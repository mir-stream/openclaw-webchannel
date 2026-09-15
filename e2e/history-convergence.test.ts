import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryWork } from "../packages/plugin/src/materialized-history.js";
import { openDeliveryJournal } from "../packages/plugin/src/delivery-journal.js";
import { ConversationKeyStore } from "../packages/plugin/src/conversation-key-store.js";
import { generateKeyPair } from "../packages/plugin/src/e2e-crypto.js";
import { NatsChannel } from "../packages/plugin/src/nats-channel.js";
import type { NatsTransport } from "../packages/plugin/src/nats-transport.js";
import { createHistoryServer } from "../packages/plugin/src/history-serve.js";
import { WebChannelNATSClient } from "../packages/client/src/nats-client-wrapper.js";
import { openMessage } from "../packages/client/src/e2e-crypto-browser.js";
import { decodeInboundMessage } from "../packages/client/src/inbound-wire-decode.js";
import type { InboundMessage } from "../packages/client/src/nats-client.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function setup(limit = 1_000_000) {
  const root = mkdtempSync(join(tmpdir(), "history-convergence-"));
  const work: HistoryWork[] = [];
  const journal = openDeliveryJournal({ databasePath: join(root, "journal.sqlite"), onHistoryWork: row => work.push(row) });
  const keys = new ConversationKeyStore({ tenant: "tenant", accountId: "account", storageRoot: root });
  class Transport extends EventEmitter {
    connected = true;
    effectiveOutboundLimit = limit;
    frames: Buffer[] = [];
    subscribe() { return 1; }
    unsubscribe() {}
    publish(_subject: string, payload: string | Buffer) {
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(this.effectiveOutboundLimit);
      this.frames.push(Buffer.from(payload));
    }
  }
  const transport = new Transport();
  const channel = new NatsChannel(transport as unknown as NatsTransport, "account", "tenant",
    { keyStore: keys, identityKeyPair: generateKeyPair() }, undefined,
    { deliveryJournal: journal, reasoningDurable: true });
  channel.registerPeer("peer");
  const key = keys.getOrCreate("peer");
  const queue: Array<() => void> = [];
  const server = createHistoryServer({ journal, channel, config: { limit: 50, pageSize: 50 },
    schedule: (fn) => queue.push(fn) });
  const wrapper = new WebChannelNATSClient({ natsUrl: "ws://127.0.0.1:4222", bootstrapJwt: "test",
    accountId: "account", tenant: "tenant", peerId: "peer",
    registration: { devicePrivateKey: {} as CryptoKey, deviceX25519PrivateKey: {} as CryptoKey } });
  const inner = wrapper as unknown as { handleMessage(m: InboundMessage): void;
    client: { getDifference(afterSeq: number, nonce: string): void };
    cursor: { state: string; afterSeq: number; last: number } };
  inner.client.getDifference = (afterSeq, nonce) => server.serveDifference("peer", afterSeq, nonce);
  const decode = (frame: Buffer) => {
    const decoded = decodeInboundMessage(openMessage(frame.toString(), key));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("invalid emitted frame");
    return decoded.message;
  };
  const deliver = () => { for (const frame of transport.frames.splice(0)) inner.handleMessage(decode(frame)); };
  cleanups.push(() => { wrapper.close(); channel.dispose(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  const snapshot = () => {
    server.sendSnapshot("peer");
    for (let steps = 0; steps < 1000; steps++) {
      queue.shift()!();
      if (transport.frames.some(frame => decode(frame).type === "history")) return;
    }
    throw new Error("snapshot did not complete");
  };
  return { journal, channel, server, transport, wrapper, inner, queue, decode, deliver, snapshot, work };
}

describe("history producer → sealed frame → browser decoder → wrapper", () => {
  it("keeps absent seal removals hidden even when a later journal retry names the ID", () => {
    const h = setup();
    h.journal.append("peer", { kind: "seal", turnId: "t", answers: [], remove: ["unseen"] });
    h.journal.append("peer", { kind: "bubble", answerId: "unseen", text: "late retry" });
    h.journal.append("peer", { kind: "bubble", answerId: "kept", text: "kept" });
    h.snapshot(); h.deliver();
    expect(h.wrapper.getState().messages.map((m) => m.id)).toEqual(["kept"]);
    expect(h.inner.cursor.last).toBe(3);
  });
  it("carries real journal origin mappings, row modification seqs and edit metadata", () => {
    const h = setup();
    const other = h.journal.appendInboundUser("peer", { text: "same", randomId: "other", turnId: "other-wire" });
    const own = h.journal.appendInboundUser("peer", { text: "same", randomId: "own", turnId: "own-wire" });
    expect(h.channel.sendProgress("peer", "A", "partial", "own-wire")).toBe(true);
    expect(h.channel.sendToolActivity("peer", { id: "tool", turnId: "own-wire", name: "exec", phase: "start" })).toBe(true);
    expect(h.channel.sendReasoning("peer", "R", "own-wire", "final reasoning", true)).toBe(true);
    expect(h.channel.sendToolActivity("peer", { id: "tool", turnId: "own-wire", phase: "end", status: "ok" })).toBe(true);
    expect(h.channel.sendText("peer", "answer", "A", "own-wire")).toBe(true);
    expect(h.channel.sendTurnSnapshot("peer", "own-wire", [{ id: "A", text: "sealed answer" }], [])).toBe(true);
    h.journal.append("peer", { kind: "messageEdited", id: "A", text: "edited answer", revision: 2 });
    h.transport.frames.length = 0; // This cold browser missed all live egress.
    h.snapshot();
    const snapshot = h.decode(h.transport.frames[0]!);
    expect(snapshot).toMatchObject({ type: "history", highWaterSeq: 9, snapshotComplete: true });
    expect(snapshot.messages).toMatchObject([
      { id: other.messageId, randomId: "other", turnId: "other-wire", seq: 1 },
      { id: own.messageId, randomId: "own", turnId: "own-wire", seq: 2 },
      { id: "A", text: "edited answer", turnId: "own-wire", seq: 9, revision: 2, edited: true },
      { kind: "tool", id: "tool", seq: 6, phase: "end", status: "ok" },
      { kind: "reasoning", id: "R", seq: 5, text: "final reasoning" },
    ]);
    h.deliver();
    expect(h.wrapper.getState().messages.map((row) => row.id)).toEqual([other.messageId, own.messageId, "A", "tool", "R"]);
    expect(h.wrapper.getState().messages[2]).toMatchObject({ text: "edited answer", revision: 2, edited: true, working: false });
    expect(h.inner.cursor.last).toBe(9);
  });

  it("recovers a warm >500-event gap in order while live updates arrive between difference pages", () => {
    const h = setup();
    h.journal.append("peer", { kind: "user", id: "old", text: "old" });
    h.snapshot(); h.deliver();
    for (let i = 2; i <= 602; i++) h.journal.append("peer", { kind: "bubble", answerId: `a${i}`, text: `${i}` });
    h.snapshot(); h.deliver();
    expect(h.wrapper.getState().messages.map((m) => m.id)).toEqual(["old"]);
    expect(h.inner.cursor.afterSeq).toBe(1);
    h.queue.shift()!(); h.deliver(); // First 500 events, continuation now queued.
    expect(h.inner.cursor.afterSeq).toBe(501);
    expect(h.channel.sendText("peer", "concurrent", "a603")).toBe(true);
    h.deliver(); // Held by the active device-specific difference request.
    h.queue.shift()!(); h.deliver();
    expect(h.inner.cursor.last).toBe(603);
    expect(h.work.some(w => w.batches > 0)).toBe(true);
    expect(h.work.every(w => w.pageRowsRead <= 50)).toBe(true);
    expect(h.wrapper.getState().messages.map((m) => m.id)).toEqual(["old", ...Array.from({ length: 602 }, (_, i) => `a${i + 2}`)]);
  });

  it("measures snapshot completeness on the actual sealed envelope and recovers byte trimming", () => {
    const h = setup(1800);
    for (let i = 1; i <= 8; i++) h.journal.append("peer", { kind: "bubble", answerId: `a${i}`, text: "content ".repeat(25) });
    h.snapshot();
    const snapshot = h.decode(h.transport.frames[0]!);
    expect(snapshot.snapshotComplete).toBe(false);
    expect(snapshot.messages!.length).toBeLessThan(8);
    h.deliver();
    expect(h.inner.cursor.afterSeq).toBe(0);
    expect(h.wrapper.getState().messages).toEqual([]);
    for (let requests = 0; h.queue.length && requests < 10; requests++) { h.queue.shift()!(); h.deliver(); }
    expect(h.inner.cursor.last).toBe(8);
    expect(h.work.some(w => w.pageRowsRead > 0)).toBe(true);
    expect(h.wrapper.getState().messages.map((m) => m.id)).toEqual(Array.from({ length: 8 }, (_, i) => `a${i + 1}`));
  });

  it("restores equal-version sparse terminal tools from repeated materialized encrypted snapshots and pages", () => {
    const h = setup();
    h.channel.sendToolActivity("peer", { id: "tool", turnId: "turn", name: "read_file", argKeys: ["path"], phase: "start", summary: "reading" });
    h.transport.frames.length = 0; // Opener was missed by this browser.
    h.channel.sendToolActivity("peer", { id: "tool", turnId: "turn", phase: "end", status: "completed" });
    h.deliver();
    h.snapshot(); h.deliver();
    h.work.length = 0;
    h.snapshot(); h.deliver();
    expect(h.work).toMatchObject([{ rawEventsRead: 0, materializedRowsRead: 0, materializedRowsWritten: 0, pageRowsRead: 1 }]);
    expect(h.wrapper.getState().messages).toMatchObject([{ id: "tool", name: "read_file", argKeys: ["path"], summary: "reading", phase: "end", status: "completed" }]);
    h.channel.sendText("peer", "tail", "tail"); h.deliver();
    h.server.servePage("peer", { before: "tail", limit: 50 });
    while (h.queue.length) h.queue.shift()!();
    h.deliver();
    expect(h.wrapper.getState().messages.filter(row => row.id === "tool")).toHaveLength(1);
    expect(h.wrapper.getState().messages[0]).toMatchObject({ name: "read_file", argKeys: ["path"], phase: "end", status: "completed" });
  });


  it("adopts only the exact optimistic origin from materialized history before its acknowledgement", () => {
    const h = setup();
    const sent: Array<{ text: string; wireId: string; randomId: string }> = [];
    (h.inner.client as unknown as { sendUserMessage(text: string, id: string, randomId: string): void }).sendUserMessage =
      (text, wireId, randomId) => { sent.push({ text, wireId, randomId }); };
    const receipt = h.wrapper.send("same")!;
    expect(sent).toHaveLength(1);
    const original = sent[0]!;
    const other = h.journal.appendInboundUser("peer", { text: "same", turnId: "other-wire", randomId: "other-origin" });
    const own = h.journal.appendInboundUser("peer", { text: original.text, turnId: original.wireId, randomId: original.randomId });
    h.snapshot(); h.deliver();
    h.snapshot(); h.deliver();
    expect(h.wrapper.getState().messages.map(row => row.id)).toEqual([other.messageId, own.messageId]);
    expect(h.wrapper.getState().messages.filter(row => row.id === own.messageId)).toHaveLength(1);
    h.channel.sendAck("peer", [original.wireId], [{ random_id: original.randomId, messageId: own.messageId, seq: own.seq }]);
    h.deliver();
    // This fixture invokes the wrapper after decoding; low-level receipt tracker
    // transitions are exercised by nats-client-wrapper-sendstate.test.ts.
    expect(receipt.snapshot().state).toBe("queued");
    expect(h.wrapper.getState().messages.find(row => row.id === own.messageId)).toMatchObject({ receiptKey: receipt.id, sendState: "queued" });
    expect(h.wrapper.getState().messages.map(row => row.id)).toEqual([other.messageId, own.messageId]);
    expect(h.work.at(-1)).toMatchObject({ rawEventsRead: 0, materializedRowsRead: 0, materializedRowsWritten: 0, pageRowsRead: 2 });
  });

});
