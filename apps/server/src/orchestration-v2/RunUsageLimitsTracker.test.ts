import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import {
  RunUsageLimitsTracker,
  layerFromProviderInstanceRegistry,
  usageLimitsSnapshotsEqual,
} from "./RunUsageLimitsTracker.ts";

function makeSnapshot(usageLimits?: ServerProviderUsageLimits): ServerProvider {
  return {
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(usageLimits ? { usageLimits } : {}),
  };
}

describe("RunUsageLimitsTracker", () => {
  it.effect("reads current usage limits and refreshes them on demand", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make<ServerProvider>(
        makeSnapshot({
          checkedAt: "2026-10-01T00:00:00.000Z",
          windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 20 }],
        }),
      );
      const mockRegistry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.succeed({
            snapshot: {
              getSnapshot: Ref.get(current),
              refresh: Ref.get(current),
              refreshUsage: Ref.set(
                current,
                makeSnapshot({
                  checkedAt: "2026-10-01T00:01:00.000Z",
                  windows: [
                    { id: "five_hour", kind: "session", label: "Session", usedPercent: 34 },
                  ],
                }),
              ),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
              resolveMaintenance: () => Effect.die("unused"),
            },
          } as never),
      });

      const layer = layerFromProviderInstanceRegistry.pipe(Layer.provide(mockRegistry));
      const { before, after } = yield* Effect.gen(function* () {
        const tracker = yield* RunUsageLimitsTracker;
        const before = yield* tracker.readCurrent(ProviderInstanceId.make("claudeAgent"));
        const after = yield* tracker.refreshAndRead(ProviderInstanceId.make("claudeAgent"));
        return { before, after };
      }).pipe(Effect.provide(layer));

      assert.strictEqual(before?.windows[0]?.usedPercent, 20);
      assert.strictEqual(after?.windows[0]?.usedPercent, 34);
      assert.strictEqual(usageLimitsSnapshotsEqual(before, after), false);
      assert.strictEqual(usageLimitsSnapshotsEqual(after, after), true);
    }),
  );
});
