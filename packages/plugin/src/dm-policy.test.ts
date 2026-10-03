import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { createWebChannelPlugin } from "./channel.js";
import { resolveDmAdmission } from "./dm-allowlist.js";
import { enforceDmAdmission, resolveDmPolicy, validateDmConfig } from "./dm-allowlist.js";
import { evaluateWebchannelDoctor } from "./doctor.js";
import { resolveWebchannelAccountConfig } from "./account-config.js";
import { webchannelSetup } from "./setup.js";
import { vi } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const schema = buildJsonChannelConfigSchema(manifest.channelConfigs.webchannel.schema).runtime!;
const webchannelSection = (cfg: unknown): Record<string, unknown> =>
  ((cfg as { channels?: { webchannel?: Record<string, unknown> } }).channels?.webchannel ?? {});

describe("SDK DM policy contract (#406)", () => {
  it.each(["dmPolicy", "dmSecurity"])("disabled via %s rejects even an allowlisted/wildcard peer", (field) => {
    expect(resolveDmAdmission("alice", { [field]: "disabled", allowFrom: ["alice", "*"] }).allowed).toBe(false);
  });

  it("supports wildcard and channel-prefix entries without lowercasing peer IDs", () => {
    expect(resolveDmAdmission("alice", { dmSecurity: "allowlist", allowFrom: ["webchannel:alice"] }).allowed).toBe(true);
    expect(resolveDmAdmission("Alice", { dmSecurity: "allowlist", allowFrom: ["webchannel:alice"] }).allowed).toBe(false);
    expect(resolveDmAdmission("any", { dmSecurity: "allowlist", allowFrom: ["*"] }).allowed).toBe(true);
  });

  it.each([
    { dmPolicy: "disabled", allowFrom: ["alice"] },
    { dmPolicy: "pairing" },
    { dmPolicy: "open", allowFrom: ["*"] },
    { dmPolicy: "allowlist", allowFrom: ["webchannel:alice"] },
  ])("schema accepts canonical policy $dmPolicy", (config) => {
    expect(schema.safeParse(config).success).toBe(true);
  });

  it.each([
    { dmPolicy: "open" }, { dmPolicy: "open", allowFrom: ["alice"] },
    { dmPolicy: "allowlist", allowFrom: [] }, { dmPolicy: "allowlist", allowFrom: ["", "  "] },
    { dmPolicy: "public", allowFrom: ["*"] },
    { dmSecurity: "public" }, { dmSecurity: "unknown", allowFrom: ["*"] },
    { tenant: "t" }, { storageRoot: "/state" },
    { accounts: { a: { dmPolicy: "open" } } },
    { dmPolicy: "open", allowFrom: ["*"], accounts: { a: { allowFrom: ["alice"] } } },
    { dmPolicy: "allowlist", allowFrom: ["alice"], accounts: { a: { dmPolicy: "open" } } },
  ])("schema rejects inconsistent effective policy %j", (config) => {
    expect(schema.safeParse(config).success).toBe(false);
  });

  it.each([
    { allowFrom: ["*"] },
    { dmSecurity: " PUBLIC ", allowFrom: ["*"] },
    { allowFrom: ["*"], accounts: { a: {} } },
    { dmPolicy: "allowlist", allowFrom: ["alice"], accounts: { a: {}, b: { dmPolicy: "disabled" } } },
    { accounts: { a: { dmPolicy: "pairing" }, b: { dmPolicy: "allowlist", allowFrom: ["bob"] } } },
  ])("schema accepts inherited/legacy policies %j", (config) => {
    expect(schema.safeParse(config).success).toBe(true);
  });

  it.each([
    { config: { dmPolicy: "allowlist", allowFrom: ["webchannel:  "] }, accountId: "default" },
    { config: { accounts: { a: { dmPolicy: "allowlist", allowFrom: [" WebChannel: \t"] } } }, accountId: "a" },
    { config: { dmPolicy: "allowlist", allowFrom: ["webchannel:  "], accounts: { a: { tenant: "t" } } }, accountId: "a" },
  ])("rejects an effectively empty normalized allowlist in flat/named/inherited config %#", ({ config, accountId }) => {
    expect(schema.safeParse(config).success).toBe(false);
    const cfg = { channels: { webchannel: config } } as never;
    expect(() => validateDmConfig(resolveWebchannelAccountConfig(cfg, accountId))).toThrow(/at least one allowFrom/);
  });

  it.each([
    { enabled: false, accounts: { a: { tenant: "t" } } },
    { enabled: false, accounts: { a: { dmPolicy: "allowlist", allowFrom: [] } } },
  ])("schema skips effective DM cross-validation when the channel is disabled %j", (config) => {
    expect(schema.safeParse(config).success).toBe(true);
  });

  it("reports the open default and real flat/named audit fix paths", () => {
    const plugin = createWebChannelPlugin({} as never);
    for (const named of [false, true]) {
      const leaf = { allowFrom: ["*"] };
      const cfg = { channels: { webchannel: named ? { accounts: { a: leaf } } : leaf } } as never;
      const accountId = named ? "a" : "default";
      const account = plugin.config.resolveAccount(cfg, accountId);
      const policy = plugin.security!.resolveDmPolicy!({ cfg, accountId, account });
      const base = named ? "channels.webchannel.accounts.a" : "channels.webchannel";
      expect(policy).toMatchObject({ policy: "open", allowFrom: ["*"], policyPath: `${base}.dmPolicy`, allowFromPath: `${base}.` });
      expect(`${policy!.allowFromPath}allowFrom`).toBe(`${base}.allowFrom`);
    }
  });

  it("reports independent inherited audit paths for policy and allowFrom", () => {
    const plugin = createWebChannelPlugin({} as never);
    const cfg = { channels: { webchannel: {
      dmPolicy: "allowlist", accounts: { a: { allowFrom: ["alice"] } },
    } } } as never;
    const account = plugin.config.resolveAccount(cfg, "a");
    const policy = plugin.security!.resolveDmPolicy!({ cfg, accountId: "a", account });
    expect(policy).toMatchObject({
      policy: "allowlist",
      policyPath: "channels.webchannel.dmPolicy",
      allowFromPath: "channels.webchannel.accounts.a.",
    });
    expect(`${policy!.allowFromPath}allowFrom`).toBe("channels.webchannel.accounts.a.allowFrom");
  });

  it.each([
    { accountId: "default", webchannel: { dmPolicy: "disabled", allowFrom: ["*"] }, policy: "disabled", allowFrom: ["*"] },
    { accountId: "a", webchannel: { dmPolicy: "allowlist", allowFrom: ["WebChannel:Alice"], accounts: { a: { tenant: "t" } } }, policy: "allowlist", allowFrom: ["Alice"] },
    { accountId: "a", webchannel: { dmPolicy: "disabled", accounts: { a: { dmSecurity: "pairing", allowFrom: ["webchannel:Bob"] } } }, policy: "pairing", allowFrom: ["Bob"] },
    { accountId: "a", webchannel: { dmPolicy: "allowlist", allowFrom: ["root"], accounts: { a: { dmPolicy: "open", allowFrom: ["*"] } } }, policy: "open", allowFrom: ["*"] },
  ])("audits effective $policy policy through the core inspectAccount snapshot path %#", ({ accountId, webchannel, policy, allowFrom }) => {
    const plugin = createWebChannelPlugin({} as never);
    const cfg = { channels: { webchannel } } as never;
    const inspected = plugin.config.inspectAccount!(cfg, accountId) as never;
    expect(plugin.security!.resolveDmPolicy!({ cfg, accountId, account: inspected })).toMatchObject({
      policy,
      allowFrom,
    });
  });

  it("lets an account-local legacy policy override the shared canonical policy", () => {
    const cfg = { channels: { webchannel: { dmPolicy: "disabled", allowFrom: ["*"], accounts: {
      a: { dmSecurity: "open" }, b: { dmPolicy: "allowlist", allowFrom: ["webchannel:bob"] },
    } } } };
    const account = resolveWebchannelAccountConfig(cfg, "a");
    expect(resolveDmPolicy(account)).toBe("open");
    expect(resolveDmAdmission("alice", account).allowed).toBe(true);
    expect(schema.safeParse(cfg.channels.webchannel).success).toBe(true);
    expect(() => validateDmConfig(resolveWebchannelAccountConfig(cfg, "b"))).not.toThrow();

    const plugin = createWebChannelPlugin({} as never);
    const resolved = plugin.config.resolveAccount(cfg as never, "a");
    const auditPolicy = plugin.security!.resolveDmPolicy!({ cfg: cfg as never, accountId: "a", account: resolved });
    expect(auditPolicy).toMatchObject({ policy: "open", policyPath: "channels.webchannel.accounts.a.dmPolicy" });
    const fixed = { channels: { webchannel: { ...cfg.channels.webchannel, accounts: {
      ...cfg.channels.webchannel.accounts,
      a: { ...cfg.channels.webchannel.accounts.a, dmPolicy: "disabled" },
    } } } };
    expect(resolveDmPolicy(resolveWebchannelAccountConfig(fixed, "a"))).toBe("disabled");
  });

  it("doctor reports legacy spellings and a missing open wildcard", () => {
    const findings = evaluateWebchannelDoctor({ channels: { webchannel: {
      tenant: "t", dmSecurity: "PUBLIC", auth: { strategy: "jwt", jwt: { issuer: "issuer", jwks: { keys: [] } } },
    } } }, { env: {}, loadPersistedEnrolledCreds: () => undefined });
    expect(findings).toContainEqual(expect.objectContaining({ checkId: "dm-policy-invalid", severity: "error" }));
    expect(findings).toContainEqual(expect.objectContaining({ checkId: "legacy-dm-security", fix: expect.stringContaining('dmPolicy="open"') }));
  });

  it("doctor derives legacy migration from the alias while preserving a same-layer canonical policy", () => {
    const inherited = evaluateWebchannelDoctor({ channels: { webchannel: {
      tenant: "t", dmSecurity: "disabled", allowFrom: ["*"], accounts: {
        a: { dmPolicy: "open" }, b: {},
      },
    } } }, { env: {}, loadPersistedEnrolledCreds: () => undefined });
    for (const accountId of ["a", "b"]) {
      expect(inherited).toContainEqual(expect.objectContaining({
        accountId,
        checkId: "legacy-dm-security",
        fix: expect.stringContaining('otherwise replace dmSecurity with dmPolicy="disabled"'),
      }));
    }

    const sameLayer = evaluateWebchannelDoctor({ channels: { webchannel: {
      tenant: "t", dmSecurity: "disabled", dmPolicy: "open", allowFrom: ["*"],
    } } }, { env: {}, loadPersistedEnrolledCreds: () => undefined });
    expect(sameLayer).toContainEqual(expect.objectContaining({
      checkId: "legacy-dm-security",
      fix: expect.stringContaining("preserve it and remove only dmSecurity"),
    }));
  });

  it.each(["disabled", "allowlist", "pairing"] as const)("setup preserves an existing legacy %s policy", (dmSecurity) => {
    const cfg = { channels: { webchannel: { dmSecurity, allowFrom: ["alice"] } } } as never;
    const next = webchannelSetup.applyAccountConfig!({ cfg, accountId: "default", input: { saasBaseUrl: "https://saas.example", tenant: "t" } });
    const account = resolveWebchannelAccountConfig(next, "default");
    expect(account.dmPolicy).toBe(dmSecurity);
    expect(account.allowFrom).toEqual(["alice"]);
  });

  it.each(["default", "work"])("partial setup seeds valid DM defaults for a fresh %s account", (accountId) => {
    const next = webchannelSetup.applyAccountConfig!({ cfg: {} as never, accountId, input: { tenant: "t" } });
    const section = webchannelSection(next);
    expect(schema.safeParse(section).success).toBe(true);
    expect(resolveWebchannelAccountConfig(next, accountId)).toMatchObject({
      tenant: "t", dmPolicy: "open", allowFrom: ["*"],
    });
  });

  it("partial setup preserves existing and inherited restrictive DM configuration", () => {
    const existing = { channels: { webchannel: { accounts: {
      a: { dmPolicy: "allowlist", allowFrom: ["alice"] },
    } } } } as never;
    const updated = webchannelSetup.applyAccountConfig!({ cfg: existing, accountId: "a", input: { tenant: "t" } });
    expect(resolveWebchannelAccountConfig(updated, "a")).toMatchObject({
      tenant: "t", dmPolicy: "allowlist", allowFrom: ["alice"],
    });

    const existingEmpty = { channels: { webchannel: { accounts: { a: {} } } } } as never;
    const unchanged = webchannelSetup.applyAccountConfig!({ cfg: existingEmpty, accountId: "a", input: { tenant: "t" } });
    expect((webchannelSection(unchanged).accounts as Record<string, unknown>).a).toEqual({ tenant: "t" });

    const inherited = { channels: { webchannel: { dmPolicy: "disabled", accounts: { other: {} } } } } as never;
    const added = webchannelSetup.applyAccountConfig!({ cfg: inherited, accountId: "work", input: { tenant: "t" } });
    expect((webchannelSection(added).accounts as Record<string, unknown>).work).toEqual({ tenant: "t" });
    expect(resolveWebchannelAccountConfig(added, "work").dmPolicy).toBe("disabled");
    expect(schema.safeParse(webchannelSection(added)).success).toBe(true);
  });

  it("partial credentials-only setup seeds DM defaults for a fresh account", () => {
    const next = webchannelSetup.applyAccountConfig!({ cfg: {} as never, accountId: "work", input: { credentialsMode: "static" } });
    expect(resolveWebchannelAccountConfig(next, "work")).toMatchObject({
      dmPolicy: "open", allowFrom: ["*"], nats: { credentials: { mode: "static" } },
    });
    expect(schema.safeParse(webchannelSection(next)).success).toBe(true);
  });
});

