import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { AutomationsPage } from "./AutomationsPage";

const environments = ["Laptop", "Server"].map((label) => ({
  environmentId: EnvironmentId.make(label.toLowerCase()),
  label,
  connection: { phase: "connected" },
  entry: { target: { _tag: "PrimaryConnectionTarget" } },
  serverConfig: {
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { platform: { machine: "server" } },
  },
}));

const decodeScheduledTask = Schema.decodeSync(ScheduledTask);
const tasks = new Map(
  environments.map(({ environmentId, label }) => {
    const task = decodeScheduledTask({
      id: environmentId,
      title: `${label} reminder`,
      prompt: "Check the project",
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      projectId: "test-project",
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "test-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: "2026-11-26T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    });
    return [environmentId, Atom.make(AsyncResult.success({ tasks: [task] }))];
  }),
);

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: () => ({ environments }) as never,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      scheduledTasksLive: ({ environmentId }: { environmentId: EnvironmentId }) =>
        tasks.get(environmentId)!,
    },
  };
});

it("filters scheduled tasks by environment from the Automations route", async () => {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const automations = createRoute({
    getParentRoute: () => chat,
    path: "automations",
    component: AutomationsPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([automations])]),
    history: createMemoryHistory({ initialEntries: ["/automations"] }),
    disableGlobalCatchBoundary: true,
  });
  await using screen = await render(
    <SidebarProvider>
      <RouterProvider router={router} />
    </SidebarProvider>,
    { router: false }, // Automations reads search params from its own named route.
  );

  await expect.element(screen.getByRole("heading", { name: "Automations" })).toBeVisible();
  await expect.element(screen.getByText("Laptop reminder")).toBeVisible();
  await expect.element(screen.getByText("Server reminder")).toBeVisible();

  await screen.getByRole("button", { name: "Environment scope: All environments" }).click();
  await page.getByRole("menuitemradio", { name: /^Server/ }).click();

  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Server" }))
    .toBeVisible();
  await expect.element(screen.getByText("Server reminder")).toBeVisible();
  await expect.element(screen.getByText("Laptop reminder")).not.toBeInTheDocument();
});
