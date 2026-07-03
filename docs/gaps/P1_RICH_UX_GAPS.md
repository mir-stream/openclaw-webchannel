# P1 — Rich UX Gaps (WebChannel vs. Telegram)

> **Scope.** P1 = the gaps that separate a "works" chat from a "polished product": rich text
> rendering, long-message handling, reasoning/answer separation, media, interactive buttons,
> self-diagnosis (doctor), and reconnect/error UX. Assumes P0 (`P0_CORE_CHAT_GAPS.md`) is done —
> several P1 items build on P0 wiring. P2 (threads / reactions / spool / throttle / audit) is in
> `P2_ADVANCED_GAPS.md`.
>
> **Reference channel.** Telegram extension at `/Users/mircorn/workspace/openclaw/extensions/telegram/src/`.
> **openclaw core** (peer dep, sibling checkout): `/Users/mircorn/workspace/openclaw/src/`.
>
> **⚠️ Re-anchored 2026-07-03.** The integrated showcase demo rewrote the demo surface (now
> `demo/web/src/widget.ts` over the `WebChannelNATSClient` reducer). **P1-7 (error/reconnect UX) is
> mostly built** by that work (marked ✅). Markdown/media/reasoning/doctor remain open. `file:line`
> re-pointed at the current tree.
>
> **Classification.** 🔴 missing entirely · 🟡 client-render-done / server-left · 🟢 partial polish ·
> ✅ built by the integrated demo (number retained as anchor).
>
> **Big reuse theme.** Telegram composes `openclaw/plugin-sdk/*` runtimes rather than hand-rolling.
> Web is a different *transport* but the same *content model* (`MessagePresentation`, reply payloads,
> markdown IR, media runtime). **Render the SAME core content model in the browser where possible.**

---

## The web advantage (read before scoping)

Telegram fights constraints the browser doesn't have: 4096-char message cap, 1024-char caption cap,
64-byte `callback_data` cap, 16-level HTML nesting cap, `setMyCommands` budget, `parse_mode` HTML
dialect, flood-wait edit throttling. **In the browser we own the DOM**, so most P1 work is *simpler*
than Telegram's — real HTML, inline images, real event handlers. The value of the Telegram reference
is its **content model and plugin-sdk seams**, not its transport-specific limit-juggling. Port the
IR and the button/media *shapes*, not the chunking/nesting machinery.

**Where P1 renders now.** All client render lands in the reducer
(`packages/client/src/nats-client-wrapper.ts`) + the widget `render(state)`
(`demo/web/src/widget.ts:100-148`). New signals add a reducer `case`, a `WebChannelState` field
(`packages/client/src/types.ts:74-97`), and a `render` branch.

---

## P1-1 — Rich text / markdown rendering — 🔴 MISSING

**Symptom.** Agent replies render as raw plain text — code blocks, lists, links, bold, tables show
as literal markdown.

**Classification.** 🔴 Missing (client renders plain text; no server change needed — markdown is
already in the `agent_message` text).

**Where it stands today.**
- The agent's reply text is markdown (openclaw agents emit markdown); it arrives intact in
  `agent_message.text` and the reducer stores it verbatim (`nats-client-wrapper.ts:291`).
- **The widget renders it as a text node:** `demo/web/src/widget.ts:126-140` builds each bubble with
  `[m.text]` as a child (`white-space:pre-wrap`), so all markup is literal. `ChatMessage` only
  carries `text` (`types.ts:22-27`).

**Telegram reference (content model — NOT the transport limits).**
- `format.ts:158` `markdownToTelegramHtml()` / `:1132` `markdownToTelegramRichHtml()`.
- The reusable IR lives in **`openclaw/plugin-sdk/text-chunking`**: `markdownToIR()`,
  `renderMarkdownIRChunksWithinLimit()`, `findCodeRegions()`. Telegram wraps this in Telegram-HTML;
  we'd render the same IR to **real DOM**.
- `format.ts:733` `sanitizeTelegramRichHtml()` — the sanitize policy reference.
- Telegram's `rich-message.ts` nesting/entity-limit machinery is **transport-specific — skip it.**

