import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClawChannelClient } from "./index.js";
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

const URL = "ws://test.local/clawchannel/ws";

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

describe("ClawChannelClient — connect & open", () => {
  it("constructs a WebSocket at the given url and flips to connected on open", async () => {
    const client = new ClawChannelClient({ url: URL });
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
    const client = new ClawChannelClient({ url: URL, getTicket });

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

describe("ClawChannelClient — inbound progress & agent_message", () => {
  async function openClient() {
    const client = new ClawChannelClient({ url: URL });
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

describe("ClawChannelClient — approvals", () => {
  async function openClient() {
    const client = new ClawChannelClient({ url: URL });
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
  });
});

describe("ClawChannelClient — send", () => {
  async function openClient() {
    const client = new ClawChannelClient({ url: URL });
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
    expect(JSON.parse(sock.sent[0])).toEqual({ type: "user_message", text: "hi there" });
  });

  it("is a no-op when the socket is not OPEN (no state change, no send)", async () => {
    const client = new ClawChannelClient({ url: URL });
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

describe("ClawChannelClient — decide", () => {
  it("optimistically sets resolvedDecision and sends an approval_decision frame", async () => {
    const client = new ClawChannelClient({ url: URL });
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

describe("ClawChannelClient — reconnect backoff", () => {
  it("schedules a reconnect on unexpected close; status becomes reconnecting; a new socket opens after the timer", async () => {
    const client = new ClawChannelClient({ url: URL });
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

    const client = new ClawChannelClient({ url: URL });
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

describe("ClawChannelClient — close()", () => {
  it("prevents any further reconnect and closes the live socket", async () => {
    const client = new ClawChannelClient({ url: URL });
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

describe("ClawChannelClient — orphaned working draft on reconnect", () => {
  it("settles a leftover progress draft to working:false when a new socket opens", async () => {
    const client = new ClawChannelClient({ url: URL });
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

describe("ClawChannelClient — subscribe/unsubscribe", () => {
  it("unsubscribe stops further notifications", async () => {
    const client = new ClawChannelClient({ url: URL });
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
