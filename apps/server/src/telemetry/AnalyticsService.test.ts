// @effect-diagnostics-next-line nodeBuiltinImport:off -- Verify the persisted key against the Node HMAC digest used for ingestion.
import * as NodeCrypto from "node:crypto";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { ManagedPolicyDocument } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { getTelemetryIdentity } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly serverOs?: string;
        readonly serverArch?: string;
        readonly serverAppVersion?: string;
        readonly serverMode?: string;
        readonly t3CodeVersion?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
      readonly serverOs?: string;
      readonly serverArch?: string;
      readonly serverAppVersion?: string;
      readonly serverMode?: string;
      readonly t3CodeVersion?: string;
    };
  }>;
}

const SentBatch = Schema.fromJsonString(
  Schema.Struct({
    batch: Schema.Array(
      Schema.Struct({
        uuid: Schema.String,
        event: Schema.String,
        distinct_id: Schema.String,
        properties: Schema.Struct({
          telemetryChannel: Schema.String,
          installId: Schema.optionalKey(Schema.String),
          ownerSource: Schema.optionalKey(Schema.String),
          ownerId: Schema.optionalKey(Schema.String),
          wsl: Schema.optionalKey(Schema.Boolean),
          serverWslDistro: Schema.optionalKey(Schema.Unknown),
          observedBy: Schema.optionalKey(Schema.String),
        }),
      }),
    ),
  }),
);
const decodeSentBatch = Schema.decodeEffect(SentBatch);
type SentEvent = (typeof SentBatch.Type)["batch"][number];
type Respond = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const respondWithStatus =
  (status: number): Respond =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));

/**
 * Answers 503 for `minutes` after the first send, then 204. `answers` holds each
 * answer with its time in ms after the first send (the test clock runs on across tests).
 */
const failingFor = (minutes: number) => {
  const answers: Array<{ readonly at: number; readonly status: number }> = [];
  let firstSend: number | undefined;
  const respond: Respond = (request) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      firstSend ??= now;
      const at = now - firstSend;
      const status = at < minutes * 60_000 ? 503 : 204;
      answers.push({ at, status });
      return respondWithStatus(status)(request);
    });
  return { respond, answers };
};

const recordTwentyEvents = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  for (let index = 0; index < 20; index += 1) {
    yield* analytics.record("test.retry", { index });
  }
});

const testSettingsLayer = ServerSettingsService.layerTest();

const analyticsLayerWith = (
  client: HttpClient.HttpClient,
  policy?: ManagedPolicyDocument,
  envOptIn: boolean | null = true,
  wslDistroName = "private-org-linux",
  serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-telemetry-retry-",
  }),
) =>
  AnalyticsService.layer.pipe(
    Layer.provideMerge(testSettingsLayer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...(envOptIn === null ? {} : { LIGHTNING_CODE_TELEMETRY_ENABLED: envOptIn }),
          WSL_DISTRO_NAME: wslDistroName,
          LIGHTNING_CODE_POSTHOG_KEY: "phc_test_key",
          LIGHTNING_CODE_POSTHOG_HOST: "http://localhost",
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "win32"),
        Layer.succeed(HostProcess.Architecture, "x64"),
        Layer.succeed(HttpClient.HttpClient, client),
        ManagedPolicy.layerTest(policy),
      ),
    ),
  );

const captureBatches = (respond: Respond) => {
  const batches: Array<ReadonlyArray<SentEvent>> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.body._tag === "Uint8Array") {
        const body = yield* decodeSentBatch(new TextDecoder().decode(request.body.body)).pipe(
          Effect.orDie,
        );
        batches.push(body.batch);
      }
      return yield* respond(request);
    }),
  );
  return { client, batches };
};

/**
 * Runs `record` (20 events by default), then lets `minutes` of background
 * flushes run against a client that answers every send with `respond`.
 * Returns the sent batches.
 */
const sendFor = (
  minutes: number,
  respond: Respond,
  record: Effect.Effect<
    void,
    never,
    AnalyticsService.AnalyticsService | Effect.Services<typeof getTelemetryIdentity>
  > = recordTwentyEvents,
  policy?: ManagedPolicyDocument,
) =>
  Effect.gen(function* () {
    const { client, batches } = captureBatches(respond);
    const runtimeLayer = analyticsLayerWith(client, policy);

    yield* Effect.gen(function* () {
      yield* record;
      for (let second = 0; second < minutes * 60; second += 1) {
        yield* TestClock.adjust("1 second");
      }
    }).pipe(Effect.provide(runtimeLayer));
    return batches;
  });