**Implementation sketch.**
1. Pick a markdown renderer:
   - **Reuse core IR:** import `openclaw/plugin-sdk/text-chunking` `markdownToIR()`, walk the IR, emit
     DOM. Guarantees parity with other channels. **Preferred ONLY IF bundle feasibility is verified
     first** — ⚠️ the client package is deliberately openclaw-free and browser-safe (`openclaw` is
     the *plugin's* Node-side peer dep; see memory `openclaw-plugin-dependency`). This path adds
     `openclaw` as a *client-package* dependency and needs the transitive graph of `text-chunking`'s
     re-exports to be node-free and tree-shakeable — **unverified**. Do a 30-minute esbuild spike
     before committing; if it fails or bloats, fall back to the standalone lib.
   - **Standalone lib:** a small sanitizing markdown→HTML lib.
2. In `widget.ts`, replace the `[m.text]` text child with a `renderMarkdown(text)` producing
   sanitized HTML for `m.role !== "user"` bubbles (keep user bubbles plain).
3. **Sanitize.** Agent output is semi-trusted but may contain injected content from tools/web.
   Allowlist tags (`p, code, pre, strong, em, a, ul, ol, li, blockquote, table…`); strip `script`,
   event handlers, `javascript:` URLs.
4. Code blocks: monospace + copy button; syntax highlight is P1-optional.

**Acceptance.** Fenced code, inline code, bold/italic, links, lists, tables render as formatted HTML;
no raw `**`/backticks leak; no XSS from a crafted reply (`<img src=x onerror=alert(1)>` → inert).

**Note.** Unblocks P0-3 command output (`/help` is markdown) and P1-3 (reasoning blocks). Do it early.

---

## P1-2 — Long-response handling — 🟢 PARTIAL (polish)

**Symptom.** Very long replies produce one giant bubble; no "show more", no smart splitting.

**Classification.** 🟢 Partial. The web has no 4096 cap, so this is UX polish, not correctness.

**Where it stands today.** Single `agent_message` → single bubble (`widget.ts:126-140`). Functionally
fine; poor for very long outputs (giant scroll, no collapse).

**Telegram reference.** `draft-chunking.ts:9` `resolveTelegramDraftStreamingChunking()` delegates to
**`openclaw/plugin-sdk/channel-outbound` `resolveChannelDraftStreamingChunking()`**. Telegram must
chunk for the 4096 cap; **we don't need to for correctness.**

**Implementation sketch (all optional polish).**
1. Collapse over-long bubbles behind a "show more" past N lines.
2. If you *want* multi-bubble parity, respect `resolveChannelDraftStreamingChunking()` — but default
   to single-bubble for web.
3. Preserve scroll anchoring when a streaming bubble grows (ties into P0-5).

**Acceptance.** A 5000-word reply is readable (collapsible or smoothly scrollable), doesn't freeze
the layout, and streaming growth doesn't yank the viewport.

---

## P1-3 — Reasoning / thinking lane separation — 🔴 MISSING

**Symptom.** Model "thinking" (when present) is dumped inline with the answer or lost.

**Classification.** 🔴 Missing. Needs a server decision (emit reasoning separately) + client render
(collapsible lane).

**Where it stands today.** Our progress/answer path (`inbound.ts:109-269`) streams one draft; no
reasoning/answer split. The `progress` frame is a single text stream (reducer `case "progress"`,
`nats-client-wrapper.ts:279`).

**Telegram reference.**
- `reasoning-lane-coordinator.ts:68` `splitTelegramReasoningText()` — splits `{reasoningText,
  answerText}`.
- `:106` `createTelegramReasoningStepState()` — hinted→delivered state machine.
- `lane-delivery-text-deliverer.ts:131` `createLaneTextDeliverer()`.
- Reusable: **`openclaw/plugin-sdk/agent-runtime` `formatReasoningMessage()`**,
  **`openclaw/plugin-sdk/text-chunking` `stripReasoningTagsFromText()`**,
  **`openclaw/plugin-sdk/channel-outbound` `isPotentialTruncatedFinal()` / `selectLongerFinalText()`**.

**Implementation sketch.**
1. **Server:** add a `reasoning` boolean/kind to `progress` frames (or a new `reasoning` frame type
   in `nats-channel.ts`) when the turn produces reasoning; reuse `stripReasoningTagsFromText` +
   `formatReasoningMessage` so the split matches other channels.
2. **Client:** add a reducer `case` + a `WebChannelState` field; render reasoning in a collapsible
   `<details>` above the answer bubble (default collapsed); the answer streams/finalizes as in P0-5.
3. Handle truncation recovery with `selectLongerFinalText` semantics.

**Acceptance.** A reasoning-capable turn shows a collapsed "Thoughts" section that expands, with the
answer rendered separately and streaming normally. Non-reasoning turns show no empty affordance.

**Scope note.** Requires a small wire addition — heavier than the pure-render items. Sequence after
P1-1.

---

## P1-4 — Media attachments (images / files / voice) — 🔴 MISSING (mini-project)

**Symptom.** Text only. Users can't send images/files; the agent can't return them.

**Classification.** 🔴 Missing (no media path in wire, server-emit, or client).

**Where it stands today.** The E2E envelope carries a JSON text payload (`e2e-crypto.ts` /
`e2e-envelope.ts`); `nats-channel.ts` frames are text-only; the client has no upload/download.

**Telegram reference.**
- Outbound media: `telegram-media.runtime.ts:2-7` re-exports **`openclaw/plugin-sdk/media-runtime`**
  (`readRemoteMediaBuffer()`, `saveMediaBuffer()`, `saveRemoteMedia()`) — **the core runtime to reuse.**
- Inbound normalization: `prompt-media-path.ts:25` `resolveTelegramPromptMediaPath()` —
  `media://inbound/{id}` URIs with safe-id validation.
- Captions: `caption.ts` `TELEGRAM_MAX_CAPTION_LENGTH` (1024) — Telegram-specific; **web has no cap.**

**Decision (2026-07-02): object storage / blob endpoint.**
1. **Transport for bytes:** a separate authenticated **blob endpoint** — browser uploads
   E2E-encrypted bytes → gets a `media://` id → sends the id in the message. Mirrors Telegram's
   `media://inbound/{id}` indirection and keeps the relay lean. NATS-chunking rejected.
2. **Inbound (user → agent):** browser uploads, sends a message referencing the `media://` id; the
   agent resolves it via `media-runtime`, saves to the media store, and **injects it as a prompt
   attachment** (`inbound.ts` ctxPayload). Model capability gating + media-understanding
   (transcribe/describe for non-vision models) is inherited free from the shared turn path
   (`get-reply.ts:440`) — no error on text-only models, no media logic to build.
3. **Outbound (agent → user):** agent reply carries a `media://` id; client fetches + renders inline
   (image) or as a download (file).
4. **E2E:** media bytes must be encrypted too (the relay/blob store sees only ciphertext — the repo's
   core invariant). Encrypt the blob with the session key or a per-file key wrapped to the session.

**Acceptance.** A user can attach an image and the agent sees it; an agent image reply renders inline;
a file reply downloads. The relay/blob store never sees plaintext bytes.

**Scope note.** A **mini-project** (transport design + E2E for blobs + upload/download UI) — the
single biggest P1 lift. Consider splitting into its own tracking doc.

---

## P1-5 — Interactive buttons / quick replies — **MERGED INTO P0-4**

> **This gap has no standalone work.** Decided (2026-07-02): general interactive buttons and approval
> cards are ONE surface — an agent presents clickable controls, the user clicks, a decision/action
> flows back. They share a single client render component. The number `P1-5` is retained as a stable
> anchor; the substance lives in **`P0_CORE_CHAT_GAPS.md` → P0-4**.
>
> **Current state.** P0-4's approval renderer is **built** (`renderApproval` `widget.ts:74-98`) but
> is approval-specific. The P1-5 delta:
> 1. **Generalize the renderer** — refactor `renderApproval` into `renderControls(controls, onPick)`
>    over a normalized `[{ label, style, disabled?, kind:"decision"|"action"|"url", payload }]`.
>    Approval becomes the `kind:"decision"` case (no UI rework).
> 2. **Two wire frames on top of the same renderer:**
>    - `presentation { id, blocks: MessagePresentation }` (agent→browser) — carries the core
>      `openclaw/plugin-sdk/interactive-runtime` `MessagePresentation` verbatim.
>    - `button_action { id, action | value }` (browser→agent) — sibling of `approval_decision`.
> 3. **Server dispatch:** route `button_action` via `dispatchPluginInteractiveHandler`
>    (`interactive-dispatch.ts:72`); emit `presentation` when the agent reply contains an interactive
>    block. Approval frames stay separate (they carry `execApprovals.approvers` authz); only the
>    render component is shared.
>
> Telegram references: `button-types.ts:130` `buildTelegramPresentationButtons()`,
> `interactive-dispatch.ts:72`. Web sends real payloads — the 64-byte `callback_data` encoding is
> irrelevant.

---

## P1-6 — Doctor / self-diagnosis — 🔴 MISSING

**Symptom.** When misconfigured, failures are opaque (silent skips in logs); no user-facing "what's
wrong + how to fix".

**Classification.** 🔴 Missing (we have a setup *wizard* — `docs/SETUP_WIZARD_PLAN.md` — but no
*doctor* that validates an existing config / live connection).

**Where it stands today.** `packages/plugin/index-nats.ts` already *detects* many failure modes and
logs them (encryption misconfig skip, missing creds skip, connection failure skip, admission=auto +
open dmSecurity warning). **These are exactly the checks a doctor would surface — they're just log
lines.**

**Telegram reference.**
- `doctor.ts:604` `telegramDoctor` (a `ChannelDoctorAdapter`); scanners `doctor.ts:146-585`;
  auto-repair `:307/:371`.
- `probe.ts:122` `probeTelegram()` (live getMe/getWebhookInfo) → `TelegramProbe`.
- `status-issues.ts:208` `collectTelegramStatusIssues()`.
- **Reusable contract:** `openclaw/plugin-sdk/channel-contract` — `ChannelDoctorAdapter`,
  `ChannelStatusIssue`, `BaseProbeResult`. Register one and openclaw's `openclaw doctor` surfaces it.

**Implementation sketch.**
1. Implement a `ChannelDoctorAdapter` for webchannel (config scan): encryption policy resolvable?
   creds present per account? auth.strategy valid (not `anonymous`)? admission vs dmSecurity
   consistent? Factor the conditions `index-nats.ts` already branches on into pure check functions
   reused in both the doctor and the serving path.
2. Add a **live probe:** can the agent reach the relay? did the register route respond? (mirror
   `probeTelegram` with a NATS ping / SaaS `/health`).
3. A `ChannelStatusIssue` collector for runtime health.
4. Surface in the demo too: the demo admin panel (`demo/web/src/admin.ts`) could show doctor output.

**Acceptance.** `openclaw doctor` (or the demo status panel) reports actionable issues for a mis-set
account (missing creds, bad auth strategy, encryption off) with a fix hint, instead of a silent log
skip.

---

## P1-7 — Error handling / reconnect UX — ✅ MOSTLY BUILT

**Symptom (original).** On failures the demo showed minimal state; terminal errors (PoP/NKEY
rejection) were hard to distinguish from transient ones.

**Classification.** ✅ Mostly built by the integrated demo. Reconnect mechanics + connection-state UX
+ terminal-vs-transient classification are done; finer error-cause wording is the remaining polish.

**Where it stands today.**
- Reconnect backoff with jitter: `nats-client.ts` `scheduleReconnect` (capped exponential + full
  jitter).
- **Terminal vs transient classified:** `WebChannelNatsClient` treats PoP/NKEY registration failure
  as terminal (tears down, no retry) and distinguishes it from a transient
  "Authentication Expired" (`nats-client.ts:171-172`, `:427-430`, `:482`), surfacing via `onError`.
- **Wrapper maps it to state:** `nats-client-wrapper.ts:103-105` `onError` → `status:"error"` +
  `error` message; `onState` → `connected`/`reconnecting` (guards against a trailing `onState(false)`
  downgrading a terminal error, `:87-93`).
- **Widget renders distinct states:** a status pill (`connecting…`/`connected`/`reconnecting…`/
  `error`, `widget.ts:23-28,100-105`), and on `status==="error"` a distinct **"Credentials expired"**
  box with a one-click **Re-authenticate** button that mints a fresh credential
  (`widget.ts:109-119`); input/send disabled while terminal.
- `ConnectionStatus` union in the type (`types.ts:66`); `WebChannelState.error` carries the reason
  (`types.ts:81-93`).

**Telegram reference.**
- `network-errors.ts` — `isRecoverableTelegramNetworkError()` (`:305`), `readTelegramRetryAfterMs()`
  (`:235`), `isTelegramServerError()` (`:267`), `isSafeToRetrySendError()` (`:205`).
- Reusable: **`openclaw/plugin-sdk/error-runtime`** (`formatErrorMessage`, `extractErrorCode`) —
  classifier building blocks; **`openclaw/plugin-sdk/runtime-env`** (`computeBackoff`).

**Remaining polish (optional).**
1. **Finer cause wording** — distinguish "auth failed — reload to re-login" (terminal) vs "network
   blip — reconnecting" vs "rate-limited" using `error-runtime` helpers. The client already
   distinguishes terminal vs transient internally; thread a cause tag into the callback so the widget
   can label it more specifically than the current single "Credentials expired" copy.
2. **Send-while-down** — pairs with P0-7; at minimum disable the send button + show "reconnecting…"
   instead of silently dropping (the terminal case already disables send at `widget.ts:118-119`).

**Acceptance (mostly met).** A network blip shows "reconnecting…"; a credential rejection shows a
distinct terminal message with a recovery action (✅). Finer per-cause wording is the open slice.

---

## P1-8 — Turn control: `/stop` abort + inbound debounce/coalesce — 🔴 MISSING

**Symptom.** While the agent is streaming a long turn there is no way to stop it, and a follow-up
message can't be merged into the in-flight turn — each becomes its own serialized turn. Typing
`/stop` does **not** interrupt: it is queued *behind* the very turn it means to abort.

**Classification.** 🔴 Missing. The core abort **primitive exists** and our turns are abortable in
principle, but nothing on our side delivers the abort out-of-band, and there is no message
coalescing. This is a **Telegram parity gap** (Telegram has both).

**Where it stands today — why `/stop` is not "already there".**
- Every `user_message` is enqueued with **no content inspection**:
  ```js
  // packages/plugin/index-nats.ts:639-642
  channel.setMessageHandler((peerId, message) => {
    if (message.type !== "user_message") return;
    dispatchInbound(peerId, message);        // → per-session FIFO, unconditionally
  });
  ```
- The FIFO chains each turn off the previous (`inbound-queue.ts`
  `createSerializedInboundDispatcher`): `const settled = previous.then(() => handler(...))`. So a
  `/stop` sent mid-turn waits for the running turn to **finish** before it is processed → by then
  `abortReplyRunBySessionId` has nothing to abort → no-op.
- **The core primitive is present and reachable:** `abortReplyRunBySessionId(sessionId)`
  (`openclaw/src/auto-reply/reply/reply-run-registry.ts:745`); `/stop` is a core text command
  (`commands-registry.shared.ts:699`), and our turns register in the reply-run-registry because they
  run through `channelRuntime.inbound.run` (`inbound.ts:49`). The **only** missing piece is an
  out-of-band delivery path (a queue bypass) so the abort reaches core while the turn is still live.
- There is **no control-lane / abort fast-path anywhere in our plugin** (no `isAbortRequestText`, no
  bypass — verified). Telegram *builds* its own control lane; core does not hand us one for free.
- **No coalescing:** consecutive `user_message`s always become separate serialized turns; there is no
  debounce/batch step.

**Telegram reference (the model to adopt, adapted).**
- **Control lane / abort bypass:** `sequential-key.ts:73-74` — "`/stop@bot` still needs the control
  lane so it can cancel a busy turn"; abort vocabulary `abort-primitives.ts:72` `isAbortRequestText`
  (matches `/stop` + natural-language abort triggers).
- **Reply fence (interrupt semantics):** `telegram-reply-fence.ts:206`
  `shouldSupersedeTelegramReplyFence`. Note the **direct-chat default** (`:224-233`): a plain
  follow-up in a DM returns `false` = *non-interrupting = queued* — **the same behavior we already
  have.** Only authorized commands (`/stop`, explicit `/…`) supersede in DMs; plain messages
  supersede only in *group* chats (`:234`). So parity here is **not** "auto-interrupt on every
  message" — it is specifically the `/stop` control path + coalescing.
- **Debounce/coalesce:** `bot-handlers.debounce-key.ts` (`buildTelegramInboundDebounceKey`,
  `debounceLane`) — rapid same-sender/same-conversation messages are batched before the turn runs.

**Implementation sketch.**
1. **`/stop` abort (out-of-band).** In `channel.setMessageHandler` (`index-nats.ts:639`), **before**
   `dispatchInbound`, check `isAbortRequestText(message.text)` (import from
   `openclaw/plugin-sdk/reply-runtime`, re-exported from `command-primitives-runtime`). If true:
   resolve the session key (`channelRuntime.routing.resolveAgentRoute`, as `inbound.ts:125`) and call
   `abortReplyRunBySessionId(sessionKey)` **without enqueuing**. Optionally finalize the in-flight
   working draft via the existing `inbound.ts:260-269` path with a "⏹ stopped" text.
2. **Client "Stop" affordance.** In `demo/web/src/widget.ts`, while `state.isTyping` or a working
   draft exists, toggle the Send button to **Stop**; on click call a new
   `client.stop()` on the wrapper (`nats-client-wrapper.ts`) that sends a stop signal. **Wire
   choice:** either (a) send the literal `/stop` as a `user_message` (server detects it via step 1 —
   also makes *typed* `/stop` work) — recommended, no new frame; or (b) a dedicated
   `{ type:"cancel" }` outbound frame (`types.ts:153` union) handled identically before enqueue.
   Prefer (a) so typed `/stop` and the button share one path.
3. **Debounce/coalesce (server-side).** Give the queue a per-session **pending-input buffer**: while
   a turn runs, accumulate subsequent plain `user_message` texts; on turn completion, flush the
   buffer as **one** turn input (mirrors Telegram's debounce-before-run). This requires the queue to
   hold message *content* (today it holds an opaque promise chain) — the same buffer P1-9 Option B
   needs, so **build them together if going server-side.** A lighter alternative is a **client-side**
   debounce in the widget (hold rapid sends ~250–400ms, concat, then publish once).

**Acceptance.** Mid-stream, clicking **Stop** (or typing `/stop`) aborts the running turn within one
step and finalizes the draft as stopped — it does **not** wait for the turn to complete. Firing two
messages in quick succession produces **one** coalesced turn, not two serialized turns.

**Scope note.** The `/stop` half is **XS–S** (core primitive exists; only the pre-enqueue bypass +
button are new). The coalesce half is **S–M** (queue needs a content buffer). They are independent —
ship `/stop` first.

---

## P1-9 — Pending-message retraction ("unsend" a queued message) — 🟢 WEB ADVANTAGE (no Telegram equiv)

**Symptom.** You send a message while a turn is still running; it sits queued (`inbound-queue.ts`
FIFO) and is delivered to the agent only after the current turn finishes. There is no way to pull it
back before it runs.

**Classification.** 🟢 **Web advantage, not a parity gap.** Telegram has **no** equivalent — the
Telegram Bot API does not deliver message *deletions* to bots at all, and its `edited_message`
handler (`bot-handlers.runtime.ts:3469` → `recordEditedMessageForReplyChain`) only updates the
reply-chain cache; it never dequeues a pending turn. Because **we own the browser client**, we can
offer genuine retraction — a superset of Telegram. Distinct from P1-8: retraction targets a
**not-yet-started** queued message; aborting the **in-flight** turn is P1-8.

**Where it stands today.**
- The widget publishes immediately: `widget.ts:208-217` `submit()` → `client.send(text)` →
  `nats-client-wrapper.ts:131` → publishes over NATS at once. Nothing is held locally.
- Queueing happens **server-side** (`inbound-queue.ts` per-session FIFO). Once published, the message
  is committed to that chain and there is **no dequeue signal** (`types.ts:153` outbound union has
  only `user_message` / `approval_decision` / `load_history`).

**Telegram reference.** None — this affordance does not exist in Telegram (see Classification). This
item is scoped from our own transport, not benchmarked.

**Implementation sketch — two options.**
- **(A) Client-side hold (RECOMMENDED — zero wire/server change).** While `state.isTyping` or a
  working draft is active, the widget does **not** publish the next message; it holds it locally as a
  "pending" chip with an **✕ retract** control, and publishes it only when the prior turn finalizes
  (the `agent_message`/finalize in `nats-client-wrapper.ts:291`). Retract = delete the local chip. No
  server or wire change; the "queue" becomes visible and controllable in the client. Trade-off: "sent"
  now means "queued for send" — surface that in the chip label.
- **(B) Server-side dequeue.** Publish immediately (today's behavior), stamp each `user_message` with
  a stable id, add a `{ type:"retract", id }` outbound frame (`types.ts:153` union), and have the
  server remove the **not-yet-started** entry from the FIFO. Requires the queue to hold message
  content and be indexable by id — the **same buffer P1-8's coalesce needs**, so unify if going
  server-side. Only *pending* messages are removable; a message whose turn already started is P1-8
  (abort), not retraction.

**Acceptance.** Sending while a turn runs shows the new message as **pending** with a retract control;
retracting before the turn finishes means the agent never receives it; leaving it delivers it exactly
once when the turn completes.

**Recommendation.** Option A — it matches the UX the user already perceives (a visible pending queue),
costs no E2E/server work, and stays purely in `demo/web/src/widget.ts` + a small wrapper hold.

---

## Suggested execution order (P1 — remaining work)

| Order | Gap | Effort | Depends on |
|---|---|---|---|
| 1 | P1-8a `/stop` turn abort | XS–S | — (core `abortReplyRunBySessionId` exists; add pre-enqueue bypass + Stop button) |
| 2 | P1-9 pending-message retraction (unsend) | S | — (Option A: client hold, no server/wire change) |
| 3 | P1-1 markdown rendering | S–M | — (unblocks P0-3 output, P1-3) |
| 4 | P1-7 finer error wording | XS | — (mechanics + terminal UX already built) |
| — | ~~P1-5 interactive buttons~~ | — | **MERGED into P0-4** (delta = generalize renderer + 2 wire frames) |
| 5 | P1-8b inbound debounce/coalesce | S–M | queue content buffer (shared with P1-9 Option B) |
| 6 | P1-3 reasoning lane | M | P1-1, P0-5 |
| 7 | P1-6 doctor | M | — (factor existing `index-nats` checks) |
| 8 | P1-2 long-response polish | S | P1-1, P0-5 |
| 9 | P1-4 media | L (mini-project) | **DECIDED: object storage / blob endpoint** |

> ✅ **Already built by the integrated demo:** P1-7 (error/reconnect UX — status pill, terminal
> "Credentials expired" + re-auth, terminal-vs-transient classification). Remaining P1-7 = finer
> per-cause wording only.

**Resolved decisions (2026-07-02):**
- **P1-4 media → object storage (blob endpoint).** See P1-4 above.
- **P1-5 buttons → merged into P0-4** with the `presentation` + `button_action` delta; see P0-4.
