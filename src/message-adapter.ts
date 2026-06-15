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

import { CLAWCHANNEL_ID, ANON_PEER_ID } from "./transport.js";
import type { ClawChannelTransport } from "./transport.js";

/**
 * Stable per-message id we generate for each outbound logical send. This becomes
 * the receipt's primary platform id (the editable handle core would use) AND the
 * WS frame id the widget keys its bubble on, so a progress draft and its final
 * answer share one id.
 */
function nextMessageId(): string {
  return `clawchannel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    results: [{ channel: CLAWCHANNEL_ID, messageId: id }],
    kind: "text",
    sentAt: Date.now(),
  });
}

/**
 * The ClawChannel `message` adapter.
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
export function createClawMessageAdapter(transport: ClawChannelTransport) {
  return defineChannelMessageAdapter({
    id: CLAWCHANNEL_ID,
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
        const sessionKey = ctx.to || ANON_PEER_ID;
        if (!transport.sendText(sessionKey, ctx.text, id)) {
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
  /** Push the freshest pending draft text to the socket now. */
  flush: () => Promise<void>;
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
  transport: ClawChannelTransport;
  sessionKey: string;
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
  let stopped = false;
  let started = false;
  let finalized = false;

  const composeText = (): string => {
    const shown = lines.slice(-maxLines);
    return [`${label}…`, ...shown].join("\n");
  };

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (stopped) return false;
    const sent = transport.sendProgress(sessionKey, id, text);
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
    flush: () => loop.flush(),
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
      if (lines.length > 0) {
        loop.update(composeText());
        try {
          await loop.flush();
        } catch {
          // Pending preview send failed; deliver the final frame anyway below.
        }
      }
      stopped = true;
      loop.stop();
      await transport.finalizeDraft(sessionKey, id, text);
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
