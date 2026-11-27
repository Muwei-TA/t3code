// @effect-diagnostics nodeBuiltinImport:off -- Creates temporary bare git repositories for push/pull, isolation, history-scan, and secret-guard verification.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  HarnessMcpServerId,
  HarnessRuleId,
  TrimmedNonEmptyString,
  type ManagedPolicyDocument,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessStore from "./HarnessStore.ts";
import * as HarnessSyncService from "./HarnessSyncService.ts";

vi.mock("node:child_process", { spy: true });

function makeTestLayer(
  baseDir: string,
  paths: ServerConfig.ServerDerivedPaths,
  allowLocalRemoteForTest = true,
  policy?: ManagedPolicyDocument,
) {
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
  const storeLayer = HarnessStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(policyLayer),
    Layer.provideMerge(T3ProjectFileLoader.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return HarnessSyncService.makeLayer({ allowLocalRemoteForTest }).pipe(
    Layer.provide(Layer.mock(SecretResolver.SecretResolver)({ read: () => Effect.succeed([]) })),
    Layer.provide(ServerSecretStore.layer.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(storeLayer),
  );
}

function execGit(cwd: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", [...args], {
      cwd,
      stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed (${code})`)),
    );
  });
}

function commit(cwd: string, message: string) {
  return execGit(cwd, [
    "-c",
    "user.name=Harness test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    message,
  ]);
}

describe("HarnessSyncService", () => {
  it.effect(
    "opts into the portable MCP manifest for Git sync and imports stdio definitions disabled",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-portable-git-" }),
        );
        const source = path.join(root, "source");
        const target = path.join(root, "target");
        const srcLayer = makeTestLayer(
          source,
          yield* ServerConfig.deriveServerPaths(source, undefined),
        );
        const dstLayer = makeTestLayer(
          target,
          yield* ServerConfig.deriveServerPaths(target, undefined),
        );
        const remoteUrl = TrimmedNonEmptyString.make(path.join(root, "portable.git"));
        const branch = TrimmedNonEmptyString.make("main");
        yield* Effect.promise(() => execGit(root, ["init", "--bare", "-b", branch, remoteUrl]));
        const id = HarnessMcpServerId.make("local-fixture");
        const config = {
          enabled: true,
          injectionMode: "gateway" as const,
          approvalPolicy: "always-ask" as const,
          transport: {
            type: "stdio" as const,
            command: TrimmedNonEmptyString.make("node"),
            args: ["./tool.js"],
            env: { TOKEN: "${secret:DEMO}" },
          },
        };
        const manifest = "mcp-servers.portable.json";
        const pushCatalog = (serverId: HarnessMcpServerId, args: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const sync = yield* HarnessSyncService.HarnessSyncService;
            const store = yield* HarnessStore.HarnessStore;
            yield* store.upsertUserServer({
              id: serverId,
              config: { ...config, transport: { ...config.transport, args } },
            });
            yield* sync.configureRemote({ remoteUrl, branch, includePortableMcpServers: true });
            const preview = yield* sync.previewPush();
            expect(preview.files.map(({ path }) => path)).toEqual([manifest]);
            expect(
              (yield* sync.push({
                expectedRemoteUrl: remoteUrl,
                expectedBranch: branch,
                expectedTreeDigest: TrimmedNonEmptyString.make(preview.previewTreeDigest!),
              })).pushed,
            ).toBe(true);
          }).pipe(Effect.provide(srcLayer));
        yield* Effect.gen(function* () {
          const sync = yield* HarnessSyncService.HarnessSyncService;
          const store = yield* HarnessStore.HarnessStore;
          yield* store.upsertUserServer({ id, config });
          yield* sync.configureRemote({ remoteUrl, branch });
          expect(
            (yield* sync.previewPush()).files.find(({ path }) => path === manifest),
          ).toBeUndefined();
        }).pipe(Effect.provide(srcLayer));
        yield* pushCatalog(id, config.transport.args);
        yield* Effect.gen(function* () {
          const sync = yield* HarnessSyncService.HarnessSyncService;
          const store = yield* HarnessStore.HarnessStore;
          yield* sync.configureRemote({ remoteUrl, branch });
          yield* sync.pull();
          expect((yield* store.loadUserConfig).config.mcpServers[id]).toBeUndefined();
          yield* sync.configureRemote({ remoteUrl, branch, includePortableMcpServers: true });
          const pulled = yield* sync.pull();
          expect(pulled.importedDisabledMcpIds).toEqual([id]);
          expect(pulled.missingSecretRefs).toEqual(["${secret:DEMO}"]);
          expect((yield* store.loadUserConfig).config.mcpServers[id]).toMatchObject({
            ...config,
            enabled: false,
          });
          expect(yield* fs.exists(path.join(store.harnessDir, manifest))).toBe(false);
          expect((yield* sync.pull()).importedDisabledMcpIds).toEqual([]);
          yield* store.upsertUserServer({
            id,
            config: {
              ...config,
              enabled: false,
              transport: { ...config.transport, args: ["./local-edit.js"] },
            },
          });
          expect((yield* sync.pull()).conflicts).toBeUndefined();
          yield* sync.pull({ force: true });
          expect((yield* store.loadUserConfig).config.mcpServers[id]?.transport).toMatchObject({
            args: ["./local-edit.js"],
          });

          yield* store.removeUserServer(id);
          yield* sync.pull();
          expect((yield* store.loadUserConfig).config.mcpServers[id]).toBeUndefined();
          yield* sync.configureRemote({ remoteUrl, branch, includePortableMcpServers: false });
          yield* sync.configureRemote({ remoteUrl, branch, includePortableMcpServers: true });
          yield* sync.pull();
          expect((yield* store.loadUserConfig).config.mcpServers[id]).toBeUndefined();
        }).pipe(Effect.provide(dstLayer));

        const otherId = HarnessMcpServerId.make("second-fixture");
        yield* pushCatalog(otherId, ["./another.js"]);
        yield* Effect.gen(function* () {
          const sync = yield* HarnessSyncService.HarnessSyncService;
          const store = yield* HarnessStore.HarnessStore;
          expect((yield* sync.pull()).importedDisabledMcpIds).toEqual([otherId]);
          expect((yield* store.loadUserConfig).config.mcpServers[id]).toBeUndefined();
        }).pipe(Effect.provide(dstLayer));
        yield* pushCatalog(id, ["./upstream-edit.js"]);
        yield* Effect.gen(function* () {
          const sync = yield* HarnessSyncService.HarnessSyncService;
          const store = yield* HarnessStore.HarnessStore;
          expect((yield* sync.pull()).conflicts).toEqual([
            { path: manifest, reason: "modified_both" },
          ]);
          expect((yield* store.loadUserConfig).config.mcpServers[id]).toBeUndefined();
          expect((yield* sync.pull({ force: true })).importedDisabledMcpIds).toEqual([id]);
          expect((yield* store.loadUserConfig).config.mcpServers[id]?.transport).toMatchObject({
            args: ["./upstream-edit.js"],
          });
        }).pipe(Effect.provide(dstLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "previews and applies a portable bundle on another environment with target drift checks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-transfer-" }),
        );
        const source = path.join(root, "source");
        const target = path.join(root, "target");
        const srcLayer = makeTestLayer(
          source,
          yield* ServerConfig.deriveServerPaths(source, undefined),
        );
        const dstLayer = makeTestLayer(
          target,
          yield* ServerConfig.deriveServerPaths(target, undefined),
        );
        const rule = "rules/checks.md";
        const extra = "rules/local-only.md";
        const script = "skills/tool/scripts/check.sh";
        const sourceDir = path.join(source, "harness");
        const targetDir = path.join(target, "harness");
        yield* fs.makeDirectory(path.join(sourceDir, "rules"), { recursive: true });
        yield* fs.makeDirectory(path.join(targetDir, "rules"), { recursive: true });
        yield* fs.writeFileString(path.join(sourceDir, rule), "intro\nnew\nend\n");
        yield* fs.writeFileString(path.join(targetDir, rule), "intro\nold\nend\n");
        yield* fs.writeFileString(path.join(targetDir, extra), "Keep me.\n");
        yield* fs.makeDirectory(path.dirname(path.join(sourceDir, script)), { recursive: true });
        yield* fs.makeDirectory(path.dirname(path.join(targetDir, script)), { recursive: true });
        for (const dir of [sourceDir, targetDir])
          yield* fs.writeFileString(path.join(dir, script), "echo ok");
        yield* fs.chmod(path.join(sourceDir, script), 0o755);
        const id = HarnessMcpServerId.make("mcp-guide");
        const localId = HarnessMcpServerId.make("local-mcp");
        const config = {
          enabled: true,
          injectionMode: "gateway" as const,
          approvalPolicy: "always-ask" as const,
          transport: {
            type: "http" as const,
            url: TrimmedNonEmptyString.make("https://mcp.example.invalid/guide"),
            headers: { Authorization: "Bearer ${secret:DEMO}" },
          },
        };
        const exportResult = yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          yield* store.upsertUserServer({ id, config });
          const sync = yield* HarnessSyncService.HarnessSyncService;
          expect((yield* sync.exportBundle({})).bundle?.portableMcpServers).toBeUndefined();
          return yield* sync.exportBundle({ includeMcpServers: true });
        }).pipe(Effect.provide(srcLayer));
        expect(exportResult.canExport).toBe(true);
        const bundle = exportResult.bundle!;
        expect(bundle.files.map(({ path }) => path)).toEqual([rule, script]);
        expect(bundle.portableMcpServers?.servers[0]?.config.origin).toBeUndefined();

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const sync = yield* HarnessSyncService.HarnessSyncService;
          yield* store.upsertUserServer({
            id: localId,
            config: {
              ...config,
              enabled: false,
              transport: { ...config.transport, headers: { Authorization: "a local credential" } },
            },
          });
          const preview = yield* sync.previewReceive({ bundle });
          expect(preview.canApply).toBe(true);
          expect(preview.files).toEqual([
            { path: rule, status: "modified", additions: 1, deletions: 1 },
            { path: extra, status: "deleted", additions: 0, deletions: 1 },
            { path: script, status: "modified", additions: 0, deletions: 0 },
          ]);
          expect(preview.mcpServerDiffs).toEqual([{ id, status: "added", disabledOnImport: true }]);
          expect(preview.missingSecretRefs).toEqual(["${secret:DEMO}"]);
          expect((yield* store.loadUserConfig).config.mcpServers[id]).toBeUndefined();
          expect(yield* fs.readFileString(path.join(targetDir, rule))).toContain("old");

          yield* fs.writeFileString(path.join(targetDir, rule), "changed after preview\n");
          expect(
            (yield* sync
              .applyReceive({ bundle, expectedPreviewDigest: preview.previewDigest! })
              .pipe(Effect.flip)).detail,
          ).toContain("changed since preview");
          const next = yield* sync.previewReceive({ bundle });
          const applied = yield* sync.applyReceive({
            bundle,
            expectedPreviewDigest: next.previewDigest!,
            includeMcpServers: true,
          });
          expect(applied.appliedPaths).toEqual([rule, script]);
          expect((yield* fs.stat(path.join(targetDir, script))).mode & 0o111).toBe(0o111);
          expect(applied.importedDisabledMcpIds).toEqual([id]);
          const after = (yield* store.loadUserConfig).config.mcpServers;
          expect(after[id]).toMatchObject({ enabled: false, transport: config.transport });
          expect(after[localId]?.transport).toMatchObject({
            headers: { Authorization: "a local credential" },
          });
          expect(yield* fs.readFileString(path.join(targetDir, extra))).toBe("Keep me.\n");

          const final = yield* sync.previewReceive({ bundle });
          expect(final.mcpServerDiffs).toEqual([]);
          expect(
            (yield* sync.applyReceive({
              bundle,
              expectedPreviewDigest: final.previewDigest!,
              deleteRemovedFiles: true,
            })).appliedPaths,
          ).toEqual([extra]);
          expect(yield* fs.exists(path.join(targetDir, extra))).toBe(false);
          const invalid = { ...bundle, files: [{ path: "rules/../harness.json", text: "{}" }] };
          const blocked = yield* sync.previewReceive({ bundle: invalid });
          expect(blocked.canApply).toBe(false);
          expect(blocked.secretFindings.map(({ rule }) => rule)).toContain(
            "disallowed-bundle-path",
          );

          yield* fs.remove(path.join(targetDir, rule));
          yield* fs.symlink(path.join(sourceDir, rule), path.join(targetDir, rule));
          const unsafe = yield* sync.previewReceive({ bundle });
          expect(unsafe.canApply).toBe(false);
          expect(unsafe.secretFindings.map(({ rule }) => rule)).toContain("unscannable-symlink");
        }).pipe(Effect.provide(dstLayer));

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          yield* store.upsertUserServer({
            id,
            config: {
              ...config,
              transport: {
                ...config.transport,
                headers: { Authorization: "another literal credential" },
              },
            },
          });
          const sync = yield* HarnessSyncService.HarnessSyncService;
          yield* fs.writeFileString(
            path.join(sourceDir, rule),
            "Sample fixture ghp_abcdefghijklmnopqrstuvwxyz\n",
          );
          const blocked = yield* sync.exportBundle({ includeMcpServers: true });
          expect(blocked.canExport).toBe(false);
          expect(blocked.bundle).toBeNull();
          expect(blocked.secretFindings).toContainEqual(
            expect.objectContaining({ rule: "unsafe-portable-mcp", serverId: id }),
          );
          expect(
            blocked.secretFindings.filter(
              (finding) => finding.path === rule && finding.rule === "github-token",
            ),
          ).toHaveLength(1);
        }).pipe(Effect.provide(srcLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps organization-locked rules out of bundles and Git pull", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-locked-sync-" }),
      );
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      const srcLayer = makeTestLayer(
        source,
        yield* ServerConfig.deriveServerPaths(source, undefined),
      );
      const dstLayer = makeTestLayer(
        target,
        yield* ServerConfig.deriveServerPaths(target, undefined),
        true,
        {
          schemaVersion: 1,
          organization: TrimmedNonEmptyString.make("Example Org"),
          limits: {
            harnessLockedRules: [
              {
                id: HarnessRuleId.make("locked"),
                apply: "always",
                body: TrimmedNonEmptyString.make("Organization rule"),
              },
            ],
          },
        },
      );
      const rule = "rules/locked.md";
      const srcRules = path.join(source, "harness", "rules");
      const dstRules = path.join(target, "harness", "rules");
      yield* fs.makeDirectory(srcRules, { recursive: true });
      yield* fs.makeDirectory(dstRules, { recursive: true });
      yield* fs.writeFileString(path.join(srcRules, "locked.md"), "Source file\n");
      yield* fs.writeFileString(path.join(dstRules, "locked.md"), "Dormant local file\n");
      const remoteUrl = TrimmedNonEmptyString.make(path.join(root, "sync.git"));
      const branch = TrimmedNonEmptyString.make("main");
      yield* Effect.promise(() => execGit(root, ["init", "--bare", "-b", branch, remoteUrl]));

      const bundle = yield* Effect.gen(function* () {
        const sync = yield* HarnessSyncService.HarnessSyncService;
        const exported = yield* sync.exportBundle({});
        expect(exported.bundle?.files.map(({ path }) => path)).toEqual([rule]);
        yield* sync.configureRemote({ remoteUrl, branch });
        const preview = yield* sync.previewPush();
        yield* sync.push({
          expectedRemoteUrl: remoteUrl,
          expectedBranch: branch,
          expectedTreeDigest: TrimmedNonEmptyString.make(preview.previewTreeDigest!),
        });
        return exported.bundle!;
      }).pipe(Effect.provide(srcLayer));

      yield* Effect.gen(function* () {
        const sync = yield* HarnessSyncService.HarnessSyncService;
        expect((yield* sync.exportBundle({})).bundle?.files).toEqual([]);
        const preview = yield* sync.previewReceive({ bundle });
        expect(preview.canApply).toBe(false);
        expect(preview.secretFindings).toContainEqual(
          expect.objectContaining({ path: rule, rule: "organization-locked-rule" }),
        );
        const rejected = yield* sync
          .applyReceive({
            bundle,
            expectedPreviewDigest: "0".repeat(64),
            selectedPaths: [rule],
            deleteRemovedFiles: true,
          })
          .pipe(Effect.flip);
        expect(rejected.code).toBe("invalid_config");
        yield* sync.configureRemote({ remoteUrl, branch });
        const pulled = yield* sync.pull({ force: true });
        expect(pulled.skippedFiles).toContain(rule);
        expect(pulled.updatedFiles).toEqual([]);
        expect(yield* fs.readFileString(path.join(dstRules, "locked.md"))).toBe(
          "Dormant local file\n",
        );
      }).pipe(Effect.provide(dstLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "isolates git repo from harnessDir, blocks secrets/oversized/drift/credentials, and enforces strict allowlist on push and pull",
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

          // Read-only status/preview before configuration must not create .git or .gitignore in harnessDir.
          const initialStatus = yield* sync.getStatus();
          expect(initialStatus.initialized).toBe(false);
          const initialPreview = yield* sync.previewPush();
          expect(initialPreview.canPush).toBe(false);
          expect(initialPreview.previewTreeDigest).toBeNull();
          const hasGitInHarness = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(store.harnessDir, ".git"))
              .then(() => true)
              .catch(() => false),
          );
          expect(hasGitInHarness).toBe(false);

          // Reject remote URLs containing embedded credentials.
          const badRemote = yield* sync
            .configureRemote({
              remoteUrl: TrimmedNonEmptyString.make(
                "https://ghp_secretToken123@github.com/org/repo.git",
              ),
              branch: TrimmedNonEmptyString.make("main"),
            })
            .pipe(Effect.result);
          expect(Result.isFailure(badRemote)).toBe(true);
          if (Result.isFailure(badRemote)) {
            expect(badRemote.failure.code).toBe("invalid_config");
          }

          const configured = yield* sync.configureRemote({
            remoteUrl: TrimmedNonEmptyString.make(bareRemote),
            branch: TrimmedNonEmptyString.make("main"),
          });
          expect(configured.initialized).toBe(true);
          expect(configured.remoteUrl).toBe(bareRemote);

          // Write allowlisted files (one with raw secret), plus excluded executable/trust files.
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.join(store.harnessDir, "memory"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "harness.json"),
              JSON.stringify({ mcpServers: { bad: { command: "sh" } } }),
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
          expect(blockedPreview.secretFindings).toContainEqual({
            path: "memory/leak.md",
            line: 1,
            rule: "github-token",
            preview: "***",
          });
          // Excluded local trust ledgers & executable configs must never appear in outbound files.
          expect(blockedPreview.files.some((f) => f.path.includes("plugins-state.json"))).toBe(
            false,
          );
          expect(blockedPreview.files.some((f) => f.path.includes("harness.json"))).toBe(false);

          const blockedPush = yield* sync
            .push({
              expectedRemoteUrl: TrimmedNonEmptyString.make(bareRemote),
              expectedBranch: TrimmedNonEmptyString.make("main"),
              expectedTreeDigest: TrimmedNonEmptyString.make(
                blockedPreview.previewTreeDigest ?? "missing",
              ),
            })
            .pipe(Effect.result);
          expect(Result.isFailure(blockedPush)).toBe(true);
          if (Result.isFailure(blockedPush)) {
            expect(blockedPush.failure.code).toBe("policy_denied");
          }

          // Oversized (>512 KiB) allowlisted file must fail closed (never silently skipped).
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "memory", "leak.md"),
              "A".repeat(600 * 1024),
              "utf8",
            );
          });
          const oversizedPreview = yield* sync.previewPush();
          expect(oversizedPreview.canPush).toBe(false);
          expect(
            oversizedPreview.secretFindings.some((f) => f.rule === "unscannable-oversized"),
          ).toBe(true);

          // Replace with safe content referencing ${secret:GITHUB_TOKEN}.
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
          expect(safePreview.previewTreeDigest).not.toBeNull();

          // Mutating the file AFTER preview must fail push because tree digest drifted.
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              NodePath.join(store.harnessDir, "memory", "leak.md"),
              "Changed after preview!",
              "utf8",
            );
          });
          const driftedPush = yield* sync
            .push({
              expectedRemoteUrl: TrimmedNonEmptyString.make(bareRemote),
              expectedBranch: TrimmedNonEmptyString.make("main"),
              expectedTreeDigest: TrimmedNonEmptyString.make(safePreview.previewTreeDigest!),
            })
            .pipe(Effect.result);
          expect(Result.isFailure(driftedPush)).toBe(true);
          if (Result.isFailure(driftedPush)) {
            expect(driftedPush.failure.code).toBe("invalid_config");
          }

          // Fresh preview + push succeeds cleanly.
          const freshPreview = yield* sync.previewPush();
          expect(freshPreview.canPush).toBe(true);
          const pushed = yield* sync.push({
            commitMessage: TrimmedNonEmptyString.make("chore: initial portable harness"),
            expectedRemoteUrl: TrimmedNonEmptyString.make(bareRemote),
            expectedBranch: TrimmedNonEmptyString.make("main"),
            expectedTreeDigest: TrimmedNonEmptyString.make(freshPreview.previewTreeDigest!),
          });
          expect(pushed.committed).toBe(true);
          expect(pushed.pushed).toBe(true);

          // Simulate a malicious remote commit introducing hooks.json, harness.json, plugins-state.json,
          // AND a legitimate allowlisted rule file.
          const attackerClone = path.join(tempRoot, "attacker");
          yield* Effect.promise(async () => {
            await execGit(tempRoot, ["clone", bareRemote, attackerClone]);
            const script = NodePath.join(attackerClone, "skills", "tool", "scripts", "check.sh");
            await NodeFSP.mkdir(NodePath.dirname(script), { recursive: true });
            await NodeFSP.writeFile(script, "echo ok", { mode: 0o755 });
            await NodeFSP.mkdir(NodePath.join(attackerClone, "rules"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(attackerClone, "rules", "safe-rule.md"),
              "---\napply: always\n---\nAlways write tests.\n",
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(attackerClone, "hooks.json"),
              JSON.stringify({ version: 1, hooks: [{ id: "evil", event: "turn.beforeStart" }] }),
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(attackerClone, "plugins-state.json"),
              JSON.stringify({ trustedDigests: { evil: "deadbeef" }, enabled: { evil: true } }),
              "utf8",
            );
            await execGit(attackerClone, ["add", "-A"]);
            await execGit(attackerClone, [
              "update-index",
              "--chmod=+x",
              "skills/tool/scripts/check.sh",
            ]);
            await execGit(attackerClone, [
              "-c",
              "user.name=Remote",
              "-c",
              "user.email=remote@example.com",
              "commit",
              "-m",
              "remote update with mixed files",
            ]);
            await execGit(attackerClone, ["push", "origin", "main"]);
          });

          const pulled = yield* sync.pull();
          expect(pulled.pulled).toBe(true);
          expect(pulled.updatedFiles).toContain("rules/safe-rule.md");
          expect(
            (yield* fs.stat(path.join(store.harnessDir, "skills/tool/scripts/check.sh"))).mode &
              0o111,
          ).toBe(0o111);
          expect(pulled.skippedFiles).toContain("hooks.json");
          expect(pulled.skippedFiles).toContain("plugins-state.json");

          // Verify hooks.json did NOT land in live harnessDir and local plugins-state.json was untouched!
          const hooksExists = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(store.harnessDir, "hooks.json"))
              .then(() => true)
              .catch(() => false),
          );
          expect(hooksExists).toBe(false);
          const localPluginsState = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(store.harnessDir, "plugins-state.json"), "utf8"),
          );
          expect(localPluginsState).toContain("demo");
          expect(localPluginsState).not.toContain("evil");

          const localRule = path.join(store.harnessDir, "rules", "safe-rule.md");
          const localNote = path.join(store.harnessDir, "memory", "leak.md");
          yield* fs.writeFileString(localRule, "Local rule edit\n");
          yield* fs.writeFileString(localNote, "Local note edit\n");
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              path.join(attackerClone, "rules", "safe-rule.md"),
              "Remote rule edit\n",
            );
            await NodeFSP.unlink(path.join(attackerClone, "memory", "leak.md"));
            await NodeFSP.symlink("safe-rule.md", path.join(attackerClone, "rules", "linked.md"));
            await execGit(attackerClone, ["add", "-A"]);
            await commit(attackerClone, "Update rule and remove note");
            await execGit(attackerClone, ["push", "origin", "main"]);
          });

          const conflicted = yield* sync.pull();
          expect(conflicted.conflicts).toEqual(
            expect.arrayContaining([
              { path: "rules/safe-rule.md", reason: "modified_both" },
              { path: "memory/leak.md", reason: "deleted_upstream_modified_locally" },
            ]),
          );
          expect(conflicted.skippedFiles).toContain("rules/linked.md");
          expect(yield* fs.exists(path.join(store.harnessDir, "rules", "linked.md"))).toBe(false);
          expect(yield* fs.readFileString(localRule)).toBe("Local rule edit\n");
          expect(yield* fs.readFileString(localNote)).toBe("Local note edit\n");
          expect((yield* sync.pull()).conflicts).toEqual(conflicted.conflicts);

          const forced = yield* sync.pull({ force: true });
          expect(forced.updatedFiles).toEqual(
            expect.arrayContaining(["rules/safe-rule.md", "memory/leak.md"]),
          );
          expect(yield* fs.readFileString(localRule)).toBe("Remote rule edit\n");
          expect(yield* fs.exists(localNote)).toBe(false);
          expect((yield* sync.pull()).conflicts).toBeUndefined();
        }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the pushed resolution as the base for the next pull", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-pull-base-" });
      const paths = yield* ServerConfig.deriveServerPaths(root, undefined);
      const remote = path.join(root, "remote.git");
      const clone = path.join(root, "clone");
      yield* Effect.promise(() => execGit(root, ["init", "--bare", "-b", "main", remote]));

      yield* Effect.gen(function* () {
        const sync = yield* HarnessSyncService.HarnessSyncService;
        const { harnessDir } = yield* HarnessStore.HarnessStore;
        const remoteUrl = TrimmedNonEmptyString.make(remote);
        const branch = TrimmedNonEmptyString.make("main");
        const push = Effect.gen(function* () {
          const preview = yield* sync.previewPush();
          expect(preview.canPush).toBe(true);
          return yield* sync.push({
            expectedRemoteUrl: remoteUrl,
            expectedBranch: branch,
            expectedTreeDigest: TrimmedNonEmptyString.make(preview.previewTreeDigest!),
          });
        });
        const updateRemote = (body: string) =>
          Effect.promise(async () => {
            await NodeFSP.writeFile(path.join(clone, "AGENTS.md"), body);
            await execGit(clone, ["add", "AGENTS.md"]);
            await commit(clone, "Update instructions");
            await execGit(clone, ["push", "origin", "main"]);
          });

        yield* sync.configureRemote({ remoteUrl, branch });
        yield* fs.makeDirectory(harnessDir, { recursive: true });
        const agentsPath = path.join(harnessDir, "AGENTS.md");
        yield* fs.writeFileString(agentsPath, "Shared instructions\n");
        expect((yield* push).pushed).toBe(true);
        yield* Effect.promise(() => execGit(root, ["clone", remote, clone]));

        yield* fs.writeFileString(agentsPath, "Local instructions\n");
        yield* updateRemote("Remote instructions\n");
        expect((yield* sync.pull()).conflicts).toEqual([
          { path: "AGENTS.md", reason: "modified_both" },
        ]);

        yield* fs.writeFileString(agentsPath, "Resolved instructions\n");
        expect((yield* push).pushed).toBe(true);
        yield* Effect.promise(() => execGit(clone, ["pull", "--ff-only", "origin", "main"]));
        yield* updateRemote("New remote instructions\n");
        const pulled = yield* sync.pull();
        expect(pulled.conflicts).toBeUndefined();
        expect(pulled.updatedFiles).toEqual(["AGENTS.md"]);
        expect(yield* fs.readFileString(agentsPath)).toBe("New remote instructions\n");
      }).pipe(Effect.provide(makeTestLayer(root, paths)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "blocks an earlier outbound secret and symlink even after both disappear from HEAD",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-history-" });
        const paths = yield* ServerConfig.deriveServerPaths(root, undefined);

        yield* Effect.gen(function* () {
          const sync = yield* HarnessSyncService.HarnessSyncService;
          const store = yield* HarnessStore.HarnessStore;
          const remote = path.join(root, "remote.git");
          yield* Effect.promise(() => execGit(root, ["init", "--bare", "-b", "main", remote]));
          yield* sync.configureRemote({ remoteUrl: TrimmedNonEmptyString.make(remote) });
          const checkout = path.join(path.dirname(store.harnessDir), "harness-sync");
          yield* Effect.promise(async () => {
            const memory = path.join(checkout, "memory");
            await NodeFSP.mkdir(memory);
            await NodeFSP.writeFile(
              path.join(memory, "note.md"),
              "private note ghp_1234567890abcdefghij1234567890\n",
            );
            await NodeFSP.symlink("note.md", path.join(memory, "linked.md"));
            await execGit(checkout, ["add", "-A"]);
            await commit(checkout, "First version");
            await NodeFSP.rm(path.join(memory, "linked.md"));
            await NodeFSP.writeFile(path.join(memory, "note.md"), "clean note\n");
            await execGit(checkout, ["add", "-A"]);
            await commit(checkout, "Clean version");
          });
          const git = vi.mocked(NodeChildProcess.spawn);
          git.mockClear();
          const historyScans = () =>
            git.mock.calls.filter(
              ([command, args]) =>
                command === "git" && args?.includes("rev-list") && !args.includes("--left-right"),
            ).length;
          const preview = yield* sync.previewPush();
          expect(preview.canPush).toBe(false);
          expect(preview.secretFindings).toEqual(
            expect.arrayContaining([
              { path: "memory/note.md", line: 1, rule: "github-token", preview: "***" },
              expect.objectContaining({ path: "memory/linked.md", rule: "unscannable-symlink" }),
            ]),
          );
          expect(historyScans()).toBe(1);
          yield* fs.makeDirectory(store.harnessDir, { recursive: true });
          yield* fs.writeFileString(path.join(store.harnessDir, "AGENTS.md"), "Local edit\n");
          const edited = yield* sync.previewPush();
          expect(edited.previewTreeDigest).not.toBe(preview.previewTreeDigest);
          expect(edited.secretFindings).toEqual(preview.secretFindings);
          expect(historyScans()).toBe(1);
          const blocked = yield* sync
            .push({
              expectedRemoteUrl: TrimmedNonEmptyString.make(remote),
              expectedBranch: TrimmedNonEmptyString.make("main"),
              expectedTreeDigest: TrimmedNonEmptyString.make(edited.previewTreeDigest!),
            })
            .pipe(Effect.flip);
          expect(blocked.code).toBe("policy_denied");
        }).pipe(Effect.provide(makeTestLayer(root, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects unsupported remotes and initializes its own repository despite ambient GIT_DIR",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-remotes-" });
        const paths = yield* ServerConfig.deriveServerPaths(root, undefined);

        yield* Effect.gen(function* () {
          const sync = yield* HarnessSyncService.HarnessSyncService;
          const store = yield* HarnessStore.HarnessStore;
          for (const remoteUrl of [
            "ext::disabled",
            "file:///tmp/remote",
            "/tmp/remote",
            "--not-a-remote",
          ]) {
            const rejected = yield* sync
              .configureRemote({
                remoteUrl: TrimmedNonEmptyString.make(remoteUrl),
              })
              .pipe(Effect.flip);
            expect(rejected.code).toBe("invalid_config");
          }
          const unrelated = path.join(root, "unrelated.git");
          vi.stubEnv("GIT_DIR", unrelated);
          try {
            const remoteUrl = TrimmedNonEmptyString.make("https://example.com/harness.git");
            const status = yield* sync.configureRemote({ remoteUrl });
            expect(status.initialized).toBe(true);
            const gitDir = path.join(path.dirname(store.harnessDir), "harness-sync", ".git");
            expect(yield* fs.exists(gitDir)).toBe(true);
            expect(yield* fs.exists(unrelated)).toBe(false);
            const pendingPath = path.join(gitDir, "t3-harness-pull-bases.json");
            yield* fs.writeFileString(pendingPath, '{"AGENTS.md":null}');
            yield* sync.configureRemote({ remoteUrl });
            expect(yield* fs.exists(pendingPath)).toBe(true);
            const branch = TrimmedNonEmptyString.make("next");
            yield* sync.configureRemote({ remoteUrl, branch });
            expect(yield* fs.exists(pendingPath)).toBe(false);
            yield* fs.writeFileString(pendingPath, '{"AGENTS.md":null}');
            yield* sync.configureRemote({
              remoteUrl: TrimmedNonEmptyString.make("https://example.com/other.git"),
              branch,
            });
            expect(yield* fs.exists(pendingPath)).toBe(false);
          } finally {
            vi.unstubAllEnvs();
          }
        }).pipe(Effect.provide(makeTestLayer(root, paths, false)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("sanitizes remote URLs with embedded userinfo", () => {
    expect(
      HarnessSyncService.hasEmbeddedRemoteCredentials("https://token@github.com/org/repo.git"),
    ).toBe(true);
    expect(HarnessSyncService.hasEmbeddedRemoteCredentials("git@github.com:org/repo.git")).toBe(
      false,
    );
    expect(HarnessSyncService.sanitizeRemoteUrl("https://user:pass@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });
});
