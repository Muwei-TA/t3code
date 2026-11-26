import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as McpGateway from "../harness/McpGateway.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as Capture from "./GatewayMcpAppCapture.ts";

it.effect.each([true, false])(
  "settles snapshot files after waiting for a live run commit (%s)",
  (commit) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const threadId = ThreadId.make("gateway-fixture");
      const run = {
        id: RunId.make("run"),
        activeAttemptId: RunAttemptId.make("attempt"),
        rootNodeId: NodeId.make("node"),
        providerThreadId: ProviderThreadId.make("provider-thread"),
        providerInstanceId: ProviderInstanceId.make("provider"),
        status: "starting",
        ordinal: 1,
      } as OrchestrationV2Run;
      const entered = yield* Deferred.make<void>();
      const settle = yield* Deferred.make<void>();
      const writes: Array<Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0]> =
        [];
      const layer = Capture.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(McpGateway.McpGateway)({
              readResourceForSession: ({ uri }) =>
                Effect.succeed({
                  contents: [
                    { uri, mimeType: "text/html;profile=mcp-app", text: "<p>Fixture</p>" },
                  ],
                }),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({ getRun: () => Effect.succeed(run) }),
            Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
              allocate: () => Effect.succeed(1),
            }),
            IdAllocator.layer,
            Layer.mock(EventSink.EventSinkV2)({
              writeIfRunCurrent: (input) =>
                Effect.gen(function* () {
                  writes.push(input);
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(settle);
                  return {
                    committed: commit && input.expectedStatus === "running",
                    storedEvents: [],
                  };
                }),
            }),
          ),
        ),
      );
      const capture = yield* Effect.provide(Capture.GatewayMcpAppCapture, layer);
      const publishing = yield* capture
        .publish({
          threadId,
          run,
          context: {
            providerSessionId: "session",
            interactionMode: "default",
            runtimeMode: "approval-required",
            includeProposePlan: false,
            deferredExposure: false,
          },
          tool: "fixture__show",
          source: { uri: "ui://fixture/card", configId: "test-config" },
          arguments: {},
          result: { content: [] },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.lengthOf(yield* fileSystem.readDirectory(attachmentsDir), 1);
      if (!commit) yield* Fiber.interrupt(publishing).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(settle, undefined);
      yield* Fiber.await(publishing);
      assert.deepEqual(
        writes.map((write) => write.expectedStatus),
        ["starting", "running"],
      );
      assert.deepEqual(writes[0]?.unlessInterruptRequested, {
        requestId: IdAllocator.derive.runSignalTurnItem({
          runId: run.id,
          signal: "interrupt-request",
        }),
        resultId: IdAllocator.derive.runSignalTurnItem({
          runId: run.id,
          signal: "interrupt-result",
        }),
      });
      assert.lengthOf(yield* fileSystem.readDirectory(attachmentsDir), commit ? 1 : 0);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-gateway-app-capture-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
);
