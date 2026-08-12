# `e2e/local` — production NATS pair, live in a real openclaw gateway

This harness proves the thing the project was missing for months: a **real browser**
running the **production** `WebChannelNatsClient` talks to the **production** `index-nats`
plugin loaded in a **real openclaw gateway**, over a real `nats-server`, and gets the
agent's reply back — encrypted end-to-end.

```
headless Chromium (WebChannelNatsClient)
      │  authenticated registration + ChaCha20-Poly1305
      ▼
  nats-server (ws://…:18222)         ← relay sees ciphertext only
      ▼
  index-nats plugin  ──►  openclaw inbound.run  ──►  echo model (fake OpenAI server)
      ▲                                                     │
      └──────────────── sealed reply ◄──────────────────────┘
```

What is **real**: the browser client, the NATS wire + crypto, the `index-nats` plugin, the
openclaw gateway, and the `inbound.run` agent loop (the reply even carries openclaw's real
prompt construction). What is a **stand-in**: only the model — a deterministic `echo:` server
replaces a live LLM (by design; keeps it hermetic). Peer admission is **always** the NATS
register hop (`…{peerId}.register`, JWT + Proof-of-Possession) — the sole admission path; there
is no wildcard shortcut and no unauthenticated key-exchange path.

Your real `~/.openclaw` and gateway are **never touched** — everything runs under an isolated
`OPENCLAW_HOME`.

> **Want to actually chat with the agent?** The interactive demo lives in the top-level
> [`demo/`](../../demo) directory (`demo/run.sh`; a real NGS relay is a mode of the same script):
> it boots this same enrolled-NATS topology against your real model/provider
> config and the SaaS issuer serves ONE unified web page (`ENABLE_DEMO_UI=1`) — a left panel
> where you approve the agent's enrollment and a right panel where you then chat with it, one
> origin, no separate chat server (Ctrl+C tears it down). The unified page lives at
> `ci-smoke.html`; the SaaS bundles the browser client
> (`packages/client/src/browser-demo-entry.ts`) into `/widget.js`. For the split
> host(Mac)/container variant see [`../../docs/SPLIT_DEMO.md`](../../docs/SPLIT_DEMO.md). The
> harnesses below are headless one-shot proofs, not the interactive demo.

## Files

| File | Role |
|---|---|
| `echo-openai-server.mjs` | ~50-line fake OpenAI `/v1/chat/completions` that returns `echo: <last user msg>`. Pointed at by an openclaw `openai-completions` provider. |
| `all-real.mjs` | Playwright runner for `run-all-real.sh` and `run-derived-trust.sh`: serves the browser bundle, launches headless Chromium running the production `WebChannelNatsClient`, NKEY-authenticates to the JWT-auth nats-server, drives the JWT + PoP register hop, and asserts the reply echoes the sent text. **This is the "from a real browser" proof.** |
| `enrolled-transport-roundtrip.ts` | Node driver for `run-enrolled-transport.sh`: an NKEY-authenticated peer that round-trips one message against the device-flow-enrolled plugin. |
| `turn-outcome-roundtrip.ts` | Node driver for `run-turn-outcome.sh`: runs a provider-rejected turn and an ordinary turn against the same enrolled plugin and asserts the `turn_settled{outcome}` of each. |
| `multi-message-roundtrip.ts` | Node driver shared by `run-multi-message.sh` and `run-block-streaming.sh`: drives one turn that produces TWO real assistant messages and asserts they settle as EXACTLY two bubbles at two distinct wire ids. Logs every inbound frame before asserting. |
| `two-account-isolation-roundtrip.ts` | Node driver for `run-two-account-isolation.sh`: drives positive round-trips plus an A-authorized token against B's live register subject. |
| `ci-smoke.html` | The unified demo/chat page served by the SaaS issuer. |

## Prerequisites

- `nats-server` v2.14+ (`brew install nats-server`).
- The `openclaw` npm dep installed (it ships `playwright-core` + `esbuild` transitively).
- Chromium for playwright-core: `node node_modules/openclaw/node_modules/playwright-core/cli.js install chromium chromium-headless-shell`.

