# WebChannel Onboarding Guide (BYO-NATS / Synadia)

A reproducible, hands-on runbook for standing up a **browser ↔ OpenClaw agent** chat
over an **untrusted NATS relay** (Synadia/NGS), end-to-end encrypted, with a **SaaS
issuer** minting credentials. This is the practical sibling of the conceptual
[`TRUST_AND_ONBOARDING.md`](./TRUST_AND_ONBOARDING.md).

By the end you will have: a real browser page talking to a real OpenClaw agent
(real LLM, **not** echo) through Synadia, with the agent enrolled via the RFC 8628
device flow against your own issuer.

---

## 0. Architecture & topology

```
 Browser (WebChannelNatsClient)                Agent (openclaw + webchannel plugin)
   │  mints creds from issuer                     │  enrolls via device flow
   │  X25519 + ChaCha20-Poly1305                  │  caches creds, reconnects
   ▼                                              ▼
 ┌─────────────────────────────────────────────────────────┐
 │   Synadia / NGS  (wss://connect.ngs.global:443)          │  ← relay sees ciphertext only
 │   subjects: webchannel.{tenant}.{agentId}.{peerId}.*     │
 └─────────────────────────────────────────────────────────┘
   ▲                                              ▲
   │ /test/nats-user, /test/bootstrap-jwt         │ /api/enroll, /api/poll, /.well-known/jwks.json
   └───────────────  SaaS issuer  (:3951) ────────┘
```

Three identities, three different sources (this trips everyone up):

| Token | Who picks it | Enforced by |
|---|---|---|
| `tenant` | agent config; **sent at enrollment** | NATS creds permission `webchannel.{tenant}.>` (cross-tenant isolation) |
| `agentId` | agent config (a label) | nothing at the NATS layer — addressing only; admission JWT `aud` if register-hop |
| `peerId` | the **browser**, per session | — |

> The agent **subscribes** on `{tenant}/{agentId}`; the browser **sends** to the same
> `{tenant}/{agentId}` it is told. They must match. Security rests on **tenant creds +
> E2E encryption + handshake/allowlist**, not on `agentId`.

---

## 1. Prerequisites

- An **OpenClaw** install (`>= 2026.6.10`) wherever the agent runs (host or container).
- A **NATS relay**. This guide uses **Synadia Cloud / NGS**. You need:
  - the account **signing** nkey seed (`SA…`) — a *secret*
  - the account **ID** (`A…`) — public. (If the console only shows a resource id like
    `3FnTKuz1…`, recover the real `A…` from the `issuer_account` field of any existing
    `.creds` file for that account.)
  - the connect URL: `wss://connect.ngs.global:443`
- `node` + `tsx` to run the reference issuer.
- (Optional) Docker/OrbStack if the agent runs in a container.

---

## 2. Stand up the SaaS issuer (external-NATS mode)

The issuer mints NATS user credentials **signed by your Synadia account signing key**,
plus RS256 bootstrap JWTs (its own RSA/JWKS trust chain). "External mode" = the issuer
does **not** own the NATS account; it only holds the signing key.

Create `~/.openclaw-webchannel-saas/synadia.env` (**chmod 600** — contains a secret):

```bash
# Synadia (you fill these)
export NATS_ACCOUNT_SIGNING_SEED='SA…'          # SECRET — never log/commit/paste
export NATS_ACCOUNT_ID='A…'
export NATS_URL='wss://connect.ngs.global:443'
# issuer settings
export PORT='3951'
export SAAS_BASE_URL='http://127.0.0.1:3951'
export SAAS_ISSUER='https://saas.local/webchannel-issuer'   # JWT `iss` claim (a string, not a URL to fetch)
export ENABLE_TEST_ROUTES='1'                   # exposes /test/nats-user + /test/bootstrap-jwt for the browser demo
export TRUST_CHAIN_PATH="$HOME/.openclaw-webchannel-saas/trust-chain-synadia.json"
```

Run it (stays in the foreground; restart wipes the in-memory enrollment store):

```bash
cd <repo>
set -a; . ~/.openclaw-webchannel-saas/synadia.env; set +a
node --import tsx packages/saas/reference/enrollment-server.ts
```

Verify:

```bash
curl -s http://127.0.0.1:3951/.well-known/jwks.json | head -c 80   # → {"keys":[{"kty":"RSA",…
```

> ⚠️ `ENABLE_TEST_ROUTES=1` mints creds for **any** tenant with no auth — dev/lab only.
> The signing seed is the crown jewel: keep it in the 0600 env file, never in chat/logs/disk-as-plaintext.

---

## 3. Install the plugin into OpenClaw

```bash
openclaw plugins install --link /path/to/packages/plugin
```

`--link` links the TypeScript source (no compiled `dist/` needed). A copy-install
(`openclaw plugins install <path>`) requires `./dist/…` and will be rejected.

Verify it shows up:

```bash
openclaw plugins list | grep -i webchannel
```

**If the agent runs in a container**, copy the source in first and fix two things:

```bash
docker cp packages/plugin <container>:/root/plugin
docker exec <container> sh -c "chown -R 0:0 /root/plugin"          # else: "suspicious ownership" → BLOCKED
docker exec <container> sh -c "cd /root/plugin && npm install --omit=dev"   # installs ws (the only runtime dep)
docker exec <container> openclaw plugins install --link /root/plugin
```

---

## 4. Configure the channel

WebChannel is a **plugin channel**, not built-in — there is no `openclaw channels add`
for it. Configure it once with `openclaw config patch` (objects deep-merge, arrays/scalars
replace, `null` deletes):

```bash
openclaw config patch --stdin <<'JSON'
{
  "channels": {
    "webchannel": {
      "auth": {
        "strategy": "jwt",
        "jwt": {
          "jwksUrl": "http://127.0.0.1:3951/.well-known/jwks.json",
          "issuer":  "https://saas.local/webchannel-issuer",
          "audience": "default-agent"
        }
      },
      "dmSecurity": "allowlist",
      "allowFrom": ["web-anon"],
      "nats": {
        "url": "wss://connect.ngs.global:443",
        "admission": "register-hop",
        "credentials": { "mode": "enrolled", "saasBaseUrl": "http://127.0.0.1:3951" }
      }
    }
  }
}
JSON
openclaw config get channels.webchannel    # verify
```

| Key | Meaning |
|---|---|
| `nats.url` | the relay to dial (Synadia) |
| `credentials.mode=enrolled` | NATS creds come from the SaaS device flow |
| `credentials.saasBaseUrl` | where `/api/enroll` + `/api/poll` live |
| `auth.jwt.*` | verifies browser bootstrap JWTs (issuer JWKS) |
| `admission` | `register-hop` (SaaS bootstrap+PoP) or `auto` (handshake+allowlist) — see §6 |

> **Container caveat:** from inside a container the SaaS is **not** `127.0.0.1` — use
> `host.docker.internal:3951` for `saasBaseUrl` **and** `jwksUrl`. The `issuer` value
> stays as-is (it is a JWT claim string, not an address). NATS is public so its URL is
> unchanged.

---

## 5. Pair the agent (RFC 8628 device flow)

```bash
openclaw gateway run        # NO env needed — connection config lives in config (step 4)
```

The plugin logs a connection target and a pairing prompt:

```
[webchannel] NATS credential source: enrolled → wss://connect.ngs.global:443
[enrollment] User code: ABCD-EFGH
[enrollment] Verification URI: http://127.0.0.1:3951/enroll?user_code=ABCD-EFGH
[enrollment] Polling for approval...
```

**Approve it** (operator action). Either:

- **curl (most reliable):**
  ```bash
  curl -X POST http://127.0.0.1:3951/approve \
    -H 'content-type: application/json' -d '{"user_code":"ABCD-EFGH"}'
  # → {"success":true,…}
  ```
- **browser:** open the **full Verification URI** (with `?user_code=…`) and click **Approve**.
  Opening bare `/enroll` shows an unfilled page — don't. Hard-refresh if you opened it before.

Success:

```
[enrollment] ✓ Enrollment complete!
[connection] ✓ Connected to NATS
[webchannel] ✓ Encrypted NATS channel created
```

Creds are cached at `~/.openclaw-webchannel/credentials.json` (mode 0600) — **restarts
reconnect with no re-approval**.

> **Harmless noise — repeating `Polling for approval...` after success.** OpenClaw
> pre-warms plugins, so `registerFull` can run more than once per boot, starting more
> than one enrolled connection. Exactly **one** binds the live `NatsChannel` (the
> `✓ … registered` line appears once — there is no double message-processing); any extra
> enroll loop just polls an unapproved code until its ~600s expiry, then gives up
> gracefully. The repeating `Polling for approval...` lines are that orphaned loop and can
> be ignored. _(Known gap — pending an idempotency guard so the enrolled connection starts
> once per process.)_

> The connection (the NATS socket) is held for as long as `gateway run` runs — exactly
> like a Telegram channel holds its connection while the gateway is up. Config = *where/how*;
> pairing = *one-time*; connecting = *every run*.

---

## 6. Chat from the browser

The chat UI is a **web page you host** (the headless `packages/client` library), **not** a
SaaS URL. The demo server builds the browser bundle and serves it:

```bash
WEBCHANNEL_NATS_URL='wss://connect.ngs.global:443' \
WEBCHANNEL_ISSUER_URL='http://127.0.0.1:3951' \
WEBCHANNEL_GW_URL='http://127.0.0.1:18789' \
WEBCHANNEL_TENANT='default-tenant' \
WEBCHANNEL_AGENT_ID='default-agent' \
WEBCHANNEL_PEER_ID='web-human-1' \
WEBCHANNEL_PAGE_PORT='19393' \
node e2e/local/demo-server.mjs
# → chat UI at http://127.0.0.1:19393/
```

The page: generates keys → mints NATS creds from `issuer/test/nats-user` → mints a PoP
bootstrap JWT from `issuer/test/bootstrap-jwt` → connects to NATS → (register hop) → chat.
Use the **same `tenant`+`agentId`** as the agent.

