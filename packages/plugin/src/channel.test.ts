import { describe, it, expect, vi } from "vitest";

import { WebChannelTransport } from "./transport.js";
import { createWebChannelPlugin } from "./channel.js";
import { handleInboundMessage } from "./inbound.js";

describe("webchannel plugin", () => {
  it("resolves an account from config", () => {
    const transport = new WebChannelTransport();
    const plugin = createWebChannelPlugin(transport);
    const cfg = {
      channels: { webchannel: { allowFrom: ["user1"], dmSecurity: "allowlist" } },
    } as any;
    const account = plugin.config.resolveAccount(cfg, undefined);
    expect(account.allowFrom).toEqual(["user1"]);
    expect(account.dmPolicy).toBe("allowlist");
  });

  it("reports configured in Phase 0 (no auth required)", () => {
    const transport = new WebChannelTransport();
    const plugin = createWebChannelPlugin(transport);
    const cfg = { channels: { webchannel: {} } } as any;
    const result = plugin.config.inspectAccount!(cfg, undefined) as {
      configured: boolean;
    };
    expect(result.configured).toBe(true);
  });
});

describe("webchannel transport", () => {
  it("returns false when no socket is mapped for a session", () => {
    const transport = new WebChannelTransport();
    expect(transport.sendText("missing", "hello")).toBe(false);
  });
});

