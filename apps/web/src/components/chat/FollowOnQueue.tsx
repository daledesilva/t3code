import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CircleDashedIcon, CircleDotDashedIcon, GripVerticalIcon } from "lucide-react";
import { useRef } from "react";

import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type FollowOnQueueItem, planFollowOnQueueReorder } from "./followOnQueue.logic";
import { threadContextDropTargetProps, useThreadContextDrop } from "./threadContextDrag";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function QueueDropSlot({
  environmentId,
  slotKey,
  label,
  empty = false,
  onDropThreads,
}: {
  readonly environmentId: EnvironmentId;
  readonly slotKey: string;
  readonly label?: string | undefined;
  readonly empty?: boolean | undefined;
  readonly onDropThreads: (refs: ReadonlyArray<ScopedThreadRef>) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useThreadContextDrop(ref, environmentId, slotKey, (refs) => {
    onDropThreads(refs);
  });

  if (empty) {
    return (
      <div
        ref={ref}
        {...threadContextDropTargetProps()}
        data-testid="follow-on-queue-empty-dropzone"
        className="flex items-center justify-center rounded-lg border border-dashed border-border/80 bg-card/50 px-3 py-2.5 text-xs text-muted-foreground transition-colors data-[thread-context-over=true]:border-primary data-[thread-context-over=true]:bg-primary/8 data-[thread-context-over=true]:text-foreground"
      >
        {label ?? "Drop here to complete prior"}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      {...threadContextDropTargetProps()}
      data-testid={`follow-on-queue-drop-slot-${slotKey}`}
      className="group/drop-slot relative flex h-3 items-center justify-center transition-all data-[thread-context-over=true]:h-6"
    >
      <div className="h-0.5 w-full rounded-full bg-border/50 transition-colors group-data-[thread-context-over=true]/drop-slot:h-1 group-data-[thread-context-over=true]/drop-slot:bg-primary" />
    </div>
  );
}

function SortableQueueItemRow({
  item,
  canReorder,
  onRemove,
}: {
  readonly item: FollowOnQueueItem;
  readonly canReorder: boolean;
  readonly onRemove?: ((threadId: ThreadId) => void) | undefined;
}) {
  const disabled = !canReorder || item.isRunning;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`follow-on-queue-item-${item.id}`}
      data-running={item.isRunning ? "true" : "false"}
      className={cn(
        "group/queue-item flex items-center gap-2 rounded-md border border-border/60 bg-card/75 px-2.5 text-xs transition-colors hover:bg-accent/50",
        onRemove ? "py-1" : "py-1.5",
        isDragging && "relative z-10 bg-background shadow-md",
      )}
    >
      {canReorder ? (
        <button
          type="button"
          aria-label={`Reorder ${item.title}`}
          disabled={disabled}
          className={cn(
            "inline-flex shrink-0 items-center text-muted-foreground/60 outline-none",
            disabled
              ? "cursor-default opacity-30"
              : "cursor-grab hover:text-foreground active:cursor-grabbing",
          )}
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}

      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(item.environmentId, item.id))}
        className="min-w-0 flex-1 truncate font-medium text-foreground hover:underline"
      >
        {item.title}
      </Link>

      {item.isRunning ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-info-foreground">
          <CircleDashedIcon aria-hidden className="size-3 shrink-0" />
          Working
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          <CircleDotDashedIcon aria-hidden className="size-3 shrink-0" />
          Waiting
        </span>
      )}

      {onRemove ? (
        <Button
          size="micro"
          variant="ghost-muted"
          aria-label={`Remove ${item.title} from the queue`}
          onClick={() => onRemove(item.id)}
        >
          Remove
        </Button>
      ) : null}
    </li>
  );
}

