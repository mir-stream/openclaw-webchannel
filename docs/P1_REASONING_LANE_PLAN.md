# P1-3 Reasoning Lane Plan

**Status:** REVIEWED — adversarial review round 1 folded in
**Date:** 2026-07-14
**Scope:** OpenClaw reasoning callbacks → WebChannel wire → headless client state → demo widget

## 1. Outcome

When OpenClaw exposes reasoning for a turn, WebChannel shows it in a separate,
collapsed `Reasoning` section while the answer continues through the existing
answer/progress path unchanged. Turns without reasoning show no empty control.

Reasoning delivery is independent of `channels.webchannel.streaming.mode` (the
ANSWER streaming mode). `partial`, `progress`, `block`, and `off` still decide how
answer/tool progress is rendered; they do not decide whether reasoning is shown.

The reasoning lane is instead gated on this channel's OWN
`channels.webchannel.capabilities.reasoning` key (`resolveReasoningEnabled`,
`account-config.ts`), which defaults **ON**: the lane opens unless the key is
PRESENT and set to something other than boolean `true`.

The default is ON because the consumer already ships the reasoning UI, so every
deployment that has not hand-edited its config renders an empty `Reasoning` shell
on each turn — the exact symptom this issue removes. A deployment that does not
want reasoning on the wire sets `capabilities.reasoning: false`.

