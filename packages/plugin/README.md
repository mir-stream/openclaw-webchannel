# openclaw-webchannel

The OpenClaw web chat channel plugin — embed a chat widget on a web page and talk to an
OpenClaw agent (Claude) from the browser.

> **The authoritative status lives in [`../../docs/STATUS.md`](../../docs/STATUS.md).** AC
> completion reports and seed files elsewhere describe component-level work, not end-to-end
> functionality. Where they conflict with STATUS.md, STATUS.md is correct.

## Two transports

This package ships two plugin entries. **`index-nats.ts` is the production default**
(`package.json` → `openclaw.extensions = ["./index-nats.ts"]`); `index.ts` is a **dev-only**
zero-infra fallback.

| Entry | Mode | Role |
|---|---|---|
| `index-nats.ts` | **NATS E2E** — both sides dial OUT to a shared NATS bus (no inbound port); relay sees ciphertext only | ✅ **Production default.** Cut over live on the real gateway (`:18789`): real browser ↔ NATS ↔ this plugin ↔ `inbound.run` ↔ back, E2E-encrypted, device-flow enrolled. Satisfies the no-inbound-port premise. |
| `index.ts` | **Gateway-WS** — browser connects via a WebSocket upgrade on the gateway's own port | 🔧 **Dev-only.** Requires a reachable inbound gateway port (same-host/LAN only) — does **not** satisfy the no-inbound-port premise, so it is NOT a production transport. Keep for zero-infra local round-trips. |

