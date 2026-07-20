import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  MAX_BUFFERED_BYTES,
  MAX_CONTROL_LINE,
  MAX_PAYLOAD,
  NatsTransport,
  type NatsMessage,
} from "./nats-transport.js";

class FakeWs {
  readyState: number = WebSocket.CONNECTING;
  sent: Array<string | Buffer> = [];
  closed = false;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();
  on(name: string, fn: (...args: any[]) => void): this {
    const list = this.handlers.get(name) ?? []; list.push(fn); this.handlers.set(name, list); return this;
  }
  send(data: string | Buffer): void { this.sent.push(data); }
  close(): void { if (this.closed) return; this.closed = true; this.readyState = WebSocket.CLOSED; this.fire("close"); }
  open(): void { this.readyState = WebSocket.OPEN; this.fire("open"); }
  frame(data: string | Buffer): void { this.fire("message", data); }
  private fire(name: string, ...args: any[]): void { for (const fn of this.handlers.get(name) ?? []) fn(...args); }
}

function setup(options: Record<string, unknown> = {}) {
  const sockets: FakeWs[] = [];
  const transport = new NatsTransport({
    url: "ws://fake", handshakeTimeoutMs: 0, ...options,
    _wsFactory: () => { const ws = new FakeWs(); sockets.push(ws); return ws as unknown as WebSocket; },
  });
  return { transport, sockets };
}
async function handshake(ws: FakeWs, promise?: Promise<void>): Promise<void> {
  ws.open(); ws.frame("INFO {}\r\nPONG\r\n"); await promise;
}

