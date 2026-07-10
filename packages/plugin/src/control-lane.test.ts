import { describe, it, expect, vi } from "vitest";

import { createInboundDebouncer } from "openclaw/plugin-sdk/reply-runtime";

import {
  isControlLaneMessage,
  isExplicitAbortCommand,
  shouldDropBufferedInputOnStop,
} from "./control-lane.js";
import { resolveCommandGate } from "./command-gate.js";
import { createSerializedInboundDispatcher, coalesceUserMessages } from "./inbound-queue.js";
import {
  createIngressOnFlush,
  recordCancelledInboundItems,
} from "./ingress-dedupe.js";
import type { InboundWsMessage } from "./transport.js";

/**
 * P1-8a — the out-of-band control lane. Two seams are covered here:
 *
 *  1. `isControlLaneMessage` — the routing PREDICATE that decides whether an
 *     inbound frame is an abort ("/stop") that must bypass the FIFO. We call the
 *     real `isAbortRequestText` through it (no mocking), so this also pins that
 *     the vocabulary we rely on ("/stop", "stop", …) actually matches.
 *
 *  2. The BYPASS itself — a control-lane message routed out-of-band must run
 *     even while a normal turn is still occupying the per-session FIFO. We mirror
 *     index-nats.ts's routing branch exactly and prove the abort handler runs
 *     while a never-resolving queued turn holds the chain.
 */

const userMessage = (text: string): InboundWsMessage => ({ type: "user_message", text });

describe("isControlLaneMessage", () => {
  it("is true for abort requests ('/stop', 'stop', 'Stop.')", () => {
    expect(isControlLaneMessage(userMessage("/stop"))).toBe(true);
    expect(isControlLaneMessage(userMessage("stop"))).toBe(true);
    expect(isControlLaneMessage(userMessage("Stop."))).toBe(true);
  });

  it("is false for ordinary user text", () => {
    expect(isControlLaneMessage(userMessage("what is the weather"))).toBe(false);
    expect(isControlLaneMessage(userMessage("please continue"))).toBe(false);
    expect(isControlLaneMessage(userMessage(""))).toBe(false);
  });

  it("is false for non-user_message frames (approvals, history)", () => {
    expect(
      isControlLaneMessage({ type: "approval_decision", id: "a1", decision: "allow-once" }),
    ).toBe(false);
    expect(isControlLaneMessage({ type: "load_history", limit: 20 })).toBe(false);
  });
});

describe("isExplicitAbortCommand", () => {
  it("is true ONLY for the typed '/stop' (case- and whitespace-insensitive)", () => {
    expect(isExplicitAbortCommand(userMessage("/stop"))).toBe(true);
    expect(isExplicitAbortCommand(userMessage("/STOP "))).toBe(true);
  });

  it("is false for NL abort words that still route on the control lane", () => {
    // These abort the running turn (isControlLaneMessage true) but must NOT
    // drop buffered input — so isExplicitAbortCommand is false for them.
    expect(isExplicitAbortCommand(userMessage("stop"))).toBe(false);
    expect(isExplicitAbortCommand(userMessage("wait"))).toBe(false);
    expect(isExplicitAbortCommand(userMessage("/stop now"))).toBe(false);
  });

  it("is false for non-user_message frames", () => {
    expect(
      isExplicitAbortCommand({ type: "approval_decision", id: "a1", decision: "allow-once" }),
    ).toBe(false);
  });
});

describe("shouldDropBufferedInputOnStop", () => {
  // Real gate outputs (not hand-built stubs) so this stays honest against the
  // actual command-gate mirror the production wiring uses.
  const noAllowlist = resolveCommandGate({}, "default");
  const allowlistWithPeer = resolveCommandGate(
    { commands: { allowFrom: { webchannel: ["alice"] } } },
    "default",
  );
  const allowlistWithoutPeer = allowlistWithPeer; // same gate, different peer queried

  it("drops on explicit /stop when NO allowlist is configured (stamp authorizes everyone)", () => {
    expect(noAllowlist.delegated).toBe(false);
    expect(shouldDropBufferedInputOnStop(userMessage("/stop"), noAllowlist, "alice")).toBe(true);
  });

  it("drops on explicit /stop when an allowlist is configured AND the peer is listed", () => {
    expect(allowlistWithPeer.delegated).toBe(true);
    expect(shouldDropBufferedInputOnStop(userMessage("/stop"), allowlistWithPeer, "alice")).toBe(
      true,
    );
  });

  it("does NOT drop on explicit /stop when an allowlist is configured and the peer is NOT listed", () => {
    // Core would refuse this peer's abort → the running turn survives, so the
    // buffered input must be preserved (all-or-nothing).
    expect(shouldDropBufferedInputOnStop(userMessage("/stop"), allowlistWithoutPeer, "bob")).toBe(
      false,
    );
  });

  it("never drops for NL abort text, regardless of gate", () => {
    expect(shouldDropBufferedInputOnStop(userMessage("stop please"), noAllowlist, "alice")).toBe(
      false,
    );
    expect(shouldDropBufferedInputOnStop(userMessage("wait"), noAllowlist, "alice")).toBe(false);
    // Even a listed peer under no allowlist: NL text is not an explicit /stop.
    expect(shouldDropBufferedInputOnStop(userMessage("stop"), allowlistWithPeer, "alice")).toBe(
      false,
    );
  });
});

