/**
 * WebChannel NATS Client Wrapper — public browser-facing state adapter.
 *
 * This module wraps `WebChannelNatsClient` with transcript, approval, progress,
 * and subscription state suitable for UI integrations.
 *
 * Changes from gateway-WS:
 * - No WebSocket connection to /webchannel/ws
 * - NATS WebSocket connection with JWT authentication
 * - Per-peer NATS subjects instead of single socket
 * - Message format preserved (compatible with existing UI)
 */

import type {
  WebChannelOptions,
  WebChannelState,
  WebChannelErrorCause,
  Listener,
  ApprovalDecision,
  ApprovalOption,
  ChatApprovalMessage,
  ChatBubble,
  ChatMessage,
  ChatReasoningMessage,
  ChatToolMessage,
  ReasoningItem,
  ToolActivityItem,
  ApprovalRequest,
  SendReceipt,
  SendFailure,
  SendState,
} from "./types.js";
import {
  WebChannelNatsClient,
  randomInboxToken,
  type WebChannelNatsClientOptions as DirectClientOptions,
  type InboundMessage,
} from "./nats-client.js";
import {
  applyDurableEvent,
  projectDurableFromClient,
  type DurableEvent,
  type DurableView,
} from "./durable-view-reducer.js";

/**
 * P0-4: the state a `SendReceipt` observes. A separate `receiptKey`-keyed record
 * (not the render bubble) is authoritative: it survives `retract()` removing the
 * bubble and history adoption rewriting the bubble's `id`, so `snapshot()` never
 * loses its backing or reports a stuck `queued`. The render bubble's
 * `sendState`/`sendFailure` mirror this record for the UI.
 */
type ReceiptRecord = {
  id: string;
  /** Assigned at immediate publish or held release; absent while still held. */
  wireId?: string;
  /** Whether this user publish can produce a `turn_settled` frame. */
  settlementEligible: boolean;
  /** One-way latch: the first authoritative publish/settle decision consumes it. */
  turnOpeningConsumed: boolean;
  state: NonNullable<ChatMessage["sendState"]>;
  failure?: SendFailure;
  // P0-4 (review R5): mirrors `SendReceipt.snapshot()` — a concrete, non-optional
  // state (a record always has one), so consumers never narrow an impossible
  // `undefined`.
  subscribers: Set<(s: { state: NonNullable<ChatMessage["sendState"]>; failure?: SendFailure }) => void>;
  /** Nested transitions wait until the current bubble/subscriber fanout ends. */
  pendingTransitions: Array<{
    state: NonNullable<ChatMessage["sendState"]>;
    failure?: SendFailure;
    extraBubblePatch?: Partial<ChatBubble>;
  }>;
  drainingTransitions: boolean;
};

/** Frozen before outcome fanout, which may synchronously mutate `openTurns`. */
type TurnSettlementPlacement = {
  openPrefix: string[];
};

/**
 * Wrapper operations admitted after connect() is requested from inside close().
 * They share one FIFO so no operation can target the still-live old session or
 * overtake a user/control publish while the replacement queue is committed.
 */
type DeferredReplacementOperation =
  | {
      kind: "user";
      localId: string;
      text: string;
      receiptKey: string;
    }
  | { kind: "approval-decision"; id: string; decision: ApprovalDecision }
  | { kind: "load-history"; before?: string; beforeTurnId?: string; limit?: number }
  | { kind: "load-commands" };

function normalizeAssistantMessageIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * #244 half B — the inbound frame types that carry a per-conversation `seq`, i.e.
 * the DURABLE frames the plugin stamps `seq` on. `isSeqBearingFrame`
 * (`delivery-journal-event.ts`) is the server-side twin of the OUTBOUND seven,
 * and its drift test pins those seven against the journal mapper — it does NOT
 * pin this list, which has an eighth member: `user_committed`, which that
 * predicate explicitly REJECTS (its seq is set at construction, not stamped at
 * egress). Seven plus that echo is what makes this client's stream contiguous.
 * These are the frames gap detection watches and the ones held while a
 * `get_difference` is outstanding. A frame of one of these types WITHOUT a `seq`
 * (an id-less `agent_message`, a live reasoning DRAFT) is still handled normally —
 * it just carries no cursor, so it neither advances nor gaps.
 */
const SEQ_BEARING_INBOUND_TYPES: ReadonlySet<string> = new Set([
  "agent_message",
  "progress",
  "turn_snapshot",
  "reasoning",
  "tool_activity",
  "approval_request",
  "approval_resolved",
  // #245 Part B: the multi-device user-message broadcast carries the user opener's
  // `seq`, so it drives gap detection and advances the cursor like any durable
  // frame — a non-origin device that receives it stays contiguous with the turn's
  // first agent frame at `seq+1` (rather than reading it as a phantom gap), and a
  // missed broadcast surfaces as a gap the next agent frame's `get_difference`
  // heals. Unlike the durable frames it is NOT journaled server-side (the `user`
  // event already is); its `seq` is the committed opener's, set at the plugin.
  "user_committed",
]);

function isSeqBearingInbound(msg: { type?: unknown }): boolean {
  return typeof msg.type === "string" && SEQ_BEARING_INBOUND_TYPES.has(msg.type);
}

/**
 * #244 half B (HIGH-2) — how long to wait for a `difference` reply before
 * re-issuing the request, and how many times to re-issue before giving up into a
 * re-detect. The request and reply both ride the at-most-once `.out`, so either
 * can vanish; this is what keeps a dropped one from wedging the stream in-session.
 *
 * Telegram has no equivalent because its `getDifference` is an RPC on a session
 * connection: the transport tells the app when a call was lost. Ours is a
 * fire-and-forget publish answered by another publish, so the timer is the only
 * thing that can notice.
 */
const GET_DIFFERENCE_TIMEOUT_MS = 5_000;
const GET_DIFFERENCE_MAX_RETRIES = 3;

/**
 * #356 — THE SEQ CURSOR, AS THE STATE MACHINE TELEGRAM SPECIFIES.
 *
 * This replaces a cursor number plus five satellite fields (`differenceInFlight`,
 * `gapBuffer`, `pendingAfterSeq`, `pendingDeferredSeq`, a timer generation) that
 * SEVEN reviewers found EIGHT defects in — every one of them a pair of those
 * fields disagreeing about what was already applied. The fix is not a ninth rule:
 * it is that the states are now the type, so the disagreeing combinations cannot
 * be written down.
 *
 * The model is `core.telegram.org/api/updates`, which our roles map onto exactly
 * (our plugin = Telegram's plugin AND server; our client = the Telegram APP).
 * `seq` is `pts`; this cursor is the app's `local_pts`; `get_difference` is
 * `updates.getDifference`; the `history` snapshot's `highWaterSeq` is
 * `updates.getState`. Our `pts_count` is always 1 — every durable frame is one
 * journal row — so Telegram's three-way test collapses to:
 *
 *   seq === last + 1  → apply           ("the update can be applied")
 *   seq <= last       → already covered ("the update was already applied")
 *   seq >  last + 1   → GAP             ("an update gap that must be filled")
 *
 * ── THE STATES ──
 *
 *  - `unseeded` — NO baseline yet, so no gap can be computed: Telegram's app
 *    never calls `getDifference` before it holds a `pts`. The FIRST seq this
 *    client observes — the snapshot's `highWaterSeq` (`getState`, the normal
 *    case) or, if a durable frame beats it, that frame's own seq — becomes the
 *    baseline, and the frame that carried it folds. Nothing is requested.
 *
 *    ⚠️ ADOPTING THE FIRST OBSERVATION IS THE POINT, AND WAITING FOR THE SNAPSHOT
 *    WOULD BE A WORSE BUG THAN THE ONE THIS FIXES. `lastAppliedSeq` used to start
 *    at 0, so the first live frame of a reload mid-turn read as a gap from 0 and
 *    pulled the ENTIRE conversation back through the fold in 500-event pages
 *    (#350). But holding frames until a `history` snapshot arrives is not the
 *    cure: `history-serve.ts` SUPPRESSES an empty snapshot ("an empty snapshot is
 *    nothing to hydrate"), so a brand-new conversation never receives one and
 *    would hold every frame forever. A client that has just connected cannot know
 *    of a hole BELOW its first observation, and must not invent one; what it can
 *    see from there on is contiguous.
 *
 *    ⚠️ AND THAT LEAVES A REAL RESIDUAL, NAMED HERE RATHER THAN LEFT IMPLICIT:
 *    rows BELOW the first observation arrive only in the register-time snapshot's
 *    projection. If that snapshot is lost on the at-most-once `.out`, nothing
 *    in-session fetches them — the cursor is already above them, so no gap is
 *    detected — and the transcript is short until the next register. A persisted
 *    cursor plus a reconnect `get_difference` is what closes it (half B, #342);
 *    seeding from 0 to cover it is NOT, because that is #350.
 *  - `synced` — the ordinary state. `last` is `local_pts`.
 *  - `catching-up` — one `get_difference` is outstanding. `afterSeq` is BOTH the
 *    floor that request asked about AND the cursor: while a reply is in flight
 *    NOTHING else may move the cursor, which is why there is no second number
 *    here. The old code had one (`pendingDeferredSeq`), and applying it on top of
 *    a PARTIAL reply is precisely how a range got skipped (#352). EVERY frame of a
 *    seq-bearing type is held in `buffer`, in arrival order — with a seq or
 *    without one, because order is the reason to hold a seq-less frame; an
 *    `ack`/`history` seq is ignored outright (its frame's live effects — id
 *    adoption, hydration — have already run, and its seq is re-learned from the
 *    reply or from the next live frame).
 *
 * ── THE CORRELATION ──
 *
 * `nonce` is minted per REQUEST (a retry gets a fresh one) and the reply echoes
 * it with `afterSeq`. Both must match or the reply is ignored. Telegram does not
 * need this: each session has its own connection, so a `difference` cannot reach
 * a device that did not ask for it. Our devices share one `.out` subject and have
 * no wire identity, so without the echo device A folds device B's reply and
 * silently skips its own range (#351, NOT-list N8).
 */
type SeqCursor =
  | { state: "unseeded" }
  | { state: "synced"; last: number }
  | {
      state: "catching-up";
      /** The outstanding request's floor, which is also the cursor. */
      afterSeq: number;
      /** Re-minted on every re-issue; the reply must echo THIS one. */
      nonce: string;
      buffer: InboundMessage[];
      retries: number;
      timer: ReturnType<typeof setTimeout> | null;
    };

/**
 * #356 — what ONE `difference` reply actually delivered, which is what decides
 * whether a frame held during the round-trip is now redundant.
 *
 * TWO sets, because a held frame can be superseded on either of two keys and the
 * seq alone is not enough:
 *  - `seqs` — the seqs the reply FOLDED. Not the range it covers: a row the
 *    server could not send to this peer is covered but absent, and a row this
 *    build could not decode was carried but not applied. Neither may drop a held
 *    frame that IS foldable.
 *  - `authoredIds` — the ids the reply authored durable TEXT for. This is what
 *    supersedes a DRAFT, which carries no seq of its own when the account has
 *    `reasoningDurable` off (only a closing reasoning frame is ever journaled).
 *    A `placement` contributes NOTHING here on purpose: it claims a slot and
 *    authors no text, so it cannot supersede the draft that fills it.
 */
type CarriedRows = { seqs: ReadonlySet<number>; authoredIds: ReadonlySet<string> };

/**
 * The ids ONE folded durable event AUTHORED RENDERABLE TEXT for — what a held
 * DRAFT is measured against in `uncarried`.
 *
 * ⚠️ EXPLICIT PER KIND, WITH AN EXHAUSTIVENESS CHECK, BECAUSE A `default` ARM WAS
 * A DEFECT. Round 3 wrote `default: return [event.id]`, which quietly enrolled
 * every id-bearing kind — including `approvalResolution`, whose id is the
 * APPROVAL's and which `durable-view-reducer.ts` says outright "carries no
 * content of its own". A reply serving a resolution therefore looked like it had
 * authored the card, and a held `approval_request` for that card was dropped: the
 * card the user was looking at vanished for the session. Only three kinds author
 * text a draft can be superseded by, and the `never` below makes a new kind a
 * compile error rather than a silent enrolment.
 *
 * `placement` is the load-bearing `[]`: it claims a slot and journals no text
 * (§15.9 — the draft text is deliberately never journaled), so it cannot
 * supersede the `progress` frames that fill that slot, and a test pins that.
 *
 * ⚠️ THE OTHER `[]` ARMS ARE UNREACHABLE TODAY AND NO TEST PINS THEM — say so
 * rather than implying a guard that fires. `uncarried` consults this function
 * only for a DRAFT-SHAPED held frame (seq-less, or a `progress`), and no frame of
 * that shape carries a `user`/`tool`/`approval`/`approvalResolution` id: those
 * frames all carry their own seq. So the `approvalResolution` defect this
 * function was rewritten for is actually closed by the seq/id dichotomy in
 * `uncarried`, and defeating this table alone leaves the suite green (measured);
 * defeating BOTH reproduces it. What the arms buy is that the next kind cannot
 * default into "authors text" — which is exactly how `approvalResolution` got in
 * — and `messageEdited`/`messageDeleted` (no producer on this wire) are listed so
 * the `never` below has to be re-answered if one ever appears.
 */
function authoredIdsOf(event: DurableEvent): string[] {
  switch (event.kind) {
    case "bubble":
      return [event.answerId];
    case "seal":
      return event.answers.map((a) => a.id);
    case "reasoning":
      return [event.id];
    case "placement":
    case "user":
    case "tool":
    case "approval":
    case "approvalResolution":
    case "messageEdited":
    case "messageDeleted":
      return [];
    default: {
      // A new `DurableEvent` kind must be classified here, not defaulted into
      // "authors text" — which is exactly how `approvalResolution` got in.
      const exhaustive: never = event;
      void exhaustive;
      return [];
    }
  }
}

type SyncedCursor = Extract<SeqCursor, { state: "synced" }>;
type CatchingUpCursor = Extract<SeqCursor, { state: "catching-up" }>;

// #244 half B's `KNOWN_DURABLE_EVENT_KINDS` / `isFoldableDurableEvent` MOVED to
// `inbound-wire-decode.ts` as `decodeDurableEvent` (#246 half A). The kind check
// was only ever half the question — `foldDifferenceEvent` dereferences fields the
// reducer never sees (it iterates a `seal`'s `answers`), so a known-kind event
// with a malformed body threw INSIDE the fold. The replacement validates the
// shape each arm actually uses and reports WHY, while treating an unknown kind
// exactly as before: skipped, cursor still advanced.
// P1-9: the client-side mirror of core's abort predicate (§3.3). Intentionally
// NOT re-exported from the public barrel; imported directly here and by the
// plugin-side contract test.
import { isLikelyAbortText, isExplicitStop } from "./abort-mirror.js";
// #246 half A: the runtime wire decoder. `decodeDurableEvent` validates ONE raw
// journal event before the catch-up fold touches it; `isWireSeq` is the shared
// "this number may move the cursor" predicate.
import { decodeDurableEvent, isCommittedEcho, isWireSeq } from "./inbound-wire-decode.js";

// ---------------------------------------------------------------------------
// WebChannel NATS Client
// ---------------------------------------------------------------------------

/**
 * NATS-based WebChannel client.
 *
 * Uses per-peer NATS subjects for browser messaging.
 */

/**
 * Canonical constructor options for `WebChannelNATSClient` — the public type a
 * consumer should annotate its config with. `url` and `jwt` are supplied
 * through the `WebChannelOptions` aliases `natsUrl` / `bootstrapJwt`, so they
 * are Omitted from the `NatsClientOptions` half — otherwise the intersection
 * would require the caller to ALSO pass a raw `url` the wrapper ignores.
 * Everything else (accountId, tenant, peerId, registration, natsCredentials,
 * reconnect tuning) is forwarded as-is.
 */
export type WebChannelNATSClientOptions = Omit<WebChannelOptions, "bootstrapJwt"> &
  Omit<DirectClientOptions, "url" | "jwt"> & {
    bootstrapJwt: string;
  };

/** Public state is additive; this wrapper's live snapshots always own the lane. */
type InitializedWebChannelState = Omit<WebChannelState, "toolActivity"> & {
  toolActivity: ToolActivityItem[];
};

/**
 * v6 §15.4: the per-id CLIENT-LOCAL overlay `mergeDurable` lays on top of the
 * shared reducer's durable view. Keyed by bubble id because one event can touch
 * many bubbles — a `turn_snapshot` finalizes every answer it names.
 *
 * An explicit `undefined` value DELETES the field (see `mergeDurable` rule 3);
 * that is how `draftOnly` is cleared when a frame authors durable text.
 *
 * ⚠️ `Partial<ChatBubble>`, NOT `Partial<ChatMessage>` (#242 half 2). Every field
 * an overlay can carry — `working`, `draftOnly`, `sendState`, `receiptKey`,
 * `pending`, `wireId` — is bubble-only, and a reasoning entry has none of them
 * (see `ChatReasoningMessage`). Typing it to the bubble arm makes an overlay
 * aimed at a reasoning id a COMPILE error at the call site rather than a silent
 * no-op inside `mergeDurable`, which is where it would otherwise be discovered.
 */
type DurableLocalOverlay = Record<string, Partial<ChatBubble>>;

/**
 * What a state mutation may carry.
 *
 * ⚠️ `reasoning` (#242 half 2), `toolActivity` (half 3) AND `approvals` (half 4)
 * ARE EXCLUDED AT THE TYPE LEVEL, and that exclusion IS the "one source of truth"
 * guarantee. All three are DERIVED from `state.messages` by `nextStateFrom`
 * below; a patch that could also set one would let the two disagree, which is the
 * whole defect class these slices close. Writing `setState({ reasoning: … })`,
 * `setState({ toolActivity: … })` or `setState({ approvals: … })` is a compile
 * error, not a convention.
 */
type StatePatch = Omit<
  Partial<InitializedWebChannelState>,
  "reasoning" | "toolActivity" | "approvals"
>;

/**
 * The reasoning bursts inside a transcript, in transcript order — what
 * `state.reasoning` exposes.
 *
 * ⚠️ NO CAP. `upsertReasoning`'s `.slice(-100)` is deliberately not reproduced
 * here: the durable view is uncapped, so a live cap would be exactly the
 * live≠history divergence #242 half 2 exists to close (the argument is at the
 * reducer's `applyReasoning`; retention is #299's, at the store). Do not add one.
 */
function deriveReasoning(messages: readonly ChatMessage[]): ReasoningItem[] {
  const out: ReasoningItem[] = [];
  for (const m of messages) {
    if (m.kind === "reasoning") out.push({ id: m.id, turnId: m.turnId, text: m.text });
  }
  return out;
}

/**
 * The tool calls inside a transcript, in transcript order — what
 * `state.toolActivity` exposes (#242 half 3).
 *
 * ⚠️ NO CAP. `upsertToolActivity`'s `.slice(-100)` is deliberately not reproduced
 * here, for the reason `deriveReasoning` gives and with the same honest
 * conditional attached: a live cap over an uncapped durable view IS the
 * live≠history divergence this slice closes, and where no journal is wired there
 * is no durable view to disagree with, so the removal closes nothing there while
 * the array grows unbounded (#310's twin). Retention is #299's, at the store.
 * Do not add one.
 *
 * ⚠️ EACH OPTIONAL FIELD IS OMITTED, NOT WRITTEN AS `undefined`. `setState`
 * hands these items straight to embedders and `sameChatMessage`-style key-count
 * comparisons exist elsewhere in this file; an own `name: undefined` key would
 * make an item that reads identically compare as different.
 */
function deriveToolActivity(messages: readonly ChatMessage[]): ToolActivityItem[] {
  const out: ToolActivityItem[] = [];
  for (const m of messages) {
    if (m.kind !== "tool") continue;
    out.push({
      id: m.id,
      turnId: m.turnId,
      ...(m.name !== undefined ? { name: m.name } : {}),
      ...(m.phase !== undefined ? { phase: m.phase } : {}),
      ...(m.status !== undefined ? { status: m.status } : {}),
      ...(m.summary !== undefined ? { summary: m.summary } : {}),
      ...(m.argKeys !== undefined ? { argKeys: m.argKeys } : {}),
    });
  }
  return out;
}

/**
 * The approval cards inside a transcript, in transcript order — what
 * `state.approvals` exposes (#242 half 4).
 *
 * ⚠️ `actionable` IS RECOMPUTED HERE, NOT COPIED, AND THAT IS THE ONE PLACE THE
 * TWO CONDITIONS MEET. A card is offered to the embedder as actionable only when
 * BOTH hold:
 *   1. this device was told it is still open — `entry.actionable === true`, set
 *      ONLY by a live `approval_request` or by an `approval_snapshot` that lists
 *      the id as pending, and therefore ABSENT on anything replayed from
 *      `history`; and
 *   2. it is not resolved — no server decision, no optimistic local decision,
 *      no `resolvedElsewhere` sentinel.
 *
 * Deriving (2) rather than clearing the bit at each resolution site is
 * deliberate: there are four sites that can resolve a card (the live
 * `approval_resolved` frame, `decide()`, and two snapshot legs), and a rule that
 * each of them must remember to also clear a flag is a rule one of them will
 * eventually forget. One expression cannot be forgotten. `isActionableApproval`
 * is that expression, and `decide()` enforces the same one.
 *
 * ⚠️ THE `"unknown"` SENTINEL IS RE-COMPOSED HERE TOO. It is not a decision, so
 * it is not stored in `resolvedDecision` (see `ChatApprovalMessage`); the entry
 * carries `resolvedElsewhere` and this is where the public shape #15 defined
 * gets its value back. Only when there is no real decision — a confirmed real
 * outcome, from a snapshot's `resolved` list, must not be downgraded to the
 * sentinel.
 *
 * ⚠️ NO CAP, the same position `deriveReasoning`/`deriveToolActivity` take, and
 * for the same reasons: a live cap over an uncapped durable view is exactly the
 * live≠history divergence this slice closes, and retention belongs at the store
 * (**#299**, client-side twin **#310**).
 */
/**
 * May this device offer decision buttons for this approval entry? ONE
 * definition, shared by `deriveApprovals` (what the embedder sees) and by
 * `decide()` (what the API will actually send) — so the button the UI draws and
 * the call the UI makes can never disagree about the same card.
 *
 * BOTH conjuncts are load-bearing and they answer different questions:
 * `actionable` is "is this card still OPEN as far as the live session knows"
 * (absent on anything replayed from `history`), and the resolution tests are "has
 * it already been answered" (by the server, by this device optimistically, or by
 * another device per `approval_snapshot`'s Leg B).
 */
/**
 * Is this UNVALIDATED wire value one of the three real approval decisions?
 *
 * ⚠️ IT DELIBERATELY REJECTS `"unknown"`. That is the client's own resolution
 * SENTINEL (#15 — "answered while this device wasn't looking"), produced only by
 * `approval_snapshot`'s Leg B and stored as `resolvedElsewhere`, never as a
 * decision. Nothing on the server can journal it, so a `history` row carrying
 * one is either a forged frame or a future meaning this build does not have;
 * either way, admitting it would render a resolution that never happened.
 */
function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

function isActionableApproval(entry: ChatApprovalMessage): boolean {
  return (
    entry.actionable === true &&
    entry.resolvedDecision === undefined &&
    entry.resolvedElsewhere !== true
  );
}

/**
 * Mark ONE approval entry actionable — the only door through which a card
 * becomes clickable (#242 half 4).
 *
 * Two callers, both of which are an authority for "this card is open RIGHT NOW":
 * the live `approval_request` frame, and `approval_snapshot`'s still-pending
 * listing. `case "history"` deliberately does NOT call it, which is what makes a
 * replayed card inert.
 *
 * Returns the input array by reference when the bit is already set, so a
 * re-delivered request does not churn `state.messages`.
 */
function markApprovalActionable(messages: ChatMessage[], id: string): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.kind !== "approval" || m.id !== id || m.actionable === true) return m;
    changed = true;
    return { ...m, actionable: true };
  });
  return changed ? next : messages;
}

/**
 * Mark ONE approval entry's resolution SERVER-CONFIRMED — the client-local half
 * of an `approval_resolved` frame (the decision itself is durable and is folded
 * by the reducer).
 *
 * Confirmed means the snapshot reconciler treats the card as authoritative: it
 * never re-sends the decision as lost (Leg C) and never downgrades it to the
 * `"unknown"` sentinel (Leg B). Returns the input array by reference when the
 * bit is already set.
 */
function markApprovalConfirmed(messages: ChatMessage[], id: string): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.kind !== "approval" || m.id !== id || m.resolutionConfirmed === true) return m;
    changed = true;
    return { ...m, resolutionConfirmed: true };
  });
  return changed ? next : messages;
}

function deriveApprovals(messages: readonly ChatMessage[]): ApprovalRequest[] {
  const out: ApprovalRequest[] = [];
  for (const m of messages) {
    if (m.kind !== "approval") continue;
    const resolvedDecision: ApprovalDecision | "unknown" | undefined =
      m.resolvedDecision ?? (m.resolvedElsewhere === true ? "unknown" : undefined);
    out.push({
      id: m.id,
      kind: m.approvalKind,
      title: m.title,
      ...(m.description !== undefined ? { description: m.description } : {}),
      prompt: m.prompt,
      // A fresh array: `ApprovalRequest.options` is a MUTABLE `ApprovalOption[]`
      // in the public type while the entry holds a `readonly` one, and handing
      // the entry's own array out would let an embedder mutate a transcript
      // entry the reducer shares by reference.
      options: m.options.map((o) => ({ ...o })),
      ...(m.expiresAtMs !== undefined ? { expiresAtMs: m.expiresAtMs } : {}),
      ...(resolvedDecision !== undefined ? { resolvedDecision } : {}),
      ...(m.resolutionConfirmed !== undefined
        ? { resolutionConfirmed: m.resolutionConfirmed }
        : {}),
      actionable: isActionableApproval(m),
    });
  }
  return out;
}

/**
 * Apply one patch and recompute every DERIVED field.
 *
 * The derivation is conditional on `messages` being in the patch, so
 * `state.reasoning` keeps its ARRAY IDENTITY across patches that do not touch
 * the transcript — `typing`, `commands`, `approvals`, connection status.
 *
 * ⚠️ BE HONEST ABOUT WHAT THAT DOES AND DOES NOT BUY. An earlier revision said
 * the alternative "would report a change on every `typing` frame", which is true
 * and also the least of it. MEASURED: `state.reasoning` gets a FRESH array on
 * EVERY patch that touches `messages`, contents identical or not — two
 * consecutive `progress` frames each produce a new one. `progress` is far more
 * frequent during a turn than `typing` is, so a listener that keys off
 * `state.reasoning`'s identity still sees churn; what this condition removes is
 * the churn OUTSIDE a turn, not inside one.
 *
 * That is consistent with the rest of the object rather than a compromise —
 * `WebChannelState`'s docblock promises a new object per change, "the arrays
 * too", and `messages` itself is rebuilt by `mergeDurable` on every durable
 * frame. A content-equality memo here would be a fourth opinion about when a
 * view changed; the reducer's own header already refuses that reasoning for
 * array identity.
 */
function nextStateFrom(
  prev: InitializedWebChannelState,
  patch: StatePatch,
): InitializedWebChannelState {
  const next = { ...prev, ...patch };
  if (patch.messages !== undefined) {
    next.reasoning = deriveReasoning(patch.messages);
    next.toolActivity = deriveToolActivity(patch.messages);
    next.approvals = deriveApprovals(patch.messages);
  }
  return next;
}

/**
 * THE KIND-SCOPED IDENTITY OF ONE TRANSCRIPT ENTRY — one definition, every
 * index, BOTH the local entry and the wire row (#242 half 3).
 *
 * ⚠️ THIS EXISTS BECAUSE THE COPY-PASTE ENDS HERE. `state.messages` holds FOUR
 * kinds since #242 half 4 added approvals — and the device did its job on the
 * way in: adding the arm below turned every call site red until it was handled,
 * which is exactly what the two-way inline key it replaced could not do. Half 2
 * shipped THREE
 * separate defects of one shape — an id-keyed index over a mixed array — and its
 * conclusion is the rule this function enforces mechanically rather than by
 * memory: NEVER KEY A MIXED TRANSCRIPT BY ID ALONE. The two id spaces are not
 * provably disjoint (`durable-view-reducer.ts`'s `findTextIndex` docblock
 * retracts the id-shape argument outright), and `case "history"` deliberately
 * produces same-id pairs of different kinds.
 *
 * ⚠️ AND A FORGOTTEN KIND IS A COMPILE ERROR, WHICH IS THE ACTUAL POINT. The
 * inline key this replaced was
 * `` `${kind === "reasoning" ? "r" : "t"}\0${id}` `` — a two-way test with an
 * `else` fallback, so adding a third kind would have SILENTLY mapped every tool
 * entry into the BUBBLE key space and reintroduced the exact collision half 2
 * spent three rounds removing. The `never` default below makes that fail to
 * compile, the same device `KNOWN_EVENT_KINDS` uses in `journal-history.ts`.
 *
 * ⚠️ THE PARAMETER IS THE STRUCTURAL MINIMUM, NOT `ChatMessage`, AND THAT IS
 * WHAT LETS ONE FUNCTION SERVE BOTH SIDES. `case "history"` keys UNVALIDATED
 * WIRE ROWS and `mergeDurable` keys VALIDATED LOCAL ENTRIES; those are different
 * types carrying the same identity. An earlier revision of this slice wrote TWO
 * functions with identical bodies — two things that must agree and nothing to
 * make them go red together, which is the defect class this whole module is
 * organised against. Widening the parameter instead costs nothing: every
 * `ChatMessage` arm is assignable to the matching arm below, so a FOURTH
 * `ChatMessage` kind stops compiling at each call site rather than being keyed
 * wrongly.
 *
 * ⚠️ TOOL IS KEYED BY THE PAIR `(turnId, id)`, the other two by `id`. That is
 * not stylistic — the producer's tool id is unique within a RUN, and both the
 * live upsert and `applyTool` address a call by both fields. A key function per
 * kind is exactly what lets one index serve all three.
 *
 * NUL separates, so no id can spell another kind's key. The residual ambiguity
 * is a NUL *inside* an id or turnId; that is the pre-existing convention here
 * and its blast radius is two tool calls sharing a key, which is a visible
 * duplicate rather than a loss.
 */
type KeyedTranscriptEntry =
  | { kind?: undefined; id: string }
  | { kind: "reasoning"; id: string }
  | { kind: "tool"; id: string; turnId: string }
  | { kind: "approval"; id: string };

