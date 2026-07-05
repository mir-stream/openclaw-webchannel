# Getting Started — run WebChannel on Synadia (NGS) and attach your own openclaw

A follow-along guide: stand up the `webchannel-app` reference (SaaS backend + browser
widget) using **only the published `@mir-stream/webchannel-{saas,client}` packages**,
put the NATS relay on **Synadia Cloud / NGS**, then attach **your own openclaw agent**
and chat end-to-end.

> **Who this is for:** a developer who wants to build a WebChannel app against the
> published library and drive it with their own openclaw gateway. You never fork the
> library — you consume it.

---

## The architecture (why there is no inbound)

```
                 ┌─────────────── Synadia / NGS (managed NATS relay) ───────────────┐
                 │            wss://…   E2E-encrypted frames only (ciphertext)        │
                 └───────▲───────────────────────────────────────────────▲──────────┘
                         │ outbound WS                          outbound │ (nkey/JWT)
                         │                                                │
                ┌────────┴────────┐                              ┌────────┴─────────┐
                │  Browser widget │                              │ openclaw gateway │
                │ (WebChannelNATS │                              │  (webchannel     │
                │     Client)     │                              │     plugin)      │
                └────────┬────────┘                              └──────────────────┘
                         │ HTTPS (login / bootstrap / nats-user / enroll)
                         ▼
                ┌─────────────────┐
                │  SaaS backend    │  mints browser creds + bootstrap JWTs,
                │ (this example)   │  runs device-flow enrollment. Never a
                └─────────────────┘  browser↔agent data path.
```

**Both the browser and the agent only ever dial *outbound* to the relay.** Neither
listens for inbound connections, and **nothing ever connects to the openclaw gateway
directly** — registration itself happens *over NATS*, not over an HTTP port on the
agent. The SaaS backend is the only HTTP service, and it exists purely to issue
credentials and run enrollment; it is not on the message path. The relay only ever
sees E2E-encrypted ciphertext.

---

## Prerequisites

| Need | Why |
|---|---|
| **Node ≥ 22** | the packages target modern Node/WebCrypto (X25519/Ed25519). |
| **A GitHub `read:packages` PAT** | *Only while the registry is private* (see Step 2). `@mir-stream/*` is on GitHub Packages; classic token, scope `read:packages`. Once public, no token is needed. |
| **A Synadia / NGS account** | the managed relay. You need its **account identity** (`A…`), an **account signing-key seed** (`SA…`), and the **wss URL** (e.g. `wss://connect.ngs.global`). |
| **openclaw** installed | your agent runtime. It needs a model provider configured (so the agent can actually reply). |

> No local `nats-server` is required in Synadia mode — the relay is NGS. (A local
> `nats-server` is only used by the zero-setup *self-contained* mode; see the note at
> the end.)

---

## Step 1 — Get the example as a standalone app

The example lives inside the monorepo at `examples/webchannel-app/`. Clone the repo (you
need access to it), then **copy the example out** into a folder of its own:

```bash
git clone https://github.com/mir-stream/openclaw-webchannel.git
cp -R openclaw-webchannel/examples/webchannel-app ~/webchannel-app
cd ~/webchannel-app
```

**Why copy it out (and not just run it in place)?** Inside the monorepo,
`examples/webchannel-app` is an npm **workspace member**, so `@mir-stream/webchannel-*`
resolves through a symlink to the **local `packages/…` source** — i.e. you'd be running
local code, not the published library. Copying it to a standalone folder detaches it from
the workspace, so in Step 2 it installs the **published packages from the registry** —
which is the whole point: you consume the library exactly as an outside developer would.

> **No repo access?** The example isn't published as a standalone starter package yet, so
> today you need read access to the monorepo to get its source. (A `npm create`-style
> scaffold would remove this step — a possible follow-up.) The two **libraries** you
> depend on are already published; only this example *app* still lives in the repo.

## Step 2 — Install the published library from GitHub Packages

> **Once the packages are public you can skip the token entirely** — a public
> `@mir-stream/*` installs with just the registry line (no auth, no `.npmrc` token). The
> steps below are only needed while the registry is private.

**2a. Get a `read:packages` token.**

- **Easiest, if you use the GitHub CLI** and are already logged in: skip token creation —
  in step 2c just use `export NODE_AUTH_TOKEN=$(gh auth token)`.
