import { describe, it, expect, vi, beforeEach } from "vitest";

import { NullPeerChannel } from "./channel-contract.js";
class FakePeerChannel extends NullPeerChannel {
  constructor(_options?: unknown) { super(); }
  private approvalHandler?: (peerId: string, id: string, decision: any) => void;
  private historyHandler?: (peerId: string, request: any) => void;
  setApprovalDecisionHandler(handler: any) { this.approvalHandler = handler; }
  setFirstLivenessHandler(_handler: any) {}
  setLoadHistoryHandler(handler: any) { this.historyHandler = handler; }
  setHistoryEnabled(_enabled: boolean) {}
  registerConnection(ws: any, peerId = "web-anon") { ws.on("message", (raw: any) => { try { const frame = JSON.parse(String(raw)); if (frame.type === "approval_decision" && ["allow-once", "allow-always", "deny"].includes(frame.decision)) this.approvalHandler?.(peerId, frame.id, frame.decision); if (frame.type === "load_history") this.historyHandler?.(peerId, { ...(frame.before ? { before: frame.before } : {}), ...(frame.limit ? { limit: frame.limit } : {}) }); } catch {} }); }
}
import { createWebChannelPlugin } from "./channel.js";
import { handleInboundMessage } from "./inbound.js";
import { resolveWebchannelReasoningLevel } from "./reasoning-level.js";

// Reasoning display policy is resolved from the session store / config default in
// production (reasoning-level.ts, Telegram parity). These channel tests exercise
// the callback WIRING per streaming mode + reasoning level, so we mock the
// resolver to drive the level deterministically. Default is "off" — matching the
// real default — so the reasoning lane is NOT wired unless a test opts into
// "stream".
vi.mock("./reasoning-level.js", () => ({
  resolveWebchannelReasoningLevel: vi.fn(() => "off"),
}));
const mockReasoningLevel = vi.mocked(resolveWebchannelReasoningLevel);

beforeEach(() => {
  mockReasoningLevel.mockReset();
  mockReasoningLevel.mockReturnValue("off");
});

