/**
 * S2 regression: the NATS channel's per-peer + approval maps must stay bounded.
 *
 * The live NATS path has no peer-disconnect signal, so peer subscriptions,
 * session keys, and approval-dedup entries would otherwise grow monotonically
 * with churn on a long-lived gateway. These tests drive the size ceilings and
 * assert the oldest entry is evicted (and its subscription torn down / pinned
 * key released) once a cap is exceeded.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach } from "vitest";

import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { keyExchangeFrame } from "./e2e-session.js";
import {
  storePinnedDeviceKey,
  getPinnedDeviceKey,
  clearPinnedDeviceKeys,
} from "./auth.js";

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
  beforeEach(() => {
    clearPinnedDeviceKeys();
  });

  it("caps tracked peers and evicts the oldest (unsub + pin release)", () => {
    const transport = new FakeTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", undefined, {
      maxPeers: 3,
    });
    const subs = channel["peerSubscriptions"] as Map<string, number>;

    // The oldest peer also holds a pinned device key — eviction must release it.
    storePinnedDeviceKey("peer-0", "AAAApinned0");

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
    // Its SaaS-attested pin was released.
    expect(getPinnedDeviceKey("peer-0")).toBeNull();
  });

  it("bounds peerSessionKeys on the wildcard/auto path (handshake, no registerPeer)", () => {
    // The live gateway runs admission:"auto" → subscribeWildcard, so peers never
    // call registerPeer; their only footprint is a session key set in
    // handleHandshake. The cap must hold on THIS path too (review finding #1).
    const agentKP = generateKeyPair();
    const transport = new FakeTransport();
    const channel = new NatsChannel(
      transport as unknown as NatsTransport,
      "acct",
      "tenant",
      { keyPair: agentKP },
      { maxPeers: 3 },
    );
    const sessionKeys = channel["peerSessionKeys"] as Map<string, Uint8Array>;
    const subs = channel["peerSubscriptions"] as Map<string, number>;

    // Five distinct browsers complete a handshake via the wildcard subject —
    // messages arrive on the transport, NOT through registerPeer.
    for (let i = 0; i < 5; i++) {
      const browserKP = generateKeyPair();
      transport.emit("message", {
        subject: `webchannel.tenant.acct.peer-${i}.handshake`,
        payload: Buffer.from(keyExchangeFrame(browserKP.publicKey)),
      });
    }

    // Without the wildcard-path bound this would be 5 (unbounded leak).
    expect(sessionKeys.size).toBe(3);
    expect(sessionKeys.has("peer-0")).toBe(false); // oldest evicted
    expect(sessionKeys.has("peer-4")).toBe(true);
    // registerPeer was never involved on this path.
    expect(subs.size).toBe(0);
  });

  it("never evicts under normal (sub-cap) load", () => {
    const transport = new FakeTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", undefined, {
      maxPeers: 10_000,
    });
    const subs = channel["peerSubscriptions"] as Map<string, number>;
    for (let i = 0; i < 50; i++) channel.registerPeer(`peer-${i}`);
    expect(subs.size).toBe(50);
    expect(subs.has("peer-0")).toBe(true);
  });

  it("bounds the approval-resolution dedup map, evicting oldest", () => {
    const transport = new FakeTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", undefined, {
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
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant", undefined, {
      maxApprovalResolutions: 10,
    });

    // First resolver wins; a different peer's duplicate is dropped (false).
    expect(channel.sendApprovalResolved("peer-a", "appr", "allow-once")).toBe(true);
    expect(channel.sendApprovalResolved("peer-b", "appr", "deny")).toBe(false);
  });
});
