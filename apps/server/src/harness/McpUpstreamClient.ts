// @effect-diagnostics nodeBuiltinImport:off -- Spawns stdio MCP servers with process-group teardown and line-framed JSON-RPC.
// @effect-diagnostics globalJsonInEffect:off -- Relays opaque upstream MCP JSON-RPC tool schemas and results verbatim.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import {
  HarnessError,
  type HarnessMcpLogLine,
  type HarnessMcpServerId,
  type HarnessMcpTransport,
  IsoDateTime,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  buildSafeStdioBaseEnv,
  formatRedactedStdioCommandForLog,
  scrubHarnessLogText,
} from "./HarnessSecrets.ts";

const isHarnessError = Schema.is(HarnessError);

const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000;
const CLOSE_DELETE_TIMEOUT_MS = 3_000;
const MAX_SAME_ORIGIN_REDIRECTS = 2;
const MAX_RING_LOG_LINES = 200;

interface UpstreamOAuth {
  readonly bearer: Effect.Effect<string | undefined, HarnessError>;
  readonly unauthorized: (
    header: string | null,
    rejectedBearer: string | undefined,
  ) => Effect.Effect<string, HarnessError>;
  readonly logs: RingLogBuffer;
}

export interface UpstreamMcpTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean | undefined } | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface UpstreamMcpCallResult {
  readonly content: ReadonlyArray<Record<string, unknown>>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface UpstreamMcpResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface UpstreamMcpResourceReadResult {
  readonly contents: ReadonlyArray<Record<string, unknown>>;
}

export interface McpUpstreamConnection {
  readonly listTools: () => Effect.Effect<ReadonlyArray<UpstreamMcpTool>, HarnessError>;
  readonly callTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<UpstreamMcpCallResult, HarnessError>;
  readonly listResources?: () => Effect.Effect<ReadonlyArray<UpstreamMcpResource>, HarnessError>;
  readonly readResource?: (
    uri: string,
  ) => Effect.Effect<UpstreamMcpResourceReadResult, HarnessError>;
  readonly close: () => Effect.Effect<void>;
  readonly isClosed: () => boolean;
}

export class RingLogBuffer {
  readonly #lines: Array<HarnessMcpLogLine> = [];
  readonly #secrets = new Set<string>();

  addSecretValues(values: Iterable<string>): void {
    for (const value of values) {
      if (value.length >= 4) this.#secrets.add(value);
    }
    while (this.#secrets.size > 256) this.#secrets.delete(this.#secrets.values().next().value!);
  }

  redact(text: string): string {
    return scrubHarnessLogText(text, this.#secrets);
  }

  append(stream: "stderr" | "lifecycle", text: string): void {
    const trimmed = this.redact(text.replace(/\r?\n$/u, ""));
    if (trimmed.length === 0) return;
    this.#lines.push({
      timestamp: IsoDateTime.make(DateTime.formatIso(DateTime.nowUnsafe())),
      stream,
      text: trimmed.slice(0, 2000),
    });
    if (this.#lines.length > MAX_RING_LOG_LINES) {
      this.#lines.splice(0, this.#lines.length - MAX_RING_LOG_LINES);
    }
  }

  snapshot(): ReadonlyArray<HarnessMcpLogLine> {
    return [...this.#lines];
  }

  count(): number {
    return this.#lines.length;
  }
}

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function asJsonRpcMessage(value: unknown): JsonRpcMessage | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRpcMessage)
    : null;
}

function parseToolsFromResult(result: unknown): ReadonlyArray<UpstreamMcpTool> {
  if (result === null || typeof result !== "object") return [];
  const rawTools = Reflect.get(result, "tools");
  if (!Array.isArray(rawTools)) return [];
  const tools: Array<UpstreamMcpTool> = [];
  for (const raw of rawTools) {
    if (raw === null || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.name !== "string" || rec.name.trim().length === 0) continue;
    const rawSchema = rec.inputSchema;
    const inputSchema =
      rawSchema !== null && typeof rawSchema === "object" && !Array.isArray(rawSchema)
        ? (rawSchema as Record<string, unknown>)
        : { type: "object", properties: {} };
    const rawAnnotations = rec.annotations;
    const readOnlyHint =
      rawAnnotations !== null &&
      typeof rawAnnotations === "object" &&
      Reflect.get(rawAnnotations, "readOnlyHint") === true;
    const meta =
      rec._meta !== null && typeof rec._meta === "object" && !Array.isArray(rec._meta)
        ? (rec._meta as Record<string, unknown>)
        : undefined;
    tools.push({
      name: rec.name,
      description: typeof rec.description === "string" ? rec.description : undefined,
      inputSchema,
      ...(readOnlyHint ? { annotations: { readOnlyHint: true } } : {}),
      ...(meta ? { _meta: meta } : {}),
    });
  }
  return tools;
}

function parseCallResult(result: unknown): UpstreamMcpCallResult {
  if (result === null || typeof result !== "object") {
    return { content: [{ type: "text", text: String(result ?? "") }] };
  }
  const rec = result as Record<string, unknown>;
  const content = Array.isArray(rec.content)
    ? rec.content.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const meta =
    rec._meta !== null && typeof rec._meta === "object" && !Array.isArray(rec._meta)
      ? (rec._meta as Record<string, unknown>)
      : undefined;
  return {
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    ...(rec.structuredContent !== undefined ? { structuredContent: rec.structuredContent } : {}),
    ...(rec.isError === true ? { isError: true } : {}),
    ...(meta ? { _meta: meta } : {}),
  };
}

