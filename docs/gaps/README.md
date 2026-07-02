# WebChannel Gap Analysis vs. Telegram — Implementation Reference

Research-complete gap analysis of the WebChannel demo against the mature OpenClaw **Telegram**
channel extension (`../openclaw/extensions/telegram/`). Purpose: an implementation-grade backlog to
close every gap. Each file lists gaps with *symptom → classification → current state (our
`file:line`) → Telegram reference (`file:line`) → reusable `plugin-sdk` runtime → implementation
sketch → acceptance*.

| File | Covers | Headline |
|---|---|---|
| [`P0_CORE_CHAT_GAPS.md`](P0_CORE_CHAT_GAPS.md) | history, slash commands, HITL approvals, streaming, typing, send reliability | **Mostly 🟡 wiring gaps** — the server already supports history/typing/approvals/progress (manifest defaults ON); the demo client throws it all away at `browser-demo-entry.ts:181`. |
| [`P1_RICH_UX_GAPS.md`](P1_RICH_UX_GAPS.md) | markdown rendering, long responses, reasoning lane, media, buttons, doctor, error UX | Polish layer. Markdown + buttons + doctor are moderate; **media is a mini-project** (E2E blob transport). |
| [`P2_ADVANCED_GAPS.md`](P2_ADVANCED_GAPS.md) | multi-conversation, reactions, edit/quote, ingress durability, throttle, audit, access depth | **Ingress durability (P2-4) matters most for our NATS transport** (loss, not dup). Multi-conversation is the biggest product lift. |

## The three load-bearing findings

1. **Two client paths.** The rich `packages/client/src/client.ts` (`WebChannelClient`) already
   reduces the full protocol (history/typing/approval/progress) into immutable state. The demo
   uses the thin NATS `runDemo` path (`browser-demo-entry.ts`) which surfaces **only**
   `agent_message`. Most of P0 is re-wiring, not new protocol.

2. **Server defaults are ON.** `packages/plugin/openclaw.plugin.json` ships `history.enabled:true`,
   `capabilities.typing:"on"`, `execApprovals`/`inlineButtons`, and a `streaming.mode:"progress"`
   option. `index-nats.ts` wires `sendHistory`/`setLoadHistoryHandler`/`setApprovalDecisionHandler`/
   typing. The demo just doesn't render any of it.

3. **Slash commands already execute.** Traced through openclaw core
   (`commands-text-routing.ts:40-48`): text commands are on by default and WebChannel is not a
   native-command surface, so `/help` typed in the browser already runs. **P0-3 is discovery-only.**

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
  surface; P0-4 is built as a generic `renderControls` component, and P1-5 adds only the
  `presentation` + `button_action` wire frames on top. The `P1-5` number is a retained tombstone.
  See `P0_CORE_CHAT_GAPS.md` → P0-4 and `P1_RICH_UX_GAPS.md` → P1-5.

**Deferred (open — decide when P2 is scheduled):**
- **P2-4 durability:** JetStream vs disk spool (touches NATS topology — see memory `nats-cutover-plan`).
  Working lean: JetStream off + browser is hand-rolled NATS; recommendation is P0-7 client
  replay+ack as primary, disk-spool optional. Not yet committed.
- **P2-1 threading:** per-thread session keying + wire changes. Recommendation is payload-level
  multiplex (subject wire unchanged). Not yet committed.
