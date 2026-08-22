# Project Status — single source of truth

Issue #57 / protocol v2 bounds pre-debounce and busy-turn retained work by
shared per-session/process count and charged-byte limits. Newest overflow is
tail-rejected with a durable correlated client failure, and peer/account teardown
releases retained accounting. `/stop` durably suppresses every not-yet-running
entry it kills before releasing reservations. All ingress result frames share
the count/wire/server-payload boundary. Client and plugin require lockstep rollout.

_Last updated: 2026-07-23 (issue #57 retained-work bounds; the 2026-07-05 full re-audit
superseded the 2026-07-01 snapshot, which predated register-over-NATS, the showcase demo,
multi-device, the setup wizard, publishing, and the delivered-issuer fix)._

This document supersedes any "AC 100% / complete / verified" claim found in commit messages,
Ouroboros seeds (`.ouroboros/*`), evaluator scores, or older notes. Where those conflict with
this file, **this file is correct.**

> **Branch note:** `main` and `develop` are converged (merged `--no-ff`, both E2E-gate GREEN:
> develop `79f082e`+`7603b85`, main `9a157eb`). Feature history flowed
> `feature/showcase-demo → feat/deploy → feat/deploy-plugin → develop → main`.

## TL;DR

- **Zero-inbound is real end-to-end.** The register/admission hop rides **NATS**, not HTTP —
  the plugin's HTTP register routes are **deleted** (`packages/plugin/src/nats-register.ts`
  serves `webchannel.{tenant}.{account}.*.register`; all verify failures collapse to one opaque
  `{error:"unauthorized"}`, never an oracle). Browser and agent both dial **outbound-only** to
  the relay; the SaaS is the only HTTP service and is never on the message path.
- **Trust facts are SaaS-delivered at enrollment, not configured.** The device-flow
  `EnrollmentResult` delivers `natsUrl` (rendezvous authority) **and, since 0.1.3, the
  bootstrap-JWT `issuer`** — runtime precedence `operator pin > delivered > derived-from-baseUrl`.
  The `channels add` wizard writes the full config block (no hand-edited `openclaw.json`) and
  deliberately has **no issuer prompt**. Root-cause history: `docs/archive/TRUST_ANCHOR_DESIGN.md`;
  Gate A/B preflight (`packages/plugin/src/preflight.ts`) reports the effective values at add
  time and gateway start.
- **E2E encryption is encrypt-by-construction and fail-closed on both ends** (X25519 + HKDF +
  ChaCha20-Poly1305, canonical-AAD-bound routing; agent refuses to boot unencrypted; browser
  buffers until keyed; ciphertext-only on the wire — wiretap-proven in the demo).
- **Multi-device is production behavior (Phase 6).** The agent owns one conversation key per
  peer (`conversation-key-store.ts`, 0600 on disk) and **wrap-delivers it in the register
  response to the JWT-attested device key** — the register path has NO unauthenticated
  registration anymore (the old `handshake-verifier` is deleted). Two devices on one user each
  decrypt live traffic + snapshots; W6 id/text/positional dedup handles echo adoption.
  Register-hop (bootstrap JWT + PoP) is now the SOLE admission path — P0-2 deleted the
  unauthenticated X25519 handshake and the dev/open-NATS mode entirely.
- **Multi-account multiplex** — one gateway serves `channels.webchannel.accounts.<id>` with
  per-account NATS connections, subject namespaces, verifiers, and admission
  (`multiplex.ts`; 가-1/가-2). Exec/plugin approvals are **accountId-aware** (per-account
  claim/deliver/authz — S1 approvals half, `approvals.ts`).
- **Published & consumable:** plugin `openclaw-webchannel@0.1.0` on **ClawHub**
  (`clawhub:mir-stream/openclaw-webchannel`); libraries `openclaw-webchannel-{saas,client}`
  target the **public npm registry** as of 0.6.1 — zero-auth install, OIDC trusted publishing
  with provenance (tag-triggered `publish.yml`, lockstep versioning; the one-time bootstrap in
  `docs/PUBLISHING.md` gates the first release). Public-API-only consumers exist and are CI-gated:
  `examples/minimal-consumer` (boundary test) and `examples/webchannel-app` (full flow,
  Synadia/NGS external-relay mode, `GETTING_STARTED.md` attach-your-own-openclaw guide).
