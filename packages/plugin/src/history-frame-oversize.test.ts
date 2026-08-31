/**
 * #311 — A `history` FRAME TOO BIG FOR THE WIRE, END TO END.
 *
 * This file drives the REAL `createHistoryServer` (`history-serve.ts`) over a
 * REAL `openDeliveryJournal` fed through the REAL egress seam
 * (`NatsChannel.sendReasoning` / `sendText` → `sendToPeer` → `journalOutbound`),
 * against a transport that reproduces `nats-transport.ts`'s ONE size check
 * verbatim. `history-frame-budget.test.ts` is the pure unit file for the
 * algorithm; this one is the proof that it is actually wired to the sealed
 * sizes the wire uses.
 *
 * ── WHAT WAS MEASURED (this is what closed #311's "Not measured") ──
 *
 * `history.limit` / `pageSize` / `MAX_WIRE_HISTORY_LIMIT` bound a page by ROW
 * COUNT and nothing bounded it by BYTES. On an encrypted channel, a 50-row
 * snapshot seals past a stock nats-server's 1 MiB at 15 651 bytes of text per
 * row; a peer-requested 1000-row page at 734 bytes per row; one row alone at
 * 786 160 bytes. The MEASUREMENT tests below still assert exactly those
 * thresholds, because they are the evidence and they must not be softened.
 *
 * ── WHAT USED TO HAPPEN THERE, AND WHAT HAPPENS NOW ──
 *
 * BEFORE: `NatsTransport.publish` threw a `RangeError`; `sendToPeer` caught it,
 * logged one line and returned `false`; both call sites in `history-serve.ts`
 * discarded that `false`. The peer received NO frame — not a short one — on
 * every reconnect, and the module that owns the read said nothing.
 *
 * NOW: `history-frame-budget.ts` fits the page to the peer's sealed limit before
 * it is published. The frame IS published, carrying the NEWEST rows that fit;
 * the older ones are reported at `warn` and are reachable through the pager. A
 * row that cannot fit on its own is skipped at `error` so paging can pass it —
 * sound because such a row's LIVE send hit the same limit, so it was never
 * delivered (the journal is written before the publish). And a send that is
 * refused anyway is now reported instead of dropped.
 *
 * ⚠️ THE ONE THING THAT MUST NOT REGRESS: "short" must never become "absent".
 * Each test below states which of the two it is holding.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDeliveryJournal, type DeliveryJournal } from "./delivery-journal.js";
import { generateKeyPair } from "./e2e-crypto.js";
import {
  DEFAULT_HISTORY_CONFIG,
  MAX_WIRE_HISTORY_LIMIT,
  type HistoryConfig,
  type HistoryMessage,
} from "./history.js";
import { createHistoryServer, type HistoryServer } from "./history-serve.js";
import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";

const TENANT = "tenant";
const ACCOUNT = "acct";
const PEER = "peer-0";
const OUT = `webchannel.${TENANT}.${ACCOUNT}.${PEER}.out`;
const T0 = 1_000_000;
const T_STEP = 10;

/** A stock nats-server's `max_payload`. The number #311 is about. */
const STOCK_MAX_PAYLOAD = 1024 * 1024;

/** Wide enough that SEEDING never trips the bound the tests are about. */
const SEEDING_LIMIT = 64 * 1024 * 1024;

