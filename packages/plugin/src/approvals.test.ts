import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { NullPeerChannel } from "./channel-contract.js";
class FakePeerChannel extends NullPeerChannel {
  setFirstLivenessHandler(_handler: any) {}
  setHistoryEnabled(_enabled: boolean) {}
}
import type { ApprovalRequestPayload } from "./channel-contract.js";
import {
  createClawApprovalNativeRuntimeSpec,
  createClawApprovalCapability,
  buildApprovalRequestPayload,
  handleApprovalDecision,
  startClawApprovalMonitor,
  shouldSuppressClawNativeExecApprovalPrompt,
  getWebChannelExecApprovalApprovers,
  isWebChannelExecApprovalApprover,
  __approvalAccountBindingTestHook,
  ApprovalBindingMissingError,
  listPendingApprovalsForPeer,
  PENDING_APPROVAL_MAX_AGE_MS,
  PENDING_APPROVAL_CAP,
  __pendingApprovalsTestHook,
  listResolvedApprovalsForPeer,
  RESOLVED_APPROVAL_MAX_AGE_MS,
  RESOLVED_APPROVAL_CAP,
  __resolvedApprovalsTestHook,
} from "./approvals.js";
import {
  APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY,
  ApprovalOriginLeaseRegistry,
} from "./approval-origin.js";
import { decodeStrictLogfmt } from "./test-fixtures/strict-logfmt.js";

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
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
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
  const transport = new FakePeerChannel();
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

  it("returns null — never an invented peer — when no turn source is present", () => {
    // #93: the old code answered `web-anon` here. With no turn source AND no
    // session key there is nothing to prove an origin with, so the only safe
    // answer is "I don't know". The evidence-based path is exercised against a
    // real session store further down this file.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = resolveOriginTarget({
      cfg: cfgEnabled,
      accountId: null,
      approvalKind: "exec",
      request: execRequest(undefined, undefined),
    });
    expect(target).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=missing_session_key"),
    );
    warnSpy.mockRestore();
  });

  it("ignores a turnSourceTo that arrives without a channel", () => {
    // Uncorroborated: nothing says which channel that target belongs to. It must
    // not short-circuit to `{ to }` — the decision falls through to the
    // evidence-based path, which has no lease here and so answers null.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = resolveOriginTarget({
      cfg: cfgEnabled,
      accountId: null,
      approvalKind: "exec",
      request: execRequest("peer-alice", undefined),
    });
    expect(target).toBeNull();
    warnSpy.mockRestore();
  });

  it("prepareTarget keys the prompt to the planned per-peer target", async () => {
    const transport = new FakePeerChannel();
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
    // The prepared session key + dedupeKey are per-ACCOUNT-per-peer (S1), so two
    // distinct users never collide. NOTE: the SDK's dedupe set is scoped to a
    // single handler's single delivery plan (approval-native-runtime), so the
    // account segment is not what separates accounts — that comes from the
    // per-account handler instances. The segment just keeps the key unambiguous
    // and self-documents the account. An unscoped (null) context keys default.
    expect(prepared!.target).toEqual({ sessionKey: "peer-bob" });
    expect(prepared!.dedupeKey).toBe("webchannel:default:peer-bob");
  });

  it("delivers the approval_request to the originating peer's socket key", async () => {
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
    const capability = createClawApprovalCapability(transport) as any;
    const cfgOff: any = {
      channels: { webchannel: { execApprovals: { enabled: false, approvers: ["web-anon"] } } },
    };

    expect(
      capability.getExecInitiatingSurfaceState({ cfg: cfgOff, action: "approve" }),
    ).toEqual({ kind: "disabled" });
  });

  it("reports disabled surface state when enabled but NO approvers configured", () => {
    const transport = new FakePeerChannel();
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
    // F1: handleApprovalDecision now requires a live delivery binding (an
    // approval must have been delivered before it can be resolved). Reset the
    // shared binding map and seed "exec-1" on the default account so these
    // isolation tests drive the same map the real deliverPending writes.
    __approvalAccountBindingTestHook.clear();
    __approvalAccountBindingTestHook.record("exec-1", null);
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
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
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
    const transport = new FakePeerChannel();
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

// ─────────────────────────────────────────────────────────────────────────────
// S1: accountId-aware approvals (multi-account gateway)
//
// Failure scenario being pinned: one gateway serves accounts "a" (primary) and
// "b"; the same peerId is registered on both. Before S1, account-B turns'
// approval prompts were claimed by the account-agnostic handler and delivered
// via the PRIMARY channel — cross-deployment disclosure + a mis-scoped
// approval surface. Now each account's handler claims only its own turns
// (turnSourceAccountId match) and delivers on its own channel.
// ─────────────────────────────────────────────────────────────────────────────
describe("webchannel S1 accountId-aware approvals (multi-account)", () => {
  // Two accounts, each with its own approver set; the channel-level base has
  // NO execApprovals so nothing leaks between accounts via the shared base.
  const cfgTwoAccounts: any = {
    channels: {
      webchannel: {
        accounts: {
          a: { execApprovals: { enabled: true, approvers: ["ann"] } },
          b: { execApprovals: { enabled: true, approvers: ["bob"] } },
        },
      },
    },
  };

  function makeAccountTransports() {
    const transportA = new FakePeerChannel();
    const transportB = new FakePeerChannel();
    const sentA = vi.spyOn(transportA, "sendApprovalRequest").mockReturnValue(true);
    const sentB = vi.spyOn(transportB, "sendApprovalRequest").mockReturnValue(true);
    const resolvedA = vi.spyOn(transportA, "sendApprovalResolved").mockReturnValue(true);
    const resolvedB = vi.spyOn(transportB, "sendApprovalResolved").mockReturnValue(true);
    const fallback = new FakePeerChannel();
    const sentFallback = vi.spyOn(fallback, "sendApprovalRequest").mockReturnValue(true);
    const byAccount: Record<string, FakePeerChannel> = { a: transportA, b: transportB };
    const spec = createClawApprovalNativeRuntimeSpec(
      fallback,
      (accountId) => byAccount[accountId ?? "default"],
    );
    return { spec, sentA, sentB, resolvedA, resolvedB, sentFallback };
  }

  it("each account's handler claims ONLY its own turns (turnSourceAccountId match)", () => {
    const { spec } = makeAccountTransports();
    const requestFromB: any = {
      id: "exec-b1",
      request: {
        command: "ls",
        turnSourceChannel: "webchannel",
        turnSourceAccountId: "b",
      },
    };
    const ctx = (accountId: string) => ({ cfg: cfgTwoAccounts, accountId, context: undefined });
    // Account A's handler must NOT claim an account-B turn's approval…
    expect(spec.availability.shouldHandle({ ...ctx("a"), request: requestFromB })).toBe(false);
    // …and account B's handler must.
    expect(spec.availability.shouldHandle({ ...ctx("b"), request: requestFromB })).toBe(true);
  });

  it("isConfigured gates PER account (approvers on A only ⇒ B not configured)", () => {
    const cfgOnlyA: any = {
      channels: {
        webchannel: {
          accounts: {
            a: { execApprovals: { enabled: true, approvers: ["ann"] } },
            b: {},
          },
        },
      },
    };
    const { spec } = makeAccountTransports();
    expect(spec.availability.isConfigured({ cfg: cfgOnlyA, accountId: "a" } as any)).toBe(true);
    expect(spec.availability.isConfigured({ cfg: cfgOnlyA, accountId: "b" } as any)).toBe(false);
  });

  it("an account with no execApprovals override INHERITS the channel-level base", () => {
    const cfgSharedBase: any = {
      channels: {
        webchannel: {
          execApprovals: { enabled: true, approvers: ["ops"] },
          accounts: { a: {} },
        },
      },
    };
    expect(
      getWebChannelExecApprovalApprovers({ cfg: cfgSharedBase, accountId: "a" }),
    ).toEqual(["ops"]);
    expect(
      isWebChannelExecApprovalApprover({ cfg: cfgSharedBase, accountId: "a", senderId: "ops" }),
    ).toBe(true);
  });

  it("delivers the prompt on the ORIGINATING account's channel (shared peerId, B-turn ⇒ B channel only)", async () => {
    const { spec, sentA, sentB, sentFallback } = makeAccountTransports();
    const view = fakePendingExecView("exec-b2");
    const ctxB = { cfg: cfgTwoAccounts, accountId: "b", context: undefined };

    const pendingPayload = (await spec.presentation.buildPendingPayload({
      ...ctxB,
      request: { id: view.approvalId } as any,
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    })) as ApprovalRequestPayload;

    const prepared = await spec.transport.prepareTarget({
      ...ctxB,
      plannedTarget: { surface: "origin", target: { to: "alice" }, reason: "preferred" } as any,
      request: {} as any,
      approvalKind: "exec",
      view: view as any,
      pendingPayload,
    });
    // Account-scoped dedupe KEY (delivery separation itself comes from the
    // per-account handler instances, not this key — see the prepareTarget note).
    expect(prepared!.dedupeKey).toBe("webchannel:b:alice");

    const entry = await spec.transport.deliverPending({
      ...ctxB,
      plannedTarget: { surface: "origin", target: { to: "alice" }, reason: "preferred" } as any,
      preparedTarget: prepared!.target,
      request: {} as any,
      approvalKind: "exec",
      view: view as any,
      pendingPayload,
    });

    expect(sentB).toHaveBeenCalledWith("alice", pendingPayload);
    expect(sentA).not.toHaveBeenCalled();
    expect(sentFallback).not.toHaveBeenCalled();
    // The entry records the delivering account for the finalize leg.
    expect(entry).toEqual({ approvalId: "exec-b2", sessionKey: "alice", accountId: "b" });
  });

  it("finalizes (approval_resolved) on the SAME account's channel — entry fallback when ctx is unscoped", async () => {
    const { spec, resolvedA, resolvedB } = makeAccountTransports();
    const entry = { approvalId: "exec-b3", sessionKey: "alice", accountId: "b" };

    // Normal path: hook context carries the account.
    await spec.transport.updateEntry!({
      cfg: cfgTwoAccounts,
      accountId: "b",
      context: undefined,
      entry,
      payload: { decision: "deny" },
      phase: "resolved",
    } as any);
    expect(resolvedB).toHaveBeenCalledWith("alice", "exec-b3", "deny");
    expect(resolvedA).not.toHaveBeenCalled();

    // Defensive path: unscoped context falls back to the entry's recorded account.
    resolvedB.mockClear();
    await spec.transport.updateEntry!({
      cfg: cfgTwoAccounts,
      accountId: null,
      context: undefined,
      entry,
      payload: { decision: "allow-once" },
      phase: "resolved",
    } as any);
    expect(resolvedB).toHaveBeenCalledWith("alice", "exec-b3", "allow-once");
    expect(resolvedA).not.toHaveBeenCalled();
  });

  it("F2: unknown account is fail-closed (dropped), NEVER delivered on the fallback/primary", async () => {
    // When a resolver is wired (multi-account NATS entry), an unknown account is
    // a MISS → drop. It must NOT fall back to the closure transport (which is
    // the primary channel) — that would re-open the cross-account misroute.
    const { spec, sentA, sentB, sentFallback } = makeAccountTransports();
    const view = fakePendingExecView("exec-x");
    const ctxUnknown = { cfg: cfgTwoAccounts, accountId: "ghost", context: undefined };
    await spec.transport.deliverPending({
      ...ctxUnknown,
      plannedTarget: { surface: "origin", target: { to: "alice" }, reason: "preferred" } as any,
      preparedTarget: { sessionKey: "alice" },
      request: {} as any,
      approvalKind: "exec",
      view: view as any,
      pendingPayload: buildApprovalRequestPayload(view),
    });
    expect(sentFallback).not.toHaveBeenCalled();
    expect(sentA).not.toHaveBeenCalled();
    expect(sentB).not.toHaveBeenCalled();
  });

  it("legacy WS (no resolver) still delivers on the single closure transport", async () => {
    // The legacy single-account WS entry passes NO resolver → every account uses
    // the closure transport (there is exactly one account, no misroute possible).
    const only = new FakePeerChannel();
    const onlySent = vi.spyOn(only, "sendApprovalRequest").mockReturnValue(true);
    const spec = createClawApprovalNativeRuntimeSpec(only); // no resolver
    const view = fakePendingExecView("exec-legacy");
    await spec.transport.deliverPending({
      cfg: cfgEnabled,
      accountId: null,
      context: undefined,
      plannedTarget: { surface: "origin", target: { to: "web-anon" }, reason: "preferred" } as any,
      preparedTarget: { sessionKey: "web-anon" },
      request: {} as any,
      approvalKind: "exec",
      view: view as any,
      pendingPayload: buildApprovalRequestPayload(view),
    });
    expect(onlySent).toHaveBeenCalledWith("web-anon", expect.objectContaining({ id: "exec-legacy" }));
  });

  it("widget-click authz is PER ACCOUNT: account-A approver cannot resolve via account B", async () => {
    resolveApprovalOverGateway.mockClear();
    // exec-b4 was delivered on account b (seed the binding as deliverPending would).
    __approvalAccountBindingTestHook.clear();
    __approvalAccountBindingTestHook.record("exec-b4", "b");

    // ann is an approver on account a, NOT on account b.
    await expect(
      handleApprovalDecision(cfgTwoAccounts, "exec-b4", "deny", "ann", "b"),
    ).rejects.toThrow(/not a configured exec approver for account "b"/);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();

    // bob IS account b's approver — resolves fine, senderId forwarded.
    await handleApprovalDecision(cfgTwoAccounts, "exec-b4", "allow-once", "bob", "b");
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "exec-b4", decision: "allow-once", senderId: "bob" }),
    );
  });

  it("F1: rejects a cross-account approvalId replay (B-approver resolving A's approval on B's channel)", async () => {
    resolveApprovalOverGateway.mockClear();
    // exec-a9 was delivered on account a's channel…
    __approvalAccountBindingTestHook.clear();
    __approvalAccountBindingTestHook.record("exec-a9", "a");

    // …bob (a valid approver on B) replays a's id onto B's channel. Even though
    // bob IS a B approver, the id was NOT delivered on B → fail-closed reject
    // BEFORE the approver check, and NO gateway RPC is issued.
    await expect(
      handleApprovalDecision(cfgTwoAccounts, "exec-a9", "allow-once", "bob", "b"),
    ).rejects.toThrow(/was delivered on account "a", not "b" — refusing cross-account resolve/);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("F1: rejects an unknown/never-delivered approvalId (forged or already-resolved)", async () => {
    resolveApprovalOverGateway.mockClear();
    __approvalAccountBindingTestHook.clear();
    await expect(
      handleApprovalDecision(cfgTwoAccounts, "exec-ghost", "deny", "bob", "b"),
    ).rejects.toThrow(/unknown or already resolved/);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("F1: a finalize (updateEntry) releases the binding so a later replay is rejected", async () => {
    const { spec, resolvedB } = makeAccountTransports();
    __approvalAccountBindingTestHook.clear();
    const entry = { approvalId: "exec-b7", sessionKey: "alice", accountId: "b" };
    __approvalAccountBindingTestHook.record("exec-b7", "b");

    await spec.transport.updateEntry!({
      cfg: cfgTwoAccounts,
      accountId: "b",
      context: undefined,
      entry,
      payload: { decision: "deny" },
      phase: "resolved",
    } as any);
    expect(resolvedB).toHaveBeenCalledWith("alice", "exec-b7", "deny");

    // Binding released → a post-finalize resolve attempt is rejected.
    resolveApprovalOverGateway.mockClear();
    await expect(
      handleApprovalDecision(cfgTwoAccounts, "exec-b7", "allow-once", "bob", "b"),
    ).rejects.toThrow(/unknown or already resolved/);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("F2: a skipped account (no live channel) DROPS its prompt instead of misrouting to primary", async () => {
    // Resolver knows accounts a+b, but 'b' is 'skipped' (returns undefined) as
    // if registerFull skipped it (creds-missing). The closure/fallback transport
    // is the PRIMARY (a). A prompt for b must NOT land on the fallback.
    const primary = new FakePeerChannel();
    const primarySent = vi.spyOn(primary, "sendApprovalRequest").mockReturnValue(true);
    const transportA = new FakePeerChannel();
    const aSent = vi.spyOn(transportA, "sendApprovalRequest").mockReturnValue(true);
    const spec = createClawApprovalNativeRuntimeSpec(
      primary,
      (accountId) => (accountId === "a" ? transportA : undefined), // 'b' → undefined (skipped)
    );
    const view = fakePendingExecView("exec-b8");
    const entry = await spec.transport.deliverPending({
      cfg: cfgTwoAccounts,
      accountId: "b",
      context: undefined,
      plannedTarget: { surface: "origin", target: { to: "alice" }, reason: "preferred" } as any,
      preparedTarget: { sessionKey: "alice" },
      request: {} as any,
      approvalKind: "exec",
      view: view as any,
      pendingPayload: buildApprovalRequestPayload(view),
    });
    // Neither the primary/fallback NOR account a's channel received b's prompt.
    expect(primarySent).not.toHaveBeenCalled();
    expect(aSent).not.toHaveBeenCalled();
    // The binding is still recorded (so a stray resolve is still account-checked).
    expect(entry).toEqual({ approvalId: "exec-b8", sessionKey: "alice", accountId: "b" });
  });
});

// ---------------------------------------------------------------------------
// #15 pending-approval store — the authority behind the register-time
// `approval_snapshot`. Exercises deliverPending recording, updateEntry erasure
// (per-account), listPendingApprovalsForPeer filtering + pruning, and the cap.
// ---------------------------------------------------------------------------
describe("webchannel pending-approval store (#15)", () => {
  beforeEach(() => {
    __pendingApprovalsTestHook.clear();
    __approvalAccountBindingTestHook.clear();
  });

  function payload(id: string, expiresAtMs?: number): ApprovalRequestPayload {
    return {
      id,
      kind: "exec",
      title: "t",
      prompt: "p",
      options: [{ decision: "allow-once", label: "Allow", style: "success" }],
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    };
  }

  async function deliver(
    spec: ReturnType<typeof createClawApprovalNativeRuntimeSpec>,
    accountId: string | null,
    sessionKey: string,
    p: ApprovalRequestPayload,
  ) {
    return spec.transport.deliverPending({
      cfg: cfgEnabled,
      accountId,
      context: undefined,
      plannedTarget: {} as any,
      preparedTarget: { sessionKey },
      request: {} as any,
      approvalKind: "exec",
      view: fakePendingExecView(p.id) as any,
      pendingPayload: p,
    } as any);
  }

  async function finalize(
    spec: ReturnType<typeof createClawApprovalNativeRuntimeSpec>,
    accountId: string | null,
    entry: unknown,
    phase: "resolved" | "expired" = "resolved",
  ) {
    await spec.transport.updateEntry!({
      cfg: cfgEnabled,
      accountId,
      context: undefined,
      entry,
      payload: { decision: "deny" },
      phase,
    } as any);
  }

  it("deliverPending records the entry even when the account has NO live channel (F2 drop)", async () => {
    // Resolver present but returns undefined for this account → F2 fail-closed
    // drop (no misroute). The pending record must still be written so the prompt
    // is recoverable on the peer's next register.
    const fallback = new FakePeerChannel();
    const spec = createClawApprovalNativeRuntimeSpec(fallback, () => undefined);
    const p = payload("exec-nc");
    await deliver(spec, "acct", "alice", p);
    expect(listPendingApprovalsForPeer("acct", "alice")).toEqual([p]);
  });

  it("deliverPending records the entry even when the socket send returns false", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendApprovalRequest").mockReturnValue(false);
    const spec = createClawApprovalNativeRuntimeSpec(transport);
    const p = payload("exec-nf");
    await deliver(spec, null, "web-anon", p);
    // null/unscoped normalizes to the "default" account.
    expect(listPendingApprovalsForPeer(null, "web-anon")).toEqual([p]);
  });

  it("updateEntry erases the entry for BOTH resolved and expired finalize", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendApprovalRequest").mockReturnValue(true);
    vi.spyOn(transport, "sendApprovalResolved").mockReturnValue(true);
    const spec = createClawApprovalNativeRuntimeSpec(transport);

    const resolved = payload("exec-r");
    const entryR = await deliver(spec, null, "web-anon", resolved);
    expect(listPendingApprovalsForPeer(null, "web-anon")).toHaveLength(1);
    await finalize(spec, null, entryR, "resolved");
    expect(listPendingApprovalsForPeer(null, "web-anon")).toEqual([]);

    const expired = payload("exec-e");
    const entryE = await deliver(spec, null, "web-anon", expired);
    expect(listPendingApprovalsForPeer(null, "web-anon")).toHaveLength(1);
    await finalize(spec, null, entryE, "expired");
    expect(listPendingApprovalsForPeer(null, "web-anon")).toEqual([]);
  });

  it("updateEntry erases ONLY its own account's entry (same id on A and B is independent)", async () => {
    const transportA = new FakePeerChannel();
    const transportB = new FakePeerChannel();
    vi.spyOn(transportA, "sendApprovalRequest").mockReturnValue(true);
    vi.spyOn(transportB, "sendApprovalRequest").mockReturnValue(true);
    vi.spyOn(transportA, "sendApprovalResolved").mockReturnValue(true);
    vi.spyOn(transportB, "sendApprovalResolved").mockReturnValue(true);
    const byAccount: Record<string, FakePeerChannel> = { a: transportA, b: transportB };
    const spec = createClawApprovalNativeRuntimeSpec(
      new FakePeerChannel(),
      (accountId) => byAccount[accountId ?? "default"],
    );

    // The SAME approval id is delivered on account a AND account b (the F3
    // account-less fan-out models exactly this), to the same peer.
    const p = payload("exec-shared");
    const entryA = await deliver(spec, "a", "alice", p);
    await deliver(spec, "b", "alice", p);
    expect(listPendingApprovalsForPeer("a", "alice")).toEqual([p]);
    expect(listPendingApprovalsForPeer("b", "alice")).toEqual([p]);

    // Finalize on account A must NOT erase account B's still-pending entry.
    await finalize(spec, "a", entryA, "resolved");
    expect(listPendingApprovalsForPeer("a", "alice")).toEqual([]);
    expect(listPendingApprovalsForPeer("b", "alice")).toEqual([p]);
  });

  it("listPendingApprovalsForPeer filters by account AND sessionKey; unknown peer ⇒ []", () => {
    const now = Date.now();
    __pendingApprovalsTestHook.record("a", payload("id-a-alice"), "alice", now);
    __pendingApprovalsTestHook.record("a", payload("id-a-bob"), "bob", now);
    __pendingApprovalsTestHook.record("b", payload("id-b-alice"), "alice", now);

    expect(listPendingApprovalsForPeer("a", "alice").map((p) => p.id)).toEqual(["id-a-alice"]);
    expect(listPendingApprovalsForPeer("a", "bob").map((p) => p.id)).toEqual(["id-a-bob"]);
    expect(listPendingApprovalsForPeer("b", "alice").map((p) => p.id)).toEqual(["id-b-alice"]);
    // Wrong account for a real peer, and an entirely unknown peer, both empty.
    expect(listPendingApprovalsForPeer("b", "bob")).toEqual([]);
    expect(listPendingApprovalsForPeer("a", "nobody")).toEqual([]);
  });

  it("listPendingApprovalsForPeer prunes past-expiresAtMs and stale no-expiry entries, keeps fresh ones", () => {
    const now = Date.now();
    // Past expiry → pruned even though its deliveredAt is recent.
    __pendingApprovalsTestHook.record("a", payload("expired", now - 1_000), "alice", now);
    // No expiry, delivered longer ago than the max age → pruned.
    __pendingApprovalsTestHook.record(
      "a",
      payload("stale-no-expiry"),
      "alice",
      now - PENDING_APPROVAL_MAX_AGE_MS - 1_000,
    );
    // No expiry, delivered just now → kept.
    __pendingApprovalsTestHook.record("a", payload("fresh-no-expiry"), "alice", now);
    // Future expiry → kept.
    __pendingApprovalsTestHook.record("a", payload("future", now + 60_000), "alice", now);

    expect(listPendingApprovalsForPeer("a", "alice").map((p) => p.id).sort()).toEqual([
      "fresh-no-expiry",
      "future",
    ]);
    // Prune is destructive: the pruned entries are gone from the store entirely.
    expect(__pendingApprovalsTestHook.size()).toBe(2);
  });

  it("caps the store, evicting the oldest and retaining the newest", () => {
    const now = Date.now();
    for (let i = 0; i < PENDING_APPROVAL_CAP + 1; i++) {
      __pendingApprovalsTestHook.record("a", payload(`id-${i}`), "alice", now);
    }
    // Size is bounded at the cap; the very first (oldest) entry was evicted and
    // the last (newest) retained.
    expect(__pendingApprovalsTestHook.size()).toBe(PENDING_APPROVAL_CAP);
    const ids = new Set(listPendingApprovalsForPeer("a", "alice").map((p) => p.id));
    expect(ids.has("id-0")).toBe(false);
    expect(ids.has(`id-${PENDING_APPROVAL_CAP}`)).toBe(true);
  });

  it("#130: quoted key=value text stays inside every cap-warning value", () => {
    const hostileId = 'exec-" outcome=ok';
    const hostileAccount = 'account-" peer=trusted';
    const hostilePeer = 'peer-" forged=true';
    const now = Date.now();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      __pendingApprovalsTestHook.record(
        hostileAccount,
        payload(hostileId),
        hostilePeer,
        now,
      );
      for (let i = 0; i < PENDING_APPROVAL_CAP; i++) {
        __pendingApprovalsTestHook.record("safe", payload(`safe-${i}`), "safe-peer", now);
      }

      expect(warn).toHaveBeenCalledTimes(1);
      const record = String(warn.mock.calls[0]![0]);
      expect(record.split("\n")).toHaveLength(1);
      const encoded = record.match(/"(?:\\.|[^"\\])*"/gu) ?? [];
      expect(encoded.map((token) => JSON.parse(token))).toEqual([
        hostileId,
        hostileAccount,
        hostilePeer,
      ]);

      const fields = decodeStrictLogfmt(
        `approval=${encoded[0]} account=${encoded[1]} peer=${encoded[2]}`,
      );
      expect(fields.get("approval")).toBe(hostileId);
      expect(fields.get("account")).toBe(hostileAccount);
      expect(fields.get("peer")).toBe(hostilePeer);
      expect(fields.has("outcome")).toBe(false);
      expect(fields.has("forged")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// #19 recently-resolved store — the OUTCOMES half of the register-time
// `approval_snapshot`. Exercises updateEntry recording (real decision captured),
// per-account composite-key scoping, cap eviction, max-age prune, and
// listResolvedApprovalsForPeer filtering.
// ---------------------------------------------------------------------------
describe("webchannel recently-resolved store (#19)", () => {
  beforeEach(() => {
    __pendingApprovalsTestHook.clear();
    __resolvedApprovalsTestHook.clear();
    __approvalAccountBindingTestHook.clear();
  });

  function payload(id: string): ApprovalRequestPayload {
    return {
      id,
      kind: "exec",
      title: "t",
      prompt: "p",
      options: [{ decision: "allow-once", label: "Allow", style: "success" }],
    };
  }

  async function deliver(
    spec: ReturnType<typeof createClawApprovalNativeRuntimeSpec>,
    accountId: string | null,
    sessionKey: string,
    p: ApprovalRequestPayload,
  ) {
    return spec.transport.deliverPending({
      cfg: cfgEnabled,
      accountId,
      context: undefined,
      plannedTarget: {} as any,
      preparedTarget: { sessionKey },
      request: {} as any,
      approvalKind: "exec",
      view: fakePendingExecView(p.id) as any,
      pendingPayload: p,
    } as any);
  }

  async function finalize(
    spec: ReturnType<typeof createClawApprovalNativeRuntimeSpec>,
    accountId: string | null,
    entry: unknown,
    decision: "allow-once" | "allow-always" | "deny",
    phase: "resolved" | "expired" = "resolved",
  ) {
    await spec.transport.updateEntry!({
      cfg: cfgEnabled,
      accountId,
      context: undefined,
      entry,
      payload: { decision },
      phase,
    } as any);
  }

  it("updateEntry records the REAL decision at finalize (captured for the snapshot)", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendApprovalRequest").mockReturnValue(true);
    vi.spyOn(transport, "sendApprovalResolved").mockReturnValue(true);
    const spec = createClawApprovalNativeRuntimeSpec(transport);

    const p = payload("exec-r");
    const entry = await deliver(spec, null, "web-anon", p);
    // Not resolved yet → nothing in the resolved store.
    expect(listResolvedApprovalsForPeer(null, "web-anon")).toEqual([]);

    await finalize(spec, null, entry, "allow-always", "resolved");
    expect(listResolvedApprovalsForPeer(null, "web-anon")).toEqual([
      { id: "exec-r", decision: "allow-always" },
    ]);
  });

  it("an EXPIRY records the decision the builder produces ('deny'), driven through buildExpiredResult", async () => {
    const transport = new FakePeerChannel();
    vi.spyOn(transport, "sendApprovalRequest").mockReturnValue(true);
    vi.spyOn(transport, "sendApprovalResolved").mockReturnValue(true);
    const spec = createClawApprovalNativeRuntimeSpec(transport);

    // Prove the recorded decision comes from the BUILDER, not a test literal: take
    // the expiry payload the presentation builder emits and drive updateEntry with
    // exactly it. If buildExpiredResult ever stops modeling expiry as "deny", this
    // fails.
    const expiredAction = spec.presentation.buildExpiredResult!({
      view: fakePendingExecView("exec-e"),
    } as any);
    expect(expiredAction).toEqual({ kind: "update", payload: { decision: "deny" } });

    const p = payload("exec-e");
    const entry = await deliver(spec, null, "web-anon", p);
    await spec.transport.updateEntry!({
      cfg: cfgEnabled,
      accountId: null,
      context: undefined,
      entry,
      payload: (expiredAction as { payload: { decision: "allow-once" | "allow-always" | "deny" } })
        .payload,
      phase: "expired",
    } as any);
    expect(listResolvedApprovalsForPeer(null, "web-anon")).toEqual([
      { id: "exec-e", decision: "deny" },
    ]);
  });

  it("records under the SAME account's composite key: A's finalize doesn't mask B", async () => {
    const transportA = new FakePeerChannel();
    const transportB = new FakePeerChannel();
    vi.spyOn(transportA, "sendApprovalRequest").mockReturnValue(true);
    vi.spyOn(transportB, "sendApprovalRequest").mockReturnValue(true);
    vi.spyOn(transportA, "sendApprovalResolved").mockReturnValue(true);
    vi.spyOn(transportB, "sendApprovalResolved").mockReturnValue(true);
    const byAccount: Record<string, FakePeerChannel> = { a: transportA, b: transportB };
    const spec = createClawApprovalNativeRuntimeSpec(
      new FakePeerChannel(),
      (accountId) => byAccount[accountId ?? "default"],
    );

    // Same id delivered on A and B (the F3 fan-out), same peer.
    const p = payload("exec-shared");
    const entryA = await deliver(spec, "a", "alice", p);
    await deliver(spec, "b", "alice", p);

    // Finalize on A (allow-once) — B stays pending, unrecorded on B's key.
    await finalize(spec, "a", entryA, "allow-once", "resolved");
    expect(listResolvedApprovalsForPeer("a", "alice")).toEqual([
      { id: "exec-shared", decision: "allow-once" },
    ]);
    // B has no resolved record; it is still PENDING.
    expect(listResolvedApprovalsForPeer("b", "alice")).toEqual([]);
    expect(listPendingApprovalsForPeer("b", "alice")).toEqual([p]);
  });

  it("listResolvedApprovalsForPeer filters by account AND sessionKey; unknown peer ⇒ []", () => {
    const now = Date.now();
    __resolvedApprovalsTestHook.record("a", "id-a-alice", "allow-once", "alice", now);
    __resolvedApprovalsTestHook.record("a", "id-a-bob", "deny", "bob", now);
    __resolvedApprovalsTestHook.record("b", "id-b-alice", "allow-always", "alice", now);

    expect(listResolvedApprovalsForPeer("a", "alice")).toEqual([
      { id: "id-a-alice", decision: "allow-once" },
    ]);
    expect(listResolvedApprovalsForPeer("a", "bob")).toEqual([
      { id: "id-a-bob", decision: "deny" },
    ]);
    expect(listResolvedApprovalsForPeer("b", "alice")).toEqual([
      { id: "id-b-alice", decision: "allow-always" },
    ]);
    expect(listResolvedApprovalsForPeer("b", "bob")).toEqual([]);
    expect(listResolvedApprovalsForPeer("a", "nobody")).toEqual([]);
  });

  it("lazy-prunes entries older than the max age, keeps fresh ones", () => {
    const now = Date.now();
    __resolvedApprovalsTestHook.record(
      "a",
      "stale",
      "deny",
      "alice",
      now - RESOLVED_APPROVAL_MAX_AGE_MS - 1_000,
    );
    __resolvedApprovalsTestHook.record("a", "fresh", "allow-once", "alice", now);

    expect(listResolvedApprovalsForPeer("a", "alice")).toEqual([
      { id: "fresh", decision: "allow-once" },
    ]);
    // Prune is destructive: the stale entry is gone from the store.
    expect(__resolvedApprovalsTestHook.size()).toBe(1);
  });

  it("caps the store, evicting the oldest and retaining the newest", () => {
    const now = Date.now();
    for (let i = 0; i < RESOLVED_APPROVAL_CAP + 1; i++) {
      __resolvedApprovalsTestHook.record("a", `id-${i}`, "deny", "alice", now);
    }
    expect(__resolvedApprovalsTestHook.size()).toBe(RESOLVED_APPROVAL_CAP);
    const ids = new Set(listResolvedApprovalsForPeer("a", "alice").map((r) => r.id));
    expect(ids.has("id-0")).toBe(false);
    expect(ids.has(`id-${RESOLVED_APPROVAL_CAP}`)).toBe(true);
  });
});

/**
 * #93 — origin resolution from an active lease + the PERSISTED session store.
 *
 * This is the bug: a plugin-kind approval arrives with every `turnSource*` field
 * null, and the old resolver answered `web-anon` — not the real peer, so the
 * prompt was dropped and the write tool timed out, and an unproven origin was
 * being asserted as a delivery target.
 *
 * These tests run the REAL `resolveApprovalRequestOriginTarget` from
 * `openclaw/plugin-sdk/approval-runtime` against a REAL session-store document
 * in a temp directory. The helper is deliberately not stubbed: half the point of
 * this file is to pin its actual composition behaviour — that returning null
 * from `resolveTurnSourceTarget` yields the STORED target rather than
 * short-circuiting. That composition is not part of the exported contract, so if
 * a core upgrade changes it, this file is what fails.
 *
 * The lease registry is planted with an injected clock, because request-time
 * comparisons are strict and real wall-clock milliseconds cannot be ordered
 * deterministically in a test.
 */
describe("#93 origin routing — active lease + persisted session store", () => {
  const SESSION_KEY = "agent:rota:webchannel:default:direct:d21d9f07-1f2e";
  const ORIGIN_PEER = "PeerCase-1"; // deliberately mixed case: `to` is byte-exact
  const OTHER_PEER = "PeerCase-2";

  const slots = globalThis as unknown as Record<symbol, unknown>;
  const capability = createClawApprovalCapability(new FakePeerChannel()) as any;

  let dir: string;
  let storeSeq = 0;
  let savedRegistry: unknown;
  let registry: ApprovalOriginLeaseRegistry;
  let nowMs: number;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "webchannel-approval-origin-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    savedRegistry = slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    nowMs = 1_000;
    registry = new ApprovalOriginLeaseRegistry({ now: () => nowMs });
    slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = registry;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    if (savedRegistry === undefined) delete slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    else slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = savedRegistry;
    warnSpy.mockRestore();
  });

  /**
   * Write a fresh session-store document and return a config pointing at it.
   * A NEW file per call: core caches the parsed store by (path, mtime, size),
   * and two same-size rewrites inside one millisecond could otherwise be served
   * from that cache.
   */
  function cfgWithStore(entries: Record<string, unknown>): any {
    const file = join(dir, `sessions-${++storeSeq}.json`);
    writeFileSync(file, JSON.stringify(entries));
    return {
      session: { store: file },
      channels: { webchannel: { execApprovals: { enabled: true, approvers: [ORIGIN_PEER] } } },
    };
  }

  /** A persisted webchannel session entry, as core records one for our turns. */
  function entry(to: string, accountId?: string, channel = "webchannel"): unknown {
    return {
      lastChannel: channel,
      lastTo: to,
      ...(accountId === undefined ? {} : { lastAccountId: accountId }),
      updatedAt: new Date(1_000).toISOString(),
    };
  }

  /** The issue #93 request shape: a session key, and no turn source at all. */
  function nullMetadataRequest(
    createdAtMs: number,
    opts: { sessionKey?: string | null; id?: string } = {},
  ): any {
    return {
      id: opts.id ?? "exec-93",
      request: {
        command: "write /etc/hosts",
        sessionKey: opts.sessionKey === undefined ? SESSION_KEY : opts.sessionKey,
        turnSourceChannel: null,
        turnSourceTo: null,
        turnSourceAccountId: null,
        turnSourceThreadId: null,
      },
      createdAtMs,
      expiresAtMs: createdAtMs + 60_000,
    };
  }

  function resolveOrigin(cfg: any, request: any, accountId: string | null = null): any {
    return capability.native.resolveOriginTarget({
      cfg,
      accountId,
      approvalKind: "exec",
      request,
    });
  }

  function lease(rawAccountId: string, peerId: string, sessionKey = SESSION_KEY) {
    const handle = registry.createLease({ rawAccountId, sessionKey, peerId });
    handle.activate();
    return handle;
  }

  /** The reasons emitted by this decision (one line each, `[webchannel] …`). */
  function warnedReasons(): string[] {
    return warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("origin_unresolved"))
      .map((line) => /reason=(\w+)/.exec(line)?.[1] ?? "");
  }

  it("recovers the exact origin peer for an all-null-metadata request (the #93 regression)", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "default") });
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_030;

    expect(resolveOrigin(cfg, nullMetadataRequest(1_020))).toEqual({ to: ORIGIN_PEER });
    expect(warnedReasons()).toEqual([]);
  });

  it("returns null when the request carries no session key", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "default") });
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_030;

    for (const sessionKey of [null, "", "   "]) {
      expect(resolveOrigin(cfg, nullMetadataRequest(1_020, { sessionKey }))).toBeNull();
    }
    expect(warnedReasons()).toEqual([
      "missing_session_key",
      "missing_session_key",
      "missing_session_key",
    ]);
  });

  it("returns null when the session entry is missing or the store is corrupt", () => {
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_030;

    const missing = cfgWithStore({ "agent:other:session": entry(ORIGIN_PEER, "default") });
    expect(resolveOrigin(missing, nullMetadataRequest(1_020))).toBeNull();

    const corruptFile = join(dir, `corrupt-${++storeSeq}.json`);
    writeFileSync(corruptFile, "{ this is not json");
    const corrupt = {
      session: { store: corruptFile },
      channels: { webchannel: { execApprovals: { enabled: true, approvers: [ORIGIN_PEER] } } },
    };
    expect(resolveOrigin(corrupt, nullMetadataRequest(1_020))).toBeNull();

    expect(warnedReasons()).toEqual([
      "stored_target_unavailable",
      "stored_target_unavailable",
    ]);
  });

  it("returns null (never throws) when the SDK helper throws", () => {
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_030;
    // A non-string store path makes the helper's own path resolution throw —
    // whatever the cause, the exception must not cross the capability boundary.
    const cfg: any = {
      session: { store: 123 },
      channels: { webchannel: { execApprovals: { enabled: true, approvers: [ORIGIN_PEER] } } },
    };

    expect(() => resolveOrigin(cfg, nullMetadataRequest(1_020))).not.toThrow();
    expect(resolveOrigin(cfg, nullMetadataRequest(1_020))).toBeNull();
    expect(warnedReasons()).toEqual(["sdk_error", "sdk_error"]);
  });

  it("returns null when the stored target was overwritten by another peer", () => {
    // The active run is ORIGIN_PEER's, but a later inbound from OTHER_PEER
    // overwrote the shared session entry. Corroboration fails: deliver to
    // neither rather than guess.
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(OTHER_PEER, "default") });
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_030;

    expect(resolveOrigin(cfg, nullMetadataRequest(1_020))).toBeNull();
    expect(warnedReasons()).toEqual(["active_stored_mismatch"]);
  });

  it("returns null when the stored entry belongs to another channel", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "default", "telegram") });
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_030;

    expect(resolveOrigin(cfg, nullMetadataRequest(1_020))).toBeNull();
    expect(warnedReasons()).toEqual(["stored_target_unavailable"]);
  });

  it("returns null when the stored account does not match the handler's", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "other-account") });
    nowMs = 1_010;
    lease("AcctA", ORIGIN_PEER);
    nowMs = 1_030;

    expect(resolveOrigin(cfg, nullMetadataRequest(1_020), "AcctA")).toBeNull();
    expect(warnedReasons()).toEqual(["stored_target_unavailable"]);
  });

  it("treats a stored entry with no account as the default account only", () => {
    // The stored account canonicalizes to "default" when absent, so a NAMED
    // account's handler refuses it (our own account check, which the SDK helper
    // does not perform) while the default account's handler accepts it.
    const named = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER) });
    nowMs = 1_010;
    lease("AcctA", ORIGIN_PEER);
    nowMs = 1_030;
    expect(resolveOrigin(named, nullMetadataRequest(1_020), "AcctA")).toBeNull();
    expect(warnedReasons()).toEqual(["stored_binding_mismatch"]);

    const dflt = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER) });
    nowMs = 1_040;
    lease("default", ORIGIN_PEER);
    nowMs = 1_060;
    expect(resolveOrigin(dflt, nullMetadataRequest(1_050))).toEqual({ to: ORIGIN_PEER });
  });

  it("returns null when two distinct origins shared the canonical tuple", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "default") });
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_012;
    lease("default", OTHER_PEER);
    nowMs = 1_030;

    expect(resolveOrigin(cfg, nullMetadataRequest(1_020))).toBeNull();
    expect(warnedReasons()).toEqual(["active_ambiguous"]);
  });

  it("returns null when an overlapping run released before the request was replayed", () => {
    // A and B overlapped, so the tuple is poisoned for the epoch. A then aborted
    // and both the live lease and the store now say B — which is exactly the
    // shape that would misdeliver A's replayed pending request to B.
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(OTHER_PEER, "default") });
    nowMs = 1_010;
    const a = lease("default", ORIGIN_PEER);
    nowMs = 1_012;
    lease("default", OTHER_PEER);
    nowMs = 1_020;
    a.release();
    nowMs = 1_040;

    expect(resolveOrigin(cfg, nullMetadataRequest(1_030))).toBeNull();
    expect(warnedReasons()).toEqual(["active_ambiguous"]);
  });

  it("returns null for a same-millisecond alias activation after the origin released", () => {
    // A ran, the request was created, A released; alias-account B then activated
    // in the SAME injected millisecond as the request and overwrote the store.
    // Equality cannot prove ordering, so B is not eligible.
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(OTHER_PEER, "default") });
    nowMs = 1_010;
    const a = lease("default", ORIGIN_PEER);
    nowMs = 1_015;
    a.release();
    nowMs = 1_020;
    lease("DEFAULT", OTHER_PEER); // canonical-alias raw account, distinct peer
    nowMs = 1_040;

    expect(resolveOrigin(cfg, nullMetadataRequest(1_020))).toBeNull();
    expect(warnedReasons()).toEqual(["active_no_match"]);
  });

  it("returns null for a request replayed from before the current epoch barrier", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "default") });
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    const request = nullMetadataRequest(1_020);
    nowMs = 1_030;
    expect(resolveOrigin(cfg, request)).toEqual({ to: ORIGIN_PEER });

    // Host teardown/reload: a fresh lease and a matching store are not enough,
    // because the request predates the new barrier.
    nowMs = 1_040;
    registry.rotateEpoch();
    nowMs = 1_050;
    lease("default", ORIGIN_PEER);
    nowMs = 1_070;
    expect(resolveOrigin(cfg, request)).toBeNull();
    expect(warnedReasons()).toEqual(["invalid_request_time"]);
  });

  it("serves the exact raw account only — a canonical alias handler gets nothing", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "accta") });
    nowMs = 1_010;
    lease("AcctA", ORIGIN_PEER);
    nowMs = 1_030;
    const request = nullMetadataRequest(1_020);

    // The store canonicalizes what it persists, so the stored "accta" matches
    // the raw "AcctA" handler's canonical form …
    expect(resolveOrigin(cfg, request, "AcctA")).toEqual({ to: ORIGIN_PEER });
    // … but the alias handler holds no claim of its own and gets nothing.
    expect(resolveOrigin(cfg, request, "accta")).toBeNull();
    expect(warnedReasons()).toEqual(["active_no_match"]);
  });

  it("ignores a reassigned binding / identityLinks in the CURRENT config", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "default") });
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_030;
    const request = nullMetadataRequest(1_020);
    expect(resolveOrigin(cfg, request)).toEqual({ to: ORIGIN_PEER });

    // Reassign everything a route recomputation would read. The decision is made
    // from the lease and the persisted entry, so nothing moves.
    cfg.session.identityLinks = [{ channel: "webchannel", ids: [ORIGIN_PEER, OTHER_PEER] }];
    cfg.channels.webchannel.accounts = { other: { binding: { account: OTHER_PEER } } };
    cfg.agents = { rota: { bind: [`webchannel:${OTHER_PEER}`] } };

    expect(resolveOrigin(cfg, request)).toEqual({ to: ORIGIN_PEER });
    expect(warnedReasons()).toEqual([]);
  });

  it("takes the fast path for explicit webchannel metadata without reading the store", () => {
    // A store path that would THROW if it were read proves the fast path never
    // touches it.
    const cfg: any = {
      session: { store: 123 },
      channels: { webchannel: { execApprovals: { enabled: true, approvers: [ORIGIN_PEER] } } },
    };
    const request = {
      id: "exec-fast",
      request: {
        command: "ls",
        sessionKey: SESSION_KEY,
        turnSourceChannel: " WebChannel ",
        turnSourceTo: `  ${ORIGIN_PEER}  `,
      },
      createdAtMs: 1_020,
      expiresAtMs: 1_080,
    };

    expect(resolveOrigin(cfg, request)).toEqual({ to: ORIGIN_PEER });
    expect(warnedReasons()).toEqual([]);
  });

  it("stays silent and returns null for an explicit other channel", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "default") });
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_030;
    const request = nullMetadataRequest(1_020);
    request.request.turnSourceChannel = "signal";
    request.request.turnSourceTo = "+15551234";

    expect(resolveOrigin(cfg, request)).toBeNull();
    // A different channel's approval is a normal non-ownership, not an incident.
    expect(warnedReasons()).toEqual([]);
  });

  it("reports a globally poisoned epoch distinctly from a single ambiguous tuple", () => {
    // A poison-cap overflow drops EVERY fallback in the process until the next
    // teardown. Reporting that as `active_ambiguous` would leave an operator
    // unable to tell a process-wide outage from one confusable pair.
    const capped = new ApprovalOriginLeaseRegistry({ now: () => nowMs, maxPoisonedKeys: 1 });
    slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = capped;
    const claim = (peerId: string, sessionKey: string) =>
      capped.createLease({ rawAccountId: "default", sessionKey, peerId }).activate();
    nowMs = 1_010;
    claim(ORIGIN_PEER, "session-x");
    claim(OTHER_PEER, "session-x");
    claim(ORIGIN_PEER, "session-y");
    claim(OTHER_PEER, "session-y"); // exceeds the cap of 1 ⇒ global escalation
    // A clean tuple with a perfectly matching store is dropped all the same.
    claim(ORIGIN_PEER, SESSION_KEY);
    nowMs = 1_030;

    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "default") });
    expect(resolveOrigin(cfg, nullMetadataRequest(1_020))).toBeNull();
    expect(warnedReasons()).toEqual(["epoch_poisoned"]);
  });

  it("returns null (never throws) when the process-global registry is incompatible", () => {
    // A co-installed build owning the versioned slot must not take the delivery
    // plan down: core awaits this hook unguarded. It is also NOT `sdk_error` —
    // that would point an operator at core instead of at their own plugin set.
    slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = { contractVersion: 2 };
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER, "default") });

    expect(() => resolveOrigin(cfg, nullMetadataRequest(1_020))).not.toThrow();
    expect(resolveOrigin(cfg, nullMetadataRequest(1_020))).toBeNull();
    expect(warnedReasons()).toEqual(["registry_unavailable", "registry_unavailable"]);
  });

  it("never writes the session key, peer id, or stored target into the diagnostic", () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(OTHER_PEER, "default") });
    nowMs = 1_010;
    lease("default", ORIGIN_PEER);
    nowMs = 1_030;
    expect(resolveOrigin(cfg, nullMetadataRequest(1_020))).toBeNull();

    const lines = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("event=webchannel.approval.origin_unresolved");
    expect(line).toContain("sessionKey_present=true");
    // The account is masked; the identifying values are absent entirely.
    expect(line).toContain('accountId="default"');
    expect(line).not.toContain(SESSION_KEY);
    expect(line).not.toContain(ORIGIN_PEER);
    expect(line).not.toContain(OTHER_PEER);
  });
});

