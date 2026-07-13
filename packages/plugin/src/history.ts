import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

import { sanitizeHistoryText } from "./history-sanitize.js";

/**
 * History messages that travel on the wire and live in client state.
 *
 * Mirrored on the client side as `ChatMessage` in `packages/client/src/types.ts`.
 * The `ts` field is hydration metadata: server-recorded millisecond timestamp
 * (so the widget can sort by recency without trusting client clocks). Local
 * sends (a user typing in the widget) keep `ts` absent — the widget assigns
 * one on receive for stable sort, but the field is wire-shaped.
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
 * Logger shape we accept (matches OpenClaw's optional-method logger so we
 * don't import the SDK type and keep this module SDK-light).
 */
type LoggerLike = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type RawSessionMessage = {
  role?: unknown;
  content?: unknown;
  text?: unknown;
  timestamp?: unknown;
  __openclaw?: { id?: unknown };
};

/**
 * Pull the visible text out of an OpenAI-style `content` array (the SDK's
 * session transcript reader returns `content: [{ type:"text", text:"..." }]`,
 * sometimes a plain string, sometimes `{ text }`). Returns "" when no text is
 * present — the caller drops the message.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string" && p.text.length > 0) parts.push(p.text);
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

function normalizeRole(raw: unknown): "user" | "agent" | null {
  if (raw === "user") return "user";
  // OpenClaw transcripts label the agent "assistant" (OpenAI chat-format).
  if (raw === "assistant") return "agent";
  return null;
}

function extractTs(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

/**
 * Best-effort id recovery: OpenClaw transcripts attach the canonical message id
 * on `__openclaw.id`; if absent we synthesize a stable fallback (`h-{ts}-{idx}`)
 * so the client can still dedupe across reconnects of an empty transcript.
 */
function extractId(raw: RawSessionMessage, ts: number, idx: number): string {
  const inner = raw.__openclaw;
  if (inner && typeof inner.id === "string" && inner.id.length > 0) return inner.id;
  return `h-${ts}-${idx}`;
}

function normalize(raw: unknown, idx: number): HistoryMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as RawSessionMessage;
  const role = normalizeRole(r.role);
  if (!role) return null;
  const rawText = typeof r.text === "string" ? r.text : extractText(r.content);
  if (!rawText) return null;
  // The transcript is raw model output; the live path never showed it verbatim.
  // Sanitize at read time so a re-hydrated bubble converges to what the reader
  // saw live. An empty result (NO_REPLY-only or noise-only) drops the message.
  const text = sanitizeHistoryText(role, rawText);
  if (!text) return null;
  const ts = extractTs(r.timestamp);
  return {
    id: extractId(r, ts, idx),
    role,
    text,
    ts,
  };
}

