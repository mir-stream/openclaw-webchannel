/**
 * #311 — THE `history` FRAME IS BOUNDED BY ROW COUNT AND NEVER BY BYTES.
 *
 * ⚠️ THIS FILE PINS A DEFECT, NOT A CONTRACT. Every assertion below describes
 * what the code does TODAY. When #311's fix lands (a byte-aware page budget, or
 * chunking) these tests MUST be consciously rewritten — that is the point of
 * having them. Each one names the defect it is pinning at its assertion.
 *
 * WHY IT EXISTS: #311's body said "Not measured — the threshold above is
 * arithmetic from the configured limits, not an observed failure." These tests
 * are the measurement. They drive the REAL `createHistoryServer`
 * (`history-serve.ts`) over a REAL `openDeliveryJournal` fed through the REAL
 * egress seam (`NatsChannel.sendReasoning` / `sendText` →
 * `sendToPeer` → `journalOutbound`), against a transport that reproduces
 * `nats-transport.ts`'s ONE size check verbatim.
 *
 * ── THE MECHANISM, AS MEASURED HERE ──
 *
 *  1. `history-serve.ts`'s `sendSnapshot` asks for `{kind:"recent", limit:
 *     config.limit}` (default 50) and calls `channel.sendHistory(...)`;
 *     `servePage` does the same with the peer's clamped `limit`
 *     (`MAX_WIRE_HISTORY_LIMIT` = 1000).
 *  2. `NatsChannel.sendHistory` builds `{type:"history", messages}` and hands it
 *     to `sendToPeer`, which journals, seals, and publishes.
 *  3. `NatsTransport.publish` throws a `RangeError` when the sealed buffer is
 *     longer than `effectiveOutboundLimit` (stock nats-server: 1 MiB).
 *  4. `sendToPeer`'s own `catch` SWALLOWS that `RangeError`: one
 *     `console.error`, and `false` is returned.
 *  5. `history-serve.ts` ignores that `false`. So its "publish failed" branch
 *     never runs — that branch only catches a THROW out of `sendHistory`, and
 *     nothing throws.
 *
 * Net: the peer receives NO `history` frame at all — not a truncated one — and
 * `history-serve.ts`, the module that owns the read, says NOTHING. `sendSnapshot`
 * is the register-hop snapshot, so this repeats on every reconnect: the chat is
 * EMPTY, not merely "missing reasoning".
 *
 * ⚠️ A CORRECTION TO PROSE THAT SHIPPED. `journal-history.ts`'s
 * `recentHistoryPage` docblock says the `RangeError` is one "`history-serve.ts`
 * catches as 'publish failed'". It is NOT — step 4 above eats it first, and the
 * `logger.error` assertion in "the silence" test below is the proof. Same for
 * `history.ts`'s `MAX_WIRE_HISTORY_LIMIT` docblock, which says the same thing.
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

/** Same row, shorter body. Written per-variant so the union stays discriminated. */
function withText(message: HistoryMessage, text: string): HistoryMessage {
  return message.kind === "reasoning" ? { ...message, text } : { ...message, text };
}

/**
 * The smallest per-row body (in bytes of text) at which this exact page of rows
 * seals to MORE than a stock `max_payload` — i.e. the smallest body at which
 * `publish` throws. Monotone in `s`, so a bisection is exact.
 */
function crossingTextBytes(h: Harness, page: HistoryMessage[], hi: number): number {
  const sealedAt = (s: number): number =>
    sealedHistoryBytes(h, page.map((m) => withText(m, m.text.slice(0, s))));
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

describe("#311 — an oversized history frame is a BLACKOUT, not a truncation", () => {
  it("publishes NOTHING to the peer when the snapshot exceeds max_payload", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    // Seeding ran at `SEEDING_LIMIT`; the bound below is armed only for the
    // READ, and it is one that a single live frame still fits under (asserted at
    // the end) but six rows aggregated into one history frame do not.
    armAt(h, 32 * 1024);
    h.server.sendSnapshot(PEER);
    h.flush();

    // ⚠️ THE DEFECT, PINNED. Not a short frame — NO frame. The peer's chat is
    // empty on this reconnect and on every one after it.
    expect(outboundFrames(h)).toEqual([]);
    // The read itself was fine and produced all six rows; only the wire refused.
    expect(h.servedFrames).toHaveLength(1);
    expect(h.servedFrames[0]).toHaveLength(6);
    // `sendHistory` reported the failure the only way it can — and
    // `history-serve.ts` drops this value on the floor at both call sites.
    expect(h.sendHistoryResults).toEqual([false]);
    // The `RangeError` died here: `sendToPeer`'s catch, one console line.
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("Failed to send to peer");

    // ⚠️ AND THE CHANNEL IS NOT SIMPLY DOWN. Under the SAME bound a live frame
    // of the same content still reaches the peer, so this is specifically the
    // AGGREGATED history frame that cannot be delivered — live keeps working
    // while the reconnect view stays empty, which is why nobody notices.
    expect(h.channel.sendReasoning(PEER, "r-live", "turn-live", "x".repeat(4 * 1024), true))
      .toBe(true);
    expect(outboundFrames(h)).toHaveLength(1);
  });

  it("CONTROL: the same journal and the same rows publish once the bound fits", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    armAt(h, STOCK_MAX_PAYLOAD);
    h.server.sendSnapshot(PEER);
    h.flush();

    // Identical store, identical projection, identical row count — the ONLY
    // difference from the test above is the byte bound. That is what makes the
    // blackout a byte problem rather than a read problem.
    expect(outboundFrames(h)).toHaveLength(1);
    expect(h.sendHistoryResults).toEqual([true]);
    expect(h.servedFrames[0]).toHaveLength(6);
  });

  it("the page path blacks out identically — it is not snapshot-only", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    armAt(h, 32 * 1024);
    h.server.servePage(PEER, {});
    h.flush();

    expect(outboundFrames(h)).toEqual([]);
    expect(h.sendHistoryResults).toEqual([false]);
  });
});

