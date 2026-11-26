import {
  HarnessError,
  type ProviderApprovalDecision,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface ApprovalDecision {
  readonly decision: ProviderApprovalDecision;
  readonly feedback?: string | undefined;
}

interface ApprovalWait {
  readonly threadId: ThreadId;
  readonly open: (id: RuntimeRequestId) => Effect.Effect<void, HarnessError>;
  readonly cancel: (id: RuntimeRequestId) => Effect.Effect<void>;
  readonly invalidated: Effect.Effect<never, HarnessError>;
}

export class HarnessApprovalBroker extends Context.Service<
  HarnessApprovalBroker,
  {
    readonly requestApproval: (
      input: ApprovalWait,
    ) => Effect.Effect<ApprovalDecision, HarnessError>;
    readonly resolveApproval: (
      input: ApprovalDecision & {
        readonly threadId: ThreadId;
        readonly requestId: RuntimeRequestId;
      },
    ) => Effect.Effect<boolean>;
  }
>()("t3/harness/HarnessApprovalBroker") {}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const pending = new Map<
    RuntimeRequestId,
    { readonly threadId: ThreadId; readonly decision: Deferred.Deferred<ApprovalDecision> }
  >();
  const requestApproval = Effect.fn("HarnessApprovalBroker.requestApproval")(function* (
    input: ApprovalWait,
  ) {
    const requestId = RuntimeRequestId.make(`req:harness-gateway:${yield* random.uuidV4()}`);
    const decision = yield* Deferred.make<ApprovalDecision>();
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => pending.set(requestId, { threadId: input.threadId, decision })),
      () =>
        input.open(requestId).pipe(
          Effect.andThen(Effect.raceFirst(Deferred.await(decision), input.invalidated)),
          Effect.timeoutOrElse({
            duration: "5 minutes",
            orElse: () =>
              Effect.fail(
                new HarnessError({
                  code: "policy_denied",
                  detail: "The MCP approval request expired.",
                }),
              ),
          }),
        ),
      (_, exit) =>
        Effect.sync(() => pending.delete(requestId)).pipe(
          Effect.andThen(exit._tag === "Failure" ? input.cancel(requestId) : Effect.void),
        ),
    );
  });
  const resolveApproval: HarnessApprovalBroker["Service"]["resolveApproval"] = Effect.fn(
    "HarnessApprovalBroker.resolveApproval",
  )(function* ({ threadId, requestId, ...answer }) {
    const entry = pending.get(requestId);
    return entry?.threadId === threadId ? yield* Deferred.succeed(entry.decision, answer) : false;
  });
  return HarnessApprovalBroker.of({ requestApproval, resolveApproval });
});

export const layer = Layer.effect(HarnessApprovalBroker, make);
