// @effect-diagnostics globalFetchInEffect:off -- Integration test verifies raw HTTP Origin rejection, capability checks, and Authorization headers against live loopback server.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_HARNESS_CAPABILITIES,
  EnvironmentId,
  HarnessMcpServerId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NetAddress from "effect/net/NetAddress";
import { HttpRouter, HttpServer } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessMcpHttpServer from "./HarnessMcpHttpServer.ts";
import * as HarnessStore from "./HarnessStore.ts";
import * as McpGateway from "./McpGateway.ts";

describe("HarnessMcpHttpServer", () => {
  it.live(
    "enforces 403 on Origin/missing harness capability, 401 on bad auth, live run ownership, propose_plan guards, and Plan mode read-only gating",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-http-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        const threadId = ThreadId.make("thread-harness-http");
        const projectId = ProjectId.make("project-harness-http");
        const providerInstanceId = ProviderInstanceId.make("cursor");
        const activeRunId = RunId.make("run:active-1");
        const dispatchedCommands: Array<OrchestrationV2ServerCommand> = [];

        const mutableShell = {
          id: threadId,
          projectId,
          providerInstanceId,
          interactionMode: "plan" as "plan" | "default",
          runtimeMode: "full-access" as const,
          worktreePath: null,
          deletedAt: null,
          archivedAt: null,
          activeRunId: activeRunId as RunId | null,
          pendingBackgroundTasks: [],
        };
        let emitsProposedPlan = false;

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

        const gatewayLayer = Layer.effect(
          McpGateway.McpGateway,
          McpGateway.makeWithOptions({
            connect: () =>
              Effect.succeed({
                listTools: () =>
                  Effect.succeed([
                    {
                      name: "write_issue",
                      description: "Mutates an issue",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ]),
                callTool: () => Effect.succeed({ content: [{ type: "text", text: "written" }] }),
                close: () => Effect.void,
                isClosed: () => false,
              }),
          }),
        ).pipe(
          Layer.provideMerge(storeLayer),
          Layer.provide(secretStoreLayer),
          Layer.provide(secretResolverLayer),
        );

        const mockEnvLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-harness-test")),
        } as unknown as ServerEnvironment.ServerEnvironment["Service"]);

        const mockProjectionLayer = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThreadShell: () => Effect.sync(() => ({ ...mutableShell })),
          getThread: () => Effect.sync(() => ({ ...mutableShell })),
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"]);

        const mockProjectLayer = Layer.succeed(ProjectStore.ProjectStoreV2, {
          get: () => Effect.succeedNone,
        } as unknown as ProjectStore.ProjectStoreV2["Service"]);

        const mockAdapterRegistryLayer = Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          {
            get: () =>
              Effect.succeed({
                getCapabilities: () =>
                  Effect.sync(() => ({
                    planning: { emitsProposedPlan },
                    tools: { supportsMcpTools: true },
                    harness: DEFAULT_HARNESS_CAPABILITIES,
                  })),
              }),
          } as unknown as ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"],
        );

        const mockOrchestratorLayer = Layer.succeed(Orchestrator.OrchestratorV2, {
          dispatch: (command: OrchestrationV2ServerCommand) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: 1 };
            }),
        } as unknown as Orchestrator.OrchestratorV2["Service"]);

        const serverLayer = HttpRouter.serve(HarnessMcpHttpServer.layer, {
          disableLogger: true,
        }).pipe(
          Layer.provideMerge(McpSessionRegistry.layer),
          Layer.provideMerge(gatewayLayer),
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(mockEnvLayer),
          Layer.provide(mockProjectionLayer),
          Layer.provide(mockProjectLayer),
          Layer.provide(mockAdapterRegistryLayer),
          Layer.provide(mockOrchestratorLayer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const httpServer = yield* HttpServer.HttpServer;
          const address = httpServer.address;
          if (!NetAddress.isInetAddress(address)) {
            throw new Error("Expected InetAddress in test server");
          }
          const harnessUrl = `http://127.0.0.1:${address.port}/mcp/harness`;

          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("tracker"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://tracker.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });

          // Ordinary t3-code token WITHOUT `"harness"` capability MUST be rejected with 403!
          const plainToken = yield* registry.issue({
            threadId,
            providerInstanceId,
          });
          const noCapRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: plainToken.config.authorizationHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
            }),
          );
          expect(noCapRes.status).toBe(403);

          // Token explicitly granted `"harness"` capability is accepted.
          const issued = yield* registry.issue({
            threadId,
            providerInstanceId,
            capabilities: new Set(["harness"]),
          });
          const authHeader = issued.config.authorizationHeader;

          // 1. Browser Origin must be refused with 403 even with valid harness token.
          const originRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                origin: "https://evil.example.com",
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
            }),
          );
          expect(originRes.status).toBe(403);

          // 2. Missing/invalid bearer token must fail with 401.
          const unauthRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
            }),
          );
          expect(unauthRes.status).toBe(401);

          // 3. Valid tools/list exposes propose_plan and tracker__write_issue.
          const listRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
            }).then((r) => r.json() as Promise<{ result: { tools: Array<{ name: string }> } }>),
          );
          expect(listRes.result.tools.map((t) => t.name)).toEqual([
            "propose_plan",
            "tracker__write_issue",
          ]);

          // 4. Calling propose_plan in active Plan mode dispatches plan.propose bound to activeRunId + providerInstanceId.
          const planRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                  name: "propose_plan",
                  arguments: { markdown: "# Upgrade Plan\n\n1. Ship P0" },
                },
              }),
            }).then((r) => r.json() as Promise<{ result: { isError?: boolean } }>),
          );
          expect(planRes.result.isError).not.toBe(true);
          expect(dispatchedCommands).toHaveLength(1);
          expect(dispatchedCommands[0]).toMatchObject({
            type: "plan.propose",
            threadId,
            runId: activeRunId,
            providerInstanceId,
            markdown: "# Upgrade Plan\n\n1. Ship P0",
          });

          // 5. Direct propose_plan call in Default mode MUST be refused without dispatching!
          mutableShell.interactionMode = "default";
          const planDefaultRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: {
                  name: "propose_plan",
                  arguments: { markdown: "# Sneaky Default Plan" },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content: Array<{ text?: string }> };
                }>,
            ),
          );
          expect(planDefaultRes.result.isError).toBe(true);
          expect(dispatchedCommands).toHaveLength(1);

          // 6. Direct propose_plan call on native-plan provider MUST be refused without dispatching!
          mutableShell.interactionMode = "plan";
          emitsProposedPlan = true;
          const planNativeRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 5,
                method: "tools/call",
                params: {
                  name: "propose_plan",
                  arguments: { markdown: "# Native Provider Plan" },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content: Array<{ text?: string }> };
                }>,
            ),
          );
          expect(planNativeRes.result.isError).toBe(true);
          expect(dispatchedCommands).toHaveLength(1);
          emitsProposedPlan = false;

          // 7. Calling any tool when there is NO active run MUST be refused!
          mutableShell.activeRunId = null;
          const idleCallRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 6,
                method: "tools/call",
                params: { name: "propose_plan", arguments: { markdown: "# Stale Run" } },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content: Array<{ text?: string }> };
                }>,
            ),
          );
          expect(idleCallRes.result.isError).toBe(true);
          expect(idleCallRes.result.content[0]?.text).toContain("active thread run");
          mutableShell.activeRunId = activeRunId;

          // 8. Calling mutating tool in Plan mode is blocked at the gateway.
          const mutateRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 7,
                method: "tools/call",
                params: { name: "tracker__write_issue", arguments: {} },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content: Array<{ text?: string }> };
                }>,
            ),
          );
          expect(mutateRes.result.isError).toBe(true);
          expect(mutateRes.result.content[0]?.text).toContain("Plan mode");
        }).pipe(Effect.provide(serverLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
