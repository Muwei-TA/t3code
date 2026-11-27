import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { checkBrandLeaks } from "./check-brand-leaks.ts";

it.effect("reports source, nested HTML, manifest and missing license independently", () =>
  Effect.gen(function* () {
    const fixture = FileSystem.makeNoop({
      exists: () => Effect.succeed(true),
      readDirectory: () =>
        Effect.succeed(["nested/index.html", "manifest.webmanifest", "assets/app.js"]),
      readFileString: (file) =>
        Effect.succeed(
          file.endsWith("LICENSE")
            ? "MIT License"
            : file.endsWith("index.html")
              ? "<title>T3 Code</title>"
              : file.endsWith(".webmanifest")
                ? '{"start_url":"https://app.t3.codes"}'
                : file.endsWith("DesktopEnvironment.ts")
                  ? 'const id = "com.t3tools.t3code"'
                  : 'import "@t3tools/shared/brand"; // t3.json',
        ),
    });
    const result = yield* checkBrandLeaks("/fixture").pipe(
      Effect.provideService(FileSystem.FileSystem, fixture),
      Effect.result,
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      for (const file of [
        "LICENSE",
        "DesktopEnvironment.ts",
        "nested/index.html",
        "manifest.webmanifest",
      ]) {
        assert.include(result.failure.message, file);
      }
      assert.notInclude(result.failure.message, "assets/app.js");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
