# P1-3 Reasoning Lane Plan

**Status:** REVIEWED — adversarial review round 1 folded in
**Date:** 2026-07-14
**Scope:** OpenClaw reasoning callbacks → WebChannel wire → headless client state → demo widget

## 1. Outcome

When OpenClaw exposes reasoning for a turn, WebChannel shows it in a separate,
collapsed `Reasoning` section while the answer continues through the existing
answer/progress path unchanged. Turns without reasoning show no empty control.

Reasoning delivery is independent of `channels.webchannel.streaming.mode`.
`partial`, `progress`, `block`, and `off` still decide how answer/tool progress is
rendered; they do not decide whether an available reasoning callback is wired.

## 2. Current-state facts

- `packages/plugin/src/inbound.ts` creates one answer/tool draft only for
  `streaming.mode === "partial" | "progress"`.
- Partial answer text enters through `onPartialReply`; tool lifecycle events enter
  through `onToolStart` / `onItemEvent`.
- OpenClaw has a purpose-built `onReasoningStream(payload)` callback and an
  `onReasoningEnd()` boundary. The relevant delivered fields are `text`,
  `isReasoningSnapshot`, and `requiresReasoningProgressOptIn`; do not depend on
  `isReasoning`, which is not forwarded by every runner path.
- OpenClaw also exposes `streamReasoningInNonStreamModes`, but that is an
  independent reasoning-policy opt-in, not the WebChannel answer streaming mode.
- Plugin and client wire unions independently declare frame shapes. A new frame
  must be added to every declaration; importing the Node-side plugin contract
  into the zero-dependency browser client is intentionally avoided.
- The client reducer currently has a single `messages` collection. A `progress`
  frame upserts a working agent bubble and the matching `agent_message` finalizes
  it.
- Reasoning is not part of history snapshots and there is no durable reasoning
  store in this repository.

## 3. Decisions

### 3.1 Use the native reasoning callback

Wire `onReasoningStream` directly. Do not recover reasoning by parsing answer
partials or `<think>` tags. OpenClaw owns provider normalization and suppression;
WebChannel consumes the channel callback it intentionally exposes.

An empty or non-string `payload.text` is ignored. WebChannel must not fall back to
answer text when reasoning is absent.

### 3.2 Reasoning is independent of answer streaming mode

Every ordinary turn supplies:

- `onReasoningStream`
- `onReasoningEnd`

These callbacks are supplied regardless of WebChannel's `partial`, `progress`,
`block`, or `off` mode, including when no answer draft exists. Do **not** set
`streamReasoningInNonStreamModes:true`: in the pinned OpenClaw runtime that option
can surface ambient reasoning even when the session reasoning mode is `off`, with
`requiresReasoningProgressOptIn:true`. WebChannel has no such explicit user opt-in
in P1-3. Defense in depth: discard any callback whose
`requiresReasoningProgressOptIn` is true. A future reasoning preference may enable
it deliberately, but that is a separate product change.

The `/stop` control-lane turn is excluded: it should not create a new reasoning
lane while aborting another turn.

This decision does not force reasoning generation. Existing OpenClaw/model/session
reasoning policy remains authoritative; WebChannel only displays callbacks that
OpenClaw elects to emit.

### 3.3 Add a dedicated wire frame

Add this server-to-client frame:

```ts
{
  type: "reasoning";
  id: string;
  text: string;
  turnId: string;
}
```

Add a separate lifecycle frame:

```ts
{ type: "turn_settled"; turnId: string }
```

`turn_settled` carries no content and says nothing about reasoning completion. It
only releases transient client activity (`isTyping` / Stop) for an ordinary turn.
The plugin emits it best-effort from the ordinary turn's `finally` path for every
answer streaming mode, including clean silent completion, abort, and error. The
control-lane `/stop` turn does not emit its own lifecycle frame; the original turn
it aborts emits one when it settles.

Do not overload `progress` with a boolean. A distinct discriminant prevents
reasoning from being accidentally rendered as an answer bubble by existing
reducers and keeps answer finalization semantics unchanged.

The plugin creates one stable reasoning `id` per reasoning burst. Every update in
that burst reuses the id. `turnId` correlates all reasoning bursts, answer progress,
and final answer for one inbound user message. Existing `progress` and
id-bearing `agent_message` frames gain an optional `turnId`; plain final
`agent_message` frames also carry it for block/off mode. Optional fields preserve
old-client compatibility.

