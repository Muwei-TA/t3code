import { T, useGT } from "gt-react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { APP_BASE_NAME } from "../branding";
import { I18nProvider } from "./I18nProvider";
import { getI18nSnapshot, startI18n, whenLocaleReady } from "./runtime";
import { SUPPORTED_LOCALES } from "./locales";

const { settings, subscribe } = vi.hoisted(() => ({
  settings: { language: "en" },
  subscribe: vi.fn<(_callback: () => void) => void>(),
}));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => settings,
  subscribeClientSettings: subscribe,
  updateClientSettings: vi.fn(),
}));

function BrandCopy() {
  const gt = useGT();
  return (
    <>
      <h1>
        <T>Welcome to T3 Code</T>
      </h1>
      <p>{gt("Overridden by t3.json.")}</p>
    </>
  );
}

it("renders branded English and loads all catalogs without rewriting configuration filenames", async () => {
  startI18n();
  await whenLocaleReady();
  await using screen = await render(
    <I18nProvider>
      <BrandCopy />
    </I18nProvider>,
  );
  await expect
    .element(screen.getByRole("heading"))
    .toHaveTextContent(`Welcome to ${APP_BASE_NAME}`);
  await expect.element(screen.getByText("Overridden by t3.json.")).toBeVisible();
  for (const language of SUPPORTED_LOCALES) {
    settings.language = language;
    subscribe.mock.lastCall![0]();
    await whenLocaleReady();
    const catalog = getI18nSnapshot().translations[language];
    const serialized = JSON.stringify(catalog);
    expect(serialized).toContain("Lightning Code");
    expect(serialized).not.toContain("T3 Code");
    expect(serialized).toContain("t3.json");
  }
});