- **The showcase demo is `demo/run.sh`** (SaaS+admin UI, nats relay, echo/real LLM, 2-agent
  fleet, wiretap): scenes cover fleet grant/revoke, live add-agent, chaos (relay restart,
  cross-tenant, tamper, replay), per-peer isolation, short-TTL re-auth, JWKS rotation,
  multi-device. `DEMO_RELAY=synadia` runs it over real NGS. It deliberately keeps a **fake
  issuer with no agent-side pins**, so every boot live-tests the delivered-issuer path.
  (The old `e2e/local/run-demo.sh` live-chat harness is deleted.)
- **The NATS entry is the sole production transport**; the gateway registers no browser-facing route.
  The earlier HMAC strategy and direct-browser transport have been removed.

## CI — the source of truth

`.github/workflows/e2e-gate.yml` (push to `main`/`develop`/`feature/**`), GREEN on both
long-lived branches:

- 3-package typecheck; full vitest suite (**1371 tests**, hard floor ≥1365) on a real
  `nats-server` v2.14 (absence hard-fails; real-server suites cannot silently skip).
- **4 live harnesses** against a real openclaw gateway + headless Chromium:
  `run-enrolled-transport`, `run-all-real` (production browser + device-flow-enrolled
  plugin on one JWT-auth nats-server — the only stand-in is the echo LLM, by design),
  `run-two-account-isolation`, `run-derived-trust`. (P0-2 removed the three
  dev-open-NATS register harnesses — `run-jwt-register`, `run-saas-issuer-register`,
  `run-browser-jwt-register` — whose assertions `run-all-real` subsumes; two-account
  isolation was migrated onto the enrolled trust chain.)
- Examples consumer tests run with their own runner against freshly built `dist/`
  (`7603b85` — they import the package entry like a real downstream).

`publish.yml` (tag `v*`): build + full test (with nats-server) + `npm publish` of saas+client.

## What works (verified)

| Capability | Evidence |
|---|---|
| Browser ↔ agent chat over NATS, E2E-encrypted, zero-inbound, real LLM | Live-proven on real hardware (split host/container + real NGS relay); `demo/verify-e2e.mjs` + CI `run-all-real` |
| Register-over-NATS admission (PoP challenge→sign→verify, opaque reject, reply-to reginbox guard) | `nats-register.ts` + `nats-register.test.ts`; PR #6 review PASS; N2 guard `949b3a9` |
| SaaS-delivered trust facts (natsUrl + issuer), pin>delivered>derived | `device-flow-types.ts` / `account-config.ts` / `index-nats.ts:deriveAccountAuth`; `issuer-single-source.test.ts`; demo fake-issuer boots pin-less |
| Device-flow enrollment + `channels add` wizard (config-only interactive; `--flag` form enrolls) | `setup-wizard.ts` + Gate A preflight; AC6 real-HTTP device-flow E2E; `run-enrolled-transport` real-NATS harness |
| Multi-device conversation keys (wrap-delivered at register; no registration on register path) | `conversation-key-store.ts`, `nats-client-wrapped-key.test.ts` (fail-closed terminals), `demo/verify-multidevice.mjs` 6/6 |
| Multi-account multiplex + accountId-aware approvals | `multiplex.ts`, `approvals.ts` (+3-lens adversarial review F1/F2 fixed); `demo/verify-multiplex.mjs`, `demo/multiplex.sh` |
| JWKS rotation + eviction (admin-driven, 500→401 fix) | `jwks.ts`; `demo/verify-rotate.mjs`, `verify-evict.mjs` |
| Trust chain, NATS user-cred minting, external (Synadia/NGS) account signing | `packages/saas`; `external-nats-account.test.ts`, `nats-permissions-realserver.test.ts`; demo `DEMO_RELAY=synadia` live |
| Public API boundary (barrel = contract; internals unreachable) | `examples/minimal-consumer/test/boundary.test.mjs`, `examples/webchannel-app/test/no-internal-imports.test.mjs` (CI) |
| Stability hardening from the 2026-07-02 full review | **13 findings fixed + pushed** (C1 crash guard, S1 reconnect, A1 OOM sweeper, S2 map ceilings, S3, A2/A3, CL1–3 incl. terminal-auth state + keepalive liveness, O1/O3/O-min8) — [`REVIEW_2026-07-02.md`](archive/REVIEW_2026-07-02.md) |

