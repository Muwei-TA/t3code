import { LIGHTNING_BRAND } from "@t3tools/shared/brand";

export const PRIVACY_POLICY_URL = LIGHTNING_BRAND.websiteUrl
  ? new URL("/privacy-policy", LIGHTNING_BRAND.websiteUrl).href
  : null;
