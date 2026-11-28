import { ProviderDriverKind, type ModelSelection } from "@t3tools/contracts";
import type { QueuedRunContextImplication } from "@t3tools/client-runtime/handoff";
import { T, useGT, Var } from "gt-react";
import { ArrowRightIcon, ArrowRightLeftIcon, EraserIcon } from "lucide-react";

import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { ProviderInstanceIcon, providerTextColor } from "./ProviderInstanceIcon";

export function resolveSelectionDisplay(
  selection: ModelSelection,
  entries: ReadonlyArray<ProviderInstanceEntry>,
) {
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === selection.model);
  const modelLabel =
    model !== undefined ? getTriggerDisplayModelName(model, entry?.driverKind) : selection.model;
  const providerLabel = entry?.displayName ?? selection.instanceId;
  const showInstanceBadge = entry !== undefined && shouldShowInstanceBadge(entry, entries);
  return { entry, modelLabel, providerLabel, showInstanceBadge };
}

export function ContextImplicationInfo(props: {
  readonly implication: QueuedRunContextImplication;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly align?: "start" | "center" | "end";
  readonly size?: "badge" | "composer";
  readonly dataSlot?: string;
  readonly className?: string;
}) {
  const gt = useGT();
  const source = resolveSelectionDisplay(props.implication.from, props.entries);
  const target = resolveSelectionDisplay(props.implication.to, props.entries);
  const sourceDriver =
    source.entry?.driverKind ?? ProviderDriverKind.make(props.implication.from.instanceId);
  const targetDriver =
    target.entry?.driverKind ?? ProviderDriverKind.make(props.implication.to.instanceId);
  const sourceColor = providerTextColor(sourceDriver);
  const targetColor = providerTextColor(targetDriver);
  const isFreshSession = props.implication.kind === "fresh_session";
  const isComposer = props.size === "composer";

  return (
    <Tooltip>
      <TooltipTrigger
        delay={150}
        render={
          <span
            data-slot={props.dataSlot ?? "queued-context-info"}
            aria-label={gt("Context implications")}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-muted/50 font-medium leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              isComposer ? "h-6 px-2 text-xs" : "px-1.5 py-0.5 text-2xs",
              props.className,
            )}
          />
        }
      >
        {isFreshSession ? (
          <EraserIcon aria-hidden className="size-3 shrink-0" />
        ) : (
          <ArrowRightLeftIcon aria-hidden className="size-3 shrink-0" />
        )}
        <span>
          <T context="chip showing context handoff status">Context</T>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" align={props.align ?? "start"} className="max-w-72 text-start">
        <div className="flex flex-col gap-1.5 py-0.5 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            {isFreshSession ? (
              <EraserIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ArrowRightLeftIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span>
              {props.implication.kind === "fresh_session" ? (
                <T>New session</T>
              ) : props.implication.kind === "delta_handoff" ? (
                <T>Delta context handoff</T>
              ) : (
                <T>Context handoff</T>
              )}
            </span>
          </div>
          {!isFreshSession ? (
            <div className="flex flex-wrap items-center gap-1.5 text-2xs">
              <span className="inline-flex items-center gap-1">
                <ProviderInstanceIcon
                  driverKind={sourceDriver}
                  displayName={source.providerLabel}
                  accentColor={source.entry?.accentColor}
                  acpRegistryAgentId={source.entry?.acpRegistryAgentId}
                  acpRegistryIconUrl={source.entry?.acpRegistryIconUrl}
                  showBadge={source.showInstanceBadge}
                  size="compact"
                  iconClassName="size-3"
                  indicatorBackground="var(--popover)"
                />
                <span
                  className={cn("font-medium", sourceColor.className)}
                  style={sourceColor.style}
                >
                  {source.modelLabel}
                </span>
              </span>
              <ArrowRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="inline-flex items-center gap-1">
                <ProviderInstanceIcon
                  driverKind={targetDriver}
                  displayName={target.providerLabel}
                  accentColor={target.entry?.accentColor}
                  acpRegistryAgentId={target.entry?.acpRegistryAgentId}
                  acpRegistryIconUrl={target.entry?.acpRegistryIconUrl}
                  showBadge={target.showInstanceBadge}
                  size="compact"
                  iconClassName="size-3"
                  indicatorBackground="var(--popover)"
                />
                <span
                  className={cn("font-medium", targetColor.className)}
                  style={targetColor.style}
                >
                  {target.modelLabel}
                </span>
              </span>
            </div>
          ) : null}
          {props.implication.kind === "fresh_session" ? (
            <p className="leading-relaxed text-muted-foreground">
              <T>This prompt starts a fresh session without earlier conversation context.</T>
            </p>
          ) : props.implication.kind === "delta_handoff" ? (
            <p className="leading-relaxed text-muted-foreground">
              <T>
                Will summarize new additions to this conversation since{" "}
                <Var>{target.providerLabel}</Var> was last used.
              </T>
            </p>
          ) : (
            <div className="flex flex-col gap-1.5 leading-relaxed text-muted-foreground">
              <p>
                <T>
                  Will summarize the conversation up to this point to hand off to{" "}
                  <Var>{target.providerLabel}</Var>.
                </T>
              </p>
              <p>
                <T>
                  Prompt caching will start fresh for <Var>{target.providerLabel}</Var>.
                </T>
              </p>
            </div>
          )}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
