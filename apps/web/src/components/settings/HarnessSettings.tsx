import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type HarnessMcpApplyImportsResult,
  type HarnessMcpApprovalPolicy,
  type HarnessMcpImportCandidate,
  type HarnessMcpImportSource,
  type HarnessMcpImportSourcePreview,
  type HarnessMcpInjectionMode,
  type HarnessMcpLogLine,
  type HarnessMcpServerConfig,
  HarnessMcpServerId,
  type HarnessMcpServerView,
  type HarnessMcpSnapshot,
  isValidHarnessHttpUrl,
  supportsHarnessMcpOAuth,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { HarnessLibraryPanels, type HarnessPanelTab } from "./HarnessLibraryTabs";
import { HarnessMemoryTab, HarnessSyncTab } from "./HarnessMemoryAndSyncTabs";
import { HarnessHooksTab, HarnessPluginsTab } from "./HarnessPluginsAndHooksTabs";

const decodeServerId = Schema.decodeUnknownOption(HarnessMcpServerId);

function parseKeyValueLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    const colonIdx = trimmed.indexOf(":");
    const sep = eqIdx > 0 ? eqIdx : colonIdx;
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const val = trimmed.slice(sep + 1).trim();
    if (key.length > 0) out[key] = val;
  }
  return out;
}