describe("#311 — `history-serve.ts` never learns that the frame was lost", () => {
  it("logs NOTHING: not 'publish failed', not anything", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, 6, 4 * 1024);

    armAt(h, 32 * 1024);
    h.server.sendSnapshot(PEER);
    h.flush();

    // ⚠️ THIS EMPTINESS IS THE FINDING (#311). `history-serve.ts`'s
    // "publish failed" branch guards `emit(messages)` and only fires on a THROW
    // out of `sendHistory` — but `NatsChannel.sendToPeer` catches the
    // transport's `RangeError` itself and returns `false`, and both
    // `sendSnapshot` and `servePage` ignore the return value. So the module
    // that owns the read believes it succeeded.
    //
    // WHEN #311 IS FIXED THIS ASSERTION MUST CHANGE, and that is deliberate:
    // whatever the fix is (a byte budget that shrinks the page, or chunking),
    // a frame that still cannot be delivered has to become visible here.
    expect(h.errors).toEqual([]);
    expect(h.warns).toEqual([]);
    // The projection was reported HEALTHY on the way past — nothing was
    // unfoldable, so `reportProjectionHealth` had nothing to say either.
    expect(h.servedFrames[0]).toHaveLength(6);
    // The only trace anywhere is one `console.error` inside the channel. It is
    // the GENERIC egress diagnostic — it does not carry `history-serve.ts`'s
    // label, so nothing in the logs says a history read was lost.
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain("[nats-channel] Failed to send to peer");
    expect(line).not.toContain("history snapshot publish failed");
    expect(line).not.toContain("history snapshot journal read failed");
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
    const atCrossing = sealedHistoryBytes(h, page.map((m) => withText(m, m.text.slice(0, crossing))));
    const belowCrossing = sealedHistoryBytes(
      h,
      page.map((m) => withText(m, m.text.slice(0, crossing - 1))),
    );
    expect(atCrossing).toBeGreaterThan(STOCK_MAX_PAYLOAD);
    expect(belowCrossing).toBeLessThanOrEqual(STOCK_MAX_PAYLOAD);
  });

  it("END TO END: a 50-row snapshot at the crossing size really is a blackout", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    // 16 KiB per burst — just past the crossing measured above, and a plausible
    // amount of reasoning for one turn.
    const h = harness({ reasoningDurable: true });
    seedReasoningBursts(h, DEFAULT_HISTORY_CONFIG.limit, 16 * 1024);

    armAt(h, STOCK_MAX_PAYLOAD);
    h.server.sendSnapshot(PEER);
    h.flush();

    expect(h.servedFrames[0]).toHaveLength(50);
    expect(outboundFrames(h)).toEqual([]);
    expect(h.sendHistoryResults).toEqual([false]);
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
   * paragraph. So the blackout is reachable on plain chat bubbles with
   * `capabilities.reasoningDurable` OFF, which is its shipped default: the
   * exposed set is every account, not only the ones that opted in.
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

  it("END TO END: a 1000-bubble page of 800-byte answers is a blackout", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    seedBubbles(h, MAX_WIRE_HISTORY_LIMIT, 800);

    armAt(h, STOCK_MAX_PAYLOAD);
    h.server.servePage(PEER, { limit: MAX_WIRE_HISTORY_LIMIT });
    h.flush();

    expect(h.servedFrames[0]).toHaveLength(MAX_WIRE_HISTORY_LIMIT);
    expect(outboundFrames(h)).toEqual([]);
    expect(h.sendHistoryResults).toEqual([false]);
    expect(h.errors).toEqual([]);
  });
});

describe("#311 — ONE row can be oversized on its own, and it is a permanent poison", () => {
  /**
   * MEASURED: one reasoning row on its own seals past a stock 1 MiB at 786 160
   * bytes of text (768 KiB) — 1 048 577 sealed at that length, exactly 1 048 576
   * one byte below.
   *
   * Nothing caps the LENGTH of a durable body. `sendToPeer` journals BEFORE it
   * publishes (#239, the persist-before-publish seam), so a body larger than
   * `max_payload` is committed to the store and only THEN fails to reach the
   * peer live. From that moment every history read whose window includes that
   * row blacks out — and no row count, however small, can page around it. A
   * byte budget that shrinks the page therefore cannot fix this case on its
   * own; a `limit` of 1 still exceeds the bound.
   */
  it("journals an over-max_payload reasoning burst, then blacks out every read of it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness({ reasoningDurable: true, config: { limit: 1, pageSize: 1 } });

    h.transport.effectiveOutboundLimit = STOCK_MAX_PAYLOAD;
    // One burst whose text alone exceeds a stock max_payload.
    expect(h.channel.sendReasoning(PEER, "r-big", "turn-big", "x".repeat(STOCK_MAX_PAYLOAD + 1), true))
      .toBe(false);
    // The LIVE frame never reached the peer...
    expect(outboundFrames(h)).toEqual([]);
    // ...and the row was written anyway, because the journal hook sits above the
    // publish. This is the persist-before-publish window, working as designed.
    expect(h.journal.read(PEER)).toHaveLength(1);

    error.mockClear();
    h.transport.published.length = 0;
    h.server.sendSnapshot(PEER);
    h.flush();

    // A one-row page. Still oversized, still silent.
    expect(h.servedFrames[0]).toHaveLength(1);
    expect(outboundFrames(h)).toEqual([]);
    expect(h.sendHistoryResults).toEqual([false]);
    expect(h.errors).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
