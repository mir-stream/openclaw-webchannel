import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import type { InboundMessage, NatsClientOptions } from "./nats-client.js";
// P1-9 wire-order harness: P0-2 deleted the unauthenticated `.handshake` path, so
// the session-gate / wire-order tests below establish the conversation key the
// way production does — a PoP register round-trip whose reply carries K wrapped
// to the device X25519 key — and assert publish ordering on the encrypted `.in`
// subject. The register-fake + agent-style wrap mirror
// nats-client-wrapped-key.test.ts (node:crypto, independent of the browser impl).
import { inboundSubject, registerSubject } from "./nats-client.js";
import { generateDevicePopKeyPair } from "./pop-register.js";
import type { WrappedConversationKey } from "./e2e-crypto-browser.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";

const registration = {
  devicePrivateKey: {} as CryptoKey,
  deviceX25519PrivateKey: {} as CryptoKey,
};

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
      registration,
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
      registration,
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
      registration,
      heartbeatIntervalMs: 0, // e.g. an embedder disabling the heartbeat
    });
    const built = wrapper["natsOptions"] as NatsClientOptions;
    expect(built.heartbeatIntervalMs).toBe(0);
  });

  it("forwards connectTimeoutMs (P1-3 connect-stage deadline)", () => {
    const wrapper = new WebChannelNATSClient({
      natsUrl: "wss://nats.prod.example.com",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "acct-1",
      tenant: "tenant-1",
      peerId: "peer-1",
      registration,
      connectTimeoutMs: 2_500,
    });
    const built = wrapper["natsOptions"] as NatsClientOptions;
    expect(built.connectTimeoutMs).toBe(2_500);

    // 0 is meaningful (disables the deadline) and must survive the rebuild —
    // a `||`-style fallback would silently re-enable the 10s default.
    const disabled = new WebChannelNATSClient({
      natsUrl: "wss://nats.prod.example.com",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "acct-1",
      tenant: "tenant-1",
      peerId: "peer-1",
      registration,
      connectTimeoutMs: 0,
    });
    expect((disabled["natsOptions"] as NatsClientOptions).connectTimeoutMs).toBe(0);
  });

  it("leaves natsCredentials undefined for open/dev NATS (unchanged behavior)", () => {
    const wrapper = new WebChannelNATSClient({
      natsUrl: "wss://nats.dev.example.com",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "acct-1",
      tenant: "tenant-1",
      peerId: "peer-1",
      registration,
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
  /** P1-9: every raw frame the client wrote, for wire-order assertions. */
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWS.OPEN;
      this.onopen?.();
    });
  }
  send(data: string): void {
    this.sent.push(data);
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
      registration,
      heartbeatIntervalMs: 0,
    });
    wrapper.connect();
    await flush();
    expect(FakeWS.instances[0]?.readyState).toBe(FakeWS.OPEN);
    expect(wrapper.getState()).toMatchObject({ status: "connecting", connected: false });

    FakeWS.instances[0].serverEmit("-ERR 'Authorization Violation'\r\n");
    await flush();

    const state = wrapper.getState();
    expect(state.status).toBe("error");
    expect(state.connected).toBe(false);
    expect(state.error).toMatch(/authorization/i);
    // P1-7: the cause tag lands on state alongside the reason.
    expect(state.errorCause).toBe("auth-rejected");

    // Sticky: a trailing teardown state event must not downgrade it.
    await new Promise((r) => setTimeout(r, 20));
    expect(wrapper.getState().status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// P1-7: the machine-readable error cause threads onto state.errorCause, falls
// back to "unknown" when absent, and is cleared (with error) on reconnect.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P1-7 error cause on state", () => {
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      registration,
    });
  }
  /** Drive the inner client's error listeners (what a real terminal failure does). */
  function emitError(wrapper: WebChannelNATSClient, err: Error, cause?: string): void {
    (wrapper["client"] as unknown as {
      notifyErrorListeners: (e: Error, c?: string) => void;
    }).notifyErrorListeners(err, cause);
  }
  /**
   * Drive a state event through to the wrapper's onState handler. The wrapper
   * subscribes via `WebChannelNatsClient.onState`, which registers straight on the
   * LOW-LEVEL `NatsClient` (`wrapper.client.client`), whose `notifyStateListeners`
   * forwards its `connected` flag — so set the flag and fire it there.
   */
  function emitState(wrapper: WebChannelNATSClient, connected: boolean): void {
    const lowLevel = wrapper["client"]["client"] as unknown as {
      connected: boolean;
      notifyStateListeners: () => void;
    };
    lowLevel.connected = connected;
    lowLevel.notifyStateListeners();
  }

  it("a classified cause lands on state.errorCause", () => {
    const w = makeWrapper();
    emitError(w, new Error("upgrade the older side"), "protocol-mismatch");
    const s = w.getState();
    expect(s.status).toBe("error");
    expect(s.errorCause).toBe("protocol-mismatch");
    expect(s.error).toBe("upgrade the older side");
  });

  it("an unclassified failure (no cause) falls back to \"unknown\"", () => {
    const w = makeWrapper();
    emitError(w, new Error("mystery"));
    expect(w.getState().errorCause).toBe("unknown");
  });

  it("a terminal instance stays in error even after a later connected event (P0-4 permanent retirement)", () => {
    const w = makeWrapper();
    emitError(w, new Error("boom"), "secure-channel-failed");
    expect(w.getState().errorCause).toBe("secure-channel-failed");
    // P0-4 (R3): a CL2 terminal instance is PERMANENTLY retired. A
    // registration-path terminal sets only the WCNC-level latch (the raw
    // transport is not terminal), so a later connected event CAN arrive — but the
    // onState handler must not revive the sticky "error": every send still
    // immediate-fails (terminalReached), so a green status would be a lie.
    // Recovery is a fresh client, never same-instance revival.
    emitState(w, true);
    const s = w.getState();
    expect(s.status).toBe("error");
    expect(s.error).toBe("boom");
    expect(s.errorCause).toBe("secure-channel-failed");
    // #92: the connected event above runs the register hop, which fails ("not
    // connected" — there is no socket) and answers with a REAL-timer redial.
    // Left open, this instance keeps dialing for the rest of the FILE, and its
    // stray sockets land in whatever fake a later describe has installed
    // globally. Close it so the leak dies with the test that caused it.
    //
    // The redial is a HARNESS artifact, not the production shape: `emitError`
    // only fires the error listeners, so `terminalReached` is never set here and
    // `onConnected`'s retirement guard (`nats-client.ts`, "a terminally-retired
    // instance must NOT re-register") does not fire. A real registration-path
    // terminal sets that latch and disconnects instead of redialing.
    w.close();
  });

  it("sticky guard: a trailing onState(false) after an error does NOT clear the cause", () => {
    const w = makeWrapper();
    emitError(w, new Error("boom"), "auth-expired");
    emitState(w, false); // teardown event
    const s = w.getState();
    expect(s.status).toBe("error"); // not downgraded to reconnecting
    expect(s.errorCause).toBe("auth-expired"); // preserved
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
      registration,
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

  it("mints an immediate user echo past a hydrated u-<n> id without sharing its receipt overlay", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "u-0", role: "user", text: "older history", ts: 1 }],
    });

    wrapper.send("new local send");

    const [history, local] = wrapper.getState().messages;
    expect(history).toEqual(expect.objectContaining({
      id: "u-0", role: "user", text: "older history",
    }));
    expect(history).not.toHaveProperty("wireId");
    expect(history).not.toHaveProperty("receiptKey");
    expect(history).not.toHaveProperty("sendState");
    expect(local).toEqual(expect.objectContaining({
      id: "u-1",
      role: "user",
      text: "new local send",
      sendState: "queued",
    }));
    expect(local.turnId).toBe(local.wireId);
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
      registration,
    });
  }
  type AnyFrame = { type: string; [k: string]: unknown };
  function deliver(wrapper: WebChannelNATSClient, frame: AnyFrame): void {
    (wrapper as unknown as { handleMessage: (m: AnyFrame) => void }).handleMessage(frame);
  }

  /**
   * ⚠️ THIS DESCRIBE WAS BUILT ON `core-…` SNAPSHOT IDS AND THAT INPUT NO LONGER
   * EXISTS. #240 half 2 serves history from the plugin's delivery journal, which
   * stores the DELIVERY-ACT id — the same `webchannel-…` the live frame carried.
   * So the reconciliation these tests are named for is not "adoption" any more,
   * it is a tier-1 id match, and the agent-side guessing tiers are deleted.
   * The fixtures are re-based; the properties (no duplicate, correct order,
   * idempotent re-delivery) are asserted unchanged.
   */
  it("keeps one bubble when a snapshot re-delivers a reply this device rendered live", () => {
    const wrapper = makeWrapper();
    // Live agent reply (plugin-minted delivery-act id).
    deliver(wrapper, { type: "agent_message", id: "webchannel-1719-abc123", text: "echo: hello" });
    expect(wrapper.getState().messages).toHaveLength(1);

    // Another device registers → the snapshot re-delivers the same reply. The
    // journal holds it under the id it was DELIVERED with, so this is the same
    // id, and tier 1 does what the adoption used to do.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "webchannel-1719-abc123", role: "agent", text: "echo: hello", ts: 5 }],
    });
    const messages = wrapper.getState().messages;
    expect(messages).toHaveLength(1); // no duplicate agent bubble
    // ⚠️ The id no longer CHANGES. It used to become `core-77` (the transcript's
    // canonical id); the journal's canonical id IS the live id, so "adopting the
    // canonical id" is now a no-op. Same convergence, no rename.
    expect(messages[0].id).toBe("webchannel-1719-abc123");
    // Re-delivery of the same snapshot is a plain id-dedup no-op.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "webchannel-1719-abc123", role: "agent", text: "echo: hello", ts: 5 }],
    });
    expect(wrapper.getState().messages).toHaveLength(1);
  });

  it("never pairs a snapshot row with an id-less live bubble (no journal row exists for it)", () => {
    // ⚠️ INVERTED FROM `also adopts onto id-less live agent bubbles`, because the
    // scenario it asserted is unreachable end to end. An id-less `agent_message`
    // is refused by `isIdlessDurableFrame` (`delivery-journal-event.ts`) and
    // dropped at the egress seam before any write (`nats-channel.ts` logs
    // `idless-durable-frame` and returns), so NO journal row is ever created for
    // this bubble and no snapshot row can correspond to it. The old test adopted
    // a `core-` row onto it by text, which paired two unrelated messages.
    //
    // What a same-text snapshot row actually is here: a DIFFERENT message that
    // happens to read the same. It must fresh-insert. The duplicate is the
    // accepted safe direction — visible and self-healing — versus overwriting a
    // delivered answer. The real repair is a server-assigned id before egress
    // (doc §16.2-1, **#243**).
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "agent_message", text: "plain reply" }); // no id → a-0
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "webchannel-1", role: "agent", text: "plain reply", ts: 1 }],
    });
    const messages = wrapper.getState().messages;
    expect(messages.map((m) => `${m.id}|${m.text}`)).toEqual([
      "webchannel-1|plain reply",
      "a-0|plain reply",
    ]);
  });

  it("mints a legacy id-less agent bubble past a hydrated a-<n> id", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "a-0", role: "agent", text: "older answer", ts: 1 }],
    });

    deliver(wrapper, { type: "agent_message", text: "legacy live answer" });

    expect(wrapper.getState().messages.map(({ id, role, text }) => ({ id, role, text })))
      .toEqual([
        { id: "a-0", role: "agent", text: "older answer" },
        { id: "a-1", role: "agent", text: "legacy live answer" },
      ]);
  });

  it("never adopts onto a working progress draft (its live id must survive for upserts)", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "progress", id: "webchannel-9-live", text: "partial…" });
    // A snapshot whose agent text happens to equal the draft text must NOT
    // steal the draft's id.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "webchannel-9-stored", role: "agent", text: "partial…", ts: 1 }],
    });
    const messages = wrapper.getState().messages;
    expect(messages).toHaveLength(2); // draft + history copy coexist
    // The later FINAL still lands on the draft bubble by its live id.
    deliver(wrapper, { type: "agent_message", id: "webchannel-9-live", text: "final answer" });
    const after = wrapper.getState().messages;
    expect(after.find((m) => m.id === "webchannel-9-live")?.text).toBe("final answer");
    expect(after.find((m) => m.id === "webchannel-9-live")?.working).toBe(false);
  });

  /**
   * ⚠️ THE TIER-3 PREMISE IS DEAD, NOT MERELY UNEXERCISED — DO NOT "RESTORE
   * COVERAGE" BY REBUILDING THE PROBE. This test was
   * `tier-3 positional adoption: dedups an agent reply whose LIVE text differs
   * from the stored text`, and it was correct at the time: openclaw stripped
   * metadata from the live reply frame while the transcript stored raw model
   * output, so exact-text matching could never pair them and only the snapshot's
   * STRUCTURE could. The core-transcript reader is deleted (#240 half 2). The
   * journal stores exactly the text that was published, under the id it was
   * published with, so "live text ≠ stored text" is not merely rare — it cannot
   * be produced.
   *
   * What replaces it is the contract that made tier 3 unsafe: an agent row that
   * matches no id has NO local counterpart (if this device had rendered it, the
   * ids would agree), so it must fresh-insert rather than take a bubble that
   * belongs to a different message.
   */
  it("fresh-inserts an agent row that matches no local id, even right after a matched row", () => {
    const wrapper2 = makeWrapper();
    // Turn rendered live on this device: user send (local echo) + agent reply.
    wrapper2.send("hello");
    deliver(wrapper2, { type: "agent_message", id: "webchannel-1-live", text: "short live reply" });
    expect(wrapper2.getState().messages).toHaveLength(2);

    // The user row matches (tier 2), which is exactly the anchor the old probe
    // needed. The agent row that follows it belongs to a reply this device never
    // rendered — the shape the probe used to grab the local bubble for.
    const snapshot = [
      { id: "wire-u1", role: "user", text: "hello", ts: 1 },
      { id: "webchannel-other", role: "agent", text: "a reply from another device", ts: 2 },
    ];
    deliver(wrapper2, { type: "history", messages: snapshot });

    const messages = wrapper2.getState().messages;
    expect(messages.map((m) => `${m.id}|${m.text}`)).toEqual([
      "wire-u1|hello",
      "webchannel-other|a reply from another device",
      "webchannel-1-live|short live reply", // survives untouched
    ]);

    // Re-delivery is a pure id no-op.
    deliver(wrapper2, { type: "history", messages: snapshot });
    expect(wrapper2.getState().messages).toHaveLength(3);
  });

  // ⚠️ RENAMED: this was `tier-3 never fires without a matched anchor`. It still
  // passes, but the title named a mechanism that no longer exists — the same
  // stale-prose defect this slice spent four rounds on. What it pins is the
  // outcome, which is now unconditional rather than anchor-dependent.
  it("an unrelated agent row never steals a live bubble", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "agent_message", id: "webchannel-2-live", text: "live reply" });
    // A snapshot row from a DIFFERENT turn: it matches no local id, so it must
    // insert rather than take the live bubble.
    deliver(wrapper, {
      type: "history",
      messages: [{ id: "webchannel-x", role: "agent", text: "totally different turn", ts: 1 }],
    });
    const messages = wrapper.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.id === "webchannel-2-live")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #16 ordered snapshot insertion — a mid-session snapshot's NEWER tail must
