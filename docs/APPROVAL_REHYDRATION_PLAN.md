# Approval Rehydration Plan — pending approvals must survive a widget reload

**Issue:** #15 — "plugin: pending approvals do not survive a widget reload — approval cards are live-only, turn becomes undecidable"
**Status:** APPROVED (adversarial review round 1 folded in — 2 MAJOR + 4 MINOR amendments)
**Date:** 2026-07-09

## 1. Problem

When a user reloads (or reopens) the widget while an exec/plugin approval prompt is
pending, the approval card is gone and can never be answered. The blocked agent turn
waits until the approval times out; a widget whose composer locks while awaiting a
reply is stuck.

Two distinct failure legs, both reported in #15:

- **Leg A (lost pending):** approval prompts travel ONLY on the live channel
  (`approvals.ts` `deliverPending` → `channel.sendApprovalRequest`). The
  register-triggered history snapshot (`nats-register.ts:273` →
  `sendHistorySnapshot`) carries only user/assistant text messages. A reloading
  client re-registers, gets history, but never re-sees the pending approval.
- **Leg B (stale buttons):** a device that missed an `approval_resolved` frame
  (brief disconnect, not a full reload) keeps rendering actionable buttons for an
  approval that was already decided elsewhere. Clicking them fails server-side
  (`handleApprovalDecision` rejects an unknown/finalized binding) but the client is
  never told, so the card stays actionable forever.
- **Leg C (lost decision — surfaced in review):** `decide()` marks the card
  resolved optimistically and publishes `approval_decision` fire-and-forget
  (`nats-client.ts` seal/publish has no ack or retry once the session key exists).
  A decision sealed into a half-dead socket is lost: the card looks resolved, the
  server still waits, the turn times out. A reload self-heals (state wiped,
  snapshot re-hydrates an actionable card) but a mere reconnect does not.

## 2. Current-state facts (verified on develop + review round 1)

Plugin:
- `approvals.ts:495` `deliverPending({accountId, preparedTarget, pendingPayload})`
  already receives the full wire payload (`ApprovalRequestPayload`: id, kind, title,
  description?, prompt, options, expiresAtMs?) plus the target `sessionKey` (peerId)
  and `accountId`. It records an id→account binding (`deliveredApprovalAccounts`)
  used by the widget-click reverse path; the binding is removed in `updateEntry`
  (fires for BOTH resolved and expired), at `:532` — BEFORE the early-return on a
  channel-resolution miss, so a terminal delete placed next to it always runs.
- `updateEntry` (`approvals.ts:529`) is the terminal hook (resolve + expiry) and
  fires PER DELIVERING HANDLER with that handler's `accountId` context.
- One approval id can be delivered on MULTIPLE accounts: `prepareTarget`
  deliberately scopes its dedupeKey per account (`approvals.ts:484-491`), and the
  documented F3 residual fans account-less approvals out to every account's handler
  (`approvals.ts:333-338`). Today that fan-out degenerates to `ANON_PEER_ID` and
  fail-closes at the NATS send, but the store contract must not assume id
  uniqueness across accounts.
- Approval frames ride the peer's `.out` subject
  (`nats-channel.ts:526` `webchannel.{tenant}.{accountId}.{peerId}.out`), sealed
  with the per-peer conversation key K. All devices of the same peer share `.out`,
  so any (re)delivery fans out to every device.
- `nats-register.ts` `handleRegisterRequest` is stateless-idempotent: every
  successful register calls the injected `sendHistorySnapshot(peerId)`. The client
  subscribes `.out` BEFORE registering and buffers pre-key ciphertext frames
  (`nats-client.ts` `drainPendingInbound`), so a frame published right after
  register — i.e. BEFORE the register reply that carries the wrapped K — is never
  lost. The snapshot will ride exactly this pre-key-buffer path in the common case.
- The pending-approval state itself lives in core (the gateway approval runtime);
  the plugin sees it only via the deliver/finalize hooks. There is no SDK call to
  enumerate still-pending approvals from the channel side.
