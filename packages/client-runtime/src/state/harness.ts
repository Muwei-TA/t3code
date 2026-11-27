import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createHarnessEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listMcpResources: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:harness:mcp:resources",
      tag: WS_METHODS.harnessMcpListResources,
      staleTimeMs: 5_000,
      idleTtlMs: 15_000,
    }),
    listMcpQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:harness:mcp:list",
      tag: WS_METHODS.harnessMcpList,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    listMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:list",
      tag: WS_METHODS.harnessMcpList,
    }),
    upsertMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:upsert",
      tag: WS_METHODS.harnessMcpUpsert,
    }),
    removeMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:remove",
      tag: WS_METHODS.harnessMcpRemove,
    }),
    setMcpEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:set-enabled",
      tag: WS_METHODS.harnessMcpSetEnabled,
    }),
    trustProjectMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:trust-project",
      tag: WS_METHODS.harnessMcpTrustProjectServer,
    }),
    revokeProjectTrust: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:revoke-project-trust",
      tag: WS_METHODS.harnessMcpRevokeProjectTrust,
    }),
    restartMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:restart",
      tag: WS_METHODS.harnessMcpRestart,
    }),
    startMcpOAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:oauth:start",
      tag: WS_METHODS.harnessMcpOAuthStart,
    }),
    completeMcpOAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:oauth:complete",
      tag: WS_METHODS.harnessMcpOAuthComplete,
    }),
    disconnectMcpOAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:oauth:disconnect",
      tag: WS_METHODS.harnessMcpOAuthDisconnect,
    }),
    logsMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:logs",
      tag: WS_METHODS.harnessMcpLogs,
    }),
    scanImports: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:scan-imports",
      tag: WS_METHODS.harnessMcpScanImports,
    }),
    applyImports: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mcp:apply-imports",
      tag: WS_METHODS.harnessMcpApplyImports,
    }),
    threadContextManifest: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:thread:context-manifest",
      tag: WS_METHODS.harnessThreadContextManifest,
    }),
    libraryQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:harness:library:snapshot",
      tag: WS_METHODS.harnessLibrarySnapshot,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    librarySnapshot: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:library:snapshot",
      tag: WS_METHODS.harnessLibrarySnapshot,
    }),
    saveAgentsMd: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:agents-md:save",
      tag: WS_METHODS.harnessAgentsMdSave,
    }),
    readSkillFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness.readSkillFile",
      tag: WS_METHODS.harnessReadSkillFile,
    }),
    installSkillPackage: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness.installSkillPackage",
      tag: WS_METHODS.harnessInstallSkillPackage,
    }),
    getDeliveryMatrix: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness.getDeliveryMatrix",
      tag: WS_METHODS.harnessGetDeliveryMatrix,
    }),
    upsertSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:skill:upsert",
      tag: WS_METHODS.harnessSkillUpsert,
    }),
    removeSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:skill:remove",
      tag: WS_METHODS.harnessSkillRemove,
    }),
    setSkillEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:skill:set-enabled",
      tag: WS_METHODS.harnessSkillSetEnabled,
    }),
    upsertRule: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:rule:upsert",
      tag: WS_METHODS.harnessRuleUpsert,
    }),
    removeRule: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:rule:remove",
      tag: WS_METHODS.harnessRuleRemove,
    }),
    setRuleEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:rule:set-enabled",
      tag: WS_METHODS.harnessRuleSetEnabled,
    }),
    upsertCommand: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:command:upsert",
      tag: WS_METHODS.harnessCommandUpsert,
    }),
    removeCommand: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:command:remove",
      tag: WS_METHODS.harnessCommandRemove,
    }),
    setCommandEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:command:set-enabled",
      tag: WS_METHODS.harnessCommandSetEnabled,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:settings:update",
      tag: WS_METHODS.harnessSettingsUpdate,
    }),
    scanLibraryImports: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:library:scan-imports",
      tag: WS_METHODS.harnessLibraryScanImports,
    }),
    applyLibraryImports: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:library:apply-imports",
      tag: WS_METHODS.harnessLibraryApplyImports,
    }),
    previewExport: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:export:preview",
      tag: WS_METHODS.harnessExportPreview,
    }),
    applyExport: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:export:apply",
      tag: WS_METHODS.harnessExportApply,
    }),
    upsertMode: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mode:upsert",
      tag: WS_METHODS.harnessModeUpsert,
    }),
    removeMode: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mode:remove",
      tag: WS_METHODS.harnessModeRemove,
    }),
    setModeEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:mode:set-enabled",
      tag: WS_METHODS.harnessModeSetEnabled,
    }),
    approvalRulesQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:harness:approval-rules:list",
      tag: WS_METHODS.harnessApprovalRulesList,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    listApprovalRules: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:approval-rules:list",
      tag: WS_METHODS.harnessApprovalRulesList,
    }),
    revokeApprovalRule: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:approval-rules:revoke",
      tag: WS_METHODS.harnessApprovalRuleRevoke,
    }),
    pluginsQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:harness:plugins:list",
      tag: WS_METHODS.harnessPluginsList,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    listPlugins: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:plugins:list",
      tag: WS_METHODS.harnessPluginsList,
    }),
    installPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:plugins:install",
      tag: WS_METHODS.harnessPluginInstall,
    }),
    trustPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:plugins:trust",
      tag: WS_METHODS.harnessPluginTrust,
    }),
    setPluginEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:plugins:set-enabled",
      tag: WS_METHODS.harnessPluginSetEnabled,
    }),
    removePlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:plugins:remove",
      tag: WS_METHODS.harnessPluginRemove,
    }),
    reloadPlugins: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:plugins:reload",
      tag: WS_METHODS.harnessPluginReload,
    }),
    hooksQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:harness:hooks:list",
      tag: WS_METHODS.harnessHooksList,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    listHooks: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:hooks:list",
      tag: WS_METHODS.harnessHooksList,
    }),
    upsertHook: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:hooks:upsert",
      tag: WS_METHODS.harnessHookUpsert,
    }),
    removeHook: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:hooks:remove",
      tag: WS_METHODS.harnessHookRemove,
    }),
    setHookEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:hooks:set-enabled",
      tag: WS_METHODS.harnessHookSetEnabled,
    }),
    testHook: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:hooks:test",
      tag: WS_METHODS.harnessHookTest,
    }),
    validateWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:workflow:validate",
      tag: WS_METHODS.harnessWorkflowValidate,
    }),
    memoryQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:harness:memory:list",
      tag: WS_METHODS.harnessMemoryList,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    listMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:memory:list",
      tag: WS_METHODS.harnessMemoryList,
    }),
    upsertMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:memory:upsert",
      tag: WS_METHODS.harnessMemoryUpsert,
    }),
    removeMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:memory:remove",
      tag: WS_METHODS.harnessMemoryRemove,
    }),
    exportSyncBundle: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:sync:export-bundle",
      tag: WS_METHODS.harnessSyncExportBundle,
    }),
    previewReceiveSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:sync:preview-receive",
      tag: WS_METHODS.harnessSyncPreviewReceive,
    }),
    applyReceiveSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:sync:apply-receive",
      tag: WS_METHODS.harnessSyncApplyReceive,
    }),
    syncStatusQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:harness:sync:status",
      tag: WS_METHODS.harnessSyncStatus,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    getSyncStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:sync:status",
      tag: WS_METHODS.harnessSyncStatus,
    }),
    configureSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:sync:configure",
      tag: WS_METHODS.harnessSyncConfigure,
    }),
    previewSyncPush: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:sync:preview-push",
      tag: WS_METHODS.harnessSyncPreviewPush,
    }),
    pushSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:sync:push",
      tag: WS_METHODS.harnessSyncPush,
    }),
    pullSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:harness:sync:pull",
      tag: WS_METHODS.harnessSyncPull,
    }),
  };
}
