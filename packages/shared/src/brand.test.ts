import { describe, expect, it } from "vite-plus/test";

import { LIGHTNING_BRAND, normalizeBrandCopy, normalizeTranslationCatalog } from "./brand.ts";

describe("LIGHTNING_BRAND", () => {
  it("defines isolated runtime defaults distinct from upstream T3 Code", () => {
    expect(LIGHTNING_BRAND.baseName).toBe("Lightning Code");
    expect(LIGHTNING_BRAND.defaultHomeDirName).toBe(".lightning-code");
    expect(LIGHTNING_BRAND.homeEnvVar).toBe("LIGHTNING_CODE_HOME");
    expect(LIGHTNING_BRAND.portEnvVar).toBe("LIGHTNING_CODE_PORT");
    expect(LIGHTNING_BRAND.defaultPort).toBe(3775);
    expect(LIGHTNING_BRAND.defaultDevWebPort).toBe(5735);
    expect(LIGHTNING_BRAND.defaultThemeId).toBe("lightning");
    expect(LIGHTNING_BRAND.cloudFeaturesEnabledByDefault).toBe(false);
    expect(LIGHTNING_BRAND.telemetryEnabledByDefault).toBe(false);
    expect(LIGHTNING_BRAND.autoUpdateEnabledByDefault).toBe(false);
  });
});

describe("normalizeBrandCopy", () => {
  it("rewrites user-facing T3 Code mentions across English, German compounds, and CJK strings", () => {
    expect(normalizeBrandCopy("T3 Code home")).toBe("Lightning Code home");
    expect(normalizeBrandCopy("欢迎使用 T3 Code (Beta)")).toBe("欢迎使用 Lightning Code (Beta)");
    expect(normalizeBrandCopy("T3 Code を開く")).toBe("Lightning Code を開く");
    expect(normalizeBrandCopy("T3-Code-Server verbinden")).toBe("Lightning-Code-Server verbinden");
  });

  it("preserves technical identifiers and compatibility contracts", () => {
    expect(normalizeBrandCopy("Edit t3.json and T3_WORKTREE_ROOT")).toBe(
      "Edit t3.json and T3_WORKTREE_ROOT",
    );
    expect(normalizeBrandCopy("Reserved server t3_code_direct in @t3tools/contracts")).toBe(
      "Reserved server t3_code_direct in @t3tools/contracts",
    );
  });

  it("preserves upstream MIT license attribution by default", () => {
    const notice = "T3 Code — Copyright (c) 2026 T3 Tools Inc. (MIT License)";
    expect(normalizeBrandCopy(notice)).toBe(notice);
  });
});

describe("normalizeTranslationCatalog", () => {
  it("normalizes nested translation values while keeping keys intact", () => {
    const input = {
      "T3 Code home": "T3 Code 首页",
      nested: {
        description: ["在 T3 Code 中打开", "保留 t3.json"],
      },
      count: 2,
    };
    expect(normalizeTranslationCatalog(input)).toEqual({
      "T3 Code home": "Lightning Code 首页",
      nested: {
        description: ["在 Lightning Code 中打开", "保留 t3.json"],
      },
      count: 2,
    });
  });
});
