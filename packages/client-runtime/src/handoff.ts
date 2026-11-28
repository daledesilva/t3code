import type {
  ModelSelection,
  OrchestrationV2ModelSwitch,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { isReasoningSelect } from "./modelTraits.ts";
import type { ThreadStructure } from "./state/models.ts";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export type HandoffEndpoints = ReturnType<typeof resolveHandoffEndpoints>;

const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

function isCrossProviderHandoff(
  fromInstanceId: ProviderInstanceId,
  toInstanceId: ProviderInstanceId,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  if (fromInstanceId === toInstanceId) return false;
  const source = providers.find((provider) => provider.instanceId === fromInstanceId);
  const target = providers.find((provider) => provider.instanceId === toInstanceId);
  return (
    source?.continuation?.groupKey === undefined ||
    source.driver !== target?.driver ||
    source.continuation.groupKey !== target.continuation?.groupKey
  );
}

function orderedUserQueuedRuns(
  projection: Pick<ThreadStructure, "runs"> & {
    readonly messages?: ThreadStructure["messages"];
  },
): ReadonlyArray<OrchestrationV2Run> {
  const automaticMessageIds = new Set(
    (projection.messages ?? [])
      .filter(
        (message) =>
          message.delegatedCompletion !== undefined || message.notification !== undefined,
      )
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued" && !automaticMessageIds.has(run.userMessageId))
    .sort(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );
}

function collectVisitedProviderInstances(
  projection: Pick<ThreadStructure, "runs" | "providerThreads">,
): Set<ProviderInstanceId> {
  const visited = new Set<ProviderInstanceId>();
  for (const providerThread of projection.providerThreads ?? []) {
    if (providerThread.nativeThreadRef !== null) {
      visited.add(providerThread.providerInstanceId);
    }
  }
  for (const run of projection.runs) {
    if (
      run.status !== "rolled_back" &&
      run.status !== "queued" &&
      (run.startedAt !== null || ACTIVE_RUN_STATUSES.has(run.status))
    ) {
      visited.add(run.providerInstanceId);
    }
  }
  return visited;
}

export function resolvePendingHandoff(
  projection:
    | (Pick<ThreadStructure, "runs" | "visibleTurnItems"> & {
        readonly messages?: ThreadStructure["messages"];
      })
    | null
    | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
  options?: { readonly afterQueue?: boolean },
): HandoffEndpoints | null {
  // A thread with an empty timeline has nothing to hand off. Any loaded row
  // counts: paging can leave a window of only tool rows.
  if (!projection?.visibleTurnItems.length) return null;
  const queuedTail = options?.afterQueue
    ? orderedUserQueuedRuns(projection).at(-1)?.modelSelection
    : undefined;
  // The handoff row is committed before the provider starts. Use its destination
  // during startup so the footer does not duplicate the committed handoff.
  const from =
    queuedTail ??
    projection.runs.findLast(
      (run) =>
        run.status !== "rolled_back" &&
        (run.startedAt !== null || (run.status === "starting" && run.contextHandoffId !== null)),
    )?.modelSelection;
  if (from === undefined || selection == null) return null;
  return isCrossProviderHandoff(from.instanceId, selection.instanceId, providers)
    ? { from: [from], to: selection }
    : null;
}

/**
 * Resolves any context implication (full handoff, delta handoff, or fresh session) that the
 * composer's current selection will trigger when sent, or when saving an edited queued prompt.
 */
export function resolveComposerContextImplication(
  projection:
    | (Pick<ThreadStructure, "thread" | "runs" | "providerThreads" | "visibleTurnItems"> & {
        readonly messages?: ThreadStructure["messages"];
      })
    | null
    | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
  options?: {
    readonly editingRunId?: RunId | null;
    readonly freshSessionPending?: boolean;
  },
): QueuedRunContextImplication | null {
  if (!projection?.visibleTurnItems.length || selection == null) return null;
  const activeRun = projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const lastExecutedRun = projection.runs.findLast(
    (run) =>
      run.status !== "rolled_back" &&
      (run.startedAt !== null || (run.status === "starting" && run.contextHandoffId !== null)),
  );
  let previous: ModelSelection | undefined =
    activeRun?.modelSelection ??
    lastExecutedRun?.modelSelection ??
    projection.thread?.modelSelection;
  const visitedProviderInstances = collectVisitedProviderInstances(projection);
  const queuedRuns = orderedUserQueuedRuns(projection);

  let editedRunFreshContext = false;
  if (options?.editingRunId != null) {
    for (const queuedRun of queuedRuns) {
      if (queuedRun.id === options.editingRunId) {
        editedRunFreshContext = queuedRun.freshContext === true;
        break;
      }
      previous = queuedRun.modelSelection;
      visitedProviderInstances.add(queuedRun.providerInstanceId);
    }
  } else {
    for (const queuedRun of queuedRuns) {
      previous = queuedRun.modelSelection;
      visitedProviderInstances.add(queuedRun.providerInstanceId);
    }
  }

  if (previous === undefined) return null;
  if (editedRunFreshContext || (options?.editingRunId == null && options?.freshSessionPending)) {
    return { kind: "fresh_session", from: previous, to: selection };
  }
  if (!isCrossProviderHandoff(previous.instanceId, selection.instanceId, providers)) {
    return null;
  }
  return {
    kind: visitedProviderInstances.has(selection.instanceId) ? "delta_handoff" : "full_handoff",
    from: previous,
    to: selection,
  };
}

export type QueuedRunContextImplicationKind = "full_handoff" | "delta_handoff" | "fresh_session";

export interface QueuedRunContextImplication {
  readonly kind: QueuedRunContextImplicationKind;
  readonly from: ModelSelection;
  readonly to: ModelSelection;
}

export interface QueuedRunSelectionDiff {
  readonly from: ModelSelection;
  readonly to: ModelSelection;
  readonly providerChanged: boolean;
  readonly modelChanged: boolean;
  readonly effortLabel: string | null;
  readonly speedLabel: string | null;
  readonly contextImplication: QueuedRunContextImplication | null;
}

/**
 * Resolves the minimal per-item model/provider diff and any context implication for each queued
 * run in delivery order, comparing item `i` against the preceding effective selection (the active
 * or latest executed run for `i = 0`, and item `i - 1` thereafter).
 */
export function resolveQueuedRunSelectionDiffs(
  projection: Pick<ThreadStructure, "thread" | "runs" | "providerThreads"> | null | undefined,
  queuedRuns: ReadonlyArray<{
    readonly run: Partial<Pick<OrchestrationV2Run, "modelSelection" | "freshContext">>;
  }>,
  providers: ReadonlyArray<ServerProvider>,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<QueuedRunSelectionDiff | null> {
  if (!projection || queuedRuns.length === 0) {
    return queuedRuns.map(() => null);
  }
  const activeRun = projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const lastExecutedRun = projection.runs.findLast(
    (run) =>
      run.status !== "rolled_back" &&
      (run.startedAt !== null || (run.status === "starting" && run.contextHandoffId !== null)),
  );
  let previous: ModelSelection | undefined =
    activeRun?.modelSelection ??
    lastExecutedRun?.modelSelection ??
    projection.thread?.modelSelection;

  const visitedProviderInstances = collectVisitedProviderInstances(projection);

  const modelsOf = (selection: ModelSelection) =>
    providers.find((provider) => provider.instanceId === selection.instanceId)?.models;

  return queuedRuns.map(({ run }) => {
    const current = run.modelSelection;
    if (current === undefined || previous === undefined) {
      if (current !== undefined) {
        previous = current;
        visitedProviderInstances.add(current.instanceId);
      }
      return null;
    }

    const from = previous;
    const providerChanged = from.instanceId !== current.instanceId;
    const modelChanged = !sameModelIdentity(from, current, providers);

    const fromModels = modelsOf(from);
    const toModels = modelsOf(current);
    const fromEffort = resolveEffort(from, fromModels);
    const toEffort = resolveEffort(current, toModels);
    const effortChanged =
      toEffort !== undefined &&
      (fromEffort !== undefined
        ? fromEffort.value !== toEffort.value
        : isExplicitNonDefaultEffort(current, toModels));

    const fromSpeed = resolveSpeed(from, fromModels, resolve);
    const toSpeed = resolveSpeed(current, toModels, resolve);
    const speedChanged =
      toSpeed !== undefined && fromSpeed !== undefined && fromSpeed.value !== toSpeed.value;

    const freshSession = run.freshContext === true;
    const needsHandoff =
      !freshSession && isCrossProviderHandoff(from.instanceId, current.instanceId, providers);
    const contextImplication: QueuedRunContextImplication | null = freshSession
      ? { kind: "fresh_session", from, to: current }
      : needsHandoff
        ? {
            kind: visitedProviderInstances.has(current.instanceId)
              ? "delta_handoff"
              : "full_handoff",
            from,
            to: current,
          }
        : null;

    previous = current;
    visitedProviderInstances.add(current.instanceId);

    if (
      !providerChanged &&
      !modelChanged &&
      !effortChanged &&
      !speedChanged &&
      contextImplication === null
    ) {
      return null;
    }

    return {
      from,
      to: current,
      providerChanged,
      modelChanged,
      effortLabel: effortChanged ? (toEffort?.label ?? null) : null,
      speedLabel: speedChanged ? (toSpeed?.label ?? null) : null,
      contextImplication,
    };
  });
}

function bareModelSlug(slug: string): string {
  const slashIndex = slug.lastIndexOf("/");
  return (slashIndex >= 0 ? slug.slice(slashIndex + 1) : slug).trim().toLowerCase();
}

function sameModelIdentity(
  from: ModelSelection,
  to: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  if (from.model === to.model) return true;
  if (from.instanceId === to.instanceId) return false;
  if (bareModelSlug(from.model) === bareModelSlug(to.model)) return true;
  const fromModel = providers
    .find((provider) => provider.instanceId === from.instanceId)
    ?.models.find((candidate) => candidate.slug === from.model);
  const toModel = providers
    .find((provider) => provider.instanceId === to.instanceId)
    ?.models.find((candidate) => candidate.slug === to.model);
  if (fromModel !== undefined && toModel !== undefined) {
    return fromModel.name.trim().toLowerCase() === toModel.name.trim().toLowerCase();
  }
  return false;
}

function isExplicitNonDefaultEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): boolean {
  const model = models?.find((candidate) => candidate.slug === selection.model);
  const descriptor = model?.capabilities?.optionDescriptors?.find(isReasoningSelect);
  if (descriptor === undefined) return false;
  const explicit = getModelSelectionStringOptionValue(selection, descriptor.id);
  if (explicit === undefined) return false;
  const defaultOption = descriptor.options.find((option) => option.isDefault);
  return defaultOption === undefined ? true : explicit !== defaultOption.id;
}

function resolveSpeed(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> | undefined,
  resolve: MFunctionType,
): { readonly value: string; readonly label: string } | undefined {
  const model = models?.find((candidate) => candidate.slug === selection.model);
  const descriptors = model?.capabilities?.optionDescriptors;
  if (!descriptors) return undefined;
  const fastMode = descriptors.find(
    (descriptor): descriptor is Extract<typeof descriptor, { type: "boolean" }> =>
      descriptor.id === "fastMode" && descriptor.type === "boolean",
  );
  if (fastMode) {
    const enabled = getProviderOptionCurrentValue(fastMode, selection) === true;
    const normalLabel = resolve(msg("Normal", { $context: "model speed tier" }));
    return enabled
      ? { value: "fast", label: fastMode.label }
      : { value: "normal", label: normalLabel };
  }
  const serviceTier = descriptors.find(
    (descriptor): descriptor is Extract<typeof descriptor, { type: "select" }> =>
      descriptor.id === "serviceTier" && descriptor.type === "select",
  );
  if (serviceTier) {
    const value =
      getModelSelectionStringOptionValue(selection, "serviceTier") ??
      getProviderOptionCurrentValue(serviceTier, selection);
    if (typeof value !== "string") return undefined;
    const label =
      serviceTier.options.find((option) => option.id === value)?.label ??
      (value === "default" ? resolve(msg("Normal", { $context: "model speed tier" })) : value);
    return { value, label };
  }
  return undefined;
}

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}

function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

export interface ModelSwitchChange {
  readonly modelChanged: boolean;
  /** Effort labels, set only when the effort changed. */
  readonly effort: { readonly from: string; readonly to: string } | null;
}

/**
 * What a recorded model switch visibly changed, or null when it changed neither the model nor the
 * effort. The composer omits an untouched effort, so an unset effort reads as the model's default.
 */
export function resolveModelSwitchChange(
  { from, to }: OrchestrationV2ModelSwitch,
  providers: ReadonlyArray<ServerProvider>,
): ModelSwitchChange | null {
  const modelsOf = (selection: ModelSelection) =>
    providers.find((provider) => provider.instanceId === selection.instanceId)?.models;
  const fromEffort = resolveEffort(from, modelsOf(from));
  const toEffort = resolveEffort(to, modelsOf(to));
  const modelChanged = from.model !== to.model;
  const effort =
    fromEffort && toEffort && fromEffort.value !== toEffort.value
      ? { from: fromEffort.label, to: toEffort.label }
      : null;
  return modelChanged || effort ? { modelChanged, effort } : null;
}

/** The composer's reasoning control for the model; stated values only when the catalog lacks it. */
function resolveEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): { readonly value: string; readonly label: string } | undefined {
  const model = models?.find((candidate) => candidate.slug === selection.model);
  if (model === undefined) {
    // Pi states its effort as `thinking`; the catalog would otherwise mark it a reasoning control.
    const value = [...REASONING_EFFORT_OPTION_IDS, "thinking"]
      .map((id) => getModelSelectionStringOptionValue(selection, id))
      .find((candidate) => candidate !== undefined);
    return value === undefined ? undefined : { value, label: value };
  }
  const descriptor = model.capabilities?.optionDescriptors?.find(isReasoningSelect);
  if (descriptor === undefined) return undefined;
  const value =
    getModelSelectionStringOptionValue(selection, descriptor.id) ??
    getProviderOptionCurrentValue(descriptor, selection);
  if (typeof value !== "string") return undefined;
  return { value, label: descriptor.options.find((option) => option.id === value)?.label ?? value };
}
