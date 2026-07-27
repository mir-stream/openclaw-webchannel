import { Buffer } from "node:buffer";

export const MAX_INGRESS_RESULT_IDS = 64;
export const MAX_INGRESS_RESULT_WIRE_BYTES = 64 * 1024;
export const MAX_INGRESS_RESULT_ID_LENGTH = 128;

export type IngressResultFrame =
  | { type: "ack"; ids: string[] }
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

  const frameFor = (values: string[]): IngressResultFrame => options.type === "ack"
    ? { type: "ack", ids: values }
    : { type: "inbound_rejected", ids: values, reason: "overloaded" };

  const flush = (): boolean => {
    if (ids.length === 0) return true;
    const frame = frameFor(ids);
    const sent = options.publish(frame);
    ok = sent && ok;
    ids = [];
    inChunk = new Set();
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
