import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";

const HARNESS_SERVER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const HARNESS_ITEM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Default user budget for inline portable harness context (bytes) before whole-block degradation. */
export const DEFAULT_HARNESS_MAX_SYSTEM_CONTEXT_BYTES = 12_000;

/** Sentinel returned for literal env/header values in redacted Harness read models. */
export const HARNESS_SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

/** Built-in T3 / provider slash command names that portable custom commands may never shadow. */
const RESERVED_HARNESS_COMMAND_IDS: ReadonlySet<string> = new Set([
  "plan",
  "default",
  "model",
  "side",
  "btw",
  "clear",
  "compact",
  "compress",
  "login",
  "logout",
  "feedback",
  "goal",
  "help",
  "usage",
  "limits",
  "skill",
]);

export function isReservedHarnessCommandId(id: string): boolean {
  return RESERVED_HARNESS_COMMAND_IDS.has(id.trim().toLowerCase());
}

export const HarnessSkillId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(HARNESS_ITEM_ID_PATTERN),
).annotate({
  description:
    "Stable portable skill directory identifier (letters, digits, underscores, hyphens).",
});
export type HarnessSkillId = typeof HarnessSkillId.Type;

export const HarnessRuleId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(HARNESS_ITEM_ID_PATTERN),
).annotate({
  description: "Stable portable rule file identifier (letters, digits, underscores, hyphens).",
});
export type HarnessRuleId = typeof HarnessRuleId.Type;

export const HarnessCommandId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(HARNESS_ITEM_ID_PATTERN),
  Schema.makeFilter((value: string) => !isReservedHarnessCommandId(value), {
    expected: "a non-reserved slash command identifier",
  }),
).annotate({
  description:
    "Stable portable slash command identifier (letters, digits, underscores, hyphens; cannot shadow built-in commands).",
});
export type HarnessCommandId = typeof HarnessCommandId.Type;

const BUILTIN_HARNESS_MODE_IDS = ["build", "plan", "review", "creator"] as const;
export type BuiltinHarnessModeId = (typeof BUILTIN_HARNESS_MODE_IDS)[number];

export const HarnessModeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(HARNESS_ITEM_ID_PATTERN),
).annotate({
  description:
    "Stable portable Mode identifier (built-in build/plan/review/creator or custom modes/*.md).",
});
export type HarnessModeId = typeof HarnessModeId.Type;

export const HarnessModeScope = Schema.Literals(["builtin", "user"]);
export type HarnessModeScope = typeof HarnessModeScope.Type;

export const HarnessApprovalRuleId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type HarnessApprovalRuleId = typeof HarnessApprovalRuleId.Type;

export const HarnessApprovalRuleScope = Schema.Literals(["session", "always"]);
export type HarnessApprovalRuleScope = typeof HarnessApprovalRuleScope.Type;

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

const HarnessMcpOAuthConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  clientId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  scopes: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).check(
      Schema.isMaxLength(32),
    ),
  ),
  authorizationServerUrl: Schema.optionalKey(HarnessMcpRemoteUrl),
});

export const HarnessMcpHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: HarnessMcpRemoteUrl,
  oauth: Schema.optionalKey(HarnessMcpOAuthConfig),
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
  oauth: Schema.optionalKey(HarnessMcpOAuthConfig),
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

export function supportsHarnessMcpOAuth(config: HarnessMcpServerConfig): boolean {
  const { transport, injectionMode } = config;
  return (
    injectionMode === "gateway" &&
    transport.type !== "stdio" &&
    transport.oauth?.enabled !== false &&
    (transport.oauth?.enabled === true ||
      !Object.keys(transport.headers ?? {}).some((name) => name.toLowerCase() === "authorization"))
  );
}

