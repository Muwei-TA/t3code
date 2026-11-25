import {
  HarnessError,
  type HarnessMcpImportCandidate,
  type HarnessMcpImportSource,
  type HarnessMcpImportSourcePreview,
  type HarnessMcpServerConfig,
  HarnessMcpServerId,
  isReservedHarnessMcpServerId,
  isValidHarnessHttpUrl,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { configContainsSecretPlaceholder, redactHarnessServerConfig } from "./HarnessSecrets.ts";
import * as HarnessStore from "./HarnessStore.ts";

const decodeServerId = Schema.decodeUnknownOption(HarnessMcpServerId);

function sanitizeImportedServerId(rawId: string): HarnessMcpServerId | null {
  const cleaned = rawId
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 64);
  if (cleaned.length === 0 || isReservedHarnessMcpServerId(cleaned)) return null;
  const decoded = decodeServerId(cleaned);
  return Option.isSome(decoded) ? decoded.value : null;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim();
    if (key.length > 0 && typeof v === "string") {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asStringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && isValidHarnessHttpUrl(value);
}

interface RawImportedEntry {
  readonly id: HarnessMcpServerId;
  readonly config: HarnessMcpServerConfig;
}

interface ScannedRawSource {
  readonly source: HarnessMcpImportSource;
  readonly sourcePath: string;
  readonly found: boolean;
  readonly entries: ReadonlyArray<RawImportedEntry>;
  readonly warnings: ReadonlyArray<string>;
}

/** Parses standard JSON `mcpServers` objects (Claude, Cursor, Antigravity/Gemini). */
export function parseJsonMcpServers(input: {
  readonly rawText: string;
  readonly source: HarnessMcpImportSource;
  readonly sourcePath: string;
}): {
  readonly entries: ReadonlyArray<RawImportedEntry>;
  readonly warnings: ReadonlyArray<string>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawText);
  } catch {
    return {
      entries: [],
      warnings: [`Could not parse ${input.sourcePath}: invalid JSON syntax.`],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { entries: [], warnings: [] };
  }
  const rawMap = Reflect.get(parsed, "mcpServers");
  if (rawMap === null || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    return { entries: [], warnings: [] };
  }

  const entries: Array<RawImportedEntry> = [];
  const warnings: Array<string> = [];

  for (const [rawName, rawEntry] of Object.entries(rawMap)) {
    if (isReservedHarnessMcpServerId(rawName)) {
      continue;
    }
    const id = sanitizeImportedServerId(rawName);
    if (id === null) {
      warnings.push(`Skipped server "${rawName}": could not normalize to a valid id.`);
      continue;
    }
    if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      warnings.push(`Skipped server "${rawName}": expected a configuration object.`);
      continue;
    }
    const record = rawEntry as Record<string, unknown>;
    const disabled = record.disabled === true || record.enabled === false;
    const rawType = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
    const rawCommand = typeof record.command === "string" ? record.command.trim() : "";
    const rawUrl =
      typeof record.url === "string"
        ? record.url.trim()
        : typeof record.serverUrl === "string"
          ? record.serverUrl.trim()
          : typeof record.httpUrl === "string"
            ? record.httpUrl.trim()
            : "";

    let config: HarnessMcpServerConfig | null = null;
    if (rawCommand.length > 0 && rawType !== "http" && rawType !== "sse") {
      const args = asStringArray(record.args);
      const env = asStringRecord(record.env);
      const cwd =
        typeof record.cwd === "string" && record.cwd.trim().length > 0
          ? record.cwd.trim()
          : undefined;
      config = {
        enabled: !disabled,
        transport: {
          type: "stdio",
          command: rawCommand,
          ...(args ? { args } : {}),
          ...(cwd ? { cwd } : {}),
          ...(env ? { env } : {}),
        },
        injectionMode: "gateway",
        approvalPolicy: "auto-read",
        origin: { kind: "imported", source: input.source, sourcePath: input.sourcePath },
      };
    } else if (isHttpUrl(rawUrl)) {
      const headers = asStringRecord(record.headers ?? record.httpHeaders);
      const transportType = rawType === "sse" ? "sse" : "http";
      config = {
        enabled: !disabled,
        transport: {
          type: transportType,
          url: rawUrl,
          ...(headers ? { headers } : {}),
        },
        injectionMode: "gateway",
        approvalPolicy: "auto-read",
        origin: { kind: "imported", source: input.source, sourcePath: input.sourcePath },
      };
    } else {
      warnings.push(`Skipped server "${rawName}": missing a valid command or http(s) url.`);
      continue;
    }

    entries.push({ id, config });
  }

  return { entries, warnings };
}

