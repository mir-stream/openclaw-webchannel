/**
 * Out-of-band control lane — abort (`/stop`) routing predicate.
 *
 * WHY THIS EXISTS
 * ---------------
 * Normal inbound `user_message` frames are serialized per session on the FIFO
 * (`inbound-queue.ts`) so core never sees two turns in flight for one session.
 * But an ABORT request must do the opposite: it has to reach core's fast-abort
 * path WHILE the running turn is still live. If `/stop` queued behind the turn
 * it is meant to cancel, it would only run once that turn had already finished —
 * there would be nothing left to abort.
 *
 * So the NATS account runtime routes control-lane frames PAST the FIFO, dispatching them
 * directly (fire-and-forget) as a control-lane turn (see
 * `handleInboundMessage(..., { controlLane: true })`). Core runs
 * `tryFastAbortFromMessage` BEFORE its per-session reply-operation busy gate, so
 * an out-of-band abort aborts the active run and never collides with the
 * one-turn-per-session invariant the FIFO protects.
 *
 * This module owns only the PREDICATE (the routing decision), independently
 * covered by typecheck and behavior tests; the account runtime calls it.
 */
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";

import type { InboundWsMessage } from "./channel-contract.js";
import type { CommandGate } from "./command-gate.js";

/**
 * True when an inbound frame is an out-of-band abort request that must bypass
 * the per-session FIFO.
 *
 * Only `user_message` frames carry abort text — approvals and history frames are
 * never control-lane. `isAbortRequestText`
 * (openclaw/plugin-sdk/command-primitives-runtime) matches `/stop` plus the
 * natural-language abort vocabulary ("stop", "abort", "halt", …) after
 * command-body normalization.
 */
export function isControlLaneMessage(message: InboundWsMessage): boolean {
  return message.type === "user_message" && isAbortRequestText(message.text);
}

/**
 * True ONLY for the unambiguous typed `/stop` command (case- and
 * surrounding-whitespace-insensitive), and nothing else.
 *
 * The NL abort vocabulary ("halt", "stop", "abort", …) still ABORTS the running
 * turn — `isControlLaneMessage` keeps that full vocabulary for core/Telegram
 * parity, and must NOT be narrowed. But those NL words must not additionally
 * DESTROY the peer's buffered input: a user mid-conversation who types "halt" or
 * "stop please" (a false-positive against the running turn) should lose at most
 * a spurious abort, never a queued follow-up message. Only the explicit typed
 * "/stop" — and the widget Stop button, which sends the literal "/stop" — opts
 * into dropping the buffered/debounced input alongside the abort.
 */
export function isExplicitAbortCommand(message: InboundWsMessage): boolean {
  return (
    message.type === "user_message" &&
    message.text.trim().toLowerCase() === "/stop"
  );
}

/**
 * True ONLY when an explicit `/stop` should ALSO destroy this peer's buffered
 * input (the pre-run debounce window + the mid-turn coalesce buffer), i.e. when
 * the abort it accompanies will actually take effect.
 *
 * WHY THE GATE
 * ------------
 * The buffer drop is ALL-OR-NOTHING with the abort by design: dropping the
 * queued input only makes sense if the running turn is genuinely being
 * cancelled. But the abort itself is authorized by CORE, and core IGNORES our
 * control-lane `access.commands.authorized` stamp whenever a commands/owner
 * allowlist is configured — for a non-listed peer the `/stop` returns
 * handled:false, the running turn keeps going, and the abort is a no-op (see
 * command-gate.ts for the exact trap). If we still dropped the buffers in that
 * case, a non-listed peer's Stop would be a PARTIAL abort: their turn survives
 * but their queued follow-ups are destroyed — the worst of both. So we drop only
 * when the gate says core will honor this peer's abort:
 * `!gate.delegated` (no allowlist — the stamp path authorizes everyone) OR
 * `gate.isListed(peerId)` (allowlist configured and this peer is on it).
 *
 * ASYMMETRY WE ACCEPT (honestly)
 * ------------------------------
 * The gate is a best-effort mirror biased toward NOT dropping. A false "not
 * listed" (the mirror says refused, core actually honors) merely SKIPS the drop
 * for a peer whose abort DID succeed: their queued follow-up then runs after the
 * abort instead of being discarded — a mild surprise. We accept that over the
 * opposite error (destroying input for a peer whose turn keeps running), because
 * data loss is worse than a skipped cleanup. Core remains the authority for the
 * abort itself either way; this predicate only governs the destructive cleanup.
 *
 * NL abort vocabulary ("halt", "stop please") is excluded here exactly as in
 * `isExplicitAbortCommand` — those still abort, but must never destroy buffered
 * input.
 */
export function shouldDropBufferedInputOnStop(
  message: InboundWsMessage,
  gate: CommandGate,
  peerId: string,
): boolean {
  if (!isExplicitAbortCommand(message)) return false;
  return !gate.delegated || gate.isListed(peerId);
}
