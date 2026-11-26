// @effect-diagnostics nodeBuiltinImport:off -- Deterministic SHA-256 suffix for collision-free MCP tool names and gateway catalog digests.
import * as NodeCrypto from "node:crypto";
import {
  HarnessError,
  type HarnessGatewayApprovalTarget,
  type HarnessMcpLogsResult,
  type HarnessMcpServerConfig,
  type HarnessMcpServerId,
  type HarnessMcpRestartInput,
  type HarnessMcpServerState,
  type HarnessMcpServerView,
  type HarnessMcpSnapshot,
  type HarnessMcpToolSummary,
  type HarnessModeEntry,
  type OrchestrationV2HarnessCapabilities,
  type ProviderInteractionMode,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderSessionId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import type { HarnessNativeMcpServer } from "@t3tools/provider-core/server/mcpSession";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
import { isMcpServerAllowedByMode } from "./HarnessProjector.ts";
import * as HarnessStore from "./HarnessStore.ts";
import {
  connectUpstream,
  type McpUpstreamConnection,
  RingLogBuffer,
  type UpstreamMcpCallResult,
  type UpstreamMcpResource,
  type UpstreamMcpResourceReadResult,
  type UpstreamMcpTool,
} from "./McpUpstreamClient.ts";
import * as HarnessMcpOAuthService from "./HarnessMcpOAuthService.ts";
import * as HarnessApprovalAuditStore from "./HarnessApprovalAuditStore.ts";

const HARNESS_TOOL_SEARCH_NAME = "harness_tool_search";
export const HARNESS_PROPOSE_PLAN_NAME = "propose_plan";
export const HARNESS_SKILL_SEARCH_NAME = "harness_skill_search";
export const HARNESS_SKILL_LOAD_NAME = "harness_skill_load";
export const HARNESS_RULE_READ_NAME = "harness_rule_read";
export const HARNESS_WRITE_SKILL_NAME = "harness_write_skill";
export const HARNESS_CREATE_MODE_NAME = "harness_create_mode";
export const HARNESS_WORKFLOW_VALIDATE_NAME = "workflow_validate";
export const HARNESS_PLUGIN_PACK_NAME = "plugin_pack";
export const HARNESS_MEMORY_SEARCH_NAME = "harness_memory_search";
export const HARNESS_MEMORY_READ_NAME = "harness_memory_read";
export const HARNESS_MEMORY_WRITE_NAME = "harness_memory_write";

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
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface GatewayExposedResource {
  readonly uri: string;
  readonly serverId: HarnessMcpServerId;
  readonly upstreamUri: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface GatewaySessionContext {
  readonly providerSessionId: string;
  readonly workspaceRoot?: string | undefined;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly activeMode?: HarnessModeEntry | null | undefined;
  readonly includeProposePlan: boolean;
  readonly includeLibraryTools?: boolean | undefined;
  readonly includeCreatorTools?: boolean | undefined;
  readonly includeMemoryTools?: boolean | undefined;
  readonly deferredExposure: boolean;
  readonly harnessCapabilities?: OrchestrationV2HarnessCapabilities | undefined;
  readonly approval?: GatewayApprovalContext | undefined;
}

export interface GatewayApprovalContext {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId?: ProviderSessionId | undefined;
  readonly request?: (input: {
    readonly target: HarnessGatewayApprovalTarget;
    readonly readOnly: boolean;
    readonly argumentCount: number;
    readonly argumentNames: ReadonlyArray<string>;
  }) => Effect.Effect<
    { readonly decision: ProviderApprovalDecision; readonly feedback?: string | undefined },
    HarnessError
  >;
  readonly validate?: (input: {
    readonly serverId: HarnessMcpServerId;
    readonly readOnly: boolean;
  }) => Effect.Effect<void, HarnessError>;
}

/**
 * Shared authorization ceiling enforced across all `/mcp/harness` tools (upstream MCP,
 * Memory, Creator, and SDK plugin tools) in both `tools/list` and `tools/call`.
 */
export function checkHarnessRuntimeToolCeiling(input: {
  readonly toolName: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly activeMode?: Pick<HarnessModeEntry, "id" | "readonly"> | null | undefined;
  readonly readOnly: boolean;
  readonly isBuiltInReadOnly?: boolean | undefined;
  readonly explicitlyAllowlisted?: boolean | undefined;
}): string | null {
  const effectiveReadOnly = input.interactionMode === "plan" || input.activeMode?.readonly === true;
  if (!input.readOnly && effectiveReadOnly) {
    const modeLabel =
      input.interactionMode !== "plan" && input.activeMode?.readonly
        ? `read-only mode "${input.activeMode.id}"`
        : "Plan mode";
    return `Blocked "${input.toolName}" in ${modeLabel} because it is not marked read-only.`;
  }
  if (!input.readOnly && input.runtimeMode !== "full-access") {
    return `Blocked mutating tool "${input.toolName}" because this thread runs in "${input.runtimeMode}" mode. Switch the thread to Full access mode to allow mutating harness tools.`;
  }
  if (
    input.runtimeMode === "approval-required" &&
    input.isBuiltInReadOnly !== true &&
    input.explicitlyAllowlisted !== true
  ) {
    return `Blocked "${input.toolName}" in Approval-required mode: readOnlyHint annotations alone do not bypass approval. Explicitly allowlist the tool or switch the thread out of Approval-required mode.`;
  }
  return null;
}

function checkUpstreamToolPolicy(
  input: Parameters<typeof checkHarnessRuntimeToolCeiling>[0] & {
    readonly serverPolicy: HarnessMcpServerConfig["approvalPolicy"];
  },
): "allow" | "ask" | { readonly deny: string } {
  const denied = checkHarnessRuntimeToolCeiling({ ...input, runtimeMode: "full-access" });
  if (denied !== null) return { deny: denied };
  if (
    (input.serverPolicy === "auto-all" && input.runtimeMode === "full-access") ||
    (input.serverPolicy === "auto-read" &&
      input.readOnly &&
      (input.runtimeMode !== "approval-required" || input.explicitlyAllowlisted === true))
  )
    return "allow";
  return "ask";
}

function upstreamToolPolicy(context: GatewaySessionContext, binding: CatalogToolBinding) {
  return checkUpstreamToolPolicy({
    toolName: binding.exposed.exposedName,
    serverPolicy: binding.server.config.approvalPolicy,
    readOnly: binding.exposed.readOnly,
    explicitlyAllowlisted: binding.server.config.allowedTools?.includes(binding.tool.name),
    interactionMode: context.interactionMode,
    runtimeMode: context.runtimeMode,
    activeMode: context.activeMode,
  });
}

/** Rewrites MCP Apps `_meta.ui.resourceUri` and legacy `_meta["ui/resourceUri"]` to canonical gateway URIs. */
export function rewriteMcpAppMeta(
  serverId: HarnessMcpServerId,
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;
  let mutated = false;
  const next: Record<string, unknown> = { ...meta };
  const rawUi = next.ui;
  if (rawUi !== null && typeof rawUi === "object" && !Array.isArray(rawUi)) {
    const uiRec = rawUi as Record<string, unknown>;
    if (typeof uiRec.resourceUri === "string" && uiRec.resourceUri.trim().length > 0) {
      next.ui = {
        ...uiRec,
        resourceUri: canonicalExposedResourceUri(serverId, uiRec.resourceUri.trim()),
      };
      mutated = true;
    }
  }
  if (typeof next["ui/resourceUri"] === "string" && next["ui/resourceUri"].trim().length > 0) {
    next["ui/resourceUri"] = canonicalExposedResourceUri(serverId, next["ui/resourceUri"].trim());
    mutated = true;
  }
  return mutated ? next : meta;
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
  state: "idle" | "starting" | "connected" | "error" | "auth_required";
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

/**
 * Injective gateway resource URI mapping: preserves `ui://` scheme for MCP Apps
 * (`ui://<encodedServerId>/<rest>`) and wraps non-`ui://` schemes under `t3-harness://<encodedServerId>/<encodedUri>`.
 */
function canonicalExposedResourceUri(serverId: HarnessMcpServerId, upstreamUri: string): string {
  const encodedServer = encodeURIComponent(serverId);
  if (upstreamUri.startsWith("ui://")) {
    return `ui://${encodedServer}/${upstreamUri.slice("ui://".length)}`;
  }
  return `t3-harness://${encodedServer}/${encodeURIComponent(upstreamUri)}`;
}

function decodeCanonicalExposedResourceUri(
  exposedUri: string,
): { readonly serverId: string; readonly upstreamUri: string } | null {
  if (exposedUri.startsWith("ui://")) {
    const rest = exposedUri.slice("ui://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    try {
      const serverId = decodeURIComponent(rest.slice(0, slash));
      const upstreamRest = rest.slice(slash + 1);
      if (!serverId || !upstreamRest) return null;
      return { serverId, upstreamUri: `ui://${upstreamRest}` };
    } catch {
      return null;
    }
  }
  if (exposedUri.startsWith("t3-harness://")) {
    const rest = exposedUri.slice("t3-harness://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    try {
      const serverId = decodeURIComponent(rest.slice(0, slash));
      const upstreamUri = decodeURIComponent(rest.slice(slash + 1));
      if (!serverId || !upstreamUri) return null;
      return { serverId, upstreamUri };
    } catch {
      return null;
    }
  }
  return null;
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
      const rewrittenMeta = rewriteMcpAppMeta(server.id, tool._meta);
      const exposed: GatewayExposedTool = {
        exposedName: finalName,
        serverId: server.id,
        upstreamName: tool.name,
        description: tool.description ?? `${server.id}/${tool.name}`,
        inputSchema: tool.inputSchema,
        readOnly: tool.annotations?.readOnlyHint === true,
        ...(rewrittenMeta ? { _meta: rewrittenMeta } : {}),
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

const HARNESS_SKILL_SEARCH_DEF: GatewayExposedTool = {
  exposedName: HARNESS_SKILL_SEARCH_NAME,
  serverId: null,
  upstreamName: HARNESS_SKILL_SEARCH_NAME,
  description:
    "Search portable user and repository skills by keyword. Returns skill names, scopes, and summaries so you can load relevant skills with harness_skill_load.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords describing the task or skill to find (empty lists all skills).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  readOnly: true,
};

const HARNESS_SKILL_LOAD_DEF: GatewayExposedTool = {
  exposedName: HARNESS_SKILL_LOAD_NAME,
  serverId: null,
  upstreamName: HARNESS_SKILL_LOAD_NAME,
  description:
    "Load the full SKILL.md instructions and companion file listing for a portable skill by name or id.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Skill id or name returned by harness_skill_search or listed in portable skills.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  readOnly: true,
};

const HARNESS_RULE_READ_DEF: GatewayExposedTool = {
  exposedName: HARNESS_RULE_READ_NAME,
  serverId: null,
  upstreamName: HARNESS_RULE_READ_NAME,
  description:
    "Read the full body of a portable harness rule or overflowing mode (use 'user:AGENTS.md', 'project:AGENTS.md', 'mode:<id>', or a rule id from rules/*.md) when it is manual or exceeded inline context budget.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Rule or mode identifier (e.g. 'user:AGENTS.md', 'mode:review', or 'typescript-style').",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  readOnly: true,
};

const HARNESS_WRITE_SKILL_DEF: GatewayExposedTool = {
  exposedName: HARNESS_WRITE_SKILL_NAME,
  serverId: null,
  upstreamName: HARNESS_WRITE_SKILL_NAME,
  description:
    "Create or update a portable SKILL.md under ~/.t3/harness/skills/<id>/SKILL.md (available in Creator Mode).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Skill id (letters, digits, hyphens, underscores)." },
      name: { type: "string", description: "Optional human-readable display name." },
      description: { type: "string", description: "When agents should activate this skill." },
      body: { type: "string", description: "Markdown instructions body for SKILL.md." },
    },
    required: ["id", "body"],
    additionalProperties: false,
  },
  readOnly: false,
};

const HARNESS_CREATE_MODE_DEF: GatewayExposedTool = {
  exposedName: HARNESS_CREATE_MODE_NAME,
  serverId: null,
  upstreamName: HARNESS_CREATE_MODE_NAME,
  description:
    "Create or update a declarative portable mode under ~/.t3/harness/modes/<id>.md (available in Creator Mode).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Mode id (lowercase letters, digits, hyphens)." },
      name: { type: "string", description: "Display name for the mode." },
      description: { type: "string", description: "Short summary shown in mode switcher." },
      baseInteractionMode: { type: "string", enum: ["default", "plan"] },
      readonly: { type: "boolean" },
      proposePlan: { type: "boolean" },
      allowedMcpServers: { type: "array", items: { type: "string" } },
      includedRules: { type: "array", items: { type: "string" } },
      includedSkills: { type: "array", items: { type: "string" } },
      body: { type: "string", description: "System prompt markdown for this mode." },
    },
    required: ["id", "body"],
    additionalProperties: false,
  },
  readOnly: false,
};

