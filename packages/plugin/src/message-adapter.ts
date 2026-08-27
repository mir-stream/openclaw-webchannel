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
 *
 * #238: this is now THE mint point for every delivery act on this channel, not
 * just this adapter's. The plugin owns message identity and assigns it at the
 * moment it delivers — exactly like core's built-in Telegram extension keeps the
 * `message_id` the platform hands back at first send. We ARE the platform here,
 * so we mint locally.
 *
 * THE INVARIANT: one mint point, one id shape, and every durable-text egress
 * site calls it. All six, deliberately UNNUMBERED here — the tests own the
 * "site N" numbering and it counts only the four sites #238 changed, so a
 * second numbering in this docblock would make "site 4" mean two different
 * files depending on which file you are reading:
 *   - inbound.ts's unclaimed-delivery reply         -> tests' site 1
 *   - inbound.ts's thrown-turn apology              -> tests' site 2
 *   - channel.ts's core-initiated outbound seam     -> tests' site 3
 *   - nats-account-runtime.ts's command-gate notice -> tests' site 4
 *   - this adapter's own `send.text`                -> already minted at base
 *   - the progress-draft finalize path (nats-channel.ts's `finalizeDraft` ->
 *     `sendText`), minted right here                -> already minted at base
 * So #238 changed the first four; the adapter's `send.text` and the draft path
 * already minted through this function before the slice. The draft path is
 * listed anyway because under `streaming.mode: "partial"` — what the product
 * actually runs — it is the channel's PRIMARY durable-text egress, so an
 * enumeration that omits it reads as complete while being the least
 * representative half of the truth. No other id shape may be introduced, and
 * the client must never mint one for a durable bubble (NOT-list N4/N5).
 *
 * The receipt half is SEPARATE and narrower: only two of these six report an id
 * to core at all (this adapter's `send.text` and channel.ts's outbound seam —
 * the other four return neither a `messageId` nor a receipt). Where a site does
 * report one, it reports this same id, so core's receipt and the client's
 * bubble never end up as two names for one message.
 */
