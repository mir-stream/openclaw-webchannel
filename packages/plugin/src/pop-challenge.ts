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
 * Flow:
 *   1. GET  /webchannel/nats/register/challenge?jwt=…  → server issues a nonce
 *      bound to peerId (single-use, short TTL).
 *   2. Browser signs `popSignedMessage(peerId, nonce)` with the Ed25519 device
 *      private key.
 *   3. POST /webchannel/nats/register with the signature → server verifies it
 *      against the JWT's `pop_jwk`. Missing/invalid/expired/replayed → 401.
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
    | "nonce-mismatch"
    | "not-ed25519"
    | "bad-jwk"
    | "bad-signature-encoding"
    | "signature-mismatch";
};

const DEFAULT_TTL_MS = 120_000; // 2 minutes

/**
 * The exact message the device signs. Binding `peerId` prevents a signature
 * captured for one peer from registering another, and binding the nonce
 * prevents replay.
 */
export function popSignedMessage(peerId: string, nonce: string): string {
  return `webchannel-pop:${peerId}:${nonce}`;
}

type NonceEntry = { nonce: string; expiresAt: number };

/**
 * In-memory, single-use, TTL-bounded nonce store + Ed25519 verifier.
 *
 * `now` is injectable for deterministic expiry tests.
 */
export class PopChallengeStore {
  private readonly store = new Map<string, NonceEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Issue (and persist) a fresh nonce bound to `peerId`. Overwrites any prior. */
  issue(peerId: string): string {
    const nonce = randomBytes(32).toString("base64url");
    this.store.set(peerId, { nonce, expiresAt: this.now() + this.ttlMs });
    return nonce;
  }

  /** Consume the stored nonce (single-use). */
  private consume(peerId: string, nonce: string): "ok" | "missing" | "expired" | "mismatch" {
    const entry = this.store.get(peerId);
    if (!entry) return "missing";
    if (this.now() > entry.expiresAt) {
      this.store.delete(peerId);
      return "expired";
    }
    if (entry.nonce !== nonce) return "mismatch";
    this.store.delete(peerId); // single-use: a replay finds nothing → "missing"
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
    if (consumed === "mismatch") return { ok: false, reason: "nonce-mismatch" };

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
