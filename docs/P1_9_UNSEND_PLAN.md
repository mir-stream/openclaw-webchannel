# P1-9 — Pending-message retraction ("unsend") — Implementation Plan (v4)

> Gap: `docs/gaps/P1_RICH_UX_GAPS.md` §P1-9. Status there: 🟢 web advantage (no
> Telegram equivalent), recommended **Option A — client-side hold**. This plan
> implements Option A. **Zero wire change, zero server change.**
>
> v2 after adversarial review round 1. Material changes: NL-abort vocabulary IS
> now mirrored (round-1 held it, which converted NL aborts into delayed aborts
> of the WRONG turn); hold latches while anything is held (FIFO inversion);
> release gates on session establishment, not the raw connect flip; explicit
> `/stop` marks held text retracted instead of destroying it; stale
> working-draft reconciliation is in scope (it upgrades from cosmetic to a
> send lockout under P1-9).
>
> v3 after round 2. Material changes: the v2 snapshot-finalize leg (§3.6.1) is
> **rejected on dist evidence** — core appends assistant rows to the session
> transcript at `message_end`, i.e. MID-RUN, so "final row in snapshot ⇒ turn
> done" is false; replaced by a post-reconnect staleness valve that never swaps
> the draft's id. Tier-3 adoption must treat local-only bubbles as transparent
> (held chips otherwise break positional adoption — a duplication bug even
> without the finalize). `onSession` fires after `flushQueue()` (ledger replay
> must precede released holds on the wire).
>
> v4 after round 3. Release **moves the bubble to the tail** (display position
> = publish position — in-place release breaks the history merge's local-order
> = transcript-order invariant and corrupts later snapshots); valve timer is
> connection-scoped (cleared on `onState(false)`, re-armed per `onSession` —
> disconnected time never counts against the grace); tier-3 transparency
> narrowed to the candidate probe only (cursor mechanics untouched).

## 1. Goal & acceptance

Today `widget submit()` → `client.send(text)` publishes over NATS immediately;
a message sent while a turn is running sits in the **server-side** coalesce
buffer (`packages/plugin/src/inbound-queue.ts` `pending`) and cannot be pulled
back.

After this change:

- **A1.** Sending while a turn is in flight shows the new message as a
  **pending** bubble with a **✕ retract** control; it is NOT yet published.
- **A2.** Retracting before the turn finishes removes the bubble; the agent
  never receives the text (it was never on the wire).
- **A3.** Leaving it pending delivers it **exactly once** when the turn
  settles (published then; ingress dedupe P0-7a still applies its normal
  guarantees on top).
- **A4.** Nothing regresses when no turn is in flight and nothing is held:
  `send()` publishes immediately, exactly as today.
- **A5.** Abort text — explicit `/stop`, the widget Stop button, AND the current
  43-entry NL abort vocabulary (`stop`, `halt`, `abort`, …) — still aborts the
  running turn mid-turn: abort-shaped text **bypasses** the hold. (Holding it would
  deadlock; releasing it later would abort the WRONG turn — see §3.3.) Under
  the pinned OpenClaw 2026.7.1-2 runtime, `wait` is ordinary text and is held.
- **A6.** User text is never silently destroyed: retraction is an explicit ✕
  tap; the only other path that removes a pending send (`/stop`, §3.4) leaves
  the text visible and restorable.

## 2. Decision — Option A (client hold), wrapper-level

**Where the hold lives: `packages/client/src/nats-client-wrapper.ts`
(`WebChannelNATSClient`), not the widget.**

- The wrapper already owns the ONLY state that defines "turn in flight"
  (`isTyping`, `working` drafts) and the only choke point every send goes
  through (`send()`).
- State-driven: the widget renders `message.pending` / `message.retracted`
  and calls `client.retract(id)` — any embedder (React adapter, admin) gets
  the feature for free.
- Option B (server-side dequeue: `retract` wire frame + by-id dequeue in
  `inbound-queue.ts`) is **deferred**, not rejected — it would additionally
  cover the "published while approval-pending" window (§7.4). The buffer it
  needs exists since P1-8b. Not now: it costs a wire frame + protocol bump for
  a window Option A already shrinks to near-zero.

