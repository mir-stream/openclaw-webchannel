# P0 — Core Chat Gaps (WebChannel vs. Telegram)

> **Scope.** This file covers **P0 only** — the gaps that make a chat product feel broken (no
> history, no slash commands, unclear HITL, no streaming/typing, no send reliability). P1 (rich
> rendering / media / buttons / doctor) and P2 (threads / reactions / spool / throttle) live in
> `P1_*.md`, `P2_*.md`.
>
> **Reference channel.** OpenClaw Telegram extension at
> `../openclaw/extensions/telegram/` (absolute: `/Users/mircorn/workspace/openclaw/extensions/telegram/`).
>
> **⚠️ Re-anchored 2026-07-03.** The integrated showcase demo rewrote the demo surface. The demo
> now drives the production `WebChannelNATSClient` state reducer, so **most P0 client render is
> built** (marked ✅). What remains is server-side (P0-2/5/6) or net-new (P0-3/7).
>
> **⚠️ Line numbers drift.** The demo is still being built, so `file:line` anchors are approximate
> and keep moving — trust the file + symbol name and search if a line has shifted. Not re-anchored
> per demo change.
>
> **How to read each gap.** *Symptom → Classification → Where it stands today (`file:line`) →
> Telegram reference (`file:line`) → Implementation sketch → Acceptance.*
> Classification legend:
> - 🔴 **Missing entirely** — no support in wire, server, or UI.
> - 🟡 **Partial / server-only-left** — client render done (or wire+server done); a slice remains.
> - 🟢 **Partial polish** — exists but incomplete UX.
> - ✅ **Built by the integrated demo** — implemented and rendered; number retained as a stable anchor.

---

## 0. Architecture you must understand first (it changed)

There is now **one production client path**, and the demo uses it. The old thin `runDemo` path is
retired.

| Layer | File | Handles |
|---|---|---|
| Low-level NATS client | `packages/client/src/nats-client.ts` (`WebChannelNatsClient`) | raw NATS WS, E2E handshake, `onMessage`/`onError`/`onState`, `loadHistory` `:768`, `sendApprovalDecision`, terminal-auth classify `:444-460` |
| **State reducer wrapper** | `packages/client/src/nats-client-wrapper.ts` (`WebChannelNATSClient`) | reduces full protocol → `WebChannelState`; `getState` `:110`, `subscribe` `:115`, `send` `:131`, `decide` `:145`, `loadHistory` `:155` |
| Demo widget | `demo/web/src/widget.ts` | `subscribe(render)` → bubbles, typing, approval cards, "Load older", terminal re-auth |
| **Retired** | `packages/client/src/browser-demo-entry.ts` (`runDemo`) | old drop-all path; only a SaaS smoke test + `e2e/local/ci-smoke.html` still reference it |

The **wrapper reduces every inbound frame** (`nats-client-wrapper.ts`):

| Frame | Reducer case | Effect |
|---|---|---|
| `history` | `:209` | dedup by `id`, coerce `working:false`, prepend oldest-first |
| `typing` | `:332` | `isTyping:true` |
| `approval_request` | `:337` | upsert into `approvals[]`, clear `isTyping` |
| `approval_resolved` | `:364` | mark card resolved |
| `progress` | `:371` | upsert working bubble keyed by draft `id` |
| `agent_message` | `:383` | finalize draft / append |

Terminal auth failure → `onError` (`:103`) sets `status:"error"` (no eternal spinner).

The **server/agent side (NATS path)** lives in the package-root composition entry
`packages/plugin/index-nats.ts` (the old `src/index-nats.ts` is gone; wiring split into modules):

| Capability | Emit (`nats-channel.ts`) | Wired in `index-nats.ts` (root) |
|---|---|---|
| history snapshot on connect | `sendHistory()` | **from the register route** (stateless): `historyRecent`→`sendHistory`, detached read |
| history pagination | — | `setLoadHistoryHandler` `:769` → `historyPageBefore` `:778` → `sendHistory` `:781` |
| typing | `sendTyping()` `:337` (⚠️ ungated on NATS — see P0-6) | `inbound.ts:145` |
| streaming draft | `sendProgress()` `:322` / `finalizeDraft()` `:330` | `inbound.ts:109-269` (gated on `streaming.mode:"progress"`) |
| approval request | `sendApprovalRequest()` `:353` | emitted by `approvals.ts` `deliverPending` |
| approval decision | `setApprovalDecisionHandler()` (channel `:414`) | `index-nats.ts:759` → `handleApprovalDecision` |

