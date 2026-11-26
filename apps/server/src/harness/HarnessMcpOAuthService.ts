// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds local credentials without persisting an upstream URL as a filename.
import * as NodeCrypto from "node:crypto";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  OpenIdProviderMetadataSchema,
  OAuthMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  HarnessError,
  IsoDateTime,
  type HarnessMcpRestartInput,
  supportsHarnessMcpOAuth,
} from "@t3tools/contracts";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as ByteSize from "effect/ByteSize";
import { z } from "zod";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import * as ServerConfig from "../config.ts";
import * as McpWebhookTransport from "../mcp/McpWebhookTransport.ts";
import * as HarnessStore from "./HarnessStore.ts";

export const HARNESS_OAUTH_CALLBACK_PATH = "/oauth/harness/callback";
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 64;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const Registration = z.object({
  issuer: z.string(),
  resource: z.string(),
  metadata: z.union([OAuthMetadataSchema, OpenIdProviderMetadataSchema]),
  client: OAuthClientInformationSchema,
  redirectUri: z.string(),
});
const SavedAuthorization = z.object({
  ...Registration.shape,
  tokens: OAuthTokensSchema,
  expiresAt: z.number().optional(),
});
type Registration = z.infer<typeof Registration>;
type SavedAuthorization = z.infer<typeof SavedAuthorization>;

type Server = HarnessStore.ResolvedHarnessMcpServer;
type WebTransport = Exclude<Server["config"]["transport"], { readonly type: "stdio" }>;

function oauthTransport(server: Server): WebTransport | undefined {
  const { transport } = server.config;
  return transport.type !== "stdio" && supportsHarnessMcpOAuth(server.config)
    ? transport
    : undefined;
}

function endpoint(value: string, localOrigin: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        url.origin === localOrigin &&
        (isLocalLoopbackHost(url.hostname) || isTailnetHost(url.hostname))
      ))
  ) {
    throw new Error("Invalid OAuth endpoint.");
  }
  return url;
}

const publicTransport = McpWebhookTransport.make([]);

function verifyBrowserEndpoint(url: URL, resource: URL, signal: AbortSignal) {
  if (
    url.origin === resource.origin &&
    (isLocalLoopbackHost(resource.hostname) || isTailnetHost(resource.hostname))
  )
    return Promise.resolve();
  return Effect.runPromise(publicTransport.check(url), { signal });
}

function decodeSavedAuthorization(bytes: Uint8Array): SavedAuthorization | undefined {
  try {
    const parsed = SavedAuthorization.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// The MCP SDK expects fetch. This adapter keeps redirects disabled and pins the address checked by
// the existing outbound transport when opening the socket. Local metadata stays on the configured origin.
function sdkFetch(localOrigin: string, signal: AbortSignal) {
  const localTransport = McpWebhookTransport.make([new URL(localOrigin).hostname]);
  return async (value: string | URL, init?: RequestInit): Promise<Response> => {
    const url = endpoint(String(value), localOrigin);
    const transport =
      url.origin === localOrigin &&
      (isLocalLoopbackHost(url.hostname) || isTailnetHost(url.hostname))
        ? localTransport
        : publicTransport;
    const headers = new Headers(init?.headers);
    const body = init?.body;
    if (
      !(
        body === undefined ||
        body === null ||
        typeof body === "string" ||
        body instanceof URLSearchParams
      )
    ) {
      throw new Error("Unexpected OAuth request body.");
    }
    const request = (
      init?.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url)
    ).pipe(HttpClientRequest.setHeaders(Object.fromEntries(headers)));
    const outgoing =
      body == null
        ? request
        : HttpClientRequest.bodyText(
            request,
            String(body),
            headers.get("content-type") ??
              (body instanceof URLSearchParams
                ? "application/x-www-form-urlencoded"
                : "application/json"),
          );
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* transport.check(url);
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(outgoing);
        if (response.status >= 300 && response.status < 400)
          throw new Error("OAuth endpoint redirected.");
        const data = yield* response.text;
        return new Response([204, 205, 304].includes(response.status) ? null : data, {
          status: response.status,
          headers: response.headers,
        });
      }).pipe(
        Effect.provide(transport.layerClient),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(128)),
        Effect.timeout("15 seconds"),
      ),
      { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal },
    );
  };
}

function authError(serverId: string, detail: string) {
  return new HarnessError({ code: "auth_required", serverId, detail });
}

function tokenKey(server: Server) {
  const identity = `${server.scope}\0${server.repoRoot ?? ""}\0${server.id}\0${server.configDigest}`;
  return `harness-oauth-${NodeCrypto.createHash("sha256").update(identity).digest("hex")}`;
}

