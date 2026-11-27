import { expect, it, vi } from "vite-plus/test";
import { LIGHTNING_BRAND } from "@t3tools/shared/brand";

it("uses the renderer brand on desktop and manifest defaults in the browser", async () => {
  vi.stubGlobal("window", {});
  try {
    vi.resetModules();
    const web = await import("./branding");
    expect(web.APP_BASE_NAME).toBe(LIGHTNING_BRAND.baseName);
    expect(web.DESKTOP_DOWNLOAD_URL).toBeNull();
    expect(web.MOBILE_APP_URL).toBeNull();

    const injected = { baseName: "Custom", displayName: "Custom Dev", stageLabel: "Dev" };
    vi.stubGlobal("window", { desktopBridge: { getAppBranding: () => injected } });
    vi.resetModules();
    const desktop = await import("./branding");
    expect(desktop.APP_BASE_NAME).toBe(injected.baseName);
    expect(desktop.APP_DISPLAY_NAME).toBe(injected.displayName);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