function transcriptEntryKey(entry: KeyedTranscriptEntry): string {
  switch (entry.kind) {
    case undefined:
      return `t\0${entry.id}`;
    case "reasoning":
      return `r\0${entry.id}`;
    case "tool":
      return `x\0${toolEntryKey(entry.turnId, entry.id)}`;
    // #242 half 4. Keyed by `id` alone, like the first two and unlike `tool`:
    // an approval id is the gateway's own `approvalId` (the value the client
    // sends back on `approval_decision`), so it is the whole identity and there
    // is no second field to compose.
    case "approval":
      return `p\0${entry.id}`;
    default: {
      const unhandled: never = entry;
      void unhandled;
      // Unreachable: every arm is handled above, and a new one fails to compile
      // at the assignment. Returning a key that can collide with nothing keeps
      // this total for a value forged past the type system.
      return `?\0${String((entry as { id?: unknown }).id)}`;
    }
  }
}

/**
 * Index a transcript by KIND, each kind under its own key space and its own
 * TYPE (#242 half 3).
 *
 * ⚠️ ONE INDEX, NOT ONE MAP PER KIND BOLTED ON AS KINDS ARRIVE. `mergeDurable`
 * used to build `prevBubbleById` and `prevReasoningById` side by side; tool made
 * three and half 4's approvals four, with every call site needing to
 * remember which map to reach into. The record below is built by ONE exhaustive
 * switch, so adding a kind is two compile errors — a missing field on
 * `TranscriptIndex` and an unhandled arm here — instead of a map somebody forgot
 * to populate.
 *
 * ⚠️ THE MAPS STAY SEPARATELY TYPED RATHER THAN COLLAPSING TO
 * `Map<string, ChatMessage>` KEYED BY `transcriptEntryKey`. That would work and
 * would need a narrowing read at every lookup to recover the arm — a guard on
 * the read, which is the shape half 2 proved dangerous. Typed buckets give each
 * caller the exact arm with no guard at all, which is the property the
 * "the key does the work" conclusion was actually about.
 */
type TranscriptIndex = {
  bubble: Map<string, ChatBubble>;
  reasoning: Map<string, ChatReasoningMessage>;
  tool: Map<string, ChatToolMessage>;
  approval: Map<string, ChatApprovalMessage>;
};

function indexTranscriptByKind(messages: readonly ChatMessage[]): TranscriptIndex {
  const index: TranscriptIndex = {
    bubble: new Map(),
    reasoning: new Map(),
    tool: new Map(),
    approval: new Map(),
  };
  for (const m of messages) {
    switch (m.kind) {
      case undefined:
        index.bubble.set(m.id, m);
        break;
      case "reasoning":
        index.reasoning.set(m.id, m);
        break;
      case "tool":
        index.tool.set(toolEntryKey(m.turnId, m.id), m);
        break;
      case "approval":
        index.approval.set(m.id, m);
        break;
      default: {
        const unhandled: never = m;
        void unhandled;
        break;
      }
    }
  }
  return index;
}

/**
 * The composite key a tool call is addressed by, in ONE place.
 *
 * Both `transcriptEntryKey` and `indexTranscriptByKind` compose it, so the
 * "(turnId, id), never id alone" rule has a single definition rather than two
 * sites that must remember it.
 */
function toolEntryKey(turnId: string, id: string): string {
  return `${turnId}\0${id}`;
}

/**
 * Shallow equality over a transcript entry's own enumerable fields, so
 * `mergeDurable` can hand an UNCHANGED entry back by reference. `Object.is`
 * rather than `===` only to keep `NaN` (a plausible `ts`/`assistantMessageIndex`
 * corruption) from reporting a spurious change on every apply.
 *
 * ⚠️ "ENTRY", NOT "BUBBLE" — this said `bubble` while it only ever saw bubbles,
 * and #242 half 2 gave it a second caller (`mergeDurable`'s reasoning branch,
 * `sameChatMessage(prevEntry, nextReasoning)`). The key-count check is what makes
 * that work for BOTH kinds, which is why `ChatBubble.kind` and a reasoning
 * entry's `ts` are absent as OWN KEYS rather than present-and-`undefined`.
 *
 * ⚠️ ONLY ONE OF THOSE TWO CITES THIS FUNCTION, so do not go looking for a pair.
 * `ChatBubble.kind`'s declaration in `types.ts` carries the reason; the reasoning
 * `ts` is explained at its ASSIGNMENT site (`mergeDurable`'s reasoning branch),
 * not at its declaration. An earlier revision of this block claimed both
 * declarations did — corrected rather than deleted, because "both declarations
 * say so" is exactly the kind of census a reader trusts without checking.
 */
function sameChatMessage(a: ChatMessage, b: ChatMessage): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

export class WebChannelNATSClient {
  private readonly natsOptions: DirectClientOptions;
  private readonly client: WebChannelNatsClient;

  private state: InitializedWebChannelState = {
    messages: [],
    reasoning: [],
    toolActivity: [],
    approvals: [],
    status: "connecting",
    connected: false,
    // Learned from the register handshake; null until a register completes.
    agentProtocolVersion: null,
    agentPluginVersion: null,
  };

  private readonly listeners = new Set<Listener>();
  /** Counts public state fanouts so a staged bubble is exposed exactly once. */
  private stateNotificationSeq = 0;
  /** Receipt bubbles installed silently while their low-level send commits. */
  private readonly stagedReceiptExposures = new Set<string>();

  /**
   * P1-9: user messages HELD locally because a turn was in flight at send time
   * (the local twin of the server-side coalesce buffer). Insertion-ordered;
   * released FIFO once the turn settles AND the session key exists. Each entry's
   * `localId` is the id of its `pending: true` transcript bubble.
   */
  private readonly held: Array<{ localId: string; text: string; receiptKey: string }> = [];
  /** Every outbound operation staged for a connect requested inside close(). */
  private readonly deferredReplacementOperations: DeferredReplacementOperation[] = [];
  /** Keeps reentrant operations behind entries already staged for replacement. */
  private deferredReplacementOperationCommitDepth = 0;
  /** Prevent reentrant sends from jumping ahead of a final entry being released. */
  private heldReleaseCommitDepth = 0;
  /**
   * Explicit `/stop` is a small commit transaction. Ordinary sends created by
   * cancellation/finalization callbacks stay held until the outermost stop has
   * owned its low-level queue position; nested stops share the same transaction.
   */
  private stopCommitDepth = 0;

  /**
   * P0-4: receipt records keyed by the immutable `receiptKey`, and the
   * wireId → receiptKey routing for the low-level tracker's `onSendState`
   * transitions (a wireId is assigned at publish/release; a held send has a
   * receipt but no wireId yet).
   */
  private readonly receipts = new Map<string, ReceiptRecord>();
  private readonly wireIdToReceiptKey = new Map<string, string>();
  /**
   * #243 half 2b: the idempotency `random_id → receiptKey` linkage for the
   * bubbles this client sent. The wrapper mints the `random_id` (see
   * `mintRandomId`) so it — not the low-level `sendUserMessage` — owns the
   * `random_id ↔ bubble` correlation. On an `ack` carrying `committed`
   * (`{random_id, messageId}[]`), `adoptCommittedIds` looks up the receiptKey
   * here, finds the optimistic `u-<n>` bubble carrying that receiptKey, and
   * re-keys its durable id to the SERVER `messageId` — so the client's `user`
   * id becomes the id the delivery journal already holds, and a later
   * history/full-replay tier-1 matches by id instead of by text (`case
   * "history"` tier 2). Keyed by receiptKey (not the mutating bubble id) so it
   * survives the very re-key it enables. An entry is consumed when its echo is
   * adopted; a send that never draws a `committed` echo (control-lane text; the
   * plugin's fast-path/overflow/cancelled ack gaps — a documented follow-up)
   * leaves one residue entry per un-echoed send — bounded per send, but NOT
   * cleared until half 3 closes those echo gaps, so it grows with un-echoed
   * sends over a session (tiny string entries; a stale one can only no-op). Its
   * bubble stays `u-<n>`, where the tier-2/3 text fallback still reconciles it on
   * reconnect.
   */
  private readonly randomIdToReceiptKey = new Map<string, string>();
  /** P0-4: forward rank for the receipt-level monotonic guard (incl. `completed`). */
  private static readonly RECEIPT_RANK: Record<"queued" | "sent" | "accepted" | "completed", number> = {
    queued: 0,
    sent: 1,
    accepted: 2,
    completed: 3,
  };
  /**
   * P1-9 §3.2: true only between a session KEY establishment (onSession, fired
   * after flushQueue) and the next disconnect. The release gate depends on THIS,
   * not the raw `connected` flip — at onState(true) the conversation key does not
   * exist yet, so releasing there would push held texts into the SDK outbound
   * queue (committed, ✕ gone) with nothing publishable AND ahead of the P0-7b
   * ledger replay (FIFO inversion). Cleared on every onState(false).
   */
  private sessionEstablished = false;
  /** Latest raw transport edge; true before session flush, false immediately on loss. */
  private rawTransportConnected = false;
  /** Distinguishes initial authentication from replacement-session readiness. */
  private everSessionEstablished = false;
  /** Invalidates ready-notification continuations after raw loss/close/error. */
  private wrapperLifecycleGeneration = 0;
  /** Wrapper-owned ordinary-follow-up application-stall episode. */
  private heldStallSinceAt: number | null = null;
  private heldStallRecoveryIssued = false;
  private heldStallMutationEpoch = 0;
  private heldStallTimer: ReturnType<typeof setTimeout> | null = null;
  private heldStallTimerGeneration = 0;
  /** Defers held-admission UI fanout until the first owner's timer commit ends. */
  private heldAdmissionNotificationDepth = 0;
  private heldAdmissionNotificationPending = false;
  /**
   * P0-4: true once a terminal failure has been observed (wrapper mirror of the
   * low-level `terminalReached`). PERMANENT — a terminal instance is retired
   * (CL2 contract: every terminal cause is `retryable:false`; recovery means
   * re-initializing with fresh credentials, not reviving this instance). While
   * set, `send()` must NEVER hold — a held send arriving after the terminal
   * held[] sweep would be orphaned — so holding is disabled and the send
   * publishes, resolving immediately to failed{terminal}. Symmetric with the
   * low-level `terminalReached`, which also never resets.
   */
  private terminal = false;
  /**
   * P0-4 (review): true between an explicit `close()` and the next `connect()`.
   * CONNECTION-SCOPED — the exact opposite of the permanent `terminal` latch: a
   * closed instance is reusable, so `connect()` clears this. It is the wrapper
   * mirror of the low-level `disconnected` gate (`nats-client.ts`), which fails a
   * send onto a closed instance as `failed{closed}`. The mirror is required
   * because that gate only fires for sends that actually REACH
   * `sendUserMessage()`: a send arriving while a turn is still in flight is
   * pushed into `held[]` instead, and `held[]` drains only on `onSession` — which
   * a closed instance never fires again. `close()` does not settle live `working`
   * drafts (only the terminal path does) and it clears the staleness valve, so
   * `turnInFlight()` can stay true forever after a close. Without this flag such
   * a send is stranded at `queued` — the exact failure P0-4 exists to eliminate.
   */
  private closed = false;
  /** Nested close() calls share one teardown; the latest connect/close intent wins. */
  private closeTransactionDepth = 0;
  private connectDeferredUntilCloseCompletes = false;
  /** Replacement-held work gets a fresh timer only after its new session exists. */
  private replacementHeldNeedsFreshEpisode = false;
  /**
   * P1-9 §3.6.2: post-reconnect staleness valve. `staleDraftWatch` holds the ids
   * of `working` drafts recorded when onSession fired; the timer flips any still
   * in the set to `working: false` in place after the grace, never swapping the
   * id and never dropping the bubble — this valve GUESSES that a turn died, so it
   * promotes the partial to durable rather than deleting it (see
   * `expireStaleDrafts` for why this site differs from the three turn-end sites).
   * Both are connection-scoped: cleared on every onState(false)/close()
   * and re-armed FRESH on every onSession, so the grace counts only connected
   * time. A draft-touching frame (progress/agent_message by id, reasoning by
   * turnId) disarms its entry — the turn is demonstrably alive.
   */
  private readonly staleDraftWatch = new Set<string>();
  private staleDraftTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STALE_DRAFT_GRACE_MS = 30_000;
  /**
   * #96: ids of the turns THIS client started that have not settled yet (the id
   * is the publish wireId, which the plugin echoes as `turn_settled.turnId`).
   * A Set, not a boolean: several turns can be outstanding at once (a released
   * held burst, or sends that land in the quiet gaps of a running turn).
   * INSERTION ORDER IS LOAD-BEARING — it is publish order, which is what lets a
   * settle retire the whole coalesced prefix (see `closeTurnsThrough`).
   * `state.turnActive` is exactly `size > 0`.
   *
   * ADVISORY ONLY. It is read NOWHERE outside `turnActive` state construction —
   * never by `turnInFlight()`/`shouldHold()`/`maybeRelease()`, never by the
   * receipt machinery, never by the #81 held-stall detector. Widening the
   * existing `turnInFlight()` instead would have kept held follow-ups held for
   * the whole turn and made #81's 30s stall detector fire soft reconnects on
   * ordinary multi-step turns.
   */
  private readonly openTurns = new Set<string>();

  constructor(options: WebChannelNATSClientOptions) {
    this.natsOptions = {
      url: options.natsUrl ?? "wss://nats.example.com",
      jwt: options.bootstrapJwt,
      accountId: options.accountId ?? "default-account",
      tenant: options.tenant ?? "default-tenant",
      peerId: options.peerId ?? "anonymous-peer",
      registration: options.registration,
      // CL1: forward the NATS-layer NKEY credentials + reconnect tuning. A
      // production JWT-auth nats-server REQUIRES `natsCredentials` — without it
      // CONNECT ships only the bootstrap JWT with no signed nonce, the server
      // returns `-ERR Authorization Violation`, and the client enters an
      // unwinnable reconnect loop. Dropping these silently made the public
      // wrapper unusable against any real (non-open) NATS deployment.
      natsCredentials: options.natsCredentials,
      reconnectBaseMs: options.reconnectBaseMs,
      reconnectCapMs: options.reconnectCapMs,
      // CL3: forward the keepalive interval too (same drop-on-the-floor class as
      // the CL1 natsCredentials bug — the wrapper rebuilds the options object, so
      // any NatsClientOptions field it doesn't name is silently lost).
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      // P1-3: forward the connect-stage deadline (same drop-on-the-floor class);
      // without this the public type advertises `connectTimeoutMs` but the low
      // level always runs its 10s default — 0 (disable) must survive too.
      connectTimeoutMs: options.connectTimeoutMs,
      // #81 application-level policy remains owned and validated by the inner
      // high-level client. Forward the caller's raw value unchanged.
      ackStallTimeoutMs: options.ackStallTimeoutMs,
      // Preserve the existing deterministic scheduler seams for wrapper-based
      // tests and embedded runtimes; the held lane uses the global clock/timer.
      _retryNow: options._retryNow,
      _retryRandom: options._retryRandom,
      _retrySetTimeout: options._retrySetTimeout,
      _retryClearTimeout: options._retryClearTimeout,
    };

    this.client = new WebChannelNatsClient(this.natsOptions);

    // Wire up message listener
    this.client.onMessage((msg: InboundMessage) => this.handleMessage(msg));

    // Wire up state listener.
    this.client.onState((connected: boolean) => {
      // Record the raw edge before any cleanup/public callout. A ws.send() seam
      // can synchronously deliver onclose yet return normally; its trailing
      // tracker `sent` must see false and consume without opening.
      this.rawTransportConnected = connected;
      const wasSessionEstablished = this.sessionEstablished;
      this.wrapperLifecycleGeneration++;
      // Raw transport is never public readiness. Invalidate the release gate
      // before timer cleanup or any wrapper state callback.
      this.sessionEstablished = false;
      if (!connected || wasSessionEstablished) this.consumeHeldStallForRawLoss();
      this.clearStaleDraftWatch();
      // #244 half B: the in-flight catch-up and its buffer belong to the connection
      // that just dropped; the cursor itself survives, and the reconnect snapshot's
      // high-water re-detects any gap through the ordinary check.
      this.resetCursorForConnection();
      // P0-4: a CL2 terminal instance is PERMANENTLY retired — the onState handler
      // must not mutate status/error at all, on EITHER edge. This matters because
      // a registration-path terminal sets only the WCNC-level `terminalReached`
      // (the raw transport is NOT terminal), so a later explicit `connect()`
      // re-dials and emits `connected:true`; without this guard that would flip
      // the sticky "error" to "connected" and clear the cause while every send
      // still immediate-fails (a green status on a wedged instance). It also
      // supersedes the old one-sided (!connected && status==="error") sticky
      // guard, since `terminal` is always set whenever status is "error".
      // Recovery is a fresh client with fresh credentials, never this instance.
      if (this.terminal) return;
      // A low-level tracker can already have advanced beyond `queued` while its
      // wrapper callbacks wait behind another send-state fanout. Consume those
      // latches before the disconnect sweep so an earlier delayed `sent` cannot
      // resurrect a turn afterward (even if the latest snapshot is `failed`).
      // Truly queued work remains eligible after reconnect publication.
      if (!connected) this.consumeAdvancedTurnOpeningsAcrossDisconnect();
      // #96: a raw loss ends every turn this client was tracking — the same
      // reason it force-clears isTyping.
      //
      // NOT symmetric with isTyping, though: a later `typing` frame re-arms
      // isTyping, but a receipt whose first successful publish already opened a
      // turn has consumed its one-way opening latch. A later accepted/replay
      // transition therefore cannot re-open it after this sweep, so a transient
      // reconnect during a long multi-step turn leaves `turnActive` false for
      // the REST of that turn. A still-queued, never-published receipt retains
      // its latch and may open for the first time after reconnect.
      const turnsCleared = !connected && this.clearOpenTurns();
      this.setState({
        status: this.everSessionEstablished ? "reconnecting" : "connecting",
        connected: false,
        ...(!connected ? { isTyping: false } : {}),
        ...(turnsCleared ? { turnActive: false } : {}),
      });
    });

    // P1-9 §3.2/§3.6.2: session KEY established (both register-unwrap and legacy
    // handshake paths, strictly AFTER flushQueue). Open the release gate, arm the
    // staleness valve fresh, and try to release — ordered behind the ledger replay.
    this.client.onSession(() => {
      // P0-4 (R4): defense in depth — a retired instance must never open the
      // release gate, arm the staleness valve, or release, even if a stray
      // onSession somehow fired. The mid-level `onConnected` terminal guard is the
      // root fix; this makes the wrapper safe regardless.
      if (this.terminal || this.closed) return;
      const lifecycle = this.wrapperLifecycleGeneration;
      this.sessionEstablished = true;
      this.everSessionEstablished = true;
      this.setState({
        status: "connected",
        connected: true,
        error: undefined,
        errorCause: undefined,
      });
      // A public ready-state listener may synchronously close or retire this
      // lifecycle. It wins over every trailing stale-watch/release action.
      if (
        this.wrapperLifecycleGeneration !== lifecycle
        || !this.sessionEstablished || this.terminal || this.closed
        || !this.state.connected
      ) {
        return;
      }
      // A hold admitted after connect() was requested from inside close() could
      // not age against the old session. Its application-stall interval starts
      // only now, when the replacement session is authenticated and usable.
      if (this.replacementHeldNeedsFreshEpisode) {
        this.replacementHeldNeedsFreshEpisode = false;
        if (this.held.length > 0) this.beginHeldStallEpisode(true);
      }
      if (
        this.wrapperLifecycleGeneration !== lifecycle
        || !this.sessionEstablished || this.terminal || this.closed
        || !this.state.connected
      ) {
        return;
      }
      this.armStaleDraftWatch();
      if (
        this.wrapperLifecycleGeneration !== lifecycle
        || !this.sessionEstablished || this.terminal || this.closed
        || !this.state.connected
      ) {
        return;
      }
      this.maybeRelease();
    });

    // P0-4: the authoritative tracker drives every send-state transition. Route
    // it through the wireId → receiptKey alias to the receipt record + render
    // bubble. A wireId with no local receipt (a direct/internal send) is ignored.
    this.client.onSendState((wireId: string, state: SendState, failure?: SendFailure) => {
      const receiptKey = this.wireIdToReceiptKey.get(wireId);
      if (!receiptKey) return;
      // The record already starts at queued, so this is not a receipt transition.
      // It is nevertheless the first safe point to expose a silently staged
      // bubble: the low level owns A's outbound queue position before emitting it.
      if (state === "queued" && this.stagedReceiptExposures.delete(receiptKey)) {
        this.notifyStateListeners();
      }
      this.receiptTransition(receiptKey, state, failure);
    });

    // CL2: surface a TERMINAL failure to the embedder. The underlying client
    // fires onError for non-retryable failures — a failed PoP registration or an
    // authoritative NATS auth rejection (`-ERR Authorization Violation`, expired
    // creds) — and has stopped reconnecting. We move to the terminal `"error"`
    // status with a reason so the app can prompt for fresh credentials instead
    // of showing an eternal reconnect spinner.
    this.client.onError((err: Error, cause?: WebChannelErrorCause) => {
      console.error("[nats-wrapper] terminal connection error:", err);
      // P0-4: mark terminal BEFORE failing held[] so a re-entrant send from a
      // receipt subscriber during the sweep does NOT hold (shouldHold is gated on
      // this) — it publishes and resolves immediately to failed{terminal}.
      this.terminal = true;
      this.connectDeferredUntilCloseCompletes = false;
      this.replacementHeldNeedsFreshEpisode = false;
      this.wrapperLifecycleGeneration++;
      const deferredEntries = this.deferredReplacementOperations.splice(0);
      // P0-4 (D5 held/terminal): the queued/ledgered sends were already swept to
      // failed{terminal} by the low-level terminal sequence BEFORE this listener
      // ran; fail the wrapper-owned held[] here (they have no wireId, so the sweep
      // could not reach them). Retracted bubbles are preserved by failHeld.
      this.failHeld({ reason: "terminal", cause: cause ?? "unknown", retryable: false });
      this.failDeferredReplacementOperations(
        deferredEntries,
        { reason: "terminal", cause: cause ?? "unknown", retryable: false },
      );
      // P0-4 (R4): settle the live-turn UI in the SAME terminal update. A terminal
      // mid-turn otherwise leaves an eternal "typing…" (or a spinning `working`
      // draft): the gated onState(false) skips the normal cleanup, and the
      // staleness valve only arms on a reconnect this retired instance never does.
      // Flip isTyping off and every `working` draft to `working:false` in place
      // (id/text untouched — the /stop idiom), atomically with the error status so
      // there is no intermediate flicker. Does NOT touch status/error semantics.
      // #251: a lane that never received durable text has nothing to settle INTO,
      // so it is dropped rather than frozen at its last partial.
      let draftsSettled = false;
      const settledMessages = this.dropSpentDrafts(
        this.state.messages.map((m) => {
          if (m.working) {
            draftsSettled = true;
            this.staleDraftWatch.delete(m.id);
            return { ...m, working: false };
          }
          return m;
        }),
      );
      // #96: a retired instance can never see another `turn_settled`, so every
      // open turn ends here too — in the SAME atomic update as isTyping.
      const turnsCleared = this.clearOpenTurns();
      // P1-7: carry the machine-readable cause onto state so the embedder picks
      // truthful wording + the right recovery affordance. A classified emit site
      // supplies its cause; an unclassified failure falls back to "unknown".
      this.setState({
        status: "error",
        connected: false,
        error: err.message,
        errorCause: cause ?? "unknown",
        isTyping: false,
        ...(turnsCleared ? { turnActive: false } : {}),
        ...(draftsSettled ? { messages: settledMessages } : {}),
      });
    });

    // Register-handshake outcome: surface the agent-plugin's protocol/plugin
    // version on state for diagnostics (admin screen). A version MISMATCH never
    // arrives here — it flows through onError above as a terminal failure.
    this.client.onProtocol(({ protocolVersion, pluginVersion }) => {
      this.setState({
        agentProtocolVersion: protocolVersion,
        agentPluginVersion: pluginVersion,
      });
    });
  }

  /** Get current state */
  getState(): WebChannelState {
    return this.state;
  }

  /** Subscribe to state changes */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Connect to NATS */
  connect(): void {
    // P0-4 (review): a reconnect reopens the send path — clear the closed gate so
    // holding resumes. Mirrors `WebChannelNatsClient.connect()`, which clears its
    // own `disconnected` flag; the ordering mirrors it too — that method REFUSES
    // outright on a terminally-retired instance, so a retired wrapper must stay
    // closed rather than silently re-enable holding onto a dead instance.
    if (!this.terminal) {
      this.closed = false;
      if (this.closeTransactionDepth > 0) {
        // The old raw socket has not been disconnected yet. Record the reopen
        // intent, but never let this connect (or sends following it) target that
        // socket; the outermost close replays it after teardown completes.
        this.connectDeferredUntilCloseCompletes = true;
        return;
      }
    }
    this.client.connect();
  }

  /** Disconnect from NATS */
  close(): void {
    // P0-4 (review): gate holding FIRST — a send arriving after this close (or
    // re-entrantly, from a listener the sweep below fires) must publish and
    // resolve to failed{closed} via the low-level `disconnected` gate, never land
    // in `held[]` whose only drain (onSession) this instance will never fire.
    this.closed = true;
    // A later nested close overrides an earlier deferred connect. A connect
    // occurring from one of THIS close's callouts can set the intent again.
    this.connectDeferredUntilCloseCompletes = false;
    this.wrapperLifecycleGeneration++;
    this.closeTransactionDepth++;
    try {
      // Detach only this lifecycle's wrapper ownership before any timer or raw
      // teardown callout. Work created after a reentrant connect is replacement
      // ownership and remains in the live collections.
      const deferredEntries = this.deferredReplacementOperations.splice(0);
      const heldEntries = this.takeHeld();
      // P1-9: tear down the connection-scoped staleness valve (§3.6.2).
      this.clearStaleDraftWatch();
      // #244 half B: this lifecycle will never receive its pending `difference`;
      // stop the timer and drop the buffer so nothing leaks past close().
      this.resetCursorForConnection();
      // #96: this lifecycle will never see another `turn_settled`. Clear its
      // turns before raw teardown, but delay the public flip until disconnect()
      // has completed so no state listener can reopen onto the old socket.
      const turnsCleared = this.clearOpenTurns();
      this.client.disconnect();
      // Replacement operations admitted by a disconnect callback have not been
      // published yet, so an empty set still belongs solely to the old lifecycle.
      if (turnsCleared && this.openTurns.size === 0) {
        this.setState({ turnActive: false });
      }
      // Notify only the detached old lifecycle after raw teardown. Reentrant
      // replacement work cannot be consumed by either failure sweep.
      this.failDeferredReplacementOperations(
        deferredEntries,
        { reason: "closed", retryable: false },
      );
      this.failHeldEntries(heldEntries, { reason: "closed", retryable: false });
    } finally {
      this.closeTransactionDepth--;
      if (this.closeTransactionDepth === 0) this.finishDeferredCloseConnect();
    }
  }

  /** True only for the replacement lifecycle opened from an active close(). */
  private deferredReplacementOpen(): boolean {
    return this.closeTransactionDepth > 0
      && this.connectDeferredUntilCloseCompletes
      && !this.closed
      && !this.terminal;
  }

  /**
   * Finish the latest connect intent after the old inner lifecycle is completely
   * torn down. Staged controls are then committed live/FIFO into the new inner
   * queue; callbacks that publish during the drain append behind existing work.
   */
  private finishDeferredCloseConnect(): void {
    const shouldConnect = this.connectDeferredUntilCloseCompletes
      && !this.closed
      && !this.terminal;
    this.connectDeferredUntilCloseCompletes = false;

    if (!shouldConnect) {
      const stranded = this.deferredReplacementOperations.splice(0);
      if (stranded.length > 0) {
        this.failDeferredReplacementOperations(
          stranded,
          this.terminal
            ? {
                reason: "terminal",
                cause: this.state.errorCause ?? "unknown",
                retryable: false,
              }
            : { reason: "closed", retryable: false },
        );
      }
      return;
    }

    this.deferredReplacementOperationCommitDepth++;
    try {
      // Own the commit transaction BEFORE connect(): an injected WebSocket
      // factory or synchronous onState callback may emit wrapper operations
      // during the dial. They must append behind the already-staged FIFO, never
      // enter the inner queue ahead of it.
      this.client.connect();
      while (this.deferredReplacementOperations.length > 0) {
        if (this.closed || this.terminal) {
          const entries = this.deferredReplacementOperations.splice(0);
          this.failDeferredReplacementOperations(
            entries,
            this.terminal
              ? {
                  reason: "terminal",
                  cause: this.state.errorCause ?? "unknown",
                  retryable: false,
                }
              : { reason: "closed", retryable: false },
          );
          break;
        }
        this.commitDeferredReplacementOperation(
          this.deferredReplacementOperations.shift()!,
        );
      }
    } finally {
      this.deferredReplacementOperationCommitDepth--;
    }
  }

  /**
   * Send user message. Returns a `SendReceipt` (P0-4) for observing the send's
   * terminal outcome — source-compatible with the old `void` return (callers may
   * ignore it). `undefined` ONLY for trimmed-empty input (R2b-3): no bubble, no
   * tracker mutation, no fabricated receipt.
   */
  send(text: string): SendReceipt | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;

    // P1-9 §3.3: abort-shaped text ALWAYS bypasses the hold. Holding an abort
    // deadlocks (the hold waits for the settle, the settle needs the abort);
    // releasing it later aborts the WRONG turn (the user's own just-started
    // follow-up, or a turn another device started). The server control lane
    // stays the single authority on what an abort DOES — we only ensure the text
    // reaches it immediately. An explicit `/stop` additionally retracts the held
    // messages (§3.4: "stop means stop everything, including what I queued"); NL
    // abort words leave held entries intact (mirroring the server, where only the
    // explicit command clears the buffer).
    if (isLikelyAbortText(trimmed)) {
      if (isExplicitStop(trimmed)) {
        this.stopCommitDepth++;
        let stopCommitted = false;
        try {
          // Snapshot the stop boundary before cancellation/finalization fanout:
          // every existing candidate is stopped one-way, while a follow-up that
          // a cancellation listener creates belongs after /stop and stays
          // eligible.
          this.consumeAllTurnOpenings();
          this.markHeldRetracted();
          // §3.4: /stop means "stop everything". Also locally finalize the live
          // turn-in-flight state (working drafts AND the typing indicator) so the
          // composer unwedges even when a turn dies WITHOUT a disconnect (agent
          // dies with the socket alive) — the staleness valve only arms on
          // reconnect, so without this /stop cannot rescue a socket-alive wedge.
          // Covers both a working-draft hang and a pre-first-token typing-only
          // hang. NL abort words do NOT call this.
          this.finalizeLocalTurnState();
          // #96: control-lane text — the plugin dispatches it with
          // `controlLane: true`, which sets `settlementEligible = false`, so this
          // publish never receives a `turn_settled` and must NOT open a turn.
          const receipt = this.publish(trimmed, false);
          stopCommitted = true;
          return receipt;
        } finally {
          this.stopCommitDepth--;
          // A failed outer publish must not release replacements ahead of a stop
          // that never committed. A nested stop never drains while its outer
          // transaction is still active.
          if (this.stopCommitDepth === 0 && stopCommitted) this.maybeRelease();
        }
      }
      // Control-lane text is a real published user message → a normal receipt.
      // #96: NL abort words route onto the control lane exactly like `/stop`
      // (`isControlLaneMessage` uses the FULL abort vocabulary, of which this
      // client mirror is a subset), so this publish never settles either.
      return this.publish(trimmed, false);
    }

