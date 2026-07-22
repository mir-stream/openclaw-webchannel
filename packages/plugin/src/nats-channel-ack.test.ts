/**
 * P0-7b — NatsChannel.sendAck seals an `ack` frame to the peer's `.out`.
 *
 * The agent acks the ingress receipt of `user_message` ids so the client can
 * drain its unacked replay ledger. `sendAck` mirrors `sendTyping`/`sendHistory`:
 * it rides the same `.out` path, is fail-closed before the peer's session key
 * exists (crypto mode), and treats an empty id list as a no-op.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";

import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";

/** Transport that RECORDS published subject/payload pairs. */
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

  it("rejects encrypted construction without keyStore and identityKeyPair", () => {
    const transport = new RecordingTransport();
    expect(() => new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", {}))
      .toThrow(/keyStore and crypto.identityKeyPair/);
    expect(transport.published).toHaveLength(0);
  });
});