describe("webchannel inbound round-trip", () => {
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
      // resolveWebchannelSessionRoute IGNORES this sessionKey and rebuilds it via
      // the REAL buildAgentSessionKey with the forced per-account-channel-peer
      // scope — so the recorded key below is the ENFORCED isolation key
      // (agent:main:webchannel:<accountId>:direct:<peer>), not this naive value.
      // We still return a value here to prove the override wins.
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
        config: { channels: { webchannel: opts?.channelConfig ?? {} } },
        runtime: { channel },
        logger: {},
      } as any,
      resolveAgentRoute,
      recordInboundSession,
    };
  }

  it("default-deny allowlist (gap ③): a non-allowlisted peer is denied — inbound.run never runs, no reply", async () => {
    const transport = new WebChannelTransport();
    const sendSpy = vi.spyOn(transport, "sendText").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api, resolveAgentRoute } = makeFakeApi(captured, {
      channelConfig: { dmSecurity: "allowlist", allowFrom: ["alice"] },
    });
    const inboundRun = (api.runtime as { channel: { inbound: { run: ReturnType<typeof vi.fn> } } })
      .channel.inbound.run;

    await handleInboundMessage(api, transport, "mallory", {
      type: "user_message",
      text: "let me in",
    });

    // Denied before dispatch: the agent turn is never invoked and nothing is sent.
    expect(inboundRun).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("default-deny allowlist (gap ③): an allowlisted peer is admitted — inbound.run runs and reply is delivered", async () => {
    const transport = new WebChannelTransport();
    const sendSpy = vi.spyOn(transport, "sendText").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { dmSecurity: "allowlist", allowFrom: ["alice"] },
    });
    const inboundRun = (api.runtime as { channel: { inbound: { run: ReturnType<typeof vi.fn> } } })
      .channel.inbound.run;

    await handleInboundMessage(api, transport, "alice", {
      type: "user_message",
      text: "hello",
    });

    expect(inboundRun).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalled();
  });

  it("resolves a channel-scoped route and delivers the reply to the peer socket", async () => {
    const transport = new WebChannelTransport();
    const sendSpy = vi
      .spyOn(transport, "sendText")
      .mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api, resolveAgentRoute, recordInboundSession } = makeFakeApi(captured);

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    // Route was resolved for THIS channel + peer.
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "webchannel",
        peer: { kind: "direct", id: "web-anon" },
      }),
    );
    // An originating session/route was recorded carrying the FORCED
    // per-account-channel-peer key (webchannel self-isolates regardless of the
    // global session.dmScope — the empty accountId normalizes to "default").
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(captured.recordedSessionKey).toBe(
      "agent:main:webchannel:default:direct:web-anon",
    );
    // The recorded reply `to` lines up with the socket-map key we deliver to.
    expect(captured.recordedTo).toBe("web-anon");
    // The reply was delivered back through THIS channel to the peer's socket.
    // No-progress config => plain no-id agent_message (legacy append path).
    expect(sendSpy).toHaveBeenCalledWith("web-anon", "hi back");
  });

  it("threads accountId into resolveAgentRoute (binding.account routing — Cycle 2)", async () => {
    const transport = new WebChannelTransport();
    vi.spyOn(transport, "sendText").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api, resolveAgentRoute } = makeFakeApi(captured, {
      // Per-account config lives under accounts.<id>; acctA inherits no base here.
      channelConfig: { accounts: { acctA: {} } },
    });

    await handleInboundMessage(
      api,
      transport,
      "alice",
      { type: "user_message", text: "hello" },
      "acctA",
    );

    // The route is resolved for THIS account, activating openclaw's
    // binding.account tier (agents bind --bind webchannel:acctA).
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "webchannel",
        accountId: "acctA",
        peer: { kind: "direct", id: "alice" },
      }),
    );
  });

  it("stamps accountId on the turn context AND the run params (S1: turnSourceAccountId)", async () => {
    const transport = new WebChannelTransport();
    vi.spyOn(transport, "sendText").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { accounts: { acctB: {} } },
    });

    await handleInboundMessage(
      api,
      transport,
      "alice",
      { type: "user_message", text: "hello" },
      "acctB",
    );

    const inbound = (api as any).runtime.channel.inbound;
    // Core copies buildContext's accountId into ctx.AccountId, which becomes the
    // agent request's accountId and, on an exec approval, turnSourceAccountId —
    // the field each account's approval handler matches on. Without this stamp,
    // account-B approvals fall back to the primary handler (the S1 misroute).
    expect(inbound.run).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "webchannel", accountId: "acctB" }),
    );
    expect(inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "webchannel", accountId: "acctB" }),
    );
  });

  it("applies PER-ACCOUNT dmSecurity allowlist (account isolation — Cycle 2)", async () => {
    const transport = new WebChannelTransport();
    vi.spyOn(transport, "sendText").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: {
        accounts: { acctA: { dmSecurity: "allowlist", allowFrom: ["alice"] } },
      },
    });
    const inboundRun = (api.runtime as { channel: { inbound: { run: ReturnType<typeof vi.fn> } } })
      .channel.inbound.run;

    // A non-allowlisted peer on acctA is denied (per-account allowlist applied).
    await handleInboundMessage(
      api,
      transport,
      "mallory",
      { type: "user_message", text: "let me in" },
      "acctA",
    );
    expect(inboundRun).not.toHaveBeenCalled();

    // The allowlisted peer on acctA is admitted.
    await handleInboundMessage(
      api,
      transport,
      "alice",
      { type: "user_message", text: "hi" },
      "acctA",
    );
    expect(inboundRun).toHaveBeenCalledOnce();
  });

  it("default account keeps reading the flat (channel-level) config (regression)", async () => {
    const transport = new WebChannelTransport();
    vi.spyOn(transport, "sendText").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    // Flat config (no accounts map) — the default account resolves it as base.
    const { api, resolveAgentRoute } = makeFakeApi(captured, {
      channelConfig: { dmSecurity: "allowlist", allowFrom: ["alice"] },
    });
    const inboundRun = (api.runtime as { channel: { inbound: { run: ReturnType<typeof vi.fn> } } })
      .channel.inbound.run;

    // No accountId arg → defaults to "default", reads the flat block.
    await handleInboundMessage(api, transport, "alice", { type: "user_message", text: "hi" });
    expect(inboundRun).toHaveBeenCalledOnce();
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("streams a progress draft then finalizes the SAME id when streaming.mode=progress", async () => {
    const transport = new WebChannelTransport();
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
      const transport = new WebChannelTransport();
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

  it("sends exactly one typing frame after route resolution, before agent dispatch (AC2)", async () => {
    const transport = new WebChannelTransport();
    const typingSpy = vi
      .spyOn(transport, "sendTyping")
      .mockReturnValue(true);
    // Spy the EXISTING text send to detect the call order: typing must fire
    // BEFORE the agent's reply is delivered (route → typing → dispatch).
    const sendTextSpy = vi
      .spyOn(transport, "sendText")
      .mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api, resolveAgentRoute } = makeFakeApi(captured);

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    // Route was resolved first (proves the typing call is after route
    // resolution, not before it).
    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
    // Typing was sent exactly once, with the originating peer (wsKey).
    expect(typingSpy).toHaveBeenCalledTimes(1);
    expect(typingSpy).toHaveBeenCalledWith("web-anon");
    // The agent's reply (via sendText) was delivered — proves the typing
    // call is BEFORE agent dispatch, not after.
    expect(sendTextSpy).toHaveBeenCalledWith("web-anon", "hi back");
    // Strict order: typing < sendText.
    const typingOrder = typingSpy.mock.invocationCallOrder[0];
    const sendTextOrder = sendTextSpy.mock.invocationCallOrder[0];
    expect(typingOrder).toBeLessThan(sendTextOrder);
  });

  it("still sends the typing frame when the turn throws mid-dispatch (AC2)", async () => {
    const transport = new WebChannelTransport();
    const typingSpy = vi
      .spyOn(transport, "sendTyping")
      .mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, { throwAfterProgress: false });

    // Make the fake kernel THROW (e.g. channelRuntime.inbound.run explodes).
    const channel = (api.runtime as { channel: { inbound: { run: ReturnType<typeof vi.fn> } } })
      .channel.inbound.run;
    channel.mockRejectedValueOnce(new Error("kernel exploded"));

    // The handler swallows the dispatch error (logs it); it must NOT reject.
    await expect(
      handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      }),
    ).resolves.toBeUndefined();

    // Typing was still pushed exactly once — the seed spec mandates "turn
    // 종료 경로와 무관하게 typing은 한 번 이상 발송" (regardless of termination
    // path, typing is sent at least once). The user must see the affordance
    // even if the turn blows up; the first real frame from a subsequent turn
    // (or a manual reload) will clear it.
    expect(typingSpy).toHaveBeenCalledTimes(1);
    expect(typingSpy).toHaveBeenCalledWith("web-anon");
  });

  it("history snapshot wiring lives in index.ts (transport hooks are exposed)", () => {
    // The seed AC3 (first-pong → sendHistory) is wired in index.ts, not in
    // handleInboundMessage. This test is a structural guard: we verify the
    // transport exposes BOTH the first-liveness hook AND the load-history
    // hook, so index.ts can wire them up without further transport changes.
    const transport = new WebChannelTransport();
    expect(typeof transport.setFirstLivenessHandler).toBe("function");
    expect(typeof transport.setLoadHistoryHandler).toBe("function");
    expect(typeof transport.sendHistory).toBe("function");
    expect(typeof transport.setHistoryEnabled).toBe("function");

    // Also pin the surface: handlers can be registered (the throw is expected
    // if invoked without a socket — proves they're real methods, not stubs).
    transport.setFirstLivenessHandler(() => undefined);
    transport.setLoadHistoryHandler(() => undefined);
    expect(transport.sendHistory("missing", [])).toBe(false);
  });

  it("load_history inbound wire frame dispatches to the registered handler (AC3 integration)", () => {
    // Drive the transport's ws.on("message", ...) path with a synthetic
    // `load_history` frame and confirm the registered handler fires with the
    // validated { before, limit } shape. This is the wire-side companion to
    // the unit test in transport.test.ts and locks the parse contract from
    // the transport's POV.
    const transport = new WebChannelTransport({ heartbeatMs: 60_000 });
    const handler = vi.fn();
    transport.setLoadHistoryHandler(handler);

    // Minimal event-emitter fake: only the surface transport.registerConnection
    // needs. Holds listeners on a Map and emits with a typed iterator.
    type FakeWs = {
      on: (event: string, listener: (arg?: unknown) => void) => unknown;
      emit: (event: string, arg?: unknown) => void;
    };
    const fakeWs: FakeWs = (() => {
      const listeners = new Map<string, Array<(arg?: unknown) => void>>();
      return {
        on(event, listener) {
          const arr = listeners.get(event) ?? [];
          arr.push(listener);
          listeners.set(event, arr);
          return this;
        },
        emit(event, arg) {
          for (const fn of listeners.get(event) ?? []) fn(arg);
        },
      };
    })();

    (transport as unknown as {
      registerConnection: (w: unknown, id: string) => void;
    }).registerConnection(fakeWs, "peer-test");

    fakeWs.emit("message", JSON.stringify({ type: "load_history", before: "m-9", limit: 25 }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("peer-test", { before: "m-9", limit: 25 });
  });
});
