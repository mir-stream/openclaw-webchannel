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
> **⚠️ Re-anchored 2026-07-03; re-verified 2026-07-13 (post-#24…#33 tree).** The integrated showcase
> demo rewrote the demo surface (now `demo/web/src/widget.ts` over the `WebChannelNATSClient` reducer),
> and the parity stack has since landed several P1 items. **Now built:** **P1-1 markdown (#27)**,
> **P1-7 error/reconnect UX** (mostly), and **P1-8** (`/stop` control lane #25 + debounce/coalesce
> #29) — all marked ✅. **Still open:** P1-2 long-response, P1-3 reasoning lane (now **unblocked** —
> its deps P1-1 + P0-5 partial are met), P1-4 media, P1-6 doctor, P1-7 finer wording, P1-9 unsend.
> Note (#14): the plugin has a partial-mode answer-text stream (`streaming.mode:"partial"`, exercised
> in the demo) — P1-3's reasoning lane builds on that existing stream, not a net-new one.
>
> **⚠️ Line numbers drift.** The demo is still being built, so `file:line` anchors are approximate
> and keep moving — trust the file + symbol name and search if a line has shifted. Not re-anchored
> per demo change.
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
(`demo/web/src/widget.ts`). New signals add a reducer `case`, a `WebChannelState` field
(`packages/client/src/types.ts:123-165`), and a `render` branch.

---

## P1-1 — Rich text / markdown rendering — ✅ BUILT

**Symptom (original).** Agent replies rendered as raw plain text — code blocks, lists, links, bold,
tables showed as literal markdown.

**Classification.** ✅ Built (#27). Agent bubbles render sanitized markdown DOM; user bubbles stay
plain text. No server change (markdown was already in the `agent_message` text).

**Where it stands today.**
- New module `demo/web/src/markdown.ts` (543 lines): `renderMarkdown(text)` walks a block tree into
  real elements. Rendered at `widget.ts:201` `renderMarkdown(m.text)` for **agent bubbles only** —
  user bubbles stay plain text (`:197-198`). Supports headings, fenced code with a copy button,
  lists, tables, blockquotes, hr, inline marks, and links.
- **Sanitize-by-construction:** the module builds text nodes and elements only, **never `innerHTML`**
  (`markdown.ts:11`). `isSafeUrl` (`:52`) allows only `http`/`https`/`mailto`; relative, `//`,
  `javascript:`, and `data:` URLs fall back to plain text; images are never rendered as media.
- **Bounds:** a 20k-char parse cap (`MARKDOWN_RENDER_MAX_CHARS`, `:514`, `renderMarkdown` `:528-532`)
  guards the O(n²) inline scan and falls back to plain text past it; a per-bubble memo cache
  (`widget.ts:110`, `mdCache`) avoids re-parsing on every render pass.

> **Decision record — core-IR path REJECTED; hand-rolled zero-dep won.** The sketch preferred reusing
> `openclaw/plugin-sdk/text-chunking` `markdownToIR()` *if bundle-feasible*. It is **not**: that
> module's transitive graph pulls `node:module` / `createRequire` and won't browser-bundle
> (`markdown.ts:13-16` header). Rather than pull in a third-party markdown lib as the anticipated
> fallback, the implementation is a **standalone hand-rolled zero-dependency** parser/renderer — no
> `openclaw` dependency added to the deliberately-Node-free client/demo bundle (see memory
> `openclaw-plugin-dependency`).

**Telegram reference (content model — NOT the transport limits).** `format.ts:158`
`markdownToTelegramHtml()`; the IR in `openclaw/plugin-sdk/text-chunking`; sanitize policy
`format.ts:733` `sanitizeTelegramRichHtml()`. Telegram's `rich-message.ts` nesting/entity-limit
machinery is transport-specific — correctly skipped.

**Acceptance (met).** Fenced code, inline code, bold/italic, links, lists, tables render as formatted
HTML; no raw `**`/backticks leak; a crafted reply (`<img src=x onerror=alert(1)>`) is inert (text
nodes only, no `innerHTML`).

**Note.** Unblocks P0-3 command output (`/help` is markdown) and P1-3 (reasoning blocks).

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

**Classification.** 🔴 Missing — but **now unblocked.** Its dependencies (P1-1 markdown ✅ and P0-5
partial ✅, exercised in the demo) are met, so this is the top remaining P1 lift. Needs a server
decision (emit reasoning separately) + client render (collapsible lane).

**Where it stands today.** The plugin already streams **answer text** in `"partial"` mode
(`inbound.ts:124-136`, `onPartialReply` → `draft.pushAnswerText`) — exercised in the demo since P0-5
set `streaming.mode:"partial"` — but there is still **no reasoning/answer split**: reasoning is not
separated from the answer stream. Both `partial` (answer) and `progress` (tool lines) share the
single `progress` frame and one working draft (reducer `case "progress"`, `nats-client-wrapper.ts:557`).
A reasoning lane builds **on top of** that existing partial stream (a separate reasoning frame/field
feeding a collapsible lane), not a new stream from scratch.

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
  `Authentication Timeout` / `Permissions Violation` via the `-ERR` classifier at
  `nats-client.ts:588-596`: `authorization violation` / `authentication expired` → terminal
  `failTerminally`, while timeout/cancelled/permissions stay transient. Surfaces via `onError`.
- **Wrapper maps it to state:** `onError` → `status:"error"` + `error` message; `onState` →
  `connected`/`reconnecting` (guards against a trailing `onState(false)` downgrading a terminal
  error).
- **Widget renders distinct states:** a status pill (`connecting…`/`connected`/`reconnecting…`/
  `error`), and on `status==="error"` a distinct **"Credentials expired"** heading (`widget.ts:163`)
  with a one-click **Re-authenticate** button that mints a fresh credential; input/send disabled
  while terminal.
- `ConnectionStatus` union in the type (`types.ts:115`); `WebChannelState.error` carries the reason.

**Telegram reference.**
- `network-errors.ts` — `isRecoverableTelegramNetworkError()` (`:305`), `readTelegramRetryAfterMs()`
  (`:235`), `isTelegramServerError()` (`:267`), `isSafeToRetrySendError()` (`:205`).
- Reusable: **`openclaw/plugin-sdk/error-runtime`** (`formatErrorMessage`, `extractErrorCode`) —
  classifier building blocks; **`openclaw/plugin-sdk/runtime-env`** (`computeBackoff`).

**Remaining polish (still open).**
1. **Finer cause wording** — `ErrorListener = (err: Error)` carries **no cause tag**
   (`nats-client.ts:222`), the classifier lumps `authorization violation` + `authentication expired`
   into one terminal message (`:588-596`), and the widget shows a single hardcoded "Credentials
   expired" heading (`widget.ts:163`). Thread a cause tag into the callback so the widget can
   distinguish "auth failed — reload to re-login" vs "network blip — reconnecting" vs "rate-limited"
   using `error-runtime` helpers. This is the open P1-7 slice.
2. **Send-while-down** — now covered by P0-7 (client replay ledger re-sends on reconnect); the
   terminal case already disables send in the error-box render.

**Acceptance (mostly met).** A network blip shows "reconnecting…"; a credential rejection shows a
distinct terminal message with a recovery action (✅). Finer per-cause wording is the open slice.

---

## P1-8 — Turn control: `/stop` abort + inbound debounce/coalesce — ✅ BUILT (both halves)

**Symptom (original).** While the agent streamed a long turn there was no way to stop it, and a
follow-up message couldn't be merged into the in-flight turn. Typing `/stop` did **not** interrupt —
it queued *behind* the very turn it meant to abort.

**Classification.** ✅ Built — the `/stop` control lane (P1-8a, #25) and the two-layer
debounce/coalesce (P1-8b, #29). Both close a Telegram parity gap.

### P1-8a — `/stop` abort (control lane)

- **Pre-enqueue control lane.** `src/control-lane.ts` `isControlLaneMessage()` is checked in
  `setMessageHandler` **before** the debouncer/FIFO (`index-nats.ts:724-822`); a matching frame is
  dispatched fire-and-forget as a control-lane turn `handleInboundMessage(..., {controlLane:true})`
  (`:788-799`), so core's `tryFastAbortFromMessage` runs while the turn is still live (core runs it
  before its per-session busy gate, so it never collides with the one-turn-per-session FIFO
  invariant).
- **Abort vocabulary.** `isControlLaneMessage` matches `isAbortRequestText`
  (`openclaw/plugin-sdk/command-primitives-runtime`) = `/stop` **plus** the natural-language abort
  vocabulary ("stop", "abort", "wait", …). The full vocabulary all aborts, for core/Telegram parity.
- **Control-lane turns** stamp `access.commands.authorized:true` (`inbound.ts:215-223`), hedged
  through `commandGate` (`index-nats.ts:814-820` / `src/command-gate.ts` — the allowlist trap: core
  ignores our stamp when a commands/owner allowlist is configured); they run **draftless** and skip
  typing (`inbound.ts:136,183`). A started working draft is finalized when the run resolves without a
  final delivery (`inbound.ts` on-settle path); core's own `/stop` turn delivers "⚙️ Agent was
  aborted."
- **Client Stop button.** `widget.ts:182-186` flips the primary button to **Stop** while `isTyping ||
  any m.working`; clicking it sends the literal `/stop` as a `user_message` (`:381-386`), so the
  typed command and the button share one path.

> **Decision record — /stop wire choice (a), and explicit-`/stop`-only buffer drop.**
> - **Wire choice (a)** (send the literal `/stop` as a `user_message`, server detects it) was chosen
>   over (b) a dedicated `{type:"cancel"}` frame — no new frame, and typed `/stop` and the button
>   share the same path (`control-lane.ts` header).
> - **Explicit-`/stop`-only buffer drop.** The *destructive* buffer drop (`inboundDebouncer.cancelKey`
>   + `inboundDispatcher.clearPending`, `index-nats.ts:773-781`) is gated by `isExplicitAbortCommand`
>   (`text === "/stop"` only, `control-lane.ts:56-61`), **not** the broader `isControlLaneMessage`.
>   Rationale: the NL vocabulary ("wait", "stop please") must still ABORT the running turn but must
>   NOT destroy a user's queued follow-up — a false-positive there should cost at most a spurious
>   abort, never a lost message. The drop is further gated by `shouldDropBufferedInputOnStop` (`:97`)
>   = `!gate.delegated || gate.isListed(peerId)`, biased toward NOT dropping when the abort may be a
>   no-op (allowlist trap), so a peer whose turn keeps running never loses buffered input.

### P1-8b — debounce / coalesce (two layers)

- **(a) Pre-run debounce** reuses core's `createInboundDebouncer` (`index-nats.ts:659-713`), sitting
  IN FRONT of the FIFO. Window from **global** core config
  `messages.inbound.byChannel.webchannel ?? messages.inbound.debounceMs ?? 0` via
  `resolveInboundDebounceMs` (default `0` = inert). ⚠️ This is a **top-level core key**, NOT under
  `channels.webchannel` — the demo sets `"messages":{"inbound":{"byChannel":{"webchannel":300}}}`
  (`run.sh:268`).
- **(b) Busy-time coalesce** is always-on in `src/inbound-queue.ts`: a message arriving while a
  session turn RUNS buffers in `pending`, and on settlement the buffer merges into ONE follow-up turn
  (`startCoalesceTurn`, `coalesceUserMessages` joins texts with `"\n\n"`). Introspection
  `pendingBuffered` / `clearPending` (the latter used by `/stop`'s buffer drop).

**Telegram reference (the model adopted, adapted).** Control lane `sequential-key.ts:73-74`; abort
vocabulary `abort-primitives.ts:72` `isAbortRequestText`; reply-fence direct-chat default
`telegram-reply-fence.ts:224-233` (a plain DM follow-up is non-interrupting = queued — same as us);
debounce `bot-handlers.debounce-key.ts`.

**Acceptance (met).** Mid-stream, clicking Stop (or typing `/stop`) aborts the running turn within one
step and finalizes the draft as stopped — it does not wait for the turn to complete. Two messages in
quick succession produce **one** coalesced turn.

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

**Where it stands today (nothing built — sends go straight through).**
- The widget publishes immediately: `submit()` → `client.send(text)` → the wrapper publishes over
  NATS at once. Nothing is held locally; there is no pending chip and no retract control.
- Queueing happens **server-side** (`inbound-queue.ts` per-session FIFO / the P1-8b coalesce buffer).
  The outbound union has no `retract` frame (`user_message` / `approval_decision` / `load_history` /
  `load_commands` only), so once published a message is committed to the chain.
- **Note:** P1-8b already gave the queue a content buffer (`src/inbound-queue.ts` `pending` +
  `clearPending`) — the same server-side buffer Option B below needs. So Option B's prerequisite now
  exists; only the `retract` frame + a by-id dequeue would be net-new.

**Telegram reference.** None — this affordance does not exist in Telegram (see Classification). This
item is scoped from our own transport, not benchmarked.

**Implementation sketch — two options.**
- **(A) Client-side hold (RECOMMENDED — zero wire/server change).** While `state.isTyping` or a
  working draft is active, the widget does **not** publish the next message; it holds it locally as a
  "pending" chip with an **✕ retract** control, and publishes it only when the prior turn finalizes
  (the `agent_message`/finalize in `nats-client-wrapper.ts:383`). Retract = delete the local chip. No
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
| 1 | P1-3 reasoning lane | M | P1-1 ✅ + P0-5 ✅ **now met — unblocked, top lift** |
| 2 | P1-9 pending-message retraction (unsend) | S | — (Option A: client hold, no server/wire change) |
| 3 | P1-7 finer error wording | XS | — (mechanics + terminal UX already built; thread a cause tag) |
| 4 | P0-3 argument menus | S | — (catalog entries already carry `args.choices`; render dropdowns) |
| 5 | P1-2 long-response polish | S | P1-1 ✅ |
| 6 | P1-6 doctor | M | — (factor existing `index-nats` checks into a `ChannelDoctorAdapter`) |
| 7 | P1-4 media | L (mini-project) | **DECIDED: object storage / blob endpoint** |
| — | ~~P1-5 interactive buttons~~ | — | **MERGED into P0-4** (delta = generalize renderer + 2 wire frames) |

> ✅ **Already built:** P1-1 (markdown, #27), P1-7 (error/reconnect UX — status pill, terminal
> "Credentials expired" + re-auth, terminal-vs-transient classification; finer per-cause wording is
> the only remaining slice), P1-8a (`/stop` control lane, #25), P1-8b (debounce/coalesce, #29).

**Resolved decisions (2026-07-02):**
- **P1-4 media → object storage (blob endpoint).** See P1-4 above.
- **P1-5 buttons → merged into P0-4** with the `presentation` + `button_action` delta; see P0-4.
