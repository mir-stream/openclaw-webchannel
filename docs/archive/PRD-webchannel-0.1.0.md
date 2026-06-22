# Product Requirements Document — openclaw-webchannel

**Round 11 (FINAL) · Date: 2026-06-20 · Status: COMPLETE — Ready for `ooo seed`**

## 1. Goal

Dependency-light, authenticated WebSocket web chat channel connecting browser
end-users to an upstream openclaw agent — with human-in-the-loop approvals,
typing indicators, history snapshot/pagination, and bidirectional session-private
media re-served from the webchannel's own authenticated endpoint.

## 2. Scope

In-scope: #1/#2 auth (HMAC ticket + JWT RS256/JWKS), #3 media, #4 channels
status, #5/#6/#7 publish (typing, history snapshot/pagination, publish flow).

Out of scope this round: UX hotfixes — bad-ticket reconnect-loop UX (#8),
mid-session revocation (#9), `trusted-header` built-in (#10).

## 3. Release Boundary (FIRM)

- **REL-1 (FIRM):** 0.1.0 ships auth (#1/#2) + channels-status (#4) + publish
  (#5/#6/#7).
- **REL-2 (FIRM):** Media (#3) is the SOLE conditional / maybe-deferred item,
  gated on its still-unnamed trigger (DL-2); parallel-by-default, pulled to the
  critical path only if the trigger fires.
- **REL-3 (FIRM):** #5 (`openclaw-webchannel-ticket` zero-dep package) is a hard
  prerequisite on the critical path — it ships as part of the published set
  before #6/#7 publish.

## 4. User Stories

- **US-1 (Auth):** Connect over WS via HMAC ticket or JWT (RS256, JWKS-verified).
- **US-2 (Approvals):** Respond to agent-action requests
  `allow-once | allow-always | deny`, gating on client + plugin.
- **US-3 (Typing):** See typing indicators of agent activity.
- **US-4 (History):** Receive history snapshot + paginate prior messages on
  (re)join.
- **US-5 (Inbound media):** Upload media into a unified TTL'd store.
- **US-6 (Outbound media):** Agent media fetched from upstream and re-served from
  `/webchannel/media/<ticket-id>/<file-id>`.
- **US-7 (Media across reconnect):** Retrieve prior media (both directions) after
  reconnect within TTL.

## 5. Firm Requirements

- **R-REL1:** 0.1.0 = #1/#2 + #4 + #5/#6/#7; media #3 conditional on DL-2.
- **R-PUB1:** All three packages (`client`, `plugin`, `openclaw-webchannel-ticket`)
  publish public at initial version `0.1.0`, unscoped names. (#6)
- **R-PUB2:** Publish content checklist: README + MIT LICENSE + ClawHub
  registration + compatibility matrix + CI green. (#7)
- **R-M1:** Unified store for inbound + outbound media.
- **R-M2:** Same fixed-TTL-then-purge lifecycle both directions.
- **R-M3:** Outbound re-serve from own authenticated endpoint
  `/webchannel/media/<ticket-id>/<file-id>` (webchannel fetches bytes from the
  upstream openclaw source, then re-serves).
- **R-M4:** Session-private — accessible only to authenticated participants of
  that live session (as private as the chat itself).
- **R-M5:** Retrieved through the webchannel trust boundary, not direct upstream.
- **R-M6:** Three limits enforced — per-file size cap, media-type allowlist,
  per-session/per-ticket aggregate quota (bounds both time and volume).
- **R-M7:** Media scoped to the logical conversation; survives reconnect /
  resumption within TTL; not bound to the physical connection.
- **R-A1:** TypeScript ESM monorepo (npm workspaces, `packages/*`); Vitest tests
  colocated `*.test.ts`.
- **R-A2:** WS contracts live in `Inbound/OutboundWsMessage` unions in
  `types.ts`; client and plugin stay in sync.
- **R-A3:** Reconnection lifecycle expressed via `ConnectionStatus`.
- **R-A4:** Intentionally dependency-light (no runtime third-party deps unless
  justified).

## 6. Constraints

- **C-1:** New media endpoint + message variants extend the existing
  `Inbound/OutboundWsMessage` unions and are mirrored in the plugin package.
- **C-2:** Media enforcement (caps/quota/allowlist) respects the dependency-light
  posture.
- **C-3:** Short-lived HMAC/JWT credentials are re-minted on reconnect (see DL-6
  for the day-2 download identity implication).

## 7. Success Criteria

- **SC-1:** Upload → agent receives a reference; round-trip verified with a
  `FakeWebSocket`-style stub.
- **SC-2:** Outbound media retrievable via the authenticated endpoint.
- **SC-3:** Media retrievable after reconnect within TTL (logical-conversation
  scope verified).
- **SC-4:** Media unavailable after TTL purge.
- **SC-5:** Over-limit uploads handled per the DL-5 posture (test once resolved).
- **SC-6:** Unauthenticated / non-participant media requests are denied.
- **SC-7:** 0.1.0 acceptance does not require media (#3) unless DL-2 fires;
  auth/channels-status/publish must all pass for release.

## 8. Decide-Later Items (first-class; design/build phase, not this PRD)

- **DL-P1 — DM pairing / `allowFrom` real-user flow (#1/#2):** approval-code flow
  is fully undecided — generator, entry point, approver (operator HITL vs
  self-serve), persistence, code TTL, single-use vs reusable, storage location.
  Blocked on the product decision of operator-mediated vs self-serve onboarding.
- **DL-S1 — `openclaw channels status` integration (#4):** operator-visibility
  scope unconfirmed.
- **DL-PUB1 — Compatibility matrix contents (#7):** which openclaw versions / Node
  versions / browsers must be certified.
- **DL-1 — Media access enforcement mechanism:** credential-per-request
  (ticket/JWT replayed) vs short-lived signed capability URL. (R-M4 property
  firm; method open.)
- **DL-2 — #3 release-gating trigger:** the condition resolving "media blocks
  0.1.0 vs ships text-only" is itself undecided — trigger currently unnamed.
- **DL-3 — Outbound fetch timing:** eager-at-delivery vs lazy-on-first-request.
- **DL-4 — Outbound failure semantics:** failed-media placeholder vs retry vs
  silent drop (incl. retry policy).
- **DL-5 — Limit numbers + enforcement posture:** exact per-file size cap,
  allowlist contents, aggregate quota numbers; AND sync-reject-at-upload vs
  accept-then-fail.
- **DL-6 — Cross-credential identity model:** stable conversation identity carried
  in the credential vs per-credential binding, for day-2 downloads against
  re-minted credentials.
- **DL-7 — Conversation-end purge:** conversation-end purges media early vs media
  always lives out its full TTL.

## 9. Assumptions (tentative — flagged for confirmation)

- **A-2:** `/webchannel/media/<ticket-id>/<file-id>` is the canonical endpoint
  shape (firm intent; exact param naming may shift in design).
- **A-3:** Items #1/#2 (auth), #4 (channels status), #5/#6/#7 (publish) retain
  their prior-round decisions; no new media-driven changes beyond C-3's identity
  implication (DL-6).

---

**Interview status: COMPLETE.** Generated via `ooo pm`
(session `interview_20260620_082158`).
