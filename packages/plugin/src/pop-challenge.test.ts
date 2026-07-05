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

  it("keeps concurrent challenges for the SAME peerId independent (multi-device)", () => {
    // Two devices of one user share the same peerId (Phase 6). Each issues its
    // own challenge; the first must still verify after the second overwrote
    // nothing — keying by nonce (not peerId) is what makes this hold.
    const store = new PopChallengeStore();
    const devA = makeDevice();
    const devB = makeDevice();
    const nonceA = store.issue("alice"); // device A challenge
    const nonceB = store.issue("alice"); // device B challenge (must NOT evict A's)
    expect(nonceA).not.toBe(nonceB);
    expect(store.size).toBe(2);

    // Device A registers with its own nonce — still valid despite B's later issue.
    const sigA = devA.sign(popSignedMessage("alice", nonceA));
    expect(store.verify({ peerId: "alice", nonce: nonceA, signatureB64Url: sigA, popPublicJwk: devA.popPublicJwk }))
      .toEqual({ ok: true, reason: "verified" });
    // Device B registers with its own nonce — independent, also valid.
    const sigB = devB.sign(popSignedMessage("alice", nonceB));
    expect(store.verify({ peerId: "alice", nonce: nonceB, signatureB64Url: sigB, popPublicJwk: devB.popPublicJwk }))
      .toEqual({ ok: true, reason: "verified" });
  });

  it("rejects a nonce issued to a DIFFERENT peer, WITHOUT burning the victim's nonce (peerId binding, 401)", () => {
    const store = new PopChallengeStore();
    const dev = makeDevice();
    const nonce = store.issue("alice"); // bound to alice's bucket only
    const sig = dev.sign(popSignedMessage("mallory", nonce));
    // mallory presents alice's nonce — it isn't in mallory's bucket → missing.
    expect(store.verify({ peerId: "mallory", nonce, signatureB64Url: sig, popPublicJwk: dev.popPublicJwk }))
      .toEqual({ ok: false, reason: "nonce-missing" });
    // Crucially, mallory's probe did NOT consume alice's nonce — alice can still register.
    const aliceSig = dev.sign(popSignedMessage("alice", nonce));
    expect(store.verify({ peerId: "alice", nonce, signatureB64Url: aliceSig, popPublicJwk: dev.popPublicJwk }))
      .toEqual({ ok: true, reason: "verified" });
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

  // S2: an issued-but-never-verified nonce must not linger past its TTL.
  describe("S2 — TTL sweep bounds abandoned nonces", () => {
    it("sweep() evicts only expired nonces", () => {
      let clock = 1_000;
      const store = new PopChallengeStore(100, () => clock);
      store.issue("alice"); // expires at 1_100
      clock = 1_050;
      store.issue("bob"); // expires at 1_150
      expect(store.size).toBe(2);

      clock = 1_120; // alice expired, bob still live
      expect(store.sweep()).toBe(1);
      expect(store.size).toBe(1);
    });

    it("caps live nonces PER peer, evicting only that peer's own oldest (flood self-limits)", () => {
      // All nonces stay within TTL (no sweep eviction), so only the per-peer cap
      // engages. maxNoncesPerPeer=2 → alice's 3rd issue evicts alice's oldest (n1).
      let clock = 0;
      const store = new PopChallengeStore(100_000, () => clock, 2);
      const n1 = store.issue("alice");
      store.issue("alice");
      store.issue("alice"); // over per-peer cap → evict alice's oldest (n1)
      expect(store.size).toBe(2); // alice bounded to 2, never more
      expect(store.verify({ peerId: "alice", nonce: n1, signatureB64Url: "x", popPublicJwk: { kty: "OKP", crv: "Ed25519", x: "y" } }))
        .toEqual({ ok: false, reason: "nonce-missing" }); // n1 was evicted
    });

    it("one peer's challenge flood does NOT evict another peer's in-flight nonce (cross-peer isolation)", () => {
      let clock = 0;
      const store = new PopChallengeStore(100_000, () => clock, 2);
      const dev = makeDevice();
      const victimNonce = store.issue("victim"); // victim's single in-flight challenge
      // Attacker floods its OWN peerId well past the per-peer cap.
      for (let i = 0; i < 50; i++) store.issue("attacker");
      // Victim's nonce is untouched — the cap only evicted the attacker's own oldest.
      const sig = dev.sign(popSignedMessage("victim", victimNonce));
      expect(store.verify({ peerId: "victim", nonce: victimNonce, signatureB64Url: sig, popPublicJwk: dev.popPublicJwk }))
        .toEqual({ ok: true, reason: "verified" });
      // Attacker is self-bounded to the cap; total = attacker(2) + victim(1) before consume.
      expect(store.size).toBe(2); // victim consumed above → only attacker's 2 remain
    });

    it("issue() opportunistically sweeps so abandoned nonces don't accumulate", () => {
      let clock = 0;
      const store = new PopChallengeStore(100, () => clock);
      // Distinct peers each abandon their challenge; without the sweep the store
      // would grow by one per distinct peerId forever.
      for (let i = 0; i < 20; i++) {
        clock = i * 1_000; // each issue is well past the previous TTL
        store.issue(`peer-${i}`);
      }
      // Only the most-recent issue survives (all prior ones swept as expired).
      expect(store.size).toBe(1);
    });
  });
});
