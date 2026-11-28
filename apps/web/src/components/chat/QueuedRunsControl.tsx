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
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveQueuedRunSelectionDiffs,
  type QueuedRunSelectionDiff,
} from "@t3tools/client-runtime/handoff";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { isSlashCommand } from "@t3tools/shared/composerTrigger";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { composerFileLinksToPlainText } from "@t3tools/shared/composerInlineTokens";
import {
  parseGoalCommand,
  ProviderDriverKind,
  type ChatAttachment as ContractChatAttachment,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  CircleStopIcon,
  Clock3Icon,
  MessagesSquareIcon,
  LinkIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";
import { msg, T, useGT, useMessages } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  Children,
  Fragment,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { m } from "../../i18n/messages";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ContextImplicationInfo, resolveSelectionDisplay } from "./ContextImplicationInfo";
import { GuestMessageName } from "./guestMessageStyle";
import { MessageCopyButton } from "./MessageCopyButton";
import { promptLinkFor } from "../promptLinks/copyPromptLink";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { FoldedMessageHeader, useScheduledTaskTitle } from "./TimelineUserMessageRow";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  QueuedRunInlineComposer,
  type QueuedRunInlineEditorContext,
} from "./QueuedRunInlineComposer";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
  readonly modelSelection?: ModelSelection;
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
      isImageAttachment(attachment)
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
  /** Set while editing is unavailable (for example, a read-only connection). */
  readonly editBlockedReason: string | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly inlineEditor?: QueuedRunInlineEditorContext | null;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const projection = useQuietThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const merge = useAtomCommand(threadEnvironment.mergeQueuedRuns);
  const hold = useAtomCommand(threadEnvironment.holdQueuedRun);
  const sensors = useSensors(
    // A click stays a click. Moving the pointer starts the reorder.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
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
  const workflow = projection ? deriveThreadQueueWorkflowState(projection, messages) : null;
  const queued = workflow?.queuedRuns ?? [];
  const selectionDiffs = resolveQueuedRunSelectionDiffs(projection, queued, providers, messages);
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
      modelSelection: run.modelSelection,
      selectionDiff: selectionDiffs[serverIndex] ?? null,
      stopsBefore: run.queueHoldReasons?.includes("stop_before") === true,
      freshContext: run.freshContext === true,
      serverIndex,
      text,
      // A guest's message keeps the guest's words; the owner can cancel it, not rewrite it.
      editable: context?.guest === undefined,
      attachments,
      thumbnails: attachments.filter(isImageAttachment).map<ChatImageAttachment>((attachment) => {
        const previewUrl = queuedImageUrlById.get(attachment.id);
        return {
          ...attachment,
          type: "image",
          ...(previewUrl ? { previewUrl } : {}),
        };
      }),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      message: undefined,
      runId: null,
      messageId: null,
      modelSelection: undefined,
      selectionDiff: null,
      stopsBefore: false,
      freshContext: false,
      serverIndex: null,
      text: message.text,
      editable: true,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? []).filter(isImageAttachment),
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
    const result = workflow?.canSendNow
      ? await resume({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, runId: queuedRunId },
        })
      : activeRun !== null
        ? await promote({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
          })
        : null;
    steerInFlightRef.current = false;
    setBusyRunId(null);
    if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: m(msg("Could not send queued message")),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, m) ?? error.message)
            : m(msg("An error occurred.")),
      });
    }
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
          ...(latest.run.modelSelection === undefined
            ? {}
            : { modelSelection: latest.run.modelSelection }),
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

  const setStopBeforeQueuedRun = async (queuedRunId: RunId, held: boolean) => {
    setBusyRunId(queuedRunId);
    const result = await hold({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        runId: queuedRunId,
        reason: "stop_before",
        held,
      },
    });
    setBusyRunId((current) => (current === queuedRunId ? null : current));
    if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: held ? gt("Could not stop queue here") : gt("Could not cancel queue stop"),
        description: thrownErrorMessage(squashAtomCommandFailure(result), messages),
      });
    }
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
  const editingItemHidden =
    props.editingRunId !== null &&
    collapsible &&
    !showAll &&
    !items.slice(0, QUEUE_VISIBLE_ROWS - 1).some((item) => item.runId === props.editingRunId);
  const visibleItems =
    collapsible && !showAll && !editingItemHidden ? items.slice(0, QUEUE_VISIBLE_ROWS - 1) : items;
  const canReorder = queued.length > 1;
  const sortableIds = visibleItems.map((item) => item.key);

  return (
    <section
      aria-label={gt(
        "{count, plural, one {{count} queued message} other {{count} queued messages}}",
        { count: items.length },
      )}
      data-thread-queue="true"
      // Anchors the sr-only live region; unanchored, it escapes the timeline scroller and makes the chat column scroll.
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pt-8 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {gt("{count, plural, one {{count} queued} other {{count} queued}}", {
          count: items.length,
        })}
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
                    composerFileLinksToPlainText(
                      replaceComposerContextReferences(item.text, (reference) => reference.label),
                    ),
                  ).trim();
              const isEditing = item.runId !== null && item.runId === props.editingRunId;
              // The server decides on the agent's text, and a goal command can stop the turn.
              const sentText = {
                text: item.message?.text ?? item.text,
                attachments: item.attachments,
              };
              const movesCommandFirst =
                isSlashCommand(sentText) && parseGoalCommand(sentText) === null;
              const nextItem = visibleItems[position + 1];
              const canMergeWithNext =
                nextItem !== undefined &&
                item.runId !== null &&
                nextItem.runId !== null &&
                item.editable &&
                nextItem.editable;
              const sendNowControl =
                canSendRun(item.freshContext) && !isEditing ? (
                  <SharedTooltipTrigger
                    render={<span className="flex shrink-0" />}
                    label={
                      item.serverIndex === 0 && props.steerShortcutLabel
                        ? workflow?.canSendNow
                          ? gt("Start a turn with this message ({shortcut})", {
                              shortcut: props.steerShortcutLabel,
                            })
                          : workflow?.promoteSkipsCompaction
                            ? gt("Skip compaction and send this message ({shortcut})", {
                                shortcut: props.steerShortcutLabel,
                              })
                            : movesCommandFirst
                              ? gt("Move this command to the front of the queue ({shortcut})", {
                                  shortcut: props.steerShortcutLabel,
                                })
                              : gt("Send into the current turn ({shortcut})", {
                                  shortcut: props.steerShortcutLabel,
                                })
                        : workflow?.canSendNow
                          ? gt("Start a turn with this message")
                          : workflow?.promoteSkipsCompaction
                            ? gt("Skip compaction and send this message")
                            : movesCommandFirst
                              ? gt("Move this command to the front of the queue")
                              : gt("Send into the current turn")
                    }
                  >
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
                      <T>Send now</T>
                    </Button>
                  </SharedTooltipTrigger>
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
                      ...(item.modelSelection === undefined
                        ? {}
                        : { modelSelection: item.modelSelection }),
                    });
                  }
                : null;
              const removeControl =
                item.runId === null ? null : (
                  <SharedTooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={gt("Remove queued message")}
                        disabled={busyRunId !== null}
                        onClick={() => {
                          if (item.runId !== null) void remove(item.runId);
                        }}
                      />
                    }
                    label={
                      <>
                        <T>Remove from queue</T>
                      </>
                    }
                  >
                    <XIcon />
                  </SharedTooltipTrigger>
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
                      <T>Merge</T>
                    </Button>
                  </TooltipTrigger>
                  <TooltipPopup>
                    <T>Merge with next queued message</T>
                  </TooltipPopup>
                </Tooltip>
              ) : null;
              const canStopAfter =
                nextItem !== undefined &&
                item.runId !== null &&
                nextItem.runId !== null &&
                !nextItem.stopsBefore;
              const stopAfterControl = canStopAfter ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex shrink-0" />}>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={busyRunId !== null}
                      onClick={() => {
                        if (nextItem.runId !== null) {
                          void setStopBeforeQueuedRun(nextItem.runId, true);
                        }
                      }}
                    >
                      <CircleStopIcon />
                      <T>Stop After</T>
                    </Button>
                  </TooltipTrigger>
                  <TooltipPopup>
                    <T>Stop the queue after this message</T>
                  </TooltipPopup>
                </Tooltip>
              ) : null;
              const stoppedAtDivider = item.stopsBefore && position === 0 && activeRun === null;
              return (
                <Fragment key={item.key}>
                  {item.stopsBefore && item.runId !== null ? (
                    <li role="presentation" className="w-full" data-slot="queue-stop-divider">
                      {stoppedAtDivider ? (
                        <TimelineSystemDivider
                          label={gt("Queue interrupted")}
                          detail={gt("Stopped by user")}
                          icon={CircleStopIcon}
                        />
                      ) : (
                        <TimelineSystemDivider
                          label={gt("Stops here")}
                          icon={CircleStopIcon}
                          detail={
                            <InlineButton
                              tone="muted"
                              disabled={busyRunId !== null}
                              onClick={() => {
                                if (item.runId !== null) {
                                  void setStopBeforeQueuedRun(item.runId, false);
                                }
                              }}
                            >
                              <T>Cancel</T>
                            </InlineButton>
                          }
                        />
                      )}
                    </li>
                  ) : null}
                  <SortableQueuedMessageItem
                    id={item.key}
                    position={position}
                    total={items.length}
                    isEditing={isEditing}
                    canReorder={canReorder}
                    disabled={item.runId === null || busyRunId !== null || isEditing}
                  >
                    {({ reorder }) =>
                      isEditing &&
                      item.runId !== null &&
                      props.inlineEditor &&
                      props.inlineEditor.editDraftTarget !== null ? (
                        <QueuedRunInlineComposer
                          key={item.runId}
                          environmentId={props.environmentId}
                          runId={item.runId}
                          draftTarget={props.inlineEditor.editDraftTarget}
                          isPausedOnEditing={
                            item.serverIndex === 0 &&
                            activeRun === null &&
                            props.inlineEditor.phase !== "running"
                          }
                          editorContext={props.inlineEditor}
                        />
                      ) : (
                        <QueuedMessage
                          environmentId={props.environmentId}
                          providers={providers}
                          selectionDiff={item.selectionDiff}
                          message={item.message}
                          previewText={previewText}
                          thumbnails={item.thumbnails}
                          isEditing={isEditing}
                          timestampFormat={props.timestampFormat}
                          onOpenThread={props.onOpenThread}
                          onEdit={editQueuedMessage}
                          onImageExpand={props.onImageExpand}
                          editLabel={
                            props.editBlockedReason ??
                            (item.serverIndex === queued.length - 1 && props.editShortcutLabel
                              ? gt("Edit queued message ({shortcut})", {
                                  shortcut: props.editShortcutLabel,
                                })
                              : gt("Edit queued message"))
                          }
                          leadingControl={sendNowControl}
                          reorder={reorder}
                          footerLeading={mergeControl}
                          stopAfterControl={stopAfterControl}
                          removeControl={removeControl}
                        >
                          {item.pending ? (
                            <span className="flex items-center gap-1 px-1">
                              <Clock3Icon aria-hidden className="size-3" />
                              <T>Saving</T>
                            </span>
                          ) : null}
                        </QueuedMessage>
                      )
                    }
                  </SortableQueuedMessageItem>
                </Fragment>
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
            {showAll
              ? gt("Show fewer")
              : gt(
                  "{count, plural, one {Show all {count} queued} other {Show all {count} queued}}",
                  { count: items.length },
                )}
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

function MetaDot() {
  return (
    <span aria-hidden className="px-1.5 text-muted-foreground/40">
      ·
    </span>
  );
}

function QueueDragGrip() {
  return (
    <span aria-hidden className="flex flex-col items-center gap-px">
      {Array.from({ length: 5 }, (_, row) => (
        <span key={row} className="flex gap-0.5">
          <span className="size-0.5 rounded-full bg-current" />
          <span className="size-0.5 rounded-full bg-current" />
        </span>
      ))}
    </span>
  );
}

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
  const gt = useGT();
  const sortableDisabled = !props.canReorder || props.disabled;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: sortableDisabled,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={gt("Queued message {position} of {total}, not sent", {
        position: props.position + 1,
        total: props.total,
      })}
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
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selectionDiff: QueuedRunSelectionDiff | null;
  readonly message: QueuedRunMessage | undefined;
  readonly previewText: string;
  readonly thumbnails: ReadonlyArray<ChatImageAttachment>;
  readonly isEditing: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly onEdit: (() => void) | null;
  readonly editLabel: string;
  readonly leadingControl?: ReactNode;
  readonly reorder: {
    readonly attributes: ReturnType<typeof useSortable>["attributes"];
    readonly listeners: ReturnType<typeof useSortable>["listeners"];
  } | null;
  readonly footerLeading?: ReactNode;
  readonly stopAfterControl?: ReactNode;
  readonly removeControl?: ReactNode;
  readonly children: ReactNode;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const gt = useGT();
  const presentation = props.message ? resolveUserMessagePresentation(props.message) : null;
  const attribution = presentation?.attribution ?? null;
  const scheduledTaskId = presentation?.scheduledTaskId;
  const senderThreadId = props.message?.senderThreadId;
  // A linked environment's agent sent it from a thread there.
  const senderRef =
    props.message?.linkedSender ??
    (senderThreadId === undefined ? null : scopeThreadRef(props.environmentId, senderThreadId));
  const [expanded, setExpanded] = useState(false);
  const taskTitle = useScheduledTaskTitle(props.environmentId, scheduledTaskId);
  const senderShell = useQuietThreadShell(attribution === "agent" ? senderRef : null);
  const linkedSenderEnvironment = useEnvironment(
    props.message?.linkedSender?.environmentId ?? null,
  );
  const senderTitle = senderShell?.title.trim() || props.message?.linkedSender?.title.trim();
  const fold =
    attribution === "automation"
      ? {
          icon: CalendarClockIcon,
          label: gt("Automation"),
          fitLabel: true,
          summary: taskTitle ?? props.previewText.split(/\r?\n/, 1)[0] ?? "",
        }
      : attribution === "agent"
        ? {
            icon: MessagesSquareIcon,
            label:
              senderTitle ||
              gt("Agent", { $context: "fallback name of the agent that sent a message" }),
            fitLabel: !senderTitle,
            summary: props.previewText.split(/\r?\n/).find((line) => line.trim()) ?? "",
          }
        : null;
  const bodyVisible = fold === null || expanded;
  const promptLink = promptLinkFor(props.previewText);
  const bubbleIsButton = props.onEdit !== null && fold === null;
  const { onKeyDown: reorderKeyDown, ...bubbleReorderListeners } = props.reorder?.listeners ?? {};
  const hasPersistentFooter = Children.toArray(props.children).length > 0;

  return (
    <>
      {attribution === "t3code" ? (
        <p className="me-1 text-2xs text-muted-foreground/70">
          <T>Sent by T3 Code</T>
        </p>
      ) : null}
      {presentation?.guestName === undefined ? null : (
        <GuestMessageName name={presentation.guestName} />
      )}
      <div className="flex w-full flex-col items-end">
        <div
          className={cn(
            "relative flex w-full items-center justify-end gap-1.5",
            fold !== null && expanded && "w-full",
          )}
        >
          {props.leadingControl}
          {/* Dashed and unfilled: a turn that has not been sent yet. */}
          <div
            role={bubbleIsButton ? "button" : undefined}
            tabIndex={bubbleIsButton ? 0 : undefined}
            aria-label={bubbleIsButton ? gt("Edit queued message") : undefined}
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
              "flex min-w-0 max-w-[80%] touch-none flex-col rounded-2xl border border-dashed text-start text-sm",
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
            {props.selectionDiff !== null ? (
              <div className={cn("self-start", fold !== null ? "px-3 pt-2" : "mb-1.5")}>
                <QueuedSelectionDiffBadge
                  environmentId={props.environmentId}
                  providers={props.providers}
                  diff={props.selectionDiff}
                />
              </div>
            ) : null}
            {fold ? (
              <FoldedMessageHeader
                icon={fold.icon}
                label={fold.label}
                fitLabel={fold.fitLabel}
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
                {/* In full, like a sent turn: a queued message is read before it is sent. */}
                {props.previewText || props.onEdit ? (
                  <p className="whitespace-pre-wrap wrap-anywhere">
                    {props.previewText}
                    {props.onEdit ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="ms-3 inline-block translate-y-px align-baseline leading-none text-muted-foreground" />
                          }
                        >
                          <PencilIcon
                            aria-hidden
                            className="block size-3.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.75}
                          />
                        </TooltipTrigger>
                        <TooltipPopup>{props.editLabel}</TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </p>
                ) : null}
                {props.thumbnails.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {props.thumbnails.map((thumbnail) => (
                      <button
                        key={thumbnail.id}
                        type="button"
                        aria-label={gt("Preview {name}", { name: thumbnail.name })}
                        disabled={!thumbnail.previewUrl}
                        className="size-8 overflow-hidden rounded-md border border-border/70 bg-background enabled:cursor-zoom-in"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => {
                          const preview = buildExpandedImagePreview(props.thumbnails, thumbnail.id);
                          if (preview) props.onImageExpand(preview);
                        }}
                      >
                        {thumbnail.previewUrl ? (
                          <img
                            src={thumbnail.previewUrl}
                            alt={thumbnail.name}
                            className="size-full object-cover"
                          />
                        ) : (
                          <span
                            aria-label={thumbnail.name}
                            className="block size-full bg-muted/60"
                          />
                        )}
                      </button>
                    ))}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          {props.reorder ? (
            <div className="absolute start-full top-1/2 ms-1.5 -translate-y-1/2">
              <Tooltip>
                <TooltipTrigger
                  render={<span className="flex size-6 cursor-grab active:cursor-grabbing" />}
                >
                  <button
                    type="button"
                    aria-label={gt("Reorder queued message")}
                    className="flex size-6 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
                    {...props.reorder.attributes}
                    {...props.reorder.listeners}
                  >
                    <QueueDragGrip />
                  </button>
                </TooltipTrigger>
                <TooltipPopup>
                  <T>Drag to reorder</T>
                </TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
        {props.footerLeading ||
        props.stopAfterControl ||
        props.message ||
        props.previewText ||
        props.removeControl ||
        hasPersistentFooter ? (
          <div
            className={cn(
              "grid w-full transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
              hasPersistentFooter
                ? "grid-rows-[1fr] opacity-100"
                : "grid-rows-[0fr] opacity-0 pointer-coarse:grid-rows-[1fr] pointer-coarse:opacity-100 focus-within:grid-rows-[1fr] focus-within:opacity-100 group-hover/queued:grid-rows-[1fr] group-hover/queued:opacity-100",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex w-full items-center justify-end gap-1.5 pt-1 text-xs text-muted-foreground">
                <div className="flex min-w-0 items-center justify-end">
                  {props.footerLeading ||
                  props.stopAfterControl ||
                  props.message ||
                  props.previewText ||
                  props.removeControl ? (
                    <span
                      className={cn(
                        "flex items-center",
                        hasPersistentFooter &&
                          "opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/queued:opacity-100",
                      )}
                    >
                      <span className="flex items-center gap-1">
                        {attribution === "agent" &&
                        senderRef &&
                        // Only an environment this client is connected to can open the sender's thread there.
                        (props.message?.linkedSender === undefined ||
                          linkedSenderEnvironment !== null) ? (
                          <InlineButton
                            tone="muted"
                            onClick={() =>
                              props.onOpenThread(senderRef.threadId, senderRef.environmentId)
                            }
                          >
                            <T>Open thread</T>
                          </InlineButton>
                        ) : null}
                        {scheduledTaskId ? (
                          <InlineButton
                            tone="muted"
                            render={
                              <Link
                                to="/settings/scheduled-tasks"
                                search={{
                                  environmentId: props.environmentId,
                                  taskId: scheduledTaskId,
                                }}
                              />
                            }
                          >
                            <T>Open automation</T>
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
                            label={gt("Copy prompt link")}
                            icon={LinkIcon}
                            variant="ghost"
                          />
                        ) : null}
                      </span>
                      {props.footerLeading ? (
                        <>
                          <MetaDot />
                          {props.footerLeading}
                        </>
                      ) : null}
                      {props.stopAfterControl ? (
                        <>
                          <MetaDot />
                          {props.stopAfterControl}
                        </>
                      ) : null}
                      {props.removeControl ? (
                        <>
                          <MetaDot />
                          {props.removeControl}
                        </>
                      ) : null}
                    </span>
                  ) : null}
                  {props.children}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function QueuedSelectionDiffBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly diff: QueuedRunSelectionDiff;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const derived = deriveProviderInstanceEntries(props.providers);
  const entries = settings ? applyProviderInstanceSettings(derived, settings, null) : derived;
  const target = resolveSelectionDisplay(props.diff.to, entries);
  const textParts = [
    props.diff.modelChanged ? target.modelLabel : null,
    props.diff.effortLabel,
    props.diff.speedLabel,
  ].filter((part): part is string => part !== null && part.length > 0);
  const badgeText = textParts.join(" · ");
  const hasSelectionBadge = props.diff.providerChanged || badgeText.length > 0;
  const fullTooltip = [
    target.providerLabel,
    target.modelLabel,
    props.diff.effortLabel,
    props.diff.speedLabel,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const driverKind = target.entry?.driverKind ?? ProviderDriverKind.make(props.diff.to.instanceId);

  return (
    <div data-slot="queued-selection-diff" className="flex max-w-full flex-wrap items-center gap-1">
      {hasSelectionBadge ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-slot="queued-model-badge"
                aria-label={fullTooltip}
                className={cn(
                  "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/70 bg-muted/50 py-0.5 text-2xs font-medium leading-none text-foreground/80",
                  badgeText ? "px-1.5" : "px-1",
                )}
              />
            }
          >
            {props.diff.providerChanged ? (
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={target.providerLabel}
                accentColor={target.entry?.accentColor}
                acpRegistryAgentId={target.entry?.acpRegistryAgentId}
                acpRegistryIconUrl={target.entry?.acpRegistryIconUrl}
                showBadge={target.showInstanceBadge}
                size="compact"
                iconClassName="size-3"
                indicatorBackground="var(--muted)"
              />
            ) : null}
            {badgeText ? <span className="truncate">{badgeText}</span> : null}
          </TooltipTrigger>
          <TooltipPopup>{fullTooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
      {props.diff.contextImplication !== null ? (
        <ContextImplicationInfo
          implication={props.diff.contextImplication}
          entries={entries}
          align="start"
          size="badge"
        />
      ) : null}
    </div>
  );
}
