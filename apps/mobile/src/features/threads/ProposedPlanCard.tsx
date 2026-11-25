import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type EnvironmentId,
  type OrchestrationV2PlanArtifact,
  type PlanId,
  type ThreadId,
} from "@t3tools/contracts";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { T, useGT } from "gt-react-native";
import { useRef, useState, type ReactNode } from "react";
import { Modal, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { useQuietThreadShell, useThreadProposedPlanStatus } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { updateComposerDraftSettings } from "../../state/use-composer-drafts";
import { CopyTextButton } from "./CopyTextButton";

export function ProposedPlanCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId | undefined;
  readonly planId?: PlanId | undefined;
  readonly planStatus?: OrchestrationV2PlanArtifact["status"] | undefined;
  readonly workspaceRoot: string | null | undefined;
  readonly markdown: string;
  readonly renderMarkdown: (text: string) => ReactNode;
}) {
  const gt = useGT();
  const threadRef =
    props.threadId !== undefined ? scopeThreadRef(props.environmentId, props.threadId) : null;
  const threadShell = useQuietThreadShell(threadRef);
  const canWrite = useAtomValue(projectEnvironment.writeFile.permissionAtom(props.environmentId));
  const canOperateThread = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const setInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [implementing, setImplementing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editedMarkdown, setEditedMarkdown] = useState(props.markdown);
  const [lastPath, setLastPath] = useState("plan.md");
  const contents = `${props.markdown.trimEnd()}\n`;
  const livePlanStatus = useThreadProposedPlanStatus(threadRef, props.planId);
  const planStatus = props.planStatus ?? livePlanStatus;
  // Server orchestration only accepts `sourceProposedPlan` execution while the plan is active.
  const canExecutePlan =
    planStatus === "active" &&
    canOperateThread &&
    props.threadId !== undefined &&
    props.planId !== undefined &&
    threadShell !== null;

  const save = async (path: string) => {
    const relativePath = path.trim();
    if (!canWrite || !props.workspaceRoot || inFlight.current) return;
    if (!relativePath) {
      Dialog.alert(gt("Enter a workspace path"));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setLastPath(relativePath);
    const result = await writeFile({
      environmentId: props.environmentId,
      input: { cwd: props.workspaceRoot, relativePath, contents },
    }).finally(() => {
      inFlight.current = false;
      setSaving(false);
    });
    if (result._tag === "Success") {
      Dialog.alert(gt("Plan saved to workspace"), result.value.relativePath);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(gt("Could not save plan"), errorDisplayMessage(error, m) ?? String(error));
    }
  };

  const implementPlan = async (options?: {
    readonly markdown?: string;
    readonly freshContext?: boolean;
  }) => {
    if (!canExecutePlan || !props.threadId || !props.planId || !threadShell || implementing) {
      return;
    }
    const planText = (options?.markdown ?? props.markdown).trim();
    if (!planText) return;
    const threadKey = scopedThreadKey(props.environmentId, props.threadId);
    const createdAt = new Date().toISOString();
    setImplementing(true);
    updateComposerDraftSettings(threadKey, {
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
    const modeResult =
      threadShell.interactionMode !== DEFAULT_PROVIDER_INTERACTION_MODE
        ? await setInteractionMode({
            environmentId: props.environmentId,
            input: {
              threadId: props.threadId,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt,
            },
          })
        : null;
    if (modeResult && modeResult._tag === "Failure") {
      setImplementing(false);
      if (!isAtomCommandInterrupted(modeResult)) {
        const error = squashAtomCommandFailure(modeResult);
        Dialog.alert(
          gt("Could not switch back to build mode"),
          errorDisplayMessage(error, m) ?? String(error),
        );
      }
      return;
    }

    const turnResult = await startTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          // oxlint-disable-next-line t3code/no-untranslated-copy -- Agent prompt stays English (docs/internals/14_i18n.md).
          text: `Implement the approved plan:\n\n${planText}`,
          attachments: [],
        },
        modelSelection: threadShell.modelSelection,
        runtimeMode: threadShell.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        sourceProposedPlan: {
          threadId: props.threadId,
          planId: props.planId,
        },
        ...(options?.freshContext ? { freshContext: true } : {}),
        createdAt,
      },
    }).finally(() => {
      setImplementing(false);
    });
    if (turnResult._tag === "Failure" && !isAtomCommandInterrupted(turnResult)) {
      const error = squashAtomCommandFailure(turnResult);
      Dialog.alert(
        gt("Could not start plan implementation"),
        errorDisplayMessage(error, m) ?? String(error),
      );
    }
  };

  const continuePlanning = () => {
    if (!props.threadId) return;
    const threadKey = scopedThreadKey(props.environmentId, props.threadId);
    updateComposerDraftSettings(threadKey, { interactionMode: "plan" });
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row items-center gap-2">
        <View className="flex-1 flex-row items-center gap-2">
          <Text accessibilityRole="header" className="font-t3-bold text-base text-foreground">
            {proposedPlanTitle(props.markdown) ?? gt("Proposed plan")}
          </Text>
          {planStatus === "completed" ? (
            <Text className="text-xs font-t3-medium text-foreground-muted">
              <T>Completed</T>
            </Text>
          ) : planStatus === "superseded" ? (
            <Text className="text-xs font-t3-medium text-foreground-muted">
              <T>Superseded</T>
            </Text>
          ) : null}
        </View>
        <CopyTextButton accessibilityLabel={gt("Copy plan")} text={contents} />
      </View>
      {props.renderMarkdown(stripDisplayedPlanMarkdown(props.markdown))}
      <View className="flex-row flex-wrap gap-2">
        {canExecutePlan ? (
          <>
            <Button
              label={implementing ? gt("Starting...") : gt("Implement plan")}
              tone="primary"
              disabled={implementing}
              onPress={() => void implementPlan()}
            />
            <Button
              label={gt("Fresh context")}
              tone="secondary"
              disabled={implementing}
              onPress={() => void implementPlan({ freshContext: true })}
            />
            <Button
              label={gt("Edit")}
              tone="secondary"
              disabled={implementing}
              onPress={() => {
                setEditedMarkdown(props.markdown);
                setEditOpen(true);
              }}
            />
            <Button
              label={gt("Continue planning")}
              tone="secondary"
              disabled={implementing}
              onPress={continuePlanning}
            />
          </>
        ) : null}
        <Button
          label={saving ? gt("Saving...") : gt("Save to workspace")}
          tone="secondary"
          disabled={!canWrite || !props.workspaceRoot || saving}
          onPress={() =>
            Dialog.prompt({
              title: gt("Save plan to workspace"),
              // The write replaces an existing file, and the RPC has no create-only mode.
              message: gt(
                "Enter a path relative to the thread's workspace. A file already at that path is replaced.",
              ),
              initialValue: lastPath,
              confirmText: gt("Save", { $context: "verb, confirm button" }),
              onConfirm: (path) => void save(path),
            })
          }
        />
      </View>

      <Modal
        visible={editOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setEditOpen(false)}
      >
        <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
          <Text className="font-t3-bold text-xl text-foreground">
            <T>Edit plan before implementing</T>
          </Text>
          <TextInput
            value={editedMarkdown}
            onChangeText={setEditedMarkdown}
            multiline
            textAlignVertical="top"
            className="min-h-64 rounded-xl border border-border bg-card p-3 text-sm text-foreground"
          />
          <View className="flex-row gap-2">
            <Button
              label={implementing ? gt("Starting...") : gt("Implement plan")}
              tone="primary"
              disabled={implementing || editedMarkdown.trim().length === 0}
              onPress={() => {
                setEditOpen(false);
                void implementPlan({ markdown: editedMarkdown });
              }}
            />
            <Button label={gt("Cancel")} tone="secondary" onPress={() => setEditOpen(false)} />
          </View>
        </ScrollView>
      </Modal>
    </View>
  );
}