const HARNESS_WORKFLOW_VALIDATE_DEF: GatewayExposedTool = {
  exposedName: HARNESS_WORKFLOW_VALIDATE_NAME,
  serverId: null,
  upstreamName: HARNESS_WORKFLOW_VALIDATE_NAME,
  description:
    "Validate a declarative workflows/*.yaml document (step DAG, modeIds, in-thread/child steps) and preview its compiled T3 workflow.",
  inputSchema: {
    type: "object",
    properties: {
      yaml: { type: "string", description: "Full YAML source of the workflow." },
    },
    required: ["yaml"],
    additionalProperties: false,
  },
  readOnly: true,
};

const HARNESS_PLUGIN_PACK_DEF: GatewayExposedTool = {
  exposedName: HARNESS_PLUGIN_PACK_NAME,
  serverId: null,
  upstreamName: HARNESS_PLUGIN_PACK_NAME,
  description:
    "Create or refresh t3-plugin.json for a plugin under ~/.t3/harness/plugins/<id> and compute its SHA-256 content digest for owner trust review (available in Creator Mode).",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Plugin id (letters, digits, dots, hyphens, underscores).",
      },
      name: { type: "string", description: "Plugin display name." },
      version: { type: "string", description: "Semver version string (e.g. 1.0.0)." },
      description: { type: "string" },
      author: { type: "string" },
    },
    required: ["id", "name", "version"],
    additionalProperties: false,
  },
  readOnly: false,
};

