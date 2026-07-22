import { describe, it, expect } from "vitest";
import { join } from "node:path";

import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  canonicalizeAccountId,
  isValidAccountId,
  assertValidAccountId,
  listWebchannelAccountIds,
  inspectWebchannelAccountIds,
  resolveWebchannelAccountConfig,
  resolveAcquisitionIdentity,
  resolveAccountNatsConfig,
  resolveTypingEnabled,
  readAccountsMap,
  readWebchannelSection,
  accountCredentialPath,
  legacyCredentialPath,
  resolveReadCredentialPath,
  loadPersistedEnrolledCreds,
} from "./account-config.js";
import { planAccounts } from "./multiplex.js";

const HOME = "/home/test";

describe("removed auth.ticketParam migration", () => {
  it("rejects the deprecated flat config through the NATS account planning seam", () => {
    const cfg = { channels: { webchannel: { auth: { strategy: "jwt", ticketParam: "ticket" } } } };
    expect(() => planAccounts(cfg, { env: {} })).toThrow(
      /removed config auth\.ticketParam.*openclaw channels add/s,
    );
  });

  it("rejects the deprecated named-account leaf through the NATS account planning seam", () => {
    const cfg = { channels: { webchannel: { accounts: { work: { auth: { ticketParam: "jwt" } } } } } };
    expect(() => planAccounts(cfg, { env: {} })).toThrow(
      /removed config auth\.ticketParam.*openclaw channels add/s,
    );
  });
});

describe("P0-2 removed config migration", () => {
  it.each([
    ["nats.devOpen", { nats: { devOpen: false } }],
    ['nats.admission="auto"', { nats: { admission: "auto" } }],
    ['nats.credentials.mode="open"', { nats: { credentials: { mode: "open" } } }],
    ['auth.strategy="anonymous"', { auth: { strategy: "anonymous" } }],
  ])("fails account resolution for %s", (setting, account) => {
    const cfg = { channels: { webchannel: account } };
    expect(() => resolveWebchannelAccountConfig(cfg, "default")).toThrow(
      new RegExp(`removed config ${setting.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`),
    );
  });
});

describe("account-config: account id validation (TRUST BOUNDARY)", () => {
  it("accepts safe ids", () => {
    for (const id of ["default", "acctA", "acct-1", "a_b-C9", "x".repeat(64)]) {
      expect(isValidAccountId(id)).toBe(true);
    }
  });

  it("rejects traversal / illegal / blocked ids", () => {
    for (const id of [
      "../../tmp/evil",
      "..",
      "a/b",
      "a\\b",
      "a.b",
      "",
      "x".repeat(65),
      "__proto__",
      "constructor",
      "prototype",
    ]) {
      expect(isValidAccountId(id)).toBe(false);
    }
  });

  it("assertValidAccountId throws on a traversal id", () => {
    expect(() => assertValidAccountId("../../tmp/evil")).toThrow(/invalid account id/);
  });

  it("canonicalizeAccountId collapses a traversal sequence to a safe id (core-compatible)", () => {
    expect(canonicalizeAccountId("../../tmp/evil")).toBe("tmp-evil");
    expect(isValidAccountId(canonicalizeAccountId("../../tmp/evil"))).toBe(true);
  });

  it("canonicalizeAccountId defaults empty/blocked to 'default'", () => {
    expect(canonicalizeAccountId(undefined)).toBe("default");
    expect(canonicalizeAccountId("   ")).toBe("default");
    expect(canonicalizeAccountId("__proto__")).toBe("default");
  });

  it("canonicalizeAccountId lowercases and preserves valid ids", () => {
    expect(canonicalizeAccountId("AcctA")).toBe("accta");
    expect(canonicalizeAccountId("acct-1")).toBe("acct-1");
  });
});

