import { describe, expect, it, vi } from "vitest";

import { deriveAccountAuth, resolveEffectiveAccountAuth } from "./account-auth.js";
import type { AuthConfig } from "./auth.js";

const pointer = (): AuthConfig => ({ strategy: "jwt", jwt: {} as never });

describe("resolveEffectiveAccountAuth", () => {
  it("uses plan SaaS URL before top-level and derives absent trust facts", () => {
    const result = resolveEffectiveAccountAuth({
      accountAuthRaw: pointer(), accountId: "alpha", planSaasBaseUrl: "https://plan.example/",
      topLevelSaasBaseUrl: "https://top.example", loadCreds: () => undefined,
    });
    expect(result).toMatchObject({ strategy: "jwt", jwt: { issuer: "https://plan.example", audience: "alpha", jwksUrl: "https://plan.example/.well-known/jwks.json" } });
  });

  it("falls back to the top-level SaaS URL", () => {
    const result = resolveEffectiveAccountAuth({ accountAuthRaw: pointer(), accountId: "alpha", topLevelSaasBaseUrl: "https://top.example", loadCreds: () => undefined });
    expect(result?.strategy === "jwt" && result.jwt.issuer).toBe("https://top.example");
  });

  it("preserves the no-base-URL early return even with a delivered issuer", () => {
    const raw = pointer();
    expect(resolveEffectiveAccountAuth({ accountAuthRaw: raw, accountId: "alpha", loadCreds: () => ({ userJwt: "J", userSeed: "S", issuer: "https://delivered" }) })).toBe(raw);
  });

  it("applies pin > delivered > derived and preserves every key-source form", () => {
    for (const keySource of [{ jwksUrl: "https://pin/keys" }, { jwksFile: "/keys.json" }, { jwks: { keys: [] } }]) {
      const raw = { strategy: "jwt", jwt: { ...keySource, issuer: "https://pin", audience: "pinned-aud" } } as AuthConfig;
      expect(resolveEffectiveAccountAuth({ accountAuthRaw: raw, accountId: "alpha", planSaasBaseUrl: "https://derived", loadCreds: () => ({ userJwt: "J", userSeed: "S", issuer: "https://delivered" }) })).toEqual(raw);
    }
    const delivered = resolveEffectiveAccountAuth({ accountAuthRaw: pointer(), accountId: "alpha", planSaasBaseUrl: "https://derived", loadCreds: () => ({ userJwt: "J", userSeed: "S", issuer: "https://delivered" }) });
    expect(delivered?.strategy === "jwt" && delivered.jwt.issuer).toBe("https://delivered");
  });

  it("loads persisted credentials exactly once", () => {
    const loadCreds = vi.fn(() => undefined);
    deriveAccountAuth(pointer(), "https://x", "a");
    resolveEffectiveAccountAuth({ accountAuthRaw: pointer(), accountId: "a", planSaasBaseUrl: "https://x", loadCreds });
    expect(loadCreds).toHaveBeenCalledOnce();
  });
});
