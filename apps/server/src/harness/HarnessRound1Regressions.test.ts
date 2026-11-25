// @effect-diagnostics nodeBuiltinImport:off -- Creates temporary directories and symlinks to verify Round 1 security, mode, plugin, workflow, and budget fixes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_HARNESS_CAPABILITIES,
  HarnessMcpServerId,
  HarnessMemoryId,
  HarnessModeId,
  HarnessPluginId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkflowRuntime from "../workflows/WorkflowRuntime.ts";
import { compileDeclarativeWorkflowToDefinition } from "./DeclarativeWorkflowCompiler.ts";
import * as HarnessHooksService from "./HarnessHooksService.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import * as HarnessMemoryStore from "./HarnessMemoryStore.ts";
import { projectHarnessContext } from "./HarnessProjector.ts";
import * as HarnessStore from "./HarnessStore.ts";
import { checkHarnessRuntimeToolCeiling, rewriteMcpAppMeta } from "./McpGateway.ts";
import * as PluginHost from "./PluginHost.ts";

function makeBaseLayers(baseDir: string, paths: ServerConfig.ServerDerivedPaths) {
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
  const hooksLayer = HarnessHooksService.layer.pipe(Layer.provideMerge(storeLayer));
  const pluginLayer = PluginHost.layer.pipe(
    Layer.provideMerge(hooksLayer),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, "darwin")),
  );
  const libraryLayer = HarnessLibraryStore.layer.pipe(Layer.provideMerge(pluginLayer));
  const memoryLayer = HarnessMemoryStore.layer.pipe(Layer.provideMerge(storeLayer));
  return Layer.mergeAll(libraryLayer, memoryLayer, pluginLayer, hooksLayer, storeLayer);
}

