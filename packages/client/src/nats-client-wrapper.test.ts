import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import type { NatsClientOptions } from "./nats-client.js";

/**
 * CL1 regression: the public wrapper must FORWARD the NATS-layer NKEY
 * credentials (and reconnect tuning) to the underlying client. Before the fix
 * the constructor rebuilt its options object and silently dropped
 * `natsCredentials`, so a production JWT-auth nats-server connection sent
 * CONNECT with no signed nonce → `-ERR Authorization Violation` → an unwinnable
 * reconnect loop. Constructing the client is side-effect-free (no socket until
 * connect()), so we can inspect the options it built.
 */
describe("WebChannelNATSClient — CL1 option forwarding", () => {
  const natsCredentials = {
    userJwt: "eyJ-user-jwt",
    userSeedRaw: "cmF3LTMyLWJ5dGUtc2VlZA",
  };

  it("forwards natsCredentials to the underlying NATS client", () => {
    const wrapper = new WebChannelNATSClient({
      natsUrl: "wss://nats.prod.example.com",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "acct-1",
      tenant: "tenant-1",
      peerId: "peer-1",
      natsCredentials,
    });

    // The options the wrapper built for the wrapped client.
    const built = wrapper["natsOptions"] as NatsClientOptions;
    expect(built.natsCredentials).toEqual(natsCredentials);

    // And they actually reached the wrapped WebChannelNatsClient's inner client.
    const innerOptions = wrapper["client"]["options"] as NatsClientOptions;
    expect(innerOptions.natsCredentials).toEqual(natsCredentials);
  });

  it("forwards reconnect backoff tuning", () => {
    const wrapper = new WebChannelNATSClient({
      natsUrl: "wss://nats.prod.example.com",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "acct-1",
      tenant: "tenant-1",
      peerId: "peer-1",
      reconnectBaseMs: 250,
      reconnectCapMs: 8_000,
    });

    const built = wrapper["natsOptions"] as NatsClientOptions;
    expect(built.reconnectBaseMs).toBe(250);
    expect(built.reconnectCapMs).toBe(8_000);
  });

  it("forwards heartbeatIntervalMs (CL3)", () => {
    const wrapper = new WebChannelNATSClient({
      natsUrl: "wss://nats.prod.example.com",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "acct-1",
      tenant: "tenant-1",
      peerId: "peer-1",
      heartbeatIntervalMs: 0, // e.g. an embedder disabling the heartbeat
    });
    const built = wrapper["natsOptions"] as NatsClientOptions;
    expect(built.heartbeatIntervalMs).toBe(0);
  });

  it("leaves natsCredentials undefined for open/dev NATS (unchanged behavior)", () => {
    const wrapper = new WebChannelNATSClient({
      natsUrl: "wss://nats.dev.example.com",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "acct-1",
      tenant: "tenant-1",
      peerId: "peer-1",
    });

    const built = wrapper["natsOptions"] as NatsClientOptions;
    expect(built.natsCredentials).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CL2: a terminal auth failure must surface as the sticky "error" status.
// ---------------------------------------------------------------------------
class FakeWS {
  static instances: FakeWS[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  url: string;
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWS.OPEN;
      this.onopen?.();
    });
  }
  send(data: string): void {
    if (data.startsWith("PING")) this.onmessage?.({ data: "PONG\r\n" });
  }
  close(): void {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
  serverEmit(frame: string): void {
    this.onmessage?.({ data: frame });
  }
}

describe("WebChannelNATSClient — CL2 terminal error status", () => {
  let originalWebSocket: unknown;
  beforeEach(() => {
    originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWS;
    FakeWS.instances = [];
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("moves to sticky status \"error\" with a reason on an auth -ERR", async () => {
    const wrapper = new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 0,
    });
    wrapper.connect();
    await flush();
    expect(wrapper.getState().status).toBe("connected");

    FakeWS.instances[0].serverEmit("-ERR 'Authorization Violation'\r\n");
    await flush();

    const state = wrapper.getState();
    expect(state.status).toBe("error");
    expect(state.connected).toBe(false);
    expect(state.error).toMatch(/authorization/i);

    // Sticky: a trailing teardown state event must not downgrade it.
    await new Promise((r) => setTimeout(r, 20));
    expect(wrapper.getState().status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// W6 (Phase 6): idempotent history hydration under the stateless register —
// a snapshot triggered by ANY device's register arrives mid-session on the
// shared .out and must never duplicate bubbles.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — W6 idempotent history hydration", () => {
  type HistoryFrame = {
    type: "history";
    messages: Array<{ id: string; role: string; text: string; ts?: number }>;
  };

  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
    });
  }

  /** Drive the private inbound dispatcher directly (no socket needed). */
  function deliver(wrapper: WebChannelNATSClient, frame: HistoryFrame): void {
    (wrapper as unknown as { handleMessage: (m: HistoryFrame) => void }).handleMessage(frame);
  }

  it("re-delivered snapshot is a no-op (dedup by server id)", () => {
    const wrapper = makeWrapper();
    const snapshot: HistoryFrame = {
      type: "history",
      messages: [
        { id: "m1", role: "user", text: "hello", ts: 1 },
        { id: "m2", role: "agent", text: "hi there", ts: 2 },
      ],
    };
    deliver(wrapper, snapshot);
    expect(wrapper.getState().messages).toHaveLength(2);
    // Stateless register: the SAME snapshot arrives again (this device's
    // reconnect, or another device joining) — nothing may duplicate.
    deliver(wrapper, snapshot);
    expect(wrapper.getState().messages).toHaveLength(2);
  });

  it("adopts the server id onto a locally-echoed user message instead of duplicating it", () => {
    const wrapper = makeWrapper();
    wrapper.send("hello agent"); // local echo → synthetic id "u-0"
    expect(wrapper.getState().messages).toEqual([
      expect.objectContaining({ id: "u-0", role: "user", text: "hello agent" }),
    ]);

    // Mid-session snapshot carries the SAME message under its server id.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "srv-9", role: "user", text: "hello agent", ts: 42 }],
    });

    const messages = wrapper.getState().messages;
    expect(messages).toHaveLength(1); // no duplicate bubble
    expect(messages[0].id).toBe("srv-9"); // canonical id adopted
    // A THIRD delivery of the same snapshot is now a plain id-dedup no-op.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "srv-9", role: "user", text: "hello agent", ts: 42 }],
    });
    expect(wrapper.getState().messages).toHaveLength(1);
  });

  it("does not adopt across different texts, and repeated identical texts adopt one-to-one", () => {
    const wrapper = makeWrapper();
    wrapper.send("ping"); // u-0
    wrapper.send("ping"); // u-1 (repeated identical text)
    deliver(wrapper, {
      type: "history",
      messages: [
        { id: "s1", role: "user", text: "ping", ts: 1 },
        { id: "s2", role: "user", text: "ping", ts: 2 },
        { id: "s3", role: "user", text: "other text", ts: 3 },
      ],
    });
    const messages = wrapper.getState().messages;
    // Two local echoes adopted (s1, s2) + one genuinely-new bubble (s3).
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.id).sort()).toEqual(["s1", "s2", "s3"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 review finding 3: AGENT bubbles need adoption too — the core
// transcript never stores the plugin's live-frame id (`webchannel-…`), so a
// snapshot's agent messages arrive under different (canonical) ids.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — W6 agent-bubble id adoption", () => {
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
    });
  }
  type AnyFrame = { type: string; [k: string]: unknown };
  function deliver(wrapper: WebChannelNATSClient, frame: AnyFrame): void {
    (wrapper as unknown as { handleMessage: (m: AnyFrame) => void }).handleMessage(frame);
  }

  it("adopts the server id onto a LIVE agent bubble instead of duplicating it", () => {
    const wrapper = makeWrapper();
    // Live agent reply (plugin-generated frame id).
    deliver(wrapper, { type: "agent_message", id: "webchannel-1719-abc123", text: "echo: hello" });
    expect(wrapper.getState().messages).toHaveLength(1);

    // Another device registers → snapshot re-delivers the same reply under its
    // core-transcript id.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "core-77", role: "agent", text: "echo: hello", ts: 5 }],
    });
    const messages = wrapper.getState().messages;
    expect(messages).toHaveLength(1); // no duplicate agent bubble
    expect(messages[0].id).toBe("core-77"); // canonical id adopted
    // Re-delivery of the same snapshot is now a plain id-dedup no-op.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "core-77", role: "agent", text: "echo: hello", ts: 5 }],
    });
    expect(wrapper.getState().messages).toHaveLength(1);
  });

  it("also adopts onto id-less live agent bubbles (synthetic a-<n> ids)", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "agent_message", text: "plain reply" }); // no id → a-0
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "core-1", role: "agent", text: "plain reply", ts: 1 }],
    });
    const messages = wrapper.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("core-1");
  });

  it("never adopts onto a working progress draft (its live id must survive for upserts)", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "progress", id: "webchannel-9-live", text: "partial…" });
    // A snapshot whose agent text happens to equal the draft text must NOT
    // steal the draft's id.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "core-9", role: "agent", text: "partial…", ts: 1 }],
    });
    const messages = wrapper.getState().messages;
    expect(messages).toHaveLength(2); // draft + history copy coexist
    // The later FINAL still lands on the draft bubble by its live id.
    deliver(wrapper, { type: "agent_message", id: "webchannel-9-live", text: "final answer" });
    const after = wrapper.getState().messages;
    expect(after.find((m) => m.id === "webchannel-9-live")?.text).toBe("final answer");
    expect(after.find((m) => m.id === "webchannel-9-live")?.working).toBe(false);
  });

  it("tier-3 positional adoption: dedups an agent reply whose LIVE text differs from the stored text", () => {
    // Real openclaw behavior: the live reply frame is reformatted (metadata
    // sections stripped) while the transcript stores the raw model output —
    // exact-text matching can never pair them. The snapshot's structure can:
    // the agent reply follows the user message it answered.
    const wrapper2 = makeWrapper();
    // Turn rendered live on this device: user send (local echo) + agent reply.
    wrapper2.send("hello");
    deliver(wrapper2, { type: "agent_message", id: "webchannel-1-live", text: "short live reply" });
    expect(wrapper2.getState().messages).toHaveLength(2);

    // Snapshot: same turn, canonical ids, RAW (longer) stored agent text.
    deliver(wrapper2, {
      type: "history",
      messages: [
        { id: "core-u1", role: "user", text: "hello", ts: 1 },
        { id: "core-a1", role: "agent", text: "short live reply\n\nplus stored-only metadata", ts: 2 },
      ],
    });
    const messages = wrapper2.getState().messages;
    expect(messages).toHaveLength(2); // no duplicate agent bubble
    expect(messages[0].id).toBe("core-u1");
    expect(messages[1].id).toBe("core-a1"); // adopted positionally
    expect(messages[1].text).toContain("stored-only metadata"); // canonical text kept

    // Re-delivery (next stateless snapshot) is a pure id no-op.
    deliver(wrapper2, {
      type: "history",
      messages: [
        { id: "core-u1", role: "user", text: "hello", ts: 1 },
        { id: "core-a1", role: "agent", text: "short live reply\n\nplus stored-only metadata", ts: 2 },
      ],
    });
    expect(wrapper2.getState().messages).toHaveLength(2);
  });

  it("tier-3 never fires without a matched anchor (unrelated agent history stays a separate bubble)", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "agent_message", id: "webchannel-2-live", text: "live reply" });
    // Snapshot contains a DIFFERENT conversation prefix — no anchor match, so
    // the unknown agent message must NOT steal the live bubble.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "core-x", role: "agent", text: "totally different turn", ts: 1 }],
    });
    const messages = wrapper.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.id === "webchannel-2-live")).toBe(true);
  });
});
