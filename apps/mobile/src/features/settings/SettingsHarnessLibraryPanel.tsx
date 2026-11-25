import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type HarnessApprovalRuleRecord,
  HarnessCommandId,
  type HarnessCommandEntry,
  type HarnessExportPreviewResult,
  type HarnessExportSection,
  type HarnessExportTarget,
  type HarnessLibraryImportCandidate,
  type HarnessLibraryImportSourcePreview,
  type HarnessLibrarySnapshot,
  type HarnessMcpImportSource,
  type HarnessModeEntry,
  HarnessModeId,
  type HarnessRuleApplyMode,
  type HarnessRuleEntry,
  HarnessRuleId,
  type HarnessSkillEntry,
  HarnessSkillId,
  PositiveInt,
  type ProviderInteractionMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { Modal, ScrollView, Switch, TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const decodeSkillId = Schema.decodeUnknownOption(HarnessSkillId);
const decodeRuleId = Schema.decodeUnknownOption(HarnessRuleId);
const decodeCommandId = Schema.decodeUnknownOption(HarnessCommandId);
const decodeModeId = Schema.decodeUnknownOption(HarnessModeId);

export type MobileHarnessTab =
  | "mcp"
  | "modes"
  | "skills"
  | "rules"
  | "commands"
  | "plugins"
  | "hooks"
  | "memory"
  | "sync"
  | "permissions"
  | "transfer";

const ALL_EXPORT_SECTIONS: ReadonlyArray<HarnessExportSection> = [
  "mcp",
  "skills",
  "rules",
  "commands",
];

function confirmTwoStepExport(input: {
  readonly reviewTitle: string;
  readonly reviewMessage: string;
  readonly reviewConfirmText: string;
  readonly finalTitle: string;
  readonly finalMessage: string;
  readonly finalConfirmText: string;
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
        destructive: true,
        onConfirm: input.onConfirmed,
      });
    },
  });
}