export function FollowOnQueueSection({
  section,
  environmentId,
  beforeQueue,
  afterQueue,
  isSidebarDragging = false,
  canOperate = true,
  newThread = false,
  onRemoveItem,
  onReorderQueue,
  onDropSidebarThread,
}: {
  readonly section: "before" | "after";
  readonly environmentId: EnvironmentId;
  readonly beforeQueue: ReadonlyArray<FollowOnQueueItem>;
  readonly afterQueue: ReadonlyArray<FollowOnQueueItem>;
  readonly isSidebarDragging?: boolean | undefined;
  readonly canOperate?: boolean | undefined;
  /** The viewed thread is an unsent draft, which changes how the queue tooltips read. */
  readonly newThread?: boolean | undefined;
  readonly onRemoveItem?: ((threadId: ThreadId) => void) | undefined;
  readonly onReorderQueue: (input: {
    readonly movedThreadId: ThreadId;
    readonly targetList: "before" | "after";
    readonly targetIndex: number;
  }) => void;
  readonly onDropSidebarThread?:
    | ((refs: ReadonlyArray<ScopedThreadRef>, insertIndex: number) => void)
    | undefined;
}) {
  const items = section === "before" ? beforeQueue : afterQueue;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (section === "before" && items.length === 0 && !isSidebarDragging) {
    return null;
  }
  if (section === "after" && items.length === 0) {
    return null;
  }

  const subject = newThread ? "your new thread" : "this thread";
  const title = section === "before" ? "Follow on from" : "Follow up with";
  const hint =
    section === "before"
      ? `${capitalize(subject)} will start after these threads complete.`
      : `These threads will start after ${subject} completes.`;
  const removeItem = canOperate ? onRemoveItem : undefined;
  const itemIds = items.map((item) => item.id);
  const canReorder =
    canOperate &&
    beforeQueue.length + afterQueue.length > 1 &&
    items.some((item) => !item.isRunning);

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const activeId = String(event.active.id) as ThreadId;
    const overId = String(event.over.id) as ThreadId;
    const targetIndex = items.findIndex((item) => item.id === overId);
    if (targetIndex === -1) return;
    const plan = planFollowOnQueueReorder({
      beforeQueue,
      afterQueue,
      movedThreadId: activeId,
      targetList: section,
      targetIndex,
    });
    if (!plan) return;
    onReorderQueue({
      movedThreadId: activeId,
      targetList: section,
      targetIndex,
    });
  };

  return (
    <div
      data-testid={`follow-on-queue-${section}`}
      className="pointer-events-auto mx-auto w-full max-w-md"
    >
      <div className="mb-1.5 flex items-center gap-2 px-0.5">
        <Tooltip>
          <TooltipTrigger
            render={<span className="cursor-default text-xs font-medium text-muted-foreground" />}
          >
            {title}
          </TooltipTrigger>
          <TooltipPopup side="top">{hint}</TooltipPopup>
        </Tooltip>
      </div>

      {section === "before" && items.length === 0 ? (
        <QueueDropSlot
          environmentId={environmentId}
          slotKey="empty-0"
          label="Drop here to complete prior"
          empty
          onDropThreads={(refs) => onDropSidebarThread?.(refs, 0)}
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            {section === "before" && isSidebarDragging && onDropSidebarThread ? (
              <QueueDropSlot
                environmentId={environmentId}
                slotKey="before-0"
                onDropThreads={(refs) => onDropSidebarThread(refs, 0)}
              />
            ) : null}
            <ol aria-label={title} className="flex flex-col gap-1">
              {items.map((item, index) => (
                <div key={item.id} className="flex flex-col gap-1">
                  <SortableQueueItemRow item={item} canReorder={canReorder} onRemove={removeItem} />
                  {section === "before" && isSidebarDragging && onDropSidebarThread ? (
                    <QueueDropSlot
                      environmentId={environmentId}
                      slotKey={`before-${index + 1}`}
                      onDropThreads={(refs) => onDropSidebarThread(refs, index + 1)}
                    />
                  ) : null}
                </div>
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
