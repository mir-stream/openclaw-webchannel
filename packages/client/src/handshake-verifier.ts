/**
 * NATS Handshake MITM-rejection verifier — Sub-AC 4b.
 *
 * Compares each presented agent/device public key against the SaaS-pinned
 * values (seeded via Sub-AC 4a's `parseAndStorePinnedKeys`) and aborts the
 * handshake when they diverge.
 *
 * Security model
 * ──────────────
 * After the SaaS bootstrap (Sub-AC 4a) the browser holds the PINNED public
 * keys for both the agent and the device in `saas-bootstrap`'s in-memory
 * store.  During the NATS key-exchange handshake, the agent publishes a
 * `handshake_hello` message containing its X25519 public key.  The browser
 * MUST verify this key matches the SaaS-attested pin before proceeding with
 * ECDH and deriving the session key.  A mismatch means:
 *
 *   • The NATS relay (or any intermediate) substituted a different key
 *     (MITM attack), OR
 *   • The agent's key was rotated without a new SaaS bootstrap (config error).
 *
 * In both cases the handshake MUST be aborted — proceeding with a different
 * key would encrypt conversation content to an attacker's key.
 *
 * Similarly, the agent MUST verify the browser's presented device key against
 * the SaaS-attested cnf.jwk pin before wrapping / distributing the
 * conversation key.
 *
 * Wire format
 * ───────────
 * The `handshake_hello` message is published to a per-user NATS subject
 * (e.g. `chat.<tenant>.<agentId>.<userId>.handshake`).  Routing metadata
 * (peerId, version) is plaintext; the key material (agentPublicKey,
 * devicePublicKey) is the UNTRUSTED input that this module validates against
 * the TRUSTED SaaS-pinned values.
 *
 * Constant-time comparison
 * ────────────────────────
 * All key comparisons use a constant-time byte-equality function to prevent
 * timing side-channels.  An attacker who can measure the verification time
 * could probe which bytes of the pinned key match, potentially leaking partial
 * key material.
 *
 * Deferred
 * ────────
 * Key rotation: when the agent or device key is rotated, the browser must
 * re-run the SaaS bootstrap to obtain a fresh pin.  Incremental rotation
 * (pinning multiple candidate keys) is deferred.
 */

import { getPinnedKeys } from "./saas-bootstrap.js";

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a presented public key does not match the SaaS-pinned value.
 *
 * A `HandshakeMitmError` indicates a potential MITM attack (a relay or
 * intermediate substituted a different key) or a configuration error (key
 * rotation without re-bootstrapping).  In both cases the handshake MUST be
 * aborted — the caller MUST NOT proceed with ECDH key derivation or session
 * key use.
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
// Wire format (NATS `handshake_hello` message)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NATS wire payload for the handshake hello message.
 *
 * Published by a peer (agent or device) to announce its X25519 public key
 * before ECDH.  Routing metadata (`peerId`, `version`) is PLAINTEXT — the
 * relay may observe it.  The key fields (`agentPublicKey`, `devicePublicKey`)
 * are the UNTRUSTED inputs that the receiver MUST validate against SaaS-pinned
 * values before trusting.
 *
 * Subject convention: `chat.<tenant>.<agentId>.<userId>.handshake`
 * (exact subject grammar is deferred to the operator configuration layer).
 */
