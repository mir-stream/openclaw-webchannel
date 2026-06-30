import { describe, it, expect, beforeEach } from "vitest";

import { planAccounts } from "./multiplex.js";
import { _resetAcquisitionEnvWarning } from "./acquisition-env.js";

beforeEach(() => {
  _resetAcquisitionEnvWarning();
});

/** Helper: collect the served plans (status === "serve"). */
function served(entries: ReturnType<typeof planAccounts>) {
  return entries.filter((e) => e.status === "serve") as Extract<
    ReturnType<typeof planAccounts>[number],
    { status: "serve" }
  >[];
}
function skipped(entries: ReturnType<typeof planAccounts>) {
  return entries.filter((e) => e.status === "skip") as Extract<
    ReturnType<typeof planAccounts>[number],
    { status: "skip" }
  >[];
}

describe("planAccounts: single default (regression)", () => {
  it("plans the default account from a flat config", () => {
    const cfg = {
      channels: {
        webchannel: {
          tenant: "t",
          agentId: "agent-default",
          auth: { strategy: "jwt" },
        },
      },
    };
    const plans = planAccounts(cfg, { env: {} });
    expect(served(plans)).toHaveLength(1);
    expect(served(plans)[0]).toMatchObject({
      accountId: "default",
      tenant: "t",
      agentId: "agent-default",
    });
  });

  it("synthesizes the default identity from env when no config exists", () => {
    const plans = planAccounts(
      { channels: {} },
      {
        env: {
          WEBCHANNEL_TENANT: "envT",
          WEBCHANNEL_AGENT_ID: "envAgent",
          WEBCHANNEL_SAAS_BASE_URL: "http://env",
        },
      },
    );
    expect(served(plans)).toHaveLength(1);
    expect(served(plans)[0]).toMatchObject({
      accountId: "default",
      tenant: "envT",
      agentId: "envAgent",
      saasBaseUrl: "http://env",
    });
  });
});

describe("planAccounts: multi-account (Phase 3)", () => {
  it("plans N accounts with their own per-account tenant/agentId", () => {
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            acctA: { tenant: "tA", agentId: "agentA", saas: { baseUrl: "http://a" } },
            acctB: { tenant: "tB", agentId: "agentB" },
          },
        },
      },
    };
    const plans = served(planAccounts(cfg, { env: {} }));
    expect(plans.map((p) => p.accountId)).toEqual(["acctA", "acctB"]);
    expect(plans[0]).toMatchObject({ accountId: "acctA", tenant: "tA", agentId: "agentA", saasBaseUrl: "http://a" });
    expect(plans[1]).toMatchObject({ accountId: "acctB", tenant: "tB", agentId: "agentB" });
  });

  it("serves the default (channel-level) account alongside named accounts", () => {
    const cfg = {
      channels: {
        webchannel: {
          tenant: "tDef",
          agentId: "agentDef",
          accounts: { acctA: { tenant: "tA", agentId: "agentA" } },
        },
      },
    };
    const plans = served(planAccounts(cfg, { env: {} }));
    expect(plans.map((p) => p.accountId).sort()).toEqual(["acctA", "default"]);
    const def = plans.find((p) => p.accountId === "default");
    expect(def).toMatchObject({ agentId: "agentDef", tenant: "tDef" });
  });

  it("carries the merged per-account config (shared base inherited)", () => {
    const cfg = {
      channels: {
        webchannel: {
          auth: { strategy: "jwt" },
          accounts: { acctA: { tenant: "tA", agentId: "agentA", dmSecurity: "allowlist" } },
        },
      },
    };
    const plan = served(planAccounts(cfg, { env: {} }))[0];
    expect(plan.account.auth).toEqual({ strategy: "jwt" }); // inherited base
    expect(plan.account.dmSecurity).toBe("allowlist"); // account override
  });
});

describe("planAccounts: named-account-without-own-agentId skip (Rule 1)", () => {
  it("skips a named account that does not declare its OWN agentId", () => {
    const cfg = {
      channels: {
        webchannel: {
          // channel-level agentId would be inherited by acctA via merge — must NOT.
          agentId: "shared-agent",
          accounts: { acctA: { tenant: "tA" } },
        },
      },
    };
    const plans = planAccounts(cfg, { env: {} });
    const sk = skipped(plans).find((s) => s.accountId === "acctA");
    expect(sk?.reason).toBe("missing-agent-id");
    expect(sk?.message).toContain("--agent-id");
    expect(served(plans).some((p) => p.accountId === "acctA")).toBe(false);
  });

  it("does NOT skip the default account for using channel-level identity", () => {
    const cfg = { channels: { webchannel: { agentId: "shared-agent", tenant: "t" } } };
    const plans = planAccounts(cfg, { env: {} });
    expect(served(plans).map((p) => p.accountId)).toEqual(["default"]);
  });
});

describe("planAccounts: duplicate-agentId skip (Rule 2)", () => {
  it("skips the later account that collides on agentId; keeps the first", () => {
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            acctA: { tenant: "tA", agentId: "dup" },
            acctB: { tenant: "tB", agentId: "dup" },
          },
        },
      },
    };
    const plans = planAccounts(cfg, { env: {} });
    // Sorted order: acctA first wins "dup"; acctB skipped.
    expect(served(plans).map((p) => p.accountId)).toEqual(["acctA"]);
    const sk = skipped(plans).find((s) => s.accountId === "acctB");
    expect(sk?.reason).toBe("duplicate-agent-id");
    expect(sk?.message).toContain("acctA");
  });

  it("detects collision between a named account and the default", () => {
    const cfg = {
      channels: {
        webchannel: {
          agentId: "dup", // default's agentId
          accounts: { acctA: { tenant: "tA", agentId: "dup" } },
        },
      },
    };
    const plans = planAccounts(cfg, { env: {} });
    // Sorted: "acctA" < "default" → acctA keeps "dup", default skipped.
    const servedIds = served(plans).map((p) => p.accountId);
    expect(servedIds).toContain("acctA");
    expect(servedIds).not.toContain("default");
    expect(skipped(plans).find((s) => s.accountId === "default")?.reason).toBe(
      "duplicate-agent-id",
    );
  });
});
