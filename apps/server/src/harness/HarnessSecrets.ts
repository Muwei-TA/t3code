import {
  HARNESS_SECRET_REDACTED,
  HarnessError,
  type HarnessMcpServerConfig,
  SecretProviderId,
  type SecretReference,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/**
 * Matches `${secret:PROVIDER:REF}` (external secret provider such as 1Password)
 * or `${secret:NAME}` (local Harness-namespaced secret in ServerSecretStore).
 */
const SECRET_PLACEHOLDER_PATTERN = /\$\{secret:([a-zA-Z0-9][a-zA-Z0-9_-]*)(?::([^}\r\n]+))?\}/g;
const SECRET_PLACEHOLDER_TEST = /\$\{secret:[a-zA-Z0-9][a-zA-Z0-9_-]*(?::[^}\r\n]+)?\}/;
const LOCAL_SECRET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SAFE_PLACEHOLDER_ONLY_VALUE =
  /^(?:(?:Bearer|Basic|Token)\s+)?\$\{secret:[a-zA-Z0-9][a-zA-Z0-9_-]*(?::[^}\r\n]+)?\}$/i;

/**
 * Dedicated key prefix inside ServerSecretStore so `${secret:NAME}` can never
 * read internal T3 signing keys, OAuth secrets, or session material.
 */
const HARNESS_LOCAL_SECRET_PREFIX = "harness-secret-";

export function harnessLocalSecretKey(name: string): string | null {
  if (!LOCAL_SECRET_NAME_PATTERN.test(name)) return null;
  return `${HARNESS_LOCAL_SECRET_PREFIX}${name}`;
}

function recordContainsSecretPlaceholder(
  record: Readonly<Record<string, string>> | undefined,
): boolean {
  if (record === undefined) return false;
  return Object.values(record).some((value) => SECRET_PLACEHOLDER_TEST.test(value));
}

export function configContainsSecretPlaceholder(config: HarnessMcpServerConfig): boolean {
  const record =
    config.transport.type === "stdio" ? config.transport.env : config.transport.headers;
  return recordContainsSecretPlaceholder(record);
}

/**
 * Keeps placeholder-only values (e.g. `Bearer ${secret:TOKEN}`) readable in UI
 * while masking any literal secret values before leaving the server.
 */
function redactSecretRecord(
  record: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (record === undefined) return undefined;
  const entries = Object.entries(record);
  if (entries.length === 0) return undefined;
  const redacted: Record<string, string> = {};
  for (const [key, value] of entries) {
    const trimmed = value.trim();
    redacted[key] =
      trimmed.length === 0 || SAFE_PLACEHOLDER_ONLY_VALUE.test(trimmed)
        ? value
        : HARNESS_SECRET_REDACTED;
  }
  return redacted;
}

const SENSITIVE_ARG_FLAG =
  /^(?:-H|--header|--?[\w-]*(?:token|key|secret|password|passwd|pwd|auth|authorization|credential|bearer|cookie))$/iu;
const SENSITIVE_ARG_ASSIGN =
  /^((?:-H|--header|--?[\w-]*(?:token|key|secret|password|passwd|pwd|auth|authorization|credential|bearer|cookie))[:=])(.*)$/iu;
const SENSITIVE_ARG_VALUE =
  /(?:^(?:Bearer|Basic|Token)\s+\S+|\b(?:sk|ghp|gho|ghu|ghs|ghr|xox[baprs])-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/iu;

function isSafePlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || SAFE_PLACEHOLDER_ONLY_VALUE.test(trimmed);
}

function redactUrlCredentials(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const hadUserInfo = parsed.username.length > 0 || parsed.password.length > 0;
    const rawParams = Array.from(parsed.searchParams.entries());
    const hadHash = parsed.hash.length > 0;
    if (!hadUserInfo && rawParams.length === 0 && !hadHash) {
      return rawUrl;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const base = parsed.toString();
    const queryString =
      rawParams.length === 0
        ? ""
        : `?${rawParams
            .map(([key, value]) => {
              const encodedKey = encodeURIComponent(key);
              if (value.length === 0) return encodedKey;
              if (isSafePlaceholderValue(value)) return `${encodedKey}=${value}`;
              return `${encodedKey}=${HARNESS_SECRET_REDACTED}`;
            })
            .join("&")}`;
    const hashString = hadHash ? `#${HARNESS_SECRET_REDACTED}` : "";
    return `${base}${queryString}${hashString}`;
  } catch {
    return "[REDACTED_INVALID_URL]";
  }
}

