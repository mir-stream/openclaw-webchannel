import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #87: core marks a NON-terminal tool-error warning through WeakMap-backed
// payload metadata, which a test cannot attach (the setter is not part of the
// plugin SDK surface). Mock the reader so both branches are exercised: any
// payload whose text carries this sentinel reads as a non-terminal warning.
const WARNING_SENTINEL = "__NON_TERMINAL_TOOL_WARNING__";
vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  isReplyPayloadNonTerminalToolErrorWarning: (payload: { text?: string }) =>
    typeof payload?.text === "string" && payload.text.includes(WARNING_SENTINEL),
}));

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

import {
  handleInboundMessage,
  startAgentLifecycleSubscription,
  stopAgentLifecycleSubscription,
} from "./inbound.js";
import type { WebChannelPeerChannel } from "./channel-contract.js";
import {
  APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY,
  ApprovalOriginLeaseRegistry,
} from "./approval-origin.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";
import {
  MAX_COALESCED_MEMBER_ID_LENGTH,
  normalizeInboundUserMessage,
} from "./inbound-queue.js";
import { DEFAULT_BUSY_TURN_LIMITS } from "./inbound-retention.js";

/**
 * P1-8a — `handleInboundMessage` control-lane behaviour.
 *
 * Two invariants:
 *  - The abort authorization stamp (`access.commands.authorized`) is passed into
 *    core's `buildContext` ONLY for control-lane turns — never for ordinary
 *    turns (we must not broadly authorize text commands for every peer).
 *  - The aborted-turn defensive finalize: when core aborts the RUNNING turn its
 *    `inbound.run` resolves WITHOUT delivering a final, so a started progress
 *    draft would hang forever. We must finalize it in place with a "Stopped"
 *    marker — but a turn that DID deliver its final must finalize exactly once
 *    with the delivered text (idempotence, no "Stopped" suffix).
 *
 * The fake `api.runtime.channel` captures the `buildContext` params and lets each
 * test drive the assembled turn (invoke replyOptions callbacks / delivery) via a
 * per-test `runImpl`.
 */

type BuildContextParams = {
  access?: { commands?: { authorized?: boolean } };
  [k: string]: unknown;
};

type AssembledTurnLike = {
  replyOptions?: {
    onAgentRunStart?: (runId: string) => void;
    onToolStart?: (p: unknown) => void;
    onItemEvent?: (p: unknown) => void;
    onPartialReply?: (p: { text?: string }) => void;
    onAssistantMessageStart?: () => void;
  };
  delivery: {
    deliver: (
      payload: {
        text?: string;
        isError?: boolean;
        isStatusNotice?: boolean;
        isFallbackNotice?: boolean;
        isCompactionNotice?: boolean;
      },
      info?: { kind?: string },
    ) => Promise<{ visibleReplySent: boolean }>;
  };
};

type LifecycleEvent = { stream?: string; runId?: string; data?: Record<string, unknown> };
type LifecycleListener = (evt: LifecycleEvent) => void;

function makeFakeApi(params: {
  streamingMode: "off" | "partial" | "progress";
  runImpl: (turn: AssembledTurnLike) => Promise<void>;
  /** Expose the host's agent-events surface (#87 lifecycle verdict). */
  withAgentEvents?: boolean;
  /** Extra `channels.webchannel` keys, e.g. the DM allowlist (#99 denial case). */
  channelConfig?: Record<string, unknown>;
}): {
  api: OpenClawPluginApi;
  captured: { buildContext?: BuildContextParams };
  /** Push a lifecycle event to whatever the plugin subscribed. */
  emitLifecycle: (evt: LifecycleEvent) => void;
} {
  const captured: { buildContext?: BuildContextParams } = {};

  const config = {
    channels: {
      webchannel: { streaming: { mode: params.streamingMode }, ...params.channelConfig },
    },
  };

  const channel = {
    routing: {
      resolveAgentRoute: () => ({
        agentId: "agent1",
        channel: "webchannel",
        accountId: "default",
        mainSessionKey: "agent:agent1:main",
        sessionKey: "agent:agent1:seed",
        lastRoutePolicy: "session",
      }),
    },
    inbound: {
      buildContext: (p: BuildContextParams) => {
        captured.buildContext = p;
        return { ctx: p };
      },
      run: async (runParams: {
        raw: { text: string };
        adapter: {
          ingest: (raw: unknown) => unknown;
          resolveTurn: (input: unknown) => AssembledTurnLike;
        };
      }) => {
        const input = runParams.adapter.ingest(runParams.raw);
        const turn = runParams.adapter.resolveTurn(input);
        await params.runImpl(turn);
      },
    },
    session: {
      recordInboundSession: () => undefined,
      resolveStorePath: () => "store-path",
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: () => undefined,
    },
  };

  const listeners: LifecycleListener[] = [];
  const events = params.withAgentEvents
    ? {
        onAgentEvent: (l: LifecycleListener) => {
          listeners.push(l);
          return () => {};
        },
      }
    : undefined;

  const api = {
    config,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtime: { channel, ...(events ? { events } : {}) },
  } as unknown as OpenClawPluginApi;

  const emitLifecycle = (evt: LifecycleEvent): void => {
    for (const l of [...listeners]) l(evt);
  };

  return { api, captured, emitLifecycle };
}