const testLayer = Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer);

it.layer(testLayer)("AnalyticsService test", (it) => {
  it.effect("uses the persisted HMAC key for distinct_id across analytics restarts", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const configLayer = Layer.succeed(ServerConfig.ServerConfig, config);
      const { distinctId } = yield* getTelemetryIdentity;
      assert.isString(distinctId);

      const { client, batches } = captureBatches(respondWithStatus(204));
      const send = Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        assert.isTrue(yield* analytics.record("test.identity"));
        yield* analytics.flush;
      });
      yield* Effect.scoped(
        send.pipe(Effect.provide(analyticsLayerWith(client, undefined, true, "", configLayer))),
      );
      const key = yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        return Option.getOrThrow(yield* secrets.get("telemetry-hmac-key"));
      }).pipe(Effect.provide(ServerSecretStore.layer));
      yield* Effect.scoped(
        send.pipe(Effect.provide(analyticsLayerWith(client, undefined, true, "", configLayer))),
      );

      const expected = NodeCrypto.createHmac("sha256", key)
        .update(`distinct:${distinctId}`)
        .digest("hex");
      assert.notEqual(expected, distinctId);
      assert.deepEqual(
        batches.flat().map((event) => event.distinct_id),
        [expected, expected],
      );
    }).pipe(
      Effect.provide(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-identity-" }),
      ),
    ),
  );

  it.effect.each(["", "   "])("does not report WSL for a blank distro name (%j)", (distroName) =>
    Effect.gen(function* () {
      const { client, batches } = captureBatches(respondWithStatus(204));
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.platform");
        yield* analytics.flush;
      }).pipe(Effect.provide(analyticsLayerWith(client, undefined, true, distroName)));

      const [event] = batches.flat();
      assert.isFalse(event?.properties.wsl);
      assert.notProperty(event?.properties, "serverWslDistro");
    }),
  );

  it.effect.each([false, true])(
    "uses explicit telemetry consent %s over server settings",
    (enabled) =>
      Effect.gen(function* () {
        const { client, batches } = captureBatches(respondWithStatus(204));
        yield* Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          const settings = yield* ServerSettingsService;
          yield* settings.updateSettings({ productTelemetryEnabled: !enabled });
          assert.deepEqual(yield* analytics.productTelemetryStatus, { envOverride: enabled });
          assert.equal(yield* analytics.record("test.override"), enabled);
          yield* analytics.flush;
        }).pipe(Effect.provide(analyticsLayerWith(client, undefined, enabled)));

        assert.lengthOf(batches.flat(), enabled ? 1 : 0);
      }),
  );

  it.effect("waits for desktop shell consent and honors a late telemetry opt-out", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const batches = yield* sendFor(
        0,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          assert.deepEqual(yield* analytics.productTelemetryStatus, {
            shellDiscoveryPending: true,
          });
          yield* analytics.record("test.before-discovery");
          yield* analytics.flush;
          env.LIGHTNING_CODE_TELEMETRY_ENABLED = "false";
          delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
          assert.deepEqual(yield* analytics.productTelemetryStatus, { envOverride: false });
          yield* analytics.record("test.opted-out");
          yield* analytics.flush;
          env.LIGHTNING_CODE_TELEMETRY_ENABLED = "true";
          assert.deepEqual(yield* analytics.productTelemetryStatus, { envOverride: true });
          yield* analytics.record("test.allowed");
          yield* analytics.flush;
        }),
      ).pipe(Effect.provideService(HostProcess.Environment, env));
      assert.deepEqual(
        batches.flat().map((event) => event.event),
        ["test.allowed"],
      );
    }),
  );

  it.effect("client owner reports cannot use up the server's owner cap", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(
        10,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.recordOwners(
            Array.from({ length: 1_001 }, (_, index) => ({
              source: "device" as const,
              ownerId: index.toString(16).padStart(64, "0"),
            })),
            "client",
          );
          // The event buffer also holds 1,000, so send the client events first.
          yield* analytics.flush;
          yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
        }),
      );
      const owners = batches.flat().map((event) => event.properties.observedBy);

      assert.equal(owners.filter((observedBy) => observedBy === "client").length, 1_000);
      assert.equal(owners.filter((observedBy) => observedBy === "server").length, 1);
      const events = batches.flat();
      assert.notEqual(events[0]?.properties.ownerId, "0".repeat(64));
      assert.equal(events.at(-1)?.properties.ownerId, "a".repeat(64));
      assert.isTrue(events.every(({ properties }) => properties.wsl === true));
    }),
  );

  it.effect(
    "preserves the Lightning opt-in requirement when usage data is enabled in settings",
    () =>
      Effect.gen(function* () {
        const { client, batches } = captureBatches(respondWithStatus(204));
        yield* Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          const settings = yield* ServerSettingsService;
          yield* settings.updateSettings({ productTelemetryEnabled: true });
          assert.isFalse(yield* analytics.record("disabled-without-environment-opt-in"));
          yield* analytics.flush;
        }).pipe(Effect.provide(analyticsLayerWith(client, undefined, null)));
        assert.deepEqual(batches, []);
      }),
  );

  it.effect("keeps a failed batch through a 20-minute outage and sends it once after", () =>
    Effect.gen(function* () {
      const ingest = failingFor(20);
      const batches = yield* sendFor(40, ingest.respond);
      const statuses = ingest.answers.map(({ status }) => status);
      assert.equal(statuses.at(-1), 204);
      assert.equal(statuses.filter((status) => status === 204).length, 1);
      const sentUuids = new Set(batches.map((batch) => batch.map(({ uuid }) => uuid).join()));
      assert.equal(sentUuids.size, 1);
      assert.equal(batches[0]?.length, 20);
    }),
  );

  it.effect("drops a batch that keeps failing for 30 minutes", () =>
    Effect.gen(function* () {
      const ingest = failingFor(Infinity);
      yield* sendFor(60, ingest.respond);
      const lastSend = ingest.answers.at(-1)?.at ?? 0;
      assert.isAtLeast(lastSend, 30 * 60_000);
      assert.isBelow(lastSend, 36 * 60_000);
    }),
  );

  it.effect(
    "sends nothing when a managed policy turns telemetry off, despite the environment",
    () =>
      Effect.gen(function* () {
        const policy = { schemaVersion: 1, organization: "Example Corp" } as const;
        const allowed = yield* sendFor(1, respondWithStatus(204), recordTwentyEvents, {
          ...policy,
          limits: { telemetry: true },
        });
        assert.equal(allowed.length, 1);
        const denied = yield* sendFor(1, respondWithStatus(204), recordTwentyEvents, {
          ...policy,
          limits: { telemetry: false },
        });
        assert.deepEqual(denied, []);
      }),
  );

  it.effect("drops a batch the endpoint rejects without sending it again", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(10, respondWithStatus(400));
      assert.equal(batches.length, 1);
    }),
  );

  it.effect("shutdown stops waiting for a telemetry endpoint that never answers", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        analyticsLayerWith(HttpClient.make(() => Effect.never)),
        scope,
      );
      yield* recordTwentyEvents.pipe(Effect.provide(context));

      const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(shutdown);
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const layerTelemetry = AnalyticsService.layer.pipe(
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ServerSecretStore.layer),
        Layer.provideMerge(layerServerConfig),
      );
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          LIGHTNING_CODE_TELEMETRY_ENABLED: true,
          LIGHTNING_CODE_POSTHOG_KEY: "phc_test_key",
          LIGHTNING_CODE_POSTHOG_HOST: "http://localhost",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const layerBatchServer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.orElseSucceed(() => null),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
            ManagedPolicy.layerTest(),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const { distinctId } = yield* getTelemetryIdentity;
        assert.equal(distinctId !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every(
          (request) => request.path.endsWith("/batch/") || request.path.endsWith("/batch"),
        ),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every(
            (event) =>
              event.properties?.serverOs === "Linux" &&
              event.properties.serverArch === "arm64" &&
              event.properties.serverAppVersion === event.properties.t3CodeVersion &&
              event.properties.serverMode === "web",
          ),
        ),
        true,
      );
    }),
  );

  it.effect.each([
    { name: "only enabled in the upstream environment", env: { T3CODE_TELEMETRY_ENABLED: true } },
    { name: "an explicit false", env: { LIGHTNING_CODE_TELEMETRY_ENABLED: false } },
    { name: "an unset variable, which defaults to off", env: {} },
  ])("does not send batch requests when telemetry is $name", ({ env }) =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const layerTelemetry = AnalyticsService.layer.pipe(
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ServerSecretStore.layer),
        Layer.provideMerge(layerServerConfig),
      );
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...env,
          LIGHTNING_CODE_POSTHOG_KEY: "phc_test_key",
          LIGHTNING_CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const layerBatchServer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
            ManagedPolicy.layerTest(),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});
