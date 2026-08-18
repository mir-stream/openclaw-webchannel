import type {
  ChatMessage,
  ReasoningItem,
  ToolActivityItem,
} from "../../../packages/client/src/types.js";

export type ConversationPresentationItem =
  | { kind: "message"; value: ChatMessage }
  | { kind: "reasoning"; value: ReasoningItem }
  | { kind: "tool_activity"; value: ToolActivityItem };

/**
 * Place ephemeral reasoning and tool activity (#97) after their user anchor and
 * before their turn answer. Both lanes correlate by `turnId`; tool activity is
 * emitted right after any reasoning for the same turn so it reads as
 * subordinate, live turn detail.
 */
export function orderConversationPresentation(
  messages: readonly ChatMessage[],
  reasoning: readonly ReasoningItem[],
  toolActivity: readonly ToolActivityItem[] = [],
): ConversationPresentationItem[] {
  const reasoningByTurn = new Map<string, ReasoningItem[]>();
  for (const item of reasoning) {
    const items = reasoningByTurn.get(item.turnId) ?? [];
    items.push(item);
    reasoningByTurn.set(item.turnId, items);
  }
  const toolByTurn = new Map<string, ToolActivityItem[]>();
  for (const item of toolActivity) {
    const items = toolByTurn.get(item.turnId) ?? [];
    items.push(item);
    toolByTurn.set(item.turnId, items);
  }
  const emitted = new Set<string>();
  const result: ConversationPresentationItem[] = [];
  const emitTurnLanes = (turnId: string): void => {
    if (emitted.has(turnId)) return;
    const reasoningItems = reasoningByTurn.get(turnId);
    const toolItems = toolByTurn.get(turnId);
    if (!reasoningItems && !toolItems) return;
    emitted.add(turnId);
    if (reasoningItems) {
      result.push(...reasoningItems.map((value) => ({ kind: "reasoning" as const, value })));
    }
    if (toolItems) {
      result.push(...toolItems.map((value) => ({ kind: "tool_activity" as const, value })));
    }
  };

  for (const message of messages) {
    if (message.role === "agent" && message.turnId) emitTurnLanes(message.turnId);
    result.push({ kind: "message", value: message });
    if (message.role === "user" && message.turnId) emitTurnLanes(message.turnId);
  }
  for (const turnId of reasoningByTurn.keys()) emitTurnLanes(turnId);
  for (const turnId of toolByTurn.keys()) emitTurnLanes(turnId);
  return result;
}

/**
 * #97: compose the single-line label for a tool-activity chip. Pure so the
 * ordering/formatting is unit-testable and never touches the DOM. Shape:
 *   `🔧 {name} — {status ?? phase}` then ` ({argKeys})` then ` · {summary}`.
 * Only argument KEY NAMES appear — never arg values (they never reach the
 * client). Missing pieces are omitted.
 */
export function formatToolActivityLine(item: ToolActivityItem): string {
  const head = `🔧 ${item.name ?? "tool"}`;
  const state = item.status ?? item.phase;
  const withState = state ? `${head} — ${state}` : head;
  const withKeys =
    item.argKeys && item.argKeys.length > 0
      ? `${withState} (${item.argKeys.join(", ")})`
      : withState;
  return item.summary ? `${withKeys} · ${item.summary}` : withKeys;
}

/**
 * Build one tool-activity chip as a muted, visually-subordinate line. XSS-safe
 * by construction: only `textContent` and appended elements are used, never
 * `innerHTML`. Mirrors `buildReasoningDetails`' sanitize-by-construction rule.
 */
export function buildToolActivityChip(item: ToolActivityItem): HTMLDivElement {
  const chip = document.createElement("div");
  chip.dataset.toolActivityId = item.id;
  chip.setAttribute(
    "style",
    "align-self:flex-start;max-width:85%;padding:5px 9px;border-radius:8px;" +
      "font-size:12px;background:#161b22;border:1px solid var(--border);color:var(--muted)",
  );
  chip.textContent = formatToolActivityLine(item);
  return chip;
}

/**
 * Collect the ids of currently-EXPANDED reasoning lanes in `container`. The
 * widget rebuilds the whole transcript with `replaceChildren()` each render, so
 * it must snapshot which `<details>` the user opened BEFORE replacement and
 * restore `open` on the rebuilt nodes — otherwise a streaming reasoning update
 * would snap an expanded lane closed. Pairs with `buildReasoningDetails`.
 */
export function captureOpenReasoningIds(container: ParentNode): Set<string> {
  return new Set(
    Array.from(
      container.querySelectorAll<HTMLDetailsElement>("details[data-reasoning-id][open]"),
    ).map((node) => node.dataset.reasoningId ?? ""),
  );
}

/**
 * Build one reasoning lane as a collapsed `<details data-reasoning-id>` with a
 * neutral `Reasoning` summary and the pre-rendered (sanitize-by-construction)
 * markdown `body`. `open` restores the user's prior expand/collapse choice (see
 * `captureOpenReasoningIds`). XSS safety is inherited from the caller's markdown
 * renderer — this builder only ever appends the given element and text nodes,
 * never `innerHTML`.
 */
export function buildReasoningDetails(
  item: ReasoningItem,
  body: HTMLElement,
  open: boolean,
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.dataset.reasoningId = item.id;
  details.setAttribute(
    "style",
    "align-self:flex-start;max-width:85%;padding:7px 10px;border-radius:8px;" +
      "font-size:12px;background:#161b22;border:1px solid var(--border);color:var(--muted)",
  );
  const summary = document.createElement("summary");
  summary.setAttribute("style", "cursor:pointer;font-weight:600");
  summary.textContent = "Reasoning";
  const bodyWrap = document.createElement("div");
  bodyWrap.setAttribute("style", "margin-top:7px;color:var(--fg)");
  bodyWrap.append(body);
  details.append(summary, bodyWrap);
  details.open = open;
  return details;
}