function parseResourcesFromResult(result: unknown): ReadonlyArray<UpstreamMcpResource> {
  if (result === null || typeof result !== "object") return [];
  const rawResources = Reflect.get(result, "resources");
  if (!Array.isArray(rawResources)) return [];
  const resources: Array<UpstreamMcpResource> = [];
  for (const raw of rawResources) {
    if (raw === null || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.uri !== "string" || rec.uri.trim().length === 0) continue;
    const name =
      typeof rec.name === "string" && rec.name.trim().length > 0 ? rec.name.trim() : rec.uri;
    const meta =
      rec._meta !== null && typeof rec._meta === "object" && !Array.isArray(rec._meta)
        ? (rec._meta as Record<string, unknown>)
        : undefined;
    resources.push({
      uri: rec.uri,
      name,
      ...(typeof rec.description === "string" ? { description: rec.description } : {}),
      ...(typeof rec.mimeType === "string" ? { mimeType: rec.mimeType } : {}),
      ...(meta ? { _meta: meta } : {}),
    });
  }
  return resources;
}

function parseResourceReadResult(result: unknown): UpstreamMcpResourceReadResult {
  if (result === null || typeof result !== "object") {
    return { contents: [] };
  }
  const rawContents = Reflect.get(result, "contents");
  if (!Array.isArray(rawContents)) return { contents: [] };
  return {
    contents: rawContents.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    ),
  };
}

/**
 * Signals the detached POSIX process group (`-pid`) even if the group leader
 * already exited, so surviving grandchildren are always reaped.
 */
