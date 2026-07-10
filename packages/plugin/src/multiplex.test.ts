import { describe, it, expect, beforeEach } from "vitest";

import { planAccounts } from "./multiplex.js";
import { _resetAcquisitionEnvWarning } from "./acquisition-env.js";

beforeEach(() => {
  _resetAcquisitionEnvWarning();
});

/** Helper: collect the served plans (status === "serve"). */
function served(entries: ReturnType<typeof planAccounts>) {
  return entries.filter((e) => e.status === "serve");
}

describe("planAccounts: single default (regression)", () => {
  it("plans the default account from a flat config", () => {
    const cfg = {
      channels: {
        webchannel: {
          tenant: "t",
          auth: { strategy: "jwt" },
        },
      },
    };
    const plans = planAccounts(cfg, { env: {} });
    expect(served(plans)).toHaveLength(1);
    expect(served(plans)[0]).toMatchObject({
      accountId: "default",
      tenant: "t",
    });
  });

  it("synthesizes the default identity from env when no config exists", () => {
    const plans = planAccounts(
      { channels: {} },
      {
        env: {
          WEBCHANNEL_TENANT: "envT",
          WEBCHANNEL_SAAS_BASE_URL: "http://env",
        },
      },
    );
    expect(served(plans)).toHaveLength(1);
    expect(served(plans)[0]).toMatchObject({
      accountId: "default",
      tenant: "envT",
      saasBaseUrl: "http://env",
    });
  });
});

describe("planAccounts: multi-account (Phase 3)", () => {
  it("plans N accounts with their own per-account tenant (accountId is the wire identity)", () => {
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            acctA: { tenant: "tA", saas: { baseUrl: "http://a" } },
            acctB: { tenant: "tB" },
          },
        },
      },
    };
    const plans = served(planAccounts(cfg, { env: {} }));
    expect(plans.map((p) => p.accountId)).toEqual(["acctA", "acctB"]);
    expect(plans[0]).toMatchObject({ accountId: "acctA", tenant: "tA", saasBaseUrl: "http://a" });
    expect(plans[1]).toMatchObject({ accountId: "acctB", tenant: "tB" });
  });

  it("does NOT serve a phantom default from channel-level shared base (issue #17)", () => {
    // Channel-level fields are the SHARED BASE only; once `accounts` is present
    // they never conjure an implicit `"default"` account to serve alongside the
    // named ones (which would then fail credential acquisition for an account
    // that was never configured).
    const cfg = {
      channels: {
        webchannel: {
          tenant: "tDef",
          accounts: { acctA: {} },
        },
      },
    };
    const plans = served(planAccounts(cfg, { env: {} }));
    expect(plans.map((p) => p.accountId)).toEqual(["acctA"]);
    // The shared base still merges under the named account.
    expect(plans[0]).toMatchObject({ accountId: "acctA", tenant: "tDef" });
  });

  it("carries the merged per-account config (shared base inherited)", () => {
    const cfg = {
      channels: {
        webchannel: {
          auth: { strategy: "jwt" },
          accounts: { acctA: { tenant: "tA", dmSecurity: "allowlist" } },
        },
      },
    };
    const plan = served(planAccounts(cfg, { env: {} }))[0];
    expect(plan.account.auth).toEqual({ strategy: "jwt" }); // inherited base
    expect(plan.account.dmSecurity).toBe("allowlist"); // account override
  });
});

describe("planAccounts: 가-2 decoupled handling agent", () => {
  it("serves a named account that declares NO agentId (agent is a bind concern)", () => {
    // 가-2: the wire identity is the accountId itself, so a named account needs no
    // per-account agentId — the handling agent is selected purely via `agents bind`.
    const cfg = {
      channels: {
        webchannel: {
          accounts: { acctA: { tenant: "tA" } },
        },
      },
    };
    const plans = planAccounts(cfg, { env: {} });
    expect(served(plans).map((p) => p.accountId)).toEqual(["acctA"]);
  });

  it("silently ignores a leftover (legacy) agentId field in account config", () => {
    // A stale `agentId` from an old config must not crash and must not affect the
    // served plan — accountId is the only wire coordinate.
    const cfg = {
      channels: {
        webchannel: {
          agentId: "legacy-shared",
          accounts: {
            acctA: { tenant: "tA", agentId: "legacy-a" },
            acctB: { tenant: "tB", agentId: "legacy-a" }, // duplicate legacy value: harmless now
          },
        },
      },
    };
    const plans = planAccounts(cfg, { env: {} });
    // Both named accounts serve; the wire identity is their (unique) accountId.
    expect(served(plans).map((p) => p.accountId).sort()).toEqual(["acctA", "acctB"]);
  });
});

describe("planAccounts: orphaned-default boot warning (issue #17)", () => {
  it("warns once when channel-level auth coexists with named accounts and no accounts.default", () => {
    const warnings: string[] = [];
    const cfg = {
      channels: {
        webchannel: {
          auth: { strategy: "jwt" },
          accounts: { for_work: {} },
        },
      },
    };
    const plans = planAccounts(cfg, { env: {}, warn: (m) => warnings.push(m) });
    // Only the named account is served — the channel-level default is orphaned.
    expect(served(plans).map((p) => p.accountId)).toEqual(["for_work"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("accounts.default");
  });

  it("does NOT warn when an explicit accounts.default exists", () => {
    const warnings: string[] = [];
    const cfg = {
      channels: {
        webchannel: {
          auth: { strategy: "jwt" },
          accounts: { for_work: {}, default: {} },
        },
      },
    };
    planAccounts(cfg, { env: {}, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it("does NOT warn for a tuning-only shared base (streaming) with named accounts", () => {
    const warnings: string[] = [];
    const cfg = {
      channels: {
        webchannel: {
          streaming: { mode: "progress" },
          accounts: { for_work: {} },
        },
      },
    };
    planAccounts(cfg, { env: {}, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
});
