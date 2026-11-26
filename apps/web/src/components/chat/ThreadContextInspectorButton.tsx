import { threadContextReasonLabel } from "@t3tools/client-runtime/contract-labels";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadContextManifest, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { LayersIcon, RefreshCwIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { harnessEnvironment } from "../../state/harness";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

/**
 * The harness inspector fetches the thread's on-demand `ThreadContextManifest`
 * only when opened so zero extra bytes ride on live WebSocket streams.
 */
export function ThreadContextInspectorButton({
  environmentId,
  threadId,
  size = "sm",
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly size?: "sm" | "xs";
}) {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const fetchManifest = useAtomCommand(harnessEnvironment.threadContextManifest, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [manifest, setManifest] = useState<ThreadContextManifest | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const loadManifest = async () => {
    if (threadId === null) return;
    setLoading(true);
    setErrorText(null);
    const result = await fetchManifest({ environmentId, input: { threadId } });
    setLoading(false);
    if (result._tag === "Success") {
      setManifest(result.value);
    } else {
      const failure = squashAtomCommandFailure(result);
      setErrorText(
        failure instanceof Error ? failure.message : gt("Could not inspect harness status."),
      );
    }
  };

  const handleOpen = () => {
    setOpen(true);
    void loadManifest();
  };

  if (threadId === null) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              type="button"
              size={size}
              aria-label={gt("Inspect harness status")}
              onClick={handleOpen}
            />
          }
        >
          <ComposerControlIcon icon={LayersIcon} size={size} />
          <span data-composer-control-label>
            {gt("Harness", { $context: "composer harness status button" })}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          <T>Inspect MCP servers and Plan mode status</T>
        </TooltipPopup>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              <T>Harness status</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                On-demand snapshot of MCP servers, routing channels, and Plan mode enforcement for
                this thread.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {loading && manifest === null ? (
              <p className="text-sm text-muted-foreground">
                <T>Inspecting harness status...</T>
              </p>
            ) : errorText !== null ? (
              <p className="text-sm text-destructive">{errorText}</p>
            ) : manifest !== null ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={manifest.interactionMode === "plan" ? "default" : "secondary"}>
                    {manifest.interactionMode === "plan" ? gt("Plan mode") : gt("Default mode")}
                  </Badge>
                  <Badge variant="outline">
                    {manifest.planModeSource === "native"
                      ? gt("Plan cards: Native")
                      : manifest.planModeSource === "harness-propose-plan"
                        ? gt("Plan cards: T3 propose_plan")
                        : gt("Plan cards: Unavailable")}
                  </Badge>
                  <Badge
                    variant={
                      manifest.planModeReadOnlyEnforcement === "native" ? "outline" : "warning"
                    }
                  >
                    {manifest.planModeReadOnlyEnforcement === "native"
                      ? gt("Read-only: Native")
                      : gt("Read-only: Advisory")}
                  </Badge>
                  <Badge variant={manifest.harnessGatewayActive ? "success" : "secondary"}>
                    {manifest.harnessGatewayActive
                      ? gt("T3 Gateway active")
                      : gt("T3 Gateway idle")}
                  </Badge>
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-foreground">
                    <T>MCP Servers</T>
                  </div>
                  {manifest.mcpServers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      <T>No portable MCP servers configured for this workspace.</T>
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {manifest.mcpServers.map((item) => (
                        <div
                          key={`${item.scope}:${item.id}`}
                          className="rounded-lg border border-border/70 p-2.5 text-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono font-medium text-foreground">
                                {item.id}
                              </span>
                              <Badge variant="outline">
                                {item.scope === "project"
                                  ? gt("Project")
                                  : item.scope === "user"
                                    ? gt("User")
                                    : gt("Built-in")}
                              </Badge>
                              <Badge variant="secondary">
                                {item.channel === "gateway"
                                  ? gt("T3 Gateway")
                                  : item.channel === "native"
                                    ? gt("Native")
                                    : item.channel === "blocked"
                                      ? gt("Blocked")
                                      : gt("Disabled")}
                              </Badge>
                            </div>
                            <span className="text-muted-foreground">
                              {gt("{count, plural, one {{count} tool} other {{count} tools}}", {
                                count: item.toolCount,
                              })}
                              {item.estimatedToolListBytes > 0
                                ? // oxlint-disable-next-line t3code/no-untranslated-copy -- Compact numeric KB unit suffix.
                                  ` · ~${Math.ceil(item.estimatedToolListBytes / 1024)} KB`
                                : ""}
                            </span>
                          </div>
                          {item.reason ? (
                            <p className="mt-1 text-muted-foreground">
                              {threadContextReasonLabel(item.reason, m)}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {manifest.degradedItems.length > 0 ? (
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-warning-foreground">
                      <T>Notices & degradations</T>
                    </div>
                    <ul className="list-disc space-y-1 ps-4 text-xs text-muted-foreground">
                      {manifest.degradedItems.map((item) => (
                        <li key={`${item.kind}:${item.id}:${item.reason}`}>
                          <Var>{item.id}</Var>:{" "}
                          <Var>{threadContextReasonLabel(item.reason, m)}</Var>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/settings/harness" });
              }}
            >
              <Settings2Icon className="size-3.5" aria-hidden />
              <T>Manage Harness MCP</T>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void loadManifest()}
            >
              <RefreshCwIcon className="size-3.5" aria-hidden />
              <T>Refresh</T>
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              <T>Close</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
