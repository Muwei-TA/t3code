import Constants from "expo-constants";
import { type ReleaseChannel, releaseResourceAttributes } from "@t3tools/shared/releaseResource";
import * as RelayTracing from "@t3tools/shared/relayTracing";

import { hasTracingPublicConfig, resolveCloudPublicConfig } from "../cloud/publicConfig";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly serviceInstanceId: string;
  readonly appVariant: string;
}

const RELEASE_CHANNEL_BY_VARIANT: Readonly<Record<string, ReleaseChannel | undefined>> = {
  development: "dev",
  preview: "preview",
  production: "stable",
};

export function resolveTracingConfig(): TracingConfig | null {
  const config = resolveCloudPublicConfig();
  if (!hasTracingPublicConfig(config)) {
    return null;
  }
  const { tracesUrl, tracesDataset, tracesToken } = config.observability;
  return { tracesUrl, tracesDataset, tracesToken };
}

export function layerFromConfig(
  config: TracingConfig | null,
  resource: TracingResource,
  isEnabled?: () => boolean,
) {
  const channel =
    typeof __DEV__ !== "undefined" && __DEV__
      ? "dev"
      : RELEASE_CHANNEL_BY_VARIANT[resource.appVariant];
  return RelayTracing.layer(
    config,
    {
      serviceName: "t3code-mobile",
      serviceVersion: resource.serviceVersion,
      runtime: "react-native",
      serviceInstanceId: resource.serviceInstanceId,
      client: `mobile-${resource.appVariant}`,
      attributes: channel && releaseResourceAttributes(channel),
    },
    isEnabled ? { isEnabled } : undefined,
  );
}

const config = resolveTracingConfig();
export const relayTracingAvailable = config !== null;
let relayTracingEnabled = false;
let preferenceUpdated = false;

export function setRelayTracingEnabled(enabled: boolean) {
  preferenceUpdated = true;
  relayTracingEnabled = enabled;
}

if (relayTracingAvailable) {
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then((preferences) => {
      if (!preferenceUpdated) relayTracingEnabled = preferences.relayTracingEnabled === true;
    })
    .catch((error: unknown) => console.warn("[tracing] could not read trace preference", error));
}

export const layer = layerFromConfig(
  config,
  {
    serviceVersion: Constants.expoConfig?.version,
    serviceInstanceId: Constants.sessionId,
    appVariant:
      typeof Constants.expoConfig?.extra?.appVariant === "string"
        ? Constants.expoConfig.extra.appVariant
        : "unknown",
  },
  () => relayTracingEnabled,
);
