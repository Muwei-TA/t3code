import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ServerConfig, type ManagedPolicySummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createContext, use } from "react";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import type { EnvironmentPresentation } from "../../state/environments";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { GeneralSettingsPanel } from "./SettingsPanels";

vi.mock(import("../../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  resolveRelayTracingConfig: () => ({
    tracesUrl: "https://traces.example.test",
    tracesDataset: "test",
    tracesToken: "test",
  }),
}));

const TestEnvironments = createContext<EnvironmentPresentation[]>([]);
const decodeServerConfig = Schema.decodeSync(ServerConfig);

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: use(TestEnvironments),
    presentationById: new Map(),
  }),
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentsWithScope: (environments) =>
    new Set(environments.map(({ environmentId }) => environmentId)),
}));

const PREFERENCE_KEY = "t3code.relay-tracing-enabled";

function withoutRelayPreference() {
  const previous = localStorage.getItem(PREFERENCE_KEY);
  localStorage.removeItem(PREFERENCE_KEY);
  return {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(PREFERENCE_KEY);
      else localStorage.setItem(PREFERENCE_KEY, previous);
    },
  };
}

function renderGeneralSettings(environments: EnvironmentPresentation[] = []) {
  return render(
    <TestEnvironments value={environments}>
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <GeneralSettingsPanel />
      </SettingsScopeProvider>
    </TestEnvironments>,
  );
}

function machine(
  label: string,
  enabled: boolean,
  options?: {
    override?: boolean;
    supported?: boolean;
    managedPolicy?: ManagedPolicySummary;
  },
): EnvironmentPresentation {
  const environmentId = EnvironmentId.make(label);
  return {
    environmentId,
    label,
    displayUrl: "http://localhost:12345",
    relayManaged: false,
    entry: {
      target: new PrimaryConnectionTarget({
        environmentId,
        label,
        httpBaseUrl: "http://localhost:12345",
        wsBaseUrl: "ws://localhost:12345/ws",
      }),
      profile: Option.none(),
      enabled: true,
    },
    connection: { phase: "connected", error: null, traceId: null },
    refusedRouteIds: [],
    serverConfig: decodeServerConfig({
      environment: {
        environmentId,
        label,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "1.0.0",
        orchestrationProtocolVersion: 2,
        capabilities: { productTelemetrySettings: options?.supported ?? true },
      },
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
      cwd: "/workspace/browser",
      keybindingsConfigPath: "/workspace/keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/workspace/logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: { productTelemetryEnabled: enabled },
      ...(options?.override === undefined
        ? {}
        : { productTelemetry: { envOverride: options.override } }),
      ...(options?.managedPolicy === undefined ? {} : { managedPolicy: options.managedPolicy }),
    }),
  };
}

it.each([
  { reason: "different saved settings", laptopEnabled: true, serverEnabled: false },
  { reason: "managed policy", laptopEnabled: true, serverEnabled: true, managed: true },
  { reason: "an env override", laptopEnabled: false, serverEnabled: false, override: true },
])(
  "shows mixed effective telemetry with $reason",
  async ({ laptopEnabled, serverEnabled, managed, override }) => {
    await using screen = await renderGeneralSettings([
      machine("Laptop", laptopEnabled, override === undefined ? undefined : { override }),
      machine(
        "Server",
        serverEnabled,
        managed === undefined
          ? undefined
          : {
              managedPolicy: {
                organization: "Test administrator",
                lockedSettings: [],
                limits: { telemetry: false },
              },
            },
      ),
    ]);
    const toggle = screen.getByRole("switch", { name: "Send product usage data" });
    await expect.element(toggle).toHaveAttribute("aria-checked", "mixed");
    if (override === undefined) await expect.element(toggle).toBeEnabled();
    else await expect.element(toggle).toBeDisabled();
  },
);

it.each([false, true])("shows and locks managed product usage data set to %s", async (enabled) => {
  await using screen = await renderGeneralSettings([
    machine("Server", enabled, {
      managedPolicy: {
        organization: "Test administrator",
        lockedSettings: ["productTelemetryEnabled"],
      },
    }),
  ]);

  const toggle = screen.getByLabelText("Send product usage data");
  await expect.element(toggle).toHaveAttribute("aria-checked", String(enabled));
  await expect.element(toggle).toBeDisabled();
  await expect.element(screen.getByText("Managed by Test administrator.")).toBeVisible();
});

it.each([false, true])("shows and locks a telemetry env override of %s", async (override) => {
  await using screen = await renderGeneralSettings([machine("Server", !override, { override })]);

  const toggle = screen.getByRole("switch", { name: "Send product usage data" });
  await expect.element(toggle).toHaveAttribute("aria-checked", String(override));
  await expect.element(toggle).toBeDisabled();
  await expect
    .element(screen.getByText("T3CODE_TELEMETRY_ENABLED is explicitly set on a selected machine."))
    .toBeVisible();
});

it("keeps the product usage row visible in a mixed-version scope", async () => {
  await using screen = await renderGeneralSettings([
    machine("Current", false),
    machine("Older", false, { supported: false }),
  ]);

  const toggle = screen.getByRole("switch", { name: "Send product usage data" });
  await expect.element(toggle).toBeVisible();
  await expect.element(toggle).toBeDisabled();
  await expect
    .element(
      screen.getByText("All selected connected machines must support product usage settings."),
    )
    .toBeVisible();
});

it.each([false, true])("waits for desktop diagnostics permission (%s)", async (allowed) => {
  using _preference = withoutRelayPreference();
  const readHost = vi.fn<() => boolean | null>().mockReturnValue(null);
  using _bridge = stubGlobal("desktopBridge", {
    getRelayTelemetryEnabled: readHost,
    getClientSettings: async () => null,
  });
  await using screen = await renderGeneralSettings();

  const toggle = screen.getByRole("switch", { name: "Send T3 Connect diagnostics" });
  await expect.element(toggle).toBeDisabled();
  await expect
    .element(screen.getByText("Checking whether this desktop host", { exact: false }))
    .toBeVisible();

  readHost.mockReturnValue(allowed);
  if (allowed) {
    await expect.element(toggle).toBeEnabled();
    await expect.element(toggle).toBeChecked();
  } else {
    await expect
      .element(screen.getByText("T3CODE_TELEMETRY_ENABLED=true", { exact: false }))
      .toBeVisible();
    await expect.element(toggle).toBeDisabled();
    await expect.element(toggle).not.toBeChecked();
  }
  expect(localStorage.getItem(PREFERENCE_KEY)).toBeNull();
});

it("uses an opt-in switch in the browser", async () => {
  using _preference = withoutRelayPreference();
  await using screen = await renderGeneralSettings();
  const toggle = screen.getByRole("switch", { name: "Send T3 Connect diagnostics" });
  await expect.element(toggle).not.toBeChecked();

  await toggle.click();
  await expect.element(toggle).toBeChecked();
  expect(localStorage.getItem(PREFERENCE_KEY)).toBe("true");

  await toggle.click();
  await expect.element(toggle).not.toBeChecked();
  expect(localStorage.getItem(PREFERENCE_KEY)).toBe("false");
});
