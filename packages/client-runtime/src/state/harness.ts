import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createHarnessEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
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
  };
}
