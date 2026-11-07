import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { CircleAlertIcon } from "lucide-react";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl } from "./ComposerControl";
import {
  ComposerFooterModeControls,
  ComposerModelPicker,
  type RuntimeModeOption,
} from "./ComposerFooterControls";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { useEnvironmentModelPreferences } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { getProviderModelCapabilities } from "../../providerModels";
import { resolveComposerTraitsInput, withImplicitFastModeDefault } from "./composerProviderState";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "./ComposerModelEffort";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName, getTriggerDisplayModelName } from "./providerIconUtils";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { resolveComposerControlsOwnership } from "./composerControlsOwnership";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The composer footer controls: the model picker (which also holds effort, speed and
 * permissions), mode controls and the overflow menu for blocks that do not fit. Rendered in the
 * expanded footer or the resting controls host.
 */
// Model and effort share one trigger; it stays filled while its popup is open.
const MODEL_TRIGGER_STATES = "data-popup-open:bg-accent data-popup-open:text-foreground";
const PINNED_MODEL_STATES = "aria-pressed:bg-accent aria-pressed:text-foreground";

export function ComposerControlsBar(props: {
  environmentId: EnvironmentId;
  routeKind: ChatComposerProps["routeKind"];
  routeThreadRef: ChatComposerProps["routeThreadRef"];
  draftId: ChatComposerProps["draftId"];
  selectedProvider: ProviderDriverKind;
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedProviderModels: ServerProvider["models"];
  composerModelOptions: ReturnType<typeof useComposerProviderModel>["composerModelOptions"];
  reportedModelSelection: ChatComposerProps["reportedModelSelection"];
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  planModeEnabled: boolean;
  planModeUiEnabled: boolean;
  effortDisplay: EffortDisplay;
  /** The strip under a new thread names the permissions, so the row does not repeat them. */
  permissionsShownInStrip: boolean;
  interactionMode: ProviderInteractionMode;
  compatibleRuntimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode | undefined;
  compatibleRuntimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  composerControlsCollapsed: boolean;
  composerControlsHidden: boolean;
  restingHiddenBlockCount: number;
  iconOnlyBlockCount: number;
  showProviderUnavailable: boolean;
  providerSetupInstanceId: ProviderInstanceId | undefined;
  onOpenProviderSetup: ChatComposerProps["onOpenProviderSetup"];
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  multipleModelsEnabled: boolean;
  multipleModelSelections: ChatComposerProps["multipleModelSelections"];
  onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
  selectedModelSelection: ModelSelection;
  onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  activeThreadModelSelection: ChatComposerProps["activeThreadModelSelection"];
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ChatComposerProps["lockedProvider"];
  lockedContinuationGroupKey: string | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ChatComposerProps["keybindings"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  modelPickerIconClassName: string | undefined;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
}) {
  const {
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
    planModeUiEnabled,
    interactionMode,
    compatibleRuntimeMode,
    defaultRuntimeMode,
    compatibleRuntimeModeOptions,
    toggleInteractionMode,
    handleRuntimeModeChange,
    composerControlsCollapsed,
    composerControlsHidden,
    restingHiddenBlockCount: measuredHiddenBlockCount,
    iconOnlyBlockCount,
    showProviderUnavailable,
    providerSetupInstanceId,
    onOpenProviderSetup,
    providerCatalogPending,
    isSendBusy,
    multipleModelsEnabled,
    multipleModelSelections,
    onMultipleModelSelectionsChange,
    selectedModelSelection,
    onProviderModelSelect,
    activeThreadModelSelection,
    selectedModelForPickerWithCustomFallback,
    lockedProvider,
    lockedContinuationGroupKey,
    providerInstanceEntries,
    keybindings,
    modelOptionsByInstance,
    terminalOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    modelPickerIconClassName,
    getModelDisabledReason,
  } = props;
  const { pins } = useEnvironmentModelPreferences(environmentId);
  const accessMatchesDefault = compatibleRuntimeMode === defaultRuntimeMode;
  const {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: restingHiddenBlockCount,
    hiddenBlockIds: hiddenRestingBlockIds,
    overflowShowsPermissions,
    pickerOwnsModeShortcut,
  } = resolveComposerControlsOwnership({
    matchesDefault: accessMatchesDefault || props.permissionsShownInStrip,
    planModeUiEnabled,
    collapsed: composerControlsCollapsed,
    measuredHiddenBlockCount,
  });
  const controlSize = composerControlsCollapsed ? "xs" : "sm";
  const traitsInput = resolveComposerTraitsInput({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
  });
  const effort = describeComposerEffort(traitsInput, props.effortDisplay, controlSize);
  const instanceIndicatorBackground = composerControlsCollapsed
    ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
    : "var(--contrast-input)";
  const activeDescriptors = traitsInput
    ? getProviderOptionDescriptors({
        caps: getProviderModelCapabilities(
          selectedProviderModels,
          selectedModel,
          selectedProvider,
          planModeEnabled,
        ),
        selections: traitsInput.modelOptions,
      })
    : [];
  const pinnedModelButtons = pins.flatMap((pin) => {
    const entry = providerInstanceEntries.find(
      (candidate) => candidate.instanceId === pin.provider,
    );
    if (!entry) return [];
    const instanceOptions = modelOptionsByInstance.get(pin.provider) ?? [];
    const resolvedModelOption = resolveModelPickerSelectedModel({
      driverKind: entry.driverKind,
      model: pin.model,
      options: instanceOptions,
    });
    const resolvedSlug = resolvedModelOption?.slug ?? pin.model;
    const disabledReason = getModelDisabledReason(pin.provider, resolvedSlug);
    const pinCaps = getProviderModelCapabilities(
      entry.snapshot.models,
      resolvedSlug,
      entry.driverKind,
      planModeEnabled,
    );
    const pinSelections = withImplicitFastModeDefault(pinCaps, pin.options);
    const pinTraitsInput = {
      provider: entry.driverKind,
      instanceId: pin.provider,
      model: resolvedSlug,
      models: entry.snapshot.models,
      modelOptions: pinSelections,
      promptUltrathink: "none" as const,
      planModeEnabled,
      onModelOptionsChange: () => {},
    };
    const pinEffort = describeComposerEffort(pinTraitsInput, props.effortDisplay, controlSize);
    const triggerTitle = resolvedModelOption
      ? getTriggerDisplayModelName(resolvedModelOption, entry.driverKind)
      : pin.model;
    const triggerLabel = resolvedModelOption
      ? getDisplayModelName(resolvedModelOption)
      : triggerTitle;
    const showInstanceBadge = shouldShowInstanceBadge(entry, providerInstanceEntries);
    const isPinSelected =
      multipleModelSelections === null &&
      selectedInstanceId === pin.provider &&
      selectedModel === resolvedSlug &&
      (pin.options ?? []).every((pinnedOpt) => {
        const descriptor = activeDescriptors.find((desc) => desc.id === pinnedOpt.id);
        if (descriptor) {
          return getProviderOptionCurrentValue(descriptor) === pinnedOpt.value;
        }
        return traitsInput?.modelOptions?.some(
          (activeOpt) => activeOpt.id === pinnedOpt.id && activeOpt.value === pinnedOpt.value,
        );
      });
    const pinKey = `${pin.provider}:${pin.model}:${JSON.stringify(pin.options ?? [])}`;
    const tooltipText = [triggerLabel, pinEffort.detail, disabledReason]
      .filter(Boolean)
      .join(" \u00b7 ");
    const button = (
      <ComposerControl
        key={pinKey}
        type="button"
        size={controlSize}
        aria-pressed={isPinSelected}
        aria-label={[triggerLabel, pinEffort.detail].filter(Boolean).join(", ")}
        data-chat-model-pin="true"
        disabled={providerCatalogPending || isSendBusy || Boolean(disabledReason)}
        onClick={() => {
          onMultipleModelSelectionsChange(null);
          onProviderModelSelect(pin.provider, resolvedSlug, {
            modelOptions: pin.options ?? [],
          });
        }}
        className={cn(
          "group/model-trigger min-w-0 shrink-0 justify-between whitespace-nowrap",
          PINNED_MODEL_STATES,
          composerControlsCollapsed && "text-xs!",
        )}
      >
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center",
            controlSize === "xs" ? "gap-1" : "gap-1.5",
          )}
        >
          <span data-chat-provider-model-picker-icon className="contents">
            <ProviderInstanceIcon
              driverKind={entry.driverKind}
              displayName={entry.displayName}
              accentColor={entry.accentColor}
              acpRegistryAgentId={entry.acpRegistryAgentId}
              acpRegistryIconUrl={entry.acpRegistryIconUrl}
              showBadge={showInstanceBadge}
              className="size-4"
              iconClassName="size-4"
              indicatorBackground={instanceIndicatorBackground}
              badgeClassName={cn(
                "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs",
                controlSize === "xs" && "shadow-none",
              )}
            />
          </span>
          <span className="max-w-40 min-w-0 truncate">{triggerTitle}</span>
          {pinEffort.suffix}
        </span>
      </ComposerControl>
    );
    if (!tooltipText) return [button];
    return [
      <Tooltip key={pinKey}>
        <TooltipTrigger render={button} />
        <TooltipPopup side="top">{tooltipText}</TooltipPopup>
      </Tooltip>,
    ];
  });
  const restingBlockDefs = showModeBlock
    ? [
        {
          id: "mode",
          content: (
            <ComposerFooterModeControls
              showInteractionModeToggle={planModeUiEnabled}
              interactionMode={interactionMode}
              runtimeMode={compatibleRuntimeMode}
              runtimeModeOptions={compatibleRuntimeModeOptions}
              size={controlSize}
              hidden={composerControlsHidden || restingHiddenBlockCount > 0}
              accessDisplay={accessDisplay}
              emphasized={!accessMatchesDefault}
              onToggleInteractionMode={toggleInteractionMode}
              onRuntimeModeChange={handleRuntimeModeChange}
            />
          ),
        },
      ]
    : [];
  // Its own element, so typing (which rebuilds the controls around it) leaves it cached.
  const composerModelPicker = (
    <ComposerModelPicker
      environmentId={environmentId}
      compact={false}
      isComposerOwned
      // The trigger grows away from this edge when its model or effort label changes.
      popupAlign={composerControlsCollapsed ? "start" : "end"}
      disabled={providerCatalogPending || isSendBusy}
      multipleModelsEnabled={multipleModelsEnabled}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={onMultipleModelSelectionsChange}
      selectedModelSelection={selectedModelSelection}
      onProviderModelSelect={onProviderModelSelect}
      activeInstanceId={
        providerCatalogPending
          ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
          : selectedInstanceId
      }
      model={
        providerCatalogPending
          ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
          : selectedModelForPickerWithCustomFallback
      }
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      instanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      size={controlSize}
      triggerClassName={cn(
        "group/model-trigger",
        MODEL_TRIGGER_STATES,
        composerControlsCollapsed ? "min-w-13 shrink text-xs!" : "min-w-13",
      )}
      triggerSuffix={effort.suffix}
      triggerDetail={effort.detail}
      triggerShortcuts={
        pickerOwnsModeShortcut ? "composer.effort composer.mode" : "composer.effort"
      }
      effortColumn={<ComposerEffortColumn environmentId={environmentId} traits={traitsInput} />}
      footer={
        <ComposerPickerFooter
          traits={traitsInput}
          runtimeMode={compatibleRuntimeMode}
          runtimeModeOptions={compatibleRuntimeModeOptions}
          onRuntimeModeChange={handleRuntimeModeChange}
        />
      }
      terminalOpen={terminalOpen}
      open={modelPickerOpen}
      instanceIndicatorBackground={instanceIndicatorBackground}
      {...(modelPickerIconClassName
        ? { activeProviderIconClassName: modelPickerIconClassName }
        : {})}
      onOpenChange={onModelPickerOpenChange}
      getModelDisabledReason={getModelDisabledReason}
      onOpenProviderSetup={onOpenProviderSetup}
    />
  );
  return showProviderUnavailable ? (
    <ComposerControl
      type="button"
      disabled={!providerSetupInstanceId}
      onClick={() => {
        if (providerSetupInstanceId) {
          onOpenProviderSetup(providerSetupInstanceId);
        }
      }}
      data-chat-provider-unavailable="true"
      className="shrink-0"
    >
      <CircleAlertIcon className="size-4" />
      {providerSetupInstanceId ? "Open provider settings" : "No provider available"}
    </ComposerControl>
  ) : (
    <>
      {pinnedModelButtons.length > 0 ? (
        <div data-chat-model-pins="true" className="flex shrink-0 items-center gap-0.5">
          {pinnedModelButtons}
        </div>
      ) : null}
      {composerModelPicker}

      <>
        {restingBlockDefs.map((def, index) => {
          const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount;
          return (
            <div
              key={def.id}
              data-resting-block={def.id}
              data-composer-block-icon-only={
                index >= restingBlockDefs.length - iconOnlyBlockCount ? "true" : "false"
              }
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                "flex w-max min-w-max shrink-0 items-center gap-1",
                hidden && "pointer-events-none invisible absolute",
                index >= restingBlockDefs.length - iconOnlyBlockCount &&
                  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
              )}
            >
              {def.content}
            </div>
          );
        })}
        <div
          data-resting-controls-overflow
          aria-hidden={hiddenRestingBlockIds.length === 0 || undefined}
          inert={hiddenRestingBlockIds.length === 0 || undefined}
          className={cn(
            "min-w-0 shrink-0",
            hiddenRestingBlockIds.length === 0 && "pointer-events-none invisible absolute",
          )}
        >
          <CompactComposerControlsMenu
            interactionMode={interactionMode}
            runtimeMode={compatibleRuntimeMode}
            runtimeModeOptions={compatibleRuntimeModeOptions}
            size={controlSize}
            hidden={composerControlsHidden || hiddenRestingBlockIds.length === 0}
            showInteractionModeToggle={planModeUiEnabled && hiddenRestingBlockIds.length > 0}
            // Permissions join the overflow only when their normal home is in it.
            showPermissions={overflowShowsPermissions}
            onToggleInteractionMode={toggleInteractionMode}
            onRuntimeModeChange={handleRuntimeModeChange}
          />
        </div>
      </>
    </>
  );
}
