/**
 * External (managed) NATS account tests — Synadia Cloud / NGS.
 *
 * These exercise the additive external-account path WITHOUT a real Synadia
 * account: we synthesize an account IDENTITY keypair + a distinct account
 * SIGNING keypair locally with `@nats-io/nkeys` and assert that the minted user
 * JWT is signed by the signing key (`iss`) on behalf of the identity
 * (`nats.issuer_account`) — exactly the shape a managed resolver requires.
 *
 * The self-contained path is asserted to be byte-for-byte unchanged.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAccount } from "@nats-io/nkeys";
import { decode, type User } from "@nats-io/jwt";

import { mintNatsUserCreds } from "./nats-user-creds.js";
import { setupTrustChain } from "./setup-trust-chain.js";
import { loadOrCreateTrustChain } from "./persistent-trust-chain.js";
import { DeviceFlowEnrollment } from "./device-flow-enrollment.js";

/** Synthesize a managed account: a distinct identity key + signing key. */
function makeExternalAccount() {
  const identity = createAccount();
  const signing = createAccount();
  const accountId = identity.getPublicKey(); // A… identity (issuer_account)
  const signingPublic = signing.getPublicKey(); // A… signing key (iss)
  const signingSeed = new TextDecoder().decode(signing.getSeed()); // SA…
  return { accountId, signingPublic, signingSeed };
}

function decodeUser(jwt: string) {
  return decode<User>(jwt);
}

describe("mintNatsUserCreds — external account (issuer_account)", () => {
  it("signs with the signing key and stamps issuer_account = account identity", async () => {
    const { accountId, signingPublic, signingSeed } = makeExternalAccount();
    // Sanity: signing key is a DISTINCT account key from the identity.
    expect(signingPublic).not.toBe(accountId);

    const creds = await mintNatsUserCreds({
      accountSeed: signingSeed,
      tenant: "tenant-ext",
      role: "agent",
      issuerAccountId: accountId,
    });

    const claims = decodeUser(creds.userJwt);
    // iss = the signing key's public (what Synadia's resolver verifies against).
    expect(claims.iss).toBe(signingPublic);
    // issuer_account = the account identity (maps the user to the account).
    expect(claims.nats.issuer_account).toBe(accountId);
    // sub = the freshly-minted user NKEY public.
    expect(claims.sub).toMatch(/^U/);
    // Tenant-scoped perms unchanged.
    expect(claims.nats.pub?.allow).toEqual(["webchannel.tenant-ext.>"]);
    expect(claims.nats.sub?.allow).toEqual(["webchannel.tenant-ext.>"]);
    expect(creds.permissions).toEqual({
      pub: ["webchannel.tenant-ext.>"],
      sub: ["webchannel.tenant-ext.>"],
    });
    // Still returns the browser-friendly raw seed.
    expect(creds.userSeed).toMatch(/^SU/);
    expect(creds.userSeedRaw).toBeTruthy();
  });

  it("self-contained path is unchanged: iss = account public, no issuer_account", async () => {
    // Self-signed account: the signing seed IS the account identity.
    const account = createAccount();
    const accountPublic = account.getPublicKey();
    const accountSeed = new TextDecoder().decode(account.getSeed());

    const creds = await mintNatsUserCreds({
      accountSeed,
      tenant: "tenant-self",
      role: "agent",
    });

    const claims = decodeUser(creds.userJwt);
    expect(claims.iss).toBe(accountPublic);
    // No issuer_account when self-signed (or, if present, equal to iss).
    expect(claims.nats.issuer_account ?? claims.iss).toBe(claims.iss);
    expect(claims.nats.issuer_account).toBeFalsy();
    expect(claims.nats.pub?.allow).toEqual(["webchannel.tenant-self.>"]);
  });

  it("isolates tenants across the external path", async () => {
    const { accountId, signingSeed } = makeExternalAccount();
    const a = await mintNatsUserCreds({ accountSeed: signingSeed, tenant: "alpha", issuerAccountId: accountId });
    const b = await mintNatsUserCreds({ accountSeed: signingSeed, tenant: "beta", issuerAccountId: accountId });
    expect(decodeUser(a.userJwt).nats.pub?.allow).toEqual(["webchannel.alpha.>"]);
    expect(decodeUser(b.userJwt).nats.pub?.allow).toEqual(["webchannel.beta.>"]);
    // Same issuer_account, distinct users.
    expect(decodeUser(a.userJwt).nats.issuer_account).toBe(accountId);
    expect(decodeUser(b.userJwt).nats.issuer_account).toBe(accountId);
    expect(a.userSeed).not.toBe(b.userSeed);
  });
});

