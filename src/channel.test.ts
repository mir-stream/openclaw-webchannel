import { describe, it, expect, vi } from "vitest";

import { ClawChannelTransport } from "./transport.js";
import { createClawChannelPlugin } from "./channel.js";
import { handleInboundMessage } from "./inbound.js";

describe("clawchannel plugin", () => {
  it("resolves an account from config", () => {
    const transport = new ClawChannelTransport();
    const plugin = createClawChannelPlugin(transport);
    const cfg = {
      channels: { clawchannel: { allowFrom: ["user1"], dmSecurity: "allowlist" } },
    } as any;
    const account = plugin.config.resolveAccount(cfg, undefined);
    expect(account.allowFrom).toEqual(["user1"]);
    expect(account.dmPolicy).toBe("allowlist");
  });

  it("reports configured in Phase 0 (no auth required)", () => {
    const transport = new ClawChannelTransport();
    const plugin = createClawChannelPlugin(transport);
    const cfg = { channels: { clawchannel: {} } } as any;
    const result = plugin.config.inspectAccount!(cfg, undefined) as {
      configured: boolean;
    };
    expect(result.configured).toBe(true);
  });
});

describe("clawchannel transport", () => {
  it("returns false when no socket is mapped for a session", () => {
    const transport = new ClawChannelTransport();
    expect(transport.sendText("missing", "hello")).toBe(false);
  });
});