**The full wire contract** lives in the client (`nats-client.ts`) and channel
(`nats-channel.ts`):

```
Inbound  (agent → browser): agent_message | progress | approval_request | approval_resolved | typing | history
Outbound (browser → agent): user_message  | approval_decision | load_history
```

### ⭐ Server defaults are ON; the demo enables the important ones

`packages/plugin/openclaw.plugin.json` ships every P0 server capability with a sane default, and
`demo/run.sh:232-249` turns on the ones that matter:

| Capability | Manifest default | Demo config (`run.sh`) | P0 status |
|---|---|---|---|
| `history.enabled` | **`true`** (`:174-178`) | **`true`** (`:234`) | ✅ P0-1 works E2E |
| `execApprovals` + `capabilities.inlineButtons` | first-class (`:137/:163`) | **enabled + approvers** (`:235`) | ✅ P0-4 works E2E |
| `capabilities.typing` | **`"on"`** (`:167-170`) | unset → default on | ✅ P0-6 (client) |
| `streaming.mode` | option only (`:115-123`), **not defaulted to `progress`** | **unset** | 🟡 P0-5 — not exercised |

### Reuse note — openclaw `plugin-sdk` runtimes (VERIFIED available)

Telegram does **not** hand-roll approvals/commands/dedupe. `openclaw` is our **peer dependency**
(`packages/plugin/package.json`, `>=2026.6.10`); the authoritative source is the sibling checkout
`/Users/mircorn/workspace/openclaw/src/plugin-sdk/`. Importable subpaths:

| Subpath | Key export | Reuse for |
|---|---|---|
| `openclaw/plugin-sdk/persistent-dedupe` | `createClaimableDedupe` | **P0-7** send idempotency |
| `openclaw/plugin-sdk/native-command-registry` | command catalog | **P0-3** discovery/catalog |
| `openclaw/plugin-sdk/reply-dispatch-runtime` | `ReplyPayload`, `resolveChunkMode` | **P0-3/P0-5** dispatch |
| `openclaw/plugin-sdk/approval-delivery-runtime` | `createApproverRestrictedNativeApprovalCapability` | **P0-4** approvals |
| `openclaw/plugin-sdk/command-auth-native` | `resolveNativeCommandSessionTargets` | **P0-3** command authz |

Our plugin already imports `openclaw/plugin-sdk/channel-core` (`inbound.ts`, `channel.ts`).
**Prefer these runtimes over from-scratch builds.**

---

## P0-1 — Conversation history restored on (re)connect — ✅ BUILT

**Symptom (original).** Reload / reconnect → the transcript was empty.

**Classification.** ✅ Built by the integrated demo. Server pushes a snapshot; the reducer hydrates
it; the widget renders it.

**Where it stands today.**
- Server sends the snapshot **from the register route** (Phase 6 stateless-register change — it used
  to fire on first liveness / handshake-complete, that wiring is now gone). Every register (first
  join, reload, reconnect) gets the bounded snapshot: `historyRecent(api, route.sessionKey,
  historyConfig.limit, …)` → `channel.sendHistory(peerId, messages)`, run as a detached read
  (`runDetachedHistoryRead`) so it authorizes against a synthetic operator client. The client's
  message-id-idempotent hydration absorbs the duplicate snapshots across reconnects.
- `historyRecent` reads the openclaw session store: `src/history.ts` (`recent`, config via
  `resolveHistoryConfig` `:35`).
- Wire frame: `{ type:"history"; messages:[{id,role,text,ts}] }`.
- **Reducer hydrates it:** `nats-client-wrapper.ts:209` `case "history"` — dedups by `id`, forces
  `working:false`, prepends oldest-first.
