// @effect-diagnostics nodeBuiltinImport:off -- Runs git commands on an isolated sync checkout and secret-safety scans on portable harness files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  HarnessError,
  type HarnessPortableMcpCatalog,
  type HarnessSyncApplyReceiveInput,
  type HarnessSyncApplyReceiveResult,
  type HarnessSyncBundle,
  type HarnessSyncConfigureInput,
  type HarnessSyncDiffFile,
  type HarnessSyncExportBundleInput,
  type HarnessSyncExportBundleResult,
  type HarnessSyncPreviewPushResult,
  type HarnessSyncPreviewReceiveInput,
  type HarnessSyncPreviewReceiveResult,
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
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { diffLines } from "diff";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  importedMcpConfig,
  isPortableMcpCatalog,
  portableMcpConfig,
  PORTABLE_MCP_FILE,
  readPortableMcpCatalog,
} from "./HarnessPortableMcpCatalog.ts";
import { resolveSecretRecord } from "./HarnessSecrets.ts";
import * as HarnessStore from "./HarnessStore.ts";
import * as McpGateway from "./McpGateway.ts";
import {
  assertContainedNoSymlinks,
  safeReadFileUtf8,
  safeRemoveFile,
  safeWriteFileAtomic,
} from "./safeFileOps.ts";

const isHarnessError = Schema.is(HarnessError);

const MAX_SYNC_FILE_BYTES = 512 * 1024;
const MAX_SYNC_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_SYNC_BUNDLE_FILES = 512;
const PORTABLE_MCP_GIT_CONFIG = "t3harness.portableMcpServers";
const REDACTED_PREVIEW = "***";
const SAFE_READ_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);
const PENDING_PULL_BASES_FILE = "t3-harness-pull-bases.json";

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
 * Skill files may retain execute bits. Other portable files are declarative.
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
    return segments.every(
      (part) =>
        !/[<>:"|?*\u0000-\u001f\u007f]/u.test(part) &&
        !/[. ]$/u.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    );
  }
  return false;
}

function isBundlePath(path: string): boolean {
  return (
    path.length <= 512 &&
    isAllowlistedSyncPath(path) &&
    path
      .split("/")
      .every(
        (part) =>
          !/[<>:"|?*\u0000-\u001f\u007f]/u.test(part) &&
          !/[. ]$/u.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  );
}

function safetyFinding(path: string, rule: string): HarnessSyncSecretFinding {
  return { path, line: PositiveInt.make(1), rule, preview: REDACTED_PREVIEW };
}

function bundleDigest(input: Omit<HarnessSyncBundle, "bundleDigest">): string {
  return NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        version: input.version,
        files: input.files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        portableMcpServers: input.portableMcpServers ?? null,
      }),
    )
    .digest("hex");
}

