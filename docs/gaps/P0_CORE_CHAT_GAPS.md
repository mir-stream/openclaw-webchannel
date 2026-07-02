# P0 — Core Chat Gaps (WebChannel demo vs. Telegram)

> **Scope.** This file covers **P0 only** — the gaps that make the demo feel broken as a
> chat product (no history, no slash commands, unclear HITL, no streaming/typing, no send
> reliability). P1 (rich rendering / media / buttons / doctor) and P2 (threads / reactions /
> spool / throttle) live in sibling files: `P1_*.md`, `P2_*.md`.
>
> **Reference channel.** OpenClaw Telegram extension at
> `../openclaw/extensions/telegram/` (absolute: `/Users/mircorn/workspace/openclaw/extensions/telegram/`).
>
> **How to read each gap.** Every entry has: *Symptom → Classification → Where it stands today
> (our code, `file:line`) → Telegram reference (`file:line`) → Implementation sketch → Acceptance.*
> Classification legend:
> - 🔴 **Missing entirely** — no support in wire, server, or UI.
> - 🟡 **Wiring gap** — server + wire protocol already support it; the demo client just doesn't surface it. **These are the cheap wins.**
> - 🟢 **Partial** — exists but incomplete.

---

## 0. Architecture you must understand first

There are **two client paths** in this repo. The demo uses the thin one.

| Path | File | history | typing | approval | progress | slash |
|---|---|:--:|:--:|:--:|:--:|:--:|
| `WebChannelClient` (legacy WS path — **rich, already handles everything**) | `packages/client/src/client.ts` | ✅ | ✅ | ✅ | ✅ | ❌ |
| **`runDemo` (NATS path — what the demo actually runs)** | `packages/client/src/browser-demo-entry.ts` | ❌ | ❌ | ❌ | ❌ | ❌ |

The **server/agent side (NATS path) is already mature.** `NatsChannel`
(`packages/plugin/src/nats-channel.ts`) emits and handles the full protocol, and
`index-nats.ts` wires all of it:

| Capability | Emit method (`nats-channel.ts`) | Wired in `index-nats.ts` |
|---|---|---|
| history snapshot on connect | `sendHistory()` — `:237` | `:434` (on `/webchannel/nats/register`) |
| history pagination | `setLoadHistoryHandler()` — `:307` | `:643` → `historyPageBefore` |
| typing | `sendTyping()` — `:229` | sent in `inbound.ts:145` (⚠️ `capabilities.typing` gate NOT wired on the NATS path — see P0-6) |
| streaming draft | `sendProgress()` `:214` / `finalizeDraft()` `:222` | `inbound.ts:109-269` (gated on `streaming.mode:"progress"`) |
| approval request | `sendApprovalRequest()` — `:245` | emitted by `approvals.ts:373-380` (`deliverPending`) |
| approval decision | `setApprovalDecisionHandler()` — `:298` | `:633` → `handleApprovalDecision` |

**The full inbound/outbound wire contract already exists** in both the production client
(`packages/client/src/nats-client.ts:97-116`) and the channel
(`packages/plugin/src/nats-channel.ts:36-46`):

```
Inbound  (agent → browser): agent_message | progress | approval_request | approval_resolved | typing | history
Outbound (browser → agent): user_message  | approval_decision | load_history
```

**So most P0 items are 🟡 wiring gaps, not new protocol.** The single line that throws away
90% of the capability is:

```ts
// packages/client/src/browser-demo-entry.ts:179-182
// Wire inbound replies → onReply. Only surface high-level agent_message text;
// other inbound types (progress/typing/approval/history) are ignored by the demo.
client.onMessage((m) => {
  if (m.type === "agent_message") callbacks.onReply(m.text ?? "");
});
```

### Two strategic options (decide before P0-4/5/6)

1. **Wire the NATS demo path directly** — extend `RunDemoCallbacks`
   (`browser-demo-entry.ts:42-49`) with `onHistory/onTyping/onProgress/onApproval*`, and
   render them in the vanilla JS in `e2e/local/demo-app.html`. Lowest effort, keeps the
   proven ALL-REAL setup untouched.
2. **Port the demo onto `WebChannelClient`'s state model** — `client.ts` already reduces the
   full protocol into an immutable `WebChannelState { messages, approvals, status, isTyping }`
   (`client.ts:40-45`, `types.ts:66-83`). It is transport-agnostic *except* it owns a raw
   `WebSocket`; the NATS path would need a small adapter. Higher effort but yields ONE state
   reducer shared by demo + any future React/Vue widget.

**Recommendation:** Option 1 for P0 (fast, unblocks the demo), then refactor toward Option 2's
reducer when building the P1 rich widget. Each gap below is written assuming Option 1 but notes
the `client.ts` code you can lift.

