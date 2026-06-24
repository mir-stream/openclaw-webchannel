/**
 * Agent-side Handshake MITM-rejection verifier — AC 4.
 *
 * Compares each presented device public key against the SaaS-pinned value
 * (stored in auth.ts during admission) and aborts the handshake when they diverge.
 *
 * Security model
 * ──────────────
 * After JWT admission (auth.ts), the plugin holds the PINNED device public key
 * for each peer in the pinnedDeviceKeys store. During the NATS key-exchange
 * handshake, the browser publishes a `handshake_hello` message containing its
 * X25519 device public key. The agent MUST verify this key matches the
 * SaaS-attested pin before proceeding with ECDH and deriving the session key.
 *
 * A mismatch means:
 *   • The NATS relay (or any intermediate) substituted a different key
 *     (MITM attack), OR
 *   • The device's key was rotated without a new SaaS bootstrap (config error).
 *
 * In both cases the handshake MUST be aborted — proceeding with a different
 * key would encrypt conversation content to an attacker's key.
 *
 * Wire format
 * ───────────
 * The `handshake_hello` message is published to a per-user NATS subject
 * (e.g. `webchannel.{tenant}.{agentId}.{userId}.handshake`). The message
 * contains the device's X25519 public key, which is the UNTRUSTED input that
 * this module validates against the TRUSTED SaaS-pinned value.
 *
 * Constant-time comparison
 * ────────────────────────
 * Key comparison uses constant-time byte-equality to prevent timing side-channels.
 */

import { getPinnedDeviceKey } from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a presented device public key does not match the SaaS-pinned value.
 *
 * A `HandshakeMitmError` indicates a potential MITM attack (a relay or
 * intermediate substituted a different key) or a configuration error (key
 * rotation without re-bootstrapping). In both cases the handshake MUST be
 * aborted — the caller MUST NOT proceed with ECDH key derivation.
 */
export class HandshakeMitmError extends Error {
  public readonly kind = "HandshakeMitmError" as const;

  constructor(message: string) {
    super(message);
    this.name = "HandshakeMitmError";
    // Maintain correct prototype chain for `instanceof` across transpiled builds.
    Object.setPrototypeOf(this, HandshakeMitmError.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire format (NATS `handshake_hello` message from browser)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NATS wire payload for the handshake hello message from browser to agent.
 *
 * Published by the browser to announce its X25519 device public key
 * before ECDH. The `peerId` is used to look up the correct pinned keys for
 * this peer. The `devicePublicKey` is the UNTRUSTED input that the agent MUST
 * validate against SaaS-pinned values before proceeding.
 *
 * Subject convention: `webchannel.{tenant}.{agentId}.{userId}.handshake`
 * (exact subject grammar is deferred to the operator configuration layer).
 */
export type HandshakeHelloMessage = {
  /** Discriminator — must be "handshake_hello". */
  readonly type: "handshake_hello";
  /** Schema version — must be 1. */
  readonly version: 1;
  /**
   * JWT `sub` claim of the user initiating the handshake.
   * Used to look up the correct pinned device key for this peer.
   */
  readonly peerId: string;
  /**
   * Device X25519 public key — base64url-encoded 32 bytes.
   *
   * UNTRUSTED input: the agent validates this against
   * `getPinnedDeviceKey(peerId)` (the SaaS-attested value) before
   * proceeding. A mismatch MUST abort the handshake.
   */
  readonly devicePublicKey: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Device key verifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that a presented device public key matches the SaaS-pinned value.
 *
 * The pinned key is stored in `auth.ts`'s pinnedDeviceKeys map after
 * successful JWT admission with a cnf claim. This function is called by the
 * AGENT when it receives a `handshake_hello` message from the browser.
 *
 * Comparison is constant-time to prevent timing side-channels.
 *
 * @param peerId              JWT `sub` — identifies which pinned key to look up.
 * @param presentedDeviceKey  32-byte X25519 device public key from the handshake.
 *
 * @throws {HandshakeMitmError}  Presented key diverges from the SaaS-pinned value.
 * @throws {Error}               No pinned key stored for `peerId` (admission failure).
 * @throws {HandshakeMitmError}  Presented key has invalid length.
 */
export function verifyDeviceKey(
  peerId: string,
  presentedDeviceKey: Uint8Array,
): void {
  const pinnedKeyB64 = getPinnedDeviceKey(peerId);
  if (!pinnedKeyB64) {
    throw new Error(
      `handshake-verifier: no pinned device key for peerId "${peerId}" — ` +
        "JWT admission must include a cnf.jwk claim with device public key",
    );
  }

  if (presentedDeviceKey.length !== 32) {
    throw new HandshakeMitmError(
      `handshake-verifier: presented devicePublicKey has invalid length ` +
        `${presentedDeviceKey.length} (expected 32 bytes)`,
    );
  }

  const pinnedKey = base64UrlToUint8(pinnedKeyB64);
  if (!constantTimeEqual(presentedDeviceKey, pinnedKey)) {
    throw new HandshakeMitmError(
      `handshake-verifier: device key mismatch for peerId "${peerId}" — ` +
        "possible MITM: presented key diverges from the SaaS-pinned value; " +
        "handshake aborted",
    );
  }
}

/**
 * Parse a raw NATS handshake payload and verify the device key against the
 * SaaS-pinned value for the given peerId.
 *
 * This is the PRIMARY entry point for handshake verification. It:
 *   1. JSON-parses the raw NATS `MSG` payload.
 *   2. Validates the structural invariants of `HandshakeHelloMessage`.
 *   3. Verifies `devicePublicKey` against `getPinnedDeviceKey(peerId)`.
 *   4. Returns the validated message on success.
 *
 * If any step fails the function throws before the caller can use any key
 * material — the caller MUST NOT proceed with ECDH if an exception is caught.
 *
 * @param payload   Raw NATS `MSG` payload (Buffer or JSON string).
 * @param peerId    Expected JWT `sub` (must equal `payload.peerId`).
 * @returns         Validated `HandshakeHelloMessage` (device key matches pin).
 *
 * @throws {HandshakeMitmError}  Device key diverges from the SaaS-pinned value.
 * @throws {Error}               Malformed JSON, structural validation failure,
 *                               or missing pinned key for the peer.
 */
export function parseAndVerifyHandshake(
  payload: Buffer | string,
  peerId: string,
): HandshakeHelloMessage {
  // ── 1. JSON parse ──────────────────────────────────────────────────────────
  const json =
    typeof payload === "string" ? payload : payload.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      "handshake-verifier: failed to parse handshake payload as JSON",
    );
  }

  // ── 2. Structural validation ───────────────────────────────────────────────
  const msg = validateHandshakeMessage(parsed, peerId);

  // ── 3. Verify device key ────────────────────────────────────────────────────
  const deviceKey = base64UrlToUint8(msg.devicePublicKey);
  verifyDeviceKey(peerId, deviceKey);

  // ── 4. Return validated message ───────────────────────────────────────────
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural validation of a raw-parsed handshake hello object.
 *
 * Throws `Error` (NOT `HandshakeMitmError`) for structural failures — these
 * indicate a malformed message, not a key mismatch.
 */
function validateHandshakeMessage(
  raw: unknown,
  expectedPeerId: string,
): HandshakeHelloMessage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "handshake-verifier: handshake payload must be a JSON object",
    );
  }
  const obj = raw as Record<string, unknown>;

