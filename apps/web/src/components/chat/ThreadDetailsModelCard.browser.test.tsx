import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderMcpServer,
  type ProviderRuntimeModeLimit,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ThreadDetailsModelCard } from "./ThreadDetailsModelCard";

function makeProvider(overrides?: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.311",
    status: "ready",
    auth: {
      status: "authenticated",
      label: "Claude Max",
      email: "dev@example.com",
    },
    checkedAt: "2026-11-28T12:00:00.000Z",
    models: [
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: Array.from({ length: 12 }, (_, index) => ({
      name: index === 0 ? "review" : `cmd-${index}`,
    })),
    skills: [
      {
        name: "test-t3-app",
        path: "/repo/.agents/skills/test-t3-app/SKILL.md",
        enabled: true,
      },
    ],
    usageLimits: {
      checkedAt: "2026-11-28T12:00:00.000Z",
      windows: [
        {
          id: "session",
          kind: "session",
          label: "5h session",
          usedPercent: 35,
          resetsAt: "2026-11-28T15:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 60,
          resetsAt: "2026-12-03T00:00:00.000Z",
          windowDurationMins: 10080,
        },
      ],
    },
    ...overrides,
  };
}

function makeEntry(provider: ServerProvider): ProviderInstanceEntry {
  return {
    instanceId: provider.instanceId,
    driverKind: provider.driver,
    displayName: provider.displayName ?? "Claude",
    snapshot: provider,
  } as ProviderInstanceEntry;
}

