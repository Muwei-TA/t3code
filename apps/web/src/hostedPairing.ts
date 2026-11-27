import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "@t3tools/shared/remote";
import { parseUrl } from "@t3tools/shared/url";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export type HostedAppChannel = "latest" | "nightly";

export function configuredHostedAppUrl(): string {
  return import.meta.env.VITE_HOSTED_APP_URL?.trim() || DEFAULT_HOSTED_APP_URL;
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "nightly" ? channel : null;
}

export function isHostedStaticApp(url?: URL): boolean {
  if (configuredBackendUrl()) {
    return false;
  }

  if (configuredHostedAppChannel()) {
    return true;
  }

  if (url === undefined && (typeof window === "undefined" || window.location === undefined)) {
    return false;
  }

  const hostedOrigin = parseUrl(configuredHostedAppUrl())?.origin;
  return (
    hostedOrigin !== undefined && (url ?? new URL(window.location.href)).origin === hostedOrigin
  );
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string | null {
  const hostedApp = parseUrl(import.meta.env.VITE_HOSTED_APP_URL?.trim() ?? "");
  if (
    hostedApp === null ||
    (hostedApp.protocol !== "https:" &&
      !(hostedApp.protocol === "http:" && isLocalLoopbackHost(hostedApp.hostname)))
  ) {
    return null;
  }
  const url = new URL("/pair", hostedApp.origin);
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildHostedChannelSelectionUrl(input: {
  readonly channel: HostedAppChannel;
}): string {
  const url = new URL("/__t3code/channel", configuredHostedAppUrl());
  url.searchParams.set("channel", input.channel);
  return url.toString();
}
