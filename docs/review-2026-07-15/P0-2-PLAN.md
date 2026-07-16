# P0-2 Implementation Plan — Auto-admission과 unauthenticated handshake 완전 삭제

> Work item: [`P0.md`](P0.md) §"P0-2" (lines 90–173).
> Branch: `feat/p0-2-auto-admission-removal`, stacked on `feat/p0-1-gateway-ws-removal` (PR #41).
> Status: **CONVERGED v9** — codex gpt-5.6-sol adversarial review, 7 rounds
> (findings: 2B+2M → 1B+3M(B refuted) → 0B+2M → 0B+3M → 0B+1M → 0B+1M → **0B+0M**).
> R7's three MINORs folded below. This document is the implementation spec.

## 1. Goal and invariants

Delete every path by which a peer is served **without authenticated registration**, and
every path by which the agent connects to NATS **without credentials**:

- **Axis B (`nats-admission.ts`)**: `admission: "auto"` — wildcard `.in`/`.handshake`
  subscription serving ANY peer that completes an unauthenticated X25519 `key_exchange`.
  The per-connection key exchange verifies nothing about the counterparty: an active
  relay can run two separate exchanges and read/re-encrypt plaintext in the middle
  (the exact MITM the register-delivered wrapped-K design closed for register-hop).
- **Axis A (`nats-credential-source.ts`)**: `mode: "open"` — `WEBCHANNEL_NATS_DEV_OPEN`,
  `nats.devOpen`, `credentials.mode:"open"` — connecting to NATS with no credentials.
- **Wire**: the `key_exchange` frame and the `.handshake` subject, both directions,
  both packages.
- **Dev identity**: the WELL-KNOWN dev agent identity key (`dev-identity.ts`) that
  register-hop-on-open-NATS used to wrap K without attestation.

End-state invariants (P0.md 완료 조건):

1. `admission:"auto"`, `DEV_OPEN`, unauthenticated `key_exchange`: **0 runtime callers**.
2. Every peer gets an active subscription **only after** authenticated registration
   (bootstrap JWT + PoP over the `.register` subject).
3. BYO-NATS and managed NATS use the same protocol/invariants (see D4 for the
   deliberate P0-3 hand-off on static-creds serving).
4. Old config (`admission:"auto"`, `devOpen`, `credentials.mode:"open"`, and the
   static-creds-implies-auto default shape) fails loudly with a targeted migration
   error, never silently ignored (reuses the P0-1 `assertNoRemovedConfig` seam).
5. Bidirectional key-substitution attack tests pass (relay substituting either side's
   key is detected and the flow fails closed).

KEPT (남겨야 할 암호 기능): SaaS-attested browser device key; SaaS-attested agent
identity key; register-response wrapped conversation key (`KEY_WRAP_INFO =
"webchannel-key-wrap-v1"` static-static ECDH — domain-separated from the deleted
handshake KDF `webchannel-conversation-v1`, verified); ChaCha20-Poly1305
`MessageEnvelope` v1 with canonical AAD; replay/idempotency protection; PoP register
(`registerWithPop`).

## 2. Scope

IN: plugin admission/credential axes, plugin channel handshake surface, client legacy
handshake branch, config schema + migration errors, wire frame removal, tests
(delete/rewrite/add attack tests), e2e harness migration, CI baseline, docs, CHANGELOG.

OUT (explicitly deferred):
- P0-3: BYO-NATS(static creds) authenticated registration — P0-2 makes static-creds
  accounts fail loudly (D4); P0-3 restores them with attested keys.
- P0-4: send-result contract (unchanged from P0-1 deferral).
- Encryption-policy surface (`encryption.mode:"disabled"` boot rejection) — already
  fail-closed; untouched.
- `ANON_PEER_ID` (`auth.ts:33`, "web-anon") — NOT part of auto admission; it feeds
  approvals fan-out (`approvals.ts`) + inbound fallback. Untouched.
- Broader `dmSecurity` allowlist enforcement — only the orphaned `isDmPostureOpen`
  helper dies (its sole runtime caller is the auto-mode warn; verified).
- `demo/web/src/wiretap.ts` `webchannel.{tenant}.>` subscription — OBSERVER wildcard
  (chaos/wiretap tooling), unrelated to admission. Untouched.

## 3. Dependency map (explorer-verified; spot-checks re-run by TechLead)

### 3.1 DELETE whole files

| File | Why safe |
|---|---|
| `packages/plugin/src/nats-admission.ts` (+ `nats-admission.test.ts`) | collapses to constants (D1) |
| `packages/plugin/src/dev-identity.ts` (+ `dev-identity.test.ts`) | D4 |
| `packages/plugin/src/e2e-roundtrip-agent.ts` | test seam, not shipped; importers = 2 vitest live-gate tests only (verified: other hits are comments) |
| `packages/client/src/e2e-browser-client.ts` | Playwright dial seam, not in barrel (verified); same 2 tests |
| `e2e/dev-nats-roundtrip.test.ts`, `e2e/enrolled-jwt-roundtrip.test.ts` | drive the two seams above via handshake |
| `packages/client/src/e2e-crypto-browser.test.ts` | tests `parseKeyExchange` only |
| `e2e/local/drive-roundtrip.ts`, `e2e/local/browser-entry.ts` | registration-less handshake drivers (drive-roundtrip mints the old HS256 web-anon ticket). Stage 1 fact: no `e2e/local/*.sh` references either file (repository grep); they are orphaned from shell harnesses. |

### 3.2 REWRITE map (file:line, current role → change)

**`packages/plugin/src/nats-credential-source.ts`** — `mode:"open"` union member (:98),
`devOpen` config field (:73), `legacyNats.devOpen` (:116), OPEN resolver branch
(:243-251), connector `case "open"` (:380-389), `admission` field type (:75-76):
delete open/devOpen everywhere; `admission` type becomes `"register-hop"`.
Static + enrolled + `.creds` parsing KEEP.

**`packages/plugin/src/account-config.ts`** — extend `assertNoRemovedConfig` (:184-191)
per D5. Everything else KEEP.

**`packages/plugin/src/consume-credentials.ts`** (codex R3) — the union change lands
here too: "open / static" contract comments (:17,:21,:83) and the non-enrolled
delegate branch are rewritten to static-only; its test's `{ mode: "open" }` case
(`consume-credentials.test.ts:142`) is deleted/rewritten as unrepresentable.
`acquisition-env.ts:18` stale `_DEV_OPEN` comment pruned.

**`packages/plugin/openclaw.plugin.json`** — ONE consistent rule for every removed
shape (codex R5 — an earlier draft contradicted itself here): **removed literals stay
schema-valid-but-deprecated; rejection happens ONLY at the `assertNoRemovedConfig`
seam.** Removing an enum literal (or a key, per P0-1 D4) makes the generic schema
validator reject the config BEFORE the migration seam runs — which violates P0.md
:154-157's targeted-error requirement. Concretely: `nats.devOpen` (:195-198) KEY
KEPT, description → "REMOVED — startup migration error"; `nats.admission` enum
(:199-203) keeps `"auto"`, description marks it removed; `credentials.mode` enum
(:209-212) keeps `"open"`, same treatment; `auth.strategy` enum (:47-50) keeps
`"anonymous"`, same treatment (D9). Help text at :255 rewritten (currently instructs
"set NO auth at all for auto admission"). A migration-error test per literal proves
the seam is reached (not schema-rejected).

**`packages/plugin/index-nats.ts`** — dev-identity import (:70) + register-hop
dev-identity fallback (:534-557) DELETE (fail-closed branch :544-556 becomes the only
behavior); legacy config projection type `nats?: { url?: string; devOpen?: boolean }`
(:115) loses the `devOpen` member (`url` stays — legacy `nats.url` remains honored by
the resolver) (codex R5); admission resolution (:469-479) → unconditional
register-hop (D1);
wildcard-subscribe block + auto/dmSecurity warn (:834-843) DELETE; channel-construction
ternary (:562-572) → always keyStore+identityKeyPair; verifier/register gates
(:944-963, :980+) unconditional. `isDmPostureOpen` import (:51) DELETE →
`dm-allowlist.ts:55` function deleted (module stays).

**`packages/plugin/src/nats-channel.ts`** — `subscribeWildcard()` (:349-359),
`handleHandshake()` (:815-901) incl. S2 auto-cap (:858-876) + auto history suppression
(:886-900), `handshakeSubscriptions` (:228), `handshakeSubject()` (:673-675),
legacy-mode handshake sub in `registerPeer` (:333-337) + teardown (:402-406),
handshake dispatch arm (:734-737), ephemeral `agentKeyPair` (:214,260),
`setHandshakeCompleteHandler`/`onHandshakeComplete`/`isNewSession` machinery
(:235-247, :610-622, :899 — verified consumers are tests + the deleted path only):
DELETE. Constructor invariant becomes `encryptionRequired ⇒ keyStore ⇒ identityKeyPair`
(today `keyStore` optional and null-keyStore IS the auto path — :219,:261).
`peerSessionKeys` (:226) KEEP; sole writer becomes `registerPeer` (:299-301), bounded
by its existing cap loop (:315-322).

**`packages/plugin/src/e2e-session.ts`** — DELETE `keyExchangeFrame` (:61-66),
`parseKeyExchange` (:72-93), `deriveConversationKey` (:49-55), `CONVERSATION_KDF_INFO`
(:35). KEEP `sealEnvelope`/`openEnvelope`/`SessionRouting`.

**`packages/plugin/src/preflight.ts`** — auto readiness branch (:149-156) + admission
field (:79-80) → register-hop-only.

**`packages/plugin/src/nats-transport.ts`** — comments only (codex R7): option
docs (:30,:36) and the internal branch note (:236) still frame credential-less
construction as supported "open dev" behavior. Reframe as test/low-level transport
capability (the generic transport stays permissive by design — its production
callers all come through the credential source, which no longer has an open mode).

**`packages/plugin/src/setup.ts`** — already writes `admission:"register-hop"` +
`credentials.mode:"enrolled"` (:238) — KEEP that; but (codex R4) the TYPE surface is
live deletion scope: `WebchannelSetupInput.credentialsMode` admits `"open"` (:84) and
`buildAccountPatch` writes it verbatim into persisted config (:128) — drop `"open"`
from the type so setup can never re-mint a removed shape; prune stale "legacy auto"
prose (:193-196); setup tests updated.

**`packages/plugin/src/auth.ts`** — (codex R4, pairs with D9) `AnonymousAuthConfig`
(:62) and its arm in the `AuthConfig` union (:106) are deleted — the runtime type,
not just the schema enum. Affected construction sites/tests inventoried in Stage 1
(`auth-admission.test.ts` keeps asserting the REJECTION of a raw
`{strategy:"anonymous"}` object, now type-cast in the test).

**`packages/client/src/nats-client.ts`** — legacy handshake fallback (:1285-1294),
`publishHandshakeWithRetry` (:1302-1315), `clearHandshakeRetry` (:1317-1322), handshake
arm of `handleRaw` (:1327-1336), `handshakeRetryTimer` (:933), `handshakeSub` (:923),
`keyPair` field (:885), `HANDSHAKE_MAX_RETRIES`/`HANDSHAKE_RETRY_MS`,
`handshakeSubject()` (:846-848): DELETE. **`registration` itself (:114, today
optional — "when absent, registration is skipped") and `deviceX25519PrivateKey`
(:117-126) both become required** (codex R1 BLOCKER 1): the constructor throws a
synchronous terminal config error when either is missing — never a silent
legacy-path pre-selection, never a connected-but-keyless client (`connect()` runs
registration only inside `if (registration)` at :1126 today).
Register-delivered branch (:1226-1282) KEEP.

**`packages/client/src/nats-client-wrapper.ts`** — forwards `registration` unchanged
(:70) and `WebChannelNATSClientOptions` inherits its optionality: type + runtime
follow the mandatory-registration change; wrapper-level missing-registration test
added.

**`packages/client/src/browser-demo-entry.ts`** — codex R1 BLOCKER 2: a RUNTIME
handshake selector, not stale prose — `opts.gwUrl ? { registration: {...} } : {}`
(:177-189) constructs the production client registration-less when `gwUrl` is unset
(comment :167-170 spells out the auto/handshake intent; `agentPublicKey` required
only when `gwUrl` set, :160-162). REWRITE: registration unconditional; `gwUrl` stops
being a registration toggle; `agentPublicKey` always required from bootstrap.

**`examples/minimal-consumer/src/widget.ts`** — constructs `WebChannelNATSClient`
with NO registration (type-surface smoke, :16-23). REWRITE to include a registration
stub once the type requires it (WebCrypto-generated keys or documented fixture);
`examples/webchannel-app` + `demo/web/src/widget.ts` already register unconditionally
(verified) — README snippets re-checked in Stage 6. `browser-jwt-entry.ts` registers
(4 sites) — verify both construction sites in Stage 4.

**`packages/client/src/e2e-crypto-browser.ts`** — DELETE `generateX25519KeyPair`
(:56-67), `deriveConversationKey` (:115-121), `keyExchangeFrame` (:216-218),
`parseKeyExchange` (:221-237), `BrowserKeyPair` (:50-54). KEEP `unwrapConversationKey`,
`KEY_WRAP_INFO`, `deriveX25519SharedSecret` (:69-86 — unwrap dependency, DO NOT
delete), `hkdfSha256`, envelope codec, base64url helpers.

**`packages/client/src/index.ts`** — no change (verified: no handshake surface is
exported).

**`packages/saas/reference/bootstrap-server.ts`** — :245-252 `DEV_OPEN ?
{agentPublicKey: devOpenAgentIdentityPublicB64url()}` reference-harness pin: REWRITE
to an explicit pin source — new `WEBCHANNEL_AGENT_PUBLIC_KEY` env (base64url), no
implicit dev key, no DEV_OPEN flag.

**`packages/saas/src/ac6-device-flow-e2e.test.ts`** — :141 starts the reference
bootstrap-server with `WEBCHANNEL_NATS_DEV_OPEN=1` to obtain the dev pin (codex R2 —
outside the four D6 harnesses, and it would trip the new banned-symbol guard).
REWRITE: the test generates/derives an agent X25519 key pair itself and passes the
public half via the new env; the pin assertion becomes EQUALITY against that env
value (the current :452,:474 defined-only assertion is too weak — codex R3).

### 3.3 Stale-docs fixes discovered (fold into Stage 6)

- `e2e/local/README.md:105,197` reference `src/wildcard-gate.ts` /
  `shouldSubscribeWildcard` — **file does not exist** (the gate is
  `admissionServingPlan`). Rewrite.
- `run-all-real.sh:286-302` / `run-enrolled-transport.sh:278-284` comments claim the
  setup adapter writes `admission:"auto"` — stale (setup.ts:238 writes register-hop).
- (codex R4) saas protocol comments still describe `.handshake` as a live subject:
  `subject-token.ts:4`, `nats-user-creds.ts:26`, `device-flow-enrollment.ts:885` —
  rewrite (subject set becomes `register|reginbox|in|out`); permission tests stop
  asserting handshake-specific semantics (the broad `>` grants themselves stay —
  they cover the surviving subjects).

## 4. Design decisions

### D1 — Axis B collapses; `nats-admission.ts` deleted

With `"auto"` gone there is exactly one admission mode. `resolveAdmissionMode`,
`AdmissionMode`, `AdmissionServingPlan`, `admissionServingPlan` die; the serving loop
unconditionally builds the verifier, subscribes `.register`, never subscribes a
wildcard. Config key `nats.admission` stays **schema-accepted (deprecated)** — P0-1 D4
lesson: `additionalProperties:false` rejects old configs BEFORE the migration detector
runs. `assertNoRemovedConfig` throws on `admission:"auto"`; explicit
`admission:"register-hop"` is accepted and ignored (it names the only remaining
behavior — erroring on it would punish the safe config).

### D2 — Axis A: `open` credential mode deleted; env override becomes a hard error

Detection points and their error surfaces:

- Config-sourced (`nats.devOpen`, legacy top-level `nats.devOpen`,
  `credentials.mode:"open"`): migration error via `assertNoRemovedConfig` — same seam
  and message style as P0-1's `auth.ticketParam`. Key-presence check for `devOpen`
  (any value, incl. `false` — carried-but-false is dead config; the error is cheaper
  than the ambiguity — Q1 for codex), value-match for `credentials.mode === "open"`.
- Env-sourced (`WEBCHANNEL_NATS_DEV_OPEN=1`): `resolveNatsCredentialSource` throws the
  same migration error (env never passes through account-config; the resolver already
  throws on incomplete static creds, and index-nats maps a resolver throw to
  skip-account-with-log).

Migration error text names the removed setting, the required authenticated enrollment,
and the reconfigure command (`openclaw channels add --channel webchannel`).

### D3 — Handshake deleted end-to-end; wrap path untouched

Per §3.2 (`nats-channel.ts`, `e2e-session.ts`, `nats-client.ts`,
`e2e-crypto-browser.ts`). Load-bearing invariants:

- Register wrap path uses `KEY_WRAP_INFO` (domain-separated) — handshake KDF deletable
  with zero wrap-path impact (verified).
- `NatsChannel` crypto model becomes keyStore-only: `encryptionRequired ⇒ keyStore ⇒
  identityKeyPair`. Without this, a half-deleted channel neither handshakes nor has a
  keyStore and serves nothing (explorer G2).
- `peerSessionKeys` stays; register becomes its sole writer; boundedness now rides
  `registerPeer`'s existing cap (explorer G3 — verify no unbounded re-register growth
  in Stage 3 tests).
