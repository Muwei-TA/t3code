// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous SHA-256 digest for trust verification and config fingerprinting.
import * as NodeCrypto from "node:crypto";
import {
  DEFAULT_HARNESS_MAX_SYSTEM_CONTEXT_BYTES,
  HarnessCommandId,
  HarnessConfigFile,
  HarnessError,
  type HarnessInvalidEntry,
  HarnessMcpServerConfig,
  HarnessMcpServerId,
  type HarnessMcpServerScope,
  type HarnessMcpTrustReason,
  HarnessModeId,
  HarnessRuleId,
  HarnessSkillId,
  IsoDateTime,
  isReservedHarnessCommandId,
  isReservedHarnessMcpServerId,
  type ManagedPolicyLimits,
  PositiveInt,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  configContainsSecretPlaceholder,
  mergeRedactedConfigWithExisting,
} from "./HarnessSecrets.ts";

const HARNESS_CONFIG_FILENAME = "harness.json";

const HarnessTrustEntry = Schema.Struct({
  repoRoot: Schema.String,
  serverId: HarnessMcpServerId,
  digest: Schema.String,
  trustedAt: IsoDateTime,
});
type HarnessTrustEntry = typeof HarnessTrustEntry.Type;

const HarnessTrustLedgerFile = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  entries: Schema.Array(HarnessTrustEntry).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

const decodeHarnessConfigJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HarnessConfigFile),
);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownLenientJson = Schema.decodeUnknownEffect(fromLenientJson(Schema.Unknown));
const encodeHarnessConfigJson = Schema.encodeEffect(HarnessConfigFile);
const decodeServerEntry = Schema.decodeUnknownOption(HarnessMcpServerConfig);
const decodeServerId = Schema.decodeUnknownOption(HarnessMcpServerId);
const decodeSkillId = Schema.decodeUnknownOption(HarnessSkillId);
const decodeRuleId = Schema.decodeUnknownOption(HarnessRuleId);
const decodeCommandId = Schema.decodeUnknownOption(HarnessCommandId);
const decodeModeId = Schema.decodeUnknownOption(HarnessModeId);
const decodePositiveInt = Schema.decodeUnknownOption(PositiveInt);
const decodeTrustLedgerJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HarnessTrustLedgerFile),
);
const encodeTrustLedger = Schema.encodeEffect(HarnessTrustLedgerFile);

const EMPTY_USER_HARNESS_CONFIG: HarnessConfigFile = {
  schemaVersion: 1,
  mcpServers: {},
  disabledSkills: [],
  disabledRules: [],
  disabledCommands: [],
  disabledModes: [],
  maxSystemContextBytes: null,
};

function formatPrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface ResolvedHarnessMcpServer {
  readonly pluginId?: string;
  readonly id: HarnessMcpServerId;
  readonly scope: HarnessMcpServerScope;
  readonly config: HarnessMcpServerConfig;
  readonly configDigest: string;
  readonly effectiveEnabled: boolean;
  readonly trusted: boolean;
  readonly needsTrustConfirmation: boolean;
  readonly trustReason: HarnessMcpTrustReason | null;
  readonly requiresSecretAccess: boolean;
  readonly trustDigest: string | null;
  readonly repoRoot: string | null;
  readonly overriddenByProject: boolean;
  readonly blockedByPolicyReason: string | null;
}

export interface LoadedUserHarnessConfig {
  readonly config: HarnessConfigFile;
  readonly invalidEntries: ReadonlyArray<HarnessInvalidEntry>;
}

export interface ResolvedWorkspaceHarness {
  readonly harnessDir: string;
  readonly configPath: string;
  readonly workspaceRoot: string | null;
  readonly servers: ReadonlyArray<ResolvedHarnessMcpServer>;
  readonly invalidEntries: ReadonlyArray<HarnessInvalidEntry>;
  readonly managedPolicyAllowsHarness: boolean;
  readonly managedPolicyAllowsStdio: boolean;
  readonly managedPolicyOrganization: string | null;
}

function trustReasonForProjectServer(config: HarnessMcpServerConfig): HarnessMcpTrustReason {
  const isStdio = config.transport.type === "stdio";
  const usesSecrets = configContainsSecretPlaceholder(config);
  if (isStdio && usesSecrets) return "stdio_and_secrets";
  if (isStdio) return "stdio";
  if (usesSecrets) return "secrets";
  return "project";
}

export function canonicalMcpTransport(transport: HarnessMcpServerConfig["transport"]) {
  return transport.type === "stdio"
    ? {
        type: "stdio",
        command: transport.command,
        args: transport.args ?? [],
        cwd: transport.cwd ?? null,
        env: transport.env
          ? Object.entries(transport.env).sort(([a], [b]) => a.localeCompare(b))
          : [],
      }
    : {
        type: transport.type,
        url: transport.url,
        headers: transport.headers
          ? Object.entries(transport.headers).sort(([a], [b]) => a.localeCompare(b))
          : [],
        ...(transport.oauth === undefined ? {} : { oauth: transport.oauth }),
      };
}

/**
 * Binds owner trust for a checked-in `t3.json` server to its full execution channel,
 * destination URL/command/args/cwd/env/headers, and tool approval policy.
 */
function computeProjectTrustDigest(config: HarnessMcpServerConfig): string {
  const canonical = JSON.stringify({
    version: 2,
    injectionMode: config.injectionMode,
    approvalPolicy: config.approvalPolicy,
    allowedTools: config.allowedTools ?? null,
    disabledTools: config.disabledTools ?? null,
    transport: canonicalMcpTransport(config.transport),
  });
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex");
}

