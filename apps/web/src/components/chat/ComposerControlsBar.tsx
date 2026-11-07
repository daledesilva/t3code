import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { CircleAlertIcon, PinIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
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
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { modelPinsEqual } from "@t3tools/shared/serverSettings";
import {
  useEnvironmentModelPreferences,
  useRenameEnvironmentModelPin,
  useToggleEnvironmentModelPin,
} from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { readLocalApi } from "../../localApi";
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
  const togglePin = useToggleEnvironmentModelPin(environmentId);
  const renamePin = useRenameEnvironmentModelPin(environmentId);
  const [renamingPinKey, setRenamingPinKey] = useState<string | null>(null);
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
    const defaultTriggerTitle = resolvedModelOption
      ? getTriggerDisplayModelName(resolvedModelOption, entry.driverKind)
      : pin.model;
    const triggerTitle = pin.label ?? defaultTriggerTitle;
    const triggerLabel = resolvedModelOption
      ? getDisplayModelName(resolvedModelOption)
      : defaultTriggerTitle;
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
    const isRenaming = renamingPinKey === pinKey;
    const tooltipText = [
      pin.label ? `${pin.label} (${triggerLabel})` : triggerLabel,
      pinEffort.detail,
      disabledReason,
    ]
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
    const iconElement = (
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
    );
    if (isRenaming) {
      return [
        <div
          key={pinKey}
          data-chat-model-pin="true"
          className={cn(
            "inline-flex shrink-0 items-center whitespace-nowrap rounded-(--control-radius) bg-accent text-foreground",
            controlSize === "xs"
              ? "h-7 gap-1 px-1.75 text-xs sm:h-6"
              : "h-7 gap-1.5 px-2 text-base sm:text-sm",
          )}
        >
          {iconElement}
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
          {pinEffort.suffix}
        </div>,
      ];
    }
    const button = (
      <ComposerControl
        key={pinKey}
        type="button"
        size={controlSize}
        aria-pressed={isPinSelected}
        aria-label={[triggerTitle, pinEffort.detail].filter(Boolean).join(", ")}
        data-chat-model-pin="true"
        disabled={providerCatalogPending || isSendBusy || Boolean(disabledReason)}
        onClick={() => {
          onMultipleModelSelectionsChange(null);
          onProviderModelSelect(pin.provider, resolvedSlug, {
            modelOptions: pin.options ?? [],
          });
        }}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
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
          {iconElement}
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
