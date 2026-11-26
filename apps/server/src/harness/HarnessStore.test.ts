import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HARNESS_SECRET_REDACTED, HarnessMcpServerId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessStore from "./HarnessStore.ts";

const decodeHarnessServerId = Schema.decodeUnknownOption(HarnessMcpServerId);

const makeTestLayer = (
  baseDir: string,
  paths: ServerConfig.ServerDerivedPaths,
  policyOverrides?: {
    readonly harness?: boolean;
    readonly harnessMcpStdio?: boolean;
  },
) => {
  const configLayer = Layer.succeed(ServerConfig.ServerConfig, {
    ...paths,
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: baseDir,
    baseDir,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    logWebSocketEvents: false,
    autoBootstrapProjectFromCwd: false,
    shellEnvironmentPrepared: true,
    tailscaleServeEnabled: false,
    tailscaleServePort: 0,
    lan: false,
  } as unknown as ServerConfig.ServerConfig["Service"]);

  const policyLayer = Layer.succeed(ManagedPolicy.ManagedPolicy, {
    document:
      policyOverrides === undefined
        ? undefined
        : {
            version: 1,
            organization: "Acme Corp",
            limits: policyOverrides,
          },
    source: undefined,
    error: undefined,
  } as unknown as ManagedPolicy.ManagedPolicy["Service"]);

  return HarnessStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(policyLayer),
    Layer.provideMerge(T3ProjectFileLoader.layer),
    Layer.provideMerge(NodeServices.layer),
  );
};

