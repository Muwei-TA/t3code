// @effect-diagnostics nodeBuiltinImport:off -- Runs git commands on an isolated sync checkout and secret-safety scans on portable harness files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  HarnessError,
  type HarnessSyncConfigureInput,
  type HarnessSyncDiffFile,
  type HarnessSyncPreviewPushResult,
  type HarnessSyncPullConflict,
  type HarnessSyncPullInput,
  type HarnessSyncPullResult,
  type HarnessSyncPushInput,
  type HarnessSyncPushResult,
  type HarnessSyncSecretFinding,
  type HarnessSyncStatus,
  NonNegativeInt,
  PositiveInt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as HarnessStore from "./HarnessStore.ts";
import {
  assertContainedNoSymlinks,
  safeReadFileUtf8,
  safeRemoveFile,
  safeWriteFileAtomic,
} from "./safeFileOps.ts";

const MAX_SYNC_FILE_BYTES = 512 * 1024;
const REDACTED_PREVIEW = "***";
const O_NOFOLLOW = NodeFS.constants.O_NOFOLLOW ?? 0;
const PENDING_PULL_BASES_FILE = "t3-harness-pull-bases.json";

const ALLOWED_SKILL_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

const ALLOWLIST_DIRS = ["rules", "commands", "modes", "memory", "skills"] as const;

const SECRET_RULES: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----/ },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "raw-bearer-token",
    pattern: /\bBearer\s+(?!\$\{secret:)[A-Za-z0-9._~+/=-]{24,}\b/,
  },
];

/**
 * Only non-executable declarative harness content may sync across machines.
 * Local trust ledgers (`plugins-state.json`, `approval-rules.json`, `project-trust.json`),
 * executable configs (`harness.json`, `hooks.json`, `plugins/**`), and secrets never sync.
 */
function isAllowlistedSyncPath(rawRelPath: string): boolean {
  if (rawRelPath.includes("\\")) return false;
  const relPath = rawRelPath;
  if (!relPath || relPath.startsWith("/") || relPath.endsWith("/")) return false;
  const segments = relPath.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === ".." || s.startsWith("."))) {
    return false;
  }
  if (relPath === "AGENTS.md") return true;
  if (segments.length === 2) {
    const [dir, file] = segments;
    if (
      (dir === "rules" || dir === "commands" || dir === "modes" || dir === "memory") &&
      file !== undefined &&
      file.endsWith(".md")
    ) {
      return true;
    }
  }
  if (segments.length >= 3 && segments[0] === "skills") {
    if (segments.includes("node_modules")) return false;
    const file = segments[segments.length - 1] ?? "";
    const ext = NodePath.extname(file).toLowerCase();
    return ALLOWED_SKILL_EXTENSIONS.has(ext);
  }
  return false;
}

export function hasEmbeddedRemoteCredentials(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol === "http:" || protocol === "https:") {
        return parsed.username.length > 0 || parsed.password.length > 0;
      }
      if (parsed.password.length > 0) return true;
    } catch {
      return /:\/\/[^/\s@]+@/u.test(trimmed);
    }
  }
  return false;
}

export function sanitizeRemoteUrl(rawUrl: string | null): string | null {
  if (rawUrl === null) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol === "http:" || protocol === "https:") {
        parsed.username = "";
        parsed.password = "";
        return parsed.toString().replace(/\/$/u, trimmed.endsWith("/") ? "/" : "");
      }
      if (parsed.password.length > 0) {
        parsed.password = "";
        return parsed.toString();
      }
      return trimmed;
    } catch {
      return trimmed.replace(/(:\/\/)[^/\s@]+@/gu, "$1");
    }
  }
  return trimmed;
}

function sanitizeErrorDetail(message: string): string {
  return message.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/gu, "$1***@");
}

function gitBlobHash(content: Buffer): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return NodeCrypto.createHash("sha1").update(header).update(content).digest("hex");
}

function scanBufferForSecrets(
  relPath: string,
  buffer: Buffer,
  findings: Array<HarnessSyncSecretFinding>,
): void {
  if (buffer.byteLength > MAX_SYNC_FILE_BYTES) {
    findings.push({
      path: relPath,
      line: PositiveInt.make(1),
      rule: "unscannable-oversized",
      preview: `Exceeds ${MAX_SYNC_FILE_BYTES} byte scan limit`,
    });
    return;
  }
  if (buffer.includes(0)) {
    findings.push({
      path: relPath,
      line: PositiveInt.make(1),
      rule: "unscannable-binary",
      preview: "Binary content cannot be verified for secrets",
    });
    return;
  }
  const content = buffer.toString("utf8");
  const lines = content.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const sanitized = line.replace(/\$\{secret:[^}]+\}/gu, "");
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(sanitized)) {
        findings.push({
          path: relPath,
          line: PositiveInt.make(i + 1),
          rule: rule.name,
          preview: REDACTED_PREVIEW,
        });
        break;
      }
    }
    if (findings.length >= 50) return;
  }
}

interface ScannedFileSnapshot {
  readonly relPath: string;
  readonly content: Buffer;
  readonly text: string;
  readonly blobSha: string;
}

interface HarnessAllowlistSnapshot {
  readonly files: ReadonlyMap<string, ScannedFileSnapshot>;
  readonly findings: ReadonlyArray<HarnessSyncSecretFinding>;
}