/** A transport that records finalize frames and accepts progress/typing/text. */
function makeFakeTransport(options?: {
  /** #99: return false from `sendTurnSettled` for these turnIds (delivery failure). */
  failSettleFor?: readonly string[];
  /** #99: THROW from `sendTurnSettled` for these turnIds (hostile implementation). */
  throwSettleFor?: readonly string[];
}): {
  transport: WebChannelPeerChannel;
  finalizes: Array<{ id: string; text: string }>;
  progress: Array<{ id: string; text: string }>;
  typing: string[];
  settles: Array<"ok" | "error">;
  /** #99: the full settle frames, in emission order — turnId matters per member. */
  settleFrames: Array<{ turnId: string; outcome: "ok" | "error" }>;
} {
  const finalizes: Array<{ id: string; text: string }> = [];
  const progress: Array<{ id: string; text: string }> = [];
  const typing: string[] = [];
  const settles: Array<"ok" | "error"> = [];
  const settleFrames: Array<{ turnId: string; outcome: "ok" | "error" }> = [];
  const transport = {
    sendTyping: (sessionKey: string) => {
      typing.push(sessionKey);
      return true;
    },
    sendText: () => true,
    sendReasoning: () => true,
    sendTurnSettled: (_sessionKey: string, turnId: string, outcome: "ok" | "error") => {
      settles.push(outcome);
      settleFrames.push({ turnId, outcome });
      if (options?.throwSettleFor?.includes(turnId)) {
        throw new Error(`settle blew up for ${turnId}`);
      }
      return !options?.failSettleFor?.includes(turnId);
    },
    sendProgress: (_sessionKey: string, id: string, text: string) => {
      progress.push({ id, text });
      return true;
    },
    finalizeDraft: (_sessionKey: string, id: string, text: string) => {
      finalizes.push({ id, text });
      return true;
    },
    sendHistory: () => true,
    sendApprovalRequest: () => true,
    sendApprovalResolved: () => true,
    sendApprovalSnapshot: () => true,
  } as WebChannelPeerChannel;
  return { transport, finalizes, progress, typing, settles, settleFrames };
}

const userMessage = { type: "user_message" as const, text: "/stop" };

describe("handleInboundMessage — control-lane authorization stamp", () => {
  it("stamps access.commands.authorized=true ONLY for controlLane turns", async () => {
    const { api, captured } = makeFakeApi({
      streamingMode: "off",
      runImpl: async () => {},
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", userMessage, "default", {
      controlLane: true,
    });

    expect(captured.buildContext?.access?.commands?.authorized).toBe(true);
  });

  it("does NOT stamp authorization for ordinary (non-control-lane) turns", async () => {
    const { api, captured } = makeFakeApi({
      streamingMode: "off",
      runImpl: async () => {},
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "hello there",
    });

    // No `access` key at all — the ordinary path must not touch command authz.
    expect(captured.buildContext?.access).toBeUndefined();
  });
});

describe("handleInboundMessage — typing indicator gating", () => {
  it("sends a typing frame for an ordinary turn", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, typing } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "hello there",
    });

    // The ordinary path flashes "agent is typing…" keyed by the peer's wsKey.
    expect(typing).toEqual(["peer-1"]);
  });

  it("does NOT send a typing frame for a control-lane abort turn", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, typing } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", userMessage, "default", {
      controlLane: true,
    });

    // An abort must never flash typing: it winds the turn DOWN, and on the
    // unauthorized-sender path (core returns handled:false) no settling frame
    // ever follows, which would otherwise leave the widget's Stop button armed
    // with nothing to release it.
    expect(typing).toEqual([]);
  });
});

describe("handleInboundMessage — aborted-turn defensive finalize", () => {
  it("reports visibleReplySent=false when draft finalization returns false", async () => {
    let visible: boolean | undefined;
    const { api } = makeFakeApi({
      streamingMode: "partial",
      runImpl: async (turn) => {
        visible = (await turn.delivery.deliver({ text: "answer" }, { kind: "final" })).visibleReplySent;
      },
    });
    const { transport } = makeFakeTransport();
    transport.finalizeDraft = () => false;
    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message", text: "answer me", id: "turn-dv",
    });
    expect(visible).toBe(false);
  });
  it("settles a hung draft with the streamed snapshot (no marker) when the run resolves without delivering a final", async () => {
    const { api } = makeFakeApi({
      streamingMode: "partial",
      // Simulate an aborted turn: stream some answer text (starts the draft),
      // then resolve WITHOUT ever calling delivery.deliver(kind:"final").
      runImpl: async (turn) => {
        turn.replyOptions?.onPartialReply?.({ text: "Here is my answ" });
      },
    });
    const { transport, finalizes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "do a long thing",
    });

    // The bubble settles with EXACTLY the streamed content — no "Stopped"
    // marker (an abort gets its own "⚙️ Agent was aborted." from core; a silent
    // completion must not be mislabeled).
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0]!.text).toBe("Here is my answ");
    expect(finalizes[0]!.text).not.toContain("Stopped");
  });

  it("settles a hung TOOL-ONLY draft with the scaffold text (no marker) on a silent completion", async () => {
    const { api } = makeFakeApi({
      streamingMode: "progress",
      // A silent/tool-only turn: tool + item events start the draft, then the run
      // resolves without any deliver and without any answer text streamed.
      runImpl: async (turn) => {
        turn.replyOptions?.onToolStart?.({
          itemId: "i1",
          toolCallId: "t1",
          name: "bash",
          phase: "start",
          args: {},
        });
        turn.replyOptions?.onItemEvent?.({
          itemId: "i1",
          kind: "tool",
          name: "bash",
          phase: "start",
          status: "running",
        });
      },
    });
    const { transport, finalizes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "run a tool",
    });

    expect(finalizes).toHaveLength(1);
    // Settled with the rendered scaffold (contains the tool line), never marked.
    expect(finalizes[0]!.text).toContain("Bash");
    expect(finalizes[0]!.text).not.toContain("Stopped");
  });

  it("finalizes exactly once with the delivered text when the run DOES deliver a final (no marker)", async () => {
    const { api } = makeFakeApi({
      streamingMode: "partial",
      runImpl: async (turn) => {
        turn.replyOptions?.onPartialReply?.({ text: "Final answer" });
        await turn.delivery.deliver({ text: "Final answer complete" }, { kind: "final" });
      },
    });
    const { transport, finalizes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "answer me",
    });

    // The delivered final wins; the defensive finalize is an idempotent no-op.
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0]!.text).toBe("Final answer complete");
    expect(finalizes[0]!.text).not.toContain("Stopped");
  });
});

