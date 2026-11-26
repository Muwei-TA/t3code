import { useAtomValue } from "@effect/atom-react";
import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  workflowRunState,
  workflowThreadProgress,
  type WorkflowBeat,
  type WorkflowRunNode,
} from "@t3tools/client-runtime/workflows";
import {
  ThreadId,
  type EnvironmentId,
  type WorkflowQuestion,
  type WorkflowRunsSnapshot,
} from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkflowQuestionCard } from "./WorkflowRunRouteScreen";
import { reportFailure, useCanOpenThread, workflowRunFeedOf } from "./WorkflowStepCard";
import { WORKFLOW_TONE_CLASS } from "./WorkflowsScreen";
import { WorkflowTimeline } from "./WorkflowTimeline";

export function ThreadWorkflowRuns({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: WorkflowRunsSnapshot;
}) {
  const gt = useGT();
  const [showAll, setShowAll] = useState(false);
  const nodes = allWorkflowRunNodes(groupWorkflowRuns([], snapshot.runs, snapshot.questions));
  const visible = showAll
    ? nodes
    : nodes.filter((node, index) => index < 5 || node.run.endedAt === null);
  return (
    <View className="gap-2 py-2">
      {visible.map((node) => (
        <RunCard key={node.run.runId} environmentId={environmentId} node={node} />
      ))}
      {visible.length < nodes.length ? (
        <Button
          tone="text"
          label={gt("Show earlier workflow runs")}
          onPress={() => setShowAll(true)}
        />
      ) : null}
    </View>
  );
}

function RunCard({
  environmentId,
  node,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkflowRunNode;
}) {
  const { run } = node;
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const [openedAtMs] = useState(() => Date.now());
  const acting = useRef(false);
  const [busy, setBusy] = useState(false);
  const detail = useEnvironmentQuery(
    expanded || run.endedAt === null
      ? serverEnvironment.workflowRun({
          environmentId,
          input: {
            runId: run.runId,
            ...(run.hostThreadId === undefined ? {} : { hostThreadId: run.hostThreadId }),
          },
        })
      : null,
  );
  const canOperate = useAtomValue(
    serverEnvironment.resumeWorkflowRun.permissionAtom(environmentId),
  );
  const pause = useAtomCommand(serverEnvironment.pauseWorkflowRun, { reportFailure: false });
  const resume = useAtomCommand(serverEnvironment.resumeWorkflowRun, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelWorkflowRun, { reportFailure: false });
  const target = { environmentId, input: { runId: run.runId } };
  const progress = workflowThreadProgress(detail.data);
  const state = workflowRunState(node, m);
  const canOpenThread = useCanOpenThread(environmentId);
  const openThread = (thread: NonNullable<WorkflowBeat["thread"]>) =>
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: thread.environmentId ?? environmentId,
        threadId: ThreadId.make(thread.threadId),
      }),
    );
  const act = async (verb: "resume" | "cancel" | "pause") => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    const action = verb === "resume" ? resume : verb === "pause" ? pause : cancel;
    reportFailure(
      verb === "resume"
        ? gt("Could not resume the run")
        : verb === "pause"
          ? gt("Could not pause the run")
          : gt("Could not cancel the run"),
      await action(target).finally(() => {
        acting.current = false;
        setBusy(false);
      }),
    );
  };
  const renderQuestion = (question: WorkflowQuestion, inline = false) => (
    <WorkflowQuestionCard
      key={question.name}
      inline={inline}
      environmentId={environmentId}
      question={question}
      canAnswer={canOperate}
      onOpenThread={
        question.thread !== null &&
        question.thread.threadId !== run.hostThreadId &&
        canOpenThread(question.thread)
          ? openThread
          : null
      }
    />
  );
  const rows = expanded && detail.data !== null ? workflowRunFeedOf(node, detail.data.steps) : null;
  const questionFor = (beat: WorkflowBeat) =>
    beat.kind === "ask" && beat.status === "running"
      ? (node.questions.find((question) => question.name === beat.name) ?? null)
      : null;
  const beats = (rows ?? []).flatMap((row) =>
    row.kind === "quick" ? [] : row.kind === "together" ? row.beats : [row],
  );
  return (
    <View className="gap-2 rounded-xl border border-divider bg-grouped-card p-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center gap-2 px-1 py-2"
      >
        <SymbolView name={expanded ? "chevron.down" : "chevron.right"} size={12} />
        <Text className="min-w-0 flex-1 font-t3-medium text-foreground" numberOfLines={1}>
          {run.title}
        </Text>
        <Text className={cn("text-xs", WORKFLOW_TONE_CLASS[state.tone])}>{state.word}</Text>
      </Pressable>
      {progress !== null && progress.total > 0 ? (
        <Text className="px-1 text-xs text-foreground-muted">
          {gt("{completed}/{total} stages", {
            completed: progress.completed,
            total: progress.total,
          })}
          {progress.active ? ` · ${progress.active}` : ""}
        </Text>
      ) : null}
      {canOperate && run.endedAt === null ? (
        <View className="flex-row gap-2">
          {run.supportsStagePause && run.status !== "paused" ? (
            <Button
              tone="secondary"
              label={run.pauseRequested ? gt("Keep running") : gt("Pause after this stage")}
              disabled={busy}
              onPress={() => void act(run.pauseRequested ? "resume" : "pause")}
            />
          ) : null}
          {run.status === "paused" && !run.retired ? (
            <Button
              tone="secondary"
              label={gt("Resume now")}
              disabled={busy}
              onPress={() => void act("resume")}
            />
          ) : null}
          <Button
            tone="text"
            label={gt("Stop")}
            disabled={busy}
            onPress={() =>
              Dialog.alert(
                gt("Cancel this run?"),
                gt("Its agents stop and the run cannot be resumed."),
                [
                  { text: gt("Keep it"), style: "cancel" },
                  {
                    text: gt("Cancel run"),
                    style: "destructive",
                    onPress: () => void act("cancel"),
                  },
                ],
              )
            }
          />
        </View>
      ) : null}
      {expanded ? (
        <>
          {detail.data?.stages?.map((stage) => (
            <Text key={stage.id} className="px-1 text-xs text-foreground-muted">
              {stage.name ?? stage.id}
              {stage.modeId === undefined ? null : ` · ${stage.modeId}`}
            </Text>
          ))}
          {rows === null ? (
            node.questions.map((question) => renderQuestion(question))
          ) : (
            <WorkflowTimeline
              rows={rows}
              node={node}
              question={questionFor}
              loose={node.questions.filter(
                (asked) => !beats.some((beat) => questionFor(beat) === asked),
              )}
              renderQuestion={(question) => renderQuestion(question, true)}
              pausedAt={null}
              pause={
                run.status === "paused" ? (
                  <Text className="text-sm text-danger-foreground">
                    {run.detail ?? gt("A step failed.")}
                  </Text>
                ) : null
              }
              openedAtMs={openedAtMs}
              onOpenStep={(step) => {
                const beat = beats.find((candidate) => candidate.name === step);
                if (
                  beat?.thread &&
                  beat.thread.threadId !== run.hostThreadId &&
                  canOpenThread(beat.thread)
                )
                  openThread(beat.thread);
                else
                  navigation.dispatch(
                    StackActions.push("WorkflowStep", { environmentId, runId: run.runId, step }),
                  );
              }}
            />
          )}
        </>
      ) : (
        node.questions.map((question) => renderQuestion(question))
      )}
    </View>
  );
}