The preferred `turnId` is the inbound `user_message.id` already minted by the NATS
client. For legacy/no-id messages the plugin creates a per-dispatch id. A client
that cannot match that generated id to a local user bubble may temporarily place
the reasoning at the live tail; the matching answer frame still carries the same
turn id and makes final placement deterministic.

Unknown frame types are currently ignored by older clients, so a new plugin with
an old client degrades to “no reasoning UI.” A new client with an old plugin sees
no frame and likewise shows nothing. The protocol version is not bumped because
the addition is optional and forward-compatible.

### 3.4 Normalize snapshot versus incremental updates in the plugin

The transport frame always carries the full reasoning text accumulated so far.
The browser reducer therefore always replaces by id; it never appends deltas.

The per-turn plugin controller maintains `currentText`:

- `payload.isReasoningSnapshot === true`: replace `currentText` with `text`.
- otherwise, if `text` extends `currentText`: replace with `text` (cumulative
  providers).
- otherwise append `text` (delta providers).
- exact duplicate updates are no-ops.

Before implementing this heuristic, tests must be written from the callback
shapes exercised by the pinned OpenClaw version. If the runtime contract proves
that non-snapshot payloads are already cumulative, simplify to replacement and
record that verified contract in code comments. Do not ship an untested concat
heuristic.

`onReasoningEnd` closes the current burst in the plugin controller only; it does
not send a terminal frame. A later reasoning update in the same turn starts a new
reasoning item with a new id. This preserves multiple reasoning bursts separated
by tool/assistant boundaries without a best-effort terminal frame that could be
dropped and leave misleading client state.

### 3.5 Model reasoning as first-class client state

Add:

```ts
type ReasoningItem = {
  id: string;
  turnId: string;
  text: string;
};

type WebChannelState = {
  // existing fields...
  reasoning: ReasoningItem[];
};
```

The reducer upserts by `id`. Reasoning does not enter
`ChatMessage[]`, because that collection is a durable-looking conversation
transcript used by history reconciliation. Keeping lanes separate prevents live,
non-durable reasoning from being adopted or reordered as chat history.

Receiving a reasoning frame does **not** clear `isTyping`. Today `isTyping` also
drives whether the primary action is Stop, and block/off mode has no working
answer draft to keep that activity alive. Clearing it on reasoning would turn Stop
back into Send while the run is still active. The widget suppresses the redundant
`agent is typing…` text when it is already showing reasoning for the active tail,
but retains `isTyping` as the turn-control signal until `turn_settled` (or an
existing answer/progress settling frame) arrives.

The reducer ignores `turn_settled` content-wise and sets `isTyping:false`. Per-peer
ordinary turns are serialized, so there is at most one ordinary active turn; the
out-of-band control lane only accelerates settlement of that same turn. On a
disconnect/reconnect transition the clients also clear stale transient activity,
providing a recovery boundary if the best-effort settlement frame was lost.

`ChatMessage` gains optional `turnId`. Local user sends set `turnId` to their
existing `wireId`; frames emitted for that turn set it on live/final agent
messages. History messages leave it absent. The widget derives presentation order
without mutating durable transcript state:

1. place a turn's reasoning after its matching user message;
2. place the turn's answer messages after its reasoning;
3. while neither anchor is locally available (for example another device), place
   the live reasoning at the tail until a correlated answer arrives;
4. preserve reasoning burst arrival order within a turn.

Reasoning state is in-memory only. Reloading or reconnecting does not rehydrate
past reasoning. Existing items remain visible through an ordinary reconnect in
the same wrapper instance, but a fresh client starts with `reasoning: []`.

Reasoning items have no `working`/`done` state, so a lost end frame or reconnect
cannot leave a false live indicator. Retain at most the newest 100 reasoning bursts
and preferentially discard items whose `turnId` no longer has a local user or
answer anchor. This is an ephemeral UI bound, not history retention.

### 3.6 Demo rendering

Render each reasoning item as a native `<details>` block aligned with agent
content:

- closed by default;
- summary label: `Reasoning` (no live/done claim and no terminal frame required);
- body rendered with the existing sanitize-by-construction markdown renderer;
- no affordance when the array is empty;
- no italic/low-opacity styling that makes expanded content hard to read.

