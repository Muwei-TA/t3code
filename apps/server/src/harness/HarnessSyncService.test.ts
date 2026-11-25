// @effect-diagnostics nodeBuiltinImport:off -- Creates temporary bare git repositories for push/pull and secret-guard verification.
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
    const child = NodeChildProcess.spawn("git", [...args], { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed (${code})`)),
    );
  });
}

describe("HarnessSyncService", () => {
  it.effect(
    "blocks push when raw secrets exist, allows ${secret:NAME}, ignores local trust ledgers, and syncs push/pull against a Git remote",
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

          const configured = yield* sync.configureRemote({
            remoteUrl: TrimmedNonEmptyString.make(bareRemote),
            branch: TrimmedNonEmptyString.make("main"),
          });
          expect(configured.initialized).toBe(true);
          expect(configured.remoteUrl).toBe(bareRemote);

          // Write a safe file referencing ${secret:OPENAI_API_KEY}, a local trust ledger, and a leaked raw key.
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.join(store.harnessDir, "memory"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "mcp.json"),
              JSON.stringify({ token: "${secret:OPENAI_API_KEY}" }),
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
          expect(blockedPreview.secretFindings.length).toBeGreaterThan(0);
          expect(blockedPreview.secretFindings[0]?.rule).toBe("github-token");
          // Local trust ledger must be gitignored and absent from outbound diff files.
          expect(blockedPreview.files.some((f) => f.path.includes("plugins-state.json"))).toBe(
            false,
          );

          const blockedPush = yield* sync.push({}).pipe(Effect.result);
          expect(Result.isFailure(blockedPush)).toBe(true);
          if (Result.isFailure(blockedPush)) {
            expect(blockedPush.failure.code).toBe("policy_denied");
          }

          // Replace raw secret with a safe placeholder -> preview turns green and push succeeds.
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

          const pushed = yield* sync.push({
            commitMessage: TrimmedNonEmptyString.make("chore: initial portable harness"),
          });
          expect(pushed.committed).toBe(true);
          expect(pushed.pushed).toBe(true);

          const pulled = yield* sync.pull();
          expect(pulled.pulled).toBe(true);
        }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
