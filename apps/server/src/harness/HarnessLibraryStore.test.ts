import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  HarnessCommandId,
  HarnessModeId,
  HarnessRuleId,
  HarnessSkillId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import * as HarnessStore from "./HarnessStore.ts";

const makeTestLayer = (
  baseDir: string,
  paths: ServerConfig.ServerDerivedPaths,
  policyOverrides?: { readonly harness?: boolean },
) => {
  const configLayer = Layer.succeed(ServerConfig.ServerConfig, {
    ...paths,
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: baseDir,
    baseDir,
  } as unknown as ServerConfig.ServerConfig["Service"]);

  const policyLayer = Layer.succeed(ManagedPolicy.ManagedPolicy, {
    document:
      policyOverrides === undefined
        ? undefined
        : { version: 1, organization: "Acme Corp", limits: policyOverrides },
    source: undefined,
    error: undefined,
  } as unknown as ManagedPolicy.ManagedPolicy["Service"]);

  const storeLayer = HarnessStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(policyLayer),
    Layer.provideMerge(T3ProjectFileLoader.layer),
    Layer.provideMerge(NodeServices.layer),
  );

  return HarnessLibraryStore.layer.pipe(Layer.provideMerge(storeLayer));
};

describe("HarnessLibraryStore", () => {
  it("rejects reserved built-in command IDs in schema decoding", () => {
    const decodeCmd = Schema.decodeUnknownOption(HarnessCommandId);
    for (const reserved of ["plan", "model", "compact", "clear", "logout", "default", "skill"]) {
      expect(Option.isNone(decodeCmd(reserved))).toBe(true);
    }
    expect(Option.isSome(decodeCmd("review-pr"))).toBe(true);
  });

  it.effect(
    "manages CRUD for AGENTS.md, skills, rules, and commands, merges project .agents/skills with t3.json overrides, and stages Claude plugin-dir safely",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-lib-" });
        const baseDir = path.join(tempRoot, "t3home");
        const repoRoot = path.join(tempRoot, "repo");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        yield* fs.makeDirectory(path.join(repoRoot, ".agents", "skills", "shared-skill"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(repoRoot, "AGENTS.md"),
          "# Repo guidelines\nFollow Effect service patterns.\n",
        );
        yield* fs.writeFileString(
          path.join(repoRoot, ".agents", "skills", "shared-skill", "SKILL.md"),
          "---\nname: shared-skill\ndescription: Project version\n---\nUse repo checklist.\n",
        );
        yield* fs.writeFileString(
          path.join(repoRoot, "t3.json"),
          JSON.stringify({
            harness: {
              disabledRules: ["muted-rule"],
              disabledCommands: ["muted-cmd"],
            },
          }),
        );

        yield* Effect.gen(function* () {
          const lib = yield* HarnessLibraryStore.HarnessLibraryStore;

          // 1. Personal AGENTS.md CRUD
          const savedAgents = yield* lib.saveUserAgentsMd({
            body: "# Personal Rules\nPrefer concise diffs.\n",
            workspaceRoot: repoRoot,
          });
          expect(savedAgents.userAgentsMd.exists).toBe(true);
          expect(savedAgents.userAgentsMd.body).toContain("Prefer concise diffs.");
          expect(savedAgents.projectAgentsMd?.exists).toBe(true);
          expect(savedAgents.projectAgentsMd?.body).toContain("Follow Effect service patterns.");

          // 2. Skills CRUD + project .agents/skills override precedence + companion files
          yield* lib.upsertUserSkill({
            id: HarnessSkillId.make("shared-skill"),
            description: "User version",
            body: "User instructions",
            workspaceRoot: repoRoot,
          });
          yield* lib.upsertUserSkill({
            id: HarnessSkillId.make("audit-sql"),
            name: TrimmedNonEmptyString.make("Audit SQL"),
            description: "Inspect SQL migrations",
            body: "Always check index selectivity.",
            workspaceRoot: repoRoot,
          });
          // Add companion file inside audit-sql skill dir
          const auditSkillDir = path.join(baseDir, "harness", "skills", "audit-sql");
          yield* fs.writeFileString(
            path.join(auditSkillDir, "checklist.md"),
            "- Verify rollback\n",
          );

          const detailOpt = yield* lib.getSkillDetail({
            nameOrId: "audit-sql",
            workspaceRoot: repoRoot,
          });
          expect(Option.isSome(detailOpt)).toBe(true);
          if (Option.isSome(detailOpt)) {
            expect(detailOpt.value.skill.id).toBe("audit-sql");
            expect(detailOpt.value.companionFiles).toContain("checklist.md");
          }

          const snap = yield* lib.getSnapshot(repoRoot);
          // Project .agents/skills/shared-skill overrides user skill of same ID
          const userShared = snap.skills.find((s) => s.id === "shared-skill" && s.scope === "user");
          const projShared = snap.skills.find(
            (s) => s.id === "shared-skill" && s.scope === "project",
          );
          expect(projShared?.effectiveEnabled).toBe(true);
          expect(userShared?.overriddenByProject).toBe(true);
          expect(userShared?.effectiveEnabled).toBe(false);

          // 3. Stage Claude plugin-dir containing enabled skills + .claude-plugin/plugin.json
          const mountDir = yield* lib.materializeClaudePluginDir({
            skills: snap.skills.filter((s) => s.effectiveEnabled),
          });
          expect(mountDir).not.toBeNull();
          expect(yield* fs.exists(path.join(mountDir!, ".claude-plugin", "plugin.json"))).toBe(
            true,
          );
          expect(yield* fs.exists(path.join(mountDir!, "skills", "audit-sql", "SKILL.md"))).toBe(
            true,
          );
          expect(
            yield* fs.exists(path.join(mountDir!, "skills", "audit-sql", "checklist.md")),
          ).toBe(true);

          // 4. Rules CRUD + t3.json disabledRules
          yield* lib.upsertUserRule({
            id: HarnessRuleId.make("ts-strict"),
            description: "Strict TS",
            apply: "glob",
            globs: [TrimmedNonEmptyString.make("**/*.ts")],
            body: "No any.",
            workspaceRoot: repoRoot,
          });
          yield* lib.upsertUserRule({
            id: HarnessRuleId.make("muted-rule"),
            apply: "always",
            body: "Should be disabled by project t3.json",
            workspaceRoot: repoRoot,
          });

          const ruleDetailOpt = yield* lib.getRuleDetail({
            id: "ts-strict",
            workspaceRoot: repoRoot,
          });
          expect(Option.isSome(ruleDetailOpt)).toBe(true);
          if (Option.isSome(ruleDetailOpt)) {
            expect(ruleDetailOpt.value.body).toContain("No any.");
          }

          // 5. Commands CRUD + t3.json disabledCommands + disable/remove roundtrip
          yield* lib.upsertUserCommand({
            id: HarnessCommandId.make("review-pr"),
            description: "Review pull request",
            argumentHint: "<branch>",
            body: "Review diff against $1 focusing on $ARGUMENTS",
            workspaceRoot: repoRoot,
          });
          const afterCmds = yield* lib.upsertUserCommand({
            id: HarnessCommandId.make("muted-cmd"),
            body: "Muted in repo",
            workspaceRoot: repoRoot,
          });
          expect(afterCmds.rules.find((r) => r.id === "muted-rule")?.effectiveEnabled).toBe(false);
          expect(afterCmds.rules.find((r) => r.id === "muted-rule")?.overriddenByProject).toBe(
            true,
          );
          expect(afterCmds.commands.find((c) => c.id === "muted-cmd")?.effectiveEnabled).toBe(
            false,
          );

          const afterToggle = yield* lib.setCommandEnabled({
            id: HarnessCommandId.make("review-pr"),
            enabled: false,
            workspaceRoot: repoRoot,
          });
          expect(afterToggle.commands.find((c) => c.id === "review-pr")?.effectiveEnabled).toBe(
            false,
          );

          const afterRemove = yield* lib.removeUserCommand({
            id: HarnessCommandId.make("review-pr"),
            workspaceRoot: repoRoot,
          });
          expect(afterRemove.commands.some((c) => c.id === "review-pr")).toBe(false);
        }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("manages built-in and custom declarative modes with overrides and resolution", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-modes-" });
      const baseDir = path.join(tempRoot, "t3home");
      const repoRoot = path.join(tempRoot, "repo");
      yield* fs.makeDirectory(repoRoot, { recursive: true });
      yield* fs.writeFileString(
        path.join(repoRoot, "t3.json"),
        JSON.stringify({
          harness: {
            disabledModes: ["creator"],
          },
        }),
      );
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

      yield* Effect.gen(function* () {
        const lib = yield* HarnessLibraryStore.HarnessLibraryStore;
        const [initial, concurrent] = yield* Effect.all(
          [lib.getSnapshot(repoRoot), lib.getSnapshot(repoRoot)],
          { concurrency: 2 },
        );
        expect(concurrent).toBe(initial);
        const ids = initial.modes.map((m) => m.id);
        expect(ids).toContain("build");
        expect(ids).toContain("plan");
        expect(ids).toContain("review");
        expect(ids).toContain("creator");
        expect(initial.modes.find((m) => m.id === "creator")?.effectiveEnabled).toBe(false);
        expect(initial.modes.find((m) => m.id === "creator")?.overriddenByProject).toBe(true);

        // Create a custom declarative mode
        const afterCreate = yield* lib.upsertUserMode({
          id: HarnessModeId.make("security-audit"),
          name: TrimmedNonEmptyString.make("Security Audit"),
          description: "Read-only threat review",
          baseInteractionMode: "default",
          readonly: true,
          proposePlan: false,
          includedRules: [HarnessRuleId.make("sec-baseline")],
          body: "Inspect auth boundaries and never modify files.",
          workspaceRoot: repoRoot,
        });
        const customMode = afterCreate.modes.find((m) => m.id === "security-audit");
        expect(afterCreate).not.toBe(initial);
        expect(yield* lib.getSnapshot(repoRoot)).toBe(afterCreate);
        expect(customMode).toBeDefined();
        expect(customMode?.scope).toBe("user");
        expect(customMode?.readonly).toBe(true);
        expect(customMode?.includedRules).toEqual(["sec-baseline"]);

        // Resolve custom mode with stable digest
        const resolved = yield* lib.resolveMode({
          modeId: HarnessModeId.make("security-audit"),
          interactionMode: "default",
          workspaceRoot: repoRoot,
        });
        expect(resolved?.id).toBe("security-audit");
        expect(resolved?.contentDigest).toBe(customMode?.contentDigest);

        // Override built-in review mode, then remove override to restore built-in
        const afterOverride = yield* lib.upsertUserMode({
          id: HarnessModeId.make("review"),
          overrideBuiltin: true,
          name: TrimmedNonEmptyString.make("Strict Review"),
          baseInteractionMode: "default",
          readonly: true,
          body: "Custom review checklist.",
          workspaceRoot: repoRoot,
        });
        const overriddenReview = afterOverride.modes.find((m) => m.id === "review");
        expect(overriddenReview?.scope).toBe("user");
        expect(overriddenReview?.overriddenBuiltin).toBe(true);

        const afterDisable = yield* lib.setModeEnabled({
          id: HarnessModeId.make("security-audit"),
          enabled: false,
          workspaceRoot: repoRoot,
        });
        expect(afterDisable.modes.find((m) => m.id === "security-audit")?.effectiveEnabled).toBe(
          false,
        );

        const afterRemove = yield* lib.removeUserMode({
          id: HarnessModeId.make("review"),
          workspaceRoot: repoRoot,
        });
        expect(afterRemove.modes.find((m) => m.id === "review")?.scope).toBe("builtin");
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes a skill symlink without deleting the skill it points to", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-removal-" });
      const paths = yield* ServerConfig.deriveServerPaths(root, undefined);
      yield* Effect.gen(function* () {
        const lib = yield* HarnessLibraryStore.HarnessLibraryStore;
        const original = yield* lib.upsertUserSkill({
          id: HarnessSkillId.make("example"),
          body: "Original instructions",
        });
        const target = path.join(original.harnessDir, "skills", "example");
        const link = path.join(original.harnessDir, "skills", "alias");
        yield* fs.symlink(target, link);
        const after = yield* lib.removeUserSkill({ id: HarnessSkillId.make("alias") });
        expect(yield* fs.exists(link)).toBe(false);
        expect(yield* fs.readFileString(path.join(target, "SKILL.md"))).toContain(
          "Original instructions",
        );
        expect(after.skills.map((skill) => skill.id)).toEqual(["example"]);
      }).pipe(Effect.provide(makeTestLayer(root, paths)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "removes rule, command, mode, and AGENTS.md symlinks without deleting their target",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-removal-" });
        const paths = yield* ServerConfig.deriveServerPaths(root, undefined);
        yield* Effect.gen(function* () {
          const lib = yield* HarnessLibraryStore.HarnessLibraryStore;
          const { harnessDir } = yield* lib.getSnapshot();
          const target = path.join(harnessDir, "original.md");
          yield* fs.makeDirectory(harnessDir, { recursive: true });
          yield* fs.writeFileString(target, "Original instructions\n");
          for (const [relativeLink, remove] of [
            ["rules/alias.md", lib.removeUserRule({ id: HarnessRuleId.make("alias") })],
            ["commands/alias.md", lib.removeUserCommand({ id: HarnessCommandId.make("alias") })],
            ["modes/alias.md", lib.removeUserMode({ id: HarnessModeId.make("alias") })],
            ["AGENTS.md", lib.saveUserAgentsMd({ body: "" })],
          ] as const) {
            const link = path.join(harnessDir, relativeLink);
            yield* fs.makeDirectory(path.dirname(link), { recursive: true });
            yield* fs.symlink(target, link);
            yield* remove;
            expect(yield* fs.readFileString(target)).toBe("Original instructions\n");
            expect(yield* fs.exists(link)).toBe(false);
          }
        }).pipe(Effect.provide(makeTestLayer(root, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("blocks writes when ManagedPolicy disables harness", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-lib-pol-" });
      const baseDir = path.join(tempRoot, "t3home");
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

      yield* Effect.gen(function* () {
        const lib = yield* HarnessLibraryStore.HarnessLibraryStore;
        const err = yield* lib.saveUserAgentsMd({ body: "Blocked by policy" }).pipe(Effect.flip);
        expect(err.code).toBe("policy_denied");
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths, { harness: false })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
