import { describe, expect, it, vi } from "vitest";

import {
  deriveAccountAuth,
  prepareAccountAuth,
  resolveEffectiveAccountAuth,
} from "./account-auth.js";
import type { AuthConfig } from "./auth.js";

const pointer = (): AuthConfig => ({ strategy: "jwt", jwt: {} as never });

describe("resolveEffectiveAccountAuth", () => {
  it("uses plan SaaS URL before top-level and derives absent trust facts", () => {
    const result = resolveEffectiveAccountAuth({
      accountAuthRaw: pointer(), tenant: "tenant", accountId: "alpha", planSaasBaseUrl: "https://plan.example/",
      topLevelSaasBaseUrl: "https://top.example", loadCreds: () => undefined,
    });
    expect(result).toMatchObject({ strategy: "jwt", jwt: { issuer: "https://plan.example", jwksUrl: "https://plan.example/.well-known/jwks.json" } });
    expect((result?.jwt as Record<string, unknown>)).not.toHaveProperty("audience");
  });

  it("falls back to the top-level SaaS URL", () => {
    const result = resolveEffectiveAccountAuth({ accountAuthRaw: pointer(), tenant: "tenant", accountId: "alpha", topLevelSaasBaseUrl: "https://top.example", loadCreds: () => undefined });
    expect(result?.strategy === "jwt" && (result.jwt as { issuer?: string }).issuer).toBe("https://top.example");
  });

  it("uses a delivered issuer even without a base URL and leaves JWKS validation to preparation", () => {
    const result = resolveEffectiveAccountAuth({ accountAuthRaw: pointer(), tenant: "tenant", accountId: "alpha", loadCreds: () => ({ userJwt: "J", userSeed: "S", issuer: "https://delivered" }) });
    expect(result).toEqual({ strategy: "jwt", jwt: { issuer: "https://delivered" } });
  });

  it("applies pin > delivered > derived and preserves every key-source form", () => {
    for (const keySource of [{ jwksUrl: "https://pin/keys" }, { jwksFile: "/keys.json" }, { jwks: { keys: [] } }]) {
      const raw = { strategy: "jwt", jwt: { ...keySource, issuer: "https://pin" } } as AuthConfig;
      expect(resolveEffectiveAccountAuth({ accountAuthRaw: raw, tenant: "tenant", accountId: "alpha", planSaasBaseUrl: "https://derived", loadCreds: () => ({ userJwt: "J", userSeed: "S", issuer: "https://delivered" }) })).toEqual(raw);
    }
    const delivered = resolveEffectiveAccountAuth({ accountAuthRaw: pointer(), tenant: "tenant", accountId: "alpha", planSaasBaseUrl: "https://derived", loadCreds: () => ({ userJwt: "J", userSeed: "S", issuer: "https://delivered" }) });
    expect(delivered?.strategy === "jwt" && (delivered.jwt as { issuer?: string }).issuer).toBe("https://delivered");
  });

  it("loads persisted credentials exactly once", () => {
    const loadCreds = vi.fn(() => undefined);
    deriveAccountAuth(pointer(), "https://x", "a");
    resolveEffectiveAccountAuth({ accountAuthRaw: pointer(), tenant: "tenant", accountId: "a", planSaasBaseUrl: "https://x", loadCreds });
    expect(loadCreds).toHaveBeenCalledOnce();
  });

  it("does not load persisted metadata for missing/non-jwt auth or an explicit issuer", () => {
    for (const accountAuthRaw of [undefined, { strategy: "none" }] as const) {
      const loadCreds = vi.fn(() => ({
        userJwt: "J",
        userSeed: "S",
        issuer: "https://delivered",
      }));
      resolveEffectiveAccountAuth({
        accountAuthRaw: accountAuthRaw as never,
        tenant: "tenant",
        accountId: "alpha",
        loadCreds,
      });
      expect(loadCreds).not.toHaveBeenCalled();

      const getPersisted = vi.fn(loadCreds);
      const plan = {
        accountId: "alpha",
        tenant: "tenant",
        account: { ...(accountAuthRaw === undefined ? {} : { auth: accountAuthRaw }) },
      } as never;
      expect(() => prepareAccountAuth({ plan, getPersisted })).toThrow(/auth(?:\.| )strategy/);
      expect(getPersisted).not.toHaveBeenCalled();
    }

    const explicitLoad = vi.fn(() => ({
      userJwt: "J",
      userSeed: "S",
      issuer: "https://delivered",
    }));
    const explicitPlan = {
      accountId: "alpha",
      tenant: "tenant",
      account: {
        auth: {
          strategy: "jwt",
          jwt: { issuer: "https://pin", jwks: { keys: [] } },
        },
      },
    } as never;
    prepareAccountAuth({ plan: explicitPlan, getPersisted: explicitLoad });
    expect(explicitLoad).not.toHaveBeenCalled();
  });

  it("loads a delivered issuer once for one valid JWT preparation plan", () => {
    const getPersisted = vi.fn(() => ({
      userJwt: "J",
      userSeed: "S",
      issuer: "https://delivered",
    }));
    const plan = {
      accountId: "alpha",
      tenant: "tenant",
      saasBaseUrl: "https://derived",
      account: { auth: { strategy: "jwt", jwt: {} } },
    } as never;
    const prepared = prepareAccountAuth({ plan, getPersisted });
    expect(prepared.auth.jwt.issuer).toBe("https://delivered");
    expect(getPersisted).toHaveBeenCalledOnce();
  });

  it("derives an absent jwt pointer but rejects explicit malformed jwt without persisted reads", () => {
    const absent = deriveAccountAuth(
      { strategy: "jwt" },
      "https://saas.example/",
      "alpha",
    );
    expect(absent).toEqual({
      strategy: "jwt",
      jwt: {
        issuer: "https://saas.example",
        jwksUrl: "https://saas.example/.well-known/jwks.json",
      },
    });

    for (const jwt of [null, "bad", []]) {
      const getPersisted = vi.fn(() => ({
        userJwt: "J",
        userSeed: "S",
        issuer: "https://delivered",
      }));
      const plan = {
        accountId: "alpha",
        tenant: "tenant",
        saasBaseUrl: "https://saas.example",
        account: { auth: { strategy: "jwt", jwt } },
      } as never;
      expect(() => prepareAccountAuth({ plan, getPersisted })).toThrow(
        /auth\.jwt is required/,
      );
      expect(getPersisted).not.toHaveBeenCalled();
    }
  });

  it("does not replace malformed explicitly-present issuer or JWKS pins", () => {
    const getPersisted = vi.fn(() => ({
      userJwt: "J",
      userSeed: "S",
      issuer: "https://delivered",
    }));
    const invalidIssuerPlan = {
      accountId: "alpha",
      tenant: "tenant",
      saasBaseUrl: "https://derived",
      account: {
        auth: {
          strategy: "jwt",
          jwt: { issuer: "", jwks: { keys: [] } },
        },
      },
    } as never;
    expect(() => prepareAccountAuth({ plan: invalidIssuerPlan, getPersisted })).toThrow(
      "auth.jwt.issuer is required",
    );
    expect(getPersisted).not.toHaveBeenCalled();

    const invalidSourcePlan = {
      accountId: "alpha",
      tenant: "tenant",
      saasBaseUrl: "https://derived",
      account: {
        auth: {
          strategy: "jwt",
          jwt: { issuer: "https://pin", jwksUrl: undefined },
        },
      },
    } as never;
    expect(() => prepareAccountAuth({ plan: invalidSourcePlan, getPersisted })).toThrow(
      "auth.jwt.jwksUrl must be a non-empty string",
    );
    expect(getPersisted).not.toHaveBeenCalled();
  });
});