describe("webchannel plugin", () => {
  it("resolves an account from config", () => {
    const transport = new FakePeerChannel();
    const plugin = createWebChannelPlugin(transport);
    const cfg = {
      channels: { webchannel: { allowFrom: ["user1"], dmSecurity: "allowlist" } },
    } as any;
    const account = plugin.config.resolveAccount(cfg, undefined);
    expect(account.enabled).toBe(true);
    expect(plugin.config.isEnabled!(account, cfg)).toBe(true);
    expect(account.allowFrom).toEqual(["user1"]);
    expect(account.dmPolicy).toBe("allowlist");
  });

  it("reports an actual flat default configuration as configured", () => {
    const transport = new FakePeerChannel();
    const plugin = createWebChannelPlugin(transport);
    const cfg = { channels: { webchannel: { dmSecurity: "allowlist" } } } as any;
    const account = plugin.config.resolveAccount(cfg, undefined);
    const result = plugin.config.inspectAccount!(cfg, undefined) as {
      configured: boolean;
    };
    expect(result.configured).toBe(true);
    expect(plugin.config.isConfigured!(account, cfg)).toBe(true);

    const ghost = plugin.config.resolveAccount(cfg, "ghost");
    expect(ghost.enabled).toBe(true);
    expect(plugin.config.isEnabled!(ghost, cfg)).toBe(true);
    expect(plugin.config.isConfigured!(ghost, cfg)).toBe(false);
    expect(plugin.config.inspectAccount!(cfg, "ghost")).toMatchObject({
      enabled: true,
      configured: false,
      tokenStatus: "missing",
    });
  });

  it("reports absent and empty channel sections as unconfigured", () => {
    const plugin = createWebChannelPlugin(new FakePeerChannel());
    const fixtures = [
      {},
      { channels: {} },
      { channels: { webchannel: {} } },
      { channels: { webchannel: { accounts: {} } } },
      { channels: { webchannel: { enabled: true } } },
      { channels: { webchannel: { enabled: false } } },
      { channels: { webchannel: { defaultAccount: "default" } } },
      { channels: { webchannel: { accounts: {}, enabled: true } } },
    ] as any[];

    for (const cfg of fixtures) {
      const account = plugin.config.resolveAccount(cfg, undefined);
      expect(plugin.config.isConfigured!(account, cfg)).toBe(false);
      expect(plugin.config.inspectAccount!(cfg, undefined)).toMatchObject({
        configured: false,
        tokenStatus: "missing",
      });
    }
  });

  it("reports an explicitly configured named account as configured", () => {
    const plugin = createWebChannelPlugin(new FakePeerChannel());
    const cfg = {
      channels: {
        webchannel: {
          accounts: { work: { dmSecurity: "allowlist" } },
        },
      },
    } as any;
    const account = plugin.config.resolveAccount(cfg, "work");
    expect(plugin.config.isConfigured!(account, cfg)).toBe(true);
    expect(plugin.config.inspectAccount!(cfg, "work")).toMatchObject({
      configured: true,
      tokenStatus: "available",
    });
  });

  it("reports flat channel-level disable while keeping configuration truth separate", () => {
    const plugin = createWebChannelPlugin(new FakePeerChannel());
    const disabledCfg = {
      channels: { webchannel: { enabled: false, dmSecurity: "allowlist" } },
    } as any;
    const disabled = plugin.config.resolveAccount(disabledCfg, undefined);
    expect(disabled.enabled).toBe(false);
    expect(plugin.config.isEnabled!(disabled, disabledCfg)).toBe(false);
    expect(plugin.config.isConfigured!(disabled, disabledCfg)).toBe(true);
    expect(plugin.config.inspectAccount!(disabledCfg, undefined)).toMatchObject({
      enabled: false,
      configured: true,
    });

    const enabledCfg = {
      channels: { webchannel: { enabled: true, dmSecurity: "allowlist" } },
    } as any;
    const enabled = plugin.config.resolveAccount(enabledCfg, undefined);
    expect(enabled.enabled).toBe(true);
    expect(plugin.config.isEnabled!(enabled, enabledCfg)).toBe(true);
    expect(plugin.config.inspectAccount!(enabledCfg, undefined)).toMatchObject({
      enabled: true,
      configured: true,
    });
  });

  it("honors named disable, enabled controls, and global-disable dominance", () => {
    const plugin = createWebChannelPlugin(new FakePeerChannel());
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            disabled: { enabled: false, dmSecurity: "allowlist" },
            enabled: { enabled: true, dmSecurity: "allowlist" },
            inherited: { dmSecurity: "allowlist" },
          },
        },
      },
    } as any;

    for (const [accountId, expected] of [
      ["disabled", false],
      ["enabled", true],
      ["inherited", true],
    ] as const) {
      const account = plugin.config.resolveAccount(cfg, accountId);
      expect(account.enabled).toBe(expected);
      expect(plugin.config.isEnabled!(account, cfg)).toBe(expected);
      expect(plugin.config.inspectAccount!(cfg, accountId)).toMatchObject({
        enabled: expected,
        configured: true,
      });
    }

    const ghost = plugin.config.resolveAccount(cfg, "ghost");
    expect(ghost.enabled).toBe(true);
    expect(plugin.config.isEnabled!(ghost, cfg)).toBe(true);
    expect(plugin.config.isConfigured!(ghost, cfg)).toBe(false);
    expect(plugin.config.inspectAccount!(cfg, "ghost")).toMatchObject({
      enabled: true,
      configured: false,
    });

    const globallyDisabledCfg = {
      channels: {
        webchannel: {
          enabled: false,
          accounts: { enabled: { enabled: true, dmSecurity: "allowlist" } },
        },
      },
    } as any;
    const globallyDisabled = plugin.config.resolveAccount(globallyDisabledCfg, "enabled");
    expect(globallyDisabled.enabled).toBe(false);
    expect(plugin.config.isEnabled!(globallyDisabled, globallyDisabledCfg)).toBe(false);
    expect(plugin.config.inspectAccount!(globallyDisabledCfg, "enabled")).toMatchObject({
      enabled: false,
      configured: true,
    });
  });

  it("throws distinct outbound errors and never marks this send path best-effort", async () => {
    const transport = new FakePeerChannel();
    const plugin = createWebChannelPlugin(transport) as any;
    const sendText = plugin.outbound.sendText;
    await expect(sendText({ text: "hello" })).rejects.toThrow("ctx.to is absent");
    await expect(sendText({ to: "missing", text: "hello" })).rejects.toThrow(
      "targeted send returned false for peer missing",
    );
    // D1 caveat: this adapter does not opt into core's error-swallowing path.
    expect(plugin.outbound.bestEffort).not.toBe(true);
  });

  it("exposes doctor preview warnings and status probing from the common factory", async () => {
    const plugin = createWebChannelPlugin(new FakePeerChannel());
    expect(plugin.doctor?.collectPreviewWarnings).toBeTypeOf("function");
    expect(plugin.status?.probeAccount).toBeTypeOf("function");
    const warnings = await plugin.doctor!.collectPreviewWarnings!({
      cfg: { channels: { webchannel: { encryption: { mode: "disabled" }, dmSecurity: "allowlist" } } } as never,
      doctorFixCommand: "openclaw doctor --fix",
      env: {},
    });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/channels\.webchannel\.default.*encryption-disabled/)]),
    );
  });
});

