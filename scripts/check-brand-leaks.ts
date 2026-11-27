#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";

const brandEntries = [
  "apps/server/src/binCli.ts",
  "apps/server/src/config.ts",
  "apps/server/src/os-jank.ts",
  "apps/server/src/provider/ModelManifest.ts",
  "apps/server/src/telemetry/AnalyticsService.ts",
  "apps/server/src/cli/config.ts",
  "apps/server/src/cli/install.ts",
  "apps/server/src/cloud/publicConfig.ts",
  "apps/server/src/triage/triagePrompt.ts",
  "apps/desktop/package.json",
  "apps/desktop/src/app/DesktopEnvironment.ts",
  "apps/desktop/src/app/DesktopConfig.ts",
  "apps/desktop/src/app/DesktopAppIdentity.ts",
  "apps/desktop/src/app/DesktopStatePaths.ts",
  "apps/desktop/src/app/DesktopEarlyElectronStartup.ts",
  "apps/desktop/src/app/DesktopUserData.ts",
  "apps/desktop/scripts/electron-launcher.mjs",
  "apps/desktop/resources/linux/com.lightningcode.desktop.metainfo.xml",
  "scripts/build-desktop-artifact.ts",
  "scripts/dev-runner.ts",
];

class BrandCheckError extends Schema.TaggedError<BrandCheckError>()("BrandCheckError", {
  message: Schema.String,
}) {}

export const checkBrandLeaks = Effect.fn("checkBrandLeaks")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const problems: string[] = [];
  const license = yield* fs.readFileString(path.join(root, "LICENSE"));
  if (!license.split(/\r?\n/).includes("Copyright (c) 2026 T3 Tools Inc.")) {
    problems.push("LICENSE is missing the upstream copyright notice.");
  }
  const files = [...brandEntries];
  const dist = path.join("apps", "web", "dist");
  if (yield* fs.exists(path.join(root, dist))) {
    for (const entry of yield* fs.readDirectory(path.join(root, dist), { recursive: true })) {
      if (/\.html?$|\.webmanifest$|(?:^|[/\\])[^/\\]*manifest[^/\\]*\.json$/i.test(entry)) {
        files.push(path.join(dist, entry));
      }
    }
  }
  for (const file of files) {
    const source = yield* fs.readFileString(path.join(root, file));
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const leak = /\bT3 Code\b|\bapp\.t3\.codes\b|\bcom\.t3tools\.t3code\b/i.exec(line);
      if (leak) problems.push(`${file}:${index + 1} contains "${leak[0]}"`);
    }
  }
  if (problems.length) return yield* new BrandCheckError({ message: problems.join("\n") });
  return files.length;
});

if (import.meta.main) {
  const command = Command.make("check-brand-leaks", {}, () =>
    checkBrandLeaks(`${import.meta.dirname}/..`).pipe(
      Effect.flatMap((count) =>
        Console.log(`Checked ${count} brand surfaces and the upstream license.`),
      ),
    ),
  );
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
