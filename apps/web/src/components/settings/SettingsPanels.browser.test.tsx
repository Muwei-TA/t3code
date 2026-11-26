import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
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

function renderGeneralSettings() {
  return render(
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <GeneralSettingsPanel />
    </SettingsScopeProvider>,
  );
}

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