- `WebChannelTransport` is a CLASS (`transport.ts:144`), constructed directly by
  tests — adding a method breaks no mocks. The lazyTransport Proxy and the
  `NatsChannel` casts in `index-nats.ts` go through `as unknown as`, so typecheck
  will NOT force `NatsChannel` to implement a new transport method — the direct
  per-account wiring plus a channel-level test must cover it.
- There are FOUR independent wire-union declarations to extend: plugin
  `transport.ts:76` `OutboundWsMessage`, plugin `nats-channel.ts:56` (its OWN
  `OutboundWsMessage` — not imported from transport.ts), client `types.ts:167`,
  and client `nats-client.ts:140-154` (`InboundMessage`, loose shape — needs the
  new `approvals?` field).
- Unknown inbound frame types fall through both clients' switches silently (no
  default case; `nats-client.ts:1081-1082` casts without a whitelist), so
  old-client/new-plugin and new-client/old-plugin are both compatible. This
  forward-compat property is currently an ACCIDENT — lock it in with a test.

Client (NATS wrapper `nats-client-wrapper.ts`, used by the demo widget):
- `approval_request` (`:337-362`): id-based upsert — new id appended, repeat id
  **replaced in place**. NOTE: replacement builds a fresh entry from the frame, so a
  re-delivered request would CLOBBER a locally-set `resolvedDecision` (latent
  resurrect-buttons hazard once we start re-delivering).
- `approval_resolved` (`:364-369`): patches `resolvedDecision` on the matching
  entry; entries are never removed. `patchApproval` on a missing id is a no-op.
- The `history` handler never touches `state.approvals`; reload ⇒ `approvals: []`.
- `decide()` (`:145-152`) optimistically sets `resolvedDecision` then sends
  `{type:"approval_decision", id, decision}`.
- Demo widget (`demo/web/src/widget.ts:81-105`) renders buttons disabled when
  `resolvedDecision !== undefined` and appends `→ <decision>`.
- The raw-WS client (`client.ts`) mirrors this logic. Wrapper tests DO exist
  (`nats-client-wrapper.test.ts`, zero approval coverage today) — new cases go
  there, not in a parallel file.

## 3. Design

### 3.1 Core idea

The plugin already observes every approval's full lifecycle (deliver → finalize)
with the full wire payload in hand. So:

1. **Plugin-side pending store** (in-memory, module-scoped in `approvals.ts`,
   sibling of `deliveredApprovalAccounts`): keyed by
   **(normalized accountId, approvalId)** → `{payload, sessionKey, accountId,
   deliveredAtMs}`. Written in `deliverPending`, erased in `updateEntry` (per
   delivering handler — account A's finalize never erases account B's entry).
2. **Authoritative snapshot on register**: every successful register additionally
   sends a new outbound frame carrying the peer's complete still-pending set for
   THAT account:

   ```
   { type: "approval_snapshot", approvals: ApprovalRequestPayload[] }
   ```

   Sent ALWAYS, including `approvals: []` — the empty set is precisely the
   reconciliation signal that fixes Leg B.
