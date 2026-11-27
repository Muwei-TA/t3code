import { createFileRoute, redirect } from "@tanstack/react-router";

import { readWorkflowPane } from "../components/workflows/workflowPane.logic";
import { WorkflowsPage, type WorkflowsSearch } from "../components/workflows/WorkflowsPage";

export const Route = createFileRoute("/_chat/workflows")({
  validateSearch: (raw: Record<string, unknown>): WorkflowsSearch => ({
    ...(typeof raw.env === "string" && raw.env ? { env: raw.env.slice(0, 200) } : {}),
    ...(typeof raw.run === "string" && raw.run ? { run: raw.run.slice(0, 200) } : {}),
    ...readWorkflowPane(raw.pane, raw.tab),
    ...(raw.definitions === true || raw.definitions === "true" ? { definitions: true } : {}),
    ...(typeof raw.file === "string" && raw.file ? { file: raw.file.slice(0, 200) } : {}),
  }),
  beforeLoad: ({ search }) => {
    if (!search.env && !search.run && !search.pane && !search.file && !search.definitions) {
      throw redirect({ to: "/automations", search: { tab: "workflows" }, replace: true });
    }
  },
  component: WorkflowsPage,
});
