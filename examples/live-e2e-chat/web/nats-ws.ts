/**
 * Minimal NATS-over-WebSocket client — byte-accurate, runs in BOTH the browser
 * and Node ≥21 (uses the global `WebSocket`).
 *
 * Speaks just enough of the NATS protocol for this demo:
 *   INFO (server→us)   → we reply CONNECT + PING
 *   PING (server→us)   → we reply PONG
 *   SUB <subj> <sid>   (us→server)
 *   PUB <subj> <#bytes>\r\n<payload>\r\n  (us→server)
 *   MSG <subj> <sid> [reply] <#bytes>\r\n<payload>\r\n  (server→us)
 *
 * Payloads are handled as bytes (the MSG/PUB length is a byte count), so binary
 * ciphertext envelopes survive intact.
 */

type MessageHandler = (subject: string, payload: Uint8Array) => void;

const CRLF = new Uint8Array([13, 10]); // \r\n

export class NatsWsClient {
  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private subs = new Map<string, number>(); // subject -> sid
  private sidCounter = 0;
  private handlers = new Set<MessageHandler>();
  private connectedResolve: (() => void) | null = null;
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectedResolve = resolve;
      const ws = new WebSocket(this.url);
      // In the browser, NATS sends binary frames; ask for ArrayBuffers.
      (ws as { binaryType?: string }).binaryType = "arraybuffer";
      this.ws = ws;
      ws.onerror = () => reject(new Error(`NATS WebSocket error: ${this.url}`));
      ws.onclose = () => {
        this.ws = null;
      };
      ws.onmessage = (ev: MessageEvent) => this.onFrame(ev.data);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.add(handler);
  }

  subscribe(subject: string): void {
    const sid = ++this.sidCounter;
    this.subs.set(subject, sid);
    this.sendText(`SUB ${subject} ${sid}\r\n`);
  }

  publish(subject: string, payload: Uint8Array | string): void {
    const body = typeof payload === "string" ? this.enc.encode(payload) : payload;
    const header = this.enc.encode(`PUB ${subject} ${body.length}\r\n`);
    this.sendBytes(concat([header, body, CRLF]));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  // -- internals ----------------------------------------------------------

  private sendText(s: string): void {
    this.ws?.send(this.enc.encode(s));
  }
  private sendBytes(b: Uint8Array): void {
    this.ws?.send(b);
  }

  private onFrame(data: string | ArrayBuffer | Uint8Array): void {
    let bytes: Uint8Array;
    if (typeof data === "string") bytes = this.enc.encode(data);
    else if (data instanceof Uint8Array) bytes = data;
    else bytes = new Uint8Array(data);
    this.buf = concat([this.buf, bytes]);
    this.drain();
  }

  private drain(): void {
    // Process complete protocol messages from the front of the buffer.
    for (;;) {
      const nl = indexOfCRLF(this.buf, 0);
      if (nl < 0) return; // no complete control line yet
      const line = this.dec.decode(this.buf.subarray(0, nl));

      if (line.startsWith("MSG ")) {
        // MSG <subject> <sid> [reply-to] <#bytes>
        const parts = line.split(" ");
        const hasReply = parts.length === 5;
        const subject = parts[1];
        const nBytes = parseInt(parts[hasReply ? 4 : 3] ?? "0", 10);
        const payloadStart = nl + 2;
        const payloadEnd = payloadStart + nBytes;
        // Need the full payload + trailing CRLF before consuming.
        if (this.buf.length < payloadEnd + 2) return;
        const payload = this.buf.subarray(payloadStart, payloadEnd);
        for (const h of this.handlers) h(subject, payload);
        this.buf = this.buf.subarray(payloadEnd + 2);
        continue;
      }

      // Control line (INFO / PING / PONG / +OK / -ERR): consume the line.
      this.buf = this.buf.subarray(nl + 2);
      if (line.startsWith("INFO ")) {
        // Open-auth demo: no JWT/sig needed. Announce, then PING to confirm.
        this.sendText(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false })}\r\n`);
        this.sendText("PING\r\n");
      } else if (line === "PING") {
        this.sendText("PONG\r\n");
      } else if (line === "PONG") {
        // Our post-CONNECT PING was answered → connection is live.
        this.connectedResolve?.();
        this.connectedResolve = null;
      }
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function indexOfCRLF(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}
