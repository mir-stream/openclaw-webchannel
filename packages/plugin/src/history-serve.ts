/**
 * Serve journal-owned snapshots/pages and raw ordered difference events.
 * The file is account-scoped; conversationId is the authenticated raw peer ID.
 *
 * Snapshots/pages catch up the rebuildable SQLite model in bounded scheduled
 * transactions, then select indexed rows in canonical reducer order. The two
 * in-flight latches remain held across every yield. They bound concurrent work
 * per peer/kind; they impose no history depth limit or request-rate policy.
 *
 * A snapshot's high-water comes from the same transaction as its selected rows.
 * Byte fitting may mark it incomplete so client recovery starts from the proper
 * prefix. Difference still reads the raw journal and retains the existing
 * individually oversized-event skip policy (#343).
 *
 * Read/projection faults log and emit no frame; a successful empty result is
 * distinct from failure. There is no transcript fallback or empty-success catch.
 */
import type { DifferenceReply } from "./channel-contract.js";
import type { DeliveryJournal } from "./delivery-journal.js";
import { fitHistoryFrame, type SkippedHistoryRow } from "./history-frame-budget.js";
import type { HistoryConfig, HistoryMessage } from "./history.js";
import { planHistoryFetch } from "./history.js";
import { serveHistoryRequestStep, type ServedHistory } from "./journal-history.js";
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
 * #356 — how many `get_difference` requests one peer may have QUEUED, on top of
 * the one being served. Past it, a new request displaces the newest queued one.
 * (Before the first run there is nothing being served, so the queue alone is the
 * whole outstanding set; during a run it is this many plus that one.)
 *
 * The queue is per PEER, and a peer is an account's whole DEVICE SET — there is
 * no per-device registry, so this is the only place a device count can be
 * expressed at all. A conforming device has at most ONE request outstanding (its
 * cursor holds one nonce), so this is a device bound, and it is deliberately the
 * same number `PopChallengeStore` allows for live nonces per peer
 * (`DEFAULT_MAX_NONCES_PER_PEER = 8`) — the existing answer in this codebase to
 * "how many of one peer's devices does the plugin keep state for at once".
 */
const MAX_QUEUED_DIFFERENCE_REQUESTS = 8;

/**
 * #343 — a difference row that alone exceeds this peer's wire, with the size
 * that proved it. The `history` twin is `SkippedHistoryRow`; this one is keyed by
 * `seq` because a difference addresses rows by seq, not by projected id.
 */
type SkippedDifferenceRow = { seq: number; bytes: number };

