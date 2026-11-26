import {
  analyzeApprovalRequest,
  type ApprovalRiskTagId,
} from "@t3tools/client-runtime/approval-analysis";
import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  approvalOptionsForDisplay,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const gt = useGT();
  const m = useMessages();
  const options: ReadonlyArray<ProviderApprovalOption> = approvalOptionsForDisplay(
    props.approval,
    m,
  ) ?? [
    { decision: "accept", label: gt("Allow once") },
    { decision: "acceptForSession", label: gt("Allow session") },
    {
      decision: "decline",
      label: gt("Decline", { $context: "verb, rejects the approval request" }),
    },
  ];
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const analysis = analyzeApprovalRequest({
    requestKind: props.approval.requestKind,
    detail: props.approval.detail,
  });
  const riskLabel = (id: ApprovalRiskTagId): string => {
    switch (id) {
      case "destructive":
        return gt("Destructive");
      case "privilege":
        return gt("Elevated privileges");
      case "network":
        return gt("Network");
      case "git-push":
        return gt("Git push");
      case "package-install":
        return gt("Package install");
      case "fs-write":
        return gt("File write");
      case "read-only":
        return gt("Read-only");
    }
  };
  const hasHighRiskTag =
    analysis.kind === "command" && analysis.riskTags.some((tag) => tag.severity === "high");

  const handleOptionPress = (option: ProviderApprovalOption) => {
    const isPersistentGrant =
      option.decision === "acceptForSession" || option.decision === "acceptAlways";
    const isApprove = option.decision === "accept" || isPersistentGrant;
    if (isApprove && (hasHighRiskTag || isPersistentGrant)) {
      const commandPreview =
        analysis.kind === "command"
          ? analysis.rawCommand
          : (props.approval.detail ?? props.approval.requestKind);
      const riskSummary =
        analysis.kind === "command" && analysis.riskTags.length > 0
          ? analysis.riskTags.map((tag) => riskLabel(tag.id)).join(", ")
          : null;
      Dialog.confirm({
        title: hasHighRiskTag
          ? gt("Confirm high-risk remote approval")
          : gt("Confirm persistent approval grant"),
        message: [
          riskSummary ? `${gt("Risk")}: ${riskSummary}` : null,
          `${gt("Action")}: ${option.label}`,
          commandPreview.slice(0, 240),
        ]
          .filter(Boolean)
          .join("\n\n"),
        confirmText: option.label,
        destructive: hasHighRiskTag,
        onConfirm: () => {
          void props.onRespond(props.approval.requestId, option.decision);
        },
      });
      return;
    }
    void props.onRespond(props.approval.requestId, option.decision);
  };

  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        <T>Approval needed</T>
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        {props.approval.appName ?? props.approval.requestKind}
      </Text>
      {analysis.kind === "command" ? (
        <View className="gap-2">
          {analysis.riskTags.length > 0 ? (
            <View className="flex-row flex-wrap gap-1.5">
              {analysis.riskTags.map((tag) => (
                <View
                  key={tag.id}
                  className={
                    tag.severity === "high"
                      ? "rounded-full bg-danger/15 px-2.5 py-0.5"
                      : tag.severity === "medium"
                        ? "rounded-full bg-warning/15 px-2.5 py-0.5"
                        : "rounded-full bg-card px-2.5 py-0.5"
                  }
                >
                  <Text
                    className={
                      tag.severity === "high"
                        ? "font-t3-medium text-xs text-danger-foreground"
                        : tag.severity === "medium"
                          ? "font-t3-medium text-xs text-warning-foreground"
                          : "font-t3-medium text-xs text-foreground-secondary"
                    }
                  >
                    {riskLabel(tag.id)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          {analysis.cwd ? (
            <Text className="font-mono text-xs text-foreground-muted">cwd: {analysis.cwd}</Text>
          ) : null}
          <View className="rounded-xl border border-border bg-card p-2.5">
            <Text className="font-mono text-xs leading-5 text-foreground" selectable>
              {analysis.rawCommand}
            </Text>
          </View>
        </View>
      ) : analysis.kind === "file-change" ? (
        <View className="gap-1.5">
          {analysis.filePath ? (
            <Text className="font-mono text-xs text-foreground-secondary">
              {analysis.filePath}
              {analysis.additions > 0 || analysis.deletions > 0
                ? ` (+${analysis.additions} / -${analysis.deletions})`
                : ""}
            </Text>
          ) : null}
          <View className="rounded-xl border border-border bg-card p-2.5">
            {analysis.previewLines.slice(0, 24).map((line, index) => (
              <Text
                key={`${line.kind}:${String(index)}:${line.text.slice(0, 16)}`}
                className={
                  line.kind === "add"
                    ? "font-mono text-xs text-success-foreground"
                    : line.kind === "del"
                      ? "font-mono text-xs text-danger-foreground"
                      : line.kind === "hunk"
                        ? "font-mono text-xs text-foreground-muted"
                        : "font-mono text-xs text-foreground"
                }
              >
                {line.text}
              </Text>
            ))}
          </View>
        </View>
      ) : analysis.kind === "structured-json" ? (
        <View className="gap-1.5">
          {analysis.summary.length > 0 ? (
            <Text className="font-mono text-xs text-foreground-secondary">{analysis.summary}</Text>
          ) : null}
          <View className="rounded-xl border border-border bg-card p-2.5">
            <Text className="font-mono text-xs leading-5 text-foreground" selectable>
              {analysis.formattedJson}
            </Text>
          </View>
        </View>
      ) : props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {props.approval.detail}
        </Text>
      ) : null}
      {props.approval.reason ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">
          {props.approval.reason}
        </Text>
      ) : null}
      {props.approval.fullAccessOverride ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: explanationOpen }}
          onPress={() => setExplanationOpen((open) => !open)}
        >
          <Text className="font-t3-bold text-xs text-foreground-secondary underline">
            {m(FULL_ACCESS_OVERRIDE_QUESTION)}
          </Text>
          {explanationOpen ? (
            <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
              {fullAccessOverrideExplanation(props.approval.fullAccessOverride, m)}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          <T>
            The provider process for this request is no longer available. Interrupt or restart the
            run to continue.
          </T>
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      <View className="gap-2">
        {options.map((option) => (
          <Button
            key={option.decision}
            label={option.label}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={disabled || !props.canOperateThread}
            onPress={() => handleOptionPress(option)}
            fullWidth
          />
        ))}
      </View>
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          <T>This connection cannot respond to approvals.</T>
        </Text>
      ) : null}
    </View>
  );
}
