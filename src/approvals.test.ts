import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the unified gateway resolver so we can assert how a widget button click
// is forwarded WITHOUT a live gateway. We re-export everything else (the real
// `createChannelApprovalNativeRuntimeAdapter`, view types, etc.) so the native
// runtime spec is built and exercised for real.
const { resolveApprovalOverGateway } = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/approval-handler-runtime", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("openclaw/plugin-sdk/approval-handler-runtime")
  >();
  return { ...actual, resolveApprovalOverGateway };
});

import { ClawChannelTransport } from "./transport.js";
import type { ApprovalRequestPayload } from "./transport.js";
import {
  createClawApprovalNativeRuntimeSpec,
  createClawApprovalCapability,
  createClawApprovalNativeAdapter,
  buildApprovalRequestPayload,
  handleApprovalDecision,
  startClawApprovalMonitor,
  shouldSuppressClawNativeExecApprovalPrompt,
} from "./approvals.js";

// A minimal valid pending exec approval view (the shape core hands to
// `presentation.buildPendingPayload`). Verified fields:
// dist/plugin-sdk/approval-handler-runtime-types-CL_Nb7hO.d.ts:258-286 (base +
// exec pending) and :246-252 (ApprovalActionView).
function fakePendingExecView(id = "exec-1"): any {
  return {
    approvalId: id,
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    metadata: [],
    commandText: "rm -rf /tmp/cache",
    commandPreview: "rm -rf /tmp/cache",
    expiresAtMs: Date.now() + 60_000,
    actions: [
      { decision: "allow-once", label: "Allow Once", style: "success", command: "/approve once" },
      { decision: "allow-always", label: "Allow Always", style: "primary", command: "/approve always" },
      { decision: "deny", label: "Deny", style: "danger", command: "/approve deny" },
    ],
  };
}

const cfgEnabled: any = {
  channels: { clawchannel: { execApprovals: { enabled: true } } },
};

describe("clawchannel approval payload projection", () => {
  it("forwards only the offered decisions and drops command text", () => {
    const payload = buildApprovalRequestPayload(fakePendingExecView());
    expect(payload.id).toBe("exec-1");
    expect(payload.kind).toBe("exec");
    expect(payload.options.map((o) => o.decision)).toEqual([
      "allow-once",
      "allow-always",
      "deny",
    ]);
    // The synthesized `/approve …` command must NOT leak into the WS payload.
    for (const opt of payload.options) {
      expect(opt).not.toHaveProperty("command");
    }
    // Prompt carries a human-readable one-liner including the command preview.
    expect(payload.prompt).toContain("rm -rf /tmp/cache");
  });
});

