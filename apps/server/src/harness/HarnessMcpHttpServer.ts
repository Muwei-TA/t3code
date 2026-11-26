// @effect-diagnostics globalJsonInEffect:off -- Dynamic MCP JSON-RPC 2.0 router relays opaque upstream tool schemas and call payloads.
import {
  CommandId,
  DEFAULT_HARNESS_CAPABILITIES,
  HarnessError,
  HarnessMcpServerId,
  HarnessMemoryId,
  HarnessModeId,
  HarnessPluginId,
  HarnessRuleId,
  HarnessSkillId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { MCP_TOOL_EXPOSURE_HEADER } from "@t3tools/provider-core/server/mcpSession";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import { HARNESS_MCP_HTTP_PATH } from "../httpCors.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { isLiveCallerShell } from "../mcp/threadAccess.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { compileAndValidateDeclarativeWorkflow } from "./DeclarativeWorkflowCompiler.ts";
import { resolveRunHarnessMode, runInteractionMode } from "./HarnessTurnPreprocess.ts";
import * as HarnessHooksService from "./HarnessHooksService.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import * as HarnessMemoryStore from "./HarnessMemoryStore.ts";
import * as HarnessMcpOAuthNotice from "./HarnessMcpOAuthNotice.ts";
import * as McpGateway from "./McpGateway.ts";
import * as PluginHost from "./PluginHost.ts";

const decodeSkillId = Schema.decodeUnknownOption(HarnessSkillId);
const decodeRuleId = Schema.decodeUnknownOption(HarnessRuleId);
const decodeMcpServerId = Schema.decodeUnknownOption(HarnessMcpServerId);
const decodeModeId = Schema.decodeUnknownOption(HarnessModeId);
const decodePluginId = Schema.decodeUnknownOption(HarnessPluginId);
const decodeMemoryId = Schema.decodeUnknownOption(HarnessMemoryId);

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const jsonRpcSuccess = (id: unknown, result: unknown, sessionId?: string) =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", id, result },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    },
  );

const jsonRpcError = (id: unknown, code: number, message: string, sessionId?: string) =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    },
  );

const unauthorizedResponse = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      message: "A valid T3 Code MCP thread credential is required for /mcp/harness.",
    },
    { status: 401, headers: { "cache-control": "no-store" } },
  );

const forbiddenResponse = (message: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "harness_access_denied",
      message,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );

const makeHarnessPostHandler = Effect.fn("HarnessMcpHttpServer.post")(function* (deps: {
  readonly registry: McpSessionRegistry.McpSessionRegistry["Service"];
  readonly gateway: McpGateway.McpGateway["Service"];
  readonly libraryStore: Option.Option<HarnessLibraryStore.HarnessLibraryStore["Service"]>;
  readonly memoryStore: Option.Option<HarnessMemoryStore.HarnessMemoryStore["Service"]>;
  readonly oauthNotice: Option.Option<HarnessMcpOAuthNotice.HarnessMcpOAuthNotice["Service"]>;
  readonly hooksService: Option.Option<HarnessHooksService.HarnessHooksService["Service"]>;
  readonly pluginHost: Option.Option<PluginHost.PluginHost["Service"]>;
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly adapterRegistry: ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"];
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly random: SecureRandom.SecureRandom["Service"];
}) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // Refuse every browser Origin before checking credentials, matching `/mcp`.
  if (request.headers.origin !== undefined) {
    return HttpServerResponse.empty({ status: 403 });
  }

  const {
    registry,
    gateway,
    libraryStore,
    memoryStore,
    oauthNotice,
    hooksService,
    pluginHost,
    projections,
    projects,
    adapterRegistry,
    orchestrator,
    random,
  } = deps;

  const token = parseBearerToken(request) ?? "";
  const scope = yield* registry.resolve(token);
  if (!scope) {
    return unauthorizedResponse();
  }
  // Ordinary `t3-code` tokens from sessions that did not mount Harness are refused here.
  if (!scope.capabilities.has("harness")) {
    return forbiddenResponse("This session token is not authorized to access /mcp/harness.");
  }

  const body = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return HttpServerResponse.jsonUnsafe(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC payload." } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const rpc = body as JsonRpcRequest;
  const method = typeof rpc.method === "string" ? rpc.method : "";
  const hasId = Object.hasOwn(rpc, "id") && rpc.id !== undefined;
  const sessionId = request.headers["mcp-session-id"] ?? scope.thread.providerSessionId;

  // Notifications carry no `id` and expect 202 Accepted.
  if (!hasId || method.startsWith("notifications/")) {
    return HttpServerResponse.empty({
      status: 202,
      headers: { "mcp-session-id": sessionId, "cache-control": "no-store" },
    });
  }

  if (method === "initialize") {
    const requestedVersion =
      rpc.params !== null &&
      typeof rpc.params === "object" &&
      typeof Reflect.get(rpc.params, "protocolVersion") === "string"
        ? (Reflect.get(rpc.params, "protocolVersion") as string)
        : SUPPORTED_PROTOCOL_VERSION;
    return jsonRpcSuccess(
      rpc.id,
      {
        protocolVersion: requestedVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
        },
        serverInfo: {
          name: "t3-harness",
          version: packageJson.version,
        },
      },
      sessionId,
    );
  }

  if (method === "ping") {
    return jsonRpcSuccess(rpc.id, {}, sessionId);
  }

  const resolveThreadState = Effect.gen(function* () {
    const shell = yield* projections
      .getThreadShell(scope.thread.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (
      shell === null ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.providerInstanceId !== scope.thread.providerInstanceId
    ) {
      return null;
    }

    const project = yield* projects
      .get(shell.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const workspaceRoot =
      shell.worktreePath ?? (Option.isSome(project) ? project.value.workspaceRoot : undefined);
    const snapshot = yield* gateway.getSnapshot(workspaceRoot);
    const capabilities = yield* adapterRegistry.get(scope.thread.providerInstanceId).pipe(
      Effect.flatMap((adapter) => adapter.getCapabilities()),
      Effect.option,
    );
    const emitsProposedPlan = Option.isSome(capabilities)
      ? capabilities.value.planning.emitsProposedPlan
      : false;
    const supportsMcpTools = Option.isSome(capabilities)
      ? capabilities.value.tools.supportsMcpTools
      : false;
    const harnessCapabilities = Option.isSome(capabilities)
      ? capabilities.value.harness
      : DEFAULT_HARNESS_CAPABILITIES;
    const deferredExposure = request.headers[MCP_TOOL_EXPOSURE_HEADER] === "deferred";
    const librarySnapshot = Option.isSome(libraryStore)
      ? yield* libraryStore.value.getSnapshot(workspaceRoot).pipe(Effect.orElseSucceed(() => null))
      : null;
    const activeRun =
      shell.activeRunId !== null && typeof projections.getThreadRecords === "function"
        ? yield* projections
            .getThreadRecords(scope.thread.threadId, ["runs"], { runIds: [shell.activeRunId] })
            .pipe(
              Effect.map(
                (records) => records.runs.find((run) => run.id === shell.activeRunId) ?? null,
              ),
              Effect.orElseSucceed(() => null),
            )
        : null;
    const effectiveInteractionMode = runInteractionMode(
      shell.interactionMode,
      activeRun?.harnessMode,
    );
    const activeMode = Option.isSome(libraryStore)
      ? yield* resolveRunHarnessMode(libraryStore.value, {
          modeId: shell.modeId,
          interactionMode: shell.interactionMode,
          workspaceRoot,
          override: activeRun?.harnessMode,
        }).pipe(Effect.orElseSucceed(() => null))
      : null;
    const includeLibraryTools =
      snapshot.managedPolicyAllowsHarness &&
      supportsMcpTools &&
      librarySnapshot !== null &&
      (librarySnapshot.skills.some((skill) => skill.effectiveEnabled) ||
        librarySnapshot.rules.some((rule) => rule.effectiveEnabled) ||
        (librarySnapshot.userAgentsMd.exists &&
          librarySnapshot.userAgentsMd.body.trim().length > 0));
    const includeCreatorTools =
      snapshot.managedPolicyAllowsHarness &&
      supportsMcpTools &&
      effectiveInteractionMode !== "plan" &&
      activeMode?.readonly !== true &&
      (activeMode?.id ?? activeRun?.harnessMode?.id ?? shell.modeId) === "creator";
    const context: McpGateway.GatewaySessionContext = {
      providerSessionId: scope.thread.providerSessionId,
      workspaceRoot,
      interactionMode: effectiveInteractionMode,
      runtimeMode: shell.runtimeMode,
      activeMode,
      includeProposePlan:
        snapshot.managedPolicyAllowsHarness &&
        (effectiveInteractionMode === "plan" || activeMode?.proposePlan === true) &&
        !emitsProposedPlan &&
        supportsMcpTools,
      includeLibraryTools,
      includeCreatorTools,
      includeMemoryTools:
        snapshot.managedPolicyAllowsHarness && supportsMcpTools && Option.isSome(memoryStore),
      deferredExposure,
      harnessCapabilities,
    };
    return {
      shell,
      context,
      librarySnapshot,
      managedPolicyAllowsHarness: snapshot.managedPolicyAllowsHarness,
    };
  });

  const publishAuthNotice = (serverId: HarnessMcpServerId) =>
    Option.isSome(oauthNotice)
      ? oauthNotice.value.publish(scope.thread.threadId, serverId)
      : Effect.void;

  if (method === "tools/list") {
    const state = yield* resolveThreadState;
    if (state === null) {
      return forbiddenResponse("The calling provider no longer owns this thread.");
    }
    const tools = yield* gateway.listToolsForSession(state.context);
    if (
      Option.isSome(oauthNotice) &&
      state.shell.activeRunId !== null &&
      state.managedPolicyAllowsHarness
    ) {
      const snapshot = yield* gateway.getSnapshot(state.context.workspaceRoot);
      yield* Effect.forEach(
        snapshot.servers.filter((server) => server.state === "auth_required"),
        (server) => publishAuthNotice(server.id),
        { discard: true },
      );
    }
    const pluginTools =
      state.managedPolicyAllowsHarness && Option.isSome(pluginHost)
        ? pluginHost.value.listActiveSdkTools().filter(
            (tool) =>
              McpGateway.checkHarnessRuntimeToolCeiling({
                toolName: tool.exposedName,
                interactionMode: state.context.interactionMode,
                runtimeMode: state.context.runtimeMode,
                activeMode: state.context.activeMode,
                readOnly: tool.readOnly,
              }) === null,
          )
        : [];
    return jsonRpcSuccess(
      rpc.id,
      {
        tools: [
          ...tools.map((tool) => ({
            name: tool.exposedName,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
            ...(tool._meta ? { _meta: tool._meta } : {}),
          })),
          ...pluginTools.map((tool) => ({
            name: tool.exposedName,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
          })),
        ],
      },
      sessionId,
    );
  }

  if (method === "resources/list") {
    const state = yield* resolveThreadState;
    if (state === null) {
      return forbiddenResponse("The calling provider no longer owns this thread.");
    }
    const resources = yield* gateway.listResourcesForSession(state.context);
    return jsonRpcSuccess(
      rpc.id,
      {
        resources: resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          ...(resource.description ? { description: resource.description } : {}),
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          ...(resource._meta ? { _meta: resource._meta } : {}),
        })),
      },
      sessionId,
    );
  }

  if (method === "resources/read") {
    const state = yield* resolveThreadState;
    if (state === null || !isLiveCallerShell(state.shell, scope.thread.providerInstanceId)) {
      return jsonRpcError(
        rpc.id,
        -32001,
        "The calling provider no longer owns an active thread run.",
        sessionId,
      );
    }
    const params =
      rpc.params !== null && typeof rpc.params === "object" && !Array.isArray(rpc.params)
        ? (rpc.params as Record<string, unknown>)
        : {};
    const uri = typeof params.uri === "string" ? params.uri.trim() : "";
    if (!uri) {
      return jsonRpcError(rpc.id, -32602, "resources/read requires a non-empty uri.", sessionId);
    }
    const readRes = yield* gateway
      .readResourceForSession({ context: state.context, uri })
      .pipe(Effect.result);
    if (Result.isFailure(readRes)) {
      return jsonRpcError(rpc.id, -32002, readRes.failure.detail, sessionId);
    }
    return jsonRpcSuccess(rpc.id, readRes.success, sessionId);
  }

  if (method === "tools/call") {
    const params =
      rpc.params !== null && typeof rpc.params === "object" && !Array.isArray(rpc.params)
        ? (rpc.params as Record<string, unknown>)
        : {};
    const toolName = typeof params.name === "string" ? params.name : "";
    const toolArgs =
      params.arguments !== null &&
      typeof params.arguments === "object" &&
      !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    let state = yield* resolveThreadState;
    if (state === null || !isLiveCallerShell(state.shell, scope.thread.providerInstanceId)) {
      return jsonRpcSuccess(
        rpc.id,
        {
          isError: true,
          content: [
            {
              type: "text",
              text: "The calling provider no longer owns an active thread run.",
            },
          ],
        },
        sessionId,
      );
    }

    if (!state.managedPolicyAllowsHarness) {
      return jsonRpcSuccess(
        rpc.id,
        {
          isError: true,
          content: [
            {
              type: "text",
              text: "Portable harness extensions are disabled by this environment's managed policy.",
            },
          ],
        },
        sessionId,
      );
    }

    if (Option.isSome(hooksService)) {
      const preOutcome = yield* hooksService.value.runToolHook("PreToolUse", {
        threadId: scope.thread.threadId,
        toolName,
        arguments: toolArgs,
        workspaceRoot: state.context.workspaceRoot,
      });
      if (preOutcome.blocked) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              {
                type: "text",
                text: preOutcome.blockReason ?? `Tool "${toolName}" blocked by PreToolUse hook.`,
              },
            ],
          },
          sessionId,
        );
      }
      const freshState = yield* resolveThreadState;
      if (
        freshState === null ||
        !isLiveCallerShell(freshState.shell, scope.thread.providerInstanceId) ||
        freshState.shell.activeRunId !== state.shell.activeRunId
      ) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              { type: "text", text: "The calling provider no longer owns an active thread run." },
            ],
          },
          sessionId,
        );
      }
      if (!freshState.managedPolicyAllowsHarness) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              {
                type: "text",
                text: "Portable harness extensions are disabled by this environment's managed policy.",
              },
            ],
          },
          sessionId,
        );
      }
      state = freshState;
    }
    const { context } = state;

    const emitPostToolHook = (isError: boolean) =>
      Option.isSome(hooksService)
        ? hooksService.value.runToolHook("PostToolUse", {
            threadId: scope.thread.threadId,
            toolName,
            arguments: toolArgs,
            workspaceRoot: context.workspaceRoot,
            isError,
          })
        : Effect.void;

    if (toolName === McpGateway.HARNESS_WORKFLOW_VALIDATE_NAME) {
      const yaml = typeof toolArgs.yaml === "string" ? toolArgs.yaml : "";
      const knownModes = state.librarySnapshot
        ? new Set(state.librarySnapshot.modes.map((m) => m.id))
        : undefined;
      const validation = compileAndValidateDeclarativeWorkflow(yaml, knownModes);
      yield* emitPostToolHook(!validation.valid);
      return jsonRpcSuccess(
        rpc.id,
        {
          isError: !validation.valid,
          content: [
            {
              type: "text",
              text: validation.valid
                ? `Valid workflow "${validation.name ?? "unnamed"}" (execution order: ${validation.executionOrder.join(" -> ")}).\n\n${validation.compiledPreview ?? ""}`
                : `Workflow validation failed:\n${validation.issues.map((i) => `- [${i.severity}] ${i.path}: ${i.message}`).join("\n")}`,
            },
          ],
          structuredContent: validation,
        },
        sessionId,
      );
    }

    const checkRuntimeCeiling = (readOnly: boolean) =>
      McpGateway.checkHarnessRuntimeToolCeiling({
        toolName,
        interactionMode: context.interactionMode,
        runtimeMode: context.runtimeMode,
        activeMode: context.activeMode,
        readOnly,
      });

    if (toolName === McpGateway.HARNESS_WRITE_SKILL_NAME) {
      const ceilingErr = checkRuntimeCeiling(false);
      if (ceilingErr !== null) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          { isError: true, content: [{ type: "text", text: ceilingErr }] },
          sessionId,
        );
      }
      if (!state.context.includeCreatorTools || Option.isNone(libraryStore)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              { type: "text", text: "harness_write_skill is only available in Creator mode." },
            ],
          },
          sessionId,
        );
      }
      const rawId = typeof toolArgs.id === "string" ? toolArgs.id.trim() : "";
      const body = typeof toolArgs.body === "string" ? toolArgs.body : "";
      const idOpt = decodeSkillId(rawId);
      if (idOpt._tag === "None" || body.trim().length === 0) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              {
                type: "text",
                text: "harness_write_skill requires a valid skill id and non-empty markdown body.",
              },
            ],
          },
          sessionId,
        );
      }
      const saved = yield* libraryStore.value
        .upsertUserSkill({
          id: idOpt.value,
          ...(typeof toolArgs.name === "string" && toolArgs.name.trim()
            ? { name: TrimmedNonEmptyString.make(toolArgs.name.trim()) }
            : {}),
          ...(typeof toolArgs.description === "string" && toolArgs.description.trim()
            ? { description: toolArgs.description.trim() }
            : {}),
          body,
          ...(state.context.workspaceRoot
            ? { workspaceRoot: TrimmedNonEmptyString.make(state.context.workspaceRoot) }
            : {}),
        })
        .pipe(Effect.result);
      if (Result.isFailure(saved)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          { isError: true, content: [{ type: "text", text: saved.failure.detail }] },
          sessionId,
        );
      }
      yield* emitPostToolHook(false);
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text: `Saved portable skill "${idOpt.value}" under ~/.t3/harness/skills/${idOpt.value}/SKILL.md.`,
            },
          ],
        },
        sessionId,
      );
    }

    if (toolName === McpGateway.HARNESS_CREATE_MODE_NAME) {
      const ceilingErr = checkRuntimeCeiling(false);
      if (ceilingErr !== null) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          { isError: true, content: [{ type: "text", text: ceilingErr }] },
          sessionId,
        );
      }
      if (!state.context.includeCreatorTools || Option.isNone(libraryStore)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              { type: "text", text: "harness_create_mode is only available in Creator mode." },
            ],
          },
          sessionId,
        );
      }
      const rawId = typeof toolArgs.id === "string" ? toolArgs.id.trim() : "";
      const body = typeof toolArgs.body === "string" ? toolArgs.body : "";
      const idOpt = decodeModeId(rawId);
      if (idOpt._tag === "None" || body.trim().length === 0) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              {
                type: "text",
                text: "harness_create_mode requires a valid mode id and non-empty markdown body.",
              },
            ],
          },
          sessionId,
        );
      }
      const decodeList = <T>(
        value: unknown,
        decode: (v: unknown) => Option.Option<T>,
      ): ReadonlyArray<T> | undefined => {
        if (!Array.isArray(value)) return undefined;
        const out: Array<T> = [];
        for (const item of value) {
          const decoded = decode(item);
          if (Option.isSome(decoded)) out.push(decoded.value);
        }
        return out.length > 0 ? out : undefined;
      };
      const allowedMcpServers = decodeList(toolArgs.allowedMcpServers, decodeMcpServerId);
      const includedRules = decodeList(toolArgs.includedRules, decodeRuleId);
      const includedSkills = decodeList(toolArgs.includedSkills, decodeSkillId);
      const saved = yield* libraryStore.value
        .createUserMode({
          id: idOpt.value,
          ...(typeof toolArgs.name === "string" && toolArgs.name.trim()
            ? { name: TrimmedNonEmptyString.make(toolArgs.name.trim()) }
            : {}),
          ...(typeof toolArgs.description === "string" && toolArgs.description.trim()
            ? { description: toolArgs.description.trim() }
            : {}),
          baseInteractionMode: toolArgs.baseInteractionMode === "plan" ? "plan" : "default",
          ...(typeof toolArgs.readonly === "boolean" ? { readonly: toolArgs.readonly } : {}),
          ...(typeof toolArgs.proposePlan === "boolean"
            ? { proposePlan: toolArgs.proposePlan }
            : {}),
          ...(allowedMcpServers ? { allowedMcpServers } : {}),
          ...(includedRules ? { includedRules } : {}),
          ...(includedSkills ? { includedSkills } : {}),
          body,
          ...(state.context.workspaceRoot
            ? { workspaceRoot: TrimmedNonEmptyString.make(state.context.workspaceRoot) }
            : {}),
        })
        .pipe(Effect.result);
      if (Result.isFailure(saved)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          { isError: true, content: [{ type: "text", text: saved.failure.detail }] },
          sessionId,
        );
      }
      yield* emitPostToolHook(false);
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text: `Saved declarative mode "${idOpt.value}" under ~/.t3/harness/modes/${idOpt.value}.md.`,
            },
          ],
        },
        sessionId,
      );
    }

    if (toolName === McpGateway.HARNESS_PLUGIN_PACK_NAME) {
      const ceilingErr = checkRuntimeCeiling(false);
      if (ceilingErr !== null) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          { isError: true, content: [{ type: "text", text: ceilingErr }] },
          sessionId,
        );
      }
      if (!state.context.includeCreatorTools || Option.isNone(pluginHost)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [{ type: "text", text: "plugin_pack is only available in Creator mode." }],
          },
          sessionId,
        );
      }
      const rawId = typeof toolArgs.id === "string" ? toolArgs.id.trim() : "";
      const name = typeof toolArgs.name === "string" ? toolArgs.name.trim() : "";
      const version = typeof toolArgs.version === "string" ? toolArgs.version.trim() : "";
      const idOpt = decodePluginId(rawId);
      if (idOpt._tag === "None" || name.length === 0 || version.length === 0) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              {
                type: "text",
                text: "plugin_pack requires valid id, name, and version fields.",
              },
            ],
          },
          sessionId,
        );
      }
      const packed = yield* pluginHost.value
        .packPlugin({
          id: idOpt.value,
          name,
          version,
          ...(typeof toolArgs.description === "string" && toolArgs.description.trim()
            ? { description: toolArgs.description.trim() }
            : {}),
          ...(typeof toolArgs.author === "string" && toolArgs.author.trim()
            ? { author: toolArgs.author.trim() }
            : {}),
        })
        .pipe(Effect.result);
      if (Result.isFailure(packed)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          { isError: true, content: [{ type: "text", text: packed.failure.detail }] },
          sessionId,
        );
      }
      yield* emitPostToolHook(false);
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text: `Packed plugin "${packed.success.id}" at ${packed.success.manifestPath} (${packed.success.fileCount} files, sha256:${packed.success.contentDigest.slice(0, 16)}). Owner trust confirmation is required in Settings -> Harness -> Plugins before activation.`,
            },
          ],
          structuredContent: packed.success,
        },
        sessionId,
      );
    }

    if (toolName === McpGateway.HARNESS_PROPOSE_PLAN_NAME) {
      if (!state.context.includeProposePlan) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              {
                type: "text",
                text: "propose_plan is only available in Plan mode on providers without native proposed-plan cards.",
              },
            ],
          },
          sessionId,
        );
      }
      if (state.shell.activeRunId === null) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              {
                type: "text",
                text: "propose_plan requires an active thread run.",
              },
            ],
          },
          sessionId,
        );
      }
      const markdown = typeof toolArgs.markdown === "string" ? toolArgs.markdown.trim() : "";
      if (markdown.length === 0) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [{ type: "text", text: "propose_plan requires a non-empty markdown plan." }],
          },
          sessionId,
        );
      }
      const commandId = CommandId.make(`cmd:harness-propose-plan:${yield* random.uuidV4()}`);
      const dispatched = yield* orchestrator
        .dispatch({
          type: "plan.propose",
          commandId,
          threadId: scope.thread.threadId,
          runId: state.shell.activeRunId,
          providerInstanceId: scope.thread.providerInstanceId,
          markdown,
        })
        .pipe(
          Effect.as({ ok: true as const }),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      if (!dispatched.ok) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [{ type: "text", text: `Failed to publish plan: ${dispatched.message}` }],
          },
          sessionId,
        );
      }
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text: "Proposed plan card published to the user. Wait for user approval before implementing.",
            },
          ],
        },
        sessionId,
      );
    }

    if (toolName === McpGateway.HARNESS_SKILL_SEARCH_NAME) {
      if (Option.isNone(libraryStore) || state.librarySnapshot === null) {
        return jsonRpcSuccess(
          rpc.id,
          { content: [{ type: "text", text: "No portable skills are available." }] },
          sessionId,
        );
      }
      const query = typeof toolArgs.query === "string" ? toolArgs.query.trim().toLowerCase() : "";
      const terms = query.split(/[^a-z0-9_-]+/u).filter(Boolean);
      const enabledSkills = state.librarySnapshot.skills.filter((skill) => skill.effectiveEnabled);
      const matches =
        terms.length === 0
          ? enabledSkills.slice(0, 20)
          : enabledSkills
              .map((skill) => {
                const haystack =
                  `${skill.id} ${skill.name} ${skill.description ?? ""} ${skill.shortDescription ?? ""}`.toLowerCase();
                let score = 0;
                for (const term of terms) {
                  if (skill.id.toLowerCase() === term || skill.name.toLowerCase() === term) {
                    score += 100;
                  } else if (
                    skill.id.toLowerCase().includes(term) ||
                    skill.name.toLowerCase().includes(term)
                  ) {
                    score += 10;
                  } else if (haystack.includes(term)) {
                    score += 2;
                  }
                }
                return { skill, score };
              })
              .filter((entry) => entry.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 12)
              .map((entry) => entry.skill);
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text:
                matches.length === 0
                  ? `No portable skills matched "${query}".`
                  : matches
                      .map(
                        (skill) =>
                          `- ${skill.name} (id: ${skill.id}, scope: ${skill.scope}): ${skill.shortDescription ?? skill.description ?? "No description"}`,
                      )
                      .join("\n"),
            },
          ],
          structuredContent: {
            skills: matches.map((skill) => ({
              id: skill.id,
              name: skill.name,
              scope: skill.scope,
              description: skill.shortDescription ?? skill.description ?? "",
              sourcePath: skill.sourcePath,
            })),
          },
        },
        sessionId,
      );
    }

    if (toolName === McpGateway.HARNESS_SKILL_LOAD_NAME) {
      const name = typeof toolArgs.name === "string" ? toolArgs.name.trim() : "";
      if (name.length === 0 || Option.isNone(libraryStore)) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              { type: "text", text: "harness_skill_load requires a non-empty skill name." },
            ],
          },
          sessionId,
        );
      }
      const detail = yield* libraryStore.value.getSkillDetail({
        nameOrId: name,
        workspaceRoot: state.context.workspaceRoot,
      });
      if (Option.isNone(detail)) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              { type: "text", text: `Portable skill "${name}" was not found or is disabled.` },
            ],
          },
          sessionId,
        );
      }
      const { skill, companionFiles } = detail.value;
      const companionNote =
        companionFiles.length > 0
          ? `\n\nCompanion files in ${skill.sourcePath.replace(/\/SKILL\.md$/u, "")}:\n${companionFiles.map((f) => `- ${f}`).join("\n")}`
          : "";
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text: `# Skill: ${skill.name} (${skill.scope})\nSource: ${skill.sourcePath}\n\n${skill.body.trim()}${companionNote}`,
            },
          ],
        },
        sessionId,
      );
    }

    if (toolName === McpGateway.HARNESS_RULE_READ_NAME) {
      const ruleId = typeof toolArgs.id === "string" ? toolArgs.id.trim() : "";
      if (ruleId.length === 0 || Option.isNone(libraryStore)) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [{ type: "text", text: "harness_rule_read requires a non-empty rule id." }],
          },
          sessionId,
        );
      }
      const detail = yield* libraryStore.value.getRuleDetail({
        id: ruleId,
        workspaceRoot: state.context.workspaceRoot,
      });
      if (Option.isNone(detail)) {
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              { type: "text", text: `Portable rule "${ruleId}" was not found or is disabled.` },
            ],
          },
          sessionId,
        );
      }
      const rule = detail.value;
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text: `# Rule: ${rule.id} (${rule.scope}, apply: ${rule.apply})\nSource: ${rule.sourcePath}\n\n${rule.body.trim()}`,
            },
          ],
        },
        sessionId,
      );
    }

    if (toolName === McpGateway.HARNESS_MEMORY_SEARCH_NAME) {
      if (Option.isNone(memoryStore)) {
        yield* emitPostToolHook(false);
        return jsonRpcSuccess(
          rpc.id,
          { content: [{ type: "text", text: "Portable memory is not configured." }] },
          sessionId,
        );
      }
      const query = typeof toolArgs.query === "string" ? toolArgs.query : undefined;
      const tag = typeof toolArgs.tag === "string" ? toolArgs.tag : undefined;
      const limit = typeof toolArgs.limit === "number" ? toolArgs.limit : undefined;
      const matches = yield* memoryStore.value
        .searchMemory({ query, tag, limit })
        .pipe(Effect.orElseSucceed(() => []));
      yield* emitPostToolHook(false);
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text:
                matches.length === 0
                  ? "No portable memory notes matched."
                  : matches
                      .map(
                        (entry) =>
                          `- ${entry.id}: ${entry.title}${entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : ""}${entry.pinned ? " (pinned)" : ""}`,
                      )
                      .join("\n"),
            },
          ],
          structuredContent: {
            entries: matches.map((entry) => ({
              id: entry.id,
              title: entry.title,
              tags: entry.tags,
              pinned: entry.pinned,
              updatedAt: entry.updatedAt,
            })),
          },
        },
        sessionId,
      );
    }

    if (toolName === McpGateway.HARNESS_MEMORY_READ_NAME) {
      const id = typeof toolArgs.id === "string" ? toolArgs.id.trim() : "";
      if (!id || Option.isNone(memoryStore)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [{ type: "text", text: "harness_memory_read requires a non-empty id." }],
          },
          sessionId,
        );
      }
      const entryOpt = yield* memoryStore.value
        .readMemory(id)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(entryOpt)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [{ type: "text", text: `Portable memory note "${id}" was not found.` }],
          },
          sessionId,
        );
      }
      const entry = entryOpt.value;
      yield* emitPostToolHook(false);
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text: `# Memory: ${entry.title} (${entry.id})\nTags: ${entry.tags.join(", ") || "none"}\nUpdated: ${entry.updatedAt}\n\n${entry.body}`,
            },
          ],
        },
        sessionId,
      );
    }

    if (toolName === McpGateway.HARNESS_MEMORY_WRITE_NAME) {
      const ceilingErr = checkRuntimeCeiling(false);
      if (ceilingErr !== null) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          { isError: true, content: [{ type: "text", text: ceilingErr }] },
          sessionId,
        );
      }
      const rawId = typeof toolArgs.id === "string" ? toolArgs.id.trim() : "";
      const title = typeof toolArgs.title === "string" ? toolArgs.title.trim() : "";
      const body = typeof toolArgs.body === "string" ? toolArgs.body : "";
      const idOpt = decodeMemoryId(rawId);
      if (Option.isNone(idOpt) || !title || !body.trim() || Option.isNone(memoryStore)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          {
            isError: true,
            content: [
              {
                type: "text",
                text: "harness_memory_write requires valid id, title, and non-empty markdown body.",
              },
            ],
          },
          sessionId,
        );
      }
      const tags = Array.isArray(toolArgs.tags)
        ? toolArgs.tags
            .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
            .map((t) => TrimmedNonEmptyString.make(t.trim()))
        : undefined;
      const saved = yield* memoryStore.value
        .upsertMemory({
          id: idOpt.value,
          title: TrimmedNonEmptyString.make(title),
          ...(tags ? { tags } : {}),
          ...(typeof toolArgs.pinned === "boolean" ? { pinned: toolArgs.pinned } : {}),
          body,
        })
        .pipe(Effect.result);
      if (Result.isFailure(saved)) {
        yield* emitPostToolHook(true);
        return jsonRpcSuccess(
          rpc.id,
          { isError: true, content: [{ type: "text", text: saved.failure.detail }] },
          sessionId,
        );
      }
      yield* emitPostToolHook(false);
      return jsonRpcSuccess(
        rpc.id,
        {
          content: [
            {
              type: "text",
              text: `Saved portable memory note "${idOpt.value}" under ~/.t3/harness/memory/${idOpt.value}.md.`,
            },
          ],
        },
        sessionId,
      );
    }

    if (toolName.startsWith("plugin__") && Option.isSome(pluginHost)) {
      const sdkTool = pluginHost.value
        .listActiveSdkTools()
        .find((candidate) => candidate.exposedName === toolName);
      if (sdkTool) {
        const ceilingErr = checkRuntimeCeiling(sdkTool.readOnly);
        if (ceilingErr !== null) {
          yield* emitPostToolHook(true);
          return jsonRpcSuccess(
            rpc.id,
            {
              isError: true,
              content: [{ type: "text", text: ceilingErr }],
            },
            sessionId,
          );
        }
        const pluginRes = yield* pluginHost.value
          .callActiveSdkTool({
            exposedName: toolName,
            arguments: toolArgs,
            workspaceRoot: state.context.workspaceRoot,
            threadId: scope.thread.threadId,
          })
          .pipe(
            Effect.catch((error: HarnessError) =>
              Effect.succeed({
                isError: true as const,
                content: [{ type: "text", text: error.detail }],
              }),
            ),
          );
        yield* emitPostToolHook(pluginRes.isError === true);
        return jsonRpcSuccess(rpc.id, pluginRes, sessionId);
      }
    }

    const result = yield* gateway
      .callToolForSession({ context: state.context, toolName, arguments: toolArgs })
      .pipe(
        Effect.catch((error: HarnessError) => {
          const server = decodeMcpServerId(error.serverId);
          const notice =
            error.code === "auth_required" && Option.isSome(server)
              ? publishAuthNotice(server.value)
              : Effect.void;
          return notice.pipe(
            Effect.as({
              isError: true as const,
              content: [{ type: "text", text: error.detail }],
            }),
          );
        }),
      );
    yield* emitPostToolHook(result.isError === true);
    return jsonRpcSuccess(rpc.id, result, sessionId);
  }

  return jsonRpcError(
    rpc.id,
    -32601,
    `Method "${method}" is not implemented by t3-harness.`,
    sessionId,
  );
});