export const HarnessConfigFile = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  mcpServers: Schema.Record(HarnessMcpServerId, HarnessMcpServerConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  disabledSkills: Schema.Array(HarnessSkillId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  disabledRules: Schema.Array(HarnessRuleId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  disabledCommands: Schema.Array(HarnessCommandId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  disabledModes: Schema.Array(HarnessModeId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  maxSystemContextBytes: Schema.NullOr(PositiveInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type HarnessConfigFile = typeof HarnessConfigFile.Type;

/** Checked-in project harness configuration inside `t3.json`. */
export const ProjectHarnessConfig = Schema.Struct({
  mcpServers: Schema.optionalKey(Schema.Record(HarnessMcpServerId, HarnessMcpServerConfig)),
  disabledMcpServers: Schema.optionalKey(Schema.Array(HarnessMcpServerId)),
  disabledSkills: Schema.optionalKey(Schema.Array(HarnessSkillId)),
  disabledRules: Schema.optionalKey(Schema.Array(HarnessRuleId)),
  disabledCommands: Schema.optionalKey(Schema.Array(HarnessCommandId)),
  disabledModes: Schema.optionalKey(Schema.Array(HarnessModeId)),
}).annotate({
  description:
    "Project-scoped portable harness configuration (MCP servers, skills, rules, commands, modes overrides). Stdio servers require explicit owner trust confirmation before execution.",
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
  "auth_required",
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
  estimatedToolListBytes: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  needsTrustConfirmation: Schema.Boolean,
  trustReason: Schema.NullOr(HarnessMcpTrustReason),
  requiresSecretAccess: Schema.Boolean,
  trustDigest: Schema.NullOr(Schema.String),
  repoRoot: Schema.NullOr(Schema.String),
  overriddenByProject: Schema.Boolean,
  stderrLinesCount: NonNegativeInt,
  oauthStatus: Schema.optionalKey(Schema.Literals(["required", "connected", "expired"])),
  oauthExpiresAt: Schema.optionalKey(IsoDateTime),
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

export const HarnessRuleApplyMode = Schema.Literals(["always", "glob", "manual"]);
export type HarnessRuleApplyMode = typeof HarnessRuleApplyMode.Type;

export const HarnessAgentsMdView = Schema.Struct({
  scope: HarnessMcpServerScope,
  path: Schema.String,
  exists: Schema.Boolean,
  contentDigest: Schema.String,
  bytes: NonNegativeInt,
  body: Schema.String,
});
export type HarnessAgentsMdView = typeof HarnessAgentsMdView.Type;

export const HarnessSkillEntry = Schema.Struct({
  id: HarnessSkillId,
  name: TrimmedNonEmptyString,
  scope: HarnessMcpServerScope,
  description: Schema.optionalKey(Schema.String),
  shortDescription: Schema.optionalKey(Schema.String),
  userInvocable: Schema.Boolean,
  userInvocationOnly: Schema.Boolean,
  enabled: Schema.Boolean,
  effectiveEnabled: Schema.Boolean,
  overriddenByProject: Schema.Boolean,
  sourcePath: Schema.String,
  contentDigest: Schema.String,
  bytes: NonNegativeInt,
  body: Schema.String,
  origin: Schema.optionalKey(HarnessMcpOrigin),
});
export type HarnessSkillEntry = typeof HarnessSkillEntry.Type;

export const HarnessRuleEntry = Schema.Struct({
  id: HarnessRuleId,
  scope: HarnessMcpServerScope,
  description: Schema.optionalKey(Schema.String),
  apply: HarnessRuleApplyMode,
  globs: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  effectiveEnabled: Schema.Boolean,
  overriddenByProject: Schema.Boolean,
  sourcePath: Schema.String,
  contentDigest: Schema.String,
  bytes: NonNegativeInt,
  body: Schema.String,
  origin: Schema.optionalKey(HarnessMcpOrigin),
});
export type HarnessRuleEntry = typeof HarnessRuleEntry.Type;

export const HarnessCommandEntry = Schema.Struct({
  id: HarnessCommandId,
  name: TrimmedNonEmptyString,
  scope: HarnessMcpServerScope,
  description: Schema.optionalKey(Schema.String),
  argumentHint: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  effectiveEnabled: Schema.Boolean,
  overriddenByProject: Schema.Boolean,
  sourcePath: Schema.String,
  contentDigest: Schema.String,
  bytes: NonNegativeInt,
  body: Schema.String,
  origin: Schema.optionalKey(HarnessMcpOrigin),
});
export type HarnessCommandEntry = typeof HarnessCommandEntry.Type;

export const HarnessModeEntry = Schema.Struct({
  id: HarnessModeId,
  name: TrimmedNonEmptyString,
  scope: HarnessModeScope,
  overriddenBuiltin: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  baseInteractionMode: ProviderInteractionMode,
  readonly: Schema.Boolean,
  proposePlan: Schema.Boolean,
  defaultModel: Schema.optionalKey(TrimmedNonEmptyString),
  allowedMcpServers: Schema.optionalKey(Schema.Array(HarnessMcpServerId)),
  disabledMcpServers: Schema.optionalKey(Schema.Array(HarnessMcpServerId)),
  includedRules: Schema.optionalKey(Schema.Array(HarnessRuleId)),
  includedSkills: Schema.optionalKey(Schema.Array(HarnessSkillId)),
  enabled: Schema.Boolean,
  effectiveEnabled: Schema.Boolean,
  overriddenByProject: Schema.Boolean,
  sourcePath: Schema.NullOr(Schema.String),
  contentDigest: Schema.String,
  bytes: NonNegativeInt,
  body: Schema.String,
});
export type HarnessModeEntry = typeof HarnessModeEntry.Type;

export const HarnessModeUpsertInput = Schema.Struct({
  id: HarnessModeId,
  overrideBuiltin: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  baseInteractionMode: ProviderInteractionMode,
  readonly: Schema.optionalKey(Schema.Boolean),
  proposePlan: Schema.optionalKey(Schema.Boolean),
  defaultModel: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  allowedMcpServers: Schema.optionalKey(Schema.Array(HarnessMcpServerId)),
  disabledMcpServers: Schema.optionalKey(Schema.Array(HarnessMcpServerId)),
  includedRules: Schema.optionalKey(Schema.Array(HarnessRuleId)),
  includedSkills: Schema.optionalKey(Schema.Array(HarnessSkillId)),
  enabled: Schema.optionalKey(Schema.Boolean),
  body: Schema.String.check(Schema.isMaxLength(262_144)),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessModeUpsertInput = typeof HarnessModeUpsertInput.Type;

export const HarnessModeRemoveInput = Schema.Struct({
  id: HarnessModeId,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessModeRemoveInput = typeof HarnessModeRemoveInput.Type;

export const HarnessModeSetEnabledInput = Schema.Struct({
  id: HarnessModeId,
  enabled: Schema.Boolean,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessModeSetEnabledInput = typeof HarnessModeSetEnabledInput.Type;

/** Audited native `allow_always` / session approval rule recorded for visibility and revocation. */
export const HarnessApprovalRuleRecord = Schema.Struct({
  id: HarnessApprovalRuleId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  requestKind: Schema.String,
  scope: HarnessApprovalRuleScope,
  summary: Schema.String,
  appName: Schema.optionalKey(Schema.String),
  workspaceRoot: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type HarnessApprovalRuleRecord = typeof HarnessApprovalRuleRecord.Type;

export const HarnessApprovalRulesListInput = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  includeRevoked: Schema.optionalKey(Schema.Boolean),
});
export type HarnessApprovalRulesListInput = typeof HarnessApprovalRulesListInput.Type;

export const HarnessApprovalRulesListResult = Schema.Struct({
  rules: Schema.Array(HarnessApprovalRuleRecord),
});
export type HarnessApprovalRulesListResult = typeof HarnessApprovalRulesListResult.Type;

export const HarnessApprovalRuleRevokeInput = Schema.Struct({
  id: HarnessApprovalRuleId,
  detachThreadSession: Schema.optionalKey(Schema.Boolean),
});
export type HarnessApprovalRuleRevokeInput = typeof HarnessApprovalRuleRevokeInput.Type;

export const HarnessApprovalRuleRevokeResult = Schema.Struct({
  rule: HarnessApprovalRuleRecord,
  sessionDetached: Schema.Boolean,
  note: Schema.String,
});
export type HarnessApprovalRuleRevokeResult = typeof HarnessApprovalRuleRevokeResult.Type;

export const HarnessLibrarySnapshot = Schema.Struct({
  harnessDir: Schema.String,
  workspaceRoot: Schema.NullOr(Schema.String),
  userAgentsMd: HarnessAgentsMdView,
  projectAgentsMd: Schema.NullOr(HarnessAgentsMdView),
  skills: Schema.Array(HarnessSkillEntry),
  rules: Schema.Array(HarnessRuleEntry),
  commands: Schema.Array(HarnessCommandEntry),
  modes: Schema.Array(HarnessModeEntry).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  maxSystemContextBytes: PositiveInt,
  invalidEntries: Schema.Array(HarnessInvalidEntry),
  managedPolicyAllowsHarness: Schema.Boolean,
  managedPolicyOrganization: Schema.NullOr(Schema.String),
});
export type HarnessLibrarySnapshot = typeof HarnessLibrarySnapshot.Type;

export const HarnessLibrarySnapshotInput = Schema.Struct({
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessLibrarySnapshotInput = typeof HarnessLibrarySnapshotInput.Type;

export const HarnessAgentsMdSaveInput = Schema.Struct({
  body: Schema.String.check(Schema.isMaxLength(262_144)),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessAgentsMdSaveInput = typeof HarnessAgentsMdSaveInput.Type;

export const HarnessSkillUpsertInput = Schema.Struct({
  id: HarnessSkillId,
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  shortDescription: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  userInvocable: Schema.optionalKey(Schema.Boolean),
  userInvocationOnly: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.Boolean),
  body: Schema.String.check(Schema.isMaxLength(262_144)),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessSkillUpsertInput = typeof HarnessSkillUpsertInput.Type;

export const HarnessSkillRemoveInput = Schema.Struct({
  id: HarnessSkillId,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessSkillRemoveInput = typeof HarnessSkillRemoveInput.Type;

export const HarnessSkillSetEnabledInput = Schema.Struct({
  id: HarnessSkillId,
  enabled: Schema.Boolean,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessSkillSetEnabledInput = typeof HarnessSkillSetEnabledInput.Type;

export const HarnessRuleUpsertInput = Schema.Struct({
  id: HarnessRuleId,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  apply: HarnessRuleApplyMode,
  globs: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256)))),
  enabled: Schema.optionalKey(Schema.Boolean),
  body: Schema.String.check(Schema.isMaxLength(262_144)),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessRuleUpsertInput = typeof HarnessRuleUpsertInput.Type;

export const HarnessRuleRemoveInput = Schema.Struct({
  id: HarnessRuleId,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessRuleRemoveInput = typeof HarnessRuleRemoveInput.Type;

export const HarnessRuleSetEnabledInput = Schema.Struct({
  id: HarnessRuleId,
  enabled: Schema.Boolean,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessRuleSetEnabledInput = typeof HarnessRuleSetEnabledInput.Type;

export const HarnessCommandUpsertInput = Schema.Struct({
  id: HarnessCommandId,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  argumentHint: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  enabled: Schema.optionalKey(Schema.Boolean),
  body: Schema.String.check(Schema.isMaxLength(262_144)),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessCommandUpsertInput = typeof HarnessCommandUpsertInput.Type;

export const HarnessCommandRemoveInput = Schema.Struct({
  id: HarnessCommandId,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessCommandRemoveInput = typeof HarnessCommandRemoveInput.Type;

export const HarnessCommandSetEnabledInput = Schema.Struct({
  id: HarnessCommandId,
  enabled: Schema.Boolean,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessCommandSetEnabledInput = typeof HarnessCommandSetEnabledInput.Type;

export const HarnessSettingsUpdateInput = Schema.Struct({
  maxSystemContextBytes: Schema.NullOr(PositiveInt),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessSettingsUpdateInput = typeof HarnessSettingsUpdateInput.Type;

export const HarnessLibraryImportKind = Schema.Literals(["skill", "rule", "command", "agents_md"]);
export type HarnessLibraryImportKind = typeof HarnessLibraryImportKind.Type;

export const HarnessLibraryImportCandidate = Schema.Struct({
  kind: HarnessLibraryImportKind,
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
  sourcePath: Schema.String,
  previewDigest: Schema.String,
  existingDigest: Schema.optionalKey(Schema.NullOr(Schema.String)),
  conflict: HarnessMcpImportConflict,
  bytes: NonNegativeInt,
  summary: Schema.String,
});
export type HarnessLibraryImportCandidate = typeof HarnessLibraryImportCandidate.Type;

export const HarnessLibraryImportSourcePreview = Schema.Struct({
  source: HarnessMcpImportSource,
  found: Schema.Boolean,
  candidates: Schema.Array(HarnessLibraryImportCandidate),
  warnings: Schema.Array(Schema.String),
});
export type HarnessLibraryImportSourcePreview = typeof HarnessLibraryImportSourcePreview.Type;

export const HarnessLibraryScanImportsInput = Schema.Struct({
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessLibraryScanImportsInput = typeof HarnessLibraryScanImportsInput.Type;

export const HarnessLibraryScanImportsResult = Schema.Struct({
  sources: Schema.Array(HarnessLibraryImportSourcePreview),
});
export type HarnessLibraryScanImportsResult = typeof HarnessLibraryScanImportsResult.Type;

export const HarnessLibraryApplyImportsInput = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      source: HarnessMcpImportSource,
      kind: HarnessLibraryImportKind,
      id: TrimmedNonEmptyString,
      expectedDigest: Schema.optionalKey(TrimmedNonEmptyString),
      expectedExistingDigest: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
    }),
  ),
  overwriteExisting: Schema.optionalKey(Schema.Boolean),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessLibraryApplyImportsInput = typeof HarnessLibraryApplyImportsInput.Type;

export const HarnessLibraryApplyImportsResult = Schema.Struct({
  importedKeys: Schema.Array(Schema.String),
  skippedKeys: Schema.Array(Schema.String),
  snapshot: HarnessLibrarySnapshot,
});
export type HarnessLibraryApplyImportsResult = typeof HarnessLibraryApplyImportsResult.Type;

export const HarnessExportTarget = Schema.Literals(["codex", "claude", "cursor"]);
export type HarnessExportTarget = typeof HarnessExportTarget.Type;

export const HarnessExportSection = Schema.Literals(["mcp", "skills", "rules", "commands"]);
export type HarnessExportSection = typeof HarnessExportSection.Type;

export const HarnessExportFileAction = Schema.Literals(["create", "update", "unchanged"]);
export type HarnessExportFileAction = typeof HarnessExportFileAction.Type;

export const HarnessExportPreviewFile = Schema.Struct({
  targetPath: Schema.String,
  action: HarnessExportFileAction,
  section: HarnessExportSection,
  itemId: Schema.String,
  bytes: NonNegativeInt,
  previewSnippet: Schema.String,
  hasSecretPlaceholders: Schema.Boolean,
});
export type HarnessExportPreviewFile = typeof HarnessExportPreviewFile.Type;

export const HarnessExportPreviewInput = Schema.Struct({
  target: HarnessExportTarget,
  sections: Schema.optionalKey(Schema.Array(HarnessExportSection)),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessExportPreviewInput = typeof HarnessExportPreviewInput.Type;

export const HarnessExportPreviewResult = Schema.Struct({
  target: HarnessExportTarget,
  planDigest: Schema.String,
  files: Schema.Array(HarnessExportPreviewFile),
  warnings: Schema.Array(Schema.String),
});
export type HarnessExportPreviewResult = typeof HarnessExportPreviewResult.Type;

export const HarnessExportApplyInput = Schema.Struct({
  target: HarnessExportTarget,
  sections: Schema.optionalKey(Schema.Array(HarnessExportSection)),
  planDigest: TrimmedNonEmptyString,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HarnessExportApplyInput = typeof HarnessExportApplyInput.Type;

export const HarnessExportApplyResult = Schema.Struct({
  target: HarnessExportTarget,
  writtenPaths: Schema.Array(Schema.String),
  skippedPaths: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
});
export type HarnessExportApplyResult = typeof HarnessExportApplyResult.Type;

export const ThreadContextSkillItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scope: HarnessMcpServerScope,
  channel: Schema.Literals(["native-mount", "gateway", "deduplicated", "disabled"]),
  bytes: NonNegativeInt,
  reason: Schema.optionalKey(Schema.String),
});
export type ThreadContextSkillItem = typeof ThreadContextSkillItem.Type;

export const ThreadContextRuleItem = Schema.Struct({
  id: Schema.String,
  scope: HarnessMcpServerScope,
  apply: HarnessRuleApplyMode,
  status: Schema.Literals(["inlined", "on-demand", "degraded", "deduplicated", "disabled"]),
  bytes: NonNegativeInt,
  reason: Schema.optionalKey(Schema.String),
});
export type ThreadContextRuleItem = typeof ThreadContextRuleItem.Type;

export const ThreadContextTokenUsage = Schema.Struct({
  usedTokens: NonNegativeInt,
  maxTokens: Schema.NullOr(PositiveInt),
  autoCompactThreshold: Schema.NullOr(PositiveInt),
});
export type ThreadContextTokenUsage = typeof ThreadContextTokenUsage.Type;

export const ThreadContextDegradedItem = Schema.Struct({
  kind: Schema.Literals(["mcp", "plan", "skill", "rule", "mode"]),
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
  modeId: Schema.optionalKey(HarnessModeId),
  modeName: Schema.optionalKey(Schema.String),
  modeDigest: Schema.optionalKey(Schema.String),
  modeReadOnly: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  planModeSource: HarnessPlanModeKind,
  planModeReadOnlyEnforcement: HarnessPlanReadOnlyEnforcement,
  harnessGatewayActive: Schema.Boolean,
  mcpServers: Schema.Array(ThreadContextMcpItem),
  skills: Schema.Array(ThreadContextSkillItem).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  rules: Schema.Array(ThreadContextRuleItem).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  commandsCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  contextBudgetBytes: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  contextUsedBytes: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  scaffoldBytes: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  tokenUsage: Schema.NullOr(ThreadContextTokenUsage).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  approvalRulesCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
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

export const HarnessMcpOAuthStartResult = Schema.Struct({ authorizationUrl: Schema.String });
export const HarnessMcpOAuthCompleteInput = Schema.Struct({
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
  serverId: Schema.optionalKey(HarnessMcpServerId),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});

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

export const HarnessPluginId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
).pipe(Schema.brand("HarnessPluginId"));
export type HarnessPluginId = typeof HarnessPluginId.Type;

export const HarnessPluginFormat = Schema.Literals(["t3-plugin", "claude-plugin"]);
export type HarnessPluginFormat = typeof HarnessPluginFormat.Type;

export const HarnessPluginTrustStatus = Schema.Literals(["trusted", "untrusted", "digest_changed"]);
export type HarnessPluginTrustStatus = typeof HarnessPluginTrustStatus.Type;

export const HarnessPluginView = Schema.Struct({
  id: HarnessPluginId,
  name: Schema.String,
  version: Schema.String,
  description: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  format: HarnessPluginFormat,
  sourcePath: Schema.String,
  contentDigest: Schema.String,
  trustedDigest: Schema.NullOr(Schema.String),
  trustStatus: HarnessPluginTrustStatus,
  enabled: Schema.Boolean,
  active: Schema.Boolean,
  hasCommandHooks: Schema.Boolean,
  hasStdioMcp: Schema.Boolean,
  skillIds: Schema.Array(Schema.String),
  ruleIds: Schema.Array(Schema.String),
  commandIds: Schema.Array(Schema.String),
  modeIds: Schema.Array(Schema.String),
  hookIds: Schema.Array(Schema.String),
  mcpServerIds: Schema.Array(Schema.String),
  workflowFiles: Schema.Array(Schema.String),
  entrypoint: Schema.optionalKey(Schema.String),
  toolNames: Schema.optionalKey(Schema.Array(Schema.String)),
  lastError: Schema.NullOr(Schema.String),
});
export type HarnessPluginView = typeof HarnessPluginView.Type;

export const HarnessPluginsSnapshot = Schema.Struct({
  pluginsDir: Schema.String,
  plugins: Schema.Array(HarnessPluginView),
  managedPolicyAllowsHarness: Schema.Boolean,
  managedPolicyOrganization: Schema.NullOr(Schema.String),
});
export type HarnessPluginsSnapshot = typeof HarnessPluginsSnapshot.Type;

export const HarnessPluginInstallInput = Schema.Struct({
  sourcePath: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  id: Schema.optionalKey(HarnessPluginId),
  trustOnInstall: Schema.optionalKey(Schema.Boolean),
});
export type HarnessPluginInstallInput = typeof HarnessPluginInstallInput.Type;

export const HarnessPluginTrustInput = Schema.Struct({
  id: HarnessPluginId,
  expectedDigest: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type HarnessPluginTrustInput = typeof HarnessPluginTrustInput.Type;

export const HarnessPluginSetEnabledInput = Schema.Struct({
  id: HarnessPluginId,
  enabled: Schema.Boolean,
});
export type HarnessPluginSetEnabledInput = typeof HarnessPluginSetEnabledInput.Type;

export const HarnessPluginRemoveInput = Schema.Struct({
  id: HarnessPluginId,
});
export type HarnessPluginRemoveInput = typeof HarnessPluginRemoveInput.Type;

export const HarnessPluginReloadInput = Schema.Struct({
  id: Schema.optionalKey(HarnessPluginId),
});
export type HarnessPluginReloadInput = typeof HarnessPluginReloadInput.Type;

export const HarnessHookId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
).pipe(Schema.brand("HarnessHookId"));
export type HarnessHookId = typeof HarnessHookId.Type;

export const HarnessHookEvent = Schema.Literals([
  "turn.beforeStart",
  "thread.created",
  "turn.completed",
  "run.settled",
  "checkpoint.created",
  "PreToolUse",
  "PostToolUse",
]);
export type HarnessHookEvent = typeof HarnessHookEvent.Type;

export const HarnessHookCommandTarget = Schema.Struct({
  type: Schema.Literal("command"),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  args: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(1024)))),
  cwd: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type HarnessHookCommandTarget = typeof HarnessHookCommandTarget.Type;

export const HarnessHookHttpTarget = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type HarnessHookHttpTarget = typeof HarnessHookHttpTarget.Type;

export const HarnessHookTarget = Schema.Union([HarnessHookCommandTarget, HarnessHookHttpTarget]);
export type HarnessHookTarget = typeof HarnessHookTarget.Type;

export const HarnessHookSource = Schema.Literals(["user", "plugin"]);
export type HarnessHookSource = typeof HarnessHookSource.Type;

export const HarnessHookDefinition = Schema.Struct({
  id: HarnessHookId,
  event: HarnessHookEvent,
  enabled: Schema.Boolean,
  matcher: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  timeoutMs: Schema.optionalKey(PositiveInt),
  failClosed: Schema.optionalKey(Schema.Boolean),
  target: HarnessHookTarget,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  source: HarnessHookSource,
  pluginId: Schema.optionalKey(HarnessPluginId),
});
export type HarnessHookDefinition = typeof HarnessHookDefinition.Type;

export const HarnessHooksSnapshot = Schema.Struct({
  hooksPath: Schema.String,
  hooks: Schema.Array(HarnessHookDefinition),
  managedPolicyAllowsHarness: Schema.Boolean,
});
export type HarnessHooksSnapshot = typeof HarnessHooksSnapshot.Type;

export const HarnessHookUpsertInput = Schema.Struct({
  id: HarnessHookId,
  event: HarnessHookEvent,
  enabled: Schema.optionalKey(Schema.Boolean),
  matcher: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  timeoutMs: Schema.optionalKey(PositiveInt),
  failClosed: Schema.optionalKey(Schema.Boolean),
  target: HarnessHookTarget,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
});
export type HarnessHookUpsertInput = typeof HarnessHookUpsertInput.Type;

export const HarnessHookRemoveInput = Schema.Struct({
  id: HarnessHookId,
});
export type HarnessHookRemoveInput = typeof HarnessHookRemoveInput.Type;

export const HarnessHookSetEnabledInput = Schema.Struct({
  id: HarnessHookId,
  enabled: Schema.Boolean,
});
export type HarnessHookSetEnabledInput = typeof HarnessHookSetEnabledInput.Type;

export const HarnessHookTestInput = Schema.Struct({
  id: HarnessHookId,
  samplePayload: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type HarnessHookTestInput = typeof HarnessHookTestInput.Type;

export const HarnessHookExecutionResult = Schema.Struct({
  hookId: HarnessHookId,
  event: HarnessHookEvent,
  ok: Schema.Boolean,
  blocked: Schema.Boolean,
  blockReason: Schema.optionalKey(Schema.String),
  injectedContext: Schema.optionalKey(Schema.String),
  durationMs: NonNegativeInt,
  timedOut: Schema.Boolean,
  stdout: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type HarnessHookExecutionResult = typeof HarnessHookExecutionResult.Type;

export const HarnessWorkflowStepKind = Schema.Literals(["in-thread", "child"]);
export type HarnessWorkflowStepKind = typeof HarnessWorkflowStepKind.Type;

export const HarnessWorkflowStepFailurePolicy = Schema.Literals(["fail", "continue", "pause"]);
export type HarnessWorkflowStepFailurePolicy = typeof HarnessWorkflowStepFailurePolicy.Type;

export const HarnessWorkflowStepSpec = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.optionalKey(Schema.String),
  kind: HarnessWorkflowStepKind,
  prompt: Schema.String,
  modeId: Schema.optionalKey(HarnessModeId),
  dependsOn: Schema.Array(TrimmedNonEmptyString),
  timeoutSeconds: Schema.optionalKey(PositiveInt),
  onFailure: HarnessWorkflowStepFailurePolicy,
});
export type HarnessWorkflowStepSpec = typeof HarnessWorkflowStepSpec.Type;

export const HarnessWorkflowValidationIssue = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  path: Schema.String,
  message: Schema.String,
});
export type HarnessWorkflowValidationIssue = typeof HarnessWorkflowValidationIssue.Type;

export const HarnessWorkflowValidateInput = Schema.Struct({
  yaml: Schema.String.check(Schema.isMaxLength(262_144)),
});
export type HarnessWorkflowValidateInput = typeof HarnessWorkflowValidateInput.Type;

export const HarnessWorkflowValidateResult = Schema.Struct({
  valid: Schema.Boolean,
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(PositiveInt),
  description: Schema.optionalKey(Schema.String),
  steps: Schema.Array(HarnessWorkflowStepSpec),
  executionOrder: Schema.Array(Schema.String),
  issues: Schema.Array(HarnessWorkflowValidationIssue),
  compiledPreview: Schema.optionalKey(Schema.String),
});
export type HarnessWorkflowValidateResult = typeof HarnessWorkflowValidateResult.Type;

export const HarnessMemoryId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
).pipe(Schema.brand("HarnessMemoryId"));
export type HarnessMemoryId = typeof HarnessMemoryId.Type;

export const HarnessMemoryEntry = Schema.Struct({
  id: HarnessMemoryId,
  title: TrimmedNonEmptyString,
  tags: Schema.Array(TrimmedNonEmptyString),
  pinned: Schema.Boolean,
  body: Schema.String,
  bytes: NonNegativeInt,
  sourcePath: Schema.String,
  updatedAt: IsoDateTime,
});
export type HarnessMemoryEntry = typeof HarnessMemoryEntry.Type;

export const HarnessMemorySnapshot = Schema.Struct({
  memoryDir: Schema.String,
  entries: Schema.Array(HarnessMemoryEntry),
  managedPolicyAllowsHarness: Schema.Boolean,
});
export type HarnessMemorySnapshot = typeof HarnessMemorySnapshot.Type;

export const HarnessMemoryUpsertInput = Schema.Struct({
  id: HarnessMemoryId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  tags: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(48)))),
  pinned: Schema.optionalKey(Schema.Boolean),
  body: Schema.String.check(Schema.isMaxLength(262_144)),
});
export type HarnessMemoryUpsertInput = typeof HarnessMemoryUpsertInput.Type;

export const HarnessMemoryRemoveInput = Schema.Struct({
  id: HarnessMemoryId,
});
export type HarnessMemoryRemoveInput = typeof HarnessMemoryRemoveInput.Type;

export const HarnessSyncSecretFinding = Schema.Struct({
  path: Schema.String,
  line: PositiveInt,
  rule: Schema.String,
  preview: Schema.String,
});
export type HarnessSyncSecretFinding = typeof HarnessSyncSecretFinding.Type;

export const HarnessSyncDiffFile = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["added", "modified", "deleted", "untracked"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type HarnessSyncDiffFile = typeof HarnessSyncDiffFile.Type;

export const HarnessSyncStatus = Schema.Struct({
  harnessDir: Schema.String,
  initialized: Schema.Boolean,
  branch: Schema.NullOr(Schema.String),
  remoteUrl: Schema.NullOr(Schema.String),
  dirtyCount: NonNegativeInt,
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  secretFindings: Schema.Array(HarnessSyncSecretFinding),
  canPush: Schema.Boolean,
  managedPolicyAllowsHarness: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
});
export type HarnessSyncStatus = typeof HarnessSyncStatus.Type;

export const HarnessSyncConfigureInput = Schema.Struct({
  remoteUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  branch: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type HarnessSyncConfigureInput = typeof HarnessSyncConfigureInput.Type;

export const HarnessSyncPreviewPushResult = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  remoteUrl: Schema.NullOr(Schema.String),
  previewTreeDigest: Schema.NullOr(Schema.String),
  files: Schema.Array(HarnessSyncDiffFile),
  secretFindings: Schema.Array(HarnessSyncSecretFinding),
  canPush: Schema.Boolean,
  diffSummary: Schema.String,
});
export type HarnessSyncPreviewPushResult = typeof HarnessSyncPreviewPushResult.Type;

export const HarnessSyncPushInput = Schema.Struct({
  commitMessage: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  expectedRemoteUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  expectedBranch: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  expectedTreeDigest: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type HarnessSyncPushInput = typeof HarnessSyncPushInput.Type;

export const HarnessSyncPushResult = Schema.Struct({
  committed: Schema.Boolean,
  pushed: Schema.Boolean,
  commitSha: Schema.optionalKey(Schema.String),
  filesCommitted: NonNegativeInt,
  summary: Schema.String,
});
export type HarnessSyncPushResult = typeof HarnessSyncPushResult.Type;

export const HarnessSyncPullInput = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
});
export type HarnessSyncPullInput = typeof HarnessSyncPullInput.Type;

export const HarnessSyncPullConflict = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["modified_both", "deleted_upstream_modified_locally", "added_both"]),
});
export type HarnessSyncPullConflict = typeof HarnessSyncPullConflict.Type;

export const HarnessSyncPullResult = Schema.Struct({
  pulled: Schema.Boolean,
  updatedFiles: Schema.Array(Schema.String),
  skippedFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  conflicts: Schema.optionalKey(Schema.Array(HarnessSyncPullConflict)),
  summary: Schema.String,
});
export type HarnessSyncPullResult = typeof HarnessSyncPullResult.Type;

export const HarnessErrorCode = Schema.Literals([
  "policy_denied",
  "invalid_config",
  "not_found",
  "untrusted",
  "upstream_error",
  "io_error",
  "auth_required",
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
