/**
 * NatsChannel register-hop wiring — the NATS analogue of the deleted HTTP routes.
 *
 * Covers the channel plumbing only (the verify/PoP logic lives in
 * nats-register.ts): `subscribeRegister` subscribes the `.register` wildcard, a
 * request on `…{peerId}.register` is routed to the handler with the subject
 * peerId + raw payload, and the handler's reply is published to the request's
 * NATS reply-to inbox — which is ALLOWLISTED to the requester's OWN reginbox
 * (`webchannel.{tenant}.{accountId}.{peerId}.reginbox.{token}`, the one shape
 * the production client and every e2e/demo driver use). Any other reply-to —
 * another peer's subtree, the requester's own non-reginbox subjects, `_INBOX.*`
 * — is dropped (redirect guard).
 */

import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";

import { NatsChannel } from "./nats-channel.js";

const TENANT = "acme";
const ACCOUNT = "agent-1";
const PEER = "user-42";
const regSubj = `webchannel.${TENANT}.${ACCOUNT}.${PEER}.register`;
const regWild = `webchannel.${TENANT}.${ACCOUNT}.*.register`;
const ownReginbox = (token: string): string =>
  `webchannel.${TENANT}.${ACCOUNT}.${PEER}.reginbox.${token}`;

class FakeTransport extends EventEmitter {
  connected = true;
  readonly subs: string[] = [];
  readonly unsubscribed: number[] = [];
  readonly published: Array<{ subject: string; payload: string }> = [];
  subscribe(subject: string): number {
    this.subs.push(subject);
    return this.subs.length;
  }
  unsubscribe(sid: number): void { this.unsubscribed.push(sid); }
  publish(subject: string, payload: string | Buffer): void {
    this.published.push({ subject, payload: payload.toString() });
  }
  deliver(subject: string, payload: string, replyTo?: string): void {
    this.emit("message", { subject, payload: Buffer.from(payload), replyTo });
  }
}

function makeChannel(): { channel: NatsChannel; transport: FakeTransport } {
  const transport = new FakeTransport();
  const channel = new NatsChannel(
    transport as unknown as ConstructorParameters<typeof NatsChannel>[0],
    ACCOUNT,
    TENANT,
    undefined,
  );
  return { channel, transport };
}

/** Wire a handler that replies `{nonce:"n1"}`, subscribe, and deliver one request. */
function deliverChallenge(replyTo?: string): FakeTransport {
  const { channel, transport } = makeChannel();
  channel.setRegisterRequestHandler((_peerId, _payload, reply) => {
    reply(JSON.stringify({ nonce: "n1" }));
  });
  channel.subscribeRegister();
  transport.deliver(regSubj, JSON.stringify({ op: "challenge", token: "jwt" }), replyTo);
  return transport;
}

