/**
 * P0-7b — client-side unacked replay ledger + server ack draining.
 *
 * 4a stamped every `user_message` with a stable id and made the server dedupe it
 * at ingress. 4b closes the loss window: a `user_message` sealed+published but
 * dropped by a mid-session relay outage is REPLAYED (same id → 4a dedupe keeps it
 * exactly-once) when the session re-establishes, and the agent's ingress `ack`
 * drains the client's ledger so it can't grow forever.
 *
 * These tests drive `WebChannelNatsClient` against a fake nats-server that:
 *   - SURVIVES reconnects (a shared handler is installed on every socket), and
 *   - lets a test toggle whether the agent PROCESSES inbound (simulating a relay
 *     outage that swallows a sealed frame) and whether it ACKs.
 * Legacy-handshake mode (no registration) is used because `flushQueue()` — the
 * replay choke point — fires on handshake completion, the same as in register
 * mode, and the harness is simpler.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WebChannelNatsClient,
  inboundSubject,
  outboundSubject,
  handshakeSubject,
  type OutboundMessage,
} from "./nats-client.js";
import {
  generateX25519KeyPair,
  deriveConversationKey,
  keyExchangeFrame,
  parseKeyExchange,
  sealMessage,
  openMessage,
} from "./e2e-crypto-browser.js";

// ---------------------------------------------------------------------------
// Fake nats-server over a fake WebSocket — shared handler across reconnects
// ---------------------------------------------------------------------------

type ServerHandler = (subject: string, payload: string, server: FakeNatsWS) => void | Promise<void>;

class FakeNatsWS {
  static instances: FakeNatsWS[] = [];
  static sharedHandler: ServerHandler = () => {};
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  url: string;
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  private readonly subs = new Map<string, number>();
  readonly published: Array<{ subject: string; payload: string }> = [];
  handler: ServerHandler;

  constructor(url: string) {
    this.url = url;
    this.handler = FakeNatsWS.sharedHandler;
    FakeNatsWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeNatsWS.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    if (data.startsWith("CONNECT")) return;
    if (data.startsWith("PING")) {
      this.emit("PONG\r\n");
      return;
    }
    if (data.startsWith("PONG")) return;
    if (data.startsWith("SUB ")) {
      const [, subject, sid] = data.trim().split(" ");
      this.subs.set(subject, Number(sid));
      return;
    }
    if (data.startsWith("UNSUB ")) {
      const sid = Number(data.trim().split(" ")[1]);
      for (const [subject, id] of this.subs) if (id === sid) this.subs.delete(subject);
      return;
    }
    if (data.startsWith("PUB ")) {
      const idx = data.indexOf("\r\n");
      const subject = data.slice(0, idx).split(" ")[1];
      const payload = data.slice(idx + 2).replace(/\r\n$/, "");
      this.published.push({ subject, payload });
      void this.handler(subject, payload, this);
      return;
    }
  }

  deliverToClient(subject: string, payload: string): void {
    const sid = this.subs.get(subject);
    if (sid === undefined) return;
    const len = new TextEncoder().encode(payload).length;
    this.emit(`MSG ${subject} ${sid} ${len}\r\n${payload}\r\n`);
  }

  close(): void {
    this.readyState = FakeNatsWS.CLOSED;
    this.onclose?.();
  }

  private emit(frame: string): void {
    this.onmessage?.({ data: frame });
  }
}

const TENANT = "acme";
const AGENT = "agent-1";
const PEER = "user-42";

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
}

/**
 * A shared "agent" that handshakes on every (re)connect, and — when `deliver` is
 * true — decrypts inbound user_messages, records them, and (when `ack` is true)
 * seals an `ack` frame back on `.out`. A false `deliver` drops the frame verbatim
 * (a mid-session relay outage), so the client never gets an ack for it.
 */
function makeReplayAgent(control: { deliver: boolean; ack: boolean }) {
  let sessionKey: Uint8Array | null = null;
  const hs = handshakeSubject(TENANT, AGENT, PEER);
  const inS = inboundSubject(TENANT, AGENT, PEER);
  const outS = outboundSubject(TENANT, AGENT, PEER);
  const received: Array<{ id?: string; text?: string }> = [];
  const handler: ServerHandler = async (subject, payload, server) => {
    if (subject === hs) {
      const browserPub = parseKeyExchange(payload);
      if (!browserPub) return;
      const agentKP = await generateX25519KeyPair();
      sessionKey = await deriveConversationKey(agentKP.privateKey, browserPub);
      server.deliverToClient(hs, keyExchangeFrame(agentKP.publicKeyB64url));
      return;
    }
    if (subject === inS && sessionKey) {
      if (!control.deliver) return; // outage: the sealed frame is swallowed
      const msg = openMessage(payload, sessionKey) as
        | { type?: string; id?: string; text?: string }
        | null;
      if (msg?.type === "user_message") {
        received.push({ id: msg.id, text: msg.text });
        if (control.ack && msg.id) {
          const wire = sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, sessionKey, {
            type: "ack",
            ids: [msg.id],
          } as unknown as OutboundMessage);
          server.deliverToClient(outS, wire);
        }
      }
    }
  };
  return { handler, received };
}

