import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_HARNESS_CAPABILITIES,
  HarnessCommandId,
  type HarnessLibrarySnapshot,
  HarnessMcpServerId,
  type HarnessModeEntry,
  HarnessModeId,
  HarnessRuleId,
  HarnessSkillId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import {
  expandPortableCommand,
  extractMentionedSkills,
  extractReferencedPaths,
  isMcpServerAllowedByMode,
  matchesRuleGlob,
  projectHarnessContext,
} from "./HarnessProjector.ts";

function makeLibrary(overrides?: Partial<HarnessLibrarySnapshot>): HarnessLibrarySnapshot {
  return {
    harnessDir: "/home/user/.t3/harness",
    workspaceRoot: "/home/user/repo",
    userAgentsMd: {
      scope: "user",
      exists: false,
      path: "/home/user/.t3/harness/AGENTS.md",
      body: "",
      bytes: NonNegativeInt.make(0),
      contentDigest: "empty",
    },
    projectAgentsMd: null,
    skills: [],
    rules: [],
    commands: [],
    modes: [],
    maxSystemContextBytes: PositiveInt.make(12_000),
    invalidEntries: [],
    managedPolicyAllowsHarness: true,
    managedPolicyOrganization: null,
    ...overrides,
  };
}

describe("HarnessProjector", () => {
  it("inlines locked organization rules before user context despite a small user budget", () => {
    const body = "Use the organization checklist.";
    const id = HarnessRuleId.make("org-guide");
    const base = makeLibrary();
    const projected = projectHarnessContext({
      harnessCapabilities: DEFAULT_HARNESS_CAPABILITIES,
      supportsMcpTools: true,
      library: makeLibrary({
        maxSystemContextBytes: PositiveInt.make(10),
        userAgentsMd: {
          ...base.userAgentsMd,
          exists: true,
          body: "User instructions",
          bytes: NonNegativeInt.make(17),
        },
        rules: [
          {
            id,
            scope: "user",
            apply: "always",
            globs: [],
            enabled: true,
            effectiveEnabled: true,
            overriddenByProject: false,
            lockedByPolicy: true,
            sourcePath: "/policy.json",
            contentDigest: "fixture",
            bytes: NonNegativeInt.make(body.length),
            body,
          },
        ],
      }),
    });
    expect(projected.segments[0]?.text).toContain(body);
    expect(projected.rules).toContainEqual(
      expect.objectContaining({ id, lockedByPolicy: true, status: "inlined" }),
    );
    expect(projected.contextUsedBytes).toBeLessThanOrEqual(projected.contextBudgetBytes);
  });

  it("matches rule globs including **, *, ?, braces, and basename patterns", () => {
    expect(matchesRuleGlob("**/*.ts", "apps/server/src/index.ts")).toBe(true);
    expect(matchesRuleGlob("**/*.{ts,tsx}", "apps/web/src/App.tsx")).toBe(true);
    expect(matchesRuleGlob("**/*.{ts,tsx}", "apps/web/src/styles.css")).toBe(false);
    expect(matchesRuleGlob("*.sql", "db/migrations/001.sql")).toBe(true);
    expect(matchesRuleGlob("apps/server/**", "apps/server/src/ws.ts")).toBe(true);
    expect(matchesRuleGlob("apps/server/**", "apps/web/src/ws.ts")).toBe(false);
    expect(matchesRuleGlob("src/file?.ts", "src/file1.ts")).toBe(true);
    expect(matchesRuleGlob("src/file?.ts", "src/file12.ts")).toBe(false);
  });

  it("expands portable custom commands with $ARGUMENTS and positional $1..$9 while protecting reserved built-ins", () => {
    const commands = [
      {
        id: HarnessCommandId.make("review-pr"),
        effectiveEnabled: true,
        body: "Review PR $1 against $2. Extra notes: $ARGUMENTS",
      },
      {
        id: HarnessCommandId.make("check-types"),
        effectiveEnabled: true,
        body: "Run typecheck and report any errors.",
      },
      {
        id: HarnessCommandId.make("disabled-cmd"),
        effectiveEnabled: false,
        body: "Should never expand",
      },
    ];

    const expanded = expandPortableCommand({
      text: '/review-pr 42 "origin/main"',
      commands,
    });
    expect(expanded.expanded).toBe(true);
    expect(expanded.commandId).toBe("review-pr");
    expect(expanded.text).toBe('Review PR 42 against origin/main. Extra notes: 42 "origin/main"');

    const literalArguments = expandPortableCommand({
      text: "/review-pr $& $1 $$",
      commands,
    });
    expect(literalArguments.text).toBe("Review PR $& against $1. Extra notes: $& $1 $$");

    // No placeholders appends user args cleanly
    const appended = expandPortableCommand({
      text: "/check-types packages/contracts",
      commands,
    });
    expect(appended.expanded).toBe(true);
    expect(appended.text).toBe("Run typecheck and report any errors.\n\npackages/contracts");

    // Disabled command and reserved built-ins never expand
    expect(expandPortableCommand({ text: "/disabled-cmd now", commands }).expanded).toBe(false);
    expect(expandPortableCommand({ text: "/plan something", commands }).expanded).toBe(false);
    expect(expandPortableCommand({ text: "/logout", commands }).expanded).toBe(false);
  });

  it("extracts referenced paths and $skill mentions from prompts", () => {
    const paths = extractReferencedPaths({
      promptText:
        "Please inspect @apps/server/src/ws.ts and [doc](docs/guide.md) not https://x.dev/a.ts",
      attachmentPaths: ["packages/contracts/src/harness.ts"],
    });
    expect(paths).toContain("apps/server/src/ws.ts");
    expect(paths).toContain("docs/guide.md");
    expect(paths).toContain("packages/contracts/src/harness.ts");
    expect(paths.some((p) => p.includes("https://"))).toBe(false);

    const mentioned = extractMentionedSkills("Use $sql-audit and ($deploy-check) here");
    expect(mentioned.has("sql-audit")).toBe(true);
    expect(mentioned.has("deploy-check")).toBe(true);
  });

  it("deduplicates skills by path/digest and routes Claude to native-mount vs Codex/others to gateway", () => {
    const lib = makeLibrary({
      skills: [
        {
          id: HarnessSkillId.make("already-native"),
          name: TrimmedNonEmptyString.make("already-native"),
          scope: "user",
          description: "Matches digest",
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          userInvocable: true,
          userInvocationOnly: false,
          sourcePath: "/home/user/.t3/harness/skills/already-native/SKILL.md",
          contentDigest: "digest-same-123",
          bytes: NonNegativeInt.make(100),
          body: "Native body",
        },
        {
          id: HarnessSkillId.make("portable-one"),
          name: TrimmedNonEmptyString.make("portable-one"),
          scope: "user",
          description: "Portable skill",
          files: [
            {
              relativePath: "scripts/check",
              executable: true,
              kind: "script",
              sizeBytes: NonNegativeInt.make(50),
            },
          ],
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          userInvocable: true,
          userInvocationOnly: false,
          sourcePath: "/home/user/.t3/harness/skills/portable-one/SKILL.md",
          contentDigest: "digest-portable-1",
          bytes: NonNegativeInt.make(140),
          body: "Do portable steps.",
        },
      ],
    });

    const claudeProjected = projectHarnessContext({
      library: lib,
      harnessCapabilities: {
        ...DEFAULT_HARNESS_CAPABILITIES,
        skillMount: "plugin-dir",
      },
      nativeSkills: [
        {
          name: "other-name",
          path: "/home/user/.claude/skills/x/SKILL.md",
          contentDigest: "digest-same-123",
        },
        { name: "portable-one", path: "/cli/other/SKILL.md", contentDigest: "digest-portable-1" },
      ],
      supportsMcpTools: true,
    });
    expect(claudeProjected.skills.find((s) => s.id === "already-native")?.channel).toBe(
      "deduplicated",
    );
    expect(claudeProjected.skills.find((s) => s.id === "portable-one")?.channel).toBe(
      "native-mount",
    );
    expect(claudeProjected.nativeMountSkills.map((s) => s.id)).toEqual(["portable-one"]);
    expect(claudeProjected.needsGatewayTools).toBe(true);

    const codexProjected = projectHarnessContext({
      library: lib,
      harnessCapabilities: {
        ...DEFAULT_HARNESS_CAPABILITIES,
        skillMount: "none",
        maxSystemContextBytes: 3600,
      },
      nativeSkills: [
        {
          name: "other-name",
          path: "/home/user/.codex/skills/x/SKILL.md",
          contentDigest: "digest-same-123",
        },
      ],
      supportsMcpTools: true,
    });
    expect(codexProjected.skills.find((s) => s.id === "portable-one")?.channel).toBe("gateway");
    expect(codexProjected.needsGatewayTools).toBe(true);
    expect(codexProjected.scaffoldBytes).toBeGreaterThan(0);

    const codexNative = (codexSkillMount: "prepare" | "mounted") =>
      projectHarnessContext({
        library: lib,
        harnessCapabilities: {
          ...DEFAULT_HARNESS_CAPABILITIES,
          skillMount: "managed-home",
          maxSystemContextBytes: 3600,
        },
        codexSkillMount,
        supportsMcpTools: true,
      });
    expect(codexNative("prepare").nativeMountSkills.map((skill) => skill.id)).toContain(
      "portable-one",
    );
    expect(codexNative("prepare").needsGatewayTools).toBe(true);
    expect(
      codexNative("mounted").skills.find((skill) => skill.id === "portable-one")?.channel,
    ).toBe("native-mount");
    expect(codexNative("mounted").needsGatewayTools).toBe(true);
    expect(
      codexNative("mounted")
        .segments.map((entry) => entry.text)
        .join("\n"),
    ).toContain("harness_skill_load");
  });

  it("never silently truncates rules, degrades overflowing blocks whole-block to on-demand, and enforces Codex <= 3600 B per segment", () => {
    const mediumRuleBody = "Rule A line. ".repeat(150); // ~1950 bytes
    const secondRuleBody = "Rule B line. ".repeat(150); // ~1950 bytes
    const oversizedSingleRuleBody = "Huge single rule. ".repeat(260); // ~4680 bytes (> 3600 B Codex segment cap)

    const lib = makeLibrary({
      maxSystemContextBytes: PositiveInt.make(12_000),
      userAgentsMd: {
        scope: "user",
        exists: true,
        path: "/home/user/.t3/harness/AGENTS.md",
        body: "Always write deterministic tests.",
        bytes: NonNegativeInt.make(33),
        contentDigest: "agents-1",
      },
      rules: [
        {
          id: HarnessRuleId.make("rule-a"),
          scope: "user",
          apply: "always",
          globs: [],
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          sourcePath: "/home/user/.t3/harness/rules/rule-a.md",
          contentDigest: "ra",
          bytes: NonNegativeInt.make(Buffer.byteLength(mediumRuleBody, "utf8")),
          body: mediumRuleBody,
        },
        {
          id: HarnessRuleId.make("rule-b"),
          scope: "user",
          apply: "glob",
          globs: [TrimmedNonEmptyString.make("**/*.ts")],
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          sourcePath: "/home/user/.t3/harness/rules/rule-b.md",
          contentDigest: "rb",
          bytes: NonNegativeInt.make(Buffer.byteLength(secondRuleBody, "utf8")),
          body: secondRuleBody,
        },
        {
          id: HarnessRuleId.make("rule-huge"),
          scope: "user",
          apply: "always",
          globs: [],
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          sourcePath: "/home/user/.t3/harness/rules/rule-huge.md",
          contentDigest: "rh",
          bytes: NonNegativeInt.make(Buffer.byteLength(oversizedSingleRuleBody, "utf8")),
          body: oversizedSingleRuleBody,
        },
      ],
    });

    const codexProjected = projectHarnessContext({
      library: lib,
      harnessCapabilities: {
        ...DEFAULT_HARNESS_CAPABILITIES,
        maxSystemContextBytes: 3600,
      },
      promptText: "Refactor apps/server/src/ws.ts",
      supportsMcpTools: true,
    });

    // Every single emitted segment MUST stay <= 3600 UTF-8 bytes for Codex!
    expect(codexProjected.segments.length).toBeGreaterThanOrEqual(2);
    for (const seg of codexProjected.segments) {
      expect(seg.bytes).toBeLessThanOrEqual(3600);
      expect(Buffer.byteLength(seg.text, "utf8")).toBeLessThanOrEqual(3600);
    }

    // Both rule-a and glob-matched rule-b fit in separate segments cleanly (zero truncation)
    const combinedText = codexProjected.segments.map((s) => s.text).join("\n");
    expect(combinedText).toContain(mediumRuleBody.trim());
    expect(combinedText).toContain(secondRuleBody.trim());

    // Oversized single block > 3600 B MUST NOT be truncated — it degrades whole-block to harness_rule_read
    expect(combinedText).not.toContain("Huge single rule.");
    expect(codexProjected.rules.find((r) => r.id === "rule-huge")?.status).toBe("degraded");
    expect(
      codexProjected.degradedItems.some((d) => d.kind === "rule" && d.id === "rule-huge"),
    ).toBe(true);
    expect(codexProjected.needsGatewayTools).toBe(true);

    // Total budget exhaustion degrades remaining whole blocks without truncating anything
    const tightProjected = projectHarnessContext({
      library: makeLibrary({
        ...lib,
        maxSystemContextBytes: PositiveInt.make(2500),
      }),
      harnessCapabilities: {
        ...DEFAULT_HARNESS_CAPABILITIES,
        maxSystemContextBytes: 3600,
      },
      promptText: "Refactor apps/server/src/ws.ts",
      supportsMcpTools: true,
    });
    expect(tightProjected.contextUsedBytes).toBeLessThanOrEqual(2500);
    expect(tightProjected.rules.find((r) => r.id === "rule-b")?.status).toBe("degraded");
  });

  it("projects active declarative Mode instructions, included manual rules, and MCP server filtering", () => {
    const activeMode: HarnessModeEntry = {
      id: HarnessModeId.make("security-audit"),
      name: TrimmedNonEmptyString.make("Security Audit"),
      scope: "user",
      description: "Audit security boundaries",
      baseInteractionMode: "default",
      readonly: true,
      proposePlan: false,
      allowedMcpServers: [HarnessMcpServerId.make("github")],
      disabledMcpServers: [HarnessMcpServerId.make("shell-exec")],
      includedRules: [HarnessRuleId.make("sec-manual")],
      enabled: true,
      effectiveEnabled: true,
      overriddenByProject: false,
      sourcePath: "/home/user/.t3/harness/modes/security-audit.md",
      contentDigest: "mode-sec-1",
      bytes: NonNegativeInt.make(48),
      body: "Focus on auth, secrets, and injection risks.",
    };

    expect(isMcpServerAllowedByMode("github", activeMode)).toBe(true);
    expect(isMcpServerAllowedByMode("linear", activeMode)).toBe(false);
    expect(isMcpServerAllowedByMode("shell-exec", activeMode)).toBe(false);

    const lib = makeLibrary({
      modes: [activeMode],
      rules: [
        {
          id: HarnessRuleId.make("sec-manual"),
          scope: "user",
          apply: "manual",
          globs: [],
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          sourcePath: "/home/user/.t3/harness/rules/sec-manual.md",
          contentDigest: "rm-1",
          bytes: NonNegativeInt.make(32),
          body: "Check every RPC scope boundary.",
        },
      ],
    });

    const projected = projectHarnessContext({
      library: lib,
      activeMode,
      harnessCapabilities: DEFAULT_HARNESS_CAPABILITIES,
      supportsMcpTools: true,
    });
    const combined = projected.segments.map((s) => s.text).join("\n");
    expect(combined).toContain("Security Audit");
    expect(combined).toContain("Focus on auth, secrets, and injection risks.");
    expect(combined).toContain("Check every RPC scope boundary.");
    expect(projected.rules.find((r) => r.id === "sec-manual")?.status).toBe("inlined");
  });
});
