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
import { describe, it, expect } from "vitest";

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
