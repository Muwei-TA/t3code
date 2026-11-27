// @effect-diagnostics nodeBuiltinImport:off -- Test fixture setup creates temporary plugin directory trees on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HarnessModeId, HarnessPluginId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessHooksService from "./HarnessHooksService.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import * as HarnessStore from "./HarnessStore.ts";
import * as PluginHost from "./PluginHost.ts";

function makeTestLayer(
  baseDir: string,
  paths: ServerConfig.ServerDerivedPaths,
  denyPlugins = false,
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
    document: denyPlugins
      ? { schemaVersion: 1, organization: "Fixture", limits: { harnessPlugins: false } }
      : undefined,
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
  const pluginLayer = PluginHost.layer.pipe(
    Layer.provideMerge(hooksLayer),
    Layer.provideMerge(storeLayer),
  );
  const libraryLayer = HarnessLibraryStore.layer.pipe(
    Layer.provideMerge(pluginLayer),
    Layer.provideMerge(storeLayer),
  );
  return Layer.mergeAll(
    configLayer,
    policyLayer,
    storeLayer,
    hooksLayer,
    pluginLayer,
    libraryLayer,
    NodeServices.layer,
  );
}

describe("PluginHost", () => {
  it.effect("keeps external plugins inactive under policy and rejects activation operations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-policy-" }),
      );
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const source = path.join(baseDir, "bundle");
      yield* fs.makeDirectory(path.join(source, "skills", "example"), { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "t3-plugin.json"),
        '{"id":"demo-plugin","name":"Demo","version":"1.0.0"}',
      );
      yield* fs.writeFileString(
        path.join(source, "skills", "example", "SKILL.md"),
        "---\nname: example\n---\nExample\n",
      );
      const installed = yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const snapshot = yield* host.install({ sourcePath: TrimmedNonEmptyString.make(source) });
        const plugin = snapshot.plugins[0]!;
        return (yield* host.trust({
          id: plugin.id,
          expectedDigest: TrimmedNonEmptyString.make(plugin.contentDigest),
        })).plugins[0]!;
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      expect(installed.active).toBe(true);
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const snapshot = yield* host.list();
        expect(snapshot.managedPolicyAllowsHarness).toBe(true);
        expect(snapshot.managedPolicyAllowsPlugins).toBe(false);
        expect(snapshot.plugins[0]?.active).toBe(false);
        expect(host.getActiveContributions()).toEqual([]);
        const operations = [
          host.install({ sourcePath: TrimmedNonEmptyString.make(source) }),
          host.trust({
            id: installed.id,
            expectedDigest: TrimmedNonEmptyString.make(installed.contentDigest),
          }),
          host.setEnabled({ id: installed.id, enabled: true }),
          host.reload({}),
          host
            .packPlugin({ id: installed.id, name: installed.name, version: "2.0.0" })
            .pipe(Effect.asVoid),
        ];
        for (const operation of operations)
          expect((yield* Effect.flip(operation)).code).toBe("policy_denied");
        expect((yield* host.remove({ id: installed.id })).plugins).toEqual([]);
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths, true)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("discovers a directly copied bundle under its installed id without activating it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        expect((yield* host.list()).plugins).toEqual([]);
        const directory = path.join(paths.harnessDir, "plugins", "copied");
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          path.join(directory, "t3-plugin.json"),
          '{"id":"original","name":"Copied"}',
        );
        expect((yield* host.list()).plugins).toMatchObject([
          { id: "copied", enabled: false, active: false, trustStatus: "untrusted" },
        ]);
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "enforces owner digest trust, reversible Scope activation/unload, tamper detection, and .claude-plugin compatibility",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-host-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        // Prepare a native t3-plugin directory
        const srcNative = path.join(tempRoot, "native-pack");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(srcNative, "skills", "audit-skill"), {
            recursive: true,
          });
          await NodeFSP.mkdir(NodePath.join(srcNative, "modes"), { recursive: true });
          await NodeFSP.mkdir(NodePath.join(srcNative, "workflows"), { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(srcNative, "t3-plugin.json"),
            JSON.stringify(
              {
                id: "acme-audit",
                name: "Acme Audit",
                version: "1.0.0",
                description: "Security audit bundle",
                mcpServers: { search: { url: "https://example.invalid/mcp" } },
                hooks: [
                  {
                    id: "before-check",
                    event: "turn.beforeStart",
                    target: {
                      type: "command",
                      command: process.execPath,
                      args: [
                        "-e",
                        'process.stdout.write(JSON.stringify({ injectContext: "[acme-plugin]" }))',
                      ],
                    },
                  },
                ],
              },
              null,
              2,
            ),
          );
          await NodeFSP.writeFile(
            NodePath.join(srcNative, "skills", "audit-skill", "SKILL.md"),
            "---\nname: audit-skill\ndescription: Security checklist\n---\n\nCheck input validation.\n",
          );
          await NodeFSP.writeFile(
            NodePath.join(srcNative, "modes", "sec-audit.md"),
            "---\nname: Sec Audit\nreadonly: true\nbaseInteractionMode: plan\n---\n\nInspect security invariants.\n",
          );
          await NodeFSP.writeFile(
            NodePath.join(srcNative, "workflows", "audit.yaml"),
            "name: audit-workflow\nsteps:\n  - id: review\n    modeId: review\n    prompt: Review the change\n",
          );
        });

        // Prepare a .claude-plugin compatible directory
        const srcClaude = path.join(tempRoot, "claude-compat");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(srcClaude, ".claude-plugin"), { recursive: true });
          await NodeFSP.mkdir(NodePath.join(srcClaude, "skills", "claude-helper"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(srcClaude, ".claude-plugin", "plugin.json"),
            JSON.stringify({ name: "Claude Compat", version: "0.2.0" }),
          );
          await NodeFSP.writeFile(
            NodePath.join(srcClaude, "skills", "claude-helper", "SKILL.md"),
            "---\nname: claude-helper\n---\n\nHelper body.\n",
          );
        });

        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          const hooks = yield* HarnessHooksService.HarnessHooksService;
          const library = yield* HarnessLibraryStore.HarnessLibraryStore;

          const store = yield* HarnessStore.HarnessStore;
          const gatewayServer = store
            .resolveWorkspace()
            .pipe(Effect.map((w) => w.servers.find((s) => s.id === "plugin-acme-audit-search")));
          yield* fs.writeFile(path.join(srcNative, "asset.bin"), Uint8Array.of(0, 1, 255, 0));
          yield* fs.writeFileString(path.join(srcNative, "check.sh"), "echo ok");
          yield* fs.chmod(path.join(srcNative, "check.sh"), 0o755);
          const sourcePath = TrimmedNonEmptyString.make(srcNative);
          const risk = yield* host.inspectExecutableRisk({ kind: "sourcePath", sourcePath });
          const expectedFiles = [
            "asset.bin",
            "check.sh",
            "modes/sec-audit.md",
            "skills/audit-skill/SKILL.md",
            "t3-plugin.json",
            "workflows/audit.yaml",
          ];
          const records = yield* Effect.promise(() =>
            Promise.all(
              expectedFiles.map(async (name) => [
                name,
                (await NodeFSP.stat(path.join(srcNative, name))).mode & 0o111,
                NodeCrypto.createHash("sha256")
                  .update(await NodeFSP.readFile(path.join(srcNative, name)))
                  .digest("hex"),
              ]),
            ),
          );
          expect(risk.contentDigest).toBe(
            NodeCrypto.createHash("sha256")
              .update(JSON.stringify({ version: 2, files: records }))
              .digest("hex"),
          );
          expect(risk.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
          yield* Effect.promise(() =>
            NodeFSP.appendFile(path.join(srcNative, "t3-plugin.json"), "\n"),
          );
          const changedManifest = yield* host
            .install({
              sourcePath,
              expectedManifestDigest: risk.manifestDigest,
            })
            .pipe(Effect.flip);
          expect(changedManifest.detail).toContain("changed since it was inspected");
          expect((yield* host.list()).plugins).toEqual([]);

          // 1. Install without trustOnInstall -> untrusted and inactive (zero hooks/skills leaked)
          const installed = yield* host.install({
            sourcePath: TrimmedNonEmptyString.make(srcNative),
          });
          const plugin = installed.plugins.find((p) => p.id === "acme-audit");
          expect(plugin).toBeDefined();
          expect(plugin?.trustStatus).toBe("untrusted");
          expect(plugin?.active).toBe(false);
          expect(yield* gatewayServer).toBeUndefined();
          expect(
            (yield* fs.stat(path.join(installed.pluginsDir, "acme-audit", "check.sh"))).mode &
              0o111,
          ).toBe(0o111);
          expect((yield* hooks.list()).hooks).toHaveLength(0);
          expect((yield* library.getSnapshot()).skills.some((s) => s.id === "audit-skill")).toBe(
            false,
          );

          // 2. Wrong digest fails closed
          const wrongTrust = yield* host
            .trust({
              id: HarnessPluginId.make("acme-audit"),
              expectedDigest: TrimmedNonEmptyString.make("0000deadbeef"),
            })
            .pipe(Effect.flip);
          expect(wrongTrust.code).toBe("untrusted");

          // 3. Exact digest trust activates plugin via Effect Scope (skills, modes, and hooks live)
          const trusted = yield* host.trust({
            id: HarnessPluginId.make("acme-audit"),
            expectedDigest: TrimmedNonEmptyString.make(plugin!.contentDigest),
          });
          expect(trusted.plugins.find((p) => p.id === "acme-audit")?.active).toBe(true);
          expect((yield* hooks.list()).hooks.some((h) => h.pluginId === "acme-audit")).toBe(true);
          expect(yield* gatewayServer).toMatchObject({
            effectiveEnabled: true,
            config: { injectionMode: "gateway" },
          });
          const libWhileActive = yield* library.getSnapshot();
          expect(libWhileActive.skills.some((s) => s.id === "audit-skill")).toBe(true);
          expect(libWhileActive.modes.some((m) => m.id === "sec-audit")).toBe(true);
          const duplicateMode = yield* library
            .createUserMode({
              id: HarnessModeId.make("sec-audit"),
              baseInteractionMode: "default",
              body: "Replacement mode",
            })
            .pipe(Effect.flip);
          expect(duplicateMode.code).toBe("invalid_config");
          expect(
            (yield* library.getSnapshot()).modes.find((mode) => mode.id === "sec-audit")?.body,
          ).toContain("Inspect security invariants.");
          expect(trusted.plugins.find((p) => p.id === "acme-audit")?.workflowFiles).toEqual([
            "workflows/audit.yaml",
          ]);
          expect(host.getActiveContributions().flatMap((item) => item.workflows)).toEqual([
            expect.objectContaining({ relativePath: "workflows/audit.yaml" }),
          ]);

          // 4. Reversible unload: disabling closes the plugin's Scope -> ZERO leaked hooks or skills
          const disabled = yield* host.setEnabled({
            id: HarnessPluginId.make("acme-audit"),
            enabled: false,
          });
          expect(disabled.plugins.find((p) => p.id === "acme-audit")?.active).toBe(false);
          expect((yield* hooks.list()).hooks).toHaveLength(0);
          expect(host.getActiveContributions()).toEqual([]);
          expect(yield* gatewayServer).toBeUndefined();
          expect((yield* library.getSnapshot()).skills.some((s) => s.id === "audit-skill")).toBe(
            false,
          );

          // Re-enable -> active again
          yield* host.setEnabled({ id: HarnessPluginId.make("acme-audit"), enabled: true });
          expect((yield* hooks.list()).hooks).toHaveLength(1);

          const script = path.join(installed.pluginsDir, "acme-audit", "check.sh");
          yield* fs.chmod(script, 0o700);
          const changed = (yield* host.list()).plugins.find((p) => p.id === "acme-audit")!;
          expect(changed).toMatchObject({ active: false, trustStatus: "digest_changed" });
          expect(
            (yield* host
              .trust({
                id: changed.id,
                expectedDigest: TrimmedNonEmptyString.make(plugin!.contentDigest),
              })
              .pipe(Effect.flip)).code,
          ).toBe("untrusted");
          yield* host.trust({
            id: changed.id,
            expectedDigest: TrimmedNonEmptyString.make(changed.contentDigest),
          });

          // 5. Tampering with a file on disk flips trustStatus to digest_changed and auto-deactivates
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(
                installed.pluginsDir,
                "acme-audit",
                "skills",
                "audit-skill",
                "SKILL.md",
              ),
              "---\nname: audit-skill\n---\n\nTAMPERED!\n",
            ),
          );
          const afterTamper = yield* host.reload({ id: HarnessPluginId.make("acme-audit") });
          const tampered = afterTamper.plugins.find((p) => p.id === "acme-audit");
          expect(tampered?.trustStatus).toBe("digest_changed");
          expect(tampered?.active).toBe(false);
          expect((yield* hooks.list()).hooks).toHaveLength(0);

          // 6. .claude-plugin/plugin.json compatibility
          const claudeInstalled = yield* host.install({
            sourcePath: TrimmedNonEmptyString.make(srcClaude),
            id: HarnessPluginId.make("claude-compat"),
            trustOnInstall: true,
          });
          const claudeView = claudeInstalled.plugins.find((p) => p.id === "claude-compat");
          expect(claudeView?.format).toBe("claude-plugin");
          expect(claudeView?.active).toBe(true);
          expect(claudeView?.skillIds).toEqual(["claude-helper"]);

          // 7. Creator Mode packPlugin creates manifest under pluginsDir as untrusted
          const packed = yield* host.packPlugin({
            id: HarnessPluginId.make("packed-demo"),
            name: "Packed Demo",
            version: "1.0.0",
          });
          expect(packed.contentDigest.length).toBe(64);
          const afterPack = yield* host.list();
          expect(afterPack.plugins.find((p) => p.id === "packed-demo")?.trustStatus).toBe(
            "untrusted",
          );
          expect(afterPack.plugins.find((p) => p.id === "claude-compat")).toEqual(claudeView);
          expect((yield* library.getSnapshot()).skills.map((skill) => skill.id)).toContain(
            "claude-helper",
          );
        }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
