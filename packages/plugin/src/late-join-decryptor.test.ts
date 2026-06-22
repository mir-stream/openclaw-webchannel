/**
 * Late-join envelope decryptor — Sub-AC 2b tests.
 *
 * Sub-AC 2b: Late-join envelope decryption — implement the client-side routine
 * that, given a set of paginated ciphertext envelopes and the wrapped conversation
 * key delivered to a late-joining device, unwraps the conversation key and decrypts
 * each envelope to plaintext; verified by a test that pre-builds M encrypted
 * envelopes with a known key, feeds them through the decryptor, and asserts full
 * plaintext round-trip fidelity.
 *
 * Coverage matrix:
 *
 *  1.  Key-wrap round-trip — wrapConversationKey → unwrapConversationKey recovers the original key.
 *  2.  Key-wrap authentication — wrong device private key throws (Poly1305 tag failure).
 *  3.  Key-wrap tamper detection — flipping a bit in wrapped.ciphertext throws.
 *  4.  Key-wrap tamper detection — flipping a bit in wrapped.tag throws.
 *  5.  Key-wrap ephemeral uniqueness — two wraps of the same key produce distinct ephemeralPublicKey values.
 *  6.  Full late-join round-trip (M=20) — pre-build 20 encrypted envelopes with a known
 *      conversation key, wrap the key for a target device, run decryptBacklog, assert all
 *      20 plaintexts are recovered exactly.  PRIMARY Sub-AC 2b assertion.
 *  7.  Single-envelope degenerate case (M=1) — decryptBacklog works for a single envelope.
 *  8.  Empty backlog (M=0) — decryptBacklog returns empty plaintexts and recovers key.
 *  9.  Large payload envelopes (4 KB each, M=10) — decryptBacklog handles large content.
 * 10.  Paginated backlog stitching (3 pages of 5 envelopes) — caller stitches pages and
 *      decryptBacklog decrypts the flat array; tests the page-stitch pattern.
 * 11.  Wrong device private key — decryptBacklog throws before decrypting any envelope.
 * 12.  Tampered first envelope — decryptBacklog throws on the tampered envelope.
 * 13.  Tampered middle envelope — partial tamper detected.
 * 14.  Multi-device: two devices independently unwrap the same conversation key — both
 *      recover the identical key and decrypt all envelopes to identical plaintexts.
 * 15.  Wrong device cannot unwrap key targeted at another device.
 * 16.  Approval decision envelopes in the backlog — decryptBacklog handles mixed envelope types.
 * 17.  decryptBacklog exposes conversationKey — caller can use it for future envelopes
 *      without re-unwrapping.
 * 18.  Key-wrap field structure — WrappedConversationKey has exactly the four expected fields.
 * 19.  Unwrapped conversation key length — always exactly 32 bytes.
 * 20.  Large M=50 round-trip — scales linearly with no correctness regression.
 */

import { describe, it, expect } from "vitest";
import {
  wrapConversationKey,
  unwrapConversationKey,
  decryptBacklog,
  KEY_WRAP_INFO,
} from "./late-join-decryptor.js";
import type { WrappedConversationKey } from "./late-join-decryptor.js";
import {
  encodeEnvelope,
  decryptEnvelopeContent,
  serializeEnvelope,
  deserializeEnvelope,
} from "./e2e-envelope.js";
import type { EnvelopeRouting, MessageEnvelope } from "./e2e-envelope.js";
import {
  generateKeyPair,
  hkdfSha256,
  deriveSharedSecret,
} from "./e2e-crypto.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a string as UTF-8 bytes. */
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Decode UTF-8 bytes to string. */
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Hex-encode a Uint8Array for readable assertions. */
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/**
 * Generate a fresh 32-byte conversation key via X25519+HKDF, simulating what
 * the agent produces before wrapping it for registered devices.
 */
function makeConversationKey(info = "webchannel-conversation-v1"): Uint8Array {
  const a = generateKeyPair();
  const b = generateKeyPair();
  return hkdfSha256(deriveSharedSecret(a.privateKey, b.publicKey), null, info, 32);
}

/**
 * Build a minimal EnvelopeRouting record.
 */
function routing(
  messageId: string,
  envelopeType: EnvelopeRouting["envelopeType"] = "conversation",
  ts = 1_718_000_000_000,
): EnvelopeRouting {
  return {
    agentId: "agent-late-join",
    tenant: "tenant-acme",
    sub: "user-42",
    messageId,
    envelopeType,
    ts,
  };
}

