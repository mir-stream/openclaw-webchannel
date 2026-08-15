import {
  defineChannelMessageAdapter,
  createMessageReceiptFromOutboundResults,
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

type LaneResolution = "open" | "unresolved" | "materialized" | "empty";
type LaneFrameType = "progress" | "final";
type DeliveryFailureKind = "false" | "throw";

type DeferredAngleMarkerTail = {
  /** Raw callback prefix before the earliest still-ambiguous `<`. */
  sourcePrefix: string;
  /** Latest cumulative callback observed while this was only a probe. */
  probeSource: string;
  /** Once true, only an ordinary durable final may replace this quarantine. */
  exact: boolean;
  /** Safe only for an incomplete probe after nonempty visible prose. */
  terminalFallbackText?: string;
};

type AssistantDraftLane = {
  generation: number;
  /** Assigned only after a successful first wire frame for this lane. */
  id?: string;
  /** A provisional id is tentative for the duration of one send transaction. */
  tentativeProvisionalId?: string;
  answerText: string;
  /**
   * The last RAW cumulative partial accepted into this lane, before reasoning /
   * inline-directive stripping. Tag stripping makes the CLEANED text
   * non-monotonic (an unclosed `<thinking>` shortens it), so cleaned text alone
   * cannot tell tag noise from a new assistant message. The raw stream is the
   * better signal — but NOT a monotonic one, and #94 recorded the opposite
   * ("a provider appending to the same message always extends it"). Measured
   * false on the pinned core 2026.7.1-2: what reaches `onPartialReply` is not
   * the provider's text but `sanitizeUserFacingText(cumulative)`, applied by
   * core to EVERY payload, and its tool-call / `<function_calls>` / `<final>`
   * strippers shorten their output the instant such a tag completes. Feeding
   * `Hello <tool_call>{...}</tool_call> there` one character at a time yields
   * the payload pair `"Hello <tool_call>"` then `"Hello "` — a strict prefix,
   * inside ONE message.
   *
   * Nothing here acts on that, deliberately. #120 (a second message whose whole
   * text is a strict prefix of the first is erased by `finalize`) was attacked
   * by treating a backwards raw as a restart signal, and every variant of that
   * misfires on ordinary tag-bearing turns — see M7h for the defect and M7k for
   * the stream that defeats the cure. The distinction is not in the text; it
   * has to come from the boundary signal. #120 stays open.
   *
   * Used only by the missed-boundary defense.
   */
  lastRawAnswerText: string;
  /** Latest callback source, kept separate while an angle tail is quarantined. */
  lastPartialSourceText: string;
  /** Sticky hold for a distinctive marker that core may erase retroactively. */
  deferredAngleMarkerTail?: DeferredAngleMarkerTail;
  answerRevision: number;
  tentativeBarrierReservationIds: string[];
  closed: boolean;
  resolution: LaneResolution;
  /** Armed only by an attached indexless reservation; terminal drain disarms it. */
  acceptsLateIndexlessReservations: boolean;
  started: boolean;
  settled: boolean;
  failedDeliveryCount: number;
  lastFailedDelivery?: {
    revision: number;
    frameType: LaneFrameType;
    error: DeliveryFailureKind;
  };
  lastProgressAttemptRevision: number;
  settleResult?: Promise<boolean>;
  settleOutcome?: boolean;
};

type ProvisionalClaimOwner =
  | { kind: "lane"; generation: number }
  | { kind: "independent"; deliverySequence: number };

type ProvisionalPreview = {
  id: string;
  text: string;
  revision: number;
  started: boolean;
  scaffoldWriter: "active" | "invalidated";
  claim:
    | { state: "unclaimed" }
    | { state: "reserved"; owner: ProvisionalClaimOwner }
    | { state: "claimed"; owner: ProvisionalClaimOwner };
  settleResult?: Promise<boolean>;
  settleOutcome?: boolean;
};

type TentativeBlockReservation = {
  token: string;
  barrierGeneration?: number;
  assistantMessageIndex?: number;
  state: "pending" | "retired";
};

type TentativeNoticeToken = {
  assistantMessageIndex?: number;
  state: "pending" | "retired";
};

type AuthorizedBlockDisposition = {
  settled: boolean;
  /**
   * What the delivered payload WAS. Recorded at the delivery seam, which is the
   * only place the payload — and therefore its notice flags — is available.
   */
  kind: "block" | "notice";
};

type FinalReconciliationState = {
  ordinaryAnswerSettled: boolean;
  leadingTerminalErrorSeen: boolean;
};

type PendingProgressFrame =
  | { kind: "preview"; revision: number; text: string }
  | { kind: "lane"; generation: number; revision: number; text: string };

type ProgressDraftState = {
  provisionalPreview: ProvisionalPreview;
  lanes: AssistantDraftLane[];
  blockReservations: TentativeBlockReservation[];
  noticeTokens: TentativeNoticeToken[];
  blockDispositions: AuthorizedBlockDisposition[];
  finalReconciliation: FinalReconciliationState;
  lines: string[];
  pendingProgress?: PendingProgressFrame;
  progressTimer?: ReturnType<typeof setTimeout>;
  /** One-shot release of a text-less predecessor that is holding a live lane. */
  emptyPredecessorTimer?: ReturnType<typeof setTimeout>;
  lastProgressSentAt: number;
  firstBoundarySeen: boolean;
  lateReservationEpochOpen: boolean;
  nextTokenSequence: number;
  nextDeliverySequence: number;
  durableDeliverySucceeded: boolean;
  started: boolean;
  stopped: boolean;
};

type SerialQueueTask = {
  label: string;
  run: () => unknown;
  fallback: unknown;
  resolve: (value: unknown) => void;
};

type SerialQueueState = {
  running: boolean;
  tasks: SerialQueueTask[];
};

type NoticeFlags = {
  isStatusNotice?: boolean;
  isFallbackNotice?: boolean;
  isCompactionNotice?: boolean;
};

type ProvisionalReservation = {
  owner: ProvisionalClaimOwner;
  id: string;
  usesPreview: boolean;
};

/** One structured partial update from the public reply callback. */
export type PartialAnswerUpdate = { text?: string; delta?: string; replace?: true };

/**
 * Distinctive angle-led markers stripped by the pinned OpenClaw stream path.
 * The first nine mirror TOOL_CALL_TAG_NAMES. The remaining entries cover the
 * adjacent final, MiniMax, standalone-parameter, memory, and model-token passes
 * without copying any of their payload/close-tag grammars.
 */
const CORE_ANGLE_MARKER_NAMES = [
  "tool_call",
  "tool_calls",
  "tool_result",
  "function_call",
  "function_calls",
  "function_response",
  "function",
  "antml:invoke",
  "antml:parameter",
  "final",
  "minimax:tool_call",
  "invoke",
  "parameter",
] as const;
const MEMORY_MARKER_NAMES = ["relevant_memories", "relevant-memories"] as const;
const XML_NAME_CHAR_RE = /[A-Za-z0-9_.:-]/;
const MODEL_PIPE_CHARS = new Set(["|", "｜"]);

type AngleMarkerCandidate = { start: number; exact: boolean };
type AngleMarkerScan = {
  first?: AngleMarkerCandidate;
  earliestExactStart?: number;
};

function cleanPartialAnswerText(text: string): string {
  return stripInlineDirectiveTagsForDelivery(
    stripReasoningTagsFromText(text, { mode: "strict", trim: "both" }),
  ).text;
}

function classifyMemoryMarkerAt(
  text: string,
  nameStart: number,
): "incomplete" | "exact" | undefined {
  for (const target of MEMORY_MARKER_NAMES) {
    let offset = 0;
    while (
      offset < target.length &&
      nameStart + offset < text.length &&
      text[nameStart + offset]!.toLowerCase() === target[offset]
    ) {
      offset += 1;
    }
    if (offset === target.length) {
      const boundary = text[nameStart + offset];
      if (boundary === undefined || !/\w/.test(boundary)) return "exact";
      continue;
    }
    if (
      nameStart + offset === text.length ||
      text[nameStart + offset] === "<"
    ) {
      return "incomplete";
    }
  }
  return undefined;
}

function classifyAngleMarkerAt(
  text: string,
  start: number,
  nextModelPipe: Int32Array,
): "incomplete" | "exact" | undefined {
  if (text[start] !== "<") return undefined;
  const afterOpen = text[start + 1];
  if (MODEL_PIPE_CHARS.has(afterOpen ?? "")) {
    const closePipe = nextModelPipe[start + 2] ?? -1;
    if (closePipe < 0) return "incomplete";
    const afterClose = text[closePipe + 1];
    if (afterClose === undefined) return "incomplete";
    return afterClose === ">" ? "exact" : undefined;
  }

  let cursor = start + 1;
  while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  if (text[cursor] === "/") {
    cursor += 1;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  }
  // A bare `<` is still a viable distinctive marker prefix. The next name byte
  // either promotes the hold or proves ordinary literal text immediately.
  if (cursor === text.length) return "incomplete";

  const memory = classifyMemoryMarkerAt(text, cursor);
  if (memory) return memory;

  const nameStart = cursor;
  while (XML_NAME_CHAR_RE.test(text[cursor] ?? "")) cursor += 1;
  if (cursor === nameStart) return undefined;
  const fragment = text.slice(nameStart, cursor).toLowerCase();
  for (const name of CORE_ANGLE_MARKER_NAMES) {
    if (fragment === name) return "exact";
    if ((cursor === text.length || text[cursor] === "<") && name.startsWith(fragment)) {
      return "incomplete";
    }
  }
  return undefined;
}

/** One bounded linear scan; no candidate rescans a suffix or sanitizer stage. */
function scanAngleMarkers(text: string): AngleMarkerScan {
  const firstAngle = text.indexOf("<");
  if (firstAngle < 0) return {};

  const nextModelPipe = new Int32Array(text.length + 1);
  let nextPipe = -1;
  nextModelPipe[text.length] = -1;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (MODEL_PIPE_CHARS.has(text[index] ?? "")) nextPipe = index;
    nextModelPipe[index] = nextPipe;
  }

  const result: AngleMarkerScan = {};
  for (let start = firstAngle; start >= 0; start = text.indexOf("<", start + 1)) {
    const classification = classifyAngleMarkerAt(text, start, nextModelPipe);
    if (!classification) continue;
    const candidate = { start, exact: classification === "exact" };
    result.first ??= candidate;
    if (candidate.exact && result.earliestExactStart === undefined) {
      result.earliestExactStart = start;
    }
  }
  return result;
}

