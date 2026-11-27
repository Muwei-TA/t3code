import { T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import type { HarnessScaffoldCase } from "./cases.ts";

export interface RecordedToolCall {
  readonly name: string;
  readonly argumentsJson: string;
}

export interface HarnessScaffoldGradeResult {
  readonly passed: boolean;
  readonly reason: string;
}

export function buildHarnessScaffoldSystemPrompt(extraContext?: string): string {
  return extraContext
    ? `${T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS}\n\n${extraContext}`
    : T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS;
}

export function gradeHarnessScaffoldTurn(
  evalCase: HarnessScaffoldCase,
  toolCalls: ReadonlyArray<RecordedToolCall>,
): HarnessScaffoldGradeResult {
  const harnessCalls = toolCalls.filter((call) => call.name.startsWith("harness_"));
  if (
    evalCase.expectToolPrefix === "harness_install_skill" &&
    harnessCalls[0]?.name !== "harness_inspect"
  ) {
    return {
      passed: false,
      reason: "Inspect the available T3 library before installing a package.",
    };
  }

  if (evalCase.expectToolPrefix === "none") {
    if (harnessCalls.length === 0) {
      return { passed: true, reason: "Skipped harness tools on ordinary coding task." };
    }
    return {
      passed: false,
      reason: `Unexpected harness tool call(s) on control case: ${harnessCalls.map((c) => c.name).join(", ")}.`,
    };
  }

  const matching = harnessCalls.filter((call) => call.name.startsWith(evalCase.expectToolPrefix));
  if (matching.length === 0) {
    return {
      passed: false,
      reason: `Expected tool matching "${evalCase.expectToolPrefix}*", saw: ${toolCalls.map((c) => c.name).join(", ") || "none"}.`,
    };
  }

  if (evalCase.expectedArgsPattern) {
    const matchedArgs = matching.some((call) =>
      evalCase.expectedArgsPattern!.test(call.argumentsJson),
    );
    if (!matchedArgs) {
      return {
        passed: false,
        reason: `Tool "${matching[0]!.name}" was called without matching target argument (${String(evalCase.expectedArgsPattern)}).`,
      };
    }
  }

  return { passed: true, reason: `Called ${matching.map((c) => c.name).join(", ")} cleanly.` };
}
