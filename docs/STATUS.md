# Project Status — single source of truth

_Last updated: 2026-06-26._

This document supersedes any "AC 100% / complete / verified" claim found in commit messages,
Ouroboros seeds (`.ouroboros/*`), evaluator scores, or older notes. Where those conflict with
this file, **this file is correct.**

> **Branch note:** the Phase B live-E2E work below is on branch `ooo/orch_554cce15442a`
> (seed `seed_06e6a09afebf`), **not yet merged to `jwks`**. On `jwks` itself the NATS path
> is still the older "components-only" state.

## TL;DR

- **The Gateway-WS path works end-to-end** (browser ↔ OpenClaw ↔ Claude) — the always-on baseline.
- **The NATS E2E path now works end-to-end in an automated gate** (on this branch): a real
  headless-Chromium browser dials a real `nats-server`, round-trips a ChaCha20-Poly1305 message
  through the real openclaw agent loop, and decrypts the reply — in **both** dev/open-NATS and
  enrolled-JWT modes, with the relay observing ciphertext only. This is the gap that was open for
  months; it is closed and tested.
- **Authz is enforced** (default-deny allowlist at the inbound seam; Ed25519 signed-nonce PoP at
  registration).
- **Not done:** real ClawHub/npm publish (needs registry creds), an explicit AAD-mismatch negative
  test, and the PoP producer-side wiring (SaaS mint + browser sign) for a live register-route test.

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

**Test suite: 751 passing, typecheck clean across all 3 workspaces.**

## What does NOT work yet

| Gap | Detail |
|---|---|
| Real ClawHub / npm publish | Needs registry credentials (CI secrets) + a ClawHub account. The seed sanctions a `DonePublishDeferred` terminal state when creds are absent. See `docs/PACKAGING.md`. |
| PoP producer-side wiring | The PoP *gate* (verification) is done + tested. The *producer* side — SaaS minting the device Ed25519 key into the bootstrap JWT `pop_jwk`, and the browser doing the challenge→sign round-trip — is not yet wired, so there is no live register-route end-to-end test (only the gate's unit tests). |
| Explicit AAD-mismatch negative test (AC2) | Wire-opacity (ciphertext-only) is covered; a dedicated "tampered AAD fails decryption" assertion is not yet separate. |
| Real `index-nats` entry uses plaintext `NatsChannel` | The live E2E uses a deterministic echo agent. The production `index-nats.ts` still wires the plaintext `NatsChannel` (not `CryptoNatsChannel`) and lacks the fail-closed-no-crypto guard — AC-scoped but not yet applied to the real entry. |

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
2. Wire the PoP **producer** side: SaaS mints the device Ed25519 key into the bootstrap JWT
   `pop_jwk`; the browser performs the challenge→sign round-trip. Then add a live register-route test.
3. Add the explicit AAD-mismatch negative test (AC2).
4. Apply `CryptoNatsChannel` + fail-closed-no-crypto guard to the real `index-nats.ts` entry.
5. Packaging + **real** ClawHub/npm publish (registry creds) — or accept `DonePublishDeferred`.
6. Merge `ooo/orch_554cce15442a` → `jwks`.

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
