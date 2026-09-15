import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  resolveAcquisitionIdentity,
  resolveAccountNatsConfig,
  resolveDefaultWebchannelAccountId,
  resolveWebchannelAccountId,
  resolveWebchannelAccountConfig,
  isWebchannelAccountEnabled,
} from "./account-config.js";
import { createNatsWebChannelPlugin } from "./nats-account-runtime.js";
import { createWebchannelDoctorAdapter, createWebchannelStatusAdapter } from "./doctor.js";
import { planWebchannelAccount } from "./multiplex.js";
import { resolveAcquisitionEnvPrecedence } from "./acquisition-env.js";
import { webchannelSetup } from "./setup.js";
import { webchannelSetupWizard } from "./setup-wizard.js";
import { createCredentialIdentityForEnrollment } from "./credential-document.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { tupleStoragePaths } from "./storage-paths.js";

const config = (webchannel: Record<string, unknown>): OpenClawConfig => ({
  channels: { webchannel },
});

describe("account read and diagnostic surfaces (#378)", () => {
  const cfg = config({
    defaultAccount: "acme",
    allowFrom: ["shared"],
    accounts: {
      default: { tenant: "tenant-default" },
      Acme: { tenant: "tenant-acme", allowFrom: ["acme-peer"], enabled: false },
    },
  });

  it("reads core's canonical alias using the listed config and identity", () => {
    const plugin = createNatsWebChannelPlugin(new Map());
    const alias = normalizeAccountId("Acme");
    expect(resolveWebchannelAccountConfig(cfg, alias)).toMatchObject({
      tenant: "tenant-acme", allowFrom: ["acme-peer"],
    });
    expect(plugin.config.resolveAccount(cfg, alias)).toMatchObject({
      accountId: "Acme", enabled: false, allowFrom: ["acme-peer"],
    });
    expect(plugin.config.inspectAccount!(cfg, alias)).toMatchObject({
      configured: true, enabled: false,
    });
  });

  it("carries the listed acquisition identity through canonical lookup", () => {
    expect(resolveAcquisitionIdentity(cfg, normalizeAccountId("Acme"))).toMatchObject({
      accountId: "Acme", tenant: "tenant-acme",
    });
  });

  it("delivers an invalid explicit-default warning through the doctor adapter", async () => {
    const warnings = await createWebchannelDoctorAdapter({
      loadPersistedEnrolledCreds: () => undefined,
    }).collectPreviewWarnings!({ cfg, env: {}, doctorFixCommand: "openclaw doctor --fix" });
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/defaultAccount.*acme.*fallback.*"default"/),
    ]));
  });

  it.each([undefined, null, "", " \t "])("uses the listed preference across reads for %j", (input) => {
    const cfg = config({ defaultAccount: "Beta", tenant: "shared", accounts: {
      default: { tenant: "default-tenant" },
      Beta: { tenant: "beta-tenant", nats: { url: "wss://beta.example" } },
    } });
    const plugin = createNatsWebChannelPlugin(new Map());
    expect(resolveWebchannelAccountId(cfg, input)).toBe("Beta");
    expect(resolveWebchannelAccountConfig(cfg, input).tenant).toBe("beta-tenant");
    expect(resolveAccountNatsConfig(cfg, input)?.url).toBe("wss://beta.example");
    expect(isWebchannelAccountEnabled(cfg, input)).toBe(true);
    expect(plugin.config.resolveAccount(cfg, input).accountId).toBe("Beta");
    expect(plugin.config.inspectAccount!(cfg, input)).toMatchObject({ accountId: "Beta", configured: true });
    expect(resolveAcquisitionIdentity(cfg, input)).toMatchObject({ accountId: "Beta", tenant: "beta-tenant" });
    expect(resolveAcquisitionEnvPrecedence(cfg, input, { env: {} }).identity).toMatchObject({ accountId: "Beta", tenant: "beta-tenant" });
    expect(planWebchannelAccount(cfg, input, { env: {} })).toMatchObject({ accountId: "Beta", tenant: "beta-tenant" });
  });

  it.each(["Acme", "-Acme", "_Acme", "ACME-"])("preserves listed identity %s using the actual public SDK alias", (listed) => {
    const cfg = config({ accounts: { [listed]: { tenant: "listed-tenant" } } });
    const alias = normalizeAccountId(listed);
    expect(resolveWebchannelAccountId(cfg, alias)).toBe(listed);
    expect(resolveAcquisitionIdentity(cfg, alias)).toMatchObject({ accountId: listed, tenant: "listed-tenant" });
    expect(planWebchannelAccount(cfg, alias, { env: {} })?.accountId).toBe(listed);
  });

  it.each(["missing", "!!!", "a.b", "constructor", "__proto__", "prototype", "a".repeat(65), "-"])(
    "refuses explicit unknown/nonconforming %j before any identity or probe I/O",
    async (input) => {
      const cfg = config({ tenant: "shared", accounts: { default: {}, "a-b": {} } });
      const plugin = createNatsWebChannelPlugin(new Map());
      expect(resolveWebchannelAccountId(cfg, input)).toBeUndefined();
      expect(resolveWebchannelAccountConfig(cfg, input)).toEqual({});
      expect(resolveAccountNatsConfig(cfg, input)).toBeUndefined();
      expect(isWebchannelAccountEnabled(cfg, input)).toBe(false);
      expect(plugin.config.resolveAccount(cfg, input)).toMatchObject({ accountId: input, enabled: false, allowFrom: [] });
      expect(plugin.config.inspectAccount!(cfg, input)).toMatchObject({ configured: false, enabled: false });
      expect(() => resolveAcquisitionIdentity(cfg, input)).toThrow(/valid listed account/);
      expect(() => resolveAcquisitionEnvPrecedence(cfg, input, { env: {} })).toThrow(/valid listed account/);
      expect(planWebchannelAccount(cfg, input, { env: {} })).toBeUndefined();
      const loadCreds = vi.fn();
      const dial = vi.fn();
      const probe = await createWebchannelStatusAdapter({ loadCreds, dial }).probeAccount!({
        cfg, account: { accountId: input }, timeoutMs: 50,
      });
      expect(probe).toMatchObject({ accountId: input, ok: false });
      expect(loadCreds).not.toHaveBeenCalled();
      expect(dial).not.toHaveBeenCalled();
    },
  );

  it.each([{ ids: ["Acme", "acme"] }, { ids: ["a.b", "a-b"] }, { ids: ["default", "-"] }])("never bypasses the collision gate for $ids", ({ ids }) => {
    const cfg = config({ accounts: Object.fromEntries(ids.map((id) => [id, { tenant: id }])) });
    for (const id of [...ids, normalizeAccountId(ids[0]), null, ""]) {
      expect(resolveWebchannelAccountId(cfg, id)).toBeUndefined();
      expect(resolveWebchannelAccountConfig(cfg, id)).toEqual({});
      expect(isWebchannelAccountEnabled(cfg, id)).toBe(false);
      expect(planWebchannelAccount(cfg, id, { env: {} })).toBeUndefined();
    }
  });

  it("re-reads changes in the same config object without losing disabled or exact identity", () => {
    const accounts: Record<string, Record<string, unknown>> = {
      Acme: { tenant: "first", enabled: false }, Beta: { tenant: "beta" },
    };
    const cfg = config({ defaultAccount: "Acme", accounts });
    expect(isWebchannelAccountEnabled(cfg, "acme")).toBe(false);
    expect(planWebchannelAccount(cfg, "acme", { env: {} })).toBeUndefined();
    accounts.Acme = { tenant: "second", enabled: true };
    expect(planWebchannelAccount(cfg, "acme", { env: {} })).toMatchObject({ accountId: "Acme", tenant: "second" });
    accounts.acme = { tenant: "collision" };
    expect(planWebchannelAccount(cfg, "Acme", { env: {} })).toBeUndefined();
    expect(resolveDefaultWebchannelAccountId(cfg)).toBe("Beta");
    delete accounts.Acme;
    expect(resolveAcquisitionIdentity(cfg, "Acme")).toMatchObject({ accountId: "acme", tenant: "collision" });
    delete accounts.acme;
    expect(resolveWebchannelAccountId(cfg, "Acme")).toBeUndefined();
  });

  it("keeps the implicit flat identity and refuses arbitrary identities in config-less mode", () => {
    for (const input of [null, undefined, "", "DEFAULT"]) {
      expect(resolveAcquisitionEnvPrecedence({}, input, { env: { WEBCHANNEL_TENANT: "env-tenant" } }).identity)
        .toMatchObject({ accountId: "default", tenant: "env-tenant" });
    }
    expect(() => resolveAcquisitionEnvPrecedence({}, "missing", { env: {} })).toThrow(/valid listed account/);
  });

  it("applies removed-config checks to the resolved listed planner account", () => {
    const cfg = config({ accounts: { Acme: { auth: { jwt: { audience: "old" } } } } });
    expect(() => planWebchannelAccount(cfg, "acme", { env: {} })).toThrow(/accounts.Acme.auth.jwt.audience/);
  });

  it("keeps new setup targets on shared base without copying a canonical sibling's overrides", () => {
    const cfg = config({ tenant: "base-tenant", auth: { jwt: { issuer: "https://base.example" } }, accounts: {
      Acme: { tenant: "private-tenant", auth: { jwt: { issuer: "https://private.example" } } },
    } });
    const before = structuredClone(cfg);
    for (const target of ["acme", "new-account"]) {
      const written = webchannelSetup.applyAccountConfig({ cfg, accountId: target, input: { saasBaseUrl: "https://saas.example" } });
      const accounts = (written.channels!.webchannel as { accounts: Record<string, unknown> }).accounts;
      expect(accounts[target]).toMatchObject({ tenant: "base-tenant", auth: { jwt: { issuer: "https://base.example" } } });
      expect(accounts.Acme).toEqual((cfg.channels!.webchannel as { accounts: Record<string, unknown> }).accounts.Acme);
    }
    expect(cfg).toEqual(before);
  });

  it("uses listed identity for wizard readiness and status lines", () => {
    const cfg = config({ accounts: { Acme: { tenant: "acme-tenant", auth: { jwt: {} }, nats: { credentials: { mode: "static" } } } } });
    expect(webchannelSetupWizard.status.resolveConfigured({ cfg, accountId: "acme" })).toBe(true);
    expect(webchannelSetupWizard.status.resolveStatusLines!({ cfg, accountId: "acme", configured: true }))
      .toEqual([expect.stringContaining("WebChannel (Acme): configured — tenant=acme-tenant")]);
  });

  it("reads only the listed credential namespace for status/wizard and preserves the stored document", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "webchannel-account-lookup-"));
    const scope = { tenant: "acme-tenant", accountId: "Acme", storageRoot };
    const path = tupleStoragePaths(scope).credentialPath;
    const aliasPath = tupleStoragePaths({ ...scope, accountId: "acme" }).credentialPath;
    const pair = generateKeyPair();
    const publicKey = Buffer.from(pair.publicKey).toString("base64url");
    const saasBaseUrl = "https://saas.example";
    const contents = JSON.stringify({
      credentialIdentity: createCredentialIdentityForEnrollment({
        tenant: scope.tenant, accountId: scope.accountId, saasBaseUrl,
        relayUrl: "wss://relay.example", agentPublicKey: publicKey,
      }),
      identityKey: { publicKey, privateKey: Buffer.from(pair.privateKey).toString("base64url") },
      enrollment: { creds: { userJwt: "fixture-jwt", userSeed: "fixture-seed" },
        peerId: "peer", jwksUrl: "https://keys.example", bootstrapUrl: "https://bootstrap.example", natsUrl: "wss://relay.example" },
      tenant: scope.tenant, accountId: scope.accountId,
      saasEnrollUrl: `${saasBaseUrl}/api/enroll`, saasPollUrl: `${saasBaseUrl}/api/poll`,
    });
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: 0o600 });
      const cfg = config({ defaultAccount: "Acme", accounts: { Acme: {
        tenant: scope.tenant, storageRoot, saas: { baseUrl: saasBaseUrl },
        auth: { strategy: "jwt", jwt: { issuer: "https://issuer.example", jwks: { keys: [{ kty: "RSA", kid: "fixture" }] } } },
      } } });
      const dial = vi.fn(async () => ({ ok: true as const }));
      const adapter = createWebchannelStatusAdapter({ env: {}, dial });
      for (const input of ["acme", " ACME ", null, ""]) {
        expect(await adapter.probeAccount!({ cfg, account: { accountId: input }, timeoutMs: 50 }))
          .toMatchObject({ accountId: "Acme", ok: true });
      }
      expect(dial).toHaveBeenCalledTimes(4);
      for (const [call] of dial.mock.calls as unknown as Array<[{ subject: string }]>) {
        expect(call.subject).toBe("webchannel.acme-tenant.Acme.*.register");
      }
      expect(webchannelSetupWizard.status.resolveConfigured({ cfg, accountId: "acme" })).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(existsSync(aliasPath)).toBe(false);
      // A credential in the caller's lowercase namespace cannot replace a
      // missing document belonging to the configured exact account.
      rmSync(path);
      mkdirSync(dirname(aliasPath), { recursive: true });
      writeFileSync(aliasPath, contents, { mode: 0o600 });
      dial.mockClear();
      expect(await adapter.probeAccount!({ cfg, account: { accountId: "acme" }, timeoutMs: 50 }))
        .toMatchObject({ accountId: "Acme", ok: false, error: "no enrolled credentials for Acme" });
      expect(webchannelSetupWizard.status.resolveConfigured({ cfg, accountId: "acme" })).toBe(false);
      expect(dial).not.toHaveBeenCalled();
      expect(existsSync(path)).toBe(false);
      expect(readFileSync(aliasPath, "utf8")).toBe(contents);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});