// append after the matched local prefix (chronological), while pagination and
// initial hydration keep their previous prepend/ordering behavior.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — #16 ordered history insertion", () => {
  type AnyFrame = { type: string; [k: string]: unknown };
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      registration,
    });
  }
  function deliver(wrapper: WebChannelNATSClient, frame: AnyFrame): void {
    (wrapper as unknown as { handleMessage: (m: AnyFrame) => void }).handleMessage(frame);
  }

  it("regression: a snapshot's newer tail is APPENDED after the matched local prefix, not prepended", () => {
    const w = makeWrapper();
    // Local live state: a turn rendered on THIS device (user echo + agent bubble).
    w.send("hi"); // u-0
    deliver(w, { type: "agent_message", id: "webchannel-live-1", text: "hello back" });
    expect(w.getState().messages.map((m) => m.text)).toEqual(["hi", "hello back"]);

    // Another device registered → snapshot carries the matched prefix PLUS a
    // newer turn (sent from that other device, or while this tab was away).
    // Re-based onto journal ids: the agent row carries the id the live frame
    // carried, so the prefix matches at tier 1 (the user row still tier-2
    // adopts, since a local echo is `u-<n>` and the journal holds the wire id).
    deliver(w, {
      type: "history",
      messages: [
        { id: "wire-u1", role: "user", text: "hi", ts: 1 },
        { id: "webchannel-live-1", role: "agent", text: "hello back", ts: 2 },
        { id: "wire-u2", role: "user", text: "second question", ts: 3 },
        { id: "webchannel-a2", role: "agent", text: "second answer", ts: 4 },
      ],
    });

    const messages = w.getState().messages;
    // The two NEW messages land at the BOTTOM, chronologically after the prefix.
    // Length, order and text are UNCHANGED from the pre-cutover expectation —
    // only the ids were re-based.
    expect(messages.map((m) => m.id)).toEqual([
      "wire-u1",
      "webchannel-live-1",
      "wire-u2",
      "webchannel-a2",
    ]);
    expect(messages.map((m) => m.text)).toEqual([
      "hi",
      "hello back",
      "second question",
      "second answer",
    ]);
  });

  // ⚠️ `regression via TIER-3: live agent text differs from stored text` USED TO
  // LIVE HERE AND IS DELETED, NOT SKIPPED. It asserted that a positional probe
  // adopted an agent row whose stored text differed from the live text, and that
  // the newer tail then appended after it. Both halves of its premise died with
  // the core-transcript reader (#240 half 2): the journal stores exactly the
  // published text under the published id, so "live text ≠ stored text" cannot
  // occur, and the probe itself is deleted. The ordering property it shared with
  // the test above is covered there against journal ids; the "an unmatched agent
  // row fresh-inserts instead of stealing a bubble" property is pinned in the W6
  // describe and in `nats-client-wrapper-hydration.test.ts`. Do NOT reintroduce a
  // positional tier to bring this case back — that tier is what lost four
  // messages across four review rounds.

  it("pagination: strictly-older messages with zero overlap prepend at the top, page order preserved", () => {
    const w = makeWrapper();
    // Local state holds canonical-id messages (already hydrated).
    deliver(w, {
      type: "history",
      messages: [
        { id: "c-10", role: "user", text: "newest question", ts: 10 },
        { id: "c-11", role: "agent", text: "newest answer", ts: 11 },
      ],
    });
    expect(w.getState().messages.map((m) => m.id)).toEqual(["c-10", "c-11"]);

    // A loadHistory page of strictly-OLDER messages (no id/text overlap).
    deliver(w, {
      type: "history",
      messages: [
        { id: "c-1", role: "user", text: "old question", ts: 1 },
        { id: "c-2", role: "agent", text: "old answer", ts: 2 },
      ],
    });
    // Older page prepends, in page order, ahead of the existing tail.
    expect(w.getState().messages.map((m) => m.id)).toEqual(["c-1", "c-2", "c-10", "c-11"]);
  });

  it("keeps repeated agent rows distinct when paginating h-form synthetic history ids", () => {
    const w = makeWrapper();

    // The plugin's id-less fallback is `h-<timestamp>-<window-index>`. These
    // rows are settled history, never live agent bubbles eligible for id
    // adoption, even when an older page repeats the same agent text.
    deliver(w, {
      type: "history",
      messages: [
        { id: "h-3000-0", role: "user", text: "newer question", ts: 3000 },
        { id: "h-4000-1", role: "agent", text: "OK", ts: 4000 },
      ],
    });
    deliver(w, {
      type: "history",
      messages: [
        { id: "h-1000-0", role: "user", text: "older question", ts: 1000 },
        { id: "h-2000-1", role: "agent", text: "OK", ts: 2000 },
      ],
    });

    expect(w.getState().messages.map(({ id, text, ts }) => ({ id, text, ts }))).toEqual([
      { id: "h-1000-0", text: "older question", ts: 1000 },
      { id: "h-2000-1", text: "OK", ts: 2000 },
      { id: "h-3000-0", text: "newer question", ts: 3000 },
      { id: "h-4000-1", text: "OK", ts: 4000 },
    ]);
  });

  it("initial hydration: snapshot order preserved into empty state", () => {
    const w = makeWrapper();
    deliver(w, {
      type: "history",
      messages: [
        { id: "h-1", role: "user", text: "one", ts: 1 },
        { id: "h-2", role: "agent", text: "two", ts: 2 },
        { id: "h-3", role: "user", text: "three", ts: 3 },
      ],
    });
    expect(w.getState().messages.map((m) => m.id)).toEqual(["h-1", "h-2", "h-3"]);
  });

  it("gap insertion: a fresh message between two matched local messages lands BETWEEN them", () => {
    const w = makeWrapper();
    // Two live user echoes on this device (no agent turns between them locally).
    w.send("first"); // u-0
    w.send("third"); // u-1
    expect(w.getState().messages.map((m) => m.text)).toEqual(["first", "third"]);

    // Snapshot: matches local idx 0, a FRESH unseen message, then matches idx 1.
    deliver(w, {
      type: "history",
      messages: [
        { id: "s-first", role: "user", text: "first", ts: 1 },
        { id: "s-mid", role: "agent", text: "second (server-only)", ts: 2 },
        { id: "s-third", role: "user", text: "third", ts: 3 },
      ],
    });

    const messages = w.getState().messages;
    // The fresh message is spliced BETWEEN the two adopted local echoes.
    expect(messages.map((m) => m.text)).toEqual(["first", "second (server-only)", "third"]);
    expect(messages.map((m) => m.id)).toEqual(["s-first", "s-mid", "s-third"]);
  });
});

