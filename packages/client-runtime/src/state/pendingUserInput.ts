/** The question fields answer handling reads. Web and mobile question types both fit it. */
export interface PendingUserInputQuestion {
  readonly id: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly value?: string | undefined }>;
  readonly multiSelect?: boolean | undefined;
  readonly allowCustomAnswer?: boolean | undefined;
  readonly initialAnswer?: string | undefined;
  readonly required?: boolean | undefined;
}

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionValues?: ReadonlyArray<string>;
  readonly customAnswer?: string;
  /** Text kept in the Other field after an offered option is selected. */
  readonly retainedCustomAnswer?: string;
  readonly attachmentCount?: number;
  readonly attachmentsBlocked?: boolean;
}

export type PendingUserInputAnswer = string | ReadonlyArray<string>;

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Provider option values stay exact, including whitespace. Only options without a value match by label.
function resolvePendingUserInputOptionValue(
  question: PendingUserInputQuestion,
  value: string,
): string | null {
  if (question.options.some((option) => option.value === value)) {
    return value;
  }

  const label = value.trim();
  return label.length > 0 &&
    question.options.some((option) => option.value === undefined && option.label.trim() === label)
    ? label
    : null;
}

/** The draft's selections that name an offered option, deduplicated, in selection order. */
export function normalizeSelectedOptionValues(
  question: PendingUserInputQuestion,
  value: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => resolvePendingUserInputOptionValue(question, entry))
        .filter((entry): entry is string => entry !== null),
    ),
  );
}

/** The answer to submit for one question, or null while it is unanswered. */
export function resolvePendingUserInputAnswer(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): PendingUserInputAnswer | null {
  if (draft?.attachmentsBlocked) return null;
  const customAnswer =
    question.allowCustomAnswer === false
      ? null
      : question.initialAnswer !== undefined
        ? (draft?.customAnswer ?? null)
        : normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer !== null && customAnswer.length > 0) {
    return customAnswer;
  }
  if (question.required === false && question.options.length === 0) {
    return "";
  }

  const selectedOptionValues = normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  const fallback =
    customAnswer ??
    (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null);
  if (question.multiSelect) {
    // Checking nothing answers "none of these" unless the provider requires a choice.
    return selectedOptionValues.length > 0
      ? selectedOptionValues
      : (fallback ?? (question.required ? null : []));
  }
  return selectedOptionValues[0] ?? fallback;
}

export function setPendingUserInputCustomAnswer(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionValues =
    question.initialAnswer !== undefined || customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  return {
    customAnswer,
    ...(customAnswer.trim().length > 0 ? { retainedCustomAnswer: customAnswer } : {}),
    ...(selectedOptionValues && selectedOptionValues.length > 0 ? { selectedOptionValues } : {}),
  };
}

export function isPendingUserInputOptionSelected(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): boolean {
  if (question.allowCustomAnswer !== false && normalizeDraftAnswer(draft?.customAnswer)) {
    return false;
  }

  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  return (
    resolvedOptionValue !== null &&
    normalizeSelectedOptionValues(question, draft?.selectedOptionValues).includes(
      resolvedOptionValue,
    )
  );
}

