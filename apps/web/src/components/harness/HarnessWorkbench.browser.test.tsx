import {
  EnvironmentId,
  HarnessLibrarySnapshot,
  HarnessHooksSnapshot,
  HarnessPluginsSnapshot,
  HarnessMemorySnapshot,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { HarnessWorkbench } from "./HarnessWorkbench";

const environmentId = EnvironmentId.make("test-server");
const fixture = Schema.decodeSync(HarnessLibrarySnapshot)({
  harnessDir: "/harness",
  workspaceRoot: "/repo",
  rules: [],
  modes: [],
  commands: [],
  invalidEntries: [],
  userAgentsMd: {
    body: "",
    path: "/harness/AGENTS.md",
    bytes: 0,
    exists: false,
    scope: "user",
    contentDigest: "",
  },
  projectAgentsMd: null,
  maxSystemContextBytes: 4096,
  managedPolicyAllowsHarness: true,
  managedPolicyOrganization: null,
  skills: [
    {
      id: "example",
      scope: "project",
      name: "Example",
      enabled: true,
      effectiveEnabled: true,
      overriddenByProject: false,
      userInvocable: true,
      userInvocationOnly: false,
      sourcePath: "/repo/.agents/skills/example/SKILL.md",
      contentDigest: "1",
      bytes: 8,
      body: "Overview",
      companionTruncated: true,
      files: [
        { relativePath: "scripts/check.sh", kind: "script", sizeBytes: 8, executable: true },
        { relativePath: "assets/logo.png", kind: "asset", sizeBytes: 24, executable: false },
      ],
    },
  ],
});
const proposals = Schema.decodeSync(HarnessHooksSnapshot)({
  hooksPath: "/harness/hooks.json",
  managedPolicyAllowsHarness: true,
  hooks: [
    {
      id: "review",
      event: "PreToolUse",
      source: "user",
      enabled: false,
      pendingApproval: true,
      target: { type: "command", command: "review" },
    },
  ],
});
const plugins = Schema.decodeSync(HarnessPluginsSnapshot)({
  pluginsDir: "/plugins",
  managedPolicyAllowsHarness: true,
  managedPolicyOrganization: null,
  plugins: [
    {
      id: "tools",
      name: "Project helper",
      version: "1",
      format: "t3-plugin",
      sourcePath: "/plugins/tools",
      contentDigest: "abc",
      trustedDigest: null,
      trustStatus: "untrusted",
      enabled: false,
      active: false,
      hasCommandHooks: false,
      hasStdioMcp: false,
      skillIds: [],
      ruleIds: [],
      commandIds: [],
      modeIds: [],
      hookIds: [],
      mcpServerIds: [],
      workflowFiles: [],
      lastError: null,
    },
  ],
});
const memory = Schema.decodeSync(HarnessMemorySnapshot)({
  memoryDir: "/notes",
  managedPolicyAllowsHarness: true,
  entries: [
    {
      id: "layout",
      title: "Layout note",
      tags: [],
      pinned: false,
      body: "Follow existing conventions.",
      bytes: 28,
      sourcePath: "/notes/layout.md",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ],
});
const success = <A,>(data: A) => Atom.make(AsyncResult.success(data));
vi.mock(import("../settings/SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: () =>
    ({
      scope: { kind: "project", members: [{ environmentId, workspaceRoot: "/repo" }] },
      environment: { environmentId, connection: { phase: "connected" } },
    }) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/harness"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    harnessEnvironment: {
      ...actual.harnessEnvironment,
      getDeliveryMatrix: {
        ...actual.harnessEnvironment.getDeliveryMatrix,
        permissionAtom: () => Atom.make(true),
      },
      readSkillFile: {
        ...actual.harnessEnvironment.readSkillFile,
        permissionAtom: () => Atom.make(true),
      },
      libraryQuery: () => success(fixture),
      pluginsQuery: () => success(plugins),
      memoryQuery: () => success(memory),
      hooksQuery: () => success(proposals),
      setHookEnabled: {
        ...actual.harnessEnvironment.setHookEnabled,
        run: (_registry, { input }) =>
          Effect.succeed({
            ...proposals,
            hooks: proposals.hooks.map((hook) =>
              hook.id === input.id && input.enabled
                ? { ...hook, enabled: true, pendingApproval: false }
                : hook,
            ),
          }),
      },
      deliveryMatrixQuery: () =>
        success([
          {
            providerInstanceId: "host-cli",
            driverKind: "test",
            displayName: "Host CLI",
            skillDelivery: "conditional-native" as const,
            mcpDelivery: "hybrid" as const,
            toolHooksDelivery: "gateway" as const,
            readsProjectAgentsMd: true,
          },
        ]),
      skillFileQuery: ({ environmentId: host, input }) =>
        success({
          path: input.relativePath,
          executable: false,
          sizeBytes: 24,
          binary: input.relativePath.endsWith(".png"),
          content: [host, input.scope, input.workspaceRoot, input.relativePath].join(" "),
        } as never),
    },
  };
});

it("reads the selected package member in project scope and approves a pending hook", async () => {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const harness = createRoute({
    getParentRoute: () => chat,
    path: "harness",
    validateSearch: (search) => ({ tab: search.tab }),
    component: HarnessWorkbench,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([harness])]),
    history: createMemoryHistory({ initialEntries: ["/harness?tab=context#harness-memory"] }),
  });
  await using screen = await render(
    <SidebarProvider>
      <RouterProvider router={router} />
    </SidebarProvider>,
    { router: false },
  ); // Workbench tabs navigate inside the named Harness route.
  await expect.element(screen.getByRole("button", { name: "Delete Layout note" })).toBeVisible();
  await expect.poll(() => router.state.location.hash).toBe("");
  expect(router.state.location.search).toMatchObject({ tab: "context" });
  await screen.getByRole("link", { name: "Skills & Plugins" }).click();
  await expect.element(screen.getByText("Host CLI · Conditional native")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Remove Project helper" })).toBeVisible();
  await screen.getByRole("button", { name: "Inspect files" }).click();
  await expect.element(screen.getByText("The server returned a partial file tree.")).toBeVisible();
  await screen.getByRole("button", { name: "check.sh [+x]" }).click();
  await expect
    .element(screen.getByText("test-server project /repo scripts/check.sh"))
    .toBeVisible();
  await screen.getByRole("button", { name: "logo.png" }).click();
  await expect.element(screen.getByText("Binary file · png · 24 bytes")).toBeVisible();
  await screen.getByRole("link", { name: "Context & Roles" }).click();
  await expect.element(screen.getByRole("button", { name: "Delete Layout note" })).toBeVisible();
  await screen.getByRole("link", { name: "Guardrails" }).click();
  await expect.element(screen.getByText("Pending hook proposal")).toBeVisible();
  await screen.getByRole("button", { name: "Approve & Enable" }).click();
  await expect.element(screen.getByText("Pending hook proposal")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("switch")).toBeChecked();
});
