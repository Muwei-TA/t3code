import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  HarnessCommandId,
  HarnessModeId,
  HarnessRuleId,
  HarnessSkillId,
  type ManagedPolicyLimits,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  policyOverrides?: ManagedPolicyLimits,
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
        : { schemaVersion: 1, organization: "Acme Corp", limits: policyOverrides },
    path: "/policy.json",
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
  it.effect(
    "replaces complete packages in either scope and keeps the previous version on validation failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const baseDir = path.join(root, "t3"),
          workspaceRoot = path.join(root, "repo");
        yield* fs.makeDirectory(workspaceRoot);
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
        yield* Effect.gen(function* () {
          const lib = yield* HarnessLibraryStore.HarnessLibraryStore;
          const location = {
            id: HarnessSkillId.make("package"),
            scope: "project" as const,
            workspaceRoot,
          };
          const manifest = {
            relativePath: "SKILL.md",
            content: "---\nname: Package\ndescription: Example\n---\nBody",
          };
          const files = [
            manifest,
            { relativePath: "assets/image.dat", encoding: "base64" as const, content: "AP8=" },
            { relativePath: "scripts/check", content: "echo ready", executable: true },
          ];
          const initial = yield* lib.installSkillPackage({ ...location, files });
          expect(initial.skills[0]?.files).toContainEqual({
            relativePath: "scripts/check",
            kind: "script",
            executable: true,
            sizeBytes: 10,
          });
          expect(
            yield* lib.readSkillFile({ ...location, relativePath: "assets/image.dat" }),
          ).toMatchObject({ binary: true, sizeBytes: 2 });
          const dir = path.join(workspaceRoot, ".agents", "skills", "package");
          const copy = yield* lib.installSkillPackage({
            ...location,
            scope: "user",
            sourceDir: dir,
          });
          expect(copy.skills.filter((s) => s.id === "package")).toHaveLength(2);
          for (const bad of [
            [manifest, { relativePath: "../escape", content: "bad" }],
            [{ relativePath: "SKILL.md", content: "missing frontmatter" }],
            [manifest, manifest],
          ]) {
            expect(
              (yield* lib.installSkillPackage({ ...location, files: bad }).pipe(Effect.flip)).code,
            ).toBe("invalid_config");
          }
          expect(
            (yield* lib.readSkillFile({ ...location, relativePath: "scripts/check" })).content,
          ).toBe("echo ready");
          yield* fs.symlink(path.join(dir, "SKILL.md"), path.join(dir, "linked"));
          expect(
            (yield* lib.readSkillFile({ ...location, relativePath: "linked" }).pipe(Effect.flip))
              .code,
          ).toBe("invalid_config");
          expect(
            (yield* lib
              .readSkillFile({ ...location, relativePath: "../SKILL.md" })
              .pipe(Effect.flip)).code,
          ).toBe("invalid_config");
          const replaced = yield* lib.installSkillPackage({
            ...location,
            files: [
              manifest,
              ...Array.from({ length: 68 }, (_, i) => ({
                relativePath: "refs/" + i,
                content: "ok",
              })),
            ],
          });
          expect(replaced.skills.find((s) => s.scope === "project")?.companionTruncated).toBe(true);
          expect(yield* fs.exists(path.join(dir, "scripts/check"))).toBe(false);
          expect((yield* lib.readSkillFile({ ...location, relativePath: "refs/67" })).content).toBe(
            "ok",
          );
        }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("locks organization rules against local edits and project overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-locked-rule-" }),
      );
      const baseDir = path.join(tempRoot, "home");
      const workspaceRoot = path.join(tempRoot, "workspace");
      const rulesDir = path.join(baseDir, "harness", "rules");
      yield* fs.makeDirectory(rulesDir, { recursive: true });
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      yield* fs.writeFileString(path.join(rulesDir, "org-guide.md"), "Local text\n");
      yield* fs.writeFileString(
        path.join(workspaceRoot, "t3.json"),
        '{"harness":{"disabledRules":["org-guide"]}}',
      );
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const id = HarnessRuleId.make("org-guide");
      const body = TrimmedNonEmptyString.make("Organization text");
      yield* Effect.gen(function* () {
        const library = yield* HarnessLibraryStore.HarnessLibraryStore;
        const { rules } = yield* library.getSnapshot(workspaceRoot);
        expect(rules).toEqual([
          expect.objectContaining({
            id,
            body,
            lockedByPolicy: true,
            effectiveEnabled: true,
            overriddenByProject: false,
          }),
        ]);
        const upper = HarnessRuleId.make("ORG-GUIDE");
        for (const mutation of [
          library.setRuleEnabled({ id, enabled: false }),
          library.removeUserRule({ id: upper }),
          library.upsertUserRule({ id, apply: "always", body: "Replace the organization rule" }),
        ]) {
          expect((yield* mutation.pipe(Effect.flip)).code).toBe("policy_denied");
        }
      }).pipe(
        Effect.provide(
          makeTestLayer(baseDir, paths, { harnessLockedRules: [{ id, apply: "always", body }] }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
          const skills = snap.skills.filter((skill) => skill.effectiveEnabled);
          const codexRoot = yield* lib.materializeCodexSkillRoot({ skills });
          expect(codexRoot).toBeDefined();
          expect(yield* fs.exists(path.join(codexRoot!, "audit-sql", "SKILL.md"))).toBe(true);
          expect(yield* fs.exists(path.join(codexRoot!, "audit-sql", "checklist.md"))).toBe(true);
          expect(yield* lib.materializeCodexSkillRoot({ skills })).toBe(codexRoot);

          const checklist = path.join(auditSkillDir, "checklist.md");
          yield* fs.writeFileString(checklist, "- Verify backups\n");
          const changedCodexRoot = yield* lib.materializeCodexSkillRoot({ skills });
          const changedMountDir = yield* lib.materializeClaudePluginDir({ skills });
          expect(changedCodexRoot).not.toBe(codexRoot);
          expect(changedMountDir).not.toBe(mountDir);
          expect(
            yield* fs.readFileString(path.join(changedCodexRoot!, "audit-sql", "checklist.md")),
          ).toBe("- Verify backups\n");

          if ((yield* HostProcess.Platform) !== "win32") {
            yield* fs.chmod(checklist, 0o700);
            const executableRoot = yield* lib.materializeCodexSkillRoot({ skills });
            expect(executableRoot).not.toBe(changedCodexRoot);
            const info = yield* fs.stat(path.join(executableRoot!, "audit-sql", "checklist.md"));
            expect(info.mode & 0o111).toBe(0o100);
          }

          yield* fs.remove(checklist);
          const removedCodexRoot = yield* lib.materializeCodexSkillRoot({ skills });
          expect(yield* fs.exists(path.join(removedCodexRoot!, "audit-sql", "checklist.md"))).toBe(
            false,
          );

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