/** Toggles an offered option. An unknown option returns the same draft. */
export function togglePendingUserInputOptionSelection(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): PendingUserInputDraftAnswer {
  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  if (resolvedOptionValue === null) {
    return draft ?? {};
  }

  const retainedCustomAnswer = retainedOtherText(draft);
  if (question.multiSelect) {
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues,
    );
    const nextSelectedOptionValues = selectedOptionValues.includes(resolvedOptionValue)
      ? selectedOptionValues.filter((value) => value !== resolvedOptionValue)
      : [...selectedOptionValues, resolvedOptionValue];

    return {
      customAnswer: "",
      ...(retainedCustomAnswer === undefined ? {} : { retainedCustomAnswer }),
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  return {
    customAnswer: "",
    ...(retainedCustomAnswer === undefined ? {} : { retainedCustomAnswer }),
    selectedOptionValues: [resolvedOptionValue],
  };
}

function retainedOtherText(draft: PendingUserInputDraftAnswer | undefined): string | undefined {
  if (normalizeDraftAnswer(draft?.customAnswer) !== null) return draft?.customAnswer;
  return normalizeDraftAnswer(draft?.retainedCustomAnswer) === null
    ? undefined
    : draft?.retainedCustomAnswer;
}

/**
 * The answers to submit keyed by question id, or null while a question still needs one.
 * An optional single choice left unselected is skipped: it gets no entry.
 */
export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<PendingUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, PendingUserInputAnswer> | null {
  const entries: Array<[string, PendingUserInputAnswer]> = [];

  for (const question of questions) {
    const draft = draftAnswers[question.id];
    const answer = resolvePendingUserInputAnswer(question, draft);
    if (answer === null) {
      if (question.required === false && !draft?.attachmentsBlocked) continue;
      return null;
    }
    entries.push([question.id, answer]);
  }

  return Object.fromEntries(entries);
}

/** The Other text that should be sent instead of an offered option, if the user is answering that way. */
export function activeCustomQuestionAnswer(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | null {
  const custom = normalizeDraftAnswer(draft?.customAnswer);
  if (custom === null) return null;
  if (
    question.allowCustomAnswer === false &&
    normalizeSelectedOptionValues(question, draft?.selectedOptionValues).length > 0
  ) {
    return null;
  }
  return custom;
}

export function questionHasSubmittableAnswer(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): boolean {
  if (draft?.attachmentsBlocked) return false;
  if (resolvePendingUserInputAnswer(question, draft) !== null) return true;
  if (question.required === false) return true;
  return activeCustomQuestionAnswer(question, draft) !== null;
}

export function questionSetUsesCustomAnswer(
  questions: ReadonlyArray<PendingUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): boolean {
  return questions.some(
    (question) => activeCustomQuestionAnswer(question, draftAnswers[question.id]) !== null,
  );
}

function optionAnswerLabel(question: PendingUserInputQuestion, value: string): string {
  const option = question.options.find((entry) => (entry.value ?? entry.label) === value);
  return option?.label ?? value;
}

/** Question and answer pairs for a follow-up message, or null while any question is unanswered. */
export function formatQueuedQuestionAnswers(
  questions: ReadonlyArray<PendingUserInputQuestion & { readonly question: string }>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): string | null {
  const parts: string[] = [];
  for (const question of questions) {
    const draft = draftAnswers[question.id];
    const custom = activeCustomQuestionAnswer(question, draft);
    const resolved = custom ?? resolvePendingUserInputAnswer(question, draft);
    if (resolved === null) {
      if (question.required === false && !draft?.attachmentsBlocked) continue;
      return null;
    }
    if (resolved === "") {
      parts.push(question.question);
      continue;
    }
    const labels = typeof resolved === "string" ? [resolved] : resolved;
    const answer = custom ?? labels.map((value) => optionAnswerLabel(question, value)).join(", ");
    parts.push(`${question.question}\n${answer}`);
  }
  return parts.join("\n\n");
}

/** The unanswered question a steer or model handoff must carry, or null when there is nothing to carry. */
export function unansweredQuestionTakeoverText(
  questions: ReadonlyArray<{
    readonly header?: string | undefined;
    readonly question: string;
    readonly options: ReadonlyArray<{
      readonly label: string;
      readonly description?: string | undefined;
    }>;
  }>,
): string | null {
  if (questions.length === 0) return null;
  const body = questions
    .map((question) => {
      const options = question.options
        .map((option) =>
          option.description && option.description !== option.label
            ? `- ${option.label}: ${option.description}`
            : `- ${option.label}`,
        )
        .join("\n");
      return [question.header, question.question, options]
        .filter((line) => (line ?? "").length > 0)
        .join("\n");
    })
    .join("\n\n");
  // oxlint-disable-next-line t3code/no-untranslated-copy -- message sent to the agent
  return `The assistant asked a question that was not answered. This message takes over that turn.\n\n${body}`;
}

/** Text still shown in Other after an offered option takes over the answer. */
export function visibleOtherAnswer(draft: PendingUserInputDraftAnswer | undefined): string {
  if ((draft?.customAnswer ?? "").length > 0) return draft?.customAnswer ?? "";
  return draft?.retainedCustomAnswer ?? "";
}