function terminateChildProcess(child: NodeChildProcess.ChildProcess, platform: string): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process group already gone.
        }
      }
    }
    // @effect-diagnostics-next-line globalTimers:off -- SIGKILL fallback after SIGTERM on detached process group teardown.
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Process group already exited.
      }
    }, 2_000);
    timer.unref();
    return;
  }

  if (child.exitCode !== null || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already exited.
  }
  // @effect-diagnostics-next-line globalTimers:off -- SIGKILL fallback after SIGTERM on Windows child teardown.
  const timer = setTimeout(() => {
    if (child.exitCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, 2_000);
  timer.unref();
}

const connectStdioUpstream = Effect.fn("McpUpstreamClient.connectStdio")(function* (input: {
  readonly serverId: HarnessMcpServerId;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly resolvedEnv: Readonly<Record<string, string>>;
  readonly sensitiveValues: ReadonlyArray<string>;
  readonly logs: RingLogBuffer;
}): Effect.fn.Return<McpUpstreamConnection, HarnessError> {
  const platform = yield* HostProcess.Platform;
  input.logs.addSecretValues(input.sensitiveValues);
  const env: NodeJS.ProcessEnv = {
    ...buildSafeStdioBaseEnv(process.env),
    ...input.resolvedEnv,
  };
  input.logs.append(
    "lifecycle",
    `Spawning stdio MCP server: ${formatRedactedStdioCommandForLog(input.command, input.args)}`,
  );

  const child = yield* Effect.try({
    try: () =>
      NodeChildProcess.spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group on POSIX so teardown reaps the whole subprocess tree.
        detached: platform !== "win32",
      }),
    catch: (cause) => {
      const message = scrubHarnessLogText(
        cause instanceof Error ? cause.message : String(cause),
        input.sensitiveValues,
      );
      input.logs.append("lifecycle", `Failed to spawn: ${message}`);
      return new HarnessError({
        code: "upstream_error",
        serverId: input.serverId,
        detail: `Failed to start MCP server "${input.serverId}": ${message}`,
      });
    },
  });

  let closed = false;
  let nextId = 1;
  const pending = new Map<
    number,
    {
      readonly resolve: (value: JsonRpcMessage) => void;
      readonly reject: (error: HarnessError) => void;
    }
  >();

  const failAllPending = (reason: string) => {
    const safeReason = scrubHarnessLogText(reason, input.sensitiveValues);
    for (const [id, entry] of pending) {
      entry.reject(
        new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: safeReason,
        }),
      );
      pending.delete(id);
    }
  };

  const errRl = child.stderr ? NodeReadline.createInterface({ input: child.stderr }) : null;
  errRl?.on("line", (line) => input.logs.append("stderr", line));

  const outRl = child.stdout ? NodeReadline.createInterface({ input: child.stdout }) : null;
  outRl?.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      input.logs.append("stderr", `[non-json stdout] ${trimmed}`);
      return;
    }
    const msg = asJsonRpcMessage(parsed);
    if (msg === null) return;
    // Answer server-initiated pings so well-behaved servers stay alive.
    if (msg.id !== undefined && msg.method === "ping") {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
      return;
    }
    if (typeof msg.id === "number") {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  });

  const cleanupProcess = (reason: string) => {
    const wasClosed = closed;
    closed = true;
    errRl?.close();
    outRl?.close();
    if (!wasClosed) {
      failAllPending(reason);
    }
    terminateChildProcess(child, platform);
  };

  child.on("error", (error) => {
    const safeMessage = scrubHarnessLogText(error.message, input.sensitiveValues);
    closed = true;
    input.logs.append("lifecycle", `Process error: ${safeMessage}`);
    failAllPending(`MCP server "${input.serverId}" errored: ${safeMessage}`);
  });

  child.on("exit", (code, signal) => {
    closed = true;
    errRl?.close();
    outRl?.close();
    input.logs.append(
      "lifecycle",
      `Process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
    failAllPending(
      `MCP server "${input.serverId}" exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
    );
  });

  const sendRequest = (
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Effect.Effect<JsonRpcMessage, HarnessError> =>
    Effect.callback<JsonRpcMessage, HarnessError>((resume) => {
      if (closed || !child.stdin || child.stdin.destroyed) {
        resume(
          Effect.fail(
            new HarnessError({
              code: "upstream_error",
              serverId: input.serverId,
              detail: `MCP server "${input.serverId}" is not running.`,
            }),
          ),
        );
        return;
      }
      const id = nextId++;
      pending.set(id, {
        resolve: (value) => resume(Effect.succeed(value)),
        reject: (error) => resume(Effect.fail(error)),
      });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      child.stdin.write(`${payload}\n`, (error) => {
        if (error) {
          pending.delete(id);
          resume(
            Effect.fail(
              new HarnessError({
                code: "upstream_error",
                serverId: input.serverId,
                detail: scrubHarnessLogText(
                  `Failed writing to MCP server "${input.serverId}": ${error.message}`,
                  input.sensitiveValues,
                ),
              }),
            ),
          );
        }
      });
      return Effect.sync(() => {
        pending.delete(id);
      });
    }).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new HarnessError({
                code: "upstream_error",
                serverId: input.serverId,
                detail: `MCP server "${input.serverId}" timed out waiting for ${method}.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const sendNotification = (method: string, params: unknown) =>
    Effect.sync(() => {
      if (!closed && child.stdin && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      }
    });

  // Always terminate the spawned process group on failure OR fiber interruption anywhere during startup.
  yield* Effect.gen(function* () {
    const initResponse = yield* sendRequest(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-harness-gateway", version: "1.0.0" },
      },
      DEFAULT_INIT_TIMEOUT_MS,
    );

    if (initResponse.error !== undefined) {
      return yield* new HarnessError({
        code: "upstream_error",
        serverId: input.serverId,
        detail: scrubHarnessLogText(
          `MCP server "${input.serverId}" initialize failed: ${String(initResponse.error.message ?? "unknown error")}`,
          input.sensitiveValues,
        ),
      });
    }

    yield* sendNotification("notifications/initialized", {});
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.sync(() => {
            cleanupProcess(`MCP server "${input.serverId}" initialization aborted.`);
          }),
    ),
  );
  input.logs.append("lifecycle", "Initialized stdio MCP session.");

  return {
    listTools: () =>
      sendRequest("tools/list", {}, DEFAULT_INIT_TIMEOUT_MS).pipe(
        Effect.flatMap((msg) =>
          msg.error !== undefined
            ? Effect.fail(
                new HarnessError({
                  code: "upstream_error",
                  serverId: input.serverId,
                  detail: scrubHarnessLogText(
                    `tools/list failed: ${String(msg.error.message ?? "unknown error")}`,
                    input.sensitiveValues,
                  ),
                }),
              )
            : Effect.succeed(parseToolsFromResult(msg.result)),
        ),
      ),
    callTool: (name, args) =>
      sendRequest("tools/call", { name, arguments: args }, DEFAULT_TOOL_CALL_TIMEOUT_MS).pipe(
        Effect.flatMap((msg) =>
          msg.error !== undefined
            ? Effect.fail(
                new HarnessError({
                  code: "upstream_error",
                  serverId: input.serverId,
                  detail: scrubHarnessLogText(
                    `tools/call(${name}) failed: ${String(msg.error.message ?? "unknown error")}`,
                    input.sensitiveValues,
                  ),
                }),
              )
            : Effect.succeed(parseCallResult(msg.result)),
        ),
      ),
    listResources: () =>
      sendRequest("resources/list", {}, DEFAULT_INIT_TIMEOUT_MS).pipe(
        Effect.flatMap((msg) =>
          msg.error !== undefined
            ? Effect.succeed([] as ReadonlyArray<UpstreamMcpResource>)
            : Effect.succeed(parseResourcesFromResult(msg.result)),
        ),
      ),
    readResource: (uri) =>
      sendRequest("resources/read", { uri }, DEFAULT_TOOL_CALL_TIMEOUT_MS).pipe(
        Effect.flatMap((msg) =>
          msg.error !== undefined
            ? Effect.fail(
                new HarnessError({
                  code: "upstream_error",
                  serverId: input.serverId,
                  detail: scrubHarnessLogText(
                    `resources/read(${uri}) failed: ${String(msg.error.message ?? "unknown error")}`,
                    input.sensitiveValues,
                  ),
                }),
              )
            : Effect.succeed(parseResourceReadResult(msg.result)),
        ),
      ),
    close: () =>
      Effect.sync(() => {
        if (!closed) {
          input.logs.append("lifecycle", "Stopping stdio MCP server.");
        }
        cleanupProcess(`MCP server "${input.serverId}" was stopped.`);
      }),
    isClosed: () => closed,
  };
});

function originOfUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function resolveRelativeUrl(location: string, base: string): URL | null {
  try {
    return new URL(location, base);
  } catch {
    return null;
  }
}

/**
 * Fetches an MCP upstream URL with `redirect: "manual"` and refuses any cross-origin
 * redirect so Authorization/secret headers can never be forwarded to a third-party origin.
 */
const fetchSameOriginOnly = Effect.fn("McpUpstreamClient.fetchSameOriginOnly")(function* (input: {
  readonly serverId: HarnessMcpServerId;
  readonly allowedOrigin: string;
  readonly url: string;
  readonly init: Omit<RequestInit, "redirect">;
  readonly timeoutMs: number;
  /** When true, applies timeout only while awaiting response headers so long-lived streams stay open. */
  readonly timeoutAppliesToHeadersOnly?: boolean;
  readonly sensitiveValues: ReadonlyArray<string>;
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  readonly oauth?: UpstreamOAuth | undefined;
}): Effect.fn.Return<Response, HarnessError> {
  const mapFetchError = (cause: unknown): HarnessError =>
    isHarnessError(cause)
      ? cause
      : new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: scrubHarnessLogText(
            `HTTP MCP server "${input.serverId}" error: ${cause instanceof Error ? cause.message : String(cause)}`,
            input.sensitiveValues,
          ),
        });

  let currentUrl = input.url;
  let oauthBearer = input.oauth === undefined ? undefined : yield* input.oauth.bearer;
  let refreshed = false;
  for (let hop = 0; hop <= MAX_SAME_ORIGIN_REDIRECTS; hop += 1) {
    const currentOrigin = originOfUrl(currentUrl);
    if (currentOrigin === null || currentOrigin !== input.allowedOrigin) {
      return yield* new HarnessError({
        code: "upstream_error",
        serverId: input.serverId,
        detail: `Refused cross-origin request for MCP server "${input.serverId}".`,
      });
    }

    const headers = new Headers(input.init.headers);
    if (input.oauth !== undefined) {
      headers.delete("authorization");
      if (oauthBearer !== undefined) {
        input.oauth.logs.addSecretValues([oauthBearer]);
        headers.set("authorization", `Bearer ${oauthBearer}`);
      }
    }
    const response = input.timeoutAppliesToHeadersOnly
      ? yield* Effect.tryPromise({
          try: (signal) => {
            const signals = input.init.signal ? [signal, input.init.signal] : [signal];
            return input.fetchImpl(currentUrl, {
              ...input.init,
              headers,
              redirect: "manual",
              signal: AbortSignal.any(signals),
            });
          },
          catch: mapFetchError,
        }).pipe(
          Effect.timeoutOption(Duration.millis(input.timeoutMs)),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new HarnessError({
                    code: "upstream_error",
                    serverId: input.serverId,
                    detail: `HTTP MCP server "${input.serverId}" timed out waiting for response headers.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        )
      : yield* Effect.tryPromise({
          try: (signal) => {
            const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
            const signals = input.init.signal
              ? [signal, timeoutSignal, input.init.signal]
              : [signal, timeoutSignal];
            return input.fetchImpl(currentUrl, {
              ...input.init,
              headers,
              redirect: "manual",
              signal: AbortSignal.any(signals),
            });
          },
          catch: mapFetchError,
        });

    if (
      response.status === 401 &&
      input.oauth !== undefined &&
      input.init.method !== "DELETE" &&
      (oauthBearer !== undefined ||
        /^\s*Bearer\b/i.test(response.headers.get("www-authenticate") ?? ""))
    ) {
      const challenge = response.headers.get("www-authenticate");
      yield* discardResponseBody(response);
      if (refreshed)
        return yield* new HarnessError({
          code: "auth_required",
          serverId: input.serverId,
          detail: "Sign in to this MCP server in Harness settings.",
        });
      oauthBearer = yield* input.oauth.unauthorized(challenge, oauthBearer);
      refreshed = true;
      hop -= 1;
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      yield* discardResponseBody(response);
      if (oauthBearer !== undefined)
        return yield* new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: "Refused redirect from an OAuth-authenticated MCP endpoint.",
        });
      if (!location) {
        return yield* new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: `HTTP MCP server "${input.serverId}" returned redirect HTTP ${response.status} without Location.`,
        });
      }
      const nextUrl = resolveRelativeUrl(location, currentUrl);
      if (nextUrl === null) {
        return yield* new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: `HTTP MCP server "${input.serverId}" returned an invalid redirect target.`,
        });
      }
      if (nextUrl.origin !== input.allowedOrigin) {
        return yield* new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: `Refused cross-origin redirect for MCP server "${input.serverId}" to protect credentials.`,
        });
      }
      if (hop === MAX_SAME_ORIGIN_REDIRECTS) {
        return yield* new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: `HTTP MCP server "${input.serverId}" exceeded maximum same-origin redirects.`,
        });
      }
      currentUrl = nextUrl.toString();
      continue;
    }

    return response;
  }

  return yield* new HarnessError({
    code: "upstream_error",
    serverId: input.serverId,
    detail: `HTTP MCP server "${input.serverId}" redirect loop aborted.`,
  });
});