## The harnesses

All seven boot a real gateway + `nats-server` + echo provider under an isolated
`OPENCLAW_HOME`, run one encrypted round-trip through the register hop, and self-clean on exit.

```bash
./e2e/local/run-all-real.sh              # production browser + device-flow-enrolled plugin,
                                         #   one shared trust chain, JWT + PoP register hop
./e2e/local/run-enrolled-transport.sh    # agent-side device-flow enrollment → enrolled NATS transport
./e2e/local/run-two-account-isolation.sh # one gateway/two accounts, live cross-account rejection
./e2e/local/run-derived-trust.sh         # `channels add` with ZERO hand-written JWT trust facts
./e2e/local/run-turn-outcome.sh          # provider-rejected turn settles `error`, not `ok` (#87)
./e2e/local/run-multi-message.sh         # multi-assistant-message turn settles TWO distinct ids (#94)
./e2e/local/run-block-streaming.sh       # the same turn with blockStreamingDefault "on":
                                         #   still exactly ONE bubble per message (#111)
```

> **They boot against `packages/plugin/dist/`, not your edited `src/`.** Measured on the pinned
> core (2026.6.10): the gateway logs
> `channel "webchannel" registered … source=…/packages/plugin/dist/index-nats.js`, so the
> `openclaw.extensions → ./index-nats.ts` swap each runner performs does **not** make it load TS
> source. CI is fine (it builds the plugin at step 5c before any harness runs), but locally a
> stale bundle silently tests code you did not write — with the #94 fix reverted in `src/` and a
> stale fixed `dist/` on disk, `run-multi-message.sh` passed. `run-multi-message.sh` therefore
> builds the plugin itself before booting; run `npm run build --workspace=packages/plugin` before
> the other five.

Each prints `[REPLY] echo: …<your message>` (and a `[PROOF] …` line) on success, and exits
non-zero if the register hop fails to admit the peer.

### `run-all-real.sh` — the fusion proof

A REAL headless-Chromium browser running the production `WebChannelNatsClient`
(a) NKEY-authenticates to a REAL JWT-auth `nats-server` and (b) drives the JWT + PoP register
hop, against a REAL enrolled plugin whose NATS creds were acquired **at config time** via
`openclaw channels add` (the device-flow `EnrollmentClient` runs in the setup hook, not at
gateway boot). One `setupTrustChain()` feeds the agent's device-flow creds, the nats-server
operator/account, the register-hop JWKS, and the browser's NATS creds + bootstrap JWT. The
only stand-in is the echo LLM.

### `run-enrolled-transport.sh` — enrolled transport (agent side)

Proves the plugin obtains tenant-scoped NATS user credentials via the REAL device-flow
enrollment-server (enroll → auto-approve → poll) through the production
`createEnrolledNatsConnection` path, connects (NKEY-authenticated) to a JWT-auth nats-server
from the SAME `setupTrustChain()`, and completes an encrypted round-trip.

### `run-two-account-isolation.sh` — routing isolation (AC6 gate)

One gateway process serves two account-bound runtimes sharing the same coordinator,
tenant, relay, issuer, and JWKS. Aggregate readiness must reach 2/2, and the production
`WebChannelNatsClient` proves A→A and B→B.
Then an A-authorized JWT and syntactically valid PoP request are sent to B's actual live
register subject: challenge and register must both return the exact opaque 401, B's peer/key
state and history/approval output must remain unchanged, and the same B-issued nonce must
still succeed with B's token (proving the audience rejection did not consume it). B→B must
still pass afterward.
Both entries run through `registerFull` → host account start →
`NatsAccountRuntimeCoordinator`/`NatsChannel`; there is no direct handler/verifier harness here.

### `run-turn-outcome.sh` — a failed turn must look failed (#87 gate)

`turn_settled{outcome}` is the signal the browser client promotes a user message's
`sendState` from: `ok` → `completed` (a ✓), `error` → `failed{reason:"turn-failed",
retryable:true}` — which is also what gates the retry affordance. Issue #87: a turn
rejected by the **provider** settled `ok`, so the widget rendered a ✓ and offered no
retry for a turn that produced no answer.

