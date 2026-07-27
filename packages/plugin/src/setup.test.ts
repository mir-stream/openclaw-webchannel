import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the acquisition routine so afterAccountConfigWritten is testable without
// a real SaaS / device flow.
const acquireMock = vi.fn(
  async (_opts: { accountId?: string; saasBaseUrl: string; tenant: string }) => ({
    creds: { userJwt: "JWT", userSeed: "SEED" },
    peerId: "p",
    jwksUrl: "j",
    bootstrapUrl: "b",
    natsUrl: "wss://relay.example",
  }),
);
vi.mock("./acquire-credentials.js", () => ({
  acquireCredentials: (opts: never) => acquireMock(opts),
}));

// Mock the Gate A preflight so afterAccountConfigWritten is testable without a
// real SaaS JWKS fetch / NATS relay dial. The real preflight is covered in
// preflight.test.ts; here we only assert it is INVOKED post-enroll.
const preflightMock = vi.fn(
  async (_opts: unknown) => ({ ok: true, line: "channels add preflight: (stub)" }),
);
vi.mock("./preflight.js", () => ({
  runAddPreflight: (opts: never) => preflightMock(opts),
}));

// Migration durability/behavior is covered separately. Keep setup-unit reads
// hermetic so they never inspect or mutate the developer's real legacy home.
const migrationMock = vi.hoisted(() => vi.fn(() => ({
    status: "not-needed",
    credential: "absent",
    conversationKeys: "absent",
  })));
vi.mock("./legacy-storage-migration.js", () => ({
  migrateLegacyTupleState: () => migrationMock(),
}));

// Mock node:fs so direct credential reads are controllable.
const readMock = vi.fn((_p: string) => "");
const rootDirectoryStat = {
  dev: 1,
  ino: 1,
  isDirectory: () => true,
  isSymbolicLink: () => false,
};
const lstatMock = vi.fn((path: string) => {
  if (path === "/") return rootDirectoryStat;
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (p: string) => readMock(p),
    lstatSync: (p: string) => lstatMock(p),
  };
});

import { webchannelSetup, buildAccountPatch, resolveSetupIdentity } from "./setup.js";
import { listWebchannelAccountIds } from "./account-config.js";
import { createCredentialIdentityForEnrollment } from "./credential-document.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { StorageDocumentError } from "./storage-document.js";

const TEST_PAIR = generateKeyPair();
const KEY = Buffer.from(TEST_PAIR.publicKey).toString("base64url");
const PRIVATE_KEY = Buffer.from(TEST_PAIR.privateKey).toString("base64url");
function credentialJson(input: {
  tenant?: string;
  accountId?: string;
  saasBaseUrl?: string;
} = {}): string {
  const tenant = input.tenant ?? "t";
  const accountId = input.accountId ?? "accta";
  const saasBaseUrl = input.saasBaseUrl ?? "http://s";
  return JSON.stringify({
    credentialIdentity: createCredentialIdentityForEnrollment({
      tenant,
      accountId,
      saasBaseUrl,
      relayUrl: "wss://relay.example",
      agentPublicKey: KEY,
    }),
    identityKey: { publicKey: KEY, privateKey: PRIVATE_KEY },
    enrollment: {
      creds: { userJwt: "JWT", userSeed: "SEED" },
      peerId: "peer-a",
      jwksUrl: "https://keys.example/jwks",
      bootstrapUrl: "https://bootstrap.example",
      natsUrl: "wss://relay.example",
    },
    tenant,
    accountId,
    saasEnrollUrl: `${saasBaseUrl}/api/enroll`,
    saasPollUrl: `${saasBaseUrl}/api/poll`,
  });
}

type Cfg = { channels: { webchannel?: Record<string, unknown> } };
function section(next: unknown): Record<string, unknown> {
  return (next as Cfg).channels.webchannel as Record<string, unknown>;
}

