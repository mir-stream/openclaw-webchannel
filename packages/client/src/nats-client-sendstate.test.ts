import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inboundSubject,
  outboundSubject,
  type OutboundMessage,
  WebChannelNatsClient,
} from "./nats-client.js";
import type { SendFailure, SendState } from "./types.js";
import { openMessage, sealMessage } from "./e2e-crypto-browser.js";
import {
  AGENT,
  FakeNatsWS,
  PEER,
  TENANT,
  installFakeWebSocket,
  makeAgentIdentity,
  makeClient,
  registerAgent,
  settle,
  type ServerHandler,
} from "./nats-client-wrapped.test-harness.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";

// ---------------------------------------------------------------------------
// P0-4 — the authoritative low-level send-state tracker (D4). These exercise
// `WebChannelNatsClient.onSendState` directly over the fake NATS socket:
// monotonic queued/sent/accepted/failed transitions, the send-throw liveness
// recovery (D3), unacked eviction, the terminal/disconnect fail-all, and the
// reserveWireId seam. The wrapper-level `completed`/receipt behavior lives in
// nats-client-wrapper-sendstate.test.ts.
// ---------------------------------------------------------------------------

let restore: () => void;
beforeEach(() => { restore = installFakeWebSocket(); });
afterEach(() => restore());

type Ev = { id: string; state: SendState; failure?: SendFailure };
const IN = inboundSubject(TENANT, AGENT, PEER);
const OUT = outboundSubject(TENANT, AGENT, PEER);
const states = (events: Ev[], id: string): SendState[] =>
  events.filter((e) => e.id === id).map((e) => e.state);

/** Register + (optionally) deliver/ack every user_message, reading `control` live. */
async function setup(control: { deliver: boolean; ack: boolean } = { deliver: true, ack: true }) {
  const K = new Uint8Array(32).fill(31);
  const h = await makeClient({ reconnect: true });
  const events: Ev[] = [];
  h.client.onSendState((id, state, failure) => events.push({ id, state, failure }));
  const registration = registerAgent(K, h.devicePublicRaw, h.identity);
  const received: string[] = [];
  const handler: ServerHandler = async (s, p, server, reply) => {
    await registration(s, p, server, reply);
    if (s !== IN || !control.deliver) return;
    const msg = openMessage(p, K) as { type?: string; id?: string } | null;
    if (msg?.type !== "user_message" || !msg.id) return;
    received.push(msg.id);
    if (control.ack) {
      server.deliverToClient(OUT, sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, { type: "ack", ids: [msg.id] } as unknown as OutboundMessage));
    }
  };
  FakeNatsWS.sharedHandler = handler;
  h.client.connect();
  await settle();
  return { ...h, K, events, received, control };
}

