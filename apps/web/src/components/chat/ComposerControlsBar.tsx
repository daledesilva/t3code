import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { CircleAlertIcon, PinIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl } from "./ComposerControl";
import {
  ComposerFooterModeControls,
  ComposerModelPicker,
  type RuntimeModeOption,
} from "./ComposerFooterControls";
import {
  type ContextMenuItem,
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EffortDisplay, ModelPin } from "@t3tools/contracts/settings";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { modelPinsEqual } from "@t3tools/shared/serverSettings";
import {
  useEnvironmentIdentificationMode,
  useEnvironmentModelPreferences,
  useRenameEnvironmentModelPin,
  useToggleEnvironmentModelPin,
} from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { readLocalApi } from "../../localApi";
import { getProviderModelCapabilities } from "../../providerModels";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { resolveComposerTraitsInput, withImplicitFastModeDefault } from "./composerProviderState";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
  describePinnedModelEffort,
} from "./ComposerModelEffort";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName, getTriggerDisplayModelName } from "./providerIconUtils";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { resolveComposerControlsOwnership } from "./composerControlsOwnership";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type PinnedModelContextMenuAction = "rename" | "unpin";

const PINNED_MODEL_CONTEXT_MENU_ITEMS: ReadonlyArray<
  ContextMenuItem<PinnedModelContextMenuAction>
> = [
  { id: "rename", label: "Rename", icon: "pencil" },
  { id: "unpin", label: "Unpin", icon: "pin-off" },
];

// Mounted only while renaming, so each rename starts uncommitted.
function PinnedModelRenameInput(props: {
  initialValue: string;
  placeholder: string;
  onCommit: (nextLabel: string) => void;
  onCancel: () => void;
}) {
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      dir="auto"
      aria-label="Pinned model nickname"
      defaultValue={props.initialValue}
      placeholder={props.placeholder}
      ref={(element) => {
        element?.focus();
        element?.select();
      }}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        if (!settledRef.current) props.onCommit(event.currentTarget.value);
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="w-28 min-w-0 rounded-sm bg-background px-1 text-foreground outline-none ring-1 ring-inset ring-ring"
    />
  );
}

const PINNED_MODEL_SUBMIT_PILL =
  "group/model-trigger relative isolate inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 overflow-hidden rounded-full ps-3 pe-2.75 font-medium text-base whitespace-nowrap shadow-xs transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:h-8 sm:pe-2.25 sm:text-sm";

