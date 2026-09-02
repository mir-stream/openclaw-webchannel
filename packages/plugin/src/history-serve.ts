/**
 * v6 delivery-render — THE LIVE HISTORY READ PATH (issue #240 half 2, doc §15.6).
 *
 * Both things a peer can ask for — the register-time snapshot and a
 * `load_history` page — are the same three steps: pick a plan, replay this
 * peer's journal through the shared reducer (`journal-history.ts`), publish the
 * result — byte-fitted to the peer's wire since #311 (`history-frame-budget.ts`,
 * applied in `publishFitted` below). This module owns those two bodies so that
 * `nats-account-runtime.ts` is left holding wiring and no policy.
 *
 * ⚠️ IT LIVES HERE BECAUSE IT COULD NOT BE TESTED WHERE IT LIVED BEFORE, AND
 * THAT WAS NOT A STYLE PROBLEM. Both bodies were closures inside
 * `buildNatsAccount`, unreachable from any test, so the tenant-isolation suite
 * "covered" them by TRANSCRIBING them into a helper. MEASURED consequence:
 * changing the production call from `serveHistoryRequest(journal.read, peerId,
 * …)` to `…, accountId, …` — which lets every peer under one
 * `(tenant, accountId)` read every other peer's conversation — left all 21
 * tests in `session-route-tenant-isolation.test.ts` GREEN. A security test that
 * cannot observe the code it certifies is not one. `history-serve.test.ts`
 * drives the real `createHistoryServer` against a real `openDeliveryJournal`,
 * and that mutation is now caught.
 *
 * ── WHAT SCOPES A HISTORY READ ──
 *
 * `conversationId === peerId`, and that is the whole story. Both write seams key
 * the journal by peerId (`nats-channel.ts` at egress, `ingress-dedupe.ts` at the
 * inbound accept), and the FILE is already scoped to one `(tenant, accountId)`
 * by `tupleStoragePaths(...).deliveryJournalPath`. `peerId` is the authenticated
 * JWT `sub`, so a peer can only ever name itself. There is NO session key, NO
 * route resolution and NO core transcript read on this path — that was NOT-list
 * N2 and it is gone. Do not reintroduce a core read "as a fallback": it would be
 * a second opinion about what was said.
 *
 * ── READ FAILURE: LOG, AND SEND NOTHING ──
 *
 * `serveHistoryRequest` does not catch, and neither does this module turn a
 * failure into an empty answer. On a throw: `logger.error`, and NO `history`
 * frame at all. With the journal as the only store, answering a broken read with
 * `[]` would impersonate an empty conversation to its owner — doc §15.6's
 * "조용한 빈-세션 위장 금지" reached from the read side. An empty answer from a
 * SUCCESSFUL read is a different thing and is still sent for a page.
 *
 * ⚠️ BE PRECISE ABOUT WHAT THE EMPTY PAGE DOES FOR *OUR* CLIENT: nothing. Its
 * `case "history"` returns early on a zero-length list and `loadHistory` keeps
 * no pending state, so an empty page does not "stop it asking" — it is a
 * no-op, which is the honest outcome. A third-party client that tracks its own
 * request gets the end-of-history answer. Sending nothing at all would be worse
 * for both, which is why this is still the right value.
 *
 * HONEST LIMIT: the client still sees an empty chat either way, because there is
 * no wire signal for "history unavailable" — a peer that receives no `history`
 * frame cannot distinguish it from a new conversation. This log is the only
 * place the failure is visible, so the honest policy stops at the wire.
 * **#296** owns adding the signal.
 *
 * ── ⚠️ WHY THE TWO IN-FLIGHT LATCHES EXIST: A PEER COULD PIN THE PROCESS ──
 *
 * `load_history` reaches `dispatchInbound` (`nats-channel.ts`) with no rate
 * limit, no in-flight cap and no coalescing — it does not go through
 * `inboundDebouncer` or `SerializedInboundDispatcher`, which are `user_message`
 * -only. The reader this replaced was an async gateway call hard-capped at 1000
 * messages; this one is a SYNCHRONOUS replay, quadratic in conversation length
 * (~1.45–1.51 s at 20 000 events across #286's two runs; `journal-history.ts`'s
 * own table is one run and tops out at 1449.6 ms). So 50
 * frames carrying distinct cursors against one long conversation was ~72 s of
 * blocked event loop, on the one loop serving every tenant in the process.
 * `setImmediate` does not help with that: it interleaves other work between
 * folds, it does not reduce the CPU or the concurrency.
 *
 * ── ⚠️ HALF 2 SHIPS WITH NEITHER OF #286's DISJUNCTS. READ THIS BEFORE CITING
 *    THE LATCH AS A BOUND. ──
 *
 * #286's scope note offers two ways half 2 could ship safely: "the snapshot path
 * only", or "a bound on how far back paging goes" — a DEPTH bound. **Neither is
 * satisfied here.** The snapshot is unbounded and so are pages. The latch below
 * is a third thing: it bounds a BURST of frames stacking folds. It is not a
 * depth bound and not a rate bound, and it must not be quoted as either.
 *
 * ⚠️ A DEPTH BOUND WAS BUILT AND THEN REVERTED, so the next reader does not
 * rebuild it. The only thing checkable BEFORE a fold is total conversation
 * length (via `seq`); DEPTH — how far back a cursor sits — is not, because
 * locating a cursor in the projection IS the fold. A length gate is therefore
 * not a weaker version of the old wall, it is a different and WORSE product:
 * the deleted `pageBefore` always served the newest `MAX_FETCH_WINDOW` (1 000)
 * messages and returned `[]` only for a cursor outside that window, so a
 * 3 000-message conversation could still page back through its newest 1 000. A
 * length gate at the same number gives a 1 200-message conversation a reach of
 * ZERO — the first "Load older" click and every one after it answers `[]`, and
 * 1 150 messages the pre-cutover build served become unreachable at any depth.
 * "Reproduces the old reach" was measured against the wrong quantity.
 *
 * ⚠️ WHY SHIPPING UNBOUNDED IS NONETHELESS THE RIGHT CALL, stated as the actual
 * argument rather than a shrug: bounding pages while the snapshot stays
 * unbounded is THEATRE. The register hop is unrated (#298), and it drives the
 * snapshot — an unbounded fold on a path that has no bound BY DESIGN, since a
 * truncated snapshot is a wrong chat rather than a slow one.
 *
 * ⚠️ "TRUNCATED" THERE MEANS REPLAY DEPTH, NOT THE SERVED WINDOW — read as the
 * latter the sentence is simply false, because `sendSnapshot` below asks for
 * `{kind:"recent", limit: config.limit}` — which at the DEFAULT config
 * (`DEFAULT_HISTORY_CONFIG.limit` is 50) windows every snapshot to the newest
 * 50 messages. That number is `channels.webchannel.history.limit` and an
 * operator can set it to anything; what is unconditional is that the snapshot is
 * windowed at all, not the width. What must not be
 * truncated is the FOLD: `serveHistoryRequest` projects the WHOLE journal and
 * `recentHistoryPage`/`historyPageBefore` slice that result. Truncating the
 * INPUT instead is not available — the projection is a fold from the start of
 * the stream with no way to resume partway (materializing one is exactly #286),
 * so a shortened replay yields a different conversation rather than a shorter
 * one. Windowing the OUTPUT is cheap and correct. `MAX_WIRE_HISTORY_LIMIT`
 * (`history.ts`) likewise bounds only the output of a peer-requested page — it
 * is not a fold bound and does not touch the argument below.
 *
 * The process is
 * therefore already exposed to unbounded serial folds; the page path adds
 * nothing qualitatively new to that exposure, only more of it. A page bound
 * would buy a real product regression for no change in the worst case.
 *
 * ⚠️ SO THE DECISION IS LIVE, AND IT IS NOT THIS FILE'S. #286 says the cost "IS
 * a blocker for serving long conversations. Decide which when half 2 lands."
 * Half 2 landed WITHOUT either disjunct. That decision now belongs to whoever
 * merges this — it was not made here, and this comment is not it being made.
 *
 * ⚠️ TWO SETS, NOT ONE, AND THAT IS THE WHOLE REASON THIS IS SAFE. A snapshot
 * must never be dropped because a PAGE fold is running: a page answers with
 * OLDER messages, so a reconnecting tab that lost its snapshot would lose its
 * TAIL — the most recent messages — and never recover them.
 *
 * Each drop is harmless for its own reason, and neither reason covers the other:
 *  - SNAPSHOT: the register-time snapshot is stateless and idempotent
 *    (`nats-register.ts` fires it on EVERY register, and the client's
 *    id-idempotent hydration absorbs duplicates). Dropping one because ANOTHER
 *    SNAPSHOT FOR THE SAME PEER is already folding loses nothing: same
 *    conversation, same store, an answer is already on its way.
 *  - PAGE: the next cursor comes out of the previous page's answer, so a
 *    conforming client never has two page requests outstanding. Dropping a
 *    concurrent one costs a non-conforming client an answer it was not entitled
 *    to assume it could ask for.
 *
 * ⚠️ THIS BOUNDS CONCURRENCY, NOT RATE, AND THE RESIDUAL IS REAL — VERIFIED, NOT
 * ASSUMED. The register hop is effectively unbounded in rate for an
 * authenticated peer: `handleRegisterRequest` gates on JWT + tenant + subject
 * match + `clientNonce` + a single-use PoP nonce, and `PopChallengeStore` caps
 * only the number of LIVE nonces per peer (`DEFAULT_MAX_NONCES_PER_PEER = 8`),
 * never the rate at which a peer may challenge→register→challenge→register. So
 * one authenticated peer can still drive SERIAL snapshot folds back to back and
 * occupy the loop indefinitely; the latch stops it from stacking N of them at
 * once, which is what turned a burst into minutes. Pre-cutover a register cost
 * an async core call; post-cutover it costs a synchronous quadratic fold, which
 * is a new deployment-visible property — **#298** owns bounding the trigger, and
 * it is the lever that matters most given nothing bounds depth.
 *
 * ⚠️ #298 AND #286 ARE INDEPENDENT LEVERS AND NEITHER SUBSUMES THE OTHER: #286
 * makes the replay cheaper, #298 bounds how often it can be triggered. Fixing
 * one does not retire the other.
 *
 * ⚠️ AND DO NOT "FIX" THE COST HERE. A projection cache, a high-water-`seq`
 * memo, or anything else that avoids the replay is §15.4's materialized read
 * model — that is **#286**, and a private incremental fold in the plugin is a
 * second implementation of the reducer, which is N8.
 */
