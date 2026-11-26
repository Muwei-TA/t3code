import {
  HarnessError,
  HarnessMcpResourceSummary,
  type ComposerContextId,
  type ComposerContextRecord,
  type McpResourceContextRecord,
  type OrchestrationV2HarnessCapabilities,
  type OrchestrationV2RunHarnessMode,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import { resolveRunHarnessMode, runInteractionMode } from "./HarnessTurnPreprocess.ts";
import * as McpGateway from "./McpGateway.ts";

const MAX_BYTES = 32 * 1024;
const MAX_MENTIONS = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const textMime = (type: string | undefined) =>
  type === undefined ||
  /^text\/(?:plain|markdown)(?:;|$)|^(?:application\/json)(?:;|$)/i.test(type);
const isResourceSummary = Schema.is(HarnessMcpResourceSummary);

type ThreadContext = Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "worktreePath" | "modeId" | "interactionMode" | "runtimeMode"
>;

export const resolveContext = Effect.fn("HarnessMcpResourceMentions.resolveContext")(function* (
  workspaceRoot: string,
  thread: ThreadContext | null,
  library: HarnessLibraryStore.HarnessLibraryStore["Service"] | undefined,
  override?: OrchestrationV2RunHarnessMode,
  capabilities?: OrchestrationV2HarnessCapabilities,
) {
  const interactionMode = thread?.interactionMode ?? "default";
  const activeMode =
    library === undefined
      ? null
      : yield* resolveRunHarnessMode(library, {
          modeId: thread?.modeId,
          interactionMode,
          workspaceRoot,
          override,
        }).pipe(Effect.orElseSucceed(() => null));
  return {
    providerSessionId: thread?.id ?? "composer",
    workspaceRoot,
    runtimeMode: thread?.runtimeMode ?? "approval-required",
    interactionMode: runInteractionMode(interactionMode, override),
    activeMode,
    includeProposePlan: false,
    deferredExposure: false,
    harnessCapabilities: capabilities,
  } satisfies McpGateway.GatewaySessionContext;
});

export const list = Effect.fn("HarnessMcpResourceMentions.list")(function* (
  gateway: McpGateway.McpGateway["Service"],
  context: McpGateway.GatewaySessionContext,
) {
  const resources = yield* gateway
    .listResourcesForSession(context, { connectedOnly: true })
    .pipe(Effect.timeoutOption("2 seconds"));
  return Option.getOrElse(resources, () => [])
    .flatMap(({ uri, serverId, name, mimeType }) => {
      const resource = { uri, serverId, name: name.trim().slice(0, 200) };
      return textMime(mimeType) && isResourceSummary(resource) ? [resource] : [];
    })
    .slice(0, 200);
});

export const read = Effect.fn("HarnessMcpResourceMentions.read")(function* (
  gateway: McpGateway.McpGateway["Service"],
  context: McpGateway.GatewaySessionContext,
  uri: string,
  budget = MAX_BYTES,
) {
  const resource = yield* gateway
    .readResourceForSession({ context, uri, connectedOnly: true })
    .pipe(Effect.timeoutOption("2 seconds"));
  if (Option.isNone(resource))
    return yield* new HarnessError({
      code: "upstream_error",
      detail: "Timed out reading the MCP resource.",
    });
  let text = "";
  let remaining = budget;
  for (const item of resource.value.contents) {
    if (
      typeof item.text !== "string" ||
      !textMime(typeof item.mimeType === "string" ? item.mimeType : undefined)
    )
      continue;
    const block = encoder.encode((text === "" ? "" : "\n") + item.text.slice(0, remaining));
    let end = Math.min(block.length, remaining);
    while (end < block.length && (block[end]! & 0xc0) === 0x80) end -= 1;
    text += decoder.decode(block.subarray(0, end));
    remaining -= end;
    if (remaining === 0 || end < block.length) break;
  }
  return { text };
});

export const makeMessageProjector = Effect.gen(function* () {
  const gateway = yield* Effect.serviceOption(McpGateway.McpGateway);
  const projects = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const library = yield* Effect.serviceOption(HarnessLibraryStore.HarnessLibraryStore);
  const identity = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity);
  return Effect.fn("HarnessMcpResourceMentions.projectMessage")(function* (
    input: { readonly text: string; readonly records: ReadonlyArray<ComposerContextRecord> },
    thread: ThreadContext,
    override: OrchestrationV2RunHarnessMode | undefined,
    capabilities: OrchestrationV2HarnessCapabilities | undefined,
  ) {
    const resourceRecords = input.records.filter(
      (record): record is McpResourceContextRecord =>
        record.kind === "mcp-resource" && "uri" in record,
    );
    if (resourceRecords.length === 0) return projectComposerContextForProvider(input);
    if (Option.isNone(identity) || Option.isNone(gateway))
      return projectComposerContextForProvider(input);
    const environmentId = yield* identity.value.getEnvironmentId;
    const references = new Set(
      collectComposerContextReferences(input.text).map((ref) => ref.contextId),
    );
    const records = resourceRecords
      .filter(
        (record) =>
          record.environmentId === environmentId &&
          record.projectId === thread.projectId &&
          references.has(record.contextId),
      )
      .slice(0, MAX_MENTIONS);
    if (records.length === 0) return projectComposerContextForProvider(input);
    const root =
      thread.worktreePath ??
      (Option.isSome(projects)
        ? yield* projects.value.get(thread.projectId).pipe(
            Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined);
    if (!root) return projectComposerContextForProvider(input);
    const context = yield* resolveContext(
      root,
      thread,
      Option.getOrUndefined(library),
      override,
      capabilities,
    );
    let remaining = MAX_BYTES;
    const resourceText = new Map<ComposerContextId, string>();
    const resolved = new Map<string, string>();
    for (const record of records) {
      if (remaining === 0 || resourceText.has(record.contextId)) continue;
      let text = resolved.get(record.uri);
      if (text === undefined) {
        const resource = yield* read(gateway.value, context, record.uri, remaining).pipe(
          Effect.option,
        );
        if (Option.isNone(resource)) continue;
        text = resource.value.text;
        resolved.set(record.uri, text);
      }
      const length = encoder.encode(text).byteLength;
      if (length > remaining) continue;
      remaining -= length;
      resourceText.set(record.contextId, text);
    }
    return projectComposerContextForProvider({ ...input, resourceText });
  });
});
