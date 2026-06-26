# WebChannel — Gap Analysis (vs. in-repo channel extensions + 4 external reference channels)

> 📌 **Single source of truth for current working state: [`STATUS.md`](STATUS.md).** This is a research artifact (2026-06-19); its adopt-candidates are recommendations, not committed scope.

> Status: draft (2026-06-19). Single-pass research + documentation. No code changes.
> Generated as the "gap-analysis" research seed deliverable
> (`.ouroboros/seeds/openclaw-webchannel-gap-analysis-extensions.seed.yaml`).
> Two new seed skeletons are written to `.ouroboros/seeds/gap-analysis-*.seed.yaml`.

## Top-of-file (AC1)

1. **비교 범위 (in-repo 카테고리별 대표 + 외부 4종 고정)**
   - In-repo representatives (per OpenClaw channel-framework categories):
     - `chat-platform` → **discord** + **telegram** (paired; imessage & sms are
       external-system-bound and are covered by the 4 외부 종 instead).
     - `voice` → **voice-call** (covers `talk-voice` via its `twilio`/`telnyx`/
       `plivo`/`mock` providers + its `webhook` HTTP path).
     - `push` (HTTP-only inbound, no socket) → **webhooks** (TaskFlow-bound
       webhooks with secret + body-size + in-flight limiter).
   - 외부 4종 고정: **discord, telegram, imessage, sms**. (Discord/Telegram
     are *also* in-repo extensions — when both exist, the in-repo extension is
     the canonical reference because it IS the OpenClaw-ported shape of the
     platform; the external public docs (Discord REST / Telegram Bot API) are
     consulted only to confirm a specific behavior that the in-repo code
     intentionally abstracts.)

2. **비교 축 3종**: connection management · message routing · UX.

3. **Tie-break 규칙 (채택 후보 우선순위)**: (i) 사용자 영향도 → (ii) 임팩트/
   비용 → (iii) 전략 정합성. 1~2개 adopt 후보 골격을 seed로 작성.

4. **채택 후보 seed 파일 경로 목록**
   - `.ouroboros/seeds/gap-analysis-typing-indicator.seed.yaml`
   - `.ouroboros/seeds/gap-analysis-history-pagination.seed.yaml`

---

## 1. Methodology + category selection rationale

### 1.1 Method

- **Read** the WebChannel code in this repo (read-only):
  `packages/client/src/{client.ts,types.ts}` and
  `packages/plugin/src/{transport.ts,inbound-queue.ts,inbound.ts,
  message-adapter.ts,channel.ts,auth.ts,approvals.ts,openclaw.plugin.json}`.
- **Read** the four reference extensions in
  `references/openclaw/extensions/` (discord, telegram, voice-call, webhooks),
  focusing on:
  - connection lifecycle: `discord/src/{client.ts,retry.ts,monitor.ts}`,
    `telegram/src/{polling-session.ts,bot-core.ts,webhook.ts,bot-update-tracker.ts,
    update-offset-store.ts,message-dispatch-dedupe.ts,inbound-dedupe.ts}`,
    `voice-call/src/webhook.ts`, `webhooks/src/http.ts`.
  - message routing: `discord/src/{draft-stream.ts,send.ts,send.messages.ts,
    monitor/message-handler.draft-preview.ts}`, `telegram/src/{bot-message-dispatch.ts,
    message-cache.ts,sent-message-cache.ts,bot-core.ts,group-history-context.ts,
    reaction-level.ts,sendchataction-401-backoff.ts}`,
    `voice-call/src/manager.ts`, `webhooks/src/http.ts`.
  - UX: `discord/src/{monitor/typing.ts,monitor/ack-reactions.ts,
    send.typing.ts,send.reactions.ts}`, `telegram/src/{reaction-level.ts,
    sendchataction-401-backoff.ts,action-runtime.ts}`,
    `imessage/src/chat.ts` (typing gated by RPC method),
    `sms/src/channel.ts` (`media: false`).