3. **Client reconciliation** on `approval_snapshot`. The client additionally
   distinguishes an optimistic local decision from a server-confirmed resolution
   via a new internal flag (see §3.3):
   - **id in snapshot, no local entry** → append as pending (Leg A: reload
     rehydration).
   - **id in snapshot, local entry unresolved** → KEEP the existing entry as-is
     (an approval is immutable once minted, so the local entry already holds the
     identical payload; keeping it makes a duplicate snapshot a reference-stable
     state no-op).
   - **id in snapshot, local `resolvedDecision` set but NOT server-confirmed** →
     the decision frame was lost (Leg C): **auto-resend**
     `{type:"approval_decision", id, decision}` and keep the card rendered as
     resolved. Server-side double-resolve is safe (gateway rejects a second
     resolve; `nats-channel.ts:423-446` dedups the resolved echo), and every
     future register retries again, so this converges without user action.
   - **id in snapshot, local `resolvedDecision` server-confirmed** → preserve
     (stale-by-milliseconds snapshot; the confirmed state wins).
   - **id NOT in snapshot, local entry unresolved** → mark
     `resolvedDecision: "unknown"`, server-confirmed (it was decided/expired while
     we weren't looking; no longer actionable). (Leg B)
   - **id NOT in snapshot, local optimistic decision unconfirmed** → mark
     server-confirmed (the server no longer has it pending — plausibly our
     decision won, or another device's did).

Why a snapshot frame instead of just re-emitting `approval_request` frames:
re-emission alone fixes only Leg A. Legs B and C need the client to learn the
authoritative pending set — and once you have the set, re-emission is subsumed.
One frame, one code path, three legs closed.

### 3.2 Plugin changes

`packages/plugin/src/approvals.ts`
- Add `pendingApprovals` store keyed by the composite
  `` `${bindingAccountKey(accountId)} ${approvalId}` `` (NUL separator —
  approvalIds are `crypto.randomUUID()`, account ids are config keys; neither
  contains NUL) → `{payload: ApprovalRequestPayload; sessionKey: string;
  accountKey: string; deliveredAtMs: number}`. Cap-bounded like the binding map
  (evict oldest; approvals are agent-minted, not client-forgeable, so the cap is a
  backstop, not a security boundary — dedicated constant, e.g. 512).
- `deliverPending`: record the entry **unconditionally, before the channel lookup**
  — including the F2 "no live channel" drop and the "no matching open socket" drop.
  Bonus: a prompt that could not be delivered live becomes recoverable on the
  peer's next register instead of being permanently lost. `deliveredAtMs` comes
  from `Date.now()`.
- `updateEntry`: delete THIS handler's account-scoped entry, placed next to the
  existing `deliveredApprovalAccounts.delete(entry.approvalId)` at `:532` (i.e.
  BEFORE the channel-resolution early return, so the delete always runs). Key from
  `bindingAccountKey(accountId ?? entry.accountId)`.
- Export `listPendingApprovalsForPeer(accountId: string | null | undefined,
  sessionKey: string): ApprovalRequestPayload[]` — filters by normalized account +
  sessionKey. Lazy prune on read: drop entries whose `expiresAtMs` is past
  (defense in depth; the runtime's expiry path normally erases them via
  `updateEntry`) AND entries WITHOUT `expiresAtMs` older than a conservative
  `PENDING_APPROVAL_MAX_AGE_MS` (60 min) — an orphan whose finalize never fired
  (e.g. approval monitor disposed on channel stop) must not be re-delivered as an
  actionable zombie card forever.
- Export a small `__pendingApprovalsTestHook` (seed/clear) mirroring the existing
  binding test hook, so register-path tests can drive the same map production
  writes.

`packages/plugin/src/nats-channel.ts`
- Add `sendApprovalSnapshot(peerId: string, approvals: ApprovalRequestPayload[]):
  boolean` → `sendToPeer(peerId, { type: "approval_snapshot", approvals })`. Rides
  the same sealed `.out` path as history/approval frames (fail-closed pre-handshake,
  E2E-encrypted, multi-device fan-out for free).
- Extend nats-channel's OWN `OutboundWsMessage` union (`:56`) — it is NOT imported
  from transport.ts.

`packages/plugin/src/transport.ts`
- Extend the outbound wire union (`:76`) with the `approval_snapshot` frame type
  and add `sendApprovalSnapshot` to the `WebChannelTransport` class (trivial
  socket-map implementation for parity; the legacy dev-only WS server path does NOT
  get register-time emission — it has no stateless register hop).

`packages/plugin/src/nats-register.ts`
- Add injected dep `sendApprovalSnapshot: (peerId: string) => void` alongside
  `sendHistorySnapshot`; call it in the same success block (after
  `sendHistorySnapshot(peerId)`), inside the existing try/catch so a throw still
  replies `REGISTER_FAILED` consistently.

`packages/plugin/index-nats.ts`
- Wire the dep per account:
  `sendApprovalSnapshot: (pid) => channel.sendApprovalSnapshot(pid,
  listPendingApprovalsForPeer(accountId, pid))`.
- **HARD CONSTRAINT: the store read and the publish must be synchronous —
  no `await`/`.then()` between `listPendingApprovalsForPeer` and
  `sendApprovalSnapshot`.** The §3.4 race analysis holds BECAUSE finalize deletes
  the store entry before publishing `approval_resolved` and the snapshot is
  list→publish in one event-loop turn. Do NOT copy `sendHistorySnapshot`'s async
  detached-read shape (`index-nats.ts:243-269`) — that template sits right next to
  this wiring point and is the obvious wrong thing to imitate.
- NOTE: `NatsChannel` reaches the approval capability through `as unknown as`
  casts, so typecheck will not force the new method to exist — the direct wiring
  here plus test §4-6 covers it.

### 3.3 Client changes

`packages/client/src/types.ts`
- Widen `ApprovalRequest.resolvedDecision` to `ApprovalDecision | "unknown"` (the
  sentinel for "resolved elsewhere, outcome unknown"). **Semver note:** this widens
  a published type in `@mir-stream/openclaw-webchannel-client` — an embedder
  switching exhaustively on it breaks at compile. Ship in the usual lockstep bump;
  call it out in the release notes.
- Add internal-ish optional flag `resolutionConfirmed?: boolean` — true only when
  the resolution came from the SERVER (`approval_resolved` frame, or
  snapshot-absence marking). `decide()`'s optimistic set leaves it falsy. The demo
  widget keeps keying its UI off `resolvedDecision !== undefined` unchanged.
- Add the `approval_snapshot` frame to the inbound wire types (`:167` union).

`packages/client/src/nats-client.ts`
- Add `"approval_snapshot"` to the `.out` inbound frame union / `InboundMessage`
  loose shape (`:140-154`, new optional `approvals` field) so it is surfaced to
  the wrapper (it flows through the existing sealed-frame decrypt + pre-key buffer
  machinery unchanged).

`packages/client/src/nats-client-wrapper.ts`
- New `approval_snapshot` handler implementing §3.1(3) reconciliation, including
  the Leg C auto-resend (`this.client.sendApprovalDecision(id, decision)` for a
  locally-resolved-but-unconfirmed id the snapshot still lists as pending).
- `approval_resolved` handler additionally sets `resolutionConfirmed: true`.
- Fix the latent upsert-clobber: when `approval_request` (or a snapshot entry)
  replaces an existing entry, carry over the existing `resolvedDecision` /
  `resolutionConfirmed` if set. This is a correctness fix for re-delivery in
  general, not just snapshots.

`packages/client/src/client.ts` (raw-WS client)
- Apply the same upsert-preserve fix (shared hazard). Do NOT add snapshot handling
  — the legacy WS server never emits the frame; note it in a comment.

`demo/web/src/widget.ts`
- Render `resolvedDecision === "unknown"` as a neutral label (e.g.
  `→ resolved (elsewhere)`); buttons already disable via `resolvedDecision !==
  undefined`.

### 3.4 Ordering & races (analyzed)

- **Snapshot vs live `approval_resolved` (same publisher):** both are published by
  the same agent NATS connection on the same `.out` subject; NATS preserves
  per-publisher order. `updateEntry` deletes the store entry BEFORE publishing
  `approval_resolved`, and the snapshot is store-read→publish in one synchronous
  block (§3.2 hard constraint), so a snapshot can never list an approval whose
  `approval_resolved` was published before it. If a resolution happens after the
  snapshot, the `approval_resolved` frame follows it and patches the entry (and
  sets `resolutionConfirmed`). Converges correctly. The residuals below are
  defense-in-depth, not expected behavior — they only become live if the sync
  constraint is violated.
- **Snapshot resurrecting a locally-resolved card:** prevented by the
  preserve-`resolvedDecision` upsert rule. The client keeps resolved entries in
  state for the session's lifetime, which acts as a tombstone set.
- **Lost decision frame (Leg C):** converges via the snapshot auto-resend rule
  (§3.1). A resend races a concurrent resolution at worst — the gateway rejects
  the loser, the resolved echo is deduped, the client state is already terminal.
- **Fresh reload + resolution racing the register:** the client could receive
  `approval_resolved` for an id it doesn't have (no-op), then a snapshot listing it
  as pending (possible only under a violated sync constraint — see first bullet).
  The card renders actionable; a click is rejected server-side (binding already
  finalized). Residual, tiny, and strictly better than today. Noted as accepted.
- **Multi-device echo:** device B's register triggers a snapshot that also lands on
  live device A (shared `.out`). For A this is an idempotent upsert of state it
  already has; the `"unknown"`-marking rule only fires for entries absent from the
  snapshot, and the snapshot is authoritative at publish time, so A converges to
  the same truth. (A user-message flowing concurrently can add a NEW pending
  approval after the snapshot was built; it arrives as a live `approval_request`
  after the snapshot — append path, unaffected by reconciliation.) Same-account
  scoping (composite store key) guarantees a snapshot for account X never claims
  authority over an approval delivered on account Y.
- **Agent restart:** the store is in-memory, matching the existing
  `deliveredApprovalAccounts` semantics (a restart already orphans in-flight
  approvals — `handleApprovalDecision` fails closed on the lost binding). After a
  restart the first register sends `approvals: []`, which clears stale cards on
  clients — an improvement over today.

### 3.5 Security review (self)

- **No new ingress:** the snapshot is outbound-only, emitted solely from the
  authenticated register success path (JWT + PoP verified). No client-controlled
  input reaches the store; keys/values originate from core-minted approvals.
- **Scoping:** `listPendingApprovalsForPeer` filters by (normalized account,
  sessionKey), so a peer only ever receives its own approvals on the account it
  registered — the same targeting rule as live delivery
  (`prepareTarget`/`resolveOriginTarget`). The composite store key keeps
  per-account deliveries of one approval id independent (the F3 fan-out residual
  is a designed possibility; the store must not collapse it).
- **Confidentiality:** frame rides the sealed `.out` path; the relay sees only
  `envelopeType`/subject metadata, unchanged.
- **Authorization unchanged:** re-delivery does not touch
  `deliveredApprovalAccounts` (binding recorded once at original delivery and kept
  until finalize) and does not widen who may resolve (`handleApprovalDecision`
  approver check unchanged). The Leg C auto-resend goes through the exact same
  authz gate as a live click.
- **Memory:** bounded map, entries erased at finalize; lazy expiry prune +
  max-age prune for entries without `expiresAtMs`.

### 3.6 Out of scope (explicit)

- Persisting pending approvals across agent restarts (would need core cooperation
  or disk state for what core owns; restart already fails closed).
- The legacy dev-only WS path's register-time emission (no stateless register hop).
- **Auto-admission (`admission:"auto"`) NATS accounts** — no register hop, so no
  snapshot; Legs A/B stay open there, mirroring the existing history-snapshot gap
  on that path. This is EXCLUDED BY DESIGN, not a pending follow-up — see §3.7,
  which supersedes the earlier "cheap follow-up = `setHandshakeCompleteHandler →
  sendApprovalSnapshot`" note.
- **Failed-click feedback:** when `handleApprovalDecision` rejects (unknown/
  finalized/foreign id), the client is never told and the card stays actionable
  until the next register. Fixing it needs a reject frame on the decision path —
  file as a follow-up issue; the max-age prune bounds the zombie-card window this
  plan could otherwise create.

### 3.7 Auto-admission accounts get NO approval rehydration — by design

An `admission:"auto"` NATS account (the live gateway's wildcard/handshake mode)
is deliberately EXCLUDED from approval snapshotting. This supersedes §3.6's
earlier "cheap follow-up" note (`setHandshakeCompleteHandler →
sendApprovalSnapshot`): that hook exists and would technically work, but wiring
it there is a SECURITY REGRESSION, not a nicety.

In auto mode peer identity is UNAUTHENTICATED — there is no register hop, no JWT,
no PoP. Any holder of the tenant NATS creds can complete an X25519 handshake as
any `peerId` and take over its outbound `.out` session (documented at the
handshake-registered-peers-only guard in `nats-channel.ts` ~line 745, where even
the history snapshot is withheld from a wildcard peer for exactly this reason). A
handshake-time approval snapshot would hand such a hijacker:

- the **pending approval ids** for the impersonated peer (an information leak), and
- **approve capability** — if the impersonated `peerId` is in
  `execApprovals.approvers`, the snapshot's Leg A rehydrates actionable cards and
  the hijacker can resolve a real pending exec, whereas today those ids only ever
  travel in the mint-time live `approval_request` frame the hijacker already
  missed.

So the snapshot is REGISTER-HOP-ONLY, the same fail-closed precedent as
history-snapshot-for-registered-peers-only. Auto-admission accounts keep Legs
A/B/C open; closing them there requires the authenticated-peer semantics the auto
path by definition lacks.

## 4. Test plan

Plugin (`packages/plugin/src/approvals.test.ts` + register/channel tests):
1. `deliverPending` records the pending entry even when the account channel is
   missing (F2 drop) and when the socket send returns false.
2. `updateEntry` erases the entry for both resolved and expired payloads — and
   erases ONLY its own account's entry: the same approvalId delivered on accounts
   A and B (`deliverPending` from two handler contexts) must list on both;
   finalize on A must leave B's entry intact.
3. `listPendingApprovalsForPeer` filters by account AND sessionKey; prunes
   past-`expiresAtMs` entries; prunes no-`expiresAtMs` entries older than
   `PENDING_APPROVAL_MAX_AGE_MS` and KEEPS younger ones; unknown peer ⇒ `[]`.
4. Cap eviction (oldest evicted at cap, newest retained).
5. `nats-register.test.ts`: successful register invokes `sendApprovalSnapshot`
   exactly once with the verified peerId; failed register does not.
6. `nats-channel`: `sendApprovalSnapshot` emits `{type:"approval_snapshot",
   approvals}` through the sealed send path (guards the un-typechecked
   facade seam — see §3.2 note).

Client (`nats-client-wrapper.test.ts` — extend the EXISTING file; `client.test.ts`):
7. `approval_snapshot` with a fresh state hydrates pending cards (Leg A).
8. `approval_snapshot` marks locally-unresolved entries absent from the snapshot as
   `resolvedDecision:"unknown"` + confirmed; empty snapshot clears all actionable
   cards (Leg B).
9. Snapshot/`approval_request` upsert preserves an existing `resolvedDecision` +
   `resolutionConfirmed` (no button resurrection) — covered for BOTH clients
   (wrapper + raw WS).
10. `approval_resolved` arriving after a snapshot patches `"unknown"`/pending to
    the real decision and sets `resolutionConfirmed`.
11. **Leg C:** locally-decided-but-unconfirmed id listed as pending in a snapshot
    → `approval_decision` frame is re-sent, card stays resolved; the same id
    ABSENT from the snapshot → marked confirmed, nothing re-sent.
12. Pre-key buffered snapshot: `approval_snapshot` ciphertext arriving BEFORE the
    wrapped key is processed survives the pre-key buffer and is applied after key
    delivery (this is the COMMON register path, not an edge).
13. Duplicate snapshots (register retry after a lost reply) are a state no-op.
14. Unknown-frame tolerance: the wrapper ignores an unrecognized frame type
    without throwing (locks in the forward-compat property the rollout depends on).

E2E/manual:
15. Live scenario via the demo: trigger an exec approval, reload the widget mid-
    pending → card reappears and is decidable; decide on device B while A is
    disconnected, reconnect A → A's card shows resolved.

## 5. Acceptance criteria

- Reloading the widget while an approval is pending re-renders a decidable approval
  card after re-register, and deciding it unblocks the agent turn. (Leg A)
- A device that missed the resolution converges to a non-actionable card after its
  next register. (Leg B)
- A decision whose frame was lost is re-sent on the next register and unblocks the
  turn without user action. (Leg C)
- All existing suites stay green (plugin/client/saas); no wire-protocol change to
  existing frame types; legacy WS path behavior unchanged; auto-admission accounts
  explicitly unchanged.

## 6. Review log

- Round 1 (adversarial, fable): APPROVE-WITH-AMENDMENTS — MAJOR-1 (optimistic
  decide vs snapshot authority → Leg C auto-resend), MAJOR-2 (composite
  account+id store key), MINOR-3 (sync read→publish constraint), MINOR-4
  (auto-admission scope), MINOR-5 (max-age prune + failed-click follow-up),
  MINOR-6 (nats-channel's own union), NIT-7 (semver note). All folded in above.
