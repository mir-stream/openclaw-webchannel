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

import { WEBCHANNEL_ID } from "./channel-contract.js";
import type { WebChannelPeerChannel } from "./channel-contract.js";

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
export function createClawMessageAdapter(transport: WebChannelPeerChannel) {
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
        // absent or the targeted send fails, throw before fabricating any
        // receipt (P0-1 removed recipient guessing; P0-4 makes failure honest).
        //
        // P0-4 (review R2): throwing is safe ONLY because core never re-sends a
        // thrown outbound. Traced in openclaw 2026.6.10 (the installed version and
        // the floor of the `>=2026.6.10` peer range): `durableFinal.capabilities.
        // text` below makes this channel eligible for core's durable delivery
        // queue, whose `failDelivery` does NOT drop the entry (it bumps retryCount
        // and leaves it pending for `recoverPendingDeliveries`) — but core stamps
        // `send_attempt_started` immediately BEFORE calling us, and its drain
        // refuses to blindly replay an entry in that state unless the adapter
        // supplies `reconcileUnknownSend`, which we deliberately do not. So a
        // thrown send moves to failed, never re-sent. Adding a
        // `reconcileUnknownSend` here, or a core bump, re-opens the blind-replay
        // path → SILENT DUPLICATE DELIVERY. Re-verify then.
        if (!ctx.to) {
          throw new Error("[webchannel] message.send.text failed: ctx.to is absent");
        }
        if (!transport.sendText(ctx.to, ctx.text, id)) {
          throw new Error(
            `[webchannel] message.send.text failed: targeted send returned false for peer ${ctx.to}`,
          );
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
 * One assistant message's live draft lane (#94).
 *
 * A turn can contain SEVERAL completed assistant messages. Each one owns its
 * own lane: its own wire id, its own streamed body, and its own terminal frame.
 * At a message boundary the active lane settles into its own bubble and a fresh
 * lane (new id) becomes active, so the live view ends up with the same number
 * of bubbles, in the same order, as the transcript has messages.
 */
type AssistantDraftLane = {
  /** 0 = the turn's first assistant message; incremented on every rotation. */
  generation: number;
  /** The wire id every frame of THIS message uses (progress + terminal). */
  id: string;
  /** Cleaned cumulative partial text of THIS message (REPLACE semantics). */
  answerText: string;
  /** `onBlockReplyQueued` payloads recorded against this lane, in order. */
  queuedBlocks: Array<{ text?: string; assistantMessageIndex?: number }>;
  /**
   * Adopted from the first queued block that carries one. A LATER block whose
   * index differs belongs to the next assistant message and rotates this lane
   * (see recordQueuedBlock). Read only from `onBlockReplyQueued`'s
   * `BlockReplyContext` — never at the delivery seam, whose
   * `ChannelDeliveryInfo` is `{ kind }` and carries no index at all.
   */
  assistantMessageIndex?: number;
  /** True once this lane emitted at least one `progress` frame. */
  started: boolean;
  settled: boolean;
  /** Per-lane settle latch (see settleLane / finalize). */
  settleResult?: Promise<boolean>;
};

/**
 * One `onPartialReply` payload, narrowed to the fields we consume.
 * `PartialReplyPayload = Pick<ReplyPayload,"text"|"mediaUrls"> & { delta?;
 * replace?: true }` (verified: dist/plugin-sdk/types-DNy-f8Hr.d.ts:200).
 * `mediaUrls` is intentionally ignored — this draft lane is text-only.
 */
export type PartialAnswerUpdate = { text?: string; delta?: string; replace?: true };

/**
 * Per-turn progress-draft controller for one originating session.
 *
 * Composes a rolling "Working… / 🔎 … / 🛠️ …" text block from agent tool/item
 * progress events and pushes it to the widget via the transport's `progress`
 * frame, throttled by `createDraftStreamLoop`
 * (dist/plugin-sdk/draft-stream-controls-C4f0z7_6.d.ts: `update(text)`/`flush()`
 * backed by `sendOrEditStreamMessage(text)`).
 *
 * #94 — ONE ROTATABLE LANE PER ASSISTANT MESSAGE. Frames carry the ACTIVE
 * lane's id, so the widget updates one bubble per assistant message; at a
 * message boundary the active lane settles into its own bubble (its own
 * terminal frame) and a fresh lane with a fresh id takes over. The previous
 * model minted one id per TURN and merged every message into one body, so the
 * final frame replaced that merged bubble with the LAST message alone and the
 * earlier text the user had already watched stream was erased from the live
 * view.
 *
 * Message ownership comes from structured signals, never from comparing one
 * message's text to another's — a final that quotes or repeats the previous
 * message is still its own bubble. Three signals rotate a lane, in descending
 * order of how often the pinned core actually produces them:
 *
 *  1. an `assistantMessageIndex` CHANGE across `onBlockReplyQueued` payloads
 *     (`BlockReplyContext.assistantMessageIndex`, types-DNy-f8Hr.d.ts:172) —
 *     the authoritative per-message identity core hands a plugin, and the same
 *     signal core's own channels rotate on;
 *  2. a non-`replace` partial whose cumulative text DIVERGES from the streamed
 *     body — not a content-identity guess but detection that the STREAM
 *     restarted, which is what a per-item cumulative reset looks like from
 *     here. In the pinned core this is the primary trigger for a partial-mode
 *     multi-message turn (see 3);
 *  3. `onAssistantMessageStart`. Advertised as "a new assistant message
 *     started". The two runners THIS channel's turns go through latch it to
 *     fire once per RUN: `dist/run-attempt-DRhLt3eF.js:4083-4085` sets
 *     `assistantStarted` (reset nowhere but the constructor at :3876) and
 *     `dist/btw-CDO5476N.js:564`/:597-599 does the same. A THIRD path in the
 *     bundle does fire it per message — `dist/selection-BfRwHcjH.js:3788-3793`
 *     (`handleMessageStart`, no latch) plus the stream-item-change call at
 *     :3860-3865, wired at :13601 and reached from
 *     `dist/embedded-agent-BgF2MOkH.js:3092`. So on our paths it lands once, at
 *     the first delta, when the lane is still empty and rotation correctly
 *     no-ops; on that third path it behaves as advertised. Either way this
 *     handler is correct — a per-message boundary settles and rotates, a
 *     once-per-run one no-ops on the empty lane — so it stays wired as the
 *     contract's stated signal.
 */
export type ProgressDraftController = {
  /** The ACTIVE lane's draft/final id (rotates at each message boundary). */
  readonly id: string;
  /**
   * True once the ACTIVE lane has emitted at least one `progress` frame, so a
   * working bubble is currently shown for it. The error-recovery path uses this
   * to decide whether the widget needs a terminal frame to settle that bubble.
   * A freshly rotated lane with no assistant text yet has never emitted a frame
   * (§6.2-2b), so it reads false and nothing settles it — no empty bubble.
   */
  readonly started: boolean;
  /** Record a structured progress event and refresh the draft. */
  pushEvent: (input: ChannelProgressDraftLineInput) => void;
  /**
   * Ingest one `onPartialReply` payload into the ACTIVE lane (partial mode).
   * Core's `onPartialReply` delivers the FULL assistant text so far each call
   * (`text` is cumulative: `${assistantTextByItem.get(itemId) ?? ""}${delta}`,
   * verified: dist/run-attempt-DRhLt3eF.js:4088-4097), so we REPLACE rather
   * than append. Once answer text is present the lane's body becomes that
   * answer (the "Label…"/tool scaffold is dropped — the answer replaces the
   * working view). An empty update is a no-op so a trailing empty frame can't
   * clobber a non-empty draft. `replace: true` is core's explicit "same
   * message, rewritten" signal and NEVER rotates.
   */
  pushAnswerText: (update: PartialAnswerUpdate) => void;
  /**
   * Mark an assistant-message boundary (`onAssistantMessageStart`, partial
   * mode). Settles the active lane into its own bubble and rotates to a fresh
   * lane. A boundary with nothing to settle (the leading one, a redundant
   * repeat, or a lane already rotated by one of the other two triggers)
   * neither settles nor rotates, so no empty bubble is ever created.
   *
   * In the pinned core both runners latch this event to once per RUN (see the
   * controller doc), so it fires at the first delta and no-ops on the empty
   * first lane. It remains wired as the contract's stated boundary signal.
   */
  handleAssistantMessageBoundary: () => void;
  /**
   * Record one `onBlockReplyQueued` payload against the ACTIVE lane (§6.2-4/5),
   * and rotate when its `assistantMessageIndex` shows the block belongs to a
   * NEW assistant message. Blocks are also what a lane settles from when its
   * message produced no partials at all. Recording never emits a `progress`
   * frame, and a same-index block never rotates: one block is NOT one assistant
   * message, and a lane can receive several.
   */
  recordQueuedBlock: (block: { text?: string; assistantMessageIndex?: number }) => void;
  /** Push the freshest pending draft text to the socket now. */
  flush: () => Promise<void>;
  /**
   * Read-only snapshot of the draft text the flush loop would currently send
   * for the ACTIVE LANE — its streamed answer body (partial mode) or, for the
   * first lane only, the "Working…" scaffold + tool lines. Returns "" when the
   * active lane has nothing worth settling (there is no scaffold worth
   * preserving, and a rotated lane with no text must not produce a bubble).
   * Side-effect-free: used by the aborted-turn defensive finalize (inbound.ts)
   * to settle the bubble with the streamed content alone (no marker).
   */
  snapshotText: () => string;
  /**
   * Finalize the ACTIVE lane into the final answer (reusing that lane's id) and
   * end the turn's streaming. Idempotent PER LANE: the first call for a lane
   * finalizes and stops the loop; later calls return that first attempt's
   * cached boolean so callers never retry or observe `undefined`. A lane
   * already settled at a message boundary is likewise never settled twice.
   */
  finalize: (text: string) => Promise<boolean>;
  /**
   * Stop the draft loop without sending a final frame. Used on cleanup paths so
   * a late background throttled flush can't race error handling. Idempotent.
   */
  stop: () => void;
};

/**
 * Build the per-turn controller.
 *
 * SERIALIZATION (§6.3). Every lane mutation below is SYNCHRONOUS and each one
 * try/catches its own transport call. `transport.sendProgress` /
 * `transport.finalizeDraft` are synchronous (channel-contract.ts:41-44), so
 * ordering never depends on whether core awaits the Promise our callbacks may
 * return — the assumption §6.3 refuses to rely on. The only async step is the
 * pre-finalize `loop.flush()`. A synchronous chain is strictly stronger than a
 * promise queue here: it cannot leave a wedged or rejected tail, so lane A
 * failing to settle never blocks lane B (§8-1).
 */
export function createProgressDraftController(params: {
  transport: WebChannelPeerChannel;
  sessionKey: string;
  turnId?: string;
  /** Channel config section (for label/maxLines/line formatting). */
  channelConfig: unknown;
  throttleMs?: number;
  /**
   * Host logger. Lane rotations are recorded at `info` — §6.5.1 requires only
   * that a rotation is never SILENT, and the rotation paths here are ordinary
   * healthy-turn behaviour, not contract violations. `warn` is reserved for a
   * real fault: a lane whose terminal frame threw out of the transport.
   */
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}): ProgressDraftController {
  const { transport, sessionKey, channelConfig, logger } = params;

  const label =
    resolveChannelProgressDraftLabel({ entry: channelConfig as never, seed: sessionKey }) ??
    "Working";
  const maxLines = resolveChannelProgressDraftMaxLines(channelConfig as never, 6);

  // Rolling, de-duplicated tool/item lines (most-recent-last, capped). Turn-wide
  // and volatile: only the FIRST lane ever renders them (see composeText).
  const lines: string[] = [];
  // Count of message seams we ALREADY rotated on one of the other two triggers
  // (a diverged partial, or an assistantMessageIndex change on a queued block)
  // before `onAssistantMessageStart` arrived for that seam. A belated start
  // event for an already-rotated seam must be a no-op — see
  // handleAssistantMessageBoundary. The empty-lane guard there is NOT enough on
  // its own: a divergence rotation hands the diverged text straight to the new
  // lane, so a late boundary would find a non-empty lane and split one message
  // into two bubbles.
  let absorbedMissedBoundaries = 0;
  let stopped = false;

  const newLane = (generation: number): AssistantDraftLane => ({
    generation,
    id: nextMessageId(),
    answerText: "",
    queuedBlocks: [],
    started: false,
    settled: false,
  });

  /**
   * Every lane of this turn, oldest first. Kept (rather than only the active
   * one) so a queued block that drains LATE can be routed back to the lane that
   * owns it instead of being mistaken for a new message — see recordQueuedBlock.
   */
  const lanes: AssistantDraftLane[] = [newLane(0)];
  /** The lane every ingest path acts on. `deliver` acts on this one too. */
  let active = lanes[0]!;
  /**
   * Which lane owns each `assistantMessageIndex` we have seen. Ownership is
   * assigned by ORDINAL, not by the index value: blocks drain in index order on
   * a serialized chain, so the n-th distinct index ever seen belongs to the n-th
   * lane. That holds whatever base the indices start from and however sparse
   * they are, and — unlike inferring from the value — it stays correct when a
   * lane was created by a partial divergence while an earlier message's block
   * was still draining. This map is the single source of truth for index
   * ownership; the ordinal is simply its size.
   *
   * INVARIANT: one lane holds at most ONE key, so `laneByIndex.size` never
   * exceeds `lanes.length`. When an empty lane is reused for a later index
   * (see recordQueuedBlock) its previous key is DELETED before the new one is
   * set — do not simply add the second key. Two keys on one lane inflate the
   * ordinal, which then points past the lanes that exist and makes the next
   * block read as a new message: the live lane gets settled early and the
   * message it holds is shown twice.
   *
   * KNOWN RESIDUAL, DELIBERATELY DEFERRED (#94 review, "Y2"). A lane whose
   * message was closed by its own TEXT-LESS block still holds no `answerText`,
   * so the next message's partials find nothing to diverge from and are
   * absorbed into it. That message's own block then reads as a new one, and the
   * text ends up settling twice — one duplicated bubble, never erasure. The
   * close is a partial-path rotation when the active lane has a claimed index
   * AND an empty `answerText`: for a lane in that state the block already
   * closed its message, so a partial genuinely starts the next one. It is
   * sound and was measured to fix the case; it was declined on cost, because
   * it adds a THIRD rotation trigger to the hottest path, and it needs core to
   * emit text-less blocks with distinct indices before any assistant text in
   * the turn. Tracked as a follow-up, not an oversight.
   */
  const laneByIndex = new Map<number, AssistantDraftLane>();
  /**
   * The lane whose text is sitting in the throttled loop. The pending text is
   * remembered TOGETHER with the lane it belongs to, so a late background flush
   * is evaluated against that lane's state rather than whatever lane happens to
   * be active by then.
   */
  let pendingSendLane: AssistantDraftLane | undefined;

  const composeText = (): string => {
    // Once answer text is streaming, it REPLACES the working scaffold (the
    // "Label…" header + tool lines) — matching draft.update-style text
    // replacement.
    if (active.answerText.length > 0) return active.answerText;
    // §6.2-2b: a ROTATED lane emits nothing until it has real assistant text.
    // The protocol has no bubble-delete frame (OutboundWsMessage carries only
    // `progress`/`agent_message`), so any id we show must later be settled —
    // and settling a scaffold would promote "work between messages" to a
    // completed assistant message (§7). The FIRST lane keeps today's scaffold
    // behaviour exactly; visibility of inter-message work is #96.
    if (active.generation > 0) return "";
    const shown = lines.slice(-maxLines);
    return [`${label}…`, ...shown].join("\n");
  };

  // True when the ACTIVE lane has content worth flushing/settling — streamed
  // answer text, or (first lane only) at least one tool/item line. A bare
  // "Working…" header with no lines is not content.
  const hasPendingContent = (): boolean =>
    active.answerText.length > 0 || (active.generation === 0 && lines.length > 0);

  /** Queue the active lane's current body onto the throttled loop. */
  const refresh = (): void => {
    const text = composeText();
    if (!text) return;
    pendingSendLane = active;
    loop.update(text);
  };

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (stopped) return false;
    const lane = pendingSendLane;
    // A frame whose lane already settled would either resurrect a settled
    // bubble or, worse, paint stale text onto the wrong id after a rotation.
    if (!lane || lane.settled) return false;
    const sent = transport.sendProgress(sessionKey, lane.id, text, params.turnId);
    // Track that a working bubble is now shown for THAT lane, so the
    // error-recovery path knows it must emit a terminal frame to settle it.
    if (sent) lane.started = true;
    return sent;
  };

  const loop: DraftStreamLoop = createDraftStreamLoop({
    throttleMs: params.throttleMs ?? 600,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  /**
   * The text a lane settles with (§6.2-4): the cleaned cumulative snapshot the
   * user last saw when the message streamed, else the queued block payloads in
   * the order they were recorded. A lane with neither has nothing to settle.
   *
   * KNOWN COSMETIC DIVERGENCE: core's own accumulator joins a message's blocks
   * with a single "\n" (dist/dispatch-B2e1grFo.js:1852-1855) where this uses
   * "\n\n", so a BLOCK-ONLY lane's live bubble can be spaced differently from
   * its transcript row. Body equality is explicitly not a completion condition
   * (§13); the hydrate path adopts the canonical text.
   */
  const laneBody = (lane: AssistantDraftLane): string => {
    if (lane.answerText.length > 0) return lane.answerText;
    return lane.queuedBlocks
      .map((block) => block.text)
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .join("\n\n");
  };

  /**
   * Settle ONE lane with its own terminal frame. The latch is per lane, so a
   * boundary-settled lane and a later `finalize` of another lane are
   * independent (§6.2-8). A transport throw is logged and resolves `false`: it
   * must never escape a callback-axis path, or lane A's failure would stop lane
   * B from ever settling (§8-1).
   */
  const settleLane = (lane: AssistantDraftLane, text: string): Promise<boolean> => {
    if (lane.settleResult) return lane.settleResult;
    lane.settled = true;
    let resolveSettle!: (v: boolean) => void;
    lane.settleResult = new Promise<boolean>((resolve) => { resolveSettle = resolve; });
    let sent = false;
    try {
      sent = transport.finalizeDraft(sessionKey, lane.id, text, params.turnId);
    } catch (err) {
      logger?.warn?.(
        `[webchannel] draft lane ${lane.id} (generation ${lane.generation}) failed to settle: ${String(err)}`,
      );
      sent = false;
    }
    resolveSettle(sent);
    return lane.settleResult;
  };

  /** Start a fresh lane (fresh id) for the next assistant message. */
  const rotate = (): void => {
    active = newLane(active.generation + 1);
    lanes.push(active);
  };

  /**
   * Append a block to a lane. A settled lane's body is already on the wire and
   * the protocol cannot amend it, so recording there could only mislead a later
   * reader of the lane; the per-lane settle latch independently guarantees no
   * second frame is ever emitted for it.
   */
  const recordBlockOnLane = (
    lane: AssistantDraftLane,
    block: { text?: string; assistantMessageIndex?: number },
  ): void => {
    if (lane.settled) return;
    lane.queuedBlocks.push({
      text: block.text,
      assistantMessageIndex: block.assistantMessageIndex,
    });
  };

  /**
   * Bind an assistant-message index to the lane that owns that message. A lane
   * reclaimed for a later index RELEASES its previous key first, keeping the
   * one-key-per-lane invariant documented at `laneByIndex`. A late block for
   * the released index then misses the map and is dropped by the monotonic
   * guard — correct, because a lane is only ever reclaimed when it had no body
   * to show, which is to say that index contributed nothing visible.
   */
  const claimIndexForLane = (lane: AssistantDraftLane, index: number): void => {
    if (lane.assistantMessageIndex !== undefined) {
      laneByIndex.delete(lane.assistantMessageIndex);
    }
    lane.assistantMessageIndex = index;
    laneByIndex.set(index, lane);
  };

  /** Highest index any lane has claimed, read from the map (no shadow state). */
  const highestClaimedIndex = (): number | undefined => {
    let highest: number | undefined;
    for (const index of laneByIndex.keys()) {
      if (highest === undefined || index > highest) highest = index;
    }
    return highest;
  };

  return {
    get id() {
      return active.id;
    },
    get started() {
      return active.started;
    },
    pushEvent: (input) => {
      // `formatChannelProgressDraftLineForEntry(entry, input, options)` renders
      // one icon+detail line (e.g. "🔎 web_search …"), honoring the channel's
      // command-text config. Verified: dist/plugin-sdk/streaming-DZCVNyI3.d.ts:112.
      const line = formatChannelProgressDraftLineForEntry(channelConfig as never, input);
      if (!line) return;
      if (lines[lines.length - 1] !== line) lines.push(line);
      refresh();
    },
    pushAnswerText: (update) => {
      // Core always sends the cumulative `text` today; the `delta` branch is a
      // FALLBACK so an absent `text` cannot silently drop content, not the
      // primary path.
      const raw =
        typeof update.text === "string" && update.text.length > 0
          ? update.text
          : typeof update.delta === "string" && update.delta.length > 0
            ? active.answerText + update.delta
            : undefined;
      if (raw === undefined) return;
      // Mirror core's Discord partial hygiene exactly (verified:
      // dist/message-handler.process-CcPQD8zK.js:687-700): strip reasoning +
      // inline-directive tags, drop a "Reasoning:\n"-prefixed partial, skip an
      // identical text, and ignore a SHRINKING cumulative text (a shorter
      // prefix of the current one) to avoid backwards flicker. Signatures
      // verified: stripReasoningTagsFromText(text,{mode,trim}): string
      // (chunk-items-DszNsY2v.d.ts:111-114); stripInlineDirectiveTagsForDelivery(
      // text): { text } (:153).
      const cleaned = stripInlineDirectiveTagsForDelivery(
        stripReasoningTagsFromText(raw, { mode: "strict", trim: "both" }),
      ).text;
      if (!cleaned || cleaned.startsWith("Reasoning:\n")) return;
      if (cleaned === active.answerText) return;
      // `replace: true` is core's explicit "same message, rewritten" signal, so
      // both guards below are skipped: a rewrite legitimately shrinks or
      // diverges, and it must NEVER rotate (§6.5.1 pins the defensive-rotation
      // surface to the UNMARKED divergence case alone).
      if (update.replace !== true) {
        // SHRINK GUARD (predates #94): a cumulative text that is a shorter
        // prefix of the current one is backwards flicker, so it is ignored.
        //
        // KNOWN RESIDUAL (#94, F6): a NEW message whose text happens to be a
        // strict prefix of the previous message's ("Hello world" then "Hello")
        // is indistinguishable from flicker at this seam — nothing in the text
        // tells the two apart, and no structured signal is present on this
        // path. It is therefore absorbed into the current lane, and the failure
        // mode here is ERASURE (the final settles the old lane's id with the
        // new message's text), not the duplication the rotation paths risk.
        // What recovers it is the index axis: once the messages' blocks drain
        // with distinct `assistantMessageIndex` values, recordQueuedBlock lanes
        // them correctly. Do NOT try to close this with a content heuristic —
        // that trades a rare erasure for a common one.
        if (
          active.answerText &&
          active.answerText.startsWith(cleaned) &&
          cleaned.length < active.answerText.length
        ) {
          return;
        }
        // STREAM-RESTART ROTATION. Core's cumulative `onPartialReply.text` is
        // per-itemId, so the next assistant message's partials restart from
        // "". Within a single message the cumulative text only grows, so each
        // partial has the current body as a PREFIX. A partial that is neither
        // an extension of the lane's body nor a shrinking prefix of it (both
        // handled above) has therefore RESTARTED — a new message began.
        //
        // The comparison is against the whole LANE BODY, not just its streamed
        // text: a lane whose message was block-only has a body made of queued
        // blocks, and the next message's partials must rotate away from it.
        // Gating on `answerText` alone let those partials land on the
        // block-only lane, where `laneBody`'s answerText-first preference then
        // discarded the block text entirely — the exact data loss #94 exists to
        // close, in the one case the index trigger was added for.
        //
        // ACCEPTED TRADE: if a partial for the SAME message ever arrived after
        // that message's own block, this rotates and the message is shown
        // twice. Core emits a block at message completion, after which no
        // further partials for it exist, so that ordering should not occur —
        // and §6.5.1's standing preference is duplication over erasure. It is
        // deliberately NOT narrowed with a content comparison.
        //
        // This is NOT message-identity inference from content (§6.4): it reads
        // the shape of the stream, not the meaning of the text, and the
        // response is to preserve what the user already saw rather than
        // overwrite it.
        //
        // This is the PRIMARY rotation trigger for a partial-mode multi-message
        // turn in the pinned core, because `onAssistantMessageStart` is latched
        // to once per run (see the controller doc) — an ordinary healthy turn
        // takes this path, so the diagnostic is a neutral `info` record of the
        // seam, not a violation report. §6.5.1's requirement is only that a
        // rotation is never SILENT: the one shape this can get wrong (an
        // unmarked same-message rewrite, which core should have marked
        // `replace: true`) shows the user a duplicated bubble for the rest of
        // the session, so it has to be traceable.
        const body = laneBody(active);
        if (body.length > 0 && !cleaned.startsWith(body)) {
          logger?.info?.(
            `[webchannel] partial stream restarted without a boundary event; ` +
              `settling lane ${active.id} (generation ${active.generation}) and rotating`,
          );
          void settleLane(active, body);
          rotate();
          absorbedMissedBoundaries += 1;
        }
      }
      active.answerText = cleaned;
      refresh();
    },
    handleAssistantMessageBoundary: () => {
      // IDEMPOTENCY: if the partial-ingest path already detected and rotated
      // this seam (a boundary that arrived late, after the new message's first
      // partial), consume the count and no-op — otherwise we would settle the
      // new (in-progress) message and rotate a second time.
      if (absorbedMissedBoundaries > 0) {
        absorbedMissedBoundaries -= 1;
        return;
      }
      // Nothing to settle: the leading boundary core fires before the FIRST
      // message, a redundant duplicate boundary, or a lane showing only the
      // volatile tool scaffold (a scaffold is not a completed assistant
      // message, §7). No bubble, no rotation.
      const body = laneBody(active);
      if (!body) return;
      void settleLane(active, body);
      rotate();
    },
    recordQueuedBlock: (block) => {
      // `assistantMessageIndex` is read ONLY here: `BlockReplyContext`
      // (types-DNy-f8Hr.d.ts:172) is the single place the contract exposes it,
      // and the delivery seam's `ChannelDeliveryInfo` is `{ kind }` with no
      // index at all. The index IS a lane's identity — blocks are ROUTED by it,
      // never merely adopted in arrival order.
      //
      // Routing matters because blocks and partials reach us on DIFFERENT
      // clocks. Partials are awaited inline in the delta loop
      // (dist/run-attempt-DRhLt3eF.js:4088-4097), while blocks drain on an async
      // serialized `sendChain` behind a coalescer that only flushes on an index
      // change or an idle timer (dist/block-reply-pipeline-CsIUOKQ6.js:241-246,
      // :299-300). So a block for message N routinely arrives AFTER message
      // N+1's partials have already rotated the lane. Treating that late drain
      // as a new message would settle the current lane a second time.
      const index = block.assistantMessageIndex;
      // No index ("when available", so it is optional): the only lane we can
      // attribute it to is the active one, and it never rotates.
      if (index === undefined) {
        recordBlockOnLane(active, block);
        return;
      }
      // A lane already owns this index — including the active lane, which is
      // the ordinary "several blocks per message" case. Route it home;
      // recordBlockOnLane drops it if that lane has already settled.
      const owner = laneByIndex.get(index);
      if (owner) {
        recordBlockOnLane(owner, block);
        return;
      }
      // A brand-new index arriving BELOW one we have already claimed means the
      // drain order was not monotonic. Drop it rather than let it consume an
      // ordinal, which would shift every later block onto the wrong lane.
      const highest = highestClaimedIndex();
      if (highest !== undefined && index < highest) return;
      // ORDINAL OWNERSHIP. The n-th distinct index belongs to the n-th lane.
      // The one-key-per-lane invariant (see `laneByIndex`) keeps this size from
      // running past `lanes.length`, so the else-branch below is exactly
      // "ordinal === lanes.length".
      //
      // DO NOT "tidy" that else into a strict `=== `. It is written as the
      // complement of `<` on purpose: if the invariant is ever violated again,
      // the complement still settles and rotates — one duplicate bubble —
      // whereas a strict `===` would match neither branch and silently DROP the
      // block, which is erasure. §6.5.1 puts duplication on the acceptable side
      // of that trade, so the failure mode has to stay this way round.
      const ordinal = laneByIndex.size;
      if (ordinal < lanes.length) {
        // That lane already exists — a partial divergence created it while this
        // message's block was still draining, which is the ORDINARY ordering
        // (blocks sit behind a coalescer and a serialized send chain; partials
        // are awaited inline in the delta loop). Bind the index to its real
        // owner and NEVER rotate: rotating here would settle the live lane a
        // second time, leaving two bubbles for one message.
        const owning = lanes[ordinal]!;
        claimIndexForLane(owning, index);
        recordBlockOnLane(owning, block);
        return;
      }
      // No lane exists for this ordinal yet: a message we have not laned at
      // all. This is the trigger that covers a message with NO partials, where
      // the stream-restart check cannot fire.
      const body = laneBody(active);
      if (body) {
        logger?.info?.(
          `[webchannel] queued block opened assistantMessageIndex ${index} ` +
            `beyond the lanes seen so far; settling lane ${active.id} and rotating`,
        );
        void settleLane(active, body);
        rotate();
        // A late `onAssistantMessageStart` for this same seam must not rotate
        // it a second time.
        absorbedMissedBoundaries += 1;
      }
      // An empty body means there is nothing to preserve and so nothing to
      // rotate away FROM — and rotating would strand any scaffold bubble
      // already shown on this id with no way to settle it (the protocol has no
      // delete frame). Reuse the lane and let it own the new index.
      claimIndexForLane(active, index);
      recordBlockOnLane(active, block);
      // Deliberately no refresh(): recording a block must not emit a frame.
    },
    flush: () => loop.flush(),
    snapshotText: () => (hasPendingContent() ? composeText() : ""),
    finalize: (text) => {
      const lane = active;
      // Idempotent PER LANE: the normal delivery path and the error-recovery
      // path may both attempt to finalize, and the lane may already have been
      // settled at a message boundary; only the first wins so we never send two
      // terminal frames for one id (or finalize onto an already-settled bubble).
      if (lane.settleResult) return lane.settleResult;
      // P0-4 (review R2): arm the latch SYNCHRONOUSLY. `lane.settleResult =
      // (async () => {...})()` only assigns once the body first SUSPENDS, and
      // the body reaches `transport.finalizeDraft(...)` with no preceding
      // `await` whenever there is no pending draft content — so the whole
      // terminal-frame send used to run before the latch existed, leaving it
      // unarmed across exactly the stretch it exists to protect (the pre-P0-4
      // code set its `finalized` flag synchronously). Resolving an
      // already-assigned promise WITH the body's promise keeps the
      // cached-result contract: every caller, re-entrant or not, awaits the
      // same single `finalizeDraft` outcome (or rejection).
      let settleFinalize!: (v: boolean | PromiseLike<boolean>) => void;
      lane.settleResult = new Promise<boolean>((resolve) => { settleFinalize = resolve; });
      settleFinalize((async () => {
        // Flush any pending draft text first so the widget has shown the working
        // bubble at least once (the throttle may not have fired yet for a fast
        // turn). This must run BEFORE we stop the loop, since flush() bails when
        // `isStopped()` is true — and BEFORE `lane.settled` is set, since a
        // settled lane's frames are dropped by sendOrEditStreamMessage. Then
        // finalize in place onto that same lane id.
        //
        // TOCTOU hardening: a pending progress `ws.send` can throw if the socket
        // slipped to CLOSING between the OPEN check and the send. We must NOT let
        // that abort finalization — the final answer (and, on the error path, the
        // settling frame) still has to be delivered. So swallow a flush failure
        // and proceed to finalizeDraft regardless.
        if (hasPendingContent()) {
          refresh();
          try {
            await loop.flush();
          } catch {
            // Pending preview send failed; deliver the final frame anyway below.
          }
        }
        stopped = true;
        loop.stop();
        lane.settled = true;
        return transport.finalizeDraft(sessionKey, lane.id, text, params.turnId);
      })());
      return lane.settleResult;
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

/**
 * One `onReasoningStream` payload, narrowed to the fields we consume. The pinned
 * OpenClaw callback delivers `{ text?; mediaUrls?; isReasoningSnapshot? }`
 * (verified: dist/plugin-sdk/types-B70zVumi.d.ts:1737-1741). `mediaUrls` is
 * intentionally ignored — the webchannel reasoning lane is text-only.
 */
export type ReasoningStreamUpdate = {
  text?: string;
  isReasoningSnapshot?: boolean;
};

export type ReasoningDraftController = {
  push: (update: ReasoningStreamUpdate) => void;
  endBurst: () => void;
  stop: () => void;
};

/**
 * Normalizes OpenClaw's reasoning updates into cumulative, replace-by-id wire
 * frames. Each `onReasoningEnd` boundary rotates the id so separate reasoning
 * bursts remain distinct in the UI.
 *
 * VERIFIED CONTRACT (pinned OpenClaw v2026.6.x): every emitter sends either a
 * snapshot or the cumulative FULL text so far — NEVER a bare delta:
 *  - the ACP runner emits the full accumulated text with `isReasoningSnapshot:
 *    true` (dist/run-attempt-DRhLt3eF.js:4114-4117);
 *  - the btw runner emits cumulative full text (`reasoningText += delta` then
 *    emits `reasoningText`, no snapshot flag) (dist/btw-CDO5476N.js:617-627).
 * So normalization is a plain REPLACE: ignore empty/non-string text, no-op an
 * exact duplicate of the current text, otherwise replace and send. No
 * snapshot/startsWith/endsWith/concat heuristic is needed.
 *
 * btw STALE-BURST DEFENSE: the btw `reasoningText` accumulator (declared
 * dist/btw-CDO5476N.js:563) is NEVER reset at `thinking_end` (:626), even though
 * that same event fires `onReasoningEnd`. So a SECOND thinking burst in one
 * attempt emits cumulative text that still carries burst 1's full text as a raw
 * prefix (btw concatenates raw deltas, whitespace and all). Under our per-burst id
 * rotation that would render burst 1 duplicated inside burst 2's lane. We defend
 * with a `stalePrefix`: on `endBurst` we set it to the just-closed burst's LAST
 * RAW payload (that raw cumulative text already contains every prior burst — so
 * assign, don't append our trimmed display text, which loses inter-burst
 * whitespace and misfires from burst 3 on), and on `push` we strip that prefix
 * (plus any leading whitespace) from an incoming cumulative payload before the
 * replace logic runs. The ACP runner cannot hit this — its
 * `maybeEndReasoning` (dist/run-attempt-DRhLt3eF.js:4520-4524) fires
 * `onReasoningEnd` at most once per attempt (a `reasoningEnded` guard). The strip
 * is conservative: a payload that does NOT start with the accumulated prefix
 * falls through unchanged, so the worst case is the pre-fix duplicated display,
 * never lost text — as long as the emitter's accumulator persists for the
 * controller's lifetime (the pinned single-invocation contract). A fresh runner
 * re-streaming byte-identical reasoning into a reused controller could jump-strip
 * mid-stream; no pinned path does that today.
 */
export function createReasoningDraftController(params: {
  transport: WebChannelPeerChannel;
  sessionKey: string;
  turnId: string;
}): ReasoningDraftController {
  let id = nextMessageId();
  let currentText = "";
  // Prefix a later burst's payload carries under btw (stale-burst defense). btw's
  // `reasoningText` is its RAW cumulative accumulator, so the prefix is exactly the
  // last raw payload of the just-closed burst — NOT our trimmed display text (the
  // two differ whenever whitespace separates bursts, e.g. "\n\n" from a thinking
  // model). `endBurst` therefore ASSIGNS `stalePrefix = lastRawText` (the raw
  // payload already contains every prior burst), not `+=` our stripped text.
  let stalePrefix = "";
  // The last raw payload seen this burst (before stripping), captured so endBurst
  // can hand the raw cumulative text to `stalePrefix`.
  let lastRawText = "";
  let stopped = false;

  const push = (update: ReasoningStreamUpdate): void => {
    if (stopped) return;
    const text = typeof update.text === "string" ? update.text : "";
    if (text.length === 0) return;
    // Remember the RAW payload before any stripping (see stalePrefix above).
    lastRawText = text;
    // btw stale-burst defense (see the contract above): a later burst's cumulative
    // payload still carries every prior burst's text as a leading prefix. Strip it
    // (and any whitespace the deltas left between bursts) so this burst's lane
    // shows only its own text. A payload that does not carry the prefix is left
    // as-is (conservative — never drop text we can't confidently attribute).
    let normalized = text;
    if (stalePrefix.length > 0 && normalized.startsWith(stalePrefix)) {
      normalized = normalized.slice(stalePrefix.length).replace(/^\s+/, "");
      if (normalized.length === 0) return;
    }
    // Cumulative/snapshot REPLACE (see the verified contract above): a payload is
    // always the full text so far, so an exact match is a no-op and anything else
    // replaces the current text wholesale.
    if (normalized === currentText) return;
    currentText = normalized;
    params.transport.sendReasoning(params.sessionKey, id, params.turnId, currentText);
  };

  return {
    push,
    endBurst: () => {
      if (stopped || currentText.length === 0) return;
      // The NEXT burst's raw payload carries this closed burst's LAST RAW text as
      // its prefix (btw's accumulator is cumulative and already holds all prior
      // bursts), so assign — don't append our trimmed display text, which would
      // drop any inter-burst whitespace and break the prefix match from burst 3 on.
      stalePrefix = lastRawText;
      id = nextMessageId();
      currentText = "";
    },
    stop: () => {
      stopped = true;
    },
  };
}
