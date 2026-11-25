import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import {
  AuthProvidersManageScope,
  HarnessError,
  type ChatAttachment,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import * as HarnessHooksService from "../harness/HarnessHooksService.ts";
import * as HarnessLibraryStore from "../harness/HarnessLibraryStore.ts";
import { normalizeModeSelection, preprocessTurnText } from "../harness/HarnessTurnPreprocess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";

import * as AttachmentClaims from "./AttachmentClaims.ts";
import { isProviderSignOutPrompt } from "./CommandPolicy.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const resolveWorkspaceRootForThread = Effect.fn(
  "ThreadMessageIntake.resolveWorkspaceRootForThread",
)(function* (threadId: import("@t3tools/contracts").ThreadId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  if (shell === null) return { shell: null, workspaceRoot: undefined as string | undefined };
  if (shell.worktreePath !== null) {
    return { shell, workspaceRoot: shell.worktreePath };
  }
  const projectsOpt = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  if (Option.isSome(projectsOpt)) {
    const proj = yield* projectsOpt.value
      .get(shell.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(proj)) {
      return { shell, workspaceRoot: proj.value.workspaceRoot };
    }
  }
  return { shell, workspaceRoot: undefined as string | undefined };
});

// These failures precede commitCommand; generic dispatch errors can follow commits and remain ambiguous.
function dispatchWasNotAccepted(
  error: Orchestrator.OrchestratorV2Error | ThreadManagement.ThreadManagementError,
) {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "OrchestratorProviderSelectionBusyError":
    case "OrchestratorRuntimeModeAboveCeilingError":
    case "ThreadManagementProviderInstanceDisabledError":
    case "ThreadManagementWorktreeRestoreError":
      return true;
    default:
      return false;
  }
}
const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);
const isThreadManagementError = Schema.is(ThreadManagement.ThreadManagementError);

const releaseUnusedClaims = Effect.fn("ThreadMessageIntake.releaseUnusedClaims")(function* (
  claimedPaths: ReadonlyArray<string>,
  accepted: ReadonlyArray<ChatAttachment>,
) {
  if (claimedPaths.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  const retained = new Set(
    accepted.flatMap((attachment) => {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      return path ? [path, `${path}.txt`] : [];
    }),
  );
  yield* AttachmentClaims.releaseClaimedAttachments(
    claimedPaths.filter((path) => !retained.has(path)),
  );
});

/**
 * A guest message goes out with the files the guest attached, never ones a client names. They
 * are already the thread's attachments. A message no longer waiting gets none; the orchestrator
 * then refuses or replays the send.
 */
const readGuestMessage = Effect.fn("ThreadMessageIntake.readGuestMessage")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
) {
  if (command.guestMessageId === undefined) return undefined;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Only the thread record is needed; the window keeps the read small.
  const { projection } = yield* threads
    .getThreadSnapshotWindow(command.threadId, { rowLimit: 1 })
    .pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentClaims.AttachmentClaimError({
            message: "Failed to read the guest message.",
            cause,
          }),
      ),
    );
  return projection.thread.guestShare?.messages.find(
    (candidate) => candidate.id === command.guestMessageId && candidate.status === "pending",
  );
});

/**
 * For a caller without `providers:manage`. An edit that omits `attachments` keeps the queued
 * ones, so `/logout` signs out only when the queued message has none. The edit goes on with
 * the files read here, so an edit racing this one cannot strip them afterwards.
 */
