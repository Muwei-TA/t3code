import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateSettingsScopeSearch } from "../components/settings/settingsScope";
import { harnessDomain } from "../components/harness/harnessNavigation";

export const Route = createFileRoute("/_chat/settings/harness")({
  beforeLoad: ({ location }) => {
    const params = new URLSearchParams(location.searchStr);
    const section = params.get("tab") ?? location.hash;
    const scope = validateSettingsScopeSearch(location.search);
    if (
      params.has("sync") ||
      params.has("import") ||
      ["sync", "import", "export", "transfer"].includes(section)
    ) {
      throw redirect({ to: "/settings/sync", search: scope, replace: true });
    }
    const tab =
      section === "mcp"
        ? "tools"
        : ["hooks", "approvals"].includes(section)
          ? "guardrails"
          : ["rules", "modes", "commands", "memory"].includes(section)
            ? "context"
            : harnessDomain(section);
    throw redirect({ to: "/harness", search: { ...scope, tab }, replace: true });
  },
});