## 3. Semantics

### 3.1 Hold predicate (when does `send()` hold instead of publish?)

```
turnInFlight = state.isTyping === true || state.messages.some(m => m.working)
shouldHold   = turnInFlight || held.length > 0
```

`turnInFlight` is the same predicate P1-8a's Stop button uses
(`demo/web/src/widget.ts:188`).

**Why the `held.length > 0` latch (round-1 finding):** the wrapper's
`onState(false)` forces `isTyping: false` on disconnect
(`nats-client-wrapper.ts:99`). Without the latch: typing-only turn → M1 held →
socket drops → `turnInFlight` false while `held=[M1]` (release is gated,
§3.2) → M2 sent during reconnect would publish IMMEDIATELY into the SDK
outbound queue and reach the agent **before** M1 — FIFO inversion, transcript
order lied about. With the latch, M2 queues behind M1 and order is preserved
unconditionally.

`send()` behavior:

| condition (checked in order) | action |
|---|---|
| `isLikelyAbortText(text)` (§3.3) | if explicit `/stop`: mark all held as `retracted` (§3.4); either way publish immediately |
| `shouldHold` | append local bubble `{ id: u-<n>, pending: true }`, push onto `held[]`, do NOT publish |
| otherwise | publish via `sendUserMessage()` + append echo — **exactly today's path** |

UX note: the primary button shows "Stop" while `turnInFlight`; a send can also
be held while `held.length > 0` keeps the latch alive during a reconnect
window (button may read "Send"). The chip itself is the truth signal — do not
promise "Stop shown ⇔ held" anywhere user-facing.

### 3.2 Release (when do held messages go out?)

`maybeRelease()` runs after **every** state transition (each inbound frame
handled, `onState` flips, session establishment):

```
if (held.length > 0 && !turnInFlight && state.connected && sessionEstablished)
    → release ALL, FIFO
```

Release = for each held entry in order: `wireId = client.sendUserMessage(text)`,
patch its bubble `{ pending: false, wireId, turnId: wireId }` and **MOVE it to
the tail of `state.messages`** (in held order). The bubble keeps its local id;
its position does NOT stay where it was queued — display position = publish
position (round-3 finding). This is load-bearing for the history merge, not
cosmetics: the anchor/cursor machinery (`nats-client-wrapper.ts:339-343`) and
tier-3's `anchor + 1` probe assume LOCAL ORDER MIRRORS TRANSCRIPT ORDER, which
today always holds because every send publishes at append time. An in-place
release would be the first mechanism to break it — the canonical
`[u2, h3(held), A(draft)]` flow would release h3 ABOVE the reply A while the
server transcript orders it after, and the next routine snapshot (any
device's register) would mis-adopt or duplicate agent bubbles (a released
bubble is `pending: false`, so the §6.3 skip rule rightly no longer applies).
Moving to the tail makes a released bubble an ordinary send in an ordinary
position. It is also the honest UX: the chip visibly drops to the bottom —
"it went out now, after that reply".

Re-entrancy note (implementation): snapshot-and-clear `held[]` BEFORE the
per-bubble `setState` calls — each `setState` fires listeners synchronously
mid-loop, and a listener calling `retract()`/`send()` re-entrantly must see a
consistent `held`.

- **Why release-ALL (not one-per-settle):** the released batch hits an idle
  server session; the first message starts a turn, the rest land in the P1-8b
  coalesce buffer and merge into ONE follow-up turn — exactly the semantics a
  burst gets today. One-per-settle would serialize N held messages into N
  turns and keep chips lingering across turns.
