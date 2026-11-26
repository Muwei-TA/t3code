import { assert, it } from "@effect/vitest";
import {
  HarnessError,
  HarnessMcpServerId,
  ProjectId,
  ProviderThreadId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpGateway from "../harness/McpGateway.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpSignIn from "./McpSignIn.ts";

it.effect("binds chat OAuth to the gateway server and the thread's worktree", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const threadId = ThreadId.make("thread");
  const worktreePath = TrimmedNonEmptyString.make("/test/worktree");
  const serverId = HarnessMcpServerId.make("portable");
  const callbackUrl = TrimmedNonEmptyString.make("http://127.0.0.1/oauth/harness/callback");
  const authorizationUrl = "https://auth.example/authorize";
  let connected = false;
  const services = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({
          thread: {
            projectId: ProjectId.make("project"),
            worktreePath,
            archivedAt: null,
            deletedAt: null,
          },
          providerThreads: [{ id: providerThreadId }],
        } as never),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
    Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
    Layer.mock(McpGateway.McpGateway)({
      getSnapshot: () =>
        Effect.succeed({
          servers: connected
            ? [
                {
                  id: serverId,
                  effectiveEnabled: true,
                  state: "connected",
                  oauthStatus: "connected",
                },
              ]
            : [],
        } as never),
      startOAuth: (input) =>
        Effect.sync(() => {
          assert.deepEqual(input, { serverId, workspaceRoot: worktreePath });
          return { authorizationUrl };
        }),
      completeOAuth: (address, expected) =>
        Effect.gen(function* () {
          assert.equal(address, callbackUrl);
          assert.equal(expected?.workspaceRoot, worktreePath);
          if (expected?.serverId !== serverId)
            return yield* new HarnessError({ code: "invalid_config", detail: "Server mismatch." });
          connected = true;
          return { servers: [] } as never;
        }),
    }),
  );
  return Effect.gen(function* () {
    const signIn = yield* McpSignIn.McpSignIn;
    const input = { threadId, providerThreadId, server: `t3-harness:${serverId}` };
    assert.deepEqual(yield* signIn.start(input), { authorizationUrl, signedInAt: null });
    const error = yield* Effect.flip(
      signIn.complete({ ...input, server: "t3-harness:other", callbackUrl }),
    );
    assert.equal(error._tag, "ProviderMcpSignInError");
    assert.isFalse(connected);
    assert.isString((yield* signIn.complete({ ...input, callbackUrl })).signedInAt);
    const status = yield* signIn.start(input);
    assert.isNull(status.authorizationUrl);
    assert.isString(status.signedInAt);
  }).pipe(Effect.provide(McpSignIn.layer.pipe(Layer.provide(services))));
});
