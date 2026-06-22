# WebChannel NATS E2E Relay

*Created At: 2026-06-22T02:22:40.589325+00:00*

## Goal

Eliminate the requirement to open ingress on the agent-side server by routing browser↔agent traffic through a shared, untrusted NATS bus, while protecting all conversation and approval content with end-to-end encryption so that no relay operator can read plaintext.

## User Stories

1. **As a** Agent/plugin operator, **I want to** connect outbound to a shared NATS bus instead of exposing an inbound ingress port, **so that** removes the need to open ingress on the agent-side server, reducing attack surface and operational risk.
2. **As a** End user (browser), **I want to** exchange chat and approval messages with the agent over the public NATS bus with end-to-end encryption, **so that** their conversation content stays confidential even though the bus is untrusted.
3. **As a** End user (browser), **I want to** verify that the party they are talking to is genuinely the real agent (no MITM key substitution) via the SaaS bootstrap, **so that** they can trust the counterpart without trusting the public bus.
4. **As a** Agent/plugin, **I want to** authorize incoming users by validating their SaaS-issued JWT against the SaaS JWKS and expected sub/claims, **so that** only legitimately onboarded users can interact with the agent.
5. **As a** Relay/NATS operator, **I want to** relay only ciphertext and never plaintext, **so that** the operator is technically a blind relay, satisfying the untrusted-bus security model.
6. **As a** Platform owner, **I want to** avoid running a stateful server tier in the data path, **so that** minimizes operational footprint while still removing agent ingress.

## Constraints

- NATS is an untrusted bus; relay (NATS operator + any intermediate server) must never be able to read plaintext content — pure end-to-end encryption between browser and agent only.
- Lean topology is fixed: browser → NATS (over WebSocket) → agent (outbound connection). No operator-run stateful server in the data path.
- Agent side must not require open ingress; the plugin connects outbound to NATS.
- Key-authenticity trust anchor must ride on the existing SaaS bootstrap (identity handoff) channel — SaaS pins the agent public key / signs the handshake when issuing the JWT; keys never travel over NATS.
- Authorization uses SaaS-issued JWT verified against SaaS JWKS (RS256 + JWKS, handled on the existing jwks branch) with expected sub/claims registered on the agent plugin.
- End-user identity is anonymous/session-scoped, identified by the sub of the SaaS-issued JWT; no stable persistent identity required.
- Brownfield: TypeScript ESM npm-workspaces monorepo (packages/client, packages/plugin); Vitest tests; shared protocol/decision types mirrored between client and plugin via the _AssertDecisionInSync guard.
- Existing Inbound/Outbound discriminated-union WebSocket envelopes must be carried as (encrypted) NATS message payloads.
- Stateful features (session management, history snapshots, typing indicators) must move to the agent side or client, since no intermediate server can process plaintext.

## Success Criteria

1. Agent-side server runs with no inbound ingress port open; the plugin reaches NATS via outbound connection only.
2. NATS operator and any intermediate infrastructure can observe only ciphertext, never plaintext conversation or approval content.
3. Only the end-user browser and the agent can read message plaintext.
4. A browser session can verify the agent's authenticity (resisting bus-level MITM/key substitution) using only the SaaS bootstrap, without trusting NATS.
5. User authorization succeeds via SaaS JWT/JWKS validation before agent interaction.
6. Existing client/plugin chat and human-in-the-loop approval flows continue to function over the new NATS-WebSocket transport.

## Assumptions

- E2E encryption is adopted as a security architecture choice driven by the untrusted bus, not to satisfy any external regulatory or contractual compliance obligation.
- kakao-talk's NATS usage is a reference/benchmark that may be borrowed, not a mandated pattern.
- NATS supports WebSocket connections from the browser, enabling direct browser-to-bus connection.
- The 'auth is identity handoff via the embedding SaaS host' model from prior decisions remains the trust foundation that the E2E key anchor layers on top of.
- A stricter operator-key-less mode may be offered later if a specific enterprise customer contractually requires it.

## Decide Later

The following items were deferred or identified as premature at this stage. They should be revisited when more context is available:

- The exact cryptographic mechanism by which the browser obtains and verifies the agent's key without the untrusted bus impersonating it (key directory vs. bootstrap delivery vs. TOFU/pinning vs. attestation).
- Key rotation mechanics and lifecycle (who rotates the agent's key, key longevity).
- Whether the existing peerId/ConnectionIdentity becomes the cryptographic identity carrier or whether crypto identity sits alongside it.
- Whether to mirror kakao-talk's NATS key-distribution/usage pattern.
- Whether key pairs are ephemeral per browser session or otherwise scoped (engineering choice against the specified anonymous/session identity model).
- Whether/how to add a stricter enterprise mode where even the operator has no key access and forced decryption is impossible (left as a separate future option, contract-driven).
- Reworking the existing reconnecting WebSocket server/reconnect logic to run over NATS WebSocket (accepted as necessary rework).
- Relocating stateful features (session management, history snapshots, typing indicators) from the (removed) intermediate server to the agent side or client.

## Existing Codebase Context

- **openclaw-webchannel** (`/Users/mircorn/workspace/openclaw-webchannel`)
  Webchannel monorepo (client + plugin workspaces, docs, smoke tests) for openclaw.

---

## ⚠️ Superseded by dev interview + seed (2026-06-22)

This PRD is the PM-phase snapshot. The later dev interview (`interview_20260622_024817`)
and the QA-passed seed (`.ouroboros/seed_e2e_nats_webchannel.yaml`, score 0.90) refined
or reversed some items here. Where they differ, **the seed and `RUN_HANDOFF.md` win.**

Notable changes since this PRD:
- **Identity reversed:** "End-user identity is anonymous/session-scoped, no stable
  persistent identity required" → now **stable per-user (`peerId = JWT sub`)**, required
  for same-user multi-device 1:N sync.
- **Several decide-later items closed:** crypto suite (X25519+HKDF-SHA256+ChaCha20-Poly1305),
  SaaS-pinned key trust (not TOFU) for BOTH agent and device keys via cnf claim + PoP,
  per-user conversation key wrapped per device, agent = authoritative store with full-backlog
  late-join, at-rest ciphertext, typing ephemeral, approvals first-write-wins exactly-once.
- **Still deferred:** PoP/cnf wire format, key rotation + device revocation rekey, exact
  NATS subject grammar + durability tuning, enterprise operator-keyless mode.

See `.ouroboros/RUN_HANDOFF.md` for the authoritative current state.

---
*PM ID: pm_seed_interview_20260622_015505*
*Interview ID: interview_20260622_015505*
