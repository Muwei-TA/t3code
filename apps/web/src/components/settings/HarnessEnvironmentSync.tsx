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
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { useEnvironments } from "../../state/environments";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { useSearchableSetting } from "./settingsSearch";

export function HarnessEnvironmentSync({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
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
  const labelFor = (entry: (typeof environments)[number]) => {
    const { primary, secondary } = settingsScopeEnvironmentLabels(entry, environments);
    return secondary ? `${primary} · ${secondary}` : primary;
  };
  const outboundMcp = canExportMcp && includeMcp;
  const stateLabels = {
    added: gt("Added"),
    modified: gt("Modified"),
    deleted: gt("Only on target"),
    untracked: gt("Untracked"),
    conflict: gt("Conflict"),
  };

  if (source?.serverConfig?.environment.capabilities.harnessEnvironmentSync !== true) return null;

  const reportFailure = (error: unknown) => {
    toastManager.add({
      type: "error",
      title: gt("Harness sync failed"),
      description: error instanceof Error ? error.message : gt("Try again."),
    });
  };
  const withBusy = async (action: () => Promise<void>) => {
    setBusy(true);
    await action()
      .catch(reportFailure)
      .finally(() => setBusy(false));
  };
  const resetPreview = () => {
    setPending(null);
    setSourceFindings([]);
    setDeleteRemovedFiles(false);
  };

  const previewPush = async () => {
    if (!target || !canExport || busy) return;
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

  const push = async () => {
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
    await withBusy(async () => {
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
      if (response._tag === "Success") {
        toastManager.add({
          type: "success",
          title: gt("Harness changes pushed"),
          description: response.value.summary,
        });
      } else if (!isAtomCommandInterrupted(response))
        reportFailure(squashAtomCommandFailure(response));
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
    <SettingsSection
      {...setting("harness-mcp")}
      title={gt("Push to another connected environment")}
    >
      <div className="space-y-3 px-4 py-3 text-sm">
        {targets.length === 0 ? (
          <p className="text-muted-foreground">
            <T>No connected environment with write access supports harness sync.</T>
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-40 flex-1">
                <Select
                  value={target?.environmentId ?? null}
                  disabled={busy || !canExport}
                  onValueChange={(value) => {
                    setTargetId(value);
                    resetPreview();
                  }}
                >
                  <SelectTrigger aria-label={gt("Target environment")}>
                    <SelectValue placeholder={gt("Select target environment")}>
                      {target ? labelFor(target) : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {targets.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {labelFor(entry)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !target || !canExport}
                onClick={() => void previewPush()}
              >
                <T>Preview Diff</T>
              </Button>
            </div>
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                checked={outboundMcp}
                disabled={busy || !canExportMcp}
                onCheckedChange={(checked) => {
                  setIncludeMcp(checked === true);
                  resetPreview();
                }}
              />
              <span>
                <T>
                  Include portable MCP definitions. Secret references require verification on the
                  target.
                </T>
              </span>
            </label>
          </>
        )}
        {findings.length > 0 ? (
          <div role="alert" className="space-y-1 text-xs text-destructive">
            <p>
              <T>Sync blocked by safety checks.</T>
            </p>
            <ul>
              {findingLabels.map((label) => (
                <li key={label} className="break-all font-mono">
                  {label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview && target ? (
          <div className="space-y-3 rounded-lg border border-border/70 p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <strong>
                <T>
                  Changes for <Var>{labelFor(target)}</Var>
                </T>
              </strong>
              {!preview.canApply &&
              findings.length === 0 &&
              preview.mcpServerDiffs.some((entry) => entry.status === "conflict") ? (
                <Badge variant="error">{gt("Blocked")}</Badge>
              ) : null}
            </div>
            {preview.files.length + preview.mcpServerDiffs.length === 0 && findings.length === 0 ? (
              <p className="text-muted-foreground">
                <T>The two environments have no portable harness differences.</T>
              </p>
            ) : null}
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {preview.files.map((file) => (
                <li key={file.path} className="flex items-start justify-between gap-2">
                  <span className="break-all">
                    <code>{file.path}</code>{" "}
                    <span className="text-muted-foreground">{stateLabels[file.status]}</span>
                  </span>
                  <span className="shrink-0 font-mono">{`+${file.additions} / -${file.deletions}`}</span>
                </li>
              ))}
              {preview.mcpServerDiffs.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2">
                  <code>{entry.id}</code>
                  <Badge variant={entry.status === "conflict" ? "error" : "outline"}>
                    {stateLabels[entry.status]}
                  </Badge>
                  {entry.disabledOnImport && entry.status !== "conflict" ? (
                    <span className="text-muted-foreground">
                      <T>Disabled on import</T>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {preview.missingSecretRefs.length > 0 ? (
              <p className="break-all text-warning">
                <T>
                  Missing on target: <Var>{preview.missingSecretRefs.join(", ")}</Var>
                </T>
              </p>
            ) : null}
            {preview.files.some((file) => file.status === "deleted") ? (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={deleteRemovedFiles}
                  disabled={busy || !preview.canApply}
                  onCheckedChange={(checked) => setDeleteRemovedFiles(checked === true)}
                />
                <T>Delete files that only exist on the target</T>
              </label>
            ) : null}
            <Button
              size="sm"
              disabled={
                busy ||
                !canExport ||
                !preview.canApply ||
                !hasChanges ||
                (!!pending?.bundle.portableMcpServers && !outboundMcp)
              }
              onClick={() => void push()}
            >
              <T>Confirm &amp; Push</T>
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
