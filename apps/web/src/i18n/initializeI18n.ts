import { LIGHTNING_BRAND } from "@t3tools/shared/brand";
import { initializeGTSPA } from "gt-react";

import { GT_SOURCE_LOCALE, GT_ENGLISH_LOCALE, gtCatalogLocale, SUPPORTED_LOCALES } from "./locales";

declare const __LIGHTNING_ENGLISH_COPY__: Record<string, unknown>;

async function loadTranslations(locale: string): Promise<unknown> {
  if (locale === GT_ENGLISH_LOCALE) return __LIGHTNING_ENGLISH_COPY__;
  const module: { default: Record<string, unknown> } = await import(
    `./translations/${locale}.json`
  );
  // Swedish attaches the possessive s to the name, outside the shared whole-word rule.
  if (locale === "sv") {
    return Object.fromEntries(
      Object.entries(module.default).map(([key, value]) => [
        key,
        typeof value === "string"
          ? value.replace(/\bT3 Codes\b/g, `${LIGHTNING_BRAND.baseName}s`)
          : value,
      ]),
    );
  }
  return module.default;
}

/** Sets up GT's singletons. `onLocaleRequest` receives GT's own locale changes. */
export function initializeI18n(onLocaleRequest: (locale: string) => void): void {
  void initializeGTSPA({
    defaultLocale: GT_SOURCE_LOCALE,
    locales: SUPPORTED_LOCALES.map(gtCatalogLocale),
    locale: GT_ENGLISH_LOCALE,
    loadTranslations,
    // GT's default drops a catalog from its cache after 60 s; call-time `m()` reads that cache.
    cacheExpiryTime: null,
    _reload: (state) => onLocaleRequest(state.locale),
  });
}