function inspectBundle(bundle: HarnessSyncBundle): ReadonlyArray<HarnessSyncSecretFinding> {
  const findings: Array<HarnessSyncSecretFinding> = [];
  const seen = new Set<string>();
  let bytes = 0;
  if (bundle.files.length > MAX_SYNC_BUNDLE_FILES)
    return [safetyFinding(".", "unscannable-bundle-size")];
  for (const { path, text, executable } of bundle.files) {
    const key = path.toLowerCase();
    if ((executable && !path.startsWith("skills/")) || !isBundlePath(path) || seen.has(key)) {
      return [safetyFinding(".", "disallowed-bundle-path")];
    }
    seen.add(key);
    const content = Buffer.from(text, "utf8");
    bytes += content.byteLength + Buffer.byteLength(path, "utf8");
    if (bytes > MAX_SYNC_BUNDLE_BYTES) return [safetyFinding(".", "unscannable-bundle-size")];
    const priorFindings = findings.length;
    scanBufferForSecrets(".", Buffer.from(path, "utf8"), findings);
    if (findings.length > priorFindings) continue;
    scanBufferForSecrets(path, content, findings);
  }
  if (bundle.portableMcpServers !== undefined) {
    const catalog = bundle.portableMcpServers;
    if (!isPortableMcpCatalog(catalog))
      return [safetyFinding(PORTABLE_MCP_FILE, "unsafe-portable-mcp")];
    const content = Buffer.from(JSON.stringify(catalog), "utf8");
    if (bytes + content.byteLength > MAX_SYNC_BUNDLE_BYTES)
      return [safetyFinding(".", "unscannable-bundle-size")];
    scanBufferForSecrets(PORTABLE_MCP_FILE, content, findings);
  }
  if (findings.length > 0) return findings.slice(0, 50);
  return bundleDigest(bundle) === bundle.bundleDigest
    ? []
    : [safetyFinding(".", "invalid-bundle-digest")];
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
  readonly executable?: boolean;
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
  options?: { readonly acceptsPath?: (path: string) => boolean; readonly bundleLimits?: boolean },
): Promise<HarnessAllowlistSnapshot> {
  const files = new Map<string, ScannedFileSnapshot>();
  const findings: Array<HarnessSyncSecretFinding> = [];
  let bundleBytes = 0;
  let bundleLimitReached = false;

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
    if (bundleLimitReached || options?.acceptsPath?.(relPath) === false) return;
    try {
      const { resolvedTarget } = await assertContainedNoSymlinks(harnessDir, fullPath);
      const handle = await NodeFSP.open(resolvedTarget, SAFE_READ_FLAGS);
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
        if (
          options?.bundleLimits &&
          (files.size >= MAX_SYNC_BUNDLE_FILES ||
            bundleBytes + stat.size + Buffer.byteLength(relPath, "utf8") > MAX_SYNC_BUNDLE_BYTES)
        ) {
          bundleLimitReached = true;
          findings.push(safetyFinding(".", "unscannable-bundle-size"));
          return;
        }
        const buffer = await handle.readFile();
        scanBufferForSecrets(relPath, buffer, findings);
        const text = buffer.toString("utf8");
        if (!Buffer.from(text).equals(buffer))
          findings.push(safetyFinding(relPath, "unscannable-binary"));
        if (
          !buffer.includes(0) &&
          buffer.byteLength <= MAX_SYNC_FILE_BYTES &&
          Buffer.from(text).equals(buffer)
        ) {
          bundleBytes += buffer.byteLength + Buffer.byteLength(relPath, "utf8");
          files.set(relPath, {
            relPath,
            content: buffer,
            text,
            executable: relPath.startsWith("skills/") && (stat.mode & 0o111) !== 0,
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
      const relPath = `${relPrefix}/${entry.name}`;
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        if (relPrefix.startsWith("skills/") && options?.acceptsPath?.(relPath) !== false)
          findings.push(safetyFinding(relPath, "disallowed-package-path"));
        continue;
      }
      const fullPath = NodePath.join(dirPath, entry.name);
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
      } else if (relPrefix.startsWith("skills/") && options?.acceptsPath?.(relPath) !== false) {
        findings.push(safetyFinding(relPath, "disallowed-package-path"));
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
    "-c",
    "core.fileMode=true",
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

function fileIdentity(sha: string, executable: boolean | undefined) {
  return executable ? `x:${sha}` : sha;
}

function treeIdentity(entry: GitTreeEntry) {
  return fileIdentity(entry.sha, entry.path.startsWith("skills/") && entry.mode === "100755");
}

function isRegularSyncEntry(entry: GitTreeEntry): boolean {
  return (
    entry.type === "blob" &&
    (entry.mode === "100644" || entry.mode === "100755") &&
    (isAllowlistedSyncPath(entry.path) || entry.path === PORTABLE_MCP_FILE)
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readLocalBlobSha(root: string, target: string): Promise<string | null> {
  try {
    const { resolvedTarget } = await assertContainedNoSymlinks(root, target);
    const handle = await NodeFSP.open(resolvedTarget, SAFE_READ_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SYNC_FILE_BYTES) {
        throw new Error("Local file is unsafe or too large to compare.");
      }
      const content = await handle.readFile();
      if (content.includes(0) || content.byteLength > MAX_SYNC_FILE_BYTES) {
        throw new Error("Local file is binary or too large to compare.");
      }
      return fileIdentity(
        gitBlobHash(content),
        NodePath.relative(root, target).split(NodePath.sep)[0] === "skills" &&
          (stat.mode & 0o111) !== 0,
      );
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
      (!isAllowlistedSyncPath(path) && path !== PORTABLE_MCP_FILE) ||
      (base !== null && (typeof base !== "string" || !/^(?:x:)?[0-9a-f]{40}$/u.test(base)))
    ) {
      throw new Error("Invalid pending harness sync conflict.");
    }
    bases.set(path, base);
  }
  return bases;
}

async function writePendingPullBases(
  gitDir: string,
  target: string,
  bases: ReadonlyMap<string, string | null>,
): Promise<void> {
  await (bases.size === 0
    ? safeRemoveFile(gitDir, target)
    : safeWriteFileAtomic(gitDir, target, JSON.stringify(Object.fromEntries(bases))));
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
    hash.update(`${relPath}\0${fileIdentity(file.blobSha, file.executable)}\n`);
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
    } else if (
      headEntry &&
      localFile &&
      treeIdentity(headEntry) !== fileIdentity(localFile.blobSha, localFile.executable)
    ) {
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
  readonly exportBundle: (
    input: HarnessSyncExportBundleInput,
  ) => Effect.Effect<HarnessSyncExportBundleResult, HarnessError>;
  readonly previewReceive: (
    input: HarnessSyncPreviewReceiveInput,
  ) => Effect.Effect<HarnessSyncPreviewReceiveResult, HarnessError>;
  readonly applyReceive: (
    input: HarnessSyncApplyReceiveInput,
  ) => Effect.Effect<HarnessSyncApplyReceiveResult, HarnessError>;
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
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const secretResolver = yield* SecretResolver.SecretResolver;
      const gateway = yield* Effect.serviceOption(McpGateway.McpGateway);
      const mutex = Semaphore.makeUnsafe(1);
      const previewKey = NodeCrypto.randomBytes(32);

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
                const blobKey = `${entry.path === PORTABLE_MCP_FILE}:${entry.sha}`;
                let blobFindings = seenBlobs.get(blobKey);
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
                    if (
                      entry.path === PORTABLE_MCP_FILE &&
                      readPortableMcpCatalog(blob.stdout.toString("utf8")) === null
                    ) {
                      result.push(safetyFinding(PORTABLE_MCP_FILE, "unsafe-portable-mcp"));
                    }
                  }
                  seenBlobs.set(blobKey, result);
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

      const lockedRules = new Set(
        store.lockedRules.map((rule) => `rules/${rule.id.toLowerCase()}.md`),
      );
      const isLockedPath = (path: string) => lockedRules.has(path.toLowerCase());
      const takeSnapshot = (bundleLimits = false) =>
        snapshotAllowlistedHarnessFiles(harnessDir(), {
          acceptsPath: (path) => !isLockedPath(path),
          bundleLimits,
        });
      const syncDenied = () =>
        new HarnessError({
          code: "policy_denied",
          detail: "Portable harness sync is disabled by managed policy.",
        });
      const stalePreview = () =>
        new HarnessError({
          code: "invalid_config",
          detail: "The target harness changed since preview. Review a fresh diff before pushing.",
        });
      const readSnapshot = Effect.fn("HarnessSyncService.readSnapshot")(function* () {
        return yield* Effect.tryPromise({
          try: () => takeSnapshot(true),
          catch: () =>
            new HarnessError({
              code: "io_error",
              detail: "Could not inspect portable harness files.",
            }),
        });
      });

      const exportPortableCatalog = Effect.fn("HarnessSyncService.exportPortableCatalog")(
        function* () {
          const { config, invalidEntries } = yield* store.loadUserConfig;
          const servers: Array<HarnessPortableMcpCatalog["servers"][number]> = [];
          const findings: Array<HarnessSyncSecretFinding> = [];
          if (invalidEntries.length > 0)
            findings.push(safetyFinding(PORTABLE_MCP_FILE, "invalid-mcp-source-config"));
          for (const id of Object.keys(config.mcpServers).toSorted()) {
            const typedId = id as HarnessPortableMcpCatalog["servers"][number]["id"];
            const entry = config.mcpServers[typedId];
            if (!entry || entry.origin?.kind === "project") continue;
            const normalized = portableMcpConfig(entry);
            if (normalized === null) {
              findings.push({
                ...safetyFinding(PORTABLE_MCP_FILE, "unsafe-portable-mcp"),
                ...(SECRET_RULES.some(({ pattern }) => pattern.test(id))
                  ? {}
                  : { serverId: typedId }),
              });
            } else {
              servers.push({ id: typedId, config: normalized });
            }
          }
          const catalog = { version: 1, servers } satisfies HarnessPortableMcpCatalog;
          if (!isPortableMcpCatalog(catalog))
            findings.push(safetyFinding(PORTABLE_MCP_FILE, "unsafe-portable-mcp"));
          scanBufferForSecrets(PORTABLE_MCP_FILE, Buffer.from(stableStringify(catalog)), findings);
          return { catalog, findings: findings.slice(0, 50) };
        },
      );

      const inspectPortableCatalog = Effect.fn("HarnessSyncService.inspectPortableCatalog")(
        function* (
          catalog: HarnessPortableMcpCatalog | undefined,
          git?: { readonly base: HarnessPortableMcpCatalog | null; readonly force: boolean },
        ) {
          const entries: Array<Parameters<typeof store.importUserServers>[0]["entries"][number]> =
            [];
          const mcpServerDiffs: Array<HarnessSyncPreviewReceiveResult["mcpServerDiffs"][number]> =
            [];
          const referenceValues: Array<string> = [];
          const existingState: Array<readonly [string, string | null]> = [];
          if (!catalog?.servers.length)
            return { entries, mcpServerDiffs, missingSecretRefs: [], existingState };
          const { config: existing, invalidEntries } = yield* store.loadUserConfig;
          const workspace = yield* store.resolveWorkspace();
          const storedIds = new Map(
            Object.keys(existing.mcpServers).map((id) => [id.toLowerCase(), id]),
          );
          const baseById = new Map(git?.base?.servers.map((server) => [server.id, server.config]));
          for (const { id, config } of catalog.servers) {
            const oldConfig = baseById.get(id);
            const incomingShape = stableStringify(config);
            if (oldConfig !== undefined && incomingShape === stableStringify(oldConfig)) continue;
            const current = existing.mcpServers[id];
            existingState.push([
              id,
              current === undefined ? null : store.computeConfirmationDigest(current),
            ]);
            const imported = importedMcpConfig(config);
            const disabledOnImport = !imported.enabled;
            const currentPortable = current === undefined ? null : portableMcpConfig(current);
            const currentShape = stableStringify(currentPortable);
            if (
              current !== undefined &&
              (currentShape === incomingShape || currentShape === stableStringify(imported))
            )
              continue;
            const gitConflict =
              git !== undefined &&
              !git.force &&
              (oldConfig === undefined
                ? current !== undefined
                : currentShape !== stableStringify(oldConfig) &&
                  currentShape !== stableStringify(importedMcpConfig(oldConfig)));
            if (
              invalidEntries.length > 0 ||
              gitConflict ||
              (storedIds.has(id.toLowerCase()) && storedIds.get(id.toLowerCase()) !== id) ||
              (current !== undefined && currentPortable === null) ||
              (imported.transport.type === "stdio" && !workspace.managedPolicyAllowsStdio)
            ) {
              mcpServerDiffs.push({ id, status: "conflict", disabledOnImport });
              continue;
            }
            entries.push({
              id,
              config: imported,
              expectedExistingDigest:
                current === undefined ? null : store.computeConfirmationDigest(current),
            });
            mcpServerDiffs.push({
              id,
              status: current === undefined ? "added" : "modified",
              disabledOnImport,
            });
            const transport = config.transport;
            referenceValues.push(
              ...Object.values(
                (transport.type === "stdio" ? transport.env : transport.headers) ?? {},
              ),
            );
          }
          const { missingPlaceholders } = yield* resolveSecretRecord(
            Object.fromEntries(referenceValues.map((value, index) => [String(index), value])),
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
                Layer.succeed(SecretResolver.SecretResolver, secretResolver),
              ),
            ),
          );
          return {
            entries,
            mcpServerDiffs,
            missingSecretRefs: [...new Set(missingPlaceholders)].toSorted(),
            existingState,
          };
        },
      );

      const applyPortableCatalog = Effect.fn("HarnessSyncService.applyPortableCatalog")(function* (
        entries: Parameters<typeof store.importUserServers>[0]["entries"],
      ) {
        if (entries.length === 0) return [];
        let committed = false;
        const save = store.importUserServers({ entries, overwriteExisting: true }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              committed = true;
            }),
          ),
        );
        const synchronized =
          gateway._tag === "None"
            ? save
            : entries
                .toSorted((a, b) => a.id.localeCompare(b.id))
                .reduceRight(
                  (update, { id }) =>
                    gateway.value.updateServer({ serverId: id, scope: "user" }, update).pipe(
                      Effect.asVoid,
                      Effect.catch((error) =>
                        committed
                          ? Effect.logWarning(
                              "Could not retire previous credentials for a synced MCP server",
                              { serverId: id, code: error.code },
                            )
                          : Effect.fail(error),
                      ),
                    ),
                  save,
                );
        yield* Effect.uninterruptible(synchronized);
        return entries.filter(({ config }) => !config.enabled).map(({ id }) => id);
      });

      const inspectReceive = Effect.fn("HarnessSyncService.inspectReceive")(function* (
        bundle: HarnessSyncBundle,
        validation = inspectBundle(bundle),
      ) {
        if (!(yield* readPolicy())) return yield* syncDenied();
        const findings = [...validation];
        if (findings.length > 0)
          return yield* new HarnessError({
            code: "invalid_config",
            detail: "The portable harness bundle failed validation.",
          });
        const target = yield* readSnapshot();
        findings.push(...target.findings);
        const source = new Map(bundle.files.map((file) => [file.path, file]));
        const files: Array<HarnessSyncDiffFile> = [];
        const paths = [...new Set([...source.keys(), ...target.files.keys()])].toSorted();
        const seen = new Set<string>();
        const deadline = performance.now() + 750;
        for (const path of paths) {
          const key = path.toLowerCase();
          if (!isBundlePath(path) || seen.has(key)) {
            findings.push(safetyFinding(".", "disallowed-bundle-path"));
            continue;
          }
          if (isLockedPath(path)) {
            findings.push(safetyFinding(path, "organization-locked-rule"));
            continue;
          }
          seen.add(key);
          const before = target.files.get(path)?.text;
          const after = source.get(path)?.text;
          if (
            before === after &&
            !!source.get(path)?.executable === !!target.files.get(path)?.executable
          )
            continue;
          const diff = diffLines(before ?? "", after ?? "", {
            timeout: Math.max(1, deadline - performance.now()),
            maxEditLength: 20_000,
          });
          if (diff === undefined) {
            findings.push(safetyFinding(path, "unscannable-line-diff"));
            continue;
          }
          files.push({
            path,
            status: before === undefined ? "added" : after === undefined ? "deleted" : "modified",
            additions: NonNegativeInt.make(
              diff.reduce((n, change) => n + (change.added ? change.count : 0), 0),
            ),
            deletions: NonNegativeInt.make(
              diff.reduce((n, change) => n + (change.removed ? change.count : 0), 0),
            ),
          });
        }
        const mcp = yield* inspectPortableCatalog(bundle.portableMcpServers);
        const { mcpServerDiffs, missingSecretRefs, existingState } = mcp;
        const canApply =
          findings.length === 0 &&
          !mcpServerDiffs.some(({ status }) => status === "conflict") &&
          (files.length > 0 || mcp.entries.length > 0);
        const previewDigest = canApply
          ? NodeCrypto.createHmac("sha256", previewKey)
              .update(
                stableStringify({
                  source: bundle.bundleDigest,
                  target: computeTreeDigest(null, target.files),
                  existingState,
                  missingSecretRefs,
                }),
              )
              .digest("hex")
          : null;
        const result: HarnessSyncPreviewReceiveResult = {
          previewDigest,
          files,
          mcpServerDiffs,
          missingSecretRefs,
          secretFindings: findings.slice(0, 50),
          canApply,
          diffSummary: `${files.length} portable file change(s), ${mcpServerDiffs.length} MCP server change(s).`,
        };
        return { result, source, target, mcp };
      });

      const inspectReadOnly = async (
        portable:
          | {
              readonly catalog: HarnessPortableMcpCatalog;
              readonly findings: ReadonlyArray<HarnessSyncSecretFinding>;
            }
          | undefined,
      ) => {
        const hDir = harnessDir();
        const repoDir = syncRepoDir();
        const gitDirExists = await NodeFSP.stat(NodePath.join(repoDir, ".git"))
          .then(() => true)
          .catch(() => false);
        const observed = await takeSnapshot();
        const snapshot = {
          files: new Map(observed.files),
          findings: [...observed.findings, ...(portable?.findings ?? [])],
        };
        if (portable !== undefined && portable.findings.length === 0) {
          const text = `${JSON.stringify(portable.catalog)}\n`;
          const content = Buffer.from(text, "utf8");
          if (content.byteLength <= MAX_SYNC_FILE_BYTES) {
            snapshot.files.set(PORTABLE_MCP_FILE, {
              relPath: PORTABLE_MCP_FILE,
              text,
              content,
              blobSha: gitBlobHash(content),
            });
          } else {
            snapshot.findings.push(safetyFinding(PORTABLE_MCP_FILE, "unscannable-oversized"));
          }
        }

        if (!gitDirExists) {
          return {
            harnessDir: hDir,
            initialized: false,
            includePortableMcpServers: false,
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
          includePortableMcpServers: portable !== undefined,
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

      const inspectGit = Effect.fn("HarnessSyncService.inspectGit")(function* () {
        const include = yield* Effect.tryPromise({
          try: async () => {
            if (
              !(await NodeFSP.stat(syncRepoDir())
                .then(() => true)
                .catch(() => false))
            )
              return false;
            const result = await runGit(syncRepoDir(), [
              "config",
              "--local",
              "--bool",
              "--get",
              PORTABLE_MCP_GIT_CONFIG,
            ]);
            return result.code === 0 && result.stdout.trim() === "true";
          },
          catch: () =>
            new HarnessError({
              code: "io_error",
              detail: "Could not read harness Git configuration.",
            }),
        });
        const portable = include ? yield* exportPortableCatalog() : undefined;
        return yield* Effect.tryPromise({
          try: () => inspectReadOnly(portable),
          catch: () =>
            new HarnessError({ code: "io_error", detail: "Could not inspect harness Git state." }),
        });
      });

      const gitPortableCatalog = async (sha: string): Promise<HarnessPortableMcpCatalog | null> => {
        const repo = syncRepoDir();
        const size = await runGit(repo, ["cat-file", "-s", sha]);
        if (size.code !== 0 || Number(size.stdout) > MAX_SYNC_FILE_BYTES) return null;
        const blob = await runGitBuffer(repo, ["cat-file", "blob", sha]);
        if (blob.code !== 0) return null;
        const text = blob.stdout.toString("utf8");
        if (!Buffer.from(text).equals(blob.stdout)) return null;
        const findings: Array<HarnessSyncSecretFinding> = [];
        scanBufferForSecrets(PORTABLE_MCP_FILE, blob.stdout, findings);
        return findings.length === 0 ? readPortableMcpCatalog(text) : null;
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

        const inspected = yield* inspectGit();
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
          includePortableMcpServers: inspected.includePortableMcpServers,
          lastError: null,
        } satisfies HarnessSyncStatus;
      });

      return HarnessSyncService.of({
        getStatus,
        exportBundle: Effect.fn("HarnessSyncService.exportBundle")(function* ({
          includeMcpServers,
        }) {
          if (!(yield* readPolicy())) return yield* syncDenied();
          const snapshot = yield* readSnapshot();
          const portable = includeMcpServers ? yield* exportPortableCatalog() : undefined;
          const payload: Omit<HarnessSyncBundle, "bundleDigest"> = {
            version: 1,
            files: [...snapshot.files.values()].map((file) => ({
              path: file.relPath,
              text: file.text,
              ...(file.executable ? { executable: true } : {}),
            })),
            ...(portable === undefined ? {} : { portableMcpServers: portable.catalog }),
          };
          const bundle = { ...payload, bundleDigest: bundleDigest(payload) };
          const findings = [
            ...new Map(
              [...snapshot.findings, ...(portable?.findings ?? []), ...inspectBundle(bundle)].map(
                (finding) => [
                  `${finding.path}\0${finding.line}\0${finding.rule}\0${finding.serverId ?? ""}`,
                  finding,
                ],
              ),
            ).values(),
          ].slice(0, 50);
          return {
            bundle: findings.length === 0 ? bundle : null,
            canExport: findings.length === 0,
            secretFindings: findings,
          };
        }),
        previewReceive: Effect.fn("HarnessSyncService.previewReceive")(function* ({ bundle }) {
          const findings = inspectBundle(bundle);
          if (findings.length > 0) {
            if (!(yield* readPolicy())) return yield* syncDenied();
            return {
              previewDigest: null,
              files: [],
              mcpServerDiffs: [],
              missingSecretRefs: [],
              secretFindings: findings,
              canApply: false,
              diffSummary: "The portable harness bundle failed validation.",
            };
          }
          const inspected = yield* inspectReceive(bundle, findings);
          return inspected.result;
        }),
        applyReceive: Effect.fn("HarnessSyncService.applyReceive")(function* (input) {
          return yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const { result, source, target, mcp } = yield* inspectReceive(input.bundle);
              if (!result.canApply || result.previewDigest !== input.expectedPreviewDigest)
                return yield* stalePreview();
              const available = new Map(result.files.map((file) => [file.path, file.status]));
              const selected = input.selectedPaths ?? [...available.keys()];
              if (
                new Set(selected).size !== selected.length ||
                selected.some((path) => !available.has(path))
              ) {
                return yield* new HarnessError({
                  code: "invalid_config",
                  detail: "Select only files shown in the target preview.",
                });
              }
              const selectedPaths = selected.filter(
                (path) => available.get(path) !== "deleted" || input.deleteRemovedFiles === true,
              );
              const root = harnessDir();
              const appliedPaths: Array<string> = [];
              const write = (
                path: string,
                item: { text: string; executable?: boolean } | undefined,
              ) => {
                const file = NodePath.join(root, path);
                return item === undefined
                  ? safeRemoveFile(root, file)
                  : safeWriteFileAtomic(root, file, item.text, item.executable ? 0o755 : 0o600);
              };
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const writeFiles = Effect.tryPromise({
                    try: async () => {
                      for (const path of selectedPaths) {
                        const current = await readLocalBlobSha(root, NodePath.join(root, path));
                        const prior = target.files.get(path);
                        if (
                          current !== (prior ? fileIdentity(prior.blobSha, prior.executable) : null)
                        )
                          throw stalePreview();
                        await write(path, source.get(path));
                        appliedPaths.push(path);
                      }
                    },
                    catch: (error) =>
                      isHarnessError(error)
                        ? error
                        : new HarnessError({
                            code: "io_error",
                            detail: "Could not apply the selected portable harness files.",
                          }),
                  });
                  const importedDisabledMcpIds = yield* writeFiles.pipe(
                    Effect.andThen(
                      input.includeMcpServers === true
                        ? applyPortableCatalog(mcp.entries)
                        : Effect.succeed([]),
                    ),
                    Effect.onError(() =>
                      Effect.promise(async () => {
                        for (const path of appliedPaths.toReversed()) {
                          const replacement = source.get(path);
                          const current = await readLocalBlobSha(
                            root,
                            NodePath.join(root, path),
                          ).catch(() => undefined);
                          if (
                            current ===
                            (replacement === undefined
                              ? null
                              : fileIdentity(
                                  gitBlobHash(Buffer.from(replacement.text)),
                                  replacement.executable,
                                ))
                          ) {
                            await write(path, target.files.get(path)).catch(() => undefined);
                          }
                        }
                      }),
                    ),
                  );
                  return {
                    appliedPaths,
                    importedDisabledMcpIds,
                    missingSecretRefs:
                      input.includeMcpServers === true ? result.missingSecretRefs : [],
                    summary: `Applied ${appliedPaths.length} portable file change(s) and ${input.includeMcpServers === true ? mcp.entries.length : 0} MCP server change(s).`,
                  };
                }),
              );
            }),
          );
        }),
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
                if (input.includePortableMcpServers !== undefined) {
                  const previousPreference = await runGit(repoDir, [
                    "config",
                    "--local",
                    "--get",
                    PORTABLE_MCP_GIT_CONFIG,
                  ]);
                  if (previousPreference.code === 1) {
                    const head = await resolveRef("HEAD");
                    // Older clients could fetch a catalog before they tracked portable MCP pulls.
                    if (
                      head &&
                      (await gitTree(head)).some(
                        (entry) => entry.path === PORTABLE_MCP_FILE && isRegularSyncEntry(entry),
                      )
                    ) {
                      const pending = await readPendingPullBases(gitDir, pendingPath);
                      if (!pending.has(PORTABLE_MCP_FILE)) {
                        pending.set(PORTABLE_MCP_FILE, null);
                        await writePendingPullBases(gitDir, pendingPath, pending);
                      }
                    }
                  }
                  const configured = await runGit(repoDir, [
                    "config",
                    "--local",
                    PORTABLE_MCP_GIT_CONFIG,
                    String(input.includePortableMcpServers),
                  ]);
                  if (configured.code !== 0)
                    throw new Error("Could not save the portable MCP sync preference.");
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
          const inspected = yield* inspectGit();
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
          } satisfies HarnessSyncPreviewPushResult;
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
              const inspected = yield* inspectGit();

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
                      file.executable ? 0o755 : 0o600,
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
              const inspected = yield* inspectGit();
              if (!inspected.initialized || !inspected.remoteUrl || !inspected.branch) {
                return yield* new HarnessError({
                  code: "invalid_config",
                  detail: "Configure a harness Git remote before pulling.",
                });
              }
              const branch = inspected.branch;
              const received = yield* Effect.tryPromise({
                try: async () => {
                  await assertSafeRemote();
                  const beforeEntries = inspected.headSha ? await gitTree(inspected.headSha) : [];
                  const beforeAllowlisted = new Map(
                    beforeEntries
                      .filter(isRegularSyncEntry)
                      .map((entry) => [entry.path, treeIdentity(entry)]),
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
                      .map((entry) => [entry.path, treeIdentity(entry)]),
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
                    writePendingPullBases(gitDir, pendingPath, pendingBases);
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
                    if (path === PORTABLE_MCP_FILE) continue;
                    if (isLockedPath(path)) {
                      pendingBases.delete(path);
                      skippedFiles.add(path);
                      continue;
                    }
                    const entry = afterEntries.get(path);
                    if (entry !== undefined && !isRegularSyncEntry(entry)) continue;
                    const remote = entry ? treeIdentity(entry) : null;
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
                      await safeWriteFileAtomic(
                        hDir,
                        target,
                        text,
                        path.startsWith("skills/") && entry.mode === "100755" ? 0o755 : 0o600,
                      );
                    }
                    updatedFiles.push(path);
                    pendingBases.delete(path);
                  }
                  const entry = afterEntries.get(PORTABLE_MCP_FILE);
                  const portableBase = pendingBases.get(PORTABLE_MCP_FILE);
                  let portableCatalog: HarnessPortableMcpCatalog | null = null;
                  let previousPortableCatalog: HarnessPortableMcpCatalog | null = null;
                  if (
                    entry === undefined ||
                    (isRegularSyncEntry(entry) && entry.sha === portableBase)
                  ) {
                    pendingBases.delete(PORTABLE_MCP_FILE);
                  } else if (inspected.includePortableMcpServers && portableBase !== undefined) {
                    portableCatalog = isRegularSyncEntry(entry)
                      ? await gitPortableCatalog(entry.sha)
                      : null;
                    if (portableCatalog === null) {
                      skippedFiles.add(PORTABLE_MCP_FILE);
                    } else if (portableBase !== null) {
                      previousPortableCatalog = await gitPortableCatalog(portableBase);
                    }
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
                  const result: HarnessSyncPullResult = {
                    pulled: true,
                    updatedFiles,
                    ...(inspected.includePortableMcpServers ? { importedDisabledMcpIds: [] } : {}),
                    ...(skippedFiles.size > 0 ? { skippedFiles: [...skippedFiles] } : {}),
                    ...(conflicts.length > 0 ? { conflicts } : {}),
                    summary: `Applied ${updatedFiles.length} allowlisted file change(s) from origin/${branch}.${skippedSuffix}${conflictSuffix}`,
                  };
                  return {
                    result,
                    portableCatalog,
                    previousPortableCatalog,
                    settlePortable: async () => {
                      if (pendingBases.delete(PORTABLE_MCP_FILE)) await writePendingBases();
                    },
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
              if (received.portableCatalog === null) return received.result;
              const planned = yield* inspectPortableCatalog(received.portableCatalog, {
                base: received.previousPortableCatalog,
                force: input?.force === true,
              });
              const blocked = planned.mcpServerDiffs.some(({ status }) => status === "conflict");
              const importedDisabledMcpIds = blocked
                ? []
                : yield* applyPortableCatalog(planned.entries);
              if (!blocked)
                yield* Effect.tryPromise({
                  try: received.settlePortable,
                  catch: () =>
                    new HarnessError({
                      code: "io_error",
                      detail: "Could not record the portable MCP sync outcome.",
                    }),
                });
              return {
                ...received.result,
                ...(blocked
                  ? {
                      conflicts: [
                        ...(received.result.conflicts ?? []),
                        { path: PORTABLE_MCP_FILE, reason: "modified_both" as const },
                      ],
                    }
                  : {}),
                importedDisabledMcpIds,
                missingSecretRefs: planned.missingSecretRefs,
                summary: `${received.result.summary} Applied ${blocked ? 0 : planned.entries.length} portable MCP server change(s).${blocked ? " Some MCP definitions conflict with local settings." : ""}${planned.missingSecretRefs.length ? ` Missing secret references: ${planned.missingSecretRefs.join(", ")}.` : ""}`,
              };
            }),
          );
        }),
      });
    }),
  );

export const layer = makeLayer();
