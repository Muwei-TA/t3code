import { createFileRoute } from "@tanstack/react-router";
import { redirectLegacyHarness } from "../components/harness/harnessNavigation";

export const Route = createFileRoute("/_chat/settings/harness")({
  beforeLoad: ({ location }) => redirectLegacyHarness(location),
});
