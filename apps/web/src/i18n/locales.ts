import { resolveLocale } from "@t3tools/client-runtime/locales";

import gtConfig from "../../gt.config.json";

export const DEFAULT_LOCALE = gtConfig.defaultLocale;
export const SUPPORTED_LOCALES: ReadonlyArray<string> = [DEFAULT_LOCALE, ...gtConfig.locales];

// GT skips lookups when source and target are the same dialect. Keep the settings
// value "en" while resolving branded English as a translation of upstream English.
export const GT_SOURCE_LOCALE = "en-GB";
export const GT_ENGLISH_LOCALE = "en-US";

export function gtCatalogLocale(locale: string) {
  return locale === DEFAULT_LOCALE ? GT_ENGLISH_LOCALE : locale;
}

export function resolveWebLocaleSelection(language: string, browserLocales: ReadonlyArray<string>) {
  const catalogLocale = resolveLocale(language, browserLocales, SUPPORTED_LOCALES, DEFAULT_LOCALE);
  // Undefined formats with the host locale: "system", and English over a regional English browser.
  const keepEnglishRegion =
    language === DEFAULT_LOCALE && /^en(?:-|$)/i.test(browserLocales[0] ?? "");
  const formattingLocale = language === catalogLocale && !keepEnglishRegion ? language : undefined;
  return { catalogLocale, formattingLocale };
}
