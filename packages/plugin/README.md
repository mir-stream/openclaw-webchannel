# openclaw-webchannel

The OpenClaw web chat channel plugin — embed a chat widget on a web page and talk to an
OpenClaw agent (Claude) from the browser.

> **The authoritative status lives in [`../../docs/STATUS.md`](../../docs/STATUS.md).** AC
> completion reports and seed files elsewhere describe component-level work, not end-to-end
> functionality. Where they conflict with STATUS.md, STATUS.md is correct.

## Transport

This package ships the NATS E2E plugin entry. Both browser and agent dial out to
a shared NATS relay; the agent exposes no browser-facing inbound port and the
relay sees encrypted envelopes only.

As of `e384198`, a real headless-Chromium message HAS travelled browser → NATS → this plugin →
`inbound.run` → (echo model) → back. Earlier the NATS entry assumed APIs that don't exist
(`api.http.post`, a `webchannel-nats` id, `keepAlive`) — fixed there. Register admission is now
**fully over NATS**: a register-hop account subscribes its own
`webchannel.{tenant}.{accountId}.*.register` subject and the browser drives challenge/register/
unregister via NATS request/reply on `…{peerId}.register` (the old inbound HTTP register routes
are deleted — the agent makes ONLY outbound connections). The browser client is wired to register
over this hop (`registerWithPop`). Two caveats remain: the deterministic echo
model stands in for a live LLM (by design), and the local dev harness still drives the wildcard
auto-register path (a live e2e with a real bootstrap JWT is follow-up #13). See STATUS.md.

## Status

- NATS entry (`index-nats.ts`) — **production default, cut over live** on the real gateway
  (`:18789`): enrolled via the SaaS device flow against a persistent local trust chain
  (`nats-server` + reference issuer), credentials cached at `~/.openclaw-webchannel/credentials.json`
  so restarts reconnect with no re-approval. Also has an env-gated **dev/open-NATS** path
  (`removed unauthenticated NATS flag`) that connects to a plain local `nats-server` with no enrollment —
  see [`../../e2e/local/README.md`](../../e2e/local/README.md) to reproduce browser↔agent locally.
- Defer to [`../../docs/STATUS.md`](../../docs/STATUS.md) for the current authoritative state.

## Enrollment & credentials (NATS mode)

`src/enrollment-client.ts` implements plugin-side onboarding over the **RFC 8628 device flow**
— ingress-free (outbound HTTPS only, no listening sockets, no secret pasting).

### CLI flag mapping (`channels add`)

OpenClaw's `channels add` parses a **fixed generic flag set**, and a non-bundled plugin cannot
register its own commander flags. So on the non-interactive onboarding command the identity rides
mapped generic flags — note that **the tenant id goes on `--url`, not `--base-url`**:

```
openclaw channels add --channel webchannel \
  --account <accountId>     # the on-wire identity
  --base-url <saas-url>     # → saasBaseUrl (the SaaS issuer URL)
  --url     <tenant-uuid>   # → tenant   (yes, the TENANT id — flag name is a host-CLI limitation)
```

`--url` reading "Channel setup URL" in `--help` is the host CLI's generic text; there is no
plugin-registered `--tenant`/`--saas-base-url`. `afterAccountConfigWritten` echoes the resolved
`accountId`/`tenant`/`saasBaseUrl` before enrolling so a mis-mapping is visible immediately. The
interactive `channels add` **wizard** prompts for tenant by name and avoids the flag entirely.
(The legacy `WEBCHANNEL_TENANT` env is not an onboarding alternative — it is honored only at
gateway-run time when no webchannel config exists, and is deprecated once config is present.)

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
  `saasPollUrl`, optional `accountId` (the wire identity). The private key is generated locally
  and never transmitted.

## E2E security model (admission + key establishment)

Phase 6 (multi-device) split key establishment by admission mode:

- **Register admission (production / SaaS path) — register-delivered conversation key.**
  The agent OWNS a stable per-peerId key K (`src/conversation-key-store.ts`, persisted at
  `~/.openclaw-webchannel/<account>/conversation-keys.json`, 0600). The register handler (a NATS
  request/reply on the account's `…{peerId}.register` subject) wraps K (`src/late-join-decryptor.ts`
  — X25519 ECDH + HKDF-SHA256 `webchannel-key-wrap-v1` + ChaCha20-Poly1305) to the device key
  attested in **that request's** verified JWT `cnf` claim and returns it in the register reply.
  There is **no `registration subject` on this path** — the keyStore-mode channel neither subscribes nor
  answers it — so an active relay cannot substitute keys: K only ever travels **wrapped to a
  JWT-attested device key**, and the wrap target comes from the SaaS-signed JWT `cnf`, not from
  anything the transport controls. So even though register now rides NATS (visible to the relay),
  the relay/observer sees only ciphertext + a wrapped key it cannot open, and cannot coax K to be
  wrapped to a key it holds. This resolves review finding **C2** structurally for register
  deployments. One user's
  devices all receive the SAME K, so multi-device decryption works and a second device no longer
  overwrites the first one's key.
  - **`cnf` claim verification** (`src/jwt.ts`): after the bootstrap JWT's signature is verified,
    `verifyJwt` extracts the RFC 7800 `cnf.jwk` confirmation claim. The claim must be
    `kty: "OKP"`, `crv: "X25519"`, with a 32-byte `x`; a `d` (private) field, wrong length, or
    any malformed `cnf` causes the **whole JWT to be rejected** (fail-closed). The validated key
    surfaces as `JwtIdentity.devicePublicKey`; the register handler REQUIRES it (401 without) and
    wraps per-request. There is deliberately **no cross-request pinned-key store** — the old
    peerId-keyed pin store collided two devices of one user and was removed (with the never-wired
    `registration-verifier.ts`) in Phase 6 W7.
  - **Session scoping caveat:** a register account serves many users, so openclaw's
    `session.dmScope` MUST be `"per-channel-peer"` (or the per-account variant). The default
    `"main"` collapses every peer into ONE agent session, and the register history snapshot then
    delivers the shared transcript to every user (re-sealed to each requester's own K —
    encryption cannot prevent a scoping leak). The plugin warns loudly at startup when it detects
    this (`crossUserHistoryWarning`).
- **Authenticated admission (`admission:register-hop`, bring-your-own-NATS) — legacy per-device X25519
  registration, unchanged.** The registration is unauthenticated (any tenant-creds holder can complete
  it), so auto mode gives confidentiality against a *passive* relay only; an *active* relay MITM
  can substitute keys. Acceptable **only while the relay is operated by a trusted party** (your
  own `nats-server` or your own Synadia account). Migrating auto deployments to register
  admission is the follow-up that closes this.
- **No anonymous admission:** the `anonymous` auth strategy throws at plugin load
  (`makeAnonymousVerifier` never returns a verifier) — connections must use `jwt`.

**Threat model (register path):** relay substitutes a key → impossible, K is wrapped to the
JWT-attested `cnf` key and never negotiated on the wire; attacker skips bootstrap → no admission
(register requires a verified JWT + PoP); forged `cnf` → JWT signature verification fails;
tampered wrapped key → Poly1305 reject, client fails closed (terminal error, no registration
downgrade). **Auto path:** active relay MITM remains possible (see above). **Out of scope:** SaaS
key compromise / revocation (deferred to re-enrollment); K rotation (deferred — fixed key first);
real-time allowlist authz is a core-delegated stub.

## Bring-your-own NATS (e.g. Synadia Cloud / NGS)

The agent's NATS connection is decoupled from the SaaS issuer along **two orthogonal
axes**, so you can point the plugin at **any** NATS with just a URL + static user
credentials — **no SaaS issuer required**.

- **Axis A — credential source** (`src/nats-credential-source.ts`): how the *agent*
  authenticates to NATS. One of `open` (dev, no auth), `static` (BYO-NATS — url +
  user JWT + NKEY seed, or a `.creds` file, given directly), or `enrolled` (the SaaS
  device-flow, still the default). The plugin is *given* static creds; it never mints
  them (no import from `packages/saas`).
- **Axis B — peer admission** (`src/nats-admission.ts`): which browser peers the agent
  serves. `register-hop` (SaaS bootstrap JWT + PoP) or `auto` (subscribe the
  tenant/agent wildcard; serve any peer that completes the authenticated registration **and**
  passes the `dmSecurity` allowlist). Static creds default to `auto`. Security here
  rests on **NATS subject permissions + the allowlist + E2E encryption** — not on an
  issuer. E2E encryption stays fail-closed regardless of source.

### Agent (static creds, no issuer)

```jsonc
// channels.webchannel
{
  // NO `auth` block needed: static creds resolve admission to "auto", and JWT
  // verification (`assertJwtAuthConfig` + the register-path `verifyIdentity`)
  // only runs for the "register-hop" admission mode.
  // Browser admission here = NATS subject permissions + authenticated registration
  // (+ an optional `dmSecurity` allowlist). The `jwt` register-hop strategy is
  // the only alternative; it is INERT on this static/auto NATS path.
  "nats": {
    "url": "wss://connect.ngs.global",
    "credentials": {
      "mode": "static",
      // Prefer env/file over inlining secrets:
      "userJwt":  { "env": "WEBCHANNEL_NATS_USER_JWT" },
      "userSeed": { "env": "WEBCHANNEL_NATS_USER_SEED" }
      // …or point at a standard NATS .creds file instead:
      // "credsFile": "/etc/openclaw/synadia.creds"
    }
    // admission defaults to "auto" for static creds; override with
    // "admission": "register-hop" if you run the SaaS JWT bootstrap.
  }
}
```

Env overrides (take precedence over config) — secrets need not live in committed config:

| Env var | Meaning |
|---------|---------|
| `WEBCHANNEL_NATS_URL` | NATS WebSocket URL |
| `WEBCHANNEL_NATS_USER_JWT` | static user JWT |
| `WEBCHANNEL_NATS_USER_SEED` | static user NKEY seed (`SU…`) |
| `WEBCHANNEL_NATS_CREDS` | path to a NATS `.creds` file (JWT + seed) |
| `removed unauthenticated NATS flag` | dev open-NATS (no auth) |
| `WEBCHANNEL_SAAS_BASE_URL` | enrolled-mode SaaS base URL |

### Browser (natsCredentials, no registration)

```ts
new WebChannelNatsClient({
  url: "wss://connect.ngs.global",
  accountId, tenant, peerId,
  // No bootstrap `jwt` and no `registration` — the bootstrap JWT is now optional
  // and only needed for the SaaS register-hop path.
  natsCredentials: {
    userJwt,       // browser-scoped NATS user JWT
    userSeedRaw,   // base64url of the raw 32-byte Ed25519 seed
  },
});
```

> **Synadia permissions:** the static user must have **pub + sub** permission on the
> `webchannel.<tenant>.<accountId>.*` subjects (the agent subscribes to `…*.in` /
> `…*registration subject` and publishes `…*.out`; the browser is the mirror). Without the
> wildcard sub permission the agent's `auto` admission cannot receive peers.

## NATS subject namespace

`src/nats-channel.ts` routes per-peer over tenant- and account-scoped subjects:

```
webchannel.{tenant}.{accountId}.{peerId}.in    # browser → agent (plugin subscribes)
webchannel.{tenant}.{accountId}.{peerId}.out   # agent → browser (plugin publishes)
```

Each peer (browser session) gets its own subject pair; tenant isolation is enforced by the NATS
user credentials' pub/sub permissions minted during enrollment.

> **Handling agent vs. wire identity.** The `accountId` is the on-wire/admission identity
> (the deployment). Which OpenClaw agent actually answers is **decoupled** and selected via
> `openclaw agents bind --bind webchannel:<accountId> --agent <agent>` (telegram-like) — not a
> per-account config `agentId`. Inbound routing calls `resolveAgentRoute({ accountId, … })`,
> which honours those bindings.

## Develop / test

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest run
```

**Note:** this package currently has **no `build` script** (only `test` and `typecheck` in
`package.json`); the plugin is loaded as TypeScript via OpenClaw's plugin loader. Packaging /
publish to ClawHub is a known open question — see `../../docs/PACKAGING.md` and STATUS.md.

The plugin serves no static UI and no inbound
HTTP routes at all: register admission (`register-hop` mode) rides NATS request/reply on the
account's `webchannel.{tenant}.{accountId}.{peerId}.register` subject, so the agent makes only
outbound connections. A consumer wires the headless `packages/client` library
into their own page (see that package's README).