function ledgerOf(client: WebChannelNatsClient): Map<string, OutboundMessage> {
  return (client as unknown as { unackedLedger: Map<string, OutboundMessage> }).unackedLedger;
}

function makeClient(): WebChannelNatsClient {
  return new WebChannelNatsClient({
    url: "ws://127.0.0.1:4222",
    jwt: "",
    accountId: AGENT,
    tenant: TENANT,
    peerId: PEER,
    reconnectBaseMs: 1,
    reconnectCapMs: 2,
    heartbeatIntervalMs: 0,
  });
}

let originalWebSocket: unknown;

beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeNatsWS;
  FakeNatsWS.instances = [];
  FakeNatsWS.sharedHandler = () => {};
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

describe("WebChannelNatsClient — P0-7b unacked ledger", () => {
  it("records a published user_message and drains it when the ack arrives", async () => {
    const agent = makeReplayAgent({ deliver: true, ack: true });
    FakeNatsWS.sharedHandler = agent.handler;
    const client = makeClient();
    client.connect();
    await settle();

    client.sendUserMessage("hello");
    await settle();

    // The agent received it once, and its ack drained the ledger.
    expect(agent.received.map((m) => m.text)).toEqual(["hello"]);
    expect(ledgerOf(client).size).toBe(0);
    client.disconnect();
  });

  it("keeps an unacked message in the ledger when the agent never acks", async () => {
    const agent = makeReplayAgent({ deliver: true, ack: false });
    FakeNatsWS.sharedHandler = agent.handler;
    const client = makeClient();
    client.connect();
    await settle();

    const id = client.sendUserMessage("no-ack");
    await settle();

    expect(agent.received.map((m) => m.text)).toEqual(["no-ack"]);
    expect([...ledgerOf(client).keys()]).toEqual([id]);
    client.disconnect();
  });

  it("replays a lost message on reconnect with the SAME id, exactly once", async () => {
    // Agent starts in outage: the first send is swallowed (never processed/acked).
    const control = { deliver: false, ack: true };
    const agent = makeReplayAgent(control);
    FakeNatsWS.sharedHandler = agent.handler;
    const client = makeClient();
    client.connect();
    await settle();

    const id = client.sendUserMessage("survive-the-outage");
    await settle();
    // Swallowed → nothing received, still in the ledger.
    expect(agent.received).toEqual([]);
    expect([...ledgerOf(client).keys()]).toEqual([id]);

    // Relay heals, then the socket drops → the client reconnects and replays.
    control.deliver = true;
    FakeNatsWS.instances.at(-1)!.close();
    await settle();

    // Delivered exactly once, same id, and the ack drained the ledger.
    expect(agent.received).toEqual([{ id, text: "survive-the-outage" }]);
    expect(ledgerOf(client).size).toBe(0);
    client.disconnect();
  });

  it("replays unacked messages in original order, ahead of a message queued during the outage", async () => {
    const control = { deliver: false, ack: true };
    const agent = makeReplayAgent(control);
    FakeNatsWS.sharedHandler = agent.handler;
    const client = makeClient();
    client.connect();
    await settle();

    // Two sealed-but-swallowed sends (recorded in the ledger, in order).
    const id1 = client.sendUserMessage("first");
    const id2 = client.sendUserMessage("second");
    await settle();
    expect(agent.received).toEqual([]);

    // Drop the socket; while disconnected the user sends a THIRD message — it has
    // no session key, so it queues in outboundQueue (not the ledger).
    control.deliver = true;
    FakeNatsWS.instances.at(-1)!.close();
    const id3 = client.sendUserMessage("third");
    await settle();

    // Replay order: the two ledger entries FIRST (original order), then the
    // freshly-queued third — each with its own id.
    expect(agent.received).toEqual([
      { id: id1, text: "first" },
      { id: id2, text: "second" },
      { id: id3, text: "third" },
    ]);
    expect(ledgerOf(client).size).toBe(0);
    client.disconnect();
  });

  it("caps the ledger at 100, evicting the oldest", async () => {
    const agent = makeReplayAgent({ deliver: true, ack: false }); // never acks → fills
    FakeNatsWS.sharedHandler = agent.handler;
    const client = makeClient();
    client.connect();
    await settle();

    const ids: string[] = [];
    for (let i = 0; i < 101; i++) ids.push(client.sendUserMessage(`m${i}`));
    await settle();

    const ledger = ledgerOf(client);
    expect(ledger.size).toBe(100);
    expect(ledger.has(ids[0])).toBe(false); // oldest evicted
    expect(ledger.has(ids[100])).toBe(true); // newest retained
    client.disconnect();
  });

  it("resetSession keeps the ledger (a mid-session drop needs the entries)", async () => {
    const agent = makeReplayAgent({ deliver: true, ack: false });
    FakeNatsWS.sharedHandler = agent.handler;
    const client = makeClient();
    client.connect();
    await settle();

    const id = client.sendUserMessage("keep-me");
    await settle();
    expect(ledgerOf(client).size).toBe(1);

    (client as unknown as { resetSession: () => void }).resetSession();
    expect([...ledgerOf(client).keys()]).toEqual([id]); // survived the drop

    client.disconnect();
  });

  it("disconnect() clears the ledger (dead instance)", async () => {
    const agent = makeReplayAgent({ deliver: true, ack: false });
    FakeNatsWS.sharedHandler = agent.handler;
    const client = makeClient();
    client.connect();
    await settle();

    client.sendUserMessage("gone-on-disconnect");
    await settle();
    expect(ledgerOf(client).size).toBe(1);

    client.disconnect();
    expect(ledgerOf(client).size).toBe(0);
  });

  it("a pre-key buffered ack drains the ledger before flushQueue replays (no replay)", async () => {
    // On reconnect the ordering is: handshake completes → drainPendingInbound →
    // flushQueue. An `ack` that arrived on `.out` BEFORE the key existed sits in
    // pendingInbound; draining it removes the id from the ledger BEFORE the replay
    // pass runs, so the acked message is NOT re-delivered.
    const hs = handshakeSubject(TENANT, AGENT, PEER);
    const inS = inboundSubject(TENANT, AGENT, PEER);
    const outS = outboundSubject(TENANT, AGENT, PEER);
    let knownId = "";
    let ackPreKeyOnReconnect = false;
    const receivedIn: string[] = [];

    FakeNatsWS.sharedHandler = async (subject, payload, server) => {
      if (subject === hs) {
        const browserPub = parseKeyExchange(payload);
        if (!browserPub) return;
        const agentKP = await generateX25519KeyPair();
        const key = await deriveConversationKey(agentKP.privateKey, browserPub);
        if (ackPreKeyOnReconnect && knownId) {
          // Seal the ack with the SAME key the client will derive, and deliver it
          // on `.out` FIRST — before the handshake reply — so the client buffers it
          // pre-key in pendingInbound.
          const ackWire = sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, key, {
            type: "ack",
            ids: [knownId],
          } as unknown as OutboundMessage);
          server.deliverToClient(outS, ackWire);
        }
        server.deliverToClient(hs, keyExchangeFrame(agentKP.publicKeyB64url));
        (server as unknown as { sessionKey: Uint8Array }).sessionKey = key;
        return;
      }
      if (subject === inS) {
        const key = (server as unknown as { sessionKey?: Uint8Array }).sessionKey;
        if (!key) return;
        const msg = openMessage(payload, key) as { type?: string; text?: string } | null;
        if (msg?.type === "user_message") receivedIn.push(msg.text ?? "");
      }
    };

    const client = makeClient();
    client.connect();
    await settle();

    // Send an unacked message (agent does not ack on the first connection).
    knownId = client.sendUserMessage("acked-while-reconnecting");
    await settle();
    expect(receivedIn).toEqual(["acked-while-reconnecting"]);
    expect([...ledgerOf(client).keys()]).toEqual([knownId]);
    receivedIn.length = 0; // watch only the reconnect for a replay

    // Reconnect: the agent now acks the outstanding id PRE-KEY on `.out`.
    ackPreKeyOnReconnect = true;
    FakeNatsWS.instances.at(-1)!.close();
    await settle();

    // The pre-key ack drained the ledger before flushQueue, so nothing replayed.
    expect(receivedIn).toEqual([]);
    expect(ledgerOf(client).size).toBe(0);
    client.disconnect();
  });

  it("an ack with unknown ids is a no-op and still reaches message listeners", async () => {
    const agent = makeReplayAgent({ deliver: true, ack: false });
    FakeNatsWS.sharedHandler = agent.handler;
    const client = makeClient();
    const received: Array<{ type: string }> = [];
    client.onMessage((m) => received.push(m));
    client.connect();
    await settle();

    const id = client.sendUserMessage("still-here");
    await settle();
    expect(ledgerOf(client).size).toBe(1);

    // The agent hand-delivers an ack for ids we never sent.
    const key = (client as unknown as { sessionKey: Uint8Array }).sessionKey;
    const wire = sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, key, {
      type: "ack",
      ids: ["never-seen-1", "never-seen-2"],
    } as unknown as OutboundMessage);
    FakeNatsWS.instances.at(-1)!.deliverToClient(outboundSubject(TENANT, AGENT, PEER), wire);
    await settle();

    // Ledger untouched (our real id survives), and the frame was forwarded.
    expect([...ledgerOf(client).keys()]).toEqual([id]);
    expect(received.some((m) => m.type === "ack")).toBe(true);
    client.disconnect();
  });
});