- History/approval snapshots: auto-path suppression machinery
  (`setHandshakeCompleteHandler` et al.) is fully dead — every peer is
  PoP-authenticated and snapshots fire from the register route (already the case).

### D4 — Static creds: forced register-hop, load-time migration error until P0-3

Today `resolveAdmissionMode` defaults **everything except jwt+hop-available to auto**
— including static creds (`registerHopAvailable = credentialMode !== "static"`,
schema text: "static credentials always default to auto"). Deleting auto is therefore
NOT transparent for static-creds BYO-NATS: their default serving path disappears, and
the only remaining route (register-hop) is fail-closed without an enrolled/attested
identity key (`index-nats.ts:544-556` — the F2 guard, which stays as the serve-time
backstop).

Decision: **surface this loudly, with two-layer semantics** (codex R1 MAJOR 2 — a
static source can be selected by config OR by process-wide env/`.creds` signals that
never pass through account-config, and the two layers have different blast radii):

- **Layer 1 — raw removed config shapes** (`nats.devOpen`, `nats.admission:"auto"`,
  `nats.credentials.mode:"open"`, `auth.strategy:"anonymous"`): thrown by
  `assertNoRemovedConfig` inside `resolveWebchannelAccountConfig`. Propagation is the
  **P0-1 precedent, verified**: `planAccounts` (`multiplex.ts:71`) calls it per
  account with NO try/catch, so the throw escapes the plugin's serve loop —
  **plugin-load-fatal**, exactly like `auth.ticketParam` today. A removed shape in
  committed config should be unmissable; this is deliberate.
