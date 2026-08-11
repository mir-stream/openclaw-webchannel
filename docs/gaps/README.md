# WebChannel Gap Analysis vs. Telegram — Implementation Reference

Research-complete gap analysis of the WebChannel demo against the mature OpenClaw **Telegram**
channel extension (`../openclaw/extensions/telegram/`). Purpose: an implementation-grade backlog to
close every gap. Each file lists gaps with *symptom → classification → current state (our
`file:line`) → Telegram reference (`file:line`) → reusable `plugin-sdk` runtime → implementation
sketch → acceptance*.

> **⚠️ Re-anchored 2026-07-03 (post integrated-demo rebase); re-verified 2026-07-13 (post-#24…#33
> tree).** This branch was rebased onto the integrated showcase demo, which *rewrote the entire demo
> surface*, and the P0/P1 parity stack has since largely **landed**. P0 capability enablement is built,
> but **two P0 residuals remain**: P0-3 argument menus and P0-5 multi-message finalize correctness
> ([#94](https://github.com/mir-stream/openclaw-webchannel/issues/94)). Several P1 items shipped too.
> The demo drives the production
> `WebChannelNATSClient` state reducer and renders history, typing, approvals, streaming drafts,
> markdown, slash-command discovery, and terminal-error UX. Since the 07-10 re-verify develop merged:
> **P0-2 depth cap (#24)**; the P0/P1 parity stack **#25/#26/#28/#29/#30** = `/stop` control lane +
> NATS typing gate + slash discovery + debounce/coalesce + ingress dedupe; **markdown (#27)**;
> **client replay+ack (#31)**; and the **protocol-version handshake (#33)**. Those areas are corrected
> below. See **["What the integrated demo built — and what remains"](#what-the-integrated-demo-built--and-what-remains)**.
>
> **⚠️ Line numbers drift — trust the symbol, not the number.** The demo is still under active
> development, so every `file:line` anchor in these docs is approximate and *will* keep moving. The
> file paths, symbol names, and behavioral claims are the source of truth; if a cited line has
> shifted, search for the quoted symbol. Line numbers are not re-anchored on every demo change.

| File | Covers | Headline |
|---|---|---|
| [`P0_CORE_CHAT_GAPS.md`](P0_CORE_CHAT_GAPS.md) | history, slash commands, HITL approvals, streaming, typing, send reliability | **🟡 P0 enablement built; two residuals open.** Client render is done via `nats-client-wrapper.ts` + `demo/web/src/widget.ts`; the server-side halves (P0-2 depth cap #24, P0-5 streaming flag, P0-6 typing gate #26) and the net-new work (P0-3 discovery #30, P0-7 idempotency #30/#31) all landed. Remaining: **P0-3 argument menus and P0-5/#94 multi-message finalize correctness.** |
| [`P1_RICH_UX_GAPS.md`](P1_RICH_UX_GAPS.md) | markdown rendering, long responses, reasoning lane, media, buttons, doctor, error UX, **turn control (P1-8)**, **pending-message retraction (P1-9)** | **✅ P1-1 markdown, P1-3 reasoning, P1-7 error UX, and P1-8 `/stop`+debounce built.** Still open: **P1-9 unsend** (web advantage), **P1-2 long-response**, **P1-6 doctor**, **P1-7 finer wording**, and **media (P1-4) — a mini-project**. |
| [`P2_ADVANCED_GAPS.md`](P2_ADVANCED_GAPS.md) | multi-conversation, reactions, edit/quote, ingress durability, throttle, audit, access depth | **Ingress durability (P2-4) matters most for our NATS transport.** P0-7 now covers the client-reconnect side; P2-4 narrows to **agent-down durability** (JetStream vs spool, still deferred). Multi-conversation is the biggest product lift. *(Rest of P2 unchanged — still backlog.)* |

## The current architecture (read this first — it changed)

There is **one production client path**, and the demo uses it.

| Layer | File | Role |
|---|---|---|
| Low-level NATS client | `packages/client/src/nats-client.ts` (`WebChannelNatsClient`) | raw NATS WS + E2E handshake + `onMessage`/`onError`/`onState`/`onProtocol`; terminal-vs-transient auth classification (`:588-596`); P0-7b replay ledger (`unackedLedger`/`flushQueue`/`drainAcked`). |
| **State reducer wrapper** | `packages/client/src/nats-client-wrapper.ts` (`WebChannelNATSClient`) | reduces the full protocol into an immutable `WebChannelState { messages(+wireId/delivered), approvals, status, connected, isTyping?, commands?, agentProtocolVersion, agentPluginVersion, error? }` (`types.ts:123-165`); exposes `subscribe`/`getState`/`send`/`decide`/`loadHistory`/`loadCommands`. |
| Demo widget | `demo/web/src/widget.ts` | `client.subscribe(render)` → renders bubbles, typing, approval cards, "Load older", terminal-error re-auth. |
| **Retired** | `packages/client/src/browser-demo-entry.ts` (`runDemo`) | the old thin "drop everything but `agent_message`" path. **No longer the demo** — only a SaaS smoke test + `e2e/local/ci-smoke.html` still reference it. |

**Server/agent side (NATS path).** The wiring the old doc attributed to `packages/plugin/src/index-nats.ts`
now lives in the **package-root** composition entry `packages/plugin/index-nats.ts` (772 lines),
which glues together the split modules:

| Concern | Module (current) |
|---|---|
| plugin registration + outbound seam | `src/channel.ts` (`createWebChannelPlugin` `:87`) |
| NATS outbound frames | `src/nats-channel.ts` (`NatsChannel` — `sendProgress` `:375`, `finalizeDraft` `:383`, `sendHistory` `:398`, `sendApprovalRequest` `:406`, `sendApprovalResolved` `:432`, `sendApprovalSnapshot` `:473`, `sendTyping` **gated** `:509-513`, `sendCommands` `:527-530`, `sendAck` `:539-543`) |
| register hop + handler wiring | `packages/plugin/index-nats.ts` (**NATS request/reply — no HTTP**): `setRegisterRequestHandler` (wired `:638`), `setApprovalDecisionHandler` (`:530`), `setLoadHistoryHandler` (`:548`), `setLoadCommandsHandler` (`:917-925`); the register success path sends **both** a history snapshot (`sendHistory`, detached read) **and** an approval snapshot (`sendApprovalSnapshot`, synchronous, `:668-673`) — stateless per register. |
| `/stop` control lane (P1-8a) | `src/control-lane.ts` (`isControlLaneMessage`, `isExplicitAbortCommand`, `shouldDropBufferedInputOnStop`) + `src/command-gate.ts` (allowlist-trap hedge) |
| slash-command discovery (P0-3) | `src/commands-catalog.ts` (`buildCommandCatalog`, `createCommandCatalogProvider`) |
| ingress dedupe + ack (P0-7a) | `src/ingress-dedupe.ts` (`filterFreshInboundItems`, `createIngressOnFlush`, `recordCancelledInboundItems`) |
| protocol version (#33) | `src/protocol.ts` (`WEBCHANNEL_PROTOCOL_VERSION`, `readPluginVersion`) |
| inbound turn / streaming / typing | `src/inbound.ts` (streaming-mode resolve `:124-136`, control-lane branch, `sendTyping` `:160`, `commandBody` `:200`) |
| debounce / coalesce (P1-8b) | `src/inbound-queue.ts` (`coalesceUserMessages`, `startCoalesceTurn`, `clearPending`/`pendingBuffered`) + core `createInboundDebouncer` |
| history store | `src/history.ts` (`resolveHistoryConfig` `:37`, `recent` `:182`, `planHistoryFetch` `:218-231`, `pageBefore` `:277-318`) |
| multi-account multiplex | `src/multiplex.ts` (`planAccounts`) |
| legacy WS transport (retained) | `src/transport.ts` (`typingEnabled`/`historyEnabled` gates) |

## What the integrated demo built — and what remains

The demo config (`demo/run.sh:268-291`) ships `history.enabled:true` and `execApprovals` with
approvers, so these run **end-to-end** in the demo. The reducer (`nats-client-wrapper.ts`) handles
every inbound frame; the widget renders each.

| Gap | Status now | Where |
|---|---|---|
| **P0-1** history restore | ✅ **built** (client reduce + **ordered merge** + render; server snapshot from the register route, stateless). #16 three-tier matching + anchor-cursor; #15/#19 approval snapshot on the same hop. | reducer `case "history"` `nats-client-wrapper.ts:209`; server snapshot in the register route |
| **P0-2** history pagination | ✅ **built** (#24): two-phase `pageBefore` to the 1000-msg ceiling + `planHistoryFetch` call-site fix; >1000-turn residual stays upstream-blocked | `pageBefore` `history.ts:277-318`; `planHistoryFetch` `:218-231` |
| **P0-3** slash-command discovery | ✅ **built** (#30): server catalog (`load_commands`→`commands`) + client typeahead. **Residual: argument menus** | `commands-catalog.ts`; `sendCommands` `nats-channel.ts:527-530`; widget `cmdMenu` `:78`, `renderMenu` `:238` |
| **P0-4** approval cards | ✅ **built** (card render + `decide`); **rehydration built** (#15/#19 `approval_snapshot` Legs A/B/C) | `renderApproval` `widget.ts:81`; reducer `:381/:421/:435`; `decide` `:145` |
| **P0-5** streaming drafts | 🟡 **enablement built; correctness open** — demo sets `streaming.mode:"partial"` (`run.sh:287`), but #94 must preserve multiple assistant-message lanes through finalize | reducer `case "progress"` `:557`; server gate `inbound.ts:124-136`; #94 |
| **P0-6** typing indicator | ✅ **built** — client render + **NATS gate wired** (#26): `typing:"off"` now honored | reducer `case "typing"` `:376`; gate `nats-channel.ts:509-513` wired `index-nats.ts:590` |
| **P0-7** send reliability | ✅ **built** (#30/#31): client replay ledger + server ingress dedupe + `ack` frame | `nats-client.ts` `unackedLedger`/`flushQueue`/`drainAcked`; `src/ingress-dedupe.ts`; `sendAck` `nats-channel.ts:539-543` |
| **P1-1** markdown | ✅ **built** (#27): sanitized markdown DOM for agent bubbles (zero-dep, no `innerHTML`) | `demo/web/src/markdown.ts`; `renderMarkdown` at `widget.ts:201` |
| **P1-3** reasoning lane | ✅ **built**: native callback → dedicated turn-correlated wire/state → collapsed sanitized UI; streams only when resolved session reasoning level is `stream` (default `off`, Telegram parity, fail-closed) | `ReasoningDraftController`; `reasoning-level.ts`; `reasoning`/`turn_settled`; `presentation.ts` |
| **P1-7** error / reconnect UX | ✅ **built** (status pill + cause-driven terminal error box + re-auth); a `WebChannelErrorCause` tag threads from the `-ERR`/register emit sites through `state.errorCause` to per-cause wording | terminal classify `nats-client.ts` `-ERR` split; `error-copy.ts`; error box `widget.ts` |
| **P1-8** turn control | ✅ **built**: `/stop` control lane (#25, `control-lane.ts`) + debounce/coalesce (#29, `inbound-queue.ts`) | control lane `index-nats.ts:724-822`; Stop button `widget.ts:182-186,381-386` |

**Still genuinely open** (accurately described in the files): **P0-3** argument menus,
**P0-5/#94** multi-message finalize correctness, **P1-2** long-response,
**P1-4** media (mini-project), **P1-6** doctor, **P1-9** pending-message
retraction / unsend (web advantage — no Telegram equivalent), and **all of P2** (with P2-4 now
narrowed to agent-down durability — see below).

## Classification legend

- 🔴 **Missing entirely** — no support in wire, server, or UI.
- 🟡 **Partial / server-only-left** — client render done (or wire+server done); a slice remains.
- 🟢 **Partial polish** — exists but incomplete UX.
- ✅ **Built by the integrated demo** — implemented and rendered; numbering retained as a stable anchor.

## The load-bearing findings (updated)

1. **One client path now.** The rich `WebChannelNATSClient` (`nats-client-wrapper.ts`) reduces the
   full protocol (history/typing/approval/progress) into immutable state, and the demo
   (`demo/web/src/widget.ts`) subscribes to it. The old "two paths / thin `runDemo` drops 90%"
   framing is **obsolete**.

2. **Server defaults are ON, and the demo sets `partial`.** `packages/plugin/openclaw.plugin.json`
   ships `history.enabled:true` (`:174-178`), `capabilities.typing:"on"` (`:167-170`),
   `execApprovals`/`inlineButtons` (`:137/:163`), and a `streaming.mode` option
   (`off|partial|block|progress`, enum `:110`) with **no manifest default** — but the demo now **sets
   `streaming.mode:"partial"`** (`run.sh:287`, P0-5). The two draft modes differ: `"partial"` streams
   the **current assistant message's answer text** into an active working draft, while `"progress"`
   streams **tool/item lines only** and finalizes the answer atomically (`inbound.ts:124-136`). The
   capability is live, but [#94](https://github.com/mir-stream/openclaw-webchannel/issues/94) remains
   a correctness gap: multiple assistant messages currently share one draft id, so the last final can
   erase earlier live messages. The accepted fix settles one bubble per assistant-message boundary
   and rotates to a new id, while letting the first durable lane claim the provisional tool-scaffold id,
   retaining late indexless reservations through lifecycle/terminal drain. Queued callbacks are
   pre-TTS/media and pre-rewrite/cancel, so they never supply wire body or a delivery-suppression
   credit. Only the actual post-hook block delivery is authoritative, but no public identity correlates
   it to a reservation—even one remaining reservation can be unrelated. Every authorized non-notice
   block in partial mode therefore uses a fresh fallback id. Skip/cancel/settled/error lifecycle
   signals retire reservations, and all three block notice flags take an independent non-lane path.
   Queued callback cardinality still cannot classify finals. After a leading terminal error,
   non-notice finals without public identity, such as `[A1,A2,B]`, each use a fresh fallback id.
   This deliberately preserves at least once and may duplicate materialized A/B; block partial dedupe,
   same-message grouping, exact lane ownership, and final exact-once need a stable public identity that
   reaches actual delivery and are deferred to
   [#111](https://github.com/mir-stream/openclaw-webchannel/issues/111). Setup-wizard nit remains:
   it does not offer `streaming.mode` (enroll-only).

3. **Slash commands both execute AND are discoverable.** Execution always worked — text commands are
   on by default and WebChannel is not a native-command surface (`channel.ts:115` declares no
   `nativeCommands`), so `/help` typed in the browser runs (core `commands-text-routing.ts:40-48`).
   **Discovery is now built too** (#30): a `load_commands`→`commands` catalog (config-filtered, from
   `native-command-registry`) feeds a widget typeahead. The only P0-3 residual is **argument menus**.

## Server-side items — status after the refactor

The original enablement gaps landed. Streaming is enabled, with #94 still open as a live-path
correctness fix:

1. **P0-2 depth cap** — ✅ FIXED (#24). `pageBefore` (`history.ts:277-318`) is now a two-phase fetch
   that widens to the 1000-message upstream ceiling (`MAX_FETCH_WINDOW`) when the small window can't
   yield a full page, and returns an **empty page** (not the old newest-N `slice`) on a genuine
   cursor miss. The live-path call-site bug (whole request object passed as `beforeId`) is fixed via
   `planHistoryFetch` (`:218-231`). Residual: conversations >1000 turns stay upstream-blocked.
2. **P0-6 typing gate** — ✅ FIXED (#26). `NatsChannel` now has a `typingEnabled` field (`:249`) +
   `setTypingEnabled()` (`:502-504`); `sendTyping` (`:509-513`) is gated; wired at
   `index-nats.ts:590` from `resolveTypingEnabled(account)` (`account-config.ts:271-276`). So
   `capabilities.typing:"off"` is now honored on NATS.
3. **P0-5 streaming flag** — 🟡 ENABLED, correctness work open. `demo/run.sh:287` sets
   `"streaming": { "mode": "partial" }`, so `resolveStreamingMode(...)` enables the answer-text draft
   stream in the demo (`inbound.ts:124-136`). #94 must still replace the turn-wide single draft with
   per-assistant-message materialize-and-rotate lanes. Setup-wizard nit: it still doesn't offer
   `streaming.mode` (enroll-only).

## Reuse principle

WebChannel is a new **transport** for openclaw's existing **content + policy model**. Telegram
composes `openclaw/plugin-sdk/*` runtimes rather than hand-rolling; the same subpaths are verified
present in the sibling checkout (`/Users/mircorn/workspace/openclaw/src/plugin-sdk/`) and importable
as peer deps. The full runtime→gap map is at the bottom of `P2_ADVANCED_GAPS.md`.

## Decisions

**Resolved (2026-07-02):**
- **P1-4 media → object storage (blob endpoint).** E2E-encrypted upload to a gateway blob
  endpoint → `media://` id in the message → agent decrypts, saves to media store, injects as a
  prompt attachment. Model capability gating + media-understanding (transcribe/describe for
  non-vision models) inherited free from the shared turn path — no error on text-only models.
  NATS-chunking rejected. See `P1_RICH_UX_GAPS.md` → P1-4.
- **P1-5 buttons → merged into P0-4.** General interactive buttons and approval cards are one
  surface; P0-4's approval renderer exists (`widget.ts:74-98`), and P1-5 adds only the
  `presentation` + `button_action` wire frames on top. The `P1-5` number is a retained tombstone.
  See `P0_CORE_CHAT_GAPS.md` → P0-4 and `P1_RICH_UX_GAPS.md` → P1-5.

**Deferred (open — decide when P2 is scheduled):**
- **P2-4 durability:** JetStream vs disk spool (touches NATS topology — see memory `nats-cutover-plan`).
  P0-7 client replay+ack **is now built** and covers the client-reconnect side, so P2-4 narrows to
  agent-down durability (disk-spool / JetStream on the inbound subject). The transport decision is
  still not committed.
- **P2-1 threading:** per-thread session keying + wire changes. Recommendation is payload-level
  multiplex (subject wire unchanged). Not yet committed.
