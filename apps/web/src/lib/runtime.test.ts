import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
// Load the runtime's module graph once at collection, outside the per-test timeout;
// each case re-evaluates it from that cache after vi.resetModules().
import "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const answers = (...values: Array<boolean | null>) => {
  let call = 0;
  return () => values[Math.min(call++, values.length - 1)] ?? null;
};

describe("web runtime relay telemetry policy", () => {
  it("stops exporting even if storing the opt-out fails", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => "true",
        setItem: () => {
          throw new Error("Storage is read-only");
        },
      },
    });
    const { relayTelemetryEnabled, setRelayTracingPreference } =
      await import("../cloud/publicConfig");
    expect(relayTelemetryEnabled()).toBe(true);
    expect(() => setRelayTracingPreference(false)).toThrow("Storage is read-only");
    expect(relayTelemetryEnabled()).toBe(false);
  });

  it("does not save an opt-in before desktop host permission is granted", async () => {
    vi.resetModules();
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      desktopBridge: { getRelayTelemetryEnabled: answers(null, false) },
      localStorage: { setItem },
    });
    const { getRelayTracingStatus, setRelayTracingPreference } =
      await import("../cloud/publicConfig");

    setRelayTracingPreference(true);
    setRelayTracingPreference(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(getRelayTracingStatus()).toBe("host-disabled");
  });

  it.each([
    {
      surface: "desktop opt-out despite a stored renderer opt-in",
      desktopBridge: { getRelayTelemetryEnabled: () => false },
      preference: "true",
      exports: false,
    },
    {
      surface: "desktop enabled",
      desktopBridge: { getRelayTelemetryEnabled: () => true },
      exports: true,
    },
    {
      surface: "desktop renderer opts out despite host permission",
      desktopBridge: { getRelayTelemetryEnabled: () => true },
      preference: "false",
      exports: false,
    },
    {
      // The desktop host reads the login shell after the renderer has started.
      surface: "desktop enabled once the login shell is read",
      desktopBridge: { getRelayTelemetryEnabled: answers(null, true) },
      exports: true,
      startsPending: true,
    },
    {
      surface: "desktop opt-out found in the login shell",
      desktopBridge: { getRelayTelemetryEnabled: answers(null, false, true) },
      exports: false,
    },
    {
      surface: "ordinary browser defaults to off",
      desktopBridge: undefined,
      exports: false,
    },
    {
      surface: "ordinary browser opts in",
      desktopBridge: undefined,
      preference: "true",
      exports: true,
    },
    {
      surface: "browser opts out before flush",
      desktopBridge: undefined,
      preference: "true",
      exports: false,
      disableBeforeFlush: true,
    },
  ])("applies $surface before the first relay span", async (entry) => {
    const { desktopBridge, exports, preference, startsPending, disableBeforeFlush } = entry;
    vi.resetModules();
    vi.stubEnv("T3CODE_TELEMETRY_ENABLED", "false");
    vi.stubEnv("T3CODE_OTEL_SDK_DISABLED", "true");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
    let storedPreference = preference;
    vi.stubGlobal("window", {
      desktopBridge,
      localStorage: {
        getItem: () => storedPreference,
        setItem: (_key: string, value: string) => {
          storedPreference = value;
        },
      },
    });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchFn);
    // Re-import after setting runtime policy: static initialization creates the exporter layer.
    const { runtime: freshRuntime } = await import("./runtime");
    const { setDelegate } = await import("../observability/clientTracer");
    const { setRelayTracingPreference } = await import("../cloud/publicConfig");
    const userSpans: Array<string> = [];

    try {
      if (startsPending) {
        await freshRuntime.runPromise(
          Effect.void.pipe(Effect.withSpan("relay.before-consent"), withRelayClientTracing),
        );
      }
      expect(
        await freshRuntime.runPromise(
          Effect.succeed("relay operation completed").pipe(
            Effect.withSpan("relay.first-operation"),
            withRelayClientTracing,
          ),
        ),
      ).toBe("relay operation completed");

      setDelegate(
        Tracer.make({
          span(options) {
            userSpans.push(options.name);
            return new Tracer.NativeSpan(options);
          },
        }),
      );
      await freshRuntime.runPromise(Effect.void.pipe(Effect.withSpan("user.work")));
      expect(userSpans).toEqual(["user.work"]);
    } finally {
      setDelegate(null);
      if (disableBeforeFlush) setRelayTracingPreference(false);
      // Closing the runtime flushes the exporter without waiting for its batch timer.
      await freshRuntime.dispose();
    }

    if (exports) {
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://telemetry.example.test/v1/traces");
      const payload = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
      expect(payload).toContain('"name":"relay.first-operation"');
    } else {
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });
});