const validateToolFilters = Effect.fn("HarnessStore.validateToolFilters")(function* (
  id: HarnessMcpServerId,
  config: HarnessMcpServerConfig,
) {
  const disabled = new Set(config.disabledTools);
  const conflicts = [...new Set(config.allowedTools)].filter((name) => disabled.has(name));
  if (conflicts.length > 0) {
    return yield* new HarnessError({
      code: "invalid_config",
      serverId: id,
      detail: `Tools cannot be both allowed and disabled: ${conflicts.join(", ")}.`,
    });
  }
});

export function computeCanonicalConfigFingerprint(config: HarnessMcpServerConfig): string {
  return JSON.stringify({
    enabled: config.enabled,
    description: config.description ?? null,
    origin: config.origin ?? null,
    trustDigest: computeProjectTrustDigest(config),
  });
}

/** Leniently reads a raw JSON object so one bad server entry never breaks the rest of harness.json. */
function decodeUserConfigLeniently(
  rawText: string,
  configPath: string,
): Effect.Effect<LoadedUserHarnessConfig> {
  return decodeHarnessConfigJson(rawText).pipe(
    Effect.map((config): LoadedUserHarnessConfig => ({ config, invalidEntries: [] })),
    Effect.catch(() =>
      decodeUnknownJson(rawText).pipe(
        Effect.match({
          onFailure: (): LoadedUserHarnessConfig => ({
            config: EMPTY_USER_HARNESS_CONFIG,
            invalidEntries: [
              {
                source: configPath,
                id: null,
                message: "Malformed JSON in harness.json.",
              },
            ],
          }),
          onSuccess: (parsed): LoadedUserHarnessConfig => {
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              return {
                config: EMPTY_USER_HARNESS_CONFIG,
                invalidEntries: [
                  {
                    source: configPath,
                    id: null,
                    message: "Expected a JSON object in harness.json.",
                  },
                ],
              };
            }
            return decodePartialUserConfigObject(parsed as Record<string, unknown>, configPath);
          },
        }),
      ),
    ),
  );
}

function decodeIdList<Id extends string>(
  raw: unknown,
  decode: (value: unknown) => Option.Option<Id>,
): ReadonlyArray<Id> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Id> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const decoded = decode(item);
    if (Option.isSome(decoded) && !seen.has(decoded.value)) {
      seen.add(decoded.value);
      out.push(decoded.value);
    }
  }
  return out;
}

function decodePartialUserConfigObject(
  parsed: Record<string, unknown>,
  configPath: string,
): LoadedUserHarnessConfig {
  const disabledSkills = decodeIdList(Reflect.get(parsed, "disabledSkills"), decodeSkillId);
  const disabledRules = decodeIdList(Reflect.get(parsed, "disabledRules"), decodeRuleId);
  const disabledCommands = decodeIdList(Reflect.get(parsed, "disabledCommands"), decodeCommandId);
  const disabledModes = decodeIdList(Reflect.get(parsed, "disabledModes"), decodeModeId);
  const rawMaxBytes = Reflect.get(parsed, "maxSystemContextBytes");
  const maxSystemContextBytes =
    rawMaxBytes === null || rawMaxBytes === undefined
      ? null
      : Option.getOrElse(decodePositiveInt(rawMaxBytes), () => null);
  const baseFields = {
    disabledSkills,
    disabledRules,
    disabledCommands,
    disabledModes,
    maxSystemContextBytes,
  };
  const rawServers = Reflect.get(parsed, "mcpServers");
  if (rawServers === undefined) {
    return { config: { schemaVersion: 1, mcpServers: {}, ...baseFields }, invalidEntries: [] };
  }
  if (rawServers === null || typeof rawServers !== "object" || Array.isArray(rawServers)) {
    return {
      config: { schemaVersion: 1, mcpServers: {}, ...baseFields },
      invalidEntries: [
        {
          source: configPath,
          id: null,
          message: "`mcpServers` must be an object keyed by server id.",
        },
      ],
    };
  }
  const mcpServers: Record<HarnessMcpServerId, HarnessMcpServerConfig> = {};
  const invalidEntries: Array<HarnessInvalidEntry> = [];
  for (const [rawId, rawValue] of Object.entries(rawServers)) {
    const validId = decodeServerId(rawId);
    if (Option.isNone(validId)) {
      invalidEntries.push({
        source: configPath,
        id: rawId,
        message: isReservedHarnessMcpServerId(rawId)
          ? `MCP server id "${rawId}" is reserved by T3 Code and was skipped.`
          : `Invalid MCP server id "${rawId}". Use letters, digits, hyphens, or underscores.`,
      });
      continue;
    }
    const validEntry = decodeServerEntry(rawValue);
    if (Option.isNone(validEntry)) {
      invalidEntries.push({
        source: configPath,
        id: rawId,
        message: `Server "${rawId}" has an invalid configuration and was skipped.`,
      });
      continue;
    }
    mcpServers[validId.value] = validEntry.value;
  }
  return {
    config: { schemaVersion: 1, mcpServers, ...baseFields },
    invalidEntries,
  };
}

interface LoadedProjectHarnessConfig {
  readonly mcpServers: Readonly<Record<string, HarnessMcpServerConfig>>;
  /** Includes invalid project server IDs so broken overrides still shadow user-level servers. */
  readonly declaredServerIds: ReadonlySet<string>;
  readonly disabledMcpServers: ReadonlySet<string>;
  readonly disabledSkills: ReadonlySet<string>;
  readonly disabledRules: ReadonlySet<string>;
  readonly disabledCommands: ReadonlySet<string>;
  readonly disabledModes: ReadonlySet<string>;
  readonly invalidEntries: ReadonlyArray<HarnessInvalidEntry>;
}

const EMPTY_PROJECT_HARNESS: LoadedProjectHarnessConfig = {
  mcpServers: {},
  declaredServerIds: new Set(),
  disabledMcpServers: new Set(),
  disabledSkills: new Set(),
  disabledRules: new Set(),
  disabledCommands: new Set(),
  disabledModes: new Set(),
  invalidEntries: [],
};

