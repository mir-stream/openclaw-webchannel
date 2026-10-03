import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeEnvelope } from "./e2e-crypto-browser.js";
import { outboundSubject } from "./nats-client.js";
import {
  AGENT, TENANT, PEER, FakeNatsWS, installFakeWebSocket, makeClient, registerAgent, settleUntil,
} from "./nats-client-wrapped.test-harness.js";

const key = new Uint8Array(32).fill(23);
const cleanup: Array<() => void> = [];
beforeEach(() => { cleanup.push(installFakeWebSocket()); });
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); vi.restoreAllMocks(); });

function sealed(messageId: string, ts = Date.now(), routing = {}) {
  return JSON.stringify(encodeEnvelope({
    tenant: TENANT, accountId: AGENT, sub: PEER, envelopeType: "conversation", messageId, ts, ...routing,
  }, JSON.stringify({ type: "agent_message", text: messageId }), key));
}
async function start(beforeReply?: () => Promise<void>) {
  const h = await makeClient();
  cleanup.push(() => h.client.disconnect());
  FakeNatsWS.sharedHandler = registerAgent(key, h.devicePublicRaw, h.identity, { beforeReply });
  const messages: unknown[] = [];
  let sessions = 0;
  h.client.onSession(() => { sessions++; });
  h.client.onMessage(m => messages.push(m));
  h.client.connect();
  await settleUntil(() => beforeReply
    ? FakeNatsWS.instances.at(-1)!.subscribedSubjects().includes(outboundSubject(TENANT, AGENT, PEER))
    : sessions === 1, { label: "receive subscription / registered session" });
  return { ...h, messages, get sessions() { return sessions; }, deliver: (wire: string) => FakeNatsWS.instances.at(-1)!.deliverToClient(outboundSubject(TENANT, AGENT, PEER), wire) };
}

it("#415 E4: drops an authenticated replay, including across reconnect", async () => {
  const h = await start();
  const wire = sealed("once");
  h.deliver(wire); h.deliver(wire);
  expect(h.messages).toEqual([{ type: "agent_message", text: "once" }]);
  expect(h.client.requestApplicationRecovery()).toBe(true);
  await settleUntil(() => h.sessions === 2, { label: "recovered session" });
  h.deliver(wire); h.deliver(sealed("next"));
  expect(h.messages).toEqual([{ type: "agent_message", text: "once" }, { type: "agent_message", text: "next" }]);
});

it.each([-600_001, 600_001])("#415 E4: rejects authenticated timestamp skew %i", async offset => {
  const h = await start();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  h.deliver(sealed("stale", now + offset));
  h.deliver(sealed("fresh", now));
  expect(h.messages).toEqual([{ type: "agent_message", text: "fresh" }]);
});

it("#415 E4: checks replay when draining pre-key frames", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const h = await start(() => gate);
  const wire = sealed("buffered");
  h.deliver(wire); h.deliver(wire);
  release(); await settleUntil(() => h.sessions === 1, { label: "buffer drained" });
  expect(h.messages).toEqual([{ type: "agent_message", text: "buffered" }]);
});

it("#415 E4: never lets a forged envelope reserve the authenticated ID", async () => {
  const h = await start();
  const wire = sealed("genuine");
  const forged = JSON.parse(wire); forged.ts -= 1;
  h.deliver(JSON.stringify(forged)); h.deliver(wire);
  expect(h.messages).toEqual([{ type: "agent_message", text: "genuine" }]);
});

it.each([{ tenant: "foreign" }, { accountId: "foreign" }, { sub: "foreign" }])(
  "#415 E4: rejects a valid envelope for the wrong tuple %j", async routing => {
    const h = await start();
    h.deliver(sealed("wrong-tuple", Date.now(), routing));
    expect(h.messages).toEqual([]);
  },
);

it("#415 E4: bounds memory without evicting fresh replay evidence", async () => {
  const h = await start();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  // Exercise the real receive door at its capacity boundary, without sealing
  // thousands of unrelated frames just to populate a bounded cache.
  const seen = h.client["seenInboundEnvelopes"] ?? new Map<string, number>();
  for (let i = 0; i < 16_384; i++) seen.set(`seen-${i}`, now + 600_000);
  h.deliver(sealed("overflow")); h.deliver(sealed("seen-0"));
  expect(h.messages).toEqual([]);
  vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
  h.deliver(sealed("after-expiry"));
  expect(h.messages).toEqual([{ type: "agent_message", text: "after-expiry" }]);
});
