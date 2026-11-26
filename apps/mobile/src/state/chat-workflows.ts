import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ServerConfig,
  ThreadId,
  WorkflowRunsSnapshot,
  WorkflowSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";

type ChatWorkflowSelections = ReadonlyMap<
  string,
  { environmentId: EnvironmentId; workflow: WorkflowSummary }
>;
const selections = Atom.make<ChatWorkflowSelections>(new Map()).pipe(Atom.keepAlive);
const emptySnapshot = Atom.make(AsyncResult.initial<WorkflowRunsSnapshot>());

function chatWorkflowAvailable(config: ServerConfig | undefined) {
  return config?.environment.capabilities.workflowChat === true && config.settings.workflowsEnabled;
}

export function useChatWorkflows(environmentId: EnvironmentId | null, threadId?: ThreadId) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const config = environmentId === null ? undefined : configs.get(environmentId);
  const enabled = chatWorkflowAvailable(config);
  const result = useAtomValue(
    environmentId !== null && enabled
      ? serverEnvironment.workflowsLive({
          environmentId,
          input: { chat: threadId === undefined ? {} : { threadId } },
        })
      : emptySnapshot,
  );
  return { enabled, snapshot: Option.getOrNull(AsyncResult.value(result)) };
}

function selectionOf(
  values: ChatWorkflowSelections,
  draftKey: string | null,
  environmentId: EnvironmentId | null,
) {
  const current = draftKey === null ? undefined : values.get(draftKey);
  return current !== undefined && current.environmentId === environmentId ? current.workflow : null;
}

export function useChatWorkflowMode(draftKey: string | null, environmentId: EnvironmentId | null) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const selected = selectionOf(useAtomValue(selections), draftKey, environmentId);
  return environmentId !== null && chatWorkflowAvailable(configs.get(environmentId))
    ? selected
    : null;
}

export function readChatWorkflowMode(draftKey: string, environmentId: EnvironmentId) {
  return chatWorkflowAvailable(appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId))
    ? selectionOf(appAtomRegistry.get(selections), draftKey, environmentId)
    : null;
}

export function setChatWorkflowMode(
  draftKey: string,
  environmentId: EnvironmentId,
  workflow: WorkflowSummary | null,
) {
  appAtomRegistry.update(selections, (values) => {
    if (workflow === null && !values.has(draftKey)) return values;
    const next = new Map(values);
    if (workflow === null) next.delete(draftKey);
    else next.set(draftKey, { environmentId, workflow });
    return next;
  });
}