function formatKeyValueLines(record: Readonly<Record<string, string>> | undefined): string {
  if (!record) return "";
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseCommaList(raw: string): ReadonlyArray<string> {
  return raw
    .split(/[,\n]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseArgsText(raw: string): ReadonlyArray<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  return matches.map((token) => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

export function HarnessSettingsPanel() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const { scope, environment } = useSettingsScope();
  const [activeTab, setActiveTab] = useState<HarnessPanelTab>("mcp");
  const connected = environment?.connection.phase === "connected";
  const workspaceRoot =
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members.find((member) => member.environmentId === environment?.environmentId)
          ?.workspaceRoot
      : undefined;

  const tabs: ReadonlyArray<{ readonly id: HarnessPanelTab; readonly label: string }> = [
    { id: "mcp", label: gt("MCP Servers") },
    { id: "modes", label: gt("Modes") },
    { id: "skills", label: gt("Skills") },
    { id: "rules", label: gt("Rules & AGENTS.md") },
    { id: "commands", label: gt("Commands") },
    { id: "plugins", label: gt("Plugins") },
    { id: "hooks", label: gt("Hooks") },
    { id: "memory", label: gt("Memory") },
    { id: "sync", label: gt("Git Sync") },
    { id: "approvals", label: gt("Approvals") },
    { id: "transfer", label: gt("Import / Export") },
  ];

  return (
    <SettingsPageContainer>
      {connected && environment ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {tabs.map((tab) => (
              <Button
                key={tab.id}
                size="sm"
                variant={activeTab === tab.id ? "default" : "outline"}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </Button>
            ))}
          </div>
          {activeTab === "mcp" ? (
            <EnvironmentHarnessMcpSection
              key={`${environment.environmentId}:${workspaceRoot ?? ""}`}
              environment={environment}
              workspaceRoot={workspaceRoot}
            />
          ) : activeTab === "plugins" ? (
            <HarnessPluginsTab
              key={`${environment.environmentId}:plugins`}
              environmentId={environment.environmentId}
            />
          ) : activeTab === "hooks" ? (
            <HarnessHooksTab
              key={`${environment.environmentId}:hooks`}
              environmentId={environment.environmentId}
            />
          ) : activeTab === "memory" ? (
            <HarnessMemoryTab
              key={`${environment.environmentId}:memory`}
              environmentId={environment.environmentId}
            />
          ) : activeTab === "sync" ? (
            <HarnessSyncTab
              key={`${environment.environmentId}:sync`}
              environmentId={environment.environmentId}
            />
          ) : (
            <HarnessLibraryPanels
              key={`${environment.environmentId}:${workspaceRoot ?? ""}:${activeTab}`}
              activeTab={activeTab}
              environmentId={environment.environmentId}
              workspaceRoot={workspaceRoot}
            />
          )}
        </div>
      ) : (
        <SettingsSection {...setting("harness-mcp")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>Connect an environment to configure portable MCP servers and harness extensions.</T>
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentHarnessMcpSection({
  environment,
  workspaceRoot,
}: {
  readonly environment: EnvironmentPresentation;
  readonly workspaceRoot: string | undefined;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const environmentId = environment.environmentId;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canRunStdio = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const queryAtom = harnessEnvironment.listMcpQuery({
    environmentId,
    input: workspaceRoot ? { workspaceRoot } : {},
  });
  const queryResult = useAtomValue(queryAtom);
  const [overrideSnapshot, setOverrideSnapshot] = useState<HarnessMcpSnapshot | null>(null);
  const snapshot =
    overrideSnapshot ?? AsyncResult.getOrElse(queryResult, () => null as HarnessMcpSnapshot | null);

  const listMcp = useAtomCommand(harnessEnvironment.listMcp, { reportFailure: false });
  const upsertMcp = useAtomCommand(harnessEnvironment.upsertMcp, { reportFailure: false });
  const removeMcp = useAtomCommand(harnessEnvironment.removeMcp, { reportFailure: false });
  const setMcpEnabled = useAtomCommand(harnessEnvironment.setMcpEnabled, { reportFailure: false });
  const trustProjectMcp = useAtomCommand(harnessEnvironment.trustProjectMcp, {
    reportFailure: false,
  });
  const revokeProjectTrust = useAtomCommand(harnessEnvironment.revokeProjectTrust, {
    reportFailure: false,
  });
  const restartMcp = useAtomCommand(harnessEnvironment.restartMcp, { reportFailure: false });
  const startMcpOAuth = useAtomCommand(harnessEnvironment.startMcpOAuth, { reportFailure: false });
  const completeMcpOAuth = useAtomCommand(harnessEnvironment.completeMcpOAuth, {
    reportFailure: false,
    reportDefect: false,
  });
  const disconnectMcpOAuth = useAtomCommand(harnessEnvironment.disconnectMcpOAuth, {
    reportFailure: false,
  });
  const logsMcp = useAtomCommand(harnessEnvironment.logsMcp, { reportFailure: false });
  const scanImports = useAtomCommand(harnessEnvironment.scanImports, { reportFailure: false });
  const applyImports = useAtomCommand(harnessEnvironment.applyImports, { reportFailure: false });

  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<{
    readonly server: HarnessMcpServerView;
    readonly url: string;
  } | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [finishingOAuth, setFinishingOAuth] = useState(false);
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(new Set());
  const [editorState, setEditorState] = useState<
    | null
    | { readonly mode: "add" }
    | { readonly mode: "edit"; readonly server: HarnessMcpServerView }
  >(null);
  const [removeTarget, setRemoveTarget] = useState<HarnessMcpServerView | null>(null);
  const [trustTarget, setTrustTarget] = useState<HarnessMcpServerView | null>(null);
  const [logsDialog, setLogsDialog] = useState<{
    readonly serverId: HarnessMcpServerId;
    readonly lines: ReadonlyArray<HarnessMcpLogLine>;
    readonly loading: boolean;
  } | null>(null);
  const [importDialog, setImportDialog] = useState<{
    readonly loading: boolean;
    readonly sources: ReadonlyArray<HarnessMcpImportSourcePreview>;
  } | null>(null);

  const refreshSnapshot = async () => {
    const result = await listMcp({
      environmentId,
      input: workspaceRoot ? { workspaceRoot } : {},
    });
    if (result._tag === "Success") {
      setOverrideSnapshot(result.value);
    }
  };

  const handleOAuth = async (server: HarnessMcpServerView, disconnect: boolean) => {
    const input = { serverId: server.id, ...(workspaceRoot ? { workspaceRoot } : {}) };
    setBusyServerId(server.id);
    if (disconnect) {
      const result = await disconnectMcpOAuth({ environmentId, input });
      if (result._tag === "Success") setOverrideSnapshot(result.value);
      else if (!isAtomCommandInterrupted(result))
        toastManager.add({ type: "error", title: gt("Couldn't disconnect MCP sign-in.") });
    } else {
      const result = await startMcpOAuth({ environmentId, input });
      if (result._tag === "Success") {
        setCallbackUrl("");
        setOAuthError(null);
        setSignIn({ server, url: result.value.authorizationUrl });
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: failure instanceof Error ? failure.message : gt("Couldn't start MCP sign-in."),
        });
      }
    }
    setBusyServerId(null);
  };

  const finishOAuth = async () => {
    if (!signIn || finishingOAuth) return;
    setFinishingOAuth(true);
    setOAuthError(null);
    const address = callbackUrl.trim();
    const result =
      address.length > 0
        ? await completeMcpOAuth({
            environmentId,
            input: {
              serverId: signIn.server.id,
              callbackUrl: address,
              ...(workspaceRoot ? { workspaceRoot } : {}),
            },
          })
        : await listMcp({ environmentId, input: workspaceRoot ? { workspaceRoot } : {} });
    setFinishingOAuth(false);
    if (result._tag === "Success") {
      setOverrideSnapshot(result.value);
      if (
        address ||
        result.value.servers.some(
          (entry) =>
            entry.id === signIn.server.id &&
            entry.scope === signIn.server.scope &&
            entry.oauthStatus === "connected" &&
            entry.state !== "auth_required",
        )
      ) {
        setSignIn(null);
        return;
      }
    } else if (isAtomCommandInterrupted(result)) return;
    setOAuthError(gt("Sign-in is incomplete. Approve access or paste the callback address."));
  };

  const handleToggleEnabled = async (server: HarnessMcpServerView, nextEnabled: boolean) => {
    setBusyServerId(server.id);
    const result = await setMcpEnabled({
      environmentId,
      input: {
        id: server.id,
        enabled: nextEnabled,
        expectedDigest: server.configDigest,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyServerId(null);
    if (result._tag === "Success") {
      setOverrideSnapshot(result.value);
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not update MCP server"),
        description: formatErrorMessage(
          squashAtomCommandFailure(result),
          gt("Failed to toggle server state."),
        ),
      });
    }
  };

  const handleRestart = async (server: HarnessMcpServerView) => {
    setBusyServerId(server.id);
    const result = await restartMcp({
      environmentId,
      input: {
        serverId: server.id,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyServerId(null);
    if (result._tag === "Success") {
      setOverrideSnapshot(result.value);
      const updated = result.value.servers.find((item) => item.id === server.id);
      if (updated?.state === "connected") {
        toastManager.add({
          type: "success",
          title: gt("Connected to {id}", { id: server.id }),
          description: gt(
            "{count, plural, one {{count} tool loaded} other {{count} tools loaded}}",
            {
              count: updated.toolCount,
            },
          ),
        });
      } else if (updated?.lastError) {
        toastManager.add({
          type: "error",
          title: gt("Could not connect to {id}", { id: server.id }),
          description: updated.lastError,
        });
      }
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not restart {id}", { id: server.id }),
        description: formatErrorMessage(
          squashAtomCommandFailure(result),
          gt("Failed to restart MCP server."),
        ),
      });
    }
  };

  const handleOpenLogs = async (serverId: HarnessMcpServerId) => {
    setLogsDialog({ serverId, lines: [], loading: true });
    const result = await logsMcp({ environmentId, input: { serverId } });
    if (result._tag === "Success") {
      setLogsDialog({ serverId, lines: result.value.lines, loading: false });
    } else {
      setLogsDialog({ serverId, lines: [], loading: false });
    }
  };

  const handleOpenImporter = async () => {
    setImportDialog({ loading: true, sources: [] });
    const result = await scanImports({ environmentId, input: {} });
    if (result._tag === "Success") {
      setImportDialog({ loading: false, sources: result.value.sources });
    } else if (!isAtomCommandInterrupted(result)) {
      setImportDialog(null);
      toastManager.add({
        type: "error",
        title: gt("Could not scan CLI configurations"),
        description: formatErrorMessage(
          squashAtomCommandFailure(result),
          gt("Failed to scan local CLI MCP files."),
        ),
      });
    }
  };

  const handleConfirmRemove = async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    setBusyServerId(target.id);
    const result = await removeMcp({
      environmentId,
      input: {
        id: target.id,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyServerId(null);
    if (result._tag === "Success") {
      setOverrideSnapshot(result.value);
      toastManager.add({
        type: "success",
        title: gt("Removed {id}", { id: target.id }),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not remove {id}", { id: target.id }),
        description: formatErrorMessage(
          squashAtomCommandFailure(result),
          gt("Failed to remove MCP server."),
        ),
      });
    }
  };

  const handleConfirmTrust = async () => {
    if (!trustTarget || !trustTarget.repoRoot || !trustTarget.trustDigest) return;
    const target = trustTarget;
    setTrustTarget(null);
    setBusyServerId(target.id);
    const result = await trustProjectMcp({
      environmentId,
      input: {
        repoRoot: target.repoRoot!,
        serverId: target.id,
        digest: target.trustDigest!,
      },
    });
    setBusyServerId(null);
    if (result._tag === "Success") {
      setOverrideSnapshot(result.value);
      toastManager.add({
        type: "success",
        title: gt("Trusted {id}", { id: target.id }),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not trust {id}", { id: target.id }),
        description: formatErrorMessage(
          squashAtomCommandFailure(result),
          gt("Failed to save trust approval."),
        ),
      });
    }
  };

  const handleRevokeTrust = async (server: HarnessMcpServerView) => {
    if (!server.repoRoot) return;
    setBusyServerId(server.id);
    const result = await revokeProjectTrust({
      environmentId,
      input: {
        repoRoot: server.repoRoot,
        serverId: server.id,
      },
    });
    setBusyServerId(null);
    if (result._tag === "Success") {
      setOverrideSnapshot(result.value);
      toastManager.add({
        type: "success",
        title: gt("Revoked trust for {id}", { id: server.id }),
      });
    }
  };

  const toggleExpandTools = (serverId: string) => {
    setExpandedTools((current) => {
      const next = new Set(current);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };

  const servers = snapshot?.servers ?? [];

  return (
    <>
      <SettingsSection
        {...setting("harness-mcp")}
        headerAction={
          canWriteSettings ? (
            <div className="flex items-center gap-1.5">
              <Button size="xs" variant="outline" onClick={() => void handleOpenImporter()}>
                <DownloadIcon className="size-3" aria-hidden />
                <T>Import from CLI</T>
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={snapshot?.managedPolicyAllowsHarness === false}
                onClick={() => setEditorState({ mode: "add" })}
              >
                <PlusIcon className="size-3" aria-hidden />
                <T>Add MCP server</T>
              </Button>
            </div>
          ) : null
        }
      >
        <div className="space-y-3 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            <T>
              Configure MCP servers once in{" "}
              <code>
                <Var>{snapshot?.configPath ?? "~/.t3/harness/harness.json"}</Var>
              </code>{" "}
              and reuse them across every provider through the isolated <code>/mcp/harness</code>{" "}
              gateway. Use <code>{"${secret:NAME}"}</code> or{" "}
              <code>{"${secret:provider:ref}"}</code> for credentials.
            </T>
          </p>

          {snapshot && !snapshot.managedPolicyAllowsHarness ? (
            <Alert variant="warning">
              <AlertTitle>
                <T>Restricted by organization policy</T>
              </AlertTitle>
              <AlertDescription>
                <T>
                  <Var>{snapshot.managedPolicyOrganization ?? "Your organization"}</Var> has
                  disabled portable harness extensions on this environment.
                </T>
              </AlertDescription>
            </Alert>
          ) : null}

          {snapshot && snapshot.managedPolicyAllowsHarness && !snapshot.managedPolicyAllowsStdio ? (
            <Alert variant="warning">
              <AlertTitle>
                <T>Local stdio MCP servers disabled</T>
              </AlertTitle>
              <AlertDescription>
                <T>
                  <Var>{snapshot.managedPolicyOrganization ?? "Your organization"}</Var> only allows
                  remote HTTP/SSE MCP servers on this environment.
                </T>
              </AlertDescription>
            </Alert>
          ) : null}

          {snapshot && snapshot.invalidEntries.length > 0 ? (
            <Alert variant="error">
              <AlertTitle>
                <T>Invalid entries in harness.json</T>
              </AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 ps-4">
                  {snapshot.invalidEntries.map((entry) => (
                    <li key={`${entry.source}:${entry.id ?? "root"}:${entry.message}`}>
                      {entry.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        {servers.length === 0 ? (
          <div className="px-4 pb-4 text-sm text-muted-foreground">
            <T>
              No portable MCP servers configured yet. Add one manually or import existing servers
              from Codex, Claude, Cursor, or Antigravity without modifying their original files.
            </T>
          </div>
        ) : (
          servers.map((server) => {
            const isBusy = busyServerId === server.id;
            const isExpanded = expandedTools.has(server.id);
            const stateBadge = renderStateBadge(server, gt);
            const targetSummary =
              server.config.transport.type === "stdio"
                ? [server.config.transport.command, ...(server.config.transport.args ?? [])].join(
                    " ",
                  )
                : server.config.transport.url;

            return (
              <SettingsRow
                key={`${server.scope}:${server.id}`}
                title={
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-sm">{server.id}</span>
                    <Badge variant="outline">
                      {server.scope === "project" ? gt("Project") : gt("User")}
                    </Badge>
                    <Badge variant="secondary">
                      {server.config.transport.type === "stdio"
                        ? "stdio"
                        : server.config.transport.type === "sse"
                          ? "SSE"
                          : "HTTP"}
                    </Badge>
                    <Badge variant="outline">
                      {server.config.injectionMode === "native"
                        ? gt("Native passthrough")
                        : gt("T3 Gateway")}
                    </Badge>
                    {stateBadge}
                  </div>
                }
                description={
                  <div className="mt-1 space-y-1.5">
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {targetSummary}
                    </div>
                    {server.config.description ? (
                      <div className="text-xs text-muted-foreground">
                        {server.config.description}
                      </div>
                    ) : null}
                    {server.lastError ? (
                      <div className="text-xs text-destructive">{server.lastError}</div>
                    ) : null}
                    {server.needsTrustConfirmation ? (
                      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-warning-foreground">
                        <ShieldAlertIcon className="size-3.5 shrink-0" aria-hidden />
                        <span>
                          {server.trustReason === "stdio_and_secrets" ? (
                            <T>
                              Project stdio server with secret placeholders from{" "}
                              <code>t3.json</code> requires owner trust approval before running.
                            </T>
                          ) : server.trustReason === "secrets" ? (
                            <T>
                              Project MCP server with secret placeholders from <code>t3.json</code>{" "}
                              requires owner trust approval before resolving secrets.
                            </T>
                          ) : server.trustReason === "stdio" ? (
                            <T>
                              Project stdio server from <code>t3.json</code> requires owner trust
                              approval before running.
                            </T>
                          ) : (
                            <T>
                              Project MCP server from <code>t3.json</code> requires owner trust
                              approval before connecting.
                            </T>
                          )}
                        </span>
                        {canWriteSettings &&
                        (server.config.transport.type !== "stdio" || canRunStdio) &&
                        (!server.requiresSecretAccess || canManageProviders) ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => setTrustTarget(server)}
                          >
                            <T>Review & trust</T>
                          </Button>
                        ) : null}
                      </div>
                    ) : server.scope === "project" && server.trustDigest !== null ? (
                      <div className="flex items-center gap-2 pt-0.5 text-xs text-muted-foreground">
                        <ShieldCheckIcon className="size-3.5 text-success" aria-hidden />
                        <span>
                          <T>Trusted for current digest</T>
                        </span>
                        {canWriteSettings ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={isBusy}
                            onClick={() => void handleRevokeTrust(server)}
                          >
                            <T>Revoke trust</T>
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {server.tools.length > 0 ? (
                      <div className="pt-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => toggleExpandTools(server.id)}
                        >
                          {isExpanded ? (
                            <ChevronDownIcon className="size-3" aria-hidden />
                          ) : (
                            <ChevronRightIcon className="size-3" aria-hidden />
                          )}
                          {gt("{count, plural, one {{count} tool} other {{count} tools}}", {
                            count: server.tools.length,
                          })}
                        </Button>
                        {isExpanded ? (
                          <div className="mt-1.5 space-y-1 rounded-lg border border-border/70 bg-muted/30 p-2">
                            {server.tools.map((tool) => (
                              <div
                                key={tool.exposedName}
                                className="flex items-start justify-between gap-2 text-xs"
                              >
                                <div className="min-w-0">
                                  <div className="font-mono text-foreground">
                                    {tool.exposedName}
                                  </div>
                                  {tool.description ? (
                                    <div className="truncate text-muted-foreground">
                                      {tool.description}
                                    </div>
                                  ) : null}
                                </div>
                                {tool.readOnly ? (
                                  <Badge variant="outline">{gt("Read-only")}</Badge>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                }
              >
                <div className="flex items-center gap-1.5">
                  {canManageProviders &&
                  server.effectiveEnabled &&
                  supportsHarnessMcpOAuth(server.config) ? (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => void handleOAuth(server, false)}
                      >
                        {server.oauthStatus === "connected" ? <T>Sign in again</T> : <T>Sign in</T>}
                      </Button>
                      {server.oauthStatus === "connected" || server.oauthStatus === "expired" ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => void handleOAuth(server, true)}
                        >
                          <T>Disconnect sign-in</T>
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  {server.scope === "user" && canWriteSettings ? (
                    <Switch
                      size="sm"
                      checked={server.config.enabled}
                      disabled={isBusy || server.state === "blocked_by_policy"}
                      aria-label={gt("Toggle {id}", { id: server.id })}
                      onCheckedChange={(checked) => void handleToggleEnabled(server, checked)}
                    />
                  ) : null}
                  {canOperate &&
                  server.effectiveEnabled &&
                  (server.config.transport.type !== "stdio" || canRunStdio) &&
                  (!server.requiresSecretAccess || canManageProviders) ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={isBusy}
                      aria-label={gt("Connect or restart {id}", { id: server.id })}
                      onClick={() => void handleRestart(server)}
                    >
                      <RefreshCwIcon className="size-3.5" aria-hidden />
                    </Button>
                  ) : null}
                  {canReadDiagnostics ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={gt("View logs for {id}", { id: server.id })}
                      onClick={() => void handleOpenLogs(server.id)}
                    >
                      <TerminalIcon className="size-3.5" aria-hidden />
                    </Button>
                  ) : null}
                  {server.scope === "user" && canWriteSettings ? (
                    <>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={isBusy}
                        aria-label={gt("Edit {id}", { id: server.id })}
                        onClick={() => setEditorState({ mode: "edit", server })}
                      >
                        <PencilIcon className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={isBusy}
                        aria-label={gt("Remove {id}", { id: server.id })}
                        onClick={() => setRemoveTarget(server)}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden />
                      </Button>
                    </>
                  ) : null}
                </div>
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>

      <Dialog
        open={signIn !== null}
        onOpenChange={(open) => {
          if (!open && !finishingOAuth) setSignIn(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {gt("Sign in to {server}", { server: signIn?.server.id ?? "" })}
            </DialogTitle>
            <DialogDescription>
              <T>
                Approve access in your browser. If the callback page cannot open, paste its address
                here.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    if (signIn) void ensureLocalApi().shell.openExternal(signIn.url);
                  }}
                >
                  <T>Open sign-in page</T>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (signIn) copyToClipboard(signIn.url);
                  }}
                >
                  {isCopied ? <T>Copied</T> : <T>Copy link</T>}
                </Button>
              </div>
              <Input
                aria-label={gt("OAuth callback address")}
                value={callbackUrl}
                onChange={(event) => setCallbackUrl(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={finishingOAuth}
              />
              {oauthError ? (
                <p role="alert" className="text-sm text-destructive">
                  {oauthError}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={!canManageProviders || finishingOAuth}
              onClick={() => void finishOAuth()}
            >
              <T>Finish sign-in</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={editorState !== null}
        onOpenChange={(open) => {
          if (!open) setEditorState(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          {editorState ? (
            <McpServerEditorForm
              environmentId={environmentId}
              workspaceRoot={workspaceRoot}
              initial={editorState.mode === "edit" ? editorState.server : undefined}
              allowStdio={canRunStdio && (snapshot?.managedPolicyAllowsStdio ?? true)}
              onCancel={() => setEditorState(null)}
              onSaved={(nextSnapshot) => {
                setOverrideSnapshot(nextSnapshot);
                setEditorState(null);
              }}
              upsertMcp={upsertMcp}
            />
          ) : null}
        </DialogPopup>
      </Dialog>

      <Dialog
        open={logsDialog !== null}
        onOpenChange={(open) => {
          if (!open) setLogsDialog(null);
        }}
      >
        <DialogPopup className="max-w-2xl">
          {logsDialog ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  <T>
                    MCP diagnostics: <Var>{logsDialog.serverId}</Var>
                  </T>
                </DialogTitle>
                <DialogDescription>
                  <T>Recent stderr and lifecycle events captured by the T3 Harness gateway.</T>
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                {logsDialog.loading ? (
                  <p className="text-sm text-muted-foreground">
                    <T>Loading logs...</T>
                  </p>
                ) : logsDialog.lines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    <T>
                      No logs recorded yet. Stdio servers start lazily on first tool use or when you
                      click Restart.
                    </T>
                  </p>
                ) : (
                  <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
                    {logsDialog.lines
                      .map((line) => `[${line.timestamp}] (${line.stream}) ${line.text}`)
                      .join("\n")}
                  </pre>
                )}
              </DialogPanel>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleOpenLogs(logsDialog.serverId)}
                >
                  <T>Refresh</T>
                </Button>
                <Button size="sm" onClick={() => setLogsDialog(null)}>
                  <T>Close</T>
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>

      <Dialog
        open={importDialog !== null}
        onOpenChange={(open) => {
          if (!open) setImportDialog(null);
        }}
      >
        <DialogPopup className="max-w-2xl">
          {importDialog ? (
            <McpImportWizard
              environmentId={environmentId}
              workspaceRoot={workspaceRoot}
              loading={importDialog.loading}
              sources={importDialog.sources}
              allowStdio={canRunStdio && (snapshot?.managedPolicyAllowsStdio ?? true)}
              allowSecrets={canManageProviders}
              applyImports={applyImports}
              onClose={() => setImportDialog(null)}
              onImported={(nextSnapshot) => {
                setOverrideSnapshot(nextSnapshot);
                setImportDialog(null);
              }}
            />
          ) : null}
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove MCP server <Var>{removeTarget?.id ?? ""}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This removes the server from your portable <code>harness.json</code> and stops any
                pooled connection on this environment.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button variant="destructive" size="sm" onClick={() => void handleConfirmRemove()}>
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={trustTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTrustTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Trust project MCP server <Var>{trustTarget?.id ?? ""}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Approving this lets T3 Code activate the following project MCP server from{" "}
                <code>t3.json</code> on <Var>{environment.label}</Var>. Trust is pinned to its full
                transport, channel, policy, and destination digest and resets if{" "}
                <code>t3.json</code> changes.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {trustTarget ? (
            <div className="mx-6 space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
              {trustTarget.config.transport.type === "stdio" ? (
                <>
                  <div>command: {trustTarget.config.transport.command}</div>
                  {(trustTarget.config.transport.args ?? []).length > 0 ? (
                    <div className="text-muted-foreground">
                      args: {JSON.stringify(trustTarget.config.transport.args)}
                    </div>
                  ) : null}
                  {trustTarget.config.transport.cwd ? (
                    <div className="text-muted-foreground">
                      cwd: {trustTarget.config.transport.cwd}
                    </div>
                  ) : null}
                </>
              ) : (
                <div>
                  {trustTarget.config.transport.type.toUpperCase()}:{" "}
                  {trustTarget.config.transport.url}
                </div>
              )}
              <div className="text-muted-foreground">
                {trustTarget.requiresSecretAccess
                  ? gt("Route: {route} · Policy: {policy} · Secret placeholders: yes", {
                      route: trustTarget.config.injectionMode,
                      policy: trustTarget.config.approvalPolicy,
                    })
                  : gt("Route: {route} · Policy: {policy}", {
                      route: trustTarget.config.injectionMode,
                      policy: trustTarget.config.approvalPolicy,
                    })}
              </div>
              {trustTarget.trustDigest ? (
                <div className="text-muted-foreground">
                  sha256: {trustTarget.trustDigest.slice(0, 16)}…
                </div>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button size="sm" onClick={() => void handleConfirmTrust()}>
              <T>Trust & enable</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {snapshot === null && !queryResult.waiting ? (
        <div className="px-4 py-2">
          <Button size="xs" variant="outline" onClick={() => void refreshSnapshot()}>
            <T>Retry loading Harness</T>
          </Button>
        </div>
      ) : null}
    </>
  );
}

function renderStateBadge(server: HarnessMcpServerView, gt: ReturnType<typeof useGT>) {
  if (
    server.state === "auth_required" ||
    server.oauthStatus === "required" ||
    server.oauthStatus === "expired"
  ) {
    return <Badge variant="warning">{gt("Sign-in required")}</Badge>;
  }
  if (server.oauthStatus === "connected" && server.state === "idle") {
    return <Badge variant="success">{gt("Signed in")}</Badge>;
  }
  switch (server.state) {
    case "connected":
      return (
        <Badge variant="success">{gt("Connected ({count})", { count: server.toolCount })}</Badge>
      );
    case "starting":
      return <Badge variant="secondary">{gt("Starting")}</Badge>;
    case "error":
      return <Badge variant="error">{gt("Error")}</Badge>;
    case "untrusted":
      return <Badge variant="warning">{gt("Needs trust")}</Badge>;
    case "blocked_by_policy":
      return <Badge variant="error">{gt("Blocked by policy")}</Badge>;
    case "disabled":
      return <Badge variant="secondary">{gt("Disabled")}</Badge>;
    default:
      return <Badge variant="secondary">{gt("Idle")}</Badge>;
  }
}

function McpServerEditorForm({
  environmentId,
  workspaceRoot,
  initial,
  allowStdio,
  onCancel,
  onSaved,
  upsertMcp,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | undefined;
  readonly initial: HarnessMcpServerView | undefined;
  readonly allowStdio: boolean;
  readonly onCancel: () => void;
  readonly onSaved: (snapshot: HarnessMcpSnapshot) => void;
  readonly upsertMcp: (args: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly id: string;
      readonly config: HarnessMcpServerConfig;
      readonly workspaceRoot?: string;
    };
  }) => Promise<AtomCommandResult<HarnessMcpSnapshot, unknown>>;
}) {
  const gt = useGT();
  const [serverId, setServerId] = useState(initial?.id ?? "");
  const [transportType, setTransportType] = useState<"stdio" | "http" | "sse">(
    initial?.config.transport.type ?? (allowStdio ? "stdio" : "http"),
  );
  const [command, setCommand] = useState(
    initial?.config.transport.type === "stdio" ? initial.config.transport.command : "",
  );
  const [argsText, setArgsText] = useState(
    initial?.config.transport.type === "stdio"
      ? (initial.config.transport.args ?? []).join(" ")
      : "",
  );
  const [cwd, setCwd] = useState(
    initial?.config.transport.type === "stdio" ? (initial.config.transport.cwd ?? "") : "",
  );
  const [envText, setEnvText] = useState(
    initial?.config.transport.type === "stdio"
      ? formatKeyValueLines(initial.config.transport.env)
      : "",
  );
  const [url, setUrl] = useState(
    initial?.config.transport.type !== "stdio" ? (initial?.config.transport.url ?? "") : "",
  );
  const [headersText, setHeadersText] = useState(
    initial?.config.transport.type !== "stdio"
      ? formatKeyValueLines(initial?.config.transport.headers)
      : "",
  );
  const initialOAuth =
    initial?.config.transport.type === "stdio" ? undefined : initial?.config.transport.oauth;
  const [oauthClientId, setOAuthClientId] = useState(initialOAuth?.clientId ?? "");
  const [oauthScopes, setOAuthScopes] = useState(initialOAuth?.scopes?.join(", ") ?? "");
  const [oauthIssuer, setOAuthIssuer] = useState(initialOAuth?.authorizationServerUrl ?? "");
  const [injectionMode, setInjectionMode] = useState<HarnessMcpInjectionMode>(
    initial?.config.injectionMode ?? "gateway",
  );
  const [approvalPolicy, setApprovalPolicy] = useState<HarnessMcpApprovalPolicy>(
    initial?.config.approvalPolicy ?? "auto-read",
  );
  const [allowedToolsText, setAllowedToolsText] = useState(
    (initial?.config.allowedTools ?? []).join(", "),
  );
  const [disabledToolsText, setDisabledToolsText] = useState(
    (initial?.config.disabledTools ?? []).join(", "),
  );
  const [description, setDescription] = useState(initial?.config.description ?? "");
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSave = async () => {
    const parsedId = decodeServerId(serverId.trim());
    if (parsedId._tag === "None") {
      setValidationError(
        gt("Server ID must start with a letter or digit and use only letters, digits, -, or _."),
      );
      return;
    }

    let transport: HarnessMcpServerConfig["transport"];
    if (transportType === "stdio") {
      if (!allowStdio) {
        setValidationError(gt("Local stdio MCP servers are not permitted on this connection."));
        return;
      }
      const trimmedCmd = command.trim();
      if (trimmedCmd.length === 0) {
        setValidationError(gt("Enter a command to launch the stdio MCP server."));
        return;
      }
      const parsedArgs = parseArgsText(argsText);
      const parsedEnv = parseKeyValueLines(envText);
      transport = {
        type: "stdio",
        command: trimmedCmd,
        ...(parsedArgs.length > 0 ? { args: parsedArgs } : {}),
        ...(cwd.trim().length > 0 ? { cwd: cwd.trim() } : {}),
        ...(Object.keys(parsedEnv).length > 0 ? { env: parsedEnv } : {}),
      };
    } else {
      const trimmedUrl = url.trim();
      if (!isValidHarnessHttpUrl(trimmedUrl)) {
        setValidationError(gt("Enter a valid http:// or https:// MCP endpoint URL."));
        return;
      }
      const issuer = oauthIssuer.trim();
      if (issuer && !isValidHarnessHttpUrl(issuer)) {
        setValidationError(gt("Enter a valid http:// or https:// OAuth authorization server URL."));
        return;
      }
      const parsedHeaders = parseKeyValueLines(headersText);
      const scopes = parseCommaList(oauthScopes);
      const oauth = {
        ...(initialOAuth?.enabled === undefined ? {} : { enabled: initialOAuth.enabled }),
        ...(oauthClientId.trim() ? { clientId: oauthClientId.trim() } : {}),
        ...(scopes.length > 0 ? { scopes } : {}),
        ...(issuer ? { authorizationServerUrl: issuer } : {}),
      };
      transport = {
        type: transportType,
        url: trimmedUrl,
        ...(Object.keys(parsedHeaders).length > 0 ? { headers: parsedHeaders } : {}),
        ...(Object.keys(oauth).length > 0 ? { oauth } : {}),
      };
    }

    const allowedTools = parseCommaList(allowedToolsText);
    const disabledTools = parseCommaList(disabledToolsText);
    const config: HarnessMcpServerConfig = {
      enabled: initial?.config.enabled ?? true,
      transport,
      injectionMode,
      approvalPolicy,
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {}),
      ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      ...(initial?.config.origin ? { origin: initial.config.origin } : {}),
    };

    setValidationError(null);
    setSaving(true);
    const result = await upsertMcp({
      environmentId,
      input: {
        id: parsedId.value,
        config,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setSaving(false);

    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: initial
          ? gt("Updated {id}", { id: parsedId.value })
          : gt("Added {id}", { id: parsedId.value }),
      });
      onSaved(result.value);
    } else if (!isAtomCommandInterrupted(result)) {
      setValidationError(
        formatErrorMessage(squashAtomCommandFailure(result), gt("Failed to save MCP server.")),
      );
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{initial ? gt("Edit MCP server") : gt("Add portable MCP server")}</DialogTitle>
        <DialogDescription>
          <T>
            Saved to your portable <code>~/.t3/harness/harness.json</code> and available to every
            provider.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          {validationError ? (
            <Alert variant="error">
              <AlertDescription>{validationError}</AlertDescription>
            </Alert>
          ) : null}

          <label className="grid gap-1">
            <span className="text-xs font-medium text-foreground">
              <T>Server ID</T>
            </span>
            <Input
              value={serverId}
              disabled={initial !== undefined || saving}
              placeholder="github"
              spellCheck={false}
              onChange={(event) => setServerId(event.target.value)}
            />
          </label>

          <div className="grid gap-1">
            <span className="text-xs font-medium text-foreground">
              <T>Transport</T>
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="xs"
                variant={transportType === "stdio" ? "default" : "outline"}
                disabled={!allowStdio || saving}
                onClick={() => setTransportType("stdio")}
              >
                stdio
              </Button>
              <Button
                type="button"
                size="xs"
                variant={transportType === "http" ? "default" : "outline"}
                disabled={saving}
                onClick={() => setTransportType("http")}
              >
                <T>Streamable HTTP</T>
              </Button>
              <Button
                type="button"
                size="xs"
                variant={transportType === "sse" ? "default" : "outline"}
                disabled={saving}
                onClick={() => setTransportType("sse")}
              >
                SSE
              </Button>
            </div>
          </div>

          {transportType === "stdio" ? (
            <>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">
                  <T>Command</T>
                </span>
                <Input
                  value={command}
                  disabled={saving}
                  placeholder="npx"
                  spellCheck={false}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">
                  <T>Arguments</T>
                </span>
                <Input
                  value={argsText}
                  disabled={saving}
                  placeholder="-y @modelcontextprotocol/server-github"
                  spellCheck={false}
                  onChange={(event) => setArgsText(event.target.value)}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">
                  <T>Working directory (optional)</T>
                </span>
                <Input
                  value={cwd}
                  disabled={saving}
                  placeholder="/path/to/dir"
                  spellCheck={false}
                  onChange={(event) => setCwd(event.target.value)}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">
                  <T>Environment variables (KEY=VALUE per line, supports {"${secret:NAME}"})</T>
                </span>
                <Textarea
                  rows={3}
                  value={envText}
                  disabled={saving}
                  // oxlint-disable-next-line t3code/no-untranslated-copy -- Environment variable example stays English.
                  placeholder="GITHUB_TOKEN=${secret:GITHUB_TOKEN}"
                  spellCheck={false}
                  onChange={(event) => setEnvText(event.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">
                  <T>Endpoint URL</T>
                </span>
                <Input
                  value={url}
                  disabled={saving}
                  placeholder="https://mcp.example.com/mcp"
                  spellCheck={false}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">
                  <T>Headers (Header=Value per line, supports {"${secret:NAME}"})</T>
                </span>
                <Textarea
                  rows={3}
                  value={headersText}
                  disabled={saving}
                  // oxlint-disable-next-line t3code/no-untranslated-copy -- HTTP header syntax example stays English.
                  placeholder="Authorization=Bearer ${secret:API_TOKEN}"
                  spellCheck={false}
                  onChange={(event) => setHeadersText(event.target.value)}
                />
              </label>
              {injectionMode === "gateway" ? (
                <details>
                  <summary className="cursor-pointer text-xs font-medium text-foreground">
                    <T>OAuth settings</T>
                  </summary>
                  <div className="mt-2 grid gap-2">
                    <label className="grid gap-1 text-xs">
                      <T>OAuth client ID</T>
                      <Input
                        value={oauthClientId}
                        onChange={(event) => setOAuthClientId(event.target.value)}
                        disabled={saving}
                      />
                    </label>
                    <label className="grid gap-1 text-xs">
                      <T>OAuth scopes (comma-separated)</T>
                      <Input
                        value={oauthScopes}
                        onChange={(event) => setOAuthScopes(event.target.value)}
                        disabled={saving}
                      />
                    </label>
                    <label className="grid gap-1 text-xs">
                      <T>OAuth authorization server URL</T>
                      <Input
                        value={oauthIssuer}
                        onChange={(event) => setOAuthIssuer(event.target.value)}
                        disabled={saving}
                      />
                    </label>
                  </div>
                </details>
              ) : null}
            </>
          )}

          <div className="grid gap-1">
            <span className="text-xs font-medium text-foreground">
              <T>Injection route</T>
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="xs"
                variant={injectionMode === "gateway" ? "default" : "outline"}
                disabled={saving}
                onClick={() => setInjectionMode("gateway")}
              >
                <T>T3 Gateway (Recommended, all 11 providers)</T>
              </Button>
              <Button
                type="button"
                size="xs"
                variant={injectionMode === "native" ? "default" : "outline"}
                disabled={saving}
                onClick={() => setInjectionMode("native")}
              >
                <T>Native passthrough (when supported)</T>
              </Button>
            </div>
          </div>

          <div className="grid gap-1">
            <span className="text-xs font-medium text-foreground">
              <T>Gateway tool policy</T>
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="xs"
                variant={approvalPolicy === "auto-read" ? "default" : "outline"}
                disabled={saving}
                onClick={() => setApprovalPolicy("auto-read")}
              >
                <T>Auto-allow read-only</T>
              </Button>
              <Button
                type="button"
                size="xs"
                variant={approvalPolicy === "always-ask" ? "default" : "outline"}
                disabled={saving}
                onClick={() => setApprovalPolicy("always-ask")}
              >
                <T>Strict</T>
              </Button>
              <Button
                type="button"
                size="xs"
                variant={approvalPolicy === "auto-all" ? "default" : "outline"}
                disabled={saving}
                onClick={() => setApprovalPolicy("auto-all")}
              >
                <T>Auto-allow all</T>
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-xs font-medium text-foreground">
                <T>Allowed tools (optional, comma-separated)</T>
              </span>
              <Input
                value={allowedToolsText}
                disabled={saving}
                // oxlint-disable-next-line t3code/no-untranslated-copy -- MCP tool name identifiers stay English.
                placeholder="search, get_issue"
                spellCheck={false}
                onChange={(event) => setAllowedToolsText(event.target.value)}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-foreground">
                <T>Disabled tools (optional, comma-separated)</T>
              </span>
              <Input
                value={disabledToolsText}
                disabled={saving}
                placeholder="delete_repo"
                spellCheck={false}
                onChange={(event) => setDisabledToolsText(event.target.value)}
              />
            </label>
          </div>

          <label className="grid gap-1">
            <span className="text-xs font-medium text-foreground">
              <T>Description (optional)</T>
            </span>
            <Input
              value={description}
              disabled={saving}
              placeholder={gt("GitHub issues and repository search")}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>
          <T>Cancel</T>
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
          {saving ? gt("Saving...") : gt("Save")}
        </Button>
      </DialogFooter>
    </>
  );
}

function McpImportWizard({
  environmentId,
  workspaceRoot,
  loading,
  sources,
  allowStdio,
  allowSecrets,
  applyImports,
  onClose,
  onImported,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | undefined;
  readonly loading: boolean;
  readonly sources: ReadonlyArray<HarnessMcpImportSourcePreview>;
  readonly allowStdio: boolean;
  readonly allowSecrets: boolean;
  readonly applyImports: (args: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly items: ReadonlyArray<{
        readonly source: HarnessMcpImportSource;
        readonly id: HarnessMcpServerId;
        readonly expectedDigest?: string;
        readonly expectedExistingDigest?: string | null;
      }>;
      readonly overwriteExisting?: boolean;
      readonly workspaceRoot?: string;
    };
  }) => Promise<AtomCommandResult<HarnessMcpApplyImportsResult, unknown>>;
  readonly onClose: () => void;
  readonly onImported: (snapshot: HarnessMcpSnapshot) => void;
}) {
  const gt = useGT();
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [importing, setImporting] = useState(false);

  const toggleCandidate = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allCandidates: Array<{
    readonly key: string;
    readonly source: HarnessMcpImportSourcePreview["source"];
    readonly candidate: HarnessMcpImportCandidate;
  }> = [];
  for (const src of sources) {
    for (const candidate of src.candidates) {
      allCandidates.push({ key: `${src.source}:${candidate.id}`, source: src.source, candidate });
    }
  }

  const handleImport = async () => {
    const items = allCandidates
      .filter((entry) => selectedKeys.has(entry.key))
      .map((entry) => ({
        source: entry.source,
        id: entry.candidate.id,
        expectedDigest: entry.candidate.previewDigest,
        ...(entry.candidate.existingDigest !== undefined
          ? { expectedExistingDigest: entry.candidate.existingDigest }
          : {}),
      }));
    if (items.length === 0) return;

    setImporting(true);
    const result = await applyImports({
      environmentId,
      input: {
        items,
        overwriteExisting,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setImporting(false);

    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt(
          "Imported {count, plural, one {{count} MCP server} other {{count} MCP servers}}",
          {
            count: result.value.importedIds.length,
          },
        ),
      });
      onImported(result.value.snapshot);
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Import failed"),
        description: formatErrorMessage(
          squashAtomCommandFailure(result),
          gt("Could not import selected MCP servers."),
        ),
      });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Import MCP servers from installed CLIs</T>
        </DialogTitle>
        <DialogDescription>
          <T>
            Read-only scan of Codex, Claude, Cursor, and Antigravity configurations. Existing CLI
            files are never modified.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {loading ? (
          <p className="text-sm text-muted-foreground">
            <T>Scanning local CLI configurations...</T>
          </p>
        ) : allCandidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <T>No importable MCP servers were found in Codex, Claude, Cursor, or Antigravity.</T>
          </p>
        ) : (
          <div className="space-y-4">
            {sources
              .filter((src) => src.found && (src.candidates.length > 0 || src.warnings.length > 0))
              .map((src) => (
                <div key={src.source} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                      {src.source}
                    </span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {src.sourcePath}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {src.candidates.map((candidate) => {
                      const key = `${src.source}:${candidate.id}`;
                      const blocked =
                        (candidate.config.transport.type === "stdio" && !allowStdio) ||
                        (candidate.hasSecretPlaceholders && !allowSecrets);
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 p-2.5"
                        >
                          <Checkbox
                            checked={selectedKeys.has(key)}
                            disabled={blocked || importing}
                            onCheckedChange={() => toggleCandidate(key)}
                          />
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-xs font-medium text-foreground">
                                {candidate.id}
                              </span>
                              <Badge variant="secondary">{candidate.config.transport.type}</Badge>
                              {candidate.conflict === "none" ? (
                                <Badge variant="success">{gt("New")}</Badge>
                              ) : candidate.conflict === "exists_identical" ? (
                                <Badge variant="outline">{gt("Already imported")}</Badge>
                              ) : (
                                <Badge variant="warning">{gt("Differs from existing")}</Badge>
                              )}
                            </div>
                            <div className="truncate font-mono text-xs text-muted-foreground">
                              {candidate.config.transport.type === "stdio"
                                ? [
                                    candidate.config.transport.command,
                                    ...(candidate.config.transport.args ?? []),
                                  ].join(" ")
                                : candidate.config.transport.url}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={overwriteExisting}
                disabled={importing}
                onCheckedChange={(checked) => setOverwriteExisting(checked === true)}
              />
              <span>
                <T>Overwrite servers with matching IDs already in harness.json</T>
              </span>
            </label>
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={importing} onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button
          size="sm"
          disabled={importing || selectedKeys.size === 0}
          onClick={() => void handleImport()}
        >
          {importing
            ? gt("Importing...")
            : gt("Import selected ({count})", { count: selectedKeys.size })}
        </Button>
      </DialogFooter>
    </>
  );
}
