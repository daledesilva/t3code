import {
  ANTIGRAVITY_DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { msg, useMessages } from "gt-react";
import { memo } from "react";

import { m, type MessageResolver } from "~/i18n/messages";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { deriveProviderInstanceEntries, shouldShowInstanceBadge } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { describeComposerEffort } from "./ComposerModelEffort";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  getDisplayModelName,
  getTriggerDisplayModelName,
  type ModelEsque,
} from "./providerIconUtils";
import { readPromptUltrathink } from "./TraitsPicker";

function inferDriverKindFromInstanceId(
  instanceId: ProviderInstanceId,
): ProviderDriverKind | undefined {
  return Object.hasOwn(DEFAULT_MODEL_BY_PROVIDER, instanceId)
    ? (instanceId as unknown as ProviderDriverKind)
    : undefined;
}

export function resolveModelTriggerLabel(input: {
  readonly driverKind: ProviderDriverKind | undefined;
  readonly model: string;
  readonly options: ReadonlyArray<ModelEsque>;
  readonly fallbackToFirstOption?: boolean;
  readonly retainedModel?: ModelEsque | undefined;
  readonly resolve?: MessageResolver;
}) {
  const resolve = input.resolve ?? m;
  const normalizedModel =
    (input.driverKind
      ? resolveSelectableModel(
          input.driverKind,
          input.model,
          input.options as ReadonlyArray<ServerProvider["models"][number]>,
        )
      : null) ?? input.model;
  const selectedModel =
    resolveModelPickerSelectedModel({
      driverKind: input.driverKind,
      model: normalizedModel,
      options: input.options,
    }) ??
    resolveModelPickerSelectedModel({
      driverKind: input.driverKind,
      model: input.model,
      options: input.options,
    }) ??
    input.retainedModel ??
    (input.fallbackToFirstOption &&
    input.driverKind !== "opencode" &&
    input.driverKind !== "antigravity"
      ? input.options[0]
      : undefined);
  const fallbackModelEsque: ModelEsque | undefined =
    !selectedModel &&
    !input.fallbackToFirstOption &&
    normalizedModel &&
    normalizedModel !== ANTIGRAVITY_DEFAULT_MODEL
      ? { slug: normalizedModel, name: formatModelSlugName(normalizedModel) }
      : undefined;
  const effectiveModel = selectedModel ?? fallbackModelEsque;
  const triggerTitle = effectiveModel
    ? getTriggerDisplayModelName(effectiveModel, input.driverKind)
    : input.model === ANTIGRAVITY_DEFAULT_MODEL
      ? resolve(msg("Choose model"))
      : input.model || resolve(msg("Choose model"));
  const triggerLabel = effectiveModel
    ? effectiveModel.isUnavailable
      ? resolve(msg("{model} (Unavailable)", { model: getDisplayModelName(effectiveModel) }))
      : getDisplayModelName(effectiveModel)
    : triggerTitle;
  return {
    normalizedModel,
    selectedModel,
    triggerTitle,
    triggerLabel,
  };
}

export function formatModelSelectionTriggerLabel(
  modelSelection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  resolve?: MessageResolver,
): string {
  const provider = providers.find((entry) => entry.instanceId === modelSelection.instanceId);
  const driverKind = provider?.driver ?? inferDriverKindFromInstanceId(modelSelection.instanceId);
  return resolveModelTriggerLabel({
    driverKind,
    model: modelSelection.model,
    options: provider?.models ?? [],
    ...(resolve ? { resolve } : {}),
  }).triggerTitle;
}

export const TimelineRunModelChip = memo(function TimelineRunModelChip(props: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly modelSelection: ModelSelection;
  readonly providers?: ReadonlyArray<ServerProvider> | undefined;
  readonly prompt?: string | undefined;
  readonly variant?: "inline" | "badge" | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}) {
  const settings = usePrimarySettings();
  const resolve = useMessages();
  const environmentProviders = useAtomValue(
    serverEnvironment.providersValueAtom(props.environmentId),
  );
  const providers = props.providers ?? environmentProviders ?? EMPTY_SERVER_PROVIDERS;
  const instanceId = props.providerInstanceId ?? props.modelSelection.instanceId;
  const instanceEntries = deriveProviderInstanceEntries(providers);
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === instanceId) ?? null;
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  const driverKind =
    activeEntry?.driverKind ?? provider?.driver ?? inferDriverKindFromInstanceId(instanceId);
  const models = provider?.models ?? [];
  const { normalizedModel, triggerTitle, triggerLabel } = resolveModelTriggerLabel({
    driverKind,
    model: props.modelSelection.model,
    options: models,
    resolve,
  });
  const showInstanceBadge =
    activeEntry !== null && shouldShowInstanceBadge(activeEntry, instanceEntries);
  const effort = driverKind
    ? describeComposerEffort(
        {
          provider: driverKind,
          instanceId,
          models,
          model: normalizedModel,
          promptUltrathink: props.prompt ? readPromptUltrathink(props.prompt) : "none",
          modelOptions: props.modelSelection.options,
          allowPromptInjectedEffort: props.prompt !== undefined,
          includePlanAgent: true,
        },
        settings.effortDisplay,
        "xs",
      )
    : { suffix: null, detail: null };
  const tooltipLabel = [triggerLabel, effort.detail].filter(Boolean).join(" · ");
  const isBadge = props.variant === "badge";

  const chip = (
    <span
      data-testid={props.testId ?? "timeline-run-model-chip"}
      aria-label={tooltipLabel || undefined}
      className={cn(
        isBadge
          ? "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/70 bg-muted/50 px-1.5 py-0.5 text-2xs font-medium leading-none text-foreground/80"
          : "inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        props.className,
      )}
    >
      {driverKind ? (
        <ProviderInstanceIcon
          driverKind={driverKind}
          displayName={activeEntry?.displayName ?? driverKind}
          accentColor={activeEntry?.accentColor}
          acpRegistryAgentId={activeEntry?.acpRegistryAgentId}
          acpRegistryIconUrl={activeEntry?.acpRegistryIconUrl}
          showBadge={showInstanceBadge}
          size="compact"
          {...(isBadge ? {} : { className: "size-3.5" })}
          iconClassName={isBadge ? "size-3" : "size-3.5 text-muted-foreground"}
          indicatorBackground={isBadge ? "var(--muted)" : "var(--background)"}
        />
      ) : null}
      <span className="truncate">{triggerTitle}</span>
      {effort.suffix}
    </span>
  );

  if (isBadge && tooltipLabel) {
    return <SharedTooltipTrigger render={chip} label={tooltipLabel} />;
  }

  return chip;
});
