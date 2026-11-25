import {
  HarnessModeId,
  type HarnessWorkflowStepFailurePolicy,
  type HarnessWorkflowStepKind,
  type HarnessWorkflowStepSpec,
  type HarnessWorkflowValidateResult,
  type HarnessWorkflowValidationIssue,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

const decodeModeId = Schema.decodeUnknownOption(HarnessModeId);
const STEP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const WORKFLOW_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,80}$/;

function renderCompiledWorkflowPreview(input: {
  readonly name: string;
  readonly version: number;
  readonly description?: string | undefined;
  readonly steps: ReadonlyArray<HarnessWorkflowStepSpec>;
  readonly executionOrder: ReadonlyArray<string>;
}): string {
  const byId = new Map(input.steps.map((step) => [step.id, step]));
  const stepLines = input.executionOrder.flatMap((stepId) => {
    const step = byId.get(stepId);
    if (!step) return [];
    const modeArg = step.modeId ? `, modeId: ${JSON.stringify(step.modeId)}` : "";
    const stepFn = step.kind === "child" ? "ctx.agent.delegate" : "ctx.agent.runInThread";
    return [
      `    // Step ${step.id} (${step.kind}${step.dependsOn.length > 0 ? `, after: ${step.dependsOn.join(", ")}` : ""})`,
      `    await ctx.step(${JSON.stringify(step.id)}, () => ${stepFn}({ prompt: ${JSON.stringify(step.prompt)}${modeArg} }));`,
    ];
  });
  const docComment = input.description ? `// ${input.description}\n` : "";
  return [
    `${docComment}import { T3 } from "@t3tools/workflows";`,
    "",
    `export default T3.workflow({`,
    `  name: ${JSON.stringify(input.name)},`,
    `  version: ${input.version},`,
    `  async run(ctx) {`,
    ...stepLines,
    `  },`,
    `});`,
    "",
  ].join("\n");
}

