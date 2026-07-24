import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationKeyCapacityError,
  ConversationKeyStore,
} from "./conversation-key-store.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";

class RecordingTransport extends EventEmitter {
  connected = true;
  deliveries = 0;
  readonly subjects = new Map<number, string>();
  private sid = 0;
  subscribe(subject: string): number {
    const sid = ++this.sid;
    this.subjects.set(sid, subject);
    return sid;
  }
  unsubscribe(sid: number): void {
    this.subjects.delete(sid);
  }
  publish(): void {}
  deliver(subject: string, payload: Buffer): void {
    if (![...this.subjects.values()].includes(subject)) return;
    this.deliveries++;
    this.emit("message", { subject, payload });
  }
}

function channel(transport: RecordingTransport, maxPeers = 10): NatsChannel {
  const keyStore = { getOrCreate: vi.fn(() => new Uint8Array(32).fill(7)) };
  return new NatsChannel(
    transport as unknown as NatsTransport,
    "acct",
    "tenant",
    { keyStore: keyStore as never, identityKeyPair: generateKeyPair() },
    { maxPeers },
  );
}

describe("authenticated subscription boundary", () => {
  it("subscribes only .register at startup and adds .in only after registerPeer", () => {
    const transport = new RecordingTransport();
    const sut = channel(transport);
    const turns = vi.fn();
    sut.setMessageHandler(turns);
    sut.subscribeRegister();
    expect([...transport.subjects.values()]).toEqual(["webchannel.tenant.acct.*.register"]);

    transport.deliver("webchannel.tenant.acct.peer.in", Buffer.from("pre-register"));
    expect(transport.deliveries).toBe(0);
    expect(turns).not.toHaveBeenCalled();

    sut.registerPeer("peer");
    expect([...transport.subjects.values()]).toContain("webchannel.tenant.acct.peer.in");
    transport.deliver("webchannel.tenant.acct.peer.in", Buffer.from("post-register"));
    expect(transport.deliveries).toBe(1);
  });

  it("bounds peerSessionKeys through registerPeer", () => {
    const transport = new RecordingTransport();
    const sut = channel(transport, 2);
    sut.registerPeer("a");
    sut.registerPeer("b");
    sut.registerPeer("c");
    const keys = sut["peerSessionKeys"] as Map<string, Uint8Array>;
    expect([...keys.keys()]).toEqual(["b", "c"]);
  });

  it("does not leak subscription or session state when key acquisition throws", () => {
    const transport = new RecordingTransport();
    const keyStore = { getOrCreate: vi.fn(() => { throw new Error("disk failure"); }) };
    const sut = new NatsChannel(
      transport as unknown as NatsTransport,
      "acct",
      "tenant",
      { keyStore: keyStore as never, identityKeyPair: generateKeyPair() },
    );
    expect(() => sut.registerPeer("peer")).toThrow(/disk failure/);
    expect(sut["peerSubscriptions"].size).toBe(0);
    expect(sut["peerSessionKeys"].size).toBe(0);
    expect(transport.subjects.size).toBe(0);
  });

  it("rejects real key-store capacity before evicting any live peer", () => {
    const home = mkdtempSync(join(tmpdir(), "webchannel-admission-capacity-"));
    try {
      const transport = new RecordingTransport();
      const store = new ConversationKeyStore({
        tenant: "tenant",
        accountId: "acct",
        home,
        maxKeys: 2,
        onCapacityWarning: () => {},
      });
      const sut = new NatsChannel(
        transport as unknown as NatsTransport,
        "acct",
        "tenant",
        { keyStore: store, identityKeyPair: generateKeyPair() },
        { maxPeers: 2 },
      );

      sut.registerPeer("p1");
      sut.registerPeer("p2");
      const p1 = store.get("p1")!;
      const p2 = store.get("p2")!;

      expect(() => sut.registerPeer("p3")).toThrow(ConversationKeyCapacityError);
      expect([...sut["peerSubscriptions"].keys()]).toEqual(["p1", "p2"]);
      expect([...sut["peerSessionKeys"].keys()]).toEqual(["p1", "p2"]);
      expect([...transport.subjects.values()]).toEqual([
        "webchannel.tenant.acct.p1.in",
        "webchannel.tenant.acct.p2.in",
      ]);
      expect(store.get("p3")).toBeNull();
      expect(Buffer.from(store.get("p1")!).equals(Buffer.from(p1))).toBe(true);
      expect(Buffer.from(store.get("p2")!).equals(Buffer.from(p2))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
