import type {
  ApprovalRequest,
  ChatBubble,
  ChatMessage,
  ReasoningItem,
  ToolActivityItem,
} from "../../../packages/client/src/types.js";

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
 * Which affordance the primary composer button offers, for the given state AND
 * the current draft. Text in the composer is unambiguous Send intent — Enter
 * already sends it — so the button only offers Stop on an empty composer.
 * Deriving the label from the draft (rather than guarding inside the click
 * handler) is what keeps the label honest: it always states exactly what a click
 * will do, so a user who means to abort never publishes a stray message and a
 * user who means to send never aborts the turn.
 */
export function composerButtonMode(
  state: { isTyping?: boolean; turnActive?: boolean; messages: readonly ChatMessage[] },
  draft: string,
): "send" | "stop" {
  return draft.trim() === "" && composerInFlight(state) ? "stop" : "send";
}

/**
 * #96: the transcript-tail activity line, or `null` for none.
 *
 * `isTyping` ("an answer is being composed right now") keeps its base behavior
 * exactly: the reasoning gate belongs to the "agent is typing…" line ALONE,
 * because a live reasoning lane is that same signal in richer form. It must NOT
 * gate the gap hint: `state.reasoning` carries no liveness notion, so one
 * reasoning block anywhere in the turn would otherwise suppress the gap hint for
 * the rest of it — exactly the case #96 is about.
 *
 * ⚠️ THAT ARGUMENT GOT STRONGER, NOT WEAKER, IN #242 half 2 — check it before
 * "simplifying" this. `state.reasoning` used to be a capped rolling buffer; it
 * is now DERIVED from `state.messages` and UNCAPPED, so it also holds blocks
 * REPLAYED FROM HISTORY. The turn-scoped match is what keeps that harmless: it
 * compares against `latestUser.turnId`, and a history-hydrated user row is
 * fresh-inserted WITHOUT a `turnId` (`case "history"` emits exactly
 * `{id, role, text, ts, working}`), so a reload cannot make an old block speak
 * for a new turn. Dropping the turn scope would.
 *
 * In the gap (`turnActive` true, nothing typing) the line softens to "still
 * working…", except when something louder already speaks for the turn: a live
 * `working` draft renders its own in-progress bubble, and an unresolved approval
 * card takes priority over the gap hint (the turn is blocked on the USER, not
 * working). The approval check is scoped to the gap hint alone — the typing line
 * keeps its base behavior, where an approval frame clears `isTyping` anyway.
 */
export function activityHint(state: {
  isTyping?: boolean;
  turnActive?: boolean;
  messages: readonly ChatMessage[];
  reasoning: readonly ReasoningItem[];
  approvals: readonly Pick<ApprovalRequest, "resolvedDecision">[];
}): string | null {
  if (state.isTyping === true) {
    // P1-9: skip pending/retracted user bubbles — they have no turnId, and
    // letting one become `latestUser` would resurrect the "agent is typing…"
    // line next to a live reasoning lane.
    const latestUser = [...state.messages].reverse().find(
      (m) => m.role === "user" && !m.pending && !m.retracted,
    );
    const reasoningReplacesTyping = Boolean(
      latestUser?.turnId && state.reasoning.some((item) => item.turnId === latestUser.turnId),
    );
    return reasoningReplacesTyping ? null : "agent is typing…";
  }
  if (state.turnActive !== true) return null;
  if (state.messages.some((m) => m.working)) return null;
  if (state.approvals.some((a) => a.resolvedDecision === undefined)) return null;
  return "still working…";
}

/**
 * One drawable row.
 *
 * ⚠️ `message` CARRIES A `ChatBubble`, NOT A `ChatMessage` — that narrowing is
 * where the widget's compile-time safety against drawing a reasoning block as an
 * agent bubble lives (#242 half 2; `ChatMessage`'s docblock explains why the
 * union itself is readable without narrowing). A widget cannot reach `m.role`
 * or `m.text` here without first switching on this `kind`.
 */
export type ConversationPresentationItem =
  | { kind: "message"; value: ChatBubble }
  | { kind: "reasoning"; value: ReasoningItem }
  | { kind: "tool_activity"; value: ToolActivityItem };

