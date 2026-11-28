import { describe, expect, it } from "vite-plus/test";

import { mobileAppLinkFiles } from "../../vite/mobileAppLinks";

const apple = ".well-known/apple-app-site-association.json";
const android = ".well-known/assetlinks.json";
const certificate = Array(32).fill("AB").join(":");

describe("mobile app association files", () => {
  it("publishes no signing identities without a configured link host", () => {
    expect(
      mobileAppLinkFiles({
        LIGHTNING_IOS_TEAM_ID: "ABCD123456",
        LIGHTNING_ANDROID_APP_LINK_SHA256_PRODUCTION: certificate,
      }),
    ).toEqual({
      [apple]: { applinks: { details: [] } },
      [android]: [],
    });
  });

  it("publishes Lightning variants and binds Android certificates to their own package", () => {
    const files = mobileAppLinkFiles({
      LIGHTNING_MOBILE_LINK_HOST: "app.lightning.example",
      LIGHTNING_IOS_TEAM_ID: "ABCD123456",
      LIGHTNING_ANDROID_APP_LINK_SHA256_PREVIEW: certificate.toLowerCase(),
    });
    expect(files[apple]).toEqual({
      applinks: {
        details: [
          {
            appIDs: [
              "ABCD123456.com.lightningcode.mobile.dev",
              "ABCD123456.com.lightningcode.mobile.preview",
              "ABCD123456.com.lightningcode.mobile",
            ],
            components: [{ "/": "/threads/*" }],
          },
        ],
      },
    });
    expect(files[android]).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.lightningcode.mobile.preview",
          sha256_cert_fingerprints: [certificate],
        },
      },
    ]);
  });

  it("rejects invalid fingerprints for a configured host", () => {
    expect(() =>
      mobileAppLinkFiles({
        LIGHTNING_MOBILE_LINK_HOST: "app.lightning.example",
        LIGHTNING_ANDROID_APP_LINK_SHA256_PRODUCTION: "AB:CD",
      }),
    ).toThrow("LIGHTNING_ANDROID_APP_LINK_SHA256_PRODUCTION");
  });
});