- **Layer 2 — effective source after full precedence resolution** (static selected by
  `credentials.mode:"static"`, `credsFile`, inline secrets, `WEBCHANNEL_NATS_USER_JWT`
  + `_SEED`, `WEBCHANNEL_NATS_CREDS`; open selected by `WEBCHANNEL_NATS_DEV_OPEN=1`):
  detected at/after `resolveNatsCredentialSource` in the serving loop, where the
  existing per-account catch (`index-nats.ts:399,455`) converts a throw into
  **skip-this-account with an error-level migration log** — one bad account disables
  that account only, other accounts/channels unaffected (matches the established
  degradation model for credential problems). The message states the env-var scope
  explicitly (a process-wide env selects static/open for EVERY account, so every
  account logs it): "static NATS credentials no longer imply auto admission; BYO-NATS
  requires authenticated registration (attested agent identity) — enroll with
  `openclaw channels add --channel webchannel`, or track P0-3", and for DEV_OPEN:
  "WEBCHANNEL_NATS_DEV_OPEN was removed; there is no unauthenticated NATS mode".

Deliberate consequence, stated in CHANGELOG and the PR body: **static-creds accounts
are un-servable until P0-3** (Q3 — product call, flagged to the user).

Tests cover every static signal individually (mode/credsFile/inline/env-JWT+seed/
env-creds-file) plus env DEV_OPEN — per-account skip asserted, not process crash;
and one Layer-1 shape per key — process-fatal asserted.