describe("WebChannelNatsClient — P0-4 send-state tracker", () => {
  // T-hp (low-level slice): queued → sent → accepted, each exactly once.
  it("T-hp: a happy-path send transitions queued→sent→accepted, each once", async () => {
    const h = await setup();
    const id = h.client.sendUserMessage("hello");
    await settle();
    expect(states(h.events, id)).toEqual(["queued", "sent", "accepted"]);
    h.client.disconnect();
  });

  it("serializes re-entrant teardown events so every listener sees queued→sent→failed", async () => {
    const h = await setup({ deliver: true, ack: false });
    const first: Ev[] = [];
    const second: Ev[] = [];
    let closed = false;
    h.client.onSendState((id, state, failure) => {
      first.push({ id, state, failure });
      if (state === "sent" && !closed) {
        closed = true;
        h.client.disconnect();
      }
    });
    h.client.onSendState((id, state, failure) => second.push({ id, state, failure }));

    const id = h.client.sendUserMessage("close-during-sent");

    expect(closed).toBe(true);
    expect(states(first, id)).toEqual(["queued", "sent", "failed"]);
    expect(states(second, id)).toEqual(["queued", "sent", "failed"]);
    expect(first.at(-1)?.failure).toMatchObject({ reason: "closed" });
    expect(second.at(-1)?.failure).toMatchObject({ reason: "closed" });
  });

  it("commits A before a queued listener can synchronously send B", async () => {
    const h = await setup({ deliver: true, ack: false });
    let firstQueuedId: string | undefined;
    let nestedId: string | undefined;
    h.client.onSendState((id, state) => {
      if (state !== "queued" || firstQueuedId !== undefined) return;
      firstQueuedId = id;
      nestedId = h.client.sendUserMessage("B-from-queued-listener");
    });

    const firstId = h.client.sendUserMessage("A-outer");
    await settle();

    expect(firstQueuedId).toBe(firstId);
    expect(nestedId).toBeDefined();
    expect(h.received.slice(-2)).toEqual([firstId, nestedId]);
    expect(states(h.events, firstId)).toEqual(["queued", "sent"]);
    expect(states(h.events, nestedId!)).toEqual(["queued", "sent"]);
    h.client.disconnect();
  });

  // T-d1: a pre-connect send stays `queued`, then flushes to sent+accepted once
  // the register-delivered key lands.
  it("T-d1: a pre-connect send is queued, then sent+accepted after registration", async () => {
    const K = new Uint8Array(32).fill(9);
    const h = await makeClient({ reconnect: true });
    const events: Ev[] = [];
    h.client.onSendState((id, state, failure) => events.push({ id, state, failure }));
    const registration = registerAgent(K, h.devicePublicRaw, h.identity);
    const handler: ServerHandler = async (s, p, server, reply) => {
      await registration(s, p, server, reply);
      if (s !== IN) return;
      const msg = openMessage(p, K) as { type?: string; id?: string } | null;
      if (msg?.type === "user_message" && msg.id) {
        server.deliverToClient(OUT, sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, { type: "ack", ids: [msg.id] } as unknown as OutboundMessage));
      }
    };
    FakeNatsWS.sharedHandler = handler;
    const id = h.client.sendUserMessage("early"); // BEFORE connect → queued
    expect(states(events, id)).toEqual(["queued"]);
    h.client.connect();
    await settle();
    expect(states(events, id)).toEqual(["queued", "sent", "accepted"]);
    h.client.disconnect();
  });

  // T-d2: a publish-window disconnect (ws.send throws, NO close event) auto
  // forceReconnects, replays the ledgered send, and acks — and NEVER emits `sent`
  // at the throw. (R1-F2)
  it("T-d2: a send-throw with no close event recovers via forceReconnect (no sent at throw)", async () => {
    const h = await setup();
    const ws = FakeNatsWS.instances.at(-1)!;
    const realSend = ws.send.bind(ws);
    let thrown = false;
    ws.send = (data: string) => {
      if (!thrown && data.startsWith(`PUB ${IN} `)) { thrown = true; throw new Error("send failed (half-open)"); }
      return realSend(data);
    };
    const id = h.client.sendUserMessage("survive");
    // Synchronously after the throwing publish: queued only — no `sent`.
    expect(states(h.events, id)).toEqual(["queued"]);
    await settle(30);
    // Reconnect happened and the replay drove sent+accepted (a single `sent`).
    expect(FakeNatsWS.instances.length).toBeGreaterThan(1);
    expect(states(h.events, id)).toEqual(["queued", "sent", "accepted"]);
    h.client.disconnect();
  });

  it("treats a silently-discarding CLOSING socket as unsent and replays after reconnect", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await setup();
    const stale = FakeNatsWS.instances.at(-1)!;
    const publishedBefore = stale.published.length;
    stale.readyState = 2; // WebSocket.CLOSING; FakeNatsWS.send would otherwise accept silently.

    const id = h.client.sendUserMessage("closing-window");

    expect(states(h.events, id)).toEqual(["queued"]);
    expect(stale.published).toHaveLength(publishedBefore);
    await settle(30);
    expect(FakeNatsWS.instances.length).toBeGreaterThan(1);
    expect(states(h.events, id)).toEqual(["queued", "sent", "accepted"]);
    expect(h.received).toContain(id);
    warn.mockRestore();
    h.client.disconnect();
  });

  // T-d2 variant (R2-5): during a 3-send burst the 2nd publish throws → 1st sent,
  // 2nd+3rd stay queued, then FIFO-ordered replay on reconnect.
  it("T-d2 variant: mid-burst send-throw keeps FIFO on replay (1st sent, 2nd/3rd queued)", async () => {
    const h = await setup();
    const ws = FakeNatsWS.instances.at(-1)!;
    const realSend = ws.send.bind(ws);
    let pubCount = 0;
    ws.send = (data: string) => {
      if (data.startsWith(`PUB ${IN} `)) { pubCount++; if (pubCount === 2) throw new Error("boom on 2nd"); }
      return realSend(data);
    };
    const id1 = h.client.sendUserMessage("m1"); // sent
    const id2 = h.client.sendUserMessage("m2"); // throws → forceReconnect + resetSession
    const id3 = h.client.sendUserMessage("m3"); // sessionKey now null → queued
    // Synchronous snapshot: 1st sent, 2nd/3rd queued only.
    expect(states(h.events, id1)).toEqual(["queued", "sent"]);
    expect(states(h.events, id2)).toEqual(["queued"]);
    expect(states(h.events, id3)).toEqual(["queued"]);
    await settle(30);
    for (const id of [id1, id2, id3]) {
      expect(states(h.events, id)).toEqual(["queued", "sent", "accepted"]);
    }
    // The replayed frames reached the agent in the original FIFO order.
    expect(h.received.slice(-3)).toEqual([id1, id2, id3]);
    h.client.disconnect();
  });

  // T-rp: an ACK-less drop + reconnect replays the SAME id; `accepted` fires
  // exactly once (no duplicate transition).
  it("T-rp: accepted fires exactly once across a pre-ack reconnect replay", async () => {
    const h = await setup({ deliver: true, ack: false });
    const id = h.client.sendUserMessage("retry-me");
    await settle();
    expect(states(h.events, id)).toEqual(["queued", "sent"]);
    h.control.ack = true;
    FakeNatsWS.instances.at(-1)!.close();
    await settle(30);
    expect(h.events.filter((e) => e.id === id && e.state === "accepted")).toHaveLength(1);
    expect(states(h.events, id)).toEqual(["queued", "sent", "accepted"]);
    h.client.disconnect();
  });

  // T-ev: the unacked ledger cap evicts the oldest as failed{evicted,retryable}
  // exactly once, with a single warn.
  it("T-ev: the 101st unacked send evicts the oldest as failed{evicted}", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await setup({ deliver: true, ack: false });
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) ids.push(h.client.sendUserMessage(`m${i}`));
    await settle(20);
    const evicted = h.events.filter((e) => e.id === ids[0] && e.state === "failed");
    expect(evicted).toHaveLength(1);
    expect(evicted[0].failure).toMatchObject({ reason: "evicted", retryable: true });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("unacked ledger exceeded"))).toHaveLength(1);
    warn.mockRestore();
    h.client.disconnect();
  });

  // T-cl (low-level slice): disconnect fails every pending user_message
  // (queued + unacked) with failed{closed} and clears both structures.
  it("disconnect fails all pending (queued + unacked) with failed{closed} and clears them", async () => {
    const h = await setup({ deliver: true, ack: false });
    const sent = h.client.sendUserMessage("unacked"); // sealed → in ledger
    await settle();
    const queued = h.client.sendUserMessage("also"); // still-in-flight ledger entry too
    await settle();
    h.client.disconnect();
    for (const id of [sent, queued]) {
      const last = states(h.events, id).at(-1);
      expect(last).toBe("failed");
      expect(h.events.find((e) => e.id === id && e.state === "failed")?.failure).toMatchObject({
        reason: "closed",
        retryable: false,
      });
    }
    const ledger = (h.client as unknown as { unackedLedger: Map<string, unknown> }).unackedLedger;
    const queue = (h.client as unknown as { outboundQueue: unknown[] }).outboundQueue;
    expect(ledger.size).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it("disconnect preserves a fresh send created by a synchronous reconnecting state listener", async () => {
    const h = await setup({ deliver: true, ack: false });
    const oldId = h.client.sendUserMessage("old-lifecycle");
    await settle();
    expect(states(h.events, oldId)).toEqual(["queued", "sent"]);

    let freshId: string | undefined;
    let reopened = false;
    const unsubscribe = h.client.onState((connected) => {
      if (connected || reopened) return;
      reopened = true;
      h.client.connect();
      freshId = h.client.sendUserMessage("replacement-lifecycle");
    });

    h.client.disconnect();
    expect(reopened).toBe(true);
    expect(freshId).toBeDefined();
    expect(states(h.events, oldId).at(-1)).toBe("failed");
    expect(states(h.events, freshId!)).toEqual(["queued"]);
    await settle(30);
    expect(states(h.events, freshId!)).toEqual(["queued", "sent"]);
    expect(h.received).toContain(freshId!);
    expect(h.events.some((e) => e.id === freshId && e.state === "failed")).toBe(false);

    unsubscribe();
    h.client.disconnect();
  });

  // T-tm (register-path entry points): each REGISTER/handshake terminal failure
  // must route through the D4 terminal sequence — sweep pending → failed{terminal,
  // cause}, empty both structures, and immediate-fail a post-failure send. Driving
  // the real entry points (not the private notifyErrorListeners) is what guards
  // the round-1 BLOCKER: these five sites used to bypass handleTerminal.
  const K = new Uint8Array(32).fill(31);
  const ledgerOf = (c: WebChannelNatsClient) => (c as unknown as { unackedLedger: Map<string, unknown> }).unackedLedger;
  const queueOf = (c: WebChannelNatsClient) => (c as unknown as { outboundQueue: unknown[] }).outboundQueue;

  type RegCase = {
    name: string;
    cause: SendFailure["cause"];
    build: () => Promise<Awaited<ReturnType<typeof makeClient>>>;
  };
  const otherIdentity = makeAgentIdentity();
  const regCases: RegCase[] = [
    {
      name: "PoP 401 → auth-rejected",
      cause: "auth-rejected",
      build: async () => {
        const h = await makeClient({ reconnect: true });
        FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity, { rejectCode: 401 });
        return h;
      },
    },
    {
      name: "PoP 500 → server",
      cause: "server",
      build: async () => {
        const h = await makeClient({ reconnect: true });
        FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity, { rejectCode: 500 });
        return h;
      },
    },
    {
      name: "protocolVersion mismatch → protocol-mismatch",
      cause: "protocol-mismatch",
      build: async () => {
        const h = await makeClient({ reconnect: true });
        FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity, {
          versions: { protocolVersion: WEBCHANNEL_PROTOCOL_VERSION + 1 },
        });
        return h;
      },
    },
    {
      name: "missing wrappedConversationKey → protocol-mismatch",
      cause: "protocol-mismatch",
      build: async () => {
        const h = await makeClient({ reconnect: true });
        FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity, { omitWrappedKey: true });
        return h;
      },
    },
    {
      name: "missing pinned agent key → secure-channel-failed",
      cause: "secure-channel-failed",
      build: async () => {
        const h = await makeClient({ reconnect: true, pinned: null });
        FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity);
        return h;
      },
    },
    {
      name: "unwrap failure (wrong pin) → secure-channel-failed",
      cause: "secure-channel-failed",
      build: async () => {
        // Client pins `otherIdentity`, but the agent wraps K with `h.identity`.
        const h = await makeClient({ reconnect: true, pinned: otherIdentity.publicB64url });
        FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity);
        return h;
      },
    },
  ];

  for (const rc of regCases) {
    it(`T-tm: ${rc.name} sweeps pending to failed{terminal} and immediate-fails a later send`, async () => {
      const h = await rc.build();
      const events: Ev[] = [];
      h.client.onSendState((id, state, failure) => events.push({ id, state, failure }));
      const id = h.client.sendUserMessage("pending"); // queued (never keyed)
      h.client.connect();
      await settle(20);
      // The register terminal swept the queued send.
      expect(states(events, id)).toEqual(["queued", "failed"]);
      expect(events.find((e) => e.id === id && e.state === "failed")?.failure).toMatchObject({
        reason: "terminal",
        cause: rc.cause,
        retryable: false,
      });
      // Full sweep: both pending structures are empty.
      expect(queueOf(h.client)).toHaveLength(0);
      expect(ledgerOf(h.client).size).toBe(0);
      // D4 ①: a send AFTER the terminal resolves immediately to failed{terminal},
      // never re-queuing into the dead instance.
      const late = h.client.sendUserMessage("too late");
      expect(states(events, late)).toEqual(["queued", "failed"]);
      expect(events.find((e) => e.id === late && e.state === "failed")?.failure).toMatchObject({
        reason: "terminal",
        cause: rc.cause,
      });
      expect(queueOf(h.client)).toHaveLength(0);
    });
  }

  // T-tm (auth-stream entry points): the two `-ERR` terminal literals fire through
  // the low-level protocol parser → failTerminally → handleTerminal, sweeping a
  // ledgered (published-but-unacked) send.
  for (const [line, cause] of [
    ["-ERR 'User/Account Authentication Expired'", "auth-expired"],
    ["-ERR 'Authorization Violation'", "auth-rejected"],
  ] as const) {
    it(`T-tm: ${cause} via ${line} sweeps a ledgered send to failed{terminal}`, async () => {
      const h = await setup({ deliver: true, ack: false });
      const id = h.client.sendUserMessage("in-ledger");
      await settle();
      expect(states(h.events, id)).toEqual(["queued", "sent"]); // sealed, unacked
      // Emit the terminal -ERR on the live socket's protocol stream.
      FakeNatsWS.instances.at(-1)!.onmessage?.({ data: `${line}\r\n` } as { data: string });
      await settle();
      expect(states(h.events, id).at(-1)).toBe("failed");
      expect(h.events.find((e) => e.id === id && e.state === "failed")?.failure).toMatchObject({
        reason: "terminal",
        cause,
        retryable: false,
      });
      expect(ledgerOf(h.client).size).toBe(0);
      expect(queueOf(h.client)).toHaveLength(0);
    });
  }

  // T-mg (a): a duplicate ack after `accepted` is a no-op (accepted stays once).
  it("T-mg(a): a duplicate ack does not re-fire accepted", async () => {
    const h = await setup();
    const id = h.client.sendUserMessage("dup-ack");
    await settle();
    // Re-deliver the same ack.
    FakeNatsWS.instances.at(-1)!.deliverToClient(OUT, sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, h.K, { type: "ack", ids: [id] } as unknown as OutboundMessage));
    await settle();
    expect(h.events.filter((e) => e.id === id && e.state === "accepted")).toHaveLength(1);
    h.client.disconnect();
  });

  // T-mg (b): an ack AFTER eviction is a no-op — the evicted id stays failed.
  it("T-mg(b): an ack after eviction does not resurrect the send", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await setup({ deliver: true, ack: false });
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) ids.push(h.client.sendUserMessage(`m${i}`));
    await settle(20);
    expect(states(h.events, ids[0]).at(-1)).toBe("failed");
    // A late ack for the evicted id.
    FakeNatsWS.instances.at(-1)!.deliverToClient(OUT, sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, h.K, { type: "ack", ids: [ids[0]] } as unknown as OutboundMessage));
    await settle();
    expect(h.events.filter((e) => e.id === ids[0] && e.state === "accepted")).toHaveLength(0);
    expect(states(h.events, ids[0]).at(-1)).toBe("failed");
    warn.mockRestore();
    h.client.disconnect();
  });

  // T-mg (c, low-level): a REAL sealed ack for an already-failed send is a guarded
  // no-op. The message is failed via a socket close (failed{closed}); after a
  // reconnect a stray ack for the dead id arrives on the wire and must not advance.
  it("T-mg(c): a real ack for an already-failed send does not resurrect it", async () => {
    const h = await setup({ deliver: true, ack: false });
    const id = h.client.sendUserMessage("gone");
    await settle();
    h.client.disconnect(); // failed{closed} + ledger cleared
    expect(states(h.events, id).at(-1)).toBe("failed");
    // Reconnect and deliver a REAL sealed ack for the now-dead id over `.out`.
    h.client.connect();
    await settle();
    FakeNatsWS.instances.at(-1)!.deliverToClient(
      OUT,
      sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, h.K, { type: "ack", ids: [id] } as unknown as OutboundMessage),
    );
    await settle();
    expect(h.events.filter((e) => e.id === id && e.state === "accepted")).toHaveLength(0);
    expect(states(h.events, id).at(-1)).toBe("failed");
    h.client.disconnect();
  });
});

