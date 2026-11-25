import { describe, expect, it } from "vite-plus/test";

import { AuthSettingsWriteScope, AuthTerminalOperateScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("clientRpcRequiredScopes for hook changes", () => {
  const input = {
    id: "check-turn",
    event: "turn.beforeStart",
    target: { type: "command", command: "echo" },
  };

  it("checks terminal access for every command hook save", () => {
    for (const payload of [input, { ...input, enabled: true }, { ...input, enabled: false }]) {
      expect(clientRpcRequiredScopes(WS_METHODS.harnessHookUpsert, payload)).toEqual([
        AuthSettingsWriteScope,
        AuthTerminalOperateScope,
      ]);
    }
  });

  it("uses settings access for HTTP hook saves and for disabling or removing hooks", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.harnessHookSetEnabled, { id: input.id, enabled: false }),
    ).toEqual([AuthSettingsWriteScope]);
    expect(clientRpcRequiredScopes(WS_METHODS.harnessHookRemove, { id: input.id })).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.harnessHookUpsert, {
        ...input,
        enabled: true,
        target: { type: "http", url: "https://example.com/hook" },
      }),
    ).toEqual([AuthSettingsWriteScope]);
  });
});
