# Phase B — Control-Plane / Onboarding (handoff for the ONBOARDING interview)

> Self-contained state for resuming after a context compaction. Read this first,
> then run `ooo interview` with `docs/ONBOARDING.md` as the initial context.

## Where we are

- **Phase A (data plane) = DONE.** The E2E NATS relay seed was executed and landed on
  branch `jwks` (impl `de42140` → merge `eeabec1` → `01cb5a8` → `88a261b`). 596 tests pass,
  typecheck clean, evaluator verdict **APPROVED 0.86**. Old artifacts (`.ouroboros/pm.md`,
  `seed_e2e_nats_webchannel.yaml`, `RUN_HANDOFF.md`) are the **record of Phase A — keep, do not
  re-run, do not discard.**
- **Phase B (control plane) = NEXT.** Design source: **`docs/ONBOARDING.md`** (4-party trust
  coupling + onboarding: browser / OpenClaw plugin / NATS / SaaS; SaaS = single trust anchor).
  Phase B builds AROUND the Phase A modules; it is additive, not a rewrite.

## Interview framing (say this up front so it doesn't re-derive the data plane)

> "Data plane (E2E crypto X25519+HKDF+ChaCha20-Poly1305, NATS transport protocol, envelopes,
> multi-device, late-join, approvals content, typing) is ALREADY built & evaluated on `jwks`
> @ `88a261b`. This interview is scoped ONLY to the control plane: SaaS trust-chain, NATS
> decentralized auth, RFC 8628 device-flow enrollment, agent device-key (cnf/PoP) verification,
> and cutting the live channel over from the gateway-WS path to NATS. Treat existing modules as
> brownfield to WIRE, not to reimplement."

Note: the earlier "Phase 2 (real NATS account isolation A/B)" question is **absorbed** here
(it is items B1 + C4 below) — no separate answer needed.

## The incomplete-work inventory (= Phase B scope). Verified by grep on `jwks`.

| id | item | nature | maps to ONBOARDING |
|----|------|--------|--------------------|
| **A1** | Cut the live agent channel over to NATS (today `transport.ts` uses `WebSocketServer {noServer:true}` behind a gateway that owns the listening socket; `channel.ts`/`inbound.ts` do NOT import `NatsTransport`/`crypto-nats-channel`) | wiring | removes gateway-with-ingress dependency |
| **A2** | Browser dials NATS directly (today `client.ts` dials the gateway WS) using bootstrap-supplied url+creds | wiring | gap ② |
| **B1** | Real NATS account/subject permission + SaaS-issued NATS **user JWTs** (today only `PermissionedFakeNatsBroker`; real resolver/config absent) | fake→real | #1, #3 |
| **B2** | Approval first-write-wins exactly-once re-established over NATS (today delegated to OpenClaw gateway via `resolveApprovalOverGateway`) | delegated→native | — |
| **C1** | Agent-side **cnf/PoP** device-key verification (client `handshake-verifier` verifies; plugin `jwt.ts`/`auth.ts` have NO cnf handling) | new | gap ① |
| **C2** | SaaS **`setupTrustChain`**: RS256 key + **NATS account signing seed** (private→SaaS, public→NATS config) | new (root) | #1, "누가 무엇을 쥐나" |
| **C3** | **Device-flow (RFC 8628) enrollment**: SaaS endpoint + plugin boot pairing → receive NATS user creds + **register agent X25519 public key** with SaaS | new | #3 + "숨은 절반" |
| **C4** | NATS server config: operator/account JWT + resolver | new | #1 |
| **C5** | allowlist authorization beyond approvals (OPEN-auth stub history in `approvals.ts`; `TODO(secretref)` in `auth.ts`) | new | gap ③ |

**Dependency order (from ONBOARDING DAG, root = SaaS):**
`C2 → C4 → {C3, B1} → A1·A2·C1 → B2`  (C5 can ride alongside the authz wiring).

## Brownfield modules to WIRE (not reimplement) — all on `jwks`

- `packages/plugin/src/nats-transport.ts` — outbound NATS-WS client (proven against real nats-server in `nats-transport-realserver.test.ts`).
- `packages/plugin/src/crypto-nats-channel.ts`, `e2e-envelope.ts`, `e2e-crypto.ts` — content E2E (unchanged).
- `packages/plugin/src/nats-subject-permissions.test.ts` — encodes the exact `nats.pub.allow`/`nats.sub.allow` keyed-on-tenant model B1 must realize for real.
- `packages/plugin/src/jwt.ts` / `jwks.ts` / `auth.ts` — RS256+JWKS verify; extend for cnf (C1).
- `packages/client/src/saas-bootstrap.ts`, `handshake-verifier.ts` — #4 bootstrap + key pin (extend to carry NATS url+creds for A2).
- `packages/plugin/src/transport.ts` — the gateway-WS path A1 cuts over.
- `packages/plugin/src/approvals.ts` — `resolveApprovalOverGateway` is the B2 seam.

## Locked design decisions already in ONBOARDING.md (interview should confirm, not re-open)

- NATS auth = **decentralized operator/account JWT + resolver** (not static accounts, not app-level).
- Enrollment = **RFC 8628 device flow** (plugin is ingress-free → pulls creds at boot; operator approves with one click; no secret paste).
- SaaS is the **single trust anchor**; `setupTrustChain` is an offline once-ever root step; **no SaaS↔NATS runtime interdependency** (account keypair split: private→SaaS, public→NATS config).
- Boot order: keygen(SaaS) → {NATS, SaaS-svc} → plugin(last).
- Key rotation / revocation = re-call enrollment endpoint (deferred).

## Next command

`ooo interview`  → feed `docs/ONBOARDING.md` as initial context + the framing paragraph above.
(Then `ooo seed` → `ooo run`.) Tenancy / deployment model context: see memory
`webchannel-deployment-model` and `e2e-nats-relay-seed`.