// ---------------------------------------------------------------------------
// #94 multi-bubble turns — PRE-FIX CHARACTERIZATION.
//
// Until now the plugin reused ONE draft id per turn, so a turn was exactly one
// agent bubble and tier-3 positional adoption was an exception path (it fired
// only when a single live reply's text had been reformatted). The #94 fix
// rotates the draft lane per assistant message, so a turn becomes N bubbles
// sharing one turnId under N DIFFERENT ids — and tier-3 becomes the ROUTINE
// path, because every one of those bubbles carries a live-only
// `webchannel-…` id that the core transcript never stores.
//
// These tests pin the client's existing behavior against that new shape BEFORE
// the plugin changes. They are deliberately assertions about code that already
// works by construction rather than by test — the point is to freeze it, so a
// later refactor of the reconciler cannot silently regress multi-bubble turns
// into duplicates or dropped replies. Nothing here changes production code.
//
// The asymmetric cases (C3/C4) are the interesting ones: live bubble count and
// snapshot row count are allowed to disagree (a live bubble that never made it
// into the transcript, or a defensive lane rotation the core coalesced away),
// and the reconciler must still converge without duplicating or losing text.
// C7 records the complementary protocol constraint: once history adopts a
// canonical id, the reducer keeps no alias for the old live id. An ambiguous
// final must therefore avoid mutating either the canonical id or the now-stale
// live id. C8 pins the separate provisional-id ordering constraint: the first
// successful independent delivery must replace a visible preview in place;
// appending it under a fresh id lets a later lane rewrite the older array slot.
// Once claimed, the old scaffold writer must also stop: a later progress frame
// on P would overwrite the durable payload because the reducer upserts by id.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — #94 multi-bubble turn reconciliation", () => {
  type AnyFrame = { type: string; [k: string]: unknown };
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      registration,
    });
  }
  function deliver(wrapper: WebChannelNATSClient, frame: AnyFrame): void {
    (wrapper as unknown as { handleMessage: (m: AnyFrame) => void }).handleMessage(frame);
  }

  /**
   * One assistant message of a post-#94 turn: a streaming draft on its own lane
   * id, then the final frame that settles that same lane. Both frames carry the
   * SHARED turnId — that is the whole shape change #94 introduces.
   */
  function liveBubble(
    w: WebChannelNATSClient,
    id: string,
    turnId: string,
    partial: string,
    final: string,
  ): void {
    deliver(w, { type: "progress", id, turnId, text: partial });
    deliver(w, { type: "agent_message", id, turnId, text: final });
  }

  // --- C1: live-only, no snapshot involved. -------------------------------
  it("C1: two lanes of one turn render as two independent bubbles in arrival order", () => {
    const w = makeWrapper();
    // Post-#94 plugin output: one turn, two assistant messages, two lane ids.
    liveBubble(w, "webchannel-a", "T", "first partial…", "first answer");
    liveBubble(w, "webchannel-b", "T", "second partial…", "second answer");

    const messages = w.getState().messages;
    // Distinct ids ⇒ distinct upsert targets: the second lane must APPEND, not
    // overwrite the first (pre-#94 the shared id made the second frame clobber
    // the first bubble's text — that is exactly the data loss #94 fixes).
    expect(messages.map((m) => m.id)).toEqual(["webchannel-a", "webchannel-b"]);
    expect(messages.map((m) => m.text)).toEqual(["first answer", "second answer"]);
    // Each lane settled on its own final frame; neither is left streaming.
    expect(messages.map((m) => m.working)).toEqual([false, false]);
    // The shared turnId rides along on both (it is what turn_settled and the
    // reasoning disarm correlate on).
    expect(messages.map((m) => m.turnId)).toEqual(["T", "T"]);
  });

  // --- C2: symmetric live 2 / snapshot 2. ---------------------------------
  /**
   * ⚠️ EVERY SNAPSHOT FIXTURE IN THIS DESCRIBE WAS RE-BASED AT #240 HALF 2.
   * They were written against `core-…` transcript ids and an explicit premise —
   * "the stored agent text carries the metadata core strips from live frames, so
   * it is NOT byte-equal to either live text ⇒ tier 2 cannot match and tier 3
   * must carry both". History now comes from the plugin's delivery journal,
   * which stores the exact published text under the delivery-act id, so that
   * premise is unproducible and the agent-side tiers are deleted. Each case
   * below now runs on tier 1 for agent rows and tier 2 for the user echo. The
   * per-case notes record where a FINAL expectation changed rather than just
   * the ids — C4b and C7 are the two that did.
   */
  it("C2: a snapshot of a two-bubble turn matches BOTH lanes by id instead of duplicating", () => {
    const w = makeWrapper();
    w.send("hello"); // u-0 local echo
    liveBubble(w, "webchannel-a", "T", "…", "live A");
    liveBubble(w, "webchannel-b", "T", "…", "live B");
    expect(w.getState().messages).toHaveLength(3);

    // Snapshot from another device's register. Both lanes were DELIVERED, so the
    // journal holds one row each under the id each was delivered with, carrying
    // the text that was actually published.
    const snapshot = [
      { id: "wire-u1", role: "user", text: "hello", ts: 1 },
      { id: "webchannel-a", role: "agent", text: "live A", ts: 2 },
      { id: "webchannel-b", role: "agent", text: "live B", ts: 3 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // wire-u1 tier-2 adopts u-0 → cursor=1; webchannel-a and webchannel-b are
    // tier-1 hits in place. No guessing is involved at any step.
    //
    // The long "anchor advancement" mutation note that used to sit here is gone
    // with the anchor: it explained how tier 3 chained probes across multi-lane
    // turns, and there is no probe to chain.
    expect(messages).toHaveLength(3); // no duplicates
    expect(messages.map((m) => m.id)).toEqual(["wire-u1", "webchannel-a", "webchannel-b"]);
    // ⚠️ TEXT EXPECTATION CHANGED, and only because the fixture's premise did:
    // there is no "<stored metadata>" divergence to converge onto any more, so
    // the stored text IS the live text. Same three bubbles, same order.
    expect(messages.map((m) => m.text)).toEqual([
      "hello",
      "live A",
      "live B",
    ]);

    // Stateless register re-delivers the same snapshot on every register by any
    // device, so the repeat must leave the array alone — same count, same ids,
    // same order — or a busy multi-device room would grow duplicates over time.
    // (This asserts the OUTCOME only. The reconciler happens to reach it via an
    // early return, but a rebuild that reproduces the identical array is just as
    // acceptable here; nothing below pins the mechanism.)
    deliver(w, { type: "history", messages: snapshot });
    const after = w.getState().messages;
    expect(after).toHaveLength(3);
    expect(after.map((m) => m.id)).toEqual(["wire-u1", "webchannel-a", "webchannel-b"]);
  });

  // --- C3: asymmetric live 1 / snapshot 2, the FIRST lane never settled. ---
  it("C3: when the first lane never settled, the missing reply is inserted and the surviving bubble keeps its id", () => {
    const w = makeWrapper();
    // §8-1: lane A never settled on this device (its frames were lost), so the
    // only agent bubble here is lane B — the SECOND reply. The snapshot carries
    // both rows, because both were delivered SOMEWHERE and so both are journaled.
    w.send("hello"); // u-0
    liveBubble(w, "webchannel-b", "T", "…", "live B");
    expect(w.getState().messages).toHaveLength(2);

    const snapshot = [
      { id: "wire-u1", role: "user", text: "hello", ts: 1 },
      { id: "webchannel-a", role: "agent", text: "reply A", ts: 2 },
      { id: "webchannel-b", role: "agent", text: "live B", ts: 3 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // wire-u1 tier-2 adopts u-0 → cursor=1. webchannel-a misses tier 1 (this
    // device never rendered it) and fresh-inserts at cursor 1. webchannel-b is a
    // tier-1 hit on the local bubble, in place.
    //
    // ⚠️ THIS CASE GOT STRICTLY BETTER AND THE OLD NOTE IS WORTH KEEPING AS
    // HISTORY. Under tier 3 the array converged but the IDENTITIES were shifted
    // by one slot: lane A's row was processed first, probed `anchor + 1`, found
    // the lane-B bubble sitting there and adopted A's row onto it — so the
    // surviving bubble ended up carrying the wrong message's id, and only the
    // leftover row landing after it made the final array look right. The old
    // comment called that out explicitly ("the agent bubble's identity shifts by
    // one slot… the path is not the one the plan describes"). With id matching
    // there is no shift: each row lands on its own message. Same length, same
    // order, same texts — correct for a better reason.
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.id)).toEqual(["wire-u1", "webchannel-a", "webchannel-b"]);
    expect(messages.map((m) => m.text)).toEqual([
      "hello",
      "reply A",
      "live B",
    ]);
    // The fresh row lands settled — history is never streaming.
    expect(messages[1].working).toBe(false);

    // Repeat delivery is a plain id no-op.
    deliver(w, { type: "history", messages: snapshot });
    const after = w.getState().messages;
    expect(after).toHaveLength(3);
    expect(after.map((m) => m.id)).toEqual(["wire-u1", "webchannel-a", "webchannel-b"]);
    expect(after.map((m) => m.text)).toEqual([
      "hello",
      "reply A",
      "live B",
    ]);
  });

  // --- C3b: asymmetric live 1 / snapshot 2, the LAST lane never arrived. ---
  it("C3b: a trailing reply this device never rendered is inserted after the adopted bubble", () => {
    const w = makeWrapper();
    // §8-4 (reconnect/register history recovers messages this device missed):
    // the LATER lane never rendered here at all — the tab was away or the
    // frames were dropped — so the snapshot carries a trailing reply this
    // device has no local bubble for.
    w.send("hello"); // u-0
    liveBubble(w, "webchannel-a", "T", "…", "live A");
    expect(w.getState().messages).toHaveLength(2);

    const snapshot = [
      { id: "wire-u1", role: "user", text: "hello", ts: 1 },
      { id: "webchannel-a", role: "agent", text: "live A", ts: 2 },
      { id: "webchannel-a2", role: "agent", text: "the reply this device never saw", ts: 3 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // wire-u1 → tier-2 adopt idx 0, cursor=1.
    // webchannel-a → tier-1 hit at idx 1, cursor=2.
    // webchannel-a2 → no local counterpart, fresh-inserts at cursor=2.
    // WHAT THIS CASE CONSTRAINS NOW: that the cursor advances past a tier-1 hit,
    // so the trailing row lands AFTER the matched prefix instead of being
    // prepended. Dropping `cursor = li + 1` from the tier-1 branch misplaces it.
    // (It used to constrain "that tier 3 fires at all", which is no longer a
    // thing that can fire.)
    expect(messages).toHaveLength(3); // nothing lost, nothing duplicated
    expect(messages.map((m) => m.id)).toEqual(["wire-u1", "webchannel-a", "webchannel-a2"]);
    expect(messages[1].text).toBe("live A");
    expect(messages[2].text).toBe("the reply this device never saw");
    // The fresh row lands settled — it is history, never streaming.
    expect(messages[2].working).toBe(false);

    deliver(w, { type: "history", messages: snapshot });
    const after = w.getState().messages;
    expect(after).toHaveLength(3);
    expect(after.map((m) => m.id)).toEqual(["wire-u1", "webchannel-a", "webchannel-a2"]);
  });

  // --- C4: asymmetric live 3 / snapshot 2 (snapshot predates the last lane). -
  it("C4: a live bubble newer than one snapshot is preserved, then adopted by a later complete snapshot", () => {
    const w = makeWrapper();
    // §8-4, read in the other direction: the register that produced this
    // snapshot happened BEFORE lane C was persisted, so the snapshot is simply
    // a prefix of what this device already holds — three live agent bubbles
    // against two stored rows, with lane C corresponding to no row at all.
    // (This is NOT the §6.5.1 defensive-rotation divergence, where the last
    // stored row DOES correspond to the last live bubble. C4b covers that.)
    w.send("hello"); // u-0
    liveBubble(w, "webchannel-a", "T", "…", "live A");
    liveBubble(w, "webchannel-b", "T", "…", "live B");
    liveBubble(w, "webchannel-c", "T", "…", "live C");
    expect(w.getState().messages).toHaveLength(4);

    const snapshot = [
      { id: "wire-u1", role: "user", text: "hello", ts: 1 },
      { id: "webchannel-a", role: "agent", text: "live A", ts: 2 },
      { id: "webchannel-b", role: "agent", text: "live B", ts: 3 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // wire-u1 → tier-2 adopt idx 0; webchannel-a → idx 1; webchannel-b → idx 2,
    // both tier-1. The snapshot runs out before the local array does, so idx 3
    // (lane C) is simply never mentioned and keeps its live id and text.
    // The invariant being frozen: a live bubble the snapshot does not reach must
    // survive untouched and in place, and a later snapshot that DOES carry it
    // must match it rather than duplicate it. Dropping it would lose a rendered
    // reply; inserting the snapshot rows around it would duplicate one.
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.id)).toEqual([
      "wire-u1",
      "webchannel-a",
      "webchannel-b",
      "webchannel-c",
    ]);
    expect(messages.map((m) => m.text)).toEqual([
      "hello",
      "live A",
      "live B",
      "live C",
    ]);

    // Repeat the prefix first: the three snapshot ids are all tier-1 hits and
    // lane C is still newer than the snapshot, so it remains untouched.
    deliver(w, { type: "history", messages: snapshot });
    const afterPrefixRepeat = w.getState().messages;
    expect(afterPrefixRepeat).toHaveLength(4);
    expect(afterPrefixRepeat.map((m) => m.id)).toEqual([
      "wire-u1",
      "webchannel-a",
      "webchannel-b",
      "webchannel-c",
    ]);

    // A later register snapshot now includes lane C, under the id lane C was
    // delivered with — so it is a fourth tier-1 hit rather than a positional
    // probe. (The old fixture gave it a distinct `core-a3` and a divergent
    // stored text specifically to force tier 3; neither is producible now.)
    const completeSnapshot = [
      ...snapshot,
      { id: "webchannel-c", role: "agent", text: "live C", ts: 4 },
    ];
    deliver(w, { type: "history", messages: completeSnapshot });

    const matched = w.getState().messages;
    expect(matched).toHaveLength(4);
    expect(matched.map((m) => m.id)).toEqual([
      "wire-u1",
      "webchannel-a",
      "webchannel-b",
      "webchannel-c",
    ]);
    expect(matched[3].text).toBe("live C");
    expect(matched[3].working).toBe(false);

    // The complete snapshot stays a pure tier-1 id no-op.
    deliver(w, { type: "history", messages: completeSnapshot });
    expect(w.getState().messages.map((m) => m.id)).toEqual([
      "wire-u1",
      "webchannel-a",
      "webchannel-b",
      "webchannel-c",
    ]);
  });

  // --- C4b: the §6.5.1 defensive rotation, after the cutover. --------------
  //
  // ⚠️ THIS TEST'S FINAL EXPECTATION CHANGED, AND IT IS THE BIGGEST CHANGE IN
  // THIS FILE — it used to be a COST LEDGER for a divergence that no longer
  // exists. Read this note before touching it.
  //
  // §6.5.1 accepts that when the plugin cannot prove a boundary is the same
  // assistant message it rotates the lane defensively, so ONE assistant message
  // rewritten mid-flight renders as TWO live bubbles. The old test then said:
  // the CORE TRANSCRIPT stored that rewrite as ONE row, tier 3 paired that row
  // onto the WRONG live bubble, and the session showed 4 bubbles while a full
  // reload showed 3 — a session/reload gap it existed to keep visible.
  //
  // Both halves of that are gone. The journal does not store "the assistant
  // message"; it stores what was DELIVERED, and both lanes were delivered, so it
  // holds a row for each under its own delivery-act id. And tier 3 is deleted,
  // so nothing pairs anything positionally. The session and the reload now agree
  // at FOUR — which is the doc's Q5/N8 discipline working as designed: the
  // journal mirrors live faithfully, and if live double-renders a defensive
  // rotation then history double-renders it identically. Inventing a
  // supersession rule in the projection to collapse them is exactly the N8 the
  // store exists to prevent.
  //
  // The double render itself is NOT fixed here and is not history's problem: it
  // is live-path routing (#215/#223). What the cutover removed is the SECOND
  // defect that used to sit on top of it — the mis-pairing and the
  // session-vs-reload gap.
  it("C4b: §6.5.1 — a defensively-rotated rewrite renders identically live and on reload", () => {
    const w = makeWrapper();
    w.send("hello"); // u-0
    liveBubble(w, "webchannel-a", "T", "…", "msg A");
    // One assistant message, rewritten mid-flight across a defensive rotation:
    // lane B held the pre-rewrite rendering, lane C the final one.
    liveBubble(w, "webchannel-b", "T", "…", "msg C draft");
    liveBubble(w, "webchannel-c", "T", "…", "msg C rewritten");
    expect(w.getState().messages).toHaveLength(4);

    // Both lanes were published to this peer, so the journal carries both.
    const snapshot = [
      { id: "wire-u1", role: "user", text: "hello", ts: 1 },
      { id: "webchannel-a", role: "agent", text: "msg A", ts: 2 },
      { id: "webchannel-b", role: "agent", text: "msg C draft", ts: 3 },
      { id: "webchannel-c", role: "agent", text: "msg C rewritten", ts: 4 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // Every agent row is a tier-1 hit on the bubble it was delivered as. No row
    // is carried onto a lane it does not describe.
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.id)).toEqual([
      "wire-u1",
      "webchannel-a",
      "webchannel-b",
      "webchannel-c",
    ]);
    expect(messages.map((m) => m.text)).toEqual([
      "hello",
      "msg A",
      "msg C draft",
      "msg C rewritten",
    ]);

    // Still idempotent.
    deliver(w, { type: "history", messages: snapshot });
    expect(w.getState().messages).toHaveLength(4);

    // ⚠️ THE GAP THIS TEST WAS BUILT TO MEASURE IS CLOSED. A full reload used to
    // yield THREE bubbles against the session's four; the same snapshot hydrated
    // into empty state now yields the same four, in the same order, with the
    // same text. If this ever diverges again, the projection has started
    // inventing supersession — look there first, not at the client.
    const reloaded = makeWrapper();
    deliver(reloaded, { type: "history", messages: snapshot });
    expect(reloaded.getState().messages.map((m) => `${m.id}|${m.text}`)).toEqual(
      w.getState().messages.map((m) => `${m.id}|${m.text}`),
    );
  });

  // --- C5(a): one turn_settled must settle EVERY lane of its turn. --------
  it("C5a: a single turn_settled settles every lane sharing its turnId — #251: dropping the unfinalized ones", () => {
    const w = makeWrapper();
    // Three lanes of turn T left streaming (their final frames never arrived),
    // plus one lane of an unrelated turn U.
    deliver(w, { type: "progress", id: "webchannel-a", turnId: "T", text: "A partial…" });
    deliver(w, { type: "progress", id: "webchannel-b", turnId: "T", text: "B partial…" });
    deliver(w, { type: "progress", id: "webchannel-c", turnId: "T", text: "C partial…" });
    deliver(w, { type: "progress", id: "webchannel-z", turnId: "U", text: "Z partial…" });
    expect(w.getState().messages.map((m) => m.working)).toEqual([true, true, true, true]);

    // Settlement correlates by turnId, not by draft id — so ONE frame has to
    // clear all N lanes of that turn. If it settled only the newest draft, the
    // older lanes would stay `working` and keep turnInFlight() true, wedging
    // the composer until some other unwedge path fires — an explicit /stop
    // (finalizeLocalTurnState) or a reconnect arming the staleness valve.
    deliver(w, { type: "turn_settled", turnId: "T" });

    const messages = w.getState().messages;
    // #251: all three lanes of T claimed a slot and never received durable text,
    // so settling them DROPS them. This used to assert finalize-in-place — three
    // bubbles left showing "A/B/C partial…" forever, which is the freeze the
    // issue is about. Z belongs to turn U, is untouched, and stays working: that
    // is what proves the settle is still scoped BY turnId and not a blanket sweep.
    expect(messages.map((m) => m.id)).toEqual(["webchannel-z"]);
    expect(messages.map((m) => m.working)).toEqual([true]);
    expect(messages[0].text).toBe("Z partial…");
    // The lockout property the test exists for: no lane of T is left `working`,
    // so turnInFlight() no longer holds on T's account.
    expect(
      w.getState().messages.some((m) => m.turnId === "T" && m.working),
    ).toBe(false);
  });

  // --- C6: the first tool scaffold is a provisional preview, not a lane. --
  it("C6: reusing the provisional scaffold id for the first durable answer leaves no ghost bubble", () => {
    const w = makeWrapper();

    // The plugin may show tool activity before it knows which assistant-message
    // lane will first produce durable text. The post-#94 wire contract keeps
    // that id provisional: if an empty/tool-only assistant message is followed
    // by answer B, B claims the SAME id and replaces the scaffold in place.
    deliver(w, {
      type: "progress",
      id: "webchannel-preview",
      turnId: "T",
      text: "Working…\n🛠️ read_file",
    });
    deliver(w, {
      type: "progress",
      id: "webchannel-preview",
      turnId: "T",
      text: "B partial…",
    });
    deliver(w, {
      type: "agent_message",
      id: "webchannel-preview",
      turnId: "T",
      text: "B final",
    });
    deliver(w, { type: "turn_settled", turnId: "T", outcome: "ok" });

    const messages = w.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "webchannel-preview",
      turnId: "T",
      text: "B final",
      working: false,
    });
    expect(messages.some((m) => m.text.includes("Working"))).toBe(false);
  });

  // --- C7: history adoption makes the old live ids stale. -----------------
  it("C7: snapshot-matched lanes stay unchanged while fresh fallback ids append independently", () => {
    const w = makeWrapper();

    // Before core's terminal array arrives, both lanes have been materialized by
    // the ordinary lane path. A register snapshot then re-delivers them — under
    // the SAME ids, because that is what the journal stores.
    w.send("hello"); // u-0 local echo
    liveBubble(w, "webchannel-a", "T", "A partial…", "A streamed");
    liveBubble(w, "webchannel-b", "T", "B partial…", "B streamed");
    deliver(w, {
      type: "history",
      messages: [
        { id: "wire-u1", role: "user", text: "hello", ts: 1 },
        { id: "webchannel-a", role: "agent", text: "A streamed", ts: 2 },
        { id: "webchannel-b", role: "agent", text: "B streamed", ts: 3 },
      ],
    });
    expect(w.getState().messages.map((m) => m.id)).toEqual([
      "wire-u1",
      "webchannel-a",
      "webchannel-b",
    ]);

    // OpenClaw 2026.6.10 can now deliver [error, A1, A2, B]. The public final
    // seam has no assistant-message/block identity, so after the leading error
    // the plugin preserves every non-notice payload under a FRESH fallback id.
    // This is intentionally at-least-once: canonical A/B stay untouched while
    // the uncorrelated payloads append, even when their content repeats A/B.
    deliver(w, {
      type: "agent_message",
      id: "webchannel-error",
      turnId: "T",
      text: "⚠️ The model errored.",
    });
    deliver(w, {
      type: "agent_message",
      id: "webchannel-fallback-a1",
      turnId: "T",
      text: "A1 uncorrelated final",
    });
    deliver(w, {
      type: "agent_message",
      id: "webchannel-fallback-a2",
      turnId: "T",
      text: "A2 uncorrelated final",
    });
    deliver(w, {
      type: "agent_message",
      id: "webchannel-fallback-b",
      turnId: "T",
      text: "B uncorrelated final",
    });
    deliver(w, { type: "turn_settled", turnId: "T", outcome: "error" });

    const messages = w.getState().messages;
    expect(messages.map((m) => m.id)).toEqual([
      "wire-u1",
      "webchannel-a",
      "webchannel-b",
      "webchannel-error",
      "webchannel-fallback-a1",
      "webchannel-fallback-a2",
      "webchannel-fallback-b",
    ]);
    expect(messages.map((m) => m.text)).toEqual([
      "hello",
      "A streamed",
      "B streamed",
      "⚠️ The model errored.",
      "A1 uncorrelated final",
      "A2 uncorrelated final",
      "B uncorrelated final",
    ]);
    expect(messages.map((m) => m.working)).toEqual([
      undefined,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);

    // ⚠️ FINAL EXPECTATION CHANGED HERE, AND THE OLD LEDGER ENTRY IS RETIRED
    // RATHER THAN RE-BASED. This used to inject a "stale" upsert on the live
    // lane id and assert it APPENDED an eighth bubble: history adoption had
    // renamed lane A to `core-a1` and the client kept no alias for the old id,
    // so the upsert matched nothing. That cost was created by the renaming, and
    // the journal does not rename — lane A still IS `webchannel-a` — so the same
    // upsert now lands on its own bubble, in place. Seven bubbles, not eight.
    //
    // The surrounding property is unchanged and is what this case is really for:
    // an uncorrelated final must mint a FRESH id rather than guess an old lane,
    // and those fallback bubbles append independently of the matched lanes.
    deliver(w, {
      type: "agent_message",
      id: "webchannel-a",
      turnId: "T",
      text: "A late upsert on the same lane",
    });
    expect(w.getState().messages.map((m) => m.id)).toEqual([
      "wire-u1",
      "webchannel-a",
      "webchannel-b",
      "webchannel-error",
      "webchannel-fallback-a1",
      "webchannel-fallback-a2",
      "webchannel-fallback-b",
    ]);
    expect(w.getState().messages[1].text).toBe("A late upsert on the same lane");
  });

  // --- C8: independent delivery must claim a visible provisional id. ------
  it("C8: preview claim preserves order and exposes fresh-first and late-scaffold mutation costs", () => {
    const claimed = makeWrapper();

    // Correct post-#94 shape. The independent block is not assigned to an
    // assistant lane, but it is the first successful durable consumer of P.
    // Reusing P replaces the scaffold at its existing array position; B must
    // then append under a new lane id.
    deliver(claimed, {
      type: "progress",
      id: "webchannel-preview",
      turnId: "T",
      text: "Working…",
    });
    deliver(claimed, {
      type: "agent_message",
      id: "webchannel-preview",
      turnId: "T",
      text: "A authorized block",
    });
    liveBubble(claimed, "webchannel-b", "T", "B partial…", "B final");
    deliver(claimed, { type: "turn_settled", turnId: "T", outcome: "ok" });

    expect(claimed.getState().messages.map((m) => m.id)).toEqual([
      "webchannel-preview",
      "webchannel-b",
    ]);
    expect(claimed.getState().messages.map((m) => m.text)).toEqual([
      "A authorized block",
      "B final",
    ]);
    expect(claimed.getState().messages.map((m) => m.working)).toEqual([false, false]);

    const claimedBlockOnly = makeWrapper();

    // The same successful P claim in a block-only turn replaces the scaffold
    // and gives cleanup exactly one already-settled durable bubble.
    deliver(claimedBlockOnly, {
      type: "progress",
      id: "webchannel-preview",
      turnId: "T",
      text: "Working…",
    });
    deliver(claimedBlockOnly, {
      type: "agent_message",
      id: "webchannel-preview",
      turnId: "T",
      text: "A authorized block",
    });
    deliver(claimedBlockOnly, { type: "turn_settled", turnId: "T", outcome: "ok" });

    expect(claimedBlockOnly.getState().messages).toHaveLength(1);
    expect(claimedBlockOnly.getState().messages[0]).toMatchObject({
      id: "webchannel-preview",
      text: "A authorized block",
      working: false,
    });

    const freshFirst = makeWrapper();

    // Mutation/cost ledger: deliberately append F while P is still unclaimed,
    // then let B reuse P. Upsert preserves P's older array slot, so the reducer
    // produces [B(P), F] even though F arrived first. This is why the plugin
    // must reserve P before the independent send and commit only on success.
    deliver(freshFirst, {
      type: "progress",
      id: "webchannel-preview",
      turnId: "T",
      text: "Working…",
    });
    deliver(freshFirst, {
      type: "agent_message",
      id: "webchannel-fallback-a",
      turnId: "T",
      text: "A authorized block",
    });
    liveBubble(freshFirst, "webchannel-preview", "T", "B partial…", "B final");
    deliver(freshFirst, { type: "turn_settled", turnId: "T", outcome: "ok" });

    expect(freshFirst.getState().messages.map((m) => m.id)).toEqual([
      "webchannel-preview",
      "webchannel-fallback-a",
    ]);
    expect(freshFirst.getState().messages.map((m) => m.text)).toEqual([
      "B final",
      "A authorized block",
    ]);

    const blockOnlyFresh = makeWrapper();

    // The same invalid fresh-first shape in a block-only turn leaves P with no
    // payload that can replace it.
    //
    // #251: the two-bubble [ghost P, F] cost this comment used to describe is
    // GONE, not deferred. P claimed a slot, streamed "Working…", and never
    // received durable text, so turn_settled DROPS it — exactly as core's
    // built-in Telegram extension deletes an unfinalized preview at turn end
    // (`[core] extensions/telegram/src/bot-message-dispatch.ts:2971-2975`). The
    // ledger entry that survives is the ORDERING one above (fresh-first still
    // produces [B(P), F] when P is claimed); the ghost bubble is no longer part
    // of the cost of getting it wrong.
    deliver(blockOnlyFresh, {
      type: "progress",
      id: "webchannel-preview",
      turnId: "T",
      text: "Working…",
    });
    deliver(blockOnlyFresh, {
      type: "agent_message",
      id: "webchannel-fallback-a",
      turnId: "T",
      text: "A authorized block",
    });
    deliver(blockOnlyFresh, { type: "turn_settled", turnId: "T", outcome: "ok" });

    expect(blockOnlyFresh.getState().messages.map((m) => m.id)).toEqual([
      "webchannel-fallback-a",
    ]);
    expect(blockOnlyFresh.getState().messages.map((m) => m.text)).toEqual([
      "A authorized block",
    ]);
    expect(blockOnlyFresh.getState().messages.map((m) => m.working)).toEqual([false]);

    const lateScaffoldMutation = makeWrapper();

    // Second mutation/cost ledger: even after agent_message(P) made A durable,
    // the reducer accepts a later progress(P) as an in-place update. The plugin
    // must therefore invalidate the provisional scaffold writer on ANY claim;
    // otherwise a late tool/item event replaces A with Working… and reopens it.
    deliver(lateScaffoldMutation, {
      type: "progress",
      id: "webchannel-preview",
      turnId: "T",
      text: "Working…",
    });
    deliver(lateScaffoldMutation, {
      type: "agent_message",
      id: "webchannel-preview",
      turnId: "T",
      text: "A authorized block",
    });
    deliver(lateScaffoldMutation, {
      type: "progress",
      id: "webchannel-preview",
      turnId: "T",
      text: "Working… after claim",
    });

    expect(lateScaffoldMutation.getState().messages).toHaveLength(1);
    expect(lateScaffoldMutation.getState().messages[0]).toMatchObject({
      id: "webchannel-preview",
      text: "Working… after claim",
      working: true,
    });
    // …and the cost STOPS at wrong text. #251 made an unfinalized lane droppable
    // at turn end, so a late progress that re-marked this bubble `draftOnly`
    // would escalate the mutation above into DELETION of a delivered answer:
    //
    //   agent_message P "A authorized block" → progress P "Working…" → turn_settled → []
    //
    // The `progress` mapper therefore only ever CLAIMS `draftOnly`, never ADDS it
    // to a bubble that already exists without it. Delivering the settle here is
    // what makes that a regression net rather than a comment — the pre-existing
    // version of this test stopped before `turn_settled` and could not see it.
    deliver(lateScaffoldMutation, { type: "turn_settled", turnId: "T", outcome: "ok" });
    expect(lateScaffoldMutation.getState().messages).toHaveLength(1);
    expect(lateScaffoldMutation.getState().messages[0]).toMatchObject({
      id: "webchannel-preview",
      working: false,
    });
    expect(lateScaffoldMutation.getState().messages[0].draftOnly).toBeUndefined();

    // And the bubble surviving is what leaves the damage REPAIRABLE: the turn's
    // authoritative snapshot restores the authored text a deleted bubble could
    // not have received (M212g — a visible duplicate/wrong text is recoverable
    // where a deletion is not, `packages/plugin/src/message-adapter.ts:1760-1761`).
    deliver(lateScaffoldMutation, {
      type: "turn_snapshot",
      turnId: "T",
      answers: [{ id: "webchannel-preview", text: "A authorized block" }],
      remove: [],
    });
    expect(lateScaffoldMutation.getState().messages.map((m) => m.text)).toEqual([
      "A authorized block",
    ]);
  });

  it("an id-bearing final is materialized before its notification can re-enter with /stop", () => {
    const w = makeWrapper();
    deliver(w, {
      type: "progress",
      id: "laneA",
      turnId: "T",
      text: "partial A",
    });

    let observedFinal: ReturnType<WebChannelNATSClient["getState"]>["messages"][number]
      | undefined;
    let observedTyping: boolean | undefined;
    let reentered = false;
    const unsubscribe = w.subscribe((state) => {
      if (reentered) return;
      reentered = true;
      observedFinal = state.messages.find((message) => message.id === "laneA");
      observedTyping = state.isTyping;
      w.send("/stop");
    });

    deliver(w, {
      type: "agent_message",
      id: "laneA",
      turnId: "T",
      text: "final A",
    });
    unsubscribe();

    expect(reentered).toBe(true);
    expect(observedTyping).toBe(false);
    expect(observedFinal).toMatchObject({
      id: "laneA",
      text: "final A",
      working: false,
    });
    expect(observedFinal?.draftOnly).toBeUndefined();
    expect(w.getState().messages.map((message) => message.id)).toEqual(["laneA", "u-0"]);
    expect(w.getState().messages.filter((message) => message.id === "laneA"))
      .toHaveLength(1);
    expect(w.getState().messages.find((message) => message.id === "u-0")?.text)
      .toBe("/stop");
  });

  // --- #212: turn_snapshot pure-view reconciliation. ----------------------
  it("S1: the mid-lane snapshot fixes order/text, mints the failed lane, drops the overflow, and preserves EVERYTHING else", () => {
    const w = makeWrapper();
    // A user bubble with real send-state (must be untouched by the snapshot).
    w.send("do the thing"); // u-0
    expect(w.getState().messages.find((m) => m.id === "u-0")).toMatchObject({
      id: "u-0",
      role: "user",
    });

    // A durable-history agent row that happens to share the live turn (untouched
    // — its id is neither in `answers` nor `remove`).
    deliver(w, { type: "agent_message", id: "durable-1", turnId: "T", text: "older durable" });

    // The live turn, as the pre-#212 client rendered it: lane A settled "tA"; a
    // status notice mid-turn; lane C mis-topped to "tB"; the overflow final "tC"
    // on its own independent bubble. ⚠️ The reasoning block is IN the transcript
    // since #242 half 2 — it used to ride a separate surface, and this case now
    // doubles as the proof that a `seal` steps over it (the reducer's
    // `applySeal` guards every id test with `kind === "text"`).
    liveBubble(w, "laneA", "T", "A", "tA");
    deliver(w, { type: "reasoning", id: "r1", turnId: "T", text: "thinking…" });
    deliver(w, { type: "agent_message", id: "notice1", turnId: "T", text: "Heads up: a notice." });
    liveBubble(w, "laneC", "T", "C", "tB");
    deliver(w, { type: "agent_message", id: "tcId", turnId: "T", text: "tC" });

    const messagesBefore = w.getState().messages;
    expect(messagesBefore.map((m) => m.id)).toEqual([
      "u-0",
      "durable-1",
      "laneA",
      "r1",
      "notice1",
      "laneC",
      "tcId",
    ]);
    // Capture the exact bubble objects to prove they are not even re-created.
    const userBefore = messagesBefore.find((m) => m.id === "u-0")!;
    const noticeBefore = messagesBefore.find((m) => m.id === "notice1")!;
    const durableBefore = messagesBefore.find((m) => m.id === "durable-1")!;
    const reasoningBefore = messagesBefore.find((m) => m.id === "r1")!;

    // The plugin's authoritative snapshot: streamed [A][B][C]; lane B never
    // materialized so it is MINTED; the overflow "tC" bubble is removed.
    deliver(w, {
      type: "turn_snapshot",
      turnId: "T",
      answers: [
        { id: "laneA", text: "A" },
        { id: "laneB", text: "B" },
        { id: "laneC", text: "C" },
      ],
      remove: ["tcId"],
    });

    const after = w.getState().messages;
    // Order: answers in authoritative order among themselves; every non-answer
    // bubble keeps its slot — the reasoning block INCLUDED; the overflow bubble
    // is gone.
    expect(after.map((m) => m.id)).toEqual([
      "u-0",
      "durable-1",
      "laneA",
      "laneB",
      "r1",
      "notice1",
      "laneC",
    ]);
    // Answer texts are the authoritative streamed content.
    expect(after.find((m) => m.id === "laneA")!.text).toBe("A");
    expect(after.find((m) => m.id === "laneB")!.text).toBe("B");
    expect(after.find((m) => m.id === "laneC")!.text).toBe("C");
    // The failed lane B was minted exactly once.
    expect(after.filter((m) => m.text === "B")).toHaveLength(1);
    expect(after.find((m) => m.id === "laneB")).toMatchObject({
      role: "agent",
      working: false,
      turnId: "T",
    });
    // The overflow bubble is dropped.
    expect(after.some((m) => m.id === "tcId")).toBe(false);

    // Preserved halves — the SAME bubble objects, not re-created:
    //  - the user bubble (receipts/send-state),
    expect(after.find((m) => m.id === "u-0")).toBe(userBefore);
    //  - the mid-turn notice bubble (text and its relative slot),
    expect(after.find((m) => m.id === "notice1")).toBe(noticeBefore);
    //  - the durable-history agent row that shares the turn,
    expect(after.find((m) => m.id === "durable-1")).toBe(durableBefore);
    //  - and the reasoning block, BY REFERENCE, with no `role` invented for it.
    //    A `seal` reconciles the turn's ANSWER bubbles and must say nothing
    //    about a reasoning block that shares the turn (#242 half 2).
    expect(after.find((m) => m.id === "r1")).toBe(reasoningBefore);
    expect(after.find((m) => m.id === "r1")).toEqual({
      kind: "reasoning",
      id: "r1",
      turnId: "T",
      text: "thinking…",
    });
    //  - `state.reasoning` is the DERIVED view of exactly that entry.
    expect(w.getState().reasoning).toEqual([
      { id: "r1", turnId: "T", text: "thinking…" },
    ]);
  });

  it("S1b: a HISTORY-hydrated bubble (no turnId) is preserved by reference too", () => {
    // The `.toBe` cases in S1 all carry a `turnId`, so they cannot see the
    // key-SHAPE half of the guarantee. A history fresh-insert emits
    // `{id, role, text, ts, working}` with NO `turnId` key at all, and
    // `mergeDurable` writing `turnId: entry.turnId ?? base?.turnId` into the
    // literal would give it an own `turnId: undefined` — a different key set,
    // failing the identity check and silently re-creating the bubble on the very
    // first durable frame of the next turn. Every hydrated row in the transcript
    // would churn on every frame.
    const w = makeWrapper();
    deliver(w, {
      type: "history",
      messages: [
        { id: "core-u1", role: "user", text: "hello", ts: 1 },
        { id: "core-a1", role: "agent", text: "an older answer", ts: 2 },
      ],
    });
    const hydrated = w.getState().messages;
    expect(hydrated.map((m) => m.id)).toEqual(["core-u1", "core-a1"]);
    // Non-vacuity: the premise is that these carry no `turnId` KEY.
    for (const m of hydrated) expect(Object.hasOwn(m, "turnId")).toBe(false);

    // A durable frame for a NEW turn re-projects and merges every bubble.
    deliver(w, { type: "agent_message", id: "laneA", turnId: "T2", text: "new answer" });

    const after = w.getState().messages;
    expect(after.map((m) => m.id)).toEqual(["core-u1", "core-a1", "laneA"]);
    expect(after[0]).toBe(hydrated[0]);
    expect(after[1]).toBe(hydrated[1]);
    // …and the key set is still what history produced — no `turnId` was added.
    for (const m of after.slice(0, 2)) expect(Object.hasOwn(m, "turnId")).toBe(false);
  });

  it("S1c: prototype-shaped snapshot ids remain ordinary overlay keys", () => {
    const w = makeWrapper();
    deliver(w, {
      type: "history",
      messages: [{ id: "working", role: "agent", text: "hydrated answer", ts: 1 }],
    });
    deliver(w, { type: "typing" });
    expect(w.getState().isTyping).toBe(true);

    expect(() => deliver(w, {
      type: "turn_snapshot",
      turnId: "T",
      answers: [{ id: "__proto__", text: "sealed answer" }],
      remove: [],
    })).not.toThrow();

    const state = w.getState();
    expect(state.isTyping).toBe(false);
    expect(state.messages.map((message) => message.id)).toEqual(["working", "__proto__"]);
    expect(state.messages[0]).toMatchObject({
      id: "working",
      role: "agent",
      text: "hydrated answer",
      working: false,
    });
    expect(state.messages[1]).toMatchObject({
      id: "__proto__",
      role: "agent",
      text: "sealed answer",
      turnId: "T",
      working: false,
    });
  });

  it("S2: a snapshot for a foreign/absent turn with no matching ids is a no-op on the answer region", () => {
    const w = makeWrapper();
    liveBubble(w, "laneA", "T", "A", "final A");
    const before = w.getState().messages.slice();
    // An empty-answers, empty-remove snapshot changes nothing.
    deliver(w, { type: "turn_snapshot", turnId: "T", answers: [], remove: [] });
    expect(w.getState().messages).toEqual(before);
    // A remove naming an id we do not hold changes nothing.
    deliver(w, { type: "turn_snapshot", turnId: "T", answers: [], remove: ["ghost"] });
    expect(w.getState().messages).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// #15 approval rehydration — the wrapper reconciles its approval state against
// the authoritative `approval_snapshot` frame (Legs A/B/C).
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — approval_snapshot reconciliation (#15)", () => {
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      registration,
    });
  }
  function deliver(wrapper: WebChannelNATSClient, frame: InboundMessage): void {
    (wrapper as unknown as { handleMessage: (m: InboundMessage) => void }).handleMessage(frame);
  }
  function pendingPayload(id: string) {
    return {
      id,
      kind: "exec" as const,
      title: "Run",
      prompt: `cmd-${id}`,
      options: [{ decision: "allow-once", label: "Allow", style: "success" }],
      expiresAtMs: 999_999_999_999,
    };
  }
  function requestFrame(id: string): InboundMessage {
    return { type: "approval_request", ...pendingPayload(id) };
  }
  function snapshotFrame(
    ids: string[],
    resolved?: Array<{ id: string; decision: string }>,
  ): InboundMessage {
    return {
      type: "approval_snapshot",
      approvals: ids.map(pendingPayload),
      ...(resolved ? { resolved } : {}),
    };
  }
  /** Spy on the underlying client's decision sender (for Leg C re-send assertions). */
  function spyDecision(wrapper: WebChannelNATSClient) {
    const client = (wrapper as unknown as {
      client: { sendApprovalDecision: (id: string, d: string) => void };
    }).client;
    return vi.spyOn(client, "sendApprovalDecision");
  }

  it("Leg A: a snapshot hydrates pending cards from a fresh (reloaded) state and clears the typing indicator", () => {
    const w = makeWrapper();
    // Simulate a live typing indicator still showing when the snapshot lands.
    deliver(w, { type: "typing" });
    expect(w.getState().isTyping).toBe(true);

    deliver(w, snapshotFrame(["a1", "a2"]));
    const approvals = w.getState().approvals;
    expect(approvals.map((a) => a.id)).toEqual(["a1", "a2"]);
    // Rehydrated cards are actionable (no resolution).
    expect(approvals.every((a) => a.resolvedDecision === undefined)).toBe(true);
    // Parity with the live approval_request path: a fresh actionable card clears
    // the typing indicator (the agent is blocked on the user, not working).
    expect(w.getState().isTyping).toBe(false);
  });

  it("Leg B: a card absent from the snapshot is marked resolved 'unknown' + confirmed; empty snapshot clears all actionable cards", () => {
    const w = makeWrapper();
    deliver(w, requestFrame("a1"));
    deliver(w, requestFrame("a2"));
    // Snapshot lists only a2 → a1 was decided/expired elsewhere.
    deliver(w, snapshotFrame(["a2"]));
    const byId = Object.fromEntries(w.getState().approvals.map((a) => [a.id, a]));
    expect(byId["a1"].resolvedDecision).toBe("unknown");
    expect(byId["a1"].resolutionConfirmed).toBe(true);
    expect(byId["a2"].resolvedDecision).toBeUndefined(); // still actionable

    // An EMPTY snapshot retires every remaining actionable card.
    deliver(w, snapshotFrame([]));
    expect(w.getState().approvals.find((a) => a.id === "a2")?.resolvedDecision).toBe("unknown");
  });

  it("#19 Leg B: a card absent from pending but present in `resolved` shows the ACTUAL decision", () => {
    const w = makeWrapper();
    deliver(w, requestFrame("a1"));
    // Snapshot: a1 no longer pending, but its resolved outcome is carried.
    deliver(w, snapshotFrame([], [{ id: "a1", decision: "allow-once" }]));
    const a = w.getState().approvals[0];
    expect(a.resolvedDecision).toBe("allow-once"); // real verdict, not "unknown"
    expect(a.resolutionConfirmed).toBe(true);
  });

  it("#19 Leg B: a card absent from BOTH pending and resolved still falls back to 'unknown'", () => {
    const w = makeWrapper();
    deliver(w, requestFrame("a1"));
    // resolved carries an UNRELATED id → a1 aged out of the server's ring.
    deliver(w, snapshotFrame([], [{ id: "other", decision: "deny" }]));
    const a = w.getState().approvals[0];
    expect(a.resolvedDecision).toBe("unknown");
    expect(a.resolutionConfirmed).toBe(true);
  });

  it("#19 optimistic-vs-server conflict: the SERVER decision wins and is confirmed", () => {
    const w = makeWrapper();
    deliver(w, requestFrame("a1"));
    w.decide("a1", "allow-once"); // optimistic, unconfirmed
    // Server resolved it as DENY (e.g. another approver) — absent from pending,
    // present in resolved with a DIFFERENT decision → server overrides.
    deliver(w, snapshotFrame([], [{ id: "a1", decision: "deny" }]));
    const a = w.getState().approvals[0];
    expect(a.resolvedDecision).toBe("deny");
    expect(a.resolutionConfirmed).toBe(true);
  });

  it("#19 optimistic matches server: just confirm, no decision change", () => {
    const w = makeWrapper();
    deliver(w, requestFrame("a1"));
    w.decide("a1", "allow-once");
    deliver(w, snapshotFrame([], [{ id: "a1", decision: "allow-once" }]));
    const a = w.getState().approvals[0];
    expect(a.resolvedDecision).toBe("allow-once");
    expect(a.resolutionConfirmed).toBe(true);
  });

  it("#19 a `resolved`-list id with NO local card is NOT rehydrated as a card", () => {
    const w = makeWrapper();
    // Fresh state, snapshot lists only a resolved outcome for an id we never held.
    deliver(w, snapshotFrame([], [{ id: "ghost", decision: "deny" }]));
    expect(w.getState().approvals).toEqual([]);
  });

  it("#19 defensive: an id in BOTH pending and resolved lists ends RESOLVED (terminal wins), never actionable", () => {
    // Impossible server-side (finalize is a synchronous delete-then-record), but
    // the reconciler must fail safe: the resolved outcome wins over the pending
    // listing, for both an existing card and a no-local-card id.
    const w = makeWrapper();
    deliver(w, requestFrame("a1")); // existing unresolved card
    // a1 in BOTH the pending set AND the resolved set.
    deliver(w, snapshotFrame(["a1", "a2"], [{ id: "a1", decision: "deny" }]));
    const byId = Object.fromEntries(w.getState().approvals.map((a) => [a.id, a]));
    // a1: terminal outcome wins — resolved "deny", confirmed, NOT actionable.
    expect(byId["a1"].resolvedDecision).toBe("deny");
    expect(byId["a1"].resolutionConfirmed).toBe(true);
    // a2: pending-only → rehydrated as an actionable card as usual.
    expect(byId["a2"].resolvedDecision).toBeUndefined();

    // No-local-card id in BOTH lists → NOT rehydrated as an actionable card.
    const w2 = makeWrapper();
    deliver(w2, snapshotFrame(["b1"], [{ id: "b1", decision: "allow-once" }]));
    expect(w2.getState().approvals).toEqual([]);
  });

  it("upsert-preserve: a re-delivered approval_request keeps a locally-set resolution (no button resurrection)", () => {
    const w = makeWrapper();
    deliver(w, requestFrame("a1"));
    w.decide("a1", "allow-once"); // optimistic, unconfirmed
    expect(w.getState().approvals[0].resolvedDecision).toBe("allow-once");

    // Stateless register re-delivers the SAME approval_request — must NOT clobber
    // the resolution back to actionable.
    deliver(w, requestFrame("a1"));
    const a = w.getState().approvals[0];
    expect(a.resolvedDecision).toBe("allow-once");
    expect(a.resolutionConfirmed).toBeFalsy();
  });

  it("a later approval_resolved overwrites an 'unknown' card with the real decision and confirms it", () => {
    const w = makeWrapper();
    deliver(w, requestFrame("a1"));
    deliver(w, snapshotFrame([])); // a1 → unknown + confirmed
    expect(w.getState().approvals[0].resolvedDecision).toBe("unknown");
    // The authoritative resolution frame still arrives (order not guaranteed).
    deliver(w, { type: "approval_resolved", id: "a1", decision: "deny" });
    const a = w.getState().approvals[0];
    expect(a.resolvedDecision).toBe("deny");
    expect(a.resolutionConfirmed).toBe(true);
  });

  it("Leg C: a locally-decided-but-unconfirmed card the snapshot still lists as pending re-sends the decision and stays resolved; absent → confirmed, nothing re-sent", () => {
    const w = makeWrapper();
    const spy = spyDecision(w);
    deliver(w, requestFrame("a1"));
    w.decide("a1", "allow-once"); // optimistic decision → one send
    spy.mockClear();

    // The lost decision: the snapshot STILL lists a1 as pending → re-send it.
    deliver(w, snapshotFrame(["a1"]));
    expect(spy).toHaveBeenCalledWith("a1", "allow-once");
    const a = w.getState().approvals[0];
    expect(a.resolvedDecision).toBe("allow-once"); // card stays resolved
    expect(a.resolutionConfirmed).toBeFalsy(); // still unconfirmed → retries next register

    // Now the server has it resolved: a1 is ABSENT → confirm, do NOT re-send.
    spy.mockClear();
    deliver(w, snapshotFrame([]));
    expect(spy).not.toHaveBeenCalled();
    const after = w.getState().approvals[0];
    expect(after.resolvedDecision).toBe("allow-once");
    expect(after.resolutionConfirmed).toBe(true);
  });

  it("a server-confirmed resolution present in the snapshot does NOT re-send a decision (guards the Leg C gate)", () => {
    const w = makeWrapper();
    const spy = spyDecision(w);
    deliver(w, requestFrame("a1"));
    // Server-confirmed resolution (an authoritative approval_resolved), NOT an
    // optimistic decide — so resolutionConfirmed is true.
    deliver(w, { type: "approval_resolved", id: "a1", decision: "deny" });
    expect(w.getState().approvals[0].resolutionConfirmed).toBe(true);
    spy.mockClear();
    const before = w.getState();

    // The snapshot still lists a1 as pending (stale-by-ms). The confirmed
    // resolution must WIN: no decision re-send, no state churn.
    deliver(w, snapshotFrame(["a1"]));
    expect(spy).not.toHaveBeenCalled();
    expect(w.getState()).toBe(before); // no setState fired
    expect(w.getState().approvals[0].resolvedDecision).toBe("deny");
  });

  it("a duplicate snapshot is a state no-op (register retry after a lost reply)", () => {
    const w = makeWrapper();
    deliver(w, snapshotFrame(["a1"]));
    const s1 = w.getState();
    deliver(w, snapshotFrame(["a1"]));
    const s2 = w.getState();
    // No setState fired → the very same state object reference.
    expect(s2).toBe(s1);
    expect(s2.approvals).toHaveLength(1);
  });

  it("ignores an unrecognized frame type without throwing (forward-compat lock-in)", () => {
    const w = makeWrapper();
    expect(() =>
      deliver(w, { type: "some_future_frame", foo: "bar" } as unknown as InboundMessage),
    ).not.toThrow();
    // State is untouched.
    expect(w.getState().approvals).toEqual([]);
    expect(w.getState().messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P0-3 slash-command discovery — the wrapper stores the catalog from a
// `commands` frame and forwards loadCommands() to the underlying client.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-3 command discovery", () => {
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      registration,
    });
  }
  function deliver(wrapper: WebChannelNATSClient, frame: InboundMessage): void {
    (wrapper as unknown as { handleMessage: (m: InboundMessage) => void }).handleMessage(frame);
  }

  it("a `commands` frame sets state.commands", () => {
    const w = makeWrapper();
    expect(w.getState().commands).toBeUndefined();
    const commands = [
      { name: "help", description: "Show available commands." },
      { name: "model", description: "Show or set the model.", args: [{ name: "model" }] },
    ];
    deliver(w, { type: "commands", commands } as unknown as InboundMessage);
    expect(w.getState().commands).toEqual(commands);
  });

  it("a later `commands` frame REPLACES the catalog wholesale (idempotent refresh)", () => {
    const w = makeWrapper();
    deliver(w, { type: "commands", commands: [{ name: "help", description: "h" }] } as unknown as InboundMessage);
    deliver(w, { type: "commands", commands: [{ name: "new", description: "n" }] } as unknown as InboundMessage);
    expect(w.getState().commands?.map((c) => c.name)).toEqual(["new"]);
  });

  it("a `commands` frame does NOT touch isTyping (not turn activity)", () => {
    const w = makeWrapper();
    deliver(w, { type: "typing" });
    expect(w.getState().isTyping).toBe(true);
    deliver(w, { type: "commands", commands: [] } as unknown as InboundMessage);
    expect(w.getState().isTyping).toBe(true); // unchanged
  });

  it("loadCommands() delegates to the underlying client", () => {
    const w = makeWrapper();
    const inner = (w as unknown as { client: { loadCommands: () => void } }).client;
    const spy = vi.spyOn(inner, "loadCommands");
    w.loadCommands();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// P0-4 send-state acks (T-wd) — send() stamps the local echo with the wire id,
// and an `ack` frame advances the matching bubble to `sendState:"accepted"`
// (replaces the removed boolean `delivered`). Acceptance is now driven by the
// low-level tracker's `onSendState`, so the ack is delivered through the inner
// client's real inbound path (`deliverInbound`), not the reducer alone.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-4 send-state acks", () => {
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      registration,
    });
  }
  /** Deliver an ack the way the socket would: through the inner client's inbound
   * path, which drains the ledger AND advances the tracker (→ onSendState). */
  function ack(wrapper: WebChannelNATSClient, ids: string[]): void {
    (wrapper as unknown as { client: { deliverInbound: (m: InboundMessage) => void } })
      .client.deliverInbound({ type: "ack", ids });
  }

  it("send() stores the wire id and starts the bubble at sendState 'queued'", () => {
    const w = makeWrapper();
    w.send("hello");
    const m = w.getState().messages[0];
    expect(typeof m.wireId).toBe("string");
    expect(m.wireId).toBeTruthy();
    expect(m.sendState).toBe("queued"); // not yet accepted (never connected)
  });

  it("an ack advances the matching bubble to sendState 'accepted' and leaves others untouched", () => {
    const w = makeWrapper();
    w.send("first");
    w.send("second");
    const [m1, m2] = w.getState().messages;

    ack(w, [m1.wireId!]);
    const after = w.getState().messages;
    expect(after.find((m) => m.id === m1.id)?.sendState).toBe("accepted");
    expect(after.find((m) => m.id === m2.id)?.sendState).toBe("queued"); // unrelated
  });

  it("an ack with no matching wireId is a state no-op", () => {
    const w = makeWrapper();
    w.send("only");
    const before = w.getState();
    ack(w, ["not-a-wire-id"]);
    expect(w.getState()).toBe(before); // no setState fired
  });

  it("an empty ack is a no-op", () => {
    const w = makeWrapper();
    w.send("only");
    const before = w.getState();
    ack(w, []);
    expect(w.getState()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Protocol-version handshake: the register outcome surfaces on WebChannelState
// so a diagnostics/admin view can read the agent-plugin's versions.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — protocol version on state", () => {
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      registration,
    });
  }

  /** Fire the inner client's protocol listeners (what a real register triggers). */
  function emitProtocol(
    wrapper: WebChannelNATSClient,
    info: { protocolVersion: number | null; pluginVersion: string | null },
  ): void {
    (wrapper["client"] as unknown as {
      notifyProtocolListeners: (i: typeof info) => void;
    }).notifyProtocolListeners(info);
  }

  it("initial state exposes null protocol + plugin versions (not yet registered)", () => {
    const state = makeWrapper().getState();
    expect(state.agentProtocolVersion).toBeNull();
    expect(state.agentPluginVersion).toBeNull();
  });

  it("a matched register exposes both versions on state", () => {
    const wrapper = makeWrapper();
    emitProtocol(wrapper, { protocolVersion: WEBCHANNEL_PROTOCOL_VERSION, pluginVersion: "0.1.8" });
    const state = wrapper.getState();
    expect(state.agentProtocolVersion).toBe(WEBCHANNEL_PROTOCOL_VERSION);
    expect(state.agentPluginVersion).toBe("0.1.8");
  });

  it("a test-only null protocol diagnostic keeps the pre-connection state null", () => {
    const wrapper = makeWrapper();
    emitProtocol(wrapper, { protocolVersion: null, pluginVersion: null });
    const state = wrapper.getState();
    expect(state.agentProtocolVersion).toBeNull();
    expect(state.agentPluginVersion).toBeNull();
    expect(state.status).not.toBe("error");
  });
});