This needs a live gateway because the defect lives in a core behavior no unit test can
stage: core does **not** throw on a provider rejection. It absorbs the failure and hands
the plugin its terminal message as an ordinary reply payload flagged `isError`, so the
turn resolves cleanly and the plugin's `catch` never runs.
`packages/plugin/src/inbound.test.ts` pins the plugin-side logic; this harness pins the
core behavior that logic reads.

Same topology as `run-enrolled-transport.sh`, with `ECHO_FAIL_MARKER` set so the echo
provider answers HTTP 500 for any turn carrying the marker. Two turns, one gateway boot:
a rejected turn (must settle `error` **and** still deliver core's terminal message — the
fix must not silence the user-visible explanation) and an ordinary turn (must still settle
`ok`, so an unconditional "always error" fix cannot pass). Verified load-bearing by
revert-check: with the fix disabled the harness exits 6.

### `run-multi-message.sh` — two assistant messages, two bubbles (#94 gate)

In `streaming.mode:"partial"` the channel used to mint **one** draft id per **turn** and
accumulate every assistant message into it. The turn's `final` then replaced that merged bubble
with the **last** message's text, so earlier assistant text the user had already watched stream
was erased from the live view (the transcript kept it; the live path lost it). The fix gives each
assistant message its own lane — its own wire id, its own body, its own terminal frame.

The second assistant message is **real**, not staged: the only way a provider drives one is a tool
call, so the echo server (`ECHO_MULTI_MSG_MARKER`) answers phase 1 with assistant text A **plus** a
`tool_calls` entry and `finish_reason:"tool_calls"`, core executes the tool and comes back for
phase 2, which returns assistant text B. `ECHO_MULTI_MSG_TOOL` defaults to `agents_list` — captured
from the `body.tools` core actually advertises in this minimal config (27 tools), and picked because
it takes no arguments, always succeeds, and touches no filesystem or network state.

Same topology as `run-turn-outcome.sh` plus `streaming.mode:"partial"` on the account (the only
mode that creates a draft lane — in `block`/`off` the plugin takes the plain append path and the
harness would prove nothing; the runner re-asserts and verifies the mode after `channels add`).
Asserts: **exactly one settled `agent_message` per assistant message, at one distinct id each**,
message A present and not overwritten by B, model order preserved, and `turn_settled{outcome:"ok"}`
still delivered (so an unconditional-rotation fix cannot pass). The equality bar replaced the
original `>= 2` for #111 — see `run-block-streaming.sh` below, whose 4-bubble defect passed the old
one. Verified load-bearing by revert-check: with the fix reverted the harness exits 6.

The driver logs **every** inbound frame with its type, id and text before asserting. That record
is a deliverable in itself — it is the first direct evidence of how core drives a real
multi-message turn, which is the question plan §12.2(5) leaves open and no unit test can answer.
Measured shape on the pinned core (2026.6.10):

```
typing
progress      id=A  "ISSUE94_MESSAGE_A che"                     ← A mid-stream
agent_message id=A  "ISSUE94_MESSAGE_A checking the roster now." ← A settles, lane rotates
progress      id=B  "ZZZ94_SECOND_ANSWER here is what came back."
agent_message id=B  "ZZZ94_SECOND_ANSWER here is what came back."
turn_settled  outcome=ok
```

