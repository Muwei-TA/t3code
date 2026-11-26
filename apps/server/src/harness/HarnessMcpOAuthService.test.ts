// @effect-diagnostics-next-line nodeBuiltinImport:off -- Computes the PKCE digest expected by the test authorization server.
import * as NodeCrypto from "node:crypto";
import { NodeCrypto as NodeCryptoLayer, NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { HarnessMcpServerId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as HarnessMcpOAuthService from "./HarnessMcpOAuthService.ts";
import * as HarnessStore from "./HarnessStore.ts";
import { connectUpstream, RingLogBuffer } from "./McpUpstreamClient.ts";

it.live(
  "discovers OAuth on 401, verifies PKCE and callback state, and refreshes a stored upstream token",
  () =>
    Effect.gen(function* () {
      const address = (yield* HttpServer.HttpServer).address;
      if (address._tag === "UnixPathAddress")
        return yield* Effect.die("Expected TCP fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      const resource = `${origin}/mcp`;
      const serverId = HarnessMcpServerId.make("oauth-fixture");
      const tokens = ["fixture-access-one", "fixture-access-two"];
      let acceptedToken = tokens[0];
      let refreshes = 0;
      let challenge: string | null = null;
      yield* HttpRouter.serve(
        Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/.well-known/oauth-protected-resource/mcp",
            HttpServerResponse.jsonUnsafe({
              resource,
              authorization_servers: [origin],
              scopes_supported: ["tools"],
            }),
          ),
          HttpRouter.add(
            "GET",
            "/.well-known/oauth-authorization-server",
            HttpServerResponse.jsonUnsafe({
              issuer: origin,
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
              expect(form.get("resource")).toBe(resource);
              expect(form.get("client_id")).toBe("t3-fixture-client");
              if (form.get("grant_type") === "refresh_token") {
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
                  : { tools: [{ name: "list-items", inputSchema: { type: "object" } }] };
              return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: body.id, result });
            }),
          ),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);

      const baseDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const configLayer = Layer.succeed(ServerConfig.ServerConfig, {
        ...(yield* ServerConfig.deriveServerPaths(baseDir, undefined)),
        baseDir,
        mode: "web",
        host: "127.0.0.1",
        port: address.port,
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
      yield* Effect.gen(function* () {
        const store = yield* HarnessStore.HarnessStore;
        const oauth = yield* HarnessMcpOAuthService.HarnessMcpOAuthService;
        const transport = { type: "http", url: resource } as const;
        yield* store.upsertUserServer({
          id: serverId,
          config: {
            enabled: true,
            transport,
            injectionMode: "gateway",
            approvalPolicy: "auto-read",
          },
        });
        const server = (yield* store.resolveWorkspace()).servers[0]!;
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
        expect((yield* Effect.flip(connect)).code).toBe("auth_required");
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
        expect((yield* Effect.flip(oauth.complete(incorrect.href))).code).toBe("auth_required");
        expect(yield* oauth.complete(callback.href)).toEqual({ serverId });
        expect((yield* Effect.flip(oauth.complete(callback.href))).code).toBe("invalid_config");
        expect(yield* oauth.status(server)).toMatchObject({ oauthStatus: "connected" });

        const connection = yield* connect;
        acceptedToken = tokens[1];
        const listed = yield* Effect.all([connection.listTools(), connection.listTools()], {
          concurrency: 2,
        });
        expect(listed.map((tools) => tools[0]?.name)).toEqual(["list-items", "list-items"]);
        expect(refreshes).toBe(1);
        yield* connection.close();
        yield* oauth.disconnect({ serverId });
        expect((yield* Effect.flip(connect)).code).toBe("auth_required");
        expect(
          logs
            .snapshot()
            .map((entry) => entry.text)
            .join("\n"),
        ).not.toMatch(/fixture-(access|refresh)/);
      }).pipe(Effect.provide(oauthLayer));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer, NodeCryptoLayer.layer),
      ),
    ),
);