    // P1-9 §3.1: hold while a turn is in flight OR anything is already held. The
    // `held.length > 0` latch preserves FIFO across a disconnect (onState(false)
    // forces isTyping:false, so without the latch a send during the reconnect
    // window would publish ahead of an earlier held message).
    if (this.shouldHold()) {
      const receiptKey = this.newReceiptKey();
      const localId = this.mintLocalBubbleId("u");
      const heldEntry = { localId, text: trimmed, receiptKey };
      this.held.push(heldEntry);
      if (this.deferredReplacementOpen()) {
        this.replacementHeldNeedsFreshEpisode = true;
      }
      // P0-4: a held send has a receipt (queued) but NO wireId yet — the wireId
      // is minted at release (2-phase). The receiptKey is the stable handle.
      this.receipts.set(receiptKey, {
        id: receiptKey,
        settlementEligible: true,
        turnOpeningConsumed: false,
        state: "queued",
        subscribers: new Set(),
        pendingTransitions: [],
        drainingTransitions: false,
      });
      // Install A's bubble silently before the timer callout, then expose the
      // entire nested admission transaction only after the outer timer/episode
      // commit finishes. A synchronous setTimeout hook that sends B therefore
      // preserves both UI and ownership order A,B and cannot expose a timerless
      // intermediate state.
      this.heldAdmissionNotificationDepth++;
      try {
        this.appendMessage({
          id: localId, role: "user", text: trimmed, pending: true, receiptKey, sendState: "queued",
        });
        this.ensureHeldStallEpisode();
      } finally {
        this.heldAdmissionNotificationDepth--;
        if (
          this.heldAdmissionNotificationDepth === 0
          && this.heldAdmissionNotificationPending
        ) {
          this.heldAdmissionNotificationPending = false;
          this.notifyStateListeners();
        }
      }
      return this.makeReceipt(receiptKey);
    }

