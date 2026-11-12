import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:follow-on");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const makeLayerTest = () => {
  const layerDatabase = SqlitePersistence.layerMemory;
  return ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "follow-on-queue" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
};

const createThread = (threadId: ThreadId, startAfterThreadId?: ThreadId | null) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: `Thread ${threadId}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      ...(startAfterThreadId === undefined ? {} : { startAfterThreadId }),
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (
  threadId: ThreadId,
  text: string,
  dispatchMode:
    | { readonly type: "start_immediately" }
    | { readonly type: "queue_after_active" }
    | { readonly type: "defer_start"; readonly workspaceStrategy: { readonly type: "root" } } = {
    type: "start_immediately",
  },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode,
      createdBy: "user",
      creationSource: "web",
    });
  });

const completeActiveRun = (
  threadId: ThreadId,
  status: "completed" | "failed" | "interrupted" = "completed",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const activeRun = projection.runs.find(
      (run) => run.status === "starting" || run.status === "running" || run.status === "waiting",
    );
    assert.isDefined(activeRun);
    const now = yield* DateTime.now;
    yield* eventSink.writeWithEffects({
      events: [
        {
          id: EventId.make(`event:complete:${threadId}:${activeRun!.id}`),
          type: "run.updated",
          threadId,
          runId: activeRun!.id,
          providerInstanceId: activeRun!.providerInstanceId,
          occurredAt: now,
          payload: {
            ...activeRun!,
            status,
            completedAt: now,
          },
        } satisfies OrchestrationV2DomainEvent,
      ],
      effects: [],
    });
    // Wait for the event stream fiber in Orchestrator to process the terminal run update
    for (let attempt = 0; attempt < 20; attempt += 1) {
      yield* Effect.yieldNow;
    }
  });

it.effect(
  "inserts a follow-on thread after a working thread, splices existing followers, and releases on finish",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadA = ThreadId.make("thread:A");
      const threadB = ThreadId.make("thread:B");
      const threadC = ThreadId.make("thread:C");

      yield* createThread(threadA);
      yield* send(threadA, "work A");

      // Create B following A via defer_start + prepared-run.release (like ThreadLaunchService)
      yield* createThread(threadB, threadA);
      yield* send(threadB, "work B", {
        type: "defer_start",
        workspaceStrategy: { type: "root" },
      });
      const projBPreparing = yield* orchestrator.getThreadProjection(threadB);
      assert.equal(projBPreparing.thread.startAfterThreadId, threadA);
      assert.equal(projBPreparing.runs[0]?.status, "preparing");

      yield* orchestrator.dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make("release:B"),
        threadId: threadB,
        runId: projBPreparing.runs[0]!.id,
      });
      const projBQueued = yield* orchestrator.getThreadProjection(threadB);
      assert.equal(projBQueued.runs[0]?.status, "queued");
      assert.equal(projBQueued.runs[0]?.queueHeld, true);

      // Now right-click A again and create C following A: C is injected between A and B (A -> C -> B)
      yield* createThread(threadC, threadA);
      yield* send(threadC, "work C");

      const projCAfterInsert = yield* orchestrator.getThreadProjection(threadC);
      const projBAfterInsert = yield* orchestrator.getThreadProjection(threadB);
      assert.equal(projCAfterInsert.thread.startAfterThreadId, threadA);
      assert.equal(projCAfterInsert.runs[0]?.status, "queued");
      assert.equal(projCAfterInsert.runs[0]?.queueHeld, true);
      assert.equal(projBAfterInsert.thread.startAfterThreadId, threadC);

      // When A finishes, C's trigger clears and C starts; B still waits on C
      yield* completeActiveRun(threadA, "completed");

      const projCAfterA = yield* orchestrator.getThreadProjection(threadC);
      const projBAfterA = yield* orchestrator.getThreadProjection(threadB);
      assert.isNull(projCAfterA.thread.startAfterThreadId ?? null);
      assert.equal(projCAfterA.runs[0]?.status, "starting");
      assert.equal(projBAfterA.thread.startAfterThreadId, threadC);
      assert.equal(projBAfterA.runs[0]?.status, "queued");

      // When C finishes (even on failure), B's trigger clears and B starts
      yield* completeActiveRun(threadC, "failed");

      const projBAfterC = yield* orchestrator.getThreadProjection(threadB);
      assert.isNull(projBAfterC.thread.startAfterThreadId ?? null);
      assert.equal(projBAfterC.runs[0]?.status, "starting");
    }).pipe(Effect.provide(makeLayerTest())),
);

it.effect("starts immediately when the target prior thread is already idle", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadA = ThreadId.make("thread:idle-A");
    const threadB = ThreadId.make("thread:idle-B");

    yield* createThread(threadA);
    // threadA has no active or queued runs -> already idle
    yield* createThread(threadB, threadA);
    yield* send(threadB, "work B");

    const projB = yield* orchestrator.getThreadProjection(threadB);
    assert.isNull(projB.thread.startAfterThreadId ?? null);
    assert.equal(projB.runs[0]?.status, "starting");
  }).pipe(Effect.provide(makeLayerTest())),
);

it.effect("reorders threads in a queue, rejects cycles, and supports clearing the trigger", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadA = ThreadId.make("thread:reorder-A");
    const threadB = ThreadId.make("thread:reorder-B");
    const threadC = ThreadId.make("thread:reorder-C");

    yield* createThread(threadA);
    yield* send(threadA, "work A");

    yield* createThread(threadB, threadA);
    yield* send(threadB, "work B");

    yield* createThread(threadC, threadB);
    yield* send(threadC, "work C");

    // Chain is A -> B -> C. Reject cycle if B tries to start after C.
    const cycleExit = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.start-after.reorder",
        commandId: CommandId.make("reorder:cycle"),
        threadId: threadB,
        startAfterThreadId: threadC,
      }),
    );
    assert.isTrue(Exit.isFailure(cycleExit));

    // Reject moving running head A behind B
    const moveRunningExit = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.start-after.reorder",
        commandId: CommandId.make("reorder:running"),
        threadId: threadA,
        startAfterThreadId: threadB,
      }),
    );
    assert.isTrue(Exit.isFailure(moveRunningExit));

    // Reorder C to be directly after A: chain becomes A -> C -> B
    yield* orchestrator.dispatch({
      type: "thread.start-after.reorder",
      commandId: CommandId.make("reorder:C-after-A"),
      threadId: threadC,
      startAfterThreadId: threadA,
    });

    const projB = yield* orchestrator.getThreadProjection(threadB);
    const projC = yield* orchestrator.getThreadProjection(threadC);
    assert.equal(projC.thread.startAfterThreadId, threadA);
    assert.equal(projB.thread.startAfterThreadId, threadC);

    // Clear C's trigger: C starts immediately and B re-links to C's old predecessor A
    yield* orchestrator.dispatch({
      type: "thread.start-after.clear",
      commandId: CommandId.make("clear:C"),
      threadId: threadC,
    });

    const projBAfterClear = yield* orchestrator.getThreadProjection(threadB);
    const projCAfterClear = yield* orchestrator.getThreadProjection(threadC);
    assert.isNull(projCAfterClear.thread.startAfterThreadId ?? null);
    assert.equal(projCAfterClear.runs[0]?.status, "starting");
    assert.equal(projBAfterClear.thread.startAfterThreadId, threadA);
  }).pipe(Effect.provide(makeLayerTest())),
);

it.effect(
  "re-links followers when a middle thread is deleted and releases when head is deleted",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadA = ThreadId.make("thread:del-A");
      const threadB = ThreadId.make("thread:del-B");
      const threadC = ThreadId.make("thread:del-C");

      yield* createThread(threadA);
      yield* send(threadA, "work A");

      yield* createThread(threadB, threadA);
      yield* send(threadB, "work B");

      yield* createThread(threadC, threadB);
      yield* send(threadC, "work C");

      // Delete middle thread B -> C re-links to A
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete:B"),
        threadId: threadB,
      });

      const projCAfterDeleteB = yield* orchestrator.getThreadProjection(threadC);
      assert.equal(projCAfterDeleteB.thread.startAfterThreadId, threadA);
      assert.equal(projCAfterDeleteB.runs[0]?.status, "queued");

      // Delete head thread A -> C is released and starts
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete:A"),
        threadId: threadA,
      });

      const projCAfterDeleteA = yield* orchestrator.getThreadProjection(threadC);
      assert.isNull(projCAfterDeleteA.thread.startAfterThreadId ?? null);
      assert.equal(projCAfterDeleteA.runs[0]?.status, "starting");
    }).pipe(Effect.provide(makeLayerTest())),
);
