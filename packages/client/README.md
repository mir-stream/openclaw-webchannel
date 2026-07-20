# openclaw-webchannel-client

Framework-agnostic browser client for the OpenClaw web chat channel.

The public `WebChannelNATSClient` connects to a shared NATS relay, performs the
configured enrollment/register flow, and exchanges end-to-end encrypted messages
with the agent over per-peer subjects. It owns transcript, progress, reasoning,
approval, typing, command-catalog, and connection state without imposing a UI
framework.

## Usage

```ts
import { WebChannelNATSClient } from "@mir-stream/webchannel-client";

const client = new WebChannelNATSClient({
  natsUrl: "wss://relay.example.com",
  bootstrapJwt,
  accountId: "account-1",
  tenant: "tenant-1",
  peerId: "user-1",
  natsCredentials,
  registration,
});

const unsubscribe = client.subscribe((state) => {
  if (state.connected) console.log(state.messages);
});

client.connect();
client.send("Hello");
// Later: client.close(); unsubscribe();
```

The wrapper also exposes `decide`, `loadHistory`, `loadCommands`, `getState`, and
the reconnect/heartbeat tuning fields defined by `NatsClientOptions`.

Public state types include `ChatMessage`, `ApprovalRequest`, `ReasoningItem`,
`WebChannelState`, `WebChannelErrorCause`, `WebChannelOptions`, and the P0-4
send-result types `SendState`, `SendFailure`, and `SendReceipt`.

## Send-result contract (P0-4)

Every `send()` returns a `SendReceipt` (or `undefined` for trimmed-empty input —
no bubble, no state change). The receipt's `id` is stable across history adoption
and `retract()`; `snapshot()` reads the current state and `subscribe(cb)` fires on
every transition:

```ts
const receipt = client.send("Hello");
receipt?.subscribe(({ state, failure }) => {
  if (state === "failed") console.warn("send failed:", failure?.reason);
});
```

Each user message also carries `ChatMessage.sendState` (+ `sendFailure` when
failed) for rendering. The lifecycle:

```
queued -> sent -> accepted -> completed        (+ failed, terminal, from any pre-completed state)
```

- `queued` — held locally; not yet written to the socket.
- `sent` — the encrypted frame reached the socket (NOT plugin acceptance).
- `accepted` — the plugin acked the message at ingress (P0-7b).
- `completed` — the turn settled with an **explicit** `turn_settled{outcome:"ok"}`
  on the anchor message. A legacy plugin that omits `outcome` leaves the message
  at `accepted` (an honest degradation — `completed` never appears, never faked).
- `failed` — terminal; `sendFailure.reason` is one of `closed` | `evicted` |
  `terminal` (+ `cause`) | `turn-failed` | `cancelled`, with `retryable` and
  `lastAttemptAt`. `retryable` means "does THIS client auto-retry"; recovery
  judgement for a `terminal` failure is the embedder's, keyed off `cause`.

Once a CL2 terminal failure fires (auth/register/secure-channel — `status:"error"`),
the client instance is **permanently retired**: it never reconnects, and every
subsequent `send()` resolves immediately to `failed{terminal}`. Recovery means
constructing a NEW client with fresh credentials — reviving the same instance is
unsupported.

**Coalesce anchor:** a burst that the agent coalesces into ONE turn completes only
the ANCHOR message (the last one — `turnId === wireId`); the earlier messages rest
at `accepted` (admission is guaranteed; turn outcome is observed per turn).

**Answer-delivery vs turn outcome:** if the agent's final answer frame fails to
send but the turn itself settled without error, the message still reaches
`completed` — the receipt tracks the *user message's* fate, not answer delivery.
The dropped answer text is recovered by the register-time history snapshot (lane
L3/L6 below), never by faking the turn outcome.

### Durability boundary

There is **no disk-backed queue**. A `queued` or `sent` (un-acked) message dies
with the page/process — the live-session contract above holds only while the tab
is open. `accepted`/`completed`/`failed` are the durable resolutions.

### Recovery lanes (windows that can't resolve in-session)

| Window | Lane | Observation |
|---|---|---|
| `user_message` publish loss | ledger replay (P0-7b) + publish-driven forceReconnect | `queued`→retry→`sent`→… |
| plugin ack-send failure | client re-register → replay → dedupe → re-ack | `sent` until the next reconnect, then `accepted` |
| `turn_settled`/final-frame send failure | client stays honestly `accepted`; history snapshot re-hydrates the answer | no false `completed` |
| `approval_decision` loss | #15 Leg C reconciler re-sends | unchanged |
| `load_history`/`load_commands` loss | re-request + register re-hydration | loss is harmless |
| inbound frame loss | register snapshot re-hydration | unchanged |

### BREAKING: `ChatMessage.delivered` removed

The boolean `delivered` is gone. Migration: `delivered === true` ↔
`sendState === "accepted" || sendState === "completed"`; render a failure from
`sendState === "failed"` + `sendFailure`. `@mir-stream/webchannel-client` and
`@mir-stream/webchannel-plugin` ship in lockstep — upgrade both together (the
additive `turn_settled.outcome` field is the only wire change; an older peer on
either side simply ignores it).

See [`../../docs/STATUS.md`](../../docs/STATUS.md) for current deployment status
and [`../../docs/TRUST_AND_ONBOARDING.md`](../../docs/TRUST_AND_ONBOARDING.md) for
the enrollment and trust model.

## Build / test

```bash
npm run build
npm run typecheck
npm test
```
