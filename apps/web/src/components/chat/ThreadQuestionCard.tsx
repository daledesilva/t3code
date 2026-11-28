import type {
  EnvironmentId,
  RuntimeRequestId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { memo } from "react";
import type { PendingUserInput } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { usePendingUserInputDraft } from "./usePendingThreadRequests";

/** Owns the answer drafts subscription so typing an answer does not re-render the chat view. */
export const ThreadQuestionCard = memo(function ThreadQuestionCard(props: {
  environmentId: EnvironmentId;
  activeThreadId: ThreadId | null;
  supportsQuestionAttachments: boolean;
  pendingUserInputs: PendingUserInput[];
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isResponding: boolean;
  respondingRequestIds: RuntimeRequestId[];
  onToggleOption: (questionId: string, optionValue: string) => void;
  onChangeCustomAnswer: (questionId: string, value: string) => void;
  onAdvance: () => void;
  onPrevious: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  submitOnKeyDown: (event: KeyboardEvent) => boolean;
}) {
  const { pendingUserInputs, isResponding, respondingRequestIds } = props;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const { activePendingDraftAnswers, activePendingQuestionIndex } = usePendingUserInputDraft({
    environmentId: props.environmentId,
    activeThreadId: props.activeThreadId,
    activePendingUserInput,
    supportsQuestionAttachments: props.supportsQuestionAttachments,
  });
  return (
    <div className="chat-content-lane mb-3">
      <ComposerBanner.Root detached data-thread-question-card="true" variant="info">
        <ComposerPendingUserInputPanel
          pendingUserInputs={pendingUserInputs}
          cwd={props.cwd}
          threadRef={props.threadRef}
          disabled={props.disabled}
          respondingRequestIds={
            isResponding && activePendingUserInput
              ? [...respondingRequestIds, activePendingUserInput.requestId]
              : respondingRequestIds
          }
          answers={activePendingDraftAnswers}
          questionIndex={activePendingQuestionIndex}
          onToggleOption={props.onToggleOption}
          onChangeCustomAnswer={props.onChangeCustomAnswer}
          onAdvance={props.onAdvance}
          onPrevious={props.onPrevious}
          onDismiss={props.onDismiss}
          submitOnKeyDown={props.submitOnKeyDown}
        />
      </ComposerBanner.Root>
    </div>
  );
});
