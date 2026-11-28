import { LIGHTNING_BRAND } from "./brand.ts";

const mobileIdentifier = "com.lightningcode.mobile";

export const MOBILE_APP_IDENTITIES = {
  development: {
    appName: `${LIGHTNING_BRAND.baseName} Dev`,
    identifier: `${mobileIdentifier}.dev`,
    scheme: `${LIGHTNING_BRAND.urlScheme}-dev`,
  },
  preview: {
    appName: `${LIGHTNING_BRAND.baseName} Preview`,
    identifier: `${mobileIdentifier}.preview`,
    scheme: `${LIGHTNING_BRAND.urlScheme}-preview`,
  },
  production: {
    appName: LIGHTNING_BRAND.baseName,
    identifier: mobileIdentifier,
    scheme: LIGHTNING_BRAND.urlScheme,
  },
} as const;

export const MOBILE_DEV_IOS_ARTIFACT = "LightningCodeDev.app";
export const MOBILE_THREAD_LINK_PATH_PREFIX = "/threads/";

export function parseMobileLinkHost(
  value: string | undefined,
  variable = "LIGHTNING_MOBILE_LINK_HOST",
): string | undefined {
  const host = value?.trim().toLowerCase();
  if (!host) return undefined;
  if (URL.parse(`https://${host}`)?.hostname !== host) {
    throw new Error(`${variable} must be a hostname.`);
  }
  return host;
}

export function parseMobileIosTeamId(value: string | undefined): string | undefined {
  const teamId = value?.trim();
  if (!teamId) return undefined;
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("LIGHTNING_IOS_TEAM_ID must be a 10-character Apple Team ID.");
  }
  return teamId;
}