const openJournals: DeliveryJournal[] = [];
const tempRoots: string[] = [];
const channels: NatsChannel[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (channels.length > 0) {
    try {
      channels.pop()!.dispose();
    } catch {
      /* teardown must not fail a test that disposed on purpose */
    }
  }
  while (openJournals.length > 0) {
    try {
      openJournals.pop()!.close();
    } catch {
      /* as above */
    }
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

/**
 * Transport stand-in carrying the ONE production rule this file is about.
 *
 * ⚠️ THE SIZE CHECK IS COPIED FROM `nats-transport.ts`'s `publish`, DELIBERATELY
 * AND VISIBLY — same predicate (`buf.length > this.effectiveOutboundLimit`),
 * same `RangeError`, same message. The real transport needs a live WebSocket, so
 * it cannot be driven from a unit test; transcribing three lines of it is the
 * price, and putting them here where a reader can diff them is better than
 * hiding the bound behind a `failPublishCalls` set (which is what
 * `nats-channel-ack.test.ts` does, for a different question). If that predicate
 * ever changes, this comment is the pointer to the two places that must move
 * together.
 */
class LimitedTransport extends EventEmitter {
  connected = true;
  effectiveOutboundLimit = SEEDING_LIMIT;
  readonly published: Array<{ subject: string; bytes: number }> = [];
  private sid = 0;
  subscribe(): number {
    return ++this.sid;
  }
  unsubscribe(): void {
    /* no-op */
  }
  publish(subject: string, payload: string | Buffer): void {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    if (buf.length > this.effectiveOutboundLimit) {
      throw new RangeError(
        `NatsTransport: outbound payload ${buf.length} exceeds effective max_payload ${this.effectiveOutboundLimit}`,
      );
    }
    this.published.push({ subject, bytes: buf.length });
  }
}

type Harness = {
  journal: DeliveryJournal;
  transport: LimitedTransport;
  channel: NatsChannel;
  server: HistoryServer;
  /** What `NatsChannel.sendHistory` RETURNED, per call. `history-serve` drops it. */
  sendHistoryResults: boolean[];
  /** The projected rows `history-serve` handed to the channel, per call. */
  servedFrames: HistoryMessage[][];
  errors: string[];
  warns: string[];
  flush: () => void;
};

/**
 * The production shape: an ENCRYPTED channel (the register-hop mode
 * `nats-account-runtime.ts` builds), a real journal, and the real history
 * server over both.
 *
 * Encrypted rather than plaintext on purpose — `outboundWireSize` then returns
 * the SEALED length, which is what `publish` actually measures, and sealing is
 * where a third of the bytes come from (`e2e-envelope.ts` base64url-encodes the
 * ciphertext into a JSON envelope, so the wire is ~4/3 of the JSON). Measuring
 * plaintext would understate every threshold below by ~25%.
 */
function harness(opts: {
  reasoningDurable?: boolean;
  config?: HistoryConfig;
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "webchannel-history-oversize-"));
  tempRoots.push(root);
  let tick = 0;
  const journal = openDeliveryJournal({
    databasePath: join(root, "tuple", "delivery-journal.sqlite"),
    now: () => T0 + tick++ * T_STEP,
  });
  openJournals.push(journal);

  const transport = new LimitedTransport();
  const sessionKey = new Uint8Array(32).fill(7);
  const channel = new NatsChannel(
    transport as unknown as NatsTransport,
    ACCOUNT,
    TENANT,
    { keyStore: { getOrCreate: () => sessionKey } as never, identityKeyPair: generateKeyPair() },
    undefined,
    {
      deliveryJournal: journal,
      reasoningDurable: opts.reasoningDurable === true,
    },
  );
  channels.push(channel);
  channel.registerPeer(PEER);

  const sendHistoryResults: boolean[] = [];
  const servedFrames: HistoryMessage[][] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const queue: Array<() => void> = [];

  const server = createHistoryServer({
    journal,
    // The REAL channel, wrapped only to observe the boolean `history-serve.ts`
    // discards. Every byte still goes through `NatsChannel.sendHistory`.
    channel: {
      sendHistory(peerId: string, messages: HistoryMessage[]): boolean {
        servedFrames.push(messages);
        const ok = channel.sendHistory(peerId, messages);
        sendHistoryResults.push(ok);
        return ok;
      },
      // Straight through to the real channel: the budget must run against the
      // SEALED sizes and the transport's own advertised limit, not a stand-in.
      outboundWireSize: (peerId, payload) => channel.outboundWireSize(peerId, payload),
      effectiveOutboundLimit: () => channel.effectiveOutboundLimit(),
    },
    config: opts.config ?? DEFAULT_HISTORY_CONFIG,
    logger: {
      error: (m) => void errors.push(m),
      warn: (m) => void warns.push(m),
    },
    schedule: (fn) => void queue.push(fn),
  });

  return {
    journal,
    transport,
    channel,
    server,
    sendHistoryResults,
    servedFrames,
    errors,
    warns,
    flush: () => {
      while (queue.length > 0) queue.shift()!();
    },
  };
}

/** Durable reasoning rows via the REAL egress seam (`#242` half 1's close frame). */
function seedReasoningBursts(h: Harness, count: number, textBytes: number): void {
  for (let i = 0; i < count; i++) {
    // `final: true` is what `delivery-journal-event.ts`'s `case "reasoning"`
    // admits; a draft frame is deliberately not durable.
    const ok = h.channel.sendReasoning(PEER, `r-${i}`, `turn-${i}`, "x".repeat(textBytes), true);
    expect(ok).toBe(true);
  }
}

/** Durable agent bubbles via the REAL egress seam — no `reasoningDurable` involved. */
function seedBubbles(h: Harness, count: number, textBytes: number): void {
  for (let i = 0; i < count; i++) {
    const ok = h.channel.sendText(PEER, "x".repeat(textBytes), `m-${i}`, `turn-${i}`);
    expect(ok).toBe(true);
  }
}

/** Forget the seeding traffic; from here `published` is the answer's frames only. */
function armAt(h: Harness, limit: number): void {
  h.transport.published.length = 0;
  h.transport.effectiveOutboundLimit = limit;
}

/** Frames the peer actually received on its `.out` subject. */
function outboundFrames(h: Harness): Array<{ subject: string; bytes: number }> {
  return h.transport.published.filter((p) => p.subject === OUT);
}

/**
 * The channel's OWN measurement primitive (`nats-channel.ts`'s
 * `outboundWireSize`) applied to the exact frame `sendHistory` would build.
 * This is the sealed length `publish` compares against `effectiveOutboundLimit`
 * — not a `JSON.stringify` estimate.
 */
function sealedHistoryBytes(h: Harness, messages: HistoryMessage[]): number {
  const size = h.channel.outboundWireSize(PEER, { type: "history", messages });
  if (size === undefined) throw new Error("no session key for peer — harness is wrong");
  return size;
}

/**
 * Same row, shorter body. Written per-variant so the union stays discriminated:
 * only the text and reasoning variants carry a `text` body to shorten; a tool or
 * approval row has none and is returned unchanged (no fixture here builds one).
 */
function withText(message: HistoryMessage, text: string): HistoryMessage {
  if (message.kind === "reasoning") return { ...message, text };
  if (message.kind === undefined) return { ...message, text };
  return message;
}

/** The row's text body, or "" for a tool or approval row (which have none). */
function bodyText(message: HistoryMessage): string {
  return message.kind === undefined || message.kind === "reasoning" ? message.text : "";
}

/**
 * The smallest per-row body (in bytes of text) at which this exact page of rows
 * seals to MORE than a stock `max_payload` — i.e. the smallest body at which
 * `publish` throws. Monotone in `s`, so a bisection is exact.
 */
function crossingTextBytes(h: Harness, page: HistoryMessage[], hi: number): number {
  const sealedAt = (s: number): number =>
    sealedHistoryBytes(h, page.map((m) => withText(m, bodyText(m).slice(0, s))));
  expect(sealedAt(0)).toBeLessThanOrEqual(STOCK_MAX_PAYLOAD);
  expect(sealedAt(hi)).toBeGreaterThan(STOCK_MAX_PAYLOAD);
  let lo = 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sealedAt(mid) > STOCK_MAX_PAYLOAD) hi = mid;
    else lo = mid;
  }
  return hi;
}