export function nextMessageId(): string {
  return `webchannel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a `MessageReceipt` whose primary/only platform id is `id`.
 *
 * `MessageReceipt` (stable export:
 * `node_modules/openclaw/dist/plugin-sdk/channel-outbound.d.ts`) requires
 * `platformMessageIds: string[]`, `parts: MessageReceiptPart[]`, `sentAt: number`;
 * `primaryPlatformMessageId` is the stable editable id. We delegate to
 * `createMessageReceiptFromOutboundResults` (same stable export) so the receipt
 * is shaped exactly as core expects from one text part.
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
 *    allowed to COEXIST — the bundled SMS channel ships both (observed internal
 *    behavior, verified at OpenClaw 2026.7.1-2). We keep `outbound` for
 *    core-initiated sends and add this adapter to declare our live capabilities.
 *
 *  - The `live` facet declares the progress-draft capabilities
 *    (`draftPreview`/`progressUpdates`/`previewFinalization`,
 *    `ChannelMessageLiveCapability`, stable export:
 *    `node_modules/openclaw/dist/plugin-sdk/channel-outbound.d.ts`).
 *
 * IMPORTANT (verified by tracing the runtime): core does NOT auto-drive a
 * plugin's `message.live` adapter to produce progress drafts. The live
 * draft+edit machinery is implemented per-channel inside each channel's own
 * monitor/message-handler using the shared helpers
 * (`createChannelProgressDraftCompositor`, `createDraftStreamLoop`, ...). The
 * built-in path lives entirely under `extensions/discord/src/monitor/...`
 * and calls Discord REST `editChannelMessage`/`createChannelMessage` directly
 * (observed internal behavior, verified at OpenClaw 2026.7.1-2).
 *
 * For a PLUGIN channel the generic seam is the inbound turn's reply dispatcher:
 * the `AssembledChannelTurn` we return from `resolveTurn` accepts
 * `replyOptions?: Omit<GetReplyOptions, "onBlockReply">` and `dispatcherOptions`
 * (structurally checked through the stable `OpenClawPluginApi` export in
 * `node_modules/openclaw/dist/plugin-sdk/channel-core.d.ts`). Those carry
 * `onToolStart`/`onItemEvent`/`onPartialReply` through `GetReplyOptions` (stable
 * export: `node_modules/openclaw/dist/plugin-sdk/reply-runtime.d.ts`). We hook
 * them to drive our own draft (see `createProgressDraftController`) and emit WS
 * `progress` frames, then finalize through the turn's `delivery.deliver`. See
 * src/inbound.ts.
 *
 * `send.text` must return `ChannelMessageSendResult = { receipt; messageId? }`
 * (stable export: `node_modules/openclaw/dist/plugin-sdk/channel-outbound.d.ts`).
 * We return a real receipt whose primary id is our generated per-message id;
 * this is also the fallback send used if core ever drives the adapter directly.
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
  // plain no-draft path. `resolveChannelPreviewStreamMode` and `StreamingMode`
  // are stable exports of
  // `node_modules/openclaw/dist/plugin-sdk/channel-outbound.d.ts`.
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
  /**
   * #172: this lane's SOUND per-message identity — core's 1-based
   * `assistantMessageIndex` for the assistant message this lane carries. Stamped
   * by `handleAssistantMessageBoundary` from a boundary counter that ticks on
   * EVERY `onAssistantMessageStart` (including the swallowed first), so message A
   * = 1, B = 2, matching core. A lane the fail-safe `closeAndRotate` created
   * WITHOUT a boundary callback is left undefined on purpose: it has no sound
   * identity, so its block cannot be matched and degrades to independent
   * delivery (recovery preserved).
   *
   * DELIBERATELY SEPARATE from the barrier/reservation system, which picks its
   * lanes from lane STATE: no ordinal chooses a LANE there. That is the whole of
   * the claim — the reservation system still READS the ordinal in three live
   * places (it stores it on the reservation, it arms an indexless reservation's
   * lane, and `outstandingRecordsAtIndex`/`retireOneRecordAtIndex` match on it to
   * retire a barrier), and every one of those is load-bearing. Do not read
   * "separate" as "the ordinal is unused over there" and delete a read on that
   * basis; a review pass did exactly that to the arming branch and measured 19
   * red on this tree, all of them the same shape — a lane held past the point it
   * should have released, so the next message never streams.
   *
   * This field is used ONLY by `laneForAssistantMessageIndex` for the #172
   * block-suppression decision and never feeds ordering.
   *
   * That separation is the whole point, so keep it: this stamp answers "which
   * assistant message does this lane carry", which is a rendering question about
   * a lane that already exists. It must never be inverted into "which lane does
   * this record belong to" — an ordinal deciding a record's lane is the
   * forbidden move (plan §0.2 N5), whatever the base arithmetic.
   */
  assistantMessageIndex?: number;
  /** Assigned only after a successful first wire frame for this lane. */
  id?: string;
  /** A provisional id is tentative for the duration of one send transaction. */
  tentativeProvisionalId?: string;
  answerText: string;
  /**
   * #212 (Phase 3): the cleaned VISIBLE answer text this lane STREAMED, captured
   * at `pushAnswerText` time (and on a deferred-tail restore) and NEVER
   * overwritten by an authoritative final. `answerText` is topped up in place by
   * `emitAuthoritativeFinalOnLane`/`flushBufferedOrdinaryFinals`, so it inherits
   * the #215 mis-routing corruption (a final landing on the wrong lane). This
   * field does not, so the `turn_snapshot` uses it as the corruption-immune
   * fallback text source. The deliberate tradeoff is the open VERIFY-1 edge (a
   * final-only tail that never streamed is missed) — but only on the buffered
   * mis-routable path; the common immediate path prefers `answerText` (see
   * `answerTextIsAuthoritative`).
   */
  streamedAnswerText: string;
  /**
   * #212 (Phase 3): is `answerText` a CORRECTLY-ROUTED authoritative final, safe
   * to show verbatim in the snapshot? Set true when routing is proved: by
   * `finalize`'s immediate collapse / current-lane-has-text / lone-message path,
   * or by `flushBufferedOrdinaryFinals` when order-correlation is exact
   * (`exactCorrelation` — every final has a streamed lane to pair with) and THIS
   * target's `streamedVisibleAnswerText` proves it streamed its own prefix. Left
   * false on a count shortfall, or for the K==1 Case-X textless current lane. Note
   * the predicate is CARDINALITY-based, so a compensating desync (a deduped final
   * plus an unstreamed message) can still pass it — a pre-#238 hole, not closed
   * here (#262). The snapshot uses `answerText` when this is true (preserving the
   * final's tail beyond the last partial — the VERIFY-1 edge, and the north-star
   * "final is not droppable") and falls back to the corruption-immune
   * `streamedAnswerText` otherwise.
   */
  answerTextIsAuthoritative: boolean;
  /**
   * #173: did this lane ever receive non-empty VISIBLE answer text? Set true at
   * the `lane.answerText = cleaned` assignment, which is AFTER the reasoning
   * filter's early-return, so a reasoning-only partial never sets it. It is
   * PERSISTENT: never cleared on close/rotate, so a lane the fail-safe rotated
   * away still counts. `finalize` uses it as the answer-lane routing predicate:
   * an ordinary final is paired with a text-bearing lane in generation order,
   * never a tool-only/reasoning-only lane (see the collapse-aware routing in
   * `finalize`). It tracks BOTH rotation paths (boundary and the `closeAndRotate`
   * fail-safe) and never counts a reasoning partial the adapter filtered.
   */
  streamedVisibleAnswerText: boolean;
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
  /**
   * #173: per-turn cursor counting how many ordinary (non-error, non-notice)
   * answer-finals have already been routed to a lane this turn. The Nth such
   * final settles the Nth target lane in generation order — see `finalize`. Core
   * emits one ordinary final per text-bearing message when the last assistant
   * message is tool-only (the #173 topology), and exactly ONE collapsed final
   * (the last message's text) when the last message itself has text. The cursor
   * lets order-based routing pair each final with the lane it belongs to instead
   * of always overwriting `currentLane()`.
   */
  ordinaryAnswerFinalsRoutedToLanes: number;
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
  /**
   * #172: count of `onAssistantMessageStart` boundaries observed this turn,
   * including the swallowed first one. Reproduces core's 1-based
   * `assistantMessageIndex` (the Nth boundary ⇔ core index N) and is stamped
   * onto the lane that boundary opens. Fail-safe rotations have no boundary and
   * do not tick it, so their lanes stay unstamped.
   */
  assistantMessageBoundaryCount: number;
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
 * The pinned OpenClaw TOOL_CALL_TAG_NAMES plus its adjacent `final` tag.
 * Keep this fixed allowlist in sync when the core pin moves.
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
] as const;
const XML_NAME_CHAR_RE = /[A-Za-z0-9_.:-]/;

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

function classifyAngleMarkerAt(
  text: string,
  start: number,
): "incomplete" | "exact" | undefined {
  if (text[start] !== "<") return undefined;

  let cursor = start + 1;
  while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  if (text[cursor] === "/") {
    cursor += 1;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  }
  // A bare `<` is still a viable distinctive marker prefix. The next name byte
  // either promotes the hold or proves ordinary literal text immediately.
  if (cursor === text.length) return "incomplete";

  const nameStart = cursor;
  while (XML_NAME_CHAR_RE.test(text[cursor] ?? "")) cursor += 1;
  if (cursor === nameStart) return undefined;
  const fragment = text.slice(nameStart, cursor).toLowerCase();
  for (const name of CORE_ANGLE_MARKER_NAMES) {
    if (fragment === name) {
      const boundary = text[cursor];
      if (boundary === undefined || boundary === "<") return "incomplete";
      return /\s/.test(boundary) || boundary === "/" || boundary === ">"
        ? "exact"
        : undefined;
    }
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

  const result: AngleMarkerScan = {};
  for (let start = firstAngle; start >= 0; start = text.indexOf("<", start + 1)) {
    const classification = classifyAngleMarkerAt(text, start);
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
    /** Observed run/attempt-local block ordinal; never a durable history key. */
    assistantMessageIndex?: number;
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
    streamedAnswerText: "",
    answerTextIsAuthoritative: false,
    streamedVisibleAnswerText: false,
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
      ordinaryAnswerFinalsRoutedToLanes: 0,
    },
    lines: [],
    lastProgressSentAt: 0,
    firstBoundarySeen: false,
    assistantMessageBoundaryCount: 0,
    lateReservationEpochOpen: true,
    nextTokenSequence: 0,
    nextDeliverySequence: 0,
    durableDeliverySucceeded: false,
    started: false,
    stopped: false,
  };
  const queue: SerialQueueState = { running: false, tasks: [] };
  let ordinaryFinalSendInProgress = false;
  // #173: ordinary finals that arrived while the current lane was TEXTLESS, held
  // in arrival order until drain. At finalize time the collapse-with-nonstreaming-
  // last shape (K==1 → the final is the last/current lane's own text) is
  // indistinguishable from the tool-only-last shape (K>=2 → one final per
  // text-bearing lane); only the drain-time COUNT tells them apart. See
  // `flushBufferedOrdinaryFinals` and `finalize`.
  const bufferedOrdinaryFinals: string[] = [];
  // #212: wire ids of independent bubbles the plugin KNOWS carry answer content
  // already represented by a lane in the `turn_snapshot`. Since #238 there is
  // exactly ONE producer — the failed-lane recovery block (:2424), whose lane is
  // in `answers` by its streamed text. (The overflow-final producer is gone: its
  // flag's value was `streamed.length === finals.length`, unreachable at an
  // overflow under the new candidate list.) The snapshot names these in `remove`
  // so the client drops exactly them and preserves every other agent bubble
  // (notices/errors). A missed id leaves a corruption bubble; a wrongly-added id
  // would lose content — captured ONLY at that one mint site, never from a
  // notice/error path.
  const supersededAnswerBubbleIds: string[] = [];

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

  const sendIndependent = (
    text: string,
    assistantMessageIndex?: number,
    // #212: when this independent bubble carries answer content a lane ALSO
    // represents in the snapshot's `answers`, record its wire id so the snapshot
    // can name it in `remove` (the client then drops this duplicate). Set at ONE
    // site — the failed-lane recovery block, whose lane is in `answers` by its
    // streamed text. Never a notice, and (since #238) never an overflow final: the
    // flag's old value there was `streamedLanes.length === finals.length`, which
    // UNDER THE NEW CANDIDATE LIST is mutually exclusive with overflow, so it had
    // no reachable true case. Scope that to the new list — under the OLD one
    // (`materializedAnswerLanes()`) the two were perfectly compatible: 3 streamed,
    // 2 materialized, 3 finals made the flag true WITH an overflow, which is the
    // `remove: [tcId]` base's M212a asserted. And NOT because an overflow bubble's
    // content never streamed — measured false, it often has (see the flush's
    // overflow branch).
    options?: { supersedesAnswerLane?: boolean },
  ): boolean => {
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
      sent =
        (assistantMessageIndex === undefined
          ? transport.finalizeDraft(sessionKey, reservation.id, text, params.turnId)
          : transport.finalizeDraft(
              sessionKey,
              reservation.id,
              text,
              params.turnId,
              assistantMessageIndex,
            )) === true;
      if (!sent) failure = "false";
    } catch {
      failure = "throw";
    }
    if (sent) {
      commitReservation(reservation);
      if (options?.supersedesAnswerLane === true) {
        supersededAnswerBubbleIds.push(reservation.id);
      }
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
    // #212: a restored incomplete-prose tail is genuine streamed content — keep
    // the snapshot's streamed source in step with it.
    lane.streamedAnswerText = restored;
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
   *
   * EXCEPTION since #238: "invents no bubble" describes THIS predicate's callers
   * (`releaseReadyLanes`, the throttle flush), not the whole controller. The
   * buffered-final flush does not consult this at all, so on the exact-correlation
   * path it can settle a never-materialized lane and thereby invent exactly such a
   * bubble (M173e's lane B). That is intended: there the lane has a final of its
   * own to carry, which is the one thing a merely-HELD revision never had.
   */
  const laneTerminalSuppressed = (lane: AssistantDraftLane): boolean =>
    lane.resolution !== "materialized" && laneHasFailedCurrentRevision(lane);

  // #173: the answer lanes that streamed VISIBLE answer text AND actually reached
  // the client (`resolution === "materialized"`).
  //
  // Two callers: `finalize`'s AMBIGUITY PRECONDITION, and the flush's SHORTFALL
  // fallback list.
  //
  // The precondition asks "is this textless-current-lane shape ambiguous at all,
  // or is the current lane the unambiguous target?" — and materialization is the
  // right test for DECIDABILITY, which is a narrower justification than the one
  // that used to sit here. That claim was: with no answer lane on the client's
  // screen there is no earlier bubble a final could be topping up. It is FALSE, and
  // measured so — `emitTurnSnapshot` publishes never-materialized lanes under a
  // freshly minted id, and the client MINTS a bubble for an id it does not know
  // (`packages/client/src/nats-client-wrapper.ts:1533-1544`). A never-materialized
  // lane can absolutely own a bubble by the end of the turn.
  //
  // The real reason it works is empirical, not deductive: an unmaterialized lane
  // has no live wire presence AT THIS INSTANT, so treating the shape as the
  // lone-message one keeps the immediate path — which is what makes M13g's
  // failed-lane-A shape settle B on its own preview id rather than buffering.
  //
  // KNOWN HOLE, recorded rather than fixed: when EVERY text-bearing lane's frames
  // fail, this returns empty, the precondition's `textBearingLanes.length > 0` is
  // false, the shape is declared unambiguous, the flush never runs at all — and so
  // #238's cursor never reaches that shape. Out of scope for this slice.
  //
  // It is deliberately NOT the flush's candidate list in the exact-correlation
  // case — see `streamedAnswerLanes` and `flushBufferedOrdinaryFinals`. Narrowing
  // the CANDIDATES by materialization is what skewed the order; narrowing the
  // PRECONDITION by it is what makes the shape decidable. Two different questions
  // that happen to share a predicate — and, on a shortfall, a third: the safest
  // list to route onto when the pairing cannot be trusted anyway.
  const materializedAnswerLanes = (): AssistantDraftLane[] =>
    state.lanes.filter(
      (lane) => lane.streamedVisibleAnswerText && lane.resolution === "materialized",
    );

  // #238 (v6 slice 5): the lanes the buffered-final cursor walks WHEN
  // order-correlation is exact — every lane that STREAMED visible answer text, in
  // generation order. This is deliberately the exact same set `emitTurnSnapshot`
  // publishes as `answers` (:1777), so a lane the cursor can settle and a lane the
  // snapshot can carry are the same lane.
  //
  // Materialization is NOT required, and that is the point. Core hands the channel
  // the turn's finals as an ORDERED array
  // (`[core] src/auto-reply/reply/dispatch-from-config.ts:3886` — `const replies =
  // …`; `:3910` — `for (const [replyIndex, reply] of replies.entries())`), and
  // order is the only correlation on offer. Dropping a lane whose frame failed to
  // ship throws part of that order away and skews every later index (plan §16.5.3).
  //
  // That cuts BOTH ways, which is why `flushBufferedOrdinaryFinals` gates its use:
  // every lane in this set is one the snapshot republishes, so routing a final onto
  // one under a shortfall lets the snapshot overwrite it. See the gate there.
  const streamedAnswerLanes = (): AssistantDraftLane[] =>
    state.lanes.filter((lane) => lane.streamedVisibleAnswerText);

  // #172: the lane carrying core's assistant message `assistantMessageIndex`, by
  // the sound per-message stamp this controller wrote itself. Read-only, and
  // used ONLY for the #172 block-suppression decision — it never picks the lane
  // a record attaches to. Undefined for an unstamped index (no boundary opened a
  // lane for it — e.g. a fail-safe rotation) or an indexless block.
  const laneForAssistantMessageIndex = (
    assistantMessageIndex: number | undefined,
  ): AssistantDraftLane | undefined => {
    if (assistantMessageIndex === undefined) return undefined;
    return state.lanes.find(
      (lane) => lane.assistantMessageIndex === assistantMessageIndex,
    );
  };

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
    // flight, and "text-less" is exactly what a lane whose only content is an
    // undelivered block looks like. Releasing on that evidence would let the
    // successor stream ahead of a block still on its way, which is a permanent
    // bubble inversion, not a delay.
    //
    // Deliberately turn-wide and lane-agnostic, and it stays that way now that
    // reservations attach by lane state rather than by an ordinal comparison.
    // Attachment answers "which lane is held", which is a strictly narrower
    // question than "is any block still owed in this turn" — a reservation whose
    // own lane is the current one holds no successor at all, and this gate is
    // what still covers that. It never depended on the attachment answer and
    // must not start depending on it.
    //
    // With a block outstanding we fall back to the documented turn-bounded
    // delay, which `retireReservation` and terminal drain both clear.
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
   * with the block pipeline enqueueing onto its own serial chain the same way
   * (observed internal behavior, verified at OpenClaw 2026.7.1-2) — so an
   * earlier message's block is delivered AND settled before a later message's
   * payload arrives, and that is why emitting held text ahead of the arriving
   * payload is SAFE WHEN IT FIRES.
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
    // No late attachment pass here on purpose. Every block reservation picks its
    // barrier lane from LANE STATE at queue time (`noteBlockReplyQueued`), so
    // there is no such thing as a reservation still waiting for the lane that
    // will "match" it. The rotation-time rescan that used to live here existed
    // only to retry an ordinal→generation comparison; see the reservation
    // docblock for why that comparison is gone.
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
   *
   * CALLER DEPENDENCY, so a change here does not silently break it:
   * `noteBlockReplyQueued`'s arming branch is a capability test on THIS
   * function. It arms a lane exactly when a reservation is un-retirable before
   * drain, and "un-retirable" means precisely what this function refuses — the
   * `undefined` bail below, and the strict-equality index match in
   * `outstandingRecordsAtIndex`. Widen either one so that indexless records can
   * be matched, and that arming predicate becomes wrong: it would keep arming
   * lanes that are now retirable, over-holding them. (Safe direction — it stalls,
   * it never inverts — but it is still a stall, so go update the branch.)
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

  // #212 (Phase 3, targeted): publish the plugin's AUTHORITATIVE ordered set of
  // the turn's agent ANSWER bubbles so the client renders them verbatim (fixing
  // #174 ordering and dissolving the #215 K>=2 mid-lane corruption). Called at the
  // terminal drain AFTER `flushBufferedOrdinaryFinals` (so every lane's text and
  // the superseded-id set are final) and BEFORE `turn_settled`.
  //
  //  - `answers` = the answer lanes (those that streamed visible text) in
  //    generation order. `id` reuses the lane's own materialized wire id, or a
  //    freshly minted id for a lane that streamed but never reached the wire
  //    (failed-frame recovery — the client mints that bubble). `text` is the
  //    lane's AUTHORITATIVE text when a correctly-routed final settled it
  //    (`answerTextIsAuthoritative`, preserving the final's tail), else the
  //    corruption-immune `streamedAnswerText`.
  //  - `remove` = the ids of independent bubbles that PROVABLY duplicate a lane in
  //    `answers` — since #238 that is exactly one shape, the failed-lane recovery
  //    block. An overflow final is NOT one of them, and deliberately so: it MAY
  //    duplicate a lane here (measured — see the flush's overflow branch), but the
  //    flush cannot tell when, and a visible duplicate is recoverable where a
  //    deletion is not (M212g). The client drops ONLY these and preserves every
  //    other agent bubble.
  //
  // Case X (K==1) is DELIBERATELY not addressed: it is byte-identical to the
  // legitimate non-streaming-last collapse (M173c/M15a/M15b), so its tool bubble
  // is neither an `answers` lane (it never streamed) nor in `remove` — it is
  // preserved, unchanged, exactly as before.
  const emitTurnSnapshot = (): void => {
    const turnId = params.turnId;
    // No correlation key ⇒ the client cannot scope the reconciliation to a turn.
    if (turnId === undefined) return;
    if (typeof transport.sendTurnSnapshot !== "function") return;
    // The SAME set `flushBufferedOrdinaryFinals` walks with its cursor, by
    // construction rather than by coincidence (#238).
    const answers = streamedAnswerLanes()
      .map((lane) => ({
        id: lane.id ?? nextMessageId(),
        text: lane.answerTextIsAuthoritative ? lane.answerText : lane.streamedAnswerText,
      }));
    const remove = [...new Set(supersededAnswerBubbleIds)];
    if (answers.length === 0 && remove.length === 0) return;
    try {
      transport.sendTurnSnapshot(sessionKey, turnId, answers, remove);
    } catch {
      // A render-fidelity overlay: a failed emit degrades to the pre-#212
      // arrival-order render — it never blocks the drain or `turn_settled`.
      warn("turn_snapshot delivery threw; live-turn agent order falls back to arrival order");
    }
  };

  const terminalDrain = (settleCurrent: boolean): void => {
    resolveDeferredAngleMarkerTail(currentLane());
    retireTentativeState();
    releaseReadyLanes({
      emitCurrentProgress: false,
      settleCurrent,
    });
    if (settleCurrent) {
      settlePreviewIfAlone();
      // #173: the terminal settle is the point where the buffered-final count is
      // finally known, so it is where the textless-currentLane finals resolve.
      flushBufferedOrdinaryFinals();
      // #212: emit AFTER the flush (lane text + superseded ids now final).
      emitTurnSnapshot();
    }
  };

  // #238: this used to forward a `supersedesAnswerLane` option for the
  // overflow-final site. The flag's old value there was `streamed.length ===
  // finals.length`, which under the new candidate list cannot hold at an overflow
  // (see the flush's overflow branch) — so the option had no reachable true case
  // here and is gone. That is a CARDINALITY argument and only that: do NOT
  // paraphrase it as "an overflow final's content never streamed", which is
  // measured false and is the premise that would justify deleting the bubble.
  // EVERY bubble this function produces (leading error, stray extra, notice,
  // overflow final) is preserved by the client. `sendIndependent` keeps the option
  // for its one remaining user, the failed-lane recovery block (:2423), whose
  // duplicate IS provable.
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

  // #173: apply an ordinary final's authoritative text to a lane and settle it on
  // that lane's OWN id. A lane other than the current one has already auto-settled
  // with its last partial (`releaseReadyLanes` at its boundary); the final may
  // carry a tail the partials never emitted, so top it up on the same id rather
  // than dropping it (`settleLane` no-ops on an already-settled lane). Wrapped in
  // the re-entrancy latch because the synchronous transport send can call back
  // into `finalize`. Does NOT reset the deferred-angle-marker tail — callers do
  // that first, before any `terminalDrain`, so the tail resolver sees it cleared.
  const emitAuthoritativeFinalOnLane = (
    target: AssistantDraftLane,
    text: string,
    // #212: true only when this final is provably THIS lane's own: from
    // `finalize`'s immediate collapse / current-lane-has-text / lone-message path,
    // or from `flushBufferedOrdinaryFinals` when order-correlation is exact
    // (`exactCorrelation`) and THIS target's
    // `streamedVisibleAnswerText` is true. Otherwise — a count shortfall, or the
    // K==1 Case-X textless current lane — the snapshot falls back to the
    // corruption-immune `streamedAnswerText`.
    options?: { authoritative?: boolean },
  ): boolean => {
    target.answerText = text;
    if (options?.authoritative === true) target.answerTextIsAuthoritative = true;
    target.answerRevision += 1;
    discardPendingProgress(
      (frame) => frame.kind === "lane" && frame.generation === target.generation,
    );
    ordinaryFinalSendInProgress = true;
    try {
      return target.settleOutcome !== undefined
        ? sendLaneFrame(target, "final", text)
        : settleLane(target, text);
    } finally {
      ordinaryFinalSendInProgress = false;
    }
  };

  // #173/#238: resolve the finals that `finalize` buffered while the current lane
  // was textless. Called from the terminal drain, where the count K is known.
  //
  // THE MODEL IS A SINGLE FORWARD-ONLY CURSOR, copied from core's built-in
  // Telegram channel (plan §16.5.1, measured against the pinned clone):
  //
  //   - Core hands the channel the turn's finals as an ORDERED ARRAY
  //     (`[core] src/auto-reply/reply/dispatch-from-config.ts:3886` — `const
  //     replies = …`; `:3910` — `for (const [replyIndex, reply] of
  //     replies.entries())`).
  //   - Telegram consumes that array with ONE cursor and never asks "which past
  //     bubble owns this final", because it has no past bubbles to ask about: its
  //     `lane` is a CONTENT TYPE (`LaneName = "answer" | "reasoning"`,
  //     `[core] extensions/telegram/src/lane-delivery-text-deliverer.ts:19`), so
  //     exactly one answer bubble is ever open.
  //
  // Our lanes are PER-ASSISTANT-MESSAGE, so N are open at once. That asymmetry is
  // deliberate UX and it stays — but it changes nothing about the correlation core
  // supplies, which is ORDER. Precisely (plan §16.5.3): a final has no durable id
  // (Q1 — we mint one) and no explicit pointer (Q2), but it HAS a position. What it
  // does not support is retroactive attribution to an arbitrary past bubble (Q3) —
  // Telegram cannot do that either, and neither of us needs to.
  //
  //   K == 1 → the single final is the last (current, textless) message's own
  //            text: a collapse whose last message streamed no partial, or a
  //            lone message with no partial. Settle the current lane on its id.
  //            (Case X — a single streamed answer followed by a tool-only last
  //            message — also lands here, topping up the tool-only current lane.
  //            Not addressed on purpose: it is byte-identical to the legitimate
  //            M173c/M15a/M15b collapse, so no signal at this seam separates them.
  //            The snapshot leaves that bubble alone rather than guessing — M212b.)
  //   K >= 2 → the tool-only-last (#173) shape: one final per text-bearing
  //            message, in generation order. The cursor walks the streamed lanes
  //            when the correlation is exact and the materialized ones otherwise
  //            (see below); the textless current (tool-only) lane receives none.
  //
  // WIDENING THE CANDIDATE LIST IS GATED ON THE CORRELATION BEING EXACT, and that
  // gate is load-bearing, not caution. `streamedAnswerLanes()` is the right list
  // when order-correlation holds: it keeps the lane whose send failed, so the
  // cursor stays in step (M173e). But widening also widens the set of lanes a
  // MIS-ROUTED final can land on, and a lane in that set is one `emitTurnSnapshot`
  // REPUBLISHES. Under a shortfall the landing is non-authoritative, so the
  // snapshot overwrites the bubble with `streamedAnswerText` — destroying the
  // final's text. Measured on the shape [msg1 streams "A"; msg2 text-bearing but
  // streams NOTHING; msg3 streams but every frame fails; msg4 tool-only]: the
  // ungated version routed msg2's final onto msg3's lane and the snapshot then
  // republished that bubble as msg3's streamed prefix, erasing msg2's only copy of
  // its answer. `materializedAnswerLanes()` kept msg2's final as its own bubble.
  //
  // The property that makes the gate free: when it is false EVERY landing is
  // non-authoritative, so every final routed onto a lane is discarded by the
  // snapshot regardless. Routing under a shortfall buys nothing and can only cost
  // content, whereas a narrower list pushes more finals into overflow bubbles the
  // client preserves. So on a shortfall we fall back to the pre-#238 list, and
  // behaviour is byte-identical to it.
  //
  // A final that runs PAST the end of the candidate list becomes its own
  // independent bubble: never a degrade, never a skip (plan §0.2 N10).
  const flushBufferedOrdinaryFinals = (): void => {
    if (bufferedOrdinaryFinals.length === 0) return;
    const finals = bufferedOrdinaryFinals.splice(0);
    const streamed = streamedAnswerLanes();
    // #238: order-correlation is EXACT when every final has a streamed lane to
    // pair with. A shortfall means core emitted a final for a text-bearing message
    // that has no streamed lane — it streamed zero partials, or core deduped two
    // byte-identical finals (`[core] dispatch-from-config.ts:3937-3941`) — and if
    // that message is not the LAST one, everything after it shifts by one.
    //
    // This is NOT a completeness claim, and the earlier comment here wrongly made
    // one. A COMPENSATING desync passes it: one streamed lane whose final core
    // deduped away, plus one unstreamed text message, leaves the counts equal while
    // the pairing is still shifted, and the mis-routed text then publishes
    // AUTHORITATIVE. That hole predates #238 (`pairingIsSound` had the same
    // cardinality basis) and is not closed here. What the predicate actually
    // certifies is narrower: the counts agree, so no final is left without a
    // partner and no partner without a final.
    const exactCorrelation = streamed.length === finals.length;
    // This SUBSUMES the previous revision's separate "did the cursor consume the
    // whole candidate list" test (`targets.length === finals.length`), and it is
    // strictly stronger rather than a rename:
    //   - When it is TRUE, `targets === streamed` and the lengths match, so the two
    //     agree. (Asserted across the whole suite during review: on the K>=2 branch
    //     they never diverged.)
    //   - When it is FALSE they can still disagree — `targets` falls back to
    //     `materializedAnswerLanes()`, whose length may coincidentally equal
    //     `finals.length` when there are MORE streamed lanes than finals (a deduped
    //     final). The old test would have certified that pairing; this one does not,
    //     and must not, because a deduped final is exactly a shift.
    //   - On the K==1 branch it reads `streamed.length === 1`, restoring the
    //     non-vacuous coverage the deleted `everyFinalHasStreamedLane` gave there.
    //     `targets.length === finals.length` was trivially true for a one-element
    //     hand-built list and certified nothing.
    const targets =
      finals.length === 1
        ? [currentLane()]
        : exactCorrelation
          ? streamed
          : materializedAnswerLanes();
    finals.forEach((text, index) => {
      const target = targets[index];
      if (!target) {
        // #238: this final ran past the end of the candidate list. No
        // `supersedesAnswerLane` is passed, and the reason is pure CARDINALITY, not
        // provenance: the flag's old value was `streamed.length === finals.length`,
        // and overflow requires `targets.length < finals.length` — which on this
        // branch means `exactCorrelation` is false, since a true one sets
        // `targets = streamed` with matching lengths. The two are mutually
        // exclusive, so the flag had no reachable true case.
        //
        // Do NOT restate this as "an overflow final's content never streamed".
        // MEASURED FALSE: with msg2 streaming nothing and msg3 streaming "C",
        // targets are [A,C], so tB lands on C and it is tC — msg3's OWN final, from
        // a message that did stream — that overflows. The bubble genuinely can
        // duplicate a lane in `answers`. Leaving it visible is the deliberate
        // trade: a duplicate is recoverable, a deletion is not (M212g).
        deliverTerminalIndependent(text);
        return;
      }
      target.deferredAngleMarkerTail = undefined;
      target.lastPartialSourceText = "";
      // `exactCorrelation` is the turn-level test above and it is COVERED: dropping
      // it turns M212g and M238d red.
      //
      // The per-target conjunct asks whether THIS lane streamed its own prefix. It
      // matters most on the K==1 branch, where `targets` is a hand-built
      // `[currentLane()]` rather than a filtered list, so nothing structurally
      // guarantees the lane streamed — on the buffered path it has not (that is the
      // buffering precondition in `finalize`), which is Case X / M173d, and a final
      // landing there may belong to an earlier message.
      //
      // BE PRECISE ABOUT ITS STATUS, because the previous revision was not.
      // MEASURED: dropping this conjunct alone leaves the whole suite green — both
      // before and after the shortfall fix. That is not a coverage gap, it is
      // structural: `answerTextIsAuthoritative` has exactly ONE reader
      // (`emitTurnSnapshot`, :1780) and that reader iterates `streamedAnswerLanes()`,
      // filtering on the very predicate this conjunct tests, so a lane that would
      // be wrongly marked is never read. DO NOT take that as licence to delete it —
      // the coupling is incidental, the flag's contract is what is being stated, and
      // the previous revision leaned on this same green result while the turn-level
      // gate was ALSO vacuous on K==1 (`targets.length === finals.length` is
      // trivially true for a one-element list), which left that branch stating a
      // guarantee nothing computed. `exactCorrelation` reads `streamed.length === 1`
      // there, so both conjuncts now say something.
      emitAuthoritativeFinalOnLane(target, text, {
        authoritative: exactCorrelation && target.streamedVisibleAnswerText,
      });
    });
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

          // Mirror core's observed partial hygiene exactly: strip reasoning +
          // inline-directive tags, drop a "Reasoning:\n"-prefixed partial, skip
          // an identical text, and ignore a SHRINKING cumulative text (a shorter
          // prefix of the current one) to avoid backwards flicker. The empirical
          // contract is pinned by `message-adapter.test.ts` M7c/M7i. Restored
          // from `develop` — the lane rewrite (34da088) dropped the first and
          // third of those while keeping the strip itself.
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
          // #212: capture the streamed text on a field a later authoritative final
          // never overwrites, so the `turn_snapshot` is immune to #215 mis-routing.
          lane.streamedAnswerText = cleaned;
          // #173: this lane has now streamed visible answer text. Set AFTER the
          // reasoning-filter early-return above, so a `Reasoning:\n...` partial
          // never counts. Persistent: settlement counts lanes with this flag to
          // recognise the [A,A,B] overwrite (see the field's own comment).
          lane.streamedVisibleAnswerText = true;
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
          //    message's first chunk is processed (observed internal ordering,
          //    verified at OpenClaw 2026.7.1-2), and this seam enqueues boundaries
          //    and partials onto one FIFO, so neither can overtake the other. The
          //    counter therefore never consumed a duplicate — it consumed the
          //    NEXT message's real boundary.
          //  - the failure modes inverted. Under lanes, swallowing a boundary
          //    does not merge two paragraphs: the next message's final lands on
          //    the previous message's lane and OVERWRITES it. Deleting the
          //    counter can at worst cause one spurious rotation, and an empty
          //    lane emits no bubble at all (§6.2-3, M6). A stray empty lane is
          //    not the same order of defect as deleted text.
          // #172: tick the boundary counter on EVERY callback — the swallowed
          // first one is a real `onAssistantMessageStart`, and core counts it —
          // then stamp the lane this boundary opens with the resulting 1-based
          // index. The first boundary opens the current (gen 0) lane = message A
          // = index 1; every later boundary rotates a new lane and stamps that.
          // This identity is separate from the barrier system (see the lane
          // field docblock); it only drives #172 block suppression.
          state.assistantMessageBoundaryCount += 1;
          const boundaryIndex = state.assistantMessageBoundaryCount;
          if (!state.firstBoundarySeen) {
            state.firstBoundarySeen = true;
            currentLane().assistantMessageIndex = boundaryIndex;
            return;
          }
          closeAndRotate();
          currentLane().assistantMessageIndex = boundaryIndex;
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

          // ONE attachment path for every reservation, indexed or not, keyed on
          // LANE STATE alone.
          //
          // There used to be a second path that picked the barrier lane by
          // comparing `input.assistantMessageIndex` to `lane.generation`. It is
          // deleted, and not because the comparison had the wrong base: there is
          // no sound ordinal→lane mapping to correct it to. The ordinal is a
          // source-stream counter core resets per subscription, and using it as
          // the key that decides WHICH lane a record belongs to is the
          // self-inflicted #215/#223 defect (plan §0.2 N5, §16.5 precision note
          // 1). Core's own Telegram extension draws the same line: it reads the
          // ordinal as a block-ROTATION hint and never as an identity key.
          //
          // Lane state answers the question the ordinal was being asked for, and
          // answers it soundly: the earliest lane that is still unresolved is the
          // one a block can still be owed to, and if none is, the block belongs
          // to the message being streamed right now.
          const unresolvedCandidates = state.lanes.filter(
            (lane) => lane.resolution === "unresolved",
          );
          if (unresolvedCandidates.length > 1) {
            warn(
              `ambiguous block reservation has ${unresolvedCandidates.length} ` +
                "unresolved predecessors; retaining the earliest ordering barrier",
            );
          }
          const barrierLane =
            state.lanes.find((lane) => lane.acceptsLateIndexlessReservations) ??
            unresolvedCandidates[0] ??
            currentLane();
          // Arming is about RETIRABILITY, not about which lane was chosen above —
          // the choice is already made, and the same way for both kinds.
          //
          // A settlement carries an `assistantMessageIndex`, and
          // `retireOneRecordAtIndex` uses it to retire the one pending record
          // that settled. An INDEXLESS reservation can never be matched that way,
          // so nothing short of terminal drain can prove it is done, and its lane
          // stays armed. An indexed one is individually retirable, so arming it
          // would only stall its lane's successor until drain (measured: the
          // whole M6b/M6h/M6u/I11/I18 family goes red, all as "B never streams").
          // This is lifecycle bookkeeping, the same category as
          // `outstandingRecordsAtIndex`; it is not an ordinal deciding a lane.
          //
          // ARMING HAS TWO EFFECTS, and the second one reaches further than the
          // flag's name suggests. It keeps this lane from pre-resolving to
          // `"empty"` when its barrier list empties — that is the local one. It
          // also makes the `find(acceptsLateIndexlessReservations)` lookup above
          // return this lane FIRST, and that lookup is now on the single unified
          // path, so the armed lane captures the next reservation of EITHER kind,
          // not just the next indexless one. Consequence worth stating plainly:
          // whether reservation N carried an ordinal transitively selects the
          // barrier lane for reservation N+1. That is still lane state deciding —
          // the flag is lane state — but it is the one place where an ordinal's
          // presence has a downstream effect on a lane choice, so a change to the
          // condition below is not local to this statement.
          if (input.assistantMessageIndex === undefined) {
            barrierLane.acceptsLateIndexlessReservations = true;
          }
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
          // #172: a block carries NO content the partials did not already stream
          // (core feeds the same visible text to `onPartialReply` and the block
          // chunker). So when this block's own lane has streamed that content and
          // will render it, delivering it again via `sendIndependent` duplicates
          // the bubble (2 messages → 4 bubbles). Suppress the wire frame in that
          // case — bookkeeping above (disposition + barriers) is untouched, so
          // the ordering/release gate is unaffected.
          //
          // The match uses the sound per-message stamp this controller wrote
          // itself (see the lane field and boundary-counter docblocks). It is a
          // RENDERING decision about a lane that already exists — "has this lane
          // already shown this text" — and deliberately not an attachment
          // decision: no ordinal picks the lane a record ATTACHES TO for ordering
          // anywhere in this controller (plan §0.2 N5). Read narrowly: this very
          // line maps an ordinal onto a lane, and is allowed precisely because it
          // decides rendering rather than order.
          //
          // PREDICATE = `streamedVisibleAnswerText && !laneTerminalSuppressed`,
          // i.e. the lane streamed visible answer text and is either MATERIALIZED
          // or merely THROTTLE-PENDING (streamed but its progress frame is still
          // held by the 600ms throttle), EXCLUDING only a lane whose send has
          // actually FAILED (`laneTerminalSuppressed`). Do NOT tighten this back
          // to `resolution === "materialized"`: blocks arrive MID-TURN during the
          // throttle window, so message ≥2's lane is still `open` (its leading
          // progress frame is throttled — only the FIRST lane emits leading-edge
          // when `lastProgressSentAt === 0`) when its block lands. Requiring
          // `materialized` there would fail to suppress and silently re-open #172
          // for every non-first message (the common tool-using / multi-message
          // case). A throttle-pending lane's text still reaches the wire via the
          // throttle timer or the drain settle, so suppressing its block loses
          // nothing.
          //
          // Every other shape falls through to independent delivery UNCHANGED:
          // an indexless block, a stamp with no matching lane, a lane the
          // fail-safe rotated (unstamped), or a lane whose frame FAILED to ship
          // (`laneTerminalSuppressed`) — the last preserves failed-lane recovery
          // (M13g). If that lane's deferred settle would also fail, the block's
          // own `sendIndependent` shares the transport and fails too, so no
          // recovery is forfeited by suppressing a merely-pending lane.
          //
          // Return `false` (the text-less/no-op contract, :~1975): no NEW visible
          // bubble left this seam. It does NOT make the turn answer-less — the
          // plugin's own `answerDelivered` is set for blocks independently at the
          // deliver seam (inbound.ts), and core's streamed-answer tracking keys
          // off the delivery call completing, not off this return.
          const targetLane = laneForAssistantMessageIndex(input.assistantMessageIndex);
          if (
            targetLane &&
            targetLane.streamedVisibleAnswerText &&
            !laneTerminalSuppressed(targetLane)
          ) {
            return false;
          }
          emitHeldLaneTextBeforeIndependentDelivery();
          // #212: reaching here with a streamed target lane means that lane's
          // frame FAILED (`laneTerminalSuppressed`) — this block is recovering its
          // content. That lane is in the snapshot's `answers` (by streamed text),
          // so this independent recovery bubble duplicates it and is named in
          // `remove`. An unstamped/tool-only-lane block carries UNIQUE content and
          // is preserved (flag stays unset).
          return sendIndependent(input.text, input.assistantMessageIndex, {
            supersedesAnswerLane: targetLane?.streamedVisibleAnswerText === true,
          });
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
            // payload to classify. Terminal drain clears whatever is left.
            //
            // PRICE THE COST HONESTLY, because it grew. A reservation surviving
            // here still keeps the turn-wide empty-predecessor release gate
            // closed, and it now ALSO hard-holds the lane it attached to: since
            // #238 every reservation attaches to a real lane, so the barrier
            // token sits on that lane's list, `laneOrderResolved` refuses it, and
            // `predecessorsResolved` blocks every successor. No timer clears
            // that — `releasableEmptyPredecessors` bails on the same pending
            // reservation — so the successor streams NOTHING and arrives only as
            // its terminal frame at drain.
            //
            // Measured: lane A streams "A text", A's block is queued at core's
            // real ordinal 1, this error fires, then B streams "B text". Before
            // #238 the wire carried B's progress frame pre-drain; now it does
            // not. That is the intended conservative direction — an ordering
            // barrier we cannot prove is discharged is held, not guessed away —
            // but it is a stalled lane, not merely a disarmed timer.
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
          // A leading terminal error still forces every later ordinary final onto
          // an independent bubble, whatever the lane topology.
          if (state.finalReconciliation.leadingTerminalErrorSeen) {
            return deliverTerminalIndependent(text);
          }
          // #173 — collapse-aware final routing. Core produces ordinary answer
          // finals in one of two shapes (verified against the pinned bundle,
          // payloads-1r4oLFNi.js:335/:424/:426):
          //   - COLLAPSE: the last assistant message has visible text, so core
          //     emits exactly ONE final = that last message's text. Earlier
          //     messages only ever reached the user via live streaming.
          //   - #173: the last assistant message is tool-only (no text), so the
          //     collapse cannot fire and core emits one final PER text-bearing
          //     message, IN ORDER. Tool-only messages still fire
          //     `onAssistantMessageStart`, so at finalize time `currentLane()` is
          //     the tool-only message's TEXTLESS lane — never a last answer lane.
          //
          // The routing target is unambiguous ONLY when the current lane bears
          // text (collapse → the current lane) or there is no text-bearing lane
          // at all (a lone message whose text arrived only in the final → the
          // current lane). When the current lane is TEXTLESS *and* text-bearing
          // lanes exist, the shape is undecidable at this instant: it is the
          // collapse-with-nonstreaming-last shape (K==1 → the final is the
          // current lane's own text) OR the tool-only-last #173 shape (K>=2 →
          // one final per text-bearing lane). Only the drain-time COUNT tells
          // them apart, so buffer and resolve in `flushBufferedOrdinaryFinals`.
          const textBearingLanes = materializedAnswerLanes();
          if (!active.streamedVisibleAnswerText && textBearingLanes.length > 0) {
            state.finalReconciliation.ordinaryAnswerSettled = true;
            bufferedOrdinaryFinals.push(text);
            // Provisional: the real send happens at drain (a synchronous status is
            // impossible here). Deliberately optimistic — inbound treats the final
            // as delivered, and it will be unless the turn is `stop`ped before
            // drain, in which case the streamed lane text still stands and a reload
            // heals. Never leaves a dangling promise.
            return true;
          }
          // Immediate path: the current lane is the sole, unambiguous target. The
          // first final settles it; a second ordinary final in this shape has no
          // lane left and falls back to an independent bubble (today's behaviour).
          if (state.finalReconciliation.ordinaryAnswerFinalsRoutedToLanes >= 1) {
            return deliverTerminalIndependent(text);
          }
          state.finalReconciliation.ordinaryAnswerFinalsRoutedToLanes += 1;
          state.finalReconciliation.ordinaryAnswerSettled = true;
          // Unlike partial callbacks, the ordinary final is durable and
          // authoritative. It is the only event allowed to replace an exact
          // quarantine with text that merely looks like a control marker. Reset
          // the tail BEFORE `terminalDrain`, whose resolver reads the current
          // lane, so it sees the cleared tail.
          active.deferredAngleMarkerTail = undefined;
          active.lastPartialSourceText = "";
          terminalDrain(false);
          // #212: the immediate path routes the final to its OWN lane — the
          // snapshot may show this authoritative text verbatim (final tail kept).
          return emitAuthoritativeFinalOnLane(active, text, { authoritative: true });
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
          // #173: a stop without a drain discards any buffered finals. This can
          // lose content, not just a re-send: an ordinary final may carry a tail
          // the last streamed partial never emitted (VERIFY-1 is still open), so a
          // dropped buffered final can lose a final-only tail the streamed lane
          // does NOT hold. Accepted by design — a reload heals it from durable
          // history — and what must not happen is a dangling promise, which
          // `finalize` already prevents by resolving each buffered final
          // provisionally.
          bufferedOrdinaryFinals.length = 0;
        },
        undefined,
      );
    },
  };
}

