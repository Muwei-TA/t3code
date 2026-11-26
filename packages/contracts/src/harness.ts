import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";

const HARNESS_SERVER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Sentinel returned for literal env/header values in redacted Harness read models. */
export const HARNESS_SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

/** Built-in T3 MCP server identifiers and dynamic thread-scoped prefixes that user/project configs may never shadow. */
const RESERVED_HARNESS_MCP_SERVER_IDS: ReadonlySet<string> = new Set([
  "t3-code",
  "t3_code",
  "t3-code-direct",
  "t3_code_direct",
  "t3-harness",
  "t3_harness",
]);

const RESERVED_HARNESS_MCP_SERVER_PREFIXES: ReadonlyArray<string> = [
  "t3-code-",
  "t3_code_",
  "t3-harness-",
  "t3_harness_",
];

export function isReservedHarnessMcpServerId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  if (RESERVED_HARNESS_MCP_SERVER_IDS.has(normalized)) return true;
  return RESERVED_HARNESS_MCP_SERVER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export const HarnessMcpServerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(HARNESS_SERVER_ID_PATTERN),
  Schema.makeFilter((value: string) => !isReservedHarnessMcpServerId(value), {
    expected: "a non-reserved MCP server identifier",
  }),
).annotate({
  description:
    "Stable MCP server identifier (letters, digits, underscores, hyphens; no dots, spaces, or reserved T3 built-in names).",
});
export type HarnessMcpServerId = typeof HarnessMcpServerId.Type;

export const HarnessMcpStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  args: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(4096)))),
  cwd: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  /** Values may contain `${secret:NAME}` or `${secret:PROVIDER:REF}` placeholders resolved on the server. */
  env: Schema.optionalKey(
    Schema.Record(
      TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      Schema.String.check(Schema.isMaxLength(4096)),
    ),
  ),
});
export type HarnessMcpStdioTransport = typeof HarnessMcpStdioTransport.Type;

/** Validates that a candidate URL parses cleanly as an http(s) URL with a non-empty hostname and valid port. */
export function isValidHarnessHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/u.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

const HarnessMcpRemoteUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value: string) => isValidHarnessHttpUrl(value), {
    expected: "a valid http or https URL",
  }),
);

export const HarnessMcpHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: HarnessMcpRemoteUrl,
  /** Header values may contain `${secret:NAME}` or `${secret:PROVIDER:REF}` placeholders resolved on the server. */
  headers: Schema.optionalKey(
    Schema.Record(
      TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      Schema.String.check(Schema.isMaxLength(4096)),
    ),
  ),
});
export type HarnessMcpHttpTransport = typeof HarnessMcpHttpTransport.Type;

export const HarnessMcpSseTransport = Schema.Struct({
  type: Schema.Literal("sse"),
  url: HarnessMcpRemoteUrl,
  headers: Schema.optionalKey(
    Schema.Record(
      TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      Schema.String.check(Schema.isMaxLength(4096)),
    ),
  ),
});
export type HarnessMcpSseTransport = typeof HarnessMcpSseTransport.Type;

export const HarnessMcpTransport = Schema.Union([
  HarnessMcpStdioTransport,
  HarnessMcpHttpTransport,
  HarnessMcpSseTransport,
]);
export type HarnessMcpTransport = typeof HarnessMcpTransport.Type;

export const HarnessMcpInjectionMode = Schema.Literals(["gateway", "native"]);
export type HarnessMcpInjectionMode = typeof HarnessMcpInjectionMode.Type;

export const HarnessMcpApprovalPolicy = Schema.Literals(["always-ask", "auto-read", "auto-all"]);
export type HarnessMcpApprovalPolicy = typeof HarnessMcpApprovalPolicy.Type;

export const HarnessMcpOriginKind = Schema.Literals(["user", "project", "imported"]);
export type HarnessMcpOriginKind = typeof HarnessMcpOriginKind.Type;

export const HarnessMcpOrigin = Schema.Struct({
  kind: HarnessMcpOriginKind,
  source: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  sourcePath: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
});
export type HarnessMcpOrigin = typeof HarnessMcpOrigin.Type;

export const HarnessMcpServerConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  transport: HarnessMcpTransport,
  injectionMode: HarnessMcpInjectionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("gateway" as const)),
  ),
  approvalPolicy: HarnessMcpApprovalPolicy.pipe(
    Schema.withDecodingDefault(Effect.succeed("auto-read" as const)),
  ),
  allowedTools: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  ),
  disabledTools: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  ),
  description: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  origin: Schema.optionalKey(HarnessMcpOrigin),
});
export type HarnessMcpServerConfig = typeof HarnessMcpServerConfig.Type;

