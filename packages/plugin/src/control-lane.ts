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
 * So index-nats.ts routes control-lane frames PAST the FIFO, dispatching them
 * directly (fire-and-forget) as a control-lane turn (see
 * `handleInboundMessage(..., { controlLane: true })`). Core runs
 * `tryFastAbortFromMessage` BEFORE its per-session reply-operation busy gate, so
 * an out-of-band abort aborts the active run and never collides with the
 * one-turn-per-session invariant the FIFO protects.
 *
 * This module owns only the PREDICATE (the routing decision), kept in `src/` so
 * it is covered by tsc + vitest; index-nats.ts (which is outside tsconfig) just
 * calls it.
 */
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";

import type { InboundWsMessage } from "./transport.js";

/**
 * True when an inbound frame is an out-of-band abort request that must bypass
 * the per-session FIFO.
 *
 * Only `user_message` frames carry abort text — approvals and history frames are
 * never control-lane. `isAbortRequestText`
 * (openclaw/plugin-sdk/command-primitives-runtime) matches `/stop` plus the
 * natural-language abort vocabulary ("stop", "abort", "wait", …) after
 * command-body normalization.
 */
export function isControlLaneMessage(message: InboundWsMessage): boolean {
  return message.type === "user_message" && isAbortRequestText(message.text);
}
