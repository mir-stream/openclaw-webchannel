/**
 * v6 delivery-render — THE LIVE HISTORY READ PATH (issue #240 half 2, doc §15.6).
 *
 * Both things a peer can ask for — the register-time snapshot and a
 * `load_history` page — are the same three steps: pick a plan, replay this
 * peer's journal through the shared reducer (`journal-history.ts`), publish the
 * result. This module owns those two bodies so that `nats-account-runtime.ts`
 * is left holding wiring and no policy.
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
 * `{kind:"recent", limit: config.limit}` and `DEFAULT_HISTORY_CONFIG.limit` is
 * 50, so every snapshot IS windowed to the newest 50 messages. What must not be
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
import type { HistoryConfig, HistoryMessage } from "./history.js";
import { planHistoryFetch } from "./history.js";
import { serveHistoryRequest, type ServedHistory } from "./journal-history.js";
import { logSafe } from "./log-safe.js";
import type { NatsChannel } from "./nats-channel.js";

/**
 * The exact channel surface this module reaches. `Pick` over the real class, the
 * same device `RegisterChannelSurface` uses, so removing `sendHistory` from
 * `NatsChannel` is a compile error at this contract rather than a runtime break.
 */
export type HistoryChannelSurface = Pick<NatsChannel, "sendHistory">;

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
  /** Serve one `load_history` request. Same deferral, different reason — below. */
  servePage(peerId: string, request: { before?: string; limit?: number }): void;
};

/** What a diagnostic is about. Closed set; one throttle entry per (kind, reason). */
type ServeKind = "snapshot" | "page";
type DiagnosticReason =
  | "dropped"
  | "read-failed"
  | "publish-failed"
  | "unsupported-events"
  | "ts-fallbacks";

const SERVE_KINDS: readonly ServeKind[] = ["snapshot", "page"];
const DIAGNOSTIC_REASONS: readonly DiagnosticReason[] = [
  "dropped",
  "read-failed",
  "publish-failed",
  "unsupported-events",
  "ts-fallbacks",
];

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

  return {
    sendSnapshot(peerId: string): void {
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
          return served.messages;
        },
        (messages) => {
          // Kept as `> 0`, not "always send": an empty snapshot is nothing to
          // hydrate. Safe to suppress ONLY because `reportProjectionHealth`
          // above has already spoken if the emptiness was manufactured by rows
          // this build could not read.
          if (messages.length > 0) channel.sendHistory(peerId, messages);
        },
      );
    },

    servePage(peerId: string, request: { before?: string; limit?: number }): void {
      // PURE, so it stays on the dispatch turn: `planHistoryFetch` validates the
      // wire `limit` (the NATS dispatch forwards `message.limit` unvalidated)
      // and picks paginate-vs-tail from `before`. It cannot throw and it does
      // not touch the store.
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
          channel.sendHistory(peerId, messages);
        },
      );
    },
  };
}
