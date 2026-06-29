/**
 * Browser entry for the INTERACTIVE live chat over the EXISTING hmac-ticket
 * webchannel path (NOT the NATS path).
 *
 * Unlike `browser-demo-entry.ts` (which drives the NATS `WebChannelNatsClient`
 * with in-page keygen + PoP register), this entry uses the plain gateway-WS
 * `WebChannelClient`: it connects to `/webchannel/ws?ticket=<hs256-jwt>`, where
 * the short-lived HS256 ticket is minted SERVER-SIDE and fetched over HTTP from
 * `ticketUrl`. The shared `WEBCHANNEL_TICKET_SECRET` never reaches the browser.
 *
 * BROWSER-SAFE ONLY: uses `fetch` + `WebSocket` (via `WebChannelClient`) — no
 * `node:` imports — so it survives the esbuild browser bundle.
 *
 * The `WebChannelClient` is a headless state store: it owns the transcript and
 * exposes `subscribe(state => …)` + `getState()`. We translate its immutable
 * state snapshots into the host's flat `onReply` / `onStatus` callbacks:
 *   - status   → onStatus("connecting" | "connected")  (we map the client's
 *                "reconnecting" onto "connecting" for the simple two-state UI)
 *   - messages → onReply(text) for each NEWLY-FINALIZED agent bubble (role
 *                "agent", not `working`). Intermediate `progress` drafts
 *                (working:true) are ignored; only the settled final answer is
 *                surfaced, deduped by message id so a given reply fires once.
 */

import { WebChannelClient } from "./client.js";
import type { WebChannelState } from "./types.js";

/** Options for the live chat (the full gateway-WS url + the ticket endpoint). */
export type RunLiveChatOptions = {
  /** Full WS url, e.g. `ws://127.0.0.1:18789/webchannel/ws`. */
  wsUrl: string;
  /** HTTP endpoint that returns a fresh HS256 ticket as `text/plain`. */
  ticketUrl: string;
};

/** Callbacks the host UI provides to receive replies / errors / status updates. */
export type RunLiveChatCallbacks = {
  /** Called for each finalized agent reply text. */
  onReply: (text: string) => void;
  /** Called on any terminal/setup error. */
  onError: (err: Error) => void;
  /** Called at connection transitions: "connecting" | "connected". */
  onStatus: (status: string) => void;
};

/** Controller returned by `runLiveChat`: the live, multi-send chat handle. */
export type LiveChatController = {
  /** Send one user message over the persistent client. */
  send: (text: string) => void;
  /** Tear down the WebSocket connection. */
  disconnect: () => void;
};

/**
 * Construct a `WebChannelClient` against the live gateway, wire its state store
 * to the host callbacks, connect, and return a `{ send, disconnect }` handle.
 *
 * Never throws synchronously for connection problems — those flow through the
 * client's reconnect policy and surface as status transitions. The returned
 * promise resolves as soon as the client is constructed and `connect()` is
 * kicked off.
 */
export async function runLiveChat(
  opts: RunLiveChatOptions,
  callbacks: RunLiveChatCallbacks,
): Promise<LiveChatController> {
  const client = new WebChannelClient({
    url: opts.wsUrl,
    // Fetch a fresh server-minted ticket on EVERY (re)connect. The client treats
    // a thrown error or a null/empty body as a failed connect (back off + retry).
    getTicket: async () => {
      const r = await fetch(opts.ticketUrl);
      if (!r.ok) return null;
      const token = (await r.text()).trim();
      return token.length > 0 ? token : null;
    },
  });

  // Ids of agent bubbles we have already delivered to onReply — so a single
  // reply is surfaced exactly once even though state snapshots are emitted on
  // every transition (typing → progress → final).
  const deliveredReplies = new Set<string>();
  // Track the last status we reported so we don't spam onStatus with duplicates.
  let lastStatus: string | null = null;

  const handleState = (state: WebChannelState): void => {
    // Status: collapse the client's tri-state ("connecting"|"reconnecting"|
    // "connected") into the host's two-state model. "connected" stays as-is;
    // anything else maps to "connecting".
    const status = state.connected ? "connected" : "connecting";
    if (status !== lastStatus) {
      lastStatus = status;
      try {
        callbacks.onStatus(status);
      } catch {
        /* host callback errors must not break the client loop */
      }
    }

    // Replies: deliver each agent bubble once it is FINAL (not a working draft).
    for (const m of state.messages) {
      if (m.role !== "agent") continue;
      if (m.working) continue; // still a live `progress` draft — wait for final.
      if (deliveredReplies.has(m.id)) continue;
      deliveredReplies.add(m.id);
      try {
        callbacks.onReply(m.text);
      } catch {
        /* host callback errors must not break the client loop */
      }
    }
  };

  client.subscribe(handleState);
  // Emit the initial snapshot's status immediately (subscribe does not fire on
  // attach), so the UI shows "connecting…" right away.
  handleState(client.getState());

  client.connect();

  return {
    send: (text: string) => client.send(text),
    disconnect: () => client.close(),
  };
}