describe("#311 — an oversized history frame is SHORTENED, never lost", () => {
  /** The ids of the rows the peer's frame actually carries. */
  const servedIds = (h: Harness, call = 0): string[] =>
    h.servedFrames[call].map((m) => m.id);

  it("publishes the NEWEST rows that fit when the snapshot exceeds max_payload", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    // Seeding ran at `SEEDING_LIMIT`; the bound below is armed only for the
    // READ, and it is one that a single live frame still fits under but six
    // rows aggregated into one history frame do not.
    armAt(h, 32 * 1024);
    h.server.sendSnapshot(PEER);
    h.flush();

    // ⚠️ SHORT, NOT ABSENT — the property this whole issue is about. Exactly one
    // frame reached the peer, and it fits.
    const frames = outboundFrames(h);
    expect(frames).toHaveLength(1);
    expect(frames[0].bytes).toBeLessThanOrEqual(32 * 1024);
    expect(h.sendHistoryResults).toEqual([true]);
    // Nothing was refused, so the channel's egress diagnostic never fired.
    expect(error).not.toHaveBeenCalled();

    // The NEWEST rows, in order, as a contiguous suffix of the conversation.
    expect(servedIds(h)).toEqual(["r-1", "r-2", "r-3", "r-4", "r-5"]);

    // ⚠️ AND IT IS MAXIMAL, not merely "some suffix". Adding the one row the
    // budget left out puts the frame over the bound — checked with the
    // channel's own sealed measurement, so this pins "as many of the newest as
    // fit" rather than "an arbitrary number of them".
    const oneMore = [{ ...h.servedFrames[0][0], id: "r-0" }, ...h.servedFrames[0]];
    expect(sealedHistoryBytes(h, oneMore)).toBeGreaterThan(32 * 1024);
  });

  it("says the page was shortened, at warn, and does not call it data loss", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    armAt(h, 32 * 1024);
    h.server.sendSnapshot(PEER);
    h.flush();

    // ⚠️ THE SILENCE IS GONE. Before #311 this whole read logged NOTHING while
    // the peer got NOTHING; `history-serve.ts` never saw `sendHistory`'s
    // `false`. Now the module that owns the read reports what it did.
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain("history snapshot");
    expect(h.warns[0]).toContain("was shortened");
    expect(h.warns[0]).toContain("1 older row(s) left out");
    expect(h.warns[0]).toContain("reachable with load_history");
    expect(h.warns[0]).toContain(PEER);
    // ⚠️ `warn`, NOT `error`, and nothing was undeliverable: the trimmed row is
    // one `load_history` away. An operator reading this as deletion would go
    // hunting for a corruption that is not there.
    expect(h.errors).toEqual([]);
  });

  it("CONTROL: the same journal and the same rows arrive WHOLE once the bound fits", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    armAt(h, STOCK_MAX_PAYLOAD);
    h.server.sendSnapshot(PEER);
    h.flush();

    // Identical store, identical projection — the ONLY difference from the two
    // tests above is the byte bound. So the shortening is a byte decision, not
    // a read one, and a page that fits is never touched.
    expect(outboundFrames(h)).toHaveLength(1);
    expect(h.sendHistoryResults).toEqual([true]);
    expect(servedIds(h)).toEqual(["r-0", "r-1", "r-2", "r-3", "r-4", "r-5"]);
    expect(h.warns).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("the PAGE path is shortened the same way — this is not snapshot-only", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    armAt(h, 32 * 1024);
    h.server.servePage(PEER, {});
    h.flush();

    expect(outboundFrames(h)).toHaveLength(1);
    expect(h.sendHistoryResults).toEqual([true]);
    expect(servedIds(h)).toEqual(["r-1", "r-2", "r-3", "r-4", "r-5"]);
    expect(h.warns[0]).toContain("history page");
  });

  it("PAGING REACHES THE TRIMMED ROWS — the cost of shortening is zero reach", () => {
    // ⚠️ THE JUSTIFICATION FOR TRIMMING, EXERCISED RATHER THAN ASSERTED. Rows
    // dropped from the OLD end are exactly what the next `load_history`
    // returns, because this module's other entry point IS the pager. If that
    // were not true, shortening would be data loss and chunking would have been
    // the only honest fix.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    armAt(h, 32 * 1024);
    h.server.sendSnapshot(PEER);
    h.flush();
    expect(servedIds(h)).toEqual(["r-1", "r-2", "r-3", "r-4", "r-5"]);

    // The client asks for what came before the oldest row it was given.
    h.server.servePage(PEER, { before: servedIds(h)[0] });
    h.flush();
    expect(servedIds(h, 1)).toEqual(["r-0"]);
  });

  it("reports a send the channel REFUSES, instead of discarding the boolean", () => {
    // The budget declines to act when even an EMPTY frame exceeds the limit —
    // no subset of rows can help, and answering `[]` would impersonate an empty
    // conversation to its owner. The page is handed on, the channel refuses it,
    // and THAT is what must not be silent: before #311 this exact `false` was
    // dropped at both call sites.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    armAt(h, 10);
    h.server.sendSnapshot(PEER);
    h.flush();

    expect(outboundFrames(h)).toEqual([]);
    expect(h.sendHistoryResults).toEqual([false]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("history snapshot publish failed");
    expect(h.errors[0]).toContain("refused a 6-row frame");
    expect(h.errors[0]).toContain(PEER);
    // The channel logged its own generic line too; the point is that the module
    // owning the read no longer depends on someone reading that one.
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("#311 — THE MEASUREMENT: where a page crosses a stock 1 MiB max_payload", () => {
  /**
   * MEASURED, at `DEFAULT_HISTORY_CONFIG.limit` = 50 and an encrypted channel:
   * a 50-row reasoning page seals to 1 048 640 bytes — 64 past a stock 1 MiB —
   * at 15 651 bytes of text per row (15.3 KiB), and to 1 048 573 one byte of
   * text per row below that.
   *
   * ⚠️ THE SEALED WIRE IS ~4/3 OF THE JSON, so `journal-history.ts`'s "~21 KB"
   * is the PLAINTEXT arithmetic and OVERSTATES how much text it takes.
   * `e2e-envelope.ts` base64url-encodes the ciphertext into a JSON envelope, and
   * `publish` measures the sealed buffer, so the real bar for an encrypted
   * (register-hop, i.e. production) channel is a quarter lower.
   *
   * 15 KiB of reasoning per burst is not an exotic figure — it is a few hundred
   * lines of thinking on one turn.
   */
  it("50 reasoning rows (the DEFAULT snapshot) cross 1 MiB at ~15 KiB of text each", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    const ROWS = DEFAULT_HISTORY_CONFIG.limit;
    expect(ROWS).toBe(50);
    seedReasoningBursts(h, ROWS, 32 * 1024);

    armAt(h, SEEDING_LIMIT);
    h.server.sendSnapshot(PEER);
    h.flush();
    const page = h.servedFrames[0];
    expect(page).toHaveLength(ROWS);

    const crossing = crossingTextBytes(h, page, 32 * 1024);
    // MEASURED: 15 651. The band is ±5% so a harmless change in row metadata
    // does not fail the file, while a change of ORDER (a byte budget landing,
    // sealing getting cheaper) does.
    expect(crossing).toBeGreaterThan(14_868);
    expect(crossing).toBeLessThan(16_434);

    // The two numbers the issue wanted: what the page seals to at the crossing,
    // and one byte of text per row below it.
    const atCrossing = sealedHistoryBytes(h, page.map((m) => withText(m, bodyText(m).slice(0, crossing))));
    const belowCrossing = sealedHistoryBytes(
      h,
      page.map((m) => withText(m, bodyText(m).slice(0, crossing - 1))),
    );
    expect(atCrossing).toBeGreaterThan(STOCK_MAX_PAYLOAD);
    expect(belowCrossing).toBeLessThanOrEqual(STOCK_MAX_PAYLOAD);
  });

  it("END TO END: a 50-row snapshot past the crossing arrives SHORT, not empty", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    // 16 KiB per burst — just past the crossing measured above, and a plausible
    // amount of reasoning for one turn.
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, DEFAULT_HISTORY_CONFIG.limit, 16 * 1024);

    armAt(h, STOCK_MAX_PAYLOAD);
    h.server.sendSnapshot(PEER);
    h.flush();

    // Before #311 this published nothing at all. Now it publishes one frame
    // under the bound, carrying the newest rows.
    const frames = outboundFrames(h);
    expect(frames).toHaveLength(1);
    expect(frames[0].bytes).toBeLessThanOrEqual(STOCK_MAX_PAYLOAD);
    expect(h.sendHistoryResults).toEqual([true]);
    expect(error).not.toHaveBeenCalled();

    const served = h.servedFrames[0];
    expect(served.length).toBeGreaterThan(40);
    expect(served.length).toBeLessThan(DEFAULT_HISTORY_CONFIG.limit);
    // Newest-first-kept: the last row of the conversation is always present.
    expect(served[served.length - 1].id).toBe("r-49");
    expect(h.warns[0]).toContain("was shortened");
    expect(h.errors).toEqual([]);
  });

  /**
   * ⚠️ WHO IS EXPOSED — AND IT IS NOT ONLY `reasoningDurable` ACCOUNTS.
   *
   * `MAX_WIRE_HISTORY_LIMIT` (1000) is the clamp `planHistoryFetch` applies to
   * the PEER-SUPPLIED `load_history` limit, so any client may ask for a
   * 1000-row page with no operator configuration at all. At 1000 rows the
   * per-row budget is ~1 KiB, which MEASURES to 734 bytes of body text (sealing
   * to 1 049 453; 1 048 120 at 733) — an utterly ordinary agent answer, about a
   * paragraph. So the overflow is reachable on plain chat bubbles with
   * `capabilities.reasoningDurable` OFF, which is its shipped default: the
   * exposed set was every account, not only the ones that opted in.
   */
  it("1000 ORDINARY BUBBLES at MAX_WIRE_HISTORY_LIMIT cross 1 MiB at ~734 bytes each", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    seedBubbles(h, MAX_WIRE_HISTORY_LIMIT, 2048);

    armAt(h, SEEDING_LIMIT);
    // Peer-driven: `planHistoryFetch` clamps this to MAX_WIRE_HISTORY_LIMIT.
    h.server.servePage(PEER, { limit: 100_000 });
    h.flush();
    const page = h.servedFrames[0];
    expect(page).toHaveLength(MAX_WIRE_HISTORY_LIMIT);
    // No reasoning rows exist here at all — `reasoningDurable` is off.
    expect(page.every((m) => m.kind === undefined)).toBe(true);

    const crossing = crossingTextBytes(h, page, 2048);
    // MEASURED: 734 bytes of text per bubble, ±5%.
    expect(crossing).toBeGreaterThan(697);
    expect(crossing).toBeLessThan(771);
  });

  it("END TO END: a 1000-bubble page of 800-byte answers arrives SHORT, not empty", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    seedBubbles(h, MAX_WIRE_HISTORY_LIMIT, 800);

    armAt(h, STOCK_MAX_PAYLOAD);
    h.server.servePage(PEER, { limit: MAX_WIRE_HISTORY_LIMIT });
    h.flush();

    const frames = outboundFrames(h);
    expect(frames).toHaveLength(1);
    expect(frames[0].bytes).toBeLessThanOrEqual(STOCK_MAX_PAYLOAD);
    expect(h.sendHistoryResults).toEqual([true]);
    expect(error).not.toHaveBeenCalled();

    const served = h.servedFrames[0];
    expect(served.length).toBeLessThan(MAX_WIRE_HISTORY_LIMIT);
    expect(served[served.length - 1].id).toBe("m-999");
    expect(h.warns[0]).toContain("history page");
    expect(h.warns[0]).toContain("was shortened");
  });
});