beforeEach(() => {
  acquireMock.mockClear();
  preflightMock.mockClear();
  migrationMock.mockReset();
  migrationMock.mockReturnValue({
    status: "not-needed",
    credential: "absent",
    conversationKeys: "absent",
  });
  readMock.mockReset();
  readMock.mockImplementation(() => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  lstatMock.mockReset();
  lstatMock.mockImplementation((path: string) => {
    if (path === "/") return rootDirectoryStat;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
});

describe("setup: resolveSetupIdentity", () => {
  it("prefers dedicated keys over generic flags", () => {
    expect(
      resolveSetupIdentity({
        saasBaseUrl: "http://s",
        tenant: "t",
        baseUrl: "http://ignored",
        url: "ignored",
      }),
    ).toEqual({ saasBaseUrl: "http://s", tenant: "t" });
  });

  it("falls back to generic flags when dedicated keys are absent", () => {
    expect(
      resolveSetupIdentity({ baseUrl: "http://s", url: "tenant-x" }),
    ).toEqual({ saasBaseUrl: "http://s", tenant: "tenant-x" });
  });
});

describe("setup: buildAccountPatch", () => {
  it("maps identity into the account config shape", () => {
    expect(
      buildAccountPatch({ saasBaseUrl: "http://s", tenant: "t" }),
    ).toEqual({ tenant: "t", saas: { baseUrl: "http://s" } });
  });

  it("includes only defined fields", () => {
    expect(buildAccountPatch({ tenant: "t" })).toEqual({ tenant: "t" });
  });

  it("maps credentialsMode into nats.credentials.mode", () => {
    expect(buildAccountPatch({ credentialsMode: "static" })).toEqual({
      nats: { credentials: { mode: "static" } },
    });
  });
});

describe("setup: resolveAccountId (canonicalization / trust boundary)", () => {
  it("defaults to 'default'", () => {
    expect(webchannelSetup.resolveAccountId({})).toBe("default");
  });
  it("canonicalizes (lowercases) an explicit id", () => {
    expect(webchannelSetup.resolveAccountId({ accountId: "AcctA" })).toBe("accta");
    expect(webchannelSetup.resolveAccountId({ accountId: "default" })).toBe("default");
  });
  it("collapses a traversal id to a safe canonical id (no '/' or '.')", () => {
    const id = webchannelSetup.resolveAccountId({ accountId: "../../tmp/evil" });
    expect(id).toBe("tmp-evil");
    expect(id).not.toMatch(/[./\\]/);
  });
});

describe("setup: applyAccountConfig (writes to accounts.<id>)", () => {
  it("writes a NAMED account under accounts.<id> (full block when saasBaseUrl present)", () => {
    const cfg = { channels: {} } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "accta",
      input: { saasBaseUrl: "http://s", tenant: "t" },
    });
    // saasBaseUrl present ⇒ the complete enroll-ready block is written under the
    // named account. Trust-anchor change 2: issuer/jwksUrl/audience are NOT
    // written (no operator pins supplied) — they derive at runtime from
    // {saas.baseUrl, accountId}. Only the anchor + strategy + admission/creds/
    // dmSecurity are persisted.
    expect(section(next)).toEqual({
      accounts: {
        accta: {
          tenant: "t",
          saas: { baseUrl: "http://s" },
          auth: { strategy: "jwt" },
          dmSecurity: "open",
          nats: { admission: "register-hop", credentials: { mode: "enrolled" } },
        },
      },
    });
  });

  it("writes only a PARTIAL block when saasBaseUrl is absent", () => {
    const cfg = { channels: {} } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "accta",
      input: { tenant: "t" },
    });
    // No saasBaseUrl ⇒ partial write only (no auth/nats/dmSecurity emitted).
    expect((section(next).accounts as Record<string, unknown>).accta).toEqual({
      tenant: "t",
    });
  });

  it("fails closed before writing when existing config contains removed auth.jwt.audience", () => {
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: {
              auth: {
                strategy: "jwt",
                jwt: {
                  jwksUrl: "http://s/.well-known/jwks.json",
                  issuer: "http://custom-issuer",
                  audience: "custom-aud",
                },
              },
            },
          },
        },
      },
    } as never;
    expect(() => webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "accta",
      input: { saasBaseUrl: "http://s", tenant: "t2" },
    })).toThrow(/delete auth\.jwt\.audience/i);
    expect(((section(cfg).accounts as Record<string, unknown>).accta as { tenant?: string }).tenant)
      .toBeUndefined();
  });

  it("allows an issuer-only input but rejects the removed audience input", () => {
    const cfg = { channels: {} } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "accta",
      input: {
        saasBaseUrl: "http://host.docker.internal:3951",
        tenant: "t",
        issuer: "http://127.0.0.1:3951",
      },
    });
    const accta = (section(next).accounts as Record<string, unknown>).accta as Record<
      string,
      unknown
    >;
    // Issuer remains an advanced pin. Audience is structurally the account id
    // and is never persisted independently.
    expect(accta.auth).toEqual({
      strategy: "jwt",
      jwt: {
        issuer: "http://127.0.0.1:3951",
      },
    });
    expect(() => webchannelSetup.applyAccountConfig({
      cfg: { channels: {} } as never,
      accountId: "accta",
      input: { tenant: "t", audience: "custom-aud" },
    })).toThrow(/removed setup input audience/i);
  });

  it("writes the DEFAULT account at channel level (flat — regression-safe) when no named accounts exist", () => {
    const cfg = { channels: { webchannel: { allowFrom: ["x"], auth: { strategy: "jwt" } } } } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { tenant: "t" },
    });
    // Stays flat: existing fields preserved + tenant merged in (no `accounts` key).
    expect(section(next)).toEqual({ allowFrom: ["x"], auth: { strategy: "jwt" }, tenant: "t" });
    // A flat default (no accounts map) is still servable via the fallback.
    expect(listWebchannelAccountIds(next)).toEqual(["default"]);
  });

  it("scopes the DEFAULT account under accounts.default when a named accounts map exists (issue #17)", () => {
    // A flat default write here would enroll creds for an account that
    // listWebchannelAccountIds never serves, and its identity fields would
    // contaminate the named account as shared base. It must land under
    // accounts.default so it is actually served.
    const cfg = {
      channels: { webchannel: { auth: { strategy: "jwt" }, accounts: { acctb: { tenant: "tB" } } } },
    } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { tenant: "tDefault" },
    });
    const s = section(next);
    // Channel-level shared base untouched; default written under accounts.default.
    expect(s.auth).toEqual({ strategy: "jwt" });
    expect(s.tenant).toBeUndefined();
    expect(s.accounts).toEqual({
      acctb: { tenant: "tB" },
      default: { tenant: "tDefault" },
    });
    // Both accounts are now servable — no phantom, no silent drop.
    expect(listWebchannelAccountIds(next)).toEqual(["acctb", "default"]);
  });

  it("adds a named account alongside core's promoted accounts.default (no clobber)", () => {
    // Simulate the state AFTER core's moveSingleAccountChannelSectionToDefaultAccount:
    // shared base at channel level + promoted subset under accounts.default.
    const cfg = {
      channels: {
        webchannel: {
          auth: { strategy: "jwt" },
          accounts: { default: { allowFrom: ["x"] } },
        },
      },
    } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "acctb",
      input: { tenant: "tB" },
    });
    const s = section(next);
    expect(s.auth).toEqual({ strategy: "jwt" });
    expect(s.accounts).toEqual({
      default: { allowFrom: ["x"] },
      acctb: { tenant: "tB" },
    });
  });

  it("shallow-merges nats when re-running on a named account", () => {
    const cfg = {
      channels: { webchannel: { accounts: { accta: { nats: { url: "ws://x" } } } } },
    } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "accta",
      input: { credentialsMode: "enrolled" },
    });
    expect((section(next).accounts as Record<string, unknown>).accta).toEqual({
      nats: { url: "ws://x", credentials: { mode: "enrolled" } },
    });
  });

  it("does not mutate the input config object", () => {
    const cfg = { channels: { webchannel: { allowFrom: ["x"] } } } as never;
    const snapshot = JSON.stringify(cfg);
    webchannelSetup.applyAccountConfig({ cfg, accountId: "acctb", input: { tenant: "t" } });
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });

  it("ensures a named account exists even with no flags", () => {
    const cfg = { channels: {} } as never;
    const next = webchannelSetup.applyAccountConfig({ cfg, accountId: "acctz", input: {} });
    expect((section(next).accounts as Record<string, unknown>).acctz).toEqual({});
  });

  it("canonicalizes the account id before writing (no traversal key)", () => {
    const cfg = { channels: {} } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "../../evil",
      input: { tenant: "t" },
    });
    const accounts = section(next).accounts as Record<string, unknown>;
    expect(Object.keys(accounts)).toEqual(["evil"]);
  });
});

