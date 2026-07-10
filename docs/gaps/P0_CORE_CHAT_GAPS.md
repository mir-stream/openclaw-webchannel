# P0 — Core Chat Gaps (WebChannel vs. Telegram)

> **Scope.** This file covers **P0 only** — the gaps that make a chat product feel broken (no
> history, no slash commands, unclear HITL, no streaming/typing, no send reliability). P1 (rich
> rendering / media / buttons / doctor) and P2 (threads / reactions / spool / throttle) live in
> `P1_*.md`, `P2_*.md`.
>
> **Reference channel.** OpenClaw Telegram extension at
> `../openclaw/extensions/telegram/` (absolute: `/Users/mircorn/workspace/openclaw/extensions/telegram/`).
>
> **⚠️ Re-anchored 2026-07-03; re-verified 2026-07-10 (post-#14/#15/#16/#19 tree).** The integrated
> showcase demo rewrote the demo surface. The demo now drives the production `WebChannelNATSClient`
> state reducer, so **most P0 client render is built** (marked ✅). What remains is server-side
> (P0-5/6) or net-new (P0-3/7); P0-2 closed 2026-07-10. Corrected 2026-07-10 for: partial-mode
> answer-text streaming (#14, P0-5), the `approval_snapshot` rehydration frame (#15/#19, P0-4/§0
> wire), the ordered history merge (#16, P0-1/§0), and the NATS register hop replacing
> `registerHttpRoute` (P0-3).
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
| Low-level NATS client | `packages/client/src/nats-client.ts` (`WebChannelNatsClient`) | raw NATS WS, E2E handshake, `onMessage`/`onError`/`onState`, `loadHistory` `:768`, `sendApprovalDecision`, terminal-auth classify `:551-556` |
| **State reducer wrapper** | `packages/client/src/nats-client-wrapper.ts` (`WebChannelNATSClient`) | reduces full protocol → `WebChannelState`; `getState` `:110`, `subscribe` `:115`, `send` `:131`, `decide` `:145`, `loadHistory` `:155` |
| Demo widget | `demo/web/src/widget.ts` | `subscribe(render)` → bubbles, typing, approval cards, "Load older", terminal re-auth |
| **Retired** | `packages/client/src/browser-demo-entry.ts` (`runDemo`) | old drop-all path; only a SaaS smoke test + `e2e/local/ci-smoke.html` still reference it |

The **wrapper reduces every inbound frame** (`nats-client-wrapper.ts`):

| Frame | Reducer case | Effect |
|---|---|---|
| `history` | `:209` | **#16 ordered merge**: three-tier matching (id → exact text+role adoption of server ids onto live-id bubbles → positional adoption for reformatted agent replies) + **anchor-cursor** insertion (fresh unmatched messages land at `matchedIndex+1`, so a mid-session snapshot's unseen suffix inserts chronologically). Blanket oldest-first prepend only for zero-overlap pages / initial hydration into empty state. |
| `typing` | `:376` | `isTyping:true` |
| `approval_request` | `:381` | upsert into `approvals[]` (**upsert-preserve** `:400-417`: a re-delivered request can't clobber a local resolution), clear `isTyping` |
| `approval_resolved` | `:421` | mark card resolved |
| `approval_snapshot` | `:435` | **#15/#19 rehydration**: Leg A (rehydrate a lost pending card), Leg B (retire a card resolved elsewhere — show actual decision from `resolved`, else `"unknown"`), Leg C (re-send a lost decision frame); clears `isTyping` when a pending card is rehydrated |
| `progress` | `:557` | upsert working bubble keyed by draft `id` |
| `agent_message` | `:569` | finalize draft / append |

Terminal auth failure → `onError` (`:103`) sets `status:"error"` (no eternal spinner).

The **server/agent side (NATS path)** lives in the package-root composition entry
`packages/plugin/index-nats.ts` (the old `src/index-nats.ts` is gone; wiring split into modules):

| Capability | Emit (`nats-channel.ts`) | Wired in `index-nats.ts` (root) |
|---|---|---|
| register hop | — | `setRegisterRequestHandler()` `:322` (channel) → wired `:638` (**NATS request/reply — the old HTTP `registerHttpRoute` is gone**) |
| history snapshot on register | `sendHistory()` `:398` | **from the register success path** (stateless): `historyRecent`→`sendHistory`, detached read |
| approval snapshot on register | `sendApprovalSnapshot()` `:473` | **from the same register path**, **synchronous** (not detached): `listPendingApprovalsForPeer`/`listResolvedApprovalsForPeer` → `sendApprovalSnapshot` (`:668-673`) |
| history pagination | — | `setLoadHistoryHandler` `:505`/wired `:548` → `historyPageBefore` → `sendHistory` |
| typing | `sendTyping()` `:390` (⚠️ ungated on NATS — see P0-6) | `inbound.ts:160` |
| streaming draft | `sendProgress()` `:375` / `finalizeDraft()` `:383` | `inbound.ts:124-126` (gated on `streaming.mode` — `partial` = answer text, `progress` = tool lines) |
| approval request | `sendApprovalRequest()` `:406` | emitted by `approvals.ts` `deliverPending` |
| approval decision | `setApprovalDecisionHandler()` (channel `:496`) | `index-nats.ts:530` → `handleApprovalDecision` |

**The full wire contract** lives in the client (`nats-client.ts` / `types.ts`) and channel
(`nats-channel.ts`) — seven inbound frames since #15/#19 added `approval_snapshot`:

```
Inbound  (agent → browser): agent_message | progress | approval_request | approval_resolved | approval_snapshot | typing | history
Outbound (browser → agent): user_message  | approval_decision  | load_history
```

`approval_snapshot` = `{ type:"approval_snapshot"; approvals:[…]; resolved?:[{id,decision}] }`
(`packages/client/src/types.ts:206-214`; plugin side `nats-channel.ts:65-69`). The optional
`resolved` array is the #19 addition. `ApprovalRequest` also gained `resolvedDecision?:
ApprovalDecision | "unknown"` and `resolutionConfirmed?:boolean` (`types.ts:66-67`).

### ⭐ Server defaults are ON; the demo enables the important ones

`packages/plugin/openclaw.plugin.json` ships every P0 server capability with a sane default, and
`demo/run.sh:232-249` turns on the ones that matter:

| Capability | Manifest default | Demo config (`run.sh`) | P0 status |
|---|---|---|---|
| `history.enabled` | **`true`** (`:174-178`) | **`true`** (`:234`) | ✅ P0-1 works E2E |
| `execApprovals` + `capabilities.inlineButtons` | first-class (`:137/:163`) | **enabled + approvers** (`:235`) | ✅ P0-4 works E2E |
| `capabilities.typing` | **`"on"`** (`:167-170`) | unset → default on | ✅ P0-6 (client) |
| `streaming.mode` | option only (enum `off\|partial\|block\|progress`, `:110`), **no default** | **unset** | 🟡 P0-5 — neither `partial` (answer-text stream) nor `progress` (tool lines) exercised |

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
- Server sends the snapshot **from the register success path** (Phase 6 stateless-register change — it
  used to fire on first liveness / handshake-complete, that wiring is now gone; the register hop is
  now NATS request/reply via `setRegisterRequestHandler`, no HTTP). Every register (first join,
  reload, reconnect) gets the bounded snapshot: `historyRecent(api, route.sessionKey,
  historyConfig.limit, …)` → `channel.sendHistory(peerId, messages)`, run as a **detached** read
  (`runDetachedHistoryRead`) so it authorizes against a synthetic operator client. **Since #15/#19,
  the same register path also sends an `approval_snapshot`** (`sendApprovalSnapshot`,
  `index-nats.ts:668-673`) — deliberately **synchronous**, not detached (race analysis comment at
  `index-nats.ts:655-667`), so a pending approval card is rehydrated on the same hop as history (see
  P0-4). The client's message-id-idempotent, order-preserving hydration absorbs duplicate snapshots
  across reconnects.
- `historyRecent` reads the openclaw session store: `src/history.ts` (`recent` `:182`, config via
  `resolveHistoryConfig` `:37`).
- Wire frame: `{ type:"history"; messages:[{id,role,text,ts}] }`.
- **Reducer hydrates it (#16 ordered merge):** `nats-client-wrapper.ts:209` `case "history"` — no
  longer a blanket "dedup + prepend oldest-first". It does three-tier matching (id → exact text+role
  adoption of server ids onto local live-id bubbles → positional adoption for reformatted agent
  replies) and **anchor-cursor** insertion so an overlapping mid-session snapshot's unseen suffix
  lands chronologically after the matched prefix. Blanket prepend survives only for zero-overlap
  pages and initial hydration into empty state (design comment `:216-259`).
- **Widget renders it:** `demo/web/src/widget.ts:146-158` maps `state.messages` → bubbles.
- Demo config enables it: `demo/run.sh` `history.enabled:true`.

**Telegram reference.** `session-transcript-context.ts`, `message-cache.ts`,
`bot-message-context.session.ts`. We don't need the reply-chain machinery — our session store is
the source of truth and the server reads it.

**Remaining nits (not blocking).**
- No mid-session-reconnect scroll preservation beyond the reducer's #16 ordered merge (fine for the demo).

**Acceptance (met).** Send 2 messages → reload → both prior turns + agent replies reappear in
order; no duplicate bubbles on a mid-session reconnect.

**Watch out.** Both snapshots (history + approval) now fire **inside the register path**, so they
require the register hop. `demo/run.sh` uses register-hop admission — but **not in the config
heredoc**: the `channels add` setup adapter may write `admission:auto`, so `run.sh:321-326` re-asserts
`accounts.<acct>.nats.admission="register-hop"` programmatically after enrollment, and the trigger
fires because of that re-assertion. If you switch to `admission:"auto"` (no register hop), neither
snapshot sends — re-wire them onto whatever path replaces register. The client must have its `.out`
subscription active *before* it calls register (`WebChannelNatsClient.onConnected` ordering) or the
snapshot is lost.

---

## P0-2 — History pagination (scroll-up "load more") — ✅ BUILT (1000-msg ceiling)

**Symptom (original).** Older-than-snapshot turns can't be reached past ~2 pages.

**Classification.** ✅ Closed 2026-07-10 (branch `feat/p0-2`). Two defects fixed:
1. **`pageBefore` depth cap + left-edge truncation** (`history.ts`): now a two-phase fetch —
   phase 1 reads `min(limit*2, 1000)`; the older-slice is returned only when it cannot be
   left-truncated by the window edge (`idx >= limit`, or the window is already maximal);
   otherwise (miss OR hit at `idx < limit`) phase 2 widens to the 1000-message upstream ceiling
   (`MAX_FETCH_WINDOW`, mirrors `PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT`). A cursor absent
   from the maximal window returns an **empty page** (the honest end-of-history signal; the old
   `slice(-limit)` newest-N fallback fed the client dedup-swallowed duplicates = silent stop).
2. **Live NATS call-site bug** (`index-nats.ts` load-history handler): it passed the whole
   `{before, limit}` request object as `beforeId`, so live-path pagination ALWAYS returned `[]`
   (masked from tsc — `index-nats.ts` is outside the plugin tsconfig `include`). Now routed
   through `planHistoryFetch(request, pageSize)` (`history.ts`): validates the wire `limit`
   (finite, >0, floored, else pageSize) and branches `before` → `pageBefore` / absent → `recent`,
   matching the legacy `index.ts` handler.

Residual (accepted): conversations >1000 messages hard-wall at the upstream tail-fetch cap —
true unbounded paging still needs the upstream cursor (below). Follow-ups (LOW, from review):
type-validate `before` at the plan level (garbage frames currently burn a wasted 1000-fetch
before the honest `[]`); clamp the wire `limit` upper bound (a 1000-msg `recent` page can exceed
relay `max_payload`); window-relative synthesized ids (`h-${ts}-${idx}`) can miss OR false-match
across windows — position-anchored synthesis is the real fix.

**Where it stands today.**
- Outbound frame + client method exist: `WebChannelNatsClient.loadHistory(before?, limit?)`
  (`nats-client.ts:768`); wrapper `loadHistory({before,limit})` (`nats-client-wrapper.ts:155`).
- **UI trigger exists:** the "Load older" button (`widget.ts:49`) → `historyBtn.onclick`
  (`widget.ts:211-214`) passes the oldest non-working message id as `before`.
- Server handler exists: `index-nats.ts:548` `setLoadHistoryHandler` → `planHistoryFetch(request,
  pageSize)` → `historyPageBefore`/`historyRecent` → `sendHistory` (reuses the `history` frame, so
  P0-1's reducer handles the response).
- ✅ **Server pager depth cap — FIXED** (see Classification above). The old `pageBefore` fetched
  only the newest `limit*2` and its cursor-miss fallback returned the **newest** `limit` (comment
  claimed oldest) — dedup-swallowed by the client's #16 ordered merge → "load more silently stops"
  after ~2 pages. Both replaced by the two-phase fetch + empty-page contract.

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

**Reference implementation (our reducer).** `nats-client-wrapper.ts:209` already does the #16 ordered
merge (three-tier match + anchor-cursor insertion, with blanket oldest-first prepend for a
zero-overlap page); the "Load older" response reuses it.

**Telegram reference.** `message-cache.ts` builds bounded history windows on demand; Telegram has no
user-facing "load more" (the client is Telegram itself), so our scroll-to-top pagination UX is novel.

**Implementation sketch (remaining).**
0. ~~Server: raise the `pageBefore` fetch window to the 1000-message ceiling~~ ✅ DONE 2026-07-10
   (two-phase fetch + left-edge widening + empty-page cursor-miss + `planHistoryFetch` call-site
   fix in `index-nats.ts` — see Classification).
1. **Scroll UX (optional polish, still open):** trigger `loadHistory` on scroll-near-top instead of
   only the button, and preserve scroll position (measure `scrollHeight` before prepend, restore
   after).

**Acceptance.** With >2 pages of history (up to the ~1000-message ceiling), repeatedly loading older
keeps fetching+prepending; fetching past the beginning (or past the 1000-message ceiling) is a no-op
(empty page) rather than a silent stop with no explanation.

---

## P0-3 — Slash command discovery (`/help`, `/new`, `/reset`, `/model`, …) — 🔴 DISCOVERY MISSING

**Symptom.** Typing `/` shows nothing; no command menu or autocomplete.

**Classification.** 🔴 **Execution already works (verified by code path); discovery is the real gap.**

**Verified — commands already execute as text.** Traced through openclaw core:
1. Inbound forwards raw text as a command body: `inbound.ts:173` `textForCommands: raw.text` →
   `:200` `commandBody: input.textForCommands`.
2. Core decides via `shouldHandleTextCommands`
   (`/Users/mircorn/workspace/openclaw/src/auto-reply/commands-text-routing.ts:40-48`):
   `if (params.cfg.commands?.text !== false) return true;` — text commands ON by default.
3. `isNativeCommandSurface` is true only for plugins whose **registration object** declares
   `capabilities.nativeCommands === true`. Our registration
   (`packages/plugin/src/channel.ts:115`) declares `{ chatTypes:["direct"], media:false }` — no
   `nativeCommands` → webchannel is NOT a native surface → text slash commands stay active.

**Conclusion:** `/help` in the browser is already routed to core's text-command handler and returns
output as an `agent_message` (which the widget renders). The gap is **discovery + result fidelity**.

**What's genuinely missing.**
1. **A command catalog surfaced to the browser** — returning `[{name,description,args?}]` from
   `openclaw/plugin-sdk/native-command-registry`, filtered by `resolveNativeCommandsEnabled`. **Do not
   hard-code a command array.** ⚠️ The old sketch's `/webchannel/commands` HTTP route no longer has a
   pattern to copy: **the NATS path has no HTTP surface** since the register hop moved to NATS
   request/reply (`registerHttpRoute` is gone from `index-nats.ts`; only the retained legacy WS entry
   `packages/plugin/index.ts:210` still registers an HTTP upgrade route). Two delivery mechanisms fit:
   - **(a) A NATS request/reply or inbound frame over the existing channel (recommended)** — e.g. a
     `load_commands` outbound sibling of `load_history` handled by a new
     `setLoadCommandsHandler` (mirrors `setLoadHistoryHandler` `nats-channel.ts:505` / wired
     `index-nats.ts:548`) that replies with a `commands` inbound frame. Keeps the **zero-inbound**
     agent property (no HTTP surface reintroduced).
   - **(b) A SaaS-side HTTP route** serving the catalog out-of-band. Simpler wiring, but puts the
     catalog on a different origin than the agent that owns the command set.
2. **A typeahead in `demo/web/src/widget.ts`** — when `input.value` starts with `/`, fetch the
   catalog once, render a filterable menu; on pick, insert; on Enter, send as a normal message.
3. **Argument menus** (`/model <pick>`, `/thinking <level>`) — a dropdown rendered from the catalog's
   `args` (ties into P1 buttons / P0-4's control renderer).

**Telegram reference.** `bot-native-commands.ts` (`registerTelegramNativeCommands` `:824`,
`setMyCommands` `:1724`, `findCommandByNativeName` `:419`); catalog import
`openclaw/plugin-sdk/native-command-registry`.

**Two design choices (mutually exclusive on routing):**
- **(A) Stay a text-command surface (recommended).** Keep `channel.ts:115` as-is. Commands execute
  as text (already working); add discovery only. Lowest risk.
- **(B) Become a native-command surface.** Declare `capabilities.nativeCommands:true` in the
  **registration object** (`channel.ts:115`). ⚠️ This alone does NOT disable text-command handling
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
  (`:406`). Frame: `{ type:"approval_request", id, kind, title, description?, prompt,
  options:[{decision,label,style}], expiresAtMs? }`.
- Server handles the decision: `index-nats.ts:530` `setApprovalDecisionHandler` →
  `handleApprovalDecision(...)`.
- Resolution echo: `sendApprovalResolved` (`nats-channel.ts:432`) → `{ type:"approval_resolved", id,
  decision }`.
- **Reducer:** `nats-client-wrapper.ts:381` `case "approval_request"` (upsert **with preserve** —
  `:400-417` so a re-delivered request can't clobber a local resolution — clear `isTyping`); `:421`
  `case "approval_resolved"` (mark resolved). `decide(id, decision)` `:145`.
- **Widget:** `renderApproval` (`widget.ts:81`) renders title/prompt + one button per option
  (danger/primary styling), disables on resolve, and calls `client.decide(a.id, opt.decision)`.
- Demo config: `execApprovals.enabled:true` + approvers (`run.sh`), so approvals run E2E.
- Types: `ApprovalRequest`/`ApprovalOption`/`ApprovalDecision` (`types.ts:31-67`); `decision ∈
  "allow-once" | "allow-always" | "deny"`.

**Since the re-anchor — approval rehydration (#15/#19).** A pending approval that arrives while a
device is disconnected (or is resolved elsewhere) is no longer lost. On every register the server
sends a synchronous `approval_snapshot` `{ approvals, resolved? }` (see §0 and P0-1). The reducer's
`case "approval_snapshot"` (`nats-client-wrapper.ts:435`) runs three legs:
- **Leg A** — a snapshot id with no local card → rehydrate it as a pending, actionable card (and
  clear `isTyping`).
- **Leg B** — a local unresolved card *absent* from the snapshot → it was decided/expired elsewhere;
  retire it, showing the actual decision if the `resolved` array (#19) carries it, else the
  `"unknown"` sentinel (`ApprovalRequest.resolvedDecision?: … | "unknown"`).
- **Leg C** — a local card whose decision frame was lost → re-send the decision, keep the card
  resolved.
The widget renders the resolved-elsewhere state as a neutral `→ resolved (elsewhere)` for `"unknown"`
vs `→ <decision>` otherwise (`widget.ts:105-110`).

> **Security judgment (from the #15 review).** The snapshot rides the **register-hop admission path**,
> so **auto-admission snapshots are by-design EXCLUDED** — sending one on an auto path would leak
> approval ids and approval *power* to a hijacker. Do not "fix" this by snapshotting on auto.

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

**Classification.** 🟡 Client render is built and **mode-agnostic**; the demo **does not enable** any
server streaming mode, so neither the answer-text stream nor the tool-progress stream is exercised.

**Where it stands today.**
- Server streaming is **gated on config** with **two distinct draft modes** (post-#14):
  `inbound.ts:124-126`
  ```ts
  const streamingMode = resolveStreamingMode(channelConfig);
  const draftEnabled = streamingMode === "progress" || streamingMode === "partial";
  const answerStreamingEnabled = streamingMode === "partial";
  ```
  - **`"partial"`** streams the **answer text** into the working draft (`onPartialReply` →
    `draft.pushAnswerText`, `inbound.ts:263-284`) — the core/Telegram-parity "typing out" effect.
    Partial is a **superset** of progress: it also carries tool/item lines.
  - **`"progress"`** streams **tool/item progress lines only** (`onToolStart`/`onItemEvent`,
    `inbound.ts:229-252`); the answer text is **not** streamed — it finalizes atomically.
  - `"block"`/`"off"` take the no-draft fallback.
- The #14 per-itemId cumulative-partial handling + boundary prefix-rollup (and #23's missed-boundary
  defense) live in `packages/plugin/src/message-adapter.ts` (`answerText`/`answerPrefix`,
  `rollCurrentIntoPrefix`, `handleAssistantMessageBoundary`, the "MISSED-BOUNDARY DEFENSE" block in
  `pushAnswerText`).
- **Wire is unchanged:** partial reuses the same `{ type:"progress", id, text }` frame
  (`nats-channel.ts:58`, `sendProgress` `:375`); finalize reuses `agent_message` with the same draft
  `id` (`finalizeDraft` `:383`).
- **Reducer is mode-agnostic:** `nats-client-wrapper.ts:557` `case "progress"` upserts a working
  bubble keyed by draft `id`; the matching `agent_message` (`:569`) finalizes it. **No client work is
  needed to switch the demo to `partial`.**
- **Widget:** working bubbles render italic/dimmed (`widget.ts:150-154` `m.working` → `opacity:.7;
  font-style:italic`).
- ⚠️ **Demo doesn't set `streaming.mode`.** The account block (`run.sh:273-291`) has
  `history`/`execApprovals`/`auth`/`dmSecurity` but **no `streaming.mode`**, so `draftEnabled` is
  false in the demo — no draft frames are emitted at all.

**Telegram reference.** `draft-stream.ts` `createTelegramDraftStream` (`:176`), throttled edits
(`DEFAULT_THROTTLE_MS`, min 250ms). Reasoning/answer split is **P1-3**, not P0.

**Implementation sketch (remaining).**
1. **Enable server streaming in the demo — use `partial`.** Add
   `channels.webchannel.accounts.<acct>.streaming.mode:"partial"` to the `run.sh` config heredoc
   (`run.sh:273-291`) — or set it in the setup wizard (memory `webchannel-setup-wizard-backlog`).
   `"partial"` is what satisfies this section's acceptance (incremental **answer** text that finalizes
   into the answer); choose `"progress"` only if you specifically want tool-progress-lines-only with
   an atomic answer.
2. Optional: a subtle "working" affordance (cursor/shimmer) beyond the current italic dim.

**Acceptance.** With `streaming.mode:"partial"` set, a multi-step / tool-using turn shows incremental
text in a single bubble that finalizes into the answer — no duplicate bubbles, no infinite spinner if
the turn errors (the in-flight draft is finalized on error). (With `"progress"`, the same holds for
tool lines but the answer arrives atomically.)

---

## P0-6 — Typing indicator ("agent is typing…") — ✅ CLIENT BUILT, NATS GATE OPEN

**Symptom (original).** After sending, no feedback that the agent received it.

**Classification.** ✅ Client built and rendered. Server-side, the `capabilities.typing:"off"` gate
is **not wired on the NATS path** (default-on works; the off toggle is silently ignored).

**Where it stands today.**
- Server sends it at turn start: `inbound.ts:160` `transport.sendTyping(wsKey)`. Emit method
  `nats-channel.ts:390`.
- **Reducer:** `nats-client-wrapper.ts:376` `case "typing"` → `isTyping:true`; every subsequent
  real frame clears it (`approval_request`/`progress`/`agent_message` set `isTyping:false`;
  `approval_snapshot` clears it only when it rehydrates a pending actionable card).
- **Widget:** `widget.ts:159` pushes an "agent is typing…" line when `state.isTyping`.
- Demo: `capabilities.typing` unset → default `"on"`, so typing shows.
- ⚠️ **The `capabilities.typing` gate is NOT enforced on the NATS path.** The gate exists only on
  the legacy WS transport (`transport.ts:193/:360/:610` `typingEnabled` + `setTypingEnabled`).
  `NatsChannel` (`nats-channel.ts`) has **no gate field**, `NatsChannel.sendTyping` (`:390`) is
  ungated, and `index-nats.ts` never wires one. Net: an operator setting `capabilities.typing:"off"`
  is **silently ignored on the NATS path** (the `inbound.ts:156-157` comment "the transport gates
  the frame" is only true for the WS transport).
- (Note: `src/typing-indicator.ts` is an **unrelated** feature — ephemeral client↔client typing
  envelopes — not this agent→browser gate.)

**Telegram reference.** `sendchataction-401-backoff.ts` (typing = `sendChatAction` with 401 backoff).
The backoff machinery is Telegram-specific; we only need the on/off signal.

**Implementation sketch (remaining — server only).**
1. Add a `typingEnabled` gate to `NatsChannel` (mirror `transport.ts:193/:360/:610`), set it from the
   account's `capabilities.typing` during account setup in `index-nats.ts`, and gate
   `NatsChannel.sendTyping` (`nats-channel.ts:390`) on it.

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
| 1 | P0-5 streaming demo flag | XS | One-line `streaming.mode:"partial"` in `run.sh` unlocks the already-built (mode-agnostic) render — answer-text streaming; `"progress"` for tool-lines-only. |
| 2 | P0-6 NATS typing gate | S | Small server gate; makes `typing:"off"` honored. |
| 3 | ~~P0-2 server depth cap~~ | — | ✅ DONE 2026-07-10 (`feat/p0-2`): two-phase `pageBefore` to the 1000-msg ceiling + `index-nats.ts` call-site fix; true unbounded cursor stays upstream-blocked. |
| 4 | P0-3 slash discovery | S–M | Catalog route + typeahead (execution already works). |
| 5 | P0-7 send reliability | L | Client replay + server dedupe; the reliability milestone. |

> ✅ **Already built by the integrated demo:** P0-1 (history restore), P0-4 (approval cards), P0-6
> (typing render), P0-5 (progress render). No further client work for those beyond the notes above.
> ✅ **P0-2 (server depth cap)** closed 2026-07-10 on `feat/p0-2` — only the optional scroll-UX
> polish remains in that section.

## Cross-cutting: the reducer is the shared seam

All render extensions now go through one place — the reducer (`nats-client-wrapper.ts:207-405`) and
the widget's `render(state)` (`widget.ts:100-148`). New frame types (e.g. P1-5 `presentation`,
P1-3 `reasoning`) add: a `case` in the reducer, a field on `WebChannelState` (`types.ts:74-94`), and
a branch in `render`. There is no thin path to re-wire.
