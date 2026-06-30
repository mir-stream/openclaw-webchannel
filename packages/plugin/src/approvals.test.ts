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

import { WebChannelTransport } from "./transport.js";
import type { ApprovalRequestPayload } from "./transport.js";
import {
  createClawApprovalNativeRuntimeSpec,
  createClawApprovalCapability,
  buildApprovalRequestPayload,
  handleApprovalDecision,
  startClawApprovalMonitor,
  shouldSuppressClawNativeExecApprovalPrompt,
  getWebChannelExecApprovalApprovers,
  isWebChannelExecApprovalApprover,
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
  channels: { webchannel: { execApprovals: { enabled: true, approvers: ["web-anon"] } } },
};

describe("webchannel approval payload projection", () => {
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

describe("webchannel native approval runtime", () => {
  it("emits an approval_request frame with the offered options on delivery", async () => {
    const transport = new WebChannelTransport();
    const requestSpy = vi
      .spyOn(transport, "sendApprovalRequest")
      .mockReturnValue(true);

    const spec = createClawApprovalNativeRuntimeSpec(transport);
    const view = fakePendingExecView();
    const baseCtx = { cfg: cfgEnabled, accountId: null, context: undefined };

    // availability gates on execApprovals.enabled AND configured approvers AND
    // the request matching this channel (inner spec gate mirrors the outer
    // lazy adapter via shouldHandleWebChannelApprovalRequest).
    expect(spec.availability.isConfigured(baseCtx as any)).toBe(true);
    expect(
      spec.availability.shouldHandle({
        ...baseCtx,
        request: {
          id: view.approvalId,
          request: { command: "ls", turnSourceChannel: "webchannel" },
        } as any,
      }),
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
    const transport = new WebChannelTransport();
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

describe("webchannel native approval origin routing (multi-user)", () => {
  // resolveOriginTarget must read the turn source (`turnSourceTo`) so the prompt
  // is routed to the originating peer, not a hardcoded anon key. The capability
  // built by createApproverRestrictedNativeApprovalCapability exposes the
  // resolver we passed in as `native.resolveOriginTarget`, so exercise it there
  // (the old standalone createClawApprovalNativeAdapter was removed).
  const transport = new WebChannelTransport();
  const capability = createClawApprovalCapability(transport) as any;
  const resolveOriginTarget = capability.native.resolveOriginTarget;

  function execRequest(turnSourceTo?: string, turnSourceChannel?: string): any {
    return {
      id: "exec-1",
      request: { command: "ls", turnSourceTo, turnSourceChannel },
    };
  }

  it("resolves the origin target to the originating peer (turnSourceTo)", () => {
    const target = resolveOriginTarget({
      cfg: cfgEnabled,
      accountId: null,
      approvalKind: "exec",
      request: execRequest("peer-alice", "webchannel"),
    });
    expect(target).toEqual({ to: "peer-alice" });
  });

  it("ignores an approval that originated on a different channel", () => {
    const target = resolveOriginTarget({
      cfg: cfgEnabled,
      accountId: null,
      approvalKind: "exec",
      request: execRequest("+15551234", "signal"),
    });
    expect(target).toBeNull();
  });

  it("falls back to the anon peer when no turn source is present", () => {
    const target = resolveOriginTarget({
      cfg: cfgEnabled,
      accountId: null,
      approvalKind: "exec",
      request: execRequest(undefined, undefined),
    });
    expect(target).toEqual({ to: "web-anon" });
  });

  it("prepareTarget keys the prompt to the planned per-peer target", async () => {
    const transport = new WebChannelTransport();
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
    expect(prepared!.dedupeKey).toBe("webchannel:peer-bob");
  });

  it("delivers the approval_request to the originating peer's socket key", async () => {
    const transport = new WebChannelTransport();
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

describe("webchannel native approval bootstrap (Gate 1)", () => {
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
    expect(params.channelId).toBe("webchannel");
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

describe("webchannel native approval surface state (Gate 2)", () => {
  // The capability built by createApproverRestrictedNativeApprovalCapability
  // derives the surface state from BOTH execApprovals.enabled AND configured
  // approvers (an enabled account with no approvers is NOT a usable native
  // approval client). These hooks live at the CAPABILITY level and are read by
  // core's exec-approval-surface resolver.
  it("exposes surface-state hooks returning enabled when execApprovals on + approvers configured", () => {
    const transport = new WebChannelTransport();
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
    const transport = new WebChannelTransport();
    const capability = createClawApprovalCapability(transport) as any;
    const cfgOff: any = {
      channels: { webchannel: { execApprovals: { enabled: false, approvers: ["web-anon"] } } },
    };

    expect(
      capability.getExecInitiatingSurfaceState({ cfg: cfgOff, action: "approve" }),
    ).toEqual({ kind: "disabled" });
  });

  it("reports disabled surface state when enabled but NO approvers configured", () => {
    const transport = new WebChannelTransport();
    const capability = createClawApprovalCapability(transport) as any;
    const cfgNoApprovers: any = {
      channels: { webchannel: { execApprovals: { enabled: true } } },
    };

    expect(
      capability.getExecInitiatingSurfaceState({ cfg: cfgNoApprovers, action: "approve" }),
    ).toEqual({ kind: "disabled" });
  });
});

describe("webchannel in-band approval text suppression (Gate 2)", () => {
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
      channels: { webchannel: { execApprovals: { enabled: false } } },
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

describe("webchannel approval decision -> gateway", () => {
  beforeEach(() => {
    resolveApprovalOverGateway.mockClear();
  });

  it("resolves the approval over the gateway on a widget button click", async () => {
    // senderId is now required (per-peer authorization); pass the anon peer.
    await handleApprovalDecision(cfgEnabled, "exec-1", "deny", "web-anon");
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "exec-1",
        decision: "deny",
        allowPluginFallback: true,
        senderId: "web-anon",
      }),
    );
  });

  it("REJECTS a widget click from a non-approver (the real attack path)", async () => {
    const cfgWithApprovers = {
      channels: { webchannel: { execApprovals: { enabled: true, approvers: ["alice"] } } },
    };
    await expect(
      handleApprovalDecision(cfgWithApprovers as any, "exec-1", "deny", "eve"),
    ).rejects.toThrow(/not a configured exec approver/);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("allows a widget click from a configured approver and forwards senderId", async () => {
    const cfgWithApprovers = {
      channels: { webchannel: { execApprovals: { enabled: true, approvers: ["alice"] } } },
    };
    await handleApprovalDecision(cfgWithApprovers as any, "exec-1", "deny", "alice");
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "exec-1", decision: "deny", senderId: "alice" }),
    );
  });

  it("routes an inbound approval_decision frame through the transport handler", () => {
    const transport = new WebChannelTransport();
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

describe("webchannel approver resolution", () => {
  it("reads approvers from channels.webchannel.execApprovals.approvers", () => {
    const cfg = {
      channels: { webchannel: { execApprovals: { approvers: ["alice", "bob"] } } },
    };
    expect(getWebChannelExecApprovalApprovers({ cfg: cfg as any })).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("falls back to commands.ownerAllowFrom when channel approvers unset", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["owner"] },
      channels: { webchannel: {} },
    };
    expect(getWebChannelExecApprovalApprovers({ cfg: cfg as any })).toEqual([
      "owner",
    ]);
  });

  it("prefers channel approvers over ownerAllowFrom", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["owner"] },
      channels: { webchannel: { execApprovals: { approvers: ["alice"] } } },
    };
    expect(getWebChannelExecApprovalApprovers({ cfg: cfg as any })).toEqual([
      "alice",
    ]);
  });

  it("returns empty when neither source configured", () => {
    expect(getWebChannelExecApprovalApprovers({ cfg: {} as any })).toEqual([]);
  });

  it("trims and drops empty entries", () => {
    const cfg = {
      channels: {
        webchannel: { execApprovals: { approvers: ["  alice  ", "", "bob"] } },
      },
    };
    expect(getWebChannelExecApprovalApprovers({ cfg: cfg as any })).toEqual([
      "alice",
      "bob",
    ]);
  });
});

describe("webchannel exec approval authorization", () => {
  const cfgWithApprovers = {
    channels: {
      webchannel: { execApprovals: { enabled: true, approvers: ["alice", "bob"] } },
    },
  };

  it("approves a configured approver", () => {
    expect(
      isWebChannelExecApprovalApprover({
        cfg: cfgWithApprovers as any,
        senderId: "alice",
      }),
    ).toBe(true);
  });

  it("rejects an unknown peer", () => {
    expect(
      isWebChannelExecApprovalApprover({
        cfg: cfgWithApprovers as any,
        senderId: "eve",
      }),
    ).toBe(false);
  });

  it("rejects empty/whitespace senderId", () => {
    expect(
      isWebChannelExecApprovalApprover({
        cfg: cfgWithApprovers as any,
        senderId: "  ",
      }),
    ).toBe(false);
    expect(
      isWebChannelExecApprovalApprover({ cfg: cfgWithApprovers as any }),
    ).toBe(false);
  });
});

describe("webchannel capability authorizeActorAction", () => {
  const cfgWithApprovers = {
    channels: {
      webchannel: { execApprovals: { enabled: true, approvers: ["alice"] } },
    },
  };

  it("authorizes a configured approver", () => {
    const transport = new WebChannelTransport();
    const capability = createClawApprovalCapability(transport) as any;
    const result = capability.authorizeActorAction({
      cfg: cfgWithApprovers,
      accountId: null,
      senderId: "alice",
      action: "approve",
      approvalKind: "exec",
    });
    expect(result).toEqual({ authorized: true });
  });

  it("capability.authorizeActorAction rejects a non-approver", () => {
    const transport = new WebChannelTransport();
    const capability = createClawApprovalCapability(transport) as any;
    const result = capability.authorizeActorAction({
      cfg: cfgWithApprovers,
      accountId: null,
      senderId: "eve",
      action: "approve",
      approvalKind: "exec",
    });
    expect(result).toEqual({
      authorized: false,
      reason: expect.stringContaining("not authorized"),
    });
  });

  it("rejects when no approvers configured", () => {
    const transport = new WebChannelTransport();
    const capability = createClawApprovalCapability(transport) as any;
    const cfgEmpty = {
      channels: { webchannel: { execApprovals: { enabled: true } } },
    };
    const result = capability.authorizeActorAction({
      cfg: cfgEmpty,
      accountId: null,
      senderId: "anyone",
      action: "approve",
      approvalKind: "exec",
    });
    expect(result).toEqual({ authorized: false, reason: expect.any(String) });
  });
});