describe("WebChannelNATSClient — reasoning lane", () => {
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "jwt",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      registration,
    });
  }

  function deliver(wrapper: WebChannelNATSClient, frame: InboundMessage): void {
    (wrapper as unknown as { handleMessage: (m: InboundMessage) => void }).handleMessage(frame);
  }

  it("is correlated, replaceable, and UNBOUNDED — the .slice(-100) cap is gone", () => {
    // ⚠️ THIS CASE ASSERTED THE OPPOSITE UNTIL #242 half 2. It read
    // `toHaveLength(100)` / `reasoning[0].id === "r5"`, pinning `upsertReasoning`'s
    // `.slice(-100)`. That cap is deleted: the durable view is uncapped, so a
    // live cap was itself a live≠history divergence (past 100 blocks the live
    // list had dropped the oldest and a replay still had them). Retention is
    // #299's, at the store, as one policy over everything.
    const wrapper = makeWrapper();
    for (let i = 0; i < 105; i++) {
      deliver(wrapper, { type: "reasoning", id: `r${i}`, turnId: `t${i}`, text: `text${i}` });
    }
    expect(wrapper.getState().reasoning).toHaveLength(105);
    expect(wrapper.getState().reasoning[0].id).toBe("r0");
    // Upsert by id, not append.
    deliver(wrapper, { type: "reasoning", id: "r104", turnId: "t104", text: "updated" });
    expect(wrapper.getState().reasoning).toHaveLength(105);
    expect(wrapper.getState().reasoning.at(-1)?.text).toBe("updated");
  });

  it("puts each burst IN the transcript, and derives state.reasoning from it", () => {
    // The other half of the same change: `state.messages` used to stay `[]`
    // through every reasoning frame, because the client kept a side array.
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "reasoning", id: "r1", turnId: "t1", text: "half" });
    deliver(wrapper, { type: "reasoning", id: "r1", turnId: "t1", text: "half done" });

    // ⚠️ `toEqual` on the whole entry, so an invented `role` (or any other
    // bubble field) fails: the entry has exactly four own keys.
    expect(wrapper.getState().messages).toEqual([
      { kind: "reasoning", id: "r1", turnId: "t1", text: "half done" },
    ]);
    // DERIVED, not maintained — same content, `ReasoningItem` shape.
    expect(wrapper.getState().reasoning).toEqual([
      { id: "r1", turnId: "t1", text: "half done" },
    ]);
  });

  it("state.reasoning keeps its ARRAY IDENTITY across a frame that is not a transcript change", () => {
    // The derivation is conditional on `messages` being in the patch. Without
    // that, every `typing` frame would hand listeners a fresh `reasoning` array
    // and defeat the identity-based change detection `WebChannelState` promises.
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "reasoning", id: "r1", turnId: "t1", text: "thought" });
    const before = wrapper.getState().reasoning;
    deliver(wrapper, { type: "typing" });
    expect(wrapper.getState().reasoning).toBe(before);
  });

  it("but it DOES churn on every frame that touches the transcript — measured, not implied", () => {
    // ⚠️ THE HONEST OTHER HALF, pinned because `nextStateFrom`'s docblock used
    // to state only the `typing` case and that reads as a stronger guarantee
    // than it is. A `progress` frame patches `messages`, so `reasoning` is
    // rebuilt — identical contents, new array — and `progress` is far more
    // frequent during a turn than `typing` is. Consistent with the rest of the
    // object (`WebChannelState` promises a new object per change, "the arrays
    // too"), but a subscriber must not read this array's identity as "the
    // reasoning changed".
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "reasoning", id: "r1", turnId: "t1", text: "thought" });
    const before = wrapper.getState().reasoning;
    deliver(wrapper, { type: "progress", id: "A", turnId: "t1", text: "Working…" });
    const after = wrapper.getState().reasoning;
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
    // Two consecutive `progress` frames churn it again, with nothing to show.
    deliver(wrapper, { type: "progress", id: "A", turnId: "t1", text: "Working… more" });
    expect(wrapper.getState().reasoning).not.toBe(after);
    expect(wrapper.getState().reasoning).toEqual(before);
  });

  it("a reasoning block sits between the answers it was delivered between", () => {
    // Position comes from the stream, not from `turnId` grouping — the property
    // the demo's deleted interleave used to supply and now must not.
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "agent_message", id: "A", turnId: "t1", text: "first" });
    deliver(wrapper, { type: "reasoning", id: "r1", turnId: "t1", text: "hmm" });
    deliver(wrapper, { type: "agent_message", id: "B", turnId: "t1", text: "second" });
    expect(wrapper.getState().messages.map((m) => m.id)).toEqual(["A", "r1", "B"]);
  });

  it("does not clear typing on reasoning but turn_settled does", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "typing" });
    deliver(wrapper, { type: "reasoning", id: "r", turnId: "t", text: "thought" });
    expect(wrapper.getState().isTyping).toBe(true);
    deliver(wrapper, { type: "turn_settled", turnId: "t" });
    expect(wrapper.getState().isTyping).toBe(false);
  });
});

