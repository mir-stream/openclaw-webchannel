# `e2e/local` — production NATS pair, live in a real openclaw gateway

This harness proves the thing the project was missing for months: a **real browser**
running the **production** `WebChannelNatsClient` talks to the **production** `index-nats`
plugin loaded in a **real openclaw gateway**, over a real `nats-server`, and gets the
agent's reply back — encrypted end-to-end.

```
headless Chromium (WebChannelNatsClient)
      │  authenticated registration + ChaCha20-Poly1305
      ▼
  nats-server (ws://127.0.0.1:$NATS_WS)   ← relay sees ciphertext only
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
| `multi-message-roundtrip.ts` | Node driver for `run-multi-message.sh`: drives one turn that produces TWO real assistant messages and asserts they settle at two distinct wire ids. Logs every inbound frame before asserting. |
| `two-account-isolation-roundtrip.ts` | Node driver for `run-two-account-isolation.sh`: drives positive round-trips plus an A-authorized token against B's live register subject. |
| `ci-smoke.html` | The unified demo/chat page served by the SaaS issuer. |
| `ports.json` | **Single source of truth for every port** in the gate family and in the root-sweep suites that bind real sockets (#118/#119). Also records non-suite owners (`tools`) and exclusions (`reserved`). |
| `ports.test.ts` | Guards `ports.json`: allocation globally disjoint, no reserved port claimed, an entry per `run-*.sh` declaring every key that gate references, bidirectional sync with the suites it declares, and — by allowlist, not by enumerated spelling — no port literal anywhere in `e2e/local/**` (recursive, `lib/` included) or in a declared suite. |
| `lib/harness.sh` | Shared gate helpers: `harness_ports` (exports a harness's ports from `ports.json`), `harness_build_plugin` (rebuilds `packages/plugin/dist/` from the working tree, records its hash), and `harness_assert_loaded_dist` (asserts, after readiness, that the gateway resolved that exact bundle). |
| `require-env.ts` | Makes drivers demand their topology from the launching gate instead of falling back to a port literal that silently drifts. |

## Prerequisites

- `nats-server` v2.14+ (`brew install nats-server`).
- The `openclaw` npm dep installed (it ships `playwright-core` + `esbuild` transitively).
- Chromium for playwright-core: `node node_modules/openclaw/node_modules/playwright-core/cli.js install chromium chromium-headless-shell`.

## The harnesses

All six boot a real gateway + `nats-server` + echo provider under an isolated
`OPENCLAW_HOME`, run one encrypted round-trip through the register hop, and self-clean on exit.

```bash
./e2e/local/run-all-real.sh              # production browser + device-flow-enrolled plugin,
                                         #   one shared trust chain, JWT + PoP register hop
./e2e/local/run-enrolled-transport.sh    # agent-side device-flow enrollment → enrolled NATS transport
./e2e/local/run-two-account-isolation.sh # one gateway/two accounts, live cross-account rejection
./e2e/local/run-derived-trust.sh         # `channels add` with ZERO hand-written JWT trust facts
./e2e/local/run-turn-outcome.sh          # provider-rejected turn settles `error`, not `ok` (#87)
./e2e/local/run-multi-message.sh         # multi-assistant-message turn settles TWO distinct ids (#94)
```

> **Every harness builds `packages/plugin/dist/` from your working tree before booting** (#125).
> Measured on the pinned core: the gateway logs
> `channel "webchannel" registered … source=…/packages/plugin/dist/index-nats.js`, so the
> `openclaw.extensions → ./index-nats.ts` swap each runner performs does **not** make it load TS
> source — the built bundle is what runs. A stale bundle therefore tests code you did not write:
> with the #94 fix reverted in `src/` and a stale fixed `dist/` on disk, `run-multi-message.sh`
> passed; and during #113 `run-two-account-isolation.sh` twice reported "this guard is not the
> cause" for an edit that had never executed.
>
> Only `run-multi-message.sh` used to build. Now all six call `harness_build_plugin` from
> [`lib/harness.sh`](lib/harness.sh), so you no longer need to remember
> `npm run build --workspace=packages/plugin`, and running one gate in isolation is as trustworthy
> as running them in a particular order. The build is unconditional — one esbuild bundle, ~0.3s —
> because a redundant rebuild is free and a skipped one costs a wrong conclusion.
>
> Building the right file and the gateway **loading** it are two different claims, so each
> harness records the first and asserts the second:
>
> ```
> [run-enrolled] built dist: /…/packages/plugin/dist/index-nats.js (2026-08-13T10:26:17.907Z, 535083 bytes, sha256 b0e2cb20388b55d3)
> [run-enrolled] ✓ DIST-ASSERT: gateway loaded the bundle this gate built (source=/…/dist/index-nats.js, sha256 b0e2cb20388b55d3)
> ```
>
> The `built dist:` line is **provenance, not a check** — it is printed straight after an
> unconditional build that always rewrites the output, so it can never report anything but
> success. Do not read it as evidence the build ran.
>
> The `DIST-ASSERT` line is the check. After gateway readiness, `harness_assert_loaded_dist`
> greps core's own resolution record (`… (plugin=webchannel, source=<path>)`) for the exact
> bundle this gate built, and re-hashes it to catch anything that rewrote `dist/` in between.
> A mismatch aborts the gate before the driver runs. That is what catches a core update
> changing plugin resolution — the class of failure where your build was fine and irrelevant.

### Ports

Every port that anything under `e2e/local/` binds or dials is **allocated** in
[`ports.json`](ports.json), and nothing here may hard-code one — gates get theirs from
`harness_ports`, drivers from their gate's env.

Root-sweep suites with intentionally fixed listeners are allocated there too. Three hard-code
their own numbers and are *declared* — `ac6-device-flow-e2e.test.ts` and the two demo smokes.
For those three the literal is the allocation, and `ports.test.ts` pins the two together in both
directions so neither side can drift. The two real nats-server suites instead ask nats-server to
bind OS-assigned ports atomically, then read its per-process ports file; they remain in the
literal scan so reintroducing a fixed port is still rejected.

The two families used to allocate independently, and overlapped: `18222` was both the
transport-realserver monitor port and the default NATS URL in
`two-account-isolation-roundtrip.ts` (#118), and `3981` was claimed by both `run-turn-outcome.sh`
and `run-derived-trust.sh` (#119). When they collide, `nats-server` cannot bind and the suite
dies in `beforeAll` — or skips its tests and reports nothing.

One file means a concurrent addition is a merge conflict. [`ports.test.ts`](ports.test.ts)
covers the rest: the allocation is globally disjoint, claims no reserved port, has an entry for
every `run-*.sh` that declares every key its gate references, and stays in sync with the suites
it declares.

**The literal scan is an allowlist, not a list of forbidden spellings.** An earlier version
enumerated shapes — `NAME=1234`, a `ws://host:port` URL, a port-named binding — and three more
were found in one sitting (`port: 14481` inside the `node -e` block that writes `nats.conf`,
`local ECHO_PORT=…`, and an `NAME=… cmd` env prefix). Deciding which rules ran by file extension
was itself an enumeration, and the `nats.conf` case — a JS object literal inside a `.sh` — is
what walked through it. So the polarity is inverted: **every integer in the unprivileged port
range, in any scanned file, outside comments and not part of a longer token, is a port** unless
it is a documented non-port occurrence scoped to that file and an exact expected count, a port
that file is the declared owner of, or a named waiver tied to a filed issue.

**The scan set is discovered, not listed.** It walks `e2e/local/` recursively — `lib/harness.sh`
is in scope, and a literal there would override `harness_ports` for all six gates at once — plus
every file under `packages/*/src/**` that *binds or spawns a listener*, found by content
(`nats-server`, `.listen(`, `createServer(`, `ws_port`, `spawn(`). That predicate is the analogue
of `run-*.sh` and also recognizes `new WebSocketServer({ port })`: a new realserver suite is
covered the day it lands, without anyone registering it.
Earlier the `packages/` half was a hand-maintained list, and a new suite spawning
`nats-server -p 14491 --ws_port 18491` — `run-multi-message`'s live ports — was invisible.
`packages/*/reference/**` is out of scope on purpose: those servers take their port from env in
every harness use, and their defaults are recorded under `reserved`.

**The exemption and waiver lists are forced to shrink.** Each `NOT_PORTS` entry names its source,
value, and exact occurrence count. The same value in another source receives no allowance, and
an extra occurrence in the named source exceeds the allowance, so a timeout cannot hide a fixed
listener. Removing an occurrence also makes the count stale. Every `WAIVED` entry must likewise
still occur in the scan set, so fixing a waived defect fails the build until the waiver is deleted
rather than leaving a silent blind spot.

> Known evasions of the token rule, listed because that rule is the design's load-bearing claim:
> numeric separators (`18_991`), hex/octal, and runtime concatenation of sub-4-digit parts. Each
> takes intent; the scan is aimed at the accident.
>
> Scanned extensions are source only (`.sh .ts .mts .cts .js .mjs .cjs`). `.json` is excluded
> because the authority is itself JSON; `.yaml` because the CI workflow is owned by another lane.

Drivers take their topology from the gate via env and **fail** if it is missing rather than
falling back to a literal — a default that never runs during a real gate is a default that
silently drifts (see [`require-env.ts`](require-env.ts)).

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
Asserts: **at least two `agent_message` frames with distinct ids**, message A present and not
overwritten by B, model order preserved, and `turn_settled{outcome:"ok"}` still delivered (so an
unconditional-rotation fix cannot pass). Verified load-bearing by revert-check: with the fix
reverted the harness exits 6.

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
