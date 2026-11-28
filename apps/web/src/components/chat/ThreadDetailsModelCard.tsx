import {
  type ModelSelection,
  type OrchestrationV2Run,
  type ProviderInstanceId,
  type ProviderMcpServer,
  type ProviderRuntimeModeLimit,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  formatRunUsageUsedPercent,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
  resolveRunUsageLimitWindows,
} from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { ScrollArea } from "../ui/scroll-area";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { PaceIcon, barColor } from "../usage/UsageLimits";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName } from "./providerIconUtils";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsMcpSection, ThreadDetailsModeLimitsSection } from "./ThreadDetailsMcpRows";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { resolveThreadDetailsLimits, resolveThreadHttpQuotas } from "./ThreadDetailsUsage.logic";
import { THREAD_DETAILS_PANEL_CHEVRON_CLASS } from "./threadDetailsPanelStyles";

export type ThreadUsageLimitRun = Pick<
  OrchestrationV2Run,
  "modelSelection" | "usageLimitsBefore" | "usageLimitsAfter"
>;

export interface ThreadDetailsModelCardProps {
  readonly providerEntry: ProviderInstanceEntry | null;
  readonly selectedModel: string | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly threadRuns?: ReadonlyArray<ThreadUsageLimitRun>;
  readonly isServerThread: boolean;
  readonly isEditingQueuedRun: boolean;
  readonly threadModelSelection?: ModelSelection | null;
  readonly threadRuntimeProviderInstanceId?: ProviderInstanceId | null;
  readonly mcpServers: ReadonlyArray<ProviderMcpServer>;
  readonly runtimeModeLimits: ReadonlyArray<ProviderRuntimeModeLimit>;
  readonly cwd: string | null;
  readonly onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
}

const WINDOW_RESET_TOLERANCE_MS = 60_000;

function sumThreadUsedPercentForWindow(input: {
  readonly provider: Pick<ServerProvider, "instanceId" | "driver">;
  readonly window: ServerProviderUsageWindow;
  readonly runs: ReadonlyArray<ThreadUsageLimitRun>;
}): number {
  const currentResetMs = input.window.resetsAt ? Date.parse(input.window.resetsAt) : Number.NaN;
  const windowStartMs =
    Number.isFinite(currentResetMs) && input.window.windowDurationMins !== undefined
      ? currentResetMs - input.window.windowDurationMins * 60_000
      : Number.NaN;

  let totalDelta = 0;
  for (const run of input.runs) {
    if (run.modelSelection.instanceId !== input.provider.instanceId) continue;
    if (run.usageLimitsAfter === undefined) continue;
    const deltas = resolveRunUsageLimitWindows({
      driver: input.provider.driver,
      model: run.modelSelection.model,
      before: run.usageLimitsBefore,
      after: run.usageLimitsAfter,
    });
    const match = deltas.find((entry) => entry.id === input.window.id);
    if (!match || match.usedDelta <= 0) continue;

    const runResetMs = match.windowAfter.resetsAt
      ? Date.parse(match.windowAfter.resetsAt)
      : Number.NaN;
    if (
      Number.isFinite(currentResetMs) &&
      Number.isFinite(runResetMs) &&
      currentResetMs > runResetMs + WINDOW_RESET_TOLERANCE_MS
    ) {
      continue;
    }
    if (
      Number.isFinite(windowStartMs) &&
      match.afterAtMs > 0 &&
      match.afterAtMs < windowStartMs - WINDOW_RESET_TOLERANCE_MS
    ) {
      continue;
    }
    totalDelta += match.usedDelta;
  }

  return Number(Math.max(0, totalDelta).toPrecision(12));
}

function authDotClass(status: ServerProvider["auth"]["status"]): string {
  switch (status) {
    case "authenticated":
      return "bg-emerald-500";
    case "unauthenticated":
      return "bg-warning";
    case "unknown":
      return "bg-muted-foreground/50";
  }
}

function shortWindowTag(window: Pick<ServerProviderUsageWindow, "kind" | "label">): string {
  if (window.kind === "session") return "5h";
  if (window.kind === "weekly") return "7d";
  if (window.kind === "monthly") return "30d";
  return window.label;
}