describe("WebChannelNATSClient — #97 tool activity lane", () => {
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "jwt",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      registration,
    });
  }

  function deliver(wrapper: WebChannelNATSClient, frame: InboundMessage): void {
    (wrapper as unknown as { handleMessage: (m: InboundMessage) => void }).handleMessage(frame);
  }

  function toolActivityOf(wrapper: WebChannelNATSClient) {
    return wrapper.getState().toolActivity ?? [];
  }

  it("upserts a tool_activity frame into state.toolActivity with structured fields", () => {
    const wrapper = makeWrapper();
    expect(wrapper.getState()).toMatchObject({ toolActivity: [] });
    deliver(wrapper, {
      type: "tool_activity",
      id: "tc1",
      turnId: "t1",
      name: "get_weather",
      phase: "start",
      argKeys: ["city", "days"],
    });
    const list = toolActivityOf(wrapper);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "tc1",
      turnId: "t1",
      name: "get_weather",
      phase: "start",
      argKeys: ["city", "days"],
    });
  });

  it("merges a sparse same-call frame without discarding start fields", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, {
      type: "tool_activity",
      id: "tc1",
      turnId: "t1",
      name: "bash",
      phase: "start",
      argKeys: ["command", "cwd"],
    });
    deliver(wrapper, {
      type: "tool_activity",
      id: "tc1",
      turnId: "t1",
      status: "completed",
      summary: "done",
    });
    let list = toolActivityOf(wrapper);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "tc1",
      turnId: "t1",
      name: "bash",
      phase: "start",
      argKeys: ["command", "cwd"],
      status: "completed",
      summary: "done",
    });

    deliver(wrapper, {
      type: "tool_activity",
      id: "patch1",
      turnId: "t1",
      name: "apply_patch",
      phase: "end",
      status: "failed",
    });
    deliver(wrapper, {
      type: "tool_activity",
      id: "patch1",
      turnId: "t1",
      phase: "end",
      summary: "Updated 1 file",
    });
    expect(toolActivityOf(wrapper).find((item) => item.id === "patch1")).toMatchObject({
      name: "apply_patch",
      status: "failed",
      summary: "Updated 1 file",
    });

    deliver(wrapper, { type: "tool_activity", id: "tc2", turnId: "t1", name: "grep" });
    list = toolActivityOf(wrapper);
    expect(list).toHaveLength(3);
    expect(list.map((a) => a.id)).toEqual(["tc1", "patch1", "tc2"]);
  });

  it("keeps the same id in different turns as distinct calls", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, {
      type: "tool_activity",
      id: "tool-activity-1",
      turnId: "turn-one",
      name: "bash",
      phase: "start",
      argKeys: ["command"],
    });
    deliver(wrapper, {
      type: "tool_activity",
      id: "tool-activity-1",
      turnId: "turn-two",
      name: "bash",
      phase: "start",
      argKeys: ["command"],
    });
    deliver(wrapper, {
      type: "tool_activity",
      id: "tool-activity-1",
      turnId: "turn-two",
      status: "completed",
    });

    const list = toolActivityOf(wrapper);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      id: "tool-activity-1",
      turnId: "turn-one",
      phase: "start",
    });
    expect(list[0]!.status).toBeUndefined();
    expect(list[1]).toMatchObject({
      id: "tool-activity-1",
      turnId: "turn-two",
      name: "bash",
      argKeys: ["command"],
      status: "completed",
    });
  });

  it("drops a frame missing id or turnId", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "tool_activity", turnId: "t1", name: "x" } as InboundMessage);
    deliver(wrapper, { type: "tool_activity", id: "tc1", name: "x" } as InboundMessage);
    deliver(wrapper, { type: "tool_activity", id: "", turnId: "t1", name: "x" });
    deliver(wrapper, { type: "tool_activity", id: "tc1", turnId: "", name: "x" });
    expect(toolActivityOf(wrapper)).toHaveLength(0);
  });

  it("bounds the list to the last 100 entries", () => {
    const wrapper = makeWrapper();
    for (let i = 0; i < 105; i++) {
      deliver(wrapper, { type: "tool_activity", id: `tc${i}`, turnId: `t${i}`, name: "n" });
    }
    const list = toolActivityOf(wrapper);
    expect(list).toHaveLength(100);
    expect(list[0].id).toBe("tc5");
    expect(list.at(-1)?.id).toBe("tc104");
  });

  it("does NOT clear toolActivity on turn_settled (ephemeral, live-not-durable)", () => {
    const wrapper = makeWrapper();
    deliver(wrapper, { type: "tool_activity", id: "tc1", turnId: "t1", name: "bash" });
    deliver(wrapper, { type: "turn_settled", turnId: "t1" });
    expect(toolActivityOf(wrapper)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P1-9 wire-order harness — register-delivered conversation key over a fake NATS
// socket. P0-2 removed the legacy `.handshake` negotiation, so the two
// session-gate / wire-order tests establish the session key exactly as
// production does: a PoP register round-trip whose reply carries K wrapped to the
// device X25519 key. The wrap is produced the AGENT's way (node:crypto, mirroring
// packages/plugin/src/late-join-decryptor.ts and nats-client-wrapped-key.test.ts)
// so the browser unwrap is exercised for real, not stubbed.
// ---------------------------------------------------------------------------

async function makeDeviceX25519(): Promise<{ privateKey: CryptoKey; publicKeyBytes: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicKeyBytes: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

/** DER SPKI from a raw 32-byte X25519 public key (RFC 8410 prefix). */
function x25519RawToSpki(raw: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(raw)]);
}

/** A node:crypto X25519 identity key pair standing in for the SaaS-attested agent key. */
function makeAgentIdentity(): { privatePem: string; publicRaw: Uint8Array; publicB64url: string } {
  const kp = generateKeyPairSync("x25519");
  const publicRaw = new Uint8Array(
    (kp.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32),
  );
  return {
    privatePem: kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicRaw,
    publicB64url: Buffer.from(publicRaw).toString("base64url"),
  };
}

/**
 * The v3 wrap AAD, re-implemented by hand (no import from the module under test)
 * so this file stays an independent agent mirror:
 *   UTF-8("webchannel-wrap-v2") ‹0x1F› UTF-8(peerId) ‹0x1F› UTF-8(clientNonce)
 */
function wrapAadLikeAgent(peerId: string, clientNonce: string): Buffer {
  const US = Buffer.from([0x1f]);
  return Buffer.concat([
    Buffer.from("webchannel-wrap-v2", "utf8"), US,
    Buffer.from(peerId, "utf8"), US,
    Buffer.from(clientNonce, "utf8"),
  ]);
}

/**
 * Wrap K the AGENT's way (F2 static-static): ECDH(agentIdentity.private,
 * device.public) → HKDF "webchannel-key-wrap-v1" → chacha20-poly1305 sealing K
 * with AAD = wrapAadLikeAgent(peerId, clientNonce). Mirrors
 * packages/plugin/src/late-join-decryptor.ts, independent of the browser unwrap
 * under test.
 */
function wrapLikeAgent(
  conversationKey: Uint8Array,
  devicePublicKeyRaw: Uint8Array,
  agentIdentity: { privatePem: string; publicRaw: Uint8Array },
  peerId: string,
  clientNonce: string,
): WrappedConversationKey {
  const devicePub = createPublicKey({
    key: x25519RawToSpki(devicePublicKeyRaw),
    type: "spki",
    format: "der",
  });
  const shared = diffieHellman({
    privateKey: createPrivateKey(agentIdentity.privatePem),
    publicKey: devicePub,
  });
  const wrapKey = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(32), "webchannel-key-wrap-v1", 32),
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", wrapKey, nonce, { authTagLength: 16 });
  cipher.setAAD(wrapAadLikeAgent(peerId, clientNonce), {
    plaintextLength: conversationKey.length,
  });
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(conversationKey)), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
  return {
    ephemeralPublicKey: b64(agentIdentity.publicRaw),
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
    tag: b64(tag),
  };
}