export class HarnessMcpOAuthService extends Context.Service<
  HarnessMcpOAuthService,
  {
    readonly supports: (server: Server) => boolean;
    readonly start: (
      input: HarnessMcpRestartInput,
    ) => Effect.Effect<{ readonly authorizationUrl: string }, HarnessError>;
    readonly complete: (callbackUrl: string) => Effect.Effect<HarnessMcpRestartInput, HarnessError>;
    readonly disconnect: (input: HarnessMcpRestartInput) => Effect.Effect<void, HarnessError>;
    readonly bearer: (server: Server) => Effect.Effect<string | undefined, HarnessError>;
    readonly unauthorized: (
      server: Server,
      challenge: string | null,
      rejectedBearer: string | undefined,
    ) => Effect.Effect<string, HarnessError>;
    readonly status: (server: Server) => Effect.Effect<{
      readonly oauthStatus?: "required" | "connected" | "expired";
      readonly oauthExpiresAt?: IsoDateTime;
    }>;
  }
>()("t3/harness/HarnessMcpOAuthService") {}

const make = Effect.gen(function* () {
  const store = yield* HarnessStore.HarnessStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const config = yield* ServerConfig.ServerConfig;
  const cloud = yield* Effect.serviceOption(CloudLink.CloudLink);
  const locks = yield* KeyedLock.make<string>();
  const credentials = new Map<string, SavedAuthorization | undefined>();
  const challenges = new Map<string, ReturnType<typeof extractWWWAuthenticateParams>>();
  const pending = new Map<
    string,
    {
      readonly server: Server;
      readonly input: HarnessMcpRestartInput;
      readonly registration: Registration;
      readonly verifier: string;
      readonly deadline: number;
    }
  >();

  const requireServer = Effect.fn("HarnessMcpOAuthService.requireServer")(function* (
    input: HarnessMcpRestartInput,
  ) {
    const workspace = yield* store.resolveWorkspace(input.workspaceRoot);
    const server = workspace.servers.find(
      (entry) => entry.id === input.serverId && entry.effectiveEnabled && entry.trusted,
    );
    const transport = server && oauthTransport(server);
    if (!workspace.managedPolicyAllowsHarness || !server || !transport) {
      return yield* authError(
        input.serverId,
        "Enable and trust this OAuth-capable gateway server before signing in.",
      );
    }
    return { server, transport };
  });

  const read = Effect.fn("HarnessMcpOAuthService.read")(function* (server: Server) {
    const key = tokenKey(server);
    if (credentials.has(key)) return credentials.get(key);
    const bytes = yield* secrets
      .get(key)
      .pipe(Effect.mapError(() => authError(server.id, "Could not read the OAuth credentials.")));
    if (credentials.has(key)) return credentials.get(key);
    const value = Option.isSome(bytes) ? decodeSavedAuthorization(bytes.value) : undefined;
    credentials.set(key, value);
    if (credentials.size > 128) credentials.delete(credentials.keys().next().value!);
    return value;
  });

  const write = Effect.fn("HarnessMcpOAuthService.write")(function* (
    server: Server,
    value: SavedAuthorization | undefined,
  ) {
    const key = tokenKey(server);
    yield* (
      value === undefined
        ? secrets.remove(key)
        : encodeJson(value).pipe(
            Effect.flatMap((json) => secrets.set(key, new TextEncoder().encode(json))),
          )
    ).pipe(
      Effect.mapError(() => authError(server.id, "Could not update the stored OAuth credentials.")),
    );
    credentials.set(key, value);
    if (credentials.size > 128) credentials.delete(credentials.keys().next().value!);
  });

  const saveTokens = Effect.fn("HarnessMcpOAuthService.saveTokens")(function* (
    server: Server,
    registration: Registration,
    tokens: SavedAuthorization["tokens"],
    fallbackRefresh?: string,
  ) {
    if (
      tokens.token_type.toLowerCase() !== "bearer" ||
      tokens.access_token.length > 8192 ||
      !/^[A-Za-z0-9._~+/=-]+$/.test(tokens.access_token)
    ) {
      return yield* authError(server.id, "The authorization server returned an unsupported token.");
    }
    const now = yield* Clock.currentTimeMillis;
    const saved: SavedAuthorization = {
      ...Registration.parse(registration),
      tokens: { ...tokens, refresh_token: tokens.refresh_token ?? fallbackRefresh },
      expiresAt: tokens.expires_in === undefined ? undefined : now + tokens.expires_in * 1000,
    };
    yield* write(server, saved);
    return tokens.access_token;
  });

  const start = Effect.fn("HarnessMcpOAuthService.start")(function* (
    input: HarnessMcpRestartInput,
  ) {
    const { server, transport } = yield* requireServer(input);
    const cloudState = Option.isSome(cloud)
      ? yield* cloud.value.linkState().pipe(Effect.option)
      : Option.none();
    const tunnel = Option.filter(cloudState, (state) => state.linked && !state.linkRevoked).pipe(
      Option.getOrUndefined,
    )?.tunnelHostname;
    const redirectUri = `${tunnel ? `https://${tunnel}` : `http://127.0.0.1:${config.port}`}${HARNESS_OAUTH_CALLBACK_PATH}`;
    const state = NodeCrypto.randomBytes(24).toString("base64url");
    const challenge = challenges.get(tokenKey(server));
    const previous = yield* read(server);
    const flow = yield* Effect.tryPromise({
      try: async (signal) => {
        const url = new URL(transport.url);
        endpoint(transport.url, url.origin);
        const fetchFn = sdkFetch(url.origin, signal);
        const protectedResource = await discoverOAuthProtectedResourceMetadata(
          url,
          challenge?.resourceMetadataUrl
            ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
            : {},
          fetchFn,
        ).catch(() => undefined);
        if (protectedResource && new URL(protectedResource.resource).href !== url.href) {
          throw new Error("Protected resource does not match this MCP server.");
        }
        const issuer =
          transport.oauth?.authorizationServerUrl ?? protectedResource?.authorization_servers?.[0];
        if (!issuer) throw new Error("No authorization server was discovered.");
        endpoint(issuer, url.origin);
        const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn });
        if (
          !metadata ||
          metadata.issuer !== issuer ||
          !metadata.code_challenge_methods_supported?.includes("S256")
        ) {
          throw new Error("The authorization server did not advertise S256 PKCE.");
        }
        const authorizationEndpoint = endpoint(metadata.authorization_endpoint, url.origin);
        await verifyBrowserEndpoint(authorizationEndpoint, url, signal);
        endpoint(metadata.token_endpoint, url.origin);
        const requestedScope =
          transport.oauth?.scopes?.join(" ") ??
          challenge?.scope ??
          protectedResource?.scopes_supported?.join(" ");
        const client = transport.oauth?.clientId
          ? { client_id: transport.oauth.clientId }
          : previous?.issuer === issuer && previous.redirectUri === redirectUri
            ? previous.client
            : await registerClient(issuer, {
                metadata,
                fetchFn,
                ...(requestedScope ? { scope: requestedScope } : {}),
                clientMetadata: {
                  redirect_uris: [redirectUri],
                  token_endpoint_auth_method: "none",
                  client_name: "T3 Code Portable Harness",
                  grant_types: ["authorization_code", "refresh_token"],
                  response_types: ["code"],
                },
              });
        const resource = protectedResource?.resource ?? transport.url;
        const authorization = await startAuthorization(issuer, {
          metadata,
          clientInformation: client,
          redirectUrl: redirectUri,
          state,
          resource,
          ...(requestedScope ? { scope: requestedScope } : {}),
        });
        return {
          ...authorization,
          registration: { issuer, resource, metadata, client, redirectUri },
        };
      },
      catch: () =>
        authError(
          server.id,
          "Could not discover or start OAuth for this MCP server. Check its authorization server and client settings.",
        ),
    });
    const now = yield* Clock.currentTimeMillis;
    for (const [key, request] of pending) if (request.deadline <= now) pending.delete(key);
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
    pending.set(state, {
      server,
      input,
      registration: flow.registration,
      verifier: flow.codeVerifier,
      deadline: now + AUTHORIZATION_TTL_MS,
    });
    return { authorizationUrl: flow.authorizationUrl.href };
  });

  const complete = Effect.fn("HarnessMcpOAuthService.complete")(function* (callbackUrl: string) {
    const callback = URL.parse(callbackUrl);
    const state = callback?.searchParams.get("state");
    const authorization = state ? pending.get(state) : undefined;
    const now = yield* Clock.currentTimeMillis;
    if (!state || !authorization || authorization.deadline <= now || !callback) {
      return yield* new HarnessError({
        code: "invalid_config",
        detail: "OAuth sign-in expired or is invalid. Start sign-in again.",
      });
    }
    const expected = new URL(authorization.registration.redirectUri);
    if (
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      callback.username ||
      callback.password ||
      callback.hash ||
      callback.searchParams.getAll("state").length !== 1
    ) {
      return yield* authError(
        authorization.server.id,
        "The OAuth callback address does not match this sign-in.",
      );
    }
    pending.delete(state);
    const code = callback.searchParams.get("code");
    const issuer = callback.searchParams.get("iss");
    const registration = authorization.registration;
    if (
      !code ||
      callback.searchParams.getAll("code").length !== 1 ||
      callback.searchParams.has("error") ||
      (issuer !== null && issuer !== registration.issuer)
    ) {
      return yield* authError(
        authorization.server.id,
        "The authorization server did not complete sign-in.",
      );
    }
    yield* locks.withLock(
      tokenKey(authorization.server),
      Effect.gen(function* () {
        const { server, transport } = yield* requireServer(authorization.input);
        if (tokenKey(server) !== tokenKey(authorization.server)) {
          return yield* authError(
            server.id,
            "The MCP server changed during sign-in. Start sign-in again.",
          );
        }
        const tokens = yield* Effect.tryPromise({
          try: (signal) =>
            exchangeAuthorization(registration.issuer, {
              metadata: registration.metadata,
              clientInformation: registration.client,
              authorizationCode: code,
              codeVerifier: authorization.verifier,
              redirectUri: registration.redirectUri,
              resource: registration.resource,
              fetchFn: sdkFetch(new URL(transport.url).origin, signal),
            }),
          catch: () => authError(server.id, "The authorization server refused the OAuth code."),
        });
        const current = yield* requireServer(authorization.input);
        if (tokenKey(current.server) !== tokenKey(authorization.server)) {
          return yield* authError(
            server.id,
            "The MCP server changed during sign-in. Start sign-in again.",
          );
        }
        yield* saveTokens(server, registration, tokens);
      }),
    );
    return authorization.input;
  });

  const disconnect = Effect.fn("HarnessMcpOAuthService.disconnect")(function* (
    input: HarnessMcpRestartInput,
  ) {
    const { server } = yield* requireServer(input);
    const key = tokenKey(server);
    yield* locks.withLock(
      key,
      Effect.gen(function* () {
        for (const [id, request] of pending)
          if (tokenKey(request.server) === key) pending.delete(id);
        yield* write(server, undefined);
      }),
    );
  });

  const unauthorized = Effect.fn("HarnessMcpOAuthService.unauthorized")(function* (
    server: Server,
    header: string | null,
    rejectedBearer: string | undefined,
  ) {
    const transport = oauthTransport(server);
    if (!transport)
      return yield* authError(server.id, "The upstream server requires authorization.");
    const key = tokenKey(server);
    if (header) {
      const challenge = extractWWWAuthenticateParams(
        new Response(null, { headers: { "www-authenticate": header } }),
      );
      challenges.set(key, challenge);
      if (challenges.size > 128) challenges.delete(challenges.keys().next().value!);
    }
    return yield* locks.withLock(
      key,
      Effect.gen(function* () {
        const saved = yield* read(server);
        if (saved && rejectedBearer !== undefined && saved.tokens.access_token !== rejectedBearer)
          return saved.tokens.access_token;
        const refreshToken = saved?.tokens.refresh_token;
        if (!saved || !refreshToken)
          return yield* authError(server.id, "Sign in to this MCP server in Harness settings.");
        const refreshed = yield* Effect.tryPromise({
          try: (signal) =>
            refreshAuthorization(saved.issuer, {
              metadata: saved.metadata,
              clientInformation: saved.client,
              refreshToken,
              resource: saved.resource,
              fetchFn: sdkFetch(new URL(transport.url).origin, signal),
            }),
          catch: () =>
            authError(server.id, "The OAuth session expired. Sign in to this MCP server again."),
        }).pipe(Effect.tapError(() => write(server, undefined).pipe(Effect.ignore)));
        return yield* saveTokens(server, saved, refreshed, refreshToken);
      }),
    );
  });

  return HarnessMcpOAuthService.of({
    start,
    complete,
    disconnect,
    unauthorized,
    supports: (server) => oauthTransport(server) !== undefined,
    bearer: Effect.fn("HarnessMcpOAuthService.bearer")(function* (server) {
      if (!oauthTransport(server)) return;
      return (yield* read(server))?.tokens.access_token;
    }),
    status: Effect.fn("HarnessMcpOAuthService.status")(function* (server) {
      if (!oauthTransport(server) || !server.effectiveEnabled) return {};
      const saved = yield* read(server).pipe(Effect.orElseSucceed(() => undefined));
      if (!saved)
        return challenges.has(tokenKey(server)) ? { oauthStatus: "required" as const } : {};
      const now = yield* Clock.currentTimeMillis;
      return {
        oauthStatus:
          saved.expiresAt !== undefined && saved.expiresAt <= now
            ? ("expired" as const)
            : ("connected" as const),
        ...(saved.expiresAt === undefined
          ? {}
          : {
              oauthExpiresAt: IsoDateTime.make(
                DateTime.formatIso(DateTime.makeUnsafe(saved.expiresAt)),
              ),
            }),
      };
    }),
  });
});

export const layer = Layer.effect(HarnessMcpOAuthService, make);
