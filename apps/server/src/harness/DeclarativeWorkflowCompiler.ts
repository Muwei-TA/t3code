import {
  HarnessModeId,
  ModelSelection,
  RuntimeMode,
  type HarnessWorkflowStepFailurePolicy,
  type HarnessWorkflowStepKind,
  type HarnessWorkflowStepSpec,
  type HarnessWorkflowValidateResult,
  type HarnessWorkflowValidationIssue,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { parse as parseYaml } from "yaml";

import {
  pauseBeforeStage,
  stop,
  workflow,
  type WorkflowDefinition,
} from "../workflows/workflow.ts";
import { agent, ask, type AgentOptions, type AgentThread } from "../workflows/workflowAgent.ts";

const decodeModeId = Schema.decodeUnknownOption(HarnessModeId);
const STEP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const WORKFLOW_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,80}$/;

const DeclarativeWorkflowPayload = Schema.Struct({
  project: Schema.optional(Schema.String),
  thread: Schema.optional(
    Schema.Struct({
      threadId: Schema.String,
      environment: Schema.optional(Schema.String),
    }),
  ),
  input: Schema.optional(Schema.String),
  host: Schema.optionalKey(
    Schema.Struct({
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
      worktreePath: Schema.NullOr(Schema.String),
      branch: Schema.NullOr(Schema.String),
    }),
  ),
});
type DeclarativeWorkflowPayloadType = typeof DeclarativeWorkflowPayload.Type;

