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
 */
export type CommittedUserMessage = { random_id: string; messageId: string };

export type IngressResultFrame =
  | { type: "ack"; ids: string[]; committed?: CommittedUserMessage[] }
  | { type: "inbound_rejected"; ids: string[]; reason: "overloaded" };

export type IngressResultChunkWriter = {
  add(id: unknown): boolean;
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
 * Set is retained. Each frame deduplicates only its own at-most-64 ids.
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
  let ok = true;
  // One-shot: attached to the first `ack` frame `flush` publishes, then cleared
  // so later frames in a chunked batch do not repeat it. `frameFor` reads it, so
  // the frame the wire limit is measured against already includes it.
  let committedPending: CommittedUserMessage[] =
    options.type === "ack" && options.committed && options.committed.length > 0
      ? options.committed
      : [];

  const frameFor = (values: string[]): IngressResultFrame => options.type === "ack"
    ? { type: "ack", ids: values, ...(committedPending.length > 0 ? { committed: committedPending } : {}) }
    : { type: "inbound_rejected", ids: values, reason: "overloaded" };

  const flush = (): boolean => {
    if (ids.length === 0) return true;
    const frame = frameFor(ids);
    const sent = options.publish(frame);
    ok = sent && ok;
    ids = [];
    inChunk = new Set();
    // The echo has now ridden a frame; every subsequent frame omits it.
    committedPending = [];
    return sent;
  };

  const add = (candidate: unknown): boolean => {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_INGRESS_RESULT_ID_LENGTH) {
      return false;
    }
    if (inChunk.has(candidate)) return true;
    if (ids.length >= maxIds) flush();
    let next = [...ids, candidate]; // bounded to maxIds (64)
    let bytes = measure(frameFor(next));
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("wire measurement is invalid");
    if (bytes > effectiveLimit && ids.length > 0) {
      flush();
      next = [candidate];
      bytes = measure(frameFor(next));
    }
    if (bytes > effectiveLimit) {
      options.onTooSmall?.();
      ok = false;
      return false;
    }
    ids = next;
    inChunk.add(candidate);
    return true;
  };

  return { add, finish: () => { flush(); return ok; }, retainedIds: () => ids.length };
}