describe("NatsChannel register-hop wiring", () => {
  it("disposes the retained transport listener and every owned subscription idempotently", () => {
    const { channel, transport } = makeChannel();
    channel.subscribeRegister();
    channel.registerPeer(PEER);
    expect(transport.listenerCount("message")).toBe(1);
    channel.dispose();
    channel.dispose();
    expect(transport.listenerCount("message")).toBe(0);
    expect(transport.unsubscribed).toEqual([1, 2]);
    expect(channel.sendText(PEER, "late")).toBe(false);
  });

  it("subscribeRegister subscribes the `.register` wildcard", () => {
    const { channel, transport } = makeChannel();
    channel.subscribeRegister();
    expect(transport.subs).toContain(regWild);
  });

  it("returns an idempotent unsubscribe and close retires the transport listener", () => {
    const { channel, transport } = makeChannel();
    let calls = 0;
    channel.setRegisterRequestHandler(() => { calls += 1; });
    const unsubscribe = channel.subscribeRegister();
    unsubscribe();
    unsubscribe();
    expect(transport.unsubscribed).toEqual([1]);

    channel.subscribeRegister();
    channel.close();
    channel.close();
    expect(transport.unsubscribed).toEqual([1, 2]);
    transport.deliver(regSubj, JSON.stringify({ op: "challenge", token: "jwt" }));
    expect(calls).toBe(0);
  });

  it("routes a register request to the handler and publishes the reply to the requester's own reginbox", () => {
    const { channel, transport } = makeChannel();
    const seen: Array<{ peerId: string; payload: string }> = [];
    channel.setRegisterRequestHandler((peerId, payload, reply) => {
      seen.push({ peerId, payload });
      reply(JSON.stringify({ nonce: "n1" }));
    });
    channel.subscribeRegister();

    const body = JSON.stringify({ op: "challenge", token: "jwt" });
    transport.deliver(regSubj, body, ownReginbox("tok123"));

    // Handler saw the subject peerId + raw payload.
    expect(seen).toEqual([{ peerId: PEER, payload: body }]);
    // The reply went to the request's reply-to inbox and nowhere else.
    expect(transport.published).toEqual([
      { subject: ownReginbox("tok123"), payload: JSON.stringify({ nonce: "n1" }) },
    ]);
  });

  it("drops a reply-to that targets ANOTHER peer's webchannel subtree (redirect guard)", () => {
    // Attacker publishes on their OWN register subject but sets reply-to to a
    // victim's `.out` — the agent must refuse to publish there.
    const victimOut = `webchannel.${TENANT}.${ACCOUNT}.victim-99.out`;
    const transport = deliverChallenge(victimOut);
    expect(transport.published).toHaveLength(0);
  });

  it("drops a reply-to in the requester's OWN subtree that is not its reginbox (no self-bounce)", () => {
    // Own `.in` / `.register` etc. would bounce the plaintext reply back through
    // the agent's own handlers — allowlist rejects everything but reginbox.
    for (const subject of [
      `webchannel.${TENANT}.${ACCOUNT}.${PEER}.in`,
      `webchannel.${TENANT}.${ACCOUNT}.${PEER}.register`,
      `webchannel.${TENANT}.${ACCOUNT}.${PEER}.handshake`,
    ]) {
      expect(deliverChallenge(subject).published).toHaveLength(0);
    }
  });

  it("drops a reply-to outside the webchannel namespace (`_INBOX.*` etc.)", () => {
    // No real consumer uses `_INBOX` (the reginbox is in-namespace precisely so
    // browser creds need no `_INBOX.>` grant); the guard is an allowlist.
    expect(deliverChallenge("_INBOX.abc").published).toHaveLength(0);
    expect(deliverChallenge("orders.create").published).toHaveLength(0);
  });

  it("drops an own-reginbox reply-to with an EMPTY token (invalid subject shape)", () => {
    expect(deliverChallenge(`webchannel.${TENANT}.${ACCOUNT}.${PEER}.reginbox.`).published)
      .toHaveLength(0);
  });

  it("drops an own-reginbox reply-to whose token is not a single valid subject token", () => {
    // Wildcards / extra segments / whitespace after `reginbox.` start with the
    // prefix but would make the agent publish a malformed or wildcard subject.
    const base = `webchannel.${TENANT}.${ACCOUNT}.${PEER}.reginbox.`;
    for (const token of [">", "*", "tok.extra", "tok.extra.out", ".", "has space", "tok\t"]) {
      expect(deliverChallenge(`${base}${token}`).published).toHaveLength(0);
    }
  });

  it("drops a reginbox reply-to under a DIFFERENT peerId, including a prefix-peerId", () => {
    // `user-4` is a strict prefix of `user-42` — the trailing dot in the
    // allowlist prefix must keep these distinct.
    expect(deliverChallenge(`webchannel.${TENANT}.${ACCOUNT}.other.reginbox.t`).published)
      .toHaveLength(0);
    expect(deliverChallenge(`webchannel.${TENANT}.${ACCOUNT}.user-4.reginbox.t`).published)
      .toHaveLength(0);
  });

  it("allows the requester's own reginbox reply-to", () => {
    const transport = deliverChallenge(ownReginbox("tok123"));
    expect(transport.published).toContainEqual({
      subject: ownReginbox("tok123"),
      payload: JSON.stringify({ nonce: "n1" }),
    });
  });

  it("a request with no reply-to gets a no-op reply (fire-and-forget, no publish, no throw)", () => {
    const { channel, transport } = makeChannel();
    channel.setRegisterRequestHandler((_peerId, _payload, reply) => {
      // e.g. unregister: reply() is a no-op when there is no inbox.
      reply("should-not-publish");
    });
    channel.subscribeRegister();

    expect(() => transport.deliver(regSubj, JSON.stringify({ op: "unregister" }))).not.toThrow();
    expect(transport.published).toHaveLength(0);
  });

  it("a register frame is NOT treated as encrypted inbound (no session-key drop path)", () => {
    const { channel, transport } = makeChannel();
    let handlerCalls = 0;
    channel.setRegisterRequestHandler(() => {
      handlerCalls++;
    });
    channel.setMessageHandler(() => {
      throw new Error("register frame must not reach the inbound message handler");
    });
    channel.subscribeRegister();

    transport.deliver(regSubj, JSON.stringify({ op: "challenge", token: "jwt" }), ownReginbox("x"));
    expect(handlerCalls).toBe(1);
  });
});