export function ComposerPinnedModelsRow(props: {
  environmentId: EnvironmentId;
  planModeEnabled: boolean;
  showProviderUnavailable: boolean;
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  canSubmit: boolean;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
  onSubmitWithPin: (
    pin: ModelPin,
    resolvedSlug: string,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  pendingPinnedModel?: {
    pin: ModelPin;
    phase: "waiting" | "entering";
  } | null;
  onPendingPinnedModelEntered?: () => void;
  filter?: "all" | "custom-label" | "default-label";
  inline?: boolean;
  trailingAccessory?: ReactNode;
  className?: string;
}) {
  const {
    environmentId,
    planModeEnabled,
    showProviderUnavailable,
    providerCatalogPending,
    isSendBusy,
    canSubmit,
    providerInstanceEntries,
    modelOptionsByInstance,
    getModelDisabledReason,
    onSubmitWithPin,
    pendingPinnedModel = null,
    onPendingPinnedModelEntered,
    filter = "all",
    inline = false,
    trailingAccessory,
  } = props;
  const { pins } = useEnvironmentModelPreferences(environmentId);
  const togglePin = useToggleEnvironmentModelPin(environmentId);
  const renamePin = useRenameEnvironmentModelPin(environmentId);
  const [renamingPinKey, setRenamingPinKey] = useState<string | null>(null);
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(environmentIdentificationMode);

  if (showProviderUnavailable || (pins.length === 0 && !pendingPinnedModel)) {
    return null;
  }

  const openPinContextMenu = (
    pin: ModelPin,
    pinKey: string,
    position: { x: number; y: number },
  ) => {
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const action = await api.contextMenu.show(PINNED_MODEL_CONTEXT_MENU_ITEMS, position);
      if (action === "rename") {
        setRenamingPinKey(pinKey);
      } else if (action === "unpin") {
        void togglePin(pin.provider, pin.model, pin.options);
      }
    })();
  };

  const filteredPins = pins.filter((pin) => {
    if (filter === "custom-label") return Boolean(pin.label);
    if (filter === "default-label") return !pin.label;
    return true;
  });

  const visiblePins =
    pendingPinnedModel?.phase === "waiting"
      ? filteredPins.filter((pin) => !modelPinsEqual(pin, pendingPinnedModel.pin))
      : pendingPinnedModel?.phase === "entering" &&
          !filteredPins.some((pin) => modelPinsEqual(pin, pendingPinnedModel.pin))
        ? [...filteredPins, pendingPinnedModel.pin]
        : filteredPins;

  const pinnedModelButtons = visiblePins.flatMap((pin) => {
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
    const pinEffort = describePinnedModelEffort(pinTraitsInput, "sm");
    const defaultTriggerTitle = resolvedModelOption
      ? getTriggerDisplayModelName(resolvedModelOption, entry.driverKind)
      : pin.model;
    const hasCustomName = Boolean(pin.label);
    const triggerTitle = pin.label ?? defaultTriggerTitle;
    const triggerLabel = resolvedModelOption
      ? getDisplayModelName(resolvedModelOption)
      : defaultTriggerTitle;
    const showInstanceBadge = shouldShowInstanceBadge(entry, providerInstanceEntries);
    const pinKey = `${pin.provider}:${pin.model}:${JSON.stringify(pin.options ?? [])}`;
    const isRenaming = renamingPinKey === pinKey;
    const submitTargetLabel = [triggerLabel, pinEffort.detail].filter(Boolean).join(" \u00b7 ");
    const tooltipSuffix = [`\u00b7 ${submitTargetLabel}`, disabledReason]
      .filter(Boolean)
      .join(" \u00b7 ");
    const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      openPinContextMenu(
        pin,
        pinKey,
        event.clientX === 0 && event.clientY === 0
          ? { x: bounds.left, y: bounds.bottom }
          : { x: event.clientX, y: event.clientY },
      );
    };
    const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
      if (
        event.defaultPrevented ||
        isRenaming ||
        !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      openPinContextMenu(pin, pinKey, { x: bounds.left, y: bounds.bottom });
    };
    const tooltipIconElement = (
      <ProviderInstanceIcon
        driverKind={entry.driverKind}
        displayName={entry.displayName}
        accentColor={entry.accentColor}
        acpRegistryAgentId={entry.acpRegistryAgentId}
        acpRegistryIconUrl={entry.acpRegistryIconUrl}
        showBadge={showInstanceBadge}
        className="size-3.5 shrink-0"
        iconClassName="size-3.5"
        indicatorBackground="var(--popover)"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-2.5 min-w-2.5 px-0.5 text-5xs"
      />
    );
    const upArrowIcon = (
      <svg
        width="12"
        height="12"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        className="ms-0.5 size-3.5 shrink-0 pointer-events-none"
      >
        <path
          d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
    const backdropArt = stageBackdropVariant ? (
      <span className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <StageBackdropButtonArt variant={stageBackdropVariant} />
      </span>
    ) : null;
    const toneClassName = stageBackdropVariant
      ? "bg-transparent text-white"
      : "bg-message-action text-message-action-foreground";
    if (isRenaming) {
      return [
        <div
          key={pinKey}
          data-chat-model-pin="true"
          className={cn(PINNED_MODEL_SUBMIT_PILL, toneClassName)}
        >
          {backdropArt}
          <span className="flex min-w-0 items-center gap-1.5">
            <PinnedModelRenameInput
              initialValue={pin.label ?? defaultTriggerTitle}
              placeholder={defaultTriggerTitle}
              onCommit={(nextValue) => {
                setRenamingPinKey(null);
                const trimmed = nextValue.trim();
                const nextLabel =
                  trimmed.length === 0 || trimmed === defaultTriggerTitle ? null : trimmed;
                if ((nextLabel ?? undefined) === pin.label) return;
                void renamePin(pin.provider, pin.model, pin.options, nextLabel);
              }}
              onCancel={() => setRenamingPinKey(null)}
            />
            {upArrowIcon}
          </span>
        </div>,
      ];
    }
    const isHardDisabled = providerCatalogPending || isSendBusy || Boolean(disabledReason);
    const isActionReady = !isHardDisabled && canSubmit;
    const isEntering =
      pendingPinnedModel?.phase === "entering" && modelPinsEqual(pin, pendingPinnedModel.pin);
    const button = (
      <button
        key={pinKey}
        type="button"
        aria-disabled={!isActionReady || undefined}
        aria-label={`Submit with ${submitTargetLabel}`}
        data-chat-model-pin="true"
        disabled={isHardDisabled}
        onClick={(event) => {
          if (!isActionReady) {
            event.preventDefault();
            return;
          }
          onSubmitWithPin(pin, resolvedSlug, event);
        }}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        onTransitionEnd={isEntering ? () => onPendingPinnedModelEntered?.() : undefined}
        style={
          isEntering
            ? { transitionTimingFunction: "cubic-bezier(0.215, 0.61, 0.355, 1)" }
            : undefined
        }
        className={cn(
          PINNED_MODEL_SUBMIT_PILL,
          toneClassName,
          isActionReady
            ? cn(
                "cursor-pointer inset-shadow-control-highlight hover:scale-[1.02] active:inset-shadow-control-pressed active:shadow-none",
                stageBackdropVariant
                  ? "shadow-black/24 hover:brightness-110"
                  : "shadow-message-action/24 hover:bg-message-action-hover",
              )
            : "opacity-64 shadow-none",
          "disabled:opacity-64 disabled:shadow-none",
          isEntering &&
            "origin-center duration-200 ease-out starting:scale-80 starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:scale-100 motion-reduce:starting:opacity-100",
        )}
      >
        {backdropArt}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-40 min-w-0 truncate">{triggerTitle}</span>
          {!hasCustomName ? pinEffort.suffix : null}
          {upArrowIcon}
        </span>
      </button>
    );
    return [
      <Tooltip key={pinKey}>
        <TooltipTrigger render={button} />
        <TooltipPopup side="top">
          <span className="inline-flex flex-wrap items-center gap-1">
            <span>Submit with</span>
            {tooltipIconElement}
            <span>{tooltipSuffix}</span>
          </span>
        </TooltipPopup>
      </Tooltip>,
    ];
  });

  if (pinnedModelButtons.length === 0 && !pendingPinnedModel) {
    return null;
  }

  return (
    <div
      data-chat-model-pins="true"
      className={cn(
        inline
          ? "flex min-h-9 min-w-0 flex-wrap items-center justify-end gap-1.5 sm:min-h-8"
          : "flex min-h-9 min-w-0 flex-wrap items-center justify-end gap-1.5 px-2 pb-1.5 sm:min-h-8",
        props.className,
      )}
    >
      {pinnedModelButtons}
      {trailingAccessory}
    </div>
  );
}

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
  onPinModel?: (pin: ModelPin) => void;
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
    onPinModel,
  } = props;
  const { pins } = useEnvironmentModelPreferences(environmentId);
  const togglePin = useToggleEnvironmentModelPin(environmentId);
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
  const activePinOptions =
    activeDescriptors.length > 0
      ? buildExplicitProviderOptionSelectionsFromDescriptors(
          activeDescriptors,
          traitsInput?.modelOptions,
        )
      : traitsInput?.modelOptions && traitsInput.modelOptions.length > 0
        ? traitsInput.modelOptions
        : undefined;
  const currentPinCandidate: ModelPin | null =
    multipleModelSelections === null && selectedInstanceId && selectedModel
      ? {
          provider: selectedInstanceId,
          model: selectedModel,
          ...(activePinOptions && activePinOptions.length > 0 ? { options: activePinOptions } : {}),
        }
      : null;
  const isCurrentModelPinned =
    currentPinCandidate !== null && pins.some((pin) => modelPinsEqual(pin, currentPinCandidate));
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
  const pinTriggerDisabled = providerCatalogPending || isSendBusy || currentPinCandidate === null;
  const pinTooltipLabel = isCurrentModelPinned ? "Unpin model" : "Pin model";
  // Its own element, so typing (which rebuilds the controls around it) leaves it cached.
  const composerModelPicker = (
    <div data-chat-provider-model-segmented="true" className="flex min-w-0 shrink items-center">
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
          "group/model-trigger rounded-e-none",
          MODEL_TRIGGER_STATES,
          composerControlsCollapsed ? "min-w-13 shrink text-xs!" : "min-w-13",
        )}
        triggerSuffix={effort.suffix}
        triggerDetail={effort.detail}
        triggerShortcuts={
          pickerOwnsModeShortcut ? "composer.effort composer.mode" : "composer.effort"
        }
        effortColumn={<ComposerEffortColumn traits={traitsInput} />}
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
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              type="button"
              size={controlSize}
              aria-pressed={isCurrentModelPinned}
              aria-label={pinTooltipLabel}
              data-chat-provider-model-pin-button="true"
              disabled={pinTriggerDisabled}
              onClick={() => {
                if (!currentPinCandidate) return;
                if (!isCurrentModelPinned) {
                  onPinModel?.(currentPinCandidate);
                }
                void togglePin(
                  currentPinCandidate.provider,
                  currentPinCandidate.model,
                  currentPinCandidate.options,
                );
              }}
              className={cn(
                "shrink-0 rounded-s-none border-s border-border/50 px-1.5",
                PINNED_MODEL_STATES,
              )}
            />
          }
        >
          <PinIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 sm:size-3",
              isCurrentModelPinned && "fill-current text-primary",
            )}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{pinTooltipLabel}</TooltipPopup>
      </Tooltip>
    </div>
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
