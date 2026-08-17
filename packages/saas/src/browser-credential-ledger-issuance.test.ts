/**
 * The issuance SEAM: `issueBrowserCredentials` × {@link BrowserCredentialLedger}.
 *
 * The conformance suite pins what a ledger MEANS; this file pins what the login
 * path DOES with one — above all the ordering decision, which is fail-closed
 * (plan §3.2) and is fixed here by test rather than left to a comment.
 */

import { describe, expect, it } from "vitest";
import { createAccount } from "@nats-io/nkeys";

import { setupTrustChain } from "./setup-trust-chain.js";
import { issueBrowserCredentials, type IssueBrowserCredentialsOptions } from "./nats-user-creds.js";
import {
  MemoryBrowserCredentialLedger,
  type BrowserCredentialIssuance,
  type BrowserCredentialLedger,
  type BrowserCredentialPage,
  type BrowserCredentialRecord,
  type RecordIssuanceOutcome,
} from "./browser-credential-ledger.js";

const ledgerOf = () => new MemoryBrowserCredentialLedger({ autoSweep: false });

async function chain() {
  const built = await setupTrustChain({ operatorName: "ledger-op", accountName: "ledger-acct" });
  return built;
}

const peerScope = (natsAccountPublicKey: string, peerId: string) =>
  ({ kind: "peer", natsAccountPublicKey, peerId }) as const;

/** Drain every page so "all of them are enumerated" is not a one-page accident. */
async function all(ledger: BrowserCredentialLedger, natsAccountPublicKey: string, peerId: string): Promise<BrowserCredentialRecord[]> {
  const seen: BrowserCredentialRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: BrowserCredentialPage = await ledger.list(peerScope(natsAccountPublicKey, peerId), { limit: 2, cursor });
    seen.push(...page.records);
    cursor = page.cursor;
    if (cursor === null) return seen;
  }
}