### Two admission models

- **`register-hop`** (config default when `auth.strategy=jwt`): the browser must complete
  an HTTP register hop at the agent's `/webchannel/nats/register*` routes (`WEBCHANNEL_GW_URL`).
  → **Known issue (openclaw 2026.6.10):** `api.registerHttpRoute` can resolve to a no-op in
  the plugin-registration context, so those routes **404**. Until the plugin migrates to the
  2026.6.10 route API, use `auto` instead.
- **`auto`** (recommended for now): the agent serves any peer that completes the X25519
  handshake **and** passes the `dmSecurity` allowlist — **no register hop**. Switch with:
  ```bash
  openclaw config patch --stdin <<'JSON'
  { "channels": { "webchannel": { "dmSecurity": "open", "nats": { "admission": "auto" } } } }
  JSON
  # restart the gateway to apply
  ```
  …and run the demo server with `WEBCHANNEL_GW_URL=''` so the browser skips registration.

Type a message → the **real configured model** replies (verify the agent's model is a live
provider, e.g. `openclaw config get` / the `agent model:` startup log — not an echo stand-in).

---

## 7. (Optional) Reach the gateway dashboard

`openclaw gateway run` serves a dashboard on its port (default `:18789`), token-gated:

```
http://<host>:18789/#token=<gateway.auth.token>
```

The token is `gateway.auth.token` in that gateway's config (or `OPENCLAW_GATEWAY_TOKEN`).
The `#token=` fragment auto-authenticates; a missing/wrong token → `AUTH_RATE_LIMITED`
(rate-limit lockout) then `token mismatch`.

> **Port-collision gotcha (container + a host gateway):** if a host OpenClaw gateway already
> binds `127.0.0.1:18789`, it **shadows** a container's published `*:18789` for loopback
> requests — so `127.0.0.1:18789` hits the **host** gateway (and the container token mismatches).
> Fixes: (a) give the container gateway `gateway.bind: "lan"` and reach it via the container's
> OrbStack/host address; or (b) stop the host gateway (`openclaw gateway stop`, restart later
> with `openclaw gateway start`) so `:18789` frees up for the container. A container gateway on
> `bind: "loopback"` is unreachable through the port-forward — it must be `lan` to be forwarded.

---

## 8. Troubleshooting quick reference

| Symptom | Cause | Fix |
|---|---|---|
| plugin `blocked: suspicious ownership` | source dir `uid≠0` in a root container | `chown -R 0:0 <dir>` |
| `Cannot find module 'ws'` | node_modules not installed for the linked plugin | `npm install --omit=dev` in the plugin dir |
| `NATS connection failed (fetch failed)` | wrong `saasBaseUrl` / issuer down | issuer up? container → `host.docker.internal`, not `127.0.0.1` |
| approve → `Enrollment not found … {{USER_CODE}}` | opened bare `/enroll`, or cached approval page | open the full `?user_code=…` URL / hard-refresh / curl `/approve` |
| polls re-enroll every ~5s, never pairs | client treated `authorization_pending` (HTTP 400) as a hard error | ensure poll handles the 400 `{error}` body (don't throw) |
| `Polling for approval...` keeps printing **after** a successful connect | pre-warm ran `registerFull` more than once → a duplicate enroll loop polling an unapproved code | harmless (one channel binds; no double-processing) — self-terminates at ~600s expiry; known gap, needs an idempotency guard |
| register `/challenge` → 404 + CORS | `registerHttpRoute` no-op on 2026.6.10 | use `admission: auto` (no register hop) |
| dashboard `AUTH_RATE_LIMITED` / `token mismatch` | no/!wrong `#token=`, or hitting a different gateway on the same port | use the right gateway's token; resolve the `:18789` collision (§7) |

---

## 9. Reference

**Env overrides** (take precedence over config; keep secrets out of committed config):
`WEBCHANNEL_NATS_URL`, `WEBCHANNEL_NATS_USER_JWT`, `WEBCHANNEL_NATS_USER_SEED`,
`WEBCHANNEL_NATS_CREDS`, `WEBCHANNEL_NATS_DEV_OPEN=1`, `WEBCHANNEL_SAAS_BASE_URL`,
`WEBCHANNEL_TENANT`, `WEBCHANNEL_AGENT_ID`.

**Subjects:** `webchannel.{tenant}.{agentId}.{peerId}.{in,out,handshake}`
(agent subscribes `…*.in`/`…*.handshake`, publishes `…*.out`; browser is the mirror).

**Credential modes** (`nats.credentials.mode`): `enrolled` (SaaS device flow, default) ·
`static` (BYO url + user JWT + NKEY seed / `.creds` file, no issuer) · `open` (dev, no auth).

**Issuer endpoints:** `/api/enroll`, `/api/poll`, `/approve`, `/.well-known/jwks.json`,
and (test-only) `/test/nats-user`, `/test/bootstrap-jwt`.
