/**
 * History WIRE TYPE + CONFIG + REQUEST PLAN. No I/O, no store, no reader.
 *
 * ⚠️ THIS FILE USED TO BE THE HISTORY READ PATH AND NO LONGER IS. Until #240
 * half 2 it read core's agent transcript through
 * `api.runtime.subagent`'s session-message read, normalized raw model output,
 * ran it through a sanitizer, and paged it by fetching a window and slicing.
 * That is
 * NOT-list N2 — the plugin is the SSOT and serves history from its OWN store —
 * so the whole reader was deleted along with `history-sanitize.ts` and the
 * `AsyncResource` operator-scope detour it needed to authorize the self-read.
 *
 * The replacement is `journal-history.ts`: it replays the CLIENT's reducer over
 * the plugin's delivery journal, so `history == live` holds by construction
 * rather than because two implementations happen to agree. If you are looking
 * for "where does history come from", it is there, and `serveHistoryRequest` is
 * the seam both call sites use. Those call sites live in `history-serve.ts`
 * (`sendSnapshot` and `servePage`); `nats-account-runtime.ts` only wires them.
 *
 * What is left here is what has no store dependency and is shared by both
 * paths — the wire type the `history` frame carries, the operator config block,
 * and the pure wire→plan mapping. Do not grow a reader back into this file.
 */
import type { HistoryMessage as WireHistoryMessage } from "./channel-contract.js";

/**
 * History messages that travel on the wire and live in client state.
 *
 * ⚠️ RE-EXPORTED, NOT RE-DECLARED (#305). This file used to carry its OWN
 * `HistoryMessage` — `{id, role, text, ts}` with `ts` REQUIRED — beside
 * `channel-contract.ts`'s `{id, role, text, ts?}`. Two independent declarations
 * of one wire type, already drifted on `ts`, which made every widening a
 * two-file change and every reader's "which one is this?" a real question. The
 * wire shape belongs to `channel-contract.ts`; the only thing this module adds
 * is the PROJECTION's stronger `ts` guarantee, expressed below as a DERIVED
 * type so tsc checks the relationship instead of a comment asserting it.
 *
 * Mirrored on the client side as `ChatMessage` in `packages/client/src/types.ts`
 * — which #242 half 2 made a tagged union for the same reason this one is.
 *
 * `ts` is HYDRATION METADATA — a server-recorded millisecond timestamp so a
 * rehydrated bubble can show when it was said. ⚠️ IT IS NOT AN ORDERING KEY, and
 * an earlier version of this docblock claiming the widget "can sort by recency"
 * was stale: MEASURED, there is no `.sort(`/`.toSorted(` in any non-test file
 * under `packages/client/src`, nor in the widget tree at `demo/web/src/` where
 * `presentation.ts` and `app.ts` actually render the list. Order comes from the
 * array, which `journal-history.ts` takes verbatim from the shared reducer — and
 * that order is deliberately NON-MONOTONE in `ts` (a `seal` may permute answer
 * slots after their placements were dated), so sorting on this field would
 * override the reducer and reintroduce N8. Local sends (a user typing in the
 * widget) keep `ts` absent; the widget assigns one on receive, but the field is
 * wire-shaped.
 */
export type {
  HistoryMessage,
  HistoryReasoningMessage,
  HistoryTextMessage,
  HistoryToolMessage,
} from "./channel-contract.js";

/**
 * What `journal-history.ts` PRODUCES: a wire row whose `ts` is always present.
 *
 * ⚠️ DERIVED FROM THE WIRE TYPE, NEVER RESTATED. `Required<Pick<…, "ts">>` is
 * what makes this a CHECKED relationship: rename or drop `ts` on the wire and
 * this line fails to compile, instead of silently becoming a second, drifting
 * declaration — which is exactly what #305 was.
 *
 * The intersection distributes over the union, so `kind === "reasoning"` still
 * narrows a `ProjectedHistoryMessage` the same way it narrows the wire type.
 *
 * WHY THE PROJECTION IS STRONGER THAN THE WIRE. `projectJournalHistory` sources
 * a `ts` for every row it emits (the `created_ms` of the row whose event first
 * names that id, or the documented fallback), so the value is never absent on
 * the way out. The WIRE stays optional because it also describes rows this
 * package does not produce — an older plugin's, and the shape a client is
 * allowed to receive.
 */
