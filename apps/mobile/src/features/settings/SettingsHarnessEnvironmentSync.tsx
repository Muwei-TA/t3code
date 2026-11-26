import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type HarnessSyncBundle,
  type HarnessSyncPreviewReceiveResult,
  type HarnessSyncSecretFinding,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { Switch, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { m } from "../../i18n/messages";
import { useEnvironments } from "../../state/environments";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { confirmTwoStepRemoteAction } from "./confirmTwoStepRemoteAction";

export function SettingsHarnessEnvironmentSync({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const writableIds = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const canExport = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canExportMcp = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const source = environments.find((environment) => environment.environmentId === environmentId);
  const targets = environments.filter(
    (environment) =>
      environment.environmentId !== environmentId &&
      environment.connection.phase === "connected" &&
      writableIds.has(environment.environmentId) &&
      environment.serverConfig?.environment.capabilities.harnessEnvironmentSync === true &&
      environment.serverConfig.managedPolicy?.limits?.harness !== false,
  );
  const exportBundle = useAtomCommand(harnessEnvironment.exportSyncBundle, {
    reportFailure: false,
  });
  const previewReceive = useAtomCommand(harnessEnvironment.previewReceiveSync, {
    reportFailure: false,
  });
  const applyReceive = useAtomCommand(harnessEnvironment.applyReceiveSync, {
    reportFailure: false,
  });
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  const [includeMcp, setIncludeMcp] = useState(false);
  const [deleteRemovedFiles, setDeleteRemovedFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sourceFindings, setSourceFindings] = useState<ReadonlyArray<HarnessSyncSecretFinding>>([]);
  const [pending, setPending] = useState<{
    bundle: HarnessSyncBundle;
    preview: HarnessSyncPreviewReceiveResult;
  } | null>(null);
  const target = targets.find((environment) => environment.environmentId === targetId);
  const labelFor = (entry: (typeof environments)[number]) =>
    environments.some(
      (other) => other.environmentId !== entry.environmentId && other.label === entry.label,
    )
      ? `${entry.label} · ${entry.displayUrl ?? entry.environmentId}`
      : entry.label;
  const outboundMcp = canExportMcp && includeMcp;
  const stateLabels = {
    added: gt("Added"),
    modified: gt("Modified"),
    deleted: gt("Only on target"),
    untracked: gt("Untracked"),
    conflict: gt("Conflict"),
  };

  if (source?.serverConfig?.environment.capabilities.harnessEnvironmentSync !== true) return null;

  const reportFailure = (error: unknown) =>
    Dialog.alert(gt("Harness sync failed"), errorDisplayMessage(error, m) ?? gt("Try again."));
  const withBusy = async (action: () => Promise<void>) => {
    setBusy(true);
    await action()
      .catch(reportFailure)
      .finally(() => setBusy(false));
  };
  const resetPreview = () => {
    setSourceFindings([]);
    setPending(null);
    setDeleteRemovedFiles(false);
  };

  const previewPush = async () => {
    if (!target || busy || !canExport) return;
    resetPreview();
    await withBusy(async () => {
      const exported = await exportBundle({
        environmentId,
        input: { includeMcpServers: outboundMcp },
      });
      if (exported._tag === "Failure") {
        if (!isAtomCommandInterrupted(exported)) reportFailure(squashAtomCommandFailure(exported));
        return;
      }
      const { bundle, secretFindings } = exported.value;
      if (!bundle) {
        setSourceFindings(secretFindings);
        return;
      }
      const response = await previewReceive({
        environmentId: target.environmentId,
        input: { bundle },
      });
      if (response._tag === "Success") setPending({ bundle, preview: response.value });
      else if (!isAtomCommandInterrupted(response))
        reportFailure(squashAtomCommandFailure(response));
    });
  };

  const confirmPush = () => {
    const previewDigest = pending?.preview.previewDigest;
    if (
      !target ||
      busy ||
      !pending ||
      !previewDigest ||
      !canExport ||
      (pending.bundle.portableMcpServers && !outboundMcp)
    )
      return;
    const count = pending.preview.files.filter(
      (file) => file.status !== "deleted" || deleteRemovedFiles,
    ).length;
    confirmTwoStepRemoteAction({
      reviewTitle: gt("Review harness push"),
      reviewMessage: gt("Apply {files} file changes and {servers} MCP server changes to {host}?", {
        files: count,
        servers: pending.preview.mcpServerDiffs.length,
        host: labelFor(target),
      }),
      reviewConfirmText: gt("Continue"),
      finalTitle: gt("Push harness changes?"),
      finalMessage: gt("The reviewed changes will be written on {host}.", {
        host: labelFor(target),
      }),
      finalConfirmText: gt("Confirm & Push"),
      destructive: deleteRemovedFiles,
      onConfirmed: () =>
        void withBusy(async () => {
          const response = await applyReceive({
            environmentId: target.environmentId,
            input: {
              bundle: pending.bundle,
              expectedPreviewDigest: previewDigest,
              includeMcpServers: outboundMcp,
              deleteRemovedFiles,
            },
          });
          setPending(null);
          if (response._tag === "Success")
            Dialog.alert(gt("Harness changes pushed"), response.value.summary);
          else if (!isAtomCommandInterrupted(response))
            reportFailure(squashAtomCommandFailure(response));
        }),
    });
  };

  const preview = target ? pending?.preview : null;
  const findings = preview?.secretFindings ?? sourceFindings;
  const findingLabels = [
    ...new Set(findings.map(({ path, line, rule }) => `${path}:${line} (${rule})`)),
  ];
  const hasChanges =
    preview?.files.some((file) => file.status !== "deleted" || deleteRemovedFiles) ||
    (preview?.mcpServerDiffs.length ?? 0) > 0;
  return (
    <View className="gap-3 rounded-xl border border-border-subtle bg-card p-3">
      <Text className="font-t3-semibold text-sm text-foreground">
        <T>Push to another connected environment</T>
      </Text>
      {targets.length === 0 ? (
        <Text className="text-xs text-foreground-muted">
          <T>No connected environment with write access supports harness sync.</T>
        </Text>
      ) : (
        <>
          <View>
            {targets.map((entry, index) => (
              <SelectionRow
                key={entry.environmentId}
                title={labelFor(entry)}
                selected={entry.environmentId === targetId}
                disabled={busy || !canExport}
                isFirst={index === 0}
                isLast={index === targets.length - 1}
                onPress={() => {
                  setTargetId(entry.environmentId);
                  resetPreview();
                }}
              />
            ))}
          </View>
          <View className="flex-row items-center gap-2">
            <Text className="flex-1 text-xs text-foreground">
              <T>
                Include portable MCP definitions. Secret references require verification on the
                target.
              </T>
            </Text>
            <Switch
              accessibilityLabel={gt("Include portable MCP definitions")}
              disabled={busy || !canExportMcp}
              value={outboundMcp}
              onValueChange={(value) => {
                setIncludeMcp(value);
                resetPreview();
              }}
            />
          </View>
          <Button
            label={gt("Preview Diff")}
            tone="secondary"
            disabled={busy || !target || !canExport}
            onPress={() => void previewPush()}
          />
        </>
      )}
      {findings.length > 0 ? (
        <View className="gap-1">
          <Text className="text-xs text-destructive">
            <T>Sync blocked by safety checks.</T>
          </Text>
          {findingLabels.map((label) => (
            <Text key={label} className="font-mono text-xs text-destructive">
              {label}
            </Text>
          ))}
        </View>
      ) : null}
      {preview && target ? (
        <View className="gap-2">
          <Text className="font-t3-semibold text-xs text-foreground">
            <T>
              Changes for <Var>{labelFor(target)}</Var>
            </T>
          </Text>
          {preview.files.length + preview.mcpServerDiffs.length === 0 && findings.length === 0 ? (
            <Text className="text-xs text-foreground-muted">
              <T>The two environments have no portable harness differences.</T>
            </Text>
          ) : null}
          {preview.files.map((file) => (
            <View key={file.path} className="flex-row justify-between gap-2">
              <Text className="flex-1 font-mono text-xs text-foreground">
                {file.path} · {stateLabels[file.status]}
              </Text>
              <Text className="font-mono text-xs text-foreground-muted">{`+${file.additions} / -${file.deletions}`}</Text>
            </View>
          ))}
          {preview.mcpServerDiffs.map((entry) => (
            <View key={entry.id} className="flex-row flex-wrap gap-2">
              <Text className="font-mono text-xs text-foreground">{entry.id}</Text>
              <Text className="text-xs text-foreground-muted">{stateLabels[entry.status]}</Text>
              {entry.disabledOnImport && entry.status !== "conflict" ? (
                <Text className="text-xs text-foreground-muted">
                  <T>Disabled on import</T>
                </Text>
              ) : null}
            </View>
          ))}
          {preview.missingSecretRefs.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              <T>
                Missing on target: <Var>{preview.missingSecretRefs.join(", ")}</Var>
              </T>
            </Text>
          ) : null}
          {preview.files.some((file) => file.status === "deleted") ? (
            <View className="flex-row items-center gap-2">
              <Text className="flex-1 text-xs text-foreground">
                <T>Delete files that only exist on the target</T>
              </Text>
              <Switch
                accessibilityLabel={gt("Delete files that only exist on the target")}
                value={deleteRemovedFiles}
                disabled={busy || !preview.canApply}
                onValueChange={setDeleteRemovedFiles}
              />
            </View>
          ) : null}
          <Button
            label={gt("Confirm & Push")}
            disabled={
              busy ||
              !canExport ||
              !preview.canApply ||
              !hasChanges ||
              (!!pending?.bundle.portableMcpServers && !outboundMcp)
            }
            onPress={confirmPush}
          />
        </View>
      ) : null}
    </View>
  );
}
