import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  HarnessMemoryId,
  type HarnessSyncPreviewPushResult,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT, Var } from "gt-react-native";
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

const decodeMemoryId = Schema.decodeUnknownOption(HarnessMemoryId);

export function SettingsHarnessMemorySyncPanel({
  activeTab,
  environmentId,
  targetHost,
  canWriteSettings,
  canWriteSourceControl,
}: {
  readonly activeTab: "memory" | "sync";
  readonly environmentId: EnvironmentId;
  readonly targetHost: string;
  readonly canWriteSettings: boolean;
  readonly canWriteSourceControl: boolean;
}) {
  if (activeTab === "memory") {
    return (
      <MobileMemoryPanel
        environmentId={environmentId}
        targetHost={targetHost}
        canWriteSettings={canWriteSettings}
      />
    );
  }
  return (
    <MobileSyncPanel
      environmentId={environmentId}
      targetHost={targetHost}
      canWriteSettings={canWriteSettings}
      canWriteSourceControl={canWriteSourceControl}
    />
  );
}

function MobileMemoryPanel({
  environmentId,
  targetHost,
  canWriteSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly targetHost: string;
  readonly canWriteSettings: boolean;
}) {
  const gt = useGT();
  const memoryQuery = useEnvironmentQuery(
    harnessEnvironment.memoryQuery({ environmentId, input: {} }),
  );
  const upsertMemory = useAtomCommand(harnessEnvironment.upsertMemory, { reportFailure: false });
  const removeMemory = useAtomCommand(harnessEnvironment.removeMemory, { reportFailure: false });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [noteId, setNoteId] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [pinned, setPinned] = useState(false);
  const [body, setBody] = useState("");

  if (memoryQuery.isPending && !memoryQuery.data) {
    return <AppActivityIndicator size="small" />;
  }
  const snapshot = memoryQuery.data;

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-xs text-foreground-muted">
          <T>
            Cross-provider markdown notes on <Var>{targetHost}</Var>.
          </T>
        </Text>
        <Button
          label={gt("Add Note")}
          tone="primary"
          disabled={!canWriteSettings}
          onPress={() => setAddOpen(true)}
        />
      </View>

      {!snapshot || snapshot.entries.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          <T>No portable memory notes yet.</T>
        </Text>
      ) : (
        snapshot.entries.map((entry) => (
          <View
            key={entry.id}
            className="gap-1.5 rounded-xl border border-border-subtle bg-card p-3"
          >
            <View className="flex-row items-center justify-between gap-2">
              <View className="min-w-0 flex-1">
                <Text className="font-t3-semibold text-sm text-foreground" numberOfLines={1}>
                  {entry.title}
                </Text>
                <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={1}>
                  {entry.id}
                </Text>
              </View>
              <Button
                label={gt("Delete")}
                tone="secondary"
                disabled={!canWriteSettings || busyId === entry.id}
                onPress={() => {
                  Dialog.confirm({
                    title: gt("Delete memory note"),
                    message: gt("Delete “{title}” from {host}?", {
                      title: entry.title,
                      host: targetHost,
                    }),
                    confirmText: gt("Delete"),
                    destructive: true,
                    onConfirm: () => {
                      void (async () => {
                        setBusyId(entry.id);
                        await removeMemory({ environmentId, input: { id: entry.id } });
                        setBusyId(null);
                        memoryQuery.refresh();
                      })();
                    },
                  });
                }}
              />
            </View>
            <Text className="text-xs text-foreground-muted" numberOfLines={3}>
              {entry.body}
            </Text>
          </View>
        ))
      )}

      <Modal visible={addOpen} animationType="slide" onRequestClose={() => setAddOpen(false)}>
        <ScrollView className="flex-1 bg-background p-5" contentContainerClassName="gap-3 pt-12">
          <Text className="font-t3-semibold text-lg text-foreground">
            <T>New Memory Note</T>
          </Text>
          <TextInput
            value={noteId}
            onChangeText={setNoteId}
            placeholder="deploy-runbook"
            autoCapitalize="none"
            className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
          />
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder={gt("Title")}
            className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
          />
          <TextInput
            value={tags}
            onChangeText={setTags}
            placeholder={gt("Tags (comma separated)")}
            autoCapitalize="none"
            className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
          />
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-foreground">
              <T>Pin note</T>
            </Text>
            <Switch value={pinned} onValueChange={setPinned} />
          </View>
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder={gt("Markdown content")}
            multiline
            numberOfLines={6}
            className="min-h-[120px] rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
          />
          <View className="flex-row gap-2 pt-2">
            <Button label={gt("Cancel")} tone="secondary" onPress={() => setAddOpen(false)} />
            <Button
              label={gt("Save")}
              tone="primary"
              disabled={busyId === "__save__"}
              onPress={() => {
                const idOpt = decodeMemoryId(noteId.trim().toLowerCase());
                if (idOpt._tag === "None" || !title.trim() || !body.trim()) {
                  Dialog.alert(gt("Enter a valid note ID, title, and body."));
                  return;
                }
                const tagList = tags
                  .split(/[,\n]+/u)
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((t) => TrimmedNonEmptyString.make(t));
                void (async () => {
                  setBusyId("__save__");
                  const res = await upsertMemory({
                    environmentId,
                    input: {
                      id: idOpt.value,
                      title: TrimmedNonEmptyString.make(title.trim()),
                      ...(tagList.length > 0 ? { tags: tagList } : {}),
                      pinned,
                      body,
                    },
                  });
                  setBusyId(null);
                  if (res._tag === "Success") {
                    setAddOpen(false);
                    setNoteId("");
                    setTitle("");
                    setTags("");
                    setPinned(false);
                    setBody("");
                    memoryQuery.refresh();
                  } else if (!isAtomCommandInterrupted(res)) {
                    Dialog.alert(
                      gt("Could not save note"),
                      errorDisplayMessage(squashAtomCommandFailure(res), m) ?? gt("Try again."),
                    );
                  }
                })();
              }}
            />
          </View>
        </ScrollView>
      </Modal>
    </View>
  );
}

