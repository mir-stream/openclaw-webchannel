import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { NatsChannel } from "./nats-channel.js";
import { NatsTransport } from "./nats-transport.js";

class BrokerSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Array<string | Buffer> = [];
  readonly liveSids = new Map<number, string>();
  constructor(readonly broker: FakeBroker) { super(); }
  send(data: string | Buffer): void {
    this.sent.push(data);
    if (typeof data !== "string") return;
    const parts = data.trim().split(" ");
    if (parts[0] === "SUB") this.liveSids.set(Number(parts[2]), parts[1]!);
    if (parts[0] === "UNSUB") this.liveSids.delete(Number(parts[1]));
  }
  open(): void { this.readyState = WebSocket.OPEN; this.emit("open"); this.emit("message", "INFO {}\r\nPONG\r\n"); }
  close(): void { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.emit("close"); }
}
class FakeBroker {
  readonly sockets: BrokerSocket[] = [];
  make = (): WebSocket => { const ws = new BrokerSocket(this); this.sockets.push(ws); return ws as unknown as WebSocket; };
  publish(subject: string, payload: string): number {
    let deliveries = 0;
    for (const ws of this.sockets) for (const [sid, subscribed] of ws.liveSids) {
      if (subscribed !== subject || ws.readyState !== WebSocket.OPEN) continue;
      deliveries++;
      ws.emit("message", `MSG ${subject} ${sid} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
    }
    return deliveries;
  }
}

describe("P1-3 NatsChannel stable live SID", () => {
  it("unregisters the replayed live SID at the broker and prevents later dispatch", async () => {
    vi.useFakeTimers();
    const broker = new FakeBroker();
    const transport = new NatsTransport({ url: "ws://fake", reconnect: true, reconnectBaseMs: 1, handshakeTimeoutMs: 20, _wsFactory: broker.make });
    const channel = new NatsChannel(transport, "acct", "tenant");
    const handler = vi.fn(); channel.setMessageHandler(handler);
    const initial = transport.connect(); broker.sockets[0]!.open(); await initial;
    channel.registerPeer("peer");
    const subject = "webchannel.tenant.acct.peer.in";
    const sid = [...broker.sockets[0]!.liveSids].find(([, s]) => s === subject)![0];

    broker.sockets[0]!.close(); await vi.advanceTimersByTimeAsync(1);
    broker.sockets[1]!.open(); await vi.waitFor(() => expect(transport.connected).toBe(true));
    expect(broker.sockets[1]!.liveSids.get(sid)).toBe(subject);

    channel.unregisterPeer("peer");
    expect(broker.sockets[1]!.sent).toContain(`UNSUB ${sid}\r\n`);
    expect([...broker.sockets[1]!.liveSids.values()]).not.toContain(subject);
    expect(broker.publish(subject, JSON.stringify({ type: "user_message", text: "zombie" }))).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    transport.disconnect(); vi.useRealTimers();
  });
});
