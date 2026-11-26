// @effect-diagnostics processEnvInEffect:off -- Test sets and restores process.env.OPENAI_API_KEY to verify stdio child env stripping.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_HARNESS_CAPABILITIES,
  HARNESS_SECRET_REDACTED,
  HarnessError,
  HarnessMcpServerId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessApprovalAuditStore from "./HarnessApprovalAuditStore.ts";
import { buildSafeStdioBaseEnv, harnessLocalSecretKey } from "./HarnessSecrets.ts";
import * as HarnessStore from "./HarnessStore.ts";
import * as McpGateway from "./McpGateway.ts";
import { connectUpstream, RingLogBuffer } from "./McpUpstreamClient.ts";

// Minimal stdio MCP server running under the current Node binary for deterministic real-process tests.
const ECHO_STDIO_MCP_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
process.stderr.write("echo-mcp booting token=" + (process.env.MY_TOKEN ?? "") + " Bearer raw-leak-999\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } }
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          { name: "read_env", description: "Read injected env", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
          { name: "mutate_item", description: "Mutating write tool", inputSchema: { type: "object", properties: { value: { type: "string" } } } }
        ]
      }
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    if (msg.params.name === "read_env") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              injected: process.env.MY_TOKEN ?? null,
              leakedOpenAi: process.env.OPENAI_API_KEY ?? null
            })
          }]
        }
      }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: "mutated:" + String(msg.params.arguments?.value ?? "") }] }
    }) + "\\n");
  }
});
`;

const makeGatewayTestLayer = (
  baseDir: string,
  paths: ServerConfig.ServerDerivedPaths,
  options?: McpGateway.McpGatewayOptions & {
    readonly secrets?: Readonly<Record<string, string>>;
  },
) => {
  const secretsMap = options?.secrets ?? {};

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
    get: (name: string) =>
      Effect.succeed(
        secretsMap[name] !== undefined
          ? Option.some(new TextEncoder().encode(secretsMap[name]))
          : Option.none<Uint8Array>(),
      ),
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
    McpGateway.makeWithOptions(options),
  ).pipe(
    Layer.provideMerge(HarnessApprovalAuditStore.layer),
    Layer.provideMerge(storeLayer),
    Layer.provide(secretStoreLayer),
    Layer.provide(secretResolverLayer),
  );

  return gatewayLayer;
};

describe("McpGateway", () => {
  it.effect("executes gateway approvals once, for a session, or until revocation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      let executions = 0;
      const connect: typeof connectUpstream = () =>
        Effect.succeed({
          listTools: () => Effect.succeed([{ name: "write", inputSchema: { type: "object" } }]),
          callTool: () =>
            Effect.sync(() => {
              executions += 1;
              return { content: [{ type: "text", text: "ran" }] };
            }),
          close: () => Effect.void,
          isClosed: () => false,
        });
      yield* Effect.gen(function* () {
        const store = yield* HarnessStore.HarnessStore;
        const gateway = yield* McpGateway.McpGateway;
        const audit = yield* HarnessApprovalAuditStore.HarnessApprovalAuditStore;
        const id = HarnessMcpServerId.make("approval");
        const config = {
          enabled: true,
          transport: { type: "http", url: "https://fixture.example/mcp" },
          injectionMode: "gateway",
          approvalPolicy: "always-ask",
        } as const;
        yield* store.upsertUserServer({ id, config });
        const threadId = ThreadId.make("approval-thread");
        const nativeSession = ProviderSessionId.make("session-1");
        const project = baseDir;
        let approvals = 0;
        let decision: ProviderApprovalDecision = "decline";
        const context = {
          providerSessionId: "gateway-credential",
          workspaceRoot: project,
          interactionMode: "default",
          runtimeMode: "approval-required",
          includeProposePlan: false,
          deferredExposure: false,
          approval: {
            threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: nativeSession,
            request: () =>
              Effect.sync(() => {
                approvals += 1;
                return {
                  decision,
                  ...(decision === "decline" ? { feedback: "Try reading first." } : {}),
                };
              }),
          },
        } satisfies McpGateway.GatewaySessionContext;
        const invoke = (current: McpGateway.GatewaySessionContext = context) =>
          gateway.callToolForSession({
            context: current,
            toolName: "approval__write",
            arguments: {},
          });
        expect(
          (yield* gateway.listToolsForSession(context)).map((tool) => tool.exposedName),
        ).toContain("approval__write");
        const denied = yield* invoke();
        expect(denied.isError).toBe(true);
        expect(denied.content).toEqual([
          { type: "text", text: "User denied the MCP tool call: Try reading first." },
        ]);
        expect(executions).toBe(0);

        decision = "accept";
        yield* invoke();
        yield* invoke();
        expect(approvals).toBe(3);
        expect(executions).toBe(2);
        expect(yield* audit.list()).toEqual([]);

        decision = "acceptForSession";
        yield* invoke();
        yield* invoke();
        expect(approvals).toBe(4);
        expect(executions).toBe(4);
        const newSession = {
          ...context,
          approval: { ...context.approval, providerSessionId: ProviderSessionId.make("session-2") },
        };
        decision = "acceptAlways";
        yield* invoke(newSession);
        expect(approvals).toBe(5);
        yield* invoke(newSession);
        expect(approvals).toBe(5);
        expect(executions).toBe(6);
        const grant = (yield* audit.list()).find((rule) => rule.scope === "always")!;
        expect(grant.source).toBe("gateway");
        expect(grant.target).toMatchObject({ serverId: id, toolName: "write" });

        const inPlan = yield* invoke({ ...newSession, interactionMode: "plan" });
        expect(inPlan.isError).toBe(true);
        expect(executions).toBe(6);
        expect(approvals).toBe(5);
        yield* audit.revoke(grant.id);
        decision = "decline";
        yield* invoke(newSession);
        expect(approvals).toBe(6);
        expect(executions).toBe(6);

        yield* store.upsertUserServer({ id, config: { ...config, description: "Changed" } });
        yield* invoke(context);
        expect(approvals).toBe(7);
        expect(executions).toBe(6);

        const stale = yield* invoke({
          ...context,
          approval: {
            ...context.approval,
            request: () =>
              store
                .upsertUserServer({
                  id,
                  config: { ...config, description: "Changed while awaiting approval" },
                })
                .pipe(Effect.as({ decision: "accept" as const })),
          },
        }).pipe(Effect.flip);
        expect(stale.code).toBe("invalid_config");
        expect(executions).toBe(6);
      }).pipe(Effect.provide(makeGatewayTestLayer(baseDir, paths, { connect })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("strips ambient API credentials from stdio base environment", () => {
    const safe = buildSafeStdioBaseEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      T3CODE_AUTH_TOKEN: "t3-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    });
    expect(safe.PATH).toBe("/usr/bin");
    expect(safe.HOME).toBe("/tmp/home");
    expect(safe.OPENAI_API_KEY).toBeUndefined();
    expect(safe.ANTHROPIC_API_KEY).toBeUndefined();
    expect(safe.T3CODE_AUTH_TOKEN).toBeUndefined();
    expect(safe.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it.live(
    "isolates harness secret namespace, redacts snapshots & logs, enforces approvalPolicy + runtimeMode ceiling, and supports __ in server IDs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-gateway-stdio-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        const priorOpenAiKey = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = "sk-should-never-leak";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (priorOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = priorOpenAiKey;
          }),
        );

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const gateway = yield* McpGateway.McpGateway;

          // Server with `__` in its own ID to verify unambiguous tool-name routing (P2).
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("my__echo"),
            config: {
              enabled: true,
              transport: {
                type: "stdio",
                command: process.execPath,
                args: ["-e", ECHO_STDIO_MCP_SCRIPT],
                env: {
                  MY_TOKEN: "${secret:ECHO_SECRET}",
                  LITERAL_KEY: "super-literal-secret",
                },
              },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });

          // Server attempting to read an un-prefixed internal ServerSecretStore key MUST fail!
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("steal_internal"),
            config: {
              enabled: true,
              transport: {
                type: "stdio",
                command: process.execPath,
                args: ["-e", ECHO_STDIO_MCP_SCRIPT],
                env: {
                  MY_TOKEN: "${secret:auth-signing-key}",
                },
              },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });

          // Passive snapshot must NOT spawn stdio and MUST redact literal env values while keeping placeholders.
          const passive = yield* gateway.getSnapshot();
          const echoView = passive.servers.find((s) => s.id === "my__echo");
          expect(echoView?.state).toBe("idle");
          expect(echoView?.toolCount).toBe(0);
          expect(
            echoView?.config.transport.type === "stdio" ? echoView.config.transport.env : undefined,
          ).toEqual({
            MY_TOKEN: "${secret:ECHO_SECRET}",
            LITERAL_KEY: HARNESS_SECRET_REDACTED,
          });

          // Calling steal_internal fails with Missing secrets because `auth-signing-key` is outside harness namespace.
          const internalAttempt = yield* gateway
            .callToolForSession({
              context: {
                providerSessionId: "sess-1",
                interactionMode: "default",
                runtimeMode: "full-access",
                includeProposePlan: false,
                deferredExposure: false,
              },
              toolName: "steal_internal__read_env",
              arguments: {},
            })
            .pipe(Effect.flip);
          expect(internalAttempt.code).toBe("invalid_config");
          expect(internalAttempt.detail).toContain("Missing secrets");

          // Discover `my__echo` tools via Gateway (serverId contains `__`, so exposed names carry deterministic disambiguation tags).
          const listedEchoTools = yield* gateway.listToolsForSession({
            providerSessionId: "sess-1",
            interactionMode: "default",
            runtimeMode: "full-access",
            includeProposePlan: false,
            deferredExposure: false,
          });
          const readEnvToolName = listedEchoTools.find(
            (t) => t.serverId === "my__echo" && t.upstreamName === "read_env",
          )!.exposedName;
          const mutateItemToolName = "my__echo__mutate_item__8";
          expect(readEnvToolName).toBe("my__echo__read_env__8");
          expect(listedEchoTools.some((t) => t.exposedName === mutateItemToolName)).toBe(false);
          expect(McpGateway.decodeCanonicalExposedToolName(readEnvToolName)).toEqual({
            serverId: "my__echo",
            upstreamToolName: "read_env",
          });

          // Read-only tool under auto-read succeeds in full-access Plan mode, receives harness secret, strips OPENAI_API_KEY.
          const readResult = yield* gateway.callToolForSession({
            context: {
              providerSessionId: "sess-1",
              interactionMode: "plan",
              runtimeMode: "full-access",
              includeProposePlan: true,
              deferredExposure: false,
            },
            toolName: readEnvToolName,
            arguments: {},
          });
          expect(readResult.isError).not.toBe(true);
          const payload = JSON.parse(String(readResult.content[0]?.text ?? "{}")) as {
            injected: string | null;
            leakedOpenAi: string | null;
          };
          expect(payload.injected).toBe("resolved-echo-secret-value");
          expect(payload.leakedOpenAi).toBeNull();

          // In `approval-required`, unconfirmed upstream `readOnlyHint` alone MUST NOT bypass approval.
          const readBlockedInApprovalRequired = yield* gateway.callToolForSession({
            context: {
              providerSessionId: "sess-1",
              interactionMode: "default",
              runtimeMode: "approval-required",
              includeProposePlan: false,
              deferredExposure: false,
            },
            toolName: readEnvToolName,
            arguments: {},
          });
          expect(readBlockedInApprovalRequired.isError).toBe(true);
          expect(String(readBlockedInApprovalRequired.content[0]?.text ?? "")).toContain(
            "requires approval",
          );

          // Under `auto-read`, mutating tool MUST be blocked even in Default + full-access mode!
          const writeBlockedByAutoRead = yield* gateway.callToolForSession({
            context: {
              providerSessionId: "sess-1",
              interactionMode: "default",
              runtimeMode: "full-access",
              includeProposePlan: false,
              deferredExposure: false,
            },
            toolName: mutateItemToolName,
            arguments: { value: "abc" },
          });
          expect(writeBlockedByAutoRead.isError).toBe(true);
          expect(String(writeBlockedByAutoRead.content[0]?.text ?? "")).toContain(
            "requires approval",
          );

          // Under `always-ask`, EVEN read-only tools in full-access MUST fail closed!
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("my__echo"),
            config: {
              enabled: true,
              transport: {
                type: "stdio",
                command: process.execPath,
                args: ["-e", ECHO_STDIO_MCP_SCRIPT],
                env: { MY_TOKEN: "${secret:ECHO_SECRET}" },
              },
              injectionMode: "gateway",
              approvalPolicy: "always-ask",
            },
          });
          const readBlockedByAlwaysAsk = yield* gateway.callToolForSession({
            context: {
              providerSessionId: "sess-1",
              interactionMode: "default",
              runtimeMode: "full-access",
              includeProposePlan: false,
              deferredExposure: false,
            },
            toolName: readEnvToolName,
            arguments: {},
          });
          expect(readBlockedByAlwaysAsk.isError).toBe(true);
          expect(String(readBlockedByAlwaysAsk.content[0]?.text ?? "")).toContain(
            "requires approval",
          );

          // Under `auto-all`, mutating tool is blocked in supervised `auto` mode and Plan mode,
          // and allowed ONLY in Default + `full-access` mode.
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("my__echo"),
            config: {
              enabled: true,
              transport: {
                type: "stdio",
                command: process.execPath,
                args: ["-e", ECHO_STDIO_MCP_SCRIPT],
                env: { MY_TOKEN: "${secret:ECHO_SECRET}" },
              },
              injectionMode: "gateway",
              approvalPolicy: "auto-all",
            },
          });
          const writeBlockedInSupervised = yield* gateway.callToolForSession({
            context: {
              providerSessionId: "sess-1",
              interactionMode: "default",
              runtimeMode: "auto",
              includeProposePlan: false,
              deferredExposure: false,
            },
            toolName: mutateItemToolName,
            arguments: { value: "abc" },
          });
          expect(writeBlockedInSupervised.isError).toBe(true);
          expect(String(writeBlockedInSupervised.content[0]?.text ?? "")).toContain(
            "requires approval",
          );

          const writeBlockedInPlan = yield* gateway.callToolForSession({
            context: {
              providerSessionId: "sess-1",
              interactionMode: "plan",
              runtimeMode: "full-access",
              includeProposePlan: true,
              deferredExposure: false,
            },
            toolName: mutateItemToolName,
            arguments: { value: "abc" },
          });
          expect(writeBlockedInPlan.isError).toBe(true);
          expect(String(writeBlockedInPlan.content[0]?.text ?? "")).toContain("Plan mode");

          const writeAllowedFullAccess = yield* gateway.callToolForSession({
            context: {
              providerSessionId: "sess-1",
              interactionMode: "default",
              runtimeMode: "full-access",
              includeProposePlan: false,
              deferredExposure: false,
            },
            toolName: mutateItemToolName,
            arguments: { value: "abc" },
          });
          expect(writeAllowedFullAccess.isError).not.toBe(true);
          expect(String(writeAllowedFullAccess.content[0]?.text ?? "")).toBe("mutated:abc");

          // Stderr ring buffer captured boot output AND scrubbed both resolved secret and Bearer token!
          const logs = yield* gateway.getLogs(HarnessMcpServerId.make("my__echo"));
          const combined = logs.lines.map((line) => line.text).join("\n");
          expect(combined).toContain("echo-mcp booting");
          expect(combined).not.toContain("resolved-echo-secret-value");
          expect(combined).not.toContain("raw-leak-999");
          expect(combined).toContain("[REDACTED]");
        }).pipe(
          Effect.provide(
            makeGatewayTestLayer(baseDir, paths, {
              secrets: {
                [harnessLocalSecretKey("ECHO_SECRET")!]: "resolved-echo-secret-value",
                "auth-signing-key": "internal-signing-material-must-not-leak",
              },
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "routes unsupported native servers through gateway consistently, supports deferred search, evicts idle upstreams, and serializes concurrent invalidate",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-gateway-deferred-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        let closedCount = 0;
        const mockTools = Array.from({ length: 30 }, (_, index) => ({
          name: index === 7 ? "search_issues" : `tool_${index}`,
          description: index === 7 ? "Search repository issues" : `Tool number ${index}`,
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        }));

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const gateway = yield* McpGateway.McpGateway;

          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("big"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://big.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("direct_native"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://direct.example.com/mcp" },
              injectionMode: "native",
              approvalPolicy: "auto-read",
            },
          });

          // Native passthrough honors provider capabilities and falls back to gateway when unsupported.
          const nativeSupported = yield* gateway.resolveSessionInjection({
            interactionMode: "default",
            emitsProposedPlan: true,
            supportsMcpTools: true,
            harnessCapabilities: {
              ...DEFAULT_HARNESS_CAPABILITIES,
              mcpPassthrough: "http",
            },
          });
          expect(nativeSupported.harnessActive).toBe(true);
          expect(nativeSupported.nativeMcpServers.map((s) => s.id)).toEqual(["direct_native"]);

          const nativeUnsupported = yield* gateway.resolveSessionInjection({
            interactionMode: "default",
            emitsProposedPlan: true,
            supportsMcpTools: true,
            harnessCapabilities: DEFAULT_HARNESS_CAPABILITIES,
          });
          expect(nativeUnsupported.harnessActive).toBe(true);
          expect(nativeUnsupported.nativeMcpServers).toEqual([]);

          // When provider does NOT support native passthrough (mcpPassthrough: "none"),
          // `direct_native` MUST be exposed on the gateway catalog instead of silently disappearing!
          const fallbackTools = yield* gateway.callToolForSession({
            context: {
              providerSessionId: "sess-fallback",
              interactionMode: "default",
              runtimeMode: "full-access",
              includeProposePlan: false,
              deferredExposure: true,
              harnessCapabilities: DEFAULT_HARNESS_CAPABILITIES,
            },
            toolName: "harness_tool_search",
            arguments: { query: "direct_native" },
          });
          expect(String(fallbackTools.content[0]?.text ?? "")).toContain(
            "direct_native__search_issues",
          );

          // When provider DOES support native HTTP passthrough, `direct_native` is excluded from gateway catalog.
          const nativeCatalogSearch = yield* gateway.callToolForSession({
            context: {
              providerSessionId: "sess-native",
              interactionMode: "default",
              runtimeMode: "full-access",
              includeProposePlan: false,
              deferredExposure: true,
              harnessCapabilities: {
                ...DEFAULT_HARNESS_CAPABILITIES,
                mcpPassthrough: "http",
              },
            },
            toolName: "harness_tool_search",
            arguments: { query: "direct_native" },
          });
          expect(String(nativeCatalogSearch.content[0]?.text ?? "")).not.toContain(
            "direct_native__search_issues",
          );

          // Concurrent connect + invalidate is serialized by the per-server lifecycle lock.
          const listFiber = yield* Effect.forkChild(
            gateway.listToolsForSession({
              providerSessionId: "sess-race",
              interactionMode: "default",
              runtimeMode: "full-access",
              includeProposePlan: false,
              deferredExposure: false,
              harnessCapabilities: DEFAULT_HARNESS_CAPABILITIES,
            }),
          );
          const invalidateFiber = yield* Effect.forkChild(
            gateway.invalidateServer(HarnessMcpServerId.make("big")),
          );
          yield* Fiber.join(listFiber);
          yield* Fiber.join(invalidateFiber);

          // Advance TestClock past idleTtlMs and verify idle upstreams are evicted cleanly.
          yield* TestClock.adjust(Duration.millis(15_000));
          yield* gateway.evictIdle;
          expect(closedCount).toBeGreaterThanOrEqual(2);
          const snapshotAfterEvict = yield* gateway.getSnapshot();
          expect(snapshotAfterEvict.servers.find((s) => s.id === "big")?.state).toBe("idle");
        }).pipe(
          Effect.provide(
            makeGatewayTestLayer(baseDir, paths, {
              idleTtlMs: 10_000,
              connect: () => {
                let closed = false;
                return Effect.succeed({
                  listTools: () => Effect.succeed(mockTools),
                  callTool: (name) =>
                    Effect.succeed({ content: [{ type: "text", text: `ok:${name}` }] }),
                  close: () =>
                    Effect.sync(() => {
                      if (!closed) {
                        closed = true;
                        closedCount += 1;
                      }
                    }),
                  isClosed: () => closed,
                });
              },
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "refuses cross-origin HTTP redirects, matches early Streamable HTTP SSE responses, marks 404 session closed, and supports legacy SSE GET handshake",
    () =>
      Effect.gen(function* () {
        // 1. Cross-origin 302 redirect MUST fail without forwarding Authorization header.
        const seenOrigins: Array<string> = [];
        const redirectErr = yield* connectUpstream({
          serverId: HarnessMcpServerId.make("redir"),
          transport: { type: "http", url: "https://trusted.example.com/mcp" },
          resolvedEnvOrHeaders: { Authorization: "Bearer super-secret" },
          sensitiveValues: ["super-secret"],
          logs: new RingLogBuffer(),
          fetchImplementation: async (url) => {
            seenOrigins.push(new URL(url).origin);
            return new Response(null, {
              status: 302,
              headers: { location: "https://evil.example.com/steal" },
            });
          },
        }).pipe(Effect.flip);
        expect(redirectErr.code).toBe("upstream_error");
        expect(redirectErr.detail).toContain("cross-origin redirect");
        expect(seenOrigins).toEqual(["https://trusted.example.com"]);

        // 2. Streamable HTTP returns immediately upon matching SSE event id (even if stream never closes!)
        //    and marks the connection closed on HTTP 404 expired session.
        let callCount = 0;
        const streamConn = yield* connectUpstream({
          serverId: HarnessMcpServerId.make("stream_http"),
          transport: { type: "http", url: "https://stream.example.com/mcp" },
          resolvedEnvOrHeaders: {},
          logs: new RingLogBuffer(),
          fetchImplementation: async (_url, init) => {
            const parsed = JSON.parse(String(init?.body ?? "{}")) as {
              id?: number;
              method?: string;
            };
            if (parsed.method === "notifications/initialized") {
              return new Response(null, { status: 202 });
            }
            if (parsed.method === "tools/call") {
              callCount += 1;
              return new Response(null, { status: 404 });
            }
            const encoder = new TextEncoder();
            const payload =
              parsed.method === "initialize"
                ? {
                    jsonrpc: "2.0",
                    id: parsed.id,
                    result: { protocolVersion: "2025-06-18", capabilities: {} },
                  }
                : {
                    jsonrpc: "2.0",
                    id: parsed.id,
                    result: { tools: [{ name: "ping_tool", inputSchema: { type: "object" } }] },
                  };
            // Deliberately keep stream open (never calling controller.close()) to prove early matching.
            const neverEndingStream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
              },
            });
            return new Response(neverEndingStream, {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                "mcp-session-id": "sess-stream-1",
              },
            });
          },
        });
        const listed = yield* streamConn.listTools();
        expect(listed.map((t) => t.name)).toEqual(["ping_tool"]);
        expect(streamConn.isClosed()).toBe(false);

        const expiredErr = yield* streamConn.callTool("ping_tool", {}).pipe(Effect.flip);
        expect(callCount).toBe(1);
        expect(expiredErr.detail).toContain("404");
        expect(streamConn.isClosed()).toBe(true);

        // 3. Legacy SSE GET handshake receives `event: endpoint`, does not bind a headers-only
        //    connect timer to the live stream body, and correlates POST + SSE message frames.
        const encoder = new TextEncoder();
        let sseController!: ReadableStreamDefaultController<Uint8Array>;
        let sseGetSignal: AbortSignal | undefined;
        const sseConn = yield* connectUpstream({
          serverId: HarnessMcpServerId.make("legacy_sse"),
          transport: { type: "sse", url: "https://sse.example.com/sse" },
          resolvedEnvOrHeaders: { Authorization: "Bearer sse-secret" },
          sensitiveValues: ["sse-secret"],
          logs: new RingLogBuffer(),
          fetchImplementation: async (url, init) => {
            if ((init?.method ?? "GET") === "GET") {
              sseGetSignal = init?.signal ?? undefined;
              const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                  sseController = controller;
                  controller.enqueue(
                    encoder.encode("event: endpoint\ndata: /messages?session=1\n\n"),
                  );
                },
              });
              return new Response(stream, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              });
            }
            expect(url).toBe("https://sse.example.com/messages?session=1");
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              id?: number;
              method?: string;
            };
            if (body.id !== undefined) {
              const reply =
                body.method === "initialize"
                  ? { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }
                  : {
                      jsonrpc: "2.0",
                      id: body.id,
                      result: { tools: [{ name: "sse_tool", inputSchema: { type: "object" } }] },
                    };
              sseController.enqueue(
                encoder.encode(`event: message\ndata: ${JSON.stringify(reply)}\n\n`),
              );
            }
            return new Response(null, { status: 202 });
          },
        });
        expect(sseGetSignal?.aborted).toBe(false);
        const sseTools = yield* sseConn.listTools();
        expect(sseTools.map((t) => t.name)).toEqual(["sse_tool"]);
        yield* sseConn.close();
        expect(sseConn.isClosed()).toBe(true);
        expect(sseGetSignal?.aborted).toBe(true);

        // 4. Legacy SSE dropping mid-POST produces zero unhandledRejection.
        const unhandled: Array<unknown> = [];
        const onUnhandled = (reason: unknown) => {
          unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
          let dropSseController!: ReadableStreamDefaultController<Uint8Array>;
          const dropErr = yield* connectUpstream({
            serverId: HarnessMcpServerId.make("sse_drop_mid_post"),
            transport: { type: "sse", url: "https://drop.example.com/sse" },
            resolvedEnvOrHeaders: {},
            logs: new RingLogBuffer(),
            fetchImplementation: async (_url, init) => {
              if ((init?.method ?? "GET") === "GET") {
                const stream = new ReadableStream<Uint8Array>({
                  start(controller) {
                    dropSseController = controller;
                    controller.enqueue(encoder.encode("event: endpoint\ndata: /rpc\n\n"));
                  },
                });
                return new Response(stream, {
                  status: 200,
                  headers: { "content-type": "text/event-stream" },
                });
              }
              // Close the SSE stream while POST is still in flight, then flush microtasks before returning 202.
              dropSseController.close();
              await Promise.resolve();
              await Promise.resolve();
              return new Response(null, { status: 202 });
            },
          }).pipe(Effect.flip);
          expect(dropErr.code).toBe("upstream_error");
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(unhandled).toEqual([]);
        } finally {
          process.off("unhandledRejection", onUnhandled);
        }

        // 5. Interrupting Streamable HTTP during `notifications/initialized` sends DELETE to clean up session.
        let deletedSessionId: string | null = null;
        const initNotifyStarted = yield* Deferred.make<void>();
        const httpInterruptFiber = yield* connectUpstream({
          serverId: HarnessMcpServerId.make("http_interrupt_init"),
          transport: { type: "http", url: "https://http-cleanup.example.com/mcp" },
          resolvedEnvOrHeaders: {},
          logs: new RingLogBuffer(),
          fetchImplementation: async (_url, init) => {
            if (init?.method === "DELETE") {
              const headers = new Headers(init.headers);
              deletedSessionId = headers.get("mcp-session-id");
              return new Response(null, { status: 204 });
            }
            const parsed = JSON.parse(String(init?.body ?? "{}")) as {
              id?: number;
              method?: string;
            };
            if (parsed.method === "initialize") {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: { protocolVersion: "2025-06-18", capabilities: {} },
                }),
                {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "mcp-session-id": "sess-to-delete-42",
                  },
                },
              );
            }
            // Hold `notifications/initialized` open until aborted by fiber interrupt.
            Deferred.doneUnsafe(initNotifyStarted, Exit.void);
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            });
          },
        }).pipe(Effect.forkChild);
        yield* Deferred.await(initNotifyStarted);
        yield* Fiber.interrupt(httpInterruptFiber);
        expect(deletedSessionId).toBe("sess-to-delete-42");

        // 6. Streamable HTTP `notifications/initialized` returning HTTP 401 fails connect AND sends DELETE
        //    with a single case-insensitively overridden `mcp-protocol-version` header (no duplicates).
        let deleted401SessionId: string | null = null;
        let deleted401ProtocolVersion: string | null = null;
        let postInitProtocolVersion: string | null = null;
        const init401Err = yield* connectUpstream({
          serverId: HarnessMcpServerId.make("http_401_init"),
          transport: { type: "http", url: "https://http-401.example.com/mcp" },
          resolvedEnvOrHeaders: { "Mcp-Protocol-Version": "2025-03-26" },
          logs: new RingLogBuffer(),
          fetchImplementation: async (_url, init) => {
            const headers = new Headers(init?.headers);
            if (init?.method === "DELETE") {
              deleted401SessionId = headers.get("mcp-session-id");
              deleted401ProtocolVersion = headers.get("mcp-protocol-version");
              return new Response(null, { status: 204 });
            }
            const parsed = JSON.parse(String(init?.body ?? "{}")) as {
              id?: number;
              method?: string;
            };
            if (parsed.method === "initialize") {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: { protocolVersion: "2025-06-18", capabilities: {} },
                }),
                {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "mcp-session-id": "sess-401-delete",
                  },
                },
              );
            }
            postInitProtocolVersion = headers.get("mcp-protocol-version");
            return new Response(null, { status: 401 });
          },
        }).pipe(Effect.flip);
        expect(init401Err.code).toBe("upstream_error");
        expect(postInitProtocolVersion).toBe("2025-06-18");
        expect(deleted401SessionId).toBe("sess-401-delete");
        expect(deleted401ProtocolVersion).toBe("2025-06-18");

        // 7. Invalid HTTP header values (even with leading/trailing whitespace around secrets that
        //    Fetch `Headers` trims before throwing) return a fixed typed HarnessError with zero leak.
        const badHeaderErr = yield* connectUpstream({
          serverId: HarnessMcpServerId.make("http_bad_header"),
          transport: { type: "http", url: "https://bad-header.example.com/mcp" },
          resolvedEnvOrHeaders: { "X-Bad": "ok\r\n trimmed-secret-999 " },
          sensitiveValues: [" trimmed-secret-999 "],
          logs: new RingLogBuffer(),
          fetchImplementation: async () => new Response(null, { status: 200 }),
        }).pipe(Effect.flip);
        expect(badHeaderErr.code).toBe("invalid_config");
        expect(badHeaderErr.detail).toBe(
          'Invalid HTTP header configuration for MCP server "http_bad_header".',
        );
        expect(badHeaderErr.detail).not.toContain("trimmed-secret-999");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "disambiguates colliding __ tool names consistently across list/call, blocks direct calls to native-routed servers, serializes restart against revokeProjectTrust, and cleans up connections on tools/list interruption",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-collision-" });
        const baseDir = path.join(tempRoot, "t3home");
        const repoDir = path.join(tempRoot, "repo");
        yield* fs.makeDirectory(repoDir, { recursive: true });
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
        const invoked: Array<string> = [];
        let nativeConnected = 0;
        let interruptedClosed = 0;
        let repoConnected = 0;
        const discoverStarted = yield* Deferred.make<void>();
        const releaseFirstConnect = yield* Deferred.make<void>();
        const firstConnectStarted = yield* Deferred.make<void>();

        const testLayer = makeGatewayTestLayer(baseDir, paths, {
          connect: (input) => {
            if (input.serverId === "native_only") {
              nativeConnected += 1;
            }
            if (input.serverId === "repo_race") {
              repoConnected += 1;
              let closed = false;
              return Effect.gen(function* () {
                if (repoConnected === 1) {
                  yield* Deferred.succeed(firstConnectStarted, undefined);
                  yield* Deferred.await(releaseFirstConnect);
                }
                return {
                  listTools: () => Effect.succeed([]),
                  callTool: () => Effect.succeed({ content: [] }),
                  close: () =>
                    Effect.sync(() => {
                      closed = true;
                    }),
                  isClosed: () => closed,
                };
              });
            }
            if (input.serverId === "hanging_discover") {
              let closed = false;
              return Effect.succeed({
                listTools: () =>
                  Deferred.succeed(discoverStarted, undefined).pipe(Effect.andThen(Effect.never)),
                callTool: () => Effect.die("unexpected"),
                close: () =>
                  Effect.sync(() => {
                    if (!closed) {
                      closed = true;
                      interruptedClosed += 1;
                    }
                  }),
                isClosed: () => closed,
              });
            }
            const tools =
              input.serverId === "alpha"
                ? [
                    {
                      name: "beta__read",
                      description: "From alpha server",
                      inputSchema: { type: "object" },
                      annotations: { readOnlyHint: true },
                    },
                  ]
                : [
                    {
                      name: "read",
                      description: "From alpha__beta server",
                      inputSchema: { type: "object" },
                      annotations: { readOnlyHint: true },
                    },
                  ];
            let closed = false;
            return Effect.succeed({
              listTools: () => Effect.succeed(tools),
              callTool: (name) =>
                Effect.sync(() => {
                  invoked.push(`${input.serverId}:${name}`);
                  return { content: [{ type: "text", text: `${input.serverId}:${name}` }] };
                }),
              close: () =>
                Effect.sync(() => {
                  closed = true;
                }),
              isClosed: () => closed,
            });
          },
        });

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const gateway = yield* McpGateway.McpGateway;

          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("alpha"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://alpha.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("alpha__beta"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://alphabeta.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("native_only"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://native.example.com/mcp" },
              injectionMode: "native",
              approvalPolicy: "auto-read",
            },
          });

          const caps = {
            mcpPassthrough: "http" as const,
            mcpListChanged: false,
            skillMount: "none" as const,
            systemContextMutableMidSession: false,
            maxSystemContextBytes: null,
            nativeToolHooks: false,
            nativeAllowAlways: false,
          };
          const sessionCtx: McpGateway.GatewaySessionContext = {
            providerSessionId: "sess-collision",
            interactionMode: "default",
            runtimeMode: "full-access",
            includeProposePlan: false,
            deferredExposure: false,
            harnessCapabilities: caps,
          };

          // 1. Both colliding tools are exposed with distinct injective names matching getSnapshot,
          //    and removing `alpha` never rebinds `alpha`'s cached exposed name to `alpha__beta`.
          const listed = yield* gateway.listToolsForSession(sessionCtx);
          expect(listed).toHaveLength(2);
          const alphaEntry = listed.find((t) => t.serverId === "alpha");
          const alphaBetaEntry = listed.find((t) => t.serverId === "alpha__beta");
          expect(alphaEntry).toBeDefined();
          expect(alphaBetaEntry).toBeDefined();
          expect(alphaEntry!.exposedName).not.toBe(alphaBetaEntry!.exposedName);

          const snapForTools = yield* gateway.getSnapshot();
          expect(snapForTools.servers.find((s) => s.id === "alpha")?.tools[0]?.exposedName).toBe(
            alphaEntry!.exposedName,
          );
          expect(
            snapForTools.servers.find((s) => s.id === "alpha__beta")?.tools[0]?.exposedName,
          ).toBe(alphaBetaEntry!.exposedName);

          const res1 = yield* gateway.callToolForSession({
            context: sessionCtx,
            toolName: alphaEntry!.exposedName,
            arguments: {},
          });
          const res2 = yield* gateway.callToolForSession({
            context: sessionCtx,
            toolName: alphaBetaEntry!.exposedName,
            arguments: {},
          });
          expect(res1.content[0]?.text).toBe("alpha:beta__read");
          expect(res2.content[0]?.text).toBe("alpha__beta:read");
          expect(invoked).toEqual(["alpha:beta__read", "alpha__beta:read"]);

          // Remove `alpha` while keeping `alpha__beta`; calling `alpha`'s cached exposedName MUST fail (never rebind!).
          yield* store.removeUserServer(HarnessMcpServerId.make("alpha"));
          yield* gateway.invalidateServer(HarnessMcpServerId.make("alpha"));
          const staleAlphaErr = yield* gateway
            .callToolForSession({
              context: sessionCtx,
              toolName: alphaEntry!.exposedName,
              arguments: {},
            })
            .pipe(Effect.flip);
          expect(staleAlphaErr.code).toBe("not_found");
          expect(invoked).toEqual(["alpha:beta__read", "alpha__beta:read"]);

          // Re-add `alpha` for subsequent digest test.
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("alpha"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://alpha.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });

          // 2. Direct call to native-routed server is refused without ever connecting it.
          const nativeCallErr = yield* gateway
            .callToolForSession({
              context: sessionCtx,
              toolName: "native_only__ping",
              arguments: {},
            })
            .pipe(Effect.flip);
          expect(nativeCallErr.code).toBe("not_found");
          expect(nativeConnected).toBe(0);

          // 3. Gateway digest changes when gateway stays active and a server changes.
          const inj1 = yield* gateway.resolveSessionInjection({
            interactionMode: "default",
            emitsProposedPlan: false,
            supportsMcpTools: true,
            harnessCapabilities: caps,
          });
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("alpha"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://alpha.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-all",
            },
          });
          const inj2 = yield* gateway.resolveSessionInjection({
            interactionMode: "default",
            emitsProposedPlan: false,
            supportsMcpTools: true,
            harnessCapabilities: caps,
          });
          expect(inj1.harnessActive).toBe(true);
          expect(inj2.harnessActive).toBe(true);
          expect(inj2.gatewayServersDigest).not.toBe(inj1.gatewayServersDigest);

          // 4. Interrupting initial tools/list closes the unpooled upstream connection.
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("hanging_discover"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://hang.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });
          const fiber = yield* gateway
            .callToolForSession({
              context: sessionCtx,
              toolName: "hanging_discover__any",
              arguments: {},
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(discoverStarted);
          yield* Fiber.interrupt(fiber);
          expect(interruptedClosed).toBe(1);

          // 5. A restart queued behind a running connect re-reads trust inside the lock and fails after revocation.
          yield* fs.writeFileString(
            path.join(repoDir, "t3.json"),
            JSON.stringify({
              harness: {
                mcpServers: {
                  repo_race: {
                    enabled: true,
                    transport: { type: "http", url: "https://repo-race.example.com/mcp" },
                  },
                },
              },
            }),
          );
          const beforeTrust = yield* store.resolveWorkspace(repoDir);
          const repoServer = beforeTrust.servers.find((s) => s.id === "repo_race")!;
          yield* store.trustProjectServer({
            repoRoot: repoServer.repoRoot!,
            serverId: repoServer.id,
            digest: repoServer.trustDigest!,
          });
          const firstRestart = yield* gateway
            .restartServer({ serverId: repoServer.id, workspaceRoot: repoDir })
            .pipe(Effect.forkChild);
          yield* Deferred.await(firstConnectStarted);

          // Queue a second restart while the per-server lock is held, then revoke trust before releasing.
          const queuedRestart = yield* gateway
            .restartServer({ serverId: repoServer.id, workspaceRoot: repoDir })
            .pipe(Effect.flip, Effect.forkChild);
          yield* store.revokeProjectTrust({
            repoRoot: repoServer.repoRoot!,
            serverId: repoServer.id,
          });
          yield* Deferred.succeed(releaseFirstConnect, undefined);
          yield* Fiber.join(firstRestart);
          const queuedErr = yield* Fiber.join(queuedRestart);
          expect(queuedErr.code).toBe("untrusted");
          expect(repoConnected).toBe(1);
        }).pipe(Effect.provide(testLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "re-reads trust inside the per-server lock so a queued discovery fiber cannot connect a project server revoked while 4 concurrency slots were busy",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-disc-race-" });
        const baseDir = path.join(tempRoot, "t3home");
        const repoDir = path.join(tempRoot, "repo");
        yield* fs.makeDirectory(repoDir, { recursive: true });
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        const releaseSlots = yield* Deferred.make<void>();
        let startedSlots = 0;
        const fourSlotsBusy = yield* Deferred.make<void>();
        let fifthConnected = 0;

        const testLayer = makeGatewayTestLayer(baseDir, paths, {
          connect: (input) =>
            Effect.gen(function* () {
              if (input.serverId === "z_fifth_repo") {
                fifthConnected += 1;
              } else {
                startedSlots += 1;
                if (startedSlots === 4) {
                  yield* Deferred.succeed(fourSlotsBusy, undefined);
                }
                yield* Deferred.await(releaseSlots);
              }
              return {
                listTools: () =>
                  Effect.succeed([
                    {
                      name: "ping",
                      inputSchema: { type: "object" },
                      annotations: { readOnlyHint: true },
                    },
                  ]),
                callTool: () => Effect.succeed({ content: [] }),
                close: () => Effect.void,
                isClosed: () => false,
              };
            }),
        });

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const gateway = yield* McpGateway.McpGateway;

          for (const id of ["a_slot1", "b_slot2", "c_slot3", "d_slot4"]) {
            yield* store.upsertUserServer({
              id: HarnessMcpServerId.make(id),
              config: {
                enabled: true,
                transport: { type: "http", url: `https://${id}.example.com/mcp` },
                injectionMode: "gateway",
                approvalPolicy: "auto-read",
              },
            });
          }
          yield* fs.writeFileString(
            path.join(repoDir, "t3.json"),
            JSON.stringify({
              harness: {
                mcpServers: {
                  z_fifth_repo: {
                    enabled: true,
                    transport: { type: "http", url: "https://fifth.example.com/mcp" },
                  },
                },
              },
            }),
          );
          const ws = yield* store.resolveWorkspace(repoDir);
          const fifth = ws.servers.find((s) => s.id === "z_fifth_repo")!;
          yield* store.trustProjectServer({
            repoRoot: fifth.repoRoot!,
            serverId: fifth.id,
            digest: fifth.trustDigest!,
          });

          const listFiber = yield* gateway
            .listToolsForSession({
              providerSessionId: "sess-disc-race",
              workspaceRoot: repoDir,
              interactionMode: "default",
              runtimeMode: "full-access",
              includeProposePlan: false,
              deferredExposure: false,
              harnessCapabilities: DEFAULT_HARNESS_CAPABILITIES,
            })
            .pipe(Effect.forkChild);

          // Wait until all 4 concurrency slots are occupied, then revoke trust & invalidate the 5th server.
          yield* Deferred.await(fourSlotsBusy);
          yield* store.revokeProjectTrust({
            repoRoot: fifth.repoRoot!,
            serverId: fifth.id,
          });
          yield* gateway.invalidateServer(fifth.id);
          yield* Deferred.succeed(releaseSlots, undefined);

          const tools = yield* Fiber.join(listFiber);
          expect(fifthConnected).toBe(0);
          expect(tools.some((t) => t.serverId === "z_fifth_repo")).toBe(false);
        }).pipe(Effect.provide(testLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "prevents trailing/leading single-underscore boundary collisions (`a_`+`b` vs `a`+`_b`) and keeps getSnapshot 100% consistent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-underscore-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
        const invoked: Array<string> = [];

        const testLayer = makeGatewayTestLayer(baseDir, paths, {
          connect: (input) =>
            Effect.succeed({
              listTools: () =>
                Effect.succeed(
                  input.serverId === "a_"
                    ? [
                        {
                          name: "b",
                          inputSchema: { type: "object" },
                          annotations: { readOnlyHint: true },
                        },
                      ]
                    : [
                        {
                          name: "_b",
                          inputSchema: { type: "object" },
                          annotations: { readOnlyHint: true },
                        },
                      ],
                ),
              callTool: (name) =>
                Effect.sync(() => {
                  invoked.push(`${input.serverId}:${name}`);
                  return { content: [{ type: "text", text: `${input.serverId}:${name}` }] };
                }),
              close: () => Effect.void,
              isClosed: () => false,
            }),
        });

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const gateway = yield* McpGateway.McpGateway;

          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("a_"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://a-under.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("a"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://a.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });

          const ctx: McpGateway.GatewaySessionContext = {
            providerSessionId: "sess-under",
            interactionMode: "default",
            runtimeMode: "full-access",
            includeProposePlan: false,
            deferredExposure: false,
            harnessCapabilities: DEFAULT_HARNESS_CAPABILITIES,
          };
          const listed = yield* gateway.listToolsForSession(ctx);
          const aUnder = listed.find((t) => t.serverId === "a_")!;
          const aPlain = listed.find((t) => t.serverId === "a")!;
          expect(aUnder.exposedName).toBe("a___b__2");
          expect(aPlain.exposedName).toBe("a___b__1");
          expect(McpGateway.decodeCanonicalExposedToolName(aUnder.exposedName)).toEqual({
            serverId: "a_",
            upstreamToolName: "b",
          });
          expect(McpGateway.decodeCanonicalExposedToolName(aPlain.exposedName)).toEqual({
            serverId: "a",
            upstreamToolName: "_b",
          });

          const snap = yield* gateway.getSnapshot();
          expect(snap.servers.find((s) => s.id === "a_")?.tools[0]?.exposedName).toBe(
            aUnder.exposedName,
          );
          expect(snap.servers.find((s) => s.id === "a")?.tools[0]?.exposedName).toBe(
            aPlain.exposedName,
          );

          // Same-id AND identical configDigest user vs project configs MUST still isolate state/lastError/tools!
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("same_digest"),
            config: {
              enabled: true,
              transport: {
                type: "http",
                url: "https://same-digest.example.com/mcp",
                headers: { Authorization: "Bearer ${secret:missing_scope_secret}" },
              },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
              origin: { kind: "imported", source: "claude" },
            },
          });
          yield* gateway.listToolsForSession(ctx);
          const repoDir = path.join(tempRoot, "scope-isolation-repo");
          yield* fs.makeDirectory(repoDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(repoDir, "t3.json"),
            JSON.stringify({
              harness: {
                mcpServers: {
                  a: {
                    enabled: true,
                    transport: { type: "http", url: "https://project-a.example.com/mcp" },
                  },
                  same_digest: {
                    enabled: true,
                    transport: {
                      type: "http",
                      url: "https://same-digest.example.com/mcp",
                      headers: { Authorization: "Bearer ${secret:missing_scope_secret}" },
                    },
                    injectionMode: "gateway",
                    approvalPolicy: "auto-read",
                    origin: { kind: "imported", source: "claude" },
                  },
                },
              },
            }),
          );
          const scopedSnap = yield* gateway.getSnapshot(repoDir);
          const projectAView = scopedSnap.servers.find(
            (s) => s.id === "a" && s.scope === "project",
          );
          expect(projectAView?.tools).toEqual([]);
          expect(projectAView?.lastError).toBeNull();
          const userSameDigest = scopedSnap.servers.find(
            (s) => s.id === "same_digest" && s.scope === "user",
          );
          const projectSameDigest = scopedSnap.servers.find(
            (s) => s.id === "same_digest" && s.scope === "project",
          );
          expect(userSameDigest?.configDigest).toBe(projectSameDigest?.configDigest);
          expect(userSameDigest?.lastError).toContain(
            'Missing secrets for MCP server "same_digest"',
          );
          expect(projectSameDigest?.state).toBe("untrusted");
          expect(projectSameDigest?.lastError).toBeNull();
          expect(projectSameDigest?.tools).toEqual([]);

          // Removing `a_` MUST NOT allow `a_`'s cached exposedName to execute `a:_b`!
          yield* store.removeUserServer(HarnessMcpServerId.make("a_"));
          yield* gateway.invalidateServer(HarnessMcpServerId.make("a_"));
          const err = yield* gateway
            .callToolForSession({
              context: ctx,
              toolName: aUnder.exposedName,
              arguments: {},
            })
            .pipe(Effect.flip);
          expect(err.code).toBe("not_found");
          expect(invoked).toEqual([]);
        }).pipe(Effect.provide(testLayer));

        // Failed tool call on a dead project-scoped connection MUST NOT close a healthy user-scoped
        // connection sharing the same serverId.
        let userScopedClosed = 0;
        let projectScopedClosed = 0;
        const multiScopeLayer = makeGatewayTestLayer(baseDir, paths, {
          connect: (input) => {
            const isProject =
              input.transport.type === "http" && input.transport.url.includes("project-only");
            let closed = false;
            return Effect.succeed({
              listTools: () =>
                Effect.succeed([
                  {
                    name: "ping",
                    description: "Ping",
                    inputSchema: { type: "object" },
                    annotations: { readOnlyHint: true },
                  },
                ]),
              callTool: () => {
                if (isProject) {
                  closed = true;
                  return Effect.fail(
                    new HarnessError({
                      code: "upstream_error",
                      serverId: input.serverId,
                      detail: "project connection dropped",
                    }),
                  );
                }
                return Effect.succeed({ content: [{ type: "text", text: "user-ok" }] });
              },
              close: () =>
                Effect.sync(() => {
                  if (!closed) closed = true;
                  if (isProject) projectScopedClosed += 1;
                  else userScopedClosed += 1;
                }),
              isClosed: () => closed,
            });
          },
        });
        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const gateway = yield* McpGateway.McpGateway;
          const repoDir2 = path.join(tempRoot, "single-scope-cleanup-repo");
          yield* fs.makeDirectory(repoDir2, { recursive: true });
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("shared_srv"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://user-only.example.com/mcp" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });
          yield* fs.writeFileString(
            path.join(repoDir2, "t3.json"),
            JSON.stringify({
              harness: {
                mcpServers: {
                  shared_srv: {
                    enabled: true,
                    transport: { type: "http", url: "https://project-only.example.com/mcp" },
                    injectionMode: "gateway",
                    approvalPolicy: "auto-read",
                  },
                },
              },
            }),
          );
          const preTrust = yield* gateway.getSnapshot(repoDir2);
          const projEntry = preTrust.servers.find(
            (s) => s.id === "shared_srv" && s.scope === "project",
          )!;
          yield* store.trustProjectServer({
            repoRoot: repoDir2,
            serverId: HarnessMcpServerId.make("shared_srv"),
            digest: projEntry.trustDigest!,
          });

          const userCtx: McpGateway.GatewaySessionContext = {
            providerSessionId: "sess-user-scope",
            interactionMode: "default",
            runtimeMode: "full-access",
            includeProposePlan: false,
            deferredExposure: false,
            harnessCapabilities: DEFAULT_HARNESS_CAPABILITIES,
          };
          const projectCtx: McpGateway.GatewaySessionContext = {
            ...userCtx,
            providerSessionId: "sess-proj-scope",
            workspaceRoot: repoDir2,
          };
          yield* gateway.listToolsForSession(userCtx);
          yield* gateway.listToolsForSession(projectCtx);

          const callErr = yield* gateway
            .callToolForSession({
              context: projectCtx,
              toolName: "shared_srv__ping",
              arguments: {},
            })
            .pipe(Effect.flip);
          expect(callErr.code).toBe("upstream_error");
          expect(projectScopedClosed).toBe(1);
          expect(userScopedClosed).toBe(0);

          const userSnap = yield* gateway.getSnapshot();
          expect(userSnap.servers.find((s) => s.id === "shared_srv")?.state).toBe("connected");
          const projSnap = yield* gateway.getSnapshot(repoDir2);
          expect(
            projSnap.servers.find((s) => s.id === "shared_srv" && s.scope === "project")?.state,
          ).toBe("idle");
        }).pipe(Effect.provide(multiScopeLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