type RegHandler = (
  subject: string,
  payload: string,
  server: FakeRegisterWS,
  replyTo?: string,
) => void | Promise<void>;

/**
 * A fake NATS socket that answers the PoP register round-trip (challenge →
 * register) over request/reply, and records every raw frame the client wrote in
 * `sent` for wire-order assertions. Mirrors the `FakeNatsWS` in
 * nats-client-wrapped-key.test.ts (PONG on PING flips the client to connected).
 */
class FakeRegisterWS {
  static instances: FakeRegisterWS[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  url: string;
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  /** P1-9: every raw frame the client wrote, for wire-order assertions. */
  sent: string[] = [];
  private readonly subs = new Map<string, number>();
  handler: RegHandler = () => {};
  constructor(url: string) {
    this.url = url;
    FakeRegisterWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeRegisterWS.OPEN;
      this.onopen?.();
    });
  }
  send(data: string): void {
    this.sent.push(data);
    if (data.startsWith("CONNECT") || data.startsWith("PONG")) return;
    if (data.startsWith("PING")) {
      this.serverEmit("PONG\r\n");
      return;
    }
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
      const header = data.slice(0, idx).split(" "); // PUB <subject> [reply-to] <len>
      const subject = header[1];
      const replyTo = header.length === 4 ? header[2] : undefined;
      const payload = data.slice(idx + 2).replace(/\r\n$/, "");
      void this.handler(subject, payload, this, replyTo);
      return;
    }
  }
  deliverToClient(subject: string, payload: string): void {
    const sid = this.subs.get(subject);
    if (sid === undefined) return;
    const len = new TextEncoder().encode(payload).length;
    this.serverEmit(`MSG ${subject} ${sid} ${len}\r\n${payload}\r\n`);
  }
  close(): void {
    this.readyState = FakeRegisterWS.CLOSED;
    this.onclose?.();
  }
  serverEmit(frame: string): void {
    this.onmessage?.({ data: frame });
  }
}

/**
 * Register-agent handler over the reply-to inbox: challenge → nonce, register →
 * `{peerId, registered, wrappedConversationKey}`. `gate`, when supplied, holds
 * the register REPLY (the wrapped key) so a test can observe the
 * connected-but-keyless window before the key lands.
 */
function makeRegisterHandler(
  tenant: string,
  accountId: string,
  peerId: string,
  wrapped: (clientNonce: string) => WrappedConversationKey,
  gate?: Promise<void>,
): RegHandler {
  const reg = registerSubject(tenant, accountId, peerId);
  return async (subject, payload, server, replyTo) => {
    if (subject !== reg || !replyTo) return;
    const body = JSON.parse(payload) as { op?: string; clientNonce?: unknown };
    if (body.op === "challenge") {
      server.deliverToClient(replyTo, JSON.stringify({ nonce: "nonce-abc" }));
      return;
    }
    if (body.op === "register") {
      if (gate) await gate;
      // v3: wrap against the anchor THIS register carried (never echoed back).
      server.deliverToClient(
        replyTo,
        JSON.stringify({
          peerId,
          registered: true,
          wrappedConversationKey: wrapped(
            typeof body.clientNonce === "string" ? body.clientNonce : "",
          ),
          protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
        }),
      );
    }
  };
}

