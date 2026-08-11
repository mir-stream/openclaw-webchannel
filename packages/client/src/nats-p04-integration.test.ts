/**
 * P0-4 cross-package SEAM integration (Stage 5) — the REAL client send-state
 * contract wired to the REAL plugin ingress pure functions in one process. This
 * is reduced seam coverage, NOT the full T-co/T-st loop (no debounce timer / no
 * core turn loop — see the describe block).
 *
 * The client wrapper (this package) is the primary under test; the two plugin
 * halves are imported by relative source path — `coalesceUserMessages`
 * (turn anchor = last frame id) and `recordCancelledInboundItems` (a /stop-
 * cancelled message is acked, never turned). Both are dependency-free pure
 * functions, so they typecheck cleanly under this package's (DOM) libs. The join
 * is the wire id: the client's real `wireId`s ARE the frame ids the plugin
 * coalesces/acks, and the frames the plugin emits are delivered back verbatim.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import { outboundSubject, type OutboundMessage } from "./nats-client.js";
import { sealMessage } from "./e2e-crypto-browser.js";
import { generateDevicePopKeyPair } from "./pop-register.js";
import {
  AGENT,
  FakeNatsWS,
  JWT,
  PEER,
  TENANT,
  generateDeviceX25519,
  installFakeWebSocket,
  makeAgentIdentity,
  registerAgent,
  settle,
  type ServerHandler,
} from "./nats-client-wrapped.test-harness.js";

// REAL plugin ingress seams (dependency-free pure functions).
import { coalesceUserMessages, readCoalescedMemberIds } from "../../plugin/src/inbound-queue.js";
import { recordCancelledInboundItems, type IngressDedupeCheck } from "../../plugin/src/ingress-dedupe.js";

const OUT = outboundSubject(TENANT, AGENT, PEER);

let restore: () => void;
beforeEach(() => { restore = installFakeWebSocket(); });
afterEach(() => restore());

/** A real, registered WebChannelNATSClient over the fake socket (session-keyed). */
async function connectWrapper(): Promise<{ wrapper: WebChannelNATSClient; K: Uint8Array }> {
  const pop = await generateDevicePopKeyPair();
  const x = await generateDeviceX25519();
  const identity = makeAgentIdentity();
  const K = new Uint8Array(32).fill(77);
  const registration = registerAgent(K, x.publicRaw, identity);
  // Register only; both tests drive the plugin ack/turn_settled frames explicitly.
  const handler: ServerHandler = async (s, p, server, reply) => { await registration(s, p, server, reply); };
  FakeNatsWS.sharedHandler = handler;
  const wrapper = new WebChannelNATSClient({
    natsUrl: "ws://127.0.0.1:4222",
    bootstrapJwt: JWT,
    accountId: AGENT,
    tenant: TENANT,
    peerId: PEER,
    heartbeatIntervalMs: 0,
    registration: {
      devicePrivateKey: pop.privateKey,
      deviceX25519PrivateKey: x.privateKey,
      pinnedAgentPublicKey: identity.publicB64url,
    },
  });
  wrapper.connect();
  await settle();
  return { wrapper, K };
}

const deliverOut = (K: Uint8Array, msg: Record<string, unknown>): void => {
  FakeNatsWS.instances.at(-1)!.deliverToClient(
    OUT,
    sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, msg as unknown as OutboundMessage),
  );
};
const userBubble = (w: WebChannelNATSClient, text: string) =>
  w.getState().messages.find((m) => m.role === "user" && m.text === text)!;