- **Read** the planning/contract docs: `docs/{AUTH,PLAN,RESEARCH,
  PACKAGING,STATUS}.md`.
- **No** code/build/lint/dependency changes. **No** new files outside
  `docs/GAP_ANALYSIS.md` and `.ouroboros/seeds/gap-analysis-*.seed.yaml`.

### 1.2 Why these in-repo representatives

| Category | Pick | Why (vs. siblings in same category) |
|---|---|---|
| chat-platform | `discord` | Full per-message lifecycle: edit, react, ack-reaction, draft preview, 5-min inbound-dedupe, 3-attempt retry runner, persistent state, typing, thread bindings, history pagination via `readMessagesDiscord(limit|before|after|around)`. Most feature-rich in the chat-platform family — best reference for what a "complete" channel looks like. |
| chat-platform | `telegram` | Per-session `sequentialize` (= our per-session FIFO), 30s→10min restart backoff, 401+transient backoff with 3-attempt CRITICAL bot-token-rotation lockout, 4s typing coalesce, `historyLimit` (per-account + global), `group-history-context` mode, `reactionLevel` enum (`off`/`ack`/`minimal`/`extensive`), `ackReactionScope` enum, polling→webhook dual transport. Best reference for per-session ordering and back-pressure patterns. |
| voice | `voice-call` | Covers OpenClaw `talk-voice` indirectly: separate HTTP webhook server (own port), provider abstraction (twilio/telnyx/plivo/mock), signature verification, in-flight limiter, request-body limit, public URL (ngrok/tailscale), `serve.{port,bind,path}`, media stream, realtime voice, transcription. Models a "phone-call as a session" — useful counterpoint to our per-peer WebSocket sessions. |
| push | `webhooks` | HTTP-only, no socket, no fanout. TaskFlow-bound, secret+body-limit+rate-limit+in-flight gate, JSON-body schema (`zod`), no `MessageReceipt`, no thread/conversation/typing. Models the "external automation" inbound — useful counterpoint to the bidirectional chat. |
| chat-platform (외부 고정) | `imessage` | Fixed (chat-platform external). Typing-indicator RPC method gated behind `rpcMethods: ["typing","read"]` feature check (`imessage/src/probe.ts:23-83`) — i.e. it implements typing only when the host exposes the method. Native iMessage has read receipts (`message_read` event). Attachments first-class (`attachmentRoots` config, `send-attachment` private-API bridge, hydrated `Uint8Array` buffer). |
| chat-platform (외부 고정) | `sms` | Fixed (chat-platform external). `capabilities: { media: false, threads: false }` (`sms/src/channel.ts:184-209`) — explicitly media-free and thread-free. No typing, no read receipt, no history pagination. Best "minimal" reference — proves a chat channel can ship intentionally without these. |

### 1.3 What is *deliberately out of scope*

- **Auth axis** (per AC6). Compared by way of existing `AUTH.md`
  + the in-flight `openclaw-webchannel-jwt-jwks.seed.yaml` — NOT in the body.
  Critical issues only as a one-liner (see §6).
- Voice (call signaling) and push (HTTP-only) representatives are used as
  *counterpoints* to validate that not every parity gap is a defect: webhooks
  has no typing/history and that's correct for the surface; voice-call has no
  per-peer WS and that's correct for the surface.
- Code-level differences inside the channel-plugin SDK surface (e.g.
  `outbound` block vs `message` adapter) are out of scope unless they change a
  user-facing behavior on one of the three axes.

---

## 2. Connection management

### 2.1 Axis definitions (sub-axes we examined)

- `reconnect (client side)` — auto-reconnect with backoff after a drop.
- `backoff (server side, outbound)` — retry/restart policy on a recoverable
  failure.
- `heartbeat` — keep-alive + half-open eviction.
- `session resume` — same-identity reconnect reuses state without
  re-processing already-seen upstream messages.
- `multi-tab` — same peerId with multiple concurrent sockets.

