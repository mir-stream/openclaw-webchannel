/**
 * Unit tests for per-credential NATS revocation (issues #7 + #12).
 *
 * Pure crypto — decode/encode/sign only, no real nats-server, so this runs in
 * any sandbox. Covers the opt-in operator seed, the addRevocation re-encoding
 * (preservation + merge + wildcard), and input validation.
 */

import { describe, expect, it } from "vitest";
import { decode, encodeAccount, type Account } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";

import { setupTrustChain } from "./setup-trust-chain.js";
import { mintNatsUserCreds } from "./nats-user-creds.js";
import { addRevocation } from "./account-revocation.js";

describe("operator seed opt-in (issue #7)", () => {
  it("returns private.operatorSeed ('SO…') only when returnOperatorSeed is set", async () => {
    const withSeed = await setupTrustChain({ returnOperatorSeed: true });
    expect(withSeed.private.operatorSeed).toMatch(/^SO/);

    const withoutSeed = await setupTrustChain();
    expect(withoutSeed.private.operatorSeed).toBeUndefined();
  });
});

describe("addRevocation (issue #7)", () => {
  // Build a self-contained chain + a minted user pubkey for the happy-path tests.
  async function fixture() {
    const chain = await setupTrustChain({ returnOperatorSeed: true });
    const operatorSeed = chain.private.operatorSeed!;
    const accountJwt = chain.natsConfig.mode === "self-contained" ? chain.natsConfig.accountJwt : "";
    const minted = await mintNatsUserCreds({
      accountSeed: chain.private.natsAccountSeed,
      tenant: "t1",
      role: "agent",
    });
    return { chain, operatorSeed, accountJwt, userPubkey: minted.userPubkey };
  }

  it("records the revocation, preserves the account sub + limits", async () => {
    const { accountJwt, operatorSeed, userPubkey } = await fixture();
    const before = decode<Account>(accountJwt);

    const at = 1_700_000_000;
    const next = await addRevocation(accountJwt, operatorSeed, userPubkey, at);
    const after = decode<Account>(next);

    expect(after.nats.revocations?.[userPubkey]).toBe(at);
    // Same account public key (drop-in replacement for the resolver entry).
    expect(after.sub).toBe(before.sub);
    // Re-signed by the operator: iss stays the account's operator (else a
    // nats-server trusting that operator rejects the whole account JWT).
    const operatorPub = fromSeed(new TextEncoder().encode(operatorSeed)).getPublicKey();
    expect(after.iss).toBe(operatorPub);
    expect(after.iss).toBe(before.iss);
    // Unlimited limits set at setup survive the re-encode (else account bricks).
    expect(after.nats.limits?.conn).toBe(-1);
    expect(after.nats.limits?.subs).toBe(-1);
  });

  it("preserves top-level exp, nbf, and aud while regenerating signing metadata", async () => {
    const { accountJwt, operatorSeed, userPubkey } = await fixture();
    const decoded = decode<Account>(accountJwt);
    const operatorKp = fromSeed(new TextEncoder().encode(operatorSeed));
    const constrained = await encodeAccount(
      decoded.name,
      fromPublic(decoded.sub),
      decoded.nats,
      {
        signer: operatorKp,
        exp: 2_000_000_000,
        nbf: 1_700_000_000,
        aud: "containment-control-plane",
      },
    );
    const before = decode<Account>(constrained);

    const next = await addRevocation(constrained, operatorSeed, userPubkey, 1_800_000_000);
    const after = decode<Account>(next);

    expect(after.exp).toBe(before.exp);
    expect(after.nbf).toBe(before.nbf);
    expect(after.aud).toBe(before.aud);
    expect(after.jti).not.toBe(before.jti);
    expect(after.iss).toBe(before.iss);
  });

  it("rejects a valid-but-foreign operator seed (wrong chain)", async () => {
    const { accountJwt, userPubkey } = await fixture();
    // Chain B: a distinct, valid trust chain whose operator seed passes the
    // `SO…` prefix check but does NOT sign account A.
    const chainB = await setupTrustChain({ returnOperatorSeed: true });
    await expect(
      addRevocation(accountJwt, chainB.private.operatorSeed!, userPubkey, 1000),
    ).rejects.toThrow(/does not sign this account|issuer/);
  });

  it("merges a second revocation without dropping the first", async () => {
    const { chain, accountJwt, operatorSeed, userPubkey } = await fixture();
    const other = (
      await mintNatsUserCreds({ accountSeed: chain.private.natsAccountSeed, tenant: "t1", role: "agent" })
    ).userPubkey;

    const once = await addRevocation(accountJwt, operatorSeed, userPubkey, 1000);
    const twice = await addRevocation(once, operatorSeed, other, 2000);
    const after = decode<Account>(twice);

    expect(after.nats.revocations?.[userPubkey]).toBe(1000);
    expect(after.nats.revocations?.[other]).toBe(2000);
  });

  it("accepts and records the '*' wildcard (revoke all users)", async () => {
    const { accountJwt, operatorSeed } = await fixture();
    const next = await addRevocation(accountJwt, operatorSeed, "*", 1500);
    const after = decode<Account>(next);
    expect(after.nats.revocations?.["*"]).toBe(1500);
  });

  it.each([
    ["same user key", false],
    ["wildcard", true],
  ])("never lowers an existing revocation floor for %s", async (_label, wildcard) => {
    const { accountJwt, operatorSeed, userPubkey } = await fixture();
    const key = wildcard ? "*" : userPubkey;
    const once = await addRevocation(accountJwt, operatorSeed, key, 2000);
    const twice = await addRevocation(once, operatorSeed, key, 1000);
    const after = decode<Account>(twice);

    expect(after.nats.revocations?.[key]).toBe(2000);
  });

  describe("input validation", () => {
    it("rejects an account seed ('SA…') passed as the operator seed", async () => {
      const { accountJwt, chain, userPubkey } = await fixture();
      await expect(
        addRevocation(accountJwt, chain.private.natsAccountSeed, userPubkey, 1000),
      ).rejects.toThrow(/operator seed/);
    });

    it("rejects a non-SO operatorSeed", async () => {
      const { accountJwt, userPubkey } = await fixture();
      await expect(addRevocation(accountJwt, "not-a-seed", userPubkey, 1000)).rejects.toThrow(
        /operator seed/,
      );
    });

    it("rejects a userPubkey that is neither 'U…' nor '*'", async () => {
      const { accountJwt, operatorSeed } = await fixture();
      await expect(addRevocation(accountJwt, operatorSeed, "SAxyz", 1000)).rejects.toThrow(
        /userPubkey/,
      );
    });

    it("rejects a non-positive / NaN / non-integer `at`", async () => {
      const { accountJwt, operatorSeed, userPubkey } = await fixture();
      await expect(addRevocation(accountJwt, operatorSeed, userPubkey, 0)).rejects.toThrow(/at must/);
      await expect(addRevocation(accountJwt, operatorSeed, userPubkey, -5)).rejects.toThrow(/at must/);
      await expect(addRevocation(accountJwt, operatorSeed, userPubkey, NaN)).rejects.toThrow(/at must/);
      await expect(
        addRevocation(accountJwt, operatorSeed, userPubkey, Infinity),
      ).rejects.toThrow(/at must/);
      // Fractional lands in the map and fails nats-server's int64 unmarshal.
      await expect(
        addRevocation(accountJwt, operatorSeed, userPubkey, 1_700_000_000.5),
      ).rejects.toThrow(/at must/);
    });
  });
});

describe("mintNatsUserCreds.userPubkey (issue #12)", () => {
  it("returns userPubkey ('U…') equal to the JWT sub", async () => {
    const chain = await setupTrustChain();
    const minted = await mintNatsUserCreds({
      accountSeed: chain.private.natsAccountSeed,
      tenant: "t1",
      role: "agent",
    });
    expect(minted.userPubkey).toMatch(/^U/);
    const sub = decode(minted.userJwt).sub;
    expect(minted.userPubkey).toBe(sub);
  });
});
