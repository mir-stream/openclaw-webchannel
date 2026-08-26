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

/**
 * History messages that travel on the wire and live in client state.
 *
 * Mirrored on the client side as `ChatMessage` in `packages/client/src/types.ts`.
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
export type HistoryMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  ts: number;
};

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
 */
export type HistoryFetchPlan =
  | { kind: "page"; beforeId: string; limit: number }
  | { kind: "recent"; limit: number };

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
 */
export function planHistoryFetch(
  request: { before?: string; limit?: number },
  fallbackLimit: number,
): HistoryFetchPlan {
  const limit =
    typeof request.limit === "number" &&
    Number.isFinite(request.limit) &&
    request.limit > 0
      ? Math.floor(request.limit)
      : fallbackLimit;
  return request.before
    ? { kind: "page", beforeId: request.before, limit }
    : { kind: "recent", limit };
}