describe("HarnessStore", () => {
  it("rejects reserved built-in MCP server IDs in schema decoding", () => {
    const decode = Schema.decodeUnknownOption(HarnessMcpServerId);
    expect(Option.isNone(decode("t3-code"))).toBe(true);
    expect(Option.isNone(decode("t3_code"))).toBe(true);
    expect(Option.isNone(decode("t3-code-direct"))).toBe(true);
    expect(Option.isNone(decode("t3-harness"))).toBe(true);
    expect(Option.isNone(decode("T3-HARNESS"))).toBe(true);
    expect(Option.isSome(decode("my__custom_server"))).toBe(true);
  });

  it.effect("rejects conflicting tool filters on save and in a batch import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-filters-" });
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      yield* Effect.gen(function* () {
        const store = yield* HarnessStore.HarnessStore;
        const id = HarnessMcpServerId.make("conflicting");
        const config = {
          enabled: true,
          transport: { type: "http", url: "https://mcp.example.com/docs" },
          injectionMode: "gateway",
          approvalPolicy: "auto-read",
          allowedTools: ["search"],
        } as const;
        const conflicting = { id, config: { ...config, disabledTools: ["search"] } };

        const saveError = yield* store.upsertUserServer(conflicting).pipe(Effect.flip);
        expect(saveError).toMatchObject({ code: "invalid_config", serverId: id });
        const importError = yield* store
          .importUserServers({
            entries: [{ id: HarnessMcpServerId.make("valid"), config }, conflicting],
          })
          .pipe(Effect.flip);
        expect(importError).toMatchObject({ code: "invalid_config", serverId: id });
        expect(importError.detail).toContain("search");
        expect((yield* store.loadUserConfig).config.mcpServers).toEqual({});
        yield* store.upsertUserServer({ id, config });
        expect(yield* store.importUserServers({ entries: [conflicting] })).toEqual({
          importedIds: [],
          skippedIds: [id],
        });
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "persists harness.json outside userdata, skips malformed and reserved entries, and preserves redacted secrets on edit",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-store-" });
        const baseDir = path.join(tempRoot, "t3home");
        const expectedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          expect(store.harnessDir).toBe(path.join(baseDir, "harness"));
          expect(path.relative(baseDir, store.harnessDir)).toBe("harness");
          expect(store.harnessDir.startsWith(expectedPaths.stateDir)).toBe(false);

          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("docs"),
            config: {
              enabled: true,
              transport: {
                type: "http",
                url: "https://mcp.example.com/docs",
                headers: { Authorization: "Bearer literal-secret-123" },
              },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });

          // Editing metadata with unchanged URL target and redaction sentinel preserves the stored literal header.
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("docs"),
            config: {
              enabled: true,
              description: "Updated docs label",
              transport: {
                type: "http",
                url: "https://mcp.example.com/docs",
                headers: { Authorization: HARNESS_SECRET_REDACTED },
              },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });
          const afterEdit = yield* store.loadUserConfig;
          expect(
            afterEdit.config.mcpServers.docs?.transport.type === "http"
              ? afterEdit.config.mcpServers.docs.transport.headers?.Authorization
              : null,
          ).toBe("Bearer literal-secret-123");

          // Changing the URL origin or pathname while reusing redacted credentials MUST be rejected.
          const retargetPathErr = yield* store
            .upsertUserServer({
              id: HarnessMcpServerId.make("docs"),
              config: {
                enabled: true,
                transport: {
                  type: "http",
                  url: "https://mcp.example.com/docs-v2",
                  headers: { Authorization: HARNESS_SECRET_REDACTED },
                },
                injectionMode: "gateway",
                approvalPolicy: "auto-read",
              },
            })
            .pipe(Effect.flip);
          expect(retargetPathErr.code).toBe("invalid_config");

          const retargetHostErr = yield* store
            .upsertUserServer({
              id: HarnessMcpServerId.make("docs"),
              config: {
                enabled: true,
                transport: {
                  type: "http",
                  url: "https://attacker.example.com/docs",
                  headers: { Authorization: HARNESS_SECRET_REDACTED },
                },
                injectionMode: "gateway",
                approvalPolicy: "auto-read",
              },
            })
            .pipe(Effect.flip);
          expect(retargetHostErr.code).toBe("invalid_config");

          // Switching injectionMode to native while reusing redacted credentials is also rejected.
          const retargetModeErr = yield* store
            .upsertUserServer({
              id: HarnessMcpServerId.make("docs"),
              config: {
                enabled: true,
                transport: {
                  type: "http",
                  url: "https://mcp.example.com/docs",
                  headers: { Authorization: HARNESS_SECRET_REDACTED },
                },
                injectionMode: "native",
                approvalPolicy: "auto-read",
              },
            })
            .pipe(Effect.flip);
          expect(retargetModeErr.code).toBe("invalid_config");

          // Changing URL with an explicit new header (no redaction sentinel) succeeds.
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("docs"),
            config: {
              enabled: true,
              transport: {
                type: "http",
                url: "https://mcp.example.com/docs-v2",
                headers: { Authorization: "Bearer fresh-secret-456" },
              },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });

          // Submitting a redaction sentinel for a brand-new key is rejected.
          const badSentinel = yield* store
            .upsertUserServer({
              id: HarnessMcpServerId.make("docs"),
              config: {
                enabled: true,
                transport: {
                  type: "http",
                  url: "https://mcp.example.com/docs-v2",
                  headers: { "X-New-Key": HARNESS_SECRET_REDACTED },
                },
                injectionMode: "gateway",
                approvalPolicy: "auto-read",
              },
            })
            .pipe(Effect.flip);
          expect(badSentinel.code).toBe("invalid_config");

          // setServerEnabled rejects stale expectedDigest so remote confirmations stay bound to previewed config.
          const staleToggleErr = yield* store
            .setServerEnabled({
              id: HarnessMcpServerId.make("docs"),
              enabled: false,
              expectedDigest: "000000000000000000000000",
            })
            .pipe(Effect.flip);
          expect(staleToggleErr.code).toBe("invalid_config");

          // External configDigest is keyed with a server-local CSPRNG HMAC key (not an unkeyed SHA-256).
          const resolvedDocs = (yield* store.resolveWorkspace()).servers.find(
            (s) => s.id === "docs",
          )!;
          expect(resolvedDocs.configDigest).toBe(
            store.computeConfirmationDigest(resolvedDocs.config),
          );
          expect(resolvedDocs.configDigest).toMatch(/^[0-9a-f]{24}$/u);

          // Inject malformed + reserved entries alongside the valid server.
          yield* fs.writeFileString(
            store.configPath,
            JSON.stringify(
              {
                schemaVersion: 1,
                mcpServers: {
                  docs: {
                    enabled: true,
                    transport: { type: "http", url: "https://mcp.example.com/docs" },
                  },
                  "t3-code": {
                    enabled: true,
                    transport: { type: "http", url: "https://evil.example.com" },
                  },
                  "bad.server.id": {
                    enabled: true,
                    transport: { type: "http", url: "https://invalid.example.com" },
                  },
                  broken: {
                    enabled: true,
                    transport: { type: "http", url: "not-a-url" },
                  },
                },
              },
              null,
              2,
            ),
          );

          const resilient = yield* store.loadUserConfig;
          expect(Object.keys(resilient.config.mcpServers)).toEqual(["docs"]);
          expect(resilient.invalidEntries).toHaveLength(3);

          // A single invalid project MCP URL in JSONC t3.json (with comments + trailing commas + secret query)
          // must NOT discard disabledMcpServers or valid entries, and must never echo URL secrets.
          const projectRepo = path.join(tempRoot, "partial-project");
          yield* fs.makeDirectory(projectRepo, { recursive: true });
          yield* fs.writeFileString(
            path.join(projectRepo, "t3.json"),
            `{
              // Project harness overrides with trailing commas
              "harness": {
                "disabledMcpServers": ["docs",],
                "mcpServers": {
                  "broken_project": {
                    "enabled": true,
                    "transport": {
                      "type": "http",
                      "url": "https://bad.example.com:99999/mcp?token=top-secret-t3json",
                    },
                  },
                  "good_project": {
                    "enabled": true,
                    "transport": {
                      "type": "http",
                      "url": "https://good.example.com/mcp",
                    },
                  },
                },
              },
            }`,
          );
          const partialWorkspace = yield* store.resolveWorkspace(projectRepo);
          const userDocsInProject = partialWorkspace.servers.find(
            (s) => s.id === "docs" && s.scope === "user",
          );
          expect(userDocsInProject?.overriddenByProject).toBe(true);
          expect(userDocsInProject?.effectiveEnabled).toBe(false);
          expect(
            partialWorkspace.servers.some((s) => s.id === "good_project" && s.scope === "project"),
          ).toBe(true);
          expect(partialWorkspace.invalidEntries.some((e) => e.id === "broken_project")).toBe(true);
          expect(JSON.stringify(partialWorkspace.invalidEntries)).not.toContain(
            "top-secret-t3json",
          );
        }).pipe(Effect.provide(makeTestLayer(baseDir, expectedPaths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "requires owner trust for project HTTP/secret and stdio servers, binds injectionMode and URL into digest, and rejects forged digests",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-trust-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
        const repoDir = path.join(tempRoot, "repo");
        yield* fs.makeDirectory(repoDir, { recursive: true });

        yield* fs.writeFileString(
          path.join(repoDir, "t3.json"),
          JSON.stringify({
            harness: {
              disabledMcpServers: ["disabled_user"],
              mcpServers: {
                repo_tool: {
                  enabled: true,
                  injectionMode: "gateway",
                  transport: {
                    type: "stdio",
                    command: "node",
                    args: ["scripts/mcp.mjs"],
                  },
                },
                repo_secret_http: {
                  enabled: true,
                  transport: {
                    type: "http",
                    url: "https://attacker.example.com/mcp",
                    headers: {
                      Authorization: "Bearer ${secret:MY_API_TOKEN}",
                    },
                  },
                },
              },
            },
          }),
        );

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("disabled_user"),
            config: {
              enabled: true,
              transport: { type: "http", url: "https://mcp.example.com/user" },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          });

          const first = yield* store.resolveWorkspace(repoDir);
          const disabledUser = first.servers.find((s) => s.id === "disabled_user");
          expect(disabledUser?.effectiveEnabled).toBe(false);
          expect(disabledUser?.overriddenByProject).toBe(true);

          // Project HTTP server with ${secret:...} MUST NOT auto-activate.
          const secretHttp = first.servers.find((s) => s.id === "repo_secret_http");
          expect(secretHttp?.needsTrustConfirmation).toBe(true);
          expect(secretHttp?.trustReason).toBe("secrets");
          expect(secretHttp?.requiresSecretAccess).toBe(true);
          expect(secretHttp?.effectiveEnabled).toBe(false);

          const repoTool = first.servers.find((s) => s.id === "repo_tool");
          expect(repoTool?.scope).toBe("project");
          expect(repoTool?.needsTrustConfirmation).toBe(true);
          expect(repoTool?.trustReason).toBe("stdio");
          expect(repoTool?.effectiveEnabled).toBe(false);
          expect(repoTool?.trustDigest).toBeTruthy();

          // Submitting a forged digest is rejected server-side.
          const forged = yield* store
            .trustProjectServer({
              repoRoot: repoTool!.repoRoot!,
              serverId: repoTool!.id,
              digest: "deadbeef",
            })
            .pipe(Effect.flip);
          expect(forged.code).toBe("invalid_config");

          // Authorization failure inside lock prevents persisting trust.
          const deniedAuth = yield* store
            .trustProjectServer({
              repoRoot: secretHttp!.repoRoot!,
              serverId: secretHttp!.id,
              digest: secretHttp!.trustDigest!,
              authorize: () => Effect.fail("missing_providers_manage" as const),
            })
            .pipe(Effect.flip);
          expect(deniedAuth).toBe("missing_providers_manage");
          const stillUntrusted = yield* store.resolveWorkspace(repoDir);
          expect(
            stillUntrusted.servers.find((s) => s.id === "repo_secret_http")?.effectiveEnabled,
          ).toBe(false);

          // Confirm trust with exact server-computed digest.
          yield* store.trustProjectServer({
            repoRoot: repoTool!.repoRoot!,
            serverId: repoTool!.id,
            digest: repoTool!.trustDigest!,
          });
          yield* store.trustProjectServer({
            repoRoot: secretHttp!.repoRoot!,
            serverId: secretHttp!.id,
            digest: secretHttp!.trustDigest!,
          });

          const trusted = yield* store.resolveWorkspace(repoDir);
          expect(trusted.servers.find((s) => s.id === "repo_tool")?.effectiveEnabled).toBe(true);
          expect(trusted.servers.find((s) => s.id === "repo_secret_http")?.effectiveEnabled).toBe(
            true,
          );

          // Switching injectionMode from gateway -> native OR changing URL invalidates trust!
          yield* fs.writeFileString(
            path.join(repoDir, "t3.json"),
            JSON.stringify({
              harness: {
                mcpServers: {
                  repo_tool: {
                    enabled: true,
                    injectionMode: "native",
                    transport: {
                      type: "stdio",
                      command: "node",
                      args: ["scripts/mcp.mjs"],
                    },
                  },
                  repo_secret_http: {
                    enabled: true,
                    transport: {
                      type: "http",
                      url: "https://other.example.com/mcp",
                      headers: {
                        Authorization: "Bearer ${secret:MY_API_TOKEN}",
                      },
                    },
                  },
                },
              },
            }),
          );
          const mutated = yield* store.resolveWorkspace(repoDir);
          const mutatedTool = mutated.servers.find((s) => s.id === "repo_tool");
          expect(mutatedTool?.needsTrustConfirmation).toBe(true);
          expect(mutatedTool?.effectiveEnabled).toBe(false);
          expect(mutatedTool?.trustDigest).not.toBe(repoTool?.trustDigest);

          const mutatedHttp = mutated.servers.find((s) => s.id === "repo_secret_http");
          expect(mutatedHttp?.needsTrustConfirmation).toBe(true);
          expect(mutatedHttp?.effectiveEnabled).toBe(false);
          expect(mutatedHttp?.trustDigest).not.toBe(secretHttp?.trustDigest);

          // Revoking trust succeeds cleanly.
          yield* store.revokeProjectTrust({
            repoRoot: repoTool!.repoRoot!,
            serverId: repoTool!.id,
          });
        }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("enforces lock-held authorize on setServerEnabled and ManagedPolicy limits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-policy-" });
      const baseDir = path.join(tempRoot, "t3home");
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

      yield* Effect.gen(function* () {
        const store = yield* HarnessStore.HarnessStore;
        yield* store.upsertUserServer({
          id: HarnessMcpServerId.make("remote_http"),
          config: {
            enabled: false,
            transport: { type: "http", url: "https://mcp.example.com/ok" },
            injectionMode: "gateway",
            approvalPolicy: "auto-read",
          },
        });
        const enableDenied = yield* store
          .setServerEnabled({
            id: HarnessMcpServerId.make("remote_http"),
            enabled: true,
            authorize: () => Effect.fail("denied_under_lock" as const),
          })
          .pipe(Effect.flip);
        expect(enableDenied).toBe("denied_under_lock");
        const stillDisabled = yield* store.loadUserConfig;
        expect(stillDisabled.config.mcpServers.remote_http?.enabled).toBe(false);

        const stdioAttempt = yield* store
          .upsertUserServer({
            id: HarnessMcpServerId.make("local_stdio"),
            config: {
              enabled: true,
              transport: { type: "stdio", command: "node", args: ["-v"] },
              injectionMode: "gateway",
              approvalPolicy: "auto-read",
            },
          })
          .pipe(Effect.flip);
        expect(stdioAttempt.code).toBe("policy_denied");
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths, { harnessMcpStdio: false })));

      // Full harness disable blocks resolution of already-saved servers.
      yield* Effect.gen(function* () {
        const store = yield* HarnessStore.HarnessStore;
        const resolved = yield* store.resolveWorkspace();
        expect(resolved.managedPolicyAllowsHarness).toBe(false);
        expect(resolved.servers[0]?.effectiveEnabled).toBe(false);
        expect(resolved.servers[0]?.blockedByPolicyReason).toContain("Acme Corp");
      }).pipe(Effect.provide(makeTestLayer(baseDir, paths, { harness: false })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "redacts URL query params, fragments, and sensitive stdio args, enforces stdio target binding, and rejects dynamic reserved prefixes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-redact-" });
        const baseDir = path.join(tempRoot, "t3home");
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

        // Dynamic reserved prefixes used by OpenCode 2 thread-scoped servers must be rejected.
        expect(decodeHarnessServerId("t3-code-thread1")._tag).toBe("None");
        expect(decodeHarnessServerId("t3-harness-thread1")._tag).toBe("None");
        expect(decodeHarnessServerId("t3_harness_custom")._tag).toBe("None");

        const { redactHarnessServerConfig } = yield* Effect.promise(
          () => import("./HarnessSecrets.ts"),
        );

        yield* Effect.gen(function* () {
          const store = yield* HarnessStore.HarnessStore;
          const httpConfig = {
            enabled: true,
            transport: {
              type: "http" as const,
              url: "https://user:pass@api.example.com/mcp?api_key=live-secret-key&mode=fast#frag-token",
              headers: { Authorization: "Bearer header-secret" },
            },
            injectionMode: "gateway" as const,
            approvalPolicy: "auto-read" as const,
          };
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("query_srv"),
            config: httpConfig,
          });
          const redactedHttp = redactHarnessServerConfig(httpConfig);
          expect(redactedHttp.transport.type).toBe("http");
          if (redactedHttp.transport.type === "http") {
            expect(redactedHttp.transport.url).not.toContain("live-secret-key");
            expect(redactedHttp.transport.url).not.toContain("frag-token");
            expect(redactedHttp.transport.url).not.toContain("pass");
            expect(redactedHttp.transport.url).toContain(`api_key=${HARNESS_SECRET_REDACTED}`);
          }

          // Re-saving redacted HTTP config with same target preserves stored query/hash/headers.
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("query_srv"),
            config: { ...redactedHttp, description: "Kept query credentials" },
          });
          const reloadedHttp = (yield* store.loadUserConfig).config.mcpServers.query_srv;
          expect(
            reloadedHttp?.transport.type === "http" ? reloadedHttp.transport.url : "",
          ).toContain("api_key=live-secret-key");
          expect(
            reloadedHttp?.transport.type === "http" ? reloadedHttp.transport.url : "",
          ).toContain("#frag-token");

          // Stdio sensitive args and env are redacted in read models and bound to command+cwd+args.
          const stdioConfig = {
            enabled: true,
            transport: {
              type: "stdio" as const,
              command: "npx",
              args: [
                "-y",
                "mcp-tool",
                "--api-key",
                "super-secret-arg",
                "--token=inline-tok",
                "https://mcp.example.com/hook?secret=url-arg-secret",
              ],
              cwd: "/tmp/work",
              env: { API_TOKEN: "env-secret-999" },
            },
            injectionMode: "gateway" as const,
            approvalPolicy: "auto-read" as const,
          };
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("stdio_srv"),
            config: stdioConfig,
          });
          const redactedStdio = redactHarnessServerConfig(stdioConfig);
          if (redactedStdio.transport.type === "stdio") {
            expect(redactedStdio.transport.args).toEqual([
              "-y",
              "mcp-tool",
              "--api-key",
              HARNESS_SECRET_REDACTED,
              `--token=${HARNESS_SECRET_REDACTED}`,
              `https://mcp.example.com/hook?secret=${HARNESS_SECRET_REDACTED}`,
            ]);
            expect(redactedStdio.transport.env?.API_TOKEN).toBe(HARNESS_SECRET_REDACTED);
          }

          // Editing metadata with unchanged command/cwd/args restores redacted args + env.
          yield* store.upsertUserServer({
            id: HarnessMcpServerId.make("stdio_srv"),
            config: { ...redactedStdio, description: "Same stdio target" },
          });
          const reloadedStdio = (yield* store.loadUserConfig).config.mcpServers.stdio_srv;
          expect(
            reloadedStdio?.transport.type === "stdio" ? reloadedStdio.transport.args?.[3] : "",
          ).toBe("super-secret-arg");
          expect(
            reloadedStdio?.transport.type === "stdio" ? reloadedStdio.transport.env?.API_TOKEN : "",
          ).toBe("env-secret-999");

          // Changing stdio command while keeping redacted env/args MUST be rejected.
          const retargetStdioErr = yield* store
            .upsertUserServer({
              id: HarnessMcpServerId.make("stdio_srv"),
              config: {
                ...redactedStdio,
                transport: {
                  ...(redactedStdio.transport.type === "stdio"
                    ? redactedStdio.transport
                    : { type: "stdio" as const, command: "sh" }),
                  command: "evil-bin",
                },
              },
            })
            .pipe(Effect.flip);
          expect(retargetStdioErr.code).toBe("invalid_config");
        }).pipe(Effect.provide(makeTestLayer(baseDir, paths)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