Two things in that record are worth carrying forward. **A settles before B's first `progress`**,
so no partial of B is ever applied to A's lane. And the rotation came from
**`onAssistantMessageStart`**, not from the partial-divergence path plan §5.5 designates as the
primary trigger: `rotate()` has exactly three call sites and the two on the partial/block paths
both log at `info` before rotating, yet the gateway log for a passing run contains neither
diagnostic. So on the pinned core the boundary event *does* fire for the second assistant message
of a tool-call turn — §5.5's "exactly once per agent run" does not hold across a tool boundary,
and the trigger the fix keeps "for contract fidelity" is the one actually carrying this shape.
(The gate is still load-bearing for #94 as a whole: the reverted plugin fails it.) A turn whose
second message arrives with **no** boundary event — the shape §5.5 describes — is not reachable
through this provider and remains covered only by the unit fixtures.

### `run-block-streaming.sh` — one bubble per message with block streaming on (#111 gate)

`run-multi-message.sh` with one config line added: `agents.defaults.blockStreamingDefault:"on"`.
That flag makes core dispatch each **completed** assistant message a second time, as a
`kind:"block"` delivery carrying that message's `assistantMessageIndex` — on top of the partials
the draft lane already streamed. The channel used to route every block to a fresh wire id, so the
same two-message turn settled as **four** bubbles, each answer duplicated:

```
progress      id=cl4jv9 "ISSUE94_MESSAGE_A che"
agent_message id=n34zbj "ISSUE94_MESSAGE_A checking the roster now."   ← independent block (index 1)
agent_message id=cl4jv9 "ISSUE94_MESSAGE_A checking the roster now."   ← the lane that streamed it
agent_message id=jgqt6u "ZZZ94_SECOND_ANSWER here is what came back."  ← independent block (index 2)
agent_message id=vne2pu "ZZZ94_SECOND_ANSWER here is what came back."
```

`run-multi-message.sh` cannot see this: with the flag off no block delivery is ever produced, so
the shape is unreachable there. The fix attributes an indexed block to the lane that owns that
index — identity **core itself supplied**, never body text, arrival order, or candidate counts —
and the driver's equality assertion is what holds it. Its ports, peer id and `OPENCLAW_HOME`
(`/tmp/oc-block-streaming-e2e`) are all distinct from `run-multi-message.sh`'s, so the two can run
back to back. Verified load-bearing by revert-check: with the attribution branch reverted this
harness exits 6 on the 4-bubble shape while `run-multi-message.sh` still passes.

Why it must be live: the field the routing reads (`assistantMessageIndex` on the delivery seam's
runtime info) is not even declared by the public `ChannelDeliveryInfo` type — it is there because
core hands the channel adapter the dispatcher's own `ReplyDispatchRuntimeInfo` verbatim
(`kernel-BROH42tr.js:696/:721` → `reply-dispatcher.types-CVYQHGPk.js:12`). A unit fixture
asserting that field is only asserting its own mock; only a real gateway can show core still
supplies it.

### `run-derived-trust.sh` — zero hand-written trust facts

Proves a fresh `openclaw channels add` reaches a working encrypted register round-trip with
ZERO hand-written JWT trust facts in `openclaw.json`. It writes NO `channels.webchannel`
config beyond what `buildFullAccountPatch` (`packages/plugin/src/setup.ts`) emits at
`channels add` (which omits issuer/JWKS trust pins and never writes an audience), so it is the
only harness that exercises account auth preparation end-to-end. The Gate-B readiness line
reports the derived issuer/JWKS/aud and `admission=register-hop`.

The unit-level twin of the real-issuer proof lives in
`packages/saas/src/ac6-device-flow-e2e.test.ts` ("issued JWT verifies against served JWKS via
the plugin's verifyJwt"), which cross-imports the plugin's `verifyJwt` + `JWKSCache` and
asserts a real-issuer JWT verifies against the served JWKS without a gateway.

## Known gaps (why this is "live" but not yet "full production")

- **Echo model, not a live LLM** — by design (hermetic). The agent path is real; only the brain is dumb.
- **Real-SaaS browser/Playwright JWT variant against a hosted issuer** — the register-hop
  proof runs against the reference bootstrap/enrollment server, not a hosted SaaS. A real
  browser variant against a hosted issuer is deferred because Playwright cannot pass an
  Ed25519 `CryptoKey` across the page boundary (the Node drivers can).

## In CI

`run-all-real.sh` and the other five harnesses run in the CI gate
(`.github/workflows/e2e-gate.yml`), so the real-gateway + `inbound.run` path is
regression-guarded on every push/PR.