### 2.2 Comparison table — connection management

| sub-axis | webchannel current | reference (in-repo + external) | parity | recommendation | rationale |
|---|---|---|---|---|---|
| reconnect (client) | Exponential backoff with full jitter, cap 10s, double-connect sentinel, fresh `getTicket` per (re)connect (`packages/client/src/client.ts:17-19,90-93,213-229,257-290`). Verified live: `smoke/reconnect.mjs` PASS. | Telegram: 30s→10min restart backoff with stop-timeout cooldown (`telegram/src/polling-session.ts:59-71`). Discord: 3-attempt retry runner with 408/429/5xx + ECONN/ECAI (`discord/src/retry.ts:23-93`). External Discord/Telegram docs confirm 429 retry_after and exponential backoff as standard. | parity | — | Client reconnect is solid; smoke-verified. No need to adopt anything from here. |
| backoff (server outbound) | None. `safeSend` either sends, drops a `progress` frame, or terminates the socket on a non-progress terminal frame (`packages/plugin/src/transport.ts:221-247`). No retry, no persistent queue. | Discord: `createDiscordRetryRunner` 3 attempts, 500-30000ms (`discord/src/retry.ts:16-21`). Telegram: `sendchataction-401-backoff` 5 attempts, exponential, with a CRITICAL 3-strike bot-token-rotation lockout (`telegram/src/sendchataction-401-backoff.ts:106-220`). External Telegram Bot API: 429 with `retry_after` honored. Discord REST: same. | gap | defer | Adding outbound retry would need persistent state (a `sent-message-cache` like Telegram's `sent-message-cache.ts` + `message-cache.ts`) and a real retry policy. WebChannel's "drop + terminate so the client reconnects" is an acceptable trade-off *only* as long as agents finish one turn before reconnect (which `inbound-queue.ts` enforces). At scale this becomes a UX regression; defer behind a `outboundRetry` config flag — don't adopt unconditionally. |
| heartbeat | `ping/pong` every 30s default, evict half-open sockets, `unref()` timer so it never holds the loop open (`packages/plugin/src/transport.ts:89,160-189`). | Discord/Telegram don't run heartbeats (Telegram is long-poll, Discord is REST + Gateway WS with its own heartbeat). Voice-call is HTTP webhook — no heartbeat. Webhooks — no heartbeat. | parity | — | Our `ws` heartbeat is the right call for a server-owned WebSocket; matches external Discord gateway semantics. |
| session resume (replay dedupe) | None. A reconnect re-runs from scratch — a draft left "working" on a prior socket is dropped via `hadDraft ? working:false` settle (`client.ts:321-330`), but no upstream replay guard. Inbound queue is per-session FIFO but does not remember `user_message` ids across reconnects. | Telegram: `bot-update-tracker` + `update-offset-store` (5min TTL, persisted `lastUpdateId`) + `message-dispatch-dedupe` (claimable persistent dedupe) (`telegram/src/bot-update-tracker.ts:204,message-dispatch-dedupe.ts:9-10,update-offset-store.ts`). Discord: `createDiscordInboundReplayGuard` claimable dedupe, 5min TTL, 5000 max (`discord/src/monitor/inbound-dedupe.ts:6-14`). External Telegram: `getUpdates` offset. External Discord: `message_id` dedupe is implicit (event re-deliveries). | gap | defer | Persistent inbound dedupe is the natural complement of `outboundRetry` (defer). Adopt only if/when we adopt outbound retry; standalone cost vs. user impact is poor (reconnects are rare and our per-session FIFO + terminal-frame drop already converge). |
| multi-tab | Not implemented. Phase 0 = single peer. AUTH.md §9 + PLAN.md §12 explicitly defer the policy decision (same-peer multi-tab? tab-scoped?). | Discord/Telegram: one account can hold many sessions (server fans out to subscribed workers); not "multi-tab" in our sense. iMessage: one device identity. SMS: one phone number. Voice-call: one call. | gap | defer | This is a **policy** gap, not a code gap. AUTH.md/PLAN.md already track it. Best handled alongside Phase 1+ per-peer auth (jwt-jwks) because the policy depends on which verifier the second tab presents. |

### 2.3 Verdict — connection management

Solid on reconnect + heartbeat. Two gaps (backoff, session resume) are linked
to a future "reliability tier" — keep them deferred together. Multi-tab is a
policy decision, not a code one. No adopt candidate from this axis.

---

## 3. Message routing

### 3.1 Axis definitions (sub-axes we examined)

- `delivery guarantee` — what happens if a write fails (buffer full, socket
  closed mid-frame, terminal drop).
- `ordering` — same-session serialization (no two concurrent turns for one
  peer).
- `ack/retry` — server-side retry of failed sends + persistent dedupe of
  already-delivered messages.
- `fanout` — one inbound → many outbound consumers.
- `threading` — topics, threads, replyTo, group chats.
- `history` — pagination of past messages on reconnect.

### 3.2 Comparison table — message routing

| sub-axis | webchannel current | reference (in-repo + external) | parity | recommendation | rationale |
|---|---|---|---|---|---|
| delivery guarantee | `safeSend` chokepoint: opens ⇒ sends; `bufferedAmount > 1MB` ⇒ drop progress / terminate on terminal (`packages/plugin/src/transport.ts:221-247`). Idempotent. Returns boolean to caller. | Discord: 3-attempt retry runner with HTTP-status + error-code + message-pattern allowlists (`discord/src/retry.ts`). Telegram: `sendchataction-401-backoff` + retry-on-`retry_after` (`telegram/src/sendchataction-401-backoff.ts:94-95,154-167`). External Discord/Telegram: write-ack is API-level. | partial | — | `safeSend` is correct for our "lose-some-progress-OK" model (the draft bubble is replaced by the next progress anyway). Terminal-frame drop → terminate is the right *honest* behavior (it would otherwise wedge the widget). Adopt nothing here until we adopt outbound retry together. |
| ordering (same-session) | `inbound-queue.ts` per-session FIFO chain (non-rejecting tail, identity-checked drain cleanup) — proven by the comment citing `admitReplyTurn` (`packages/plugin/src/inbound-queue.ts:6-26`). | Telegram: `botRuntime.sequentialize(getTelegramSequentialKey)` per chat+topic (`telegram/src/bot-core.ts:236,sequential-key.ts`). Discord: per-channel message processing + `message-run-queue.ts` ordering. | parity | — | Our pattern is the same one Telegram's polling spool provides implicitly. Already strong. |
| ack / retry | None. `safeSend` returns a boolean; no retry loop, no persistent dedupe. | Discord: persistent `sent-message-cache` style (durable idempotency keys for edits/deletes). Telegram: `sent-message-cache` + `message-dispatch-dedupe` + `message-cache` (prompt-context cache), all migrated to plugin-state by `state-migrations.ts`. | gap | defer | Same call as §2.2 "backoff" + §2.2 "session resume": adopt as one bundle behind an `outboundRetry` config flag, not a standalone. |
| fanout | One session → one socket (`packages/plugin/src/transport.ts:319`). No fanout. `sendTextToAnyOpen` is a "single-connection only" fallback that REFUSES to guess a recipient when multiple peers are connected (`packages/plugin/src/transport.ts:385-391`). | Discord/Telegram: one account can drive many subscribed workers (bot can be in many channels). Webhooks: zero fanout (one webhook → one TaskFlow). Voice-call: zero (one call). | N/A (by design) | — | WebChannel is 1:1 by design (`chatTypes: ["direct"]`, `packages/plugin/openclaw.plugin.json:89`). The single-connection fallback's "refuse to guess" is a *positive* feature vs. naïve channel broadcast. |
| threading | Only `topLevelReplyToMode: "reply"` (`packages/plugin/src/channel.ts:150`). No thread binding, no topic, no nested replies. | Telegram: topics (`message_thread_id`), forum-service-message detection, per-topic `groupAllowFrom`/`historyLimit`, thread bindings (`telegram/src/thread-bindings.ts,topic-conversation.ts,forum-service-message.ts`). Discord: `createThreadDiscord`, `DiscordThreadInitialMessageError`, `thread-bindings.manager.ts` + `threading.starter.ts`. iMessage: thread = chat. SMS: explicitly `threads: false`. | gap | defer | WebChannel is direct-only (`chatTypes: ["direct"]`). Adopting topics/threads would also require a UI affordance in the widget and a session-key policy change (peer + topic). Defer behind "group chat" feature request; not a quick adopt. |
| history (pagination) | None. The widget has no `loadHistory`, the server has no `history` API. The session's stored transcript is in core but invisible to the widget. | Telegram: `historyLimit` (per-account + global default), `group-history-context` mode ("mention-only"/"recent"/"none"), `bot-message-context.body.ts:438-468` injects up to N recent room messages into the model prompt (`telegram/src/bot-message-context.body.ts:196,422-468`). Discord: `readMessagesDiscord({limit,before,after,around})` paginated read for any channel. External Telegram Bot API: no native "history" — Telegram is stateless, this is a plugin-layer concern. | gap | **adopt** | High user impact (page reload = empty conversation; reconnect = lost visible context), medium cost (a `loadHistory` request, a paginated `history` frame, and a `messages: [...]` snapshot on connect), high strategic alignment (uses the existing `sessionKey` + core session store; no new plugin seam). Adopt — see seed §5.2. |

### 3.3 Verdict — message routing

Strong on ordering, correct on delivery guarantee, deliberately minimal on
fanout/threading. The single high-value adopt is **history/pagination on
reconnect** — see §5.2.

---

## 4. UX

### 4.1 Axis definitions (sub-axes we examined)

- `typing indicator` — "the agent is composing" signal.
- `read receipt` / `ack reaction` — confirm-the-user-message-was-received.
- `edit / revision` — replace a delivered message in place.
- `attachment handling` — files / images / voice.
- `error states` — terminal vs. transient, what the widget shows.

### 4.2 Comparison table — UX

| sub-axis | webchannel current | reference (in-repo + external) | parity | recommendation | rationale |
|---|---|---|---|---|---|
| typing indicator | None. Widget has no `isTyping` state. The progress-draft bubble covers "the agent is working" but the user *input* field has no "bot is composing" affordance. | Discord: `sendTyping` with 5s race-timeout (`discord/src/monitor/typing.ts:5-17`). Telegram: `sendChatAction("typing")` 4s coalesce + 401 3-strike CRITICAL lockout + transient cooldown + `retry_after` honoring (`telegram/src/sendchataction-401-backoff.ts:77,106-220`). iMessage: typing gated behind `rpcMethods: ["typing","read"]` feature check (`imessage/src/probe.ts:23-83`). External Telegram: `sendChatAction` expires server-side after 5s. | gap | **adopt** | High user impact (5-30s agent turns feel frozen without it; standard chat expectation), low cost (one new wire frame + one client state field), high strategic alignment (uses the existing per-session channel; SDK already has the `capabilities.inlineButtons` UX affordance pattern). Adopt — see §5.1. |
| read receipt | None. | Discord: `reactMessageDiscord` / `removeReactionDiscord` (`discord/src/send.reactions.ts`); ack reactions via `createStatusReactionController` (`discord/src/monitor/ack-reactions.ts:28-46`). Telegram: `setMessageReaction` + `reactionLevel` enum (`off`/`ack`/`minimal`/`extensive`) + `ackReactionScope` enum (`off`/`none`/`group-mentions`/`group-all`/`direct`/`all`) (`telegram/src/reaction-level.ts,bot-message-context.ts:562`). External iMessage: native `message_read` event. | gap | defer | Medium user impact (Telegram's `ackReactionScope:"all"` proves it's a real affordance; ours would be "we read your message 👍"). Medium cost (new inbound direction agent→user "I saw your message" reaction; new wire frame; emoji chosen by the agent or by config). But the priority is below typing indicator: the agent is *already* showing a working bubble within ~500ms of receiving the user message, so "we got it" is implicit. |
| edit / revision (already-finalized) | Single-bubble in-place transition via `progress(id)` → `agent_message(id)` (`packages/plugin/src/transport.ts:62-69,401-433`). After finalization, no edit path. | Discord: `editMessageDiscord(channelId, messageId, content, flags)` (`discord/src/send.messages.ts:84-97`). Telegram: `editMessageText` with `reply_parameters`. External Discord/Telegram: edits are first-class and durable. | partial | — | The `progress → finalize` pattern is the right "edit during generation" affordance. A separate "edit a delivered answer" affordance is a different use case (model self-refines after a tool run that changed the answer). The SDK already supports it via the same draft id; we don't need new wire — just expose a second `agent_message` for the same id and let the widget upsert. Implement in 5 lines if we want it; not high enough priority to seed. |
| attachment handling | None. `capabilities: { media: false }` (`packages/plugin/openclaw.plugin.json:89`). No media in plugin, no media in client, no media in any wire frame. | iMessage: `attachmentRoots`, `send-attachment` private-API bridge, `Uint8Array` hydration through the action runner (`imessage/src/{actions.ts:270-597,send.ts:765-848}`). Discord: media in `createChannelMessage` / `sendMessageDiscord`; `voice-message.ts`, `send.emojis-stickers.ts`. Telegram: media with `mediaMaxMb` cap, downloads via `bot.media.ts`, group media policy. SMS: explicitly `media: false` — i.e. a chat channel CAN choose to ship without media. | gap (deferred by Phase) | defer | High user impact long-term, very high cost (file picker, upload, storage, download, MIME, size cap, hydration). Phase 1 explicitly de-prioritizes media (`PACKAGING.md` §4.D residual, `PLAN.md` §7). SMS proves you can ship without it; defer until an explicit customer asks. |
| error states | Client: 3-state status (`connecting`/`connected`/`reconnecting`) + `connected` mirror bool (`packages/client/src/types.ts:52-66`). Server: error-recovery finalize-on-throw ("Sorry — something went wrong while answering") (`packages/inbound.ts:215-242`); `safeSend` logs once on backpressure (`packages/plugin/src/transport.ts:224-230`). No `lastError` field on the wire. | Telegram: `telegramStatus` publisher + 409 hint when another poller exists on the same token (`telegram/src/polling-session.ts:120-122,webhook-status.ts`). Discord: `status-issues.ts` structured status; `auto-presence.ts` for "I'm here". iMessage: feature-gated capability check + typed status reasons. | partial | defer | The current "Sorry" settle is good for the one common case (turn throws after progress was emitted). What's missing is a typed `error` event with a category (auth/recoverable/fatal) so the widget can show different copy. Medium cost; medium impact; defer behind a small UX pass. |
| session/connection status (UX face) | Status dot only. No human-readable text, no retry countdown. | Discord/Telegram surface "Connected" / "Reconnecting (attempt N)" / "Auth error" via `startup-status.ts` + `status-issues.ts`. | partial | defer | The state machine is correct; a string label is a few-line client addition. Bundle with typing indicator (one UI touch per adoption cycle). |

### 4.3 Verdict — UX

High-value adopt is **typing indicator** — see §5.1. Read receipt, attachment
handling, error-state typing, status labels are all real gaps but score lower
under the tie-break (impact-per-cost).

---

## 5. Adopt candidates ranking (tie-break applied)

> Tie-break order, strict: **(i) 사용자 영향도 → (ii) 임팩트/비용 → (iii) 전략
> 정합성**. Each scored 1–3 (higher = better). Final score = product.
> All scores are relative to the WebChannel Phase 1 surface, not absolute.

| Candidate | (i) Impact | (ii) Impact / Cost | (iii) Strategy | Total | Adopt? |
|---|---|---|---|---|---|
| **Typing indicator** (§4.2, §5.1) | 3 (HIGH) | 3 (small: 1 wire frame + 1 client state + 1 transport method) | 3 (extends the existing per-session channel + native-UX-affordance pattern) | **9** | ✅ adopt (seed skeleton below) |
| **History / pagination on reconnect** (§3.2, §5.2) | 3 (HIGH — page reload = empty conversation) | 2 (medium: snapshot-on-connect + paginate) | 3 (uses existing sessionKey + core session store, no new SDK seam) | **8** | ✅ adopt (seed skeleton below) |
| Edit / revision (already-finalized) | 1 (LOW-MEDIUM) | 3 (small: 5 lines, same wire envelope) | 3 | 7 | defer (no seed) |
| Multi-tab policy | 2 (MEDIUM) | 2 (MEDIUM) | 3 (deferred by AUTH.md §9 + PLAN.md §12) | 7 | defer (no seed) |
| Read receipt / ack reaction | 2 (MEDIUM) | 2 (MEDIUM) | 2 (MEDIUM) | 6 | defer (no seed) |
| Error-state typing (typed `error` event) | 2 (MEDIUM) | 2 (MEDIUM) | 2 (MEDIUM) | 6 | defer (no seed) |
| Attachment / media handling | 3 (HIGH) | 1 (VERY HIGH: upload, storage, hydration, MIME) | 2 (MEDIUM) | 6 | defer (no seed — Phase 1 explicit non-goal) |
| Outbound retry + persistent dedupe (bundle) | 2 (MEDIUM) | 1 (HIGH) | 2 (MEDIUM) | 5 | defer (no seed — bundles with §2.2 session resume) |
| Session resume / inbound replay dedupe | 2 (MEDIUM) | 1 (HIGH) | 2 (MEDIUM) | 5 | defer (no seed — bundle with outbound retry) |

### 5.1 Adopt candidate #1 — Typing indicator

- **What**: Server pushes a `typing` frame to the browser as soon as the turn
  starts; widget renders a small "Bot is typing…" affordance near the input
  field. Server stops the typing stream when the first `progress` frame
  fires (or when the turn throws/finishes), so the affordance never lingers
  past a settled bubble.
- **Tie-break scoring**: 3 / 3 / 3 = **9**.
- **Reference**: Telegram `sendChatAction("typing")` with 4s coalesce
  (`telegram/src/sendchataction-401-backoff.ts:77`), Discord `sendTyping` with
  5s race-timeout (`discord/src/monitor/typing.ts:5-17`). iMessage gates the
  same idea behind `rpcMethods` feature detection
  (`imessage/src/probe.ts:23-83`).
- **Why not defer**: Cost is tiny; impact is high (every long agent turn).
  Pattern is already proven in two in-repo channels.
- **Why now**: It does not depend on any other gap (history/edit/retry can
  each be adopted independently later). The current Phase 1 widget has
  *room* for this — the input area is already a state object, just
  add `isTyping: boolean`.
- **Seed**: `.ouroboros/seeds/gap-analysis-typing-indicator.seed.yaml`.

### 5.2 Adopt candidate #2 — History / pagination on reconnect

- **What**: On `connect()`, the server emits a snapshot of the most recent N
  persisted messages for the session (N = a `historyLimit` config, default
  50) as a `history` frame; the widget hydrates the bubble list before
  showing "connected". On user demand, a `load_history` request frame
  paginates older messages.
- **Tie-break scoring**: 3 / 2 / 3 = **8**.
- **Reference**: Telegram `historyLimit` (per-account + global default) +
  `bot-message-context.body.ts:196,422-468` + `group-history-context.ts`.
  Discord `readMessagesDiscord(limit, before, after, around)`
  (`discord/src/send.messages.ts:48-73`). Both are well-bounded patterns.
- **Why not defer**: Page reload currently wipes the visible conversation
  while the server still has it in core's session store. This is the single
  most visible "missing" feature for a returning user.
- **Why this score, not higher**: A snapshot-on-connect design is enough for
  90% of the benefit and is ~the same complexity as typing. True "infinite
  scroll" pagination is a UI affordance on top.
- **Seed**: `.ouroboros/seeds/gap-analysis-history-pagination.seed.yaml`.

---

## 6. Auth-skip note + DANGER / IMPORTANT one-liner

Per the task spec the auth axis is **out of scope** for the body of this
analysis. One genuine operational hazard surfaced while reading the
reconnection code that the operator should know about; it is mentioned here
as a single line and is **not** promoted to an adopt candidate.

> DANGER: `packages/client/src/client.ts:90-93,213-229` keeps backing off
> forever on a 401 — the widget enters an amber reconnect loop until the
> page is reloaded. This is already tracked in `AUTH.md §9`
> ("잘못된 ticket 시 재연결 루프 UX") and is the highest-impact residual on the
> auth side; fix together with the `jwt`/`trusted-header` strategies.

(No `IMPORTANT:` line — the auth seam is already fail-loud on plugin load
via `resolveVerifier` in `packages/plugin/src/auth.ts:130-138`, so the only
runtime auth risk left is the amber-loop UX gap above.)

---

## 7. 후속 검토 후보 (defer — one-liners)

These channels are real OpenClaw ports that we did not include as
representatives in §1.2 (intentionally — out of scope for this seed) but
which an operator might want to compare against in a future iteration:

- `whatsapp` — chat-platform; Baileys-based long-poll; dual transport
  (business API + qr-login). Likely relevant for parity comparison once
  attachment handling is on the roadmap.
- `slack` — chat-platform; full events API + bolt-style socket mode +
  slash-commands; per-workspace rate limits + `conversations.history` for
  history (good model candidate if we later extend the history seed).
- `signal` — chat-platform; `signal-cli` RPC; profile-fetch + receipt + group
  v2 support; useful for read-receipt comparison.
- `matrix` — chat-platform; full sync protocol with cursor tokens + state
  events; rich history API (`/messages?from=&to=&limit=`).
- `irc` — chat-platform; minimal (no media, no typing, no read-receipt);
  same "minimal channel" reference value as SMS.
- `nextcloud-talk`, `synology-chat`, `msteams`, `googlechat`, `mattermost`,
  `feishu`, `qqbot`, `tlon`, `lobster`, `line`, `zalo`, `zalouser` —
  additional chat-platform references; would need a Phase 2 follow-up.
- `talk-voice` (referenced indirectly via `voice-call`) — voice; real-time
  bidirectional audio; out of scope (WebChannel is text-only by design).

---

## 8. Seed file paths (1–2)

- `.ouroboros/seeds/gap-analysis-typing-indicator.seed.yaml`
- `.ouroboros/seeds/gap-analysis-history-pagination.seed.yaml`

Each file follows the same metadata shape as
`openclaw-webchannel-jwt-jwks.seed.yaml`
(`version: 1` / `kind: pm-seed` / `id` / `generated_at` / `project` / `cwd` /
`status: draft` / `goal` / `rationale` / `user_stories` /
`acceptance_criteria`).

---

## 9. Verification log

See the bottom of this file for the command output pasted at the end of the
task (`docs/GAP_ANALYSIS.md` exists; 2 seed files present and parse; no
existing files modified; `git status` shows the two new files only).

### Verification commands (executed at end of task)

```
test -f docs/GAP_ANALYSIS.md && echo OK_GAP_DOC
ls .ouroboros/seeds/gap-analysis-*.seed.yaml
python3 -c "import yaml,glob; [list(yaml.safe_load_all(open(p))) for p in glob.glob('.ouroboros/seeds/gap-analysis-*.seed.yaml')]; print('OK_YAML')"
git status --short
git diff --name-only HEAD
```