describe("account-config: resolveTypingEnabled (P0-6)", () => {
  it("defaults ON when capabilities is absent", () => {
    expect(resolveTypingEnabled({})).toBe(true);
    expect(resolveTypingEnabled({ capabilities: {} })).toBe(true);
  });

  it("ON for explicit typing:'on'", () => {
    expect(resolveTypingEnabled({ capabilities: { typing: "on" } })).toBe(true);
  });

  it("OFF only for explicit typing:'off'", () => {
    expect(resolveTypingEnabled({ capabilities: { typing: "off" } })).toBe(false);
  });

  it("honors an account override 'off' over a channel-level 'on' base (through the merge)", () => {
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { typing: "on" },
          accounts: {
            acctA: { capabilities: { typing: "off" } },
          },
        },
      },
    };
    expect(resolveTypingEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it("honors an account override 'on' over a channel-level 'off' base (through the merge)", () => {
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { typing: "off" },
          accounts: {
            acctA: { capabilities: { typing: "on" } },
          },
        },
      },
    };
    expect(resolveTypingEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(true);
  });

  it("inherits the channel-level base when the account omits capabilities (shared-base merge)", () => {
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { typing: "off" },
          accounts: { acctA: { tenant: "t" } },
        },
      },
    };
    expect(resolveTypingEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it("keeps the base typing:'off' when the account sets OTHER capabilities (nested merge, no clobber)", () => {
    // Locks `capabilities` staying in NESTED_OBJECT_KEYS: the account's
    // capabilities object must MERGE over the base, not replace it — dropping
    // that would silently regress typing:"off" back to being ignored.
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { typing: "off" },
          accounts: { acctA: { capabilities: { someOtherKey: "x" } } },
        },
      },
    };
    expect(resolveTypingEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });
});

