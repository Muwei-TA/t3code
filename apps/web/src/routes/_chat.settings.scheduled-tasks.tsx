import { createFileRoute } from "@tanstack/react-router";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";

import { WorkflowsSettingsRow } from "../components/settings/WorkflowsSettingsRow";
import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";

function SettingsScheduledTasksRoute() {
  const target = Route.useSearch();
  return (
    <>
      <WorkflowsSettingsRow />
      <ScheduledTasksSettings {...target} />
    </>
  );
}

export const Route = createFileRoute("/_chat/settings/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
  component: SettingsScheduledTasksRoute,
});