As of `e384198`, a real headless-Chromium message HAS travelled browser → NATS → this plugin →
`inbound.run` → (echo model) → back. Earlier the NATS entry assumed APIs that don't exist
(`api.http.post`, a `webchannel-nats` id, `keepAlive`) — fixed there. The plain-HTTP register
routes (`/webchannel/nats/register*`) are now **served live** too: they were silently dropped
because `registerFull` called `api.registerHttpRoute` *after* `await`-ing the NATS connect, and
openclaw only honors route registration during the **synchronous** `registerFull` window — the
fix registers them up front (handlers read live state via a holder). This was *not* an openclaw
limitation on plain-HTTP routes; those dispatch fine. The browser client is also **wired** to
register over this hop (`registerWithPop`, `9aa4b67`). Two caveats remain: the deterministic echo
model stands in for a live LLM (by design), and the local dev harness still drives the wildcard
auto-register path (a live e2e with a real bootstrap JWT is follow-up #13). See STATUS.md.

## Status

- NATS entry (`index-nats.ts`) — **production default, cut over live** on the real gateway
  (`:18789`): enrolled via the SaaS device flow against a persistent local trust chain
  (`nats-server` + reference issuer), credentials cached at `~/.openclaw-webchannel/credentials.json`
  so restarts reconnect with no re-approval. Also has an env-gated **dev/open-NATS** path
  (`WEBCHANNEL_NATS_DEV_OPEN=1`) that connects to a plain local `nats-server` with no enrollment —
  see [`../../e2e/local/README.md`](../../e2e/local/README.md) to reproduce browser↔agent locally.
- Gateway-WS channel (`index.ts`) — **dev-only** zero-infra fallback (run it via an OpenClaw gateway
  with this plugin loaded in WS mode). Needs a reachable inbound port, so it is NOT used in
  production. Exercise it via the `smoke/*.mjs` WS round-trip scripts; the single interactive
  chat demo is the NATS path (`e2e/local/run-demo.sh`).
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
  `saasPollUrl`, optional `accountId` (the wire identity). The private key is generated locally
  and never transmitted.

## E2E security model (admission + key establishment)

Phase 6 (multi-device) split key establishment by admission mode:

- **Register admission (production / SaaS path) — register-delivered conversation key.**
  The agent OWNS a stable per-peerId key K (`src/conversation-key-store.ts`, persisted at
  `~/.openclaw-webchannel/<account>/conversation-keys.json`, 0600). The HTTP register route wraps
  K (`src/late-join-decryptor.ts` — X25519 ECDH + HKDF-SHA256 `webchannel-key-wrap-v1` +
  ChaCha20-Poly1305) to the device key attested in **that request's** verified JWT `cnf` claim and
  returns it in the register response. There is **no `.handshake` on this path** — the
  keyStore-mode channel neither subscribes nor answers it — so an active relay cannot substitute
  keys: K only ever travels wrapped to a JWT-attested device key, over authenticated HTTPS, never
  over NATS. This resolves review finding **C2** structurally for register deployments. One user's
  devices all receive the SAME K, so multi-device decryption works and a second device no longer
  overwrites the first one's key.
  - **`cnf` claim verification** (`src/jwt.ts`): after the bootstrap JWT's signature is verified,
    `verifyJwt` extracts the RFC 7800 `cnf.jwk` confirmation claim. The claim must be
    `kty: "OKP"`, `crv: "X25519"`, with a 32-byte `x`; a `d` (private) field, wrong length, or
    any malformed `cnf` causes the **whole JWT to be rejected** (fail-closed). The validated key
    surfaces as `JwtIdentity.devicePublicKey`; the register route REQUIRES it (401 without) and
    wraps per-request. There is deliberately **no cross-request pinned-key store** — the old
    peerId-keyed pin store collided two devices of one user and was removed (with the never-wired
    `handshake-verifier.ts`) in Phase 6 W7.
  - **Session scoping caveat:** a register account serves many users, so openclaw's
    `session.dmScope` MUST be `"per-channel-peer"` (or the per-account variant). The default
    `"main"` collapses every peer into ONE agent session, and the register history snapshot then
    delivers the shared transcript to every user (re-sealed to each requester's own K —
    encryption cannot prevent a scoping leak). The plugin warns loudly at startup when it detects
    this (`crossUserHistoryWarning`).
- **Auto admission (`admission:"auto"`, bring-your-own-NATS) — legacy per-device X25519
  handshake, unchanged.** The handshake is unauthenticated (any tenant-creds holder can complete
  it), so auto mode gives confidentiality against a *passive* relay only; an *active* relay MITM
  can substitute keys. Acceptable **only while the relay is operated by a trusted party** (your
  own `nats-server` or your own Synadia account). Migrating auto deployments to register
  admission is the follow-up that closes this.
- **No anonymous admission:** the `anonymous` auth strategy throws at plugin load
  (`makeAnonymousVerifier` never returns a verifier) — connections must use `jwt`.

**Threat model (register path):** relay substitutes a key → impossible, K is wrapped to the
JWT-attested `cnf` key and never negotiated on the wire; attacker skips bootstrap → no admission
(register requires a verified JWT + PoP); forged `cnf` → JWT signature verification fails;
tampered wrapped key → Poly1305 reject, client fails closed (terminal error, no handshake
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
  tenant/agent wildcard; serve any peer that completes the X25519 handshake **and**
  passes the `dmSecurity` allowlist). Static creds default to `auto`. Security here
  rests on **NATS subject permissions + the allowlist + E2E encryption** — not on an
  issuer. E2E encryption stays fail-closed regardless of source.

### Agent (static creds, no issuer)

```jsonc
// channels.webchannel
{
  // NO `auth` block needed: static creds resolve admission to "auto", and the
  // ConnectionVerifier is only built for the "register-hop" admission mode.
  // Browser admission here = NATS subject permissions + X25519 handshake
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
| `WEBCHANNEL_NATS_DEV_OPEN=1` | dev open-NATS (no auth) |
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
> `…*.handshake` and publishes `…*.out`; the browser is the mirror). Without the
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

The plugin serves no static UI. The **production** entry (`index-nats.ts`) exposes the
plain-HTTP register routes `/webchannel/nats/register`, `/webchannel/nats/register/challenge`,
and `/webchannel/nats/unregister` (used only by the `register-hop` admission mode; the browser
otherwise reaches the agent over NATS, not HTTP). The **legacy dev-only** entry (`index.ts`)
exposes the `/webchannel/ws` WebSocket route instead. Either way a consumer wires the headless
`packages/client` library into their own page (see that package's README).
