import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

export type FollowOnQueueThreadInput = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "title"
  | "branch"
  | "createdAt"
  | "deletedAt"
  | "archivedAt"
  | "startAfterThreadId"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
>;

export interface FollowOnQueueItem {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly branch: string | null;
  readonly isRunning: boolean;
  readonly status: SidebarThreadStatus;
  readonly startAfterThreadId: ThreadId | null;
}

export interface FollowOnQueueLists {
  readonly beforeQueue: ReadonlyArray<FollowOnQueueItem>;
  readonly afterQueue: ReadonlyArray<FollowOnQueueItem>;
}

export interface FollowOnQueueServerUpdate {
  readonly threadId: ThreadId;
  readonly startAfterThreadId: ThreadId | null;
  readonly kind: "set" | "reorder" | "clear";
}

export interface FollowOnQueuePlan {
  readonly nextPriorThreadId: ThreadId | null;
  readonly serverUpdates: ReadonlyArray<FollowOnQueueServerUpdate>;
}

export function isSidebarThreadEligibleForFollowOnQueue(thread: FollowOnQueueThreadInput): boolean {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return false;
  const status = resolveSidebarThreadStatus(thread);
  const runtimeBusy =
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting", "idle"].includes(
      thread.runtime.status,
    );
  return (
    runtimeBusy ||
    status === "working" ||
    status === "preparing" ||
    status === "waiting" ||
    thread.startAfterThreadId !== null
  );
}

export function toFollowOnQueueItem(thread: FollowOnQueueThreadInput): FollowOnQueueItem {
  const status = resolveSidebarThreadStatus(thread);
  return {
    id: thread.id,
    environmentId: thread.environmentId,
    title: thread.title.trim() || "Untitled thread",
    branch: thread.branch ?? null,
    isRunning: status === "working" || status === "preparing",
    status,
    startAfterThreadId: thread.startAfterThreadId ?? null,
  };
}

export function buildFollowOnQueueLists(input: {
  readonly threads: ReadonlyArray<FollowOnQueueThreadInput>;
  readonly priorThreadId: ThreadId | null;
  readonly currentThreadId?: ThreadId | null | undefined;
}): FollowOnQueueLists {
  const { threads, priorThreadId, currentThreadId = null } = input;
  if (priorThreadId === null) {
    return { beforeQueue: [], afterQueue: [] };
  }

  const activeThreads = threads.filter(
    (thread) => thread.deletedAt === null && thread.archivedAt === null,
  );
  const byId = new Map(activeThreads.map((thread) => [thread.id, thread]));
  const priorThread = byId.get(priorThreadId);
  if (!priorThread) {
    return { beforeQueue: [], afterQueue: [] };
  }

  const visited = new Set<ThreadId>();
  if (currentThreadId !== null) {
    visited.add(currentThreadId);
  }

  const beforeChainReversed: FollowOnQueueItem[] = [];
  let cursor: FollowOnQueueThreadInput | undefined = priorThread;
  while (cursor !== undefined && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    beforeChainReversed.push(toFollowOnQueueItem(cursor));
    cursor = cursor.startAfterThreadId !== null ? byId.get(cursor.startAfterThreadId) : undefined;
  }
  const beforeQueue = beforeChainReversed.reverse();

  const followersByPredecessor = new Map<ThreadId, FollowOnQueueThreadInput[]>();
  for (const thread of activeThreads) {
    if (thread.startAfterThreadId === null || thread.id === currentThreadId) continue;
    const list = followersByPredecessor.get(thread.startAfterThreadId) ?? [];
    list.push(thread);
    followersByPredecessor.set(thread.startAfterThreadId, list);
  }
  for (const list of followersByPredecessor.values()) {
    list.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }

  const afterQueue: FollowOnQueueItem[] = [];
  const queueSeeds: ThreadId[] = [
    priorThreadId,
    ...(currentThreadId !== null ? [currentThreadId] : []),
  ];
  while (queueSeeds.length > 0) {
    const nextParentId = queueSeeds.shift()!;
    const followers = followersByPredecessor.get(nextParentId) ?? [];
    for (const follower of followers) {
      if (visited.has(follower.id)) continue;
      visited.add(follower.id);
      afterQueue.push(toFollowOnQueueItem(follower));
      queueSeeds.push(follower.id);
    }
  }

  return { beforeQueue, afterQueue };
}

function computeServerChainUpdates(
  previousItems: ReadonlyArray<FollowOnQueueItem>,
  nextServerChain: ReadonlyArray<FollowOnQueueItem>,
): ReadonlyArray<FollowOnQueueServerUpdate> {
  const prevById = new Map(previousItems.map((item) => [item.id, item]));
  const updates: FollowOnQueueServerUpdate[] = [];

  for (let index = 0; index < nextServerChain.length; index += 1) {
    const item = nextServerChain[index]!;
    const desiredStartAfterId = index === 0 ? null : nextServerChain[index - 1]!.id;
    const previousStartAfterId =
      prevById.get(item.id)?.startAfterThreadId ?? item.startAfterThreadId;

    if (desiredStartAfterId === previousStartAfterId) continue;
    if (desiredStartAfterId === null) {
      updates.push({
        threadId: item.id,
        startAfterThreadId: null,
        kind: "clear",
      });
    } else if (previousStartAfterId !== null) {
      updates.push({
        threadId: item.id,
        startAfterThreadId: desiredStartAfterId,
        kind: "reorder",
      });
    } else {
      updates.push({
        threadId: item.id,
        startAfterThreadId: desiredStartAfterId,
        kind: "set",
      });
    }
  }

  return updates;
}

