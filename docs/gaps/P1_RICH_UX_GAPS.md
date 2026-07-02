# P1 — Rich UX Gaps (WebChannel vs. Telegram)

> **Scope.** P1 = the gaps that separate a "works" chat from a "polished product": rich text
> rendering, long-message handling, reasoning/answer separation, media, interactive buttons,
> self-diagnosis (doctor), and reconnect/error UX. Assumes P0 (`P0_CORE_CHAT_GAPS.md`) is done —
> several P1 items build directly on P0 wiring. P2 (threads / reactions / spool / throttle /
> audit) is in `P2_ADVANCED_GAPS.md`.
>
> **Reference channel.** Telegram extension at `/Users/mircorn/workspace/openclaw/extensions/telegram/src/`.
> **openclaw core** (peer dep, sibling checkout): `/Users/mircorn/workspace/openclaw/src/`.
>
> **Classification.** 🔴 missing entirely · 🟡 server/wire exists, client doesn't render · 🟢 partial.
>
> **Big reuse theme.** Telegram builds almost none of this from scratch — it composes
> `openclaw/plugin-sdk/*` runtimes (all verified present in `openclaw/src/plugin-sdk/`). Web is a
> different *transport* but the same *content model* (`MessagePresentation`, reply payloads,
> markdown IR, media runtime). **Wherever possible, render the SAME core content model in the
> browser instead of inventing a web-only one.** Per-gap SDK anchors below.

---

## The web advantage (read before scoping)

Telegram fights constraints the browser simply doesn't have: 4096-char message cap, 1024-char
caption cap, 64-byte `callback_data` cap, 16-level HTML nesting cap, `setMyCommands` payload
budget, `parse_mode` HTML dialect, flood-wait edit throttling. **In the browser we own the DOM**,
so most P1 work is *simpler* than Telegram's — we render markdown to real HTML, show images
inline, and attach real event handlers to buttons. The value of the Telegram reference is its
**content model and its plugin-sdk seams**, not its transport-specific limit-juggling. Do not port
the chunking/nesting-limit machinery; port the IR and the button/media *shapes*.

---

## P1-1 — Rich text / markdown rendering

**Symptom.** Agent replies render as raw plain text — code blocks, lists, links, bold, tables all
show as literal markdown. `demo-app.html:427` does `d.textContent = text` (deliberately plain).

**Classification.** 🔴 Missing (client renders plain text; no server change needed — markdown is
already in the `agent_message` text).

**Where it stands today.**
- The agent's reply text is markdown (openclaw agents emit markdown). It arrives intact in
  `agent_message.text`.
- The demo renders it as `textContent` (`demo-app.html:425-431` `append()`), so all markup is
  literal. `client.ts` likewise only stores `text` (`types.ts:22-29`).

**Telegram reference (content model — NOT the transport limits).**
- `format.ts:158` `markdownToTelegramHtml()` and `format.ts:1132` `markdownToTelegramRichHtml()` —
  markdown → HTML with tables/spoilers/linkify/file-ref wrapping.
- The reusable IR lives in **`openclaw/plugin-sdk/text-chunking`**: `markdownToIR()`,
  `renderMarkdownIRChunksWithinLimit()`, `findCodeRegions()`, `isInsideCode()`. Telegram wraps
  this in Telegram-HTML; we'd render the same IR to **real DOM/HTML**.
- `format.ts:669` `wrapFileReferencesInHtml()` — wrap `foo.ts` in `<code>` to prevent
  auto-linkification (nice-to-have).
- Telegram's `rich-message.ts` nesting/entity-limit machinery (`:29-32`, `:414-427`) is
  **transport-specific — skip it.**

**Implementation sketch.**
1. Pick a markdown renderer. Two paths:
   - **Reuse core IR:** import `openclaw/plugin-sdk/text-chunking` `markdownToIR()`, walk the IR,
     emit DOM. Guarantees parity with how the agent "thinks" about its own output and with other
     channels. Preferred.
   - **Standalone lib:** a small sanitizing markdown→HTML lib (must sanitize — see below).
