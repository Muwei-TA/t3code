import {
  analyzeApprovalRequest,
  type ApprovalRiskTag,
} from "@t3tools/client-runtime/approval-analysis";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { FileDiff } from "@pierre/diffs/react";
import { msg, T, useGT, useMessages } from "gt-react";
import { FolderIcon, ShieldAlertIcon, ShieldIcon } from "lucide-react";
import { memo, use } from "react";
import { useRenderedAppearance } from "../../hooks/useTheme";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { type PendingApproval } from "../../session-logic";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Badge } from "../ui/badge";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx } from "./timelineRowContext";
import { WorkLogRow } from "./WorkLog";

const RISK_TAG_LABELS = {
  destructive: msg("Destructive"),
  privilege: msg("Elevated privileges"),
  network: msg("Network access"),
  "git-push": msg("Git push"),
  "package-install": msg("Package install"),
  "fs-write": msg("File write"),
  "read-only": msg("Read-only"),
} satisfies Record<ApprovalRiskTag["id"], string>;

function riskBadgeVariant(severity: ApprovalRiskTag["severity"]) {
  if (severity === "high") return "error" as const;
  if (severity === "medium") return "warning" as const;
  return "secondary" as const;
}

const APPROVAL_PRESENTATION = {
  command: {
    icon: "terminal",
    label: msg("Command approval"),
    detailLabel: msg("Command", { $context: "noun, shell command awaiting approval" }),
  },
  "file-change": {
    icon: "square-pen",
    label: msg("File change approval"),
    detailLabel: msg("File change"),
  },
  "file-read": { icon: "eye", label: msg("File read approval"), detailLabel: msg("File to read") },
  permission: {
    icon: "wrench",
    label: msg("App permission approval"),
    detailLabel: msg("Permission request"),
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: msg("App access approval"),
    detailLabel: msg("App access request"),
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; detailLabel: string }
>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const m = useMessages();
  const gt = useGT();
  const renderedAppearance = useRenderedAppearance();
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  const analysis = analyzeApprovalRequest({
    requestKind: approval.requestKind,
    detail: approval.detail,
  });
  const renderablePatch =
    analysis.kind === "file-change" && analysis.unifiedDiff
      ? getRenderablePatch(analysis.unifiedDiff, `approval:${approval.requestId}`)
      : null;

  return (
    <WorkLogRow
      role="group"
      aria-label={m(presentation.label)}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        <div className="flex min-w-0 flex-col gap-1.5">
          {analysis.kind === "command" && analysis.riskTags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              {analysis.riskTags.map((tag) => (
                <Badge key={tag.id} variant={riskBadgeVariant(tag.severity)}>
                  <ShieldAlertIcon aria-hidden className="size-3 shrink-0" />
                  {m(RISK_TAG_LABELS[tag.id])}
                </Badge>
              ))}
            </div>
          ) : null}
          {analysis.kind === "command" && analysis.cwd ? (
            <div className="inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground">
              <FolderIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{analysis.cwd}</span>
            </div>
          ) : null}
          <code
            aria-label={m(presentation.detailLabel)}
            className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            data-approval-detail="complete"
            tabIndex={0}
          >
            {analysis.kind === "command"
              ? analysis.rawCommand || m(presentation.label)
              : analysis.kind === "structured-json"
                ? analysis.formattedJson
                : approval.detail || m(presentation.label)}
          </code>
          {analysis.kind === "command" && analysis.argv.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
              <span>{gt("Parsed argv:")}</span>
              {analysis.argv.slice(0, 8).map((arg, idx) => (
                <span
                  key={`${idx.toString()}:${arg}`}
                  className="rounded bg-muted/60 px-1 py-0.5 font-mono text-2xs text-foreground/90"
                >
                  {arg}
                </span>
              ))}
              {analysis.argv.length > 8 ? (
                <span>{gt("+{count} more", { count: analysis.argv.length - 8 })}</span>
              ) : null}
            </div>
          ) : null}
          {renderablePatch?.kind === "files" ? (
            <div className="max-h-72 overflow-auto rounded-md border border-border/60 bg-background/50">
              <DiffWorkerPoolProvider>
                {renderablePatch.files.map((fileDiff) => (
                  <FileDiff
                    key={resolveFileDiffPath(fileDiff)}
                    fileDiff={fileDiff}
                    options={{
                      collapsed: false,
                      diffStyle: "unified",
                      theme: resolveDiffThemeName(renderedAppearance),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                    }}
                  />
                ))}
              </DiffWorkerPoolProvider>
            </div>
          ) : analysis.kind === "file-change" && analysis.previewLines.length > 0 ? (
            <div className="max-h-64 overflow-auto rounded-md border border-border/60 bg-muted/30 p-2 font-mono text-xs">
              <div className="mb-1 flex items-center justify-between gap-2 text-2xs text-muted-foreground">
                <span className="truncate">{analysis.filePath ?? gt("Patch")}</span>
                <span>
                  +{analysis.additions} / -{analysis.deletions}
                </span>
              </div>
              {analysis.previewLines.map((line, idx) => (
                <div
                  key={`${idx.toString()}:${line.kind}:${line.text.slice(0, 24)}`}
                  className={
                    line.kind === "add"
                      ? "bg-success/10 text-success"
                      : line.kind === "del"
                        ? "bg-destructive/10 text-destructive"
                        : line.kind === "hunk"
                          ? "text-info"
                          : "text-foreground/85"
                  }
                >
                  {line.text || " "}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
        {approval.appName ? (
          <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span>
        ) : null}
        {approval.reason ? (
          <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              <span className="inline-flex items-center gap-1 text-warning">
                <ShieldIcon aria-hidden className="size-3 shrink-0" />
                <T>Waiting for approval</T>
              </span>
              {onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <ComposerPendingApprovalActions
                    presentation="inline"
                    requestId={approval.requestId}
                    disabled={!canOperateThread}
                    isResponding={respondingRequestIds.includes(approval.requestId)}
                    canRespond={canRespond}
                    options={approval.options}
                    onRespondToApproval={onRespondToApproval}
                  />
                </>
              ) : null}
            </>
          ) : (
            <span className="text-warning">
              <T>Provider process is gone. Interrupt or restart the run to respond.</T>
            </span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {m(FULL_ACCESS_OVERRIDE_QUESTION)}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      </div>
    </WorkLogRow>
  );
});