export const withQueuedAttachmentsOnSignOutText = Effect.fn(
  "ThreadMessageIntake.withQueuedAttachmentsOnSignOutText",
)(function* (command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>) {
  if (
    command.attachments !== undefined ||
    !isProviderSignOutPrompt({ text: command.text, attachments: [] })
  ) {
    return command;
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  // A retry of an accepted edit replays its receipt, even after its run left the queue.
  if (yield* threads.hasReceipt(command.commandId)) return command;
  const { runs } = yield* threads.getThreadRecords(command.threadId, ["runs"], {
    runIds: [command.runId],
  });
  const queuedRun = runs.find((run) => run.id === command.runId && run.status === "queued");
  const attachments =
    queuedRun === undefined
      ? []
      : ((yield* threads.getMessagesById(command.threadId, [queuedRun.userMessageId])).get(
          queuedRun.userMessageId,
        )?.attachments ?? []);
  if (attachments.length === 0) return yield* rpcAuthorizationError(AuthProvidersManageScope);
  return { ...command, attachments };
});

/**
 * `sender.managesProviders` is whether the caller holds `providers:manage`. RPC authorization
 * has already checked every command whose payload shows a provider sign-out; a queued edit
 * that keeps its attachments is the one case decided here.
 */
export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(
  function* (incoming: OrchestrationV2Command, sender: { readonly managesProviders: boolean }) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    if (
      (incoming.type === "message.dispatch" || incoming.type === "queued-run.edit") &&
      (yield* threads.hasReceipt(incoming.commandId))
    ) {
      return yield* threads.dispatch(incoming);
    }
    const { command, guestText } = yield* Effect.gen(function* () {
      if (incoming.type !== "message.dispatch" && incoming.type !== "queued-run.edit") {
        return { command: incoming };
      }

      const guestMessage =
        incoming.type === "message.dispatch" ? yield* readGuestMessage(incoming) : undefined;
      const isGuest = incoming.type === "message.dispatch" && incoming.guestMessageId !== undefined;
      const input = isGuest
        ? { ...incoming, attachments: guestMessage?.attachments ?? [] }
        : incoming;
      if (isGuest && guestMessage === undefined) return { command: input };
      const originalText = isGuest ? (guestMessage?.text ?? "") : input.text;
      const libraryStore = yield* Effect.serviceOption(HarnessLibraryStore.HarnessLibraryStore);
      const hooksService = yield* Effect.serviceOption(HarnessHooksService.HarnessHooksService);
      const { shell, workspaceRoot } = yield* resolveWorkspaceRootForThread(input.threadId);
      const preprocessed = yield* preprocessTurnText({
        text: originalText,
        threadId: input.threadId,
        workspaceRoot,
        modeId: shell?.modeId,
        interactionMode: shell?.interactionMode,
        libraryStore,
        hooksService,
      });

      if (preprocessed.blocked) {
        return yield* new HarnessError({
          code: "policy_denied",
          detail: preprocessed.blockReason ?? "Turn blocked by turn.beforeStart hook.",
        });
      }
      if (isGuest) {
        return { command: input, guestText: preprocessed.text };
      }
      const next = { ...input, text: preprocessed.text };
      if (!sender.managesProviders) {
        if (next.type === "queued-run.edit" && next.attachments === undefined) {
          return { command: yield* withQueuedAttachmentsOnSignOutText(next) };
        }
        if (
          (next.type === "queued-run.edit" || preprocessed.text !== originalText) &&
          isProviderSignOutPrompt({ text: next.text, attachments: next.attachments ?? [] })
        ) {
          return yield* rpcAuthorizationError(AuthProvidersManageScope);
        }
      }
      return { command: next };
    });
    if (command.type === "runtime-request.respond" && command.attachmentsByQuestionId) {
      const config = yield* ServerConfig.ServerConfig;
      const incomingByQuestionId = command.attachmentsByQuestionId;
      yield* AttachmentClaims.validateAttachmentLimits(Object.values(incomingByQuestionId).flat());
      const claimedPaths: string[] = [];
      const prepared = yield* Effect.gen(function* () {
        const attachmentsByQuestionId: import("@t3tools/contracts").UserInputAttachments = {};
        for (const [questionId, attachments] of Object.entries(incomingByQuestionId)) {
          const claimed = yield* AttachmentClaims.claimPendingAttachments({
            threadId: command.threadId,
            attachments,
          });
          claimedPaths.push(...claimed.claimedPaths);
          Object.defineProperty(attachmentsByQuestionId, questionId, {
            value: claimed.attachments,
            enumerable: true,
          });
        }
        const answers = yield* appendUserInputAttachmentPaths({
          answers: command.answers ?? {},
          attachmentsByQuestionId,
          attachmentsDir: config.attachmentsDir,
        }).pipe(
          Effect.mapError(
            (cause) => new AttachmentClaims.AttachmentClaimError({ message: cause.issue }),
          ),
        );
        return { answers, attachmentsByQuestionId };
      }).pipe(Effect.onError(() => AttachmentClaims.releaseClaimedAttachments(claimedPaths)));
      return yield* threads
        .dispatch({
          ...command,
          answers: prepared.answers,
          attachmentsByQuestionId: prepared.attachmentsByQuestionId,
        })
        .pipe(
          Effect.tap((result) => {
            // Replayed receipts refer to the first answer; release this attempt's unused copies only with a resolved item.
            // Missing questionAnswer means no accepted attachments; missing resolution leaves delivery ambiguous.
            const answeredItems = result.storedEvents.flatMap(({ event }) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "user_input_request" &&
              event.payload.requestId === command.requestId
                ? [event.payload]
                : [],
            );
            return answeredItems.length > 0
              ? releaseUnusedClaims(
                  claimedPaths,
                  answeredItems.flatMap((item) =>
                    item.questionAnswer === undefined
                      ? []
                      : Object.values(item.questionAnswer.attachmentsByQuestionId).flat(),
                  ),
                )
              : Effect.void;
          }),
          Effect.tapError((error) =>
            dispatchWasNotAccepted(error)
              ? AttachmentClaims.releaseClaimedAttachments(claimedPaths)
              : Effect.void,
          ),
        );
    }
    const commandWithModeDigest = yield* Effect.gen(function* () {
      if (
        (command.type === "thread.create" || command.type === "thread.interaction-mode.set") &&
        command.modeId !== undefined &&
        command.modeDigest === undefined
      ) {
        const libraryStore = yield* Effect.serviceOption(HarnessLibraryStore.HarnessLibraryStore);
        const workspaceRoot =
          command.type === "thread.interaction-mode.set"
            ? (yield* resolveWorkspaceRootForThread(command.threadId)).workspaceRoot
            : undefined;
        const normalized = yield* normalizeModeSelection({
          modeId: command.modeId,
          modeDigest: command.modeDigest,
          interactionMode: command.interactionMode,
          workspaceRoot,
          libraryStore,
        });
        if (
          normalized.interactionMode !== command.interactionMode ||
          normalized.modeDigest !== command.modeDigest
        ) {
          return {
            ...command,
            interactionMode: normalized.interactionMode,
            ...(normalized.modeDigest !== undefined ? { modeDigest: normalized.modeDigest } : {}),
          };
        }
      }
      return command;
    });

    if (
      commandWithModeDigest.type !== "message.dispatch" &&
      (commandWithModeDigest.type !== "queued-run.edit" ||
        commandWithModeDigest.attachments === undefined)
    ) {
      const dispatched = yield* threads.dispatch(commandWithModeDigest);
      if (commandWithModeDigest.type === "thread.create" && dispatched.replayed !== true) {
        const hooksOpt = yield* Effect.serviceOption(HarnessHooksService.HarnessHooksService);
        if (Option.isSome(hooksOpt)) {
          yield* hooksOpt.value.emitLifecycleEvent("thread.created", {
            threadId: commandWithModeDigest.threadId,
            projectId: commandWithModeDigest.projectId,
            ...(commandWithModeDigest.modeId ? { modeId: commandWithModeDigest.modeId } : {}),
          });
        }
      }
      return dispatched;
    }
    // An accepted edit's retry replays its receipt even if a later cleanup removed its files.
    if (
      commandWithModeDigest.type === "queued-run.edit" &&
      !(yield* threads.hasReceipt(commandWithModeDigest.commandId))
    ) {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      // A stale view can keep a file that another client's edit dropped and deleted.
      for (const attachment of commandWithModeDigest.attachments ?? []) {
        if (AttachmentClaims.attachmentIsPendingUpload(attachment)) continue;
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        if (
          path !== null &&
          !(yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)))
        ) {
          return yield* new AttachmentClaims.AttachmentClaimError({
            message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
          });
        }
      }
    }
    const claimed = yield* AttachmentClaims.claimPendingAttachments({
      threadId: commandWithModeDigest.threadId,
      attachments: commandWithModeDigest.attachments ?? [],
    });
    return yield* threads
      .dispatch(
        {
          ...commandWithModeDigest,
          attachments: claimed.attachments,
          ...(commandWithModeDigest.context
            ? {
                context: remapComposerContextAttachments(
                  commandWithModeDigest.context,
                  commandWithModeDigest.attachments ?? [],
                  claimed.attachments,
                ),
              }
            : {}),
        },
        guestText === undefined ? undefined : { preprocessedGuestText: guestText },
      )
      .pipe(
        Effect.tap((result) =>
          releaseUnusedClaims(
            claimed.claimedPaths,
            result.storedEvents.flatMap(({ event }) =>
              event.type === "message.updated" ? event.payload.attachments : [],
            ),
          ),
        ),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
            : Effect.void,
        ),
      );
  },
  (effect, incoming) =>
    incoming.type === "message.dispatch" || incoming.type === "queued-run.edit"
      ? Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
          threads.withMessageIntakeLock(incoming.commandId, effect),
        )
      : effect,
);

