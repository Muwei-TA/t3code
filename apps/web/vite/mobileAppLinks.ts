import {
  MOBILE_APP_IDENTITIES,
  MOBILE_THREAD_LINK_PATH_PREFIX,
  parseMobileIosTeamId,
  parseMobileLinkHost,
} from "@t3tools/shared/mobileBrand";
import type { Plugin } from "vite-plus";

function androidAppLink(identifier: string, envKey: string, value: string | undefined) {
  if (!value?.trim()) return [];
  const fingerprints = value.split(",").map((fingerprint) => fingerprint.trim().toUpperCase());
  if (fingerprints.some((fingerprint) => !/^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/.test(fingerprint))) {
    throw new Error(`${envKey} must contain comma-separated SHA-256 certificate fingerprints.`);
  }
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: identifier,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

export function mobileAppLinkFiles(env: Readonly<Record<string, string | undefined>>) {
  const host = parseMobileLinkHost(env.LIGHTNING_MOBILE_LINK_HOST);
  const teamId = host ? parseMobileIosTeamId(env.LIGHTNING_IOS_TEAM_ID) : undefined;
  const identities = MOBILE_APP_IDENTITIES;
  const details = teamId
    ? [
        {
          appIDs: Object.values(identities).map(({ identifier }) => `${teamId}.${identifier}`),
          components: [{ "/": `${MOBILE_THREAD_LINK_PATH_PREFIX}*` }],
        },
      ]
    : [];
  const android = host
    ? Object.entries(identities).flatMap(([variant, { identifier }]) => {
        const key = `LIGHTNING_ANDROID_APP_LINK_SHA256_${variant.toUpperCase()}`;
        return androidAppLink(identifier, key, env[key]);
      })
    : [];
  return {
    ".well-known/apple-app-site-association.json": { applinks: { details } },
    ".well-known/assetlinks.json": android,
  };
}

export function mobileAppLinksPlugin(env: Readonly<Record<string, string | undefined>>): Plugin {
  return {
    name: "lightning-mobile-app-links",
    apply: "build",
    generateBundle() {
      for (const [fileName, contents] of Object.entries(mobileAppLinkFiles(env))) {
        this.emitFile({
          type: "asset",
          fileName,
          source: `${JSON.stringify(contents, null, 2)}\n`,
        });
      }
    },
  };
}
