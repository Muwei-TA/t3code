// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off -- Spawns user-configured command and HTTP hooks with explicit abort/kill deadlines.
import * as NodeChildProcess from "node:child_process";
import {
  type EnvironmentAuthorizationError,
  HarnessError,
  HarnessHookDefinition,
  type HarnessHookEvent,
  type HarnessHookExecutionResult,
  type HarnessHookRemoveInput,
  type HarnessHookSetEnabledInput,
  type HarnessHooksSnapshot,
  type HarnessHookTestInput,
  type HarnessHookUpsertInput,
  type HarnessPluginId,
  NonNegativeInt,
  PositiveInt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as HarnessStore from "./HarnessStore.ts";
import { safeReadFileUtf8, safeWriteFileAtomic } from "./safeFileOps.ts";

const DEFAULT_HOOK_TIMEOUT_MS = 3_000;
const MIN_HOOK_TIMEOUT_MS = 100;
const MAX_HOOK_TIMEOUT_MS = 10_000;
const MAX_HOOK_STDOUT_BYTES = 32 * 1024;
const HOOKS_FILE_NAME = "hooks.json";

const HooksConfigFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  hooks: Schema.Array(HarnessHookDefinition),
});

const decodeHooksConfigFile = Schema.decodeUnknownOption(HooksConfigFileSchema);

function clampTimeoutMs(timeoutMs: number | undefined): number {
  const raw = timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_HOOK_TIMEOUT_MS), MAX_HOOK_TIMEOUT_MS);
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

function encodePrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tryParseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Glob-like matcher (`*` wildcard) without regex ReDoS risk. */
function matchesHookMatcher(matcher: string | undefined, subject: string): boolean {
  if (!matcher || matcher.trim().length === 0 || matcher.trim() === "*") {
    return true;
  }
  const pattern = matcher.trim();
  if (!pattern.includes("*")) {
    return subject === pattern || subject.includes(pattern);
  }
  const parts = pattern.split("*").filter((part) => part.length > 0);
  if (parts.length === 0) return true;
  let cursor = 0;
  const anchoredStart = !pattern.startsWith("*");
  const anchoredEnd = !pattern.endsWith("*");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const found = subject.indexOf(part, cursor);
    if (found < 0) return false;
    if (index === 0 && anchoredStart && found !== 0) return false;
    cursor = found + part.length;
  }
  if (anchoredEnd) {
    const last = parts[parts.length - 1]!;
    return subject.endsWith(last);
  }
  return true;
}

interface RawHookRunOutcome {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly error?: string | undefined;
}