The dev-identity fallback (`index-nats.ts:534-543`) and `dev-identity.ts` are deleted;
register-hop with no attested key is ALWAYS fail-closed.

### D5 — Migration errors ride the P0-1 seam

Layer 1 (D4) detection lives in `assertNoRemovedConfig` (`account-config.ts:184`),
which runs inside `resolveWebchannelAccountConfig` — the real load path for every
account resolution, plugin-load-fatal via `planAccounts` (verified — R1 resolved).
New Layer-1 checks: `nats.devOpen` (presence), `nats.admission === "auto"`,
`nats.credentials.mode === "open"`, `auth.strategy === "anonymous"` (D9). Layer 2
(effective source, env-selected shapes) lives in the resolver/serving loop per D4.
Schema keeps removed keys deprecated-accepted with descriptions saying "REMOVED —
startup error; see migration".

### D6 — e2e harness migration (the true blast radius)

Corrected understanding (explorer E, verified): the four devOpen CI harnesses are
**register-hop tests already** — devOpen is their NATS *transport* scaffold and
`dev-identity` is their *attestation* scaffold (agent falls back to the well-known dev
key; drivers pin `devOpenAgentIdentityPublicB64url()`). None of them exercises auto
admission. So the migration is transport+identity substitution, not semantics loss:

