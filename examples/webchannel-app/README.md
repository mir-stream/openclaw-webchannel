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
single target is the server's `ACCOUNT_ID`, authorized server-side (`canAccess`).
The JWT `aud`, NATS subject account, and returned agent pin all refer to that same
`(TENANT, ACCOUNT_ID)` tuple. A multi-tenant integrator must authorize the full
`(user, tenant, accountId)` tuple. Without this gate the server would be an
unauthenticated oracle minting SaaS-signed bootstrap JWTs for an attacker-chosen
account or victim peer.

## Run

```bash
./run.sh          # builds saas+client (dist is gitignored), boots SaaS + nats-server
# then open http://127.0.0.1:4000 and log in as  alice / password
```

Requires `node >= 22` and `nats-server` on PATH.

## Relay modes

The relay is chosen by the `RELAY` env var. Both modes are **zero-inbound**: the
browser and the openclaw agent each connect **outbound** to the relay; nothing in
this app or the agent listens for an inbound connection.

- **`self-contained`** (default — unset `RELAY`, or `RELAY=self-contained`): the
  app boots a **local `nats-server`** (`server/nats.ts`) and mints creds signed by
  the trust chain's own account. Zero setup; requires `nats-server` on PATH. This
  is the mode `./run.sh` and the smoke test use.

- **`RELAY=synadia`**: the relay is **Synadia Cloud / NGS** — a managed
  `nats-server`. No local `nats-server` is booted; the SaaS mints creds signed by
  a managed-account **signing key**, and the browser + agent both connect outbound
  to the NGS wss URL. Requires three env vars (the server throws a clear startup
  error naming any that are missing):

  | Var | Meaning |
  |-----|---------|
  | `NATS_URL` | the NGS relay wss URL, e.g. `wss://connect.ngs.global` (delivered to browser + agent with the minted creds) |
  | `NATS_ACCOUNT_ID` | the managed NGS account identity public key (`A…`) |
  | `NATS_ACCOUNT_SIGNING_SEED` | the account signing-key seed (`SA…`) — **SECRET**, never logged (only a short prefix appears in the boot line) and never persisted to the trust-chain file |

  ```bash
  RELAY=synadia \
    NATS_URL=wss://connect.ngs.global \
    NATS_ACCOUNT_ID=A... \
    NATS_ACCOUNT_SIGNING_SEED=SA... \
    ./run.sh
  ```

  In synadia mode the boot line reads
  `[app] relay mode: synadia (account A1b2…) → wss://…`; in self-contained it reads
  `[app] relay mode: self-contained (local nats-server ws://…)`.

## The no-agent end state

This app deliberately does **not** boot openclaw — attaching an agent is *your*
domain. With no agent attached, the browser:

- reaches `status: "connected"` (the NKEY NATS auth succeeds), then
- ~15s later, after the bounded PoP `register` attempts time out with no
  responder, treats the agent-offline condition as transient and enters
  `status: "reconnecting"` instead of a terminal error. The client keeps
  retrying until an agent appears.

## Attach an openclaw agent

`run.sh` prints the exact commands. In short: point the webchannel plugin's SaaS
URL at this server, `openclaw channels add webchannel` (device-flow enroll),
approve via `POST /admin/enrollments/<code>/approve`, then `openclaw gateway`.
Once the agent subscribes, the PoP register completes and the lane goes live.

The approve route returns **tenant-wide agent credentials**, so it is
**admin-gated**: it requires `Authorization: Bearer <token>` equal to
`ENROLLMENT_ADMIN_TOKEN`. The routes fail closed with 503 when the variable is
unset. Approve with:

```bash
curl -X POST -H "Authorization: Bearer <ENROLLMENT_ADMIN_TOKEN>" \
  http://127.0.0.1:4000/admin/enrollments/<USER_CODE>/approve
```

`POST /api/enroll` / `POST /api/poll` stay open (they only create/poll a pending
code and return no creds) — add a rate-limit in production.

`server/users.ts` is a **BYO-auth stub** — replace it with your IdP/DB.
