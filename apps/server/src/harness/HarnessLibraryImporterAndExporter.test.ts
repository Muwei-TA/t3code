import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  HarnessCommandId,
  HarnessMcpServerId,
  HarnessRuleId,
  HarnessSkillId,
  TrimmedNonEmptyString,
  type ManagedPolicyDocument,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { parse as parseToml } from "smol-toml";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessExporter from "./HarnessExporter.ts";
import * as HarnessLibraryImporter from "./HarnessLibraryImporter.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import * as HarnessStore from "./HarnessStore.ts";

const makeTestLayer = (
  baseDir: string,
  homeDir: string,
  paths: ServerConfig.ServerDerivedPaths,
  policy?: ManagedPolicyDocument,
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
    document: policy,
    source: undefined,
    error: undefined,
  } as unknown as ManagedPolicy.ManagedPolicy["Service"]);

  const homeLayer = Layer.succeed(HostProcess.HomeDirectory, homeDir);

  const storeLayer = HarnessStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(policyLayer),
    Layer.provideMerge(T3ProjectFileLoader.layer),
    Layer.provideMerge(NodeServices.layer),
  );

  const libLayer = HarnessLibraryStore.layer.pipe(Layer.provideMerge(storeLayer));

  return Layer.mergeAll(
    libLayer,
    HarnessLibraryImporter.layer.pipe(Layer.provide(libLayer), Layer.provide(homeLayer)),
    HarnessExporter.layer.pipe(Layer.provide(libLayer), Layer.provide(homeLayer)),
  );
};