| CI step | Harness | Unique assertions | Disposition |
|---|---|---|---|
| 8 | `run-jwt-register.sh` | static-file RS256 fixture/JWKS; production PoP challenge+register; register-delivered K; encrypted echo text; nonzero on register/error/timeout | **SUBSUMED → DELETE in Stage 6.** `run-all-real.sh` proves the same production PoP/register/K/encrypted-echo assertions with a stronger real issuer/JWKS HTTP trust chain and authenticated NATS. The only difference, `jwksFile` fixture wiring, is configuration-unit coverage rather than a unique protocol assertion. |
| 8b | `run-saas-issuer-register.sh` | reference bootstrap RS256 issuance; live JWKS-over-HTTP verification; bootstrap peer/JWT-sub and agent-pin presence; production PoP register; encrypted echo | **SUBSUMED → DELETE in Stage 6.** all-real uses the reference enrollment issuer's real RS256/JWKS HTTP endpoints, obtains browser bootstrap from that same trust chain, drives PoP register, and proves encrypted echo. Its enrolled agent/browser credentials and explicit attested pin are stronger than dev-open/dev-key scaffolding. |
| 8d | `run-browser-jwt-register.sh` | in-page X25519 + non-extractable Ed25519 generation; cross-origin bootstrap; production browser PoP register; encrypted echo text in real Chromium | **SUBSUMED → DELETE in Stage 6.** `all-real.mjs` bundles the same production browser entry pattern into headless Chromium and asserts the echoed text, while `run-all-real.sh` also supplies authenticated NATS and enrolled identity. No candidate-only browser assertion remains. |
| 8f | `run-two-account-isolation.sh` | 2-account routing isolation | NOT subsumed → **MIGRATE** to the `setupTrustChain` enrolled pattern (per-account enrolled creds + attested identity; driver pins the enrolled key) |
| 8c/8e/8g | enrolled-transport / all-real / derived-trust | — | KEEP (already devOpen-OFF, register-hop, real creds) |

Any un-subsumed assertion from the deleted three is folded into `run-all-real.sh`.
CI steps + the ≥1420 test baseline move in lockstep (a code-only delete lands red).

### D7 — Attack tests (P0.md's five)

**Threat model (explicit, per P0.md "Relay가 … 치환"):** the attacker is the NATS
relay (or any NATS-level principal). The first-party HTTPS bootstrap leg
(SaaS ↔ browser) is NOT the attacker — key substitution *at issuance* is a
compromised-issuer scenario, out of scope for these five.

**A1 binding mechanism (corrected, codex R2):** the browser X25519 device key rides
INSIDE the SaaS-signed bootstrap JWT (`cnf.jwk`); the register handler extracts it
only from the *verified* token (`nats-register.ts:250-258` — rejects when absent or
non-32-byte). PoP does NOT bind it — PoP proves possession of the separate Ed25519
`pop_jwk` over `peerId+nonce` only (RFC 7800 split, `pop-challenge.ts:9-21,63`). So a
relay substituting the device key must alter the JWT payload → signature verification
fails → registration rejected. That is the manufacturable A1 test: mutate `cnf.jwk`
inside the register token → expect `REGISTER_UNAUTHORIZED`.

