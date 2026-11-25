import {
  HarnessError,
  type HarnessPlanModeKind,
  type HarnessPlanReadOnlyEnforcement,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  type ThreadContextDegradedItem,
  type ThreadContextManifest,
  type ThreadContextMcpItem,
  type ThreadContextTokenUsage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HarnessApprovalAuditStore from "./HarnessApprovalAuditStore.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import * as HarnessMemoryStore from "./HarnessMemoryStore.ts";
import {
  isMcpServerAllowedByMode,
  type NativeDiscoveredSkill,
  projectHarnessContext,
} from "./HarnessProjector.ts";
import * as McpGateway from "./McpGateway.ts";
import * as PluginHost from "./PluginHost.ts";

export class HarnessContextService extends Context.Service<
  HarnessContextService,
  {
    readonly getThreadContextManifest: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadContextManifest, HarnessError>;
  }
>()("t3/harness/HarnessContextService") {}

const make = Effect.gen(function* () {
  const gateway = yield* McpGateway.McpGateway;
  const libraryStore = yield* Effect.serviceOption(HarnessLibraryStore.HarnessLibraryStore);
  const memoryStore = yield* Effect.serviceOption(HarnessMemoryStore.HarnessMemoryStore);
  const pluginHost = yield* Effect.serviceOption(PluginHost.PluginHost);
  const approvalAuditStore = yield* Effect.serviceOption(
    HarnessApprovalAuditStore.HarnessApprovalAuditStore,
  );
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const adapterRegistry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

  const getThreadContextManifest: HarnessContextService["Service"]["getThreadContextManifest"] =
    Effect.fn("HarnessContextService.getThreadContextManifest")(function* (threadId) {
      const thread = yield* projections.getThread(threadId).pipe(
        Effect.mapError(
          () =>
            new HarnessError({
              code: "not_found",
              detail: `Thread ${threadId} could not be loaded.`,
            }),
        ),
      );
      const project = yield* projects
        .get(thread.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const workspaceRoot =
        thread.worktreePath ?? (Option.isSome(project) ? project.value.workspaceRoot : undefined);

      const capabilities = yield* adapterRegistry.get(thread.providerInstanceId).pipe(
        Effect.flatMap((adapter) => adapter.getCapabilities()),
        Effect.option,
      );

      const emitsProposedPlan = Option.isSome(capabilities)
        ? capabilities.value.planning.emitsProposedPlan
        : false;
      const supportsMcpTools = Option.isSome(capabilities)
        ? capabilities.value.tools.supportsMcpTools
        : false;
      const harnessCapabilities = Option.isSome(capabilities)
        ? capabilities.value.harness
        : {
            mcpPassthrough: "none" as const,
            mcpListChanged: false,
            skillMount: "none" as const,
            systemContextMutableMidSession: false,
            maxSystemContextBytes: null,
            nativeToolHooks: false,
            nativeAllowAlways: false,
          };

      const snapshot = yield* gateway.getSnapshot(workspaceRoot);
      const librarySnapshot = Option.isSome(libraryStore)
        ? yield* libraryStore.value
            .getSnapshot(workspaceRoot)
            .pipe(Effect.orElseSucceed(() => null))
        : null;
      const nativeSkills: ReadonlyArray<NativeDiscoveredSkill> = Option.isSome(providerRegistry)
        ? yield* providerRegistry.value.getProviders.pipe(
            Effect.map((providers) => {
              const matched = providers.find(
                (provider) => provider.instanceId === thread.providerInstanceId,
              );
              if (!matched) return [];
              const ws =
                workspaceRoot !== undefined
                  ? matched.workspaceSnapshots?.find((snap) => snap.cwd === workspaceRoot)
                  : undefined;
              const skills = ws?.skills ?? matched.skills;
              return skills.map((skill) => ({ name: skill.name, path: skill.path }));
            }),
            Effect.orElseSucceed(() => [] as ReadonlyArray<NativeDiscoveredSkill>),
          )
        : [];
      const activeMode = Option.isSome(libraryStore)
        ? yield* libraryStore.value
            .resolveMode({
              ...(thread.modeId !== undefined ? { modeId: thread.modeId } : {}),
              interactionMode: thread.interactionMode,
              workspaceRoot,
            })
            .pipe(Effect.orElseSucceed(() => null))
        : null;
      const projected =
        librarySnapshot !== null
          ? projectHarnessContext({
              library: librarySnapshot,
              harnessCapabilities,
              activeMode,
              nativeSkills,
              nativeReadsProjectAgentsMd: true,
              supportsMcpTools,
            })
          : null;

      const latestTokenUsage: ThreadContextTokenUsage | null = yield* projections
        .getThreadRecords(threadId, ["providerTurns"])
        .pipe(
          Effect.map((records) => {
            const withUsage = [...records.providerTurns]
              .reverse()
              .find((turn) => turn.tokenUsage !== undefined);
            if (!withUsage?.tokenUsage) return null;
            const maxTokensVal = withUsage.tokenUsage.maxTokens;
            const autoCompactVal = withUsage.tokenUsage.autoCompactThreshold;
            return {
              usedTokens: NonNegativeInt.make(
                Math.max(0, Math.floor(withUsage.tokenUsage.usedTokens)),
              ),
              maxTokens:
                typeof maxTokensVal === "number" && maxTokensVal > 0
                  ? PositiveInt.make(Math.floor(maxTokensVal))
                  : null,
              autoCompactThreshold:
                typeof autoCompactVal === "number" && autoCompactVal > 0
                  ? PositiveInt.make(Math.floor(autoCompactVal))
                  : null,
            } satisfies ThreadContextTokenUsage;
          }),
          Effect.orElseSucceed(() => null),
        );

      const approvalRulesCount = Option.isSome(approvalAuditStore)
        ? yield* approvalAuditStore.value.list({ threadId, includeRevoked: false }).pipe(
            Effect.map((rules) => NonNegativeInt.make(rules.length)),
            Effect.orElseSucceed(() => NonNegativeInt.make(0)),
          )
        : NonNegativeInt.make(0);

      const planModeSource: HarnessPlanModeKind = emitsProposedPlan
        ? "native"
        : supportsMcpTools && snapshot.managedPolicyAllowsHarness
          ? "harness-propose-plan"
          : "none";
      const planModeReadOnlyEnforcement: HarnessPlanReadOnlyEnforcement =
        harnessCapabilities.planReadOnlyEnforcement ?? (emitsProposedPlan ? "native" : "advisory");

      const mcpServers: Array<ThreadContextMcpItem> = [];
      const degradedItems: Array<ThreadContextDegradedItem> = [];

      let activeGatewayCount = 0;

      for (const server of snapshot.servers) {
        let channel: ThreadContextMcpItem["channel"];
        let reason: string | undefined;

        if (server.state === "blocked_by_policy") {
          channel = "blocked";
          reason = server.lastError ?? "Blocked by organization policy.";
          degradedItems.push({ kind: "mcp", id: server.id, reason });
        } else if (server.state === "untrusted") {
          channel = "blocked";
          reason =
            server.trustReason === "stdio_and_secrets"
              ? "Project stdio MCP server with secret placeholders requires owner trust confirmation."
              : server.trustReason === "secrets"
                ? "Project MCP server with secret placeholders requires owner trust confirmation."
                : server.trustReason === "stdio"
                  ? "Project stdio MCP server requires owner trust confirmation."
                  : "Project MCP server in t3.json requires owner trust confirmation.";
          degradedItems.push({ kind: "mcp", id: server.id, reason });
        } else if (!server.effectiveEnabled) {
          channel = "disabled";
          reason = server.overriddenByProject
            ? "Overridden by project t3.json."
            : "Disabled in Harness settings.";
        } else if (!isMcpServerAllowedByMode(server.id, activeMode)) {
          channel = "disabled";
          reason = `Filtered out by active mode "${activeMode?.id ?? ""}".`;
        } else if (
          McpGateway.resolveServerChannel(server.config, harnessCapabilities) === "native"
        ) {
          channel = "native";
        } else {
          channel = "gateway";
          activeGatewayCount += 1;
          if (server.config.injectionMode === "native") {
            reason =
              "Provider does not support native passthrough for this transport; routed via T3 Gateway.";
            degradedItems.push({ kind: "mcp", id: server.id, reason });
          }
          if (server.state === "error" && server.lastError) {
            reason = server.lastError;
            degradedItems.push({ kind: "mcp", id: server.id, reason });
          }
        }

        mcpServers.push({
          id: server.id,
          scope: server.scope,
          channel,
          state: server.state,
          toolCount: server.toolCount,
          estimatedToolListBytes: server.estimatedToolListBytes,
          ...(reason !== undefined ? { reason } : {}),
        });
      }

      if (thread.interactionMode === "plan" && planModeReadOnlyEnforcement === "advisory") {
        degradedItems.push({
          kind: "plan",
          id: "plan-read-only",
          reason:
            "This provider does not enforce read-only mode natively; Plan mode is advisory for provider built-in tools (T3 Gateway MCP tools remain read-only gated).",
        });
      }

      if (projected !== null) {
        degradedItems.push(...projected.degradedItems);
      }

      const now = yield* DateTime.now;
      const commandsCount =
        librarySnapshot !== null
          ? NonNegativeInt.make(librarySnapshot.commands.filter((c) => c.effectiveEnabled).length)
          : NonNegativeInt.make(0);

      return {
        threadId,
        generatedAt: IsoDateTime.make(DateTime.formatIso(now)),
        providerInstanceId: thread.providerInstanceId,
        interactionMode: thread.interactionMode,
        ...(activeMode !== null
          ? {
              modeId: activeMode.id,
              modeName: activeMode.name,
              modeDigest: activeMode.contentDigest,
              modeReadOnly: activeMode.readonly,
            }
          : {
              ...(thread.modeId !== undefined ? { modeId: thread.modeId } : {}),
              ...(thread.modeDigest !== undefined ? { modeDigest: thread.modeDigest } : {}),
              modeReadOnly: thread.interactionMode === "plan",
            }),
        planModeSource,
        planModeReadOnlyEnforcement,
        harnessGatewayActive:
          snapshot.managedPolicyAllowsHarness &&
          (activeGatewayCount > 0 ||
            (supportsMcpTools &&
              (projected?.needsGatewayTools === true ||
                Option.isSome(memoryStore) ||
                (activeMode?.id === "creator" &&
                  thread.interactionMode !== "plan" &&
                  !activeMode.readonly) ||
                (Option.isSome(pluginHost) && pluginHost.value.listActiveSdkTools().length > 0))) ||
            ((thread.interactionMode === "plan" || activeMode?.proposePlan === true) &&
              planModeSource === "harness-propose-plan")),
        mcpServers,
        skills: projected?.skills ?? [],
        rules: projected?.rules ?? [],
        commandsCount,
        contextBudgetBytes: projected?.contextBudgetBytes ?? NonNegativeInt.make(0),
        contextUsedBytes: projected?.contextUsedBytes ?? NonNegativeInt.make(0),
        scaffoldBytes: projected?.scaffoldBytes ?? NonNegativeInt.make(0),
        tokenUsage: latestTokenUsage,
        approvalRulesCount,
        degradedItems,
      };
    });

  return HarnessContextService.of({ getThreadContextManifest });
});

export const layer = Layer.effect(HarnessContextService, make);
