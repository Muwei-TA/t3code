// @effect-diagnostics nodeBuiltinImport:off -- Deterministic SHA-256 suffix for collision-free MCP tool names and gateway catalog digests.
import * as NodeCrypto from "node:crypto";
import {
  HarnessError,
  type HarnessMcpLogsResult,
  type HarnessMcpServerConfig,
  type HarnessMcpServerId,
  type HarnessMcpServerState,
  type HarnessMcpServerView,
  type HarnessMcpSnapshot,
  type HarnessMcpToolSummary,
  type OrchestrationV2HarnessCapabilities,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { HarnessNativeMcpServer } from "@t3tools/provider-core/server/mcpSession";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  redactHarnessServerConfig,
  resolveSecretRecord,
  scrubHarnessLogText,
} from "./HarnessSecrets.ts";
import * as HarnessStore from "./HarnessStore.ts";
import {
  connectUpstream,
  type McpUpstreamConnection,
  RingLogBuffer,
  type UpstreamMcpCallResult,
  type UpstreamMcpTool,
} from "./McpUpstreamClient.ts";

const HARNESS_TOOL_SEARCH_NAME = "harness_tool_search";
export const HARNESS_PROPOSE_PLAN_NAME = "propose_plan";

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1_000;
const DEFERRED_THRESHOLD_TOOLS = 24;
const MAX_SEARCH_RESULTS = 12;
const MAX_EXPOSURE_SESSIONS = 256;

export interface GatewayExposedTool {
  readonly exposedName: string;
  readonly serverId: HarnessMcpServerId | null;
  readonly upstreamName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
}

export interface GatewaySessionContext {
  readonly providerSessionId: string;
  readonly workspaceRoot?: string | undefined;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly includeProposePlan: boolean;
  readonly deferredExposure: boolean;
  readonly harnessCapabilities?: OrchestrationV2HarnessCapabilities | undefined;
}

export interface GatewaySessionInjection {
  readonly harnessActive: boolean;
  /** Changes whenever active gateway server configs or propose_plan availability change. */
  readonly gatewayServersDigest: string;
  readonly nativeMcpServers: ReadonlyArray<HarnessNativeMcpServer>;
}

interface PooledUpstream {
  readonly serverId: HarnessMcpServerId;
  readonly scopeKey: string;
  readonly configDigest: string;
  readonly transportType: HarnessMcpServerConfig["transport"]["type"];
  readonly connection: McpUpstreamConnection;
  readonly tools: ReadonlyArray<UpstreamMcpTool>;
  lastUsedMs: number;
}

function runtimeScopeKey(
  server: Pick<HarnessStore.ResolvedHarnessMcpServer, "scope" | "repoRoot" | "configDigest">,
): string {
  return server.scope === "project"
    ? `project\u0000${server.repoRoot ?? ""}\u0000${server.configDigest}`
    : `user\u0000${server.configDigest}`;
}

function runtimeScopePrefix(
  server: Pick<HarnessStore.ResolvedHarnessMcpServer, "id" | "scope" | "repoRoot">,
): string {
  return server.scope === "project"
    ? `${server.id}\u0000project\u0000${server.repoRoot ?? ""}\u0000`
    : `${server.id}\u0000user\u0000`;
}

function poolKeyFor(
  server: Pick<HarnessStore.ResolvedHarnessMcpServer, "id" | "scope" | "repoRoot" | "configDigest">,
): string {
  return `${server.id}\u0000${runtimeScopeKey(server)}`;
}

interface DigestRuntimeState {
  state: "idle" | "starting" | "connected" | "error";
  lastError: string | null;
}

interface ServerRuntimeRecord {
  readonly stateByDigest: Map<string, DigestRuntimeState>;
  readonly toolsByDigest: Map<string, ReadonlyArray<UpstreamMcpTool>>;
  readonly logs: RingLogBuffer;
  readonly lock: Semaphore.Semaphore;
}

export interface McpGatewayOptions {
  readonly idleTtlMs?: number;
  readonly connect?: typeof connectUpstream;
}

/**
 * Strictly injective, reversible tool naming: `<serverId>__<tool>` when `__` occurs only at the
 * boundary, else `<serverId>__<tool>__<serverId.length>` so the split point is uniquely decodable.
 */
function canonicalExposedToolName(serverId: HarnessMcpServerId, upstreamToolName: string): string {
  const base = `${serverId}__${upstreamToolName}`;
  if (
    !serverId.includes("__") &&
    !upstreamToolName.includes("__") &&
    !serverId.endsWith("_") &&
    !upstreamToolName.startsWith("_")
  ) {
    return base;
  }
  return `${base}__${serverId.length}`;
}

/** Exact inverse of `canonicalExposedToolName` (returns null for malformed names). */
export function decodeCanonicalExposedToolName(
  exposedName: string,
): { readonly serverId: string; readonly upstreamToolName: string } | null {
  const firstSep = exposedName.indexOf("__");
  if (firstSep <= 0) return null;
  const lastSep = exposedName.lastIndexOf("__");
  if (firstSep === lastSep) {
    const serverId = exposedName.slice(0, firstSep);
    const upstreamToolName = exposedName.slice(firstSep + 2);
    if (
      upstreamToolName.length === 0 ||
      serverId.endsWith("_") ||
      upstreamToolName.startsWith("_")
    ) {
      return null;
    }
    return { serverId, upstreamToolName };
  }
  const lenText = exposedName.slice(lastSep + 2);
  if (!/^[1-9]\d*$/u.test(lenText)) return null;
  const serverLen = Number(lenText);
  const body = exposedName.slice(0, lastSep);
  if (serverLen <= 0 || serverLen + 2 >= body.length) return null;
  if (body.slice(serverLen, serverLen + 2) !== "__") return null;
  return {
    serverId: body.slice(0, serverLen),
    upstreamToolName: body.slice(serverLen + 2),
  };
}

