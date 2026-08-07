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
| `two-account-isolation-roundtrip.ts` | Node driver for `run-two-account-isolation.sh`: drives positive round-trips plus an A-authorized token against B's live register subject. |
| `ci-smoke.html` | The unified demo/chat page served by the SaaS issuer. |

## Prerequisites

- `nats-server` v2.14+ (`brew install nats-server`).
- The `openclaw` npm dep installed (it ships `playwright-core` + `esbuild` transitively).
- Chromium for playwright-core: `node node_modules/openclaw/node_modules/playwright-core/cli.js install chromium chromium-headless-shell`.

## The harnesses

All five boot a real gateway + `nats-server` + echo provider under an isolated
`OPENCLAW_HOME`, run one encrypted round-trip through the register hop, and self-clean on exit.

```bash
./e2e/local/run-all-real.sh              # production browser + device-flow-enrolled plugin,
                                         #   one shared trust chain, JWT + PoP register hop
./e2e/local/run-enrolled-transport.sh    # agent-side device-flow enrollment → enrolled NATS transport
./e2e/local/run-two-account-isolation.sh # one gateway/two accounts, live cross-account rejection
./e2e/local/run-derived-trust.sh         # `channels add` with ZERO hand-written JWT trust facts
./e2e/local/run-turn-outcome.sh          # provider-rejected turn settles `error`, not `ok` (#87)
```

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

`run-all-real.sh` and the other four harnesses run in the CI gate
(`.github/workflows/e2e-gate.yml`), so the real-gateway + `inbound.run` path is
regression-guarded on every push/PR.