describe("setupTrustChain — external account mode", () => {
  it("uses the provided account, emits no operator/account/resolver", async () => {
    const { accountId, signingSeed } = makeExternalAccount();
    const chain = await setupTrustChain({
      externalNatsAccount: { signingSeed, accountId },
    });

    expect(chain.natsConfig.mode).toBe("external");
    if (chain.natsConfig.mode !== "external") throw new Error("unreachable");
    expect(chain.natsConfig.accountPublicKey).toBe(accountId);
    // No self-contained server config is meaningful in external mode.
    expect((chain.natsConfig as Record<string, unknown>).operatorJwt).toBeUndefined();
    expect((chain.natsConfig as Record<string, unknown>).accountJwt).toBeUndefined();
    expect((chain.natsConfig as Record<string, unknown>).resolverConfig).toBeUndefined();
    // Bootstrap material (RSA + JWKS + kid) is still generated, unchanged.
    expect(chain.private.rsaPrivateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(chain.private.natsAccountSeed).toBe(signingSeed);
    expect(chain.jwks.keys).toHaveLength(1);
    expect(chain.kid).toBeTruthy();
  });

  it("the external chain mints Synadia-valid creds", async () => {
    const { accountId, signingPublic, signingSeed } = makeExternalAccount();
    const chain = await setupTrustChain({ externalNatsAccount: { signingSeed, accountId } });
    const creds = await mintNatsUserCreds({
      accountSeed: chain.private.natsAccountSeed,
      tenant: "t1",
      issuerAccountId: chain.natsConfig.mode === "external" ? chain.natsConfig.accountPublicKey : undefined,
    });
    const claims = decodeUser(creds.userJwt);
    expect(claims.iss).toBe(signingPublic);
    expect(claims.nats.issuer_account).toBe(accountId);
  });

  it("rejects a malformed signing seed or account id", async () => {
    const { accountId, signingSeed } = makeExternalAccount();
    await expect(
      setupTrustChain({ externalNatsAccount: { signingSeed: "not-a-seed", accountId } }),
    ).rejects.toThrow(/signing-key seed/);
    await expect(
      setupTrustChain({ externalNatsAccount: { signingSeed, accountId: "not-an-account" } }),
    ).rejects.toThrow(/account identity public key/);
  });

  it("self-contained mode is the default (no external option)", async () => {
    const chain = await setupTrustChain();
    expect(chain.natsConfig.mode ?? "self-contained").toBe("self-contained");
    expect(chain.natsConfig.operatorJwt).toBeTruthy();
    expect(chain.natsConfig.resolverConfig).toBeTruthy();
  });
});

describe("DeviceFlowEnrollment — agent path mints against the external account", () => {
  it("approved agent creds carry issuer_account = the managed account id", async () => {
    const { accountId, signingPublic, signingSeed } = makeExternalAccount();
    const chain = await setupTrustChain({ externalNatsAccount: { signingSeed, accountId } });

    const enrollment = new DeviceFlowEnrollment({
      saasTrustChain: chain.private,
      natsAccountConfig: chain.natsConfig,
      natsIssuerAccountId: chain.natsConfig.mode === "external" ? chain.natsConfig.accountPublicKey : undefined,
      saasBaseUrl: "https://saas.test",
      jwksUrl: "https://saas.test/.well-known/jwks.json",
      bootstrapUrl: "https://saas.test/bootstrap",
    });

    const { user_code } = await enrollment.enroll({
      agentPublicKey: "agent-x25519-pub",
      accountId: "agent-1",
      tenant: "tenant-ext",
    });
    const result = await enrollment.approve(user_code);
    expect(result).not.toBeNull();

    const claims = decodeUser(result!.creds.userJwt);
    expect(claims.iss).toBe(signingPublic);
    expect(claims.nats.issuer_account).toBe(accountId);
    expect(claims.nats.pub?.allow).toEqual(["webchannel.tenant-ext.>"]);
  });
});

describe("loadOrCreateTrustChain — external mode never persists the signing seed", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ext-trust-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("strips the signing seed from disk and re-injects it from config on reload", async () => {
    const { accountId, signingSeed } = makeExternalAccount();
    const path = join(dir, "chain.json");
    const opts = { externalNatsAccount: { signingSeed, accountId } };

    const created = await loadOrCreateTrustChain(path, opts);
    expect(created.private.natsAccountSeed).toBe(signingSeed); // in-memory keeps it
    expect(created.natsConfig.mode).toBe("external");

    // The secret must NOT be on disk.
    expect(existsSync(path)).toBe(true);
    const onDisk = readFileSync(path, "utf-8");
    expect(onDisk).not.toContain(signingSeed);

    // Reload re-injects the env/config seed + account id.
    const reloaded = await loadOrCreateTrustChain(path, opts);
    expect(reloaded.private.natsAccountSeed).toBe(signingSeed);
    expect(reloaded.natsConfig.mode).toBe("external");
    if (reloaded.natsConfig.mode !== "external") throw new Error("unreachable");
    expect(reloaded.natsConfig.accountPublicKey).toBe(accountId);
    // The persisted RSA key is stable across reload.
    expect(reloaded.private.rsaPrivateKeyPem).toBe(created.private.rsaPrivateKeyPem);
    expect(reloaded.kid).toBe(created.kid);
  });

  it("fails fast when reloading an external chain WITHOUT the signing seed", async () => {
    const { accountId, signingSeed } = makeExternalAccount();
    const path = join(dir, "chain.json");

    // Persist an external chain (with the seed, stripped before write).
    await loadOrCreateTrustChain(path, { externalNatsAccount: { signingSeed, accountId } });

    // Reload WITHOUT the env secret → clear error, not a cryptic later mint.
    await expect(loadOrCreateTrustChain(path)).rejects.toThrow(/requires the signing seed/);
  });
});