### Reuse note — openclaw `plugin-sdk` runtimes (VERIFIED available)

Telegram does **not** hand-roll approvals/commands/dedupe. It composes openclaw core runtimes.
`openclaw` is our **peer dependency** (`packages/plugin/package.json:26` `>=2026.6.10`) — it is NOT
in this repo's `node_modules`; it's provided by the host at runtime. The authoritative source is
the sibling checkout `/Users/mircorn/workspace/openclaw/src/plugin-sdk/`. **Verified importable
subpaths** (each is a real file under `src/plugin-sdk/`, importable as `openclaw/plugin-sdk/<name>`):

| Subpath | Key export | Reuse for |
|---|---|---|
| `openclaw/plugin-sdk/persistent-dedupe` | `createClaimableDedupe` | **P0-7** send idempotency |
| `openclaw/plugin-sdk/native-command-registry` | command catalog (`findCommandByNativeName`, …) | **P0-3** discovery/catalog |
| `openclaw/plugin-sdk/reply-dispatch-runtime` | `ReplyPayload`, `resolveChunkMode` | **P0-3/P0-5** command+draft dispatch |
| `openclaw/plugin-sdk/approval-delivery-runtime` | `createApproverRestrictedNativeApprovalCapability` | **P0-4** approvals |
| `openclaw/plugin-sdk/command-auth-native` | `resolveNativeCommandSessionTargets` | **P0-3** command authz |
| `openclaw/plugin-sdk/interactive-runtime` | `MessagePresentation`, button building | **P1** buttons |
| `openclaw/plugin-sdk/media-runtime` | `readRemoteMediaBuffer`, `saveRemoteMedia` | **P1** media |
| `openclaw/plugin-sdk/channel-outbound` | `ChannelIngressQueue`, draft chunking | **P2** spool / **P1** chunking |

Our plugin already imports `openclaw/plugin-sdk/channel-core` (`inbound.ts:1`, `channel.ts:4`), so
the wiring pattern is proven. **Prefer these runtimes over from-scratch builds.**

### ⭐ The server defaults are already ON — the demo just doesn't render them

Our own plugin manifest (`packages/plugin/openclaw.plugin.json`) ships every P0 server capability
enabled by default. **The operator does not need to configure anything for P0-1/4/6 to work
server-side; only P0-5 needs a one-line flag flip.** From the manifest:

| Capability | Manifest default | Gap is purely… |
|---|---|---|
| `history.enabled` | **`true`** (limit 50, pageSize 50) | client render (P0-1/2) |
| `capabilities.typing` | **`"on"`** | client render (P0-6) — but the `"off"` toggle is NOT wired on the NATS path (see P0-6 ⚠️) |
| `execApprovals` + `capabilities.inlineButtons` | first-class config, buttons documented | client render (P0-4) |
| `streaming.mode` | option exists (`off\|partial\|block\|progress`) — **not defaulted to `progress`** | set `"progress"` + render (P0-5) |

Note the manifest `uiHints` already describe the approval buttons as
`[Allow once] [Allow always] [Deny]` and history as "pushes a snapshot of the last N messages on
connect" — the intended UX is documented; only the demo client is behind.

---

## P0-1 — Conversation history is not restored on (re)connect

**Symptom.** Reload the page / reconnect → the transcript is empty. Prior turns are gone.

**Classification.** 🟡 Wiring gap. The server already pushes a history snapshot; the demo drops it.

**Where it stands today.**
- Server sends a snapshot the moment a peer registers:
  `index-nats.ts:426-434` calls `historyRecent(api, route.sessionKey, limit, logger)` then
  `channel.sendHistory(peerId, messages)`.
- `historyRecent` reads the openclaw session store: `packages/plugin/src/history.ts`
  (`recent` / `pageBefore`, config via `resolveHistoryConfig` at `history.ts:35`).
- The wire frame exists: `{ type: "history"; messages: [{id, role, text, ts}] }`
  (`nats-client.ts:108`).
- The production client **already parses it** and exposes it via `onMessage`.
- **The demo drops it** at `browser-demo-entry.ts:181-182` (only `agent_message` survives).
- The demo HTML has **no transcript-hydration logic** — `demo-app.html` `append()` only ever
  adds live bubbles (`demo-app.html:425-431`).

**Reference implementation to copy from (our own rich path).**
`client.ts:364-398` — the `case "history"` reducer. It: (a) dedups by `id` against messages
already on screen, (b) forces `working:false` on hydrated bubbles, (c) prepends oldest-first.
Lift this dedup+coerce logic verbatim.

**Telegram reference.** `session-transcript-context.ts` (reads recent turns from session store
with time/window limits), `message-cache.ts` (persistent reply-chain cache),
`bot-message-context.session.ts` (builds the history window). We don't need the reply-chain
machinery — our session store is the source of truth and the server already reads it.