function MobileSyncPanel({
  environmentId,
  targetHost,
  canWriteSettings,
  canWriteSourceControl,
}: {
  readonly environmentId: EnvironmentId;
  readonly targetHost: string;
  readonly canWriteSettings: boolean;
  readonly canWriteSourceControl: boolean;
}) {
  const canSyncRemote = canWriteSettings && canWriteSourceControl;
  const gt = useGT();
  const statusQuery = useEnvironmentQuery(
    harnessEnvironment.syncStatusQuery({ environmentId, input: {} }),
  );
  const configureSync = useAtomCommand(harnessEnvironment.configureSync, { reportFailure: false });
  const previewSyncPush = useAtomCommand(harnessEnvironment.previewSyncPush, {
    reportFailure: false,
  });
  const pushSync = useAtomCommand(harnessEnvironment.pushSync, { reportFailure: false });
  const pullSync = useAtomCommand(harnessEnvironment.pullSync, { reportFailure: false });

  const [busy, setBusy] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [preview, setPreview] = useState<HarnessSyncPreviewPushResult | null>(null);

  if (statusQuery.isPending && !statusQuery.data) {
    return <AppActivityIndicator size="small" />;
  }
  const status = statusQuery.data;

  return (
    <View className="gap-3">
      <Text className="text-xs text-foreground-muted">
        <T>
          Sync portable harness files on <Var>{targetHost}</Var> via Git. Raw secrets are blocked
          before push.
        </T>
      </Text>

      {status && status.secretFindings.length > 0 ? (
        <View className="gap-1 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
          <Text className="font-t3-semibold text-xs text-destructive">
            <T>
              Push blocked: <Var>{status.secretFindings.length}</Var> raw secret pattern(s)
              detected.
            </T>
          </Text>
        </View>
      ) : null}

      <TextInput
        value={remoteUrl || status?.remoteUrl || ""}
        onChangeText={setRemoteUrl}
        placeholder="git@github.com:you/my-t3-harness.git"
        autoCapitalize="none"
        className="rounded-xl border border-border bg-card px-3 py-2.5 text-foreground"
      />

      <View className="flex-row flex-wrap gap-2">
        <Button
          label={gt("Save Remote")}
          tone="secondary"
          disabled={!canWriteSettings || busy}
          onPress={() => {
            const url = (remoteUrl || status?.remoteUrl || "").trim();
            if (!url) return;
            void (async () => {
              setBusy(true);
              const res = await configureSync({
                environmentId,
                input: { remoteUrl: TrimmedNonEmptyString.make(url) },
              });
              setBusy(false);
              if (res._tag === "Success") {
                statusQuery.refresh();
              } else if (!isAtomCommandInterrupted(res)) {
                Dialog.alert(
                  gt("Configure sync failed"),
                  errorDisplayMessage(squashAtomCommandFailure(res), m) ?? gt("Try again."),
                );
              }
            })();
          }}
        />
        <Button
          label={gt("Preview Push")}
          tone="secondary"
          disabled={!status?.initialized || busy}
          onPress={() => {
            void (async () => {
              setBusy(true);
              const res = await previewSyncPush({ environmentId, input: {} });
              setBusy(false);
              if (res._tag === "Success") {
                setPreview(res.value);
              } else if (!isAtomCommandInterrupted(res)) {
                Dialog.alert(
                  gt("Preview failed"),
                  errorDisplayMessage(squashAtomCommandFailure(res), m) ?? gt("Try again."),
                );
              }
            })();
          }}
        />
        <Button
          label={gt("Pull")}
          tone="secondary"
          disabled={!canSyncRemote || !status?.initialized || busy}
          onPress={() => {
            void (async () => {
              setBusy(true);
              const res = await pullSync({ environmentId, input: {} });
              setBusy(false);
              if (res._tag === "Success") {
                Dialog.alert(gt("Pulled harness updates"), res.value.summary);
                statusQuery.refresh();
              } else if (!isAtomCommandInterrupted(res)) {
                Dialog.alert(
                  gt("Pull failed"),
                  errorDisplayMessage(squashAtomCommandFailure(res), m) ?? gt("Try again."),
                );
              }
            })();
          }}
        />
      </View>

      {preview ? (
        <View className="gap-2 rounded-xl border border-border-subtle bg-card p-3">
          <Text className="font-t3-semibold text-xs text-foreground">
            <T>Outbound Diff Preview</T>
          </Text>
          <Text className="font-mono text-2xs text-foreground-muted">{preview.diffSummary}</Text>
          {preview.files.map((file) => (
            <Text key={file.path} className="font-mono text-2xs text-foreground-muted">
              {`${file.status}: ${file.path}`}
            </Text>
          ))}
          <Button
            label={gt("Commit & Push")}
            tone="primary"
            disabled={
              !canSyncRemote ||
              !preview.canPush ||
              !preview.remoteUrl ||
              !preview.branch ||
              !preview.previewTreeDigest ||
              busy
            }
            onPress={() => {
              if (!preview.remoteUrl || !preview.branch || !preview.previewTreeDigest) return;
              const expectedRemoteUrl = TrimmedNonEmptyString.make(preview.remoteUrl);
              const expectedBranch = TrimmedNonEmptyString.make(preview.branch);
              const expectedTreeDigest = TrimmedNonEmptyString.make(preview.previewTreeDigest);
              void (async () => {
                setBusy(true);
                const res = await pushSync({
                  environmentId,
                  input: {
                    expectedRemoteUrl,
                    expectedBranch,
                    expectedTreeDigest,
                  },
                });
                setBusy(false);
                if (res._tag === "Success") {
                  setPreview(null);
                  Dialog.alert(gt("Harness pushed"), res.value.summary);
                  statusQuery.refresh();
                } else if (!isAtomCommandInterrupted(res)) {
                  Dialog.alert(
                    gt("Push failed"),
                    errorDisplayMessage(squashAtomCommandFailure(res), m) ?? gt("Try again."),
                  );
                }
              })();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
