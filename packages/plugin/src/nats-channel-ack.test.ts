/**
 * P0-7b — NatsChannel.sendAck seals an `ack` frame to the peer's `.out`.
 *
 * The agent acks the ingress receipt of `user_message` ids so the client can
 * drain its unacked replay ledger. `sendAck` mirrors `sendTyping`/`sendHistory`:
 * it rides the same `.out` path, is fail-closed before the peer's session key
 * exists (crypto mode), and treats an empty id list as a no-op.
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, it, expect, vi } from "vitest";

import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { openEnvelope } from "./e2e-session.js";
import type { IngressResultFrame } from "./ingress-result-chunks.js";

afterEach(() => vi.restoreAllMocks());

/** Transport that RECORDS published subject/payload pairs. */
class RecordingTransport extends EventEmitter {
  connected = true;
  effectiveOutboundLimit = 8 * 1024 * 1024;
  readonly published: Array<{ subject: string; payload: string }> = [];
  failPublishCalls = new Set<number>();
  publishFailure: unknown = new Error("publish failed");
  publishCalls = 0;
  private sid = 0;
  subscribe(): number {
    return ++this.sid;
  }
  unsubscribe(): void {
    /* no-op */
  }
  publish(subject: string, payload: string): void {
    this.publishCalls++;
    if (this.failPublishCalls.has(this.publishCalls)) throw this.publishFailure;
    this.published.push({ subject, payload });
  }
}

function ackFrames(t: RecordingTransport): Array<{ subject: string; ids: string[] }> {
  const out: Array<{ subject: string; ids: string[] }> = [];
  for (const p of t.published) {
    try {
      const parsed = JSON.parse(p.payload) as { type?: string; ids?: string[] };
      if (parsed.type === "ack") out.push({ subject: p.subject, ids: parsed.ids ?? [] });
    } catch {
      /* ciphertext / non-JSON — not a plaintext ack */
    }
  }
  return out;
}

