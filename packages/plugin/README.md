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
over this hop (`registerWithPop`), and the live harnesses exercise it end-to-end. One caveat
remains: the deterministic echo model stands in for a live LLM (by design); a real
browser/Playwright variant against a hosted SaaS issuer is follow-up #13. See STATUS.md.

## Status

- NATS entry (`index-nats.ts`) — **production default, cut over live** on the real gateway
  (`:18789`): enrolled via the SaaS device flow against a persistent local trust chain
  (`nats-server` + reference issuer), credentials cached at `~/.openclaw-webchannel/<account>/credentials.json`
  so restarts reconnect with no re-approval. See
  [`../../e2e/local/README.md`](../../e2e/local/README.md) to reproduce browser↔agent locally.
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
- **Location:** `~/.openclaw-webchannel/<account>/credentials.json` (override via `credentialPath`)
- **Permissions:** written with mode `0o600` (owner read/write only)
- **Shape** (`PluginCredentials`): `identityKey { publicKey, privateKey }` (base64url X25519),
  optional `enrollment { creds, peerId, jwksUrl, bootstrapUrl }`, plus `tenant`, `saasEnrollUrl`,
  `saasPollUrl`, optional `accountId` (the wire identity). The private key is generated locally
  and never transmitted.

## E2E security model (admission + key establishment)

P0-2 made the authenticated register hop the **sole** admission path; key establishment happens
there:

- **Register admission (the only path) — register-delivered conversation key.**
  The agent OWNS a stable per-peerId key K (`src/conversation-key-store.ts`, persisted at
  `~/.openclaw-webchannel/<account>/conversation-keys.json`, 0600). The register handler (a NATS
  request/reply on the account's `…{peerId}.register` subject) wraps K (`src/late-join-decryptor.ts`
  — X25519 ECDH + HKDF-SHA256 `webchannel-key-wrap-v1` + ChaCha20-Poly1305) to the device key
  attested in **that request's** verified JWT `cnf` claim and returns it in the register reply.
  There is **no unauthenticated key-exchange subject on this path** — the register handler DOES
  subscribe and answer `.register` (that IS the admission path), but K is never negotiated on the
  wire; it travels only inside the authenticated register reply — so an active relay cannot
  substitute keys: K only ever travels **wrapped to a
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
    `handshake-verifier.ts`) in Phase 6 W7.
  - **Session scoping caveat:** a register account serves many users, so openclaw's
    `session.dmScope` MUST be `"per-channel-peer"` (or the per-account variant). The default
    `"main"` collapses every peer into ONE agent session, and the register history snapshot then
    delivers the shared transcript to every user (re-sealed to each requester's own K —
    encryption cannot prevent a scoping leak). The plugin warns loudly at startup when it detects
    this (`crossUserHistoryWarning`).
- **No anonymous admission:** the `anonymous` auth strategy throws at plugin load
  (`makeAnonymousVerifier` never returns a verifier) — connections must use `jwt`.

**Threat model (register path):** relay substitutes a key → impossible, K is wrapped to the
JWT-attested `cnf` key and never negotiated on the wire; attacker skips bootstrap → no admission
(register requires a verified JWT + PoP); forged `cnf` → JWT signature verification fails;
tampered wrapped key → Poly1305 reject, client fails closed (terminal error, no registration
downgrade). Review finding **C2** (active-relay MITM) is CLOSED on this path — the residual is only
relay TRUST for availability/metadata, not confidentiality/integrity. **Out of scope:** SaaS
key compromise / revocation (deferred to re-enrollment); K rotation (deferred — fixed key first);
real-time allowlist authz is a core-delegated stub.

## Bring-your-own NATS (static creds) — REMOVED in P0-2, returns in P0-3

Static / bring-your-own-NATS **serving** (and the old dev-open mode) was removed in P0-2: the
authenticated register hop is now the **sole** admission path (see the E2E security model above).
Support for static/BYO creds is planned to return in **P0-3**.

Until then, any removed config **fails closed with a targeted migration error** instead of silently
degrading:

- `nats.credentials.mode:"open"`, the removed dev-open NATS flag, `nats.admission:"auto"`, and
  `auth.strategy:"anonymous"` are rejected at account resolution (`assertNoRemovedConfig` in
  `src/account-config.ts`), with a message pointing at `openclaw channels add --channel webchannel`.
- `nats.credentials.mode:"static"` and the matching environment overrides are rejected one phase
  later, at credential-source resolution (`src/nats-credential-source.ts`).

Enrolled (SaaS device-flow) creds remain the supported path; the connection env overrides
(`WEBCHANNEL_NATS_URL` / `_USER_JWT` / `_USER_SEED` / `_CREDS`) still classify the source. Do **not**
copy an old `credentials.mode:"static"` block (or a `natsCredentials`-only browser client) as a
working recipe — it now throws at startup / requires `registration`.

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
