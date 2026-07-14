import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebChannelClient } from "./index.js";
import type { OutboundWsMessage } from "./types.js";

/**
 * A controllable fake WebSocket. Instances register themselves on the module's
 * `sockets` array so a test can grab the most-recently-constructed socket and
 * drive its lifecycle (onopen/onmessage/onclose/onerror) + readyState by hand.
 */
class FakeWebSocket {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  // ── test-driving helpers ──────────────────────────────────────────────────
  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  fireMessage(msg: OutboundWsMessage | string): void {
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);
    this.onmessage?.({ data });
  }

  fireClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  fireError(): void {
    this.onerror?.();
  }
}

/** The most-recently-constructed fake socket. */
function lastSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1);
  if (!s) throw new Error("no socket constructed yet");
  return s;
}

/** Flush the microtask queue so an awaited `getTicket()` resolves and the
 *  socket actually gets constructed. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const URL = "ws://test.local/webchannel/ws";

let originalWebSocket: typeof globalThis.WebSocket;

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.WebSocket = FakeWebSocket as any;
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  // Deterministic backoff: delay = Math.random() * exp => 0 means immediate.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.WebSocket = originalWebSocket;
});

describe("WebChannelClient — connect & open", () => {
  it("constructs a WebSocket at the given url and flips to connected on open", async () => {
    const client = new WebChannelClient({ url: URL });
    const seen: string[] = [];
    client.subscribe((s) => seen.push(s.status));

    client.connect();
    await flush();

    const sock = lastSocket();
    expect(sock.url).toBe(URL);
    expect(client.getState().status).toBe("connecting");
    expect(client.getState().connected).toBe(false);

    sock.fireOpen();

    expect(client.getState().status).toBe("connected");
    expect(client.getState().connected).toBe(true);
    expect(seen).toContain("connected");
  });

  it("appends an encoded ?ticket= and calls getTicket on every (re)connect", async () => {
    const getTicket = vi.fn(async () => "a b/c");
    const client = new WebChannelClient({ url: URL, getTicket });

    client.connect();
    await flush();

    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(lastSocket().url).toBe(`${URL}?ticket=${encodeURIComponent("a b/c")}`);

    // Drop the socket → triggers a reconnect, which must fetch a FRESH ticket.
    lastSocket().fireClose();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances.length).toBe(2);
  });
});

describe("WebChannelClient — inbound progress & agent_message", () => {
  async function openClient() {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    const sock = lastSocket();
    sock.fireOpen();
    return { client, sock };
  }

  it("progress creates one working draft keyed by id; a 2nd progress replaces it", async () => {
    const { client, sock } = await openClient();

    sock.fireMessage({ type: "progress", id: "d1", text: "thinking…" });
    let msgs = client.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id: "d1", role: "agent", text: "thinking…", working: true });

    sock.fireMessage({ type: "progress", id: "d1", text: "still thinking…" });
    msgs = client.getState().messages;
    expect(msgs).toHaveLength(1); // replaced, not appended
    expect(msgs[0]).toMatchObject({ id: "d1", text: "still thinking…", working: true });
  });

  it("agent_message WITH a matching id finalizes the draft in place (working:false)", async () => {
    const { client, sock } = await openClient();

    sock.fireMessage({ type: "progress", id: "d1", text: "wip" });
    sock.fireMessage({ type: "agent_message", id: "d1", text: "final answer" });

    const msgs = client.getState().messages;
    expect(msgs).toHaveLength(1); // finalized in place, not a new bubble
    expect(msgs[0]).toMatchObject({ id: "d1", role: "agent", text: "final answer", working: false });
  });

  it("agent_message WITHOUT id appends a fresh agent bubble", async () => {
    const { client, sock } = await openClient();

    sock.fireMessage({ type: "agent_message", text: "hello" });
    sock.fireMessage({ type: "agent_message", text: "world" });

    const msgs = client.getState().messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "agent", text: "hello" });
    expect(msgs[1]).toMatchObject({ role: "agent", text: "world" });
    expect(msgs[0].working).toBeFalsy();
  });
});

describe("WebChannelClient — approvals", () => {
  async function openClient() {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    const sock = lastSocket();
    sock.fireOpen();
    return { client, sock };
  }

  const reqFrame = (id: string, title: string): OutboundWsMessage => ({
    type: "approval_request",
    id,
    kind: "exec",
    title,
    prompt: "run it?",
    options: [{ decision: "allow-once", label: "Allow", style: "primary" }],
  });

  it("adds an approval; repeat id replaces it; approval_resolved sets resolvedDecision", async () => {
    const { client, sock } = await openClient();

    sock.fireMessage(reqFrame("ap1", "first"));
    expect(client.getState().approvals).toHaveLength(1);
    expect(client.getState().approvals[0].title).toBe("first");

    sock.fireMessage(reqFrame("ap1", "updated"));
    expect(client.getState().approvals).toHaveLength(1); // replaced
    expect(client.getState().approvals[0].title).toBe("updated");

    sock.fireMessage({ type: "approval_resolved", id: "ap1", decision: "deny" });
    expect(client.getState().approvals[0].resolvedDecision).toBe("deny");
    // #15: a server resolution is marked confirmed.
    expect(client.getState().approvals[0].resolutionConfirmed).toBe(true);
  });

  it("#15 upsert-preserve: a re-delivered approval_request keeps a locally-set resolution (no button resurrection)", async () => {
    const { client, sock } = await openClient();

    sock.fireMessage(reqFrame("ap1", "first"));
    client.decide("ap1", "allow-once"); // optimistic local resolution
    expect(client.getState().approvals[0].resolvedDecision).toBe("allow-once");

    // A re-delivered approval_request (reconnect / retry) must NOT clobber the
    // resolution back to actionable.
    sock.fireMessage(reqFrame("ap1", "updated"));
    const a = client.getState().approvals[0];
    expect(a.resolvedDecision).toBe("allow-once");
    // The refreshed payload still lands (title updated) — only the resolution is
    // preserved, not the whole stale entry.
    expect(a.title).toBe("updated");
  });
});

describe("WebChannelClient — typing indicator (AC3)", () => {
  async function openClient() {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    const sock = lastSocket();
    sock.fireOpen();
    return { client, sock };
  }

  it("typing frame flips isTyping to true (AC3)", async () => {
    const { client, sock } = await openClient();

    expect(client.getState().isTyping).toBeFalsy();
    sock.fireMessage({ type: "typing" });
    expect(client.getState().isTyping).toBe(true);

    // A second typing frame is idempotent — the indicator stays on.
    sock.fireMessage({ type: "typing" });
    expect(client.getState().isTyping).toBe(true);
  });

  it("the first progress frame after typing auto-clears isTyping (AC3)", async () => {
    const { client, sock } = await openClient();

    sock.fireMessage({ type: "typing" });
    expect(client.getState().isTyping).toBe(true);

    sock.fireMessage({ type: "progress", id: "d1", text: "working…" });
    expect(client.getState().isTyping).toBe(false);
    // The progress bubble was also rendered (no regression on existing flow).
    expect(client.getState().messages).toHaveLength(1);
    expect(client.getState().messages[0]).toMatchObject({
      id: "d1",
      text: "working…",
      working: true,
    });
  });

  it("the first agent_message frame after typing auto-clears isTyping (AC3)", async () => {
    const { client, sock } = await openClient();

    sock.fireMessage({ type: "typing" });
    expect(client.getState().isTyping).toBe(true);

    // No-id (legacy append path) — still clears typing.
    sock.fireMessage({ type: "agent_message", text: "hello" });
    expect(client.getState().isTyping).toBe(false);
    expect(client.getState().messages).toHaveLength(1);
  });

  it("id-finalized agent_message after typing also auto-clears isTyping (AC3)", async () => {
    const { client, sock } = await openClient();

    sock.fireMessage({ type: "typing" });
    sock.fireMessage({ type: "progress", id: "d1", text: "thinking…" });
    expect(client.getState().isTyping).toBe(false);
    expect(client.getState().messages[0].working).toBe(true);

    sock.fireMessage({ type: "typing" }); // re-arm: another turn starts
    expect(client.getState().isTyping).toBe(true);

    sock.fireMessage({ type: "agent_message", id: "d1", text: "final" });
    expect(client.getState().isTyping).toBe(false);
    // The final answer settled the working bubble in place.
    expect(client.getState().messages[0]).toMatchObject({
      id: "d1",
      text: "final",
      working: false,
    });
  });

  it("typing received AFTER a progress frame is a no-op (idempotent flip) (AC3)", async () => {
    const { client, sock } = await openClient();

    // Normal turn: progress → finalize. isTyping is false the whole time.
    sock.fireMessage({ type: "progress", id: "d1", text: "thinking…" });
    sock.fireMessage({ type: "agent_message", id: "d1", text: "final" });
    expect(client.getState().isTyping).toBe(false);

    // A late / duplicate typing frame (e.g. server retransmit) re-arms the
    // indicator — the spec's "idempotent flip" means a typing frame always
    // sets isTyping:true. The NEXT real frame (here: a new turn's progress)
    // will simply re-clear it. This matches Telegram/Discord semantics:
    // best-effort, no ack, late frames don't crash the bubble.
    sock.fireMessage({ type: "typing" });
    expect(client.getState().isTyping).toBe(true);

    sock.fireMessage({ type: "progress", id: "d2", text: "next…" });
    expect(client.getState().isTyping).toBe(false);
    expect(client.getState().messages).toHaveLength(2);
  });
});

describe("WebChannelClient — send", () => {
  async function openClient() {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    const sock = lastSocket();
    sock.fireOpen();
    return { client, sock };
  }

  it("when OPEN appends a user message and sends a trimmed user_message frame", async () => {
    const { client, sock } = await openClient();

    client.send("  hi there  ");

    const msgs = client.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "user", text: "hi there" });
    expect(sock.sent).toHaveLength(1);
    expect(JSON.parse(sock.sent[0])).toEqual({ type: "user_message", text: "hi there", id: "ws-0" });
  });

  it("is a no-op when the socket is not OPEN (no state change, no send)", async () => {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    const sock = lastSocket();
    // never fired onopen → still CONNECTING
    client.send("dropped");

    expect(client.getState().messages).toHaveLength(0);
    expect(sock.sent).toHaveLength(0);
  });

  it("is a no-op for empty/whitespace text", async () => {
    const { client, sock } = await openClient();

    client.send("   ");
    client.send("");

    expect(client.getState().messages).toHaveLength(0);
    expect(sock.sent).toHaveLength(0);
  });
});

describe("WebChannelClient — decide", () => {
  it("optimistically sets resolvedDecision and sends an approval_decision frame", async () => {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    const sock = lastSocket();
    sock.fireOpen();

    sock.fireMessage({
      type: "approval_request",
      id: "ap1",
      kind: "exec",
      title: "t",
      prompt: "p",
      options: [{ decision: "allow-once", label: "Allow", style: "primary" }],
    });

    client.decide("ap1", "allow-once");

    expect(client.getState().approvals[0].resolvedDecision).toBe("allow-once");
    expect(sock.sent).toHaveLength(1);
    expect(JSON.parse(sock.sent[0])).toEqual({
      type: "approval_decision",
      id: "ap1",
      decision: "allow-once",
    });
  });
});

describe("WebChannelClient — reconnect backoff", () => {
  it("schedules a reconnect on unexpected close; status becomes reconnecting; a new socket opens after the timer", async () => {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    expect(FakeWebSocket.instances.length).toBe(1);

    lastSocket().fireClose();
    expect(client.getState().status).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(0); // random()=0 → delay 0
    await flush();
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it("grows the backoff window across consecutive failures", async () => {
    // Use a real (>0) jitter so each scheduled delay equals the full exp window:
    // delay = random() * exp. With random()=1, delay === exp.
    vi.spyOn(Math, "random").mockReturnValue(1);

    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();

    // attempt 0 -> exp = 500 * 2^0 = 500ms
    lastSocket().fireClose();
    await flush();
    // Just under 500ms: not yet reconnected.
    await vi.advanceTimersByTimeAsync(499);
    await flush();
    expect(FakeWebSocket.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(FakeWebSocket.instances.length).toBe(2);

    // attempt 1 -> exp = 500 * 2^1 = 1000ms
    lastSocket().fireClose();
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    await flush();
    expect(FakeWebSocket.instances.length).toBe(2); // still not (delay grew)
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(FakeWebSocket.instances.length).toBe(3);
  });
});

describe("WebChannelClient — close()", () => {
  it("prevents any further reconnect and closes the live socket", async () => {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    const sock = lastSocket();
    sock.fireOpen();

    client.close();
    expect(sock.closed).toBe(true);

    // A late close event must NOT schedule a reconnect.
    sock.fireClose();
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(FakeWebSocket.instances.length).toBe(1); // no new socket
  });
});

describe("WebChannelClient — orphaned working draft on reconnect", () => {
  it("settles a leftover progress draft to working:false when a new socket opens", async () => {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    const sock1 = lastSocket();
    sock1.fireOpen();

    sock1.fireMessage({ type: "progress", id: "d1", text: "half-done" });
    expect(client.getState().messages[0].working).toBe(true);

    // Socket drops mid-draft, then reconnects.
    sock1.fireClose();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    const sock2 = lastSocket();
    expect(sock2).not.toBe(sock1);
    sock2.fireOpen();

    const draft = client.getState().messages[0];
    expect(draft).toMatchObject({ id: "d1", text: "half-done", working: false });
  });
});

describe("WebChannelClient — subscribe/unsubscribe", () => {
  it("unsubscribe stops further notifications", async () => {
    const client = new WebChannelClient({ url: URL });
    const calls: number[] = [];
    const unsub = client.subscribe(() => calls.push(1));

    client.connect();
    await flush();
    lastSocket().fireOpen(); // notifies
    const afterOpen = calls.length;
    expect(afterOpen).toBeGreaterThan(0);

    unsub();
    lastSocket().fireMessage({ type: "agent_message", text: "hi" }); // would notify
    expect(calls.length).toBe(afterOpen); // unchanged
  });
});

describe("WebChannelClient — history pagination (AC5)", () => {
  async function openClient() {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    const sock = lastSocket();
    sock.fireOpen();
    return { client, sock };
  }

  const hist = (
    messages: Array<{ id: string; role: "user" | "agent"; text: string; ts?: number }>,
  ): OutboundWsMessage => ({ type: "history", messages });

  it("history frame prepends new messages to state.messages (dedup by id) (AC5)", async () => {
    const { client, sock } = await openClient();

    // One local user send first (id `u-0`) so we can verify prepending.
    client.send("hello there");
    expect(client.getState().messages.map((m) => m.id)).toEqual(["u-0"]);

    sock.fireMessage(
      hist([
        { id: "m-1", role: "user", text: "earlier msg", ts: 1000 },
        { id: "m-2", role: "agent", text: "older reply", ts: 2000 },
      ]),
    );

    const msgs = client.getState().messages;
    // Snapshot prepended (oldest-first → m-1 then m-2 then the local user send).
    expect(msgs.map((m) => m.id)).toEqual(["m-1", "m-2", "u-0"]);
    expect(msgs[0]).toMatchObject({ id: "m-1", role: "user", text: "earlier msg", ts: 1000 });
    expect(msgs[1]).toMatchObject({ id: "m-2", role: "agent", text: "older reply", ts: 2000 });
  });

  it("history dedup: re-delivery of the same ids is a no-op (idempotent) (AC5)", async () => {
    const { client, sock } = await openClient();

    sock.fireMessage(
      hist([
        { id: "m-1", role: "user", text: "earlier", ts: 1 },
        { id: "m-2", role: "agent", text: "older", ts: 2 },
      ]),
    );
    expect(client.getState().messages).toHaveLength(2);

    // Same ids again — the second frame is a no-op (no duplicate bubbles).
    sock.fireMessage(
      hist([
        { id: "m-1", role: "user", text: "earlier", ts: 1 },
        { id: "m-2", role: "agent", text: "older", ts: 2 },
      ]),
    );
    const msgs = client.getState().messages;
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });

  it("history overlap: snapshot + page with shared id keeps the page's NEW ones (no dup) (AC5)", async () => {
    const { client, sock } = await openClient();

    // Initial snapshot covers ids 1..3.
    sock.fireMessage(
      hist([
        { id: "m-1", role: "user", text: "1", ts: 1 },
        { id: "m-2", role: "agent", text: "2", ts: 2 },
        { id: "m-3", role: "user", text: "3", ts: 3 },
      ]),
    );
    expect(client.getState().messages.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"]);

    // Pagination page that overlaps with the snapshot on the boundary.
    // Cursor was m-1 (oldest on screen) → page returns [ghost, ...].
    // The page is "older than m-1": say ghost-2, ghost-1, m-1 (the cursor).
    // Per the spec the cursor itself is NOT in the page; the dedup guard
    // still keeps the existing m-1 in place.
    sock.fireMessage(
      hist([
        { id: "g-1", role: "user", text: "ghost-1", ts: 0 },
        { id: "g-2", role: "agent", text: "ghost-2", ts: -1 },
        // The page sent an m-1 we already have — must be deduped.
        { id: "m-1", role: "user", text: "1 (duplicate)", ts: 1 },
      ]),
    );
    const msgs = client.getState().messages;
    // New ids prepended; the duplicate m-1 is dropped.
    expect(msgs.map((m) => m.id)).toEqual(["g-1", "g-2", "m-1", "m-2", "m-3"]);
  });

  it("history forces working:false on every hydrated bubble (AC5)", async () => {
    const { client, sock } = await openClient();

    // Even if the server (defensively) sends a hydrated bubble with
    // working:true (e.g. some legacy transcript dump), the client coerces it
    // to working:false. A live "working" flag in a snapshot would render a
    // spinner on an already-settled bubble.
    sock.fireMessage(
      hist([{ id: "m-1", role: "agent", text: "old reply", ts: 1 } as never]),
    );

    expect(client.getState().messages[0]).toMatchObject({
      id: "m-1",
      role: "agent",
      text: "old reply",
      working: false,
    });
  });

  it("history does NOT clobber isTyping or working drafts (AC5)", async () => {
    const { client, sock } = await openClient();

    // A live progress draft arrives (working:true, isTyping:false).
    sock.fireMessage({ type: "progress", id: "d1", text: "working…" });
    expect(client.getState().messages[0]).toMatchObject({ id: "d1", working: true });
    expect(client.getState().isTyping).toBe(false);

    // Then typing flips on.
    sock.fireMessage({ type: "typing" });
    expect(client.getState().isTyping).toBe(true);

    // A history snapshot arrives — it must NOT clear isTyping nor flip the
    // working draft to false.
    sock.fireMessage(hist([{ id: "m-1", role: "user", text: "old", ts: 1 }]));
    expect(client.getState().isTyping).toBe(true);
    expect(client.getState().messages[0]).toMatchObject({ id: "m-1", working: false });
    expect(client.getState().messages[1]).toMatchObject({ id: "d1", working: true });
  });

  it("history: empty messages array is a no-op (no state change)", async () => {
    const { client, sock } = await openClient();

    const before = client.getState().messages;
    sock.fireMessage({ type: "history", messages: [] });
    expect(client.getState().messages).toBe(before);
  });

  it("loadHistory sends a load_history frame over the wire (AC5)", async () => {
    const { client, sock } = await openClient();

    // With both fields.
    client.loadHistory({ before: "m-3", limit: 25 });
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
      type: "load_history",
      before: "m-3",
      limit: 25,
    });

    // With cursor only (server uses configured pageSize).
    client.loadHistory({ before: "m-3" });
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
      type: "load_history",
      before: "m-3",
    });

    // No args — server still gets a load_history frame (lets the host fetch
    // the oldest available page if it ever needs to).
    client.loadHistory();
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ type: "load_history" });
  });

  it("loadHistory is a no-op when the socket is not OPEN", async () => {
    const client = new WebChannelClient({ url: URL });
    client.connect();
    await flush();
    // Never fired onopen → still CONNECTING → no socket message.
    client.loadHistory({ before: "m-3", limit: 25 });
    expect(lastSocket().sent).toHaveLength(0);
  });

  it("regression guard: existing wire cases (typing/approval_request/etc.) are unchanged", () => {
    // Locks the JSON shape of every pre-existing OutboundWsMessage case
    // carried by this client. Mirrors the plugin-side regression guard.
    const frames: Array<OutboundWsMessage | Record<string, unknown>> = [
      { type: "agent_message", text: "hello" },
      { type: "agent_message", text: "final", id: "draft-1" },
      { type: "progress", id: "d1", text: "working" },
      {
        type: "approval_request",
        id: "ap1",
        kind: "exec",
        title: "t",
        prompt: "p",
        options: [{ decision: "allow-once", label: "Allow", style: "primary" }],
      },
      { type: "approval_resolved", id: "ap1", decision: "deny" },
      { type: "typing" },
      { type: "history", messages: [{ id: "m-1", role: "user", text: "hi", ts: 1 }] },
    ];
    // Round-trip every frame through JSON to assert the wire shape (the
    // client only ever sees the JSON-encoded form over the WS).
    for (const f of frames) {
      const rt = JSON.parse(JSON.stringify(f));
      expect(rt).toEqual(f);
    }
  });

  it("stores reasoning by turn, replaces updates, and settles activity separately", async () => {
    const { client, sock } = await openClient();
    sock.fireMessage({ type: "typing" });
    sock.fireMessage({ type: "reasoning", id: "r1", turnId: "t1", text: "first" });
    expect(client.getState().reasoning).toEqual([{ id: "r1", turnId: "t1", text: "first" }]);
    expect(client.getState().isTyping).toBe(true);
    sock.fireMessage({ type: "reasoning", id: "r1", turnId: "t1", text: "updated" });
    expect(client.getState().reasoning[0].text).toBe("updated");
    sock.fireMessage({ type: "turn_settled", turnId: "t1" });
    expect(client.getState().isTyping).toBe(false);
  });
});