export type ProjectedHistoryMessage = WireHistoryMessage &
  Required<Pick<WireHistoryMessage, "ts">>;

/** Resolved `channels.webchannel.history` config block. */
export type HistoryConfig = {
  limit: number;
  pageSize: number;
};

export const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
  limit: 50,
  pageSize: 50,
};

/**
 * Read the `channels.webchannel.history` config block. Defaults fill in any
 * missing / malformed sub-keys (operators can omit `history` entirely and get
 * the documented default behaviour).
 */
export function resolveHistoryConfig(channelConfig: unknown): HistoryConfig {
  const section = channelConfig as { history?: Partial<HistoryConfig> } | undefined;
  const raw = section?.history ?? {};
  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit) && raw.limit > 0
      ? Math.floor(raw.limit)
      : DEFAULT_HISTORY_CONFIG.limit;
  const pageSize =
    typeof raw.pageSize === "number" &&
    Number.isFinite(raw.pageSize) &&
    raw.pageSize > 0
      ? Math.floor(raw.pageSize)
      : DEFAULT_HISTORY_CONFIG.pageSize;
  return { limit, pageSize };
}

/**
 * The decision a load-history handler makes from an inbound request, without
 * executing any store I/O — so the wire → fetch mapping is unit-testable apart
 * from the live channel wiring:
 *  - `page`   — a cursor was supplied; fetch older-than-`beforeId`.
 *  - `recent` — no cursor; tail-fetch the most recent `limit`.
 *
 * `beforeTurnId` is the OPTIONAL second half of the page cursor (#320). Present,
 * the anchor row must match BOTH fields; absent, `beforeId` alone selects it —
 * which is what an older peer sends and what it therefore still gets.
 */
export type HistoryFetchPlan =
  | { kind: "page"; beforeId: string; beforeTurnId?: string; limit: number }
  | { kind: "recent"; limit: number };

/**
 * Upper bound on a PEER-SUPPLIED `limit`, in messages per `history` frame.
 *
 * ⚠️ THIS RESTORES A CLAMP THE CUTOVER DROPPED, it is not a new policy. On base
 * every history read was capped at 1000 per frame — but ⚠️ NOT, as an earlier
 * revision of this docblock said, "twice over" on both paths. Stated per path,
 * because the difference matters for the request this bounds:
 *   - `recent` (no cursor): base's `recent()` forwarded `limit` to
 *     core's session-message read UNCLAMPED (⚠️ the symbol is deliberately NOT
 *     spelled here — #240's acceptance check is a repo-wide grep for it that must
 *     match NOTHING under `packages/`, and a docblock naming it is exactly the hit
 *     that makes the check lie about itself; `session-route-tenant-isolation.test.ts`
 *     splits the token for the same reason). `MAX_FETCH_WINDOW = 1000` was referenced
 *     only inside `pageBefore`. So this path was capped ONCE, upstream, by core's
 *     `Math.min` against `PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT = 1_000`;
 *   - `page` (cursor supplied): base clamped locally first
 *     (`Math.min(limit * 2, MAX_FETCH_WINDOW)`) and core clamped again.
 * `{type:"load_history", limit: 1e9}` carries NO cursor, so the exact request in
 * the threat model took the once-capped path. The conclusion is unchanged — base
 * capped it, the cutover did not — only the mechanism.
 *
 * Without this clamp that request selects the entire conversation, then
 * `JSON.stringify`s and AEAD-seals all of it on the shared event loop.
 * `sendHistory`/`sendToPeer` apply no size guard of their OWN — ⚠️ which is not
 * the same as "nothing checks the size", as an earlier revision implied by
 * claiming `effectiveOutboundLimit` is consulted only by `sendIngressResult`'s
 * chunking. `nats-transport.ts`'s `publish` checks it too and THROWS a
 * `RangeError` above it, on the very path every `sendHistory` takes.
 *
 * ⚠️ THAT THROW IS NOT CAUGHT BY `history-serve.ts`, as this docblock used to
 * claim — `nats-channel.ts`'s `sendToPeer` catches it first and returns `false`.
 * SINCE #311 the size is no longer left to that throw at all:
 * `history-frame-budget.ts` fits the page to the peer's sealed limit before it
 * is published, so an oversized page is SHORTENED from the old end (the pager
 * still reaches the rest) rather than lost whole. This clamp is still worth
 * having and its reason is unchanged: it bounds the CPU spent projecting and
 * sealing a page before any budget can look at it, and it keeps a peer from
 * naming an arbitrary row count in the first place.
 */