function filterAllowedTools(
  config: HarnessMcpServerConfig,
  tools: ReadonlyArray<UpstreamMcpTool>,
): ReadonlyArray<UpstreamMcpTool> {
  const allowed =
    config.allowedTools && config.allowedTools.length > 0 ? new Set(config.allowedTools) : null;
  const disabled =
    config.disabledTools && config.disabledTools.length > 0 ? new Set(config.disabledTools) : null;
  return tools.filter((tool) => {
    if (allowed !== null && !allowed.has(tool.name)) return false;
    if (disabled !== null && disabled.has(tool.name)) return false;
    return true;
  });
}

function scoreToolMatch(
  tool: Pick<GatewayExposedTool, "exposedName" | "description">,
  terms: ReadonlyArray<string>,
): number {
  const name = tool.exposedName.toLowerCase();
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (term === name) total += 100;
    else if (name.includes(term)) total += 4;
    else if (description.includes(term)) total += 1;
  }
  return total;
}

function estimateToolsBytes(tools: ReadonlyArray<HarnessMcpToolSummary>): number {
  if (tools.length === 0) return 0;
  return Buffer.byteLength(
    JSON.stringify(
      tools.map((tool) => ({
        name: tool.exposedName,
        description: tool.description ?? "",
      })),
    ),
    "utf8",
  );
}

function providerSupportsNativeTransport(
  capabilities: OrchestrationV2HarnessCapabilities,
  transportType: HarnessMcpServerConfig["transport"]["type"],
): boolean {
  if (capabilities.mcpPassthrough === "none") return false;
  if (capabilities.mcpPassthrough === "stdio+http") return true;
  if (capabilities.mcpPassthrough === "stdio") return transportType === "stdio";
  return transportType === "http" || transportType === "sse";
}

/**
 * Single source of truth deciding whether an enabled MCP server runs over native passthrough
 * or falls back to the T3 Harness HTTP gateway for a given provider's capabilities.
 */
export function resolveServerChannel(
  config: Pick<HarnessMcpServerConfig, "injectionMode" | "transport">,
  harnessCapabilities?: OrchestrationV2HarnessCapabilities,
): "native" | "gateway" {
  if (
    config.injectionMode === "native" &&
    harnessCapabilities !== undefined &&
    providerSupportsNativeTransport(harnessCapabilities, config.transport.type)
  ) {
    return "native";
  }
  return "gateway";
}

interface CatalogToolBinding {
  readonly exposed: GatewayExposedTool;
  readonly server: HarnessStore.ResolvedHarnessMcpServer;
  readonly tool: UpstreamMcpTool;
}

/**
 * Single deterministic naming table shared by `tools/list`, `tools/call`, and `getSnapshot`.
 */
function buildGatewayExposedCatalog(
  entries: ReadonlyArray<{
    readonly server: HarnessStore.ResolvedHarnessMcpServer;
    readonly tools: ReadonlyArray<UpstreamMcpTool>;
  }>,
): {
  readonly tools: ReadonlyArray<GatewayExposedTool>;
  readonly byExposedName: ReadonlyMap<string, CatalogToolBinding>;
} {
  const sortedServers = [...entries].sort(
    (left, right) =>
      left.server.id.localeCompare(right.server.id) ||
      left.server.scope.localeCompare(right.server.scope),
  );

  const tools: Array<GatewayExposedTool> = [];
  const byExposedName = new Map<string, CatalogToolBinding>();
  for (const { server, tools: rawTools } of sortedServers) {
    const allowed = [...filterAllowedTools(server.config, rawTools)].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const tool of allowed) {
      const finalName = canonicalExposedToolName(server.id, tool.name);
      const exposed: GatewayExposedTool = {
        exposedName: finalName,
        serverId: server.id,
        upstreamName: tool.name,
        description: tool.description ?? `${server.id}/${tool.name}`,
        inputSchema: tool.inputSchema,
        readOnly: tool.annotations?.readOnlyHint === true,
      };
      tools.push(exposed);
      byExposedName.set(finalName, { exposed, server, tool });
    }
  }

  return { tools, byExposedName };
}

const HARNESS_TOOL_SEARCH_DEF: GatewayExposedTool = {
  exposedName: HARNESS_TOOL_SEARCH_NAME,
  serverId: null,
  upstreamName: HARNESS_TOOL_SEARCH_NAME,
  description:
    "Search user-configured MCP tools hosted by T3 Harness by keyword and load matching tools into this session.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords describing the tool or MCP server to load (e.g. 'github issue').",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  readOnly: true,
};

const HARNESS_PROPOSE_PLAN_DEF: GatewayExposedTool = {
  exposedName: HARNESS_PROPOSE_PLAN_NAME,
  serverId: null,
  upstreamName: HARNESS_PROPOSE_PLAN_NAME,
  description:
    "Submit a decision-complete Markdown implementation plan for user review in Plan mode. Calling this renders an interactive plan card so the user can approve and execute it.",
  inputSchema: {
    type: "object",
    properties: {
      markdown: {
        type: "string",
        description: "Complete implementation plan in Markdown.",
      },
    },
    required: ["markdown"],
    additionalProperties: false,
  },
  readOnly: true,
};