| # | Attack | Expected | Existing coverage? |
|---|--------|----------|--------------------|
| A1 | Relay tampers device X25519 key (`cnf.jwk`) in the register token | JWT verify fails → registration rejected | Partial: signed-token payload/signature tamper crosses the real verifier at `packages/plugin/src/jwt-middleware.test.ts:252`; structural cnf cases at `jwt-cnf.test.ts:105-174`. No signed cnf-specific mutation existed; add it. |
| A2 | Relay tampers the plaintext register reply's wrapped-K material | browser fails closed and disconnects (`nats-client.ts:1261`); pin itself is NOT wire-mutable (SaaS-delivered) | Partial: ciphertext mutation/disconnect at `packages/client/src/nats-client-wrapped-key.test.ts:507`; wrap ciphertext/tag and wrong peer binding at `packages/plugin/src/late-join-decryptor.test.ts:176-213`. Ephemeral key, nonce, tag/ciphertext and wrong-local-pin matrix is incomplete. |
| A3 | Unregistered valid NATS user publishes `.in` | no agent turn starts | No pre-existing subscription-boundary test. Added in Checkpoint A at `packages/plugin/src/nats-channel-admission-boundary.test.ts:36`. |
| A4 | Bootstrap JWT peer/account/tenant/device binding substitution | verify fails | Partial: subject-vs-claim peer rejection at `packages/plugin/src/nats-register.test.ts:172`; PoP mismatch cases at `register-pop-gate.test.ts:47-120`; issuer/audience tamper at `jwt-middleware.test.ts:273-318`. Named account, tenant, and device binding mutations were not all present. |
| A5 | Register response missing wrapped K | terminal failure, no fallback code path exists | Existing: `packages/client/src/nats-client-wrapped-key.test.ts:485` asserts terminal error and no handshake fallback. |

Test-boundary requirements (codex R3):

- **A1 must cross the real verifier**: mutate the payload segment of a genuinely
  signed token while keeping the original signature, and drive the production
  `verifyJwtAndExtractIdentity` path (`jwt.ts:243,252` — signature verify precedes
  payload extraction). A `handleRegisterRequest` test with a mocked `verifyIdentity`
  proves nothing about the binding.
- **A2 enumerates the actually-mutable wire fields individually**: wrapped ephemeral
  public key, nonce, ciphertext/tag — each mutation → unwrap failure + disconnect —
  plus one wrong-local-pin case. (The pin never rides the relay.)
- **A4 enumerates each required binding individually** (codex R7, per P0.md:162):
  four mutation cases — `peerId` (subject-vs-claim mismatch), `accountId`
  (cross-account token), `tenant`, and device (`cnf.jwk`, shared with A1) — each →
  registration rejected. Not "inventory, extend" hand-waving: each binding gets a
  named test.
- **A3 must prove the SUBSCRIPTION boundary, not dispatch behavior** (codex R4):
  injecting into the dispatch function bypasses exactly the property under test.
  The test asserts, at the transport level (recording/real transport), that (i) at
  startup only `.register` is subscribed (`nats-channel.ts:371`) — no `.in`, no
  wildcard; (ii) a pre-registration `.in` publish produces no delivery and no turn;
  (iii) after successful registration (`registerPeer` — :292,:324) the same publish
  is delivered.

Stage 1 inventories A1–A5 by test-grep (not plan-doc claims — P0-1 lesson: round-1
once shipped a gate on a fabricated field).

### D8 — Wire/protocol + release: protocol version STAYS 1 (decision, not deferral)

`key_exchange` leaves the wire; the `.handshake` subject disappears entirely. The 11/4
frame count on `.in`/`.out` proper is unchanged.

**Decision (codex R1 MAJOR 1): keep `WEBCHANNEL_PROTOCOL_VERSION = 1`.** Rationale:

- The version gates the **negotiated** wire contract, and negotiation happens only in
  the register reply (`nats-client.ts:1200-1221`, exact-match, mismatch = TERMINAL
  disconnect). The negotiated contract for the **delivered-key model** — register
  request/reply, wrapped-K delivery, envelope frames — is **byte-identical** before
  and after P0-2. A v1 client that registers with `deviceX25519PrivateKey` works
  perfectly against the new plugin.
- Bumping to 2 under the exact-match rule would terminally break exactly those
  fully-compatible clients for zero wire difference — strictly worse.
- The handshake path never reached version negotiation in ANY version (auto clients
  never register), so it was never under the version's protection; deleting it cannot
  be expressed by that mechanism.
- **The registering-WITHOUT-x25519 shape (codex R2):** a v1 client with
  `registration` but no `deviceX25519PrivateKey` passes v1 negotiation, then runs the
  legacy handshake (`nats-client.ts:1099,1285`). Against a register-hop account this
  shape **already wedges today** — a keyStore-mode channel never subscribes
  `.handshake` (F5, `nats-channel.ts:352-357`). It only ever functioned against
  `admission:"auto"` agents. Post-P0-2 those agents hard-error at startup, and 0.3.0
  clients make the shape unrepresentable (D10). So keeping v1 does not regress it:
  it moves from "wedges against production accounts" to "wedges against a config
  that refuses to boot". Compat policy stated in CHANGELOG.

Acknowledged residual: old auto-mode or registering-without-x25519 clients against a
new plugin time out without a version diagnostic — exactly their behavior against any
register-hop account today. Accepted because (a) the agent-side migration errors are
loud; (b) client+plugin ship 0.3.0 in enforced 3-way lockstep. Stated in CHANGELOG.

