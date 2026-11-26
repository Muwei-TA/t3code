import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ThreadId, type RuntimeRequestId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as HarnessApprovalBroker from "./HarnessApprovalBroker.ts";

it.effect("delivers a decision only to the owning thread and cancels expired approvals", () =>
  Effect.gen(function* () {
    const broker = yield* HarnessApprovalBroker.HarnessApprovalBroker;
    const threadId = ThreadId.make("approval-thread");
    const opened = yield* Deferred.make<RuntimeRequestId>();
    const cancelled = yield* Deferred.make<RuntimeRequestId>();
    const fiber = yield* broker
      .requestApproval({
        threadId,
        open: (requestId) => Deferred.succeed(opened, requestId).pipe(Effect.asVoid),
        cancel: (requestId) => Deferred.succeed(cancelled, requestId).pipe(Effect.asVoid),
        invalidated: Effect.never,
      })
      .pipe(Effect.forkChild);
    const requestId = yield* Deferred.await(opened);
    assert.isFalse(
      yield* broker.resolveApproval({
        threadId: ThreadId.make("unrelated"),
        requestId,
        decision: "accept",
      }),
    );
    assert.isTrue(
      yield* broker.resolveApproval({
        threadId,
        requestId,
        decision: "decline",
        feedback: "Use a read-only operation.",
      }),
    );
    assert.deepEqual(yield* Fiber.join(fiber), {
      decision: "decline",
      feedback: "Use a read-only operation.",
    });
    assert.isFalse(yield* Deferred.isDone(cancelled));
    assert.isFalse(yield* broker.resolveApproval({ threadId, requestId, decision: "accept" }));

    const expiring = yield* Deferred.make<RuntimeRequestId>();
    const timed = yield* broker
      .requestApproval({
        threadId,
        open: (id) => Deferred.succeed(expiring, id).pipe(Effect.asVoid),
        cancel: (id) => Deferred.succeed(cancelled, id).pipe(Effect.asVoid),
        invalidated: Effect.never,
      })
      .pipe(Effect.flip, Effect.forkChild);
    const pending = yield* Deferred.await(expiring);
    yield* TestClock.adjust("5 minutes");
    assert.equal((yield* Fiber.join(timed)).code, "policy_denied");
    assert.equal(yield* Deferred.await(cancelled), pending);
    assert.isFalse(
      yield* broker.resolveApproval({
        threadId,
        requestId: pending,
        decision: "acceptAlways",
      }),
    );
  }).pipe(Effect.provide(HarnessApprovalBroker.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);
