# openclaw-webchannel-client

Framework-agnostic browser client for the OpenClaw web chat channel.

## What it is

A headless client that carries WebChannel's *functionality* — WebSocket
connection (with reconnect/backoff), the wire protocol, progress drafts, native
approvals, typing indicator, and the transcript/state reducer — **without any UI
framework dependency**. The client owns the chat state; wrap it in whatever view
layer you like (vanilla DOM, Vue, or a thin React `useSyncExternalStore` hook).
It is zero-dependency at runtime.

The production transport is **NATS E2E** (`WebChannelNatsClient`): the browser
dials a shared NATS bus, does an X25519 handshake, and exchanges
ChaCha20-Poly1305 ciphertext with the agent. A **legacy dev-only** Gateway-WS
client (`WebChannelClient`) also ships for zero-infra local round-trips.

## Status

Defer to [`../../docs/STATUS.md`](../../docs/STATUS.md), the single source of
truth for what is and isn't done.

- `WebChannelNatsClient` (NATS mode) — **the production client, live end-to-end.**
  A real browser running this class has round-tripped an encrypted message over a
  real JWT-auth `nats-server` into the enrolled `index-nats` plugin and back
  (NATS-layer NKEY-auth + X25519 handshake + PoP register hop). Ciphertext-only on
  the wire.
- `WebChannelClient` (Gateway-WS) — **legacy / dev-only.** A zero-infra WS
  round-trip exercised by `smoke-client.mjs`. No production role; slated for
  removal (see the repo `docs/BACKLOG.md`).

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

- `WebChannelNatsClient` — the production NATS-mode client (see Status; live).
  Defined in `src/nats-client.ts`. The package barrel currently re-exports it via
  a thin wrapper class exported under the name `WebChannelNATSClient`
  (`src/nats-client-wrapper.ts`) — the two names refer to the same NATS client;
  the casing should be unified in a later cleanup.
- `WebChannelClient` — legacy Gateway-WS client (dev-only).

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
(`natsUrl`, `accountId`, `tenant`, `peerId`, `natsCredentials`, optional
`registration`) drive the live `WebChannelNatsClient`.

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
