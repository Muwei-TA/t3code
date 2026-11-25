import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type HarnessMemoryEntry,
  HarnessMemoryId,
  type HarnessMemorySnapshot,
  type HarnessSyncPreviewPushResult,
  type HarnessSyncStatus,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  EyeIcon,
  GitBranchIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const decodeMemoryId = Schema.decodeUnknownOption(HarnessMemoryId);

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}

export function HarnessMemoryTab({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);

  const queryAtom = harnessEnvironment.memoryQuery({ environmentId, input: {} });
  const queryResult = useAtomValue(queryAtom);
  const [overrideSnapshot, setOverrideSnapshot] = useState<HarnessMemorySnapshot | null>(null);
  const snapshot =
    overrideSnapshot ??
    AsyncResult.getOrElse(queryResult, () => null as HarnessMemorySnapshot | null);

  const listMemory = useAtomCommand(harnessEnvironment.listMemory, { reportFailure: false });
  const upsertMemory = useAtomCommand(harnessEnvironment.upsertMemory, { reportFailure: false });
  const removeMemory = useAtomCommand(harnessEnvironment.removeMemory, { reportFailure: false });

  const [busy, setBusy] = useState(false);
  const [editorEntry, setEditorEntry] = useState<HarnessMemoryEntry | "new" | null>(null);

  const refresh = async () => {
    setBusy(true);
    const res = await listMemory({ environmentId, input: {} });
    setBusy(false);
    if (res._tag === "Success") setOverrideSnapshot(res.value);
  };

  return (
    <div className="space-y-4">
      <SettingsSection {...setting("harness-mcp")} title={gt("Portable Memory")}>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            <T>
              Cross-provider markdown notes stored in ~/.t3/harness/memory/*.md and exposed via
              /mcp/harness. Writing is blocked in Plan mode.
            </T>
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
              <RefreshCwIcon className="size-3.5" />
              <T>Refresh</T>
            </Button>
            <Button
              size="sm"
              disabled={!canWriteSettings || busy}
              onClick={() => setEditorEntry("new")}
            >
              <PlusIcon className="size-3.5" />
              <T>Add Note</T>
            </Button>
          </div>
        </div>

        {!snapshot ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            <T>Loading portable memory...</T>
          </p>
        ) : snapshot.entries.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            <T>
              No memory notes yet. Add durable architecture notes, runbooks, or team preferences to
              share across providers.
            </T>
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {snapshot.entries.map((entry) => (
              <div key={entry.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{entry.title}</span>
                    <Badge variant="outline">{entry.id}</Badge>
                    {entry.pinned ? (
                      <Badge variant="info">
                        <PinIcon className="mr-1 size-3" />
                        <T>Pinned</T>
                      </Badge>
                    ) : null}
                    {entry.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canWriteSettings || busy}
                      onClick={() => setEditorEntry(entry)}
                    >
                      <PencilIcon className="size-3.5" />
                      <T>Edit</T>
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!canWriteSettings || busy}
                      onClick={async () => {
                        setBusy(true);
                        const res = await removeMemory({
                          environmentId,
                          input: { id: entry.id },
                        });
                        setBusy(false);
                        if (res._tag === "Success") {
                          setOverrideSnapshot(res.value);
                          toastManager.add({ type: "success", title: gt("Memory note removed") });
                        } else if (!isAtomCommandInterrupted(res)) {
                          toastManager.add({
                            type: "error",
                            title: gt("Failed to remove memory note"),
                            description: formatError(
                              squashAtomCommandFailure(res),
                              gt("Try again."),
                            ),
                          });
                        }
                      }}
                    >
                      <Trash2Icon className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{entry.body}</p>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {editorEntry !== null ? (
        <MemoryEditorDialog
          initial={editorEntry === "new" ? null : editorEntry}
          busy={busy}
          onClose={() => setEditorEntry(null)}
          onSave={async (payload) => {
            setBusy(true);
            const res = await upsertMemory({ environmentId, input: payload });
            setBusy(false);
            if (res._tag === "Success") {
              setOverrideSnapshot(res.value);
              setEditorEntry(null);
              toastManager.add({ type: "success", title: gt("Memory note saved") });
            } else if (!isAtomCommandInterrupted(res)) {
              toastManager.add({
                type: "error",
                title: gt("Failed to save memory note"),
                description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
              });
            }
          }}
        />
      ) : null}
    </div>
  );
}

function MemoryEditorDialog({
  initial,
  busy,
  onClose,
  onSave,
}: {
  readonly initial: HarnessMemoryEntry | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (input: {
    readonly id: HarnessMemoryId;
    readonly title: typeof TrimmedNonEmptyString.Type;
    readonly tags?: ReadonlyArray<typeof TrimmedNonEmptyString.Type>;
    readonly pinned?: boolean;
    readonly body: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [idText, setIdText] = useState(initial?.id ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [tagsText, setTagsText] = useState(initial?.tags.join(", ") ?? "");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [body, setBody] = useState(initial?.body ?? "");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initial ? gt("Edit Memory Note") : gt("New Portable Memory Note")}
          </DialogTitle>
          <DialogDescription>
            <T>
              Stored as plain Markdown with YAML frontmatter so it syncs cleanly via Git and works
              across all providers.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium">{gt("Note ID")}</label>
                <Input
                  value={idText}
                  disabled={initial !== null}
                  placeholder="deploy-runbook"
                  onChange={(e) => setIdText(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">{gt("Title")}</label>
                <Input
                  value={title}
                  placeholder={gt("Production Deploy Runbook")}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">{gt("Tags (comma separated)")}</label>
              <Input
                value={tagsText}
                // oxlint-disable-next-line t3code/no-untranslated-copy -- comma-separated tag example
                placeholder="ops, release, architecture"
                onChange={(e) => setTagsText(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={pinned}
                onCheckedChange={(checked) => setPinned(Boolean(checked))}
              />
              <span>{gt("Pin note to top of search results")}</span>
            </label>
            <div className="space-y-1">
              <label className="text-xs font-medium">{gt("Markdown Body")}</label>
              <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              const idOpt = decodeMemoryId(idText.trim().toLowerCase());
              if (idOpt._tag === "None") {
                toastManager.add({
                  type: "error",
                  title: gt("Invalid note ID"),
                  description: gt("Use lowercase letters, digits, dots, hyphens, or underscores."),
                });
                return;
              }
              if (!title.trim() || !body.trim()) {
                toastManager.add({
                  type: "error",
                  title: gt("Title and body are required"),
                });
                return;
              }
              const tags = tagsText
                .split(/[,\n]+/u)
                .map((t) => t.trim())
                .filter(Boolean)
                .map((t) => TrimmedNonEmptyString.make(t));
              void onSave({
                id: idOpt.value,
                title: TrimmedNonEmptyString.make(title.trim()),
                ...(tags.length > 0 ? { tags } : {}),
                pinned,
                body,
              });
            }}
          >
            <T>Save Note</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function HarnessSyncTab({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const canSyncRemote = canWriteSettings && canWriteSourceControl;

  const queryAtom = harnessEnvironment.syncStatusQuery({ environmentId, input: {} });
  const queryResult = useAtomValue(queryAtom);
  const [overrideStatus, setOverrideStatus] = useState<HarnessSyncStatus | null>(null);
  const status =
    overrideStatus ?? AsyncResult.getOrElse(queryResult, () => null as HarnessSyncStatus | null);

  const getSyncStatus = useAtomCommand(harnessEnvironment.getSyncStatus, { reportFailure: false });
  const configureSync = useAtomCommand(harnessEnvironment.configureSync, { reportFailure: false });
  const previewSyncPush = useAtomCommand(harnessEnvironment.previewSyncPush, {
    reportFailure: false,
  });
  const pushSync = useAtomCommand(harnessEnvironment.pushSync, { reportFailure: false });
  const pullSync = useAtomCommand(harnessEnvironment.pullSync, { reportFailure: false });

  const [busy, setBusy] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [commitMessage, setCommitMessage] = useState("");
  const [preview, setPreview] = useState<HarnessSyncPreviewPushResult | null>(null);

  const refreshStatus = async () => {
    setBusy(true);
    const res = await getSyncStatus({ environmentId, input: {} });
    setBusy(false);
    if (res._tag === "Success") setOverrideStatus(res.value);
  };

  return (
    <div className="space-y-4">
      <SettingsSection {...setting("harness-mcp")} title={gt("Harness Git Sync")}>
        <div className="space-y-4 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            <T>
              Sync ~/.t3/harness/ across machines using a Git repository. Secret literals are
              blocked automatically.
            </T>
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <GitBranchIcon className="size-3.5 text-muted-foreground" />
              {status?.initialized ? (
                <>
                  <Badge variant="success">{status.branch ?? "main"}</Badge>
                  <span className="font-mono text-muted-foreground">
                    {status.remoteUrl ?? gt("No remote configured")}
                  </span>
                  <Badge variant="outline">
                    <T>
                      <Var>{status.dirtyCount}</Var> pending
                    </T>
                  </Badge>
                </>
              ) : (
                <Badge variant="secondary">{gt("Not configured")}</Badge>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void refreshStatus()}
            >
              <RefreshCwIcon className="size-3.5" />
              <T>Refresh</T>
            </Button>
          </div>

          {status && status.secretFindings.length > 0 ? (
            <Alert variant="error">
              <ShieldAlertIcon className="size-4" />
              <AlertTitle>{gt("Raw secrets detected in harness directory")}</AlertTitle>
              <AlertDescription>
                <div className="space-y-1">
                  <p>
                    <T>
                      Push is blocked until raw secret literals are replaced with{" "}
                      <code>{"${secret:NAME}"}</code> references.
                    </T>
                  </p>
                  <ul className="list-disc pl-4 font-mono text-xs">
                    {status.secretFindings.map((finding) => (
                      <li key={`${finding.path}:${finding.line}:${finding.rule}`}>
                        {`${finding.path}:${finding.line} (${finding.rule})`}
                      </li>
                    ))}
                  </ul>
                </div>
              </AlertDescription>
            </Alert>
          ) : status?.initialized ? (
            <Alert>
              <ShieldCheckIcon className="size-4" />
              <AlertTitle>{gt("Secret safety scan clean")}</AlertTitle>
              <AlertDescription>
                <T>
                  Local trust ledgers (plugins-state.json, approval-rules.json) are excluded via
                  .gitignore.
                </T>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium">{gt("Git Remote URL")}</label>
              <Input
                value={remoteUrl || status?.remoteUrl || ""}
                placeholder="git@github.com:you/my-t3-harness.git"
                disabled={!canWriteSettings || busy}
                onChange={(e) => setRemoteUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">{gt("Branch")}</label>
              <Input
                value={branch}
                disabled={!canWriteSettings || busy}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canWriteSettings || busy || !(remoteUrl || status?.remoteUrl)?.trim()}
              onClick={async () => {
                const targetUrl = (remoteUrl || status?.remoteUrl || "").trim();
                if (!targetUrl) return;
                setBusy(true);
                const res = await configureSync({
                  environmentId,
                  input: {
                    remoteUrl: TrimmedNonEmptyString.make(targetUrl),
                    ...(branch.trim() ? { branch: TrimmedNonEmptyString.make(branch.trim()) } : {}),
                  },
                });
                setBusy(false);
                if (res._tag === "Success") {
                  setOverrideStatus(res.value);
                  toastManager.add({ type: "success", title: gt("Harness Git remote saved") });
                } else if (!isAtomCommandInterrupted(res)) {
                  toastManager.add({
                    type: "error",
                    title: gt("Failed to configure Git sync"),
                    description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
                  });
                }
              }}
            >
              <T>Save Remote</T>
            </Button>

            <Button
              size="sm"
              variant="outline"
              disabled={!status?.initialized || busy}
              onClick={async () => {
                setBusy(true);
                const res = await previewSyncPush({ environmentId, input: {} });
                setBusy(false);
                if (res._tag === "Success") {
                  setPreview(res.value);
                } else if (!isAtomCommandInterrupted(res)) {
                  toastManager.add({
                    type: "error",
                    title: gt("Failed to preview push diff"),
                    description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
                  });
                }
              }}
            >
              <EyeIcon className="size-3.5" />
              <T>Preview Push Diff</T>
            </Button>

            <Button
              size="sm"
              variant="outline"
              disabled={!canSyncRemote || !status?.initialized || !status.remoteUrl || busy}
              onClick={async () => {
                setBusy(true);
                const res = await pullSync({ environmentId, input: {} });
                setBusy(false);
                if (res._tag === "Success") {
                  toastManager.add({
                    type: "success",
                    title: gt("Pulled harness updates"),
                    description: res.value.summary,
                  });
                  void refreshStatus();
                } else if (!isAtomCommandInterrupted(res)) {
                  toastManager.add({
                    type: "error",
                    title: gt("Pull failed"),
                    description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
                  });
                }
              }}
            >
              <ArrowDownToLineIcon className="size-3.5" />
              <T>Pull</T>
            </Button>
          </div>

          {preview ? (
            <div className="space-y-3 rounded-lg border border-border/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium">{gt("Outbound Diff Preview")}</span>
                <Badge variant={preview.canPush ? "success" : "error"}>
                  {preview.canPush ? gt("Safe to push") : gt("Blocked")}
                </Badge>
              </div>
              {preview.files.length === 0 ? (
                <p className="text-xs text-muted-foreground">{preview.diffSummary}</p>
              ) : (
                <div className="space-y-1 font-mono text-xs">
                  {preview.files.map((file) => (
                    <div key={file.path} className="flex items-center justify-between gap-2">
                      <span className="truncate">{`${file.status}: ${file.path}`}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {`+${file.additions} / -${file.deletions}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={commitMessage}
                  placeholder={gt("Optional commit message")}
                  disabled={!canSyncRemote || !preview.canPush || busy}
                  onChange={(e) => setCommitMessage(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={!canSyncRemote || !preview.canPush || busy}
                  onClick={async () => {
                    setBusy(true);
                    const res = await pushSync({
                      environmentId,
                      input: commitMessage.trim()
                        ? { commitMessage: TrimmedNonEmptyString.make(commitMessage.trim()) }
                        : {},
                    });
                    setBusy(false);
                    if (res._tag === "Success") {
                      setPreview(null);
                      setCommitMessage("");
                      toastManager.add({
                        type: "success",
                        title: gt("Harness pushed"),
                        description: res.value.summary,
                      });
                      void refreshStatus();
                    } else if (!isAtomCommandInterrupted(res)) {
                      toastManager.add({
                        type: "error",
                        title: gt("Push failed"),
                        description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
                      });
                    }
                  }}
                >
                  <ArrowUpFromLineIcon className="size-3.5" />
                  <T>Commit & Push</T>
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  );
}
