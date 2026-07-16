# WebChannel Onboarding Guide (BYO-NATS / Synadia)

A reproducible, hands-on runbook for standing up a **browser ↔ OpenClaw agent** chat
over a NATS relay (Synadia/NGS), end-to-end encrypted, with a **SaaS
issuer** minting credentials.

> ⚠️ **Relay trust caveat:** the E2E channel currently provides confidentiality against a
> *passive* relay only. Active-relay MITM protection (authenticated registration) is **not yet
> wired** — see **C2** in [`BACKLOG.md`](./BACKLOG.md). Until then, run this against a relay you
> operate (your own `nats-server` or your own Synadia account), not a genuinely untrusted one. This is the practical sibling of the conceptual
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
 │   subjects: webchannel.{tenant}.{accountId}.{peerId}.*   │
 └─────────────────────────────────────────────────────────┘
   ▲                                              ▲
   │ login → /nats-user, /bootstrap               │ /api/enroll, /api/poll, /.well-known/jwks.json
   │ (server-derived peerId)                      │
   └───────────────  SaaS issuer  (:3951) ────────┘
```

Three identities, three different sources (this trips everyone up):

| Token | Who picks it | Enforced by |
|---|---|---|
| `tenant` | agent config; **sent at enrollment** | NATS creds permission `webchannel.{tenant}.>` (cross-tenant isolation) |
| `accountId` | the `--account` flag of `channels add` (the deployment/wire identity) | NATS subject addressing; admission JWT `aud` on the register hop |
| `peerId` | the **browser**, per session | — |

> The agent **subscribes** on `{tenant}/{accountId}`; the browser **sends** to the same
> `{tenant}/{accountId}` it is told. They must match. Security rests on **tenant creds +
> E2E encryption + registration/allowlist**, not on `accountId`.
>
> The **handling agent is decoupled** from the wire identity (telegram-like): the
> `accountId` is the on-wire/admission identity, and which OpenClaw agent answers is a
> separate `openclaw agents bind --bind webchannel:<accountId> --agent <agent>` concern.

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
# Browser demo surface — the login flow (§6). Under ENABLE_DEMO_UI the
# unauthenticated /test/* mint routes are OFF; the human LOGS IN instead. This one
# issuer then serves BOTH the /approve pairing UI (§5) and the login/chat page (§6).
export ENABLE_DEMO_UI='1'
export DEMO_APP_HTML="$PWD/e2e/local/ci-smoke.html"          # required by ENABLE_DEMO_UI
export DEMO_CLIENT_ENTRY="$PWD/packages/client/src/browser-demo-entry.ts"   # required by ENABLE_DEMO_UI
export TRUST_CHAIN_PATH="$HOME/.openclaw-webchannel-saas/trust-chain-synadia.json"
```

> `SAAS_ISSUER` is the `iss` the SaaS stamps. On the `channels add` happy path the
> config's `auth.jwt.issuer` is **derived from `--base-url`** (fact: issuer defaults to
> the SaaS base URL), so with `admission: register-hop` (the sole admission path) the two must
> agree — set `SAAS_ISSUER` to your SaaS base URL. The demo env block in `demo/run.sh` is the
> canonical, already-updated example.

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

