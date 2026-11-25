import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { memo, useState, useId } from "react";
import { findRevealRef } from "./markdownFindContext";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type PlanId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import {
  EllipsisIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planId,
  planStatus = "active",
  planMarkdown,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
  isGitRepo = false,
  findActive = false,
  canOperateThread = false,
  onImplementPlan,
  onContinuePlanning,
}: {
  planId?: PlanId | undefined;
  planStatus?: "active" | "completed" | "draft" | "superseded" | undefined;
  planMarkdown: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  isGitRepo?: boolean;
  findActive?: boolean;
  canOperateThread?: boolean;
  onImplementPlan?:
    | ((input: {
        readonly planId: PlanId;
        readonly planMarkdown: string;
        readonly freshContext?: boolean;
        readonly inNewWorktree?: boolean;
      }) => Promise<void>)
    | undefined;
  onContinuePlanning?: (() => void) | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [expanded, setExpanded] = useState(false);
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isImplementing, setIsImplementing] = useState(false);
  const [lastSavePath, setLastSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "plan",
      unavailableMessage: msg("Clipboard API is unavailable while copying plan."),
      failureMessage: msg("Failed to copy plan to the clipboard."),
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy plan"),
          description:
            error instanceof Error ? error.message : gt("An error occurred while copying."),
        }),
      );
    },
  });
  const title = proposedPlanTitle(planMarkdown) ?? gt("Proposed plan");
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 }, messages)
    : null;
  const isCollapsed = canCollapse && !expanded;
  // Mount clipped plans during find to count hidden matches without revealing them.
  const showPreview = isCollapsed && !findActive;
  const revealRef = findRevealRef(() => setExpanded(true));
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!canWriteFiles) return;
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Workspace path is unavailable"),
          description: gt("This thread does not have a workspace path to save into."),
        }),
      );
      return;
    }
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = (savePath: string) => {
    const relativePath = savePath.trim();
    if (!workspaceRoot || !readEnvironmentScope(environmentId, AuthFilesystemWriteScope)) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: gt("Enter a workspace path"),
      });
      return;
    }

    setLastSavePath(savePath);
    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: gt("Plan saved to workspace"),
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not save plan"),
            description:
              error instanceof Error ? error.message : gt("An error occurred while saving."),
          }),
        );
      }
    })();
  };

  // Server orchestration only accepts `sourceProposedPlan` execution while the plan is active.
  const canExecutePlan =
    planStatus === "active" &&
    planId !== undefined &&
    onImplementPlan !== undefined &&
    canOperateThread;

  const triggerImplementPlan = (options?: {
    readonly markdown?: string;
    readonly freshContext?: boolean;
    readonly inNewWorktree?: boolean;
  }) => {
    if (!planId || !onImplementPlan || isImplementing) return;
    setIsImplementing(true);
    void onImplementPlan({
      planId,
      planMarkdown: options?.markdown ?? planMarkdown,
      ...(options?.freshContext ? { freshContext: true } : {}),
      ...(options?.inNewWorktree ? { inNewWorktree: true } : {}),
    }).finally(() => {
      setIsImplementing(false);
    });
  };

  return (
    <div className="rounded-2xl border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">{gt("Plan", { $context: "badge, noun" })}</Badge>
          {planStatus === "completed" ? (
            <Badge variant="outline">{gt("Completed")}</Badge>
          ) : planStatus === "superseded" ? (
            <Badge variant="outline">{gt("Superseded")}</Badge>
          ) : null}
          {}
          <h3 data-thread-find-text="true" className="truncate text-sm font-medium text-foreground">
            {title}
          </h3>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label={gt("Plan actions")} size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            {canExecutePlan ? (
              <>
                <MenuItem
                  disabled={isImplementing}
                  onClick={() => triggerImplementPlan({ freshContext: true })}
                >
                  <RotateCcwIcon aria-hidden="true" className="size-3.5" />
                  <T>Clear context &amp; implement</T>
                </MenuItem>
                {isGitRepo ? (
                  <MenuItem
                    disabled={isImplementing}
                    onClick={() => triggerImplementPlan({ inNewWorktree: true })}
                  >
                    <GitBranchIcon aria-hidden="true" className="size-3.5" />
                    <T>Implement in new worktree</T>
                  </MenuItem>
                ) : null}
                <MenuItem disabled={isImplementing} onClick={() => setIsEditDialogOpen(true)}>
                  <PencilIcon aria-hidden="true" className="size-3.5" />
                  <T>Edit &amp; implement</T>
                </MenuItem>
              </>
            ) : null}
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? gt("Copied!") : gt("Copy to clipboard")}
            </MenuItem>
            <MenuItem onClick={handleDownload}>
              <T>Download as markdown</T>
            </MenuItem>
            <MenuItem
              onClick={openSaveDialog}
              disabled={!canWriteFiles || !workspaceRoot || isSavingToWorkspace}
            >
              <T>Save to workspace</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div
          ref={revealRef}
          className={cn("relative", isCollapsed && "max-h-104 overflow-hidden")}
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
        >
          {showPreview ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          )}
          {isCollapsed ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? gt("Collapse plan") : gt("Expand plan")}
            </Button>
          </div>
        ) : null}
        {canExecutePlan ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <Button size="sm" disabled={isImplementing} onClick={() => triggerImplementPlan()}>
              <PlayIcon aria-hidden="true" className="size-3.5" />
              <T>Implement plan</T>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isImplementing}
              onClick={() => triggerImplementPlan({ freshContext: true })}
            >
              <RotateCcwIcon aria-hidden="true" className="size-3.5" />
              <T>Fresh context</T>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isImplementing}
              onClick={() => setIsEditDialogOpen(true)}
            >
              <PencilIcon aria-hidden="true" className="size-3.5" />
              <T>Edit</T>
            </Button>
            {onContinuePlanning ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={isImplementing}
                onClick={onContinuePlanning}
              >
                <MessageSquareIcon aria-hidden="true" className="size-3.5" />
                <T>Continue planning</T>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <Dialog
        open={isEditDialogOpen}
        onOpenChange={(open) => {
          if (!isImplementing) {
            setIsEditDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-2xl">
          <EditPlanBeforeImplementForm
            initialMarkdown={planMarkdown}
            submitting={isImplementing}
            onCancel={() => setIsEditDialogOpen(false)}
            onSubmit={(editedMarkdown) => {
              setIsEditDialogOpen(false);
              triggerImplementPlan({ markdown: editedMarkdown });
            }}
          />
        </DialogPopup>
      </Dialog>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <SavePlanToWorkspaceForm
            initialPath={lastSavePath || downloadFilename}
            placeholder={downloadFilename}
            workspaceRoot={workspaceRoot}
            canWriteFiles={canWriteFiles}
            saving={isSavingToWorkspace}
            onCancel={() => setIsSaveDialogOpen(false)}
            onSave={handleSaveToWorkspace}
          />
        </DialogPopup>
      </Dialog>
    </div>
  );
});

function SavePlanToWorkspaceForm({
  initialPath,
  placeholder,
  workspaceRoot,
  canWriteFiles,
  saving,
  onCancel,
  onSave,
}: {
  initialPath: string;
  placeholder: string;
  workspaceRoot: string | undefined;
  canWriteFiles: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (path: string) => void;
}) {
  const gt = useGT();
  const [savePath, setSavePath] = useState(initialPath);
  const savePathInputId = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Save plan to workspace</T>
        </DialogTitle>
        <DialogDescription>
          {workspaceRoot !== undefined ? (
            <T>
              Enter a path relative to{" "}
              <code>
                <Var>{workspaceRoot}</Var>
              </code>
              .
            </T>
          ) : (
            <T>
              Enter a path relative to <code>the workspace</code>.
            </T>
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <label htmlFor={savePathInputId} className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">
            <T>Workspace path</T>
          </span>
          <Input
            id={savePathInputId}
            value={savePath}
            onChange={(event) => setSavePath(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            disabled={saving}
          />
        </label>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          <T>Cancel</T>
        </Button>
        <Button size="sm" onClick={() => onSave(savePath)} disabled={!canWriteFiles || saving}>
          {saving ? gt("Saving...") : gt("Save")}
        </Button>
      </DialogFooter>
    </>
  );
}

function EditPlanBeforeImplementForm({
  initialMarkdown,
  submitting,
  onCancel,
  onSubmit,
}: {
  initialMarkdown: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (markdown: string) => void;
}) {
  const gt = useGT();
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const textareaId = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Edit plan before implementing</T>
        </DialogTitle>
        <DialogDescription>
          <T>Adjust the steps below before switching to build mode and starting execution.</T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <label htmlFor={textareaId} className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">
            <T>Plan markdown</T>
          </span>
          <Textarea
            id={textareaId}
            rows={12}
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            disabled={submitting}
          />
        </label>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
          <T>Cancel</T>
        </Button>
        <Button
          size="sm"
          onClick={() => onSubmit(markdown)}
          disabled={submitting || markdown.trim().length === 0}
        >
          {submitting ? gt("Starting...") : gt("Implement plan")}
        </Button>
      </DialogFooter>
    </>
  );
}