import type { DifferenceReply } from "./channel-contract.js";
import type { DeliveryJournal } from "./delivery-journal.js";
import { fitHistoryFrame, type SkippedHistoryRow } from "./history-frame-budget.js";
import type { HistoryConfig, HistoryMessage } from "./history.js";
import { planHistoryFetch } from "./history.js";
import { serveHistoryRequest, type ServedHistory } from "./journal-history.js";
import { logSafe } from "./log-safe.js";
import type { NatsChannel } from "./nats-channel.js";
// #244 half B: a `difference` carries RAW journal events, typed by the client
// reducer's `DurableEvent` (`JournalEvent`'s alias). TYPE-ONLY, erased.
import type { DurableEvent } from "../../client/src/durable-view-reducer.js";

/**
 * The exact channel surface this module reaches. `Pick` over the real class, the
 * same device `RegisterChannelSurface` uses, so removing `sendHistory` from
 * `NatsChannel` is a compile error at this contract rather than a runtime break.
 *
 * #311 widened it by the two MEASUREMENT members — the sealed size of a frame
 * for this peer, and the peer's effective `max_payload`. Both were already
 * public methods on the class; nothing new is exposed. They are what
 * `history-frame-budget.ts` needs and deliberately does not import for itself.
 */
export type HistoryChannelSurface = Pick<
  NatsChannel,
  "sendHistory" | "sendDifference" | "outboundWireSize" | "effectiveOutboundLimit"
>;

/**
 * #244 half B — the ceiling on how many RAW events one `difference` response
 * carries. It bounds the READ (`delivery-journal.read`'s `limit`); the real bound
 * on the wire is the BYTE budget applied in `fitDifference` below. A gap is
 * normally a handful of dropped frames, so this rarely binds — and when it does,
 * the reply says so (`partial: true`) and the client re-requests from where it got
 * to, so a capped response costs a round-trip, never data (doc §16.2-6, §16.7).
 *
 * ⚠️ #356: the READ ASKS FOR ONE MORE THAN THIS. That extra row is never sent; it
 * is how "the journal holds more than one reply can carry" becomes an observed
 * fact rather than an inference from a full page.
 */
export const MAX_DIFFERENCE_EVENTS = 500;

/** One raw catch-up entry: a journal row's `seq` and its event, folded client-side. */
export type DifferenceEntry = { seq: number; event: DurableEvent };

/** #356 — the request one `difference` answers, echoed back on the reply. */
type DifferenceRequest = { afterSeq: number; nonce: string };

/**
 * #343 — a difference row that alone exceeds this peer's wire, with the size
 * that proved it. The `history` twin is `SkippedHistoryRow`; this one is keyed by
 * `seq` because a difference addresses rows by seq, not by projected id.
 */
type SkippedDifferenceRow = { seq: number; bytes: number };

type FittedDifference = {
  /** The events to publish: an order-preserving subsequence, oldest first. */
  entries: DifferenceEntry[];
  /** Rows that can NEVER be sent to this peer. Operator-actionable. */
  skipped: SkippedDifferenceRow[];
  /**
   * How many NEWER events the byte budget left out. Not data loss: the reply
   * carries `partial: true` and the client re-requests from where it got to.
   */
  trimmed: number;
};

/** Minimal logger shape — matches OpenClaw's optional-method logger. */
export type HistoryServerLogger = {
  error?: (message: string) => void;
  warn?: (message: string) => void;
};

export type HistoryServerDeps = {
  /**
   * ⚠️ NON-OPTIONAL, AND THAT IS THE POINT. "A failed journal open fails the
   * account start" used to be asserted in a comment claiming TypeScript's
   * definite-assignment analysis proved it. That claim was FALSE — MEASURED: a
   * `let journal: DeliveryJournal` never assigned on any path typechecks clean,
   * because every read of it was inside a closure and TS suppresses DA analysis
   * there. Making it a required constructor parameter, with the server built
   * inside the same `try` as the open, expresses the impossibility as an
   * ordinary parameter type — a fact the compiler actually checks.
   */
  journal: DeliveryJournal;
  channel: HistoryChannelSurface;
  config: HistoryConfig;
  logger?: HistoryServerLogger;
  /**
   * How deferred work is scheduled. Defaults to `setImmediate`; injected so
   * tests can prove the deferral (nothing runs on the calling turn) rather than
   * racing it.
   */
  schedule?: (fn: () => void) => void;
  /** Injectable clock for the drop-warning throttle. */
  now?: () => number;
};

