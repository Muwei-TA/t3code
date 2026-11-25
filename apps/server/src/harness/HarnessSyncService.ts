// @effect-diagnostics nodeBuiltinImport:off -- Runs git commands and secret-safety scans on ~/.t3/harness/.
import * as NodeChildProcess from "node:child_process";
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

import * as HarnessStore from "./HarnessStore.ts";

const HARNESS_GITIGNORE_CONTENT = [
  "# T3 Code local trust ledgers & machine-local state (never sync)",
  "plugins-state.json",
  "approval-rules.json",
  ".t3-trust",
  "*.sqlite",
  "*.sqlite-*",
  "secrets",
  "secrets.*",
  "*.env",
  ".env*",
  "",
].join("\n");

const LOCAL_ONLY_BASENAMES = new Set([
  "plugins-state.json",
  "approval-rules.json",
  ".t3-trust",
  "secrets",
]);

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

function redactPreview(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= 20) return "***";
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-4)}`;
}

/**
 * Scans portable harness files for literal secrets while allowing `${secret:NAME}` placeholders.
 * Never scans `.git/` or machine-local trust ledgers excluded by `.gitignore`.
 */
async function scanHarnessDirectoryForSecrets(
  harnessDir: string,
): Promise<ReadonlyArray<HarnessSyncSecretFinding>> {
  const findings: Array<HarnessSyncSecretFinding> = [];

  const walk = async (currentDir: string, relPrefix: string) => {
    const entries = await NodeFSP.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (LOCAL_ONLY_BASENAMES.has(entry.name) || entry.name.endsWith(".sqlite")) continue;
      const fullPath = NodePath.join(currentDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await NodeFSP.stat(fullPath).catch(() => null);
      if (!stat || stat.size > 512 * 1024) continue;
      const content = await NodeFSP.readFile(fullPath, "utf8").catch(() => null);
      if (content === null) continue;
      const lines = content.split(/\r?\n/u);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Strip safe ${secret:...} references before checking literal secret patterns.
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
  };

  await walk(harnessDir, "");
  return findings;
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

async function ensureGitignore(harnessDir: string): Promise<void> {
  const ignorePath = NodePath.join(harnessDir, ".gitignore");
  const exists = await NodeFSP.stat(ignorePath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await NodeFSP.writeFile(ignorePath, HARNESS_GITIGNORE_CONTENT, "utf8");
  }
}

async function collectDiffFiles(harnessDir: string): Promise<{
  readonly files: ReadonlyArray<HarnessSyncDiffFile>;
  readonly diffSummary: string;
}> {
  const statusRes = await runGit(harnessDir, ["status", "--porcelain=v1", "-uall"]);
  const numstatRes = await runGit(harnessDir, ["diff", "--numstat", "HEAD"]);
  const statsByPath = new Map<string, { additions: number; deletions: number }>();
  if (numstatRes.code === 0) {
    for (const line of numstatRes.stdout.split(/\r?\n/u)) {
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const additions = Number.parseInt(parts[0] ?? "0", 10);
        const deletions = Number.parseInt(parts[1] ?? "0", 10);
        const filePath = parts[2] ?? "";
        if (filePath) {
          statsByPath.set(filePath, {
            additions: Number.isFinite(additions) ? Math.max(0, additions) : 0,
            deletions: Number.isFinite(deletions) ? Math.max(0, deletions) : 0,
          });
        }
      }
    }
  }

  const files: Array<HarnessSyncDiffFile> = [];
  for (const rawLine of statusRes.stdout.split(/\r?\n/u)) {
    if (rawLine.length < 4) continue;
    const code = rawLine.slice(0, 2);
    const filePath = rawLine.slice(3).trim();
    if (!filePath) continue;
    let status: HarnessSyncDiffFile["status"] = "modified";
    if (code === "??") status = "untracked";
    else if (code.includes("A")) status = "added";
    else if (code.includes("D")) status = "deleted";
    const stat = statsByPath.get(filePath);
    files.push({
      path: filePath,
      status,
      additions: NonNegativeInt.make(stat?.additions ?? 0),
      deletions: NonNegativeInt.make(stat?.deletions ?? 0),
    });
  }

  const diffStatRes = await runGit(harnessDir, ["diff", "--stat"]);
  const diffSummary =
    diffStatRes.stdout.trim() ||
    (files.length > 0 ? `${files.length} changed file(s) ready for sync.` : "Working tree clean.");

  return { files, diffSummary };
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
    const harnessDir = () => store.harnessDir;

    const readPolicy = () =>
      store
        .resolveWorkspace()
        .pipe(Effect.map((workspace) => workspace.managedPolicyAllowsHarness));

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
          await NodeFSP.mkdir(dir, { recursive: true });
          const gitDirExists = await NodeFSP.stat(NodePath.join(dir, ".git"))
            .then(() => true)
            .catch(() => false);
          const secretFindings = await scanHarnessDirectoryForSecrets(dir);

          if (!gitDirExists) {
            return {
              harnessDir: dir,
              initialized: false,
              branch: null,
              remoteUrl: null,
              dirtyCount: NonNegativeInt.make(0),
              ahead: NonNegativeInt.make(0),
              behind: NonNegativeInt.make(0),
              secretFindings,
              canPush: false,
              managedPolicyAllowsHarness: true,
              lastError: null,
            };
          }

          const branchRes = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
          const branch =
            branchRes.code === 0 && branchRes.stdout.trim() && branchRes.stdout.trim() !== "HEAD"
              ? branchRes.stdout.trim()
              : "main";
          const remoteRes = await runGit(dir, ["remote", "get-url", "origin"]);
          const remoteUrl = remoteRes.code === 0 ? remoteRes.stdout.trim() || null : null;
          const statusRes = await runGit(dir, ["status", "--porcelain=v1"]);
          const dirtyCount = statusRes.stdout
            .split(/\r?\n/u)
            .filter((line) => line.trim().length > 0).length;

          let ahead = 0;
          let behind = 0;
          const abRes = await runGit(dir, [
            "rev-list",
            "--left-right",
            "--count",
            `HEAD...@{upstream}`,
          ]);
          if (abRes.code === 0) {
            const [aText, bText] = abRes.stdout.trim().split(/\s+/u);
            ahead = Number.parseInt(aText ?? "0", 10) || 0;
            behind = Number.parseInt(bText ?? "0", 10) || 0;
          }

          return {
            harnessDir: dir,
            initialized: true,
            branch,
            remoteUrl,
            dirtyCount: NonNegativeInt.make(dirtyCount),
            ahead: NonNegativeInt.make(Math.max(0, ahead)),
            behind: NonNegativeInt.make(Math.max(0, behind)),
            secretFindings,
            canPush: remoteUrl !== null && secretFindings.length === 0,
            managedPolicyAllowsHarness: true,
            lastError: null,
          };
        },
        catch: (error) =>
          new HarnessError({
            code: "io_error",
            detail: `Failed to inspect harness git sync status: ${error instanceof Error ? error.message : String(error)}`,
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
        const dir = harnessDir();
        const targetBranch = input.branch ?? "main";
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(dir, { recursive: true });
            const hasGit = await NodeFSP.stat(NodePath.join(dir, ".git"))
              .then(() => true)
              .catch(() => false);
            if (!hasGit) {
              const init = await runGit(dir, ["init", "-b", targetBranch]);
              if (init.code !== 0) {
                throw new Error(init.stderr.trim() || "git init failed");
              }
            }
            await ensureGitignore(dir);
            const hasOrigin = await runGit(dir, ["remote", "get-url", "origin"]);
            const setRemote =
              hasOrigin.code === 0
                ? await runGit(dir, ["remote", "set-url", "origin", input.remoteUrl])
                : await runGit(dir, ["remote", "add", "origin", input.remoteUrl]);
            if (setRemote.code !== 0) {
              throw new Error(setRemote.stderr.trim() || "git remote update failed");
            }
          },
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Failed to configure harness git remote: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        return yield* getStatus();
      }),
      previewPush: Effect.fn("HarnessSyncService.previewPush")(function* () {
        const status = yield* getStatus();
        if (!status.managedPolicyAllowsHarness) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Portable harness sync is disabled by managed policy.",
          });
        }
        const dir = harnessDir();
        if (!status.initialized) {
          return {
            branch: null,
            remoteUrl: null,
            files: [],
            secretFindings: status.secretFindings,
            canPush: false,
            diffSummary: "Harness Git sync is not configured yet.",
          } satisfies HarnessSyncPreviewPushResult;
        }
        const { files, diffSummary } = yield* Effect.tryPromise({
          try: async () => {
            await ensureGitignore(dir);
            return await collectDiffFiles(dir);
          },
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Failed to preview harness push diff: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        return {
          branch: status.branch,
          remoteUrl: status.remoteUrl,
          files,
          secretFindings: status.secretFindings,
          canPush: status.remoteUrl !== null && status.secretFindings.length === 0,
          diffSummary,
        } satisfies HarnessSyncPreviewPushResult;
      }),
      push: Effect.fn("HarnessSyncService.push")(function* (input) {
        const status = yield* getStatus();
        if (!status.managedPolicyAllowsHarness) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Portable harness sync is disabled by managed policy.",
          });
        }
        if (!status.initialized || !status.remoteUrl) {
          return yield* new HarnessError({
            code: "invalid_config",
            detail: "Configure a harness Git remote before pushing.",
          });
        }
        if (status.secretFindings.length > 0) {
          const sample = status.secretFindings
            .slice(0, 3)
            .map((f) => `${f.path}:${f.line} (${f.rule})`)
            .join(", ");
          return yield* new HarnessError({
            code: "policy_denied",
            detail: `Push blocked: detected ${status.secretFindings.length} raw secret pattern(s) (${sample}). Replace literals with \${secret:NAME} references before syncing.`,
          });
        }
        const dir = harnessDir();
        const branch = status.branch ?? "main";
        const message = input.commitMessage ?? "chore(harness): sync portable harness";
        return yield* Effect.tryPromise({
          try: async (): Promise<HarnessSyncPushResult> => {
            await ensureGitignore(dir);
            const { files } = await collectDiffFiles(dir);
            let committed = false;
            let commitSha: string | undefined;
            if (files.length > 0) {
              const addRes = await runGit(dir, ["add", "-A"]);
              if (addRes.code !== 0) {
                throw new Error(addRes.stderr.trim() || "git add failed");
              }
              // Ensure author identity is present even on fresh environments.
              const commitRes = await runGit(dir, [
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
              const shaRes = await runGit(dir, ["rev-parse", "--short", "HEAD"]);
              if (shaRes.code === 0) {
                commitSha = shaRes.stdout.trim() || undefined;
              }
            }
            const pushRes = await runGit(dir, ["push", "-u", "origin", branch]);
            if (pushRes.code !== 0) {
              throw new Error(pushRes.stderr.trim() || "git push failed");
            }
            return {
              committed,
              pushed: true,
              ...(commitSha ? { commitSha } : {}),
              filesCommitted: NonNegativeInt.make(files.length),
              summary: committed
                ? `Committed ${files.length} file(s) and pushed ${branch} to origin.`
                : `Pushed ${branch} to origin (no new local changes).`,
            };
          },
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Harness sync push failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
      }),
      pull: Effect.fn("HarnessSyncService.pull")(function* () {
        const status = yield* getStatus();
        if (!status.managedPolicyAllowsHarness) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Portable harness sync is disabled by managed policy.",
          });
        }
        if (!status.initialized || !status.remoteUrl) {
          return yield* new HarnessError({
            code: "invalid_config",
            detail: "Configure a harness Git remote before pulling.",
          });
        }
        const dir = harnessDir();
        const branch = status.branch ?? "main";
        return yield* Effect.tryPromise({
          try: async (): Promise<HarnessSyncPullResult> => {
            const beforeRes = await runGit(dir, ["rev-parse", "HEAD"]);
            const beforeSha = beforeRes.code === 0 ? beforeRes.stdout.trim() : "";
            const pullRes = await runGit(dir, ["pull", "--ff-only", "origin", branch]);
            if (pullRes.code !== 0) {
              throw new Error(pullRes.stderr.trim() || "git pull --ff-only failed");
            }
            const afterRes = await runGit(dir, ["rev-parse", "HEAD"]);
            const afterSha = afterRes.code === 0 ? afterRes.stdout.trim() : "";
            let updatedFiles: Array<string> = [];
            if (beforeSha && afterSha && beforeSha !== afterSha) {
              const diffNames = await runGit(dir, [
                "diff",
                "--name-only",
                `${beforeSha}..${afterSha}`,
              ]);
              updatedFiles = diffNames.stdout
                .split(/\r?\n/u)
                .map((s) => s.trim())
                .filter(Boolean);
            }
            return {
              pulled: true,
              updatedFiles,
              summary:
                updatedFiles.length > 0
                  ? `Pulled ${updatedFiles.length} updated file(s) from origin/${branch}.`
                  : `Harness is already up to date with origin/${branch}.`,
            };
          },
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Harness sync pull failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
      }),
    });
  }),
);
