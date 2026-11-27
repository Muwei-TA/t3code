import { createFileRoute } from "@tanstack/react-router";
import { HarnessMigration } from "../components/harness/HarnessWorkbench";

export const Route = createFileRoute("/_chat/settings/sync")({ component: HarnessMigration });
