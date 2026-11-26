import {
  CommandId,
  HarnessMcpServerId,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { HARNESS_MCP_APP_SERVER, MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import * as McpGateway from "../harness/McpGateway.ts";
import type { UpstreamMcpCallResult } from "../harness/McpUpstreamClient.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import { stripUnservedToolOutputImageBytes } from "../orchestration-v2/toolOutputImageBytes.ts";
import { snapshotMcpApp } from "./McpAppSnapshot.ts";

export const gatewayAppTurnItemSignal = (attachmentId: string) => `gateway-mcp-app:${attachmentId}`;

export class GatewayMcpAppCapture extends Context.Service<
  GatewayMcpAppCapture,
  {
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly run: OrchestrationV2Run;
      readonly context: McpGateway.GatewaySessionContext;
      readonly tool: string;
      readonly source: { readonly uri: string; readonly configId: string };
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly result: UpstreamMcpCallResult;
    }) => Effect.Effect<void>;
  }
>()("t3/mcpApps/GatewayMcpAppCapture") {}

const make = Effect.gen(function* () {
  const gateway = yield* McpGateway.McpGateway;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const publish: GatewayMcpAppCapture["Service"]["publish"] = Effect.fn(
    "GatewayMcpAppCapture.publish",
  )(
    function* ({ threadId, run, context, tool, source, arguments: args, result }) {
      const owner = McpGateway.decodeCanonicalExposedToolName(tool);
      if (owner === null || !run.activeAttemptId || !run.providerThreadId) return;
      const resourceUri = source.uri;
      const resource = yield* gateway
        .readResourceForSession({
          context,
          uri: resourceUri,
          appOwner: {
            serverId: HarnessMcpServerId.make(owner.serverId),
            configId: source.configId,
          },
          connectedOnly: true,
        })
        .pipe(Effect.timeoutOption("3 seconds"));
      if (Option.isNone(resource)) return;
      const app = yield* snapshotMcpApp({
        attachmentsDir: config.attachmentsDir,
        threadId,
        server: HARNESS_MCP_APP_SERVER,
        tool,
        resourceUri,
        contents: resource.value.contents,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      if (app === undefined) return;

      // The gateway is the source of truth even if the provider omits the tool event or its identity.
      const signal = gatewayAppTurnItemSignal(app.attachmentId);
      const itemId = ids.derive.runSignalTurnItem({ runId: run.id, signal });
      const commandId = CommandId.make(signal);
      const now = yield* DateTime.now;
      const committed = yield* Effect.gen(function* () {
        const current = yield* projections.getRun(threadId, run.id);
        if (
          current?.activeAttemptId !== run.activeAttemptId ||
          (current.status !== "starting" && current.status !== "running")
        )
          return false;
        const ordinal = yield* positions.allocate({
          threadId,
          turnItemId: itemId,
          runId: run.id,
          runOrdinal: run.ordinal,
        });
        const id = yield* ids.allocate.event({ threadId, commandId });
        const written = yield* sink.writeIfRunCurrent({
          commandId,
          threadId,
          runId: run.id,
          activeAttemptId: run.activeAttemptId!,
          expectedStatus: current.status,
          events: [
            {
              id,
              type: "turn-item.updated",
              threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: stripUnservedToolOutputImageBytes({
                id: itemId,
                type: "dynamic_tool",
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerThreadId: run.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                toolName: `${HARNESS_MCP_APP_SERVER}.${tool}`,
                input: args,
                output: { [MCP_APP_OUTPUT_KEY]: app, result, gatewayConfigId: source.configId },
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              }),
            },
          ],
        });
        return written.committed;
      }).pipe(
        Effect.catch(() =>
          projections.getTurnItem({ threadId, itemId }).pipe(
            Effect.map((item) => item !== null),
            Effect.orElseSucceed(() => true),
          ),
        ),
        Effect.uninterruptible,
      );
      if (committed) return;
      const path = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${app.attachmentId}.html`,
      });
      if (path !== null) yield* fileSystem.remove(path, { force: true }).pipe(Effect.ignore);
    },
    Effect.catchCause(() => Effect.logDebug("Gateway MCP app capture did not complete")),
  );
  return GatewayMcpAppCapture.of({ publish });
});

export const layer = Layer.effect(GatewayMcpAppCapture, make);
