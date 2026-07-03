/**
 * NatsChannel register-hop wiring — the NATS analogue of the deleted HTTP routes.
 *
 * Covers the channel plumbing only (the verify/PoP logic lives in
 * nats-register.ts): `subscribeRegister` subscribes the `.register` wildcard, a
 * request on `…{peerId}.register` is routed to the handler with the subject
 * peerId + raw payload, and the handler's reply is published to the request's
 * NATS reply-to inbox (never a peerId subject).
 */

import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";

import { NatsChannel } from "./nats-channel.js";

const TENANT = "acme";
const ACCOUNT = "agent-1";
const PEER = "user-42";
const regSubj = `webchannel.${TENANT}.${ACCOUNT}.${PEER}.register`;
const regWild = `webchannel.${TENANT}.${ACCOUNT}.*.register`;

class FakeTransport extends EventEmitter {
  connected = true;
  readonly subs: string[] = [];
  readonly published: Array<{ subject: string; payload: string }> = [];
  subscribe(subject: string): number {
    this.subs.push(subject);
    return this.subs.length;
  }
  unsubscribe(): void {}
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
    {}, // crypto mode
  );
  return { channel, transport };
}

describe("NatsChannel register-hop wiring", () => {
  it("subscribeRegister subscribes the `.register` wildcard", () => {
    const { channel, transport } = makeChannel();
    channel.subscribeRegister();
    expect(transport.subs).toContain(regWild);
  });

  it("routes a register request to the handler and publishes the reply to the reply-to inbox", () => {
    const { channel, transport } = makeChannel();
    const seen: Array<{ peerId: string; payload: string }> = [];
    channel.setRegisterRequestHandler((peerId, payload, reply) => {
      seen.push({ peerId, payload });
      reply(JSON.stringify({ nonce: "n1" }));
    });
    channel.subscribeRegister();

    const body = JSON.stringify({ op: "challenge", token: "jwt" });
    transport.deliver(regSubj, body, "_INBOX.abc");

    // Handler saw the subject peerId + raw payload.
    expect(seen).toEqual([{ peerId: PEER, payload: body }]);
    // The reply was published to the request's reply-to inbox, NOT a peer subject.
    expect(transport.published).toContainEqual({
      subject: "_INBOX.abc",
      payload: JSON.stringify({ nonce: "n1" }),
    });
    expect(transport.published.some((p) => p.subject.includes(PEER))).toBe(false);
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

    transport.deliver(regSubj, JSON.stringify({ op: "challenge", token: "jwt" }), "_INBOX.x");
    expect(handlerCalls).toBe(1);
  });
});
