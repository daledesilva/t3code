import { resolveComposerContextImplication } from "@t3tools/client-runtime/handoff";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { deriveThreadStructureRuntime } from "@t3tools/client-runtime/state/thread-execution";
import type {
  ChatAttachment as ContractChatAttachment,
  ChatFileAttachment,
  ComposerContextId,
  EnvironmentId,
  ModelSelection,
  OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ResolvedKeybindingsConfig,
  ResponseContextRecord,
  RunId,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { parseSideChatCommand } from "@t3tools/shared/composerTrigger";
import { msg, useGT } from "gt-react";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { ComposerSubmissionIntent } from "../../composer-logic";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { m as resolveMessage } from "../../i18n/messages";
import type { ShortcutMatchContext } from "../../keybindings";
import { responseContextReference } from "../../lib/composerContextRecords";
import {
  collectInlineContextIds,
  formatInlineContextReference,
} from "../../lib/composerContextReferences";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { providerInstanceEntriesFor } from "../../providerInstances";
import type { PendingApproval, PendingUserInput, TimelineEntry } from "../../session-logic";
import type { SessionPhase } from "../../types";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { QueuedAttachmentContextBinding } from "./composerContextUndo";
import { ComposerSurface } from "./ComposerSurface";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { useComposerSelection } from "./useComposerSelection";
import type { QueuedRunEditContent } from "./useQueuedRunEdit";
import type { EnvironmentUnavailableState } from "./useSystemComposerBanners";

const EMPTY_PENDING_APPROVALS: PendingApproval[] = [];
const EMPTY_PENDING_USER_INPUTS: PendingUserInput[] = [];
const EMPTY_RESPONDING_REQUEST_IDS: RuntimeRequestId[] = [];
const EMPTY_COMPOSER_BANNER_ITEMS: ReadonlyArray<ComposerBannerStackItem> = [];
const noop = () => {};

function withReplyReference(prompt: string, replyTo: ResponseContextRecord | null): string {
  return replyTo && !collectInlineContextIds(prompt).includes(replyTo.contextId)
    ? `${formatInlineContextReference(responseContextReference(replyTo))} ${prompt}`
    : prompt;
}

export interface QueuedRunInlineEditorContext {
  readonly editDraftTarget: DraftId | null;
  readonly editingAttachments: ReadonlyArray<{
    readonly attachment: ContractChatAttachment;
    readonly url: string | null;
    readonly contextIds?: ReadonlyArray<ComposerContextId> | undefined;
  }> | null;
  readonly removedEditingAttachments?: ReadonlyArray<QueuedAttachmentContextBinding> | undefined;
  readonly isSaving: boolean;
  readonly onCancelEdit: () => void;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onRestoreAttachment?: ((attachment: ContractChatAttachment) => void) | undefined;
  readonly onSaveEdit: (
    content: QueuedRunEditContent,
    setThreadError: (threadId: ThreadId, error: string | null) => void,
    submission?: {
      readonly dispatchMode: ComposerDispatchMode;
      readonly submissionIntent: ComposerSubmissionIntent;
    },
  ) => Promise<void>;
  readonly routeThreadRef: ScopedThreadRef;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly promptHistoryEntries: ReadonlyArray<TimelineEntry>;
  readonly activeRuntime: ReturnType<typeof deriveThreadStructureRuntime>;
  readonly activeProjectId: ProjectId | null;
  readonly activeProjectName: string | undefined;
  readonly activeProjectDefaultModelSelection: ModelSelection | null;
  readonly serverProjection: ThreadStructure | null;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly providerCatalogKnown: boolean;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly supportsProviderSwitchingViaHandoff: boolean;
  readonly canOperateThread: boolean;
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
  readonly environmentUnavailable: EnvironmentUnavailableState | null;
  readonly canSteer: boolean;
  readonly phase: SessionPhase;
  readonly resolvedTheme: "light" | "dark";
  readonly settings: UnifiedSettings;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly getShortcutContext: (eventTarget: EventTarget | null) => ShortcutMatchContext;
  readonly gitCwd: string | null;
  readonly pullRequestProjectId: ProjectId | null;
  readonly pullRequestRepository: string | null;
  readonly threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
}

/**
 * In-place composer that replaces a queued row while editing. Reuses `ChatComposer` inside
 * `ComposerSurface` so attachments, mentions, slash commands, dictation, paste/drop, and
 * model/effort selection work identically to the bottom composer without touching it.
 */
export function QueuedRunInlineComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: RunId;
  readonly draftTarget: DraftId;
  readonly isPausedOnEditing: boolean;
  readonly editorContext: QueuedRunInlineEditorContext;
}) {
  const { environmentId, runId, draftTarget, isPausedOnEditing, editorContext } = props;
  const {
    editingAttachments,
    removedEditingAttachments,
    isSaving,
    onCancelEdit,
    onRemoveAttachment,
    onRestoreAttachment,
    onSaveEdit,
    routeThreadRef,
    activeThread,
    activeThreadRuns,
    promptHistoryEntries,
    activeRuntime,
    activeProjectId,
    activeProjectName,
    activeProjectDefaultModelSelection,
    serverProjection,
    providerStatuses,
    providerCatalogKnown,
    lockedProvider,
    supportsProviderSwitchingViaHandoff,
    canOperateThread,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
    environmentUnavailable,
    canSteer,
    phase,
    resolvedTheme,
    settings,
    keybindings,
    getShortcutContext,
    gitCwd,
    pullRequestProjectId,
    pullRequestRepository,
    threadPullRequests,
    setThreadError,
    onExpandImage,
    onFileOpen,
  } = editorContext;

  const gt = useGT();
  const containerRef = useRef<HTMLDivElement>(null);
  const inlineComposerRef = useRef<ChatComposerHandle | null>(null);
  const inlinePromptRef = useRef("");
  const inlineImagesRef = useRef<ComposerImageAttachment[]>([]);
  const inlineFilesRef = useRef<ComposerFileAttachment[]>([]);
  const inlineTerminalContextsRef = useRef<TerminalContextDraft[]>([]);

  const focusInlineComposer = useStableCallback(() => {
    inlineComposerRef.current?.focusAtEnd();
  });
  const scheduleInlineComposerFocus = useStableCallback(() => {
    window.requestAnimationFrame(() => {
      inlineComposerRef.current?.focusAtEnd();
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses and reveals the inline composer when editing begins
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inlineComposerRef.current?.focusAtEnd();
      containerRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const { getModelDisabledReason, onProviderModelSelectStable, openProviderSetupStable } =
    useComposerSelection({
      environmentId,
      composerDraftTarget: draftTarget,
      draftThread: null,
      activeThread,
      activeRuntime,
      activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
      settings,
      providerStatuses,
      lockedProvider,
      supportsProviderSwitchingViaHandoff,
      multipleModelSelections: null,
      runtimeMode: activeThread?.runtimeMode ?? "approval-required",
      isLocalDraftThread: false,
      canOverrideServerThreadEnvMode: false,
      setPendingServerThreadEnvModeEntry: noop,
      setPendingServerThreadStartFromOriginByThreadId: noop,
      scheduleComposerFocus: scheduleInlineComposerFocus,
    });

  const draftSelectedModelSelection = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(draftTarget);
    return draft?.activeProvider
      ? (draft.modelSelectionByProvider[draft.activeProvider] ?? null)
      : null;
  });
  const providerInstanceEntries = providerInstanceEntriesFor(
    providerStatuses,
    settings,
    activeProjectId,
  );
  const effectiveSelection = draftSelectedModelSelection ?? activeThread?.modelSelection ?? null;
  const selectionUsable = providerInstanceEntries.some(
    (entry) =>
      entry.instanceId === effectiveSelection?.instanceId && entry.enabled && entry.isAvailable,
  );
  const contextImplication = resolveComposerContextImplication(
    serverProjection,
    selectionUsable ? effectiveSelection : null,
    providerStatuses,
    {
      editingRunId: runId,
      freshSessionPending: false,
    },
  );

  const getInlineShortcutContext = useStableCallback((eventTarget: EventTarget | null) => ({
    ...getShortcutContext(eventTarget),
    composerFocus:
      eventTarget instanceof Element &&
      eventTarget.closest('[data-testid="queued-run-composer-editor"]') !== null,
  }));

  const handleSave = useStableCallback(
    async (
      event?: { preventDefault: () => void },
      dispatchMode: ComposerDispatchMode = "auto",
      submissionIntent: ComposerSubmissionIntent = "foreground",
    ) => {
      event?.preventDefault();
      if (isSaving || !canOperateThread || environmentUnavailable !== null) return;
      const sendCtx = inlineComposerRef.current?.getSendContext();
      if (!sendCtx) return;
      if (parseSideChatCommand(sendCtx.prompt)) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: resolveMessage(msg("Queued message not updated")),
            description: resolveMessage(
              msg("A queued message can't move to a side chat. Remove /side or /btw to save it."),
            ),
          }),
        );
        return;
      }
      const replyTo =
        useComposerDraftStore.getState().getComposerDraft(draftTarget)?.replyTo ?? null;
      const promptForSave = withReplyReference(sendCtx.prompt, replyTo);
      await onSaveEdit(
        {
          prompt: promptForSave,
          images: sendCtx.images,
          files: sendCtx.files,
          terminalContexts: sendCtx.terminalContexts,
          reviewComments: sendCtx.reviewComments,
          previewAnnotations: sendCtx.previewAnnotations,
          threadContexts: sendCtx.threadContexts,
          environmentContexts: sendCtx.environmentContexts,
          replyTo,
          modelSelection: sendCtx.selectedModelSelection,
        },
        setThreadError,
        { dispatchMode, submissionIntent },
      );
    },
  );

  const handleWrapperKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing &&
      !(inlineComposerRef.current?.isModelPickerOpen() ?? false)
    ) {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-slot="popover-popup"], [data-slot="menu-popup"]')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onCancelEdit();
    }
  };

  return (
    <div
      ref={containerRef}
      data-slot="queued-inline-composer"
      data-editing-run-id={runId}
      className="w-full"
      onKeyDown={handleWrapperKeyDown}
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host inert={isSaving} aria-busy={isSaving}>
          <div className="relative z-10">
            <ChatComposer
              editorTestId="queued-run-composer-editor"
              canOperateThread={canOperateThread}
              reportedModelSelection={null}
              contextImplication={contextImplication}
              multipleModelSelections={null}
              supportsMultipleModels={false}
              onMultipleModelSelectionsChange={noop}
              composerRef={inlineComposerRef}
              composerDraftTarget={draftTarget}
              environmentId={environmentId}
              attachmentUploadsCapabilityKnown={attachmentUploadsCapabilityKnown}
              supportsAttachmentUploads={supportsAttachmentUploads}
              supportsQuestionAttachments={false}
              maxFileAttachmentBytes={maxFileAttachmentBytes}
              routeKind="server"
              routeThreadRef={routeThreadRef}
              draftId={null}
              activeThreadId={activeThread?.id ?? routeThreadRef.threadId}
              activeThread={activeThread}
              activeThreadRuns={activeThreadRuns}
              promptHistoryEntries={promptHistoryEntries}
              forceExpandedOnMobile
              projectSelectionRequired={false}
              phase={phase}
              canSteer={canSteer}
              canInterrupt={false}
              isSendBusy={isSaving}
              canResume={false}
              isRevertingCheckpoint={false}
              sendDisabledReason={
                !canOperateThread ? gt("This connection cannot change threads.") : null
              }
              isPreparingWorktree={false}
              bannerItems={EMPTY_COMPOSER_BANNER_ITEMS}
              resumeCompactionTokens={null}
              keepFullHistory={false}
              onToggleKeepFullHistory={noop}
              sideChatAvailable={false}
              sideChatDisabledReason={null}
              environmentUnavailable={environmentUnavailable}
              activePendingApproval={null}
              pendingApprovals={EMPTY_PENDING_APPROVALS}
              onHeldRequestIdsChange={noop}
              pendingUserInputs={EMPTY_PENDING_USER_INPUTS}
              activePendingIsResponding={false}
              respondingRequestIds={EMPTY_RESPONDING_REQUEST_IDS}
              runtimeMode={activeThread?.runtimeMode ?? "approval-required"}
              defaultRuntimeMode={activeThread?.runtimeMode ?? "approval-required"}
              lockedProvider={lockedProvider}
              providerStatuses={providerStatuses as ServerProvider[]}
              providerCatalogKnown={providerCatalogKnown}
              activeProjectDefaultModelSelection={activeProjectDefaultModelSelection}
              activeThreadModelSelection={activeThread?.modelSelection}
              activeProjectId={activeProjectId}
              projectName={activeProjectName}
              compactThreadUnavailable
              compactDisabled
              resolvedTheme={resolvedTheme}
              settings={settings}
              keybindings={keybindings}
              getShortcutContext={getInlineShortcutContext}
              terminalOpen={false}
              gitCwd={gitCwd}
              pullRequestProjectId={pullRequestProjectId}
              pullRequestRepository={pullRequestRepository}
              threadPullRequests={threadPullRequests}
              onComposerOverlayHeightChange={noop}
              permissionsShownInStrip={false}
              promptRef={inlinePromptRef}
              composerImagesRef={inlineImagesRef}
              composerFilesRef={inlineFilesRef}
              composerTerminalContextsRef={inlineTerminalContextsRef}
              onPageScrollKeyDown={noop}
              onPageScrollKeyUp={noop}
              onPageScrollRelease={noop}
              onCompactContext={noop}
              onSend={handleSave}
              onResume={noop}
              onInterrupt={noop}
              onSelectActivePendingUserInputOption={noop}
              onAdvanceActivePendingUserInput={noop}
              onDismissActivePendingUserInput={noop}
              onPreviousActivePendingUserInputQuestion={noop}
              onChangeActivePendingUserInputCustomAnswer={noop}
              onProviderModelSelect={onProviderModelSelectStable}
              onOpenProviderSetup={openProviderSetupStable}
              getModelDisabledReason={getModelDisabledReason}
              handleRuntimeModeChange={noop}
              focusComposer={focusInlineComposer}
              scheduleComposerFocus={scheduleInlineComposerFocus}
              setThreadError={setThreadError}
              onExpandImage={onExpandImage}
              onFileOpen={onFileOpen}
              editingQueuedAttachments={editingAttachments ?? []}
              removedEditingQueuedAttachments={removedEditingAttachments}
              isPausedOnEditingQueuedMessage={isPausedOnEditing}
              onCancelQueuedEdit={onCancelEdit}
              onRemoveEditingQueuedAttachment={onRemoveAttachment}
              onRestoreEditingQueuedAttachment={onRestoreAttachment}
            />
          </div>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
