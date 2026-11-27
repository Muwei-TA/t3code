import { type HarnessDeliveryMatrixEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";

export const getDeliveryMatrix = Effect.fn("Harness.getDeliveryMatrix")(function* (
  registry: ProviderInstanceRegistry["Service"],
) {
  const instances = yield* registry.listInstances;
  const rows = yield* Effect.forEach(instances, (instance) =>
    Effect.gen(function* () {
      const capabilities = Option.getOrUndefined(
        yield* instance.orchestrationAdapter.getCapabilities().pipe(Effect.option),
      );
      const harness = capabilities?.harness;
      return {
        providerInstanceId: instance.instanceId,
        driverKind: instance.driverKind,
        displayName: instance.displayName ?? instance.driverKind,
        skillDelivery:
          harness?.skillMount === "plugin-dir"
            ? "native"
            : harness?.skillMount === "managed-home"
              ? "conditional-native"
              : "gateway",
        mcpDelivery: harness && harness.mcpPassthrough !== "none" ? "hybrid" : "gateway",
        toolHooksDelivery: harness?.nativeToolHooks ? "native" : "gateway",
        readsProjectAgentsMd: harness?.readsProjectAgentsMd === true,
        ...(!instance.enabled || !capabilities?.tools.supportsMcpTools
          ? {
              notes: !instance.enabled
                ? "Provider instance is disabled."
                : "MCP gateway tools unavailable for this instance.",
            }
          : harness?.skillMount === "plugin-dir" && !harness.nativeToolHooks
            ? { notes: "Harness PreToolUse and PostToolUse hooks run on gateway tools only." }
            : {}),
      } satisfies HarnessDeliveryMatrixEntry;
    }),
  );
  const unavailable = yield* registry.listUnavailable;
  return [
    ...rows,
    ...unavailable.map(
      (instance) =>
        ({
          providerInstanceId: instance.instanceId,
          driverKind: instance.driver,
          displayName: instance.displayName ?? instance.driver,
          skillDelivery: "gateway",
          mcpDelivery: "gateway",
          toolHooksDelivery: "gateway",
          readsProjectAgentsMd: false,
          notes: "Instance unavailable. Delivery capabilities could not be verified.",
        }) satisfies HarnessDeliveryMatrixEntry,
    ),
  ];
});