const HARNESS_MEMORY_SEARCH_DEF: GatewayExposedTool = {
  exposedName: HARNESS_MEMORY_SEARCH_NAME,
  serverId: null,
  upstreamName: HARNESS_MEMORY_SEARCH_NAME,
  description:
    "Search portable cross-provider memory notes stored in ~/.t3/harness/memory/*.md by keyword or tag.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional search keywords." },
      tag: { type: "string", description: "Optional exact tag filter." },
      limit: { type: "integer", description: "Maximum notes to return (default 15, max 50)." },
    },
    additionalProperties: false,
  },
  readOnly: true,
};

const HARNESS_MEMORY_READ_DEF: GatewayExposedTool = {
  exposedName: HARNESS_MEMORY_READ_NAME,
  serverId: null,
  upstreamName: HARNESS_MEMORY_READ_NAME,
  description: "Read the full markdown body of a portable memory note by id or title.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Memory note id or title." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  readOnly: true,
};

const HARNESS_MEMORY_WRITE_DEF: GatewayExposedTool = {
  exposedName: HARNESS_MEMORY_WRITE_NAME,
  serverId: null,
  upstreamName: HARNESS_MEMORY_WRITE_NAME,
  description:
    "Create or update a portable markdown memory note under ~/.t3/harness/memory/<id>.md (disabled in Plan mode).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Kebab-case note id (e.g. deploy-notes)." },
      title: { type: "string", description: "Short human-readable title." },
      tags: { type: "array", items: { type: "string" } },
      pinned: { type: "boolean" },
      body: { type: "string", description: "Markdown body to persist." },
    },
    required: ["id", "title", "body"],
    additionalProperties: false,
  },
  readOnly: false,
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
    readonly updateServer: <E>(
      input: {
        readonly serverId: HarnessMcpServerId;
        readonly workspaceRoot?: string | undefined;
        readonly scope: "user" | "project";
      },
      update: Effect.Effect<void, E>,
    ) => Effect.Effect<HarnessMcpSnapshot, HarnessError | E>;
    readonly startOAuth: (
      input: HarnessMcpRestartInput,
    ) => Effect.Effect<{ readonly authorizationUrl: string }, HarnessError>;
    readonly completeOAuth: (
      callbackUrl: string,
      expected?: HarnessMcpRestartInput,
    ) => Effect.Effect<HarnessMcpSnapshot, HarnessError>;
    readonly disconnectOAuth: (
      input: HarnessMcpRestartInput,
    ) => Effect.Effect<HarnessMcpSnapshot, HarnessError>;
    readonly resolveSessionInjection: (input: {
      readonly workspaceRoot?: string | undefined;
      readonly interactionMode: ProviderInteractionMode;
      readonly activeMode?: HarnessModeEntry | null | undefined;
      readonly emitsProposedPlan: boolean;
      readonly supportsMcpTools: boolean;
      readonly harnessCapabilities: OrchestrationV2HarnessCapabilities;
      readonly hasLibraryGatewayTools?: boolean | undefined;
      readonly hasCreatorTools?: boolean | undefined;
      readonly hasMemoryTools?: boolean | undefined;
      readonly sdkToolsDigest?: string | undefined;
      readonly libraryDigest?: string | undefined;
    }) => Effect.Effect<GatewaySessionInjection>;
    readonly listToolsForSession: (
      context: GatewaySessionContext,
    ) => Effect.Effect<ReadonlyArray<GatewayExposedTool>>;
    readonly callToolForSession: (input: {
      readonly context: GatewaySessionContext;
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<UpstreamMcpCallResult, HarnessError>;
    readonly listResourcesForSession: (
      context: GatewaySessionContext,
    ) => Effect.Effect<ReadonlyArray<GatewayExposedResource>>;
    readonly readResourceForSession: (input: {
      readonly context: GatewaySessionContext;
      readonly uri: string;
    }) => Effect.Effect<UpstreamMcpResourceReadResult, HarnessError>;
    readonly evictIdle: Effect.Effect<void>;
  }
>()("t3/harness/McpGateway") {}

export const makeWithOptions = Effect.fn("McpGateway.make")(function* (
  options: McpGatewayOptions = {},
) {
  const store = yield* HarnessStore.HarnessStore;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const oauth = Option.getOrUndefined(
    yield* Effect.serviceOption(HarnessMcpOAuthService.HarnessMcpOAuthService),
  );
  const approvalAudit = Option.getOrUndefined(
    yield* Effect.serviceOption(HarnessApprovalAuditStore.HarnessApprovalAuditStore),
  );

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
    error: HarnessError,
  ) {
    const record = getOrCreateRecord(serverId);
    yield* record.lock.withPermits(1)(
      Effect.gen(function* () {
        if (pool.get(key) !== expected) return;
        yield* closePooled(key);
        if (error.code === "auth_required") {
          setDigestState(record, expected.scopeKey, "auth_required", error.detail);
        } else if (record.stateByDigest.get(expected.scopeKey)?.state === "connected") {
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
        ...(oauth?.supports(server)
          ? {
              oauth: {
                bearer: oauth.bearer(server),
                explicitlyEnabled:
                  server.config.transport.type !== "stdio" &&
                  server.config.transport.oauth?.enabled === true,
                unauthorized: (header, rejectedBearer) =>
                  oauth.unauthorized(server, header, rejectedBearer),
                logs: record.logs,
              },
            }
          : {}),
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
            setDigestState(
              record,
              scopeKey,
              error.code === "auth_required" ? "auth_required" : "error",
              error.detail,
            );
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
            setDigestState(
              record,
              scopeKey,
              error.code === "auth_required" ? "auth_required" : "error",
              error.detail,
            );
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
    } else if (digestState?.state === "error" || digestState?.state === "auth_required") {
      state = digestState.state;
    } else {
      state = "idle";
    }

    const cachedTools = liveConnected ? pooled.tools : (record?.toolsByDigest.get(scopeKey) ?? []);
    const filteredTools = filterAllowedTools(server.config, cachedTools);
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
      const servers =
        oauth === undefined
          ? workspace.servers.map(deriveServerView)
          : yield* Effect.forEach(
              workspace.servers,
              (server) =>
                oauth
                  .status(server)
                  .pipe(Effect.map((status) => ({ ...deriveServerView(server), ...status }))),
              { concurrency: 4 },
            );
      return {
        harnessDir: workspace.harnessDir,
        configPath: workspace.configPath,
        workspaceRoot: workspace.workspaceRoot,
        servers,
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

  const updateServer: McpGateway["Service"]["updateServer"] = Effect.fn("McpGateway.updateServer")(
    function* <E>(
      input: Parameters<McpGateway["Service"]["updateServer"]>[0],
      update: Effect.Effect<void, E>,
    ): Effect.fn.Return<HarnessMcpSnapshot, HarnessError | E> {
      const { serverId, scope, workspaceRoot } = input;
      const readServer = store
        .resolveWorkspace(scope === "user" ? undefined : workspaceRoot)
        .pipe(
          Effect.map((workspace) =>
            workspace.servers.find((server) => server.id === serverId && server.scope === scope),
          ),
        );
      const record = getOrCreateRecord(serverId);
      yield* record.lock.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* readServer;
          yield* update;
          yield* closeAllForServerUnlocked(serverId);
          if (!oauth || !previous || !HarnessMcpOAuthService.oauthCredentialKey(previous)) return;
          const current = yield* readServer;
          if (
            !current ||
            !current.trusted ||
            !oauth.supports(current) ||
            HarnessMcpOAuthService.oauthCredentialKey(previous) !==
              HarnessMcpOAuthService.oauthCredentialKey(current)
          ) {
            yield* oauth.clear(previous);
          }
        }),
      );
      return yield* getSnapshot(workspaceRoot);
    },
  );

  const noOAuth = Effect.fail(
    new HarnessError({ code: "invalid_config", detail: "Harness OAuth is unavailable." }),
  );
  const startOAuth = (input: HarnessMcpRestartInput) => oauth?.start(input) ?? noOAuth;
  const completeOAuth = Effect.fn("McpGateway.completeOAuth")(function* (
    callbackUrl: string,
    expected?: HarnessMcpRestartInput,
  ) {
    const { input, exchanged } = yield* oauth?.complete(callbackUrl, expected) ?? noOAuth;
    if (exchanged) {
      const record = getOrCreateRecord(input.serverId);
      yield* record.lock.withPermits(1)(
        Effect.gen(function* () {
          const workspace = yield* store.resolveWorkspace(input.workspaceRoot);
          const server = workspace.servers.find(
            (entry) => entry.id === input.serverId && entry.effectiveEnabled,
          );
          if (
            !workspace.managedPolicyAllowsHarness ||
            !server?.effectiveEnabled ||
            !server.trusted ||
            !oauth?.supports(server)
          )
            return;
          const key = poolKeyFor(server);
          yield* closePooled(key);
          setDigestState(record, runtimeScopeKey(server), "idle", null);
          yield* ensureConnectedUnlocked(server, record).pipe(Effect.ignore);
        }),
      );
    }
    return yield* getSnapshot(input.workspaceRoot);
  });
  const disconnectOAuth = Effect.fn("McpGateway.disconnectOAuth")(function* (
    input: HarnessMcpRestartInput,
  ) {
    yield* oauth?.disconnect(input) ?? noOAuth;
    yield* invalidateServer(input.serverId);
    return yield* getSnapshot(input.workspaceRoot);
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
      (input.interactionMode === "plan" || input.activeMode?.proposePlan === true) &&
      !input.emitsProposedPlan &&
      input.supportsMcpTools;

    const nativeMcpServers: Array<HarnessNativeMcpServer> = [];
    const gatewayServerFingerprints: Array<string> = [];

    for (const server of workspace.servers) {
      if (
        !server.effectiveEnabled ||
        !server.trusted ||
        server.needsTrustConfirmation ||
        server.blockedByPolicyReason !== null ||
        !isMcpServerAllowedByMode(server.id, input.activeMode)
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
    const hasLibraryTools = input.hasLibraryGatewayTools === true && input.supportsMcpTools;
    const hasCreatorTools = input.hasCreatorTools === true && input.supportsMcpTools;
    const hasMemoryTools = input.hasMemoryTools === true && input.supportsMcpTools;
    const sdkToolsDigest = input.supportsMcpTools ? (input.sdkToolsDigest ?? "") : "";
    const activeModeSig = input.activeMode
      ? `${input.activeMode.id}@${input.activeMode.contentDigest}:${input.activeMode.readonly ? "ro" : "rw"}:${input.activeMode.proposePlan ? "pp" : "no"}`
      : "";
    const gatewayServersDigest = NodeCrypto.createHash("sha256")
      .update(
        `${needsProposePlan ? "1" : "0"}\u0000${hasLibraryTools ? "1" : "0"}\u0000${hasCreatorTools ? "1" : "0"}\u0000${hasMemoryTools ? "1" : "0"}\u0000${sdkToolsDigest}\u0000${activeModeSig}\u0000${input.libraryDigest ?? ""}\u0000${gatewayServerFingerprints.join("\u001f")}`,
      )
      .digest("hex")
      .slice(0, 24);

    return {
      harnessActive:
        needsProposePlan ||
        hasLibraryTools ||
        hasCreatorTools ||
        hasMemoryTools ||
        sdkToolsDigest.length > 0 ||
        gatewayServerFingerprints.length > 0,
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
        isMcpServerAllowedByMode(server.id, context.activeMode) &&
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

    return [...buildGatewayExposedCatalog(stillActive).byExposedName.values()]
      .filter((binding) => {
        const policy = upstreamToolPolicy(context, binding);
        return policy === "allow" || (policy === "ask" && context.approval !== undefined);
      })
      .map(({ exposed }) => exposed);
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
    if (context.includeLibraryTools) {
      listed.push(
        HARNESS_SKILL_SEARCH_DEF,
        HARNESS_SKILL_LOAD_DEF,
        HARNESS_RULE_READ_DEF,
        HARNESS_WORKFLOW_VALIDATE_DEF,
      );
    }
    if (context.includeCreatorTools) {
      const canWriteCreator =
        checkHarnessRuntimeToolCeiling({
          toolName: HARNESS_WRITE_SKILL_NAME,
          interactionMode: context.interactionMode,
          runtimeMode: context.runtimeMode,
          activeMode: context.activeMode,
          readOnly: false,
        }) === null;
      if (canWriteCreator) {
        listed.push(HARNESS_WRITE_SKILL_DEF, HARNESS_CREATE_MODE_DEF);
      }
      if (!context.includeLibraryTools) {
        listed.push(HARNESS_WORKFLOW_VALIDATE_DEF);
      }
      if (canWriteCreator) {
        listed.push(HARNESS_PLUGIN_PACK_DEF);
      }
    }
    if (context.includeMemoryTools) {
      listed.push(HARNESS_MEMORY_SEARCH_DEF, HARNESS_MEMORY_READ_DEF);
      if (
        checkHarnessRuntimeToolCeiling({
          toolName: HARNESS_MEMORY_WRITE_NAME,
          interactionMode: context.interactionMode,
          runtimeMode: context.runtimeMode,
          activeMode: context.activeMode,
          readOnly: false,
        }) === null
      ) {
        listed.push(HARNESS_MEMORY_WRITE_DEF);
      }
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
        isMcpServerAllowedByMode(server.id, context.activeMode) &&
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
      if (!isMcpServerAllowedByMode(primary.id, context.activeMode)) {
        return yield* new HarnessError({
          code: "policy_denied",
          serverId: primary.id,
          detail: `MCP server "${primary.id}" is disabled by active mode "${context.activeMode?.id ?? ""}".`,
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

    const policy = upstreamToolPolicy(context, binding);
    if (typeof policy === "object") {
      return { isError: true, content: [{ type: "text", text: policy.deny }] };
    }
    const approval = context.approval;
    const target = {
      serverId,
      serverScope: server.scope,
      repoRoot: workspace.workspaceRoot,
      toolName: upstreamToolName,
      configDigest: server.configDigest,
    } satisfies HarnessGatewayApprovalTarget;
    const grantTarget =
      approval?.providerSessionId === undefined
        ? undefined
        : { target, threadId: approval.threadId, providerSessionId: approval.providerSessionId };
    const hasGrant =
      policy === "ask" && grantTarget && approvalAudit
        ? yield* approvalAudit.hasActiveGatewayGrant(grantTarget)
        : false;
    if (policy === "ask" && !hasGrant) {
      if (!approval?.request) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `MCP tool "${toolName}" requires approval from an active T3 Code thread.`,
            },
          ],
        };
      }
      const properties = targetTool.inputSchema.properties;
      const { decision, feedback } = yield* approval.request({
        target,
        readOnly: binding.exposed.readOnly,
        argumentCount: Object.keys(args).length,
        argumentNames:
          properties !== null && typeof properties === "object"
            ? Object.keys(properties)
                .filter((name) => Object.hasOwn(args, name))
                .slice(0, 16)
            : [],
      });
      if (decision === "decline" || decision === "cancel") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: feedback
                ? `User denied the MCP tool call: ${feedback}`
                : "User denied the MCP tool call.",
            },
          ],
        };
      }
      if (decision === "acceptAlways" || decision === "acceptForSession") {
        if (!grantTarget || !approvalAudit) {
          return yield* new HarnessError({
            code: "policy_denied",
            serverId,
            detail: "The selected MCP approval could not be saved.",
          });
        }
        yield* approval.validate?.({ serverId, readOnly: binding.exposed.readOnly }) ?? Effect.void;
        yield* approvalAudit.recordGatewayGrant({
          ...grantTarget,
          providerInstanceId: approval.providerInstanceId,
          workspaceRoot: workspace.workspaceRoot,
          requestKind: "permission",
          scope: decision === "acceptAlways" ? "always" : "session",
          summary: `${serverId}: ${upstreamToolName}`,
        });
      }
    }
    yield* approval?.validate?.({ serverId, readOnly: binding.exposed.readOnly }) ?? Effect.void;

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
      preDispatchWorkspace.workspaceRoot !== workspace.workspaceRoot ||
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

    if (
      hasGrant &&
      grantTarget &&
      approvalAudit &&
      !(yield* approvalAudit.hasActiveGatewayGrant(grantTarget))
    ) {
      return yield* new HarnessError({
        code: "policy_denied",
        serverId,
        detail: "The MCP approval was revoked. Retry to request approval.",
      });
    }

    pooled.lastUsedMs = yield* Clock.currentTimeMillis;
    const callRes = yield* pooled.connection
      .callTool(upstreamToolName, args)
      .pipe(
        Effect.tapError((error) =>
          pooled.connection.isClosed() || error.code === "auth_required"
            ? closePooledInstance(serverId, expectedPoolKey, pooled, error)
            : Effect.void,
        ),
      );
    const rewrittenResultMeta = rewriteMcpAppMeta(serverId, callRes._meta);
    return rewrittenResultMeta !== callRes._meta
      ? { ...callRes, ...(rewrittenResultMeta ? { _meta: rewrittenResultMeta } : {}) }
      : callRes;
  });

  const listResourcesForSession: McpGateway["Service"]["listResourcesForSession"] = Effect.fn(
    "McpGateway.listResourcesForSession",
  )(function* (context) {
    const workspace = yield* store.resolveWorkspace(context.workspaceRoot);
    if (!workspace.managedPolicyAllowsHarness) {
      return [];
    }
    const activeGatewayServers = workspace.servers.filter(
      (server) =>
        server.effectiveEnabled &&
        server.trusted &&
        !server.needsTrustConfirmation &&
        server.blockedByPolicyReason === null &&
        isMcpServerAllowedByMode(server.id, context.activeMode) &&
        resolveServerChannel(server.config, context.harnessCapabilities) === "gateway",
    );

    const perServer = yield* Effect.forEach(
      activeGatewayServers,
      (server) =>
        ensureConnectedFresh({
          serverId: server.id,
          scope: server.scope,
          workspaceRoot: context.workspaceRoot,
          harnessCapabilities: context.harnessCapabilities,
        }).pipe(
          Effect.flatMap(({ server: freshServer, pooled }) => {
            const listRes = pooled.connection.listResources;
            if (!listRes) {
              return Effect.succeed([] as ReadonlyArray<GatewayExposedResource>);
            }
            return listRes().pipe(
              Effect.map((resources: ReadonlyArray<UpstreamMcpResource>) =>
                resources.map((resource): GatewayExposedResource => ({
                  uri: canonicalExposedResourceUri(freshServer.id, resource.uri),
                  serverId: freshServer.id,
                  upstreamUri: resource.uri,
                  name: resource.name,
                  ...(resource.description ? { description: resource.description } : {}),
                  ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
                  ...(resource._meta ? { _meta: resource._meta } : {}),
                })),
              ),
              Effect.orElseSucceed(() => [] as ReadonlyArray<GatewayExposedResource>),
            );
          }),
          Effect.orElseSucceed(() => [] as ReadonlyArray<GatewayExposedResource>),
        ),
      { concurrency: 4 },
    );

    return perServer.flat();
  });

  const readResourceForSession: McpGateway["Service"]["readResourceForSession"] = Effect.fn(
    "McpGateway.readResourceForSession",
  )(function* ({ context, uri }) {
    const workspace = yield* store.resolveWorkspace(context.workspaceRoot);
    if (!workspace.managedPolicyAllowsHarness) {
      return yield* new HarnessError({
        code: "policy_denied",
        detail: "Organization policy does not allow portable harness extensions.",
      });
    }
    const decoded = decodeCanonicalExposedResourceUri(uri);
    if (decoded === null) {
      return yield* new HarnessError({
        code: "not_found",
        detail: `Unknown gateway resource URI "${uri}".`,
      });
    }
    const server = workspace.servers.find(
      (candidate) =>
        candidate.id === decoded.serverId &&
        candidate.effectiveEnabled &&
        candidate.trusted &&
        !candidate.needsTrustConfirmation &&
        candidate.blockedByPolicyReason === null &&
        isMcpServerAllowedByMode(candidate.id, context.activeMode) &&
        resolveServerChannel(candidate.config, context.harnessCapabilities) === "gateway",
    );
    if (server === undefined) {
      return yield* new HarnessError({
        code: "not_found",
        serverId: decoded.serverId,
        detail: `MCP server "${decoded.serverId}" is not active on the T3 Harness gateway.`,
      });
    }
    const { pooled } = yield* ensureConnectedFresh({
      serverId: server.id,
      scope: server.scope,
      workspaceRoot: context.workspaceRoot,
      harnessCapabilities: context.harnessCapabilities,
    });
    const readRes = pooled.connection.readResource;
    if (!readRes) {
      return yield* new HarnessError({
        code: "upstream_error",
        serverId: server.id,
        detail: `MCP server "${server.id}" does not support resources/read.`,
      });
    }
    pooled.lastUsedMs = yield* Clock.currentTimeMillis;
    const raw = yield* readRes(decoded.upstreamUri).pipe(
      Effect.tapError((error) =>
        pooled.connection.isClosed() || error.code === "auth_required"
          ? closePooledInstance(server.id, poolKeyFor(server), pooled, error)
          : Effect.void,
      ),
    );
    // Rewrite returned content URIs back to the canonical gateway URI so MCP App frames resolve cleanly.
    return {
      contents: raw.contents.map((item) => ({
        ...item,
        uri,
      })),
    };
  });

  return McpGateway.of({
    getSnapshot,
    getLogs,
    restartServer,
    invalidateServer,
    updateServer,
    startOAuth,
    completeOAuth,
    disconnectOAuth,
    resolveSessionInjection,
    listToolsForSession,
    callToolForSession,
    listResourcesForSession,
    readResourceForSession,
    evictIdle,
  });
});

export const layer = Layer.effect(McpGateway, makeWithOptions());
