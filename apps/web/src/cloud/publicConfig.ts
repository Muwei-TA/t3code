import {
  clerkFrontendApiHostnameFromPublishableKey,
  relayClerkTokenOptions,
} from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: trimNonEmpty(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
    ),
    clerkJwtTemplate: trimNonEmpty(import.meta.env.VITE_CLERK_JWT_TEMPLATE as string | undefined),
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

const RELAY_TRACING_PREFERENCE = "t3code.relay-tracing-enabled";
const desktopRelayTelemetry = new WeakMap<NonNullable<Window["desktopBridge"]>, boolean>();
let relayTracingOptedOutForSession = false;
const relayTracingListeners = new Set<() => void>();

function readRelayTracingPreference(): boolean | undefined {
  if (relayTracingOptedOutForSession) return false;
  try {
    const value = window.localStorage.getItem(RELAY_TRACING_PREFERENCE);
    return value === "true" ? true : value === "false" ? false : undefined;
  } catch {
    return false;
  }
}

function desktopRelayTelemetryAllowed() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (bridge === undefined) return undefined;
  const cached = desktopRelayTelemetry.get(bridge);
  if (cached !== undefined) return cached;
  const allowed = bridge.getRelayTelemetryEnabled();
  if (allowed !== null) desktopRelayTelemetry.set(bridge, allowed);
  return allowed;
}

export function setRelayTracingPreference(enabled: boolean) {
  if (enabled) {
    const hostAllowed = desktopRelayTelemetryAllowed();
    if (hostAllowed === false || hostAllowed === null) return;
  }
  if (!enabled) relayTracingOptedOutForSession = true;
  try {
    window.localStorage.setItem(RELAY_TRACING_PREFERENCE, String(enabled));
    relayTracingOptedOutForSession = false;
  } finally {
    for (const listener of relayTracingListeners) listener();
  }
}

/** Whether relay spans may be exported now; the desktop host may not know yet at startup. */
export function relayTelemetryEnabled(): boolean | null {
  if (typeof window === "undefined") return false;
  const preference = readRelayTracingPreference();
  if (preference === false) return false;
  const hostAllowed = desktopRelayTelemetryAllowed();
  return hostAllowed === undefined ? preference === true : hostAllowed;
}

export function getRelayTracingStatus() {
  const hostAllowed = desktopRelayTelemetryAllowed();
  if (hostAllowed === null) return "pending";
  if (hostAllowed === false) return "host-disabled";
  return relayTelemetryEnabled() ? "enabled" : "disabled";
}

export function subscribeRelayTracingStatus(onChange: () => void) {
  relayTracingListeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === RELAY_TRACING_PREFERENCE || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);

  // The synchronous bridge reports null until login shell discovery settles.
  const timer =
    desktopRelayTelemetryAllowed() === null
      ? window.setInterval(() => {
          if (desktopRelayTelemetryAllowed() === null) return;
          window.clearInterval(timer);
          onChange();
        }, 250)
      : undefined;
  return () => {
    relayTracingListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
    window.clearInterval(timer);
  };
}

export function resolveRelayTracingConfig() {
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  if (!config.clerkPublishableKey || !config.clerkJwtTemplate || !config.relayUrl) {
    return false;
  }

  // Electron has its own auth runtime; development keys also support private browser origins.
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !config.clerkPublishableKey.startsWith("pk_live_")
  ) {
    return true;
  }

  try {
    // Custom Frontend API hosts use clerk.<production domain>.
    const domain = clerkFrontendApiHostnameFromPublishableKey(config.clerkPublishableKey).replace(
      /^clerk\./u,
      "",
    );
    const { hostname, protocol, port } = window.location;
    return (
      protocol === "https:" &&
      port === "" &&
      (hostname === domain || hostname.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}