function unquoteTomlString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (!inSingle && ch === '"') inDouble = !inDouble;
    else if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inDouble && ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseTomlStringArray(raw: string): ReadonlyArray<string> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const items: Array<string> = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inDouble && ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      current += ch;
    } else if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      current += ch;
    } else if (!inSingle && !inDouble && ch === ",") {
      const value = current.trim();
      if (value.length > 0) items.push(unquoteTomlString(value));
      current = "";
    } else {
      current += ch;
    }
  }
  const trailing = current.trim();
  if (trailing.length > 0) items.push(unquoteTomlString(trailing));
  return items;
}

function parseTomlInlineTable(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return {};
  const out: Record<string, string> = {};
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const parts: Array<string> = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inDouble && ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      current += ch;
    } else if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      current += ch;
    } else if (!inSingle && !inDouble && ch === ",") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) parts.push(current);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = unquoteTomlString(part.slice(0, eq).trim());
    const val = unquoteTomlString(part.slice(eq + 1).trim());
    if (key.length > 0) out[key] = val;
  }
  return out;
}

/** Focused read-only parser for Codex `~/.codex/config.toml` `[mcp_servers.<id>]` sections. */
export function parseCodexTomlMcpServers(input: {
  readonly rawText: string;
  readonly sourcePath: string;
}): {
  readonly entries: ReadonlyArray<RawImportedEntry>;
  readonly warnings: ReadonlyArray<string>;
} {
  interface RawCodexServer {
    command?: string;
    args?: ReadonlyArray<string>;
    cwd?: string;
    url?: string;
    enabled?: boolean;
    env: Record<string, string>;
    httpHeaders: Record<string, string>;
  }

  const servers = new Map<string, RawCodexServer>();
  const ensureServer = (name: string): RawCodexServer => {
    let existing = servers.get(name);
    if (!existing) {
      existing = { env: {}, httpHeaders: {} };
      servers.set(name, existing);
    }
    return existing;
  };

  let activeServer: string | null = null;
  let activeSubtable: "root" | "env" | "http_headers" | null = null;

  const lines = input.rawText.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripTomlComment(lines[i]!).trim();
    if (line.length === 0) continue;

    if (line.startsWith("[") && line.endsWith("]") && !line.startsWith("[[")) {
      const header = line.slice(1, -1).trim();
      const match = /^mcp_servers\.("([^"]+)"|'([^']+)'|([^.\s]+))(?:\.(env|http_headers))?$/u.exec(
        header,
      );
      if (match) {
        activeServer = match[2] ?? match[3] ?? match[4] ?? null;
        activeSubtable = (match[5] as "env" | "http_headers" | undefined) ?? "root";
        if (activeServer) ensureServer(activeServer);
      } else {
        activeServer = null;
        activeSubtable = null;
      }
      continue;
    }

    if (activeServer === null || activeSubtable === null) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const rawKey = unquoteTomlString(line.slice(0, eq).trim());
    let rawVal = line.slice(eq + 1).trim();

    // Join multi-line arrays like `args = [\n  "...",\n]`.
    while (rawVal.startsWith("[") && !rawVal.endsWith("]") && i + 1 < lines.length) {
      i += 1;
      rawVal += ` ${stripTomlComment(lines[i]!).trim()}`;
    }

    const target = ensureServer(activeServer);
    if (activeSubtable === "env") {
      target.env[rawKey] = unquoteTomlString(rawVal);
    } else if (activeSubtable === "http_headers") {
      target.httpHeaders[rawKey] = unquoteTomlString(rawVal);
    } else {
      if (rawKey === "command") target.command = unquoteTomlString(rawVal);
      else if (rawKey === "cwd") target.cwd = unquoteTomlString(rawVal);
      else if (rawKey === "url") target.url = unquoteTomlString(rawVal);
      else if (rawKey === "enabled") target.enabled = rawVal === "true";
      else if (rawKey === "args") target.args = parseTomlStringArray(rawVal);
      else if (rawKey === "env" && rawVal.startsWith("{")) {
        Object.assign(target.env, parseTomlInlineTable(rawVal));
      } else if (rawKey === "http_headers" && rawVal.startsWith("{")) {
        Object.assign(target.httpHeaders, parseTomlInlineTable(rawVal));
      }
    }
  }

  const entries: Array<RawImportedEntry> = [];
  const warnings: Array<string> = [];

  for (const [rawName, raw] of servers.entries()) {
    if (isReservedHarnessMcpServerId(rawName)) {
      continue;
    }
    const id = sanitizeImportedServerId(rawName);
    if (id === null) {
      warnings.push(`Skipped Codex server "${rawName}": invalid server id.`);
      continue;
    }
    const enabled = raw.enabled !== false;
    if (raw.command && raw.command.trim().length > 0) {
      entries.push({
        id,
        config: {
          enabled,
          transport: {
            type: "stdio",
            command: raw.command.trim(),
            ...(raw.args && raw.args.length > 0 ? { args: raw.args } : {}),
            ...(raw.cwd && raw.cwd.trim().length > 0 ? { cwd: raw.cwd.trim() } : {}),
            ...(Object.keys(raw.env).length > 0 ? { env: raw.env } : {}),
          },
          injectionMode: "gateway",
          approvalPolicy: "auto-read",
          origin: { kind: "imported", source: "codex", sourcePath: input.sourcePath },
        },
      });
    } else if (isHttpUrl(raw.url)) {
      entries.push({
        id,
        config: {
          enabled,
          transport: {
            type: "http",
            url: raw.url.trim(),
            ...(Object.keys(raw.httpHeaders).length > 0 ? { headers: raw.httpHeaders } : {}),
          },
          injectionMode: "gateway",
          approvalPolicy: "auto-read",
          origin: { kind: "imported", source: "codex", sourcePath: input.sourcePath },
        },
      });
    } else {
      warnings.push(`Skipped Codex server "${rawName}": missing command or url.`);
    }
  }

  return { entries, warnings };
}

