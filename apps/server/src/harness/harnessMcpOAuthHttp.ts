import * as Effect from "effect/Effect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { requestUrls } from "../auth/McpOAuth.ts";
import { HARNESS_OAUTH_CALLBACK_PATH } from "./HarnessMcpOAuthService.ts";
import * as McpGateway from "./McpGateway.ts";

const headers = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export const layer = HttpRouter.add(
  "GET",
  HARNESS_OAUTH_CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const gateway = yield* McpGateway.McpGateway;
    const { issuer } = requestUrls(request);
    const callback = new URL(request.url, issuer);
    const success = yield* gateway.completeOAuth(callback.href).pipe(Effect.isSuccess);
    return HttpServerResponse.text(
      success
        ? "MCP sign-in complete. Return to T3 Code and refresh the Harness MCP server."
        : "MCP sign-in could not be completed. Return to T3 Code to start sign-in again.",
      { status: success ? 200 : 400, headers },
    );
  }).pipe(HttpMiddleware.withLoggerDisabled, Effect.withTracerEnabled(false)),
);
