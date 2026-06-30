/**
 * Unit tests for the E2E crypto primitive module.
 *
 * Sub-AC 1: X25519+HKDF-SHA256+ChaCha20-Poly1305 crypto primitive module
 *
 * Coverage:
 *  1. Key-pair generation — output shape, uniqueness
 *  2. ECDH shared-secret derivation — symmetry, determinism, length
 *  3. HKDF-SHA256 — output length, domain-separation isolation
 *  4. ChaCha20-Poly1305 round-trip — encrypt → decrypt correctness
 *  5. Full pipeline — X25519 → HKDF → ChaCha20-Poly1305 end-to-end
 *  6. Wrong-key rejection — decryption with a different key must throw
 *  7. Ciphertext tamper detection — flipping ciphertext bits must throw
 *  8. Auth-tag tamper detection — flipping tag bits must throw
 *  9. AAD round-trip — matching AAD succeeds
 * 10. AAD mismatch rejection — different AAD must throw
 * 11. Nonce uniqueness — distinct nonce per encrypt call
 * 12. Nonce / tag length invariants — 12-byte nonce, 16-byte tag
 */

import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
  encrypt,
  decrypt,
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

// ---------------------------------------------------------------------------
// 1. Key-pair generation
// ---------------------------------------------------------------------------

describe("generateKeyPair", () => {
  it("returns publicKey and privateKey each of exactly 32 bytes", () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.length).toBe(32);
  });

  it("produces distinct key pairs on each call (CSPRNG randomness)", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    // Collision probability is negligible (1/2^256) — treat as never.
    expect(hex(kp1.publicKey)).not.toBe(hex(kp2.publicKey));
    expect(hex(kp1.privateKey)).not.toBe(hex(kp2.privateKey));
  });

  it("public key and private key are different values within the same pair", () => {
    const kp = generateKeyPair();
    // The public key is the Curve25519 scalar-multiplication of the private
    // key with the base point — they should differ in almost all cases.
    expect(hex(kp.publicKey)).not.toBe(hex(kp.privateKey));
  });
});

// ---------------------------------------------------------------------------
// 2. ECDH shared-secret derivation
// ---------------------------------------------------------------------------

describe("deriveSharedSecret (X25519 ECDH)", () => {
  it("is symmetric: alice+bob_pub === bob+alice_pub", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const secretA = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const secretB = deriveSharedSecret(bob.privateKey, alice.publicKey);
    expect(hex(secretA)).toBe(hex(secretB));
  });

  it("returns a 32-byte shared secret", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    expect(secret).toBeInstanceOf(Uint8Array);
    expect(secret.length).toBe(32);
  });

  it("is deterministic: same inputs produce the same output", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const s1 = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const s2 = deriveSharedSecret(alice.privateKey, bob.publicKey);
    expect(hex(s1)).toBe(hex(s2));
  });

  it("different key pairs produce different shared secrets", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    const secretAliceBob = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const secretAliceCarol = deriveSharedSecret(alice.privateKey, carol.publicKey);
    // Alice×Bob ≠ Alice×Carol (astronomically unlikely to collide).
    expect(hex(secretAliceBob)).not.toBe(hex(secretAliceCarol));
  });
});

// ---------------------------------------------------------------------------
// 3. HKDF-SHA256 key derivation
// ---------------------------------------------------------------------------