export const HarnessConfigFile = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  mcpServers: Schema.Record(HarnessMcpServerId, HarnessMcpServerConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type HarnessConfigFile = typeof HarnessConfigFile.Type;

/** Checked-in project harness configuration inside `t3.json`. */
export const ProjectHarnessConfig = Schema.Struct({
  mcpServers: Schema.optionalKey(Schema.Record(HarnessMcpServerId, HarnessMcpServerConfig)),
  disabledMcpServers: Schema.optionalKey(Schema.Array(HarnessMcpServerId)),
}).annotate({
  description:
    "Project-scoped portable harness configuration (MCP servers and overrides). Stdio servers require explicit owner trust confirmation before execution.",
});
export type ProjectHarnessConfig = typeof ProjectHarnessConfig.Type;

export const HarnessMcpToolSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  exposedName: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
  readOnly: Schema.Boolean,
});
export type HarnessMcpToolSummary = typeof HarnessMcpToolSummary.Type;

export const HarnessMcpServerState = Schema.Literals([
  "idle",
  "starting",
  "connected",
  "error",
  "untrusted",
  "blocked_by_policy",
  "disabled",
]);
export type HarnessMcpServerState = typeof HarnessMcpServerState.Type;

export const HarnessMcpServerScope = Schema.Literals(["user", "project"]);
export type HarnessMcpServerScope = typeof HarnessMcpServerScope.Type;

export const HarnessMcpTrustReason = Schema.Literals([
  "stdio",
  "secrets",
  "stdio_and_secrets",
  "project",
]);
export type HarnessMcpTrustReason = typeof HarnessMcpTrustReason.Type;

export const HarnessMcpServerView = Schema.Struct({
  id: HarnessMcpServerId,
  scope: HarnessMcpServerScope,
  config: HarnessMcpServerConfig,
  configDigest: Schema.String,
  effectiveEnabled: Schema.Boolean,
  state: HarnessMcpServerState,
  toolCount: NonNegativeInt,
  tools: Schema.Array(HarnessMcpToolSummary),
  discoveredToolNames: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  estimatedToolListBytes: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  needsTrustConfirmation: Schema.Boolean,
  trustReason: Schema.NullOr(HarnessMcpTrustReason),
  requiresSecretAccess: Schema.Boolean,
  trustDigest: Schema.NullOr(Schema.String),
  repoRoot: Schema.NullOr(Schema.String),
  overriddenByProject: Schema.Boolean,
  stderrLinesCount: NonNegativeInt,
});
export type HarnessMcpServerView = typeof HarnessMcpServerView.Type;

export const HarnessInvalidEntry = Schema.Struct({
  source: Schema.String,
  id: Schema.NullOr(Schema.String),
  message: Schema.String,
});
export type HarnessInvalidEntry = typeof HarnessInvalidEntry.Type;

export const HarnessMcpSnapshot = Schema.Struct({
  harnessDir: Schema.String,
  configPath: Schema.String,
  workspaceRoot: Schema.NullOr(Schema.String),
  servers: Schema.Array(HarnessMcpServerView),
  invalidEntries: Schema.Array(HarnessInvalidEntry),
  managedPolicyAllowsHarness: Schema.Boolean,
  managedPolicyAllowsStdio: Schema.Boolean,
  managedPolicyOrganization: Schema.NullOr(Schema.String),
});
export type HarnessMcpSnapshot = typeof HarnessMcpSnapshot.Type;

export const HarnessMcpImportSource = Schema.Literals(["codex", "claude", "cursor", "antigravity"]);
export type HarnessMcpImportSource = typeof HarnessMcpImportSource.Type;

export const HarnessMcpImportConflict = Schema.Literals([
  "none",
  "exists_identical",
  "exists_different",
]);
export type HarnessMcpImportConflict = typeof HarnessMcpImportConflict.Type;

export const HarnessMcpImportCandidate = Schema.Struct({
  id: HarnessMcpServerId,
  /** Redacted preview config (literal env/header/url/arg secrets are masked with HARNESS_SECRET_REDACTED). */
  config: HarnessMcpServerConfig,
  previewDigest: Schema.String,
  /** Keyed confirmation digest of any currently stored user server with the same id (`null` when absent). */
  existingDigest: Schema.optionalKey(Schema.NullOr(Schema.String)),
  hasSecretPlaceholders: Schema.Boolean,
  conflict: HarnessMcpImportConflict,
});
export type HarnessMcpImportCandidate = typeof HarnessMcpImportCandidate.Type;

export const HarnessMcpImportSourcePreview = Schema.Struct({
  source: HarnessMcpImportSource,
  sourcePath: Schema.String,
  found: Schema.Boolean,
  candidates: Schema.Array(HarnessMcpImportCandidate),
  warnings: Schema.Array(Schema.String),
});
export type HarnessMcpImportSourcePreview = typeof HarnessMcpImportSourcePreview.Type;

export const HarnessMcpLogLine = Schema.Struct({
  timestamp: IsoDateTime,
  stream: Schema.Literals(["stderr", "lifecycle"]),
  text: Schema.String,
});
export type HarnessMcpLogLine = typeof HarnessMcpLogLine.Type;

export const HarnessMcpLogsResult = Schema.Struct({
  serverId: HarnessMcpServerId,
  lines: Schema.Array(HarnessMcpLogLine),
});
export type HarnessMcpLogsResult = typeof HarnessMcpLogsResult.Type;

export const HarnessPlanModeKind = Schema.Literals(["native", "harness-propose-plan", "none"]);
export type HarnessPlanModeKind = typeof HarnessPlanModeKind.Type;

