/**
 * Proof-of-Possession (PoP) signed-nonce challenge — gap ①.
 *
 * Binds peer registration to the device's signing key so a stolen/forwarded
 * bootstrap JWT alone cannot register a peer: the caller must prove possession
 * of the device PRIVATE key by signing a server-issued, single-use, short-TTL
 * nonce.
 *
 * Key model (standard RFC 7800 split): the bootstrap JWT carries the device's
 * Ed25519 PoP PUBLIC key (OKP/Ed25519) in the `pop_jwk` claim. The X25519
 * `cnf.jwk` is a separate key (E2E encryption + handshake pinning) and is NOT a
 * signing key, so PoP needs its own Ed25519 key.
 *
 * Flow (over NATS request/reply on the account's `…{peerId}.register` subject):
 *   1. `{op:"challenge", token}` → server issues a nonce bound to peerId
 *      (single-use, short TTL).
 *   2. Browser signs `popSignedMessage(peerId, nonce)` with the Ed25519 device
 *      private key.
 *   3. `{op:"register", token, nonce, signature}` → server verifies the signature
 *      against the JWT's `pop_jwk`. Missing/invalid/expired/replayed → rejected.
 */

import { randomBytes, createPublicKey, verify as edVerify } from "node:crypto";

/** Ed25519 public key in JWK form (OKP / Ed25519). */
export type PopPublicJwk = {
  kty: string;
  crv: string;
  /** base64url-encoded 32-byte Ed25519 public key. */
  x: string;
};

export type PopVerifyResult = {
  ok: boolean;
  reason:
    | "verified"
    | "nonce-missing"
    | "nonce-expired"
    | "not-ed25519"
    | "bad-jwk"
    | "bad-signature-encoding"
    | "signature-mismatch";
};

const DEFAULT_TTL_MS = 120_000; // 2 minutes

/**
 * Max concurrent live nonces PER peerId (NOT a global cap). Bucketing nonces by
 * peer lets a user's multiple devices each hold a live challenge, but one peer
 * must not be able to flood `challenge` unbounded. A per-peer cap bounds each
 * peer to a handful of live nonces AND — crucially — only ever evicts that
 * peer's OWN oldest, so one credential can never evict another peer's in-flight
 * nonce (a cross-peer eviction DoS). 8 is far above real multi-device load, so
 * it never engages in normal operation and only caps abuse.
 */
const DEFAULT_MAX_NONCES_PER_PEER = 8;

/**
 * The exact message the device signs. Binding `peerId` prevents a signature
 * captured for one peer from registering another, and binding the nonce
 * prevents replay.
 */
export function popSignedMessage(peerId: string, nonce: string): string {
  return `webchannel-pop:${peerId}:${nonce}`;
}

/**
 * In-memory, single-use, TTL-bounded PoP nonce store + Ed25519 verifier.
 *
 * Nonces are bucketed PER peerId (`peerId → (nonce → expiresAtMs)`), which gives
 * two structural properties:
 *   - MULTI-DEVICE: a user's devices share one peerId but each holds its OWN live
 *     nonce in the shared bucket, so concurrent challenges never clobber each
 *     other. (Keying the whole store by peerId would overwrite — the first
 *     device's register would then find a stale nonce and 401.)
 *   - CROSS-PEER ISOLATION: the per-peer cap only ever evicts the ISSUING peer's
 *     own oldest nonce, so one peer's `challenge` flood cannot evict another
 *     peer's in-flight nonce (a cross-peer eviction DoS). A nonce is also only
 *     findable under the peer that issued it, so it can never be consumed by
 *     another peer — that bucketing IS the peerId binding.
 *
 * `now` is injectable for deterministic expiry tests.
 */
