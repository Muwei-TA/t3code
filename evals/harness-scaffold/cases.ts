export interface HarnessScaffoldCase {
  readonly id: string;
  readonly source: string;
  readonly prompt: string;
  readonly expectToolPrefix:
    | "harness_skill_"
    | "harness_rule_read"
    | "harness_install_skill"
    | "none";
  readonly expectedArgsPattern?: RegExp;
}

export const HARNESS_SCAFFOLD_CASES: ReadonlyArray<HarnessScaffoldCase> = [
  {
    id: "discover-portable-skill",
    source: "Portable Harness P1 spec — skill discovery over /mcp/harness",
    prompt: "Apply my portable sql-audit skill to check the migration file before we open the PR.",
    expectToolPrefix: "harness_skill_",
    expectedArgsPattern: /sql-audit/i,
  },
  {
    id: "read-overflow-rule",
    source: "Portable Harness P1 spec — whole-block non-truncating rule degradation",
    prompt:
      "Read my on-demand portable rule `security-headers` and verify our HTTP response middleware matches it.",
    expectToolPrefix: "harness_rule_read",
    expectedArgsPattern: /security-headers/i,
  },
  {
    id: "install-skill-package",
    source: "Stage A portable skill authoring",
    prompt: "Install the skill package in /workspace/release-notes into my T3 user skill library.",
    expectToolPrefix: "harness_install_skill",
    expectedArgsPattern: /release-notes/u,
  },
  {
    id: "ordinary-coding-control",
    source: "Portable Harness P1 control — avoid unnecessary harness MCP calls",
    prompt: "Fix the typo in README.md where 'recieve' should be 'receive'.",
    expectToolPrefix: "none",
  },
];
