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
 * the client advances to the max seq it received and re-requests for the rest, so
 * a capped response costs a round-trip, never data (doc §16.2-6).
 */
export const MAX_DIFFERENCE_EVENTS = 500;

/** One raw catch-up entry: a journal row's `seq` and its event, folded client-side. */
export type DifferenceEntry = { seq: number; event: DurableEvent };

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
   * #244 half B — answer a `get_difference(afterSeq)`: read this peer's journal
   * for `seq > afterSeq`, byte-fit the RAW events, and `sendDifference`.
   *
   * ⚠️ RAW EVENTS, NO REDUCER. Unlike `sendSnapshot`/`servePage` this does NOT
   * call `serveHistoryRequest`/`projectJournalHistory` — the #286 quadratic
   * replay — because the client already holds the folded view and folds the
   * difference onto it. This is the whole reason half B is #286-free.
   *
   * ⚠️ NOT DEFERRED. The read is a single bounded, indexed `read(afterSeq, limit)`
   * — O(limit) rows, no fold — so unlike the two projection paths it stays on the
   * dispatch turn (the same choice `servePage`'s docblock defends the OTHER way
   * for the fold). It is wrapped in a try/catch: a read fault logs and sends
   * NOTHING — never an empty frame, which would falsely advance the client's
   * cursor past the range it is missing.
   *
   * ⚠️ SENDING NOTHING ON A FAULT IS SAFE ONLY BECAUSE THE CLIENT SELF-HEALS. The
   * request went unanswered; there is no server- or client-side path here that
   * "eventually retries" on its own. The client arms a TIMEOUT on its in-flight
   * `get_difference` (`nats-client-wrapper.ts`) and re-issues it when no
   * `difference` arrives — that timer, not any buffered-frame mechanism, is what
   * recovers a dropped request/reply or a read fault. An EMPTY-SUCCESSFUL read is
   * a different thing and IS still answered (an empty `difference`), so an
   * already-current `afterSeq` unwinds cleanly rather than waiting on the timeout.
   */
  serveDifference(peerId: string, afterSeq: number): void;
};

/** What a diagnostic is about. Closed set; one throttle entry per (kind, reason). */
type ServeKind = "snapshot" | "page";
type DiagnosticReason =
  | "dropped"
  | "read-failed"
  | "publish-failed"
  | "unsupported-events"
  | "ts-fallbacks"
  | "oversize-skipped"
  | "budget-trimmed";

const SERVE_KINDS: readonly ServeKind[] = ["snapshot", "page"];
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
   * #244 half B — trim a difference to the peer's wire, keeping the OLDEST
   * contiguous prefix (lowest seqs).
   *
   * ⚠️ THE OPPOSITE END FROM `fitHistoryFrame`, ON PURPOSE. A history page keeps
   * the NEWEST rows because the pager reaches the older ones. A difference must
   * keep the OLDEST because the client advances its cursor to the max seq it
   * receives and re-requests from there: dropping the tail is re-requestable,
   * dropping the head would strand a permanent hole below the new cursor. Order is
   * never permuted.
   *
   * Each event was already delivered LIVE as its own frame that fit this wire, so
   * a single event always fits and the kept prefix is non-empty whenever the input
   * is — which is what guarantees the client makes FORWARD PROGRESS rather than
   * stalling on a `difference` the channel would refuse.
   */
  const fitDifference = (peerId: string, entries: DifferenceEntry[]): DifferenceEntry[] => {
    if (entries.length === 0) return entries;
    const limit = channel.effectiveOutboundLimit();
    // An unusable limit means "no bound known" — send as-is and let the channel
    // decide, the same idiom `fitHistoryFrame` uses.
    if (!Number.isSafeInteger(limit) || limit < 0) return entries;
    const sizeOf = (rows: DifferenceEntry[]): number | undefined =>
      channel.outboundWireSize(peerId, { type: "difference", events: rows });
    const whole = sizeOf(entries);
    // No session key yet: the send is about to fail-closed for the same reason, so
    // there is nothing to budget. Hand it on unchanged.
    if (whole === undefined) return entries;
    if (whole <= limit) return entries;
    // Oversize: keep the largest fitting PREFIX. Bounded by row count and only
    // paid by a response that would otherwise be refused whole.
    let hi = entries.length;
    while (hi > 1) {
      const prefix = entries.slice(0, hi - 1);
      const size = sizeOf(prefix);
      hi -= 1;
      if (size !== undefined && size <= limit) return prefix;
    }
    // One event and it still does not fit (the #311 undeliverable case, and it was
    // deliverable live so this is near-impossible). Hand it on; the channel refuses
    // it loudly rather than this function impersonating "no events to send".
    return entries.slice(0, 1);
  };

  const publishDifference = (peerId: string, entries: DifferenceEntry[]): void => {
    const fitted = fitDifference(peerId, entries);
    if (!channel.sendDifference?.(peerId, fitted)) {
      try {
        logger?.error?.(
          `webchannel: difference publish failed for ${logSafe(peerId)}: the ` +
            `channel refused a ${fitted.length}-event frame; see the channel log`,
        );
      } catch { /* a faulting logger must not escape the dispatch turn */ }
    }
  };

  return {
    serveDifference(peerId: string, afterSeq: number): void {
      let entries: DifferenceEntry[];
      try {
        // RAW read: `read` already filters `seq > afterSeq` and orders by seq
        // ascending. NO reducer, NO projection — the whole point (doc §16.2-6):
        // the client folds these onto the view it already holds.
        const rows = journal.read(peerId, { afterSeq, limit: MAX_DIFFERENCE_EVENTS });
        // The row's event is `RetainedJournalEvent` — a newer build's row may carry
        // a kind this build does not know (#253). It is shipped VERBATIM: the
        // CLIENT skips an unknown kind while still advancing its cursor past it (as
        // `projectJournalHistory` does with `unsupportedEvents`), so filtering here
        // would strand the cursor below an unknown tail and re-request forever.
        entries = rows.map((row) => ({ seq: row.seq, event: row.event as DurableEvent }));
      } catch (err) {
        // READ FAULT: log and send NOTHING. This does NOT unwind the client — an
        // unanswered request is recovered by the client's in-flight TIMEOUT
        // (`nats-client-wrapper.ts`), which re-issues and then re-detects. Sending
        // an empty frame here would be worse than silence: it would falsely advance
        // the client PAST the range it is still missing.
        try {
          logger?.error?.(
            `webchannel: difference read failed for ${logSafe(peerId)} ` +
              `(afterSeq=${afterSeq}): ${logSafe(err)}`,
          );
        } catch { /* a faulting logger must not escape the dispatch turn */ }
        return;
      }
      // EMPTY-SUCCESSFUL read (afterSeq already current) — a DIFFERENT case from the
      // fault above, and it IS answered: an empty `difference`. The client's
      // `case "difference"` no-ops the fold and drains its buffer, unwinding a
      // spurious/raced detection without waiting on its timeout. Sending nothing
      // here would leave a client that DID buffer stuck until that timeout fires.
      publishDifference(peerId, entries);
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
