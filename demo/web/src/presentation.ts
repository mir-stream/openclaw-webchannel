import type { ChatMessage, ReasoningItem } from "../../../packages/client/src/types.js";

export type ConversationPresentationItem =
  | { kind: "message"; value: ChatMessage }
  | { kind: "reasoning"; value: ReasoningItem };

/** Place ephemeral reasoning after its user anchor and before its turn answer. */
export function orderConversationPresentation(
  messages: readonly ChatMessage[],
  reasoning: readonly ReasoningItem[],
): ConversationPresentationItem[] {
  const byTurn = new Map<string, ReasoningItem[]>();
  for (const item of reasoning) {
    const items = byTurn.get(item.turnId) ?? [];
    items.push(item);
    byTurn.set(item.turnId, items);
  }
  const emitted = new Set<string>();
  const result: ConversationPresentationItem[] = [];
  const emitReasoning = (turnId: string): void => {
    if (emitted.has(turnId)) return;
    const items = byTurn.get(turnId);
    if (!items) return;
    emitted.add(turnId);
    result.push(...items.map((value) => ({ kind: "reasoning" as const, value })));
  };

  for (const message of messages) {
    if (message.role === "agent" && message.turnId) emitReasoning(message.turnId);
    result.push({ kind: "message", value: message });
    if (message.role === "user" && message.turnId) emitReasoning(message.turnId);
  }
  for (const turnId of byTurn.keys()) emitReasoning(turnId);
  return result;
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