async function runCommandHook(
  hook: HarnessHookDefinition,
  payloadJson: string,
  timeoutMs: number,
): Promise<RawHookRunOutcome> {
  const target = hook.target;
  if (target.type !== "command") {
    return { ok: false, timedOut: false, durationMs: 0, stdout: "", error: "Not a command hook." };
  }
  const startedAt = performance.now();
  return new Promise<RawHookRunOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let inputError: string | undefined;
    let child: NodeChildProcess.ChildProcess | null = null;

    const finish = (outcome: Omit<RawHookRunOutcome, "durationMs">) => {
      if (settled) return;
      settled = true;
      resolve({ ...outcome, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) });
    };

    try {
      child = NodeChildProcess.spawn(target.command, target.args ? [...target.args] : [], {
        cwd: target.cwd,
        env: target.env ? { ...process.env, ...target.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        ok: false,
        timedOut: false,
        stdout: "",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        // Ignore already-exited child.
      }
      finish({
        ok: false,
        timedOut: true,
        stdout,
        error: `Hook "${hook.id}" timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, "utf8") < MAX_HOOK_STDOUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_HOOK_STDOUT_BYTES) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        timedOut,
        stdout,
        error: error.message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && inputError === undefined) {
        finish({ ok: true, timedOut: false, stdout });
      } else {
        finish({
          ok: false,
          timedOut,
          stdout,
          error: stderr.trim() || (inputError ?? `Hook exited with status ${code ?? "unknown"}.`),
        });
      }
    });

    const recordInputError = (error: unknown) => {
      inputError = error instanceof Error ? error.message : String(error);
    };
    child.stdin?.on("error", recordInputError);
    try {
      child.stdin?.end(payloadJson);
    } catch (error) {
      recordInputError(error);
    }
  });
}

async function runHttpHook(
  hook: HarnessHookDefinition,
  payloadJson: string,
  timeoutMs: number,
): Promise<RawHookRunOutcome> {
  if (hook.target.type !== "http") {
    return { ok: false, timedOut: false, durationMs: 0, stdout: "", error: "Not an HTTP hook." };
  }
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(hook.target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...hook.target.headers,
      },
      body: payloadJson,
      signal: controller.signal,
    });
    const text = (await response.text()).slice(0, MAX_HOOK_STDOUT_BYTES);
    clearTimeout(timer);
    return {
      ok: response.ok,
      timedOut: false,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      stdout: text,
      ...(response.ok ? {} : { error: `HTTP ${response.status} ${response.statusText}`.trim() }),
    };
  } catch (error) {
    clearTimeout(timer);
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      timedOut: isAbort,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      stdout: "",
      error: isAbort
        ? `Hook "${hook.id}" timed out after ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

export interface BeforeTurnStartHookOutcome {
  readonly blocked: boolean;
  readonly blockReason?: string | undefined;
  readonly injectedContext?: string | undefined;
  readonly results: ReadonlyArray<HarnessHookExecutionResult>;
}

export interface ToolHookOutcome {
  readonly blocked: boolean;
  readonly blockReason?: string | undefined;
  readonly results: ReadonlyArray<HarnessHookExecutionResult>;
}

export interface PluginHookCustomRunnerResult {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly error?: string | undefined;
}

export type PluginHookCustomRunner = (input: {
  readonly hook: HarnessHookDefinition;
  readonly event: HarnessHookEvent;
  readonly payload: Record<string, unknown>;
  readonly timeoutMs: number;
}) => Promise<PluginHookCustomRunnerResult>;

export interface HarnessHooksServiceShape {
  readonly list: () => Effect.Effect<HarnessHooksSnapshot, HarnessError>;
  readonly upsertUserHook: (
    input: HarnessHookUpsertInput,
  ) => Effect.Effect<HarnessHooksSnapshot, HarnessError>;
  readonly removeUserHook: (
    input: HarnessHookRemoveInput,
  ) => Effect.Effect<HarnessHooksSnapshot, HarnessError>;
  readonly setUserHookEnabled: (
    input: HarnessHookSetEnabledInput,
    authorizeCommand: Effect.Effect<void, EnvironmentAuthorizationError>,
  ) => Effect.Effect<HarnessHooksSnapshot, HarnessError | EnvironmentAuthorizationError>;
  readonly testHook: (
    input: HarnessHookTestInput,
  ) => Effect.Effect<HarnessHookExecutionResult, HarnessError>;
  /** Scoped registration for active trusted plugins: closing the Scope removes all plugin hooks. */
  readonly registerPluginHooks: (
    pluginId: HarnessPluginId,
    hooks: ReadonlyArray<HarnessHookDefinition>,
    customRunners?: ReadonlyMap<string, PluginHookCustomRunner>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly runBeforeTurnStart: (payload: {
    readonly threadId: string;
    readonly modeId?: string | undefined;
    readonly text: string;
    readonly workspaceRoot?: string | undefined;
  }) => Effect.Effect<BeforeTurnStartHookOutcome>;
  readonly runToolHook: (
    phase: "PreToolUse" | "PostToolUse",
    payload: {
      readonly threadId: string;
      readonly toolName: string;
      readonly arguments: Record<string, unknown>;
      readonly workspaceRoot?: string | undefined;
      readonly isError?: boolean | undefined;
    },
  ) => Effect.Effect<ToolHookOutcome>;
  /** Non-blocking lifecycle hook fan-out (never called inside pure decider or SQLite transactions). */
  readonly emitLifecycleEvent: (
    event: Extract<
      HarnessHookEvent,
      "thread.created" | "turn.completed" | "run.settled" | "checkpoint.created"
    >,
    payload: Record<string, unknown>,
  ) => Effect.Effect<void>;
}

export class HarnessHooksService extends Context.Service<
  HarnessHooksService,
  HarnessHooksServiceShape
>()("t3/harness/HarnessHooksService") {}

export const layer = Layer.effect(
  HarnessHooksService,
  Effect.gen(function* () {
    const writeLock = yield* Semaphore.make(1);
    const path = yield* Path.Path;
    const store = yield* HarnessStore.HarnessStore;
    const pluginHooksByPluginId = new Map<HarnessPluginId, ReadonlyArray<HarnessHookDefinition>>();
    const pluginCustomRunnersByPluginId = new Map<
      HarnessPluginId,
      ReadonlyMap<string, PluginHookCustomRunner>
    >();

    const hooksFilePath = () => path.join(store.harnessDir, HOOKS_FILE_NAME);

    const readPolicy = Effect.fn("HarnessHooksService.readPolicy")(function* () {
      const resolved = yield* store.resolveWorkspace();
      return {
        allowsHarness: resolved.managedPolicyAllowsHarness,
        allowsStdio: resolved.managedPolicyAllowsStdio,
      };
    });

    const readUserHooks = Effect.fn("HarnessHooksService.readUserHooks")(function* () {
      const raw = yield* Effect.tryPromise({
        try: () =>
          safeReadFileUtf8(store.harnessDir, hooksFilePath()).catch((error: unknown) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return "";
            }
            throw error;
          }),
        catch: () =>
          new HarnessError({
            code: "io_error",
            detail:
              "Could not safely read hooks.json. Check that the file and harness directory are not symbolic links.",
          }),
      });
      const parsedRecord = tryParseJsonRecord(raw);
      if (!parsedRecord) return [] as ReadonlyArray<HarnessHookDefinition>;
      const decoded = decodeHooksConfigFile(parsedRecord);
      if (decoded._tag === "None") return [] as ReadonlyArray<HarnessHookDefinition>;
      return decoded.value.hooks.filter((hook) => hook.source === "user");
    });

    const writeUserHooks = Effect.fn("HarnessHooksService.writeUserHooks")(function* (
      hooks: ReadonlyArray<HarnessHookDefinition>,
    ) {
      const content = encodePrettyJson({ version: 1, hooks });
      yield* Effect.tryPromise({
        try: () => safeWriteFileAtomic(store.harnessDir, hooksFilePath(), content),
        catch: () =>
          new HarnessError({
            code: "io_error",
            detail:
              "Could not safely write hooks.json. Check that the file and harness directory are not symbolic links.",
          }),
      });
    });

    const allHooks = Effect.fn("HarnessHooksService.allHooks")(function* () {
      const userHooks = yield* readUserHooks();
      const pluginHooks: Array<HarnessHookDefinition> = [];
      for (const list of pluginHooksByPluginId.values()) {
        pluginHooks.push(...list);
      }
      return [...userHooks, ...pluginHooks];
    });

    const buildSnapshot = Effect.fn("HarnessHooksService.buildSnapshot")(function* () {
      const policy = yield* readPolicy();
      const hooks = yield* allHooks();
      return {
        hooksPath: hooksFilePath(),
        hooks,
        managedPolicyAllowsHarness: policy.allowsHarness,
      } satisfies HarnessHooksSnapshot;
    });

    const executeOneHook = Effect.fn("HarnessHooksService.executeOneHook")(function* (
      hook: HarnessHookDefinition,
      event: HarnessHookEvent,
      payload: Record<string, unknown>,
      policy: { readonly allowsHarness: boolean; readonly allowsStdio: boolean },
    ): Effect.fn.Return<HarnessHookExecutionResult> {
      if (!policy.allowsHarness) {
        return {
          hookId: hook.id,
          event,
          ok: false,
          blocked: false,
          durationMs: NonNegativeInt.make(0),
          timedOut: false,
          error: "Portable harness hooks are disabled by managed policy.",
        };
      }
      const customRunner =
        hook.source === "plugin" && hook.pluginId !== undefined
          ? pluginCustomRunnersByPluginId.get(hook.pluginId)?.get(hook.id)
          : undefined;
      if ((hook.target.type === "command" || customRunner !== undefined) && !policy.allowsStdio) {
        return {
          hookId: hook.id,
          event,
          ok: false,
          blocked: Boolean(hook.failClosed),
          ...(hook.failClosed
            ? { blockReason: `Command hook "${hook.id}" blocked by managed stdio policy.` }
            : {}),
          durationMs: NonNegativeInt.make(0),
          timedOut: false,
          error: "Command hooks are disabled by managed policy.",
        };
      }

      const timeoutMs = clampTimeoutMs(hook.timeoutMs);
      const now = yield* DateTime.now;
      const fullPayload: Record<string, unknown> = {
        hookId: hook.id,
        event,
        timestamp: DateTime.formatIso(now),
        ...payload,
      };
      const payloadJson = encodeJson(fullPayload);

      const outcome = yield* Effect.promise(() =>
        customRunner !== undefined
          ? customRunner({ hook, event, payload: fullPayload, timeoutMs })
          : hook.target.type === "command"
            ? runCommandHook(hook, payloadJson, timeoutMs)
            : runHttpHook(hook, payloadJson, timeoutMs),
      );

      if (!outcome.ok) {
        const failClosedBlocked = Boolean(hook.failClosed);
        return {
          hookId: hook.id,
          event,
          ok: false,
          blocked: failClosedBlocked,
          ...(failClosedBlocked
            ? { blockReason: outcome.error ?? `Hook "${hook.id}" failed (fail-closed).` }
            : {}),
          durationMs: NonNegativeInt.make(outcome.durationMs),
          timedOut: outcome.timedOut,
          ...(outcome.stdout.trim() ? { stdout: outcome.stdout.trim() } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        } satisfies HarnessHookExecutionResult;
      }

      const parsed = tryParseJsonRecord(outcome.stdout);
      const blocked = parsed?.block === true || parsed?.allow === false;
      const blockReason =
        typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
          ? parsed.reason.trim()
          : blocked
            ? `Blocked by hook "${hook.id}".`
            : undefined;
      const injectedContext =
        typeof parsed?.injectContext === "string" && parsed.injectContext.trim().length > 0
          ? parsed.injectContext.trim()
          : undefined;

      return {
        hookId: hook.id,
        event,
        ok: true,
        blocked,
        ...(blockReason ? { blockReason } : {}),
        ...(injectedContext ? { injectedContext } : {}),
        durationMs: NonNegativeInt.make(outcome.durationMs),
        timedOut: false,
        ...(outcome.stdout.trim() ? { stdout: outcome.stdout.trim() } : {}),
      } satisfies HarnessHookExecutionResult;
    });

    return HarnessHooksService.of({
      list: Effect.fn("HarnessHooksService.list")(function* () {
        return yield* buildSnapshot();
      }),

      upsertUserHook: Effect.fn("HarnessHooksService.upsertUserHook")(function* (input) {
        const policy = yield* readPolicy();
        if (!policy.allowsHarness) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Portable harness hooks are disabled by managed policy.",
          });
        }
        if (input.target.type === "command" && !policy.allowsStdio) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Command hooks are disabled by managed policy.",
          });
        }
        if (input.target.type === "http" && !/^https?:\/\//i.test(input.target.url)) {
          return yield* new HarnessError({
            code: "invalid_config",
            detail: "HTTP hook URL must start with http:// or https://.",
          });
        }
        const existing = yield* readUserHooks();
        const nextHook: HarnessHookDefinition = {
          id: input.id,
          event: input.event,
          enabled: input.enabled ?? true,
          ...(input.matcher ? { matcher: input.matcher } : {}),
          ...(input.timeoutMs !== undefined
            ? { timeoutMs: PositiveInt.make(clampTimeoutMs(input.timeoutMs)) }
            : {}),
          ...(input.failClosed !== undefined ? { failClosed: input.failClosed } : {}),
          target: input.target,
          ...(input.description ? { description: input.description } : {}),
          source: "user",
        };
        const nextHooks = [...existing.filter((h) => h.id !== input.id), nextHook].toSorted(
          (a, b) => a.id.localeCompare(b.id),
        );
        yield* writeUserHooks(nextHooks);
        return yield* buildSnapshot();
      }, writeLock.withPermits(1)),

      removeUserHook: Effect.fn("HarnessHooksService.removeUserHook")(function* (input) {
        const existing = yield* readUserHooks();
        const nextHooks = existing.filter((h) => h.id !== input.id);
        yield* writeUserHooks(nextHooks);
        return yield* buildSnapshot();
      }, writeLock.withPermits(1)),

      setUserHookEnabled: Effect.fn("HarnessHooksService.setUserHookEnabled")(function* (
        input,
        authorizeCommand,
      ) {
        const existing = yield* readUserHooks();
        const found = existing.find((h) => h.id === input.id);
        if (!found) {
          return yield* new HarnessError({
            code: "not_found",
            detail: `Hook "${input.id}" was not found.`,
          });
        }
        if (input.enabled && found.target.type === "command") yield* authorizeCommand;
        const nextHooks = existing.map((h) =>
          h.id === input.id ? { ...h, enabled: input.enabled } : h,
        );
        yield* writeUserHooks(nextHooks);
        return yield* buildSnapshot();
      }, writeLock.withPermits(1)),

      testHook: Effect.fn("HarnessHooksService.testHook")(function* (input) {
        const hooks = yield* allHooks();
        const hook = hooks.find((candidate) => candidate.id === input.id);
        if (!hook) {
          return yield* new HarnessError({
            code: "not_found",
            detail: `Hook "${input.id}" was not found.`,
          });
        }
        return yield* executeOneHook(
          hook,
          hook.event,
          input.samplePayload ?? { dryRun: true },
          yield* readPolicy(),
        );
      }),

      registerPluginHooks: Effect.fn("HarnessHooksService.registerPluginHooks")(
        function* (pluginId, hooks, customRunners) {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              if (hooks.length > 0) {
                pluginHooksByPluginId.set(pluginId, hooks);
              }
              if (customRunners && customRunners.size > 0) {
                pluginCustomRunnersByPluginId.set(pluginId, customRunners);
              }
            }),
            () =>
              Effect.sync(() => {
                pluginHooksByPluginId.delete(pluginId);
                pluginCustomRunnersByPluginId.delete(pluginId);
              }),
          );
        },
      ),

      runBeforeTurnStart: Effect.fn("HarnessHooksService.runBeforeTurnStart")(function* (payload) {
        const loaded = yield* allHooks().pipe(Effect.result);
        if (loaded._tag === "Failure") {
          return { blocked: true, blockReason: loaded.failure.detail, results: [] };
        }
        const hooks = loaded.success.filter(
          (hook) =>
            hook.enabled &&
            hook.event === "turn.beforeStart" &&
            matchesHookMatcher(hook.matcher, payload.modeId ?? "build"),
        );
        if (hooks.length === 0) {
          return { blocked: false, results: [] } satisfies BeforeTurnStartHookOutcome;
        }
        const policy = yield* readPolicy();
        const results: Array<HarnessHookExecutionResult> = [];
        const injectedParts: Array<string> = [];
        for (const hook of hooks) {
          const result = yield* executeOneHook(hook, "turn.beforeStart", payload, policy);
          results.push(result);
          if (!result.ok) {
            yield* Effect.logWarning("harness.hook.turn-before-start.failed", {
              hookId: hook.id,
              timedOut: result.timedOut,
              error: result.error,
              failClosed: Boolean(hook.failClosed),
            });
          }
          if (result.blocked) {
            return {
              blocked: true,
              blockReason: result.blockReason ?? `Turn blocked by hook "${hook.id}".`,
              results,
            } satisfies BeforeTurnStartHookOutcome;
          }
          if (result.injectedContext) {
            injectedParts.push(result.injectedContext);
          }
        }
        return {
          blocked: false,
          ...(injectedParts.length > 0 ? { injectedContext: injectedParts.join("\n\n") } : {}),
          results,
        } satisfies BeforeTurnStartHookOutcome;
      }),

      runToolHook: Effect.fn("HarnessHooksService.runToolHook")(function* (phase, payload) {
        const loaded = yield* allHooks().pipe(Effect.result);
        if (loaded._tag === "Failure") {
          return { blocked: true, blockReason: loaded.failure.detail, results: [] };
        }
        const hooks = loaded.success.filter(
          (hook) =>
            hook.enabled &&
            hook.event === phase &&
            matchesHookMatcher(hook.matcher, payload.toolName),
        );
        if (hooks.length === 0) {
          return { blocked: false, results: [] } satisfies ToolHookOutcome;
        }
        const policy = yield* readPolicy();
        if (phase === "PostToolUse") {
          // PostToolUse runs asynchronously so tool responses never stall on audit hooks.
          yield* Effect.forkDetach(
            Effect.forEach(hooks, (hook) => executeOneHook(hook, "PostToolUse", payload, policy), {
              concurrency: 4,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("harness.hook.post-tool-use.failed", { cause }),
              ),
            ),
          );
          return { blocked: false, results: [] } satisfies ToolHookOutcome;
        }
        const results: Array<HarnessHookExecutionResult> = [];
        for (const hook of hooks) {
          const result = yield* executeOneHook(hook, "PreToolUse", payload, policy);
          results.push(result);
          if (result.blocked) {
            return {
              blocked: true,
              blockReason: result.blockReason ?? `Tool call blocked by hook "${hook.id}".`,
              results,
            } satisfies ToolHookOutcome;
          }
        }
        return { blocked: false, results } satisfies ToolHookOutcome;
      }),

      emitLifecycleEvent: Effect.fn("HarnessHooksService.emitLifecycleEvent")(
        function* (event, payload) {
          const hooks = (yield* allHooks().pipe(
            Effect.catch((error) =>
              Effect.logWarning("harness.hook.load.failed", { detail: error.detail }).pipe(
                Effect.as([]),
              ),
            ),
          )).filter((hook) => hook.enabled && hook.event === event);
          if (hooks.length === 0) return;
          const policy = yield* readPolicy();
          yield* Effect.forkDetach(
            Effect.forEach(hooks, (hook) => executeOneHook(hook, event, payload, policy), {
              concurrency: 4,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("harness.hook.lifecycle.failed", { event, cause }),
              ),
            ),
          );
        },
      ),
    });
  }),
);