export type HistoryServer = {
  /**
   * Fire the register-time snapshot for a just-registered peer.
   *
   * ⚠️ RETURNS WITHOUT DOING THE WORK, AND `nats-register.ts` DEPENDS ON THAT.
   * It is called BEFORE the register `reply(...)` is published, and the
   * projection is a synchronous full replay (~1.45–1.51 s at 20 000 events,
   * #286's two runs), so folding inline would stall the handshake reply for
   * every long conversation.
   */
  sendSnapshot(peerId: string): void;
  /**
   * Serve one `load_history` request. Same deferral, different reason — below.
   *
   * `beforeTurnId` completes the cursor for a tool row and is optional on the
   * wire; see `channel-contract.ts`'s `load_history` member.
   */
  servePage(
    peerId: string,
    request: { before?: string; beforeTurnId?: string; limit?: number },
  ): void;
  /**
   * #244 half B / #356 — answer a `get_difference(afterSeq, nonce)`: read this
   * peer's journal for `seq > afterSeq`, byte-fit the RAW events, and
   * `sendDifference` with `afterSeq`/`nonce` echoed plus `partial`/`maxSeq`.
   *
   * ⚠️ RAW EVENTS, NO REDUCER. Unlike `sendSnapshot`/`servePage` this does NOT
   * call `serveHistoryRequest`/`projectJournalHistory` — the #286 quadratic
   * replay — because the client already holds the folded view and folds the
   * difference onto it. This is the whole reason half B is #286-free.
   *
   * ⚠️ DEFERRED AND LATCHED PER PEER (#348), which is a REVERSAL of what this
   * docblock used to say. "Not deferred: the read is a single bounded indexed
   * read, O(limit) rows, no fold" was true of the READ and never covered the
   * BYTE FIT, which is a sequence of `sealEnvelope` calls on the same turn — and
   * with nothing latching this path an authenticated peer could loop
   * `get_difference{afterSeq:0}` and hold the account's dispatch. It is now
   * `schedule`d like the other two, with a per-peer latch that COALESCES rather
   * than drops (the implementation argues why the two differ).
   *
   * ⚠️ A READ FAULT SENDS NOTHING, and that is safe only because the client
   * self-heals: it arms a timeout on its outstanding request, re-issues with a
   * fresh nonce, and gives up into a re-detect. Sending an empty frame instead
   * would carry `partial: false` and a `maxSeq`, i.e. "you are synced" — falsely
   * advancing the client past the range it is missing. An EMPTY-SUCCESSFUL read
   * is a different thing and IS answered, which is what unwinds a spurious
   * detection without waiting on that timeout.
   */
  serveDifference(peerId: string, afterSeq: number, nonce: string): void;
};

/**
 * What a diagnostic is about. Closed set; one throttle entry per (kind, reason).
 *
 * #356 added `difference`. Before it, `serveDifference`'s two `error` lines went
 * straight to the logger and bypassed `admit` entirely — the one failure path in
 * this file exempt from the throttle the header says every failure path must use,
 * and the most peer-drivable of them (#343). It is a `ServeKind` now for the same
 * reason the other two are: a corrupt journal or a disposed account makes the read
 * throw immediately, so an unthrottled line is one per event-loop turn forever.
 */
type ServeKind = "snapshot" | "page" | "difference";
type DiagnosticReason =
  | "dropped"
  | "read-failed"
  | "publish-failed"
  | "unsupported-events"
  | "ts-fallbacks"
  | "oversize-skipped"
  | "budget-trimmed";

const SERVE_KINDS: readonly ServeKind[] = ["snapshot", "page", "difference"];
/**
 * ⚠️ EVERY MEMBER OF `DiagnosticReason` MUST APPEAR HERE. This array is what
 * seeds the `diagnostics` map, and `admit` reads that map with a non-null
 * assertion precisely because a miss is impossible — see its docblock. Adding a
 * reason to the union and not to this list turns the first diagnostic of that
 * kind into a `TypeError` inside a scheduled callback.
 */
const DIAGNOSTIC_REASONS: readonly DiagnosticReason[] = [
  "dropped",
  "read-failed",
  "publish-failed",
  "unsupported-events",
  "ts-fallbacks",
  "oversize-skipped",
  "budget-trimmed",
];

/**
 * How many skipped row ids one `oversize-skipped` line names before it counts
 * the rest. The line is throttled to one per minute, but a page can nominate up
 * to `MAX_WIRE_HISTORY_LIMIT` rows at once and an unbounded log line is its own
 * incident.
 */
const MAX_SKIPPED_IDS_LOGGED = 5;

/** `id (N B), id (N B) +K more` — one bounded string, built off the log call. */
function summarizeSkippedRows(skipped: readonly SkippedHistoryRow[]): string {
  const named = skipped
    .slice(0, MAX_SKIPPED_IDS_LOGGED)
    .map((row) => `${row.id} (${row.bytes} B)`)
    .join(", ");
  const rest = skipped.length - MAX_SKIPPED_IDS_LOGGED;
  return rest > 0 ? `${named} +${rest} more` : named;
}

/** `seq N (M B), seq N (M B) +K more` — the `difference` twin of the above. */
function summarizeSkippedDifferenceRows(skipped: readonly SkippedDifferenceRow[]): string {
  const named = skipped
    .slice(0, MAX_SKIPPED_IDS_LOGGED)
    .map((row) => `seq ${row.seq} (${row.bytes} B)`)
    .join(", ");
  const rest = skipped.length - MAX_SKIPPED_IDS_LOGGED;
  return rest > 0 ? `${named} +${rest} more` : named;
}

/**
 * Same 60 s window the two sibling throttles in this package use
 * (`nats-channel.ts`'s `warnDeliveryJournal`, `ingress-outcome.ts`'s
 * `createRateLimitedOutcomeFailureWarning`).
 */
const DIAGNOSTIC_INTERVAL_MS = 60_000;

