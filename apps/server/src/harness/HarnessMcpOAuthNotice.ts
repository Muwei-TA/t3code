import { CommandId, type HarnessMcpServerId, type ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";

export class HarnessMcpOAuthNotice extends Context.Service<
  HarnessMcpOAuthNotice,
  {
    readonly publish: (threadId: ThreadId, serverId: HarnessMcpServerId) => Effect.Effect<void>;
  }
>()("t3/harness/HarnessMcpOAuthNotice") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const publish: HarnessMcpOAuthNotice["Service"]["publish"] = Effect.fn(
    "HarnessMcpOAuthNotice.publish",
  )(
    function* (threadId: ThreadId, serverId: HarnessMcpServerId) {
      const shell = yield* projections.getThreadShell(threadId);
      if (
        shell === null ||
        shell.activeRunId === null ||
        shell.deletedAt !== null ||
        shell.archivedAt !== null
      )
        return;
      const run = yield* projections.getRun(threadId, shell.activeRunId);
      if (!run?.activeAttemptId || !run.providerThreadId) return;
      const signal = `harness-mcp-sign-in:${serverId}`;
      const turnItemId = ids.derive.runSignalTurnItem({ runId: run.id, signal });
      const commandId = CommandId.make(`${signal}:${run.id}`);
      const ordinal = yield* positions.allocate({
        threadId,
        turnItemId,
        runId: run.id,
        runOrdinal: run.ordinal,
      });
      const now = yield* DateTime.now;
      const id = yield* ids.allocate.event({ threadId, commandId });
      yield* sink.writeIfRunCurrent({
        commandId,
        threadId,
        runId: run.id,
        activeAttemptId: run.activeAttemptId,
        expectedStatus: run.status,
        events: [
          {
            id,
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              id: turnItemId,
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: run.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              type: "system_notice",
              status: "completed",
              title: `MCP sign-in required for ${serverId}`,
              message: "Sign in to this MCP server to load its tools.",
              mcpSignIn: { server: `t3-harness:${serverId}` },
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
        ],
      });
    },
    (effect) => Effect.ignore(effect),
  );
  return HarnessMcpOAuthNotice.of({ publish });
});

export const layer = Layer.effect(HarnessMcpOAuthNotice, make);