describe("WebChannelNatsClient — P0-4 reserveWireId seam (T-id)", () => {
  // T-id (a): an unreserved id throws + publishes/records nothing.
  it("T-id(a): sendUserMessage with an unreserved id throws, records nothing", async () => {
    const h = await makeClient();
    expect(() => h.client.sendUserMessage("x", "never-reserved")).toThrow(/was not reserved/);
    expect((h.client as unknown as { sendTracker: Map<string, unknown> }).sendTracker.size).toBe(0);
    expect((h.client as unknown as { outboundQueue: unknown[] }).outboundQueue).toHaveLength(0);
  });

  // T-id (b): consuming the same reserved id twice throws on the second.
  it("T-id(b): a reserved id can be consumed only once", async () => {
    const h = await makeClient();
    const id = h.client.reserveWireId();
    h.client.sendUserMessage("first", id);
    expect(() => h.client.sendUserMessage("again", id)).toThrow(/was not reserved/);
  });

  // T-id (c): reusing an id after it is in-flight (tracked/ledgered) throws.
  it("T-id(c): an id already in use cannot be re-sent (no ledger overwrite)", async () => {
    const h = await makeClient();
    const id = h.client.reserveWireId();
    h.client.sendUserMessage("live", id);
    // Even if a caller re-reserved via internal set manipulation, consume rejects.
    (h.client as unknown as { reservedWireIds: Set<string> }).reservedWireIds.add(id);
    expect(() => h.client.sendUserMessage("overwrite", id)).toThrow(/already in use/);
  });

  // T-id (d): reserving without using it mutates no send state.
  it("T-id(d): a reserved-but-unused id leaves the tracker untouched", async () => {
    const h = await makeClient();
    h.client.reserveWireId();
    expect((h.client as unknown as { sendTracker: Map<string, unknown> }).sendTracker.size).toBe(0);
    expect((h.client as unknown as { outboundQueue: unknown[] }).outboundQueue).toHaveLength(0);
  });

  // T-id (e): every minted id is non-empty and ≤128 chars.
  it("T-id(e): minted ids are non-empty and ≤128 chars", async () => {
    const h = await makeClient();
    for (let i = 0; i < 50; i++) {
      const id = h.client.reserveWireId();
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(128);
    }
  });

  // T-id (f): a deterministic (constant) RNG collides on the 2nd reservation and
  // throws after the bounded attempts — leaving no orphaned reservation.
  it("T-id(f): a colliding RNG exhausts the bounded attempts and mints no orphan", async () => {
    const h = await makeClient();
    const g = (globalThis as { crypto: { getRandomValues: (a: Uint8Array) => Uint8Array } }).crypto;
    const spy = vi.spyOn(g, "getRandomValues").mockImplementation((arr: Uint8Array) => { arr.fill(7); return arr; });
    const id1 = h.client.reserveWireId();
    expect(() => h.client.reserveWireId()).toThrow(/unique/);
    // No orphan: exactly the one successful reservation remains.
    const reserved = (h.client as unknown as { reservedWireIds: Set<string> }).reservedWireIds;
    expect(reserved.size).toBe(1);
    expect(reserved.has(id1)).toBe(true);
    spy.mockRestore();
  });
});