function decodeProjectHarnessLeniently(
  rawText: string,
  projectFilePath: string,
): Effect.Effect<LoadedProjectHarnessConfig> {
  return decodeUnknownLenientJson(rawText).pipe(
    Effect.match({
      onFailure: (): LoadedProjectHarnessConfig => ({
        ...EMPTY_PROJECT_HARNESS,
        invalidEntries: [
          {
            source: projectFilePath,
            id: null,
            message: "Malformed JSON in t3.json.",
          },
        ],
      }),
      onSuccess: (parsed): LoadedProjectHarnessConfig => {
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return EMPTY_PROJECT_HARNESS;
        }
        const rawHarness = Reflect.get(parsed, "harness");
        if (rawHarness === undefined || rawHarness === null) {
          return EMPTY_PROJECT_HARNESS;
        }
        if (typeof rawHarness !== "object" || Array.isArray(rawHarness)) {
          return {
            ...EMPTY_PROJECT_HARNESS,
            invalidEntries: [
              {
                source: projectFilePath,
                id: null,
                message: "`harness` in t3.json must be an object.",
              },
            ],
          };
        }

        const invalidEntries: Array<HarnessInvalidEntry> = [];
        const disabledMcpServers = new Set<string>();
        const rawDisabled = Reflect.get(rawHarness, "disabledMcpServers");
        if (Array.isArray(rawDisabled)) {
          for (const rawId of rawDisabled) {
            if (typeof rawId !== "string") continue;
            const validId = decodeServerId(rawId);
            if (Option.isSome(validId)) {
              disabledMcpServers.add(validId.value);
            } else {
              invalidEntries.push({
                source: projectFilePath,
                id: rawId,
                message: `Invalid disabled MCP server id "${rawId}" in t3.json.`,
              });
            }
          }
        }

        const mcpServers: Record<string, HarnessMcpServerConfig> = {};
        const declaredServerIds = new Set<string>();
        const rawServers = Reflect.get(rawHarness, "mcpServers");
        if (rawServers !== undefined && rawServers !== null) {
          if (typeof rawServers !== "object" || Array.isArray(rawServers)) {
            invalidEntries.push({
              source: projectFilePath,
              id: null,
              message: "`harness.mcpServers` in t3.json must be an object keyed by server id.",
            });
          } else {
            for (const [rawId, rawValue] of Object.entries(rawServers)) {
              const validId = decodeServerId(rawId);
              if (Option.isNone(validId)) {
                invalidEntries.push({
                  source: projectFilePath,
                  id: rawId,
                  message: isReservedHarnessMcpServerId(rawId)
                    ? `MCP server id "${rawId}" is reserved by T3 Code and was skipped.`
                    : `Invalid MCP server id "${rawId}" in t3.json.`,
                });
                continue;
              }
              declaredServerIds.add(validId.value);
              const validEntry = decodeServerEntry(rawValue);
              if (Option.isNone(validEntry)) {
                invalidEntries.push({
                  source: projectFilePath,
                  id: rawId,
                  message: `Project server "${rawId}" in t3.json has an invalid configuration and was skipped.`,
                });
                continue;
              }
              mcpServers[validId.value] = validEntry.value;
            }
          }
        }

        const disabledSkills = new Set<string>(
          decodeIdList(Reflect.get(rawHarness, "disabledSkills"), decodeSkillId),
        );
        const disabledRules = new Set<string>(
          decodeIdList(Reflect.get(rawHarness, "disabledRules"), decodeRuleId),
        );
        const disabledCommands = new Set<string>(
          decodeIdList(Reflect.get(rawHarness, "disabledCommands"), decodeCommandId).filter(
            (id) => !isReservedHarnessCommandId(id),
          ),
        );
        const disabledModes = new Set<string>(
          decodeIdList(Reflect.get(rawHarness, "disabledModes"), decodeModeId),
        );

        return {
          mcpServers,
          declaredServerIds,
          disabledMcpServers,
          disabledSkills,
          disabledRules,
          disabledCommands,
          disabledModes,
          invalidEntries,
        };
      },
    }),
  );
}

