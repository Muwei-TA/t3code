import Constants from "expo-constants";

const configuredOrigin: unknown = Constants.expoConfig?.extra?.hostedThreadLinkOrigin;
export const hostedThreadLinkOrigin =
  typeof configuredOrigin === "string" ? configuredOrigin : undefined;