> ⚠️ The signing seed is the crown jewel: keep it in the 0600 env file, never in
> chat/logs/disk-as-plaintext. (The legacy `ENABLE_TEST_ROUTES=1` mints creds for **any**
> tenant with no auth — dev/lab only; it is superseded by the login-gated demo flow and is
> 404'd whenever `ENABLE_DEMO_UI=1`. It stays available for the headless harnesses only —
> see §5's footnote.)

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

WebChannel is a **plugin channel**. On the happy path you configure it **and** enroll it in
a **single command**: `openclaw channels add` with `--base-url` writes the COMPLETE account
config block and then runs the device-flow enroll. Credential acquisition no longer happens
at `gateway run` — `gateway run` only **consumes** persisted per-account creds. A
hand-written `config patch` is only needed for the advanced cases in the last subsection.

### Recommended: one command writes config + enrolls (`openclaw channels add`)

The `--account <id>` value **is** the wire identity (the `accountId`): omit `--account` for
the `"default"` account, or pass `--account <id>` for a named account (creds persist to
`~/.openclaw-webchannel/<account>/credentials.json`). There is **no `--token`** — the
handling agent is bound separately (below).

```bash
openclaw channels add --channel webchannel \
  --account  default-agent \           # → accountId (the wire identity)
  --base-url http://127.0.0.1:3951 \   # → saas.baseUrl (SaaS issuer)
  --url      default-tenant            # → tenant
# With --base-url present the plugin (1) writes the FULL account block, then
# (2) runs the RFC 8628 device flow headlessly (prints the user_code), persists creds, exits 0.
```

When `--base-url` (the SaaS base URL) is present, the setup adapter writes the COMPLETE,
enroll-ready block and **derives** every field you would otherwise hand-write:

| Field | Derived value |
|---|---|
| `auth.strategy` | `jwt` |
| `auth.jwt.jwksUrl` | `<base-url>/.well-known/jwks.json` |
| `auth.jwt.issuer` | `<base-url>` (default) |
| `auth.jwt.audience` | `<accountId>` (default) |
| `dmSecurity` | `open` |
| `nats.admission` | `register-hop` |
| `nats.credentials.mode` | `enrolled` |
| `nats.url` | **omitted** — the SaaS delivers the relay URL with the creds at enroll |

Then bind the handling agent to that account (telegram-like — decoupled from the wire):

```bash
openclaw agents bind --bind webchannel:default-agent --agent my-agent
```

Approve the device code exactly as in §5; on success creds are persisted and `channels add`
exits 0. `gateway run` then consumes them with no re-approval.

**CLI flag mapping (important).** WebChannel is an installed (non-bundled) plugin, so
OpenClaw's `channels add` does not register custom `--saas-base-url`/`--tenant` flags today;
the plugin maps the **generic** flags onto its identity fields:

| Generic flag | Maps to | Config location written |
|---|---|---|
| `--account <id>` | `accountId` (wire identity) | `channels.webchannel.accounts.<id>` (the account key) |
| `--base-url <url>` | `saasBaseUrl` | `channels.webchannel[.accounts.<id>].saas.baseUrl` |
| `--url <tenant>` | `tenant` | `channels.webchannel[.accounts.<id>].tenant` |

`channels add` echoes the **resolved** identity before enrolling
(`[webchannel] account "<id>" resolved acquisition identity: accountId=… tenant=… saasBaseUrl=…`)
so a mis-mapped flag is visible. The dedicated `--saas-base-url`/`--tenant`
flags are declared in the manifest and will work automatically if/when the host registers
non-bundled `cliAddOptions`.

**Interactive wizard — guided alternative for authoring config.** Running **bare**
`openclaw channels add` (no flags) launches the interactive setup wizard: pick **webchannel**,
then answer prompts for the account id, tenant, and SaaS base URL — plus **advanced** JWT
`issuer`/`audience` overrides (the two fields the flag form cannot express; see the advanced
subsection). The wizard writes the **same** full block through the shared builder, but the
device-flow enroll fires on the `--flag` path — so after authoring config with the wizard,
complete enrollment by running the flag form above (or re-running acquisition). Use the
wizard when you need a custom `issuer`/`audience`; use the flag form for config **and** enroll
in one shot.

**Unambiguous alternative — acquisition env (legacy):** when there is **no** `channels.webchannel`
config at all, `WEBCHANNEL_TENANT` / `WEBCHANNEL_SAAS_BASE_URL` synthesize the `"default"`
account's identity. Once any webchannel config exists, these are **ignored** (config wins)
with a one-time deprecation warning. (Connection/static env —
`WEBCHANNEL_NATS_URL`/`_USER_JWT`/`_USER_SEED`/`_CREDS` — keep their runtime meaning; the removed
unauthenticated dev-open env flag now throws a targeted migration error instead of enabling an open
connection — see `resolveNatsCredentialSource`.)

Approve the device code exactly as in §5; on success creds are persisted and `channels add`
exits 0. `gateway run` then consumes them with no re-approval.

### Advanced / manual override (register-hop, custom issuer, allowlist)

The flag form maps only the generic `--account`/`--base-url`/`--url` flags — there is **no**
`--issuer`/`--audience`/`--admission` flag. So for the cases the derived defaults can't
express — `admission: register-hop`, an `issuer` that is **not** the SaaS base URL, or
`dmSecurity: allowlist` — either use the interactive wizard's advanced `issuer`/`audience`
prompts, or hand-write the account block with `openclaw config patch` (objects deep-merge,
arrays/scalars replace, `null` deletes):

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
| `admission` | `register-hop` (SaaS bootstrap+PoP) — the sole admission path, see §6 |

> **Container caveat:** from inside a container the SaaS is **not** `127.0.0.1` — use
> `host.docker.internal:3951` for `saasBaseUrl` **and** `jwksUrl`. The `issuer` value
> stays as-is (it is a JWT claim string, not an address). NATS is public so its URL is
> unchanged. On the `channels add` happy path, pass
> `--base-url http://host.docker.internal:3951` so the **derived** `jwksUrl`/`issuer` come
> out container-correct.

After hand-writing config this way, still enroll with `openclaw channels add` (§5) — the
device flow is what persists the creds `gateway run` consumes.

---

## 5. Pair the agent (RFC 8628 device flow)

Pairing runs during **`channels add`** (§4), which prints the pairing prompt:

```
[webchannel] account "default" resolved acquisition identity: tenant=default-tenant, accountId=default-agent, saasBaseUrl=http://127.0.0.1:3951
[webchannel] Acquiring credentials for account "default" (tenant=default-tenant, saas=http://127.0.0.1:3951)
[enrollment] User code: ABCD-EFGH
[enrollment] Verification URI: http://127.0.0.1:3951/enroll?user_code=ABCD-EFGH
[enrollment] Polling for approval...
```

**Approve it** (operator action). Either:

- **curl (most reliable):**
  ```bash
  curl -X POST http://127.0.0.1:3951/approve \
    -H "authorization: Bearer $ENROLLMENT_ADMIN_TOKEN" \
    -H 'content-type: application/json' -d '{"user_code":"ABCD-EFGH"}'
  # → {"success":true,…}
  ```
- **browser:** open the **full Verification URI** (with `?user_code=…`) and click **Approve**.
  Opening bare `/enroll` shows an unfilled page — don't. Hard-refresh if you opened it before.

Success (acquisition persists creds; it does **not** open the NATS connection — that happens
later at `gateway run`):

```
[enrollment] ✓ Enrollment complete!
[webchannel] ✓ Credentials acquired for account "default" → ~/.openclaw-webchannel/default/credentials.json (peerId=…)
```

Creds are cached at `~/.openclaw-webchannel/<account>/credentials.json` (mode 0600).
Then start the gateway — it **consumes** the persisted creds, never re-enrolls:

```bash
openclaw gateway run        # connection config lives in config (§4); creds were acquired in §4
```

```
[webchannel] NATS credential source: enrolled → wss://connect.ngs.global:443
[webchannel] ✓ Connected to NATS
[webchannel] ✓ Encrypted NATS channel created
[webchannel] ✓ NATS mode plugin registered
```

> **No more runtime enroll / "Polling…" noise.** Because acquisition moved to `channels add`
> (가-1), `gateway run` no longer starts an enroll loop — the duplicate-enroll "Polling for
> approval…" noise from `registerFull` pre-warming is gone. If an account's creds are
> **missing/expired**, that account is skipped with an actionable log
> (`account "<id>" has no enrolled credentials — … Run: openclaw channels add --channel
> webchannel --account <id>`); the gateway, other accounts, and other channels stay up.

> The connection (the NATS socket) is held for as long as `gateway run` runs — exactly
> like a Telegram channel holds its connection while the gateway is up. Config = *where/how*;
> pairing = *one-time at `channels add`*; connecting = *every run*.

---

## 6. Chat from the browser

In production the chat UI is a **web page the customer hosts** (the headless `packages/client`
library embedded on their site) and the **SaaS serves the widget bundle**. The reference SaaS
server mirrors this: with `ENABLE_DEMO_UI=1` it serves the unified page (`GET /`), the browser
bundle (`GET /widget.js`), and the live enrollment list on its OWN origin — one origin for both
the approve flow and the chat. So the chat page is served **by the issuer you already run**, not a
separate web server:

```bash
# Start the SaaS issuer with the demo web surface enabled. It bundles the browser
# client into /widget.js and serves the two-panel page at /. Point DEMO_* at the
# same NATS/gateway/tenant/account your agent uses.
PORT='3951' \
SAAS_BASE_URL='http://127.0.0.1:3951' \
NATS_URL='wss://connect.ngs.global:443' \
ENABLE_DEMO_UI=1 \
DEMO_APP_HTML="$PWD/e2e/local/ci-smoke.html" \
DEMO_CLIENT_ENTRY="$PWD/packages/client/src/browser-demo-entry.ts" \
DEMO_GW_URL='' \                                            # vestigial: register-hop is the SOLE admission path (it rides NATS on the `.register` subject — no gateway is ever dialed). This var no longer selects an "auto" mode.
DEMO_TENANT='default-tenant' \
DEMO_ACCOUNT_ID='default-agent' \
node --import tsx packages/saas/reference/enrollment-server.ts
# → unified demo page at http://127.0.0.1:3951/
```

> Under `ENABLE_DEMO_UI` the human **logs in** (there is no client-declared peerId), so the
> old `DEMO_PEER_ID` no longer controls the human's identity — the server derives it. Leave
> it unset; the reference SaaS still accepts it only as a headless-harness hint.

> For a **turnkey local run** that boots the whole stack (issuer+web, NATS, gateway, enrolled
> plugin) against your real model config, just use `demo/run.sh` — it sets all of the
> above for you. `DEMO_RELAY=synadia demo/run.sh` runs the same demo over real NGS; its env
> block is the canonical demo example.

The page: approve the agent in the left panel → in the right panel **log in** as `alice` or
`bob` (password `demo`). The browser then generates keys → mints NATS creds from `issuer/nats-user`
→ mints a PoP bootstrap JWT from `issuer/bootstrap` → connects to NATS → (register hop, if any) →
chat. The **peerId is derived server-side** from the logged-in user (its `uuid`) — any
client-declared peerId is ignored — and the SaaS enforces the user↔`accountId` authz at
JWT-mint time (`canAccess` → `403`). Use the **same `tenant`+`accountId`** as the agent.

### Admission: the register hop (the only path)

- **`register-hop`** (the sole admission path; the default when `auth.strategy=jwt`): the
  browser completes a register hop as a **NATS request/reply** on the account's `.register`
  subject — there is **no HTTP route and no gateway URL**. The browser derives the register
  subject from `tenant/accountId/peerId`, proves possession of its device key (PoP — a
  signature over a single-use server nonce), the agent validates the bootstrap JWT `aud`, and
  returns the conversation key **wrapped to the device key**. This rides the same outbound NATS
  connection as chat, so the agent keeps **zero inbound listeners**. This is what the demo
  (`demo/run.sh`) uses — register-hop is fully working.
  > **History note:** register was originally an HTTP plugin route (`/webchannel/nats/register*`),
  > and on openclaw 2026.6.10 `api.registerHttpRoute` could resolve to a no-op → 404, which
  > is why older guidance told you to fall back to an unauthenticated auto-subscribe mode. Both
  > are obsolete: register moved to NATS request/reply (the 404 class is gone) and the
  > unauthenticated auto-admission mode was removed entirely — register-hop is the only path.

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
| register `/challenge` → 404 + CORS | legacy HTTP register path (`registerHttpRoute` no-op on 2026.6.10) | obsolete — register is a NATS request/reply now; ensure the client uses the current `registration` (subject-derived) path, not a `registerBaseUrl` |
| dashboard `AUTH_RATE_LIMITED` / `token mismatch` | no/!wrong `#token=`, or hitting a different gateway on the same port | use the right gateway's token; resolve the `:18789` collision (§7) |

---

## 9. Reference

**Env overrides** (take precedence over config; keep secrets out of committed config):
`WEBCHANNEL_NATS_URL`, `WEBCHANNEL_NATS_USER_JWT`, `WEBCHANNEL_NATS_USER_SEED`,
`WEBCHANNEL_NATS_CREDS`, `WEBCHANNEL_SAAS_BASE_URL`,
`WEBCHANNEL_TENANT`. (Acquisition no longer reads `WEBCHANNEL_AGENT_ID` — the wire identity
is the `accountId`, set via `channels add --account <id>`. The **login-flow demo** server is
configured with `DEMO_ACCOUNT_ID`/`DEMO_TENANT`; `WEBCHANNEL_ACCOUNT_ID` is a **headless
harness** var read by the `e2e/local/*` drivers.)

**Subjects:** messaging on `webchannel.{tenant}.{accountId}.{peerId}.{in,out}`; admission is the
separate request/reply subject `webchannel.{tenant}.{accountId}.{peerId}.register`. (Agent
subscribes `…*.in` and the `…*.register` admission subject, publishes `…*.out`; browser is the mirror.)

**Credential modes** (`nats.credentials.mode`): `enrolled` (SaaS device flow, default) ·
`static` (BYO url + user JWT + NKEY seed / `.creds` file, no issuer).

**Issuer endpoints:** `/api/enroll`, `/api/poll`, `/approve`, `/.well-known/jwks.json`.
Under `ENABLE_DEMO_UI` the browser login flow adds `/login`, `/nats-user`, `/bootstrap`
(server-derived peerId + user↔`accountId` authz at JWT-mint). The unauthenticated
`/test/nats-user` + `/test/bootstrap-jwt` are **headless-harness only** (used by
`e2e/local/run-all-real.sh` and `browser-jwt-entry.ts`) and are `404`'d whenever
`ENABLE_DEMO_UI=1`.
