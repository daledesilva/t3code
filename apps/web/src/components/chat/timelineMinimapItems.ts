import {
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type OrchestrationV2Run,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  assistantCitationsToPlainText,
  splitsSurrogatePair,
} from "@t3tools/shared/assistantCitations";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import {
  resolveRunUsageLimitWindows,
  type RunUsageLimitWindowDelta,
} from "@t3tools/shared/usageLimits";
import type { Nodes } from "hast";

import { markdownTree } from "~/markdown/wordsHast";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export type TimelineMinimapRun = Pick<
  OrchestrationV2Run,
  "id" | "providerInstanceId" | "modelSelection"
> &
  Partial<Pick<OrchestrationV2Run, "userMessageId" | "usageLimitsBefore" | "usageLimitsAfter">>;

export interface TimelineMinimapUsage {
  readonly driver: ServerProvider["driver"];
  readonly providerLabel: string;
  readonly accentColor?: string | undefined;
  readonly windows: ReadonlyArray<RunUsageLimitWindowDelta>;
}

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
  readonly usage?: TimelineMinimapUsage | null;
}

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
  runs?: ReadonlyArray<TimelineMinimapRun>,
  providers?: ReadonlyArray<ServerProvider>,
): TimelineMinimapItem[] {
  const runByUserMessageId = new Map<string, TimelineMinimapRun>();
  for (const run of runs ?? []) {
    if (run.userMessageId) {
      runByUserMessageId.set(run.userMessageId, run);
    }
  }
  const providerByInstanceId = new Map<string, ServerProvider>();
  for (const provider of providers ?? []) {
    providerByInstanceId.set(provider.instanceId, provider);
  }

  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    const run = runByUserMessageId.get(row.message.id);
    let usage: TimelineMinimapUsage | undefined;
    if (run?.usageLimitsAfter) {
      const provider = providerByInstanceId.get(run.providerInstanceId);
      const driver = provider?.driver ?? ProviderDriverKind.make(String(run.providerInstanceId));
      const windows = resolveRunUsageLimitWindows({
        driver,
        model: run.modelSelection.model,
        before: run.usageLimitsBefore,
        after: run.usageLimitsAfter,
      });
      if (windows.length > 0) {
        const providerLabel =
          provider?.displayName?.trim() || PROVIDER_DISPLAY_NAMES[driver] || String(driver);
        usage = {
          driver,
          providerLabel,
          accentColor: provider?.accentColor,
          windows,
        };
      }
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: isAttachmentOnlyBootstrapPrompt(row.message.text) ? "" : row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
      ...(usage ? { usage } : {}),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

// Elements whose children run together; every other element is separated by a space.
// A tight list item holds its text bare, without the paragraph a loose one wraps it in.
const INLINE_PARENTS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "td",
  "th",
  "em",
  "strong",
  "del",
  "a",
  "code",
  "span",
  "sup",
  "sub",
]);

function markdownNodeText(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "element" && node.tagName === "br") return " ";
  if (node.type === "element" && node.tagName === "img") return String(node.properties.alt ?? "");
  if (node.type !== "element" && node.type !== "root") return "";
  // Footnote markers and the footnote list are not part of the message's prose.
  if (
    node.type === "element" &&
    (node.properties.dataFootnotes !== undefined || node.properties.dataFootnoteRef !== undefined)
  )
    return "";
  const separator = node.type === "element" && INLINE_PARENTS.has(node.tagName) ? "" : " ";
  const text = node.children.map(markdownNodeText).join(separator);
  // A thread autolink's only text is its URL.
  return node.type === "element" && node.tagName === "a" && parseThreadLinkHref(text) !== null
    ? "a thread"
    : text;
}

/** Markdown as one line of the text it renders, without markup or link targets. */
export function markdownPlainText(markdown: string): string {
  return markdownNodeText(markdownTree(markdown)).replace(/\s+/g, " ").trim();
}

// The tooltip shows a few lines; bound parsing work for long messages and streaming responses.
function markdownMinimapPreview(markdown: string | null) {
  if (markdown === null) return null;
  const compact = markdownPlainText(
    markdown.slice(0, splitsSurrogatePair(markdown, 1_500) ? 1_499 : 1_500),
  );
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        // Before markdown parsing, which would reduce a citation link to "Assistant quote".
        userText: markdownMinimapPreview(
          item.userText === null
            ? null
            : assistantCitationsToPlainText(
                replaceComposerContextReferences(item.userText, (reference) => reference.label),
              ),
        ),
        assistantText: markdownMinimapPreview(item.assistantText),
      };
}
