import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryWork } from "../packages/plugin/src/materialized-history.js";
import { openDeliveryJournal } from "../packages/plugin/src/delivery-journal.js";
import { ConversationKeyStore } from "../packages/plugin/src/conversation-key-store.js";
import { generateKeyPair } from "../packages/plugin/src/e2e-crypto.js";
import { NatsChannel } from "../packages/plugin/src/nats-channel.js";
import type { NatsTransport } from "../packages/plugin/src/nats-transport.js";
import { createHistoryServer, MAX_OUTSTANDING_PAGE_REQUESTS } from "../packages/plugin/src/history-serve.js";
import { MAX_OUTSTANDING_HISTORY_PAGES, WebChannelNATSClient } from "../packages/client/src/nats-client-wrapper.js";
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
  it("#413: an entirely oversized snapshot still seeds and lets the next live row through", () => {
    const h = setup(1200);
    for (let i = 1; i <= 3; i++) h.journal.append("peer", { kind: "bubble", answerId: `a${i}`, text: "x".repeat(3000) });
    h.snapshot(); h.deliver();
    expect(h.wrapper.getState().messages).toEqual([]);
    expect(h.wrapper.getState().historyOmissions).toEqual([1, 2, 3].map(seq => ({ id: `a${seq}`, seq })));
    expect(h.inner.cursor).toMatchObject({ state: "synced", last: 3 });
    expect(h.queue).toEqual([]);
    h.channel.sendText("peer", "small live", "a4"); h.deliver();
    expect(h.wrapper.getState().messages.map(m => m.id)).toEqual(["a4"]);
    expect(h.inner.cursor.last).toBe(4);
  });

  it("#414: stamps the journal epoch on snapshots, differences, ACKs and live frames", () => {
    const h = setup();
    expect(h.journal.epoch).toEqual(expect.any(String));
    expect(h.journal.epoch!.length).toBeGreaterThan(0);
    h.snapshot();
    const baseline = h.decode(h.transport.frames[0]!);
    expect(baseline).toMatchObject({ epoch: h.journal.epoch, highWaterSeq: 0 });
    h.deliver();
    const user = h.journal.appendInboundUser("peer", { text: "question", randomId: "random" });
    h.channel.sendAck("peer", ["wire"], [{ random_id: "random", messageId: user.messageId, seq: user.seq }]);
    h.channel.sendUserCommitted("peer", { id: user.messageId, text: "question", seq: user.seq, random_id: "random" });
    h.channel.sendText("peer", "answer", "answer");
    expect(h.transport.frames.map(frame => h.decode(frame).epoch)).toEqual(Array(3).fill(h.journal.epoch));
    h.transport.frames.length = 0;
    h.server.serveDifference("peer", 0, "nonce");
    while (h.queue.length) h.queue.shift()!();
    expect(h.decode(h.transport.frames[0]!)).toMatchObject({ epoch: h.journal.epoch,
      type: "difference", afterSeq: 0, nonce: "nonce", maxSeq: 2 });
  });
  it("#413: incomplete cold snapshots do linear storage work and never replay the journal", () => {
    // Pin the materializer's time-slice clock: CI contention may yield midway
    // through a fetched 128-row batch and reread its tail on the next callback.
    // Row-count yielding still runs; this isolates structural work from load.
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const costs: number[] = [];
      for (const count of [2000, 4000]) {
        const h = setup(20_000);
        for (let i = 1; i <= count; i++) {
          h.journal.append("peer", { kind: "bubble", answerId: `a${i}`,
            text: i === count - 1 ? "x".repeat(30_000) : `answer ${i}` });
        }
        h.snapshot();
        const snapshot = h.decode(h.transport.frames[0]!);
        expect(snapshot.snapshotComplete).toBe(false);
        h.deliver();
        expect(h.inner.cursor).toMatchObject({ state: "synced", last: count });
        expect(h.queue).toEqual([]);
        expect(h.wrapper.getState().messages).toHaveLength(49);
        expect(h.wrapper.getState().historyOmissions).toEqual([{ id: `a${count - 1}`, seq: count - 1 }]);
        expect(h.channel.sendText("peer", "live", "live")).toBe(true);
        h.deliver();
        expect(h.wrapper.getState().messages.at(-1)).toMatchObject({ id: "live", text: "live" });
        expect(h.inner.cursor.last).toBe(count + 1);
        const sum = (key: keyof HistoryWork) => h.work.reduce((n, w) => n + w[key], 0);
        expect(sum("rawEventsApplied")).toBe(count);
        expect(sum("rawEventsRead")).toBe(count);
        expect(sum("pageRowsRead")).toBe(50);
        costs.push(sum("rawEventsRead") + sum("materializedRowsRead") + sum("materializedRowsWritten"));
        h.work.length = 0;
        h.snapshot(); h.deliver();
        expect(sum("rawEventsRead")).toBe(1); // Only the new live row needs materialization.
        expect(h.queue).toEqual([]);
      }
      // Structural work, not a noisy wall-clock threshold: doubling rows doubles
      // cold materialization; browser hydration remains one bounded window.
      expect(costs[1]).toBeLessThanOrEqual(costs[0]! * 2 + 10);
    } finally { clock.mockRestore(); }
  });
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

  it("covers a cold same-peer browser that registers during snapshot catch-up", () => {
    const h = setup();
    for (let i = 1; i <= 400; i++) {
      h.journal.append("peer", { kind: "bubble", answerId: `a${i}`, text: `${i}` });
    }
    h.server.sendSnapshot("peer"); // An earlier browser's registration.
    h.queue.shift()!(); // The first bounded callback captures 400 and yields.
    expect(h.transport.frames).toEqual([]);
    expect(h.queue).toHaveLength(1);

    expect(h.channel.sendText("peer", "before the cold browser joined", "a401")).toBe(true);
    h.transport.frames.length = 0; // The cold browser has not subscribed yet.
    expect(h.wrapper.getState().messages).toEqual([]);
    h.server.sendSnapshot("peer"); // Its registration shares the pending replay.
    expect(h.queue).toHaveLength(1);
    while (h.queue.length) h.queue.shift()!();

    expect(h.transport.frames).toHaveLength(1);
    const snapshot = h.decode(h.transport.frames[0]!);
    expect(snapshot).toMatchObject({ type: "history", highWaterSeq: 401, snapshotComplete: true });
    expect(snapshot.messages!.at(-1)).toMatchObject({ id: "a401", seq: 401 });
    h.deliver();
    expect(h.inner.cursor).toMatchObject({ state: "synced", last: 401 });
    expect(h.wrapper.getState().messages.map(row => row.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `a${i + 352}`),
    );
    expect(h.wrapper.getState().messages.at(-1)).toMatchObject({ text: "before the cold browser joined" });
    expect(h.queue).toEqual([]);
  });

  it("measures snapshot completeness on the actual sealed envelope and recovers byte trimming", () => {
    const h = setup(1800);
    for (let i = 1; i <= 8; i++) h.journal.append("peer", { kind: "bubble", answerId: `a${i}`, text: "content ".repeat(25) });
    h.snapshot();
    const snapshot = h.decode(h.transport.frames[0]!);
    expect(snapshot.snapshotComplete).toBe(false);
    expect(snapshot.messages!.length).toBeLessThan(8);
    h.deliver();
    expect(h.inner.cursor.last).toBe(8);
    expect(h.wrapper.getState().messages).toHaveLength(snapshot.messages!.length);
    expect(h.queue).toEqual([]);
    const internals = h.wrapper as unknown as { mintHistoryPageNonce(): string };
    for (let pages = 0; h.wrapper.getState().messages[0]?.id !== "a1" && pages < 8; pages++) {
      h.server.servePage("peer", { before: h.wrapper.getState().messages[0]!.id,
        nonce: internals.mintHistoryPageNonce() });
      while (h.queue.length) h.queue.shift()!();
      h.deliver();
    }
    expect(h.wrapper.getState().historyOmissions).toEqual([]);
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
    // #401: the page answers THIS browser's request, so it carries its nonce;
    // an unsolicited page would be dropped and assert nothing about the merge.
    const internals = h.wrapper as unknown as { mintHistoryPageNonce(): string; historyPageNonces: string[] };
    const nonce = internals.mintHistoryPageNonce();
    h.server.servePage("peer", { before: "tail", limit: 50, nonce });
    while (h.queue.length) h.queue.shift()!();
    h.deliver();
    // Folded, not dropped: the page was claimed against this browser's nonce.
    expect(internals.historyPageNonces).not.toContain(nonce);
    expect(h.wrapper.getState().messages.filter(row => row.id === "tool")).toHaveLength(1);
    expect(h.wrapper.getState().messages[0]).toMatchObject({ name: "read_file", argKeys: ["path"], phase: "end", status: "completed" });
  });


  it("#401: the client remembers every page the server can owe", () => {
    // The server answers one folding page plus a full queue per peer, in order.
    // A smaller client bound would evict a nonce whose page is still coming,
    // and that page would be dropped on arrival as another device's.
    expect(MAX_OUTSTANDING_PAGE_REQUESTS).toBe(9);
    expect(MAX_OUTSTANDING_HISTORY_PAGES).toBeGreaterThanOrEqual(MAX_OUTSTANDING_PAGE_REQUESTS);
  });

  it("#401: a load-older page supplies the rows only it carries, to the requesting browser only", () => {
    const h = setup();
    // One row more than the snapshot window (limit 50): `page-only` is reachable
    // ONLY through a page, so its presence proves the page was folded.
    h.journal.append("peer", { kind: "bubble", answerId: "page-only", text: "older than the window" });
    for (let i = 1; i <= 50; i++) h.journal.append("peer", { kind: "bubble", answerId: `b${i}`, text: `${i}` });
    const other = new WebChannelNATSClient({ natsUrl: "ws://127.0.0.1:4222", bootstrapJwt: "test",
      accountId: "account", tenant: "tenant", peerId: "peer",
      registration: { devicePrivateKey: {} as CryptoKey, deviceX25519PrivateKey: {} as CryptoKey } });
    cleanups.push(() => other.close());
    const otherInner = other as unknown as { handleMessage(m: InboundMessage): void };
    // Every sealed frame on the shared `.out` reaches BOTH browsers of the peer.
    const broadcast = () => {
      for (const frame of h.transport.frames.splice(0)) {
        const message = h.decode(frame);
        h.inner.handleMessage(message);
        otherInner.handleMessage(message);
      }
    };
    h.snapshot(); broadcast();
    const window = Array.from({ length: 50 }, (_, i) => `b${i + 1}`);
    expect(h.wrapper.getState().messages.map((m) => m.id)).toEqual(window);
    expect(other.getState().messages.map((m) => m.id)).toEqual(window);

    // The wrapper's real request path, answered by the real pager.
    (h.inner.client as unknown as {
      loadHistory(before?: string, limit?: number, beforeTurnId?: string, nonce?: string): void;
    }).loadHistory = (before, limit, beforeTurnId, nonce) =>
      h.server.servePage("peer", { before, limit, beforeTurnId, nonce });
    h.wrapper.loadHistory({ before: "b1" });
    while (h.queue.length) h.queue.shift()!();
    broadcast();

    expect(h.wrapper.getState().messages.map((m) => m.id)).toEqual(["page-only", ...window]);
    expect(other.getState().messages.map((m) => m.id)).toEqual(window);
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
