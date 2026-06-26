# Project Status — single source of truth

_Last updated: 2026-06-26._

This document supersedes any "AC 100% / complete / verified" claim found in commit messages,
Ouroboros seeds (`.ouroboros/*`), evaluator scores, or older notes. Where those conflict with
this file, **this file is correct.**

## TL;DR

- **The Gateway-WS path works end-to-end** (browser ↔ OpenClaw ↔ Claude). This is the path you
  can run today.
- **The NATS E2E path does not work end-to-end yet.** Its components are built and tested in
  isolation, but a browser message has never actually travelled over NATS, through the plugin,
  into the agent, and back as a Claude reply.
- The reason it _looked_ done is explained under "How the signals got contradictory" below.

## What works (verified)

| Capability | Evidence |
|---|---|
| Gateway-WS channel: browser ↔ OpenClaw agent ↔ Claude | Runs on `ws://127.0.0.1:18789`; `packages/client/smoke-client.mjs` round-trips a message against a live gateway. `~/.openclaw/openclaw.json` loads the plugin in WS mode. |
| E2E crypto: X25519 + HKDF-SHA256 + ChaCha20-Poly1305 (`packages/plugin/src/e2e-crypto.ts`, `e2e-envelope.ts`) | Unit-tested. |
| NATS transport (`nats-transport.ts`), channel framing (`nats-channel.ts`, `crypto-nats-channel.ts`) | Unit + integration tests vs a real `nats-server`. |
| Trust chain (`packages/saas`): `setupTrustChain` (operator/account JWTs, MEMORY resolver, JWKS), device-flow enrollment (RFC 8628), NATS user-cred minting | AC3 real-server permission isolation 7/7, AC6 device-flow E2E 10/10 — on a real `nats-server` (`@nats-io/nkeys` + `@nats-io/jwt`). |
| npm `openclaw` dependency (peer+devDep), vendored `references/openclaw` removed | `0041b37`, `86bb500`; typecheck clean, 731 tests pass. |

**Test suite: 731 passing, typecheck clean across all 3 workspaces.** Note the coverage gap below.

## What does NOT work yet

| Gap | Detail |
|---|---|
| **Live NATS path (browser ↔ Claude over NATS)** | Never run end-to-end. This is the headline gap. |
| NATS plugin entry → agent bridge (`packages/plugin/index-nats.ts`) | Was a **skeleton**: inbound handler was `console.log("TODO: handle inbound message")` and the outbound transport was `null as any`. The two seams are **now implemented** (`22133b5`): inbound routes through `handleInboundMessage` → `api.runtime.channel.inbound.run`; a lazy `Proxy` transport binds to the live `NatsChannel` in `registerFull`. **Typecheck-clean, but not run live and not integration-tested.** |
| NATS connection path for a local run | `index-nats.ts` hardcodes `createEnrolledNatsConnection` (requires the SaaS enrollment server + JWT). No dev/open-NATS path exists for a quick local run. |
| Peer auth on the NATS register route | Requires a `jwt`/JWKS strategy; `anonymous`/`hmac-ticket` are rejected there. |
| Browser dialing NATS in the live client | The client library can speak the NATS WS protocol, but it is not wired to dial NATS / pub-sub the channel subjects. (A browser chat UI is consumer/product work — a consumer builds their own page on the client library; this repo ships no demo UI.) |
| Agent-side cnf/PoP verification wiring (gap ①), allowlist authz (gap ③) | See `docs/TRUST_AND_ONBOARDING.md:186`. Authz is a core-delegated stub. |
| Packaging / ClawHub publish | See `docs/PACKAGING.md` (marked 미완). |

## The coverage gap that hid all this

The 731 tests are real and green — but they verify the **parts in isolation**: crypto round-trips,
transport vs a fake broker, enrollment flows, NATS subject permissions on a real server. **No test
exercises the whole chain** "browser message → NATS → gateway plugin → OpenClaw agent (model) →
reply → NATS → browser." That is exactly the chain that was never wired (the `index-nats.ts`
skeleton), so a non-functional NATS entry passed every check.

**Takeaway:** "731 tests pass" and "AC 100%" mean component-level completion, not a working
end-to-end NATS feature. Don't read them as the latter.

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

## To finish the NATS path (B)

1. ✅ Implement the inbound→agent and outbound seams in `index-nats.ts` — **done** (`22133b5`).
2. Add a dev/open-NATS connection path (skip SaaS enrollment + JWT for local runs).
3. Wire the client library to dial NATS + pub/sub the channel subjects (a browser UI on top is consumer product work, not part of this repo).
4. Run an OpenClaw gateway with the NATS entry + a Claude model (the `claude-cli` runtime needs no
   API key).
5. Add an **end-to-end integration test** for the full chain so this gap can't reopen silently.

## Commit landmarks

| Commit | What |
|---|---|
| `88a261b` | Phase A data plane landed (real-nats interop test) |
| `187f58e` | Phase B component work (crypto/trust/enrollment) on `jwks` |
| `0041b37` | Depend on npm `openclaw`; drop vendored `references/openclaw` |
| `22133b5` | Wire `index-nats.ts` to the OpenClaw agent loop (the two missing seams) |
| `ee89ba3` | Remove the throwaway echo-bot demo |
| `86bb500` | Remove detached `references/openclaw` |
