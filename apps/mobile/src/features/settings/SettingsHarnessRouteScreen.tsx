import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  HarnessMcpServerId,
  type HarnessMcpImportCandidate,
  type HarnessMcpImportSource,
  type HarnessMcpServerConfig,
  type HarnessMcpServerView,
  type HarnessMcpTransport,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { Modal, ScrollView, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { m } from "../../i18n/messages";
import { useProjects } from "../../state/entities";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { formatMobileTargetHost, formatMobileTransportBreakdown } from "./harness-confirmation";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { type MobileHarnessTab, SettingsHarnessLibraryPanel } from "./SettingsHarnessLibraryPanel";
import { SettingsHarnessMemorySyncPanel } from "./SettingsHarnessMemorySyncPanel";
import { SettingsHarnessPluginsHooksPanel } from "./SettingsHarnessPluginsHooksPanel";

const decodeServerId = Schema.decodeUnknownSync(HarnessMcpServerId);

interface FlattenedImportCandidate {
  readonly source: HarnessMcpImportSource;
  readonly sourcePath: string;
  readonly candidate: HarnessMcpImportCandidate;
}

function describeTransport(transport: HarnessMcpTransport): string {
  if (transport.type === "stdio") {
    return [transport.command, ...(transport.args ?? [])].filter(Boolean).join(" ").trim();
  }
  return transport.url;
}

function splitArgs(raw: string): string[] {
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

function confirmTwoStepRemoteAction(input: {
  readonly reviewTitle: string;
  readonly reviewMessage: string;
  readonly reviewConfirmText: string;
  readonly finalTitle: string;
  readonly finalMessage: string;
  readonly finalConfirmText: string;
  readonly destructive?: boolean;
  readonly onConfirmed: () => void;
}) {
  Dialog.confirm({
    title: input.reviewTitle,
    message: input.reviewMessage,
    confirmText: input.reviewConfirmText,
    onConfirm: () => {
      Dialog.confirm({
        title: input.finalTitle,
        message: input.finalMessage,
        confirmText: input.finalConfirmText,
        ...(input.destructive ? { destructive: true } : {}),
        onConfirm: input.onConfirmed,
      });
    },
  });
}

export function SettingsHarnessRouteScreen() {
  const gt = useGT();
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const settingsWriteEnvs = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const terminalOperateEnvs = useEnvironmentsWithScope(selectedTargets, AuthTerminalOperateScope);
  const orchestrationOperateEnvs = useEnvironmentsWithScope(
    selectedTargets,
    AuthOrchestrationOperateScope,
  );
  const diagnosticsReadEnvs = useEnvironmentsWithScope(selectedTargets, AuthDiagnosticsReadScope);
  const providersManageEnvs = useEnvironmentsWithScope(selectedTargets, AuthProvidersManageScope);
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title={gt("Harness & MCP")} menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">
            <T>Select a connected environment.</T>
          </Text>
        ) : (
          selectedTargets.map((environment) => (
            <EnvironmentHarnessSection
              key={environment.environmentId}
              environment={environment}
              canWriteSettings={settingsWriteEnvs.has(environment.environmentId)}
              canOperateTerminal={terminalOperateEnvs.has(environment.environmentId)}
              canOperateOrchestration={orchestrationOperateEnvs.has(environment.environmentId)}
              canReadDiagnostics={diagnosticsReadEnvs.has(environment.environmentId)}
              canManageProviders={providersManageEnvs.has(environment.environmentId)}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentHarnessSection({
  environment,
  canWriteSettings,
  canOperateTerminal,
  canOperateOrchestration,
  canReadDiagnostics,
  canManageProviders,
}: {
  readonly environment: SettingsTarget;
  readonly canWriteSettings: boolean;
  readonly canOperateTerminal: boolean;
  readonly canOperateOrchestration: boolean;
  readonly canReadDiagnostics: boolean;
  readonly canManageProviders: boolean;
}) {
  const gt = useGT();
  const environmentId = environment.environmentId;
  const targetHost = formatMobileTargetHost(environment);
  const managedPolicy = environment.serverConfig.managedPolicy;
  const harnessDisabledByPolicy = managedPolicy?.limits?.harness === false;
  const stdioDisabledByPolicy = managedPolicy?.limits?.harnessMcpStdio === false;

  const allProjects = useProjects();
  const envProjects = allProjects.filter((project) => project.environmentId === environmentId);
  const [selectedWorkspaceRoot, setSelectedWorkspaceRoot] = useState<string | undefined>(undefined);
  const activeWorkspaceRoot =
    selectedWorkspaceRoot !== undefined &&
    envProjects.some((project) => project.workspaceRoot === selectedWorkspaceRoot)
      ? selectedWorkspaceRoot
      : undefined;

  const listQuery = useEnvironmentQuery(
    harnessEnvironment.listMcpQuery({
      environmentId,
      input: activeWorkspaceRoot ? { workspaceRoot: activeWorkspaceRoot } : {},
    }),
  );

  const upsertMcp = useAtomCommand(harnessEnvironment.upsertMcp, { reportFailure: false });
  const removeMcp = useAtomCommand(harnessEnvironment.removeMcp, { reportFailure: false });
  const setMcpEnabled = useAtomCommand(harnessEnvironment.setMcpEnabled, { reportFailure: false });
  const restartMcp = useAtomCommand(harnessEnvironment.restartMcp, { reportFailure: false });
  const logsMcp = useAtomCommand(harnessEnvironment.logsMcp, { reportFailure: false });
  const scanImports = useAtomCommand(harnessEnvironment.scanImports, { reportFailure: false });
  const applyImports = useAtomCommand(harnessEnvironment.applyImports, { reportFailure: false });
  const trustProjectMcp = useAtomCommand(harnessEnvironment.trustProjectMcp, {
    reportFailure: false,
  });
  const revokeProjectTrust = useAtomCommand(harnessEnvironment.revokeProjectTrust, {
    reportFailure: false,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MobileHarnessTab>("mcp");
  const [addOpen, setAddOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [newTransportType, setNewTransportType] = useState<"http" | "sse" | "stdio">("http");
  const [newUrl, setNewUrl] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [logsModal, setLogsModal] = useState<{
    readonly serverId: string;
    readonly lines: ReadonlyArray<string>;
  } | null>(null);
  const [importCandidates, setImportCandidates] =
    useState<ReadonlyArray<FlattenedImportCandidate> | null>(null);
  const [selectedImportKeys, setSelectedImportKeys] = useState<ReadonlySet<string>>(new Set());

  const servers = listQuery.data?.servers ?? [];
  const invalidEntries = listQuery.data?.invalidEntries ?? [];

  const commitToggleEnabled = async (server: HarnessMcpServerView, nextEnabled: boolean) => {
    setBusyId(server.id);
    const result = await setMcpEnabled({
      environmentId,
      input: {
        id: server.id,
        enabled: nextEnabled,
        expectedDigest: server.configDigest,
        ...(activeWorkspaceRoot ? { workspaceRoot: activeWorkspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") {
      listQuery.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not update MCP server"),
        errorDisplayMessage(error, m) ?? gt("Try again."),
      );
    }
  };

  const handleToggleEnabled = (server: HarnessMcpServerView) => {
    if (!canWriteSettings || server.scope !== "user") return;
    const nextEnabled = !server.config.enabled;
    if (nextEnabled && server.config.transport.type === "stdio") {
      if (!canOperateTerminal) {
        Dialog.alert(
          gt("Terminal access required"),
          gt("Enabling stdio MCP servers requires terminal permissions on {host}.", {
            host: targetHost,
          }),
        );
        return;
      }
      const breakdown = formatMobileTransportBreakdown(server.config);
      confirmTwoStepRemoteAction({
        reviewTitle: gt("Review remote stdio command (1/2)"),
        reviewMessage: gt(
          "Enabling “{serverId}” allows {host} to execute:\n\n{breakdown}\n\nContinue to final confirmation?",
          {
            serverId: server.id,
            host: targetHost,
            breakdown,
          },
        ),
        reviewConfirmText: gt("Continue"),
        finalTitle: gt("Confirm remote execution (2/2)"),
        finalMessage: gt(
          "Confirm enabling stdio MCP server “{serverId}” on {host}. Local host processes will run when tools are called.",
          {
            serverId: server.id,
            host: targetHost,
          },
        ),
        finalConfirmText: gt("Enable stdio server"),
        onConfirmed: () => {
          void commitToggleEnabled(server, true);
        },
      });
      return;
    }
    void commitToggleEnabled(server, nextEnabled);
  };

  const handleRestart = async (server: HarnessMcpServerView) => {
    if (!canOperateOrchestration) return;
    if (server.config.transport.type === "stdio" && !canOperateTerminal) return;
    if (server.requiresSecretAccess && !canManageProviders) return;
    setBusyId(server.id);
    const result = await restartMcp({
      environmentId,
      input: {
        serverId: server.id,
        ...(activeWorkspaceRoot ? { workspaceRoot: activeWorkspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") {
      listQuery.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not restart MCP server"),
        errorDisplayMessage(error, m) ?? gt("Try again."),
      );
    }
  };

  const handleOpenLogs = async (server: HarnessMcpServerView) => {
    if (!canReadDiagnostics) return;
    setBusyId(server.id);
    const result = await logsMcp({
      environmentId,
      input: { serverId: server.id },
    });
    setBusyId(null);
    if (result._tag === "Success") {
      setLogsModal({
        serverId: server.id,
        lines: result.value.lines.map(
          (entry) => `[${entry.timestamp}] (${entry.stream}) ${entry.text}`,
        ),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not load server logs"),
        errorDisplayMessage(error, m) ?? gt("Try again."),
      );
    }
  };

  const handleRemove = (server: HarnessMcpServerView) => {
    if (!canWriteSettings || server.scope !== "user") return;
    Dialog.confirm({
      title: gt("Remove MCP server"),
      message: gt("Remove “{serverId}” from {host}?", {
        serverId: server.id,
        host: targetHost,
      }),
      confirmText: gt("Remove"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setBusyId(server.id);
          const result = await removeMcp({
            environmentId,
            input: {
              id: server.id,
              ...(activeWorkspaceRoot ? { workspaceRoot: activeWorkspaceRoot } : {}),
            },
          });
          setBusyId(null);
          if (result._tag === "Success") {
            listQuery.refresh();
          } else if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            Dialog.alert(
              gt("Could not remove MCP server"),
              errorDisplayMessage(error, m) ?? gt("Try again."),
            );
          }
        })();
      },
    });
  };

  const handleTrust = (server: HarnessMcpServerView) => {
    if (!canWriteSettings || !server.repoRoot || !server.trustDigest) return;
    if (server.config.transport.type === "stdio" && !canOperateTerminal) return;
    if (server.requiresSecretAccess && !canManageProviders) return;
    const breakdown = formatMobileTransportBreakdown(server.config);
    const shortDigest = server.trustDigest.slice(0, 16);
    confirmTwoStepRemoteAction({
      reviewTitle: gt("Review project MCP server (1/2)"),
      reviewMessage: gt(
        "Repository: {repo}\nHost: {host}\nDigest: sha256:{digest}\n\n{breakdown}\n\nContinue to trust confirmation?",
        {
          repo: server.repoRoot,
          host: targetHost,
          digest: shortDigest,
          breakdown,
        },
      ),
      reviewConfirmText: gt("Continue"),
      finalTitle: gt("Trust project MCP server? (2/2)"),
      finalMessage: gt(
        "Confirm trusting “{serverId}” from t3.json on {host}. Trust resets automatically if t3.json changes.",
        {
          serverId: server.id,
          host: targetHost,
        },
      ),
      finalConfirmText: gt("Trust & enable"),
      onConfirmed: () => {
        void (async () => {
          setBusyId(server.id);
          const result = await trustProjectMcp({
            environmentId,
            input: {
              repoRoot: server.repoRoot!,
              serverId: server.id,
              digest: server.trustDigest!,
            },
          });
          setBusyId(null);
          if (result._tag === "Success") {
            listQuery.refresh();
          } else if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            Dialog.alert(
              gt("Could not trust server"),
              errorDisplayMessage(error, m) ?? gt("Try again."),
            );
          }
        })();
      },
    });
  };

  const handleRevokeTrust = async (server: HarnessMcpServerView) => {
    if (!canWriteSettings || !server.repoRoot) return;
    setBusyId(server.id);
    const result = await revokeProjectTrust({
      environmentId,
      input: {
        repoRoot: server.repoRoot,
        serverId: server.id,
      },
    });
    setBusyId(null);
    if (result._tag === "Success") {
      listQuery.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(gt("Could not revoke trust"), errorDisplayMessage(error, m) ?? gt("Try again."));
    }
  };

  const commitAddServer = async (id: HarnessMcpServerId, config: HarnessMcpServerConfig) => {
    setBusyId("__add__");
    const result = await upsertMcp({
      environmentId,
      input: {
        id,
        config,
        ...(activeWorkspaceRoot ? { workspaceRoot: activeWorkspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") {
      setAddOpen(false);
      setNewId("");
      setNewUrl("");
      setNewCommand("");
      setNewArgs("");
      listQuery.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not add MCP server"),
        errorDisplayMessage(error, m) ?? gt("Try again."),
      );
    }
  };

  const handleSubmitAddServer = () => {
    let parsedId: HarnessMcpServerId;
    try {
      parsedId = decodeServerId(newId.trim());
    } catch {
      Dialog.alert(
        gt("Invalid server ID"),
        gt("Use letters, digits, underscores, or hyphens (no dots, spaces, or reserved T3 names)."),
      );
      return;
    }

    if (newTransportType === "stdio") {
      if (!canOperateTerminal) {
        Dialog.alert(
          gt("Terminal access required"),
          gt("Adding stdio MCP servers requires terminal permissions on {host}.", {
            host: targetHost,
          }),
        );
        return;
      }
      const trimmedCommand = newCommand.trim();
      if (!trimmedCommand) {
        Dialog.alert(gt("Enter a command"));
        return;
      }
      const args = splitArgs(newArgs);
      const config: HarnessMcpServerConfig = {
        enabled: true,
        transport: {
          type: "stdio",
          command: trimmedCommand,
          ...(args.length > 0 ? { args } : {}),
        },
        injectionMode: "gateway",
        approvalPolicy: "auto-read",
      };
      const breakdown = formatMobileTransportBreakdown(config);
      confirmTwoStepRemoteAction({
        reviewTitle: gt("Review remote stdio command (1/2)"),
        reviewMessage: gt(
          "Host: {host}\nServer ID: {serverId}\n\n{breakdown}\n\nContinue to final confirmation?",
          {
            host: targetHost,
            serverId: parsedId,
            breakdown,
          },
        ),
        reviewConfirmText: gt("Continue"),
        finalTitle: gt("Confirm remote command execution (2/2)"),
        finalMessage: gt(
          "Allow {host} to save and execute stdio MCP server “{serverId}” with this exact command and argument list?",
          {
            host: targetHost,
            serverId: parsedId,
          },
        ),
        finalConfirmText: gt("Add stdio server"),
        onConfirmed: () => {
          void commitAddServer(parsedId, config);
        },
      });
      return;
    }

    const trimmedUrl = newUrl.trim();
    if (!/^https?:\/\/[^\s/]+/i.test(trimmedUrl)) {
      Dialog.alert(gt("Enter a valid http:// or https:// endpoint URL"));
      return;
    }
    void commitAddServer(parsedId, {
      enabled: true,
      transport: {
        type: newTransportType,
        url: trimmedUrl,
      },
      injectionMode: "gateway",
      approvalPolicy: "auto-read",
    });
  };

  const handleScanImports = async () => {
    setBusyId("__scan__");
    const result = await scanImports({
      environmentId,
      input: {},
    });
    setBusyId(null);
    if (result._tag === "Success") {
      const flattened: FlattenedImportCandidate[] = result.value.sources.flatMap((source) =>
        source.candidates.map((candidate) => ({
          source: source.source,
          sourcePath: source.sourcePath,
          candidate,
        })),
      );
      setImportCandidates(flattened);
      setSelectedImportKeys(
        new Set(
          flattened
            .filter(
              (entry) =>
                entry.candidate.conflict === "none" &&
                (entry.candidate.config.transport.type !== "stdio" ||
                  (canOperateTerminal && !stdioDisabledByPolicy)) &&
                (!entry.candidate.hasSecretPlaceholders || canManageProviders),
            )
            .map((entry) => `${entry.source}:${entry.candidate.id}`),
        ),
      );
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not scan CLI configs"),
        errorDisplayMessage(error, m) ?? gt("Try again."),
      );
    }
  };

  const commitImports = async (chosen: ReadonlyArray<FlattenedImportCandidate>) => {
    setBusyId("__import__");
    const result = await applyImports({
      environmentId,
      input: {
        items: chosen.map((entry) => ({
          source: entry.source,
          id: entry.candidate.id,
          expectedDigest: entry.candidate.previewDigest,
          ...(entry.candidate.existingDigest !== undefined
            ? { expectedExistingDigest: entry.candidate.existingDigest }
            : {}),
        })),
        overwriteExisting: true,
        ...(activeWorkspaceRoot ? { workspaceRoot: activeWorkspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") {
      setImportCandidates(null);
      listQuery.refresh();
      Dialog.alert(
        gt("Import complete"),
        gt("Imported {count} MCP server(s) without modifying native CLI configs.", {
          count: result.value.importedIds.length,
        }),
      );
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not import MCP servers"),
        errorDisplayMessage(error, m) ?? gt("Try again."),
      );
    }
  };

  const handleApplyImports = () => {
    if (!importCandidates) return;
    const chosen = importCandidates.filter((entry) =>
      selectedImportKeys.has(`${entry.source}:${entry.candidate.id}`),
    );
    if (chosen.length === 0) return;

    const secretChosen = chosen.filter((entry) => entry.candidate.hasSecretPlaceholders);
    if (secretChosen.length > 0 && !canManageProviders) {
      Dialog.alert(
        gt("Provider management permission required"),
        gt(
          "Importing servers that reference secrets requires provider management access on {host}.",
          {
            host: targetHost,
          },
        ),
      );
      return;
    }

    const stdioChosen = chosen.filter((entry) => entry.candidate.config.transport.type === "stdio");
    if (stdioChosen.length > 0) {
      if (!canOperateTerminal) {
        Dialog.alert(
          gt("Terminal access required"),
          gt("Importing stdio MCP servers requires terminal permissions on {host}.", {
            host: targetHost,
          }),
        );
        return;
      }
      const commandBreakdown = stdioChosen
        .map(
          (entry) =>
            `• ${entry.candidate.id} (${entry.source})\n${formatMobileTransportBreakdown(entry.candidate.config)}`,
        )
        .join("\n\n");
      confirmTwoStepRemoteAction({
        reviewTitle: gt("Review imported stdio commands (1/2)"),
        reviewMessage: gt("Host: {host}\n\n{commands}\n\nContinue to final confirmation?", {
          host: targetHost,
          commands: commandBreakdown,
        }),
        reviewConfirmText: gt("Continue"),
        finalTitle: gt("Confirm remote stdio import (2/2)"),
        finalMessage: gt(
          "Confirm importing {count} stdio MCP server(s) onto {host}. Native CLI files will not be modified.",
          {
            count: stdioChosen.length,
            host: targetHost,
          },
        ),
        finalConfirmText: gt("Import & allow"),
        onConfirmed: () => {
          void commitImports(chosen);
        },
      });
      return;
    }

    void commitImports(chosen);
  };

  return (
    <SettingsSection title={environment.label}>
      <View className="gap-3 p-4">
        <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {targetHost}
        </Text>

        {harnessDisabledByPolicy ? (
          <Text className="text-sm text-foreground-muted">
            <T>T3 Portable Harness is disabled by this environment's managed policy.</T>
          </Text>
        ) : (
          <>
            {envProjects.length > 0 ? (
              <View className="gap-1.5">
                <Text className="text-xs font-t3-medium text-foreground-muted">
                  <T>Workspace scope (for project t3.json servers)</T>
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerClassName="flex-row gap-2"
                >
                  <Button
                    label={gt("User only")}
                    tone={activeWorkspaceRoot === undefined ? "primary" : "secondary"}
                    onPress={() => setSelectedWorkspaceRoot(undefined)}
                  />
                  {envProjects.map((project) => (
                    <Button
                      key={project.id}
                      label={project.title}
                      tone={activeWorkspaceRoot === project.workspaceRoot ? "primary" : "secondary"}
                      onPress={() => setSelectedWorkspaceRoot(project.workspaceRoot)}
                    />
                  ))}
                </ScrollView>
              </View>
            ) : null}

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="flex-row gap-2"
            >
              {(
                [
                  ["mcp", gt("MCP")],
                  ["modes", gt("Modes")],
                  ["skills", gt("Skills")],
                  ["rules", gt("Rules")],
                  ["commands", gt("Commands")],
                  ["plugins", gt("Plugins")],
                  ["hooks", gt("Hooks")],
                  ["memory", gt("Memory")],
                  ["sync", gt("Git Sync")],
                  ["permissions", gt("Permissions")],
                  ["transfer", gt("Import / Export")],
                ] as const
              ).map(([tabKey, tabLabel]) => (
                <Button
                  key={tabKey}
                  label={tabLabel}
                  tone={activeTab === tabKey ? "primary" : "secondary"}
                  onPress={() => setActiveTab(tabKey)}
                />
              ))}
            </ScrollView>

            {activeTab === "plugins" || activeTab === "hooks" ? (
              <SettingsHarnessPluginsHooksPanel
                activeTab={activeTab}
                environmentId={environmentId}
                targetHost={targetHost}
                canWriteSettings={canWriteSettings}
                canOperateTerminal={canOperateTerminal}
              />
            ) : activeTab === "memory" || activeTab === "sync" ? (
              <SettingsHarnessMemorySyncPanel
                activeTab={activeTab}
                environmentId={environmentId}
                targetHost={targetHost}
                canWriteSettings={canWriteSettings}
              />
            ) : activeTab !== "mcp" ? (
              <SettingsHarnessLibraryPanel
                activeTab={activeTab}
                environmentId={environmentId}
                workspaceRoot={activeWorkspaceRoot}
                targetHost={targetHost}
                canWriteSettings={canWriteSettings}
                canManageProviders={canManageProviders}
              />
            ) : (
              <>
                <View className="flex-row flex-wrap gap-2">
                  <Button
                    label={gt("Add server")}
                    tone="primary"
                    disabled={!canWriteSettings}
                    onPress={() => setAddOpen(true)}
                  />
                  <Button
                    label={busyId === "__scan__" ? gt("Scanning...") : gt("Import from CLIs")}
                    tone="secondary"
                    disabled={!canWriteSettings || busyId === "__scan__"}
                    onPress={() => void handleScanImports()}
                  />
                  <Button
                    label={gt("Refresh")}
                    tone="secondary"
                    onPress={() => listQuery.refresh()}
                  />
                </View>

                {invalidEntries.length > 0 ? (
                  <Text className="text-xs text-destructive">
                    {gt("{count} invalid harness entry skipped in harness.json.", {
                      count: invalidEntries.length,
                    })}
                  </Text>
                ) : null}

                {listQuery.isPending && servers.length === 0 ? (
                  <View className="py-4">
                    <AppActivityIndicator />
                  </View>
                ) : servers.length === 0 ? (
                  <Text className="text-sm text-foreground-muted">
                    <T>
                      No MCP servers configured yet. Add one or import from Codex, Claude, Cursor,
                      or Antigravity.
                    </T>
                  </Text>
                ) : (
                  <View className="gap-3">
                    {servers.map((server) => {
                      const canTrustServer =
                        canWriteSettings &&
                        (server.config.transport.type !== "stdio" ||
                          (canOperateTerminal && !stdioDisabledByPolicy)) &&
                        (!server.requiresSecretAccess || canManageProviders);
                      const canRestartServer =
                        canOperateOrchestration &&
                        server.effectiveEnabled &&
                        (server.config.transport.type !== "stdio" || canOperateTerminal) &&
                        (!server.requiresSecretAccess || canManageProviders);
                      return (
                        <View
                          key={`${server.scope}:${server.id}`}
                          className="gap-2 rounded-xl border border-border bg-card-alt p-3"
                        >
                          <View className="flex-row items-center justify-between gap-2">
                            <View className="flex-1">
                              <Text className="font-t3-semibold text-base text-foreground">
                                {server.id}
                              </Text>
                              <Text className="text-xs text-foreground-muted">
                                {server.config.transport.type.toUpperCase()} · {server.scope} ·{" "}
                                {server.state} · {gt("{count} tools", { count: server.toolCount })}
                              </Text>
                            </View>
                            {server.scope === "user" ? (
                              <Switch
                                value={server.config.enabled}
                                disabled={
                                  !canWriteSettings ||
                                  busyId === server.id ||
                                  server.state === "blocked_by_policy"
                                }
                                onValueChange={() => handleToggleEnabled(server)}
                              />
                            ) : null}
                          </View>

                          <Text
                            className="font-mono text-xs text-foreground-muted"
                            numberOfLines={3}
                          >
                            {describeTransport(server.config.transport)}
                          </Text>

                          {server.lastError ? (
                            <Text className="text-xs text-destructive">{server.lastError}</Text>
                          ) : null}

                          <View className="flex-row flex-wrap gap-2 pt-1">
                            {server.needsTrustConfirmation ? (
                              <Button
                                label={gt("Review & trust")}
                                tone="primary"
                                disabled={!canTrustServer || busyId === server.id}
                                onPress={() => handleTrust(server)}
                              />
                            ) : null}
                            {server.scope === "project" &&
                            server.trustDigest !== null &&
                            !server.needsTrustConfirmation ? (
                              <Button
                                label={gt("Revoke trust")}
                                tone="secondary"
                                disabled={!canWriteSettings || busyId === server.id}
                                onPress={() => void handleRevokeTrust(server)}
                              />
                            ) : null}
                            <Button
                              label={gt("Restart")}
                              tone="secondary"
                              disabled={!canRestartServer || busyId === server.id}
                              onPress={() => void handleRestart(server)}
                            />
                            {canReadDiagnostics ? (
                              <Button
                                label={gt("Logs")}
                                tone="secondary"
                                disabled={busyId === server.id}
                                onPress={() => void handleOpenLogs(server)}
                              />
                            ) : null}
                            {server.scope === "user" ? (
                              <Button
                                label={gt("Remove")}
                                tone="secondary"
                                disabled={!canWriteSettings || busyId === server.id}
                                onPress={() => handleRemove(server)}
                              />
                            ) : null}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </>
            )}
          </>
        )}
      </View>

      <Modal
        visible={addOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAddOpen(false)}
      >
        <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
          <Text className="font-t3-bold text-xl text-foreground">
            <T>Add MCP server</T>
          </Text>
          <Text className="font-mono text-xs text-foreground-muted">
            {gt("Target host: {host}", { host: targetHost })}
          </Text>

          <View className="gap-1.5">
            <Text className="text-sm font-t3-medium text-foreground">
              <T>Server ID</T>
            </Text>
            <TextInput
              value={newId}
              onChangeText={setNewId}
              placeholder="github"
              autoCapitalize="none"
              autoCorrect={false}
              className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
            />
          </View>

          <View className="flex-row gap-2">
            {(["http", "sse", "stdio"] as const).map((transport) => (
              <Button
                key={transport}
                label={transport.toUpperCase()}
                tone={newTransportType === transport ? "primary" : "secondary"}
                disabled={transport === "stdio" && (stdioDisabledByPolicy || !canOperateTerminal)}
                onPress={() => setNewTransportType(transport)}
              />
            ))}
          </View>

          {newTransportType === "stdio" ? (
            <>
              <View className="gap-1.5">
                <Text className="text-sm font-t3-medium text-foreground">
                  <T>Command</T>
                </Text>
                <TextInput
                  value={newCommand}
                  onChangeText={setNewCommand}
                  placeholder="npx"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
                />
              </View>
              <View className="gap-1.5">
                <Text className="text-sm font-t3-medium text-foreground">
                  <T>Arguments (space-separated)</T>
                </Text>
                <TextInput
                  value={newArgs}
                  onChangeText={setNewArgs}
                  // oxlint-disable-next-line t3code/no-untranslated-copy -- CLI argument example stays English.
                  placeholder="-y @modelcontextprotocol/server-filesystem ."
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
                />
              </View>
            </>
          ) : (
            <View className="gap-1.5">
              <Text className="text-sm font-t3-medium text-foreground">
                <T>Endpoint URL</T>
              </Text>
              <TextInput
                value={newUrl}
                onChangeText={setNewUrl}
                placeholder="https://mcp.example.com/mcp"
                autoCapitalize="none"
                autoCorrect={false}
                className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
              />
            </View>
          )}

          <View className="flex-row gap-2 pt-2">
            <Button
              label={busyId === "__add__" ? gt("Saving...") : gt("Save")}
              tone="primary"
              disabled={busyId === "__add__"}
              onPress={handleSubmitAddServer}
            />
            <Button label={gt("Cancel")} tone="secondary" onPress={() => setAddOpen(false)} />
          </View>
        </ScrollView>
      </Modal>

      <Modal
        visible={importCandidates !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setImportCandidates(null)}
      >
        <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
          <Text className="font-t3-bold text-xl text-foreground">
            <T>Import MCP servers from CLIs</T>
          </Text>
          <Text className="font-mono text-xs text-foreground-muted">
            {gt("Target host: {host}", { host: targetHost })}
          </Text>
          <Text className="text-sm text-foreground-muted">
            <T>
              Read-only scan of Codex, Claude, Cursor, and Antigravity configs. Native files are
              never modified.
            </T>
          </Text>

          {importCandidates && importCandidates.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>No external MCP servers were found on this host.</T>
            </Text>
          ) : (
            (importCandidates ?? []).map((entry) => {
              const key = `${entry.source}:${entry.candidate.id}`;
              const selected = selectedImportKeys.has(key);
              const blocked =
                (entry.candidate.config.transport.type === "stdio" &&
                  (!canOperateTerminal || stdioDisabledByPolicy)) ||
                (entry.candidate.hasSecretPlaceholders && !canManageProviders);
              return (
                <View
                  key={key}
                  className="flex-row items-center justify-between gap-3 rounded-xl border border-border bg-card-alt p-3"
                >
                  <View className="flex-1">
                    <Text className="font-t3-semibold text-base text-foreground">
                      {entry.candidate.id}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {entry.source} · {entry.candidate.config.transport.type.toUpperCase()}
                      {entry.candidate.conflict !== "none" ? ` · ${entry.candidate.conflict}` : ""}
                    </Text>
                    <Text className="font-mono text-xs text-foreground-muted" numberOfLines={3}>
                      {formatMobileTransportBreakdown(entry.candidate.config)}
                    </Text>
                  </View>
                  <Switch
                    value={selected}
                    disabled={blocked}
                    onValueChange={(next) => {
                      setSelectedImportKeys((prev) => {
                        const updated = new Set(prev);
                        if (next) updated.add(key);
                        else updated.delete(key);
                        return updated;
                      });
                    }}
                  />
                </View>
              );
            })
          )}

          <View className="flex-row gap-2 pt-2">
            <Button
              label={
                busyId === "__import__"
                  ? gt("Importing...")
                  : gt("Import selected ({count})", { count: selectedImportKeys.size })
              }
              tone="primary"
              disabled={selectedImportKeys.size === 0 || busyId === "__import__"}
              onPress={handleApplyImports}
            />
            <Button
              label={gt("Close")}
              tone="secondary"
              onPress={() => setImportCandidates(null)}
            />
          </View>
        </ScrollView>
      </Modal>

      <Modal
        visible={logsModal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setLogsModal(null)}
      >
        <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
          <Text className="font-t3-bold text-xl text-foreground">
            <T>
              Logs: <Var>{logsModal?.serverId ?? ""}</Var>
            </T>
          </Text>
          {logsModal && logsModal.lines.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>No recent stderr or lifecycle output recorded.</T>
            </Text>
          ) : (
            <View className="rounded-xl border border-border bg-card-alt p-3">
              <Text className="font-mono text-xs text-foreground" selectable>
                {(logsModal?.lines ?? []).join("\n")}
              </Text>
            </View>
          )}
          <Button label={gt("Close")} tone="secondary" onPress={() => setLogsModal(null)} />
        </ScrollView>
      </Modal>
    </SettingsSection>
  );
}