function buildDeferredAngleMarkerTail(
  text: string,
  sourcePrefix: string,
  exact: boolean,
): DeferredAngleMarkerTail {
  const hasVisiblePrefix = cleanPartialAnswerText(sourcePrefix).length > 0;
  return {
    sourcePrefix,
    probeSource: text,
    exact,
    terminalFallbackText:
      !exact && hasVisiblePrefix ? cleanPartialAnswerText(text) : undefined,
  };
}

function deferAngleMarkerTail(
  text: string,
  previous?: DeferredAngleMarkerTail,
): {
  visibleText: string;
  deferred?: DeferredAngleMarkerTail;
  alreadyQuarantined?: boolean;
  restart?: boolean;
} {
  if (previous?.exact) {
    return { visibleText: previous.sourcePrefix, deferred: previous, alreadyQuarantined: true };
  }

  const scan = scanAngleMarkers(text);
  if (previous) {
    const anchor = previous.sourcePrefix.length;
    if (!text.startsWith(previous.probeSource)) {
      const cleanPrefix = cleanPartialAnswerText(previous.sourcePrefix).trimEnd();
      const keepsSafePrefix =
        previous.sourcePrefix.length === 0 ||
        text.startsWith(previous.sourcePrefix) ||
        (cleanPrefix.length > 0 && cleanPartialAnswerText(text).startsWith(cleanPrefix));
      if (!keepsSafePrefix) return { visibleText: text, restart: true };
      return {
        visibleText: previous.sourcePrefix,
        deferred: buildDeferredAngleMarkerTail(text, previous.sourcePrefix, true),
        alreadyQuarantined: true,
      };
    }
    if (scan.first?.start === anchor) {
      const nestedExact =
        scan.earliestExactStart !== undefined && scan.earliestExactStart >= anchor;
      return {
        visibleText: previous.sourcePrefix,
        deferred: buildDeferredAngleMarkerTail(
          text,
          previous.sourcePrefix,
          scan.first.exact || nestedExact,
        ),
      };
    }
    // A monotonic continuation proved that the incomplete name was literal.
    // Re-scan below so a later independent candidate can start its own hold.
  }

  if (!scan.first) return { visibleText: text };
  const exact =
    scan.first.exact ||
    (scan.earliestExactStart !== undefined && scan.earliestExactStart >= scan.first.start);
  const sourcePrefix = text.slice(0, scan.first.start);
  return {
    visibleText: sourcePrefix,
    deferred: buildDeferredAngleMarkerTail(text, sourcePrefix, exact),
  };
}

/**
 * Per-turn draft state for partial/progress streaming.
 *
 * The provisional preview is turn-scoped and ownerless until a successful
 * durable delivery claims it. Assistant text is held in ordered, rotatable
 * lanes. Actual block and uncorrelated final payloads never acquire a lane;
 * they are delivered independently with their own sequence and wire id.
 */
export type ProgressDraftController = {
  /**
   * Legacy cleanup signal for inbound: true means some wire frame succeeded
   * while the ordinary-answer terminal slot is still open. Inbound may use it
   * only to decide whether legacy tool-only preview cleanup may be needed. An
   * ownerless provisional preview can make it true while `snapshotText()` is
   * empty, and false after an ordinary answer settles does not mean that no
   * wire activity or durable delivery occurred. Silent completion must call
   * `drain()`; it must not infer an empty lane needs a synthetic stop marker.
   */
  readonly started: boolean;
  /** Queue one tool/item event for the provisional preview writer. */
  pushEvent(input: ChannelProgressDraftLineInput): void;
  /** Queue one cumulative/delta partial update for the current lane. */
  pushAnswerText(update: PartialAnswerUpdate): void;
  /** Close the current assistant lane and open the next ordered lane. */
  handleAssistantMessageBoundary(): void;
  /** Record only tentative ordering/notice state from a queued callback. */
  noteBlockReplyQueued(input: {
    assistantMessageIndex?: number;
    isStatusNotice?: boolean;
    isFallbackNotice?: boolean;
    isCompactionNotice?: boolean;
  }): void;
  /** Deliver an authorized block independently from every assistant lane. */
  deliverAuthorizedBlock(input: {
    text: string;
    isStatusNotice?: boolean;
    isFallbackNotice?: boolean;
    isCompactionNotice?: boolean;
  }): Promise<boolean>;
  /** Retire unambiguous callback lifecycle state without selecting an owner. */
  noteDeliveryLifecycle(
    kind: "skip" | "cancel" | "settled" | "error",
    input: {
      /** Dispatcher callbacks are a union; delivery.onError exposes string. */
      deliveryKind: string;
      assistantMessageIndex?: number;
    } & NoticeFlags,
  ): void;
  /** Use the current lane's one ordinary-answer terminal slot. */
  finalize(text: string): Promise<boolean>;
  /** Deliver a terminal notice/error/uncorrelated final independently. */
  deliverIndependentFinal(input: {
    text: string;
    isStatusNotice?: boolean;
    isFallbackNotice?: boolean;
    isCompactionNotice?: boolean;
  }): Promise<boolean>;
  /** Record that a terminal error preceded any ordinary answer final. */
  noteLeadingTerminalError(): void;
  /** Retire tentative state and settle real text (or a lone tool preview). */
  drain(): Promise<void>;
  /**
   * Side-effect-free snapshot of the current assistant lane only. This can be
   * empty while `started` is true because a provisional tool preview is not
   * lane text; silent completion must call `drain()` rather than
   * `finalize(snapshotText() || marker)`.
   */
  snapshotText(): string;
  /** Flush the newest throttled progress frame through the serial queue. */
  flush(): Promise<void>;
  /** Stop timers and discard pending progress without sending a terminal frame. */
  stop(): void;
};