describe("hkdfSha256", () => {
  it("expands a secret to exactly the requested key length (32 bytes)", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const key = hkdfSha256(secret, null, "webchannel-v1", 32);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("expands to arbitrary requested lengths (e.g. 16 bytes)", () => {
    const secret = new Uint8Array(32).fill(0xab);
    const key16 = hkdfSha256(secret, null, "test", 16);
    expect(key16.length).toBe(16);
  });

  it("is deterministic: same IKM/salt/info → same output", () => {
    const ikm = new Uint8Array(32).fill(0x01);
    const salt = new Uint8Array(32).fill(0x02);
    const k1 = hkdfSha256(ikm, salt, "deterministic-test", 32);
    const k2 = hkdfSha256(ikm, salt, "deterministic-test", 32);
    expect(hex(k1)).toBe(hex(k2));
  });

  it("null salt and all-zero salt produce the same output (RFC 5869 §2.2)", () => {
    const ikm = new Uint8Array(32).fill(0x03);
    // RFC 5869 §2.2: if salt is not provided, use a string of HashLen zeros.
    // For HMAC-SHA256, HashLen = 32.
    const kNull = hkdfSha256(ikm, null, "salt-test", 32);
    const kZero = hkdfSha256(ikm, new Uint8Array(32), "salt-test", 32);
    expect(hex(kNull)).toBe(hex(kZero));
  });

  it("different info strings produce cryptographically independent keys", () => {
    const secret = new Uint8Array(32).fill(0x05);
    const keyConversation = hkdfSha256(secret, null, "webchannel-conversation-v1", 32);
    const keyApproval = hkdfSha256(secret, null, "webchannel-approval-v1", 32);
    expect(hex(keyConversation)).not.toBe(hex(keyApproval));
  });

  it("different salts produce different keys (salt randomises the KDF)", () => {
    const ikm = new Uint8Array(32).fill(0x07);
    const salt1 = new Uint8Array(32).fill(0x10);
    const salt2 = new Uint8Array(32).fill(0x11);
    const k1 = hkdfSha256(ikm, salt1, "info", 32);
    const k2 = hkdfSha256(ikm, salt2, "info", 32);
    expect(hex(k1)).not.toBe(hex(k2));
  });

  it("different IKM values produce different keys", () => {
    const ikm1 = new Uint8Array(32).fill(0x20);
    const ikm2 = new Uint8Array(32).fill(0x21);
    const k1 = hkdfSha256(ikm1, null, "info", 32);
    const k2 = hkdfSha256(ikm2, null, "info", 32);
    expect(hex(k1)).not.toBe(hex(k2));
  });
});

// ---------------------------------------------------------------------------
// 4. ChaCha20-Poly1305 round-trip
// ---------------------------------------------------------------------------

describe("encrypt / decrypt (ChaCha20-Poly1305)", () => {
  it("round-trip: decrypt(encrypt(plaintext)) === plaintext", () => {
    const key = new Uint8Array(32).fill(0x42);
    const plaintext = enc("hello, E2E world!");
    const result = encrypt(key, plaintext);
    const recovered = decrypt(key, result.nonce, result.ciphertext, result.tag);
    expect(recovered).toEqual(plaintext);
  });

  it("round-trip with empty plaintext", () => {
    const key = new Uint8Array(32).fill(0x01);
    const plaintext = new Uint8Array(0);
    const result = encrypt(key, plaintext);
    const recovered = decrypt(key, result.nonce, result.ciphertext, result.tag);
    expect(recovered).toEqual(plaintext);
  });

  it("round-trip with a large plaintext (1 KB)", () => {
    const key = new Uint8Array(32).fill(0x11);
    const plaintext = new Uint8Array(1024).fill(0xcc);
    const { ciphertext, nonce, tag } = encrypt(key, plaintext);
    const recovered = decrypt(key, nonce, ciphertext, tag);
    expect(recovered).toEqual(plaintext);
  });

  it("ciphertext length equals plaintext length (stream cipher property)", () => {
    const key = new Uint8Array(32).fill(0x09);
    const plaintext = enc("exactly 19 bytes!!"); // 19 bytes
    const { ciphertext } = encrypt(key, plaintext);
    expect(ciphertext.length).toBe(plaintext.length);
  });

  it("nonce is 12 bytes", () => {
    const key = new Uint8Array(32).fill(0x0a);
    const { nonce } = encrypt(key, enc("test"));
    expect(nonce.length).toBe(12);
  });

  it("auth tag is 16 bytes", () => {
    const key = new Uint8Array(32).fill(0x0b);
    const { tag } = encrypt(key, enc("test"));
    expect(tag.length).toBe(16);
  });

  it("nonce is distinct on every encrypt call (random nonce generation)", () => {
    const key = new Uint8Array(32).fill(0x0c);
    const plaintext = enc("same content");
    const r1 = encrypt(key, plaintext);
    const r2 = encrypt(key, plaintext);
    // 1/2^96 probability of collision — treat as never.
    expect(hex(r1.nonce)).not.toBe(hex(r2.nonce));
  });

  it("ciphertext is distinct on every call (nonce uniqueness → distinct output)", () => {
    const key = new Uint8Array(32).fill(0x0d);
    const plaintext = enc("same content");
    const r1 = encrypt(key, plaintext);
    const r2 = encrypt(key, plaintext);
    expect(hex(r1.ciphertext)).not.toBe(hex(r2.ciphertext));
  });

  // ── Wrong-key rejection ──────────────────────────────────────────────────

  it("decryption with a wrong key throws (auth failure)", () => {
    const key = new Uint8Array(32).fill(0x42);
    const wrongKey = new Uint8Array(32).fill(0x43);
    const plaintext = enc("secret content");
    const { ciphertext, nonce, tag } = encrypt(key, plaintext);
    expect(() => decrypt(wrongKey, nonce, ciphertext, tag)).toThrow();
  });

  it("decryption with a zeroed key throws when encrypted with a non-zero key", () => {
    const key = new Uint8Array(32).fill(0xff);
    const zeroKey = new Uint8Array(32); // all zeros
    const { ciphertext, nonce, tag } = encrypt(key, enc("payload"));
    expect(() => decrypt(zeroKey, nonce, ciphertext, tag)).toThrow();
  });

  // ── Ciphertext tamper detection ──────────────────────────────────────────

  it("decryption after flipping first ciphertext byte throws", () => {
    const key = new Uint8Array(32).fill(0x01);
    const plaintext = enc("tamper-proof payload");
    const { ciphertext, nonce, tag } = encrypt(key, plaintext);

    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0x01; // flip one bit

    expect(() => decrypt(key, nonce, tampered, tag)).toThrow();
  });

  it("decryption after flipping last ciphertext byte throws", () => {
    const key = new Uint8Array(32).fill(0x02);
    const plaintext = enc("another tamper test");
    const { ciphertext, nonce, tag } = encrypt(key, plaintext);

    const tampered = new Uint8Array(ciphertext);
    tampered[tampered.length - 1] ^= 0x80;

    expect(() => decrypt(key, nonce, tampered, tag)).toThrow();
  });

  it("decryption after flipping a bit in the auth tag throws", () => {
    const key = new Uint8Array(32).fill(0x03);
    const plaintext = enc("tag tamper test");
    const { ciphertext, nonce, tag } = encrypt(key, plaintext);

    const tamperedTag = new Uint8Array(tag);
    tamperedTag[0] ^= 0x01;

    expect(() => decrypt(key, nonce, ciphertext, tamperedTag)).toThrow();
  });

  it("decryption with a wrong nonce throws (auth failure)", () => {
    const key = new Uint8Array(32).fill(0x04);
    const plaintext = enc("nonce test");
    const { ciphertext, nonce, tag } = encrypt(key, plaintext);

    const wrongNonce = new Uint8Array(nonce);
    wrongNonce[0] ^= 0x01;

    expect(() => decrypt(key, wrongNonce, ciphertext, tag)).toThrow();
  });

  // ── Additional Authenticated Data (AAD) ─────────────────────────────────

  it("AAD round-trip: matching AAD on both sides succeeds", () => {
    const key = new Uint8Array(32).fill(0x05);
    const plaintext = enc("confidential approval decision");
    const aad = enc("approval-id:abc123");
    const { ciphertext, nonce, tag } = encrypt(key, plaintext, aad);
    const recovered = decrypt(key, nonce, ciphertext, tag, aad);
    expect(dec(recovered)).toBe("confidential approval decision");
  });

  it("AAD mismatch: different AAD on decrypt throws (auth failure)", () => {
    const key = new Uint8Array(32).fill(0x06);
    const plaintext = enc("payload with aad");
    const aad = enc("approval-id:correct");
    const wrongAad = enc("approval-id:wrong");
    const { ciphertext, nonce, tag } = encrypt(key, plaintext, aad);
    expect(() => decrypt(key, nonce, ciphertext, tag, wrongAad)).toThrow();
  });

  it("encrypting with AAD but decrypting without AAD throws", () => {
    const key = new Uint8Array(32).fill(0x07);
    const plaintext = enc("protected");
    const aad = enc("must-include-aad");
    const { ciphertext, nonce, tag } = encrypt(key, plaintext, aad);
    // No AAD on decrypt — auth fails.
    expect(() => decrypt(key, nonce, ciphertext, tag)).toThrow();
  });

  it("encrypting without AAD but decrypting with AAD throws", () => {
    const key = new Uint8Array(32).fill(0x08);
    const plaintext = enc("no aad on encrypt");
    const { ciphertext, nonce, tag } = encrypt(key, plaintext);
    // Unexpected AAD on decrypt — auth fails.
    expect(() => decrypt(key, nonce, ciphertext, tag, enc("spurious"))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Full pipeline: X25519 → HKDF-SHA256 → ChaCha20-Poly1305
// ---------------------------------------------------------------------------

describe("Full E2E pipeline (X25519 ECDH → HKDF-SHA256 → ChaCha20-Poly1305)", () => {
  it("alice encrypts → bob decrypts using independently derived session keys", () => {
    // Key exchange
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    // Both independently derive the same session key
    const rawSecretAlice = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const rawSecretBob = deriveSharedSecret(bob.privateKey, alice.publicKey);

    // Verify the shared secret is symmetric
    expect(hex(rawSecretAlice)).toBe(hex(rawSecretBob));

    // Both run HKDF with the same parameters to get the session key
    const keyAlice = hkdfSha256(rawSecretAlice, null, "webchannel-conversation-v1", 32);
    const keyBob = hkdfSha256(rawSecretBob, null, "webchannel-conversation-v1", 32);

    // Keys must be identical (deterministic KDF from same secret)
    expect(hex(keyAlice)).toBe(hex(keyBob));

    // Alice encrypts
    const message = '{"type":"user_message","text":"E2E hello from Alice!"}';
    const plaintext = enc(message);
    const { ciphertext, nonce, tag } = encrypt(keyAlice, plaintext);

    // Bob decrypts
    const recovered = decrypt(keyBob, nonce, ciphertext, tag);
    expect(dec(recovered)).toBe(message);
  });

  it("relay operator cannot decrypt: a third-party key pair produces wrong session key", () => {
    // Alice and Bob exchange keys
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const keyAlice = hkdfSha256(
      deriveSharedSecret(alice.privateKey, bob.publicKey),
      null,
      "webchannel-v1",
      32,
    );

    // Alice encrypts
    const { ciphertext, nonce, tag } = encrypt(keyAlice, enc("secret message"));

    // Relay operator (Eve) does not know Alice's private key or Bob's private key.
    // Eve can only observe Alice's public key and Bob's public key on the wire.
    // Even with both public keys, Eve cannot derive the shared secret.
    const eve = generateKeyPair();
    // Eve tries to derive a key using her own private key with Alice's public key.
    const eveKey = hkdfSha256(
      deriveSharedSecret(eve.privateKey, alice.publicKey),
      null,
      "webchannel-v1",
      32,
    );

    // Eve's key is different from the Alice-Bob session key.
    expect(hex(eveKey)).not.toBe(hex(keyAlice));
    // Eve's decryption fails.
    expect(() => decrypt(eveKey, nonce, ciphertext, tag)).toThrow();
  });

  it("approval decision round-trip with AAD binding the approval ID", () => {
    const agent = generateKeyPair();
    const browser = generateKeyPair();

    const sessionKey = hkdfSha256(
      deriveSharedSecret(agent.privateKey, browser.publicKey),
      null,
      "webchannel-approval-v1",
      32,
    );
    const browserSessionKey = hkdfSha256(
      deriveSharedSecret(browser.privateKey, agent.publicKey),
      null,
      "webchannel-approval-v1",
      32,
    );

    // Approval ID is the AAD (authenticated but not encrypted —
    // correlates the decision to the request without revealing content).
    const approvalId = "approval-7a8b9c";
    const decision = enc(JSON.stringify({ decision: "allow-once" }));
    const aad = enc(approvalId);

    // Browser encrypts the approval decision
    const { ciphertext, nonce, tag } = encrypt(browserSessionKey, decision, aad);

    // Agent decrypts and verifies the AAD matches the expected approval ID
    const recovered = decrypt(sessionKey, nonce, ciphertext, tag, aad);
    expect(dec(recovered)).toBe(JSON.stringify({ decision: "allow-once" }));

    // A different approval ID as AAD would fail authentication
    expect(() =>
      decrypt(sessionKey, nonce, ciphertext, tag, enc("approval-different")),
    ).toThrow();
  });

  it("multi-message sequence: each message uses a distinct nonce", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const key = hkdfSha256(
      deriveSharedSecret(alice.privateKey, bob.publicKey),
      null,
      "webchannel-v1",
      32,
    );

    const messages = ["message 1", "message 2", "message 3"];
    const nonces: string[] = [];

    for (const msg of messages) {
      const { nonce, ciphertext, tag } = encrypt(key, enc(msg));
      nonces.push(hex(nonce));
      // Each message is correctly decryptable
      const recovered = decrypt(key, nonce, ciphertext, tag);
      expect(dec(recovered)).toBe(msg);
    }

    // All nonces must be distinct (random nonce generation)
    const uniqueNonces = new Set(nonces);
    expect(uniqueNonces.size).toBe(messages.length);
  });
});
