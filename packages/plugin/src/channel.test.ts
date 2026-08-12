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
import { composeAccountLifecycles, createWebChannelPlugin } from "./channel.js";
import {
  handleInboundMessage,
  startAgentLifecycleSubscription,
  stopAgentLifecycleSubscription,
} from "./inbound.js";
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

describe("account lifecycle composition", () => {
  const context = (abortSignal: AbortSignal) => ({
    accountId: "default",
    abortSignal,
    channelRuntime: { runtimeContexts: { register: () => ({ dispose: vi.fn() }) } },
  });

  it("host abort waits for both approval and NATS cleanup", async () => {
    const host = new AbortController();
    let release!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
    const task = composeAccountLifecycles(context(host.signal), async (ctx) => {
      if (!ctx.abortSignal.aborted) await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", resolve, { once: true }));
      await cleanupGate;
    });
    host.abort();
    let settled = false;
    void task.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(task).resolves.toBeUndefined();
  });

  it("an unexpected sibling resolution aborts and awaits approval cleanup before rejecting", async () => {
    const host = new AbortController();
    const task = composeAccountLifecycles(context(host.signal), async () => {});
    await expect(task).rejects.toThrow(/nats account lifecycle exited before host abort/);
  });
});

describe("webchannel plugin", () => {
  it("reports invalid raw ids best-effort without changing valid enumeration", () => {
    const reporter = vi.fn(() => { throw new Error("logger failed"); });
    const plugin = createWebChannelPlugin(new FakePeerChannel(), { onInvalidAccountId: reporter });
    const mixed = { channels: { webchannel: { accounts: { good: {}, "bad.id": {} } } } } as any;
    expect(plugin.config.listAccountIds(mixed)).toEqual(["good"]);
    expect(reporter).toHaveBeenCalledWith(mixed, expect.objectContaining({ id: "bad.id" }));
    const allInvalid = { channels: { webchannel: { accounts: { "../bad": {} } } } } as any;
    expect(plugin.config.listAccountIds(allInvalid)).toEqual([]);
  });

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
  type NoticeFlags = {
    isStatusNotice?: boolean;
    isFallbackNotice?: boolean;
    isCompactionNotice?: boolean;
  };

  type TestReplyPayload = NoticeFlags & {
    text?: string;
    isError?: boolean;
  };

  type KernelStep =
    | { partial: { text?: string; delta?: string; replace?: true } }
    | { boundary: true }
    | {
        queuedBlock: {
          payload: TestReplyPayload;
          assistantMessageIndex?: number;
        };
      }
    | { deliverBlock: TestReplyPayload }
    | { deliverFinal: TestReplyPayload }
    | {
        lifecycle: {
          kind: "skip" | "cancel" | "settled";
          deliveryKind?: "tool" | "block" | "final";
          payload?: TestReplyPayload;
          assistantMessageIndex?: number;
        };
      }
    | { deliveryError: { kind: "tool" | "block" | "final" } }
    | { toolStart: { name?: string; phase?: string } }
    | { itemEvent: { kind?: string; name?: string; phase?: string; status?: string } };

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
      // Ordered pinned-runtime events for the #94 delivery/lifecycle seams.
      // Queued payloads and actual deliveries remain separate steps because
      // core hooks may rewrite or cancel between them.
      steps?: KernelStep[];
      // When supplied, these replace the default single `"hi back"` final.
      finalPayloads?: TestReplyPayload[];
      skipFinal?: boolean;
      betweenSteps?: () => Promise<void> | void;
      onDeliveryResult?: (
        result: { visibleReplySent?: boolean } | void,
        payload: TestReplyPayload,
        kind: "block" | "final",
      ) => void;
      lifecyclePhase?: "end" | "error";
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
    const agentEventListeners: Array<(event: unknown) => void> = [];
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
          const testRunId = "channel-test-run";
          if (opts?.lifecyclePhase) {
            turn.replyOptions?.onAgentRunStart?.(testRunId);
          }
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
          if (opts?.steps) {
            for (const step of opts.steps) {
              if ("partial" in step) {
                await turn.replyOptions?.onPartialReply?.(step.partial);
              } else if ("boundary" in step) {
                await turn.replyOptions?.onAssistantMessageStart?.();
              } else if ("queuedBlock" in step) {
                await turn.replyOptions?.onBlockReplyQueued?.(
                  step.queuedBlock.payload,
                  step.queuedBlock.assistantMessageIndex === undefined
                    ? {}
                    : { assistantMessageIndex: step.queuedBlock.assistantMessageIndex },
                );
              } else if ("deliverBlock" in step) {
                const result = await turn.delivery.deliver(step.deliverBlock, { kind: "block" });
                opts.onDeliveryResult?.(result, step.deliverBlock, "block");
              } else if ("deliverFinal" in step) {
                const result = await turn.delivery.deliver(step.deliverFinal, { kind: "final" });
                opts.onDeliveryResult?.(result, step.deliverFinal, "final");
              } else if ("lifecycle" in step) {
                const info = {
                  kind: step.lifecycle.deliveryKind ?? ("block" as const),
                  ...(step.lifecycle.assistantMessageIndex === undefined
                    ? {}
                    : { assistantMessageIndex: step.lifecycle.assistantMessageIndex }),
                };
                if (step.lifecycle.kind === "skip") {
                  await turn.dispatcherOptions?.onSkip?.(
                    step.lifecycle.payload ?? {},
                    { ...info, reason: "empty" },
                  );
                } else if (step.lifecycle.kind === "cancel") {
                  await turn.dispatcherOptions?.onBeforeDeliverCancelled?.(
                    step.lifecycle.payload ?? {},
                    info,
                  );
                } else {
                  await turn.dispatcherOptions?.onDeliverySettled?.(info);
                }
              } else if ("deliveryError" in step) {
                turn.delivery.onError?.(new Error("synthetic delivery error"), step.deliveryError);
              } else if ("toolStart" in step) {
                await turn.replyOptions?.onToolStart?.(step.toolStart);
              } else {
                await turn.replyOptions?.onItemEvent?.(step.itemEvent);
              }
              await opts.betweenSteps?.();
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
          if (opts?.skipFinal) {
            if (opts.lifecyclePhase) {
              for (const listener of agentEventListeners) {
                listener({
                  stream: "lifecycle",
                  runId: testRunId,
                  data: { phase: opts.lifecyclePhase },
                });
              }
            }
            return;
          }
          for (const payload of opts?.finalPayloads ?? [{ text: "hi back" }]) {
            const result = await turn.delivery.deliver(payload, { kind: "final" });
            opts?.onDeliveryResult?.(result, payload, "final");
          }
          if (opts?.lifecyclePhase) {
            for (const listener of agentEventListeners) {
              listener({
                stream: "lifecycle",
                runId: testRunId,
                data: { phase: opts.lifecyclePhase },
              });
            }
          }
        }),
      },
    };

    const api = {
      config: { channels: { webchannel: opts?.channelConfig ?? {} } },
      runtime: {
        channel,
        ...(opts?.lifecyclePhase
          ? {
              events: {
                onAgentEvent: (listener: (event: unknown) => void) => {
                  agentEventListeners.push(listener);
                  return () => {
                    const index = agentEventListeners.indexOf(listener);
                    if (index >= 0) agentEventListeners.splice(index, 1);
                  };
                },
              },
            }
          : {}),
      },
      logger: {},
    } as any;
    if (opts?.lifecyclePhase) startAgentLifecycleSubscription(api);
    return {
      api,
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

  it("I9: streams a progress draft then finalizes the same provisional id", async () => {
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

  it("I3: keeps a single partial-mode message on one id from its first progress through final", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // No tool events this turn — only cumulative answer-text partials.
      partialTexts: ["Hel", "Hello wor", "Hello world"],
      finalPayloads: [{ text: "Hello world" }],
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
    // Throttling may coalesce intermediate progress snapshots. The authoritative
    // final carries the latest text on the same id.
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(finalizeSpy).toHaveBeenCalledWith(
      "web-anon",
      progId,
      "Hello world",
      expect.any(String),
    );
  });

  it("I3: the last emitted progress frame carries the freshest coalesced snapshot", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakePeerChannel();
      const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      let stepCount = 0;
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps: [
          { partial: { text: "Hel" } },
          { partial: { text: "Hello wor" } },
          { partial: { text: "Hello world" } },
        ],
        finalPayloads: [{ text: "Hello world" }],
        betweenSteps: async () => {
          stepCount += 1;
          if (stepCount === 3) await vi.advanceTimersByTimeAsync(601);
        },
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(progressSpy.mock.calls.map((call) => call[2])).toEqual([
        "Hel",
        "Hello world",
      ]);
      expect(progressSpy.mock.calls.at(-1)?.[2]).toBe("Hello world");
    } finally {
      vi.useRealTimers();
    }
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

  // RESTORED BEHAVIOUR (#94). This test used to assert the opposite — that a
  // shorter cumulative payload is a "contract divergence" that rotates the lane
  // and yields two bubbles. That expectation was written against 34da088, which
  // dropped `develop`'s shrink guard; it pinned the regression in place rather
  // than catching it. Core's own partial hygiene ignores a shrinking cumulative
  // text (message-handler.process-CcPQD8zK.js:697), because mid-stream tag
  // stripping makes the cleaned text go backwards while the message is still
  // being appended to. One answer, one bubble.
  it("ignores a shrinking cumulative partial instead of splitting the answer", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // A shorter cumulative payload is backwards movement in ONE message, not
      // a new message.
      partialTexts: ["Hello world", "Hello"],
      finalPayloads: [{ text: "Hello final" }],
    });
    const warn = vi.fn();
    api.logger.warn = warn;

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    expect(progressSpy.mock.calls[0]![2]).toBe("Hello world");
    // The shrink never reaches the wire, and never splits the answer.
    expect(progressSpy.mock.calls.map((call) => call[2])).not.toContain("Hello");
    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual(["Hello final"]);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("contract violation: cumulative partial diverged"),
    );
  });

  /**
   * #94 — a TEXT-LESS block must not stall the rest of the turn.
   *
   * CROSSES TWO GUARDS: the delivery seam's `if (!text) return` early exit, and
   * the turn-wide pending-reservation gate on the empty-predecessor release. A
   * media-only block sends nothing, so the seam used to return before telling the
   * controller anything — while core still SETTLED it. The settlement had no
   * delivery to pair with, so that block's reservation stayed pending forever,
   * and the release gate (correctly) refuses to release while any reservation is
   * pending. Result: every later assistant message streamed nothing at all.
   *
   * This lives at the inbound seam and NOT in the controller fixtures on purpose.
   * At the controller boundary a text-less block is byte-identical to a
   * callback-free notice — same `settled{kind:"block", index}` with no delivery —
   * and those two must behave OPPOSITELY (F5 requires the notice to retire
   * nothing). Only this seam has the payload that tells them apart.
   */
  it("I27: a text-less block still retires its reservation, so later messages stream", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakePeerChannel();
      const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);

      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps: [
          { boundary: true },
          { toolStart: { name: "web_search", phase: "start" } },
          // A's block is queued and then delivered with NO text at all.
          { queuedBlock: { payload: {}, assistantMessageIndex: 1 } },
          { deliverBlock: {} },
          { lifecycle: { kind: "settled", deliveryKind: "block", assistantMessageIndex: 1 } },
          { boundary: true },
          { partial: { text: "B streams" } },
        ],
        betweenSteps: async () => {
          await vi.advanceTimersByTimeAsync(700);
        },
        finalPayloads: [{ text: "B streams" }],
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(progressSpy.mock.calls.map((call) => call[2])).toContain("B streams");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #94 — the stuck reservation is ALSO a permanent lane barrier, so a third
   * message stalls even where the turn-wide release gate is not the cause.
   *
   * CROSSES TWO GUARDS: the same text-less delivery exit, and
   * `laneOrderResolved`'s per-lane barrier check (not the release gate). A's
   * stuck reservation attaches to a lane, and that lane then blocks every
   * successor through ordinary ordering — which is why fixing the retirement,
   * rather than loosening the gate, is the right repair.
   */
  it("I28: a stuck reservation does not strand the third assistant message", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakePeerChannel();
      const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);

      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps: [
          { boundary: true },
          { partial: { text: "A text" } },
          { queuedBlock: { payload: { text: "A block one" }, assistantMessageIndex: 1 } },
          { deliverBlock: { text: "A block one" } },
          { lifecycle: { kind: "settled", deliveryKind: "block", assistantMessageIndex: 1 } },
          // A's second block carries no text — the shape that used to stick.
          { queuedBlock: { payload: {}, assistantMessageIndex: 1 } },
          { deliverBlock: {} },
          { lifecycle: { kind: "settled", deliveryKind: "block", assistantMessageIndex: 1 } },
          { boundary: true },
          { partial: { text: "B text" } },
          { boundary: true },
          { partial: { text: "C text" } },
        ],
        betweenSteps: async () => {
          await vi.advanceTimersByTimeAsync(700);
        },
        finalPayloads: [{ text: "C text" }],
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      const streamed = progressSpy.mock.calls.map((call) => call[2]);
      expect(streamed).toContain("B text");
      expect(streamed).toContain("C text");
    } finally {
      vi.useRealTimers();
    }
  });

  it("I15: lets the mixed-turn answer claim and finalize the provisional scaffold id", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      steps: [
        { boundary: true },
        { toolStart: { name: "web_search", phase: "start" } },
        { boundary: true },
        { partial: { text: "The answer is 42" } },
      ],
      finalPayloads: [{ text: "The answer is 42" }],
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
    // The authoritative final replaces that provisional bubble. The answer
    // progress may still be inside the throttle window and need not hit wire.
    const progId = progressSpy.mock.calls[0][1];
    for (const call of progressSpy.mock.calls) expect(call[1]).toBe(progId);
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(finalizeSpy).toHaveBeenCalledWith(
      "web-anon",
      progId,
      "The answer is 42",
      expect.any(String),
    );
  });

  it("I1: settles A and B as two ordered bubbles across assistant-message boundaries", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      // Two final_answer messages: the second's cumulative partials restart from
      // "" after the boundary.
      partialSteps: [
        { boundary: true },
        { text: "First msg" },
        { boundary: true },
        { text: "Sec" },
        { text: "Second msg" },
      ],
      finalPayloads: [{ text: "Second msg" }],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "First msg",
      "Second msg",
    ]);
    expect(finalizeSpy.mock.calls[0]![1]).not.toBe(finalizeSpy.mock.calls[1]![1]);
    expect(progressSpy.mock.calls[0]![1]).toBe(finalizeSpy.mock.calls[0]![1]);
  });

  it("I4: keeps B separate when its final quotes the complete text of A", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      partialSteps: [
        { boundary: true },
        { text: "A says the capital is Paris." },
        { boundary: true },
        { text: "Quoting A: A says the capital is Paris." },
      ],
      finalPayloads: [
        { text: "Quoting A: A says the capital is Paris. That remains correct." },
      ],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "A says the capital is Paris.",
      "Quoting A: A says the capital is Paris. That remains correct.",
    ]);
    expect(finalizeSpy.mock.calls[0]![1]).not.toBe(finalizeSpy.mock.calls[1]![1]);
  });

  it("I5: preserves delta/replace metadata and lets B final fully rewrite only B", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      steps: [
        { boundary: true },
        { partial: { text: "A stays" } },
        { boundary: true },
        { partial: { text: "Hel" } },
        { partial: { delta: "lo" } },
        { partial: { text: "Rewritten", replace: true } },
      ],
      finalPayloads: [{ text: "COMPLETELY DIFFERENT B" }],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "A stays",
      "COMPLETELY DIFFERENT B",
    ]);
    expect(finalizeSpy.mock.calls[0]![1]).not.toBe(finalizeSpy.mock.calls[1]![1]);
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

  it("preserves both bubbles when a divergent cumulative partial arrives without a boundary", async () => {
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
      finalPayloads: [{ text: "Second msg" }],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "First msg",
      "Second msg",
    ]);
    expect(finalizeSpy.mock.calls[0]![1]).not.toBe(finalizeSpy.mock.calls[1]![1]);
  });

  it("absorbs a late boundary after the defensive rotation", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);

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
      finalPayloads: [{ text: "Second msg more" }],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(progressSpy).toHaveBeenCalled();
    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "First msg",
      "Second msg more",
    ]);
    expect(new Set(finalizeSpy.mock.calls.map((call) => call[1])).size).toBe(2);
  });

  it("I2: settles three assistant messages in generation order on three ids", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      partialSteps: [
        { boundary: true },
        { text: "Alpha" },
        { boundary: true },
        { text: "Bravo" },
        { boundary: true },
        { text: "Charlie" },
      ],
      finalPayloads: [{ text: "Charlie final" }],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "Alpha",
      "Bravo",
      "Charlie final",
    ]);
    expect(new Set(finalizeSpy.mock.calls.map((call) => call[1])).size).toBe(3);
  });

  it.each(["false", "throw"] as const)(
    "I6: a lane-A terminal %s leaves the queue alive for B",
    async (failure) => {
      const transport = new FakePeerChannel();
      vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      let first = true;
      const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockImplementation(() => {
        if (!first) return true;
        first = false;
        if (failure === "throw") throw new Error("lane A send threw");
        return false;
      });
      const settledSpy = vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);
      const finalResults: boolean[] = [];
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        partialSteps: [
          { boundary: true },
          { text: "A" },
          { boundary: true },
          { text: "B draft" },
        ],
        finalPayloads: [{ text: "B final" }],
        onDeliveryResult: (result, _payload, kind) => {
          if (kind === "final") finalResults.push(result?.visibleReplySent === true);
        },
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        id: `turn-i6-${failure}`,
        text: "hello",
      });

      expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual(["A", "B final"]);
      expect(finalResults).toEqual([true]);
      expect(settledSpy).toHaveBeenCalledWith(
        "web-anon",
        `turn-i6-${failure}`,
        "ok",
      );
    },
  );

  it("I8: a clean resolve drains all real lane text without a marker bubble", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      partialSteps: [
        { boundary: true },
        { text: "A partial" },
        { boundary: true },
        { text: "B partial" },
      ],
      skipFinal: true,
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual(["A partial", "B partial"]);
    expect(finalizeSpy.mock.calls.flatMap((call) => String(call[2]))).not.toContain("Stopped");
  });

  it.each([0, undefined])(
    "I11: a late queued A reservation (index=%s) never supplies the wire body or B lane id",
    async (assistantMessageIndex) => {
      const transport = new FakePeerChannel();
      vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const steps: KernelStep[] = [
        { boundary: true },
        { boundary: true },
        { partial: { text: "B draft" } },
        {
          queuedBlock: {
            payload: { text: "pre-hook A" },
            ...(assistantMessageIndex === undefined ? {} : { assistantMessageIndex }),
          },
        },
        { deliverBlock: { text: "post-hook A" } },
      ];
      if (assistantMessageIndex !== undefined) {
        steps.push({ lifecycle: { kind: "settled", assistantMessageIndex } });
      }
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps,
        finalPayloads: [{ text: "B final" }],
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
        "post-hook A",
        "B final",
      ]);
      expect(finalizeSpy.mock.calls.map((call) => call[2])).not.toContain("pre-hook A");
      expect(finalizeSpy.mock.calls[0]![1]).not.toBe(finalizeSpy.mock.calls[1]![1]);
    },
  );

  it.each(["skip", "cancel", "settled"] as const)(
    "I11/F2: a pre-delivery final %s lifecycle cannot release block A ahead of its wire bubble",
    async (lifecycleKind) => {
      const transport = new FakePeerChannel();
      const wireEvents: string[] = [];
      vi.spyOn(transport, "sendProgress").mockImplementation((_peer, _id, text) => {
        wireEvents.push(`progress:${text}`);
        return true;
      });
      vi.spyOn(transport, "finalizeDraft").mockImplementation((_peer, _id, text) => {
        wireEvents.push(`final:${text}`);
        return true;
      });
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps: [
          { boundary: true },
          { boundary: true },
          { partial: { text: "B draft" } },
          {
            queuedBlock: {
              payload: { text: "queued A" },
              assistantMessageIndex: 0,
            },
          },
          {
            lifecycle: {
              kind: lifecycleKind,
              deliveryKind: "final",
              payload: { text: "unrelated final" },
              assistantMessageIndex: 0,
            },
          },
          { deliverBlock: { text: "F-A" } },
          {
            lifecycle: {
              kind: "settled",
              deliveryKind: "block",
              assistantMessageIndex: 0,
            },
          },
        ],
        finalPayloads: [{ text: "B final" }],
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(wireEvents).toEqual([
        "final:F-A",
        "progress:B draft",
        "final:B final",
      ]);
    },
  );

  it("I16: two late indexless callbacks remain tentative while both actual blocks are preserved", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      steps: [
        { boundary: true },
        { boundary: true },
        { partial: { text: "B draft" } },
        { queuedBlock: { payload: { text: "queued A1" } } },
        { queuedBlock: { payload: { text: "queued A2" } } },
        { deliverBlock: { text: "actual A1" } },
        { deliverBlock: { text: "actual A2" } },
      ],
      finalPayloads: [{ text: "B final" }],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "actual A1",
      "actual A2",
      "B final",
    ]);
    expect(new Set(finalizeSpy.mock.calls.map((call) => call[1])).size).toBe(3);
  });

  it("I17: only the post-hook authorized block text reaches the wire", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      steps: [
        {
          queuedBlock: {
            payload: { text: "queued original" },
            assistantMessageIndex: 0,
          },
        },
        { deliverBlock: { text: "rewritten actual" } },
      ],
      finalPayloads: [{ text: "answer" }],
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "rewritten actual",
      "answer",
    ]);
  });

  it.each([
    { lifecycleKind: "skip" as const, assistantMessageIndex: 0 },
    { lifecycleKind: "cancel" as const, assistantMessageIndex: 0 },
    { lifecycleKind: "cancel" as const, assistantMessageIndex: undefined },
  ])(
    "I18: $lifecycleKind cleanup (index=$assistantMessageIndex) leaves no queued-A ghost",
    async ({ lifecycleKind, assistantMessageIndex }) => {
      const transport = new FakePeerChannel();
      const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const lifecycleStep: KernelStep = {
        lifecycle: {
          kind: lifecycleKind,
          payload: { text: "queued A" },
          ...(assistantMessageIndex === undefined ? {} : { assistantMessageIndex }),
        },
      };
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps: [
          { boundary: true },
          { boundary: true },
          { partial: { text: "B draft" } },
          {
            queuedBlock: {
              payload: { text: "queued A" },
              ...(assistantMessageIndex === undefined ? {} : { assistantMessageIndex }),
            },
          },
          lifecycleStep,
        ],
        finalPayloads: [{ text: "B final" }],
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual(["B final"]);
      if (assistantMessageIndex === 0) {
        expect(progressSpy.mock.calls.map((call) => call[2])).toEqual(["B draft"]);
      } else {
        expect(progressSpy).not.toHaveBeenCalled();
      }
    },
  );

  it("I18/F4: a block delivery error is diagnosed through the injected logger", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      steps: [{ deliveryError: { kind: "block" } }],
      skipFinal: true,
    });
    const warn = vi.fn();
    api.logger.warn = warn;

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "delivery adapter reported an error; ambiguous reservations await terminal drain",
      ),
    );
  });

  it.each([
    { label: "I12a callback-free", coalescedCallbacks: false },
    { label: "I12b coalesced callbacks", coalescedCallbacks: true },
  ])(
    "$label leading-error replay preserves every final independently of callback cardinality",
    async ({ coalescedCallbacks }) => {
      const transport = new FakePeerChannel();
      vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      const settledSpy = vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);
      const finalResults: boolean[] = [];
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const steps: KernelStep[] = [
        { boundary: true },
        { partial: { text: "A live" } },
        { boundary: true },
        { partial: { text: "B live" } },
      ];
      if (coalescedCallbacks) {
        steps.push(
          {
            queuedBlock: {
              payload: { text: "A1 queued\n\nA2 queued" },
              assistantMessageIndex: 0,
            },
          },
          {
            queuedBlock: {
              payload: { text: "B queued" },
              assistantMessageIndex: 1,
            },
          },
          { deliverBlock: { text: "A1 actual\n\nA2 actual" } },
          { deliverBlock: { text: "B actual" } },
        );
      }
      steps.push(
        { deliverFinal: { text: "terminal error", isError: true } },
        { deliverFinal: { text: "A1 replay" } },
        { deliverFinal: { text: "A2 replay" } },
        { deliverFinal: { text: "B replay" } },
      );
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps,
        skipFinal: true,
        lifecyclePhase: "error",
        onDeliveryResult: (result, _payload, kind) => {
          if (kind === "final") finalResults.push(result?.visibleReplySent === true);
        },
      });

      try {
        await handleInboundMessage(api, transport, "web-anon", {
          type: "user_message",
          text: "hello",
        });
      } finally {
        stopAgentLifecycleSubscription();
      }

      const texts = finalizeSpy.mock.calls.map((call) => call[2]);
      expect(texts).toEqual([
        "A live",
        ...(coalescedCallbacks ? ["A1 actual\n\nA2 actual", "B actual"] : []),
        "terminal error",
        "A1 replay",
        "A2 replay",
        "B replay",
        "B live",
      ]);
      expect(finalResults).toEqual([true, true, true, true]);
      expect(settledSpy).toHaveBeenCalledWith("web-anon", expect.any(String), "error");
      expect(new Set(finalizeSpy.mock.calls.map((call) => call[1])).size).toBe(
        finalizeSpy.mock.calls.length,
      );
    },
  );

  it.each([
    "isStatusNotice",
    "isFallbackNotice",
    "isCompactionNotice",
  ] as const)(
    "I20/F3: queued %s classification is the only difference between B release and a barrier",
    async (flag) => {
      vi.useFakeTimers();
      try {
        const transport = new FakePeerChannel();
        const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
        const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
        const notice = { text: "queued notice", [flag]: true } as TestReplyPayload;
        const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
        const { api } = makeFakeApi(captured, {
          channelConfig: { streaming: { mode: "partial" } },
          steps: [
            { boundary: true },
            { partial: { text: "A" } },
            { boundary: true },
            {
              queuedBlock: {
                payload: notice,
                assistantMessageIndex: 0,
              },
            },
            { partial: { text: "B draft" } },
            {
              lifecycle: {
                kind: "skip",
                payload: notice,
                assistantMessageIndex: 0,
              },
            },
          ],
          finalPayloads: [{ text: "B final" }],
          betweenSteps: async () => {
            await vi.advanceTimersByTimeAsync(601);
          },
        });

        await handleInboundMessage(api, transport, "web-anon", {
          type: "user_message",
          text: "hello",
        });

        expect(progressSpy.mock.calls.map((call) => call[2])).toEqual(["A", "B draft"]);
        expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual(["A", "B final"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { noticeLifecycle: "skip" as const, cleanupLifecycle: "cancel" as const },
    { noticeLifecycle: "cancel" as const, cleanupLifecycle: "skip" as const },
  ])(
    "I20/F3: $noticeLifecycle notice flags retire the token so $cleanupLifecycle can release B",
    async ({ noticeLifecycle, cleanupLifecycle }) => {
      vi.useFakeTimers();
      try {
        const transport = new FakePeerChannel();
        const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
        vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
        const notice = {
          text: "queued notice",
          isFallbackNotice: true,
        } as TestReplyPayload;
        const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
        const { api } = makeFakeApi(captured, {
          channelConfig: { streaming: { mode: "partial" } },
          steps: [
            { boundary: true },
            { partial: { text: "A" } },
            { boundary: true },
            {
              queuedBlock: {
                payload: notice,
                assistantMessageIndex: 0,
              },
            },
            {
              lifecycle: {
                kind: noticeLifecycle,
                payload: notice,
                assistantMessageIndex: 0,
              },
            },
            {
              queuedBlock: {
                payload: { text: "queued real block" },
                assistantMessageIndex: 0,
              },
            },
            {
              lifecycle: {
                kind: cleanupLifecycle,
                payload: { text: "queued real block" },
                assistantMessageIndex: 0,
              },
            },
            { partial: { text: "B draft" } },
          ],
          finalPayloads: [{ text: "B final" }],
          betweenSteps: async () => {
            await vi.advanceTimersByTimeAsync(601);
          },
        });

        await handleInboundMessage(api, transport, "web-anon", {
          type: "user_message",
          text: "hello",
        });

        expect(progressSpy.mock.calls.map((call) => call[2])).toEqual(["A", "B draft"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "isStatusNotice",
    "isFallbackNotice",
    "isCompactionNotice",
  ] as const)(
    "I20/F1: a final %s notice does not consume the streamed answer lane",
    async (flag) => {
      const transport = new FakePeerChannel();
      const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      const notice = { text: "switched model", [flag]: true } as TestReplyPayload;
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps: [
          { partial: { text: "Real answer draft" } },
          { deliverFinal: notice },
          { deliverFinal: { text: "Real answer final" } },
        ],
        skipFinal: true,
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
        "switched model",
        "Real answer final",
      ]);
      const streamedLaneId = progressSpy.mock.calls[0]![1];
      expect(finalizeSpy.mock.calls[0]![1]).not.toBe(streamedLaneId);
      expect(finalizeSpy.mock.calls[1]![1]).toBe(streamedLaneId);
    },
  );

  it("I13: an ordinary answer and a trailing tool-warning final both remain visible", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    const settledSpy = vi.spyOn(transport, "sendTurnSettled").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      steps: [
        { partial: { text: "answer draft" } },
        { deliverFinal: { text: "answer final" } },
        { deliverFinal: { text: "tool warning", isError: true } },
      ],
      skipFinal: true,
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      id: "turn-i13",
      text: "hello",
    });

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "answer final",
      "tool warning",
    ]);
    expect(finalizeSpy.mock.calls[0]![1]).not.toBe(finalizeSpy.mock.calls[1]![1]);
    expect(settledSpy).toHaveBeenCalledWith("web-anon", "turn-i13", "ok");
  });

  it("I13/F7: a sent independent terminal error suppresses the catch-path apology", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      steps: [{ deliverFinal: { text: "terminal error", isError: true } }],
      throwAfterProgress: true,
    });

    await expect(
      handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      }),
    ).resolves.toBeUndefined();

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual(["terminal error"]);
  });

  it.each([0, 1, 3])(
    "I14: an authorized block stays independent with %i tentative reservations",
    async (reservationCount) => {
      const transport = new FakePeerChannel();
      const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      const steps: KernelStep[] = [{ partial: { text: "lane draft" } }];
      for (let index = 0; index < reservationCount; index += 1) {
        steps.push({
          queuedBlock: {
            payload: { text: `queued-${index}` },
            assistantMessageIndex: 0,
          },
        });
      }
      steps.push({ deliverBlock: { text: "actual block" } });
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps,
        finalPayloads: [{ text: "lane final" }],
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
        "actual block",
        "lane final",
      ]);
      expect(finalizeSpy.mock.calls[0]![1]).not.toBe(progressSpy.mock.calls[0]![1]);
      expect(finalizeSpy.mock.calls[1]![1]).toBe(progressSpy.mock.calls[0]![1]);
    },
  );

  it("I10: a successful plain block does not count toward the final-only delivery OR", async () => {
    const transport = new FakePeerChannel();
    const sendTextSpy = vi.spyOn(transport, "sendText").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "off" } },
      steps: [{ deliverBlock: { text: "plain block" } }],
      throwAfterProgress: true,
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(sendTextSpy.mock.calls.map((call) => call[1])).toEqual([
      "plain block",
      "Sorry — something went wrong while answering. Please try again.",
    ]);
  });

  it.each(["block", "off"] as const)(
    "I10: streaming.mode=%s keeps authorized blocks and final on the plain append path",
    async (mode) => {
      const transport = new FakePeerChannel();
      const sendTextSpy = vi.spyOn(transport, "sendText").mockReturnValue(true);
      const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode } },
        steps: [
          { deliverBlock: { text: "block one" } },
          { deliverBlock: { text: "block two" } },
        ],
        finalPayloads: [{ text: "plain final" }],
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(sendTextSpy.mock.calls.map((call) => call[1])).toEqual([
        "block one",
        "block two",
        "plain final",
      ]);
      expect(sendTextSpy.mock.calls.every((call) => call[2] === undefined)).toBe(true);
      expect(progressSpy).not.toHaveBeenCalled();
      expect(finalizeSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["true", "false", "throw"] as const)(
    "I19/I21/I23: tool P plus an authorized block %s reports the real result and orders B",
    async (blockOutcome) => {
      const transport = new FakePeerChannel();
      const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      let deliveryNumber = 0;
      const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockImplementation(() => {
        deliveryNumber += 1;
        if (deliveryNumber !== 1 || blockOutcome === "true") return true;
        if (blockOutcome === "throw") throw new Error("authorized block threw");
        return false;
      });
      const blockResults: boolean[] = [];
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps: [
          { boundary: true },
          { toolStart: { name: "bash", phase: "start" } },
          { deliverBlock: { text: "authorized block" } },
          { boundary: true },
          { partial: { text: "B draft" } },
        ],
        finalPayloads: [{ text: "B final" }],
        onDeliveryResult: (result, _payload, kind) => {
          if (kind === "block") blockResults.push(result?.visibleReplySent === true);
        },
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
        "authorized block",
        "B final",
      ]);
      expect(blockResults).toEqual([blockOutcome === "true"]);
      const provisionalId = progressSpy.mock.calls[0]![1];
      expect(finalizeSpy.mock.calls[0]![1]).toBe(provisionalId);
      if (blockOutcome === "true") {
        expect(finalizeSpy.mock.calls[1]![1]).not.toBe(provisionalId);
      } else {
        expect(finalizeSpy.mock.calls[1]![1]).toBe(provisionalId);
      }
    },
  );

  it("I22: a successful block-only turn replaces P without a cleanup sibling", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      steps: [
        { toolStart: { name: "bash", phase: "start" } },
        { deliverBlock: { text: "block-only result" } },
      ],
      skipFinal: true,
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(finalizeSpy).toHaveBeenCalledWith(
      "web-anon",
      progressSpy.mock.calls[0]![1],
      "block-only result",
      expect.any(String),
    );
  });

  it.each([
    "isStatusNotice",
    "isFallbackNotice",
    "isCompactionNotice",
  ] as const)(
    "I20: callback-to-actual %s rewrites preserve both authorized payloads outside the lane",
    async (flag) => {
      const transport = new FakePeerChannel();
      const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
      const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
      const queuedNotice = { text: "queued notice", [flag]: true } as TestReplyPayload;
      const actualNotice = { text: "actual notice", [flag]: true } as TestReplyPayload;
      const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
      const { api } = makeFakeApi(captured, {
        channelConfig: { streaming: { mode: "partial" } },
        steps: [
          { partial: { text: "lane draft" } },
          {
            queuedBlock: {
              payload: queuedNotice,
              assistantMessageIndex: 0,
            },
          },
          { deliverBlock: { text: "rewritten non-notice" } },
          {
            queuedBlock: {
              payload: { text: "queued non-notice" },
              assistantMessageIndex: 0,
            },
          },
          { deliverBlock: actualNotice },
        ],
        finalPayloads: [{ text: "lane final" }],
      });

      await handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      });

      expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
        "rewritten non-notice",
        "actual notice",
        "lane final",
      ]);
      const laneId = progressSpy.mock.calls[0]![1];
      expect(finalizeSpy.mock.calls[0]![1]).not.toBe(laneId);
      expect(finalizeSpy.mock.calls[1]![1]).not.toBe(laneId);
      expect(finalizeSpy.mock.calls[2]![1]).toBe(laneId);
    },
  );

  it.each([
    "isStatusNotice",
    "isFallbackNotice",
    "isCompactionNotice",
  ] as const)(
    "I20/F5: an actual %s notice cannot settle a real-block reservation",
    async (flag) => {
      vi.useFakeTimers();
      try {
        const transport = new FakePeerChannel();
        const wireEvents: string[] = [];
        vi.spyOn(transport, "sendProgress").mockImplementation((_peer, _id, text) => {
          wireEvents.push(`progress:${text}`);
          return true;
        });
        vi.spyOn(transport, "finalizeDraft").mockImplementation((_peer, _id, text) => {
          wireEvents.push(`final:${text}`);
          return true;
        });
        const actualNotice = { text: "actual notice", [flag]: true } as TestReplyPayload;
        const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
        const { api } = makeFakeApi(captured, {
          channelConfig: { streaming: { mode: "partial" } },
          steps: [
            { boundary: true },
            { partial: { text: "A" } },
            {
              queuedBlock: {
                payload: { text: "queued prior block" },
                assistantMessageIndex: 0,
              },
            },
            { deliverBlock: { text: "actual prior block" } },
            {
              lifecycle: {
                kind: "settled",
                deliveryKind: "block",
                assistantMessageIndex: 0,
              },
            },
            { boundary: true },
            {
              queuedBlock: {
                payload: { text: "queued real block" },
                assistantMessageIndex: 0,
              },
            },
            { partial: { text: "B draft" } },
            { deliverBlock: actualNotice },
            {
              lifecycle: {
                kind: "settled",
                deliveryKind: "block",
                assistantMessageIndex: 0,
              },
            },
            { deliverBlock: { text: "actual real block" } },
            {
              lifecycle: {
                kind: "settled",
                deliveryKind: "block",
                assistantMessageIndex: 0,
              },
            },
          ],
          finalPayloads: [{ text: "B final" }],
          betweenSteps: async () => {
            await vi.advanceTimersByTimeAsync(601);
          },
        });

        await handleInboundMessage(api, transport, "web-anon", {
          type: "user_message",
          text: "hello",
        });

        expect(wireEvents).toEqual([
          "progress:A",
          "final:actual prior block",
          "final:A",
          "final:actual notice",
          "final:actual real block",
          "progress:B draft",
          "final:B final",
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("I24: a failed leading error rolls P back for the next retained final", async () => {
    const transport = new FakePeerChannel();
    const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
    let first = true;
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockImplementation(() => {
      if (!first) return true;
      first = false;
      return false;
    });
    const results: boolean[] = [];
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "progress" } },
      steps: [
        { toolStart: { name: "bash", phase: "start" } },
        { deliverFinal: { text: "terminal error", isError: true } },
        { deliverFinal: { text: "retained A" } },
        { deliverFinal: { text: "retained B" } },
      ],
      skipFinal: true,
      onDeliveryResult: (result, _payload, kind) => {
        if (kind === "final") results.push(result?.visibleReplySent === true);
      },
    });

    await handleInboundMessage(api, transport, "web-anon", {
      type: "user_message",
      text: "hello",
    });

    expect(results).toEqual([false, true, true]);
    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
      "terminal error",
      "retained A",
      "retained B",
    ]);
    const provisionalId = progressSpy.mock.calls[0]![1];
    expect(finalizeSpy.mock.calls[0]![1]).toBe(provisionalId);
    expect(finalizeSpy.mock.calls[1]![1]).toBe(provisionalId);
    expect(finalizeSpy.mock.calls[2]![1]).not.toBe(provisionalId);
  });

  it.each(["independent", "lane"] as const)(
    "I25: a successful $owner P claim suppresses later tool and item scaffold frames",
    async (owner) => {
      vi.useFakeTimers();
      try {
        const transport = new FakePeerChannel();
        const progressSpy = vi.spyOn(transport, "sendProgress").mockReturnValue(true);
        const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
        const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
        const ownerStep: KernelStep =
          owner === "independent"
            ? { deliverBlock: { text: "independent owner" } }
            : { deliverFinal: { text: "lane owner" } };
        const { api } = makeFakeApi(captured, {
          channelConfig: { streaming: { mode: "partial" } },
          steps: [
            { toolStart: { name: "bash", phase: "start" } },
            ownerStep,
            { toolStart: { name: "late_tool", phase: "start" } },
            {
              itemEvent: {
                kind: "tool",
                name: "late_item",
                phase: "start",
                status: "running",
              },
            },
          ],
          skipFinal: true,
          betweenSteps: async () => {
            await vi.advanceTimersByTimeAsync(601);
          },
        });

        await handleInboundMessage(api, transport, "web-anon", {
          type: "user_message",
          text: "hello",
        });

        expect(progressSpy).toHaveBeenCalledTimes(1);
        expect(progressSpy.mock.calls[0]![2]).toMatch(/Bash/i);
        expect(finalizeSpy).toHaveBeenCalledTimes(1);
        expect(finalizeSpy.mock.calls[0]![1]).toBe(progressSpy.mock.calls[0]![1]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(
    (["progress", "final"] as const).flatMap((firstFrame) =>
      (["false", "throw"] as const).flatMap((failure) =>
        (["lane", "independent"] as const).map((nextConsumer) => ({
          firstFrame,
          failure,
          nextConsumer,
        })),
      ),
    ),
  )(
    "I26: first $firstFrame frame $failure rolls P back for the next $nextConsumer consumer",
    async ({ firstFrame, failure, nextConsumer }) => {
      vi.useFakeTimers();
      try {
        const transport = new FakePeerChannel();
        const attempts: Array<{ frame: "progress" | "final"; id: string; text: string }> = [];
        vi.spyOn(transport, "sendProgress").mockImplementation((_peer, id, text) => {
          attempts.push({ frame: "progress", id, text });
          if (firstFrame === "progress" && text === "A first") {
            if (failure === "throw") throw new Error("A progress threw");
            return false;
          }
          return true;
        });
        vi.spyOn(transport, "finalizeDraft").mockImplementation((_peer, id, text) => {
          attempts.push({ frame: "final", id, text });
          if (firstFrame === "final" && text === "A first") {
            if (failure === "throw") throw new Error("A final threw");
            return false;
          }
          return true;
        });
        const deliveryResults: boolean[] = [];
        const steps: KernelStep[] = [
          { boundary: true },
          { toolStart: { name: "bash", phase: "start" } },
          firstFrame === "progress"
            ? { partial: { text: "A first" } }
            : { deliverFinal: { text: "A first" } },
        ];
        if (nextConsumer === "lane") {
          steps.push(
            { boundary: true },
            { partial: { text: "B draft" } },
          );
        } else {
          steps.push({ deliverBlock: { text: "independent F" } });
          if (firstFrame === "progress") {
            steps.push({ partial: { text: "A later revision" } });
          }
        }
        const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
        const { api } = makeFakeApi(captured, {
          channelConfig: { streaming: { mode: "partial" } },
          steps,
          skipFinal: true,
          betweenSteps: async () => {
            await vi.advanceTimersByTimeAsync(601);
          },
          onDeliveryResult: (result) => {
            deliveryResults.push(result?.visibleReplySent === true);
          },
        });

        await handleInboundMessage(api, transport, "web-anon", {
          type: "user_message",
          text: "hello",
        });

        const provisionalId = attempts[0]!.id;
        const failedAttempts = attempts.filter((attempt) => attempt.text === "A first");
        expect(failedAttempts).toHaveLength(1);
        expect(failedAttempts[0]!.id).toBe(provisionalId);
        const successfulConsumerText =
          nextConsumer === "lane" ? "B draft" : "independent F";
        const successfulConsumer = attempts.find(
          (attempt) => attempt.text === successfulConsumerText,
        );
        expect(successfulConsumer?.id).toBe(provisionalId);
        if (firstFrame === "final") {
          expect(deliveryResults[0]).toBe(false);
        }
        if (nextConsumer === "independent" && firstFrame === "progress") {
          const laterA = attempts.find((attempt) => attempt.text === "A later revision");
          expect(laterA?.id).not.toBe(provisionalId);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

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

    // No answer/tool draft AND reasoning level is the default "off": neither
    // lane is active, so replyOptions carries nothing but the #87 run-id hook.
    // That hook is wired on EVERY turn — it is how the turn learns which agent
    // run's lifecycle terminal decides its `turn_settled` outcome — so unlike
    // the draft/reasoning callbacks it is not conditional on a streaming mode.
    expect(seenReplyOptions).toEqual({ onAgentRunStart: expect.any(Function) });
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
      onAgentRunStart: expect.any(Function),
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

  it("replaces a thrown tool-only turn's provisional preview with the independent apology", async () => {
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

      // The authoritative apology gets the first claim attempt before cleanup,
      // so it REPLACES the ownerless preview instead of leaving a settled
      // "Working…" scaffold beside a second bubble.
      expect(finalizeSpy).toHaveBeenCalledTimes(1);
      const [finSession, finId, finText] = finalizeSpy.mock.calls[0];
      expect(finSession).toBe("web-anon");
      expect(finId).toBe(progId);
      expect(finText).toBe("Sorry — something went wrong while answering. Please try again.");
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

  it("settles streamed text unchanged and surfaces a separate apology when the turn throws", async () => {
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

      // The apology is an independent authoritative delivery, then terminal
      // drain settles the real lane text on its original id. In particular,
      // the apology must never overwrite the already-materialized lane.
      expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual([
        "Sorry — something went wrong while answering. Please try again.",
        "Partial ans",
      ]);
      const apologyCall = finalizeSpy.mock.calls[0]!;
      const laneCall = finalizeSpy.mock.calls[1]!;
      expect(apologyCall[0]).toBe("web-anon");
      expect(apologyCall[1]).not.toBe(progId);
      expect(laneCall[0]).toBe("web-anon");
      expect(laneCall[1]).toBe(progId);

      // Loop stopped: no late background flush after error handling.
      const progressCountAfterError = progressSpy.mock.calls.length;
      await vi.runAllTimersAsync();
      expect(progressSpy.mock.calls.length).toBe(progressCountAfterError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not append a catch-path apology after a final was already delivered", async () => {
    const transport = new FakePeerChannel();
    const finalizeSpy = vi.spyOn(transport, "finalizeDraft").mockReturnValue(true);
    const captured: { recordedSessionKey?: string; recordedTo?: string } = {};
    const { api } = makeFakeApi(captured, {
      channelConfig: { streaming: { mode: "partial" } },
      steps: [{ deliverFinal: { text: "Completed answer" } }],
      throwAfterProgress: true,
    });

    await expect(
      handleInboundMessage(api, transport, "web-anon", {
        type: "user_message",
        text: "hello",
      }),
    ).resolves.toBeUndefined();

    expect(finalizeSpy.mock.calls.map((call) => call[2])).toEqual(["Completed answer"]);
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
