// @effect-diagnostics-next-line nodeBuiltinImport:off -- Computes the PKCE digest expected by the test authorization server.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture binds an HTTP listener to an explicit address family.
import * as NodeHttp from "node:http";
import { NodeCrypto as NodeCryptoLayer, NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { HarnessMcpServerId, TrimmedNonEmptyString } from "@t3tools/contracts";
import { formatHostForUrl } from "@t3tools/shared/hostClassification";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessMcpOAuthService from "./HarnessMcpOAuthService.ts";
import * as HarnessStore from "./HarnessStore.ts";
import * as McpGateway from "./McpGateway.ts";
import { connectUpstream, RingLogBuffer } from "./McpUpstreamClient.ts";

it.live.each(["127.0.0.1", "::1"])(
  "discovers and completes gateway OAuth over %s, then refreshes the stored token",
  (host) =>
    Effect.gen(function* () {
      const address = (yield* HttpServer.HttpServer).address;
      if (address._tag === "UnixPathAddress")
        return yield* Effect.die("Expected TCP fixture address");
      const origin = `http://${formatHostForUrl(host)}:${address.port}`;
      const resource = `${origin}/mcp`;
      const serverId = HarnessMcpServerId.make("oauth-fixture");
      const otherId = HarnessMcpServerId.make("oauth-other");
      const tokens = ["fixture-access-one", "fixture-access-two"];
      let acceptedToken = tokens[0];
      let refreshes = 0;
      let refreshFailure: "transient" | "invalid_grant" | null = null;
      let challenge: string | null = null;
      yield* HttpRouter.serve(
        Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/.well-known/oauth-protected-resource/mcp",
            HttpServerResponse.jsonUnsafe({
              resource: origin,
              authorization_servers: [origin],
              scopes_supported: ["tools"],
            }),
          ),
          HttpRouter.add(
            "GET",
            "/.well-known/oauth-authorization-server",
            HttpServerResponse.jsonUnsafe({
              issuer: `${origin}/`,
              authorization_response_iss_parameter_supported: true,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              registration_endpoint: `${origin}/register`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["none"],
            }),
          ),
          HttpRouter.add(
            "POST",
            "/register",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const metadata = yield* request.json;
              expect(metadata).toMatchObject({
                redirect_uris: [`${origin}/oauth/harness/callback`],
              });
              return HttpServerResponse.jsonUnsafe(
                { ...(metadata as Record<string, unknown>), client_id: "t3-fixture-client" },
                { status: 201 },
              );
            }),
          ),
          HttpRouter.add(
            "POST",
            "/token",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const form = new URLSearchParams(yield* request.text);
              expect(form.get("resource")).toBe(origin);
              expect(form.get("client_id")).toBe("t3-fixture-client");
              if (form.get("grant_type") === "refresh_token") {
                if (refreshFailure === "transient")
                  return HttpServerResponse.empty({ status: 503 });
                if (refreshFailure === "invalid_grant")
                  return HttpServerResponse.jsonUnsafe({ error: "invalid_grant" }, { status: 400 });
                expect(form.get("refresh_token")).toBe("fixture-refresh-one");
                refreshes += 1;
                return HttpServerResponse.jsonUnsafe({
                  access_token: tokens[1],
                  token_type: "Bearer",
                  refresh_token: "fixture-refresh-two",
                });
              }
              expect(form.get("code")).toBe("fixture-code");
              const verifier = form.get("code_verifier");
              expect(verifier).not.toBeNull();
              expect(NodeCrypto.createHash("sha256").update(verifier!).digest("base64url")).toBe(
                challenge,
              );
              return HttpServerResponse.jsonUnsafe({
                access_token: tokens[0],
                token_type: "Bearer",
                refresh_token: "fixture-refresh-one",
                expires_in: 3600,
              });
            }),
          ),
          HttpRouter.add(
            "POST",
            "/mcp",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.headers.authorization !== `Bearer ${acceptedToken}`) {
                return HttpServerResponse.empty({
                  status: 401,
                  headers: {
                    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="tools"`,
                  },
                });
              }
              const body = (yield* request.json) as {
                readonly id?: number;
                readonly method: string;
              };
              if (body.id === undefined) return HttpServerResponse.empty({ status: 202 });
              const result =
                body.method === "initialize"
                  ? {
                      protocolVersion: "2025-06-18",
                      capabilities: { tools: {} },
                      serverInfo: { name: "fixture", version: "1" },
                    }
                  : {
                      tools: [
                        {
                          name: "list-items",
                          inputSchema: { type: "object" },
                          annotations: { readOnlyHint: true },
                        },
                      ],
                    };
              return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: body.id, result });
            }),
          ),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const configLayer = Layer.succeed(ServerConfig.ServerConfig, {
        ...(yield* ServerConfig.deriveServerPaths(baseDir, undefined)),
        baseDir,
        mode: "web",
        host,
        port: 0,
        cwd: baseDir,
      } as ServerConfig.ServerConfig["Service"]);
      const storeLayer = HarnessStore.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(configLayer, T3ProjectFileLoader.layer, ManagedPolicy.layerTest()),
        ),
      );
      const oauthLayer = HarnessMcpOAuthService.layer.pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(storeLayer),
      );
      const gatewayLayer = McpGateway.layer.pipe(
        Layer.provideMerge(oauthLayer),
        Layer.provide(
          Layer.mock(SecretResolver.SecretResolver)({ read: () => Effect.succeed([]) }),
        ),
      );
      yield* Effect.gen(function* () {
        const store = yield* HarnessStore.HarnessStore;
        const oauth = yield* HarnessMcpOAuthService.HarnessMcpOAuthService;
        const gateway = yield* McpGateway.McpGateway;
        const transport = { type: "http", url: resource } as const;
        const base = {
          enabled: true,
          transport,
          injectionMode: "gateway",
          approvalPolicy: "auto-read",
        } as const;
        yield* store.upsertUserServer({
          id: serverId,
          config: base,
        });
        const configuredOAuth = {
          enabled: false,
          scopes: ["tools"],
          clientId: "static-client",
          authorizationServerUrl: origin,
        };
        yield* store.upsertUserServer({
          id: otherId,
          config: { ...base, transport: { ...transport, oauth: configuredOAuth } },
        });
        const otherConfig = (yield* gateway.getSnapshot()).servers.find(
          (entry) => entry.id === otherId,
        )!.config;
        expect(otherConfig.transport).toMatchObject({ oauth: configuredOAuth });
        yield* store.upsertUserServer({ id: otherId, config: otherConfig });
        expect(
          (yield* store.resolveWorkspace()).servers.find((entry) => entry.id === otherId)!.config
            .transport,
        ).toMatchObject({ oauth: configuredOAuth });
        expect((yield* Effect.flip(oauth.start({ serverId: otherId }))).code).toBe("auth_required");
        yield* store.upsertUserServer({
          id: otherId,
          config: {
            ...base,
            transport: { ...transport, oauth: { ...configuredOAuth, enabled: true } },
          },
        });
        const hosted = yield* Effect.gen(function* () {
          const hostedOauth = yield* HarnessMcpOAuthService.HarnessMcpOAuthService;
          return yield* hostedOauth.start({ serverId: otherId });
        }).pipe(
          Effect.provide(
            Layer.fresh(oauthLayer).pipe(
              Layer.provide(
                Layer.succeed(
                  HarnessMcpOAuthService.PublicOrigin,
                  Effect.succeed("https://fixture.t3coderelay.example"),
                ),
              ),
            ),
          ),
        );
        expect(new URL(hosted.authorizationUrl).searchParams.get("redirect_uri")).toBe(
          "https://fixture.t3coderelay.example/oauth/harness/callback",
        );
        const server = (yield* store.resolveWorkspace()).servers.find(
          (entry) => entry.id === serverId,
        )!;
        const logs = new RingLogBuffer();
        const connect = connectUpstream({
          serverId,
          transport,
          resolvedEnvOrHeaders: {},
          logs,
          oauth: {
            bearer: oauth.bearer(server),
            unauthorized: (header, token) => oauth.unauthorized(server, header, token),
            logs,
          },
        });
        expect(
          (yield* gateway.restartServer({ serverId })).servers.find(
            (entry) => entry.id === serverId,
          )?.state,
        ).toBe("auth_required");
        expect(yield* oauth.status(server)).toEqual({ oauthStatus: "required" });
        const signIn = new URL((yield* oauth.start({ serverId })).authorizationUrl);
        expect(signIn.searchParams.get("code_challenge_method")).toBe("S256");
        expect(signIn.searchParams.get("scope")).toBe("tools");
        challenge = signIn.searchParams.get("code_challenge");
        const callback = new URL(signIn.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", signIn.searchParams.get("state")!);
        const incorrect = new URL(callback);
        incorrect.pathname = "/wrong";
        expect((yield* Effect.flip(oauth.complete(incorrect.href))).code).toBe("invalid_config");
        expect((yield* Effect.flip(oauth.complete(callback.href))).code).toBe("invalid_config");
        callback.searchParams.set("iss", `${origin}/`);
        expect(
          (yield* Effect.flip(oauth.complete(callback.href, { serverId: otherId }))).code,
        ).toBe("invalid_config");
        expect((yield* Effect.flip(oauth.complete(`${callback.href}#`))).code).toBe(
          "invalid_config",
        );
        const authorized = yield* gateway.completeOAuth(callback.href);
        expect(authorized.servers.find((entry) => entry.id === serverId)).toMatchObject({
          state: "connected",
          oauthStatus: "connected",
          lastError: null,
          toolCount: 1,
        });
        expect((yield* Effect.flip(oauth.complete(callback.href))).code).toBe("invalid_config");
        expect(yield* oauth.complete(callback.href.replace("http://", ""), { serverId })).toEqual({
          input: { serverId },
          exchanged: false,
        });
        expect(yield* oauth.status(server)).toMatchObject({ oauthStatus: "connected" });
        const persisted = yield* Effect.gen(function* () {
          const restarted = yield* HarnessMcpOAuthService.HarnessMcpOAuthService;
          return yield* restarted.bearer(server);
        }).pipe(Effect.provide(Layer.fresh(oauthLayer)));
        expect(persisted).toBe(tokens[0]);

        const edited = yield* gateway.updateServer(
          { serverId, scope: "user" },
          store.upsertUserServer({ id: serverId, config: { ...base, description: "Updated" } }),
        );
        expect(edited.servers.find((entry) => entry.id === serverId)?.oauthStatus).toBe(
          "connected",
        );
        const connection = yield* connect;
        acceptedToken = tokens[1];
        refreshFailure = "transient";
        expect((yield* Effect.flip(connection.listTools())).code).toBe("upstream_error");
        refreshFailure = null;
        const listed = yield* Effect.all([connection.listTools(), connection.listTools()], {
          concurrency: 2,
        });
        expect(listed.map((tools) => tools[0]?.name)).toEqual(["list-items", "list-items"]);
        expect(refreshes).toBe(1);
        yield* connection.close();
        const gatewaySession = {
          providerSessionId: "fixture-provider",
          interactionMode: "default",
          runtimeMode: "full-access",
          includeProposePlan: false,
          deferredExposure: false,
        } as const;
        const tools = yield* gateway.listToolsForSession(gatewaySession);
        expect(tools.some((tool) => tool.exposedName === `${serverId}__list-items`)).toBe(true);
        acceptedToken = "invalid";
        refreshFailure = "invalid_grant";
        const denied = yield* Effect.flip(
          gateway.callToolForSession({
            context: gatewaySession,
            toolName: `${serverId}__list-items`,
            arguments: {},
          }),
        );
        expect(denied.code).toBe("auth_required");
        expect(
          (yield* gateway.getSnapshot()).servers.find((entry) => entry.id === serverId)?.state,
        ).toBe("auth_required");
        acceptedToken = tokens[0];
        const again = new URL((yield* oauth.start({ serverId })).authorizationUrl);
        challenge = again.searchParams.get("code_challenge");
        callback.searchParams.set("state", again.searchParams.get("state")!);
        yield* gateway.completeOAuth(callback.href);
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const key = HarnessMcpOAuthService.oauthCredentialKey(server)!;
        expect(Option.isSome(yield* secretStore.get(key))).toBe(true);
        yield* gateway.updateServer({ serverId, scope: "user" }, store.removeUserServer(serverId));
        expect(Option.isNone(yield* secretStore.get(key))).toBe(true);
        yield* store.upsertUserServer({ id: serverId, config: base });
        expect((yield* Effect.flip(connect)).code).toBe("auth_required");
        const workspaceRoot = TrimmedNonEmptyString.make(path.join(baseDir, "project"));
        yield* fs.makeDirectory(workspaceRoot);
        yield* fs.writeFileString(
          path.join(workspaceRoot, "t3.json"),
          JSON.stringify({
            harness: { mcpServers: { [serverId]: base } },
          }),
        );
        const projectServer = (yield* store.resolveWorkspace(workspaceRoot)).servers.find(
          (entry) => entry.scope === "project" && entry.id === serverId,
        )!;
        expect(projectServer.needsTrustConfirmation).toBe(true);
        const projectInput = { serverId, workspaceRoot };
        expect((yield* Effect.flip(oauth.start(projectInput))).code).toBe("auth_required");
        const trustInput = {
          serverId,
          repoRoot: workspaceRoot,
          digest: projectServer.trustDigest!,
        };
        yield* store.trustProjectServer(trustInput);
        const projectSignIn = new URL((yield* oauth.start(projectInput)).authorizationUrl);
        challenge = projectSignIn.searchParams.get("code_challenge");
        callback.searchParams.set("state", projectSignIn.searchParams.get("state")!);
        yield* gateway.completeOAuth(callback.href, projectInput);
        const projectKey = HarnessMcpOAuthService.oauthCredentialKey(projectServer)!;
        expect(Option.isSome(yield* secretStore.get(projectKey))).toBe(true);
        yield* gateway.updateServer(
          { ...projectInput, scope: "project" },
          store.revokeProjectTrust(trustInput),
        );
        expect(Option.isNone(yield* secretStore.get(projectKey))).toBe(true);
        yield* store.trustProjectServer(trustInput);
        expect(
          (yield* gateway.restartServer(projectInput)).servers.find(
            (entry) => entry.scope === "project" && entry.id === serverId,
          )?.state,
        ).toBe("auth_required");
        expect(
          logs
            .snapshot()
            .map((entry) => entry.text)
            .join("\n"),
        ).not.toMatch(/fixture-(access|refresh)/);
      }).pipe(Effect.provide(gatewayLayer));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host }),
          NodeCryptoLayer.layer,
        ),
      ),
    ),
);