> **Superseded (#113).** This section previously described the gate as the
> resolved SESSION reasoning level, read session-store-first with
> `agents.*.reasoningDefault` as the config default, mirroring Telegram. That
> could never be turned on here, and failed silently. `agents.*.reasoningDefault`
> is CO-PARSED by core, which invalidates it for unauthorized senders and forces
> `off`. WebChannel's browser peers are unauthorized by design — `inbound.ts`
> stamps `access.commands.authorized` on the control (`/stop`) lane ONLY, and we
> are deliberately not opening a text-command surface to a browser. So the two
> resolvers disagreed: ours said `stream` and opened the lane, core's said `off`
> and never emitted. The turn settled `ok` with the answer intact and zero
> reasoning frames. The gate is now a channel-private key that core does not
> co-parse, and `reasoning-level.ts` is deleted.

Opening the lane is only the CHANNEL half of the gate. Core's `canShowReasoning`
(the agent's own thinking level `!== "off"`) is an independent precondition that no
channel config can override. When an opted-in lane ends a turn having received no
payload at all, `inbound.ts` logs one warning naming that cause — see §3.2 — so the
combination is diagnosed instead of showing an empty section.

## 2. Current-state facts

- `packages/plugin/src/inbound.ts` creates one answer/tool draft only for
  `streaming.mode === "partial" | "progress"`.
- Partial answer text enters through `onPartialReply`; tool lifecycle events enter
  through `onToolStart` / `onItemEvent`.
- OpenClaw has a purpose-built `onReasoningStream(payload)` callback and an
  `onReasoningEnd()` boundary. The pinned payload is exactly
  `{ text?: string; mediaUrls?: string[]; isReasoningSnapshot?: boolean }`
  (verified: `dist/plugin-sdk/types-B70zVumi.d.ts:1737-1741`). We consume `text`
  and `isReasoningSnapshot`; `mediaUrls` is ignored (text-only lane). Do not
  depend on `isReasoning`, which is not forwarded by every runner path.
- The plugin dispatch path forwards `onReasoningStream` with NO reasoning-level
  gate of its own (`dist/dispatch-B2e1grFo.js:1658-1710`): the ACP runner always
  emits a full-text snapshot (`dist/run-attempt-DRhLt3eF.js:4100-4117`) and the
  btw runner emits cumulative full text whenever the resolved level is not `off`,
  i.e. it emits at level `on` too (`dist/btw-CDO5476N.js:617-627`). WHETHER a
  channel shows reasoning to its client is therefore CHANNEL-OWNED display policy.
- `streamReasoningInNonStreamModes` and `requiresReasoningProgressOptIn` DO exist,
  as public reply-options fields declared next to `onReasoningStream` on the
  plugin-sdk reply-options contract.

  > **Corrected (#113).** This section previously asserted that both fields "do
  > NOT exist anywhere in the pinned dist — an earlier draft of this plan invented
  > them." That was true at the then-current pin `2026.6.10` and is FALSE now.
  > Both were added by `2026.7.1`, which is why `compat.pluginApi` was raised to
  > `>=2026.7.1`. `streamReasoningInNonStreamModes: true` turns out to be the
  > LEVER that makes core emit at all on this dispatch path: measured against a
  > live gateway on an otherwise identical unauthorized-peer config, 0 reasoning
  > frames without it and 5 with it. `inbound.ts` now passes it, but only on turns
  > where the lane is actually open.
  >
  > `requiresReasoningProgressOptIn` is a marker core sets to say "the channel
  > opted into this progress info; the user did not request a reasoning stream."
  > Deferred to **#121** and deliberately NOT implemented: on this channel the
  > marker is a CONSTANT. Core forces `reasoningMode` to `"off"` for our
  > unauthorized peers, so EVERY payload carries it — it has zero runtime
  > discriminating power, and a wire field that is always the same value earns
  > nothing on either side. Reasoning therefore ships unmarked for now and the
  > wire frame shape in §3.3 is unchanged.
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

### 3.2 Reasoning is gated on `capabilities.reasoning`, not the answer mode

When the lane is active, an ordinary turn supplies:

- `streamReasoningInNonStreamModes: true`
- `onReasoningStream`
- `onReasoningEnd`

These are supplied (or not) INDEPENDENTLY of WebChannel's `partial`, `progress`,
`block`, or `off` answer mode — including when no answer draft exists. What decides
whether they are wired is `channels.webchannel.capabilities.reasoning`:

- resolve it via `resolveReasoningEnabled` (`account-config.ts`) against the merged
  account config, exactly like `capabilities.typing`;
- the rule is `absent → ON; present-and-not-boolean-true → OFF`. It is deliberately
  NOT a `!== false` truthiness test: `capabilities.typing` next door spells its
  values `"on"`/`"off"`, so `reasoning: "off"` is the first thing an operator
  reaches for to disable the lane, and under `!== false` that string is truthy and
  would KEEP reasoning on — defeating their intent in the privacy-losing direction.
  So `false`, `"off"`, `"false"`, `"true"`, `"on"`, `0`, `1`, `null` all fail
  CLOSED; only an ABSENT key gets the ON default;
- wire the reasoning callbacks only when it resolves `true`.

`streamReasoningInNonStreamModes: true` is passed ONLY on turns where the lane is
open. It is what makes core emit at all (§2); asking core to stream reasoning we
would immediately discard is pointless, and for an account that turned the lane
off it would be a real behaviour change in core's emission rather than a no-op.

The `/stop` control-lane turn is excluded: it never opens a reasoning lane while
aborting another turn, regardless of the config.

This decision does not force reasoning GENERATION. Core's `canShowReasoning` — the
agent's own thinking level `!== "off"` — remains an independent precondition that
no channel config can override. Because that combination (channel ON, model side
impossible) would otherwise present as an empty section on an `ok` turn,
`inbound.ts` logs ONE warning per ACCOUNT per PROCESS when an opened lane ends a
qualifying turn having received no payload.

The warning fires on a turn that ANSWERED SUCCESSFULLY and was not positively
known to be aborted — that is where zero frames is surprising. It is suppressed
when:

- no answer was delivered (`answerDelivered` false) — tool-only work, a suppressed
  reply, a final the transport could not ship, or a turn whose only final was core
  chatter. `answerDelivered` excludes notices by design, where
  `finalReplyDelivered` would not; with no answer on screen there is no empty
  section beside it to explain;
- the turn failed terminally (`turnOutcome === "error"`) — the operator already has
  a real error and a second, wrong diagnosis is noise;
- the user aborted (`/stop`), vetoed by `verdict !== "aborted"`. #89's settled
  value for an abort is still `ok`, so `turnOutcome` alone cannot see it.

`answerDelivered` is the COMPLETION signal; `verdict` is only a veto on a
positively-known abort, never positive proof of normal completion. An aborted
turn's terminal is core's own "agent was aborted" chatter, which `answerDelivered`
already excludes, so the veto exists for the single case the other guards miss: an
abort landing after a real answer was delivered.

The verdict test must NOT be tightened to `verdict === "ok"`. That was tried and
measured wrong on the live two-account gate: a second account's ordinary,
successfully-answered turns carry a real `agentRunId` for which
`agentRunVerdicts` holds no entry, so they resolve `verdict === undefined` and go
silent. A missing verdict is normal for multi-account deployments today —
`startAgentLifecycleSubscription` releases the previous subscription before
subscribing, so only the last-registered account's runs ever record one. That is
pre-existing (it predates #113 and also degrades #87's classification for those
accounts), filed separately, and deliberately not worked around here. Under
`=== "ok"` the diagnostic would be dead for every account but one.

The wording deliberately does NOT assert the cause. The plugin cannot observe the
agent's thinking level, and a model that simply does not emit reasoning for this
provider or prompt produces an identical zero-frame turn; claiming
`thinkingLevel === "off"` would send an operator who already set it to `medium`
hunting a misconfiguration that does not exist. The message names the likely cause,
mentions the other, and points at both remedies.

Scope is per ACCOUNT per PROCESS, latched in `reasoningEmptyLaneWarned` and
re-armed by `stopAgentLifecycleSubscription`. Per-TURN was the first cut and it did
not survive the default flip: a deployment whose model simply never reasons is
indistinguishable from a misconfigured one from this side, so a per-turn warning
fires on every answered turn forever, gets filtered out of the log pipeline, and
then does not inform anyone at all. A diagnostic is worth as much as it is rare.

The latch is deliberately separate from the three qualifying guards above: those
decide whether a turn COUNTS, the latch decides whether we have already said it.
Re-arming on teardown matters — that is the seam where config changes land, so an
operator who just edited config and reloaded is told again whether it worked. The
message says it is latched, so a single line is not read as a count of affected
turns.

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

VERIFIED CONTRACT (pinned OpenClaw v2026.6.x): every emitter sends either a
snapshot or the cumulative FULL text so far — NEVER a bare delta. The ACP runner
emits the full accumulated text with `isReasoningSnapshot: true`
(`dist/run-attempt-DRhLt3eF.js:4100-4117`); the btw runner accumulates
`reasoningText += delta` and emits `reasoningText` with no snapshot flag
(`dist/btw-CDO5476N.js:617-627`). No provider path emits a bare delta.

The per-turn plugin controller therefore maintains `currentText` with a plain
REPLACE — no snapshot/startsWith/endsWith/concat heuristic:

- empty or non-string `payload.text`: ignore.
- exact duplicate of `currentText`: no-op.
- otherwise: replace `currentText` with `text` and send.

The browser reducer likewise always replaces by id; it never appends deltas.

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

- **No reasoning, or reasoning level not `stream`:** no reasoning callback is
  wired, no frame is sent, and no client item appears. Level `off` and `on` both
  fall here; only `stream` opens the lane.
- **Reasoning before answer (level `stream`):** lane appears; answer later follows
  its existing path. The textual typing indicator is hidden while reasoning is
  visible, but the internal turn-control signal stays active.
- **Reasoning (level `stream`) without a streamed answer (answer mode `off`/`block`):**
  lane streams, then the atomic final answer arrives normally — proving the
  reasoning gate is independent of the answer streaming mode.
- **Multiple bursts:** `onReasoningEnd` rotates one item; a later update creates the
  next item. btw stale-burst defense: the btw runner never resets its
  `reasoningText` accumulator at `thinking_end`, so a second burst's cumulative
  payload still carries prior bursts' text as a raw prefix; the controller keeps
  the closed burst's last RAW payload as its `stalePrefix` (assigned, not appended
  from trimmed display text — trimming loses inter-burst whitespace and breaks the
  prefix match from burst 3 on) and strips it from later payloads so each rotated
  lane shows only its own text (ACP is unaffected — it ends reasoning at most once
  per attempt).
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
- Exposing arbitrary internal chain-of-thought. The UI presents reasoning only
  when the resolved session reasoning level is `stream`; at `off`/`on` no lane is
  wired and nothing is shown.
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
   - implement the per-turn controller (cumulative REPLACE, verified contract);
   - wire callbacks independently of the answer `streaming.mode`, gated on
     `capabilities.reasoning` (`resolveReasoningEnabled`, `account-config.ts`;
     absent → ON, present non-`true` → OFF, and NO schema default in the manifest
     so the absent case stays reachable), and pass
     `streamReasoningInNonStreamModes: true` with the open lane;
   - rotate on reasoning-end and stop on turn settlement;
   - warn once per account per process when an opened lane completed a normal turn
     with no payload (suppressed on abort, terminal failure, and undelivered answers);
   - add enabled/disabled × partial/progress/block/off and control-lane tests.
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
| Level `stream`, `partial` mode | Separate reasoning lane; answer draft unchanged |
| Level `stream`, `progress` mode | Separate reasoning lane; tool progress unchanged |
| Level `stream`, `block` mode | Reasoning lane plus atomic final answer; Stop remains armed |
| Level `stream`, `off` mode | Same as block; proves answer-mode independence |
| Level `on` (any mode) | No reasoning lane wired; no reasoning frame (btw emits at `on` upstream, channel suppresses) |
| Level `off` (any mode) | No reasoning lane wired; no reasoning frame |
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
| Store-read error during level resolution | Fail-closed to `off`; no reasoning lane |
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
3. When the resolved session reasoning level is `stream`, the reasoning callback
   is wired in all four answer modes; at level `off`/`on` it is not wired; the
   `/stop` control lane is always excluded.
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

1. RESOLVED: the pinned OpenClaw runtime never sends bare deltas — ACP emits
   full-text snapshots (`dist/run-attempt-DRhLt3eF.js:4100-4117`) and btw emits
   cumulative full text (`dist/btw-CDO5476N.js:617-627`). The controller uses a
   plain REPLACE, locked by `message-adapter.test.ts`.
2. Enumerate every independent wire union and transport mock before editing; this
   repository intentionally duplicates browser/server protocol types.
3. Trace the inbound `user_message.id` through both NATS and legacy WebSocket
   dispatch so `turnId` is stable where available and safely generated otherwise.
