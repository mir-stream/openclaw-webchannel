/**
 * Unit tests for the E2E Message Envelope Codec — Sub-AC 2.
 *
 * Sub-AC 2: E2E envelope codec — routing metadata plaintext, content ChaCha20-Poly1305 ciphertext.
 *
 * Coverage:
 *  1.  Envelope structure: content field has zero plaintext (nonce/ciphertext/tag only)
 *  2.  Serialized JSON: content object contains no plaintext fields whatsoever
 *  3.  Decryption with correct key recovers original plaintext
 *  4.  Decryption with wrong key throws (auth failure)
 *  5.  Routing metadata accessible without any key (plaintext routing)
 *  6.  Serialize → deserialize round-trip preserves all fields
 *  7.  Tampered ciphertext: flipping a byte throws on decryption
 *  8.  Tampered tag: flipping a byte throws on decryption
 *  9.  AAD round-trip: matching AAD on both sides succeeds
 * 10.  AAD mismatch: different AAD on decrypt throws
 * 11.  envelopeType is visible in plaintext (routing-level discriminator only)
 * 12.  Schema version mismatch rejects deserialization
 * 13.  Missing content fields reject deserialization
 * 14.  Missing routing fields reject deserialization
 * 15.  Full pipeline: X25519 key exchange → HKDF → envelope encode/decode
 * 16.  Relay operator cannot read content: third-party key produces wrong decrypt
 * 17.  Approval decision round-trip with AAD binding the approvalId
 * 18.  Empty plaintext round-trip (edge case)
 * 19.  Nonce uniqueness: two encodes of the same plaintext produce distinct nonces
 * 20.  Content ciphertext is distinct on every call (nonce uniqueness → distinct output)
 */

import { describe, it, expect } from "vitest";
import {
  encodeEnvelope,
  decryptEnvelopeContent,
  getEnvelopeRouting,
  serializeEnvelope,
  deserializeEnvelope,
  ENVELOPE_VERSION,
} from "./e2e-envelope.js";
import type { MessageEnvelope, EnvelopeRouting } from "./e2e-envelope.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
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

/** Fixed 32-byte test key. */
const TEST_KEY = new Uint8Array(32).fill(0x42);

/** A minimal valid routing object for test envelopes. */
const TEST_ROUTING: EnvelopeRouting = {
  agentId: "agent-abc123",
  tenant: "tenant-xyz",
  sub: "user-42",
  messageId: "msg-uuid-0001",
  envelopeType: "conversation",
  ts: 1_718_000_000_000,
};

/** A typical conversation message body. */
const TEST_CONTENT_STR = JSON.stringify({
  type: "user_message",
  text: "Hello, this is a secret message!",
});
const TEST_CONTENT = enc(TEST_CONTENT_STR);

// ---------------------------------------------------------------------------
// 1. Envelope structure: content field has zero plaintext
// ---------------------------------------------------------------------------

