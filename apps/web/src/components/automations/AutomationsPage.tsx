import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { Clock3Icon, WorkflowIcon } from "lucide-react";

import { isElectron } from "~/env";
import { ScheduledTasksSettings } from "../settings/ScheduledTasksSettings";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useWorkflowEnvironmentIds } from "../workflows/useWorkflowEnvironmentIds";

export interface AutomationsSearch {
  readonly tab?: "scheduled-tasks" | "workflows";
}

export function AutomationsPage() {
  const search = useSearch({ from: "/_chat/automations" });
  const navigate = useNavigate();
  const gt = useGT();
  const workflowEnvIds = useWorkflowEnvironmentIds();
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
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
