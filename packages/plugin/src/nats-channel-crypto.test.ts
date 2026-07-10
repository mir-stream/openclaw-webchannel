/**
 * NatsChannel encrypt-by-construction tests.
 *
 * Drives the production `NatsChannel` in crypto mode against an in-memory NATS
 * broker (echo:false, exact-subject routing) and a hand-driven "browser" peer
 * built from the same e2e-crypto / e2e-session primitives the live gate uses.
 *
 * Covers:
 *  - the X25519 handshake + encrypted round-trip (browser ↔ agent),
 *  - wiretap evidence: the relay sees ChaCha20-Poly1305 envelopes, never plaintext,
 *  - fail-closed: before the handshake the channel neither emits plaintext outbound
 *    nor processes inbound; a frame sealed with the wrong key is dropped.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";

import { NatsChannel } from "./nats-channel.js";
import type { InboundWsMessage } from "./nats-channel.js";
import { generateKeyPair, encrypt } from "./e2e-crypto.js";
import {
  deriveConversationKey,
  keyExchangeFrame,
  parseKeyExchange,
  sealEnvelope,
  openEnvelope,
} from "./e2e-session.js";

// ---------------------------------------------------------------------------
// In-memory NATS broker (echo:false, exact-subject routing)
// ---------------------------------------------------------------------------

/** NATS subject match: `*` matches one token, `>` matches the rest. */
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
  /** Deliver to every subscribed client EXCEPT the publisher (echo:false). */
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
    const buf = Buffer.isBuffer(payload)
      ? payload
      : typeof payload === "string"
        ? Buffer.from(payload)
        : Buffer.from(payload);
    this.broker.route(subject, buf, this);
  }
  matches(subject: string): boolean {
    for (const s of this.subs.values()) if (subjectMatches(s, subject)) return true;
    return false;
  }
  deliver(subject: string, payload: Buffer): void {
    this.emit("message", { subject, payload });
  }
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const TENANT = "acme";
const AGENT = "agent-1";
const PEER = "user-42";
const inSubj = `webchannel.${TENANT}.${AGENT}.${PEER}.in`;
const outSubj = `webchannel.${TENANT}.${AGENT}.${PEER}.out`;
const hsSubj = `webchannel.${TENANT}.${AGENT}.${PEER}.handshake`;

type Harness = {
  broker: FakeBroker;
  channel: NatsChannel;
  browser: FakeTransport;
  wiretap: FakeTransport;
  wirePayloads: Array<{ subject: string; text: string }>;
  inbound: InboundWsMessage[];
  browserReplies: unknown[];
  browserSessionKey: () => Uint8Array | null;
  doHandshake: () => void;
};