- **`sessionEstablished` (round-1 finding), not the raw `connected` flip:** at
  `onState(true)` the conversation key does NOT exist yet — register + unwrap
  complete later (`nats-client.ts:1236-1238`). Releasing there would push the
  texts into the SDK `outboundQueue` (committed, replay-ledgered, ✕ gone)
  while nothing is publishable — the exact state this gate exists to avoid —
  and would flip the bubbles to `pending: false` BEFORE the register-triggered
  history snapshot is drained (`drainPendingInbound()` runs before
  `flushQueue()`, same lines), re-opening the §3.6 adoption hole for
  released-but-unflushed bubbles. Instead `WebChannelNatsClient` gains a tiny
  `onSession(listener)` hook fired at the two existing key-establishment
  points (register-unwrap path `nats-client.ts:1236` AND the legacy handshake
  path `:1289`), **after `flushQueue()`** — i.e. strictly
  `drain → flush → notify`. After-drain alone is NOT enough (round-2 finding):
  firing between drain and flush would let released holds publish BEFORE
  `flushQueue()` replays the P0-7b unacked ledger (`nats-client.ts:1338-1342`
  front-of-queue replay), re-creating the FIFO inversion through the ledger
  door (an undelivered M1 in the ledger must reach the agent before a held
  M2). The wrapper sets `sessionEstablished` in that callback and clears it on
  disconnect — **before** the `onState` handler's terminal-`"error"` early
  return (`nats-client-wrapper.ts:95`), so the gate never depends on the
  `connected` flag coincidentally covering that path. Releasing on this signal
  means every released send seals-and-publishes immediately, ordered after the
  ledger replay, and any snapshot buffered during the key gap has already been
  reconciled against bubbles that were still `pending: true` (excluded from
  adoption, §3.6).
- A snapshot that arrives AFTER release (wire race) can at worst hit the
  pre-existing, documented identical-text-from-two-devices id-swap edge
  (`nats-client-wrapper.ts:299-303`) — bubble count stays correct. Not new.

### 3.3 Abort bypass — mirror the abort vocabulary (REVERSED from v1)

The server routes abort text out-of-band and aborts **whatever turn is live at
arrival time** (`packages/plugin/src/control-lane.ts:39` `isControlLaneMessage`
→ SDK `isAbortRequestText`). Two constraints follow:

1. A held abort = deadlock (the hold waits for settle; the settle needs the
   abort) — so abort text must bypass the hold.
2. A held-then-released abort = **stale abort**: user types "translate this
   next" then "stop" mid-turn (aimed at the RUNNING turn); both held; turn
   settles; release-ALL publishes the first message (starts a new turn) then
   the "stop" — which control-lanes and kills the user's own just-started
   turn. Multi-device variant: a released "halt" kills a turn another device
   started. So abort text must **never enter `held[]` at all** — bypassing
   only explicit `/stop` (v1) is not enough; the whole vocabulary must bypass
   at send time.

The client therefore mirrors the abort predicate:

```ts
// packages/client/src/abort-mirror.ts (new)
const ABORT_TRIGGERS: ReadonlySet<string> = new Set([ /* the 43-entry set
  pinned VERBATIM (copy mechanically, do not hand-transcribe) from openclaw
  dist abort-primitives ABORT_TRIGGERS */ ]);
const TRAILING_PUNCT = /[.!?！？…,，。;；:：'"’”)\]}]+$/u;
const normalizeAbort = (t: string) =>
  t.trim().toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ")
   .replace(TRAILING_PUNCT, "").trim();
export const isLikelyAbortText = (t: string) =>
  t.trim().toLowerCase() === "/stop" || normalizeAbort(t) === "/stop" ||
  ABORT_TRIGGERS.has(normalizeAbort(t));
export const isExplicitStop = (t: string) =>
  t.trim().toLowerCase() === "/stop";   // mirrors control-lane.ts:56
```

**Why mirroring is safe (the v1 "drift hazard" argument, re-examined):** the
mirror deliberately omits core's `normalizeCommandBody` alias/mention
canonicalization, so it accepts a strict SUBSET of what the server accepts.
Both drift directions are then benign:

- **False positive (mirror says abort, server doesn't)** — impossible while
  the subset property holds; a plugin-package contract test enforces it (§8).
- **False negative (server vocabulary grew; mirror doesn't know the word)** —
  the new word is held like normal text and released later: degraded (the
  §3.3.2 stale-abort residual applies to THAT word only) but bounded to
  vocabulary added to core after the pin. Re-pin on openclaw upgrades.

The contract test lives in `packages/plugin` (which depends on openclaw; the
client package stays zero-dep) and asserts, for every mirrored trigger plus
case/punctuation/whitespace variants, `isAbortRequestText(x) === true` — the
same cross-package drift-guard pattern PACKAGING.md §3 already uses for the
wire types. Core REMOVING a word fails the test (prune the mirror); the test
cannot see additions (accepted residual above). It ALSO enumerates the stop
command's registry `textAliases` (today exactly one: `/stop`,
commands-registry data) and asserts each is mirror-accepted — so a future core
alias (e.g. `/abort` canonicalizing to `/stop` via `normalizeCommandBody`)
fails the test mechanically instead of silently becoming a held stale abort.

Bypassed abort text publishes immediately → the server control lane remains
the single authority on what an abort DOES. A mirror false-positive-in-spirit
(e.g. bare "halt" meant literally) behaves exactly as it does today —
published mid-turn — so the bypass never makes anything worse than the status
quo. `wait`, removed from the abort set at the 2026.7.1-2 pin, is ordinary held
text on both client and server.

Other slash commands (`/status`, …) are held like normal text — an
improvement: today a mid-turn `/status` gets text-coalesced into another
message's paragraph server-side; held, it releases after settle instead.

### 3.4 Explicit `/stop` marks held messages retracted (REVISED from v1)

Server-side, an explicit `/stop` destroys the peer's buffered queue
(`control-lane.ts` `shouldDropBufferedInputOnStop` → `clearPending`): "stop
means stop everything, including what I queued." The client hold is that
buffer's local twin, so explicit `/stop` (typed or the widget button) must
prevent the held messages from auto-releasing when the abort settles —
otherwise they'd immediately start a NEW turn, the opposite of the user's
intent.

But v1's "silently drop them" fails A6 (round-1 finding): client-held text
exists **nowhere else** — unlike the server buffer there is no other copy —
and the server-side drop is even allowlist-gated while a client drop would be
unconditional. So instead of deleting:

- explicit `/stop` moves every held entry out of `held[]` and flips its bubble
  to `{ pending: false, retracted: true }` — kept in the transcript, styled
  "not sent — stopped", text preserved and copyable;
- the demo widget renders retracted bubbles with a **"restore to composer"**
  affordance (tap → `input.value = text`, remove the bubble via `retract(id)`,
  which also accepts retracted bubbles);
- NL abort words (bare `"stop"`, …) do NOT touch held entries — mirroring the
  server, where only the explicit command clears the buffer. They bypass and
  abort; held messages then release normally after the abort settles (same as
  the server's buffered input surviving an NL abort).
- Known nuance (accepted): if a command allowlist is configured and this peer
  is NOT authorized, the server neutralizes the `/stop` while the client has
  already marked its held messages retracted. With v2 semantics nothing is
  lost — the text sits in retracted bubbles, one tap from re-sending.

### 3.5 Retract

`retract(localId: string): boolean` on the wrapper: if a message with that id
exists AND (`pending === true` OR `retracted === true`) → remove it from
`held[]` (pending case) and from `state.messages`, return true. Anything else
→ false, no-op. There is no race with release: both run on the single JS
thread, and release flips `pending` off synchronously before any user event
can observe it.

### 3.6 Stale working-draft reconciliation (IN SCOPE — round-1 finding, redesigned in v3)

If the final `agent_message` / `turn_settled` is lost in a disconnect window
(core NATS has no retention), the `working` draft can never finalize today:
the register snapshot refuses to adopt onto it (`nats-client-wrapper.ts:298`
"a working draft is never an adoption target") and no live frame with its id
will ever arrive. Pre-P1-9 that cost a stuck "Stop" label and a stray draft —
sends still worked. Under P1-9 `turnInFlight` would be **permanently true → a
permanent send lockout**, and this happens on any turn that ends inside a
reconnect window, not just agent death.

**Rejected approach (v2), for the record:** finalize the draft from the
register history snapshot via tier-3 positional adoption. Its premise —
"the finalized row exists in the snapshot iff the turn already completed" —
is FALSE by pinned-core observation: core appends user/assistant/toolResult
messages to the session transcript **per `message_end` event, mid-run**
(internal behavior verified at 2026.7.1-2), and an
agentic turn emits multiple assistant messages around tool calls. Since a
snapshot is broadcast to EVERY device whenever ANY device registers
(`nats-client-wrapper.ts:279-283`), a mid-turn snapshot with intermediate
assistant rows is a routine event, and snapshot-finalize would: finalize the
live draft early → release held messages mid-turn (defeats A1/A2), and swap
the draft's live id away so subsequent progress/final upserts fallback-append
a persistent duplicate agent bubble. Not recoverable client-side; rejected.

The v3 fixes, neither of which ever swaps a draft's id:

1. **`turn_settled` finalize:** on `turn_settled`, also flip
   `working: false` on any draft whose `turnId` matches the frame's (today
   the handler only clears `isTyping`, `nats-client-wrapper.ts:646-649`).
   Settled means no more upserts are coming; in the normal flow the final
   `agent_message` already did this and it's a no-op.
2. **Post-reconnect staleness valve:** when `onSession` fires (§3.2) and a
   `working: true` draft exists, record the draft ids and arm a one-shot
   grace timer (`STALE_DRAFT_GRACE_MS = 30_000`). Any frame that touches a
   recorded draft — a `progress`/`agent_message` upsert on its id, or a
   `reasoning` frame on its `turnId` — clears it from the watch set (the turn
   is demonstrably still alive). On expiry, drafts still in the set flip
   `working: false` **in place** (id and text untouched) and `maybeRelease()`
   runs. **Timer lifecycle (round-3 finding): the watch set AND the timer are
   cleared on every `onState(false)` and on `close()`, and armed FRESH on
   every `onSession`** — the grace must count only connected time (a timer
   surviving a mid-grace flap would count seconds during which no disarming
   frame could possibly arrive, and could expire moments after frames resume).
   This also makes expiry-while-disconnected structurally impossible rather
   than merely release-gate-blocked. Safety analysis:
   - The id is never swapped, so even a WRONG staleness guess cannot
     duplicate bubbles: a later progress upsert still matches the id and
     simply flips the draft back to `working: true` (self-healing; the
     re-flip re-engages the hold for future sends — already-released holds
     were server-queued, which is exactly today's behavior).
   - False-positive window (turn alive but >30s frame-silent across a
     reconnect, e.g. one long silent tool call): held messages release early
     into the server coalesce buffer — retractability ends early,
     correctness (order, exactly-once) unaffected.
   - The valve arms ONLY on session re-establishment, never during a healthy
     connection — the normal lifecycle can't trip it.

Residual (accepted): the false-positive window above, and a stale draft's
partial text remaining in the transcript as a plain bubble (its true final
text arrives only via a later snapshot as a separate row — the pre-existing
cosmetic cost of a lost final, now without the lockout). The held chips stay
retractable throughout and `/stop` recovers text (§3.4): annoying, never
lossy.

## 4. Wire / protocol impact — NONE

No new frames. `InboundWsMessage` / `OutboundWsMessage` unchanged.
`WEBCHANNEL_PROTOCOL_VERSION` unchanged. No plugin/server runtime edits (the
plugin package gains only a test). Lockstep publish still bumps both packages
(publishing gotcha), but there is no compatibility coupling: old client vs new
plugin and vice versa are both fine.

## 5. API / type changes (client package — additive, semver-minor)

`packages/client/src/types.ts`:

```ts
export type ChatMessage = {
  // ...existing...
  /**
   * P1-9: true while this user message is HELD locally (a turn was in flight
   * at send time) and not yet published. Local-only — never on the wire,
   * never in history. Flips off (with wireId/turnId assigned) at release.
   */
  pending?: boolean;
  /**
   * P1-9: an explicit /stop converted this held message into a not-sent
   * marker. Local-only. Text preserved; removable via retract(id).
   */
  retracted?: boolean;
};
```

- `WebChannelNATSClient`: new public method `retract(id: string): boolean`.
- `WebChannelNatsClient` (inner): new `onSession(listener: () => void)` hook
  (§3.2) — fired on key establishment, both register-unwrap and legacy
  handshake paths.
- New module `packages/client/src/abort-mirror.ts` (§3.3), exported for the
  plugin-side contract test (also via the barrel? NO — keep it out of the
  public barrel; the contract test imports the source path like the demo
  does).
- No `WebChannelState` shape change (pending/retracted derivable from
  `messages`).

## 6. File-by-file changes

### 6.1 `packages/client/src/abort-mirror.ts` (new)

Per §3.3. Pure functions + the pinned trigger set; no imports.

### 6.2 `packages/client/src/nats-client.ts`

`onSession` hook: listener set + `notifySessionListeners()` called at the two
existing `sessionKey = …; drainPendingInbound(); flushQueue();` sites
(`:1236`, `:1289`), **after `flushQueue()`** (strictly drain → flush →
notify; see §3.2 — notifying between drain and flush re-creates the FIFO
inversion via the ledger replay).

### 6.3 `packages/client/src/nats-client-wrapper.ts`

- Private `held: Array<{ localId: string; text: string }>` (insertion order)
  + `sessionEstablished: boolean` (set via `onSession`; cleared on ANY
  `onState(false)` — before the terminal-`"error"` early return at
  `nats-client-wrapper.ts:95`, so the clear never depends on that branch's
  behavior).
- `send()`: per §3.1 table (§3.3 bypass first, then the hold latch).
- `retract(id)`: per §3.5.
- Private `maybeRelease()`: per §3.2. Call sites: end of `handleMessage()`
  (after the switch), the `onState` callback, and the `onSession` callback.
- Explicit-`/stop` path: `markHeldRetracted()` per §3.4.
- **History adoption exclusion (correctness-critical):** in the `history`
  handler, `isLocalLiveId` currently treats ANY `u-*` id as adoptable
  (tier-2 text match). A held bubble must NEVER be an adoption target — a
  snapshot row with identical text (same text sent from another device) would
  adopt its server id onto our UNSENT bubble, and the later release would
  then run/duplicate it. Change (also excludes retracted markers):

  ```ts
  m.role === "user"
    ? m.id.startsWith("u-") && m.pending !== true && m.retracted !== true
    : ...
  ```

- **Tier-3 transparency for local-only bubbles (round-2 finding):** held
  chips sit BETWEEN the anchor and the agent reply they delayed — while a
  hold is alive (multi-frame reply keeping a second draft working, or a
  snapshot drained before `onSession` opens the gate), the layout is
  `[u2, h3(pending), A]`. Tier-3's candidate probe is hard-coded to
  `anchor + 1` (`nats-client-wrapper.ts:381-391`), which lands on the held
  chip (role `user`) and misses `A` → the snapshot row fresh-inserts →
  duplicate agent bubble. This breaks adoption the moment held chips exist,
  independent of any finalize logic. Fix: the tier-3 candidate probe skips
  `pending`/`retracted` bubbles (local-only, can never correspond to a
  snapshot row) and takes the first non-local candidate after the anchor.
  **Cursor mechanics are UNTOUCHED** (round-3 clarification): fresh rows
  still insert at the plain cursor index — inserting before a held chip is
  chronologically correct, since anything the snapshot carries predates the
  unpublished chip. Only the probe skips. Released bubbles need no rule here:
  release moves them to the tail (§3.2), so they are ordinary in-order sends
  by the time any snapshot sees them.
- **`turn_settled` draft finalize** per §3.6.1 and the **post-reconnect
  staleness valve** per §3.6.2 (watch set + `STALE_DRAFT_GRACE_MS` timer;
  cleared on every `onState(false)` and on `close()`, re-armed fresh on
  every `onSession`).
- `ack` handler: no change — held bubbles have no `wireId`, naturally skipped.

### 6.4 `demo/web/src/widget.ts`

- Pending user bubble: reduced opacity + inline row
  `⏳ queued — sends when the agent finishes` + `✕` → `client.retract(m.id)`.
- Retracted bubble: struck/dimmed `not sent — stopped` + `restore` + `✕`.
  Restore must NOT clobber a draft the user is mid-typing: if `input.value`
  is non-empty, append (`input.value = input.value + " " + text`) instead of
  replacing; then `client.retract(m.id)`.
- Composer stays enabled while holding (unlike the terminal-error state).
- `latestUser` (`widget.ts:239`): skip `pending`/`retracted` bubbles — they
  have no `turnId`, and letting one become `latestUser` would resurrect the
  "agent is typing…" line next to a live reasoning lane.
- `historyBtn` (`widget.ts:390`): oldest-cursor pick additionally excludes
  `pending`/`retracted` bubbles (a local-only id must never be sent as a
  `before` cursor).

### 6.5 `packages/plugin/src/abort-mirror-contract.test.ts` (new, test-only)

§3.3 contract test: imports `isLikelyAbortText` from the client source and
`isAbortRequestText` from `openclaw/plugin-sdk/command-primitives-runtime`;
asserts the subset property over the full mirrored set × variants, plus
negative fixtures ("stop it now", "/stop now", "stopwatch"), plus the stop
command's registry `textAliases` each being mirror-accepted (§3.3 — closes
the future-alias door mechanically).

### 6.6 Docs

`docs/gaps/P1_RICH_UX_GAPS.md`: mark P1-9 built (Option A), update the
execution-order table, note the vocabulary-mirror subset + re-pin-on-upgrade
maintenance duty. Also add one line to the known-edges list: a bypassed
mid-turn immediate send (e.g. an NL abort echo) sitting between the anchor
and the reply blocks the tier-3 positional probe when the server does not
transcript that text — a PRE-EXISTING edge (any mid-turn immediate send does
this today, byte-for-byte the same path), documented while P1-9 touches that
probe, not changed by it.

## 7. Edge cases & accepted trade-offs

1. **Deadlock / stale abort** — closed by the §3.3 send-time bypass of the
   FULL vocabulary. Residual: vocabulary added to core after the pin (§3.3).
2. **FIFO inversion across disconnect** — closed by the `held.length > 0`
   latch (§3.1).
3. **Approval-wait window** — `approval_request` flips `isTyping` false
   (`nats-client-wrapper.ts:469/487`); if no `working` draft is live, held
   messages release and land in the server coalesce buffer behind the
   approval-blocked turn (unretractable from that point). Exactly today's
   behavior for that window — Option A never makes it worse. Fixing it needs
   either treating unresolved approvals as in-flight (WRONG: a rehydrated
   approval card with no running turn would hold sends forever) or Option B.
   Accepted; noted in the gap doc.
4. **Reload / teardown / terminal error with held messages** — local-only,
   lost with the page (never sent). The Option A trade-off the gap doc names;
   the chip label says "queued — sends when the agent finishes". Accepted.
5. **Wedged predicate** — closed by §3.6 (`turn_settled` finalize +
   post-reconnect staleness valve); residuals documented there. Snapshot-based
   finalize is explicitly rejected (mid-run transcript rows, dist-verified).
6. **Multiple held messages** — release-all; server runs 1 turn for the first
   + 1 coalesced turn for the rest (§3.2, `inbound-queue.ts:178-188`). Bubble
   count and order always correct.
7. **Send while disconnected with nothing held** — unchanged from today:
   publishes into the SDK outbound queue (fail-closed, replayed). The hold
   only ever delays a publish that would otherwise happen NOW.
8. **History/dedup interplay** — released messages get fresh `wireId`s at
   publish time (P0-7a id minted then), so ingress-dedupe and the ack/replay
   ledger see a completely ordinary send. Pending/retracted bubbles are
   excluded from snapshot adoption (§6.3).

## 8. Test plan

`packages/client/src/nats-client-wrapper.test.ts` (existing fake-transport
harness — extend the fake to support **delayed key establishment** AND an
undelivered-ledger scenario so the pre-session window and the replay ordering
are actually exercisable), new describe block:

1. idle send publishes immediately (A4 regression pin).
2. send during `isTyping` → not published, bubble `pending: true`, no `wireId`.
3. send during a `working` draft (isTyping already false) → held.
4. `agent_message` final → held released FIFO: publish order, bubbles patched
   `{pending: false, wireId, turnId}` AND moved to the tail of
   `state.messages` in held order (§3.2 — display position = publish
   position).
5. `turn_settled` (typing-only turn, no draft) → releases.
6. `retract` on a pending id → bubble gone, nothing published after settle
   (A2); on a non-pending, non-retracted id → false, no-op.
7. explicit `/stop` mid-turn → published immediately (A5) AND held bubbles
   flip to `retracted` (still in transcript, removable via retract);
   case/whitespace variants (`" /STOP "`).
8. NL `"stop"` / `"halt"` / `"Stop."` mid-turn → bypass: published
   immediately, `held` untouched (A5; pins the §3.3 reversal); `"wait"`
   follows the ordinary-text hold/release path under the current pin.
9. **latch:** typing-only turn → M1 held → `onState(false)` (isTyping drops)
   → send M2 → M2 held (not published); reconnect + session → release order
   M1, M2 (pins §3.1).
10. **session gate + ledger order:** settle while disconnected → no release;
    `onState(true)` alone → still no release; `onSession` fires → releases
    (the fake's delayed key makes the middle assertion real). Variant with an
    undelivered P0-7b ledger entry M1 and held M2: wire order after reconnect
    is `[M1 (ledger replay), M2 (released hold)]` — pins the
    drain→flush→notify ordering (§3.2/§6.2).
11. snapshot with identical text does NOT adopt onto a pending (or retracted)
    bubble; after release both bubbles exist distinctly (§6.3).
12. **tier-3 transparency:** construct the reachable layout — multi-frame
    reply: `[u2, h3(pending), A1(final), A2(working)]` (the second draft
    keeps the hold alive) — then snapshot `[u2row, A1row]` → `A1row` adopts
    onto `A1` THROUGH the held chip (no duplicate agent bubble); variant via
    the delayed-key fake (snapshot drained before `onSession` opens the
    gate). Pins §6.3 (round-2 finding; round-3 reachability fix).
12b. **post-release snapshot:** `[u2, h3(held)]` → reply A finalizes → h3
    releases (moves to tail: `[u2, A, h3]`) → snapshot
    `[u2row, Arow, h3row, Rrow]` → clean adoption in order, no duplicates,
    no mis-adoption; multi-frame variant `[u2, h3, h4]` → release →
    snapshot `[u2row, A1row, A2row, h3row, h4row, Rrow]` (pins §3.2
    move-to-tail, round-3 finding).
13. **no snapshot finalize:** working draft + mid-turn snapshot containing
    intermediate agent rows → draft survives `working: true`, held stays held
    (pins the §3.6 v2-rejection).
14. **staleness valve:** working draft + reconnect (`onSession`) + no
    draft-touching frame for `STALE_DRAFT_GRACE_MS` (fake timers) → draft
    flips `working: false` in place (id/text unchanged), held releases;
    variant where a `progress` upsert arrives inside the grace → valve
    disarmed, held stays held; variant where a post-expiry `progress` arrives
    → same bubble (by id) flips back `working: true`, no duplicate; variant
    where the socket flaps mid-grace → timer cleared on `onState(false)`,
    re-armed fresh on the next `onSession` (disconnected time never counts
    against the grace) (§3.6.2).
15. `turn_settled` with matching `turnId` finalizes a lingering draft
    (§3.6.1).
16. approval_request with no working draft → releases (pins §7.3 as chosen
    behavior).

`packages/plugin/src/abort-mirror-contract.test.ts`: §6.5 (subset property +
negatives). `control-lane.test.ts` untouched; add a cross-link comment.

Verification: `npm test` + `npm run typecheck` in both packages, demo smoke
via the existing verify driver (send-during-turn → retract → settle → assert
the agent transcript never saw the text; NL "stop" mid-turn → assert abort).

## 9. Out of scope

- Option B server dequeue (`retract` frame) — deferred (§2).
- Retracting a message already on the wire (that is abort = P1-8a, or Option B).
- Editing a pending message (retract + retype covers it).
- Persisting held messages across reload.
- A general (non-reconnect) settle-timeout — the §3.6.2 valve arms only on
  session re-establishment; a healthy-connection watchdog stays a follow-up.