/**
 * #123 — a peer must not be able to write into the log stream through a
 * thrown approval error.
 *
 * `approvalId` and `senderId` come straight off the wire: `dispatchInbound`
 * (nats-channel.ts) validates `approval_decision.id` with nothing but
 * `typeof === "string"`, then hands it here. Every message these three throw
 * sites build is logged VERBATIM by the approval-decision handler
 * (nats-account-runtime.ts), so a newline inside the error message forged a
 * fully-formed second log record from inside the error itself.
 *
 * The old templates hard-coded quotes (`approval "${approvalId}"`), which made
 * the sites READ as delimited while escaping nothing — the trap this pins shut.
 * `logSafe` now supplies those quotes for real.
 */
describe("approval error messages are single log records (#123)", () => {
  const FORGED = 'exec-1\nwebchannel: approval "exec-9" resolved by admin';
  const cfg: any = {
    channels: { webchannel: { execApprovals: { enabled: true, approvers: ["alice"] } } },
  };

  beforeEach(() => {
    __approvalAccountBindingTestHook.clear();
  });

  const assertSingleRecord = (message: string) => {
    expect(message.split("\n")).toHaveLength(1);
    expect(message).not.toContain("\n");
    // The injected text survives as inert, escaped evidence.
    expect(message).toContain("\\n");
  };

  /**
   * Await a call that MUST reject and hand back the error. Asserting the
   * rejection happened is part of the helper so a silently-resolving call can
   * never leave the record assertions running against `undefined`.
   */
  async function rejectionOf(call: Promise<unknown>): Promise<Error> {
    let caught: unknown;
    let rejected = false;
    try {
      await call;
    } catch (e) {
      rejected = true;
      caught = e;
    }
    expect(rejected).toBe(true);
    return caught as Error;
  }

  it("an unknown approvalId carrying a newline cannot forge a second record", async () => {
    const err = await rejectionOf(handleApprovalDecision(cfg, FORGED, "deny", "alice"));
    expect(err).toBeInstanceOf(ApprovalBindingMissingError);
    assertSingleRecord(err.message);
    expect(err.message).toContain("exec-1");
    expect(err.message).toContain("unknown or already resolved");
  });

  it("a cross-account replay of a newline-bearing approvalId cannot forge a second record", async () => {
    __approvalAccountBindingTestHook.record(FORGED, "a");
    const err = await rejectionOf(handleApprovalDecision(cfg, FORGED, "deny", "alice", "b"));
    assertSingleRecord(err.message);
    expect(err.message).toContain("refusing cross-account resolve");
  });

  it("a newline-bearing senderId cannot forge a second record", async () => {
    const forgedPeer = "eve\nwebchannel: peer admin is a configured exec approver";
    __approvalAccountBindingTestHook.record("exec-1", null);
    const err = await rejectionOf(handleApprovalDecision(cfg, "exec-1", "deny", forgedPeer));
    assertSingleRecord(err.message);
    expect(err.message).toContain("not a configured exec approver");
  });

  it("renders a well-formed id EXACTLY as before — the quotes moved, they did not change", () => {
    // `logSafe` supplies the quotes the templates used to hard-code, so benign
    // output is byte-identical and the existing assertions on these messages
    // (and any operator's grep) keep matching. That is what makes this fix safe
    // to apply to an error message rather than only at the log site.
    expect(new ApprovalBindingMissingError("exec-1").message).toBe(
      'webchannel: approval "exec-1" is unknown or already resolved ' +
        "(no live delivery binding) — refusing to resolve",
    );
  });
});