/**
 * One `onReasoningStream` payload, narrowed to the fields we consume. The pinned
 * OpenClaw callback delivers `{ text?; mediaUrls?; isReasoningSnapshot? }`
 * through `GetReplyOptions` (stable export:
 * `node_modules/openclaw/dist/plugin-sdk/reply-runtime.d.ts`). `mediaUrls` is
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
 * #242 half 1 — ONE DURABLE FRAME PER BURST. A frame carrying `final: true` is
 * what LETS the delivery journal record a burst, and the journal records
 * NOTHING else this controller sends. (Whether it records anything at all is the
 * account's `capabilities.reasoningDurable`, default OFF — gated at the
 * journaling seam, never here, so this controller's wire output is identical
 * either way.) The invariant is per BURST, not per call:
 *
 *   `endBurst`                    — closes the live burst: ONE frame, or ZERO
 *                                   when nothing of it was delivered.
 *   `stop()`                      — same, on the turn's way out.
 *   `pushDurableBlock`, branch A  — the CLI replay: closes the live burst (one
 *     (replay suppression)          or zero) and suppresses the block itself,
 *                                   because the block IS that burst.
 *   `pushDurableBlock`, branch B  — an independent block: closes the live burst
 *     (independent block)           (one or zero) AND emits the block, which is
 *                                   already complete and so carries the flag on
 *                                   its own single frame. Up to TWO frames —
 *                                   two BURSTS, not one burst twice.
 *
 * So "exactly one per close call" is false and "at most one per burst, and zero
 * only when the burst reached nobody" is the property. See `closeLiveBurst` for
 * the O(n²) argument the flag replaces and for the four-case table behind the
 * `lastDeliveredText` gate.
 *
 * VERIFIED INTERNAL BEHAVIOR (OpenClaw 2026.7.1-2): every emitter sends either
 * a snapshot or the cumulative FULL text so far — NEVER a bare delta:
 *  - the ACP runner emits the full accumulated text with `isReasoningSnapshot:
 *    true`;
 *  - the btw runner emits cumulative full text (`reasoningText += delta` then
 *    emits `reasoningText`, no snapshot flag).
 * So normalization is a plain REPLACE: ignore empty/non-string text, no-op an
 * exact duplicate of the current text, otherwise replace and send. No
 * snapshot/startsWith/endsWith/concat heuristic is needed.
 *
 * btw STALE-BURST DEFENSE: the btw `reasoningText` accumulator (declared
 * internally and verified at OpenClaw 2026.7.1-2) is NEVER reset at
 * `thinking_end`, even though that same event fires `onReasoningEnd`. So a
 * SECOND thinking burst in one attempt emits cumulative text that still carries
 * burst 1's full text as a raw prefix (btw concatenates raw deltas, whitespace
 * and all). Under our per-burst id
 * rotation that would render burst 1 duplicated inside burst 2's lane. We defend
 * with a `stalePrefix`: on `endBurst` we set it to the just-closed burst's LAST
 * RAW payload (that raw cumulative text already contains every prior burst — so
 * assign, don't append our trimmed display text, which loses inter-burst
 * whitespace and misfires from burst 3 on), and on `push` we strip that prefix
 * (plus any leading whitespace) from an incoming cumulative payload before the
 * replace logic runs. The ACP runner cannot hit this — its internal
 * `maybeEndReasoning` fires `onReasoningEnd` at most once per attempt (a
 * `reasoningEnded` guard), verified at OpenClaw 2026.7.1-2. The strip is
 * conservative: a payload that does NOT start with the accumulated prefix falls
 * through unchanged, so the worst case is the pre-fix duplicated display,
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
  //
  // ⚠️ THIS FLAG IS ABOUT THE *LAST* SEND, AND THAT IS THE ONLY QUESTION IT MAY
  // BE ASKED. It is deliberately NOT the gate on the burst's durable frame — see
  // `lastDeliveredText` below for the hole that produced and for what is left of
  // it (#304 tracks the remainder; the argument is here, not there).
  let liveSnapshotDelivered = false;
  // ⚠️ THE BURST TEXT THE CLIENT ACTUALLY HAS (#242 half 1, #304). Assigned ONLY
  // when `sendReasoning` returned true, so it lags `currentText` whenever a send
  // is refused, and cleared with `currentText` at close.
  //
  // It replaces an obvious-but-wrong gate — "did the LAST send land?" — which
  // discards a burst the user demonstrably watched: with `push "a"` delivered,
  // `push "ab"` refused, and then `endBurst()`, that gate emits ZERO durable
  // frames even though the peer is still rendering "a". Tracking the last
  // DELIVERED text answers the two questions that actually matter — did ANY of
  // this burst reach the client, and what text does it hold — with one variable.
  //
  // ⚠️ WHAT THIS FIXES IS NARROWER THAN AN EARLIER REVISION OF THIS COMMENT
  // CLAIMED, AND THE DIFFERENCE IS A REAL RESIDUAL HOLE. That revision named the
  // triggers as "a NATS reconnect, the fail-closed 'no session key yet' window"
  // and presented this variable as closing them. It does not: those same two
  // conditions refuse the CLOSE FRAME as well. `sendToPeer` returns `false` at
  // its disposed/transport-down check and at its missing-session-key check, and
  // BOTH sit ABOVE `journalOutbound` — deliberately, so a refused send is never
  // journaled. So the fix is conditional on RECOVERY:
  //
  //   transport recovered by close time → the close frame is published and
  //                                       journaled, carrying the delivered
  //                                       prefix. THIS is what changed.
  //   transport STILL refusing at close → the close frame is refused too, and
  //                                       the burst gets NO row at all, while
  //                                       the peer keeps rendering the text it
  //                                       already received. STILL OPEN.
  //
  // MEASURED against the real `NatsChannel` with `reasoningDurable: true`: push
  // "Let me" (published), push "Let me think" (published), transport down, push
  // "…about this" (refused), `endBurst()` → 2 publishes, 0 rows. `stop()` is
  // identical. The recovered control writes 1 row carrying "Let me".
  //
  // ⚠️ AND THE SEAM CANNOT FIX THE RESIDUAL — do not try here. Journaling a
  // refused send is ruled out at `sendToPeer`'s persist-before-publish block:
  // the caller re-mints an id per attempt, so recording refusals manufactures a
  // phantom row per revision under ids that never existed live (N8, gaining, at
  // an unbounded rate). A second journal hook inside this controller is NOT-list
  // N6b/N6c. The residual is #304 and needs a design round, not a patch.
  let lastDeliveredText = "";
  let stopped = false;

  const closeLiveBurst = (): void => {
    if (currentText.length === 0) return;
    // ── #242 half 1: THE BURST'S ONE DURABLE FRAME ──
    //
    // `push` sends a frame for every cumulative update that CHANGES the text —
    // an exact repeat is its only no-op, and there is no throttle or coalescing
    // — and each frame carries the full text so far, so journaling the live
    // stream would write one row per token,
    // each holding the whole burst — O(n²) bytes, multiplied into an already
    // quadratic history replay (#286). Instead the burst emits ONE extra frame
    // carrying `final: true`, and `journalEventForOutbound` records only frames
    // carrying it. Same distinction §15.9 already draws between the rolling
    // `progress` draft (indicator) and `agent_message` (durable content);
    // reasoning simply had no `progress` equivalent, so every one of its frames
    // looked durable.
    //
    // ⚠️ IT CARRIES `lastDeliveredText`, NOT `currentText`, AND IS GATED ON THE
    // SAME VARIABLE — "history records what was DELIVERED", N10 stated
    // positively. That NARROWS the loss; it does not end it. What remains is
    // deferred for one reason, and it is stated HERE rather than by pointer: the
    // seam cannot journal a refused send (N6b — see the declaration of
    // `lastDeliveredText` above for the full chain), and a second journal hook
    // inside this controller is N6b/N6c. **#304 tracks the remainder.**
    //
    // ⚠️ CITE #304 AS THE TRACKER, NEVER AS THE EXPLANATION. Its original filing
    // is about the gap this file has since CLOSED — its candidate fix reads
    // "track `anySnapshotDelivered` alongside `liveSnapshotDelivered` … captured
    // at send time rather than read off `currentText`", which is
    // `lastDeliveredText` as shipped right here. A reader sent to that body to
    // learn why the residual is deferred finds an argument for deferring
    // something already done, and the obvious next move is to close the issue —
    // taking the tracker away from a burst the peer watched and no row records.
    // The reasons live in this file; the issue exists to keep the remainder
    // visible.
    //
    // The cases, and the row count each actually produces:
    //
    //   ordinary   every push landed        → close frame carries the full text.
    //                                         ONE row.
    //   mixed,     early pushes landed, a   → close frame carries what the client
    //   RECOVERED  later one refused, the     ACTUALLY HAS. Published and
    //              transport is back up      journaled: ONE row, and it is an
    //              at close time             upsert-by-id no-op for the client.
    //                                        ⭐ THIS is the case this variable
    //                                        fixed; before it, ZERO rows.
    //   mixed,     the transport is STILL   → the close frame is REFUSED too
    //   STILL      refusing when the burst    (`sendToPeer` returns false above
    //   DOWN       closes                     `journalOutbound`), so NO row at
    //                                         all — while the peer keeps
    //                                         rendering the text it did receive.
    //                                         ⚠️ STILL OPEN. #304.
    //   all-refused                         → `lastDeliveredText` is empty, so no
    //                                         close frame is even attempted; a
    //                                         durable block, if one follows, is
    //                                         the only delivery and the only row.
    //   empty burst                         → the early return above. Nothing.
    //
    // A `pushDurableBlock` that follows any of these arrives under its OWN id as
    // a second block, so two blocks live is two rows — matching, not duplicated.
    //
    // Characterization tests pin every row above INCLUDING the still-open one;
    // they record the behaviour, they do not endorse it.
    //
    // The id is the live burst's own, so for the client the frame is an upsert
    // by id over text it already holds. The one real cost is one extra copy of
    // the burst's text on the wire per burst; accepted.
    //
    // The text is a DISPLAY text (post-strip), never `lastRawText` (btw's raw
    // cumulative payload, which still carries earlier bursts). History must
    // record what live displayed.
    if (lastDeliveredText.length > 0) {
      params.transport.sendReasoning(
        params.sessionKey,
        id,
        params.turnId,
        lastDeliveredText,
        true,
      );
    }
    // The NEXT live burst's raw payload carries this closed burst's LAST RAW text
    // as its prefix (btw's accumulator is cumulative and already holds all prior
    // bursts), so assign — don't append our trimmed display text, which would
    // drop any inter-burst whitespace and break the prefix match from burst 3 on.
    stalePrefix = lastRawText;
    id = nextMessageId();
    currentText = "";
    lastDeliveredText = "";
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
    // Only a send the transport ACCEPTED changes what the client holds, so this
    // lags `currentText` across a refusal instead of tracking it. That lag is
    // the whole mechanism — see `lastDeliveredText`'s declaration and
    // `closeLiveBurst`'s case table.
    if (liveSnapshotDelivered) lastDeliveredText = currentText;
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
      //
      // #242 half 1: `closeLiveBurst` emits the burst's ONE `final` frame here,
      // and this branch must NOT also send the durable block — that is what
      // "suppress the replay" means, and sending both would be two durable rows
      // for one burst. This branch requires `liveSnapshotDelivered`, and that
      // condition is only reachable when the last `push` was accepted, so
      // `lastDeliveredText === currentText` here: the final really is emitted on
      // this path, and it carries the burst's full text rather than a truncated
      // prefix.
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
      // #242 half 1: this block is ALREADY COMPLETE when it is sent — it is a
      // whole durable reasoning block, not a cumulative draft — so it carries
      // `final: true` on its single frame. There is deliberately no second
      // "closing" frame for it: that would be two durable rows for one block.
      params.transport.sendReasoning(params.sessionKey, id, params.turnId, text, true);
      id = nextMessageId();
    },
    endBurst: () => {
      if (stopped || currentText.length === 0) return;
      closeLiveBurst();
    },
    stop: () => {
      // #242 half 1: CLOSE AN OPEN BURST BEFORE LATCHING. `inbound.ts` calls
      // `reasoning?.stop()` on the turn's way out, so an aborted turn (/stop) or
      // a turn that ended without a reasoning-end boundary used to drop whatever
      // the user had already watched stream — live showed it, history would not,
      // which is the N8-losing hole this slice exists to close.
      //
      // ⚠️ IT CALLS `closeLiveBurst`, NOT `endBurst`, AND THAT IS WHY THE ORDER
      // READS AS IF IT MATTERS WHEN IT DOES NOT. `closeLiveBurst` never consults
      // `stopped`, so latching first would work identically; `endBurst` DOES
      // return early on `stopped`, so writing `endBurst(); stopped = true;` here
      // would be correct today and would silently become a no-op the moment
      // anyone reordered these two lines. The direct call has no such edge.
      //
      // Idempotent: `closeLiveBurst` early-returns on an empty burst, and it
      // clears `currentText`, so a second `stop()` — or a `stop()` after
      // `endBurst` — emits nothing.
      //
      // ⚠️ THIS FRAME IS JOURNALED AFTER THE TURN'S `seal`, AND THAT IS A KNOWN
      // ORDERING DIVERGENCE. `inbound.ts` awaits `draft?.drain()` — which emits
      // the `turn_snapshot` — and calls `reasoning?.stop()` afterwards, from its
      // `finally`. So a burst that streamed BEFORE the answer but never received
      // a reasoning-end boundary gets a later `seq` than the seal and replays at
      // the tail, past the turn's answers. Bursts closed by `endBurst` are
      // unaffected (they close mid-turn). Unobservable in half 1 because the
      // projection drops reasoning before the wire; half 2 inherits it as a
      // live≠history ORDERING divergence and owns the fix, which is the order of
      // those two calls in the turn teardown — NOT a change to make here.
      closeLiveBurst();
      stopped = true;
    },
  };
}