**Implementation sketch.**
1. `browser-demo-entry.ts`: add `onHistory: (messages: ChatMessage[]) => void` to
   `RunDemoCallbacks` (`:42`); in the `onMessage` handler add
   `if (m.type === "history") callbacks.onHistory(m.messages ?? [])`.
2. `demo-app.html`: on `onHistory`, render each message **above** any live bubbles, dedup by
   `id`, in one batch before the "Connected. Say hello…" note. Reuse the `client.ts:383-397`
   dedup logic.
3. Verify `historyRecent` returns turns for the demo's `route.sessionKey`. The demo login
   binds `peerId = user.uuid` (see memory `demo-user-login`); confirm the session store path
   resolves to the same key the agent writes replies under (`inbound.ts:183-186`
   `resolveStorePath`).

**Acceptance.** Send 2 messages → reload → both prior turns + agent replies reappear, in order,
before you can send a new one. No duplicate bubbles on a mid-session reconnect.

**Watch out.** NATS has no retention, and the snapshot is sent from the `/register` HTTP
handler (`index-nats.ts:422-434`), **after** `registerPeer` but the browser must already be
subscribed to `.out` — it is (`nats-client.ts:602`, subscribe happens in `onConnected` before
the register hop). Good. But if you switch to `admission:"auto"` (no register hop), **nothing
triggers the snapshot** — you'd need to send history on first handshake completion instead. The
demo uses the register hop only when `gwUrl` is set (`browser-demo-entry.ts:168`).
**Resolved (2026-07-02 review):** `run-demo.sh:88` sets `DEMO_GW_URL="http://127.0.0.1:$GW_PORT"`
→ the demo runs register-hop, so the snapshot trigger fires as designed.

---

## P0-2 — No history pagination (scroll-up "load more")

**Symptom.** Even if the snapshot works, there's no way to see older-than-snapshot turns.

**Classification.** 🟢 Partial. Client method + server handler + wire frame all exist and no UI
trigger exists — but the server pager has a **hard depth cap** (below), so this is NOT pure
client wiring: real pagination needs a server fix too.

**Where it stands today.**
- Outbound frame exists: `{ type: "load_history", before?, limit? }` (`nats-client.ts:116`).
- Client method exists: `WebChannelNatsClient.loadHistory(before?, limit?)`
  (`nats-client.ts:562`). It's buffered until handshake like every other send.
