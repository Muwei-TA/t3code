import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type HarnessHookEvent,
  HarnessHookId,
  type HarnessPluginView,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { Modal, ScrollView, Switch, TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const decodeHookId = Schema.decodeUnknownOption(HarnessHookId);

const HOOK_EVENTS: ReadonlyArray<HarnessHookEvent> = [
  "turn.beforeStart",
  "thread.created",
  "turn.completed",
  "run.settled",
  "checkpoint.created",
  "PreToolUse",
  "PostToolUse",
];

export function SettingsHarnessPluginsHooksPanel({
  activeTab,
  environmentId,
  targetHost,
  canWriteSettings,
  canOperateTerminal,
}: {
  readonly activeTab: "plugins" | "hooks";
  readonly environmentId: EnvironmentId;
  readonly targetHost: string;
  readonly canWriteSettings: boolean;
  readonly canOperateTerminal: boolean;
}) {
  const gt = useGT();
  const pluginsQuery = useEnvironmentQuery(
    harnessEnvironment.pluginsQuery({ environmentId, input: {} }),
  );
  const hooksQuery = useEnvironmentQuery(
    harnessEnvironment.hooksQuery({ environmentId, input: {} }),
  );

  const installPlugin = useAtomCommand(harnessEnvironment.installPlugin, { reportFailure: false });
  const trustPlugin = useAtomCommand(harnessEnvironment.trustPlugin, { reportFailure: false });
  const setPluginEnabled = useAtomCommand(harnessEnvironment.setPluginEnabled, {
    reportFailure: false,
  });
  const removePlugin = useAtomCommand(harnessEnvironment.removePlugin, { reportFailure: false });
  const reloadPlugins = useAtomCommand(harnessEnvironment.reloadPlugins, { reportFailure: false });

  const upsertHook = useAtomCommand(harnessEnvironment.upsertHook, { reportFailure: false });
  const removeHook = useAtomCommand(harnessEnvironment.removeHook, { reportFailure: false });
  const setHookEnabled = useAtomCommand(harnessEnvironment.setHookEnabled, {
    reportFailure: false,
  });
  const testHook = useAtomCommand(harnessEnvironment.testHook, { reportFailure: false });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [installPath, setInstallPath] = useState("");
  const [hookModalOpen, setHookModalOpen] = useState(false);
  const [hookId, setHookId] = useState("");
  const [hookEvent, setHookEvent] = useState<HarnessHookEvent>("turn.beforeStart");
  const [hookTargetType, setHookTargetType] = useState<"command" | "http">("http");
  const [hookCommand, setHookCommand] = useState("");
  const [hookArgs, setHookArgs] = useState("");
  const [hookUrl, setHookUrl] = useState("");
  const [hookMatcher, setHookMatcher] = useState("");
  const [hookFailClosed, setHookFailClosed] = useState(false);

  const handleTrustPlugin = (plugin: HarnessPluginView) => {
    const shortDigest = plugin.contentDigest.slice(0, 16);
    Dialog.confirm({
      title: gt("Review plugin digest (1/2)"),
      message: gt(
        "Plugin: {name} v{version}\nHost: {host}\nDigest: sha256:{digest}\nFormat: {format}\n\nContinue to trust confirmation?",
        {
          name: plugin.name,
          version: plugin.version,
          host: targetHost,
          digest: shortDigest,
          format: plugin.format,
        },
      ),
      confirmText: gt("Continue"),
      onConfirm: () => {
        Dialog.confirm({
          title: gt("Trust and activate plugin? (2/2)"),
          message: gt(
            "Pin digest sha256:{digest} for “{name}” on {host}. Any file modification automatically revokes trust.",
            { digest: shortDigest, name: plugin.name, host: targetHost },
          ),
          confirmText: gt("Trust & activate"),
          onConfirm: () => {
            void (async () => {
              setBusyId(plugin.id);
              const res = await trustPlugin({
                environmentId,
                input: {
                  id: plugin.id,
                  expectedDigest: TrimmedNonEmptyString.make(plugin.contentDigest),
                },
              });
              setBusyId(null);
              if (res._tag === "Success") {
                pluginsQuery.refresh();
              } else if (!isAtomCommandInterrupted(res)) {
                Dialog.alert(
                  gt("Could not trust plugin"),
                  errorDisplayMessage(squashAtomCommandFailure(res), m) ?? gt("Try again."),
                );
              }
            })();
          },
        });
      },
    });
  };

  if (activeTab === "plugins") {
    const snapshot = pluginsQuery.data;
    const allowsPlugins =
      snapshot?.managedPolicyAllowsHarness === true &&
      snapshot.managedPolicyAllowsPlugins !== false;
    const editable = canWriteSettings && allowsPlugins;
    return (
      <View className="gap-3">
        {snapshot && !allowsPlugins ? (
          <Text className="text-xs text-foreground-muted">
            <T>Your organization has disabled external plugins.</T>
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={gt("Install plugin")}
            tone="primary"
            disabled={!editable}
            onPress={() => setInstallOpen(true)}
          />
          <Button
            label={gt("Reload")}
            tone="secondary"
            disabled={!editable || busyId !== null}
            onPress={() => {
              void (async () => {
                setBusyId("__reload__");
                await reloadPlugins({ environmentId, input: {} });
                setBusyId(null);
                pluginsQuery.refresh();
              })();
            }}
          />
        </View>

        {snapshot === null ? (
          <AppActivityIndicator />
        ) : snapshot.plugins.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            <T>No plugins installed on this host yet.</T>
          </Text>
        ) : (
          snapshot.plugins.map((plugin) => (
            <View
              key={plugin.id}
              className="gap-2 rounded-xl border border-border-subtle bg-card p-3"
            >
              <View className="flex-row items-center justify-between gap-2">
                <View className="min-w-0 flex-1">
                  <Text className="font-t3-semibold text-sm text-foreground" numberOfLines={1}>
                    {plugin.name} v{plugin.version}
                  </Text>
                  <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={1}>
                    {/* oxlint-disable-next-line t3code/no-untranslated-copy -- plugin format and SHA-256 digest identifier */}
                    {`${plugin.format} · sha256:${plugin.contentDigest.slice(0, 12)}`}
                  </Text>
                </View>
                {plugin.trustStatus === "trusted" ? (
                  <Switch
                    value={plugin.enabled}
                    disabled={!editable || busyId === plugin.id}
                    onValueChange={(enabled) => {
                      void (async () => {
                        setBusyId(plugin.id);
                        await setPluginEnabled({
                          environmentId,
                          input: { id: plugin.id, enabled },
                        });
                        setBusyId(null);
                        pluginsQuery.refresh();
                      })();
                    }}
                  />
                ) : (
                  <Button
                    label={gt("Trust")}
                    tone="primary"
                    disabled={!editable || busyId === plugin.id}
                    onPress={() => handleTrustPlugin(plugin)}
                  />
                )}
              </View>
              <View className="flex-row items-center justify-between gap-2">
                <Text className="text-xs text-foreground-muted">
                  {plugin.active
                    ? gt("Active")
                    : plugin.trustStatus === "digest_changed"
                      ? gt("Digest changed: re-trust required")
                      : plugin.trustStatus === "untrusted"
                        ? gt("Untrusted")
                        : gt("Disabled")}
                </Text>
                <Button
                  label={gt("Remove")}
                  tone="secondary"
                  disabled={!canWriteSettings || busyId === plugin.id}
                  onPress={() => {
                    Dialog.confirm({
                      title: gt("Remove plugin"),
                      message: gt("Remove plugin “{name}” from {host}?", {
                        name: plugin.name,
                        host: targetHost,
                      }),
                      confirmText: gt("Remove"),
                      destructive: true,
                      onConfirm: () => {
                        void (async () => {
                          setBusyId(plugin.id);
                          await removePlugin({ environmentId, input: { id: plugin.id } });
                          setBusyId(null);
                          pluginsQuery.refresh();
                        })();
                      },
                    });
                  }}
                />
              </View>
            </View>
          ))
        )}

        <Modal
          visible={installOpen}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setInstallOpen(false)}
        >
          <ScrollView
            className="flex-1 bg-screen px-5 pt-6"
            contentContainerClassName="gap-4 pb-10"
          >
            <Text className="font-t3-bold text-xl text-foreground">
              <T>Install Local Plugin</T>
            </Text>
            <Text className="text-xs text-foreground-muted">
              <T>
                Enter a plugin directory path on the host containing t3-plugin.json or
                .claude-plugin/plugin.json.
              </T>
            </Text>
            <TextInput
              value={installPath}
              onChangeText={setInstallPath}
              placeholder="/path/to/plugin"
              autoCapitalize="none"
              className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
            />
            <View className="flex-row gap-2">
              <Button
                label={gt("Install")}
                tone="primary"
                disabled={busyId !== null || installPath.trim().length === 0}
                onPress={() => {
                  void (async () => {
                    setBusyId("__install__");
                    const res = await installPlugin({
                      environmentId,
                      input: { sourcePath: TrimmedNonEmptyString.make(installPath.trim()) },
                    });
                    setBusyId(null);
                    if (res._tag === "Success") {
                      setInstallOpen(false);
                      setInstallPath("");
                      pluginsQuery.refresh();
                    } else if (!isAtomCommandInterrupted(res)) {
                      Dialog.alert(
                        gt("Could not install plugin"),
                        errorDisplayMessage(squashAtomCommandFailure(res), m) ?? gt("Try again."),
                      );
                    }
                  })();
                }}
              />
              <Button label={gt("Cancel")} tone="secondary" onPress={() => setInstallOpen(false)} />
            </View>
          </ScrollView>
        </Modal>
      </View>
    );
  }

  const hooksSnapshot = hooksQuery.data;
  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={gt("Add hook")}
          tone="primary"
          disabled={!canWriteSettings}
          onPress={() => setHookModalOpen(true)}
        />
        <Button label={gt("Refresh")} tone="secondary" onPress={() => hooksQuery.refresh()} />
      </View>

      {hooksSnapshot === null ? (
        <AppActivityIndicator />
      ) : hooksSnapshot.hooks.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          <T>No lifecycle hooks configured on this host yet.</T>
        </Text>
      ) : (
        [...hooksSnapshot.hooks]
          .sort((a, b) => Number(Boolean(b.pendingApproval)) - Number(Boolean(a.pendingApproval)))
          .map((hook) => (
            <View
              key={`${hook.source}:${hook.id}`}
              className="gap-2 rounded-xl border border-border-subtle bg-card p-3"
            >
              <View className="flex-row items-center justify-between gap-2">
                <View className="min-w-0 flex-1">
                  <Text
                    className="font-mono text-sm font-t3-medium text-foreground"
                    numberOfLines={1}
                  >
                    {hook.id}
                  </Text>
                  <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                    {hook.event} · {hook.target.type}
                    {hook.pluginId ? ` · ${hook.pluginId}` : ""}
                  </Text>
                  {hook.source === "user" &&
                  !canOperateTerminal &&
                  hook.target.type === "command" &&
                  !hook.enabled ? (
                    <Text className="text-xs text-foreground-muted">
                      <T>Enabling command hooks requires terminal access.</T>
                    </Text>
                  ) : null}
                </View>
                {hook.source === "user" && hook.pendingApproval ? (
                  <Button
                    label={gt("Approve & Enable")}
                    disabled={
                      !canWriteSettings ||
                      busyId === hook.id ||
                      (!canOperateTerminal && hook.target.type === "command")
                    }
                    onPress={async () => {
                      setBusyId(hook.id);
                      await setHookEnabled({
                        environmentId,
                        input: { id: hook.id, enabled: true },
                      });
                      setBusyId(null);
                      hooksQuery.refresh();
                    }}
                  />
                ) : hook.source === "user" ? (
                  <Switch
                    value={hook.enabled}
                    disabled={
                      !canWriteSettings ||
                      busyId === hook.id ||
                      (!canOperateTerminal && hook.target.type === "command" && !hook.enabled)
                    }
                    onValueChange={(enabled) => {
                      void (async () => {
                        setBusyId(hook.id);
                        await setHookEnabled({ environmentId, input: { id: hook.id, enabled } });
                        setBusyId(null);
                        hooksQuery.refresh();
                      })();
                    }}
                  />
                ) : null}
              </View>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={gt("Test")}
                  tone="secondary"
                  disabled={
                    !canWriteSettings ||
                    !canOperateTerminal ||
                    busyId === hook.id ||
                    hook.pendingApproval === true
                  }
                  onPress={() => {
                    void (async () => {
                      setBusyId(hook.id);
                      const res = await testHook({ environmentId, input: { id: hook.id } });
                      setBusyId(null);
                      if (res._tag === "Success") {
                        const r = res.value;
                        Dialog.alert(
                          r.blocked
                            ? gt("Hook blocked ({ms}ms)", { ms: r.durationMs })
                            : r.ok
                              ? gt("Hook passed ({ms}ms)", { ms: r.durationMs })
                              : gt("Hook failed ({ms}ms)", { ms: r.durationMs }),
                          r.blockReason ?? r.injectedContext ?? r.error ?? r.stdout ?? gt("Done."),
                        );
                      } else if (!isAtomCommandInterrupted(res)) {
                        Dialog.alert(
                          gt("Hook test failed"),
                          errorDisplayMessage(squashAtomCommandFailure(res), m) ?? gt("Try again."),
                        );
                      }
                    })();
                  }}
                />
                {hook.source === "user" ? (
                  <Button
                    label={hook.pendingApproval ? gt("Reject") : gt("Remove")}
                    tone="secondary"
                    disabled={!canWriteSettings || busyId === hook.id}
                    onPress={() => {
                      void (async () => {
                        setBusyId(hook.id);
                        await removeHook({ environmentId, input: { id: hook.id } });
                        setBusyId(null);
                        hooksQuery.refresh();
                      })();
                    }}
                  />
                ) : null}
              </View>
            </View>
          ))
      )}

      <Modal
        visible={hookModalOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setHookModalOpen(false)}
      >
        <ScrollView className="flex-1 bg-screen px-5 pt-6" contentContainerClassName="gap-4 pb-10">
          <Text className="font-t3-bold text-xl text-foreground">
            <T>New Lifecycle Hook</T>
          </Text>
          <TextInput
            value={hookId}
            onChangeText={setHookId}
            placeholder="policy-gate"
            autoCapitalize="none"
            className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
          />
          <View className="flex-row flex-wrap gap-1.5">
            {HOOK_EVENTS.map((ev) => (
              <Button
                key={ev}
                label={ev}
                tone={hookEvent === ev ? "primary" : "secondary"}
                onPress={() => setHookEvent(ev)}
              />
            ))}
          </View>
          <View className="flex-row gap-2">
            <Button
              label="http"
              tone={hookTargetType === "http" ? "primary" : "secondary"}
              onPress={() => setHookTargetType("http")}
            />
            <Button
              label="command"
              tone={hookTargetType === "command" ? "primary" : "secondary"}
              disabled={!canOperateTerminal}
              onPress={() => setHookTargetType("command")}
            />
          </View>
          {hookTargetType === "http" ? (
            <TextInput
              value={hookUrl}
              onChangeText={setHookUrl}
              placeholder="https://example.com/hook"
              autoCapitalize="none"
              className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
            />
          ) : (
            <>
              <TextInput
                value={hookCommand}
                onChangeText={setHookCommand}
                placeholder="/usr/bin/env"
                autoCapitalize="none"
                className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
              />
              <TextInput
                value={hookArgs}
                onChangeText={setHookArgs}
                // oxlint-disable-next-line t3code/no-untranslated-copy -- literal CLI argument example
                placeholder="node ./hook.mjs"
                autoCapitalize="none"
                className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
              />
            </>
          )}
          <TextInput
            value={hookMatcher}
            onChangeText={setHookMatcher}
            placeholder={gt("Optional matcher (*deploy*)")}
            autoCapitalize="none"
            className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
          />
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-foreground">
              <T>Fail closed on error/timeout</T>
            </Text>
            <Switch value={hookFailClosed} onValueChange={setHookFailClosed} />
          </View>
          <View className="flex-row gap-2">
            <Button
              label={gt("Save")}
              tone="primary"
              disabled={busyId !== null || (hookTargetType === "command" && !canOperateTerminal)}
              onPress={() => {
                const decoded = decodeHookId(hookId.trim());
                if (decoded._tag === "None") {
                  Dialog.alert(gt("Invalid hook ID"));
                  return;
                }
                const target =
                  hookTargetType === "http"
                    ? {
                        type: "http" as const,
                        url: TrimmedNonEmptyString.make(hookUrl.trim()),
                      }
                    : {
                        type: "command" as const,
                        command: TrimmedNonEmptyString.make(hookCommand.trim()),
                        ...(hookArgs.trim()
                          ? { args: hookArgs.trim().split(/\s+/u).filter(Boolean) }
                          : {}),
                      };
                void (async () => {
                  setBusyId("__save_hook__");
                  const res = await upsertHook({
                    environmentId,
                    input: {
                      id: decoded.value,
                      event: hookEvent,
                      ...(hookMatcher.trim()
                        ? { matcher: TrimmedNonEmptyString.make(hookMatcher.trim()) }
                        : {}),
                      timeoutMs: PositiveInt.make(3000),
                      failClosed: hookFailClosed,
                      target,
                    },
                  });
                  setBusyId(null);
                  if (res._tag === "Success") {
                    setHookModalOpen(false);
                    setHookId("");
                    hooksQuery.refresh();
                  } else if (!isAtomCommandInterrupted(res)) {
                    Dialog.alert(
                      gt("Could not save hook"),
                      errorDisplayMessage(squashAtomCommandFailure(res), m) ?? gt("Try again."),
                    );
                  }
                })();
              }}
            />
            <Button label={gt("Cancel")} tone="secondary" onPress={() => setHookModalOpen(false)} />
          </View>
        </ScrollView>
      </Modal>
    </View>
  );
}
