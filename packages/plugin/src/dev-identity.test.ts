/**
 * F2 — the well-known DEV-OPEN agent identity key (dev/e2e register-hop fallback).
 *
 * Proves the agent and the dev browser drivers derive the SAME keypair (so the
 * pinned public authenticates the agent's wrap), and that `keyPairFromSeed` yields
 * a real, interoperable X25519 pair.
 */

import { describe, it, expect } from "vitest";

import {
  devOpenAgentIdentityKeyPair,
  devOpenAgentIdentityPublicB64url,
} from "./dev-identity.js";
import { keyPairFromSeed, generateKeyPair } from "./e2e-crypto.js";
import { wrapConversationKey, unwrapConversationKey } from "./late-join-decryptor.js";
import { randomBytes } from "node:crypto";

describe("dev-identity (F2 dev-open register-hop fallback)", () => {
  it("is deterministic: the keypair and its b64url public are stable across calls", () => {
    const a = devOpenAgentIdentityKeyPair();
    const b = devOpenAgentIdentityKeyPair();
    expect(Buffer.from(a.privateKey).equals(Buffer.from(b.privateKey))).toBe(true);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
    expect(a.publicKey.length).toBe(32);
    expect(a.privateKey.length).toBe(32);
  });

  it("the exported b64url public matches the keypair's public half", () => {
    const kp = devOpenAgentIdentityKeyPair();
    expect(devOpenAgentIdentityPublicB64url()).toBe(
      Buffer.from(kp.publicKey).toString("base64url"),
    );
  });

  it("the agent wrap under the dev identity key unwraps against its pinned public + peerId AAD", () => {
    const K = new Uint8Array(randomBytes(32));
    const agentId = devOpenAgentIdentityKeyPair();
    const deviceKP = generateKeyPair();
    const peerId = "dev-peer";

    const wrapped = wrapConversationKey(K, deviceKP.publicKey, {
      agentIdentityKeyPair: agentId,
      peerId,
    });
    const recovered = unwrapConversationKey(wrapped, deviceKP.privateKey, {
      agentPublicKey: agentId.publicKey,
      peerId,
    });
    expect(Buffer.from(recovered).equals(Buffer.from(K))).toBe(true);
  });
});

describe("keyPairFromSeed", () => {
  it("throws on a non-32-byte seed", () => {
    expect(() => keyPairFromSeed(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it("stores the seed verbatim as the private scalar and derives a matching public", () => {
    const seed = new Uint8Array(randomBytes(32));
    const kp = keyPairFromSeed(seed);
    expect(Buffer.from(kp.privateKey).equals(Buffer.from(seed))).toBe(true);
    // Same seed → same public (deterministic).
    expect(Buffer.from(keyPairFromSeed(seed).publicKey).equals(Buffer.from(kp.publicKey))).toBe(true);
  });
});