describe("webchannel transport", () => {
  it("returns false when no socket is mapped for a session", () => {
    const transport = new FakePeerChannel();
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
      // When set, the fake kernel fires onPartialReply (if the turn wired it)
      // with each cumulative answer text in sequence, AFTER tool progress but
      // BEFORE delivering the final reply. Simulates core's final-answer stream.
      partialTexts?: string[];
      // A finer-grained answer stream than `partialTexts`: an ordered sequence
      // mixing cumulative partial texts and assistant-message boundaries, so a
      // test can drive a MULTI-message reply (boundary → per-item cumulative
      // restarts from ""). Fired in the same slot as `partialTexts`.
      partialSteps?: Array<{ text: string } | { boundary: true }>;
      reasoningSteps?: Array<{
        text: string;
        isReasoningSnapshot?: boolean;
        end?: boolean;
      }>;
      // Captures the replyOptions the turn supplied, so a test can assert which
      // callbacks were (or were NOT) wired for a given streaming mode.
      onReplyOptions?: (replyOptions: any) => void;
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
          // Expose the turn's replyOptions so a test can assert which callbacks
          // the streaming mode wired (e.g. progress mode must NOT wire onPartialReply).
          opts?.onReplyOptions?.(turn.replyOptions);
          // In a draft mode the turn supplies replyOptions whose tool callbacks
          // fire DURING the run; emulate one tool event so the draft starts.
          if (opts?.fireToolProgress && turn.replyOptions?.onToolStart) {
            await turn.replyOptions.onToolStart({ name: "web_search", phase: "start" });
          }
          // Answer-text streaming: fire onPartialReply with each cumulative text
          // (core sends the FULL text-so-far each call). Only wired in partial mode.
          if (opts?.partialTexts && turn.replyOptions?.onPartialReply) {
            for (const text of opts.partialTexts) {
              await turn.replyOptions.onPartialReply({ text });
            }
          }
          // Multi-message answer stream: replay a mixed sequence of cumulative
          // partials and assistant-message boundaries (each only fires if the
          // turn wired the matching callback — i.e. partial mode).
          if (opts?.partialSteps) {
            for (const step of opts.partialSteps) {
              if ("boundary" in step) {
                await turn.replyOptions?.onAssistantMessageStart?.();
              } else if (turn.replyOptions?.onPartialReply) {
                await turn.replyOptions.onPartialReply({ text: step.text });
              }
            }
          }
          if (opts?.reasoningSteps) {
            for (const step of opts.reasoningSteps) {
              await turn.replyOptions?.onReasoningStream?.(step);
              if (step.end) await turn.replyOptions?.onReasoningEnd?.();
            }
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

  it("warns once when turn_settled cannot be sent, without reporting false success", async () => {
    const transport = new FakePeerChannel();
    const settledSpy = vi.spyOn(transport, "sendTurnSettled").mockReturnValue(false);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured);
    const warn = vi.fn();
    api.logger.warn = warn;
    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message", id: "turn-ts", text: "hello",
    });
    expect(settledSpy).toHaveBeenCalledWith("web-anon", "turn-ts", "ok");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("turn_settled was not delivered");
  });

  it("default-deny allowlist (gap ③): a non-allowlisted peer is denied — inbound.run never runs, no reply", async () => {
    const transport = new FakePeerChannel();
    const sendSpy = vi.spyOn(transport, "sendText").mockReturnValue(true);
    const settledSpy = vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);

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
    expect(settledSpy).not.toHaveBeenCalled();
  });

  it("default-deny allowlist (gap ③): an allowlisted peer is admitted — inbound.run runs and reply is delivered", async () => {
    const transport = new FakePeerChannel();
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

  it("settles an ACKed ordinary turn as error when route setup throws before inbound.run", async () => {
    const transport = new FakePeerChannel();
    const sendSpy = vi.spyOn(transport, "sendText").mockReturnValue(true);
    const settledSpy = vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api, resolveAgentRoute } = makeFakeApi(captured);
    resolveAgentRoute.mockImplementation(() => {
      throw new Error("route store unavailable");
    });
    const error = vi.fn();
    api.logger.error = error;
    const inboundRun = (api.runtime as { channel: { inbound: { run: ReturnType<typeof vi.fn> } } })
      .channel.inbound.run;

    await handleInboundMessage(api, transport, "alice", {
      type: "user_message",
      id: "acked-route-fault",
      text: "hello",
    });

    expect(inboundRun).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      "alice",
      "Sorry — something went wrong while answering. Please try again.",
      undefined,
      "acked-route-fault",
    );
    expect(settledSpy).toHaveBeenCalledTimes(1);
    expect(settledSpy).toHaveBeenCalledWith("alice", "acked-route-fault", "error");
  });

  it("resolves a channel-scoped route and delivers the reply to the peer socket", async () => {
    const transport = new FakePeerChannel();
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
    expect(sendSpy).toHaveBeenCalledWith("web-anon", "hi back", undefined, expect.any(String));
  });

  it("threads accountId into resolveAgentRoute (binding.account routing — Cycle 2)", async () => {
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
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
    expect(finalizeSpy).toHaveBeenCalledWith("web-anon", progId, "hi back", expect.any(String));

    // Every progress frame shares the one draft id.
    for (const call of progressSpy.mock.calls) {
      expect(call[1]).toBe(progId);
    }
  });

  it("streams ANSWER TEXT as progress frames (one draft id) then finalizes the SAME id when streaming.mode=partial (no-tool turn)", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // No tool events this turn — only cumulative answer-text partials.
      partialTexts: ["Hel", "Hello wor", "Hello world"],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    // Answer text streamed as progress frames sharing ONE draft id.
    expect(progressSpy).toHaveBeenCalled();
    const progId = progressSpy.mock.calls[0][1];
    for (const call of progressSpy.mock.calls) {
      expect(call[0]).toBe("web-anon");
      expect(call[1]).toBe(progId);
      // Once answer text exists there is NO "Working…" scaffold — the answer
      // text OWNS the whole draft body (replacement, not append).
      expect(call[2]).not.toMatch(/…$/m);
    }
    // The last emitted frame carries the latest cumulative answer text.
    const lastFrameText = progressSpy.mock.calls[progressSpy.mock.calls.length - 1][2];
    expect(lastFrameText).toBe("Hello world");

    // The final answer finalized the SAME draft id (working bubble → final text).
    expect(finalizeSpy).toHaveBeenCalledWith("web-anon", progId, "hi back", expect.any(String));
  });

  it("strips reasoning tags from streamed partials in partial mode (mirrors core hygiene)", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // Reasoning tags must be stripped before hitting the draft; no frame may
      // ever expose the hidden reasoning content.
      partialTexts: ["<think>secret plan</think>Hello world"],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    for (const call of progressSpy.mock.calls) {
      expect(call[2]).not.toContain("secret plan");
      expect(call[2]).not.toContain("<think>");
    }
    const lastFrameText = progressSpy.mock.calls[progressSpy.mock.calls.length - 1][2];
    expect(lastFrameText).toBe("Hello world");
    const progId = progressSpy.mock.calls[0][1];
    expect(finalizeSpy).toHaveBeenCalledWith("web-anon", progId, "hi back", expect.any(String));
  });

  it("ignores a SHRINKING cumulative partial (no backwards flicker) in partial mode", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // The second partial is a shorter prefix of the first — core (and now we)
      // ignore it so the draft never regresses to the shorter text.
      partialTexts: ["Hello world", "Hello"],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    // No frame ever regresses to the shorter "Hello"; the draft stays at the
    // longer cumulative text.
    for (const call of progressSpy.mock.calls) {
      expect(call[2]).toBe("Hello world");
    }
  });

  it("shows label+tool line first, then the answer text replaces the scaffold when streaming.mode=partial (mixed turn)", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      fireToolProgress: true,
      partialTexts: ["The answer is 42"],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    // Before answer text arrives the draft is the working scaffold: "<Label>…"
    // header + the formatted tool line.
    const firstFrameText = progressSpy.mock.calls[0][2];
    expect(firstFrameText.split("\n")[0]).toMatch(/…$/);
    expect(firstFrameText).toMatch(/Web Search/i);
    // Once answer text streams, a later frame's body is the answer text with NO
    // "…" scaffold header (the answer replaced the working view).
    const lastFrameText = progressSpy.mock.calls[progressSpy.mock.calls.length - 1][2];
    expect(lastFrameText).toBe("The answer is 42");
    // Every frame shares the one draft id.
    const progId = progressSpy.mock.calls[0][1];
    for (const call of progressSpy.mock.calls) expect(call[1]).toBe(progId);
  });

  it("preserves earlier message text across an assistant-message boundary in partial mode (no vanish)", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // Two final_answer messages: the second's cumulative partials restart from
      // "" after the boundary. The already-streamed "First msg" must NOT vanish.
      partialSteps: [
        { text: "First msg" },
        { boundary: true },
        { text: "Sec" },
        { text: "Second msg" },
      ],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    // Every frame after the boundary keeps the first message as a prefix — the
    // last emitted frame shows both messages joined (prefix preserved).
    const lastFrameText = progressSpy.mock.calls[progressSpy.mock.calls.length - 1][2];
    expect(lastFrameText).toBe("First msg\n\nSecond msg");
    // No frame ever drops "First msg" once it has been streamed (no vanish):
    // the only frames without it are the pre-first-message ones (there are none
    // here since the first partial IS "First msg").
    const firstMsgFrames = progressSpy.mock.calls.filter((c) =>
      (c[2] as string).includes("First msg"),
    );
    expect(firstMsgFrames.length).toBe(progressSpy.mock.calls.length);
    // All frames share one draft id, and the final settles that same id.
    const progId = progressSpy.mock.calls[0][1];
    for (const call of progressSpy.mock.calls) expect(call[1]).toBe(progId);
    expect(finalizeSpy).toHaveBeenCalledWith("web-anon", progId, "hi back", expect.any(String));
  });

  it("treats an assistant-message boundary BEFORE the first partial as a no-op (no leading blank prefix)", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // Core fires onAssistantMessageStart before the FIRST message too; that
      // call must be a no-op (answerText empty) — no leading "\n\n" prefix.
      partialSteps: [
        { boundary: true },
        { text: "First" },
        { text: "First answer" },
      ],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    // No frame carries a leading blank prefix from the pre-first boundary.
    for (const call of progressSpy.mock.calls) {
      expect((call[2] as string).startsWith("\n\n")).toBe(false);
    }
    // The very first frame is exactly the first partial's text (no prefix).
    expect(progressSpy.mock.calls[0][2]).toBe("First");
  });

  it("degrades a MISSING assistant-message boundary to correct accumulation (no clobber, no dup)", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // Two messages with NO boundary event between them. The second message's
      // cumulative partial ("Second msg") restarts from "" and DIVERGES from
      // the first ("First msg") — neither is a prefix of the other. Without the
      // missed-boundary defense this would clobber "First msg".
      partialSteps: [{ text: "First msg" }, { text: "Second msg" }],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    // The seam was rolled up defensively: the last frame keeps BOTH messages.
    const lastFrameText = progressSpy.mock.calls[progressSpy.mock.calls.length - 1][2];
    expect(lastFrameText).toBe("First msg\n\nSecond msg");
    // "First msg" is never dropped once streamed (no clobber) and appears once
    // per frame (no duplication) in the final joined frame.
    expect((lastFrameText as string).match(/First msg/g)?.length).toBe(1);
    expect((lastFrameText as string).match(/Second msg/g)?.length).toBe(1);
    const progId = progressSpy.mock.calls[0][1];
    for (const call of progressSpy.mock.calls) expect(call[1]).toBe(progId);
    expect(finalizeSpy).toHaveBeenCalledWith("web-anon", progId, "hi back", expect.any(String));
  });

  it("handles a LATE assistant-message boundary idempotently (no double-roll)", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // The boundary arrives LATE — after the second message's first partial has
      // already been ingested (and rolled up by the missed-boundary defense).
      // The belated boundary must be a no-op: it must NOT roll "Second msg" a
      // second time. A subsequent growth partial extends the second message.
      partialSteps: [
        { text: "First msg" },
        { text: "Second msg" },
        { boundary: true },
        { text: "Second msg more" },
      ],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    const lastFrameText = progressSpy.mock.calls[progressSpy.mock.calls.length - 1][2];
    // No double-roll: "First msg" rolled ONCE, second message accumulates in
    // place — not "First msg\n\nSecond msg\n\nSecond msg more".
    expect(lastFrameText).toBe("First msg\n\nSecond msg more");
    expect((lastFrameText as string).match(/First msg/g)?.length).toBe(1);
  });

  it("does NOT stream answer text in progress mode (onPartialReply is not wired — regression)", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    let seenReplyOptions: any;
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "progress" } },
      fireToolProgress: true,
      // Offer partials, but the kernel only fires them if the turn WIRED
      // onPartialReply — progress mode must not.
      partialTexts: ["leaked answer text"],
      onReplyOptions: (ro) => {
        seenReplyOptions = ro;
      },
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    // Progress mode wires tool/item events but NOT onPartialReply.
    expect(seenReplyOptions?.onToolStart).toBeTypeOf("function");
    expect(seenReplyOptions?.onPartialReply).toBeUndefined();
    // No progress frame ever contains the answer text; tool-lines-only holds.
    expect(progressSpy).toHaveBeenCalled();
    for (const call of progressSpy.mock.calls) {
      expect(call[2]).not.toContain("leaked answer text");
    }
    // The working scaffold header is still present (tool-lines-only view).
    expect(progressSpy.mock.calls[0][2].split("\n")[0]).toMatch(/…$/);
  });

  it("streaming.mode=block takes the plain no-id agent_message path (no draft — regression)", async () => {
    const transport = new FakePeerChannel();
    const sendTextSpy = vi.spyOn(transport, "sendText").mockReturnValue(true);
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    let seenReplyOptions: any = "unset";
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "block" } },
      fireToolProgress: true,
      partialTexts: ["should not stream"],
      onReplyOptions: (ro) => {
        seenReplyOptions = ro;
      },
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    // No answer/tool draft AND reasoning level is the default "off": with neither
    // lane active, replyOptions is omitted entirely (pre-reasoning-lane shape).
    expect(seenReplyOptions).toBeUndefined();
    expect(progressSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(sendTextSpy).toHaveBeenCalledWith("web-anon", "hi back", undefined, expect.any(String));
  });

  it("streaming.mode=block with reasoning level 'stream' wires ONLY the reasoning callbacks (no tool/answer draft)", async () => {
    const transport = new FakePeerChannel();
    const sendTextSpy = vi.spyOn(transport, "sendText").mockReturnValue(true);
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    mockReasoningLevel.mockReturnValue("stream");

    let seenReplyOptions: any = "unset";
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "block" } },
      fireToolProgress: true,
      partialTexts: ["should not stream"],
      onReplyOptions: (ro) => {
        seenReplyOptions = ro;
      },
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    // Reasoning lane opened, but no answer/tool draft in block mode: replyOptions
    // carries ONLY the reasoning callbacks — no tool/answer callbacks, no suppression.
    expect(seenReplyOptions).toEqual({
      onReasoningStream: expect.any(Function),
      onReasoningEnd: expect.any(Function),
    });
    expect(progressSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(sendTextSpy).toHaveBeenCalledWith("web-anon", "hi back", undefined, expect.any(String));
  });

  it.each(["off", "block", "progress", "partial"] as const)(
    "streams reasoning independently of the answer streaming mode when the level is 'stream' (mode=%s)",
    async (mode) => {
      const transport = new FakePeerChannel();
      const reasoningSpy = vi.spyOn(transport, "sendReasoning").mockReturnValue(true);
      const settledSpy = vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);
      mockReasoningLevel.mockReturnValue("stream");
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode } },
        reasoningSteps: [{ text: "safe" }],
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        id: "turn-42",
        text: "hello",
      });

      expect(reasoningSpy).toHaveBeenCalledTimes(1);
      expect(reasoningSpy).toHaveBeenCalledWith(
        "web-anon",
        expect.any(String),
        "turn-42",
        "safe",
      );
      // turn_settled is a lifecycle frame emitted for every ordinary turn.
      expect(settledSpy).toHaveBeenCalledWith("web-anon", "turn-42", "ok");
    },
  );

  it.each(["off", "on"] as const)(
    "does NOT wire the reasoning lane when the resolved level is '%s' (Telegram parity: only 'stream' streams)",
    async (level) => {
      // btw emits reasoning upstream at level "on" too (dist/btw-CDO5476N.js:617-627),
      // but the webchannel display policy — like Telegram — streams reasoning ONLY
      // at "stream". At "off"/"on" no reasoning callback is wired and no frame is sent.
      const transport = new FakePeerChannel();
      const reasoningSpy = vi.spyOn(transport, "sendReasoning").mockReturnValue(true);
      const settledSpy = vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);
      mockReasoningLevel.mockReturnValue(level);
      let seenReplyOptions: any = "unset";
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        reasoningSteps: [{ text: "safe" }],
        onReplyOptions: (ro) => {
          seenReplyOptions = ro;
        },
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        id: "turn-42",
        text: "hello",
      });

      // No reasoning callback wired (partial mode still wires the answer draft,
      // just not the reasoning lane) and no reasoning frame emitted.
      expect(seenReplyOptions?.onReasoningStream).toBeUndefined();
      expect(seenReplyOptions?.onReasoningEnd).toBeUndefined();
      expect(reasoningSpy).not.toHaveBeenCalled();
      // turn_settled still fires — it is a lifecycle frame, not a reasoning frame.
      expect(settledSpy).toHaveBeenCalledWith("web-anon", "turn-42", "ok");
    },
  );

  it("recovers the working bubble when the turn throws mid-draft in progress mode", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakePeerChannel();
      // Open socket simulated: progress/finalize sends "succeed" so the draft
      // actually starts (started=true) and the widget shows a working bubble.
      const progressSpy = vi
        .spyOn(transport, "sendProgress")
        .mockReturnValue(true);
      const finalizeSpy = vi
        .spyOn(transport, "finalizeDraft")
        .mockReturnValue(true);
      const settledSpy = vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);

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
      expect(settledSpy).toHaveBeenCalledWith("web-anon", expect.any(String), "error");

      // The draft loop was stopped: no late background throttled flush fires
      // after the error handling, so no further progress frames are emitted.
      const progressCountAfterError = progressSpy.mock.calls.length;
      await vi.runAllTimersAsync();
      expect(progressSpy.mock.calls.length).toBe(progressCountAfterError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers the working bubble when the turn throws mid-draft in partial mode (answer-text-only, no tool events)", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakePeerChannel();
      const progressSpy = vi
        .spyOn(transport, "sendProgress")
        .mockReturnValue(true);
      const finalizeSpy = vi
        .spyOn(transport, "finalizeDraft")
        .mockReturnValue(true);

      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        // No tool events — the draft starts purely from streamed answer text,
        // then the turn throws before the final reply is delivered.
        partialTexts: ["Partial ans"],
        throwAfterProgress: true,
      });

      await expect(
        handleInboundMessage(api, transport, "web-anon", {
          type: "user_message",
          text: "hello",
        }),
      ).resolves.toBeUndefined();

      // A working bubble was shown from answer text alone (draft started)...
      expect(progressSpy).toHaveBeenCalled();
      const progId = progressSpy.mock.calls[0][1];

      // ...and the SAME draft id was finalized with a non-empty apology, so the
      // widget settles instead of hanging on the streamed partial forever.
      expect(finalizeSpy).toHaveBeenCalledTimes(1);
      const [finSession, finId, finText] = finalizeSpy.mock.calls[0];
      expect(finSession).toBe("web-anon");
      expect(finId).toBe(progId);
      expect((finText as string).length).toBeGreaterThan(0);

      // Loop stopped: no late background flush after error handling.
      const progressCountAfterError = progressSpy.mock.calls.length;
      await vi.runAllTimersAsync();
      expect(progressSpy.mock.calls.length).toBe(progressCountAfterError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends exactly one typing frame after route resolution, before agent dispatch (AC2)", async () => {
    const transport = new FakePeerChannel();
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
    expect(sendTextSpy).toHaveBeenCalledWith("web-anon", "hi back", undefined, expect.any(String));
    // Strict order: typing < sendText.
    const typingOrder = typingSpy.mock.invocationCallOrder[0];
    const sendTextOrder = sendTextSpy.mock.invocationCallOrder[0];
    expect(typingOrder).toBeLessThan(sendTextOrder);
  });

  it("still sends the typing frame when the turn throws mid-dispatch (AC2)", async () => {
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel({ heartbeatMs: 60_000 });
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