describe("MessageEnvelope: content field has zero plaintext", () => {
  it("content object has exactly three fields: nonce, ciphertext, tag — all strings", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);

    // The content object must have ONLY these three fields.
    const contentKeys = Object.keys(env.content).sort();
    expect(contentKeys).toEqual(["ciphertext", "nonce", "tag"].sort());

    // All three must be non-empty strings (base64url-encoded binary).
    expect(typeof env.content.nonce).toBe("string");
    expect(typeof env.content.ciphertext).toBe("string");
    expect(typeof env.content.tag).toBe("string");
    expect(env.content.nonce.length).toBeGreaterThan(0);
    expect(env.content.ciphertext.length).toBeGreaterThan(0);
    expect(env.content.tag.length).toBeGreaterThan(0);
  });

  it("content.ciphertext does not contain the plaintext string", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);

    // The ciphertext must not contain the original text (even as a substring).
    expect(env.content.ciphertext).not.toContain("Hello");
    expect(env.content.ciphertext).not.toContain("secret");
    expect(env.content.ciphertext).not.toContain("user_message");
  });

  it("content object does not have a 'text', 'plaintext', or 'body' field", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const c = env.content as Record<string, unknown>;

    // None of these keys should exist in the content block.
    expect(c["text"]).toBeUndefined();
    expect(c["plaintext"]).toBeUndefined();
    expect(c["body"]).toBeUndefined();
    expect(c["message"]).toBeUndefined();
    expect(c["payload"]).toBeUndefined();
    expect(c["data"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Serialized JSON: no plaintext in the serialized wire format
// ---------------------------------------------------------------------------

describe("MessageEnvelope: serialized JSON has no plaintext content", () => {
  it("JSON output does not contain the original plaintext anywhere", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const serialized = serializeEnvelope(env).toString("utf8");

    // The serialized envelope must never expose any content plaintext.
    expect(serialized).not.toContain("Hello");
    expect(serialized).not.toContain("secret message");
    expect(serialized).not.toContain("user_message"); // routing type only
  });

  it("content block in JSON has exactly nonce, ciphertext, tag keys and nothing else", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const parsed = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    const content = parsed["content"] as Record<string, unknown>;

    const keys = Object.keys(content).sort();
    expect(keys).toEqual(["ciphertext", "nonce", "tag"]);
  });

  it("routing metadata IS present in plaintext in the serialized JSON", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const serialized = serializeEnvelope(env).toString("utf8");

    // These routing fields should appear in the plaintext JSON.
    expect(serialized).toContain(TEST_ROUTING.agentId);
    expect(serialized).toContain(TEST_ROUTING.tenant);
    expect(serialized).toContain(TEST_ROUTING.sub);
    expect(serialized).toContain(TEST_ROUTING.messageId);
    expect(serialized).toContain(TEST_ROUTING.envelopeType);
  });

  it("schema version is present in serialized JSON as 1", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const parsed = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    expect(parsed["v"]).toBe(ENVELOPE_VERSION);
    expect(parsed["v"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Decryption with correct key recovers original plaintext
// ---------------------------------------------------------------------------

describe("decryptEnvelopeContent: correct key recovers plaintext", () => {
  it("decrypts a conversation message back to the original UTF-8 string", () => {
    const plaintext = enc("Hello, E2E envelope world!");
    const env = encodeEnvelope(TEST_ROUTING, plaintext, TEST_KEY);
    const recovered = decryptEnvelopeContent(env, TEST_KEY);
    expect(dec(recovered)).toBe("Hello, E2E envelope world!");
  });

  it("decrypts a JSON payload correctly", () => {
    const body = JSON.stringify({ type: "agent_message", text: "Agent reply!" });
    const env = encodeEnvelope(TEST_ROUTING, enc(body), TEST_KEY);
    const recovered = dec(decryptEnvelopeContent(env, TEST_KEY));
    const parsed = JSON.parse(recovered) as { type: string; text: string };
    expect(parsed.type).toBe("agent_message");
    expect(parsed.text).toBe("Agent reply!");
  });

  it("round-trip with a large payload (4 KB)", () => {
    const largePayload = new Uint8Array(4096).fill(0xcd);
    const env = encodeEnvelope(TEST_ROUTING, largePayload, TEST_KEY);
    const recovered = decryptEnvelopeContent(env, TEST_KEY);
    expect(recovered).toEqual(largePayload);
  });
});

// ---------------------------------------------------------------------------
// 4. Decryption with wrong key throws
// ---------------------------------------------------------------------------

describe("decryptEnvelopeContent: wrong key throws (auth failure)", () => {
  it("a different 32-byte key throws on decryption", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const wrongKey = new Uint8Array(32).fill(0x99);
    expect(() => decryptEnvelopeContent(env, wrongKey)).toThrow();
  });

  it("all-zeros key throws when the message was encrypted with a non-zero key", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const zeroKey = new Uint8Array(32);
    expect(() => decryptEnvelopeContent(env, zeroKey)).toThrow();
  });

  it("a key differing by only one bit throws", () => {
    const key = new Uint8Array(32).fill(0x01);
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, key);
    const offByOne = new Uint8Array(key);
    offByOne[0] ^= 0x01;
    expect(() => decryptEnvelopeContent(env, offByOne)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Routing metadata accessible without any key
// ---------------------------------------------------------------------------

describe("getEnvelopeRouting: plaintext routing fields require no key", () => {
  it("returns all routing fields identical to the originals", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const routing = getEnvelopeRouting(env);

    expect(routing.agentId).toBe(TEST_ROUTING.agentId);
    expect(routing.tenant).toBe(TEST_ROUTING.tenant);
    expect(routing.sub).toBe(TEST_ROUTING.sub);
    expect(routing.messageId).toBe(TEST_ROUTING.messageId);
    expect(routing.envelopeType).toBe(TEST_ROUTING.envelopeType);
    expect(routing.ts).toBe(TEST_ROUTING.ts);
  });

  it("routing extraction works on a deserialized envelope (from wire)", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const wireBytes = serializeEnvelope(env);
    const restored = deserializeEnvelope(wireBytes);
    const routing = getEnvelopeRouting(restored);

    expect(routing.agentId).toBe(TEST_ROUTING.agentId);
    expect(routing.sub).toBe(TEST_ROUTING.sub);
  });

  it("routing object has no content field", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const routing = getEnvelopeRouting(env) as Record<string, unknown>;

    // The routing extract must not accidentally include the content block.
    expect(routing["content"]).toBeUndefined();
    expect(routing["nonce"]).toBeUndefined();
    expect(routing["ciphertext"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Serialize → deserialize round-trip
// ---------------------------------------------------------------------------

describe("serializeEnvelope / deserializeEnvelope round-trip", () => {
  it("Buffer serialization round-trips all envelope fields correctly", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const bytes = serializeEnvelope(env);
    const restored = deserializeEnvelope(bytes);

    expect(restored.v).toBe(ENVELOPE_VERSION);
    expect(restored.agentId).toBe(TEST_ROUTING.agentId);
    expect(restored.tenant).toBe(TEST_ROUTING.tenant);
    expect(restored.sub).toBe(TEST_ROUTING.sub);
    expect(restored.messageId).toBe(TEST_ROUTING.messageId);
    expect(restored.envelopeType).toBe(TEST_ROUTING.envelopeType);
    expect(restored.ts).toBe(TEST_ROUTING.ts);
    expect(restored.content.nonce).toBe(env.content.nonce);
    expect(restored.content.ciphertext).toBe(env.content.ciphertext);
    expect(restored.content.tag).toBe(env.content.tag);
  });

  it("string serialization round-trips correctly", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const jsonString = serializeEnvelope(env).toString("utf8");
    const restored = deserializeEnvelope(jsonString);
    // Decryption must still work on the deserialized envelope.
    const recovered = decryptEnvelopeContent(restored, TEST_KEY);
    expect(dec(recovered)).toBe(TEST_CONTENT_STR);
  });

  it("full round-trip: encode → serialize → deserialize → decrypt recovers plaintext", () => {
    const message = "Full round-trip test payload!";
    const env = encodeEnvelope(TEST_ROUTING, enc(message), TEST_KEY);
    const restored = deserializeEnvelope(serializeEnvelope(env));
    const recovered = dec(decryptEnvelopeContent(restored, TEST_KEY));
    expect(recovered).toBe(message);
  });
});

// ---------------------------------------------------------------------------
// 7. Tampered ciphertext throws
// ---------------------------------------------------------------------------

describe("tamper detection: mutated ciphertext throws on decrypt", () => {
  it("flipping the first byte of ciphertext.nonce throws", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    // Decode nonce, flip first byte, re-encode.
    const nonce = Buffer.from(env.content.nonce, "base64url");
    nonce[0] ^= 0x01;
    const tampered: MessageEnvelope = {
      ...env,
      content: {
        ...env.content,
        nonce: nonce.toString("base64url"),
      },
    };
    expect(() => decryptEnvelopeContent(tampered, TEST_KEY)).toThrow();
  });

  it("flipping a byte in content.ciphertext throws", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const ct = Buffer.from(env.content.ciphertext, "base64url");
    ct[0] ^= 0xff;
    const tampered: MessageEnvelope = {
      ...env,
      content: { ...env.content, ciphertext: ct.toString("base64url") },
    };
    expect(() => decryptEnvelopeContent(tampered, TEST_KEY)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Tampered auth tag throws
// ---------------------------------------------------------------------------

describe("tamper detection: mutated auth tag throws on decrypt", () => {
  it("flipping a bit in content.tag throws", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const tag = Buffer.from(env.content.tag, "base64url");
    tag[0] ^= 0x01;
    const tampered: MessageEnvelope = {
      ...env,
      content: { ...env.content, tag: tag.toString("base64url") },
    };
    expect(() => decryptEnvelopeContent(tampered, TEST_KEY)).toThrow();
  });

  it("all-zeros tag throws", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const zeroTag = Buffer.alloc(16, 0x00).toString("base64url");
    const tampered: MessageEnvelope = {
      ...env,
      content: { ...env.content, tag: zeroTag },
    };
    expect(() => decryptEnvelopeContent(tampered, TEST_KEY)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. AAD round-trip
// ---------------------------------------------------------------------------

describe("AAD: additional authenticated data round-trip", () => {
  it("encrypt with AAD, decrypt with same AAD succeeds", () => {
    const aad = enc("nats.subject.chat.tenant1.agent1.user42");
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY, aad);
    const recovered = dec(decryptEnvelopeContent(env, TEST_KEY, aad));
    expect(recovered).toBe(TEST_CONTENT_STR);
  });

  it("AAD is not stored in the envelope content (zero-plaintext guarantee)", () => {
    const aad = enc("approval-id:abc123");
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY, aad);

    // The AAD must NOT appear anywhere in the envelope's content block.
    expect(env.content.ciphertext).not.toContain("abc123");
    expect(env.content.nonce).not.toContain("abc123");
    expect(env.content.tag).not.toContain("abc123");

    // The AAD must NOT appear in the serialized JSON at all.
    const json = serializeEnvelope(env).toString("utf8");
    expect(json).not.toContain("approval-id:abc123");
  });
});

// ---------------------------------------------------------------------------
// 10. AAD mismatch throws
// ---------------------------------------------------------------------------

describe("AAD mismatch: wrong AAD on decrypt throws", () => {
  it("different AAD string on decrypt throws", () => {
    const aad = enc("correct-aad");
    const wrongAad = enc("wrong-aad");
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY, aad);
    expect(() => decryptEnvelopeContent(env, TEST_KEY, wrongAad)).toThrow();
  });

  it("encrypting without AAD but decrypting with AAD throws", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    // Decrypting with spurious AAD must fail.
    expect(() =>
      decryptEnvelopeContent(env, TEST_KEY, enc("unexpected-aad")),
    ).toThrow();
  });

  it("encrypting with AAD but decrypting without AAD throws", () => {
    const aad = enc("required-aad");
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY, aad);
    // Omitting AAD on decrypt must fail.
    expect(() => decryptEnvelopeContent(env, TEST_KEY)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. envelopeType is plaintext
// ---------------------------------------------------------------------------

describe("envelopeType: visible in plaintext for routing decisions", () => {
  it("approval_request type is visible in the envelope without decryption", () => {
    const routing: EnvelopeRouting = {
      ...TEST_ROUTING,
      envelopeType: "approval_request",
    };
    const env = encodeEnvelope(routing, TEST_CONTENT, TEST_KEY);
    expect(env.envelopeType).toBe("approval_request");
    const json = serializeEnvelope(env).toString("utf8");
    expect(json).toContain("approval_request");
  });

  it("typing type is visible in the envelope without decryption", () => {
    const routing: EnvelopeRouting = { ...TEST_ROUTING, envelopeType: "typing" };
    const env = encodeEnvelope(routing, new Uint8Array(0), TEST_KEY);
    expect(env.envelopeType).toBe("typing");
  });

  it("all six envelopeTypes survive serialize/deserialize", () => {
    const types: Array<EnvelopeRouting["envelopeType"]> = [
      "conversation",
      "approval_request",
      "approval_decision",
      "approval_resolved",
      "history",
      "typing",
    ];
    for (const t of types) {
      const routing: EnvelopeRouting = { ...TEST_ROUTING, envelopeType: t };
      const env = encodeEnvelope(routing, TEST_CONTENT, TEST_KEY);
      const restored = deserializeEnvelope(serializeEnvelope(env));
      expect(restored.envelopeType).toBe(t);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Schema version mismatch rejects deserialization
// ---------------------------------------------------------------------------

describe("deserializeEnvelope: schema version validation", () => {
  it("throws when v is 2 (unsupported version)", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    obj["v"] = 2;
    expect(() => deserializeEnvelope(Buffer.from(JSON.stringify(obj)))).toThrow(
      /unsupported schema version/i,
    );
  });

  it("throws when v is missing", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    delete obj["v"];
    expect(() => deserializeEnvelope(Buffer.from(JSON.stringify(obj)))).toThrow();
  });

  it("throws when v is a string '1' instead of number 1", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    obj["v"] = "1"; // wrong type
    expect(() => deserializeEnvelope(Buffer.from(JSON.stringify(obj)))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 13. Missing content fields reject deserialization
// ---------------------------------------------------------------------------

describe("deserializeEnvelope: content field validation", () => {
  it("throws when content is missing", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    delete obj["content"];
    expect(() => deserializeEnvelope(Buffer.from(JSON.stringify(obj)))).toThrow();
  });

  it("throws when content.nonce is missing", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    const content = obj["content"] as Record<string, unknown>;
    delete content["nonce"];
    expect(() => deserializeEnvelope(Buffer.from(JSON.stringify(obj)))).toThrow();
  });

  it("throws when content.ciphertext is missing", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    const content = obj["content"] as Record<string, unknown>;
    delete content["ciphertext"];
    expect(() => deserializeEnvelope(Buffer.from(JSON.stringify(obj)))).toThrow();
  });

  it("throws when content.tag is missing", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    const content = obj["content"] as Record<string, unknown>;
    delete content["tag"];
    expect(() => deserializeEnvelope(Buffer.from(JSON.stringify(obj)))).toThrow();
  });

  it("throws on non-JSON input", () => {
    expect(() => deserializeEnvelope(Buffer.from("not-json"))).toThrow(
      /invalid JSON/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 14. Missing routing fields reject deserialization
// ---------------------------------------------------------------------------

describe("deserializeEnvelope: routing field validation", () => {
  const ROUTING_FIELDS = [
    "agentId",
    "tenant",
    "sub",
    "messageId",
    "envelopeType",
  ] as const;

  for (const field of ROUTING_FIELDS) {
    it(`throws when "${field}" is missing`, () => {
      const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
      const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
      delete obj[field];
      expect(() =>
        deserializeEnvelope(Buffer.from(JSON.stringify(obj))),
      ).toThrow();
    });

    it(`throws when "${field}" is an empty string`, () => {
      const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
      const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
      obj[field] = "";
      expect(() =>
        deserializeEnvelope(Buffer.from(JSON.stringify(obj))),
      ).toThrow();
    });
  }

  it("throws when ts is not a number", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    obj["ts"] = "not-a-number";
    expect(() => deserializeEnvelope(Buffer.from(JSON.stringify(obj)))).toThrow();
  });

  it("throws when ts is NaN", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    // JSON.stringify(NaN) → 'null' in JSON, but we can set it explicitly.
    const obj = JSON.parse(serializeEnvelope(env).toString("utf8")) as Record<string, unknown>;
    obj["ts"] = null;
    expect(() => deserializeEnvelope(Buffer.from(JSON.stringify(obj)))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 15. Full pipeline: X25519 key exchange → HKDF → envelope encode/decode
// ---------------------------------------------------------------------------

describe("Full E2E pipeline: X25519 → HKDF-SHA256 → envelope codec", () => {
  it("browser encrypts → agent decrypts using independently derived session keys", () => {
    // Key exchange: browser and agent each have an X25519 key pair.
    const browserKP = generateKeyPair();
    const agentKP = generateKeyPair();

    // Both derive the same session key via ECDH + HKDF.
    const rawSecretBrowser = deriveSharedSecret(browserKP.privateKey, agentKP.publicKey);
    const rawSecretAgent = deriveSharedSecret(agentKP.privateKey, browserKP.publicKey);

    // The shared secrets must be symmetric.
    expect(hex(rawSecretBrowser)).toBe(hex(rawSecretAgent));

    const browserKey = hkdfSha256(rawSecretBrowser, null, "webchannel-conversation-v1", 32);
    const agentKey = hkdfSha256(rawSecretAgent, null, "webchannel-conversation-v1", 32);

    // Both keys must be identical.
    expect(hex(browserKey)).toBe(hex(agentKey));

    // Browser encodes a message.
    const message = "Secret conversation content!";
    const routing: EnvelopeRouting = {
      agentId: "agent-007",
      tenant: "acme",
      sub: "user-browser-1",
      messageId: "msg-full-pipeline-1",
      envelopeType: "conversation",
      ts: 1_718_100_000_000,
    };
    const env = encodeEnvelope(routing, enc(message), browserKey);

    // Verify zero plaintext in content.
    expect(env.content.ciphertext).not.toContain("Secret");
    expect(JSON.stringify(env.content)).not.toContain("Secret");

    // Agent decrypts: must recover the original message.
    const recovered = dec(decryptEnvelopeContent(env, agentKey));
    expect(recovered).toBe(message);
  });

  it("relay operator cannot decrypt: third-party key produces wrong session key", () => {
    const browserKP = generateKeyPair();
    const agentKP = generateKeyPair();
    const eavesdropperKP = generateKeyPair();

    const sessionKey = hkdfSha256(
      deriveSharedSecret(browserKP.privateKey, agentKP.publicKey),
      null,
      "webchannel-v1",
      32,
    );

    const env = encodeEnvelope(TEST_ROUTING, enc("confidential payload"), sessionKey);

    // Eavesdropper (relay operator) only observes public keys.
    // They cannot derive the shared secret because they lack a private key.
    // Even using their own private key + one observed public key yields a
    // different session key.
    const eveKey = hkdfSha256(
      deriveSharedSecret(eavesdropperKP.privateKey, agentKP.publicKey),
      null,
      "webchannel-v1",
      32,
    );

    // Eve's key differs from the session key.
    expect(hex(eveKey)).not.toBe(hex(sessionKey));
    // Eve's decryption attempt must fail.
    expect(() => decryptEnvelopeContent(env, eveKey)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 16. Approval decision round-trip with AAD binding
// ---------------------------------------------------------------------------

describe("Approval decision round-trip with AAD binding the approvalId", () => {
  it("approvalId as AAD — correct AAD succeeds, wrong AAD fails", () => {
    const agentKP = generateKeyPair();
    const browserKP = generateKeyPair();

    const agentKey = hkdfSha256(
      deriveSharedSecret(agentKP.privateKey, browserKP.publicKey),
      null,
      "webchannel-approval-v1",
      32,
    );
    const browserKey = hkdfSha256(
      deriveSharedSecret(browserKP.privateKey, agentKP.publicKey),
      null,
      "webchannel-approval-v1",
      32,
    );

    // Keys must match.
    expect(hex(agentKey)).toBe(hex(browserKey));

    const approvalId = "approval-7a8b9c";
    const aad = enc(approvalId);
    const decision = JSON.stringify({ decision: "allow-once" });

    const routing: EnvelopeRouting = {
      ...TEST_ROUTING,
      envelopeType: "approval_decision",
      messageId: approvalId,
    };

    // Browser encrypts the approval decision with the approvalId as AAD.
    const env = encodeEnvelope(routing, enc(decision), browserKey, aad);

    // The approvalId must NOT appear inside the content block.
    expect(JSON.stringify(env.content)).not.toContain(approvalId);
    // But the messageId (same as approvalId) IS visible in plaintext routing.
    expect(env.messageId).toBe(approvalId);

    // Agent decrypts with correct AAD.
    const recovered = dec(decryptEnvelopeContent(env, agentKey, aad));
    expect(JSON.parse(recovered)).toEqual({ decision: "allow-once" });

    // A different approvalId as AAD must fail authentication.
    expect(() =>
      decryptEnvelopeContent(env, agentKey, enc("approval-wrong")),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 17. Empty plaintext round-trip (edge case)
// ---------------------------------------------------------------------------

describe("edge case: empty plaintext", () => {
  it("encrypts and decrypts empty content correctly", () => {
    const env = encodeEnvelope(TEST_ROUTING, new Uint8Array(0), TEST_KEY);

    // The envelope is still valid (auth tag covers empty ciphertext).
    expect(env.content.nonce.length).toBeGreaterThan(0);
    expect(env.content.tag.length).toBeGreaterThan(0);
    // ciphertext of empty input is empty string in base64url ("").
    expect(Buffer.from(env.content.ciphertext, "base64url").length).toBe(0);

    // Decryption must return empty bytes.
    const recovered = decryptEnvelopeContent(env, TEST_KEY);
    expect(recovered.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 18. Nonce uniqueness: two encodes of same plaintext → distinct nonces
// ---------------------------------------------------------------------------

describe("nonce uniqueness: random per encode call", () => {
  it("two encodes of the same plaintext with the same key produce distinct nonces", () => {
    const env1 = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const env2 = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);

    // Nonces must differ (random per encrypt call).
    expect(env1.content.nonce).not.toBe(env2.content.nonce);
  });

  it("two encodes produce distinct ciphertexts (nonce uniqueness → output uniqueness)", () => {
    const env1 = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const env2 = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);

    // Even with the same key and plaintext, different nonces → different ciphertext.
    expect(env1.content.ciphertext).not.toBe(env2.content.ciphertext);
  });

  it("both independently encrypted envelopes still decrypt to the same plaintext", () => {
    const env1 = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const env2 = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);

    const r1 = dec(decryptEnvelopeContent(env1, TEST_KEY));
    const r2 = dec(decryptEnvelopeContent(env2, TEST_KEY));
    expect(r1).toBe(TEST_CONTENT_STR);
    expect(r2).toBe(TEST_CONTENT_STR);
  });
});

// ---------------------------------------------------------------------------
// Additional structural invariants
// ---------------------------------------------------------------------------

describe("structural invariants", () => {
  it("envelope top-level keys include exactly v + routing fields + content", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const keys = new Set(Object.keys(env));

    // All expected top-level keys must be present.
    expect(keys.has("v")).toBe(true);
    expect(keys.has("agentId")).toBe(true);
    expect(keys.has("tenant")).toBe(true);
    expect(keys.has("sub")).toBe(true);
    expect(keys.has("messageId")).toBe(true);
    expect(keys.has("envelopeType")).toBe(true);
    expect(keys.has("ts")).toBe(true);
    expect(keys.has("content")).toBe(true);

    // No unexpected top-level keys (no content leaking to top level).
    const expected = new Set([
      "v",
      "agentId",
      "tenant",
      "sub",
      "messageId",
      "envelopeType",
      "ts",
      "content",
    ]);
    for (const k of keys) {
      expect(expected.has(k)).toBe(true);
    }
  });

  it("envelope v is always ENVELOPE_VERSION (1)", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    expect(env.v).toBe(ENVELOPE_VERSION);
    expect(env.v).toBe(1);
  });

  it("content.nonce decodes to exactly 12 bytes", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const nonce = Buffer.from(env.content.nonce, "base64url");
    expect(nonce.length).toBe(12);
  });

  it("content.tag decodes to exactly 16 bytes", () => {
    const env = encodeEnvelope(TEST_ROUTING, TEST_CONTENT, TEST_KEY);
    const tag = Buffer.from(env.content.tag, "base64url");
    expect(tag.length).toBe(16);
  });

  it("content.ciphertext decodes to same byte-length as plaintext (stream cipher property)", () => {
    const plaintext = enc("exactly 24 bytes here!");
    const env = encodeEnvelope(TEST_ROUTING, plaintext, TEST_KEY);
    const ct = Buffer.from(env.content.ciphertext, "base64url");
    expect(ct.length).toBe(plaintext.length);
  });
});