export class HarnessStore extends Context.Service<
  HarnessStore,
  {
    readonly harnessDir: string;
    readonly configPath: string;
    readonly lockedRules: NonNullable<ManagedPolicyLimits["harnessLockedRules"]>;
    readonly policyPath: string;
    readonly managedPolicyAllowsPlugins: boolean;
    /** Computes a server-secret-keyed confirmation digest that cannot be offline brute-forced from read-only snapshots. */
    readonly computeConfirmationDigest: (config: HarnessMcpServerConfig) => string;
    readonly serverLifecycleLock: (id: HarnessMcpServerId) => Semaphore.Semaphore;
    readonly onPluginServerRemoved: (
      close: (id: HarnessMcpServerId, pluginId: string) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly registerPluginServers: (
      pluginId: string,
      configs: Readonly<Record<string, HarnessMcpServerConfig>>,
      stillTrusted: Effect.Effect<boolean>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly loadUserConfig: Effect.Effect<LoadedUserHarnessConfig>;
    readonly resolveWorkspace: (
      workspaceRoot?: string | undefined,
    ) => Effect.Effect<ResolvedWorkspaceHarness>;
    readonly upsertUserServer: <E = never>(input: {
      readonly id: HarnessMcpServerId;
      readonly config: HarnessMcpServerConfig;
      readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
    }) => Effect.Effect<void, HarnessError | E>;
    readonly importUserServers: <E = never>(input: {
      readonly entries: ReadonlyArray<{
        readonly id: HarnessMcpServerId;
        readonly config: HarnessMcpServerConfig;
        readonly expectedExistingDigest?: string | null | undefined;
      }>;
      readonly overwriteExisting?: boolean | undefined;
      readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
    }) => Effect.Effect<
      {
        readonly importedIds: ReadonlyArray<HarnessMcpServerId>;
        readonly skippedIds: ReadonlyArray<HarnessMcpServerId>;
      },
      HarnessError | E
    >;
    readonly removeUserServer: (id: HarnessMcpServerId) => Effect.Effect<void, HarnessError>;
    readonly setServerEnabled: <E = never>(input: {
      readonly id: HarnessMcpServerId;
      readonly enabled: boolean;
      readonly expectedDigest?: string | undefined;
      readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
    }) => Effect.Effect<void, HarnessError | E>;
    readonly trustProjectServer: <E = never>(input: {
      readonly repoRoot: string;
      readonly serverId: HarnessMcpServerId;
      readonly digest: string;
      readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
    }) => Effect.Effect<void, HarnessError | E>;
    readonly revokeProjectTrust: (input: {
      readonly repoRoot: string;
      readonly serverId: HarnessMcpServerId;
    }) => Effect.Effect<void, HarnessError>;
    readonly setLibraryItemDisabled: (input: {
      readonly kind: "skill" | "rule" | "command" | "mode";
      readonly id: string;
      readonly disabled: boolean;
    }) => Effect.Effect<void, HarnessError>;
    readonly updateSettings: (input: {
      readonly maxSystemContextBytes: typeof PositiveInt.Type | null;
    }) => Effect.Effect<void, HarnessError>;
    readonly readProjectLibraryOverrides: (workspaceRoot?: string | undefined) => Effect.Effect<{
      readonly normalizedRepo: string | null;
      readonly disabledSkills: ReadonlySet<string>;
      readonly disabledRules: ReadonlySet<string>;
      readonly disabledCommands: ReadonlySet<string>;
      readonly disabledModes: ReadonlySet<string>;
      readonly invalidEntries: ReadonlyArray<HarnessInvalidEntry>;
      readonly managedPolicyAllowsHarness: boolean;
      readonly managedPolicyOrganization: string | null;
      readonly maxSystemContextBytes: typeof PositiveInt.Type;
    }>;
  }
>()("t3/harness/HarnessStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;

  const harnessDir = serverConfig.harnessDir;
  const configPath = path.join(harnessDir, HARNESS_CONFIG_FILENAME);
  const trustPath = serverConfig.harnessTrustPath;
  const writeLock = yield* Semaphore.make(1);
  // Server-local CSPRNG HMAC key binds UI confirmation tokens without exposing an unkeyed hash of secrets.
  const confirmationHmacKey = NodeCrypto.randomBytes(32);

  const computeConfirmationDigest = (config: HarnessMcpServerConfig): string =>
    NodeCrypto.createHmac("sha256", confirmationHmacKey)
      .update(`config\u0000${computeCanonicalConfigFingerprint(config)}`)
      .digest("hex")
      .slice(0, 24);

  const computeTrustConfirmationToken = (
    repoRoot: string,
    serverId: HarnessMcpServerId,
    persistedTrustDigest: string,
  ): string =>
    NodeCrypto.createHmac("sha256", confirmationHmacKey)
      .update(`trust\u0000${repoRoot}\u0000${serverId}\u0000${persistedTrustDigest}`)
      .digest("hex")
      .slice(0, 32);

  const policyHarnessDeniedBy = ManagedPolicy.deniedBy(managedPolicy, "harness");
  const policyStdioDeniedBy = ManagedPolicy.deniedBy(managedPolicy, "harnessMcpStdio");
  const policyPluginsDeniedBy = ManagedPolicy.deniedBy(managedPolicy, "harnessPlugins");
  const managedPolicyAllowsHarness = policyHarnessDeniedBy === undefined;
  const managedPolicyAllowsStdio = managedPolicyAllowsHarness && policyStdioDeniedBy === undefined;
  const managedPolicyOrganization = managedPolicy.document?.organization ?? null;

  const writeFileAtomic = Effect.fn("HarnessStore.writeFileAtomic")(function* (
    targetPath: string,
    contents: string,
  ) {
    const dir = path.dirname(targetPath);
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new HarnessError({
            code: "io_error",
            detail: `Could not create directory for ${path.basename(targetPath)}.`,
          }),
      ),
    );
    const tmpPath = `${targetPath}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(tmpPath, contents).pipe(
      Effect.andThen(fs.rename(tmpPath, targetPath)),
      Effect.onError(() => fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(
        () =>
          new HarnessError({
            code: "io_error",
            detail: `Failed to write ${path.basename(targetPath)}.`,
          }),
      ),
    );
  });

  const loadUserConfig: HarnessStore["Service"]["loadUserConfig"] = Effect.gen(function* () {
    const raw = yield* fs.readFileString(configPath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.logWarning("Failed to read harness.json", { error }).pipe(
                Effect.as(Option.none<string>()),
              ),
      }),
    );
    if (Option.isNone(raw)) {
      return { config: EMPTY_USER_HARNESS_CONFIG, invalidEntries: [] };
    }
    return yield* decodeUserConfigLeniently(raw.value, configPath);
  }).pipe(Effect.withSpan("HarnessStore.loadUserConfig"));

  const saveUserConfig = Effect.fn("HarnessStore.saveUserConfig")(function* (
    config: HarnessConfigFile,
  ) {
    const encoded = yield* encodeHarnessConfigJson(config).pipe(
      Effect.mapError(
        () =>
          new HarnessError({
            code: "invalid_config",
            detail: "Failed to encode harness.json configuration.",
          }),
      ),
    );
    yield* writeFileAtomic(configPath, formatPrettyJson(encoded));
  });

  const loadTrustLedger = Effect.fn("HarnessStore.loadTrustLedger")(function* () {
    const raw = yield* fs.readFileString(trustPath).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(raw)) {
      return [] as ReadonlyArray<HarnessTrustEntry>;
    }
    return yield* decodeTrustLedgerJson(raw.value).pipe(
      Effect.map((doc) => doc.entries),
      Effect.orElseSucceed((): ReadonlyArray<HarnessTrustEntry> => []),
    );
  });

  const saveTrustLedger = Effect.fn("HarnessStore.saveTrustLedger")(function* (
    entries: ReadonlyArray<HarnessTrustEntry>,
  ) {
    const encoded = yield* encodeTrustLedger({ schemaVersion: 1, entries }).pipe(
      Effect.mapError(
        () =>
          new HarnessError({
            code: "io_error",
            detail: "Failed to encode harness trust ledger.",
          }),
      ),
    );
    yield* writeFileAtomic(trustPath, formatPrettyJson(encoded));
  });

  const normalizeRepoRoot = (repoRoot: string): Effect.Effect<string> =>
    fs.realPath(repoRoot).pipe(Effect.orElseSucceed(() => path.resolve(repoRoot)));

  const policyDenialReason = (config: HarnessMcpServerConfig): string | null => {
    if (!managedPolicyAllowsHarness) {
      return `${policyHarnessDeniedBy ?? "Organization"}'s policy does not allow portable harness extensions.`;
    }
    if (config.transport.type === "stdio" && !managedPolicyAllowsStdio) {
      return `${policyStdioDeniedBy ?? "Organization"}'s policy does not allow local stdio MCP servers.`;
    }
    return null;
  };

  const loadProjectHarnessForRepo = Effect.fn("HarnessStore.loadProjectHarnessForRepo")(function* (
    normalizedRepo: string,
  ): Effect.fn.Return<LoadedProjectHarnessConfig> {
    const projectFilePath = path.join(normalizedRepo, "t3.json");
    const raw = yield* fs.readFileString(projectFilePath).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(raw)) {
      return EMPTY_PROJECT_HARNESS;
    }
    return yield* decodeProjectHarnessLeniently(raw.value, projectFilePath);
  });

  const lifecycleLocks = new Map<HarnessMcpServerId, Semaphore.Semaphore>();
  const serverLifecycleLock = (id: HarnessMcpServerId) => {
    const existing = lifecycleLocks.get(id);
    if (existing) return existing;
    const lock = Semaphore.makeUnsafe(1);
    lifecycleLocks.set(id, lock);
    return lock;
  };
  const removalListeners = new Set<
    (id: HarnessMcpServerId, pluginId: string) => Effect.Effect<void>
  >();
  const onPluginServerRemoved: HarnessStore["Service"]["onPluginServerRemoved"] = Effect.fn(
    "HarnessStore.onPluginServerRemoved",
  )(function* (close) {
    yield* Effect.acquireRelease(
      Effect.sync(() => removalListeners.add(close)),
      () => Effect.sync(() => removalListeners.delete(close)),
    );
  });
  const pluginServers = new Set<{
    id: HarnessMcpServerId;
    pluginId: string;
    config: HarnessMcpServerConfig;
    stillTrusted: Effect.Effect<boolean>;
  }>();
  const registerPluginServers: HarnessStore["Service"]["registerPluginServers"] = Effect.fn(
    "HarnessStore.registerPluginServers",
  )(function* (pluginId, configs, stillTrusted) {
    for (const [key, config] of Object.entries(configs)) {
      const id = HarnessMcpServerId.make(key);
      const entry = { id, pluginId, config, stillTrusted };
      const lock = serverLifecycleLock(id);
      yield* Effect.acquireRelease(
        lock.withPermits(1)(Effect.sync(() => pluginServers.add(entry))),
        () =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              pluginServers.delete(entry);
              yield* Effect.forEach(removalListeners, (close) => close(id, pluginId), {
                discard: true,
              });
            }),
          ),
      );
    }
  });

  const resolveWorkspace: HarnessStore["Service"]["resolveWorkspace"] = Effect.fn(
    "HarnessStore.resolveWorkspace",
  )(function* (workspaceRoot) {
    const [{ config: userConfig, invalidEntries: userInvalidEntries }, trustEntries] =
      yield* Effect.all([loadUserConfig, loadTrustLedger()]);
    const normalizedRepo =
      workspaceRoot !== undefined && workspaceRoot.trim().length > 0
        ? yield* normalizeRepoRoot(workspaceRoot.trim())
        : null;
    const projectHarness =
      normalizedRepo !== null
        ? yield* loadProjectHarnessForRepo(normalizedRepo)
        : EMPTY_PROJECT_HARNESS;
    const invalidEntries = [...userInvalidEntries, ...projectHarness.invalidEntries];
    const projectDisabled = projectHarness.disabledMcpServers;
    const projectServers = projectHarness.mcpServers;

    const trustedKeys = new Map<string, string>();
    for (const entry of trustEntries) {
      trustedKeys.set(`${entry.repoRoot}\u0000${entry.serverId}`, entry.digest);
    }

    const resolved: Array<ResolvedHarnessMcpServer> = [];

    // 1. User-level servers (`~/.t3/harness/harness.json`)
    const servers = { ...userConfig.mcpServers };
    const owners = new Map<string, string>();
    const trustedPlugins = new Map<string, boolean>();
    for (const plugin of pluginServers) {
      if (Object.hasOwn(servers, plugin.id)) continue;
      const trusted = trustedPlugins.get(plugin.pluginId) ?? (yield* plugin.stillTrusted);
      trustedPlugins.set(plugin.pluginId, trusted);
      if (trusted) {
        servers[plugin.id] = plugin.config;
        owners.set(plugin.id, plugin.pluginId);
      }
    }
    for (const [id, serverConfigEntry] of Object.entries(servers)) {
      if (isReservedHarnessMcpServerId(id)) continue;
      const serverId = id as HarnessMcpServerId;
      const disabledByProject = projectDisabled.has(serverId);
      const overriddenByProject =
        projectHarness.declaredServerIds.has(serverId) || disabledByProject;
      const blockedReason = policyDenialReason(serverConfigEntry);
      const effectiveEnabled =
        serverConfigEntry.enabled &&
        !serverConfigEntry.pendingApproval &&
        !overriddenByProject &&
        blockedReason === null;
      resolved.push({
        id: serverId,
        scope: "user",
        ...(owners.has(id) ? { pluginId: owners.get(id)! } : {}),
        config: serverConfigEntry,
        configDigest: computeConfirmationDigest(serverConfigEntry),
        effectiveEnabled,
        trusted: serverConfigEntry.pendingApproval !== true,
        needsTrustConfirmation: false,
        trustReason: null,
        requiresSecretAccess: configContainsSecretPlaceholder(serverConfigEntry),
        trustDigest: null,
        repoRoot: null,
        overriddenByProject,
        blockedByPolicyReason: blockedReason,
      });
    }

    // 2. Project-level servers (`<repo>/t3.json#harness.mcpServers`)
    // Every checked-in project MCP server requires explicit owner trust pinned to its full config digest
    // so opening an untrusted repo can never spawn commands, reach remote origins, or exfiltrate host secrets.
    if (normalizedRepo !== null) {
      for (const [id, rawProjectEntry] of Object.entries(projectServers)) {
        if (isReservedHarnessMcpServerId(id)) continue;
        const serverId = id as HarnessMcpServerId;
        const entry: HarnessMcpServerConfig = {
          ...rawProjectEntry,
          origin: rawProjectEntry.origin ?? {
            kind: "project",
            source: "t3.json",
            sourcePath: path.join(normalizedRepo, "t3.json"),
          },
        };
        const persistedTrustDigest = computeProjectTrustDigest(entry);
        const trustedDigest = trustedKeys.get(`${normalizedRepo}\u0000${serverId}`);
        const trusted = trustedDigest === persistedTrustDigest;
        const trustReason = trustReasonForProjectServer(entry);
        const needsTrustConfirmation = entry.enabled && !trusted;
        const blockedReason = policyDenialReason(entry);
        const effectiveEnabled =
          entry.enabled && !projectDisabled.has(serverId) && trusted && blockedReason === null;
        resolved.push({
          id: serverId,
          scope: "project",
          config: entry,
          configDigest: computeConfirmationDigest(entry),
          effectiveEnabled,
          trusted,
          needsTrustConfirmation,
          trustReason,
          requiresSecretAccess: configContainsSecretPlaceholder(entry),
          trustDigest: computeTrustConfirmationToken(
            normalizedRepo,
            serverId,
            persistedTrustDigest,
          ),
          repoRoot: normalizedRepo,
          overriddenByProject: false,
          blockedByPolicyReason: blockedReason,
        });
      }
    }

    resolved.sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));

    return {
      harnessDir,
      configPath,
      workspaceRoot: normalizedRepo,
      servers: resolved,
      invalidEntries,
      managedPolicyAllowsHarness,
      managedPolicyAllowsStdio,
      managedPolicyOrganization,
    };
  });

  const assertWriteAllowed = (
    config: HarnessMcpServerConfig,
  ): Effect.Effect<void, HarnessError> => {
    const reason = policyDenialReason(config);
    return reason === null
      ? Effect.void
      : Effect.fail(new HarnessError({ code: "policy_denied", detail: reason }));
  };

  const upsertUserServer: HarnessStore["Service"]["upsertUserServer"] = Effect.fn(
    "HarnessStore.upsertUserServer",
  )(function* <E = never>({
    id,
    config,
    authorize,
  }: {
    readonly id: HarnessMcpServerId;
    readonly config: HarnessMcpServerConfig;
    readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
  }): Effect.fn.Return<void, HarnessError | E> {
    if (isReservedHarnessMcpServerId(id)) {
      return yield* new HarnessError({
        code: "invalid_config",
        serverId: id,
        detail: `MCP server id "${id}" is reserved by T3 Code.`,
      });
    }
    yield* validateToolFilters(id, config);
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const { config: current } = yield* loadUserConfig;
        const mergedConfig = yield* mergeRedactedConfigWithExisting(
          id,
          config,
          current.mcpServers[id],
        );
        if (authorize !== undefined) {
          yield* authorize(mergedConfig);
        }
        yield* assertWriteAllowed(mergedConfig);
        const next: HarnessConfigFile = {
          ...current,
          schemaVersion: 1,
          mcpServers: {
            ...current.mcpServers,
            [id]: {
              ...mergedConfig,
              origin: mergedConfig.origin ?? { kind: "user", sourcePath: configPath },
            },
          },
        };
        yield* saveUserConfig(next);
      }),
    );
  });

  const importUserServers: HarnessStore["Service"]["importUserServers"] = Effect.fn(
    "HarnessStore.importUserServers",
  )(function* <E = never>({
    entries,
    overwriteExisting,
    authorize,
  }: {
    readonly entries: ReadonlyArray<{
      readonly id: HarnessMcpServerId;
      readonly config: HarnessMcpServerConfig;
      readonly expectedExistingDigest?: string | null | undefined;
    }>;
    readonly overwriteExisting?: boolean | undefined;
    readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
  }): Effect.fn.Return<
    {
      readonly importedIds: ReadonlyArray<HarnessMcpServerId>;
      readonly skippedIds: ReadonlyArray<HarnessMcpServerId>;
    },
    HarnessError | E
  > {
    for (const entry of entries) {
      if (isReservedHarnessMcpServerId(entry.id)) {
        return yield* new HarnessError({
          code: "invalid_config",
          serverId: entry.id,
          detail: `MCP server id "${entry.id}" is reserved by T3 Code.`,
        });
      }
    }

    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const { config: current } = yield* loadUserConfig;
        const nextServers: Record<HarnessMcpServerId, HarnessMcpServerConfig> = {
          ...current.mcpServers,
        };
        const importedIds: Array<HarnessMcpServerId> = [];
        const skippedIds: Array<HarnessMcpServerId> = [];

        for (const entry of entries) {
          const existing = nextServers[entry.id];
          const exists = existing !== undefined;

          if (exists && overwriteExisting !== true) {
            skippedIds.push(entry.id);
            continue;
          }
          yield* validateToolFilters(entry.id, entry.config);
          if (exists && overwriteExisting === true && entry.expectedExistingDigest === undefined) {
            return yield* new HarnessError({
              code: "invalid_config",
              serverId: entry.id,
              detail: `Overwriting existing MCP server "${entry.id}" requires expectedExistingDigest from a fresh preview.`,
            });
          }
          if (entry.expectedExistingDigest !== undefined) {
            const actualExistingDigest =
              existing !== undefined ? computeConfirmationDigest(existing) : null;
            if (actualExistingDigest !== entry.expectedExistingDigest) {
              return yield* new HarnessError({
                code: "invalid_config",
                serverId: entry.id,
                detail: `Target MCP server "${entry.id}" changed since preview. Rescan and review before importing.`,
              });
            }
          }
          if (authorize !== undefined) {
            yield* authorize(entry.config);
          }
          yield* assertWriteAllowed(entry.config);
          nextServers[entry.id] = {
            ...entry.config,
            origin: entry.config.origin ?? { kind: "imported", sourcePath: configPath },
          };
          importedIds.push(entry.id);
        }

        if (importedIds.length > 0) {
          yield* saveUserConfig({
            ...current,
            schemaVersion: 1,
            mcpServers: nextServers,
          });
        }
        return { importedIds, skippedIds };
      }),
    );
  });

  const removeUserServer: HarnessStore["Service"]["removeUserServer"] = Effect.fn(
    "HarnessStore.removeUserServer",
  )(function* (id) {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const { config: current } = yield* loadUserConfig;
        if (!Object.hasOwn(current.mcpServers, id)) {
          return yield* new HarnessError({
            code: "not_found",
            serverId: id,
            detail: `MCP server "${id}" was not found in harness.json.`,
          });
        }
        const nextServers = { ...current.mcpServers };
        delete nextServers[id];
        yield* saveUserConfig({ ...current, schemaVersion: 1, mcpServers: nextServers });
      }),
    );
  });

  const setServerEnabled: HarnessStore["Service"]["setServerEnabled"] = Effect.fn(
    "HarnessStore.setServerEnabled",
  )(function* <E = never>({
    id,
    enabled,
    expectedDigest,
    authorize,
  }: {
    readonly id: HarnessMcpServerId;
    readonly enabled: boolean;
    readonly expectedDigest?: string | undefined;
    readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
  }): Effect.fn.Return<void, HarnessError | E> {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const { config: current } = yield* loadUserConfig;
        const existing = current.mcpServers[id];
        if (existing === undefined) {
          return yield* new HarnessError({
            code: "not_found",
            serverId: id,
            detail: `MCP server "${id}" was not found in harness.json.`,
          });
        }
        if (
          expectedDigest !== undefined &&
          computeConfirmationDigest(existing) !== expectedDigest
        ) {
          return yield* new HarnessError({
            code: "invalid_config",
            serverId: id,
            detail: `MCP server "${id}" configuration changed since preview. Refresh and review before updating.`,
          });
        }
        if (enabled) {
          if (authorize !== undefined) {
            yield* authorize(existing);
          }
          yield* assertWriteAllowed(existing);
        }
        yield* saveUserConfig({
          ...current,
          schemaVersion: 1,
          mcpServers: {
            ...current.mcpServers,
            [id]: {
              ...existing,
              enabled,
              ...(enabled && existing.pendingApproval ? { pendingApproval: false } : {}),
            },
          },
        });
      }),
    );
  });

  const trustProjectServer: HarnessStore["Service"]["trustProjectServer"] = Effect.fn(
    "HarnessStore.trustProjectServer",
  )(function* <E = never>({
    repoRoot,
    serverId,
    digest,
    authorize,
  }: {
    readonly repoRoot: string;
    readonly serverId: HarnessMcpServerId;
    readonly digest: string;
    readonly authorize?: (config: HarnessMcpServerConfig) => Effect.Effect<void, E>;
  }): Effect.fn.Return<void, HarnessError | E> {
    if (isReservedHarnessMcpServerId(serverId)) {
      return yield* new HarnessError({
        code: "invalid_config",
        serverId,
        detail: `MCP server id "${serverId}" is reserved by T3 Code.`,
      });
    }
    const normalizedRepo = yield* normalizeRepoRoot(repoRoot);
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const projectHarness = yield* loadProjectHarnessForRepo(normalizedRepo);
        const entry = projectHarness.mcpServers[serverId];
        if (entry === undefined) {
          return yield* new HarnessError({
            code: "not_found",
            serverId,
            detail: `Project MCP server "${serverId}" was not found in ${normalizedRepo}/t3.json.`,
          });
        }
        yield* assertWriteAllowed(entry);
        const persistedTrustDigest = computeProjectTrustDigest(entry);
        const expectedToken = computeTrustConfirmationToken(
          normalizedRepo,
          serverId,
          persistedTrustDigest,
        );
        if (expectedToken !== digest) {
          return yield* new HarnessError({
            code: "invalid_config",
            serverId,
            detail: `Project MCP server "${serverId}" configuration changed since preview. Refresh and review before trusting.`,
          });
        }
        if (authorize !== undefined) {
          yield* authorize(entry);
        }
        const now = yield* DateTime.now;
        const entries = yield* loadTrustLedger();
        const filtered = entries.filter(
          (existing) => !(existing.repoRoot === normalizedRepo && existing.serverId === serverId),
        );
        yield* saveTrustLedger([
          ...filtered,
          {
            repoRoot: normalizedRepo,
            serverId,
            digest: persistedTrustDigest,
            trustedAt: IsoDateTime.make(DateTime.formatIso(now)),
          },
        ]);
      }),
    );
  });

  const revokeProjectTrust: HarnessStore["Service"]["revokeProjectTrust"] = Effect.fn(
    "HarnessStore.revokeProjectTrust",
  )(function* ({ repoRoot, serverId }) {
    const normalizedRepo = yield* normalizeRepoRoot(repoRoot);
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const entries = yield* loadTrustLedger();
        const filtered = entries.filter(
          (entry) => !(entry.repoRoot === normalizedRepo && entry.serverId === serverId),
        );
        yield* saveTrustLedger(filtered);
      }),
    );
  });

  const setLibraryItemDisabled: HarnessStore["Service"]["setLibraryItemDisabled"] = Effect.fn(
    "HarnessStore.setLibraryItemDisabled",
  )(function* ({ kind, id, disabled }) {
    if (!managedPolicyAllowsHarness) {
      return yield* new HarnessError({
        code: "policy_denied",
        detail: `${policyHarnessDeniedBy ?? "Organization"}'s policy does not allow portable harness extensions.`,
      });
    }
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const { config: current } = yield* loadUserConfig;
        const toggle = <T extends string>(list: ReadonlyArray<T>, value: T): ReadonlyArray<T> => {
          const next = new Set(list);
          if (disabled) next.add(value);
          else next.delete(value);
          return Array.from(next).sort((a, b) => a.localeCompare(b));
        };
        if (kind === "skill") {
          const decoded = decodeSkillId(id);
          if (Option.isNone(decoded)) {
            return yield* new HarnessError({
              code: "invalid_config",
              detail: `Invalid skill id "${id}".`,
            });
          }
          yield* saveUserConfig({
            ...current,
            disabledSkills: toggle(current.disabledSkills, decoded.value),
          });
          return;
        }
        if (kind === "rule") {
          const decoded = decodeRuleId(id);
          if (Option.isNone(decoded)) {
            return yield* new HarnessError({
              code: "invalid_config",
              detail: `Invalid rule id "${id}".`,
            });
          }
          yield* saveUserConfig({
            ...current,
            disabledRules: toggle(current.disabledRules, decoded.value),
          });
          return;
        }
        if (kind === "mode") {
          const decoded = decodeModeId(id);
          if (Option.isNone(decoded)) {
            return yield* new HarnessError({
              code: "invalid_config",
              detail: `Invalid mode id "${id}".`,
            });
          }
          yield* saveUserConfig({
            ...current,
            disabledModes: toggle(current.disabledModes, decoded.value),
          });
          return;
        }
        const decoded = decodeCommandId(id);
        if (Option.isNone(decoded)) {
          return yield* new HarnessError({
            code: "invalid_config",
            detail: `Invalid command id "${id}".`,
          });
        }
        yield* saveUserConfig({
          ...current,
          disabledCommands: toggle(current.disabledCommands, decoded.value),
        });
      }),
    );
  });

  const updateSettings: HarnessStore["Service"]["updateSettings"] = Effect.fn(
    "HarnessStore.updateSettings",
  )(function* ({ maxSystemContextBytes }) {
    if (!managedPolicyAllowsHarness) {
      return yield* new HarnessError({
        code: "policy_denied",
        detail: `${policyHarnessDeniedBy ?? "Organization"}'s policy does not allow portable harness extensions.`,
      });
    }
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const { config: current } = yield* loadUserConfig;
        yield* saveUserConfig({
          ...current,
          maxSystemContextBytes,
        });
      }),
    );
  });

  const readProjectLibraryOverrides: HarnessStore["Service"]["readProjectLibraryOverrides"] =
    Effect.fn("HarnessStore.readProjectLibraryOverrides")(function* (workspaceRoot) {
      const { config: userConfig, invalidEntries: userInvalid } = yield* loadUserConfig;
      const normalizedRepo =
        workspaceRoot !== undefined && workspaceRoot.trim().length > 0
          ? yield* normalizeRepoRoot(workspaceRoot.trim())
          : null;
      const projectHarness =
        normalizedRepo !== null
          ? yield* loadProjectHarnessForRepo(normalizedRepo)
          : EMPTY_PROJECT_HARNESS;
      return {
        normalizedRepo,
        disabledSkills: projectHarness.disabledSkills,
        disabledRules: projectHarness.disabledRules,
        disabledCommands: projectHarness.disabledCommands,
        disabledModes: projectHarness.disabledModes,
        invalidEntries: [...userInvalid, ...projectHarness.invalidEntries],
        managedPolicyAllowsHarness,
        managedPolicyOrganization,
        maxSystemContextBytes:
          userConfig.maxSystemContextBytes ??
          PositiveInt.make(DEFAULT_HARNESS_MAX_SYSTEM_CONTEXT_BYTES),
      };
    });

  return HarnessStore.of({
    harnessDir,
    configPath,
    lockedRules: managedPolicy.document?.limits?.harnessLockedRules ?? [],
    policyPath: managedPolicy.path,
    managedPolicyAllowsPlugins: managedPolicyAllowsHarness && policyPluginsDeniedBy === undefined,
    computeConfirmationDigest,
    loadUserConfig,
    resolveWorkspace,
    registerPluginServers,
    onPluginServerRemoved,
    serverLifecycleLock,
    upsertUserServer,
    importUserServers,
    removeUserServer,
    setServerEnabled,
    trustProjectServer,
    revokeProjectTrust,
    setLibraryItemDisabled,
    updateSettings,
    readProjectLibraryOverrides,
  });
});

export const layer = Layer.effect(HarnessStore, make);
