# @openclaw/webchannel-saas

Headless SaaS trust-chain core + reference harness for the WebChannel NATS relay.

> **Status:** the components in this package (`setupTrustChain`, device-flow
> enrollment, tenant-scoped NATS user-cred minting) are built and tested in
> isolation — including against a real `nats-server`. They are **not** a working
> end-to-end feature on their own. See [`../../docs/STATUS.md`](../../docs/STATUS.md)
> for the authoritative, project-wide status (it supersedes any "AC ✅ / 100%"
> claim you may find elsewhere). The headline gap: a browser message has never
> yet travelled the full NATS path into the agent and back.

## Overview

The SaaS is the **single trust anchor** for the WebChannel control plane. This
package does the one-time offline initialization of that trust root, plus the
runtime device-flow enrollment that mints per-tenant NATS credentials.

Two pieces of public API:

- `setupTrustChain` — offline, once: emits the NATS operator/account JWTs,
  resolver config, and the JWKS document.
- `DeviceFlowEnrollment` — runtime: RFC 8628 device flow that enrolls plugins
  and issues tenant-scoped NATS user credentials.

Zero new crypto dependencies in the core: it uses only `globalThis.crypto`
(Web Crypto), so it runs on Node 18+, Cloudflare Workers, and modern browsers.

## `setupTrustChain`

Generates the complete SaaS trust-chain artifacts:

