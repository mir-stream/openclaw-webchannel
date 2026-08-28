/**
 * P0-6 regression: the NATS channel must honor `capabilities.typing: "off"`.
 *
 * The typing gate previously existed ONLY on the legacy WS transport, so
 * `NatsChannel.sendTyping` published a `typing` frame unconditionally and an
 * operator's off-toggle was silently ignored on the NATS path. These tests drive
 * the `setTypingEnabled` gate directly on the channel (index-nats wires it from
 * the account's resolved `capabilities.typing`).
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";

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

function typingFrames(t: RecordingTransport): Array<{ subject: string; payload: string }> {
  return t.published.filter((p) => {
    try {
      return (JSON.parse(p.payload) as { type?: string }).type === "typing";
    } catch {
      return false;
    }
  });
}

describe("P0-6 — NatsChannel typing gate", () => {
  it("emits a typing frame by default (gate enabled)", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");

    expect(channel.sendTyping("peer-0")).toBe(true);
    const frames = typingFrames(transport);
    expect(frames).toHaveLength(1);
    expect(frames[0].subject).toBe("webchannel.tenant.acct.peer-0.out");
  });

  it("is a no-op after setTypingEnabled(false) — returns false, publishes nothing", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");

    channel.setTypingEnabled(false);
    expect(channel.sendTyping("peer-0")).toBe(false);
    expect(typingFrames(transport)).toHaveLength(0);
  });

  it("emits again after re-enabling", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");

    channel.setTypingEnabled(false);
    expect(channel.sendTyping("peer-0")).toBe(false);

    channel.setTypingEnabled(true);
    expect(channel.sendTyping("peer-0")).toBe(true);
    expect(typingFrames(transport)).toHaveLength(1);
  });
});

describe("#153 — live inbound typing/history boundary", () => {
  it("drops an inbound typing frame before the user-message or history handlers", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(
      transport as unknown as NatsTransport,
      "acct",
      "tenant",
    );
    const onUserMessage = vi.fn();
    const onLoadHistory = vi.fn();
    channel.setMessageHandler(onUserMessage);
    channel.setLoadHistoryHandler(onLoadHistory);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const subject = "webchannel.tenant.acct.peer-0.in";
    const deliver = (message: unknown) =>
      transport.emit("message", {
        subject,
        payload: Buffer.from(JSON.stringify(message)),
      });

    deliver({ type: "typing", typing: true });

    expect(onUserMessage).not.toHaveBeenCalled();
    expect(onLoadHistory).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown message type: "typing"'),
    );

    // Positive controls prove this drove NatsChannel's real dispatch boundary:
    // user input reaches the live turn handler, while history stays delegated
    // to the core-transcript load handler rather than any deleted local store.
    deliver({ type: "user_message", text: "hello", id: "turn-1" });
    deliver({ type: "load_history", before: "cursor-1", limit: 10 });
    expect(onUserMessage).toHaveBeenCalledOnce();
    expect(onLoadHistory).toHaveBeenCalledWith("peer-0", {
      before: "cursor-1",
      limit: 10,
    });
    warnSpy.mockRestore();
  });
});

describe("#320 — the composite history cursor crosses the inbound dispatch", () => {
  it("forwards `beforeTurnId` to the load-history handler", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");
    const onLoadHistory = vi.fn();
    channel.setLoadHistoryHandler(onLoadHistory);

    transport.emit("message", {
      subject: "webchannel.tenant.acct.peer-0.in",
      payload: Buffer.from(
        JSON.stringify({
          type: "load_history",
          before: "tool-activity-1",
          beforeTurnId: "turn-b",
          limit: 10,
        }),
      ),
    });

    // ⚠️ THE FIELD IS ASSERTED DIRECTLY, NOT VIA A WHOLE-OBJECT
    // `toHaveBeenCalledWith`, AND THAT IS THE WHOLE POINT OF THIS TEST.
    // `toHaveBeenCalledWith` compares with `toEqual` semantics, which treat an
    // ABSENT key and a present-but-`undefined` key as equal — so the sibling
    // expectation above (`{before, limit}`) passes identically whether or not
    // `nats-channel.ts` puts `beforeTurnId` on the request it builds, and an
    // expectation naming all three fields would too. The field is OPTIONAL on
    // the wire type, so deleting the forwarding line also typechecks; without a
    // direct read the composite cursor degrades to id-only in silence and the
    // tool-cursor paging repair (#320) is undone at the very first hop.
    const [peerId, request] = onLoadHistory.mock.calls[0] as [
      string,
      { before?: string; beforeTurnId?: string; limit?: number },
    ];
    expect(peerId).toBe("peer-0");
    expect(request.beforeTurnId).toBe("turn-b");
    // Positive controls: the two halves that already travelled still do, so a
    // failure above names the new field rather than a broken dispatch.
    expect(request.before).toBe("tool-activity-1");
    expect(request.limit).toBe(10);
  });
});

describe("approval decision reverse path", () => {
  it("dispatches a decoded decision with peer/id/decision and rejects malformed input", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");
    const handler = vi.fn();
    channel.setApprovalDecisionHandler(handler);
    transport.emit("message", { subject: "webchannel.tenant.acct.peer-0.in", payload: Buffer.from(JSON.stringify({ type: "approval_decision", id: "exec-1", decision: "deny" })) });
    expect(handler).toHaveBeenCalledWith("peer-0", "exec-1", "deny");
    handler.mockClear();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    transport.emit("message", { subject: "webchannel.tenant.acct.peer-0.in", payload: Buffer.from(JSON.stringify({ type: "approval_decision", id: "exec-1", decision: "bogus" })) });
    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid approval_decision from "peer-0"'),
    );

    warnSpy.mockClear();
    transport.emit("message", { subject: "webchannel.tenant.acct.peer-0.in", payload: Buffer.from(JSON.stringify({ type: "approval_decision", id: 42, decision: "deny" })) });
    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid approval_decision from "peer-0"'),
    );
    warnSpy.mockRestore();
  });
});