function normalizeAll(rawMessages: readonly unknown[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = normalize(rawMessages[i], i);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Inner store call. Uses the SDK's `runtime.subagent.getSessionMessages` —
 * the closest stable seam a plugin has to read past messages for a sessionKey
 * (it dispatches the gateway `sessions.get` method which is sessionKey-scoped
 * inside the kernel, so cross-peer leakage is impossible at this layer).
 *
 * This helper does NOT catch — the public `recent` / `pageBefore` wrappers
 * own the try/catch + warn, so the seed's "throw is logged and treated as
 * no history" contract has exactly one log path.
 */
async function readFromStore(
  api: OpenClawPluginApi,
  sessionKey: string,
  limit: number,
): Promise<HistoryMessage[]> {
  const subagent = api.runtime?.subagent as
    | { getSessionMessages?: (params: { sessionKey: string; limit?: number }) => Promise<{ messages?: unknown[] }> }
    | undefined;
  if (!subagent || typeof subagent.getSessionMessages !== "function") return [];
  const payload = await subagent.getSessionMessages({ sessionKey, limit });
  const raw = Array.isArray(payload?.messages) ? payload.messages : [];
  return normalizeAll(raw);
}

/**
 * Returns the most recent `limit` messages for `sessionKey` from the core
 * session store. Wrapped in try/catch — a throw is logged and treated as
 * "no history" (returns `[]`), per the seed's best-effort contract: a
 * missing or failing store MUST NOT block the connection.
 */
export async function recent(
  api: OpenClawPluginApi,
  sessionKey: string,
  limit: number,
  logger?: LoggerLike,
): Promise<HistoryMessage[]> {
  if (!sessionKey || limit <= 0) return [];
  try {
    return await readFromStore(api, sessionKey, limit);
  } catch (err) {
    logger?.warn?.(`webchannel: history.recent failed for ${sessionKey}: ${String(err)}`);
    return [];
  }
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
 * so an un-guarded NaN/Infinity/negative would slip past `pageBefore`'s own
 * `limit <= 0` check — so any non-positive / non-finite / non-number falls back
 * to `fallbackLimit` (the configured page size). A present `before` selects
 * pagination; its absence selects the tail fetch.
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

/**
 * Maximum number of messages we ever request from the store in one call.
 * Mirrors upstream `PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT` (openclaw
 * `server-plugins.ts`): `getSessionMessages` caps its `limit` at 1000, so
 * asking for more is silently clamped upstream. We clamp on our side too so
 * the fetch window and the effective wall are the same number.
 */
const MAX_FETCH_WINDOW = 1000;

/**
 * Returns up to `limit` messages older than `beforeId` for `sessionKey`.
 *
 * The SDK seam (`runtime.subagent.getSessionMessages`) only accepts `limit`
 * (no native `before` cursor) — it is a plain tail fetch (most-recent-N). To
 * page backwards we fetch a window and slice client-side around the cursor,
 * widening the window when the small window cannot yield a full page:
 *  1. Phase 1 — read the last `limit * 2` messages (a small buffer so we can
 *     still hand back `limit` items after role filtering drops a few). Return
 *     the older-than-cursor slice ONLY when it cannot be truncated by the
 *     window's LEFT edge: either the cursor sits at index `>= limit` (a full
 *     page of older messages is already in the window), or phase 1 already
 *     fetched `MAX_FETCH_WINDOW` (no wider window exists). Otherwise — a miss,
 *     OR a hit at `idx < limit` where the older slice would be cut short by
 *     the window edge rather than by the store — fall through to phase 2.
 *  2. Phase 2 — re-fetch the last `MAX_FETCH_WINDOW` messages (the upstream
 *     cap) and search again. If the cursor is found, return its older slice
 *     even when short/empty: at the maximal window a truncated slice is the
 *     genuine wall (1000-cap or start of conversation). `readFromStore`
 *     filters out non-user/agent roles, so `idx < limit` in the small window
 *     does NOT prove start-of-conversation — that is exactly why the left-edge
 *     case must widen, mirroring the miss case.
 *  3. If the cursor is still not found in the maximal window, return `[]`.
 *     Returning newest-N instead would only produce duplicates the client
 *     dedups (a silent stop). An empty page is the honest "no more history"
 *     signal — the client wrapper treats an empty `history` frame as a no-op.
 *
 * Conversations longer than `MAX_FETCH_WINDOW` are a hard wall (the SDK cannot
 * fetch past it); paging into that region returns `[]`.
 *
 * Always returns messages OLDER than `beforeId` (never includes the cursor).
 * Cross-peer leakage: the SDK's `getSessionMessages` is internally scoped by
 * `sessionKey` — we never query without one. Best-effort: a throw in EITHER
 * phase is logged and the call returns `[]`.
 */
export async function pageBefore(
  api: OpenClawPluginApi,
  sessionKey: string,
  beforeId: string,
  limit: number,
  logger?: LoggerLike,
): Promise<HistoryMessage[]> {
  if (!sessionKey || !beforeId || limit <= 0) return [];
  try {
    // Phase 1: the common path — a small window around the cursor.
    const phase1Limit = Math.min(limit * 2, MAX_FETCH_WINDOW);
    const window = await readFromStore(api, sessionKey, phase1Limit);
    const idx = window.findIndex((m) => m.id === beforeId);
    // Trust the small window only when the older slice is bounded by the store,
    // not by the window's left edge: a full page is already present (idx >=
    // limit), or this window is already the maximal one we can fetch.
    if (idx >= limit || (idx !== -1 && phase1Limit >= MAX_FETCH_WINDOW)) {
      return window.slice(Math.max(0, idx - limit), idx);
    }
    // Phase 1 was already the maximal window and the cursor missed — no wider
    // search to try.
    if (phase1Limit >= MAX_FETCH_WINDOW) return [];

    // Phase 2: a miss, or a hit at the left edge that phase 1 couldn't fully
    // serve — widen to the upstream cap and search again.
    const wide = await readFromStore(api, sessionKey, MAX_FETCH_WINDOW);
    const wideIdx = wide.findIndex((m) => m.id === beforeId);
    // At the maximal window a short/empty older slice IS the genuine wall.
    if (wideIdx !== -1) return wide.slice(Math.max(0, wideIdx - limit), wideIdx);

    // Cursor is not in the maximal window we can fetch. Usually that means the
    // client holds messages older than anything reachable (conversation >1000
    // or start-of-history), but the id could also miss because it was
    // synthesized window-relative (`h-${ts}-${idx}`, see extractId) or the
    // message was dropped by read-time sanitization. In every case an empty
    // page is the honest signal — newest-N would only feed the client dupes.
    return [];
  } catch (err) {
    logger?.warn?.(`webchannel: history.pageBefore failed for ${sessionKey}: ${String(err)}`);
    return [];
  }
}
