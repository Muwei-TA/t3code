import { T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { describe, expect, it } from "vite-plus/test";

import { HARNESS_SCAFFOLD_CASES } from "./cases.ts";
import { buildHarnessScaffoldSystemPrompt, gradeHarnessScaffoldTurn } from "./grade.ts";

describe("harness-scaffold eval grader", () => {
  it("imports real scaffold instructions and stays compact", () => {
    const prompt = buildHarnessScaffoldSystemPrompt();
    expect(prompt).toBe(T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS);
    expect(prompt).toContain("harness_skill_search");
    expect(prompt).toContain("harness_skill_load");
    expect(prompt).toContain("harness_rule_read");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(400);
  });

  it("grades portable skill discovery, on-demand rule reads, and ordinary control cases accurately", () => {
    const skillCase = HARNESS_SCAFFOLD_CASES.find((c) => c.id === "discover-portable-skill")!;
    const ruleCase = HARNESS_SCAFFOLD_CASES.find((c) => c.id === "read-overflow-rule")!;
    const controlCase = HARNESS_SCAFFOLD_CASES.find((c) => c.id === "ordinary-coding-control")!;

    expect(
      gradeHarnessScaffoldTurn(skillCase, [
        { name: "harness_skill_load", argumentsJson: '{"name":"sql-audit"}' },
      ]).passed,
    ).toBe(true);
    expect(gradeHarnessScaffoldTurn(skillCase, []).passed).toBe(false);
    expect(
      gradeHarnessScaffoldTurn(skillCase, [
        { name: "harness_skill_load", argumentsJson: '{"name":"unrelated"}' },
      ]).passed,
    ).toBe(false);

    expect(
      gradeHarnessScaffoldTurn(ruleCase, [
        { name: "harness_rule_read", argumentsJson: '{"id":"security-headers"}' },
      ]).passed,
    ).toBe(true);
    expect(
      gradeHarnessScaffoldTurn(ruleCase, [
        { name: "harness_skill_search", argumentsJson: '{"query":"security-headers"}' },
      ]).passed,
    ).toBe(false);

    expect(gradeHarnessScaffoldTurn(controlCase, []).passed).toBe(true);
    expect(
      gradeHarnessScaffoldTurn(controlCase, [
        { name: "harness_skill_search", argumentsJson: '{"query":"readme"}' },
      ]).passed,
    ).toBe(false);
  });
});
