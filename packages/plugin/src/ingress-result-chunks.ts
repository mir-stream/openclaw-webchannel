import { Buffer } from "node:buffer";

export const MAX_INGRESS_RESULT_IDS = 64;
export const MAX_INGRESS_RESULT_WIRE_BYTES = 64 * 1024;
export const MAX_INGRESS_RESULT_ID_LENGTH = 128;

/**
 * #243 half 2a: the durable id the server assigned to a fresh (or deduped-retry)
 * user message, paired with the client `random_id` that keyed it. Rides the `ack`
 * frame — the frame that already tells the client "this inbound id was accepted"
 * is the natural place to also say "and here is the durable id we minted for it".
 * The client IGNORES it in 2a (adoption is half 2b); see `nats-client.ts`.
 *
 * #244 half A: `seq` carries the user message's per-conversation sequence. The
 * user turn-opener consumes a seq (`appendInboundUser`) but rides no durable wire
 * frame, so this echo is the only way the client learns it — without it the first
 * agent frame of every turn reads as a phantom gap (doc §16.2-6).
 */
export type CommittedUserMessage = { random_id: string; messageId: string; seq: number };

export type IngressResultFrame =
  // cancelled is durable proof for a subset of this frame's exact wire ids.
  | { type: "ack"; ids: string[]; committed?: CommittedUserMessage[]; cancelled?: string[] }
  | { type: "inbound_rejected"; ids: string[]; reason: "overloaded" };

export type IngressResultChunkWriter = {
  /** cancelled requires durable evidence and always rides this ID's frame. */
  add(id: unknown, cancelled?: boolean): boolean;
  finish(): boolean;
  retainedIds(): number;
};

export type IngressResultChunkOptions = {
  type: IngressResultFrame["type"];
  publish(frame: IngressResultFrame): boolean;
  /** Actual sealed wire measurement for this peer/route. */
  measureWireBytes?: (frame: IngressResultFrame) => number;
  effectiveOutboundLimit?: number;
  maxIds?: number;
  maxWireBytes?: number;
  onTooSmall?: () => void;
  /**
   * #243 half 2a: the batch's `random_id → messageId` echo, carried on the FIRST
   * published `ack` frame only (a one-shot) and then dropped. Ignored for
   * `inbound_rejected`.
   *
   * ⚠️ NOT SPLIT ALONGSIDE `ids`, ON PURPOSE. Each entry is SELF-CONTAINED (it
   * names its own `random_id`), so the client keys on it regardless of which ack
   * frame it arrives on — there is no id↔entry correspondence to preserve across
   * chunk boundaries. Riding one frame keeps it off the wire N times over when a
   * batch chunks, and the frame's wire size is measured WITH it (see `frameFor`),
   * so the fit invariant still holds.
   */
  committed?: CommittedUserMessage[];
};

/**
 * Exact base64url length for an AEAD ciphertext whose byte length equals its
 * plaintext length. Useful to build route-specific envelope estimators.
 */
export function base64UrlLength(bytes: number): number {
  const full = Math.floor(bytes / 3) * 4;
  const rem = bytes % 3;
  return full + (rem === 0 ? 0 : rem + 1);
}

/**
 * Stream result ids through a single bounded chunk. No whole-flush id array or
 * Set is retained. Each frame deduplicates only its own at-most-64 ids and carries
 * only their cancellation flags; no proof may be separated from its wire ID.
 */
export function createIngressResultChunkWriter(
  options: IngressResultChunkOptions,
): IngressResultChunkWriter {
  const maxIds = options.maxIds ?? MAX_INGRESS_RESULT_IDS;
  const effectiveLimit = Math.min(
    options.maxWireBytes ?? MAX_INGRESS_RESULT_WIRE_BYTES,
    options.effectiveOutboundLimit ?? Number.MAX_SAFE_INTEGER,
  );
  if (!Number.isSafeInteger(maxIds) || maxIds < 1) throw new TypeError("maxIds must be positive");
  if (!Number.isSafeInteger(effectiveLimit) || effectiveLimit < 0) throw new TypeError("effective outbound limit is invalid");
  const measure = options.measureWireBytes ?? ((frame: IngressResultFrame) =>
    Buffer.byteLength(JSON.stringify(frame), "utf8"));
  let ids: string[] = [];
  let inChunk = new Set<string>();
  let cancelledIds: string[] = [];
  let ok = true;
  // One-shot: attached to the first `ack` frame `flush` publishes, then cleared
  // so later frames in a chunked batch do not repeat it. `frameFor` reads it, so
  // the frame the wire limit is measured against already includes it.
  let committedPending: CommittedUserMessage[] =
    options.type === "ack" && options.committed && options.committed.length > 0
      ? options.committed
      : [];

  const frameFor = (values: string[], cancelled: string[]): IngressResultFrame => options.type === "ack"
    ? { type: "ack", ids: values, ...(committedPending.length > 0 ? { committed: committedPending } : {}),
      ...(cancelled.length > 0 ? { cancelled } : {}) }
    : { type: "inbound_rejected", ids: values, reason: "overloaded" };

  const flush = (): boolean => {
    if (ids.length === 0) return true;
    const frame = frameFor(ids, cancelledIds);
    const sent = options.publish(frame);
    ok = sent && ok;
    ids = [];
    inChunk = new Set();
    cancelledIds = [];
    // The echo has now ridden a frame; every subsequent frame omits it.
    committedPending = [];
    return sent;
  };

  const add = (candidate: unknown, cancelled = false): boolean => {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_INGRESS_RESULT_ID_LENGTH) {
      return false;
    }
    const proof = options.type === "ack" && cancelled;
    if (inChunk.has(candidate) && (!proof || cancelledIds.includes(candidate))) return true;
    if (!inChunk.has(candidate) && ids.length >= maxIds) flush();
    let next = inChunk.has(candidate) ? ids : [...ids, candidate]; // bounded to maxIds (64)
    let nextCancelled = proof ? [...cancelledIds, candidate] : cancelledIds;
    let bytes = measure(frameFor(next, nextCancelled));
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("wire measurement is invalid");
    if (bytes > effectiveLimit && ids.length > 0) {
      flush();
      next = [candidate];
      nextCancelled = proof ? [candidate] : [];
      bytes = measure(frameFor(next, nextCancelled));
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("wire measurement is invalid");
    }
    if (bytes > effectiveLimit) {
      options.onTooSmall?.();
      ok = false;
      return false;
    }
    ids = next;
    cancelledIds = nextCancelled;
    inChunk.add(candidate);
    return true;
  };

  return { add, finish: () => { flush(); return ok; }, retainedIds: () => ids.length };
}
