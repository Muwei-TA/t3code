import type {
  HarnessModeId,
  OrchestrationV2RunHarnessMode,
  ProviderInteractionMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as HarnessHooksService from "./HarnessHooksService.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import { expandPortableCommand } from "./HarnessProjector.ts";

export interface TurnPreprocessResult {
  readonly blocked: boolean;
  readonly blockReason?: string | undefined;
  readonly text: string;
  readonly expanded: boolean;
}

/**
 * Shared transaction-external turn preprocessing used across WS dispatch, WS/MCP/Scheduled launch,
 * and `sendToThread`: expands portable `/<command>` templates and runs `turn.beforeStart` hooks.
 */
export const preprocessTurnText = Effect.fn("HarnessTurnPreprocess.preprocessTurnText")(
  function* (input: {
    readonly text: string;
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | undefined;
    readonly modeId?: HarnessModeId | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
    readonly libraryStore: Option.Option<HarnessLibraryStore.HarnessLibraryStore["Service"]>;
    readonly hooksService: Option.Option<HarnessHooksService.HarnessHooksService["Service"]>;
  }) {
    let expandedText = input.text;
    if (input.text.trimStart().startsWith("/") && Option.isSome(input.libraryStore)) {
      const snapshot = yield* input.libraryStore.value
        .getSnapshot(input.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => null));
      if (
        snapshot !== null &&
        snapshot.managedPolicyAllowsHarness &&
        snapshot.commands.length > 0
      ) {
        const expanded = expandPortableCommand({
          text: input.text,
          commands: snapshot.commands,
        });
        expandedText = expanded.text;
      }
    }

    let finalText = expandedText;
    if (Option.isSome(input.hooksService)) {
      const effectiveModeId = input.modeId ?? (input.interactionMode === "plan" ? "plan" : "build");
      const beforeOutcome = yield* input.hooksService.value.runBeforeTurnStart({
        threadId: input.threadId,
        modeId: effectiveModeId,
        text: expandedText,
        workspaceRoot: input.workspaceRoot,
      });
      if (beforeOutcome.blocked) {
        return {
          blocked: true,
          blockReason: beforeOutcome.blockReason ?? "Turn blocked by turn.beforeStart hook.",
          text: expandedText,
          expanded: expandedText !== input.text,
        } satisfies TurnPreprocessResult;
      }
      if (beforeOutcome.injectedContext) {
        finalText = `${beforeOutcome.injectedContext}\n\n${expandedText}`;
      }
    }

    return {
      blocked: false,
      text: finalText,
      expanded: expandedText !== input.text,
    } satisfies TurnPreprocessResult;
  },
);

/** Normalizes `modeId` to its resolved `baseInteractionMode` and live `contentDigest`. */
export const normalizeModeSelection = Effect.fn("HarnessTurnPreprocess.normalizeModeSelection")(
  function* (input: {
    readonly modeId?: HarnessModeId | undefined;
    readonly modeDigest?: string | undefined;
    readonly interactionMode: ProviderInteractionMode;
    readonly workspaceRoot?: string | undefined;
    readonly libraryStore: Option.Option<HarnessLibraryStore.HarnessLibraryStore["Service"]>;
  }) {
    if (input.modeId === undefined || input.modeDigest !== undefined) {
      return {
        interactionMode: input.interactionMode,
        modeDigest: input.modeDigest,
      };
    }
    if (Option.isNone(input.libraryStore)) {
      return {
        interactionMode: input.interactionMode,
        modeDigest: input.modeDigest,
      };
    }
    const resolved = yield* input.libraryStore.value
      .resolveMode({
        modeId: input.modeId,
        interactionMode: input.interactionMode,
        workspaceRoot: input.workspaceRoot,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (resolved === null) {
      return {
        interactionMode: input.interactionMode,
        modeDigest: input.modeDigest,
      };
    }
    return {
      interactionMode: resolved.baseInteractionMode,
      modeDigest: resolved.contentDigest,
    };
  },
);

export function runInteractionMode(
  threadMode: ProviderInteractionMode,
  runMode: OrchestrationV2RunHarnessMode | undefined,
): ProviderInteractionMode {
  return threadMode === "plan" || runMode?.interactionMode === "plan" ? "plan" : "default";
}

export const resolveRunHarnessMode = Effect.fn("HarnessTurnPreprocess.resolveRunHarnessMode")(
  function* (
    library: HarnessLibraryStore.HarnessLibraryStore["Service"],
    input: {
      readonly modeId?: HarnessModeId | undefined;
      readonly interactionMode: ProviderInteractionMode;
      readonly workspaceRoot?: string | undefined;
      readonly override?: OrchestrationV2RunHarnessMode | undefined;
    },
  ) {
    const threadMode = yield* library.resolveMode(input);
    if (input.override === undefined || input.override.id === input.modeId) return threadMode;
    const runMode = yield* library.resolveMode({
      modeId: input.override.id,
      interactionMode: input.override.interactionMode,
      workspaceRoot: input.workspaceRoot,
    });
    if (runMode === null || threadMode === null) return runMode ?? threadMode;

    const allowedMcpServers =
      threadMode.allowedMcpServers === undefined
        ? runMode.allowedMcpServers
        : runMode.allowedMcpServers === undefined
          ? threadMode.allowedMcpServers
          : runMode.allowedMcpServers.filter((server) =>
              threadMode.allowedMcpServers!.includes(server),
            );
    return {
      ...runMode,
      readonly: runMode.readonly || threadMode.readonly,
      ...(allowedMcpServers === undefined ? {} : { allowedMcpServers }),
      disabledMcpServers: [
        ...new Set([
          ...(runMode.disabledMcpServers ?? []),
          ...(threadMode.disabledMcpServers ?? []),
        ]),
      ],
    };
  },
);
