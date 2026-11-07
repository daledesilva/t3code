import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildFollowOnQueueLists,
  type FollowOnQueueThreadInput,
  planFollowOnQueueReorder,
  planSidebarDropIntoFollowOnQueue,
  toFollowOnQueueItem,
} from "./followOnQueue.logic";

const environmentId = EnvironmentId.make("environment-local");

function makeQueueThread(
  overrides: Partial<FollowOnQueueThreadInput> & { id: string },
): FollowOnQueueThreadInput {
  return {
    environmentId,
    title: overrides.title ?? `Thread ${overrides.id}`,
    branch: "main",
    createdAt: "2026-03-09T10:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
    startAfterThreadId: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    blockedOnThreadWait: false,
    runtime: {
      status: "idle",
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeRunId: null,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
    ...overrides,
    id: ThreadId.make(overrides.id),
  };
}

describe("buildFollowOnQueueLists", () => {
  it("splits the queue into beforeQueue (up to prior) and afterQueue (followers after prior)", () => {
    const threadA = makeQueueThread({
      id: "thread-a",
      title: "Thread A",
      createdAt: "2026-03-09T10:00:00.000Z",
      runtime: {
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        activeRunId: "run-a" as never,
        lastError: null,
        updatedAt: "2026-03-09T10:00:00.000Z",
      },
    });
    const threadB = makeQueueThread({
      id: "thread-b",
      title: "Thread B",
      createdAt: "2026-03-09T10:01:00.000Z",
      startAfterThreadId: threadA.id,
    });
    const threadC = makeQueueThread({
      id: "thread-c",
      title: "Thread C",
      createdAt: "2026-03-09T10:02:00.000Z",
      startAfterThreadId: threadB.id,
    });

    // Injecting a new draft after Thread A puts [A] in beforeQueue and [B, C] in afterQueue.
    const fromA = buildFollowOnQueueLists({
      threads: [threadA, threadB, threadC],
      priorThreadId: threadA.id,
    });
    expect(fromA.beforeQueue.map((item) => item.id)).toEqual([threadA.id]);
    expect(fromA.beforeQueue[0]?.isRunning).toBe(true);
    expect(fromA.afterQueue.map((item) => item.id)).toEqual([threadB.id, threadC.id]);
    expect(fromA.afterQueue.every((item) => !item.isRunning)).toBe(true);

    // Injecting a new draft after Thread B puts [A, B] in beforeQueue and [C] in afterQueue.
    const fromB = buildFollowOnQueueLists({
      threads: [threadA, threadB, threadC],
      priorThreadId: threadB.id,
    });
    expect(fromB.beforeQueue.map((item) => item.id)).toEqual([threadA.id, threadB.id]);
    expect(fromB.afterQueue.map((item) => item.id)).toEqual([threadC.id]);
  });

  it("excludes currentThreadId when building lists for an already-created waiting thread", () => {
    const threadA = makeQueueThread({
      id: "thread-a",
      runtime: {
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        activeRunId: "run-a" as never,
        lastError: null,
        updatedAt: "2026-03-09T10:00:00.000Z",
      },
    });
    const threadCurrent = makeQueueThread({
      id: "thread-current",
      startAfterThreadId: threadA.id,
    });
    const threadC = makeQueueThread({
      id: "thread-c",
      startAfterThreadId: threadCurrent.id,
    });

    const lists = buildFollowOnQueueLists({
      threads: [threadA, threadCurrent, threadC],
      priorThreadId: threadA.id,
      currentThreadId: threadCurrent.id,
    });
    expect(lists.beforeQueue.map((item) => item.id)).toEqual([threadA.id]);
    expect(lists.afterQueue.map((item) => item.id)).toEqual([threadC.id]);
  });
});

describe("planFollowOnQueueReorder", () => {
  const threadA = toFollowOnQueueItem(
    makeQueueThread({
      id: "thread-a",
      runtime: {
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        activeRunId: "run-a" as never,
        lastError: null,
        updatedAt: "2026-03-09T10:00:00.000Z",
      },
    }),
  );
  const threadB = toFollowOnQueueItem(
    makeQueueThread({
      id: "thread-b",
      startAfterThreadId: threadA.id,
    }),
  );
  const threadC = toFollowOnQueueItem(
    makeQueueThread({
      id: "thread-c",
      startAfterThreadId: threadB.id,
    }),
  );

  it("reorders waiting threads within beforeQueue and keeps the running head first", () => {
    const plan = planFollowOnQueueReorder({
      beforeQueue: [threadA, threadB, threadC],
      afterQueue: [],
      movedThreadId: threadC.id,
      targetList: "before",
      targetIndex: 0,
    });

    expect(plan).toEqual({
      nextPriorThreadId: threadB.id,
      serverUpdates: [
        { threadId: threadC.id, startAfterThreadId: threadA.id, kind: "reorder" },
        { threadId: threadB.id, startAfterThreadId: threadC.id, kind: "reorder" },
      ],
    });
  });

  it("moves a thread between beforeQueue and afterQueue to reposition the draft", () => {
    const plan = planFollowOnQueueReorder({
      beforeQueue: [threadA, threadB],
      afterQueue: [threadC],
      movedThreadId: threadB.id,
      targetList: "after",
      targetIndex: 0,
    });

    expect(plan).toEqual({
      nextPriorThreadId: threadA.id,
      serverUpdates: [],
    });
  });

  it("does not allow moving the running head", () => {
    expect(
      planFollowOnQueueReorder({
        beforeQueue: [threadA, threadB],
        afterQueue: [],
        movedThreadId: threadA.id,
        targetList: "before",
        targetIndex: 1,
      }),
    ).toBeNull();
  });
});

describe("planSidebarDropIntoFollowOnQueue", () => {
  const threadA = toFollowOnQueueItem(
    makeQueueThread({
      id: "thread-a",
      runtime: {
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        activeRunId: "run-a" as never,
        lastError: null,
        updatedAt: "2026-03-09T10:00:00.000Z",
      },
    }),
  );
  const threadB = toFollowOnQueueItem(
    makeQueueThread({
      id: "thread-b",
      startAfterThreadId: threadA.id,
    }),
  );
  const threadD = toFollowOnQueueItem(
    makeQueueThread({
      id: "thread-d",
      startAfterThreadId: null,
    }),
  );

  it("sets nextPriorThreadId when dropping onto an empty queue", () => {
    expect(
      planSidebarDropIntoFollowOnQueue({
        beforeQueue: [],
        afterQueue: [],
        droppedThread: threadA,
        insertIndex: 0,
      }),
    ).toEqual({
      nextPriorThreadId: threadA.id,
      serverUpdates: [],
    });
  });

  it("inserts a waiting thread between existing queue items", () => {
    const plan = planSidebarDropIntoFollowOnQueue({
      beforeQueue: [threadA, threadB],
      afterQueue: [],
      droppedThread: threadD,
      insertIndex: 1,
    });

    expect(plan).toEqual({
      nextPriorThreadId: threadB.id,
      serverUpdates: [
        { threadId: threadD.id, startAfterThreadId: threadA.id, kind: "set" },
        { threadId: threadB.id, startAfterThreadId: threadD.id, kind: "reorder" },
      ],
    });
  });
});
