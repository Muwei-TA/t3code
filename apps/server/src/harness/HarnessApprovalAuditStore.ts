// @effect-diagnostics nodeBuiltinImport:off -- Uses node:crypto randomUUID for approval audit record identifiers and atomic temp writes.
import * as NodeCrypto from "node:crypto";
import {
  HarnessApprovalRuleId,
  HarnessApprovalRuleRecord,
  type HarnessApprovalRuleScope,
  HarnessError,
  IsoDateTime,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as HarnessStore from "./HarnessStore.ts";

const MAX_APPROVAL_AUDIT_RECORDS = 500;

const ApprovalAuditLedger = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  rules: Schema.Array(HarnessApprovalRuleRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});

const decodeLedgerJson = Schema.decodeUnknownOption(Schema.fromJsonString(ApprovalAuditLedger));

function serializeLedger(rules: ReadonlyArray<HarnessApprovalRuleRecord>): string {
  return `${JSON.stringify({ schemaVersion: 1, rules }, null, 2)}\n`;
}

export class HarnessApprovalAuditStore extends Context.Service<
  HarnessApprovalAuditStore,
  {
    readonly recordGrant: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly requestKind: string;
      readonly scope: HarnessApprovalRuleScope;
      readonly summary: string;
      readonly appName?: string | undefined;
      readonly workspaceRoot?: string | null | undefined;
    }) => Effect.Effect<HarnessApprovalRuleRecord>;
    readonly list: (input?: {
      readonly threadId?: ThreadId | undefined;
      readonly includeRevoked?: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<HarnessApprovalRuleRecord>>;
    readonly revoke: (
      id: HarnessApprovalRuleId,
    ) => Effect.Effect<HarnessApprovalRuleRecord, HarnessError>;
  }
>()("t3/harness/HarnessApprovalAuditStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* HarnessStore.HarnessStore;
  const ledgerPath = path.join(store.harnessDir, "approval-rules.json");
  const lock = yield* Semaphore.make(1);

  const loadRules = Effect.fn("HarnessApprovalAuditStore.loadRules")(function* () {
    const raw = yield* fs.readFileString(ledgerPath).pipe(Effect.option);
    if (raw._tag === "None") return [] as Array<HarnessApprovalRuleRecord>;
    const decoded = decodeLedgerJson(raw.value);
    return decoded._tag === "Some" ? [...decoded.value.rules] : [];
  });

  const saveRules = Effect.fn("HarnessApprovalAuditStore.saveRules")(function* (
    rules: ReadonlyArray<HarnessApprovalRuleRecord>,
  ) {
    yield* fs.makeDirectory(path.dirname(ledgerPath), { recursive: true }).pipe(Effect.ignore);
    const tmpPath = `${ledgerPath}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(tmpPath, serializeLedger(rules)).pipe(
      Effect.andThen(fs.rename(tmpPath, ledgerPath)),
      Effect.onError(() => fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
      Effect.ignore,
    );
  });

  const recordGrant: HarnessApprovalAuditStore["Service"]["recordGrant"] = Effect.fn(
    "HarnessApprovalAuditStore.recordGrant",
  )(function* (input) {
    const now = yield* DateTime.now;
    const trimmedSummary = input.summary.trim().slice(0, 500) || input.requestKind;
    const record: HarnessApprovalRuleRecord = {
      id: HarnessApprovalRuleId.make(
        `apr_${NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      ),
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      requestKind: input.requestKind,
      scope: input.scope,
      summary: trimmedSummary,
      ...(input.appName !== undefined && input.appName.trim().length > 0
        ? { appName: input.appName.trim() }
        : {}),
      workspaceRoot: input.workspaceRoot ?? null,
      createdAt: IsoDateTime.make(DateTime.formatIso(now)),
      revokedAt: null,
    };

    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* loadRules();
        const next = [record, ...existing].slice(0, MAX_APPROVAL_AUDIT_RECORDS);
        yield* saveRules(next);
      }),
    );

    return record;
  });

  const list: HarnessApprovalAuditStore["Service"]["list"] = Effect.fn(
    "HarnessApprovalAuditStore.list",
  )(function* (input) {
    const rules = yield* loadRules();
    return rules.filter((rule) => {
      if (input?.threadId !== undefined && rule.threadId !== input.threadId) return false;
      if (input?.includeRevoked !== true && rule.revokedAt !== null) return false;
      return true;
    });
  });

  const revoke: HarnessApprovalAuditStore["Service"]["revoke"] = Effect.fn(
    "HarnessApprovalAuditStore.revoke",
  )(function* (id) {
    const now = yield* DateTime.now;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const rules = yield* loadRules();
        const idx = rules.findIndex((rule) => rule.id === id);
        if (idx === -1) {
          return yield* new HarnessError({
            code: "not_found",
            detail: `Approval rule "${id}" was not found.`,
          });
        }
        const current = rules[idx]!;
        const updated: HarnessApprovalRuleRecord =
          current.revokedAt !== null
            ? current
            : { ...current, revokedAt: IsoDateTime.make(DateTime.formatIso(now)) };
        rules[idx] = updated;
        yield* saveRules(rules);
        return updated;
      }),
    );
  });

  return HarnessApprovalAuditStore.of({
    recordGrant,
    list,
    revoke,
  });
});

export const layer = Layer.effect(HarnessApprovalAuditStore, make);
