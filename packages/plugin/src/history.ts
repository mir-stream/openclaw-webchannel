import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

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
  const text = typeof r.text === "string" ? r.text : extractText(r.content);
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
 * Returns up to `limit` messages older than `beforeId` for `sessionKey`.
 *
 * The SDK seam (`runtime.subagent.getSessionMessages`) only accepts `limit`
 * (no native `before` cursor), so we fetch a wider window and slice client-side:
 *  1. Read the last `limit * 2` messages (a small buffer so we can still hand
 *     back `limit` items even if a chunk is filtered out).
 *  2. Find `beforeId` in that window; if absent (likely because the user has
 *     scrolled past the buffer), return the oldest `limit` items we have.
 *  3. Otherwise return the slice strictly older than `beforeId`.
 *
 * Always returns messages OLDER than `beforeId` (never includes the cursor).
 * Cross-peer leakage: the SDK's `getSessionMessages` is internally scoped by
 * `sessionKey` — we never query without one. Best-effort: a throw is logged
 * and the call returns `[]`.
 */
export async function pageBefore(
  api: OpenClawPluginApi,
  sessionKey: string,
  beforeId: string,
  limit: number,
  logger?: LoggerLike,
): Promise<HistoryMessage[]> {
  if (!sessionKey || !beforeId || limit <= 0) return [];
  const fetchLimit = limit * 2;
  let window: HistoryMessage[];
  try {
    window = await readFromStore(api, sessionKey, fetchLimit);
  } catch (err) {
    logger?.warn?.(`webchannel: history.pageBefore failed for ${sessionKey}: ${String(err)}`);
    return [];
  }
  const idx = window.findIndex((m) => m.id === beforeId);
  if (idx === -1) {
    // Cursor not in the window — give back the oldest `limit` we have so the
    // user still makes progress when scrolling past the buffer edge.
    return window.slice(-limit);
  }
  return window.slice(Math.max(0, idx - limit), idx);
}