export function SettingsHarnessLibraryPanel({
  activeTab,
  environmentId,
  workspaceRoot,
  targetHost,
  canWriteSettings,
  canManageProviders,
}: {
  readonly activeTab: Exclude<MobileHarnessTab, "mcp" | "plugins" | "hooks" | "memory" | "sync">;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | undefined;
  readonly targetHost: string;
  readonly canWriteSettings: boolean;
  readonly canManageProviders: boolean;
}) {
  const gt = useGT();
  const libraryQuery = useEnvironmentQuery(
    harnessEnvironment.libraryQuery({
      environmentId,
      input: workspaceRoot ? { workspaceRoot } : {},
    }),
  );
  const approvalRulesQuery = useEnvironmentQuery(
    harnessEnvironment.approvalRulesQuery({
      environmentId,
      input: { includeRevoked: true },
    }),
  );

  const saveAgentsMd = useAtomCommand(harnessEnvironment.saveAgentsMd, { reportFailure: false });
  const upsertSkill = useAtomCommand(harnessEnvironment.upsertSkill, { reportFailure: false });
  const removeSkill = useAtomCommand(harnessEnvironment.removeSkill, { reportFailure: false });
  const setSkillEnabled = useAtomCommand(harnessEnvironment.setSkillEnabled, {
    reportFailure: false,
  });
  const upsertRule = useAtomCommand(harnessEnvironment.upsertRule, { reportFailure: false });
  const removeRule = useAtomCommand(harnessEnvironment.removeRule, { reportFailure: false });
  const setRuleEnabled = useAtomCommand(harnessEnvironment.setRuleEnabled, {
    reportFailure: false,
  });
  const upsertCommand = useAtomCommand(harnessEnvironment.upsertCommand, { reportFailure: false });
  const removeCommand = useAtomCommand(harnessEnvironment.removeCommand, { reportFailure: false });
  const setCommandEnabled = useAtomCommand(harnessEnvironment.setCommandEnabled, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(harnessEnvironment.updateSettings, {
    reportFailure: false,
  });
  const scanLibraryImports = useAtomCommand(harnessEnvironment.scanLibraryImports, {
    reportFailure: false,
  });
  const applyLibraryImports = useAtomCommand(harnessEnvironment.applyLibraryImports, {
    reportFailure: false,
  });
  const previewExport = useAtomCommand(harnessEnvironment.previewExport, { reportFailure: false });
  const applyExport = useAtomCommand(harnessEnvironment.applyExport, { reportFailure: false });
  const upsertMode = useAtomCommand(harnessEnvironment.upsertMode, { reportFailure: false });
  const removeMode = useAtomCommand(harnessEnvironment.removeMode, { reportFailure: false });
  const setModeEnabled = useAtomCommand(harnessEnvironment.setModeEnabled, {
    reportFailure: false,
  });
  const revokeApprovalRule = useAtomCommand(harnessEnvironment.revokeApprovalRule, {
    reportFailure: false,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [modeModal, setModeModal] = useState<
    { readonly mode: "create" } | { readonly mode: "edit"; readonly entry: HarnessModeEntry } | null
  >(null);
  const [skillModal, setSkillModal] = useState<
    | { readonly mode: "create" }
    | { readonly mode: "edit"; readonly entry: HarnessSkillEntry }
    | null
  >(null);
  const [ruleModal, setRuleModal] = useState<
    { readonly mode: "create" } | { readonly mode: "edit"; readonly entry: HarnessRuleEntry } | null
  >(null);
  const [commandModal, setCommandModal] = useState<
    | { readonly mode: "create" }
    | { readonly mode: "edit"; readonly entry: HarnessCommandEntry }
    | null
  >(null);
  const [agentsMdOpen, setAgentsMdOpen] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);

  const [importSources, setImportSources] =
    useState<ReadonlyArray<HarnessLibraryImportSourcePreview> | null>(null);
  const [selectedImportKeys, setSelectedImportKeys] = useState<ReadonlySet<string>>(new Set());

  const [exportTarget, setExportTarget] = useState<HarnessExportTarget>("codex");
  const [exportSections, setExportSections] = useState<ReadonlySet<HarnessExportSection>>(
    () => new Set(ALL_EXPORT_SECTIONS),
  );
  const [exportPreview, setExportPreview] = useState<HarnessExportPreviewResult | null>(null);

  const snapshot: HarnessLibrarySnapshot | null = libraryQuery.data ?? null;

  const reportError = (title: string, result: { readonly _tag: string }) => {
    if (isAtomCommandInterrupted(result as never)) return;
    const error = squashAtomCommandFailure(result as never);
    Dialog.alert(title, errorDisplayMessage(error, m) ?? gt("Try again."));
  };

  if (libraryQuery.isPending && !snapshot) {
    return (
      <View className="py-4">
        <AppActivityIndicator />
      </View>
    );
  }

  const handleToggleMode = async (entry: HarnessModeEntry) => {
    if (!canWriteSettings) return;
    setBusyId(`mode:${entry.id}`);
    const result = await setModeEnabled({
      environmentId,
      input: {
        id: entry.id,
        enabled: !entry.effectiveEnabled,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") libraryQuery.refresh();
    else reportError(gt("Could not update mode"), result);
  };

  const handleRemoveMode = (entry: HarnessModeEntry) => {
    if (!canWriteSettings || entry.scope !== "user") return;
    Dialog.confirm({
      title: gt("Remove mode"),
      message: gt('Remove portable mode "{id}" from this host?', { id: entry.id }),
      confirmText: gt("Remove"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setBusyId(`mode:${entry.id}`);
          const result = await removeMode({
            environmentId,
            input: {
              id: entry.id,
              ...(workspaceRoot ? { workspaceRoot } : {}),
            },
          });
          setBusyId(null);
          if (result._tag === "Success") libraryQuery.refresh();
          else reportError(gt("Could not remove mode"), result);
        })();
      },
    });
  };

  const handleRevokeApprovalRule = (rule: HarnessApprovalRuleRecord) => {
    if (!canWriteSettings || rule.revokedAt !== null) return;
    Dialog.confirm({
      title: gt("Revoke approval grant"),
      message: gt(
        'Revoke "{summary}" on {host} and detach its active provider session so future turns re-check permissions?',
        { summary: rule.summary, host: targetHost },
      ),
      confirmText: gt("Revoke"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setBusyId(`approval:${rule.id}`);
          const result = await revokeApprovalRule({
            environmentId,
            input: { id: rule.id, detachThreadSession: true },
          });
          setBusyId(null);
          if (result._tag === "Success") {
            approvalRulesQuery.refresh();
            Dialog.alert(
              gt("Grant revoked"),
              result.value.sessionDetached
                ? gt("The grant was revoked and the thread session was detached.")
                : result.value.note,
            );
          } else {
            reportError(gt("Could not revoke grant"), result);
          }
        })();
      },
    });
  };

  const handleToggleSkill = async (entry: HarnessSkillEntry) => {
    if (!canWriteSettings) return;
    setBusyId(`skill:${entry.id}`);
    const result = await setSkillEnabled({
      environmentId,
      input: {
        id: entry.id,
        enabled: !entry.effectiveEnabled,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") libraryQuery.refresh();
    else reportError(gt("Could not update skill"), result);
  };

  const handleRemoveSkill = (entry: HarnessSkillEntry) => {
    if (!canWriteSettings || entry.scope !== "user") return;
    Dialog.confirm({
      title: gt("Remove skill"),
      message: gt('Remove portable skill "{id}" from this host?', { id: entry.id }),
      confirmText: gt("Remove"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setBusyId(`skill:${entry.id}`);
          const result = await removeSkill({
            environmentId,
            input: {
              id: entry.id,
              ...(workspaceRoot ? { workspaceRoot } : {}),
            },
          });
          setBusyId(null);
          if (result._tag === "Success") libraryQuery.refresh();
          else reportError(gt("Could not remove skill"), result);
        })();
      },
    });
  };

  const handleToggleRule = async (entry: HarnessRuleEntry) => {
    if (!canWriteSettings) return;
    setBusyId(`rule:${entry.id}`);
    const result = await setRuleEnabled({
      environmentId,
      input: {
        id: entry.id,
        enabled: !entry.effectiveEnabled,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") libraryQuery.refresh();
    else reportError(gt("Could not update rule"), result);
  };

  const handleRemoveRule = (entry: HarnessRuleEntry) => {
    if (!canWriteSettings) return;
    Dialog.confirm({
      title: gt("Remove rule"),
      message: gt('Remove portable rule "{id}" from this host?', { id: entry.id }),
      confirmText: gt("Remove"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setBusyId(`rule:${entry.id}`);
          const result = await removeRule({
            environmentId,
            input: {
              id: entry.id,
              ...(workspaceRoot ? { workspaceRoot } : {}),
            },
          });
          setBusyId(null);
          if (result._tag === "Success") libraryQuery.refresh();
          else reportError(gt("Could not remove rule"), result);
        })();
      },
    });
  };

  const handleSaveBudget = async () => {
    if (!canWriteSettings || !snapshot) return;
    const parsed = Number.parseInt(
      (budgetDraft ?? String(snapshot.maxSystemContextBytes)).trim(),
      10,
    );
    if (!Number.isFinite(parsed) || parsed < 1024 || parsed > 131_072) {
      Dialog.alert(
        gt("Invalid context budget"),
        gt("Enter a value between 1024 and 131072 bytes."),
      );
      return;
    }
    setBusyId("__budget__");
    const result = await updateSettings({
      environmentId,
      input: {
        maxSystemContextBytes: PositiveInt.make(parsed),
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") {
      setBudgetDraft(null);
      libraryQuery.refresh();
    } else {
      reportError(gt("Could not update budget"), result);
    }
  };

  const handleToggleCommand = async (entry: HarnessCommandEntry) => {
    if (!canWriteSettings) return;
    setBusyId(`cmd:${entry.id}`);
    const result = await setCommandEnabled({
      environmentId,
      input: {
        id: entry.id,
        enabled: !entry.effectiveEnabled,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") libraryQuery.refresh();
    else reportError(gt("Could not update command"), result);
  };

  const handleRemoveCommand = (entry: HarnessCommandEntry) => {
    if (!canWriteSettings) return;
    Dialog.confirm({
      title: gt("Remove command"),
      message: gt('Remove custom slash command "/{id}"?', { id: entry.id }),
      confirmText: gt("Remove"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setBusyId(`cmd:${entry.id}`);
          const result = await removeCommand({
            environmentId,
            input: {
              id: entry.id,
              ...(workspaceRoot ? { workspaceRoot } : {}),
            },
          });
          setBusyId(null);
          if (result._tag === "Success") libraryQuery.refresh();
          else reportError(gt("Could not remove command"), result);
        })();
      },
    });
  };

  const handleScanLibrary = async () => {
    setBusyId("__scan_lib__");
    const result = await scanLibraryImports({
      environmentId,
      input: workspaceRoot ? { workspaceRoot } : {},
    });
    setBusyId(null);
    if (result._tag === "Success") {
      const defaults = new Set<string>();
      for (const source of result.value.sources) {
        for (const candidate of source.candidates) {
          if (candidate.conflict === "none") {
            defaults.add(`${source.source}:${candidate.kind}:${candidate.id}`);
          }
        }
      }
      setImportSources(result.value.sources);
      setSelectedImportKeys(defaults);
    } else {
      reportError(gt("Scan failed"), result);
    }
  };

  const handleApplyLibraryImports = async () => {
    if (!importSources) return;
    const items: Array<{
      readonly source: HarnessMcpImportSource;
      readonly kind: HarnessLibraryImportCandidate["kind"];
      readonly id: typeof TrimmedNonEmptyString.Type;
      readonly expectedDigest: typeof TrimmedNonEmptyString.Type;
      readonly expectedExistingDigest?: typeof TrimmedNonEmptyString.Type | null;
    }> = [];
    for (const source of importSources) {
      for (const candidate of source.candidates) {
        const key = `${source.source}:${candidate.kind}:${candidate.id}`;
        if (selectedImportKeys.has(key)) {
          items.push({
            source: source.source,
            kind: candidate.kind,
            id: candidate.id,
            expectedDigest: TrimmedNonEmptyString.make(candidate.previewDigest),
            ...(candidate.existingDigest !== undefined
              ? {
                  expectedExistingDigest:
                    candidate.existingDigest === null
                      ? null
                      : TrimmedNonEmptyString.make(candidate.existingDigest),
                }
              : {}),
          });
        }
      }
    }
    if (items.length === 0) return;
    setBusyId("__import_lib__");
    const result = await applyLibraryImports({
      environmentId,
      input: {
        items,
        overwriteExisting: true,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") {
      setImportSources(null);
      libraryQuery.refresh();
      Dialog.alert(
        gt("Import complete"),
        gt("Imported {count} item(s).", { count: result.value.importedKeys.length }),
      );
    } else {
      reportError(gt("Import failed"), result);
    }
  };

  const handlePreviewExport = async () => {
    const sections = [...exportSections];
    if (sections.length === 0) {
      Dialog.alert(gt("Select sections"), gt("Choose at least one section to export."));
      return;
    }
    setBusyId("__preview_export__");
    const result = await previewExport({
      environmentId,
      input: {
        target: exportTarget,
        sections,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    setBusyId(null);
    if (result._tag === "Success") {
      setExportPreview(result.value);
    } else {
      reportError(gt("Export preview failed"), result);
    }
  };

  const handleApplyExport = () => {
    if (!exportPreview || !canWriteSettings || !canManageProviders) return;
    const writable = exportPreview.files.filter((file) => file.action !== "unchanged");
    const summaryLines = writable.map((file) => `• [${file.action}] ${file.targetPath}`).join("\n");
    confirmTwoStepExport({
      reviewTitle: gt("Review external CLI export (1/2)"),
      reviewMessage: gt(
        "Host: {host}\nTarget: {target}\n\nFiles to write:\n{files}\n\nContinue to final confirmation?",
        {
          host: targetHost,
          target: exportPreview.target,
          files: summaryLines || gt("(no file changes)"),
        },
      ),
      reviewConfirmText: gt("Continue"),
      finalTitle: gt("Confirm export write (2/2)"),
      finalMessage: gt(
        "Write {count} file(s) into {target} config on {host}? Existing unrelated keys are preserved.",
        {
          count: writable.length,
          target: exportPreview.target,
          host: targetHost,
        },
      ),
      finalConfirmText: gt("Write files"),
      onConfirmed: () => {
        void (async () => {
          setBusyId("__apply_export__");
          const result = await applyExport({
            environmentId,
            input: {
              target: exportPreview.target,
              sections: [...exportSections],
              planDigest: TrimmedNonEmptyString.make(exportPreview.planDigest),
              ...(workspaceRoot ? { workspaceRoot } : {}),
            },
          });
          setBusyId(null);
          if (result._tag === "Success") {
            setExportPreview(null);
            Dialog.alert(
              gt("Export complete"),
              gt("Wrote {count} file(s) to {target}.", {
                count: result.value.writtenPaths.length,
                target: result.value.target,
              }),
            );
          } else {
            reportError(gt("Export failed"), result);
          }
        })();
      },
    });
  };

  return (
    <View className="gap-3">
      {activeTab === "modes" ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={gt("Add mode")}
              tone="primary"
              disabled={!canWriteSettings}
              onPress={() => setModeModal({ mode: "create" })}
            />
            <Button label={gt("Refresh")} tone="secondary" onPress={() => libraryQuery.refresh()} />
          </View>

          {!snapshot || snapshot.modes.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>No portable modes found.</T>
            </Text>
          ) : (
            <View className="gap-3">
              {snapshot.modes.map((mode) => (
                <View
                  key={`${mode.scope}:${mode.id}`}
                  className="gap-2 rounded-xl border border-border bg-card-alt p-3"
                >
                  <View className="flex-row items-center justify-between gap-2">
                    <View className="flex-1">
                      <Text className="font-t3-semibold text-base text-foreground">
                        {mode.name}
                      </Text>
                      <Text className="text-xs text-foreground-muted">
                        {mode.id} · {mode.scope} · {mode.baseInteractionMode}
                        {mode.readonly ? ` · ${gt("read-only")}` : ""}
                        {mode.proposePlan ? ` · ${gt("propose-plan")}` : ""}
                      </Text>
                    </View>
                    <Switch
                      value={mode.effectiveEnabled}
                      disabled={!canWriteSettings || busyId === `mode:${mode.id}`}
                      onValueChange={() => void handleToggleMode(mode)}
                    />
                  </View>
                  {mode.description ? (
                    <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                      {mode.description}
                    </Text>
                  ) : null}
                  <View className="flex-row flex-wrap gap-2 pt-1">
                    <Button
                      label={mode.scope === "builtin" ? gt("Customize") : gt("Edit")}
                      tone="secondary"
                      disabled={!canWriteSettings}
                      onPress={() => setModeModal({ mode: "edit", entry: mode })}
                    />
                    {mode.scope === "user" ? (
                      <Button
                        label={gt("Remove")}
                        tone="secondary"
                        disabled={!canWriteSettings || busyId === `mode:${mode.id}`}
                        onPress={() => handleRemoveMode(mode)}
                      />
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          )}
        </>
      ) : null}

      {activeTab === "permissions" ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={gt("Refresh")}
              tone="secondary"
              onPress={() => approvalRulesQuery.refresh()}
            />
          </View>
          <Text className="text-xs text-foreground-muted">
            <T>
              Audited native allow-always and session approval grants recorded on this host.
              Revoking a grant marks it inactive and detaches the active provider session.
            </T>
          </Text>
          {approvalRulesQuery.isPending && !approvalRulesQuery.data ? (
            <View className="py-4">
              <AppActivityIndicator />
            </View>
          ) : !approvalRulesQuery.data || approvalRulesQuery.data.rules.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>No persistent or session approval grants recorded yet.</T>
            </Text>
          ) : (
            <View className="gap-3">
              {approvalRulesQuery.data.rules.map((rule) => (
                <View
                  key={rule.id}
                  className="gap-2 rounded-xl border border-border bg-card-alt p-3"
                >
                  <Text className="font-mono text-xs text-foreground">{rule.summary}</Text>
                  <Text className="text-xs text-foreground-muted">
                    {rule.scope} · {rule.requestKind} · {rule.providerInstanceId} ·{" "}
                    {rule.revokedAt ? gt("Revoked") : gt("Active")}
                  </Text>
                  <Text className="text-2xs text-foreground-muted">
                    {gt("Granted {timestamp}", { timestamp: rule.createdAt })}
                  </Text>
                  {rule.revokedAt === null ? (
                    <View className="flex-row pt-1">
                      <Button
                        label={gt("Revoke")}
                        tone="danger"
                        disabled={!canWriteSettings || busyId === `approval:${rule.id}`}
                        onPress={() => handleRevokeApprovalRule(rule)}
                      />
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          )}
        </>
      ) : null}

      {activeTab === "skills" ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={gt("Add skill")}
              tone="primary"
              disabled={!canWriteSettings}
              onPress={() => setSkillModal({ mode: "create" })}
            />
            <Button label={gt("Refresh")} tone="secondary" onPress={() => libraryQuery.refresh()} />
          </View>

          {!snapshot || snapshot.skills.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>
                No portable skills configured yet. Add one here or import from Codex, Claude,
                Cursor, or Antigravity.
              </T>
            </Text>
          ) : (
            <View className="gap-3">
              {snapshot.skills.map((skill) => (
                <View
                  key={`${skill.scope}:${skill.id}`}
                  className="gap-2 rounded-xl border border-border bg-card-alt p-3"
                >
                  <View className="flex-row items-center justify-between gap-2">
                    <View className="flex-1">
                      <Text className="font-t3-semibold text-base text-foreground">
                        {skill.name}
                      </Text>
                      <Text className="text-xs text-foreground-muted">
                        ${skill.id} · {skill.scope} · {skill.bytes} B
                      </Text>
                    </View>
                    <Switch
                      value={skill.effectiveEnabled}
                      disabled={!canWriteSettings || busyId === `skill:${skill.id}`}
                      onValueChange={() => void handleToggleSkill(skill)}
                    />
                  </View>
                  {skill.description ? (
                    <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                      {skill.description}
                    </Text>
                  ) : null}
                  {skill.scope === "user" ? (
                    <View className="flex-row flex-wrap gap-2 pt-1">
                      <Button
                        label={gt("Edit")}
                        tone="secondary"
                        disabled={!canWriteSettings}
                        onPress={() => setSkillModal({ mode: "edit", entry: skill })}
                      />
                      <Button
                        label={gt("Remove")}
                        tone="secondary"
                        disabled={!canWriteSettings || busyId === `skill:${skill.id}`}
                        onPress={() => handleRemoveSkill(skill)}
                      />
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          )}
        </>
      ) : null}

      {activeTab === "rules" ? (
        <>
          <View className="gap-2 rounded-xl border border-border bg-card-alt p-3">
            <View className="flex-row items-center justify-between gap-2">
              <View className="flex-1">
                <Text className="font-t3-semibold text-base text-foreground">
                  <T>Personal AGENTS.md</T>
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {snapshot?.userAgentsMd.exists
                    ? gt("{bytes} B configured", { bytes: snapshot.userAgentsMd.bytes })
                    : gt("Not created yet")}
                </Text>
              </View>
              <Button
                label={gt("Edit")}
                tone="secondary"
                disabled={!canWriteSettings}
                onPress={() => setAgentsMdOpen(true)}
              />
            </View>
            {snapshot?.projectAgentsMd ? (
              <Text className="text-xs text-foreground-muted">
                {gt("Project AGENTS.md detected ({bytes} B, read-only).", {
                  bytes: snapshot.projectAgentsMd.bytes,
                })}
              </Text>
            ) : null}
          </View>

          <View className="gap-2 rounded-xl border border-border bg-card-alt p-3">
            <Text className="font-t3-semibold text-sm text-foreground">
              <T>System context budget (bytes)</T>
            </Text>
            <Text className="text-xs text-foreground-muted">
              <T>
                Blocks exceeding this budget move to on-demand MCP reads instead of silently
                truncating.
              </T>
            </Text>
            <View className="flex-row items-center gap-2">
              <TextInput
                value={budgetDraft ?? String(snapshot?.maxSystemContextBytes ?? 12_000)}
                onChangeText={setBudgetDraft}
                keyboardType="number-pad"
                editable={canWriteSettings}
                className="flex-1 rounded-xl border border-border bg-card px-3 py-2 text-foreground"
              />
              <Button
                label={busyId === "__budget__" ? gt("Saving...") : gt("Save")}
                tone="secondary"
                disabled={!canWriteSettings || busyId === "__budget__"}
                onPress={() => void handleSaveBudget()}
              />
            </View>
          </View>

          <View className="flex-row flex-wrap gap-2">
            <Button
              label={gt("Add rule")}
              tone="primary"
              disabled={!canWriteSettings}
              onPress={() => setRuleModal({ mode: "create" })}
            />
            <Button label={gt("Refresh")} tone="secondary" onPress={() => libraryQuery.refresh()} />
          </View>

          {!snapshot || snapshot.rules.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>No portable rules configured yet.</T>
            </Text>
          ) : (
            <View className="gap-3">
              {snapshot.rules.map((rule) => (
                <View
                  key={rule.id}
                  className="gap-2 rounded-xl border border-border bg-card-alt p-3"
                >
                  <View className="flex-row items-center justify-between gap-2">
                    <View className="flex-1">
                      <Text className="font-t3-semibold text-base text-foreground">{rule.id}</Text>
                      <Text className="text-xs text-foreground-muted">
                        {rule.apply} · {rule.bytes} B
                        {rule.description ? ` · ${rule.description}` : ""}
                      </Text>
                    </View>
                    <Switch
                      value={rule.effectiveEnabled}
                      disabled={!canWriteSettings || busyId === `rule:${rule.id}`}
                      onValueChange={() => void handleToggleRule(rule)}
                    />
                  </View>
                  {rule.globs.length > 0 ? (
                    <Text className="font-mono text-xs text-foreground-muted" numberOfLines={2}>
                      {rule.globs.join(", ")}
                    </Text>
                  ) : null}
                  <View className="flex-row flex-wrap gap-2 pt-1">
                    <Button
                      label={gt("Edit")}
                      tone="secondary"
                      disabled={!canWriteSettings}
                      onPress={() => setRuleModal({ mode: "edit", entry: rule })}
                    />
                    <Button
                      label={gt("Remove")}
                      tone="secondary"
                      disabled={!canWriteSettings || busyId === `rule:${rule.id}`}
                      onPress={() => handleRemoveRule(rule)}
                    />
                  </View>
                </View>
              ))}
            </View>
          )}
        </>
      ) : null}

      {activeTab === "commands" ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={gt("Add command")}
              tone="primary"
              disabled={!canWriteSettings}
              onPress={() => setCommandModal({ mode: "create" })}
            />
            <Button label={gt("Refresh")} tone="secondary" onPress={() => libraryQuery.refresh()} />
          </View>

          {!snapshot || snapshot.commands.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>
                No portable custom commands yet. Commands expand on the server across every
                provider.
              </T>
            </Text>
          ) : (
            <View className="gap-3">
              {snapshot.commands.map((command) => (
                <View
                  key={command.id}
                  className="gap-2 rounded-xl border border-border bg-card-alt p-3"
                >
                  <View className="flex-row items-center justify-between gap-2">
                    <View className="flex-1">
                      <Text className="font-t3-semibold text-base text-foreground">
                        /{command.id}
                      </Text>
                      <Text className="text-xs text-foreground-muted">
                        {command.description ?? gt("Custom slash command")} · {command.bytes} B
                      </Text>
                    </View>
                    <Switch
                      value={command.effectiveEnabled}
                      disabled={!canWriteSettings || busyId === `cmd:${command.id}`}
                      onValueChange={() => void handleToggleCommand(command)}
                    />
                  </View>
                  <View className="flex-row flex-wrap gap-2 pt-1">
                    <Button
                      label={gt("Edit")}
                      tone="secondary"
                      disabled={!canWriteSettings}
                      onPress={() => setCommandModal({ mode: "edit", entry: command })}
                    />
                    <Button
                      label={gt("Remove")}
                      tone="secondary"
                      disabled={!canWriteSettings || busyId === `cmd:${command.id}`}
                      onPress={() => handleRemoveCommand(command)}
                    />
                  </View>
                </View>
              ))}
            </View>
          )}
        </>
      ) : null}

      {activeTab === "transfer" ? (
        <View className="gap-4">
          <View className="gap-2 rounded-xl border border-border bg-card-alt p-3">
            <Text className="font-t3-semibold text-base text-foreground">
              <T>Import Skills, Rules & Commands</T>
            </Text>
            <Text className="text-xs text-foreground-muted">
              <T>
                Read-only scan of Codex, Claude, Cursor, and Antigravity files on this host. Native
                files are never modified.
              </T>
            </Text>
            <View className="flex-row gap-2 pt-1">
              <Button
                label={busyId === "__scan_lib__" ? gt("Scanning...") : gt("Scan external CLIs")}
                tone="primary"
                disabled={!canWriteSettings || busyId === "__scan_lib__"}
                onPress={() => void handleScanLibrary()}
              />
            </View>
          </View>

          <View className="gap-3 rounded-xl border border-border bg-card-alt p-3">
            <Text className="font-t3-semibold text-base text-foreground">
              <T>Export Harness back to CLI</T>
            </Text>
            <Text className="text-xs text-foreground-muted">
              <T>
                Preview and write your portable harness back to native Codex, Claude, or Cursor
                configs without losing unrelated keys.
              </T>
            </Text>

            <View className="flex-row flex-wrap gap-2">
              {(["codex", "claude", "cursor"] as const).map((target) => (
                <Button
                  key={target}
                  label={target === "codex" ? "Codex" : target === "claude" ? "Claude" : "Cursor"}
                  tone={exportTarget === target ? "primary" : "secondary"}
                  onPress={() => {
                    setExportTarget(target);
                    setExportPreview(null);
                  }}
                />
              ))}
            </View>

            <View className="flex-row flex-wrap gap-2">
              {ALL_EXPORT_SECTIONS.map((section) => {
                const selected = exportSections.has(section);
                return (
                  <Button
                    key={section}
                    label={section}
                    tone={selected ? "primary" : "secondary"}
                    onPress={() => {
                      setExportPreview(null);
                      setExportSections((prev) => {
                        const next = new Set(prev);
                        if (next.has(section)) next.delete(section);
                        else next.add(section);
                        return next;
                      });
                    }}
                  />
                );
              })}
            </View>

            <Button
              label={busyId === "__preview_export__" ? gt("Previewing...") : gt("Preview export")}
              tone="secondary"
              disabled={!canWriteSettings || busyId === "__preview_export__"}
              onPress={() => void handlePreviewExport()}
            />

            {exportPreview ? (
              <View className="gap-2 rounded-xl border border-border bg-card p-3">
                <Text className="text-xs font-t3-medium text-foreground">
                  {gt("{count} file(s) in plan for {target}", {
                    count: exportPreview.files.length,
                    target: exportPreview.target,
                  })}
                </Text>
                {exportPreview.warnings.map((warning) => (
                  <Text key={warning} className="text-xs text-destructive">
                    {warning}
                  </Text>
                ))}
                {exportPreview.files.map((file) => (
                  <Text key={file.targetPath} className="font-mono text-xs text-foreground-muted">
                    [{file.action}] {file.targetPath}
                  </Text>
                ))}
                <Button
                  label={
                    busyId === "__apply_export__" ? gt("Exporting...") : gt("Review & apply export")
                  }
                  tone="primary"
                  disabled={
                    !canWriteSettings ||
                    !canManageProviders ||
                    busyId === "__apply_export__" ||
                    exportPreview.files.every((file) => file.action === "unchanged")
                  }
                  onPress={handleApplyExport}
                />
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      <Modal
        visible={skillModal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSkillModal(null)}
      >
        {skillModal ? (
          <SkillEditorBody
            key={skillModal.mode === "edit" ? skillModal.entry.id : "__new__"}
            initial={skillModal.mode === "edit" ? skillModal.entry : null}
            saving={busyId === "__save_skill__"}
            onCancel={() => setSkillModal(null)}
            onSave={async (draft) => {
              const decodedId = decodeSkillId(draft.id.trim());
              if (decodedId._tag === "None") {
                Dialog.alert(
                  gt("Invalid skill ID"),
                  gt("Use lowercase letters, numbers, and hyphens (e.g. code-review)."),
                );
                return;
              }
              setBusyId("__save_skill__");
              const result = await upsertSkill({
                environmentId,
                input: {
                  id: decodedId.value,
                  ...(draft.name.trim().length > 0
                    ? { name: TrimmedNonEmptyString.make(draft.name.trim()) }
                    : {}),
                  ...(draft.description.trim().length > 0
                    ? { description: draft.description.trim() }
                    : {}),
                  body: draft.body,
                  ...(workspaceRoot ? { workspaceRoot } : {}),
                },
              });
              setBusyId(null);
              if (result._tag === "Success") {
                setSkillModal(null);
                libraryQuery.refresh();
              } else {
                reportError(gt("Could not save skill"), result);
              }
            }}
          />
        ) : null}
      </Modal>

      <Modal
        visible={ruleModal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setRuleModal(null)}
      >
        {ruleModal ? (
          <RuleEditorBody
            key={ruleModal.mode === "edit" ? ruleModal.entry.id : "__new__"}
            initial={ruleModal.mode === "edit" ? ruleModal.entry : null}
            saving={busyId === "__save_rule__"}
            onCancel={() => setRuleModal(null)}
            onSave={async (draft) => {
              const decodedId = decodeRuleId(draft.id.trim());
              if (decodedId._tag === "None") {
                Dialog.alert(
                  gt("Invalid rule ID"),
                  gt("Use lowercase letters, numbers, and hyphens (e.g. typescript-strict)."),
                );
                return;
              }
              const globs = draft.globsText
                .split(/[\n,]/u)
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
                .map((s) => TrimmedNonEmptyString.make(s));
              setBusyId("__save_rule__");
              const result = await upsertRule({
                environmentId,
                input: {
                  id: decodedId.value,
                  ...(draft.description.trim().length > 0
                    ? { description: draft.description.trim() }
                    : {}),
                  apply: draft.apply,
                  ...(globs.length > 0 ? { globs } : {}),
                  body: draft.body,
                  ...(workspaceRoot ? { workspaceRoot } : {}),
                },
              });
              setBusyId(null);
              if (result._tag === "Success") {
                setRuleModal(null);
                libraryQuery.refresh();
              } else {
                reportError(gt("Could not save rule"), result);
              }
            }}
          />
        ) : null}
      </Modal>

      <Modal
        visible={commandModal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCommandModal(null)}
      >
        {commandModal ? (
          <CommandEditorBody
            key={commandModal.mode === "edit" ? commandModal.entry.id : "__new__"}
            initial={commandModal.mode === "edit" ? commandModal.entry : null}
            saving={busyId === "__save_cmd__"}
            onCancel={() => setCommandModal(null)}
            onSave={async (draft) => {
              const decodedId = decodeCommandId(draft.id.trim());
              if (decodedId._tag === "None") {
                Dialog.alert(
                  gt("Invalid command ID"),
                  gt("Use lowercase letters, numbers, and hyphens (avoid built-in names)."),
                );
                return;
              }
              setBusyId("__save_cmd__");
              const result = await upsertCommand({
                environmentId,
                input: {
                  id: decodedId.value,
                  ...(draft.description.trim().length > 0
                    ? { description: draft.description.trim() }
                    : {}),
                  ...(draft.argumentHint.trim().length > 0
                    ? { argumentHint: draft.argumentHint.trim() }
                    : {}),
                  body: draft.body,
                  ...(workspaceRoot ? { workspaceRoot } : {}),
                },
              });
              setBusyId(null);
              if (result._tag === "Success") {
                setCommandModal(null);
                libraryQuery.refresh();
              } else {
                reportError(gt("Could not save command"), result);
              }
            }}
          />
        ) : null}
      </Modal>

      <Modal
        visible={agentsMdOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAgentsMdOpen(false)}
      >
        {agentsMdOpen ? (
          <AgentsMdEditorBody
            key={snapshot?.userAgentsMd.contentDigest ?? "__empty__"}
            initialContent={snapshot?.userAgentsMd.body ?? ""}
            saving={busyId === "__save_agents__"}
            onCancel={() => setAgentsMdOpen(false)}
            onSave={async (body) => {
              setBusyId("__save_agents__");
              const result = await saveAgentsMd({
                environmentId,
                input: {
                  body,
                  ...(workspaceRoot ? { workspaceRoot } : {}),
                },
              });
              setBusyId(null);
              if (result._tag === "Success") {
                setAgentsMdOpen(false);
                libraryQuery.refresh();
              } else {
                reportError(gt("Could not save AGENTS.md"), result);
              }
            }}
          />
        ) : null}
      </Modal>

      <Modal
        visible={importSources !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setImportSources(null)}
      >
        <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
          <Text className="font-t3-bold text-xl text-foreground">
            <T>Import Skills, Rules & Commands</T>
          </Text>
          <Text className="font-mono text-xs text-foreground-muted">
            {gt("Target host: {host}", { host: targetHost })}
          </Text>
          {(importSources ?? []).every((source) => source.candidates.length === 0) ? (
            <Text className="text-sm text-foreground-muted">
              <T>No importable skills, rules, or commands found on this host.</T>
            </Text>
          ) : (
            (importSources ?? []).flatMap((source) =>
              source.candidates.map((candidate) => {
                const key = `${source.source}:${candidate.kind}:${candidate.id}`;
                const selected = selectedImportKeys.has(key);
                return (
                  <View
                    key={key}
                    className="flex-row items-center justify-between gap-3 rounded-xl border border-border bg-card-alt p-3"
                  >
                    <View className="flex-1">
                      <Text className="font-t3-semibold text-base text-foreground">
                        {candidate.id}
                      </Text>
                      <Text className="text-xs text-foreground-muted">
                        {source.source} · {candidate.kind} · {candidate.bytes} B
                        {candidate.conflict !== "none" ? ` · ${candidate.conflict}` : ""}
                      </Text>
                    </View>
                    <Switch
                      value={selected}
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
              }),
            )
          )}
          <View className="flex-row gap-2 pt-2">
            <Button
              label={
                busyId === "__import_lib__"
                  ? gt("Importing...")
                  : gt("Import selected ({count})", { count: selectedImportKeys.size })
              }
              tone="primary"
              disabled={selectedImportKeys.size === 0 || busyId === "__import_lib__"}
              onPress={() => void handleApplyLibraryImports()}
            />
            <Button label={gt("Close")} tone="secondary" onPress={() => setImportSources(null)} />
          </View>
        </ScrollView>
      </Modal>

      <Modal
        visible={modeModal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setModeModal(null)}
      >
        {modeModal ? (
          <ModeEditorBody
            initial={modeModal.mode === "edit" ? modeModal.entry : null}
            saving={busyId === "__mode_save__"}
            onCancel={() => setModeModal(null)}
            onSave={async (draft) => {
              const parsedId = decodeModeId(draft.id.trim());
              if (parsedId._tag === "None") {
                Dialog.alert(
                  gt("Invalid mode ID"),
                  gt("Use letters, digits, underscores, or hyphens."),
                );
                return;
              }
              setBusyId("__mode_save__");
              const result = await upsertMode({
                environmentId,
                input: {
                  id: parsedId.value,
                  ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
                  ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
                  baseInteractionMode: draft.baseInteractionMode,
                  readonly: draft.readonly,
                  proposePlan: draft.proposePlan,
                  body: draft.body,
                  ...(workspaceRoot ? { workspaceRoot } : {}),
                },
              });
              setBusyId(null);
              if (result._tag === "Success") {
                setModeModal(null);
                libraryQuery.refresh();
              } else {
                reportError(gt("Could not save mode"), result);
              }
            }}
          />
        ) : null}
      </Modal>
    </View>
  );
}

function SkillEditorBody({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  readonly initial: HarnessSkillEntry | null;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly body: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");

  return (
    <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
      <Text className="font-t3-bold text-xl text-foreground">
        {initial ? (
          <T>
            Edit skill <Var>{initial.id}</Var>
          </T>
        ) : (
          <T>New portable skill</T>
        )}
      </Text>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Skill ID</T>
        </Text>
        <TextInput
          value={id}
          onChangeText={setId}
          editable={initial === null}
          placeholder="code-review"
          autoCapitalize="none"
          autoCorrect={false}
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Display name</T>
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="code-review"
          autoCapitalize="none"
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Description</T>
        </Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder={gt("When should an agent use this skill?")}
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>SKILL.md instructions</T>
        </Text>
        <TextInput
          value={body}
          onChangeText={setBody}
          multiline
          textAlignVertical="top"
          className="min-h-40 rounded-xl border border-border bg-card px-3 py-2.5 font-mono text-xs text-foreground"
        />
      </View>
      <View className="flex-row gap-2 pt-2">
        <Button
          label={saving ? gt("Saving...") : gt("Save")}
          tone="primary"
          disabled={saving}
          onPress={() => void onSave({ id, name, description, body })}
        />
        <Button label={gt("Cancel")} tone="secondary" onPress={onCancel} />
      </View>
    </ScrollView>
  );
}

function RuleEditorBody({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  readonly initial: HarnessRuleEntry | null;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: {
    readonly id: string;
    readonly description: string;
    readonly apply: HarnessRuleApplyMode;
    readonly globsText: string;
    readonly body: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [id, setId] = useState(initial?.id ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [apply, setApply] = useState<HarnessRuleApplyMode>(initial?.apply ?? "always");
  const [globsText, setGlobsText] = useState((initial?.globs ?? []).join(", "));
  const [body, setBody] = useState(initial?.body ?? "");

  return (
    <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
      <Text className="font-t3-bold text-xl text-foreground">
        {initial ? (
          <T>
            Edit rule <Var>{initial.id}</Var>
          </T>
        ) : (
          <T>New portable rule</T>
        )}
      </Text>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Rule ID</T>
        </Text>
        <TextInput
          value={id}
          onChangeText={setId}
          editable={initial === null}
          placeholder="typescript-strict"
          autoCapitalize="none"
          autoCorrect={false}
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Description</T>
        </Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder={gt("Optional human-readable summary")}
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="flex-row gap-2">
        {(["always", "glob", "manual"] as const).map((mode) => (
          <Button
            key={mode}
            label={mode}
            tone={apply === mode ? "primary" : "secondary"}
            onPress={() => setApply(mode)}
          />
        ))}
      </View>
      {apply === "glob" ? (
        <View className="gap-1.5">
          <Text className="text-sm font-t3-medium text-foreground">
            <T>Glob patterns (comma or newline separated)</T>
          </Text>
          <TextInput
            value={globsText}
            onChangeText={setGlobsText}
            placeholder="**/*.ts, **/*.tsx"
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-xl border border-border bg-card px-3 py-2.5 font-mono text-xs text-foreground"
          />
        </View>
      ) : null}
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Rule Markdown</T>
        </Text>
        <TextInput
          value={body}
          onChangeText={setBody}
          multiline
          textAlignVertical="top"
          className="min-h-40 rounded-xl border border-border bg-card px-3 py-2.5 font-mono text-xs text-foreground"
        />
      </View>
      <View className="flex-row gap-2 pt-2">
        <Button
          label={saving ? gt("Saving...") : gt("Save")}
          tone="primary"
          disabled={saving}
          onPress={() => void onSave({ id, description, apply, globsText, body })}
        />
        <Button label={gt("Cancel")} tone="secondary" onPress={onCancel} />
      </View>
    </ScrollView>
  );
}

function CommandEditorBody({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  readonly initial: HarnessCommandEntry | null;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: {
    readonly id: string;
    readonly description: string;
    readonly argumentHint: string;
    readonly body: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [id, setId] = useState(initial?.id ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [argumentHint, setArgumentHint] = useState(initial?.argumentHint ?? "");
  const [body, setBody] = useState(initial?.body ?? "");

  return (
    <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
      <Text className="font-t3-bold text-xl text-foreground">
        {initial ? (
          <T>
            Edit command /<Var>{initial.id}</Var>
          </T>
        ) : (
          <T>New custom command</T>
        )}
      </Text>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Command ID (without /)</T>
        </Text>
        <TextInput
          value={id}
          onChangeText={setId}
          editable={initial === null}
          placeholder="review-pr"
          autoCapitalize="none"
          autoCorrect={false}
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Description</T>
        </Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder={gt("Short description shown in / menu")}
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Argument hint</T>
        </Text>
        <TextInput
          value={argumentHint}
          onChangeText={setArgumentHint}
          placeholder="<target-branch>"
          autoCapitalize="none"
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Prompt template ($ARGUMENTS, $1..$9)</T>
        </Text>
        <TextInput
          value={body}
          onChangeText={setBody}
          multiline
          textAlignVertical="top"
          className="min-h-40 rounded-xl border border-border bg-card px-3 py-2.5 font-mono text-xs text-foreground"
        />
      </View>
      <View className="flex-row gap-2 pt-2">
        <Button
          label={saving ? gt("Saving...") : gt("Save")}
          tone="primary"
          disabled={saving}
          onPress={() => void onSave({ id, description, argumentHint, body })}
        />
        <Button label={gt("Cancel")} tone="secondary" onPress={onCancel} />
      </View>
    </ScrollView>
  );
}

function AgentsMdEditorBody({
  initialContent,
  saving,
  onCancel,
  onSave,
}: {
  readonly initialContent: string;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (content: string) => Promise<void>;
}) {
  const gt = useGT();
  const [content, setContent] = useState(initialContent);

  return (
    <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
      <Text className="font-t3-bold text-xl text-foreground">
        <T>Personal AGENTS.md</T>
      </Text>
      <Text className="text-xs text-foreground-muted">
        <T>Stored in ~/.t3/harness/AGENTS.md and projected across every provider.</T>
      </Text>
      <TextInput
        value={content}
        onChangeText={setContent}
        multiline
        textAlignVertical="top"
        className="min-h-60 rounded-xl border border-border bg-card px-3 py-2.5 font-mono text-xs text-foreground"
      />
      <View className="flex-row gap-2 pt-2">
        <Button
          label={saving ? gt("Saving...") : gt("Save")}
          tone="primary"
          disabled={saving}
          onPress={() => void onSave(content)}
        />
        <Button label={gt("Cancel")} tone="secondary" onPress={onCancel} />
      </View>
    </ScrollView>
  );
}

function ModeEditorBody({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  readonly initial: HarnessModeEntry | null;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly baseInteractionMode: ProviderInteractionMode;
    readonly readonly: boolean;
    readonly proposePlan: boolean;
    readonly body: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [baseInteractionMode, setBaseInteractionMode] = useState<ProviderInteractionMode>(
    initial?.baseInteractionMode ?? "default",
  );
  const [readonlyMode, setReadonlyMode] = useState(initial?.readonly ?? false);
  const [proposePlan, setProposePlan] = useState(initial?.proposePlan ?? false);
  const [body, setBody] = useState(initial?.body ?? "");

  return (
    <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
      <Text className="font-t3-bold text-xl text-foreground">
        {initial ? <T>Edit Portable Mode</T> : <T>New Portable Mode</T>}
      </Text>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Mode ID</T>
        </Text>
        <TextInput
          value={id}
          editable={initial === null}
          onChangeText={setId}
          placeholder="security-audit"
          autoCapitalize="none"
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Display name</T>
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={gt("Security Audit")}
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Description</T>
        </Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder={gt("Short summary shown in mode switcher")}
          className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
        />
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Base plan interaction mode</T>
        </Text>
        <Switch
          value={baseInteractionMode === "plan"}
          onValueChange={(enabled) => setBaseInteractionMode(enabled ? "plan" : "default")}
        />
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Read-only mode</T>
        </Text>
        <Switch value={readonlyMode} onValueChange={setReadonlyMode} />
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Emit proposed plan cards</T>
        </Text>
        <Switch value={proposePlan} onValueChange={setProposePlan} />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Instructions (Markdown)</T>
        </Text>
        <TextInput
          value={body}
          onChangeText={setBody}
          multiline
          textAlignVertical="top"
          className="min-h-40 rounded-xl border border-border bg-card px-3 py-2.5 font-mono text-xs text-foreground"
        />
      </View>
      <View className="flex-row gap-2 pt-2">
        <Button
          label={saving ? gt("Saving...") : gt("Save")}
          tone="primary"
          disabled={saving}
          onPress={() =>
            void onSave({
              id,
              name,
              description,
              baseInteractionMode,
              readonly: readonlyMode,
              proposePlan,
              body,
            })
          }
        />
        <Button label={gt("Cancel")} tone="secondary" onPress={onCancel} />
      </View>
    </ScrollView>
  );
}
