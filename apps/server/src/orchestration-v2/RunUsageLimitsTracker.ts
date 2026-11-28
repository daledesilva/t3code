import type {
  OrchestrationV2RunUsageLimitsSnapshot,
  ProviderInstanceId,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

function toRunUsageLimitsSnapshot(
  limits: ServerProviderUsageLimits | undefined,
): OrchestrationV2RunUsageLimitsSnapshot | undefined {
  if (!limits || limits.unavailable !== undefined || limits.windows.length === 0) {
    return undefined;
  }
  return {
    checkedAt: limits.checkedAt,
    windows: limits.windows,
  };
}

export function usageLimitsSnapshotsEqual(
  left: OrchestrationV2RunUsageLimitsSnapshot | undefined,
  right: OrchestrationV2RunUsageLimitsSnapshot | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.windows.length !== right.windows.length) return false;
  return left.windows.every((window, index) => {
    const other = right.windows[index];
    return (
      other !== undefined &&
      window.id === other.id &&
      window.usedPercent === other.usedPercent &&
      window.resetsAt === other.resetsAt
    );
  });
}

export class RunUsageLimitsTracker extends Context.Reference<{
  readonly readCurrent: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<OrchestrationV2RunUsageLimitsSnapshot | undefined>;
  readonly refreshAndRead: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<OrchestrationV2RunUsageLimitsSnapshot | undefined>;
}>("t3/orchestration-v2/RunUsageLimitsTracker", {
  defaultValue: () => ({
    readCurrent: () => Effect.undefined,
    refreshAndRead: () => Effect.undefined,
  }),
}) {}

export const layerFromProviderInstanceRegistry = Layer.effect(
  RunUsageLimitsTracker,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

    const readCurrent = Effect.fn("RunUsageLimitsTracker.readCurrent")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const instance = yield* instances.getInstance(instanceId);
      if (!instance) return undefined;
      const snapshot = yield* instance.snapshot.getSnapshot;
      return toRunUsageLimitsSnapshot(snapshot.usageLimits);
    });

    const refreshAndRead = Effect.fn("RunUsageLimitsTracker.refreshAndRead")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const instance = yield* instances.getInstance(instanceId);
      if (!instance?.snapshot.refreshUsage) return undefined;
      yield* instance.snapshot.refreshUsage.pipe(Effect.ignoreCause({ log: true }));
      const snapshot = yield* instance.snapshot.getSnapshot;
      return toRunUsageLimitsSnapshot(snapshot.usageLimits);
    });

    return { readCurrent, refreshAndRead };
  }),
);