- **Otherwise**, on GitHub: **Settings → Developer settings → Personal access tokens →
  Tokens (classic) → Generate new token (classic)**, tick the **`read:packages`** scope,
  generate, and copy it (looks like `ghp_…`). **Use a *classic* token — GitHub Packages
  npm rejects fine-grained tokens.**

**2b. Create a file named `.npmrc` in the app folder** (`~/webchannel-app/.npmrc`). It
points `@mir-stream` at GitHub Packages and reads the token from an env var, so **the
secret never lives in the file**:

```ini
@mir-stream:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

You can create it in one line:

```bash
cat > .npmrc <<'EOF'
@mir-stream:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
EOF
```

**2c. Export the token and install** (npm expands `${NODE_AUTH_TOKEN}` from `.npmrc`). Pin
the two packages to the published version:

```bash
export NODE_AUTH_TOKEN=$(gh auth token)         # if you use the GitHub CLI (2a option 1)
# export NODE_AUTH_TOKEN=ghp_your_token_here    # …or paste your classic token from 2a
echo "${NODE_AUTH_TOKEN:0:4} len=${#NODE_AUTH_TOKEN}"   # sanity: should print  ghp_ len=40

npm pkg set dependencies.@mir-stream/webchannel-saas=0.1.3
npm pkg set dependencies.@mir-stream/webchannel-client=0.1.3
npm install
```

> **401 Unauthorized?** The registry line worked but the token didn’t: `NODE_AUTH_TOKEN`
> is empty (the `export` didn’t run in *this* shell), still the literal
> `ghp_your_token_here` placeholder, or a fine-grained token (use a classic one). The
> `echo` line above catches all three.

Verify you actually downloaded the tarballs (not a local symlink):

```bash
readlink node_modules/@mir-stream/webchannel-saas || echo "REAL dir (downloaded, not a symlink)"
grep -m1 '"resolved".*npm.pkg.github.com' package-lock.json
# → "resolved": "https://npm.pkg.github.com/download/@mir-stream/webchannel-saas/0.1.3/…"
```

## Step 3 — Point the relay at Synadia (NGS)

Gather these from your Synadia account (Synadia Cloud → your account → NATS user / signing
keys):

```bash
export RELAY=synadia
export NATS_URL="wss://connect.ngs.global"      # your NGS websocket URL
export NATS_ACCOUNT_ID="A………"                   # managed account IDENTITY (A…)
export NATS_ACCOUNT_SIGNING_SEED="SA………"         # account SIGNING-key seed (SA…) — SECRET
```

- `NATS_ACCOUNT_SIGNING_SEED` signs the browser/agent user JWTs on behalf of your NGS
  account; it is a secret and is never persisted or logged.
- `NATS_URL` is delivered to the browser and agent *with* their minted credentials — it
  is not page config (the SaaS is the rendezvous authority for the relay URL).

## Step 4 — Run the SaaS backend

```bash
npm start        # = tsx server/index.ts
```

You should see:

```
[app] relay mode: synadia (account A1b2c3…) → wss://connect.ngs.global
[app] SaaS backend on http://127.0.0.1:4000
[app] tenant=app-tenant account=agent-dev
[app] admin token (for approving enrollments): 3f9a…      ← copy this
```

Note the **admin token** — you need it to approve the agent in Step 6. (Set `ADMIN_TOKEN`
yourself in the env to make it stable across restarts.)

## Step 5 — Open the browser widget

Open **http://127.0.0.1:4000** and log in as **`alice` / `password`**
(`server/users.ts` is a BYO-auth stub — swap in your IdP/DB later).

The widget will:
1. mint device keys + fetch a bootstrap JWT and browser NATS creds,
2. connect **outbound** to NGS and reach `connected`,
3. ~15 s later show **“⏳ waiting for agent”** — expected: no agent is attached yet, so
   the PoP `register` has no responder. Leave it here and attach openclaw next.

## Step 6 — Attach your openclaw agent

> ⚠️ **Three strings must match on both sides:** the **tenant** (`app-tenant`), the
> **SaaS URL** (`http://127.0.0.1:4000`), and the **account / JWT audience**
> (`agent-dev`). If openclaw uses a different account/audience, the agent will reject the
> browser’s bootstrap JWT. Align them: keep the SaaS defaults, or set `APP_TENANT` /
> `APP_ACCOUNT` on the server to match the account you add in openclaw.