export class HarnessImporter extends Context.Service<
  HarnessImporter,
  {
    /** Returns redacted candidate previews (literal env/header values never leave the server). */
    readonly scan: Effect.Effect<ReadonlyArray<HarnessMcpImportSourcePreview>>;
    /** Resolves selected `(source, id)` pairs directly from local CLI configs on disk. */
    readonly apply: <E = never>(input: {
      readonly items: ReadonlyArray<{
        readonly source: HarnessMcpImportSource;
        readonly id: HarnessMcpServerId;
        readonly expectedDigest?: string | undefined;
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
  }
>()("t3/harness/HarnessImporter") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = yield* HostProcess.HomeDirectory;
  const store = yield* HarnessStore.HarnessStore;

  const readFileIfPresent = (filePath: string) =>
    fs.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const scanRawSources = Effect.fn("HarnessImporter.scanRawSources")(function* () {
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    const claudePath = path.join(homeDir, ".claude.json");
    const cursorPath = path.join(homeDir, ".cursor", "mcp.json");
    const antigravityPrimaryPath = path.join(homeDir, ".gemini", "antigravity", "mcp_config.json");
    const antigravityFallbackPath = path.join(homeDir, ".gemini", "settings.json");

    const [codexRaw, claudeRaw, cursorRaw, antigravityPrimaryRaw, antigravityFallbackRaw] =
      yield* Effect.all(
        [
          readFileIfPresent(codexPath),
          readFileIfPresent(claudePath),
          readFileIfPresent(cursorPath),
          readFileIfPresent(antigravityPrimaryPath),
          readFileIfPresent(antigravityFallbackPath),
        ],
        { concurrency: "unbounded" },
      );

    const sources: Array<ScannedRawSource> = [];

    if (Option.isSome(codexRaw)) {
      const parsed = parseCodexTomlMcpServers({ rawText: codexRaw.value, sourcePath: codexPath });
      sources.push({
        source: "codex",
        sourcePath: codexPath,
        found: true,
        entries: parsed.entries,
        warnings: parsed.warnings,
      });
    } else {
      sources.push({
        source: "codex",
        sourcePath: codexPath,
        found: false,
        entries: [],
        warnings: [],
      });
    }

    if (Option.isSome(claudeRaw)) {
      const parsed = parseJsonMcpServers({
        rawText: claudeRaw.value,
        source: "claude",
        sourcePath: claudePath,
      });
      sources.push({
        source: "claude",
        sourcePath: claudePath,
        found: true,
        entries: parsed.entries,
        warnings: parsed.warnings,
      });
    } else {
      sources.push({
        source: "claude",
        sourcePath: claudePath,
        found: false,
        entries: [],
        warnings: [],
      });
    }

    if (Option.isSome(cursorRaw)) {
      const parsed = parseJsonMcpServers({
        rawText: cursorRaw.value,
        source: "cursor",
        sourcePath: cursorPath,
      });
      sources.push({
        source: "cursor",
        sourcePath: cursorPath,
        found: true,
        entries: parsed.entries,
        warnings: parsed.warnings,
      });
    } else {
      sources.push({
        source: "cursor",
        sourcePath: cursorPath,
        found: false,
        entries: [],
        warnings: [],
      });
    }

    if (Option.isSome(antigravityPrimaryRaw)) {
      const parsed = parseJsonMcpServers({
        rawText: antigravityPrimaryRaw.value,
        source: "antigravity",
        sourcePath: antigravityPrimaryPath,
      });
      sources.push({
        source: "antigravity",
        sourcePath: antigravityPrimaryPath,
        found: true,
        entries: parsed.entries,
        warnings: parsed.warnings,
      });
    } else if (Option.isSome(antigravityFallbackRaw)) {
      const parsed = parseJsonMcpServers({
        rawText: antigravityFallbackRaw.value,
        source: "antigravity",
        sourcePath: antigravityFallbackPath,
      });
      sources.push({
        source: "antigravity",
        sourcePath: antigravityFallbackPath,
        found: true,
        entries: parsed.entries,
        warnings: parsed.warnings,
      });
    } else {
      sources.push({
        source: "antigravity",
        sourcePath: antigravityPrimaryPath,
        found: false,
        entries: [],
        warnings: [],
      });
    }

    return sources;
  });

  const classifyCandidates = (
    entries: ReadonlyArray<RawImportedEntry>,
    existingMap: Readonly<Record<string, HarnessMcpServerConfig>>,
  ): ReadonlyArray<HarnessMcpImportCandidate> =>
    entries.map(({ id, config }) => {
      const redactedConfig = redactHarnessServerConfig(config);
      const previewDigest = store.computeConfirmationDigest(config);
      const hasSecretPlaceholders = configContainsSecretPlaceholder(config);
      const existing = existingMap[id];
      if (existing === undefined) {
        return {
          id,
          config: redactedConfig,
          previewDigest,
          existingDigest: null,
          hasSecretPlaceholders,
          conflict: "none" as const,
        };
      }
      const existingDigest = store.computeConfirmationDigest(existing);
      const same = existingDigest === previewDigest;
      return {
        id,
        config: redactedConfig,
        previewDigest,
        existingDigest,
        hasSecretPlaceholders,
        conflict: same ? ("exists_identical" as const) : ("exists_different" as const),
      };
    });

  const scan: HarnessImporter["Service"]["scan"] = Effect.gen(function* () {
    const [{ config: currentUserConfig }, rawSources] = yield* Effect.all([
      store.loadUserConfig,
      scanRawSources(),
    ]);
    const existingMap = currentUserConfig.mcpServers;

    return rawSources.map((src) => ({
      source: src.source,
      sourcePath: src.sourcePath,
      found: src.found,
      candidates: classifyCandidates(src.entries, existingMap),
      warnings: src.warnings,
    }));
  }).pipe(Effect.withSpan("HarnessImporter.scan"));

  const apply: HarnessImporter["Service"]["apply"] = Effect.fn("HarnessImporter.apply")(function* <
    E = never,
  >({
    items,
    overwriteExisting,
    authorize,
  }: {
    readonly items: ReadonlyArray<{
      readonly source: HarnessMcpImportSource;
      readonly id: HarnessMcpServerId;
      readonly expectedDigest?: string | undefined;
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
    const rawSources = yield* scanRawSources();
    const sourceIndex = new Map<string, HarnessMcpServerConfig>();
    for (const src of rawSources) {
      for (const entry of src.entries) {
        sourceIndex.set(`${src.source}\u0000${entry.id}`, entry.config);
      }
    }

    const selectedEntries: Array<{
      readonly id: HarnessMcpServerId;
      readonly config: HarnessMcpServerConfig;
      readonly expectedExistingDigest?: string | null | undefined;
    }> = [];
    for (const item of items) {
      const rawConfig = sourceIndex.get(`${item.source}\u0000${item.id}`);
      if (rawConfig === undefined) {
        return yield* new HarnessError({
          code: "not_found",
          serverId: item.id,
          detail: `Import candidate "${item.id}" was not found in ${item.source} configuration.`,
        });
      }
      if (
        item.expectedDigest !== undefined &&
        store.computeConfirmationDigest(rawConfig) !== item.expectedDigest
      ) {
        return yield* new HarnessError({
          code: "invalid_config",
          serverId: item.id,
          detail: `Import candidate "${item.id}" changed since preview. Rescan and review before importing.`,
        });
      }
      selectedEntries.push({
        id: item.id,
        config: rawConfig,
        ...(item.expectedExistingDigest !== undefined
          ? { expectedExistingDigest: item.expectedExistingDigest }
          : {}),
      });
    }

    // Authorize every selected config before acquiring the store write lock, then verify target
    // existence and expected target digests atomically inside HarnessStore's write lock.
    if (authorize !== undefined) {
      for (const entry of selectedEntries) {
        yield* authorize(entry.config);
      }
    }

    return yield* store.importUserServers({
      entries: selectedEntries,
      overwriteExisting,
      ...(authorize ? { authorize } : {}),
    });
  });

  return HarnessImporter.of({ scan, apply });
});

export const layer = Layer.effect(HarnessImporter, make);
