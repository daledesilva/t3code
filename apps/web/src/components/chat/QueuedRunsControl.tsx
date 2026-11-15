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
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  Clock3Icon,
  GripVerticalIcon,
  MessagesSquareIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { Link as LinkIconNode } from "lucide";
import * as DateTime from "effect/DateTime";
import { useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useQuietThreadShell, useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { GuestMessageName } from "./guestMessageStyle";
import { MessageCopyButton } from "./MessageCopyButton";
import { promptLinkFor } from "../promptLinks/copyPromptLink";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { FoldedMessageHeader, useScheduledTaskTitle } from "./TimelineUserMessageRow";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

interface QueuedRowThumbnail {
  readonly key: string;
  readonly name: string;
  readonly url: string | null;
}

// A longer queue shows its first messages and a button that shows the rest.
const QUEUE_VISIBLE_ROWS = 3;

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

type ThreadQueueProjection = Parameters<typeof deriveThreadQueueWorkflowState>[0];

function queuedImageResources(projection: ThreadQueueProjection | undefined) {
  if (!projection) return [];
  return deriveThreadQueueWorkflowState(projection).queuedRuns.flatMap(({ attachments }) =>
    attachments.flatMap((attachment) =>
      attachment.type === "image"
        ? [{ _tag: "attachment" as const, attachmentId: attachment.id }]
        : [],
    ),
  );
}

export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  readonly editingRunId: RunId | null;
  /** Set while something else holds the composer, such as an open question. */
  readonly editBlockedReason: string | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const merge = useAtomCommand(threadEnvironment.mergeQueuedRuns);
  const sensors = useSensors(
    // A tap edits. A hold starts the reorder, with room for a finger to settle.
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [showAll, setShowAll] = useState(false);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const steerInFlightRef = useRef(false);
  // Run-only acknowledgements can resurrect pending rows after cancellation or startup.
  const acknowledgedMessageIds = new Set((projection?.messages ?? []).map((message) => message.id));
  const queuedImageAttachmentResources = queuedImageResources(projection);
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const workflow = projection ? deriveThreadQueueWorkflowState(projection) : null;
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  // A fresh message starts its own turn: it may skip compaction, but not steer into a turn.
  const canSendRun = (freshContext: boolean) =>
    workflow?.canSendNow === true ||
    (workflow?.canPromoteToSteer === true &&
      (!freshContext || workflow.promoteSkipsCompaction === true));
  const queuedImageUrlById = new Map(
    queuedImageAttachmentUrls.flatMap((url, index) => {
      const resource = queuedImageAttachmentResources[index];
      return url && resource ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const items = [
    ...queued.map(({ run, text, attachments, context, message }, serverIndex) => ({
      key: run.id,
      message,
      runId: run.id,
      messageId: run.userMessageId,
      freshContext: run.freshContext === true,
      serverIndex,
      text,
      // A guest's message keeps the guest's words; the owner can cancel it, not rewrite it.
      editable: context?.guest === undefined,
      attachments,
      thumbnails: attachments
        .filter((attachment) => attachment.type === "image")
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: queuedImageUrlById.get(attachment.id) ?? null,
        })),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      message: undefined,
      runId: null,
      messageId: null,
      freshContext: false,
      serverIndex: null,
      text: message.text,
      editable: true,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? [])
        .filter(isImageAttachment)
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: attachment.previewUrl ?? null,
        })),
      pending: true,
    })),
  ];

  const sendQueuedMessage = async (queuedRunId: RunId) => {
    const freshContext = queued.some(
      ({ run }) => run.id === queuedRunId && run.freshContext === true,
    );
    if (!canSendRun(freshContext) || steerInFlightRef.current) return;
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    if (workflow?.canSendNow) {
      await resume({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId: queuedRunId },
      });
    } else if (activeRun !== null) {
      await promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
      });
    }
    steerInFlightRef.current = false;
    setBusyRunId(null);
  };

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued[0];
      if (!next || !canSendRun(next.run.freshContext === true)) return false;
      if (!repeat && busyRunId === null) void sendQueuedMessage(next.run.id);
      return true;
    },
    // Leave the key to caret navigation while editing.
    editLatest(repeat) {
      const latest = queued.at(-1);
      if (
        !latest ||
        latest.context?.guest !== undefined ||
        props.editingRunId !== null ||
        props.editBlockedReason !== null ||
        busyRunId !== null
      ) {
        return false;
      }
      if (!repeat) {
        setShowAll(true);
        props.onEditQueuedRun({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  if (items.length === 0) return null;

  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    await cancel({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId },
    });
    setBusyRunId(null);
  };

  const reorderQueuedMessage = async (runId: RunId, beforeRunId: RunId | null) => {
    setBusyRunId(runId);
    await reorder({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId, beforeRunId },
    });
    setBusyRunId(null);
  };

  const mergeQueuedMessages = async (targetRunId: RunId, sourceRunId: RunId) => {
    setBusyRunId(targetRunId);
    await merge({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, targetRunId, sourceRunId },
    });
    setBusyRunId(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id || busyRunId !== null) return;
    const activeId = String(event.active.id) as RunId;
    const overId = String(event.over.id) as RunId;
    const oldIndex = queued.findIndex(({ run }) => run.id === activeId);
    const newIndex = queued.findIndex(({ run }) => run.id === overId);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
    const reordered = arrayMove([...queued], oldIndex, newIndex);
    const beforeRunId = reordered[newIndex + 1]?.run.id ?? null;
    void reorderQueuedMessage(activeId, beforeRunId);
  };

  const collapsible = items.length > QUEUE_VISIBLE_ROWS;
  const visibleItems = collapsible && !showAll ? items.slice(0, QUEUE_VISIBLE_ROWS - 1) : items;
  const canReorder = queued.length > 1;
  const sortableIds = visibleItems.map((item) => item.key);

  return (
    <section
      aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
      data-thread-queue="true"
      // Anchors the sr-only live region; unanchored, it escapes the timeline scroller and makes the chat column scroll.
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {items.length} queued
      </span>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col items-end gap-3" id={queueListId}>
            {visibleItems.map((item, position) => {
              const previewText = isAttachmentOnlyBootstrapPrompt(item.text)
                ? ""
                : assistantCitationsToPlainText(
                    replaceComposerContextReferences(item.text, (reference) =>
                      reference.kind === "image" && item.thumbnails.length > 0
                        ? ""
                        : reference.label,
                    ),
                  ).trim();
              const isEditing = item.runId !== null && item.runId === props.editingRunId;
              const nextItem = visibleItems[position + 1];
              const canMergeWithNext =
                nextItem !== undefined &&
                item.runId !== null &&
                nextItem.runId !== null &&
                item.editable &&
                nextItem.editable;
              const sendNowControl =
                canSendRun(item.freshContext) && !isEditing ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex shrink-0" />}>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={item.runId === null || busyRunId !== null}
                        onClick={() => {
                          if (item.runId !== null) {
                            void sendQueuedMessage(item.runId);
                          }
                        }}
                      >
                        <ArrowUpIcon />
                        Send now
                      </Button>
                    </TooltipTrigger>
                    <TooltipPopup>
                      {`${workflow?.canSendNow ? "Start a turn with this message" : workflow?.promoteSkipsCompaction ? "Skip compaction and send this message" : "Send into the current turn"}${item.serverIndex === 0 && props.steerShortcutLabel ? ` (${props.steerShortcutLabel})` : ""}`}
                    </TooltipPopup>
                  </Tooltip>
                ) : null;
              const canEdit =
                !isEditing &&
                item.runId !== null &&
                item.messageId !== null &&
                item.editable &&
                busyRunId === null &&
                props.editBlockedReason === null;
              const editQueuedMessage = canEdit
                ? () => {
                    if (item.runId === null || item.messageId === null) return;
                    props.onEditQueuedRun({
                      runId: item.runId,
                      messageId: item.messageId,
                      text: item.text,
                      attachments: item.attachments,
                    });
                  }
                : null;
              const removeControl =
                item.runId === null ? null : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label="Remove queued message"
                          disabled={busyRunId !== null}
                          onClick={() => {
                            if (item.runId !== null) void remove(item.runId);
                          }}
                        />
                      }
                    >
                      <XIcon />
                    </TooltipTrigger>
                    <TooltipPopup>Remove from queue</TooltipPopup>
                  </Tooltip>
                );
              const mergeControl = canMergeWithNext ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex shrink-0" />}>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={
                        busyRunId !== null ||
                        props.editingRunId === item.runId ||
                        props.editingRunId === nextItem.runId
                      }
                      onClick={() => {
                        if (item.runId !== null && nextItem.runId !== null) {
                          void mergeQueuedMessages(item.runId, nextItem.runId);
                        }
                      }}
                    >
                      <MergeQueuedMessagesIcon />
                      Merge
                    </Button>
                  </TooltipTrigger>
                  <TooltipPopup>Merge with next queued message</TooltipPopup>
                </Tooltip>
              ) : null;
              return (
                <SortableQueuedMessageItem
                  key={item.key}
                  id={item.key}
                  position={position}
                  total={items.length}
                  isEditing={isEditing}
                  canReorder={canReorder}
                  disabled={item.runId === null || busyRunId !== null}
                >
                  {({ reorder }) => (
                    <QueuedMessage
                      environmentId={props.environmentId}
                      message={item.message}
                      previewText={previewText}
                      thumbnails={item.thumbnails}
                      isEditing={isEditing}
                      timestampFormat={props.timestampFormat}
                      onOpenThread={props.onOpenThread}
                      onEdit={editQueuedMessage}
                      editLabel={
                        props.editBlockedReason ??
                        `Edit in the composer${item.serverIndex === queued.length - 1 && props.editShortcutLabel ? ` (${props.editShortcutLabel})` : ""}`
                      }
                      leadingControl={sendNowControl}
                      reorder={reorder}
                      footerLeading={mergeControl}
                      removeControl={removeControl}
                    >
                      {item.pending ? (
                        <span className="flex items-center gap-1 px-1">
                          <Clock3Icon aria-hidden className="size-3" />
                          Saving
                        </span>
                      ) : null}
                      {isEditing ? (
                        <>
                          <span className="px-1 text-foreground">Editing in the composer</span>
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label="Cancel editing queued message"
                            onClick={props.onCancelEdit}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : null}
                    </QueuedMessage>
                  )}
                </SortableQueuedMessageItem>
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
      {collapsible ? (
        <div className="self-end pe-1 text-xs pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5">
          <InlineButton
            tone="muted"
            aria-expanded={showAll}
            aria-controls={queueListId}
            // Keep the composer focused; keyboard activation still works.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `Show all ${items.length} queued`}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                showAll && "rotate-180",
              )}
            />
          </InlineButton>
        </div>
      ) : null}
    </section>
  );
}