**6a. Install the plugin** (from ClawHub):

```bash
openclaw plugins install clawhub:mir-stream/openclaw-webchannel
```

**6b. Add the channel** (device-flow enrollment). This prompts for the tenant and SaaS
base URL, then prints a **user code** and **blocks waiting for approval**:

```bash
openclaw channels add
#   → select: WebChannel
#   → WebChannel tenant id:        app-tenant
#   → WebChannel SaaS base URL:    http://127.0.0.1:4000
#   → JWT audience (advanced):     agent-dev     ← match the SaaS account
#
#   Enrollment created. user code: WXYZ-1234   (waiting for approval…)
```

> **No issuer question?** Correct — there is nothing to configure. The SaaS
> *declares* the exact JWT issuer it mints as part of the enrollment result
> (the same way it delivers the relay URL), and the agent verifies against
> that. Even a SaaS whose issuer differs from its base URL (reverse proxy,
> custom domain) attaches with zero issuer config.

**6c. Approve it** (in another terminal) — the approve route hands out tenant-wide agent
credentials, so it is **admin-gated** with the token from Step 4:

```bash
curl -X POST -H "x-admin-token: <ADMIN_TOKEN>" \
  http://127.0.0.1:4000/admin/enrollments/WXYZ-1234/approve
```

`channels add` unblocks once approved and writes the full trust/nats/saas config block
(you never hand-edit `openclaw.json`).

**6d. Run the gateway** — the agent connects **outbound** to NGS and subscribes:

```bash
openclaw gateway
```

**6e. Back in the browser**, hit **Retry**. The PoP `register` now finds a responder,
the handshake completes, and the lane goes live — type a message and your openclaw agent
replies over the E2E-encrypted NGS relay.

---

## Troubleshooting

- **Browser stuck on “waiting for agent” after `gateway` is up** → tenant/account
  mismatch (see the callout in Step 6). Confirm the SaaS logs `tenant=app-tenant
  account=agent-dev` and that the wizard used the same tenant and an audience of
  `agent-dev`.
- **`401` when approving** → wrong/missing `x-admin-token`; use the token the server
  printed at boot (or set `ADMIN_TOKEN`).
- **`npm install` 401/403** → the PAT lacks `read:packages`, or `.npmrc` is missing the
  `@mir-stream:registry` line.
- **Agent connects but never replies** → openclaw has no model provider configured. The
  webchannel plugin is transport only; the reply comes from your openclaw agent/model.
- **Browser register rejected with an opaque `unauthorized`** → the agent is verifying
  against a different JWT issuer than the SaaS mints. Two known causes: (1) the agent
  enrolled with an **older** saas/plugin version that predates SaaS-delivered issuer —
  delete `~/.openclaw-webchannel/<account>/credentials.json` and re-run `channels add`
  (re-enrollment is what delivers the issuer); (2) a stale `auth.jwt.issuer` **pin** in
  `openclaw.json` — a pin always wins over the delivered value, so remove it unless you
  set it deliberately.
- **NGS auth failures** → check `NATS_ACCOUNT_ID` (identity `A…`) vs
  `NATS_ACCOUNT_SIGNING_SEED` (signing `SA…`) are from the *same* account, and that
  `NATS_URL` is your account’s wss endpoint.
- **Multiple users sharing one transcript** → set openclaw’s `session.dmScope` to
  `per-channel-peer` (a shared/default scope pools users into one session).

---

## What’s verified vs. the frontier

- ✅ **Registry install + SaaS + browser flow** is verified: the app runs off the
  downloaded `@mir-stream/*@0.1.3` tarballs up to the `connected → waiting-for-agent`
  state, public-API-only.
- 🧭 **The openclaw attach (Step 6) is the part you drive.** It uses the same enrollment
  mechanics (`/api/enroll` → admin approve → `gateway`) that the internal `demo/` proves,
  but your openclaw environment (account naming, model provider) is yours. If a step
  doesn’t line up, the tenant/account match is almost always the cause.

---

## Appendix — zero-setup self-contained mode (no Synadia)

To try the flow with **no external relay**, unset `RELAY` (or set
`RELAY=self-contained`) and just `./run.sh` (in the monorepo) or `npm start` (standalone,
requires `nats-server` on PATH). The SaaS boots a local `nats-server` and everything else
is identical. Synadia mode is the realistic deployment; self-contained is for a quick
local spin.