const makeHarnessGetOrDeleteHandler = Effect.fn("HarnessMcpHttpServer.getOrDelete")(function* (
  registry: McpSessionRegistry.McpSessionRegistry["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.origin !== undefined) {
    return HttpServerResponse.empty({ status: 403 });
  }
  const token = parseBearerToken(request) ?? "";
  const scope = yield* registry.resolve(token);
  if (!scope) {
    return unauthorizedResponse();
  }
  if (!scope.capabilities.has("harness")) {
    return forbiddenResponse("This session token is not authorized to access /mcp/harness.");
  }
  return request.method === "DELETE"
    ? HttpServerResponse.empty({ status: 204, headers: { "cache-control": "no-store" } })
    : HttpServerResponse.empty({ status: 405, headers: { allow: "POST, DELETE" } });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const gateway = yield* McpGateway.McpGateway;
    const libraryStore = yield* Effect.serviceOption(HarnessLibraryStore.HarnessLibraryStore);
    const memoryStore = yield* Effect.serviceOption(HarnessMemoryStore.HarnessMemoryStore);
    const oauthNotice = yield* Effect.serviceOption(HarnessMcpOAuthNotice.HarnessMcpOAuthNotice);
    const hooksService = yield* Effect.serviceOption(HarnessHooksService.HarnessHooksService);
    const pluginHost = yield* Effect.serviceOption(PluginHost.PluginHost);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const adapterRegistry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const random = yield* SecureRandom.SecureRandom;
    const handlePost = makeHarnessPostHandler({
      registry,
      gateway,
      libraryStore,
      memoryStore,
      oauthNotice,
      hooksService,
      pluginHost,
      projections,
      projects,
      adapterRegistry,
      orchestrator,
      random,
    });
    const handleGetOrDelete = makeHarnessGetOrDeleteHandler(registry);
    return Layer.mergeAll(
      HttpRouter.add("POST", HARNESS_MCP_HTTP_PATH, handlePost),
      HttpRouter.add("GET", HARNESS_MCP_HTTP_PATH, handleGetOrDelete),
      HttpRouter.add("DELETE", HARNESS_MCP_HTTP_PATH, handleGetOrDelete),
    );
  }),
);
