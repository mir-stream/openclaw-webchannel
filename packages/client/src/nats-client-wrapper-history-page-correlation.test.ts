import { describe, expect, it } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";

/**
 * #401 — a load-older page belongs to the device that asked for it.
 *
 * Telegram answers `messages.getHistory` on the requesting session only. Our
 * page rides the peer's shared `.out`, so every device of the peer receives it,
 * and `case "history"` inserts rows it does not hold at the head of the view. A
 * device whose window differs from the requester's therefore used to prepend a
 * page that is not contiguous with it — and its own "load older", which pages
 * from the view's oldest row, could never reach the rows in between.
 *
 * These suites drive two real wrappers (two devices of one peer) through the
 * private inbound dispatcher, with no socket: a `load_history` request stays on
 * the inner client's `outboundQueue`, which is where its nonce is read from.
 */

type Frame = { type: string; [k: string]: unknown };
type Row = { id: string; role: string; text: string };

function device(): WebChannelNATSClient {
  return new WebChannelNATSClient({
    natsUrl: "ws://127.0.0.1:4222",
    bootstrapJwt: "eyJ-bootstrap",
    accountId: "a",
    tenant: "t",
    peerId: "p",
    registration: {
      devicePrivateKey: {} as CryptoKey,
      deviceX25519PrivateKey: {} as CryptoKey,
    },
  });
}

function deliver(wrapper: WebChannelNATSClient, frame: Frame): void {
  (wrapper as unknown as { handleMessage: (m: Frame) => void }).handleMessage(frame);
}

/** Deliver one frame to every device of the peer — the shared `.out`. */
function broadcast(devices: WebChannelNATSClient[], frame: Frame): void {
  for (const d of devices) deliver(d, frame);
}

/** Agent rows `a<from>..a<to>`, oldest first — the server's projected order. */
function rows(from: number, to: number): Row[] {
  const out: Row[] = [];
  for (let n = from; n <= to; n++) out.push({ id: `a${n}`, role: "agent", text: `${n}` });
  return out;
}

/** The register-time snapshot: carries the high-water, meant for every device. */
function snapshot(from: number, to: number): Frame {
  return { type: "history", highWaterSeq: to, messages: rows(from, to) };
}

/** Load older from `before`; returns the nonce this device put on the wire. */
function loadOlder(wrapper: WebChannelNATSClient, before: string): string | undefined {
  wrapper.loadHistory({ before });
  const queue = (wrapper as unknown as {
    client: { outboundQueue: Array<Record<string, unknown>> };
  }).client.outboundQueue;
  const frame = queue.filter((m) => m.type === "load_history").at(-1);
  expect(frame?.before).toBe(before);
  return frame?.nonce as string | undefined;
}

function ids(wrapper: WebChannelNATSClient): string[] {
  return wrapper.getState().messages.map((m) => m.id);
}

function range(from: number, to: number): string[] {
  return rows(from, to).map((r) => r.id);
}

