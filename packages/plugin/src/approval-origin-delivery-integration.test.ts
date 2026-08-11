/**
 * #93 — origin-routed approval DELIVERY, end to end (plan §6.4).
 *
 * The unit tests prove what `resolveOriginTarget` decides. This file proves what
 * the user actually experiences: which NATS subject an approval frame lands on.
 * It wires the real pieces together — an active lease and a real persisted
 * session-store document, through the capability's `resolveOriginTarget`, into
 * the native runtime's `prepareTarget` / `deliverPending`, onto a `NatsChannel`
 * over a recording transport — and asserts on published subjects.
 *
 * Every assertion is about subjects because that is where the bug was visible:
 * an approval prompt appearing in the WRONG browser session, or (the reported
 * symptom) in none at all while a write tool timed out. The safety property is
 * one-sided and absolute: when the origin is not proven, the count is ZERO
 * publishes — never a best-effort delivery to a plausible peer.
 *
 * The recording transport mirrors the one in `nats-channel-typing.test.ts`; it
 * is the repo's existing way to capture published subjects without a broker.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";
import type { WebChannelPeerChannel } from "./channel-contract.js";
import {
  createClawApprovalCapability,
  createClawApprovalNativeRuntimeSpec,
} from "./approvals.js";
import {
  APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY,
  ApprovalOriginLeaseRegistry,
} from "./approval-origin.js";

const TENANT = "tenant";
const ACCOUNT = "acct";
const SESSION_KEY = "agent:rota:webchannel:acct:direct:d21d9f07-1f2e";
const OTHER_SESSION_KEY = "agent:rota:webchannel:acct:direct:9f07d21d-2e1f";
const ORIGIN_PEER = "PeerCase-A";
const OTHER_PEER = "PeerCase-B";
const ORIGIN_SUBJECT = `webchannel.${TENANT}.${ACCOUNT}.${ORIGIN_PEER}.out`;
const OTHER_SUBJECT = `webchannel.${TENANT}.${ACCOUNT}.${OTHER_PEER}.out`;

/** Transport that RECORDS published subject/payload pairs (plaintext mode). */
class RecordingTransport extends EventEmitter {
  connected = true;
  readonly published: Array<{ subject: string; payload: string }> = [];
  private sid = 0;
  subscribe(): number {
    return ++this.sid;
  }
  unsubscribe(): void {
    /* no-op */
  }
  publish(subject: string, payload: string): void {
    this.published.push({ subject, payload });
  }
}

/** The minimal pending exec view core hands to `buildPendingPayload`. */
function fakePendingExecView(id: string): any {
  return {
    approvalId: id,
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    metadata: [],
    commandText: "write /etc/hosts",
    commandPreview: "write /etc/hosts",
    expiresAtMs: 2_000_000,
    actions: [{ decision: "deny", label: "Deny", style: "danger", command: "/approve deny" }],
  };
}