function paceClipPath(tickLeft: string) {
  return {
    clipPath: `polygon(-1px -1px, calc(${tickLeft} - 3px) -1px, calc(${tickLeft} - 3px) calc(100% + 1px), calc(${tickLeft} + 3px) calc(100% + 1px), calc(${tickLeft} + 3px) -1px, calc(100% + 1px) -1px, calc(100% + 1px) calc(100% + 1px), -1px calc(100% + 1px))`,
  };
}

function CollapsibleNameListSection({
  headingId,
  title,
  items,
  prefix = "",
}: {
  readonly headingId: string;
  readonly title: string;
  readonly items: ReadonlyArray<string>;
  readonly prefix?: string;
}) {
  const [sectionExpanded, setSectionExpanded] = useState(false);

  if (items.length === 0) return null;

  const Chevron = sectionExpanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <ThreadDetailsSection headingId={headingId} title={title} showHeading={false}>
      <div className="flex flex-col">
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          aria-expanded={sectionExpanded}
          onClick={() => setSectionExpanded((current) => !current)}
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
            {items.length}
          </span>
          <Chevron className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} aria-hidden />
        </ThreadDetailsControl>
        {sectionExpanded ? (
          <div className="mt-0.5 flex flex-col">
            {items.map((name) => (
              <div
                key={name}
                className="flex h-6 min-w-0 items-center rounded-lg px-2.5 text-xs text-muted-foreground"
              >
                <span className="truncate font-mono text-2xs">
                  {prefix}
                  {name}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

function formatWindowTimeLeft(
  window: Pick<ServerProviderUsageWindow, "kind" | "windowDurationMins">,
  timeLeft: number,
  gt: ReturnType<typeof useGT>,
): string {
  const mins = window.windowDurationMins;
  if (mins !== undefined && mins > 0) {
    if (mins % (24 * 60) === 0) {
      return gt("{timeLeft}% of {days} day window left", {
        timeLeft,
        days: mins / (24 * 60),
      });
    }
    if (mins % 60 === 0) {
      return gt("{timeLeft}% of {hours} hour window left", {
        timeLeft,
        hours: mins / 60,
      });
    }
    if (mins >= 24 * 60) {
      return gt("{timeLeft}% of {days} day window left", {
        timeLeft,
        days: Math.round(mins / (24 * 60)),
      });
    }
    if (mins >= 60) {
      return gt("{timeLeft}% of {hours} hour window left", {
        timeLeft,
        hours: Math.round(mins / 60),
      });
    }
    return gt("{timeLeft}% of {minutes} minute window left", {
      timeLeft,
      minutes: mins,
    });
  }
  if (window.kind === "session") {
    return gt("{timeLeft}% of {hours} hour window left", { timeLeft, hours: 5 });
  }
  if (window.kind === "weekly") {
    return gt("{timeLeft}% of {days} day window left", { timeLeft, days: 7 });
  }
  if (window.kind === "monthly") {
    return gt("{timeLeft}% of {days} day window left", { timeLeft, days: 30 });
  }
  return gt("{timeLeft}% of window left", { timeLeft });
}

/** Matches PR #9's timeline tooltip usage bar: h-4 rounded-md bg-muted, opacity-35 remaining fill, outlined diagonal pinstripe thread-used segment, and clipped pace tick. */
function UsageLimitBarRow({
  window,
  color,
  now,
  threadUsedPercent = 0,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string;
  readonly now: number;
  readonly threadUsedPercent?: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const spent = Math.max(0, 100 - remaining);
  const clampedThreadUsed = Math.max(0, Math.min(spent, threadUsedPercent));
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const paceTickLeft = timeLeft !== null ? `clamp(3px, ${timeLeft}%, calc(100% - 3px))` : null;
  const windowTimeLeftLabel = timeLeft !== null ? formatWindowTimeLeft(window, timeLeft, gt) : null;
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)
    : null;

  const summary = [
    gt("{label}: {remaining}% usage left", { label: window.label, remaining }),
    windowTimeLeftLabel,
    resetsAt ? gt("Resets {resetsAt}", { resetsAt }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return (
    <div className="flex flex-col gap-1 px-2.5" data-testid={`model-card-usage-bar-${window.id}`}>
      <div className="flex items-center justify-between gap-2 text-2xs leading-none">
        <Link
          to="/usage"
          className="truncate text-muted-foreground outline-none hover:text-foreground"
        >
          {window.label}
        </Link>
        <span className="flex shrink-0 items-center gap-1.5 font-medium text-foreground tabular-nums">
          {pace ? <PaceIcon pace={pace} /> : null}
          <span>{gt("{remaining}% left", { remaining })}</span>
        </span>
      </div>
      <SharedTooltipTrigger
        render={
          <Link
            to="/usage"
            aria-label={summary}
            className="relative block h-4 w-full rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
        label={
          <div className="flex flex-col gap-0.5">
            <span className="text-foreground">{gt("{remaining}% usage left", { remaining })}</span>
            {windowTimeLeftLabel ? (
              <span className="text-muted-foreground">{windowTimeLeftLabel}</span>
            ) : null}
            {clampedThreadUsed > 0 && formatRunUsageUsedPercent(clampedThreadUsed) !== "0" ? (
              <span className="text-muted-foreground">
                {gt("{percent}% used in this thread", {
                  percent: formatRunUsageUsedPercent(clampedThreadUsed),
                })}
              </span>
            ) : null}
            {resetsAt ? (
              <span className="text-muted-foreground">{gt("Resets {resetsAt}", { resetsAt })}</span>
            ) : null}
          </div>
        }
      >
        <span className="absolute inset-0 block overflow-hidden rounded-md">
          <span
            className="absolute inset-0 block"
            style={paceTickLeft !== null ? paceClipPath(paceTickLeft) : undefined}
          >
            {remaining > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "absolute inset-y-0 left-0 block opacity-35",
                  clampedThreadUsed > 0 ? "rounded-l-md" : "rounded-md",
                )}
                style={{ width: `${remaining}%`, backgroundColor: color }}
              />
            ) : null}
            {clampedThreadUsed > 0 ? (
              <span
                aria-hidden
                data-testid={`model-card-usage-delta-${window.id}`}
                className={cn(
                  "absolute inset-y-0 block box-border",
                  remaining === 0 ? "rounded-md" : "rounded-r-md",
                )}
                style={{
                  left: `${remaining}%`,
                  width: `${clampedThreadUsed}%`,
                  minWidth: "4px",
                  border: `1px solid color-mix(in oklch, ${color} 80%, transparent)`,
                  backgroundImage: `repeating-linear-gradient(135deg, color-mix(in oklch, ${color} 45%, transparent) 0 1.5px, transparent 1.5px 5px)`,
                }}
              />
            ) : null}
          </span>
        </span>
        {paceTickLeft !== null ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 block w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={{ left: paceTickLeft }}
          />
        ) : null}
      </SharedTooltipTrigger>
    </div>
  );
}

export function ThreadDetailsModelCard({
  providerEntry,
  selectedModel,
  providers,
  sources,
  threadRuns = [],
  isServerThread,
  isEditingQueuedRun,
  threadModelSelection = null,
  threadRuntimeProviderInstanceId = null,
  mcpServers,
  runtimeModeLimits,
  cwd,
  onOpenProviderSetup,
}: ThreadDetailsModelCardProps) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);

  const provider = providerEntry?.snapshot ?? null;
  const hasAlert =
    provider !== null &&
    (provider.auth.status === "unauthenticated" ||
      provider.status === "error" ||
      provider.status === "warning" ||
      provider.compatibilityAdvisory?.status === "broken" ||
      provider.compatibilityAdvisory?.status === "unsupported");

  const [headerExpanded, setHeaderExpanded] = useState(hasAlert);
  const [usageExpanded, setUsageExpanded] = useState(true);

  if (!providerEntry || !provider) return null;

  const modelRecord =
    selectedModel !== null
      ? (provider.models.find((entry) => entry.slug === selectedModel) ?? null)
      : null;
  const modelName =
    selectedModel !== null
      ? getDisplayModelName(modelRecord ?? { slug: selectedModel, name: selectedModel })
      : providerEntry.displayName;
  const subProvider = modelRecord?.subProvider ?? null;
  const version = provider.installedVersion ?? provider.version;
  const accentColor =
    normalizeProviderAccentColor(providerEntry.accentColor ?? provider.accentColor) ??
    barColor(provider.driver);

  const activeThreadInstanceId = isServerThread ? threadRuntimeProviderInstanceId : null;
  const activeThreadProvider =
    activeThreadInstanceId !== null
      ? (providers.find((entry) => entry.instanceId === activeThreadInstanceId) ?? null)
      : null;
  const switchesProvider =
    !isEditingQueuedRun &&
    activeThreadInstanceId !== null &&
    activeThreadInstanceId !== provider.instanceId;
  const switchesModel =
    !isEditingQueuedRun &&
    activeThreadInstanceId !== null &&
    !switchesProvider &&
    threadModelSelection !== null &&
    selectedModel !== null &&
    threadModelSelection.model !== selectedModel;
  const startsFreshSession =
    switchesProvider &&
    (provider.continuation?.groupKey === undefined ||
      provider.continuation.groupKey !== activeThreadProvider?.continuation?.groupKey);

  const auth = provider.auth;
  const authPrimaryLabel = (() => {
    if (auth.status === "authenticated") {
      return auth.label ?? gt("Authenticated", { $context: "provider auth status" });
    }
    if (auth.status === "unauthenticated") {
      return gt("Signed out", { $context: "provider auth status" });
    }
    return auth.label ?? gt("Auth unknown", { $context: "provider auth status" });
  })();
  const authEmail = auth.email?.trim() || null;
  const authFallbackDetail = !authEmail ? (auth.endpoint ?? auth.type ?? null) : null;
  const canSignIn =
    auth.status === "unauthenticated" &&
    onOpenProviderSetup !== undefined &&
    (provider.setup?.canAuthenticate !== false || auth.action !== undefined);

  const advisoryMessage = (() => {
    if (
      provider.compatibilityAdvisory &&
      (provider.compatibilityAdvisory.status === "broken" ||
        provider.compatibilityAdvisory.status === "unsupported")
    ) {
      return (
        provider.compatibilityAdvisory.message ??
        gt("Provider version is incompatible", { $context: "provider health advisory" })
      );
    }
    if (provider.status === "error" || provider.status === "warning") {
      return (
        provider.message ??
        provider.unavailableReason ??
        gt("Provider needs attention", { $context: "provider health advisory" })
      );
    }
    if (
      provider.versionAdvisory?.status === "behind_latest" &&
      provider.versionAdvisory.latestVersion
    ) {
      return gt("Update available ({version})", {
        version: provider.versionAdvisory.latestVersion,
      });
    }
    return null;
  })();
  const advisoryTone =
    provider.status === "error" || provider.compatibilityAdvisory?.status === "broken"
      ? "error"
      : "warning";

  const resolvedLimits = resolveThreadDetailsLimits(
    provider.instanceId,
    selectedModel,
    providers,
    sources,
    now,
  );
  const httpQuotas = resolveThreadHttpQuotas(provider.instanceId, sources);
  const displayWindows: ReadonlyArray<ServerProviderUsageWindow> = (() => {
    const out: ServerProviderUsageWindow[] = [];
    if (resolvedLimits?.kind === "instance" && limitsNotice(resolvedLimits.limits) === null) {
      out.push(...resolvedLimits.limits.windows);
    } else if (resolvedLimits?.kind === "pool") {
      for (const poolWindow of resolvedLimits.windows) {
        out.push({
          id: poolWindow.id,
          kind: poolWindow.kind,
          label: poolWindow.label,
          usedPercent: Math.max(0, Math.min(100, 100 - poolWindow.remainingPercent)),
        });
      }
    }
    for (const quota of httpQuotas) {
      out.push(quota.window);
    }
    return out;
  })();

  const limitNoticeText =
    resolvedLimits?.kind === "instance" && displayWindows.length === 0
      ? limitsNotice(resolvedLimits.limits, m)
      : null;

  const resetCredits = provider.usageLimits?.resetCredits;
  const externalUsage = provider.usageLimits?.externalUsage;
  const hasUsageSection =
    displayWindows.length > 0 ||
    limitNoticeText !== null ||
    Boolean(resetCredits && resetCredits.availableCount > 0) ||
    Boolean(externalUsage);

  const usageHeaderSummary = (() => {
    const parts: string[] = [];
    for (const window of displayWindows.slice(0, 2)) {
      parts.push(`${shortWindowTag(window)} ${remainingPercent(window)}%`);
    }
    return parts.join(" · ");
  })();

  const providerMcpServers = mcpServers.filter((server) => server.scope === "provider");
  const providerModeLimits = runtimeModeLimits.filter(
    (limit) => limit.reason !== "project-settings",
  );

  const workspaceSnapshot =
    cwd !== null
      ? (provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd) ?? null)
      : null;
  const skillNames = [
    ...new Set([
      ...provider.skills.filter((skill) => skill.enabled).map((skill) => skill.name),
      ...(workspaceSnapshot?.skills.filter((skill) => skill.enabled).map((skill) => skill.name) ??
        []),
    ]),
  ];
  const commandNames = [
    ...new Set([
      ...provider.slashCommands.map((command) => command.name),
      ...(workspaceSnapshot?.slashCommands.map((command) => command.name) ?? []),
    ]),
  ];

  const HeaderChevron = headerExpanded ? ChevronDownIcon : ChevronRightIcon;
  const UsageChevron = usageExpanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      className="dropdown-glass isolate contain-paint grid min-h-0 max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-2xl"
      data-thread-details-model-card
    >
      <ScrollArea scrollFade observeContent className="min-h-0">
        <div className="flex flex-col">
          <ThreadDetailsSection
            headingId="thread-details-model-header"
            title={gt("Model and provider")}
            separated={false}
            showHeading={false}
          >
            <div className="flex flex-col">
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                aria-label={gt("Model details: {model}", { model: modelName })}
                aria-expanded={headerExpanded}
                onClick={() => setHeaderExpanded((current) => !current)}
              >
                <ProviderInstanceIcon
                  driverKind={providerEntry.driverKind}
                  displayName={providerEntry.displayName}
                  accentColor={providerEntry.accentColor}
                  acpRegistryAgentId={providerEntry.acpRegistryAgentId}
                  acpRegistryIconUrl={providerEntry.acpRegistryIconUrl}
                  size="compact"
                  iconClassName="size-4"
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                  {modelName}
                </span>
                {isEditingQueuedRun ? (
                  <span className="shrink-0 rounded-md bg-black/[0.06] px-1.5 py-0.5 text-4xs font-medium text-foreground/80 dark:bg-white/[0.1]">
                    {gt("Queued edit")}
                  </span>
                ) : null}
                <HeaderChevron className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} aria-hidden />
              </ThreadDetailsControl>

              {headerExpanded ? (
                <div className="mt-1 flex flex-col gap-1.5 px-2.5 pb-0.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="truncate text-2xs font-medium leading-snug text-foreground/80">
                      {subProvider
                        ? `${providerEntry.displayName} · ${subProvider}`
                        : providerEntry.displayName}
                    </span>
                    {version ? (
                      <span className="truncate font-mono text-2xs leading-snug text-muted-foreground">
                        {gt("Version {version}", { version })}
                      </span>
                    ) : null}
                    {advisoryMessage ? (
                      <span
                        className={cn(
                          "flex min-w-0 items-center gap-1.5 text-2xs leading-snug",
                          advisoryTone === "error"
                            ? "text-error-foreground"
                            : "text-warning-foreground",
                        )}
                      >
                        <AlertTriangleIcon
                          className={cn(
                            "size-3 shrink-0",
                            advisoryTone === "error" ? "text-error" : "text-warning",
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate">{advisoryMessage}</span>
                      </span>
                    ) : null}
                  </div>

                  {startsFreshSession ? (
                    <span className="text-2xs leading-snug text-muted-foreground">
                      {gt("Starts a new session on next send")}
                    </span>
                  ) : switchesProvider || switchesModel ? (
                    <span className="text-2xs leading-snug text-muted-foreground">
                      {gt("Switches on next send")}
                    </span>
                  ) : null}

                  <div className="flex min-w-0 items-start gap-2">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        authDotClass(auth.status),
                      )}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-xs leading-snug text-foreground/85">
                        {authPrimaryLabel}
                      </span>
                      {!canSignIn && authEmail ? (
                        <RedactedSensitiveText
                          key={authEmail}
                          value={authEmail}
                          ariaLabel={gt("Toggle account email visibility")}
                          revealTooltip={gt("Click to reveal email")}
                          hideTooltip={gt("Click to hide email")}
                          className="w-fit max-w-full truncate text-left"
                        />
                      ) : !canSignIn && authFallbackDetail ? (
                        <span className="truncate text-2xs leading-snug text-muted-foreground">
                          {authFallbackDetail}
                        </span>
                      ) : null}
                    </div>
                    {canSignIn ? (
                      <ThreadDetailsControl
                        part="meta"
                        tone="primary"
                        onClick={() => onOpenProviderSetup(provider.instanceId)}
                      >
                        <KeyRoundIcon className="size-3" aria-hidden />
                        {gt("Sign in")}
                      </ThreadDetailsControl>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </ThreadDetailsSection>

          {hasUsageSection ? (
            <ThreadDetailsSection
              headingId="thread-details-model-usage-heading"
              title={gt("Usage")}
              showHeading={false}
            >
              <div className="flex flex-col">
                <ThreadDetailsControl
                  size="sm"
                  variant="ghost"
                  part="row"
                  aria-expanded={usageExpanded}
                  onClick={() => setUsageExpanded((current) => !current)}
                >
                  <span className="min-w-0 flex-1 truncate">{gt("Usage")}</span>
                  {usageHeaderSummary ? (
                    <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                      {usageHeaderSummary}
                    </span>
                  ) : null}
                  <UsageChevron className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} aria-hidden />
                </ThreadDetailsControl>

                {usageExpanded ? (
                  <div className="mt-1.5 flex flex-col gap-2 pb-0.5">
                    {displayWindows.map((window) => {
                      const threadUsedPercent = sumThreadUsedPercentForWindow({
                        provider,
                        window,
                        runs: threadRuns,
                      });
                      return (
                        <UsageLimitBarRow
                          key={window.id}
                          window={window}
                          color={accentColor}
                          now={now}
                          threadUsedPercent={threadUsedPercent}
                        />
                      );
                    })}

                    {limitNoticeText ? (
                      <Link
                        to="/usage"
                        className="flex min-h-6 items-center px-2.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {limitNoticeText}
                      </Link>
                    ) : null}

                    {resetCredits && resetCredits.availableCount > 0 ? (
                      <Link
                        to="/usage"
                        className="flex h-6 min-w-0 items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground outline-none hover:bg-black/[0.035] hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-white/[0.08]"
                      >
                        <RotateCcwIcon className="size-3.5 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">
                          {gt(
                            "{count, plural, one {{count} reset credit} other {{count} reset credits}}",
                            { count: resetCredits.availableCount },
                          )}
                        </span>
                      </Link>
                    ) : null}

                    {externalUsage ? (
                      <a
                        href={externalUsage.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex h-6 min-w-0 items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground outline-none hover:bg-black/[0.035] hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-white/[0.08]"
                      >
                        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{externalUsage.label}</span>
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </ThreadDetailsSection>
          ) : null}

          <ThreadDetailsMcpSection
            headingId="thread-details-provider-mcp-heading"
            title={gt("MCP servers")}
            servers={providerMcpServers}
          />

          <CollapsibleNameListSection
            headingId="thread-details-skills-heading"
            title={gt("Skills")}
            items={skillNames}
          />

          <CollapsibleNameListSection
            headingId="thread-details-commands-heading"
            title={gt("Commands")}
            items={commandNames}
            prefix="/"
          />

          {headerExpanded ? (
            <ThreadDetailsModeLimitsSection
              headingId="thread-details-provider-mode-limits-heading"
              title={gt("Provider restrictions")}
              limits={providerModeLimits}
            />
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