function makeHarness(opts: { admission?: "register" | "wildcard" } = {}): Harness {
  const broker = new FakeBroker();

  // Agent transport + crypto channel.
  const agentTransport = new FakeTransport(broker);
  const channel = new NatsChannel(
    agentTransport as unknown as ConstructorParameters<typeof NatsChannel>[0],
    AGENT,
    TENANT,
    {},
  );
  const inbound: InboundWsMessage[] = [];
  channel.setMessageHandler((_peer, msg) => {
    inbound.push(msg);
    // Echo a reply so we can verify the outbound seal path.
    channel.sendText(_peer, `reply:${msg.type === "user_message" ? msg.text : ""}`);
  });
  if (opts.admission === "wildcard") {
    channel.subscribeWildcard(); // `admission:"auto"` — no per-peer registerPeer
  } else {
    channel.registerPeer(PEER);
  }

  // Passive wiretap (the untrusted relay's vantage point).
  const wiretap = new FakeTransport(broker);
  wiretap.subscribe(inSubj);
  wiretap.subscribe(outSubj);
  const wirePayloads: Array<{ subject: string; text: string }> = [];
  wiretap.on("message", (m: { subject: string; payload: Buffer }) => {
    wirePayloads.push({ subject: m.subject, text: m.payload.toString("utf8") });
  });

  // Hand-driven browser peer.
  const browser = new FakeTransport(broker);
  browser.subscribe(hsSubj);
  browser.subscribe(outSubj);
  const browserKP = generateKeyPair();
  let browserSessionKey: Uint8Array | null = null;
  const browserReplies: unknown[] = [];
  browser.on("message", (m: { subject: string; payload: Buffer }) => {
    if (m.subject === hsSubj) {
      const agentPub = parseKeyExchange(m.payload);
      if (agentPub) browserSessionKey = deriveConversationKey(browserKP.privateKey, agentPub);
      return;
    }
    if (m.subject === outSubj && browserSessionKey) {
      browserReplies.push(openEnvelope(m.payload, browserSessionKey).message);
    }
  });

  const doHandshake = (): void => {
    browser.publish(hsSubj, keyExchangeFrame(browserKP.publicKey));
  };

  return {
    broker,
    channel,
    browser,
    wiretap,
    wirePayloads,
    inbound,
    browserReplies,
    browserSessionKey: () => browserSessionKey,
    doHandshake,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NatsChannel (encrypt-by-construction)", () => {
  it("completes the X25519 handshake and round-trips an encrypted message", () => {
    const h = makeHarness();
    h.doHandshake();
    expect(h.browserSessionKey()).not.toBeNull();
    const key = h.browserSessionKey()!;

    // Browser → agent (sealed)
    h.browser.publish(inSubj, sealEnvelope({ accountId: AGENT, tenant: TENANT, sub: PEER }, key, {
      type: "user_message",
      text: "hello agent",
    }));

    // Agent decrypted the inbound...
    expect(h.inbound).toEqual([{ type: "user_message", text: "hello agent" }]);
    // ...and the browser decrypted the agent's sealed reply.
    expect(h.browserReplies).toEqual([{ type: "agent_message", text: "reply:hello agent" }]);
  });

  it("fires the handshake-complete handler once the session key exists, so a snapshot sent from it is encryptable and delivered", () => {
    const h = makeHarness();
    // Wire a handshake-complete handler that sends an initial history snapshot —
    // this is exactly how the plugin defers hydration until the key is ready.
    const firedFor: string[] = [];
    h.channel.setHandshakeCompleteHandler((peerId) => {
      firedFor.push(peerId);
      h.channel.sendHistory(peerId, [{ id: "m1", role: "user", text: "earlier turn" }]);
    });

    // Before the handshake the handler has not fired and nothing is deliverable.
    expect(firedFor).toEqual([]);

    h.doHandshake();

    // It fired exactly once, for this peer, AFTER the session key was set...
    expect(firedFor).toEqual([PEER]);
    expect(h.browserSessionKey()).not.toBeNull();
    // ...and the snapshot it sent decrypts on the browser (would have been
    // fail-closed "no session key yet" if sent from the pre-handshake register hop).
    expect(h.browserReplies).toEqual([
      { type: "history", messages: [{ id: "m1", role: "user", text: "earlier turn" }] },
    ]);
  });

  it("#15: sendApprovalSnapshot emits {type:'approval_snapshot', approvals} through the sealed .out path", () => {
    const h = makeHarness();
    h.doHandshake();
    expect(h.browserSessionKey()).not.toBeNull();

    const approvals = [
      {
        id: "exec-1",
        kind: "exec" as const,
        title: "Run command",
        prompt: "rm -rf /tmp/cache",
        options: [{ decision: "allow-once" as const, label: "Allow", style: "success" }],
        expiresAtMs: 1_000,
      },
    ];
    // Guards the un-typechecked facade seam (NatsChannel is reached via
    // `as unknown as` casts): the frame is E2E-sealed and decrypts on the browser.
    expect(h.channel.sendApprovalSnapshot(PEER, approvals)).toBe(true);
    expect(h.browserReplies).toEqual([{ type: "approval_snapshot", approvals }]);

    // An EMPTY snapshot is a meaningful signal and must be delivered too.
    expect(h.channel.sendApprovalSnapshot(PEER, [])).toBe(true);
    expect(h.browserReplies.at(-1)).toEqual({ type: "approval_snapshot", approvals: [] });

    // #19: recently-resolved outcomes ride the SAME sealed path when supplied.
    const resolved = [{ id: "exec-0", decision: "deny" as const }];
    expect(h.channel.sendApprovalSnapshot(PEER, approvals, resolved)).toBe(true);
    expect(h.browserReplies.at(-1)).toEqual({ type: "approval_snapshot", approvals, resolved });
    // An empty/omitted resolved list keeps the frame free of the field (back-compat).
    expect(h.channel.sendApprovalSnapshot(PEER, approvals, [])).toBe(true);
    expect(h.browserReplies.at(-1)).toEqual({ type: "approval_snapshot", approvals });
  });

  it("does NOT re-fire the snapshot for a duplicate handshake (client retry / RTT race)", () => {
    const h = makeHarness();
    const firedFor: string[] = [];
    h.channel.setHandshakeCompleteHandler((peerId) => firedFor.push(peerId));

    // Same browser key republished (the bounded handshake retry, or two frames
    // both arriving on a relay slower than the retry interval).
    h.doHandshake();
    h.doHandshake();

    // Derives the SAME session key both times → snapshot fires exactly once, so
    // the browser is not spammed with a duplicate backlog.
    expect(firedFor).toEqual([PEER]);
  });

  it("does NOT fire the snapshot for an unregistered (wildcard/auto) peer — no at-rest history to an unauthenticated peer", () => {
    const h = makeHarness({ admission: "wildcard" });
    const firedFor: string[] = [];
    h.channel.setHandshakeCompleteHandler((peerId) => firedFor.push(peerId));

    h.doHandshake();

    // The handshake completes (live chat still works on the wildcard path), but
    // the peer never went through the PoP register hop, so the initial stored-
    // history snapshot MUST NOT be sent to it.
    expect(h.browserSessionKey()).not.toBeNull();
    expect(firedFor).toEqual([]);
  });

  it("only ever puts ciphertext on the wire (relay sees no plaintext)", () => {
    const h = makeHarness();
    h.doHandshake();
    const key = h.browserSessionKey()!;
    h.browser.publish(inSubj, sealEnvelope({ accountId: AGENT, tenant: TENANT, sub: PEER }, key, {
      type: "user_message",
      text: "topsecret-probe",
    }));

    const dataFrames = h.wirePayloads.filter((p) => p.subject === inSubj || p.subject === outSubj);
    expect(dataFrames.length).toBe(2); // one in, one out
    for (const frame of dataFrames) {
      // No plaintext leaks anywhere on the wire.
      expect(frame.text).not.toContain("topsecret-probe");
      expect(frame.text).not.toContain("reply:");
      expect(frame.text).not.toContain("user_message");
      expect(frame.text).not.toContain("agent_message");
      // The frame is a genuine v1 envelope with a ciphertext content block.
      const env = JSON.parse(frame.text) as { v: number; content?: { ciphertext?: string } };
      expect(env.v).toBe(1);
      expect(typeof env.content?.ciphertext).toBe("string");
      expect((env.content!.ciphertext as string).length).toBeGreaterThan(0);
    }
  });

  it("fail-closed: refuses to send before the handshake (no plaintext outbound)", () => {
    const h = makeHarness();
    // No handshake performed.
    const ok = h.channel.sendText(PEER, "must-not-leak");
    expect(ok).toBe(false);
    expect(h.wirePayloads.some((p) => p.subject === outSubj)).toBe(false);
  });

  it("fail-closed: drops inbound that arrives before the handshake", () => {
    const h = makeHarness();
    // Plaintext attempt before any key exchange.
    h.browser.publish(inSubj, Buffer.from(JSON.stringify({ type: "user_message", text: "x" })));
    // Sealed-with-some-key attempt before any key exchange.
    const someKey = deriveConversationKey(generateKeyPair().privateKey, generateKeyPair().publicKey);
    h.browser.publish(inSubj, sealEnvelope({ accountId: AGENT, tenant: TENANT, sub: PEER }, someKey, { type: "user_message", text: "y" }));
    expect(h.inbound).toEqual([]);
  });

  it("fail-closed: drops a frame whose routing (AAD) was tampered after sealing (AC2)", () => {
    const h = makeHarness();
    h.doHandshake();
    const key = h.browserSessionKey()!;

    // Seal legitimately, then tamper a plaintext routing field WITHOUT re-encrypting.
    // The agent recomputes canonical AAD from the (tampered) routing, so the
    // ChaCha20-Poly1305 tag no longer authenticates → decryption fails → dropped.
    const sealed = sealEnvelope({ accountId: AGENT, tenant: TENANT, sub: PEER }, key, {
      type: "user_message",
      text: "authentic",
    });
    const env = JSON.parse(sealed.toString("utf8")) as Record<string, unknown>;
    env["messageId"] = `${String(env["messageId"])}-tampered`; // routing/AAD mutation
    h.browser.publish(inSubj, Buffer.from(JSON.stringify(env)));

    expect(h.inbound).toEqual([]);

    // And a control: the same payload, untampered, IS accepted — proving the drop
    // above is specifically due to the AAD mismatch, not a structural reject.
    h.browser.publish(inSubj, sealed);
    expect(h.inbound).toEqual([{ type: "user_message", text: "authentic" }]);
  });

  it("fail-closed: drops a frame sealed with the wrong key after handshake", () => {
    const h = makeHarness();
    h.doHandshake();
    // Wrong key (not the negotiated session key) → decrypt fails → dropped.
    const wrongKey = deriveConversationKey(generateKeyPair().privateKey, generateKeyPair().publicKey);
    h.browser.publish(inSubj, sealEnvelope({ accountId: AGENT, tenant: TENANT, sub: PEER }, wrongKey, {
      type: "user_message",
      text: "tampered",
    }));
    expect(h.inbound).toEqual([]);
  });

  it("uses a fresh 12-byte nonce per seal (no nonce reuse)", () => {
    // Sanity on the underlying AEAD the channel relies on.
    const key = deriveConversationKey(generateKeyPair().privateKey, generateKeyPair().publicKey);
    const a = encrypt(key, new TextEncoder().encode("same"));
    const b = encrypt(key, new TextEncoder().encode("same"));
    expect(Buffer.from(a.nonce).toString("hex")).not.toBe(Buffer.from(b.nonce).toString("hex"));
  });
});
