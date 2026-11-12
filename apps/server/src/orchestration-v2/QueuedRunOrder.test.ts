import { describe, expect, it } from "vite-plus/test";

import { queuedRunsInDeliveryOrder, userQueuePositionsBehindFirst } from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
    ]);
    expect(userQueuePositionsBehindFirst(projection)).toEqual([
      expect.objectContaining({
        queuePosition: 2,
        run: expect.objectContaining({ id: "run:visible-first" }),
      }),
      expect.objectContaining({
        queuePosition: 3,
        run: expect.objectContaining({ id: "run:visible-second" }),
      }),
    ]);
  });
});