describe("#401 — a page folds only on the device that asked for it", () => {
  it("the audit repro: another device's page leaves no hole in a different window", () => {
    const a = device();
    const b = device();
    // B connected first and already paged once; A connected later, so the two
    // windows differ: B holds a101..a200, A holds only its snapshot a151..a200.
    deliver(b, snapshot(151, 200));
    const first = loadOlder(b, "a151");
    deliver(b, { type: "history", messages: rows(101, 150), nonce: first });
    deliver(a, snapshot(151, 200));
    expect(ids(b)).toEqual(range(101, 200));
    expect(ids(a)).toEqual(range(151, 200));

    // B pages again. The answer rides the shared `.out` to BOTH devices.
    const second = loadOlder(b, "a101");
    broadcast([a, b], { type: "history", messages: rows(51, 100), nonce: second });

    // B — the requester — folds it, exactly as before (no load-older regression).
    expect(ids(b)).toEqual(range(51, 200));
    // A did not ask. Pre-#401 it became a51..a100 + a151..a200 with oldest cursor
    // a51, and its "load older" could never reach a101..a150.
    expect(ids(a)).toEqual(range(151, 200));

    // A's own load older still pages from ITS oldest row and closes the range.
    const own = loadOlder(a, "a151");
    broadcast([a, b], { type: "history", messages: rows(101, 150), nonce: own });
    expect(ids(a)).toEqual(range(101, 200));
    expect(ids(b)).toEqual(range(51, 200));
  });

  it("a snapshot is every device's: it is folded with no request outstanding", () => {
    const a = device();
    deliver(a, snapshot(1, 3));
    expect(ids(a)).toEqual(range(1, 3));
  });

  it("a foreign nonce does not consume this device's own outstanding request", () => {
    const a = device();
    deliver(a, snapshot(4, 6));
    const own = loadOlder(a, "a4");
    expect(own).toEqual(expect.any(String));

    deliver(a, { type: "history", messages: rows(1, 1), nonce: `${own}-other` });
    expect(ids(a)).toEqual(range(4, 6));

    deliver(a, { type: "history", messages: rows(1, 3), nonce: own });
    expect(ids(a)).toEqual(range(1, 6));
    // Answered once: a replay of the same page under the same nonce is not ours.
    deliver(a, { type: "history", messages: rows(0, 0), nonce: own });
    expect(ids(a)).toEqual(range(1, 6));
  });

  it("each request carries a fresh nonce on the wire", () => {
    const a = device();
    const n1 = loadOlder(a, "a10");
    const n2 = loadOlder(a, "a10");
    expect(n1).toEqual(expect.any(String));
    expect(n2).toEqual(expect.any(String));
    expect(n1).not.toBe(n2);
  });

  it("remembers a bounded number of outstanding requests, dropping the oldest", () => {
    const a = device();
    deliver(a, snapshot(100, 100));
    const nonces = Array.from({ length: 10 }, () => loadOlder(a, "a100"));

    // The first of ten fell off the bound of nine.
    deliver(a, { type: "history", messages: rows(99, 99), nonce: nonces[0] });
    expect(ids(a)).toEqual(range(100, 100));
    deliver(a, { type: "history", messages: rows(99, 99), nonce: nonces[1] });
    expect(ids(a)).toEqual(range(99, 100));
  });
});

describe("#401 — a page this device did not ask for", () => {
  it("a page with no nonce is never folded, even with a request outstanding", () => {
    // Protocol 7's exact-match gate means the plugin echoes every nonce this
    // wrapper sends; an un-nonced page answers some other client's request.
    const a = device();
    deliver(a, snapshot(10, 10));
    const own = loadOlder(a, "a10");
    deliver(a, { type: "history", messages: rows(1, 1) });
    expect(ids(a)).toEqual(range(10, 10));
    // ...and this device's own answer is still waiting and folds.
    deliver(a, { type: "history", messages: rows(9, 9), nonce: own });
    expect(ids(a)).toEqual(range(9, 10));
  });

  it("still adopts this device's own send from it, inserting nothing", () => {
    // `hydrateHistory` runs the explicit `randomId` adoption before the claim
    // gates the row fold: re-keying a bubble this device already holds cannot
    // open a hole, and another device's page may be the first to carry the id.
    const a = device();
    deliver(a, snapshot(10, 10));
    const receipt = a.send("hello")!;
    const randomId = [...(a as unknown as { randomIdToReceiptKey: Map<string, string> })
      .randomIdToReceiptKey].find(([, key]) => key === receipt.id)![0];

    deliver(a, { type: "history", nonce: "another-device", messages: [
      ...rows(1, 1),
      { id: "server-hello", role: "user", text: "hello", randomId },
    ] });

    const messages = a.getState().messages;
    expect(messages.map((m) => m.id)).toEqual(["a10", "server-hello"]);
    expect(messages[1]).toMatchObject({ role: "user", text: "hello", receiptKey: receipt.id });
  });
});