export const MAX_WIRE_HISTORY_LIMIT = 1000;

/**
 * Turn an inbound `load_history` request into a fetch plan.
 *
 * `limit` is validated here because the NATS dispatch forwards `message.limit`
 * straight off the wire (unlike the legacy WS transport). `NaN <= 0` is false,
 * so an un-guarded NaN/Infinity/negative would slip past the page selectors'
 * own `limit <= 0` check (`journal-history.ts`) — so any non-positive /
 * non-finite / non-number falls back to `fallbackLimit` (the configured page
 * size). A present `before` selects pagination; its absence selects the tail
 * fetch.
 *
 * ⚠️ THE CLAMP IS ASYMMETRIC ON PURPOSE — DO NOT "FIX" THE INCONSISTENCY.
 * `MAX_WIRE_HISTORY_LIMIT` bounds `request.limit`, which is peer-controlled
 * input. `fallbackLimit` is `config.limit` / `config.pageSize` — operator
 * configuration, i.e. trusted — and an operator who raises it is making a
 * deliberate choice about their own gateway, not mounting an attack. Clamping it
 * too would silently override a documented config key.
 *
 * `beforeTurnId` IS NOT VALIDATED HERE, and that asymmetry with `limit` is not
 * an oversight. `limit` needs validation because a non-finite one slips past the
 * page selectors' own `limit <= 0` check; `beforeTurnId` is only ever COMPARED,
 * exactly like `before` — a value naming no row is the empty page, which is the
 * same honest miss an unknown `before` already gets.
 *
 * ⚠️ AND THIS IS NOT THE DEPTH/LENGTH GATE THAT WAS BUILT AND REVERTED EARLIER
 * IN THIS SLICE. That one refused to serve past a total-conversation size, which
 * destroys REACH — a 1200-message conversation would have been unreadable at any
 * depth. A per-PAGE cap costs zero reach: `historyPageBefore` still pages
 * arbitrarily far back, 1000 messages at a time, which is strictly more reach
 * than base had (base capped the page identically AND capped it twice).
 */
export function planHistoryFetch(
  request: { before?: string; beforeTurnId?: string; limit?: number },
  fallbackLimit: number,
): HistoryFetchPlan {
  const limit =
    typeof request.limit === "number" &&
    Number.isFinite(request.limit) &&
    request.limit > 0
      ? Math.min(Math.floor(request.limit), MAX_WIRE_HISTORY_LIMIT)
      : fallbackLimit;
  // `beforeTurnId` rides along on the `page` arm only — it is meaningless
  // without an anchor id, so a request carrying it with no `before` still
  // tail-fetches.
  return request.before
    ? { kind: "page", beforeId: request.before, beforeTurnId: request.beforeTurnId, limit }
    : { kind: "recent", limit };
}