describe("Portable Harness Round 1 Regressions", () => {
  it("P0-3: enforces supervised runtime ceiling uniformly for mutating and approval-required tools", () => {
    expect(
      checkHarnessRuntimeToolCeiling({
        toolName: "harness_memory_write",
        interactionMode: "default",
        runtimeMode: "auto-accept-edits",
        readOnly: false,
      }),
    ).toContain("auto-accept-edits");

    expect(
      checkHarnessRuntimeToolCeiling({
        toolName: "harness_write_skill",
        interactionMode: "default",
        runtimeMode: "approval-required",
        readOnly: false,
      }),
    ).toContain("approval-required");

    expect(
      checkHarnessRuntimeToolCeiling({
        toolName: "plugin__demo__read_data",
        interactionMode: "default",
        runtimeMode: "approval-required",
        readOnly: true,
      }),
    ).toContain("Approval-required");

    expect(
      checkHarnessRuntimeToolCeiling({
        toolName: "harness_memory_write",
        interactionMode: "default",
        runtimeMode: "full-access",
        activeMode: { id: HarnessModeId.make("review"), readonly: true },
        readOnly: false,
      }),
    ).toContain('read-only mode "review"');

    expect(
      checkHarnessRuntimeToolCeiling({
        toolName: "harness_memory_write",
        interactionMode: "default",
        runtimeMode: "full-access",
        readOnly: false,
      }),
    ).toBeNull();
  });

  it("P1-7: rewrites MCP Apps _meta.ui.resourceUri and legacy ui/resourceUri to canonical gateway URIs", () => {
    const serverId = HarnessMcpServerId.make("chart-app");
    const rewritten = rewriteMcpAppMeta(serverId, {
      ui: { resourceUri: "ui://dashboard/main.html", height: 420 },
      "ui/resourceUri": "ui://dashboard/legacy.html",
      other: true,
    });
    expect(rewritten).toEqual({
      ui: { resourceUri: "ui://chart-app/dashboard/main.html", height: 420 },
      "ui/resourceUri": "ui://chart-app/dashboard/legacy.html",
      other: true,
    });
  });

  it("P1-9: strictly enforces total contextUsedBytes <= maxSystemContextBytes including scaffold and separators", () => {
    const bigBody = "Rule content line.\n".repeat(45);
    const library = {
      harnessDir: "/tmp/harness",
      userAgentsMd: {
        scope: "user" as const,
        path: "/tmp/harness/AGENTS.md",
        exists: true,
        body: bigBody,
        contentDigest: "digest-agents",
        bytes: NonNegativeInt.make(Buffer.byteLength(bigBody, "utf8")),
      },
      projectAgentsMd: null,
      skills: [],
      rules: [1, 2, 3, 4].map((n) => ({
        id: `rule-${n}` as never,
        scope: "user" as const,
        apply: "always" as const,
        globs: [],
        body: bigBody,
        sourcePath: `/tmp/harness/rules/rule-${n}.md`,
        contentDigest: `digest-${n}`,
        bytes: NonNegativeInt.make(Buffer.byteLength(bigBody, "utf8")),
        enabled: true,
        effectiveEnabled: true,
        overriddenByProject: false,
      })),
      commands: [],
      modes: [],
      maxSystemContextBytes: NonNegativeInt.make(3000) as never,
      managedPolicyAllowsHarness: true,
      managedPolicyOrganization: null,
    };

    const projected = projectHarnessContext({
      library,
      harnessCapabilities: {
        ...DEFAULT_HARNESS_CAPABILITIES,
        maxSystemContextBytes: 3600,
      },
      supportsMcpTools: true,
    });

    expect(projected.contextUsedBytes).toBeLessThanOrEqual(3000);
    for (const seg of projected.segments) {
      expect(seg.bytes).toBeLessThanOrEqual(3600);
    }
  });

  it.effect(
    "P0-5 & P2-2: HarnessMemoryStore rejects symlink escapes and supports Chinese/Unicode search",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-r1-memory-" });
        const baseDir = path.join(tempRoot, "t3home");
        const outsideFile = path.join(tempRoot, "outside.txt");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        yield* Effect.promise(() => NodeFSP.writeFile(outsideFile, "secret outside", "utf8"));

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const memory = yield* HarnessMemoryStore.HarnessMemoryStore;

          // P2-2: Chinese & mixed CJK/English search
          yield* memory.upsertMemory({
            id: HarnessMemoryId.make("deploy-zh"),
            title: TrimmedNonEmptyString.make("生产环境发布手册"),
            tags: [TrimmedNonEmptyString.make("运维")],
            body: "部署前先检查数据库连接池和 Cloudflare 队列。",
          });
          yield* memory.upsertMemory({
            id: HarnessMemoryId.make("other-en"),
            title: TrimmedNonEmptyString.make("English Only Note"),
            body: "Unrelated frontend styling tips.",
          });

          const zhMatches = yield* memory.searchMemory({ query: "生产环境" });
          expect(zhMatches.map((m) => m.id)).toEqual(["deploy-zh"]);

          const mixedMatches = yield* memory.searchMemory({ query: "Cloudflare 数据库" });
          expect(mixedMatches.map((m) => m.id)).toEqual(["deploy-zh"]);

          // P0-5: Symlink escape on note file must be rejected without modifying outsideFile
          const symlinkTarget = NodePath.join(store.harnessDir, "memory", "escape-note.md");
          yield* Effect.promise(() => NodeFSP.symlink(outsideFile, symlinkTarget));

          const writeEscape = yield* memory
            .upsertMemory({
              id: HarnessMemoryId.make("escape-note"),
              title: TrimmedNonEmptyString.make("Escape"),
              body: "overwritten!",
            })
            .pipe(Effect.result);
          expect(Result.isFailure(writeEscape)).toBe(true);
          const outsideAfter = yield* Effect.promise(() => NodeFSP.readFile(outsideFile, "utf8"));
          expect(outsideAfter).toBe("secret outside");
        }).pipe(Effect.provide(makeBaseLayers(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "P1-9: HarnessLibraryStore.getRuleDetail resolves overflowing declarative modes via mode:<id>",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-r1-mode-read-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        yield* Effect.gen(function* () {
          const lib = yield* HarnessLibraryStore.HarnessLibraryStore;
          const detail = yield* lib.getRuleDetail({ id: "mode:review" });
          expect(Option.isSome(detail)).toBe(true);
          if (Option.isSome(detail)) {
            expect(detail.value.id).toBe("mode:review");
            expect(detail.value.body.length).toBeGreaterThan(0);
          }
        }).pipe(Effect.provide(makeBaseLayers(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "P1-4: WorkflowRuntime.loadDefinitions compiles and registers declarative .yaml workflows",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-r1-yaml-wf-" });
        const yamlPath = path.join(tempRoot, "release-check.yaml");
        const yamlContent = [
          "name: release-check",
          "version: 1",
          "steps:",
          "  - id: audit",
          "    kind: in-thread",
          "    modeId: review",
          "    prompt: Audit the diff.",
          "    timeoutSeconds: 120",
          "    onFailure: continue",
          "  - id: verify",
          "    kind: child",
          "    dependsOn: [audit]",
          "    prompt: Run tests in child thread.",
          "    onFailure: fail",
        ].join("\n");

        yield* Effect.promise(() => NodeFSP.writeFile(yamlPath, yamlContent, "utf8"));

        const compiled = compileDeclarativeWorkflowToDefinition(yamlContent);
        expect(compiled.ok).toBe(true);
        if (compiled.ok) {
          expect(compiled.validation.compiledPreview).toContain('T3.workflow(\n  "release-check"');
          expect(compiled.validation.compiledPreview).toContain("T3.agent.try");
          expect(compiled.validation.compiledPreview).toContain("T3.stop");
        }

        const loaded = yield* WorkflowRuntime.loadDefinitions(yamlPath);
        expect(loaded).toHaveLength(1);
        expect(loaded[0]?.name).toBe("release-check");
        expect(loaded[0]?.version).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "P0-4, P1-5, P1-6: PluginHost wires SDK hooks, flags executable plugins, and keeps list() read-only",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-r1-sdk-plugin-" });
        const baseDir = path.join(tempRoot, "t3home");
        const pluginSrc = path.join(tempRoot, "sdk-hook-plugin");
        const spawnCounterFile = path.join(tempRoot, "spawn-count.txt");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        // Build a minimal out-of-process JSON-RPC SDK plugin that declares a blocking turn.beforeStart hook
        // and appends a line to spawnCounterFile each time it starts.
        const entryScript = `
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(spawnCounterFile)}, "spawn\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "1",
        plugin: {
          id: "sdk-guard",
          name: "SDK Guard",
          version: "1.0.0",
          tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} }, readOnly: true }],
          hooks: [{ id: "block-secret", event: "turn.beforeStart", failClosed: true }],
          modes: []
        }
      }
    }) + "\\n");
  } else if (req.method === "hooks/run") {
    const text = String(req.params?.payload?.text ?? "");
    const blocked = text.includes("FORBIDDEN_TOKEN");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: blocked ? { block: true, reason: "Blocked by SDK hook" } : { allow: true }
    }) + "\\n");
  } else if (req.method === "shutdown") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\\n");
    process.exit(0);
  }
});
`;

        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(pluginSrc, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(pluginSrc, "t3-plugin.json"),
            JSON.stringify({
              id: "sdk-guard",
              name: "SDK Guard",
              version: "1.0.0",
              entrypoint: "index.cjs",
            }),
            "utf8",
          );
          await NodeFSP.writeFile(NodePath.join(pluginSrc, "index.cjs"), entryScript, "utf8");
        });

        yield* Effect.gen(function* () {
          const pluginHost = yield* PluginHost.PluginHost;
          const hooksService = yield* HarnessHooksService.HarnessHooksService;

          // P0-4: Executable SDK plugin must report requiresTerminalOperate = true
          const risk = yield* pluginHost.inspectExecutableRisk({
            kind: "sourcePath",
            sourcePath: pluginSrc,
          });
          expect(risk.requiresTerminalOperate).toBe(true);

          const installed = yield* pluginHost.install({
            sourcePath: TrimmedNonEmptyString.make(pluginSrc),
            trustOnInstall: true,
          });
          const view = installed.plugins.find((p) => p.id === "sdk-guard");
          expect(view?.active).toBe(true);
          expect(view?.hookIds).toContain("sdk-guard.block-secret");

          // P1-6: Calling list() repeatedly must NOT respawn the plugin process!
          yield* pluginHost.list();
          yield* pluginHost.list();
          const spawnLines = yield* Effect.promise(() =>
            NodeFSP.readFile(spawnCounterFile, "utf8").then((s) => s.trim().split("\n")),
          );
          expect(spawnLines).toHaveLength(1);

          // P1-5: SDK hook executes through HarnessHooksService!
          const blockedOutcome = yield* hooksService.runBeforeTurnStart({
            threadId: "thread-1",
            modeId: "build",
            text: "please send FORBIDDEN_TOKEN",
          });
          expect(blockedOutcome.blocked).toBe(true);
          expect(blockedOutcome.blockReason).toBe("Blocked by SDK hook");

          const allowedOutcome = yield* hooksService.runBeforeTurnStart({
            threadId: "thread-1",
            modeId: "build",
            text: "normal request",
          });
          expect(allowedOutcome.blocked).toBe(false);

          // Disabling plugin cleans up its SDK hook cleanly via Scope.
          yield* pluginHost.setEnabled({
            id: HarnessPluginId.make("sdk-guard"),
            enabled: false,
          });
          const afterDisable = yield* hooksService.runBeforeTurnStart({
            threadId: "thread-1",
            modeId: "build",
            text: "please send FORBIDDEN_TOKEN",
          });
          expect(afterDisable.blocked).toBe(false);
        }).pipe(Effect.provide(makeBaseLayers(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
