# openclaw-webchannel-client

Framework-agnostic browser client for the OpenClaw web chat channel.

## What it is

A headless client that carries WebChannel's *functionality* — WebSocket
connection (with reconnect/backoff), the wire protocol, progress drafts, native
approvals, typing indicator, and the transcript/state reducer — **without any UI
framework dependency**. The client owns the chat state; wrap it in whatever view
layer you like (vanilla DOM, Vue, or a thin React `useSyncExternalStore` hook).
It is zero-dependency at runtime.

Today it works against the **Gateway-WS** transport (`WebChannelClient`), the
path the rest of the repo runs end-to-end.

## Status

Defer to [`../../docs/STATUS.md`](../../docs/STATUS.md), the single source of
truth for what is and isn't done.

- `WebChannelClient` (Gateway-WS) — works end-to-end and is exercised by a live
  round-trip smoke (`smoke-client.mjs`).
- `WebChannelNATSClient` (NATS mode) — the type surface and a wrapper exist, but
  **the browser-dials-NATS path is not wired live yet.** No browser message has
  travelled over NATS into the agent and back. Treat NATS mode as not ready.

## Usage (Gateway-WS)

The client takes options and pushes immutable state snapshots to subscribers.
This mirrors `smoke-client.mjs`, a working round-trip against a live gateway with
the `hmac-ticket` auth strategy:

```js
import { WebChannelClient } from "openclaw-webchannel-client";

const client = new WebChannelClient({
  // Cross-origin gateway. For same-origin, use `path` instead (defaults to
  // "/webchannel/ws").
  url: "ws://127.0.0.1:18789/webchannel/ws",
  // Called on every (re)connect to mint a FRESH short-lived ticket. Return
  // null/empty to connect anonymously (when the gateway allows it).
  getTicket: async () => mintTicket("web-anon"),
});

// State is owned by the client; subscribe for immutable snapshots.
const unsubscribe = client.subscribe((state) => {
  if (state.connected) client.send("Hello");
  const reply = state.messages.find((m) => m.role === "agent" && !m.working && m.text);
  if (reply) console.log(reply.text);
});

client.connect();
// ... later: client.close(); unsubscribe();
```

All `WebChannelOptions` are optional — a zero-arg `new WebChannelClient()`
connects to `/webchannel/ws` on the current origin with no ticket (the anonymous
dev path).

## Exported API

From the package entry (`src/index.ts`):

**Classes**

- `WebChannelClient` — the Gateway-WS client.
- `WebChannelNATSClient` — NATS-mode wrapper (see Status; not wired live).

**Client methods** (same surface on both classes)

- `connect()` — open the connection.
- `close()` — tear it down.
- `send(text)` — send a user message.
- `decide(id, decision)` — resolve a native approval (`"allow-once"` |
  `"allow-always"` | `"deny"`).
- `loadHistory({ before?, limit? })` — request an older page of transcript.
- `subscribe(listener)` — register a state listener; returns an unsubscribe fn.
- `getState()` — read the current `WebChannelState` snapshot.

**Types**

`ChatRole`, `ChatMessage`, `ApprovalDecision`, `ApprovalOption`,
`ApprovalRequest`, `ConnectionStatus`, `WebChannelState`, `WebChannelOptions`,
`Listener`.

Key `WebChannelOptions`: `url` (full cross-origin WS URL), `path` (same-origin
WS path), `getTicket` (per-connect ticket supplier). NATS-mode options
(`natsUrl`, `bootstrapJwt`, `accountId`, `tenant`, `peerId`) exist but are not
wired live.

`WebChannelState` exposes `messages`, `approvals`, `status`
(`"connecting"` | `"connected"` | `"reconnecting"`), `connected`, and an
optional `isTyping` flag.

## Build / test

```bash
npm run build       # tsc library build -> dist/ (JS + .d.ts)
npm run typecheck   # tsc --noEmit
npm test            # vitest unit tests
```

This package is a headless library only — there is no bundled demo UI. A
consumer imports `WebChannelClient` and wires it into their own page (vanilla
DOM, Vue, or a thin React `useSyncExternalStore` hook).

`smoke-client.mjs` is a live round-trip against a running gateway with
`hmac-ticket` auth — run it with `WEBCHANNEL_TICKET_SECRET` set (from
`~/.openclaw/.env`) after `npm run build`.
