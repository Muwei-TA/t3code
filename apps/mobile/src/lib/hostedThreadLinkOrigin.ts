import Constants from "expo-constants";
import { MOBILE_APP_IDENTITIES } from "@t3tools/shared/mobileBrand";

const configuredOrigin: unknown = Constants.expoConfig?.extra?.hostedThreadLinkOrigin;
export const hostedThreadLinkOrigin =
  typeof configuredOrigin === "string" ? configuredOrigin : undefined;

const variant: unknown = Constants.expoConfig?.extra?.appVariant;
export const mobileAppScheme =
  MOBILE_APP_IDENTITIES[variant === "development" || variant === "preview" ? variant : "production"]
    .scheme;
