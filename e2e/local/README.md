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
- **Wildcard auto-register, not the HTTP register hop** — openclaw 2026.6.10 only dispatches
  *WS-upgrade* plugin routes, so the plugin's plain-HTTP `/webchannel/nats/register*` routes 404.
  The dev path uses `NatsChannel.subscribeWildcard()` (the allowlist gate still runs). Closing this
  is follow-up #8 in `docs/STATUS.md`; it's what unblocks live JWT/PoP registration.
- **Not in CI yet** — this is a local manual harness; folding it into the gate is follow-up #9.
