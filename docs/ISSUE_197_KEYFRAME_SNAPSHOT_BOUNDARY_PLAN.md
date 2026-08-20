# #197 — keyframe snapshot boundary (the "A-plan"): stop the client guessing its replace region

Status: **PLAN (chosen 2026-08-20).** Round 7 of the #173 track. This is the keystone that
ends the review whack-a-mole on the keyframe reducer.

## Why (the root cause the review rounds kept circling)
The #173 keyframe is a **region-scoped authoritative replace**: at turn settlement the plugin
sends the transcript projection and the client REPLACES the covered region of its rendered
bubbles. The client is told the keyframe's **contents** but NOT the **boundary** — which of its
currently-rendered rows the keyframe authoritatively covers. So it GUESSES the boundary by
`findIndex(oldestKeyframeRowId)` ("anchor") and assumes everything after the anchor is covered.

That guess is unsound because:
- **rendered order ≠ transcript order** (held/pending echoes render before the preceding turn's
  final; `history` adoption canonicalizes ids without reordering). So `[U, A, B]` on screen can
  represent transcript `[A, U, B]`; a keyframe `[U, B]` anchors on U at index 0 and **silently
  deletes A**, though A is older than the keyframe window and must be retained. (reviewer-repro'd P1)
- a row that is **not in the keyframe** is ambiguous: it is EITHER older paginated scrollback
  (keep) OR a corrupt live bubble the keyframe exists to delete. Id/order alone cannot tell them
  apart → #201 (anchor-miss nukes scrollback), and every id-dedup patch creates duplicate-id debt
  that corrupts the NEXT keyframe's anchor (the reverted F2 proved this).

Guessing is the disease. Every patch to the guess grows a new edge.

## The fix: the keyframe self-describes its coverage
Make the keyframe carry an explicit **snapshot boundary** so the client scopes the replace by a
stated range, never by id-anchor inference, and never sweeps a row outside that range regardless
of render order.

Two flavors were considered:
- **Client-remembered boundary (rejected as the primary):** the client marks where each applied
  keyframe ended and only lets the next keyframe touch what accumulated since. Simpler (client
  only), but desyncs silently if a keyframe is lost or arrives out of order, and cannot detect it.
- **Server-stamped boundary (CHOSEN, = A-plan):** each keyframe carries its own coverage range +
  a monotonic sequence. The frame is self-describing, so a stale/duplicate/reordered/lost frame is
  detectable and rejectable. Strictly more robust; small additive protocol change.

## Wire (additive; must NOT require per-final identity #111)
Add to the `keyframe` frame (`channel-contract.ts` `OutboundWsMessage`), alongside `messages`:
- `sequence: number` — monotonic per (session, peer). Advances every keyframe. The client rejects
  any keyframe whose `sequence` is <= the last one it applied (defeats reorder/duplicate; a lost
  frame just means the next higher one wins — self-healing).
- a **coverage boundary** identifying the OLDEST transcript position this keyframe authoritatively
  covers. Candidates to settle in the design step (do NOT hard-code yet):
  - the settling `turnId` plus the transcript row ids already carried in `messages` (finals are
    identity-less #111, but transcript ROWS carry core/`h-` ids — usable as coverage anchors), or
  - a transcript-position ordinal if `history.recent` can expose one from the store cursor.
  The boundary's job: let the client partition its rendered rows into
  {strictly-older-than-coverage → KEEP untouched}, {within-coverage → REPLACE with `messages`},
  {newer-than-coverage / local pending chips → KEEP}. It must place a row by the boundary, NOT by
  where the row happens to render.

Plugin side: the settlement emit already reads `history.recent`; stamp `sequence` (per-session
counter) and the boundary there. `sendKeyframe` / `NatsChannel` / `NullPeerChannel` carry the
new fields.

Client side (`nats-client-wrapper.ts` `case "keyframe"`): replace the `anchor = findIndex(oldestKfId)`
logic with boundary-scoped partition. Reject stale by `sequence`. Older-than-coverage rows are kept
by the boundary (kills PR200-F1). The corrupt-live-vs-scrollback ambiguity is resolved because
"within coverage but not in `messages`" = corrupt (delete), "older than coverage" = scrollback (keep)
— no more id-dedup guessing, so NO duplicate ids (kills the F2 class; restores the no-dup-id invariant).

## What this closes
- **PR200-F1** (anchor deletes older uncovered rows) — the P1 that forced this.
- **#201** (anchor-miss resets scrollback) — anchor-miss stops existing; coverage is explicit.
- **#197** itself (this is it).
- the duplicate-id class (reverted F2 / PR204-F2) — no id-dedup needed once coverage is explicit.

## What this does NOT close (stay separate follow-ups; different root = lossy 4-field projection)
- **#202** notice/status bubbles, **#207** failed/retry verdict, **#198** receipt ✓ — all "keyframe
  rebuilt row can't carry live-only state." Orthogonal; needs a richer projection, not a boundary.
  (These are reload-equivalent.)
- **#206 / #208** trigger precision (two-lane false-positive; failed-finalize false-negative) —
  about WHEN to fire, not how to scope the replace. #202 (preserve notices) is what makes any
  over-fire harmless.

## Stack state at plan time (2026-08-20)
- PR2 **#200** (client) tip `9f2b8ba` — region replace reducer; F2 (keptPrefix dup-id carve-out)
  REVERTED because it created a P1 dup-id. 528 client tests green.
- PR3 **#204** (plugin) tip `7f50f67` — keyframe emit; trigger sourced from the controller's
  materialized visible-lane count; settle-order gate; heal verified on BOTH rotation paths
  (structured boundary + divergence). Full suite green.
- #197 work is Round 7 — likely a new stacked PR (plugin stamp + client scope) on top of #200/#204,
  OR folded before merging the stack. Decide sequencing at kickoff.

## Constraints (carried from the whole track)
- No per-final identity (#111) — use transcript ROW ids + turnId + a session sequence, never final
  identity. - Additive protocol only (older clients ignore unknown fields; keep the compat door).
- Never delete a user send's text/affordance to avoid a duplicate — but with explicit coverage the
  dilemma dissolves (no duplicate needed). - `history.recent` read still runs in the detached
  scope (#203). - PRs target develop.