/**
 * #87 — a provider-rejected turn must settle `error`, not `ok`.
 *
 * Core does NOT throw when the provider rejects: it absorbs the failure and
 * returns its terminal message as an ordinary reply payload carrying
 * `isError: true`. The turn therefore resolves cleanly and — before this fix —
 * settled `ok`, so the widget rendered the user's bubble as `completed` (a ✓)
 * with no retry affordance, for a turn that produced no answer at all.
 *
 * Measured against a real gateway + real plugin + a provider stubbed to reject
 * (openclaw 2026.6.10): the terminal payload reaches this seam as
 * `kind:"final"`, `isError:true`, with no notice flags, ~3ms before the settle.
 *
 * The outcome keys off THE ANSWER, not off `isError` alone — core also flags a
 * NON-terminal tool-error warning, and only ever does so on a turn that DID
 * produce a user-facing reply. Keying off `isError` alone would flip those
 * successful turns to `failed`.
 */
describe("handleInboundMessage — #87 turn outcome", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };

  it("settles `error` when the only final payload is a terminal error", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver(
          { text: "⚠️ Something went wrong while processing your request.", isError: true },
          { kind: "final" },
        );
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("settles `ok` for an ordinary answered turn", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "here is your answer" }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("settles `ok` when a non-terminal tool warning trails a delivered answer", async () => {
    // The regression this fix must NOT introduce: core marks a tool-error
    // warning `isError` ONLY when the turn also produced a user-facing reply.
    // Keying the outcome off `isError` alone would report this success as a
    // failure and hand the user a retry for a turn that already answered.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "here is your answer" }, { kind: "final" });
        await turn.delivery.deliver(
          { text: "⚠️ a tool failed but the turn recovered", isError: true },
          { kind: "final" },
        );
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("settles `error` when only core's own notices accompany the terminal error", async () => {
    // Status/fallback/compaction notices are core chatter, never the answer —
    // they must not satisfy "this turn answered".
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver(
          { text: "↩️ switched model", isFallbackNotice: true },
          { kind: "final" },
        );
        await turn.delivery.deliver({ text: "🧹 Compacting context...", isCompactionNotice: true }, { kind: "final" });
        await turn.delivery.deliver({ text: "⚠️ Request failed.", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("does not count a TOOL payload as the turn's answer", async () => {
    // Tool payloads are tool chatter, never the turn's answer. If they counted,
    // a turn that emitted tool progress and THEN failed terminally would settle
    // `ok` — #87 all over again for that shape. (Block payloads DO count; see
    // the block-streaming case below.)
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "🛠️ read_file" }, { kind: "tool" });
        await turn.delivery.deliver({ text: "⚠️ Request failed.", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("settles `ok` for a silent completion (tool-only turn, no final payload)", async () => {
    // A turn that answers nothing but never errored is a legitimate clean
    // completion — it must not be reported as a failure.
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("still settles `error` when the turn throws (pre-existing path)", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async () => {
        throw new Error("dispatch blew up");
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("does not settle a control-lane turn at all", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ failed", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", { type: "user_message", text: "/stop" }, "default", {
      controlLane: true,
    });

    expect(settles).toEqual([]);
  });
});

/**
 * #99 — every accepted send must reach a terminal receipt state.
 *
 * P1-8b layer (b) merges N buffered user messages into ONE turn keyed by the
 * LAST id. Each of those messages was ACKed and holds its own P0-4 receipt, and
 * the client's `promoteAnchor` matches strictly on `turnId === wireId`, so a
 * single settle frame stranded the other N-1 receipts at `accepted` forever.
 * The turn now settles every member wireId with the same outcome.
 *
 * NOTE (test trap): `handleInboundMessage` swallows its own errors — a failed
 * `expect` inside a transport/dispatcher fake would be caught and logged, and
 * the test would pass vacuously. Every assertion below runs AFTER the awaited
 * turn, over recorded observations.
 */
describe("handleInboundMessage — #99 coalesced-group settlement", () => {
  /** What the coalescer hands down for the burst A, B, C (anchor = id-3). */
  const coalescedTurn = {
    type: "user_message" as const,
    text: "a\n\nb\n\nc",
    id: "id-3",
    coalescedIds: ["id-1", "id-2", "id-3"],
  };

  it("settles EVERY member wireId with the turn's outcome, each once, anchor last", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "here is your answer" }, { kind: "final" });
      },
    });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", coalescedTurn);

    // Order is load-bearing: the anchor is the id the drafts and `agent_message`
    // frames carry, so it is what ends the turn for the UI and must go last.
    expect(settleFrames).toEqual([
      { turnId: "id-1", outcome: "ok" },
      { turnId: "id-2", outcome: "ok" },
      { turnId: "id-3", outcome: "ok" },
    ]);
  });

  it("settles every member `error` when the turn fails (no member is left `ok`)", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver(
          { text: "⚠️ Something went wrong while processing your request.", isError: true },
          { kind: "final" },
        );
      },
    });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", coalescedTurn);

    // The group ran as one turn, so it fails as one: every receipt resolves to
    // `failed{turn-failed}`, none is left waiting.
    expect(settleFrames).toEqual([
      { turnId: "id-1", outcome: "error" },
      { turnId: "id-2", outcome: "error" },
      { turnId: "id-3", outcome: "error" },
    ]);
  });

  it("settles each member exactly once when the member list repeats the anchor", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "a\n\nb",
      id: "id-2",
      // The anchor appears mid-list AND a member repeats: a duplicate settle is
      // harmless on the client but is noise on the wire, and the anchor must
      // still be emitted last.
      coalescedIds: ["id-1", "id-2", "id-1"],
    });

    expect(settleFrames).toEqual([
      { turnId: "id-1", outcome: "ok" },
      { turnId: "id-2", outcome: "ok" },
    ]);
  });

  it("emits EXACTLY ONE settle for a non-coalesced turn (no member list)", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "hello there",
      id: "solo-1",
    });

    expect(settleFrames).toEqual([{ turnId: "solo-1", outcome: "ok" }]);
  });

  it("emits NO settle for an admission-denied coalesced turn", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async () => {},
      channelConfig: { dmSecurity: "allowlist", allowFrom: ["alice"] },
    });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "mallory", coalescedTurn);

    // `settlementEligible` gates the whole group, not just the anchor: no agent
    // turn was admitted, so nothing settles (ingress owns those receipts).
    expect(settleFrames).toEqual([]);
  });

  /**
   * The settle loop reads `coalescedIds` off the turn message, and that message
   * used to be reachable from the wire verbatim (the decode path casts instead
   * of validating). Layer (a) strips the field at ingress; these pin layer (b),
   * the read-site guard, so a path that ever forgets to strip degrades to "only
   * the anchor settles" instead of stranding the whole turn.
   *
   * The failure this prevents is severe and silent: the member loop runs BEFORE
   * the anchor is pushed, so a throw here emits ZERO settle frames, the
   * dispatcher swallows the rejection, and every receipt in the turn — anchor
   * included — is stuck at `accepted` with the draft never finalized.
   */
  describe("hostile `coalescedIds` still settles the anchor", () => {
    const hostile: Array<[string, unknown]> = [
      ["a number (not iterable — would throw)", 5],
      ["a string (would iterate as characters)", "abc"],
      ["null", null],
      ["an object", { length: 2 }],
      ["non-string members", [{}, 7]],
      ["empty-string members", ["", ""]],
    ];

    for (const [label, value] of hostile) {
      it(`settles exactly once for ${label}`, async () => {
        const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
        const { transport, settleFrames } = makeFakeTransport();

        await handleInboundMessage(api, transport, "peer-1", {
          type: "user_message",
          text: "hi",
          id: "anchor-1",
          coalescedIds: value as never,
        });

        expect(settleFrames).toEqual([{ turnId: "anchor-1", outcome: "ok" }]);
      });
    }

    it("drops an over-long member id and caps a flooded member list", async () => {
      const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
      const { transport, settleFrames } = makeFakeTransport();
      const overLong = "x".repeat(MAX_COALESCED_MEMBER_ID_LENGTH + 1);

      await handleInboundMessage(api, transport, "peer-1", {
        type: "user_message",
        text: "hi",
        id: "anchor-1",
        // A frame can hold far more ids than a real group ever has while
        // staying inside the payload/session byte budgets; each one costs a
        // seal+publish in the turn's `finally`.
        coalescedIds: [
          overLong,
          ...Array.from({ length: DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession * 50 }, (_, i) => `flood-${i}`),
        ],
      });

      // Capped at the bound the honest producer obeys, plus the anchor.
      expect(settleFrames).toHaveLength(DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession + 1);
      expect(settleFrames.map((f) => f.turnId)).not.toContain(overLong);
      expect(settleFrames.at(-1)).toEqual({ turnId: "anchor-1", outcome: "ok" });
    });

    it("a NORMALIZED wire frame settles only its own id — a peer cannot name others", async () => {
      // The end-to-end property of layer (a): what a peer actually sends is
      // `{…, coalescedIds:[victim ids]}`; ingress rebuilds the frame from its
      // known wire fields, and the turn then speaks only for the sender's own
      // wireId. Without the strip, this peer would make the agent settle two
      // receipts belonging to messages it never sent.
      const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
      const { transport, settleFrames } = makeFakeTransport();
      const wireFrame = {
        type: "user_message" as const,
        text: "hi",
        id: "mine-1",
        coalescedIds: ["victim-1", "victim-2"],
      };

      await handleInboundMessage(
        api,
        transport,
        "peer-1",
        normalizeInboundUserMessage(wireFrame),
      );

      expect(settleFrames).toEqual([{ turnId: "mine-1", outcome: "ok" }]);
    });
  });

  it("a THROWING member send cannot take the group — or the anchor — down", async () => {
    // `transport` is an interface; the shipped channel returns a boolean, but a
    // throwing implementation here would skip every id still queued. The anchor
    // is emitted LAST, so it is the one that would be lost — and the throw would
    // escape from a `finally` into the dispatcher's `.catch(() => {})`, leaving
    // the whole turn unsettled and the draft hanging.
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settleFrames } = makeFakeTransport({ throwSettleFor: ["id-1"] });
    const warn = vi.fn();
    (api as unknown as { logger: { warn: (m: string) => void } }).logger.warn = warn;

    await expect(
      handleInboundMessage(api, transport, "peer-1", coalescedTurn),
    ).resolves.toBeUndefined();

    expect(settleFrames.map((f) => f.turnId)).toEqual(["id-1", "id-2", "id-3"]);
    // Treated exactly like a `false` return: same warn shape, then keep going.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("turn_settled was not delivered");
    expect(warn.mock.calls[0]?.[0]).toContain("turn=id-1");
  });

  it("warns per undelivered member and still settles the rest", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settleFrames } = makeFakeTransport({ failSettleFor: ["id-2"] });
    const warn = vi.fn();
    (api as unknown as { logger: { warn: (m: string) => void } }).logger.warn = warn;

    await handleInboundMessage(api, transport, "peer-1", coalescedTurn);

    // A member whose frame does not ship must not abort the group — the anchor
    // and the other members still settle — and it warns in the same shape the
    // anchor always has.
    expect(settleFrames.map((f) => f.turnId)).toEqual(["id-1", "id-2", "id-3"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("turn_settled was not delivered");
    expect(warn.mock.calls[0]?.[0]).toContain("turn=id-2");
  });
});

