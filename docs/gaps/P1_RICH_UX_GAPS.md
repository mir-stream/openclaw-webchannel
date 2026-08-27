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
> **P1-7 error/reconnect UX** (incl. finer cause-driven wording), and **P1-8** (`/stop` control lane
> #25 + debounce/coalesce #29), P1-3 reasoning lane, and **P1-9 unsend** (Option A client-side hold)
> — all marked ✅. **Still open:** P1-2 long-response and P1-4 media.
> P1-6 doctor is built on `feat/p1-6-doctor` and awaiting merge (#39) — see its section.
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

## P1-3 — Reasoning / thinking lane separation — ✅ BUILT

**Symptom.** Model "thinking" (when present) is dumped inline with the answer or lost.

**Classification.** ✅ Built. OpenClaw live callbacks and durable reasoning payloads now travel on a dedicated,
turn-correlated frame and render as collapsed `Reasoning` details independently of the answer
streaming mode. Reasoning streams to the browser ONLY when this channel's own
`capabilities.reasoning` is not switched off (default ON, #113) — a channel-private key, deliberately
NOT `agents.*.reasoningDefault`, which core co-parses and invalidates for our unauthorized browser
peers — and no persisted explicit session `/reasoning off` veto exists.

**Where it stands today.** `inbound.ts` resolves `capabilities.reasoning` (`resolveReasoningEnabled`,
`account-config.ts`; absent → ON, any present non-boolean-`true` value or malformed capabilities
container → OFF, merged channel base under account override), then preserves a persisted explicit
session `/reasoning off` as a narrow privacy veto without consulting `agents.*.reasoningDefault`.
The veto reads and validates one raw session-store snapshot (`ENOENT` alone means
empty; other read/parse/store-entry-shape failures close the lane) before pinned core's
`resolveSessionStoreEntry` resolves its target/aliases from that same snapshot.
It wires `onReasoningStream` /
`onReasoningEnd` ONLY when it is on — in every answer mode
(`partial` / `progress` / `block` / `off`), while preserving existing mode-specific answer/tool
callbacks — together with `streamReasoningInNonStreamModes: true` for live snapshots and
`reasoningPayloadsEnabled: true` for core's durable `isReasoning` form. The delivery seam intercepts
the latter before ordinary answer/draft handling and emits each complete durable
block at full length under a distinct id, outside the live stale-prefix state.
Pinned CLI also prepends its last live snapshot as a durable payload without an
end callback; only that exact replay while the matching live burst is still open
and its live send succeeded is suppressed. A rejected live send retains the
durable fallback. Equal or shared-prefix independent durable blocks remain distinct.
`ReasoningDraftController` normalizes live cumulative/snapshot updates by REPLACE
(verified: no pinned emitter sends a bare delta) and rotates live bursts. An opened lane that ends its turn having
received no payload logs one warning per account per process — suppressed on abort, terminal failure, and turns that
delivered no answer, so it only fires where zero frames is genuinely surprising. It names the likely
cause without asserting it: core's `canShowReasoning` (the agent's thinking level `!== "off"`) is an
independent precondition the channel cannot observe or override, and some models emit no reasoning. Dedicated `reasoning` and `turn_settled` frames
exist in both transports. **This gap is CLOSED as of #242 half 2** (2026-08-27) — the four sentences that
stood here described half 1 and every one of them is now false, so they are replaced rather than amended:
the demo no longer keeps a bounded side array, no longer groups by `turnId` at render time, the client
state IS persisted for an opted-in account, and the projection no longer drops reasoning.

The plugin journals one row per reasoning BURST — the burst's delivered display text, as plaintext — but
only for an account that sets `capabilities.reasoningDurable: true`, which **defaults OFF** and is a
separate key from the default-ON `capabilities.reasoning`. It is necessary but not sufficient: durability
records the same lane the live stream carries, so with the lane off no frames are produced and no rows are
written (that combination now warns at config time). Half 2 widened the `history` wire row into a tagged
union whose reasoning variant carries no `role`, deleted the projection's drop, and moved the client's
render onto the shared reducer — so a reasoning block sits in `state.messages` at its delivered position
and survives a reload.

Two residuals remain, both tracked: **#304** (a burst whose transport is still refusing at close gets no
row, so watched reasoning can vanish on reload) and a live-vs-replay **ordering** divergence (GAP 2b, in
`journal-history.ts`'s conversion loop). Full statement: §15.9 of `ISSUE_114_DELIVERY_MIRROR_PLAN.md`.

**Telegram reference.**
- `reasoning-lane-coordinator.ts:68` `splitTelegramReasoningText()` — splits `{reasoningText,
  answerText}`.
- `:106` `createTelegramReasoningStepState()` — hinted→delivered state machine.
- `lane-delivery-text-deliverer.ts:131` `createLaneTextDeliverer()`.
- Reusable: **`openclaw/plugin-sdk/agent-runtime` `formatReasoningMessage()`**,
  **`openclaw/plugin-sdk/text-chunking` `stripReasoningTagsFromText()`**,
  **`openclaw/plugin-sdk/channel-outbound` `isPotentialTruncatedFinal()` / `selectLongerFinalText()`**.

**Decision record.** Native `onReasoningStream` won over parsing `<think>` tags. A dedicated frame
won over overloading `progress`, and `turnId` prevents multi-turn ordering errors. Reasoning has no
fallible live/done UI state; `turn_settled` handles only transient Stop/typing activity. Full plan:
`docs/P1_REASONING_LANE_PLAN.md`.

**Acceptance (met).** A reasoning-capable turn shows a collapsed `Reasoning` section that expands,
with the answer rendered separately and streaming normally. Non-reasoning turns show no empty
affordance; consecutive turns retain correct reasoning/answer placement.

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

## P1-6 — Doctor / self-diagnosis — ✅ BUILT

**Symptom (original).** When misconfigured, failures were opaque (silent skips in logs); no
user-facing "what's wrong + how to fix".

**Classification.** ✅ Built (branch `feat/p1-6-doctor`; plan + dist-verified SDK contract in
`docs/P1_DOCTOR_PLAN.md`). `openclaw doctor` now reports actionable per-account findings with fix
hints via `ChannelDoctorAdapter.collectPreviewWarnings` (Path A — works with the gateway DOWN), and
the status surfaces carry a live probe (`status.probeAccount`: effective-JWKS-source check +
relay dial, never triggers enrollment) plus runtime-only `collectStatusIssues`.

**What was built.**
- `src/doctor.ts` — finding engine C1–C11 factored from the exact serving-loop skip conditions
  (`index-nats.ts`): encryption-disabled, creds-missing, register-hop-static-unsupported,
  identity-key-missing, verifier-unbuildable, audience-override-removed, open-admission, obsolete-cors,
  auth-strategy-invalid (contextual a/b/c), credential-source-invalid, orphaned-default,
  deprecated-acquisition-env. Mirror-fidelity rule: never a false positive on a served config,
  never silent on a skipped one.
- `src/account-auth.ts` — `deriveAccountAuth` moved verbatim out of the entry +
  `resolveEffectiveAccountAuth` (single effective-auth resolution shared by serving loop, doctor,
  and probe; behavior-preserving).
- `src/auth.ts` — side-effect-free `validateJwtVerifierConfig`/`validateVerifierConfig` (doctor
  validates without allocating the module-level JWKS cache; `makeJwtVerifier` calls the same
  validator — one source of truth).
- `src/consume-credentials.ts` — `resolveDialMaterial` (probe-safe: enrolled mode reads persisted
  creds only, `persisted.natsUrl ?? source.url`, device flow unreachable).
- Adapters attached in `createWebChannelPlugin` (`src/channel.ts`) so the doctor CLI's read-only /
  setup-entry load path gets them; types from `openclaw/plugin-sdk/channel-contract`.

**Gotchas (durable).** The real `ChannelDoctorAdapter` is config-repair hooks, NOT the scanner
registry this doc originally sketched — status issues/probe live on the separate
`ChannelStatusAdapter`. `openclaw doctor`'s status-issue leg (Path B) is gateway-RPC-gated and
silently absent when the gateway is down, so config findings MUST live in Path A. The plain
`openclaw status` scan builds snapshots via `config.describeAccount`, never
`status.buildAccountSnapshot` — don't smuggle config findings through snapshots.

**Acceptance (met).** `openclaw doctor` reports actionable issues for a mis-set account (missing
creds, bad auth strategy, encryption off) with a fix hint, instead of a silent log skip (✅ — plus
live probe + runtime status issues beyond the original ask).

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

## P1-7 — Error handling / reconnect UX — ✅ BUILT

**Symptom (original).** On failures the demo showed minimal state; terminal errors (PoP/NKEY
rejection) were hard to distinguish from transient ones.

**Classification.** ✅ Built. Reconnect mechanics + connection-state UX + terminal-vs-transient
classification, and now the finer per-cause wording slice (a machine-readable cause tag threaded from
the connection layer to a cause-driven terminal error box).

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

**Polish.**
1. **Finer cause wording** — ✅ **built.** `ErrorListener` now carries an optional
   `WebChannelErrorCause` second arg; the `-ERR` classifier splits `authentication expired`
   (`auth-expired`) from `authorization violation` (`auth-rejected`), and the six register/handshake
   emit sites each tag their cause (`config`, `auth-rejected`, `server`, `protocol-mismatch`,
   `secure-channel-failed`). The wrapper lands it in `state.errorCause` (`?? "unknown"`), and the
   widget renders heading/hint/recovery from `demo/web/src/error-copy.ts` — so a protocol mismatch
   shows "Upgrade required" with no re-auth button instead of the false "Credentials expired". A
   `rate-limited` cause was scoped out: there is no rate-limit signal on the browser↔NATS↔plugin path,
   so inventing one would be dead code (the union stays open for a future producer).
2. **Send-while-down** — now covered by P0-7 (client replay ledger re-sends on reconnect); the
   terminal case already disables send in the error-box render.

**Acceptance (met).** A network blip shows "reconnecting…"; a credential rejection shows a distinct
terminal message with a recovery action (✅); each terminal cause now gets truthful per-cause wording
and the right recovery affordance (✅).

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
  vocabulary (43 entries at the pinned 2026.7.1-2 runtime: "stop", "abort", "halt", …). The full
  current vocabulary all aborts, for core/Telegram parity; `wait` is ordinary text under this pin.
- **Control-lane turns** stamp `access.commands.authorized:true` (`inbound.ts:215-223`), hedged
  through `commandGate` (`index-nats.ts:814-820` / `src/command-gate.ts` — the allowlist trap: core
  ignores our stamp when a commands/owner allowlist is configured); they run **draftless** and skip
  typing (`inbound.ts:136,183`). A started working draft is finalized when the run resolves without a
  final delivery (`inbound.ts` on-settle path); core's own `/stop` turn delivers "⚙️ Agent was
  aborted."
- **Client Stop button.** The primary button flips to **Stop** while the turn is in flight *and* the
  composer is empty — `composerButtonMode` / `composerInFlight` in `demo/web/src/presentation.ts`,
  applied by `applyComposerMode` in `widget.ts`. In-flight is `isTyping || turnActive ||
  any m.working`; `turnActive` was folded in for #96 so the affordance survives the gaps between a
  multi-step turn's bubbles, and the blank-composer condition keeps the label honest (a draft is
  Send intent, and Enter already sends it). Clicking Stop sends the literal `/stop` as a
  `user_message`, so the typed command and the button share one path.

> **Decision record — /stop wire choice (a), and explicit-`/stop`-only buffer drop.**
> - **Wire choice (a)** (send the literal `/stop` as a `user_message`, server detects it) was chosen
>   over (b) a dedicated `{type:"cancel"}` frame — no new frame, and typed `/stop` and the button
>   share the same path (`control-lane.ts` header).
> - **Explicit-`/stop`-only buffer drop.** The *destructive* buffer drop (`inboundDebouncer.cancelKey`
>   + `inboundDispatcher.clearPending`, `index-nats.ts:773-781`) is gated by `isExplicitAbortCommand`
>   (`text === "/stop"` only, `control-lane.ts:56-61`), **not** the broader `isControlLaneMessage`.
>   Rationale: the NL vocabulary ("halt", "stop please") must still ABORT the running turn but must
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

## P1-9 — Pending-message retraction ("unsend" a queued message) — ✅ BUILT (Option A — client-side hold)

**Symptom.** You send a message while a turn is still running; it sits queued (`inbound-queue.ts`
FIFO) and is delivered to the agent only after the current turn finishes. There is no way to pull it
back before it runs.

**Classification.** 🟢 **Web advantage, not a parity gap.** Telegram has **no** equivalent — the
Telegram Bot API does not deliver message *deletions* to bots at all, and its `edited_message`
handler (`bot-handlers.runtime.ts:3469` → `recordEditedMessageForReplyChain`) only updates the
reply-chain cache; it never dequeues a pending turn. Because **we own the browser client**, we can
offer genuine retraction — a superset of Telegram. Distinct from P1-8: retraction targets a
**not-yet-started** queued message; aborting the **in-flight** turn is P1-8.

**What shipped (Option A — client-side hold; zero wire change, zero server-runtime change).** See
`docs/P1_9_UNSEND_PLAN.md` (v4) for the full design + rationale. The hold lives in the wrapper
(`packages/client/src/nats-client-wrapper.ts`), not the widget, so any embedder inherits it:
- `send()` HOLDS when `state.isTyping || a working draft || held.length > 0` (the last is a FIFO latch
  across disconnects); a held message is a `pending: true` local bubble, published only on release.
- Release is FIFO-all, gated on `connected && sessionEstablished` (a new `onSession` hook in
  `nats-client.ts`, fired at BOTH key-establishment sites strictly AFTER `flushQueue()` — drain → flush
  → notify, so a released hold is ordered behind the P0-7b ledger replay). Released bubbles are moved
  to the **tail** of the transcript (display position = publish position — load-bearing for the
  history merge's local-order = transcript-order invariant).
- Abort text bypasses the hold (`packages/client/src/abort-mirror.ts` mirrors core's `ABORT_TRIGGERS`
  as a strict SUBSET; a plugin-package contract test enforces the subset against the real SDK
  predicate). Explicit `/stop` additionally flips held bubbles to `retracted: true` (kept in the
  transcript, restorable); NL abort words bypass but leave held messages intact.
- `retract(id)` removes a pending or retracted bubble; a `turn_settled` draft-finalize + a
  post-reconnect staleness valve (`STALE_DRAFT_GRACE_MS = 30_000`, connection-scoped) prevent a wedged
  `working` draft from becoming a permanent send lockout. Note: the valve re-arms FRESH on every
  register, so under a register storm (< 30s apart — the documented duplicate-responder failure mode)
  its grace keeps resetting and expiry is deferred; non-lossy (chips stay retractable, `/stop`
  recovers text), just slower to unwedge until the storm itself is fixed.
- **Maintenance duty:** `abort-mirror.ts` is a VERBATIM pin of the openclaw dist `ABORT_TRIGGERS` +
  normalization. It accepts a subset of core, so a false positive is impossible, but core GROWING its
  vocabulary is invisible to the mirror (the new word is held-then-released — a bounded stale-abort
  residual). **Re-pin the trigger set + normalization on every openclaw upgrade;** the contract test
  catches a REMOVED word (prune the mirror) but cannot see additions.
- **Known edge (pre-existing, documented while P1-9 touched the probe):** a bypassed mid-turn immediate
  send (e.g. an NL abort echo) sitting between the tier-3 anchor and the reply blocks the positional
  probe when the server does not transcript that text. This is byte-for-byte the SAME path any mid-turn
  immediate send takes today — not introduced by P1-9, which only made the probe skip local-only
  pending/retracted chips.
- **Accepted residual (approval-wait window):** if `approval_request` clears `isTyping` with no working
  draft live, held messages release into the server coalesce buffer behind the approval-blocked turn
  (unretractable from that point) — exactly today's behavior for that window; Option A never makes it
  worse. Fixing it needs Option B.

Option B (server-side dequeue) stays deferred: P1-8b already gave the queue a content buffer
(`src/inbound-queue.ts` `pending` + `clearPending`), so Option B's prerequisite exists; only a
`retract` frame + a by-id dequeue + a protocol bump would be net-new. Not now.

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
| ✅ | P1-3 reasoning lane | M | built — native callback + turn-correlated lane |
| ✅ | P1-9 pending-message retraction (unsend) | S | built — Option A client hold, no server/wire change |
| ✅ | P1-7 finer error wording | XS | built — cause tag threaded to a cause-driven terminal error box |
| 4 | P0-3 argument menus | S | — (catalog entries already carry `args.choices`; render dropdowns) |
| 5 | P1-2 long-response polish | S | P1-1 ✅ |
| ✅ | P1-6 doctor | M | built — C1–C11 finding engine mirrors the serving-loop skips; doctor + status adapters, probe never enrolls |
| 7 | P1-4 media | L (mini-project) | **DECIDED: object storage / blob endpoint** |
| — | ~~P1-5 interactive buttons~~ | — | **MERGED into P0-4** (delta = generalize renderer + 2 wire frames) |

> ✅ **Already built:** P1-1 (markdown, #27), P1-7 (error/reconnect UX — status pill, terminal
> error box + re-auth, terminal-vs-transient classification, and finer per-cause wording via a
> threaded `WebChannelErrorCause` tag), P1-8a (`/stop` control lane, #25), P1-8b (debounce/coalesce,
> #29).

**Resolved decisions (2026-07-02):**
- **P1-4 media → object storage (blob endpoint).** See P1-4 above.
- **P1-5 buttons → merged into P0-4** with the `presentation` + `button_action` delta; see P0-4.
# Issue #54 audience update

Audience drift/shared-audience diagnosis is closed structurally: an enabled
account rejects any raw `auth.jwt.audience`, and its expected JWT `aud` is always
its runtime account id. Doctor exposes the removed-key migration finding.