Reasoning is grouped by `turnId` and rendered between that turn's user message and
answer. Multiple reasoning bursts within one turn render in arrival order. This
must work across at least two consecutive live turns; a global reasoning area is
not acceptable.

The UI must preserve the user's open/closed choice across incremental renders.
`replaceChildren()` currently rebuilds the transcript, so the widget must capture
open reasoning ids before replacement and restore them. A streaming update must
not snap an expanded lane closed.

The existing markdown renderer's 20k-character safety cap applies unchanged to a
reasoning body. Rendering uses the same per-id/text memoization strategy as agent
bubbles so an update does not reparse every older reasoning item.

## 4. Server design

Create a small per-turn `ReasoningDraftController` rather than extending
`ProgressDraftController`. Its responsibilities are:

1. generate stable ids;
2. normalize callback updates to cumulative text;
3. suppress empty/duplicate frames;
4. send cumulative `reasoning` frames;
5. close the current burst on `onReasoningEnd`;
6. stop idempotently during normal settlement or error cleanup.

The controller uses the same best-effort/backpressure posture as progress drafts.
Reasoning must never delay or fail the agent turn. Transport send failure is a
dropped preview update, not a turn error.

Both WebSocket and NATS channel transports gain `sendReasoning(...)`, even though
the integrated demo currently uses NATS. Keeping their public frame contracts in
sync avoids a transport-dependent feature and satisfies the existing packaging
contract.

Both transports also gain `sendTurnSettled(...)`. It is invoked from `finally`
after the reasoning and answer draft controllers have stopped. A failure to send
must not fail the turn. The existing catch path should additionally send the
user-visible apology in block/off mode when no final reply was delivered; the
lifecycle frame fixes activity state but must not replace useful error feedback.

`replyOptions` in `inbound.ts` is currently created only inside `...(draft ? ...
: {})`. Mode independence requires restructuring it: reasoning callbacks are
unconditional for ordinary turns, while `onToolStart`, `onItemEvent`,
`onPartialReply`, `onAssistantMessageStart`, and
`suppressDefaultToolProgressMessages` remain under their existing draft/mode
conditions. Block/off regression tests must prove that this refactor does not
silently enable tool progress or answer partials.

## 5. Lifecycle and edge cases

- **No reasoning:** no frame and no client item.
- **Reasoning before answer:** lane appears; answer later follows
  its existing path. The textual typing indicator is hidden while reasoning is
  visible, but the internal turn-control signal stays active.
- **Reasoning without streamed answer (`off`/`block`):** lane streams, then the
  atomic final answer arrives normally.
- **Multiple bursts:** `onReasoningEnd` rotates one item; a later update creates the
  next item.
- **Missing `onReasoningEnd`:** turn settlement stops the active controller; no
  reasoning terminal state is required; `turn_settled` releases turn activity.
- **Abort/error:** stop the active controller. Already-delivered reasoning remains
  readable with the neutral `Reasoning` label. `turn_settled` releases Stop;
  block/off errors also receive a visible terminal apology.
- **Empty/duplicate callbacks:** ignored.
- **Late callback after settlement:** ignored by the stopped controller.
- **Backpressure:** updates may be dropped; final answer delivery remains
  unaffected. There is no terminal reasoning frame whose loss corrupts reasoning
  state. A lost activity settlement is cleared at reconnect or the next settling
  content frame.
- **Markdown/XSS:** reuse `renderMarkdown`; never use `innerHTML`.
- **History/reload:** reasoning is intentionally ephemeral and absent after a
  fresh load.

## 6. Non-goals

- Enabling a model's reasoning or changing session `reasoningLevel`.
- Exposing arbitrary internal chain-of-thought. The UI presents only channel-safe
  reasoning preview/summary content that OpenClaw's explicit `stream` policy emits;
  opt-in-required ambient payloads are rejected.
- Persisting reasoning in session history or server storage.
- Persisted correlation for historical reasoning after a fresh load.
- Adding user controls for reasoning level.
- Reusing Telegram-specific message markers, length limits, or delivery state
  machines.
- Changing answer/tool progress behavior.

## 7. Implementation slices