// Bubble padding plus the first text line, so the controls center on that line.
const FIRST_LINE_ALIGN = "box-content flex h-5 items-center pt-2";

function MergeQueuedMessagesIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5"
    >
      <path d="M12 2v8" />
      <path d="m8 6 4 4 4-4" />
      <path d="M12 22v-8" />
      <path d="m8 18 4-4 4 4" />
    </svg>
  );
}

function SortableQueuedMessageItem(props: {
  readonly id: string;
  readonly position: number;
  readonly total: number;
  readonly isEditing: boolean;
  readonly canReorder: boolean;
  readonly disabled: boolean;
  readonly children: (input: {
    readonly reorder: {
      readonly attributes: ReturnType<typeof useSortable>["attributes"];
      readonly listeners: ReturnType<typeof useSortable>["listeners"];
    } | null;
  }) => ReactNode;
}) {
  const sortableDisabled = !props.canReorder || props.disabled;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: sortableDisabled,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={`Queued message ${props.position + 1} of ${props.total}, not sent`}
      aria-posinset={props.position + 1}
      aria-setsize={props.total}
      aria-current={props.isEditing ? "true" : undefined}
      className={cn(
        "group/queued flex w-full flex-col items-end gap-1",
        isDragging && "relative z-10 opacity-90",
      )}
    >
      {props.children({
        reorder: sortableDisabled ? null : { attributes, listeners },
      })}
    </li>
  );
}