type FittedDifference = {
  /** The exact reply measured by the fitter, ready to publish unchanged. */
  reply: DifferenceReply;
  /** Rows that cannot fit alone in their difference envelope. */
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
   * ⚠️ DEFERRED AND QUEUED PER PEER (#348), which is a REVERSAL of what this
   * docblock used to say. "Not deferred: the read is a single bounded indexed
   * read, O(limit) rows, no fold" was true of the READ and never covered the
   * BYTE FIT, which is a sequence of `sealEnvelope` calls on the same turn — and
   * with nothing bounding this path an authenticated peer could loop
   * `get_difference{afterSeq:0}` and hold the account's dispatch. It is now
   * `schedule`d like the other two, with a bounded per-peer QUEUE rather than
   * their drop-a-concurrent-request latch: a difference names a floor and a
   * nonce, so dropping one leaves a device waiting on its timeout. What is
   * bounded is CONCURRENCY (one read+publish in flight) and DEPTH
   * (`MAX_QUEUED_DIFFERENCE_REQUESTS`), not rate — see the file header, which
   * says the same of the other two.
   *
   * ⚠️ BOTH HALVES ARE GUARDED, AND THE DEFERRAL IS WHY THAT MATTERS MORE THAN
   * IT USED TO. A read fault and a publish fault are caught separately, under
   * their own labels; nothing escapes the scheduled callback, because out there
   * an escape is an `uncaughtException`, not a dropped frame.
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
   * #356 — the per-peer `get_difference` queue. Present ⇒ this peer has a read
   * scheduled or running; the array holds the requests still to answer, oldest
   * first. A QUEUE rather than one slot because every request must get its own
   * reply — `serveDifference` argues why, and `MAX_QUEUED_DIFFERENCE_REQUESTS`
   * is what keeps it from becoming a backlog.
   */
  const pendingDifferences = new Map<string, DifferenceRequest[]>();

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
          ...(options.highWaterSeq !== undefined ? {
            highWaterSeq: options.highWaterSeq, snapshotComplete: rows.length === messages.length,
          } : {}),
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
    if (fitted.rows.length === 0 && !options.sendEmpty && options.highWaterSeq === undefined) return;

    if (!channel.sendHistory(peerId, fitted.rows, options.highWaterSeq,
      options.highWaterSeq === undefined ? undefined : fitted.rows.length === messages.length)) {
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

  /** Keep the latch through catch-up yields; release it on success or failure. */
  const runDeferred = (
    kind: ServeKind,
    inFlight: Set<string>,
    peerId: string,
    produce: () => HistoryMessage[] | { pending: true },
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
    const run = () => {
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
      let pending = false;
      try {
        const produced = produce();
        if (Array.isArray(produced)) messages = produced;
        else pending = true;
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
        if (!pending) inFlight.delete(peerId);
      }
      if (pending) { schedule(run); return; }
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
    };
    schedule(run);
  };

  /**
   * Keep the oldest fitting prefix, skipping only individually oversized rows.
   * Each size check uses the partial/maxSeq coverage that reply would publish:
   * conservative high-water metadata may falsely classify a fitting row as lost.
   * One per-row pass plus one bisection bounds measurements without re-running a
   * prefix search for every skipped row (#343/#348).
   */
  const fitDifference = (
    peerId: string,
    request: DifferenceRequest,
    produced: { entries: DifferenceEntry[]; capped: boolean; maxSeq: number },
  ): FittedDifference => {
    const { entries } = produced;
    const windowMax = entries.at(-1)?.seq ?? request.afterSeq;
    // Covering less than the physical window leaves a partial reply even when
    // every remaining row was oversized. Completing the window also covers the
    // journal high-water, unless the read found rows beyond its cap.
    const makeReply = (events: DifferenceEntry[], coveredThrough = windowMax): DifferenceReply => {
      const partial = produced.capped || coveredThrough < windowMax;
      return {
        afterSeq: request.afterSeq,
        nonce: request.nonce,
        events,
        partial,
        maxSeq: partial ? coveredThrough : Math.max(windowMax, produced.maxSeq),
      };
    };
    const wholeReply = makeReply(entries);
    const unchanged = (): FittedDifference => ({ reply: wholeReply, skipped: [], trimmed: 0 });
    if (entries.length === 0) return unchanged();
    const limit = channel.effectiveOutboundLimit();
    if (!Number.isSafeInteger(limit) || limit < 0) return unchanged();
    const sizeOf = (reply: DifferenceReply): number | undefined => {
      const bytes = channel.outboundWireSize(peerId, { type: "difference", ...reply });
      return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0
        ? bytes
        : undefined;
    };

    const wholeBytes = sizeOf(wholeReply);
    if (wholeBytes === undefined || wholeBytes <= limit) return unchanged();
    // If even an empty coverage reply cannot fit, leave failure to the channel.
    const emptyReply = makeReply([]);
    const emptyBytes = sizeOf(emptyReply);
    if (emptyBytes === undefined || emptyBytes > limit) return unchanged();

    const skipped: SkippedDifferenceRow[] = [];
    const survivors: DifferenceEntry[] = [];
    for (const entry of entries) {
      // A singleton can end at its own seq while physical rows remain. Its
      // terminal counterpart must include completion/high-water metadata.
      const bytes = sizeOf(makeReply([entry], entry.seq));
      if (bytes === undefined) return unchanged();
      if (bytes > limit) skipped.push({ seq: entry.seq, bytes });
      else survivors.push(entry);
    }
    if (survivors.length === 0) return { reply: emptyReply, skipped, trimmed: 0 };

    const survivingWhole = makeReply(survivors);
    const survivingBytes = sizeOf(survivingWhole);
    if (survivingBytes === undefined) return unchanged();
    if (survivingBytes <= limit) return { reply: survivingWhole, skipped, trimmed: 0 };

    // The first singleton was proven to fit. Search through ALL survivors:
    // their own last seq may fit even when covering a skipped tail does not.
    let lo = 1;
    let hi = survivors.length + 1;
    let reply = makeReply([survivors[0]!], survivors[0]!.seq);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const candidate = makeReply(survivors.slice(0, mid), survivors[mid - 1]!.seq);
      const bytes = sizeOf(candidate);
      if (bytes === undefined) return unchanged();
      if (bytes <= limit) {
        lo = mid;
        reply = candidate;
      } else {
        hi = mid;
      }
    }
    return { reply, skipped, trimmed: survivors.length - lo };
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
    const fitted = fitDifference(peerId, request, produced);

    if (fitted.skipped.length > 0) {
      const suppressed = admit("difference", "oversize-skipped");
      if (suppressed !== undefined) {
        // `error`, and the same level and reason the history budget's skip uses:
        // content in this peer's store is omitted from this difference because
        // it exceeds the budget, and this line names WHICH rows.
        const detail = summarizeSkippedDifferenceRows(fitted.skipped);
        try {
          logger?.error?.(
            `webchannel: difference skipped ${fitted.skipped.length} oversized ` +
              `row(s) for ${logSafe(peerId)}; each one alone in a difference exceeds ` +
              `this peer's effective max_payload of ${limit} bytes ` +
              `(#311/#343): ${logSafe(detail)} (suppressed=${suppressed})`,
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

    const { reply } = fitted;
    if (!channel.sendDifference?.(peerId, reply)) {
      const suppressed = admit("difference", "publish-failed");
      if (suppressed !== undefined) {
        try {
          logger?.error?.(
            `webchannel: difference publish failed for ${logSafe(peerId)}: the ` +
              `channel refused a ${reply.events.length}-event frame; see the ` +
              `channel log (suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not escape this callback */ }
      }
    }
  };

  /**
   * Serve the HEAD of this peer's queue on a fresh turn, then schedule the next
   * if any remain. The entry is held for the whole read+publish, so a peer never
   * has two of either in flight. Retained requests run in FIFO order, subject to
   * the queue's overflow replacement rule.
   */
  const scheduleNextDifference = (peerId: string): void => {
    schedule(() => {
      const queue = pendingDifferences.get(peerId);
      const request = queue?.shift();
      if (queue === undefined || request === undefined) {
        pendingDifferences.delete(peerId);
        return;
      }
      try {
        runDifference(peerId, request);
      } finally {
        // `queue` is the LIVE array, so requests that arrived during the run are
        // retained in it for subsequent turns, subject to the queue bound.
        //
        // ⚠️ THE `finally` IS UNREACHABLE DEFENCE TODAY, AND NO TEST PINS IT —
        // say so rather than implying otherwise. `runDifference` guards its read
        // and its publish separately and every diagnostic inside them is itself
        // wrapped, so there is no path by which it throws; deleting the `finally`
        // leaves this file's tests green (measured). It is kept because the cost
        // of being wrong is the peer latched out of its own catch-up for the life
        // of the process, and because `runDeferred` releases its in-flight set
        // the same way for the same reason. What IS pinned is the reachable
        // half — a failed publish releasing the queue.
        if (queue.length > 0) scheduleNextDifference(peerId);
        else pendingDifferences.delete(peerId);
      }
    });
  };

  /**
   * The deferred body of ONE `get_difference`, for one queued request.
   */
  const runDifference = (peerId: string, request: DifferenceRequest): void => {
    let produced: { entries: DifferenceEntry[]; capped: boolean; maxSeq: number };
    try {
      // High-water first, rows second. NOT a race guard — both are synchronous
      // `better-sqlite3` calls inside one function body with no `await`, so
      // nothing can interleave between them and either order is equally atomic.
      // The order is kept because it reads in the direction the values are used:
      // the baseline, then the window measured against it.
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
    //
    // ⚠️ THE PUBLISH HALF NEEDS ITS OWN `try`, AND #356 IS WHAT MADE THAT TRUE.
    // Two try blocks, two labels, exactly as `runDeferred` splits them, and for
    // the same reason: a throw out of `channel.outboundWireSize` (i.e.
    // `sealEnvelope`) or out of `channel.sendDifference` is the SEND half
    // failing, not a journal fault, and labelling it "read failed" points an
    // operator at a database that is fine.
    //
    // But the STAKES changed here, which is why it is not merely tidy. On
    // develop this body ran INLINE on the inbound dispatch turn, inside
    // `nats-transport.ts`'s `safeEmitFor` catch, so a throw cost one dropped
    // frame. This slice moved it into a `schedule(...)` callback, where nothing
    // is left on the stack to catch anything: an escape is an
    // `uncaughtException` and the gateway process goes down. Both routes are
    // real — `JSON.stringify` of a 500-row page can raise `RangeError: Invalid
    // string length` on the very population `fitDifference` exists for, and
    // `sendToPeer`'s fail-closed diagnostic sits outside its own `try`.
    try {
      publishDifference(peerId, request, produced);
    } catch (err) {
      // The SAME `publish-failed` reason a REFUSED send reports, deliberately:
      // it is one operator-visible event ("this peer did not get its
      // difference"), and giving a thrown one its own vocabulary would mean an
      // operator has to know both to grep for it.
      const suppressed = admit("difference", "publish-failed");
      if (suppressed !== undefined) {
        try {
          logger?.error?.(
            `webchannel: difference publish failed for ${logSafe(peerId)} ` +
              `(afterSeq=${request.afterSeq}): ${logSafe(err)} ` +
              `(suppressed=${suppressed})`,
          );
        } catch { /* a faulting logger must not escape this callback */ }
      }
    }
  };

  return {
    serveDifference(peerId: string, afterSeq: number, nonce: string): void {
      // ONE READ+PUBLISH IN FLIGHT PER PEER, WITH A BOUNDED FIFO QUEUE.
      // The other two read paths latch per peer and DROP a concurrent request
      // (`runDeferred`), which is right for them: a snapshot and a page each
      // answer a question that is still true when the survivor lands, so the
      // dropped caller loses nothing. A `get_difference` is not like that. It
      // names a FLOOR and carries a `nonce`, and the reply is addressed to that
      // pair — so a dropped request is a device left waiting on its 5 s timeout.
      //
      // ⚠️ AND COALESCING TO THE NEWEST IS THE SAME BUG WEARING A BETTER NAME.
      // The configuration this feature exists for is N devices of one account on
      // ONE shared `.out` subject (#245 Part B). They gap on the SAME dropped
      // broadcast, in the same instant, from different floors. Newest-wins would
      // answer one and silence N−1 — and, because their timers were armed
      // together, their retries re-collide in lockstep: 4 rounds of 5 s each,
      // then a give-up, for every device but one. The queue retains concurrent
      // requests up to the bound described below.
      //
      // ⚠️ WHAT THIS BOUNDS IS CONCURRENCY AND DEPTH, NOT RATE — the same thing
      // the file header says about the other two latches, and it is worth
      // repeating because an earlier revision of this comment claimed a rate
      // bound it did not have. A peer that issues one request per event-loop
      // turn still gets one read per turn (so does `load_history` on develop).
      // What cannot happen is two reads or two publishes at once, or an
      // unbounded backlog: past `MAX_QUEUED_DIFFERENCE_REQUESTS` the newest
      // request displaces the newest queued one.
      const queued = pendingDifferences.get(peerId);
      if (queued !== undefined) {
        if (queued.length >= MAX_QUEUED_DIFFERENCE_REQUESTS) {
          // The NEWEST queued entry is the one replaced: a later floor from the
          // same device supersedes its own earlier one, while dropping from the
          // HEAD would spend the budget answering stale floors. Everything else
          // already queued still gets its reply, and the displaced device
          // re-issues on its own timeout.
          queued[queued.length - 1] = { afterSeq, nonce };
          const suppressed = admit("difference", "dropped");
          if (suppressed !== undefined) {
            try {
              logger?.warn?.(
                `webchannel: difference request for ${logSafe(peerId)} displaced the ` +
                  `newest of ${MAX_QUEUED_DIFFERENCE_REQUESTS} already queued for this ` +
                  `peer; the displaced request re-issues on its own timeout ` +
                  `(suppressed=${suppressed})`,
              );
            } catch { /* a faulting logger must not fail the dispatch turn */ }
          }
          return;
        }
        queued.push({ afterSeq, nonce });
        return;
      }
      pendingDifferences.set(peerId, [{ afterSeq, nonce }]);
      scheduleNextDifference(peerId);
    },

    sendSnapshot(peerId: string): void {
      let highWaterSeq: number | undefined;
      let targetSeq: number | undefined;
      runDeferred(
        "snapshot",
        snapshotsInFlight,
        peerId,
        () => {
          const served = serveHistoryRequestStep(journal, peerId, {
            kind: "recent", limit: config.limit,
          }, targetSeq);
          if (served.pending) { targetSeq = served.targetSeq; return served; }
          reportProjectionHealth("snapshot", peerId, served);
          // This high-water and these rows share one SQLite snapshot, including
          // when another handle advanced beyond our original finite target.
          highWaterSeq = served.highWaterSeq;
          return served.messages;
        },
        (messages) => {
          // An empty conversation still supplies its baseline. If byte fitting
          // removes content, snapshotComplete=false prevents false cold seeding.
          publishFitted("snapshot", peerId, messages, { sendEmpty: true, highWaterSeq });
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
      let targetSeq: number | undefined;
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
          const served = serveHistoryRequestStep(journal, peerId, plan, targetSeq);
          if (served.pending) { targetSeq = served.targetSeq; return served; }
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
