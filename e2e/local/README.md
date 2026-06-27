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
#    - channels.webchannel = { auth: { strategy: "hmac-ticket", ticketSecret: { env: "WEBCHANNEL_TICKET_SECRET" } },
#        dmSecurity: "allowlist", allowFrom: ["web-anon"] }     # NOTE: no `nats`/`encryption` keys — schema rejects them
#    - plugins.load.paths = ["<repo>/packages/plugin"]
#    Point the webchannel plugin entry at index-nats: temporarily set
#    packages/plugin/package.json  openclaw.extensions = ["./index-nats.ts"]  (revert after).

# 4. boot the isolated gateway in dev/open-NATS mode (env-driven — see the contract below)
OPENCLAW_HOME="$OCH" WEBCHANNEL_TICKET_SECRET=e2e-ticket-secret OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_DEV_OPEN=1 WEBCHANNEL_NATS_URL=ws://127.0.0.1:18222 \
  WEBCHANNEL_TENANT=default-tenant WEBCHANNEL_AGENT_ID=default-agent \
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
peer-admission path** — no wildcard shortcut. It is a sibling of the hmac round-trip above,
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

## dev/open-NATS contract (how `index-nats` skips enrollment)

Production `index-nats` connects via `createEnrolledNatsConnection` (SaaS device-flow + JWT).
For local testing it has a **dev/open-NATS** path that connects to a plain `nats-server` with no
enrollment. It is **env-driven** because openclaw validates the `channels.webchannel` config
against the plugin schema and rejects unknown keys (so you cannot put `nats`/`encryption` there):

| Env var | Meaning |
|---|---|
| `WEBCHANNEL_NATS_DEV_OPEN=1` | enable the dev/open-NATS path (no enrollment, no JWT) |
| `WEBCHANNEL_NATS_URL` | nats-server ws URL (default `ws://127.0.0.1:4222`) |
| `WEBCHANNEL_TENANT` / `WEBCHANNEL_AGENT_ID` | subject-namespace fields (must match the browser client) |

Encryption stays **on** (encrypt-by-construction default); the relay only ever sees ciphertext.

## Known gaps (why this is "live" but not yet "full production")

- **Echo model, not a live LLM** — by design (hermetic). The agent path is real; only the brain is dumb.
- **Wildcard auto-register (hmac harness only) vs. the HTTP register hop (now exercised)** — the
  hmac dev harness browser connects with an hmac-ticket and does not call the HTTP register route,
  so that path uses `NatsChannel.subscribeWildcard()` (the allowlist gate still runs). The HTTP
  register hop is now **exercised end-to-end** by the JWT-register scenario above
  (`run-jwt-register.sh`): under `auth.strategy="jwt"` the wildcard is gated OFF
  (`src/wildcard-gate.ts`), so the round-trip there proves `registerPeer` happens **only** via the
  live HTTP route. (Background: the plain-HTTP `/webchannel/nats/register*` routes work live — #8
  done; the client is wired to call `registerWithPop` — #11 done.) The remaining gap (#13) shrinks
  to: a real **browser/Playwright** JWT variant against a **real SaaS issuer** — deferred because
  Playwright cannot pass an Ed25519 `CryptoKey` across the page boundary (the Node driver can).
- **Not in CI yet** — this is a local manual harness; folding it into the gate is follow-up #9.