describe("#93 approval delivery — exact origin subject or nothing", () => {
  const slots = globalThis as unknown as Record<symbol, unknown>;

  let dir: string;
  let storeSeq = 0;
  let savedRegistry: unknown;
  let registry: ApprovalOriginLeaseRegistry;
  let nowMs: number;
  let transport: RecordingTransport;
  let channel: NatsChannel;
  let capability: any;
  let spec: ReturnType<typeof createClawApprovalNativeRuntimeSpec>;
  let approvalSeq = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "webchannel-approval-delivery-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    savedRegistry = slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    nowMs = 1_000;
    registry = new ApprovalOriginLeaseRegistry({ now: () => nowMs });
    slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = registry;

    transport = new RecordingTransport();
    channel = new NatsChannel(transport as unknown as NatsTransport, ACCOUNT, TENANT);
    const peerChannel = channel as unknown as WebChannelPeerChannel;
    capability = createClawApprovalCapability(peerChannel) as any;
    spec = createClawApprovalNativeRuntimeSpec(peerChannel);
  });
  afterEach(() => {
    if (savedRegistry === undefined) delete slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    else slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = savedRegistry;
  });

  /** Fresh store document per call — core caches parsed stores by path+mtime+size. */
  function cfgWithStore(entries: Record<string, unknown>): any {
    const file = join(dir, `sessions-${++storeSeq}.json`);
    writeFileSync(file, JSON.stringify(entries));
    return {
      session: { store: file },
      channels: { webchannel: { execApprovals: { enabled: true, approvers: [ORIGIN_PEER] } } },
    };
  }

  function entry(to: string): unknown {
    return {
      lastChannel: "webchannel",
      lastTo: to,
      lastAccountId: ACCOUNT,
      updatedAt: new Date(1_000).toISOString(),
    };
  }

  function request(createdAtMs: number, sessionKey = SESSION_KEY): any {
    return {
      id: `exec-${++approvalSeq}`,
      request: {
        command: "write /etc/hosts",
        sessionKey,
        turnSourceChannel: null,
        turnSourceTo: null,
        turnSourceAccountId: null,
        turnSourceThreadId: null,
      },
      createdAtMs,
      expiresAtMs: createdAtMs + 60_000,
    };
  }

  function lease(peerId: string, sessionKey = SESSION_KEY) {
    const handle = registry.createLease({ rawAccountId: ACCOUNT, sessionKey, peerId });
    handle.activate();
    return handle;
  }

  /** Subjects that carried an `approval_request` frame. */
  function approvalSubjects(): string[] {
    return transport.published
      .filter((p) => {
        try {
          return (JSON.parse(p.payload) as { type?: string }).type === "approval_request";
        } catch {
          return false;
        }
      })
      .map((p) => p.subject);
  }

  /**
   * The real delivery pipeline: resolve the origin, prepare the target, deliver.
   * Each stage may legitimately refuse, and a refusal means NO publish — which
   * is the property under test.
   */
  async function attemptDelivery(cfg: any, req: any): Promise<void> {
    const base = { cfg, accountId: ACCOUNT, context: undefined };
    const target = await capability.native.resolveOriginTarget({
      ...base,
      approvalKind: "exec",
      request: req,
    });
    if (!target) return;
    const view = fakePendingExecView(req.id);
    const pendingPayload = await spec.presentation.buildPendingPayload({
      ...base,
      request: req,
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    } as any);
    const plannedTarget = { surface: "origin", target } as any;
    const prepared = await spec.transport.prepareTarget({
      ...base,
      plannedTarget,
      request: req,
      approvalKind: "exec",
      view,
      pendingPayload,
    } as any);
    if (!prepared) return;
    await spec.transport.deliverPending({
      ...base,
      plannedTarget,
      preparedTarget: prepared.target,
      request: req,
      approvalKind: "exec",
      view,
      pendingPayload,
    } as any);
  }

  it("publishes to exactly one subject — the proven origin's — when lease and store agree", async () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER) });
    nowMs = 1_010;
    lease(ORIGIN_PEER);
    nowMs = 1_030;

    await attemptDelivery(cfg, request(1_020));

    expect(approvalSubjects()).toEqual([ORIGIN_SUBJECT]);
  });

  it("publishes nothing once the originating run has released its lease", async () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER) });
    nowMs = 1_010;
    const handle = lease(ORIGIN_PEER);
    nowMs = 1_020;
    handle.release();
    nowMs = 1_040;

    await attemptDelivery(cfg, request(1_030));

    expect(approvalSubjects()).toEqual([]);
  });

  it("publishes nothing for a pre-barrier request replayed after a teardown rotation", async () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER) });
    nowMs = 1_010;
    lease(ORIGIN_PEER);
    const replayed = request(1_020);
    nowMs = 1_030;
    registry.rotateEpoch();
    nowMs = 1_060;

    await attemptDelivery(cfg, replayed);

    expect(approvalSubjects()).toEqual([]);
  });

  it("publishes a retained run's genuine post-barrier request to its one origin subject", async () => {
    // The queue lets a running handler settle across teardown, so its lease
    // survives the rotation — and a request it really creates afterwards is
    // deliverable to exactly the peer that started it.
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER) });
    nowMs = 1_010;
    lease(ORIGIN_PEER);
    nowMs = 1_030;
    registry.rotateEpoch();
    nowMs = 1_060;

    await attemptDelivery(cfg, request(1_050));

    expect(approvalSubjects()).toEqual([ORIGIN_SUBJECT]);
  });

  it("publishes nothing when a reload pairs a later lease and store B with an old request", async () => {
    // After the reload, everything "agrees" on B — a later lease AND a stored
    // target. The old request still predates the barrier, so it is refused
    // rather than handed to B.
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(OTHER_PEER) });
    nowMs = 1_010;
    const a = lease(ORIGIN_PEER);
    const old = request(1_020);
    nowMs = 1_030;
    a.release();
    registry.rotateEpoch();
    nowMs = 1_050;
    lease(OTHER_PEER);
    nowMs = 1_070;

    await attemptDelivery(cfg, old);

    expect(approvalSubjects()).toEqual([]);
  });

  it("publishes nothing after an A/B overlap even once A released and only B remains", async () => {
    const cfg = cfgWithStore({ [SESSION_KEY]: entry(OTHER_PEER) });
    nowMs = 1_010;
    const a = lease(ORIGIN_PEER);
    nowMs = 1_012;
    lease(OTHER_PEER);
    nowMs = 1_020;
    a.release();
    nowMs = 1_050;

    await attemptDelivery(cfg, request(1_040));

    expect(approvalSubjects()).toEqual([]);
  });

  it("publishes nothing on any fallback once the epoch escalated to global poison", async () => {
    const poisonRegistry = new ApprovalOriginLeaseRegistry({
      now: () => nowMs,
      maxPoisonedKeys: 1,
    });
    slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = poisonRegistry;
    const claim = (peerId: string, sessionKey: string) =>
      poisonRegistry.createLease({ rawAccountId: ACCOUNT, sessionKey, peerId }).activate();

    // Two overlapped tuples exceed the cap of one, so the whole epoch fails
    // closed instead of evicting the first key's evidence.
    nowMs = 1_010;
    claim(ORIGIN_PEER, OTHER_SESSION_KEY);
    claim(OTHER_PEER, OTHER_SESSION_KEY);
    nowMs = 1_012;
    claim(ORIGIN_PEER, "agent:rota:webchannel:acct:direct:third");
    claim(OTHER_PEER, "agent:rota:webchannel:acct:direct:third");
    // A tuple that never overlapped at all, with a perfectly matching store.
    nowMs = 1_014;
    claim(ORIGIN_PEER, SESSION_KEY);
    nowMs = 1_040;

    const cfg = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER) });
    await attemptDelivery(cfg, request(1_030));

    expect(approvalSubjects()).toEqual([]);
  });

  it("never publishes to a non-origin subject across the whole scenario set", async () => {
    // One channel, several decisions: only the proven one may reach the wire,
    // and B's subject must never appear even when B is the live/stored peer.
    const matching = cfgWithStore({ [SESSION_KEY]: entry(ORIGIN_PEER) });
    nowMs = 1_010;
    const a = lease(ORIGIN_PEER);
    nowMs = 1_030;
    await attemptDelivery(matching, request(1_020)); // publishes to A

    // Stored target overwritten by B while A still holds the lease.
    const overwritten = cfgWithStore({ [SESSION_KEY]: entry(OTHER_PEER) });
    await attemptDelivery(overwritten, request(1_020));

    // A releases; B takes over the tuple and the store.
    nowMs = 1_040;
    a.release();
    nowMs = 1_050;
    lease(OTHER_PEER);
    nowMs = 1_070;
    // A's replayed request under B's live lease and B's stored target.
    await attemptDelivery(overwritten, request(1_020));

    expect(approvalSubjects()).toEqual([ORIGIN_SUBJECT]);
    expect(approvalSubjects()).not.toContain(OTHER_SUBJECT);
  });
});
