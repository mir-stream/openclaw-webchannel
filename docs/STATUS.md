# Project Status — single source of truth

_Last updated: 2026-06-27._

This document supersedes any "AC 100% / complete / verified" claim found in commit messages,
Ouroboros seeds (`.ouroboros/*`), evaluator scores, or older notes. Where those conflict with
this file, **this file is correct.**

> **Branch note:** Phase B (seed `seed_06e6a09afebf`) is **merged to `jwks`** (`c20b552`).
> The production NATS pair is additionally **live-verified in a real openclaw gateway**
> (`e384198`) — see "PRODUCTION pair live in REAL openclaw" below. To reproduce that live test,
> see [`e2e/local/README.md`](../e2e/local/README.md).

## TL;DR

- **The Gateway-WS path works end-to-end** (browser ↔ OpenClaw ↔ Claude) — the always-on baseline.
- **The production NATS pair is live in a REAL openclaw gateway** (`e384198`): a real headless-Chromium
  browser running the production `WebChannelNatsClient` round-trips an encrypted message through the
  `index-nats` plugin loaded in a real openclaw gateway → real `inbound.run` → (deterministic echo
  model) → back, decrypted. This closed the project's core "never run live" gap. Reproduce via
  [`e2e/local/`](../e2e/local/README.md).
- **The NATS E2E path also has an automated gate** (separate demo seam): a real headless-Chromium
  browser dials a real `nats-server`, round-trips a ChaCha20-Poly1305 message through an in-repo echo
  agent, and decrypts the reply — in **both** dev/open-NATS and enrolled-JWT modes, ciphertext-only on
  the wire. (This gate uses `e2e-browser-client`/`e2e-roundtrip-agent`, not the production pair yet.)
- **Authz is enforced** (default-deny allowlist at the inbound seam; Ed25519 signed-nonce PoP at
  registration).
- **Both production ends are now encrypt-by-construction and fail-closed** — the agent (`index-nats.ts`
  refuses to boot without encryption; `NatsChannel` answers a per-peer X25519 handshake and
  ChaCha20-Poly1305-seals every frame) AND the browser (`WebChannelNatsClient` handshakes, seals
  outbound, decrypts inbound, buffers sends until the key exists). Neither ever emits plaintext.
- **Proof-of-Possession is complete on both sides** — the gate (verify) rejects bad/missing/expired
  proofs, and the producer (SaaS mints `pop_jwk`; the browser `registerWithPop` signs the nonce
  challenge) makes the positive path work, proven against a faithful verifier replica.
- **Not done:** real ClawHub/npm publish (needs registry creds). Everything else hermetic is green.

## What works (verified)

