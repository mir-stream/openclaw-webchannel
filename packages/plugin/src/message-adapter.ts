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

type AssistantDraftLane = {
  generation: number;
  assistantMessageIndex?: number;
  /** Assigned only after a successful first wire frame for this lane. */
  id?: string;
  /** A provisional id is tentative for the duration of one send transaction. */
  tentativeProvisionalId?: string;
  answerText: string;
  answerRevision: number;
  tentativeBarrierReservationIds: string[];
  closed: boolean;
  resolution: LaneResolution;
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
  token: string;
  noticeKind: "status" | "fallback" | "compaction";
  assistantMessageIndex?: number;
  state: "pending" | "retired";
};

type AuthorizedBlockDisposition = {
  sequence: number;
  route: "provisional-claim" | "fresh-fallback";
  settled: boolean;
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
  lastProgressSentAt: number;
  firstBoundarySeen: boolean;
  absorbedMissedBoundaries: number;
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
 * Per-turn draft state for partial/progress streaming.
 *
 * The provisional preview is turn-scoped and ownerless until a successful
 * durable delivery claims it. Assistant text is held in ordered, rotatable
 * lanes. Actual block and uncorrelated final payloads never acquire a lane;
 * they are delivered independently with their own sequence and wire id.
 */
export type ProgressDraftController = {
  /** True after any transport call for this controller has returned true. */
  readonly started: boolean;
  /** Queue one tool/item event for the provisional preview writer. */
  pushEvent(input: ChannelProgressDraftLineInput): void;
  /** Queue one cumulative/delta partial update for the current lane. */
  pushAnswerText: {
    (update: PartialAnswerUpdate): void;
    /** Transitional compatibility for inbound.ts until the wiring round. */
    (text: string): void;
  };
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
    input: { assistantMessageIndex?: number },
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
  /** Side-effect-free snapshot of the current assistant lane only. */
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
    absorbedMissedBoundaries: 0,
    lateReservationEpochOpen: true,
    nextTokenSequence: 0,
    nextDeliverySequence: 0,
    durableDeliverySucceeded: false,
    started: false,
    stopped: false,
  };
  const queue: SerialQueueState = { running: false, tasks: [] };

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

  const noticeKind = (input: NoticeFlags): TentativeNoticeToken["noticeKind"] | undefined => {
    if (input.isStatusNotice) return "status";
    if (input.isFallbackNotice) return "fallback";
    if (input.isCompactionNotice) return "compaction";
    return undefined;
  };

  const nextToken = (prefix: "block" | "notice"): string =>
    `${prefix}-${++state.nextTokenSequence}`;

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
    recordLaneFailure(lane, frameType, failure ?? "false");
    return false;
  };

  const sendIndependent = (text: string, recordBlockDisposition = false): boolean => {
    if (!text) return false;
    const sequence = ++state.nextDeliverySequence;
    const owner: ProvisionalClaimOwner = { kind: "independent", deliverySequence: sequence };
    const reservation = reserveProvisional(owner);
    let disposition: AuthorizedBlockDisposition | undefined;
    if (recordBlockDisposition) {
      disposition = {
        sequence,
        route: reservation.usesPreview ? "provisional-claim" : "fresh-fallback",
        settled: false,
      };
      state.blockDispositions.push(disposition);
    }
    let sent = false;
    let failure: DeliveryFailureKind | undefined;
    try {
      sent = transport.finalizeDraft(sessionKey, reservation.id, text, params.turnId) === true;
      if (!sent) failure = "false";
    } catch {
      failure = "throw";
    }
    if (disposition) disposition.settled = true;
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

  const laneHasFailedCurrentRevision = (lane: AssistantDraftLane): boolean =>
    lane.answerRevision > 0 && lane.lastFailedDelivery?.revision === lane.answerRevision;

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

  const settleLane = (lane: AssistantDraftLane, text: string): boolean => {
    if (lane.settleOutcome !== undefined) return lane.settleOutcome;
    if (lane.settleResult) return false;

    // Arm the per-lane latch before the synchronous transport call. A
    // re-entrant settle observes this promise and cannot emit a second frame.
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
        if (
          lane.answerText &&
          !lane.settled &&
          !laneHasFailedCurrentRevision(lane)
        ) {
          settleLane(lane, lane.answerText);
        }
        continue;
      }
      if (lane !== active || !lane.answerText || lane.settled) continue;
      if (options?.settleCurrent) {
        discardPendingProgress(
          (frame) => frame.kind === "lane" && frame.generation === lane.generation,
        );
        if (!laneHasFailedCurrentRevision(lane)) settleLane(lane, lane.answerText);
      } else if (
        options?.emitCurrentProgress !== false &&
        lane.lastProgressAttemptRevision < lane.answerRevision &&
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
  };

  const attachIndexedReservations = (lane: AssistantDraftLane): void => {
    if (!state.lateReservationEpochOpen) return;
    for (const reservation of state.blockReservations) {
      if (
        reservation.state !== "pending" ||
        reservation.barrierGeneration !== undefined ||
        reservation.assistantMessageIndex !== lane.generation
      ) {
        continue;
      }
      reservation.barrierGeneration = lane.generation;
      lane.assistantMessageIndex ??= reservation.assistantMessageIndex;
      lane.tentativeBarrierReservationIds.push(reservation.token);
    }
  };

  const closeAndRotate = (): void => {
    const lane = currentLane();
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
      lane.acceptsLateIndexlessReservations = true;
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
    if (lane.tentativeBarrierReservationIds.length === 0) {
      lane.acceptsLateIndexlessReservations = false;
      if (!lane.answerText && lane.resolution !== "materialized") {
        lane.resolution = "empty";
      }
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
    retireTentativeState();
    releaseReadyLanes({
      emitCurrentProgress: false,
      settleCurrent,
    });
    if (settleCurrent) settlePreviewIfAlone();
  };

  const deliverTerminalIndependent = (text: string): boolean => {
    // Retirement opens ordering barriers, but the authoritative terminal
    // payload gets the first P claim attempt before any newly released lane.
    // On failure its rollback lets the first released lane claim P instead.
    retireTentativeState();
    const sent = sendIndependent(text);
    releaseReadyLanes({ emitCurrentProgress: false });
    return sent;
  };

  return {
    get started() {
      return state.started;
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
    pushAnswerText: (input: PartialAnswerUpdate | string) => {
      void enqueue(
        "partial answer update",
        () => {
          let lane = currentLane();
          if (state.stopped || lane.settled) return;
          const update = typeof input === "string" ? { text: input } : input;
          const raw =
            typeof update.text === "string" && update.text.length > 0
              ? update.text
              : typeof update.delta === "string" && update.delta.length > 0
                ? lane.answerText + update.delta
                : undefined;
          if (raw === undefined) return;
          const cleaned = stripInlineDirectiveTagsForDelivery(
            stripReasoningTagsFromText(raw, { mode: "strict", trim: "both" }),
          ).text;
          if (!cleaned || cleaned === lane.answerText) return;

          // This is the sole content-prefix check in the answer state machine.
          // It is a fail-safe for a missing structured boundary, not an attempt
          // to correlate callback bodies or final payloads. Explicit replace
          // updates stay in the same lane even when their text diverges.
          if (
            update.replace !== true &&
            lane.answerText.length > 0 &&
            !cleaned.startsWith(lane.answerText)
          ) {
            warn(
              `contract violation: cumulative partial diverged without an assistant-message ` +
                `boundary; preserving generation ${lane.generation} and rotating defensively`,
            );
            closeAndRotate();
            state.absorbedMissedBoundaries += 1;
            lane = currentLane();
          }

          lane.answerText = cleaned;
          lane.answerRevision += 1;
          lane.lastFailedDelivery = undefined;
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
          if (state.absorbedMissedBoundaries > 0) {
            state.absorbedMissedBoundaries -= 1;
            state.firstBoundarySeen = true;
            return;
          }
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
          const classifiedNotice = noticeKind(input);
          if (classifiedNotice) {
            state.noticeTokens.push({
              token: nextToken("notice"),
              noticeKind: classifiedNotice,
              assistantMessageIndex: input.assistantMessageIndex,
              state: state.lateReservationEpochOpen ? "pending" : "retired",
            });
            return;
          }

          const reservation: TentativeBlockReservation = {
            token: nextToken("block"),
            assistantMessageIndex: input.assistantMessageIndex,
            state: state.lateReservationEpochOpen ? "pending" : "retired",
          };
          state.blockReservations.push(reservation);
          if (reservation.state === "retired") return;

          let barrierLane: AssistantDraftLane | undefined;
          if (input.assistantMessageIndex !== undefined) {
            barrierLane = state.lanes.find(
              (lane) =>
                lane.assistantMessageIndex === input.assistantMessageIndex ||
                lane.generation === input.assistantMessageIndex,
            );
            if (barrierLane) barrierLane.assistantMessageIndex ??= input.assistantMessageIndex;
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
        () => {
          // Re-classify the wire-authoritative payload before touching lane or
          // reservation state. Both notice and non-notice blocks use the same
          // independent claim-or-fresh transaction.
          const actualNotice = noticeKind(input);
          if (actualNotice) return sendIndependent(input.text, true);
          return sendIndependent(input.text, true);
        },
        false,
      ),
    noteDeliveryLifecycle: (kind, input) => {
      void enqueue(
        `delivery lifecycle ${kind}`,
        () => {
          if (kind === "error") {
            warn("delivery adapter reported an error; ambiguous reservations await terminal drain");
          }
          const index = input.assistantMessageIndex;
          if (index !== undefined) {
            const reservations = state.blockReservations.filter(
              (reservation) =>
                reservation.state === "pending" &&
                reservation.assistantMessageIndex === index,
            );
            if (reservations.length === 1) retireReservation(reservations[0]!);

            const notices = state.noticeTokens.filter(
              (token) =>
                token.state === "pending" && token.assistantMessageIndex === index,
            );
            if (notices.length === 1) notices[0]!.state = "retired";
          }
          releaseReadyLanes();
        },
        undefined,
      );
    },
    finalize: (text) => {
      const lane = currentLane();
      if (lane.settleResult) return lane.settleResult;
      return enqueue(
        "ordinary answer final",
        () => {
          const active = currentLane();
          if (active.settleOutcome !== undefined) return active.settleOutcome;
          if (active.settleResult) return false;
          if (!text) {
            terminalDrain(false);
            return false;
          }
          if (
            state.finalReconciliation.leadingTerminalErrorSeen ||
            state.finalReconciliation.ordinaryAnswerSettled
          ) {
            return deliverTerminalIndependent(text);
          }
          terminalDrain(false);
          state.finalReconciliation.ordinaryAnswerSettled = true;
          active.answerText = text;
          active.answerRevision += 1;
          active.lastFailedDelivery = undefined;
          discardPendingProgress(
            (frame) => frame.kind === "lane" && frame.generation === active.generation,
          );
          return settleLane(active, text);
        },
        false,
      );
    },
    deliverIndependentFinal: (input) =>
      enqueue(
        "independent final delivery",
        () => {
          // The actual flags, not any earlier callback classification, decide
          // that this payload is independent. Terminal delivery also closes the
          // late-reservation epoch before sending.
          noticeKind(input);
          return deliverTerminalIndependent(input.text);
        },
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
          clearProgressTimer();
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