type QueuedRunMessage = NonNullable<ThreadQueueProjection["messages"][number]>;

/** A queued turn wears its sent form's attribution; only the dashed edge and controls differ. */
function QueuedMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly message: QueuedRunMessage | undefined;
  readonly previewText: string;
  readonly thumbnails: ReadonlyArray<QueuedRowThumbnail>;
  readonly isEditing: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onEdit: (() => void) | null;
  readonly editLabel: string;
  readonly leadingControl?: ReactNode;
  readonly reorder: {
    readonly attributes: ReturnType<typeof useSortable>["attributes"];
    readonly listeners: ReturnType<typeof useSortable>["listeners"];
  } | null;
  readonly footerLeading?: ReactNode;
  readonly removeControl?: ReactNode;
  readonly children: ReactNode;
}) {
  const presentation = props.message ? resolveUserMessagePresentation(props.message) : null;
  const attribution = presentation?.attribution ?? null;
  const scheduledTaskId = presentation?.scheduledTaskId;
  const senderThreadId = props.message?.senderThreadId;
  const [expanded, setExpanded] = useState(false);
  const taskTitle = useScheduledTaskTitle(props.environmentId, scheduledTaskId);
  const senderShell = useQuietThreadShell(
    attribution === "agent" && senderThreadId
      ? { environmentId: props.environmentId, threadId: senderThreadId }
      : null,
  );
  const fold =
    attribution === "automation"
      ? {
          icon: CalendarClockIcon,
          label: "Automation",
          summary: taskTitle ?? props.previewText.split(/\r?\n/, 1)[0] ?? "",
        }
      : attribution === "agent"
        ? {
            icon: MessagesSquareIcon,
            label: senderShell?.title.trim() || "Agent",
            summary: props.previewText.split(/\r?\n/).find((line) => line.trim()) ?? "",
          }
        : null;
  const bodyVisible = fold === null || expanded;
  const promptLink = promptLinkFor(props.previewText);
  const bubbleIsButton = props.onEdit !== null && fold === null;
  const { onKeyDown: reorderKeyDown, ...bubbleReorderListeners } = props.reorder?.listeners ?? {};

  return (
    <>
      {attribution === "t3code" ? (
        <p className="me-1 text-2xs text-muted-foreground/70">Sent by T3 Code</p>
      ) : null}
      {presentation?.guestName === undefined ? null : (
        <GuestMessageName name={presentation.guestName} />
      )}
      <div
        className={cn(
          "flex w-full items-start justify-end gap-1.5",
          fold !== null && expanded && "w-full",
        )}
      >
        {props.leadingControl ? (
          <div className={FIRST_LINE_ALIGN}>{props.leadingControl}</div>
        ) : null}
        {/* Dashed and unfilled: a turn that has not been sent yet. */}
        <div
          role={bubbleIsButton ? "button" : undefined}
          tabIndex={bubbleIsButton ? 0 : undefined}
          aria-label={bubbleIsButton ? "Edit queued message" : undefined}
          {...bubbleReorderListeners}
          onClick={(event) => {
            if (!props.onEdit) return;
            const target = event.target;
            if (target instanceof Element && target.closest("button, a")) return;
            props.onEdit();
          }}
          onKeyDown={(event) => {
            reorderKeyDown?.(event);
            if (!bubbleIsButton || event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            props.onEdit?.();
          }}
          className={cn(
            "flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed text-start text-sm",
            props.onEdit && "cursor-pointer",
            props.isEditing
              ? "border-primary/60 text-foreground"
              : attribution === "guest"
                ? "border-guest/50 text-muted-foreground"
                : "border-muted-foreground/40 text-muted-foreground",
            fold === null && "px-3 py-2",
            fold !== null && expanded && "w-full",
          )}
        >
          {fold ? (
            <FoldedMessageHeader
              icon={fold.icon}
              label={fold.label}
              summary={fold.summary}
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
            />
          ) : null}
          {bodyVisible ? (
            <div
              className={cn(
                "flex flex-col gap-2",
                fold !== null && "max-h-96 overflow-auto px-3 pb-2",
              )}
            >
              {props.thumbnails.length > 0 ? (
                <span className="flex flex-wrap items-center gap-1">
                  {props.thumbnails.map((thumbnail) => (
                    <span
                      key={thumbnail.key}
                      className="size-8 overflow-hidden rounded-md border border-border/70 bg-background"
                    >
                      {thumbnail.url ? (
                        <img
                          src={thumbnail.url}
                          alt={thumbnail.name}
                          className="size-full object-cover"
                        />
                      ) : (
                        <span aria-label={thumbnail.name} className="block size-full bg-muted/60" />
                      )}
                    </span>
                  ))}
                </span>
              ) : null}
              {/* In full, like a sent turn: a queued message is read before it is sent. */}
              {props.previewText || props.onEdit ? (
                <p className="whitespace-pre-wrap wrap-anywhere">
                  {props.previewText}
                  {props.onEdit ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="ms-1 inline-block translate-y-px text-muted-foreground/80" />
                        }
                      >
                        <PencilIcon aria-hidden className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup>{props.editLabel}</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        {props.reorder ? (
          <div className={FIRST_LINE_ALIGN}>
            <Tooltip>
              <TooltipTrigger
                render={<span className="flex shrink-0 cursor-grab active:cursor-grabbing" />}
              >
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Reorder queued message"
                  {...props.reorder.attributes}
                  {...props.reorder.listeners}
                >
                  <GripVerticalIcon />
                </Button>
              </TooltipTrigger>
              <TooltipPopup>Hold and drag to reorder</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1 pe-1 text-xs text-muted-foreground">
        {props.footerLeading}
        {props.message || props.previewText ? (
          <span className="flex items-center gap-1 px-1 opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/queued:opacity-100">
            {attribution === "agent" && senderThreadId ? (
              <InlineButton tone="muted" onClick={() => props.onOpenThread(senderThreadId)}>
                Open thread
              </InlineButton>
            ) : null}
            {scheduledTaskId ? (
              <InlineButton
                tone="muted"
                render={
                  <Link
                    to="/settings/scheduled-tasks"
                    search={{ environmentId: props.environmentId, taskId: scheduledTaskId }}
                  />
                }
              >
                Open automation
              </InlineButton>
            ) : null}
            {props.message ? (
              <TimelineRowTimestamp
                createdAt={DateTime.formatIso(props.message.createdAt)}
                timestampFormat={props.timestampFormat}
                alwaysVisible
              />
            ) : null}
            {props.previewText ? (
              <MessageCopyButton text={props.previewText} variant="ghost" />
            ) : null}
            {promptLink !== null ? (
              <MessageCopyButton
                text={promptLink}
                label="Copy prompt link"
                icon={LinkIconNode}
                variant="ghost"
              />
            ) : null}
            {props.removeControl}
          </span>
        ) : null}
        {props.children}
      </div>
    </>
  );
}