describe("SDK pairing policy (#406)", () => {
  it("creates an account-scoped challenge and admits the peer only after approval", async () => {
    const readStore = vi.fn().mockResolvedValue([]);
    const upsertPairingRequest = vi.fn().mockResolvedValue({ code: "PAIR1234", created: true });
    const sendPairingReply = vi.fn().mockResolvedValue(undefined);
    const input = { peerId: "alice", accountId: "a", config: { dmPolicy: "pairing" as const }, readStore, upsertPairingRequest, sendPairingReply };
    expect(await enforceDmAdmission(input)).toMatchObject({ allowed: false, reason: "pairing-required" });
    expect(readStore).toHaveBeenCalledWith("webchannel", process.env, "a");
    expect(upsertPairingRequest).toHaveBeenCalledWith(expect.objectContaining({ channel: "webchannel", accountId: "a", id: "alice" }));
    expect(sendPairingReply).toHaveBeenCalledWith(expect.stringContaining("PAIR1234"));
    readStore.mockResolvedValue(["webchannel:alice"]);
    expect((await enforceDmAdmission(input)).allowed).toBe(true);
    expect(upsertPairingRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "allowlist", "open"] as const)("%s never reads pairing approvals", async (dmPolicy) => {
    const readStore = vi.fn().mockResolvedValue(["alice"]);
    const admission = await enforceDmAdmission({ peerId: "alice", accountId: "a", config: { dmPolicy, allowFrom: ["bob"] }, readStore, sendPairingReply: vi.fn() });
    expect(admission.allowed).toBe(false);
    expect(readStore).not.toHaveBeenCalled();
  });
});
