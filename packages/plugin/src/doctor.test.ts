import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { PersistedEnrolledCreds } from "./account-config.js";
import {
  createWebchannelStatusAdapter,
  evaluateWebchannelDoctor,
  formatDoctorWarning,
  probeWebchannelAccount,
  type DoctorCheckId,
} from "./doctor.js";

const cfg = (webchannel: Record<string, unknown>): OpenClawConfig => ({ channels: { webchannel } } as never);
const identityKey = { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) };
const persisted = { userJwt: "J", userSeed: "S", identityKey };
const validAuth = (audience = "a") => ({ strategy: "jwt", jwt: { issuer: "https://issuer", audience, jwks: { keys: [] } } });
const ids = (config: OpenClawConfig, env: Record<string, string | undefined> = {}, load: () => PersistedEnrolledCreds | undefined = () => persisted) =>
  evaluateWebchannelDoctor(config, { env, loadPersistedEnrolledCreds: load }).map((finding) => finding.checkId);

describe("evaluateWebchannelDoctor findings", () => {
  const cases: Array<[DoctorCheckId, OpenClawConfig, Record<string, string | undefined>, () => PersistedEnrolledCreds | undefined]> = [
    ["encryption-disabled", cfg({ encryption: { mode: "disabled" }, auth: validAuth("default"), dmSecurity: "allowlist" }), {}, () => persisted],
    ["creds-missing", cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }), {}, () => undefined],
    ["identity-key-missing", cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }), {}, () => ({ userJwt: "J", userSeed: "S" })],
    ["verifier-unbuildable", cfg({ auth: { strategy: "jwt", jwt: { issuer: "", audience: "default", jwks: { keys: [] } } }, dmSecurity: "allowlist" }), {}, () => persisted],
    ["shared-audience", cfg({ dmSecurity: "allowlist", accounts: { a: { auth: validAuth("shared") }, b: { auth: validAuth("shared") } } }), {}, () => persisted],
    ["obsolete-cors", cfg({ auth: { ...validAuth("default"), cors: {} }, dmSecurity: "allowlist" }), {}, () => persisted],
    ["credential-source-invalid", cfg({ auth: validAuth("default"), nats: { credentials: { mode: "static", userJwt: "J" } }, dmSecurity: "allowlist" }), {}, () => persisted],
    ["orphaned-default", cfg({ auth: validAuth("shared"), dmSecurity: "allowlist", accounts: { named: {} } }), {}, () => persisted],
    ["deprecated-acquisition-env", cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }), { WEBCHANNEL_TENANT: "old" }, () => persisted],
  ];

  it.each(cases)("fires %s", (checkId, config, env, load) => {
    expect(ids(config, env, load)).toContain(checkId);
  });

  it("verifier-unbuildable fires for absent and strategyless auth (every account is register-hop)", () => {
    for (const auth of [undefined, {}]) {
      const config = cfg({ ...(auth === undefined ? {} : { auth }), dmSecurity: "allowlist" });
      const finding = evaluateWebchannelDoctor(config, { env: {}, loadPersistedEnrolledCreds: () => persisted }).find((item) => item.checkId === "verifier-unbuildable");
      expect(finding?.message).toContain("auth.strategy is required (jwt)");
    }
  });

  it("normalizes issuer slashes but requires byte-identical audiences for shared-audience", () => {
    const findings = evaluateWebchannelDoctor(cfg({
      dmSecurity: "allowlist",
      accounts: {
        a: { auth: validAuth("shared") },
        b: { auth: { strategy: "jwt", jwt: { issuer: "https://issuer/", audience: "shared", jwks: { keys: [] } } } },
        c: { auth: { strategy: "jwt", jwt: { issuer: "https://issuer/", audience: "shared/", jwks: { keys: [] } } } },
      },
    }), { env: {}, loadPersistedEnrolledCreds: () => persisted });
    const shared = findings.filter((finding) => finding.checkId === "shared-audience");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.accountId).toBe("b");
    expect(shared[0]?.message).toMatch(/a and b/);
  });

  it("collects a shared-audience claim before rejecting an invalid verifier", () => {
    const findings = evaluateWebchannelDoctor(cfg({
      dmSecurity: "allowlist",
      accounts: {
        invalid: { auth: { strategy: "jwt", jwt: { issuer: "https://issuer", audience: "shared", jwks: { keys: [] }, jwksUrl: "https://issuer/keys" } } },
        valid: { auth: validAuth("shared") },
      },
    }), { env: {}, loadPersistedEnrolledCreds: () => persisted });
    expect(findings.find((finding) => finding.checkId === "verifier-unbuildable")?.accountId).toBe("invalid");
    expect(findings.find((finding) => finding.checkId === "shared-audience")?.message).toMatch(/invalid and valid/);
  });

  it("reports a static creds config as credential-source-invalid (BYO-NATS pending P0-3)", () => {
    const config = cfg({ auth: validAuth("default"), nats: { credentials: { mode: "static", credsFile: "/account.creds" } }, dmSecurity: "allowlist" });
    const finding = evaluateWebchannelDoctor(config, { env: {}, loadPersistedEnrolledCreds: () => persisted }).find((f) => f.checkId === "credential-source-invalid");
    expect(finding?.message).toMatch(/static NATS credentials/);
  });

  it("stays quiet on orphaned-default with accounts.default and for tenant/saas-only shared bases", () => {
    const withDefault = cfg({ auth: validAuth("shared"), accounts: { default: {}, named: {} }, dmSecurity: "allowlist" });
    const sharedBase = cfg({ tenant: "t", saas: { baseUrl: "https://saas" }, accounts: { named: {} }, dmSecurity: "allowlist" });
    expect(ids(withDefault)).not.toContain("orphaned-default");
    expect(ids(sharedBase)).not.toContain("orphaned-default");
  });

  it("is latch-free across consecutive evaluations for deprecated-acquisition-env", () => {
    const config = cfg({ auth: validAuth("default"), dmSecurity: "allowlist" });
    for (let i = 0; i < 2; i += 1) {
      expect(ids(config, { WEBCHANNEL_TENANT: "old" })).toContain("deprecated-acquisition-env");
    }
  });

  it("keeps healthy compatibility fixtures at zero findings", () => {
    const fixtures = [
      cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }),
      cfg({ auth: validAuth("default"), nats: { admission: "register-hop" }, dmSecurity: "allowlist" }),
      cfg({ auth: validAuth("default"), nats: { url: "ws://relay" }, dmSecurity: "allowlist" }),
      cfg({ auth: { strategy: "jwt", jwt: { issuer: "https://issuer", audience: "default", jwksUrl: "https://issuer/keys" } }, dmSecurity: "allowlist" }),
    ];
    for (const fixture of fixtures) expect(evaluateWebchannelDoctor(fixture, { env: {}, loadPersistedEnrolledCreds: () => persisted })).toEqual([]);
  });

  it("formats the account, check, message, and actionable fix", () => {
    const warning = formatDoctorWarning({ accountId: "a", checkId: "creds-missing", kind: "auth", severity: "error", message: "missing", fix: "enroll" });
    expect(warning).toBe("- channels.webchannel.a: ERROR [creds-missing] missing Fix: enroll");
  });
});

