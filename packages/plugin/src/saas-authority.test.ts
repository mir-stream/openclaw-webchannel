import { describe, expect, it, vi } from "vitest";
import { deriveEnrollmentEndpoints, isAbsoluteHttpUrl } from "./saas-authority.js";
import { deriveAccountAuth } from "./account-auth.js";
import { evaluateWebchannelDoctor } from "./doctor.js";
import { deriveJwksUrl, runAddPreflight } from "./preflight.js";
import { resolveEnrolledSaasBaseUrl } from "./nats-credential-source.js";

describe("SaaS transport trust (#411)", () => {
  it.each([
    "https://saas.example/base", "http://localhost:3001", "http://LOCALHOST:3001",
    "http://127.0.0.1", "http://127.255.255.254/base", "http://[::1]:3001",
  ])("allows %s without rewriting its authority", (url) => {
    expect(isAbsoluteHttpUrl(url)).toBe(true);
    expect(deriveEnrollmentEndpoints(url).saasEnrollUrl).toBe(`${url}/api/enroll`);
  });

  it.each([
    "http://saas.example", "http://192.168.1.1", "http://128.0.0.1",
    "http://localhost.evil", "http://127.0.0.1.evil", "http://[::2]",
    "http://[::ffff:127.0.0.1]", "http://localhost@evil", "http://evil@localhost",
  ])("rejects %s at validation, enrollment, derivation and resolution", (url) => {
    expect(isAbsoluteHttpUrl(url)).toBe(false);
    expect(() => deriveEnrollmentEndpoints(url)).toThrow();
    expect(() => deriveJwksUrl(url)).toThrow();
    expect(() => deriveAccountAuth({ strategy: "jwt" }, url, "default")).toThrow();
    expect(() => resolveEnrolledSaasBaseUrl({ env: {}, saasBaseUrl: url })).toThrow();
  });

  it("doctor reports insecure effective overrides before loading credentials", () => {
    const loadPersistedEnrolledCreds = vi.fn();
    const findings = evaluateWebchannelDoctor({ channels: { webchannel: {
      tenant: "t", auth: { strategy: "jwt" }, saas: { baseUrl: "https://safe.example" },
    } } }, { env: { WEBCHANNEL_SAAS_BASE_URL: "http://remote.example" }, loadPersistedEnrolledCreds });
    expect(findings).toContainEqual(expect.objectContaining({
      severity: "error", message: expect.stringMatching(/HTTPS|https/),
    }));
    expect(loadPersistedEnrolledCreds).not.toHaveBeenCalled();
  });

  it("preflight refuses remote HTTP before any fetch or relay dial", async () => {
    const fetchImpl = vi.fn();
    const dial = vi.fn();
    const report = await runAddPreflight({ accountId: "a", tenant: "t", saasBaseUrl: "http://remote.example",
      enrollment: { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example" }, log: () => {}, fetchImpl, dial });
    expect(report).toMatchObject({ ok: false, line: expect.stringContaining("HTTPS") });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  });
});