export const HarnessPlanReadOnlyEnforcement = Schema.Literals(["native", "advisory"]);
export type HarnessPlanReadOnlyEnforcement = typeof HarnessPlanReadOnlyEnforcement.Type;

export const ThreadContextMcpItem = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literals(["builtin", "user", "project"]),
  channel: Schema.Literals(["gateway", "native", "blocked", "disabled"]),
  state: HarnessMcpServerState,
  toolCount: NonNegativeInt,
  estimatedToolListBytes: NonNegativeInt,
  reason: Schema.optionalKey(Schema.String),
});
export type ThreadContextMcpItem = typeof ThreadContextMcpItem.Type;

export const ThreadContextDegradedItem = Schema.Struct({
  kind: Schema.Literals(["mcp", "plan"]),
  id: Schema.String,
  reason: Schema.String,
});
export type ThreadContextDegradedItem = typeof ThreadContextDegradedItem.Type;

/** On-demand diagnostic manifest for a thread (fetched on click, never pushed on WS streams). */
export const ThreadContextManifest = Schema.Struct({
  threadId: ThreadId,
  generatedAt: IsoDateTime,
  providerInstanceId: ProviderInstanceId,
  interactionMode: ProviderInteractionMode,
  planModeSource: HarnessPlanModeKind,
  planModeReadOnlyEnforcement: HarnessPlanReadOnlyEnforcement,
  harnessGatewayActive: Schema.Boolean,
  mcpServers: Schema.Array(ThreadContextMcpItem),
  degradedItems: Schema.Array(ThreadContextDegradedItem),
});
export type ThreadContextManifest = typeof ThreadContextManifest.Type;

export const HarnessMcpListInput = Schema.Struct({
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessMcpListInput = typeof HarnessMcpListInput.Type;

export const HarnessMcpUpsertInput = Schema.Struct({
  id: HarnessMcpServerId,
  config: HarnessMcpServerConfig,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessMcpUpsertInput = typeof HarnessMcpUpsertInput.Type;

export const HarnessMcpRemoveInput = Schema.Struct({
  id: HarnessMcpServerId,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessMcpRemoveInput = typeof HarnessMcpRemoveInput.Type;

export const HarnessMcpSetEnabledInput = Schema.Struct({
  id: HarnessMcpServerId,
  enabled: Schema.Boolean,
  expectedDigest: Schema.optionalKey(TrimmedNonEmptyString),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessMcpSetEnabledInput = typeof HarnessMcpSetEnabledInput.Type;

export const HarnessMcpTrustProjectServerInput = Schema.Struct({
  repoRoot: TrimmedNonEmptyString,
  serverId: HarnessMcpServerId,
  digest: TrimmedNonEmptyString,
});
export type HarnessMcpTrustProjectServerInput = typeof HarnessMcpTrustProjectServerInput.Type;

export const HarnessMcpRevokeProjectTrustInput = Schema.Struct({
  repoRoot: TrimmedNonEmptyString,
  serverId: HarnessMcpServerId,
});
export type HarnessMcpRevokeProjectTrustInput = typeof HarnessMcpRevokeProjectTrustInput.Type;

export const HarnessMcpRestartInput = Schema.Struct({
  serverId: HarnessMcpServerId,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessMcpRestartInput = typeof HarnessMcpRestartInput.Type;

export const HarnessMcpLogsInput = Schema.Struct({
  serverId: HarnessMcpServerId,
});
export type HarnessMcpLogsInput = typeof HarnessMcpLogsInput.Type;

export const HarnessMcpScanImportsResult = Schema.Struct({
  sources: Schema.Array(HarnessMcpImportSourcePreview),
});
export type HarnessMcpScanImportsResult = typeof HarnessMcpScanImportsResult.Type;

export const HarnessMcpApplyImportsInput = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      source: HarnessMcpImportSource,
      id: HarnessMcpServerId,
      expectedDigest: Schema.optionalKey(TrimmedNonEmptyString),
      expectedExistingDigest: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
    }),
  ),
  overwriteExisting: Schema.optionalKey(Schema.Boolean),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessMcpApplyImportsInput = typeof HarnessMcpApplyImportsInput.Type;

export const HarnessMcpApplyImportsResult = Schema.Struct({
  importedIds: Schema.Array(HarnessMcpServerId),
  skippedIds: Schema.Array(HarnessMcpServerId),
  snapshot: HarnessMcpSnapshot,
});
export type HarnessMcpApplyImportsResult = typeof HarnessMcpApplyImportsResult.Type;

export const HarnessThreadContextManifestInput = Schema.Struct({
  threadId: ThreadId,
});
export type HarnessThreadContextManifestInput = typeof HarnessThreadContextManifestInput.Type;

export const HarnessErrorCode = Schema.Literals([
  "policy_denied",
  "invalid_config",
  "not_found",
  "untrusted",
  "upstream_error",
  "io_error",
]);
export type HarnessErrorCode = typeof HarnessErrorCode.Type;

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  code: HarnessErrorCode,
  detail: Schema.String,
  serverId: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.detail;
  }
}