export const sendToThread = Effect.fn("ThreadMessageIntake.sendToThread")(function* (
  input: ThreadManagement.ThreadManagementSendInput,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claimed = yield* AttachmentClaims.claimPendingAttachments(input);
  return yield* threads.sendToThread({ ...input, attachments: claimed.attachments }).pipe(
    Effect.tap((result) => releaseUnusedClaims(claimed.claimedPaths, result.message.attachments)),
    Effect.tapError((error) =>
      dispatchWasNotAccepted(error)
        ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
        : Effect.void,
    ),
  );
});

export const launchThread = Effect.fn("ThreadMessageIntake.launchThread")(function* (
  input: ThreadLaunch.ThreadLaunchInput,
) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);
  if (!input.initialMessage?.attachments.some(AttachmentClaims.attachmentIsPendingUpload)) {
    return yield* launches.launch(input);
  }
  if (input.threadId === undefined) {
    return yield* new AttachmentClaims.AttachmentClaimError({
      message: "Uploaded attachments need a thread id at launch.",
    });
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: input.threadId,
    attachments: input.initialMessage.attachments,
  });
  return yield* launches
    .launch({
      ...input,
      initialMessage: {
        ...input.initialMessage,
        attachments: claimed.attachments,
        ...(input.initialMessage.context
          ? {
              context: remapComposerContextAttachments(
                input.initialMessage.context,
                input.initialMessage.attachments,
                claimed.attachments,
              ),
            }
          : {}),
      },
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.projection.messages.flatMap((message) => message.attachments),
        ),
      ),
      Effect.tapError((error) => {
        if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
          return AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths);
        }
        // Project/receipt reads precede dispatch; create-thread errors can wrap post-message reads and prove nothing alone.
        const notAccepted =
          error.operation === "resolve-project" ||
          error.operation === "read-receipt" ||
          ((error.operation === "create-thread" || error.operation === "dispatch-message") &&
            (isOrchestratorError(error.cause) || isThreadManagementError(error.cause)) &&
            // Projection errors under create-thread can occur after the message commit.
            (error.operation !== "create-thread" ||
              error.cause._tag !== "OrchestratorProjectionError") &&
            dispatchWasNotAccepted(error.cause));
        return notAccepted
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void;
      }),
    );
});