describe("clawchannel inbound round-trip", () => {
  // Minimal fake of the kernel: drive the supplied adapter exactly like
  // `runtime.channel.inbound.run` does (ingest -> resolveTurn -> record +
  // deliver) so we can assert the corrected dispatch path records a route and
  // delivers the reply through THIS channel's delivery adapter.
  function makeFakeApi(
    captured: { recordedSessionKey?: string; recordedTo?: string },
    opts?: {
      channelConfig?: Record<string, unknown>;
      // When set, the fake kernel fires these tool/progress callbacks (if the
      // turn supplied replyOptions) before delivering the final reply.
      fireToolProgress?: boolean;
      // When set, the fake kernel THROWS after firing tool progress (so a draft
      // working bubble is live) but BEFORE delivering the final reply, to
      // exercise the mid-draft error-recovery path.
      throwAfterProgress?: boolean;
    },
  ) {
    const resolveAgentRoute = vi.fn((input: any) => ({
      agentId: "main",
      channel: input.channel,
      accountId: "",
      // Emulate a channel-scoped key (resolveAgentRoute keeps channel + peer
      // rather than collapsing to agent:main:main like buildAgentSessionKey).
      sessionKey: `agent:main:${input.channel}:${input.peer.id}`,
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
    }));

    const recordInboundSession = vi.fn(async () => {});
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => ({}) as any);

    const channel = {
      routing: { resolveAgentRoute },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/store"),
        recordInboundSession,
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher },
      inbound: {
        buildContext: vi.fn((p: any) => ({ ...p, SessionKey: p.route.routeSessionKey })),
        run: vi.fn(async (params: any) => {
          const input = await params.adapter.ingest(params.raw);
          const turn = await params.adapter.resolveTurn(input, undefined, undefined);
          captured.recordedSessionKey = turn.routeSessionKey;
          captured.recordedTo = turn.ctxPayload.reply.to;
          // The kernel records the inbound session, then dispatches and the
          // agent reply is delivered through the turn's delivery adapter.
          await turn.recordInboundSession({
            storePath: turn.storePath,
            sessionKey: turn.routeSessionKey,
            ctx: turn.ctxPayload,
            onRecordError: () => {},
          });
          // In progress mode the turn supplies replyOptions whose tool callbacks
          // fire DURING the run; emulate one tool event so the draft starts.
          if (opts?.fireToolProgress && turn.replyOptions?.onToolStart) {
            await turn.replyOptions.onToolStart({ name: "web_search", phase: "start" });
          }
          // Simulate the turn blowing up mid-draft (after a progress frame, but
          // before the final reply is delivered).
          if (opts?.throwAfterProgress) {
            throw new Error("agent run failed mid-draft");
          }
          await turn.delivery.deliver({ text: "hi back" }, { kind: "final" });
        }),
      },
    };

    return {
      api: {
        config: { channels: { clawchannel: opts?.channelConfig ?? {} } },
        runtime: { channel },
        logger: {},
      } as any,
      resolveAgentRoute,
      recordInboundSession,
    };
  }

  it("resolves a channel-scoped route and delivers the reply to the peer socket", async () => {
    const transport = new ClawChannelTransport();
    const sendSpy = vi
      .spyOn(transport, "sendText")
      .mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api, resolveAgentRoute, recordInboundSession } = makeFakeApi(captured);

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    // Route was resolved for THIS channel + peer (not via buildAgentSessionKey).
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "clawchannel",
        peer: { kind: "direct", id: "web-anon" },
      }),
    );
    // An originating session/route was recorded carrying the channel-scoped key.
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(captured.recordedSessionKey).toBe("agent:main:clawchannel:web-anon");
    // The recorded reply `to` lines up with the socket-map key we deliver to.
    expect(captured.recordedTo).toBe("web-anon");
    // The reply was delivered back through THIS channel to the peer's socket.
    // No-progress config => plain no-id agent_message (legacy append path).
    expect(sendSpy).toHaveBeenCalledWith("web-anon", "hi back");
  });

  it("streams a progress draft then finalizes the SAME id when streaming.mode=progress", async () => {
    const transport = new ClawChannelTransport();
    // Simulate an open socket so the draft loop's sends "succeed" (returning
    // false would make createDraftStreamLoop retain pending text and not emit).
    const progressSpy = vi
      .spyOn(transport, "sendProgress")
      .mockReturnValue(true);
    const finalizeSpy = vi
      .spyOn(transport, "finalizeDraft")
      .mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "progress" } },
      fireToolProgress: true,
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    // A rolling progress draft was emitted during the run (one or more frames),
    // all carrying a single draft id. The text is a label line ("<Label>…",
    // drawn from the SDK's progress-draft label pool) plus the formatted tool
    // line for the web_search event.
    expect(progressSpy).toHaveBeenCalled();
    const progressCall = progressSpy.mock.calls[0];
    const [progSession, progId, progText] = progressCall;
    expect(progSession).toBe("web-anon");
    expect(typeof progId).toBe("string");
    // First line is the rolling "<Label>…" status line.
    expect(progText.split("\n")[0]).toMatch(/…$/);
    // The tool event was rendered as a draft line (icon + tool name).
    expect(progText).toMatch(/Web Search/i);

    // The final answer finalized the SAME draft id (widget transitions the
    // working bubble into the final text), NOT a fresh no-id agent_message.
    expect(finalizeSpy).toHaveBeenCalledWith("web-anon", progId, "hi back");

    // Every progress frame shares the one draft id.
    for (const call of progressSpy.mock.calls) {
      expect(call[1]).toBe(progId);
    }
  });

  it("recovers the working bubble when the turn throws mid-draft in progress mode", async () => {
    vi.useFakeTimers();
    try {
      const transport = new ClawChannelTransport();
      // Open socket simulated: progress/finalize sends "succeed" so the draft
      // actually starts (started=true) and the widget shows a working bubble.
      const progressSpy = vi
        .spyOn(transport, "sendProgress")
        .mockReturnValue(true);
      const finalizeSpy = vi
        .spyOn(transport, "finalizeDraft")
        .mockReturnValue(true);

      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "progress" } },
        fireToolProgress: true,
        throwAfterProgress: true,
      });

      // The handler swallows the dispatch error (logs it); it must NOT reject.
      await expect(
        handleInboundMessage(api, transport, "web-anon", {
          type: "user_message",
          text: "hello",
        }),
      ).resolves.toBeUndefined();

      // A working bubble was shown (at least one progress frame emitted)...
      expect(progressSpy).toHaveBeenCalled();
      const progId = progressSpy.mock.calls[0][1];

      // ...and on the error path the SAME draft id was finalized with a visible
      // (non-empty) settling message, so the widget transitions the bubble out
      // of its "working" state instead of hanging forever.
      expect(finalizeSpy).toHaveBeenCalledTimes(1);
      const [finSession, finId, finText] = finalizeSpy.mock.calls[0];
      expect(finSession).toBe("web-anon");
      expect(finId).toBe(progId);
      expect(typeof finText).toBe("string");
      expect((finText as string).length).toBeGreaterThan(0);

      // The draft loop was stopped: no late background throttled flush fires
      // after the error handling, so no further progress frames are emitted.
      const progressCountAfterError = progressSpy.mock.calls.length;
      await vi.runAllTimersAsync();
      expect(progressSpy.mock.calls.length).toBe(progressCountAfterError);
    } finally {
      vi.useRealTimers();
    }
  });
});
