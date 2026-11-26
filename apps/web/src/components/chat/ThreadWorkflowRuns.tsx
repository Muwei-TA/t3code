import { useAtomValue } from "@effect/atom-react";
import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  workflowThreadProgress,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunsSnapshot } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";
import WorkflowPane from "../workflows/WorkflowPane";
import {
  WorkflowQuestionCard,
  WorkflowRunFeed,
  WorkflowStateWord,
} from "../workflows/WorkflowRunFeed";
import {
  activeWorkflowPaneIndex,
  openWorkflowPaneTab,
  type WorkflowPaneState,
  type WorkflowPaneTab,
} from "../workflows/workflowPane.logic";

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
    <div className="chat-content-lane space-y-2 py-2">
      {visible.map((node) => (
        <RunCard key={node.run.runId} environmentId={environmentId} node={node} />
      ))}
      {visible.length < nodes.length ? (
        <Button size="xs" variant="ghost" onClick={() => setShowAll(true)}>
          {gt("Show earlier workflow runs")}
        </Button>
      ) : null}
    </div>
  );
}

function RunCard({
  environmentId,
  node,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: ReturnType<typeof allWorkflowRunNodes>[number];
}) {
  const gt = useGT();
  const { run } = node;
  const [expanded, setExpanded] = useState(false);
  const [pane, setPane] = useState<WorkflowPaneState>({});
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
  const progress = workflowThreadProgress(detail.data);
  const pause = useAtomCommand(serverEnvironment.pauseWorkflowRun);
  const resume = useAtomCommand(serverEnvironment.resumeWorkflowRun);
  const cancel = useAtomCommand(serverEnvironment.cancelWorkflowRun);
  const canOperate = useAtomValue(
    serverEnvironment.resumeWorkflowRun.permissionAtom(environmentId),
  );
  const target = { environmentId, input: { runId: run.runId } };
  const open = (tab: WorkflowPaneTab) => {
    setExpanded(true);
    setPane((previous) => openWorkflowPaneTab(previous, tab));
  };
  const openThread = (thread: { threadId: string; environmentId: string | null }) => {
    if (
      thread.threadId === run.hostThreadId &&
      (thread.environmentId === null || thread.environmentId === environmentId)
    )
      return;
    open({
      thread: thread.threadId,
      ...(thread.environmentId === null ? {} : { env: thread.environmentId }),
    });
  };
  return (
    <section aria-label={run.title} className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-1 px-2 py-1">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          className="min-w-0 justify-start"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRightIcon className={expanded ? "rotate-90" : undefined} />
          <WorkflowIcon />
          <span className="truncate">{run.title}</span>
        </Button>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-2 text-xs text-muted-foreground">
          {progress !== null && progress.total > 0 ? (
            <span className="truncate">
              {gt("{completed}/{total} stages", {
                completed: progress.completed,
                total: progress.total,
              })}
              {progress.active ? ` · ${progress.active}` : ""}
            </span>
          ) : null}
          <WorkflowStateWord node={node} />
        </div>
        {canOperate && run.supportsStagePause && run.endedAt === null && run.status !== "paused" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void (run.pauseRequested ? resume(target) : pause(target))}
          >
            {run.pauseRequested ? gt("Keep running") : gt("Pause after this stage")}
          </Button>
        ) : null}
        {!expanded && canOperate && run.status === "paused" && !run.retired ? (
          <Button size="xs" variant="outline" onClick={() => void resume(target)}>
            {gt("Resume now")}
          </Button>
        ) : null}
        {!expanded && canOperate && run.endedAt === null ? (
          <Button
            size="xs"
            variant="ghost-destructive"
            onClick={async () => {
              if (
                await requestConfirmDialog(
                  gt("Cancel {title}? Its agents stop and the run cannot be resumed.", {
                    title: run.title,
                  }),
                  { variant: "destructive" },
                )
              ) {
                await cancel(target);
              }
            }}
          >
            {gt("Stop")}
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <>
          {detail.data?.stages && detail.data.stages.length > 0 ? (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 px-4 pt-2 text-xs text-muted-foreground">
              {detail.data.stages.map((stage) => (
                <li key={stage.id}>
                  {stage.name ?? stage.id}
                  {stage.modeId === undefined ? null : ` · ${stage.modeId}`}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex min-w-0 flex-col border-t border-border lg:flex-row">
            <div className="min-w-0 flex-1">
              <WorkflowRunFeed
                embedded
                environmentId={environmentId}
                node={node}
                parent={null}
                shownTab={pane.pane?.[activeWorkflowPaneIndex(pane)] ?? null}
                onSelect={() => setExpanded(false)}
                onOpenThread={openThread}
                onOpenReference={(reference) => open({ kind: reference.kind, key: reference.key })}
              />
            </div>
            {pane.pane?.length ? (
              <div className="h-96 min-w-0 border-t lg:w-1/2 lg:border-s lg:border-t-0">
                <WorkflowPane
                  environmentId={environmentId}
                  runId={run.runId}
                  hostThreadId={run.hostThreadId}
                  state={pane}
                  onChange={setPane}
                />
              </div>
            ) : null}
          </div>
        </>
      ) : (
        node.questions.map((question) => (
          <div className="px-3 pb-3" key={question.name}>
            <WorkflowQuestionCard
              environmentId={environmentId}
              question={question}
              onOpenThread={openThread}
            />
          </div>
        ))
      )}
    </section>
  );
}
