// @effect-diagnostics nodeBuiltinImport:off -- Standalone out-of-process plugin SDK communicates over line-framed JSON-RPC on stdin/stdout.
import * as NodeReadline from "node:readline";

export type T3PluginHookEvent =
  | "turn.beforeStart"
  | "PreToolUse"
  | "PostToolUse"
  | "thread.created"
  | "turn.completed"
  | "run.settled"
  | "checkpoint.created";

export interface T3PluginToolContext {
  readonly pluginId: string;
  readonly workspaceRoot?: string | undefined;
  readonly threadId?: string | undefined;
}

export interface T3PluginToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
}

export interface T3PluginToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly?: boolean | undefined;
  readonly handler: (
    args: Readonly<Record<string, unknown>>,
    ctx: T3PluginToolContext,
  ) => Promise<T3PluginToolResult | string> | T3PluginToolResult | string;
}

export interface T3PluginHookResult {
  readonly allow?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly injectContext?: string | undefined;
}

export interface T3PluginHookDefinition {
  readonly id: string;
  readonly event: T3PluginHookEvent;
  readonly matcher?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly failClosed?: boolean | undefined;
  readonly handler: (
    payload: Readonly<Record<string, unknown>>,
  ) => Promise<T3PluginHookResult | void> | T3PluginHookResult | void;
}

export interface T3PluginModeDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly baseInteractionMode?: "default" | "plan" | undefined;
  readonly readonly?: boolean | undefined;
  readonly proposePlan?: boolean | undefined;
  readonly body: string;
}

export interface T3PluginConfig {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly tools?: ReadonlyArray<T3PluginToolDefinition> | undefined;
  readonly hooks?: ReadonlyArray<T3PluginHookDefinition> | undefined;
  readonly modes?: ReadonlyArray<T3PluginModeDefinition> | undefined;
}

export interface T3PluginInstance {
  readonly config: T3PluginConfig;
  readonly describe: () => T3PluginDescriptor;
  readonly callTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    ctx: T3PluginToolContext,
  ) => Promise<T3PluginToolResult>;
  readonly runHook: (
    hookId: string,
    payload: Readonly<Record<string, unknown>>,
  ) => Promise<T3PluginHookResult>;
}

export interface T3PluginDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly readOnly: boolean;
  }>;
  readonly hooks: ReadonlyArray<{
    readonly id: string;
    readonly event: T3PluginHookEvent;
    readonly matcher?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly failClosed?: boolean | undefined;
  }>;
  readonly modes: ReadonlyArray<T3PluginModeDefinition>;
}

function normalizeToolResult(result: T3PluginToolResult | string): T3PluginToolResult {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  return result;
}

export function definePlugin(config: T3PluginConfig): T3PluginInstance {
  const toolsByName = new Map<string, T3PluginToolDefinition>();
  for (const tool of config.tools ?? []) {
    toolsByName.set(tool.name, tool);
  }
  const hooksById = new Map<string, T3PluginHookDefinition>();
  for (const hook of config.hooks ?? []) {
    hooksById.set(hook.id, hook);
  }

  return {
    config,
    describe: (): T3PluginDescriptor => ({
      id: config.id,
      name: config.name,
      version: config.version,
      ...(config.description ? { description: config.description } : {}),
      tools: (config.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnly: tool.readOnly === true,
      })),
      hooks: (config.hooks ?? []).map((hook) => ({
        id: hook.id,
        event: hook.event,
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
        ...(hook.failClosed !== undefined ? { failClosed: hook.failClosed } : {}),
      })),
      modes: [...(config.modes ?? [])],
    }),
    callTool: async (name, args, ctx) => {
      const tool = toolsByName.get(name);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: "text", text: `Plugin "${config.id}" has no tool "${name}".` }],
        };
      }
      try {
        const result = await tool.handler(args, ctx);
        return normalizeToolResult(result);
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
    runHook: async (hookId, payload) => {
      const hook = hooksById.get(hookId);
      if (!hook) {
        return { allow: true };
      }
      const outcome = await hook.handler(payload);
      return outcome ?? { allow: true };
    },
  };
}

interface JsonRpcRequest {
  readonly id?: number | string | null | undefined;
  readonly method?: string | undefined;
  readonly params?: Record<string, unknown> | undefined;
}

/**
 * Runs a `T3PluginInstance` as an isolated out-of-process stdio JSON-RPC server
 * managed by T3 Code's `PluginHost` Effect `Scope`.
 */
export function runPluginStdioServer(
  plugin: T3PluginInstance,
  streams?: {
    readonly input?: NodeJS.ReadableStream;
    readonly output?: NodeJS.WritableStream;
  },
): { readonly close: () => void } {
  const input = streams?.input ?? process.stdin;
  const output = streams?.output ?? process.stdout;
  const rl = NodeReadline.createInterface({ input });

  const writeResponse = (msg: Record<string, unknown>) => {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return;
    }
    const id = req.id;
    const method = req.method ?? "";
    const params = req.params ?? {};

    void (async () => {
      try {
        if (method === "initialize") {
          writeResponse({
            id,
            result: {
              protocolVersion: "1",
              plugin: plugin.describe(),
            },
          });
          return;
        }
        if (method === "plugin/describe") {
          writeResponse({ id, result: plugin.describe() });
          return;
        }
        if (method === "tools/call") {
          const name = typeof params.name === "string" ? params.name : "";
          const args =
            params.arguments !== null &&
            typeof params.arguments === "object" &&
            !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : {};
          const ctx: T3PluginToolContext = {
            pluginId: plugin.config.id,
            ...(typeof params.workspaceRoot === "string"
              ? { workspaceRoot: params.workspaceRoot }
              : {}),
            ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
          };
          const result = await plugin.callTool(name, args, ctx);
          writeResponse({ id, result });
          return;
        }
        if (method === "hooks/run") {
          const hookId = typeof params.hookId === "string" ? params.hookId : "";
          const payload =
            params.payload !== null &&
            typeof params.payload === "object" &&
            !Array.isArray(params.payload)
              ? (params.payload as Record<string, unknown>)
              : {};
          const result = await plugin.runHook(hookId, payload);
          writeResponse({ id, result });
          return;
        }
        if (method === "shutdown") {
          writeResponse({ id, result: { ok: true } });
          rl.close();
          return;
        }
        writeResponse({
          id,
          error: { code: -32601, message: `Unknown method "${method}".` },
        });
      } catch (error) {
        writeResponse({
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();
  });

  return {
    close: () => {
      rl.close();
    },
  };
}