export function createHistoryServer(deps: HistoryServerDeps): HistoryServer {
  const { journal, channel, config, logger } = deps;
  const schedule = deps.schedule ?? ((fn: () => void) => void setImmediate(fn));
  const now = deps.now ?? Date.now;

  // ⚠️ SEPARATE SETS. See the file header: a snapshot dropped because a PAGE is
  // folding would cost a reconnecting tab its TAIL, which no retry recovers.
  const snapshotsInFlight = new Set<string>();
  const pagesInFlight = new Set<string>();
  /**
   * #356 — the per-peer `get_difference` latch. Present ⇒ a read is scheduled for
   * this peer and has not run yet; the VALUE is the newest request, which is what
   * that run will answer. A `Map`, not a `Set`, because coalescing to the latest
   * floor is the whole point (`serveDifference` argues it).
   */
  const pendingDifferences = new Map<string, DifferenceRequest>();

  // ⚠️ THE THROTTLE IS THE HOUSE SHAPE, RE-INSTANTIATED, NOT `warnDeliveryJournal`
  // EXPORTED — and that is a deliberate answer, not an oversight. That method is
  // private to `NatsChannel`, typed to the `DeliveryJournalWarning` category
  // union, and hard-codes a message body ("this frame has no durable row, the
  // send result is unchanged") that is false about every line below. Exporting
  // it would mean exporting all three. What is genuinely shared across the call
  // sites in this package is the SHAPE — `{lastAt, suppressed}` per category,
  // one line per window, carrying `suppressed=N` into the next — and that is
  // what is reproduced here. `ingress-outcome.ts` made the same call for the
  // same reason.
  //
  // ⚠️ EVERY category is throttled, the failure ones included. They are all
  // peer-driven and all sustained: with a corrupt journal or a disposed account
  // the read throws IMMEDIATELY, so the latch releases on the same turn and an
  // unthrottled `error` is one line per event-loop turn, indefinitely. That is
  // the exact flood `journal-history.ts` argues a limiter is mandatory for; an
  // exemption for the failure path would be the asymmetry, not the throttle.
  const diagnostics = new Map<string, { lastAt: number; suppressed: number }>();
  for (const kind of SERVE_KINDS) {
    for (const reason of DIAGNOSTIC_REASONS) {
      diagnostics.set(`${kind}:${reason}`, {
        lastAt: Number.NEGATIVE_INFINITY,
        suppressed: 0,
      });
    }
  }

  /**
   * May this (kind, reason) speak now? Returns the number of lines swallowed
   * since it last did, or `undefined` when the window is still open.
   *
   * ⚠️ IT RETURNS A COUNT RATHER THAN TAKING THE MESSAGE, AND THAT SHAPE IS
   * LOAD-BEARING FOR THE #123 AUDIT — not a style choice. An earlier revision
   * took a `build: (suppressed) => string` callback and called the sink itself.
   * MEASURED, and state the two numbers separately because they are different
   * quantities: the file contained FOUR log statements at that moment, and the
   * scanner reported ZERO. The floor test surfaced it as `{2,7} → {0,0}`
   * because 2/7 was the stored baseline from before this slice added the third
   * and fourth lines. Cause: the scanner recognises a template literal passed
   * AS AN ARGUMENT to a log callee, and a template built inside a callback is
   * invisible to it — not exempt,
   * INVISIBLE, the same trap `ingress-dedupe.ts`'s KNOWN_RAW block documents
   * ("an exemption a reader can see and falsify beats a statement the audit
   * never looks at"). Keeping the interpolation at the `logger.error?.(…)` call
   * site is what keeps every peer value in these lines under the audit. The
   * moving coverage floor is what caught it.
   */
  const admit = (kind: ServeKind, reason: DiagnosticReason): number | undefined => {
    // ⚠️ NON-NULL, NOT A GUARD. Every `kind:reason` pair is pre-seeded above from
    // two closed unions, so a miss is impossible; the earlier `if (!entry)
    // return undefined` was unreachable AND failed open — it would have silently
    // swallowed the diagnostic on the one path that could ever reach it. An
    // unreachable guard that fails open is worse than none: if a future edit
    // does desynchronise the seeding from the unions, a `TypeError` naming this
    // line beats a history server that has quietly stopped reporting.
    const entry = diagnostics.get(`${kind}:${reason}`)!;
    const at = now();
    if (at - entry.lastAt < DIAGNOSTIC_INTERVAL_MS) {
      // No clamp: an earlier version wrapped this in
      // `Math.min(…, Number.MAX_SAFE_INTEGER)`, which can never bind — at that
      // magnitude `x + 1 === x`, so the counter saturates on its own. A dead
      // guard reads as a considered bound and is worse than the plain increment.
      entry.suppressed += 1;
      return undefined;
    }
    const suppressed = entry.suppressed;
    entry.lastAt = at;
    entry.suppressed = 0;
    return suppressed;
  };

  /**
   * ⚠️ THE ONE THING THAT MAKES A SUCCESSFUL EMPTY READ HONEST.
   *
   * `unsupportedEvents > 0` means rows this build cannot fold were skipped, so
   * the projection is NOT authoritative — `journal-history.ts` says exactly that
   * about the counter. The case that matters is a ROLLBACK after #241 widens the
   * event union: every row becomes an unknown kind, the projection is `[]`, the
   * snapshot's `length > 0` gate suppresses the frame, and without this line the
   * peer sees a brand-new empty conversation with nothing logged anywhere. That
   * is the same silent-empty impersonation the failed-read path is forbidden to
   * produce, arriving through the successful-read door.
   *
   * `error`, not `warn`, for that reason: a history that silently omits the
   * user's own messages is a defect, not a hiccup.
   */
  const reportProjectionHealth = (
    kind: ServeKind,
    peerId: string,
    served: ServedHistory,
  ): void => {
    if (served.unsupportedEvents > 0) {
      const suppressed = admit(kind, "unsupported-events");
      if (suppressed !== undefined) {
        try {
          logger?.error?.(
            `webchannel: history ${kind} projection is NOT authoritative for ` +
              `${logSafe(peerId)}; skipped ${served.unsupportedEvents} journal ` +
              `event(s) this build cannot fold — history may be missing messages ` +
              `(suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not take down the read */ }
      }
    }
    // ⚠️ `warn`, WHERE THE COUNTER ABOVE IS `error`, AND THE ASYMMETRY IS THE
    // ARGUMENT. An unsupported event means CONTENT IS MISSING from the history
    // this build just served. A `ts` fallback means a message that IS present
    // got its timestamp from the last row read rather than from the row that
    // introduced its id — and `journal-history.ts` establishes at length that
    // `ts` is hydration metadata that nothing orders on, so the blast radius is
    // a timestamp reading early. Both say "this build is behind the journal";
    // only one says the user is being shown less than they said.
    //
    // Reachable the same way: #241 adds a fifth kind carrying an id,
    // `recordFirstSeen`'s exhaustiveness check forces it to be handled — but if
    // it were ever bypassed, every id that kind introduces falls through to the
    // fallback and this is what says so.
    if (served.tsFallbacks > 0) {
      const suppressed = admit(kind, "ts-fallbacks");
      if (suppressed !== undefined) {
        try {
          logger?.warn?.(
            `webchannel: history ${kind} dated ${served.tsFallbacks} message(s) ` +
              `for ${logSafe(peerId)} from a fallback rather than a first ` +
              `appearance — timestamps may read early (suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not take down the read */ }
      }
    }
  };

  /**
   * ⚠️ THE ONE PLACE A `history` FRAME REACHES THE WIRE (#311).
   *
   * Both emit callbacks go through here so that the byte budget, the two
   * diagnostics it produces, and the publish-failure report cannot drift apart
   * between the snapshot path and the page path — which is exactly how the
   * `false` return below came to be dropped at TWO call sites rather than one.
   *
   * WHAT CHANGED, AND WHY IT IS SAFE TO SHORTEN A PAGE. Before this, an
   * oversized frame was not truncated — `nats-transport.ts`'s `publish` threw a
   * `RangeError`, `nats-channel.ts`'s `sendToPeer` caught it and returned
   * `false`, and both call sites here ignored that value. The peer received NO
   * frame, on every reconnect, silently. Shortening from the OLD end costs zero
   * reach because this module's other entry point IS the pager: the dropped
   * rows are exactly what the next `load_history` returns.
   *
   * ⚠️ AND THE `false` IS NO LONGER DISCARDED. A refused frame is reported under
   * the SAME `publish-failed` reason as a thrown one, deliberately: it is one
   * operator-visible event ("this peer did not get its history"), and giving it
   * a second vocabulary would mean an operator has to know both to grep for it.
   */
  const publishFitted = (
    kind: ServeKind,
    peerId: string,
    messages: HistoryMessage[],
    // #244 half A: `highWaterSeq` is the conversation's MAX(seq) baseline. The
    // SNAPSHOT path passes it; the PAGE path leaves it `undefined` (a page serves
    // older rows and carries no high-water). Both the wire frame and the byte
    // measurement below include it so the budget accounts for the extra field.
    options: { sendEmpty: boolean; highWaterSeq?: number },
  ): void => {
    const limit = channel.effectiveOutboundLimit();
    const fitted = fitHistoryFrame(messages, {
      limit,
      // The SEALED length — what `publish` compares against the limit. On an
      // encrypted channel with no session key yet this returns `undefined`, and
      // `fitHistoryFrame` treats that as "do not budget" rather than falling
      // back to a plaintext estimate, because the send is about to be refused
      // fail-closed for the same missing key.
      measure: (rows) =>
        channel.outboundWireSize(peerId, {
          type: "history",
          messages: rows,
          ...(options.highWaterSeq !== undefined ? { highWaterSeq: options.highWaterSeq } : {}),
        }),
    });

    if (fitted.skipped.length > 0) {
      const suppressed = admit(kind, "oversize-skipped");
      if (suppressed !== undefined) {
        // `error`, and it is the right level: content exists in this peer's
        // store that can NEVER be delivered to it at this `max_payload`. It is
        // also the one line that tells an operator WHICH rows, so raising the
        // server's `max_payload` (or #299 retention) has a target.
        const detail = summarizeSkippedRows(fitted.skipped);
        try {
          logger?.error?.(
            `webchannel: history ${kind} skipped ${fitted.skipped.length} ` +
              `undeliverable row(s) for ${logSafe(peerId)}; each one alone ` +
              `exceeds this peer's effective max_payload of ${limit} bytes and ` +
              `can never be sent, live or replayed (#311): ${logSafe(detail)} ` +
              `(suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not escape this callback */ }
      }
    }

    if (fitted.trimmed > 0) {
      const suppressed = admit(kind, "budget-trimmed");
      if (suppressed !== undefined) {
        // ⚠️ `warn`, AND THE WORDING MATTERS AS MUCH AS THE LEVEL. This is NOT
        // data loss and must not read as it: the rows left out are the OLDEST
        // in the window and the pager reaches every one of them. An operator
        // who reads this as "history is being deleted" will go looking for a
        // corruption that is not there.
        try {
          logger?.warn?.(
            `webchannel: history ${kind} for ${logSafe(peerId)} was shortened ` +
              `to fit the peer's effective max_payload of ${limit} bytes: ` +
              `${fitted.trimmed} older row(s) left out of this page and still ` +
              `reachable with load_history (suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not escape this callback */ }
      }
    }

    // An empty SNAPSHOT is nothing to hydrate and is suppressed, exactly as it
    // was before the budget existed. An empty PAGE is still an answer.
    //
    // ⚠️ HONEST RESIDUAL: a page whose every row was skipped as undeliverable
    // arrives as an empty page, which a client reads as end-of-history rather
    // than as "this window cannot be shown". There is no wire signal for the
    // latter — **#296** owns adding one — so the `error` above is where that
    // fact lives today.
    if (fitted.rows.length === 0 && !options.sendEmpty) return;

    if (!channel.sendHistory(peerId, fitted.rows, options.highWaterSeq)) {
      const suppressed = admit(kind, "publish-failed");
      if (suppressed !== undefined) {
        try {
          logger?.error?.(
            `webchannel: history ${kind} publish failed for ${logSafe(peerId)}: ` +
              `the channel refused a ${fitted.rows.length}-row frame; see the ` +
              `channel log for the cause (suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not escape this callback */ }
      }
    }
  };

  /**
   * The one deferred body both entry points share.
   *
   * `produce` returns `undefined` to mean "answer nothing at all" — the read
   * failed, and no `history` frame may be sent (see the header). `emit` decides
   * what a successful answer does with its messages, because the two kinds
   * differ there: a snapshot with nothing to say sends no frame, while an empty
   * page is still an answer.
   */
  const runDeferred = (
    kind: ServeKind,
    inFlight: Set<string>,
    peerId: string,
    produce: () => HistoryMessage[],
    emit: (messages: HistoryMessage[]) => void,
  ): void => {
    if (inFlight.has(peerId)) {
      const suppressed = admit(kind, "dropped");
      if (suppressed !== undefined) {
        // ⚠️ THE `try` IS LOAD-BEARING HERE, NOT DEFENSIVE HABIT. This is the
        // ONLY diagnostic that runs SYNCHRONOUSLY on the caller's turn, and
        // `nats-register.ts` calls `sendSnapshot` from inside the `try` whose
        // `catch` replies `REGISTER_FAILED` — so without this, a host with a
        // throwing `logger.warn` would refuse a registration because we tried to
        // mention that the peer was already connecting. The deleted `history.ts`
        // wrapped every diagnostic for exactly this reason ("Diagnostics must
        // not take down this best-effort history read"); that precedent did not
        // survive the extraction and is restored here and at the four sites
        // below, which are inside scheduled callbacks where an escape would be
        // an `uncaughtException` instead.
        try {
          logger?.warn?.(
            `webchannel: history ${kind} dropped for ${logSafe(peerId)}; a ` +
              `${kind} replay for this peer is already in flight ` +
              `(suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not fail the register */ }
      }
      return;
    }
    inFlight.add(peerId);
    schedule(() => {
      // ⚠️ THE READ IS INSIDE THE `try`; THE PUBLISH IS NOT. An earlier revision
      // ran `emit` inside it, so a throw out of `channel.sendHistory` — reachable,
      // see `nats-channel.ts`'s publish path — was logged as "journal read
      // failed", pointing an operator at a database that was fine. Two try
      // blocks, two labels, and neither may escape: nothing is left on the stack
      // to catch a throw here, so an escape is an `uncaughtException`.
      //
      // ⚠️ SINCE #311 THE `emit` SIDE ALSO RUNS THE BYTE BUDGET, so "publish
      // failed" now labels a throw out of `publishFitted` as well — which means
      // a throw out of `channel.outboundWireSize` (i.e. `sealEnvelope`) as much
      // as one out of `sendHistory`. The label is still accurate: both are the
      // send half of this callback, both mean the peer got no frame, and
      // neither is a journal fault. What the label does NOT cover is a REFUSED
      // send, which never throws — that is reported inside `publishFitted`
      // under the same `publish-failed` reason.
      let messages: HistoryMessage[] | undefined;
      try {
        messages = produce();
      } catch (err) {
        const suppressed = admit(kind, "read-failed");
        if (suppressed !== undefined) {
          try {
            logger?.error?.(
              `webchannel: history ${kind} journal read failed for ` +
                `${logSafe(peerId)}: ${logSafe(err)} (suppressed=${suppressed})`,
            );
          } catch { /* a faulting logger must not escape this callback */ }
        }
      } finally {
        // In the `finally` so a throw cannot latch the peer out of its own
        // history for the life of the process.
        inFlight.delete(peerId);
      }
      if (messages === undefined) return;
      try {
        emit(messages);
      } catch (err) {
        const suppressed = admit(kind, "publish-failed");
        if (suppressed !== undefined) {
          try {
            logger?.error?.(
              `webchannel: history ${kind} publish failed for ${logSafe(peerId)}: ` +
                `${logSafe(err)} (suppressed=${suppressed})`,
            );
          } catch { /* a faulting logger must not escape this callback */ }
        }
      }
    });
  };

  /**
   * #244 half B / #356 — trim a difference to the peer's wire, keeping the
   * OLDEST prefix and SKIPPING any row that cannot be sent to this peer at all.
   *
   * ⚠️ THE OPPOSITE END FROM `fitHistoryFrame`, ON PURPOSE. A history page keeps
   * the NEWEST rows because the pager reaches the older ones. A difference must
   * keep the OLDEST because the client advances its cursor through the range it
   * receives and re-requests from there: dropping the tail is re-requestable
   * (that is what `partial` says), dropping the head would strand a permanent
   * hole below the new cursor. Order is never permuted.
   *
   * ⚠️ AND THAT IS THE ONLY DIFFERENCE FROM `history-frame-budget.ts`. This is
   * the same algorithm — one measurement fast path, then a bisection for the
   * largest fitting run with a single blocker measurement deciding "skip it" vs
   * "the budget ran out here" — mirrored for a prefix rather than a suffix. It
   * is mirrored rather than shared because that module is typed to
   * `HistoryMessage` and its bisection walks from the other end; generalising it
   * over both would put the history path's behaviour behind a parameter for one
   * caller. Keep the two in step: a fix to the shape belongs in both.
   *
   * ⚠️ WHY IT REPLACED A ONE-ROW-PER-STEP SHRINK, MEASURED IN CALLS. `sizeOf` is
   * `outboundWireSize` → a full `sealEnvelope` of the candidate (serialize +
   * encrypt). The previous loop re-sealed the whole prefix once per removed row:
   * O(n²) seals, up to ~125 000 of them for a 500-row page that overflows, run
   * on the account's dispatch turn (#348). The bisection is ~13 for the same
   * page — `history-serve.test.ts` counts them.
   *
   * ⚠️ AND WHY THE SKIP IS NOT N8. The old bottom-out was `entries.slice(0, 1)`:
   * hand the single oversize row to `sendDifference`, which refuses it, and the
   * device gets NOTHING — every retry, for the whole session (#343). The
   * docblock justifying that ("each event was already delivered LIVE … so a
   * single event always fits") was false in both directions, and
   * `history-frame-budget.ts` exists because such rows are demonstrably in the
   * store: `nats-channel.ts` journals BEFORE it publishes, so a row too big for
   * this wire is there PRECISELY BECAUSE its own live send hit the same
   * `RangeError`. The peer never saw it live, so omitting it PRESERVES
   * `live == history` — showing it is what would break it. The skipped seq is
   * inside the served range, so the client advances past it (see the `difference`
   * member of `OutboundWsMessage`); it does NOT make the reply `partial`, because
   * nothing is left to re-request.
   *
   * ⚠️ MEASURED WITH `partial: false`. The flag is decided by this function's
   * result, so it cannot be known while measuring; `false` is the longer JSON
   * literal, so the frame that ships is never larger than what was budgeted.
   */
  const fitDifference = (
    peerId: string,
    envelope: { afterSeq: number; nonce: string; maxSeq: number },
    entries: DifferenceEntry[],
  ): FittedDifference => {
    const unchanged = (): FittedDifference => ({ entries, skipped: [], trimmed: 0 });
    if (entries.length === 0) return unchanged();
    const limit = channel.effectiveOutboundLimit();
    // An unusable limit means "no bound known" — send as-is and let the channel
    // decide, the same idiom `fitHistoryFrame` uses.
    if (!Number.isSafeInteger(limit) || limit < 0) return unchanged();
    const sizeOf = (rows: DifferenceEntry[]): number | undefined => {
      const bytes = channel.outboundWireSize(peerId, {
        type: "difference",
        afterSeq: envelope.afterSeq,
        nonce: envelope.nonce,
        events: rows,
        partial: false,
        maxSeq: envelope.maxSeq,
      });
      return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0
        ? bytes
        : undefined;
    };

    // ── 1. THE FAST PATH: one measurement, and the reply is on its way. ──
    const whole = sizeOf(entries);
    // No session key yet: the send is about to fail-closed for the same reason,
    // so there is nothing to budget. Hand it on unchanged.
    if (whole === undefined) return unchanged();
    if (whole <= limit) return unchanged();

    // If not even an empty frame fits, no subset does — hand it on and let the
    // publish fail loudly rather than impersonating "nothing to send".
    const emptyFrame = sizeOf([]);
    if (emptyFrame === undefined || emptyFrame > limit) return unchanged();

    const skipped: SkippedDifferenceRow[] = [];
    // Rebound, never spliced: `sizeOf` hands this array to `outboundWireSize`
    // inside a frame object, so mutating it in place would edit an array a
    // caller may still hold (`history-frame-budget.ts` records how that was
    // caught).
    let survivors: DifferenceEntry[] = [...entries];
    // Each pass either returns or removes exactly one row, so the pass count is
    // bounded by the row count — written as a `for` so the termination argument
    // is checkable at the syntax.
    for (let pass = 0; pass <= entries.length; pass++) {
      if (survivors.length === 0) return { entries: [], skipped, trimmed: 0 };

      const survivingWhole = sizeOf(survivors);
      if (survivingWhole === undefined) return unchanged();
      // Dropping an undeliverable row on an earlier pass may have been enough on
      // its own.
      if (survivingWhole <= limit) return { entries: [...survivors], skipped, trimmed: 0 };

      // Largest fitting PREFIX, by bisection. Sealed size is monotone in row
      // count, so the predicate is monotone and the search is exact. `lo` fits
      // (the empty frame was checked above), `hi` does not (`survivingWhole`).
      let lo = 0;
      let hi = survivors.length;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        const bytes = sizeOf(survivors.slice(0, mid));
        if (bytes === undefined) return unchanged();
        if (bytes <= limit) lo = mid;
        else hi = mid;
      }

      // THE BLOCKER — the row immediately AFTER the largest fitting prefix, i.e.
      // the one that stopped the search. This single measurement decides between
      // the two outcomes, which is why no separate pass is needed to find
      // undeliverable rows: the blocker either cannot fit ALONE (skip it and
      // search again, so the reply spans across it) or it is simply where the
      // budget ran out. `lo === 0` — nothing fits at all — makes the blocker the
      // OLDEST row, which is the same rule reaching the same place.
      const blocker = survivors[lo]!;
      const blockerBytes = sizeOf([blocker]);
      if (blockerBytes === undefined) return unchanged();
      if (blockerBytes > limit) {
        skipped.push({ seq: blocker.seq, bytes: blockerBytes });
        survivors = [...survivors.slice(0, lo), ...survivors.slice(lo + 1)];
        continue;
      }

      return {
        entries: survivors.slice(0, lo),
        skipped,
        trimmed: survivors.length - lo,
      };
    }

    // Unreachable: every pass returns or shortens `survivors`, and the pass
    // bound is the row count. Kept as a total function rather than a `throw` —
    // a difference read must not become an `uncaughtException` inside the
    // scheduled callback.
    return { entries: [], skipped, trimmed: survivors.length };
  };

  /**
   * Byte-fit one difference, report what the budget did, and publish it.
   *
   * `capped` is the OTHER half of `partial`: the read asked for
   * `MAX_DIFFERENCE_EVENTS + 1` rows precisely so that "there are more rows than
   * one reply may carry" is a fact rather than an inference.
   */
  const publishDifference = (
    peerId: string,
    request: DifferenceRequest,
    produced: { entries: DifferenceEntry[]; capped: boolean; maxSeq: number },
  ): void => {
    const limit = channel.effectiveOutboundLimit();
    const windowMax = produced.entries.at(-1)?.seq ?? request.afterSeq;
    const fitted = fitDifference(
      peerId,
      {
        afterSeq: request.afterSeq,
        nonce: request.nonce,
        // ⚠️ THE UPPER BOUND ON `coveredThrough`, NOT THE VALUE — which is not
        // known yet, because it depends on what this fit decides. Every branch
        // below yields at most `max(windowMax, journal high-water)`, so measuring
        // with that can only OVERSTATE the frame by a digit or two, never
        // understate it. (`partial` is measured as `false` for the same reason:
        // it is the longer JSON literal.)
        maxSeq: Math.max(windowMax, produced.maxSeq),
      },
      produced.entries,
    );

    if (fitted.skipped.length > 0) {
      const suppressed = admit("difference", "oversize-skipped");
      if (suppressed !== undefined) {
        // `error`, and the same level and reason the history budget's skip uses:
        // content exists in this peer's store that can NEVER be delivered to it
        // at this `max_payload`, and this is the one line naming WHICH rows.
        const detail = summarizeSkippedDifferenceRows(fitted.skipped);
        try {
          logger?.error?.(
            `webchannel: difference skipped ${fitted.skipped.length} undeliverable ` +
              `row(s) for ${logSafe(peerId)}; each one alone exceeds this peer's ` +
              `effective max_payload of ${limit} bytes and can never be sent, live ` +
              `or replayed (#311/#343): ${logSafe(detail)} (suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not escape this callback */ }
      }
    }

    if (fitted.trimmed > 0) {
      const suppressed = admit("difference", "budget-trimmed");
      if (suppressed !== undefined) {
        // `warn`, NOT `error`, and the wording matters as much as the level: the
        // rows left out are the NEWEST of the requested range and the reply says
        // so (`partial: true`), so the client re-requests them on the spot. This
        // is a round-trip, not data loss.
        try {
          logger?.warn?.(
            `webchannel: difference for ${logSafe(peerId)} was shortened to fit the ` +
              `peer's effective max_payload of ${limit} bytes: ${fitted.trimmed} ` +
              `newer event(s) left for the next request (partial=true) ` +
              `(suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not escape this callback */ }
      }
    }

    // Telegram's `difference` vs `differenceSlice`: TRUE iff rows exist beyond
    // what this reply accounts for. A row the budget SKIPPED does not count — it
    // is undeliverable, not deferred, and re-requesting it would wedge the device
    // on it forever.
    const partial = produced.capped || fitted.trimmed > 0;
    // ⚠️ `maxSeq` IS "THE HIGHEST SEQ THIS REPLY ACCOUNTS FOR", AND ON A PARTIAL
    // REPLY THAT IS NOT THE JOURNAL'S HIGH-WATER. The client advances to it and
    // re-requests from there, so it MUST be strictly above `afterSeq` whenever
    // `partial` is set or the pair loops forever on the same floor. Three cases,
    // and the middle one is the one that would otherwise loop:
    //  - rows were TRIMMED for bytes: coverage stops at the last event actually
    //    served (a row skipped ABOVE that point is not covered and is simply
    //    re-examined on the next request);
    //  - nothing was trimmed: every row the read returned is either in `events`
    //    or was skipped as undeliverable, so the whole WINDOW is accounted for —
    //    including the degenerate window whose every row was undeliverable, which
    //    ships zero events and must still move the client past them;
    //  - and when the read was not capped either, the window reached the end, so
    //    the journal's own high-water (read BEFORE the rows) applies too.
    const coveredThrough =
      fitted.trimmed > 0
        ? (fitted.entries.at(-1)?.seq ?? request.afterSeq)
        : produced.capped
          ? windowMax
          : Math.max(windowMax, produced.maxSeq);

    const reply: DifferenceReply = {
      afterSeq: request.afterSeq,
      nonce: request.nonce,
      events: fitted.entries,
      partial,
      maxSeq: coveredThrough,
    };
    if (!channel.sendDifference?.(peerId, reply)) {
      const suppressed = admit("difference", "publish-failed");
      if (suppressed !== undefined) {
        try {
          logger?.error?.(
            `webchannel: difference publish failed for ${logSafe(peerId)}: the ` +
              `channel refused a ${fitted.entries.length}-event frame; see the ` +
              `channel log (suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not escape this callback */ }
      }
    }
  };

  /**
   * The deferred body of one `get_difference`, run against the LATEST request
   * this peer made before the turn yielded (see `serveDifference`).
   */
  const runDifference = (peerId: string, request: DifferenceRequest): void => {
    let produced: { entries: DifferenceEntry[]; capped: boolean; maxSeq: number };
    try {
      // ⚠️ HIGH-WATER FIRST, ROWS SECOND, AND THE ORDER IS A SAFETY PROPERTY —
      // not tidiness. A non-`partial` reply tells the client "you are synced up
      // to `maxSeq`", and the client sets its cursor there. Reading `maxSeq`
      // AFTER the rows would let a row appended between the two reads raise
      // `maxSeq` above anything this reply carries: the client would advance
      // past that row, and the live frame carrying it would then be discarded as
      // already-applied. Reading it FIRST can only make `maxSeq` LOWER than the
      // range served, which the client absorbs (it takes the max of the two).
      const maxSeq = journal.maxSeq(peerId);
      // RAW read: `read` already filters `seq > afterSeq` and orders by seq
      // ascending. NO reducer, NO projection — the whole point (doc §16.2-6):
      // the client folds these onto the view it already holds.
      //
      // `+ 1` IS THE PARTIAL PROBE. Reading one row past the cap is how "the
      // journal holds more than this reply can carry" becomes an observed fact;
      // the extra row is never sent.
      const rows = journal.read(peerId, {
        afterSeq: request.afterSeq,
        limit: MAX_DIFFERENCE_EVENTS + 1,
      });
      produced = {
        maxSeq,
        capped: rows.length > MAX_DIFFERENCE_EVENTS,
        // The row's event is `RetainedJournalEvent` — a newer build's row may
        // carry a kind this build does not know (#253). It is shipped VERBATIM:
        // the CLIENT skips an unknown kind while still advancing its cursor past
        // it (as `projectJournalHistory` does with `unsupportedEvents`), so
        // filtering here would strand the cursor below an unknown tail and
        // re-request forever.
        entries: rows
          .slice(0, MAX_DIFFERENCE_EVENTS)
          .map((row) => ({ seq: row.seq, event: row.event as DurableEvent })),
      };
    } catch (err) {
      // READ FAULT: log and send NOTHING. This does NOT unwind the client — an
      // unanswered request is recovered by the client's in-flight TIMEOUT
      // (`nats-client-wrapper.ts`), which re-issues with a fresh nonce and then
      // gives up into a re-detect. Sending an empty frame here would be worse
      // than silence: `partial: false` + a `maxSeq` would falsely advance the
      // client PAST the range it is still missing.
      const suppressed = admit("difference", "read-failed");
      if (suppressed !== undefined) {
        try {
          logger?.error?.(
            `webchannel: difference read failed for ${logSafe(peerId)} ` +
              `(afterSeq=${request.afterSeq}): ${logSafe(err)} ` +
              `(suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not escape this callback */ }
      }
      return;
    }
    // An EMPTY-SUCCESSFUL read (afterSeq already current) is a DIFFERENT case
    // from the fault above and IS answered, with an empty non-`partial`
    // difference carrying `maxSeq`. That frame is what unwinds a spurious or
    // raced detection immediately instead of at the client's timeout.
    publishDifference(peerId, request, produced);
  };

  return {
    serveDifference(peerId: string, afterSeq: number, nonce: string): void {
      // ⚠️ ONE OUTSTANDING READ PER PEER, COALESCING TO THE LATEST — the latch
      // the other two read paths have (`runDeferred`), with the one behavioural
      // change the request/reply shape allows. `runDeferred` DROPS a second
      // request because a snapshot and a page each answer a question that is
      // still true; a `get_difference` names a FLOOR, and a later floor strictly
      // supersedes an earlier one from the same device (its cursor only moves
      // forward). So a burst collapses into one read that answers the newest
      // `(afterSeq, nonce)`.
      //
      // ⚠️ AND THE SUPERSEDED NONCES GET NO REPLY, WHICH IS SAFE ONLY BECAUSE OF
      // THE ECHO. A device folds a `difference` only when BOTH `afterSeq` and
      // `nonce` match its own outstanding request (#351), so a device whose
      // request was coalesced away simply sees a frame that is not its own,
      // ignores it, and re-issues on its 5 s timeout with a fresh nonce. That is
      // the same recovery a dropped request already has on this at-most-once
      // transport. What it must NOT do is answer the OLDEST floor, which would
      // re-send a range a newer request already implies.
      //
      // ⚠️ DEFERRED NOW, WHERE THIS PATH USED TO RUN INLINE. The latch only means
      // anything if there is a window in which a request can be outstanding, and
      // the byte-fit is no longer free (a bisection of `sealEnvelope` calls). The
      // client is unaffected: it waits on a timeout, not on the dispatch turn.
      const alreadyScheduled = pendingDifferences.has(peerId);
      pendingDifferences.set(peerId, { afterSeq, nonce });
      if (alreadyScheduled) {
        const suppressed = admit("difference", "dropped");
        if (suppressed !== undefined) {
          try {
            logger?.warn?.(
              `webchannel: difference request for ${logSafe(peerId)} coalesced into ` +
                `the one already scheduled; the reply will answer the newest ` +
                `afterSeq and the superseded request re-issues on its own timeout ` +
                `(suppressed=${suppressed})`,
            );
          } catch { /* a faulting logger must not fail the dispatch turn */ }
        }
        return;
      }
      schedule(() => {
        const request = pendingDifferences.get(peerId);
        // Clear BEFORE the read so a request arriving after this callback
        // schedules its own run rather than being swallowed by a latch nothing
        // will release. The body below is synchronous, so nothing can interleave
        // between the delete and the publish.
        pendingDifferences.delete(peerId);
        if (request === undefined) return;
        runDifference(peerId, request);
      });
    },

    sendSnapshot(peerId: string): void {
      // #244 half A: the conversation's high-water `seq` at snapshot time,
      // captured in `produce` (inside the read guard) and stamped onto the
      // `history` frame in `emit`. `maxSeq` is a single MAX(seq) index read, NOT
      // a fold — so it does NOT reintroduce the §15.4 materialized read model the
      // header warns against (that ban is about AVOIDING the replay; this stands
      // alongside the fold `serveHistoryRequest` still performs).
      let highWaterSeq: number | undefined;
      runDeferred(
        "snapshot",
        snapshotsInFlight,
        peerId,
        () => {
          // UNBOUNDED on purpose — but NOT because #286 licenses it. #286's
          // first disjunct is "ship the snapshot path ONLY" (i.e. do not ship
          // the pager); it says nothing about the snapshot's own depth, and this
          // slice shipped the pager anyway, so neither disjunct is met (header).
          // The reason depth is not gated HERE is the product one: a truncated
          // snapshot is a wrong chat, not a slow one. The residual that leaves
          // is #298.
          const served = serveHistoryRequest(journal.read, peerId, {
            kind: "recent",
            limit: config.limit,
          });
          reportProjectionHealth("snapshot", peerId, served);
          // Read the high-water inside the guard: a throw here is a read failure
          // like any other and must suppress the frame, not ship a snapshot with
          // a wrong baseline.
          highWaterSeq = journal.maxSeq(peerId);
          return served.messages;
        },
        (messages) => {
          // Kept as `> 0`, not "always send": an empty snapshot is nothing to
          // hydrate. Safe to suppress ONLY because `reportProjectionHealth`
          // above has already spoken if the emptiness was manufactured by rows
          // this build could not read.
          if (messages.length > 0) {
            publishFitted("snapshot", peerId, messages, { sendEmpty: false, highWaterSeq });
          }
        },
      );
    },

    servePage(
      peerId: string,
      request: { before?: string; beforeTurnId?: string; limit?: number },
    ): void {
      // PURE, so it stays on the dispatch turn: `planHistoryFetch` validates the
      // wire `limit` (the NATS receive door's decoder checks only that it is a
      // number or absent — #246 half A — and forwards every other question
      // here: range, finiteness, flooring) and picks paginate-vs-tail from
      // `before`, carrying `beforeTurnId` into
      // the page plan. It cannot throw and it does not touch the store.
      const plan = planHistoryFetch(request, config.pageSize);
      // ⚠️ DEFERRED FOR A DIFFERENT REASON THAN THE SNAPSHOT — name which one.
      // Nothing is racing this handler (a `load_history` answer is an ordinary
      // publish, not a request/reply), so no reply is being unblocked. What the
      // deferral buys is that the fold does not run ON the inbound dispatch
      // turn.
      runDeferred(
        "page",
        pagesInFlight,
        peerId,
        () => {
          // ⚠️ UNBOUNDED IN DEPTH — see the header. Every page is a full replay
          // of the whole conversation, so this is the expensive path and nothing
          // gates it but the in-flight latch above. A pre-fold length gate was
          // built and reverted (it destroys reach rather than limiting it); the
          // fix is #286's materialized read model, not a cheaper check here.
          const served = serveHistoryRequest(journal.read, peerId, plan);
          reportProjectionHealth("page", peerId, served);
          return served.messages;
        },
        (messages) => {
          // Always sent, empty included. For OUR client an empty `history` frame
          // is a no-op (`nats-client-wrapper.ts`'s `case "history"` returns
          // early on a zero-length list, and `loadHistory` keeps no pending
          // state to clear), so this does not "stop it asking" — it simply
          // changes nothing, which is the honest outcome. For a third-party
          // client that does track a request, an empty page is the end-of-history
          // answer. Sending nothing would be worse for both.
          publishFitted("page", peerId, messages, { sendEmpty: true });
        },
      );
    },
  };
}