export function compileAndValidateDeclarativeWorkflow(
  yamlText: string,
  knownModeIds?: ReadonlySet<string>,
): HarnessWorkflowValidateResult {
  const issues: Array<HarnessWorkflowValidationIssue> = [];
  if (yamlText.trim().length === 0) {
    return {
      valid: false,
      steps: [],
      executionOrder: [],
      issues: [{ severity: "error", path: "$", message: "Workflow YAML document is empty." }],
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    return {
      valid: false,
      steps: [],
      executionOrder: [],
      issues: [
        {
          severity: "error",
          path: "$",
          message: `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      steps: [],
      executionOrder: [],
      issues: [
        { severity: "error", path: "$", message: "Workflow root must be a YAML mapping/object." },
      ],
    };
  }

  const root = raw as Record<string, unknown>;
  const rawName = typeof root.name === "string" ? root.name.trim() : "";
  if (rawName.length === 0) {
    issues.push({ severity: "error", path: "name", message: "Workflow 'name' is required." });
  } else if (!WORKFLOW_NAME_PATTERN.test(rawName)) {
    issues.push({
      severity: "error",
      path: "name",
      message: "Workflow 'name' must start with an alphanumeric character and be <= 80 chars.",
    });
  }

  let version = 1;
  if (root.version !== undefined) {
    if (typeof root.version !== "number" || !Number.isInteger(root.version) || root.version < 1) {
      issues.push({
        severity: "error",
        path: "version",
        message: "Workflow 'version' must be a positive integer.",
      });
    } else {
      version = root.version;
    }
  }

  const description =
    typeof root.description === "string" && root.description.trim().length > 0
      ? root.description.trim()
      : undefined;

  if (!Array.isArray(root.steps) || root.steps.length === 0) {
    issues.push({
      severity: "error",
      path: "steps",
      message: "Workflow must define a non-empty 'steps' array.",
    });
    return {
      valid: false,
      ...(rawName ? { name: rawName } : {}),
      version: PositiveInt.make(version),
      ...(description ? { description } : {}),
      steps: [],
      executionOrder: [],
      issues,
    };
  }

  const steps: Array<HarnessWorkflowStepSpec> = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < root.steps.length; index += 1) {
    const entry = root.steps[index];
    const stepPath = `steps[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ severity: "error", path: stepPath, message: "Step entry must be an object." });
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const rawId = typeof obj.id === "string" ? obj.id.trim() : "";
    if (!rawId) {
      issues.push({ severity: "error", path: `${stepPath}.id`, message: "Step 'id' is required." });
      continue;
    }
    if (!STEP_ID_PATTERN.test(rawId)) {
      issues.push({
        severity: "error",
        path: `${stepPath}.id`,
        message: `Invalid step id "${rawId}". Use letters, numbers, dots, underscores, or hyphens.`,
      });
      continue;
    }
    if (seenIds.has(rawId)) {
      issues.push({
        severity: "error",
        path: `${stepPath}.id`,
        message: `Duplicate step id "${rawId}".`,
      });
      continue;
    }
    seenIds.add(rawId);

    const rawKind = obj.kind ?? "in-thread";
    let kind: HarnessWorkflowStepKind = "in-thread";
    if (rawKind === "in-thread" || rawKind === "child") {
      kind = rawKind;
    } else {
      issues.push({
        severity: "error",
        path: `${stepPath}.kind`,
        message: `Step '${rawId}' has invalid kind "${String(rawKind)}". Expected "in-thread" or "child".`,
      });
    }

    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    if (prompt.length === 0) {
      issues.push({
        severity: "error",
        path: `${stepPath}.prompt`,
        message: `Step '${rawId}' requires a non-empty 'prompt'.`,
      });
    }

    let modeId: HarnessModeId | undefined;
    if (obj.modeId !== undefined && obj.modeId !== null && obj.modeId !== "") {
      const decoded = decodeModeId(obj.modeId);
      if (decoded._tag === "None") {
        issues.push({
          severity: "error",
          path: `${stepPath}.modeId`,
          message: `Step '${rawId}' has invalid modeId "${String(obj.modeId)}".`,
        });
      } else {
        modeId = decoded.value;
        if (knownModeIds && !knownModeIds.has(modeId)) {
          issues.push({
            severity: "warning",
            path: `${stepPath}.modeId`,
            message: `Step '${rawId}' references mode "${modeId}" which is not currently installed.`,
          });
        }
      }
    }

    const dependsOn: Array<typeof TrimmedNonEmptyString.Type> = [];
    if (obj.dependsOn !== undefined) {
      if (!Array.isArray(obj.dependsOn)) {
        issues.push({
          severity: "error",
          path: `${stepPath}.dependsOn`,
          message: `Step '${rawId}' field 'dependsOn' must be an array of step ids.`,
        });
      } else {
        for (const dep of obj.dependsOn) {
          if (typeof dep !== "string" || dep.trim().length === 0) {
            issues.push({
              severity: "error",
              path: `${stepPath}.dependsOn`,
              message: `Step '${rawId}' has an empty or non-string dependency.`,
            });
          } else if (dep.trim() === rawId) {
            issues.push({
              severity: "error",
              path: `${stepPath}.dependsOn`,
              message: `Step '${rawId}' cannot depend on itself.`,
            });
          } else {
            dependsOn.push(TrimmedNonEmptyString.make(dep.trim()));
          }
        }
      }
    }

    let timeoutSeconds: typeof PositiveInt.Type | undefined;
    if (obj.timeoutSeconds !== undefined) {
      if (
        typeof obj.timeoutSeconds !== "number" ||
        !Number.isInteger(obj.timeoutSeconds) ||
        obj.timeoutSeconds < 1 ||
        obj.timeoutSeconds > 86_400
      ) {
        issues.push({
          severity: "error",
          path: `${stepPath}.timeoutSeconds`,
          message: `Step '${rawId}' timeoutSeconds must be an integer between 1 and 86400.`,
        });
      } else {
        timeoutSeconds = PositiveInt.make(obj.timeoutSeconds);
      }
    }

    const rawOnFailure = obj.onFailure ?? "fail";
    let onFailure: HarnessWorkflowStepFailurePolicy = "fail";
    if (rawOnFailure === "fail" || rawOnFailure === "continue" || rawOnFailure === "pause") {
      onFailure = rawOnFailure;
    } else {
      issues.push({
        severity: "error",
        path: `${stepPath}.onFailure`,
        message: `Step '${rawId}' has invalid onFailure "${String(rawOnFailure)}". Expected "fail", "continue", or "pause".`,
      });
    }

    const stepName =
      typeof obj.name === "string" && obj.name.trim().length > 0 ? obj.name.trim() : undefined;

    steps.push({
      id: TrimmedNonEmptyString.make(rawId),
      ...(stepName ? { name: stepName } : {}),
      kind,
      prompt,
      ...(modeId ? { modeId } : {}),
      dependsOn,
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
      onFailure,
    });
  }

  // Validate dependsOn targets exist and compute topological order via Kahn's algorithm.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Array<string>>();
  for (const step of steps) {
    inDegree.set(step.id, 0);
    dependents.set(step.id, []);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!seenIds.has(dep)) {
        issues.push({
          severity: "error",
          path: `steps.${step.id}.dependsOn`,
          message: `Step '${step.id}' depends on unknown step '${dep}'.`,
        });
        continue;
      }
      dependents.get(dep)?.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
    }
  }

  const queue: Array<string> = [];
  for (const step of steps) {
    if ((inDegree.get(step.id) ?? 0) === 0) {
      queue.push(step.id);
    }
  }
  const executionOrder: Array<string> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    executionOrder.push(current);
    for (const next of dependents.get(current) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (executionOrder.length < steps.length) {
    const cycleNodes = steps
      .filter((step) => !executionOrder.includes(step.id))
      .map((step) => step.id);
    issues.push({
      severity: "error",
      path: "steps",
      message: `Workflow dependency cycle detected involving: ${cycleNodes.join(", ")}.`,
    });
  }

  const hasError = issues.some((issue) => issue.severity === "error");
  return {
    valid: !hasError,
    ...(rawName ? { name: rawName } : {}),
    version: PositiveInt.make(version),
    ...(description ? { description } : {}),
    steps,
    executionOrder: hasError ? [] : executionOrder,
    issues,
    ...(!hasError && rawName
      ? {
          compiledPreview: renderCompiledWorkflowPreview({
            name: rawName,
            version,
            description,
            steps,
            executionOrder,
          }),
        }
      : {}),
  };
}
