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
import { assertContainedNoSymlinks, safeRemoveFile, safeWriteFileAtomic } from "./safeFileOps.ts";

const MAX_SYNC_FILE_BYTES = 512 * 1024;
const O_NOFOLLOW = NodeFS.constants.O_NOFOLLOW ?? 0;

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
  const relPath = rawRelPath.replaceAll("\\", "/");
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

function redactPreview(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= 20) return "***";
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-4)}`;
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
          preview: redactPreview(line),
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
        preview: redactPreview(message),
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
    } catch (error) {
      findings.push({
        path: relPrefix,
        line: PositiveInt.make(1),
        rule: "unscannable-io",
        preview: redactPreview(error instanceof Error ? error.message : String(error)),
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

function runGit(cwd: string, args: ReadonlyArray<string>): Promise<GitExecResult> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn("git", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runGitBuffer(
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly code: number; readonly stdout: Buffer; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn("git", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const chunks: Array<Buffer> = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout: Buffer.alloc(0), stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly path: string;
}

async function readGitTree(repoDir: string, ref: string): Promise<ReadonlyArray<GitTreeEntry>> {
  const res = await runGit(repoDir, ["ls-tree", "-r", "-z", ref]);
  if (res.code !== 0) return [];
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

/**
 * Scans every blob object in commits not yet on `origin/<branch>` (or all commits reachable from `HEAD`
 * if the remote tracking ref does not exist). Blocks secrets, oversized/binary objects, and non-allowlisted paths.
 */
async function scanOutboundGitHistory(
  repoDir: string,
  branch: string,
): Promise<ReadonlyArray<HarnessSyncSecretFinding>> {
  const headRes = await runGit(repoDir, ["rev-parse", "--verify", "HEAD"]);
  if (headRes.code !== 0) return [];

  const remoteRef = `refs/remotes/origin/${branch}`;
  const hasRemoteRef = (await runGit(repoDir, ["rev-parse", "--verify", remoteRef])).code === 0;
  const revArgs = hasRemoteRef
    ? ["rev-list", "--objects", `${remoteRef}..HEAD`]
    : ["rev-list", "--objects", "HEAD"];
  const revRes = await runGit(repoDir, revArgs);
  if (revRes.code !== 0) {
    return [
      {
        path: ".git",
        line: PositiveInt.make(1),
        rule: "unscannable-git-history",
        preview: redactPreview(sanitizeErrorDetail(revRes.stderr || "git rev-list failed")),
      },
    ];
  }

  const findings: Array<HarnessSyncSecretFinding> = [];
  const seenObjects = new Set<string>();
  for (const line of revRes.stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx <= 0) continue;
    const sha = trimmed.slice(0, spaceIdx);
    const relPath = trimmed.slice(spaceIdx + 1).trim();
    if (!sha || !relPath) continue;
    const key = `${sha}:${relPath}`;
    if (seenObjects.has(key)) continue;
    seenObjects.add(key);

    const typeRes = await runGit(repoDir, ["cat-file", "-t", sha]);
    if (typeRes.code !== 0) {
      findings.push({
        path: relPath,
        line: PositiveInt.make(1),
        rule: "unscannable-git-object",
        preview: `Could not inspect object ${sha.slice(0, 10)}`,
      });
      continue;
    }
    if (typeRes.stdout.trim() !== "blob") continue;

    if (!isAllowlistedSyncPath(relPath)) {
      findings.push({
        path: relPath,
        line: PositiveInt.make(1),
        rule: "disallowed-path-in-history",
        preview: "Non-allowlisted file present in outbound Git history",
      });
      if (findings.length >= 50) return findings;
      continue;
    }

    const sizeRes = await runGit(repoDir, ["cat-file", "-s", sha]);
    const size = Number.parseInt(sizeRes.stdout.trim(), 10);
    if (sizeRes.code !== 0 || !Number.isFinite(size) || size > MAX_SYNC_FILE_BYTES) {
      findings.push({
        path: relPath,
        line: PositiveInt.make(1),
        rule: "unscannable-oversized",
        preview: `Outbound blob exceeds ${MAX_SYNC_FILE_BYTES} bytes`,
      });
      if (findings.length >= 50) return findings;
      continue;
    }

    const blobRes = await runGitBuffer(repoDir, ["cat-file", "blob", sha]);
    if (blobRes.code !== 0) {
      findings.push({
        path: relPath,
        line: PositiveInt.make(1),
        rule: "unscannable-git-object",
        preview: `Failed to read blob ${sha.slice(0, 10)}`,
      });
      if (findings.length >= 50) return findings;
      continue;
    }
    scanBufferForSecrets(relPath, blobRes.stdout, findings);
    if (findings.length >= 50) return findings;
  }

  return findings;
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
  readonly pull: () => Effect.Effect<HarnessSyncPullResult, HarnessError>;
}

export class HarnessSyncService extends Context.Service<
  HarnessSyncService,
  HarnessSyncServiceShape
>()("t3/harness/HarnessSyncService") {}

export const layer = Layer.effect(
  HarnessSyncService,
  Effect.gen(function* () {
    const store = yield* HarnessStore.HarnessStore;
    const mutex = Semaphore.makeUnsafe(1);

    const harnessDir = () => store.harnessDir;
    // Keep the Git checkout strictly separate from the live harness directory so pulls can never
    // overwrite local trust ledgers or executable configs directly.
    const syncRepoDir = () =>
      NodePath.join(NodePath.dirname(NodePath.resolve(store.harnessDir)), "harness-sync");

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
      const headEntries = headSha ? await readGitTree(repoDir, "HEAD") : [];
      const { files, diffSummary } = computeDiffAgainstHead(headEntries, snapshot.files);

      const historyFindings = await scanOutboundGitHistory(repoDir, branch);
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

      const previewTreeDigest = computeTreeDigest(headSha, snapshot.files);

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
        if (hasEmbeddedRemoteCredentials(input.remoteUrl)) {
          return yield* new HarnessError({
            code: "invalid_config",
            detail:
              "Remote URL must not contain embedded credentials or tokens. Configure SSH keys or a Git credential helper instead.",
          });
        }
        const repoDir = syncRepoDir();
        const targetBranch = input.branch ?? "main";
        yield* mutex.withPermits(1)(
          Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(repoDir, { recursive: true });
              const hasGit = await NodeFSP.stat(NodePath.join(repoDir, ".git"))
                .then(() => true)
                .catch(() => false);
              if (!hasGit) {
                const init = await runGit(repoDir, ["init", "-b", targetBranch]);
                if (init.code !== 0) {
                  throw new Error(init.stderr.trim() || "git init failed");
                }
              } else {
                const symRes = await runGit(repoDir, [
                  "symbolic-ref",
                  "HEAD",
                  `refs/heads/${targetBranch}`,
                ]);
                if (symRes.code !== 0) {
                  const checkoutRes = await runGit(repoDir, ["checkout", "-B", targetBranch]);
                  if (checkoutRes.code !== 0) {
                    throw new Error(checkoutRes.stderr.trim() || "git branch switch failed");
                  }
                }
              }
              const hasOrigin = await runGit(repoDir, ["remote", "get-url", "origin"]);
              const setRemote =
                hasOrigin.code === 0
                  ? await runGit(repoDir, ["remote", "set-url", "origin", input.remoteUrl])
                  : await runGit(repoDir, ["remote", "add", "origin", input.remoteUrl]);
              if (setRemote.code !== 0) {
                throw new Error(setRemote.stderr.trim() || "git remote update failed");
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
                const outboundFindings = await scanOutboundGitHistory(repoDir, branch);
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
      pull: Effect.fn("HarnessSyncService.pull")(function* () {
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
                const beforeEntries = inspected.headSha ? await readGitTree(repoDir, "HEAD") : [];
                const beforeAllowlisted = new Map<string, string>();
                for (const entry of beforeEntries) {
                  if (entry.type === "blob" && isAllowlistedSyncPath(entry.path)) {
                    beforeAllowlisted.set(entry.path, entry.sha);
                  }
                }

                const fetchRes = await runGit(repoDir, ["fetch", "origin", branch]);
                if (fetchRes.code !== 0) {
                  throw new Error(fetchRes.stderr.trim() || "git fetch failed");
                }
                if (inspected.headSha === null) {
                  const checkoutRes = await runGit(repoDir, [
                    "checkout",
                    "-B",
                    branch,
                    "FETCH_HEAD",
                  ]);
                  if (checkoutRes.code !== 0) {
                    throw new Error(checkoutRes.stderr.trim() || "git checkout FETCH_HEAD failed");
                  }
                } else {
                  const mergeRes = await runGit(repoDir, ["merge", "--ff-only", "FETCH_HEAD"]);
                  if (mergeRes.code !== 0) {
                    throw new Error(mergeRes.stderr.trim() || "git merge --ff-only failed");
                  }
                }

                const afterEntries = await readGitTree(repoDir, "HEAD");
                const afterAllowlisted = new Map<string, GitTreeEntry>();
                const skippedFiles: Array<string> = [];
                for (const entry of afterEntries) {
                  // Reject symlinks (120000), submodules (160000), and all non-allowlisted paths.
                  if (
                    entry.type !== "blob" ||
                    entry.mode === "120000" ||
                    entry.mode === "160000" ||
                    !isAllowlistedSyncPath(entry.path)
                  ) {
                    skippedFiles.push(entry.path);
                    continue;
                  }
                  afterAllowlisted.set(entry.path, entry);
                }

                await NodeFSP.mkdir(hDir, { recursive: true });
                const updatedFiles: Array<string> = [];

                for (const [relPath, entry] of afterAllowlisted.entries()) {
                  const blobRes = await runGitBuffer(repoDir, ["cat-file", "blob", entry.sha]);
                  if (blobRes.code !== 0) {
                    skippedFiles.push(relPath);
                    continue;
                  }
                  if (
                    blobRes.stdout.byteLength > MAX_SYNC_FILE_BYTES ||
                    blobRes.stdout.includes(0)
                  ) {
                    skippedFiles.push(relPath);
                    continue;
                  }
                  const targetPath = NodePath.join(hDir, relPath);
                  const existingBuf = await NodeFSP.readFile(targetPath).catch(() => null);
                  if (existingBuf !== null && existingBuf.equals(blobRes.stdout)) {
                    continue;
                  }
                  await safeWriteFileAtomic(hDir, targetPath, blobRes.stdout.toString("utf8"));
                  updatedFiles.push(relPath);
                }

                // Remove allowlisted files that existed in the previous synced commit and were deleted upstream.
                for (const prevPath of beforeAllowlisted.keys()) {
                  if (!afterAllowlisted.has(prevPath)) {
                    await safeRemoveFile(hDir, NodePath.join(hDir, prevPath));
                    updatedFiles.push(prevPath);
                  }
                }

                const skippedSuffix =
                  skippedFiles.length > 0
                    ? ` Skipped ${skippedFiles.length} non-allowlisted or unsafe file(s) from remote.`
                    : "";
                return {
                  pulled: true,
                  updatedFiles,
                  ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
                  summary:
                    updatedFiles.length > 0
                      ? `Pulled ${updatedFiles.length} allowlisted file(s) from origin/${branch}.${skippedSuffix}`
                      : `Harness is already up to date with origin/${branch}.${skippedSuffix}`,
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
