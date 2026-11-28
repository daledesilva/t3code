import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function codexProvider(
  instanceId: string,
  displayName: string,
  usageLimits: ServerProviderUsageLimits,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return codexProvider(instanceId, displayName, {
    checkedAt,
    windows: [],
    unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
    externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
  });
}

function onDesk(providers: ServerProvider[]) {
  return new Map([
    [
      EnvironmentId.make("desk"),
      { entry: { target: { label: "Desk" } }, serverConfig: { providers } },
    ],
  ]);
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = onDesk([
      managedChatGpt("chatgpt_work", "ChatGPT Work"),
      managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

describe("UsageLimitsPooled next refill", () => {
  it("skips elapsed resets while waiting for refreshed account data", async () => {
    function account(instanceId: string, usedPercent: number, resetsAt: string): ServerProvider {
      return {
        ...managedChatGpt(instanceId, instanceId),
        usageLimits: {
          checkedAt,
          windows: [{ id: "weekly", label: "Weekly", kind: "weekly", usedPercent, resetsAt }],
        },
      };
    }
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              account("Work", 20, "2026-10-25T17:00:00.000Z"),
              account("Personal", 60, "2026-10-25T18:00:00.000Z"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T17:30:00Z")} />,
    );
    await expect.element(screen.getByText("↻ +30%", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("↻ +30% in 30m")).toBeVisible();

    await screen.rerender(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T18:00:00Z")} />,
    );
    await expect.element(screen.getByText(/^↻ \+\d+%$/)).not.toBeInTheDocument();
  });
});

describe("UsageLimitsPooled segment bar", () => {
  it("depletes from the left with the even-pace mark at the elapsed share", async () => {
    const now = Date.parse(checkedAt);
    const presentations = onDesk([
      codexProvider("codex", "Codex", {
        checkedAt,
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "5-hour",
            usedPercent: 30,
            windowDurationMins: 300,
            resetsAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
          },
        ],
      }),
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={now} />,
    );

    const segment = screen.getByRole("button", { name: /70% left/ });
    await expect.element(segment).toBeVisible();
    const bar = segment.element().getBoundingClientRect();
    const part = (slot: string) =>
      segment.element().querySelector(`[data-slot="${slot}"]`)!.getBoundingClientRect();
    const fill = part("usage-fill");
    const restore = part("usage-restore");
    const mark = part("usage-pace-mark");

    expect(fill.right).toBeCloseTo(bar.right, 0);
    expect(fill.width).toBeCloseTo(bar.width * 0.7, 0);
    expect(restore.left).toBeCloseTo(bar.left, 0);
    expect(restore.width).toBeCloseTo(bar.width * 0.3, 0);
    // Three fifths of the window has elapsed, so even spending would leave the fill's edge there.
    expect(mark.left + mark.width / 2).toBeCloseTo(bar.left + bar.width * 0.6, 0);
  });
});