/**
 * Strictly read-only, symlink-safe snapshot of allowlisted declarative files in `harnessDir`.
 * Fails closed: any symlink, unreadable file, oversized file, or binary file produces a blocking finding.
 */
async function snapshotAllowlistedHarnessFiles(
  harnessDir: string,
): Promise<HarnessAllowlistSnapshot> {
  const files = new Map<string, ScannedFileSnapshot>();
  const findings: Array<HarnessSyncSecretFinding> = [];

  const rootStat = await NodeFSP.lstat(harnessDir).catch(() => null);
  if (rootStat === null) {
    return { files, findings };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    findings.push({
      path: ".",
      line: PositiveInt.make(1),
      rule: "unscannable-symlink",
      preview: "Harness root directory is a symlink or non-directory",
    });
    return { files, findings };
  }

  const readAllowlistedFile = async (relPath: string, fullPath: string) => {
    try {
      const { resolvedTarget } = await assertContainedNoSymlinks(harnessDir, fullPath);
      const handle = await NodeFSP.open(resolvedTarget, NodeFS.constants.O_RDONLY | O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          findings.push({
            path: relPath,
            line: PositiveInt.make(1),
            rule: "unscannable-non-regular",
            preview: "Non-regular file cannot be synced",
          });
          return;
        }
        if (stat.size > MAX_SYNC_FILE_BYTES) {
          findings.push({
            path: relPath,
            line: PositiveInt.make(1),
            rule: "unscannable-oversized",
            preview: `File size ${stat.size} exceeds ${MAX_SYNC_FILE_BYTES} bytes`,
          });
          return;
        }
        const buffer = await handle.readFile();
        scanBufferForSecrets(relPath, buffer, findings);
        if (!buffer.includes(0) && buffer.byteLength <= MAX_SYNC_FILE_BYTES) {
          files.set(relPath, {
            relPath,
            content: buffer,
            text: buffer.toString("utf8"),
            blobSha: gitBlobHash(buffer),
          });
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      findings.push({
        path: relPath,
        line: PositiveInt.make(1),
        rule: message.toLowerCase().includes("symlink") ? "unscannable-symlink" : "unscannable-io",
        preview: REDACTED_PREVIEW,
      });
    }
  };

  // 1. Top-level AGENTS.md
  const agentsPath = NodePath.join(harnessDir, "AGENTS.md");
  const agentsStat = await NodeFSP.lstat(agentsPath).catch(() => null);
  if (agentsStat !== null) {
    if (agentsStat.isSymbolicLink()) {
      findings.push({
        path: "AGENTS.md",
        line: PositiveInt.make(1),
        rule: "unscannable-symlink",
        preview: "Symlink rejected in portable harness sync",
      });
    } else if (agentsStat.isFile()) {
      await readAllowlistedFile("AGENTS.md", agentsPath);
    }
  }

  // 2. Allowlisted subdirectories
  const walkDir = async (dirPath: string, relPrefix: string) => {
    const dirStat = await NodeFSP.lstat(dirPath).catch(() => null);
    if (dirStat === null) return;
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      findings.push({
        path: relPrefix,
        line: PositiveInt.make(1),
        rule: "unscannable-symlink",
        preview: "Symlinked directory rejected in portable harness sync",
      });
      return;
    }
    let entries: ReadonlyArray<NodeFS.Dirent>;
    try {
      entries = await NodeFSP.readdir(dirPath, { withFileTypes: true });
    } catch {
      findings.push({
        path: relPrefix,
        line: PositiveInt.make(1),
        rule: "unscannable-io",
        preview: REDACTED_PREVIEW,
      });
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = NodePath.join(dirPath, entry.name);
      const relPath = `${relPrefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        findings.push({
          path: relPath,
          line: PositiveInt.make(1),
          rule: "unscannable-symlink",
          preview: "Symlink rejected in portable harness sync",
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (relPrefix === "skills" || relPrefix.startsWith("skills/")) {
          await walkDir(fullPath, relPath);
        }
        continue;
      }
      if (entry.isFile() && isAllowlistedSyncPath(relPath)) {
        await readAllowlistedFile(relPath, fullPath);
      }
    }
  };

  for (const dir of ALLOWLIST_DIRS) {
    await walkDir(NodePath.join(harnessDir, dir), dir);
  }

  return { files, findings };
}

interface GitExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function makeGitRunner(allowLocalRemote: boolean) {
  const protocolOptions = [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    `protocol.file.allow=${allowLocalRemote ? "always" : "never"}`,
    "-c",
    "protocol.http.allow=always",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.ssh.allow=always",
    "-c",
    "core.hooksPath=/dev/null",
  ];
  return (
    cwd: string,
    args: ReadonlyArray<string>,
  ): Promise<{ readonly code: number; readonly stdout: Buffer; readonly stderr: string }> =>
    new Promise((resolve) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      );
      const child = NodeChildProcess.spawn("git", [...protocolOptions, ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
      });
      const chunks: Array<Buffer> = [];
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) =>
        resolve({ code: 1, stdout: Buffer.alloc(0), stderr: err.message }),
      );
      child.on("close", (code) =>
        resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr }),
      );
    });
}

interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly path: string;
}

async function readGitTree(
  runGit: (args: ReadonlyArray<string>) => Promise<GitExecResult>,
  ref: string,
): Promise<ReadonlyArray<GitTreeEntry>> {
  const res = await runGit(["ls-tree", "-r", "-z", ref]);
  if (res.code !== 0) throw new Error("Could not read the Git sync tree.");
  const entries: Array<GitTreeEntry> = [];
  for (const record of res.stdout.split("\0")) {
    if (!record) continue;
    const tabIdx = record.indexOf("\t");
    if (tabIdx <= 0) continue;
    const meta = record.slice(0, tabIdx).split(/\s+/u);
    const entryPath = record.slice(tabIdx + 1);
    if (meta.length >= 3 && entryPath) {
      entries.push({
        mode: meta[0] ?? "",
        type: meta[1] ?? "",
        sha: meta[2] ?? "",
        path: entryPath,
      });
    }
  }
  return entries;
}

function isRegularSyncEntry(entry: GitTreeEntry): boolean {
  return (
    entry.type === "blob" &&
    (entry.mode === "100644" || entry.mode === "100755") &&
    isAllowlistedSyncPath(entry.path)
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readLocalBlobSha(root: string, target: string): Promise<string | null> {
  try {
    const { resolvedTarget } = await assertContainedNoSymlinks(root, target);
    const handle = await NodeFSP.open(resolvedTarget, NodeFS.constants.O_RDONLY | O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SYNC_FILE_BYTES) {
        throw new Error("Local file is unsafe or too large to compare.");
      }
      const content = await handle.readFile();
      if (content.includes(0) || content.byteLength > MAX_SYNC_FILE_BYTES) {
        throw new Error("Local file is binary or too large to compare.");
      }
      return gitBlobHash(content);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readPendingPullBases(
  gitDir: string,
  target: string,
): Promise<Map<string, string | null>> {
  const raw = await safeReadFileUtf8(gitDir, target).catch((error: unknown) => {
    if (isMissing(error)) return "{}";
    throw error;
  });
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Could not read pending harness sync conflicts.");
  }
  const bases = new Map<string, string | null>();
  for (const [path, base] of Object.entries(parsed)) {
    if (
      !isAllowlistedSyncPath(path) ||
      (base !== null && (typeof base !== "string" || !/^[0-9a-f]{40}$/u.test(base)))
    ) {
      throw new Error("Invalid pending harness sync conflict.");
    }
    bases.set(path, base);
  }
  return bases;
}

function computeTreeDigest(
  headSha: string | null,
  files: ReadonlyMap<string, ScannedFileSnapshot>,
): string {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(`head:${headSha ?? "UNBORN"}\n`);
  const sortedPaths = Array.from(files.keys()).toSorted();
  for (const relPath of sortedPaths) {
    const file = files.get(relPath);
    if (!file) continue;
    hash.update(`${relPath}\0${file.blobSha}\n`);
  }
  return hash.digest("hex");
}

function computeDiffAgainstHead(
  headEntries: ReadonlyArray<GitTreeEntry>,
  snapshotFiles: ReadonlyMap<string, ScannedFileSnapshot>,
): {
  readonly files: ReadonlyArray<HarnessSyncDiffFile>;
  readonly diffSummary: string;
} {
  const headByPath = new Map<string, GitTreeEntry>();
  for (const entry of headEntries) {
    if (entry.type === "blob") {
      headByPath.set(entry.path, entry);
    }
  }

  const diffFiles: Array<HarnessSyncDiffFile> = [];
  const allPaths = Array.from(new Set([...headByPath.keys(), ...snapshotFiles.keys()])).toSorted();
  for (const relPath of allPaths) {
    const headEntry = headByPath.get(relPath);
    const localFile = snapshotFiles.get(relPath);
    if (!headEntry && localFile) {
      const lineCount = localFile.text.length === 0 ? 0 : localFile.text.split(/\r?\n/u).length;
      diffFiles.push({
        path: relPath,
        status: "added",
        additions: NonNegativeInt.make(lineCount),
        deletions: NonNegativeInt.make(0),
      });
    } else if (headEntry && !localFile) {
      diffFiles.push({
        path: relPath,
        status: "deleted",
        additions: NonNegativeInt.make(0),
        deletions: NonNegativeInt.make(1),
      });
    } else if (headEntry && localFile && headEntry.sha !== localFile.blobSha) {
      const lineCount = localFile.text.length === 0 ? 0 : localFile.text.split(/\r?\n/u).length;
      diffFiles.push({
        path: relPath,
        status: "modified",
        additions: NonNegativeInt.make(lineCount),
        deletions: NonNegativeInt.make(0),
      });
    }
  }

  const diffSummary =
    diffFiles.length > 0
      ? `${diffFiles.length} allowlisted portable file(s) changed and ready for sync.`
      : "No portable harness changes pending.";

  return { files: diffFiles, diffSummary };
}

async function clearNonGitEntries(repoDir: string): Promise<void> {
  const entries = await NodeFSP.readdir(repoDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    await NodeFSP.rm(NodePath.join(repoDir, entry.name), { recursive: true, force: true });
  }
}

export interface HarnessSyncServiceShape {
  readonly getStatus: () => Effect.Effect<HarnessSyncStatus, HarnessError>;
  readonly configureRemote: (
    input: HarnessSyncConfigureInput,
  ) => Effect.Effect<HarnessSyncStatus, HarnessError>;
  readonly previewPush: () => Effect.Effect<HarnessSyncPreviewPushResult, HarnessError>;
  readonly push: (
    input: HarnessSyncPushInput,
  ) => Effect.Effect<HarnessSyncPushResult, HarnessError>;
  readonly pull: (
    input?: HarnessSyncPullInput,
  ) => Effect.Effect<HarnessSyncPullResult, HarnessError>;
}

export class HarnessSyncService extends Context.Service<
  HarnessSyncService,
  HarnessSyncServiceShape
>()("t3/harness/HarnessSyncService") {}

export const makeLayer = (options?: { readonly allowLocalRemoteForTest?: boolean }) =>
  Layer.effect(
    HarnessSyncService,
    Effect.gen(function* () {
      const store = yield* HarnessStore.HarnessStore;
      const mutex = Semaphore.makeUnsafe(1);

      const harnessDir = () => store.harnessDir;
      // Keep the Git checkout strictly separate from the live harness directory so pulls can never
      // overwrite local trust ledgers or executable configs directly.
      const syncRepoDir = () =>
        NodePath.join(NodePath.dirname(NodePath.resolve(store.harnessDir)), "harness-sync");

      const allowLocalRemote = options?.allowLocalRemoteForTest === true;
      const runGitBuffer = makeGitRunner(allowLocalRemote);
      const runGit = async (cwd: string, args: ReadonlyArray<string>): Promise<GitExecResult> => {
        const result = await runGitBuffer(cwd, args);
        return { ...result, stdout: result.stdout.toString("utf8") };
      };
      const gitTree = (ref: string) => readGitTree((args) => runGit(syncRepoDir(), args), ref);
      const resolveRef = async (ref: string) => {
        const res = await runGit(syncRepoDir(), ["rev-parse", "--verify", ref]);
        return res.code === 0 ? res.stdout.trim() : null;
      };
      const isAllowedRemote = (url: string) => {
        if (
          url.startsWith("-") ||
          /[\\\s\x00-\x1f\x7f]/u.test(url) ||
          hasEmbeddedRemoteCredentials(url)
        ) {
          return false;
        }
        if (allowLocalRemote && NodePath.isAbsolute(url)) return true;
        if (
          /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[0-9a-fA-F:]+\]):[^:][^\s]*$/u.test(
            url,
          )
        ) {
          return true;
        }
        if (!/^(?:https?|ssh):\/\/[^/]/u.test(url)) return false;
        try {
          const parsed = new URL(url);
          return Boolean(parsed.hostname) && !parsed.search && !parsed.hash;
        } catch {
          return false;
        }
      };
      const assertSafeRemote = async (push = false) => {
        const res = await runGit(syncRepoDir(), [
          "remote",
          "get-url",
          ...(push ? ["--push"] : []),
          "origin",
        ]);
        if (res.code !== 0 || !isAllowedRemote(res.stdout.trim())) {
          throw new Error(
            "Configure an HTTP, HTTPS, or SSH Git remote without embedded credentials.",
          );
        }
      };

      const scanOutboundGitHistory = async (head: string | null, remote: string | null) => {
        if (head === null || head === remote) return [];
        const repoDir = syncRepoDir();
        const findings: Array<HarnessSyncSecretFinding> = [];
        const seenEntries = new Set<string>();
        const seenBlobs = new Map<string, ReadonlyArray<HarnessSyncSecretFinding>>();
        try {
          const revisions = await runGit(repoDir, [
            "rev-list",
            remote ? `${remote}..${head}` : head,
          ]);
          if (revisions.code !== 0) throw new Error("Could not enumerate outbound commits.");
          for (const commit of revisions.stdout.trim().split("\n").filter(Boolean)) {
            for (const entry of await gitTree(commit)) {
              const key = `${entry.mode}:${entry.sha}:${entry.path}`;
              if (seenEntries.has(key)) continue;
              seenEntries.add(key);
              if (!isRegularSyncEntry(entry)) {
                findings.push({
                  path: entry.path,
                  line: PositiveInt.make(1),
                  rule:
                    entry.mode === "120000" ? "unscannable-symlink" : "disallowed-path-in-history",
                  preview: "Unsafe file present in outbound Git history",
                });
              } else {
                let blobFindings = seenBlobs.get(entry.sha);
                if (!blobFindings) {
                  const size = await runGit(repoDir, ["cat-file", "-s", entry.sha]);
                  if (size.code !== 0) throw new Error("Could not inspect outbound object.");
                  const result: Array<HarnessSyncSecretFinding> = [];
                  if (Number(size.stdout) > MAX_SYNC_FILE_BYTES) {
                    result.push({
                      path: entry.path,
                      line: PositiveInt.make(1),
                      rule: "unscannable-oversized",
                      preview: `Outbound blob exceeds ${MAX_SYNC_FILE_BYTES} bytes`,
                    });
                  } else {
                    const blob = await runGitBuffer(repoDir, ["cat-file", "blob", entry.sha]);
                    if (blob.code !== 0) throw new Error("Could not read outbound object.");
                    scanBufferForSecrets(entry.path, blob.stdout, result);
                  }
                  seenBlobs.set(entry.sha, result);
                  blobFindings = result;
                }
                findings.push(...blobFindings.map((finding) => ({ ...finding, path: entry.path })));
              }
              if (findings.length >= 50) return findings.slice(0, 50);
            }
          }
        } catch {
          findings.push({
            path: ".git",
            line: PositiveInt.make(1),
            rule: "unscannable-git-history",
            preview: "Could not inspect outbound Git history",
          });
        }
        return findings;
      };

      let historyCache:
        | {
            readonly key: string;
            readonly value: ReturnType<typeof scanOutboundGitHistory>;
          }
        | undefined;

      const readPolicy = () =>
        store
          .resolveWorkspace()
          .pipe(Effect.map((workspace) => workspace.managedPolicyAllowsHarness));

      const inspectReadOnly = async () => {
        const hDir = harnessDir();
        const repoDir = syncRepoDir();
        const gitDirExists = await NodeFSP.stat(NodePath.join(repoDir, ".git"))
          .then(() => true)
          .catch(() => false);
        const snapshot = await snapshotAllowlistedHarnessFiles(hDir);

        if (!gitDirExists) {
          return {
            harnessDir: hDir,
            initialized: false,
            branch: null,
            remoteUrl: null,
            headSha: null,
            dirtyCount: 0,
            ahead: 0,
            behind: 0,
            files: [] as ReadonlyArray<HarnessSyncDiffFile>,
            diffSummary: "Harness Git sync is not configured yet.",
            previewTreeDigest: null,
            secretFindings: snapshot.findings,
            snapshotFiles: snapshot.files,
          };
        }

        const branchRes = await runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
        let branch =
          branchRes.code === 0 && branchRes.stdout.trim() && branchRes.stdout.trim() !== "HEAD"
            ? branchRes.stdout.trim()
            : "";
        if (!branch) {
          const symRes = await runGit(repoDir, ["symbolic-ref", "--short", "HEAD"]);
          branch = symRes.code === 0 && symRes.stdout.trim() ? symRes.stdout.trim() : "main";
        }

        const remoteRes = await runGit(repoDir, ["remote", "get-url", "origin"]);
        const rawRemote = remoteRes.code === 0 ? remoteRes.stdout.trim() || null : null;
        const remoteUrl = sanitizeRemoteUrl(rawRemote);

        const headRes = await runGit(repoDir, ["rev-parse", "--verify", "HEAD"]);
        const headSha = headRes.code === 0 ? headRes.stdout.trim() || null : null;
        const headEntries = headSha ? await gitTree(headSha) : [];
        const { files, diffSummary } = computeDiffAgainstHead(headEntries, snapshot.files);

        const previewTreeDigest = computeTreeDigest(headSha, snapshot.files);
        const remoteHead =
          headSha === null ? null : await resolveRef(`refs/remotes/origin/${branch}`);
        const historyCacheKey = `${headSha ?? ""}:${remoteHead ?? ""}`;
        if (historyCache?.key !== historyCacheKey) {
          const scan = scanOutboundGitHistory(headSha, remoteHead);
          historyCache = { key: historyCacheKey, value: scan };
          const evictScan = () => {
            if (historyCache?.value === scan) historyCache = undefined;
          };
          void scan.then((findings) => {
            if (findings.some(({ rule }) => rule === "unscannable-git-history")) evictScan();
          }, evictScan);
        }
        const historyFindings = await historyCache.value;
        const allFindings = [...snapshot.findings, ...historyFindings].slice(0, 50);

        let ahead = 0;
        let behind = 0;
        if (headSha) {
          const abRes = await runGit(repoDir, [
            "rev-list",
            "--left-right",
            "--count",
            `HEAD...refs/remotes/origin/${branch}`,
          ]);
          if (abRes.code === 0) {
            const [aText, bText] = abRes.stdout.trim().split(/\s+/u);
            ahead = Number.parseInt(aText ?? "0", 10) || 0;
            behind = Number.parseInt(bText ?? "0", 10) || 0;
          }
        }

        return {
          harnessDir: hDir,
          initialized: true,
          branch,
          remoteUrl,
          headSha,
          dirtyCount: files.length,
          ahead: Math.max(0, ahead),
          behind: Math.max(0, behind),
          files,
          diffSummary,
          previewTreeDigest,
          secretFindings: allFindings,
          snapshotFiles: snapshot.files,
        };
      };

      const getStatus = Effect.fn("HarnessSyncService.getStatus")(function* () {
        const allowed = yield* readPolicy();
        const dir = harnessDir();
        if (!allowed) {
          return {
            harnessDir: dir,
            initialized: false,
            branch: null,
            remoteUrl: null,
            dirtyCount: NonNegativeInt.make(0),
            ahead: NonNegativeInt.make(0),
            behind: NonNegativeInt.make(0),
            secretFindings: [],
            canPush: false,
            managedPolicyAllowsHarness: false,
            lastError: null,
          } satisfies HarnessSyncStatus;
        }

        return yield* Effect.tryPromise({
          try: async (): Promise<HarnessSyncStatus> => {
            const inspected = await inspectReadOnly();
            return {
              harnessDir: inspected.harnessDir,
              initialized: inspected.initialized,
              branch: inspected.branch,
              remoteUrl: inspected.remoteUrl,
              dirtyCount: NonNegativeInt.make(inspected.dirtyCount),
              ahead: NonNegativeInt.make(inspected.ahead),
              behind: NonNegativeInt.make(inspected.behind),
              secretFindings: inspected.secretFindings,
              canPush:
                inspected.initialized &&
                inspected.remoteUrl !== null &&
                inspected.secretFindings.length === 0,
              managedPolicyAllowsHarness: true,
              lastError: null,
            };
          },
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: sanitizeErrorDetail(
                `Failed to inspect harness git sync status: ${error instanceof Error ? error.message : String(error)}`,
              ),
            }),
        });
      });

      return HarnessSyncService.of({
        getStatus,
        configureRemote: Effect.fn("HarnessSyncService.configureRemote")(function* (input) {
          const allowed = yield* readPolicy();
          if (!allowed) {
            return yield* new HarnessError({
              code: "policy_denied",
              detail: "Portable harness sync is disabled by managed policy.",
            });
          }
          if (!isAllowedRemote(input.remoteUrl)) {
            return yield* new HarnessError({
              code: "invalid_config",
              detail:
                "Use an HTTP, HTTPS, or SSH remote URL without embedded credentials, or an SSH remote in user@host:path format.",
            });
          }
          const repoDir = syncRepoDir();
          const targetBranch = input.branch ?? "main";
          yield* mutex.withPermits(1)(
            Effect.tryPromise({
              try: async () => {
                await NodeFSP.mkdir(repoDir, { recursive: true });
                const gitDir = NodePath.join(repoDir, ".git");
                const pendingPath = NodePath.join(gitDir, PENDING_PULL_BASES_FILE);
                const hasGit = await NodeFSP.stat(gitDir)
                  .then(() => true)
                  .catch(() => false);
                if (!hasGit) {
                  const init = await runGit(repoDir, ["init", "-b", targetBranch]);
                  if (init.code !== 0) {
                    throw new Error(init.stderr.trim() || "git init failed");
                  }
                } else {
                  const branchRef = `refs/heads/${targetBranch}`;
                  const previousBranch = await runGit(repoDir, ["symbolic-ref", "HEAD"]);
                  if (previousBranch.code !== 0 || previousBranch.stdout.trim() !== branchRef) {
                    const symRes = await runGit(repoDir, ["symbolic-ref", "HEAD", branchRef]);
                    if (symRes.code !== 0) {
                      const checkoutRes = await runGit(repoDir, ["checkout", "-B", targetBranch]);
                      if (checkoutRes.code !== 0) {
                        throw new Error(checkoutRes.stderr.trim() || "git branch switch failed");
                      }
                    }
                    await safeRemoveFile(gitDir, pendingPath);
                  }
                }
                const previousRemote = await runGit(repoDir, [
                  "config",
                  "--local",
                  "--get",
                  "remote.origin.url",
                ]);
                if (previousRemote.code !== 0 || previousRemote.stdout.trim() !== input.remoteUrl) {
                  const setRemote =
                    previousRemote.code === 0
                      ? await runGit(repoDir, [
                          "remote",
                          "set-url",
                          "--",
                          "origin",
                          input.remoteUrl,
                        ])
                      : await runGit(repoDir, ["remote", "add", "--", "origin", input.remoteUrl]);
                  if (setRemote.code !== 0) {
                    throw new Error(setRemote.stderr.trim() || "git remote update failed");
                  }
                  await safeRemoveFile(gitDir, pendingPath);
                }
              },
              catch: (error) =>
                new HarnessError({
                  code: "io_error",
                  detail: sanitizeErrorDetail(
                    `Failed to configure harness git remote: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                }),
            }),
          );
          return yield* getStatus();
        }),
        previewPush: Effect.fn("HarnessSyncService.previewPush")(function* () {
          const allowed = yield* readPolicy();
          if (!allowed) {
            return yield* new HarnessError({
              code: "policy_denied",
              detail: "Portable harness sync is disabled by managed policy.",
            });
          }
          return yield* Effect.tryPromise({
            try: async (): Promise<HarnessSyncPreviewPushResult> => {
              const inspected = await inspectReadOnly();
              return {
                branch: inspected.branch,
                remoteUrl: inspected.remoteUrl,
                previewTreeDigest: inspected.previewTreeDigest,
                files: inspected.files,
                secretFindings: inspected.secretFindings,
                canPush:
                  inspected.initialized &&
                  inspected.remoteUrl !== null &&
                  inspected.previewTreeDigest !== null &&
                  inspected.secretFindings.length === 0,
                diffSummary: inspected.diffSummary,
              };
            },
            catch: (error) =>
              new HarnessError({
                code: "io_error",
                detail: sanitizeErrorDetail(
                  `Failed to preview harness push diff: ${error instanceof Error ? error.message : String(error)}`,
                ),
              }),
          });
        }),
        push: Effect.fn("HarnessSyncService.push")(function* (input) {
          const allowed = yield* readPolicy();
          if (!allowed) {
            return yield* new HarnessError({
              code: "policy_denied",
              detail: "Portable harness sync is disabled by managed policy.",
            });
          }
          const repoDir = syncRepoDir();
          const message = input.commitMessage ?? "chore(harness): sync portable harness";

          return yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const inspected = yield* Effect.tryPromise({
                try: () => inspectReadOnly(),
                catch: (error) =>
                  new HarnessError({
                    code: "io_error",
                    detail: sanitizeErrorDetail(
                      `Failed to inspect harness state before push: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  }),
              });

              if (!inspected.initialized || !inspected.remoteUrl || !inspected.branch) {
                return yield* new HarnessError({
                  code: "invalid_config",
                  detail: "Configure a harness Git remote before pushing.",
                });
              }
              if (
                inspected.remoteUrl !== sanitizeRemoteUrl(input.expectedRemoteUrl) ||
                inspected.branch !== input.expectedBranch ||
                inspected.previewTreeDigest !== input.expectedTreeDigest
              ) {
                return yield* new HarnessError({
                  code: "invalid_config",
                  detail:
                    "Harness sync target or files changed since preview. Refresh the push preview and confirm again.",
                });
              }
              if (inspected.secretFindings.length > 0) {
                const sample = inspected.secretFindings
                  .slice(0, 3)
                  .map((f) => `${f.path}:${f.line} (${f.rule})`)
                  .join(", ");
                return yield* new HarnessError({
                  code: "policy_denied",
                  detail: `Push blocked: detected ${inspected.secretFindings.length} safety finding(s) (${sample}). Resolve all findings before syncing.`,
                });
              }

              const branch = inspected.branch;
              return yield* Effect.tryPromise({
                try: async (): Promise<HarnessSyncPushResult> => {
                  await assertSafeRemote(true);
                  // Materialize ONLY the already-verified in-memory allowlisted bytes into the isolated sync repo.
                  await clearNonGitEntries(repoDir);
                  for (const file of inspected.snapshotFiles.values()) {
                    await safeWriteFileAtomic(
                      repoDir,
                      NodePath.join(repoDir, file.relPath),
                      file.text,
                    );
                  }

                  let committed = false;
                  let commitSha: string | undefined;
                  if (inspected.files.length > 0 || inspected.headSha === null) {
                    const addRes = await runGit(repoDir, ["add", "-A"]);
                    if (addRes.code !== 0) {
                      throw new Error(addRes.stderr.trim() || "git add failed");
                    }
                    const commitRes = await runGit(repoDir, [
                      "-c",
                      "user.name=T3 Harness Sync",
                      "-c",
                      "user.email=harness-sync@t3.local",
                      "commit",
                      "-m",
                      message,
                    ]);
                    if (commitRes.code !== 0 && !commitRes.stdout.includes("nothing to commit")) {
                      throw new Error(commitRes.stderr.trim() || "git commit failed");
                    }
                    committed = commitRes.code === 0;
                    const shaRes = await runGit(repoDir, ["rev-parse", "--short", "HEAD"]);
                    if (shaRes.code === 0) {
                      commitSha = shaRes.stdout.trim() || undefined;
                    }
                  }

                  // Final defense-in-depth scan of every outbound Git object right before push.
                  const outboundFindings = await scanOutboundGitHistory(
                    await resolveRef("HEAD"),
                    await resolveRef(`refs/remotes/origin/${branch}`),
                  );
                  if (outboundFindings.length > 0) {
                    const sample = outboundFindings
                      .slice(0, 3)
                      .map((f) => `${f.path}:${f.line} (${f.rule})`)
                      .join(", ");
                    throw new Error(
                      `Outbound Git history scan blocked push (${outboundFindings.length} finding(s): ${sample}).`,
                    );
                  }

                  const pushRes = await runGit(repoDir, ["push", "-u", "origin", branch]);
                  if (pushRes.code !== 0) {
                    throw new Error(pushRes.stderr.trim() || "git push failed");
                  }
                  const gitDir = NodePath.join(repoDir, ".git");
                  await safeRemoveFile(gitDir, NodePath.join(gitDir, PENDING_PULL_BASES_FILE));
                  return {
                    committed,
                    pushed: true,
                    ...(commitSha ? { commitSha } : {}),
                    filesCommitted: NonNegativeInt.make(inspected.files.length),
                    summary: committed
                      ? `Committed ${inspected.files.length} allowlisted file(s) and pushed ${branch} to origin.`
                      : `Pushed ${branch} to origin (no new local changes).`,
                  };
                },
                catch: (error) =>
                  new HarnessError({
                    code:
                      error instanceof Error && error.message.includes("Outbound Git history scan")
                        ? "policy_denied"
                        : "io_error",
                    detail: sanitizeErrorDetail(
                      `Harness sync push failed: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  }),
              });
            }),
          );
        }),
        pull: Effect.fn("HarnessSyncService.pull")(function* (input) {
          const allowed = yield* readPolicy();
          if (!allowed) {
            return yield* new HarnessError({
              code: "policy_denied",
              detail: "Portable harness sync is disabled by managed policy.",
            });
          }
          const hDir = harnessDir();
          const repoDir = syncRepoDir();

          return yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const inspected = yield* Effect.tryPromise({
                try: () => inspectReadOnly(),
                catch: (error) =>
                  new HarnessError({
                    code: "io_error",
                    detail: sanitizeErrorDetail(
                      `Failed to inspect harness sync status before pull: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  }),
              });
              if (!inspected.initialized || !inspected.remoteUrl || !inspected.branch) {
                return yield* new HarnessError({
                  code: "invalid_config",
                  detail: "Configure a harness Git remote before pulling.",
                });
              }
              const branch = inspected.branch;
              return yield* Effect.tryPromise({
                try: async (): Promise<HarnessSyncPullResult> => {
                  await assertSafeRemote();
                  const beforeEntries = inspected.headSha ? await gitTree(inspected.headSha) : [];
                  const beforeAllowlisted = new Map(
                    beforeEntries
                      .filter(isRegularSyncEntry)
                      .map((entry) => [entry.path, entry.sha]),
                  );
                  const gitDir = NodePath.join(repoDir, ".git");
                  const pendingPath = NodePath.join(gitDir, PENDING_PULL_BASES_FILE);
                  const pendingBases = await readPendingPullBases(gitDir, pendingPath);

                  const fetchRes = await runGit(repoDir, ["fetch", "origin", branch]);
                  if (fetchRes.code !== 0) {
                    throw new Error(fetchRes.stderr.trim() || "git fetch failed");
                  }
                  const fetchedEntries = await gitTree("FETCH_HEAD");
                  const fetchedAllowlisted = new Map(
                    fetchedEntries
                      .filter(isRegularSyncEntry)
                      .map((entry) => [entry.path, entry.sha]),
                  );

                  // Keep the original per-file bases across fast-forwards, conflicts, and interrupted pulls.
                  for (const path of new Set([
                    ...beforeAllowlisted.keys(),
                    ...fetchedAllowlisted.keys(),
                  ])) {
                    const base = beforeAllowlisted.get(path) ?? null;
                    if (
                      !pendingBases.has(path) &&
                      base !== (fetchedAllowlisted.get(path) ?? null)
                    ) {
                      pendingBases.set(path, base);
                    }
                  }
                  const writePendingBases = () =>
                    pendingBases.size === 0
                      ? safeRemoveFile(gitDir, pendingPath)
                      : safeWriteFileAtomic(
                          gitDir,
                          pendingPath,
                          JSON.stringify(Object.fromEntries(pendingBases)),
                        );
                  if (pendingBases.size > 0) await writePendingBases();

                  const advance =
                    inspected.headSha === null
                      ? await runGit(repoDir, ["checkout", "-B", branch, "FETCH_HEAD"])
                      : await runGit(repoDir, ["merge", "--ff-only", "FETCH_HEAD"]);
                  if (advance.code !== 0) {
                    throw new Error(
                      advance.stderr.trim() || "Could not fast-forward the sync branch.",
                    );
                  }

                  const afterEntries = new Map(
                    (await gitTree("HEAD")).map((entry) => [entry.path, entry]),
                  );
                  const skippedFiles = new Set(
                    [...afterEntries.values()]
                      .filter((entry) => !isRegularSyncEntry(entry))
                      .map((entry) => entry.path),
                  );
                  const updatedFiles: Array<string> = [];
                  const conflicts: Array<HarnessSyncPullConflict> = [];
                  await NodeFSP.mkdir(hDir, { recursive: true });

                  for (const [path, base] of pendingBases) {
                    const entry = afterEntries.get(path);
                    if (entry !== undefined && !isRegularSyncEntry(entry)) continue;
                    const remote = entry?.sha ?? null;
                    if (remote === base) {
                      pendingBases.delete(path);
                      continue;
                    }

                    const target = NodePath.join(hDir, path);
                    let local: string | null;
                    try {
                      local = await readLocalBlobSha(hDir, target);
                    } catch {
                      skippedFiles.add(path);
                      continue;
                    }
                    if (local === remote) {
                      pendingBases.delete(path);
                      continue;
                    }
                    if (local !== base) {
                      conflicts.push({
                        path,
                        reason:
                          remote === null
                            ? "deleted_upstream_modified_locally"
                            : base === null
                              ? "added_both"
                              : "modified_both",
                      });
                      if (input?.force !== true) continue;
                    }
                    if (entry === undefined) {
                      await safeRemoveFile(hDir, target);
                    } else {
                      const size = await runGit(repoDir, ["cat-file", "-s", entry.sha]);
                      if (size.code !== 0 || Number(size.stdout) > MAX_SYNC_FILE_BYTES) {
                        skippedFiles.add(path);
                        continue;
                      }
                      const blob = await runGitBuffer(repoDir, ["cat-file", "blob", entry.sha]);
                      const text = blob.stdout.toString("utf8");
                      if (
                        blob.code !== 0 ||
                        blob.stdout.includes(0) ||
                        !Buffer.from(text).equals(blob.stdout)
                      ) {
                        skippedFiles.add(path);
                        continue;
                      }
                      await safeWriteFileAtomic(hDir, target, text);
                    }
                    updatedFiles.push(path);
                    pendingBases.delete(path);
                  }
                  await writePendingBases();

                  const skippedSuffix =
                    skippedFiles.size > 0
                      ? ` Skipped ${skippedFiles.size} non-allowlisted or unsafe file(s).`
                      : "";
                  const conflictSuffix =
                    conflicts.length > 0
                      ? ` ${input?.force === true ? "Force pull conflicts" : "Local changes kept for conflicts"}: ${conflicts.map(({ path }) => path).join(", ")}.`
                      : "";
                  return {
                    pulled: true,
                    updatedFiles,
                    ...(skippedFiles.size > 0 ? { skippedFiles: [...skippedFiles] } : {}),
                    ...(conflicts.length > 0 ? { conflicts } : {}),
                    summary: `Applied ${updatedFiles.length} allowlisted file change(s) from origin/${branch}.${skippedSuffix}${conflictSuffix}`,
                  };
                },
                catch: (error) =>
                  new HarnessError({
                    code: "io_error",
                    detail: sanitizeErrorDetail(
                      `Harness sync pull failed: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  }),
              });
            }),
          );
        }),
      });
    }),
  );

export const layer = makeLayer();
