import type WebSocket from "ws";

import {
  NatsTransport,
  type NatsConnectOptions,
} from "./nats-transport.js";

type Handler = (...args: unknown[]) => void;

/** Minimal controllable WebSocket CLIENT used by connector ownership tests. */
export class ConnectorFakeWebSocket {
  readyState = 0;
  readonly sent: Array<string | Buffer> = [];
  closeCalls = 0;
  private closed = false;
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): this {
    const current = this.handlers.get(event) ?? [];
    current.push(handler);
    this.handlers.set(event, current);
    return this;
  }

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
    if (this.closed) return;
    this.closed = true;
    this.fire("close");
  }

  open(): void {
    this.readyState = 1;
    this.fire("open");
  }

  server(data: string): void {
    this.fire("message", data);
  }

  error(error: Error): void {
    this.fire("error", error);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

export function createConnectorTransportHarness(
  overrides: Partial<NatsConnectOptions> = {},
): {
  readonly sockets: ConnectorFakeWebSocket[];
  readonly transportFactory: (options: NatsConnectOptions) => NatsTransport;
  readonly transport: () => NatsTransport;
} {
  const sockets: ConnectorFakeWebSocket[] = [];
  let allocated: NatsTransport | undefined;
  return {
    sockets,
    transportFactory: (options) => {
      allocated = new NatsTransport({
        ...options,
        reconnectBaseMs: 5,
        reconnectCapMs: 5,
        handshakeTimeoutMs: 25,
        ...overrides,
        _wsFactory: () => {
          const socket = new ConnectorFakeWebSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });
      return allocated;
    },
    transport: () => {
      if (!allocated) throw new Error("transport not allocated");
      return allocated;
    },
  };
}

/** Drive INFO -> async NKEY signing -> PONG on one production transport dial. */
export async function completeJwtHandshake(socket: ConnectorFakeWebSocket): Promise<void> {
  socket.open();
  socket.server('INFO {"nonce":"connector-test-nonce"}\r\n');
  await Promise.resolve();
  await Promise.resolve();
  socket.server("PONG\r\n");
}