| Capability | Evidence |
|---|---|
| Gateway-WS channel: browser ↔ OpenClaw agent ↔ Claude | Runs on `ws://127.0.0.1:18789`; `packages/client/smoke-client.mjs` round-trips a message against a live gateway. `~/.openclaw/openclaw.json` loads the plugin in WS mode. |
| E2E crypto: X25519 + HKDF-SHA256 + ChaCha20-Poly1305 (`packages/plugin/src/e2e-crypto.ts`, `e2e-envelope.ts`) | Unit-tested. |
| NATS transport (`nats-transport.ts`), channel framing (`nats-channel.ts`, `crypto-nats-channel.ts`) | Unit + integration tests vs a real `nats-server`. |
| Trust chain (`packages/saas`): `setupTrustChain` (operator/account JWTs, MEMORY resolver, JWKS), device-flow enrollment (RFC 8628), NATS user-cred minting | AC3 real-server permission isolation 7/7, AC6 device-flow E2E 10/10 — on a real `nats-server` (`@nats-io/nkeys` + `@nats-io/jwt`). |
| npm `openclaw` dependency (peer+devDep), vendored `references/openclaw` removed | `0041b37`, `86bb500`; typecheck clean. |
| **Live NATS E2E round-trip** (browser → nats-server → plugin/agent → reply → browser), dev/open-NATS + enrolled-JWT, ciphertext-only on the wire | `e2e/dev-nats-roundtrip.test.ts` + `e2e/enrolled-jwt-roundtrip.test.ts` — real headless Chromium (playwright-core) + real `nats-server` + real openclaw echo agent. `96339e6`. |
| **DM allowlist authz (gap ③)** — default-deny at the inbound seam | `dm-allowlist.ts` + `inbound.ts` gating; `dm-allowlist.test.ts` + `channel.test.ts`. `ff61d1e`. |
| **Proof-of-Possession (gap ①)** — Ed25519 signed-nonce at registration (401 on missing/invalid/expired/replayed) | `pop-challenge.ts` + register-route wiring; `pop-challenge.test.ts` (7). `d49add0`. |
| **Encrypted NATS entry (encrypt-by-construction) + fail-closed boot (AC 3a)** — agent answers a per-peer X25519 handshake, seals/opens every frame, drops anything it can't decrypt; `index-nats.ts` refuses to boot when encryption is disabled | `nats-channel.ts` crypto mode + `e2e-session.ts` + `encryption-policy.ts` + `index-nats.ts`; `nats-channel-crypto.test.ts` (7, incl. wiretap-ciphertext-only + tampered-AAD drop) + `encryption-policy.test.ts` (4). `3c78c64`. |
| **AAD-mismatch fails decryption (AC 2)** — tampering any plaintext routing field after sealing breaks the canonical-AAD binding and the frame is dropped | `nats-channel-crypto.test.ts` (tampered-routing drop + untampered-accept control); codec-level binding in `e2e-envelope.ts` `canonicalAad`. `3c78c64`. |
| **Production browser client is encrypted + fail-closed** — `WebChannelNatsClient` does the X25519 handshake, seals outbound to `.in`, decrypts inbound from `.out`, buffers sends until the key exists; also fixes two latent bugs (binary ws frames; reversed subject direction) | `nats-client.ts` + shared `e2e-crypto-browser.ts`; `nats-client-crypto.test.ts` (8: handshake round-trip, ciphertext-only wire, fail-closed buffering, drop-on-bad-decrypt, AAD/KDF spec conformance). `6308867`. |
| **PoP producer side (gap ① positive path)** — SaaS mints `pop_jwk` (Ed25519) alongside `cnf.jwk`; the browser generates a device Ed25519 key and `registerWithPop` runs challenge→sign→register | `saas/bootstrap-claims.ts` + `client/pop-register.ts`; `pop-register.test.ts` (7, interop vs a node:crypto verifier replicating `PopChallengeStore.verify`) + `bootstrap-claims.test.ts` (5). `4edba6e`. |
| **PRODUCTION pair live in REAL openclaw** — a real headless-Chromium browser running the production `WebChannelNatsClient` round-trips an encrypted message through the `index-nats` plugin loaded in a real openclaw gateway → real `inbound.run` agent loop (deterministic echo model) → back, decrypted. The reply carries openclaw's real prompt construction, proving it is the real agent path, not the demo echo agent. Fixed plugin-id, `api.registerHttpRoute`, `keepAlive` guard, and added a dev/open-NATS path. | `e2e/local/*` harness (echo OpenAI server + Node + Playwright drivers), run against an isolated `OPENCLAW_HOME` gateway. `e384198`. |

**CI E2E gate is the source of truth** (`.github/workflows/e2e-gate.yml`, GREEN): full vitest suite (50 test files, ≥712-test baseline) + 3-package typecheck + the real-gateway `run-jwt-register.sh` harness, all on a real `nats-server` v2.14 + headless Chromium. (The gate had been RED on a pre-existing rollup optional-dep miss + slow-runner e2e timeouts until `35871d9` / `75ac2ec`.)

## What does NOT work yet