describe("account-config: listWebchannelAccountIds", () => {
  it("isolates invalid raw keys and does not synthesize default for an explicit all-invalid map", () => {
    const mixed = { channels: { webchannel: { accounts: { good: {}, "bad.id": {}, constructor: {}, Zed: {} } } } };
    expect(inspectWebchannelAccountIds(mixed)).toEqual({
      validIds: ["good", "Zed"].sort((a, b) => a.localeCompare(b)),
      invalid: [
        { id: "bad.id", reason: "the id must match /^[A-Za-z0-9_-]{1,64}$/" },
        { id: "constructor", reason: "the id is a blocked prototype key" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
      usesImplicitDefault: false,
    });
    expect(listWebchannelAccountIds({ channels: { webchannel: { accounts: { "../bad": {} } } } })).toEqual([]);
  });
  it("synthesizes default when there is no webchannel section", () => {
    expect(listWebchannelAccountIds({ channels: {} })).toEqual([DEFAULT_WEBCHANNEL_ACCOUNT_ID]);
    expect(listWebchannelAccountIds({})).toEqual([DEFAULT_WEBCHANNEL_ACCOUNT_ID]);
  });

  it("returns default for a flat single-account config", () => {
    const cfg = { channels: { webchannel: { auth: { strategy: "jwt" }, allowFrom: ["a"] } } };
    expect(listWebchannelAccountIds(cfg)).toEqual([DEFAULT_WEBCHANNEL_ACCOUNT_ID]);
  });

  it("returns default for an empty webchannel object", () => {
    expect(listWebchannelAccountIds({ channels: { webchannel: {} } })).toEqual([
      DEFAULT_WEBCHANNEL_ACCOUNT_ID,
    ]);
  });

  it("returns default when the accounts map is PRESENT but empty, even with channel-level fields", () => {
    const cfg = {
      channels: { webchannel: { auth: { strategy: "jwt" }, accounts: {} } },
    };
    expect(listWebchannelAccountIds(cfg)).toEqual([DEFAULT_WEBCHANNEL_ACCOUNT_ID]);
  });

  it("lists accounts-map children", () => {
    const cfg = {
      channels: { webchannel: { accounts: { acctA: { auth: {} }, acctB: { allowFrom: [] } } } },
    };
    expect(listWebchannelAccountIds(cfg)).toEqual(["acctA", "acctB"]);
  });

  it("treats channel-level base as shared base only — no implicit default beside named accounts", () => {
    const cfg = {
      channels: { webchannel: { auth: { strategy: "jwt" }, accounts: { acctB: {} } } },
    };
    expect(listWebchannelAccountIds(cfg)).toEqual(["acctB"]);
  });

  it("honors an explicit `default` account in the accounts map", () => {
    const cfg = { channels: { webchannel: { accounts: { default: { auth: {} }, acctB: {} } } } };
    expect(listWebchannelAccountIds(cfg)).toEqual(["acctB", "default"]);
  });

  it("does NOT conjure a phantom default from channel-level shared tuning keys (issue #17)", () => {
    const cfg = {
      channels: {
        webchannel: { accounts: { for_work: {} }, streaming: { mode: "progress" } },
      },
    };
    expect(listWebchannelAccountIds(cfg)).toEqual(["for_work"]);
  });
});

describe("account-config: resolveWebchannelAccountConfig (base merge)", () => {
  it("returns the flat block AS the default account (backward compat)", () => {
    const cfg = { channels: { webchannel: { allowFrom: ["a"], dmSecurity: "allowlist" } } };
    const acct = resolveWebchannelAccountConfig(cfg, "default");
    expect(acct.allowFrom).toEqual(["a"]);
    expect(acct.dmSecurity).toBe("allowlist");
  });

  it("merges channel-level base UNDER a named account override", () => {
    const cfg = {
      channels: {
        webchannel: {
          auth: { strategy: "jwt" },
          allowFrom: ["base"],
          accounts: { acctB: { allowFrom: ["b"], agentId: "agentB" } },
        },
      },
    };
    const acct = resolveWebchannelAccountConfig(cfg, "acctB");
    expect(acct.allowFrom).toEqual(["b"]);
    expect(acct.auth).toEqual({ strategy: "jwt" });
    expect(acct.agentId).toBe("agentB");
  });

  it("shallow-merges nested object keys (nats.url base + nats.credentials override)", () => {
    const cfg = {
      channels: {
        webchannel: {
          nats: { url: "ws://base" },
          accounts: { acctB: { nats: { credentials: { mode: "enrolled" } } } },
        },
      },
    };
    const acct = resolveWebchannelAccountConfig(cfg, "acctB");
    expect(acct.nats).toEqual({ url: "ws://base", credentials: { mode: "enrolled" } });
  });

  it("does NOT leak the accounts map into the resolved account", () => {
    const cfg = { channels: { webchannel: { auth: {}, accounts: { acctB: {} } } } };
    const acct = resolveWebchannelAccountConfig(cfg, "default");
    expect(acct.accounts).toBeUndefined();
  });

  it("returns base for a missing named account (inherits shared base only)", () => {
    const cfg = { channels: { webchannel: { auth: { strategy: "jwt" }, accounts: { acctA: {} } } } };
    expect(resolveWebchannelAccountConfig(cfg, "nope")).toEqual({ auth: { strategy: "jwt" } });
  });
});

describe("account-config: readWebchannelSection / readAccountsMap / resolveAccountNatsConfig", () => {
  it("reads the section", () => {
    const cfg = { channels: { webchannel: { nats: { url: "ws://x" } } } };
    expect(readWebchannelSection(cfg)).toEqual({ nats: { url: "ws://x" } });
  });

  it("reads the accounts map", () => {
    const cfg = { channels: { webchannel: { accounts: { a: { x: 1 } } } } };
    expect(readAccountsMap(readWebchannelSection(cfg))).toEqual({ a: { x: 1 } });
  });

  it("rejects a merged per-account devOpen fixture", () => {
    const cfg = {
      channels: { webchannel: { nats: { url: "ws://base" }, accounts: { acctA: { nats: { devOpen: true } } } } },
    };
    expect(() => resolveAccountNatsConfig(cfg, "acctA")).toThrow(/removed config nats.devOpen/);
  });

  it("reads flat nats config for default", () => {
    const cfg = { channels: { webchannel: { nats: { url: "ws://flat" } } } };
    expect(resolveAccountNatsConfig(cfg, "default")).toEqual({ url: "ws://flat" });
  });
});

describe("account-config: resolveAcquisitionIdentity", () => {
  it("reads per-account identity from the accounts map", () => {
    const cfg = {
      channels: {
        webchannel: {
          accounts: { acctA: { tenant: "tA", saas: { baseUrl: "http://s" } } },
        },
      },
    };
    expect(resolveAcquisitionIdentity(cfg, "acctA")).toEqual({
      accountId: "acctA",
      tenant: "tA",
      saasBaseUrl: "http://s",
    });
  });

  it("falls back to top-level cfg for the default account only", () => {
    const cfg = {
      tenant: "topTenant",
      saas: { baseUrl: "http://top" },
      channels: { webchannel: { allowFrom: ["a"] } },
    };
    expect(resolveAcquisitionIdentity(cfg, "default")).toEqual({
      accountId: "default",
      tenant: "topTenant",
      saasBaseUrl: "http://top",
    });
  });

  it("does NOT use top-level fallback for a non-default account with no own identity", () => {
    const cfg = {
      tenant: "topTenant",
      channels: { webchannel: { accounts: { acctB: {} } } },
    };
    const id = resolveAcquisitionIdentity(cfg, "acctB");
    expect(id.tenant).toBe("default-tenant");
    // accountId is the wire identity (가-2); the handling agent is a bind concern.
    expect(id.accountId).toBe("acctB");
    expect(id.saasBaseUrl).toBeUndefined();
  });

  it("defaults to the historical literals when nothing is configured", () => {
    expect(resolveAcquisitionIdentity({}, "default")).toEqual({
      accountId: "default",
      tenant: "default-tenant",
      saasBaseUrl: undefined,
    });
  });
});

describe("account-config: credential paths", () => {
  it("rejects account-less path reads at the API boundary", () => {
    expect(() => (accountCredentialPath as unknown as () => string)()).toThrow(/account id/i);
  });
  it("builds the per-account path", () => {
    expect(accountCredentialPath("acctA", HOME)).toBe(
      join(HOME, ".openclaw-webchannel", "acctA", "credentials.json"),
    );
  });

  it("REJECTS a traversal account id before building a path (security)", () => {
    expect(() => accountCredentialPath("../../tmp/evil", HOME)).toThrow(/invalid account id/);
  });

  it("builds the legacy path", () => {
    expect(legacyCredentialPath(HOME)).toBe(
      join(HOME, ".openclaw-webchannel", "credentials.json"),
    );
  });

  it("resolveReadCredentialPath prefers the per-account file when it exists", () => {
    const perAccount = accountCredentialPath("default", HOME);
    const path = resolveReadCredentialPath("default", {
      home: HOME,
      exists: (p) => p === perAccount,
    });
    expect(path).toBe(perAccount);
  });

  it("resolveReadCredentialPath ignores the legacy file for default", () => {
    const legacy = legacyCredentialPath(HOME);
    const perAccount = accountCredentialPath("default", HOME);
    const path = resolveReadCredentialPath("default", {
      home: HOME,
      exists: (p) => p === legacy,
    });
    expect(path).toBe(perAccount);
  });

  it("resolveReadCredentialPath does NOT use legacy for a non-default account", () => {
    const legacy = legacyCredentialPath(HOME);
    const perAccount = accountCredentialPath("acctA", HOME);
    const path = resolveReadCredentialPath("acctA", {
      home: HOME,
      exists: (p) => p === legacy, // only legacy exists
    });
    expect(path).toBe(perAccount);
  });

  it("resolveReadCredentialPath returns the per-account path when nothing exists", () => {
    const path = resolveReadCredentialPath("default", { home: HOME, exists: () => false });
    expect(path).toBe(accountCredentialPath("default", HOME));
  });

  it("resolveReadCredentialPath rejects a traversal id", () => {
    expect(() =>
      resolveReadCredentialPath("../../evil", { home: HOME, exists: () => false }),
    ).toThrow(/invalid account id/);
  });
});

describe("account-config: loadPersistedEnrolledCreds", () => {
  const validFile = JSON.stringify({
    enrollment: { creds: { userJwt: "JWT", userSeed: "SEED" } },
  });

  it("rejects account-less credential reads at the API boundary", () => {
    expect(() => (loadPersistedEnrolledCreds as unknown as () => unknown)()).toThrow(/account id/i);
  });

  it("loads creds from the per-account file", () => {
    const perAccount = accountCredentialPath("acctA", HOME);
    const creds = loadPersistedEnrolledCreds("acctA", {
      home: HOME,
      exists: (p) => p === perAccount,
      read: () => validFile,
    });
    expect(creds).toEqual({ userJwt: "JWT", userSeed: "SEED" });
  });

  it("threads the SaaS-delivered natsUrl through when persisted", () => {
    // EnrollmentResult.natsUrl is persisted under `enrollment.natsUrl`; the
    // consumer dials it in preference to local config, so the loader must surface
    // it. (Absent → omitted, exercised by the back-compat fixtures above.)
    const withUrl = JSON.stringify({
      enrollment: {
        creds: { userJwt: "JWT", userSeed: "SEED" },
        natsUrl: "wss://saas-delivered-relay",
      },
    });
    const perAccount = accountCredentialPath("acctA", HOME);
    const creds = loadPersistedEnrolledCreds("acctA", {
      home: HOME,
      exists: (p) => p === perAccount,
      read: () => withUrl,
    });
    expect(creds).toEqual({
      userJwt: "JWT",
      userSeed: "SEED",
      natsUrl: "wss://saas-delivered-relay",
    });
  });

  it("threads the SaaS-delivered issuer through when persisted (VERBATIM)", () => {
    // EnrollmentResult.issuer is persisted under `enrollment.issuer`; the runtime
    // verifies bootstrap JWTs against it (pin > delivered > derived), so the
    // loader must surface it — verbatim, trailing slash and all (verify compares
    // slash-insensitively; the loader must not "helpfully" canonicalize).
    const withIssuer = JSON.stringify({
      enrollment: {
        creds: { userJwt: "JWT", userSeed: "SEED" },
        natsUrl: "wss://saas-delivered-relay",
        issuer: "https://saas.local/demo-issuer/",
      },
    });
    const perAccount = accountCredentialPath("acctA", HOME);
    const creds = loadPersistedEnrolledCreds("acctA", {
      home: HOME,
      exists: (p) => p === perAccount,
      read: () => withIssuer,
    });
    expect(creds).toEqual({
      userJwt: "JWT",
      userSeed: "SEED",
      natsUrl: "wss://saas-delivered-relay",
      issuer: "https://saas.local/demo-issuer/",
    });
  });

  it("omits issuer for pre-issuer persisted creds and non-string junk (back-compat)", () => {
    const junk = JSON.stringify({
      enrollment: {
        creds: { userJwt: "JWT", userSeed: "SEED" },
        issuer: 42,
      },
    });
    const perAccount = accountCredentialPath("acctA", HOME);
    const creds = loadPersistedEnrolledCreds("acctA", {
      home: HOME,
      exists: (p) => p === perAccount,
      read: () => junk,
    });
    expect(creds).toEqual({ userJwt: "JWT", userSeed: "SEED" });
  });

  it("F2: surfaces the agent identity key when both halves decode to 32 bytes", () => {
    // base64url of a 32-byte X25519 key is 43 chars. Reuse one string for both
    // halves — the loader only checks decoded length, not that they're a real pair.
    const KEY43 = "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo";
    const withIdentity = JSON.stringify({
      identityKey: { publicKey: KEY43, privateKey: KEY43 },
      enrollment: { creds: { userJwt: "JWT", userSeed: "SEED" } },
    });
    const perAccount = accountCredentialPath("acctA", HOME);
    const creds = loadPersistedEnrolledCreds("acctA", {
      home: HOME,
      exists: (p) => p === perAccount,
      read: () => withIdentity,
    });
    expect(creds?.identityKey).toBeDefined();
    expect(creds!.identityKey!.publicKey).toBeInstanceOf(Uint8Array);
    expect(creds!.identityKey!.publicKey.length).toBe(32);
    expect(creds!.identityKey!.privateKey.length).toBe(32);
  });

  it("F2: omits the identity key when the block is absent, partial, or the wrong length (fail-closed)", () => {
    const KEY43 = "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo";
    const perAccount = accountCredentialPath("acctA", HOME);
    const load = (identityKey: unknown) =>
      loadPersistedEnrolledCreds("acctA", {
        home: HOME,
        exists: (p) => p === perAccount,
        read: () =>
          JSON.stringify({ identityKey, enrollment: { creds: { userJwt: "JWT", userSeed: "SEED" } } }),
      });
    // Absent entirely.
    expect(load(undefined)?.identityKey).toBeUndefined();
    // Only one half present.
    expect(load({ publicKey: KEY43 })?.identityKey).toBeUndefined();
    // Wrong length (31 bytes → not an X25519 key).
    expect(load({ publicKey: "AAAA", privateKey: "AAAA" })?.identityKey).toBeUndefined();
    // But the rest of the creds still load (identity is optional at this layer).
    expect(load(undefined)).toMatchObject({ userJwt: "JWT", userSeed: "SEED" });
  });

  it("ignores the legacy file for the default account", () => {
    const legacy = legacyCredentialPath(HOME);
    const creds = loadPersistedEnrolledCreds("default", {
      home: HOME,
      exists: (p) => p === legacy,
      read: () => validFile,
    });
    expect(creds).toBeUndefined();
  });

  it("returns undefined when no file exists", () => {
    expect(
      loadPersistedEnrolledCreds("default", { home: HOME, exists: () => false }),
    ).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    const perAccount = accountCredentialPath("default", HOME);
    expect(
      loadPersistedEnrolledCreds("default", {
        home: HOME,
        exists: (p) => p === perAccount,
        read: () => "not json{",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the enrollment block is missing", () => {
    const perAccount = accountCredentialPath("default", HOME);
    expect(
      loadPersistedEnrolledCreds("default", {
        home: HOME,
        exists: (p) => p === perAccount,
        read: () => JSON.stringify({ identityKey: {} }),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when userJwt/userSeed are empty", () => {
    const perAccount = accountCredentialPath("default", HOME);
    expect(
      loadPersistedEnrolledCreds("default", {
        home: HOME,
        exists: (p) => p === perAccount,
        read: () => JSON.stringify({ enrollment: { creds: { userJwt: "", userSeed: "" } } }),
      }),
    ).toBeUndefined();
  });

  it("rejects a traversal account id", () => {
    expect(() => loadPersistedEnrolledCreds("../../evil", { home: HOME })).toThrow(
      /invalid account id/,
    );
  });
});
