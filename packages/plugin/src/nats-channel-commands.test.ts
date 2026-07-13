/**
 * P0-3 — the NATS channel routes a `load_commands` request to its handler and
 * emits the catalog as a `commands` frame. Plaintext mode (no crypto) so the
 * RecordingTransport can inspect the wire payload directly, mirroring
 * nats-channel-typing.test.ts.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";

import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport, NatsMessage } from "./nats-transport.js";
import type { CommandCatalogEntry } from "./commands-catalog.js";

/** Transport that RECORDS published subject/payload pairs (plaintext mode). */
class RecordingTransport extends EventEmitter {
  connected = true;
  readonly published: Array<{ subject: string; payload: string }> = [];
  private sid = 0;
  subscribe(): number {
    return ++this.sid;
  }
  unsubscribe(): void {
    /* no-op */
  }
  publish(subject: string, payload: string): void {
    this.published.push({ subject, payload });
  }
  /** Drive an inbound frame as if it arrived on a subscribed subject. */
  deliver(subject: string, payload: unknown): void {
    const msg: NatsMessage = {
      subject,
      payload: Buffer.from(JSON.stringify(payload)),
    };
    this.emit("message", msg);
  }
}

const IN = "webchannel.tenant.acct.peer-0.in";
const OUT = "webchannel.tenant.acct.peer-0.out";

function commandsFrames(t: RecordingTransport): Array<{ type: string; commands: CommandCatalogEntry[] }> {
  return t.published
    .map((p) => {
      try {
        return JSON.parse(p.payload) as { type: string; commands: CommandCatalogEntry[] };
      } catch {
        return { type: "", commands: [] };
      }
    })
    .filter((m) => m.type === "commands");
}

describe("P0-3 — NatsChannel command discovery", () => {
  it("routes an inbound load_commands to the handler with the peerId", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");

    const seen: string[] = [];
    channel.setLoadCommandsHandler((peerId) => seen.push(peerId));

    transport.deliver(IN, { type: "load_commands" });
    expect(seen).toEqual(["peer-0"]);
  });

  it("sendCommands emits a `commands` frame on the peer's .out subject", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");

    const catalog: CommandCatalogEntry[] = [
      { name: "help", description: "Show available commands." },
      { name: "model", description: "Show or set the model.", args: [{ name: "model" }] },
    ];
    expect(channel.sendCommands("peer-0", catalog)).toBe(true);

    const frames = commandsFrames(transport);
    expect(frames).toHaveLength(1);
    expect(transport.published.at(-1)?.subject).toBe(OUT);
    expect(frames[0].commands).toEqual(catalog);
  });

  it("wires end-to-end: a load_commands request drives a catalog reply", () => {
    const transport = new RecordingTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");

    const catalog: CommandCatalogEntry[] = [{ name: "help", description: "Show available commands." }];
    channel.setLoadCommandsHandler((peerId) => channel.sendCommands(peerId, catalog));

    transport.deliver(IN, { type: "load_commands" });

    const frames = commandsFrames(transport);
    expect(frames).toHaveLength(1);
    expect(frames[0].commands).toEqual(catalog);
  });

  it("is a no-op when no handler is registered (unknown-safe)", () => {
    const transport = new RecordingTransport();
    new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant");
    // No handler set — must not throw, must not publish.
    expect(() => transport.deliver(IN, { type: "load_commands" })).not.toThrow();
    expect(commandsFrames(transport)).toHaveLength(0);
  });
});