    // #96: an ordinary user message — the plugin runs it as a normal turn and
    // answers with `turn_settled`, so its first `sent`/`accepted` transition can
    // open a turn.
    return this.publish(trimmed, true);
  }

  /**
   * P1-9 retraction. Accepts a PENDING (still held) or a RETRACTED (/stop-marked)
   * bubble by id: removes it from `held[]` (pending case) and from the transcript,
   * returns true. Any other id (a normal sent bubble, an agent bubble, unknown) →
   * false, no-op. No race with release: both run on the single JS thread and
   * release flips `pending` off synchronously before any user event observes it.
   */
  retract(id: string): boolean {
    const msg = this.state.messages.find((m) => m.id === id);
    if (!msg || (msg.pending !== true && msg.retracted !== true)) return false;
    const hi = this.held.findIndex((h) => h.localId === id);
    if (hi !== -1) {
      this.held.splice(hi, 1);
      if (this.held.length === 0) this.endHeldStallEpisode();
    }
    this.setState({ messages: this.state.messages.filter((m) => m.id !== id) });
    // P0-4 (R3-4): a cancel is still a terminal RECEIPT outcome even though the
    // render bubble is gone. The receipt record outlives the bubble, so
    // snapshot()/subscribe() report failed{cancelled} rather than a stuck queued.
    // A second retract of an already-cancelled bubble is a receipt no-op (guard).
    if (msg.receiptKey) {
      this.receiptTransition(msg.receiptKey, "failed", { reason: "cancelled", retryable: false });
    }
    return true;
  }

  /**
   * Publish a user message immediately — today's send path. Extracted so both the
   * no-hold and the abort-bypass branches share it (§3.1/§3.3).
   *
   * P0-4 commit order (D4): reserve the wire id, register the receipt record +
   * alias + render bubble SILENTLY, then let `sendUserMessage` own A's outbound
   * queue position before any state callback can synchronously send B. The queued
   * low-level event exposes the staged bubble; if that event is itself delayed by
   * a nested event drain, the commit helper exposes it once before returning.
   *
   * `settlementEligible` (#96) says whether the plugin will answer this publish
   * with a `turn_settled` — false for the two abort branches of `send()`, whose
   * text the server routes onto the control lane. The CALLER already knows which
   * branch it is; publish must never re-sniff the text.
   */
  private publish(trimmed: string, settlementEligible: boolean): SendReceipt {
    if (this.shouldDeferReplacementOperation()) {
      return this.deferReplacementPublish(trimmed, settlementEligible);
    }
    const receiptKey = this.newReceiptKey();
    const wireId = this.client.reserveWireId();
    this.wireIdToReceiptKey.set(wireId, receiptKey);
    this.receipts.set(receiptKey, {
      id: receiptKey,
      wireId,
      settlementEligible,
      turnOpeningConsumed: false,
      state: "queued",
      subscribers: new Set(),
      pendingTransitions: [],
      drainingTransitions: false,
    });
    // v6 §15.4: the echo's durable half (id/role/text/turnId + tail placement) is
    // the reducer's `user` transition; the receipt overlay is the client's.
    const bubbleId = this.mintLocalBubbleId("u");
    const messages = this.nextPublishedUserMessages(
      bubbleId,
      trimmed,
      wireId,
      { wireId, receiptKey, sendState: "queued" },
    );
    const randomId = this.mintRandomId(receiptKey);
    this.stageReceiptStateThenCommit(
      receiptKey,
      { messages },
      () => { this.client.sendUserMessage(trimmed, wireId, randomId); },
    );
    return this.makeReceipt(receiptKey);
  }

  // ---------------------------------------------------------------------------
  // #96 — turn-scoped "this turn is still open" signal (`state.turnActive`)
  // ---------------------------------------------------------------------------
  //
  // Opening/closing helpers mutate the open-turn set and report whether
  // `state.turnActive` must change; settlement placement is frozen separately
  // before reducer callouts. That lets each caller fold the flip into the state
  // patch it was already emitting rather than emitting a second one.
  //
  // That folding is per-CALLER, not a global atomicity claim: a reducer that
  // already emits several patches still emits several. `turn_settled{error}` is
  // the case to know about — its `promoteAnchor` fans out the anchor's
  // `failed{turn-failed}` bubble patch first (P0-4 requires the outcome to commit
  // before any UI settlement callout), so the `turnActive` flip lands in the
  // FOLLOWING fanout alongside `isTyping:false`. Both are consistent snapshots;
  // there is simply no single frame that carries the whole settle.

  /**
   * Consume a receipt's one chance to open its turn on the first authoritative
   * `sent`/`accepted` transition. `queued` is only client ownership; it can sit
   * pre-connect without ever reaching the wire. The one-way latch prevents a
   * later ack/replay from reopening a turn that a disconnect safety sweep closed.
   * Control-lane publishes are consumed without opening because they never emit
   * `turn_settled`; retired/closed instances likewise cannot start a live turn.
   */
  private openTurnFromReceipt(
    receipt: ReceiptRecord,
    state: NonNullable<ChatMessage["sendState"]>,
  ): boolean {
    if ((state !== "sent" && state !== "accepted") || receipt.turnOpeningConsumed) {
      return false;
    }
    receipt.turnOpeningConsumed = true;
    if (
      !receipt.settlementEligible
      || !receipt.wireId
      || !this.rawTransportConnected
      || this.terminal
      || this.closed
    ) {
      return false;
    }
    this.openTurns.add(receipt.wireId);
    return this.state.turnActive !== true;
  }

  /**
   * A settle can race ahead of the wrapper's authoritative publish callback
   * (notably an outcome-less legacy settle from a synchronous transport seam).
   * Consume every local settlement-eligible candidate through the named id in
   * publish order before any settlement callout, so a delayed `sent`/`accepted`
   * event cannot open work that has already ended.
   */
  private consumeTurnOpeningsThrough(
    turnId: string | undefined,
  ): TurnSettlementPlacement | undefined {
    if (!turnId) return undefined;
    const targetKey = this.wireIdToReceiptKey.get(turnId);
    const target = targetKey ? this.receipts.get(targetKey) : undefined;
    if (!target?.settlementEligible) return undefined;

    // The normal path needs only the live Set prefix. It avoids rescanning the
    // lifetime-retained wire map on every settle (which would make N sequential
    // turns O(N²)), and freezing the prefix here keeps it stable across the
    // synchronous outcome/subscriber fanout before `closeTurnsThrough` runs.
    if (this.openTurns.has(turnId)) {
      const openPrefix: string[] = [];
      for (const openTurnId of this.openTurns) {
        openPrefix.push(openTurnId);
        if (openTurnId === turnId) break;
      }
      return { openPrefix };
    }

    // Consumed + absent means an old replay (or safety-cleared turn) and must
    // remain a no-op. Only the rare settle-before-sent case needs publish-order
    // placement from the retained wire map.
    if (target.turnOpeningConsumed) return undefined;
    const openPrefix: string[] = [];
    for (const [wireId, receiptKey] of this.wireIdToReceiptKey) {
      const receipt = this.receipts.get(receiptKey);
      if (receipt?.settlementEligible) receipt.turnOpeningConsumed = true;
      if (this.openTurns.has(wireId)) openPrefix.push(wireId);
      if (wireId === turnId) break;
    }
    return { openPrefix };
  }

  /** Consume every candidate that exists at an explicit-stop boundary. */
  private consumeAllTurnOpenings(): void {
    for (const receipt of this.receipts.values()) {
      if (receipt.settlementEligible) receipt.turnOpeningConsumed = true;
    }
  }

  /**
   * Consume non-queued low-level outcomes whose wrapper callbacks are delayed
   * across a raw disconnect. Queued candidates deliberately survive for replay.
   */
  private consumeAdvancedTurnOpeningsAcrossDisconnect(): void {
    for (const receipt of this.receipts.values()) {
      if (!receipt.settlementEligible || receipt.turnOpeningConsumed || !receipt.wireId) continue;
      const tracked = this.client.getSendStateSnapshot(receipt.wireId);
      // A failed snapshot can still have an earlier `sent` event waiting in the
      // global FIFO (for example sent→failed{evicted}). Consume every advanced
      // state, not just success, or that stale sent event could open after loss.
      if (tracked && tracked.state !== "queued") {
        receipt.turnOpeningConsumed = true;
      }
    }
  }

  /**
   * Close a settled turn AND every turn opened before it (insertion order).
   *
   * Turns are NOT 1:1 with publishes. The agent buffers messages that arrive
   * while a turn runs and merges them: `inbound-queue.ts`
   * `coalesceUserMessages` folds N buffered messages into one turn keyed by the
   * LAST id (`messages[messages.length - 1].id`). The current plugin emits one
   * same-outcome `turn_settled` per member, in arrival order with that anchor
   * last. Exact-id receipt promotion handles the normal path. The prefix sweep
   * here remains necessary when an earlier member frame is lost/missing and for
   * older anchor-only v3 plugin builds; without
   * it an earlier wireId could sit in `openTurns` forever on a healthy
   * connection, a permanent false "still working".
   *
   * The session's work is processed in publish order and coalescing only ever
   * merges FORWARD, so a settle for `w3` proves every turn published before `w3`
   * has been subsumed by it or already settled. `Set` iterates in insertion
   * order, which is publish order here, so sweeping the prefix is exactly that
   * proof. The prefix is frozen before outcome fanout, so synchronous receipt
   * subscribers cannot move the boundary or make a later turn eligible to close.
   *
   * A known local target whose settle raced its first publish callback is also
   * placeable: its consume helper uses the wire-id map once to capture the
   * already-open prefix even though the target itself has not entered
   * `openTurns`. Normal settles never rescan that lifetime-retained map. An
   * unknown/other-device id or a consumed, already-closed replay remains a
   * no-op; neither may retire live work this frame cannot place.
   */
  private closeTurnsThrough(
    placement: TurnSettlementPlacement | undefined,
  ): boolean {
    if (!placement) return false;
    for (const wireId of placement.openPrefix) {
      this.openTurns.delete(wireId);
    }
    return this.openTurns.size === 0 && this.state.turnActive === true;
  }

  /**
   * Close exactly one turn whose send can no longer produce one. Used only by
   * the terminal-`failed` receipt hook (see `receiptTransition`): unlike a
   * settle, a failure says nothing about the turns published around it, so this
   * never sweeps the prefix.
   */
  private closeTurn(turnId: string | undefined): boolean {
    if (!turnId || !this.openTurns.delete(turnId)) return false;
    return this.openTurns.size === 0 && this.state.turnActive === true;
  }

  /**
   * Safety-point sweep: close EVERY open turn. Used by exactly the sites that
   * already force-clear `isTyping` (disconnect, terminal, `close()`, explicit
   * `/stop`, the post-reconnect staleness valve) — a lost `turn_settled` must
   * degrade to a missing signal, never a stuck one.
   */
  private clearOpenTurns(): boolean {
    if (this.openTurns.size === 0) return false;
    this.openTurns.clear();
    return this.state.turnActive === true;
  }

  /**
   * Stage an immediate/control send for the replacement lifecycle. Ownership is
   * installed before exposing the bubble, so a nested close can detach and fail
   * it without leaving a queued receipt behind.
   */
  private deferReplacementPublish(
    trimmed: string,
    settlementEligible: boolean,
  ): SendReceipt {
    const receiptKey = this.newReceiptKey();
    const localId = this.mintLocalBubbleId("u");
    this.deferredReplacementOperations.push({
      kind: "user", localId, text: trimmed, receiptKey,
    });
    this.receipts.set(receiptKey, {
      id: receiptKey,
      settlementEligible,
      turnOpeningConsumed: false,
      state: "queued",
      subscribers: new Set(),
      pendingTransitions: [],
      drainingTransitions: false,
    });
    this.appendMessage({
      id: localId,
      role: "user",
      text: trimmed,
      receiptKey,
      sendState: "queued",
    });
    return this.makeReceipt(receiptKey);
  }

  /** Preserve staged FIFO while replacement entries are being committed. */
  private shouldDeferReplacementOperation(): boolean {
    if (this.closed || this.terminal) return false;
    return this.deferredReplacementOpen()
      || this.deferredReplacementOperationCommitDepth > 0;
  }

  /** Queue an untracked operation or run it immediately on the current lifecycle. */
  private deferOrRunReplacementOperation(
    operation: Exclude<DeferredReplacementOperation, { kind: "user" }>,
  ): void {
    if (this.deferReplacementOperation(operation)) return;
    this.commitDeferredReplacementOperation(operation);
  }

  /** Reserve FIFO ownership before a public state callout when replacement-bound. */
  private deferReplacementOperation(
    operation: Exclude<DeferredReplacementOperation, { kind: "user" }>,
  ): boolean {
    if (!this.shouldDeferReplacementOperation()) return false;
    this.deferredReplacementOperations.push(operation);
    return true;
  }

  /** Hand one staged operation to the replacement inner lifecycle. */
  private commitDeferredReplacementOperation(
    entry: DeferredReplacementOperation,
  ): void {
    if (entry.kind === "approval-decision") {
      this.client.sendApprovalDecision(entry.id, entry.decision);
      return;
    }
    if (entry.kind === "load-history") {
      this.client.loadHistory(entry.before, entry.limit, entry.beforeTurnId);
      return;
    }
    if (entry.kind === "load-commands") {
      this.client.loadCommands();
      return;
    }

    const receipt = this.receipts.get(entry.receiptKey);
    if (!receipt || receipt.state === "failed" || receipt.state === "completed") return;

    const wireId = this.client.reserveWireId();
    this.wireIdToReceiptKey.set(wireId, entry.receiptKey);
    receipt.wireId = wireId;
    const bubble = this.state.messages.find(
      (message) => message.receiptKey === entry.receiptKey,
    );
    const randomId = this.mintRandomId(entry.receiptKey);
    if (bubble) {
      const messages = this.nextPublishedUserMessages(
        bubble.id,
        entry.text,
        wireId,
        { wireId },
        bubble,
      );
      this.stageReceiptStateThenCommit(
        entry.receiptKey,
        { messages },
        () => { this.client.sendUserMessage(entry.text, wireId, randomId); },
      );
    } else {
      this.client.sendUserMessage(entry.text, wireId, randomId);
    }
  }

  /** P1-9 §3.1: a turn is in flight when the agent is typing or a draft is working. */
  private turnInFlight(): boolean {
    return this.state.isTyping === true || this.state.messages.some((m) => m.working);
  }

  /** P1-9 §3.1: hold predicate — in flight OR the latch keeps prior holds first. */
  private shouldHold(): boolean {
    // P0-4: never hold after a terminal failure (a held send would escape the
    // held[] sweep and orphan). Publish instead → immediate failed{terminal}.
    if (this.terminal) return false;
    // A connect requested from a close() callout opens the replacement wrapper
    // lifecycle before the old socket is gone. Ordinary sends belong to that
    // replacement, but must remain held until its own session is established.
    if (this.deferredReplacementOpen()) return true;
    // P0-4 (review): never hold after an explicit close() either — held[] drains
    // only on onSession, which a closed instance never fires, so a hold here is a
    // permanent `queued`. Publish instead → immediate failed{closed}.
    if (this.closed) return false;
    // Ordinary callback-created sends cannot publish during an explicit-stop
    // transaction. They release only after the outer stop owns its queue slot.
    if (this.stopCommitDepth > 0) return true;
    if (this.heldReleaseCommitDepth > 0) return true;
    return this.turnInFlight() || this.held.length > 0;
  }

  /**
   * P1-9 §3.2: release ALL held messages FIFO once the turn has settled AND the
   * session key exists (a released burst hits an idle session — the first starts
   * a turn, the rest coalesce into one follow-up, exactly as a live burst does).
   *
   * Each released bubble is published, patched `{pending:false, wireId, turnId}`,
   * AND MOVED TO THE TAIL of `state.messages` (display position = publish
   * position). Moving to the tail is load-bearing, not cosmetic: the history
   * merge assumes local order mirrors the ORDER THE JOURNAL REPLAYS. An
   * in-place release would order a held chip ABOVE the reply it delayed while
   * the journal orders it after — a later user row could then adopt at a lower
   * index and drag the insertion cursor backwards, misplacing the rows after it.
   * Moving to the tail makes a released bubble an ordinary send in an ordinary
   * position.
   *
   * ⚠️ THE REASON NARROWED AT #240 HALF 2 AND STILL HOLDS. It used to cite the
   * tier-3 positional probe (deleted) and "the server transcript" (never read
   * any more — N2). What carries it now is the insertion cursor alone, on the
   * USER path, which is the one tier that still adopts. Also worth keeping from
   * the deleted tier: a fresh row inserting at the plain `cursor`, AHEAD of a
   * held chip, is chronologically right — anything a snapshot carries predates
   * an unpublished chip.
   *
   * Re-entrancy: drain `held[]` LIVE — `shift()` one entry per iteration rather
   * than snapshot-and-clear before the loop. Each staged bubble is exposed to
   * listeners synchronously after its low-level queue commit; a listener calling
   * `send()` re-entrantly must NOT jump the queue. With a live drain the still-
   * unreleased entries are genuinely present in `held[]`, so `shouldHold()`'s
   * `held.length > 0` latch holds that new message and the continuing loop takes
   * it in FIFO order. A snapshot-and-clear would leave `held[]` empty mid-loop
   * and let the re-entrant send publish AHEAD of the not-yet-released entries
   * (M1, M3, M2).
   * Two behaviors this preserves: (a) a re-entrant `retract()` of a not-yet-
   * released held item splices it out of the live array, so `shift()` never
   * reaches it — its publish is cancelled; (b) the last entry's listener calling
   * `send()` runs only AFTER that entry's `sendUserMessage` already fired, so
   * order stays correct.
   */
  private maybeRelease(): void {
    if (
      this.deferredReplacementOpen() ||
      this.stopCommitDepth > 0 ||
      this.heldReleaseCommitDepth > 0 ||
      this.held.length === 0 ||
      this.turnInFlight() ||
      !this.state.connected ||
      !this.sessionEstablished
    ) {
      return;
    }
    this.heldReleaseCommitDepth++;
    try {
      while (this.held.length > 0) {
        const heldEntry = this.held[0];
        if (this.held.length === 1) {
          // Keep the final entry explicitly wrapper-owned across timer cleanup.
          // clearTimeout is an embedder callout: close/retract/terminal must be
          // able to see and settle this entry before the stale release stack can
          // assign it a wire id. A plain reentrant send appends behind the exact
          // owner and is drained FIFO after it.
          const lifecycle = this.wrapperLifecycleGeneration;
          const receipt = this.receipts.get(heldEntry.receiptKey);
          this.endHeldStallEpisode();
          if (
            this.wrapperLifecycleGeneration !== lifecycle
            || !this.heldSessionReady()
            || this.held[0] !== heldEntry
            || this.receipts.get(heldEntry.receiptKey) !== receipt
            || receipt?.state !== "queued"
            || receipt.wireId !== undefined
          ) {
            return;
          }
        }

        // No callout exists between the exact-owner fence above and detachment.
        // For a non-final entry this is the ordinary live FIFO shift; for the
        // final entry the timer/lifecycle transaction has now committed.
        if (this.held[0] !== heldEntry) return;
        this.held.shift();
        const { localId, text, receiptKey } = heldEntry;
        // P0-4 commit order: reserve the wireId, register the alias, stage the bubble
        // at the tail, THEN let the low level own/publish A before exposing that move.
        const wireId = this.client.reserveWireId();
        this.wireIdToReceiptKey.set(wireId, receiptKey);
        const receipt = this.receipts.get(receiptKey);
        if (receipt) receipt.wireId = wireId;
        const bubble = this.state.messages.find((m) => m.id === localId);
        const randomId = this.mintRandomId(receiptKey);
        // A re-entrant listener may have already removed the bubble; the text is
        // still published (correct — release is a commit), so just skip the patch.
        if (bubble) {
          const messages = this.nextPublishedUserMessages(
            bubble.id,
            text,
            wireId,
            { pending: false, wireId },
            bubble,
          );
          this.stageReceiptStateThenCommit(
            receiptKey,
            { messages },
            () => { this.client.sendUserMessage(text, wireId, randomId); },
          );
        } else {
          // No bubble remains to stage. The authoritative `sent`/`accepted`
          // receipt callback still opens and exposes the turn only after the
          // low-level publish succeeds; `heldReleaseCommitDepth` keeps a listener
          // reached by that fanout from jumping this entry's FIFO position.
          this.client.sendUserMessage(text, wireId, randomId);
        }
      }
    } finally {
      this.heldReleaseCommitDepth--;
    }
  }

  /**
   * P1-9 §3.4: an explicit /stop moves every held entry out of `held[]` and flips
   * its bubble to `{pending:false, retracted:true}` — KEPT in the transcript
   * (text preserved, restorable), never auto-released. Unlike the server's
   * allowlist-gated buffer drop, client-held text exists nowhere else, so we mark
   * rather than delete (A6). NL abort words do not call this.
   */
  private markHeldRetracted(): void {
    if (this.held.length === 0) return;
    const entries = this.held.splice(0);
    this.endHeldStallEpisode();
    // P0-4: /stop is a user-intentional cancel — each held receipt ends at
    // failed{cancelled,retryable:false}, and its bubble flips to the retracted
    // marker (text preserved, restorable). receiptTransition patches the bubble
    // (sendState/sendFailure) alongside the pending→retracted flip.
    for (const e of entries) {
      this.receiptTransition(
        e.receiptKey,
        "failed",
        { reason: "cancelled", retryable: false },
        { pending: false, retracted: true },
      );
    }
  }

  /**
   * P0-4 (D5): fail every wrapper-owned held[] entry with `failure` and clear the
   * hold (they can no longer release). Their bubbles flip pending→false with the
   * failed sendState/sendFailure; `retracted` bubbles (already terminal) are left
   * untouched because they carry no held entry. Used by close() and terminal error.
   */
  private failHeld(failure: SendFailure): void {
    this.failHeldEntries(this.takeHeld(), failure);
  }

  private takeHeld(): Array<{ localId: string; text: string; receiptKey: string }> {
    const entries = this.held.splice(0);
    if (entries.length > 0) {
      this.endHeldStallEpisode();
    }
    return entries;
  }

  /** Fail a detached ownership snapshot without consuming replacement holds. */
  private failHeldEntries(
    entries: readonly { localId: string; text: string; receiptKey: string }[],
    failure: SendFailure,
  ): void {
    for (const e of entries) {
      this.receiptTransition(e.receiptKey, "failed", failure, { pending: false });
    }
  }

  /** Drop detached operations and fail only those with observable receipts. */
  private failDeferredReplacementOperations(
    entries: readonly DeferredReplacementOperation[],
    failure: SendFailure,
  ): void {
    for (const entry of entries) {
      if (entry.kind !== "user") continue;
      this.receiptTransition(entry.receiptKey, "failed", failure);
    }
  }

  // ---------------------------------------------------------------------------
  // #81 — wrapper-owned held-work application liveness
  // ---------------------------------------------------------------------------

  private heldSessionReady(): boolean {
    return this.sessionEstablished
      && this.state.connected
      && !this.deferredReplacementOpen()
      && !this.closed
      && !this.terminal;
  }

  /** Start only the first owner's episode; later held sends preserve its age. */
  private ensureHeldStallEpisode(): void {
    if (
      this.client.getAckStallTimeoutMs() === 0
      || this.held.length === 0
      || this.heldStallSinceAt !== null
      || this.heldStallRecoveryIssued
    ) {
      return;
    }
    this.beginHeldStallEpisode(this.heldSessionReady());
  }

  /**
   * Replace the held interval after authenticated live-turn activity, or record
   * a non-ready hold as already covered by the connection recovery in progress.
   */
  private beginHeldStallEpisode(ready: boolean): void {
    if (this.client.getAckStallTimeoutMs() === 0 || this.held.length === 0) return;
    const lifecycleGeneration = this.wrapperLifecycleGeneration;
    const mutationEpoch = ++this.heldStallMutationEpoch;
    this.heldStallSinceAt = null;
    this.heldStallRecoveryIssued = !ready;
    const cancellationToken = this.cancelHeldStallTimer();
    if (
      this.heldStallMutationEpoch !== mutationEpoch
      || this.heldStallTimerGeneration !== cancellationToken
      || this.heldStallTimer !== null
      || this.wrapperLifecycleGeneration !== lifecycleGeneration
      || this.held.length === 0
    ) {
      return;
    }
    if (!ready || !this.heldSessionReady()) return;

    const startedAt = Date.now();
    if (
      this.heldStallMutationEpoch !== mutationEpoch
      || this.heldStallTimerGeneration !== cancellationToken
      || this.heldStallTimer !== null
      || this.wrapperLifecycleGeneration !== lifecycleGeneration
      || this.held.length === 0 || !this.heldSessionReady()
    ) {
      return;
    }
    this.heldStallSinceAt = startedAt;
    this.heldStallRecoveryIssued = false;
    this.armHeldStallTimer();
  }

  /** Null ownership before clearTimeout so reentrant scheduling always wins. */
  private cancelHeldStallTimer(): number {
    const token = ++this.heldStallTimerGeneration;
    const timer = this.heldStallTimer;
    this.heldStallTimer = null;
    if (timer !== null) clearTimeout(timer);
    return token;
  }

  private armHeldStallTimer(): void {
    const timeoutMs = this.client.getAckStallTimeoutMs();
    const cancellationToken = this.cancelHeldStallTimer();
    if (
      timeoutMs === 0
      || this.heldStallTimerGeneration !== cancellationToken
      || this.heldStallTimer !== null
      || this.held.length === 0
      || this.heldStallSinceAt === null
      || this.heldStallRecoveryIssued
      || !this.heldSessionReady()
    ) {
      return;
    }
    const mutationEpoch = this.heldStallMutationEpoch;
    const lifecycleGeneration = this.wrapperLifecycleGeneration;
    const sinceAt = this.heldStallSinceAt;
    const now = Date.now();
    if (
      this.heldStallMutationEpoch !== mutationEpoch
      || this.heldStallTimerGeneration !== cancellationToken
      || this.heldStallTimer !== null
      || this.wrapperLifecycleGeneration !== lifecycleGeneration
      || this.held.length === 0 || this.heldStallSinceAt !== sinceAt
      || this.heldStallRecoveryIssued || !this.heldSessionReady()
    ) {
      return;
    }
    const delay = Math.max(0, timeoutMs - Math.max(0, now - sinceAt));
    const generation = ++this.heldStallTimerGeneration;
    const timer = setTimeout(() => {
      if (
        this.heldStallTimerGeneration !== generation
        || this.heldStallMutationEpoch !== mutationEpoch
        || this.wrapperLifecycleGeneration !== lifecycleGeneration
        || this.held.length === 0 || this.heldStallSinceAt !== sinceAt
        || this.heldStallRecoveryIssued || !this.heldSessionReady()
      ) {
        return;
      }
      this.heldStallTimer = null;
      this.heldStallTimerGeneration++;
      this.heldStallMutationEpoch++;
      this.heldStallRecoveryIssued = true;
      this.client.requestApplicationRecovery();
    }, delay);
    if (
      this.heldStallTimerGeneration !== generation
      || this.heldStallMutationEpoch !== mutationEpoch
      || this.heldStallTimer !== null
      || this.wrapperLifecycleGeneration !== lifecycleGeneration
      || this.held.length === 0 || this.heldStallSinceAt !== sinceAt
      || this.heldStallRecoveryIssued || !this.heldSessionReady()
    ) {
      clearTimeout(timer);
      return;
    }
    this.heldStallTimer = timer;
    const unrefTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
    unrefTimer.unref?.();
  }

  /** Raw replacement consumes the current allowance and owns all scheduling. */
  private consumeHeldStallForRawLoss(): void {
    if (this.client.getAckStallTimeoutMs() === 0 || this.held.length === 0) return;
    this.heldStallMutationEpoch++;
    this.heldStallRecoveryIssued = true;
    this.cancelHeldStallTimer();
  }

  /** Final-owner removal retires state before any receipt/state/client callback. */
  private endHeldStallEpisode(): void {
    // Clear the retired owner's marker before canceling its timer. A synchronous
    // clearTimeout hook may connect+send replacement work and set the marker
    // again; that newer ownership must win when this method resumes.
    this.replacementHeldNeedsFreshEpisode = false;
    this.heldStallMutationEpoch++;
    this.heldStallSinceAt = null;
    this.heldStallRecoveryIssued = false;
    this.cancelHeldStallTimer();
  }

  private observeHeldTurnActivity(msg: InboundMessage, preFrameLiveTurn: boolean): void {
    if (
      !preFrameLiveTurn
      || this.held.length === 0
      || !this.heldSessionReady()
      || (
        msg.type !== "typing"
        && msg.type !== "progress"
        && msg.type !== "reasoning"
        // #97: a tool_activity frame, like reasoning, proves the turn is alive.
        && msg.type !== "tool_activity"
        && msg.type !== "agent_message"
      )
    ) {
      return;
    }
    this.beginHeldStallEpisode(true);
  }

  // ---------------------------------------------------------------------------
  // P1-9 §3.6: stale working-draft reconciliation
  // ---------------------------------------------------------------------------

  /**
   * §3.6.1: settle any `working` draft whose turnId matches a settled turn.
   * Settled means no more upserts are coming; if `turnInFlight` drops as a
   * result, the end-of-frame `maybeRelease()` releases held messages.
   *
   * "Settle" is TWO outcomes since #251, not the flip-in-place this used to
   * promise: a draft that received durable text flips `working: false` with its
   * id and text untouched, while one that never did is DROPPED. `turn_settled` is
   * a genuine turn-end signal, so an unfinalized lane has nothing left to become.
   */
  /**
   * #212 (Phase 3, targeted): reconcile the live turn's AGENT ANSWER bubbles to
   * the plugin's authoritative `turn_snapshot`. The plugin owns per-message
   * identity; this is a PURE VIEW of its `answers` (ordered {id,text}) with a
   * `remove` set naming the bubbles it mis-routed answer content onto.
   *
   * The contract is EXPLICIT, never a blanket "drop everything not listed":
   *  - `answers` bubbles are upserted by id (existing bubble updated in place; an
   *    id we do not hold yet is MINTED — a lane that streamed but whose wire
   *    frames failed, e.g. the #215 mid-lane B recovery) and then reordered into
   *    snapshot order among the slots answer bubbles already occupy;
   *  - `remove` ids are dropped (an overflow final, or a recovery block now
   *    represented by an `answers` lane);
   *  - EVERYTHING else is untouched: user bubbles (receipts/held/sendState),
   *    notices/errors, an adopted durable-history agent row that shares the turn,
   *    and every non-answer agent bubble keeps its slot — only answer bubbles
   *    reorder, and only among themselves.
   * Case X is unaffected: its tool bubble is neither in `answers` (it never
   * streamed) nor in `remove`, so it is preserved exactly as before.
   *
   * v6 §15.4: that whole reconciliation now lives in the shared reducer's `seal`
   * transition (`durable-view-reducer.ts`'s `applySeal`, which was already a
   * line-for-line port of the body this method used to hold). What survives here
   * is the FRAME → EVENT mapper plus the client-local half:
   *
   *  - the two early returns are reproduced EXACTLY, including that neither sets
   *    `isTyping: false`. A no-op snapshot must stay a no-op — emitting a state
   *    patch and a listener notification for a frame that changes nothing is a
   *    real regression, however small;
   *  - the wire filters are applied HERE as well as inside `applySeal` (which
   *    re-applies them idempotently) because the early-return decision and the
   *    per-answer overlay both need the FILTERED set. An answer with a blank id
   *    is dropped by the reducer, so it must not contribute an overlay either;
   *  - `working: false` + clearing `draftOnly` on every answer is the overlay
   *    that reproduces the old body's answer objects, for the reused and the
   *    minted branch alike.
   */
  /**
   * ⚠️ RETURNS "WAS THIS FRAME FOLDED" (#246 half A) — `turn_snapshot` is
   * SEQ-BEARING, so this verdict is what `handleFrame` hands the cursor. The two
   * early returns are deliberately DIFFERENT answers: a `turnId`-less frame is
   * REFUSED (`false` — nothing this method can key on, so the gap must stay open
   * until the canonical `seal` is re-served), while a snapshot with nothing to
   * seal and nothing to remove is ACCEPTED (`true` — an empty seal is a real,
   * foldable no-op; refusing it would buy a `get_difference` round-trip to
   * re-fetch a row that changes nothing). "Nothing" means the wire arrays were
   * absent or empty: the door (`decodeInboundMessage`) refuses an empty answer
   * id or remove entry, so the filters below cannot reduce a frame that carried
   * content to this early return.
   */
  private applyTurnSnapshot(msg: InboundMessage): boolean {
    const turnId = msg.turnId;
    if (typeof turnId !== "string" || turnId.length === 0) return false;
    const rawAnswers = (Array.isArray(msg.answers) ? msg.answers : []).filter(
      (a): a is { id: string; text: string } =>
        !!a &&
        typeof a.id === "string" &&
        a.id.length > 0 &&
        typeof a.text === "string",
    );
    // Defense-in-depth: the plugin never repeats an id (lane ids and minted ids
    // are unique), but a duplicate would break the slot-refill's
    // `slots.length === answers.length` assumption. Keep the FIRST occurrence.
    const answerSeen = new Set<string>();
    const answers = rawAnswers.filter((a) =>
      answerSeen.has(a.id) ? false : (answerSeen.add(a.id), true),
    );
    const remove = (Array.isArray(msg.remove) ? msg.remove : []).filter(
      (r): r is string => typeof r === "string" && r.length > 0,
    );
    if (answers.length === 0 && remove.length === 0) return true;

    // Answer ids are wire-controlled; `__proto__` must be an ordinary overlay key.
    const local = Object.create(null) as DurableLocalOverlay;
    for (const a of answers) {
      // A sealed answer is authored durable text, so it is no longer a draft.
      local[a.id] = { working: false, draftOnly: undefined };
    }
    this.applyDurable({ kind: "seal", turnId, answers, remove }, local, { isTyping: false });
    return true;
  }

  private finalizeDraftsForTurn(turnId?: string): void {
    if (!turnId) return;
    let changed = false;
    // #251: the ordinary turn end. A lane whose draft never became durable text
    // disappears here — the same thing Telegram's user sees when an unfinalized
    // preview is cleared at turn end.
    const messages = this.dropSpentDrafts(
      this.state.messages.map((m) => {
        if (m.working && m.turnId === turnId) {
          changed = true;
          this.staleDraftWatch.delete(m.id);
          return { ...m, working: false };
        }
        return m;
      }),
    );
    if (changed) this.setState({ messages });
  }

  /**
   * §3.4: settle the local turn-in-flight state — flip EVERY live `working` draft
   * to `working: false` (staleness-watch entry dropped) AND clear the `isTyping`
   * indicator. Both feed `turnInFlight()`, so clearing them is what actually
   * unwedges the composer. Called only from the explicit-`/stop` branch of send():
   * "stop everything" must unwedge immediately, not wait for a
   * `turn_settled`/final frame that may never arrive (agent died with the socket
   * alive). Covers BOTH a working-draft hang and a pre-first-token typing-only
   * hang (isTyping true, zero drafts).
   *
   * #251: a draft that never received durable text is DROPPED rather than flipped
   * in place — an explicit `/stop` is a genuine turn end, so an unfinalized lane
   * has nothing to become. A draft that DID receive durable text keeps its id and
   * text exactly as before.
   *
   * The self-healing invariant survives the drop, but ONLY FOR IDENTITY, not for
   * position: if the turn was actually still alive, a later `typing`/`progress`
   * re-sets the state this cleared and the lane comes back under the SAME id (one
   * bubble, and its eventual final still matches it) — but `applyPlacement`
   * appends, so it re-materialises at the TAIL rather than in its old slot. A
   * `/stop` mid-turn can therefore leave the late answer BELOW the user's `/stop`
   * bubble. That is Telegram-faithful: the preview was deleted, so the lane
   * returning is a new delivery act. Pinned in `durable-view-reducer.test.ts`
   * ("late progress after a drop re-materialises the lane at the TAIL (#251)").
   */
  private finalizeLocalTurnState(): void {
    let changed = false;
    // #251: "stop everything" ends the turn, so an unfinalized lane's bubble goes
    // with it rather than freezing at its last partial.
    const messages = this.dropSpentDrafts(
      this.state.messages.map((m) => {
        if (m.working) {
          changed = true;
          this.staleDraftWatch.delete(m.id);
          return { ...m, working: false };
        }
        return m;
      }),
    );
    const clearTyping = this.state.isTyping === true;
    // #96: "stop everything" includes the turn-open signal — otherwise a widget
    // would keep claiming the agent is working on a turn the user just killed
    // (no `turn_settled` is coming for an aborted turn).
    const turnsCleared = this.clearOpenTurns();
    if (!changed && !clearTyping && !turnsCleared) return;
    this.setState({
      ...(changed ? { messages } : {}),
      ...(clearTyping ? { isTyping: false } : {}),
      ...(turnsCleared ? { turnActive: false } : {}),
    });
  }

  /**
   * §3.6.2: arm the post-reconnect staleness valve FRESH — record the ids of the
   * currently-`working` drafts and start a one-shot grace timer. Called only from
   * onSession (session re-establishment), never during a healthy connection, so
   * the normal lifecycle can't trip it. Clears any prior watch/timer first.
   */
  private armStaleDraftWatch(): void {
    this.clearStaleDraftWatch();
    for (const m of this.state.messages) {
      if (m.working) this.staleDraftWatch.add(m.id);
    }
    if (this.staleDraftWatch.size === 0) return;
    this.staleDraftTimer = setTimeout(
      () => this.expireStaleDrafts(),
      WebChannelNATSClient.STALE_DRAFT_GRACE_MS,
    );
  }

  /** §3.6.2: clear the watch set AND the grace timer (connection teardown / re-arm). */
  private clearStaleDraftWatch(): void {
    this.staleDraftWatch.clear();
    if (this.staleDraftTimer) {
      clearTimeout(this.staleDraftTimer);
      this.staleDraftTimer = null;
    }
  }

  /** §3.6.2: reasoning-frame disarm — drop watched drafts belonging to `turnId`. */
  private disarmStaleDraftsByTurn(turnId: string): void {
    if (this.staleDraftWatch.size === 0) return;
    for (const m of this.state.messages) {
      if (m.turnId === turnId && this.staleDraftWatch.has(m.id)) {
        this.staleDraftWatch.delete(m.id);
      }
    }
  }

  /**
   * §3.6.2: grace expired. Any draft still in the watch set (no draft-touching
   * frame arrived across the grace) is presumed stale — flip `working: false` IN
   * PLACE and PROMOTE its partial text to durable (id, text and slot untouched,
   * so a WRONG guess self-heals: a later progress upsert re-matches the id and
   * re-flips it working, in its original slot, re-engaging the hold). Then
   * re-evaluate the release gate.
   */
  private expireStaleDrafts(): void {
    this.staleDraftTimer = null;
    if (this.staleDraftWatch.size === 0) return;
    let changed = false;
    // #251 DOES NOT APPLY HERE, and the difference is the whole point: this is
    // the ONE draft-settling site that is not a turn-end signal. The reference
    // deletes an unfinalized preview inside a `finally` around the whole dispatch
    // — `[core] extensions/telegram/src/bot-message-dispatch.ts:2954-2975`, i.e.
    // the turn genuinely ENDED, abort path included. This valve is a
    // CONSUMER-SIDE GUESS fired MID-TURN: armed at session re-establish, tripped
    // by 30s of quiet on a turn that may be perfectly healthy. Deleting content on
    // a guess is the wrong side of N10, so the other three sites (terminal settle,
    // `turn_settled`, explicit `/stop` — all real turn-end signals) drop, and this
    // one PROMOTES: `draftOnly` is cleared, the partial the user was already
    // reading becomes durable, and the bubble stays in its slot.
    //
    // Clearing the bit is required, not cosmetic — merely SKIPPING the drop here
    // would commit `working:false && draftOnly:true`, which `mergeDurable`'s rule
    // 4 would then drop on the next unrelated frame anyway.
    //
    // Honest consequence: a dropped connection whose turn never settles leaves the
    // frozen partial bubble on screen. That is the pre-#251 status quo at this
    // site, not a regression — we only delete when we KNOW the turn ended.
    const messages = this.state.messages.map((m) => {
      if (this.staleDraftWatch.has(m.id) && m.working) {
        changed = true;
        const promoted: ChatMessage = { ...m, working: false };
        delete promoted.draftOnly;
        return promoted;
      }
      return m;
    });
    // #96: the same verdict applies to the turn-open signal — the grace expired
    // with no proof of life, so stop claiming a turn is running.
    //
    // SCOPE, stated honestly: the evidence is PER-DRAFT but this sweep is
    // ALL-OR-NOTHING. One wedged draft expiring therefore also drops the signal
    // for any other turn that happens to be open, healthy or not (drafts are
    // watched by id; turns are not correlated to them at all). Accepted: the
    // error is one-sided, which is strictly better than a spinner for a turn that
    // is already dead. But be precise about the cost — unlike a swept `isTyping`,
    // which a later `typing` frame re-arms, a swept turn is NOT recoverable: its
    // receipt already consumed the one-way opening latch. A turn that was really
    // alive loses its indicator for good, and only its own settle (or a later one
    // sweeping past it) tidies the set. Swept BEFORE `maybeRelease()`, so a
    // follow-up released right here opens its own fresh turn rather than being
    // caught by this same sweep.
    const turnsCleared = this.clearOpenTurns();
    this.staleDraftWatch.clear();
    if (changed || turnsCleared) {
      this.setState({
        ...(changed ? { messages } : {}),
        ...(turnsCleared ? { turnActive: false } : {}),
      });
    }
    this.maybeRelease();
  }

  /**
   * Send approval decision.
   *
   * ⚠️ #242 half 4: A CARD THIS DEVICE HOLDS AND KNOWS IS NOT ACTIONABLE IS
   * REFUSED HERE, NOT ONLY GREYED OUT IN A RENDERER. Approvals became durable
   * messages in this slice, so a REPLAYED card sits in the transcript looking
   * exactly like a live one — unresolved as far as the durable stream records,
   * while it may have expired or been decided elsewhere since. Sending a
   * decision for it means answering a question nobody is waiting for. The
   * renderer is the wrong and only place to enforce that: an embedder writes its
   * own renderer, and the shipped demo used to key its buttons purely off
   * `resolvedDecision !== undefined` — which a replayed pending card satisfies.
   * `isActionableApproval` is the same predicate `state.approvals` reports, so
   * the button and the call agree by construction.
   *
   * ⚠️ AN UNKNOWN ID IS STILL SENT, AND THAT ASYMMETRY IS DELIBERATE. This
   * refuses only what it can PROVE stale. A card this client never held carries
   * no evidence either way — an embedder answering out of band is the documented
   * behaviour and the wrapper has no basis to override it — so the operation
   * goes out exactly as before. (It is also unreachable from a UI: nothing
   * renders a card that is not in `state.approvals`.)
   *
   * ⚠️ THE `setState` IS UNCONDITIONAL ON PURPOSE. It fires even when the
   * optimistic mark changes nothing, because that has always been true here
   * (`patchApproval` mapped and committed regardless) and the replacement-FIFO
   * ordering depends on it: a state listener may synchronously raise another
   * outbound operation, and it must land BEHIND the decision reserved above.
   */
  decide(id: string, decision: ApprovalDecision): void {
    const held = this.state.messages.find(
      (m): m is ChatApprovalMessage => m.kind === "approval" && m.id === id,
    );
    if (held !== undefined && !isActionableApproval(held)) return;
    const operation = { kind: "approval-decision", id, decision } as const;
    // In a replacement transaction, reserve the decision's FIFO position before
    // optimistic UI fanout. A state listener may synchronously emit another
    // outbound operation; it belongs behind this already-invoked decision.
    const deferred = this.deferReplacementOperation(operation);
    this.setState({ messages: this.optimisticApprovalDecision(id, decision) });
    if (!deferred) this.deferOrRunReplacementOperation(operation);
  }

  /**
   * Record `decide()`'s OPTIMISTIC decision on the card, leaving
   * `resolutionConfirmed` falsy so `approval_snapshot`'s Leg C can detect a lost
   * decision frame and re-send it (#15).
   *
   * It rides `resolvedDecision`, the same field the server's answer folds into,
   * because that is what makes the card stop offering buttons immediately — and
   * because `projectDurable` carries the field, the guess survives the next
   * unrelated durable frame instead of being re-projected away. Nothing local
   * is ever journaled; the plugin builds its own events from wire frames.
   *
   * Returns the input array by reference when no card matched.
   */
  private optimisticApprovalDecision(
    id: string,
    decision: ApprovalDecision,
  ): ChatMessage[] {
    let changed = false;
    const next = this.state.messages.map((m) => {
      if (m.kind !== "approval" || m.id !== id) return m;
      changed = true;
      return { ...m, resolvedDecision: decision };
    });
    return changed ? next : this.state.messages;
  }

  /**
   * Request history page.
   *
   * `beforeTurnId` completes the cursor when `before` names a TOOL row, which is
   * identified by the pair `(turnId, id)` — an id-only cursor over a repeated
   * tool id is ambiguous and the server refuses it (#320). Optional and additive:
   * omitting it is the id-only cursor. `demo/web/src/presentation.ts`'s
   * `oldestHistoryCursor` is the reference picker.
   */
  loadHistory(request?: { before?: string; beforeTurnId?: string; limit?: number }): void {
    this.deferOrRunReplacementOperation({
      kind: "load-history",
      before: request?.before,
      beforeTurnId: request?.beforeTurnId,
      limit: request?.limit,
    });
  }

  /**
   * Request the slash-command discovery catalog (P0-3). The agent answers with
   * a `commands` frame that lands in `state.commands`. UI calls this the first
   * time the user types `/` (lazy discovery); repeat calls are cheap and simply
   * refresh the catalog.
   */
  loadCommands(): void {
    this.deferOrRunReplacementOperation({ kind: "load-commands" });
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  /**
   * Public state listeners are isolated so an embedder render bug cannot abort a
   * send, a staged-bubble exposure, or a held drain midway through its FIFO commit.
   */
  private setState(patch: StatePatch): void {
    this.state = nextStateFrom(this.state, patch);
    this.notifyStateListeners();
  }

  private notifyStateListeners(): void {
    if (this.heldAdmissionNotificationDepth > 0) {
      this.heldAdmissionNotificationPending = true;
      return;
    }
    this.stateNotificationSeq++;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (e) {
        console.error("[nats-wrapper] state listener threw:", e);
      }
    }
  }

  /**
   * Install a receipt bubble/update before committing its low-level send, without
   * exposing it early. The low-level queued callback normally performs the public
   * fanout after queue ownership is established. If that callback is delayed by a
   * surrounding send-state drain, expose the staged state once after commit.
   */
  private stageReceiptStateThenCommit(
    receiptKey: string,
    patch: StatePatch,
    commit: () => void,
  ): void {
    const notificationSeq = this.stateNotificationSeq;
    // Routed through the SAME derivation as `setState` — this is the other door
    // into `this.state`, and a direct spread here would leave `reasoning` stale
    // for any staged patch that touches `messages`.
    this.state = nextStateFrom(this.state, patch);
    this.stagedReceiptExposures.add(receiptKey);
    try {
      commit();
    } finally {
      this.stagedReceiptExposures.delete(receiptKey);
      if (this.stateNotificationSeq === notificationSeq) this.notifyStateListeners();
    }
  }

  private appendMessage(message: ChatMessage): void {
    this.setState({ messages: [...this.state.messages, message] });
  }

  // ---------------------------------------------------------------------------
  // v6 §15.4 (#237) — the durable half of `state.messages` is computed by the
  // SHARED REDUCER, not by hand-rolled reconciliation here.
  // ---------------------------------------------------------------------------
  //
  // The design's central bet is `history == the live view` BY CONSTRUCTION: one
  // pure reducer (`durable-view-reducer.ts`) produces both this client's live
  // view and — later, from the journal — the server's history projection. A
  // reducer with no runtime consumer guarantees nothing, so THIS is its first
  // consumer (NOT-list N8).
  //
  // Shape: `state.messages` stays the ONE array. There is deliberately no
  // parallel durable event log and no retained `DurableView` field — we PROJECT
  // `state.messages`, apply exactly one event, and merge the result back. That
  // keeps bubbles the reducer never authored (adopted history rows, notices)
  // inside the view, so they hold their slots through a `seal` exactly as
  // `applySeal` promises, and it means the history merge's adoption of a
  // snapshot row (which writes `state.messages` directly) automatically seeds
  // the next projection without being routed through the reducer.
  //
  // Split of ownership, per §0.1 / the north star: the REDUCER owns id, role,
  // durable text, turnId and ORDER; the CLIENT owns its own overlay (`working`,
  // `ts`, `sendState`/`sendFailure`, `receiptKey`, `wireId`, `pending`,
  // `retracted`, `assistantMessageIndex`, `draftOnly`), which is never journaled.

  /**
   * Project `state.messages` down to the durable view the reducer operates on.
   *
   * The §15.9 rule it applies (a `draftOnly` bubble contributes `text: ""`) lives
   * in the reducer module, NOT here: it is the durability boundary itself, and
   * the eventual server projection must inherit the same one. A second copy in
   * the render path would be an N8 live≠history divergence with nothing to make
   * it go red.
   */
  private durableProjection(): DurableView {
    return projectDurableFromClient(this.state.messages);
  }

  /**
   * #251: an agent bubble that claimed a slot via `progress` and never received
   * durable text renders NOTHING once it stops working.
   *
   * Settled from the reference, not chosen: core's built-in Telegram extension
   * DELETES an unfinalized preview at turn end —
   * `[core] extensions/telegram/src/bot-message-dispatch.ts:2971-2975`
   * (`lane.finalized ? stream.stop() : stream.clear()`), and `clear()` really
   * deletes (`draft-stream.ts:653-668` → `:634 api.deleteMessage`). A preview
   * becomes durable in exactly two cases — it finalized, or it is a completed
   * overflow chunk (`draft-stream.ts:409`, `:479`, the only two `retain: true`
   * sites). `draft-stream.ts:277` says it outright: "ephemeral preview to
   * delete, NOT a durable content chunk to retain."
   *
   * The predicate keys on `draftOnly`, NOT on `text === ""`. Two reasons:
   *  - `draftOnly` OUTLIVES the `working` flip, so the drop is actually
   *    reachable at turn end. A text test is not: by then `text` holds the last
   *    partial, so the bubble would freeze forever — today's bug;
   *  - it cannot swallow a legitimately empty durable message. Every answer /
   *    final path guards non-empty text (`message-adapter.ts:944`, `:1716`,
   *    `:2521`; `inbound.ts:1446`), but the generic outbound seam
   *    (`channel.ts:311`) forwards core's `ctx.text` unchecked, so empty durable
   *    text is not structurally impossible. Keying on `draftOnly` makes that
   *    moot instead of relying on the guarantee.
   */
  private isSpentDraft(m: ChatMessage): boolean {
    return m.role === "agent" && m.working !== true && m.draftOnly === true;
  }

  /**
   * Apply the #251 drop to a messages array the caller built WITHOUT the
   * reducer. THREE sites call this — terminal settle, `finalizeDraftsForTurn`
   * and `finalizeLocalTurnState`. Each is a real turn-end signal, which is what
   * makes the drop safe: core deletes an unfinalized preview at TURN END
   * (`[core] extensions/telegram/src/bot-message-dispatch.ts:2954-2975`).
   *
   * ⚠️ `expireStaleDrafts` also flips `working: false` and is deliberately NOT
   * routed here — it PROMOTES instead (see its body). Do not "fix" that
   * asymmetry: that valve is a consumer-side guess fired mid-turn on a possibly
   * healthy turn, and deleting a partial the user is reading on a guess is the
   * N10 violation this split exists to prevent. Wiring it in would look like a
   * consistency cleanup and would silently restore content deletion.
   *
   * Doing the drop here rather than routing these sites through `applyDurable`
   * keeps them event-free: there is no "nothing happened" `DurableEvent`, and
   * BOUNDARY 2 forbids inventing one.
   */
  private dropSpentDrafts(messages: ChatMessage[]): ChatMessage[] {
    return messages.some((m) => this.isSpentDraft(m))
      ? messages.filter((m) => !this.isSpentDraft(m))
      : messages;
  }

  /**
   * Merge a reducer-produced `DurableView` back onto `state.messages`.
   *
   *  1. every client-local field is carried from the `prev` bubble with the same
   *     id (the whole overlay — `ts`, `working`, `sendState`, `receiptKey`, …).
   *     ⚠️ THE CARRY IS KEYED BY (KIND, id), NOT BY id: `state.messages` can
   *     hold a same-id pair of different kinds (`case "history"`'s cross-kind
   *     fresh insert), and each member keeps its OWN overlay. This sentence was
   *     false while `prev` was indexed by id alone — see the two kind-scoped
   *     maps below for what went wrong and how;
   *  2. `id`, `role`, `text` and `turnId` come from the view (`turnId` falls back
   *     to `prev`'s), EXCEPT that a still-`draftOnly` entry keeps `prev.text` —
   *     its durable text is `""` by construction and the rendered text is the
   *     client-local draft, so taking the view's `""` would blank a live draft
   *     whenever an unrelated frame triggers an apply;
   *  3. an OWN `local[id]` is applied LAST and wins. Prototype properties are
   *     never overlays. A key set to `undefined` DELETES it (that is how
   *     `draftOnly` is cleared), rather than leaving an `undefined`-valued key
   *     that would defeat the identity reuse below;
   *  4. a spent draft (see `isSpentDraft`) is OMITTED;
   *  5. an id in `prev` but absent from the view is dropped — that is `seal`'s
   *     `remove` working as designed. ⚠️ SINCE #241 half 2 a `seal.remove` no longer makes the
 *     id ABSENT — it leaves a tombstone (`kind: "text", deleted: true`) in the
 *     view at its slot — so the drop now happens via the tombstone strip at the
 *     TOP of the loop rather than by absence. Either way a removed id is not
 *     rendered.
   *
   * ⚠️ RULES 1-4 ARE ABOUT BUBBLES. A `kind: "reasoning"` or `kind: "tool"`
   * entry takes a short branch at the top of the loop: it has no `local[id]`
   * overlay to lay on (rule 1/3), no `draftOnly` carve-out (rule 2) and no
   * spent-draft state (rule 4). Rule 5 and the reference-reuse guarantee below
   * apply to it unchanged. #242 half 2 / half 3.
   *
   * ⚠️ AN APPROVAL ENTRY IS THE ONE TAGGED ARM THAT PARTIALLY BREAKS THAT — read
   * its branch before assuming "tagged ⇒ no client state". It takes no
   * `local[id]` overlay either, but it DOES carry client-local fields
   * (`actionable`, `resolutionConfirmed`, `resolvedElsewhere`) that must be
   * inherited from `prev` exactly the way rule 1 inherits a bubble's overlay.
   * #242 half 4.
   *
   * Entries whose emitted fields are unchanged are returned BY REFERENCE. That
   * is required, not an optimization: `nats-client-wrapper.test.ts` asserts
   * `.toBe` identity for untouched user/notice/history bubbles across a
   * `turn_snapshot`. It is also the reducer's own structural-sharing discipline
   * — `DurableMessage` being `readonly` forbids writing THROUGH a shared entry,
   * not handing an unchanged one back. Note this is entry identity only: do NOT
   * build an ARRAY-identity no-op signal on top (the reducer's header is
   * explicit that array identity is a partial property).
   */
  private mergeDurable(
    prev: ChatMessage[],
    view: DurableView,
    local?: DurableLocalOverlay,
  ): ChatMessage[] {
    // `base` is looked up in the PRE-`remove` `prev`, so an id appearing in BOTH
    // `seal.remove` and `seal.answers` would inherit the removed bubble's
    // client-local fields rather than starting clean. Unreachable by construction
    // rather than by a guard here: `emitTurnSnapshot` builds `answers` from lane
    // ids and `remove` from `supersededAnswerBubbleIds`, which are disjoint sets.
    // Recorded rather than branched on — an unreachable branch with no test is
    // worse than a stated invariant.
    // ⚠️ KIND-SCOPED INDEXES, NEVER ONE KEYED BY ID. The id spaces (answer/user
    // bubbles, reasoning blocks, and — since #242 half 3 — tool calls) are not
    // provably disjoint — the reducer's `findTextIndex` docblock retracts the
    // id-shape argument that used to claim they were — and `case "history"` now
    // DELIBERATELY produces a same-id pair of different kinds when a snapshot row
    // collides with a local entry of the other kind.
    //
    // ⚠️ A SINGLE `Map<string, ChatMessage>` WITH A KIND GUARD ON THE LOOKUP WAS
    // TRIED AND WAS WRONG, in exactly the way `case "history"`'s id-keyed index
    // was wrong: a Map is LAST-WINS, so `get(id)` on such a pair returned
    // whichever member sat later in the array and the guard turned that into
    // `undefined` for the EARLIER one — dropping its WHOLE overlay (rule 1), not
    // one field. Measured: a hydrated bubble lost its `ts` on the next unrelated
    // durable frame; the same loss takes `receiptKey` (after which
    // `patchBubbleByReceiptKey` can never find that bubble), `wireId` (breaking
    // `promoteAnchor`) and `pending` (making `retract()` return false for a
    // bubble still in `this.held[]`). Scoping the INDEX makes each member find
    // its own `prev`, and the guards disappear because the key does the work.
    //
    // ⚠️ THE THREE MAPS ARE NO LONGER BUILT HERE. Half 3 moved the construction
    // into `indexTranscriptByKind`, whose exhaustive switch makes a FORGOTTEN
    // KIND a compile error — the copy-paste that would have made this loop's
    // `if/else` silently file tool entries under the bubble key space. See that
    // function for why the buckets stay separately typed.
    const prevByKind = indexTranscriptByKind(prev);
    const out: ChatMessage[] = [];
    for (const entry of view) {
      // ⚠️ #241 half 2: STRIP TOMBSTONES. A permanent typed delete — today only a
      // `seal.remove` — leaves a `{ kind: "text", deleted: true, text: "" }`
      // entry in the durable view at its slot so a later same-id event cannot
      // resurrect it (the reducer's no-resurrect guards). It must never become a
      // rendered `ChatMessage`: dropping it here makes a removed id invisible,
      // exactly as the old `filter`-based `seal` did (rule 5). This is the CLIENT
      // half of the strip; `journal-history.ts` drops the same entries when it
      // serves history, and both fold the SAME reducer — so live == history.
      if (entry.kind === "text" && entry.deleted === true) continue;
      // ⚠️ #242 half 2: A REASONING ENTRY IS CARRIED, NOT SKIPPED. Half 1 had a
      // `continue` here because `state.messages` was the chat-BUBBLE list and
      // the client rendered reasoning from a separate `state.reasoning` array.
      // Half 2 made `ChatMessage` a tagged union and moved reasoning into this
      // array, so the entry maps across as itself.
      //
      // It carries NO overlay and NO `role` — see `ChatReasoningMessage` for why
      // neither can apply. The one client-local field it can hold is `ts`
      // (hydration metadata off a `history` row), and it is inherited from the
      // previous entry exactly the way rule 1 inherits the bubble overlay.
      //
      // ⚠️ THE `ts` INHERITANCE IS WHY THIS BRANCH CANNOT BE A BARE `push`. A
      // reload hydrates the block with a `ts`; the very next durable frame
      // re-projects and re-merges the whole view, and building a fresh
      // `{kind,id,turnId,text}` would silently drop it.
      //
      // ⚠️ THAT REASONING WAS RIGHT AND THE CODE STILL LOST THE `ts` — measured,
      // and worth recording because the paragraph above reads as a guarantee.
      // The inheritance only ever held for the LAST-WINS member of a same-id
      // pair: `prev` was indexed by id alone, so a reasoning entry sharing an id
      // with a bubble later in the array looked up as `undefined` and this
      // branch built exactly the fresh `{kind,id,turnId,text}` it says it
      // avoids. Keying the index by kind is what made the paragraph true.
      // ⚠️ #242 half 3: A TOOL ENTRY IS CARRIED THE SAME WAY, and for the same
      // reasons the reasoning branch above spells out — it holds no overlay and
      // no `role`, and its one client-local field is the hydration `ts`, which
      // must be inherited or a reload's timestamp is dropped by the next
      // unrelated durable frame.
      //
      // ⚠️ THE LOOKUP KEY IS `(turnId, id)`, NOT `id`. `indexTranscriptByKind`
      // files tool entries under `toolEntryKey`, so reading them back by id alone
      // would miss every one of them — and a miss here is not a no-op, it is the
      // `ts` loss described above plus a needlessly fresh object defeating the
      // `.toBe` identity reuse.
      if (entry.kind === "tool") {
        const prevTool = prevByKind.tool.get(toolEntryKey(entry.turnId, entry.id));
        const nextTool: ChatToolMessage = {
          kind: "tool",
          id: entry.id,
          turnId: entry.turnId,
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
          ...(entry.status !== undefined ? { status: entry.status } : {}),
          ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
          ...(entry.argKeys !== undefined ? { argKeys: entry.argKeys } : {}),
        };
        // Assigned rather than written in the literal, exactly as the two
        // branches around it do: an own `ts: undefined` key would fail
        // `sameChatMessage`'s key-count check and defeat the identity reuse.
        if (prevTool?.ts !== undefined) nextTool.ts = prevTool.ts;
        out.push(
          prevTool !== undefined && sameChatMessage(prevTool, nextTool)
            ? prevTool
            : nextTool,
        );
        continue;
      }
      // ⚠️ #242 half 4: AN APPROVAL ENTRY CARRIES A CLIENT-LOCAL OVERLAY THAT
      // THE OTHER TWO TAGGED ARMS DO NOT, AND LOSING IT IS THE SAFETY BUG. Three
      // fields are inherited from `prev` rather than rebuilt: `actionable` (may
      // this device offer buttons — absent means NO, and rebuilding without it
      // would silently disarm a live card on the next unrelated frame),
      // `resolutionConfirmed` and `resolvedElsewhere` (the #15 pair that tells a
      // server answer from `decide()`'s optimistic one), plus the hydration `ts`
      // the other arms also inherit.
      //
      // ⚠️ THE INHERITANCE RUNS ONE WAY ONLY. `resolvedDecision` comes from the
      // VIEW, never from `prev`: it is durable state, the reducer owns it, and
      // `applyApproval`'s upsert-preserve is what keeps a re-delivered request
      // from clearing it. Taking it from `prev` here would be a second copy of
      // that rule, in a different module, free to drift.
      if (entry.kind === "approval") {
        const prevApproval = prevByKind.approval.get(entry.id);
        const nextApproval: ChatApprovalMessage = {
          kind: "approval",
          id: entry.id,
          approvalKind: entry.approvalKind,
          title: entry.title,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          prompt: entry.prompt,
          options: entry.options,
          ...(entry.expiresAtMs !== undefined ? { expiresAtMs: entry.expiresAtMs } : {}),
          ...(entry.resolvedDecision !== undefined
            ? { resolvedDecision: entry.resolvedDecision }
            : {}),
        };
        // Assigned rather than written in the literal, exactly as the two
        // branches below do: an own `…: undefined` key would fail
        // `sameChatMessage`'s key-count check and defeat the identity reuse.
        if (prevApproval?.actionable !== undefined) {
          nextApproval.actionable = prevApproval.actionable;
        }
        if (prevApproval?.resolutionConfirmed !== undefined) {
          nextApproval.resolutionConfirmed = prevApproval.resolutionConfirmed;
        }
        if (prevApproval?.resolvedElsewhere !== undefined) {
          nextApproval.resolvedElsewhere = prevApproval.resolvedElsewhere;
        }
        if (prevApproval?.ts !== undefined) nextApproval.ts = prevApproval.ts;
        out.push(
          prevApproval !== undefined && sameChatMessage(prevApproval, nextApproval)
            ? prevApproval
            : nextApproval,
        );
        continue;
      }
      if (entry.kind === "reasoning") {
        const prevEntry = prevByKind.reasoning.get(entry.id);
        const nextReasoning: ChatReasoningMessage = {
          kind: "reasoning",
          id: entry.id,
          turnId: entry.turnId,
          text: entry.text,
        };
        // Assigned rather than written in the literal for the same reason the
        // bubble branch assigns `turnId`: an own `ts: undefined` key would fail
        // `sameChatMessage`'s key-count check and defeat the identity reuse.
        if (prevEntry?.ts !== undefined) nextReasoning.ts = prevEntry.ts;
        out.push(
          prevEntry !== undefined && sameChatMessage(prevEntry, nextReasoning)
            ? prevEntry
            : nextReasoning,
        );
        continue;
      }
      const base = prevByKind.bubble.get(entry.id);
      const overlay = local !== undefined && Object.hasOwn(local, entry.id)
        ? local[entry.id]
        : undefined;
      const overlaySetsText = overlay !== undefined && "text" in overlay;
      const overlaySetsDraftOnly = overlay !== undefined && "draftOnly" in overlay;
      const draftOnly = overlaySetsDraftOnly ? overlay.draftOnly : base?.draftOnly;
      const turnId = entry.turnId ?? base?.turnId;
      const next: ChatBubble = {
        ...base,
        id: entry.id,
        role: entry.role,
        // Rule 2's carve-out: while the bubble holds only a draft, `text` is the
        // client's, not the view's.
        text: draftOnly === true && !overlaySetsText && base !== undefined
          ? base.text
          : entry.text,
      };
      // Assigned rather than written in the literal so an ABSENT turnId does not
      // become an own `turnId: undefined` key. A history-hydrated bubble is
      // created without one (`case "history"`'s fresh-insert for a TEXT row that
      // matched no tier — the `inserts` push in the `m.role` branch, not the
      // reasoning one above it — emits exactly `{id, role, text, ts, working}`),
      // and adding the key fails
      // `sameChatMessage`'s key-count check on the very first durable event —
      // silently re-creating a bubble the `.toBe` guarantee says must be reused.
      if (turnId !== undefined) next.turnId = turnId;
      if (overlay !== undefined) {
        for (const [key, value] of Object.entries(overlay)) {
          if (value === undefined) delete (next as Record<string, unknown>)[key];
          else (next as Record<string, unknown>)[key] = value;
        }
      }
      if (this.isSpentDraft(next)) continue;
      out.push(base !== undefined && sameChatMessage(base, next) ? base : next);
    }
    return out;
  }

  /**
   * Compute the next `state.messages` for ONE durable event, without committing
   * it. Receipt-bound user publication uses the specialized sibling below;
   * inbound durable frames use this form through `applyDurable`.
   */
  private nextDurableMessages(
    event: DurableEvent,
    local?: DurableLocalOverlay,
  ): ChatMessage[] {
    const before = this.durableProjection();
    const after = applyDurableEvent(before, event);
    return this.mergeDurable(this.state.messages, after, local);
  }

  /**
   * Materialize one successfully published user echo through the shared reducer.
   * A held/deferred bubble is only local staging until its wire id is reserved:
   * remove that one row from the reducer input so `user` appends its FINAL
   * durable identity/content/turnId at the tail, then merge against the full
   * client view so the staging row's receipt/UI fields survive. `local` applies
   * the path-specific publication changes (`pending:false` for held release,
   * absent for deferred publication). A caller whose staging row disappeared
   * deliberately skips this helper, so publication never resurrects a bubble.
   */
  private nextPublishedUserMessages(
    bubbleId: string,
    text: string,
    wireId: string,
    local: Partial<ChatBubble>,
    stagedBubble?: ChatMessage,
  ): ChatMessage[] {
    let reducerInput = this.state.messages;
    if (stagedBubble !== undefined) {
      const stagedIndex = reducerInput.indexOf(stagedBubble);
      if (stagedIndex !== -1) {
        reducerInput = [
          ...reducerInput.slice(0, stagedIndex),
          ...reducerInput.slice(stagedIndex + 1),
        ];
      }
    }
    const before = projectDurableFromClient(reducerInput);
    const after = applyDurableEvent(before, {
      kind: "user",
      id: bubbleId,
      text,
      turnId: wireId,
    });
    return this.mergeDurable(this.state.messages, after, { [bubbleId]: local });
  }

  /** Apply ONE durable event to `state.messages`, optionally folding in a
   *  sibling state patch the same frame owes (e.g. `turn_snapshot`'s
   *  `isTyping: false`) so it lands in a single notification. */
  private applyDurable(
    event: DurableEvent,
    local?: DurableLocalOverlay,
    // ⚠️ `StatePatch`, NOT `Partial<InitializedWebChannelState>` — this was the
    // ONE door left unnarrowed in #242 half 2, and a spread hole is still a
    // hole: `setState({ messages, ...extra })` does not error on a `reasoning`
    // key arriving through the spread, so `StatePatch`'s claim that assigning
    // `reasoning` is "a compile error, not a convention" was true of every
    // caller except this one. Closed rather than weakened, because a guarantee
    // with a documented exception is the shape nobody checks.
    extra?: StatePatch,
  ): void {
    this.setState({ messages: this.nextDurableMessages(event, local), ...extra });
  }

  // ⚠️ `upsertToolActivity` IS GONE (#242 half 3). It maintained
  // `state.toolActivity` as an independent, `.slice(-100)`-capped side array —
  // a second opinion about which tool calls a conversation contains and where
  // they sit. Tool activity is a DURABLE MESSAGE now: `case "tool_activity"`
  // routes each frame through `applyDurable`, `durable-view-reducer.ts`'s
  // `applyTool` performs the ONE merge, and `state.toolActivity` is derived from
  // `state.messages` by `deriveToolActivity`. The cap went with it — see
  // `WebChannelState.toolActivity` for the honest version of what that does and
  // does not close.

  // ⚠️ `patchApproval` IS GONE (#242 half 4). It mapped over `state.approvals`
  // as an independently maintained side array — a second opinion about which
  // approvals a conversation contains and, since that array had no transcript
  // position at all, about where they sit. An approval is a DURABLE MESSAGE now:
  // `case "approval_request"`/`case "approval_resolved"` route through
  // `applyDurable`, `durable-view-reducer.ts` performs the ONE fold, and
  // `state.approvals` is derived from `state.messages` by `deriveApprovals`.
  // `StatePatch` excludes `approvals` so a `setState({approvals})` regression is
  // a compile error rather than a divergence.

  private uid(): string {
    return `${this.seq++}`;
  }

  /** Mint a viewer-local bubble id without colliding with hydrated transcript ids. */
  private mintLocalBubbleId(prefix: "u" | "a"): string {
    let id: string;
    do {
      id = `${prefix}-${this.uid()}`;
    } while (this.state.messages.some((message) => message.id === id));
    return id;
  }

  private seq = 0;

  /** One-shot latch: the id-less durable `agent_message` warning is per client
   *  instance, not per frame — a legacy plugin emits one per reply. */
  private warnedIdlessDurableFrame = false;

  // ---- #244 half B / #356 — the per-conversation seq cursor -----------------
  //
  // ONE conversation per client here (`peerId` is fixed at construction and the
  // `.out` stream is single-conversation), so a single cursor suffices — no
  // per-conversation map. It starts UNSEEDED: this client holds no `pts` until the
  // register-time `history` snapshot's `highWaterSeq` arrives, and Telegram's app
  // asks for nothing before then. See `SeqCursor` for the states and the rules.
  private cursor: SeqCursor = { state: "unseeded" };

  // ---------------------------------------------------------------------------
  // P0-4 — receipt records + send-state projection (D5)
  // ---------------------------------------------------------------------------

  /** Dedicated counter so receiptKeys never perturb the `u-`/`a-` bubble id sequence. */
  private receiptSeq = 0;
  private newReceiptKey(): string {
    return `r-${this.receiptSeq++}`;
  }

  /**
   * #243 half 2b: mint the `user_message` idempotency `random_id` for one send
   * and remember `random_id → receiptKey` so a later `ack` echo can adopt the
   * server id onto this exact bubble (`adoptCommittedIds`). Minting it HERE — not
   * in the low-level `sendUserMessage` default — is what gives the wrapper the
   * `random_id ↔ bubble` correlation. Called once per logical send; the token is
   * stamped on the outbound frame the low-level ledgers, so every reconnect
   * REPLAY re-publishes the same `random_id` (half 1's idempotency) without the
   * wrapper re-minting.
   */
  private mintRandomId(receiptKey: string): string {
    const randomId = randomInboxToken();
    this.randomIdToReceiptKey.set(randomId, receiptKey);
    return randomId;
  }

  /** A thin observable view over the receiptKey-keyed record (no state duplication). */
  private makeReceipt(receiptKey: string): SendReceipt {
    return {
      id: receiptKey,
      snapshot: () => this.receiptSnapshot(receiptKey),
      subscribe: (cb) => {
        const rec = this.receipts.get(receiptKey);
        if (!rec) return () => {};
        rec.subscribers.add(cb);
        return () => { rec.subscribers.delete(cb); };
      },
    };
  }

  /**
   * Read the wrapper projection unless the low tracker has already reached a
   * later state whose callback is merely waiting in the global FIFO drain. This
   * is a read-only overlay: bubbles and receipt subscribers still transition
   * through `receiptTransition` in serialized event order.
   *
   * While this receipt's own transition is fanning out, its record remains the
   * snapshot authority so every subscriber sees the event it was passed. The
   * wrapper-only terminal outcomes (`completed` and `failed`, including
   * `turn-failed`) likewise outrank the low tracker's accepted/sent projection.
   * A held receipt has no wire id and therefore remains queued.
   */
  private receiptSnapshot(receiptKey: string): ReturnType<SendReceipt["snapshot"]> {
    const rec = this.receipts.get(receiptKey);
    // A record always exists for a receipt we handed out; the fallback keeps the
    // type total. Records are intentionally retained across adoption/retraction.
    if (!rec) return { state: "failed" };

    const wrapperState = rec.state;
    const wrapperSnapshot = { state: wrapperState, failure: rec.failure };
    if (
      rec.drainingTransitions ||
      wrapperState === "failed" ||
      wrapperState === "completed" ||
      !rec.wireId
    ) {
      return wrapperSnapshot;
    }

    const tracked = this.client.getSendStateSnapshot(rec.wireId);
    if (!tracked) return wrapperSnapshot;
    if (
      tracked.state === "failed" ||
      WebChannelNATSClient.RECEIPT_RANK[tracked.state] > WebChannelNATSClient.RECEIPT_RANK[wrapperState]
    ) {
      return tracked;
    }
    return wrapperSnapshot;
  }

  /** Monotonic receipt guard (wrapper-level, incl. `completed`): queued<sent<accepted<completed; failed/completed terminal. */
  private receiptAdvances(from: ReceiptRecord["state"], to: NonNullable<ChatMessage["sendState"]>): boolean {
    if (from === to) return false;
    if (from === "failed" || from === "completed") return false; // terminal
    if (to === "failed") return true; // failable from any non-terminal state
    return WebChannelNATSClient.RECEIPT_RANK[to] > WebChannelNATSClient.RECEIPT_RANK[from];
  }

  /**
   * P0-4: apply a send-state transition to a receipt record (authoritative) and
   * mirror it onto the render bubble, enforcing the wrapper-level monotonic guard
   * (which alone knows `completed`). A bubble/state or receipt subscriber can
   * synchronously cause another transition for this same receipt, so the whole
   * guard→mutation→bubble fanout→receipt fanout transaction is drained FIFO per
   * receipt. The current event remains the authoritative snapshot until every
   * subscriber has seen it; a rejected transition touches nothing.
   */
  private receiptTransition(
    receiptKey: string,
    state: NonNullable<ChatMessage["sendState"]>,
    failure?: SendFailure,
    extraBubblePatch?: Partial<ChatBubble>,
  ): void {
    const rec = this.receipts.get(receiptKey);
    if (!rec) return;
    rec.pendingTransitions.push({ state, failure, extraBubblePatch });
    if (rec.drainingTransitions) return;

    rec.drainingTransitions = true;
    try {
      while (rec.pendingTransitions.length > 0) {
        const next = rec.pendingTransitions.shift()!;
        if (!this.receiptAdvances(rec.state, next.state)) continue;
        rec.state = next.state;
        rec.failure = next.failure;
        // Terminal outcomes consume an unpublished candidate too: a delayed
        // lower-level callback must never revive a failed/completed receipt.
        if (next.state === "failed" || next.state === "completed") {
          rec.turnOpeningConsumed = true;
        }
        // #96: publication authority lives in the low-level tracker. Fold the
        // first `sent`/`accepted` opening into this same bubble/state fanout;
        // queued ownership alone never claims that the agent has a live turn.
        const turnOpened = this.openTurnFromReceipt(rec, next.state);
        // #96: close the turn of a send whose failure is our best evidence that
        // no turn will ever settle for it (see the `overloaded` note below — it
        // is a proxy, not a proof).
        // This is the one funnel every terminal receipt outcome passes through
        // (the low-level tracker's `onSendState`, plus the wrapper's own), which
        // is why the hook lives here and not on any single emit site.
        //
        // THE RULE — do not extend this by listing more reasons. An id may be
        // removed here ONLY if no `turn_settled` can ever name it. Anything a
        // settle might still name must be left to `closeTurnsThrough`, because
        // removing it early makes that sweep's `openTurns.has(turnId)` guard fail
        // and strands EVERY earlier coalesced wireId permanently. Turns left here
        // are not leaked: they sit earlier in publish order than any later turn,
        // so the next settle sweeps them as part of its prefix — bounded, the
        // same way the control-lane residual is bounded.
        //
        // `overloaded` is the only reason we treat as clearing that bar — as the
        // best available PROXY for non-delivery, not as proof of it. The common
        // case is an ingress rejection before any turn was dispatched, and closing
        // immediately is worth having. But the agent can also reject a message it
        // already admitted: the client live-retries an unacked id on the SAME
        // healthy connection, ack delivery back to us is itself best-effort, and
        // an accepted-marker loss (a memory-only record evicted from the bounded
        // dedupe caches, or the dual-marker branch) makes that retry look fresh
        // and rejectable while its turn is already running. Then a `turn_settled`
        // DOES name this id, arriving after we removed it, and the prefix bails.
        // Accepted knowingly: that residual sits inside the bound documented on
        // `turnActive` — dropping `overloaded` from the hook would instead latch
        // every genuinely-rejected send until the same next-turn sweep, the
        // identical bound, while giving up the immediate close in the common case.
        // Two reasons that look eligible are NOT:
        //  - `turn-failed` comes FROM a settle (`outcome:"error"`), whose reducer
        //    promotes the anchor from the top — before the sweep at the bottom —
        //    so closing here would consume the settle's own id;
        //  - `evicted` is a CLIENT-side unacked-ledger cap drop. Ack loss is not
        //    delivery failure: the message may have reached the agent, been
        //    coalesced, and be the very id its turn settles under.
        // (`cancelled` and `closed` need no exclusion — a `cancelled` receipt is
        // still held and has no wireId, while a `closed` receipt becomes terminal
        // before any authoritative publish transition can open it. Neither can
        // reach an open turn, so neither is a turn-closing mechanism.)
        const turnClosed =
          next.state === "failed"
          && next.failure?.reason === "overloaded"
          && this.closeTurn(rec.wireId);
        this.patchBubbleByReceiptKey(
          receiptKey,
          {
            sendState: next.state,
            sendFailure: next.failure,
            ...(next.extraBubblePatch ?? {}),
          },
          turnOpened
            ? { turnActive: true }
            : turnClosed
              ? { turnActive: false }
              : undefined,
        );
        for (const cb of [...rec.subscribers]) {
          try {
            cb({ state: next.state, failure: next.failure });
          } catch (e) {
            console.error("[nats-wrapper] receipt subscriber threw:", e);
          }
        }
      }
    } finally {
      rec.drainingTransitions = false;
    }
  }

  /**
   * Patch the render bubble carrying `receiptKey` (a no-op if it was retracted).
   * `extraState` rides along in the SAME fanout — #96 uses it so a turn closed by
   * a terminal failure flips `turnActive` atomically with the bubble's
   * `sendState`, and still lands when the bubble itself is gone.
   */
  private patchBubbleByReceiptKey(
    receiptKey: string,
    patch: Partial<ChatBubble>,
    extraState?: StatePatch,
  ): void {
    // ⚠️ `m.kind === undefined` IS PART OF THE PREDICATE, not decoration.
    // `receiptKey` is a bubble-only field — a reasoning block is never SENT by
    // this client, so it has no receipt — which makes a match a bubble by
    // construction. The conjunct is here anyway because "cannot happen" is not a
    // reason to spread a bubble patch over an entry of another kind. The cast
    // below records what this predicate already decided; TS cannot carry a
    // `findIndex` callback's narrowing to the element (the same limitation the
    // reducer's `applyPlacement` documents).
    const idx = this.state.messages.findIndex(
      (m) => m.kind === undefined && m.receiptKey === receiptKey,
    );
    if (idx === -1) {
      if (extraState) this.setState(extraState);
      return;
    }
    const messages = this.state.messages.slice();
    messages[idx] = { ...(messages[idx] as ChatBubble), ...patch };
    this.setState({ messages, ...(extraState ?? {}) });
  }

  /**
   * #243 half 2b: adopt the server-assigned durable ids echoed on an `ack`.
   *
   * `committed` is `{random_id, messageId}[]` (#243 half 2a): the plugin minted
   * ONE durable `messageId` per inbound user message and echoes it against the
   * client's idempotency `random_id`. For each entry we resolve `random_id →
   * receiptKey` (the linkage `mintRandomId` recorded), find the optimistic
   * `u-<n>` bubble carrying that receiptKey, and RE-KEY its durable id to the
   * server `messageId`. After this the client's `user` id equals the id the
   * delivery journal holds, so a later `history`/full-replay of the same
   * conversation TIER-1 matches by id (`case "history"`) instead of adopting by
   * text/position (tier 2/3) — live == history under one shared id, which is
   * what #302 is blocked on.
   *
   * ⚠️ RE-KEYING A DURABLE ID ON THE CLIENT is the same in-place `id` rewrite
   * `case "history"`'s `adoptAt` already performs on a user bubble; it is safe
   * for exactly the reason `ChatBubble.receiptKey`'s docblock (`types.ts`) states
   * — "history adoption rewrites `id` in place but keeps this key, so the receipt
   * survives id churn." The receipt record and its `wireId` alias are keyed by
   * `receiptKey`/`wireId`, NOT by the bubble id, and the spread preserves
   * `receiptKey` (this method even MATCHES on it) — so `patchBubbleByReceiptKey`,
   * `promoteAnchor`, and the send-state path all keep working; and the durable
   * projection re-derives the bubble under its new id every frame, so the overlay
   * carries across `mergeDurable` by `(kind,id)` (which is the loss `mergeDurable`'s
   * own header warns about — averted here because the re-key lands in
   * `state.messages` before the next projection reads it). We change ONLY `id`;
   * `text`/`ts`/`sendState`/`pending` are the
   * bubble's own and stay — the same fields `adoptAt` keeps (it discards only
   * `assistantMessageIndex`, which a user bubble never carries).
   *
   * A `random_id` with no linkage (never sent from this client), or one whose
   * bubble was retracted, is a silent no-op — and a send whose ack carries NO
   * `committed` at all simply never reaches here, leaving its bubble at `u-<n>`
   * for the tier-2/3 text fallback (deliberately kept; removing it is half 3).
   */
  private adoptCommittedIds(
    // #244 half A adds an optional `seq` to each entry (the user message's wire
    // seq). Adoption ignores it — this method re-keys by `messageId` only.
    committed: Array<{ random_id: string; messageId: string; seq?: number }> | undefined,
  ): void {
    if (!Array.isArray(committed) || committed.length === 0) return;
    // receiptKey → server messageId, for the entries we can resolve this frame.
    const adopt = new Map<string, string>();
    for (const entry of committed) {
      // #246 half A: the three hand-rolled checks that were here are now the
      // shared `isCommittedEcho` predicate — the SAME rule the door decoder and
      // the cursor advance apply, so no entry can be good enough for one of the
      // three and not the others.
      if (!isCommittedEcho(entry)) continue;
      const { random_id: randomId, messageId } = entry;
      const receiptKey = this.randomIdToReceiptKey.get(randomId);
      // Consume the linkage: the echo is terminal for this `random_id` (its
      // ledger entry drained on this same `ack`, so no replay reuses it).
      this.randomIdToReceiptKey.delete(randomId);
      if (receiptKey === undefined) continue;
      adopt.set(receiptKey, messageId);
    }
    if (adopt.size === 0) return;

    let changed = false;
    const messages = this.state.messages.map((m): ChatMessage => {
      // Only a sent USER echo adopts. `role === "user"` narrows to `ChatBubble`
      // (the other union members have no `role`), and `receiptKey` links it to
      // its send.
      if (m.role !== "user" || m.receiptKey === undefined) return m;
      const serverId = adopt.get(m.receiptKey);
      if (serverId === undefined || serverId === m.id) return m;
      changed = true;
      return { ...m, id: serverId };
    });
    if (changed) this.setState({ messages });
  }

  /**
   * P0-4: promote the exact user bubble named by `turnId` (wireId === turnId) to
   * `completed` (outcome ok) or fail it `turn-failed` (outcome error). The method
   * keeps its historical anchor name, but the current plugin sends one frame per
   * coalesced member, so repeated exact-id promotion resolves the whole group.
   * An older anchor-only producer, or a missing member frame, leaves an unnamed
   * non-anchor receipt at `accepted`; the turn-activity prefix sweep does not
   * fabricate a receipt outcome.
   */
  private promoteAnchor(turnId: string, state: "completed" | "failed", failure?: SendFailure): void {
    const anchor = this.state.messages.find((m) => m.role === "user" && m.wireId === turnId);
    if (anchor?.receiptKey) this.receiptTransition(anchor.receiptKey, state, failure);
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(msg: InboundMessage): void {
    // #244 half B: the catch-up response is orchestration (fold N events, then
    // either re-request or settle and drain), not a single state transition, so
    // it is handled ahead of the ordinary dispatch and outside the seq-bearing
    // path below.
    if (msg.type === "difference") {
      this.applyDifference(msg);
      return;
    }

    // #244 half B: DURABLE (seq-bearing) frames are what the cursor is about.
    // Every other frame passes straight through — a `difference` is the only
    // inbound frame that itself moves the cursor without being folded live.
    if (isSeqBearingInbound(msg)) {
      // #246 half A: `isWireSeq`, the same predicate every other cursor site
      // uses. The door refuses a non-wire `seq` before this runs; this keeps the
      // cursor site independent of the decoder being complete (an `Infinity`
      // here would be a gap that no difference can ever close). A seq-bearing
      // TYPE without a seq (an id-less `agent_message`, a live reasoning DRAFT)
      // is still handled — it just carries no cursor.
      this.observeSeq(isWireSeq(msg.seq) ? msg.seq : undefined, msg);
      return;
    }

    // ⚠️ READ BEFORE `applyFrame`, WHICH CONSUMES THE EVIDENCE. `adoptCommittedIds`
    // DELETES each `random_id` linkage it resolves, and that linkage is the only
    // thing that distinguishes this device's own receipt from another device's —
    // see `originCommittedSeqs`. Asking afterwards would always answer "not mine".
    const ownCommittedSeqs = msg.type === "ack" ? this.originCommittedSeqs(msg) : undefined;

    this.applyFrame(msg);

    // Two NON-seq-bearing frames still carry a seq the cursor tracks. Both go
    // through the SAME three-way check as a durable frame (#345, #352): a value
    // above the contiguous next seq is a GAP, never a bare advance.
    if (msg.type === "history") {
      // The register-time snapshot's authoritative high-water — Telegram's
      // `updates.getState`, and the normal way an unseeded cursor gets its
      // baseline. `case "history"` has already hydrated. A `load_history` PAGE
      // omits `highWaterSeq`, so this only fires for the register-time snapshot.
      //
      // #246 half A: `isWireSeq`, not `typeof === "number"`. The cursor is a
      // monotone high-water, so a `NaN`/fractional/over-large value accepted here
      // would park it beyond every real seq and gate out the whole stream after
      // it. The frame's own decoder already refuses such a value at the door;
      // this is the second guard, at the site that would suffer.
      if (isWireSeq(msg.highWaterSeq)) this.observeSeq(msg.highWaterSeq, undefined);
    } else if (ownCommittedSeqs !== undefined) {
      // The inbound USER opener consumes a seq but rides no durable frame — half A
      // echoes that seq on the ack. Only THIS DEVICE'S echoes reach here.
      for (const seq of ownCommittedSeqs) this.observeSeq(seq, undefined);
    }
  }

  /**
   * #345 — the `ack.committed` seqs that are THIS DEVICE'S OWN RECEIPT: an entry
   * whose `random_id` still resolves a local send linkage.
   *
   * ⚠️ THE FILTER IS THE FIX, AND IT IS THE TELEGRAM SPLIT WE OTHERWISE LACK. An
   * ack rides the per-peer `.out`, which #245 Part B uses as the multi-device
   * fan-out, so every device of the peer receives the origin's ack. On the ORIGIN
   * the echoed seq names a row this device is already holding (the optimistic
   * bubble, re-keyed onto `webchannel-user-<seq>` by `adoptCommittedIds` in the
   * same frame), so the cursor may move over it. On any OTHER device it names a
   * row that was never folded: advancing there closes the very gap that would
   * have fetched it, and the turn renders an answer with no question (#345 shape
   * A). Telegram gets this split for free — a sent-message update goes to the
   * session that sent it — and the linkage is our only substitute for a session.
   *
   * A non-origin device therefore IGNORES the seq entirely rather than gap-testing
   * it: the row it names may legitimately be one this device has not seen, and the
   * turn's first agent frame at `seq + 1` opens the gap that heals it one moment
   * later. So the cost of ignoring is at most one round-trip, and only when the
   * `user_committed` broadcast for that row was also dropped.
   *
   * ⚠️ MUST BE CALLED BEFORE `applyFrame`. `adoptCommittedIds` consumes each
   * linkage it resolves, so afterwards every entry looks foreign.
   */
  private originCommittedSeqs(msg: InboundMessage): number[] {
    const seqs: number[] = [];
    for (const entry of msg.committed ?? []) {
      // #246 half A: the WHOLE entry must be well-formed, not just its `seq` —
      // the same `isCommittedEcho` predicate `adoptCommittedIds` and the door
      // decoder apply. A `seq` is evidence that a row was committed only if the
      // entry naming that row is intact.
      if (!isCommittedEcho(entry) || entry.seq === undefined) continue;
      if (!this.randomIdToReceiptKey.has(entry.random_id)) continue;
      seqs.push(entry.seq);
    }
    return seqs;
  }

  /**
   * #356 — THE ONE CURSOR FUNCTION. Every seq this client learns about goes
   * through here, and it is the only place the cursor moves or a gap is opened.
   *
   * `frame` is the seq-bearing frame that CARRIED the seq, or `undefined` for a
   * carrier that is not itself durable content (an `ack` echo, a `history`
   * high-water): those have already had their live effect, so there is nothing to
   * hold or to fold — only their seq passes through.
   *
   * The three-way test is Telegram's, with `pts_count` fixed at 1:
   *
   *  - `seq > last + 1` — GAP. Hold the frame and ask for everything after the
   *    cursor. This is the only path into `catching-up`.
   *  - `seq === last + 1` — apply, and advance IFF the fold accepted it (#246
   *    half A: a REFUSED frame must not move the cursor, or the event is lost AND
   *    the gap that would re-fetch it is closed by the same statement).
   *  - `seq <= last` — already covered by the cursor, so it can never be a gap and
   *    never moves the cursor backward.
   *
   * ⚠️ `seq <= last` IS STILL FOLDED, WHICH IS THE ONE PLACE WE DO NOT DO WHAT
   * TELEGRAM SAYS ("the update was already applied, and must be ignored"), AND
   * THE REASON IS THAT OUR SEQ IS NOT A `pts`. A `pts` counts EVENTS; our `seq`
   * numbers durable ROWS, and several live frames legitimately map onto ONE row:
   * `delivery-journal.ts` dedupes `placement` on its answer id, so every
   * `progress` frame of a streaming answer — the whole draft, chunk by chunk —
   * carries the SAME seq as the first one. Ignoring them would freeze every
   * streaming draft at its first chunk. So the cursor treats a repeated seq as
   * "nothing new to learn", while the frame itself folds exactly as it did
   * before this slice. (The BUFFER is the other story: a frame the catch-up has
   * just authoritatively answered for is dropped rather than re-folded — see
   * `redispatchBuffered`, where dropping is about the reply, not about the seq.)
   */
  private observeSeq(seq: number | undefined, frame: InboundMessage | undefined): void {
    const cursor = this.cursor;

    // CATCHING-UP: a reply is owed, so no durable frame may be applied or advanced
    // until it lands. EVERY seq-bearing-type frame is held, in arrival order —
    // with a seq or without one — and a bare carrier (an `ack` echo, a snapshot
    // high-water) is DROPPED, because its frame's live effects already ran and
    // applying its seq on top of a PARTIAL reply is exactly how a range got
    // skipped (#352).
    //
    // ⚠️ A SEQ-LESS FRAME IS HELD TOO, AND THAT IS ABOUT ORDER, NOT ABOUT
    // DOUBLE-APPLYING. It has no journal row, so no reply can re-deliver it —
    // but the reply's events are the rows BELOW it, and applying it first puts it
    // above them for the session. Concretely: `reasoningDurable` is OFF by
    // default, so EVERY reasoning frame is seq-less; applied during a catch-up
    // for `user@11`/`bubble@12`, the reasoning lane renders ABOVE the user
    // question that opened the turn (`applyReasoning` upserts by id and keeps its
    // position), and a reload re-projects it from seq order — live ≠ history on
    // the ordinary gap path.
    //
    // What it must NOT cost is the draft being overwritten by its own stale
    // prefix on the way back in; `uncarried` owns that, by dropping a held frame
    // whose id the reply AUTHORED durable text for.
    if (cursor.state === "catching-up") {
      if (frame !== undefined) cursor.buffer.push(frame);
      return;
    }

    // UNSEEDED: adopt this observation as the baseline. `seq - 1` rather than
    // `seq`, so the frame that carried it goes through the ordinary apply path
    // below — including the #246 gate, which leaves the cursor one short if the
    // fold refuses it, so the NEXT frame reads as the gap that re-serves it. A
    // frame of a seq-bearing TYPE that carries NO seq establishes nothing and is
    // simply folded (it is a live draft with no durable row behind it).
    let synced: SyncedCursor;
    if (cursor.state === "unseeded") {
      if (seq === undefined) {
        if (frame !== undefined) this.applyFrame(frame);
        return;
      }
      synced = { state: "synced", last: Math.max(0, seq - 1) };
      this.cursor = synced;
    } else {
      synced = cursor;
    }

    // SYNCED — Telegram's three-way test, against the baseline above.

    if (seq !== undefined && seq > synced.last + 1) {
      // GAP: the seqs between are gone — NATS is at-most-once, so a hole in the
      // contiguous stream is a real drop. Ask for everything after the cursor and
      // hold this frame until the answer lands.
      this.openCatchUp(synced.last, frame === undefined ? [] : [frame]);
      return;
    }

    if (frame === undefined) {
      // A bare carrier at or below `last + 1`: nothing to fold, so the seq is the
      // whole content. Never backward.
      if (seq !== undefined && seq > synced.last) synced.last = seq;
      return;
    }

    const folded = this.applyFrame(frame);
    // Re-read: `applyFrame` runs reducers and public listeners, so the cursor it
    // returns to may not be the object read above. Advancing only in `synced` is
    // the same rule stated once more, at the one site that could violate it.
    const after = this.cursor;
    if (folded && seq !== undefined && after.state === "synced" && seq > after.last) {
      after.last = seq;
    }
  }

  /**
   * Enter `catching-up`: mint a fresh nonce, send `get_difference(afterSeq, nonce)`,
   * arm the liveness timer, and take ownership of the frames to hold meanwhile.
   *
   * `buffer` is passed in rather than started empty because the two callers hand
   * over different things: a fresh gap contributes the frame that revealed it,
   * while a PARTIAL reply hands back the frames it did not itself deliver
   * (Telegram: "the query must be repeated, using the intermediate status as the
   * current status").
   *
   * ⚠️ THIS MINTS A FRESH CURSOR, SO IT RESETS `retries` TO 0 — and that is only
   * correct because both callers have PROGRESS behind them: a gap newly detected
   * from a moved cursor, or a slice that covered past the floor it answered. A
   * reply that moved NOTHING must never come through here — `stalled` diverts it,
   * keeping the budget and the deadline, because otherwise a peer that answers
   * nothing gets an unbounded fresh budget every round-trip.
   */
  private openCatchUp(afterSeq: number, buffer: InboundMessage[]): void {
    const cursor: CatchingUpCursor = {
      state: "catching-up",
      afterSeq,
      nonce: randomInboxToken(),
      buffer,
      retries: 0,
      timer: null,
    };
    this.cursor = cursor;
    this.client.getDifference(afterSeq, cursor.nonce);
    this.armCatchUpTimer(cursor);
  }

  /**
   * Land in `synced` at `last` and re-dispatch what was held.
   *
   * The two ways a catch-up ENDS — a complete reply, and a give-up after the
   * retry budget — and nothing else: the `unseeded` seed installs its cursor
   * inline (it holds no buffer to re-dispatch), a partial reply hands straight
   * to `openCatchUp`, and `resetCursorForConnection` drops the buffer rather
   * than folding it.
   *
   * `carried` is the reply's own — `undefined` on the give-up and stall paths,
   * where no reply delivered anything and therefore nothing may be dropped. See
   * `uncarried`.
   */
  private settleSynced(
    last: number,
    buffered: InboundMessage[],
    carried: CarriedRows | undefined,
  ): void {
    this.cursor = { state: "synced", last };
    this.redispatchBuffered(buffered, carried);
  }

  /**
   * Re-dispatch held frames in ARRIVAL ORDER, minus the ones the reply
   * superseded. `uncarried` owns which those are and argues every case; this
   * method owns only the order, and the order is the point — a held frame folds
   * after the reply's events, which is where a reload's seq-ordered projection
   * puts it.
   */
  private redispatchBuffered(
    buffered: InboundMessage[],
    carried: CarriedRows | undefined,
  ): void {
    for (const m of this.uncarried(buffered, carried)) this.handleMessage(m);
  }

  /**
   * The held frames a reply did NOT supersede — the ones still owed to the view.
   *
   * Split out because BOTH exits from a reply need it and they need it at
   * different moments: a complete reply re-dispatches these (`settleSynced`),
   * while a PARTIAL one carries them into the next request. Filtering only on the
   * re-dispatch would let a frame the first slice delivered survive across the
   * boundary and fold after the second one.
   *
   * `undefined` means the caller has nothing to measure against: the give-up path,
   * where the budget ran out without any reply that delivered anything. (A reply
   * that lands and delivers nothing is a STALL — it does not reach here at all,
   * because it does not end the round-trip.)
   *
   * ── ONE DICHOTOMY, ON WHETHER THE HELD FRAME CARRIES DURABLE TEXT OF ITS OWN ──
   *
   * **A DRAFT-SHAPED frame** — one with no seq (an unthrottled reasoning frame,
   * which is every reasoning frame while `reasoningDurable` is off), or a
   * `progress`, whose row is a text-less `placement` — is superseded only by the
   * reply AUTHORING its id. Nothing else can supersede a draft: the seq it shares
   * with its `placement` says the SLOT was delivered, not the text, and dropping
   * on that blanks the draft the user is watching, permanently for an answer that
   * never produces another frame.
   *
   * **Every other held frame** is superseded only by the reply FOLDING its seq.
   * Not by the id: an id-authored drop is unbounded above the range the reply
   * covered, and a tool card is the proof — tool rows are not deduped, so every
   * phase is its own row, and a slice carrying `tool{T, phase:"start"}@12` would
   * otherwise drop a held `tool_activity{T, phase:"end"}@20` that the next slice
   * then skips as undeliverable (#343). The card stays "running" for the session.
   * Not by the cursor either: after a reply the cursor also covers seqs the
   * server SKIPPED (#343) — inside `maxSeq`, carried by no event — and a frame
   * sitting in this buffer is PROOF that its own live send succeeded. A
   * `difference` envelope for the same content is larger than the live frame that
   * carried it, so a row inside that band is live-deliverable and
   * difference-undeliverable: #343's own razor edge, arriving from the other side.
   *
   * ⚠️ AND "FOLDED", NOT "CARRIED": an event this build could not decode advances
   * the cursor past itself (the documented asymmetry) and delivers nothing, so it
   * may not drop the held frame that is the only usable copy of that row.
   *
   * ⚠️ THIS IS NOT A SECOND CURSOR SITE, AND MUST NOT BECOME ONE (#246 half A).
   * `redispatchBuffered` re-enters through `handleMessage`, so a re-dispatched
   * frame moves the cursor through the ONE gated statement in `observeSeq` —
   * refused ⇒ no advance. A frame that still reveals a gap re-opens one cleanly,
   * re-buffering the remainder onto the fresh cursor's buffer.
   */
  private uncarried(
    buffered: InboundMessage[],
    carried: CarriedRows | undefined,
  ): InboundMessage[] {
    if (carried === undefined) return buffered;
    return buffered.filter((m) => {
      const seq = isWireSeq(m.seq) ? m.seq : undefined;
      if (seq === undefined || m.type === "progress") {
        const id = typeof m.id === "string" && m.id.length > 0 ? m.id : undefined;
        return id === undefined || !carried.authoredIds.has(id);
      }
      return !carried.seqs.has(seq);
    });
  }

  /** HIGH-2 — arm (or re-arm) the reply timeout for this catch-up. */
  private armCatchUpTimer(cursor: CatchingUpCursor): void {
    this.clearCatchUpTimer(cursor);
    cursor.timer = setTimeout(() => {
      // ⚠️ OBJECT IDENTITY REPLACES THE OLD GENERATION COUNTER. Every transition
      // installs a NEW cursor object, so "is the cursor still the one that armed
      // me" is exactly the question the counter used to answer — with no second
      // number to keep in step.
      if (this.cursor !== cursor) return;
      cursor.timer = null;
      this.onCatchUpTimeout(cursor);
    }, GET_DIFFERENCE_TIMEOUT_MS);
  }

  private clearCatchUpTimer(cursor: CatchingUpCursor): void {
    if (cursor.timer !== null) {
      clearTimeout(cursor.timer);
      cursor.timer = null;
    }
  }

  /**
   * #356 — did this reply FAIL TO MOVE THE FLOOR, i.e. answer nothing?
   *
   * A stall is treated exactly as a LOST reply: the round-trip stays open on its
   * original deadline, and `onCatchUpTimeout` re-issues on its own cadence and
   * gives up when the budget is spent. Settling instead re-dispatches the buffer,
   * the held frame re-opens the same gap on the spot, and `openCatchUp` hands out
   * a fresh retry budget — an unbounded request loop at round-trip speed
   * (measured: 51 requests for 50 non-advancing replies, no time passing).
   *
   * Two shapes, one condition. A `partial: true` reply whose coverage does not
   * exceed the floor it answered, and a reply whose fold threw before a single
   * event landed — in both the client learned nothing and the request is, in
   * effect, still outstanding.
   *
   * ⚠️ AND THE SPURIOUS-GAP UNWIND IS THE ONE EXEMPTION, WHICH TURNS ON THE
   * BUFFER — not on `partial`. `partial: false` with no events is the server
   * saying "there is nothing past your floor", and a detection that was spurious
   * must be able to close on it. But that is only true when the buffer is EMPTY.
   * With a frame still held, settling re-dispatches it, the frame re-opens the
   * same gap on the spot, and `openCatchUp` hands out a fresh retry budget —
   * round 2's storm, arriving through the `partial: false` door: measured at 51
   * requests for 50 empty complete replies, with no time passing. A held frame
   * means the gap was real, so an answer that covers nothing is a stall whatever
   * the flag says.
   */
  private stalled(
    msg: InboundMessage,
    covered: number,
    completed: boolean,
    cursor: CatchingUpCursor,
  ): boolean {
    if (covered > cursor.afterSeq) return false;
    return msg.partial === true || !completed || cursor.buffer.length > 0;
  }

  /**
   * HIGH-2 — the reply (or the request) was lost on the at-most-once `.out`, or
   * the server's read faulted and it sent nothing.
   *
   * Re-issue the SAME `afterSeq` with a FRESH nonce, a bounded number of times.
   * The nonce is re-minted rather than reused so the two replies of a
   * request/retry race are distinguishable: the first to arrive matches, and the
   * second matches nothing and is dropped whole, which is a cheaper guard against
   * a double fold than making every event kind idempotent.
   *
   * On giving up, settle at the current floor and re-dispatch what was held: the
   * frames are still foldable content and the give-up path must not throw away
   * ones it can still use (#343). A frame that is still beyond the cursor re-opens
   * the gap with a fresh retry budget, so a persistently unanswerable request
   * settles into one attempt per `GET_DIFFERENCE_TIMEOUT_MS` rather than stopping
   * — the same rate the old "freeze and wait for the next live frame" path
   * produced whenever traffic continued, and now also present when it does not.
   * A transport drop stops it (`resetCursorForConnection`).
   */
  private onCatchUpTimeout(cursor: CatchingUpCursor): void {
    if (cursor.retries < GET_DIFFERENCE_MAX_RETRIES) {
      cursor.retries += 1;
      cursor.nonce = randomInboxToken();
      this.client.getDifference(cursor.afterSeq, cursor.nonce);
      this.armCatchUpTimer(cursor);
      return;
    }
    // `undefined`: no reply landed, so nothing was carried and nothing may be
    // dropped — every held frame re-dispatches, repeated-seq `progress` frames
    // included (#343: the give-up path must not throw away what it can fold).
    this.settleSynced(cursor.afterSeq, cursor.buffer, undefined);
  }

  /**
   * #244 half B — connection-scoped reset: the outstanding request and the frames
   * held for it belong to the connection that just dropped. Called on raw
   * transport loss and on `close()`, alongside the other connection-scoped valves
   * (`clearStaleDraftWatch`).
   *
   * The CURSOR IS KEPT — Telegram's app keeps its `pts` across connections, and so
   * do we; only the in-flight request, its timer and its buffer go. A reconnect
   * re-runs `updates.getState` (the register-time snapshot), and its `highWaterSeq`
   * re-detects any gap through the ordinary three-way check.
   */
  private resetCursorForConnection(): void {
    const cursor = this.cursor;
    if (cursor.state === "catching-up") {
      this.clearCatchUpTimer(cursor);
      this.cursor = { state: "synced", last: cursor.afterSeq };
      return;
    }
    // `synced`/`unseeded` hold nothing connection-scoped: there is no request, no
    // timer and no buffer, and the baseline (or the absence of one) is exactly
    // what the next connection should resume from.
  }

  /**
   * The ordinary per-frame dispatch: observe held-turn activity against the
   * pre-frame latch, fold the frame, then re-evaluate the release gate. Split out
   * of `handleMessage` so the #244 gap-sync path can gate/buffer around it.
   */
  private applyFrame(msg: InboundMessage): boolean {
    // Observe authenticated turn activity against the pre-frame live-turn latch.
    // Reducers may settle that latch or invoke public listeners, so this must be
    // the first operation for every decrypted frame.
    const preFrameLiveTurn = this.turnInFlight();
    this.observeHeldTurnActivity(msg, preFrameLiveTurn);
    // #246 half A: the verdict travels to the caller — the seq cursor advances
    // only for a frame that was actually folded. See `handleFrame`.
    const folded = this.handleFrame(msg);
    // P1-9 §3.2: every handled frame is a state transition — re-evaluate the
    // release gate after the reducer settles (a no-op when nothing is held or a
    // turn is still in flight). Deliberately NOT gated on `folded`: the latch
    // observation above already ran, and a re-evaluation is idempotent.
    this.maybeRelease();
    return folded;
  }

  /**
   * #244 half B / #356 — fold a `difference` catch-up onto the view, then either
   * re-request (the reply was a slice) or settle and re-dispatch what was held.
   *
   * The events are folded through the SAME `applyDurable` reducer path live frames
   * fold through — RAW journal events, no client-local overlays beyond the ones
   * `foldDifferenceEvent` re-supplies — so the result converges on the durable
   * (history) truth for the caught-up range.
   *
   * ⚠️ TWO GATES BEFORE ANYTHING IS TOUCHED, AND THEY ARE DIFFERENT QUESTIONS.
   *  1. Is a request outstanding at all? A `difference` is only meaningful in
   *     `catching-up`; one arriving in any other state is stale (a reply that lost
   *     the race with a retry's reply, or one landing after a give-up or a
   *     reconnect) and is DROPPED WHOLE, which is the exact guard against a
   *     re-fold for EVERY event kind.
   *  2. Is it MINE? `.out` is shared by every device of this peer (#245 Part B —
   *     the subject IS the fan-out), so a reply to ANOTHER device's request lands
   *     here too. Before #356 nothing asked: device A, catching up from floor 100,
   *     folded device B's reply for floor 300, advanced its cursor to B's max, and
   *     silently lost 101..300 (#351, NOT-list N8). The reply echoes the request's
   *     `afterSeq` and `nonce`; both must match this cursor's, or it is ignored in
   *     silence — the other device is being answered, not us, and our own reply or
   *     our timeout is still coming.
   *
   * ⚠️ THE FOLD FLOOR IS THE CURSOR, AND THAT IS NOW A TAUTOLOGY RATHER THAN A
   * COINCIDENCE. `catching-up` holds ONE number: nothing may move the cursor while
   * a reply is owed, so there is no "live cursor" that could drift away from the
   * floor the request was issued with, and no deferred advance to reconcile
   * afterwards. That drift, plus a PARTIAL reply, was #352 — the deferred `ack`
   * seq landed above the reply's range and the drain then discarded the buffered
   * events between them.
   *
   * ⚠️ A REFUSED EVENT IS SKIPPED AND ITS SEQ STILL ADVANCES — the DELIBERATE
   * OPPOSITE of the live path, where a refused frame must NOT advance. A difference
   * is the authoritative answer to a gap, so freezing the cursor on a row this
   * build cannot fold would re-request that same row forever. The server's
   * `projectJournalHistory` treats such a row the same way (an `unsupportedEvents`
   * skip). `decodeDurableEvent`'s docblock states the asymmetry once, for both
   * sites.
   */
  private applyDifference(msg: InboundMessage): void {
    const cursor = this.cursor;
    // Gate 1: no request outstanding ⇒ stale/duplicate. Drop it WITHOUT touching
    // any timer (none belongs to it) or draining anything.
    if (cursor.state !== "catching-up") return;
    // Gate 2: not the reply to OUR request ⇒ another device's, or a superseded
    // retry's. Silent: on a shared subject this is ordinary traffic, not a fault.
    if (msg.nonce !== cursor.nonce || msg.afterSeq !== cursor.afterSeq) return;
    // ⚠️ THE LIVENESS TIMER IS *NOT* STOPPED HERE, AND THAT IS THE ROUND-4 FIX.
    // It used to be cleared the moment a matching reply arrived, on the theory
    // that the round-trip was over. A STALL is a reply that ends nothing — so
    // clearing here and re-arming there handed the deadline to the peer: any
    // peer stalling faster than `GET_DIFFERENCE_TIMEOUT_MS` pushed the deadline
    // back forever and the timer never fired. Measured over 10 simulated minutes
    // at a 50 ms stall cadence: ONE request, still catching-up, 12 001 frames
    // held, nothing rendered. The deadline now belongs to the REQUEST: only a
    // reply that actually ends the round-trip clears it (see the `finally`).

    const raw = Array.isArray(msg.events) ? msg.events : [];
    const events = raw
      .filter(
        (e): e is { seq: number; event: unknown } =>
          // #246 half A: `isWireSeq`, not `typeof === "number"`. These seqs become
          // the cursor, so a `NaN` (which loses every comparison and would leave
          // the cursor short) or an over-large value (which would park it past
          // every real seq) is worse here than a missing entry.
          !!e && typeof e === "object" && isWireSeq((e as { seq?: unknown }).seq),
      )
      // The server sends ascending `seq`; sort defensively so the fold order is a
      // property of this method, not of the wire.
      .sort((a, b) => a.seq - b.seq);

    let last = cursor.afterSeq;
    let completed = false;
    // What this reply actually DELIVERED — see `CarriedRows`. Both sets take an
    // entry only for an event that was decoded AND folded: a row this build
    // cannot read advances the cursor past itself (the documented asymmetry) but
    // delivers nothing, so it may not drop a held frame that IS foldable.
    const carriedSeqs = new Set<number>();
    const authoredIds = new Set<string>();
    // ⚠️ `try/finally` (#246 half A): the transition below MUST run even if a fold
    // throws. `notifyMessageListeners` (`nats-client.ts`) swallows a listener's
    // throw, so an escape from here would leave the cursor stuck in `catching-up`
    // with its liveness timer already cancelled — every later durable frame
    // silently held, with nothing left to re-issue anything.
    // `decodeDurableEvent` is what makes such a throw unreachable; this is the
    // belt to its braces, and it is cheap.
    //
    // ⚠️ IT DEGRADES, IT DOES NOT PRETEND. `last` is raised AFTER each event is
    // handled, so a throw leaves the cursor at the last event actually applied —
    // and `completed` is what stops the server's `maxSeq` from papering over the
    // rest.
    //
    // ⚠️ AND THE SELF-HEAL AFTER A THROW IS CONDITIONAL — say which condition.
    // If frames were HELD during the round-trip, the re-dispatch below re-detects
    // the gap and asks again with a fresh retry budget (a TRANSIENT throw heals;
    // a deterministic one re-requests the same range each round, the pre-existing
    // shape of any reply that fails to close a gap). If the buffer is EMPTY —
    // a gap opened by an `ack` echo, say — nothing re-detects anything: the
    // cursor simply sits below the event that threw until the next durable frame
    // arrives and reads the hole. Degraded, not wedged, which is the property
    // the `finally` is here for.
    try {
      for (const { seq, event } of events) {
        // Fold everything the request asked for; a `seq <= last` is a
        // raced/duplicate overlap we already hold.
        if (seq <= last) continue;
        const decoded = decodeDurableEvent(event);
        if (decoded.ok) {
          this.foldDifferenceEvent(decoded.event);
          carriedSeqs.add(seq);
          for (const id of authoredIdsOf(decoded.event)) authoredIds.add(id);
        } else if (decoded.kind === "malformed") {
          // Only the MALFORMED case is reported: an unknown kind is an ordinary
          // version skew and would be noise on every frame from a newer server,
          // while a known kind we cannot fold is a real defect somewhere upstream.
          console.warn(
            `[nats-wrapper] skipping malformed ${decoded.eventKind} event at seq ${seq} ` +
              `in a difference: ${decoded.reason}`,
          );
        }
        last = seq;
      }
      completed = true;
    } finally {
      // ⚠️ ONLY IF THIS CATCH-UP IS STILL THE LIVE ONE. The fold runs reducers and
      // public listeners, and a listener may call `close()` — which runs
      // `resetCursorForConnection` and lands a valid `synced` cursor. Transitioning
      // on top of that would re-enter `catching-up` on a closed client, with a
      // request nothing will answer and a timer nothing will clear. Object
      // identity, the same test the timer uses.
      if (this.cursor === cursor) {
        // `maxSeq` is the highest seq this reply ACCOUNTS FOR, which is more than
        // the events it carried: a seq the server SKIPPED as undeliverable at this
        // peer's `max_payload` (#343) is covered but unsendable, and freezing on
        // it would wedge this device for the session. It is adopted only when the
        // whole reply was processed — after a throw it would claim a range that
        // was never applied.
        const covered = completed && isWireSeq(msg.maxSeq) ? Math.max(last, msg.maxSeq) : last;
        const carried: CarriedRows = { seqs: carriedSeqs, authoredIds };
        // ⚠️ A STALL ENDS NOTHING, AND "NOTHING" INCLUDES THE DEADLINE. The
        // cursor stays, its retry budget is preserved, and the timer the REQUEST
        // armed is left exactly where it was — `onCatchUpTimeout` is the only
        // thing that re-issues and the only thing that gives up. Round 3 re-armed
        // here instead, which starts a FRESH `GET_DIFFERENCE_TIMEOUT_MS`: a peer
        // stalling faster than that pushed the deadline back on every reply and
        // the timeout never fired. Measured over 10 simulated minutes at a 50 ms
        // stall cadence: ONE request, still catching-up, 12 001 frames held,
        // nothing rendered — worse than the loop the stall rule replaced.
        if (!this.stalled(msg, covered, completed, cursor)) {
          // The round-trip IS over, so the request's deadline has nothing left to
          // protect. Both branches below install a NEW cursor, and this is the one
          // place that retires the old one's timer.
          this.clearCatchUpTimer(cursor);
          if (msg.partial === true) {
            // Telegram's `updates.differenceSlice`: "the query must be repeated,
            // using the intermediate status as the current status." The
            // intermediate status is `covered`; the held frames carry FORWARD,
            // minus the ones this slice delivered.
            this.openCatchUp(covered, this.uncarried(cursor.buffer, carried));
          } else {
            this.settleSynced(covered, cursor.buffer, carried);
          }
        }
      }
      // A difference can settle a held-turn condition (it is durable turn content),
      // and the fold above bypassed the per-frame gate; re-evaluate it once here.
      this.maybeRelease();
    }
  }

  /**
   * #244 half B — fold ONE raw catch-up event, applying the SAME client-local
   * overlay the corresponding LIVE handler applies.
   *
   * ⚠️ THE OVERLAY IS LOAD-BEARING, NOT DECORATION — this is the subtlety half B
   * turns on. `working`/`draftOnly` are client-local flags the wire never carries
   * (a journal `placement` has no text; a `bubble`/`seal` authors durable text and
   * RETIRES the draft). A BARE `applyDurable(bubble)` folded onto a live draft
   * bubble keeps that bubble `draftOnly:true` — and `projectDurableFromClient`
   * blanks a `draftOnly` bubble to `""`, so the caught-up text would VANISH from
   * the durable view. Re-supplying the exact overlays `case "agent_message"` /
   * `case "progress"` / `applyTurnSnapshot` supply is what makes a gap heal to a
   * view byte-identical to the no-gap fold (live == history). Every other event
   * kind (`user`/`reasoning`/`tool`/`approval`/…) carries no such flag, so it folds
   * with no overlay exactly as its live handler does — an approval, like a
   * history-replayed one, is inert until an `approval_snapshot` arms it.
   */
  private foldDifferenceEvent(event: DurableEvent): void {
    switch (event.kind) {
      case "bubble":
        // Mirror `case "agent_message"`: durable text authored ⇒ no longer a draft.
        this.applyDurable(event, {
          [event.answerId]: { working: false, draftOnly: undefined },
        });
        return;
      case "placement": {
        // Mirror `case "progress"`: the slot claim is a working draft. The draft
        // TEXT is not journaled, so it stays empty until a `bubble`/`seal` authors
        // it (the same lane the live progress carried, minus the volatile text).
        //
        // ⚠️ MED-3: `draftOnly` is CLAIMED ONLY when the bubble is absent or is
        // itself already a draft — the SAME `claimsDraft` guard the live `progress`
        // handler applies. A placement landing on an ALREADY-AUTHORED bubble (a
        // re-progress, or a placement re-served after its answer arrived) must NOT
        // re-mark it droppable: `projectDurableFromClient` would then blank the
        // authored answer to `""` (the "answer destroyed" case the live docblock
        // guards). `working: true` is still set unconditionally, exactly as live —
        // it is not a durable flag, so it never blanks the projection.
        const held = this.state.messages.find(
          (m) => m.kind === undefined && m.id === event.answerId,
        );
        const claimsDraft = held === undefined || held.draftOnly === true;
        this.applyDurable(event, {
          [event.answerId]: { working: true, ...(claimsDraft ? { draftOnly: true } : {}) },
        });
        return;
      }
      case "seal": {
        // Mirror `applyTurnSnapshot`: each sealed answer is authored durable text.
        const local = Object.create(null) as DurableLocalOverlay;
        for (const a of event.answers) {
          local[a.id] = { working: false, draftOnly: undefined };
        }
        this.applyDurable(event, local);
        return;
      }
      case "user": {
        // #337 — a LOST ack leaves the optimistic user bubble un-adopted at its
        // local id (`adoptCommittedIds` runs only on the ack). The turn's first
        // agent frame opens a gap, and this difference re-delivers the same user
        // event under the SERVER id (`webchannel-user-<seq>`) — a DISTINCT id — so
        // a bare `applyDurable` would `applyUser`-append a SECOND user bubble.
        //
        // #245 Part B folds the live broadcast the SAME way (`case "user_committed"`
        // in `handleFrame`), so the adopt-then-fold body lives in ONE place.
        this.foldUserEvent(event);
        return;
      }
      default:
        this.applyDurable(event);
    }
  }

  /**
   * #337 / #245 Part B — adopt an un-adopted optimistic user bubble by `random_id`
   * THEN fold the user event, the ONE body shared by the `get_difference` catch-up
   * (`foldDifferenceEvent`'s `case "user"`) and the live multi-device broadcast
   * (`handleFrame`'s `case "user_committed"`).
   *
   * Adopt FIRST — the SAME correlation the ack path uses — re-keying the local
   * bubble to `event.id` BEFORE the fold, so `applyUser`'s `findTextIndex` now
   * finds it and no-ops (ONE bubble on the ORIGIN device). If `randomId` is absent
   * (older row/older client), unknown, or already adopted (the ack won the race
   * and drained the linkage), the adopt is a no-op and `applyUser` APPENDS —
   * which is exactly what a NON-ORIGIN device (no linkage for this `random_id`)
   * wants. NEVER text-matched. `applyUser` is id-idempotent, so a re-delivery
   * (broadcast PLUS a later gap-sync difference of the same event) is a no-op.
   */
  private foldUserEvent(event: Extract<DurableEvent, { kind: "user" }>): void {
    if (typeof event.randomId === "string" && event.randomId.length > 0) {
      this.adoptUserBubbleByRandomId(event.randomId, event.id);
    }
    this.applyDurable(event);
  }

  /**
   * #337 — adopt ONE un-adopted optimistic user bubble onto its server id by
   * `random_id`, the resolve+rekey+delete core `adoptCommittedIds` runs per ack
   * entry, narrowed to a single linkage for the difference fold.
   *
   * The linkage is CONSUMED (`delete`) unconditionally, exactly as the ack path
   * does: the echo — via ack OR via a re-delivered difference — is terminal for
   * this `random_id`. Whichever path runs first drains it, so the other's
   * `randomIdToReceiptKey.get` returns undefined and it becomes a no-op (no
   * double-adopt, no crash) — the ordering safety the ack/difference race needs.
   *
   * A `random_id` with no live linkage (already adopted, or never sent from this
   * client) resolves to `undefined` ⇒ no re-key; the caller then folds unchanged
   * (`applyUser` no-ops on an already-held id, or appends a genuinely new final).
   */
  private adoptUserBubbleByRandomId(randomId: string, serverId: string): void {
    const receiptKey = this.randomIdToReceiptKey.get(randomId);
    // Consume the linkage — terminal for this random_id (mirrors adoptCommittedIds).
    this.randomIdToReceiptKey.delete(randomId);
    if (receiptKey === undefined) return;
    let changed = false;
    const messages = this.state.messages.map((m): ChatMessage => {
      // Only a sent USER echo re-keys. `role === "user"` narrows to `ChatBubble`;
      // `receiptKey` links it to its send. An already-server-id bubble is a no-op.
      if (m.role !== "user" || m.receiptKey !== receiptKey) return m;
      if (m.id === serverId) return m;
      changed = true;
      return { ...m, id: serverId };
    });
    if (changed) this.setState({ messages });
  }

  /**
   * Fold ONE inbound frame onto the view.
   *
   * ⚠️ RETURNS "WAS THIS FRAME FOLDED", AND THE SEQ CURSOR DEPENDS ON IT (#246
   * half A). `true` means the frame was ACCEPTED and applied — INCLUDING an
   * accepted no-op (an empty `history`, a `turn_snapshot` with nothing to seal,
   * an `approval_resolved` naming a card this view does not hold). `false` means
   * the frame was REFUSED as malformed and NOTHING was applied.
   *
   * ⚠️ THIS USED TO RETURN `void`, AND THAT WAS THE BUG. Every shape check in
   * here is a bare early `return`, indistinguishable from a successful fold to
   * the caller — so the cursor advanced past a seq-bearing frame it had just
   * REFUSED. The event was then lost forever: the cursor
   * covered its seq, so no later frame read a gap, and the `get_difference` that
   * would have re-served the canonical journal row was never sent. The invariant
   * is now: A SEQ-BEARING FRAME ADVANCES THE CURSOR IFF IT WAS FOLDED.
   *
   * ⚠️ AND THE INVARIANT LIVES HERE, NOT IN THE DOOR DECODER. `decodeInboundMessage`
   * makes most of these refusals unreachable in production, which is exactly why
   * the cursor must not be wired to it: a decoder that misses a case would
   * silently reintroduce the loss. Two independent guards, and the cheap one is
   * the one that cannot be incomplete.
   *
   * See `inbound-wire-decode.ts`'s `decodeDurableEvent` for why a refusal inside
   * a `difference` does the OPPOSITE (skip, but advance) — one rule, two doors.
   */
  private handleFrame(msg: InboundMessage): boolean {
    switch (msg.type) {
      case "history": {
        const rawIncoming = Array.isArray(msg.messages) ? msg.messages : [];
        /**
         * ⚠️ DROP EMPTY-TEXT AGENT ROWS BEFORE ANYTHING ELSE LOOKS AT THEM.
         *
         * A lane that got a `progress` and then neither a `bubble` nor a
         * `seal.answers` entry — an aborted turn, or a connection dropped before
         * the drain — leaves a PLACEMENT whose text is never authored. The
         * server's replay emits it as `{role:"agent", text:""}` because
         * `applyPlacement` appends one and nothing in the journal removes it
         * (`journal-history.ts`'s header documents this as N8-by-omission), and
         * the server CANNOT drop it: the rule that hides it live keys on
         * `draftOnly`, a client-local flag §15.9 deliberately never journals.
         *
         * ⚠️ WHY IT STILL EXISTS NOW THAT AGENT ROWS CANNOT ADOPT. It was added
         * because the row DESTROYED a delivered answer: matching no local text it
         * fell through to the positional probe, which took the next real agent
         * bubble and overwrote it with `{id: P, text: ""}` (N10). That probe is
         * deleted, so the row can no longer damage anything — it would simply
         * fresh-insert. The filter is retained for the ORIGINAL, smaller reason,
         * which the damage had overshadowed: live renders nothing for such a
         * lane, so a history that renders an empty bubble diverges from live for
         * no benefit (N8). Deriving the row away server-side is #251/#264.
         *
         * ⚠️ THIS IS NOT A NEW RULE — IT IS THE ONE THIS CLIENT ALREADY APPLIES
         * LIVE, moved to the only other door the same lane can arrive through.
         * `isSpentDraft`/`dropSpentDrafts` delete a spent draft at turn end
         * (#251, settled against core's built-in Telegram extension, which
         * deletes an unfinalized preview rather than keeping it). An empty agent
         * bubble renders nothing either way, so this converges history to live
         * instead of inventing a third behaviour.
         *
         * ⚠️ A `history` FRAME IS NOT "ALWAYS AFTER TURN END" — an earlier
         * revision of this paragraph said so, and the Phase-6 note below
         * contradicts it: a snapshot arrives at every device MID-SESSION. The
         * justification does not need that claim. A lane still in flight
         * projects `{agent, ""}` and is filtered — same outcome as the live
         * draft it mirrors, which also renders nothing. A lane that already
         * published a bubble carries its text, so it tier-1 matches its own
         * `working:true` draft by id and is left alone (tier 1 is a no-op; a
         * working draft is never an adoption target either).
         *
         * Keeping it client-local is also where
         * **#264** says the derivation belongs — a server-side "placement whose
         * answerId never reappears" fold would be a supersession rule invented
         * in the projection, which is the N8 the store exists to prevent.
         *
         * ⚠️ RESIDUAL, STATED BECAUSE `isSpentDraft`'s OWN DOCBLOCK NAMES IT:
         * this keys on `text === ""`, which `isSpentDraft` deliberately does NOT,
         * so it also drops a LEGITIMATELY empty durable message. Those are not
         * structurally impossible — every answer/final path guards non-empty
         * text, but the generic outbound seam (`channel.ts:311`) forwards core's
         * `ctx.text` unchecked. The consequence is invisible: an empty bubble
         * renders nothing whether it is dropped or kept. We cannot do better
         * here, because `draftOnly` is exactly the discriminator the wire does
         * not carry.
         *
         * ⚠️ IT CANNOT EAT A REASONING ROW, AND THE REASON IS THE `role` TEST,
         * NOT THE TEXT TEST (#242 half 2 — checked, because "empty text" would
         * be the tempting thing to blame). A reasoning row carries NO `role`, so
         * the first conjunct is already false and the row is kept whatever its
         * text says.
         *
         * ⚠️ THAT IS WHY AN EMPTY REASONING ROW IS REFUSED IN THE REASONING
         * BRANCH INSTEAD, and it is a different rule with a different reason.
         * Live, `case "reasoning"` drops a frame whose `text` is empty
         * (`msg.text.length === 0`). Without a matching admission rule here the
         * same content would be DROPPED live and KEPT from history — an empty
         * `<details>` the live path would never draw, which is an N8 divergence
         * this door introduced. It is not enough that the plugin's
         * `closeLiveBurst` only emits a burst frame when
         * `lastDeliveredText.length > 0`: that makes such a row unreachable FROM
         * OUR PLUGIN, not absent, and this reducer's standing policy is that a
         * history row is validated on its own rather than on trust in the
         * server. (Contrast the empty USER row below, which is deliberately
         * KEPT: nothing drops an empty user bubble live either, so keeping it is
         * what agrees.)
         */
        const incoming = rawIncoming.filter(
          (m) =>
            !(
              m &&
              typeof m === "object" &&
              (m as { role?: unknown }).role === "agent" &&
              (m as { text?: unknown }).text === ""
            ),
        );
        if (incoming.length === 0) return true;

        const existing = this.state.messages;
        /**
         * The tier-1 key: (KIND, identity), never the id alone.
         *
         * ⚠️ `state.messages` MIXES KINDS SINCE #242 half 2 (three of them since
         * half 3), and the id spaces are NOT provably disjoint —
         * `durable-view-reducer.ts`'s `findTextIndex` docblock retracts the
         * id-shape argument outright (agent answer ids come from the same
         * `nextMessageId()` as reasoning ids, and USER ids are client-supplied,
         * validated only as a non-empty string within
         * `MAX_INBOUND_USER_ID_LENGTH`, so a peer can send `webchannel-…`
         * verbatim). Indexing a mixed array by id alone is therefore the whole
         * defect class; keying it is the fix, and it is one property rather than
         * a rule each site has to remember.
         *
         * ⚠️ THE LOCAL LAMBDA IS GONE — IT WAS THE NEXT INSTANCE OF THE DEFECT,
         * NOT A HELPER. It read
         * `` `${kind === "reasoning" ? "r" : "t"}\0${id}` ``: a two-way test with
         * an `else`, so half 3's tool entries would have keyed as BUBBLES and
         * collided silently. `transcriptEntryKey` switches on a closed union
         * with a `never` default, so a fourth kind (half 4's approvals) fails to
         * compile instead. It also carries tool's composite `(turnId, id)` key,
         * which a `(kind, id)` lambda could not express — and it is the SAME
         * function `mergeDurable` keys local entries with, so the wire side and
         * the local side cannot drift.
         */
        const seen = new Set(existing.map((m) => transcriptEntryKey(m)));

        // Phase 6 (stateless register, shared conversation key): a snapshot
        // triggered by ANY device's register — this device's reconnect or a
        // second device joining — arrives at every device mid-session on the
        // shared `.out`. Messages already rendered LIVE on this device sit in
        // state under LOCAL id namespaces, so plain id-dedup could duplicate
        // them.
        //
        // ⚠️ #240 HALF 2 CHANGED WHERE THE SNAPSHOT'S IDS COME FROM, AND THE
        // AGENT-SIDE GUESSING TIERS WERE DELETED BECAUSE OF IT. History is no
        // longer core's transcript; it is a projection of the plugin's own
        // delivery journal, whose ids ARE the ids minted at the delivery act —
        // the same `webchannel-…` values the live frames carried. So:
        //   - AGENT rows: if this device rendered the answer, its bubble carries
        //     that id and TIER 1 matches. Therefore an agent row that MISSES tier
        //     1 has no local counterpart, and any text- or position-based
        //     adoption of one is guaranteed to overwrite a different message.
        //     Tiers 2 and 3 are closed to agent rows for that reason.
        //   - USER rows: the local echo is `u-<n>` (`mintLocalBubbleId`) while
        //     the journal stores the inbound WIRE id, so a user row legitimately
        //     misses tier 1 and TIER 2 is how it is recovered. Removing tier 2
        //     here would fresh-insert every user row on every snapshot and
        //     duplicate everything this device sent. **#302** owns removing it,
        //     and is blocked on **#243** giving a user message one shared id.
        //
        // ⚠️ THE HONEST COST, STATED WHERE IT IS PAID: text matching is the
        // ordinal/text inference NOT-list N5 forbids, and it still runs on the
        // user path. That is not an oversight — it is unremovable until #243.
        //
        // ⚠️ WHY DELETION RATHER THAN MORE RULES. Four data-loss defects were
        // found in this block across four consecutive review rounds, each fixed
        // by adding a rule, and each new rule failed to cover the next instance:
        // a tier-1 match that did not claim its bubble; the unauthored placement
        // row firing the positional probe; `adoptAt` not retiring the id it
        // displaced; and a hydrated bubble being treated as live because the old
        // `isLocalLiveId` was a bare `webchannel-` prefix test. All four were on
        // the agent path. Do not reintroduce a tier here to "restore coverage" —
        // the coverage it restores is the coverage that lost the messages.
        //
        // Matching happens in two tiers, in snapshot order:
        //   1. id — a message whose canonical id we already hold is a no-op.
        //      This is where every AGENT row either matches or falls through to
        //      a fresh insert;
        //   2. exact text+role — USER ROWS ONLY. Adopt the server id onto the
        //      first text-matching local echo.
        // ⚠️ A REASONING ROW USES TIER 1 AND THE FRESH INSERT, AND NOTHING ELSE
        // (#242 half 2). It is handled in its own branch below, ahead of the
        // `role` validation, for a reason worth stating here too: reasoning ids
        // are PLUGIN-minted and identical live and in the snapshot, so tier 1 is
        // the normal outcome — and tier 2 is closed to it twice over (the
        // incoming row's `if (m.role === "user")` and the pool's
        // `isAdoptableUserEcho`).
        // PLACEMENT of the unmatched (fresh) messages is ORDERED, not a blanket
        // prepend (#16). We carry an insertion CURSOR = the index into `next`
        // before which the next fresh message lands; every match/adoption walks
        // it to `matchedIndex + 1`. So a mid-session snapshot whose overlapping
        // prefix matches the local tail inserts its unseen suffix chronologically
        // AFTER that prefix (a turn sent from another device, or turns that
        // landed while this tab was disconnected, appear at the bottom — not the
        // top). Pagination and zero-overlap frames match nothing → the cursor
        // stays 0 → the whole page prepends in order (unchanged); initial
        // hydration into empty state inserts everything at 0 in order (unchanged).
        // A `working:true` progress draft is never an adoption target: its
        // live id must survive for the upcoming progress/final upserts.
        // Known cosmetic edge (accepted): if TWO devices send the identical
        // text near-simultaneously, text-only matching can adopt the OTHER
        // device's server id onto this device's bubble — the ids swap between
        // the two bubbles, but the bubble COUNT stays exactly right and every
        // later snapshot still dedups, so nothing duplicates or disappears.
        // ⚠️ USER ROWS ONLY — the agent branch of this predicate was DELETED, and
        // its NAME is why. It used to be `isLocalLiveId`, and it read
        // `!m.working && (id.startsWith("a-") || id.startsWith("webchannel-"))`.
        // Post-cutover a history-HYDRATED agent bubble also carries
        // `webchannel-`, so the prefix stopped discriminating "rendered live on
        // this device" from "handed to us by the server" — and an older page
        // then adopted onto a bubble a previous snapshot had hydrated, destroying
        // the newer answer. The predicate is now named for what it actually
        // tests.
        //
        // P1-9 §6.3, still load-bearing: a held (pending) or /stop-retracted user
        // bubble is LOCAL-ONLY (never on the wire, never in the journal). It must
        // NEVER be an adoption target — a snapshot row with identical text (the
        // same text sent from another device) would otherwise steal its server id
        // onto our UNSENT bubble, and the later release would run/duplicate it.
        // ⚠️ A TYPE PREDICATE, not a `boolean` — #242 half 2. `m.role === "user"`
        // already excludes a reasoning entry at RUNTIME (it has no role), and
        // the predicate makes tsc carry that fact to the `adoptKey(m.role, …)`
        // below instead of leaving `role` possibly-undefined there. It is also
        // the second of the two independent guards that keep tier 2 off a
        // reasoning row; the other is the `if (m.role === "user")` on the
        // incoming row.
        const isAdoptableUserEcho = (m: ChatMessage): m is ChatBubble =>
          m.role === "user" &&
          m.id.startsWith("u-") &&
          m.pending !== true &&
          m.retracted !== true;
        const adoptKey = (role: string, text: string): string => `${role} ${text}`;

        const next = existing.slice();
        // Last-wins on a duplicate key, exactly as before — the change is the
        // KEY, not the policy, so the non-collision case is unaffected.
        const localIndexByKey = new Map<string, number>();
        next.forEach((m, i) => localIndexByKey.set(transcriptEntryKey(m), i));
        const claimed = new Set<number>();
        const adoptable = new Map<string, number[]>();
        next.forEach((m, i) => {
          if (isAdoptableUserEcho(m)) {
            const key = adoptKey(m.role, m.text);
            const idxs = adoptable.get(key) ?? [];
            idxs.push(i);
            adoptable.set(key, idxs);
          }
        });

        let adopted = false;
        /**
         * Fresh (unmatched) snapshot messages, grouped by the INSERTION CURSOR
         * value in effect when each was seen — the index into `next` BEFORE
         * which they must land. We cannot splice into `next` mid-loop (that
         * invalidates every cached local index in
         * `localIndexByKey`/`claimed`/`adoptable`), so the placement is deferred
         * to a single rebuild after the loop. Multiple fresh messages sharing a
         * cursor keep their snapshot order (appended to the same array).
         */
        const inserts = new Map<number, ChatMessage[]>();
        /**
         * Index into `next` before which the NEXT fresh message is inserted.
         * Advances to `matchedIndex + 1` past every matched (tier 1) or adopted
         * (tier 2/3) message, so a snapshot's unseen tail lands chronologically
         * AFTER the overlapping matched prefix instead of being prepended (#16).
         */
        let cursor = 0;

        const adoptAt = (idx: number, m: { id: string; text: string; ts?: number }): boolean => {
          // INVARIANT: `seen` and `localIndexByKey` describe `next` exactly.
          // `adoptAt` is the only thing that mutates `next` inside the loop, so
          // it is the only place that can break them.
          //
          // ⚠️ EVERY KEY BELOW IS A BUBBLE KEY, AND THAT IS CHECKED, NOT
          // ASSUMED. This closure has ONE call site — the tier-2 branch, gated
          // `if (m.role === "user")` — so the incoming row is a user bubble; and
          // `idx` comes only from the `adoptable` pool, seeded solely from
          // `isAdoptableUserEcho`, a type predicate that narrows to
          // `ChatBubble`. So the displaced entry is a bubble too, and a
          // reasoning key can never be the right one here.
          //
          // ⚠️ THE REACHABLE TRIGGER IS GONE and the earlier version of this
          // comment claiming "MEASURED DATA LOSS WITHOUT THIS LINE" no longer
          // describes this tree. It was true while AGENT rows could adopt: the
          // snapshot carried the very id being displaced as its own later row,
          // which then tier-1 "matched" a bubble it no longer occupied and was
          // dropped. Only user echoes adopt now, and the sole id a user adoption
          // can displace is a local `u-<n>` that no snapshot row ever carries.
          // Kept anyway: two lines that keep the bookkeeping unconditionally true
          // beat a live premise about what ids can appear.
          // ⚠️ NARROWED, NOT CAST (#242 half 3). The argument above proves the
          // target is a bubble, and until half 3 the SPREAD below happened to
          // type-check anyway; with a third arm it stopped, because
          // `ChatToolMessage` pins `text` to `undefined` and this writes a
          // string. Rather than cast the proof back in, the refusal is made
          // explicit and REPORTED: the caller falls through to the fresh-insert
          // path, so an invariant violation costs a duplicate row rather than a
          // dropped one or a malformed entry. `adopted`/`claimed`/`cursor` are
          // all left untouched on that path, which is what keeps `seen` and
          // `localIndexByKey` describing `next` exactly.
          const target = next[idx];
          if (target.kind !== undefined) return false;
          const displacedId = target.id;
          // Keep the canonical stored text on adoption, so this device
          // converges to exactly what a reloading device would render. The
          // observed live block ordinal is deliberately discarded: history
          // cannot validate or persist this run/attempt-local metadata.
          const { assistantMessageIndex: _liveOrdinal, ...adoptedMessage } = target;
          next[idx] = {
            ...adoptedMessage,
            id: m.id,
            text: m.text,
            ts: m.ts,
          };
          // `displacedId !== m.id` always here (equality is a tier-1 hit, which
          // never reaches an adoption), so this cannot erase what we just set.
          seen.delete(transcriptEntryKey({ id: displacedId }));
          localIndexByKey.delete(transcriptEntryKey({ id: displacedId }));
          claimed.add(idx);
          localIndexByKey.set(transcriptEntryKey({ id: m.id }), idx);
          adopted = true;
          cursor = idx + 1;
          return true;
        };

        for (const m of incoming) {
          if (!m || typeof m !== "object") continue;
          if (typeof m.id !== "string" || m.id.length === 0) continue;
          // ⚠️ THE TOOL BRANCH RUNS BEFORE THE `text` GUARD, AND MUST. A tool row
          // is the ONE history variant with no `text` at all — its content is the
          // name/phase/status/argKeys surface — so leaving it below the guard
          // would drop EVERY tool row on the way in while live rendered them
          // (N10, and an N8 live≠history gap). Found by the compiler only
          // indirectly; verified by the round-trip test.
          /**
           * ⚠️ #242 half 3: A TOOL ROW TAKES TIER 1 OR A FRESH INSERT, exactly
           * like a reasoning row, and all four properties in the docblock above
           * carry over unchanged — with one addition that is NOT cosmetic:
           *
           *  5. THE KEY IS `(kind, turnId, id)`. `transcriptEntryKey` composes
           *     the tool arm from BOTH identity fields, so tier 1 here asks the same
           *     question `applyTool` and `indexTranscriptByKind` ask. Keying a
           *     tool row by id alone would tier-1 match two different calls that
           *     happen to share a producer id across turns and DROP the second —
           *     N10 content loss, and the same shape as the defect property 4
           *     records, one field further out.
           *
           * ⚠️ THE ROW IS A MERGED CALL, NOT A FRAME, so it is inserted whole.
           * The journal stores one row per frame and the PLUGIN's projection
           * folds them through the same `applyTool` before serving; by the time a
           * row reaches this client it is already the merge result. That is why
           * there is no accumulation to do here and no partial to reconcile.
           *
           * `turnId` is REQUIRED on this variant (the wire types it `string`), so
           * a row without one is dropped rather than inserted with a fabricated
           * correlation — the same rule the reasoning branch applies. There is
           * deliberately NO non-empty test on the other fields: unlike reasoning's
           * `text`, every one of them is optional on the wire and an empty
           * `status` is a real state a live frame can produce, so refusing one
           * here would drop a row live rendered.
           */
          if (m.kind === "tool") {
            if (typeof m.turnId !== "string" || m.turnId.length === 0) continue;
            const key = transcriptEntryKey({ kind: "tool", id: m.id, turnId: m.turnId });
            if (seen.has(key)) {
              const li = localIndexByKey.get(key);
              if (li !== undefined) {
                cursor = li + 1;
                claimed.add(li);
              }
              continue;
            }
            seen.add(key);
            const atCursorTool = inserts.get(cursor) ?? [];
            atCursorTool.push({
              kind: "tool",
              id: m.id,
              turnId: m.turnId,
              ...(typeof m.name === "string" ? { name: m.name } : {}),
              ...(typeof m.phase === "string" ? { phase: m.phase } : {}),
              ...(typeof m.status === "string" ? { status: m.status } : {}),
              ...(typeof m.summary === "string" ? { summary: m.summary } : {}),
              ...(Array.isArray(m.argKeys)
                ? { argKeys: m.argKeys.filter((k): k is string => typeof k === "string") }
                : {}),
              ...(typeof m.ts === "number" ? { ts: m.ts } : {}),
            });
            inserts.set(cursor, atCursorTool);
            continue;
          }
          /**
           * ⚠️ #242 half 4: AN APPROVAL ROW TAKES TIER 1 OR A FRESH INSERT, and
           * it MUST sit above the `text` guard for the same reason the tool
           * branch does — an approval row carries no `text` at all (its content
           * is the title/prompt/options surface), so below the guard every one
           * of them would be dropped while live rendered them (N10, and an N8
           * live≠history gap).
           *
           * The four properties in the reasoning branch's docblock carry over
           * unchanged: tier 1 is the normal outcome (an approval id is the
           * gateway's `approvalId`, identical live and in the projection); tier
           * 2 cannot reach it (gated `if (m.role === "user")`, and the pool is
           * seeded only from `isAdoptableUserEcho`); a miss fresh-inserts at the
           * cursor; and tier 1 can only match an entry of this row's own kind,
           * because `transcriptEntryKey` keys by (kind, id).
           *
           * ⚠️ AND THE ROW IS INSERTED WITHOUT `actionable` — THAT IS THE POINT
           * OF THE WHOLE SLICE, NOT AN OMISSION. A card rebuilt here is a
           * REPLAY: the durable stream may record it as still pending while it
           * has since expired or been decided on another device, and a click
           * would send a decision nobody is waiting for. It renders inert until
           * a register-time `approval_snapshot` lists it as pending again, which
           * is the one authority for "still open". Do not "restore" the bit here
           * to make a reloaded card usable; the snapshot already does that, on
           * every register, and it does it from the server's own pending set.
           *
           * `resolvedDecision` IS adopted from the row, because live showed the
           * decided card with its outcome and history must not hide it (N8/N10).
           * It is validated against the three real decisions rather than trusted:
           * these values come off the wire unvalidated, and the client's
           * `"unknown"` sentinel must never enter through this door — it is a
           * local reconciliation outcome, and a server that sent one would be
           * asserting a resolution that never happened.
           */
          if (m.kind === "approval") {
            const key = transcriptEntryKey({ kind: "approval", id: m.id });
            if (seen.has(key)) {
              const li = localIndexByKey.get(key);
              if (li !== undefined) {
                cursor = li + 1;
                claimed.add(li);
              }
              continue;
            }
            seen.add(key);
            const atCursorApproval = inserts.get(cursor) ?? [];
            atCursorApproval.push({
              kind: "approval",
              id: m.id,
              approvalKind: m.approvalKind === "plugin" ? "plugin" : "exec",
              title: typeof m.title === "string" ? m.title : "",
              ...(typeof m.description === "string" ? { description: m.description } : {}),
              prompt: typeof m.prompt === "string" ? m.prompt : "",
              options: Array.isArray(m.options)
                ? (m.options as ApprovalOption[])
                : [],
              ...(typeof m.expiresAtMs === "number" ? { expiresAtMs: m.expiresAtMs } : {}),
              // ⚠️ A SERVED DECISION IS SERVER-CONFIRMED BY CONSTRUCTION, and
              // saying so here is not decoration — it is what stops a replayed
              // card RE-SENDING a decision. The only producer of an
              // `approvalResolution` row is an `approval_resolved` frame the
              // plugin itself published, so a decision that came out of the
              // journal is by definition the server's own answer, never
              // `decide()`'s optimistic guess. Leaving the flag off would make
              // the next `approval_snapshot` that still lists the card as
              // pending (stale by milliseconds, or a server that never erased
              // it) take Leg C and re-send a decision this device never made.
              // It is also the one field that made the live and replayed cards
              // differ — measured, not predicted: the both-sides test went red
              // on exactly this key.
              ...(isApprovalDecision(m.resolvedDecision)
                ? { resolvedDecision: m.resolvedDecision, resolutionConfirmed: true }
                : {}),
              ...(typeof m.ts === "number" ? { ts: m.ts } : {}),
            });
            inserts.set(cursor, atCursorApproval);
            continue;
          }
          if (typeof m.text !== "string") continue;
          /**
           * ⚠️ #242 half 2: A REASONING ROW TAKES TIER 1 OR A FRESH INSERT, AND
           * NOTHING ELSE. Four properties make that safe, and all four were
           * checked rather than assumed:
           *
           *  1. TIER 1 IS THE NORMAL OUTCOME. A reasoning id is minted by the
           *     PLUGIN (`nextMessageId()` inside the reasoning controller) and
           *     travels on the live `reasoning` frame; `journalEventForOutbound`
           *     copies that same `frame.id` into the journal row. So the id this
           *     device rendered live IS the id the snapshot carries, and
           *     `seen.has(transcriptEntryKey(m))` matches it — no
           *     adoption, no duplicate.
           *  2. TIER 2 CANNOT REACH IT, TWICE OVER. The adoption branch is
           *     gated `if (m.role === "user")`, which a role-less row fails; and
           *     the pool itself is seeded only from `isAdoptableUserEcho`, which
           *     tests `m.role === "user"`. So no reasoning row can adopt, and no
           *     reasoning bubble can BE adopted onto.
           *  3. A MISS FRESH-INSERTS AT THE CURSOR, exactly like an agent row
           *     that misses tier 1 — which is the right answer for the same
           *     reason: with plugin-minted ids, a miss means this device has no
           *     local counterpart at all.
           *  4. TIER 1 CAN ONLY MATCH AN ENTRY OF THE ROW'S OWN KIND, because
           *     `seen`/`localIndexByKey` are keyed by (KIND, id) rather than by
           *     id — see `transcriptEntryKey` for why the id spaces cannot be
           *     assumed disjoint. This was the fourth outcome
           *     the first revision of this list did not enumerate, and it was
           *     the defect: a kind-blind tier 1 counted a collision with an
           *     entry of the OTHER kind as a match and DROPPED the row — never
           *     inserted, never rendered, though it renders fine on a fresh
           *     load (N10, live≠history content loss). A miss now falls to the
           *     fresh insert, which is already the right answer for "this device
           *     has no local counterpart" (property 3).
           *
           *     ⚠️ KEYING THE INDEX IS THE FIX; A CONJUNCT ON TOP OF AN ID-KEYED
           *     INDEX WAS TRIED FIRST AND WAS WRONG. That version left the map
           *     keyed by id and guarded tier 1 with `kindAgrees`. Page 1
           *     fresh-inserted correctly — and then, because the map is
           *     LAST-WINS, `get(id)` on the resulting same-id pair resolved to
           *     the OTHER kind's entry forever, `kindAgrees` never became true
           *     again, and the row inserted AGAIN on every subsequent page.
           *     Measured: three identical pages yielded three text entries
           *     beside the one reasoning entry. A snapshot lands on every
           *     register, so unbounded duplicate growth per reconnect is worse
           *     than the drop it replaced. Keyed, page 2 is an ordinary tier-1
           *     match and the whole thing is idempotent — which is why the
           *     conjunct is gone rather than repaired.
           *
           * `turnId` is REQUIRED on this variant (the wire types it `string`),
           * so a row without one is dropped rather than inserted with a
           * fabricated correlation.
           */
          if (m.kind === "reasoning") {
            if (typeof m.turnId !== "string" || m.turnId.length === 0) continue;
            // ⚠️ THE SAME ADMISSION RULE `case "reasoning"` APPLIES LIVE. Its
            // guard is `msg.text.length === 0`, and a history row must meet it
            // too or the identical content renders from one door and not the
            // other — see the empty-row note at the top of this case.
            if (m.text.length === 0) continue;
            // Keyed, so this can only ever meet a REASONING entry (property 4).
            const key = transcriptEntryKey({ kind: "reasoning", id: m.id });
            if (seen.has(key)) {
              const li = localIndexByKey.get(key);
              if (li !== undefined) {
                cursor = li + 1;
                claimed.add(li);
              }
              continue;
            }
            seen.add(key);
            const atCursorReasoning = inserts.get(cursor) ?? [];
            atCursorReasoning.push({
              kind: "reasoning",
              id: m.id,
              turnId: m.turnId,
              text: m.text,
              ...(typeof m.ts === "number" ? { ts: m.ts } : {}),
            });
            inserts.set(cursor, atCursorReasoning);
            continue;
          }
          if (m.role !== "user" && m.role !== "agent") continue;
          // Keyed, so this can only ever meet a BUBBLE — see property 4 in the
          // reasoning branch's docblock above for the whole argument.
          const key = transcriptEntryKey({ id: m.id });
          if (seen.has(key)) {
            const li = localIndexByKey.get(key);
            // Tier-1 match: walk the cursor past this already-held message so
            // later fresh messages insert after it. A key we cannot locate
            // locally leaves the cursor untouched.
            //
            // ⚠️ THAT CASE IS REACHABLE, AND THE PARENTHETICAL THAT USED TO SIT
            // HERE DENIED IT — it read "should not happen — `seen` is seeded
            // from `next`". `seen` is ALSO added to by the fresh-insert paths
            // below, which do not touch `localIndexByKey`, so a key in `seen`
            // with no local index is the ordinary within-page repeat: still a
            // match, still a drop. It was already wrong before #242 half 2, and
            // it is cut now because keying the index makes that state the ONLY
            // way the two can disagree.
            if (li !== undefined) {
              cursor = li + 1;
              // ⚠️ CLAIM IT. A bubble already identified BY ID must not stay a
              // later row's tier-2 adoption target. Like the retirement in
              // `adoptAt`, this is now bookkeeping rather than a live fix — the
              // pool holds only unadopted `u-<n>` echoes, which cannot be
              // tier-1 matched (the journal never serves that id). The measured
              // loss it was added for was on the AGENT path, which no longer
              // adopts at all.
              //
              // `claimed` alone is sufficient: tier 2 shifts claimed indices off
              // the front of each pool before using one, so this entry is purged
              // when it is reached. No pool surgery, no loop restructuring.
              claimed.add(li);
            }
            continue;
          }

          seen.add(key);
          // Tier 2: exact text+role — ⚠️ USER ROWS ONLY, and the role test is
          // EXPLICIT rather than left to the pool being empty for agent keys.
          // Implicit-by-empty-pool is exactly the kind of coupling that produced
          // the four defects this deletion closes: it reads as "agent rows may
          // adopt, there just happens to be nothing to adopt onto", which is one
          // pool-seeding edit away from being wrong again.
          if (m.role === "user") {
            const idxs = adoptable.get(adoptKey(m.role, m.text));
            while (idxs && idxs.length > 0 && claimed.has(idxs[0])) idxs.shift();
            if (
              idxs &&
              idxs.length > 0 &&
              adoptAt(idxs.shift()!, { id: m.id, text: m.text, ts: m.ts })
            ) {
              continue;
            }
          }
          const atCursor = inserts.get(cursor) ?? [];
          atCursor.push({
            id: m.id,
            role: m.role,
            text: m.text,
            ts: m.ts,
            working: false,
          });
          inserts.set(cursor, atCursor);
        }

        if (inserts.size === 0 && !adopted) return true;

        // Rebuild `next` with each fresh group spliced in at its cursor. Slot i
        // holds the messages that must precede `next[i]`; slot `next.length`
        // holds any tail appended after the last local message.
        const merged: ChatMessage[] = [];
        for (let i = 0; i <= next.length; i++) {
          const ins = inserts.get(i);
          if (ins) merged.push(...ins);
          if (i < next.length) merged.push(next[i]);
        }
        this.setState({ messages: merged });
        return true;
      }

      case "typing": {
        this.setState({ isTyping: true });
        return true;
      }

      case "commands": {
        // P0-3 discovery: replace the catalog wholesale (idempotent — a repeat
        // request just refreshes it). NOT turn activity, so isTyping is left
        // untouched.
        this.setState({ commands: Array.isArray(msg.commands) ? msg.commands : [] });
        return true;
      }

      case "ack": {
        // P0-4: acceptance is now driven authoritatively by the low-level
        // tracker — the same `ack` frame already advanced each matching wireId to
        // `accepted` via `onSendState` (which patched the bubble's sendState).
        // `handleMessage` runs the release gate (`maybeRelease`) AFTER this
        // reducer returns, so the ack still participates in re-evaluating
        // held-message release.
        //
        // #243 half 2b: an `ack` MAY also carry `committed` — the server's
        // durable id per `random_id`. Adopt each onto its optimistic bubble so
        // client and server converge on one id (`adoptCommittedIds`). It runs
        // after `onSendState` has already flipped the bubble to `accepted`; the
        // re-key preserves that overlay. An ack without `committed` is a no-op
        // here (the tier-2/3 history fallback reconciles that bubble).
        this.adoptCommittedIds(msg.committed);
        return true;
      }

      case "user_committed": {
        // #245 Part B: the immediate multi-device broadcast of a just-committed
        // inbound user message. Fold it exactly as the `get_difference` catch-up
        // folds a `user` event (`foldDifferenceEvent`'s `case "user"`) — adopt by
        // `random_id` THEN fold — so the two paths cannot diverge:
        //  - ORIGIN device: the adopt re-keys its optimistic bubble onto the server
        //    `id` (or no-ops if the ack already drained the `random_id` linkage),
        //    and `applyUser` then no-ops — ONE bubble.
        //  - NON-ORIGIN device: no linkage for this `random_id`, so the adopt is a
        //    no-op and `applyUser` APPENDS the user bubble. The seq-bearing path in
        //    `handleMessage` has already advanced this device's cursor, so the
        //    turn's first agent frame is contiguous (no false gap).
        // `applyUser` is id-idempotent, so a re-delivery (this broadcast PLUS a
        // later gap-sync difference of the same event) is a no-op.
        const id = typeof msg.id === "string" ? msg.id : "";
        if (id.length === 0 || typeof msg.text !== "string") return false;
        this.foldUserEvent({
          kind: "user",
          id,
          text: msg.text,
          ...(typeof msg.turnId === "string" ? { turnId: msg.turnId } : {}),
          ...(typeof msg.random_id === "string" ? { randomId: msg.random_id } : {}),
        });
        return true;
      }

      case "inbound_rejected": {
        // The low-level client has already removed ledger entries and emitted
        // failed{overloaded}; receipt/bubble state arrives through onSendState.
        return true;
      }

      case "approval_request": {
        // ⚠️ #242 half 4: AN id-LESS FRAME IS NOW REFUSED, AND THAT IS A
        // DELIBERATE (SMALL) BEHAVIOUR CHANGE. This used to build a card under
        // `id: msg.id ?? ""`. `journalEventForOutbound` refuses an empty id
        // (`isUsableMessageId`, the one definition of "id-less" the whole store
        // shares), so keeping the old default would render a card live that
        // history can never hold — N8 in the GAINING direction, manufactured at
        // this line. It costs nothing real: an approval id is the gateway's
        // `approvalId` and is what `approval_decision` sends back, so a card
        // under `""` was undecidable anyway.
        const id = msg.id ?? "";
        if (id.length === 0) return false;
        const merged = this.nextDurableMessages({
          kind: "approval",
          id,
          approvalKind: msg.kind ?? "exec",
          title: msg.title ?? "",
          ...(msg.description !== undefined ? { description: msg.description } : {}),
          prompt: msg.prompt ?? "",
          options: (msg.options ?? []) as ApprovalOption[],
          ...(msg.expiresAtMs !== undefined ? { expiresAtMs: msg.expiresAtMs } : {}),
        });
        // Upsert-preserve (#15) is NOT repeated here — `applyApproval` owns it,
        // so a re-delivered `approval_request` (stateless register, retry)
        // cannot clobber a resolution and resurrect the buttons. The rule lives
        // in the shared reducer precisely so a REPLAY obeys it too.
        //
        // The LIVE frame is one of the two authorities for "this card is open
        // right now", so it is also the one that (re-)arms interactivity.
        this.setState({
          messages: markApprovalActionable(merged, id),
          isTyping: false,
        });
        return true;
      }

      case "approval_resolved": {
        const id = msg.id ?? "";
        const decision = msg.decision as ApprovalDecision | undefined;
        // ⚠️ A DECISION-LESS FRAME IS REFUSED, where this used to write
        // `resolvedDecision: undefined` alongside `resolutionConfirmed: true` —
        // i.e. mark a card confirmed-resolved with no outcome, which no renderer
        // can express. The wire types `decision` as an `ApprovalDecision`, so
        // only a malformed peer produces one, and the journal mapper refuses the
        // same shape.
        if (id.length === 0 || decision === undefined) return false;
        // Server-confirmed resolution: the DECISION is durable state and the
        // reducer folds it (`applyApprovalResolution`); `resolutionConfirmed` is
        // client-local and marks it authoritative, so the snapshot reconciler
        // never re-sends it as a lost decision (Leg C) and never downgrades it to
        // the "unknown" sentinel (Leg B). (#15)
        const merged = this.nextDurableMessages({
          kind: "approvalResolution",
          id,
          decision,
        });
        this.setState({ messages: markApprovalConfirmed(merged, id) });
        return true;
      }

      case "approval_snapshot": {
        // Authoritative pending-approval reconciliation (#15). The snapshot is
        // the account's COMPLETE still-pending set for this peer at publish time;
        // we reconcile local approval state against it to close three legs:
        //   A (reload lost the card) — a snapshot id with no local entry is
        //     rehydrated as pending;
        //   B (missed approval_resolved) — a local unresolved card ABSENT from
        //     the snapshot was decided/expired elsewhere → mark it non-actionable.
        //     If the snapshot's `resolved` set (#19) carries the actual outcome,
        //     show that decision; otherwise (aged out of the server's resolved
        //     ring) fall back to the "unknown" sentinel. Either way confirmed.
        //   C (lost decision frame) — a locally-decided but NOT server-confirmed
        //     card the snapshot STILL lists as pending → the decision frame was
        //     lost; re-send it and keep the card resolved (every future register
        //     retries until the server confirms, so it converges hands-free).
        //
        // ⚠️ #242 half 4 GAVE THIS FRAME A FOURTH JOB, AND IT IS THE ONE THE
        // SLICE EXISTS FOR: THIS IS THE ONLY THING THAT MAKES A CARD CLICKABLE
        // AGAIN. Approvals are durable messages now, so a reconnect ALSO replays
        // them out of `history` — and a replayed card is built without
        // `actionable`, deliberately, because between the disconnect and now it
        // may have expired or been decided on another device. The snapshot is
        // exactly the authority for "what is still open", and it is emitted on
        // EVERY successful register, unconditionally, in the same success block
        // as the history snapshot (`nats-register.ts`'s
        // `deps.sendApprovalSnapshot(peerId)`), so nothing has to be invented
        // to carry that role.
        //
        // ⚠️ THE ARRIVAL ORDER OF `history` AND THIS FRAME IS NOT FIXED, AND
        // BOTH ORDERS ARE HANDLED HERE. The register path calls
        // `sendHistorySnapshot` first, but #240 half 2 made that read DEFERRED,
        // so the approval snapshot can win the race. If the snapshot lands
        // FIRST, Leg A inserts the card actionable and the later history row
        // tier-1 matches it (`case "history"` walks its cursor past a match and
        // touches nothing). If `history` lands FIRST, the card is already in the
        // transcript and INERT — which is why the still-pending branch below
        // RE-ARMS an existing entry instead of assuming "present ⇒ already
        // actionable". That assumption is what the pre-half-4 code made, and it
        // was correct only while cards could not arrive from history at all.
        //
        // ⚠️ THE RECONCILIATION RUNS OVER `state.messages`, NOT OVER A SIDE
        // ARRAY. `state.approvals` is derived (`deriveApprovals`), so a card's
        // transcript POSITION is preserved by every leg below: each patched
        // entry is rebuilt in place, and only Leg A appends.
        const incoming = Array.isArray(msg.approvals) ? msg.approvals : [];
        const snapshotById = new Map<string, ChatApprovalMessage>();
        for (const p of incoming) {
          if (!p || typeof p.id !== "string" || p.id.length === 0) continue;
          snapshotById.set(p.id, {
            kind: "approval",
            id: p.id,
            approvalKind: p.kind ?? "exec",
            title: p.title ?? "",
            ...(p.description !== undefined ? { description: p.description } : {}),
            prompt: p.prompt ?? "",
            options: (p.options ?? []) as ApprovalOption[],
            ...(p.expiresAtMs !== undefined ? { expiresAtMs: p.expiresAtMs } : {}),
            // Leg A's inserts are actionable BY CONSTRUCTION — the snapshot is
            // the authority that says so. This is the second (and last) door
            // through which the bit is ever set; the other is the live
            // `approval_request` frame.
            actionable: true,
          });
        }
        // #19: the recently-RESOLVED outcomes riding alongside the pending set.
        // A resolved-list id with no local card is NOT rehydrated (it is done —
        // nothing actionable); the map only upgrades Leg B / the optimistic branch.
        const resolvedIncoming = Array.isArray(msg.resolved) ? msg.resolved : [];
        const resolvedById = new Map<string, ApprovalDecision>();
        for (const r of resolvedIncoming) {
          if (!r || typeof r.id !== "string" || r.id.length === 0) continue;
          resolvedById.set(r.id, r.decision as ApprovalDecision);
        }

        const seen = new Set<string>();
        const next: ChatMessage[] = [];
        let changed = false;
        // Tracks whether a NEW actionable (pending) card was rehydrated (Leg A),
        // so we clear the typing indicator in parity with the live
        // `approval_request` path — a fresh actionable card means the agent is
        // BLOCKED on the user, not still working.
        let rehydratedActionable = false;

        for (const m of this.state.messages) {
          // Every other transcript kind passes straight through: this frame
          // reconciles approval state and says nothing about bubbles, reasoning
          // blocks or tool calls.
          if (m.kind !== "approval") {
            next.push(m);
            continue;
          }
          seen.add(m.id);
          // Defense in depth: an id in BOTH the pending `approvals` and the
          // `resolved` lists is impossible server-side (finalize deletes the
          // pending entry and records the resolved outcome in ONE synchronous
          // step before publishing), but if it ever happens the TERMINAL outcome
          // must win — never keep/make the card actionable. So a resolved-listed
          // id is routed to the resolved-upgrade branches below, ignoring `snap`.
          const snap = resolvedById.has(m.id) ? undefined : snapshotById.get(m.id);
          // "Answered" in ANY of the three ways a card can be: the server told
          // us, we guessed optimistically in `decide()`, or a previous Leg B
          // recorded that somebody else answered it.
          const answered =
            m.resolvedDecision !== undefined || m.resolvedElsewhere === true;
          if (snap) {
            if (!answered) {
              // Present + unresolved: actionable with the full payload (an
              // approval is immutable once minted), so the payload is NOT
              // rebuilt from the snapshot — a duplicate snapshot must stay a
              // no-op. The one thing that may need changing is the bit: a card
              // hydrated from `history` is inert until this frame arms it.
              if (m.actionable !== true) {
                next.push({ ...m, actionable: true });
                changed = true;
              } else {
                next.push(m);
              }
            } else if (m.resolutionConfirmed !== true && m.resolvedDecision !== undefined) {
              // Leg C: re-send the lost decision, keep the card resolved. Stays
              // unconfirmed so the next register retries until the server echoes
              // an authoritative `approval_resolved`. A `resolvedElsewhere` card
              // has no decision to re-send and is excluded by the second
              // conjunct — the same carve-out the old `!== "unknown"` test made.
              this.deferOrRunReplacementOperation({
                kind: "approval-decision", id: m.id, decision: m.resolvedDecision,
              });
              next.push(m);
            } else {
              // Server-confirmed resolution wins over a stale-by-ms snapshot.
              next.push(m);
            }
          } else if (!answered) {
            // Leg B: decided/expired while we weren't looking — no longer
            // actionable, server-confirmed (authoritative). #19: show the ACTUAL
            // outcome if the snapshot carried it, else the "unknown" sentinel,
            // which rides `resolvedElsewhere` because it is a reconciliation
            // outcome and not a decision anyone made.
            const outcome = resolvedById.get(m.id);
            next.push(
              outcome !== undefined
                ? { ...m, resolvedDecision: outcome, resolutionConfirmed: true }
                : { ...m, resolvedElsewhere: true, resolutionConfirmed: true },
            );
            changed = true;
          } else if (m.resolutionConfirmed !== true) {
            // Optimistic decision the server no longer has pending — our decision
            // (or another device's) won. #19: if the snapshot's resolved outcome
            // DIFFERS from our optimistic guess, the SERVER decision wins;
            // otherwise just confirm what we already showed.
            const outcome = resolvedById.get(m.id);
            next.push(
              outcome !== undefined && outcome !== m.resolvedDecision
                ? { ...m, resolvedDecision: outcome, resolutionConfirmed: true }
                : { ...m, resolutionConfirmed: true },
            );
            changed = true;
          } else {
            next.push(m);
          }
        }

        // Leg A: snapshot ids with no local entry → rehydrate as pending cards.
        //
        // Appended at the TAIL, which is where a still-open prompt belongs and is
        // also what `applyApproval` would do for a first-seen id. A later
        // `history` page carrying the same card tier-1 matches it by
        // (kind, id) and does not duplicate it.
        for (const [id, snap] of snapshotById) {
          if (seen.has(id)) continue;
          // Defense in depth (see the loop above): an id present in BOTH lists is
          // terminal, so do NOT rehydrate an actionable card for it.
          if (resolvedById.has(id)) continue;
          next.push(snap);
          changed = true;
          rehydratedActionable = true;
        }

        if (changed) {
          this.setState({
            messages: next,
            ...(rehydratedActionable ? { isTyping: false } : {}),
          });
        }
        return true;
      }

      case "progress": {
        const { id } = msg;
        const text = msg.text ?? "";
        // NULLISH, not truthy: `""` survives as a real id here, and the reducer's
        // `placement` mirrors that (BOUNDARY 1 — it is the `bubble` site below
        // that treats `""` as id-less, and the two genuinely differ).
        const answerId = id ?? "";
        // `draftOnly` is only ever CLAIMED, never ADDED to a bubble that already
        // exists without it. The bit is what makes a bubble droppable at turn end
        // (`isSpentDraft`), so adding it to a bubble that already holds authored
        // durable text would let a single stray `progress` frame turn a delivered
        // answer into a DELETED one:
        //
        //   agent_message A "FINAL ANSWER"  → [A "FINAL ANSWER"]
        //   progress      A "Working…"      → [A "Working…", draftOnly]
        //   turn_settled                    → []            ← answer destroyed
        //
        // Such a frame should never arrive (see the UNGUARDED INVARIANT note on
        // `applyPlacement`), but "should never" is not a reason to make the
        // failure unrecoverable. This project's own ordering says so:
        // `message-adapter.ts:1760-1761` — a visible duplicate is recoverable
        // where a deletion is not (M212g). So a plugin-guard regression stays a
        // wrong-text bug, repairable by the turn's `turn_snapshot`, exactly as it
        // was before the reducer rewiring.
        //
        // A bubble that is ALREADY `draftOnly` keeps the bit (idempotent
        // re-claim), and an absent one claims it — that is the normal path, and
        // it is what keeps the rolling draft out of the durable projection
        // (§15.9) while it still renders.
        // ⚠️ `m.kind === undefined` IS PART OF THE PREDICATE, exactly as in
        // `patchBubbleByReceiptKey` — the two id spaces are not provably
        // disjoint (`durable-view-reducer.ts`'s `findTextIndex` docblock), and a
        // reasoning entry found here reads as a bubble with `draftOnly`
        // undefined, so `claimsDraft` goes false, the overlay omits `draftOnly`,
        // and the rolling draft never becomes droppable at turn end — it freezes
        // as durable text.
        const heldBubble = this.state.messages.find(
          (m) => m.kind === undefined && m.id === answerId,
        );
        const claimsDraft = heldBubble === undefined || heldBubble.draftOnly === true;
        this.applyDurable(
          {
            kind: "placement",
            answerId,
            ...(msg.turnId === undefined ? {} : { turnId: msg.turnId }),
          },
          { [answerId]: { working: true, text, ...(claimsDraft ? { draftOnly: true } : {}) } },
        );
        this.setState({ isTyping: false });
        // P1-9 §3.6.2: a progress upsert on a watched draft proves the turn is
        // still alive — disarm its staleness entry.
        this.staleDraftWatch.delete(answerId);
        return true;
      }

      case "reasoning": {
        if (!msg.id || !msg.turnId || typeof msg.text !== "string" || msg.text.length === 0) {
          return false;
        }
        // ⚠️ #242 half 2: THROUGH THE SHARED REDUCER, like every other durable
        // frame. Half 1 called a private `upsertReasoning` over a side array;
        // that method is deleted, and with it the second implementation the v6
        // bet cannot afford (N8). The event is byte-identical to the one
        // `journalEventForOutbound` records for this burst's `final` frame, so a
        // replay folds the same transition this line does.
        //
        // ⚠️ EVERY FRAME, NOT JUST `final`. `msg.final` is deliberately not read
        // here: the lane streams cumulative FULL text and `applyReasoning` is an
        // upsert by id, so applying each frame renders the burst live and
        // converges on exactly the text the `final` frame carries — which is the
        // text that gets journaled. Gating on `final` would leave the live lane
        // blank until the burst closed.
        //
        // ⚠️ WHAT THIS COSTS. A reasoning frame arrives per cumulative token
        // update with no throttle, and each one now projects and re-merges the
        // WHOLE transcript instead of walking a ≤100-entry side array. It is the
        // same per-frame O(messages) the other durable frames already pay, and
        // taking a cheaper private path would be the second implementation
        // again — so the cost is accepted here and tracked as **#310**, not
        // worked around. (Named rather than left as "its own issue": every other
        // deferral in this slice cites a number, and an uncited one is a claim
        // the next reader cannot check.)
        this.applyDurable({
          kind: "reasoning",
          id: msg.id,
          turnId: msg.turnId,
          text: msg.text,
        });
        // P1-9 §3.6.2: reasoning correlates by turnId — disarm any watched draft
        // for this turn (the turn is demonstrably still producing frames).
        this.disarmStaleDraftsByTurn(msg.turnId);
        return true;
      }

      case "tool_activity": {
        // #97: structured tool-call activity. Required correlation keys `id` and
        // `turnId` must be non-empty strings; drop otherwise. Only the KEY NAMES
        // in `argKeys` are carried — no arg values ever reach state.
        if (typeof msg.id !== "string" || msg.id.length === 0) return false;
        if (typeof msg.turnId !== "string" || msg.turnId.length === 0) return false;
        // ⚠️ #242 half 3: THROUGH THE SHARED REDUCER, NOT A SIDE ARRAY. The
        // event is the FRAME, verbatim — a delta. `applyTool` folds it onto the
        // call it refines, which is why the terminal frame's missing `name` and
        // `argKeys` do not blank the ones `start` carried. The admission rule
        // (non-empty string id AND turnId) is the one `journalEventForOutbound`
        // tracks, so nothing is journaled that this refuses and nothing is
        // refused that gets journaled.
        this.applyDurable({
          kind: "tool",
          id: msg.id,
          turnId: msg.turnId,
          ...(typeof msg.name === "string" ? { name: msg.name } : {}),
          ...(typeof msg.phase === "string" ? { phase: msg.phase } : {}),
          ...(typeof msg.status === "string" ? { status: msg.status } : {}),
          ...(typeof msg.summary === "string" ? { summary: msg.summary } : {}),
          // Trust boundary: the wire is untrusted; keep only string key names
          // (the "argKeys are key names only" contract) and drop anything else.
          // It survives to disk unchanged — the plugin's mapper applies the SAME
          // filter, so a hostile value cannot enter the journal by either door.
          ...(Array.isArray(msg.argKeys)
            ? { argKeys: msg.argKeys.filter((k): k is string => typeof k === "string") }
            : {}),
        });
        // Like reasoning, a tool_activity frame correlates by turnId and proves
        // the turn is still producing frames — disarm any watched stale draft.
        this.disarmStaleDraftsByTurn(msg.turnId);
        return true;
      }

      case "turn_settled": {
        // Consume before outcome promotion or UI settlement: either operation
        // can fan out synchronously, and a delayed publish callback must not open
        // a turn whose settle has already arrived.
        const turnPlacement = this.consumeTurnOpeningsThrough(msg.turnId);
        // P0-4 (§1): promote the exact send named by an EXPLICIT outcome.
        // `"ok"` → `accepted → completed` where turnId === wireId; `"error"`
        // → `failed{turn-failed, retryable:true}`. The current plugin emits one
        // same-outcome frame per coalesced member, anchor last. ABSENT `outcome`
        // means a legacy plugin (fires turn_settled from a finally regardless of
        // success): the UI still
        // settles below, but the send honestly stays `accepted` — never a
        // fabricated `completed`. A turn_settled that beats the ack promotes
        // straight past `sent` (the receipt guard allows the monotonic upgrade).
        if (msg.turnId && msg.outcome === "ok") {
          this.promoteAnchor(msg.turnId, "completed");
        } else if (msg.turnId && msg.outcome === "error") {
          this.promoteAnchor(msg.turnId, "failed", { reason: "turn-failed", retryable: true });
        }
        // Outcome is authoritative and must be committed before either UI
        // settlement callout. A listener reacting to typing/draft completion may
        // close the client; that teardown cannot overwrite completed/turn-failed.
        //
        // #96: this frame ends the turn it names AND every turn published before
        // it. Current coalesced groups emit one frame per member, anchor last;
        // the prefix behavior preserves compatibility with older anchor-only
        // producers and recovers from lost/missing earlier member frames (see
        // `closeTurnsThrough`). An outcome-less legacy `turn_settled` closes just
        // the same (the settlement is what matters, not the outcome).
        // Unknown/foreign ids and replays of an already-consumed local settle
        // remain no-ops; a local settle racing its first sent callback still
        // closes the already-open prefix.
        const turnClosed = this.closeTurnsThrough(turnPlacement);
        this.setState({ isTyping: false, ...(turnClosed ? { turnActive: false } : {}) });
        // P1-9 §3.6.1: settled ⇒ no more upserts — finalize any lingering working
        // draft whose turnId matches (in the normal flow the final agent_message
        // already did this, a no-op). Never swaps the id.
        this.finalizeDraftsForTurn(msg.turnId);
        return true;
      }

      case "turn_snapshot": {
        return this.applyTurnSnapshot(msg);
      }

      case "agent_message": {
        const { text, id } = msg;
        const assistantMessageIndex = normalizeAssistantMessageIndex(
          msg.assistantMessageIndex,
        );

        if (id) {
          this.applyDurable(
            {
              kind: "bubble",
              answerId: id,
              text: text ?? "",
              ...(msg.turnId === undefined ? {} : { turnId: msg.turnId }),
            },
            {
              [id]: {
                working: false,
                // Durable text has been authored, so the bubble is no longer a
                // draft — this is what makes it survive the turn end.
                draftOnly: undefined,
                ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
              },
            },
            { isTyping: false },
          );
          // P1-9 §3.6.2: the final upsert also proves liveness — disarm.
          this.staleDraftWatch.delete(id);
          return true;
        }

        // Preserve the legacy id-less path's existing two public transitions:
        // typing clears before the client-local bubble id is minted/applied.
        this.setState({ isTyping: false });

        // LEGACY-PLUGIN PATH ONLY. Since #238 every durable egress site mints an
        // id at the delivery act, so a durable frame reaching here means an older
        // plugin build. The text is never dropped (NOT-list N10): it still gets a
        // bubble, via a client-local `a-<n>`.
        //
        // Minting that id and feeding it to the reducer is admissible precisely
        // because it NEVER LEAVES THE CLIENT. What BOUNDARY 1 forbids (N4/N5) is
        // a viewer-minted id entering the SHARED EVENT STREAM, where it would
        // write viewer-side identity into the SSOT. Kept inside this local view
        // it does the opposite of harm: routing it through the reducer is what
        // removes the N8 divergence the old `appendMessage` branch created, where
        // the live view held a bubble the reducer's view did not.
        const mintedId = this.mintLocalBubbleId("a");
        if (!this.warnedIdlessDurableFrame) {
          this.warnedIdlessDurableFrame = true;
          console.warn(
            "[nats-wrapper] durable agent_message arrived without an id; " +
              "rendering it under a client-local id. This is a legacy-plugin " +
              "path — since #238 the plugin mints the id at the delivery act.",
          );
        }
        this.applyDurable(
          {
            kind: "bubble",
            answerId: mintedId,
            text: text ?? "",
            ...(msg.turnId === undefined ? {} : { turnId: msg.turnId }),
          },
          assistantMessageIndex !== undefined
            ? { [mintedId]: { assistantMessageIndex } }
            : undefined,
        );
        return true;
      }
    }
    // ⚠️ NO `default:`, AND FALLING OFF THE END IS STILL THE IGNORE — this is
    // the same deliberate absence `durable-view-reducer.ts`'s BOUNDARY note
    // describes for LIVE frames: a type from a newer server does nothing rather
    // than throwing. What changed in #246 half A is only that the ignore is now
    // EXPLICIT (`false` — not folded) instead of an implicit `undefined`, and
    // that the frame no longer gets this far: the door decoder refuses an
    // unknown type with one warn. Nothing hangs on the value either way, because
    // an unknown type is not in `SEQ_BEARING_INBOUND_TYPES` and so never reaches
    // the cursor.
    return false;
  }
}