export type HandshakeHelloMessage = {
  /** Discriminator — must be "handshake_hello". */
  readonly type: "handshake_hello";
  /** Schema version — must be 1. */
  readonly version: 1;
  /**
   * JWT `sub` claim of the user initiating the handshake.
   * Used to look up the correct pinned keys for this peer.
   */
  readonly peerId: string;
  /**
   * Agent X25519 public key — base64url-encoded 32 bytes.
   *
   * UNTRUSTED input: the receiver validates this against
   * `getPinnedKeys(peerId).agentPublicKey` (the SaaS-attested value) before
   * proceeding.  A mismatch MUST abort the handshake.
   */
  readonly agentPublicKey: string;
  /**
   * Device X25519 public key — base64url-encoded 32 bytes.
   *
   * UNTRUSTED input: the agent validates this against
   * `getPinnedKeys(peerId).devicePublicKey` (from the cnf.jwk claim) before
   * wrapping / distributing the conversation key.  A mismatch MUST abort.
   */
  readonly devicePublicKey: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-key verifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that a presented agent public key matches the SaaS-pinned value.
 *
 * The pinned key is the `agentPublicKey` stored by `parseAndStorePinnedKeys`
 * (Sub-AC 4a) after the SaaS bootstrap.  This function is called by the
 * BROWSER when it receives a `handshake_hello` message and the message's
 * `agentPublicKey` field has been decoded from base64url.
 *
 * Comparison is constant-time to prevent timing side-channels.
 *
 * @param peerId             JWT `sub` — identifies which pinned keys to look up.
 * @param presentedAgentKey  32-byte X25519 agent public key from the handshake.
 *
 * @throws {HandshakeMitmError}  Presented key diverges from the SaaS-pinned value.
 * @throws {Error}               No pinned keys stored for `peerId`.
 * @throws {HandshakeMitmError}  Either key has a length other than 32 bytes.
 */
export function verifyAgentKey(
  peerId: string,
  presentedAgentKey: Uint8Array,
): void {
  const pins = getPinnedKeys(peerId);
  if (!pins) {
    throw new Error(
      `handshake-verifier: no pinned keys for peerId "${peerId}" — ` +
        "complete the SaaS bootstrap (parseAndStorePinnedKeys) before the handshake",
    );
  }
  if (presentedAgentKey.length !== 32) {
    throw new HandshakeMitmError(
      `handshake-verifier: presented agentPublicKey has invalid length ` +
        `${presentedAgentKey.length} (expected 32 bytes)`,
    );
  }
  if (!constantTimeEqual(presentedAgentKey, pins.agentPublicKey)) {
    throw new HandshakeMitmError(
      `handshake-verifier: agent key mismatch for peerId "${peerId}" — ` +
        "possible MITM: presented key diverges from the SaaS-pinned value; " +
        "handshake aborted",
    );
  }
}

/**
 * Verify that a presented device public key matches the SaaS-pinned value.
 *
 * The pinned key is the `devicePublicKey` stored by `parseAndStorePinnedKeys`
 * (the cnf.jwk.x byte sequence from the SaaS-issued bootstrap JWT).  This
 * function is called by the AGENT when it receives a `handshake_hello` message
 * and the message's `devicePublicKey` field has been decoded from base64url.
 *
 * Comparison is constant-time.
 *
 * @param peerId              JWT `sub`.
 * @param presentedDeviceKey  32-byte X25519 device public key from the handshake.
 *
 * @throws {HandshakeMitmError}  Presented key diverges from the SaaS-pinned value.
 * @throws {Error}               No pinned keys stored for `peerId`.
 * @throws {HandshakeMitmError}  Either key has a length other than 32 bytes.
 */
export function verifyDeviceKey(
  peerId: string,
  presentedDeviceKey: Uint8Array,
): void {
  const pins = getPinnedKeys(peerId);
  if (!pins) {
    throw new Error(
      `handshake-verifier: no pinned keys for peerId "${peerId}" — ` +
        "complete the SaaS bootstrap (parseAndStorePinnedKeys) before the handshake",
    );
  }
  if (presentedDeviceKey.length !== 32) {
    throw new HandshakeMitmError(
      `handshake-verifier: presented devicePublicKey has invalid length ` +
        `${presentedDeviceKey.length} (expected 32 bytes)`,
    );
  }
  if (!constantTimeEqual(presentedDeviceKey, pins.devicePublicKey)) {
    throw new HandshakeMitmError(
      `handshake-verifier: device key mismatch for peerId "${peerId}" — ` +
        "possible MITM: presented key diverges from the SaaS-pinned value; " +
        "handshake aborted",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined parse + verify
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw NATS handshake payload and verify both keys against the
 * SaaS-pinned values for the given peerId.
 *
 * This is the PRIMARY entry point for handshake verification.  It:
 *   1. JSON-parses the raw NATS `MSG` payload.
 *   2. Validates the structural invariants of `HandshakeHelloMessage`.
 *   3. Verifies `agentPublicKey` against `getPinnedKeys(peerId).agentPublicKey`.
 *   4. Verifies `devicePublicKey` against `getPinnedKeys(peerId).devicePublicKey`.
 *   5. Returns the validated message on success.
 *
 * If any step fails the function throws before the caller can use any key
 * material — the caller MUST NOT proceed with ECDH if an exception is caught.
 *
 * @param payload   Raw NATS `MSG` payload (Buffer or JSON string).
 * @param peerId    Expected JWT `sub` (must equal `payload.peerId`).
 * @returns         Validated `HandshakeHelloMessage` (both keys match pins).
 *
 * @throws {HandshakeMitmError}  Any key diverges from the SaaS-pinned value.
 * @throws {Error}               Malformed JSON, structural validation failure,
 *                               or missing pinned keys for the peer.
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

  // ── 3. Verify agent key ────────────────────────────────────────────────────
  const agentKey = base64UrlToUint8(msg.agentPublicKey);
  verifyAgentKey(peerId, agentKey);

  // ── 4. Verify device key ───────────────────────────────────────────────────
  const deviceKey = base64UrlToUint8(msg.devicePublicKey);
  verifyDeviceKey(peerId, deviceKey);

  // ── 5. Return validated message ────────────────────────────────────────────
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
  if (typeof obj["agentPublicKey"] !== "string" || !obj["agentPublicKey"]) {
    throw new Error(
      "handshake-verifier: agentPublicKey must be a non-empty base64url string",
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
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