- Server handler exists: `setLoadHistoryHandler` (`index-nats.ts:643-661`) →
  `historyPageBefore(api, sessionKey, request, pageSize, logger)` → `sendHistory` (reuses the
  same `history` frame, so P0-1's renderer handles the response).
- ⚠️ **Server pager depth cap (found in 2026-07-02 review).** `pageBefore`
  (`history.ts:206-229`): the SDK seam (`runtime.subagent.getSessionMessages`) has no `before`
  cursor, so it always fetches only the **newest `limit*2`** messages and slices within that
  window. Consequences:
  - (a) pagination can never reach further back than ~2 pages from the newest message — page 3+
    silently returns nothing new;
  - (b) when the cursor falls outside the window, the fallback `window.slice(-limit)`
    (`history.ts:222-228`) returns the **newest** `limit` messages, while the comment at
    `history.ts:224-227` claims "oldest" — a comment/code contradiction. The client's dedup
    swallows the duplicates, so the visible symptom is "load more silently stops", not wrong data.
- **No UI trigger and `runDemo` doesn't expose `loadHistory`.** The `DemoController`
  (`browser-demo-entry.ts:52-57`) only has `send` / `disconnect`.

**Reference implementation (our rich path).** `client.ts:168-177` `loadHistory()` — note the
doc comment: it is **UI-triggered only** (scroll-to-top / "Load more"), never auto-fired. Keep
that contract.

**Telegram reference.** `message-cache.ts` builds bounded history windows on demand; there's no
user-facing "load more" in Telegram (the client is Telegram itself), so our pagination UX is
novel — model it on standard chat "scroll to top → fetch older page, prepend, preserve scroll
anchor."

**Implementation sketch.**
0. **Server: fix `pageBefore` depth cap** (`history.ts:206-229`). Either grow the fetch window
   until the cursor is found (iterative deepening: `limit*2`, `limit*4`, … up to a sane max) or
   page over the full transcript if the SDK seam grows a real cursor. Also fix the cursor-miss
   fallback to match its comment (return the *oldest* window slice, or better: an empty page so
   the client can render "beginning of conversation"). Without this, steps 1–3 only ever load
   ONE extra page.
1. `DemoController`: add `loadHistory: (before?: string) => void` →
   `client.loadHistory(before)`.
2. `demo-app.html`: on `#log` scroll near top, call `loadHistory(oldestMessageId)`; the
   response arrives as a `history` frame → P0-1 renderer prepends. **Preserve scroll position**
   (measure `scrollHeight` before prepend, restore after) so the viewport doesn't jump.
3. Track `oldestMessageId` = first message id currently rendered; pass as `before`. `pageSize`
   defaults from `resolveHistoryConfig` server-side.

**Acceptance.** With >2 pages of history, repeatedly scrolling to the top keeps fetching and
prepending older pages (beyond the old `limit*2` window) without the viewport jumping; fetching
past the beginning is a no-op (empty page). If step 0 is deferred, scope acceptance down to one
extra page and note the cap in the demo.

---

## P0-3 — Slash commands don't appear (`/help`, `/new`, `/reset`, `/model`, `/thinking`, `/fast`)

**Symptom.** Typing `/` shows nothing; no command menu, no autocomplete.

**Classification.** 🟢 **Execution already works (VERIFIED by code path); discovery is the real gap.**

**Verified — commands already execute as text.** Traced through openclaw core:
1. Our inbound path forwards the raw text as a command body:
   `inbound.ts:157` `textForCommands: raw.text` → `inbound.ts:178` `commandBody: input.textForCommands`.
2. Core decides whether to interpret it via `shouldHandleTextCommands`
   (`/Users/mircorn/workspace/openclaw/src/auto-reply/commands-text-routing.ts:40-48`):
   ```ts
   if (params.commandSource === "native") return true;
   if (params.cfg.commands?.text !== false) return true;   // ← text commands ON by default
   return !isNativeCommandSurface(params.surface);
   ```
3. `isNativeCommandSurface` returns true only for channel plugins whose **registration object**
   declares `capabilities.nativeCommands === true` (`commands-text-routing.ts:28-32` reads
   `listChannelPlugins()` → `plugin.capabilities`, i.e. the capabilities passed to
   `createChatChannelPlugin`, NOT the JSON manifest). **Our registration
   (`packages/plugin/src/channel.ts:103`) declares `{ chatTypes: ["direct"], media: false }` —
   no `nativeCommands`** → webchannel is NOT a native surface → text slash commands stay active.
   (Note also `commands-text-routing.ts:44`: `cfg.commands?.text !== false` returns true
   *before* the surface check ever runs — so with default config, text commands are on for
   EVERY surface, native or not.)

**Conclusion:** typing `/help` in the browser is **already routed to core's text-command
handler and executes**, returning output as an `agent_message` (which the demo already renders).
Confirm with a 30-second manual test (`run-demo.sh`, type `/help`), but the gap is now scoped to
**discovery + result fidelity only — no execution plumbing needed.**

**What's genuinely missing regardless.**
1. **A command catalog surfaced to the browser.** Telegram calls `bot.api.setMyCommands([...])`
   so the Telegram client renders a menu. We have no equivalent — the browser has no idea what
   commands exist. We need a **`/webchannel/commands` HTTP route (or a wire frame)** that returns
   the catalog `[{name, description, args?}]`, and a typeahead in `demo-app.html`.
2. **Argument menus** (e.g. `/model <pick>`, `/thinking <level>`). Telegram renders these as
   inline-keyboard button menus (`bot-native-commands.ts:419-424` `formatCommandArgMenuTitle`).
   Our web equivalent = a dropdown/quick-reply rendered from the catalog's `args` (ties into
   P1 interactive buttons).
3. **`/approve` interplay** — the core `/approve` text command exists but the widget never sends
   it (`index.ts:83-84`). Once P0-4's approval cards exist, decide whether `/approve` text is
   even needed (buttons supersede it).

