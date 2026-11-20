import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  exhaustedModelUsageLimitBannerItem,
  usageLimitRecoveryBannerItem,
} from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});

describe("exhaustedModelUsageLimitBannerItem", () => {
  it("includes the model label and reset time without recovery actions", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    const banner = exhaustedModelUsageLimitBannerItem({
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "gemini-2.5-pro",
      modelLabel: "Gemini 2.5 Pro · High",
      resetAt: new Date(2026, 9, 20, 17, 30).toISOString(),
      timestampFormat: "24-hour",
    });

    expect(banner).toMatchObject({
      id: "exhausted-model-usage-limit:antigravity:gemini-2.5-pro",
      variant: "warning",
      title: "Usage limit reached",
      description: "Gemini 2.5 Pro · High · Resets 17:30",
    });
    expect(banner.actions).toBeUndefined();
  });

  it("falls back to the model label when no reset time is reported", () => {
    const banner = exhaustedModelUsageLimitBannerItem({
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "gemini-2.5-pro",
      modelLabel: "Gemini 2.5 Pro",
      resetAt: null,
      timestampFormat: "24-hour",
    });

    expect(banner.description).toBe("Gemini 2.5 Pro · Reset time unavailable");
  });
});
