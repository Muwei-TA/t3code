import {
  HarnessMcpServerId,
  HarnessError,
  McpAppRequestError,
  type McpAppCallToolInput,
  type McpAppCallToolResult,
  type McpAppReadResourceInput,
  type McpAppReadResourceResult,
  type McpAppToolInfo,
  type McpAppToolInfoInput,
  type McpAppUpdateModelContextInput,
  type OrchestrationV2AppThread,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  HARNESS_MCP_APP_SERVER,
  mcpAppToolCallableByApp,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import { mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";
import * as McpGateway from "../harness/McpGateway.ts";
import * as HarnessLibraryStore from "../harness/HarnessLibraryStore.ts";
import { resolveRunHarnessMode, runInteractionMode } from "../harness/HarnessTurnPreprocess.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { gatewayAppTurnItemSignal } from "./GatewayMcpAppCapture.ts";

/** Reports stopped sessions without starting them; app views must not spend provider turns. */
export class McpAppRequests extends Context.Service<
  McpAppRequests,
  {
    readonly callTool: (
      input: McpAppCallToolInput,
    ) => Effect.Effect<McpAppCallToolResult, McpAppRequestError>;
    readonly toolInfo: (
      input: McpAppToolInfoInput,
    ) => Effect.Effect<McpAppToolInfo, McpAppRequestError>;
    readonly readResource: (
      input: McpAppReadResourceInput,
    ) => Effect.Effect<McpAppReadResourceResult, McpAppRequestError>;
    readonly updateModelContext: (
      input: McpAppUpdateModelContextInput,
    ) => Effect.Effect<void, McpAppRequestError>;
  }
>()("t3/mcpApps/McpAppRequests") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8 = new TextEncoder();

const readOnlyHint = (tool: ProviderAdapter.ProviderAdapterV2McpTool) =>
  Predicate.isObject(tool.annotations) && tool.annotations.readOnlyHint === true;

const toolTitle = (tool: ProviderAdapter.ProviderAdapterV2McpTool) =>
  Predicate.isObject(tool.annotations) && typeof tool.annotations.title === "string"
    ? tool.annotations.title
    : undefined;

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const modelContext = yield* McpAppModelContext.McpAppModelContext;
  const gateway = yield* Effect.serviceOption(McpGateway.McpGateway);
  const library = yield* Effect.serviceOption(HarnessLibraryStore.HarnessLibraryStore);
  const projects = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const adapters = yield* Effect.serviceOption(ProviderAdapterRegistry.ProviderAdapterRegistryV2);

  const fail = (threadId: ThreadId, reason: McpAppRequestError["reason"], cause?: unknown) =>
    new McpAppRequestError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });
  const adapterFailure = (threadId: ThreadId) => (cause: ProviderAdapter.ProviderAdapterV2Error) =>
    fail(
      threadId,
      cause._tag === "ProviderAdapterSessionStoppedError" ? "session-stopped" : "request-failed",
      cause,
    );

  const resolveApp = Effect.fn("McpAppRequests.resolveApp")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) {
    const item = yield* orchestrator
      .getTurnItem({ threadId: input.threadId, itemId: input.itemId })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    const app: McpAppReference | undefined =
      item?.type === "dynamic_tool" ? mcpAppFromToolItem(item) : undefined;
    if (item === null || app === undefined || item.providerThreadId === null) {
      return yield* fail(input.threadId, "not-an-app");
    }
    if (
      app.server === HARNESS_MCP_APP_SERVER &&
      (item.runId === null ||
        item.id !==
          IdAllocator.derive.runSignalTurnItem({
            runId: item.runId,
            signal: gatewayAppTurnItemSignal(app.attachmentId),
          }))
    ) {
      return yield* fail(input.threadId, "not-an-app");
    }
    const configId =
      item.type === "dynamic_tool" &&
      Predicate.isObject(item.output) &&
      typeof item.output.gatewayConfigId === "string"
        ? item.output.gatewayConfigId
        : undefined;
    return { app, providerThreadId: item.providerThreadId, configId };
  });

  const resolve = Effect.fn("McpAppRequests.resolve")(function* (
    threadId: ThreadId,
    { app, providerThreadId }: Effect.Success<ReturnType<typeof resolveApp>>,
  ) {
    const projection = yield* threadManagement
      .getThreadRecords(threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === providerThreadId,
    );
    if (providerThread?.providerSessionId == null) {
      return yield* fail(threadId, "session-stopped");
    }
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause))),
    );
    if (runtime === undefined) return yield* fail(threadId, "session-stopped");
    const mcpApps: ProviderAdapter.ProviderAdapterV2McpApps | undefined = runtime.mcpApps;
    if (mcpApps === undefined) return yield* fail(threadId, "provider-unsupported");
    return { app, providerThread, mcpApps };
  });

  const resolveGateway = Effect.fn("McpAppRequests.resolveGateway")(function* (
    threadId: ThreadId,
    { app, providerThreadId, configId }: Effect.Success<ReturnType<typeof resolveApp>>,
  ) {
    const owner = McpGateway.decodeCanonicalExposedToolName(app.tool);
    if (
      owner === null ||
      configId === undefined ||
      Option.isNone(gateway) ||
      Option.isNone(projects) ||
      Option.isNone(library) ||
      Option.isNone(adapters)
    )
      return yield* fail(threadId, "not-an-app");
    const serverId = HarnessMcpServerId.make(owner.serverId);
    const makeContext = Effect.fn("McpAppRequests.gatewayContext")(function* () {
      const shell = yield* threadManagement.getThreadShell(threadId);
      if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
        return yield* fail(threadId, "not-an-app");
      }
      const project = Option.getOrUndefined(yield* projects.value.get(shell.projectId));
      if (project === undefined || project.deletedAt !== null)
        return yield* fail(threadId, "not-an-app");
      const workspaceRoot = shell.worktreePath ?? project.workspaceRoot;
      const projection = yield* threadManagement.getThreadRecords(
        threadId,
        ["providerThreads", "runs"],
        shell.activeRunId === null ? { runIds: [] } : { runIds: [shell.activeRunId] },
      );
      const activeRun = projection.runs.find((run) => run.id === shell.activeRunId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === providerThreadId,
      );
      const sessionId =
        providerThread?.providerInstanceId === shell.providerInstanceId
          ? providerThread.providerSessionId
          : undefined;
      const liveSessionId =
        sessionId != null && (yield* providerSessions.isLive(sessionId, threadId))
          ? sessionId
          : undefined;
      const capabilities = yield* adapters.value
        .get(shell.providerInstanceId)
        .pipe(Effect.flatMap((adapter) => adapter.getCapabilities()));
      const interactionMode = runInteractionMode(shell.interactionMode, activeRun?.harnessMode);
      const activeMode = yield* resolveRunHarnessMode(library.value, {
        modeId: shell.modeId,
        interactionMode: shell.interactionMode,
        workspaceRoot,
        override: activeRun?.harnessMode,
      });
      return {
        providerSessionId: liveSessionId ?? threadId,
        workspaceRoot,
        interactionMode,
        runtimeMode: shell.runtimeMode,
        activeMode,
        includeProposePlan: false,
        deferredExposure: false,
        harnessCapabilities: capabilities.harness,
        approval: {
          threadId,
          providerInstanceId: shell.providerInstanceId,
          providerSessionId: liveSessionId,
        },
      } satisfies McpGateway.GatewaySessionContext;
    });
    const context = yield* makeContext().pipe(
      Effect.mapError(() => fail(threadId, "request-failed")),
    );
    const validate = Effect.fn("McpAppRequests.validateGatewayContext")(function* () {
      const current = yield* makeContext().pipe(Effect.option);
      if (
        Option.isNone(current) ||
        current.value.workspaceRoot !== context.workspaceRoot ||
        current.value.interactionMode !== context.interactionMode ||
        current.value.runtimeMode !== context.runtimeMode ||
        current.value.providerSessionId !== context.providerSessionId ||
        current.value.activeMode?.contentDigest !== context.activeMode?.contentDigest ||
        current.value.approval.providerInstanceId !== context.approval.providerInstanceId
      ) {
        return yield* new HarnessError({
          code: "policy_denied",
          detail: "The app's thread settings changed.",
        });
      }
    });
    return {
      context: { ...context, approval: { ...context.approval, validate } },
      gateway: gateway.value,
      owner: { serverId, configId },
    };
  });

  const findAppTool = Effect.fn("McpAppRequests.findAppTool")(function* (
    resolved: Effect.Success<ReturnType<typeof resolveGateway>>,
    name: string,
  ) {
    const tools = yield* resolved.gateway.listAppTools(resolved.context, resolved.owner);
    return tools.find((tool) => tool.exposedName === name || tool.upstreamName === name);
  });

  const findTool = Effect.fn("McpAppRequests.findTool")(function* (
    threadId: ThreadId,
    resolved: Effect.Success<ReturnType<typeof resolve>>,
    name: string,
  ) {
    const tools = yield* resolved.mcpApps
      .listTools({ providerThread: resolved.providerThread, server: resolved.app.server })
      .pipe(Effect.mapError(adapterFailure(threadId)));
    return tools.find((tool) => tool.name === name);
  });

  const toolInfo = Effect.fn("McpAppRequests.toolInfo")(function* (input: McpAppToolInfoInput) {
    const app = yield* resolveApp(input);
    if (app.app.server === HARNESS_MCP_APP_SERVER) {
      const resolved = yield* resolveGateway(input.threadId, app);
      const tool = yield* findAppTool(resolved, input.name);
      if (tool === undefined) return { callable: false, readOnly: false };
      return {
        callable: true,
        readOnly: tool.readOnly,
        tool: {
          name: input.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: tool.readOnly },
          ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
        },
      } satisfies McpAppToolInfo;
    }
    const resolved = yield* resolve(input.threadId, app);
    const tool = yield* findTool(input.threadId, resolved, input.name);
    const title = tool === undefined ? undefined : toolTitle(tool);
    return {
      callable: tool !== undefined && mcpAppToolCallableByApp(tool._meta),
      readOnly: tool !== undefined && readOnlyHint(tool),
      ...(title === undefined ? {} : { title }),
      ...(tool === undefined ? {} : { tool }),
    } satisfies McpAppToolInfo;
  });

  const callTool = Effect.fn("McpAppRequests.callTool")(function* (input: McpAppCallToolInput) {
    const app = yield* resolveApp(input);
    if (app.app.server === HARNESS_MCP_APP_SERVER) {
      const resolved = yield* resolveGateway(input.threadId, app);
      const tool = yield* findAppTool(resolved, input.name);
      if (tool === undefined) return yield* fail(input.threadId, "tool-not-callable");
      return yield* resolved.gateway
        .callToolForSession({
          context: resolved.context,
          toolName: tool.exposedName,
          arguments: input.arguments,
          appOwner: resolved.owner,
        })
        .pipe(Effect.mapError(() => fail(input.threadId, "request-failed")));
    }
    const resolved = yield* resolve(input.threadId, app);
    // Enforce hidden-tool restrictions server-side; client checks cannot enforce the spec.
    const tool = yield* findTool(input.threadId, resolved, input.name);
    if (tool === undefined || !mcpAppToolCallableByApp(tool._meta)) {
      return yield* fail(input.threadId, "tool-not-callable");
    }
    return yield* resolved.mcpApps
      .callTool({
        providerThread: resolved.providerThread,
        server: resolved.app.server,
        tool: input.name,
        arguments: input.arguments,
      })
      .pipe(Effect.mapError(adapterFailure(input.threadId)));
  });

  const readResource = Effect.fn("McpAppRequests.readResource")(function* (
    input: McpAppReadResourceInput,
  ) {
    const app = yield* resolveApp(input);
    if (app.app.server === HARNESS_MCP_APP_SERVER) {
      const { gateway, context, owner } = yield* resolveGateway(input.threadId, app);
      const { serverId } = owner;
      const explicitGatewayUri = input.uri.startsWith("t3-harness://");
      if (
        explicitGatewayUri &&
        McpGateway.decodeCanonicalExposedResourceUri(input.uri)?.serverId !== serverId
      ) {
        return yield* fail(input.threadId, "request-failed");
      }
      const uri =
        explicitGatewayUri || input.uri === app.app.resourceUri
          ? input.uri
          : McpGateway.canonicalExposedResourceUri(serverId, input.uri);
      return yield* gateway.readResourceForSession({ context, uri, appOwner: owner }).pipe(
        Effect.map(({ contents }) => ({
          contents: contents.map((item) => ({ ...item, uri: input.uri })),
        })),
        Effect.mapError(() => fail(input.threadId, "request-failed")),
      );
    }
    const resolved = yield* resolve(input.threadId, app);
    return yield* resolved.mcpApps
      .readResource({
        providerThread: resolved.providerThread,
        server: resolved.app.server,
        uri: input.uri,
      })
      .pipe(Effect.mapError(adapterFailure(input.threadId)));
  });

  const descendsFrom = Effect.fn("McpAppRequests.descendsFrom")(function* (
    threadId: ThreadId,
    ancestorId: ThreadId,
  ) {
    const seen = new Set<ThreadId>();
    let current: ThreadId | null = threadId;
    while (current !== null && !seen.has(current)) {
      if (current === ancestorId) return true;
      seen.add(current);
      const records: { readonly thread: OrchestrationV2AppThread } = yield* threadManagement
        .getThreadRecords(current, [])
        .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
      const { lineage } = records.thread;
      current = lineage.relationshipToParent === "fork" ? lineage.parentThreadId : null;
    }
    return false;
  });

  const updateModelContext = Effect.fn("McpAppRequests.updateModelContext")(function* (
    input: McpAppUpdateModelContextInput,
  ) {
    const { app } = yield* resolveApp(input);
    // Context belongs only to the app's thread or its descendants.
    if (!(yield* descendsFrom(input.conversationThreadId, input.threadId))) {
      return yield* fail(input.threadId, "not-an-app");
    }
    const texts: Array<string> = [];
    for (const block of input.content ?? []) {
      if (!Predicate.isObject(block) || block.type !== "text" || typeof block.text !== "string") {
        return yield* fail(input.threadId, "unsupported-content");
      }
      texts.push(block.text);
    }
    if (input.structuredContent !== undefined) {
      texts.push(encodeJson(input.structuredContent));
    }
    const text = texts.join("\n");
    if (utf8.encode(text).byteLength > McpAppModelContext.MCP_APP_MODEL_CONTEXT_MAX_BYTES) {
      return yield* fail(
        input.threadId,
        "request-failed",
        new Error("Model context is too large."),
      );
    }
    yield* modelContext
      .set({
        threadId: input.conversationThreadId,
        itemId: input.itemId,
        server: app.server,
        tool: app.tool,
        text,
      })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  return McpAppRequests.of({ callTool, toolInfo, readResource, updateModelContext });
});

export const layer = Layer.effect(McpAppRequests, make);