describe("issueBrowserCredentials × BrowserCredentialLedger", () => {
  it("records exactly one secret-free record per issuance, with the JWT's own sub/iat/exp", async () => {
    const built = await chain();
    const ledger = ledgerOf();
    const creds = await issueBrowserCredentials({
      accountSeed: built.private.natsAccountSeed,
      tenant: "tenant-x",
      peerId: "peer-1",
      ttlSeconds: 3600,
      ledger,
      accountContext: "session-abc",
    });

    const record = await ledger.get(creds.userPubkey);
    expect(record).not.toBeNull();
    // The revocation key recorded is the key `addRevocation` refuses, and it is
    // the JWT subject — not a second key that would revoke nothing.
    const payload = JSON.parse(Buffer.from(creds.userJwt.split(".")[1] as string, "base64url").toString());
    expect(record?.userPubkey).toBe(creds.userPubkey);
    expect(record?.userPubkey).toBe(payload.sub);
    expect(record?.issuedAtSec).toBe(payload.iat);
    expect(record?.expiresAtSec).toBe(payload.exp);
    expect(record?.expiresAtSec).toBe(payload.iat + 3600);
    expect(record?.tenant).toBe("tenant-x");
    expect(record?.peerId).toBe("peer-1");
    expect(record?.accountContext).toBe("session-abc");
    // Self-contained mode: the account identity IS the JWT issuer.
    expect(record?.natsAccountPublicKey).toBe(payload.iss);
    expect(record?.status).toBe("active");
    expect(record?.revokedAtSec).toBeNull();

    // Exactly one — not zero, not two.
    expect(await all(ledger, record?.natsAccountPublicKey as string, "peer-1")).toHaveLength(1);
  });

  it("snapshots every issuance option before asynchronous minting can yield", async () => {
    const built = await chain();
    const ledger = ledgerOf();
    const replacementLedger = ledgerOf();
    const replacementIdentity = createAccount().getPublicKey();
    const options: IssueBrowserCredentialsOptions = {
      accountSeed: built.private.natsAccountSeed,
      tenant: "tenant-original",
      peerId: "peer-original",
      ttlSeconds: 3_600,
      ledger,
      accountContext: "context-original",
    };

    // `issueBrowserCredentials` reaches its mint await before returning this
    // promise. Mutate every field synchronously while that await is pending;
    // the JWT, permissions, and row must all stay on the first snapshot.
    const pending = issueBrowserCredentials(options);
    options.accountSeed = "mutated-account-seed";
    options.tenant = "tenant-mutated";
    options.peerId = "peer-mutated";
    options.issuerAccountId = replacementIdentity;
    options.ttlSeconds = 0.5;
    options.ledger = replacementLedger;
    options.accountContext = "context-mutated";

    const creds = await pending;
    const payload = JSON.parse(Buffer.from(creds.userJwt.split(".")[1] as string, "base64url").toString());
    const record = await ledger.get(creds.userPubkey);
    expect(creds.permissions.pub).toEqual(["webchannel.tenant-original.*.peer-original.>"]);
    // `exp` is computed immediately before the async encoder stamps `iat`, so
    // a saturated test worker can cross a wall-clock second between the two.
    // The original one-hour TTL remains unmistakable from the mutated 0.5s.
    expect(payload.exp - payload.iat).toBeGreaterThan(3_500);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(3_600);
    expect(record).toMatchObject({
      tenant: "tenant-original",
      peerId: "peer-original",
      accountContext: "context-original",
      natsAccountPublicKey: payload.iss,
      userPubkey: payload.sub,
    });
    expect(await replacementLedger.get(creds.userPubkey)).toBeNull();
  });

  it("keeps every secret out of the record, its serialization, and a query response", async () => {
    const built = await chain();
    const ledger = ledgerOf();
    const creds = await issueBrowserCredentials({
      accountSeed: built.private.natsAccountSeed, tenant: "tenant-x", peerId: "peer-1", ledger, accountContext: "ctx",
    });
    const record = await ledger.get(creds.userPubkey);
    const page = await ledger.list(peerScope(record?.natsAccountPublicKey as string, "peer-1"));
    for (const surface of [JSON.stringify(record), JSON.stringify(page)]) {
      for (const secret of [creds.userJwt, creds.userSeedRaw, built.private.natsAccountSeed, built.private.rsaPrivateKeyPem]) {
        expect(surface).not.toContain(secret);
      }
      for (const field of ["userJwt", "userSeed", "userSeedRaw", "accountSeed", "permissions"]) {
        expect(surface).not.toContain(field);
      }
    }
    expect(Object.keys(record ?? {}).sort()).toEqual([
      "accountContext", "expiresAtSec", "issuedAtSec", "natsAccountPublicKey",
      "peerId", "revokedAtSec", "status", "tenant", "userPubkey",
    ]);
  });

  it("records a non-expiring credential as expiresAtSec null and still enumerates it", async () => {
    const built = await chain();
    const ledger = ledgerOf();
    const creds = await issueBrowserCredentials({
      accountSeed: built.private.natsAccountSeed, tenant: "tenant-x", peerId: "peer-1", ledger, accountContext: "ctx",
    });
    const record = await ledger.get(creds.userPubkey);
    expect(record?.expiresAtSec).toBeNull();
    const listed = await all(ledger, record?.natsAccountPublicKey as string, "peer-1");
    expect(listed.map((r) => r.userPubkey)).toEqual([creds.userPubkey]);
  });

  it("accumulates every credential a repeatedly-logging-in peer collects", async () => {
    const built = await chain();
    const ledger = ledgerOf();
    // The reference login path mints a FRESH non-expiring credential per login;
    // per-peer enumeration is the only way an operator learns what to cut.
    const issued: string[] = [];
    for (let login = 0; login < 5; login++) {
      const creds = await issueBrowserCredentials({
        accountSeed: built.private.natsAccountSeed, tenant: "tenant-x", peerId: "peer-1", ledger, accountContext: `session-${login}`,
      });
      issued.push(creds.userPubkey);
    }
    const other = await issueBrowserCredentials({
      accountSeed: built.private.natsAccountSeed, tenant: "tenant-x", peerId: "peer-2", ledger, accountContext: "session-other",
    });
    const account = (await ledger.get(issued[0] as string))?.natsAccountPublicKey as string;

    expect(new Set(issued).size).toBe(5);
    expect((await all(ledger, account, "peer-1")).map((r) => r.userPubkey).sort()).toEqual([...issued].sort());
    expect((await all(ledger, account, "peer-2")).map((r) => r.userPubkey)).toEqual([other.userPubkey]);
  });

  it("binds the record to the managed account identity, not the signing key, in external mode", async () => {
    const ledger = ledgerOf();
    // External mode (Synadia Cloud / NGS): `iss` is only a SIGNING key, and the
    // account whose JWT carries the revocations is `nats.issuer_account`. A
    // record keyed off `iss` would name a key the resolver holds no revocations
    // for, so the two are deliberately different here.
    const signing = createAccount();
    const identity = createAccount();
    const issuerAccountId = identity.getPublicKey();
    const creds = await issueBrowserCredentials({
      accountSeed: new TextDecoder().decode(signing.getSeed()),
      tenant: "tenant-x", peerId: "peer-1", issuerAccountId, ledger, accountContext: "ctx",
    });
    const record = await ledger.get(creds.userPubkey);
    const payload = JSON.parse(Buffer.from(creds.userJwt.split(".")[1] as string, "base64url").toString());
    expect(payload.iss).toBe(signing.getPublicKey());
    expect(payload.nats.issuer_account).toBe(issuerAccountId);
    expect(record?.natsAccountPublicKey).toBe(issuerAccountId);
    expect(record?.natsAccountPublicKey).not.toBe(payload.iss);
  });

  describe("fail-closed ordering (plan §3.2)", () => {
    const stub = (recordIssuance: BrowserCredentialLedger["recordIssuance"]): BrowserCredentialLedger => ({
      nowSec: async () => Math.floor(Date.now() / 1000),
      recordIssuance,
      get: async () => null,
      list: async () => ({ records: [], cursor: null }),
      markRevoked: async () => ({ marked: 0, alreadyRevoked: 0 }),
      sweep: async () => 0,
    });

    it("withholds the credential when the ledger write throws", async () => {
      const built = await chain();
      let attempts = 0;
      const ledger = stub(async () => { attempts++; throw new Error("ledger backend unreachable"); });
      await expect(issueBrowserCredentials({
        accountSeed: built.private.natsAccountSeed, tenant: "tenant-x", peerId: "peer-1", ledger, accountContext: "ctx",
      })).rejects.toThrow(/destroyed unreturned/);
      expect(attempts).toBe(1);
    });

    it("withholds the credential when the ledger reports a fence", async () => {
      const built = await chain();
      const ledger = stub(async () => ({ kind: "fenced", scope: "account" }) satisfies RecordIssuanceOutcome);
      await expect(issueBrowserCredentials({
        accountSeed: built.private.natsAccountSeed, tenant: "tenant-x", peerId: "peer-1", ledger, accountContext: "ctx",
      })).rejects.toThrow(/fenced at account scope/);
    });

    it("never puts the withheld credential into the rejection it throws", async () => {
      const built = await chain();
      const seen: BrowserCredentialIssuance[] = [];
      const ledger = stub(async (issuance) => { seen.push(issuance); throw new Error("ledger backend unreachable"); });
      const error: Error = await issueBrowserCredentials({
        accountSeed: built.private.natsAccountSeed, tenant: "tenant-x", peerId: "peer-1", ttlSeconds: 60, ledger, accountContext: "ctx",
      }).then(() => { throw new Error("issuance resolved despite a failing ledger"); }, (thrown: unknown) => thrown as Error);
      const rendered = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error.cause ?? null)}\n${JSON.stringify(seen)}`;
      for (const secret of ["userJwt", "userSeed", "userSeedRaw", built.private.natsAccountSeed, built.private.rsaPrivateKeyPem]) {
        expect(rendered).not.toContain(secret);
      }
      // The withheld credential still reached the ledger as a secret-free
      // issuance — proof the seam hands over the key, not the credential.
      expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
        "accountContext", "expiresAtSec", "issuedAtSec", "natsAccountPublicKey", "peerId", "tenant", "userPubkey",
      ]);
    });

    it("rejects a ledger wired up without its audit label, before minting anything", async () => {
      const built = await chain();
      let attempts = 0;
      const ledger = stub(async () => { attempts++; return { kind: "recorded", record: {} as BrowserCredentialRecord }; });
      await expect(issueBrowserCredentials({
        accountSeed: built.private.natsAccountSeed, tenant: "tenant-x", peerId: "peer-1", ledger,
      })).rejects.toThrow(/accountContext is required/);
      expect(attempts).toBe(0);
    });
  });

  it("leaves the unledgered call path unchanged", async () => {
    const built = await chain();
    const creds = await issueBrowserCredentials({
      accountSeed: built.private.natsAccountSeed, tenant: "tenant-x", peerId: "peer-1",
    });
    expect(Object.keys(creds).sort()).toEqual(["permissions", "userJwt", "userPubkey", "userSeedRaw"]);
    expect(creds.permissions.pub).toEqual(["webchannel.tenant-x.*.peer-1.>"]);
  });
});
