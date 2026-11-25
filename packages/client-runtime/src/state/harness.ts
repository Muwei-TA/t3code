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
  };
}