1. **Wire and transport**
   - add `reasoning` to all outbound/inbound wire unions;
   - add `sendReasoning` to WS and NATS transports;
   - add `turn_settled` and `sendTurnSettled` for mode-independent activity
     cleanup;
   - thread optional `turnId` through progress/final frames;
   - update transport mocks, frame fixtures, protocol comments, and runtime
     unknown-frame compatibility tests.
2. **Plugin callback/controller**
   - implement the per-turn controller;
   - wire callbacks independently of `streaming.mode`;
   - rotate on reasoning-end and stop on turn settlement;
   - reject `requiresReasoningProgressOptIn` payloads;
   - add partial/progress/block/off and control-lane tests.
3. **Headless client reducer**
   - expose `ReasoningItem` and initialize `reasoning: []`;
   - upsert by id and prune to the retention bound;
   - update both the raw WebSocket client and NATS wrapper reducers/reconnect
     paths, plus public type exports in `packages/client/src/index.ts`;
   - add reducer, retention, placement, and compatibility tests.
4. **Demo widget**
   - render collapsed sanitized markdown details;
   - retain expanded state during streaming rerenders;
   - add DOM tests for absent/present/update/open-state/XSS behavior.
5. **Documentation**
   - update `docs/gaps/P1_RICH_UX_GAPS.md`, gaps README, and status only after
     acceptance tests pass.

## 8. Test matrix

| Case | Expected result |
|---|---|
| Reasoning callback, `partial` mode | Separate reasoning lane; answer draft unchanged |
| Reasoning callback, `progress` mode | Separate reasoning lane; tool progress unchanged |
| Reasoning callback, `block` mode | Reasoning lane plus atomic final answer; Stop remains armed |
| Reasoning callback, `off` mode | Same as block; proves mode independence |
| No reasoning callback | No empty `Reasoning` UI |
| Snapshot updates | Text replaces without duplication |
| Cumulative updates | Text replaces without duplication |
| Multiple reasoning bursts | Multiple items in stable order within one turn |
| Missing end callback | Controller stops; neutral client item stays readable |
| Abort/error | No misleading live/done state exists |
| Block/off throws after reasoning | Visible apology and Stop/isTyping released |
| `/stop` response missing | Original turn's settlement releases Stop/isTyping |
| Settlement frame lost, then reconnect | Reconnect clears stale activity |
| Two consecutive turns | Each reasoning group stays with its own answer |
| History prepend during live turn | Live reasoning keeps its turn placement |
| Opt-in-required ambient payload | Suppressed |
| More than 100 bursts | Oldest/orphaned reasoning is bounded and pruned |
| Expanded lane receives update | Remains expanded |
| Hostile markdown/HTML | Inert text/safe markdown DOM |
| Old client receives frame | Ignores it; answer continues |
| New client against old plugin | Empty reasoning state; answer continues |

## 9. Acceptance criteria

1. A reasoning-capable turn displays a collapsed `Reasoning` lane whose content
   can be expanded while it streams.
2. The answer remains a separate bubble and preserves the existing behavior for
   all four streaming modes.
3. A reasoning callback is wired in all four modes; the `/stop` control lane is
   excluded.
4. Non-reasoning turns render no empty affordance.
5. Incremental updates neither duplicate text nor close a lane the user expanded.
6. Two or more consecutive turns keep each reasoning lane attached to the correct
   user/answer turn; history prepend does not move it to another turn.
7. Reasoning is absent from history and disappears on a fresh client load.
8. Old/new plugin-client combinations degrade without breaking answer delivery.
9. Plugin, client, and demo unit/DOM tests pass, plus the existing build/typecheck
   suites remain green.
10. `partial`/`progress` retain their current tool/answer callback behavior, while
    block/off receive reasoning callbacks without accidentally enabling those
    draft-only callbacks.
11. Clean, silent, aborted, and failed turns in every streaming mode release the
    Stop/isTyping activity state; block/off failures also show an error reply.

## 10. Open implementation verification

These are code-contract checks, not product decisions:

1. Verify whether the pinned OpenClaw runtime sends non-snapshot reasoning payloads
   as deltas or cumulative text; lock the observed semantics in controller tests.
2. Enumerate every independent wire union and transport mock before editing; this
   repository intentionally duplicates browser/server protocol types.
3. Trace the inbound `user_message.id` through both NATS and legacy WebSocket
   dispatch so `turnId` is stable where available and safely generated otherwise.
