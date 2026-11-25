// @effect-diagnostics nodeBuiltinImport:off -- Creates temporary bare git repositories for push/pull, isolation, history-scan, and secret-guard verification.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessStore from "./HarnessStore.ts";
import * as HarnessSyncService from "./HarnessSyncService.ts";

function makeTestLayer(baseDir: string, paths: ServerConfig.ServerDerivedPaths) {
  const configLayer = Layer.succeed(ServerConfig.ServerConfig, {
    ...paths,
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: baseDir,
    baseDir,
  } as unknown as ServerConfig.ServerConfig["Service"]);
  const policyLayer = Layer.succeed(ManagedPolicy.ManagedPolicy, {
    document: undefined,
    source: undefined,
    error: undefined,
  } as unknown as ManagedPolicy.ManagedPolicy["Service"]);
  const storeLayer = HarnessStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(policyLayer),
    Layer.provideMerge(T3ProjectFileLoader.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return HarnessSyncService.layer.pipe(Layer.provideMerge(storeLayer));
}

function execGit(cwd: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", [...args], {
      cwd,
      stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed (${code})`)),
    );
  });
}

describe("HarnessSyncService", () => {
  it.effect(
    "isolates git repo from harnessDir, blocks secrets/oversized/drift/credentials, and enforces strict allowlist on push and pull",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-sync-" });
        const bareRemote = path.join(tempRoot, "remote.git");
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(bareRemote, { recursive: true });
          await execGit(bareRemote, ["init", "--bare", "-b", "main"]);
        });

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const sync = yield* HarnessSyncService.HarnessSyncService;

          // Read-only status/preview before configuration must not create .git or .gitignore in harnessDir.
          const initialStatus = yield* sync.getStatus();
          expect(initialStatus.initialized).toBe(false);
          const initialPreview = yield* sync.previewPush();
          expect(initialPreview.canPush).toBe(false);
          expect(initialPreview.previewTreeDigest).toBeNull();
          const hasGitInHarness = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(store.harnessDir, ".git"))
              .then(() => true)
              .catch(() => false),
          );
          expect(hasGitInHarness).toBe(false);

          // Reject remote URLs containing embedded credentials.
          const badRemote = yield* sync
            .configureRemote({
              remoteUrl: TrimmedNonEmptyString.make(
                "https://ghp_secretToken123@github.com/org/repo.git",
              ),
              branch: TrimmedNonEmptyString.make("main"),
            })
            .pipe(Effect.result);
          expect(Result.isFailure(badRemote)).toBe(true);
          if (Result.isFailure(badRemote)) {
            expect(badRemote.failure.code).toBe("invalid_config");
          }

          const configured = yield* sync.configureRemote({
            remoteUrl: TrimmedNonEmptyString.make(bareRemote),
            branch: TrimmedNonEmptyString.make("main"),
          });
          expect(configured.initialized).toBe(true);
          expect(configured.remoteUrl).toBe(bareRemote);

          // Write allowlisted files (one with raw secret), plus excluded executable/trust files.
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.join(store.harnessDir, "memory"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "harness.json"),
              JSON.stringify({ mcpServers: { bad: { command: "sh" } } }),
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "plugins-state.json"),
              JSON.stringify({ trustedDigests: { demo: "abc" } }),
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "memory", "leak.md"),
              "Do not leak ghp_1234567890abcdefghij1234567890",
              "utf8",
            );
          });

          const blockedPreview = yield* sync.previewPush();
          expect(blockedPreview.canPush).toBe(false);
          expect(blockedPreview.secretFindings.some((f) => f.rule === "github-token")).toBe(true);
          // Excluded local trust ledgers & executable configs must never appear in outbound files.
          expect(blockedPreview.files.some((f) => f.path.includes("plugins-state.json"))).toBe(
            false,
          );
          expect(blockedPreview.files.some((f) => f.path.includes("harness.json"))).toBe(false);

          const blockedPush = yield* sync
            .push({
              expectedRemoteUrl: TrimmedNonEmptyString.make(bareRemote),
              expectedBranch: TrimmedNonEmptyString.make("main"),
              expectedTreeDigest: TrimmedNonEmptyString.make(
                blockedPreview.previewTreeDigest ?? "missing",
              ),
            })
            .pipe(Effect.result);
          expect(Result.isFailure(blockedPush)).toBe(true);
          if (Result.isFailure(blockedPush)) {
            expect(blockedPush.failure.code).toBe("policy_denied");
          }

          // Oversized (>512 KiB) allowlisted file must fail closed (never silently skipped).
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "memory", "leak.md"),
              "A".repeat(600 * 1024),
              "utf8",
            );
          });
          const oversizedPreview = yield* sync.previewPush();
          expect(oversizedPreview.canPush).toBe(false);
          expect(
            oversizedPreview.secretFindings.some((f) => f.rule === "unscannable-oversized"),
          ).toBe(true);

          // Replace with safe content referencing ${secret:GITHUB_TOKEN}.
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "memory", "leak.md"),
              "Use ${secret:GITHUB_TOKEN} instead.",
              "utf8",
            );
          });

          const safePreview = yield* sync.previewPush();
          expect(safePreview.canPush).toBe(true);
          expect(safePreview.secretFindings).toEqual([]);
          expect(safePreview.previewTreeDigest).not.toBeNull();

          // Mutating the file AFTER preview must fail push because tree digest drifted.
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "memory", "leak.md"),
              "Changed after preview!",
              "utf8",
            );
          });
          const driftedPush = yield* sync
            .push({
              expectedRemoteUrl: TrimmedNonEmptyString.make(bareRemote),
              expectedBranch: TrimmedNonEmptyString.make("main"),
              expectedTreeDigest: TrimmedNonEmptyString.make(safePreview.previewTreeDigest!),
            })
            .pipe(Effect.result);
          expect(Result.isFailure(driftedPush)).toBe(true);
          if (Result.isFailure(driftedPush)) {
            expect(driftedPush.failure.code).toBe("invalid_config");
          }

          // Fresh preview + push succeeds cleanly.
          const freshPreview = yield* sync.previewPush();
          expect(freshPreview.canPush).toBe(true);
          const pushed = yield* sync.push({
            commitMessage: TrimmedNonEmptyString.make("chore: initial portable harness"),
            expectedRemoteUrl: TrimmedNonEmptyString.make(bareRemote),
            expectedBranch: TrimmedNonEmptyString.make("main"),
            expectedTreeDigest: TrimmedNonEmptyString.make(freshPreview.previewTreeDigest!),
          });
          expect(pushed.committed).toBe(true);
          expect(pushed.pushed).toBe(true);

          // Simulate a malicious remote commit introducing hooks.json, harness.json, plugins-state.json,
          // AND a legitimate allowlisted rule file.
          const attackerClone = path.join(tempRoot, "attacker");
          yield* Effect.promise(async () => {
            await execGit(tempRoot, ["clone", bareRemote, attackerClone]);
            await NodeFSP.mkdir(NodePath.join(attackerClone, "rules"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(attackerClone, "rules", "safe-rule.md"),
              "---\napply: always\n---\nAlways write tests.\n",
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(attackerClone, "hooks.json"),
              JSON.stringify({ version: 1, hooks: [{ id: "evil", event: "turn.beforeStart" }] }),
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(attackerClone, "plugins-state.json"),
              JSON.stringify({ trustedDigests: { evil: "deadbeef" }, enabled: { evil: true } }),
              "utf8",
            );
            await execGit(attackerClone, ["add", "-A"]);
            await execGit(attackerClone, [
              "-c",
              "user.name=Remote",
              "-c",
              "user.email=remote@example.com",
              "commit",
              "-m",
              "remote update with mixed files",
            ]);
            await execGit(attackerClone, ["push", "origin", "main"]);
          });

          const pulled = yield* sync.pull();
          expect(pulled.pulled).toBe(true);
          expect(pulled.updatedFiles).toContain("rules/safe-rule.md");
          expect(pulled.skippedFiles).toContain("hooks.json");
          expect(pulled.skippedFiles).toContain("plugins-state.json");

          // Verify hooks.json did NOT land in live harnessDir and local plugins-state.json was untouched!
          const hooksExists = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(store.harnessDir, "hooks.json"))
              .then(() => true)
              .catch(() => false),
          );
          expect(hooksExists).toBe(false);
          const localPluginsState = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(store.harnessDir, "plugins-state.json"), "utf8"),
          );
          expect(localPluginsState).toContain("demo");
          expect(localPluginsState).not.toContain("evil");
        }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("sanitizes remote URLs with embedded userinfo", () => {
    expect(
      HarnessSyncService.hasEmbeddedRemoteCredentials("https://token@github.com/org/repo.git"),
    ).toBe(true);
    expect(HarnessSyncService.hasEmbeddedRemoteCredentials("git@github.com:org/repo.git")).toBe(
      false,
    );
    expect(HarnessSyncService.sanitizeRemoteUrl("https://user:pass@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });
});