export function createProgressDraftController(params: {
  transport: WebChannelPeerChannel;
  sessionKey: string;
  turnId?: string;
  channelConfig: unknown;
  throttleMs?: number;
  logger?: { warn?: (message: string) => void; info?: (message: string) => void };
}): ProgressDraftController {
  const { transport, sessionKey, channelConfig, logger } = params;
  const throttleMs = Math.max(0, params.throttleMs ?? 600);
  const label =
    resolveChannelProgressDraftLabel({ entry: channelConfig as never, seed: sessionKey }) ??
    "Working";
  const maxLines = resolveChannelProgressDraftMaxLines(channelConfig as never, 6);

  const newLane = (generation: number): AssistantDraftLane => ({
    generation,
    answerText: "",
    lastRawAnswerText: "",
    lastPartialSourceText: "",
    answerRevision: 0,
    tentativeBarrierReservationIds: [],
    closed: false,
    resolution: "open",
    acceptsLateIndexlessReservations: false,
    started: false,
    settled: false,
    failedDeliveryCount: 0,
    lastProgressAttemptRevision: 0,
  });

  const state: ProgressDraftState = {
    provisionalPreview: {
      id: nextMessageId(),
      text: "",
      revision: 0,
      started: false,
      scaffoldWriter: "active",
      claim: { state: "unclaimed" },
    },
    lanes: [newLane(0)],
    blockReservations: [],
    noticeTokens: [],
    blockDispositions: [],
    finalReconciliation: {
      ordinaryAnswerSettled: false,
      leadingTerminalErrorSeen: false,
    },
    lines: [],
    lastProgressSentAt: 0,
    firstBoundarySeen: false,
    lateReservationEpochOpen: true,
    nextTokenSequence: 0,
    nextDeliverySequence: 0,
    durableDeliverySucceeded: false,
    started: false,
    stopped: false,
  };
  const queue: SerialQueueState = { running: false, tasks: [] };
  let ordinaryFinalSendInProgress = false;

  const warn = (message: string): void => {
    try {
      (logger?.warn ?? console.warn)(`[webchannel] ${message}`);
    } catch {
      // Diagnostics never own the delivery queue's lifecycle.
    }
  };

  const pumpQueue = (): void => {
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.tasks.length > 0) {
        const task = queue.tasks.shift()!;
        try {
          task.resolve(task.run());
        } catch (error) {
          warn(`${task.label} failed without latching the draft queue: ${String(error)}`);
          task.resolve(task.fallback);
        }
      }
    } finally {
      queue.running = false;
    }
  };

  const enqueue = <T>(label: string, run: () => T, fallback: T): Promise<T> =>
    new Promise<T>((resolve) => {
      queue.tasks.push({
        label,
        run,
        fallback,
        resolve: resolve as (value: unknown) => void,
      });
      pumpQueue();
    });

  const currentLane = (): AssistantDraftLane => state.lanes[state.lanes.length - 1]!;

  const isNotice = (input: NoticeFlags): boolean =>
    input.isStatusNotice === true ||
    input.isFallbackNotice === true ||
    input.isCompactionNotice === true;

  const nextBlockToken = (): string => `block-${++state.nextTokenSequence}`;

  const clearProgressTimer = (): void => {
    if (state.progressTimer === undefined) return;
    clearTimeout(state.progressTimer);
    state.progressTimer = undefined;
  };

  const discardPendingProgress = (predicate: (frame: PendingProgressFrame) => boolean): void => {
    if (!state.pendingProgress || !predicate(state.pendingProgress)) return;
    state.pendingProgress = undefined;
    clearProgressTimer();
  };

  const invalidateScaffoldWriter = (): void => {
    state.provisionalPreview.scaffoldWriter = "invalidated";
    discardPendingProgress((frame) => frame.kind === "preview");
  };

  const reserveProvisional = (
    owner: ProvisionalClaimOwner,
    lane?: AssistantDraftLane,
  ): ProvisionalReservation => {
    const preview = state.provisionalPreview;
    if (
      preview.started &&
      !state.durableDeliverySucceeded &&
      preview.claim.state === "unclaimed"
    ) {
      preview.claim = { state: "reserved", owner };
      if (lane) lane.tentativeProvisionalId = preview.id;
      return { owner, id: preview.id, usesPreview: true };
    }
    return { owner, id: nextMessageId(), usesPreview: false };
  };

  const commitReservation = (
    reservation: ProvisionalReservation,
    lane?: AssistantDraftLane,
  ): void => {
    if (reservation.usesPreview) {
      state.provisionalPreview.claim = {
        state: "claimed",
        owner: reservation.owner,
      };
      if (lane) lane.tentativeProvisionalId = undefined;
    }
    // Every successful durable delivery ends the scaffold-writing phase. A
    // fresh-id success must also invalidate it, or a later tool event could
    // create a second scaffold after durable output already exists.
    invalidateScaffoldWriter();
    state.durableDeliverySucceeded = true;
    state.started = true;
  };

  const rollbackReservation = (
    reservation: ProvisionalReservation,
    lane?: AssistantDraftLane,
  ): void => {
    if (!reservation.usesPreview) return;
    state.provisionalPreview.claim = { state: "unclaimed" };
    if (lane) lane.tentativeProvisionalId = undefined;
  };

  const recordLaneFailure = (
    lane: AssistantDraftLane,
    frameType: LaneFrameType,
    error: DeliveryFailureKind,
  ): void => {
    lane.failedDeliveryCount += 1;
    lane.lastFailedDelivery = {
      revision: lane.answerRevision,
      frameType,
      error,
    };
    warn(
      `draft lane generation ${lane.generation} ${frameType} delivery returned ${error}; ` +
        `revision ${lane.answerRevision} remains memory-only`,
    );
  };

  const sendLaneFrame = (
    lane: AssistantDraftLane,
    frameType: LaneFrameType,
    text: string,
    /**
     * A SPECULATIVE attempt is one this lane did not ask for — the ordering
     * flush claiming a slot early. Its failure says nothing about the lane: the
     * lane had no wire presence to protect and has not spent its turn. So it
     * records no failure, which keeps the lane's drain-time guarantee intact.
     * A speculative attempt that SUCCEEDS is an ordinary materialization and is
     * treated exactly like one.
     */
    options?: { speculative?: boolean },
  ): boolean => {
    const owner: ProvisionalClaimOwner = { kind: "lane", generation: lane.generation };
    const reservation = lane.id
      ? { owner, id: lane.id, usesPreview: false }
      : reserveProvisional(owner, lane);
    let sent = false;
    let failure: DeliveryFailureKind | undefined;
    try {
      sent =
        frameType === "progress"
          ? transport.sendProgress(sessionKey, reservation.id, text, params.turnId) === true
          : transport.finalizeDraft(sessionKey, reservation.id, text, params.turnId) === true;
      if (!sent) failure = "false";
    } catch {
      failure = "throw";
    }
    if (sent) {
      lane.id ??= reservation.id;
      lane.started = true;
      lane.resolution = "materialized";
      commitReservation(reservation, lane);
      return true;
    }
    rollbackReservation(reservation, lane);
    // A speculative attempt must never reduce what the lane is guaranteed at
    // drain: stamping `lastFailedDelivery` here would make
    // `laneTerminalSuppressed` true and delete text that was only ever HELD, not
    // shown. That is the loss this mode exists to prevent.
    if (options?.speculative !== true) {
      recordLaneFailure(lane, frameType, failure ?? "false");
    }
    return false;
  };

  const sendIndependent = (text: string): boolean => {
    if (!text) {
      warn("independent delivery skipped empty text without a transport attempt");
      return false;
    }
    const sequence = ++state.nextDeliverySequence;
    const owner: ProvisionalClaimOwner = { kind: "independent", deliverySequence: sequence };
    const reservation = reserveProvisional(owner);
    let sent = false;
    let failure: DeliveryFailureKind | undefined;
    try {
      sent = transport.finalizeDraft(sessionKey, reservation.id, text, params.turnId) === true;
      if (!sent) failure = "false";
    } catch {
      failure = "throw";
    }
    if (sent) {
      commitReservation(reservation);
      return true;
    }
    rollbackReservation(reservation);
    warn(
      `independent delivery sequence ${sequence} returned ${failure ?? "false"}; ` +
        "its provisional claim was rolled back",
    );
    return false;
  };

  /**
   * Advance a lane's RAW partial baseline — forward only, never backwards.
   *
   * The baseline is what the missed-boundary fail-safe compares against, so a
   * write that moves it BACKWARDS silently disables that fail-safe for the rest
   * of the message: every later payload then "extends" the rewound baseline and
   * can never be recognised as a new message. The way that happened was subtle
   * — the shrink guard swallowed a payload for display and advanced the
   * baseline with the shorter text anyway — and the consequence was the #94 data
   * loss class, not a cosmetic one: with message 2's first chunk a prefix of
   * message 1's text (a one-character collision like "D" is the common case for
   * token-sized deltas), message 1 never reached the wire at all.
   *
   * Enforced here rather than at each call site so the hazard is structurally
   * unrepresentable: a payload that does not extend the baseline leaves it
   * alone, whatever the caller decided to do about displaying it.
   */
  const acceptRawBaseline = (
    lane: AssistantDraftLane,
    raw: string,
    options?: { replace?: boolean },
  ): void => {
    // An explicit `replace` is authoritative: it does not continue the previous
    // cumulative text, it REPLACES it, so it starts a new baseline instead of
    // being measured against the old one. Forward-only holds WITHIN a message;
    // a replace begins a new one. Without this the baseline stays pinned to the
    // superseded text and every later delta composes on it — "old" + "er"
    // rather than "new" + "er".
    if (options?.replace === true) {
      lane.lastRawAnswerText = raw;
      return;
    }
    if (lane.lastRawAnswerText && !raw.startsWith(lane.lastRawAnswerText)) return;
    lane.lastRawAnswerText = raw;
  };

  /** Resolve a no-final hold: incomplete prose may return; exact markers may not. */
  const resolveDeferredAngleMarkerTail = (
    lane: AssistantDraftLane,
    options?: { preserveExact?: boolean },
  ): void => {
    const deferred = lane.deferredAngleMarkerTail;
    if (!deferred) return;
    if (deferred.exact && options?.preserveExact) return;
    lane.deferredAngleMarkerTail = undefined;
    lane.lastPartialSourceText = "";
    if (deferred.exact || !deferred.terminalFallbackText) return;
    const restored = deferred.terminalFallbackText;
    if (restored === lane.answerText) return;
    lane.answerText = restored;
    lane.answerRevision += 1;
    acceptRawBaseline(lane, restored, { replace: true });
    if (lane.resolution === "empty" || lane.resolution === "unresolved") {
      lane.resolution = "open";
    }
  };

  const laneHasFailedCurrentRevision = (lane: AssistantDraftLane): boolean =>
    lane.answerRevision > 0 && lane.lastFailedDelivery?.revision === lane.answerRevision;

  /**
   * May this lane be left without a terminal frame?
   *
   * ONLY if it never put anything on the wire. `laneHasFailedCurrentRevision`
   * exists to stop us blind-retrying a revision whose send just failed, and that
   * is the right rule for the PROGRESS path — but reading it as "this lane may
   * never be delivered" truncates a message the user is already looking at: one
   * transient `false`/`throw` on the latest progress send, and the lane's bubble
   * stays frozen at whatever text last succeeded while `finalizeDraft` is never
   * even attempted. The client finalizes the working draft in place on
   * `turn_settled`, so that truncation is permanent and silent — the #94
   * data-loss class itself.
   *
   * `develop` hardened against exactly this at its finalize path ("a pending
   * progress `ws.send` can throw … We must NOT let that abort finalization — the
   * final answer … still has to be delivered"), and a control run of that
   * controller confirms it: after a failed progress send it still attempts the
   * terminal frame, carrying the FULL text. The lane rewrite lost the guarantee
   * per-lane; this restores it per-lane.
   *
   * `materialized` is the distinction, and it is already recorded for us:
   * `sendLaneFrame` sets it on any successful send. A lane that never
   * materialized has shown the user nothing, so suppressing its terminal frame
   * invents no bubble — that is the defensible case M13g pins, and it stays.
   */
  const laneTerminalSuppressed = (lane: AssistantDraftLane): boolean =>
    lane.resolution !== "materialized" && laneHasFailedCurrentRevision(lane);

  const laneOrderResolved = (lane: AssistantDraftLane): boolean => {
    if (!lane.closed) return false;
    if (lane.tentativeBarrierReservationIds.length > 0) return false;
    if (lane.resolution === "materialized" || lane.resolution === "empty") return true;
    return laneHasFailedCurrentRevision(lane);
  };

  const predecessorsResolved = (lane: AssistantDraftLane): boolean => {
    for (const predecessor of state.lanes) {
      if (predecessor.generation >= lane.generation) break;
      if (!laneOrderResolved(predecessor)) return false;
    }
    return true;
  };

  /**
   * The predecessors holding `lane` back, IF every one of them is a closed,
   * text-less lane with nothing outstanding that could still claim it.
   *
   * `undefined` means something else is in the way — a tentative block
   * reservation, a lane armed for a late indexless one, or a lane with real
   * text — and that barrier is never released on a timer.
   *
   * These terms are LOCAL DEFENCE-IN-DEPTH, not the barrier itself. Mutation
   * testing showed they can each be removed with the whole suite still green,
   * and the reason is that `laneOrderResolved` already refuses everything they
   * refuse: it checks `tentativeBarrierReservationIds` before any resolution
   * state, so flipping a reservation-held lane to `"empty"` changes nothing,
   * and a closed lane WITH text is settled immediately by `releaseReadyLanes`
   * rather than lingering unresolved. The in-window barrier behaviour is pinned
   * end to end by the M6m fixtures; these conditions exist so that this
   * function is still correct on its own terms if that upstream ordering ever
   * changes. Do not read their redundancy as permission to delete them.
   */
  const releasableEmptyPredecessors = (
    lane: AssistantDraftLane,
  ): AssistantDraftLane[] | undefined => {
    // A block queued ANYWHERE in this turn and not yet retired means we cannot
    // know a text-less predecessor is genuinely empty — its body may still be in
    // flight. Deliberately turn-wide and lane-agnostic: which lane a reservation
    // attached to (or whether it attached at all) is decided by
    // `assistantMessageIndexMatchesLane`, whose index base is known-unsound on
    // the pinned core, so the release must not depend on that answer. With a
    // block outstanding we fall back to the documented turn-bounded delay, which
    // `retireReservation` and terminal drain both clear.
    if (state.blockReservations.some((reservation) => reservation.state === "pending")) {
      return undefined;
    }
    const releasable: AssistantDraftLane[] = [];
    for (const predecessor of state.lanes) {
      if (predecessor.generation >= lane.generation) break;
      if (laneOrderResolved(predecessor)) continue;
      // A REAL barrier: something can still legitimately claim this lane, so the
      // whole scan gives up and the timer releases nothing.
      if (
        predecessor.tentativeBarrierReservationIds.length > 0 ||
        predecessor.acceptsLateIndexlessReservations
      ) {
        return undefined;
      }
      // Text-less and unclaimed: the tool-only shape this release exists for.
      if (predecessor.closed && predecessor.resolution === "unresolved" && !predecessor.answerText) {
        releasable.push(predecessor);
        continue;
      }
      // Anything else here is an unresolved lane WITH text — a fellow VICTIM of
      // the same block, not a barrier. Bailing on it deadlocks the release: with
      // two successors (tool-only lane 0, then B, then C) the scan runs against
      // C, finds B unresolved-with-text and gives up, so lane 0 is never
      // released, so B never resolves, so the scan fails identically forever and
      // NEITHER message streams. Skipping it releases lane 0 and lets ordinary
      // ordering settle B before C.
      continue;
    }
    return releasable.length > 0 ? releasable : undefined;
  };

  const clearEmptyPredecessorTimer = (): void => {
    if (state.emptyPredecessorTimer === undefined) return;
    clearTimeout(state.emptyPredecessorTimer);
    state.emptyPredecessorTimer = undefined;
  };

  /**
   * #94 — time-boxed release of a text-less predecessor lane.
   *
   * A closed lane with no text is in one of two states that are INDISTINGUISHABLE
   * at the moment the next lane starts streaming: a tool-only assistant message,
   * which will never produce anything else, or a message whose text is still
   * coming as an out-of-band block (plan §12.2(5)). The information that
   * separates them — a queued-block callback — arrives later or not at all, so
   * no rule evaluated at that instant can be right.
   *
   * Resolving it immediately would drop the ordering barrier a late block
   * depends on. Never resolving it is what shipped, and it is worse: a tool-only
   * first message is the ordinary "call a tool, then answer" turn, and it left
   * every later lane stalled behind the barrier until terminal drain, so the
   * answer streamed NOTHING and appeared only as a finished bubble.
   *
   * So we wait exactly one streaming window. If the queued callback lands inside
   * it the barrier holds as before; if nothing arrives, the lane is treated as
   * the tool-only case and the live lane is released.
   *
   * OUTSIDE the window the barrier is gone, and that is an accepted cost, not
   * an oversight: a block that arrives after the release is delivered
   * independently and therefore lands BELOW the answer that already streamed —
   * message 0's bubble under message 1's. The alternative is the stall this
   * exists to fix, and a settle is never delayed to avoid it. Recorded as
   * accepted behaviour by the M6n fixture so it cannot be mistaken for a bug.
   *
   * One further consequence, conservative rather than lossy: once a predecessor
   * flips to `"empty"` it leaves `unresolvedCandidates`, so an indexless
   * reservation arriving later arms `acceptsLateIndexlessReservations` on the
   * LIVE answer lane instead of the empty predecessor it probably belonged to.
   * That withholds the live lane rather than losing anything, and terminal drain
   * clears it.
   *
   * This delays the FIRST PROGRESS FRAME of a later lane and nothing else. Every
   * settle path (`finalize`, `deliverTerminalIndependent`, terminal drain) runs
   * `retireTentativeState`, which resolves these lanes synchronously — so a turn
   * that finishes inside the window settles exactly as it does today. The worst
   * case is unchanged behaviour; the best case is a streaming answer.
   *
   * NOT USED, and why: "the lane saw tool activity, so it is a tool-only
   * message" is unsound. Tool activity does not imply the message had no text —
   * a message can call a tool AND answer (the first message of this repo's own
   * multi-message fixture does exactly that), and whenever such a message's text
   * arrives as a block rather than as partials, its lane closes text-less with
   * tool activity while a block is genuinely still coming. That is precisely the
   * shape the barrier exists for, and it is reachable from any non-streaming
   * provider, in any streaming mode.
   */
  const scheduleEmptyPredecessorRelease = (): void => {
    if (state.emptyPredecessorTimer !== undefined || state.stopped) return;
    const timer = setTimeout(() => {
      state.emptyPredecessorTimer = undefined;
      void enqueue(
        "empty predecessor release",
        () => {
          if (state.stopped) return;
          // No `settled`/`no-text` fast path here on purpose: it was redundant
          // and therefore untestable. A settle has already run
          // `retireTentativeState`, so every predecessor is resolved and
          // `releasableEmptyPredecessors` returns nothing; with no active text
          // `releaseReadyLanes` emits nothing either.
          const active = currentLane();
          const releasable = releasableEmptyPredecessors(active);
          if (!releasable) return;
          for (const predecessor of releasable) predecessor.resolution = "empty";
          releaseReadyLanes();
          // Send the released frame NOW rather than letting the progress
          // throttle hold it another window. The throttle rate-limits repeated
          // edits to a bubble the user can already see; this lane has shown
          // nothing yet and has just waited a full window for the barrier. On a
          // turn whose answer is shorter than one throttle interval — measured
          // on the tool-only e2e fixture — the queued frame would otherwise be
          // discarded by the settle and the answer would never stream at all,
          // which is the whole defect this release exists to fix.
          if (
            state.pendingProgress?.kind === "lane" &&
            state.pendingProgress.generation === active.generation
          ) {
            flushPendingProgress();
          }
        },
        undefined,
      );
    }, throttleMs);
    // Never hold the host process open for a draft frame.
    (timer as { unref?: () => void }).unref?.();
    state.emptyPredecessorTimer = timer;
  };

  const settleLane = (lane: AssistantDraftLane, text: string): boolean => {
    if (lane.settleOutcome !== undefined) return lane.settleOutcome;
    if (lane.settleResult) return false;

    // Record lane settlement before the synchronous transport call. Internal
    // callers cannot emit a second lane terminal frame; `finalize` separately
    // distinguishes call-stack re-entry from later independent payloads.
    let resolveSettle!: (value: boolean) => void;
    lane.settleResult = new Promise<boolean>((resolve) => {
      resolveSettle = resolve;
    });
    lane.settled = true;
    const sent = sendLaneFrame(lane, "final", text);
    lane.settleOutcome = sent;
    resolveSettle(sent);
    return sent;
  };

  /**
   * #94 — everything this controller puts on the wire for a turn has to leave in
   * MESSAGE ORDER, and there are two emission paths that do not know about each
   * other.
   *
   * Lane text can be held back: a lane may not stream ahead of an unresolved
   * text-less predecessor, and that predecessor is only released after one
   * throttle window. An independent delivery is authorized visible output, so it
   * is deliberately neither throttled nor queued behind anything. Cross the two
   * inside the release window and the held lane owns no bubble id yet, so the
   * later payload takes the next slot — the widget appends on an unknown id, so
   * the later assistant message renders ABOVE the earlier one PERMANENTLY. Drain
   * does not repair it; drain is what finally emits the earlier text, into the
   * wrong slot.
   *
   * So an independent delivery emits any held lane text FIRST, in generation
   * order: earlier lanes are settled (a closed lane can gain no more text, so
   * its terminal frame is owed anyway), and the CURRENT lane — which may still
   * be mid-message — merely claims its slot with a progress frame. This picks no
   * lane by body text, arrival order or candidate count, so §5.2 is untouched:
   * it changes only WHEN text we already hold is emitted, never whose it is.
   *
   * IT DOES NOT ALWAYS FIRE, and that is the correction the fixtures forced. The
   * dispatcher really is strictly serial —
   * `sendChain = sendChain.then(… deliver …).catch(…).finally(… onDeliverySettled …)`
   * (reply-dispatcher.types-CVYQHGPk.js:95-131), with the block pipeline
   * enqueueing onto its own serial chain the same way
   * (block-reply-pipeline-CsIUOKQ6.js:241) — so an earlier message's block is
   * delivered AND settled before a later message's payload arrives, and that is
   * why emitting held text ahead of the arriving payload is SAFE WHEN IT FIRES.
   * It is not a reason to fire unconditionally, because "a block is still
   * outstanding" is reachable at this API regardless, and then the arriving
   * payload may BE that earlier message's block — which has to land ABOVE the
   * held text, not below it (M6z4). Nothing here can tell whose payload just
   * arrived; that identity is #111's. So with any reservation still pending the
   * whole thing stands down and today's ordering is kept.
   *
   * Scoping the stand-down to the slot claim alone was tried in round 10 and
   * measured: it fixes the M6z3 residual and inverts M6z4. Both fixtures ship,
   * one as the fix and one as its limit.
   */
  const emitHeldLaneTextBeforeIndependentDelivery = (): void => {
    // The stand-down (see the docblock for why it is not unconditional). Whole
    // function, not just the current lane: M6m/M6t pin the barrier it protects
    // and M6z4 the inversion that scoping it would cause.
    if (state.blockReservations.some((reservation) => reservation.state === "pending")) {
      return;
    }
    // CLAIM ONLY — never settle. Ordering is decided by whichever frame first
    // creates a bubble, so a slot claim is all this needs, and a claim costs the
    // lane nothing it cannot recover: on success the lane is materialized and is
    // then GUARANTEED its terminal frame; on failure the speculative mode leaves
    // no trace and drain still settles the text through the ordinary path.
    //
    // An earlier version settled the earlier lanes here. That spent each lane's
    // one latched terminal attempt at flush time instead of at drain, where a
    // recovered transport would have carried it — the weaker form of the same
    // loss. One rule for every lane now, closed or current.
    for (const lane of state.lanes) {
      if (lane.id || lane.settled || !lane.answerText) continue;
      if (laneTerminalSuppressed(lane)) continue;
      discardPendingProgress(
        (frame) => frame.kind === "lane" && frame.generation === lane.generation,
      );
      if (sendLaneFrame(lane, "progress", lane.answerText, { speculative: true })) {
        lane.lastProgressAttemptRevision = lane.answerRevision;
        state.lastProgressSentAt = Date.now();
      }
    }
  };

  const attemptProgress = (frame: PendingProgressFrame): boolean => {
    if (state.stopped) return false;
    if (frame.kind === "preview") {
      const preview = state.provisionalPreview;
      if (
        preview.scaffoldWriter !== "active" ||
        preview.revision !== frame.revision
      ) {
        return false;
      }
      let sent = false;
      try {
        sent = transport.sendProgress(sessionKey, preview.id, frame.text, params.turnId) === true;
      } catch {
        warn(`provisional preview revision ${frame.revision} progress delivery threw`);
      }
      if (sent) {
        preview.started = true;
        state.started = true;
        state.lastProgressSentAt = Date.now();
      }
      return sent;
    }

    const lane = state.lanes[frame.generation];
    if (
      !lane ||
      lane.closed ||
      lane.settled ||
      lane.answerRevision !== frame.revision ||
      !predecessorsResolved(lane)
    ) {
      return false;
    }
    lane.lastProgressAttemptRevision = frame.revision;
    const sent = sendLaneFrame(lane, "progress", frame.text);
    if (sent) state.lastProgressSentAt = Date.now();
    return sent;
  };

  const flushPendingProgress = (): void => {
    clearProgressTimer();
    const pending = state.pendingProgress;
    state.pendingProgress = undefined;
    if (pending) attemptProgress(pending);
  };

  const schedulePendingProgress = (): void => {
    if (state.progressTimer !== undefined || !state.pendingProgress || state.stopped) return;
    const delay = Math.max(0, throttleMs - (Date.now() - state.lastProgressSentAt));
    state.progressTimer = setTimeout(() => {
      state.progressTimer = undefined;
      void enqueue("throttled progress flush", flushPendingProgress, undefined);
    }, delay);
  };

  const queueProgress = (frame: PendingProgressFrame): void => {
    if (state.stopped) return;
    // A single pending slot is last-write-wins across BOTH frame kinds, so a
    // tool event's scaffold frame could evict an answer frame that was queued
    // but not yet sent — losing the answer's first visible update, on either
    // path below (the open-throttle path discards the pending frame outright).
    // Answer text outranks the scaffold, so the scaffold yields.
    //
    // The dropped frame is NOT free and the earlier claim that it was — that
    // `attemptProgress`'s revision re-check made it a superseded frame — was
    // wrong: `pushEvent` has just incremented `preview.revision`, so this IS the
    // current revision and nothing re-queues it. If no further tool event
    // arrives, that scaffold line never reaches the wire.
    //
    // It is safe for a different, verified reason. A lane frame can only be
    // PENDING when `lastProgressSentAt !== 0`, and that is assigned only by
    // `attemptProgress` after a SUCCESSFUL send — either of a preview (so
    // `preview.started` is already true and the P-claim path is preserved) or of
    // a lane frame (which has already run `invalidateScaffoldWriter`, so no
    // scaffold was going out anyway). Worst case is therefore a scaffold that is
    // one line stale on screen, and `settlePreviewIfAlone` still settles with the
    // newest `preview.text` because `pushEvent` updates the text before queuing.
    //
    // BOUNDED, and worth knowing where: the window shuts permanently once a lane
    // frame actually sends, because `commitReservation` calls
    // `invalidateScaffoldWriter()` and `attemptProgress` gates previews on
    // `scaffoldWriter === "active"`. So this only bites before the answer's
    // first sent frame — which is exactly the opening of a tool-first turn.
    if (frame.kind === "preview" && state.pendingProgress?.kind === "lane") return;
    const throttleOpen =
      state.lastProgressSentAt === 0 || Date.now() - state.lastProgressSentAt >= throttleMs;
    if (throttleOpen) {
      discardPendingProgress(() => true);
      attemptProgress(frame);
      return;
    }
    state.pendingProgress = frame;
    schedulePendingProgress();
  };

  const releaseReadyLanes = (options?: {
    emitCurrentProgress?: boolean;
    settleCurrent?: boolean;
  }): void => {
    const active = currentLane();
    for (const lane of state.lanes) {
      if (!predecessorsResolved(lane)) continue;
      if (lane.closed) {
        discardPendingProgress(
          (frame) => frame.kind === "lane" && frame.generation === lane.generation,
        );
        if (lane.answerText && !lane.settled && !laneTerminalSuppressed(lane)) {
          settleLane(lane, lane.answerText);
        }
        continue;
      }
      if (lane !== active || !lane.answerText || lane.settled) continue;
      if (options?.settleCurrent) {
        discardPendingProgress(
          (frame) => frame.kind === "lane" && frame.generation === lane.generation,
        );
        if (!laneTerminalSuppressed(lane)) settleLane(lane, lane.answerText);
      } else if (
        options?.emitCurrentProgress !== false &&
        lane.lastProgressAttemptRevision < lane.answerRevision &&
        // Redundant in practice and kept deliberately: `attemptProgress` stamps
        // `lastProgressAttemptRevision` BEFORE the send, so the term above
        // already blocks a retry of the revision that just failed (removing this
        // one leaves the whole suite green). It stays as the explicit statement
        // of the rule, because the terminal path now deliberately does NOT honour
        // the failed stamp and the difference between the two paths should be
        // readable here rather than inferred.
        !laneHasFailedCurrentRevision(lane)
      ) {
        queueProgress({
          kind: "lane",
          generation: lane.generation,
          revision: lane.answerRevision,
          text: lane.answerText,
        });
      }
    }
    // The live lane has text to show but is held behind a text-less predecessor.
    // Give the predecessor one streaming window to declare itself (see
    // `scheduleEmptyPredecessorRelease`); a settle never waits on this.
    // `settleCurrent`/`emitCurrentProgress` are deliberately NOT re-checked:
    // both paths leave the active lane settled or text-less by the time this
    // runs, so the conditions below already cover them.
    if (
      active.answerText &&
      !active.settled &&
      !predecessorsResolved(active) &&
      releasableEmptyPredecessors(active)
    ) {
      scheduleEmptyPredecessorRelease();
    }
  };

  const assistantMessageIndexMatchesLane = (
    assistantMessageIndex: number,
    lane: AssistantDraftLane,
  ): boolean => {
    // KNOWN-UNSOUND ON THE PINNED CORE, and tolerated deliberately.
    //
    // Core stamps the queued-block context from the same payload metadata the
    // delivery seam reads, and that stream is 1-BASED (measured on a real
    // gateway: message A = 1, B = 2). Lane generations are 0-based, so this
    // predicate is wrong on EVERY indexed turn, not in some edge case:
    //   - it matches A's reservation (index 1) against lane generation 1 = B, so
    //     the barrier lands on the SUCCESSOR, which never blocks that lane's own
    //     progress (`predecessorsResolved` looks only at predecessors); and
    //   - more commonly, when the block is queued while its own lane is still
    //     current, generation 1 does not exist yet, `state.lanes.find` returns
    //     undefined and NO barrier is created at all until the next rotation.
    //
    // An earlier version of this comment called the consequence a turn-bounded
    // delay. That stopped being true when the empty-predecessor release timer
    // landed: a mis-attached (or unattached) reservation leaves the real
    // predecessor text-less with an empty barrier list, i.e. releasable, and the
    // successor then streams ahead of a block that is still in flight —
    // inverting the two bubbles rather than delaying one.
    //
    // What makes tolerating it safe is `releasableEmptyPredecessors`, which
    // refuses to release while ANY reservation in the turn is still pending,
    // whatever lane it did or did not attach to. Correcting the mapping itself
    // needs a real index→lane identity and belongs to #111; guessing an offset
    // here would bind us to an observed core version instead of a contract.
    return assistantMessageIndex === lane.generation;
  };

  const attachIndexedReservations = (lane: AssistantDraftLane): void => {
    if (!state.lateReservationEpochOpen) return;
    for (const reservation of state.blockReservations) {
      if (
        reservation.state !== "pending" ||
        reservation.barrierGeneration !== undefined ||
        reservation.assistantMessageIndex === undefined ||
        !assistantMessageIndexMatchesLane(reservation.assistantMessageIndex, lane)
      ) {
        continue;
      }
      reservation.barrierGeneration = lane.generation;
      lane.tentativeBarrierReservationIds.push(reservation.token);
    }
  };

  const closeAndRotate = (): void => {
    const lane = currentLane();
    resolveDeferredAngleMarkerTail(lane);
    discardPendingProgress(
      (frame) => frame.kind === "lane" && frame.generation === lane.generation,
    );
    lane.closed = true;
    if (
      lane.answerText.length === 0 &&
      lane.resolution !== "materialized" &&
      lane.resolution !== "empty"
    ) {
      lane.resolution = "unresolved";
    }
    const next = newLane(lane.generation + 1);
    state.lanes.push(next);
    attachIndexedReservations(next);
    releaseReadyLanes({ emitCurrentProgress: false });
  };

  const retireReservation = (reservation: TentativeBlockReservation): void => {
    if (reservation.state === "retired") return;
    reservation.state = "retired";
    if (reservation.barrierGeneration === undefined) return;
    const lane = state.lanes[reservation.barrierGeneration];
    if (!lane) return;
    lane.tentativeBarrierReservationIds = lane.tentativeBarrierReservationIds.filter(
      (token) => token !== reservation.token,
    );
    // Deliberately has NO `lane.closed` term, unlike the otherwise identical flip
    // in `retireTentativeState`. Adding one for symmetry looks right and is
    // wrong: this flip is what lets an EARLY cleanup pre-resolve a lane that has
    // demonstrably produced nothing — its last pending claim just retired and it
    // holds no text — so the next lane streams immediately instead of waiting for
    // the release window or drain. M6h's `cleanupBeforeBoundary` case pins
    // exactly that, and gating this on `closed` turns it red: the lane is still
    // the open one when its reservation retires.
    //
    // Marking a LIVE lane `"empty"` is safe for reasons local to the transition:
    // the lane has no text by the condition below, `pushAnswerText` resets the
    // resolution to `"open"` the moment it gets any, and a live lane is never
    // anyone's predecessor. `retireTentativeState` needs the `closed` term
    // because it runs at terminal drain, where the current lane is settled by
    // `settleCurrent` rather than resolved.
    if (
      lane.tentativeBarrierReservationIds.length === 0 &&
      !lane.acceptsLateIndexlessReservations &&
      !lane.answerText &&
      lane.resolution !== "materialized"
    ) {
      lane.resolution = "empty";
    }
  };

  type OutstandingLifecycleRecord =
    | { kind: "block"; record: TentativeBlockReservation }
    | { kind: "notice"; record: TentativeNoticeToken };

  const outstandingRecordsAtIndex = (assistantMessageIndex: number): OutstandingLifecycleRecord[] => [
    ...state.blockReservations
      .filter(
        (reservation) =>
          reservation.state === "pending" &&
          reservation.assistantMessageIndex === assistantMessageIndex,
      )
      .map((record) => ({ kind: "block" as const, record })),
    ...state.noticeTokens
      .filter(
        (token) =>
          token.state === "pending" && token.assistantMessageIndex === assistantMessageIndex,
      )
      .map((record) => ({ kind: "notice" as const, record })),
  ];

  /**
   * Retire the EARLIEST pending record of `recordKind` at this index.
   *
   * Cardinality is deliberately not a condition. One assistant message can emit
   * several block payloads and core stamps them all with that message's index
   * (plan §14.4), and a notice can share an index with a real block — so
   * "exactly one record here" is the uncommon case, and bailing on anything else
   * left BOTH records pending forever. Every payload gets its own settlement, so
   * retiring one record per settlement drains them all whatever order they
   * arrive in, and the block reservation — the only record that is an ordering
   * barrier — is released last at its index.
   */
  const retireOneRecordAtIndex = (
    assistantMessageIndex: number | undefined,
    recordKind: OutstandingLifecycleRecord["kind"],
  ): void => {
    if (assistantMessageIndex === undefined) return;
    const candidate = outstandingRecordsAtIndex(assistantMessageIndex).find(
      (entry) => entry.kind === recordKind,
    );
    if (!candidate) return;
    if (candidate.kind === "block") {
      retireReservation(candidate.record);
    } else {
      candidate.record.state = "retired";
    }
  };

  const retireTentativeState = (): void => {
    state.lateReservationEpochOpen = false;
    for (const reservation of state.blockReservations) retireReservation(reservation);
    for (const token of state.noticeTokens) token.state = "retired";
    for (const disposition of state.blockDispositions) disposition.settled = true;
    for (const lane of state.lanes) {
      lane.acceptsLateIndexlessReservations = false;
      if (
        lane.closed &&
        !lane.answerText &&
        lane.tentativeBarrierReservationIds.length === 0 &&
        lane.resolution !== "materialized"
      ) {
        lane.resolution = "empty";
      }
    }
  };

  const settlePreviewIfAlone = (): boolean => {
    const preview = state.provisionalPreview;
    if (
      state.durableDeliverySucceeded ||
      !preview.started ||
      !preview.text ||
      preview.claim.state !== "unclaimed"
    ) {
      return false;
    }
    if (preview.settleOutcome !== undefined) return preview.settleOutcome;
    if (preview.settleResult) return false;
    let resolveSettle!: (value: boolean) => void;
    preview.settleResult = new Promise<boolean>((resolve) => {
      resolveSettle = resolve;
    });
    invalidateScaffoldWriter();
    let sent = false;
    try {
      sent = transport.finalizeDraft(sessionKey, preview.id, preview.text, params.turnId) === true;
    } catch {
      warn("provisional preview cleanup delivery threw");
    }
    preview.settleOutcome = sent;
    if (sent) {
      state.durableDeliverySucceeded = true;
      state.started = true;
    }
    resolveSettle(sent);
    return sent;
  };

  const terminalDrain = (settleCurrent: boolean): void => {
    resolveDeferredAngleMarkerTail(currentLane());
    retireTentativeState();
    releaseReadyLanes({
      emitCurrentProgress: false,
      settleCurrent,
    });
    if (settleCurrent) settlePreviewIfAlone();
  };

  const deliverTerminalIndependent = (text: string): boolean => {
    // ONE STORY, in the order it happens:
    //
    // 1. Retire tentative state, which opens ordering barriers.
    // 2. Emit any HELD lane text, claiming its slot. Message order outranks this
    //    payload: a lane holding text produced it BEFORE this terminal payload
    //    arrived, and the widget appends on an unknown id, so a lane that has
    //    not claimed its bubble yet would sit below this one forever.
    // 3. Send this payload.
    // 4. Release whatever the retirement in (1) unblocked.
    //
    // P-CLAIM: whoever sends first owns the scaffold id, so after (2) that can
    // be a held lane rather than this payload — deliberately, and signed off in
    // round 10 (see M13d). The scaffold was the progress indicator for the
    // message still being written, so that message's lane is its natural owner,
    // and handing P over satisfies the no-ghost rule (§6.2-3) exactly as well.
    // The RULE is unchanged — first successful claimant owns P — only who is
    // first. A failed claim in (2) rolls back and leaves P for this payload.
    resolveDeferredAngleMarkerTail(currentLane(), { preserveExact: true });
    retireTentativeState();
    emitHeldLaneTextBeforeIndependentDelivery();
    const sent = sendIndependent(text);
    releaseReadyLanes({ emitCurrentProgress: false });
    return sent;
  };

  return {
    get started() {
      return state.started && !state.finalReconciliation.ordinaryAnswerSettled;
    },
    pushEvent: (input) => {
      void enqueue(
        "progress event",
        () => {
          const preview = state.provisionalPreview;
          if (state.stopped || preview.scaffoldWriter !== "active") {
            return;
          }
          const line = formatChannelProgressDraftLineForEntry(channelConfig as never, input);
          if (!line) return;
          if (state.lines[state.lines.length - 1] !== line) state.lines.push(line);
          const shown = state.lines.slice(-maxLines);
          preview.text = [`${label}…`, ...shown].join("\n");
          preview.revision += 1;
          queueProgress({
            kind: "preview",
            revision: preview.revision,
            text: preview.text,
          });
        },
        undefined,
      );
    },
    pushAnswerText: (update: PartialAnswerUpdate) => {
      void enqueue(
        "partial answer update",
        () => {
          let lane = currentLane();
          if (state.stopped || lane.settled) return;
          const nonemptyDelta = typeof update.delta === "string" && update.delta.length > 0;
          if (update.text === "" && !nonemptyDelta) {
            lane.lastPartialSourceText = "";
            if (!lane.deferredAngleMarkerTail?.exact) {
              lane.deferredAngleMarkerTail = undefined;
            }
            return;
          }

          // A delta composes on the latest callback source even while its suffix
          // is quarantined and therefore absent from `answerText`.
          const deltaBase =
            lane.lastPartialSourceText || lane.lastRawAnswerText || lane.answerText;
          const sourceRaw =
            typeof update.text === "string" && update.text.length > 0
              ? update.text
              : nonemptyDelta
                ? deltaBase + update.delta
                : undefined;
          if (sourceRaw === undefined) return;

          const previousDeferred =
            lane.deferredAngleMarkerTail?.exact || update.replace !== true
              ? lane.deferredAngleMarkerTail
              : undefined;
          let deferredResult = deferAngleMarkerTail(sourceRaw, previousDeferred);
          if (deferredResult.alreadyQuarantined) {
            lane.lastPartialSourceText = sourceRaw;
            lane.deferredAngleMarkerTail = deferredResult.deferred;
            return;
          }

          // Mirror core's own partial hygiene exactly (verified:
          // dist/message-handler.process-CcPQD8zK.js:685-698): strip reasoning +
          // inline-directive tags, drop a "Reasoning:\n"-prefixed partial, skip
          // an identical text, and ignore a SHRINKING cumulative text (a shorter
          // prefix of the current one) to avoid backwards flicker. Restored from
          // `develop` — the lane rewrite (34da088) dropped the first and third
          // of those while keeping the strip itself.
          let visibleRaw = deferredResult.visibleText;
          let cleaned = cleanPartialAnswerText(visibleRaw);
          // Deliberately does NOT touch the raw baseline. A reasoning payload is
          // not this message's answer, so letting it set the baseline would force
          // the real answer to "extend" reasoning text it has nothing to do with,
          // and a provider that stops prefixing mid-message would then read as a
          // new assistant message. Leaving the baseline alone is inert: an empty
          // baseline cannot trigger the fail-safe (which also requires existing
          // lane text), and a non-empty one still describes the last real answer
          // payload.
          if (!cleaned || cleaned.startsWith("Reasoning:\n")) {
            lane.lastPartialSourceText = sourceRaw;
            lane.deferredAngleMarkerTail = deferredResult.deferred;
            return;
          }
          if (cleaned === lane.answerText) {
            lane.lastPartialSourceText = sourceRaw;
            lane.deferredAngleMarkerTail = deferredResult.deferred;
            acceptRawBaseline(lane, visibleRaw, { replace: update.replace === true });
            return;
          }
          // SHRINK. Mid-stream an unclosed `<thinking>` strips away text the
          // lane has already shown, so the cleaned cumulative text goes
          // BACKWARDS ("Hi <thi" → "Hi"). Rendering that would flicker, and —
          // under the lane model, unlike core's single-draft path — the next
          // partial would then look like a diverged message and rotate the lane,
          // splitting one answer across two bubbles. An explicit `replace`
          // update is authoritative and is never treated as a shrink.
          if (
            update.replace !== true &&
            !deferredResult.deferred &&
            !deferredResult.restart &&
            lane.answerText.length > 0 &&
            lane.answerText.startsWith(cleaned) &&
            cleaned.length < lane.answerText.length
          ) {
            // Tag stripping shortens the CLEANED text while the RAW payload keeps
            // growing — but only for OUR strippers (`<thinking>`, inline
            // directives), which core leaves in place. Core's own strippers
            // shorten the raw too, so a backwards raw is NOT a reliable
            // new-message signal; see `lastRawAnswerText` and #120.
            //
            // No `replace` flag needed: this branch is unreachable for a replace
            // update (the condition above requires `replace !== true`).
            lane.lastPartialSourceText = sourceRaw;
            lane.deferredAngleMarkerTail = deferredResult.deferred;
            acceptRawBaseline(lane, visibleRaw);
            return;
          }

          // This is the sole content-prefix check in the answer state machine.
          // It is a fail-safe for a missing structured boundary, not an attempt
          // to correlate callback bodies or final payloads. Explicit replace
          // updates stay in the same lane even when their text diverges.
          //
          // The RAW stream is what decides. Cleaned text diverges whenever a tag
          // closes mid-stream ("Hi <thi" → "Hi  there") even though the provider
          // is still appending to the SAME message; rotating there would split
          // one answer into two bubbles. A real missed boundary restarts the
          // cumulative text, so the raw text stops extending too.
          if (
            update.replace !== true &&
            !deferredResult.deferred &&
            lane.answerText.length > 0 &&
            (deferredResult.restart === true ||
              (!cleaned.startsWith(lane.answerText) &&
                !visibleRaw.startsWith(lane.lastRawAnswerText)))
          ) {
            warn(
              `contract violation: cumulative partial diverged without an assistant-message ` +
                `boundary; preserving generation ${lane.generation} and rotating defensively`,
            );
            closeAndRotate();
            lane = currentLane();
            deferredResult = deferAngleMarkerTail(sourceRaw);
            visibleRaw = deferredResult.visibleText;
            cleaned = cleanPartialAnswerText(visibleRaw);
          }

          lane.lastPartialSourceText = sourceRaw;
          lane.deferredAngleMarkerTail = deferredResult.deferred;
          if (!cleaned || cleaned.startsWith("Reasoning:\n")) return;
          lane.answerText = cleaned;
          acceptRawBaseline(lane, visibleRaw, { replace: update.replace === true });
          lane.answerRevision += 1;
          if (lane.resolution === "empty" || lane.resolution === "unresolved") {
            lane.resolution = "open";
          }
          releaseReadyLanes();
        },
        undefined,
      );
    },
    handleAssistantMessageBoundary: () => {
      void enqueue(
        "assistant-message boundary",
        () => {
          if (state.stopped) return;
          // NO absorb counter. #23 added one so that a boundary arriving LATE
          // for a seam the fail-safe had already rotated would no-op instead of
          // rolling twice — a real hazard in that controller, where a double
          // roll appended a spurious separator inside the single per-turn
          // bubble. Two things have changed since:
          //
          //  - its premise is false. #23 recorded that core "fires
          //    onAssistantMessageStart exactly ONCE per run"; the live harness
          //    later showed it firing per assistant message. And a boundary
          //    cannot arrive late for its OWN message: core fires it before that
          //    message's first chunk is processed (selection-BfRwHcjH.js:3788
          //    `handleMessageStart`, and :3859-3867 where a stream-item-id change
          //    fires the boundary and only then handles the chunk), and this seam
          //    enqueues boundaries and partials onto one FIFO, so neither can
          //    overtake the other. The counter therefore never consumed a
          //    duplicate — it consumed the NEXT message's real boundary.
          //  - the failure modes inverted. Under lanes, swallowing a boundary
          //    does not merge two paragraphs: the next message's final lands on
          //    the previous message's lane and OVERWRITES it. Deleting the
          //    counter can at worst cause one spurious rotation, and an empty
          //    lane emits no bubble at all (§6.2-3, M6). A stray empty lane is
          //    not the same order of defect as deleted text.
          if (!state.firstBoundarySeen) {
            state.firstBoundarySeen = true;
            return;
          }
          closeAndRotate();
        },
        undefined,
      );
    },
    noteBlockReplyQueued: (input) => {
      void enqueue(
        "queued block observation",
        () => {
          // Classification precedes every lane lookup or reservation decision.
          if (isNotice(input)) {
            state.noticeTokens.push({
              assistantMessageIndex: input.assistantMessageIndex,
              state: state.lateReservationEpochOpen ? "pending" : "retired",
            });
            return;
          }

          const reservation: TentativeBlockReservation = {
            token: nextBlockToken(),
            assistantMessageIndex: input.assistantMessageIndex,
            state: state.lateReservationEpochOpen ? "pending" : "retired",
          };
          state.blockReservations.push(reservation);
          if (reservation.state === "retired") return;

          let barrierLane: AssistantDraftLane | undefined;
          if (input.assistantMessageIndex !== undefined) {
            barrierLane = state.lanes.find(
              (lane) => assistantMessageIndexMatchesLane(input.assistantMessageIndex!, lane),
            );
          } else {
            const unresolvedCandidates = state.lanes.filter(
              (lane) => lane.resolution === "unresolved",
            );
            if (unresolvedCandidates.length > 1) {
              warn(
                `ambiguous indexless block reservation has ${unresolvedCandidates.length} ` +
                  "unresolved predecessors; retaining the earliest ordering barrier",
              );
            }
            barrierLane =
              state.lanes.find((lane) => lane.acceptsLateIndexlessReservations) ??
              unresolvedCandidates[0] ??
              currentLane();
            barrierLane.acceptsLateIndexlessReservations = true;
          }
          if (!barrierLane) return;
          reservation.barrierGeneration = barrierLane.generation;
          barrierLane.tentativeBarrierReservationIds.push(reservation.token);
        },
        undefined,
      );
    },
    deliverAuthorizedBlock: (input) =>
      enqueue(
        "authorized block delivery",
        // A block-kind notice is authoritative visible output and owns no
        // tentative block reservation. It DOES now record a disposition — an
        // earlier version of this comment said doing so would let its settled
        // event retire an unrelated real-block barrier, and that was true only
        // while dispositions were untyped. Tagging each one with what the
        // payload was is what makes recording it safe, and is what lets the
        // settlement seam stop guessing.
        () => {
          // THE classification point: this is the only seam that sees the
          // payload, so this is where "was it a notice?" is answered and
          // recorded. The settlement seam later consumes these in order rather
          // than guessing (see `noteDeliveryLifecycle`).
          //
          // Recorded BEFORE the empty-text bail on purpose. A media-only or
          // otherwise text-less block sends nothing, but the dispatcher still
          // settles it, and a settlement with no disposition to pair against used
          // to leave that block's reservation pending forever — which, with the
          // turn-wide release gate, stalled every later message for the rest of
          // the turn.
          state.blockDispositions.push({
            settled: false,
            kind: isNotice(input) ? "notice" : "block",
          });
          if (!input.text) return false;
          emitHeldLaneTextBeforeIndependentDelivery();
          return sendIndependent(input.text);
        },
        false,
      ),
    noteDeliveryLifecycle: (kind, input) => {
      void enqueue(
        `delivery lifecycle ${kind}`,
        () => {
          // The pinned dispatcher emits every lifecycle observer for tool,
          // block, and final payloads. Only block-kind events can describe the
          // tentative block state owned by this controller.
          if (input.deliveryKind !== "block") return;
          const classifiedNotice =
            kind === "skip" || kind === "cancel" ? isNotice(input) : false;
          if (kind === "error") {
            // Retires nothing on purpose: an adapter error says a delivery
            // failed, not WHICH record it belonged to, and this seam has no
            // payload to classify. Terminal drain clears whatever is left. Note
            // the cost is now turn-wide rather than per-lane — a reservation
            // surviving here keeps the empty-predecessor release gate closed for
            // the rest of the turn — which is the price of not guessing.
            warn("delivery adapter reported an error; ambiguous reservations await terminal drain");
          } else if (kind === "settled") {
            // `onDeliverySettled` carries no payload — core hands this seam only
            // `{kind, assistantMessageIndex}`, and it marks real blocks and
            // notices alike as `kind:"block"` — so nothing here can classify the
            // settling payload. Every previous attempt to infer it was a guess
            // that misfired: "no outstanding disposition ⇒ notice" is false for a
            // text-less block, and untagged FIFO pairing let a notice consume the
            // next real block's disposition.
            //
            // So the classification is taken from where the payload actually was:
            // `deliverAuthorizedBlock` records one disposition per authorized
            // block delivery, tagged with what that payload was. Settlements pair
            // with deliveries in order, and each retires the earliest pending
            // record OF THAT KIND at its index.
            //
            // That pairing rests on one premise, so state it: core fires
            // `onDeliverySettled` from the `.finally()` of the SAME promise chain
            // that awaited `deliver`, and every disposition here is pushed inside
            // this controller's serialized queue. So dispositions are recorded in
            // the order deliveries complete, and settlements arrive in that same
            // order. If a future core dispatches block deliveries concurrently
            // without awaiting each in turn, this pairing is what breaks first.
            //
            // No disposition left means this settlement belongs to a payload this
            // controller never saw delivered — a callback-free notice is the
            // reachable case — so it owns no record and retires nothing. That is
            // what keeps F5 true: a notice settlement can never consume a real
            // block's ordering reservation.
            const disposition = state.blockDispositions.find((candidate) => !candidate.settled);
            if (disposition) {
              disposition.settled = true;
              retireOneRecordAtIndex(input.assistantMessageIndex, disposition.kind);
            }
          } else {
            // `skip`/`cancel` carry the payload, so the kind is known exactly —
            // no counting needed, and no cardinality condition either. Bailing
            // when two records shared an index was the same defect the
            // settlement path had: a real block cancelled at an index it shares
            // with a notice, or one of a message's two blocks skipped by
            // normalize, left a reservation pending for the whole turn and no
            // later lane streamed anything.
            retireOneRecordAtIndex(
              input.assistantMessageIndex,
              classifiedNotice ? "notice" : "block",
            );
          }
          releaseReadyLanes();
        },
        undefined,
      );
    },
    finalize: (text) => {
      // Queue serialization would erase the fact that this call was made from
      // inside the current lane's synchronous transport send. Capture only that
      // call-stack fact; all reconciliation and state mutation stays queued.
      const reentrantOrdinarySettle = ordinaryFinalSendInProgress;
      return enqueue(
        "ordinary answer final",
        () => {
          const active = currentLane();
          if (reentrantOrdinarySettle) return false;
          if (active.settleResult && active.settleOutcome === undefined) return false;
          if (!text) {
            terminalDrain(false);
            return false;
          }
          if (
            state.finalReconciliation.leadingTerminalErrorSeen ||
            state.finalReconciliation.ordinaryAnswerSettled ||
            active.settleOutcome !== undefined
          ) {
            return deliverTerminalIndependent(text);
          }
          // Unlike partial callbacks, the ordinary final is durable and
          // authoritative. It is the only event allowed to replace an exact
          // quarantine with text that merely looks like a control marker.
          active.deferredAngleMarkerTail = undefined;
          active.lastPartialSourceText = "";
          terminalDrain(false);
          state.finalReconciliation.ordinaryAnswerSettled = true;
          active.answerText = text;
          active.answerRevision += 1;
          discardPendingProgress(
            (frame) => frame.kind === "lane" && frame.generation === active.generation,
          );
          ordinaryFinalSendInProgress = true;
          try {
            return settleLane(active, text);
          } finally {
            ordinaryFinalSendInProgress = false;
          }
        },
        false,
      );
    },
    deliverIndependentFinal: (input) =>
      enqueue(
        "independent final delivery",
        () => deliverTerminalIndependent(input.text),
        false,
      ),
    noteLeadingTerminalError: () => {
      void enqueue(
        "leading terminal error",
        () => {
          if (!state.finalReconciliation.ordinaryAnswerSettled) {
            state.finalReconciliation.leadingTerminalErrorSeen = true;
          }
        },
        undefined,
      );
    },
    drain: () =>
      enqueue(
        "terminal draft drain",
        () => {
          if (state.stopped) return;
          clearProgressTimer();
          clearEmptyPredecessorTimer();
          state.pendingProgress = undefined;
          terminalDrain(true);
        },
        undefined,
      ),
    snapshotText: () => currentLane().answerText,
    flush: () => enqueue("progress flush", flushPendingProgress, undefined),
    stop: () => {
      void enqueue(
        "draft stop",
        () => {
          state.stopped = true;
          clearProgressTimer();
          clearEmptyPredecessorTimer();
          state.pendingProgress = undefined;
        },
        undefined,
      );
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
  /** Consume one cumulative update from the native live-reasoning callback. */
  push: (update: ReasoningStreamUpdate) => void;
  /** Consume one complete durable reasoning block from the delivery adapter. */
  pushDurableBlock: (update: ReasoningStreamUpdate) => void;
  endBurst: () => void;
  stop: () => void;
};

/**
 * Normalizes OpenClaw's LIVE reasoning updates into cumulative, replace-by-id
 * wire frames. Each `onReasoningEnd` boundary rotates the id so separate live
 * reasoning bursts remain distinct in the UI. Complete durable blocks take the
 * separate `pushDurableBlock` path: each is emitted whole under a fresh id and
 * never participates in live-stream stale-prefix accounting. The sole replay
 * exception is pinned core's CLI path: while a live burst is still OPEN, its
 * exact final raw/display snapshot is delivered again as a durable block. A
 * successfully delivered exact match closes the live burst without emitting a
 * duplicate; equality or prefix overlap between independent durable blocks is
 * never deduplicated. If the live transport rejected its latest snapshot, the
 * durable block remains the fallback and is emitted normally.
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
  // Replay suppression is safe only when the matching live snapshot actually
  // reached the transport. A rejected live send leaves the durable result as the
  // only delivery path, so it must not be discarded merely because its text
  // matches the controller's in-memory snapshot.
  let liveSnapshotDelivered = false;
  let stopped = false;

  const closeLiveBurst = (): void => {
    if (currentText.length === 0) return;
    // The NEXT live burst's raw payload carries this closed burst's LAST RAW text
    // as its prefix (btw's accumulator is cumulative and already holds all prior
    // bursts), so assign — don't append our trimmed display text, which would
    // drop any inter-burst whitespace and break the prefix match from burst 3 on.
    stalePrefix = lastRawText;
    id = nextMessageId();
    currentText = "";
    liveSnapshotDelivered = false;
  };

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
    liveSnapshotDelivered = params.transport.sendReasoning(
      params.sessionKey,
      id,
      params.turnId,
      currentText,
    );
  };

  return {
    push,
    pushDurableBlock: (update) => {
      if (stopped) return;
      const text = typeof update.text === "string" ? update.text : "";
      if (text.length === 0) return;

      // Pinned core's CLI runtime bridges each thinking snapshot to the live
      // callback, then prepends the captured FINAL snapshot to its result as an
      // `isReasoning:true` payload without firing `onReasoningEnd`. Suppress only
      // that proven shape: an exact raw/display match while the live burst is
      // still OPEN. No prefix matching, and no memory after close — equal
      // independent durable blocks must each render.
      if (
        liveSnapshotDelivered &&
        currentText.length > 0 &&
        (text === currentText || text === lastRawText)
      ) {
        closeLiveBurst();
        return;
      }

      // Preserve an in-flight live burst before emitting this independent block.
      // Only closing LIVE state updates `stalePrefix`; the durable text itself is
      // sent whole and then rotates the id without touching that accumulator.
      closeLiveBurst();
      params.transport.sendReasoning(params.sessionKey, id, params.turnId, text);
      id = nextMessageId();
    },
    endBurst: () => {
      if (stopped || currentText.length === 0) return;
      closeLiveBurst();
    },
    stop: () => {
      stopped = true;
    },
  };
}
