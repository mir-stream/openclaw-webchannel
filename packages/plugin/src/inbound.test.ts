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
      payload: { text?: string },
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
} {
  const finalizes: Array<{ id: string; text: string }> = [];
  const progress: Array<{ id: string; text: string }> = [];
  const typing: string[] = [];
  const transport = {
    sendTyping: (sessionKey: string) => {
      typing.push(sessionKey);
      return true;
    },
    sendText: () => true,
    sendReasoning: () => true,
    sendTurnSettled: () => true,
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
  return { transport, finalizes, progress, typing };
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
