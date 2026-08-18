import type { ChatMessage, ReasoningItem } from "../../../packages/client/src/types.js";

/**
 * #96: whether the composer should show an in-flight affordance (the Stop
 * button). `isTyping`/`working` both go false in the gaps between bubbles of a
 * multi-step turn, which is the "silence indistinguishable from completion" #96
 * reports; `turnActive` stays true across those gaps until the turn settles.
 * Semantics live in `WebChannelState.turnActive` + the client README's "Turn
 * activity" section — this is only the widget-side consumption. `turnActive` is
 * advisory and deliberately NOT part of the library's `turnInFlight()`, so the
 * wiring belongs here, not there.
 */
export function composerInFlight(state: {
  isTyping?: boolean;
  turnActive?: boolean;
  messages: readonly ChatMessage[];
}): boolean {
  return (
    state.isTyping === true ||
    state.turnActive === true ||
    state.messages.some((m) => m.working)
  );
}

/**
 * #96: the transcript-tail activity line, or `null` for none.
 *
 * `isTyping` ("an answer is being composed right now") keeps its base behavior
 * exactly: the reasoning gate belongs to the "agent is typing…" line ALONE,
 * because a live reasoning lane is that same signal in richer form. It must NOT
 * gate the gap hint: `state.reasoning` is a rolling buffer with no liveness
 * notion, so one reasoning frame anywhere in the turn would otherwise suppress
 * the gap hint for the rest of it — exactly the case #96 is about.
 *
 * In the gap (`turnActive` true, nothing typing) the line softens to "still
 * working…", except when something louder already speaks for the turn: a live
 * `working` draft renders its own in-progress bubble, and an unresolved approval
 * card takes priority over both (the turn is blocked on the USER, not working).
 */
export function activityHint(state: {
  isTyping?: boolean;
  turnActive?: boolean;
  messages: readonly ChatMessage[];
  reasoning: readonly ReasoningItem[];
  approvals: readonly { resolvedDecision?: unknown }[];
}): string | null {
  // P1-9: skip pending/retracted user bubbles — they have no turnId, and letting
  // one become `latestUser` would resurrect the "agent is typing…" line next to
  // a live reasoning lane.
  const latestUser = [...state.messages].reverse().find(
    (m) => m.role === "user" && !m.pending && !m.retracted,
  );
  const reasoningReplacesTyping = Boolean(
    latestUser?.turnId && state.reasoning.some((item) => item.turnId === latestUser.turnId),
  );
  if (state.isTyping === true) return reasoningReplacesTyping ? null : "agent is typing…";
  if (state.turnActive !== true) return null;
  if (state.messages.some((m) => m.working)) return null;
  if (state.approvals.some((a) => a.resolvedDecision === undefined)) return null;
  return "still working…";
}

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
