// @effect-diagnostics nodeBuiltinImport:off -- HMAC protects telemetry identifiers with an install-local key.
// T3 ingest retains events and forwards to PostHog; UUIDs deduplicate retries there.
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ClientOs } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { getTelemetryIdentity, type TelemetryOwner } from "./Identify.ts";

interface BufferedAnalyticsEvent {
  readonly uuid: string;
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

interface DeliveryState {
  readonly failedBatch: ReadonlyArray<BufferedAnalyticsEvent>;
  readonly batchAttempts: number;
  readonly firstFailedAt: number;
  readonly failures: number;
  readonly retryAt: number;
}

interface ConsentQueue {
  readonly epoch: number;
  buffer: ReadonlyArray<BufferedAnalyticsEvent>;
  delivery: DeliveryState;
  readonly recordedOwners: Record<"server" | "client", Set<string>>;
}

// Retry delays shorter than this still wait for the next background check.
const FLUSH_INTERVAL_MS = 10_000;
// A hung send would hold the flush lock for the next background flush.
const SEND_TIMEOUT = "10 seconds";
// Quit and restart wait for this flush; events it cannot send in time are dropped.
const SHUTDOWN_FLUSH_TIMEOUT = "1 second";
// A failed batch is tried again until it has failed for this long. Ingest answers 503 when it
// cannot store a batch, and a broken Cloudflare location can take about 5 minutes to fail over.
// The waiting batch holds newer events back; `maxBufferedEvents` bounds them meanwhile.
const MAX_BATCH_RETRY_MS = 30 * 60_000;
const RETRY_BASE_DELAY_MS = 2_000;
// Clients can report any number of owner ids; past this many per observer, new ones
// are not sent. Each observer has its own cap, so client reports never crowd out the
// server's own.
const MAX_RECORDED_OWNERS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
// These statuses reject the batch itself; unlike 408/429, retrying cannot help.
const REJECTED_BATCH_STATUSES = new Set([400, 401, 413]);

/** `random` is in [0, 1). */
function retryDelayMs(failures: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

const TelemetryEnvConfig = Config.all({
  posthogKey: Config.String("T3CODE_POSTHOG_KEY").pipe(
    Config.withDefault("phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m"),
  ),
  posthogHost: Config.String("T3CODE_POSTHOG_HOST").pipe(
    Config.withDefault("https://ingest.t3.codes"),
  ),
  enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.option),
  flushBatchSize: Config.Number("T3CODE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.Number("T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.String("WSL_DISTRO_NAME").pipe(Config.option),
});

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Whether the event was queued to send; false when telemetry is off. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<boolean>;

    readonly flush: Effect.Effect<void>;

    /**
     * Records `install.owner_observed` for each owner of this install that the
     * server read itself or a connecting client reported. Each owner is sent once
     * per server process, so reconnects and repeated reads are free.
     */
    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    default:
      return "other";
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const wsl = Option.exists(telemetryConfig.wslDistroName, (value) => value.trim().length > 0);
  const hostEnvironment = yield* HostProcess.Environment;
  const awaitingShellConsent = hostEnvironment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1";
  // A managed policy can switch analytics off over the environment, never on.
  const policyAllows =
    ManagedPolicy.deniedBy(yield* ManagedPolicy.ManagedPolicy, "telemetry") === undefined;
  const settings = yield* ServerSettingsService;
  // A cached PATH does not establish consent from the current login shell.
  const telemetryOverride = Effect.suspend((): Effect.Effect<Option.Option<boolean>> => {
    if (!policyAllows || !Option.getOrElse(telemetryConfig.enabled, () => true)) {
      return Effect.succeedSome(false);
    }
    if (!awaitingShellConsent) return Effect.succeed(telemetryConfig.enabled);
    if (hostEnvironment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1") {
      return Effect.succeedSome(false);
    }
    const preference = hostEnvironment.T3CODE_TELEMETRY_ENABLED;
    return Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(
      Config.option,
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: preference === undefined ? {} : { T3CODE_TELEMETRY_ENABLED: preference },
        }),
      ),
      Effect.orElseSucceed(() => Option.some(false)),
    );
  });
  const consentEpoch = telemetryOverride.pipe(
    Effect.flatMap(
      Option.match({
        onSome: (enabled) => Effect.succeed(enabled ? -1 : null),
        onNone: () => settings.getProductTelemetryConsent.pipe(Effect.orElseSucceed(() => null)),
      }),
    ),
  );
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const { distinctId, installId } = yield* getTelemetryIdentity;
  const secrets = yield* ServerSecretStore;
  const telemetryKey = yield* Effect.cached(
    secrets.getOrCreateRandom("telemetry-hmac-key", 32).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load the telemetry privacy key", {
          errorTag: error._tag,
        }).pipe(Effect.as(null)),
      ),
    ),
  );
  const crypto = yield* SecureRandom.SecureRandom;
  const emptyDelivery: DeliveryState = {
    failedBatch: [],
    batchAttempts: 0,
    firstFailedAt: 0,
    failures: 0,
    retryAt: 0,
  };
  let currentQueue: ConsentQueue | null = null;
  const getQueue = consentEpoch.pipe(
    Effect.map((epoch) => {
      if (epoch === null) {
        currentQueue = null;
      } else if (currentQueue?.epoch !== epoch) {
        currentQueue = {
          epoch,
          buffer: [],
          delivery: emptyDelivery,
          recordedOwners: { server: new Set(), client: new Set() },
        };
      }
      return currentQueue;
    }),
  );
  // The background flush and the shutdown flush must not send the same batch at once.
  const flushLock = yield* Semaphore.make(1);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;

  const enqueueBufferedEvent = (
    queue: ConsentQueue,
    uuid: string,
    event: string,
    properties?: Readonly<Record<string, unknown>>,
  ) =>
    Effect.map(DateTime.now, (now) => {
      const appended = [
        ...queue.buffer,
        {
          uuid,
          event,
          ...(properties ? { properties } : {}),
          capturedAt: DateTime.formatIso(now),
        } satisfies BufferedAnalyticsEvent,
      ];
      queue.buffer =
        appended.length > telemetryConfig.maxBufferedEvents
          ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
          : appended;
      return { size: queue.buffer.length, dropped: queue.buffer.length !== appended.length };
    });

  const takeBatch = (queue: ConsentQueue) => {
    const next = queue.buffer.slice(0, telemetryConfig.flushBatchSize);
    queue.buffer = queue.buffer.slice(next.length);
    return next;
  };

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    queue: ConsentQueue,
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    if (!distinctId) return;
    const key = yield* telemetryKey;
    if (key === null) return;
    const hashedDistinctId = NodeCrypto.createHmac("sha256", key)
      .update(`distinct:${distinctId}`)
      .digest("hex");

    const payload = {
      api_key: telemetryConfig.posthogKey,
      batch: events.map((event) => ({
        uuid: event.uuid,
        event: event.event,
        distinct_id: hashedDistinctId,
        properties: {
          ...event.properties,
          ...(installId === null ? {} : { installId }),
          $process_person_profile: false,
          platform: hostPlatform,
          wsl,
          arch: hostArchitecture,
          t3CodeVersion: packageJson.version,
          telemetryChannel: ServerConfig.telemetryChannel,
          clientType,
          serverOs: serverOsFromNodePlatform(hostPlatform),
          serverArch: hostArchitecture,
          serverAppVersion: packageJson.version,
          serverMode: serverConfig.mode,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap((request) =>
        getQueue.pipe(
          Effect.flatMap((active) =>
            active === queue
              ? httpClient
                  .execute(request)
                  .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.asVoid)
              : Effect.void,
          ),
        ),
      ),
      Effect.timeout(SEND_TIMEOUT),
    );
  });

  // Back off even after dropping rejected batches so bad API keys cannot drain the queue in a tight loop.
  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    while (true) {
      const queue = yield* getQueue;
      if (queue === null) return;
      const delivery = queue.delivery;
      const batch = delivery.failedBatch.length > 0 ? delivery.failedBatch : takeBatch(queue);
      if (batch.length === 0) {
        return;
      }

      const sent = yield* Effect.result(sendBatch(queue, batch));
      if (queue !== (yield* getQueue)) return;
      if (Result.isSuccess(sent)) {
        queue.delivery = emptyDelivery;
        continue;
      }

      const now = yield* Clock.currentTimeMillis;
      const failures = delivery.failures + 1;
      const batchAttempts = delivery.batchAttempts + 1;
      const firstFailedAt = delivery.batchAttempts === 0 ? now : delivery.firstFailedAt;
      const retryAt = now + retryDelayMs(failures, yield* Random.next);
      const error = sent.failure;
      const rejected =
        error._tag === "HttpClientError" &&
        error.reason._tag === "StatusCodeError" &&
        REJECTED_BATCH_STATUSES.has(error.reason.response.status);
      if (!rejected && now - firstFailedAt < MAX_BATCH_RETRY_MS) {
        queue.delivery = {
          failedBatch: batch,
          batchAttempts,
          firstFailedAt,
          failures,
          retryAt,
        };
        yield* Effect.logDebug("Failed to send telemetry batch; will retry", {
          attempt: batchAttempts,
          cause: error,
        });
        return;
      }
      queue.delivery = {
        failedBatch: [],
        batchAttempts: 0,
        firstFailedAt: 0,
        failures,
        retryAt,
      };
      yield* Effect.logWarning(
        rejected
          ? "Dropped telemetry batch the endpoint rejected"
          : "Dropped telemetry batch after repeated send failures",
        { events: batch.length, attempts: batchAttempts, cause: error },
      );
      return;
    }
  }).pipe(flushLock.withPermit);

  const flushWhenDue = Effect.gen(function* () {
    const queue = yield* getQueue;
    if (queue !== null && (yield* Clock.currentTimeMillis) >= queue.delivery.retryAt) {
      yield* flush;
    }
  });

  const recordInQueue = Effect.fnUntraced(function* (
    queue: ConsentQueue,
    event: string,
    properties?: Readonly<Record<string, unknown>>,
  ) {
    if (!distinctId || (yield* telemetryKey) === null) return false;
    const uuid = yield* Effect.exit(crypto.uuidV7());
    if (Exit.isFailure(uuid) || queue !== (yield* getQueue)) return false;
    const enqueueResult = yield* enqueueBufferedEvent(queue, uuid.value, event, properties);
    if (enqueueResult.dropped) {
      yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
        size: enqueueResult.size,
        event,
      });
    }
    return true;
  });

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      const queue = yield* getQueue;
      return queue !== null && (yield* recordInQueue(queue, event, properties));
    },
  );

  const recordOwners: AnalyticsService["Service"]["recordOwners"] = Effect.fn(
    "AnalyticsService.recordOwners",
  )(function* (owners, observedBy) {
    const queue = yield* getQueue;
    if (queue === null) return;
    const key = yield* telemetryKey;
    if (key === null) return;
    yield* Effect.forEach(
      owners,
      Effect.fnUntraced(function* ({ source, ownerId }: TelemetryOwner) {
        const scopedId =
          source === "connect"
            ? ownerId
            : NodeCrypto.createHmac("sha256", key)
                .update(`owner:${source}:${ownerId}`)
                .digest("hex");
        const ownerKey = `${source}:${scopedId}`;
        const seen = queue.recordedOwners[observedBy];
        if (seen.has(ownerKey) || seen.size >= MAX_RECORDED_OWNERS) return;
        seen.add(ownerKey);
        const queued = yield* recordInQueue(queue, "install.owner_observed", {
          ownerSource: source,
          ownerId: scopedId,
          observedBy,
        });
        if (!queued) seen.delete(ownerKey);
      }),
      { discard: true },
    );
  });

  yield* Effect.forever(Effect.sleep(FLUSH_INTERVAL_MS).pipe(Effect.andThen(flushWhenDue)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    flush.pipe(Effect.timeout(SHUTDOWN_FLUSH_TIMEOUT), Effect.ignore),
  );

  return AnalyticsService.of({ record, flush, recordOwners });
});

export const layer = Layer.effect(AnalyticsService, make);
