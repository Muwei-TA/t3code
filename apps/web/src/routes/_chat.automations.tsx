import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage, type AutomationsSearch } from "../components/automations/AutomationsPage";

export const Route = createFileRoute("/_chat/automations")({
  validateSearch: (raw: Record<string, unknown>): AutomationsSearch =>
    raw.tab === "workflows" || raw.tab === "scheduled-tasks" ? { tab: raw.tab } : {},
  component: AutomationsPage,
});
