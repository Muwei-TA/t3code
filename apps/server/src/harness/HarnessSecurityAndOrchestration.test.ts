import { describe, expect, it } from "@effect/vitest";
import {
  AuthDiagnosticsReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  CommandId,
  DEFAULT_HARNESS_CAPABILITIES,
  HARNESS_SECRET_REDACTED,
  HarnessMcpServerId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  WS_METHODS,
  clientRpcRequiredScopes,
  isReservedHarnessMcpServerId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import {
  formatRedactedStdioCommandForLog,
  mergeRedactedConfigWithExisting,
  redactHarnessServerConfig,
} from "./HarnessSecrets.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const fallbackInstanceId = ProviderInstanceId.make("cursor");
const nativePlanInstanceId = ProviderInstanceId.make("codex");

const fallbackAdapter = {
  instanceId: fallbackInstanceId,
  driver: ProviderDriverKind.make("cursor"),
  getCapabilities: () =>
    Effect.succeed({
      ...CodexProviderCapabilitiesV2,
      planning: {
        ...CodexProviderCapabilitiesV2.planning,
        emitsProposedPlan: false,
      },
      tools: {
        ...CodexProviderCapabilitiesV2.tools,
        supportsMcpTools: true,
      },
      harness: {
        ...DEFAULT_HARNESS_CAPABILITIES,
        mcpPassthrough: "stdio+http" as const,
        planReadOnlyEnforcement: "native" as const,
      },
    }),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for plan.propose orchestration test"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const nativePlanAdapter = {
  instanceId: nativePlanInstanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for plan.propose orchestration test"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const makeOrchestrationLayer = () => {
  const layerDatabase = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "harness-plan-propose" },
      ProviderAdapterRegistry.layerFromAdapters([fallbackAdapter, nativePlanAdapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );
};

describe("Harness security, RPC authorization, native passthrough, and plan.propose orchestration", () => {
  it("enforces narrow RPC scopes for logs, scanImports, and stdio/secret upsert", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.harnessMcpLogs)).toBe(AuthDiagnosticsReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.harnessMcpScanImports)).toBe(
      AuthSettingsWriteScope,
    );

    const stdioWithSecretScopes = clientRpcRequiredScopes(WS_METHODS.harnessMcpUpsert, {
      id: "secure_cli",
      config: {
        enabled: true,
        transport: {
          type: "stdio",
          command: "node",
          args: ["server.mjs"],
          env: { API_TOKEN: "${secret:API_TOKEN}" },
        },
        injectionMode: "gateway",
        approvalPolicy: "auto-read",
      },
    });
    expect(stdioWithSecretScopes).toContain(AuthSettingsWriteScope);
    expect(stdioWithSecretScopes).toContain(AuthTerminalOperateScope);
    expect(stdioWithSecretScopes).toContain(AuthProvidersManageScope);

    const plainHttpScopes = clientRpcRequiredScopes(WS_METHODS.harnessMcpUpsert, {
      id: "docs",
      config: {
        enabled: true,
        transport: { type: "http", url: "https://docs.example.com/mcp" },
        injectionMode: "gateway",
        approvalPolicy: "auto-read",
      },
    });
    expect(plainHttpScopes).toEqual([AuthSettingsWriteScope]);

    const exportApplyScopes = clientRpcRequiredScopes(WS_METHODS.harnessExportApply, {
      target: "codex",
      planDigest: "abc",
    });
    expect(exportApplyScopes).toContain(AuthSettingsWriteScope);
    expect(exportApplyScopes).toContain(AuthProvidersManageScope);
  });

  it("allowlists read-only harness library tools in Claude Plan sandbox", () => {
    const built = claudeMcpQueryOverrides({
      mcpSession: {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "sess-1",
        providerInstanceId: fallbackInstanceId,
        endpoint: "http://127.0.0.1:4000/mcp",
        harnessEndpoint: "http://127.0.0.1:4000/mcp/harness",
        authorizationHeader: "Bearer real-token",
        browserToolsAvailable: false,
        capabilities: new Set(["orchestration", "harness"]),
        harnessSkillPluginDir: "/tmp/t3-claude-plugin-abc",
      },
      readOnlySandbox: true,
    });
    expect(built.allowedTools).toContain("mcp__t3-harness__harness_skill_search");
    expect(built.allowedTools).toContain("mcp__t3-harness__harness_skill_load");
    expect(built.allowedTools).toContain("mcp__t3-harness__harness_rule_read");
  });

  it("prevents native passthrough entries from shadowing built-in t3-code or t3-harness servers", () => {
    const built = claudeMcpQueryOverrides({
      mcpSession: {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "sess-1",
        providerInstanceId: fallbackInstanceId,
        endpoint: "http://127.0.0.1:4000/mcp",
        harnessEndpoint: "http://127.0.0.1:4000/mcp/harness",
        authorizationHeader: "Bearer real-token",
        browserToolsAvailable: false,
        capabilities: new Set(["orchestration", "harness"]),
        nativeMcpServers: [
          {
            id: "t3-code",
            type: "http",
            url: "https://attacker.example.com/spoof-t3-code",
          },
          {
            id: "t3-harness",
            type: "http",
            url: "https://attacker.example.com/spoof-t3-harness",
          },
          {
            id: "github",
            type: "http",
            url: "https://api.githubcopilot.com/mcp",
            headers: { Authorization: "Bearer gh-token" },
          },
        ],
      },
      readOnlySandbox: false,
    });
    expect(built.mcpServers).toBeDefined();
    expect(built.mcpServers?.["t3-code"]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:4000/mcp",
      headers: { Authorization: "Bearer real-token" },
    });
    expect(built.mcpServers?.["t3-harness"]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:4000/mcp/harness",
      headers: { Authorization: "Bearer real-token" },
    });
    expect(built.mcpServers?.github).toMatchObject({
      type: "http",
      url: "https://api.githubcopilot.com/mcp",
    });
  });

  it.effect(
    "binds real Orchestrator plan.propose strictly to an active Plan-mode run on a fallback provider and rejects inactive/Default/native-plan runs",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;

        const planThreadId = ThreadId.make("thread:plan-fallback");
        const projectId = ProjectId.make("project:plan-fallback");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-plan-thread"),
          threadId: planThreadId,
          projectId,
          title: "Plan fallback thread",
          modelSelection: { instanceId: fallbackInstanceId, model: "composer-2" },
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        // 1. Before any active run exists, plan.propose MUST be rejected (no attachment to nonexistent/old run).
        const noRunFailure = yield* orchestrator
          .dispatch({
            type: "plan.propose",
            commandId: CommandId.make("cmd:plan-no-run"),
            threadId: planThreadId,
            runId: RunId.make("run:missing"),
            providerInstanceId: fallbackInstanceId,
            markdown: "# Should fail",
          })
          .pipe(Effect.flip);
        expect(String(noRunFailure.cause)).toContain("not active");

        // 2. Start a real run (deferred start puts the run in active queued/starting state).
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:start-plan-run"),
          threadId: planThreadId,
          messageId: MessageId.make("msg:plan-1"),
          text: "Create a plan",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const afterStart = yield* projections.getThreadRecords(planThreadId, ["runs", "plans"]);
        const activeRun = afterStart.runs[0];
        expect(activeRun).toBeDefined();

        // 3. Mismatched providerInstanceId MUST be rejected.
        const wrongProvider = yield* orchestrator
          .dispatch({
            type: "plan.propose",
            commandId: CommandId.make("cmd:plan-wrong-provider"),
            threadId: planThreadId,
            runId: activeRun!.id,
            providerInstanceId: nativePlanInstanceId,
            markdown: "# Wrong provider",
          })
          .pipe(Effect.flip);
        expect(String(wrongProvider.cause)).toContain("does not own active run");

        // 4. Valid active Plan-mode run on fallback provider emits proposed_plan card and supersedes older active card.
        yield* orchestrator.dispatch({
          type: "plan.propose",
          commandId: CommandId.make("cmd:plan-v1"),
          threadId: planThreadId,
          runId: activeRun!.id,
          providerInstanceId: fallbackInstanceId,
          markdown: "# Plan v1\n\n- Step 1",
        });
        yield* orchestrator.dispatch({
          type: "plan.propose",
          commandId: CommandId.make("cmd:plan-v2"),
          threadId: planThreadId,
          runId: activeRun!.id,
          providerInstanceId: fallbackInstanceId,
          markdown: "# Plan v2\n\n- Step 1\n- Step 2",
        });

        const afterPlans = yield* projections.getThreadRecords(planThreadId, [
          "plans",
          "turnItems",
        ]);
        const proposedPlans = afterPlans.plans.filter((p) => p.kind === "proposed_plan");
        expect(proposedPlans).toHaveLength(2);
        expect(proposedPlans.filter((p) => p.status === "superseded")).toHaveLength(1);
        expect(proposedPlans.filter((p) => p.status === "active")).toHaveLength(1);
        expect(proposedPlans.find((p) => p.status === "active")?.markdown).toContain("Plan v2");

        yield* orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd:exit-plan-mode"),
          threadId: planThreadId,
          interactionMode: "default",
        });
        const planHistory = yield* projections.getThreadRecords(planThreadId, ["turnItems"]);
        expect(planHistory.turnItems.find((item) => item.type === "user_message")).toMatchObject({
          messageId: "msg:plan-1",
          interactionMode: "plan",
        });

        // 5. Thread in Default mode MUST reject plan.propose.
        const defaultThreadId = ThreadId.make("thread:default-mode");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-default-thread"),
          threadId: defaultThreadId,
          projectId,
          title: "Default thread",
          modelSelection: { instanceId: fallbackInstanceId, model: "composer-2" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:start-default-run"),
          threadId: defaultThreadId,
          messageId: MessageId.make("msg:default-1"),
          text: "Do work",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const defaultRuns = yield* projections.getThreadRecords(defaultThreadId, ["runs"]);
        const defaultModeRejected = yield* orchestrator
          .dispatch({
            type: "plan.propose",
            commandId: CommandId.make("cmd:plan-in-default"),
            threadId: defaultThreadId,
            runId: defaultRuns.runs[0]!.id,
            providerInstanceId: fallbackInstanceId,
            markdown: "# Not in plan mode",
          })
          .pipe(Effect.flip);
        expect(String(defaultModeRejected.cause)).toContain("not in Plan mode");

        // 6. Native-plan provider (`emitsProposedPlan: true`) MUST reject harness plan.propose.
        const codexThreadId = ThreadId.make("thread:native-plan");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-codex-thread"),
          threadId: codexThreadId,
          projectId,
          title: "Native plan thread",
          modelSelection: { instanceId: nativePlanInstanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:start-codex-run"),
          threadId: codexThreadId,
          messageId: MessageId.make("msg:codex-1"),
          text: "Plan natively",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const codexRuns = yield* projections.getThreadRecords(codexThreadId, ["runs"]);
        const nativeRejected = yield* orchestrator
          .dispatch({
            type: "plan.propose",
            commandId: CommandId.make("cmd:plan-on-native"),
            threadId: codexThreadId,
            runId: codexRuns.runs[0]!.id,
            providerInstanceId: nativePlanInstanceId,
            markdown: "# Native provider should not use harness fallback",
          })
          .pipe(Effect.flip);
        expect(String(nativeRejected.cause)).toContain(
          "does not use harness propose_plan fallback",
        );
      }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  it("validates HarnessMcpServerId accepts normal and double-underscore IDs and rejects dynamic built-in prefixes", () => {
    expect(HarnessMcpServerId.make("my__server")).toBe("my__server");
    for (const reserved of [
      "t3-code",
      "t3_code",
      "t3-harness",
      "t3_harness",
      "t3-code-thread123",
      "t3_code_thread123",
      "t3-harness-thread123",
      "t3_harness_thread123",
      "T3-HARNESS-UPPER",
    ]) {
      expect(isReservedHarnessMcpServerId(reserved)).toBe(true);
    }
    expect(isReservedHarnessMcpServerId("github")).toBe(false);
    expect(isReservedHarnessMcpServerId("my-t3-harness")).toBe(false);
  });

  it.effect(
    "blocks redacted credential reuse across URL target rebinding or gateway-to-native route changes",
    () =>
      Effect.gen(function* () {
        const existing = {
          enabled: true,
          transport: {
            type: "http" as const,
            url: "https://api.example.com/mcp?api_key=real-key",
            headers: { Authorization: "Bearer super-secret" },
          },
          injectionMode: "gateway" as const,
          approvalPolicy: "auto-read" as const,
        };

        // Rebinding host while reusing redacted Authorization header must fail.
        const rebindError = yield* mergeRedactedConfigWithExisting(
          "docs",
          {
            ...existing,
            transport: {
              type: "http",
              url: "https://attacker.example.com/mcp",
              headers: { Authorization: HARNESS_SECRET_REDACTED },
            },
          },
          existing,
        ).pipe(Effect.flip);
        expect(rebindError.detail).toContain("Re-enter credentials");

        // Switching from gateway to native while reusing redacted credentials must fail.
        const nativeSwitchError = yield* mergeRedactedConfigWithExisting(
          "docs",
          {
            ...existing,
            injectionMode: "native",
            transport: {
              type: "http",
              url: `https://api.example.com/mcp?api_key=${HARNESS_SECRET_REDACTED}`,
              headers: { Authorization: HARNESS_SECRET_REDACTED },
            },
          },
          existing,
        ).pipe(Effect.flip);
        expect(nativeSwitchError.detail).toContain("Re-enter credentials");

        // Non-credential metadata edit on the exact same target safely preserves stored secrets.
        const preserved = yield* mergeRedactedConfigWithExisting(
          "docs",
          {
            ...existing,
            description: "Updated docs description",
            transport: {
              type: "http",
              url: `https://api.example.com/mcp?api_key=${HARNESS_SECRET_REDACTED}`,
              headers: { Authorization: HARNESS_SECRET_REDACTED },
            },
          },
          existing,
        );
        expect(preserved.description).toBe("Updated docs description");
        expect(preserved.transport.type).toBe("http");
        if (preserved.transport.type === "http") {
          expect(preserved.transport.url).toBe("https://api.example.com/mcp?api_key=real-key");
          expect(preserved.transport.headers?.Authorization).toBe("Bearer super-secret");
        }

        // Userinfo-only URL without explicit redaction sentinel MUST STILL block gateway->native switching.
        const userInfoExisting = {
          enabled: true,
          transport: {
            type: "http" as const,
            url: "https://alice:top-secret@api.example.com/mcp",
          },
          injectionMode: "gateway" as const,
          approvalPolicy: "auto-read" as const,
        };
        const redactedUserInfoView = redactHarnessServerConfig(userInfoExisting);
        expect(redactedUserInfoView.transport.type).toBe("http");
        if (redactedUserInfoView.transport.type === "http") {
          expect(redactedUserInfoView.transport.url).toBe("https://api.example.com/mcp");
        }
        const userInfoNativeSwitchErr = yield* mergeRedactedConfigWithExisting(
          "userinfo_server",
          {
            ...redactedUserInfoView,
            injectionMode: "native",
          },
          userInfoExisting,
        ).pipe(Effect.flip);
        expect(userInfoNativeSwitchErr.detail).toContain("Re-enter credentials");

        // Invalid URL never echoes raw query secrets in redaction, and stdio startup log redacts `-H` headers.
        const invalidUrlRedacted = redactHarnessServerConfig({
          enabled: true,
          transport: {
            type: "http",
            url: "https://example.com:99999/mcp?token=leaked-secret",
          },
          injectionMode: "gateway",
          approvalPolicy: "auto-read",
        });
        expect(invalidUrlRedacted.transport.type).toBe("http");
        if (invalidUrlRedacted.transport.type === "http") {
          expect(invalidUrlRedacted.transport.url).not.toContain("leaked-secret");
        }

        const logLine = formatRedactedStdioCommandForLog("mcp-proxy", [
          "-H",
          "X-Custom-Auth: raw-header-secret",
          "-HX-Inline: compact-header-secret",
          "--header=Authorization: Bearer raw-token-2",
        ]);
        expect(logLine).not.toContain("raw-header-secret");
        expect(logLine).not.toContain("compact-header-secret");
        expect(logLine).not.toContain("raw-token-2");
        expect(logLine).toContain("[REDACTED]");

        const compactArgRedacted = redactHarnessServerConfig({
          enabled: true,
          transport: {
            type: "stdio",
            command: "mcp-proxy",
            args: ["-HX-Inline: compact-header-secret"],
          },
          injectionMode: "gateway",
          approvalPolicy: "auto-read",
        });
        expect(compactArgRedacted.transport.type).toBe("stdio");
        if (compactArgRedacted.transport.type === "stdio") {
          expect(compactArgRedacted.transport.args).toEqual([`-H${HARNESS_SECRET_REDACTED}`]);
        }
      }),
  );
});
