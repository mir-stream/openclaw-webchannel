import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign, type JsonWebKey } from "node:crypto";
import { PopChallengeStore, popSignedMessage, type PopPublicJwk } from "./pop-challenge.js";

// Generate an Ed25519 device keypair; export the public half as a JWK.
function makeDevice(): { popPublicJwk: PopPublicJwk; sign: (msg: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey & { x: string };
  const popPublicJwk: PopPublicJwk = { kty: jwk.kty!, crv: (jwk as { crv: string }).crv, x: jwk.x };
  return {
    popPublicJwk,
    sign: (msg: string) => edSign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64url"),
  };
}

describe("PopChallengeStore (gap ① signed-nonce PoP)", () => {
  it("accepts a valid signature over the issued nonce", () => {
    const store = new PopChallengeStore();
    const dev = makeDevice();
    const nonce = store.issue("alice");
    const sig = dev.sign(popSignedMessage("alice", nonce));
    expect(store.verify({ peerId: "alice", nonce, signatureB64Url: sig, popPublicJwk: dev.popPublicJwk }))
      .toEqual({ ok: true, reason: "verified" });
  });

  it("rejects a wrong/forged signature (401)", () => {
    const store = new PopChallengeStore();
    const dev = makeDevice();
    const attacker = makeDevice();
    const nonce = store.issue("alice");
    const sig = attacker.sign(popSignedMessage("alice", nonce)); // signed by the wrong key
    expect(store.verify({ peerId: "alice", nonce, signatureB64Url: sig, popPublicJwk: dev.popPublicJwk }).ok)
      .toBe(false);
  });

  it("rejects a missing nonce (never issued) (401)", () => {
    const store = new PopChallengeStore();
    const dev = makeDevice();
    const sig = dev.sign(popSignedMessage("alice", "made-up-nonce"));
    expect(store.verify({ peerId: "alice", nonce: "made-up-nonce", signatureB64Url: sig, popPublicJwk: dev.popPublicJwk }))
      .toEqual({ ok: false, reason: "nonce-missing" });
  });

  it("rejects an expired nonce (401)", () => {
    let t = 1_000_000;
    const store = new PopChallengeStore(120_000, () => t);
    const dev = makeDevice();
    const nonce = store.issue("alice");
    t += 120_001; // past TTL
    const sig = dev.sign(popSignedMessage("alice", nonce));
    expect(store.verify({ peerId: "alice", nonce, signatureB64Url: sig, popPublicJwk: dev.popPublicJwk }))
      .toEqual({ ok: false, reason: "nonce-expired" });
  });

  it("is single-use: a replayed valid proof is rejected (401)", () => {
    const store = new PopChallengeStore();
    const dev = makeDevice();
    const nonce = store.issue("alice");
    const sig = dev.sign(popSignedMessage("alice", nonce));
    const args = { peerId: "alice", nonce, signatureB64Url: sig, popPublicJwk: dev.popPublicJwk };
    expect(store.verify(args).ok).toBe(true);
    expect(store.verify(args)).toEqual({ ok: false, reason: "nonce-missing" }); // replay
  });

  it("rejects a signature bound to a different peer (401)", () => {
    const store = new PopChallengeStore();
    const dev = makeDevice();
    const nonce = store.issue("alice");
    // Device signs the message for "mallory" but presents it as "alice".
    const sig = dev.sign(popSignedMessage("mallory", nonce));
    expect(store.verify({ peerId: "alice", nonce, signatureB64Url: sig, popPublicJwk: dev.popPublicJwk }))
      .toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("rejects a non-Ed25519 pop key (e.g. an X25519 cnf key) (401)", () => {
    const store = new PopChallengeStore();
    const dev = makeDevice();
    const nonce = store.issue("alice");
    const sig = dev.sign(popSignedMessage("alice", nonce));
    const x25519Jwk: PopPublicJwk = { kty: "OKP", crv: "X25519", x: dev.popPublicJwk.x };
    expect(store.verify({ peerId: "alice", nonce, signatureB64Url: sig, popPublicJwk: x25519Jwk }))
      .toEqual({ ok: false, reason: "not-ed25519" });
  });
});
