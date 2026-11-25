import { describe, expect, it } from "@effect/vitest";

import { compileAndValidateDeclarativeWorkflow } from "./DeclarativeWorkflowCompiler.ts";

describe("DeclarativeWorkflowCompiler", () => {
  it("compiles a valid YAML workflow with in-thread and child steps into topological execution order", () => {
    const yaml = `
name: pr-release-pipeline
version: 2
description: Plan, implement in child thread, and run final review.
steps:
  - id: review
    kind: in-thread
    modeId: review
    dependsOn: [implement]
    prompt: Review the implementation diff for regressions.
  - id: plan
    kind: in-thread
    modeId: plan
    prompt: Inspect the repository and produce a concise plan.
  - id: implement
    kind: child
    modeId: build
    dependsOn: [plan]
    timeoutSeconds: 600
    onFailure: pause
    prompt: Implement the approved plan and run tests.
`;
    const result = compileAndValidateDeclarativeWorkflow(
      yaml,
      new Set(["build", "plan", "review", "creator"]),
    );
    expect(result.valid).toBe(true);
    expect(result.name).toBe("pr-release-pipeline");
    expect(result.version).toBe(2);
    expect(result.executionOrder).toEqual(["plan", "implement", "review"]);
    expect(result.issues).toEqual([]);
    expect(result.compiledPreview).toContain('T3.workflow(\n  "pr-release-pipeline"');
    expect(result.compiledPreview).toContain("T3.agent.try");
    expect(result.compiledPreview).toContain('T3.agent("implement"');
    expect(result.compiledPreview).toContain('modeId: "review"');
    expect(result.compiledPreview).toContain("T3.stop");
  });

  it("detects dependency cycles and unknown dependencies", () => {
    const cyclic = `
name: bad-cycle
steps:
  - id: a
    kind: in-thread
    dependsOn: [b]
    prompt: Step A
  - id: b
    kind: child
    dependsOn: [a, ghost]
    prompt: Step B
`;
    const result = compileAndValidateDeclarativeWorkflow(cyclic);
    expect(result.valid).toBe(false);
    expect(result.executionOrder).toEqual([]);
    expect(result.issues.some((i) => i.message.includes("unknown step 'ghost'"))).toBe(true);
    expect(result.issues.some((i) => i.message.includes("cycle detected"))).toBe(true);
  });

  it("warns on unknown installed modeId without failing valid syntax", () => {
    const yaml = `
name: custom-mode-wf
steps:
  - id: audit
    kind: in-thread
    modeId: security-audit
    prompt: Audit auth paths.
`;
    const result = compileAndValidateDeclarativeWorkflow(yaml, new Set(["build", "plan"]));
    expect(result.valid).toBe(true);
    expect(
      result.issues.some((i) => i.severity === "warning" && i.path === "steps[0].modeId"),
    ).toBe(true);
  });
});
