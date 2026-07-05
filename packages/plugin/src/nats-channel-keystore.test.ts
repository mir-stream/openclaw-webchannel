/**
 * NatsChannel keyStore-mode tests — Phase 6 (multi-device E2E).
 *
 * Drives the production `NatsChannel` with a `ConversationKeyStore` (the
 * register-admission key model): the agent owns a STABLE per-peerId key K,
 * devices receive K wrapped to their X25519 pubkey (register HTTP response),
 * and the legacy `.handshake` negotiation is disabled on this path.
 *
 * Covers the P0 multi-device regression (second device must NOT rotate the
 * first device's key), the register↔auto divergence (F5 / acceptance C), the
 * wrap→unwrap delivery round-trip, and K's restart survival (acceptance B at
 * unit level).
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NatsChannel } from "./nats-channel.js";
import { ConversationKeyStore } from "./conversation-key-store.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { unwrapConversationKey } from "./late-join-decryptor.js";
import {
  keyExchangeFrame,
  parseKeyExchange,
  sealEnvelope,
  openEnvelope,
} from "./e2e-session.js";

// ---------------------------------------------------------------------------
// In-memory NATS broker (echo:false, exact-subject routing) — same fixture
// pattern as nats-channel-crypto.test.ts.
// ---------------------------------------------------------------------------

function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return true;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

class FakeBroker {
  readonly clients: FakeTransport[] = [];
  register(t: FakeTransport): void {
    this.clients.push(t);
  }
  route(subject: string, payload: Buffer, sender: FakeTransport): void {
    for (const c of this.clients) {
      if (c !== sender && c.matches(subject)) c.deliver(subject, payload);
    }
  }
}

class FakeTransport extends EventEmitter {
  connected = true;
  private readonly subs = new Map<number, string>();
  private sidCounter = 0;
  constructor(private readonly broker: FakeBroker) {
    super();
    broker.register(this);
  }
  subscribe(subject: string): number {
    const sid = ++this.sidCounter;
    this.subs.set(sid, subject);
    return sid;
  }
  unsubscribe(sid: number): void {
    this.subs.delete(sid);
  }
  publish(subject: string, payload: string | Buffer | Uint8Array): void {
    this.broker.route(subject, Buffer.from(payload as Uint8Array), this);
  }
  matches(subject: string): boolean {
    for (const s of this.subs.values()) if (subjectMatches(s, subject)) return true;
    return false;
  }
  subscribedSubjects(): string[] {
    return [...this.subs.values()];
  }
  deliver(subject: string, payload: Buffer): void {
    this.emit("message", { subject, payload });
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TENANT = "acme";
const ACCOUNT = "agent-1";
const PEER = "user-42";
const outSubj = `webchannel.${TENANT}.${ACCOUNT}.${PEER}.out`;
const inSubj = `webchannel.${TENANT}.${ACCOUNT}.${PEER}.in`;
const hsSubj = `webchannel.${TENANT}.${ACCOUNT}.${PEER}.handshake`;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webchannel-keystore-channel-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function makeKeyStoreChannel(broker: FakeBroker): {
  channel: NatsChannel;
  agentTransport: FakeTransport;
  store: ConversationKeyStore;
} {
  const agentTransport = new FakeTransport(broker);
  const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
  const channel = new NatsChannel(
    agentTransport as unknown as ConstructorParameters<typeof NatsChannel>[0],
    ACCOUNT,
    TENANT,
    { keyStore: store },
  );
  return { channel, agentTransport, store };
}

/** A "device": subscribes the shared .out and records what it can decrypt with its key. */
function makeDevice(broker: FakeBroker, key: () => Uint8Array | null): {
  transport: FakeTransport;
  decrypted: unknown[];
  failed: number;
} {
  const transport = new FakeTransport(broker);
  transport.subscribe(outSubj);
  const view = { transport, decrypted: [] as unknown[], failed: 0 };
  transport.on("message", (m: { subject: string; payload: Buffer }) => {
    const k = key();
    if (!k) return;
    try {
      view.decrypted.push(openEnvelope(m.payload, k).message);
    } catch {
      view.failed++;
    }
  });
  return view;
}

