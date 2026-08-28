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
 * `state.messages` at the position the stream put it, and this function READS
 * that position rather than re-deriving one. Re-deriving it from `turnId` would
 * put a third answer next to the other two, and it would be WRONG in exactly the
 * cases the id ordering gets right (two bursts around one answer, a burst whose
 * turn has no user anchor in view).
 *
 * ⚠️ THIS SAID "the reducer owns that position on both the live and the replayed
 * side", WHICH CLAIMS TOO MUCH. The reducer owns the position it assigns;
 * `case "history"`'s cursor MERGE is not the reducer, and it can move rows
 * around a live block. Traced: hold `[u1, r1]` with the turn's answer not yet
 * received, then receive a snapshot `[u1, A1]` — with `reasoningDurable` OFF
 * (the default) that snapshot carries no reasoning row, so `u1` tier-1 matches
 * and walks the cursor past itself, `A1` fresh-inserts after it, and the render
 * is `[u1, A1, r1]` where base drew `[u1, r1, A1]`. Cosmetic only — nothing
 * lost, duplicated or unstable — and a direct consequence of deleting the
 * renderer's `turnId` re-anchor, which is the decision this docblock defends. It
 * is NOT GAP 2b (that is journal position vs live); it is merge-cursor
 * displacement, recorded here because no other site covers it.
 *
 * ⚠️ TOOL ACTIVITY IS NO LONGER INTERLEAVED EITHER (#242 half 3), and this
 * function now has NO second lane at all. The paragraph that used to sit here
 * said tool was "still EPHEMERAL … `turnId` is the only anchor there is" and
 * promised that half 3 "should lose the second lane the same way it just lost
 * the first". That is exactly what happened: tool activity is a durable message
 * now, it sits in `state.messages` at the position the stream put it, and the
 * `toolActivity` parameter — along with the `toolByTurn` grouping, the `emitted`
 * set and the trailing orphan-turn drain — is gone rather than left inert.
 *
 * The two callers' argument lists shrink accordingly; that is the point. A
 * renderer that can still be HANDED a side array is a renderer that can still
 * hold a second opinion about ordering.
 *
 * ⚠️ THE CURSOR-DISPLACEMENT NOTE ABOVE APPLIES TO TOOL ROWS TOO, with one
 * difference worth stating: it was written for reasoning, whose snapshot rows
 * are absent by DEFAULT (`reasoningDurable` is off), so the displacement it
 * traces is the common case there. Tool durability has no such opt-in, so a
 * tool row is normally PRESENT in the snapshot and tier-1 matches — the
 * displacement is reachable for tool only in the narrower window where the
 * snapshot predates the call.
 */
export function orderConversationPresentation(
  messages: readonly ChatMessage[],
): ConversationPresentationItem[] {
  const result: ConversationPresentationItem[] = [];
  for (const message of messages) {
    // Each kind in place, from the array — no turn lookup and no grouping.
    if (message.kind === "reasoning") {
      result.push({
        kind: "reasoning",
        value: { id: message.id, turnId: message.turnId, text: message.text },
      });
      continue;
    }
    if (message.kind === "tool") {
      result.push({
        kind: "tool_activity",
        value: {
          id: message.id,
          turnId: message.turnId,
          ...(message.name !== undefined ? { name: message.name } : {}),
          ...(message.phase !== undefined ? { phase: message.phase } : {}),
          ...(message.status !== undefined ? { status: message.status } : {}),
          ...(message.summary !== undefined ? { summary: message.summary } : {}),
          ...(message.argKeys !== undefined ? { argKeys: message.argKeys } : {}),
        },
      });
      continue;
    }
    result.push({ kind: "message", value: message });
  }
  return result;
}

/**
 * The widget's "load older" page size — ONE definition, imported by both the
 * widget and `history-paging.test.ts`.
 *
 * ⚠️ IT LIVES HERE BECAUSE THE TEST'S CLAIM DEPENDS ON IT. That test says a
 * future page-size change "cannot silently move the cliff without moving this
 * test", and while the widget had `limit: 20` inline and the test had its own
 * `WIDGET_LIMIT = 20`, that was false — the two literals could drift and the
 * test would stay green while measuring a boundary the widget no longer uses.
 * Exporting the constant is what makes the sentence true, which is cheaper than
 * deleting it.
 */
export const HISTORY_PAGE_SIZE = 20;

/**
 * The `before` cursor for a "load older" request: the IDENTITY of the OLDEST
 * entry this device holds that the server could plausibly resolve, or
 * `undefined` to ask for the tail.
 *
 * ⚠️ IT RETURNS AN IDENTITY, NOT A BARE ID (#320). A tool row is addressed by the
 * PAIR `(turnId, id)` everywhere the view keys on it — `applyTool` upserts on
 * exactly that pair — and a tool id is turn-local on both of its paths, so an
 * id-only cursor over one can name two rows and `historyPageBefore` refuses it as
 * ambiguous. That refusal is honest but it STOPS paging, which is the regression
 * #320 repairs: `turnId` travels with the id and the pair resolves.
 *
 * ⚠️ `turnId` IS POPULATED FOR `kind === "tool"` ONLY, AND THAT IS DELIBERATE.
 * A reasoning row also carries a `turnId`, but its id is `nextMessageId()`-minted
 * (`message-adapter.ts`), so nothing WE mint can collide with it and pairing buys
 * no disambiguation in ordinary operation — while adding a second field that must
 * agree with the projection for the cursor to resolve at all.
 *
 * ⚠️ THIS USED TO END "NARROWER CURSOR, SAME REACH", AND THE REACH IS NOT QUITE
 * THE SAME — the residual is stated rather than softened. Inbound user ids are
 * client-supplied and validated only as non-empty strings (**#293**), and
 * `ingress-dedupe.ts` journals that wire id VERBATIM, so a peer can send a
 * `user_message` whose id equals a plugin-minted reasoning id. That id is then
 * duplicated in the projection, and an id-only reasoning cursor is refused as
 * ambiguous where a paired one would have separated the two (`rowTurnId` is
 * `undefined` for the text row).
 *
 * The widening is KNOWN AND DELIBERATELY NOT TAKEN, on the difference between
 * the two collisions: a tool collision arises from ORDINARY OPERATION — tool ids
 * are turn-local on both of their paths, so one ordinary conversation produces
 * it — whereas a reasoning collision requires a peer to echo back an id we
 * minted, which is self-inflicted and is tracked as #293. Reasoning stays
 * id-only; the cost is that one self-inflicted case stops paging honestly
 * instead of resolving.
 *
 * ⚠️ AND NO KIND IS SKIPPED — the pick still returns the oldest entry whatever it
 * is. Skipping a kind is the deadlock documented at length below; carrying an
 * extra field is not skipping.
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
 * projection WHEN THE ACCOUNT OPTED INTO `capabilities.reasoningDurable`, and
 * `historyPageBefore` resolves by `findIndex` over the emitted list with no
 * policy branch on `kind` — every variant is served by the same rule. (Since
 * #320 it reads `kind` to find a row's `turnId`; that is a field lookup on a
 * discriminated union, not a preference between kinds.)
 *
 * ⚠️ THAT QUALIFIER IS NOT A HEDGE — the opt-in DEFAULTS OFF, so in the default
 * configuration a live reasoning id is in NO projection at all. Stating it
 * unconditionally would have made this paragraph read as the safety argument for
 * every deployment when it is the argument for one of them. The default case is
 * covered by the paragraph below instead, and by the same rule: an unresolvable
 * cursor is the empty page, which is honest, whereas the skip was a stall.
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
): { id: string; turnId?: string } | undefined {
  const oldest = messages.find((m) => !m.working && !m.pending && !m.retracted);
  if (!oldest) return undefined;
  return oldest.kind === "tool"
    ? { id: oldest.id, turnId: oldest.turnId }
    : { id: oldest.id };
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
