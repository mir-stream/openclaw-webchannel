/**
 * S2 regression: the NATS channel's per-peer + approval maps must stay bounded.
 *
 * The live NATS path has no peer-disconnect signal, so peer subscriptions,
 * session keys, and approval-dedup entries would otherwise grow monotonically
 * with churn on a long-lived gateway. These tests drive the size ceilings and
 * assert the oldest entry is evicted (and its subscription torn down) once a
 * cap is exceeded. (The pinned-device-key store these tests also covered is
 * gone — Phase 6 / W7 removed it with the handshake-verification model.)
 */

import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";

import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";
import { generateKeyPair } from "./e2e-crypto.js";

const cryptoConfig = () => ({
  keyStore: { getOrCreate: () => new Uint8Array(32).fill(7) } as never,
  identityKeyPair: generateKeyPair(),
});

/** Minimal transport: records SUB/UNSUB sids, swallows PUB. */
class FakeTransport extends EventEmitter {
  connected = true;
  readonly subs = new Map<number, string>();
  private sid = 0;
  subscribe(subject: string): number {
    const s = ++this.sid;
    this.subs.set(s, subject);
    return s;
  }
  unsubscribe(sid: number): void {
    this.subs.delete(sid);
  }
  publish(): void {
    /* no-op sink */
  }
}

describe("S2 — NatsChannel memory bounds", () => {
  it("caps tracked peers and evicts the oldest (unsub)", () => {
    const transport = new FakeTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", cryptoConfig(), {
      maxPeers: 3,
    });
    const subs = channel["peerSubscriptions"] as Map<string, number>;

    channel.registerPeer("peer-0");
    channel.registerPeer("peer-1");
    channel.registerPeer("peer-2");
    expect(subs.size).toBe(3);
    expect(transport.subs.size).toBe(3); // one live SUB per peer

    // 4th peer trips the cap → peer-0 (oldest) is evicted.
    channel.registerPeer("peer-3");
    expect(subs.size).toBe(3);
    expect(subs.has("peer-0")).toBe(false);
    expect(subs.has("peer-3")).toBe(true);
    // Its NATS subscription was torn down (no leaked SUB).
    expect(transport.subs.size).toBe(3);
  });

  it("runs peer-retirement cleanup for cap eviction and explicit unregister", () => {
    const transport = new FakeTransport();
    const channel = new NatsChannel(
      transport as unknown as NatsTransport,
      "acct",
      "tenant",
      cryptoConfig(),
      { maxPeers: 1 },
    );
    const retired: string[] = [];
    channel.setPeerUnregisterHandler((peerId) => retired.push(peerId));
    channel.registerPeer("peer-0");
    channel.registerPeer("peer-1");
    channel.unregisterPeer("peer-1");
    expect(retired).toEqual(["peer-0", "peer-1"]);
  });

  it("never evicts under normal (sub-cap) load", () => {
    const transport = new FakeTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", cryptoConfig(), {
      maxPeers: 10_000,
    });
    const subs = channel["peerSubscriptions"] as Map<string, number>;
    for (let i = 0; i < 50; i++) channel.registerPeer(`peer-${i}`);
    expect(subs.size).toBe(50);
    expect(subs.has("peer-0")).toBe(true);
  });

  it("bounds the approval-resolution dedup map, evicting oldest", () => {
    const transport = new FakeTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", cryptoConfig(), {
      maxApprovalResolutions: 3,
    });
    const resolutions = channel["approvalResolutions"] as Map<string, string>;

    for (let i = 0; i < 5; i++) {
      channel.sendApprovalResolved(`peer-${i}`, `approval-${i}`, "allow-once");
    }

    expect(resolutions.size).toBe(3);
    // Oldest two evicted; newest three retained.
    expect(resolutions.has("approval-0")).toBe(false);
    expect(resolutions.has("approval-1")).toBe(false);
    expect(resolutions.has("approval-4")).toBe(true);
  });

  it("keeps first-write-wins dedup working within the retained window", () => {
    const transport = new FakeTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", cryptoConfig(), {
      maxApprovalResolutions: 10,
    });
    channel.registerPeer("peer-a");
    channel.registerPeer("peer-b");

    // First resolver wins; a different peer's duplicate is dropped (false).
    expect(channel.sendApprovalResolved("peer-a", "appr", "allow-once")).toBe(true);
    expect(channel.sendApprovalResolved("peer-b", "appr", "deny")).toBe(false);
  });
});
