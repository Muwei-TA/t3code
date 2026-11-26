import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { AutomationsPage } from "./AutomationsPage";

it("opens scheduled tasks from the Automations route without a settings layout", async () => {
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
  await expect.element(screen.getByText("No environments available")).toBeVisible();
});