// ---------------------------------------------------------------------------
// P1-9 — pending-message retraction ("unsend"). A send while a turn is in flight
// is HELD client-side as a pending bubble and published only when the turn
// settles; the abort vocabulary bypasses the hold; explicit /stop retracts held
// messages; a post-reconnect staleness valve prevents a wedged send lockout.
// (docs/P1_9_UNSEND_PLAN.md; §8 test plan.)
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P1-9 pending-message retraction (unsend)", () => {
  type Frame = Record<string, unknown> & { type: string };
  type Wrapper = WebChannelNATSClient;

  const IN = inboundSubject("t", "a", "p");
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  // Reducer-level tests never open a socket, so a truthy-keyed registration is
  // all the constructor needs (P0-2 makes registration mandatory). The two
  // wire-order tests below pass a REAL one built by `realRegistration()`.
  const fakeRegistration = {
    devicePrivateKey: {} as CryptoKey,
    deviceX25519PrivateKey: {} as CryptoKey,
  };

  /** A real device PoP + X25519 key set, a pinned agent identity, and a K to wrap. */
  async function realRegistration(): Promise<{
    registration: NonNullable<NatsClientOptions["registration"]>;
    deviceKP: Awaited<ReturnType<typeof makeDeviceX25519>>;
    agentId: ReturnType<typeof makeAgentIdentity>;
    K: Uint8Array;
  }> {
    const pop = await generateDevicePopKeyPair();
    const deviceKP = await makeDeviceX25519();
    const agentId = makeAgentIdentity();
    return {
      registration: {
        devicePrivateKey: pop.privateKey,
        deviceX25519PrivateKey: deviceKP.privateKey,
        pinnedAgentPublicKey: agentId.publicB64url,
      },
      deviceKP,
      agentId,
      K: new Uint8Array(randomBytes(32)),
    };
  }

  function makeWrapper(
    registration: NonNullable<NatsClientOptions["registration"]> = fakeRegistration,
  ): Wrapper {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 0,
      // Legacy pending/stale-draft tests isolate the existing FIFO machinery;
      // #81's held watchdog has its own focused deterministic suite.
      ackStallTimeoutMs: 0,
      registration,
    });
  }
  const inner = (w: Wrapper) => (w as unknown as { client: { sendUserMessage: (t: string) => string; notifySessionListeners: () => void } }).client;
  const lowLevel = (w: Wrapper) => (w as unknown as { client: { client: { connected: boolean; notifyStateListeners: () => void } } }).client.client;
  const deliver = (w: Wrapper, frame: Frame) => (w as unknown as { handleMessage: (m: Frame) => void }).handleMessage(frame);
  const messages = (w: Wrapper) => w.getState().messages;
  const held = (w: Wrapper) => (w as unknown as { held: Array<{ localId: string; text: string }> }).held;
  const heldTexts = (w: Wrapper) => held(w).map((h) => h.text);
  const pendingBubbles = (w: Wrapper) => messages(w).filter((m) => m.pending);

  /**
   * Open the release gate WITHOUT a socket (direct field set). The REAL
   * onState/onSession callbacks are exercised in the session-gate and wire-order
   * tests below; here we only need `connected` + `sessionEstablished` true so the
   * reducer-level release logic runs.
   */
  function goOnline(w: Wrapper): void {
    (w as unknown as { state: Record<string, unknown> }).state = {
      ...(w as unknown as { state: Record<string, unknown> }).state,
      connected: true,
      status: "connected",
    };
    (w as unknown as { sessionEstablished: boolean }).sessionEstablished = true;
  }
  /** Fire the wrapper's real onState(false) (forces isTyping:false; clears the gate). */
  function goOffline(w: Wrapper): void {
    const ll = lowLevel(w);
    ll.connected = false;
    ll.notifyStateListeners();
  }
  const fireSession = (w: Wrapper) => inner(w).notifySessionListeners();

  // Real socket + real conversation key over the register-delivered-K path.
  /**
   * Connect and CAPTURE the socket THIS wrapper dialed. Load-bearing (#92): never
   * reach for "the newest FakeRegisterWS" — `instances` is a module-global the
   * fake appends to from its own constructor, and a wrapper an earlier test never
   * closed keeps redialing on REAL timers long after that test returned. Its stray
   * dial appends here MID-test and silently becomes "the newest", so a wire
   * assertion reads the intruder's empty `sent` instead of ours — which is exactly
   * how 10b failed in CI (`expected [] to have a length of 1 but got +0`) while
   * the behavior under test was fine. The specific leak is now closed at its
   * source (the P1-7 retirement test), but capturing is what makes these
   * assertions structurally immune to the next one. `connect()` dials
   * synchronously, so the instance appended by this call is unambiguously ours.
   */
  function dial(w: Wrapper): FakeRegisterWS {
    w.connect();
    return FakeRegisterWS.instances[FakeRegisterWS.instances.length - 1];
  }
  const keyState = (w: Wrapper) => inner(w) as unknown as { sessionKey: unknown };
  async function waitFor(pred: () => boolean, n = 100): Promise<void> {
    for (let i = 0; i < n; i++) {
      if (pred()) return;
      await tick();
    }
    throw new Error("waitFor timed out");
  }
  /**
   * Wait for the (already-wired) register round-trip to deliver + unwrap K, then
   * let the onSession-driven release settle. The caller sets `.handler` on the
   * socket `dial()` captured (and, for the delayed-key test, gates the register
   * reply).
   */
  async function establishKey(w: Wrapper): Promise<void> {
    await waitFor(() => Boolean(keyState(w).sessionKey));
    await tick(); // drain → flush → notify(session) → release
  }
  const inboundPubs = (ws: FakeRegisterWS) => ws.sent.filter((s) => s.startsWith(`PUB ${IN} `));

  let originalWebSocket: unknown;
  beforeEach(() => {
    originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeRegisterWS;
    FakeRegisterWS.instances = [];
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // 1. idle send publishes immediately (A4 regression pin).
  it("1: an idle send publishes immediately (no hold when nothing is in flight)", () => {
    const w = makeWrapper();
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    w.send("hello");
    expect(spy).toHaveBeenCalledWith("hello", expect.any(String));
    const m = messages(w)[0];
    expect(m.pending).toBeUndefined();
    expect(m.wireId).toBeTruthy();
    expect(m.turnId).toBe(m.wireId);
  });

  // 2. send during isTyping → not published, bubble pending:true, no wireId.
  it("2: a send during isTyping is HELD (pending bubble, not published, no wireId)", () => {
    const w = makeWrapper();
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("queued");
    expect(spy).not.toHaveBeenCalled();
    const m = messages(w)[0];
    expect(m.pending).toBe(true);
    expect(m.wireId).toBeUndefined();
    expect(heldTexts(w)).toEqual(["queued"]);
  });

  it("2b: a held staging bubble skips a hydrated u-<n> id before later materialization", () => {
    const w = makeWrapper();
    deliver(w, {
      type: "history",
      messages: [{ id: "u-0", role: "user", text: "history", ts: 1 }],
    });
    deliver(w, { type: "typing" });

    w.send("held local");

    expect(messages(w).map((m) => m.id)).toEqual(["u-0", "u-1"]);
    expect(messages(w)[0]).not.toHaveProperty("receiptKey");
    expect(messages(w)[1]).toMatchObject({
      id: "u-1",
      role: "user",
      text: "held local",
      pending: true,
      sendState: "queued",
    });
  });

  // 3. send during a working draft (isTyping already false) → held.
  it("3: a send during a working draft is HELD even though isTyping is false", () => {
    const w = makeWrapper();
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    expect(w.getState().isTyping).toBe(false); // progress clears typing
    w.send("queued");
    expect(spy).not.toHaveBeenCalled();
    expect(pendingBubbles(w).map((m) => m.text)).toEqual(["queued"]);
  });

  // 4. agent_message final → held released FIFO: publish order + patched + moved to tail.
  it("4: on the agent's final message, held messages release FIFO — patched and MOVED TO THE TAIL", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("held-1");
    w.send("held-2"); // latched behind held-1
    expect(spy).not.toHaveBeenCalled();

    deliver(w, { type: "agent_message", id: "webchannel-A", text: "the reply", turnId: "T" });

    // FIFO publish order.
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["held-1", "held-2"]);
    // Display order: the reply, THEN the two released chips at the tail.
    expect(messages(w).map((m) => m.text)).toEqual(["the reply", "held-1", "held-2"]);
    const [, r1, r2] = messages(w);
    for (const r of [r1, r2]) {
      expect(r.pending).toBe(false);
      expect(r.wireId).toBeTruthy();
      expect(r.turnId).toBe(r.wireId);
    }
    expect(held(w)).toHaveLength(0);
  });

  // 5. turn_settled (typing-only turn, no draft) → releases.
  it("5: turn_settled on a typing-only turn releases held messages", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("queued");
    expect(spy).not.toHaveBeenCalled();
    deliver(w, { type: "turn_settled", turnId: "T" });
    expect(spy).toHaveBeenCalledWith("queued", expect.any(String));
    expect(pendingBubbles(w)).toHaveLength(0);
  });

  // 6. retract a pending id → gone, nothing published after settle; non-pending id → false.
  it("6: retract removes a pending bubble (nothing published after settle); a non-pending id is a no-op", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("oops");
    const id = messages(w)[0].id;

    expect(w.retract(id)).toBe(true);
    expect(messages(w)).toHaveLength(0);
    expect(held(w)).toHaveLength(0);

    // The turn settles — nothing to release (it was retracted before the wire).
    deliver(w, { type: "turn_settled", turnId: "T" });
    expect(spy).not.toHaveBeenCalled();

    // A non-pending / unknown id → false, no-op.
    w.send("sent"); // idle → normal send (not pending)
    const sentId = messages(w)[0].id;
    expect(w.retract(sentId)).toBe(false);
    expect(w.retract("no-such-id")).toBe(false);
  });

  // 7. explicit /stop mid-turn → published immediately AND held bubbles flip retracted.
  it("7: explicit /stop publishes immediately AND flips held bubbles to retracted (kept in transcript)", () => {
    const w = makeWrapper();
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("later question");
    const heldId = messages(w)[0].id;

    w.send(" /STOP "); // case/whitespace variant — trimmed before publish
    expect(spy).toHaveBeenCalledWith("/STOP", expect.any(String));
    const marker = messages(w).find((m) => m.id === heldId)!;
    expect(marker.retracted).toBe(true);
    expect(marker.pending).toBe(false);
    expect(marker.text).toBe("later question"); // text preserved
    expect(held(w)).toHaveLength(0); // out of the held queue

    // The retracted marker is retractable (dismiss / after restore).
    expect(w.retract(heldId)).toBe(true);
  });

  // 8. Current NL abort words mid-turn → bypass: published immediately, held untouched.
  it("8: NL abort words bypass the hold (publish immediately) and DO NOT touch held messages", () => {
    for (const word of ["stop", "halt", "abort", "Stop."]) {
      const w = makeWrapper();
      const spy = vi.spyOn(inner(w), "sendUserMessage");
      deliver(w, { type: "typing" });
      w.send("keep me");
      spy.mockClear();

      w.send(word);
      expect(spy).toHaveBeenCalledWith(word, expect.any(String)); // bypassed → published
      // The held message is UNTOUCHED (not retracted, still pending).
      const stillHeld = messages(w).find((m) => m.text === "keep me")!;
      expect(stillHeld.pending).toBe(true);
      expect(stillHeld.retracted).toBeUndefined();
      expect(heldTexts(w)).toEqual(["keep me"]);
    }
  });

  it("8b: wait is ordinary text under the current pin and follows the hold/release path", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });

    w.send("wait");
    expect(spy).not.toHaveBeenCalled();
    expect(heldTexts(w)).toEqual(["wait"]);

    deliver(w, { type: "turn_settled", turnId: "T" });
    expect(spy).toHaveBeenCalledWith("wait", expect.any(String));
    expect(held(w)).toHaveLength(0);
  });

  // 9. latch: typing-only turn → M1 held → onState(false) → send M2 → M2 held → reconnect → release M1,M2.
  it("9: the held.length>0 latch preserves FIFO across a disconnect (M2 queues behind M1, released in order)", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("M1"); // held (isTyping)

    goOffline(w); // real onState(false): isTyping → false, gate closed, M1 latched
    expect(w.getState().isTyping).toBe(false);

    w.send("M2"); // turnInFlight is false now, but held.length>0 latches → held
    expect(spy).not.toHaveBeenCalled();
    expect(heldTexts(w)).toEqual(["M1", "M2"]);

    // Reconnect + session established → release in FIFO order.
    goOnline(w);
    fireSession(w);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["M1", "M2"]);
  });

  // 10a. session gate: settle-while-disconnected → no release; onState(true) alone → no release;
  //      onSession → releases (delayed-key over the real socket makes the middle assertion real).
  it("10a: release gates on session establishment, not the raw connect flip (delayed key)", async () => {
    const { registration, deviceKP, agentId, K } = await realRegistration();
    const w = makeWrapper(registration);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("M"); // held
    deliver(w, { type: "turn_settled", turnId: "T" }); // settle while DISCONNECTED
    expect(spy).not.toHaveBeenCalled(); // no release (not connected/established)

    // Connect, but GATE the register REPLY so the conversation key is DELAYED:
    // onState(true) fires (connected) while sessionEstablished stays false.
    let releaseRegister = () => {};
    const gate = new Promise<void>((r) => { releaseRegister = r; });
    dial(w).handler = makeRegisterHandler(
      "t", "a", "p",
      (cn) => wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, "p", cn),
      gate,
    );
    await waitFor(() => lowLevel(w).connected);
    await tick(); // let the (gated) register round-trip reach its held reply
    expect(w.getState()).toMatchObject({ status: "connecting", connected: false });
    expect(keyState(w).sessionKey).toBeFalsy(); // connected but keyless → still held
    expect(spy).not.toHaveBeenCalled();
    expect(heldTexts(w)).toEqual(["M"]);

    // Key arrives → onSession fires (after flushQueue) → release.
    releaseRegister();
    await establishKey(w);
    expect(w.getState()).toMatchObject({ status: "connected", connected: true });
    expect(spy).toHaveBeenCalledWith("M", expect.any(String));
    w.close();
  });

  // 10b. ledger order: an undelivered P0-7b ledger entry M1 replays BEFORE a released hold M2
  //      (drain→flush→notify — the onSession release is ordered behind the ledger replay).
  it("10b: on reconnect a ledgered M1 replays on the wire BEFORE a released hold M2", async () => {
    const { registration, deviceKP, agentId, K } = await realRegistration();
    const w = makeWrapper(registration);
    const ws = dial(w); // every wire assertion below reads OUR socket (see `dial`)
    ws.handler = makeRegisterHandler(
      "t", "a", "p",
      (cn) => wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, "p", cn),
    );
    await establishKey(w); // session 1

    // Spy records how many `.in` publishes exist AT THE MOMENT sendUserMessage runs.
    const counts: number[] = [];
    const c = inner(w);
    const realSUM = c.sendUserMessage.bind(c);
    vi.spyOn(c, "sendUserMessage").mockImplementation((text: string) => {
      counts.push(inboundPubs(ws).length);
      return realSUM(text);
    });

    w.send("M1"); // sealed publish + recorded in the P0-7b unacked ledger
    deliver(w, { type: "typing" }); // start a turn so the next send holds
    w.send("M2"); // held
    expect(inboundPubs(ws)).toHaveLength(1); // only M1 on the wire so far

    // Session drop that KEEPS the unacked ledger (resetSession keeps it), then
    // reconnect on the same socket → onConnected re-runs register + key delivery.
    const ll = lowLevel(w);
    ll.connected = false;
    ll.notifyStateListeners();
    ll.connected = true;
    ll.notifyStateListeners();
    await establishKey(w); // session 2: flushQueue replays M1, THEN onSession releases M2

    // Wire: [M1 (initial), M1 (ledger replay), M2 (released hold)] — three publishes.
    expect(inboundPubs(ws)).toHaveLength(3);
    // sendUserMessage fired for M1 (0 prior `.in`) then M2 (2 prior `.in` — its own
    // send + the ledger replay). The "2" proves the replay preceded the release.
    expect(counts).toEqual([0, 2]);
    w.close();
  });

  // 11. snapshot identical text does NOT adopt onto a pending/retracted bubble.
  it("11: a snapshot with identical text does not adopt onto a pending bubble; both survive distinctly", () => {
    const w = makeWrapper();
    goOnline(w);
    deliver(w, { type: "typing" });
    w.send("dup"); // held pending
    const localId = messages(w)[0].id;

    // Another device sent the same text → the snapshot carries a server row "dup".
    deliver(w, { type: "history", messages: [{ id: "srv-dup", role: "user", text: "dup" }] });

    // The pending bubble is NOT an adoption target → two distinct bubbles.
    expect(messages(w)).toHaveLength(2);
    expect(messages(w).find((m) => m.id === localId)?.pending).toBe(true);
    expect(messages(w).some((m) => m.id === "srv-dup")).toBe(true);

    // After the turn settles the held bubble releases and both still exist.
    deliver(w, { type: "turn_settled", turnId: "T" });
    expect(messages(w)).toHaveLength(2);
    expect(messages(w).find((m) => m.id === localId)?.pending).toBe(false);
  });

  // 12. §6.3 transparency: a held chip sitting between the user row and the
  //     reply must not disturb reconciliation.
  //
  // ⚠️ THE MECHANISM THIS NAMED IS GONE; THE PROPERTY IS NOT, AND MUST NOT BE
  // DROPPED. It was `the tier-3 positional probe skips a held chip and adopts
  // onto the reply`: the probe walked from the anchor and had to STEP OVER a
  // pending chip or it would land on the chip and the reply would duplicate.
  // #240 half 2 deleted the probe, so there is nothing to step over — but the
  // §6.3 property still has to hold end to end, and it is asserted below
  // unchanged: the reply produces no duplicate bubble and the chip stays held
  // and unclaimed. (The other half of §6.3 — a held chip is never an adoption
  // TARGET — is `isAdoptableUserEcho`'s job and is pinned by test 11.)
  it("12: a held chip between the user row and the reply causes no duplicate agent bubble", () => {
    const w = makeWrapper();
    goOnline(w);
    w.send("u2"); // normal user send (idle)
    deliver(w, { type: "typing" });
    w.send("h3"); // held pending
    // Multi-frame reply: A1 and A2 both live; A2 stays WORKING so the hold survives.
    deliver(w, { type: "progress", id: "webchannel-a1", text: "a1…", turnId: "T" });
    deliver(w, { type: "progress", id: "webchannel-a2", text: "a2…", turnId: "T" });
    deliver(w, { type: "agent_message", id: "webchannel-a1", text: "A1 FINAL", turnId: "T" });
    // Layout: [u2, h3(pending), A1(final), A2(working)]; still held (A2 working).
    expect(messages(w).map((m) => m.text)).toEqual(["u2", "h3", "A1 FINAL", "a2…"]);
    expect(pendingBubbles(w)).toHaveLength(1);

    // Snapshot [u2row, A1row] on journal ids: the user row carries the wire id
    // (tier 2 adopts the `u-<n>` echo) and A1 carries the id it was delivered
    // with (tier 1). The held chip `h3` was never sent, so the journal has no
    // row for it at all — which is the §6.3 invariant restated on the server
    // side.
    deliver(w, {
      type: "history",
      messages: [
        { id: "wire-u2", role: "user", text: "u2" },
        { id: "webchannel-a1", role: "agent", text: "A1 FINAL" },
      ],
    });

    // A1's row lands on A1 across the held chip — no duplicate agent bubble.
    expect(messages(w)).toHaveLength(4);
    expect(messages(w).find((m) => m.id === "webchannel-a1")?.text).toBe("A1 FINAL");
    expect(messages(w).filter((m) => m.role === "agent")).toHaveLength(2); // A1 + A2
    expect(pendingBubbles(w)).toHaveLength(1); // h3 still held
    // The chip is untouched: it kept its LOCAL id and was not adopted by the
    // user row, which belongs to `u2`.
    expect(messages(w)[1].text).toBe("h3");
    expect(messages(w)[1].id.startsWith("u-")).toBe(true);
  });

  // 12b. post-release snapshot: a released chip (moved to tail) is an ordinary
  //      in-order send. Re-based onto journal ids — the agent rows now match by
  //      id (tier 1) and the two user rows still tier-2 adopt their echoes.
  it("12b: after release (moved to tail), a snapshot reconciles cleanly with no duplicates", () => {
    const w = makeWrapper();
    goOnline(w);
    w.send("u2");
    deliver(w, { type: "typing" });
    w.send("h3"); // held
    deliver(w, { type: "agent_message", id: "webchannel-A", text: "A reply", turnId: "T" });
    // Reply settled the turn → h3 released and MOVED TO THE TAIL: [u2, A, h3].
    expect(messages(w).map((m) => m.text)).toEqual(["u2", "A reply", "h3"]);
    expect(pendingBubbles(w)).toHaveLength(0);

    // Snapshot carries the whole conversation in order, plus a newer reply R
    // that this device never rendered (so it fresh-inserts at the tail).
    deliver(w, {
      type: "history",
      messages: [
        { id: "wire-u2", role: "user", text: "u2" },
        { id: "webchannel-A", role: "agent", text: "A reply" },
        { id: "wire-h3", role: "user", text: "h3" },
        { id: "webchannel-R", role: "agent", text: "R reply" },
      ],
    });
    expect(messages(w).map((m) => m.id)).toEqual([
      "wire-u2",
      "webchannel-A",
      "wire-h3",
      "webchannel-R",
    ]);
    expect(messages(w).map((m) => m.text)).toEqual(["u2", "A reply", "h3", "R reply"]);
  });

  // 13. no snapshot finalize: a mid-turn snapshot with intermediate agent rows leaves the draft working.
  it("13: a mid-turn snapshot with intermediate agent rows never finalizes a working draft (held stays held)", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("held");
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    expect(spy).not.toHaveBeenCalled();

    // A routine mid-session snapshot. (The old note said "core appends assistant
    // rows per message_end" — a core-transcript fact, dead with the reader. The
    // journal appends a row per DELIVERED bubble, so a mid-turn snapshot still
    // carries earlier answers; the property under test is unaffected.)
    deliver(w, {
      type: "history",
      messages: [
        { id: "wire-u", role: "user", text: "earlier" },
        { id: "webchannel-mid", role: "agent", text: "intermediate assistant row" },
      ],
    });

    // The working draft survived working:true; the held message is still held.
    expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(true);
    expect(pendingBubbles(w)).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  // 14. staleness valve (fake timers).
  describe("14: post-reconnect staleness valve", () => {
    it("expires a wedged working draft after the grace, in place, and releases held", () => {
      vi.useFakeTimers();
      const w = makeWrapper();
      goOnline(w);
      deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" }); // working draft
      w.send("held"); // held (draft working; progress already cleared isTyping)
      // Session re-establishes with the draft still working → arm the valve.
      fireSession(w);

      vi.advanceTimersByTime(30_000);
      const draft = messages(w).find((m) => m.id === "webchannel-d")!;
      expect(draft.working).toBe(false); // flipped in place
      expect(draft.id).toBe("webchannel-d"); // id untouched
      expect(draft.text).toBe("partial…"); // text untouched
      // #251 does NOT drop here, and that is deliberate: this valve is a
      // consumer-side GUESS fired mid-turn, not a turn-end signal, so it PROMOTES
      // the partial to durable instead of deleting content on a guess (N10). The
      // three real turn-end sites — terminal settle, `turn_settled`, explicit
      // `/stop` — do drop. Clearing the bit is what makes the bubble survive:
      // leaving `working:false && draftOnly:true` committed would let
      // `mergeDurable`'s rule 4 drop it on the next unrelated frame.
      expect(draft.draftOnly).toBeUndefined();
      expect(pendingBubbles(w)).toHaveLength(0); // released
    });

    it("a draft-touching progress frame inside the grace disarms the valve (held stays held)", () => {
      vi.useFakeTimers();
      const w = makeWrapper();
      goOnline(w);
      deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
      w.send("held");
      fireSession(w);

      vi.advanceTimersByTime(10_000);
      deliver(w, { type: "progress", id: "webchannel-d", text: "more…", turnId: "T" }); // proof of life
      vi.advanceTimersByTime(30_000);
      expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(true);
      expect(pendingBubbles(w)).toHaveLength(1); // still held
    });

    it("a post-expiry progress re-flips the SAME draft working (self-heals, no duplicate)", () => {
      vi.useFakeTimers();
      const w = makeWrapper();
      goOnline(w);
      deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
      fireSession(w);
      vi.advanceTimersByTime(30_000);
      expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(false);

      deliver(w, { type: "progress", id: "webchannel-d", text: "back alive…", turnId: "T" });
      const drafts = messages(w).filter((m) => m.id === "webchannel-d");
      expect(drafts).toHaveLength(1); // no duplicate
      expect(drafts[0].working).toBe(true); // re-engaged
      // The valve PROMOTES rather than drops (see the test above), so the bubble
      // never left and the self-heal keeps its ORIGINAL SLOT — unlike the three
      // turn-end sites, where a dropped lane re-materialises at the tail.
      expect(messages(w)[0].id).toBe("webchannel-d");
      // …and the re-claim does not re-mark an already-promoted bubble as a draft,
      // which would make it droppable at the eventual turn end.
      expect(drafts[0].draftOnly).toBeUndefined();
    });

    it("a mid-grace flap clears the timer and re-arms fresh on the next onSession (disconnected time never counts)", () => {
      vi.useFakeTimers();
      const w = makeWrapper();
      goOnline(w);
      deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
      fireSession(w);

      vi.advanceTimersByTime(20_000); // 20s into the grace
      goOffline(w); // flap: timer + watch cleared
      vi.advanceTimersByTime(30_000); // disconnected time — must NOT expire anything
      expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(true);

      // Reconnect re-arms a FULL fresh grace.
      goOnline(w);
      fireSession(w);
      vi.advanceTimersByTime(29_000);
      expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(true); // not yet
      vi.advanceTimersByTime(1_000);
      expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(false); // now
    });

    // #94: after the per-message lane rotation a single turn leaves N working
    // drafts under N different ids, so the valve has to arm and expire them
    // individually rather than "the draft" of the turn.
    it("#94: expires EVERY wedged lane of a multi-bubble turn, each in place", () => {
      vi.useFakeTimers();
      const w = makeWrapper();
      goOnline(w);
      // One turn, three lanes, all left streaming across the reconnect.
      deliver(w, { type: "progress", id: "webchannel-a", text: "A partial…", turnId: "T" });
      deliver(w, { type: "progress", id: "webchannel-b", text: "B partial…", turnId: "T" });
      deliver(w, { type: "progress", id: "webchannel-c", text: "C partial…", turnId: "T" });
      w.send("held"); // held behind the working drafts
      fireSession(w); // arm: the watch set takes ALL THREE ids

      vi.advanceTimersByTime(30_000);
      const byId = (id: string) => messages(w).find((m) => m.id === id)!;
      // Arming iterates every `working` message, so one wedged turn arms N
      // entries and the single grace timer expires all of them together. Leaving
      // any one lane `working` would keep turnInFlight() true and the composer
      // wedged — the exact lockout this valve exists to prevent.
      for (const [id, text] of [
        ["webchannel-a", "A partial…"],
        ["webchannel-b", "B partial…"],
        ["webchannel-c", "C partial…"],
      ] as const) {
        expect(byId(id).working).toBe(false); // flipped
        expect(byId(id).id).toBe(id); // id untouched
        expect(byId(id).text).toBe(text); // text untouched
        // #251: this valve PROMOTES rather than drops — it is a mid-turn guess,
        // not a turn-end signal. Every lane keeps its bubble AND its slot.
        expect(byId(id).draftOnly).toBeUndefined();
      }
      // All three keep their slots, ahead of the user bubble the valve released.
      expect(messages(w).map((m) => m.id)).toEqual([
        "webchannel-a",
        "webchannel-b",
        "webchannel-c",
        "u-0",
      ]);
      expect(pendingBubbles(w)).toHaveLength(0); // released
    });

    it.each([
      {
        frameType: "progress",
        frame: { type: "progress", id: "webchannel-b", text: "B more…", turnId: "T" },
        expectedBText: "B more…",
        expectedBWorking: true,
      },
      {
        frameType: "agent_message",
        frame: { type: "agent_message", id: "webchannel-b", text: "B final", turnId: "T" },
        expectedBText: "B final",
        expectedBWorking: false,
      },
    ])(
      "#94: $frameType on ONE lane inside the grace disarms only that lane; dead siblings still expire",
      ({ frame, expectedBText, expectedBWorking }) => {
        vi.useFakeTimers();
        const w = makeWrapper();
        goOnline(w);
        deliver(w, { type: "progress", id: "webchannel-a", text: "A partial…", turnId: "T" });
        deliver(w, { type: "progress", id: "webchannel-b", text: "B partial…", turnId: "T" });
        deliver(w, { type: "progress", id: "webchannel-c", text: "C partial…", turnId: "T" });
        fireSession(w);

        // Draft-touching proof for lane B only. Both PROGRESS and AGENT_MESSAGE
        // must delete only B's watched id. A turn-wide disarm in either path
        // would leave A/C working after the timer because expiry would no longer
        // own them. `agent_message` additionally settles B itself; that expected
        // state difference is parameterized below.
        //
        // SCOPE: reasoning remains turn-wide and is tracked separately in #105.
        // `turn_settled`, explicit `/stop`, terminal error, and teardown/re-arm
        // intentionally have broader effects covered by their focused tests.
        vi.advanceTimersByTime(10_000);
        deliver(w, frame);

        vi.advanceTimersByTime(30_000);
        const byId = (id: string) => messages(w).find((m) => m.id === id)!;
        expect(byId("webchannel-a").working).toBe(false); // expired
        expect(byId("webchannel-c").working).toBe(false); // expired
        expect(byId("webchannel-b").working).toBe(expectedBWorking);
        expect(byId("webchannel-b").text).toBe(expectedBText);
        // Expiry flips only working state; sibling ids/text remain intact.
        expect(byId("webchannel-a").text).toBe("A partial…");
        expect(byId("webchannel-c").text).toBe("C partial…");
        // #251: expiry PROMOTES the expired partials to durable rather than
        // dropping them (mid-turn guess, not a turn-end signal), so all three
        // bubbles and their order survive.
        expect(byId("webchannel-a").draftOnly).toBeUndefined();
        expect(byId("webchannel-c").draftOnly).toBeUndefined();
        expect(messages(w).map((m) => m.id)).toEqual([
          "webchannel-a",
          "webchannel-b",
          "webchannel-c",
        ]);
      },
    );
  });

  // 15. turn_settled with matching turnId settles a lingering draft — and #251
  // makes "settle" mean DROP for a lane that never received durable text.
  it("15: turn_settled drops a lingering working draft whose turnId matches (#251)", () => {
    const w = makeWrapper();
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    expect(messages(w)[0].working).toBe(true);
    deliver(w, { type: "turn_settled", turnId: "T" });
    // Was: finalized in place, still showing "partial…" forever. Core's built-in
    // Telegram extension deletes an unfinalized preview at turn end
    // (`[core] extensions/telegram/src/bot-message-dispatch.ts:2971-2975`), and so
    // do we now.
    expect(messages(w)).toHaveLength(0);
    // The composer still unwedges — that is what the settle is for.
    expect(w.getState().isTyping).toBe(false);
  });

  // 16. approval_request with no working draft → releases.
  it("16: an approval_request with no working draft releases held messages", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("queued");
    expect(spy).not.toHaveBeenCalled();
    deliver(w, {
      type: "approval_request",
      id: "ap-1",
      kind: "exec",
      title: "Run",
      prompt: "cmd",
      options: [{ decision: "allow-once", label: "Allow", style: "success" }],
    });
    expect(spy).toHaveBeenCalledWith("queued", expect.any(String));
    expect(pendingBubbles(w)).toHaveLength(0);
  });

  // 17. Fix A: a re-entrant send() from a mid-release listener must NOT jump the
  //     queue — the live drain keeps FIFO (M1, M2, M3), never M1, M3, M2.
  it("17: a re-entrant send during the release loop stays FIFO (live drain, no queue-jump)", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "typing" });
    w.send("M1");
    w.send("M2"); // latched behind M1 → held [M1, M2]
    expect(spy).not.toHaveBeenCalled();

    // Inject a re-entrant send("M3") ONLY once M1 has actually been released
    // mid-loop (its bubble is present and no longer pending) — that lands the
    // injected send INSIDE the release loop while M2 is still queued in held[].
    // Gating on the released M1 (not merely the first setState) is what makes
    // this guard the fix: snapshot-and-clear has held[] empty at that instant so
    // M3 would publish immediately → ["M1","M3","M2"]; the live drain keeps M2
    // queued so M3 holds and the loop drains it last → ["M1","M2","M3"].
    let injected = false;
    const unsub = w.subscribe(() => {
      if (injected) return;
      if (!messages(w).some((m) => m.text === "M1" && m.pending === false)) return;
      injected = true;
      w.send("M3");
    });

    // Settle the turn → release loop drains [M1, M2] live; the M1 setState fires
    // the listener which calls send("M3"). Because M2 is still in held[], M3 is
    // HELD (not published now) and the continuing loop drains it after M2.
    deliver(w, { type: "agent_message", id: "webchannel-A", text: "the reply", turnId: "T" });
    unsub();

    // Wire/publish order: FIFO, NOT M1, M3, M2.
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["M1", "M2", "M3"]);
    // Display order: the reply, then the three user chips in FIFO at the tail.
    const userTexts = messages(w).filter((m) => m.role === "user").map((m) => m.text);
    expect(userTexts).toEqual(["M1", "M2", "M3"]);
    expect(held(w)).toHaveLength(0);
    expect(pendingBubbles(w)).toHaveLength(0);
  });

  // 18. Fix B1: explicit /stop settles a live working draft, unwedging the
  //     composer even with no disconnect (socket-alive agent death). #251: for a
  //     lane that never received durable text, settling means DROPPING it.
  it("18: explicit /stop drops a live unfinalized draft (#251) and unlocks the composer", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");

    // A working draft is live (its final frame is about to be lost — no settle).
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(true);

    // Explicit /stop: published immediately AND settles the draft. This used to
    // assert flipped-in-place with id and text untouched; the lane never became
    // durable, so it is dropped instead — "stop everything" ends the turn, and
    // core's built-in Telegram extension deletes an unfinalized preview at turn
    // end (`[core] extensions/telegram/src/bot-message-dispatch.ts:2971-2975`).
    w.send("/stop");
    expect(spy).toHaveBeenCalledWith("/stop", expect.any(String));
    expect(messages(w).some((m) => m.id === "webchannel-d")).toBe(false);

    // The wedge is unlocked: a subsequent send publishes IMMEDIATELY (not held).
    spy.mockClear();
    w.send("next");
    expect(spy).toHaveBeenCalledWith("next", expect.any(String));
    expect(pendingBubbles(w)).toHaveLength(0);
    expect(held(w)).toHaveLength(0);
  });

  // 18b. Fix B1 self-heal: a post-/stop progress on the same draft id brings the
  //      lane back (the turn was actually alive), with no duplicate bubble.
  it("18b: a post-/stop progress re-materialises the same draft (self-heal, no duplicate)", () => {
    const w = makeWrapper();
    goOnline(w);
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    w.send("/stop");
    // #251: dropped, not frozen at "partial…".
    expect(messages(w).some((m) => m.id === "webchannel-d")).toBe(false);

    deliver(w, { type: "progress", id: "webchannel-d", text: "back alive…", turnId: "T" });
    const drafts = messages(w).filter((m) => m.id === "webchannel-d");
    // The self-heal is intact: the id is REUSED, so the lane comes back as ONE
    // bubble that a later final still matches. What the drop costs is the slot —
    // it re-materialises at the tail. Pinned in
    // `durable-view-reducer.test.ts` ("late progress after a drop re-materialises
    // the lane at the TAIL (#251)").
    expect(drafts).toHaveLength(1); // no duplicate bubble
    expect(drafts[0].working).toBe(true); // re-engaged
    expect(drafts[0].text).toBe("back alive…");
  });

  // 18c. Fix B1 scope: an NL abort word ("abort") must NOT finalize a working draft.
  it("18c: an NL abort word does not finalize a live working draft (only explicit /stop does)", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });

    w.send("abort"); // NL abort → bypasses the hold, published, but NO finalize
    expect(spy).toHaveBeenCalledWith("abort", expect.any(String));
    expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(true);
  });

  // 18d. Fix B1: explicit /stop rescues an isTyping-ONLY wedge (pre-first-token
  //      hang: typing frame, turn dies before any progress, socket alive).
  it("18d: explicit /stop clears an isTyping-only wedge (no working draft) and unlocks the composer", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");

    deliver(w, { type: "typing" }); // isTyping:true, zero working drafts
    expect(w.getState().isTyping).toBe(true);

    w.send("/stop");
    expect(spy).toHaveBeenCalledWith("/stop", expect.any(String));
    expect(w.getState().isTyping).toBe(false); // typing indicator cleared

    // Composer unlocked: a subsequent send publishes immediately (not held).
    spy.mockClear();
    w.send("next");
    expect(spy).toHaveBeenCalledWith("next", expect.any(String));
    expect(pendingBubbles(w)).toHaveLength(0);
    expect(held(w)).toHaveLength(0);
  });
});
