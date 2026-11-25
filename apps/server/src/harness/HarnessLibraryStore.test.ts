import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  HarnessCommandId,
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
