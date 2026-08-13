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
    deliver(w, {
      type: "history",
      messages: [
        { id: "core-u1", role: "user", text: "hi", ts: 1 },
        { id: "core-a1", role: "agent", text: "hello back", ts: 2 },
        { id: "core-u2", role: "user", text: "second question", ts: 3 },
        { id: "core-a2", role: "agent", text: "second answer", ts: 4 },
      ],
    });

    const messages = w.getState().messages;
    // The two NEW messages land at the BOTTOM, chronologically after the prefix.
    expect(messages.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-u2",
      "core-a2",
    ]);
    expect(messages.map((m) => m.text)).toEqual([
      "hi",
      "hello back",
      "second question",
      "second answer",
    ]);
  });

  it("regression via TIER-3: live agent text differs from stored text — positional adoption, then newer tail appends", () => {
    const w = makeWrapper();
    // Realistic openclaw turn: user echo + a live agent bubble whose text is the
    // reformatted (metadata-stripped) live reply, NOT byte-equal to the stored
    // transcript text → tier-2 exact-text matching MISSES the agent bubble.
    w.send("hi"); // u-0
    deliver(w, { type: "agent_message", id: "webchannel-live-1", text: "hello back (live-stripped)" });
    expect(w.getState().messages.map((m) => m.text)).toEqual([
      "hi",
      "hello back (live-stripped)",
    ]);

    // Snapshot: core-u1 tier-2 matches u-0 (sets the anchor), core-a1 then
    // adopts onto the live agent bubble POSITIONALLY (tier 3), and the newer
    // turn must APPEND after it — not prepend.
    deliver(w, {
      type: "history",
      messages: [
        { id: "core-u1", role: "user", text: "hi", ts: 1 },
        { id: "core-a1", role: "agent", text: "hello back RAW stored", ts: 2 },
        { id: "core-u2", role: "user", text: "newer q", ts: 3 },
        { id: "core-a2", role: "agent", text: "newer a", ts: 4 },
      ],
    });

    const messages = w.getState().messages;
    expect(messages.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-u2",
      "core-a2",
    ]);
    // The adopted agent bubble converged to the canonical stored text.
    expect(messages[1].text).toBe("hello back RAW stored");
  });

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
  it("C2: a snapshot of a two-bubble turn adopts BOTH canonical ids instead of duplicating", () => {
    const w = makeWrapper();
    w.send("hello"); // u-0 local echo
    liveBubble(w, "webchannel-a", "T", "…", "live A");
    liveBubble(w, "webchannel-b", "T", "…", "live B");
    expect(w.getState().messages).toHaveLength(3);

    // Snapshot from another device's register. The stored agent text carries the
    // metadata core strips from live frames, so it is NOT byte-equal to either
    // live text ⇒ tier 2 cannot match either agent row and tier 3 must carry
    // BOTH. This is the routine case after #94, not an edge case.
    const snapshot = [
      { id: "core-u1", role: "user", text: "hello", ts: 1 },
      { id: "core-a1", role: "agent", text: "live A\n\n<stored metadata A>", ts: 2 },
      { id: "core-a2", role: "agent", text: "live B\n\n<stored metadata B>", ts: 3 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // core-u1 tier-2 matches u-0 → anchor=0, cursor=1.
    // core-a1 tier-3 probes anchor+1=1 (agent, live id, not working) → adopt,
    //   anchor=1, cursor=2.
    // core-a2 tier-3 probes anchor+1=2 → adopt.
    // This case constrains anchor advancement on TIER-3 adoption. Every tier-2
    // and tier-3 adoption routes through the shared `adoptAt` helper, which
    // sets `anchor = idx`; the only writes outside it are the tier-1 branch and
    // the `anchor = null` on a fresh insert.
    // Mutation-checked — restoring the previous anchor at the tier-3 call site
    // only (`const a = anchor; adoptAt(cand, m); anchor = a;`) makes core-a2
    // re-probe idx 1, hit the `claimed` guard and fresh-insert: four bubbles
    // with a duplicated reply. C2, C4 and C4b all fail on that; C3 and C3b do
    // NOT — their surviving bubble sits at the first probed slot either way, so
    // those three tests carry it between them.
    // (Deleting `anchor = idx` from `adoptAt` wholesale is a far broader break
    // rather than a sharper version of the same one: the tier-2 user match then
    // leaves the anchor null, which disables tier 3 entirely. Nine tests across
    // four describe blocks catch that, C3 and C3b among them.)
    expect(messages).toHaveLength(3); // no duplicates
    expect(messages.map((m) => m.id)).toEqual(["core-u1", "core-a1", "core-a2"]);
    // Adoption keeps the CANONICAL stored text, so this device converges on
    // exactly what a freshly-reloading device renders.
    expect(messages.map((m) => m.text)).toEqual([
      "hello",
      "live A\n\n<stored metadata A>",
      "live B\n\n<stored metadata B>",
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
    expect(after.map((m) => m.id)).toEqual(["core-u1", "core-a1", "core-a2"]);
  });

  // --- C3: asymmetric live 1 / snapshot 2, the FIRST lane never settled. ---
  it("C3: when the first lane never settled, the surviving bubble is re-labelled and the array still converges", () => {
    const w = makeWrapper();
    // §8-1: lane A never settled on this device (its frames were lost), so the
    // only agent bubble here is lane B — the SECOND reply. The snapshot carries
    // both rows.
    w.send("hello"); // u-0
    liveBubble(w, "webchannel-b", "T", "…", "live B");
    expect(w.getState().messages).toHaveLength(2);

    const snapshot = [
      { id: "core-u1", role: "user", text: "hello", ts: 1 },
      { id: "core-a1", role: "agent", text: "reply A\n\n<stored>", ts: 2 },
      { id: "core-a2", role: "agent", text: "live B\n\n<stored>", ts: 3 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // MECHANISM — worth reading carefully, because it is NOT what the plan's
    // first draft implied. That draft said "tier-3 anchor advancement must not
    // wrongly adopt B into A's slot" (the plan now records this as an error and
    // states the real path). What actually happens is the
    // mirror image of that: core-a1 (lane A's row) is processed FIRST, tier-3
    // probes anchor+1 = idx 1, finds the lane-B bubble there, and adopts A's
    // row ONTO IT — the anchor chain reaches that bubble before core-a2 ever
    // gets a look. core-a2 then probes idx 2 (past the end), misses, and
    // fresh-inserts at cursor 2.
    // So the agent bubble's identity shifts by one slot (the user bubble is
    // unaffected — it matched by text in tier 2). The final
    // array is still exactly right — `adoptAt` overwrites the adopted bubble
    // with the row's CANONICAL text, and the leftover row lands after it — so
    // content and order both converge even though the path is not the one the
    // plan describes.
    // WHAT THIS PINS (mutation-checked): that this shape converges at all.
    // Disabling tier 3 strands the live bubble as a fourth entry (duplicate
    // reply), and dropping `cursor = idx + 1` from `adoptAt` misplaces the
    // fresh row; both are caught here. It does NOT pin tier-3 anchor
    // advancement — see the note in C2.
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.id)).toEqual(["core-u1", "core-a1", "core-a2"]);
    expect(messages.map((m) => m.text)).toEqual([
      "hello",
      "reply A\n\n<stored>",
      "live B\n\n<stored>",
    ]);
    // The fresh row lands settled — transcript history is never streaming.
    expect(messages[2].working).toBe(false);

    // Repeat delivery is a plain id no-op.
    deliver(w, { type: "history", messages: snapshot });
    const after = w.getState().messages;
    expect(after).toHaveLength(3);
    expect(after.map((m) => m.id)).toEqual(["core-u1", "core-a1", "core-a2"]);
    expect(after.map((m) => m.text)).toEqual([
      "hello",
      "reply A\n\n<stored>",
      "live B\n\n<stored>",
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
      { id: "core-u1", role: "user", text: "hello", ts: 1 },
      { id: "core-a1", role: "agent", text: "live A\n\n<stored metadata A>", ts: 2 },
      { id: "core-a2", role: "agent", text: "the reply this device never saw", ts: 3 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // core-u1 → adopt idx 0, anchor=0, cursor=1.
    // core-a1 → tier-3 probes idx 1 (the only live agent bubble) → adopt,
    //   anchor=1, cursor=2.
    // core-a2 → tier-3 probes idx 2, which is PAST the end of the local array,
    //   so no adoption happens and it fresh-inserts at cursor=2.
    // WHAT THIS CASE ACTUALLY CONSTRAINS (mutation-checked): that tier-3 fires
    // at all, and that `adoptAt` advances the cursor. Disabling tier 3 makes
    // core-a1 fresh-insert instead of adopting, stranding the live bubble as a
    // fourth entry (duplicate reply); dropping `cursor = idx + 1` misplaces the
    // trailing fresh row. Both failures are caught here.
    // It does NOT constrain the PAIRING, and no claim to that effect belongs
    // here: the surviving bubble sits at idx 1, the first slot tier-3 probes
    // (`cand = anchor + 1`) under any positional rule, and core-a1 is processed
    // before core-a2 — so no probe mutation can hand this bubble the wrong row.
    // (For core-a2 to land here instead, core-a1's adoption would have to fail,
    // which sets `anchor = null` and makes core-a2 fresh-insert anyway.)
    // Tier-3 anchor advancement is pinned by C2/C4/C4b, not here.
    expect(messages).toHaveLength(3); // nothing lost, nothing duplicated
    expect(messages.map((m) => m.id)).toEqual(["core-u1", "core-a1", "core-a2"]);
    expect(messages[1].text).toBe("live A\n\n<stored metadata A>");
    expect(messages[2].text).toBe("the reply this device never saw");
    // The fresh row lands settled — it is transcript history, never streaming.
    expect(messages[2].working).toBe(false);

    deliver(w, { type: "history", messages: snapshot });
    const after = w.getState().messages;
    expect(after).toHaveLength(3);
    expect(after.map((m) => m.id)).toEqual(["core-u1", "core-a1", "core-a2"]);
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
      { id: "core-u1", role: "user", text: "hello", ts: 1 },
      { id: "core-a1", role: "agent", text: "live A\n\n<stored metadata A>", ts: 2 },
      { id: "core-a2", role: "agent", text: "live B\n\n<stored metadata B>", ts: 3 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // core-u1 → idx 0; core-a1 → idx 1; core-a2 → idx 2. The snapshot runs out
    // before the local array does, so idx 3 (lane C) is simply never probed and
    // keeps its LIVE id and LIVE text.
    // The invariant being frozen: a live bubble the snapshot does not reach
    // must survive untouched and in place, and a later snapshot that DOES carry
    // it will adopt it then. Dropping it would lose a rendered reply; inserting
    // the snapshot rows around it would duplicate one.
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-a2",
      "webchannel-c",
    ]);
    expect(messages.map((m) => m.text)).toEqual([
      "hello",
      "live A\n\n<stored metadata A>",
      "live B\n\n<stored metadata B>",
      "live C",
    ]);

    // Repeat the prefix first: the three snapshot ids are all tier-1 hits and
    // lane C is still newer than the snapshot, so it remains untouched.
    deliver(w, { type: "history", messages: snapshot });
    const afterPrefixRepeat = w.getState().messages;
    expect(afterPrefixRepeat).toHaveLength(4);
    expect(afterPrefixRepeat.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-a2",
      "webchannel-c",
    ]);

    // A later register snapshot now includes lane C. Its stored text differs
    // from the live rendering, forcing this exact path:
    //   core-u1/core-a1/core-a2 → tier-1 hits that advance anchor to idx 2;
    //   core-a3 → tier-2 miss, then tier-3 adopts idx 3 (lane C).
    // If tier-1 stopped advancing the anchor, or tier-3 stopped probing from
    // that anchor, core-a3 would fresh-insert and strand webchannel-c as a
    // duplicate fifth bubble.
    const completeSnapshot = [
      ...snapshot,
      { id: "core-a3", role: "agent", text: "live C\n\n<stored metadata C>", ts: 4 },
    ];
    deliver(w, { type: "history", messages: completeSnapshot });

    const adopted = w.getState().messages;
    expect(adopted).toHaveLength(4);
    expect(adopted.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-a2",
      "core-a3",
    ]);
    expect(adopted[3].text).toBe("live C\n\n<stored metadata C>");
    expect(adopted[3].working).toBe(false);

    // Once adopted, the complete snapshot is a pure tier-1 id no-op.
    deliver(w, { type: "history", messages: completeSnapshot });
    expect(w.getState().messages.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-a2",
      "core-a3",
    ]);
  });

  // --- C4b: the §6.5.1 defensive-rotation divergence. ---------------------
  //
  // READ THIS AS A COST LEDGER, NOT AS A CORRECTNESS PIN.
  //
  // §6.5.1 of the plan ACCEPTS a known divergence: when the plugin cannot prove
  // a boundary is the same assistant message it rotates the lane defensively,
  // so ONE assistant message that got rewritten mid-flight renders as TWO live
  // bubbles here while the core transcript stores it as ONE row. Unlike C4, the
  // last stored row DOES correspond to the last live bubble — and that is
  // precisely what breaks the reconciler's positional assumption.
  //
  // The behavior below is the accepted trade-off's actual price, measured:
  // tier 3 pairs the final stored row onto the WRONG live bubble (the earlier
  // one, because the anchor chain reaches it first), leaving the rewritten
  // message on screen TWICE — once with canonical text under the adopted id,
  // once with live text under the surviving live id. Nothing later in the
  // session clears it: repeat snapshots are pure id no-ops. Only a full reload
  // into empty state converges to the correct three bubbles.
  //
  // This test exists so that price is visible and cannot change silently. It is
  // NOT an assertion that the duplicate is correct. If the #94 fix (or a later
  // reconciler change) makes the session converge, this test SHOULD fail — and
  // the right response is to update it to the better behavior, not to preserve
  // the duplicate.
  it("C4b: §6.5.1 accepted divergence — a defensively-rotated rewrite shows TWICE until a full reload", () => {
    const w = makeWrapper();
    w.send("hello"); // u-0
    liveBubble(w, "webchannel-a", "T", "…", "msg A");
    // One assistant message, rewritten mid-flight across a defensive rotation:
    // lane B held the pre-rewrite rendering, lane C the final one.
    liveBubble(w, "webchannel-b", "T", "…", "msg C draft");
    liveBubble(w, "webchannel-c", "T", "…", "msg C rewritten");
    expect(w.getState().messages).toHaveLength(4);

    // The transcript stored the rewrite ONCE — so the last row's text tracks
    // lane C, not lane B.
    const snapshot = [
      { id: "core-u1", role: "user", text: "hello", ts: 1 },
      { id: "core-a1", role: "agent", text: "msg A\n\n<stored>", ts: 2 },
      { id: "core-a2", role: "agent", text: "msg C rewritten\n\n<stored>", ts: 3 },
    ];
    deliver(w, { type: "history", messages: snapshot });

    const messages = w.getState().messages;
    // core-u1 → idx 0 (anchor=0); core-a1 → tier-3 idx 1 (anchor=1);
    // core-a2 → tier-3 probes anchor+1 = idx 2 = lane B and adopts THERE.
    // Tier 3 is purely positional — it has no way to know the row it is
    // carrying describes lane C, two slots down — so lane C is left holding an
    // unadopted second copy of the same message.
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-a2",
      "webchannel-c",
    ]);
    // The last two entries are two renderings of the SAME assistant message:
    // the canonical stored text under the adopted id, and the live text under
    // the surviving live id. This is the visible duplicate.
    expect(messages[2].text).toBe("msg C rewritten\n\n<stored>");
    expect(messages[3].text).toBe("msg C rewritten");

    // The duplicate is NOT self-healing within the session: every later
    // snapshot hits all three ids in tier 1 and changes nothing.
    deliver(w, { type: "history", messages: snapshot });
    const after = w.getState().messages;
    expect(after).toHaveLength(4);
    expect(after.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-a2",
      "webchannel-c",
    ]);
    expect(after.map((m) => m.text)).toEqual([
      "hello",
      "msg A\n\n<stored>",
      "msg C rewritten\n\n<stored>",
      "msg C rewritten",
    ]);

    // Convergence happens only on a full reload — the same snapshot hydrated
    // into EMPTY state has no live bubbles to mis-pair and yields the correct
    // three. That gap (session shows 4, reload shows 3) is the accepted cost.
    const reloaded = makeWrapper();
    deliver(reloaded, { type: "history", messages: snapshot });
    const fresh = reloaded.getState().messages;
    expect(fresh).toHaveLength(3);
    expect(fresh.map((m) => m.id)).toEqual(["core-u1", "core-a1", "core-a2"]);
    expect(fresh.map((m) => m.text)).toEqual([
      "hello",
      "msg A\n\n<stored>",
      "msg C rewritten\n\n<stored>",
    ]);
  });

  // --- C5(a): one turn_settled must settle EVERY lane of its turn. --------
  it("C5a: a single turn_settled finalizes every working draft sharing its turnId, in place", () => {
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
    expect(messages.map((m) => m.working)).toEqual([false, false, false, true]);
    // Finalization is IN PLACE: ids and texts must survive untouched, so a late
    // frame on any lane still re-matches its bubble instead of duplicating it.
    expect(messages.map((m) => m.id)).toEqual([
      "webchannel-a",
      "webchannel-b",
      "webchannel-c",
      "webchannel-z",
    ]);
    expect(messages.map((m) => m.text)).toEqual([
      "A partial…",
      "B partial…",
      "C partial…",
      "Z partial…",
    ]);
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
  it("C7: snapshot-adopted lanes stay unchanged while fresh fallback and stale ids append independently", () => {
    const w = makeWrapper();

    // Before core's terminal array arrives, both lanes have been materialized
    // by the ordinary lane path. A register snapshot may then replace their live
    // webchannel ids with the transcript's canonical ids. The client does not
    // retain aliases for those old ids.
    w.send("hello"); // u-0 local echo supplies the positional-adoption anchor
    liveBubble(w, "webchannel-a", "T", "A partial…", "A streamed");
    liveBubble(w, "webchannel-b", "T", "B partial…", "B streamed");
    deliver(w, {
      type: "history",
      messages: [
        { id: "core-u1", role: "user", text: "hello", ts: 1 },
        { id: "core-a1", role: "agent", text: "A retained canonical", ts: 2 },
        { id: "core-a2", role: "agent", text: "B retained canonical", ts: 3 },
      ],
    });
    expect(w.getState().messages.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-a2",
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
      "core-u1",
      "core-a1",
      "core-a2",
      "webchannel-error",
      "webchannel-fallback-a1",
      "webchannel-fallback-a2",
      "webchannel-fallback-b",
    ]);
    expect(messages.map((m) => m.text)).toEqual([
      "hello",
      "A retained canonical",
      "B retained canonical",
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

    // Cost/ban ledger: deliberately inject an old-id upsert. Since history
    // adoption forgot the alias, it appends another bubble. This proves why an
    // uncorrelated final must use a fresh id rather than guessing an old lane;
    // it does NOT claim that the fresh fallback avoids semantic duplicates.
    deliver(w, {
      type: "agent_message",
      id: "webchannel-a",
      turnId: "T",
      text: "A stale old-id upsert",
    });
    expect(w.getState().messages.map((m) => m.id)).toEqual([
      "core-u1",
      "core-a1",
      "core-a2",
      "webchannel-error",
      "webchannel-fallback-a1",
      "webchannel-fallback-a2",
      "webchannel-fallback-b",
      "webchannel-a",
    ]);
    expect(w.getState().messages.at(-1)?.text).toBe("A stale old-id upsert");
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
    // payload that can replace it. turn_settled therefore exposes the exact
    // two-bubble [ghost P, F] cost that successful P-claiming prevents.
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
      "webchannel-preview",
      "webchannel-fallback-a",
    ]);
    expect(blockOnlyFresh.getState().messages.map((m) => m.text)).toEqual([
      "Working…",
      "A authorized block",
    ]);
    expect(blockOnlyFresh.getState().messages.map((m) => m.working)).toEqual([false, false]);

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

  it("keeps reasoning separate, correlated, replaceable, and bounded", () => {
    const wrapper = makeWrapper();
    for (let i = 0; i < 105; i++) {
      deliver(wrapper, { type: "reasoning", id: `r${i}`, turnId: `t${i}`, text: `text${i}` });
    }
    expect(wrapper.getState().reasoning).toHaveLength(100);
    expect(wrapper.getState().reasoning[0].id).toBe("r5");
    deliver(wrapper, { type: "reasoning", id: "r104", turnId: "t104", text: "updated" });
    expect(wrapper.getState().reasoning.at(-1)?.text).toBe("updated");
    expect(wrapper.getState().messages).toEqual([]);
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

  // 12. tier-3 transparency: a held chip between the anchor and the reply is skipped by the probe.
  it("12: the tier-3 positional probe skips a held chip and adopts onto the reply (no duplicate agent bubble)", () => {
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

    // Snapshot [u2row, A1row] with RAW stored text ≠ live A1 text.
    deliver(w, {
      type: "history",
      messages: [
        { id: "core-u2", role: "user", text: "u2" },
        { id: "core-a1", role: "agent", text: "A1 raw stored" },
      ],
    });

    // A1row adopts onto A1 THROUGH the held chip — no duplicate agent bubble.
    expect(messages(w)).toHaveLength(4);
    expect(messages(w).find((m) => m.id === "core-a1")?.text).toBe("A1 raw stored");
    expect(messages(w).filter((m) => m.role === "agent")).toHaveLength(2); // A1(adopted)+A2
    expect(pendingBubbles(w)).toHaveLength(1); // h3 still held
  });

  // 12b. post-release snapshot: a released chip (moved to tail) is an ordinary in-order send.
  it("12b: after release (moved to tail), a snapshot adopts cleanly with no duplicates or mis-adoption", () => {
    const w = makeWrapper();
    goOnline(w);
    w.send("u2");
    deliver(w, { type: "typing" });
    w.send("h3"); // held
    deliver(w, { type: "agent_message", id: "webchannel-A", text: "A reply", turnId: "T" });
    // Reply settled the turn → h3 released and MOVED TO THE TAIL: [u2, A, h3].
    expect(messages(w).map((m) => m.text)).toEqual(["u2", "A reply", "h3"]);
    expect(pendingBubbles(w)).toHaveLength(0);

    // Snapshot carries the whole transcript in order, plus a newer reply R.
    deliver(w, {
      type: "history",
      messages: [
        { id: "core-u2", role: "user", text: "u2" },
        { id: "core-A", role: "agent", text: "A raw stored" },
        { id: "core-h3", role: "user", text: "h3" },
        { id: "core-R", role: "agent", text: "R reply" },
      ],
    });
    expect(messages(w).map((m) => m.id)).toEqual(["core-u2", "core-A", "core-h3", "core-R"]);
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

    // A routine mid-run snapshot (core appends assistant rows per message_end).
    deliver(w, {
      type: "history",
      messages: [
        { id: "core-u", role: "user", text: "earlier" },
        { id: "core-mid", role: "agent", text: "intermediate assistant row" },
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
      }
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
      },
    );
  });

  // 15. turn_settled with matching turnId finalizes a lingering draft.
  it("15: turn_settled finalizes a lingering working draft whose turnId matches", () => {
    const w = makeWrapper();
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    expect(messages(w)[0].working).toBe(true);
    deliver(w, { type: "turn_settled", turnId: "T" });
    expect(messages(w)[0].working).toBe(false); // finalized in place
    expect(messages(w)[0].id).toBe("webchannel-d");
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

  // 18. Fix B1: explicit /stop finalizes a live working draft in place, unwedging
  //     the composer even with no disconnect (socket-alive agent death).
  it("18: explicit /stop finalizes a live working draft in place and unlocks the composer", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");

    // A working draft is live (its final frame is about to be lost — no settle).
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(true);

    // Explicit /stop: published immediately AND finalizes the draft in place.
    w.send("/stop");
    expect(spy).toHaveBeenCalledWith("/stop", expect.any(String));
    const draft = messages(w).find((m) => m.id === "webchannel-d")!;
    expect(draft.working).toBe(false); // flipped in place
    expect(draft.id).toBe("webchannel-d"); // id untouched
    expect(draft.text).toBe("partial…"); // text untouched

    // The wedge is unlocked: a subsequent send publishes IMMEDIATELY (not held).
    spy.mockClear();
    w.send("next");
    expect(spy).toHaveBeenCalledWith("next", expect.any(String));
    expect(pendingBubbles(w)).toHaveLength(0);
    expect(held(w)).toHaveLength(0);
  });

  // 18b. Fix B1 self-heal: a post-/stop progress on the same draft id re-flips it
  //      working (the turn was actually alive), with no duplicate bubble.
  it("18b: a post-/stop progress re-flips the same draft working (self-heal, no duplicate)", () => {
    const w = makeWrapper();
    goOnline(w);
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    w.send("/stop");
    expect(messages(w).find((m) => m.id === "webchannel-d")?.working).toBe(false);

    deliver(w, { type: "progress", id: "webchannel-d", text: "back alive…", turnId: "T" });
    const drafts = messages(w).filter((m) => m.id === "webchannel-d");
    expect(drafts).toHaveLength(1); // no duplicate bubble
    expect(drafts[0].working).toBe(true); // re-engaged
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
