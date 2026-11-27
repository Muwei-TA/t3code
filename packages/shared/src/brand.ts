export interface ProductBrandManifest {
  readonly id: "lightning-code";
  readonly baseName: "Lightning Code";
  readonly shortName: "Lightning";
  readonly slug: "lightning-code";
  readonly cliCommand: "lightning";
  readonly defaultHomeDirName: ".lightning-code";
  readonly homeEnvVar: "LIGHTNING_CODE_HOME";
  readonly portEnvVar: "LIGHTNING_CODE_PORT";
  readonly defaultPort: 3775;
  readonly defaultDevWebPort: 5735;
  readonly urlScheme: "lightningcode";
  readonly desktopAppId: "com.lightningcode.desktop";
  readonly desktopDevAppId: "com.lightningcode.desktop.dev";
  readonly linuxDesktopEntryName: "com.lightningcode.LightningCode.desktop";
  readonly linuxDevDesktopEntryName: "com.lightningcode.LightningCode.Development.desktop";
  readonly otlpServiceName: "lightning-code-server";
  readonly otlpNamespace: "lightning-code";
  readonly defaultThemeId: "lightning";
  readonly storagePrefix: "lightning-code";
  readonly repositoryUrl: "https://github.com/Muwei-TA/t3code";
  readonly upstreamRepositoryUrl: "https://github.com/pingdotgg/t3code";
  readonly websiteUrl: string | null;
  readonly downloadUrl: string | null;
  readonly mobileAppUrl: string | null;
  readonly cloudFeaturesEnabledByDefault: false;
  readonly telemetryEnabledByDefault: false;
  readonly autoUpdateEnabledByDefault: false;
}

export const LIGHTNING_BRAND: ProductBrandManifest = {
  id: "lightning-code",
  baseName: "Lightning Code",
  shortName: "Lightning",
  slug: "lightning-code",
  cliCommand: "lightning",
  defaultHomeDirName: ".lightning-code",
  homeEnvVar: "LIGHTNING_CODE_HOME",
  portEnvVar: "LIGHTNING_CODE_PORT",
  defaultPort: 3775,
  defaultDevWebPort: 5735,
  urlScheme: "lightningcode",
  desktopAppId: "com.lightningcode.desktop",
  desktopDevAppId: "com.lightningcode.desktop.dev",
  linuxDesktopEntryName: "com.lightningcode.LightningCode.desktop",
  linuxDevDesktopEntryName: "com.lightningcode.LightningCode.Development.desktop",
  otlpServiceName: "lightning-code-server",
  otlpNamespace: "lightning-code",
  defaultThemeId: "lightning",
  storagePrefix: "lightning-code",
  repositoryUrl: "https://github.com/Muwei-TA/t3code",
  upstreamRepositoryUrl: "https://github.com/pingdotgg/t3code",
  websiteUrl: null,
  downloadUrl: null,
  mobileAppUrl: null,
  cloudFeaturesEnabledByDefault: false,
  telemetryEnabledByDefault: false,
  autoUpdateEnabledByDefault: false,
};

export interface BrandCopyRewriteOptions {
  readonly preserveUpstreamLicenseContext?: boolean;
}

const UPSTREAM_LICENSE_PATTERN = /\bT3 Tools Inc\.?\b|MIT License|Copyright \(c\)/i;
const PRODUCT_NAME_PATTERN = /\bT3 Code\b/g;

/**
 * Deterministically rewrites user-facing upstream brand copy ("T3 Code" -> "Lightning Code")
 * while preserving code/file identifiers (`t3.json`, `T3_WORKTREE_*`, `t3_code_*`, `@t3tools/*`)
 * and upstream MIT license notices. Used by runtime i18n loaders so upstream translation JSONs
 * stay zero-diff for low-cost upstream merges.
 */
export function normalizeBrandCopy(text: string, options: BrandCopyRewriteOptions = {}): string {
  if (!text.includes("T3 Code")) {
    return text;
  }
  if (options.preserveUpstreamLicenseContext !== false && UPSTREAM_LICENSE_PATTERN.test(text)) {
    return text;
  }
  return text.replace(PRODUCT_NAME_PATTERN, LIGHTNING_BRAND.baseName);
}

/**
 * Recursively normalizes string values in a loaded i18n translation catalog without mutating keys.
 */
export function normalizeTranslationCatalog<T>(catalog: T): T {
  if (typeof catalog === "string") {
    return normalizeBrandCopy(catalog) as T;
  }
  if (Array.isArray(catalog)) {
    return catalog.map((item) => normalizeTranslationCatalog(item)) as T;
  }
  if (catalog !== null && typeof catalog === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(catalog)) {
      out[key] = normalizeTranslationCatalog(value);
    }
    return out as T;
  }
  return catalog;
}
