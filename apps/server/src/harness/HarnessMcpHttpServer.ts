// @effect-diagnostics globalJsonInEffect:off -- Dynamic MCP JSON-RPC 2.0 router relays opaque upstream tool schemas and call payloads.
import { CommandId, DEFAULT_HARNESS_CAPABILITIES, HarnessError } from "@t3tools/contracts";
import { MCP_TOOL_EXPOSURE_HEADER } from "@t3tools/provider-core/server/mcpSession";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import * as McpGateway from "./McpGateway.ts";

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
    const includeLibraryTools =
      snapshot.managedPolicyAllowsHarness &&
      supportsMcpTools &&
      librarySnapshot !== null &&
      (librarySnapshot.skills.some((skill) => skill.effectiveEnabled) ||
        librarySnapshot.rules.some((rule) => rule.effectiveEnabled) ||
        (librarySnapshot.userAgentsMd.exists &&
          librarySnapshot.userAgentsMd.body.trim().length > 0));
    const context: McpGateway.GatewaySessionContext = {
      providerSessionId: scope.thread.providerSessionId,
      workspaceRoot,
      interactionMode: shell.interactionMode,
      runtimeMode: shell.runtimeMode,
      includeProposePlan:
        snapshot.managedPolicyAllowsHarness &&
        shell.interactionMode === "plan" &&
        !emitsProposedPlan &&
        supportsMcpTools,
      includeLibraryTools,
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

  if (method === "tools/list") {
    const state = yield* resolveThreadState;
    if (state === null) {
      return forbiddenResponse("The calling provider no longer owns this thread.");
    }
    const tools = yield* gateway.listToolsForSession(state.context);
    return jsonRpcSuccess(
      rpc.id,
      {
        tools: tools.map((tool) => ({
          name: tool.exposedName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        })),
      },
      sessionId,
    );
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

    const state = yield* resolveThreadState;
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

    const result = yield* gateway
      .callToolForSession({ context: state.context, toolName, arguments: toolArgs })
      .pipe(
        Effect.catch((error: HarnessError) =>
          Effect.succeed({
            isError: true as const,
            content: [{ type: "text", text: error.detail }],
          }),
        ),
      );
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
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const adapterRegistry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const random = yield* SecureRandom.SecureRandom;
    const handlePost = makeHarnessPostHandler({
      registry,
      gateway,
      libraryStore,
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