function redactStdioArgs(
  args: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined {
  if (args === undefined) return undefined;
  const result: Array<string> = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      redactNext = false;
      result.push(isSafePlaceholderValue(arg) ? arg : HARNESS_SECRET_REDACTED);
      continue;
    }
    if (SENSITIVE_ARG_FLAG.test(arg)) {
      result.push(arg);
      redactNext = true;
      continue;
    }
    const assignMatch = SENSITIVE_ARG_ASSIGN.exec(arg);
    if (assignMatch !== null) {
      const prefix = assignMatch[1]!;
      const value = assignMatch[2]!;
      result.push(isSafePlaceholderValue(value) ? arg : `${prefix}${HARNESS_SECRET_REDACTED}`);
      continue;
    }
    // Compact short header flag `-H<header>` (no separating space or `=`/`=`).
    if (arg.startsWith("-H") && arg.length > 2) {
      const inlineValue = arg.slice(2);
      result.push(isSafePlaceholderValue(inlineValue) ? arg : `-H${HARNESS_SECRET_REDACTED}`);
      continue;
    }
    if (/^https?:\/\//iu.test(arg)) {
      result.push(redactUrlCredentials(arg));
      continue;
    }
    if (/\bhttps?:\/\/[^\s<>"']+/iu.test(arg)) {
      result.push(arg.replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrlCredentials));
      continue;
    }
    if (SENSITIVE_ARG_VALUE.test(arg) && !isSafePlaceholderValue(arg)) {
      result.push(HARNESS_SECRET_REDACTED);
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function redactHarnessServerConfig(config: HarnessMcpServerConfig): HarnessMcpServerConfig {
  if (config.transport.type === "stdio") {
    const redactedEnv = redactSecretRecord(config.transport.env);
    const redactedArgs = redactStdioArgs(config.transport.args);
    return {
      ...config,
      transport: {
        type: "stdio",
        command: config.transport.command,
        ...(redactedArgs ? { args: redactedArgs } : {}),
        ...(config.transport.cwd ? { cwd: config.transport.cwd } : {}),
        ...(redactedEnv ? { env: redactedEnv } : {}),
      },
    };
  }
  const redactedHeaders = redactSecretRecord(config.transport.headers);
  return {
    ...config,
    transport: {
      type: config.transport.type,
      url: redactUrlCredentials(config.transport.url),
      ...(redactedHeaders ? { headers: redactedHeaders } : {}),
      ...(config.transport.oauth
        ? {
            oauth: {
              ...config.transport.oauth,
              ...(config.transport.oauth.authorizationServerUrl
                ? {
                    authorizationServerUrl: redactUrlCredentials(
                      config.transport.oauth.authorizationServerUrl,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    },
  };
}

function recordHasRedactedSentinel(record: Readonly<Record<string, string>> | undefined): boolean {
  if (record === undefined) return false;
  return Object.values(record).some((value) => value === HARNESS_SECRET_REDACTED);
}

function argsHaveRedactedSentinel(args: ReadonlyArray<string> | undefined): boolean {
  if (args === undefined) return false;
  return args.some((arg) => arg.includes(HARNESS_SECRET_REDACTED));
}

function urlHasRedactedSentinel(rawUrl: string): boolean {
  if (rawUrl.includes(HARNESS_SECRET_REDACTED)) return true;
  try {
    const parsed = new URL(rawUrl);
    for (const [, value] of parsed.searchParams.entries()) {
      if (value === HARNESS_SECRET_REDACTED) return true;
    }
    if (decodeURIComponent(parsed.hash) === `#${HARNESS_SECRET_REDACTED}`) return true;
  } catch {
    // Ignore malformed URLs here; schema validation already guards them.
  }
  return false;
}

function httpTargetIdentity(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function mergeRedactedRecord(
  incoming: Readonly<Record<string, string>> | undefined,
  existing: Readonly<Record<string, string>> | undefined,
  serverId: string,
  fieldName: "env" | "headers",
): Effect.Effect<Record<string, string> | undefined, HarnessError> {
  if (incoming === undefined) return Effect.undefined;
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === HARNESS_SECRET_REDACTED) {
      const prior = existing?.[key];
      if (prior === undefined) {
        return Effect.fail(
          new HarnessError({
            code: "invalid_config",
            serverId,
            detail: `Cannot save redacted placeholder for new ${fieldName} key "${key}". Provide a value or \${secret:NAME} reference.`,
          }),
        );
      }
      merged[key] = prior;
    } else {
      merged[key] = value;
    }
  }
  return Effect.succeed(Object.keys(merged).length > 0 ? merged : undefined);
}

function mergeRedactedUrl(
  serverId: string,
  incomingUrl: string,
  existingUrl: string | undefined,
): Effect.Effect<string, HarnessError> {
  const hasSentinel = urlHasRedactedSentinel(incomingUrl);
  if (existingUrl !== undefined && incomingUrl === redactUrlCredentials(existingUrl)) {
    return Effect.succeed(existingUrl);
  }
  if (!hasSentinel) {
    return Effect.succeed(incomingUrl);
  }
  if (existingUrl === undefined) {
    return Effect.fail(
      new HarnessError({
        code: "invalid_config",
        serverId,
        detail:
          "Cannot save redacted URL credentials for a new server. Provide the URL explicitly.",
      }),
    );
  }
  try {
    const incomingParsed = new URL(incomingUrl);
    const existingParsed = new URL(existingUrl);
    const existingParams = Array.from(existingParsed.searchParams.entries());
    const incomingParams = Array.from(incomingParsed.searchParams.entries());
    const mergedParams: Array<[string, string]> = [];
    const usedExistingIndices = new Set<number>();

    for (const [key, value] of incomingParams) {
      if (value === HARNESS_SECRET_REDACTED) {
        const matchIndex = existingParams.findIndex(
          ([existingKey], idx) => existingKey === key && !usedExistingIndices.has(idx),
        );
        if (matchIndex === -1) {
          return Effect.fail(
            new HarnessError({
              code: "invalid_config",
              serverId,
              detail: `Cannot save redacted placeholder for new URL query parameter "${key}". Provide a value explicitly.`,
            }),
          );
        }
        usedExistingIndices.add(matchIndex);
        mergedParams.push([key, existingParams[matchIndex]![1]]);
      } else {
        mergedParams.push([key, value]);
      }
    }

    const next = new URL(`${incomingParsed.origin}${incomingParsed.pathname}`);
    if (incomingParsed.username.length > 0 || incomingParsed.password.length > 0) {
      next.username = incomingParsed.username;
      next.password = incomingParsed.password;
    } else if (existingParsed.username.length > 0 || existingParsed.password.length > 0) {
      next.username = existingParsed.username;
      next.password = existingParsed.password;
    }
    for (const [key, value] of mergedParams) {
      next.searchParams.append(key, value);
    }
    if (incomingParsed.hash.length > 0) {
      const decodedHash = decodeURIComponent(incomingParsed.hash);
      if (decodedHash === `#${HARNESS_SECRET_REDACTED}`) {
        if (existingParsed.hash.length === 0) {
          return Effect.fail(
            new HarnessError({
              code: "invalid_config",
              serverId,
              detail: "Cannot save redacted URL fragment without an existing value.",
            }),
          );
        }
        next.hash = existingParsed.hash;
      } else {
        next.hash = incomingParsed.hash;
      }
    }
    return Effect.succeed(next.toString());
  } catch {
    return Effect.fail(
      new HarnessError({
        code: "invalid_config",
        serverId,
        detail: "Invalid URL containing redacted placeholder.",
      }),
    );
  }
}

function mergeRedactedStdioArgs(
  serverId: string,
  incomingArgs: ReadonlyArray<string> | undefined,
  existingArgs: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string> | undefined, HarnessError> {
  if (incomingArgs === undefined) return Effect.undefined;
  if (!argsHaveRedactedSentinel(incomingArgs)) return Effect.succeed(incomingArgs);
  if (existingArgs === undefined || existingArgs.length !== incomingArgs.length) {
    return Effect.fail(
      new HarnessError({
        code: "invalid_config",
        serverId,
        detail:
          "Cannot reuse redacted stdio arguments after changing the argument list. Re-enter credentials explicitly.",
      }),
    );
  }
  const redactedExisting = redactStdioArgs(existingArgs) ?? [];
  const merged: Array<string> = [];
  for (let i = 0; i < incomingArgs.length; i += 1) {
    const incomingArg = incomingArgs[i]!;
    if (incomingArg.includes(HARNESS_SECRET_REDACTED)) {
      if (incomingArg !== redactedExisting[i]) {
        return Effect.fail(
          new HarnessError({
            code: "invalid_config",
            serverId,
            detail:
              "Cannot reuse redacted stdio arguments after modifying argument structure. Re-enter credentials explicitly.",
          }),
        );
      }
      merged.push(existingArgs[i]!);
    } else {
      merged.push(incomingArg);
    }
  }
  return Effect.succeed(merged);
}

/**
 * Restores stored env/header/url/arg values when a client submits unchanged redaction sentinels
 * during an edit. Strictly bound to the existing server target (origin+pathname for HTTP/SSE,
 * command+cwd+args skeleton for stdio) and injection mode so stored credentials can never be
 * redirected to a new destination.
 */
export const mergeRedactedConfigWithExisting = Effect.fn(
  "HarnessSecrets.mergeRedactedConfigWithExisting",
)(function* (
  serverId: string,
  incoming: HarnessMcpServerConfig,
  existing: HarnessMcpServerConfig | undefined,
): Effect.fn.Return<HarnessMcpServerConfig, HarnessError> {
  if (incoming.transport.type === "stdio") {
    const hasRedacted =
      recordHasRedactedSentinel(incoming.transport.env) ||
      argsHaveRedactedSentinel(incoming.transport.args);
    if (hasRedacted) {
      if (existing === undefined || existing.transport.type !== "stdio") {
        return yield* new HarnessError({
          code: "invalid_config",
          serverId,
          detail:
            "Cannot reuse redacted credentials after changing server transport type. Re-enter credentials explicitly.",
        });
      }
      const existingArgsRedacted = redactStdioArgs(existing.transport.args) ?? [];
      const incomingArgs = incoming.transport.args ?? [];
      const sameArgsSkeleton =
        existingArgsRedacted.length === incomingArgs.length &&
        incomingArgs.every((arg, index) => arg === existingArgsRedacted[index]);
      const sameTarget =
        existing.transport.command === incoming.transport.command &&
        (existing.transport.cwd ?? undefined) === (incoming.transport.cwd ?? undefined) &&
        sameArgsSkeleton;
      if (!sameTarget) {
        return yield* new HarnessError({
          code: "invalid_config",
          serverId,
          detail:
            "Cannot reuse redacted credentials after changing the stdio command, arguments, or working directory. Re-enter credentials explicitly.",
        });
      }
      if (incoming.injectionMode === "native" && existing.injectionMode !== "native") {
        return yield* new HarnessError({
          code: "invalid_config",
          serverId,
          detail:
            "Cannot switch injection mode to native while reusing redacted credentials. Re-enter credentials explicitly.",
        });
      }
    }
    const existingEnv = existing?.transport.type === "stdio" ? existing.transport.env : undefined;
    const existingArgs = existing?.transport.type === "stdio" ? existing.transport.args : undefined;
    const mergedEnv = yield* mergeRedactedRecord(
      incoming.transport.env,
      existingEnv,
      serverId,
      "env",
    );
    const mergedArgs = yield* mergeRedactedStdioArgs(
      serverId,
      incoming.transport.args,
      existingArgs,
    );
    return {
      ...incoming,
      transport: {
        type: "stdio",
        command: incoming.transport.command,
        ...(mergedArgs ? { args: mergedArgs } : {}),
        ...(incoming.transport.cwd ? { cwd: incoming.transport.cwd } : {}),
        ...(mergedEnv ? { env: mergedEnv } : {}),
      },
    };
  }

  const existingHttp =
    existing !== undefined && existing.transport.type !== "stdio" ? existing.transport : undefined;
  const reusesRedactedUserInfoOrUrl =
    existingHttp !== undefined &&
    incoming.transport.url === redactUrlCredentials(existingHttp.url) &&
    existingHttp.url !== incoming.transport.url;
  const carriesRedacted =
    recordHasRedactedSentinel(incoming.transport.headers) ||
    urlHasRedactedSentinel(incoming.transport.url) ||
    reusesRedactedUserInfoOrUrl;
  if (carriesRedacted) {
    if (
      existing === undefined ||
      existingHttp === undefined ||
      existingHttp.type !== incoming.transport.type
    ) {
      return yield* new HarnessError({
        code: "invalid_config",
        serverId,
        detail:
          "Cannot reuse redacted credentials after changing server transport type. Re-enter credentials explicitly.",
      });
    }
    const existingTarget = httpTargetIdentity(existingHttp.url);
    const incomingTarget = httpTargetIdentity(incoming.transport.url);
    if (existingTarget === null || incomingTarget === null || existingTarget !== incomingTarget) {
      return yield* new HarnessError({
        code: "invalid_config",
        serverId,
        detail:
          "Cannot reuse redacted credentials after changing the server URL origin or path. Re-enter credentials explicitly.",
      });
    }
    if (incoming.injectionMode === "native" && existing.injectionMode !== "native") {
      return yield* new HarnessError({
        code: "invalid_config",
        serverId,
        detail:
          "Cannot switch injection mode to native while reusing redacted credentials. Re-enter credentials explicitly.",
      });
    }
  }

  const sameHttpDestination =
    existing !== undefined &&
    existingHttp !== undefined &&
    existingHttp.type === incoming.transport.type &&
    httpTargetIdentity(existingHttp.url) !== null &&
    httpTargetIdentity(existingHttp.url) === httpTargetIdentity(incoming.transport.url) &&
    !(incoming.injectionMode === "native" && existing.injectionMode !== "native");
  const mergedUrl = yield* mergeRedactedUrl(
    serverId,
    incoming.transport.url,
    sameHttpDestination ? existingHttp.url : undefined,
  );
  const mergedHeaders = yield* mergeRedactedRecord(
    incoming.transport.headers,
    sameHttpDestination ? existingHttp.headers : undefined,
    serverId,
    "headers",
  );
  const oauth = incoming.transport.oauth;
  const authorizationServerUrl = oauth?.authorizationServerUrl
    ? yield* mergeRedactedUrl(
        serverId,
        oauth.authorizationServerUrl,
        sameHttpDestination ? existingHttp.oauth?.authorizationServerUrl : undefined,
      )
    : undefined;
  return {
    ...incoming,
    transport: {
      type: incoming.transport.type,
      url: mergedUrl,
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      ...(oauth
        ? { oauth: { ...oauth, ...(authorizationServerUrl ? { authorizationServerUrl } : {}) } }
        : {}),
    },
  };
});

function scrubUrlForLogs(candidate: string): string {
  const trailing = /[).,;:\]]+$/.exec(candidate)?.[0] ?? "";
  const raw = trailing.length > 0 ? candidate.slice(0, -trailing.length) : candidate;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    if (url.search.length > 0) url.search = "";
    if (url.hash.length > 0) url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

/** Scrubs resolved secret literals and common credential patterns from logs and errors. */
export function scrubHarnessLogText(text: string, secretValues: Iterable<string> = []): string {
  let scrubbed = text;
  for (const secret of secretValues) {
    if (secret.length >= 4) {
      scrubbed = scrubbed.split(secret).join("[REDACTED]");
    }
  }
  return scrubbed
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, scrubUrlForLogs)
    .replace(/\b(Bearer|Basic|Token)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'][\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /((?:--?[\w-]*|(?<![\w-])[\w-]*)(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|xox[baprs])-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED]");
}

export function formatRedactedStdioCommandForLog(
  command: string,
  args: ReadonlyArray<string>,
): string {
  const redactedArgs = redactStdioArgs(args) ?? [];
  const safeArgs = redactedArgs.map((arg) =>
    scrubHarnessLogText(arg.split(HARNESS_SECRET_REDACTED).join("[REDACTED]")),
  );
  return safeArgs.length > 0 ? `${command} ${safeArgs.join(" ")}` : command;
}

// Keep only neutral OS/runtime variables when spawning user-configured stdio MCP servers,
// stripping ambient provider API keys and session tokens (per docs/internals/03_providers.md).
const SAFE_BASE_ENV_KEYS: ReadonlyArray<string> = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export function buildSafeStdioBaseEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SAFE_BASE_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export interface SecretInterpolationResult {
  readonly resolved: Record<string, string>;
  readonly missingPlaceholders: ReadonlyArray<string>;
  /** Raw secret values resolved or provided literally, used solely to scrub logs/errors. */
  readonly sensitiveValues: ReadonlyArray<string>;
}

interface ParsedPlaceholder {
  readonly fullMatch: string;
  readonly first: string;
  readonly second: string | undefined;
}

function collectPlaceholders(
  record: Readonly<Record<string, string>>,
): ReadonlyArray<ParsedPlaceholder> {
  const seen = new Map<string, ParsedPlaceholder>();
  for (const value of Object.values(record)) {
    for (const match of value.matchAll(SECRET_PLACEHOLDER_PATTERN)) {
      const fullMatch = match[0];
      const first = match[1];
      const second = match[2];
      if (first !== undefined && !seen.has(fullMatch)) {
        seen.set(fullMatch, { fullMatch, first, second });
      }
    }
  }
  return Array.from(seen.values());
}

/**
 * Resolves `${secret:...}` placeholders in an env or headers map on the server.
 * Local `${secret:NAME}` lookups are confined strictly to the `harness-secret-` namespace.
 */
export const resolveSecretRecord = Effect.fn("HarnessSecrets.resolveSecretRecord")(function* (
  record: Readonly<Record<string, string>> | undefined,
): Effect.fn.Return<
  SecretInterpolationResult,
  never,
  SecretResolver.SecretResolver | ServerSecretStore.ServerSecretStore
> {
  if (record === undefined || Object.keys(record).length === 0) {
    return { resolved: {}, missingPlaceholders: [], sensitiveValues: [] };
  }
  const placeholders = collectPlaceholders(record);
  const sensitiveValues = new Set<string>();
  for (const rawValue of Object.values(record)) {
    const trimmed = rawValue.trim();
    if (trimmed.length >= 4 && !SAFE_PLACEHOLDER_ONLY_VALUE.test(trimmed)) {
      sensitiveValues.add(trimmed);
    }
  }

  if (placeholders.length === 0) {
    return {
      resolved: { ...record },
      missingPlaceholders: [],
      sensitiveValues: Array.from(sensitiveValues),
    };
  }

  const secretResolver = yield* SecretResolver.SecretResolver;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const providerPlaceholders = placeholders.filter((item) => item.second !== undefined);
  const localPlaceholders = placeholders.filter((item) => item.second === undefined);

  const valuesByMatch = new Map<string, string>();
  const missing: Array<string> = [];

  if (providerPlaceholders.length > 0) {
    const refs: ReadonlyArray<SecretReference> = providerPlaceholders.map((item) => ({
      provider: SecretProviderId.make(item.first),
      reference: item.second!,
    }));
    const providerValues = yield* secretResolver.read(refs);
    providerPlaceholders.forEach((item, index) => {
      const value = providerValues[index];
      if (value !== undefined) {
        valuesByMatch.set(item.fullMatch, value);
        if (value.length >= 4) sensitiveValues.add(value);
      } else {
        missing.push(item.fullMatch);
      }
    });
  }

  for (const item of localPlaceholders) {
    const scopedKey = harnessLocalSecretKey(item.first);
    if (scopedKey === null) {
      missing.push(item.fullMatch);
      continue;
    }
    const stored = yield* secretStore.get(scopedKey).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isSome(stored)) {
      valuesByMatch.set(item.fullMatch, stored.value);
      if (stored.value.length >= 4) sensitiveValues.add(stored.value);
    } else {
      missing.push(item.fullMatch);
    }
  }

  const resolved: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    const nextValue = rawValue.replace(
      SECRET_PLACEHOLDER_PATTERN,
      (fullMatch) => valuesByMatch.get(fullMatch) ?? fullMatch,
    );
    resolved[key] = nextValue;
    if (nextValue.length >= 4 && valuesByMatch.size > 0) {
      sensitiveValues.add(nextValue);
    }
  }
  return {
    resolved,
    missingPlaceholders: missing,
    sensitiveValues: Array.from(sensitiveValues),
  };
});
