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

### Terminal connection causes

`WebChannelState.errorCause` distinguishes failures that need re-authentication
from failures that need an operator or code change. In particular, `"capacity"`
means the selected OpenClaw WebChannel account has reached its fixed
conversation-key limit. It is terminal for that client instance and
re-authentication will not help; the UI should direct the user to the operator.
The lower-level `PopCapacityError` remains an internal direct-module detail and
is not exported from the package root.

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
  `terminal` (+ `cause`) | `overloaded` | `turn-failed` | `cancelled`, with `retryable` and
  `lastAttemptAt`. `retryable` means the caller/embedder may initiate a **fresh**
  retry after this terminal outcome; the failed receipt itself never resumes and
  is never automatically retried. It is `true` for `evicted`/`overloaded`/`turn-failed` and
  `false` for `closed`/`terminal`/`cancelled`. Readiness is separate: retry only
  on a ready instance; terminal recovery requires a new instance as described
  below.

Once a CL2 terminal failure fires (auth/register/capacity/secure-channel — `status:"error"`),
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

Protocol v2 adds explicit retained-work overload rejection. A rejected send
becomes `failed { reason: "overloaded", retryable: true }`; retry is a deliberate
caller/user action and creates a new id. Before either ACK or rejection arrives,
the client reliability layer replays the same id live with capped exponential
backoff, as well as immediately on reconnect. Client and plugin must be upgraded
together — the wire protocol is now **v3**.

### BREAKING: protocol v3 register hop

Three mandatory changes, all breaking:

- the register request carries a required `clientNonce`, generated fresh per
  register attempt and bound into the wrapped-conversation-key AAD (register-reply
  replay defence);
- `unregister` requires proof of possession — use `unregisterWithPop()`, since a
  token-only teardown against a v3 agent is a **silent no-op**;
- `popSignedMessage` and `signPop` both gained a leading `op` argument; the signed
  message is `webchannel-pop:{op}:{peerId}:{nonce}`.

See [`../../docs/AUTH.md`](../../docs/AUTH.md) for the reasoning.

### BREAKING: `ChatMessage.delivered` removed

The boolean `delivered` is gone. Migration: `delivered === true` ↔
`sendState === "accepted" || sendState === "completed"`; render a failure from
`sendState === "failed"` + `sendFailure`. `@mir-stream/webchannel-client` and
`@mir-stream/webchannel-plugin` ship in lockstep — upgrade both together (the
protocol v3 registration is mandatory in both directions).

See [`../../docs/STATUS.md`](../../docs/STATUS.md) for current deployment status
and [`../../docs/TRUST_AND_ONBOARDING.md`](../../docs/TRUST_AND_ONBOARDING.md) for
the enrollment and trust model.

## Build / test

```bash
npm run build
npm run typecheck
npm test
```
