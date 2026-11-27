import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
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
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import {
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";

import { SkillBundleInspector } from "../harness/SkillBundleInspector";
import { useEnvironmentQuery } from "../../state/query";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
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
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const decodeSkillId = Schema.decodeUnknownOption(HarnessSkillId);
const decodeRuleId = Schema.decodeUnknownOption(HarnessRuleId);
const decodeCommandId = Schema.decodeUnknownOption(HarnessCommandId);
const decodeModeId = Schema.decodeUnknownOption(HarnessModeId);

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}

export type HarnessPanelTab =
  | "mcp"
  | "modes"
  | "skills"
  | "rules"
  | "commands"
  | "plugins"
  | "hooks"
  | "memory"
  | "sync"
  | "approvals"
  | "transfer";

export function HarnessLibraryPanels({
  activeTab,
  environmentId,
  workspaceRoot,
}: {
  readonly activeTab: Exclude<HarnessPanelTab, "mcp" | "plugins" | "hooks" | "memory" | "sync">;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | undefined;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canRevokeApprovalRules = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

  const queryAtom = harnessEnvironment.libraryQuery({
    environmentId,
    input: workspaceRoot ? { workspaceRoot } : {},
  });
  const queryResult = useAtomValue(queryAtom);
  const [overrideSnapshot, setOverrideSnapshot] = useState<HarnessLibrarySnapshot | null>(null);
  const snapshot =
    overrideSnapshot ??
    AsyncResult.getOrElse(queryResult, () => null as HarnessLibrarySnapshot | null);

  const fetchSnapshot = useAtomCommand(harnessEnvironment.librarySnapshot, {
    reportFailure: false,
  });
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
  const upsertMode = useAtomCommand(harnessEnvironment.upsertMode, { reportFailure: false });
  const removeMode = useAtomCommand(harnessEnvironment.removeMode, { reportFailure: false });
  const setModeEnabled = useAtomCommand(harnessEnvironment.setModeEnabled, {
    reportFailure: false,
  });
  const listApprovalRules = useAtomCommand(harnessEnvironment.listApprovalRules, {
    reportFailure: false,
  });
  const revokeApprovalRule = useAtomCommand(harnessEnvironment.revokeApprovalRule, {
    reportFailure: false,
  });
  const approvalRulesQueryAtom = harnessEnvironment.approvalRulesQuery({
    environmentId,
    input: { includeRevoked: true },
  });
  const approvalRulesQueryResult = useAtomValue(approvalRulesQueryAtom);
  const [overrideApprovalRules, setOverrideApprovalRules] =
    useState<ReadonlyArray<HarnessApprovalRuleRecord> | null>(null);
  const approvalRules =
    overrideApprovalRules ??
    AsyncResult.getOrElse(
      approvalRulesQueryResult,
      () => null as { readonly rules: ReadonlyArray<HarnessApprovalRuleRecord> } | null,
    )?.rules ??
    [];
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

  const [busy, setBusy] = useState(false);
  const [agentsDraft, setAgentsDraft] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);

  const [modeModal, setModeModal] = useState<
    null | { readonly mode: "add" } | { readonly mode: "edit"; readonly item: HarnessModeEntry }
  >(null);
  const [inspected, setInspected] = useState<string | null>(null);
  const [skillModal, setSkillModal] = useState<
    null | { readonly mode: "add" } | { readonly mode: "edit"; readonly item: HarnessSkillEntry }
  >(null);
  const [ruleModal, setRuleModal] = useState<
    null | { readonly mode: "add" } | { readonly mode: "edit"; readonly item: HarnessRuleEntry }
  >(null);
  const [commandModal, setCommandModal] = useState<
    null | { readonly mode: "add" } | { readonly mode: "edit"; readonly item: HarnessCommandEntry }
  >(null);

  const [importSources, setImportSources] =
    useState<ReadonlyArray<HarnessLibraryImportSourcePreview> | null>(null);
  const [selectedImportKeys, setSelectedImportKeys] = useState<ReadonlySet<string>>(new Set());
  const [overwriteImports, setOverwriteImports] = useState(false);

  const [exportTarget, setExportTarget] = useState<HarnessExportTarget>("codex");
  const [exportSections, setExportSections] = useState<ReadonlySet<HarnessExportSection>>(
    new Set(["mcp", "skills", "rules", "commands"]),
  );
  const [exportPreview, setExportPreview] = useState<HarnessExportPreviewResult | null>(null);

  const refresh = async () => {
    setBusy(true);
    const res = await fetchSnapshot({
      environmentId,
      input: workspaceRoot ? { workspaceRoot } : {},
    });
    setBusy(false);
    if (res._tag === "Success") {
      setOverrideSnapshot(res.value);
    } else if (!isAtomCommandInterrupted(res)) {
      toastManager.add({
        type: "error",
        title: gt("Failed to refresh Harness library"),
        description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
      });
    }
  };

  if (snapshot === null) {
    return (
      <SettingsSection title={gt("Harness")}>
        <p className="px-4 py-3 text-sm text-muted-foreground">
          <T>Loading portable Harness library...</T>
        </p>
      </SettingsSection>
    );
  }

  const wsInput = workspaceRoot ? { workspaceRoot } : {};
  const policyBlocked = !snapshot.managedPolicyAllowsHarness;
  const editable = canWriteSettings && !policyBlocked;

  if (activeTab === "modes") {
    return (
      <>
        <SettingsSection {...setting("harness-modes")}>
          <SettingsRow
            title={<T>Declarative Modes</T>}
            description={
              <T>
                Portable agent modes stored in <Var>{snapshot.harnessDir}</Var>/modes/*.md. Built-in
                modes (Build, Plan, Review, Creator) can be customized without losing provider
                continuity.
              </T>
            }
          >
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
                <RefreshCwIcon className="size-3.5" aria-hidden />
                <T>Refresh</T>
              </Button>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  <T>Manual configuration</T>
                </summary>
                <Button
                  size="sm"
                  disabled={!editable || busy}
                  onClick={() => setModeModal({ mode: "add" })}
                >
                  <PlusIcon className="size-3.5" aria-hidden />
                  <T>Add Mode</T>
                </Button>
              </details>
            </div>
          </SettingsRow>

          <div className="divide-y divide-border/60">
            {snapshot.modes.map((mode) => (
              <div
                key={`${mode.scope}:${mode.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-sm font-medium text-foreground">
                      {mode.name}
                    </span>
                    <Badge variant="outline">{mode.id}</Badge>
                    <Badge variant="secondary">{mode.scope}</Badge>
                    {mode.overriddenBuiltin ? (
                      <Badge variant="outline">{gt("Overridden built-in")}</Badge>
                    ) : null}
                    {mode.readonly ? <Badge variant="warning">{gt("Read-only")}</Badge> : null}
                    {mode.proposePlan ? <Badge variant="info">{gt("Propose plan")}</Badge> : null}
                  </div>
                  {mode.description ? (
                    <p className="text-xs text-muted-foreground">{mode.description}</p>
                  ) : null}
                  <ContextSource body={mode.body} />
                  <div className="flex flex-wrap gap-1">
                    {mode.allowedMcpServers?.map((id) => (
                      <Badge key={id} variant="secondary">
                        {gt("MCP · {id}", { id })}
                      </Badge>
                    ))}
                    {mode.includedRules?.map((id) => (
                      <Badge key={id} variant="outline">
                        {gt("Rule · {id}", { id })}
                      </Badge>
                    ))}
                    {mode.includedSkills?.map((id) => (
                      <Badge key={id} variant="outline">
                        {gt("Skill · {id}", { id })}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    aria-label={gt("Toggle {id}", { id: mode.id })}
                    checked={mode.enabled}
                    disabled={!editable || busy || mode.id === "build"}
                    onCheckedChange={async (checked) => {
                      setBusy(true);
                      const res = await setModeEnabled({
                        environmentId,
                        input: { id: mode.id, enabled: checked, ...wsInput },
                      });
                      setBusy(false);
                      if (res._tag === "Success") setOverrideSnapshot(res.value);
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!editable || busy}
                    onClick={() => setModeModal({ mode: "edit", item: mode })}
                  >
                    <PencilIcon className="size-3.5" aria-hidden />
                  </Button>
                  {mode.scope === "user" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!editable || busy}
                      aria-label={
                        mode.overriddenBuiltin ? gt("Restore built-in") : gt("Remove mode")
                      }
                      onClick={async () => {
                        setBusy(true);
                        const res = await removeMode({
                          environmentId,
                          input: { id: mode.id, ...wsInput },
                        });
                        setBusy(false);
                        if (res._tag === "Success") {
                          setOverrideSnapshot(res.value);
                          toastManager.add({
                            type: "success",
                            title: mode.overriddenBuiltin
                              ? gt("Built-in mode restored")
                              : gt("Mode removed"),
                          });
                        } else if (!isAtomCommandInterrupted(res)) {
                          toastManager.add({
                            type: "error",
                            title: gt("Could not remove mode"),
                            description: formatError(
                              squashAtomCommandFailure(res),
                              gt("Try again."),
                            ),
                          });
                        }
                      }}
                    >
                      {mode.overriddenBuiltin ? (
                        <T>Restore built-in</T>
                      ) : (
                        <Trash2Icon className="size-3.5" aria-hidden />
                      )}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>

        <ModeEditorDialog
          environmentId={environmentId}
          workspaceRoot={workspaceRoot}
          rules={snapshot.rules.map((rule) => rule.id)}
          skills={snapshot.skills.map((skill) => skill.id)}
          state={modeModal}
          onClose={() => setModeModal(null)}
          onSave={async (payload) => {
            const editedMode = modeModal?.mode === "edit" ? modeModal.item : null;
            setBusy(true);
            const res = await upsertMode({
              environmentId,
              input: {
                ...payload,
                ...wsInput,
                ...(editedMode?.defaultModel === undefined
                  ? {}
                  : { defaultModel: editedMode.defaultModel }),
                ...(editedMode?.disabledMcpServers === undefined
                  ? {}
                  : { disabledMcpServers: editedMode.disabledMcpServers }),
                ...(editedMode?.scope === "builtin" || editedMode?.overriddenBuiltin
                  ? { overrideBuiltin: true }
                  : {}),
              },
            });
            setBusy(false);
            if (res._tag === "Success") {
              setOverrideSnapshot(res.value);
              setModeModal(null);
              toastManager.add({ type: "success", title: gt("Mode saved") });
            } else if (!isAtomCommandInterrupted(res)) {
              toastManager.add({
                type: "error",
                title: gt("Failed to save mode"),
                description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
              });
            }
          }}
        />
      </>
    );
  }

  if (activeTab === "approvals") {
    const refreshApprovals = async () => {
      setBusy(true);
      const res = await listApprovalRules({
        environmentId,
        input: { includeRevoked: true },
      });
      setBusy(false);
      if (res._tag === "Success") {
        setOverrideApprovalRules(res.value.rules);
      }
    };

    return (
      <SettingsSection {...setting("harness-approvals")}>
        <SettingsRow
          title={<T>Approval Grants & Audit Ledger</T>}
          description={
            <T>
              Gateway grants control future MCP calls. Revoking a provider audit grant can detach
              its live session.
            </T>
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void refreshApprovals()}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            <T>Refresh</T>
          </Button>
        </SettingsRow>

        {approvalRules.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            <T>No persistent or session approval grants recorded yet.</T>
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {approvalRules.map((rule) => (
              <div
                key={rule.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ShieldCheckIcon className="size-3.5 text-muted-foreground" aria-hidden />
                    <span className="font-mono text-xs font-medium text-foreground">
                      {rule.summary}
                    </span>
                    <Badge variant="outline">{rule.scope}</Badge>
                    <Badge variant="outline">
                      {rule.source === "gateway"
                        ? gt("Gateway (enforced)")
                        : gt("Provider (audit)")}
                    </Badge>
                    <Badge variant="secondary">{rule.requestKind}</Badge>
                    {rule.providerInstanceId ? (
                      <Badge variant="outline">{rule.providerInstanceId}</Badge>
                    ) : null}
                    {rule.revokedAt ? (
                      <Badge variant="error">{gt("Revoked")}</Badge>
                    ) : (
                      <Badge variant="success">{gt("Active")}</Badge>
                    )}
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    {gt("Granted {timestamp}", { timestamp: rule.createdAt })}
                    {rule.revokedAt
                      ? ` · ${gt("Revoked {timestamp}", { timestamp: rule.revokedAt })}`
                      : ""}
                  </p>
                </div>
                {!rule.revokedAt ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canRevokeApprovalRules || busy}
                    onClick={async () => {
                      setBusy(true);
                      const res = await revokeApprovalRule({
                        environmentId,
                        input: { id: rule.id, detachThreadSession: rule.source !== "gateway" },
                      });
                      setBusy(false);
                      if (res._tag === "Success") {
                        setOverrideApprovalRules(
                          approvalRules.map((item) =>
                            item.id === res.value.rule.id ? res.value.rule : item,
                          ),
                        );
                        toastManager.add({
                          type: "success",
                          title: res.value.sessionDetached
                            ? gt("Grant revoked and thread session detached")
                            : gt("Grant revoked"),
                        });
                      } else if (!isAtomCommandInterrupted(res)) {
                        toastManager.add({
                          type: "error",
                          title: gt("Failed to revoke grant"),
                          description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
                        });
                      }
                    }}
                  >
                    <T>Revoke</T>
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    );
  }

  if (activeTab === "skills") {
    return (
      <>
        <SettingsSection
          {...setting("harness-skills")}
          headerAction={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
                <RefreshCwIcon className="size-3.5" aria-hidden />
                <T>Refresh</T>
              </Button>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  <T>Manual configuration</T>
                </summary>
                <Button
                  size="sm"
                  disabled={!editable || busy}
                  onClick={() => setSkillModal({ mode: "add" })}
                >
                  <PlusIcon className="size-3.5" aria-hidden />
                  <T>Add Skill</T>
                </Button>
              </details>
            </div>
          }
        >
          {snapshot.skills.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              <T>
                No portable skills yet. Create one here or import existing skills from Codex,
                Claude, Cursor, or Antigravity.
              </T>
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {snapshot.skills.map((skill) => (
                <div
                  key={`${skill.scope}:${skill.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-medium text-foreground">
                        {skill.name}
                      </span>
                      <Badge variant="outline">{skill.scope}</Badge>
                      {skill.overriddenByProject ? (
                        <Badge variant="secondary">{gt("Overridden by project")}</Badge>
                      ) : null}
                      {skill.userInvocationOnly ? (
                        <Badge variant="secondary">{gt("Manual only")}</Badge>
                      ) : null}
                    </div>
                    {skill.shortDescription || skill.description ? (
                      <p className="text-xs text-muted-foreground">
                        {skill.shortDescription ?? skill.description}
                      </p>
                    ) : null}
                    <p className="truncate font-mono text-xs text-muted-foreground/80">
                      {skill.sourcePath}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label={gt("Toggle {id}", { id: skill.id })}
                      checked={skill.enabled}
                      disabled={!editable || busy}
                      onCheckedChange={async (checked) => {
                        setBusy(true);
                        const res = await setSkillEnabled({
                          environmentId,
                          input: { id: skill.id, enabled: checked, ...wsInput },
                        });
                        setBusy(false);
                        if (res._tag === "Success") setOverrideSnapshot(res.value);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      aria-expanded={inspected === skill.sourcePath}
                      onClick={() =>
                        setInspected(inspected === skill.sourcePath ? null : skill.sourcePath)
                      }
                    >
                      <T>Inspect files</T>
                    </Button>
                    {skill.scope === "user" ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!editable || busy}
                          aria-label={gt("Edit {id}", { id: skill.id })}
                          onClick={() => setSkillModal({ mode: "edit", item: skill })}
                        >
                          <PencilIcon className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!editable || busy}
                          aria-label={gt("Delete {id}", { id: skill.id })}
                          onClick={async () => {
                            setBusy(true);
                            const res = await removeSkill({
                              environmentId,
                              input: { id: skill.id, ...wsInput },
                            });
                            setBusy(false);
                            if (res._tag === "Success") {
                              setOverrideSnapshot(res.value);
                              toastManager.add({ type: "success", title: gt("Skill removed") });
                            }
                          }}
                        >
                          <Trash2Icon className="size-3.5" aria-hidden />
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {inspected === skill.sourcePath ? (
                    <SkillBundleInspector
                      environmentId={environmentId}
                      workspaceRoot={workspaceRoot}
                      skill={skill}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </SettingsSection>

        <SkillEditorDialog
          state={skillModal}
          onClose={() => setSkillModal(null)}
          onSave={async (payload) => {
            setBusy(true);
            const res = await upsertSkill({
              environmentId,
              input: { ...payload, ...wsInput },
            });
            setBusy(false);
            if (res._tag === "Success") {
              setOverrideSnapshot(res.value);
              setSkillModal(null);
              toastManager.add({ type: "success", title: gt("Skill saved") });
            } else if (!isAtomCommandInterrupted(res)) {
              toastManager.add({
                type: "error",
                title: gt("Could not save skill"),
                description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
              });
            }
          }}
        />
      </>
    );
  }

  if (activeTab === "rules") {
    const currentAgents = agentsDraft ?? snapshot.userAgentsMd.body;
    const contextBytes =
      (agentsDraft === null
        ? snapshot.userAgentsMd.bytes
        : new TextEncoder().encode(currentAgents).length) +
      (snapshot.projectAgentsMd?.bytes ?? 0) +
      snapshot.rules.reduce(
        (bytes, rule) =>
          bytes + (rule.effectiveEnabled && rule.apply === "always" ? rule.bytes : 0),
        0,
      );
    const currentBudget = budgetDraft ?? String(snapshot.maxSystemContextBytes);
    return (
      <>
        <SettingsSection title={gt("AGENTS.md")}>
          <div className="grid gap-2 p-4 text-sm">
            <label>
              {gt("Always-on source text · {used} bytes against a {limit}-byte budget", {
                used: contextBytes,
                limit: snapshot.maxSystemContextBytes,
              })}
              <progress
                className="block w-full"
                value={contextBytes}
                max={snapshot.maxSystemContextBytes}
              />
            </label>
            {snapshot.userAgentsMd.body ? (
              <pre className="whitespace-pre-wrap">{snapshot.userAgentsMd.body}</pre>
            ) : null}
            {snapshot.projectAgentsMd?.exists ? (
              <details>
                <summary>{snapshot.projectAgentsMd.path}</summary>
                <pre className="whitespace-pre-wrap">{snapshot.projectAgentsMd.body}</pre>
              </details>
            ) : null}
          </div>
          <details>
            <summary className="cursor-pointer px-4 py-2 text-sm">
              <T>Edit personal AGENTS.md and budget</T>
            </summary>
            <SettingsRow
              title={<T>Personal AGENTS.md</T>}
              description={
                <T>
                  Always-on personal coding preferences projected across every CLI without silent
                  truncation. Oversized blocks degrade cleanly to on-demand tool reads.
                </T>
              }
            >
              <Button
                size="sm"
                disabled={!editable || busy || agentsDraft === null}
                onClick={async () => {
                  setBusy(true);
                  const res = await saveAgentsMd({
                    environmentId,
                    input: { body: currentAgents, ...wsInput },
                  });
                  setBusy(false);
                  if (res._tag === "Success") {
                    setOverrideSnapshot(res.value);
                    setAgentsDraft(null);
                    toastManager.add({ type: "success", title: gt("Personal AGENTS.md saved") });
                  } else if (!isAtomCommandInterrupted(res)) {
                    toastManager.add({
                      type: "error",
                      title: gt("Could not save AGENTS.md"),
                      description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
                    });
                  }
                }}
              >
                <SaveIcon className="size-3.5" aria-hidden />
                <T>Save AGENTS.md</T>
              </Button>
            </SettingsRow>
            <div className="space-y-3 px-4 pb-4">
              <Textarea
                rows={6}
                disabled={!editable || busy}
                value={currentAgents}
                placeholder={gt("Write personal cross-CLI rules in Markdown...")}
                onChange={(event) => setAgentsDraft(event.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{gt("Inline context budget (bytes):")}</span>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    aria-label={gt("Context budget in bytes")}
                    disabled={!editable || busy}
                    value={currentBudget}
                    onChange={(event) => setBudgetDraft(event.target.value)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!editable || busy || budgetDraft === null}
                    onClick={async () => {
                      const parsed = Number.parseInt(currentBudget, 10);
                      if (!Number.isFinite(parsed) || parsed < 1024) {
                        toastManager.add({
                          type: "error",
                          title: gt("Budget must be at least 1024 bytes"),
                        });
                        return;
                      }
                      setBusy(true);
                      const res = await updateSettings({
                        environmentId,
                        input: { maxSystemContextBytes: PositiveInt.make(parsed), ...wsInput },
                      });
                      setBusy(false);
                      if (res._tag === "Success") {
                        setOverrideSnapshot(res.value);
                        setBudgetDraft(null);
                        toastManager.add({ type: "success", title: gt("Context budget updated") });
                      }
                    }}
                  >
                    <T>Update budget</T>
                  </Button>
                </div>
              </div>
            </div>
          </details>
        </SettingsSection>

        <SettingsSection {...setting("harness-rules")}>
          <SettingsRow
            title={<T>Conditional Rules (rules/*.md)</T>}
            description={
              <T>
                Apply rules always, conditionally by file glob, or on demand via harness_rule_read.
              </T>
            }
          >
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                <T>Manual configuration</T>
              </summary>
              <Button
                size="sm"
                disabled={!editable || busy}
                onClick={() => setRuleModal({ mode: "add" })}
              >
                <PlusIcon className="size-3.5" aria-hidden />
                <T>Add Rule</T>
              </Button>
            </details>
          </SettingsRow>
          {snapshot.rules.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              <T>No conditional rules configured yet.</T>
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {snapshot.rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-medium text-foreground">
                        {rule.id}
                      </span>
                      <Badge variant="outline">{rule.apply}</Badge>
                      {rule.globs.length > 0 ? (
                        <Badge variant="secondary">{rule.globs.join(", ")}</Badge>
                      ) : null}
                      {rule.lockedByPolicy ? (
                        <Badge variant="secondary">
                          <T>Locked by organization</T>
                        </Badge>
                      ) : null}
                      {rule.overriddenByProject ? (
                        <Badge variant="secondary">{gt("Disabled by project")}</Badge>
                      ) : null}
                    </div>
                    {rule.description ? (
                      <p className="text-xs text-muted-foreground">{rule.description}</p>
                    ) : null}
                    <ContextSource body={rule.body} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label={gt("Toggle {id}", { id: rule.id })}
                      checked={rule.enabled}
                      disabled={!editable || busy || rule.lockedByPolicy === true}
                      onCheckedChange={async (checked) => {
                        setBusy(true);
                        const res = await setRuleEnabled({
                          environmentId,
                          input: { id: rule.id, enabled: checked, ...wsInput },
                        });
                        setBusy(false);
                        if (res._tag === "Success") setOverrideSnapshot(res.value);
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!editable || busy || rule.lockedByPolicy === true}
                      onClick={() => setRuleModal({ mode: "edit", item: rule })}
                    >
                      <PencilIcon className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!editable || busy || rule.lockedByPolicy === true}
                      onClick={async () => {
                        setBusy(true);
                        const res = await removeRule({
                          environmentId,
                          input: { id: rule.id, ...wsInput },
                        });
                        setBusy(false);
                        if (res._tag === "Success") {
                          setOverrideSnapshot(res.value);
                          toastManager.add({ type: "success", title: gt("Rule removed") });
                        }
                      }}
                    >
                      <Trash2Icon className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>

        <RuleEditorDialog
          state={ruleModal}
          onClose={() => setRuleModal(null)}
          onSave={async (payload) => {
            setBusy(true);
            const res = await upsertRule({
              environmentId,
              input: { ...payload, ...wsInput },
            });
            setBusy(false);
            if (res._tag === "Success") {
              setOverrideSnapshot(res.value);
              setRuleModal(null);
              toastManager.add({ type: "success", title: gt("Rule saved") });
            } else if (!isAtomCommandInterrupted(res)) {
              toastManager.add({
                type: "error",
                title: gt("Could not save rule"),
                description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
              });
            }
          }}
        />
      </>
    );
  }

  if (activeTab === "commands") {
    return (
      <>
        <SettingsSection {...setting("harness-commands")}>
          <SettingsRow
            title={<T>Custom Slash Commands</T>}
            description={
              <T>
                Expanded on the server across Web, Mobile, MCP, and Scheduled Tasks. Use $ARGUMENTS
                or $1, $2 placeholders in Markdown templates.
              </T>
            }
          >
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                <T>Manual configuration</T>
              </summary>
              <Button
                size="sm"
                disabled={!editable || busy}
                onClick={() => setCommandModal({ mode: "add" })}
              >
                <PlusIcon className="size-3.5" aria-hidden />
                <T>Add Command</T>
              </Button>
            </details>
          </SettingsRow>
          {snapshot.commands.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              <T>No portable slash commands yet.</T>
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {snapshot.commands.map((cmd) => (
                <div
                  key={cmd.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-medium text-foreground">
                        /{cmd.id}
                      </span>
                      {cmd.argumentHint ? (
                        <Badge variant="outline">{cmd.argumentHint}</Badge>
                      ) : null}
                      {cmd.overriddenByProject ? (
                        <Badge variant="secondary">{gt("Disabled by project")}</Badge>
                      ) : null}
                    </div>
                    {cmd.description ? (
                      <p className="text-xs text-muted-foreground">{cmd.description}</p>
                    ) : null}
                    <ContextSource body={cmd.body} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label={gt("Toggle {id}", { id: cmd.id })}
                      checked={cmd.enabled}
                      disabled={!editable || busy}
                      onCheckedChange={async (checked) => {
                        setBusy(true);
                        const res = await setCommandEnabled({
                          environmentId,
                          input: { id: cmd.id, enabled: checked, ...wsInput },
                        });
                        setBusy(false);
                        if (res._tag === "Success") setOverrideSnapshot(res.value);
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!editable || busy}
                      onClick={() => setCommandModal({ mode: "edit", item: cmd })}
                    >
                      <PencilIcon className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!editable || busy}
                      onClick={async () => {
                        setBusy(true);
                        const res = await removeCommand({
                          environmentId,
                          input: { id: cmd.id, ...wsInput },
                        });
                        setBusy(false);
                        if (res._tag === "Success") {
                          setOverrideSnapshot(res.value);
                          toastManager.add({ type: "success", title: gt("Command removed") });
                        }
                      }}
                    >
                      <Trash2Icon className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>

        <CommandEditorDialog
          state={commandModal}
          onClose={() => setCommandModal(null)}
          onSave={async (payload) => {
            setBusy(true);
            const res = await upsertCommand({
              environmentId,
              input: { ...payload, ...wsInput },
            });
            setBusy(false);
            if (res._tag === "Success") {
              setOverrideSnapshot(res.value);
              setCommandModal(null);
              toastManager.add({ type: "success", title: gt("Command saved") });
            } else if (!isAtomCommandInterrupted(res)) {
              toastManager.add({
                type: "error",
                title: gt("Could not save command"),
                description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
              });
            }
          }}
        />
      </>
    );
  }

  // activeTab === "transfer" (Import Skills/Rules/Commands & Reverse Export to native CLIs)
  const flattenedImports: Array<{
    readonly source: HarnessMcpImportSource;
    readonly candidate: HarnessLibraryImportCandidate;
    readonly key: string;
  }> = (importSources ?? []).flatMap((src) =>
    src.candidates.map((candidate) => ({
      source: src.source,
      candidate,
      key: `${src.source}:${candidate.kind}:${candidate.id}`,
    })),
  );

  return (
    <>
      <SettingsSection {...setting("harness-transfer")}>
        <SettingsRow
          title={<T>Import Skills, Rules & Commands</T>}
          description={
            <T>
              Read-only scan of Codex, Claude, Cursor, and Antigravity configs. Source files are
              never modified.
            </T>
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={!editable || busy}
            onClick={async () => {
              setBusy(true);
              const res = await scanLibraryImports({ environmentId, input: wsInput });
              setBusy(false);
              if (res._tag === "Success") {
                setImportSources(res.value.sources);
                const defaults = new Set<string>();
                for (const src of res.value.sources) {
                  for (const c of src.candidates) {
                    if (c.conflict === "none") defaults.add(`${src.source}:${c.kind}:${c.id}`);
                  }
                }
                setSelectedImportKeys(defaults);
              } else if (!isAtomCommandInterrupted(res)) {
                toastManager.add({
                  type: "error",
                  title: gt("Import scan failed"),
                  description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
                });
              }
            }}
          >
            <DownloadIcon className="size-3.5" aria-hidden />
            <T>Scan existing CLIs</T>
          </Button>
        </SettingsRow>
        {importSources !== null ? (
          <div className="space-y-3 px-4 pb-4">
            {flattenedImports.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No importable skills, rules, or commands found on this host.</T>
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  {flattenedImports.map(({ source, candidate, key }) => (
                    <label
                      key={key}
                      className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 p-2.5 text-xs"
                    >
                      <Checkbox
                        checked={selectedImportKeys.has(key)}
                        disabled={busy}
                        onCheckedChange={() => {
                          const next = new Set(selectedImportKeys);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          setSelectedImportKeys(next);
                        }}
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">{source}</Badge>
                          <Badge variant="secondary">{candidate.kind}</Badge>
                          <span className="font-mono font-medium text-foreground">
                            {candidate.name}
                          </span>
                          {candidate.conflict === "none" ? (
                            <Badge variant="success">{gt("New")}</Badge>
                          ) : candidate.conflict === "exists_identical" ? (
                            <Badge variant="outline">{gt("Identical")}</Badge>
                          ) : (
                            <Badge variant="warning">{gt("Differs")}</Badge>
                          )}
                        </div>
                        <p className="text-muted-foreground">{candidate.summary}</p>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={overwriteImports}
                      disabled={busy}
                      onCheckedChange={(checked) => setOverwriteImports(checked === true)}
                    />
                    <span>
                      <T>Overwrite matching items in ~/.t3/harness</T>
                    </span>
                  </label>
                  <Button
                    size="sm"
                    disabled={busy || selectedImportKeys.size === 0}
                    onClick={async () => {
                      const items = flattenedImports
                        .filter((entry) => selectedImportKeys.has(entry.key))
                        .map(({ source, candidate }) => ({
                          source,
                          kind: candidate.kind,
                          id: candidate.id,
                          expectedDigest: candidate.previewDigest,
                          ...(candidate.existingDigest !== undefined
                            ? { expectedExistingDigest: candidate.existingDigest }
                            : {}),
                        }));
                      setBusy(true);
                      const res = await applyLibraryImports({
                        environmentId,
                        input: { items, overwriteExisting: overwriteImports, ...wsInput },
                      });
                      setBusy(false);
                      if (res._tag === "Success") {
                        setOverrideSnapshot(res.value.snapshot);
                        toastManager.add({
                          type: "success",
                          title: gt("Imported {count} item(s)", {
                            count: res.value.importedKeys.length,
                          }),
                        });
                      } else if (!isAtomCommandInterrupted(res)) {
                        toastManager.add({
                          type: "error",
                          title: gt("Import failed"),
                          description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
                        });
                      }
                    }}
                  >
                    {gt("Import selected ({count})", { count: selectedImportKeys.size })}
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title={gt("CLI export")}>
        <SettingsRow
          title={<T>Reverse Export to Native CLI</T>}
          description={
            <T>
              Export your portable Harness back into native Codex, Claude Code, or Cursor config
              files with a full dry-run preview before writing.
            </T>
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={!editable || busy || exportSections.size === 0}
            onClick={async () => {
              setBusy(true);
              const res = await previewExport({
                environmentId,
                input: {
                  target: exportTarget,
                  sections: Array.from(exportSections),
                  ...wsInput,
                },
              });
              setBusy(false);
              if (res._tag === "Success") {
                setExportPreview(res.value);
              } else if (!isAtomCommandInterrupted(res)) {
                toastManager.add({
                  type: "error",
                  title: gt("Could not preview export"),
                  description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
                });
              }
            }}
          >
            <UploadIcon className="size-3.5" aria-hidden />
            <T>Preview export</T>
          </Button>
        </SettingsRow>
        <div className="space-y-3 px-4 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            {(["codex", "claude", "cursor"] as const).map((target) => (
              <Button
                key={target}
                size="sm"
                variant={exportTarget === target ? "default" : "outline"}
                onClick={() => {
                  setExportTarget(target);
                  setExportPreview(null);
                }}
              >
                {target}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {(["mcp", "skills", "rules", "commands"] as const).map((section) => (
              <label key={section} className="flex items-center gap-1.5">
                <Checkbox
                  checked={exportSections.has(section)}
                  onCheckedChange={() => {
                    const next = new Set(exportSections);
                    if (next.has(section)) next.delete(section);
                    else next.add(section);
                    setExportSections(next);
                    setExportPreview(null);
                  }}
                />
                <span>{section}</span>
              </label>
            ))}
          </div>

          {exportPreview !== null ? (
            <div className="space-y-2 rounded-lg border border-border/70 p-3 text-xs">
              {exportPreview.warnings.length > 0 ? (
                <Alert variant="warning">
                  <AlertTitle>
                    <T>Export notes</T>
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc ps-4">
                      {exportPreview.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
              {exportPreview.files.length === 0 ? (
                <p className="text-muted-foreground">
                  <T>Nothing to export for the selected sections.</T>
                </p>
              ) : (
                <div className="space-y-2">
                  {exportPreview.files.map((file) => (
                    <div
                      key={file.targetPath}
                      className="rounded border border-border/60 p-2 font-mono"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="break-all text-foreground">{file.targetPath}</span>
                        <Badge
                          variant={
                            file.action === "create"
                              ? "success"
                              : file.action === "update"
                                ? "warning"
                                : "outline"
                          }
                        >
                          {file.action}
                        </Badge>
                      </div>
                      <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap text-2xs text-muted-foreground">
                        {file.previewSnippet}
                      </pre>
                    </div>
                  ))}
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={!editable || !canManageProviders || busy}
                      onClick={async () => {
                        setBusy(true);
                        const res = await applyExport({
                          environmentId,
                          input: {
                            target: exportPreview.target,
                            sections: Array.from(exportSections),
                            planDigest: exportPreview.planDigest,
                            ...wsInput,
                          },
                        });
                        setBusy(false);
                        if (res._tag === "Success") {
                          setExportPreview(null);
                          toastManager.add({
                            type: "success",
                            title: gt("Exported {count} file(s)", {
                              count: res.value.writtenPaths.length,
                            }),
                          });
                        } else if (!isAtomCommandInterrupted(res)) {
                          toastManager.add({
                            type: "error",
                            title: gt("Export failed"),
                            description: formatError(
                              squashAtomCommandFailure(res),
                              gt("Try again."),
                            ),
                          });
                        }
                      }}
                    >
                      <T>Apply export to host</T>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </>
  );
}

function SkillEditorDialog({
  state,
  onClose,
  onSave,
}: {
  readonly state:
    | null
    | { readonly mode: "add" }
    | { readonly mode: "edit"; readonly item: HarnessSkillEntry };
  readonly onClose: () => void;
  readonly onSave: (payload: {
    readonly id: HarnessSkillId;
    readonly name?: typeof TrimmedNonEmptyString.Type;
    readonly description?: string;
    readonly shortDescription?: string;
    readonly body: string;
  }) => Promise<void>;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      {state !== null ? (
        <SkillEditorDialogBody
          key={state.mode === "edit" ? state.item.id : "new-skill"}
          existing={state.mode === "edit" ? state.item : null}
          onClose={onClose}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

function SkillEditorDialogBody({
  existing,
  onClose,
  onSave,
}: {
  readonly existing: HarnessSkillEntry | null;
  readonly onClose: () => void;
  readonly onSave: (payload: {
    readonly id: HarnessSkillId;
    readonly name?: typeof TrimmedNonEmptyString.Type;
    readonly description?: string;
    readonly shortDescription?: string;
    readonly body: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [id, setId] = useState(existing?.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [body, setBody] = useState(existing?.body ?? "");

  return (
    <DialogPopup className="max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {existing ? <T>Edit Portable Skill</T> : <T>New Portable Skill</T>}
        </DialogTitle>
        <DialogDescription>
          <T>Saved as a standard SKILL.md under ~/.t3/harness/skills.</T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Skill ID")}</label>
            <Input
              disabled={existing !== null}
              value={existing ? existing.id : id}
              placeholder="code-review"
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Display Name")}</label>
            <Input
              value={name}
              placeholder="code-review"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Description")}</label>
            <Input
              value={description}
              placeholder={gt("When should agents use this skill?")}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Instructions (Markdown)")}</label>
            <Textarea
              rows={8}
              value={body}
              placeholder={gt("# Skill instructions...")}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const targetId = existing ? existing.id : id;
            const decoded = decodeSkillId(targetId);
            if (decoded._tag === "None") {
              toastManager.add({
                type: "error",
                title: gt("Invalid skill ID (use letters, digits, hyphens, underscores)"),
              });
              return;
            }
            void onSave({
              id: decoded.value,
              ...(name.trim() ? { name: TrimmedNonEmptyString.make(name.trim()) } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
              body,
            });
          }}
        >
          <T>Save Skill</T>
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function RuleEditorDialog({
  state,
  onClose,
  onSave,
}: {
  readonly state:
    | null
    | { readonly mode: "add" }
    | { readonly mode: "edit"; readonly item: HarnessRuleEntry };
  readonly onClose: () => void;
  readonly onSave: (payload: {
    readonly id: HarnessRuleId;
    readonly description?: string;
    readonly apply: HarnessRuleApplyMode;
    readonly globs?: ReadonlyArray<typeof TrimmedNonEmptyString.Type>;
    readonly body: string;
  }) => Promise<void>;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      {state !== null ? (
        <RuleEditorDialogBody
          key={state.mode === "edit" ? state.item.id : "new-rule"}
          existing={state.mode === "edit" ? state.item : null}
          onClose={onClose}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

function RuleEditorDialogBody({
  existing,
  onClose,
  onSave,
}: {
  readonly existing: HarnessRuleEntry | null;
  readonly onClose: () => void;
  readonly onSave: (payload: {
    readonly id: HarnessRuleId;
    readonly description?: string;
    readonly apply: HarnessRuleApplyMode;
    readonly globs?: ReadonlyArray<typeof TrimmedNonEmptyString.Type>;
    readonly body: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [id, setId] = useState(existing?.id ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [apply, setApply] = useState<HarnessRuleApplyMode>(existing?.apply ?? "always");
  const [globsText, setGlobsText] = useState(existing?.globs.join(", ") ?? "");
  const [body, setBody] = useState(existing?.body ?? "");

  return (
    <DialogPopup className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{existing ? <T>Edit Portable Rule</T> : <T>New Portable Rule</T>}</DialogTitle>
        <DialogDescription>
          <T>Stored under ~/.t3/harness/rules/*.md with always, glob, or manual activation.</T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Rule ID")}</label>
            <Input
              disabled={existing !== null}
              value={existing ? existing.id : id}
              placeholder="typescript-style"
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Activation Mode")}</label>
            <div className="flex gap-2">
              {(["always", "glob", "manual"] as const).map((mode) => (
                <Button
                  key={mode}
                  size="sm"
                  variant={apply === mode ? "default" : "outline"}
                  onClick={() => setApply(mode)}
                >
                  {mode}
                </Button>
              ))}
            </div>
          </div>
          {apply === "glob" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium">{gt("File Globs (comma separated)")}</label>
              <Input
                value={globsText}
                placeholder="src/**/*.ts, **/*.tsx"
                onChange={(e) => setGlobsText(e.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Description")}</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Rule Body (Markdown)")}</label>
            <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const targetId = existing ? existing.id : id;
            const decoded = decodeRuleId(targetId);
            if (decoded._tag === "None") {
              toastManager.add({ type: "error", title: gt("Invalid rule ID") });
              return;
            }
            const globs = globsText
              .split(/[,\n]+/u)
              .map((g) => g.trim())
              .filter(Boolean)
              .map((g) => TrimmedNonEmptyString.make(g));
            void onSave({
              id: decoded.value,
              ...(description.trim() ? { description: description.trim() } : {}),
              apply,
              ...(apply === "glob" && globs.length > 0 ? { globs } : {}),
              body,
            });
          }}
        >
          <T>Save Rule</T>
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function CommandEditorDialog({
  state,
  onClose,
  onSave,
}: {
  readonly state:
    | null
    | { readonly mode: "add" }
    | { readonly mode: "edit"; readonly item: HarnessCommandEntry };
  readonly onClose: () => void;
  readonly onSave: (payload: {
    readonly id: HarnessCommandId;
    readonly description?: string;
    readonly argumentHint?: string;
    readonly body: string;
  }) => Promise<void>;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      {state !== null ? (
        <CommandEditorDialogBody
          key={state.mode === "edit" ? state.item.id : "new-cmd"}
          existing={state.mode === "edit" ? state.item : null}
          onClose={onClose}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

function CommandEditorDialogBody({
  existing,
  onClose,
  onSave,
}: {
  readonly existing: HarnessCommandEntry | null;
  readonly onClose: () => void;
  readonly onSave: (payload: {
    readonly id: HarnessCommandId;
    readonly description?: string;
    readonly argumentHint?: string;
    readonly body: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [id, setId] = useState(existing?.id ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [argumentHint, setArgumentHint] = useState(existing?.argumentHint ?? "");
  const [body, setBody] = useState(existing?.body ?? "");

  return (
    <DialogPopup className="max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {existing ? <T>Edit Custom Command</T> : <T>New Custom Command</T>}
        </DialogTitle>
        <DialogDescription>
          <T>Invoked as /name [arguments] across every provider and client surface.</T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Command Name (without /)")}</label>
            <Input
              disabled={existing !== null}
              value={existing ? existing.id : id}
              placeholder="review-pr"
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Description")}</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Argument Hint")}</label>
            <Input
              value={argumentHint}
              placeholder={gt("file or PR URL")}
              onChange={(e) => setArgumentHint(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">
              {gt("Prompt Template (supports $ARGUMENTS, $1, $2)")}
            </label>
            <Textarea
              rows={8}
              value={body}
              placeholder={gt("Review the following target carefully: $ARGUMENTS")}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const targetId = existing ? existing.id : id;
            const decoded = decodeCommandId(targetId);
            if (decoded._tag === "None") {
              toastManager.add({
                type: "error",
                title: gt("Invalid or reserved command name"),
              });
              return;
            }
            void onSave({
              id: decoded.value,
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(argumentHint.trim() ? { argumentHint: argumentHint.trim() } : {}),
              body,
            });
          }}
        >
          <T>Save Command</T>
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function ModeEditorDialog({
  state,
  onClose,
  onSave,
  environmentId,
  workspaceRoot,
  rules,
  skills,
}: {
  environmentId: EnvironmentId;
  workspaceRoot: string | undefined;
  rules: readonly HarnessRuleId[];
  skills: readonly HarnessSkillId[];

  readonly state:
    | null
    | { readonly mode: "add" }
    | { readonly mode: "edit"; readonly item: HarnessModeEntry };
  readonly onClose: () => void;
  readonly onSave: (payload: {
    readonly id: HarnessModeId;
    readonly name?: typeof TrimmedNonEmptyString.Type;
    readonly description?: string;
    readonly baseInteractionMode: ProviderInteractionMode;
    readonly readonly?: boolean;
    readonly proposePlan?: boolean;
    readonly allowedMcpServers?: ReadonlyArray<typeof TrimmedNonEmptyString.Type>;
    readonly includedRules?: ReadonlyArray<typeof TrimmedNonEmptyString.Type>;
    readonly includedSkills?: ReadonlyArray<typeof TrimmedNonEmptyString.Type>;
    readonly body: string;
  }) => Promise<void>;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      {state !== null ? (
        <ModeEditorDialogBody
          environmentId={environmentId}
          workspaceRoot={workspaceRoot}
          rules={rules}
          skills={skills}
          key={state.mode === "edit" ? state.item.id : "new-mode"}
          existing={state.mode === "edit" ? state.item : null}
          onClose={onClose}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

function ModeEditorDialogBody({
  existing,
  onClose,
  onSave,
  environmentId,
  workspaceRoot,
  rules,
  skills,
}: {
  environmentId: EnvironmentId;
  workspaceRoot: string | undefined;
  rules: readonly HarnessRuleId[];
  skills: readonly HarnessSkillId[];

  readonly existing: HarnessModeEntry | null;
  readonly onClose: () => void;
  readonly onSave: (payload: {
    readonly id: HarnessModeId;
    readonly name?: typeof TrimmedNonEmptyString.Type;
    readonly description?: string;
    readonly baseInteractionMode: ProviderInteractionMode;
    readonly readonly?: boolean;
    readonly proposePlan?: boolean;
    readonly allowedMcpServers?: ReadonlyArray<typeof TrimmedNonEmptyString.Type>;
    readonly includedRules?: ReadonlyArray<typeof TrimmedNonEmptyString.Type>;
    readonly includedSkills?: ReadonlyArray<typeof TrimmedNonEmptyString.Type>;
    readonly body: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [id, setId] = useState(existing?.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [baseInteractionMode, setBaseInteractionMode] = useState<ProviderInteractionMode>(
    existing?.baseInteractionMode ?? "default",
  );
  const [readonlyMode, setReadonlyMode] = useState(existing?.readonly ?? false);
  const [proposePlan, setProposePlan] = useState(existing?.proposePlan ?? false);
  const servers = useEnvironmentQuery(
    harnessEnvironment.listMcpQuery({
      environmentId,
      input: workspaceRoot ? { workspaceRoot } : {},
    }),
  );
  const [allowedMcpServers, setServers] = useState(existing?.allowedMcpServers ?? []);
  const [includedRules, setRules] = useState(existing?.includedRules ?? []);
  const [includedSkills, setSkills] = useState(existing?.includedSkills ?? []);
  const [body, setBody] = useState(existing?.body ?? "");

  return (
    <DialogPopup className="max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {existing ? <T>Edit Declarative Mode</T> : <T>New Declarative Mode</T>}
        </DialogTitle>
        <DialogDescription>
          <T>Stored under ~/.t3/harness/modes/*.md and projected across all providers.</T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Mode ID")}</label>
            <Input
              disabled={existing !== null}
              value={existing ? existing.id : id}
              placeholder="security-audit"
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Display Name")}</label>
            <Input
              value={name}
              placeholder={gt("Security Audit")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Description")}</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium">{gt("Base Interaction Mode")}</label>
              <div className="flex gap-2">
                {(["default", "plan"] as const).map((mode) => (
                  <Button
                    key={mode}
                    size="sm"
                    variant={baseInteractionMode === mode ? "default" : "outline"}
                    onClick={() => setBaseInteractionMode(mode)}
                  >
                    {mode}
                  </Button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={readonlyMode}
                onCheckedChange={(checked) => setReadonlyMode(Boolean(checked))}
              />
              <span>{gt("Read-only")}</span>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={proposePlan}
                onCheckedChange={(checked) => setProposePlan(Boolean(checked))}
              />
              <span>{gt("Propose plan")}</span>
            </label>
          </div>
          <BindingPicker
            label={gt("Allowed MCP servers (none selected allows all)")}
            values={allowedMcpServers}
            options={servers.data?.servers.map((server) => server.id) ?? []}
            onChange={setServers}
          />
          <BindingPicker
            label={gt("Force-included Rules")}
            values={includedRules}
            options={rules}
            onChange={setRules}
          />
          <BindingPicker
            label={gt("Force-included Skills")}
            values={includedSkills}
            options={skills}
            onChange={setSkills}
          />
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("System Prompt (Markdown)")}</label>
            <Textarea
              rows={8}
              value={body}
              placeholder={gt("# Mode instructions...")}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const targetId = existing ? existing.id : id;
            const decoded = decodeModeId(targetId);
            if (decoded._tag === "None") {
              toastManager.add({
                type: "error",
                title: gt("Invalid mode ID (use lowercase letters, numbers, and hyphens)"),
              });
              return;
            }
            void onSave({
              id: decoded.value,
              ...(name.trim() ? { name: TrimmedNonEmptyString.make(name.trim()) } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
              baseInteractionMode,
              readonly: readonlyMode,
              proposePlan,
              ...(allowedMcpServers.length > 0 ? { allowedMcpServers } : {}),
              ...(includedRules.length > 0 ? { includedRules } : {}),
              ...(includedSkills.length > 0 ? { includedSkills } : {}),
              body,
            });
          }}
        >
          <T>Save Mode</T>
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function BindingPicker<Id extends string>({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: readonly Id[];
  options: readonly Id[];
  onChange: (values: readonly Id[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {Array.from(new Set([...options, ...values])).map((id) => (
          <label key={id} className="flex items-center gap-1 text-xs">
            <Checkbox
              checked={values.includes(id)}
              onCheckedChange={(checked) =>
                onChange(checked ? [...values, id] : values.filter((value) => value !== id))
              }
            />
            {id}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ContextSource({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!body) return null;
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        <T>Read instructions</T>
      </summary>
      {expanded ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words py-2 text-sm">
          {body}
        </pre>
      ) : null}
    </details>
  );
}
