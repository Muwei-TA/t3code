import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HarnessApprovalRuleId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessApprovalAuditStore from "./HarnessApprovalAuditStore.ts";
import * as HarnessStore from "./HarnessStore.ts";

function makeTestLayer(baseDir: string, paths: ServerConfig.ServerDerivedPaths) {
  const configLayer = Layer.succeed(ServerConfig.ServerConfig, {
    ...paths,
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: baseDir,
    baseDir,
  } as unknown as ServerConfig.ServerConfig["Service"]);
  const policyLayer = Layer.succeed(ManagedPolicy.ManagedPolicy, {
    document: undefined,
    source: undefined,
    error: undefined,
  } as unknown as ManagedPolicy.ManagedPolicy["Service"]);
  const storeLayer = HarnessStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(policyLayer),
    Layer.provideMerge(T3ProjectFileLoader.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  const auditLayer = HarnessApprovalAuditStore.layer.pipe(Layer.provideMerge(storeLayer));
  return Layer.mergeAll(configLayer, policyLayer, storeLayer, auditLayer, NodeServices.layer);
}

describe("HarnessApprovalAuditStore", () => {
  it.effect("records, filters, persists, and revokes native approval grants", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-approval-audit-" });
      const baseDir = path.join(tempRoot, "t3home");
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const threadA = ThreadId.make("thread-a");
      const threadB = ThreadId.make("thread-b");

      const recorded = yield* Effect.gen(function* () {
        const audit = yield* HarnessApprovalAuditStore.HarnessApprovalAuditStore;
        const first = yield* audit.recordGrant({
          threadId: threadA,
          providerInstanceId: ProviderInstanceId.make("codex"),
          requestKind: "command",
          scope: "always",
          summary: "vp test run",
          workspaceRoot: "/repo/a",
        });
        const second = yield* audit.recordGrant({
          threadId: threadB,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          requestKind: "file-change",
          scope: "session",
          summary: "Edit src/app.ts",
          workspaceRoot: "/repo/b",
        });

        const allActive = yield* audit.list();
        expect(allActive).toHaveLength(2);
        const onlyThreadA = yield* audit.list({ threadId: threadA });
        expect(onlyThreadA).toHaveLength(1);
        expect(onlyThreadA[0]?.id).toBe(first.id);

        const revoked = yield* audit.revoke(first.id);
        expect(revoked.revokedAt).not.toBeNull();
        // Idempotent revoke keeps the original timestamp
        const revokedAgain = yield* audit.revoke(first.id);
        expect(revokedAgain.revokedAt).toBe(revoked.revokedAt);

        const activeAfterRevoke = yield* audit.list();
        expect(activeAfterRevoke.map((r) => r.id)).toEqual([second.id]);
        const withRevoked = yield* audit.list({ includeRevoked: true });
        expect(withRevoked).toHaveLength(2);

        const missingErr = yield* audit
          .revoke(HarnessApprovalRuleId.make("apr_missing"))
          .pipe(Effect.flip);
        expect(missingErr.code).toBe("not_found");
        return first.id;
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));

      const ledgerPath = path.join(baseDir, "harness", "approval-rules.json");
      const current = yield* fs.readFileString(ledgerPath);
      yield* fs.writeFileString(
        ledgerPath,
        current
          .replaceAll('      "source": "provider-audit",\n', "")
          .replaceAll(',\n      "source": "provider-audit"', ""),
      );
      // Reload from disk in a fresh layer to verify persistence
      yield* Effect.gen(function* () {
        const audit = yield* HarnessApprovalAuditStore.HarnessApprovalAuditStore;
        const reloaded = yield* audit.list({ includeRevoked: true });
        expect(reloaded).toHaveLength(2);
        expect(reloaded.find((r) => r.id === recorded)?.revokedAt).not.toBeNull();
        expect(reloaded.every((rule) => rule.source === undefined)).toBe(true);
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
