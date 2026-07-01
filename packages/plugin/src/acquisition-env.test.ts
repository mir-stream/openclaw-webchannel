import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  resolveAcquisitionEnvPrecedence,
  _resetAcquisitionEnvWarning,
} from "./acquisition-env.js";

beforeEach(() => {
  _resetAcquisitionEnvWarning();
});

describe("resolveAcquisitionEnvPrecedence", () => {
  it("uses env to synthesize the default identity when there is NO config", () => {
    const warn = vi.fn();
    const { identity, usedLegacyEnv } = resolveAcquisitionEnvPrecedence({}, "default", {
      env: {
        WEBCHANNEL_TENANT: "envTenant",
        WEBCHANNEL_SAAS_BASE_URL: "http://env-saas",
      },
      warn,
    });
    expect(identity).toEqual({
      accountId: "default",
      tenant: "envTenant",
      saasBaseUrl: "http://env-saas",
    });
    expect(usedLegacyEnv).toBe(true);
    // No config ⇒ no deprecation warning (env is the intended legacy path).
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to historical defaults when no config and no env", () => {
    const { identity, usedLegacyEnv } = resolveAcquisitionEnvPrecedence({}, "default", {
      env: {},
      warn: () => {},
    });
    expect(identity.tenant).toBe("default-tenant");
    expect(identity.accountId).toBe("default");
    expect(identity.saasBaseUrl).toBeUndefined();
    expect(usedLegacyEnv).toBe(true);
  });

  it("IGNORES env and uses config when a webchannel config exists", () => {
    const warn = vi.fn();
    const cfg = {
      channels: { webchannel: { tenant: "cfgTenant" } },
    };
    const { identity, usedLegacyEnv } = resolveAcquisitionEnvPrecedence(cfg, "default", {
      env: { WEBCHANNEL_TENANT: "envTenant" },
      warn,
    });
    expect(identity.tenant).toBe("cfgTenant");
    expect(usedLegacyEnv).toBe(false);
    // One-time deprecation warning emitted (env set + config present).
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("WEBCHANNEL_TENANT");
  });

  it("does not warn when config exists but no identity env is set", () => {
    const warn = vi.fn();
    const cfg = { channels: { webchannel: { tenant: "cfgTenant" } } };
    resolveAcquisitionEnvPrecedence(cfg, "default", { env: {}, warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits the deprecation warning at most once per process", () => {
    const warn = vi.fn();
    const cfg = { channels: { webchannel: { tenant: "t" } } };
    const env = { WEBCHANNEL_TENANT: "envTenant" };
    resolveAcquisitionEnvPrecedence(cfg, "default", { env, warn });
    resolveAcquisitionEnvPrecedence(cfg, "default", { env, warn });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not crash when env is present but config wins (no throw)", () => {
    const cfg = { channels: { webchannel: { acctA: { tenant: "tA" } } } };
    expect(() =>
      resolveAcquisitionEnvPrecedence(cfg, "acctA", {
        env: { WEBCHANNEL_TENANT: "x" },
        warn: () => {},
      }),
    ).not.toThrow();
  });
});