describe("NatsChannel keyStore mode (register admission)", () => {
  it("registerPeer establishes K immediately — outbound seals with no handshake", () => {
    const broker = new FakeBroker();
    const { channel, store } = makeKeyStoreChannel(broker);
    const device = makeDevice(broker, () => store.get(PEER));

    channel.registerPeer(PEER);
    expect(channel.sendText(PEER, "hello")).toBe(true);
    expect(device.decrypted).toEqual([{ type: "agent_message", text: "hello" }]);
  });

  it("P0 regression: a second device's register does NOT rotate the first device's key", () => {
    const broker = new FakeBroker();
    const { channel, store } = makeKeyStoreChannel(broker);

    channel.registerPeer(PEER);
    const kFirst = store.get(PEER)!;
    // Device A holds its unwrapped copy of K from its own register.
    const deviceA = makeDevice(broker, () => kFirst);

    // Device B (same user → same peerId) registers second.
    channel.registerPeer(PEER);
    expect(Buffer.from(store.get(PEER)!).equals(Buffer.from(kFirst))).toBe(true);

    // The original kill scenario: A must still decrypt inbound after B joined.
    channel.sendText(PEER, "after-B-joined");
    expect(deviceA.decrypted).toEqual([{ type: "agent_message", text: "after-B-joined" }]);
    expect(deviceA.failed).toBe(0);
  });

  it("both devices decrypt the SAME single ciphertext fanout", () => {
    const broker = new FakeBroker();
    const { channel, store } = makeKeyStoreChannel(broker);
    channel.registerPeer(PEER);
    const k = store.get(PEER)!;
    const deviceA = makeDevice(broker, () => k);
    const deviceB = makeDevice(broker, () => k);

    channel.sendText(PEER, "fanout");
    expect(deviceA.decrypted).toEqual([{ type: "agent_message", text: "fanout" }]);
    expect(deviceB.decrypted).toEqual([{ type: "agent_message", text: "fanout" }]);
  });

  it("inbound sealed with K is decrypted and dispatched", () => {
    const broker = new FakeBroker();
    const { channel, store, agentTransport } = makeKeyStoreChannel(broker);
    const seen: unknown[] = [];
    channel.setMessageHandler((_peer, msg) => seen.push(msg));
    channel.registerPeer(PEER);
    const k = store.get(PEER)!;

    const device = new FakeTransport(broker);
    device.publish(
      inSubj,
      sealEnvelope({ accountId: ACCOUNT, tenant: TENANT, sub: PEER }, k, {
        type: "user_message",
        text: "hi agent",
      }),
    );
    expect(seen).toEqual([{ type: "user_message", text: "hi agent" }]);
    void agentTransport;
  });

  it("wrap→unwrap delivery round-trip: the device recovers exactly K", () => {
    const broker = new FakeBroker();
    const { channel, store } = makeKeyStoreChannel(broker);
    channel.registerPeer(PEER);
    const deviceKP = generateKeyPair();

    const wrapped = channel.wrapConversationKeyForDevice(PEER, deviceKP.publicKey);
    expect(wrapped).not.toBeNull();
    const k = unwrapConversationKey(wrapped!, deviceKP.privateKey);
    expect(Buffer.from(k).equals(Buffer.from(store.get(PEER)!))).toBe(true);

    // Negative control: a DIFFERENT device's private key cannot unwrap it.
    const otherKP = generateKeyPair();
    expect(() => unwrapConversationKey(wrapped!, otherKP.privateKey)).toThrow();
  });

  it("wrapConversationKeyForDevice guards: unregistered peer → null; bad key length → throw; legacy channel → null", () => {
    const broker = new FakeBroker();
    const { channel } = makeKeyStoreChannel(broker);
    const deviceKP = generateKeyPair();
    expect(channel.wrapConversationKeyForDevice("never-registered", deviceKP.publicKey)).toBeNull();

    channel.registerPeer(PEER);
    expect(() => channel.wrapConversationKeyForDevice(PEER, new Uint8Array(31))).toThrow(/32 bytes/);

    const legacy = new NatsChannel(
      new FakeTransport(broker) as unknown as ConstructorParameters<typeof NatsChannel>[0],
      ACCOUNT,
      TENANT,
      {},
    );
    legacy.registerPeer(PEER);
    expect(legacy.wrapConversationKeyForDevice(PEER, deviceKP.publicKey)).toBeNull();
  });

  it("divergence (F5): keyStore mode never subscribes nor answers .handshake; legacy mode does", () => {
    const broker = new FakeBroker();
    const { channel, agentTransport, store } = makeKeyStoreChannel(broker);
    channel.registerPeer(PEER);
    expect(agentTransport.subscribedSubjects()).toEqual([inSubj]);

    // Even a directly-delivered rogue handshake frame is refused: no agent
    // key_exchange reply, and K is untouched.
    const kBefore = store.get(PEER)!;
    const browserKP = generateKeyPair();
    const replies: Buffer[] = [];
    const listener = new FakeTransport(broker);
    listener.subscribe(hsSubj);
    listener.on("message", (m: { payload: Buffer }) => replies.push(m.payload));
    agentTransport.deliver(hsSubj, Buffer.from(keyExchangeFrame(browserKP.publicKey)));
    expect(replies).toHaveLength(0);
    expect(Buffer.from(store.get(PEER)!).equals(Buffer.from(kBefore))).toBe(true);

    // Legacy (auto-style) channel on its own broker: handshake IS answered.
    const broker2 = new FakeBroker();
    const legacyTransport = new FakeTransport(broker2);
    const legacy = new NatsChannel(
      legacyTransport as unknown as ConstructorParameters<typeof NatsChannel>[0],
      ACCOUNT,
      TENANT,
      {},
    );
    legacy.registerPeer(PEER);
    const legacyReplies: Buffer[] = [];
    const browser2 = new FakeTransport(broker2);
    browser2.subscribe(hsSubj);
    browser2.on("message", (m: { payload: Buffer }) => legacyReplies.push(m.payload));
    browser2.publish(hsSubj, keyExchangeFrame(browserKP.publicKey));
    expect(legacyReplies).toHaveLength(1);
    expect(parseKeyExchange(legacyReplies[0])).not.toBeNull();
  });

  it("subscribeWildcard in keyStore mode skips the handshake wildcard", () => {
    const broker = new FakeBroker();
    const { channel, agentTransport } = makeKeyStoreChannel(broker);
    channel.subscribeWildcard();
    expect(agentTransport.subscribedSubjects()).toEqual([
      `webchannel.${TENANT}.${ACCOUNT}.*.in`,
    ]);
  });

  it("K survives a gateway restart: a rebuilt channel re-establishes the SAME key (acceptance B, unit level)", () => {
    const broker = new FakeBroker();
    const { channel, store } = makeKeyStoreChannel(broker);
    channel.registerPeer(PEER);
    const k = store.get(PEER)!;
    // A device captured ciphertext before the restart.
    const preRestart = makeDevice(broker, () => k);
    channel.sendText(PEER, "before-restart");

    // "Restart": brand-new broker/transport/channel/store over the same home.
    const broker2 = new FakeBroker();
    const transport2 = new FakeTransport(broker2);
    const store2 = new ConversationKeyStore({ accountId: ACCOUNT, home });
    const channel2 = new NatsChannel(
      transport2 as unknown as ConstructorParameters<typeof NatsChannel>[0],
      ACCOUNT,
      TENANT,
      { keyStore: store2 },
    );
    channel2.registerPeer(PEER);
    expect(Buffer.from(store2.get(PEER)!).equals(Buffer.from(k))).toBe(true);

    // The device's HELD key still opens the new channel's outbound.
    const postRestart = makeDevice(broker2, () => k);
    channel2.sendText(PEER, "after-restart");
    expect(postRestart.decrypted).toEqual([{ type: "agent_message", text: "after-restart" }]);
    expect(preRestart.decrypted).toEqual([{ type: "agent_message", text: "before-restart" }]);
  });

  it("unregister then re-register self-heals from the store (stateless register)", () => {
    const broker = new FakeBroker();
    const { channel, store } = makeKeyStoreChannel(broker);
    channel.registerPeer(PEER);
    const k = store.get(PEER)!;

    channel.unregisterPeer(PEER);
    // In-memory key dropped → fail-closed while unregistered.
    expect(channel.sendText(PEER, "while-gone")).toBe(false);

    channel.registerPeer(PEER);
    const device = makeDevice(broker, () => k);
    expect(channel.sendText(PEER, "back")).toBe(true);
    expect(device.decrypted).toEqual([{ type: "agent_message", text: "back" }]);
  });
});
