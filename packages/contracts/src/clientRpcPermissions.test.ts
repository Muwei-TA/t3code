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

  it("checks terminal access for a command hook that is active on save", () => {
    for (const payload of [input, { ...input, enabled: true }]) {
      expect(clientRpcRequiredScopes(WS_METHODS.harnessHookUpsert, payload)).toEqual([
        AuthSettingsWriteScope,
        AuthTerminalOperateScope,
      ]);
    }
  });

  it("uses settings access for inactive command hooks and HTTP hooks", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.harnessHookUpsert, { ...input, enabled: false }),
    ).toEqual([AuthSettingsWriteScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.harnessHookUpsert, {
        ...input,
        enabled: true,
        target: { type: "http", url: "https://example.com/hook" },
      }),
    ).toEqual([AuthSettingsWriteScope]);
  });
});