describe("P0-7b — NatsChannel.sendAck", () => {
  it("packs only same-frame cancelled IDs across 64-ID chunks and preserves the committed echo", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");
    const ids = Array.from({ length: 130 }, (_, i) => `wire-${i}`);
    const cancelled = ids.filter((_, i) => i % 2 === 0);
    const committed = [{ random_id: "logical-a", messageId: "stored-a", seq: 7 }];
    expect(channel.sendAck("peer", [...ids, "", "x".repeat(129)], committed,
      [...cancelled, "stray", "", "x".repeat(129)])).toBe(true);
    const frames = transport.published.map(value => JSON.parse(value.payload));
    expect(frames.map(frame => frame.ids.length)).toEqual([64, 64, 2]);
    expect(frames.flatMap(frame => frame.ids)).toEqual(ids);
    expect(frames.flatMap(frame => frame.cancelled ?? [])).toEqual(cancelled);
    expect(frames.map(frame => frame.committed)).toEqual([committed, undefined, undefined]);
    for (const frame of frames) expect(frame.cancelled.every((id: string) => frame.ids.includes(id))).toBe(true);
  });

  it("authenticates cancellation proof at the exact sealed byte limit and withholds it without a key or space", () => {
    const transport = new RecordingTransport();
    const key = new Uint8Array(32).fill(7);
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant",
      { keyStore: { getOrCreate: () => key } as never, identityKeyPair: generateKeyPair() });
    const frame = { type: "ack" as const, ids: ["취소된-id"], cancelled: ["취소된-id"] };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(channel.sendAck("peer", frame.ids, undefined, frame.cancelled)).toBe(false);
    expect(transport.published).toEqual([]);
    channel.registerPeer("peer");
    transport.effectiveOutboundLimit = channel.outboundWireSize("peer", frame)!;
    expect(channel.sendAck("peer", frame.ids, undefined, frame.cancelled)).toBe(true);
    expect(Buffer.byteLength(transport.published[0].payload)).toBe(transport.effectiveOutboundLimit);
    expect(openEnvelope(Buffer.from(transport.published[0].payload), key).message).toEqual(frame);
    expect(() => openEnvelope(Buffer.from(transport.published[0].payload), new Uint8Array(32).fill(8))).toThrow();
    transport.effectiveOutboundLimit--;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(channel.sendAck("peer", frame.ids, undefined, frame.cancelled)).toBe(false);
    expect(transport.published).toHaveLength(1);
    error.mockRestore();
  });

  it("splits mixed cancellation ACKs by actual encrypted bytes without separating proof from its ID", () => {
    const transport = new RecordingTransport();
    const key = new Uint8Array(32).fill(9);
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant",
      { keyStore: { getOrCreate: () => key } as never, identityKeyPair: generateKeyPair() });
    channel.registerPeer("peer");
    const ids = Array.from({ length: 20 }, (_, i) => `요청-${i}-${"한".repeat(12)}`);
    const cancelled = ids.filter((_, i) => i % 2 === 0);
    const committed = [{ random_id: "logical", messageId: "stored", seq: 10 }];
    transport.effectiveOutboundLimit = 650;
    expect(channel.sendAck("peer", ids, committed, cancelled)).toBe(true);
    expect(transport.published.length).toBeGreaterThan(2);
    const frames = transport.published.map(({ payload }) => {
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(650);
      return openEnvelope(Buffer.from(payload), key).message as Extract<IngressResultFrame, { type: "ack" }>;
    });
    expect(frames.flatMap(frame => frame.ids)).toEqual(ids);
    expect(frames.flatMap(frame => frame.cancelled ?? [])).toEqual(cancelled);
    expect(frames.flatMap(frame => frame.committed ?? [])).toEqual(committed);
    for (const frame of frames) expect((frame.cancelled ?? []).every(id => frame.ids.includes(id))).toBe(true);
  });

  it("seals an ack frame with the ids to the peer's .out (plaintext mode)", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");

    expect(channel.sendAck("peer-0", ["id-a", "id-b"])).toBe(true);
    const frames = ackFrames(transport);
    expect(frames).toHaveLength(1);
    expect(frames[0].subject).toBe("webchannel.tenant.acct.peer-0.out");
    expect(frames[0].ids).toEqual(["id-a", "id-b"]);
  });

  it("is a no-op for an empty id list — returns true, publishes nothing", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");

    expect(channel.sendAck("peer-0", [])).toBe(true);
    expect(transport.published).toHaveLength(0);
  });

  it("publishes an id-correlated overloaded rejection and no-ops an empty list", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");

    expect(channel.sendInboundRejected("peer-0", ["id-a"])).toBe(true);
    expect(channel.sendInboundRejected("peer-0", [])).toBe(true);
    expect(transport.published).toHaveLength(1);
    expect(JSON.parse(transport.published[0].payload)).toEqual({
      type: "inbound_rejected",
      ids: ["id-a"],
      reason: "overloaded",
    });
  });

  it("splits at 64 ids and still attempts a later chunk after the first publish fails", () => {
    const transport = new RecordingTransport();
    transport.failPublishCalls.add(1);
    let getterCalls = 0;
    let customInspectCalls = 0;
    const diagnostic = {
      visible: "publish-custom-sentinel",
      get hidden(): string {
        getterCalls++;
        return "getter-must-not-run";
      },
      [Symbol.for("nodejs.util.inspect.custom")](): string {
        customInspectCalls++;
        return "custom-inspect-must-not-run";
      },
    };
    const publishFailure = new Error("publish failed", { cause: "publish-cause-sentinel" });
    publishFailure.stack = "Error: publish failed\n    at publish-stack-sentinel";
    Object.assign(publishFailure, { diagnostic });
    transport.publishFailure = publishFailure;
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");
    const ids = Array.from({ length: 65 }, (_, index) => `id-${index}`);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(channel.sendAck("peer-0", ids)).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toHaveLength(1);
    const record = String(error.mock.calls[0]?.[0]);
    expect(record.split("\n")).toHaveLength(1);
    expect(record).toContain("publish-stack-sentinel");
    expect(record).toContain("publish-cause-sentinel");
    expect(record).toContain("publish-custom-sentinel");
    expect(record).not.toContain("getter-must-not-run");
    expect(record).not.toContain("custom-inspect-must-not-run");
    expect(getterCalls).toBe(0);
    expect(customInspectCalls).toBe(0);
    expect(transport.publishCalls).toBe(2);
    expect(ackFrames(transport)).toEqual([{
      subject: "webchannel.tenant.acct.peer-0.out",
      ids: ["id-64"],
    }]);
  });

  it("accepts the exact effective wire boundary and suppresses boundary +1", () => {
    const exactPayload = JSON.stringify({ type: "ack", ids: ["id-a"] });
    const exactBytes = Buffer.byteLength(exactPayload, "utf8");
    const atBoundary = new RecordingTransport();
    atBoundary.effectiveOutboundLimit = exactBytes;
    const accepted = new NatsChannel(atBoundary as unknown as NatsTransport, "acct", "tenant");
    expect(accepted.sendAck("peer-0", ["id-a"])).toBe(true);
    expect(atBoundary.published).toHaveLength(1);

    const plusOne = new RecordingTransport();
    plusOne.effectiveOutboundLimit = exactBytes - 1;
    const rejected = new NatsChannel(plusOne as unknown as NatsTransport, "acct", "tenant");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(rejected.sendAck("peer-0", ["id-a"])).toBe(false);
    expect(plusOne.published).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never echoes invalid direct/control ids; the 128-byte boundary remains valid", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");
    const validBoundary = "v".repeat(128);
    const invalidPlusOne = "x".repeat(129);

    expect(channel.sendAck("peer-0", [
      invalidPlusOne,
      "",
      null,
      validBoundary,
    ] as unknown as string[])).toBe(true);
    expect(ackFrames(transport)).toEqual([{
      subject: "webchannel.tenant.acct.peer-0.out",
      ids: [validBoundary],
    }]);

    transport.published.length = 0;
    // The `/stop` branch calls this direct channel method with one message id.
    expect(channel.sendAck("peer-0", [invalidPlusOne])).toBe(true);
    expect(transport.published).toHaveLength(0);
  });

  it("rate-limits too-small max_payload warnings without peer or id content", () => {
    const transport = new RecordingTransport();
    transport.effectiveOutboundLimit = 1;
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(channel.sendAck("secret-peer", ["secret-id"])).toBe(false);
    expect(channel.sendInboundRejected("other-peer", ["other-id"])).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]?.[0]);
    expect(text).toContain("effective NATS max_payload");
    expect(text).not.toContain("secret-peer");
    expect(text).not.toContain("secret-id");
    expect(text).not.toContain("other-peer");
    expect(text).not.toContain("other-id");
    expect(transport.published).toHaveLength(0);
  });

  it("rejects encrypted construction without keyStore and identityKeyPair", () => {
    const transport = new RecordingTransport();
    expect(() => new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", {}))
      .toThrow(/keyStore and crypto.identityKeyPair/);
    expect(transport.published).toHaveLength(0);
  });
});