/**
 * #87 follow-up — trust core's own terminal-vs-warning classification.
 *
 * `isError` marks BOTH a terminal failure and a merely non-terminal tool-error
 * warning. Inferring the difference from "did an answer arrive" is not enough:
 * a warning can ride a turn whose answer never reached this seam as a `final`,
 * and a terminal error can precede partial answer text. Core distinguishes the
 * two and exposes it through `isReplyPayloadNonTerminalToolErrorWarning`.
 */
describe("handleInboundMessage — #87 terminal vs non-terminal error", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };

  it("settles `ok` for a marked tool warning when NO answer reached this seam", async () => {
    // The marker is what carries this case: the turn answered on a lane this
    // seam never sees (a message-tool / source-reply delivery), so there is no
    // block or final answer payload to infer from. Without core's marker the
    // trailing warning reads as a terminal failure and the widget would offer a
    // retry for a possibly mutating turn that succeeded.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver(
          { text: `⚠️ read_file failed ${WARNING_SENTINEL}`, isError: true },
          { kind: "final" },
        );
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("settles `error` when a terminal error precedes partial answer text", async () => {
    // Core builds the payload array as [terminal error, …, answers…], so an
    // unmarked error BEFORE any answer is a real failure — the trailing text is
    // partial output, not a completed answer.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ The model errored.", isError: true }, { kind: "final" });
        await turn.delivery.deliver({ text: "here is half an answer" }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("settles `ok` for an unmarked error AFTER an answer (marker-unreadable fail-safe)", async () => {
    // Ordering fail-safe: if plugin and host ever resolve different copies of
    // the openclaw module the WeakMap marker silently reads false. An error
    // arriving after a delivered answer must still be treated as a warning,
    // so that break degrades to the old behavior instead of failing successes.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "here is your answer" }, { kind: "final" });
        await turn.delivery.deliver({ text: "⚠️ a tool failed (marker unreadable)", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });
});

/**
 * #87 follow-up 2 — block-streamed answers.
 *
 * Core can deliver the assistant's answer as `kind:"block"` payloads
 * (dispatch-*.js:1885 routes them through this same seam). At 2026.6.10 core
 * marks a non-terminal tool warning ONLY for middleware errors
 * (payloads-*.js:77), so an ordinary tool warning arrives `isError` with no
 * marker. If blocks did not count as answer output, that warning would be the
 * only `final` on an answered turn and would read as a terminal failure —
 * reporting a success as failed and offering a retry for a turn that may
 * already have mutated state.
 */
describe("handleInboundMessage — #87 block-streamed answers", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };

  it("settles `ok` when the answer streamed as blocks and an UNMARKED tool warning trails it", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "First half of the answer." }, { kind: "block" });
        await turn.delivery.deliver({ text: "Second half of the answer." }, { kind: "block" });
        // No marker: core only marks middleware tool errors.
        await turn.delivery.deliver({ text: "⚠️ write_file failed", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("still settles `error` when a terminal error precedes any block output", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ The model errored.", isError: true }, { kind: "final" });
        await turn.delivery.deliver({ text: "late block output" }, { kind: "block" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("does not let a block-level error settle the turn", async () => {
    // A block-level `isError` is interim streamed content, not a verdict.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ interim trouble", isError: true }, { kind: "block" });
        await turn.delivery.deliver({ text: "the answer arrived anyway" }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });
});

/**
 * #87 follow-up 3 — core's lifecycle verdict is authoritative.
 *
 * The payload heuristics cannot separate "answered, then a failed mutating
 * tool" (a success) from "answered, then timed out" (a failure): both arrive as
 * an answer followed by an unmarked `isError` final. Core knows which it was
 * and publishes it as the run's lifecycle terminal, so when a verdict exists it
 * decides the outcome and the heuristics are not consulted.
 */
describe("handleInboundMessage — #87 lifecycle verdict", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };
  const RUN = "run-abc";

  /** Drives a turn that starts run `RUN`, runs `body`, then emits `phase`. */
  function turnWithVerdict(
    phase: "end" | "error" | undefined,
    body: (turn: AssembledTurnLike) => Promise<void>,
  ) {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        await body(turn);
        if (phase) {
          holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase } });
        }
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    return made;
  }

  it("settles `error` on a lifecycle error even though an answer was delivered", async () => {
    // The timeout shape: core appends its terminal error after retained answer
    // payloads. The heuristic alone reads this as a success.
    const { api } = turnWithVerdict("error", async (turn) => {
      await turn.delivery.deliver({ text: "partial answer text" }, { kind: "final" });
      await turn.delivery.deliver({ text: "⚠️ timed out", isError: true }, { kind: "final" });
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("settles `ok` on a lifecycle end even though an unmarked isError final arrived", async () => {
    // The failed-mutating-tool shape: the turn answered and core warned about a
    // failed write. Reading that warning as terminal would fail a successful
    // turn and offer a retry that could repeat the write.
    const { api } = turnWithVerdict("end", async (turn) => {
      await turn.delivery.deliver({ text: "done — I updated the file" }, { kind: "final" });
      await turn.delivery.deliver({ text: "⚠️ write_file failed", isError: true }, { kind: "final" });
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("settles `ok` on a lifecycle end for a turn with no answer at all", async () => {
    const { api } = turnWithVerdict("end", async (turn) => {
      await turn.delivery.deliver({ text: "⚠️ something failed", isError: true }, { kind: "final" });
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("takes the LAST terminal for a run (model fallback emits several attempts)", async () => {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase: "error" } });
        // A later attempt on the same run succeeds.
        holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase: "end" } });
        await turn.delivery.deliver({ text: "the answer" }, { kind: "final" });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("ignores a terminal belonging to a DIFFERENT run", async () => {
    // The event stream is process-global; concurrent turns must not read each
    // other's verdicts.
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        holder.emit?.({ stream: "lifecycle", runId: "some-other-run", data: { phase: "error" } });
        await turn.delivery.deliver({ text: "the answer" }, { kind: "final" });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("ignores non-lifecycle streams and non-terminal phases", async () => {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        // A terminal-looking phase on a NON-lifecycle stream must be ignored;
        // if it leaked through it would read as a success and mask the failure.
        holder.emit?.({ stream: "assistant", runId: RUN, data: { phase: "end" } });
        // `finishing` is not terminal — it carries an error even on attempts
        // that later succeed.
        holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase: "finishing", error: "x" } });
        await turn.delivery.deliver({ text: "⚠️ failed", isError: true }, { kind: "final" });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    // No terminal ⇒ the payload fallback decides, and it reads this as a failure.
    expect(settles).toEqual(["error"]);
  });

  it("falls back to the payload reading when the host exposes no events surface", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ Request failed.", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });
});

/**
 * #89 boundary — a user abort must not be reported as a turn failure.
 *
 * Core stamps `aborted` on the run's lifecycle terminal, and depending on how
 * the abort surfaces the phase can be `end` or `error`. Measured live for a
 * /stop during a provider call at 2026.6.10: `phase:"end"` with
 * `aborted:true, stopReason:"aborted"`. The `error` form must not be read as a
 * failure either — that would settle a deliberately cancelled turn as
 * `failed{reason:"turn-failed", retryable:true}` and offer to re-run work the
 * user just stopped. `cancelled` is the correct outcome; it needs a wire value
 * that does not exist yet (#89), so an aborted run keeps the pre-existing `ok`.
 */
describe("handleInboundMessage — #89 aborted runs are not failures", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };
  const RUN = "run-aborted";

  function abortedTurn(phase: "end" | "error") {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        holder.emit?.({
          stream: "lifecycle",
          runId: RUN,
          data: { phase, aborted: true, stopReason: "aborted" },
        });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    return made;
  }

  it.each(["end", "error"] as const)(
    "settles `ok` for an aborted run (phase=%s), never a retryable failure",
    async (phase) => {
      const { api } = abortedTurn(phase);
      const { transport, settles } = makeFakeTransport();

      await handleInboundMessage(api, transport, "peer-1", ordinary);

      expect(settles).toEqual(["ok"]);
    },
  );

  it("still settles `error` for a NON-aborted lifecycle error", async () => {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase: "error", aborted: false } });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });
});

/**
 * #87 — the lifecycle subscription's lifetime.
 *
 * `onAgentEvent` registers on a PROCESS-GLOBAL listener set, while a plugin
 * reload hands out a fresh `runtime.events` facade. Subscribing per facade
 * would stack one listener per reload for the life of the process, so the
 * subscription keeps its unsubscribe handle: re-starting replaces, and teardown
 * releases.
 */
describe("agent lifecycle subscription lifetime", () => {
  function makeEventsHost() {
    const listeners: LifecycleListener[] = [];
    let unsubscribes = 0;
    const api = {
      runtime: {
        events: {
          onAgentEvent: (l: LifecycleListener) => {
            listeners.push(l);
            return () => {
              unsubscribes += 1;
              const i = listeners.indexOf(l);
              if (i >= 0) listeners.splice(i, 1);
            };
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    return { api, listeners, count: () => listeners.length, unsubscribes: () => unsubscribes };
  }

  it("replaces rather than stacks when re-started (a reload)", () => {
    const host = makeEventsHost();
    startAgentLifecycleSubscription(host.api);
    startAgentLifecycleSubscription(host.api);
    startAgentLifecycleSubscription(host.api);

    expect(host.count()).toBe(1);
    expect(host.unsubscribes()).toBe(2);
    stopAgentLifecycleSubscription();
    expect(host.count()).toBe(0);
  });

  it("replaces across a FRESH events facade, which a reload hands out", () => {
    // The previous guard keyed on facade identity, so a new facade defeated it.
    const first = makeEventsHost();
    startAgentLifecycleSubscription(first.api);
    const second = makeEventsHost();
    startAgentLifecycleSubscription(second.api);

    expect(first.count()).toBe(0);
    expect(second.count()).toBe(1);
    stopAgentLifecycleSubscription();
    expect(second.count()).toBe(0);
  });

  it("is a no-op on a host with no events surface", () => {
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    expect(() => startAgentLifecycleSubscription(api)).not.toThrow();
    expect(() => stopAgentLifecycleSubscription()).not.toThrow();
  });
});

/**
 * #93 — the approval-origin lease window (plan §4.3 / §6.2).
 *
 * The lease must exist for EXACTLY the window in which the agent run can emit a
 * tool approval: from `onAgentRunStart` to the outer `finally`. Both boundaries
 * are safety boundaries, in opposite directions — claiming before the run starts
 * lets a denied or failed-setup turn absorb someone else's approval, and failing
 * to release on any exit path leaves a claim that poisons the tuple for every
 * later origin on the same key.
 *
 * The production registry runs on `Date.now` and compares request times
 * STRICTLY, so these tests plant their own registry with an injected clock in
 * the versioned global slot. The getter validates structurally, which is what
 * makes that possible — and `handleInboundMessage` re-reads the slot per turn,
 * which is what makes it take effect.
 */
describe("handleInboundMessage — approval-origin lease", () => {
  const slots = globalThis as unknown as Record<symbol, unknown>;
  const ordinary = { type: "user_message" as const, text: "please write the file" };

  let saved: unknown;
  let nowMs: number;
  let registry: ApprovalOriginLeaseRegistry;

  beforeEach(() => {
    saved = slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    nowMs = 1_000;
    registry = new ApprovalOriginLeaseRegistry({ now: () => nowMs });
    slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = registry;
  });

  afterEach(() => {
    if (saved === undefined) delete slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    else slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = saved;
  });

  /**
   * Ask the registry exactly what the approval resolver will ask it, deriving
   * the session key through the SAME helper the inbound path uses so the key is
   * byte-identical rather than hand-copied.
   */
  function resolveOrigin(
    api: OpenClawPluginApi,
    requestCreatedAtMs: number,
    peerId = "peer-1",
    accountId = "default",
  ): ReturnType<ApprovalOriginLeaseRegistry["resolve"]> {
    return registry.resolve({
      rawAccountId: accountId,
      sessionKey: resolveWebchannelSessionRoute(api, accountId, peerId).sessionKey,
      requestCreatedAtMs,
    });
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("claims nothing until onAgentRunStart, then resolves the exact peer", async () => {
    // NOTE: observations are recorded and asserted AFTER the turn.
    // `handleInboundMessage` catches everything the dispatcher throws, so an
    // `expect` inside `runImpl` would be swallowed and the test would pass
    // whatever happened.
    let beforeStart: unknown;
    let afterStart: unknown;
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        // Dispatched, route resolved, handle created — but the run has not
        // started, so a request arriving now belongs to nobody.
        nowMs = 1_030;
        beforeStart = resolveOrigin(made.api, 1_020);

        nowMs = 1_040;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        nowMs = 1_060;
        afterStart = resolveOrigin(made.api, 1_050);
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(beforeStart).toEqual({ kind: "no_match" });
    expect(afterStart).toEqual({ kind: "resolved", peerId: "peer-1" });
  });

  it("is observable to an approval lookup while the run is paused mid-turn", async () => {
    // The shape the real bug takes: the approval arrives from OUTSIDE this
    // turn's call stack while the run is still awaiting a tool decision.
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        started.resolve();
        await finish.promise;
      },
    });
    const { transport } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;

    nowMs = 1_060;
    expect(resolveOrigin(made.api, 1_050)).toEqual({
      kind: "resolved",
      peerId: "peer-1",
    });

    finish.resolve();
    await turnPromise;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("releases on a normal completion", async () => {
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        await turn.delivery.deliver({ text: "done" }, { kind: "final" });
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);
    nowMs = 1_060;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("releases when the turn throws", async () => {
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        throw new Error("provider exploded");
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);
    nowMs = 1_060;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("releases on an abort (run resolves with no final delivered)", async () => {
    const made = makeFakeApi({
      streamingMode: "partial",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        turn.replyOptions?.onPartialReply?.({ text: "half an ans" });
        // Core aborted the run: it resolves without ever delivering a final.
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);
    nowMs = 1_060;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("claims once when onAgentRunStart repeats (model fallback)", async () => {
    let duringRun: unknown;
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        // A second start must neither add a claim nor re-capture the time: a
        // re-captured 1_100 would make the 1_050 request ineligible.
        nowMs = 1_100;
        turn.replyOptions?.onAgentRunStart?.("run-2");
        nowMs = 1_120;
        duringRun = resolveOrigin(made.api, 1_050);
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(duringRun).toEqual({ kind: "resolved", peerId: "peer-1" });
    // One release ends the turn's ownership. A duplicated claim would have
    // survived it, because release removes exactly one claim by id.
    nowMs = 1_140;
    expect(resolveOrigin(made.api, 1_130)).toEqual({ kind: "no_match" });
  });

  it("claims on the control lane but is never selectable there", async () => {
    // A `/stop` whose fast-abort finds nothing to consume falls through to an
    // ordinary agent turn that can call tools and request approvals. It is
    // exempt from being ANSWERED with, not from being recorded — see the
    // cross-peer test below for what being unrecorded would cost.
    let callbackType: string | undefined;
    let duringRun: unknown;
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        // Record that the callback really is wired for this turn — otherwise
        // the assertion below would pass for the wrong reason.
        callbackType = typeof turn.replyOptions?.onAgentRunStart;
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        nowMs = 1_060;
        duringRun = resolveOrigin(made.api, 1_050);
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", userMessage, "default", {
      controlLane: true,
    });

    expect(callbackType).toBe("function");
    expect(duringRun).toEqual({ kind: "no_match" });
    nowMs = 1_080;
    expect(resolveOrigin(made.api, 1_070)).toEqual({ kind: "no_match" });
  });

  it("a control-lane run over another peer's claim yields ambiguous, not that peer", async () => {
    // Two peers collapsed onto ONE session key by `session.identityLinks` — the
    // collision that makes a stored `lastTo` insufficient on its own.
    //
    // peer-2 holds an ordinary claim. peer-1's control-lane message falls
    // through to a real agent run and requests an approval. If that run were
    // unrecorded, the registry would find exactly one eligible claim — peer-2's
    // — and peer-1's permission prompt would land in peer-2's browser.
    const identityLinks = { "shared-user": ["peer-1", "peer-2"] };
    const started = deferred();
    const finish = deferred();
    const ordinaryRun = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-peer-2");
        started.resolve();
        await finish.promise;
      },
    });
    (ordinaryRun.api.config as { session?: unknown }).session = { identityLinks };
    const { transport: transport2 } = makeFakeTransport();
    const ordinaryTurn = handleInboundMessage(
      ordinaryRun.api,
      transport2,
      "peer-2",
      ordinary,
    );
    await started.promise;

    // Both peers now share one session key, so this is the same canonical tuple.
    const linkedKey = resolveWebchannelSessionRoute(ordinaryRun.api, "default", "peer-2")
      .sessionKey;
    expect(
      resolveWebchannelSessionRoute(ordinaryRun.api, "default", "peer-1").sessionKey,
    ).toBe(linkedKey);

    let duringControlRun: unknown;
    const controlRun = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        // The fast-abort found nothing; this is a real agent run now.
        nowMs = 1_020;
        turn.replyOptions?.onAgentRunStart?.("run-peer-1");
        nowMs = 1_040;
        // peer-1's own request must NOT be answered with peer-2.
        duringControlRun = registry.resolve({
          rawAccountId: "default",
          sessionKey: linkedKey,
          requestCreatedAtMs: 1_030,
        });
      },
    });
    (controlRun.api.config as { session?: unknown }).session = { identityLinks };
    const { transport: transport1 } = makeFakeTransport();
    await handleInboundMessage(controlRun.api, transport1, "peer-1", userMessage, "default", {
      controlLane: true,
    });

    expect(duringControlRun).toEqual({ kind: "ambiguous" });

    finish.resolve();
    await ordinaryTurn;
  });

  it("rotates the epoch on teardown, refusing requests stamped before it", async () => {
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        started.resolve();
        await finish.promise;
      },
    });
    const { transport } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;
    nowMs = 1_030;
    expect(resolveOrigin(made.api, 1_020)).toEqual({
      kind: "resolved",
      peerId: "peer-1",
    });

    stopAgentLifecycleSubscription(); // draws a new barrier at 1_030
    // The same request the registry answered a moment ago is now unattributable:
    // it predates the barrier, so a gateway replay of it cannot be delivered.
    expect(resolveOrigin(made.api, 1_020)).toEqual({ kind: "invalid_request_time" });

    finish.resolve();
    await turnPromise;
  });

  it("never resolves a handle left dormant across the rotation", async () => {
    let afterLateStart: unknown;
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        // The handle exists (the route resolved) but the run has NOT started.
        started.resolve();
        await finish.promise;
        nowMs = 1_040;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        nowMs = 1_060;
        afterLateStart = resolveOrigin(made.api, 1_050);
      },
    });
    const { transport } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;
    nowMs = 1_030;
    stopAgentLifecycleSubscription(); // barrier 1_030, epoch rotated

    finish.resolve();
    await turnPromise;

    expect(afterLateStart).toEqual({ kind: "no_match" });
    nowMs = 1_080;
    expect(resolveOrigin(made.api, 1_070)).toEqual({ kind: "no_match" });
  });

  it("keeps a run active across the rotation, post-barrier only, released by its own finally", async () => {
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        started.resolve();
        await finish.promise;
      },
    });
    const { transport } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;
    nowMs = 1_030;
    stopAgentLifecycleSubscription(); // barrier 1_030; the claim is NOT cleared

    nowMs = 1_060;
    // A replayed pre-barrier request stays refused …
    expect(resolveOrigin(made.api, 1_020)).toEqual({ kind: "invalid_request_time" });
    // … but a request this still-running run genuinely creates afterwards is
    // deliverable to its exact peer.
    expect(resolveOrigin(made.api, 1_050)).toEqual({
      kind: "resolved",
      peerId: "peer-1",
    });

    finish.resolve();
    await turnPromise;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("lets a handler that was in flight at teardown settle and release itself", async () => {
    // The dispatcher fake holds the handler in flight across the rotation,
    // which is what the queue really does — dispose settles running handlers
    // rather than aborting them.
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        started.resolve();
        await finish.promise;
        await turn.delivery.deliver({ text: "finished after teardown" }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;
    nowMs = 1_030;
    stopAgentLifecycleSubscription();

    finish.resolve();
    await turnPromise;

    // The handler ran to completion after the rotation …
    expect(settles).toEqual(["ok"]);
    // … and its own `finally` released its own claim.
    nowMs = 1_080;
    expect(resolveOrigin(made.api, 1_070)).toEqual({ kind: "no_match" });
  });
});