describe("control-lane bypass of the per-session FIFO", () => {
  /**
   * The exact routing branch index-nats.ts runs per inbound frame: abort frames
   * go straight to a fire-and-forget control-lane handler; everything else is
   * enqueued on the per-session serializing dispatcher.
   */
  function route(
    message: InboundWsMessage,
    seam: {
      dispatch: (sessionKey: string, message: InboundWsMessage) => void;
      controlLane: (message: InboundWsMessage) => void;
    },
  ): void {
    if (message.type !== "user_message") return;
    if (isControlLaneMessage(message)) {
      seam.controlLane(message);
      return;
    }
    seam.dispatch("s1", message);
  }

  it("runs a control-lane abort even while a normal turn holds the FIFO", async () => {
    const ran: string[] = [];

    // A normal turn that NEVER settles — it occupies the session's FIFO chain
    // for the rest of the test, so anything queued behind it can't run.
    const { dispatch, pendingSessions } = createSerializedInboundDispatcher<InboundWsMessage>(
      (_sessionKey, message) => {
        ran.push(`fifo:${(message as { text: string }).text}`);
        return new Promise<void>(() => {}); // never resolves
      },
    );

    const controlLane = (message: InboundWsMessage): void => {
      ran.push(`abort:${(message as { text: string }).text}`);
    };

    // A normal message starts and wedges the chain.
    route(userMessage("run a long task"), { dispatch, controlLane });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ran).toEqual(["fifo:run a long task"]);
    expect(pendingSessions()).toBe(1); // the never-resolving turn holds the chain

    // The abort is routed out-of-band: it runs immediately, NOT queued behind
    // the wedged turn.
    route(userMessage("/stop"), { dispatch, controlLane });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ran).toEqual(["fifo:run a long task", "abort:/stop"]);
  });
});

describe("control-lane /stop ingress ack (P0-7b)", () => {
  /**
   * The control lane bypasses the debouncer/onFlush, so it is never deduped and
   * never acked there. index-nats.ts acks the control-lane frame directly when it
   * carries an id, so the client's unacked ledger entry drains (else every
   * reconnect would replay the /stop). Mirror that routing branch's ack step.
   */
  function routeControlLane(
    message: InboundWsMessage & { id?: string },
    sendAck: (peerId: string, ids: string[]) => void,
    peerId = "peer-1",
  ): void {
    if (message.type !== "user_message") return;
    if (!isControlLaneMessage(message)) return;
    if (message.id) sendAck(peerId, [message.id]);
  }

  it("acks a /stop that carries an id", () => {
    const acks: Array<{ peerId: string; ids: string[] }> = [];
    routeControlLane(
      { type: "user_message", text: "/stop", id: "wire-9" },
      (peerId, ids) => acks.push({ peerId, ids }),
    );
    expect(acks).toEqual([{ peerId: "peer-1", ids: ["wire-9"] }]);
  });

  it("does not ack an id-less /stop (older client)", () => {
    const acks: Array<{ peerId: string; ids: string[] }> = [];
    routeControlLane(
      { type: "user_message", text: "/stop" },
      (peerId, ids) => acks.push({ peerId, ids }),
    );
    expect(acks).toEqual([]);
  });
});

describe("control-lane /stop cancels debounce-buffered messages without leaving a replay (P0-7b)", () => {
  type Item = { peerId: string; message: { type: "user_message"; text: string; id?: string } };
  const item = (peerId: string, text: string, id?: string): Item => ({
    peerId,
    message: { type: "user_message", text, ...(id !== undefined ? { id } : {}) },
  });
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** Namespace-aware fake of checkAndRecord: true first time, false afterwards. */
  function fakeChecker() {
    const seen = new Set<string>();
    return vi.fn(async (key: string, opts?: { namespace?: string }) => {
      const composite = `${opts?.namespace ?? "global"} ${key}`;
      if (seen.has(composite)) return false;
      seen.add(composite);
      return true;
    });
  }

  /**
   * A debouncer wired exactly as index-nats.ts: onFlush is the REAL
   * `createIngressOnFlush` (dedupe + ack id-carrying items + dispatch); onCancel
   * records + acks the dropped items via `recordCancelledInboundItems`. A LONG
   * debounce keeps a message buffered so `cancelKey` (the /stop path) can drop it
   * before it ever flushes.
   */
  function buildSeam(accountId: string, checkAndRecord: ReturnType<typeof fakeChecker>) {
    const dispatched: string[] = [];
    const acks: Array<{ peerId: string; ids: string[] }> = [];
    const sendAck = (peerId: string, ids: string[]) => acks.push({ peerId, ids });
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 50,
      serializeImmediate: true,
      buildKey: (i) => i.peerId,
      onFlush: createIngressOnFlush<Item>({
        accountId,
        checkAndRecord,
        dispatch: (_peerId, message) => dispatched.push(message.text),
        coalesce: coalesceUserMessages,
        sendAck,
      }),
      onCancel: (items) => {
        void recordCancelledInboundItems(items, accountId, checkAndRecord, sendAck);
      },
    });
    return { debouncer, dispatched, acks };
  }

  it("a /stop-cancelled buffered message is acked, and its later replay is dropped as a duplicate", async () => {
    const checkAndRecord = fakeChecker();
    const { debouncer, dispatched, acks } = buildSeam("acct", checkAndRecord);

    // A message enters the (long) debounce window — buffered, not yet flushed.
    void debouncer.enqueue(item("p1", "please run the long job", "idK"));
    // The user immediately sends /stop → index-nats calls cancelKey → onCancel.
    expect(debouncer.cancelKey("p1")).toBe(true);
    await wait(10);

    // The cancelled message was acked (drains the client ledger) and never ran.
    expect(acks).toEqual([{ peerId: "p1", ids: ["idK"] }]);
    expect(dispatched).toEqual([]);

    // The client (not yet knowing the ack, e.g. it was offline) replays the SAME
    // id after reconnect. It must be dropped as a duplicate — the killed text
    // must NEVER run a turn.
    void debouncer.enqueue(item("p1", "please run the long job", "idK"));
    await wait(80);
    expect(dispatched).toEqual([]); // still nothing dispatched
  });
});
