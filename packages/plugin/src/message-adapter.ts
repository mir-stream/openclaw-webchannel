import {
  defineChannelMessageAdapter,
  createMessageReceiptFromOutboundResults,
  createDraftStreamLoop,
  resolveChannelPreviewStreamMode,
  resolveChannelProgressDraftLabel,
  resolveChannelProgressDraftMaxLines,
  formatChannelProgressDraftLineForEntry,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  ChannelMessageSendResult,
  MessageReceipt,
  StreamingMode,
  ChannelProgressDraftLineInput,
  DraftStreamLoop,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  stripReasoningTagsFromText,
  stripInlineDirectiveTagsForDelivery,
} from "openclaw/plugin-sdk/text-chunking";

import { WEBCHANNEL_ID } from "./transport.js";
import type { WebChannelTransport } from "./transport.js";

/**
 * Stable per-message id we generate for each outbound logical send. This becomes
 * the receipt's primary platform id (the editable handle core would use) AND the
 * WS frame id the widget keys its bubble on, so a progress draft and its final
 * answer share one id.
 */
function nextMessageId(): string {
  return `webchannel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a `MessageReceipt` whose primary/only platform id is `id`.
 *
 * `MessageReceipt` (verified: dist/plugin-sdk/types-Dcn9-crA.d.ts:46-56) requires
 * `platformMessageIds: string[]`, `parts: MessageReceiptPart[]`, `sentAt: number`;
 * `primaryPlatformMessageId` is the stable editable id. We delegate to
 * `createMessageReceiptFromOutboundResults` (verified:
 * dist/plugin-sdk/channel-outbound-DOdV8JXV.d.ts:341-347) so the receipt is shaped
 * exactly as core expects from one text part.
 */
export function buildClawReceipt(id: string): MessageReceipt {
  return createMessageReceiptFromOutboundResults({
    results: [{ channel: WEBCHANNEL_ID, messageId: id }],
    kind: "text",
    sentAt: Date.now(),
  });
}

/**
 * The WebChannel `message` adapter.
 *
 * Why it exists alongside the lean `outbound.attachedResults` (see channel.ts):
 *
 *  - `base.message` (a `ChannelMessageAdapter`) and a legacy `outbound` block are
 *    allowed to COEXIST — the bundled SMS channel ships both
 *    (dist/extensions/sms/channel-plugin-api.js:1242 attaches `message:
 *    smsMessageAdapter` while also defining `outbound`). We keep `outbound` for
 *    core-initiated sends and add this adapter to declare our live capabilities.
 *
 *  - The `live` facet declares the progress-draft capabilities
 *    (`draftPreview`/`progressUpdates`/`previewFinalization`,
 *    ChannelMessageLiveCapability, dist/plugin-sdk/types-Dcn9-crA.d.ts:239-241).
 *
 * IMPORTANT (verified by tracing the runtime): core does NOT auto-drive a
 * plugin's `message.live` adapter to produce progress drafts. The live
 * draft+edit machinery is implemented per-channel inside each channel's own
 * monitor/message-handler using the shared helpers
 * (`createChannelProgressDraftCompositor`, `createDraftStreamLoop`, ...). The
 * built-in path lives entirely under `extensions/discord/src/monitor/...`
 * (dist/message-handler.process-DGX1-IzX.js, all `#region` markers are Discord)
 * and calls Discord REST `editChannelMessage`/`createChannelMessage` directly.
 *
 * For a PLUGIN channel the generic seam is the inbound turn's reply dispatcher:
 * the `AssembledChannelTurn` we return from `resolveTurn` accepts
 * `replyOptions?: Omit<GetReplyOptions, "onBlockReply">` and `dispatcherOptions`
 * (AssembledChannelTurn, dist/plugin-sdk/types-BVAOMoZy.d.ts:5811-5813). Those
 * carry `onToolStart`/`onItemEvent`/`onPartialReply` (GetReplyOptions,
 * dist/plugin-sdk/types-BYvUZFDr.d.ts:274-304). We hook them to drive our own
 * draft (see `createProgressDraftController`) and emit WS `progress` frames,
 * then finalize through the turn's `delivery.deliver`. See src/inbound.ts.
 *
 * `send.text` must return `ChannelMessageSendResult = { receipt; messageId? }`
 * (dist/plugin-sdk/types-Dcn9-crA.d.ts:161-164). We return a real receipt whose
 * primary id is our generated per-message id; this is also the fallback send
 * used if core ever drives the adapter directly.
 */
export function createClawMessageAdapter(transport: WebChannelTransport) {
  return defineChannelMessageAdapter({
    id: WEBCHANNEL_ID,
    // Final delivery is plain text only.
    durableFinal: { capabilities: { text: true, media: false } },
    live: {
      capabilities: {
        draftPreview: true,
        progressUpdates: true,
        previewFinalization: true,
      },
    },
    send: {
      text: async (ctx): Promise<ChannelMessageSendResult> => {
        const id = nextMessageId();
        // `ctx.to` is the recorded reply target — the REAL per-peer `wsKey`
        // (inbound.ts records `reply.to = wsKey`). Target it directly; if it's
        // absent or has no mapped socket, fall back to `sendTextToAnyOpen`,
        // which delivers only when exactly ONE connection exists and otherwise
        // refuses to guess — so we never default to the literal `web-anon` key
        // when real peers are connected.
        if (!ctx.to || !transport.sendText(ctx.to, ctx.text, id)) {
          transport.sendTextToAnyOpen(ctx.text);
        }
        return { receipt: buildClawReceipt(id), messageId: id };
      },
    },
  });
}

/** Resolve the configured streaming mode for this channel's config section. */
export function resolveStreamingMode(
  channelConfig: unknown,
): StreamingMode {
  // `entry` is the channel config section; the SDK reads `entry.streaming.mode`
  // (or legacy preview fields). Default "off" so non-progress configs keep the
  // plain no-draft path. Verified: resolveChannelPreviewStreamMode(entry,
  // defaultMode) -> StreamingMode, dist/plugin-sdk/streaming-DZCVNyI3.d.ts:152;
  // StreamingMode = "off"|"partial"|"block"|"progress" (types.base-CrXPFJf5.d.ts:23).
  return resolveChannelPreviewStreamMode(
    channelConfig as never,
    "off",
  );
}

/**
 * Per-turn progress-draft controller for one originating session.
 *
 * Composes a rolling "Working… / 🔎 … / 🛠️ …" text block from agent tool/item
 * progress events and pushes it to the widget via the transport's `progress`
 * frame, throttled by `createDraftStreamLoop`
 * (dist/plugin-sdk/draft-stream-controls-C4f0z7_6.d.ts: `update(text)`/`flush()`
 * backed by `sendOrEditStreamMessage(text)`). All frames reuse a single draft
 * `id` so the widget updates ONE bubble; `finalize(text)` reuses that id.
 */
export type ProgressDraftController = {
  /** The stable draft/final id shared by every frame of this turn. */
  readonly id: string;
  /**
   * True once at least one `progress` frame has been emitted to the widget, so
   * a working bubble is currently shown. The error-recovery path uses this to
   * decide whether the widget needs a terminal frame to settle the bubble.
   */
  readonly started: boolean;
  /** Record a structured progress event and refresh the draft. */
  pushEvent: (input: ChannelProgressDraftLineInput) => void;
  /**
   * Replace the cumulative answer text and refresh the draft (partial mode).
   * Core's `onPartialReply` delivers the FULL assistant text so far each call
   * (`text` is cumulative: `${assistantTextByItem.get(itemId) ?? ""}${delta}`,
   * verified: dist/run-attempt-DRhLt3eF.js:4088-4097), so we REPLACE rather than
   * append. Once answer text is present the draft body becomes that answer (the
   * "Label…"/tool scaffold is dropped — the answer replaces the working view).
   * Empty/undefined text is a no-op so a trailing empty frame can't clobber a
   * non-empty draft.
   */
  pushAnswerText: (text: string) => void;
  /**
   * Mark an assistant-message boundary (partial mode). Core's cumulative
   * `onPartialReply.text` is PER-itemId: on a reply with multiple `final_answer`
   * assistant messages, the next item's partials restart from `""`. Without
   * this, our REPLACE semantics would make the already-streamed text of the
   * prior message visibly vanish until the final lands. Core fires
   * `onAssistantMessageStart` once per assistant message start — including
   * before the FIRST message (verified: dist/run-attempt-DRhLt3eF.js:4083-4086);
   * so this rolls the current `answerText` into an accumulated prefix and resets
   * it. The first-message call is a no-op (answerText empty).
   */
  handleAssistantMessageBoundary: () => void;
  /** Push the freshest pending draft text to the socket now. */
  flush: () => Promise<void>;
  /**
   * Read-only snapshot of the draft text the flush loop would currently send —
   * the streamed answer body (partial mode) or the "Working…" scaffold + tool
   * lines. Returns "" when nothing has been pushed yet (there is no scaffold
   * worth preserving). Side-effect-free: used by the aborted-turn defensive
   * finalize (inbound.ts) to settle the bubble with the streamed content alone
   * (no marker).
   */
  snapshotText: () => string;
  /**
   * Finalize the draft into the final answer (reuses the draft id). Idempotent:
   * the first call finalizes and stops the loop; later calls are no-ops so the
   * normal path and the error-recovery path can't double-finalize.
   */
  finalize: (text: string) => Promise<void>;
  /**
   * Stop the draft loop without sending a final frame. Used on cleanup paths so
   * a late background throttled flush can't race error handling. Idempotent.
   */
  stop: () => void;
};

export function createProgressDraftController(params: {
  transport: WebChannelTransport;
  sessionKey: string;
  turnId?: string;
  /** Channel config section (for label/maxLines/line formatting). */
  channelConfig: unknown;
  throttleMs?: number;
}): ProgressDraftController {
  const { transport, sessionKey, channelConfig } = params;
  const id = nextMessageId();

  const label =
    resolveChannelProgressDraftLabel({ entry: channelConfig as never, seed: sessionKey }) ??
    "Working";
  const maxLines = resolveChannelProgressDraftMaxLines(channelConfig as never, 6);

  // Rolling, de-duplicated tool/item lines (most-recent-last, capped).
  const lines: string[] = [];
  // Cumulative answer text streamed via onPartialReply (partial mode only).
  // Non-empty once the agent starts emitting final-answer text; it then owns
  // the whole draft body (see composeText). `answerPrefix` accumulates the text
  // of ALREADY-COMPLETED assistant messages (per-itemId partials restart from
  // ""), so a multi-message reply doesn't visibly drop earlier text — see
  // handleAssistantMessageBoundary.
  let answerText = "";
  let answerPrefix = "";
  // Count of message boundaries we ALREADY rolled up ourselves because we
  // detected the seam from the partial stream before core's
  // `onAssistantMessageStart` arrived (or when it never arrives). A belated
  // start event for such an already-rolled seam must be a no-op — see
  // handleAssistantMessageBoundary. Guards against a double-roll.
  let absorbedMissedBoundaries = 0;
  let stopped = false;
  let started = false;
  let finalized = false;

  // The full streamed answer body so far = completed messages + current one.
  const answerBody = (): string => answerPrefix + answerText;

  // Roll the just-completed message's text into the accumulated prefix and
  // reset the per-item cumulative buffer for the next message. No-op when
  // there is nothing to roll (answerText empty), so a redundant/leading
  // boundary never appends an empty "\n\n" segment.
  const rollCurrentIntoPrefix = (): void => {
    if (answerText.length === 0) return;
    answerPrefix += answerText + "\n\n";
    answerText = "";
  };

  const composeText = (): string => {
    // Once answer text is streaming, it REPLACES the working scaffold (the
    // "Label…" header + tool lines) — matching draft.update-style text
    // replacement. Before any answer text arrives, show the working scaffold.
    const body = answerBody();
    if (body.length > 0) return body;
    const shown = lines.slice(-maxLines);
    return [`${label}…`, ...shown].join("\n");
  };

  // True when the draft has any content worth flushing before finalize — a
  // tool/item line OR pending streamed answer text (a partial-mode no-tool turn
  // has no lines but must still flush its answer text before finalizing).
  const hasPendingContent = (): boolean => lines.length > 0 || answerBody().length > 0;

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (stopped) return false;
    const sent = transport.sendProgress(sessionKey, id, text, params.turnId);
    // Track that a working bubble is now shown to the widget, so the
    // error-recovery path knows it must emit a terminal frame to settle it.
    if (sent) started = true;
    return sent;
  };

  const loop: DraftStreamLoop = createDraftStreamLoop({
    throttleMs: params.throttleMs ?? 600,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  return {
    id,
    get started() {
      return started;
    },
    pushEvent: (input) => {
      // `formatChannelProgressDraftLineForEntry(entry, input, options)` renders
      // one icon+detail line (e.g. "🔎 web_search …"), honoring the channel's
      // command-text config. Verified: dist/plugin-sdk/streaming-DZCVNyI3.d.ts:112.
      const line = formatChannelProgressDraftLineForEntry(channelConfig as never, input);
      if (!line) return;
      if (lines[lines.length - 1] !== line) lines.push(line);
      loop.update(composeText());
    },
    pushAnswerText: (text) => {
      // No-op on empty/undefined so a trailing empty partial can't clobber a
      // non-empty draft. Cumulative REPLACE (not append) — see the doc on the
      // controller type. Routes through the SAME throttled loop as pushEvent,
      // so `started` is set on the first emitted frame identically.
      if (!text) return;
      // Mirror core's Discord partial hygiene exactly (verified:
      // dist/message-handler.process-CcPQD8zK.js:687-700): strip reasoning +
      // inline-directive tags, drop a "Reasoning:\n"-prefixed partial, skip an
      // identical text, and ignore a SHRINKING cumulative text (a shorter
      // prefix of the current one) to avoid backwards flicker. Signatures
      // verified: stripReasoningTagsFromText(text,{mode,trim}): string
      // (chunk-items-DszNsY2v.d.ts:111-114); stripInlineDirectiveTagsForDelivery(
      // text): { text } (:153).
      const cleaned = stripInlineDirectiveTagsForDelivery(
        stripReasoningTagsFromText(text, { mode: "strict", trim: "both" }),
      ).text;
      if (!cleaned || cleaned.startsWith("Reasoning:\n")) return;
      if (cleaned === answerText) return;
      if (
        answerText &&
        answerText.startsWith(cleaned) &&
        cleaned.length < answerText.length
      ) {
        return;
      }
      // MISSED-BOUNDARY DEFENSE. Correctness of the REPLACE semantics rests on
      // core rolling the prior message into the prefix (via
      // handleAssistantMessageBoundary) BEFORE the first partial of a new
      // message. That is an unpinned cross-package contract; if the boundary
      // event is late or never fires, a new message's cumulative partial (which
      // restarts from "") would otherwise CLOBBER the prior message's streamed
      // text and later duplicate it against the assembled final.
      //
      // Within a single message the cumulative `text` only grows, so each
      // partial has the current body as a PREFIX. A partial that is neither an
      // extension of `answerText` nor a shrinking prefix of it (both handled
      // above) has therefore DIVERGED — a new message began without a boundary.
      // We perform the same prefix-rollup the boundary would have and count it,
      // so a belated boundary for this seam degrades to a no-op instead of
      // rolling twice.
      //
      // NOTE: core's `onPartialReply` payload carries no itemId in the pinned
      // dist (PartialReplyPayload = { text; delta? }), so this seam is detected
      // from the cumulative text, not an itemId compare.
      if (answerText.length > 0 && !cleaned.startsWith(answerText)) {
        rollCurrentIntoPrefix();
        absorbedMissedBoundaries += 1;
      }
      answerText = cleaned;
      loop.update(composeText());
    },
    handleAssistantMessageBoundary: () => {
      // Roll the just-completed message's text into the prefix and reset the
      // per-item cumulative buffer for the next message. No-op before the first
      // message (answerText empty). No loop.update: the composed body is
      // unchanged at the boundary (answerPrefix += answerText; answerText = "")
      // so nothing visually changes until the next partial arrives. The final
      // deliver settles the bubble with the fully assembled reply, so any
      // prefix-vs-final join divergence (e.g. separator spacing) is transient
      // and self-correcting.
      //
      // IDEMPOTENCY: if the partial-ingest path already detected and rolled this
      // seam (a boundary that arrived late, after the new message's first
      // partial), consume the count and no-op — otherwise we would roll the new
      // (in-progress) message's text into the prefix a second time.
      if (absorbedMissedBoundaries > 0) {
        absorbedMissedBoundaries -= 1;
        return;
      }
      rollCurrentIntoPrefix();
    },
    flush: () => loop.flush(),
    snapshotText: () => (hasPendingContent() ? composeText() : ""),
    finalize: async (text) => {
      // Idempotent: the normal delivery path and the error-recovery path may
      // both attempt to finalize; only the first wins so we never send two
      // terminal frames (or finalize onto an already-settled bubble).
      if (finalized) return;
      finalized = true;
      // Flush any pending draft text first so the widget has shown the working
      // bubble at least once (the throttle may not have fired yet for a fast
      // turn). This must run BEFORE we stop the loop, since flush() bails when
      // `isStopped()` is true. Then finalize in place onto the same draft id.
      //
      // TOCTOU hardening: a pending progress `ws.send` can throw if the socket
      // slipped to CLOSING between the OPEN check and the send. We must NOT let
      // that abort finalization — the final answer (and, on the error path, the
      // settling frame) still has to be delivered. So swallow a flush failure
      // and proceed to finalizeDraft regardless.
      if (hasPendingContent()) {
        loop.update(composeText());
        try {
          await loop.flush();
        } catch {
          // Pending preview send failed; deliver the final frame anyway below.
        }
      }
      stopped = true;
      loop.stop();
      await transport.finalizeDraft(sessionKey, id, text, params.turnId);
    },
    stop: () => {
      // Halt the throttled loop so no late background flush can race cleanup.
      // Does NOT send a terminal frame; callers that need the widget to settle
      // a working bubble should use finalize(text) instead.
      stopped = true;
      loop.stop();
    },
  };
}

export type ReasoningStreamUpdate = {
  text?: string;
  isReasoningSnapshot?: boolean;
  requiresReasoningProgressOptIn?: boolean;
};

export type ReasoningDraftController = {
  push: (update: ReasoningStreamUpdate) => void;
  endBurst: () => void;
  stop: () => void;
  readonly started: boolean;
};

/**
 * Normalizes OpenClaw's provider-dependent reasoning updates into cumulative,
 * replace-by-id wire frames. Each `onReasoningEnd` boundary rotates the id so
 * separate reasoning bursts remain distinct in the UI.
 */
export function createReasoningDraftController(params: {
  transport: WebChannelTransport;
  sessionKey: string;
  turnId: string;
}): ReasoningDraftController {
  let id = nextMessageId();
  let currentText = "";
  let stopped = false;
  let started = false;

  const push = (update: ReasoningStreamUpdate): void => {
    if (stopped || update.requiresReasoningProgressOptIn === true) return;
    const text = typeof update.text === "string" ? update.text : "";
    if (text.length === 0) return;

    let next: string;
    if (update.isReasoningSnapshot === true || text.startsWith(currentText)) {
      next = text;
    } else if (currentText.endsWith(text)) {
      next = currentText;
    } else {
      next = currentText + text;
    }
    if (next === currentText) return;
    currentText = next;
    if (params.transport.sendReasoning(params.sessionKey, id, params.turnId, currentText)) {
      started = true;
    }
  };

  return {
    push,
    endBurst: () => {
      if (stopped || currentText.length === 0) return;
      id = nextMessageId();
      currentText = "";
    },
    stop: () => {
      stopped = true;
    },
    get started() {
      return started;
    },
  };
}
