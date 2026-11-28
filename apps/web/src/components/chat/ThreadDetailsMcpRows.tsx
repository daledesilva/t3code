import type { ProviderMcpServer, ProviderRuntimeModeLimit } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_CHEVRON_CLASS } from "./threadDetailsPanelStyles";

function mcpStatusDotClass(status: ProviderMcpServer["status"]): string {
  switch (status) {
    case "connected":
    case "configured":
      return "bg-emerald-500";
    case "needs-auth":
      return "bg-warning";
    case "failed":
      return "bg-destructive";
    case "disabled":
      return "bg-muted-foreground/40";
  }
}

function McpServerRow({
  server,
  showSource,
}: {
  readonly server: ProviderMcpServer;
  readonly showSource: boolean;
}) {
  const gt = useGT();
  const statusLabel = (() => {
    switch (server.status) {
      case "connected":
        return gt("Connected", { $context: "MCP server status" });
      case "configured":
        return gt("Ready", { $context: "MCP server status" });
      case "needs-auth":
        return gt("Needs sign-in", { $context: "MCP server status" });
      case "failed":
        return gt("Failed", { $context: "MCP server status" });
      case "disabled":
        return gt("Disabled", { $context: "MCP server status" });
    }
  })();

  const trailingLabel = showSource
    ? (server.source ?? server.transport ?? statusLabel)
    : server.status === "disabled" || server.status === "needs-auth" || server.status === "failed"
      ? statusLabel
      : (server.transport ?? statusLabel);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            className="flex h-6 min-w-0 cursor-default items-center gap-2 rounded-lg px-2.5 text-xs outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-white/[0.08]"
          />
        }
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", mcpStatusDotClass(server.status))}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-medium",
            server.enabled ? "text-foreground/85" : "text-muted-foreground line-through",
          )}
        >
          {server.name}
        </span>
        <span className="max-w-28 shrink-0 truncate text-2xs text-muted-foreground">
          {trailingLabel}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{server.name}</span>
          <span className="text-muted-foreground">{statusLabel}</span>
          {server.source ? (
            <span className="font-mono text-2xs text-muted-foreground">{server.source}</span>
          ) : null}
          {server.transport ? (
            <span className="text-muted-foreground">
              {gt("Transport: {transport}", { transport: server.transport })}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function ThreadDetailsMcpSection({
  headingId,
  title,
  servers,
  showSource = false,
  separated = true,
  defaultExpanded = false,
}: {
  readonly headingId: string;
  readonly title: string;
  readonly servers: ReadonlyArray<ProviderMcpServer>;
  readonly showSource?: boolean;
  readonly separated?: boolean;
  readonly defaultExpanded?: boolean;
}) {
  const [sectionExpanded, setSectionExpanded] = useState(defaultExpanded);

  if (servers.length === 0) return null;

  const Chevron = sectionExpanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <ThreadDetailsSection
      headingId={headingId}
      title={title}
      separated={separated}
      showHeading={false}
    >
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
            {servers.length}
          </span>
          <Chevron className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} aria-hidden />
        </ThreadDetailsControl>
        {sectionExpanded ? (
          <div className="mt-0.5 flex flex-col">
            {servers.map((server) => (
              <McpServerRow
                key={`${server.scope}:${server.name}`}
                server={server}
                showSource={showSource}
              />
            ))}
          </div>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

export function ThreadDetailsModeLimitsSection({
  headingId,
  title,
  limits,
  separated = true,
}: {
  readonly headingId: string;
  readonly title: string;
  readonly limits: ReadonlyArray<ProviderRuntimeModeLimit>;
  readonly separated?: boolean;
}) {
  const gt = useGT();
  if (limits.length === 0) return null;

  const modeLabel = (mode: ProviderRuntimeModeLimit["mode"]) => {
    switch (mode) {
      case "approval-required":
        return gt("Approval required");
      case "auto-accept-edits":
        return gt("Auto-accept edits");
      case "auto":
        return gt("Auto");
      case "full-access":
        return gt("Full access");
    }
  };

  const reasonLabel = (reason: ProviderRuntimeModeLimit["reason"]) => {
    switch (reason) {
      case "managed-settings":
        return gt("Disabled by managed settings");
      case "user-settings":
        return gt("Disabled by user settings");
      case "project-settings":
        return gt("Disabled by project settings");
      case "settings":
        return gt("Disabled by settings");
    }
  };

  return (
    <ThreadDetailsSection
      headingId={headingId}
      title={title}
      separated={separated}
      showHeading={false}
    >
      <div className="flex flex-col gap-0.5">
        {limits.map((limit) => (
          <Tooltip key={`${limit.mode}:${limit.reason}`}>
            <TooltipTrigger
              render={
                <div
                  tabIndex={0}
                  className="flex min-h-6 cursor-default items-center gap-2 rounded-lg px-2.5 py-0.5 text-xs text-warning-foreground outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-white/[0.08]"
                />
              }
            >
              <ShieldAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {gt("{mode} restricted", { mode: modeLabel(limit.mode) })}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="left" sideOffset={16}>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">{modeLabel(limit.mode)}</span>
                <span className="text-muted-foreground">{reasonLabel(limit.reason)}</span>
              </div>
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
