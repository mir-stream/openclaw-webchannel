import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import type { InboundMessage, NatsClientOptions } from "./nats-client.js";

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

  it("a later successful reconnect clears error + errorCause", () => {
    const w = makeWrapper();
    emitError(w, new Error("boom"), "secure-channel-failed");
    expect(w.getState().errorCause).toBe("secure-channel-failed");
    // The register-failure sites don't set the raw client's terminal flag, so an
    // embedder can reconnect the SAME instance; a connected event clears the stale
    // reason. (The sticky guard only blocks a connected:false event from the error
    // status; a connected:true is a genuine recovery.)
    emitState(w, true);
    const s = w.getState();
    expect(s.status).toBe("connected");
    expect(s.error).toBeUndefined();
    expect(s.errorCause).toBeUndefined();
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
// P0-7b delivery acks — send() stamps the local echo with the wire id, and an
// `ack` frame marks the matching bubble delivered (state-only).
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-7b delivery acks", () => {
  function makeWrapper(): WebChannelNATSClient {
    return new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
    });
  }
  function deliver(wrapper: WebChannelNATSClient, frame: InboundMessage): void {
    (wrapper as unknown as { handleMessage: (m: InboundMessage) => void }).handleMessage(frame);
  }

  it("send() stores the wire id on the local echo", () => {
    const w = makeWrapper();
    w.send("hello");
    const m = w.getState().messages[0];
    expect(typeof m.wireId).toBe("string");
    expect(m.wireId).toBeTruthy();
    expect(m.delivered).toBeUndefined(); // not yet acked
  });

  it("an ack frame marks the matching bubble delivered and leaves others untouched", () => {
    const w = makeWrapper();
    w.send("first");
    w.send("second");
    const [m1, m2] = w.getState().messages;

    deliver(w, { type: "ack", ids: [m1.wireId!] });
    const after = w.getState().messages;
    expect(after.find((m) => m.id === m1.id)?.delivered).toBe(true);
    expect(after.find((m) => m.id === m2.id)?.delivered).toBeUndefined(); // unrelated
  });

  it("an ack with no matching wireId is a state no-op", () => {
    const w = makeWrapper();
    w.send("only");
    const before = w.getState();
    deliver(w, { type: "ack", ids: ["not-a-wire-id"] });
    expect(w.getState()).toBe(before); // no setState fired
  });

  it("an empty ack is a no-op", () => {
    const w = makeWrapper();
    w.send("only");
    const before = w.getState();
    deliver(w, { type: "ack", ids: [] });
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
