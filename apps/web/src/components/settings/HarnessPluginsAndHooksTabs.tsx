import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type HarnessHookDefinition,
  type HarnessHookEvent,
  HarnessHookId,
  type HarnessHooksSnapshot,
  type HarnessPluginsSnapshot,
  type HarnessPluginView,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import {
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { useState } from "react";

import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const decodeHookId = Schema.decodeUnknownOption(HarnessHookId);

const ALL_HOOK_EVENTS: ReadonlyArray<HarnessHookEvent> = [
  "turn.beforeStart",
  "thread.created",
  "turn.completed",
  "run.settled",
  "checkpoint.created",
  "PreToolUse",
  "PostToolUse",
];

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}

export function HarnessPluginsTab({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);

  const queryAtom = harnessEnvironment.pluginsQuery({ environmentId, input: {} });
  const queryResult = useAtomValue(queryAtom);
  const [overrideSnapshot, setOverrideSnapshot] = useState<HarnessPluginsSnapshot | null>(null);
  const snapshot =
    overrideSnapshot ??
    AsyncResult.getOrElse(queryResult, () => null as HarnessPluginsSnapshot | null);

  const listPlugins = useAtomCommand(harnessEnvironment.listPlugins, { reportFailure: false });
  const trustPlugin = useAtomCommand(harnessEnvironment.trustPlugin, { reportFailure: false });
  const setPluginEnabled = useAtomCommand(harnessEnvironment.setPluginEnabled, {
    reportFailure: false,
  });
  const removePlugin = useAtomCommand(harnessEnvironment.removePlugin, { reportFailure: false });
  const reloadPlugins = useAtomCommand(harnessEnvironment.reloadPlugins, { reportFailure: false });

  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    const res = await listPlugins({ environmentId, input: {} });
    setBusy(false);
    if (res._tag === "Success") setOverrideSnapshot(res.value);
  };

  const trust = async (plugin: HarnessPluginView) => {
    setBusy(true);
    const res = await trustPlugin({
      environmentId,
      input: { id: plugin.id, expectedDigest: TrimmedNonEmptyString.make(plugin.contentDigest) },
    });
    setBusy(false);
    if (res._tag === "Success") {
      setOverrideSnapshot(res.value);
      toastManager.add({ type: "success", title: gt("Plugin trusted and activated") });
    } else if (!isAtomCommandInterrupted(res)) {
      toastManager.add({
        type: "error",
        title: gt("Could not trust plugin"),
        description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
      });
      void refresh();
    }
  };

  if (snapshot === null) {
    return (
      <SettingsSection {...setting("harness-plugins")}>
        <p className="px-4 py-3 text-sm text-muted-foreground">
          <T>Loading portable plugins...</T>
        </p>
      </SettingsSection>
    );
  }

  const allowsPlugins =
    snapshot.managedPolicyAllowsHarness && snapshot.managedPolicyAllowsPlugins !== false;
  const editable = canWriteSettings && allowsPlugins;

  return (
    <>
      <SettingsSection
        {...setting("harness-plugins")}
        headerAction={
          <Button
            variant="outline"
            size="sm"
            disabled={!editable || busy}
            onClick={async () => {
              setBusy(true);
              const res = await reloadPlugins({ environmentId, input: {} });
              setBusy(false);
              if (res._tag === "Success") setOverrideSnapshot(res.value);
            }}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            <T>Reload</T>
          </Button>
        }
      >
        {!allowsPlugins ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            <T>Your organization has disabled external plugins.</T>
          </p>
        ) : null}

        {snapshot.plugins.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            <T>No plugins installed.</T>
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {[...snapshot.plugins]
              .sort(
                (a, b) => Number(b.trustStatus !== "trusted") - Number(a.trustStatus !== "trusted"),
              )
              .map((plugin) => (
                <div
                  key={plugin.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-medium text-foreground">
                        {plugin.name}
                      </span>
                      <Badge variant="outline">v{plugin.version}</Badge>
                      <Badge variant="secondary">{plugin.format}</Badge>
                      {plugin.active ? (
                        <Badge variant="success">{gt("Active")}</Badge>
                      ) : plugin.trustStatus === "digest_changed" ? (
                        <Badge variant="error">{gt("Digest changed")}</Badge>
                      ) : plugin.trustStatus === "untrusted" ? (
                        <Badge variant="warning">{gt("Untrusted")}</Badge>
                      ) : (
                        <Badge variant="outline">{gt("Disabled")}</Badge>
                      )}
                    </div>
                    {plugin.description ? (
                      <p className="text-xs text-muted-foreground">{plugin.description}</p>
                    ) : null}
                    <p className="font-mono text-2xs text-muted-foreground/85">
                      {gt(
                        "sha256:{digest} · {skills} skills · {modes} modes · {hooks} hooks · {workflows} workflows",
                        {
                          digest: plugin.contentDigest.slice(0, 16) || "none",
                          skills: plugin.skillIds.length,
                          modes: plugin.modeIds.length,
                          hooks: plugin.hookIds.length,
                          workflows: plugin.workflowFiles.length,
                        },
                      )}
                    </p>
                    {plugin.lastError ? (
                      <p className="text-xs text-destructive">{plugin.lastError}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {plugin.trustStatus !== "trusted" && plugin.contentDigest ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!editable || busy}
                        onClick={() => void trust(plugin)}
                      >
                        <ShieldCheckIcon className="size-3.5" aria-hidden />
                        <T>Trust & Enable</T>
                      </Button>
                    ) : (
                      <Switch
                        aria-label={gt("Toggle {id}", { id: plugin.name })}
                        checked={plugin.enabled}
                        disabled={!editable || busy}
                        onCheckedChange={async (checked) => {
                          setBusy(true);
                          const res = await setPluginEnabled({
                            environmentId,
                            input: { id: plugin.id, enabled: checked },
                          });
                          setBusy(false);
                          if (res._tag === "Success") setOverrideSnapshot(res.value);
                        }}
                      />
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={gt("Remove {id}", { id: plugin.name })}
                      disabled={!canWriteSettings || busy}
                      onClick={async () => {
                        setBusy(true);
                        const res = await removePlugin({
                          environmentId,
                          input: { id: plugin.id },
                        });
                        setBusy(false);
                        if (res._tag === "Success") {
                          setOverrideSnapshot(res.value);
                          toastManager.add({ type: "success", title: gt("Plugin removed") });
                        }
                      }}
                    >
                      <Trash2Icon className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </SettingsSection>
    </>
  );
}

export function HarnessHooksTab({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canRunTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);

  const queryAtom = harnessEnvironment.hooksQuery({ environmentId, input: {} });
  const queryResult = useAtomValue(queryAtom);
  const [overrideSnapshot, setOverrideSnapshot] = useState<HarnessHooksSnapshot | null>(null);
  const snapshot =
    overrideSnapshot ??
    AsyncResult.getOrElse(queryResult, () => null as HarnessHooksSnapshot | null);

  const listHooks = useAtomCommand(harnessEnvironment.listHooks, { reportFailure: false });
  const upsertHook = useAtomCommand(harnessEnvironment.upsertHook, { reportFailure: false });
  const removeHook = useAtomCommand(harnessEnvironment.removeHook, { reportFailure: false });
  const setHookEnabled = useAtomCommand(harnessEnvironment.setHookEnabled, {
    reportFailure: false,
  });
  const testHook = useAtomCommand(harnessEnvironment.testHook, { reportFailure: false });

  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingHook, setEditingHook] = useState<HarnessHookDefinition | null>(null);

  if (snapshot === null) {
    return (
      <SettingsSection {...setting("harness-hooks")}>
        <p className="px-4 py-3 text-sm text-muted-foreground">
          <T>Loading lifecycle hooks...</T>
        </p>
      </SettingsSection>
    );
  }

  const editable = canWriteSettings && snapshot.managedPolicyAllowsHarness;

  return (
    <>
      <SettingsSection {...setting("harness-hooks")}>
        <SettingsRow
          title={<T>Lifecycle & Tool Hooks</T>}
          description={
            <T>
              Cross-provider hooks stored in <Var>{snapshot.hooksPath}</Var>. Supports blocking
              turn.beforeStart / PreToolUse gates and async lifecycle notifications.
            </T>
          }
        >
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const res = await listHooks({ environmentId, input: {} });
                setBusy(false);
                if (res._tag === "Success") setOverrideSnapshot(res.value);
              }}
            >
              <RefreshCwIcon className="size-3.5" aria-hidden />
              <T>Refresh</T>
            </Button>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                <T>Manual configuration</T>
              </summary>
              <Button
                size="sm"
                disabled={!editable || busy}
                onClick={() => {
                  setEditingHook(null);
                  setEditorOpen(true);
                }}
              >
                <PlusIcon className="size-3.5" aria-hidden />
                <T>Add Hook</T>
              </Button>
            </details>
          </div>
        </SettingsRow>

        {snapshot.hooks.some((hook) => hook.pendingApproval) ? (
          <h3 className="bg-warning/10 px-4 py-2 text-sm font-semibold">
            <T>Pending hook proposals</T>
          </h3>
        ) : null}
        {snapshot.hooks.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            <T>
              No lifecycle hooks configured yet. Add a command or HTTP hook to validate turns, gate
              MCP tools, or emit completion webhooks.
            </T>
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {[...snapshot.hooks]
              .sort(
                (a, b) => Number(Boolean(b.pendingApproval)) - Number(Boolean(a.pendingApproval)),
              )
              .map((hook) => (
                <div
                  key={`${hook.source}:${hook.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <WebhookIcon className="size-3.5 text-muted-foreground" aria-hidden />
                      <span className="font-mono text-xs font-medium text-foreground">
                        {hook.id}
                      </span>
                      <Badge variant="outline">{hook.event}</Badge>
                      <Badge variant="secondary">{hook.target.type}</Badge>
                      {hook.source === "plugin" && hook.pluginId ? (
                        <Badge variant="info">{hook.pluginId}</Badge>
                      ) : null}
                      {hook.matcher ? <Badge variant="outline">{hook.matcher}</Badge> : null}
                      {hook.pendingApproval ? (
                        <Badge variant="warning">{gt("Pending hook proposal")}</Badge>
                      ) : null}
                      {hook.failClosed ? (
                        <Badge variant="warning">{gt("Fail-closed")}</Badge>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap break-all font-mono text-2xs text-muted-foreground">
                      {hook.target.type === "command"
                        ? JSON.stringify([hook.target.command, ...(hook.target.args ?? [])])
                        : hook.target.url}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        !editable || !canRunTerminal || busy || hook.pendingApproval === true
                      }
                      onClick={async () => {
                        setBusy(true);
                        const res = await testHook({
                          environmentId,
                          input: { id: hook.id },
                        });
                        setBusy(false);
                        if (res._tag === "Success") {
                          const r = res.value;
                          toastManager.add({
                            type: r.ok ? "success" : "warning",
                            title: r.blocked
                              ? gt("Hook blocked ({ms}ms)", { ms: r.durationMs })
                              : r.ok
                                ? gt("Hook passed ({ms}ms)", { ms: r.durationMs })
                                : gt("Hook failed ({ms}ms)", { ms: r.durationMs }),
                            description:
                              r.blockReason ??
                              r.injectedContext ??
                              r.error ??
                              r.stdout ??
                              undefined,
                          });
                        } else if (!isAtomCommandInterrupted(res)) {
                          toastManager.add({
                            type: "error",
                            title: gt("Hook test failed"),
                            description: formatError(
                              squashAtomCommandFailure(res),
                              gt("Try again."),
                            ),
                          });
                        }
                      }}
                    >
                      <PlayIcon className="size-3.5" aria-hidden />
                      <T>Test</T>
                    </Button>
                    {hook.source === "user" ? (
                      <>
                        {!canRunTerminal && hook.target.type === "command" && !hook.enabled ? (
                          <span className="text-xs text-muted-foreground">
                            <T>Enabling command hooks requires terminal access.</T>
                          </span>
                        ) : null}
                        {hook.pendingApproval ? (
                          <Button
                            size="sm"
                            disabled={
                              !editable ||
                              busy ||
                              (!canRunTerminal && hook.target.type === "command")
                            }
                            onClick={async () => {
                              setBusy(true);
                              const result = await setHookEnabled({
                                environmentId,
                                input: {
                                  id: hook.id,
                                  enabled: true,
                                  ...(hook.configDigest
                                    ? { expectedDigest: hook.configDigest }
                                    : {}),
                                },
                              });
                              setBusy(false);
                              if (result._tag === "Success") setOverrideSnapshot(result.value);
                              else if (!isAtomCommandInterrupted(result))
                                toastManager.add({
                                  type: "error",
                                  title: gt("Could not approve hook"),
                                  description: formatError(
                                    squashAtomCommandFailure(result),
                                    gt("Try again."),
                                  ),
                                });
                            }}
                          >
                            <T>Approve & Enable</T>
                          </Button>
                        ) : (
                          <Switch
                            checked={hook.enabled}
                            disabled={
                              !editable ||
                              busy ||
                              (!canRunTerminal && hook.target.type === "command" && !hook.enabled)
                            }
                            onCheckedChange={async (checked) => {
                              setBusy(true);
                              const res = await setHookEnabled({
                                environmentId,
                                input: {
                                  id: hook.id,
                                  enabled: checked,
                                  ...(hook.configDigest
                                    ? { expectedDigest: hook.configDigest }
                                    : {}),
                                },
                              });
                              setBusy(false);
                              if (res._tag === "Success") setOverrideSnapshot(res.value);
                            }}
                          />
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!editable || busy}
                          onClick={async () => {
                            setBusy(true);
                            const res = await removeHook({
                              environmentId,
                              input: { id: hook.id },
                            });
                            setBusy(false);
                            if (res._tag === "Success") {
                              setOverrideSnapshot(res.value);
                              toastManager.add({ type: "success", title: gt("Hook removed") });
                            }
                          }}
                        >
                          {hook.pendingApproval ? (
                            <T>Reject</T>
                          ) : (
                            <Trash2Icon className="size-3.5" aria-hidden />
                          )}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
          </div>
        )}
      </SettingsSection>

      <HookEditorDialog
        open={editorOpen}
        existing={editingHook}
        canRunTerminal={canRunTerminal}
        onClose={() => setEditorOpen(false)}
        onSave={async (payload) => {
          setBusy(true);
          const res = await upsertHook({ environmentId, input: payload });
          setBusy(false);
          if (res._tag === "Success") {
            setOverrideSnapshot(res.value);
            setEditorOpen(false);
            toastManager.add({ type: "success", title: gt("Hook saved") });
          } else if (!isAtomCommandInterrupted(res)) {
            toastManager.add({
              type: "error",
              title: gt("Failed to save hook"),
              description: formatError(squashAtomCommandFailure(res), gt("Try again.")),
            });
          }
        }}
      />
    </>
  );
}

function HookEditorDialog({
  open,
  existing,
  canRunTerminal,
  onClose,
  onSave,
}: {
  readonly open: boolean;
  readonly existing: HarnessHookDefinition | null;
  readonly canRunTerminal: boolean;
  readonly onClose: () => void;
  readonly onSave: (payload: {
    readonly id: HarnessHookId;
    readonly event: HarnessHookEvent;
    readonly enabled?: boolean;
    readonly matcher?: typeof TrimmedNonEmptyString.Type;
    readonly timeoutMs?: typeof PositiveInt.Type;
    readonly failClosed?: boolean;
    readonly description?: string;
    readonly target:
      | {
          readonly type: "command";
          readonly command: typeof TrimmedNonEmptyString.Type;
          readonly args?: ReadonlyArray<string>;
        }
      | { readonly type: "http"; readonly url: typeof TrimmedNonEmptyString.Type };
  }) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open ? (
        <HookEditorBody
          key={existing?.id ?? "new-hook"}
          existing={existing}
          canRunTerminal={canRunTerminal}
          onClose={onClose}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

function HookEditorBody({
  existing,
  canRunTerminal,
  onClose,
  onSave,
}: {
  readonly existing: HarnessHookDefinition | null;
  readonly canRunTerminal: boolean;
  readonly onClose: () => void;
  readonly onSave: Parameters<typeof HookEditorDialog>[0]["onSave"];
}) {
  const gt = useGT();
  const [id, setId] = useState(existing?.id ?? "");
  const [event, setEvent] = useState<HarnessHookEvent>(existing?.event ?? "turn.beforeStart");
  const [targetType, setTargetType] = useState<"command" | "http">(
    existing?.target.type ?? (canRunTerminal ? "command" : "http"),
  );
  const [command, setCommand] = useState(
    existing?.target.type === "command" ? existing.target.command : "",
  );
  const [argsText, setArgsText] = useState(
    existing?.target.type === "command" ? (existing.target.args ?? []).join(" ") : "",
  );
  const [url, setUrl] = useState(existing?.target.type === "http" ? existing.target.url : "");
  const [matcher, setMatcher] = useState(existing?.matcher ?? "");
  const [timeoutMs, setTimeoutMs] = useState(String(existing?.timeoutMs ?? 3000));
  const [failClosed, setFailClosed] = useState(existing?.failClosed ?? false);
  const [description, setDescription] = useState(existing?.description ?? "");

  return (
    <DialogPopup className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{existing ? <T>Edit Hook</T> : <T>New Lifecycle Hook</T>}</DialogTitle>
        <DialogDescription>
          <T>Runs across all providers with a bounded timeout and JSON stdin/stdout framing.</T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Hook ID")}</label>
            <Input
              disabled={existing !== null}
              value={existing ? existing.id : id}
              placeholder="policy-gate"
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Event")}</label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_HOOK_EVENTS.map((ev) => (
                <Button
                  key={ev}
                  size="sm"
                  variant={event === ev ? "default" : "outline"}
                  onClick={() => setEvent(ev)}
                >
                  {ev}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Target Type")}</label>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={targetType === "command" ? "default" : "outline"}
                disabled={!canRunTerminal}
                onClick={() => setTargetType("command")}
              >
                command
              </Button>
              <Button
                size="sm"
                variant={targetType === "http" ? "default" : "outline"}
                onClick={() => setTargetType("http")}
              >
                http
              </Button>
            </div>
          </div>
          {targetType === "command" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium">{gt("Command")}</label>
                <Input
                  value={command}
                  placeholder="/usr/bin/env"
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">{gt("Arguments")}</label>
                <Input
                  value={argsText}
                  // oxlint-disable-next-line t3code/no-untranslated-copy -- literal CLI argument example
                  placeholder="node ./scripts/hook.mjs"
                  onChange={(e) => setArgsText(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <label className="text-xs font-medium">{gt("Webhook URL")}</label>
              <Input
                value={url}
                placeholder="https://example.com/hooks/t3"
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">{gt("Matcher (optional glob)")}</label>
              <Input
                value={matcher}
                // oxlint-disable-next-line t3code/no-untranslated-copy -- literal glob pattern example
                placeholder="*deploy*"
                onChange={(e) => setMatcher(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">{gt("Timeout (ms, max 10000)")}</label>
              <Input value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={failClosed}
              onCheckedChange={(checked) => setFailClosed(Boolean(checked))}
            />
            <span>{gt("Fail closed (block turn/tool if hook errors or times out)")}</span>
          </label>
          <div className="space-y-1">
            <label className="text-xs font-medium">{gt("Description")}</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button
          size="sm"
          disabled={targetType === "command" && !canRunTerminal}
          onClick={() => {
            const decodedId = decodeHookId(existing ? existing.id : id);
            if (decodedId._tag === "None") {
              toastManager.add({ type: "error", title: gt("Invalid hook ID") });
              return;
            }
            const parsedTimeout = Number.parseInt(timeoutMs, 10);
            const target =
              targetType === "command"
                ? {
                    type: "command" as const,
                    command: TrimmedNonEmptyString.make(command.trim()),
                    ...(argsText.trim()
                      ? { args: argsText.trim().split(/\s+/u).filter(Boolean) }
                      : {}),
                  }
                : {
                    type: "http" as const,
                    url: TrimmedNonEmptyString.make(url.trim()),
                  };
            if (target.type === "command" && command.trim().length === 0) {
              toastManager.add({ type: "error", title: gt("Command is required") });
              return;
            }
            if (target.type === "http" && url.trim().length === 0) {
              toastManager.add({ type: "error", title: gt("Webhook URL is required") });
              return;
            }
            void onSave({
              id: decodedId.value,
              event,
              ...(existing ? { enabled: existing.enabled } : {}),
              ...(matcher.trim() ? { matcher: TrimmedNonEmptyString.make(matcher.trim()) } : {}),
              ...(Number.isFinite(parsedTimeout) && parsedTimeout > 0
                ? { timeoutMs: PositiveInt.make(parsedTimeout) }
                : {}),
              failClosed,
              ...(description.trim() ? { description: description.trim() } : {}),
              target,
            });
          }}
        >
          <T>Save Hook</T>
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
