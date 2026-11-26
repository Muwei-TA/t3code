// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Tests stdio JSON-RPC framing with in-memory Node streams.
import * as NodeStream from "node:stream";
import { describe, expect, it } from "vite-plus/test";

import { definePlugin, runPluginStdioServer } from "./index.ts";

describe("@t3tools/plugin-sdk", () => {
  it("describes tools, hooks, and modes and serves JSON-RPC calls over stdio streams", async () => {
    const plugin = definePlugin({
      id: "demo-sdk-plugin",
      name: "Demo SDK Plugin",
      version: "1.0.0",
      description: "Verifies out-of-process JSON-RPC execution",
      tools: [
        {
          name: "echo_upper",
          description: "Returns uppercased text",
          readOnly: true,
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          handler: (args) => String(args.text ?? "").toUpperCase(),
        },
      ],
      hooks: [
        {
          id: "guard-deploy",
          event: "PreToolUse",
          matcher: "*deploy*",
          handler: (payload) =>
            payload.toolName === "deploy_prod"
              ? { allow: false, reason: "Blocked by SDK hook" }
              : { allow: true },
        },
      ],
      modes: [
        {
          id: "sdk-auditor",
          name: "SDK Auditor",
          baseInteractionMode: "plan",
          readonly: true,
          body: "Inspect security posture only.",
        },
      ],
    });

    const input = new NodeStream.PassThrough();
    const output = new NodeStream.PassThrough();
    const responses: Array<Record<string, unknown>> = [];
    let resolveAllResponses!: () => void;
    const allResponsesReceived = new Promise<void>((resolve) => {
      resolveAllResponses = resolve;
    });
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          responses.push(JSON.parse(line) as Record<string, unknown>);
          if (responses.length >= 4) {
            resolveAllResponses();
          }
        }
      }
    });

    const server = runPluginStdioServer(plugin, { input, output });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo_upper", arguments: { text: "hello" } },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "hooks/run",
        params: { hookId: "guard-deploy", payload: { toolName: "deploy_prod" } },
      })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "shutdown", params: {} })}\n`);

    await allResponsesReceived;
    server.close();

    expect(responses).toHaveLength(4);
    const byId = new Map(responses.map((entry) => [entry.id, entry]));
    expect(byId.get(1)).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "1",
        plugin: {
          id: "demo-sdk-plugin",
          tools: [{ name: "echo_upper", readOnly: true }],
          hooks: [{ id: "guard-deploy", event: "PreToolUse" }],
          modes: [{ id: "sdk-auditor", readonly: true }],
        },
      },
    });
    expect(byId.get(2)).toMatchObject({
      id: 2,
      result: { content: [{ type: "text", text: "HELLO" }] },
    });
    expect(byId.get(3)).toMatchObject({
      id: 3,
      result: { allow: false, reason: "Blocked by SDK hook" },
    });
    expect(byId.get(4)).toMatchObject({
      id: 4,
      result: { ok: true },
    });
  });
});
