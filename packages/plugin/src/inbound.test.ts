import { describe, it, expect } from "vitest";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

import { handleInboundMessage } from "./inbound.js";
import type { WebChannelPeerChannel } from "./channel-contract.js";

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

function makeFakeApi(params: {
  streamingMode: "off" | "partial" | "progress";
  runImpl: (turn: AssembledTurnLike) => Promise<void>;
}): {
  api: OpenClawPluginApi;
  captured: { buildContext?: BuildContextParams };
} {
  const captured: { buildContext?: BuildContextParams } = {};

  const config = {
    channels: { webchannel: { streaming: { mode: params.streamingMode } } },
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

  const api = {
    config,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtime: { channel },
  } as unknown as OpenClawPluginApi;

  return { api, captured };
}

/** A transport that records finalize frames and accepts progress/typing/text. */
function makeFakeTransport(): {
  transport: WebChannelPeerChannel;
  finalizes: Array<{ id: string; text: string }>;
  progress: Array<{ id: string; text: string }>;
  typing: string[];
  settles: Array<"ok" | "error">;
} {
  const finalizes: Array<{ id: string; text: string }> = [];
  const progress: Array<{ id: string; text: string }> = [];
  const typing: string[] = [];
  const settles: Array<"ok" | "error"> = [];
  const transport = {
    sendTyping: (sessionKey: string) => {
      typing.push(sessionKey);
      return true;
    },
    sendText: () => true,
    sendReasoning: () => true,
    sendTurnSettled: (_sessionKey: string, _turnId: string, outcome: "ok" | "error") => {
      settles.push(outcome);
      return true;
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
  return { transport, finalizes, progress, typing, settles };
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

  it("does not count a NON-final payload as the turn's answer", async () => {
    // The `kind === "final"` guard is load-bearing: block/tool payloads are
    // interim output, not the turn's answer. If they counted, a turn that
    // streamed a visible block and THEN failed terminally would settle `ok` —
    // #87 all over again for that shape.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "interim block output" }, { kind: "block" });
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