describe("#311 — a row too big to send is SKIPPED, and the page spans across it", () => {
  /**
   * MEASURED: one reasoning row on its own seals past a stock 1 MiB at 786 160
   * bytes of text (768 KiB) — 1 048 577 sealed at that length, exactly 1 048 576
   * one byte below.
   *
   * Nothing caps the LENGTH of a durable body. `sendToPeer` journals BEFORE it
   * publishes (#239, the persist-before-publish seam), so a body larger than
   * `max_payload` is committed to the store and only THEN fails to reach the
   * peer live.
   *
   * ⚠️ WHICH IS EXACTLY WHY SKIPPING IT IS NOT AN N8 DIVERGENCE. The row is in the store
   * BECAUSE its own live send hit the same `RangeError` at the same limit — the
   * peer never saw it. Leaving it out of history PRESERVES `history == live`;
   * it is a shrinking page that would break it. And a byte budget alone cannot
   * help here: a page of ONE row is still over the bound, so without the skip
   * the row is a permanent wall the pager can never get behind.
   */
  it("skips the undeliverable row, serves the rest, and names it at error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });

    // Rows on BOTH sides of the poison one, so this is the mid-page case rather
    // than a truncation that happens to look right.
    seedReasoningBursts(h, 2, 1024);
    h.transport.effectiveOutboundLimit = STOCK_MAX_PAYLOAD;
    const huge = "x".repeat(STOCK_MAX_PAYLOAD + 1);
    expect(h.channel.sendReasoning(PEER, "r-big", "turn-big", huge, true)).toBe(false);
    h.transport.effectiveOutboundLimit = SEEDING_LIMIT;
    for (let i = 0; i < 2; i++) {
      expect(h.channel.sendReasoning(PEER, `late-${i}`, `turn-late-${i}`, "y".repeat(1024), true))
        .toBe(true);
    }

    // The live send of the big row was refused, and the row was written anyway:
    // the journal hook sits above the publish.
    expect(h.journal.read(PEER)).toHaveLength(5);

    error.mockClear();
    armAt(h, STOCK_MAX_PAYLOAD);
    h.server.sendSnapshot(PEER);
    h.flush();

    // ⚠️ THE PAGE SPANS ACROSS IT: rows older AND newer than the undeliverable
    // one arrive in one frame, in order. Without the skip the budget stops at
    // `r-big` and every page ends there forever.
    expect(outboundFrames(h)).toHaveLength(1);
    expect(h.sendHistoryResults).toEqual([true]);
    expect(h.servedFrames[0].map((m) => m.id)).toEqual(["r-0", "r-1", "late-0", "late-1"]);

    // Operator-actionable, at error, naming the row and its measured size.
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("history snapshot skipped 1 undeliverable row(s)");
    expect(h.errors[0]).toContain("r-big");
    expect(h.errors[0]).toContain("#311");
    expect(h.errors[0]).toContain(PEER);
    // Not a trim: nothing was left out for budget reasons here.
    expect(h.warns).toEqual([]);
  });

  it("a conversation of NOTHING BUT undeliverable rows sends no snapshot, loudly", () => {
    // The frame would be empty, and an empty SNAPSHOT is suppressed exactly as
    // it always was — an empty chat is what the peer sees either way. What must
    // not happen is that it is silent: the `error` above is the only place this
    // fact exists, because the wire has no "history unavailable" signal (#296).
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });

    h.transport.effectiveOutboundLimit = STOCK_MAX_PAYLOAD;
    for (let i = 0; i < 2; i++) {
      expect(h.channel.sendReasoning(
        PEER,
        `r-big-${i}`,
        `turn-big-${i}`,
        "x".repeat(STOCK_MAX_PAYLOAD + 1),
        true,
      )).toBe(false);
    }

    error.mockClear();
    armAt(h, STOCK_MAX_PAYLOAD);
    h.server.sendSnapshot(PEER);
    h.flush();

    expect(outboundFrames(h)).toEqual([]);
    expect(h.sendHistoryResults).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("skipped 2 undeliverable row(s)");
    expect(h.errors[0]).toContain("r-big-0");
    expect(h.errors[0]).toContain("r-big-1");
  });
});
