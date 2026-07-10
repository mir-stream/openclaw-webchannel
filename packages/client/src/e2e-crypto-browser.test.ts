/**
 * Browser handshake-frame codec hardening.
 *
 * Mirrors the agent-side `parseKeyExchange` 32-byte guard (F1): a `key_exchange`
 * frame whose pubKey does not decode to exactly 32 bytes is an ignorable frame,
 * not a value fed into WebCrypto importKey (which would throw downstream).
 */

import { describe, it, expect } from "vitest";

import {
  base64urlEncode,
  generateX25519KeyPair,
  keyExchangeFrame,
  parseKeyExchange,
} from "./e2e-crypto-browser.js";

/** A `key_exchange` frame whose pubKey base64url-decodes to `len` bytes. */
function malformedKeyExchange(len: number): string {
  return keyExchangeFrame(base64urlEncode(new Uint8Array(len).fill(7)));
}

describe("browser parseKeyExchange (malformed-key hardening)", () => {
  it("rejects a pubKey that does not decode to exactly 32 bytes", () => {
    for (const len of [0, 1, 16, 31, 33, 64]) {
      expect(parseKeyExchange(malformedKeyExchange(len))).toBeNull();
    }
  });

  it("accepts a genuine 32-byte X25519 public key", async () => {
    const kp = await generateX25519KeyPair();
    const parsed = parseKeyExchange(keyExchangeFrame(kp.publicKeyB64url));
    expect(parsed).toBe(kp.publicKeyB64url);
  });

  it("still rejects non-key_exchange and unparseable frames", () => {
    expect(parseKeyExchange("not json")).toBeNull();
    expect(parseKeyExchange(JSON.stringify({ type: "other", pubKey: "x" }))).toBeNull();
    expect(parseKeyExchange(JSON.stringify({ type: "key_exchange" }))).toBeNull();
  });
});