## What does NOT work yet / open items

| Gap | Detail |
|---|---|
| **S1 outbound facade** (proactive/approval outbound is primary-account-only) | Cross-account disclosure risk on the agent-initiated leg; the approvals half is done, the outbound facade is the open half. [`BACKLOG.md`](BACKLOG.md) §S1. |
| **C2 (unauthenticated registration) — residual scope only** | Closed on the production register path (conversation key is register-delivered to the JWT-attested device key; `handshake-verifier` deleted). Register-hop is now the sole admission path; the residual is the accepted-risk/untrusted-relay caveat there (the relay carries the admission frames but cannot forge admission). [`BACKLOG.md`](BACKLOG.md) §C2. |
| Direct gateway transport removal | ✅ complete; browser traffic uses the NATS relay only. |
| Demo/reference server hardening (review SEC1/2/5) | The reference/demo SaaS servers are deliberately demo-grade (in-memory stores, printed admin token); production-hardening rewrite is a pending decision. |
| Pre-v2 credential documents | Legacy files without complete credential-binding identity are not reused. Stop the gateway, archive the exact file, complete any required SaaS active-key replacement, and explicitly re-enroll the account. |
| Example app is not a scaffold | The registry half of this gap closes with 0.6.1 — the `openclaw-webchannel-*` libraries move to public npm and need no token, **pending the one-time trusted-publishing bootstrap** (`docs/PUBLISHING.md`), which no release has run yet. The example app is still not a standalone `npm create` scaffold. |
| Telegram-parity gaps | Depth cap, discovery, idempotency, markdown, turn control (`/stop`), etc. — analysis lives on branch `feature/webchannel-telegram-parity` (`docs/gaps/`), not merged. |
| Follow-ups | Live-gateway admission migration (+`dmScope`), conversation-key rotation, agent-initiated-outbound demo scene. |

> **Deployment note (multi-user):** openclaw's default `session.dmScope` (`"main"`) pools
> users into ONE shared session/transcript. WebChannel does NOT depend on the operator getting
> that right — it **forces** `per-account-channel-peer` scoping on its own sessions regardless
> of the global setting (`src/session-route.ts`; the gateway readiness line reports the
> enforced scope). The global default still matters for any OTHER multi-user channel you run.

## Historical record (Phase B closure — condensed, 2026-06 → 07-01)

The full Phase B narrative (live NATS round-trip gates, encrypt-by-construction, PoP producer
side, plugin registration sync-window discovery, the enrolled-transport and all-real
fusions #13–#17, and the "how did the AC signals get contradictory" reconciliation) lived in
the 07-01 version of this file — see git history (`git show 114b03c:docs/STATUS.md`). Two
things to know when reading it:

1. **The HTTP register hop it describes was later replaced wholesale by register-over-NATS**
   (2026-07-03): the HTTP routes, their CORS layer (`register-cors.ts`), and `registerBaseUrl`
   are deleted. The JWT-register harnesses that old file names (`run-jwt-register.sh` etc.) were
   later removed in P0-2 — the register hop is now proven by `run-all-real` / `run-derived-trust`.
2. The "unwired parallel layer" contradiction it reconciles is long closed — the NATS path has
   been the production default since `e384198`, and everything above is downstream of it.

| Landmark | What |
|---|---|
| `e384198` | Production pair live in a real openclaw gateway (first time) |
| `b861fd4` | ALL-REAL fusion harness (#17) — echo LLM is the only stand-in |
| `bad0c15` | 2026-07-02 review fixes complete on develop (13 findings) |
| `f14606d` | Register hop moved HTTP → NATS (PR #6) — agent truly zero-inbound |
| `63faa90` | Phase 6 multi-device (agent-owned wrapped conversation keys) |
| `78d764e` | `channels add` setup wizard (no hand-edited config) |
| `02daa3b`→`v0.1.0` | GitHub Packages publishing live (saas+client) |
| `8bdfe26` | ClawHub plugin publish metadata (plugin 0.1.0 LIVE) |
| `fbe6671` | SaaS-delivered issuer (root-cause fix; pin > delivered > derived) |
| `9a157eb` | develop → main `--no-ff` merge, both gates GREEN |