Compat tests locked in: reply-without-protocolVersion → non-fatal (exists — verify),
matching v1 → proceeds, mismatched → terminal (exists — verify), and the
protocol-version-lockstep suite stays green unmodified.

Stage 1 verification: reply without `protocolVersion` is non-fatal at
`packages/client/src/nats-client-wrapped-key.test.ts:704`; a matching v1 reply proceeds
at `:669`; a mismatch is terminal at `:724` (malformed string mismatch at `:757`).

CHANGELOG 0.3.0 BREAKING gains: auto-admission removed, devOpen removed, live
handshake removed, static-creds serving deferred to P0-3, **`registration` (incl.
`deviceX25519PrivateKey`) required in client options**.

### D9 — `auth.strategy:"anonymous"` leaves the schema

Anonymous strategy only ever routed to auto admission and is already REJECTED at
verify-time for register-hop (`auth-admission.test.ts` asserts the rejection — that
test KEEPS as the guard). The RUNTIME type union drops `AnonymousAuthConfig`
(`auth.ts:62,:106`); the schema enum KEEPS the `"anonymous"` literal as
deprecated-accepted (see the §3.2 schema rule — removing it would schema-reject
before the migration seam) and the ":255" help text is rewritten. Old configs
carrying `strategy:"anonymous"` get a migration error via the same D5 seam
(value-match), never a generic schema rejection.

### D10 — Constructor validation boundary: local material synchronous, SaaS-delivered material runtime (codex R2)

Constructor-synchronous terminal errors (both `WebChannelNatsClient` and the
`WebChannelNATSClient` wrapper) cover everything the app possesses locally at
construction time:

- `registration` present, with BOTH `devicePrivateKey` (Ed25519 PoP) and
  `deviceX25519PrivateKey` — client-generated keys; absence is unrecoverable
  misconfiguration.
- non-empty bootstrap `jwt` — the wrapper's silent `bootstrapJwt ?? ""` default
  (`nats-client-wrapper.ts:71`) is deleted; constructing before bootstrap completes
  is a programming error.

`pinnedAgentPublicKey` deliberately stays type-optional + runtime-terminal
(`nats-client.ts:1248-1260`): the P1-7 cause design classifies a missing pin as
`secure-channel-failed`, NOT `config`, because the pin rides the SaaS bootstrap
response and re-auth (which refetches bootstrap) can genuinely deliver it — a
constructor throw would strand that recoverable state. That classification shipped in
PR #37 and is load-bearing; P0-2 does not reverse it. Codex R3 may attack this split.

## 5. Stages

1. **Inventory + harness-subsumption audit** — diff the 3 candidate-delete harnesses'
   assertions against `run-all-real.sh`; inventory existing A1–A5 coverage; confirm
   protocol-version stance. Output: plan updated to CONVERGED-fact status.
2. **Plugin axes** — delete `nats-admission.ts` + open mode + dev-identity; rewrite
   the serving loop (unconditional register-hop); D2/D4/D5/D9 migration errors;
   schema; preflight/setup prose.
3. **Plugin channel** — delete handshake surface (`nats-channel.ts`,
   `e2e-session.ts`); keyStore-only crypto invariant; delete `e2e-roundtrip-agent.ts`.
4. **Client** — delete legacy handshake branch + handshake-only crypto exports +
   `e2e-browser-client.ts`; `registration` + `deviceX25519PrivateKey` required
   (constructor-synchronous terminal error, direct + wrapper); rewrite
   `browser-demo-entry.ts` (unconditional registration) + `examples/minimal-consumer`
   stub; audit every remaining construction site (§3.2 last block).
5. **Tests** — delete/rewrite per §6.1; add migration-error tests + A1–A5.
6. **e2e + CI + guards + docs** — D6 harness moves; banned-symbol guard extension;
   CI BASELINE via the §6.3 ledger (reconcile, then update — never bare
   re-measurement); docs sweep (§3.3 stale fixes; F-list below); CHANGELOG.

Each stage ends with a TechLead commit checkpoint (codex cannot write worktree git
metadata).

## 6. Test and guard plan

### 6.1 Test classification (explorer D, TechLead-spot-checked)

DELETE: `nats-admission.test.ts`, `dev-identity.test.ts`,
`e2e/dev-nats-roundtrip.test.ts`, `e2e/enrolled-jwt-roundtrip.test.ts`,
`client/e2e-crypto-browser.test.ts`.

REWRITE: `nats-channel-crypto.test.ts` (drop wildcard-mode harness + key_exchange
helper; keep register-mode crypto), `nats-channel-s2.test.ts` (:61-87 wildcard cap
case out; register cap cases stay), `nats-channel-keystore.test.ts` (:299-337
handshake-interplay cases out), `account-config.test.ts` (devOpen fixture → rejection
case), `nats-credential-source.test.ts` (open rows → migration-error rows),
`setup-wizard.test.ts` (:84), `preflight.test.ts` (auto readiness rows),
client register tests that simulate the agent via `deriveConversationKey` (move
simulation to wrap/unwrap helpers).