**PRIVATE** (`SaasTrustChainPrivate`, SaaS-only infrastructure):
- RS256 private key (PKCS#8 PEM) — signs bootstrap JWTs
- NATS account signing seed (NKEY, `SA…`) — signs NATS operator/account JWTs

**PUBLIC** (`NatsAccountConfig` + `JwksDocument`, for nats-server + JWKS endpoint):
- NATS operator JWT (signed by operator NKEY)
- NATS account JWT (signed by operator NKEY)
- Resolver config (maps account public NKEY → account JWT; memory-resolver format)
- JWKS document (RSA public key for bootstrap-JWT verification)
- `kid` — a UUID minted per invocation, embedded in JWT headers for JWKS lookup

```typescript
import { setupTrustChain } from '@openclaw/webchannel-saas';

const trustChain = await setupTrustChain({
  operatorName: 'my-saas-operator',
  accountName: 'tenant-123',
  rsaKeySize: 2048, // optional, default 2048
});

// Store trustChain.private securely (SaaS-only)
// Load trustChain.natsConfig into nats-server
// Publish trustChain.jwks at the JWKS endpoint
```

### Key generation params

- **RSA**: Web Crypto `generateKey` with `RSASSA-PKCS1-v1_5` + SHA-256,
  configurable modulus (default 2048). Private exported PKCS#8 PEM; public
  exported as a JWK for the JWKS endpoint.
- **NATS NKEY**: Ed25519 keypair (X25519 fallback for environments without
  Ed25519), encoded in the NATS base32 alphabet (`CFH23567PR89JKLMNPQTUVWXYZ456789`).
  Account seed is `SA…`; user seeds (see enrollment) are `U…`.

## JWKS / JWT formats

**JWKS document** (`JwksDocument` → published at `/.well-known/jwks.json`) holds
RSA public keys as standard JWKs; the `keys` array allows future rotation:

```jsonc
{ "keys": [ { "kty": "RSA", "kid": "<uuid>", "alg": "RS256", "use": "sig",
             "n": "<base64url modulus>", "e": "AQAB" } ] }
```

**NATS operator JWT** (`NatsOperatorClaims`) — root of the NATS trust chain,
signed by the operator NKEY: `iss`/`sub` = operator public NKEY, `name`,
optional `nats.server`.

**NATS account JWT** (`NatsAccountClaims`) — signed by the operator NKEY,
one per tenant: `iss` = operator public NKEY, `sub` = account public NKEY,
`name` = account/tenant ID, `nats.limits` (unlimited by default).

## Device-flow enrollment (RFC 8628)

`DeviceFlowEnrollment` lets an **ingress-free** plugin onboard without secret
pasting: the plugin dials out, an operator approves once via a web UI, and the
plugin receives NATS credentials it persists locally for re-connection.

### State machine

```
plugin                              SaaS                         operator
  │ POST /enroll (agentPublicKey,    │                              │
  │   tenant, accountId)             │                              │
  │ ───────────────────────────────►│  create EnrollmentRecord     │
  │ ◄─────────────────────────────── │  status=pending              │
  │   device_code, user_code,        │                              │
  │   verification_uri[_complete],   │   ── shows user_code ──►      │
  │   expires_in, interval           │                              │ visits
  │                                  │                              │ verification_uri
  │ POST /poll (device_code)         │                              │ Approve / Deny
  │ ──── every `interval`s ─────────►│  pending → approving       │ ◄────
  │ ◄── 400 authorization_pending ── │    → approved | denied      │
  │ ◄── 200 EnrollmentResult ─────── │  on approve: mint NATS creds │
  │     (creds, peerId, jwksUrl,     │  + peerId                    │
  │      bootstrapUrl)               │                              │
```

State: `pending → approving → approved`, with `pending|approving → denied`
and eligible non-terminal records → `expired`. Approval claims carry leases;
the repository clock is authoritative for leases, expiry, and retention. The
process-local approval lock is advisory only: adapters must atomically fence
claims and commit the enrollment, active key, and history together. Denying an
`approving` record invalidates its claim, so a late commit cannot reverse the
operator decision. Approved records are not expired by polling and remain
available through `approvedAt + retentionMs` (equality retained) for boundary
poll grace and idempotent commit recovery.

Codes are short-lived
(`expirationSeconds`, default 600s), the poll interval is enforced at a minimum
of 5s per RFC 8628 (`pollIntervalSeconds`, default 5). Device codes are 256-bit
(32-byte) crypto-random, base64url; user codes are `XXXX-XXXX` drawn from an
unambiguous alphabet (`BCDEGHKMNPQRSTVWXZ`).

On first boot the plugin generates its X25519 identity key and sends the public
key in `EnrollmentRequest.agentPublicKey`; the SaaS keeps it to embed in the
bootstrap JWT's `cnf.jwk` claim. The private half never leaves the plugin. On
restart the plugin reloads stored creds and reconnects with no re-pairing.

### Types

Exported from `device-flow-types.ts` for type-safety across the SaaS ↔ plugin
boundary:

- `EnrollmentRequest` — `{ agentPublicKey, tenant, accountId }`
- `EnrollmentResponse` — `device_code`, `user_code`, `verification_uri`,
  `verification_uri_complete`, `expires_in`, `interval`
- `PollRequest` — `{ device_code }`
- `PollResponse` — `EnrollmentResult` (200) or `{ error, error_description? }` (400)
- `PendingEnrollment` — internal enrollment state (incl. `status`, `natsCreds?`, `peerId?`)
- `NatsUserCredentials` — `userJwt`, `userSeed` (`U…`), `permissions?.{pub,sub}`
- `EnrollmentResult` — `{ creds, peerId, jwksUrl, bootstrapUrl }`
- `DeviceFlowError` — `authorization_pending` | `authorization_declined` |
  `expired_token` | `invalid_device_code` | `access_denied`

Enrollment state and agent-key history share the required `EnrollmentRepository`
atomic boundary. `MemoryEnrollmentRepository` must be selected explicitly and is
only a single-process reference; production should provide a conforming durable
repository (for example PostgreSQL or a suitably co-located Redis deployment).

## Tenant-scoped NATS permissions

On approval the enrollment service mints a NATS **user** JWT (signed by the SaaS
account NKEY) whose claims scope the plugin to one tenant's subject namespace:

```jsonc
{ "iss": "<account public NKEY>", "name": "user-<tenant>-<agent>",
  "sub": "<U… user public NKEY>",
  "nats": {
    "pub": { "allow": ["webchannel.<tenant>.outbound.>"] },
    "sub": { "allow": ["webchannel.<tenant>.inbound.>"] } } }
```

### Subject namespace

```
webchannel.{tenant}.{service}.>
  ├── outbound.>  → plugin → browser (agent messages)   [pub]
  ├── inbound.>   → browser → plugin (user messages)     [sub]
  ├── history.>   → history replay
  └── approval.>  → approval coordination
```

### Cross-tenant isolation

Each tenant's permissions are bounded by its subject prefix, so cross-tenant
access is structurally impossible. This is enforced by a **real** `nats-server`
(memory resolver loaded from `setupTrustChain` output), not a fake broker — a
tenant-A client attempting `PUB webchannel.tenant-b.outbound.test` gets a real
`-ERR 'Permissions Violation for Publish to "webchannel.tenant-b.outbound.test"'`.
Covered by `src/nats-permissions-realserver.test.ts` (spawns nats-server with JWT
auth) and `src/nats-user-jwt.test.ts` (unit-level JWT/permission shape).

## Reference harnesses

These live under `reference/` and are **for demonstration only — NOT production**.
They use plain Node `http` with no TLS and an in-memory store. Operator actions
require `Authorization: Bearer $ENROLLMENT_ADMIN_TOKEN` and fail closed when the
variable is unset; a real SaaS must add TLS, authentication, a persistent store, and production error
handling.

- `reference/setup-trust-chain.ts` — CLI that runs `setupTrustChain` and
  persists `saas-private.json` (private keys, `0o600`), `nats-config.json`
  (operator/account JWT + resolver), and `jwks.json`.
- `reference/enrollment-server.ts` — HTTP server exposing the device flow:
  - `POST /api/enroll` — start enrollment
  - `POST /api/poll` — poll for approval
  - `GET  /enroll` — operator approval UI (`reference/enrollment-ui.html`)
  - `POST /approve` / `POST /deny` / `POST /revoke` — operator action; requires `ENROLLMENT_ADMIN_TOKEN`
  - serves `bootstrapUrl` as `/bootstrap`, JWKS as `/.well-known/jwks.json`

Run the reference operator endpoints with an explicit token:

```bash
ENROLLMENT_ADMIN_TOKEN=dev-only-token node --import tsx packages/saas/reference/enrollment-server.ts
curl -X POST http://127.0.0.1:3000/approve \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer dev-only-token' \
  -d '{"user_code":"ABCD-EFGH"}'
```
- `reference/bootstrap-server.ts` — reference bootstrap-JWT issuance endpoint.

## Installation notes

If you hit npm registry permission issues in some environments, either use an
alternative registry (`npm install --registry=https://registry.yarnpkg.com`) or
install dev deps manually (`npm install typescript @types/node vitest`).

## Testing

```bash
npm test
```

Covers RSA/NKEY generation and PEM/format checks, operator/account JWT claims,
resolver-config mapping, JWKS shape, private/public separation, the full
device-flow enrollment paths, tenant-scoped permission claims, and real-server
cross-tenant isolation (the real-server tests auto-skip if the `nats-server`
binary is absent). For project-wide test/status framing — including the
coverage gap that the green suite does **not** cover (the full live NATS chain) —
see [`../../docs/STATUS.md`](../../docs/STATUS.md).

## Security considerations

1. **Private material** — `saas-private.json` (RSA private key + NKEY seed) must
   stay inside SaaS infrastructure: env vars (dev), a secret manager
   (AWS Secrets Manager, Vault), or an HSM (production).
2. **Public configuration** — `nats-config.json` and `jwks.json` contain only
   public keys: safe to commit to infra repos, publish at JWKS endpoints, and
   share with ops for nats-server config.
3. **Key rotation** — deferred per spec. Re-run `setupTrustChain`, then update
   SaaS private keys, nats-server public config, the JWKS endpoint, and re-enroll
   agents.

## Implementation note

### Durable enrollment repositories

Production deployments implement the exported `EnrollmentRepository` and run
`runEnrollmentRepositoryConformance` against independent clients connected to
the real shared backend. The core and fault suites are mandatory for every
adapter; the controlled-clock suite is recommended. `commitApproval` must place the enrollment row, active
key slot, and append-only history in one transaction; claim, deny, expiry,
reconciliation, register, and revoke are atomic read/modify/write operations.

In PostgreSQL, use unique device/user-code constraints, lock the enrollment row
with `SELECT … FOR UPDATE`, lock the account slot (row or advisory lock), and
retry serialization failures. In Redis, perform each transition in Lua. Redis
Cluster is unsuitable unless enrollment and registry keys are deliberately
co-located in one hash slot; their natural device-code and account keys do not
share a slot. Configure retention explicitly and retain records while
`now <= base + retentionMs`; a practical floor is two poll intervals plus the
largest expected clock skew. The bundled memory implementation demonstrates
single-process semantics only and is not evidence of multi-process durability.

The factory's `clock` capability is optional. When it is absent, the convenience
runner executes core and fault cases and emits an explicit `SKIP` message for
every clock case; its returned report also lists every skipped case. Calling an
exported clock case directly without that capability fails with a named
`requires the optional controlled clock capability` error. Provide the clock to
certify lease, expiry, retention-boundary, and time-dependent race behavior.

```ts
const report = await runEnrollmentRepositoryConformance({
  create: async ({ retentionMs, autoSweep }) => ({
    repo: await openRepository({ retentionMs, autoSweep }),
    close: async () => closeRepository(),
  }),
});
// report.skipped is non-empty when controlled-clock cases were not certified.
```

This Phase-B build uses a simplified (non-production) NKEY signature path while
keeping the correct claim/permission structure for NATS compatibility;
production should sign via the official NATS JWT libraries. NATS user-JWT minting
lives in `src/device-flow-enrollment.ts` — there is no standalone
`nats-user-jwt.ts` module (only its test file `src/nats-user-jwt.test.ts`).
