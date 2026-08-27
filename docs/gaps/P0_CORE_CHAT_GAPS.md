# P0 — Core Chat Gaps (WebChannel vs. Telegram)

> **Scope.** This file covers **P0 only** — the gaps that make a chat product feel broken (no
> history, no slash commands, unclear HITL, no streaming/typing, no send reliability). P1 (rich
> rendering / media / buttons / doctor) and P2 (threads / reactions / spool / throttle) live in
> `P1_*.md`, `P2_*.md`.
>
> **Reference channel.** OpenClaw Telegram extension at
> `../openclaw/extensions/telegram/` (absolute: `/Users/mircorn/workspace/openclaw/extensions/telegram/`).
>
> **⚠️ Re-anchored 2026-07-03; re-verified 2026-07-13 (post-#24…#33 tree).** The integrated
> showcase demo rewrote the demo surface, and the P0/P1 parity stack has since largely **landed**.
> P0 capability enablement is built, but **two P0 correctness/UX residuals remain**: P0-3 argument
> menus and P0-5 multi-message finalize correctness
> ([#94](https://github.com/mir-stream/openclaw-webchannel/issues/94)). The demo drives the production
> `WebChannelNATSClient` state reducer, so the P0 client surfaces exist; statuses below distinguish
> enablement from unresolved correctness. Since the 07-10
> re-verify develop merged: **P0-2 depth cap (#24)**, the **/stop control lane + typing gate + slash
> discovery + debounce/coalesce + ingress dedupe (#25/#26/#28/#29/#30)**, **markdown (#27, P1)**,
> **client replay+ack (#31)**, and the **protocol-version registration (#33)**. Corrected below for:
> partial-mode answer-text streaming (#14, P0-5 — now enabled in the demo), the `approval_snapshot`
> rehydration frame (#15/#19, P0-4/§0 wire), the ordered history merge (#16, P0-1/§0), the NATS
> register hop replacing `registerHttpRoute` (P0-3), and the two new inbound frames (`commands`,
> `ack`) + register-reply version fields (§0 wire).
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
| Low-level NATS client | `packages/client/src/nats-client.ts` (`WebChannelNatsClient`) | raw NATS WS, E2E registration, `onMessage`/`onError`/`onState`, `loadHistory` `:768`, `sendApprovalDecision`, terminal-auth classify `:551-556` |
| **State reducer wrapper** | `packages/client/src/nats-client-wrapper.ts` (`WebChannelNATSClient`) | reduces full protocol → `WebChannelState`; `getState` `:110`, `subscribe` `:115`, `send` `:131`, `decide` `:145`, `loadHistory` `:155` |
| Demo widget | `demo/web/src/widget.ts` | `subscribe(render)` → bubbles, typing, approval cards, "Load older", terminal re-auth |
| **Retired** | `packages/client/src/browser-demo-entry.ts` (`runDemo`) | old drop-all path; only a SaaS smoke test + `e2e/local/ci-smoke.html` still reference it |

The **wrapper reduces every inbound frame** (`nats-client-wrapper.ts`):

| Frame | Reducer case | Effect |
|---|---|---|
| `history` | `case "history"` | **#16 ordered merge**: TWO-tier matching since #240 half 2 (id → exact text+role adoption, **USER rows only**; the positional tier and its anchor were deleted — an agent row matches by id or fresh-inserts) + **insertion-cursor** placement (fresh unmatched messages land at `matchedIndex+1`, so a mid-session snapshot's unseen suffix inserts chronologically). Blanket oldest-first prepend only for zero-overlap pages / initial hydration into empty state. |
| `typing` | `:376` | `isTyping:true` |
| `approval_request` | `:381` | upsert into `approvals[]` (**upsert-preserve** `:400-417`: a re-delivered request can't clobber a local resolution), clear `isTyping` |
| `approval_resolved` | `:421` | mark card resolved |
| `approval_snapshot` | `:435` | **#15/#19 rehydration**: Leg A (rehydrate a lost pending card), Leg B (retire a card resolved elsewhere — show actual decision from `resolved`, else `"unknown"`), Leg C (re-send a lost decision frame); clears `isTyping` when a pending card is rehydrated |
| `progress` | `:557` | upsert working bubble keyed by draft `id` |
| `agent_message` | `:569` | finalize draft / append |
| `commands` | `:412` | **P0-3**: replace `state.commands` with the delivered discovery catalog (`CommandCatalogEntry[]`) |
| `ack` | `:1081` | **P0-7b/P0-4**: advance the matching `wireId` to `sendState:"accepted"` via the authoritative send tracker (`onSendState`) — the reducer case is now a no-op (acceptance is tracked low-level, no `delivered` boolean) |

Terminal auth failure → `onError` (`:103`) sets `status:"error"` (no eternal spinner). A separate
`onProtocol` listener (not a reducer case) records the register reply's `protocolVersion` /
`pluginVersion` into `agentProtocolVersion` / `agentPluginVersion` (#33 — the CLIENT enforces the
version match and goes terminal on mismatch; these fields are plaintext, diagnostic-only, and gate
nothing on the trust path).

The **server/agent side (NATS path)** lives in the package-root composition entry
`packages/plugin/index-nats.ts` (the old `src/index-nats.ts` is gone; wiring split into modules):

| Capability | Emit (`nats-channel.ts`) | Wired in `index-nats.ts` (root) |
|---|---|---|
| register hop | — | `setRegisterRequestHandler()` `:322` (channel) → wired `:638` (**NATS request/reply — the old HTTP `registerHttpRoute` is gone**) |
| history snapshot on register | `sendHistory()` (`nats-channel.ts:644`) | **from the register success path** (stateless): `history-serve.ts` `sendSnapshot` → `serveHistoryRequest` (journal replay) → `sendHistory`, **deferred one turn** so the register reply publishes first. ⚠️ Updated by #240 half 2 — was `historyRecent`→`sendHistory` as a detached core-transcript read; both that symbol and the `AsyncResource` detour are deleted. |
| approval snapshot on register | `sendApprovalSnapshot()` `:473` | **from the same register path**, **synchronous** (not detached): `listPendingApprovalsForPeer`/`listResolvedApprovalsForPeer` → `sendApprovalSnapshot` (`:668-673`) |
| history pagination | — | `setLoadHistoryHandler` → `history-serve.ts` `servePage` → `planHistoryFetch` → `serveHistoryRequest` (journal replay) → `sendHistory`, deferred, and bounded to one in-flight page per peer. ⚠️ Updated by #240 half 2 — `historyPageBefore`/`historyRecent` (the core-transcript pager) are deleted. |
| command discovery | `sendCommands()` `:527-530` | `setLoadCommandsHandler` `:658` wired `:917-925` → `createCommandCatalogProvider(api.config)()` (memoized, config-filtered) |
| typing | `sendTyping()` `:509-513` (**now gated** — see P0-6) | gate set `index-nats.ts:590` `channel.setTypingEnabled(resolveTypingEnabled(account))` |
| streaming draft | `sendProgress()` `:375` / `finalizeDraft()` `:383` | `inbound.ts:124-136` (gated on `streaming.mode` — `partial` = answer text, `progress` = tool lines) |
| approval request | `sendApprovalRequest()` `:406` | emitted by `approvals.ts` `deliverPending` |
| approval decision | `setApprovalDecisionHandler()` (channel `:496`) | `index-nats.ts:530` → `handleApprovalDecision` |
| ingress ack | `sendAck()` `:539-543` | one per debounce flush from `createIngressOnFlush` (`index-nats.ts:675-686`), covering fresh + deduped ids |

**The full wire contract** lives in the client (`nats-client.ts` / `types.ts`) and channel
(`nats-channel.ts` `:52-87`) — **nine inbound / four outbound** frames after #30 added `commands`
(P0-3) and #31 added `ack` (P0-7b):

```
Inbound  (agent → browser): agent_message | progress | approval_request | approval_resolved | approval_snapshot | typing | history | commands | ack
Outbound (browser → agent): user_message  | approval_decision  | load_history | load_commands
```

`approval_snapshot` = `{ type:"approval_snapshot"; approvals:[…]; resolved?:[{id,decision}] }`
(`packages/client/src/types.ts`; plugin side `nats-channel.ts:74-78`). The optional `resolved` array
is the #19 addition. `ApprovalRequest` also gained `resolvedDecision?: ApprovalDecision | "unknown"`
and `resolutionConfirmed?:boolean`. Other wire deltas: `user_message` gained an optional stable `id`
(`nats-channel.ts:57` — the dedupe/ack key; id-less frames stay back-compatible); `commands` carries
`CommandCatalogEntry[]` (`:83`); `ack` carries `{ ids: string[] }` (`:87`). **Register reply** (not a
`.out` frame — the register req/reply) now carries `protocolVersion` + `pluginVersion`
(`nats-register.ts:306-314`) alongside `{ peerId, registered:true, wrappedConversationKey }`; the
client enforces the protocol match and goes terminal on mismatch (#33). `turn_settled` additionally
carries an optional `outcome?: "ok" | "error"` (**P0-4** — additive; older peers ignore it).
`WebChannelState` now holds `messages` (+`wireId`/`sendState`/`sendFailure` — **P0-4** replaced the
boolean `delivered`), `approvals`, `status`, `connected`, `error?`, `isTyping?`, `commands?`,
`agentProtocolVersion`, `agentPluginVersion` (`types.ts:262`).

### ⭐ Server defaults are ON; the demo enables the important ones

`packages/plugin/openclaw.plugin.json` ships every P0 server capability with a sane default, and
`demo/run.sh:268-291` turns on the ones that matter:

| Capability | Manifest default | Demo config (`run.sh`) | P0 status |
|---|---|---|---|
| `history.enabled` | **`true`** (`:174-178`) | **`true`** (`:234`) | ✅ P0-1 works E2E |
| `execApprovals` + `capabilities.inlineButtons` | first-class (`:137/:163`) | **enabled + approvers** (`:235`) | ✅ P0-4 works E2E |
| `capabilities.typing` | **`"on"`** (`:167-170`) | unset → default on | ✅ P0-6 — gate now wired on NATS (`typing:"off"` honored) |
| `streaming.mode` | option only (enum `off\|partial\|block\|progress`, `:110`), **no default** | **`"partial"`** (`run.sh:286`) | 🟡 P0-5 — enablement built; multi-message finalize correctness #94 open |
| `messages.inbound.byChannel.webchannel` (core key) | core default `0` (inert) | **`300`** (`run.sh:268`) | ✅ P1-8b pre-run debounce active |

### Reuse note — openclaw `plugin-sdk` runtimes (VERIFIED available)

Telegram does **not** hand-roll approvals/commands/dedupe. `openclaw` is our **peer dependency**
(`packages/plugin/package.json`, `>=2026.6.10`); the authoritative source is the sibling checkout
`/Users/mircorn/workspace/openclaw/src/plugin-sdk/`. Importable subpaths:

| Subpath | Key export | Reused by |
|---|---|---|
| `openclaw/plugin-sdk/persistent-dedupe` | `createPersistentDedupe` | **P0-7a** ingress dedupe (record-at-ingress — see the decision record in P0-7) |
| `openclaw/plugin-sdk/native-command-registry` | `listNativeCommandSpecsForConfig` | **P0-3** discovery catalog (`commands-catalog.ts`) |
| `openclaw/plugin-sdk/command-primitives-runtime` | `isAbortRequestText` | **P1-8a** `/stop` control lane (`control-lane.ts`) |
| `openclaw/plugin-sdk/approval-delivery-runtime` | `createApproverRestrictedNativeApprovalCapability` | **P0-4** approvals |

Our plugin already imports `openclaw/plugin-sdk/channel-core` (`inbound.ts`, `channel.ts`). New P0/P1
modules split into `src/` (tsc + vitest covered, since `index-nats.ts` is outside tsconfig):
`control-lane.ts`, `command-gate.ts`, `commands-catalog.ts`, `ingress-dedupe.ts`, `protocol.ts`
(server) and `command-filter.ts` (client), plus `demo/web/src/markdown.ts`.
**Prefer these runtimes over from-scratch builds.**

---

## P0-1 — Conversation history restored on (re)connect — ✅ BUILT

**Symptom (original).** Reload / reconnect → the transcript was empty.

**Classification.** ✅ Built by the integrated demo. Server pushes a snapshot; the reducer hydrates
it; the widget renders it.

**Where it stands today.**
- Server sends the snapshot **from the register success path** (Phase 6 stateless-register change — it
  used to fire on first liveness / register-complete, that wiring is now gone; the register hop is
  now NATS request/reply via `setRegisterRequestHandler`, no HTTP). Every register (first join,
  reload, reconnect) gets the bounded snapshot: **as of #240 half 2**,
  `serveHistoryRequest(journal.read, peerId, { kind:"recent", limit })` →
  `channel.sendHistory(peerId, messages)`, deferred one turn with `setImmediate` so the register
  reply is not held behind a synchronous replay. (It used to be
  `historyRecent(api, route.sessionKey, …)` run inside `runDetachedHistoryRead` so it would
  authorize against a synthetic operator client; both the core read and the detour are deleted —
  the journal needs no authorization because it is ours.) **Since #15/#19,
  the same register path also sends an `approval_snapshot`** (`sendApprovalSnapshot`) —
  deliberately **synchronous**, and it must stay that way (race analysis comment beside the wiring
  in `nats-account-runtime.ts`), so a pending approval card is rehydrated on the same hop as
  history (see P0-4). The client's message-id-idempotent, order-preserving hydration absorbs
  duplicate snapshots across reconnects.
- The snapshot reads the PLUGIN's own delivery journal, not core's session store:
  `journal-history.ts` (`serveHistoryRequest` → `projectJournalHistory`), config via
  `resolveHistoryConfig` in `history.ts`.
- Wire frame: `{ type:"history"; messages:[{id,role,text,ts}] }`.
- **Reducer hydrates it (#16 ordered merge):** `nats-client-wrapper.ts`'s `case "history"` — no
  longer a blanket "dedup + prepend oldest-first". Since #240 half 2 it does TWO-tier matching (id →
  exact text+role adoption of server ids onto local live-id bubbles, **USER rows only**; the
  positional tier for reformatted agent replies is DELETED, along with its anchor, because the
  journal serves the delivery-act id so an agent row matches by id or has no local counterpart)
  and **insertion-cursor** placement so an overlapping mid-session snapshot's unseen suffix
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
heredoc**: the `channels add` setup adapter may write `admission:register-hop, so `run.sh:321-326` re-asserts
`accounts.<acct>.nats.admission="register-hop"` programmatically after enrollment, and the trigger
fires because of that re-assertion. If you switch to `admission:register-hop` (no register hop), neither
snapshot sends — re-wire them onto whatever path replaces register. The client must have its `.out`
subscription active *before* it calls register (`WebChannelNatsClient.onConnected` ordering) or the
snapshot is lost.

---

## P0-2 — History pagination (scroll-up "load more") — ✅ BUILT (1000-msg ceiling)

> ⚠️ **SUPERSEDED 2026-08-26 by #240 half 2 — the 1000-message wall is gone, and
> so is everything below that reasons from it.** The entire SERVER half of this
> section describes a pager built on `openclaw`'s tail-fetch transcript seam:
> the two-phase fetch, `MAX_FETCH_WINDOW = 1000`, the window-relative synthetic
> ids, the "upstream-constrained, file a feature request for a `before`/`offset`
> cursor" analysis. None of that code exists any more. The plugin now serves
> history from its OWN delivery journal (`journal-history.ts`, replaying the
> client's reducer), and a page comes off the full projection. **Distinguish the
> two quantities the old wording ran together (it said "no cap at any size"):**
> REACH is now uncapped — `historyPageBefore` pages arbitrarily far back, so the
> "conversations >1000 messages hard-wall" really is gone and needs nothing from
> upstream. A single PAGE is still capped at 1000 for a peer-supplied `limit`
> (`MAX_WIRE_HISTORY_LIMIT` in `history.ts`), which is what base effectively did
> too — though **not** "via `MAX_FETCH_WINDOW` and again inside core's
> `getSessionMessages`", as an earlier revision of this line said. That is true
> only of the `page` path: base's `recent()` forwarded the peer's `limit`
> unclamped and was capped ONCE, by core. `{load_history, limit: 1e9}` carries no
> cursor, so it is a `recent`. The cutover dropped that clamp with core itself;
> #240 half 2 restores it, at zero cost to reach.
>
> What is genuinely still open here is the CLIENT half: the scroll-UX polish
> (item 1 of the sketch) and the user side of the adoption merge. The AGENT side
> is **deleted** as of #240 half 2 — the positional tier is gone and the
> text tier is closed to agent rows, because the journal serves the delivery-act
> id, so an agent row either matches by id or has no local counterpart to match.
> Four data-loss defects were found there across four review rounds before the
> tiers were removed rather than patched again (doc §15.6 has the list). Text
> matching survives for USER rows only, where the local `u-<n>` echo and the
> journaled wire id legitimately differ; removing that is **#302**, blocked on
> **#243**. The new cost ceiling is different in kind
> and is tracked separately: a page is a full synchronous replay, quadratic in
> conversation length (**#286** — the materialized read model).
>
> Kept below as the record of what was built and why, not as current state. Do
> not cite it for "how does history pagination work" or for anything about
> upstream limits.

**Symptom (original).** Older-than-snapshot turns can't be reached past ~2 pages.

**Classification.** ✅ Closed 2026-07-10 (#24, branch `feat/p0-2`). Two defects fixed:
1. **`pageBefore` depth cap + left-edge truncation** (`history.ts`, DELETED by #240 half 2): a two-phase fetch —
   phase 1 reads `Math.min(limit*2, MAX_FETCH_WINDOW)` (`:287`); the older-slice is returned only when
   it cannot be left-truncated by the window edge (`idx >= limit || (found && phase1Limit >=
   MAX_FETCH_WINDOW)`, `:293`); otherwise (miss OR hit at `idx < limit`) phase 2 widens to the
   1000-message upstream ceiling (`MAX_FETCH_WINDOW = 1000`, `:240`, mirrors
   `PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT`) and re-searches. A cursor absent from the maximal
   window returns an **empty page** (`:313` — the honest end-of-history signal; the old `slice(-limit)`
   newest-N fallback fed the client dedup-swallowed duplicates = silent stop).
2. **Live NATS call-site bug** (`index-nats.ts` load-history handler): it passed the whole
   `{before, limit}` request object as `beforeId`, so live-path pagination ALWAYS returned `[]`
   (masked from tsc — `index-nats.ts` is outside the plugin tsconfig `include`). Now routed
   through `planHistoryFetch(request, pageSize)` (`history.ts`; the function survives, the line anchor did not): validates the wire `limit`
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

**Reference implementation (our reducer).** `nats-client-wrapper.ts`'s `case "history"` already does the #16 ordered
merge (two-tier match + insertion-cursor placement, with blanket oldest-first prepend for a
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

## P0-3 — Slash command discovery (`/help`, `/new`, `/reset`, `/model`, …) — ✅ BUILT (arg menus open)

**Symptom (original).** Typing `/` showed nothing; no command menu or autocomplete.

**Classification.** ✅ Built (#30). Execution already worked (commands route as text through core);
discovery — the real gap — is now closed on **both halves**. One residual: **argument menus** are not
rendered yet.

**Execution (unchanged, still true).** `/help` typed in the browser is routed to core's text-command
handler and returns output as an `agent_message`; webchannel declares no `capabilities.nativeCommands`
(an ABSENCE in `channel.ts`'s capabilities block — no line anchors it, and the
one that used to be cited here points at unrelated code) so text slash-commands stay active (core `commands-text-routing.ts:40-48`,
`cfg.commands?.text !== false`). No change was needed here.

**Where it stands today — discovery built.**
- **Server catalog.** New inbound frame `{type:"load_commands"}` (`nats-channel.ts:63`) → outbound
  `{type:"commands", commands: CommandCatalogEntry[]}` (`:83`); `setLoadCommandsHandler` (`:658`) /
  `sendCommands` (`:527-530`), wired `index-nats.ts:917-925`. The catalog is built by
  `buildCommandCatalog` (`src/commands-catalog.ts`) from `listNativeCommandSpecsForConfig`
  (`openclaw/plugin-sdk/native-command-registry`) — **config-filtered, alias-free, name-sorted, NOT
  hard-coded**, so a command gated off for the deployment is absent and new core commands appear
  without touching this plugin. The provider is **memoized per account**
  (`createCommandCatalogProvider`) — the handler runs inline for any registered peer, so per-request
  rebuilds were an event-loop DoS surface; memoizing removes it without a rate limiter. Entry shape:
  `{name (no leading slash), description, args?:[{name,description?,required?,choices?}]}`.
  > **Exposure decision.** The catalog is served to **any registered peer**, including wildcard /
  > `admission:register-hop` peers — deliberately, unlike the history/approval snapshots (which ride the
  > register-hop admission path). The command set is low-sensitivity (it is the same list core would
  > run for a typed command), so leaking it to an auto peer carries none of the approval-power risk
  > that gates the snapshots.
- **Client typeahead.** `demo/web/src/widget.ts` — a `cmdMenu` element (`:78`) rendered by
  `renderMenu()` (`:238`); when the input starts with `/` it lazily calls `client.loadCommands()` with
  a 3s cooldown (`:250-256`), filters with the pure `filterCommandCatalog`
  (`packages/client/src/command-filter.ts`), dismisses on Escape, and inserts `/name ` on click. State
  gained `commands?: CommandCatalogEntry[]` (`types.ts:149`), fed by the reducer `case "commands"`
  (`nats-client-wrapper.ts:412`).

**Telegram reference (UX semantics).** `bot-native-commands.ts` (`registerTelegramNativeCommands`
`:824`, `setMyCommands` `:1724`, `findCommandByNativeName` `:419`); catalog import
`openclaw/plugin-sdk/native-command-registry` — the same registry our catalog reads.

**Residual (still open).** **Argument menus** (`/model <pick>`, `/thinking <level>`): catalog entries
already carry `args` (with static `choices` where the registry declares them), but the widget only
inserts the command *name* — it does not yet render a dropdown from `args.choices`. This is the P0-3
residual; it ties into the P1-5 control renderer (see P0-4).

**Acceptance (met, minus arg menus).** Typing `/` shows a filterable menu of the config-enabled
commands; selecting one inserts it and sending runs it (the help/output renders as an `agent_message`;
after P1-1, as markdown). Arg-value dropdowns are the open slice.

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

## P0-5 — Streaming / partial responses (progress drafts) — 🟡 PARTIAL (#94 open)

**Symptom (original).** The reply appeared all at once; no live "typing out", no tool-progress
feedback.

**Classification.** 🟡 The streaming capability is built and the demo exercises it, but multi-message
turns are not yet durable on the live path. [#94](https://github.com/mir-stream/openclaw-webchannel/issues/94)
tracks the correctness gap: WebChannel currently flattens more than one assistant message into one
draft id, then replaces that id with the last `final` payload. Earlier assistant messages disappear
until a history reload restores them.

**Where it stands today.**
- Server streaming is **gated on config** with **two distinct draft modes** (post-#14):
  `inbound.ts:124-136`
  ```ts
  const streamingMode = resolveStreamingMode(channelConfig);
  const draftEnabled = streamingMode === "progress" || streamingMode === "partial";
  const answerStreamingEnabled = streamingMode === "partial";
  ```
  - **`"partial"`** streams the **current assistant message's answer text** into an active working
    draft (`onPartialReply` → `draft.pushAnswerText`) — the "typing out" effect. Partial is a
    **superset** of progress: it also carries tool/item lines.
  - **`"progress"`** streams **tool/item progress lines only** (`onToolStart`/`onItemEvent`,
    `inbound.ts:229-252`); the answer text is **not** streamed — it finalizes atomically.
  - `"block"`/`"off"` take the no-draft fallback.
- The current #14/#23 implementation detects assistant-message boundaries but rolls completed text
  into `answerPrefix` under one turn-wide draft id. That avoids a mid-stream clobber but loses the
  message boundary; the last `final` then replaces the whole combined draft. #94 replaces this with
  **materialize-and-rotate** behavior: settle the completed assistant message under its existing id,
  then stream the next assistant message under a new id. A first-lane tool scaffold is not assigned to
  an empty assistant lane: it remains a turn-level provisional preview whose id is claimed by the first
  successful assistant lane or independent delivery, so `Working…` cannot survive
  beside the payload as a settled ghost. An independent claim never creates a lane. The
  public callback contract is weaker than Telegram's internal seam: `onBlockReplyQueued` may arrive
  after the next message-start callback, its index is optional, and its payload is pre-TTS/media and
  pre-`beforeDeliver` rewrite/cancel. The plugin therefore retains unresolved predecessor lanes and
  records only tentative ordering reservations—never queued text/media. Actual post-hook
  `kind:"block"` delivery is wire-authoritative, but no public identity correlates it to a reservation:
  even a sole reservation can be unrelated after callback omission or notice→non-notice rewrite.
  Every authorized block in partial mode therefore uses an independent non-lane delivery path. If P
  is visible and unclaimed, both a lane's first `progress`/final-only `agent_message` and an independent
  delivery reserve P and send with P's id. The lane transport boolean or independent delivery's
  `visibleReplySent` must be actual `true` before that owner commits;
  `false`/throw rolls back P and any tentative lane ID, keeps the writer active, records the failure
  without blind inline retry, and lets the next successful lane/independent payload reuse P. If another
  consumer claims P before a failed partial lane's later update, that lane uses a fresh id. The queue
  serializes this reserve/send/commit-or-rollback transaction. Any successful lane/independent commit
  also stops/invalidates the provisional scaffold writer. Later tool/item events must never send
  `progress(P,Working…)`, because the reducer would overwrite the durable lane/independent payload at
  P and mark it working again. The `turnActive` signal already landed through #96/#101 and preserves
  turn-level in-flight visibility between bubbles; structured tool detail remains #97. Public
  `onSkip`/`onBeforeDeliverCancelled`/
  `onDeliverySettled` observers plus delivery `onError` retire tentative state so cancel(A) cannot
  leave a ghost or permanently block B. The three block notice flags are classified first and take an
  independent path that never creates, settles, or blocks an assistant lane.
- **`kind:"final"` is a delivery class, not an assistant-message id.** Core may deliver several final
  payloads in one turn and the pinned builder can replay assistant blocks as `[error,A1,A2,B]`, where
  A1/A2 belong to one lane. Queued callbacks cannot correlate that array: default partial mode may
  produce zero callbacks, while block streaming may coalesce A1/A2 into one callback and still emit
  three terminal assistant texts. Notices do not consume assistant lanes. After a leading error, every
  non-notice final without public identity uses the same independent provisional-or-fresh path. This at-least-once
  policy may duplicate
  already-materialized A/B, but never drops or guesses ownership. Authorized blocks likewise use
  at-least-once independent delivery, so partial duplication and one bubble per block are explicit costs. Block
  dedupe/same-message grouping/exact lane ownership require a stable public dispatch/message identity
  that survives rewrite/cancel into actual delivery and are deferred to
  [#111](https://github.com/mir-stream/openclaw-webchannel/issues/111).
- **Wire primitives already fit the target:** partial uses `{ type:"progress", id, text }`; finalize
  uses `agent_message` with the same `id`. One assistant message uses one id; the id rotates only at
  an assistant-message boundary.
- **Reducer is mode-agnostic:** a `progress` frame upserts a working bubble by id and the matching
  `agent_message` finalizes it. Different ids already create different bubbles, so #94 is expected to
  be a plugin-side lane change, not a new client protocol.
- **Widget:** working bubbles render italic/dimmed (`widget.ts:215` `m.working` → `opacity:.7;
  font-style:italic`).
- ✅ **Demo sets `streaming.mode:"partial"`.** The account block (`run.sh:286`) now carries
  `"streaming": { "mode": "partial" }` alongside `history`/`execApprovals`/`auth`/`dmSecurity`, so
  `draftEnabled` + `answerStreamingEnabled` are both true and the answer streams into the working
  bubble.

**Telegram reference — illustrative only, not a contract basis.** OpenClaw's Telegram channel
materializes the active answer lane before rotation, calls `forceNewMessage()`, and serializes
`onAssistantMessageStart` / `onBlockReplyQueued` work rather than recovering boundaries from the
final string. But Telegram is bundled *inside* core and reads a wider seam than the published
plugin contract — notably `assistantMessageIndex` at its delivery seam, which
`ChannelDeliveryInfo` does not carry for plugins. Treat it as evidence that core preserves message
boundaries, not as a template a plugin can copy. See §5.2/§5.3 of
`ISSUE_94_DRAFT_FINALIZE_DATA_LOSS_PLAN.md`. Reasoning/answer split is **P1-3**, not P0.

**Other residual (nit).** The setup wizard (`src/setup-wizard.ts`) still does not offer
`streaming.mode`; an operator enrolling via `channels add` must set it by hand (as the demo does).
Optional polish: a subtle "working" affordance (cursor/shimmer) beyond the italic dim.

**Acceptance (not yet met).** On the ordinary path with `streaming.mode:"partial"`, each completed assistant message must
settle as its own bubble while partial frames edit only the current bubble. A two-message live turn
must remain two messages after settle and match a fresh history hydrate. No content-based
`includes`/suffix heuristic may decide whether messages are the same. Error/abort paths must settle
only the active draft and leave earlier settled bubbles intact. A tool scaffold followed by an answer
must reuse one provisional id, and final `[error,A1,A2,B]` must not infer ownership from callback
cardinality. Both the zero-callback default path and the coalesced
`[A1+"\n\n"+A2@0,B@1]` callback path must leave materialized A/B unchanged and preserve error
plus every uncorrelated final through the independent provisional-or-fresh path, explicitly accepting
duplicates until #111. (Each lane/independent send reports its real delivery result; only success
commits P, false/throw rolls back P plus tentative lane assignment, and one failure must not stop later
payloads. Partial-first/final-only × false/throw × later lane/independent success requires pinned-runtime
coverage, with the later success on P and no blind retry or ghost.)
(Queued payloads must never reach wire; rewrite/cancel, actual send `true`/`false`/throw, cancel(A) → B,
and all three notice flags with/without partial and interleaved A/B require pinned-runtime coverage.)
(Every authorized block in partial mode is independent regardless of whether zero, one, or several
queued reservations are pending; reservations only hold/retire ordering barriers and never select a
lane. With visible+unclaimed P, block/notice/error/fallback success must claim P before a later lane;
false/throw must leave P reusable. P→block success→B is `[block(P),B(new)]`, block-only leaves one
bubble, and failed block→B lets B claim P. Once lane or independent delivery claims P, late tool/item
events must produce zero scaffold frames; B still uses a fresh id after an independent claim.)
(With `"progress"`, tool lines remain an ephemeral scaffold and the answer arrives atomically.)

---

## P0-6 — Typing indicator ("agent is typing…") — ✅ BUILT (NATS gate now wired)

**Symptom (original).** After sending, no feedback that the agent received it.

**Classification.** ✅ Built. Client renders it, and the server-side `capabilities.typing:"off"` gate
is **now wired on the NATS path** (#26) — the off toggle is honored, not silently ignored.

**Where it stands today.**
- Server sends it at turn start: `inbound.ts:160` `transport.sendTyping(wsKey)`. Emit method
  `nats-channel.ts:509-513`.
- **Reducer:** `nats-client-wrapper.ts:376` `case "typing"` → `isTyping:true`; every subsequent
  real frame clears it (`approval_request`/`progress`/`agent_message` set `isTyping:false`;
  `approval_snapshot` clears it only when it rehydrates a pending actionable card).
- **Widget:** `widget.ts:220` pushes an "agent is typing…" line when `state.isTyping`.
- ✅ **The `capabilities.typing` gate is now enforced on the NATS path.** `NatsChannel` has a
  `private typingEnabled = true` field (`nats-channel.ts:249`) and `setTypingEnabled()` (`:502-504`);
  `sendTyping` (`:509-513`) returns `false` without emitting when disabled. It is wired at account
  setup: `index-nats.ts:590` `channel.setTypingEnabled(resolveTypingEnabled(account))`, where
  `resolveTypingEnabled` (`src/account-config.ts:271-276`) reads the **per-account** resolved config
  = `(capabilities?.typing ?? "on") !== "off"`. So `capabilities.typing:"off"` now suppresses the
  frame on NATS.
- (Note: `src/typing-indicator.ts` was an **unrelated** feature — ephemeral client↔client typing
  envelopes, not this agent→browser gate. It was never wired to production and was deleted in
  #153; its design is retained in `docs/PHASE6_MULTIDEVICE_PLAN.md` §13.2.)

**Telegram reference.** `sendchataction-401-backoff.ts` (typing = `sendChatAction` with 401 backoff).
The backoff machinery is Telegram-specific; we only need the on/off signal.

**Acceptance (met).** Sending shows "typing…" that clears on the first real frame; with
`capabilities.typing:"off"` on the account, no `typing` frame is emitted on the NATS path.

---

## P0-7 — Send reliability across reconnect (replay / idempotency) — ✅ BUILT (both halves)

**Symptom (original).** A message sent while the socket is momentarily down could be dropped; a
reconnect could re-deliver. No delivery guarantee.

**Classification.** ✅ Built — client replay queue (P0-7b, #31) + server ingress dedupe (P0-7a, #30) +
an ack frame closing the loop. This was the heaviest P0 item and the only one needing both ends.

**Where it stands today — client (P0-7b).**
- Each `user_message` is stamped with a stable id (`randomInboxToken()`) in `sendUserMessage()`
  (`nats-client.ts:1277`). `ChatMessage` gained `wireId?`; **P0-4** replaced the boolean `delivered?`
  with `sendState?` (queued/sent/accepted/completed/failed) + `sendFailure?` (`types.ts`); the
  wrapper stamps the local echo with its `wireId` at send/release time.
- Replay ledger: `outboundQueue` (`:858`) + `unackedLedger: Map<string,OutboundMessage>` (`:873`,
  cap `MAX_UNACKED = 100`, oldest-eviction with a one-shot warn `:1365-1378`, user_message only). On
  session re-establishment `flushQueue()` (`:1327-1342`) prepends the unacked ledger and re-seals
  each with the **same id**, so a mid-session drop is re-sent.
- Inbound `ack {ids:string[]}` → `drainAcked` removes acked ids from the ledger **and** advances
  each to `sendState:"accepted"` via the authoritative low-level tracker (`onSendState` → the
  wrapper patches the bubble). **P0-4** removed the old `delivered:true` reducer flip; the wrapper's
  `case "ack"` is now a no-op (acceptance is tracked low-level, and a duplicate/late/post-terminal
  ack is a guarded no-op).

**Where it stands today — server (P0-7a).**
- Ingress dedupe via `createPersistentDedupe` (`openclaw/plugin-sdk/persistent-dedupe`,
  record-at-ingress), per-account (namespace = accountId), 7-day TTL, key `${peerId}:${id}` on the
  optional `user_message.id` — `index-nats.ts:629-639`, logic in `src/ingress-dedupe.ts`
  (`filterFreshInboundItems` / `createIngressOnFlush`, wired as the debouncer's `onFlush`
  `:675-686`). Id-less frames are back-compat pass-through (never recorded); a non-string / >128-char
  id is treated as id-less to bound SQLite storage amplification.
- Ack: `{type:"ack", ids}` (`nats-channel.ts:87`, `sendAck` `:539-543`) is sent **once per flush,
  BEFORE dedupe/dispatch**, covering fresh AND duplicate ids — ack = admission (the original was
  admitted), not turn success, so a deduped duplicate must still drain the client's ledger. It also
  acks `/stop`-cancelled buffered items (record-BEFORE-ack, `ingress-dedupe.ts:262-288`) and the
  control-lane frame itself (`index-nats.ts:787`).

> **Decision record — `createPersistentDedupe`, NOT the sketch's `createClaimableDedupe`.** The
> original sketch (and Telegram's `message-dispatch-dedupe.ts`) used claim/commit with a `forget`
> rollback. We deliberately chose **record-at-ingress** (at-most-once) instead
> (`ingress-dedupe.ts:1-34`): (a) a processing failure already surfaces via the error-finalize path
> and a human retry is a NEW id, so there is nothing to roll back; (b) the P1-8b coalesce merge keeps
> only the FIRST message's fields, so a per-id rollback after a merged-turn failure would be lossy
> anyway; (c) claim/commit's in-flight waiting guards a concurrent same-key race that cannot happen
> here (the check runs inside the debouncer's same-peer-serialized `onFlush`). The honest tradeoff: a
> **sub-millisecond crash window** between record and turn-start can lose a message the replay queue
> then dedups away — accepted because the alternative re-admits duplicates on every crash-after-effect
> and partial-delivery (far more common). Narrow at-most-once beats wide at-least-once for this
> surface. (Distinct from the separate F4 in-memory anti-replay window `acceptFreshInbound`,
> `nats-channel.ts:1006-1037` — a crypto-layer defense; do not conflate the two.)

**Telegram reference.** `message-dispatch-dedupe.ts` — a 7-day dedupe window on
`openclaw/plugin-sdk/persistent-dedupe`; key builder `buildTelegramMessageDispatchReplayKey(msg)`. We
reuse the same runtime, different factory (persistent vs claimable — see the decision record).

**Acceptance (met).** Send a message, kill the relay mid-send, let it reconnect → the replay ledger
re-sends and ingress dedupe makes it exactly once. A rapid double-submit of the same id is deduped
server-side; the ack drains the ledger even for the deduped duplicate.

**Residual (accepted).** The record→turn-start crash window above; and agent-DOWN durability (a
`user_message` published while the agent is not subscribed is still lost — no JetStream / disk spool)
remains **P2-4**. P0-7 covers the client→agent replay + idempotency side; P2-4 is the durability side.

---

## Suggested execution order (remaining work only)

**P0 capability enablement is built, with two residuals still open.** P0-3 needs its argument-menu
UX and P0-5 needs #94's multi-message finalize correctness:

| Order | Gap | Effort | Why |
|---|---|---|---|
| 1 | P0-3 argument menus | S | Catalog entries already carry `args.choices`; render a dropdown from them (widget currently inserts the name only). Ties into the P1-5 control renderer. |
| 2 | P0-5 multi-message finalize (#94) | L | Replace the turn-wide draft with ordered lanes, two-phase lane/independent provisional ownership, success-only scaffold-writer invalidation, tentative block reservations + lifecycle cleanup, and at-least-once claim-or-fresh delivery. |

> ✅ **Done:** P0-1 (history restore), P0-2 (depth cap, #24 — optional scroll-UX polish is all that
> remains there), P0-3 (slash discovery, #30 — arg menus excepted above), P0-4 (approval cards +
> rehydration), P0-5 **enablement only** (demo streams `partial`; #94 correctness remains above),
> P0-6 (typing render + NATS gate, #26),
> P0-7 (client replay + server dedupe + ack, #30/#31). See each section for the residual notes.

## Cross-cutting: the reducer is the shared seam

All render extensions now go through one place — the reducer (`nats-client-wrapper.ts`) and the
widget's `render(state)`. New frame types (e.g. P1-5 `presentation`, P1-3 `reasoning`) add: a `case`
in the reducer, a field on `WebChannelState` (`types.ts:262`), and a branch in `render` — exactly
as #30's `commands` and #31's `ack` did. There is no thin path to re-wire.
