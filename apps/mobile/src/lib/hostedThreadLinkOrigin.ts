import Constants from "expo-constants";
import { MOBILE_APP_IDENTITIES, MOBILE_THREAD_LINK_PATH_PREFIX } from "@t3tools/shared/mobileBrand";

const configuredOrigin: unknown = Constants.expoConfig?.extra?.hostedThreadLinkOrigin;
export const hostedThreadLinkOrigin =
  typeof configuredOrigin === "string" ? configuredOrigin : undefined;

const variant: unknown = Constants.expoConfig?.extra?.appVariant;
export const mobileAppScheme =
  MOBILE_APP_IDENTITIES[variant === "development" || variant === "preview" ? variant : "production"]
    .scheme;

export const hostedThreadLinkPrefix = hostedThreadLinkOrigin
  ? `${hostedThreadLinkOrigin}${MOBILE_THREAD_LINK_PATH_PREFIX}`
  : "";

export const mobileThreadShareOptions = {
  hostedAppUrl: hostedThreadLinkOrigin,
  appScheme: mobileAppScheme,
};