KEEP: register/PoP/envelope suites (nats-channel-register, nats-register,
register-pop-gate, nats-channel-ack, nats-subject-permissions, nats-transport*,
client -register/-recovery/-wrapped-key/-replay/-crypto/-liveness/-wrapper,
protocol-version-lockstep, `auth-admission.test.ts` as the D9 guard).

ADD: migration-error tests per D4's two layers (Layer 1: one per removed shape,
process-fatal asserted; Layer 2: one per static signal — mode/credsFile/inline/
env-JWT+seed/env-creds-file — plus env DEV_OPEN, per-account skip asserted);
missing-`registration` / missing-either-private-key / empty-`jwt` construction errors
(direct `WebChannelNatsClient` AND wrapper `WebChannelNATSClient` — D10); pin stays
runtime-terminal (existing P1-7 cause tests keep covering it);
`browser-demo-entry` unconditional-registration test; ac6 explicit-pin migration;
A1–A5; "registerPeer is sole peerSessionKeys writer + stays bounded" unit incl.
exception paths (a subscribe/eviction throw after the :299 key insertion must not
leak an entry — codex R1 MINOR); D8 protocol compat tests (verify existing, extend
if absent); R2 reconnect-resubscribe regression test (`.register` survives transport
replay — `nats-transport.ts:580`).

### 6.2 Guards

Extend `scripts/check-banned-symbols.sh` on BOTH axes (codex R3 — the current guard
scans only `packages README.md docs .github scripts`, missing exactly where the
regressions live):

- **PATTERN** += `key_exchange`, `devOpen`, `DEV_OPEN`, `subscribeWildcard`,
  `handleHandshake`, `resolveAdmissionMode`, `devOpenAgentIdentity`.
- **Paths** += `examples demo e2e .ouroboros` (currently unscanned; they hold live
  hits like `browser-demo-entry.ts:167`, `run-two-account-isolation.sh:196`,
  `demo/run.sh:327` that must all be gone or excluded by the time the guard lands).
- **Documented narrow exclusions** (each with an inline comment naming why): the
  migration-detector seams that legitimately CONTAIN the removed literals —
  `account-config.ts` + its test, `nats-credential-source.ts` + its test (env
  detection + messages), **`openclaw.plugin.json`** (needed specifically for the
  `devOpen`/`DEV_OPEN` patterns — the kept literals `auto`/`open`/`anonymous` are
  not in PATTERN; codex R6/R7) — plus `CHANGELOG.md`, `docs/archive`,
  `docs/review-2026-07-15`, and the guard scripts themselves.

Canary-test every addition (planted symbol per new pattern AND per new path root;
git grep only — rg is absent on real PATH). `pack-load-smoke.sh` allowlist unchanged
unless dist file set changes.

### 6.3 CI baseline — ledger, not re-measurement (codex R4)

A bare "re-measure and set BASELINE" is circular (it would bless accidental test
loss). Stage 5 produces an explicit **balance sheet**, mirroring the P0-1 practice:

    old measured total (1428 @ P0-1 tip)
    − enumerated deletions   (each deleted file/describe with its test count)
    + enumerated additions   (migration errors, A1–A5, D10 ctor tests, …)
    = expected total  →  must equal the measured total; any unexplained delta
      FAILS the review round (investigate before setting BASELINE)

`BASELINE` in `e2e-gate.yml:189` is then set just under the reconciled total.
Update/remove CI steps 8/8b/8d/8f per D6. The ledger goes in the Stage 5 commit
message.

## 7. Risks / open questions (R1 verdicts folded in)

- **Q1 (D2)**: `devOpen:false` presence check — **ACCEPTED by codex R1** (stricter
  migration behavior, intentional; tested + documented).
- **Q2 (D6)**: subsumption of the 3 candidate-delete harnesses — **still open by
  design**: codex R1 concurs deletion must wait for Stage 1 assertion-by-assertion
  evidence. Fallback for any un-subsumed harness: migrate it to the enrolled trust
  chain (never keep open mode).
- **Q3 (D4)**: static-creds un-servability window until P0-3 — codex R1: technically
  coherent, **requires explicit product approval** → flagged to the user in the PR
  body and in the TechLead status report; treated as approved-by-review-text unless
  the user objects.
- **R1 (seam split)**: RESOLVED in D4/D5 (two-layer semantics: Layer 1
  plugin-load-fatal via planAccounts, Layer 2 per-account skip in the serving loop).
- **R2 (reconnect resubscribe)**: **ACCEPTED by codex R1** (transport replays stored
  subjects — `nats-transport.ts:580`); regression test added to §6.1.
- **R3**: docs sweep breadth (explorer F): plugin README, e2e/local README (incl.
  phantom `wildcard-gate.ts`), docs/{AUTH,README,ONBOARDING_GUIDE,
  TRUST_AND_ONBOARDING,STATUS,DEMO_PLAN,SETUP_WIZARD_PLAN,SPLIT_DEMO,
  PHASE6_MULTIDEVICE_PLAN,BACKLOG}.md, docs/gaps/{P0_CORE_CHAT_GAPS,
  P2_ADVANCED_GAPS}.md, `packages/saas/reference/bootstrap-server.ts`,
  demo/ scripts seeding admission. STATUS.md/BACKLOG.md close the C2 residual.
