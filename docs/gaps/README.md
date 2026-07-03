# WebChannel Gap Analysis vs. Telegram — Implementation Reference

Research-complete gap analysis of the WebChannel demo against the mature OpenClaw **Telegram**
channel extension (`../openclaw/extensions/telegram/`). Purpose: an implementation-grade backlog to
close every gap. Each file lists gaps with *symptom → classification → current state (our
`file:line`) → Telegram reference (`file:line`) → reusable `plugin-sdk` runtime → implementation
sketch → acceptance*.

> **⚠️ Re-anchored 2026-07-03 (post integrated-demo rebase).** This branch was rebased onto the
> nearly-finished **integrated showcase demo**, which *rewrote the entire demo surface*. Most of
> what P0 originally described as unrendered "wiring gaps" is now **built** — the demo no longer
> uses the thin `runDemo` path; it drives the production `WebChannelNATSClient` state reducer and
> already renders history, typing, approvals, streaming drafts, and terminal-error UX. See
> **["What the integrated demo already closed"](#what-the-integrated-demo-already-closed)**.
>
> **⚠️ Line numbers drift — trust the symbol, not the number.** The demo is still under active
> development, so every `file:line` anchor in these docs is approximate and *will* keep moving. The
> file paths, symbol names, and behavioral claims are the source of truth; if a cited line has
> shifted, search for the quoted symbol. Line numbers are not re-anchored on every demo change.

| File | Covers | Headline |
|---|---|---|
| [`P0_CORE_CHAT_GAPS.md`](P0_CORE_CHAT_GAPS.md) | history, slash commands, HITL approvals, streaming, typing, send reliability | **Mostly ✅ built by the integrated demo.** Client render is done via `nats-client-wrapper.ts` + `demo/web/src/widget.ts`. Remaining = **server-side** (P0-2 depth cap, P0-5 streaming flag, P0-6 typing gate) + **net-new** (P0-3 discovery, P0-7 idempotency). |
| [`P1_RICH_UX_GAPS.md`](P1_RICH_UX_GAPS.md) | markdown rendering, long responses, reasoning lane, media, buttons, doctor, error UX, **turn control (P1-8)**, **pending-message retraction (P1-9)** | **P1-7 error/reconnect UX ✅ mostly built.** Markdown (P1-1) is still plain text; **P1-8 `/stop` abort + debounce** is a Telegram parity gap (`/stop` currently queues behind the running turn); **P1-9 unsend** is a web advantage Telegram lacks; **media (P1-4) is a mini-project**; reasoning/doctor still open. |
| [`P2_ADVANCED_GAPS.md`](P2_ADVANCED_GAPS.md) | multi-conversation, reactions, edit/quote, ingress durability, throttle, audit, access depth | **Ingress durability (P2-4) matters most for our NATS transport** (loss, not dup). Multi-conversation is the biggest product lift. *(P2 unchanged — still backlog.)* |

## The current architecture (read this first — it changed)

There is **one production client path**, and the demo uses it.

| Layer | File | Role |
|---|---|---|
| Low-level NATS client | `packages/client/src/nats-client.ts` (`WebChannelNatsClient`) | raw NATS WS + E2E handshake + `onMessage`/`onError`/`onState`; terminal-vs-transient auth classification (`:171-172`, `:427-430`). |
| **State reducer wrapper** | `packages/client/src/nats-client-wrapper.ts` (`WebChannelNATSClient`) | reduces the full protocol into an immutable `WebChannelState { messages, approvals, status, isTyping }`; exposes `subscribe`/`getState`/`send`/`decide`/`loadHistory`. **This is the "Option 2 reducer" the old doc deferred — it now exists for the NATS path.** |
| Demo widget | `demo/web/src/widget.ts` | `client.subscribe(render)` → renders bubbles, typing, approval cards, "Load older", terminal-error re-auth. |
| **Retired** | `packages/client/src/browser-demo-entry.ts` (`runDemo`) | the old thin "drop everything but `agent_message`" path. **No longer the demo** — only a SaaS smoke test + `e2e/local/ci-smoke.html` still reference it. |

**Server/agent side (NATS path).** The wiring the old doc attributed to `packages/plugin/src/index-nats.ts`
now lives in the **package-root** composition entry `packages/plugin/index-nats.ts` (829 lines),
which glues together the split modules:

| Concern | Module (current) |
|---|---|
| plugin registration + outbound seam | `src/channel.ts` (`createWebChannelPlugin` `:86`) |
| NATS outbound frames | `src/nats-channel.ts` (`NatsChannel` — `sendText` `:256`, `sendProgress` `:279`, `finalizeDraft` `:287`, `sendTyping` `:294`, `sendHistory` `:302`, `sendApprovalRequest` `:310`, `sendApprovalResolved` `:336`) |
| register hop + handler wiring | `packages/plugin/index-nats.ts` (`registerHttpRoute`, `NatsChannel` construct, `setApprovalDecisionHandler`, `setLoadHistoryHandler`, **register-route snapshot** `historyRecent`→`sendHistory` — stateless, detached read) |
| inbound turn / streaming / typing | `src/inbound.ts` (`progressEnabled` `:109`, `sendTyping` `:145`, `commandBody` `:178`) |
| history store | `src/history.ts` (`resolveHistoryConfig` `:35`, `recent`, `pageBefore` `:214`) |
| multi-account multiplex | `src/multiplex.ts` (`planAccounts`) |
| legacy WS transport (retained) | `src/transport.ts` (`typingEnabled`/`historyEnabled` gates `:187-207`) |

## What the integrated demo already closed

The demo config (`demo/run.sh:200-217`) ships `history.enabled:true` and `execApprovals` with
approvers, so these run **end-to-end** in the demo. The reducer (`nats-client-wrapper.ts`) handles
every inbound frame; the widget renders each.

| Gap | Status now | Where |
|---|---|---|
| **P0-1** history restore | ✅ **built** (client reduce + render; server snapshot from the register route, stateless) | reducer `case "history"` `nats-client-wrapper.ts`; server snapshot in the register route (`index-nats.ts`) |
| **P0-2** history pagination | 🟡 **UI + client + server handler built**; server **depth cap still open** | "Load older" `widget.ts:49,203`; `loadHistory` `:155`; cap `history.ts:214` |
| **P0-4** approval cards | ✅ **built** (card render + `decide`) | `renderApproval` `widget.ts:74`; reducer `:245/:272`; `decide` `:145` |
| **P0-5** streaming drafts | 🟡 **client render built**; **demo doesn't set `streaming.mode:"progress"`** so it isn't exercised | reducer `case "progress"` `:279`; working bubble `widget.ts:136`; server gate `inbound.ts:109` |
| **P0-6** typing indicator | ✅ **client built**; server **NATS gate still open** (`typing:"off"` ignored on NATS) | reducer `case "typing"` `:240`; `widget.ts:141`; ungated `nats-channel.ts:294` |
| **P1-7** error / reconnect UX | ✅ **mostly built** (status pill + terminal "Credentials expired" + re-auth) | `widget.ts:100-119`; terminal classify `nats-client.ts:427-430` |

**Still genuinely open** (net-new work, accurately described in the files): **P0-3** slash-command
discovery, **P0-7** send idempotency/replay, **P1-1** markdown rendering (`widget.ts:138` is still
`textContent`), **P1-8** turn control (`/stop` abort + inbound debounce — Telegram parity;
`/stop` currently queues behind the running turn at `index-nats.ts:639`), **P1-9** pending-message
retraction / unsend (web advantage — no Telegram equivalent), **P1-2/3/4/6**, and the **server-side**
halves of P0-2/P0-5/P0-6.

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

2. **Server defaults are ON.** `packages/plugin/openclaw.plugin.json` ships `history.enabled:true`
   (`:174-178`), `capabilities.typing:"on"` (`:167-170`), `execApprovals`/`inlineButtons`
   (`:137/:163`), and a `streaming.mode` option (`off|partial|block|progress`, `:115-123`) that is
   **not defaulted to `progress`** and **not set by the demo** (P0-5).

3. **Slash commands already execute.** Traced through openclaw core
   (`commands-text-routing.ts:40-48`): text commands are on by default and WebChannel is not a
   native-command surface (`channel.ts:103` declares no `nativeCommands`), so `/help` typed in the
   browser already runs. **P0-3 is discovery-only.**

## Server-side items still valid after the refactor

Re-verified 2026-07-03 against the current tree:

1. **P0-2 depth cap** — `pageBefore` (`history.ts:214-226`): the SDK seam
   (`runtime.subagent.getSessionMessages`) has no `before` cursor, so it always fetches only the
   newest `limit*2` messages; pagination silently stops after ~2 pages, and the cursor-miss
   fallback `window.slice(-limit)` (`:226`) returns the *newest* slice while the comment claims
   *oldest*. Client dedup hides it as "load-more stops".
2. **P0-6 typing gate** — the gate lives only on the legacy WS transport
   (`transport.ts:187-199` `typingEnabled`). `NatsChannel` (`nats-channel.ts`) has **no gate field**
   and `NatsChannel.sendTyping` (`:294`) is ungated; `index-nats.ts` never wires one. So
   `capabilities.typing:"off"` is **silently ignored on the NATS path** (the `inbound.ts:141-142`
   comment "the transport gates the frame" is only true for the WS transport).
3. **P0-5 streaming flag** — `demo/run.sh` sets no `streaming` config (the account block at
   `:200-217` has `history`/`execApprovals`/`auth`/`dmSecurity` but no `streaming.mode`), so
   `resolveStreamingMode(...)==="progress"` (`inbound.ts:109`) is false in the demo. The client
   renders progress drafts, but the demo never emits them.

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
  Working lean: JetStream off + browser is hand-rolled NATS; recommendation is P0-7 client
  replay+ack as primary, disk-spool optional. Not yet committed.
- **P2-1 threading:** per-thread session keying + wire changes. Recommendation is payload-level
  multiplex (subject wire unchanged). Not yet committed.