2. In `demo-app.html`, replace `d.textContent = text` with a `renderMarkdown(text)` that produces
   sanitized HTML. Keep `.msg.user` bubbles plain (user input isn't markdown).
3. **Sanitize.** The agent output is semi-trusted but may contain injected content from tools/web.
   Escape/sanitize HTML (allowlist tags: `p, code, pre, strong, em, a, ul, ol, li, blockquote,
   table…`; strip `script`, event handlers, `javascript:` URLs). `format.ts:733`
   `sanitizeTelegramRichHtml()` is the reference policy.
4. Code blocks: monospace + copy button; syntax highlight is P1-optional.

**Acceptance.** Fenced code blocks, inline code, bold/italic, links, lists, and tables render as
formatted HTML; no raw `**` / backticks leak; no XSS from a crafted reply (test with
`<img src=x onerror=alert(1)>` in agent text → renders inert).

**Note.** This unblocks P0-3 (command output like `/help` is markdown) and P1-3 (reasoning
blocks). Do it early in P1.

---

## P1-2 — Long-response handling

**Symptom.** Very long replies produce one giant bubble; no "show more", no smart splitting.

**Classification.** 🟢 Partial. The web has no 4096 cap, so this is a UX polish item, not a
correctness one.

**Where it stands today.** Single `agent_message` → single bubble. Fine functionally; poor for
very long outputs (giant scroll, no collapse).

**Telegram reference.** `draft-chunking.ts:9` `resolveTelegramDraftStreamingChunking()` delegates
to **`openclaw/plugin-sdk/channel-outbound` `resolveChannelDraftStreamingChunking()`** — a shared
chunk-limit resolver. Telegram must chunk to obey the 4096 cap; **we don't need to chunk for
correctness.**

**Implementation sketch (all optional polish).**
1. Collapse over-long bubbles behind a "show more" past N lines.
2. If you *want* multi-bubble parity with other channels, respect
   `channel-outbound.resolveChannelDraftStreamingChunking()` so a config-set chunk size behaves
   consistently — but default to single-bubble for web.
3. Preserve scroll anchoring when a streaming bubble grows (ties into P0-5).

**Acceptance.** A 5000-word reply is readable (collapsible or smoothly scrollable), doesn't freeze
the layout, and streaming growth doesn't yank the viewport.

---

## P1-3 — Reasoning / thinking lane separation

**Symptom.** Model "thinking" (when present) is either dumped inline with the answer or lost.

**Classification.** 🔴 Missing. Needs both a server decision (emit reasoning separately) and client
render (collapsible lane).

**Where it stands today.** Our progress/answer path (`inbound.ts:109-269`) streams one draft; there
is no reasoning/answer split. The `progress` frame is a single text stream.

**Telegram reference.**
- `reasoning-lane-coordinator.ts:68` `splitTelegramReasoningText()` — splits `{reasoningText,
  answerText}` (detects `Thinking…`, `Reasoning:`, `<think>` tags).
- `reasoning-lane-coordinator.ts:106` `createTelegramReasoningStepState()` — hinted→delivered
  state machine; buffers the final answer while reasoning streams.
- `lane-delivery-text-deliverer.ts:131` `createLaneTextDeliverer()` — delivers reasoning
  (collapsible) first, then the answer, tracking per-lane streaming state.
- Reusable pieces: **`openclaw/plugin-sdk/agent-runtime` `formatReasoningMessage()`**,
  **`openclaw/plugin-sdk/text-chunking` `stripReasoningTagsFromText()` / `findCodeRegions()`**,
  **`openclaw/plugin-sdk/channel-outbound` `isPotentialTruncatedFinal()` / `selectLongerFinalText()`**.

**Implementation sketch.**
1. **Server:** decide whether webchannel emits reasoning as a distinct signal. Cheapest: add a
   `reasoning` boolean/kind to `progress` frames (or a new `reasoning` frame type in
   `nats-channel.ts`) when the turn produces reasoning. Reuse `stripReasoningTagsFromText` +
   `formatReasoningMessage` so the split matches other channels.
2. **Client:** render reasoning in a collapsible `<details>` above the answer bubble; default
   collapsed; the answer bubble streams/finalizes as in P0-5.
3. Handle truncation recovery with `selectLongerFinalText` semantics (final replaces reasoning-era
   partials).

**Acceptance.** A reasoning-capable turn shows a collapsed "Thoughts" section that can be expanded,
with the answer rendered separately and streaming normally. Non-reasoning turns show no empty
reasoning affordance.

**Scope note.** Requires a small wire addition — heavier than the pure-render P1 items. Sequence
after P1-1.

---

## P1-4 — Media attachments (images / files / voice)

**Symptom.** Text only. Users can't send images/files; the agent can't return images/files.

**Classification.** 🔴 Missing (no media path in wire, server-emit, or client).

**Where it stands today.** The E2E envelope carries a JSON text payload
(`e2e-crypto.ts` / `e2e-envelope.ts`); there's no media affordance. `nats-channel.ts` frames are
text-only. The client has no upload/download.

**Telegram reference.**
- Outbound media params: `telegram-media.runtime.ts:2-7` re-exports
  **`openclaw/plugin-sdk/media-runtime`**: `readRemoteMediaBuffer()`, `saveMediaBuffer()`,
  `saveRemoteMedia()`, `MediaFetchError` — **the core media runtime we should reuse.**
- Inbound path normalization: `prompt-media-path.ts:25` `resolveTelegramPromptMediaPath()` —
  `media://inbound/{id}` URIs with safe-id validation.
- Dedup: `bot-message-dispatch.media-dedup.ts:2` `deduplicateBlockSentMedia()`.
- Captions: `caption.ts:2` `TELEGRAM_MAX_CAPTION_LENGTH` (1024) / `caption.ts:4`
  `splitTelegramCaption()` — Telegram-specific limit; **web has no caption cap.**

**Implementation sketch (largest P1 item — scope carefully).**
1. **Decide the transport for bytes.** NATS envelopes are small JSON; large media over NATS is a
   bad fit. Options: (a) media stays E2E-encrypted but chunked over NATS; (b) a separate
   authenticated blob endpoint (upload → get `media://` id → send the id in the message). Option
   (b) mirrors telegram's `media://inbound/{id}` indirection and keeps the relay lean. **Requires a
   design decision — flag to the user.**
2. **Inbound (user → agent):** browser uploads to the blob endpoint, sends a message referencing
   the `media://` id; the agent resolves it via `media-runtime` for the model.
3. **Outbound (agent → user):** agent reply carries a `media://` id; client fetches + renders
   inline (image) or as a download (file).
4. **E2E:** media bytes must be encrypted too (the relay must only see ciphertext — the repo's
   core invariant, see `index-nats.ts:524-538`). Encrypt the blob with the session key or a
   per-file key wrapped to the session.

**Acceptance.** A user can attach an image and the agent sees it; an agent image reply renders
inline; a file reply downloads. The relay/blob store never sees plaintext bytes.

**Scope note.** This is a **mini-project** (transport design + E2E for blobs + upload/download UI).
Consider splitting into its own tracking doc. It is the single biggest P1 lift.

---

## P1-5 — Interactive buttons / quick replies — **MERGED INTO P0-4**

> **This gap has no standalone work.** Decided (2026-07-02): general interactive buttons and
> approval cards are ONE surface — an agent presents clickable controls, the user clicks, a
> decision/action flows back. They share a single client render component. The number `P1-5` is
> retained only as a stable anchor (so P1-6/P1-7 references don't shift); the substance now lives
> in **`P0_CORE_CHAT_GAPS.md` → P0-4**, which is built as a generic control renderer from day one.
>
> **Delta beyond P0-4** (the only P1-5-specific work): P0-4 renders approval cards via
> `approval_request`/`approval_decision`. General buttons add TWO wire frames on top of the same
> renderer:
> - `presentation { id, blocks: MessagePresentation }` (agent→browser) — carries the core
>   `openclaw/plugin-sdk/interactive-runtime` `MessagePresentation` verbatim.
> - `button_action { id, action | value }` (browser→agent) — sibling of `approval_decision`.
>
> Server dispatch: route `button_action` via `dispatchPluginInteractiveHandler` (same seam
> telegram uses — `interactive-dispatch.ts:72`); emit `presentation` when the agent reply contains
> an interactive block (`isMessagePresentationInteractiveBlock`). Approval frames stay separate
> (they carry `execApprovals.approvers` authz semantics); only the render component is shared.
> Telegram references retained for the merged work: `button-types.ts:130`
> `buildTelegramPresentationButtons()`, `interactive-dispatch.ts:72`. Web sends real payloads — the
> telegram 64-byte `callback_data` encoding (`native-command-callback-data.ts`) is irrelevant.

---

## P1-6 — Doctor / self-diagnosis

**Symptom.** When the demo/connection is misconfigured, failures are opaque (silent skips in
`index-nats.ts` logs); no user-facing "what's wrong + how to fix".

**Classification.** 🔴 Missing (we have a setup *wizard* — `docs/SETUP_WIZARD_PLAN.md` — but no
*doctor* that validates an existing config / live connection).

**Where it stands today.** `index-nats.ts` already *detects* many failure modes and logs them:
encryption misconfig skip (`:524-538`), missing creds skip (`:555-564`), connection failure skip
(`:574-580`), admission=auto + open dmSecurity warning (`:625-629`). **These are exactly the checks
a doctor would surface — they're just log lines, not a structured report.**

**Telegram reference.**
- `doctor.ts:604` `telegramDoctor` (a `ChannelDoctorAdapter`); scanners `doctor.ts:146-585`
  (malformed groups, invalid allowFrom, bad API roots, empty allowlists); auto-repair
  `doctor.ts:307/371`.
- `doctor-contract.ts:155` `legacyConfigRules` / `:199` `normalizeCompatibilityConfig()`.
- `probe.ts:122` `probeTelegram()` (live getMe/getWebhookInfo) → `TelegramProbe` (`:15`).
- `status-issues.ts:208` `collectTelegramStatusIssues()` (runtime health).
- **Reusable contract:** `openclaw/plugin-sdk/channel-contract` — `ChannelDoctorAdapter`,
  `ChannelStatusIssue`, `BaseProbeResult`, `ChannelAccountSnapshot`. Register a
  `ChannelDoctorAdapter` and openclaw's `openclaw doctor` surfaces it.

**Implementation sketch.**
1. Implement a `ChannelDoctorAdapter` for webchannel (config scan): encryption policy resolvable?
   creds present per account? auth.strategy valid (not `anonymous`)? admission vs dmSecurity
   consistent? These are the same conditions `index-nats.ts` already branches on — factor them
   into pure check functions and reuse in both the doctor and the serving path.
2. Add a **live probe**: can the agent reach the relay? did the register route respond? (mirror
   `probeTelegram`'s getMe with a NATS ping / SaaS `/health`).
3. A `ChannelStatusIssue` collector for runtime health (agent not subscribed, handshake failing).
4. Surface in the demo too: the demo's `/demo/status` (`demo-app.html:497`) could show doctor
   output.

**Acceptance.** `openclaw doctor` (or the demo status panel) reports actionable issues for a
mis-set webchannel account (missing creds, bad auth strategy, encryption off) with a fix hint,
instead of a silent skip in the logs.

---

## P1-7 — Error handling / reconnect UX

**Symptom.** On failures the demo shows minimal state; reconnect backoff isn't explained; some
terminal errors (PoP/NKEY rejection) are hard to distinguish from transient ones.

**Classification.** 🟢 Partial. The client has solid reconnect *mechanics*; the UX and error
*classification* are thin.

**Where it stands today.**
- Reconnect backoff with jitter exists: `nats-client.ts:415-430` (`scheduleReconnect`, capped
  exponential + full jitter); `client.ts:235-251` on the WS path.
- Terminal vs transient: `WebChannelNatsClient` treats PoP/NKEY registration failure as **terminal**
  (tears down, no retry) and surfaces via `onError` (`nats-client.ts:618-648`) — good. But the
  demo only shows a generic error bubble (`demo-app.html:446-450`).
- No classification of *why* (network vs auth vs server), no "reconnecting in Ns" affordance, no
  distinction between "retrying" and "gave up — re-auth needed".

**Telegram reference.**
- `network-errors.ts` — rich classification: `isRecoverableTelegramNetworkError()` (`:305`),
  `readTelegramRetryAfterMs()` (`:235`), `isTelegramServerError()` (`:267`),
  `isTelegramRateLimitError()` (`:271`), `isSafeToRetrySendError()` (`:205`, pre-connect codes only
  → safe to retry non-idempotent sends). Errors tagged with context via `tagTelegramNetworkError()`
  (`:164`).
- `monitor.ts:33` `createTelegramRunnerOptions()` / `:111` `monitorTelegramProvider()` — restart
  loop with backoff + token-rotation handling.
- Reusable: **`openclaw/plugin-sdk/error-runtime`** (`formatErrorMessage`, `extractErrorCode`,
  `readErrorName`, `collectErrorGraphCandidates`) — the classifier building blocks.
- `openclaw/plugin-sdk/runtime-env` (`computeBackoff`, `sleepWithAbort`) — backoff primitives.

**Implementation sketch.**
1. **Client UX:** show connection state distinctly — `connecting` / `connected` / `reconnecting
   (attempt N)` / `disconnected — action needed`. `client.ts` already has a `ConnectionStatus`
   union (`types.ts:58`) with `reconnecting`; surface it in `demo-app.html` (the status dot
   `#dot`/`#statusText` already exist).
2. **Classify errors** with `error-runtime` helpers so the UI can say "auth failed — reload to
   re-login" (terminal) vs "network blip — reconnecting" (transient). The NATS client already
   distinguishes these internally (`onError` = terminal); thread that into the callback so the demo
   can render it.
3. **Send-while-down:** currently dropped (`client.ts:125`); pairs with P0-7. At minimum, disable
   the send button + show "reconnecting…" instead of silently dropping.

**Acceptance.** A network blip shows "reconnecting…"; a credential rejection shows a distinct
terminal message with a recovery action; sending while disconnected doesn't silently vanish.

---

## Suggested execution order (P1)

| Order | Gap | Effort | Depends on |
|---|---|---|---|
| 1 | P1-1 markdown rendering | S–M | — (unblocks P0-3 output, P1-3) |
| 2 | P1-7 error/reconnect UX | S | — (small, high-clarity win) |
| — | ~~P1-5 interactive buttons~~ | — | **MERGED into P0-4** (delta = 2 wire frames on the shared renderer) |
| 3 | P1-3 reasoning lane | M | P1-1, P0-5 |
| 4 | P1-6 doctor | M | — (factor existing `index-nats` checks) |
| 5 | P1-2 long-response polish | S | P1-1, P0-5 |
| 6 | P1-4 media | L (mini-project) | **DECIDED: object storage / blob endpoint** |

**Resolved decisions (2026-07-02):**
- **P1-4 media → object storage (blob endpoint).** Browser uploads E2E-encrypted bytes to a
  gateway blob endpoint → `media://` id in the message → agent decrypts, saves to media store,
  **injects as a prompt attachment** (`inbound.ts` ctxPayload). Model capability gating +
  media-understanding (transcribe/describe for non-vision models) is inherited free from the
  shared turn path (`get-reply.ts:440`) — no error on text-only models, no media logic to build.
  NATS-chunking rejected (telegram itself uses an out-of-band blob store + reference-in-message).
- **P1-5 buttons → merged into P0-4** with the `presentation` + `button_action` delta; see P0-4.
