import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  HarnessWorkflowValidateResult,
  WorkflowDefinitionFile,
} from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { CheckCircle2Icon, Clock3Icon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "~/env";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { harnessEnvironment } from "../../state/harness";
import { useAtomCommand } from "../../state/use-atom-command";
import { ScheduledTasksSettings } from "../settings/ScheduledTasksSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useWorkflowEnvironmentIds } from "../workflows/useWorkflowEnvironmentIds";

export interface AutomationsSearch {
  readonly tab?: "scheduled-tasks" | "workflows";
}

const SAMPLE_WORKFLOW_YAML = `name: plan-implement-review
version: 1
description: Explore in Plan mode, execute in a child thread, then review.
steps:
  - id: plan
    kind: in-thread
    modeId: plan
    prompt: Inspect the codebase and draft a concise implementation plan.
  - id: approve
    kind: ask
    dependsOn: [plan]
    prompt: What should implementation prioritize?
    choices: [Simplest change, Broader coverage]
  - id: implement
    kind: child
    modeId: build
    dependsOn: [plan, approve]
    prompt: Implement the plan with the chosen priority and run unit tests.
  - id: review
    kind: in-thread
    modeId: review
    dependsOn: [implement]
    prompt: Review the resulting diff for correctness and edge cases.
`;

export function AutomationsPage() {
  const search = useSearch({ from: "/_chat/automations" });
  const navigate = useNavigate();
  const gt = useGT();
  const workflowEnvIds = useWorkflowEnvironmentIds();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connected = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId =
    selected !== null && connected.includes(selected)
      ? selected
      : primaryEnvironmentId !== null && connected.includes(primaryEnvironmentId)
        ? primaryEnvironmentId
        : (connected[0] ?? null);
  const enabled = environmentId !== null && workflowEnvIds.includes(environmentId);
  const maySave = useAtomValue(
    serverEnvironment.saveWorkflowDefinition.permissionAtom(environmentId),
  );
  const definitions = useEnvironmentQuery(
    enabled && maySave && environmentId !== null && search.tab === "workflows"
      ? serverEnvironment.workflowDefinition({ environmentId, input: {} })
      : null,
  );
  const saveWorkflow = useAtomCommand(serverEnvironment.saveWorkflowDefinition);
  const validateWorkflow = useAtomCommand(harnessEnvironment.validateWorkflow, {
    reportFailure: false,
  });
  const [yamlText, setYamlText] = useState(SAMPLE_WORKFLOW_YAML);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [validation, setValidation] = useState<HarnessWorkflowValidateResult | null>(null);
  const activeTab = search.tab === "workflows" ? "workflows" : "scheduled-tasks";

  const check = async () => {
    if (environmentId === null) return null;
    const result = await validateWorkflow({ environmentId, input: { yaml: yamlText } });
    if (result._tag === "Failure") return null;
    setValidation(result.value);
    return result.value;
  };

  const saveChecked = async (
    environmentId: EnvironmentId,
    files: ReadonlyArray<WorkflowDefinitionFile>,
  ) => {
    const checked = await check();
    if (checked === null || !checked.valid || checked.name === undefined) {
      setSaveFeedback({ text: gt("Fix the YAML before saving."), error: true });
      return;
    }
    const name = `${checked.name.replaceAll(" ", "-")}.yaml`;
    if (files.some((file) => file.name === name)) {
      setSaveFeedback({
        text: gt("{name} already exists. Open Definitions to edit it.", { name }),
        error: true,
      });
      return;
    }
    const result = await saveWorkflow({ environmentId, input: { name, source: yamlText } });
    if (result._tag === "Success") {
      const problem = result.value.problems[0]?.message;
      setSaveFeedback({
        text:
          problem ??
          (result.value.changed
            ? gt("Saved {name}.", { name })
            : gt("The workflow could not be saved.")),
        error: problem !== undefined || !result.value.changed,
      });
    }
  };
  const save = async () => {
    if (environmentId === null || definitions.data === null || saving) return;
    setSaving(true);
    setSaveFeedback(null);
    await saveChecked(environmentId, definitions.data.files).finally(() => setSaving(false));
  };

  const setTab = (tab: "scheduled-tasks" | "workflows") => {
    void navigate({ to: "/automations", search: { tab }, replace: true });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel={gt("Automations breadcrumb")} className="flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">
                <T>Automations</T>
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={activeTab === "scheduled-tasks" ? "default" : "outline"}
              onClick={() => setTab("scheduled-tasks")}
            >
              <Clock3Icon className="size-3.5" />
              <T>Scheduled tasks</T>
            </Button>
            <Button
              size="sm"
              variant={activeTab === "workflows" ? "default" : "outline"}
              onClick={() => setTab("workflows")}
            >
              <WorkflowIcon className="size-3.5" />
              <T>Workflows</T>
            </Button>
          </div>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          {activeTab === "scheduled-tasks" ? (
            <div className="mx-auto max-w-4xl px-6 py-6">
              <ScheduledTasksSettings />
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
              <div className="rounded-xl border border-border bg-card p-6">
                <h2 className="text-base font-semibold text-foreground">
                  <T>Multi-step Workflows</T>
                </h2>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  <T>Open live runs and edit workflow definitions on a connected server.</T>
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {connected.length > 1 ? (
                    <Select value={environmentId} onValueChange={(id) => setSelected(id)}>
                      <SelectTrigger
                        size="sm"
                        aria-label={gt("Environment", { $context: "a T3 Code server to pick" })}
                      >
                        <SelectValue>
                          {
                            environments.find(
                              (environment) => environment.environmentId === environmentId,
                            )?.label
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {environments
                          .filter((environment) => connected.includes(environment.environmentId))
                          .map((environment) => (
                            <SelectItem
                              key={environment.environmentId}
                              value={environment.environmentId}
                            >
                              {environment.label}
                            </SelectItem>
                          ))}
                      </SelectPopup>
                    </Select>
                  ) : null}
                  <Button
                    render={
                      <Link
                        to="/workflows"
                        search={environmentId === null ? {} : { env: environmentId }}
                      />
                    }
                    size="sm"
                  >
                    <WorkflowIcon className="size-3.5" />
                    <T>Open Workflows studio</T>
                  </Button>
                  {environmentId !== null && !enabled ? (
                    <Button
                      render={<Link to="/settings/scheduled-tasks" hash="workflows" />}
                      size="sm"
                      variant="outline"
                    >
                      <T>Workflow settings</T>
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border bg-card p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      <T>Declarative YAML Workflow Validator</T>
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      <T>Write YAML with in-thread, child, and question steps.</T>
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={validating || saving || environmentId === null}
                      onClick={async () => {
                        setValidating(true);
                        await check().finally(() => setValidating(false));
                      }}
                    >
                      <CheckCircle2Icon className="size-3.5" />
                      {validating ? <T>Validating...</T> : <T>Validate YAML</T>}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void save()}
                      disabled={
                        !enabled ||
                        !maySave ||
                        definitions.data === null ||
                        definitions.data.single ||
                        saving ||
                        validating
                      }
                    >
                      {saving ? gt("Saving…") : gt("Save YAML")}
                    </Button>
                  </div>
                </div>

                <Textarea
                  rows={12}
                  value={yamlText}
                  disabled={saving || validating}
                  onChange={(e) => {
                    setYamlText(e.target.value);
                    setValidation(null);
                    setSaveFeedback(null);
                  }}
                />

                {saveFeedback === null ? null : (
                  <p
                    role="status"
                    className={
                      saveFeedback.error
                        ? "text-sm text-destructive"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {saveFeedback.text}
                  </p>
                )}

                {validation ? (
                  <div className="space-y-2 rounded-lg border border-border/70 p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={validation.valid ? "success" : "error"}>
                        {validation.valid ? gt("Valid") : gt("Invalid")}
                      </Badge>
                      {validation.executionOrder.length > 0 ? (
                        <span className="font-mono text-muted-foreground">
                          {validation.executionOrder.join(" -> ")}
                        </span>
                      ) : null}
                    </div>
                    {validation.issues.length > 0 ? (
                      <ul className="list-disc space-y-1 ps-4">
                        {validation.issues.map((issue) => (
                          <li
                            key={`${issue.path}:${issue.message}`}
                            className={
                              issue.severity === "error" ? "text-destructive" : "text-warning"
                            }
                          >
                            <span className="font-mono">{issue.path}</span>: {issue.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {validation.compiledPreview ? (
                      <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 font-mono text-2xs text-foreground">
                        {validation.compiledPreview}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