describe("status probe", () => {
  it("probes inline effective JWKS plus relay and returns success", async () => {
    const dial = vi.fn(async () => ({ ok: true as const }));
    const result = await probeWebchannelAccount({ account: { accountId: "default" }, timeoutMs: 50, cfg: cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }) }, { env: {}, loadCreds: () => persisted, dial });
    expect(result).toMatchObject({ ok: true, admission: "register-hop", jwks: { source: "inline", keyCount: 0 }, relay: { ok: true } });
    expect(dial).toHaveBeenCalledWith(expect.objectContaining({ subject: "webchannel.default-tenant.default._doctor" }));
  });

  it("probes the effective file and URL JWKS sources through injected seams", async () => {
    const dial = vi.fn(async () => ({ ok: true as const }));
    const file = await probeWebchannelAccount({ account: { accountId: "default" }, timeoutMs: 50, cfg: cfg({ auth: { strategy: "jwt", jwt: { issuer: "i", audience: "default", jwksFile: "/keys.json" } }, dmSecurity: "allowlist" }) }, { env: {}, loadCreds: () => persisted, dial, readFile: () => JSON.stringify({ keys: [{ kty: "RSA" }] }) });
    expect(file.jwks).toEqual({ source: "file", keyCount: 1 });

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ keys: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const url = await probeWebchannelAccount({ account: { accountId: "default" }, timeoutMs: 50, cfg: cfg({ auth: { strategy: "jwt", jwt: { issuer: "i", audience: "default", jwksUrl: "https://idp/keys" } }, dmSecurity: "allowlist" }) }, { env: {}, loadCreds: () => persisted, dial, fetchImpl });
    expect(url.jwks).toEqual({ source: "url", keyCount: 0 });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("is fail-soft on dial failure and timeout-shaped errors", async () => {
    const result = await probeWebchannelAccount({ account: { accountId: "default" }, timeoutMs: 1, cfg: cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }) }, { env: {}, loadCreds: () => persisted, dial: async () => ({ error: "relay dial timed out" }) });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });

  it("never starts enrollment when enrolled credentials are missing", async () => {
    const deviceFlow = vi.fn();
    const dial = vi.fn(async () => { deviceFlow(); return { ok: true as const }; });
    const result = await probeWebchannelAccount({ account: { accountId: "default" }, timeoutMs: 10, cfg: cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }) }, { env: {}, loadCreds: () => undefined, dial });
    expect(result.ok).toBe(false);
    expect(dial).not.toHaveBeenCalled();
    expect(deviceFlow).not.toHaveBeenCalled();
  });

  it("collects lastError and defensively attached failed probes only", () => {
    const status = createWebchannelStatusAdapter();
    expect(status.collectStatusIssues?.([{ accountId: "a" }])).toEqual([]);
    const issues = status.collectStatusIssues?.([
      { accountId: "a", lastError: "offline" },
      { accountId: "b", probe: { ok: false, error: "jwks unreachable" } } as never,
    ]) ?? [];
    expect(issues.some((issue) => issue.accountId === "a")).toBe(true);
    expect(issues.some((issue) => issue.accountId === "b" && issue.kind === "auth")).toBe(true);
  });
});
