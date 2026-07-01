# `e2e/local` — production NATS pair, live in a real openclaw gateway

This harness proves the thing the project was missing for months: a **real browser**
running the **production** `WebChannelNatsClient` talks to the **production** `index-nats`
plugin loaded in a **real openclaw gateway**, over a real `nats-server`, and gets the
agent's reply back — encrypted end-to-end.

```
headless Chromium (WebChannelNatsClient)
      │  X25519 handshake + ChaCha20-Poly1305
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
replaces a live LLM (by design; keeps it hermetic). What is a **dev shortcut**: peer
registration uses a wildcard subscription instead of the HTTP register hop (see "Known gaps").

Your real `~/.openclaw` and gateway are **never touched** — everything runs under an isolated
`OPENCLAW_HOME`.

> **Want to actually chat with the agent?** `./run-demo.sh` is the **single interactive demo** —
> it boots this same enrolled-NATS topology against your real model/provider config and the SaaS
> issuer serves ONE unified web page (`ENABLE_DEMO_UI=1`): a left panel where you approve the
> agent's enrollment and a right panel where you then chat with it — one origin, no separate chat
> server (Ctrl+C tears it down). The unified page lives at `demo-app.html`; the SaaS bundles the
> browser client (`packages/client/src/browser-demo-entry.ts`) into `/widget.js`. For the split
> host(Mac)/container variant see [`../../docs/SPLIT_DEMO.md`](../../docs/SPLIT_DEMO.md). The
> harnesses below are headless one-shot proofs, not the interactive demo.

## Files

| File | Role |
|---|---|
| `echo-openai-server.mjs` | ~50-line fake OpenAI `/v1/chat/completions` that returns `echo: <last user msg>`. Pointed at by an openclaw `openai-completions` provider. |
| `drive-roundtrip.ts` | Node driver: runs the production `WebChannelNatsClient` (Node 22+ has the browser globals it needs) and round-trips one message. Fast inner-loop check. |
| `browser-entry.ts` | Browser bundle entry — exposes `window.runWeb(opts)` driving `WebChannelNatsClient`. Bundled to IIFE via esbuild. |
| `browser-roundtrip.mjs` | Playwright runner: serves the bundle, launches headless Chromium, calls `runWeb`, asserts the reply echoes the sent text. **This is the "from a real browser" proof.** |

## Prerequisites

- `nats-server` v2.14+ (`brew install nats-server`).
- The `openclaw` npm dep installed (it ships `playwright-core` + `esbuild` transitively).
- Chromium for playwright-core: `node node_modules/openclaw/node_modules/playwright-core/cli.js install chromium chromium-headless-shell`.

## Reproduce

All paths below are from the repo root. Use a scratch `OPENCLAW_HOME` so your real config is untouched.

```bash
OCH=/tmp/oc-e2e; mkdir -p "$OCH/.openclaw"

# 1. nats-server with a websocket listener
cat > "$OCH/nats.conf" <<'CONF'
port: 14222
websocket { port: 18222, no_tls: true }
CONF
nats-server -c "$OCH/nats.conf" &

# 2. echo model server
node e2e/local/echo-openai-server.mjs 18900 &

# 3. isolated openclaw config: webchannel (NATS) + echo provider + a single agent.
#    See the keys the gateway requires below; a minimal config is:
#    - models.providers.echo-local = { baseUrl: "http://127.0.0.1:18900/v1", api: "openai-completions",
#        models: [{ id: "echo", contextWindow: 200000, maxTokens: 8192 }] }
#    - agents.defaults.model.primary = "echo-local/echo"
#    - agents.defaults.compaction.reserveTokensFloor = 20000   # else tiny-context compaction errors
#    - channels.webchannel = { dmSecurity: "allowlist", allowFrom: ["web-anon"] }
#        # NOTE: no `auth` block on the open-NATS `auto` path (no verifier is built);
#        # no `nats`/`encryption` keys either — the schema rejects them here.
#    - plugins.load.paths = ["<repo>/packages/plugin"]
#    The plugin entry is ALREADY index-nats.ts by default
#    (packages/plugin/package.json openclaw.extensions = ["./index-nats.ts"]) — nothing to swap.

# 4. boot the isolated gateway in dev/open-NATS mode (env-driven — see the contract below)
OPENCLAW_HOME="$OCH" WEBCHANNEL_TICKET_SECRET=e2e-ticket-secret OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_DEV_OPEN=1 WEBCHANNEL_NATS_URL=ws://127.0.0.1:18222 \
  WEBCHANNEL_TENANT=default-tenant WEBCHANNEL_ACCOUNT_ID=default-agent \
  node_modules/.bin/openclaw gateway --port 18799 --force &