export class McpGateway extends Context.Service<
  McpGateway,
  {
    /** Strictly passive & redacted: never spawns stdio processes and never returns literal secrets. */
    readonly getSnapshot: (workspaceRoot?: string | undefined) => Effect.Effect<HarnessMcpSnapshot>;
    readonly getLogs: (serverId: HarnessMcpServerId) => Effect.Effect<HarnessMcpLogsResult>;
    /** Explicitly tears down any pooled upstream and reconnects to verify health and refresh tools. */
    readonly restartServer: <E = never>(input: {
      readonly serverId: HarnessMcpServerId;
      readonly workspaceRoot?: string | undefined;
      readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
    }) => Effect.Effect<HarnessMcpSnapshot, HarnessError | E>;
    readonly invalidateServer: (serverId: HarnessMcpServerId) => Effect.Effect<void>;
    readonly resolveSessionInjection: (input: {
      readonly workspaceRoot?: string | undefined;
      readonly interactionMode: ProviderInteractionMode;
      readonly emitsProposedPlan: boolean;
      readonly supportsMcpTools: boolean;
      readonly harnessCapabilities: OrchestrationV2HarnessCapabilities;
    }) => Effect.Effect<GatewaySessionInjection>;
    readonly listToolsForSession: (
      context: GatewaySessionContext,
    ) => Effect.Effect<ReadonlyArray<GatewayExposedTool>>;
    readonly callToolForSession: (input: {
      readonly context: GatewaySessionContext;
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<UpstreamMcpCallResult, HarnessError>;
    readonly evictIdle: Effect.Effect<void>;
  }
>()("t3/harness/McpGateway") {}

export const makeWithOptions = Effect.fn("McpGateway.make")(function* (
  options: McpGatewayOptions = {},
) {
  const store = yield* HarnessStore.HarnessStore;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const connect = options.connect ?? connectUpstream;

  const pool = new Map<string, PooledUpstream>();
  const records = new Map<HarnessMcpServerId, ServerRuntimeRecord>();
  const loadedBySession = new Map<string, Set<string>>();

  const getOrCreateRecord = (serverId: HarnessMcpServerId): ServerRuntimeRecord => {
    let record = records.get(serverId);
    if (!record) {
      record = {
        stateByDigest: new Map(),
        toolsByDigest: new Map(),
        logs: new RingLogBuffer(),
        lock: Semaphore.makeUnsafe(1),
      };
      records.set(serverId, record);
    }
    return record;
  };

  const setDigestState = (
    record: ServerRuntimeRecord,
    configDigest: string,
    state: DigestRuntimeState["state"],
    lastError: string | null,
  ) => {
    record.stateByDigest.set(configDigest, { state, lastError });
    if (record.stateByDigest.size > 8) {
      const oldest = record.stateByDigest.keys().next().value;
      if (oldest !== undefined) record.stateByDigest.delete(oldest);
    }
  };

  const closePooled = Effect.fn("McpGateway.closePooled")(function* (key: string) {
    const pooled = pool.get(key);
    if (!pooled) return;
    pool.delete(key);
    yield* pooled.connection.close();
  });

  const closeAllForServerUnlocked = Effect.fn("McpGateway.closeAllForServerUnlocked")(function* (
    serverId: HarnessMcpServerId,
  ) {
    const keys = Array.from(pool.keys()).filter((key) => key.startsWith(`${serverId}\u0000`));
    for (const key of keys) {
      yield* closePooled(key);
    }
    const record = records.get(serverId);
    if (record) {
      for (const [digest, entry] of record.stateByDigest) {
        if (entry.state === "connected" || entry.state === "starting") {
          record.stateByDigest.set(digest, { state: "idle", lastError: null });
        }
      }
    }
  });

  /** Acquires the per-server lifecycle lock so invalidation and startup never race or leak children. */
  const closeAllForServer = Effect.fn("McpGateway.closeAllForServer")(function* (
    serverId: HarnessMcpServerId,
  ) {
    const record = getOrCreateRecord(serverId);
    yield* record.lock.withPermits(1)(closeAllForServerUnlocked(serverId));
  });

  /** Closes only one specific pooled instance so a failure in one scope never tears down sibling scopes. */
  const closePooledInstance = Effect.fn("McpGateway.closePooledInstance")(function* (
    serverId: HarnessMcpServerId,
    key: string,
    expected: PooledUpstream,
  ) {
    const record = getOrCreateRecord(serverId);
    yield* record.lock.withPermits(1)(
      Effect.gen(function* () {
        if (pool.get(key) !== expected) return;
        yield* closePooled(key);
        if (record.stateByDigest.get(expected.scopeKey)?.state === "connected") {
          setDigestState(record, expected.scopeKey, "idle", null);
        }
      }),
    );
  });

  const closeAll = Effect.gen(function* () {
    const serverIds = new Set<HarnessMcpServerId>();
    for (const pooled of pool.values()) {
      serverIds.add(pooled.serverId);
    }
    for (const serverId of serverIds) {
      yield* closeAllForServer(serverId);
    }
    for (const key of Array.from(pool.keys())) {
      yield* closePooled(key);
    }
  });

  const evictIdle: McpGateway["Service"]["evictIdle"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const entries = Array.from(pool.entries());
    for (const [key, pooled] of entries) {
      const record = getOrCreateRecord(pooled.serverId);
      yield* record.lock.withPermits(1)(
        Effect.gen(function* () {
          const live = pool.get(key);
          if (!live) return;
          if (live.connection.isClosed() || now - live.lastUsedMs >= idleTtlMs) {
            yield* closePooled(key);
            const currentState = record.stateByDigest.get(live.scopeKey);
            if (currentState?.state === "connected") {
              setDigestState(record, live.scopeKey, "idle", null);
            }
          }
        }),
      );
    }
  }).pipe(Effect.withSpan("McpGateway.evictIdle"));

  // Scoped reaper cleans up idle stdio MCP processes and tears down all children on server exit.
  const reaperFiber = yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(Duration.millis(Math.max(5_000, Math.min(idleTtlMs, 60_000)))).pipe(
        Effect.andThen(evictIdle),
      ),
    ),
  );
  yield* Effect.addFinalizer(() => Fiber.interrupt(reaperFiber).pipe(Effect.andThen(closeAll)));

  const assertServerRunnable = (
    server: HarnessStore.ResolvedHarnessMcpServer,
  ): Effect.Effect<void, HarnessError> => {
    if (server.blockedByPolicyReason !== null) {
      return Effect.fail(
        new HarnessError({
          code: "policy_denied",
          serverId: server.id,
          detail: server.blockedByPolicyReason,
        }),
      );
    }
    if (!server.trusted || server.needsTrustConfirmation) {
      return Effect.fail(
        new HarnessError({
          code: "untrusted",
          serverId: server.id,
          detail: `Project MCP server "${server.id}" must be trusted by the environment owner before running.`,
        }),
      );
    }
    if (!server.effectiveEnabled) {
      return Effect.fail(
        new HarnessError({
          code: "invalid_config",
          serverId: server.id,
          detail: `MCP server "${server.id}" is disabled.`,
        }),
      );
    }
    return Effect.void;
  };

  /** Caller MUST hold `record.lock`. Closes unpooled connections on error, defect, or fiber interrupt. */
  const ensureConnectedUnlocked = Effect.fn("McpGateway.ensureConnectedUnlocked")(function* (
    server: HarnessStore.ResolvedHarnessMcpServer,
    record: ServerRuntimeRecord,
  ): Effect.fn.Return<PooledUpstream, HarnessError> {
    yield* assertServerRunnable(server);
    const scopeKey = runtimeScopeKey(server);
    const key = poolKeyFor(server);
    const existing = pool.get(key);
    if (existing && !existing.connection.isClosed()) {
      existing.lastUsedMs = yield* Clock.currentTimeMillis;
      return existing;
    }
    // Close any older or closed config revision for this same server scope before starting the new one.
    const scopePrefix = runtimeScopePrefix(server);
    for (const staleKey of Array.from(pool.keys()).filter((k) => k.startsWith(scopePrefix))) {
      yield* closePooled(staleKey);
    }

    setDigestState(record, scopeKey, "starting", null);

    let unpooledConnection: McpUpstreamConnection | null = null;

    return yield* Effect.gen(function* () {
      const rawMap =
        server.config.transport.type === "stdio"
          ? server.config.transport.env
          : server.config.transport.headers;
      const { resolved, missingPlaceholders, sensitiveValues } = yield* resolveSecretRecord(
        rawMap,
      ).pipe(
        Effect.provideService(SecretResolver.SecretResolver, secretResolver),
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );
      record.logs.addSecretValues(sensitiveValues);
      if (missingPlaceholders.length > 0) {
        const detail = `Missing secrets for MCP server "${server.id}": ${missingPlaceholders.join(", ")}`;
        setDigestState(record, scopeKey, "error", detail);
        record.logs.append("lifecycle", detail);
        return yield* new HarnessError({
          code: "invalid_config",
          serverId: server.id,
          detail,
        });
      }

      const connection = yield* connect({
        serverId: server.id,
        transport: server.config.transport,
        resolvedEnvOrHeaders: resolved,
        sensitiveValues,
        logs: record.logs,
      }).pipe(
        Effect.mapError(
          (error) =>
            new HarnessError({
              code: error.code,
              serverId: error.serverId ?? server.id,
              detail: scrubHarnessLogText(error.detail, sensitiveValues),
            }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            setDigestState(record, scopeKey, "error", error.detail);
          }),
        ),
      );
      unpooledConnection = connection;

      const tools = yield* connection.listTools().pipe(
        Effect.mapError(
          (error) =>
            new HarnessError({
              code: error.code,
              serverId: error.serverId ?? server.id,
              detail: scrubHarnessLogText(error.detail, sensitiveValues),
            }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            setDigestState(record, scopeKey, "error", error.detail);
          }),
        ),
      );

      const now = yield* Clock.currentTimeMillis;
      const pooled: PooledUpstream = {
        serverId: server.id,
        scopeKey,
        configDigest: server.configDigest,
        transportType: server.config.transport.type,
        connection,
        tools,
        lastUsedMs: now,
      };
      pool.set(key, pooled);
      unpooledConnection = null;
      setDigestState(record, scopeKey, "connected", null);
      record.toolsByDigest.set(scopeKey, tools);
      if (record.toolsByDigest.size > 8) {
        const oldestDigest = record.toolsByDigest.keys().next().value;
        if (oldestDigest !== undefined) record.toolsByDigest.delete(oldestDigest);
      }
      return pooled;
    }).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void;
        const closeUnpooled =
          unpooledConnection !== null
            ? unpooledConnection.close().pipe(Effect.ignore)
            : Effect.void;
        return closeUnpooled.pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (record.stateByDigest.get(scopeKey)?.state === "starting") {
                setDigestState(record, scopeKey, "idle", null);
              }
            }),
          ),
        );
      }),
    );
  });

  /**
   * Acquires the per-server lifecycle lock and re-reads current workspace trust, enabled state,
   * managed policy, and routing channel inside the lock so queued discovery/call fibers can never
   * start a server that was disabled, revoked, or re-routed while waiting.
   */
  const ensureConnectedFresh = Effect.fn("McpGateway.ensureConnectedFresh")(function* (input: {
    readonly serverId: HarnessMcpServerId;
    readonly scope: HarnessStore.ResolvedHarnessMcpServer["scope"];
    readonly workspaceRoot: string | undefined;
    readonly harnessCapabilities: OrchestrationV2HarnessCapabilities | undefined;
  }): Effect.fn.Return<
    {
      readonly server: HarnessStore.ResolvedHarnessMcpServer;
      readonly pooled: PooledUpstream;
    },
    HarnessError
  > {
    const record = getOrCreateRecord(input.serverId);
    return yield* record.lock.withPermits(1)(
      Effect.gen(function* () {
        const freshWorkspace = yield* store.resolveWorkspace(input.workspaceRoot);
        if (!freshWorkspace.managedPolicyAllowsHarness) {
          return yield* new HarnessError({
            code: "policy_denied",
            serverId: input.serverId,
            detail: "Organization policy does not allow portable harness extensions.",
          });
        }
        const freshServer = freshWorkspace.servers.find(
          (candidate) => candidate.id === input.serverId && candidate.scope === input.scope,
        );
        if (freshServer === undefined) {
          return yield* new HarnessError({
            code: "not_found",
            serverId: input.serverId,
            detail: `MCP server "${input.serverId}" is no longer configured.`,
          });
        }
        yield* assertServerRunnable(freshServer);
        if (resolveServerChannel(freshServer.config, input.harnessCapabilities) !== "gateway") {
          return yield* new HarnessError({
            code: "not_found",
            serverId: input.serverId,
            detail: `MCP server "${input.serverId}" is routed natively for this provider and is not callable through the T3 Harness gateway.`,
          });
        }
        const pooled = yield* ensureConnectedUnlocked(freshServer, record);
        return { server: freshServer, pooled };
      }),
    );
  });

  const deriveServerView = (
    server: HarnessStore.ResolvedHarnessMcpServer,
  ): HarnessMcpServerView => {
    const record = records.get(server.id);
    const scopeKey = runtimeScopeKey(server);
    const key = poolKeyFor(server);
    const pooled = pool.get(key);
    const liveConnected = pooled !== undefined && !pooled.connection.isClosed();

    const digestState = record?.stateByDigest.get(scopeKey);
    let state: HarnessMcpServerState;
    let lastError = digestState?.lastError ? scrubHarnessLogText(digestState.lastError) : null;
    if (server.blockedByPolicyReason !== null) {
      state = "blocked_by_policy";
      lastError = server.blockedByPolicyReason;
    } else if (server.needsTrustConfirmation) {
      state = "untrusted";
    } else if (!server.effectiveEnabled) {
      state = "disabled";
    } else if (liveConnected) {
      state = "connected";
    } else if (digestState?.state === "starting") {
      state = "starting";
    } else if (digestState?.state === "error") {
      state = "error";
    } else {
      state = "idle";
    }

    const discoveredTools = liveConnected ? pooled.tools : record?.toolsByDigest.get(scopeKey);
    const filteredTools = filterAllowedTools(server.config, discoveredTools ?? []);
    const tools: ReadonlyArray<HarnessMcpToolSummary> = filteredTools.map((tool) => ({
      name: tool.name,
      exposedName: canonicalExposedToolName(server.id, tool.name),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      readOnly: tool.annotations?.readOnlyHint === true,
    }));

    return {
      id: server.id,
      scope: server.scope,
      config: redactHarnessServerConfig(server.config),
      configDigest: server.configDigest,
      effectiveEnabled: server.effectiveEnabled,
      state,
      toolCount: tools.length,
      tools,
      ...(discoveredTools === undefined
        ? {}
        : { discoveredToolNames: discoveredTools.map((tool) => tool.name).toSorted() }),
      estimatedToolListBytes: estimateToolsBytes(tools),
      lastError,
      needsTrustConfirmation: server.needsTrustConfirmation,
      trustReason: server.trustReason,
      requiresSecretAccess: server.requiresSecretAccess,
      trustDigest: server.trustDigest,
      repoRoot: server.repoRoot,
      overriddenByProject: server.overriddenByProject,
      stderrLinesCount: record?.logs.count() ?? 0,
    };
  };

  const getSnapshot: McpGateway["Service"]["getSnapshot"] = Effect.fn("McpGateway.getSnapshot")(
    function* (workspaceRoot) {
      const workspace = yield* store.resolveWorkspace(workspaceRoot);
      return {
        harnessDir: workspace.harnessDir,
        configPath: workspace.configPath,
        workspaceRoot: workspace.workspaceRoot,
        servers: workspace.servers.map(deriveServerView),
        invalidEntries: workspace.invalidEntries,
        managedPolicyAllowsHarness: workspace.managedPolicyAllowsHarness,
        managedPolicyAllowsStdio: workspace.managedPolicyAllowsStdio,
        managedPolicyOrganization: workspace.managedPolicyOrganization,
      };
    },
  );

  const getLogs: McpGateway["Service"]["getLogs"] = (serverId) =>
    Effect.sync(() => {
      const record = records.get(serverId);
      return {
        serverId,
        lines: record ? record.logs.snapshot() : [],
      };
    }).pipe(Effect.withSpan("McpGateway.getLogs"));

  const invalidateServer: McpGateway["Service"]["invalidateServer"] = Effect.fn(
    "McpGateway.invalidateServer",
  )(function* (serverId) {
    yield* closeAllForServer(serverId);
  });

  const restartServer: McpGateway["Service"]["restartServer"] = Effect.fn(
    "McpGateway.restartServer",
  )(function* <E = never>({
    serverId,
    workspaceRoot,
    authorize,
  }: {
    readonly serverId: HarnessMcpServerId;
    readonly workspaceRoot?: string | undefined;
    readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
  }): Effect.fn.Return<HarnessMcpSnapshot, HarnessError | E> {
    const record = getOrCreateRecord(serverId);
    // Re-read config, policy, and trust inside the per-server lifecycle lock so a concurrent
    // trust revocation or disable can never be bypassed by a queued restart snapshot.
    yield* record.lock.withPermits(1)(
      Effect.gen(function* () {
        const workspace = yield* store.resolveWorkspace(workspaceRoot);
        const server =
          workspace.servers.find(
            (candidate) => candidate.id === serverId && candidate.scope === "project",
          ) ?? workspace.servers.find((candidate) => candidate.id === serverId);
        if (!server) {
          return yield* new HarnessError({
            code: "not_found",
            serverId,
            detail: `MCP server "${serverId}" was not found.`,
          });
        }
        if (authorize !== undefined) {
          yield* authorize(server.config);
        }
        if (server.blockedByPolicyReason !== null) {
          return yield* new HarnessError({
            code: "policy_denied",
            serverId,
            detail: server.blockedByPolicyReason,
          });
        }
        if (server.needsTrustConfirmation || !server.trusted) {
          return yield* new HarnessError({
            code: "untrusted",
            serverId,
            detail: `Project MCP server "${serverId}" requires trust confirmation before starting.`,
          });
        }
        yield* closeAllForServerUnlocked(serverId);
        if (server.effectiveEnabled) {
          yield* ensureConnectedUnlocked(server, record).pipe(Effect.ignore);
        }
      }),
    );
    return yield* getSnapshot(workspaceRoot);
  });

  const resolveSessionInjection: McpGateway["Service"]["resolveSessionInjection"] = Effect.fn(
    "McpGateway.resolveSessionInjection",
  )(function* (input) {
    const workspace = yield* store.resolveWorkspace(input.workspaceRoot);
    if (!workspace.managedPolicyAllowsHarness) {
      return { harnessActive: false, gatewayServersDigest: "", nativeMcpServers: [] };
    }
    const needsProposePlan =
      input.interactionMode === "plan" && !input.emitsProposedPlan && input.supportsMcpTools;

    const nativeMcpServers: Array<HarnessNativeMcpServer> = [];
    const gatewayServerFingerprints: Array<string> = [];

    for (const server of workspace.servers) {
      if (
        !server.effectiveEnabled ||
        !server.trusted ||
        server.needsTrustConfirmation ||
        server.blockedByPolicyReason !== null
      ) {
        continue;
      }
      const channel = resolveServerChannel(server.config, input.harnessCapabilities);
      if (channel === "gateway") {
        gatewayServerFingerprints.push(`${server.scope}:${server.id}:${server.configDigest}`);
        continue;
      }
      const rawMap =
        server.config.transport.type === "stdio"
          ? server.config.transport.env
          : server.config.transport.headers;
      const { resolved, missingPlaceholders } = yield* resolveSecretRecord(rawMap).pipe(
        Effect.provideService(SecretResolver.SecretResolver, secretResolver),
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );
      if (missingPlaceholders.length > 0) {
        // Keep the error visible on the gateway path instead of silently passing broken placeholders to a CLI.
        gatewayServerFingerprints.push(
          `${server.scope}:${server.id}:${server.configDigest}:missing-secret`,
        );
        continue;
      }
      if (server.config.transport.type === "stdio") {
        nativeMcpServers.push({
          id: server.id,
          type: "stdio",
          command: server.config.transport.command,
          args: server.config.transport.args ?? [],
          ...(server.config.transport.cwd ? { cwd: server.config.transport.cwd } : {}),
          ...(Object.keys(resolved).length > 0 ? { env: resolved } : {}),
        });
      } else {
        nativeMcpServers.push({
          id: server.id,
          type: server.config.transport.type,
          url: server.config.transport.url,
          ...(Object.keys(resolved).length > 0 ? { headers: resolved } : {}),
        });
      }
    }

    gatewayServerFingerprints.sort();
    const gatewayServersDigest = NodeCrypto.createHash("sha256")
      .update(`${needsProposePlan ? "1" : "0"}\u0000${gatewayServerFingerprints.join("\u001f")}`)
      .digest("hex")
      .slice(0, 24);

    return {
      harnessActive: needsProposePlan || gatewayServerFingerprints.length > 0,
      gatewayServersDigest,
      nativeMcpServers,
    };
  });

  const collectAllGatewayTools = Effect.fn("McpGateway.collectAllGatewayTools")(function* (
    context: GatewaySessionContext,
  ) {
    const workspace = yield* store.resolveWorkspace(context.workspaceRoot);
    if (!workspace.managedPolicyAllowsHarness) {
      return [] as ReadonlyArray<GatewayExposedTool>;
    }
    const activeGatewayServers = workspace.servers.filter(
      (server) =>
        server.effectiveEnabled &&
        server.trusted &&
        !server.needsTrustConfirmation &&
        server.blockedByPolicyReason === null &&
        resolveServerChannel(server.config, context.harnessCapabilities) === "gateway",
    );

    const connectedResults = yield* Effect.forEach(
      activeGatewayServers,
      (server) =>
        ensureConnectedFresh({
          serverId: server.id,
          scope: server.scope,
          workspaceRoot: context.workspaceRoot,
          harnessCapabilities: context.harnessCapabilities,
        }).pipe(
          Effect.map(({ server: freshServer, pooled }) => ({
            server: freshServer,
            pooled: pooled as PooledUpstream | null,
            tools: pooled.tools,
            configDigest: freshServer.configDigest as string | null,
          })),
          Effect.orElseSucceed(() => ({
            server,
            pooled: null as PooledUpstream | null,
            tools: [] as ReadonlyArray<UpstreamMcpTool>,
            configDigest: null as string | null,
          })),
        ),
      { concurrency: 4 },
    );

    // Re-check workspace state, connection identity, and liveness after concurrent connections
    // finish so any server revoked, reconnected, or exited while siblings connected is excluded.
    const postWorkspace = yield* store.resolveWorkspace(context.workspaceRoot);
    if (!postWorkspace.managedPolicyAllowsHarness) {
      return [] as ReadonlyArray<GatewayExposedTool>;
    }
    const stillActive = connectedResults.filter((entry) => {
      if (entry.configDigest === null || entry.pooled === null || entry.tools.length === 0) {
        return false;
      }
      if (entry.pooled.connection.isClosed()) {
        return false;
      }
      const current = postWorkspace.servers.find(
        (candidate) => candidate.id === entry.server.id && candidate.scope === entry.server.scope,
      );
      if (current === undefined) return false;
      return (
        current.configDigest === entry.configDigest &&
        current.effectiveEnabled &&
        current.trusted &&
        !current.needsTrustConfirmation &&
        current.blockedByPolicyReason === null &&
        resolveServerChannel(current.config, context.harnessCapabilities) === "gateway" &&
        pool.get(poolKeyFor(current)) === entry.pooled
      );
    });

    return buildGatewayExposedCatalog(stillActive).tools;
  });

  const recordSessionLoadedTools = (
    providerSessionId: string,
    names: ReadonlyArray<string>,
  ): void => {
    const set = loadedBySession.get(providerSessionId) ?? new Set<string>();
    loadedBySession.delete(providerSessionId);
    loadedBySession.set(providerSessionId, set);
    for (const name of names) set.add(name);
    for (const oldest of loadedBySession.keys()) {
      if (loadedBySession.size <= MAX_EXPOSURE_SESSIONS) break;
      loadedBySession.delete(oldest);
    }
  };

  const listToolsForSession: McpGateway["Service"]["listToolsForSession"] = Effect.fn(
    "McpGateway.listToolsForSession",
  )(function* (context) {
    const workspace = yield* store.resolveWorkspace(context.workspaceRoot);
    if (!workspace.managedPolicyAllowsHarness) {
      return [];
    }
    const upstreamTools = yield* collectAllGatewayTools(context);
    const shouldDefer =
      upstreamTools.length > 0 &&
      (context.deferredExposure || upstreamTools.length > DEFERRED_THRESHOLD_TOOLS);

    const listed: Array<GatewayExposedTool> = [];
    if (context.includeProposePlan) {
      listed.push(HARNESS_PROPOSE_PLAN_DEF);
    }
    if (!shouldDefer) {
      listed.push(...upstreamTools);
      return listed;
    }

    listed.push(HARNESS_TOOL_SEARCH_DEF);
    const loaded = loadedBySession.get(context.providerSessionId);
    if (loaded) {
      for (const tool of upstreamTools) {
        if (loaded.has(tool.exposedName)) {
          listed.push(tool);
        }
      }
    }
    return listed;
  });

  const callToolForSession: McpGateway["Service"]["callToolForSession"] = Effect.fn(
    "McpGateway.callToolForSession",
  )(function* ({ context, toolName, arguments: args }) {
    const workspace = yield* store.resolveWorkspace(context.workspaceRoot);
    if (!workspace.managedPolicyAllowsHarness) {
      return yield* new HarnessError({
        code: "policy_denied",
        detail: `${workspace.managedPolicyOrganization ?? "Organization"}'s policy does not allow portable harness extensions.`,
      });
    }

    if (toolName === HARNESS_TOOL_SEARCH_NAME) {
      const query = typeof args.query === "string" ? args.query : "";
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter(Boolean);
      const allUpstream = yield* collectAllGatewayTools(context);
      const matches =
        terms.length === 0
          ? allUpstream.slice(0, MAX_SEARCH_RESULTS)
          : allUpstream
              .map((tool) => ({ tool, score: scoreToolMatch(tool, terms) }))
              .filter((item) => item.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, MAX_SEARCH_RESULTS)
              .map((item) => item.tool);
      if (matches.length > 0) {
        recordSessionLoadedTools(
          context.providerSessionId,
          matches.map((tool) => tool.exposedName),
        );
      }
      return {
        content: [
          {
            type: "text",
            text:
              matches.length === 0
                ? `No harness MCP tools matched "${query}".`
                : `Loaded ${matches.length} harness MCP tool(s):\n${matches
                    .map((tool) => `- ${tool.exposedName}: ${tool.description}`)
                    .join("\n")}`,
          },
        ],
        structuredContent: {
          tools: matches.map((tool) => ({
            name: tool.exposedName,
            description: tool.description,
            readOnly: tool.readOnly,
          })),
        },
      };
    }

    const decodedTool = decodeCanonicalExposedToolName(toolName);
    const prefixMatchingServers =
      decodedTool === null
        ? []
        : workspace.servers.filter((server) => server.id === decodedTool.serverId);
    if (prefixMatchingServers.length === 0) {
      return yield* new HarnessError({
        code: "not_found",
        detail: `Unknown harness tool "${toolName}".`,
      });
    }

    // Only connect active gateway-routed servers whose id prefixes `toolName` — preserving
    // lazy startup for unrelated servers while including the entire collision equivalence class.
    const activeGatewayCandidates = prefixMatchingServers.filter(
      (server) =>
        server.effectiveEnabled &&
        server.trusted &&
        !server.needsTrustConfirmation &&
        server.blockedByPolicyReason === null &&
        resolveServerChannel(server.config, context.harnessCapabilities) === "gateway",
    );

    if (activeGatewayCandidates.length === 0) {
      const primary = [...prefixMatchingServers].sort(
        (left, right) =>
          right.id.length - left.id.length ||
          (left.scope === "project" ? -1 : 1) - (right.scope === "project" ? -1 : 1),
      )[0]!;
      if (primary.blockedByPolicyReason !== null) {
        return yield* new HarnessError({
          code: "policy_denied",
          serverId: primary.id,
          detail: primary.blockedByPolicyReason,
        });
      }
      if (primary.needsTrustConfirmation || !primary.trusted) {
        return yield* new HarnessError({
          code: "untrusted",
          serverId: primary.id,
          detail: `Project MCP server "${primary.id}" must be trusted by the environment owner before running.`,
        });
      }
      if (!primary.effectiveEnabled) {
        return yield* new HarnessError({
          code: "invalid_config",
          serverId: primary.id,
          detail: `MCP server "${primary.id}" is disabled.`,
        });
      }
      return yield* new HarnessError({
        code: "not_found",
        serverId: primary.id,
        detail: `MCP server "${primary.id}" is routed natively for this provider and is not callable through the T3 Harness gateway.`,
      });
    }

    const connectedCandidates: Array<{
      readonly server: HarnessStore.ResolvedHarnessMcpServer;
      readonly pooled: PooledUpstream;
    }> = [];
    let firstConnectError: HarnessError | null = null;
    for (const candidate of activeGatewayCandidates) {
      const result = yield* ensureConnectedFresh({
        serverId: candidate.id,
        scope: candidate.scope,
        workspaceRoot: context.workspaceRoot,
        harnessCapabilities: context.harnessCapabilities,
      }).pipe(Effect.result);
      if (Result.isSuccess(result)) {
        connectedCandidates.push(result.success);
      } else if (firstConnectError === null) {
        firstConnectError = result.failure;
      }
    }

    if (connectedCandidates.length === 0 && firstConnectError !== null) {
      return yield* firstConnectError;
    }

    const catalog = buildGatewayExposedCatalog(
      connectedCandidates.map(({ server, pooled }) => ({ server, tools: pooled.tools })),
    );
    const binding = catalog.byExposedName.get(toolName);
    if (binding === undefined) {
      if (firstConnectError !== null) {
        return yield* firstConnectError;
      }
      const fallbackServerId = activeGatewayCandidates[0]!.id;
      return yield* new HarnessError({
        code: "not_found",
        serverId: fallbackServerId,
        detail: `Tool "${toolName}" is not available on T3 Harness gateway.`,
      });
    }

    const { server, tool: targetTool } = binding;
    const serverId = server.id;
    const upstreamToolName = targetTool.name;
    const pooled = connectedCandidates.find(
      (entry) => entry.server.id === server.id && entry.server.scope === server.scope,
    )!.pooled;

    const isReadOnlyAnnotated = targetTool.annotations?.readOnlyHint === true;
    const isExplicitlyAllowlisted =
      server.config.allowedTools !== undefined &&
      server.config.allowedTools.includes(upstreamToolName);
    const policy = server.config.approvalPolicy;

    // 1. Server policy `always-ask` always fails closed until interactive gateway prompts exist.
    if (policy === "always-ask") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Blocked "${toolName}" because MCP server "${serverId}" is configured with "always-ask" policy. Interactive gateway approval is not yet enabled; update the server's policy in Harness settings to permit execution.`,
          },
        ],
      };
    }

    // 2. Plan mode enforces read-only gating on gateway-hosted MCP tools.
    if (context.interactionMode === "plan" && !isReadOnlyAnnotated) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Blocked "${toolName}" in Plan mode because it is not marked read-only. Switch back to Default mode to run mutating tools.`,
          },
        ],
      };
    }

    // 3. Server policy `auto-read` never silently executes non-read-only tools.
    if (policy === "auto-read" && !isReadOnlyAnnotated) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Blocked "${toolName}" because MCP server "${serverId}" policy is "auto-read" and this tool is not read-only. Switch the server policy to "auto-all" in Harness settings and use Full access mode to allow mutating tools.`,
          },
        ],
      };
    }

    // 4. Supervised runtime modes enforce ceiling:
    //    - Mutating tools require `full-access` even under `auto-all`.
    //    - In `approval-required`, upstream `readOnlyHint` alone never bypasses approval unless
    //      the owner explicitly pinned the tool in `allowedTools`.
    if (!isReadOnlyAnnotated && context.runtimeMode !== "full-access") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Blocked mutating tool "${toolName}" because this thread runs in "${context.runtimeMode}" mode. Switch the thread to Full access mode to allow mutating gateway tools.`,
          },
        ],
      };
    }
    if (context.runtimeMode === "approval-required" && !isExplicitlyAllowlisted) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Blocked "${toolName}" in Approval-required mode: upstream readOnlyHint annotations alone do not bypass approval. Add "${upstreamToolName}" to the server's Allowed tools list or switch the thread out of Approval-required mode.`,
          },
        ],
      };
    }

    // Re-verify live workspace trust, policy, config revision, and pool membership right before
    // dispatch so a revocation or edit occurring while sibling candidates connected can never execute.
    const preDispatchWorkspace = yield* store.resolveWorkspace(context.workspaceRoot);
    if (!preDispatchWorkspace.managedPolicyAllowsHarness) {
      return yield* new HarnessError({
        code: "policy_denied",
        serverId,
        detail: "Organization policy does not allow portable harness extensions.",
      });
    }
    const latestServer = preDispatchWorkspace.servers.find(
      (candidate) => candidate.id === server.id && candidate.scope === server.scope,
    );
    if (latestServer === undefined) {
      return yield* new HarnessError({
        code: "not_found",
        serverId,
        detail: `MCP server "${serverId}" is no longer configured.`,
      });
    }
    yield* assertServerRunnable(latestServer);
    if (resolveServerChannel(latestServer.config, context.harnessCapabilities) !== "gateway") {
      return yield* new HarnessError({
        code: "not_found",
        serverId,
        detail: `MCP server "${serverId}" is routed natively for this provider and is not callable through the T3 Harness gateway.`,
      });
    }
    const expectedPoolKey = poolKeyFor(latestServer);
    if (
      latestServer.configDigest !== server.configDigest ||
      runtimeScopeKey(latestServer) !== runtimeScopeKey(server) ||
      pooled.connection.isClosed() ||
      pool.get(expectedPoolKey) !== pooled
    ) {
      return yield* new HarnessError({
        code: "invalid_config",
        serverId,
        detail: `MCP server "${serverId}" configuration or trust changed before tool execution. Retry the call.`,
      });
    }

    pooled.lastUsedMs = yield* Clock.currentTimeMillis;
    return yield* pooled.connection
      .callTool(upstreamToolName, args)
      .pipe(
        Effect.tapError(() =>
          pooled.connection.isClosed()
            ? closePooledInstance(serverId, expectedPoolKey, pooled)
            : Effect.void,
        ),
      );
  });

  return McpGateway.of({
    getSnapshot,
    getLogs,
    restartServer,
    invalidateServer,
    resolveSessionInjection,
    listToolsForSession,
    callToolForSession,
    evictIdle,
  });
});

export const layer = Layer.effect(McpGateway, makeWithOptions());