function renderCompiledWorkflowPreview(input: {
  readonly name: string;
  readonly version: number;
  readonly description?: string | undefined;
  readonly steps: ReadonlyArray<HarnessWorkflowStepSpec>;
  readonly executionOrder: ReadonlyArray<string>;
}): string {
  const byId = new Map(input.steps.map((step) => [step.id, step]));
  const stepLines = input.executionOrder.flatMap((stepId, index) => {
    const step = byId.get(stepId);
    if (!step) return [];
    const result = `step_${index}`;
    if (step.kind === "ask") {
      const timeout =
        step.timeoutSeconds === undefined
          ? ""
          : `, timeout: ${JSON.stringify(`${step.timeoutSeconds} seconds`)}`;
      return [
        `    const ${result} = yield* T3.ask(${JSON.stringify(step.id)}, { title: ${JSON.stringify(step.prompt)}, choices: ${JSON.stringify(step.choices)}${timeout} });`,
      ];
    }
    const optParts: Array<string> = [`brief: ${JSON.stringify(step.prompt)}`];
    if (step.kind === "in-thread") {
      optParts.push(
        `...(currentThread ? { thread: currentThread } : { project: payload.project })`,
      );
    } else {
      optParts.push(`project: payload.project`);
      optParts.push(`title: ${JSON.stringify(`${input.name}: ${step.name ?? step.id}`)}`);
    }
    if (step.modeId !== undefined) {
      optParts.push(`modeId: ${JSON.stringify(step.modeId)}`);
    }
    if (step.timeoutSeconds !== undefined) {
      optParts.push(`timeout: ${JSON.stringify(`${step.timeoutSeconds} seconds`)}`);
    }
    const opts = `{ ${optParts.join(", ")} }`;
    const header = `    // Step ${step.id} (${step.kind}, onFailure: ${step.onFailure}${step.dependsOn.length > 0 ? `, after: ${step.dependsOn.join(", ")}` : ""})`;
    if (step.onFailure === "pause") {
      const assign = step.kind === "in-thread" ? `const ${result} = ` : "";
      return [
        header,
        `    ${assign}yield* T3.agent(${JSON.stringify(step.id)}, ${opts});`,
        ...(step.kind === "in-thread" ? [`    currentThread = ${result}.thread;`] : []),
      ];
    }
    if (step.onFailure === "fail") {
      return [
        header,
        `    const ${result} = yield* T3.agent.try(${JSON.stringify(step.id)}, ${opts});`,
        `    if (${result}.outcome === "failed") return yield* T3.stop(${result}.reason);`,
        ...(step.kind === "in-thread" ? [`    currentThread = ${result}.thread;`] : []),
      ];
    }
    return [
      header,
      `    const ${result} = yield* T3.agent.try(${JSON.stringify(step.id)}, ${opts});`,
      ...(step.kind === "in-thread"
        ? [`    if (${result}.outcome === "done") currentThread = ${result}.thread;`]
        : []),
    ];
  });
  const docComment = input.description ? `// ${input.description}\n` : "";
  return [
    `${docComment}// Compiled T3 Workflow preview (matches the 3-argument T3.workflow runtime API)`,
    `export default T3.workflow(`,
    `  ${JSON.stringify(input.name)},`,
    `  {`,
    `    version: ${input.version},`,
    `    chat: {},`,
    `    payload: Schema.Struct({`,
    `      thread: Schema.optional(Schema.Struct({ threadId: Schema.String })),`,
    `      project: Schema.optional(Schema.String),`,
    `      input: Schema.optional(Schema.String),`,
    `    }),`,
    `  },`,
    `  Effect.fn(function* (payload) {`,
    `    let currentThread = payload.thread;`,
    ...stepLines,
    `  }),`,
    `);`,
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
    if (rawKind === "in-thread" || rawKind === "child" || rawKind === "ask") {
      kind = rawKind;
    } else {
      issues.push({
        severity: "error",
        path: `${stepPath}.kind`,
        message: `Step '${rawId}' has invalid kind "${String(rawKind)}". Expected "in-thread", "child", or "ask".`,
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

    const choices = Array.isArray(obj.choices)
      ? obj.choices.map((choice: unknown) => (typeof choice === "string" ? choice.trim() : ""))
      : [];
    if (
      kind === "ask" &&
      (choices.length < 2 ||
        choices.length > 12 ||
        choices.some((choice) => !choice || choice.length > 160) ||
        new Set(choices).size !== choices.length)
    ) {
      issues.push({
        severity: "error",
        path: `${stepPath}.choices`,
        message: `Step '${rawId}' requires 2 to 12 distinct, non-empty choices of up to 160 characters each.`,
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
      ...(kind === "ask" ? { choices } : {}),
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

export type CompiledDeclarativeWorkflowResult =
  | {
      readonly ok: true;
      readonly definition: WorkflowDefinition;
      readonly validation: HarnessWorkflowValidateResult;
    }
  | {
      readonly ok: false;
      readonly validation: HarnessWorkflowValidateResult;
    };

/**
 * Compiles a validated declarative YAML workflow into a live `WorkflowDefinition`
 * executable by `WorkflowEngine` / `WorkflowRuntime` (supporting `in-thread`, `child`,
 * `timeoutSeconds`, and `onFailure`: `"fail"` | `"continue"` | `"pause"`).
 */
export function compileDeclarativeWorkflowToDefinition(
  yamlText: string,
  knownModeIds?: ReadonlySet<string>,
): CompiledDeclarativeWorkflowResult {
  const validation = compileAndValidateDeclarativeWorkflow(yamlText, knownModeIds);
  if (!validation.valid || !validation.name || validation.version === undefined) {
    return { ok: false, validation };
  }

  const workflowName = validation.name;
  const workflowVersion = validation.version;
  const stepById = new Map(validation.steps.map((step) => [step.id, step]));
  const orderedSteps = validation.executionOrder
    .map((id) => stepById.get(id))
    .filter((step): step is HarnessWorkflowStepSpec => step !== undefined);

  const definition = workflow(
    workflowName,
    {
      version: workflowVersion,
      payload: DeclarativeWorkflowPayload,
      chat: validation.description === undefined ? {} : { description: validation.description },
    },
    Effect.fn("DeclarativeWorkflow.run")(function* (payload: DeclarativeWorkflowPayloadType) {
      let currentThread: AgentThread | undefined = payload.thread
        ? {
            threadId: payload.thread.threadId,
            ...(payload.thread.environment !== undefined
              ? { environment: payload.thread.environment }
              : {}),
          }
        : undefined;
      const outputs: Record<
        string,
        { readonly outcome: "done" | "failed"; readonly value?: string; readonly reason?: string }
      > = {};

      for (const step of orderedSteps) {
        if (payload.thread !== undefined) yield* pauseBeforeStage(step.id);
        const depContext = step.dependsOn
          .map((depId) => {
            const depOut = outputs[depId];
            if (!depOut) return null;
            return depOut.outcome === "done"
              ? `[Previous step "${depId}" output]\n${depOut.value ?? ""}`
              : `[Previous step "${depId}" failed]\n${depOut.reason ?? "unknown error"}`;
          })
          .filter((entry): entry is string => entry !== null)
          .join("\n\n");

        if (step.kind === "ask") {
          const answer = yield* ask(step.id, {
            title: step.prompt,
            choices: step.choices ?? [],
            ...(depContext ? { data: { body: depContext } } : {}),
            ...(step.timeoutSeconds === undefined
              ? {}
              : { timeout: `${step.timeoutSeconds} seconds` as const }),
          });
          if (Option.isSome(answer)) {
            outputs[step.id] = { outcome: "done", value: answer.value.choice };
          } else if (step.onFailure === "continue") {
            outputs[step.id] = { outcome: "failed", reason: "No answer before the deadline." };
          } else {
            return yield* stop(`Question "${step.id}" was not answered before the deadline.`);
          }
          continue;
        }

        const briefParts = [
          ...(payload.input ? [`[Workflow input]\n${payload.input}`] : []),
          ...(depContext ? [depContext] : []),
          step.prompt,
        ];
        const brief = briefParts.join("\n\n");

        const stepOptions: AgentOptions<string, string> = {
          brief,
          ...(step.kind === "in-thread" && currentThread !== undefined
            ? { thread: currentThread }
            : {
                ...(payload.project !== undefined ? { project: payload.project } : {}),
                ...(step.kind === "child"
                  ? {
                      title: `${workflowName}: ${step.name ?? step.id}`,
                      ...(payload.host === undefined
                        ? {}
                        : {
                            model: payload.host.modelSelection,
                            runtimeMode: payload.host.runtimeMode,
                            workspace:
                              payload.host.worktreePath === null
                                ? { type: "root" as const }
                                : {
                                    type: "existing_worktree" as const,
                                    worktreePath: payload.host.worktreePath,
                                    ...(payload.host.branch === null
                                      ? {}
                                      : { branch: payload.host.branch }),
                                  },
                          }),
                    }
                  : {}),
              }),
          ...(step.modeId === undefined ? {} : { modeId: step.modeId }),
          ...(step.timeoutSeconds !== undefined
            ? { timeout: `${step.timeoutSeconds} seconds` as const }
            : {}),
        };

        if (step.onFailure === "pause") {
          const result = yield* agent(step.id, stepOptions);
          if (step.kind === "in-thread") {
            currentThread = result.thread;
          }
          outputs[step.id] = { outcome: "done", value: result.value };
          continue;
        }

        const attemptResult = yield* agent.try(step.id, stepOptions);
        if (attemptResult.outcome === "done") {
          if (step.kind === "in-thread") {
            currentThread = attemptResult.thread;
          }
          outputs[step.id] = { outcome: "done", value: attemptResult.value };
        } else if (step.onFailure === "fail") {
          return yield* stop(`Step "${step.id}" failed: ${attemptResult.reason}`);
        } else {
          outputs[step.id] = { outcome: "failed", reason: attemptResult.reason };
        }
      }

      return { workflow: workflowName, outputs };
    }),
  );

  const stages = orderedSteps.map(({ id, name, kind, modeId }) => ({
    id,
    ...(name === undefined ? {} : { name }),
    kind,
    ...(modeId === undefined ? {} : { modeId }),
  }));
  return { ok: true, definition: { ...definition, stages }, validation };
}
