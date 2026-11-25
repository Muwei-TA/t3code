import type { HarnessWorkflowValidateResult } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { CheckCircle2Icon, Clock3Icon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "~/env";
import { usePrimaryEnvironmentId } from "../../state/environments";
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
  - id: implement
    kind: child
    modeId: build
    dependsOn: [plan]
    prompt: Implement the approved plan and run unit tests.
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
  const validateWorkflow = useAtomCommand(harnessEnvironment.validateWorkflow, {
    reportFailure: false,
  });
  const [yamlText, setYamlText] = useState(SAMPLE_WORKFLOW_YAML);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<HarnessWorkflowValidateResult | null>(null);
  const activeTab = search.tab === "workflows" ? "workflows" : "scheduled-tasks";

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
                  <T>
                    Inspect live runs, pause/resume steps, and edit declarative workflow definitions
                    across connected environments.
                  </T>
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button render={<Link to="/workflows" />} size="sm">
                    <WorkflowIcon className="size-3.5" />
                    <T>Open Workflows studio</T>
                  </Button>
                  {workflowEnvIds.length === 0 ? (
                    <Button render={<Link to="/settings/labs" />} size="sm" variant="outline">
                      <T>Enable Workflows in Labs</T>
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
                      <T>
                        Validate workflows/*.yaml step DAGs (in-thread and child steps) and preview
                        compiled T3 workflows.
                      </T>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={validating || primaryEnvironmentId === null}
                    onClick={async () => {
                      if (!primaryEnvironmentId) return;
                      setValidating(true);
                      const res = await validateWorkflow({
                        environmentId: primaryEnvironmentId,
                        input: { yaml: yamlText },
                      });
                      setValidating(false);
                      if (res._tag === "Success") {
                        setValidation(res.value);
                      }
                    }}
                  >
                    <CheckCircle2Icon className="size-3.5" />
                    {validating ? <T>Validating...</T> : <T>Validate YAML</T>}
                  </Button>
                </div>

                <Textarea
                  rows={12}
                  value={yamlText}
                  onChange={(e) => setYamlText(e.target.value)}
                />

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