describe("P1-3 plugin transport invariants", () => {
  it("settles an overlapping dial's own first PONG while already connected", async () => {
    const { transport: t, sockets } = setup({ handshakeTimeoutMs: 10 });
    const first = t.connect(); await handshake(sockets[0]!, first);
    const second = t.connect(); await handshake(sockets[1]!, second);
    expect(t.connected).toBe(true);
    expect(sockets.every((ws) => !ws.closed)).toBe(true);
    t.disconnect();
  });

  it("treats a handshake -ERR as terminal for its packed frame", async () => {
    const { transport: t, sockets } = setup();
    const connecting = t.connect(); sockets[0]!.open();
    sockets[0]!.frame("-ERR 'x'\r\nPONG\r\n");
    await expect(connecting).rejects.toThrow("NATS server error");
    expect(t.connected).toBe(false); expect(sockets[0]!.closed).toBe(true);
  });
  it("replays every stable sid verbatim and unsubscribe removes the replayed sid", async () => {
    vi.useFakeTimers();
    const { transport: t, sockets } = setup({ reconnect: true, reconnectBaseMs: 1 });
    const initial = t.connect(); await handshake(sockets[0]!, initial);
    const a = t.subscribe("same"), b = t.subscribe("same"), c = t.subscribe("other");
    sockets[0]!.close(); await vi.advanceTimersByTimeAsync(1);
    await handshake(sockets[1]!);
    expect(sockets[1]!.sent.filter((x) => typeof x === "string" && x.startsWith("SUB ")))
      .toEqual([`SUB same ${a}\r\n`, `SUB same ${b}\r\n`, `SUB other ${c}\r\n`]);
    t.unsubscribe(b);
    expect(sockets[1]!.sent).toContain(`UNSUB ${b}\r\n`);
    sockets[1]!.close(); await vi.advanceTimersByTimeAsync(1); await handshake(sockets[2]!);
    expect(sockets[2]!.sent).not.toContain(`SUB same ${b}\r\n`);
    t.disconnect(); vi.useRealTimers();
  });

  it("delivers split UTF-8 and binary payloads byte-exactly without parsing injected lines", async () => {
    const { transport: t, sockets } = setup(); const promise = t.connect(); await handshake(sockets[0]!, promise);
    const got: NatsMessage[] = []; t.on("message", (m) => got.push(m));
    const payload = Buffer.concat([Buffer.from("한😀\r\n-ERR nope\r\nMSG fake 9 1\r\n"), Buffer.from([0, 255])]);
    const frame = Buffer.concat([Buffer.from(`MSG s 1 ${payload.length}\r\n`), payload, Buffer.from("\r\n")]);
    sockets[0]!.frame(frame.subarray(0, 17)); sockets[0]!.frame(frame.subarray(17, 21)); sockets[0]!.frame(frame.subarray(21));
    expect(got).toHaveLength(1); expect(got[0]!.payload).toEqual(payload); t.disconnect();
  });

  it.each(["MSG s 1 -1", "MSG s 1 NaN", "MSG s 1 1junk", "MSG s 1", "MSG s 1 x 1 extra", "MSG  1 1"])(
    "closes on malformed header %s", async (line) => {
      const { transport: t, sockets } = setup(); t.on("error", () => {}); const promise = t.connect(); await handshake(sockets[0]!, promise);
      sockets[0]!.frame(`${line}\r\nX\r\n`); expect(sockets[0]!.closed).toBe(true);
    },
  );

  it("enforces payload, control-line and pre-concat total bounds", async () => {
    for (const frame of [
      `MSG s 1 ${MAX_PAYLOAD + 1}\r\n`,
      "X".repeat(MAX_CONTROL_LINE + 1),
      Buffer.alloc(MAX_BUFFERED_BYTES + 1),
    ]) {
      const { transport: t, sockets } = setup(); t.on("error", () => {}); const promise = t.connect(); await handshake(sockets[0]!, promise);
      sockets[0]!.frame(frame); expect(sockets[0]!.closed).toBe(true);
    }
  });

  it("accepts exact control, payload, and maximal-frame boundaries through reinsertion", async () => {
    const { transport: t, sockets } = setup(); const connected = t.connect(); await handshake(sockets[0]!, connected);
    const got: NatsMessage[] = []; t.on("message", (m) => got.push(m));
    sockets[0]!.frame(`${"X".repeat(MAX_CONTROL_LINE)}\r\n`);
    expect(sockets[0]!.closed).toBe(false);

    const payload = Buffer.alloc(MAX_PAYLOAD, 65);
    sockets[0]!.frame(Buffer.concat([Buffer.from(`MSG s 1 ${MAX_PAYLOAD}\r\n`), payload, Buffer.from("\r\n")]));
    expect(got.at(-1)!.payload.length).toBe(MAX_PAYLOAD);

    const suffix = ` 2 ${MAX_PAYLOAD}`;
    const subject = "s".repeat(MAX_CONTROL_LINE - Buffer.byteLength("MSG ") - Buffer.byteLength(suffix));
    const header = Buffer.from(`MSG ${subject}${suffix}\r\n`);
    const maximal = Buffer.concat([header, payload, Buffer.from("\r\n")]);
    expect(maximal.length).toBe(MAX_BUFFERED_BYTES);
    sockets[0]!.frame(maximal.subarray(0, header.length + 17));
    sockets[0]!.frame(maximal.subarray(header.length + 17));
    expect(got.at(-1)!.subject).toBe(subject); expect(got.at(-1)!.payload.length).toBe(MAX_PAYLOAD);
    expect(sockets[0]!.closed).toBe(false); t.disconnect();
  });

  it("closes when a complete payload is not followed by CRLF", async () => {
    const { transport: t, sockets } = setup(); t.on("error", () => {}); const connected = t.connect(); await handshake(sockets[0]!, connected);
    sockets[0]!.frame("MSG s 1 1\r\nX!!"); expect(sockets[0]!.closed).toBe(true);
  });

  it("uses an independent per-phase deadline and stale dial cleans up only itself", async () => {
    vi.useFakeTimers();
    const { transport: t, sockets } = setup({ handshakeTimeoutMs: 10 });
    const first = t.connect(); sockets[0]!.open();
    const firstRejected = expect(first).rejects.toThrow(/phase/);
    await vi.advanceTimersByTimeAsync(5);
    const second = t.connect(); sockets[1]!.open();
    const secondRejected = expect(second).rejects.toThrow(/phase/);
    await vi.advanceTimersByTimeAsync(5);
    await firstRejected; expect(sockets[0]!.closed).toBe(true); expect(sockets[1]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    await secondRejected; expect(sockets[1]!.closed).toBe(true); vi.useRealTimers();
  });

  it("does not let an old close clear a newer dial's armed deadline", async () => {
    vi.useFakeTimers(); const { transport: t, sockets } = setup({ handshakeTimeoutMs: 10 });
    const oldDial = t.connect(); sockets[0]!.open(); const oldRejected = expect(oldDial).rejects.toThrow(/closed before/);
    const newDial = t.connect(); sockets[1]!.open(); const newRejected = expect(newDial).rejects.toThrow(/first PONG/);
    await vi.advanceTimersByTimeAsync(5); sockets[0]!.close(); await oldRejected;
    await vi.advanceTimersByTimeAsync(5); await newRejected; expect(sockets[1]!.closed).toBe(true);
  });

  it("never sends a delayed nonce signature to a replacement socket", async () => {
    let release!: (value: string) => void;
    const signature = new Promise<string>((resolve) => { release = resolve; });
    const { transport: t, sockets } = setup({ jwtCredential: "jwt", nkeySigningCallback: () => signature });
    void t.connect().catch(() => {}); sockets[0]!.open(); sockets[0]!.frame('INFO {"nonce":"old"}\r\n');
    void t.connect().catch(() => {}); sockets[1]!.open(); release("sig"); await Promise.resolve(); await Promise.resolve();
    expect(sockets[1]!.sent.some((x) => typeof x === "string" && x.startsWith("CONNECT "))).toBe(false);
    t.disconnect();
  });

  it("ignores INFO delivered to a stale socket's handler after replacement", async () => {
    const signer = vi.fn((nonce: string) => Promise.resolve(`sig-${nonce}`));
    const { transport: t, sockets } = setup({ jwtCredential: "jwt", nkeySigningCallback: signer });
    void t.connect().catch(() => {}); sockets[0]!.open();
    const newDial = t.connect(); sockets[1]!.open();
    // Stale handler fires AFTER replacement: must not reach the signer, must not
    // contaminate the current dial's parse stream, must not CONNECT anywhere.
    sockets[0]!.frame('INFO {"nonce":"stale"}\r\n');
    await Promise.resolve(); await Promise.resolve();
    expect(signer).not.toHaveBeenCalled();
    expect(sockets[0]!.sent.some((x) => typeof x === "string" && x.startsWith("CONNECT "))).toBe(false);
    expect(sockets[1]!.sent.some((x) => typeof x === "string" && x.startsWith("CONNECT "))).toBe(false);
    // The current dial still completes cleanly on its own INFO/PONG.
    sockets[1]!.frame('INFO {"nonce":"fresh"}\r\n'); await Promise.resolve(); await Promise.resolve();
    sockets[1]!.frame("PONG\r\n"); await newDial;
    expect(signer).toHaveBeenCalledTimes(1); expect(signer).toHaveBeenCalledWith("fresh");
    expect(sockets[1]!.sent.some((x) => typeof x === "string" && x.startsWith("CONNECT "))).toBe(true);
    t.disconnect();
  });

  it("keeps reconnecting after a silent redial times out, then recovers and replays", async () => {
    vi.useFakeTimers();
    const { transport: t, sockets } = setup({ reconnect: true, reconnectBaseMs: 2, reconnectCapMs: 2, handshakeTimeoutMs: 5 });
    const initial = t.connect(); await handshake(sockets[0]!, initial); const sid = t.subscribe("live.subject");
    sockets[0]!.close(); await vi.advanceTimersByTimeAsync(2);
    sockets[1]!.open(); await vi.advanceTimersByTimeAsync(5); await Promise.resolve();
    expect(sockets[1]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(2); expect(sockets).toHaveLength(3);
    await handshake(sockets[2]!); await Promise.resolve();
    expect(t.connected).toBe(true); expect(sockets[2]!.sent).toContain(`SUB live.subject ${sid}\r\n`);
    t.disconnect(); vi.useRealTimers();
  });

  it("times out WS-open silence", async () => {
    vi.useFakeTimers(); const { transport: t, sockets } = setup({ handshakeTimeoutMs: 10 });
    const dial = t.connect(); const rejected = expect(dial).rejects.toThrow(/WebSocket open/);
    await vi.advanceTimersByTimeAsync(10); await rejected; expect(sockets[0]!.closed).toBe(true);
  });

  it("times out JWT INFO silence", async () => {
    vi.useFakeTimers(); const { transport: t, sockets } = setup({ handshakeTimeoutMs: 10, jwtCredential: "j", nkeySigningCallback: async () => "s" });
    const dial = t.connect(); const rejected = expect(dial).rejects.toThrow(/INFO/); sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(10); await rejected; expect(sockets[0]!.closed).toBe(true);
  });

  it("times out a slow signing phase", async () => {
    vi.useFakeTimers(); const { transport: t, sockets } = setup({ handshakeTimeoutMs: 10, jwtCredential: "j", nkeySigningCallback: () => new Promise(() => {}) });
    const dial = t.connect(); const rejected = expect(dial).rejects.toThrow(/CONNECT signing/); sockets[0]!.open(); sockets[0]!.frame('INFO {"nonce":"n"}\r\n');
    await vi.advanceTimersByTimeAsync(10); await rejected; expect(sockets[0]!.closed).toBe(true);
  });

  it("times out first-PONG silence after signed CONNECT", async () => {
    vi.useFakeTimers(); const { transport: t, sockets } = setup({ handshakeTimeoutMs: 10, jwtCredential: "j", nkeySigningCallback: async () => "s" });
    const dial = t.connect(); const rejected = expect(dial).rejects.toThrow(/first PONG/); sockets[0]!.open(); sockets[0]!.frame('INFO {"nonce":"n"}\r\n'); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10); await rejected; expect(sockets[0]!.closed).toBe(true);
  });

  it("re-arms on phase progress so total handshake time may exceed one budget", async () => {
    vi.useFakeTimers(); const { transport: t, sockets } = setup({ handshakeTimeoutMs: 10, jwtCredential: "j", nkeySigningCallback: async () => "s" });
    const dial = t.connect(); await vi.advanceTimersByTimeAsync(8); sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(8); sockets[0]!.frame('INFO {"nonce":"n"}\r\n'); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(8); sockets[0]!.frame("PONG\r\n"); await dial;
    expect(sockets[0]!.closed).toBe(false); t.disconnect();
  });

  it("preserves hang semantics with handshakeTimeoutMs 0", async () => {
    vi.useFakeTimers(); const { transport: t, sockets } = setup({ handshakeTimeoutMs: 0 });
    let settled = false; void t.connect().then(() => { settled = true; }, () => { settled = true; }); sockets[0]!.open();
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(100_000); expect(settled).toBe(false); t.disconnect();
  });

  it("handles symmetric parser chunking and packed near-limit frames", async () => {
    const { transport: t, sockets } = setup(); const dial = t.connect(); sockets[0]!.open();
    const info = Buffer.from('INFO {"name":"한😀"}\r\nPONG\r\n');
    for (const b of info) sockets[0]!.frame(Buffer.from([b])); await dial;
    const got: NatsMessage[] = []; t.on("message", (m) => got.push(m)); t.on("error", () => {});
    for (const cut of [1, 4, 8, 11]) {
      const frame = Buffer.from("MSG split 1 1\r\nX\r\n"); sockets[0]!.frame(frame.subarray(0, cut)); sockets[0]!.frame(frame.subarray(cut));
    }
    sockets[0]!.frame("\r\nMSG zero 2 0\r\n\r\n\r\n");
    const size = Math.floor((MAX_BUFFERED_BYTES - 100) / 3);
    const packed = Buffer.concat([0, 1, 2].map((i) => Buffer.concat([Buffer.from(`MSG packed${i} ${i + 3} ${size}\r\n`), Buffer.alloc(size, 65 + i), Buffer.from("\r\n")])));
    expect(packed.length).toBeLessThanOrEqual(MAX_BUFFERED_BYTES); sockets[0]!.frame(packed);
    sockets[0]!.frame("-ERR 'permissions'\r\nMSG after 9 1\r\nZ\r\n");
    expect(got.map((m) => m.subject)).toEqual(["split", "split", "split", "split", "zero", "packed0", "packed1", "packed2", "after"]);
    expect(sockets[0]!.closed).toBe(false); t.disconnect();
  });

  it("ignores an unsolicited PONG before the signed CONNECT is on the wire", async () => {
    vi.useFakeTimers();
    const { transport: t, sockets } = setup({ handshakeTimeoutMs: 10, jwtCredential: "j", nkeySigningCallback: () => new Promise<string>(() => {}) });
    const dial = t.connect(); const rejected = expect(dial).rejects.toThrow(/CONNECT signing/);
    sockets[0]!.open(); sockets[0]!.frame('INFO {"nonce":"n"}\r\n'); await Promise.resolve();
    // Signing is pending → CONNECT is NOT on the wire. An unsolicited PONG must not
    // resolve connect(); the "CONNECT signing" phase deadline stays armed.
    sockets[0]!.frame("PONG\r\n"); expect(t.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(10); await rejected; expect(sockets[0]!.closed).toBe(true);
    vi.useRealTimers();
  });

  it("rejects a handshake-phase protocol violation without emitting error", async () => {
    const { transport: t, sockets } = setup();
    const errs: Error[] = []; t.on("error", (e) => errs.push(e));
    const dial = t.connect(); sockets[0]!.open();
    // Oversized control line before any PONG — a violation during the handshake.
    sockets[0]!.frame(`${"X".repeat(MAX_CONTROL_LINE + 1)}\r\n`);
    await expect(dial).rejects.toThrow(/protocol violation/);
    expect(errs).toEqual([]); expect(sockets[0]!.closed).toBe(true);
  });
});
