import { createFileRoute } from "@tanstack/react-router";
import { readLightningShell } from "../components/lightning/shell";
import { HarnessWorkbench } from "../components/harness/HarnessWorkbench";
import { harnessDomain, type HarnessDomain } from "../components/harness/harnessNavigation";
import {
  validateSettingsScopeSearch,
  type SettingsScopeSearch,
} from "../components/settings/settingsScope";

export const Route = createFileRoute("/_chat/harness")({
  validateSearch: (raw): SettingsScopeSearch & { tab?: HarnessDomain } => ({
    ...validateSettingsScopeSearch(raw),
    ...(raw.tab ? { tab: harnessDomain(raw.tab, readLightningShell()) } : {}),
  }),
  component: HarnessWorkbench,
});
