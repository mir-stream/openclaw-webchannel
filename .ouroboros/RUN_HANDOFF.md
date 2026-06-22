# Ouroboros Run Handoff — E2E NATS WebChannel

> Self-contained state for resuming after a context compaction. Read this first.

## TL;DR — how to run

- **Runnable seed file (USE THIS):** `.ouroboros/seed_e2e_nats_webchannel.yaml` — QA-passed v (score 0.90).
- `ooo run` → call `ouroboros_execute_seed` with **`seed_path`** pointing at that file.
- ⚠️ Do **NOT** run by `session_id` — the DB (`~/.ouroboros/ouroboros.db`) holds only the **pre-QA iter-0** seed (`seed_0b5fefb3769a`, ambiguity 0.10). The QA refinements (0.87→0.90) live only in the YAML file above.
- `ooo run` is an execution step that mutates code; may require `ooo setup` first.

## Artifacts

| Artifact | Path |
|---|---|
| PRD | `.ouroboros/pm.md` |
| PM seed (handoff) | `~/.ouroboros/seeds/pm_seed_interview_20260622_015505.json` |
| Runnable seed (QA 0.90) | `.ouroboros/seed_e2e_nats_webchannel.yaml` |
| Seed in DB (iter-0, pre-QA) | `seed_0b5fefb3769a` in `~/.ouroboros/ouroboros.db` |
| QA revision audit | `~/.ouroboros/seed-revisions/interview_20260622_024817.md` |
| Interview session | `interview_20260622_024817` (PM interview: `interview_20260622_015505`) |

## Goal

Remove agent-side ingress by routing browser↔agent traffic over a shared **untrusted NATS (WebSocket)** bus; E2E-encrypt all conversation/approval content (X25519 ECDH + HKDF-SHA256 + ChaCha20-Poly1305) so no relay operator reads content plaintext; **SaaS is the single trust anchor** closing browser↔agent and agent↔device key authenticity bidirectionally.

## Locked decisions

- **Topology:** lean — browser → NATS(WebSocket) → agent (outbound only). No operator-run stateful middle server.
- **Confidentiality:** content plaintext only to browser+agent; operator/intermediary + at-rest see ciphertext only. **Routing metadata (agentId/tenant/sub) is plaintext-allowed** (no linkability hiding).
- **Authz:** agent verifies SaaS-issued JWT via JWKS(RS256) + expected sub/claims (existing `jwks` branch RS256+JWKS). Bus isolation via NATS account/subject permission keyed on SaaS JWT claims.
- **Identity:** `peerId = JWT sub` = stable per-user (NOT anonymous — required for multi-device). Each **device** has its own X25519 keypair = the crypto identity carrier (peerId is not).
- **Key trust (NOT TOFU):** SaaS bootstrap pins/signs the **agent** public key AND binds the **device** public key via `cnf` claim (RFC7800-style) + **PoP**. JWT leak alone cannot register a device / obtain the conversation key.
- **Crypto suite:** X25519 ECDH + HKDF-SHA256 + ChaCha20-Poly1305 (libsodium/NaCl) — borrowed from `kakao-talk` benchmark (its TOFU / 1-device / forward-only / at-rest-plaintext weaknesses NOT adopted).
- **Group key:** agent holds the per-user conversation symmetric key, wraps it to each authenticated device pubkey. New device gets wrapped key → decrypts full backlog.
- **Multi-device:** same-user 1:N broadcast sync (multiple devices/tabs of the same sub). NOT a multi-user shared room.
- **Authoritative store:** agent persists history + replays backlog (outbound publish only). Late-join = **full backlog** (forgoes per-message forward secrecy, same-user device set only). At-rest = ciphertext envelopes. Typing = ephemeral client↔client, not stored/replayed.
- **Approvals:** broadcast to all devices; agent single arbiter **first-write-wins exactly-once**; `approval_resolved` fan-out closes the card on all devices. Approval request/decision content is E2E ciphertext.

## Deferred (engineering, intentionally out of seed scope)

- PoP challenge-response protocol + `cnf` claim format details.
- Key rotation cadence + device revocation rekey.
- Exact NATS subject string grammar + durability tuning (JetStream vs agent store).
- Enterprise operator-keyless mode (operator has no key access) — future, contract-driven.
- QA polish notes left for impl: criterion-6 chat-migration quantification, explicit agent→device key-verification criterion, subject-boundary metadata assertion, `typingSignal` boolean-vs-object type.

## Brownfield touch points (verified)

- `packages/plugin/src/jwt.ts` — RS256+JWKS (sub/iss/aud/exp). Add `cnf` device-key binding + PoP.
- `packages/plugin/src/auth.ts:22` — `ConnectionIdentity {peerId, displayName}`. Add device scope / device key.
- `packages/plugin/src/transport.ts:63-96` — Inbound/Outbound envelopes → carry as NATS ciphertext payloads.
- `packages/plugin/src/inbound.ts:212-224` — peerId socket-map reply routing → user-subject 1:N broadcast fan-out.
- `packages/plugin/src/approvals.ts` — `resolveOriginTarget` per-peer reply → agent first-write-wins + resolved fan-out.
- `packages/client/src/types.ts:113-149` — envelopes incl. load_history/history/typing/approval; keep `_AssertDecisionInSync` mirroring.
- Benchmark: adjacent `kakao-talk` repo (kakao-cli crypto e2e, kakao-agent DeviceCrypto).
