import { redirect } from "@tanstack/react-router";
import { validateSettingsScopeSearch } from "../settings/settingsScope";
import { msg } from "gt-react";

export const harnessDomains = [
  { tab: "skills", title: msg("Skills & Plugins") },
  { tab: "tools", title: msg("Tools (MCP)") },
  { tab: "context", title: msg("Context & Roles") },
  { tab: "guardrails", title: msg("Guardrails") },
] as const;
export type HarnessDomain = (typeof harnessDomains)[number]["tab"];
export function harnessDomain(value: unknown): HarnessDomain {
  return harnessDomains.find((domain) => domain.tab === value)?.tab ?? "skills";
}

export function redirectLegacyHarness(location: {
  searchStr: string;
  search: Record<string, unknown>;
  hash: string;
}) {
  const params = new URLSearchParams(location.searchStr);
  const hash = location.hash.replace(/^#/, "");
  const section = hash.startsWith("harness-")
    ? hash.slice("harness-".length)
    : (params.get("tab") ?? hash);
  const scope = validateSettingsScopeSearch(location.search);
  if (
    params.has("sync") ||
    params.has("import") ||
    ["sync", "import", "export", "transfer", "environment-sync"].includes(section)
  ) {
    throw redirect({ to: "/settings/sync", search: scope, hash, replace: true });
  }
  if (section === "workflows" || section === "automations") {
    throw redirect({
      to: "/automations",
      search: { ...scope, ...(section === "workflows" ? { tab: "workflows" as const } : {}) },
      hash,
      replace: true,
    });
  }
  const tab =
    section === "mcp"
      ? "tools"
      : ["hooks", "approvals"].includes(section)
        ? "guardrails"
        : ["rules", "modes", "commands", "memory"].includes(section)
          ? "context"
          : harnessDomain(section);
  throw redirect({ to: "/harness", search: { ...scope, tab }, hash, replace: true });
}
