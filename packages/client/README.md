# openclaw-webchannel-client

Framework-agnostic browser client for the OpenClaw web chat channel.

The public `WebChannelNATSClient` connects to a shared NATS relay, performs the
configured enrollment/register flow, and exchanges end-to-end encrypted messages
with the agent over per-peer subjects. It owns transcript, progress, reasoning,
approval, typing, command-catalog, and connection state without imposing a UI
framework.

## Usage

```ts
import { WebChannelNATSClient } from "openclaw-webchannel-client";

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

### BREAKING: `ChatMessage` is a tagged union, and reasoning is in the transcript

`state.messages` now carries reasoning blocks alongside chat bubbles, because a
reasoning block has a POSITION in the conversation and the transcript array is
what holds positions. `ChatMessage` is therefore
`ChatBubble | ChatReasoningMessage`, discriminated on `kind`:

```ts
if (m.kind === "reasoning") {
  // { kind, id, turnId, text, ts? } — no `role`, no send/draft state.
} else {
  // ChatBubble — exactly the old ChatMessage, with no `kind` key.
}
```

Migration, in practice:

- a renderer that walks `state.messages` **must** handle `kind === "reasoning"`,
  or it will draw a reasoning block as an agent bubble (a reasoning entry has no
  `role`, so `role === "user"` is false);
- reads that ask "is this bubble in state X" — `m.role === "user"`, `m.working`,
  `m.pending` — keep compiling and keep their exact behaviour. Those fields are
  declared absent on the reasoning arm, so they answer `undefined`, and comparing
  one against a literal narrows to `ChatBubble`;
- **never** construct a reasoning entry with a `role`. The wire carries none and
  inventing one puts a fabricated author in the system of record; the type makes
  it a compile error.

`state.reasoning` keeps its `ReasoningItem[]` shape, so code that only reads it
needs no edit — but it is now **derived** from `state.messages` rather than
separately maintained, and the previous 100-item cap is **gone** (the durable
view is uncapped; a live cap made a reload disagree with what was watched).

Whether reasoning survives a reload is an agent-side opt-in
(`channels.webchannel.capabilities.reasoningDurable`, default **off**). With it
off the lane still renders live and a reload shows none of it.

### Terminal connection causes

`WebChannelState.errorCause` distinguishes failures that need re-authentication
from failures that need an operator or code change. In particular, `"capacity"`
means the selected OpenClaw WebChannel account has reached its fixed
conversation-key limit. It is terminal for that client instance and
re-authentication will not help; the UI should direct the user to the operator.
The lower-level `PopCapacityError` remains an internal direct-module detail and
is not exported from the package root.

### Authenticated readiness and stalled-work recovery

Public `state.connected === true` means an authenticated application session is
ready: the raw NATS socket opened, registration completed, the conversation key
was installed, and the replay ledger drained. A raw socket open by itself remains
`connecting` before the first session or `reconnecting` after a prior session,
with `connected: false`. This avoids releasing locally-held work into a keyless
replacement connection.

`ackStallTimeoutMs` controls two reactive recovery signals with one shared policy:

- default `30_000` ms; accepted values are integers from `0` through
  `2_147_483_647`;
- a published `user_message` with no authenticated owned ACK/overload rejection
  requests at most one soft reconnect per continuous no-result interval;
- an ordinary follow-up held behind a live turn/FIFO gate with no authenticated
  turn activity requests the same recovery path once;
- `0` disables both automatic signals. It does not disable live publish retries,
  heartbeat/raw-loss recovery, manual reconnect, or authenticated readiness.

The timeout is a recovery policy, not a delivery deadline. Missing ACK is
delivery-unknown: published receipts stay `sent`, replay keeps the same wire ID,
and the detector never fails or retracts them. Held work stays `queued` without a
wire ID; the detector never synthesizes `/stop`, releases it, or bypasses FIFO.
Only the existing reconnect → register → key → same-ID replay → session-ready and
stale-draft/FIFO paths change those states.

A legitimately silent turn with a held follow-up can therefore cause one harmless
extra reconnect. Raise the timeout or set it to `0` for workloads where long
silent turns are normal. A completely idle tab has no active-work signal and is
not proactively probed by this recovery mode.

### Turn activity: `turnActive` vs `isTyping`

`state.isTyping` mirrors the agent's single per-turn `typing` frame and is
cleared by the first `progress` / `agent_message` / `approval_*` frame. It answers
"is an answer being composed right now?", so it is deliberately silent for the
rest of a multi-step turn.

`state.turnActive` answers the other question — "is the agent still working on
this turn?" — and is owned by the client, not the wire. It becomes `true` the
moment a user message is published (including a held follow-up released later)
and stays `true` until that turn settles, across every gap in between: further
tool calls, a second assistant bubble, an approval wait. Several turns can be
outstanding at once; the flag is `true` while any of them is open. It is absent
until this client starts its first turn.

Turns are not one-per-send. Messages that arrive while a turn is running are
buffered and coalesced into a single turn keyed by the last of them. The current
plugin emits one same-outcome `turn_settled` per coalesced member, in arrival
order with the anchor last; the client promotes the exact receipt each frame
names. A settle also closes the turn it names **and every turn published before
it**. That prefix sweep remains for lost/missing earlier member frames. Both outcomes
sweep, as does an outcome-less legacy settle; sweeping turn activity never
fabricates a receipt outcome.

A failed send closes its own turn only for the one failure that is a good **proxy
for non-delivery** — `overloaded`, an ingress rejection. That is a proxy, not a
proof: the agent can also reject a message it already admitted (a live retry of
an unacked id whose accepted marker was lost), and such a turn is already
running, so its settle arrives for an id we already closed. Everything else is
left to the sweep, because removing an id a settle might still name would break
the sweep for every turn behind it. Two that look eligible but are not:
`turn-failed` comes *from* a settle, which already sweeps; and `evicted` is a
**client-side** unacked-ledger cap drop, where a lost ack is not a failed
delivery — the message may have reached the agent, been coalesced, and be the
very id its turn settles under.

Render `isTyping` as "typing…", and `turnActive` as a lower-key "still working"
affordance that survives between bubbles — with an actionable approval card
taking priority over both, since an approval wait keeps `turnActive` true while
`isTyping` is false. The flag is advisory: it never gates sending, the held
follow-up FIFO, or reconnect, so a widget may drive a `/stop` button off it, but
nothing in this client reads it back.

The guarantee is **bounded, not absolute**: `turnActive` can be `true` for longer
than the agent was really working, but it is not designed to stick forever. A
terminal error, `close()`, and an explicit `/stop` force-close every open turn,
and so does the transition to disconnected. A send that is only queued while
disconnected opens no turn until its first successful publication after
reconnect. An explicit `/stop` also consumes ordinary sends already queued at
that boundary, so their later publication cannot re-open the stopped work; a
follow-up created by the stop's own cancellation fanout belongs after that
boundary and remains eligible. The post-reconnect staleness valve force-closes
open turns too, but only in the case where it arms at all — when a `working`
draft was live as the session re-established — so it is a bonus rescue, not a
general timeout.
Force-closing an already-open turn is one-way: unlike `isTyping`, which a later
`typing` frame re-arms, an ack or replay does not re-open it, so a transient
reconnect in the middle of a long turn leaves `turnActive` false for the rest of
it.

The residual has one shape, and no attempt is made to enumerate its causes: **any
published turn whose settle never arrives — or arrives naming an id this client
cannot place — stays `true` until a later settle sweeps it as part of the prefix,
or a safety point fires.** `turn_settled` delivery is best-effort (the agent
warn-logs and drops it if publishing fails, unlike acks, which are retried), and
several agent-side paths ack a message at ingress and then abandon it without
running a turn. Named examples, not a complete list:

- **Text the agent treats as an abort but this client does not.** Abort text
  rides a control lane that never settles, so the client deliberately opens no
  turn for it — but its abort vocabulary is a pinned *subset* of the agent's
  (see `abort-mirror.ts`). Something the agent classifies as an abort and this
  client does not (e.g. an abort command with trailing text on a second line)
  opens a turn that never settles.
- **DM-allowlist denial.** When the agent's allowlist denies a peer, the plugin
  has already acked the message at ingress but dispatches no turn and emits no
  `turn_settled` (`packages/plugin/src/inbound.ts`). Fixing the
  admission/settlement asymmetry is tracked separately.
- **A lost coalesced-member frame.** The current plugin names every member, but
  delivery is best-effort. If this client's member frame is lost and the group
  anchor belongs to a second device sharing the peer id, the remaining frames
  name ids this client cannot place. An older anchor-only plugin has the same
  shape.
- **A post-admission `overloaded` rejection.** The client live-retries an unacked
  id on the same connection; if the agent's accepted marker for it was lost, the
  retry can be rejected while the original turn is still running. The client
  closes that turn on the rejection, so the settle that follows names an id it no
  longer holds — leaving any turn published *before* it open until the next sweep.

So treat `turnActive` as a soft hint that survives between bubbles, never as a
hard gate: showing a spinner slightly too long is the intended failure, and any
UI that would wedge on a stuck `true` should key off `isTyping` or an explicit
user action instead.

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
- `completed` — an **explicit** `turn_settled{outcome:"ok"}` named this message's
  exact wire id. The current plugin emits one same-outcome frame per coalesced
  member. A legacy plugin that omits `outcome` leaves the named message at
  `accepted` (an honest degradation — `completed` never appears, never faked).
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

**Coalesced receipts:** a burst still has one ANCHOR (the last member, used by
draft and answer frames), but the current plugin emits a `turn_settled` for every
member with the same outcome, anchor last. The client promotes only the exact
`turnId === wireId` match, so all member receipts resolve. (Historically,
anchor-only plugin builds — `0.4.0` and earlier, before per-member `turn_settled`
shipped in `0.5.0` — left non-anchor receipts at `accepted`, and the
turn-activity prefix sweep closed their indicators without inventing receipt
success. Those builds speak protocol v3, which a v4 client refuses, so that path
is no longer reachable; the sweep remains for lost or missing member frames.)

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
| published work receives no owned application result | one bounded soft reconnect, then same-ID ledger replay | remains `sent` until authoritative ACK/rejection |
| ordinary follow-up remains held with no live-turn activity | one bounded soft reconnect, then existing stale-draft/FIFO release | remains `queued` with no wire ID; never detector-released |
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
together — the wire protocol is now **v4** (v3 in `0.4.0`, the register hop
described below; v4 in #246 — see the CHANGELOG).

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
`sendState === "failed"` + `sendFailure`. `openclaw-webchannel-client` and
`openclaw-webchannel` ship in lockstep — upgrade both together (the register
protocol version is mandatory in both directions, and is **v4** today).

See [`../../docs/STATUS.md`](../../docs/STATUS.md) for current deployment status
and [`../../docs/TRUST_AND_ONBOARDING.md`](../../docs/TRUST_AND_ONBOARDING.md) for
the enrollment and trust model.

## Build / test

```bash
npm run build
npm run typecheck
npm test
```