describe("clawchannel native approval runtime", () => {
  it("emits an approval_request frame with the offered options on delivery", async () => {
    const transport = new ClawChannelTransport();
    const requestSpy = vi
      .spyOn(transport, "sendApprovalRequest")
      .mockReturnValue(true);

    const spec = createClawApprovalNativeRuntimeSpec(transport);
    const view = fakePendingExecView();
    const baseCtx = { cfg: cfgEnabled, accountId: null, context: undefined };

    // availability gates on execApprovals.enabled
    expect(spec.availability.isConfigured(baseCtx as any)).toBe(true);
    expect(
      spec.availability.shouldHandle({ ...baseCtx, request: {} } as any),
    ).toBe(true);

    // Drive presentation -> transport exactly like core's handler does.
    const pendingPayload = (await spec.presentation.buildPendingPayload({
      ...baseCtx,
      request: { id: view.approvalId } as any,
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    })) as ApprovalRequestPayload;

    const prepared = await spec.transport.prepareTarget({
      ...baseCtx,
      plannedTarget: { surface: "origin", target: { to: "web-anon" } } as any,
      request: {} as any,
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    expect(prepared).not.toBeNull();

    const entry = await spec.transport.deliverPending({
      ...baseCtx,
      plannedTarget: {} as any,
      preparedTarget: prepared!.target,
      request: {} as any,
      approvalKind: "exec",
      view,
      pendingPayload,
    });

    // An approval_request frame was emitted with the three offered options.
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [, sentPayload] = requestSpy.mock.calls[0];
    expect(sentPayload.id).toBe("exec-1");
    expect(sentPayload.options.map((o) => o.decision)).toEqual([
      "allow-once",
      "allow-always",
      "deny",
    ]);
    // The pending entry threads the approval id + session for finalization.
    expect(entry).toMatchObject({ approvalId: "exec-1" });
  });

  it("emits an approval_resolved frame when the gateway resolves the approval", async () => {
    const transport = new ClawChannelTransport();
    vi.spyOn(transport, "sendApprovalRequest").mockReturnValue(true);
    const resolvedSpy = vi
      .spyOn(transport, "sendApprovalResolved")
      .mockReturnValue(true);

    const spec = createClawApprovalNativeRuntimeSpec(transport);
    const view = fakePendingExecView();
    const baseCtx = { cfg: cfgEnabled, accountId: null, context: undefined };

    const pendingPayload = (await spec.presentation.buildPendingPayload({
      ...baseCtx,
      request: {} as any,
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    })) as ApprovalRequestPayload;
    const entry = await spec.transport.deliverPending({
      ...baseCtx,
      plannedTarget: {} as any,
      preparedTarget: { sessionKey: "web-anon" },
      request: {} as any,
      approvalKind: "exec",
      view,
      pendingPayload,
    });

    // Resolution: core builds the final action, then drives transport.updateEntry.
    const resolvedView = { ...view, phase: "resolved", decision: "allow-once" };
    const finalAction = await spec.presentation.buildResolvedResult({
      ...baseCtx,
      request: {} as any,
      resolved: { decision: "allow-once" } as any,
      view: resolvedView as any,
      entry: entry!,
    });
    expect(finalAction).toMatchObject({
      kind: "update",
      payload: { decision: "allow-once" },
    });

    await spec.transport.updateEntry!({
      ...baseCtx,
      entry: entry!,
      payload: (finalAction as any).payload,
      phase: "resolved",
    });

    expect(resolvedSpy).toHaveBeenCalledWith("web-anon", "exec-1", "allow-once");
  });
});

describe("clawchannel native approval origin routing (multi-user)", () => {
  // resolveOriginTarget must read the turn source (`turnSourceTo`) so the prompt
  // is routed to the originating peer, not a hardcoded anon key.
  const adapter = createClawApprovalNativeAdapter();

  function execRequest(turnSourceTo?: string, turnSourceChannel?: string): any {
    return {
      id: "exec-1",
      request: { command: "ls", turnSourceTo, turnSourceChannel },
    };
  }

  it("resolves the origin target to the originating peer (turnSourceTo)", () => {
    const target = adapter.resolveOriginTarget!({
      cfg: cfgEnabled,
      accountId: null,
      approvalKind: "exec",
      request: execRequest("peer-alice", "clawchannel"),
    });
    expect(target).toEqual({ to: "peer-alice" });
  });

  it("ignores an approval that originated on a different channel", () => {
    const target = adapter.resolveOriginTarget!({
      cfg: cfgEnabled,
      accountId: null,
      approvalKind: "exec",
      request: execRequest("+15551234", "signal"),
    });
    expect(target).toBeNull();
  });

  it("falls back to the anon peer when no turn source is present", () => {
    const target = adapter.resolveOriginTarget!({
      cfg: cfgEnabled,
      accountId: null,
      approvalKind: "exec",
      request: execRequest(undefined, undefined),
    });
    expect(target).toEqual({ to: "web-anon" });
  });

  it("prepareTarget keys the prompt to the planned per-peer target", async () => {
    const transport = new ClawChannelTransport();
    const spec = createClawApprovalNativeRuntimeSpec(transport);
    const prepared = await spec.transport.prepareTarget({
      cfg: cfgEnabled,
      accountId: null,
      context: undefined,
      plannedTarget: { surface: "origin", target: { to: "peer-bob" } } as any,
      request: {} as any,
      approvalKind: "exec",
      view: fakePendingExecView() as any,
      pendingPayload: {} as any,
    });
    // The prepared session key + dedupeKey are per-peer (bob), so two distinct
    // users never collide and the frame targets bob's socket.
    expect(prepared!.target).toEqual({ sessionKey: "peer-bob" });
    expect(prepared!.dedupeKey).toBe("clawchannel:peer-bob");
  });

  it("delivers the approval_request to the originating peer's socket key", async () => {
    const transport = new ClawChannelTransport();
    const requestSpy = vi
      .spyOn(transport, "sendApprovalRequest")
      .mockReturnValue(true);
    const spec = createClawApprovalNativeRuntimeSpec(transport);
    const view = fakePendingExecView();
    const baseCtx = { cfg: cfgEnabled, accountId: null, context: undefined };

    const pendingPayload = (await spec.presentation.buildPendingPayload({
      ...baseCtx,
      request: { id: view.approvalId } as any,
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    })) as ApprovalRequestPayload;

    const prepared = await spec.transport.prepareTarget({
      ...baseCtx,
      plannedTarget: { surface: "origin", target: { to: "peer-bob" } } as any,
      request: {} as any,
      approvalKind: "exec",
      view,
      pendingPayload,
    });

    await spec.transport.deliverPending({
      ...baseCtx,
      plannedTarget: { surface: "origin", target: { to: "peer-bob" } } as any,
      preparedTarget: prepared!.target,
      request: {} as any,
      approvalKind: "exec",
      view,
      pendingPayload,
    });

    // The frame was sent to bob's session key, NOT the anon default.
    const [sentKey] = requestSpy.mock.calls[0];
    expect(sentKey).toBe("peer-bob");
  });
});

describe("clawchannel native approval bootstrap (Gate 1)", () => {
  // The gateway monitor MUST register an `"approval.native"` runtime context on
  // the context registry handed to it via `ctx.channelRuntime`, scoped to the
  // account id, with the abort signal — otherwise core's approval bootstrap
  // never starts the native handler and delivery falls back to text.
  it("registers the approval.native runtime context from the gateway monitor", async () => {
    const dispose = vi.fn();
    const register = vi.fn((_params: any) => ({ dispose }));
    const abort = new AbortController();

    const ctx: any = {
      cfg: cfgEnabled,
      accountId: "default",
      abortSignal: abort.signal,
      channelRuntime: { runtimeContexts: { register } },
    };

    // startAccount stays alive until abort; run it, then abort to let it settle.
    const monitorPromise = startClawApprovalMonitor(ctx);

    expect(register).toHaveBeenCalledTimes(1);
    const params = register.mock.calls[0][0] as any;
    expect(params.channelId).toBe("clawchannel");
    expect(params.accountId).toBe("default");
    // The capability key MUST be the SDK's "approval.native" constant.
    expect(params.capability).toBe("approval.native");
    // The abort signal is threaded so the lease is torn down on channel stop.
    expect(params.abortSignal).toBe(abort.signal);
    // A context object is supplied (presence is what arms the bootstrap).
    expect(params.context).toBeDefined();

    // The monitor holds the channel open until the gateway aborts the account.
    abort.abort();
    await monitorPromise;
    // On teardown the registration lease is disposed.
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("clawchannel native approval surface state (Gate 2)", () => {
  // The capability must expose getExecInitiatingSurfaceState /
  // getActionAvailabilityState (read at the CAPABILITY level by core's
  // exec-approval-surface resolver) so we count as a native exec approval
  // client, returning "enabled" when approvals are on.
  it("exposes surface-state hooks returning enabled when execApprovals on", () => {
    const transport = new ClawChannelTransport();
    const capability = createClawApprovalCapability(transport) as any;

    expect(typeof capability.getExecInitiatingSurfaceState).toBe("function");
    expect(typeof capability.getActionAvailabilityState).toBe("function");

    expect(
      capability.getExecInitiatingSurfaceState({ cfg: cfgEnabled, action: "approve" }),
    ).toEqual({ kind: "enabled" });
    expect(
      capability.getActionAvailabilityState({
        cfg: cfgEnabled,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "enabled" });
  });

  it("reports disabled surface state when execApprovals are off", () => {
    const transport = new ClawChannelTransport();
    const capability = createClawApprovalCapability(transport) as any;
    const cfgOff: any = {
      channels: { clawchannel: { execApprovals: { enabled: false } } },
    };

    expect(
      capability.getExecInitiatingSurfaceState({ cfg: cfgOff, action: "approve" }),
    ).toEqual({ kind: "disabled" });
  });
});

describe("clawchannel in-band approval text suppression (Gate 2)", () => {
  // A reply payload carrying exec-approval metadata, as core builds for a
  // pending exec approval (channelData.execApproval). getExecApprovalReplyMetadata
  // requires both approvalId + approvalSlug.
  function approvalPendingPayload(): any {
    return {
      text: "Approval required. Run: /approve abc allow-once",
      channelData: {
        execApproval: {
          approvalId: "exec-1",
          approvalSlug: "abc",
          approvalKind: "exec",
        },
      },
    };
  }

  const nativeHint = {
    kind: "approval-pending" as const,
    approvalKind: "exec" as const,
    nativeRouteActive: true,
  };

  it("suppresses the local /approve text when the native route is active", () => {
    expect(
      shouldSuppressClawNativeExecApprovalPrompt({
        cfg: cfgEnabled,
        accountId: "default",
        payload: approvalPendingPayload(),
        hint: nativeHint,
      }),
    ).toBe(true);
  });

  it("does NOT suppress when no native route is active (hint flag false)", () => {
    expect(
      shouldSuppressClawNativeExecApprovalPrompt({
        cfg: cfgEnabled,
        accountId: "default",
        payload: approvalPendingPayload(),
        hint: { ...nativeHint, nativeRouteActive: false },
      }),
    ).toBe(false);
  });

  it("does NOT suppress when execApprovals are disabled", () => {
    const cfgOff: any = {
      channels: { clawchannel: { execApprovals: { enabled: false } } },
    };
    expect(
      shouldSuppressClawNativeExecApprovalPrompt({
        cfg: cfgOff,
        accountId: "default",
        payload: approvalPendingPayload(),
        hint: nativeHint,
      }),
    ).toBe(false);
  });
});

describe("clawchannel approval decision -> gateway", () => {
  beforeEach(() => {
    resolveApprovalOverGateway.mockClear();
  });

  it("resolves the approval over the gateway on a widget button click", async () => {
    await handleApprovalDecision(cfgEnabled, "exec-1", "deny");
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "exec-1",
        decision: "deny",
        allowPluginFallback: true,
      }),
    );
  });

  it("routes an inbound approval_decision frame through the transport handler", () => {
    const transport = new ClawChannelTransport();
    const handler = vi.fn();
    transport.setApprovalDecisionHandler(handler);

    // Reach the private parse path the same way a real ws 'message' would, by
    // invoking the registered listener with a JSON approval_decision frame.
    const fakeWs: any = {
      readyState: 1,
      listeners: {} as Record<string, (data: any) => void>,
      on(event: string, cb: (data: any) => void) {
        this.listeners[event] = cb;
      },
      send: vi.fn(),
    };
    (transport as any).registerConnection(fakeWs);
    fakeWs.listeners.message(
      JSON.stringify({ type: "approval_decision", id: "exec-9", decision: "allow-always" }),
    );
    expect(handler).toHaveBeenCalledWith("web-anon", "exec-9", "allow-always");

    // A malformed decision is ignored (defensive guard).
    handler.mockClear();
    fakeWs.listeners.message(
      JSON.stringify({ type: "approval_decision", id: "exec-9", decision: "bogus" }),
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
