import {
  ContextHandoffId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveComposerContextImplication,
  resolveHandoffEndpoints,
  resolveModelSwitchChange,
  resolvePendingHandoff,
  resolveQueuedRunSelectionDiffs,
  type HandoffTimelineRun,
} from "./handoff.ts";

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const item = {
  runId: RunId.make("target"),
  fromProviderInstanceIds: [from],
  toProviderInstanceId: to,
};
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

describe("handoff endpoints shared by web and mobile", () => {
  it("preserves stamped models including several models from the same provider", () => {
    const fromModelSelections = [
      { instanceId: from, model: "source-a" },
      { instanceId: from, model: "source-b" },
    ];
    expect(
      resolveHandoffEndpoints({ ...item, fromModelSelections, toModel: "destination" }, [
        run("target", 2, to, "later-model"),
      ]),
    ).toEqual({
      from: fromModelSelections,
      to: { instanceId: to, model: "destination" },
    });
  });

  it("recovers legacy models from the handoff run and latest earlier source run", () => {
    const runs = [
      run("later", 4, from, "wrong-later-model"),
      run("old", 1, from, "old-model"),
      run("target", 3, to, "destination"),
      run("source", 2, from, "source-model"),
    ];
    expect(resolveHandoffEndpoints(item, runs)).toEqual({
      from: [{ instanceId: from, model: "source-model" }],
      to: { instanceId: to, model: "destination" },
    });
  });

  it("retains provider identities when historical runs are not loaded", () => {
    expect(resolveHandoffEndpoints(item, [])).toEqual({
      from: [{ instanceId: from, model: undefined }],
      to: { instanceId: to, model: undefined },
    });
  });

  it("does not borrow a target model from another provider", () => {
    expect(
      resolveHandoffEndpoints(item, [run("target", 2, from, "wrong-model")]).to.model,
    ).toBeUndefined();
  });
});

const projection = {
  runs: [
    {
      ...run("source", 1, from, "source"),
      status: "completed",
      contextHandoffId: null,
      startedAt: "2026-10-11T00:00:00Z",
    },
  ],
  visibleTurnItems: [{ item: { type: "user_message" } }],
} as unknown as OrchestrationV2ThreadProjection;

