import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BUFFERED_BYTES, MAX_CONTROL_LINE, MAX_PAYLOAD, NatsClient } from "./nats-client.js";

class FakeWS {
  static instances: FakeWS[] = []; static readonly OPEN = 1; static readonly CONNECTING = 0;
  readyState = 0; binaryType = "blob"; sent: string[] = []; closed = false;
  onopen: (() => void) | null = null; onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null; onclose: (() => void) | null = null;
  constructor(public url: string) { FakeWS.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  frame(data: string | Uint8Array): void {
    if (typeof data === "string") { this.onmessage?.({ data }); return; }
    // Copy into a freshly-constructed ArrayBuffer: `data.buffer` is typed
    // ArrayBufferLike (may be SharedArrayBuffer) under the TS ≥5.7 typed-array
    // generics that packages/client resolves on fresh installs.
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    this.onmessage?.({ data: buf });
  }
}
let original: unknown;
beforeEach(() => { original = globalThis.WebSocket; (globalThis as any).WebSocket = FakeWS; FakeWS.instances = []; });
afterEach(() => { (globalThis as any).WebSocket = original; vi.useRealTimers(); });
const make = (extra = {}) => new NatsClient({ url: "ws://fake", accountId: "a", tenant: "t", peerId: "p", heartbeatIntervalMs: 0, connectTimeoutMs: 0, ...extra });
const establish = (ws: FakeWS) => { ws.open(); ws.frame("PONG\r\n"); };
const credentials = { userJwt: "jwt", userSeedRaw: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url") };

describe("P1-3 browser transport invariants", () => {
  it("stops a packed terminal -ERR before delivering a following MSG", () => {
    const c = make(); const got: string[] = []; c.onRawMessage((_s, p) => got.push(p)); c.connect(); const ws = FakeWS.instances[0]!; establish(ws);
    ws.frame("-ERR 'Authorization Violation'\r\nMSG s 1 1\r\nX\r\n");
    expect(got).toEqual([]); expect(ws.closed).toBe(true); c.disconnect();
  });
  it("decodes completed split multibyte payloads and multiple MSG units", () => {
    const c = make(); const got: string[] = []; c.onRawMessage((_s, p) => got.push(p)); c.connect(); const ws = FakeWS.instances[0]!; establish(ws);
    const bytes = new TextEncoder().encode("한😀"); const frame = new Uint8Array(new TextEncoder().encode(`MSG s 1 ${bytes.length}\r\n`).length + bytes.length + 2);
    const h = new TextEncoder().encode(`MSG s 1 ${bytes.length}\r\n`); frame.set(h); frame.set(bytes, h.length); frame.set([13, 10], h.length + bytes.length);
    ws.frame(frame.slice(0, h.length + 1)); ws.frame(frame.slice(h.length + 1)); ws.frame("MSG s 1 1\r\nA\r\nMSG s 1 1\r\nB\r\n");
    expect(got).toEqual(["한😀", "A", "B"]); c.disconnect();
  });

  it("abandons a packed frame when a raw listener disconnects the owning dial", () => {
    const c = make(); const got: string[] = [];
    c.onRawMessage((_s, payload) => { got.push(payload); if (payload === "A") c.disconnect(); });
    c.connect(); const ws = FakeWS.instances[0]!; establish(ws);
    ws.frame("MSG s 1 1\r\nA\r\nMSG s 1 1\r\nB\r\nPING\r\n");
    expect(got).toEqual(["A"]); expect(ws.sent).not.toContain("PONG\r\n");
  });

  it("abandons a packed frame when the connected listener disconnects the owning dial", () => {
    vi.useFakeTimers(); const c = make({ heartbeatIntervalMs: 10 });
    c.onState((connected) => { if (connected) c.disconnect(); });
    c.connect(); const ws = FakeWS.instances[0]!; ws.open(); ws.frame("PONG\r\nPING\r\n");
    expect(ws.sent).not.toContain("PONG\r\n"); expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the raw-listener fan-out when an earlier listener retires the dial", () => {
    const c = make(); const seen: string[] = [];
    c.onRawMessage((_s, p) => { seen.push(`L1:${p}`); c.disconnect(); });
    c.onRawMessage((_s, p) => { seen.push(`L2:${p}`); });
    c.connect(); const ws = FakeWS.instances[0]!; establish(ws);
    ws.frame("MSG s 1 1\r\nA\r\n");
    expect(seen).toEqual(["L1:A"]);
  });

  // disconnect() re-notifies state listeners itself, so a later listener is always
  // reached with `false`; without the per-listener currency check the ABORTED outer
  // fan-out reaches it a SECOND time. Assert the exact call log, not a filtered view
  // (filtering on `v` hides the duplicate and makes this test vacuous).
  it("does not double-notify a later state listener when an earlier one retires the dial", () => {
    vi.useFakeTimers(); const c = make({ heartbeatIntervalMs: 10 }); const l2: boolean[] = [];
    c.onState((v) => { if (v) c.disconnect(); });
    c.onState((v) => { l2.push(v); });
    c.connect(); const ws = FakeWS.instances[0]!; ws.open(); ws.frame("PONG\r\n");
    expect(l2).toEqual([false]); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["MSG s 1 -1", "MSG s 1 NaN", "MSG s 1 1junk", "MSG s 1", "MSG s 1 x 1 extra", "MSG  1 1"])("force-reconnects malformed %s", (line) => {
    vi.useFakeTimers(); const c = make({ reconnectBaseMs: 100 }); c.connect(); const ws = FakeWS.instances[0]!; establish(ws); ws.frame(`${line}\r\nX\r\n`); expect(ws.closed).toBe(true); c.disconnect();
  });

  it("enforces all three byte bounds", () => {
    vi.useFakeTimers();
    for (const frame of [`MSG s 1 ${MAX_PAYLOAD + 1}\r\n`, "X".repeat(MAX_CONTROL_LINE + 1), new Uint8Array(MAX_BUFFERED_BYTES + 1)]) {
      const c = make({ reconnectBaseMs: 100 }); c.connect(); const ws = FakeWS.instances.at(-1)!; establish(ws); ws.frame(frame); expect(ws.closed).toBe(true); c.disconnect();
    }
  });

  it("rejects a maximal valid frame plus one byte before parsing it", () => {
    vi.useFakeTimers(); const c = make({ reconnectBaseMs: 100 }); const got: string[] = [];
    c.onRawMessage((_s, payload) => got.push(payload)); c.connect(); const ws = FakeWS.instances[0]!; establish(ws);
    const payload = new Uint8Array(MAX_PAYLOAD).fill(65);
    const suffix = ` 2 ${MAX_PAYLOAD}`, subject = "s".repeat(MAX_CONTROL_LINE - 4 - suffix.length);
    const header = new TextEncoder().encode(`MSG ${subject}${suffix}\r\n`);
    const oversized = new Uint8Array(header.length + payload.length + 3);
    oversized.set(header); oversized.set(payload, header.length); oversized.set([13, 10, 88], header.length + payload.length);
    expect(oversized.length).toBe(MAX_BUFFERED_BYTES + 1); ws.frame(oversized);
    expect(got).toHaveLength(0); expect(ws.closed).toBe(true); c.disconnect();
  });

  it("accepts exact control, payload, and maximal-frame boundaries through reinsertion", () => {
    const c = make(); const got: string[] = []; c.onRawMessage((_s, p) => got.push(p)); c.connect(); const ws = FakeWS.instances[0]!; establish(ws);
    ws.frame(`${"X".repeat(MAX_CONTROL_LINE)}\r\n`); expect(ws.closed).toBe(false);
    const payload = new Uint8Array(MAX_PAYLOAD).fill(65);
    const ordinaryHeader = new TextEncoder().encode(`MSG s 1 ${MAX_PAYLOAD}\r\n`);
    const ordinary = new Uint8Array(ordinaryHeader.length + payload.length + 2); ordinary.set(ordinaryHeader); ordinary.set(payload, ordinaryHeader.length); ordinary.set([13, 10], ordinaryHeader.length + payload.length);
    ws.frame(ordinary); expect(got.at(-1)!.length).toBe(MAX_PAYLOAD);
    const suffix = ` 2 ${MAX_PAYLOAD}`, subject = "s".repeat(MAX_CONTROL_LINE - 4 - suffix.length);
    const header = new TextEncoder().encode(`MSG ${subject}${suffix}\r\n`);
    const maximal = new Uint8Array(header.length + payload.length + 2); maximal.set(header); maximal.set(payload, header.length); maximal.set([13, 10], header.length + payload.length);
    expect(maximal.length).toBe(MAX_BUFFERED_BYTES);
    ws.frame(maximal.slice(0, header.length + 17)); ws.frame(maximal.slice(header.length + 17));
    expect(got.at(-1)!.length).toBe(MAX_PAYLOAD); expect(ws.closed).toBe(false); c.disconnect();
  });

  it("force-reconnects when payload trailing bytes are not CRLF", () => {
    vi.useFakeTimers(); const c = make({ reconnectBaseMs: 100 }); c.connect(); const ws = FakeWS.instances[0]!; establish(ws);
    ws.frame("MSG s 1 1\r\nX!!"); expect(ws.closed).toBe(true); c.disconnect();
  });

  it("does not send a delayed NKEY signature to a replacement socket", async () => {
    vi.useFakeTimers(); let release!: (value: ArrayBuffer) => void;
    const sign = vi.spyOn(crypto.subtle, "sign").mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { release = resolve; }));
    const seed = new Uint8Array(32).fill(7); const c = make({ natsCredentials: { userJwt: "jwt", userSeedRaw: Buffer.from(seed).toString("base64url") }, reconnectBaseMs: 0, reconnectCapMs: 0 });
    c.connect(); const old = FakeWS.instances[0]!; old.open(); old.frame('INFO {"nonce":"old"}\r\n');
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    c.reconnect(); await vi.advanceTimersByTimeAsync(0); const replacement = FakeWS.instances[1]!; replacement.open();
    release(new Uint8Array(64).buffer); await Promise.resolve(); await Promise.resolve();
    expect(replacement.sent.some((frame) => frame.startsWith("CONNECT "))).toBe(false);
    sign.mockRestore(); c.disconnect();
  });

  it("connect deadline forces reconnect, schedules before state notification, and 0 disables", async () => {
    vi.useFakeTimers(); const c = make({ connectTimeoutMs: 10, reconnectBaseMs: 5, reconnectCapMs: 5 });
    let stopped = false; c.onState((connected) => { if (!connected && !stopped) { stopped = true; c.disconnect(); } }); c.connect(); const ws = FakeWS.instances[0]!; ws.open();
    await vi.advanceTimersByTimeAsync(20); expect(ws.closed).toBe(true); expect(FakeWS.instances).toHaveLength(1);
    const disabled = make({ connectTimeoutMs: 0 }); disabled.connect(); FakeWS.instances[1]!.open(); await vi.advanceTimersByTimeAsync(100); expect(FakeWS.instances[1]!.closed).toBe(false); disabled.disconnect();
  });

  it("onclose schedules before a synchronously disconnecting state listener", async () => {
    vi.useFakeTimers(); const c = make({ reconnectBaseMs: 5, reconnectCapMs: 5 }); c.connect(); const ws = FakeWS.instances[0]!; establish(ws);
    let stopped = false; c.onState((connected) => { if (!connected && !stopped) { stopped = true; c.disconnect(); } }); ws.onclose?.(); await vi.advanceTimersByTimeAsync(20); expect(FakeWS.instances).toHaveLength(1);
  });

  it("times out WS-open silence", async () => {
    vi.useFakeTimers(); const c = make({ connectTimeoutMs: 10, reconnectBaseMs: 100 }); c.connect(); const ws = FakeWS.instances[0]!;
    await vi.advanceTimersByTimeAsync(10); expect(ws.closed).toBe(true); c.disconnect();
  });

  it("reports the active phase when a connect deadline expires", async () => {
    vi.useFakeTimers(); const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = make({ connectTimeoutMs: 10, reconnectBaseMs: 100 }); c.connect(); const ws = FakeWS.instances[0]!; ws.open();
    await vi.advanceTimersByTimeAsync(10); expect(warn).toHaveBeenCalledWith(expect.stringContaining("first PONG"));
    warn.mockRestore(); c.disconnect();
  });

  it("times out NKEY INFO silence", async () => {
    vi.useFakeTimers(); const c = make({ connectTimeoutMs: 10, natsCredentials: credentials, reconnectBaseMs: 100 }); c.connect(); const ws = FakeWS.instances[0]!; ws.open();
    await vi.advanceTimersByTimeAsync(10); expect(ws.closed).toBe(true); c.disconnect();
  });

  it("times out a slow NKEY signing phase and closes its owning socket", async () => {
    vi.useFakeTimers(); const sign = vi.spyOn(crypto.subtle, "sign").mockImplementationOnce(() => new Promise<ArrayBuffer>(() => {}));
    const c = make({ connectTimeoutMs: 10, natsCredentials: credentials, reconnectBaseMs: 100 }); c.connect(); const ws = FakeWS.instances[0]!; ws.open(); ws.frame('INFO {"nonce":"n"}\r\n');
    await vi.advanceTimersByTimeAsync(10); expect(ws.closed).toBe(true); sign.mockRestore(); c.disconnect();
  });

  it("times out first-PONG silence after signed CONNECT", async () => {
    vi.useFakeTimers(); const c = make({ connectTimeoutMs: 1_000, natsCredentials: credentials, reconnectBaseMs: 10_000 }); c.connect(); const ws = FakeWS.instances[0]!; ws.open(); ws.frame('INFO {"nonce":"n"}\r\n');
    await vi.waitFor(() => expect(ws.sent.some((x) => x.startsWith("CONNECT "))).toBe(true));
    await vi.advanceTimersByTimeAsync(1_000); expect(ws.closed).toBe(true); c.disconnect();
  });

  it("re-arms client phase progress beyond one timeout budget", async () => {
    vi.useFakeTimers(); let connected = false; const c = make({ connectTimeoutMs: 10_000, natsCredentials: credentials }); c.onState((v) => { connected = v; }); c.connect(); const ws = FakeWS.instances[0]!;
    await vi.advanceTimersByTimeAsync(8_000); ws.open(); await vi.advanceTimersByTimeAsync(8_000); ws.frame('INFO {"nonce":"n"}\r\n');
    await vi.waitFor(() => expect(ws.sent.some((x) => x.startsWith("CONNECT "))).toBe(true)); await vi.advanceTimersByTimeAsync(8_000); ws.frame("PONG\r\n");
    expect(connected).toBe(true); expect(ws.closed).toBe(false); c.disconnect();
  });

  it("connectTimeoutMs 0 creates no deadline and preserves hanging lifecycle", async () => {
    vi.useFakeTimers(); const c = make({ connectTimeoutMs: 0 }); c.connect(); const ws = FakeWS.instances[0]!; ws.open();
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(100_000); expect(ws.closed).toBe(false); c.disconnect();
  });

  it("isolates stale handlers and cleans up only the owning socket", async () => {
    vi.useFakeTimers(); const c = make({ reconnectBaseMs: 0, reconnectCapMs: 0 }); const got: string[] = []; c.onRawMessage((s) => got.push(s)); c.connect();
    const old = FakeWS.instances[0]!; old.open(); const staleHandler = old.onmessage!; c.reconnect(); await vi.advanceTimersByTimeAsync(0); const current = FakeWS.instances[1]!; current.open();
    staleHandler({ data: "MSG stale 1 1\r\nX\r\n" }); current.frame("PONG\r\nMSG live 2 1\r\nY\r\n");
    expect(got).toEqual(["live"]); expect(old.closed).toBe(true); expect(current.closed).toBe(false); c.disconnect();
  });

  it("handles symmetric parser chunking and packed near-limit frames", () => {
    const c = make(); const got: Array<[string, string]> = []; c.onRawMessage((s, p) => got.push([s, p])); c.connect(); const ws = FakeWS.instances[0]!; ws.open();
    const info = new TextEncoder().encode('INFO {"name":"한😀"}\r\nPONG\r\n'); for (const b of info) ws.frame(new Uint8Array([b]));
    for (const cut of [1, 4, 8, 11]) { const f = new TextEncoder().encode("MSG split 1 1\r\nX\r\n"); ws.frame(f.slice(0, cut)); ws.frame(f.slice(cut)); }
    ws.frame("\r\nMSG zero 2 0\r\n\r\n\r\n"); const size = Math.floor((MAX_BUFFERED_BYTES - 100) / 3); const enc = new TextEncoder();
    const units = [0, 1, 2].map((i) => { const h = enc.encode(`MSG packed${i} ${i + 3} ${size}\r\n`); const unit = new Uint8Array(h.length + size + 2); unit.set(h); unit.fill(65 + i, h.length, h.length + size); unit.set([13, 10], h.length + size); return unit; });
    const packed = new Uint8Array(units.reduce((n, u) => n + u.length, 0)); let offset = 0; for (const unit of units) { packed.set(unit, offset); offset += unit.length; }
    expect(packed.length).toBeLessThanOrEqual(MAX_BUFFERED_BYTES); ws.frame(packed);
    expect(got.map(([s]) => s)).toEqual(["split", "split", "split", "split", "zero", "packed0", "packed1", "packed2"]); c.disconnect();
  });

  it("ignores an unsolicited PONG before the signed CONNECT is on the wire", async () => {
    vi.useFakeTimers();
    const sign = vi.spyOn(crypto.subtle, "sign").mockImplementationOnce(() => new Promise<ArrayBuffer>(() => {}));
    const c = make({ connectTimeoutMs: 10, natsCredentials: credentials, reconnectBaseMs: 100 });
    let becameConnected = false; c.onState((v) => { if (v) becameConnected = true; });
    c.connect(); const ws = FakeWS.instances[0]!; ws.open(); ws.frame('INFO {"nonce":"n"}\r\n');
    // Signing is pending → CONNECT is NOT on the wire. An unsolicited PONG must be ignored.
    ws.frame("PONG\r\n");
    expect(becameConnected).toBe(false); expect(ws.closed).toBe(false);
    // The armed "CONNECT signing" deadline still fires — the PONG did not clear it.
    await vi.advanceTimersByTimeAsync(10); expect(ws.closed).toBe(true);
    sign.mockRestore(); c.disconnect();
  });

  it("disconnect clears the active dial deadline timer", () => {
    vi.useFakeTimers();
    const c = make({ connectTimeoutMs: 10_000 }); c.connect();
    expect(vi.getTimerCount()).toBe(1); // the WebSocket-open deadline
    c.disconnect(); expect(vi.getTimerCount()).toBe(0);
  });

  it("forceReconnect clears the old dial deadline, leaving only the reconnect timer", () => {
    vi.useFakeTimers();
    const c = make({ connectTimeoutMs: 10_000, reconnectBaseMs: 100 });
    c.connect(); const ws = FakeWS.instances[0]!; ws.open();
    expect(vi.getTimerCount()).toBe(1); // the "first PONG" dial deadline
    // A parser violation before any PONG forces a reconnect. The old dial's
    // deadline must be cancelled — exactly one timer remains (the reconnect), not two.
    ws.frame("MSG s 1 1\r\nX!!");
    expect(ws.closed).toBe(true); expect(vi.getTimerCount()).toBe(1);
    c.disconnect();
  });

  // Regression: the no-creds path must arm the "first PONG" deadline BEFORE
  // sendConnect(). A WebSocket whose send() answers our PING with a PONG in the
  // SAME synchronous tick establishes the connection and clears the deadline
  // inside sendConnect; if the deadline were armed AFTER (the pre-fix order) a
  // fresh timer would be stranded and force-reconnect the healthy link ~10s later.
  it("does not strand a first-PONG deadline when the server answers PONG in-tick", () => {
    vi.useFakeTimers();
    class SyncPongWS extends FakeWS {
      send(data: string): void {
        super.send(data);
        // Answer PING synchronously, before ws.open()'s onopen handler returns.
        if (data === "PING\r\n") this.frame("PONG\r\n");
      }
    }
    (globalThis as any).WebSocket = SyncPongWS;
    const states: boolean[] = [];
    const c = make({ connectTimeoutMs: 10_000, reconnectBaseMs: 100 });
    c.onState((v) => states.push(v));
    c.connect(); const ws = FakeWS.instances[0]!; ws.open();
    // Established in-tick, and the arm-then-send order let the sync PONG clear
    // the deadline: no timer survives.
    expect(states).toEqual([true]);
    expect(vi.getTimerCount()).toBe(0);
    // Prove it behaviorally: a stranded deadline would fire here and tear down
    // the healthy socket, spawning a reconnect dial.
    vi.advanceTimersByTime(30_000);
    expect(ws.closed).toBe(false);
    expect(FakeWS.instances).toHaveLength(1);
    expect(states).toEqual([true]);
    c.disconnect();
  });
});
