import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (cwd: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, "t3.json"), contents).pipe(Effect.orDie);
});

it.layer(layerTest)("T3ProjectFileLoader", (it) => {
  describe("load", () => {
    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("isolates invalid harness config without discarding other project settings", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          JSON.stringify({
            defaultThreadEnvMode: "worktree",
            worktreeSubmodules: "none",
            harness: {
              mcpServers: {
                bad: {
                  enabled: true,
                  transport: {
                    type: "http",
                    url: "https://alice:secret-pass@bad.example.com:99999/mcp?token=secret-query-999",
                  },
                },
              },
            },
          }),
        );

        const loaded = yield* loader.load(cwd);
        expect(Option.isSome(loaded)).toBe(true);
        expect(Option.getOrUndefined(loaded)).toEqual({
          defaultThreadEnvMode: "worktree",
          worktreeSubmodules: "none",
        });
      }),
    );

    it.effect("never logs raw rejected credential URLs on schema validation failure", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          JSON.stringify({
            worktreeSubmodules:
              "https://alice:secret-pass@bad.example.com:99999/mcp?token=secret-query-999",
          }),
        );

        const logged: Array<string> = [];
        const captureLogger = Logger.make((entry) => {
          logged.push(JSON.stringify({ message: entry.message, cause: String(entry.cause) }));
        });
        const loaded = yield* loader
          .load(cwd)
          .pipe(Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: false })));

        expect(Option.isNone(loaded)).toBe(true);
        expect(logged.length).toBeGreaterThan(0);
        const combined = logged.join("\n");
        expect(combined).not.toContain("secret-pass");
        expect(combined).not.toContain("secret-query-999");
      }),
    );
  });
});
