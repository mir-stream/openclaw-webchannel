# openclaw-webchannel

The OpenClaw web chat channel plugin — embed a chat widget on a web page and talk to an
OpenClaw agent (Claude) from the browser.

> **The authoritative status lives in [`../../docs/STATUS.md`](../../docs/STATUS.md).** AC
> completion reports and seed files elsewhere describe component-level work, not end-to-end
> functionality. Where they conflict with STATUS.md, STATUS.md is correct.

## Two transports

This package ships two plugin entries:

| Entry | Mode | Status |
|---|---|---|
| `index.ts` | **Gateway-WS** — browser connects via a WebSocket upgrade on the gateway's own port | ✅ **Works end-to-end today** (browser ↔ OpenClaw ↔ Claude) |
| `index-nats.ts` | **NATS E2E** — both sides connect to a shared NATS bus; relay sees ciphertext only | ✅ **Run live (`e384198`)** — real browser ↔ NATS ↔ this plugin in a real openclaw gateway ↔ `inbound.run` ↔ back, encrypted, via the `e2e/local` harness (echo model). Not yet in the CI gate. |

As of `e384198`, a real headless-Chromium message HAS travelled browser → NATS → this plugin →
`inbound.run` → (echo model) → back. Earlier the NATS entry assumed APIs that don't exist
(`api.http.post`, a `webchannel-nats` id, `keepAlive`) — fixed there. The plain-HTTP register
routes (`/webchannel/nats/register*`) are now **served live** too: they were silently dropped
because `registerFull` called `api.registerHttpRoute` *after* `await`-ing the NATS connect, and
openclaw only honors route registration during the **synchronous** `registerFull` window — the
fix registers them up front (handlers read live state via a holder). This was *not* an openclaw
limitation on plain-HTTP routes; those dispatch fine. Two caveats remain: the deterministic echo
model stands in for a live LLM (by design), and the browser dev harness still uses wildcard
auto-register rather than calling the HTTP register hop. See STATUS.md.

## Status

- Gateway-WS channel: works (run it via an OpenClaw gateway with this plugin loaded in WS mode).
  This is the shipped default entry (`package.json` → `openclaw.extensions = ["./index.ts"]`).
- NATS entry (`index-nats.ts`): **live-verified** in a real openclaw gateway (`e384198`). It has an
  enrolled-creds path (SaaS device flow, default) AND an env-gated **dev/open-NATS** path
  (`WEBCHANNEL_NATS_DEV_OPEN=1`) that connects to a plain local `nats-server` with no enrollment —
  see [`../../e2e/local/README.md`](../../e2e/local/README.md) to reproduce browser↔agent locally.
- Defer to [`../../docs/STATUS.md`](../../docs/STATUS.md) for the current authoritative state.

## Enrollment & credentials (NATS mode)

`src/enrollment-client.ts` implements plugin-side onboarding over the **RFC 8628 device flow**
— ingress-free (outbound HTTPS only, no listening sockets, no secret pasting).

```ts
import { EnrollmentClient } from "./src/enrollment-client.js";

const client = new EnrollmentClient({
  saasEnrollUrl: "https://saas.example/api/enroll",
  saasPollUrl:   "https://saas.example/api/poll",
  tenant: "tenant-123",
});

const enrollment = await client.enroll();   // first boot: device flow; restart: load creds
const identityKey = client.getIdentityKey(); // X25519 KeyPair
const creds       = client.getNatsCredentials();
const peerId      = client.getPeerId();
```

`src/enrolled-nats-connection.ts` wraps enrollment + NATS connect in one call
(`createEnrolledNatsConnection(...)`), returning `{ transport, identityKey, enrollment, tenant }`.

**Flow:** first boot generates an X25519 identity key, POSTs to `/enroll`, surfaces the
`user_code` + verification URI, polls `/poll` (RFC 8628 minimum 5s interval) until the operator
approves, then receives and persists NATS user credentials. On restart it loads the stored
credentials and skips enrollment.

**Credential storage:**
- **Location:** `~/.openclaw-webchannel/credentials.json` (override via `credentialPath`)
- **Permissions:** written with mode `0o600` (owner read/write only)
- **Shape** (`PluginCredentials`): `identityKey { publicKey, privateKey }` (base64url X25519),
  optional `enrollment { creds, peerId, jwksUrl, bootstrapUrl }`, plus `tenant`, `saasEnrollUrl`,
  `saasPollUrl`, optional `agentId`. The private key is generated locally and never transmitted.

## E2E security model (admission + handshake)

The agent admits **only SaaS-attested device keys** and detects relay MITM at handshake time.

- **`cnf` claim verification** (`src/jwt.ts`): after the bootstrap JWT's signature is verified,
  `verifyJwt` extracts the RFC 7800 `cnf.jwk` confirmation claim. Types `CnfJwk` / `CnfClaim`;
  the validated device key surfaces as `JwtIdentity.devicePublicKey`. The claim must be
  `kty: "OKP"`, `crv: "X25519"`, with a 32-byte `x`; a `d` (private) field, wrong length, or any
  malformed `cnf` causes the **whole JWT to be rejected** (fail-closed). A JWT with no `cnf` is
  allowed (backward compatibility).
- **Pinned device-key store** (`src/auth.ts`): on successful JWT admission the attested key is
  pinned by `peerId` via `storePinnedDeviceKey` / `getPinnedDeviceKey` /
  `clearPinnedDeviceKeys` / `clearPinnedDeviceKeyForPeer`.
- **Constant-time handshake check** (`src/handshake-verifier.ts`): `verifyDeviceKey` and
  `parseAndVerifyHandshake` compare the key a peer presents against the pinned value using
  constant-time byte-equality; a mismatch (or missing pin, or bad length) throws
  `HandshakeMitmError` and aborts the handshake before any ECDH.
- **No anonymous admission:** the `anonymous` auth strategy throws at plugin load
  (`makeAnonymousVerifier` never returns a verifier) — connections must use `jwt` or
  `hmac-ticket`.

**Threat model (handled):** relay substitutes the device key → caught by the handshake compare;
attacker skips bootstrap → no admission without a SaaS-attested key; forged `cnf` → JWT signature
verification fails; timing oracle → constant-time compare. **Out of scope:** SaaS key compromise
/ revocation (deferred to re-enrollment); real-time allowlist authz is a core-delegated stub.

## NATS subject namespace

`src/nats-channel.ts` routes per-peer over tenant- and agent-scoped subjects:

```
webchannel.{tenant}.{agentId}.{peerId}.in    # browser → agent (plugin subscribes)
webchannel.{tenant}.{agentId}.{peerId}.out   # agent → browser (plugin publishes)
```

Each peer (browser session) gets its own subject pair; tenant isolation is enforced by the NATS
user credentials' pub/sub permissions minted during enrollment.

## Develop / test

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest run
```

**Note:** this package currently has **no `build` script** (only `test` and `typecheck` in
`package.json`); the plugin is loaded as TypeScript via OpenClaw's plugin loader. Packaging /
publish to ClawHub is a known open question — see `../../docs/PACKAGING.md` and STATUS.md.

The plugin serves no static UI. It exposes the `/webchannel/ws` WebSocket route; a consumer
wires the headless `packages/client` library into their own page (see that package's README).
