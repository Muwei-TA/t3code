import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HarnessHookId, PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessHooksService from "./HarnessHooksService.ts";
import * as HarnessStore from "./HarnessStore.ts";

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
  const hooksLayer = HarnessHooksService.layer.pipe(Layer.provideMerge(storeLayer));
  return Layer.mergeAll(configLayer, policyLayer, storeLayer, hooksLayer, NodeServices.layer);
}

describe("HarnessHooksService", () => {
  it.effect(
    "supports turn.beforeStart context injection, blocking, bounded timeout degradation, and PreToolUse gating",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-hooks-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        yield* Effect.gen(function* () {
          const hooks = yield* HarnessHooksService.HarnessHooksService;

          // 1. Context-injecting hook on turn.beforeStart
          yield* hooks.upsertUserHook({
            id: HarnessHookId.make("inject-note"),
            event: "turn.beforeStart",
            target: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                'process.stdout.write(JSON.stringify({ injectContext: "[policy] Always check tests." }))',
              ],
            },
          });

          const injected = yield* hooks.runBeforeTurnStart({
            threadId: "t1",
            modeId: "build",
            text: "Fix login",
          });
          expect(injected.blocked).toBe(false);
          expect(injected.injectedContext).toBe("[policy] Always check tests.");

          // 2. Timeout safe degradation (failClosed=false never stalls or blocks turns)
          yield* hooks.upsertUserHook({
            id: HarnessHookId.make("slow-hook"),
            event: "turn.beforeStart",
            timeoutMs: PositiveInt.make(150),
            failClosed: false,
            target: {
              type: "command",
              command: process.execPath,
              args: ["-e", "setTimeout(() => {}, 5000)"],
            },
          });

          const degraded = yield* hooks.runBeforeTurnStart({
            threadId: "t1",
            modeId: "build",
            text: "Fix login",
          });
          expect(degraded.blocked).toBe(false);
          expect(degraded.results.some((r) => r.hookId === "slow-hook" && r.timedOut)).toBe(true);

          // 3. Blocking hook on turn.beforeStart
          yield* hooks.upsertUserHook({
            id: HarnessHookId.make("block-build"),
            event: "turn.beforeStart",
            matcher: TrimmedNonEmptyString.make("build"),
            target: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                'process.stdout.write(JSON.stringify({ block: true, reason: "Freeze window active" }))',
              ],
            },
          });

          const blocked = yield* hooks.runBeforeTurnStart({
            threadId: "t1",
            modeId: "build",
            text: "Deploy now",
          });
          expect(blocked.blocked).toBe(true);
          expect(blocked.blockReason).toBe("Freeze window active");

          // Non-matching modeId passes without being blocked
          const planAllowed = yield* hooks.runBeforeTurnStart({
            threadId: "t1",
            modeId: "plan",
            text: "Explore codebase",
          });
          expect(planAllowed.blocked).toBe(false);

          // 4. PreToolUse gateway gating with matcher
          yield* hooks.upsertUserHook({
            id: HarnessHookId.make("deny-deploy-tool"),
            event: "PreToolUse",
            matcher: TrimmedNonEmptyString.make("*deploy*"),
            target: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                'process.stdout.write(JSON.stringify({ allow: false, reason: "Deploy tools blocked" }))',
              ],
            },
          });

          const deniedTool = yield* hooks.runToolHook("PreToolUse", {
            threadId: "t1",
            toolName: "prod__deploy_release",
            arguments: {},
          });
          expect(deniedTool.blocked).toBe(true);
          expect(deniedTool.blockReason).toBe("Deploy tools blocked");

          const allowedTool = yield* hooks.runToolHook("PreToolUse", {
            threadId: "t1",
            toolName: "github__list_issues",
            arguments: {},
          });
          expect(allowedTool.blocked).toBe(false);

          // 5. Dry-run testHook works and removeUserHook cleans up
          const testResult = yield* hooks.testHook({ id: HarnessHookId.make("inject-note") });
          expect(testResult.ok).toBe(true);
          expect(testResult.injectedContext).toBe("[policy] Always check tests.");

          const afterRemove = yield* hooks.removeUserHook({
            id: HarnessHookId.make("block-build"),
          });
          expect(afterRemove.hooks.some((h) => h.id === "block-build")).toBe(false);
        }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
