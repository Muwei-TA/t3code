import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseT3ProjectFile, T3ProjectFileFromJson } from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", "stopOnSettle": true, },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev", stopOnSettle: true });
  });
});

describe("parseT3ProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseT3ProjectFile(`{
        /* See https://t3.codes/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });

  it("isolates an invalid harness section so project settings stay intact", () => {
    expect(
      parseT3ProjectFile(`{
        "defaultThreadEnvMode": "worktree",
        "worktreeSubmodules": "none",
        "harness": {
          "mcpServers": {
            "bad": {
              "enabled": true,
              "transport": {
                "type": "http",
                "url": "https://alice:secret@bad.example.com:99999/mcp"
              }
            }
          }
        }
      }`),
    ).toEqual({
      defaultThreadEnvMode: "worktree",
      worktreeSubmodules: "none",
    });

    expect(
      parseT3ProjectFile(`{
        "worktreeSubmodules": "invalid-mode"
      }`),
    ).toBeNull();
  });
});