// SEAM integration, NOT the full T-co/T-st loop: these wire the client's real
// wireIds through the plugin's real pure ingress FUNCTIONS
// (coalesceUserMessages / recordCancelledInboundItems), then feed the resulting
// frames back to the real client. They do NOT run the plugin's debounce timer or
// the core turn loop (not reproducible without core), so a green run here is
// seam coverage — the full-loop behavior is pinned by the client-side T-co/T-st
// over fake frames plus the plugin's own ingress tests.
describe("P0-4 cross-package SEAM integration", () => {
  // T-co seam: a real 3-message burst → the real coalescer preserves every
  // member wireId in arrival order, with the LAST id as the turn anchor. The
  // current plugin emits one same-outcome settle per member, anchor last; the
  // real client promotes each frame's exact wireId.
  it("T-co seam: the real coalescer's member list completes every client receipt", async () => {
    const h = await connectWrapper();
    const r1 = h.wrapper.send("c1")!;
    const r2 = h.wrapper.send("c2")!;
    const r3 = h.wrapper.send("c3")!;
    await settle();
    const w1 = userBubble(h.wrapper, "c1").wireId!;
    const w2 = userBubble(h.wrapper, "c2").wireId!;
    const w3 = userBubble(h.wrapper, "c3").wireId!;

    // REAL plugin coalescer over the client's actual wire ids → anchor = last id.
    const merged = coalesceUserMessages([
      { type: "user_message", id: w1, text: "c1" },
      { type: "user_message", id: w2, text: "c2" },
      { type: "user_message", id: w3, text: "c3" },
    ]);
    expect(merged.id).toBe(w3); // inbound.ts derives turnId = message.id
    const memberIds = [...readCoalescedMemberIds(merged)];
    expect(memberIds).toEqual([w1, w2, w3]);
    expect(memberIds.at(-1)).toBe(merged.id);

    // Admit all three (ingress acks the whole batch), then model the current
    // plugin's settle producer from the REAL coalescer member list: same outcome,
    // arrival order, anchor last.
    deliverOut(h.K, { type: "ack", ids: [w1, w2, w3] });
    const settleFrames = memberIds.map((turnId) => ({ type: "turn_settled", turnId, outcome: "ok" } as const));
    expect(settleFrames.map((frame) => frame.turnId)).toEqual([w1, w2, merged.id]);
    for (const frame of settleFrames) deliverOut(h.K, frame);
    await settle();

    expect(r1.snapshot().state).toBe("completed");
    expect(r2.snapshot().state).toBe("completed");
    expect(r3.snapshot().state).toBe("completed");
    expect(userBubble(h.wrapper, "c1").sendState).toBe("completed");
    expect(userBubble(h.wrapper, "c2").sendState).toBe("completed");
    expect(userBubble(h.wrapper, "c3").sendState).toBe("completed");
    h.wrapper.close();
  });

  // T-st seam: a message killed in the debounce window by /stop is acked by the
  // REAL `recordCancelledInboundItems` (admission, not a turn) — the client ends
  // exactly [queued, sent, accepted]: no completed, no turn-failed.
  it("T-st seam: a /stop-cancelled message is acked to accepted and never completes/fails", async () => {
    const h = await connectWrapper();
    const seq: string[] = [];
    h.wrapper.subscribe((s) => {
      const m = s.messages.find((x) => x.role === "user" && x.text === "will-be-stopped");
      if (m?.sendState && seq[seq.length - 1] !== m.sendState) seq.push(m.sendState);
    });
    const receipt = h.wrapper.send("will-be-stopped")!;
    await settle();
    const w = userBubble(h.wrapper, "will-be-stopped").wireId!;
    expect(receipt.snapshot().state).toBe("sent"); // sealed, unacked

    // REAL plugin cancelled-ack path: a /stop drops the debounce-window message
    // and `recordCancelledInboundItems` acks its id (admission ack — the turn was
    // never run). The ack it emits is delivered to the client verbatim.
    const emittedAcks: Array<{ peerId: string; ids: string[] }> = [];
    const checkAndRecord: IngressDedupeCheck = async () => true;
    const sendAck = (peerId: string, ids: string[]): boolean => {
      emittedAcks.push({ peerId, ids });
      deliverOut(h.K, { type: "ack", ids });
      return true;
    };
    await recordCancelledInboundItems(
      [{ peerId: PEER, message: { id: w } }],
      AGENT,
      checkAndRecord,
      sendAck,
    );
    await settle();

    expect(emittedAcks).toEqual([{ peerId: PEER, ids: [w] }]);
    // No turn_settled is ever delivered → the receipt settles at accepted.
    expect(receipt.snapshot().state).toBe("accepted");
    expect(seq).toEqual(["queued", "sent", "accepted"]);
    expect(seq).not.toContain("completed");
    expect(userBubble(h.wrapper, "will-be-stopped").sendFailure).toBeUndefined();
    h.wrapper.close();
  });
});