/**
 * Pre-build M encrypted envelopes with a known conversation key.
 * Plaintext for envelope i is `"message-${i}"` (1-indexed).
 */
function buildBacklog(
  convKey: Uint8Array,
  count: number,
  tsBase = 1_718_000_000_000,
): { envelopes: MessageEnvelope[]; plaintexts: string[] } {
  const envelopes: MessageEnvelope[] = [];
  const plaintexts: string[] = [];

  for (let i = 1; i <= count; i++) {
    const plaintext = `message-${i}`;
    plaintexts.push(plaintext);
    envelopes.push(
      encodeEnvelope(
        routing(`msg-${i}`, "conversation", tsBase + i * 1000),
        enc(plaintext),
        convKey,
      ),
    );
  }

  return { envelopes, plaintexts };
}

// ---------------------------------------------------------------------------
// Suite 1: Key-wrap / unwrap primitives
// ---------------------------------------------------------------------------

describe("wrapConversationKey / unwrapConversationKey — key-wrap primitives", () => {

  // ── Test 1: Round-trip — wrap then unwrap recovers the original key ─────────

  it(
    "wrapConversationKey → unwrapConversationKey recovers the original 32-byte conversation key",
    () => {
      const convKey = makeConversationKey();
      const deviceKP = generateKeyPair();

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
      const recovered = unwrapConversationKey(wrapped, deviceKP.privateKey);

      // Recovered key must be byte-identical to the original.
      expect(hex(recovered)).toBe(hex(convKey));
      // And must be exactly 32 bytes.
      expect(recovered.length).toBe(32);
    },
  );

  // ── Test 2: Wrong device private key → authentication failure ───────────────

  it(
    "unwrapConversationKey with wrong device private key throws (Poly1305 auth failure)",
    () => {
      const convKey = makeConversationKey();
      const rightDevice = generateKeyPair();
      const wrongDevice = generateKeyPair();

      const wrapped = wrapConversationKey(convKey, rightDevice.publicKey);

      // Wrong device private key → different ECDH secret → different wrap key →
      // Poly1305 tag mismatch → throw.
      expect(() => unwrapConversationKey(wrapped, wrongDevice.privateKey)).toThrow();
    },
  );

  // ── Test 3: Tampered ciphertext → authentication failure ───────────────────

  it(
    "flipping a bit in wrapped.ciphertext throws (authentication failure)",
    () => {
      const convKey = makeConversationKey();
      const deviceKP = generateKeyPair();

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);

      // Flip the first byte of the ciphertext.
      const ct = Buffer.from(wrapped.ciphertext, "base64url");
      ct[0] ^= 0x01;
      const tampered: WrappedConversationKey = {
        ...wrapped,
        ciphertext: ct.toString("base64url"),
      };

      expect(() => unwrapConversationKey(tampered, deviceKP.privateKey)).toThrow();
    },
  );

  // ── Test 4: Tampered auth tag → authentication failure ─────────────────────

  it(
    "flipping a bit in wrapped.tag throws (authentication failure)",
    () => {
      const convKey = makeConversationKey();
      const deviceKP = generateKeyPair();

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);

      const tag = Buffer.from(wrapped.tag, "base64url");
      tag[0] ^= 0xff;
      const tampered: WrappedConversationKey = {
        ...wrapped,
        tag: tag.toString("base64url"),
      };

      expect(() => unwrapConversationKey(tampered, deviceKP.privateKey)).toThrow();
    },
  );

  // ── Test 5: Ephemeral key uniqueness — two wraps produce distinct ephemeral keys ──

  it(
    "two successive wraps of the same conversation key produce distinct ephemeralPublicKey values",
    () => {
      const convKey = makeConversationKey();
      const deviceKP = generateKeyPair();

      const wrap1 = wrapConversationKey(convKey, deviceKP.publicKey);
      const wrap2 = wrapConversationKey(convKey, deviceKP.publicKey);

      // Fresh ephemeral key pair per wrap → different ephemeralPublicKey.
      expect(wrap1.ephemeralPublicKey).not.toBe(wrap2.ephemeralPublicKey);
      // Also different nonce (random per encrypt).
      expect(wrap1.nonce).not.toBe(wrap2.nonce);
      // Both still unwrap to the same conversation key.
      expect(hex(unwrapConversationKey(wrap1, deviceKP.privateKey))).toBe(hex(convKey));
      expect(hex(unwrapConversationKey(wrap2, deviceKP.privateKey))).toBe(hex(convKey));
    },
  );

  // ── Test 18: WrappedConversationKey field structure ─────────────────────────

  it(
    "WrappedConversationKey has exactly the four expected fields: ephemeralPublicKey, nonce, ciphertext, tag",
    () => {
      const convKey = new Uint8Array(32).fill(0x11);
      const deviceKP = generateKeyPair();
      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);

      const keys = Object.keys(wrapped).sort();
      expect(keys).toEqual(["ciphertext", "ephemeralPublicKey", "nonce", "tag"]);

      // All four values must be non-empty strings (base64url).
      expect(typeof wrapped.ephemeralPublicKey).toBe("string");
      expect(wrapped.ephemeralPublicKey.length).toBeGreaterThan(0);
      expect(typeof wrapped.nonce).toBe("string");
      expect(wrapped.nonce.length).toBeGreaterThan(0);
      expect(typeof wrapped.ciphertext).toBe("string");
      expect(wrapped.ciphertext.length).toBeGreaterThan(0);
      expect(typeof wrapped.tag).toBe("string");
      expect(wrapped.tag.length).toBeGreaterThan(0);
    },
  );

  // ── Test 19: Unwrapped key length — always exactly 32 bytes ────────────────

  it(
    "unwrapConversationKey always returns exactly 32 bytes regardless of key material",
    () => {
      // Test with several different conversation keys.
      for (let i = 0; i < 5; i++) {
        const convKey = makeConversationKey(`info-variant-${i}`);
        const deviceKP = generateKeyPair();
        const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
        const recovered = unwrapConversationKey(wrapped, deviceKP.privateKey);
        expect(recovered.length).toBe(32);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Suite 2: decryptBacklog — full late-join pipeline (PRIMARY Sub-AC 2b assertion)
// ---------------------------------------------------------------------------

describe("decryptBacklog — full late-join round-trip (Sub-AC 2b primary assertion)", () => {

  // ── Test 6: M=20 round-trip — pre-build 20 envelopes, decrypt all exactly ──

  it(
    "M=20: pre-build 20 encrypted envelopes with known key, wrap for device, unwrap and decrypt — all 20 plaintexts recovered exactly (Sub-AC 2b primary)",
    () => {
      const M = 20;

      // 1. Agent generates a conversation key (known to both agent and test).
      const convKey = makeConversationKey();

      // 2. Pre-build M encrypted envelopes using the conversation key.
      const { envelopes, plaintexts } = buildBacklog(convKey, M);
      expect(envelopes).toHaveLength(M);

      // 3. Late-joining device generates its X25519 key pair.
      const deviceKP = generateKeyPair();

      // 4. Agent wraps the conversation key for the device's public key.
      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);

      // 5. Device runs the late-join pipeline: unwrap key → decrypt all envelopes.
      const result = decryptBacklog(envelopes, wrapped, deviceKP.privateKey);

      // 6. Assert full round-trip fidelity: all M plaintexts recovered exactly.
      expect(result.plaintexts).toHaveLength(M);

      for (let i = 0; i < M; i++) {
        const recovered = dec(result.plaintexts[i]!);
        expect(
          recovered,
          `envelope ${i + 1}: plaintext must match original`,
        ).toBe(plaintexts[i]!);
      }

      // 7. The recovered conversation key must match the original.
      expect(
        hex(result.conversationKey),
        "recovered conversationKey must match original",
      ).toBe(hex(convKey));
    },
  );

  // ── Test 7: Single-envelope degenerate case (M=1) ──────────────────────────

  it(
    "M=1 single envelope: decryptBacklog returns the one plaintext correctly",
    () => {
      const convKey = makeConversationKey();
      const { envelopes, plaintexts } = buildBacklog(convKey, 1);
      const deviceKP = generateKeyPair();

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
      const result = decryptBacklog(envelopes, wrapped, deviceKP.privateKey);

      expect(result.plaintexts).toHaveLength(1);
      expect(dec(result.plaintexts[0]!)).toBe(plaintexts[0]!);
    },
  );

  // ── Test 8: Empty backlog (M=0) — returns empty plaintexts, recovers key ───

  it(
    "M=0 empty backlog: decryptBacklog returns empty plaintexts array and recovers the key",
    () => {
      const convKey = makeConversationKey();
      const deviceKP = generateKeyPair();

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
      const result = decryptBacklog([], wrapped, deviceKP.privateKey);

      expect(result.plaintexts).toHaveLength(0);
      expect(result.plaintexts).toEqual([]);
      // The key is still recovered correctly even with no envelopes.
      expect(hex(result.conversationKey)).toBe(hex(convKey));
    },
  );

  // ── Test 9: Large payload envelopes (4 KB, M=10) ───────────────────────────

  it(
    "M=10 envelopes each with 4 KB payload: decryptBacklog handles large content correctly",
    () => {
      const M = 10;
      const convKey = makeConversationKey();
      const deviceKP = generateKeyPair();

      // Build envelopes with 4 KB payloads.
      const largePlaintexts = Array.from({ length: M }, (_, i) => {
        const payload = new Uint8Array(4096).fill(i & 0xff);
        return payload;
      });
      const envelopes = largePlaintexts.map((payload, i) =>
        encodeEnvelope(
          routing(`msg-large-${i + 1}`, "conversation", 1_718_000_000_000 + i * 1000),
          payload,
          convKey,
        ),
      );

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
      const result = decryptBacklog(envelopes, wrapped, deviceKP.privateKey);

      expect(result.plaintexts).toHaveLength(M);
      for (let i = 0; i < M; i++) {
        expect(
          result.plaintexts[i],
          `large payload ${i + 1} must round-trip exactly`,
        ).toEqual(largePlaintexts[i]!);
      }
    },
  );

  // ── Test 10: Paginated backlog stitching (3 pages of 5 envelopes) ──────────

  it(
    "paginated backlog (3 pages × 5 = 15 envelopes): caller stitches pages and decryptBacklog decrypts flat array",
    () => {
      const M = 15;
      const PAGE_SIZE = 5;
      const convKey = makeConversationKey();
      const { envelopes, plaintexts } = buildBacklog(convKey, M);
      const deviceKP = generateKeyPair();

      // Simulate page stitching (as would happen with HistoryStore.loadHistory pagination).
      const pages: MessageEnvelope[][] = [];
      for (let p = 0; p < M; p += PAGE_SIZE) {
        pages.push(envelopes.slice(p, p + PAGE_SIZE));
      }
      expect(pages).toHaveLength(3); // 3 pages of 5

      // Stitch pages into a flat array (as the late-join device would do).
      const stitched = pages.flat();
      expect(stitched).toHaveLength(M);

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
      const result = decryptBacklog(stitched, wrapped, deviceKP.privateKey);

      expect(result.plaintexts).toHaveLength(M);
      for (let i = 0; i < M; i++) {
        expect(
          dec(result.plaintexts[i]!),
          `stitched page: envelope ${i + 1} must match original plaintext`,
        ).toBe(plaintexts[i]!);
      }
    },
  );

  // ── Test 11: Wrong device private key — throws before decrypting envelopes ──

  it(
    "decryptBacklog with wrong device private key throws before decrypting any envelope (key-unwrap gatekeeper)",
    () => {
      const convKey = makeConversationKey();
      const { envelopes } = buildBacklog(convKey, 5);
      const rightDevice = generateKeyPair();
      const wrongDevice = generateKeyPair();

      const wrapped = wrapConversationKey(convKey, rightDevice.publicKey);

      // Wrong private key → unwrap fails → no plaintexts returned.
      expect(() => decryptBacklog(envelopes, wrapped, wrongDevice.privateKey)).toThrow();
    },
  );

  // ── Test 12: Tampered first envelope — throws on the tampered envelope ──────

  it(
    "decryptBacklog throws when the first envelope has a tampered ciphertext",
    () => {
      const convKey = makeConversationKey();
      const { envelopes } = buildBacklog(convKey, 5);
      const deviceKP = generateKeyPair();
      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);

      // Tamper the first envelope's ciphertext.
      const first = envelopes[0]!;
      const ct = Buffer.from(first.content.ciphertext, "base64url");
      ct[0] ^= 0xff;
      const tampered: MessageEnvelope = {
        ...first,
        content: { ...first.content, ciphertext: ct.toString("base64url") },
      };
      const tamperedEnvelopes = [tampered, ...envelopes.slice(1)];

      expect(() => decryptBacklog(tamperedEnvelopes, wrapped, deviceKP.privateKey)).toThrow();
    },
  );

  // ── Test 13: Tampered middle envelope — throws at that index ───────────────

  it(
    "decryptBacklog throws when a middle envelope (index 3 of 7) has a tampered auth tag",
    () => {
      const M = 7;
      const convKey = makeConversationKey();
      const { envelopes } = buildBacklog(convKey, M);
      const deviceKP = generateKeyPair();
      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);

      // Tamper the tag of envelope index 3 (4th envelope, middle of 7).
      const mid = envelopes[3]!;
      const tag = Buffer.from(mid.content.tag, "base64url");
      tag[7] ^= 0x01;
      const tampered: MessageEnvelope = {
        ...mid,
        content: { ...mid.content, tag: tag.toString("base64url") },
      };
      const tamperedEnvelopes = [
        ...envelopes.slice(0, 3),
        tampered,
        ...envelopes.slice(4),
      ];

      // The tamper is detected when decryptBacklog reaches the 4th envelope.
      expect(() => decryptBacklog(tamperedEnvelopes, wrapped, deviceKP.privateKey)).toThrow();
    },
  );

  // ── Test 14: Multi-device — two devices independently decrypt same backlog ──

  it(
    "two devices each receive the conversation key wrapped independently — both recover identical plaintexts",
    () => {
      const M = 10;
      const convKey = makeConversationKey();
      const { envelopes, plaintexts } = buildBacklog(convKey, M);

      // Two distinct devices, each with their own X25519 key pair.
      const deviceA = generateKeyPair();
      const deviceB = generateKeyPair();

      // Agent wraps the SAME conversation key for each device independently.
      const wrappedA = wrapConversationKey(convKey, deviceA.publicKey);
      const wrappedB = wrapConversationKey(convKey, deviceB.publicKey);

      // Each device independently decrypts the backlog.
      const resultA = decryptBacklog(envelopes, wrappedA, deviceA.privateKey);
      const resultB = decryptBacklog(envelopes, wrappedB, deviceB.privateKey);

      expect(resultA.plaintexts).toHaveLength(M);
      expect(resultB.plaintexts).toHaveLength(M);

      for (let i = 0; i < M; i++) {
        // Both devices recover the same plaintext for each envelope.
        const ptA = dec(resultA.plaintexts[i]!);
        const ptB = dec(resultB.plaintexts[i]!);
        expect(ptA, `device A: envelope ${i + 1}`).toBe(plaintexts[i]!);
        expect(ptB, `device B: envelope ${i + 1}`).toBe(plaintexts[i]!);
        expect(ptA, `device A and B must agree on envelope ${i + 1}`).toBe(ptB);
      }

      // Both recovered conversation keys are identical (same source key).
      expect(hex(resultA.conversationKey)).toBe(hex(convKey));
      expect(hex(resultB.conversationKey)).toBe(hex(convKey));
    },
  );

  // ── Test 15: Wrong device cannot unwrap key targeted at another device ──────

  it(
    "device B cannot unwrap a conversation key wrapped for device A (cross-device isolation)",
    () => {
      const convKey = makeConversationKey();
      const deviceA = generateKeyPair();
      const deviceB = generateKeyPair();

      // Wrap the key for device A only.
      const wrappedForA = wrapConversationKey(convKey, deviceA.publicKey);

      // Device B attempts to unwrap — must fail.
      expect(() => unwrapConversationKey(wrappedForA, deviceB.privateKey)).toThrow();

      // Device A succeeds.
      expect(() => unwrapConversationKey(wrappedForA, deviceA.privateKey)).not.toThrow();
    },
  );

  // ── Test 16: Mixed envelope types in the backlog ────────────────────────────

  it(
    "decryptBacklog handles mixed envelope types (conversation, approval_request, approval_resolved)",
    () => {
      const convKey = makeConversationKey();
      const deviceKP = generateKeyPair();
      const ts = 1_718_000_000_000;

      const messages = [
        { type: "conversation",       payload: "user: Hello agent!" },
        { type: "approval_request",   payload: JSON.stringify({ prompt: "Allow email access?", options: ["allow", "deny"] }) },
        { type: "conversation",       payload: "agent: Processing your request..." },
        { type: "approval_resolved",  payload: JSON.stringify({ decision: "allow" }) },
        { type: "conversation",       payload: "agent: Done — email access granted." },
      ];

      const envelopes = messages.map((m, i) =>
        encodeEnvelope(
          routing(`msg-mixed-${i + 1}`, m.type as EnvelopeRouting["envelopeType"], ts + i * 1000),
          enc(m.payload),
          convKey,
        ),
      );

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
      const result = decryptBacklog(envelopes, wrapped, deviceKP.privateKey);

      expect(result.plaintexts).toHaveLength(messages.length);
      for (let i = 0; i < messages.length; i++) {
        expect(
          dec(result.plaintexts[i]!),
          `mixed type envelope ${i + 1} must round-trip`,
        ).toBe(messages[i]!.payload);
      }
    },
  );

  // ── Test 17: Exposed conversationKey — reusable for future envelopes ─────────

  it(
    "decryptBacklog exposes conversationKey; caller uses it to decrypt a subsequent live envelope without re-unwrapping",
    () => {
      const convKey = makeConversationKey();
      const { envelopes } = buildBacklog(convKey, 5);
      const deviceKP = generateKeyPair();

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
      const { conversationKey } = decryptBacklog(envelopes, wrapped, deviceKP.privateKey);

      // Simulate a live envelope arriving after the backlog replay.
      const livePayload = "live message after backlog replay";
      const liveEnvelope = encodeEnvelope(
        routing("msg-live-1", "conversation", 1_718_999_999_999),
        enc(livePayload),
        convKey, // same conversation key — no re-wrap needed
      );

      // Device decrypts with the already-unwrapped key (no unwrap overhead).
      const liveDecrypted = dec(decryptEnvelopeContent(liveEnvelope, conversationKey));
      expect(liveDecrypted).toBe(livePayload);
    },
  );

  // ── Test 20: Large M=50 — scales without correctness regression ─────────────

  it(
    "M=50 large backlog: all 50 plaintexts recovered in order (scalability + correctness)",
    () => {
      const M = 50;
      const convKey = makeConversationKey();
      const { envelopes, plaintexts } = buildBacklog(convKey, M);
      const deviceKP = generateKeyPair();

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
      const result = decryptBacklog(envelopes, wrapped, deviceKP.privateKey);

      expect(result.plaintexts).toHaveLength(M);

      // Spot-check first, last, and middle.
      expect(dec(result.plaintexts[0]!)).toBe(plaintexts[0]!);
      expect(dec(result.plaintexts[24]!)).toBe(plaintexts[24]!);
      expect(dec(result.plaintexts[M - 1]!)).toBe(plaintexts[M - 1]!);

      // Full order assertion.
      for (let i = 0; i < M; i++) {
        expect(dec(result.plaintexts[i]!), `envelope ${i + 1}`).toBe(plaintexts[i]!);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Suite 3: KEY_WRAP_INFO constant
// ---------------------------------------------------------------------------

describe("KEY_WRAP_INFO constant", () => {
  it(
    "KEY_WRAP_INFO is the correct domain-separation string",
    () => {
      expect(KEY_WRAP_INFO).toBe("webchannel-key-wrap-v1");
    },
  );

  it(
    "key-wrap and conversation-key derivation use distinct HKDF info strings (domain separation)",
    () => {
      // The wrap info must differ from the conversation-key info to prevent
      // a shared ECDH secret from being reused across domains.
      expect(KEY_WRAP_INFO).not.toBe("webchannel-conversation-v1");
    },
  );
});

// ---------------------------------------------------------------------------
// Suite 4: Serialize → deserialize → decrypt integration
// ---------------------------------------------------------------------------

describe("late-join with serialized/deserialized envelopes (wire format)", () => {
  it(
    "M=10 envelopes round-tripped through JSON serialization still decrypt correctly after late-join key unwrap",
    () => {
      const M = 10;
      const convKey = makeConversationKey();
      const { envelopes: rawEnvelopes, plaintexts } = buildBacklog(convKey, M);
      const deviceKP = generateKeyPair();

      // Simulate wire transit: serialize each envelope to JSON bytes and deserialize back.
      const wireEnvelopes = rawEnvelopes.map((env) =>
        deserializeEnvelope(serializeEnvelope(env)),
      );

      const wrapped = wrapConversationKey(convKey, deviceKP.publicKey);
      const result = decryptBacklog(wireEnvelopes, wrapped, deviceKP.privateKey);

      expect(result.plaintexts).toHaveLength(M);
      for (let i = 0; i < M; i++) {
        expect(
          dec(result.plaintexts[i]!),
          `wire-round-tripped envelope ${i + 1}`,
        ).toBe(plaintexts[i]!);
      }
    },
  );
});
