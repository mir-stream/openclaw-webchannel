import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the acquisition routine so afterAccountConfigWritten is testable without
// a real SaaS / device flow.
const acquireMock = vi.fn(
  async (_opts: { accountId?: string; saasBaseUrl: string; tenant: string; agentId?: string }) => ({
    creds: { userJwt: "JWT", userSeed: "SEED" },
    peerId: "p",
    jwksUrl: "j",
    bootstrapUrl: "b",
  }),
);
vi.mock("./acquire-credentials.js", () => ({
  acquireCredentials: (opts: never) => acquireMock(opts),
}));

// Mock node:fs so the "creds already exist" probe is controllable.
const existsMock = vi.fn((_p: string) => false);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (p: string) => existsMock(p) };
});

import { webchannelSetup, buildAccountPatch, resolveSetupIdentity } from "./setup.js";

type Cfg = { channels: { webchannel?: Record<string, unknown> } };
function section(next: unknown): Record<string, unknown> {
  return (next as Cfg).channels.webchannel as Record<string, unknown>;
}

beforeEach(() => {
  acquireMock.mockClear();
  existsMock.mockReset();
  existsMock.mockReturnValue(false);
});

describe("setup: resolveSetupIdentity", () => {
  it("prefers dedicated keys over generic flags", () => {
    expect(
      resolveSetupIdentity({
        saasBaseUrl: "http://s",
        tenant: "t",
        agentId: "a",
        baseUrl: "http://ignored",
        url: "ignored",
        token: "ignored",
      }),
    ).toEqual({ saasBaseUrl: "http://s", tenant: "t", agentId: "a" });
  });

  it("falls back to generic flags when dedicated keys are absent", () => {
    expect(
      resolveSetupIdentity({ baseUrl: "http://s", url: "tenant-x", token: "agent-y" }),
    ).toEqual({ saasBaseUrl: "http://s", tenant: "tenant-x", agentId: "agent-y" });
  });
});

describe("setup: buildAccountPatch", () => {
  it("maps identity into the account config shape", () => {
    expect(
      buildAccountPatch({ saasBaseUrl: "http://s", tenant: "t", agentId: "a" }),
    ).toEqual({ tenant: "t", agentId: "a", saas: { baseUrl: "http://s" } });
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
  it("writes a NAMED account under accounts.<id>", () => {
    const cfg = { channels: {} } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "accta",
      input: { saasBaseUrl: "http://s", tenant: "t", agentId: "a" },
    });
    expect(section(next)).toEqual({
      accounts: { accta: { tenant: "t", agentId: "a", saas: { baseUrl: "http://s" } } },
    });
  });

  it("writes the DEFAULT account at channel level (flat — regression-safe)", () => {
    const cfg = { channels: { webchannel: { allowFrom: ["x"], auth: { strategy: "jwt" } } } } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { tenant: "t" },
    });
    // Stays flat: existing fields preserved + tenant merged in (no `accounts` key).
    expect(section(next)).toEqual({ allowFrom: ["x"], auth: { strategy: "jwt" }, tenant: "t" });
  });

  it("preserves an existing accounts map when writing the default account", () => {
    const cfg = {
      channels: { webchannel: { auth: { strategy: "jwt" }, accounts: { acctb: { tenant: "tB" } } } },
    } as never;
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { tenant: "tDefault" },
    });
    const s = section(next);
    expect(s.tenant).toBe("tDefault");
    expect(s.auth).toEqual({ strategy: "jwt" });
    expect(s.accounts).toEqual({ acctb: { tenant: "tB" } });
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
      input: { tenant: "tB", agentId: "aB" },
    });
    const s = section(next);
    expect(s.auth).toEqual({ strategy: "jwt" });
    expect(s.accounts).toEqual({
      default: { allowFrom: ["x"] },
      acctb: { tenant: "tB", agentId: "aB" },
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

  it("runs acquireCredentials for an enrolled account with no existing creds", async () => {
    existsMock.mockReturnValue(false);
    const runtime = makeRuntime();
    const cfg = {
      channels: { webchannel: { accounts: { accta: { tenant: "tA", saas: { baseUrl: "http://s" } } } } },
    } as never;
    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      input: { saasBaseUrl: "http://s", tenant: "tA", agentId: "aA" },
      runtime,
    });
    expect(acquireMock).toHaveBeenCalledOnce();
    expect(acquireMock.mock.calls[0][0]).toMatchObject({
      accountId: "accta",
      saasBaseUrl: "http://s",
      tenant: "tA",
      agentId: "aA",
    });
  });

  it("echoes the RESOLVED identity (non-secret) so the generic-flag mapping is not silent", async () => {
    existsMock.mockReturnValue(false);
    const runtime = makeRuntime();
    const cfg = { channels: { webchannel: { accounts: { accta: {} } } } } as never;
    await webchannelSetup.afterAccountConfigWritten({
      previousCfg: cfg,
      cfg,
      accountId: "accta",
      // Generic-flag mapping: --base-url/--url/--token.
      input: { baseUrl: "http://s", url: "tenant-x", token: "agent-y" },
      runtime,
    });
    const echoed = runtime.log.mock.calls.find((c) =>
      String(c[0]).includes("resolved acquisition identity"),
    );
    expect(echoed).toBeDefined();
    expect(String(echoed![0])).toContain("tenant=tenant-x");
    expect(String(echoed![0])).toContain("agentId=agent-y");
    expect(String(echoed![0])).toContain("saasBaseUrl=http://s");
  });

  it("skips acquisition when per-account creds already exist", async () => {
    existsMock.mockReturnValue(true);
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
    existsMock.mockReturnValue(false);
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
    existsMock.mockReturnValue(false);
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
