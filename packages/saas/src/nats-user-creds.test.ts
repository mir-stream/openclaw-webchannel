import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccount } from "@nats-io/nkeys";
import { decode, type User } from "@nats-io/jwt";

import { issueBrowserCredentials, MemoryBrowserCredentialLedger } from "./index.js";
import { mintNatsUserCreds } from "./nats-user-creds.js";

const nowSec = 1_800_000_000;
const ONE_HOUR_SECONDS = 60 * 60;
const accountSeed = new TextDecoder().decode(createAccount().getSeed());
const base = { accountSeed, tenant: "tenant-x", peerId: "alice" };

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000); });
afterEach(() => { vi.restoreAllMocks(); });

describe.each([false, true])("browser credential TTL validation (ledger=%s)", (withLedger) => {
  function issuanceOptions() {
    const ledger = new MemoryBrowserCredentialLedger({ autoSweep: false });
    const recordIssuance = vi.spyOn(ledger, "recordIssuance");
    return {
      ledger,
      recordIssuance,
      options: { ...base, ...(withLedger ? { ledger, accountContext: "session-1" } : {}) },
    };
  }

  it.each([0, -1, 0.5, 60.5, NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1, "60", null])(
    "rejects invalid ttlSeconds=%s before writing an issuance",
    async (ttlSeconds) => {
      const { options, recordIssuance } = issuanceOptions();
      await expect(issueBrowserCredentials({ ...options, ttlSeconds: ttlSeconds as number }))
        .rejects.toThrow(/ttlSeconds/);
      expect(recordIssuance).not.toHaveBeenCalled();
    },
  );

  it.each([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - nowSec + 1])(
    "rejects a safe integer TTL whose calculated expiry is unsafe (%s)",
    async (ttlSeconds) => {
      const { options, recordIssuance } = issuanceOptions();
      await expect(issueBrowserCredentials({ ...options, ttlSeconds }))
        .rejects.toThrow(/ttlSeconds.*exp|exp.*safe integer/);
      expect(recordIssuance).not.toHaveBeenCalled();
    },
  );

  it.each([9_223_372_037, Number.MAX_SAFE_INTEGER - nowSec])(
    "rejects a safe integer expiry whose TTL overflows the relay timer (%s)",
    async (ttlSeconds) => {
      const { options, recordIssuance } = issuanceOptions();
      await expect(issueBrowserCredentials({ ...options, ttlSeconds }))
        .rejects.toThrow(/ttlSeconds exceeds the NATS expiration timer limit/);
      expect(recordIssuance).not.toHaveBeenCalled();
    },
  );

  it.each([1, 60, ONE_HOUR_SECONDS])("issues an integer expiry for a valid %s-second TTL", async (ttlSeconds) => {
    const { options, ledger, recordIssuance } = issuanceOptions();
    const creds = await issueBrowserCredentials({ ...options, ttlSeconds });
    const claim = decode<User>(creds.userJwt);
    expect(claim.exp).toBe(nowSec + ttlSeconds);
    expect(claim.sub).toBe(creds.userPubkey);
    expect(creds.permissions).toEqual({
      pub: ["webchannel.tenant-x.*.alice.>"], sub: ["webchannel.tenant-x.*.alice.>"],
    });
    expect(recordIssuance).toHaveBeenCalledTimes(withLedger ? 1 : 0);
    if (withLedger) expect((await ledger.get(creds.userPubkey))?.expiresAtSec).toBe(claim.exp);
  });

  it("preserves the non-expiring contract when TTL is omitted", async () => {
    const { options, ledger } = issuanceOptions();
    const creds = await issueBrowserCredentials(options);
    expect(decode<User>(creds.userJwt).exp).toBeUndefined();
    if (withLedger) expect((await ledger.get(creds.userPubkey))?.expiresAtSec).toBeNull();
  });
});

it("accepts the largest whole-second relay timer without a ledger", async () => {
  const creds = await issueBrowserCredentials({ ...base, ttlSeconds: 9_223_372_036 });
  expect(decode<User>(creds.userJwt).exp).toBe(nowSec + 9_223_372_036);
});

it("validates TTL before accessing the account signing seed", async () => {
  await expect(issueBrowserCredentials({ ...base, accountSeed: "invalid", ttlSeconds: 60.5 }))
    .rejects.toThrow(/ttlSeconds/);
});

it.each(["browser", "agent", "observer"] as const)("also validates internal %s credential TTLs", async (role) => {
  await expect(mintNatsUserCreds({ ...base, role, ttlSeconds: 60.5 })).rejects.toThrow(/ttlSeconds/);
});

it("keeps integer expiry and issuer-account binding in external signing mode", async () => {
  const issuerAccountId = createAccount().getPublicKey();
  const creds = await issueBrowserCredentials({ ...base, issuerAccountId, ttlSeconds: 60 });
  const claim = decode<User>(creds.userJwt);
  expect(claim.exp).toBe(nowSec + 60);
  expect(claim.nats.issuer_account).toBe(issuerAccountId);
});