| Gap | Detail |
|---|---|
| Real ClawHub / npm publish | Needs registry credentials (CI secrets) + a ClawHub account. The seed sanctions a `DonePublishDeferred` terminal state when creds are absent. See `docs/PACKAGING.md`. |
| HTTP-register hop exercised by BOTH a Node driver AND a real headless browser | The plain-HTTP register/challenge/unregister routes **are served live** (fix `5597466`), the client **is wired** to call `registerWithPop` (`9aa4b67`), and the JWT-register round-trip is **exercised end-to-end** by `e2e/local/run-jwt-register.sh` + `jwt-register-roundtrip.ts`: with `auth.strategy="jwt"` the agent does NOT `subscribeWildcard` (gated in `index-nats.ts` / `src/wildcard-gate.ts`), so a successful round-trip proves `registerPeer` happened ONLY via the live HTTP hop. The bootstrap JWT is minted via an RS256 JWKS **fixture** (`run-jwt-register.sh`, #13) AND via the **real** reference bootstrap-server with real JWKS-over-HTTP (`run-saas-issuer-register.sh`, **#14 done**). The **real browser/Playwright** JWT variant is **done** (#16, `c4f0a6b`, `e2e/local/run-browser-jwt-register.sh` — added gateway-register CORS), and the full **enrolled-NATS-transport** variant is **done** (#15, `4a70b9b`, `e2e/local/run-enrolled-transport.sh`). |
| Production pair partly in the CI gate | The **JWT-register** real-gateway harness (`e2e/local/run-jwt-register.sh`) is now run by the CI gate (step "Real-gateway live e2e (JWT register hop)"), so the real `openclaw gateway` + `index-nats` + `inbound.run` path is regression-guarded. The gate still ALSO drives the parallel `e2e-browser-client` ↔ `e2e-roundtrip-agent` vitest seam, and the hmac/browser real-gateway harnesses remain manual (follow-up #9). |

## Coverage note

The live E2E gate now exercises the full chain "browser → NATS → plugin/agent → reply → browser"
(the chain the old 731-component-tests never touched). The CI gate (`/.github/workflows/e2e-gate.yml`)
must install `nats-server` and treat its absence as a hard failure (the realserver suites
`describe.skipIf` self-skip locally, but the e2e tests throw when `CI === "true"` and the binary is
missing — so the gate cannot silently no-op).

## How the signals got contradictory

This project was built largely via Ouroboros AI orchestration (`.ouroboros/` seeds → `orch_*`
runs). The contradiction you may have noticed:

- **"Done" signals:** Phase B committed as `feat(phase-b): AC4-6 ... (UNVERIFIED)` (`053920e`);
  the evaluator scored Phase A "APPROVED 0.86, AC 100%"; seeds list "AC1-6 done."
- **"Not done" signals (correct):** `docs/TRUST_AND_ONBOARDING.md:186` lists open gaps including
  "browser NATS dial (still gateway WS)"; `.ouroboros/RUN_HANDOFF.md` calls the E2E-NATS stack a
  "complete but **unwired** parallel layer."

The AC/test framing measured the ACs that were defined — none of which was the end-to-end NATS
integration — so a high score coexisted with an honestly-noted "unwired" caveat. The score won
the narrative; the caveat was buried. (A throwaway echo-bot demo built 2026-06-25 to fake the
agent side made this worse and was removed in `ee89ba3`.)

## To fully close Phase B

1. ✅ Live NATS E2E round-trip (dev + enrolled), authz gates — **done** (`96339e6`/`ff61d1e`/`d49add0`).
2. ✅ Encrypt-by-construction `index-nats.ts` entry + fail-closed boot guard (AC 3a) — **done** (`3c78c64`).
3. ✅ Explicit AAD-mismatch negative test (AC 2) — **done** (`3c78c64`).
4. ✅ Encrypt the production browser client (`WebChannelNatsClient`): handshake + seal + fail-closed,
   matching the agent — **done** (`6308867`; also fixed binary-frame + reversed-subject bugs).
5. ✅ Wire the PoP **producer** side (SaaS mints `pop_jwk`; browser `registerWithPop` signs the
   challenge) — **done** (`4edba6e`).
6. ✅ Merge `ooo/orch_554cce15442a` → `jwks` — **done** (`c20b552`; + TS 5.9 fix `5bd7634`).
7. ✅ Run the production pair (`WebChannelNatsClient` ↔ `index-nats`) live in a real openclaw
   gateway — **done** (`e384198`; harness in `e2e/local/`).

### Remaining follow-ups (none block the hermetic ACs)

8. ✅ **Unblock the HTTP register + PoP hop so it is reachable live** — **done**. Root cause was
   **not** an openclaw limitation: openclaw dispatches plain-HTTP plugin routes fine (a2ui / canvas /
   `/webchannel/ws` all do). The real bug was ours — `index-nats` called `api.registerHttpRoute`
   **after `await transport.connect()`**, and openclaw only honors route registration during the
   **synchronous** `registerFull` window; post-`await` calls silently no-op. Fix: register all three
   routes synchronously at the top of `registerFull` (Step A), handlers read live state via a holder
   populated after async setup. Verified live: `GET /webchannel/nats/register/challenge` → our
   `401 Missing JWT`; the browser↔agent round-trip still passes. (Diagnosis method: instrumented
   the openclaw dist registry/dispatch and bisected sync-vs-after-await registration.)
9. **Fold `e2e/local` into the CI gate** — **JWT-register harness done / in CI**. The gate
   (`.github/workflows/e2e-gate.yml`, step "Real-gateway live e2e (JWT register hop)", after the
   test-baseline check) now runs `e2e/local/run-jwt-register.sh`, so the **real** `openclaw gateway`
   + `index-nats` + `inbound.run` path is regression-guarded (any non-zero exit fails the gate;
   fully hermetic, no secret). The gate still ALSO drives the parallel
   `e2e-browser-client`/`e2e-roundtrip-agent` vitest seam. Remaining: CI coverage for the hmac
   `drive-roundtrip` + browser `browser-roundtrip` real-gateway harnesses, and the
   browser/Playwright JWT variant (see #13).
10. **Converge the demo pair into the production pair** (remove the parallel `e2e-roundtrip-agent` /
    `e2e-browser-client` implementations; point `e2e-browser-client` crypto at shared `e2e-crypto-browser`).
11. ✅ **Wire `registerWithPop` into the browser connect flow** — **done** (`9aa4b67`).
    `WebChannelNatsClient.onConnected` takes an optional `registration` config and awaits
    `registerWithPop` (JWT + PoP HTTP register) **after** subscribing to `.out`/`.handshake` but
    **before** publishing the X25519 handshake (order is load-bearing — NATS has no retention, and the
    agent only subscribes to a peer's subjects after `registerPeer`). Fail-closed + terminal on failure
    (fires `onError`, tears the connection down — a rejected PoP/JWT is a permanent credential problem,
    so it does not hammer-retry); a `connectionEpoch` guard stops a drop+reconnect from letting a stale
    flow publish a stale handshake. The no-`registration` path is unchanged (dev/open-NATS wildcard).
    149 client tests pass.
12. Packaging + **real** ClawHub/npm publish (registry creds) — or accept `DonePublishDeferred`.
13. ✅ **Live e2e of the HTTP register hop + retire the wildcard on the jwt path** — **Node-driver
    variant done**. `index-nats` now gates the dev/open-NATS wildcard: `subscribeWildcard()` is taken
    only when `auth.strategy !== "jwt"` (extracted to `packages/plugin/src/wildcard-gate.ts`
    `shouldSubscribeWildcard`; +5 unit tests in `wildcard-gate.test.ts`). The new hermetic harness
    `e2e/local/run-jwt-register.sh` boots an isolated gateway with `auth.strategy="jwt"` +
    `jwksFile` (fixtures via `e2e/local/gen-jwt-fixtures.mjs`), then drives the production
    `WebChannelNatsClient` with a `registration` config from `e2e/local/jwt-register-roundtrip.ts`:
    it mints an RS256 bootstrap JWT (`sub=peerId`, `cnf.jwk` X25519, `pop_jwk` Ed25519) via
    `packages/saas/bootstrap-claims`, runs challenge → PoP-signed register over the live HTTP route,
    and round-trips an encrypted message. Because the wildcard is OFF on the jwt path, a successful
    round-trip proves `registerPeer` happened ONLY via the HTTP register hop. Remaining: the real
    **browser/Playwright** JWT variant (deferred — Playwright cannot pass an Ed25519 `CryptoKey`
    across the page boundary) against a **real SaaS issuer**. (The Node-driver harness itself is now
    folded into CI — see #9.)
    Production behavior is unchanged: enrolled production runs `devOpenNats=false`, so the wildcard
    was already off there.
14. ✅ **Real-SaaS-issuer live e2e (real bootstrap-server RS256 + real JWKS-over-HTTP)** —
    **Node-driver variant done**. The reference bootstrap-server
    (`packages/saas/reference/bootstrap-server.ts`) is now **real, no longer a mock**: at boot it
    derives a real RSA keypair via `setupTrustChain()`, holds the importable RS256 private key in
    memory, RS256-signs each `/bootstrap` JWT with header `kid` = trust-chain kid (`sub` = the
    `peerId` it returns, derived from the device key when not supplied), and serves the **real**
    public RSA JWK at `/.well-known/jwks.json` (the old `createMockJwt` / hardcoded-`mock-…` JWKS
    paths are gone). The new hermetic harness `e2e/local/run-saas-issuer-register.sh` +
    driver `e2e/local/saas-issuer-roundtrip.ts` boot that server live and point the gateway's
    `channels.webchannel.auth.jwt.jwksUrl` at its JWKS endpoint (HTTP, not a `jwksFile`), so the
    plugin's `verifyJwt` fetches the signing key by `kid` over HTTP from the **real issuer** and
    admits the token through the live HTTP register hop for an encrypted round-trip (exits 0 with
    `[PROOF] real-SaaS-issued JWT (RS256, real JWKS) admitted via live register hop`). Unit-level
    twin: `packages/saas/src/ac6-device-flow-e2e.test.ts` now cross-imports the plugin's `verifyJwt`
    + `JWKSCache` and asserts the issued JWT verifies against the served JWKS (real-issuer↔real-verifier
    interop), and its JWKS/bootstrap assertions are strengthened (real `n` ≥ 256 bytes, kid ≠
    `demo-key-id`, header.kid == served kid, signature ≠ `mock-signature`). JWT issuance is kept
    **independent of NATS transport** (devOpen NATS stays). Remaining: the full
    **enrolled-NATS-transport (device-flow)** variant (**#15, now done — `4a70b9b`**), and the real
    **browser/Playwright** JWT variant against this real issuer (#16, deferred — Playwright cannot pass
    an Ed25519 `CryptoKey` across the page boundary).
15. ✅ **DONE (`4a70b9b`) — full enrolled-NATS-transport (device-flow) integration.** Removes the
    agent-side **devOpen NATS** transport stand-in. The plugin now **device-enrolls (RFC 8628)** with
    the SaaS enrollment-server for tenant-scoped NATS user credentials and connects to a JWT-auth
    nats-server (SaaS operator/account JWT **resolver**, rejects unenrolled connections) via the
    plugin's production `createEnrolledNatsConnection` path — proven live in ONE running gateway by the
    hermetic harness `e2e/local/run-enrolled-transport.sh` + `enrolled-transport-roundtrip.ts`. ONE
    `setupTrustChain()` feeds the enrollment-server, the nats-server resolver (via `NATS_CONFIG_OUT`),
    the gateway JWKS, and the driver creds; auto-approve scrapes the user_code from the gateway log →
    `POST /approve`; encrypted round-trip with a NKEY-authed driver peer. Delta over
    `enrolled-jwt-roundtrip.test.ts`: real device-flow (not in-test `encodeUser`) + real plugin (not
    echo kernel) + production connection code. Production fixes landed: dependency-free NKEY signer
    `plugin/src/nkey-sign.ts` (byte-identical to `@nats-io/nkeys`, kept out of plugin deps; parity test
    in `saas/src/nkey-sign-parity.test.ts`), `nkeySigningCallback` threading, an `EnrollmentClient`
    ctor crash fix, `WEBCHANNEL_SAAS_BASE_URL`, and a NATS perm-scope correction to `webchannel.{tenant}.>`.
    **Finding (gates the all-real fusion):** the production browser `WebChannelNatsClient` cannot
    NATS-layer NKEY-auth (its CONNECT only carries the bootstrap JWT, no nonce-sig), so the all-real
    browser-over-JWT-auth-nats fusion (real browser #16 layered on this enrolled #15 stack) needs
    NKEY-auth added to the browser client first — that's the next real-browser step, beyond #16's
    register-hop variant. Pre-existing security follow-ups (require-PoP config; tenant-token
    sanitization; CORS origin allowlist) tracked in task #20.
16. ✅ **DONE (`c4f0a6b`) — real-browser (Playwright) JWT+PoP register variant.** Removes the
    "client runs in Node" stand-in. A real headless Chromium runs the **production**
    `WebChannelNatsClient` through the **JWT+PoP register hop** against a real gateway (index-nats jwt
    mode) + real reference SaaS issuer + real nats-server + echo, completing an encrypted round-trip —
    `e2e/local/run-browser-jwt-register.sh` + `browser-jwt-register.mjs` + browser entry
    `packages/client/src/browser-jwt-entry.ts`. The original "Playwright can't serialize an Ed25519
    `CryptoKey`" 2-phase-keygen blocker **dissolved**: the whole flow (in-page keygen → issuer
    `/bootstrap` fetch → client w/ registration path → round-trip) runs IN-PAGE, so the non-extractable
    PoP private key never crosses the Node↔page boundary. **Production gap fixed (only a real browser
    reveals it — Node fetch ignores CORS):** the gateway register routes lacked CORS, so a real
    cross-origin browser (widget page origin ≠ gateway origin, per the deployment model) was blocked.
    Added `setRegisterCors` (reflects Origin / `*`, allows Authorization+Content-Type, OPTIONS
    preflight → 204 pre-auth) to `/webchannel/nats/register{,/challenge}`; no `Allow-Credentials`
    (safe — admission still needs an unforgeable Bearer bootstrap-JWT + PoP sig); auth/PoP logic
    untouched. Origin-allowlist hardening tracked in the security follow-up (task #20).
17. ✅ **DONE (`b861fd4`) — ALL-REAL fusion; the all-real end state is reached.** Layered the real
    browser (#16) onto the enrolled JWT-auth-NATS stack (#15) into ONE harness
    (`e2e/local/run-all-real.sh` + `all-real.mjs` + `browser-jwt-entry.ts` `runAllReal()`): a real
    headless Chromium running the **production** `WebChannelNatsClient` NATS-layer **NKEY-authenticates**
    to a real JWT-auth nats-server AND drives the JWT+PoP register hop, while the real plugin (gateway,
    devOpen OFF) is enrolled to that same nats-server via `createEnrolledNatsConnection` — all from ONE
    `setupTrustChain()` — encrypted round-trip GREEN. New production capability that unblocked it:
    NATS-layer NKEY-auth in the browser client (`nats-client.ts` `natsCredentials{userJwt,userSeedRaw}`
    → deferred signed CONNECT over the INFO nonce; absent → byte-for-byte unchanged = zero regression;
    shared `nats-nkey-browser.ts`, webcrypto only, no @nats-io; issuer returns `userSeedRaw` so the
    browser needs no base32 NKEY decoder). **After this, the only runtime stand-in is the echo LLM, by
    design.** Verified GREEN alongside #15/#16 harnesses (no regression); client 151 + saas 66 unit pass;
    real `~/.openclaw` + gateway:18789 untouched. Open follow-ups (none blocking): fold the live harnesses
    into CI; security hardening (task #20); AC4 publish (creds-gated, deferred).

## Commit landmarks

| Commit | What |
|---|---|
| `88a261b` | Phase A data plane landed (real-nats interop test) |
| `187f58e` | Phase B component work (crypto/trust/enrollment) on `jwks` |
| `0041b37` | Depend on npm `openclaw`; drop vendored `references/openclaw` |
| `22133b5` | Wire `index-nats.ts` to the OpenClaw agent loop (the two missing seams) |
| `96339e6` | **Live NATS E2E round-trip gate (AC1 green) + 4 e2e bug fixes** (branch `ooo/orch_554cce15442a`) |
| `ff61d1e` | Default-deny DM allowlist at the inbound seam (AC3 gap ③) |
| `d49add0` | Ed25519 signed-nonce PoP at registration (AC3 gap ①) |
| `3c78c64` | Encrypt-by-construction NATS entry + fail-closed boot guard (AC 3a) + AAD-mismatch test (AC 2) |
| `6308867` | Encrypt the production browser client (handshake + seal + fail-closed); fix binary-frame + reversed-subject bugs |
| `4edba6e` | PoP producer side — SaaS mints `pop_jwk`; browser `registerWithPop` signs the nonce challenge |
| `c20b552` | **Merge Phase B branch → `jwks`** (--no-ff) |
| `5bd7634` | Fix browser HKDF typecheck under TS 5.7+ (`BufferSource`); surfaced by the merge's newer TS |
| `e384198` | **Production pair live in REAL openclaw** + index-nats fixes (id, `registerHttpRoute`, `keepAlive` guard, dev/open-NATS, wildcard); `e2e/local` harness |
| `5597466` | **Serve index-nats HTTP register routes** — register synchronously in `registerFull` (post-`await` calls were silently dropped); corrects the "openclaw 404s plain-HTTP routes" misdiagnosis (#8) |
| `9aa4b67` | **Wire PoP HTTP registration into the browser NATS connect flow** (`registerWithPop` after subscribe / before handshake; fail-closed + terminal; epoch guard) (#11) |
