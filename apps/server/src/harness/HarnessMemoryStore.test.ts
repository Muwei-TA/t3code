import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HarnessMemoryId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessMemoryStore from "./HarnessMemoryStore.ts";
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
  return HarnessMemoryStore.layer.pipe(Layer.provideMerge(storeLayer));
}

describe("HarnessMemoryStore", () => {
  it.effect("persists markdown memory entries with tags, pinning, search, and removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-memory-" });
      const baseDir = path.join(tempRoot, "t3home");
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

      yield* Effect.gen(function* () {
        const memory = yield* HarnessMemoryStore.HarnessMemoryStore;

        yield* memory.upsertMemory({
          id: HarnessMemoryId.make("deploy-checklist"),
          title: TrimmedNonEmptyString.make("Production Deploy Checklist"),
          tags: [TrimmedNonEmptyString.make("ops"), TrimmedNonEmptyString.make("release")],
          pinned: true,
          body: "Always run database migrations before swapping traffic.",
        });
        yield* memory.upsertMemory({
          id: HarnessMemoryId.make("postgres-tuning"),
          title: TrimmedNonEmptyString.make("Postgres Connection Pool Notes"),
          tags: [TrimmedNonEmptyString.make("db")],
          pinned: false,
          body: "Keep pool size <= 20 per worker.",
        });

        const snap = yield* memory.getSnapshot();
        expect(snap.entries.map((e) => e.id)).toEqual(["deploy-checklist", "postgres-tuning"]);
        expect(snap.entries[0]?.pinned).toBe(true);

        const byTag = yield* memory.searchMemory({ tag: "db" });
        expect(byTag.map((e) => e.id)).toEqual(["postgres-tuning"]);

        const byKeyword = yield* memory.searchMemory({ query: "migrations" });
        expect(byKeyword.map((e) => e.id)).toEqual(["deploy-checklist"]);

        const read = yield* memory.readMemory("postgres-tuning");
        expect(Option.isSome(read)).toBe(true);
        if (Option.isSome(read)) {
          expect(read.value.body).toContain("pool size <= 20");
        }

        const afterRemove = yield* memory.removeMemory({
          id: HarnessMemoryId.make("postgres-tuning"),
        });
        expect(afterRemove.entries.map((e) => e.id)).toEqual(["deploy-checklist"]);

        for (const [id, body] of [
          ["single-word", "cache"],
          ["separate-words", "cache has a configurable eviction policy"],
          ["exact-phrase", "Use cache eviction when capacity is reached"],
          ["cjk-two-bigrams", "请先部署，再检查署前日志"],
          ["cjk-one-bigram", "先部署服务"],
          ["cjk-exact", "部署前请确认权限"],
        ] as const) {
          yield* memory.upsertMemory({
            id: HarnessMemoryId.make(id),
            title: TrimmedNonEmptyString.make(id),
            body,
          });
        }
        expect(
          (yield* memory.searchMemory({ query: "cache eviction" })).map((entry) => entry.id),
        ).toEqual(["exact-phrase", "separate-words", "single-word"]);
        expect((yield* memory.searchMemory({ query: "部署前" })).map((entry) => entry.id)).toEqual([
          "cjk-exact",
          "cjk-two-bigrams",
          "cjk-one-bigram",
        ]);
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
