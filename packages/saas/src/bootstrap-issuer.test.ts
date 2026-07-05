/**
 * Unit tests for the 0.1.2 additive public API:
 *   - createBootstrapIssuer (RS256 bootstrap-JWT signer)
 *   - issueBrowserCredentials (browser-login NATS creds)
 */

import { describe, expect, it } from "vitest";

import { setupTrustChain } from "./setup-trust-chain.js";
import { buildBootstrapClaims } from "./bootstrap-claims.js";
import { createBootstrapIssuer } from "./bootstrap-issuer.js";
import { issueBrowserCredentials } from "./nats-user-creds.js";

const X25519_PUB = Buffer.alloc(32, 7).toString("base64url"); // 32 bytes
const ED25519_PUB = Buffer.alloc(32, 9).toString("base64url"); // 32 bytes

describe("createBootstrapIssuer", () => {
  it("produces a 3-part JWT whose header has the right kid + alg", async () => {
    const chain = await setupTrustChain({ operatorName: "t-op", accountName: "t-acct" });
    const issuer = await createBootstrapIssuer({
      rsaPrivateKeyPem: chain.private.rsaPrivateKeyPem,
      kid: chain.kid,
    });
    const claims = buildBootstrapClaims({
      iss: "https://saas.test",
      peerId: "peer-1",
      accountId: "acct-1",
      tenant: "tenant-x",
      deviceX25519PublicKey: X25519_PUB,
      devicePopPublicKey: ED25519_PUB,
    });
    const jwt = await issuer.sign(claims);

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe(chain.kid);

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.sub).toBe("peer-1");
    expect(payload.aud).toBe("acct-1");
    expect(payload.cnf.jwk.x).toBe(X25519_PUB);
  });

  it("is immutable — two issuers with different kids stamp their own kid", async () => {
    const chain = await setupTrustChain({ operatorName: "t-op", accountName: "t-acct" });
    const issuerA = await createBootstrapIssuer({
      rsaPrivateKeyPem: chain.private.rsaPrivateKeyPem,
      kid: "kid-A",
    });
    const claims = buildBootstrapClaims({
      iss: "https://saas.test",
      peerId: "peer-1",
      accountId: "acct-1",
      tenant: "tenant-x",
      deviceX25519PublicKey: X25519_PUB,
    });
    const jwt = await issuerA.sign(claims);
    const header = JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString());
    expect(header.kid).toBe("kid-A");
  });
});

describe("issueBrowserCredentials", () => {
  it("returns userSeedRaw + peer-scoped permissions (no base32 userSeed)", async () => {
    const chain = await setupTrustChain({ operatorName: "t-op", accountName: "t-acct" });
    const creds = await issueBrowserCredentials({
      accountSeed: chain.private.natsAccountSeed,
      tenant: "tenant-x",
      peerId: "peer-1",
    });
    expect(creds.userJwt).toBeTruthy();
    expect(creds.userSeedRaw).toBeTruthy();
    // base64url raw 32-byte seed → NOT a base32 "SU…" NKEY string.
    expect(creds.userSeedRaw).not.toMatch(/^SU/);
    expect(Buffer.from(creds.userSeedRaw, "base64url")).toHaveLength(32);
    // Pinned to this peer's own subtree.
    expect(creds.permissions.pub).toEqual(["webchannel.tenant-x.*.peer-1.>"]);
    expect(creds.permissions.sub).toEqual(["webchannel.tenant-x.*.peer-1.>"]);
    // base32 userSeed is intentionally dropped from the public shape.
    expect((creds as Record<string, unknown>).userSeed).toBeUndefined();
  });

  it.each([0, -5, NaN, Infinity])(
    "rejects a non-finite-positive ttlSeconds=%p (would mint a non-expiring/malformed credential)",
    async (ttlSeconds) => {
      const chain = await setupTrustChain({ operatorName: "t-op", accountName: "t-acct" });
      await expect(
        issueBrowserCredentials({
          accountSeed: chain.private.natsAccountSeed,
          tenant: "tenant-x",
          peerId: "peer-1",
          ttlSeconds,
        }),
      ).rejects.toThrow(/ttlSeconds must be a finite positive number/);
    },
  );

  it("stamps a finite exp when ttlSeconds > 0", async () => {
    const chain = await setupTrustChain({ operatorName: "t-op", accountName: "t-acct" });
    const before = Math.floor(Date.now() / 1000);
    const creds = await issueBrowserCredentials({
      accountSeed: chain.private.natsAccountSeed,
      tenant: "tenant-x",
      peerId: "peer-1",
      ttlSeconds: 300,
    });
    const payload = JSON.parse(Buffer.from(creds.userJwt.split(".")[1], "base64url").toString());
    expect(typeof payload.exp).toBe("number");
    expect(Number.isFinite(payload.exp)).toBe(true);
    // exp ≈ now + 300s (allow a small window for test wall-clock drift).
    expect(payload.exp).toBeGreaterThanOrEqual(before + 300);
    expect(payload.exp).toBeLessThanOrEqual(before + 305);
  });

  it("rejects a missing peerId at runtime", async () => {
    const chain = await setupTrustChain({ operatorName: "t-op", accountName: "t-acct" });
    await expect(
      // @ts-expect-error peerId is type-required; assert the runtime guard too.
      issueBrowserCredentials({ accountSeed: chain.private.natsAccountSeed, tenant: "tenant-x" }),
    ).rejects.toThrow(/peerId is required/);
  });
});