- **Widget renders it:** `demo/web/src/widget.ts:126-140` maps `state.messages` → bubbles.
- Demo config enables it: `demo/run.sh:234` `history.enabled:true`.

**Telegram reference.** `session-transcript-context.ts`, `message-cache.ts`,
`bot-message-context.session.ts`. We don't need the reply-chain machinery — our session store is
the source of truth and the server reads it.

**Remaining nits (not blocking).**
- No mid-session-reconnect scroll preservation beyond the reducer's dedup (fine for the demo).

**Acceptance (met).** Send 2 messages → reload → both prior turns + agent replies reappear in
order; no duplicate bubbles on a mid-session reconnect.

**Watch out.** The snapshot now fires **inside the register route**, so it requires the register hop.
`demo/run.sh` uses register-hop admission — but **not in the config heredoc**: the `channels add`
setup adapter may write `admission:auto`, so `run.sh:286` re-asserts
`accounts.<acct>.nats.admission="register-hop"` programmatically after enrollment, and the trigger
fires because of that re-assertion. If you switch to `admission:"auto"` (no register hop), the snapshot never sends — re-wire it
onto whatever path replaces register. The client must have its `.out` subscription active *before* it
calls register (`WebChannelNatsClient.onConnected` ordering) or the snapshot is lost.

---

## P0-2 — History pagination (scroll-up "load more") — 🟡 UI BUILT, SERVER CAP OPEN

**Symptom.** Older-than-snapshot turns can't be reached past ~2 pages.

**Classification.** 🟡 Client + UI trigger + server handler all built; the **server pager has a hard
depth cap** that still needs fixing.

**Where it stands today.**
- Outbound frame + client method exist: `WebChannelNatsClient.loadHistory(before?, limit?)`
  (`nats-client.ts:768`); wrapper `loadHistory({before,limit})` (`nats-client-wrapper.ts:155`).
- **UI trigger exists:** the "Load older" button (`widget.ts:49`) → `historyBtn.onclick`
  (`widget.ts:211-214`) passes the oldest non-working message id as `before`.
