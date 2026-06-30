# openclaw-webchannel Phase B Completion (NATS E2E + Packaging/CI)

*Created At: 2026-06-26T00:55:51.478038+00:00*

## Goal

Close the gap to declare openclaw-webchannel 'done': make the Phase B browser↔NATS-relay↔plugin↔agent encrypted round-trip live-E2E-verified and secure-by-default, then complete packaging/publish and CI on top of the already-shipping Phase A (Gateway-WS) baseline.

## User Stories

1. **As a** End-user (SaaS web visitor), **I want to** chat with the embedded openclaw agent over a NATS relay where the relay only ever sees ciphertext, **so that** private agent conversations whose confidentiality is not exposed to the relay infrastructure.
2. **As a** Browser client integrator, **I want to** have the client library dial NATS directly from the browser via a wired, headless-Chromium-tested seam, **so that** the real browser-NATS path is exercised, not bypassed by a Node-only test.
3. **As a** Platform/security owner, **I want to** have agent-side cnf/PoP verification enforced so messages with wrong/missing PoP are rejected, **so that** the live pipeline is authenticated, not just confidential.
4. **As a** Tenant administrator, **I want to** have allowlist authorization wired through the plugin (resolveAccount + security.dm policy) with default-deny so non-allowlisted senders are denied, **so that** no open-by-default trust boundary is shipped.
5. **As a** Developer / CI, **I want to** run the full E2E suite locally against an unauthenticated dev/open-NATS relay and locally-minted enrolled-JWT creds with no hosted infra, **so that** the completion gate is reproducible and gateable in CI.
6. **As a** Plugin consumer, **I want to** install the published openclaw-webchannel plugin with proper dist/exports, peerDep, README and license from ClawHub, **so that** the plugin can be adopted as a real public package.

## Constraints

- Phase A (Gateway-WS) is the shipping baseline and is already done; scope is gap-closing, not greenfield.
- Authorization responsibility is split per OpenClaw channel-plugin docs: core evaluates policy via resolveInboundMentionDecision({facts, policy}); the plugin owns identity normalization, supplying allowlist data, and wiring the security seam.
- The completion gate must be CI-runnable with NO hosted infra; enrolled-JWT creds are minted locally via setupTrustChain().
- E2E gate must drive the client's real browser-NATS dial seam through headless Chromium (Playwright) against a real nats-server; Node-only tests are insufficient.
- The relay must observe ciphertext only (E2E crypto: X25519+HKDF+ChaCha20Poly1305).
- Default-deny is the shipped authorization posture.
- Plugin must declare openclaw as a peerDep.

## Success Criteria

1. Automated, CI-runnable test exercises the full round-trip 'browser msg → NATS relay → plugin → agent → reply → relay → browser' via Playwright/headless Chromium against a real nats-server, asserting relay observes ciphertext only.
2. The same E2E test passes in BOTH dev/open-NATS mode and locally-minted enrolled-JWT mode.
3. Dev/open-NATS path is implemented as a required deliverable (unauthenticated local relay for CI).
4. Browser-dialing-NATS is wired in the client library.
5. Gap ① (agent-side cnf/PoP verification) implemented with negative E2E test: wrong/missing PoP confirmation is REJECTED.
6. Gap ③ (allowlist authz) implemented via plugin seam (resolveAccount + security.dm.resolveAllowFrom/resolvePolicy, defaultPolicy:'allowlist', honoring core decision) with negative E2E test: non-allowlisted sender is DENIED.
7. Both negative tests (① and ③) run in both dev-NATS and enrolled-JWT modes within the Playwright + real nats-server harness.
8. CI (.github workflows) exists and runs the gate.
9. Packaging complete: plugin private:true→public, versioned (not 0.0.0), dist build/exports, README, license, openclaw peerDep declared, published to ClawHub.

## Assumptions

- docs/STATUS.md (updated 2026-06-26) is authoritative over saved memory; Phase B is component-verified but NOT live-E2E-verified, so Phase B is the central open gap.
- Test-count drift (712 on jwks vs 731 @0041b37) is incidental churn, immaterial to scope.
- The jwks branch is the working basis; index-nats.ts inbound/outbound seams are wired (commit 22133b5) and typecheck-clean but never run live.
- Component-level results still hold: AC3 cross-tenant isolation enforced by real nats-server, device-flow E2E 10/10, AC1-6 typecheck-clean.
- setupTrustChain() can mint enrolled creds locally, enabling enrolled-JWT mode to be gated in CI without hosted infra.
- The OpenClaw plugin authorization split (core policy eval + plugin identity/allowlist wiring) makes gap ③ a real in-repo, E2E-testable seam rather than fully core-delegated.

## Decide Later

The following items were deferred or identified as premature at this stage. They should be revisited when more context is available:

- Negative/rejection enforcement tests beyond what is gated — NOT deferred; folded in-gate (recorded as the rejected option 2/3).
- A live manual demo against deployed/enrolled NATS infra (option c) is optional evidence, explicitly NOT part of the completion gate.

---
*PM ID: pm_seed_interview_20260626_004643*
*Interview ID: interview_20260626_004643*
