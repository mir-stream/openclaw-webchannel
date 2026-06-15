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
  function makeFakeApi(captured: { recordedSessionKey?: string; recordedTo?: string }) {
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
          await turn.delivery.deliver({ text: "hi back" }, { kind: "final" });
        }),
      },
    };

    return {
      api: { config: {}, runtime: { channel }, logger: {} } as any,
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
    expect(sendSpy).toHaveBeenCalledWith("web-anon", "hi back");
  });
});
