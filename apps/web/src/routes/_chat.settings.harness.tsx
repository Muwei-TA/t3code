import { createFileRoute } from "@tanstack/react-router";

import { HarnessSettingsPanel } from "../components/settings/HarnessSettings";

export const Route = createFileRoute("/_chat/settings/harness")({
  component: HarnessSettingsPanel,
});
