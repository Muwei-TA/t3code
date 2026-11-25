import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_HARNESS_CAPABILITIES,
  HarnessCommandId,
  HarnessError,
  HarnessMcpServerId,
  HarnessRuleId,
  HarnessSkillId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessContextService from "./HarnessContextService.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import * as HarnessStore from "./HarnessStore.ts";
import * as McpGateway from "./McpGateway.ts";

describe("HarnessContextService", () => {
  it.effect(
    "builds on-demand ThreadContextManifest with honest native vs advisory Plan enforcement and MCP routing channels",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-ctx-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        const piThreadId = ThreadId.make("thread-pi-plan");
        const openCodeThreadId = ThreadId.make("thread-opencode-plan");
        const codexThreadId = ThreadId.make("thread-codex-default");
        const projectId = ProjectId.make("project-ctx");

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

        const secretStoreLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, {
          get: () => Effect.succeed(Option.none<Uint8Array>()),
        } as unknown as ServerSecretStore.ServerSecretStore["Service"]);

        const secretResolverLayer = Layer.succeed(SecretResolver.SecretResolver, {
          read: () => Effect.succeed([]),
        } as unknown as SecretResolver.SecretResolver["Service"]);

        const storeLayer = HarnessStore.layer.pipe(
          Layer.provideMerge(configLayer),
          Layer.provideMerge(policyLayer),
          Layer.provideMerge(T3ProjectFileLoader.layer),
          Layer.provideMerge(NodeServices.layer),
        );

        const gatewayLayer = Layer.effect(McpGateway.McpGateway, McpGateway.makeWithOptions()).pipe(
          Layer.provideMerge(storeLayer),
          Layer.provide(secretStoreLayer),
          Layer.provide(secretResolverLayer),
        );

        const threadsById = new Map<
          ThreadId,
          {
            readonly id: ThreadId;
            readonly projectId: ProjectId;
            readonly providerInstanceId: ProviderInstanceId;
            readonly interactionMode: "default" | "plan";
            readonly worktreePath: string | null;
          }
        >([
          [
            piThreadId,
            {
              id: piThreadId,
              projectId,
              providerInstanceId: ProviderInstanceId.make("pi"),
              interactionMode: "plan",
              worktreePath: null,
            },
          ],
          [
            openCodeThreadId,
            {
              id: openCodeThreadId,
              projectId,
              providerInstanceId: ProviderInstanceId.make("opencode"),
              interactionMode: "plan",
              worktreePath: null,
            },
          ],
          [
            codexThreadId,
            {
              id: codexThreadId,
              projectId,
              providerInstanceId: ProviderInstanceId.make("codex"),
              interactionMode: "default",
              worktreePath: null,
            },
          ],
        ]);

        const mockProjectionLayer = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThread: (id: ThreadId) => {
            const thread = threadsById.get(id);
            return thread
              ? Effect.succeed(thread)
              : Effect.fail(new HarnessError({ code: "not_found", detail: "not found" }));
          },
          getThreadRecords: () => Effect.succeed({ providerTurns: [] }),
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"]);

        const mockProjectLayer = Layer.succeed(ProjectStore.ProjectStoreV2, {
          get: () => Effect.succeedNone,
        } as unknown as ProjectStore.ProjectStoreV2["Service"]);

        const mockAdapterRegistryLayer = Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          {
            get: (instanceId: ProviderInstanceId) => {
              if (instanceId === "codex") {
                return Effect.succeed({
                  getCapabilities: () =>
                    Effect.succeed({
                      planning: { emitsProposedPlan: true },
                      tools: { supportsMcpTools: true },
                      runtimePolicy: { enforcement: "native" },
                      harness: {
                        ...DEFAULT_HARNESS_CAPABILITIES,
                        mcpPassthrough: "stdio+http",
                        planReadOnlyEnforcement: "native",
                      },
                    }),
                });
              }
              if (instanceId === "opencode") {
                return Effect.succeed({
                  getCapabilities: () =>
                    Effect.succeed({
                      planning: { emitsProposedPlan: false },
                      tools: { supportsMcpTools: true },
                      runtimePolicy: { enforcement: "native" },
                      harness: {
                        ...DEFAULT_HARNESS_CAPABILITIES,
                        mcpPassthrough: "http",
                        planReadOnlyEnforcement: "native",
                      },
                    }),
                });
              }
              return Effect.succeed({
                getCapabilities: () =>
                  Effect.succeed({
                    planning: { emitsProposedPlan: false },
                    tools: { supportsMcpTools: true },
                    runtimePolicy: { enforcement: "client-boundary" },
                    harness: {
                      ...DEFAULT_HARNESS_CAPABILITIES,
                      mcpPassthrough: "none",
                      planReadOnlyEnforcement: "advisory",
                    },
                  }),
              });
            },
          } as unknown as ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"],
        );

        const libraryLayer = HarnessLibraryStore.layer.pipe(Layer.provideMerge(storeLayer));

        const serviceLayer = HarnessContextService.layer.pipe(
          Layer.provideMerge(gatewayLayer),
          Layer.provideMerge(libraryLayer),
          Layer.provide(mockProjectionLayer),
          Layer.provide(mockProjectLayer),
          Layer.provide(mockAdapterRegistryLayer),
        );

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const contextService = yield* HarnessContextService.HarnessContextService;

          // With zero MCP servers, Codex default mode has gateway inactive.
          const emptyCodex = yield* contextService.getThreadContextManifest(codexThreadId);
          expect(emptyCodex.harnessGatewayActive).toBe(false);
          expect(emptyCodex.planModeSource).toBe("native");
          expect(emptyCodex.planModeReadOnlyEnforcement).toBe("native");
          expect(emptyCodex.degradedItems).toEqual([]);

          // Add a native-requested HTTP MCP server to verify passthrough vs gateway degradation.
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("linear"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://mcp.linear.app/mcp" },
              injectionMode: "native",
              approvalPolicy: "auto-read",
            },
          });

          // Pi in Plan mode: harness-propose-plan + advisory warning + linear falls back to gateway.
          const piManifest = yield* contextService.getThreadContextManifest(piThreadId);
          expect(piManifest.planModeSource).toBe("harness-propose-plan");
          expect(piManifest.planModeReadOnlyEnforcement).toBe("advisory");
          expect(piManifest.harnessGatewayActive).toBe(true);
          expect(piManifest.mcpServers.find((s) => s.id === "linear")?.channel).toBe("gateway");
          expect(piManifest.degradedItems.some((item) => item.kind === "plan")).toBe(true);
          expect(
            piManifest.degradedItems.some((item) => item.kind === "mcp" && item.id === "linear"),
          ).toBe(true);

          // OpenCode in Plan mode: harness-propose-plan + native read-only + native HTTP passthrough.
          const openCodeManifest = yield* contextService.getThreadContextManifest(openCodeThreadId);
          expect(openCodeManifest.planModeSource).toBe("harness-propose-plan");
          expect(openCodeManifest.planModeReadOnlyEnforcement).toBe("native");
          expect(openCodeManifest.harnessGatewayActive).toBe(true);
          expect(openCodeManifest.mcpServers.find((s) => s.id === "linear")?.channel).toBe(
            "native",
          );
          expect(openCodeManifest.degradedItems.some((item) => item.kind === "plan")).toBe(false);

          // Add portable skill, rule, and custom command and confirm v1 manifest fields populate.
          const libStore = yield* HarnessLibraryStore.HarnessLibraryStore;
          yield* libStore.upsertUserSkill({
            id: HarnessSkillId.make("review-helper"),
            description: "Code review checklist",
            body: "Verify edge cases.",
          });
          yield* libStore.upsertUserRule({
            id: HarnessRuleId.make("always-short"),
            apply: "always",
            body: "Keep PR diffs focused.",
          });
          yield* libStore.upsertUserCommand({
            id: HarnessCommandId.make("ship"),
            body: "Check status and run tests.",
          });

          const codexWithLibrary = yield* contextService.getThreadContextManifest(codexThreadId);
          expect(codexWithLibrary.modeId).toBe("build");
          expect(codexWithLibrary.modeName).toBe("Build");
          expect(codexWithLibrary.modeReadOnly).toBe(false);
          expect(codexWithLibrary.approvalRulesCount).toBe(0);
          expect(codexWithLibrary.skills.some((s) => s.id === "review-helper")).toBe(true);
          expect(codexWithLibrary.rules.find((r) => r.id === "always-short")?.status).toBe(
            "inlined",
          );
          expect(codexWithLibrary.commandsCount).toBe(1);
          expect(codexWithLibrary.contextBudgetBytes).toBeGreaterThan(0);
          expect(codexWithLibrary.contextUsedBytes).toBeGreaterThan(0);
          expect(codexWithLibrary.scaffoldBytes).toBeGreaterThan(0);
        }).pipe(Effect.provide(serviceLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