describe("pending context handoff", () => {
  it("removes the preview while the handoff starts", () => {
    const selection = { instanceId: to, model: "destination" };
    const providers = [{ instanceId: from }] as unknown as ServerProvider[];
    const starting = {
      ...projection,
      runs: [
        ...projection.runs,
        {
          ...projection.runs[0]!,
          ...run("target", 2, to, "destination"),
          status: "starting" as const,
          startedAt: null,
          contextHandoffId: ContextHandoffId.make("handoff"),
        },
      ],
    };

    expect(resolvePendingHandoff(projection, selection, providers)).not.toBeNull();
    expect(resolvePendingHandoff(starting, selection, providers)).toBeNull();
    expect(
      resolvePendingHandoff(starting, { instanceId: from, model: "source" }, providers),
    ).toEqual({
      from: [selection],
      to: { instanceId: from, model: "source" },
    });
  });

  it.each(["preparing", "queued", "failed", "cancelled", "rolled_back"] as const)(
    "keeps the preview when an unstarted handoff run is %s",
    (status) => {
      const selection = { instanceId: to, model: "destination" };
      const unstarted = {
        ...projection,
        runs: [
          ...projection.runs,
          {
            ...projection.runs[0]!,
            ...run("target", 2, to, "destination"),
            status,
            startedAt: null,
            contextHandoffId: ContextHandoffId.make("handoff"),
          },
        ],
      };

      expect(resolvePendingHandoff(unstarted, selection, [])).toEqual({
        from: [{ instanceId: from, model: "source" }],
        to: selection,
      });
    },
  );

  it("appears on selection, updates the destination, and disappears on returning", () => {
    expect(resolvePendingHandoff(projection, { instanceId: to, model: "first" }, [])).toEqual({
      from: [{ instanceId: from, model: "source" }],
      to: { instanceId: to, model: "first" },
    });
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "second" }, [])?.to.model,
    ).toBe("second");
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "source" }, [])).toBeNull();
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "other" }, [])).toBeNull();
  });
  it("stays hidden while the thread's timeline is empty", () => {
    const empty = { ...projection, visibleTurnItems: [] };
    expect(resolvePendingHandoff(empty, { instanceId: to, model: "first" }, [])).toBeNull();
    // Paging can leave a window of only tool rows after the prompt.
    const toolRowsOnly = {
      ...projection,
      visibleTurnItems: [{ item: { type: "command_execution" } }],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(
      resolvePendingHandoff(toolRowsOnly, { instanceId: to, model: "first" }, [])?.to.model,
    ).toBe("first");
  });
  it("resumes compatible account overlays without showing a handoff", () => {
    const providers = [from, to].map((instanceId) => ({
      instanceId,
      driver: "codex",
      continuation: { groupKey: "shared" },
    })) as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "target" }, providers),
    ).toBeNull();
  });

  it("compares against the tail of the queue when afterQueue is set", () => {
    const withQueue = {
      ...projection,
      runs: [
        ...projection.runs,
        {
          ...projection.runs[0]!,
          ...run("queued-1", 2, from, "source"),
          status: "queued" as const,
          queuePosition: 1,
          startedAt: null,
          userMessageId: "msg:1",
        },
        {
          ...projection.runs[0]!,
          ...run("queued-2", 3, to, "destination"),
          status: "queued" as const,
          queuePosition: 2,
          startedAt: null,
          userMessageId: "msg:2",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;

    // Composer matches queue tail (to): no duplicate pending handoff below the queue.
    expect(
      resolvePendingHandoff(withQueue, { instanceId: to, model: "destination" }, [], {
        afterQueue: true,
      }),
    ).toBeNull();
    // Composer returns to `from`: pending handoff compares against queue tail (`to`).
    expect(
      resolvePendingHandoff(withQueue, { instanceId: from, model: "source" }, [], {
        afterQueue: true,
      }),
    ).toEqual({
      from: [{ instanceId: to, model: "destination" }],
      to: { instanceId: from, model: "source" },
    });
  });
});

describe("queued run selection diffs", () => {
  const codex = ProviderInstanceId.make("codex_personal");
  const claude = ProviderInstanceId.make("claudeAgent");
  const codexAlt = ProviderInstanceId.make("codex_work");
  const providers = [
    {
      instanceId: codex,
      driver: "codex",
      continuation: { groupKey: "codex-shared" },
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                type: "select",
                role: "reasoning",
                options: [
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
        {
          slug: "gpt-5.4-mini",
          name: "GPT-5.4 Mini",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                type: "select",
                role: "reasoning",
                options: [
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
      ],
    },
    {
      instanceId: codexAlt,
      driver: "codex",
      continuation: { groupKey: "codex-shared" },
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", capabilities: null }],
    },
    {
      instanceId: claude,
      driver: "claudeAgent",
      models: [
        {
          slug: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                type: "select",
                role: "reasoning",
                options: [
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          capabilities: null,
        },
      ],
    },
  ] as unknown as ServerProvider[];

  const baseProjection = {
    thread: { modelSelection: { instanceId: codex, model: "gpt-5.4" } },
    runs: [
      {
        ...run("active", 1, codex, "gpt-5.4"),
        status: "running",
        startedAt: "2026-10-11T00:00:00Z",
        contextHandoffId: null,
      },
    ],
    providerThreads: [{ providerInstanceId: codex, nativeThreadRef: { nativeId: "native:1" } }],
  } as unknown as OrchestrationV2ThreadProjection;

  it("shows only what changed and hides context implications when there are none", () => {
    const diffs = resolveQueuedRunSelectionDiffs(
      baseProjection,
      [
        // Identical to active run: no badge.
        { run: { modelSelection: { instanceId: codex, model: "gpt-5.4" } } },
        // Same model, thinking level changed: only effort, no context implication.
        {
          run: {
            modelSelection: {
              instanceId: codex,
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          },
        },
        // Same provider & thinking level, model changed: only model, no context implication.
        {
          run: {
            modelSelection: {
              instanceId: codex,
              model: "gpt-5.4-mini",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          },
        },
      ],
      providers,
    );

    expect(diffs[0]).toBeNull();
    expect(diffs[1]).toMatchObject({
      providerChanged: false,
      modelChanged: false,
      effortLabel: "High",
      speedLabel: null,
      contextImplication: null,
    });
    expect(diffs[2]).toMatchObject({
      providerChanged: false,
      modelChanged: true,
      effortLabel: null,
      speedLabel: null,
      contextImplication: null,
    });
  });

  it("shows provider-only change for same model across providers and tracks full vs delta handoff", () => {
    const diffs = resolveQueuedRunSelectionDiffs(
      baseProjection,
      [
        // Same model, different provider (first time on claude): provider icon only + full_handoff.
        { run: { modelSelection: { instanceId: claude, model: "gpt-5.4" } } },
        // Return to codex (already visited): delta_handoff.
        { run: { modelSelection: { instanceId: codex, model: "gpt-5.4" } } },
        // Switch back to claude (now visited via item 0): delta_handoff + model + effort.
        {
          run: {
            modelSelection: {
              instanceId: claude,
              model: "claude-opus-4-6",
              options: [{ id: "effort", value: "high" }],
            },
          },
        },
      ],
      providers,
    );

    expect(diffs[0]).toMatchObject({
      providerChanged: true,
      modelChanged: false,
      effortLabel: null,
      contextImplication: { kind: "full_handoff" },
    });
    expect(diffs[1]).toMatchObject({
      providerChanged: true,
      modelChanged: false,
      contextImplication: { kind: "delta_handoff" },
    });
    expect(diffs[2]).toMatchObject({
      providerChanged: true,
      modelChanged: true,
      effortLabel: "High",
      contextImplication: { kind: "delta_handoff" },
    });
  });

  it("omits context implications for same-continuation account switches and flags fresh sessions", () => {
    const diffs = resolveQueuedRunSelectionDiffs(
      baseProjection,
      [
        { run: { modelSelection: { instanceId: codexAlt, model: "gpt-5.4" } } },
        { run: { modelSelection: { instanceId: codexAlt, model: "gpt-5.4" }, freshContext: true } },
      ],
      providers,
    );

    expect(diffs[0]).toMatchObject({
      providerChanged: true,
      modelChanged: false,
      contextImplication: null,
    });
    expect(diffs[1]).toMatchObject({
      providerChanged: false,
      modelChanged: false,
      contextImplication: { kind: "fresh_session" },
    });
  });

  it("resolves composer context implications after the queue and while editing a queued prompt", () => {
    const q1Id = RunId.make("q1");
    const q2Id = RunId.make("q2");
    const projection = {
      thread: { modelSelection: { instanceId: from, model: "gpt-5.4" } },
      visibleTurnItems: [{ id: "row-1" }],
      providerThreads: [{ providerInstanceId: from, nativeThreadRef: "native-codex" }],
      runs: [
        {
          id: RunId.make("active"),
          ordinal: 1,
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
          contextHandoffId: null,
          providerInstanceId: from,
          modelSelection: { instanceId: from, model: "gpt-5.4" },
          userMessageId: "m-active",
        },
        {
          id: q1Id,
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          startedAt: null,
          contextHandoffId: null,
          providerInstanceId: to,
          modelSelection: { instanceId: to, model: "claude-opus-4-6" },
          userMessageId: "m-q1",
        },
        {
          id: q2Id,
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          startedAt: null,
          contextHandoffId: null,
          providerInstanceId: from,
          modelSelection: { instanceId: from, model: "gpt-5.4" },
          userMessageId: "m-q2",
        },
      ],
      messages: [],
    } as unknown as OrchestrationV2ThreadProjection;

    // After the queue (tail is `from`), switching back to `to` (visited by q1) is a delta handoff.
    expect(
      resolveComposerContextImplication(
        projection,
        { instanceId: to, model: "claude-sonnet-4-6" },
        [],
      ),
    ).toEqual({
      kind: "delta_handoff",
      from: { instanceId: from, model: "gpt-5.4" },
      to: { instanceId: to, model: "claude-sonnet-4-6" },
    });

    // Staying on the tail's provider has no context implication.
    expect(
      resolveComposerContextImplication(
        projection,
        { instanceId: from, model: "gpt-5.4-mini" },
        [],
      ),
    ).toBeNull();

    // Fresh session armed (/clear) reports fresh_session even on the same provider.
    expect(
      resolveComposerContextImplication(projection, { instanceId: from, model: "gpt-5.4" }, [], {
        freshSessionPending: true,
      }),
    ).toEqual({
      kind: "fresh_session",
      from: { instanceId: from, model: "gpt-5.4" },
      to: { instanceId: from, model: "gpt-5.4" },
    });

    // Editing q1 compares against the active run (before q1), so switching to `to` is a full handoff.
    expect(
      resolveComposerContextImplication(
        projection,
        { instanceId: to, model: "claude-opus-4-6" },
        [],
        { editingRunId: q1Id },
      ),
    ).toEqual({
      kind: "full_handoff",
      from: { instanceId: from, model: "gpt-5.4" },
      to: { instanceId: to, model: "claude-opus-4-6" },
    });
  });
});

describe("model switch change", () => {
  const selection = (model: string, options?: Record<string, string>) => ({
    instanceId: from,
    model,
    ...(options === undefined
      ? {}
      : { options: Object.entries(options).map(([id, value]) => ({ id, value })) }),
  });
  const providers = [
    {
      instanceId: from,
      models: ["gpt", "mini"].map((slug) => ({
        slug,
        capabilities: {
          optionDescriptors: [
            { id: "serviceTier", type: "select", options: [{ id: "fast", label: "Fast" }] },
            {
              id: "thought_level",
              type: "select",
              role: "reasoning",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      })),
    },
  ] as unknown as ServerProvider[];

  it("shows only what changed, reading an unset effort as the default", () => {
    expect(
      resolveModelSwitchChange(
        { from: selection("gpt"), to: selection("gpt", { thought_level: "high" }) },
        providers,
      ),
    ).toEqual({ modelChanged: false, effort: { from: "Medium", to: "High" } });
    expect(
      resolveModelSwitchChange({ from: selection("gpt"), to: selection("mini") }, providers),
    ).toEqual({ modelChanged: true, effort: null });
  });

  it("ignores changes the user cannot see", () => {
    expect(
      resolveModelSwitchChange(
        { from: selection("gpt"), to: selection("gpt", { thought_level: "medium" }) },
        providers,
      ),
    ).toBeNull();
    expect(
      resolveModelSwitchChange(
        { from: selection("gpt"), to: selection("gpt", { serviceTier: "fast" }) },
        providers,
      ),
    ).toBeNull();
    // A cataloged model without an effort control ignores stale effort options.
    expect(
      resolveModelSwitchChange(
        {
          from: selection("plain", { reasoningEffort: "low" }),
          to: selection("plain", { reasoningEffort: "high" }),
        },
        [{ instanceId: from, models: [{ slug: "plain" }] }] as unknown as ServerProvider[],
      ),
    ).toBeNull();
  });

  it("falls back to stated efforts without a catalog", () => {
    expect(
      resolveModelSwitchChange(
        {
          from: selection("gpt", { reasoningEffort: "low" }),
          to: selection("gpt", { reasoningEffort: "high" }),
        },
        [],
      ),
    ).toEqual({ modelChanged: false, effort: { from: "low", to: "high" } });
    expect(
      resolveModelSwitchChange(
        {
          from: selection("pi", { thinking: "low" }),
          to: selection("pi", { thinking: "high" }),
        },
        [],
      ),
    ).toEqual({ modelChanged: false, effort: { from: "low", to: "high" } });
    expect(
      resolveModelSwitchChange(
        { from: selection("gpt"), to: selection("gpt", { reasoningEffort: "high" }) },
        [],
      ),
    ).toBeNull();
  });
});
