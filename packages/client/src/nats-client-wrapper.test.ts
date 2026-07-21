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
    expect(wrapper.getState().status).toBe("connected");

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
    emitProtocol(wrapper, { protocolVersion: 1, pluginVersion: "0.1.8" });
    const state = wrapper.getState();
    expect(state.agentProtocolVersion).toBe(1);
    expect(state.agentPluginVersion).toBe("0.1.8");
  });

  it("a pre-v1 plugin (null versions) keeps state null without error", () => {
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
 * Wrap K the AGENT's way (F2 static-static): ECDH(agentIdentity.private,
 * device.public) → HKDF "webchannel-key-wrap-v1" → chacha20-poly1305 sealing K
 * with AAD = UTF-8(peerId). Mirrors packages/plugin/src/late-join-decryptor.ts,
 * independent of the browser unwrap under test.
 */
function wrapLikeAgent(
  conversationKey: Uint8Array,
  devicePublicKeyRaw: Uint8Array,
  agentIdentity: { privatePem: string; publicRaw: Uint8Array },
  peerId: string,
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
  cipher.setAAD(Buffer.from(peerId, "utf8"), { plaintextLength: conversationKey.length });
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
  wrapped: () => WrappedConversationKey,
  gate?: Promise<void>,
): RegHandler {
  const reg = registerSubject(tenant, accountId, peerId);
  return async (subject, payload, server, replyTo) => {
    if (subject !== reg || !replyTo) return;
    const body = JSON.parse(payload) as { op?: string };
    if (body.op === "challenge") {
      server.deliverToClient(replyTo, JSON.stringify({ nonce: "nonce-abc" }));
      return;
    }
    if (body.op === "register") {
      if (gate) await gate;
      server.deliverToClient(
        replyTo,
        JSON.stringify({ peerId, registered: true, wrappedConversationKey: wrapped() }),
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
  const lastWs = () => FakeRegisterWS.instances[FakeRegisterWS.instances.length - 1];
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
   * let the onSession-driven release settle. The caller sets `lastWs().handler`
   * after connect (and, for the delayed-key test, gates the register reply).
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

  // 8. NL "stop"/"wait"/"Stop." mid-turn → bypass: published immediately, held untouched.
  it("8: NL abort words bypass the hold (publish immediately) and DO NOT touch held messages", () => {
    for (const word of ["stop", "wait", "Stop."]) {
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
    w.connect();
    lastWs().handler = makeRegisterHandler(
      "t", "a", "p",
      () => wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, "p"),
      gate,
    );
    await waitFor(() => w.getState().connected);
    await tick(); // let the (gated) register round-trip reach its held reply
    expect(w.getState().connected).toBe(true);
    expect(keyState(w).sessionKey).toBeFalsy(); // connected but keyless → still held
    expect(spy).not.toHaveBeenCalled();
    expect(heldTexts(w)).toEqual(["M"]);

    // Key arrives → onSession fires (after flushQueue) → release.
    releaseRegister();
    await establishKey(w);
    expect(spy).toHaveBeenCalledWith("M", expect.any(String));
    w.close();
  });

  // 10b. ledger order: an undelivered P0-7b ledger entry M1 replays BEFORE a released hold M2
  //      (drain→flush→notify — the onSession release is ordered behind the ledger replay).
  it("10b: on reconnect a ledgered M1 replays on the wire BEFORE a released hold M2", async () => {
    const { registration, deviceKP, agentId, K } = await realRegistration();
    const w = makeWrapper(registration);
    w.connect();
    lastWs().handler = makeRegisterHandler(
      "t", "a", "p",
      () => wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, "p"),
    );
    await establishKey(w); // session 1

    // Spy records how many `.in` publishes exist AT THE MOMENT sendUserMessage runs.
    const counts: number[] = [];
    const c = inner(w);
    const realSUM = c.sendUserMessage.bind(c);
    vi.spyOn(c, "sendUserMessage").mockImplementation((text: string) => {
      counts.push(inboundPubs(lastWs()).length);
      return realSUM(text);
    });

    w.send("M1"); // sealed publish + recorded in the P0-7b unacked ledger
    deliver(w, { type: "typing" }); // start a turn so the next send holds
    w.send("M2"); // held
    expect(inboundPubs(lastWs())).toHaveLength(1); // only M1 on the wire so far

    // Session drop that KEEPS the unacked ledger (resetSession keeps it), then
    // reconnect on the same socket → onConnected re-runs register + key delivery.
    const ll = lowLevel(w);
    ll.connected = false;
    ll.notifyStateListeners();
    ll.connected = true;
    ll.notifyStateListeners();
    await establishKey(w); // session 2: flushQueue replays M1, THEN onSession releases M2

    // Wire: [M1 (initial), M1 (ledger replay), M2 (released hold)] — three publishes.
    expect(inboundPubs(lastWs())).toHaveLength(3);
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

  // 18c. Fix B1 scope: an NL abort word ("wait") must NOT finalize a working draft.
  it("18c: an NL abort word does not finalize a live working draft (only explicit /stop does)", () => {
    const w = makeWrapper();
    goOnline(w);
    const spy = vi.spyOn(inner(w), "sendUserMessage");
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });

    w.send("wait"); // NL abort → bypasses the hold, published, but NO finalize
    expect(spy).toHaveBeenCalledWith("wait", expect.any(String));
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