describe("setup: afterAccountConfigWritten (headless acquisition)", () => {
  function makeRuntime() {
    return { log: vi.fn() };
  }

  it.each([42, "relative/state"])(
    "contains invalid storageRoot %j as an account-scoped setup diagnostic",
    async (storageRoot) => {
      const runtime = makeRuntime();
      const cfg = {
        channels: {
          webchannel: {
            accounts: {
              accta: {
                tenant: "tA",
                storageRoot,
                saas: { baseUrl: "http://s" },
              },
            },
          },
        },
      } as never;

      await expect(
        webchannelSetup.afterAccountConfigWritten({
          previousCfg: cfg,
          cfg,
          accountId: "accta",
          input: {},
          runtime,
        }),
      ).resolves.toBeUndefined();

      const output = runtime.log.mock.calls.flat().join("\n");
      expect(output).toContain('account "accta"');
      expect(output).toContain("code=storage-root-invalid");
      expect(output).toContain("absolute filesystem path");
      expect(acquireMock).not.toHaveBeenCalled();
    },
  );

  it("runs acquireCredentials for an enrolled account with no existing creds", async () => {
    const runtime = makeRuntime();
    const cfg = {
      channels: { webchannel: { accounts: { accta: {
        tenant: "tA",
        storageRoot: "/operator/state",
        saas: { baseUrl: "http://s" },
      } } } },
    } as never;
    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: { saasBaseUrl: "http://s", tenant: "tA" },
      runtime,
    });
    expect(acquireMock).toHaveBeenCalledOnce();
    expect(acquireMock.mock.calls[0][0]).toMatchObject({
      accountId: "accta",
      saasBaseUrl: "http://s",
      storageRoot: "/operator/state",
      tenant: "tA",
    });
    // Gate A preflight runs POST-enroll with the derived anchor + enrolled creds.
    expect(preflightMock).toHaveBeenCalledOnce();
    expect(preflightMock.mock.calls[0][0]).toMatchObject({
      accountId: "accta",
      saasBaseUrl: "http://s",
      tenant: "tA",
      enrollment: { userJwt: "JWT", userSeed: "SEED" },
    });
  });

  it("refuses acquisition when the effective binding identity is invalid", async () => {
    const runtime = makeRuntime();
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: {
              tenant: "invalid.tenant",
              saas: { baseUrl: "http://s" },
            },
          },
        },
      },
    } as never;

    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: {},
      runtime,
    });

    expect(acquireMock).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.flat().join("\n")).toContain(
      "effective tenant/account/SaaS identity is invalid",
    );
  });

  it("reports a sanitized actionable storage migration failure", async () => {
    migrationMock.mockImplementationOnce(() => {
      throw new StorageDocumentError("credentials", "legacy-claim-conflict");
    });
    const runtime = makeRuntime();
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: { tenant: "tA", saas: { baseUrl: "http://s" } },
          },
        },
      },
    } as never;

    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: {},
      runtime,
    });

    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain(
      "code=credential-storage-legacy-claim-conflict",
    );
    expect(output).toContain("stop all old WebChannel plugin processes");
    expect(output).toContain("recoverable legacy backup");
    expect(output).not.toContain("/SECRET/operator/path");
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("echoes the RESOLVED identity (non-secret) so the generic-flag mapping is not silent", async () => {
    const runtime = makeRuntime();
    const cfg = { channels: { webchannel: { accounts: { accta: {} } } } } as never;
    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      // Generic-flag mapping: --base-url/--url. The wire identity is the account
      // id itself (가-2) — there is no --token → agentId mapping anymore.
      input: { baseUrl: "http://s", url: "tenant-x" },
      runtime,
    });
    const echoed = runtime.log.mock.calls.find((c) =>
      String(c[0]).includes("resolved acquisition identity"),
    );
    expect(echoed).toBeDefined();
    expect(String(echoed![0])).toContain("tenant=tenant-x");
    expect(String(echoed![0])).toContain("accountId=accta");
    expect(String(echoed![0])).toContain("saasBaseUrl=http://s");
  });

  it("acquires against nats.credentials.saasBaseUrl instead of the lower account SaaS base", async () => {
    const runtime = makeRuntime();
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: {
              tenant: "tenant-x",
              saas: { baseUrl: "https://saas-a.example" },
              nats: {
                credentials: {
                  mode: "enrolled",
                  saasBaseUrl: "https://saas-b.example",
                },
              },
            },
          },
        },
      },
    } as never;

    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: {},
      runtime,
    });

    expect(acquireMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "accta",
        tenant: "tenant-x",
        saasBaseUrl: "https://saas-b.example",
      }),
    );
    expect(
      runtime.log.mock.calls.flat().join("\n"),
    ).toContain("saasBaseUrl=https://saas-b.example");
  });

  it("uses the runtime-supported top-level identity fallback for the legacy default account", async () => {
    const runtime = makeRuntime();
    const cfg = {
      tenant: "legacy-tenant",
      saas: { baseUrl: "https://legacy-saas.example" },
      channels: { webchannel: {} },
    } as never;

    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "default",
      input: {},
      runtime,
    });

    expect(acquireMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        tenant: "legacy-tenant",
        saasBaseUrl: "https://legacy-saas.example",
      }),
    );
  });

  it.each(["bogus", null])(
    "refuses invalid explicit credential mode %j without acquisition",
    async (invalidMode) => {
    const runtime = makeRuntime();
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: {
              auth: { jwt: {} },
              nats: { credentials: { mode: invalidMode } },
            },
          },
        },
      },
    } as never;

    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: {},
      runtime,
    });

    expect(acquireMock).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.flat().join("\n")).toContain(
      'invalid credential mode; expected "static" or "enrolled"',
    );
    },
  );

  it("skips acquisition when per-account creds already exist", async () => {
    readMock.mockReturnValue(credentialJson());
    const runtime = makeRuntime();
    const cfg = { channels: { webchannel: { accounts: { accta: { saas: { baseUrl: "http://s" } } } } } } as never;
    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: { saasBaseUrl: "http://s", tenant: "t" },
      runtime,
    });
    expect(acquireMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalled();
  });

  it("refuses acquisition when the credential path is unreadable", async () => {
    readMock.mockImplementation(() => {
      throw Object.assign(new Error("SECRET permission detail"), {
        code: "EACCES",
      });
    });
    const runtime = makeRuntime();
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: { tenant: "t", saas: { baseUrl: "http://s" } },
          },
        },
      },
    } as never;

    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: {},
      runtime,
    });

    expect(acquireMock).not.toHaveBeenCalled();
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("credentials-invalid-read-failed");
    expect(output).not.toContain("SECRET permission detail");
  });

  it("refuses acquisition for a dangling credential symlink", async () => {
    lstatMock.mockImplementation((path: string) => {
      if (path.endsWith("/credentials.json")) {
        return {
          dev: 2,
          ino: 2,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        };
      }
      if (path === "/") return rootDirectoryStat;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const runtime = makeRuntime();
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: { tenant: "t", saas: { baseUrl: "http://s" } },
          },
        },
      },
    } as never;

    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: {},
      runtime,
    });

    expect(acquireMock).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.flat().join("\n")).toContain(
      "credentials-invalid-read-failed",
    );
  });

  it("refuses mismatched existing credentials without enrolling or exposing values", async () => {
    const secretRelay = "wss://user:pass@old.example/private?token=secret";
    const candidate = JSON.parse(credentialJson()) as Record<string, any>;
    candidate.credentialIdentity.storage.tenant = "old-tenant";
    candidate.credentialIdentity.binding.relayUrl = secretRelay;
    candidate.enrollment.natsUrl = secretRelay;
    readMock.mockReturnValue(JSON.stringify(candidate));
    const runtime = makeRuntime();
    const cfg = {
      channels: { webchannel: { accounts: { accta: { tenant: "t", saas: { baseUrl: "http://s" } } } } },
    } as never;

    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: {},
      runtime,
    });

    expect(acquireMock).not.toHaveBeenCalled();
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("storage.tenant");
    expect(output).toContain("archive");
    expect(output).toContain("SaaS active-key replacement");
    expect(output).toContain(
      "openclaw channels add --channel webchannel --account accta",
    );
    expect(output).not.toContain(secretRelay);
    expect(output).not.toContain("user:pass");
    expect(output).not.toContain("token=secret");
  });

  it("skips acquisition (and logs) when credential mode is not enrolled", async () => {
    const runtime = makeRuntime();
    const cfg = {
      channels: { webchannel: { accounts: { accta: { nats: { credentials: { mode: "static" } } } } } },
    } as never;
    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: {},
      runtime,
    });
    expect(acquireMock).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.some((c) => String(c[0]).includes("static"))).toBe(true);
  });

  it("logs actionable remediation when no saas-base-url is available", async () => {
    const runtime = makeRuntime();
    const cfg = { channels: { webchannel: { accounts: { accta: { tenant: "t" } } } } } as never;
    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: { tenant: "t" },
      runtime,
    });
    expect(acquireMock).not.toHaveBeenCalled();
    expect(
      runtime.log.mock.calls.some((c) => String(c[0]).includes("channels add")),
    ).toBe(true);
  });

  it("does NOT throw when acquisition fails (channels add still exits cleanly)", async () => {
    acquireMock.mockRejectedValueOnce(new Error("enroll boom"));
    const runtime = makeRuntime();
    const cfg = { channels: { webchannel: { accounts: { accta: { saas: { baseUrl: "http://s" } } } } } } as never;
    await expect(
      webchannelSetup.afterAccountConfigWritten({
        previousCfg: cfg,
        cfg,
        accountId: "accta",
        input: { saasBaseUrl: "http://s", tenant: "t" },
        runtime,
      }),
    ).resolves.toBeUndefined();
    expect(runtime.log.mock.calls.some((c) => String(c[0]).includes("failed"))).toBe(true);
  });
});