- Server handler exists: `index-nats.ts:769` `setLoadHistoryHandler` →
  `historyPageBefore(api, sessionKey, request, historyConfig.pageSize, …)` `:778` → `sendHistory`
  `:781` (reuses the `history` frame, so P0-1's reducer handles the response).
- ⚠️ **Server pager depth cap.** `pageBefore` (`history.ts:214-226`): the SDK seam
  (`runtime.subagent.getSessionMessages`) has no `before` cursor, so it always fetches only the
  newest `limit*2` (`:214`) and slices within that window. Consequences:
  - (a) pagination never reaches further than ~2 pages from the newest message;
  - (b) the cursor-miss fallback `window.slice(-limit)` (`:226`) returns the **newest** `limit`
    while the comment at `:198/:224` claims **oldest**. The client's dedup swallows the duplicates,
    so the visible symptom is "load more silently stops".

**⚠️ This gap is upstream-constrained, not ours to close unilaterally.** `openclaw` is a third-party
npm peer dependency (see memory `openclaw-plugin-dependency`) — we do not vendor or patch its
source. The plugin-facing contract `PluginRuntime.subagent.getSessionMessages`
(`openclaw/src/plugins/runtime/types.ts:87-89`, backed by `openclaw/src/gateway/server-plugins.ts:589`)
is a **closed, published type**: `{ sessionKey, limit }` only — no `before`/`offset`/cursor field
exists on it today, so we cannot add one from this repo.

Investigated 2026-07-03 (read into openclaw core, not just the type): the *underlying* JSONL
transcript store already has an ordered, id-carrying, byte-offset-seekable index
(`session-transcript-index.fs.ts`) and a cursor-capable reader
(`readSessionMessagesPageWithStatsAsync`, `session-utils.fs.ts:822`) — proven in production by
`chat.history`/`chat.startup` (`server-methods/chat.ts:2786-2925`), which already call it with an
`offset` param. So real cursor pagination is *technically* easy — but only from inside the openclaw
repo. For us it means: file an upstream feature request/PR against openclaw to add `before`/`offset`
to `sessions.get` → `getSessionMessages`, then consume it once released. Out of our control/timeline.

**Practical workaround available entirely within this repo (no upstream change needed).**
`getSessionMessages` does accept a bigger `limit` — capped upstream at
`PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT = 1000` (`server-plugins.ts:586`) — and it's a plain
tail fetch (most-recent-N), not a windowed one. So instead of `fetchLimit = limit * 2` (`:214`,
currently 100 with the demo's default `limit:50`), we can fetch up to the 1000-message ceiling in
one call, find the `beforeId` cursor inside that larger window, and slice. This turns "~2 pages then
silently stops" into "up to ~1000 messages of history, no upstream change required" — more than
enough for any realistic session (confirmed acceptable by user 2026-07-03). Only conversations
exceeding 1000 turns would still hit a hard wall, and *that* residual case needs the upstream cursor
above.

**Reference implementation (our reducer).** `nats-client-wrapper.ts:209` already prepends + dedups a
`history` page; the "Load older" response reuses it.

**Telegram reference.** `message-cache.ts` builds bounded history windows on demand; Telegram has no
user-facing "load more" (the client is Telegram itself), so our scroll-to-top pagination UX is novel.

**Implementation sketch (remaining, all within this repo).**
0. **Server: raise the `pageBefore` fetch window to the 1000-message ceiling** (`history.ts:214-226`)
   instead of `limit*2`, and find/slice the cursor within it (iterative deepening — `limit*2, *4, …`
   up to 1000 — is an equally valid way to avoid always paying the cost of a full 1000-fetch on
   every page). Fix the cursor-miss fallback to match its comment (return the *oldest* slice, or an
   empty page so the client renders "beginning of conversation") for the case where the cursor truly
   isn't in the last 1000 messages.
1. **Scroll UX (optional polish):** trigger `loadHistory` on scroll-near-top instead of only the
   button, and preserve scroll position (measure `scrollHeight` before prepend, restore after).

**Acceptance.** With >2 pages of history (up to the ~1000-message ceiling), repeatedly loading older
keeps fetching+prepending; fetching past the beginning (or past the 1000-message ceiling) is a no-op
(empty page) rather than a silent stop with no explanation.

---

## P0-3 — Slash command discovery (`/help`, `/new`, `/reset`, `/model`, …) — 🔴 DISCOVERY MISSING

**Symptom.** Typing `/` shows nothing; no command menu or autocomplete.

**Classification.** 🔴 **Execution already works (verified by code path); discovery is the real gap.**

**Verified — commands already execute as text.** Traced through openclaw core:
1. Inbound forwards raw text as a command body: `inbound.ts:157` `textForCommands: raw.text` →
   `:178` `commandBody`.
2. Core decides via `shouldHandleTextCommands`
   (`/Users/mircorn/workspace/openclaw/src/auto-reply/commands-text-routing.ts:40-48`):
   `if (params.cfg.commands?.text !== false) return true;` — text commands ON by default.
3. `isNativeCommandSurface` is true only for plugins whose **registration object** declares
   `capabilities.nativeCommands === true`. Our registration
   (`packages/plugin/src/channel.ts:103`) declares `{ chatTypes:["direct"], media:false }` — no
   `nativeCommands` → webchannel is NOT a native surface → text slash commands stay active.

**Conclusion:** `/help` in the browser is already routed to core's text-command handler and returns
output as an `agent_message` (which the widget renders). The gap is **discovery + result fidelity**.

**What's genuinely missing.**
1. **A command catalog surfaced to the browser** — a `/webchannel/commands` HTTP route (pattern:
   `index-nats.ts` `registerHttpRoute` at `:279/:331/:539`) returning `[{name,description,args?}]`
   from `openclaw/plugin-sdk/native-command-registry`, filtered by `resolveNativeCommandsEnabled`.
   **Do not hard-code a command array.**
2. **A typeahead in `demo/web/src/widget.ts`** — when `input.value` starts with `/`, fetch the
   catalog once, render a filterable menu; on pick, insert; on Enter, send as a normal message.
3. **Argument menus** (`/model <pick>`, `/thinking <level>`) — a dropdown rendered from the catalog's
   `args` (ties into P1 buttons / P0-4's control renderer).

**Telegram reference.** `bot-native-commands.ts` (`registerTelegramNativeCommands` `:824`,
`setMyCommands` `:1724`, `findCommandByNativeName` `:419`); catalog import
`openclaw/plugin-sdk/native-command-registry`.

**Two design choices (mutually exclusive on routing):**
- **(A) Stay a text-command surface (recommended).** Keep `channel.ts:103` as-is. Commands execute
  as text (already working); add discovery only. Lowest risk.
- **(B) Become a native-command surface.** Declare `capabilities.nativeCommands:true` in the
  **registration object** (`channel.ts:103`). ⚠️ This alone does NOT disable text-command handling
  (`cfg.commands?.text !== false` wins first in `commands-text-routing.ts:44`) — full (B) also needs
  `commands.text:false` + owning command dispatch and arg-menu rendering. Defer to P1/P2.

**Acceptance.** Typing `/` shows a menu of at least `/help /new /reset /model /thinking /fast`;
selecting `/help` sends it and the help text renders; `/reset` clears the server session (verify the
history snapshot is empty on next reconnect).

---

## P0-4 — HITL approval cards (exec / plugin) — ✅ BUILT

**Symptom (original).** Unclear whether "approve" works; the turn appeared to hang.

**Classification.** ✅ Built by the integrated demo. Server emits `approval_request` and handles
`approval_decision`; the reducer + widget render the card and send the decision.

**Where it stands today.**
- Server emits the card: `approvals.ts` `deliverPending` → `nats-channel.sendApprovalRequest()`
  (`:353`). Frame: `{ type:"approval_request", id, kind, title, description?, prompt,
  options:[{decision,label,style}], expiresAtMs? }`.
- Server handles the decision: `index-nats.ts:759` `setApprovalDecisionHandler` →
  `handleApprovalDecision(...)`.
- Resolution echo: `sendApprovalResolved` (`nats-channel.ts:379`) → `{ type:"approval_resolved", id,
  decision }`.
- **Reducer:** `nats-client-wrapper.ts:337` `case "approval_request"` (upsert, clear `isTyping`);
  `:364` `case "approval_resolved"` (mark resolved). `decide(id, decision)` `:145`.
- **Widget:** `renderApproval` (`widget.ts:74-98`) renders title/prompt + one button per option
  (danger/primary styling), disables on resolve, and calls `client.decide(a.id, opt.decision)`
  (`widget.ts:81`).
- Demo config: `execApprovals.enabled:true` + approvers (`run.sh:235`), so approvals run E2E.
- Types: `ApprovalRequest`/`ApprovalOption`/`ApprovalDecision` (`types.ts:31-54`); `decision ∈
  "allow-once" | "allow-always" | "deny"`.

**Telegram reference (UX semantics).** `approval-native.ts:85`
`createApproverRestrictedNativeApprovalCapability`; approver gating `exec-approvals.ts`; button
mapping `approval-native.ts:132-159`.

> ⭐ **Remaining P1 delta — generic controls.** The current renderer is approval-specific. P1-5
> (general interactive buttons) adds two wire frames (`presentation` + `button_action`) on top of a
> **generalized** `renderControls`. Refactor `renderApproval` into a normalized
> `renderControls(controls, onPick)` (`[{ label, style, disabled?, kind:"decision"|"action"|"url",
> payload }]`) so approval is just the `kind:"decision"` case. See `P1_RICH_UX_GAPS.md` → P1-5.

**Acceptance (met).** A tool needing approval renders a card with Approve/Deny; Approve continues the
turn; Deny surfaces denial; buttons disable on click and reflect the authoritative resolution.

**Watch out.** Approval authz is server-side. The demo's logged-in user must be an eligible approver
(`execApprovals.approvers`, `run.sh:235` lists Alice/Bob/Admin uuids) or decisions are rejected. See
memory `demo-user-login`.

---

## P0-5 — Streaming / partial responses (progress drafts) — 🟡 CLIENT BUILT, DEMO FLAG OFF

**Symptom.** The reply appears all at once; no live "typing out", no tool-progress feedback.

**Classification.** 🟡 Client render is built; the demo **does not enable** server streaming, so it
isn't exercised.

**Where it stands today.**
- Server streaming is **gated on config:** `inbound.ts:109`
  `const progressEnabled = resolveStreamingMode(channelConfig) === "progress"`. When enabled,
  `inbound.ts:110-269` builds a `ProgressDraftController` that pushes rolling `progress` frames then
  finalizes the same draft id with the final answer.
- Frames: `{ type:"progress", id, text }` (`nats-channel.ts:322`); finalize reuses `agent_message`
  with the same `id` (`finalizeDraft` `:330`).
- **Reducer:** `nats-client-wrapper.ts:371` `case "progress"` upserts a working bubble keyed by draft
  `id`; the matching `agent_message` (`:383`) finalizes it.
- **Widget:** working bubbles render italic/dimmed (`widget.ts:136` `m.working` → `opacity:.7;
  font-style:italic`).
- ⚠️ **Demo doesn't set `streaming.mode`.** The account block (`run.sh:232-249`) has
  `history`/`execApprovals`/`auth`/`dmSecurity` but **no `streaming.mode:"progress"`**, so
  `progressEnabled` is false in the demo — progress frames are never emitted.

**Telegram reference.** `draft-stream.ts` `createTelegramDraftStream` (`:176`), throttled edits
(`DEFAULT_THROTTLE_MS`, min 250ms). Reasoning/answer split is **P1-3**, not P0.

**Implementation sketch (remaining).**
1. **Enable server streaming in the demo:** add
   `channels.webchannel.accounts.<acct>.streaming.mode:"progress"` to the `run.sh` config heredoc
   (`run.sh:232-249`) — or set it in the setup wizard (memory `webchannel-setup-wizard-backlog`).
2. Optional: a subtle "working" affordance (cursor/shimmer) beyond the current italic dim.

**Acceptance.** With `streaming.mode:"progress"` set, a multi-step / tool-using turn shows
incremental text in a single bubble that finalizes into the answer — no duplicate bubbles, no
infinite spinner if the turn errors (`inbound.ts:258-283` finalizes an in-flight draft on error).

---

## P0-6 — Typing indicator ("agent is typing…") — ✅ CLIENT BUILT, NATS GATE OPEN

**Symptom (original).** After sending, no feedback that the agent received it.

**Classification.** ✅ Client built and rendered. Server-side, the `capabilities.typing:"off"` gate
is **not wired on the NATS path** (default-on works; the off toggle is silently ignored).

**Where it stands today.**
- Server sends it at turn start: `inbound.ts:145` `transport.sendTyping(wsKey)`. Emit method
  `nats-channel.ts:337`.
- **Reducer:** `nats-client-wrapper.ts:332` `case "typing"` → `isTyping:true`; every subsequent
  real frame clears it (`approval_request`/`progress`/`agent_message` set `isTyping:false`).
- **Widget:** `widget.ts:141-143` pushes an "agent is typing…" line when `state.isTyping`.
- Demo: `capabilities.typing` unset → default `"on"`, so typing shows.
- ⚠️ **The `capabilities.typing` gate is NOT enforced on the NATS path.** The gate exists only on
  the legacy WS transport (`transport.ts:193/:360/:610` `typingEnabled` + `setTypingEnabled`).
  `NatsChannel` (`nats-channel.ts`) has **no gate field**, `NatsChannel.sendTyping` (`:337`) is
  ungated, and `index-nats.ts` never wires one. Net: an operator setting `capabilities.typing:"off"`
  is **silently ignored on the NATS path** (the `inbound.ts:140-141` comment "the transport gates
  the frame" is only true for the WS transport).
- (Note: `src/typing-indicator.ts` is an **unrelated** feature — ephemeral client↔client typing
  envelopes — not this agent→browser gate.)

**Telegram reference.** `sendchataction-401-backoff.ts` (typing = `sendChatAction` with 401 backoff).
The backoff machinery is Telegram-specific; we only need the on/off signal.

**Implementation sketch (remaining — server only).**
1. Add a `typingEnabled` gate to `NatsChannel` (mirror `transport.ts:193/:360/:610`), set it from the
   account's `capabilities.typing` during account setup in `index-nats.ts`, and gate
   `NatsChannel.sendTyping` (`nats-channel.ts:337`) on it.

**Acceptance.** Sending shows "typing…" that clears on the first real frame; with
`capabilities.typing:"off"` on the account, no `typing` frame is emitted on the NATS path.

---

## P0-7 — Send reliability across reconnect (replay / idempotency) — 🔴 MISSING

**Symptom.** A message sent while the socket is momentarily down can be dropped; a reconnect could in
principle re-deliver. No delivery guarantee.

**Classification.** 🔴/🟡. No client replay queue or server dedupe yet.

**Where it stands today.**
- The NATS client **buffers outbound until the handshake** (fail-closed) — covers the *initial*
  connect race but **not** a mid-session drop; on reconnect the outbound queue isn't
  replay-guaranteed.
- No `messageId`-based idempotency on the browser→agent path (the E2E envelope has a random
  `messageId` per send, not a server-enforced dedupe key).
- No dedupe in `inbound.ts` (only `finalize` is idempotent, `inbound.ts:267`).

**Telegram reference.** `message-dispatch-dedupe.ts` — a **7-day claimable dedupe window** on
`openclaw/plugin-sdk/persistent-dedupe` (`createClaimableDedupe`): claim before processing, `forget`
(rollback) on failure so a retry isn't falsely deduped; key builder
`buildTelegramMessageDispatchReplayKey(msg)`.

**Reuse — VERIFIED.** `createClaimableDedupe` lives in `openclaw/plugin-sdk/persistent-dedupe`.

**Implementation sketch.**
1. **Stable client message id** — the browser stamps each `user_message` with a stable, monotonic id
   (survives reconnect); include it in the E2E envelope routing.
2. **Outbound replay queue (client)** — keep unacked sends; on reconnect+rehandshake, re-send.
3. **Server-side dedupe (agent)** — in `inbound.ts` / the serialized dispatcher, claim the client id
   via persistent-dedupe before running the turn; `forget` on failure.
4. **Ack frame (optional)** — so the client can drop delivered sends from its replay queue.

**Acceptance.** Send a message, kill the relay mid-send, let it reconnect → delivered exactly once. A
rapid double-submit of the same logical message is deduped server-side.

**Scope note.** The heaviest P0 item and the only one needing both client and server work.

---

## Suggested execution order (remaining work only)

| Order | Gap | Effort | Why |
|---|---|---|---|
| 1 | P0-5 streaming demo flag | XS | One-line `streaming.mode:"progress"` in `run.sh` unlocks the already-built render. |
| 2 | P0-6 NATS typing gate | S | Small server gate; makes `typing:"off"` honored. |
| 3 | P0-2 server depth cap | S–M | Raise fetch window to the 1000-msg ceiling (in-repo fix); true unbounded cursor is upstream-blocked. |
| 4 | P0-3 slash discovery | S–M | Catalog route + typeahead (execution already works). |
| 5 | P0-7 send reliability | L | Client replay + server dedupe; the reliability milestone. |

> ✅ **Already built by the integrated demo:** P0-1 (history restore), P0-4 (approval cards), P0-6
> (typing render), P0-5 (progress render). No further client work for those beyond the notes above.

## Cross-cutting: the reducer is the shared seam

All render extensions now go through one place — the reducer (`nats-client-wrapper.ts:207-405`) and
the widget's `render(state)` (`widget.ts:100-148`). New frame types (e.g. P1-5 `presentation`,
P1-3 `reasoning`) add: a `case` in the reducer, a field on `WebChannelState` (`types.ts:74-94`), and
a branch in `render`. There is no thin path to re-wire.
