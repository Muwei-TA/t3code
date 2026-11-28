import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ ...process.env }),
}));

beforeEach(() => {
  vi.stubEnv("LIGHTNING_MOBILE_EAS_PROJECT_ID", undefined);
  vi.stubEnv("LIGHTNING_MOBILE_EAS_OWNER", undefined);
  vi.stubEnv("LIGHTNING_MOBILE_CLERK_DOMAIN", undefined);
  vi.stubEnv("T3CODE_MOBILE_UPDATES_ENABLED", undefined);
  vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined, host?: string, team?: string) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  vi.stubEnv("LIGHTNING_MOBILE_LINK_HOST", host);
  vi.stubEnv("LIGHTNING_IOS_TEAM_ID", team);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.lightningcode.mobile", "lightningcode"],
  ["development", "com.lightningcode.mobile.dev", "lightningcode-dev"],
  ["preview", "com.lightningcode.mobile.preview", "lightningcode-preview"],
  ["production", "com.lightningcode.mobile", "lightningcode"],
])("uses Lightning identifiers for APP_VARIANT=%j", async (value, identifier, scheme) => {
  const host = "lightning.example.com";
  const team = "AB12CD34EF";
  const config = await loadConfig(value, host, team);
  expect(config.ios).toMatchObject({ bundleIdentifier: identifier, appleTeamId: team });
  expect(config.android?.package).toBe(identifier);
  expect(config.scheme).toBe(scheme);
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(config.extra?.hostedThreadLinkOrigin).toBe(`https://${host}`);
});

it("does not claim HTTPS thread links without a Lightning host", async () => {
  const config = await loadConfig("production");
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.android?.intentFilters).toBeUndefined();
  expect(config.extra?.hostedThreadLinkOrigin).toBeUndefined();
});

it("only configures iOS HTTPS thread links for a configured signing team", async () => {
  const host = "lightning.example.com";
  const config = await loadConfig("production", host);
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.android?.intentFilters).toHaveLength(1);
});

it("keeps a source build independent of a hosted EAS project and Clerk relying party", async () => {
  const config = await loadConfig("production");

  expect(config.slug).toBe("lightning-code");
  expect(config.owner).toBeUndefined();
  expect(config.updates).toEqual({ enabled: false });
  expect(config.extra?.eas.projectId).toBeUndefined();
  expect(config.ios?.associatedDomains).toBeUndefined();
});

it("links an explicit EAS project and Clerk relying party", async () => {
  const projectId = "abcdef12-1234-4321-a1b2-123456789abc";
  vi.stubEnv("LIGHTNING_MOBILE_EAS_PROJECT_ID", projectId);
  vi.stubEnv("LIGHTNING_MOBILE_EAS_OWNER", "lightning-account");
  vi.stubEnv("LIGHTNING_MOBILE_CLERK_DOMAIN", "auth.lightning.example");
  const config = await loadConfig("production");

  expect(config.owner).toBe("lightning-account");
  expect(config.extra?.eas.projectId).toBe(projectId);
  expect(config.updates).toMatchObject({ enabled: true, url: `https://u.expo.dev/${projectId}` });
  expect(config.ios?.associatedDomains).toEqual([
    "applinks:auth.lightning.example",
    "webcredentials:auth.lightning.example",
  ]);

  vi.stubEnv("T3CODE_MOBILE_UPDATES_ENABLED", "0");
  expect((await loadConfig("production")).updates?.enabled).toBe(false);
});