describe("invalid configured-default diagnostics (#378)", () => {
  const doctor = createWebchannelDoctorAdapter({ loadPersistedEnrolledCreds: () => undefined, env: {} });
  const warnings = async (section: Record<string, unknown>) =>
    (await doctor.collectPreviewWarnings!({ cfg: config(section), env: {}, doctorFixCommand: "openclaw doctor --fix" }))
      .filter((line) => line.includes("[invalid-default-account]"));

  it.each([
    { section: { accounts: { Acme: {} }, defaultAccount: "acme" }, fallback: "Acme" },
    { section: { accounts: { Acme: {}, default: {} }, defaultAccount: "acme" }, fallback: "default" },
    { section: { accounts: { Zulu: {}, Beta: {} }, defaultAccount: "missing" }, fallback: "Beta" },
    { section: { tenant: "flat", defaultAccount: "missing" }, fallback: "default" },
    { section: { defaultAccount: "missing" }, fallback: "default" },
    { section: { accounts: { default: {} }, defaultAccount: "" }, fallback: "default" },
    { section: { accounts: { Acme: {} }, defaultAccount: " \t " }, fallback: "Acme" },
    { section: { accounts: { Acme: {} }, defaultAccount: null }, fallback: "Acme" },
    { section: { accounts: { Acme: {} }, defaultAccount: 42 }, fallback: "Acme" },
    { section: { accounts: { "bad.id": {}, Good: {} }, defaultAccount: "bad.id" }, fallback: "Good" },
  ])("identifies invalid preference and selected fallback $fallback for $section", async ({ section, fallback }) => {
    const lines = await warnings(section);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Configured defaultAccount ${JSON.stringify(section.defaultAccount)}`);
    expect(lines[0]).toContain(`selected fallback is "${fallback}"`);
    expect(lines[0]).toContain("selection does not imply that it is running");
    expect(lines[0]).toContain("Set channels.webchannel.defaultAccount to an exact listed id");
    expect(resolveDefaultWebchannelAccountId(config(section))).toBe(fallback);
  });

  it.each([{ "bad.id": {} }, { Acme: {}, acme: {} }])("reports no fallback can start for all-invalid accounts %j", async (accounts) => {
    const lines = await warnings({ accounts, defaultAccount: "Acme" });
    expect(lines).toEqual([expect.stringContaining("no fallback account can start")]);
    expect(lines[0]).not.toContain("selected fallback is");
    expect(lines[0]).toContain("Correct the invalid/colliding account entries");
  });

  it.each([false, true])("reports a disabled selection without choosing another account (global disable=%s)", async (globalDisable) => {
    const section = { enabled: !globalDisable, defaultAccount: "missing", accounts: {
      Alpha: { enabled: false }, Beta: { enabled: true },
    } };
    expect(await warnings(section)).toEqual([expect.stringContaining('selected fallback is "Alpha", which is disabled and will not serve')]);
    expect(resolveWebchannelAccountId(config(section))).toBe("Alpha");
  });

  it("updates warnings on repeated calls and stays quiet for absent or valid preferences", async () => {
    const section: Record<string, unknown> = { accounts: { Acme: {}, Beta: {} } };
    expect(await warnings(section)).toEqual([]);
    section.defaultAccount = "acme";
    expect(await warnings(section)).toHaveLength(1);
    section.defaultAccount = " Acme ";
    expect(await warnings(section)).toEqual([]);
    section.defaultAccount = "typo\nvalue";
    const lines = await warnings(section);
    expect(lines[0]).toContain('"typo\\nvalue"');
    expect(lines[0]).not.toContain("typo\nvalue");
    delete section.defaultAccount;
    expect(await warnings(section)).toEqual([]);
    expect(await warnings({ tenant: "flat", defaultAccount: "default" })).toEqual([]);
  });
});
