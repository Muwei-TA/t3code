import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });

  it.each([
    undefined,
    "",
    "invalid",
    "ftp://example.com",
    "http://example.com",
    "blob:https://example.com/app",
  ])("keeps credentials on the HTTPS backend when the hosted app URL is %j", (hostedAppUrl) => {
    vi.stubEnv("VITE_HOSTED_APP_URL", hostedAppUrl);
    const backend = "https://host.tailnet.example.ts.net:3773";

    expect(resolveHostedPairingUrl(backend, "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl(`${backend}/settings?host=elsewhere`, "PAIRCODE")).toBe(
      `${backend}/pair#token=PAIRCODE`,
    );
  });

  it("allows an explicitly configured loopback hosted app for development", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "http://localhost:5173");
    expect(resolveHostedPairingUrl("https://backend.example.com", "PAIRCODE")).toBe(
      "http://localhost:5173/pair?host=https%3A%2F%2Fbackend.example.com#token=PAIRCODE",
    );
  });
});
