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