**Telegram reference (rich, for the catalog + dispatch model).**
- Registration + menu budget: `bot-native-commands.ts:824` `registerTelegramNativeCommands`,
  `:1724-1731` `setMyCommands`, `:983-999` (Telegram's 100-command / payload-size trimming — we
  won't hit these limits but the catalog-building loop is the reference).
- Command lookup/dispatch: `findCommandByNativeName` (`bot-native-commands.ts:419`), dispatch at
  `:1453` `dispatchReplyWithBufferedBlockDispatcher`.
- Reply dispatch runtime import: `bot-native-commands.ts:117`
  (`openclaw/plugin-sdk/reply-dispatch-runtime`).

**Reuse — the catalog exists in plugin-sdk (VERIFIED).**
`openclaw/plugin-sdk/native-command-registry`
(`/Users/mircorn/workspace/openclaw/src/plugin-sdk/native-command-registry.ts`) exposes the
command catalog (`findCommandByNativeName` + registry helpers) — the same source telegram imports
via `bot-native-command-deps.runtime.js` (`bot-native-commands.ts:14`). Catalog enablement:
`resolveNativeCommandsEnabled` (`openclaw/src/config/commands.ts:58`). Our
`/webchannel/commands` route re-serves this — **do not hard-code a command array.**

**Two design choices (they are mutually exclusive on the routing axis):**
- **(A) Stay a text-command surface (recommended for P0).** Keep the manifest as-is (no
  `nativeCommands` capability). Commands execute as text (already working). Add discovery only.
  Lowest risk; no core dispatch to own.
- **(B) Become a native-command surface.** Declare `capabilities.nativeCommands: true` in the
  channel **registration object** (`packages/plugin/src/channel.ts:103` — NOT
  `openclaw.plugin.json`; `isNativeCommandSurface` reads the registry entry). ⚠️ **Corrected
  (2026-07-02 review):** this alone does NOT turn off core text-command handling — in
  `shouldHandleTextCommands` (`commands-text-routing.ts:40-48`) the `cfg.commands?.text !== false`
  check fires *first*, so text commands stay ON for native surfaces unless the operator ALSO sets
  `commands.text: false`. Full (B) = declare `nativeCommands` + set `commands.text: false` + own
  command dispatch and arg-menu rendering (the full `bot-native-commands.ts` model). More power
  (inline arg menus for `/model`, `/thinking`), much more work. **Defer to P1/P2.**

**Implementation sketch (choice A).**
1. **Confirm execution** (manual test above — 30s).
2. **Catalog route.** Add `api.registerHttpRoute({ path: "/webchannel/commands", auth: "plugin",
   match: "exact", ... })` in `index-nats.ts` (pattern: existing `registerHttpRoute` at `:453`)
   returning the `native-command-registry` catalog filtered by `resolveNativeCommandsEnabled`.
3. **Typeahead UI.** In `demo-app.html`, when `#input` starts with `/`, fetch the catalog once and
   render a filterable menu; on pick, insert the command; on Enter, send as a normal
   `user_message` (core handles it via `commandBody` — no new send type).
4. **Result rendering.** Command output arrives as a (possibly multi-line) `agent_message`;
   P1 rich rendering improves fidelity but plain text already works.

**Acceptance.** Typing `/` shows a menu of at least `/help /new /reset /model /thinking /fast`;
selecting `/help` sends it and the help text renders; `/reset` clears the server session (verify
history snapshot is empty on next reconnect).

**Note.** This is the **only 🔴 P0 item requiring genuinely new surface** (a catalog route + a
typeahead). Everything else is wiring. Scope it first if execution turns out NOT to work.

---

## P0-4 — HITL approval cards (exec / plugin) are not shown

**Symptom.** Unclear whether "approve" works. When the agent needs approval, nothing renders;
the turn appears to hang.

**Classification.** 🟡 Wiring gap. Server emits `approval_request` and handles
`approval_decision`; the demo renders neither.

**Where it stands today.**
- Server emits the card: `approvals.ts:373-380` (`deliverPending`) sends the built
  `PendingApprovalView` payload via `nats-channel.sendApprovalRequest()`
  (`nats-channel.ts:245-270`). Frame shape at
  `nats-client.ts:100-107`: `{ type:"approval_request", id, kind:"exec"|"plugin", title,
  description?, prompt, options:[{decision,label,style}], expiresAtMs? }`.
- Server handles the decision: `index-nats.ts:633-637` `setApprovalDecisionHandler` →
  `handleApprovalDecision(api.config, id, decision, peerId)` (`approvals.ts`).
- Resolution echo: `sendApprovalResolved` (`nats-channel.ts:271-290`), frame
  `{ type:"approval_resolved", id, decision }`.
- Client outbound method exists: `WebChannelNatsClient.sendApprovalDecision(id, decision)`
  (`nats-client.ts:557`).
- **The demo drops `approval_request`** (`browser-demo-entry.ts:181`) and `DemoController` has
  no `decide()`.

**Reference implementation (our rich path — copy this).** `client.ts` already has the entire
reducer:
- `decide(id, decision)` — `client.ts:141-155` (optimistic resolve + send `approval_decision`).
- `case "approval_request"` — `client.ts:414-440` (upsert into `approvals[]`, clear `isTyping`
  because the agent is *blocked on the user*, not working).
- `case "approval_resolved"` — `client.ts:442-446`.
- Types: `ApprovalRequest`, `ApprovalOption`, `ApprovalDecision`
  (`types.ts:31-58`) — `decision ∈ "allow-once" | "allow-always" | "deny"`.

**Telegram reference (for UX semantics).**
- Card capability: `approval-native.ts:85` `createApproverRestrictedNativeApprovalCapability`
  (built on `openclaw/plugin-sdk/approval-delivery-runtime`).
- Approver gating: `exec-approvals.ts` (`getTelegramExecApprovalApprovers`,
  `isTelegramExecApprovalApprover`) — who may approve (falls back to `commands.ownerAllowFrom`).
- Button/decision mapping: `approval-native.ts:132-159` `resolveApproveCommandBehavior`.
- Telegram renders Approve/Deny as inline-keyboard buttons on the approval DM.

> ⭐ **Build the renderer GENERIC — P1-5 (general interactive buttons) is merged into this gap.**
> Approval cards and general agent buttons are the same surface (agent presents clickable controls
> → user clicks → decision/action flows back). Do NOT hard-code an approval-only card. Build one
> `renderControls(controls, onPick)` that takes a **normalized array**
> `[{ label, style, disabled?, kind: "decision" | "action" | "url", payload }]`. Approval is just
> the `kind:"decision"` case. Then P1-5 is purely additive (2 wire frames + a second call site into
> the same renderer) with zero UI rework. See `P1_RICH_UX_GAPS.md` → P1-5 for the delta.

**Implementation sketch.**
1. `browser-demo-entry.ts`: add to `RunDemoCallbacks`:
   `onApprovalRequest(req)` and `onApprovalResolved(id, decision)`; add `decide(id, decision)`
   to `DemoController` → `client.sendApprovalDecision(id, decision)`.
2. `demo-app.html`: build the **generic `renderControls(controls, onPick)`** (see the ⭐ note).
   For an `approval_request`, normalize `options[]` `[{decision,label,style}]` → controls with
   `kind:"decision"`, render title/prompt/description + the buttons (style the `deny` option
   distinctly). On click → `onPick` → `controller.decide(id, decision)`; optimistically disable.
3. On `approval_resolved`, mark the card resolved with the final decision (authoritative).
4. Clear the typing indicator when a card appears (see P0-6) — mirror `client.ts:432`.

**Acceptance.** Trigger a tool that requires approval → a card with Approve/Deny appears →
clicking Approve lets the turn continue and the agent's result renders; clicking Deny surfaces
the denial. Buttons disable immediately on click and reflect the authoritative resolution.
The renderer is generic enough that a future `presentation` frame (P1-5) reuses it unchanged.

**Watch out.** Approval authorization is enforced server-side. `index.ts:78-84` notes the widget
path is guarded before the gateway RPC; confirm the demo's logged-in user is an eligible approver
(or that the demo account's `execApprovals`/`ownerAllowFrom` permits it) or approvals will be
rejected. See memory `demo-user-login` for the user↔account authz model.

---

## P0-5 — No streaming / partial responses (progress drafts)

**Symptom.** The agent reply appears all at once after a long pause; no live "typing out" of the
answer, no tool-progress feedback.

**Classification.** 🟡 Wiring gap (+ a config flag). Server can stream; demo doesn't render it
and the demo config likely doesn't enable it.

**Where it stands today.**
- Server-side streaming exists but is **gated on config**:
  `inbound.ts:109` `const progressEnabled = resolveStreamingMode(channelConfig) === "progress"`.
  When enabled, `inbound.ts:110-269` builds a `ProgressDraftController` that hooks
  `onToolStart` / `onItemEvent` / `onPartialReply` and pushes rolling `progress` frames, then
  **finalizes the same draft id** with the final answer (`inbound.ts:236-247`).
- Frames exist: `{ type:"progress", id, text }` (`nats-client.ts`, `nats-channel.ts:214`) and
  finalize reuses `agent_message` with the same `id` (`nats-channel.ts:222` `finalizeDraft`).
- Crash-safety: `inbound.ts:260-269` finalizes an in-flight draft with an apologetic text if the
  turn throws after a progress frame (so the widget never spins forever).
- **Demo drops `progress`** (`browser-demo-entry.ts:181`) and `run-demo.sh` sets no `streaming`
  config (**verified 2026-07-02** — no `streaming` key anywhere in the script), so progress mode
  is not enabled in the demo.

**Reference implementation (our rich path — copy this).** `client.ts:448-462` `case "progress"`:
upsert a **single working bubble keyed by draft `id`** (`working:true`), and the matching
`agent_message` with the same `id` finalizes it to `working:false` (`client.ts:464-486`). The
`ChatMessage.working` flag already exists (`types.ts:22-29`); the demo's `append` would need an
`upsert`-by-id variant (`client.ts:195-209` `upsertMessage` is the reference).

**Telegram reference (for the streaming model).** `draft-stream.ts` — `createTelegramDraftStream`
(`:176`) returns `{ update, updatePreview, flush, ... }` (`:41-56`); it throttles edits
(`DEFAULT_THROTTLE_MS`, min 250ms, `:196`) and handles flood-wait backoff. Also
`reasoning-lane-coordinator.ts` / `lane-delivery.ts` split reasoning vs. answer (that split is
**P1**, not P0 — P0 is just "show the answer as it streams").

**Implementation sketch.**
1. **Enable server streaming** in the demo config: set
   `channels.webchannel.<account>.streaming.mode:"progress"` (or wherever the account config
   lives — see the setup wizard, memory `webchannel-setup-wizard-backlog`). Update `run-demo.sh`.
2. `browser-demo-entry.ts`: add `onProgress(id, text)` and make `agent_message` carry `id`
   through to an `onReply(text, id?)` so the demo can finalize the matching draft.
3. `demo-app.html`: implement `upsertMessage(id, text, working)` (lift `client.ts:195-209`);
   `progress` → upsert working bubble; `agent_message` with `id` → finalize; without `id` →
   append (legacy).
4. Optional: a subtle "working" affordance (cursor / shimmer) on `working:true` bubbles.

**Acceptance.** A multi-step / tool-using turn shows incremental text (or tool-progress) in a
single bubble that finalizes into the answer — no separate duplicate bubbles, no infinite
spinner if the turn errors.

---

## P0-6 — No typing indicator ("agent is typing…")

**Symptom.** After sending, there's no feedback that the agent received it and is working.

**Classification.** 🟡 Wiring gap. Server sends `typing`; demo ignores it.

**Where it stands today.**
- Server sends it at turn start: `inbound.ts:145` `transport.sendTyping(wsKey)` (best-effort,
  drop-only). Emit method `nats-channel.ts:229` `sendTyping`.
- Frame exists: `{ type: "typing" }` (`nats-client.ts`, `nats-channel.ts:230`).
- ⚠️ **The `capabilities.typing` gate is NOT enforced on the NATS path (found in 2026-07-02
  review).** The gate exists only on the legacy WS transport (`transport.ts:187-197`
  `typingEnabled` + `setTypingEnabled`). `NatsChannel.sendTyping` (`nats-channel.ts:229`) is
  **ungated** and `index-nats.ts` never wires any typing gate — the only "typing" mention there
  is `index-nats.ts:641`, a typing-shaped cast passed to `resolveHistoryConfig` (a mis-wiring
  smell, not a gate; the comment in `inbound.ts:141-142` claiming "the transport gates the
  frame" is only true for the legacy transport). Net effect: default-on behavior works, but an
  operator setting `capabilities.typing:"off"` is **silently ignored** on the NATS path.
- **Demo drops it** (`browser-demo-entry.ts:181`).

**Reference implementation (our rich path — copy this).** `client.ts:401-412` `case "typing"`:
set `isTyping:true`; **every subsequent real frame clears it** (`progress` / `agent_message` /
`approval_request` each do `isTyping:false` — see `client.ts:410,432,460,470`). Semantics:
best-effort, no ack, no explicit stop — mirror Telegram/Discord. `WebChannelState.isTyping` is
already in the type (`types.ts:66-83`).

**Telegram reference.** `sendchataction-401-backoff.ts` (typing = `sendChatAction`, with 401
backoff + cooldown), `bot-message-context.typing.test.ts`. The backoff machinery is
Telegram-API-specific; we only need the on/off signal.

**Implementation sketch.**
1. `browser-demo-entry.ts`: add `onTyping()` callback.
2. `demo-app.html`: on `typing`, show an animated "agent is typing…" affordance (reuse the
   existing status dot `#dot` / a three-dot bubble); **clear it on the next `progress` /
   `agent_message` / `approval_request`**. Don't leave it up indefinitely.
3. **Server: wire the missing gate on the NATS path.** Add a `typingEnabled` gate to
   `NatsChannel` (mirror `transport.ts:187-197`), set it from the account's
   `capabilities.typing` during account setup in `index-nats.ts`, and clean up the stray
   typing-shaped cast at `index-nats.ts:641` (it belongs to this gate, not to
   `resolveHistoryConfig`).

**Acceptance.** Sending a message immediately shows "typing…"; it disappears the instant the
first real frame (progress/answer/approval) arrives. With `capabilities.typing:"off"` on the
account, no `typing` frame is ever emitted on the NATS path.

---

## P0-7 — Send is not reliable across reconnect (no replay / idempotency)

**Symptom.** A message sent while the socket is momentarily down is silently dropped; a
reconnect can in principle re-deliver. No delivery guarantee.

**Classification.** 🔴/🟡. There's an explicit TODO; NATS has no retention, so this needs new
client-side machinery, but the server already dedups turns per session.

**Where it stands today.**
- Legacy WS client explicitly defers this: `client.ts:124`
  `// TODO(reconnect): message replay + idempotency dedupe deferred.` — a send while not OPEN is
  dropped (`client.ts:125`).
- NATS client **buffers outbound until the handshake** (fail-closed, `nats-client.ts:681-705`),
  which covers the *initial* connect race but **not** a mid-session drop (on reconnect,
  `resetSession()` clears the session key but the outbound queue semantics for in-flight sends
  aren't replay-guaranteed).
- No `messageId`-based idempotency on the browser→agent path (the E2E envelope has a
  `messageId`, `e2e-browser-client.ts:624`, but it's random per send, not a dedupe key the
  server enforces).

**Telegram reference (the model to adopt).** `message-dispatch-dedupe.ts` — a **7-day claimable
dedupe window** built on `openclaw/plugin-sdk/persistent-dedupe` (`createClaimableDedupe`,
`:4`):
- TTL: `TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS = 7*24*60*60*1000` (`:7`).
- Claim/forget semantics: claim before processing, `forget` (rollback) on failure so a retry
  isn't falsely deduped (`:14-15`, `TelegramMessageDispatchReplayForgetError` `:27`).
- Key builder: `buildTelegramMessageDispatchReplayKey(msg)` (`:68`).

**Reuse — VERIFIED available.** `createClaimableDedupe` lives in
`openclaw/plugin-sdk/persistent-dedupe`
(`/Users/mircorn/workspace/openclaw/src/plugin-sdk/persistent-dedupe.ts`), importable as a peer
subpath. Our agent side can dedupe inbound `user_message` by a client-supplied stable id with
almost no new code — mirror `message-dispatch-dedupe.ts:4` (claim before processing, `forget` on
failure).

**Implementation sketch.**
1. **Stable client message id.** Have the browser stamp each `user_message` with a stable,
   monotonic id (survives reconnect). Include it in the E2E envelope routing (reuse
   `messageId`, but make it deterministic per logical send, not per transmit).
2. **Outbound replay queue (client).** Keep unacked sends in a queue; on reconnect + rehandshake,
   re-send. Pair with (3) so re-sends are idempotent.
3. **Server-side dedupe (agent).** In `inbound.ts` / the dispatcher (`index-nats.ts:594-608`
   `createSerializedInboundDispatcher`), claim the client message id via the persistent-dedupe
   runtime before running the turn; `forget` on failure.
4. **Ack frame (optional).** Consider a lightweight ack so the client can drop delivered sends
   from its replay queue instead of relying purely on dedupe.

**Acceptance.** Send a message, kill the relay mid-send, let it reconnect → the message is
delivered exactly once (arrives after reconnect, never duplicated). A rapid double-submit of the
same logical message is deduped server-side.

**Scope note.** This is the heaviest P0 item and the only one needing both client and server
work. If demo-polish is the priority, P0-1/4/5/6 (pure wiring) land first; P0-7 can trail as the
"reliability" milestone.

---

## Suggested execution order

| Order | Gap | Effort | Why |
|---|---|---|---|
| 1 | P0-6 typing | XS | Trivial wiring; instant UX win; validates the callback-extension pattern. |
| 2 | P0-1 history restore | S | High-value; server already sends the snapshot. |
| 3 | P0-4 approval cards | S–M | Answers "does HITL work"; reducer exists in `client.ts`. |
| 4 | P0-5 streaming | M | Needs a config flag + upsert renderer; big perceived-quality jump. |
| 5 | P0-2 history pagination | S | Builds on P0-1's renderer. |
| 6 | P0-3 slash commands | S–M | **Execution already works (verified); discovery-only.** Catalog route + typeahead. |
| 7 | P0-7 send reliability | L | Client + server; do last as the reliability milestone. |

> **Before starting row 1:** do P0-3's 30-second execution check first (`run-demo.sh`, type
> `/help`) — it's free, and if execution unexpectedly does NOT work it reorders everything.

## Cross-cutting: extend the demo callback contract once

Items P0-1/4/5/6 all extend the same two seams. Do this refactor **once**, up front:

```ts
// packages/client/src/browser-demo-entry.ts:42  RunDemoCallbacks — add:
onHistory?:          (messages: ChatMessage[]) => void;
onTyping?:           () => void;
onProgress?:         (id: string, text: string) => void;
onApprovalRequest?:  (req: ApprovalRequest) => void;
onApprovalResolved?: (id: string, decision: string) => void;
// and change onReply to carry the optional draft id for finalize:
onReply:             (text: string, id?: string) => void;

// packages/client/src/browser-demo-entry.ts:52  DemoController — add:
loadHistory: (before?: string) => void;
decide:      (id: string, decision: string) => void;

// Replace the drop-all handler at :181 with a full switch mirroring client.ts:355-488.
```

Then `demo-app.html` grows one renderer per frame type — or, per Option 2 above, is rebuilt on
`WebChannelClient`'s `subscribe(state => render(state))` reducer, which already implements every
case in `client.ts:355-488`.