# wait for: "[webchannel] ✓ NATS mode plugin registered"

# 5a. fast Node round-trip
node --import tsx e2e/local/drive-roundtrip.ts

# 5b. real headless-browser round-trip
ESB=$(find node_modules -path '*/esbuild/bin/esbuild' | head -1)
"$ESB" e2e/local/browser-entry.ts --bundle --format=iife --global-name=WC --outfile=/tmp/oc-e2e/browser-bundle.js
node e2e/local/browser-roundtrip.mjs    # exits 0 iff the reply echoes the sent text
```

Both drivers print `[REPLY] echo: …<your message>`, proving the round-trip.

## JWT-register scenario (HTTP hop as sole admission)

`run-jwt-register.sh` proves the **HTTP `/webchannel/nats/register` route is the SOLE
peer-admission path** — no wildcard shortcut. It is a sibling of the open-NATS round-trip above,
but boots the gateway with `channels.webchannel.auth.strategy = "jwt"`. The wildcard is gated
off on the jwt path (`index-nats.ts` / `src/wildcard-gate.ts` `shouldSubscribeWildcard`):
under `auth.strategy="jwt"` the agent does **not** call `subscribeWildcard()`, so it is
subscribed to NO peer subjects until something calls `channel.registerPeer(peerId)` — and the
only thing that does is the live HTTP register route.

```bash
./e2e/local/run-jwt-register.sh     # exits 0 iff the JWT+PoP register hop admits the peer
```

What it does, hermetically (isolated `OPENCLAW_HOME=/tmp/oc-e2e`, self-cleaning trap):

1. `gen-jwt-fixtures.mjs` mints an RS256 keypair → `jwks.json` (gateway's `auth.jwt.jwksFile`)
   + `rs256-private.jwk.json` (the driver re-imports it to sign), **before** the gateway boots.
2. Boots nats-server + the echo provider + an isolated gateway whose `channels.webchannel.auth`
   is `{ strategy:"jwt", jwt:{ jwksFile, issuer:"https://e2e-issuer.test", audience:"default-agent" } }`,
   with `dmSecurity:"allowlist"`, `allowFrom:["web-jwt-peer"]`. (`devOpen` stays env-driven —
   `WEBCHANNEL_NATS_DEV_OPEN=1` — since the schema rejects unknown `channels.webchannel` keys.)
3. `jwt-register-roundtrip.ts` runs the **production** `WebChannelNatsClient` with a `registration`
   config: it generates device X25519 (→ `cnf.jwk`) + Ed25519 PoP (→ `pop_jwk`) keys, builds the
   bootstrap claims via `packages/saas/bootstrap-claims`, RS256-signs the JWT (`kid` matches the
   JWKS), and on connect drives challenge → PoP-signed register over the live HTTP route, then
   round-trips one encrypted message. A register failure fires `onError` → non-zero exit (loud).

Because the wildcard is OFF, the reply (`echo: …`) can only mean the agent registered the peer
through the HTTP hop. The driver prints `[PROOF] agent registered peer via HTTP hop (wildcard OFF)`.

This does **not** change production behavior: enrolled production runs `devOpenNats=false`, so the
wildcard is already off there. The gate only tightens the devOpen+jwt test so the proof is real.

### Real-SaaS-issuer scenario (real bootstrap-server, real JWKS over HTTP)

`run-saas-issuer-register.sh` is the **stronger sibling** of `run-jwt-register.sh`. Same
live register hop, same wildcard-OFF jwt path, same encrypted round-trip — but the bootstrap
JWT is **not self-minted from a static fixture**. It is minted + RS256-signed by the **real**
reference bootstrap-server (`packages/saas/reference/bootstrap-server.ts`), which derives a
real RSA keypair via `setupTrustChain()` and serves the matching public JWKS at
`/.well-known/jwks.json`. The gateway is configured with
`channels.webchannel.auth.jwt.jwksUrl` pointing **at that live JWKS endpoint** (not a
`jwksFile`), so the plugin's `verifyJwt` fetches the signing key by header `kid` **over HTTP
from the real issuer**.

```bash
./e2e/local/run-saas-issuer-register.sh   # exits 0 iff the real-issuer JWT is admitted
```

What it proves end-to-end: **real bootstrap-server RS256 issuance → real JWKS-over-HTTP
verification → live HTTP register hop → encrypted echo** — the real issuer↔verifier↔register
loop, not a fixture. The driver prints
`[PROOF] real-SaaS-issued JWT (RS256, real JWKS) admitted via live register hop`.

How it differs from `run-jwt-register.sh`:

| | `run-jwt-register.sh` | `run-saas-issuer-register.sh` |
|---|---|---|
| JWT source | self-minted in the driver from `gen-jwt-fixtures.mjs` | **real bootstrap-server** (`/bootstrap`) |
| JWKS source | static `auth.jwt.jwksFile` | **live** `auth.jwt.jwksUrl` (HTTP fetch) |
| Issuer | `https://e2e-issuer.test` (fixed) | `SAAS_ISSUER` (env, default `https://saas.local/issuer`) |
| peerId | hardcoded `web-jwt-peer` | driver sends a fixed `peerId`; server threads it into JWT `sub`; allowlisted |
| Ports | gw 18799 / nats 18222 / echo 18900 | gw 18899 / nats 18322 / echo 18901 / bootstrap 3911 |

