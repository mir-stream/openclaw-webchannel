# `webchannel-app` — public-API reference

A runnable WebChannel app (SaaS backend + browser client) built with **only** the
published public API of `@mir-stream/webchannel-saas` and
`@mir-stream/webchannel-client`. Every library import is by package **name**;
there are **zero** relative `../packages/` or deep-subpath imports (enforced by
`test/no-internal-imports.test.mjs`). This is the *canonical reference* for the
production trust flow — the red-team `demo/` reaches into internal source and is
not a consumer.

## What it shows

The full browser connect flow, public-API-only:

1. **login** → server-derived stable `peerId` (the session uuid).
2. **device keys** — X25519 (ECDH, non-extractable private) + Ed25519 PoP
   (`generateDevicePopKeyPair()`).
3. **`POST /bootstrap`** → RS256 bootstrap JWT signed via `createBootstrapIssuer`.
4. **`POST /nats-user`** → browser NATS credentials via `issueBrowserCredentials`.
5. **`new WebChannelNATSClient({ natsCredentials, registration })`** → connect.

Server side (`server/index.ts`, all `@mir-stream/webchannel-saas`):
`loadOrCreateTrustChain` → boot `nats-server` (`server/nats.ts`) →
`createBootstrapIssuer` + `new DeviceFlowEnrollment(...)` → HTTP routes.

### Security (N1)

`POST /bootstrap` and `POST /nats-user` are **session-gated**. The `peerId` is
**always** the authenticated session uuid — a body `peerId` is ignored — and the
`accountId` is authorized server-side (`canAccess`). Without this gate the server
would be an unauthenticated oracle minting SaaS-signed bootstrap JWTs for any
attacker-chosen account / victim peer.

## Run

```bash
./run.sh          # builds saas+client (dist is gitignored), boots SaaS + nats-server
# then open http://127.0.0.1:4000 and log in as  alice / password
```

Requires `node >= 22` and `nats-server` on PATH.

## The no-agent end state

This app deliberately does **not** boot openclaw — attaching an agent is *your*
domain. With no agent attached, the browser:

- reaches `status: "connected"` (the NKEY NATS auth succeeds), then
- ~15s later the PoP `register` request times out (no responder) → the wrapper
  reports a **terminal** `status: "error"` with message
  `"[nats-client] request timeout"`.

The app classifies that specific error as a graceful **"⏳ waiting for agent"**
state (not a red error box) with a **Retry** button. **Retry is a full re-auth**
(fresh device keys + `/bootstrap` + `/nats-user` + new client) because the
bootstrap JWT is short-lived (~300s) — re-creating the client alone could present
an expired JWT.

## Attach an openclaw agent

`run.sh` prints the exact commands. In short: point the webchannel plugin's SaaS
URL at this server, `openclaw channels add webchannel` (device-flow enroll),
approve via `POST /admin/enrollments/<code>/approve`, then `openclaw gateway`.
Once the agent subscribes, the PoP register completes and the lane goes live.

The approve route returns **tenant-wide agent credentials**, so it is
**admin-gated**: it requires an `x-admin-token` header (or
`Authorization: Bearer`) equal to `ADMIN_TOKEN`. Set `ADMIN_TOKEN` in the env, or
let the server auto-generate one and print it at boot
(`[app] admin token (for approving enrollments): …`). Approve with:

```bash
curl -X POST -H "x-admin-token: <ADMIN_TOKEN>" \
  http://127.0.0.1:4000/admin/enrollments/<USER_CODE>/approve
```

`POST /api/enroll` / `POST /api/poll` stay open (they only create/poll a pending
code and return no creds) — add a rate-limit in production.

`server/users.ts` is a **BYO-auth stub** — replace it with your IdP/DB.