// Fixed message avoids leaking raw or whitespace-trimmed header values formatted by the Fetch Headers constructor.
const buildSafeHttpHeaders = (input: {
  readonly serverId: HarnessMcpServerId;
  readonly resolvedHeaders: Readonly<Record<string, string>>;
  readonly overrides: ReadonlyArray<readonly [string, string]>;
}): Effect.Effect<Headers, HarnessError> =>
  Effect.try({
    try: () => {
      const headers = new Headers(input.resolvedHeaders);
      for (const [key, value] of input.overrides) {
        headers.set(key, value);
      }
      return headers;
    },
    catch: () =>
      new HarnessError({
        code: "invalid_config",
        serverId: input.serverId,
        detail: `Invalid HTTP header configuration for MCP server "${input.serverId}".`,
      }),
  });

const connectHttpUpstream = Effect.fn("McpUpstreamClient.connectHttp")(function* (input: {
  readonly serverId: HarnessMcpServerId;
  readonly transportType: "http" | "sse";
  readonly url: string;
  readonly resolvedHeaders: Readonly<Record<string, string>>;
  readonly sensitiveValues: ReadonlyArray<string>;
  readonly logs: RingLogBuffer;
  readonly oauth?: UpstreamOAuth | undefined;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}): Effect.fn.Return<McpUpstreamConnection, HarnessError> {
  const fetchImpl = input.fetchImplementation ?? fetch;
  const allowedOrigin = originOfUrl(input.url);
  if (allowedOrigin === null) {
    return yield* new HarnessError({
      code: "invalid_config",
      serverId: input.serverId,
      detail: `Invalid MCP URL for "${input.serverId}".`,
    });
  }
  input.logs.addSecretValues(input.sensitiveValues);

  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let closed = false;
  let sessionGoneOnServer = false;
  let sessionDeleteSent = false;
  let nextId = 1;

  const mapFetchError = (cause: unknown): HarnessError =>
    isHarnessError(cause)
      ? cause
      : new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: scrubHarnessLogText(
            `HTTP MCP server "${input.serverId}" error: ${cause instanceof Error ? cause.message : String(cause)}`,
            input.sensitiveValues,
          ),
        });

  const buildHttpHeaders = (entries: ReadonlyArray<readonly [string, string]>) =>
    buildSafeHttpHeaders({
      serverId: input.serverId,
      resolvedHeaders: input.resolvedHeaders,
      overrides: entries,
    });

  const postForOptionalResponse = Effect.fn("McpUpstreamClient.httpPost")(function* (
    body: unknown,
    expectedId: number | null,
    timeoutMs: number,
  ): Effect.fn.Return<JsonRpcMessage | null, HarnessError> {
    if (closed) {
      return yield* new HarnessError({
        code: "upstream_error",
        serverId: input.serverId,
        detail: `HTTP MCP server "${input.serverId}" session is closed.`,
      });
    }
    const headers = yield* buildHttpHeaders([
      ["content-type", "application/json"],
      ["accept", "application/json, text/event-stream"],
      ...(sessionId === null ? [] : ([["mcp-session-id", sessionId]] as const)),
      ...(protocolVersion === null ? [] : ([["mcp-protocol-version", protocolVersion]] as const)),
    ]);
    const response = yield* fetchSameOriginOnly({
      serverId: input.serverId,
      allowedOrigin,
      url: input.url,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      timeoutMs,
      sensitiveValues: input.sensitiveValues,
      fetchImpl,
      oauth: input.oauth,
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.code === "auth_required") closed = true;
        }),
      ),
    );

    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) sessionId = nextSessionId;

    if (!response.ok) {
      yield* discardResponseBody(response);
      if (
        (response.status === 401 || response.status === 404 || response.status === 410) &&
        sessionId !== null
      ) {
        closed = true;
        if (response.status === 404 || response.status === 410) {
          sessionGoneOnServer = true;
        }
        input.logs.append(
          "lifecycle",
          `HTTP session invalidated (HTTP ${response.status}); closing pooled connection for re-initialization.`,
        );
      }
      return yield* new HarnessError({
        code: "upstream_error",
        serverId: input.serverId,
        detail: `HTTP MCP server "${input.serverId}" returned HTTP ${response.status}.`,
      });
    }

    if (expectedId === null) {
      yield* discardResponseBody(response);
      return null;
    }

    // Stop reading an SSE response stream immediately once the matching JSON-RPC id arrives.
    const matched = yield* responsePayloads(response, mapFetchError).pipe(
      Stream.map(asJsonRpcMessage),
      Stream.filter((msg): msg is JsonRpcMessage => msg !== null && msg.id === expectedId),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new HarnessError({
                code: "upstream_error",
                serverId: input.serverId,
                detail: `HTTP MCP server "${input.serverId}" timed out waiting for response.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    return Option.getOrNull(matched);
  });

  const sendRequest = Effect.fn("McpUpstreamClient.httpSendRequest")(function* (
    method: string,
    params: unknown,
    timeoutMs: number,
  ) {
    const id = nextId++;
    const matched = yield* postForOptionalResponse(
      { jsonrpc: "2.0", id, method, params },
      id,
      timeoutMs,
    );
    if (matched === null) {
      return yield* new HarnessError({
        code: "upstream_error",
        serverId: input.serverId,
        detail: `HTTP MCP server "${input.serverId}" returned no JSON-RPC response for ${method}.`,
      });
    }
    if (matched.error !== undefined) {
      return yield* new HarnessError({
        code: "upstream_error",
        serverId: input.serverId,
        detail: input.logs.redact(
          `${method} failed: ${String(matched.error.message ?? "unknown error")}`,
        ),
      });
    }
    return matched;
  });

  const closeSession = Effect.fn("McpUpstreamClient.httpClose")(function* () {
    closed = true;
    if (sessionId !== null && !sessionGoneOnServer && !sessionDeleteSent) {
      sessionDeleteSent = true;
      const activeSessionId = sessionId;
      const maybeHeaders = yield* buildHttpHeaders([
        ["mcp-session-id", activeSessionId],
        ...(protocolVersion === null ? [] : ([["mcp-protocol-version", protocolVersion]] as const)),
      ]).pipe(Effect.option);
      if (Option.isNone(maybeHeaders)) return;
      yield* fetchSameOriginOnly({
        serverId: input.serverId,
        allowedOrigin,
        url: input.url,
        init: {
          method: "DELETE",
          headers: maybeHeaders.value,
        },
        timeoutMs: CLOSE_DELETE_TIMEOUT_MS,
        sensitiveValues: input.sensitiveValues,
        fetchImpl,
        oauth: input.oauth,
      }).pipe(
        Effect.flatMap(discardResponseBody),
        Effect.timeoutOption(Duration.millis(CLOSE_DELETE_TIMEOUT_MS)),
        Effect.ignore,
      );
    }
  });

  input.logs.append("lifecycle", `Connecting to ${input.transportType.toUpperCase()} MCP server.`);
  // Once initialize assigns a remote MCP session id, any handshake failure or fiber interruption
  // must issue DELETE before returning so remote sessions are never leaked.
  yield* Effect.gen(function* () {
    const initMsg = yield* sendRequest(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-harness-gateway", version: "1.0.0" },
      },
      DEFAULT_INIT_TIMEOUT_MS,
    );
    if (
      initMsg.result !== null &&
      typeof initMsg.result === "object" &&
      typeof Reflect.get(initMsg.result, "protocolVersion") === "string"
    ) {
      protocolVersion = Reflect.get(initMsg.result, "protocolVersion") as string;
    }
    yield* postForOptionalResponse(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      null,
      10_000,
    );
  }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeSession())));
  input.logs.append("lifecycle", "Initialized HTTP MCP session.");

  return {
    listTools: () =>
      sendRequest("tools/list", {}, DEFAULT_INIT_TIMEOUT_MS).pipe(
        Effect.map((msg) => parseToolsFromResult(msg.result)),
      ),
    callTool: (name, args) =>
      sendRequest("tools/call", { name, arguments: args }, DEFAULT_TOOL_CALL_TIMEOUT_MS).pipe(
        Effect.map((msg) => parseCallResult(msg.result)),
      ),
    listResources: () =>
      sendRequest("resources/list", {}, DEFAULT_INIT_TIMEOUT_MS).pipe(
        Effect.map((msg) => parseResourcesFromResult(msg.result)),
        Effect.orElseSucceed(() => [] as ReadonlyArray<UpstreamMcpResource>),
      ),
    readResource: (uri) =>
      sendRequest("resources/read", { uri }, DEFAULT_TOOL_CALL_TIMEOUT_MS).pipe(
        Effect.map((msg) => parseResourceReadResult(msg.result)),
      ),
    close: closeSession,
    isClosed: () => closed,
  };
});

interface ParsedSseFrame {
  readonly event: string;
  readonly data: string;
}

function parseSseEventFrame(rawEvent: string): ParsedSseFrame | null {
  let event = "message";
  const dataLines: Array<string> = [];
  for (const line of rawEvent.split(/\r\n|\r|\n/u)) {
    if (line.startsWith("event:")) {
      const name = line.slice("event:".length).trim();
      if (name.length > 0) event = name;
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/**
 * Legacy MCP HTTP+SSE client: opens a GET `text/event-stream`, waits for `event: endpoint`,
 * verifies same-origin before posting JSON-RPC messages, and matches streamed responses by id.
 * Falls back to Streamable HTTP if GET returns 405 Method Not Allowed.
 */
const connectLegacySseUpstream = Effect.fn("McpUpstreamClient.connectLegacySse")(function* (input: {
  readonly serverId: HarnessMcpServerId;
  readonly url: string;
  readonly resolvedHeaders: Readonly<Record<string, string>>;
  readonly sensitiveValues: ReadonlyArray<string>;
  readonly logs: RingLogBuffer;
  readonly oauth?: UpstreamOAuth | undefined;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}): Effect.fn.Return<McpUpstreamConnection, HarnessError> {
  const fetchImpl = input.fetchImplementation ?? fetch;
  const allowedOrigin = originOfUrl(input.url);
  if (allowedOrigin === null) {
    return yield* new HarnessError({
      code: "invalid_config",
      serverId: input.serverId,
      detail: `Invalid SSE MCP URL for "${input.serverId}".`,
    });
  }
  input.logs.addSecretValues(input.sensitiveValues);
  input.logs.append("lifecycle", "Opening legacy SSE MCP stream.");

  // @effect-diagnostics-next-line abortControllerInEffect:off -- Long-lived legacy SSE GET stream is cancelled imperatively by close().
  const sseAbort = new AbortController();
  const sseGetHeaders = yield* buildSafeHttpHeaders({
    serverId: input.serverId,
    resolvedHeaders: input.resolvedHeaders,
    overrides: [["accept", "text/event-stream"]],
  });
  const sseResponse = yield* fetchSameOriginOnly({
    serverId: input.serverId,
    allowedOrigin,
    url: input.url,
    init: {
      method: "GET",
      headers: sseGetHeaders,
      signal: sseAbort.signal,
    },
    timeoutMs: DEFAULT_INIT_TIMEOUT_MS,
    timeoutAppliesToHeadersOnly: true,
    sensitiveValues: input.sensitiveValues,
    fetchImpl,
    oauth: input.oauth,
  });

  if (sseResponse.status === 405) {
    yield* discardResponseBody(sseResponse);
    input.logs.append("lifecycle", "SSE endpoint returned 405; falling back to Streamable HTTP.");
    return yield* connectHttpUpstream({
      serverId: input.serverId,
      transportType: "sse",
      url: input.url,
      resolvedHeaders: input.resolvedHeaders,
      sensitiveValues: input.sensitiveValues,
      logs: input.logs,
      oauth: input.oauth,
      ...(input.fetchImplementation ? { fetchImplementation: input.fetchImplementation } : {}),
    });
  }

  if (!sseResponse.ok || sseResponse.body === null) {
    yield* discardResponseBody(sseResponse);
    return yield* new HarnessError({
      code: "upstream_error",
      serverId: input.serverId,
      detail: `SSE MCP server "${input.serverId}" returned HTTP ${sseResponse.status}.`,
    });
  }

  let closed = false;
  let nextId = 1;
  // Use Effect Deferreds instead of raw Promises so SSE drops mid-POST can never emit unhandledRejection.
  const endpointDeferred = Deferred.makeUnsafe<string, HarnessError>();
  const pending = new Map<number, Deferred.Deferred<JsonRpcMessage, HarnessError>>();

  const failAll = (reason: string) => {
    const error = new HarnessError({
      code: "upstream_error",
      serverId: input.serverId,
      detail: scrubHarnessLogText(reason, input.sensitiveValues),
    });
    Deferred.doneUnsafe(endpointDeferred, Exit.fail(error));
    for (const [id, waiter] of pending) {
      Deferred.doneUnsafe(waiter, Exit.fail(error));
      pending.delete(id);
    }
  };

  const reader = sseResponse.body.getReader();
  const stopSseStream = () => {
    if (closed) return;
    closed = true;
    sseAbort.abort();
    void reader.cancel().catch(() => undefined);
    failAll(`SSE MCP server "${input.serverId}" stream closed.`);
  };

  // Drive SSE event reading continuously until closed or EOF.
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const separator = /(?:\r\n|\r(?!\n)|\n){2}/u;
        let match = separator.exec(buffer);
        while (match !== null) {
          const rawFrame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const frame = parseSseEventFrame(rawFrame);
          if (frame !== null) {
            if (frame.event === "endpoint") {
              const resolvedUrl = resolveRelativeUrl(frame.data.trim(), input.url);
              if (resolvedUrl === null) {
                closed = true;
                failAll(`SSE MCP server "${input.serverId}" sent an invalid endpoint URL.`);
                sseAbort.abort();
                return;
              }
              if (resolvedUrl.origin !== allowedOrigin) {
                closed = true;
                failAll(
                  `Refused cross-origin SSE endpoint for MCP server "${input.serverId}" to protect credentials.`,
                );
                sseAbort.abort();
                return;
              }
              Deferred.doneUnsafe(endpointDeferred, Exit.succeed(resolvedUrl.toString()));
            } else if (frame.event === "message") {
              try {
                const parsed = JSON.parse(frame.data) as unknown;
                const msg = asJsonRpcMessage(parsed);
                if (msg !== null && typeof msg.id === "number") {
                  const waiter = pending.get(msg.id);
                  if (waiter) {
                    pending.delete(msg.id);
                    Deferred.doneUnsafe(waiter, Exit.succeed(msg));
                  }
                }
              } catch {
                // Ignore malformed non-JSON SSE notifications.
              }
            }
          }
          match = separator.exec(buffer);
        }
      }
    } catch {
      // Stream aborted or dropped.
    } finally {
      closed = true;
      failAll(`SSE MCP server "${input.serverId}" stream ended.`);
      try {
        reader.releaseLock();
      } catch {
        // Already released.
      }
    }
  })();

  // Protect the entire post-GET handshake (endpoint wait, initialize, notifications/initialized)
  // so any failure or fiber interruption closes the SSE stream without leaking the open socket.
  const sendSseRequest = yield* Effect.gen(function* () {
    const endpointUrl = yield* Deferred.await(endpointDeferred).pipe(
      Effect.timeoutOption(Duration.millis(DEFAULT_INIT_TIMEOUT_MS)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new HarnessError({
                code: "upstream_error",
                serverId: input.serverId,
                detail: `SSE MCP server "${input.serverId}" timed out waiting for endpoint event.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

    const sendRequest = Effect.fn("McpUpstreamClient.sseSendRequest")(function* (
      method: string,
      params: unknown,
      timeoutMs: number,
    ): Effect.fn.Return<JsonRpcMessage, HarnessError> {
      if (closed) {
        return yield* new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: `SSE MCP server "${input.serverId}" session is closed.`,
        });
      }
      const id = nextId++;
      const waiter = Deferred.makeUnsafe<JsonRpcMessage, HarnessError>();
      pending.set(id, waiter);

      const postHeaders = yield* buildSafeHttpHeaders({
        serverId: input.serverId,
        resolvedHeaders: input.resolvedHeaders,
        overrides: [
          ["content-type", "application/json"],
          ["accept", "application/json, text/event-stream"],
        ],
      }).pipe(Effect.tapError(() => Effect.sync(() => pending.delete(id))));
      const postRes = yield* fetchSameOriginOnly({
        serverId: input.serverId,
        allowedOrigin,
        url: endpointUrl,
        init: {
          method: "POST",
          headers: postHeaders,
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        },
        timeoutMs,
        sensitiveValues: input.sensitiveValues,
        fetchImpl,
        oauth: input.oauth,
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error.code === "auth_required") stopSseStream();
          }),
        ),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => pending.delete(id)),
        ),
      );

      if (!postRes.ok) {
        pending.delete(id);
        yield* discardResponseBody(postRes);
        if (postRes.status === 401 || postRes.status === 404 || postRes.status === 410) {
          stopSseStream();
        }
        return yield* new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: `SSE MCP server "${input.serverId}" POST returned HTTP ${postRes.status}.`,
        });
      }

      // If the server returned an inline JSON-RPC payload on POST instead of 202, use it directly.
      const contentType = (postRes.headers.get("content-type") ?? "").toLowerCase();
      if (postRes.status !== 202 && contentType.includes("application/json")) {
        const inline = yield* Effect.tryPromise({
          try: () => postRes.json() as Promise<unknown>,
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined));
        const inlineMsg = asJsonRpcMessage(inline);
        if (inlineMsg !== null && inlineMsg.id === id) {
          pending.delete(id);
          if (inlineMsg.error !== undefined) {
            return yield* new HarnessError({
              code: "upstream_error",
              serverId: input.serverId,
              detail: scrubHarnessLogText(
                `${method} failed: ${String(inlineMsg.error.message ?? "unknown error")}`,
                input.sensitiveValues,
              ),
            });
          }
          return inlineMsg;
        }
      } else {
        yield* discardResponseBody(postRes);
      }

      const msg = yield* Deferred.await(waiter).pipe(
        Effect.timeoutOption(Duration.millis(timeoutMs)),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new HarnessError({
                  code: "upstream_error",
                  serverId: input.serverId,
                  detail: `SSE MCP server "${input.serverId}" timed out waiting for ${method}.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

      if (msg.error !== undefined) {
        return yield* new HarnessError({
          code: "upstream_error",
          serverId: input.serverId,
          detail: input.logs.redact(
            `${method} failed: ${String(msg.error.message ?? "unknown error")}`,
          ),
        });
      }
      return msg;
    });

    yield* sendRequest(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-harness-gateway", version: "1.0.0" },
      },
      DEFAULT_INIT_TIMEOUT_MS,
    );

    const initNotifyHeaders = yield* buildSafeHttpHeaders({
      serverId: input.serverId,
      resolvedHeaders: input.resolvedHeaders,
      overrides: [["content-type", "application/json"]],
    }).pipe(Effect.option);
    if (Option.isSome(initNotifyHeaders)) {
      yield* fetchSameOriginOnly({
        serverId: input.serverId,
        allowedOrigin,
        url: endpointUrl,
        init: {
          method: "POST",
          headers: initNotifyHeaders.value,
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        },
        timeoutMs: 10_000,
        sensitiveValues: input.sensitiveValues,
        fetchImpl,
        oauth: input.oauth,
      }).pipe(Effect.flatMap(discardResponseBody), Effect.ignore);
    }

    return sendRequest;
  }).pipe(
    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(stopSseStream))),
  );

  input.logs.append("lifecycle", "Initialized legacy SSE MCP session.");

  return {
    listTools: () =>
      sendSseRequest("tools/list", {}, DEFAULT_INIT_TIMEOUT_MS).pipe(
        Effect.map((msg) => parseToolsFromResult(msg.result)),
      ),
    callTool: (name, args) =>
      sendSseRequest("tools/call", { name, arguments: args }, DEFAULT_TOOL_CALL_TIMEOUT_MS).pipe(
        Effect.map((msg) => parseCallResult(msg.result)),
      ),
    listResources: () =>
      sendSseRequest("resources/list", {}, DEFAULT_INIT_TIMEOUT_MS).pipe(
        Effect.map((msg) => parseResourcesFromResult(msg.result)),
        Effect.orElseSucceed(() => [] as ReadonlyArray<UpstreamMcpResource>),
      ),
    readResource: (uri) =>
      sendSseRequest("resources/read", { uri }, DEFAULT_TOOL_CALL_TIMEOUT_MS).pipe(
        Effect.map((msg) => parseResourceReadResult(msg.result)),
      ),
    close: () => Effect.sync(stopSseStream),
    isClosed: () => closed,
  };
});

export const connectUpstream = (input: {
  readonly serverId: HarnessMcpServerId;
  readonly transport: HarnessMcpTransport;
  readonly resolvedEnvOrHeaders: Readonly<Record<string, string>>;
  readonly sensitiveValues?: ReadonlyArray<string>;
  readonly logs: RingLogBuffer;
  readonly oauth?: UpstreamOAuth | undefined;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}): Effect.Effect<McpUpstreamConnection, HarnessError> => {
  const sensitiveValues = input.sensitiveValues ?? [];
  if (input.transport.type === "stdio") {
    return connectStdioUpstream({
      serverId: input.serverId,
      command: input.transport.command,
      args: input.transport.args ?? [],
      cwd: input.transport.cwd,
      resolvedEnv: input.resolvedEnvOrHeaders,
      sensitiveValues,
      logs: input.logs,
    });
  }
  if (input.transport.type === "sse") {
    return connectLegacySseUpstream({
      serverId: input.serverId,
      url: input.transport.url,
      resolvedHeaders: input.resolvedEnvOrHeaders,
      sensitiveValues,
      logs: input.logs,
      oauth: input.oauth,
      ...(input.fetchImplementation ? { fetchImplementation: input.fetchImplementation } : {}),
    });
  }
  return connectHttpUpstream({
    serverId: input.serverId,
    transportType: "http",
    url: input.transport.url,
    resolvedHeaders: input.resolvedEnvOrHeaders,
    sensitiveValues,
    logs: input.logs,
    oauth: input.oauth,
    ...(input.fetchImplementation ? { fetchImplementation: input.fetchImplementation } : {}),
  });
};