The unit-level twin of this proof lives in `packages/saas/src/ac6-device-flow-e2e.test.ts`
("issued JWT verifies against served JWKS via the plugin's verifyJwt"), which cross-imports
the plugin's `verifyJwt` + `JWKSCache` and asserts the real-issuer JWT verifies against the
served JWKS without a gateway.

JWT issuance is **independent of NATS transport**: this harness keeps devOpen NATS (no
enrollment). The full **enrolled-NATS-transport (device-flow)** variant — a JWT-auth
nats-server fed by the device-flow `/enroll`+`/poll` credentials — remains a follow-up.

## dev/open-NATS contract (how `index-nats` skips enrollment)

Production `index-nats` connects via `createEnrolledNatsConnection` (SaaS device-flow + JWT).
For local testing it has a **dev/open-NATS** path that connects to a plain `nats-server` with no
enrollment. It is **env-driven** because openclaw validates the `channels.webchannel` config
against the plugin schema and rejects unknown keys (so you cannot put `nats`/`encryption` there):

| Env var | Meaning |
|---|---|
| `WEBCHANNEL_NATS_DEV_OPEN=1` | enable the dev/open-NATS path (no enrollment, no JWT) |
| `WEBCHANNEL_NATS_URL` | nats-server ws URL (default `ws://127.0.0.1:4222`) |
| `WEBCHANNEL_TENANT` / `WEBCHANNEL_ACCOUNT_ID` | subject-namespace fields (`accountId` = the wire identity; must match the browser client) |

Encryption stays **on** (encrypt-by-construction default); the relay only ever sees ciphertext.

## Known gaps (why this is "live" but not yet "full production")

- **Echo model, not a live LLM** — by design (hermetic). The agent path is real; only the brain is dumb.
- **Wildcard auto-register (open-NATS harness only) vs. the HTTP register hop (now exercised)** — the
  open-NATS dev harness connects on the wildcard path and does not call the HTTP register route,
  so that path uses `NatsChannel.subscribeWildcard()` (the allowlist gate still runs). The HTTP
  register hop is now **exercised end-to-end** by the JWT-register scenario above
  (`run-jwt-register.sh`): under `auth.strategy="jwt"` the wildcard is gated OFF
  (`src/wildcard-gate.ts`), so the round-trip there proves `registerPeer` happens **only** via the
  live HTTP route. (Background: the plain-HTTP `/webchannel/nats/register*` routes work live — #8
  done; the client is wired to call `registerWithPop` — #11 done.) The remaining gap (#13) shrinks
  to: a real **browser/Playwright** JWT variant against a **real SaaS issuer** — deferred because
  Playwright cannot pass an Ed25519 `CryptoKey` across the page boundary (the Node driver can).
- **In CI (JWT-register harness)** — `run-jwt-register.sh` is now run by the CI gate
  (`.github/workflows/e2e-gate.yml`, step "Real-gateway live e2e (JWT register hop)"), so the
  real-gateway + `inbound.run` path is regression-guarded on every push/PR (follow-up #9, done for
  this harness). Still manual (smaller remaining follow-up): the open-NATS `drive-roundtrip.ts` /
  browser `browser-roundtrip.mjs` real-gateway variants, and the real **browser/Playwright** JWT
  variant against a real SaaS issuer (#13 — Playwright cannot pass an Ed25519 `CryptoKey` across the
  page boundary).