/**
 * Reorders an item within or across `beforeQueue` and `afterQueue`.
 * The running head (when `beforeQueue[0]?.isRunning` is true) stays at index 0.
 */
export function planFollowOnQueueReorder(input: {
  readonly beforeQueue: ReadonlyArray<FollowOnQueueItem>;
  readonly afterQueue: ReadonlyArray<FollowOnQueueItem>;
  readonly movedThreadId: ThreadId;
  readonly targetList: "before" | "after";
  readonly targetIndex: number;
}): FollowOnQueuePlan | null {
  const { beforeQueue, afterQueue, movedThreadId, targetList, targetIndex } = input;
  const allItems = [...beforeQueue, ...afterQueue];
  const movedItem = allItems.find((item) => item.id === movedThreadId);
  if (!movedItem) return null;

  const runningHead = beforeQueue[0]?.isRunning === true ? beforeQueue[0] : null;
  if (runningHead !== null && movedItem.id === runningHead.id) {
    // The running thread is already executing and must remain at the head of the queue.
    return null;
  }

  const nextBefore = beforeQueue.filter((item) => item.id !== movedThreadId);
  const nextAfter = afterQueue.filter((item) => item.id !== movedThreadId);

  if (targetList === "before") {
    const minIndex = runningHead !== null && nextBefore[0]?.id === runningHead.id ? 1 : 0;
    const clampedIndex = Math.max(minIndex, Math.min(targetIndex, nextBefore.length));
    nextBefore.splice(clampedIndex, 0, movedItem);
  } else {
    const clampedIndex = Math.max(0, Math.min(targetIndex, nextAfter.length));
    nextAfter.splice(clampedIndex, 0, movedItem);
  }

  if (nextBefore.length === 0) {
    return null;
  }

  const nextPriorThreadId = nextBefore.at(-1)?.id ?? null;
  const nextServerChain = [...nextBefore, ...nextAfter];
  const serverUpdates = computeServerChainUpdates(allItems, nextServerChain);

  return {
    nextPriorThreadId,
    serverUpdates,
  };
}

/**
 * Plans the effect of dropping a sidebar thread into `beforeQueue` at `insertIndex`
 * (`0` = above the first item, `beforeQueue.length` = below the last item / onto empty dropzone).
 */
export function planSidebarDropIntoFollowOnQueue(input: {
  readonly beforeQueue: ReadonlyArray<FollowOnQueueItem>;
  readonly afterQueue: ReadonlyArray<FollowOnQueueItem>;
  readonly droppedThread: FollowOnQueueItem;
  readonly insertIndex: number;
}): FollowOnQueuePlan {
  const { beforeQueue, afterQueue, droppedThread, insertIndex } = input;

  if (beforeQueue.length === 0) {
    return {
      nextPriorThreadId: droppedThread.id,
      serverUpdates: [],
    };
  }

  const allItems = [...beforeQueue, ...afterQueue];
  const existingInQueue = allItems.some((item) => item.id === droppedThread.id);
  if (existingInQueue) {
    const existingBeforeIndex = beforeQueue.findIndex((item) => item.id === droppedThread.id);
    const adjustedIndex =
      existingBeforeIndex !== -1 && existingBeforeIndex < insertIndex
        ? insertIndex - 1
        : insertIndex;
    const reordered = planFollowOnQueueReorder({
      beforeQueue,
      afterQueue,
      movedThreadId: droppedThread.id,
      targetList: "before",
      targetIndex: adjustedIndex,
    });
    if (reordered !== null) return reordered;
    return {
      nextPriorThreadId: droppedThread.id,
      serverUpdates: [],
    };
  }

  const runningHead = beforeQueue[0]?.isRunning === true ? beforeQueue[0] : null;
  if (droppedThread.isRunning) {
    if (runningHead === null && insertIndex === 0) {
      const nextBefore = [droppedThread, ...beforeQueue];
      const nextServerChain = [...nextBefore, ...afterQueue];
      return {
        nextPriorThreadId: nextBefore.at(-1)?.id ?? droppedThread.id,
        serverUpdates: computeServerChainUpdates([droppedThread, ...allItems], nextServerChain),
      };
    }
    return {
      nextPriorThreadId: droppedThread.id,
      serverUpdates: [],
    };
  }

  const nextBefore = [...beforeQueue];
  const minIndex = runningHead !== null ? 1 : 0;
  const clampedIndex = Math.max(minIndex, Math.min(insertIndex, nextBefore.length));
  nextBefore.splice(clampedIndex, 0, droppedThread);
  const nextServerChain = [...nextBefore, ...afterQueue];

  return {
    nextPriorThreadId: nextBefore.at(-1)?.id ?? droppedThread.id,
    serverUpdates: computeServerChainUpdates([...allItems, droppedThread], nextServerChain),
  };
}