/**
 * Order the transcript for rendering.
 *
 * ⚠️ REASONING IS NO LONGER INTERLEAVED HERE (#242 half 2). This function used
 * to take a separate `reasoning` array and place each burst after its user
 * anchor by `turnId`, grouped per turn — a SECOND opinion about ordering, held
 * by the renderer. Reasoning is a durable message now: it sits in
 * `state.messages` at the position the stream put it, and the reducer owns that
 * position on both the live and the replayed side. Re-deriving it from `turnId`
 * would put a third answer next to those two, and it would be WRONG in exactly
 * the cases the id ordering gets right (two bursts around one answer, a burst
 * whose turn has no user anchor in view).
 *
 * ⚠️ TOOL ACTIVITY IS STILL INTERLEAVED, and that is not an inconsistency: it is
 * still EPHEMERAL (`#242 half 3` is what makes it durable), so it lives in its
 * own array with no position of its own and `turnId` is the only anchor there
 * is. When half 3 lands, this function should lose the second lane the same way
 * it just lost the first.
 */
export function orderConversationPresentation(
  messages: readonly ChatMessage[],
  toolActivity: readonly ToolActivityItem[] = [],
): ConversationPresentationItem[] {
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
    const toolItems = toolByTurn.get(turnId);
    if (!toolItems) return;
    emitted.add(turnId);
    result.push(...toolItems.map((value) => ({ kind: "tool_activity" as const, value })));
  };

  for (const message of messages) {
    if (message.kind === "reasoning") {
      // In place, from the array — no turn lookup and no grouping.
      result.push({
        kind: "reasoning",
        value: { id: message.id, turnId: message.turnId, text: message.text },
      });
      continue;
    }
    if (message.role === "agent" && message.turnId) emitTurnLanes(message.turnId);
    result.push({ kind: "message", value: message });
    if (message.role === "user" && message.turnId) emitTurnLanes(message.turnId);
  }
  for (const turnId of toolByTurn.keys()) emitTurnLanes(turnId);
  return result;
}

/**
 * The `before` cursor for a "load older" request: the id of the OLDEST entry
 * this device holds that the server could plausibly resolve, or `undefined` to
 * ask for the tail.
 *
 * Extracted from `widget.ts`'s `historyBtn.onclick` so the paging LOOP is
 * testable end to end — see `history-paging.test.ts`, which drives this picker
 * against the plugin's real `historyPageBefore` and the client's real
 * `case "history"` merge. It was inline, and the defect it hid was invisible to
 * every unit test in the repo.
 *
 * P1-9: a local-only id (held `pending` / `retracted`) must never be sent as a
 * `before` cursor — those were never on the wire and are never in the journal.
 * A `working` draft is skipped for the same reason.
 *
 * ⚠️ A REASONING ROW IS A LEGITIMATE CURSOR, AND SKIPPING IT DEADLOCKS THE
 * BUTTON. #242 half 2 first added `m.kind === undefined` to this predicate,
 * reasoning that a live reasoning id might not be in the journal. That is a
 * DEFECT, and the test file above reproduces it: once the `limit` rows
 * immediately preceding the oldest held bubble are all reasoning, the oldest
 * cursorable entry never changes, every click re-serves a page the client
 * already holds, every row tier-1 matches — and the rest of the conversation
 * becomes permanently unreachable. Measured at the widget's own `limit: 20`
 * against `[u0, r1…r30, A]`: five clicks, cursor `A` every time, `u0` never
 * reached. The cliff is exactly at run length `limit`.
 *
 * The property that makes a reasoning id safe was verified against the REAL
 * pager rather than assumed: a reasoning id is PLUGIN-minted, appears in the
 * projection, and `historyPageBefore` resolves by `findIndex` over the emitted
 * list without ever reading `kind`.
 *
 * ⚠️ AND THE WORRY THAT MOTIVATED THE SKIP WAS NOT NEW TO REASONING — that is
 * why it does not justify one. A published local user echo keeps its `u-<n>` id
 * until a snapshot adopts it, while the accept seam journals the inbound WIRE
 * id, so this predicate has ALWAYS been able to return an id the journal does
 * not hold. The answer then and now is `historyPageBefore`'s stated contract:
 * an unresolvable cursor is the empty page, which the client treats as "no more
 * history". A stall is strictly worse than that, because it is indistinguishable
 * from it while hiding content that does exist.
 */
export function oldestHistoryCursor(
  messages: readonly ChatMessage[],
): string | undefined {
  return messages.find((m) => !m.working && !m.pending && !m.retracted)?.id;
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