  if (obj["type"] !== "handshake_hello") {
    throw new Error(
      `handshake-verifier: expected type "handshake_hello" ` +
      `(got ${JSON.stringify(obj["type"])})`,
    );
  }
  if (obj["version"] !== 1) {
    throw new Error(
      `handshake-verifier: unsupported handshake version ` +
      `${JSON.stringify(obj["version"])} (expected 1)`,
    );
  }
  if (typeof obj["peerId"] !== "string" || !obj["peerId"]) {
    throw new Error(
      "handshake-verifier: peerId must be a non-empty string",
    );
  }
  if (obj["peerId"] !== expectedPeerId) {
    throw new Error(
      `handshake-verifier: peerId mismatch — ` +
      `expected "${expectedPeerId}", got "${String(obj["peerId"])}"`,
    );
  }
  if (typeof obj["devicePublicKey"] !== "string" || !obj["devicePublicKey"]) {
    throw new Error(
      "handshake-verifier: devicePublicKey must be a non-empty base64url string",
    );
  }

  return obj as unknown as HandshakeHelloMessage;
}

/**
 * Constant-time byte-array equality.
 *
 * Compares two `Uint8Array` values in O(n) time regardless of where the first
 * differing byte is, preventing timing oracle attacks where an adversary could
 * deduce matching prefix length from response latency.
 *
 * Returns `false` immediately if lengths differ (length leakage is acceptable
 * here: all pinned keys are exactly 32 bytes; a non-32-byte input is already
 * rejected before this call).
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // Bitwise OR accumulates any difference; a single differing bit makes
    // `diff` non-zero and the result `false`.
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Decode a base64url string to a `Uint8Array`.
 *
 * Handles optional-padding variants (0, 1, or 2 trailing `=`).
 * Compatible with both Node.js (Buffer) and browser (atob) runtimes.
 */
function base64UrlToUint8(input: string): Uint8Array {
  // Fast path: Node.js Buffer (available in Node.js and Vitest environments).
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(input, "base64url"));
  }
  // Browser path: transcode base64url → standard base64, then use atob.
  let std = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4;
  if (pad === 2) std += "==";
  else if (pad === 3) std += "=";
  else if (pad === 1) {
    throw new Error(
      "handshake-verifier: invalid base64url string (length 1 mod 4)",
    );
  }
  const binary = globalThis.atob(std);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