describe("ThreadDetailsModelCard", () => {
  it("collapses model details by default, expands on click, and renders Usage with real per-run deltas plus collapsible MCP, Skills, and Commands", async () => {
    const provider = makeProvider();
    const mcpServers: ProviderMcpServer[] = [
      {
        name: "github",
        scope: "provider",
        status: "configured",
        source: "~/.claude.json",
        transport: "http",
        enabled: true,
      },
      {
        name: "repo-postgres",
        scope: "repo",
        status: "configured",
        source: ".mcp.json",
        transport: "stdio",
        enabled: true,
      },
    ];
    const runtimeModeLimits: ProviderRuntimeModeLimit[] = [
      { mode: "auto", reason: "managed-settings" },
      { mode: "full-access", reason: "project-settings" },
    ];

    await using _screen = await render(
      <ThreadDetailsModelCard
        providerEntry={makeEntry(provider)}
        selectedModel="claude-opus-5-5"
        providers={[provider]}
        sources={[]}
        threadRuns={[
          {
            // Earlier 5h session window (reset before current 5h window) -> excluded from session, counted in weekly
            modelSelection: {
              instanceId: provider.instanceId,
              model: "claude-opus-5-5",
            },
            usageLimitsBefore: {
              checkedAt: "2026-11-28T06:00:00.000Z",
              windows: [
                {
                  id: "session",
                  kind: "session",
                  label: "5h session",
                  usedPercent: 10,
                  resetsAt: "2026-11-28T09:00:00.000Z",
                  windowDurationMins: 300,
                },
                {
                  id: "weekly",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 50,
                  resetsAt: "2026-12-03T00:00:00.000Z",
                  windowDurationMins: 10080,
                },
              ],
            },
            usageLimitsAfter: {
              checkedAt: "2026-11-28T06:05:00.000Z",
              windows: [
                {
                  id: "session",
                  kind: "session",
                  label: "5h session",
                  usedPercent: 15,
                  resetsAt: "2026-11-28T09:00:00.000Z",
                  windowDurationMins: 300,
                },
                {
                  id: "weekly",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 52,
                  resetsAt: "2026-12-03T00:00:00.000Z",
                  windowDurationMins: 10080,
                },
              ],
            },
          },
          {
            // Current 5h session & 7d weekly window -> 10% session delta, 3% weekly delta (total weekly = 5%)
            modelSelection: {
              instanceId: provider.instanceId,
              model: "claude-opus-5-5",
            },
            usageLimitsBefore: {
              checkedAt: "2026-11-28T11:30:00.000Z",
              windows: [
                {
                  id: "session",
                  kind: "session",
                  label: "5h session",
                  usedPercent: 25,
                  resetsAt: "2026-11-28T15:00:00.000Z",
                  windowDurationMins: 300,
                },
                {
                  id: "weekly",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 57,
                  resetsAt: "2026-12-03T00:00:00.000Z",
                  windowDurationMins: 10080,
                },
              ],
            },
            usageLimitsAfter: {
              checkedAt: "2026-11-28T11:35:00.000Z",
              windows: [
                {
                  id: "session",
                  kind: "session",
                  label: "5h session",
                  usedPercent: 35,
                  resetsAt: "2026-11-28T15:00:00.000Z",
                  windowDurationMins: 300,
                },
                {
                  id: "weekly",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 60,
                  resetsAt: "2026-12-03T00:00:00.000Z",
                  windowDurationMins: 10080,
                },
              ],
            },
          },
        ]}
        isServerThread={true}
        isEditingQueuedRun={true}
        mcpServers={mcpServers}
        runtimeModeLimits={runtimeModeLimits}
        cwd="/repo"
      />,
    );

    // Collapsed header shows only model name + Queued edit badge, not auth/version
    await expect.element(page.getByText("Claude Opus 5.5")).toBeVisible();
    await expect.element(page.getByText("Queued edit")).toBeVisible();
    await expect.element(page.getByText("Claude Max")).not.toBeInTheDocument();

    // Expand header -> reveals provider, version, auth (with blurred email), and provider-level restriction
    await page.getByRole("button", { name: /Claude Opus 5\.5/ }).click();
    await expect.element(page.getByText("Claude Max")).toBeVisible();
    await expect.element(page.getByText("Version 2.1.311")).toBeVisible();
    await expect.element(page.getByText("dev@example.com")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Toggle account email visibility" }).click();
    await expect.element(page.getByText("dev@example.com")).toBeVisible();
    await expect.element(page.getByText("Auto restricted")).toBeVisible();
    await expect.element(page.getByText("Full access restricted")).not.toBeInTheDocument();

    // Usage section shows header summary + Session and Weekly bars with real per-run deltas (no Thread breakdown)
    await expect.element(page.getByText("5h 65% · 7d 40%")).toBeVisible();
    await expect.element(page.getByText("Thread breakdown")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("model-card-usage-bar-thread")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("model-card-usage-delta-session")).toHaveStyle({
      left: "65%",
      width: "10%",
    });
    await expect.element(page.getByTestId("model-card-usage-delta-weekly")).toHaveStyle({
      left: "40%",
      width: "5%",
    });

    // Expand MCP servers, Skills, Commands sections
    await page.getByRole("button", { name: /MCP servers/ }).click();
    await expect.element(page.getByText("github")).toBeVisible();
    await expect.element(page.getByText("repo-postgres")).not.toBeInTheDocument();

    await page.getByRole("button", { name: /Skills/ }).click();
    await expect.element(page.getByText("test-t3-app")).toBeVisible();

    await page.getByRole("button", { name: /Commands/ }).click();
    await expect.element(page.getByText("/review")).toBeVisible();
    await expect.element(page.getByText("/cmd-11")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /Show .* more/ }))
      .not.toBeInTheDocument();
  });

  it("hides empty MCP, Skills, and Commands sections and offers Sign in when unauthenticated", async () => {
    const onOpenProviderSetup = vi.fn();
    const provider = makeProvider({
      auth: { status: "unauthenticated" },
      setup: { canAuthenticate: true, canInstall: false },
      usageLimits: undefined,
      skills: [],
      slashCommands: [],
    });

    await using _screen = await render(
      <ThreadDetailsModelCard
        providerEntry={makeEntry(provider)}
        selectedModel="claude-opus-5-5"
        providers={[provider]}
        sources={[]}
        threadRuns={[]}
        isServerThread={false}
        isEditingQueuedRun={false}
        mcpServers={[]}
        runtimeModeLimits={[]}
        cwd="/repo"
        onOpenProviderSetup={onOpenProviderSetup}
      />,
    );

    // Unauthenticated auto-expands header so Sign in is immediately reachable
    await expect.element(page.getByText("Signed out")).toBeVisible();
    await page.getByRole("button", { name: "Sign in" }).click();
    expect(onOpenProviderSetup).toHaveBeenCalledWith(provider.instanceId);

    // Empty sections are hidden
    await expect.element(page.getByRole("button", { name: /MCP servers/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /Skills/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /Commands/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /Usage/ })).not.toBeInTheDocument();
  });
});
