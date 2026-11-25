import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HARNESS_SECRET_REDACTED } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessImporter from "./HarnessImporter.ts";
import * as HarnessStore from "./HarnessStore.ts";

describe("HarnessImporter", () => {
  it("parses Codex config.toml MCP servers and skips T3 built-ins", () => {
    const rawToml = `
model = "gpt-5"

[mcp_servers.t3-code]
url = "http://127.0.0.1:3773/mcp"

[mcp_servers.t3-harness]
url = "http://127.0.0.1:3773/mcp/harness"

[mcp_servers.filesystem]
command = "npx"
args = [
  "-y",
  "@modelcontextprotocol/server-filesystem",
  "/tmp/demo",
]
env = { MODE = "ro" }

[mcp_servers.docs]
url = "https://docs.example.com/mcp"

[mcp_servers.docs.http_headers]
Authorization = "Bearer \${secret:DOCS_TOKEN}"
`;
    const parsed = HarnessImporter.parseCodexTomlMcpServers({
      rawText: rawToml,
      sourcePath: "/home/user/.codex/config.toml",
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.entries.map((entry) => entry.id)).toEqual(["filesystem", "docs"]);
    expect(parsed.entries[0]?.config.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/demo"],
      env: { MODE: "ro" },
    });
    expect(parsed.entries[1]?.config.transport).toEqual({
      type: "http",
      url: "https://docs.example.com/mcp",
      headers: { Authorization: "Bearer ${secret:DOCS_TOKEN}" },
    });
  });

  it("parses JSON mcpServers from Claude/Cursor/Antigravity without touching built-ins", () => {
    const rawJson = JSON.stringify({
      mcpServers: {
        "t3-code": { url: "http://127.0.0.1:3773/mcp" },
        t3_code: { url: "http://127.0.0.1:3773/mcp" },
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "${secret:GH_TOKEN}" },
        },
        linear: {
          type: "sse",
          url: "https://mcp.linear.app/sse",
        },
      },
    });
    const parsed = HarnessImporter.parseJsonMcpServers({
      rawText: rawJson,
      source: "cursor",
      sourcePath: "/home/user/.cursor/mcp.json",
    });
    expect(parsed.entries.map((entry) => entry.id)).toEqual(["github", "linear"]);
    expect(parsed.entries[1]?.config.transport.type).toBe("sse");
  });

  it.effect(
    "returns redacted scan previews, applies unredacted configs server-side, enforces authorize, and never mutates CLI files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-import-" });
        const fakeHome = path.join(tempRoot, "home");
        const baseDir = path.join(tempRoot, "t3home");

        yield* fs.makeDirectory(path.join(fakeHome, ".codex"), { recursive: true });
        yield* fs.makeDirectory(path.join(fakeHome, ".cursor"), { recursive: true });

        const codexContent = [
          "[mcp_servers.alpha]",
          'url = "https://alpha.example.com/mcp"',
          "[mcp_servers.alpha.http_headers]",
          'Authorization = "Bearer real-codex-token-999"',
          "",
          "[mcp_servers.local_cli]",
          'command = "node"',
          'args = ["-v"]',
          "",
        ].join("\n");
        const cursorContent = JSON.stringify({
          mcpServers: {
            beta: {
              url: "https://beta.example.com/mcp",
              headers: { Authorization: "Bearer ${secret:BETA_KEY}" },
            },
          },
        });
        const codexPath = path.join(fakeHome, ".codex", "config.toml");
        const cursorPath = path.join(fakeHome, ".cursor", "mcp.json");
        yield* fs.writeFileString(codexPath, codexContent);
        yield* fs.writeFileString(cursorPath, cursorContent);

        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
        const testLayer = HarnessImporter.layer.pipe(
          Layer.provideMerge(HarnessStore.layer),
          Layer.provide(
            Layer.succeed(ServerConfig.ServerConfig, {
              ...paths,
              mode: "web",
              port: 0,
              host: "127.0.0.1",
              cwd: baseDir,
              baseDir,
            } as unknown as ServerConfig.ServerConfig["Service"]),
          ),
          Layer.provide(
            Layer.succeed(ManagedPolicy.ManagedPolicy, {
              document: undefined,
              source: undefined,
              error: undefined,
            } as unknown as ManagedPolicy.ManagedPolicy["Service"]),
          ),
          Layer.provide(T3ProjectFileLoader.layer),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const importer = yield* HarnessImporter.HarnessImporter;
          const store = yield* HarnessStore.HarnessStore;
          const firstScan = yield* importer.scan;
          const codexPreview = firstScan.find((s) => s.source === "codex");
          const cursorPreview = firstScan.find((s) => s.source === "cursor");
          expect(codexPreview?.found).toBe(true);
          const alphaCandidate = codexPreview?.candidates.find((c) => c.id === "alpha");
          expect(alphaCandidate?.conflict).toBe("none");
          // Plaintext header MUST be redacted in scan preview.
          expect(
            alphaCandidate?.config.transport.type === "http"
              ? alphaCandidate.config.transport.headers?.Authorization
              : null,
          ).toBe(HARNESS_SECRET_REDACTED);

          // Secret placeholder stays readable and flags hasSecretPlaceholders.
          const betaCandidate = cursorPreview?.candidates.find((c) => c.id === "beta");
          expect(betaCandidate?.hasSecretPlaceholders).toBe(true);
          expect(
            betaCandidate?.config.transport.type === "http"
              ? betaCandidate.config.transport.headers?.Authorization
              : null,
          ).toBe("Bearer ${secret:BETA_KEY}");

          // Server-side apply validates real disk config against `authorize`.
          const stdioDenied = yield* importer
            .apply({
              items: [{ source: "codex", id: codexPreview!.candidates[1]!.id }],
              authorize: (config) =>
                config.transport.type === "stdio"
                  ? Effect.fail("terminal_operate_required" as const)
                  : Effect.void,
            })
            .pipe(Effect.flip);
          expect(stdioDenied).toBe("terminal_operate_required");

          // Applying with a stale expectedDigest MUST fail so remote confirmation stays bound to preview.
          const staleDigestErr = yield* importer
            .apply({
              items: [
                {
                  source: "codex",
                  id: alphaCandidate!.id,
                  expectedDigest: "stale-preview-digest-000",
                },
              ],
              overwriteExisting: false,
            })
            .pipe(Effect.flip);
          expect(staleDigestErr.code).toBe("invalid_config");

          // Applying by (source, id, expectedDigest) writes the real unredacted header to harness.json server-side.
          const applied = yield* importer.apply({
            items: [
              {
                source: "codex",
                id: alphaCandidate!.id,
                expectedDigest: alphaCandidate!.previewDigest,
              },
            ],
            overwriteExisting: false,
          });
          expect(applied.importedIds).toEqual(["alpha"]);
          expect(applied.skippedIds).toEqual([]);

          const stored = yield* store.loadUserConfig;
          expect(
            stored.config.mcpServers.alpha?.transport.type === "http"
              ? stored.config.mcpServers.alpha.transport.headers?.Authorization
              : null,
          ).toBe("Bearer real-codex-token-999");

          // Second scan classifies `alpha` as exists_identical; re-applying without overwrite skips it.
          const secondScan = yield* importer.scan;
          const alphaSecond = secondScan
            .find((s) => s.source === "codex")
            ?.candidates.find((c) => c.id === "alpha");
          expect(alphaSecond?.conflict).toBe("exists_identical");

          const skipped = yield* importer.apply({
            items: [{ source: "codex", id: alphaSecond!.id }],
            overwriteExisting: false,
          });
          expect(skipped.importedIds).toEqual([]);
          expect(skipped.skippedIds).toEqual(["alpha"]);

          // Omitting expectedExistingDigest when overwriting an existing server is rejected.
          const missingTargetDigestErr = yield* importer
            .apply({
              items: [
                {
                  source: "codex",
                  id: alphaSecond!.id,
                  expectedDigest: alphaSecond!.previewDigest,
                },
              ],
              overwriteExisting: true,
            })
            .pipe(Effect.flip);
          expect(missingTargetDigestErr.code).toBe("invalid_config");

          // Stale expectedExistingDigest rejects overwrite if target server changed after preview.
          const staleTargetErr = yield* importer
            .apply({
              items: [
                {
                  source: "codex",
                  id: alphaSecond!.id,
                  expectedDigest: alphaSecond!.previewDigest,
                  expectedExistingDigest: "stale-target-digest-999",
                },
              ],
              overwriteExisting: true,
            })
            .pipe(Effect.flip);
          expect(staleTargetErr.code).toBe("invalid_config");

          // Editing description invalidates previously captured existingDigest.
          yield* store.upsertUserServer({
            id: alphaSecond!.id,
            config: {
              ...stored.config.mcpServers.alpha!,
              description: "Edited after preview",
            },
          });
          const editedMetaOverwriteErr = yield* importer
            .apply({
              items: [
                {
                  source: "codex",
                  id: alphaSecond!.id,
                  expectedDigest: alphaSecond!.previewDigest,
                  expectedExistingDigest: alphaSecond!.existingDigest ?? null,
                },
              ],
              overwriteExisting: true,
            })
            .pipe(Effect.flip);
          expect(editedMetaOverwriteErr.code).toBe("invalid_config");

          // Malformed JSON warning never echoes secret fragments from raw file contents.
          const malformedParsed = HarnessImporter.parseJsonMcpServers({
            rawText:
              '{"mcpServers": {"s": {"headers": {"Authorization": "Bearer secret-raw-999"} BROKEN',
            source: "cursor",
            sourcePath: "/tmp/broken.json",
          });
          expect(malformedParsed.entries).toHaveLength(0);
          expect(malformedParsed.warnings.join(" ")).not.toContain("secret-raw-999");

          // Invalid-port URLs are rejected during import parsing and never leak into candidates.
          const invalidUrlParsed = HarnessImporter.parseJsonMcpServers({
            rawText: JSON.stringify({
              mcpServers: {
                bad_port: {
                  url: "https://example.com:99999/mcp?token=must-not-leak",
                },
              },
            }),
            source: "cursor",
            sourcePath: "/tmp/mcp.json",
          });
          expect(invalidUrlParsed.entries).toHaveLength(0);
          expect(invalidUrlParsed.warnings.join(" ")).not.toContain("must-not-leak");
        }).pipe(
          Effect.provide(testLayer),
          Effect.provideService(HostProcess.HomeDirectory, fakeHome),
        );

        // Verify native CLI config files were never altered.
        expect(yield* fs.readFileString(codexPath)).toBe(codexContent);
        expect(yield* fs.readFileString(cursorPath)).toBe(cursorContent);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