describe("HarnessLibraryImporter & HarnessExporter", () => {
  it("converts Cursor .mdc rule frontmatter cleanly to portable always/glob/manual modes", () => {
    const alwaysRule = HarnessLibraryImporter.convertCursorRuleToPortable({
      rawId: "style",
      rawText: "---\ndescription: Style guide\nalwaysApply: true\n---\nUse strict types.\n",
    });
    expect(alwaysRule.apply).toBe("always");
    expect(alwaysRule.description).toBe("Style guide");
    expect(alwaysRule.body.trim()).toBe("Use strict types.");

    const globRule = HarnessLibraryImporter.convertCursorRuleToPortable({
      rawId: "react",
      rawText: '---\nglobs: "**/*.tsx, **/*.jsx"\n---\nUse hooks cleanly.\n',
    });
    expect(globRule.apply).toBe("glob");
    expect(globRule.globs).toEqual(["**/*.tsx", "**/*.jsx"]);

    const manualRule = HarnessLibraryImporter.convertCursorRuleToPortable({
      rawId: "manual",
      rawText: "---\ndescription: Release checklist\n---\nCheck changelog.\n",
    });
    expect(manualRule.apply).toBe("manual");
  });

  it.effect(
    "scans Codex/Claude/Cursor/Antigravity read-only, rejects stale digests on apply, and imports cleanly without modifying source files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-imp-" });
        const baseDir = path.join(tempRoot, "t3home");
        const homeDir = path.join(tempRoot, "fakehome");
        const repoRoot = path.join(tempRoot, "repo");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        // Seed external CLI files in fakehome & repoRoot
        const codexSkillPath = path.join(homeDir, ".codex", "skills", "codex-helper", "SKILL.md");
        const claudeCmdPath = path.join(homeDir, ".claude", "commands", "deploy-check.md");
        const claudeReservedCmdPath = path.join(homeDir, ".claude", "commands", "plan.md");
        const cursorRulePath = path.join(repoRoot, ".cursor", "rules", "react-ui.mdc");
        const agySkillPath = path.join(
          homeDir,
          ".gemini",
          "antigravity",
          "skills",
          "agy-perf",
          "SKILL.md",
        );

        yield* fs.makeDirectory(path.dirname(codexSkillPath), { recursive: true });
        yield* fs.makeDirectory(path.dirname(claudeCmdPath), { recursive: true });
        yield* fs.makeDirectory(path.dirname(cursorRulePath), { recursive: true });
        yield* fs.makeDirectory(path.dirname(agySkillPath), { recursive: true });

        const codexSkillOriginal =
          "---\nname: codex-helper\ndescription: From Codex\n---\nCodex steps.\n";
        yield* fs.writeFileString(codexSkillPath, codexSkillOriginal);
        const script = path.join(path.dirname(codexSkillPath), "scripts", "check");
        yield* fs.makeDirectory(path.dirname(script));
        yield* fs.writeFileString(script, "echo ok");
        yield* fs.chmod(script, 0o755);
        yield* fs.writeFileString(
          claudeCmdPath,
          "---\ndescription: Verify deployment\nargument-hint: <env>\n---\nCheck deploy for $1.\n",
        );
        yield* fs.writeFileString(claudeReservedCmdPath, "Reserved built-in should be skipped");
        yield* fs.writeFileString(
          cursorRulePath,
          '---\ndescription: React UI\nglobs: "**/*.tsx"\n---\nPrefer accessible primitives.\n',
        );
        yield* fs.writeFileString(
          agySkillPath,
          "---\nname: agy-perf\ndescription: Perf audit\n---\nProfile render loops.\n",
        );

        yield* Effect.gen(function* () {
          const importer = yield* HarnessLibraryImporter.HarnessLibraryImporter;

          const scanned = yield* importer.scan(repoRoot);
          const codex = scanned.find((s) => s.source === "codex");
          const claude = scanned.find((s) => s.source === "claude");
          const cursor = scanned.find((s) => s.source === "cursor");
          const antigravity = scanned.find((s) => s.source === "antigravity");

          expect(codex?.candidates.some((c) => c.kind === "skill" && c.id === "codex-helper")).toBe(
            true,
          );
          expect(
            claude?.candidates.some((c) => c.kind === "command" && c.id === "deploy-check"),
          ).toBe(true);
          // Reserved command `/plan` must not be importable
          expect(claude?.candidates.some((c) => c.id === "plan")).toBe(false);
          expect(cursor?.candidates.some((c) => c.kind === "rule" && c.id === "react-ui")).toBe(
            true,
          );
          expect(
            antigravity?.candidates.some((c) => c.kind === "skill" && c.id === "agy-perf"),
          ).toBe(true);

          // Stale/tampered previewDigest MUST fail (TOCTOU guard)
          const staleErr = yield* importer
            .apply({
              items: [
                {
                  source: "codex",
                  kind: "skill",
                  id: TrimmedNonEmptyString.make("codex-helper"),
                  expectedDigest: TrimmedNonEmptyString.make("deadbeef"),
                },
              ],
              workspaceRoot: repoRoot,
            })
            .pipe(Effect.flip);
          expect(staleErr.code).toBe("invalid_config");

          // Valid apply imports all selected items cleanly
          const codexCand = codex!.candidates.find((c) => c.id === "codex-helper")!;
          const claudeCand = claude!.candidates.find((c) => c.id === "deploy-check")!;
          const cursorCand = cursor!.candidates.find((c) => c.id === "react-ui")!;
          const agyCand = antigravity!.candidates.find((c) => c.id === "agy-perf")!;

          const applied = yield* importer.apply({
            items: [
              {
                source: "codex",
                kind: "skill",
                id: codexCand.id,
                expectedDigest: TrimmedNonEmptyString.make(codexCand.previewDigest),
              },
              {
                source: "claude",
                kind: "command",
                id: claudeCand.id,
                expectedDigest: TrimmedNonEmptyString.make(claudeCand.previewDigest),
              },
              {
                source: "cursor",
                kind: "rule",
                id: cursorCand.id,
                expectedDigest: TrimmedNonEmptyString.make(cursorCand.previewDigest),
              },
              {
                source: "antigravity",
                kind: "skill",
                id: agyCand.id,
                expectedDigest: TrimmedNonEmptyString.make(agyCand.previewDigest),
              },
            ],
            workspaceRoot: repoRoot,
          });
          const scriptCopy = path.join(
            paths.harnessDir,
            "skills",
            "codex-helper",
            "scripts",
            "check",
          );
          expect(yield* fs.readFileString(scriptCopy)).toBe("echo ok");
          expect((yield* fs.stat(scriptCopy)).mode & 0o111).toBe(0o111);

          const rescanned = (yield* importer.scan(repoRoot))
            .find((src) => src.source === "codex")!
            .candidates.find((candidate) => candidate.id === codexCand.id)!;
          expect(rescanned.conflict).toBe("exists_identical");
          const overwrite = importer.apply({
            overwriteExisting: true,
            workspaceRoot: repoRoot,
            items: [
              {
                source: "codex",
                kind: "skill",
                id: codexCand.id,
                expectedExistingDigest: TrimmedNonEmptyString.make(rescanned.existingDigest!),
              },
            ],
          });
          yield* fs.writeFileString(scriptCopy, "local changes");
          expect((yield* overwrite.pipe(Effect.flip)).detail).toContain("changed since preview");
          expect(yield* fs.readFileString(scriptCopy)).toBe("local changes");
          yield* fs.writeFileString(scriptCopy, "echo ok");
          expect((yield* overwrite).importedKeys).toHaveLength(1);
          expect(applied.importedKeys).toHaveLength(4);
          expect(applied.snapshot.skills.some((s) => s.id === "codex-helper")).toBe(true);
          expect(applied.snapshot.skills.some((s) => s.id === "agy-perf")).toBe(true);
          expect(applied.snapshot.commands.some((c) => c.id === "deploy-check")).toBe(true);
          const importedRule = applied.snapshot.rules.find((r) => r.id === "react-ui");
          expect(importedRule?.apply).toBe("glob");
          expect(importedRule?.globs).toEqual(["**/*.tsx"]);

          // Source CLI file remained completely untouched
          expect(yield* fs.readFileString(codexSkillPath)).toBe(codexSkillOriginal);
        }).pipe(Effect.provide(makeTestLayer(baseDir, homeDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reverse-exports portable harness to Codex, Claude, and Cursor non-destructively while redacting secrets in preview and rejecting planDigest drift",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-exp-" });
        const baseDir = path.join(tempRoot, "t3home");
        const homeDir = path.join(tempRoot, "fakehome");
        const repoRoot = path.join(tempRoot, "repo");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
        const organizationRule = {
          id: HarnessRuleId.make("locked-guide"),
          apply: "always" as const,
          body: TrimmedNonEmptyString.make("Keep this instruction managed by T3 Code."),
        };

        // Pre-populate unrelated keys in Codex config.toml and Claude ~/.claude.json
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        const claudeJsonPath = path.join(homeDir, ".claude.json");
        const codexRulesPath = path.join(homeDir, ".codex", "AGENTS.md");
        const claudeRulesPath = path.join(homeDir, ".claude", "CLAUDE.md");
        const handWritten = "# My notes\n\nKeep these instructions.\n";
        yield* fs.makeDirectory(path.dirname(codexConfigPath), { recursive: true });
        yield* fs.makeDirectory(path.dirname(claudeRulesPath), { recursive: true });
        yield* fs.makeDirectory(repoRoot, { recursive: true });
        yield* fs.writeFileString(codexRulesPath, handWritten);
        yield* fs.writeFileString(claudeRulesPath, handWritten);
        yield* fs.writeFileString(
          codexConfigPath,
          'model = "gpt-5.4"\napproval_policy = "on-request"\n',
        );
        yield* fs.writeFileString(
          claudeJsonPath,
          JSON.stringify({ numStartups: 42, mcpServers: { existing_one: { command: "echo" } } }),
        );

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const lib = yield* HarnessLibraryStore.HarnessLibraryStore;
          const exporter = yield* HarnessExporter.HarnessExporter;

          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("docs"),
            config: {
              enabled: true,
              transport: {
                type: "http",
                url: "https://mcp.example.com/docs",
                headers: { Authorization: "Bearer super-secret-xyz" },
              },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });
          yield* lib.saveUserAgentsMd({ body: "Prefer small pure functions." });
          yield* lib.upsertUserSkill({
            id: HarnessSkillId.make("ship-check"),
            description: "Release check",
            body: "Run tests before shipping.",
          });
          yield* lib.upsertUserRule({
            id: HarnessRuleId.make("no-any"),
            description: "Disallow any",
            apply: "glob",
            globs: [TrimmedNonEmptyString.make("**/*.ts")],
            body: "Never use any.",
          });
          yield* lib.upsertUserCommand({
            id: HarnessCommandId.make("lint-fix"),
            description: "Lint changed files",
            body: "Fix lint in $ARGUMENTS",
          });

          const asset = path.join(paths.harnessDir, "skills", "ship-check", "asset.bin");
          yield* fs.writeFile(asset, Uint8Array.from([0, 255, 128]));
          yield* fs.chmod(asset, 0o755);
          // 1. Codex preview redacts literal header secret + rejects drifted planDigest
          yield* fs.writeFileString(
            path.join(path.dirname(asset), "notes.txt"),
            "private attachment body",
          );
          const codexPreview = yield* exporter.preview({ target: "codex" });
          const codexTomlFile = codexPreview.files.find((f) => f.targetPath === codexConfigPath);
          const attachment = codexPreview.files.find((file) => file.relativePath === "notes.txt");
          expect(attachment).toMatchObject({ bytes: 23, executable: false });
          expect(attachment?.previewSnippet).toBe("notes.txt · 23 B");
          expect(JSON.stringify(codexPreview)).not.toContain("private attachment body");
          expect(codexTomlFile).toBeDefined();
          expect(codexTomlFile?.previewSnippet).not.toContain("super-secret-xyz");

          const driftErr = yield* exporter
            .apply({
              target: "codex",
              planDigest: TrimmedNonEmptyString.make("wrong-digest"),
            })
            .pipe(Effect.flip);
          expect(driftErr.code).toBe("invalid_config");

          const codexApplied = yield* exporter.apply({
            target: "codex",
            planDigest: TrimmedNonEmptyString.make(codexPreview.planDigest),
          });
          expect(codexApplied.writtenPaths).toContain(codexConfigPath);
          const exportedAsset = path.join(homeDir, ".codex", "skills", "ship-check", "asset.bin");
          expect(Array.from(yield* fs.readFile(exportedAsset))).toEqual([0, 255, 128]);
          expect((yield* fs.stat(exportedAsset)).mode & 0o111).toBe(0o111);
          yield* fs.writeFileString(exportedAsset, "first local edit");
          const previewUpdate = yield* exporter.preview({ target: "codex", sections: ["skills"] });
          const applyUpdate = exporter.apply({
            target: "codex",
            sections: ["skills"],
            planDigest: TrimmedNonEmptyString.make(previewUpdate.planDigest),
          });
          yield* fs.writeFileString(exportedAsset, "later local edit");
          expect((yield* applyUpdate.pipe(Effect.flip)).code).toBe("invalid_config");
          expect(yield* fs.readFileString(exportedAsset)).toBe("later local edit");
          yield* fs.writeFileString(exportedAsset, "first local edit");
          yield* fs.chmod(exportedAsset, 0o644);
          expect((yield* applyUpdate.pipe(Effect.flip)).code).toBe("invalid_config");
          const writtenToml = yield* fs.readFileString(codexConfigPath);
          expect(writtenToml).toContain('model = "gpt-5.4"');
          expect(writtenToml).toContain("[mcp_servers.docs]");
          expect(
            yield* fs.exists(path.join(homeDir, ".codex", "skills", "ship-check", "SKILL.md")),
          ).toBe(true);

          const quotedToml = [
            'developer_instructions = """',
            "This is an example of a managed block.",
            "# >>> T3 Code Portable Harness MCP (managed export) >>>",
            "[mcp_servers.old_example]",
            'command = "example"',
            "# <<< T3 Code Portable Harness MCP <<<",
            '"""',
            'model = "gpt-5.4"',
            "",
          ].join("\n");
          yield* fs.writeFileString(codexConfigPath, quotedToml);
          const quotedPreview = yield* exporter.preview({ target: "codex", sections: ["mcp"] });
          yield* exporter.apply({
            target: "codex",
            sections: ["mcp"],
            planDigest: TrimmedNonEmptyString.make(quotedPreview.planDigest),
          });
          const parsedExport = parseToml(yield* fs.readFileString(codexConfigPath));
          expect(parsedExport.developer_instructions).toBe(
            parseToml(quotedToml).developer_instructions,
          );
          expect(parsedExport.mcp_servers).toMatchObject({
            docs: { url: "https://mcp.example.com/docs" },
          });
          const repeatedExport = yield* exporter.preview({ target: "codex", sections: ["mcp"] });
          expect(repeatedExport.files[0]?.action).toBe("unchanged");

          const unmanagedToml = '[mcp_servers."docs"]\nurl = "https://existing.example/mcp"\n';
          yield* fs.writeFileString(codexConfigPath, unmanagedToml);
          const conflictPreview = yield* exporter.preview({ target: "codex", sections: ["mcp"] });
          expect(conflictPreview.files).toEqual([]);
          expect(conflictPreview.warnings.join("\n")).toContain("conflicting MCP server IDs");
          const conflictApplied = yield* exporter.apply({
            target: "codex",
            sections: ["mcp"],
            planDigest: TrimmedNonEmptyString.make(conflictPreview.planDigest),
          });
          expect(conflictApplied.writtenPaths).toEqual([]);
          expect(yield* fs.readFileString(codexConfigPath)).toBe(unmanagedToml);
          yield* fs.writeFileString(codexConfigPath, writtenToml);

          // 2. Claude export preserves unrelated keys (`numStartups`, `existing_one`) + writes commands & CLAUDE.md
          const claudePreview = yield* exporter.preview({ target: "claude" });
          const claudeApplied = yield* exporter.apply({
            target: "claude",
            planDigest: TrimmedNonEmptyString.make(claudePreview.planDigest),
          });
          expect(claudeApplied.writtenPaths).toContain(claudeJsonPath);
          const parsedClaude = JSON.parse(yield* fs.readFileString(claudeJsonPath)) as {
            numStartups: number;
            mcpServers: Record<string, unknown>;
          };
          expect(parsedClaude.numStartups).toBe(42);
          expect(parsedClaude.mcpServers.existing_one).toBeDefined();
          expect(parsedClaude.mcpServers.docs).toBeDefined();
          expect(yield* fs.exists(path.join(homeDir, ".claude", "commands", "lint-fix.md"))).toBe(
            true,
          );

          for (const [target, rulesPath] of [
            ["codex", codexRulesPath],
            ["claude", claudeRulesPath],
          ] as const) {
            const exported = yield* fs.readFileString(rulesPath);
            expect(exported.startsWith(handWritten)).toBe(true);
            expect(exported).toContain("<!-- T3-HARNESS-BEGIN -->");
            expect(exported).toContain("Prefer small pure functions.");
            expect(exported).not.toContain(organizationRule.body);
            expect(exported).toContain("<!-- T3-HARNESS-END -->");
            const second = yield* exporter.preview({ target });
            expect(second.files.find((file) => file.targetPath === rulesPath)?.action).toBe(
              "unchanged",
            );
          }

          // 3. Cursor export writes ~/.cursor/mcp.json + ~/.cursor/rules/*.mdc (never dirties repo tree)
          const cursorPreview = yield* exporter.preview({
            target: "cursor",
            workspaceRoot: repoRoot,
          });
          yield* exporter.apply({
            target: "cursor",
            workspaceRoot: repoRoot,
            planDigest: TrimmedNonEmptyString.make(cursorPreview.planDigest),
          });
          const cursorRuleFile = path.join(homeDir, ".cursor", "rules", "no-any.mdc");
          expect(yield* fs.exists(cursorRuleFile)).toBe(true);
          expect(yield* fs.exists(path.join(homeDir, ".cursor", "rules", "locked-guide.mdc"))).toBe(
            false,
          );
          const cursorRuleContent = yield* fs.readFileString(cursorRuleFile);
          expect(cursorRuleContent).toContain("globs:");
          expect(cursorRuleContent).toContain("Never use any.");

          const linkedHome = path.join(homeDir, ".claude");
          yield* fs.rename(linkedHome, path.join(homeDir, "linked-claude"));
          yield* fs.symlink(path.join(homeDir, "linked-claude"), linkedHome);
          const rejectedExport = yield* exporter.preview({ target: "claude" }).pipe(Effect.flip);
          expect(rejectedExport.detail).toContain("symlinked dotfile directory");
        }).pipe(
          Effect.provide(
            makeTestLayer(baseDir, homeDir, paths, {
              schemaVersion: 1,
              organization: TrimmedNonEmptyString.make("Example Org"),
              limits: { harnessLockedRules: [organizationRule] },
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
