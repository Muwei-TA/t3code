// @effect-diagnostics globalFetchInEffect:off nodeBuiltinImport:off -- Integration test verifies raw HTTP Origin rejection, capability checks, Authorization headers, and out-of-process SDK plugin fixtures against live loopback server.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_HARNESS_CAPABILITIES,
  EnvironmentId,
  HarnessHookId,
  HarnessMcpServerId,
  HarnessModeId,
  HarnessPluginId,
  HarnessRuleId,
  HarnessSkillId,
  type OrchestrationV2ServerCommand,
  type RuntimeMode,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NetAddress from "effect/net/NetAddress";
import { HttpRouter, HttpServer } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Workflows from "../workflows/Workflows.ts";
import * as WorkflowRuntime from "../workflows/WorkflowRuntime.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessHooksService from "./HarnessHooksService.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import * as HarnessMemoryStore from "./HarnessMemoryStore.ts";
import * as HarnessMcpHttpServer from "./HarnessMcpHttpServer.ts";
import * as HarnessStore from "./HarnessStore.ts";
import * as McpGateway from "./McpGateway.ts";
import * as PluginHost from "./PluginHost.ts";

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
          modeId: undefined as HarnessModeId | undefined,
          runtimeMode: "full-access" as RuntimeMode,
          worktreePath: null,
          deletedAt: null,
          archivedAt: null,
          activeRunId: activeRunId as RunId | null,
          pendingBackgroundTasks: [],
        };
        let emitsProposedPlan = false;
        let upstreamCalls = 0;

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
                    {
                      name: "read_issue",
                      description: "Reads an issue",
                      inputSchema: { type: "object", properties: {} },
                      annotations: { readOnlyHint: true },
                    },
                  ]),
                callTool: () =>
                  Effect.sync(() => {
                    upstreamCalls++;
                    return { content: [{ type: "text", text: "called" }] };
                  }),
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

        const libraryLayer = HarnessLibraryStore.layer.pipe(Layer.provideMerge(storeLayer));
        const hooksLayer = HarnessHooksService.layer.pipe(Layer.provideMerge(storeLayer));

        const serverLayer = HttpRouter.serve(HarnessMcpHttpServer.layer, {
          disableLogger: true,
        }).pipe(
          Layer.provideMerge(McpSessionRegistry.layer),
          Layer.provideMerge(gatewayLayer),
          Layer.provideMerge(libraryLayer),
          Layer.provideMerge(hooksLayer),
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
              approvalPolicy: "auto-all",
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

          // 3. Plan mode hides the mutating upstream tool.
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
            "harness_skill_search",
            "harness_skill_load",
            "harness_rule_read",
            "workflow_validate",
            "harness_inspect",
            "harness_skill_read_file",
            "tracker__read_issue",
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

          // 9. Portable read-only skill & rule tools work on /mcp/harness even in Plan mode.
          const libStore = yield* HarnessLibraryStore.HarnessLibraryStore;
          yield* libStore.upsertUserSkill({
            id: HarnessSkillId.make("sql-audit"),
            description: "Audit SQL migrations",
            body: "Check indexes and locking.",
          });
          yield* libStore.upsertUserRule({
            id: HarnessRuleId.make("sec-headers"),
            description: "Security headers",
            apply: "manual",
            body: "Always set CSP and HSTS.",
          });

          const listWithLibrary = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }),
            }).then((r) => r.json() as Promise<{ result: { tools: Array<{ name: string }> } }>),
          );
          const listedNames = listWithLibrary.result.tools.map((t) => t.name);
          expect(listedNames).toContain("harness_skill_search");
          expect(listedNames).toContain("harness_skill_load");
          expect(listedNames).toContain("harness_rule_read");

          const searchRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 9,
                method: "tools/call",
                params: { name: "harness_skill_search", arguments: { query: "sql" } },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content: Array<{ text?: string }> };
                }>,
            ),
          );
          expect(searchRes.result.isError).not.toBe(true);
          expect(searchRes.result.content[0]?.text).toContain("sql-audit");

          const loadRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 10,
                method: "tools/call",
                params: { name: "harness_skill_load", arguments: { name: "sql-audit" } },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content: Array<{ text?: string }> };
                }>,
            ),
          );
          expect(loadRes.result.isError).not.toBe(true);
          expect(loadRes.result.content[0]?.text).toContain("Check indexes and locking.");

          const ruleRes = yield* Effect.promise(() =>
            fetch(harnessUrl, {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 11,
                method: "tools/call",
                params: { name: "harness_rule_read", arguments: { id: "sec-headers" } },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content: Array<{ text?: string }> };
                }>,
            ),
          );
          expect(ruleRes.result.isError).not.toBe(true);
          expect(ruleRes.result.content[0]?.text).toContain("Always set CSP and HSTS.");

          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("allowed"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://allowed.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-all",
              allowedTools: [
                TrimmedNonEmptyString.make("read_issue"),
                TrimmedNonEmptyString.make("write_issue"),
              ],
            },
          });
          const callRpc = (method: string, params: Record<string, unknown>) =>
            Effect.promise(() =>
              fetch(harnessUrl, {
                method: "POST",
                headers: { authorization: authHeader, "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 20, method, params }),
              }).then(
                (r) =>
                  r.json() as Promise<{
                    result: {
                      tools?: Array<{ name: string }>;
                      structuredContent?: { tools: Array<{ name: string }> };
                      isError?: boolean;
                      content?: Array<{ text?: string }>;
                    };
                  }>,
              ),
            );
          const callTool = (name: string) => callRpc("tools/call", { name, arguments: {} });
          const toolNames = [
            "allowed__read_issue",
            "allowed__write_issue",
            "tracker__read_issue",
            "tracker__write_issue",
          ];
          for (const [interaction, mode, runtime, permitted] of [
            ["plan", undefined, "full-access", ["allowed__read_issue", "tracker__read_issue"]],
            [
              "default",
              HarnessModeId.make("review"),
              "full-access",
              ["allowed__read_issue", "tracker__read_issue"],
            ],
            ["default", undefined, "approval-required", ["allowed__read_issue"]],
            [
              "default",
              undefined,
              "auto-accept-edits",
              ["allowed__read_issue", "tracker__read_issue"],
            ],
            ["default", undefined, "full-access", toolNames],
          ] as const) {
            mutableShell.interactionMode = interaction;
            mutableShell.modeId = mode;
            mutableShell.runtimeMode = runtime;
            const { result: listed } = yield* callRpc("tools/list", {});
            expect(
              listed.tools
                ?.map((tool) => tool.name)
                .filter((name) => toolNames.includes(name))
                .sort(),
            ).toEqual(permitted);
            const { result: search } = yield* callTool("harness_tool_search");
            expect(search.structuredContent?.tools.map((tool) => tool.name).sort()).toEqual(
              permitted,
            );
            for (const name of toolNames) {
              const { result: called } = yield* callTool(name);
              expect(called.isError === true, `${runtime}/${mode ?? interaction}/${name}`).toBe(
                !permitted.some((toolName) => toolName === name),
              );
            }
          }

          const hooks = yield* HarnessHooksService.HarnessHooksService;
          const hookId = HarnessHookId.make("wait-for-mode-change");
          const pluginId = HarnessPluginId.make("mode-test");
          const entered = Promise.withResolvers<void>();
          const resume = Promise.withResolvers<void>();
          yield* hooks.registerPluginHooks(
            pluginId,
            [
              {
                id: hookId,
                event: "PreToolUse",
                enabled: true,
                matcher: TrimmedNonEmptyString.make("tracker__write_issue"),
                source: "plugin",
                pluginId,
                target: {
                  type: "http",
                  url: TrimmedNonEmptyString.make("https://example.com/hook"),
                },
              },
            ],
            new Map([
              [
                hookId,
                async () => {
                  entered.resolve();
                  await resume.promise;
                  return { ok: true, timedOut: false, durationMs: 0, stdout: "{}" };
                },
              ],
            ]),
          );
          const callsBeforeSwitch = upstreamCalls;
          const pendingCall = yield* callTool("tracker__write_issue").pipe(Effect.forkScoped);
          yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("3 seconds"));
          mutableShell.modeId = HarnessModeId.make("review");
          resume.resolve();
          const afterSwitch = yield* Fiber.join(pendingCall);
          expect(afterSwitch.result.isError).toBe(true);
          expect(afterSwitch.result.content?.[0]?.text).toContain('read-only mode "review"');
          expect(upstreamCalls).toBe(callsBeforeSwitch);
        }).pipe(Effect.provide(serverLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "manages harness assets in Build mode and enforces read-only ceilings and PreToolUse hooks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-creator-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        const threadId = ThreadId.make("thread-creator-http");
        const projectId = ProjectId.make("project-creator-http");
        const providerInstanceId = ProviderInstanceId.make("cursor");
        const activeRunId = RunId.make("run:creator-1");

        const mutableShell = {
          id: threadId,
          projectId,
          providerInstanceId,
          interactionMode: "default" as "plan" | "default",
          modeId: "build" as string | undefined,
          runtimeMode: "full-access" as const,
          worktreePath: null,
          deletedAt: null,
          archivedAt: null,
          activeRunId: activeRunId as RunId | null,
          pendingBackgroundTasks: [],
        };

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
        const hooksLayer = HarnessHooksService.layer.pipe(Layer.provideMerge(storeLayer));
        const pluginHostLayer = PluginHost.layer.pipe(
          Layer.provideMerge(hooksLayer),
          Layer.provideMerge(storeLayer),
        );
        const libraryLayer = HarnessLibraryStore.layer.pipe(
          Layer.provideMerge(pluginHostLayer),
          Layer.provideMerge(storeLayer),
        );
        const gatewayLayer = Layer.effect(
          McpGateway.McpGateway,
          McpGateway.makeWithOptions({}),
        ).pipe(
          Layer.provideMerge(storeLayer),
          Layer.provide(secretStoreLayer),
          Layer.provide(secretResolverLayer),
        );

        const mockEnvLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-creator-test")),
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
                  Effect.succeed({
                    planning: { emitsProposedPlan: false },
                    tools: { supportsMcpTools: true },
                    harness: DEFAULT_HARNESS_CAPABILITIES,
                  }),
              }),
          } as unknown as ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"],
        );

        const mockOrchestratorLayer = Layer.succeed(Orchestrator.OrchestratorV2, {
          dispatch: () => Effect.succeed({ sequence: 1 }),
        } as unknown as Orchestrator.OrchestratorV2["Service"]);

        const serverLayer = HttpRouter.serve(HarnessMcpHttpServer.layer, {
          disableLogger: true,
        }).pipe(
          Layer.provideMerge(McpSessionRegistry.layer),
          Layer.provideMerge(gatewayLayer),
          Layer.provide(
            Layer.effectContext(
              WorkflowRuntime.make(
                Effect.succeed(() => Layer.succeed(Workflows.Workflows, Workflows.off)),
                path.join(tempRoot, "deployment", "ship.yaml"),
                Effect.succeed(false),
              ),
            ),
          ),
          Layer.provideMerge(libraryLayer),
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              listInstances: Effect.succeed([]),
              listUnavailable: Effect.succeed([]),
            }),
          ),
          Layer.provide(mockEnvLayer),
          Layer.provide(mockProjectionLayer),
          Layer.provide(mockProjectLayer),
          Layer.provide(mockAdapterRegistryLayer),
          Layer.provide(mockOrchestratorLayer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const hooks = yield* HarnessHooksService.HarnessHooksService;
          const httpServer = yield* HttpServer.HttpServer;
          const address = httpServer.address;
          if (!NetAddress.isInetAddress(address)) {
            throw new Error("Expected InetAddress in test server");
          }
          const harnessUrl = `http://127.0.0.1:${address.port}/mcp/harness`;
          const issued = yield* registry.issue({
            threadId,
            providerInstanceId,
            capabilities: new Set(["harness"]),
          });
          const authHeader = issued.config.authorizationHeader;

          const callRpc = (id: number, method: string, params: unknown) =>
            Effect.promise(() =>
              fetch(harnessUrl, {
                method: "POST",
                headers: {
                  authorization: authHeader,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
              }).then(
                (r) =>
                  r.json() as Promise<{
                    result: {
                      tools?: Array<{ name: string }>;
                      isError?: boolean;
                      content?: Array<{ text?: string }>;
                    };
                  }>,
              ),
            );

          const buildTools = yield* callRpc(1, "tools/list", {});
          expect(buildTools.result.tools?.map((t) => t.name)).toContain("harness_install_skill");
          const install = {
            name: "harness_install_skill",
            arguments: {
              id: "release-notes",
              scope: "user",
              files: [
                {
                  relativePath: "SKILL.md",
                  content: "---\nname: Release notes\n---\nInstructions",
                },
                { relativePath: "scripts/check.sh", content: "echo ok", executable: true },
              ],
            },
          };
          mutableShell.interactionMode = "plan";
          expect((yield* callRpc(2, "tools/call", install)).result.isError).toBe(true);
          mutableShell.interactionMode = "default";
          expect((yield* callRpc(3, "tools/call", install)).result.isError).not.toBe(true);
          const read = yield* callRpc(4, "tools/call", {
            name: "harness_skill_read_file",
            arguments: { skillId: "release-notes", relativePath: "scripts/check.sh" },
          });
          expect(JSON.parse(read.result.content![0]!.text!)).toMatchObject({
            content: "echo ok",
            executable: true,
          });
          for (const [name, args] of [
            ["harness_manage_command", { id: "ship", body: "Describe release" }],
            [
              "harness_manage_mode",
              { id: "ship", body: "Describe release", baseInteractionMode: "default" },
            ],
            ["harness_manage_rule", { id: "ship", body: "Describe release", apply: "always" }],
            ["harness_manage_rule", { id: "AGENTS.md", body: "Describe release" }],
            [
              "harness_manage_workflow",
              {
                id: "ship",
                yaml: "name: ship\nsteps:\n  - id: draft\n    prompt: Describe release\n",
              },
            ],
          ] as const) {
            for (const action of ["upsert", "delete"]) {
              const output = yield* callRpc(5, "tools/call", {
                name,
                arguments: { ...args, action },
              });
              if (name === "harness_manage_workflow" && action === "delete") {
                expect(output.result.isError).toBe(true);
                expect(output.result.content?.[0]?.text).toContain("alone");
                expect(yield* fs.exists(path.join(tempRoot, "deployment", "ship.yaml"))).toBe(true);
                continue;
              }
              expect(output.result.isError, output.result.content?.[0]?.text).not.toBe(true);
            }
          }
          const proposed = yield* callRpc(6, "tools/call", {
            name: "harness_propose_mcp",
            arguments: {
              id: "proposed",
              config: {
                enabled: true,
                transport: { type: "http", url: "https://example.com/mcp" },
              },
            },
          });
          expect(proposed.result.isError).not.toBe(true);
          const store = yield* HarnessStore.HarnessStore;
          const pending = (yield* store.resolveWorkspace()).servers.find(
            (s) => s.id === "proposed",
          );
          expect(pending).toMatchObject({
            effectiveEnabled: false,
            config: { enabled: false, pendingApproval: true },
          });
          const hook = yield* callRpc(7, "tools/call", {
            name: "harness_propose_hook",
            arguments: {
              id: "proposed",
              event: "PostToolUse",
              enabled: true,
              target: { type: "command", command: "never-executed" },
            },
          });
          expect(hook.result.isError).not.toBe(true);
          expect((yield* hooks.list()).hooks.find((h) => h.id === "proposed")).toMatchObject({
            enabled: false,
            pendingApproval: true,
          });

          const sourceDir = path.join(tempRoot, "portable-plugin");
          yield* fs.makeDirectory(sourceDir);
          yield* fs.writeFileString(
            path.join(sourceDir, "t3-plugin.json"),
            '{"id":"portable","name":"Portable"}',
          );
          const installed = yield* callRpc(8, "tools/call", {
            name: "harness_install_plugin",
            arguments: { sourceDir },
          });
          expect(JSON.parse(installed.result.content![0]!.text!)).toMatchObject({
            id: "portable",
            trustStatus: "untrusted",
            enabled: false,
            contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          });
          const inspected = yield* callRpc(9, "tools/call", {
            name: "harness_inspect",
            arguments: {},
          });
          expect(JSON.parse(inspected.result.content![0]!.text!)).toMatchObject({
            harnessDir: paths.harnessDir,
            deliveryMatrix: [],
            plugins: [{ id: "portable", enabled: false }],
            mcpServers: [{ id: "proposed", effectiveEnabled: false, pendingApproval: true }],
          });

          // Switch thread to Creator Mode: all 4 creator tools are exposed and callable.
          mutableShell.modeId = "creator";
          const creatorTools = yield* callRpc(3, "tools/list", {});
          const creatorNames = (creatorTools.result.tools ?? []).map((t) => t.name);
          expect(creatorNames).toContain("harness_write_skill");
          expect(creatorNames).toContain("harness_create_mode");
          expect(creatorNames).toContain("workflow_validate");
          expect(creatorNames).toContain("plugin_pack");

          const skillWrite = yield* callRpc(4, "tools/call", {
            name: "harness_write_skill",
            arguments: {
              id: "release-checklist",
              description: "Release checklist",
              body: "1. Run tests\n2. Tag release",
            },
          });
          expect(skillWrite.result.isError).not.toBe(true);

          const modeCreate = yield* callRpc(5, "tools/call", {
            name: "harness_create_mode",
            arguments: {
              id: "release-pilot",
              name: "Release Pilot",
              baseInteractionMode: "default",
              body: "Verify changelog before tagging.",
            },
          });
          expect(modeCreate.result.isError).not.toBe(true);

          for (const id of ["review", "release-pilot"]) {
            const overwritten = yield* callRpc(12, "tools/call", {
              name: "harness_create_mode",
              arguments: { id, baseInteractionMode: "default", body: "Replacement" },
            });
            expect(overwritten.result.isError).toBe(true);
          }
          const library = yield* HarnessLibraryStore.HarnessLibraryStore;
          const { modes } = yield* library.getSnapshot();
          expect(modes.find((mode) => mode.id === "review")?.scope).toBe("builtin");
          expect(modes.find((mode) => mode.id === "release-pilot")?.body).toContain(
            "Verify changelog",
          );

          const wfValidate = yield* callRpc(6, "tools/call", {
            name: "workflow_validate",
            arguments: {
              yaml: "name: release-flow\nsteps:\n  - id: check\n    prompt: Verify build\n",
            },
          });
          expect(wfValidate.result.isError).not.toBe(true);
          expect(wfValidate.result.content?.[0]?.text).toContain("Valid workflow");

          const packRes = yield* callRpc(7, "tools/call", {
            name: "plugin_pack",
            arguments: {
              id: "release-kit",
              name: "Release Kit",
              version: "1.0.0",
            },
          });
          expect(packRes.result.isError).not.toBe(true);
          expect(packRes.result.content?.[0]?.text).toContain("sha256:");

          // PreToolUse hook blocks matching tools/call on /mcp/harness.
          yield* hooks.upsertUserHook({
            id: HarnessHookId.make("block-pack"),
            event: "PreToolUse",
            enabled: true,
            matcher: TrimmedNonEmptyString.make("plugin_pack"),
            timeoutMs: PositiveInt.make(2_000),
            failClosed: true,
            target: {
              type: "command",
              command: TrimmedNonEmptyString.make(process.execPath),
              args: [
                "-e",
                'process.stdout.write(JSON.stringify({ allow: false, reason: "Packaging frozen" }))',
              ],
            },
          });

          const blockedByHook = yield* callRpc(8, "tools/call", {
            name: "plugin_pack",
            arguments: {
              id: "release-kit-2",
              name: "Release Kit 2",
              version: "1.0.1",
            },
          });
          expect(blockedByHook.result.isError).toBe(true);
          expect(blockedByHook.result.content?.[0]?.text).toContain("Packaging frozen");
        }).pipe(Effect.provide(serverLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "supports MCP Apps ui:// resource passthrough, portable memory tools, and out-of-process SDK plugin tools over /mcp/harness",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-p4-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        const threadId = ThreadId.make("thread-p4-http");
        const projectId = ProjectId.make("project-p4-http");
        const providerInstanceId = ProviderInstanceId.make("cursor");
        const activeRunId = RunId.make("run:p4-1");

        const mutableShell = {
          id: threadId,
          projectId,
          providerInstanceId,
          interactionMode: "plan" as "plan" | "default",
          modeId: "plan" as string | undefined,
          runtimeMode: "full-access" as const,
          worktreePath: null,
          deletedAt: null,
          archivedAt: null,
          activeRunId: activeRunId as RunId | null,
          pendingBackgroundTasks: [],
        };

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
        const hooksLayer = HarnessHooksService.layer.pipe(Layer.provideMerge(storeLayer));
        const memoryLayer = HarnessMemoryStore.layer.pipe(Layer.provideMerge(storeLayer));
        const pluginHostLayer = PluginHost.layer.pipe(
          Layer.provideMerge(hooksLayer),
          Layer.provideMerge(storeLayer),
        );
        const libraryLayer = HarnessLibraryStore.layer.pipe(
          Layer.provideMerge(pluginHostLayer),
          Layer.provideMerge(storeLayer),
        );
        const gatewayLayer = Layer.effect(
          McpGateway.McpGateway,
          McpGateway.makeWithOptions({
            connect: () =>
              Effect.succeed({
                listTools: () => Effect.succeed([]),
                callTool: () => Effect.succeed({ content: [{ type: "text", text: "ok" }] }),
                listResources: () =>
                  Effect.succeed([
                    {
                      uri: "ui://widgets/kanban",
                      name: "Kanban Board",
                      mimeType: "text/html+mcp",
                    },
                  ]),
                readResource: (uri) =>
                  Effect.succeed({
                    contents: [
                      {
                        uri,
                        mimeType: "text/html+mcp",
                        text: "<html><body>Kanban MCP App</body></html>",
                      },
                    ],
                  }),
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
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-p4-test")),
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
                  Effect.succeed({
                    planning: { emitsProposedPlan: false },
                    tools: { supportsMcpTools: true },
                    harness: DEFAULT_HARNESS_CAPABILITIES,
                  }),
              }),
          } as unknown as ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"],
        );
        const mockOrchestratorLayer = Layer.succeed(Orchestrator.OrchestratorV2, {
          dispatch: () => Effect.succeed({ sequence: 1 }),
        } as unknown as Orchestrator.OrchestratorV2["Service"]);

        const serverLayer = HttpRouter.serve(HarnessMcpHttpServer.layer, {
          disableLogger: true,
        }).pipe(
          Layer.provideMerge(McpSessionRegistry.layer),
          Layer.provideMerge(gatewayLayer),
          Layer.provideMerge(libraryLayer),
          Layer.provideMerge(memoryLayer),
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
          const pluginHost = yield* PluginHost.PluginHost;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const httpServer = yield* HttpServer.HttpServer;
          const address = httpServer.address;
          if (!NetAddress.isInetAddress(address)) {
            throw new Error("Expected InetAddress in test server");
          }
          const harnessUrl = `http://127.0.0.1:${address.port}/mcp/harness`;

          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("boards"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://boards.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });

          // Prepare & install an out-of-process SDK plugin with a read-only tool.
          const pluginSrc = path.join(tempRoot, "sdk-plugin-src");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(pluginSrc, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(pluginSrc, "t3-plugin.json"),
              JSON.stringify({
                id: "greeter",
                name: "Greeter SDK Plugin",
                version: "1.0.0",
                entrypoint: "index.mjs",
              }),
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(pluginSrc, "index.mjs"),
              `import readline from "node:readline";
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
          id: "greeter",
          name: "Greeter SDK Plugin",
          version: "1.0.0",
          tools: [{ name: "greet", description: "Greets a user", inputSchema: { type: "object", properties: { who: { type: "string" } } }, readOnly: true }],
          hooks: [],
          modes: []
        }
      }
    }) + "\\n");
  } else if (req.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text: "Hello " + (req.params?.arguments?.who ?? "world") }] }
    }) + "\\n");
  } else if (req.method === "shutdown") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\\n");
    process.exit(0);
  }
});
`,
              "utf8",
            );
          });

          const installed = yield* pluginHost.install({
            sourcePath: TrimmedNonEmptyString.make(pluginSrc),
          });
          const greeterPlugin = installed.plugins.find((p) => p.id === "greeter");
          expect(greeterPlugin).toBeDefined();
          yield* pluginHost.trust({
            id: HarnessPluginId.make("greeter"),
            expectedDigest: TrimmedNonEmptyString.make(greeterPlugin!.contentDigest),
          });
          const enabledSnap = yield* pluginHost.setEnabled({
            id: HarnessPluginId.make("greeter"),
            enabled: true,
          });
          expect(enabledSnap.plugins.find((p) => p.id === "greeter")?.toolNames).toEqual([
            "plugin__greeter__greet",
          ]);

          const issued = yield* registry.issue({
            threadId,
            providerInstanceId,
            capabilities: new Set(["harness"]),
          });
          const authHeader = issued.config.authorizationHeader;

          const callRpc = (id: number, method: string, params: unknown) =>
            Effect.promise(() =>
              fetch(harnessUrl, {
                method: "POST",
                headers: {
                  authorization: authHeader,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
              }).then((r) => r.json() as Promise<{ result?: Record<string, unknown> }>),
            );

          // 1. initialize advertises resources capability for MCP Apps.
          const initRes = yield* callRpc(1, "initialize", {});
          expect(initRes.result?.capabilities).toMatchObject({
            tools: { listChanged: false },
            resources: { listChanged: false },
          });

          // 2. resources/list & resources/read proxy ui:// MCP Apps cleanly.
          const resList = yield* callRpc(2, "resources/list", {});
          const resources = resList.result?.resources as Array<{ uri: string; name: string }>;
          expect(resources).toEqual([
            {
              uri: "ui://boards/widgets/kanban",
              name: "Kanban Board",
              mimeType: "text/html+mcp",
            },
          ]);
          const resRead = yield* callRpc(3, "resources/read", {
            uri: "ui://boards/widgets/kanban",
          });
          const contents = resRead.result?.contents as Array<{ uri: string; text: string }>;
          expect(contents[0]?.uri).toBe("ui://boards/widgets/kanban");
          expect(contents[0]?.text).toContain("Kanban MCP App");

          // 3. Plan mode blocks harness_memory_write, Default mode allows write + search + read.
          const blockedWrite = yield* callRpc(4, "tools/call", {
            name: "harness_memory_write",
            arguments: { id: "arch", title: "Architecture", body: "Event sourced." },
          });
          expect(blockedWrite.result?.isError).toBe(true);

          mutableShell.interactionMode = "default";
          mutableShell.modeId = "build";
          const writeMem = yield* callRpc(5, "tools/call", {
            name: "harness_memory_write",
            arguments: {
              id: "arch",
              title: "Architecture",
              tags: ["core"],
              body: "Event sourced.",
            },
          });
          expect(writeMem.result?.isError).not.toBe(true);

          const searchMem = yield* callRpc(6, "tools/call", {
            name: "harness_memory_search",
            arguments: { query: "Event" },
          });
          expect(
            (searchMem.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text,
          ).toContain("arch");

          const readMem = yield* callRpc(7, "tools/call", {
            name: "harness_memory_read",
            arguments: { id: "arch" },
          });
          expect(
            (readMem.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text,
          ).toContain("Event sourced.");

          // 4. Out-of-process SDK plugin tool executes via /mcp/harness and disappears after disable.
          const pluginCall = yield* callRpc(8, "tools/call", {
            name: "plugin__greeter__greet",
            arguments: { who: "T3" },
          });
          expect(
            (pluginCall.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text,
          ).toBe("Hello T3");

          yield* pluginHost.setEnabled({
            id: HarnessPluginId.make("greeter"),
            enabled: false,
          });
          expect(pluginHost.listActiveSdkTools()).toEqual([]);
        }).pipe(Effect.provide(serverLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