export class PopChallengeStore {
  // peerId → (nonce → expiresAtMs). Both layers are insertion-ordered Maps, so
  // "oldest" is the first key. An empty bucket is deleted so peer count tracks
  // only peers with live challenges.
  private readonly byPeer = new Map<string, Map<string, number>>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly maxNoncesPerPeer: number = DEFAULT_MAX_NONCES_PER_PEER,
  ) {}

  /**
   * Issue (and persist) a fresh nonce bound to `peerId`. Does NOT overwrite any
   * prior challenge for the same peerId — concurrent challenges (e.g. a user's
   * two devices sharing one peerId) each get their own live nonce.
   */
  issue(peerId: string): string {
    // S2: opportunistically evict expired nonces on every issue. A nonce that is
    // issued but never verified (client abandons the register hop) would
    // otherwise linger forever — unbounded over a long-lived gateway's life. The
    // sweep keeps the store bounded by the count of *live* (unexpired) challenges.
    this.sweep();
    let bucket = this.byPeer.get(peerId);
    if (!bucket) {
      bucket = new Map<string, number>();
      this.byPeer.set(peerId, bucket);
    }
    // Per-peer cap: under a `challenge` flood the expiry sweep alone can't bound
    // the store (all entries are within TTL), so evict THIS peer's own oldest
    // (Map is insertion-ordered) until under the per-peer ceiling. Evicting only
    // the issuing peer's nonces means a flood is self-limited and can never drop
    // another peer's in-flight nonce. Never engages under real multi-device load.
    while (bucket.size >= this.maxNoncesPerPeer) {
      const oldest = bucket.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
    const nonce = randomBytes(32).toString("base64url");
    bucket.set(nonce, this.now() + this.ttlMs);
    return nonce;
  }

  /**
   * Evict every nonce whose TTL has elapsed (across all peers), dropping any
   * peer bucket left empty. Called opportunistically on {@link issue}; also
   * exposed for an optional periodic sweeper / tests. Returns the number evicted.
   */
  sweep(now: number = this.now()): number {
    let evicted = 0;
    for (const [peerId, bucket] of this.byPeer) {
      for (const [nonce, expiresAt] of bucket) {
        if (now > expiresAt) {
          bucket.delete(nonce);
          evicted += 1;
        }
      }
      if (bucket.size === 0) this.byPeer.delete(peerId);
    }
    return evicted;
  }

  /** Current number of stored (issued, not-yet-consumed) nonces across all peers. */
  get size(): number {
    let total = 0;
    for (const bucket of this.byPeer.values()) total += bucket.size;
    return total;
  }

  /** Drop a nonce and, if that empties the peer's bucket, the bucket too. */
  private deleteNonce(peerId: string, bucket: Map<string, number>, nonce: string): void {
    bucket.delete(nonce);
    if (bucket.size === 0) this.byPeer.delete(peerId);
  }

  /** Consume the stored nonce (single-use). Looks up ONLY the peer's own bucket,
   *  so a nonce presented under a peerId that never issued it is simply "missing"
   *  (the bucketing enforces the peerId binding without a global nonce index). */
  private consume(peerId: string, nonce: string): "ok" | "missing" | "expired" {
    const bucket = this.byPeer.get(peerId);
    if (!bucket) return "missing";
    const expiresAt = bucket.get(nonce);
    if (expiresAt === undefined) return "missing"; // never issued, or replay after consume
    if (this.now() > expiresAt) {
      this.deleteNonce(peerId, bucket, nonce);
      return "expired";
    }
    this.deleteNonce(peerId, bucket, nonce); // single-use: a replay finds nothing → "missing"
    return "ok";
  }

  /**
   * Verify a PoP proof. Consumes the nonce regardless of signature validity
   * (a failed attempt burns the challenge — the client must request a new one).
   */
  verify(params: {
    peerId: string;
    nonce: string;
    signatureB64Url: string;
    popPublicJwk: PopPublicJwk;
  }): PopVerifyResult {
    const consumed = this.consume(params.peerId, params.nonce);
    if (consumed === "missing") return { ok: false, reason: "nonce-missing" };
    if (consumed === "expired") return { ok: false, reason: "nonce-expired" };

    const { kty, crv, x } = params.popPublicJwk;
    if (kty !== "OKP" || crv !== "Ed25519") return { ok: false, reason: "not-ed25519" };

    let pub;
    try {
      pub = createPublicKey({ key: { kty, crv, x }, format: "jwk" });
    } catch {
      return { ok: false, reason: "bad-jwk" };
    }

    let sig: Buffer;
    try {
      sig = Buffer.from(params.signatureB64Url, "base64url");
    } catch {
      return { ok: false, reason: "bad-signature-encoding" };
    }

    const msg = Buffer.from(popSignedMessage(params.peerId, params.nonce), "utf8");
    const ok = edVerify(null, msg, pub, sig);
    return ok ? { ok: true, reason: "verified" } : { ok: false, reason: "signature-mismatch" };
  }
}
