import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { assertValidAccountId, type PersistedEnrolledCreds } from "./account-config.js";
import { CONVERSATION_KEY_DOCUMENT_VERSION } from "./conversation-key-document.js";
import { CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION } from "./conversation-key-generations-document.js";
import { createCredentialIdentityForEnrollment } from "./credential-document.js";
import {
  createWebchannelDoctorAdapter,
  createWebchannelStatusAdapter,
  evaluateWebchannelDoctor,
  formatDoctorWarning,
  probeWebchannelAccount,
  type DoctorCheckId,
} from "./doctor.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { StorageDocumentError } from "./storage-document.js";
import { STORAGE_IDENTITY_VERSION } from "./storage-identity.js";
import { tupleStoragePaths } from "./storage-paths.js";

const cfg = (webchannel: Record<string, unknown>): OpenClawConfig => ({ channels: { webchannel } } as never);
const identityKey = { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) };
const persisted = {
  userJwt: "J",
  userSeed: "S",
  natsUrl: "wss://bound-relay.example",
  identityKey,
};
const validAuth = (_accountId = "a") => ({ strategy: "jwt", jwt: { issuer: "https://issuer", jwks: { keys: [{ kty: "RSA", kid: "test" }] } } });
const removedDevModeKey = ["dev", "Open"].join("");
const removedDevModeSetting = ["nats.", removedDevModeKey].join("");
const ids = (config: OpenClawConfig, env: Record<string, string | undefined> = {}, load: () => PersistedEnrolledCreds | undefined = () => persisted) =>
  evaluateWebchannelDoctor(config, { env, loadPersistedEnrolledCreds: load }).map((finding) => finding.checkId);

const FUTURE_FIXTURE_TENANT = "future-storage-tenant";
const FUTURE_FIXTURE_ACCOUNT = "default";
const FUTURE_FIXTURE_SAAS = "https://saas.example";

function futureTupleFixture(
  target: "key" | "generation",
): Readonly<{
  config: OpenClawConfig;
  storageRoot: string;
  targetPath: string;
  before: Buffer;
  cleanup: () => void;
}> {
  const storageRoot = mkdtempSync(join(tmpdir(), "webchannel-doctor-future-"));
  const paths = tupleStoragePaths({
    tenant: FUTURE_FIXTURE_TENANT,
    accountId: FUTURE_FIXTURE_ACCOUNT,
    storageRoot,
  });
  const pair = generateKeyPair();
  const publicKey = Buffer.from(pair.publicKey).toString("base64url");
  const credential = JSON.stringify({
    credentialIdentity: createCredentialIdentityForEnrollment({
      tenant: FUTURE_FIXTURE_TENANT,
      accountId: FUTURE_FIXTURE_ACCOUNT,
      saasBaseUrl: FUTURE_FIXTURE_SAAS,
      relayUrl: "wss://relay.example",
      agentPublicKey: publicKey,
    }),
    identityKey: {
      publicKey,
      privateKey: Buffer.from(pair.privateKey).toString("base64url"),
    },
    enrollment: {
      creds: { userJwt: "fixture-jwt-secret", userSeed: "fixture-seed-secret" },
      peerId: "fixture-peer-secret",
      jwksUrl: "https://issuer.example/jwks",
      bootstrapUrl: "https://saas.example/api/bootstrap",
      natsUrl: "wss://relay.example",
    },
    tenant: FUTURE_FIXTURE_TENANT,
    accountId: FUTURE_FIXTURE_ACCOUNT,
    saasEnrollUrl: `${FUTURE_FIXTURE_SAAS}/api/enroll`,
    saasPollUrl: `${FUTURE_FIXTURE_SAAS}/api/poll`,
  });
  const storageIdentity = {
    identityVersion: STORAGE_IDENTITY_VERSION + 1,
    storage: {
      tenant: FUTURE_FIXTURE_TENANT,
      accountId: FUTURE_FIXTURE_ACCOUNT,
    },
  };
  const serialized = JSON.stringify(
    target === "key"
      ? {
          version: CONVERSATION_KEY_DOCUMENT_VERSION,
          storageIdentity,
          keys: {},
          futurePayload: { keep: "opaque" },
        }
      : {
          version: CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION,
          storageIdentity,
          generations: {},
          futurePayload: { keep: "opaque" },
        },
    null,
    2,
  );
  const targetPath = target === "key"
    ? paths.conversationKeyPath
    : paths.conversationKeyGenerationsPath;
  mkdirSync(dirname(paths.credentialPath), { recursive: true, mode: 0o700 });
  writeFileSync(paths.credentialPath, credential, { mode: 0o600 });
  writeFileSync(targetPath, serialized, { mode: 0o600 });

  return Object.freeze({
    config: cfg({
      tenant: FUTURE_FIXTURE_TENANT,
      saas: { baseUrl: FUTURE_FIXTURE_SAAS },
      storageRoot,
      auth: {
        strategy: "jwt",
        jwt: {
          issuer: "https://issuer.example",
          jwksUrl: "https://issuer.example/jwks",
        },
      },
      dmSecurity: "allowlist",
    }),
    storageRoot,
    targetPath,
    before: readFileSync(targetPath),
    cleanup: () => rmSync(storageRoot, { recursive: true, force: true }),
  });
}

function expectFutureFixtureUntouched(
  fixture: ReturnType<typeof futureTupleFixture>,
): void {
  expect(readFileSync(fixture.targetPath).equals(fixture.before)).toBe(true);
  const name = basename(fixture.targetPath);
  expect(
    readdirSync(dirname(fixture.targetPath)).filter(
      (entry) => entry.startsWith(`${name}.`),
    ),
  ).toEqual([]);
}

describe("evaluateWebchannelDoctor findings", () => {
  const cases: Array<[DoctorCheckId, OpenClawConfig, Record<string, string | undefined>, () => PersistedEnrolledCreds | undefined]> = [
    ["encryption-disabled", cfg({ encryption: { mode: "disabled" }, auth: validAuth("default"), dmSecurity: "allowlist" }), {}, () => persisted],
    ["creds-missing", cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }), {}, () => undefined],
    ["identity-key-missing", cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }), {}, () => ({ userJwt: "J", userSeed: "S" })],
    ["verifier-unbuildable", cfg({ auth: { strategy: "jwt", jwt: { issuer: "", jwks: { keys: [] } } }, dmSecurity: "allowlist" }), {}, () => persisted],
    ["audience-override-removed", cfg({ auth: { strategy: "jwt", jwt: { issuer: "https://issuer", jwks: { keys: [] }, audience: "legacy" } }, dmSecurity: "allowlist" }), {}, () => persisted],
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

  it("allows healthy accounts to share one issuer/JWKS", () => {
    const findings = evaluateWebchannelDoctor(cfg({
      dmSecurity: "allowlist",
      accounts: {
        a: { auth: validAuth("shared") },
        b: { auth: { strategy: "jwt", jwt: { issuer: "https://issuer/", jwks: { keys: [] } } } },
        c: { auth: { strategy: "jwt", jwt: { issuer: "https://issuer/", jwks: { keys: [] } } } },
      },
    }), { env: {}, loadPersistedEnrolledCreds: () => persisted });
    expect(findings).not.toContainEqual(expect.objectContaining({ checkId: "audience-override-removed" }));
  });

  it("reports a disabled tombstone as non-serving warning only", () => {
    const findings = evaluateWebchannelDoctor(cfg({
      dmSecurity: "allowlist",
      accounts: {
        disabled: { enabled: false, auth: { strategy: "jwt", jwt: { audience: null } } },
        valid: { auth: validAuth("valid") },
      },
    }), { env: {}, loadPersistedEnrolledCreds: () => persisted });
    expect(findings).toContainEqual(expect.objectContaining({
      accountId: "disabled",
      checkId: "audience-override-removed",
      severity: "warn",
    }));
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

  it("C11 distinguishes ignored tenant env from the still-effective SaaS override", () => {
    const config = cfg({ dmSecurity: "allowlist" });
    const findings = evaluateWebchannelDoctor(config, {
      env: {
        WEBCHANNEL_TENANT: "old-tenant",
        WEBCHANNEL_SAAS_BASE_URL: "https://legacy-saas.example",
      },
      loadPersistedEnrolledCreds: () => persisted,
    }).filter((finding) => finding.checkId === "deprecated-acquisition-env");

    expect(findings).toHaveLength(2);
    expect(findings.find((finding) => finding.message.includes("WEBCHANNEL_TENANT"))?.message)
      .toContain("is ignored");
    const saas = findings.find((finding) => finding.message.includes("WEBCHANNEL_SAAS_BASE_URL"));
    expect(saas?.message).toContain("still effective");
    expect(saas?.message).toContain("2026-08-15");
  });

  it("does not diagnose acquisition env that is honored beside lifecycle metadata only", () => {
    const findings = evaluateWebchannelDoctor(cfg({ enabled: true }), {
      env: {
        WEBCHANNEL_TENANT: "legacy-tenant",
        WEBCHANNEL_SAAS_BASE_URL: "https://legacy-saas.example",
      },
      loadPersistedEnrolledCreds: () => persisted,
    });

    expect(
      findings.filter((finding) => finding.checkId === "deprecated-acquisition-env"),
    ).toEqual([]);
  });

  it("keeps healthy compatibility fixtures at zero findings", () => {
    const fixtures = [
      cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }),
      cfg({ auth: validAuth("default"), nats: { admission: "register-hop" }, dmSecurity: "allowlist" }),
      cfg({ auth: validAuth("default"), nats: { url: "ws://relay" }, dmSecurity: "allowlist" }),
      cfg({ auth: { strategy: "jwt", jwt: { issuer: "https://issuer", jwksUrl: "https://issuer/keys" } }, dmSecurity: "allowlist" }),
    ];
    for (const fixture of fixtures) expect(evaluateWebchannelDoctor(fixture, { env: {}, loadPersistedEnrolledCreds: () => persisted })).toEqual([]);
  });

  it("formats the account, check, message, and actionable fix", () => {
    const warning = formatDoctorWarning({ accountId: "a", checkId: "creds-missing", kind: "auth", severity: "error", message: "missing", fix: "enroll" });
    expect(warning).toBe("- channels.webchannel.a: ERROR [creds-missing] missing Fix: enroll");
  });

  it.each([
    ['auth.strategy="anonymous"', cfg({ auth: { strategy: "anonymous" } })],
    ['nats.admission="auto"', cfg({ nats: { admission: "auto" } })],
    [removedDevModeSetting, cfg({ nats: { [removedDevModeKey]: false } })],
    ['nats.credentials.mode="open"', cfg({ nats: { credentials: { mode: "open" } } })],
  ])("keeps the preview actionable for removed %s", async (setting, config) => {
    const adapter = createWebchannelDoctorAdapter({
      env: {},
      loadPersistedEnrolledCreds: () => persisted,
    });
    const warnings = await adapter.collectPreviewWarnings!({
      cfg: config,
      doctorFixCommand: "openclaw doctor --fix",
      env: {},
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[configuration-invalid]");
    expect(warnings[0]).toContain(setting);
    expect(warnings[0]).toContain("openclaw channels add --channel webchannel");
  });

  it("keeps the preview actionable for a malformed raw account key", async () => {
    const adapter = createWebchannelDoctorAdapter({ env: {} });
    const warnings = await adapter.collectPreviewWarnings!({
      cfg: cfg({ accounts: { "../bad": { auth: validAuth("../bad") } } }),
      doctorFixCommand: "openclaw doctor --fix",
      env: {},
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/invalid-account-id.*account key.*\.\.\/bad.*was not started/i);
  });

  it("gives normalized-collision victims collision-specific remediation (#135)", () => {
    const findings = evaluateWebchannelDoctor(cfg({
      accounts: {
        Acme: { auth: validAuth("Acme") },
        acme: { auth: validAuth("acme") },
      },
    }), { env: {} });

    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding).toMatchObject({
        checkId: "invalid-account-id",
        severity: "error",
      });
      expect(finding.message).toContain('normalized account id "acme"');
      expect(finding.fix).toMatch(/rename or remove.*SDK-normalized account ids are unique/i);
      expect(finding.fix).not.toContain("must match /^[A-Za-z0-9_-]{1,64}$/");
    }
  });

  it("retains regex remediation for a raw-format-invalid account key", () => {
    const finding = evaluateWebchannelDoctor(
      cfg({ accounts: { "../bad": {} } }),
      { env: {} },
    )[0];

    expect(finding).toMatchObject({
      accountId: "../bad",
      checkId: "invalid-account-id",
    });
    expect(finding?.fix).toContain("match /^[A-Za-z0-9_-]{1,64}$/");
    expect(finding?.fix).not.toContain("SDK-normalized");
  });

  it("isolates removed config planning failures and still diagnoses a sibling", async () => {
    const adapter = createWebchannelDoctorAdapter({
      env: {},
      loadPersistedEnrolledCreds: () => persisted,
    });
    const warnings = await adapter.collectPreviewWarnings!({
      cfg: cfg({
        accounts: {
          bad: { auth: { strategy: "anonymous" } },
          good: {
            auth: validAuth("good"),
            encryption: { mode: "disabled" },
          },
        },
      }),
      doctorFixCommand: "openclaw doctor --fix",
      env: {},
    });

    expect(warnings).toHaveLength(2);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/channels\.webchannel\.bad.*\[configuration-invalid\].*auth\.strategy="anonymous"/),
      expect.stringMatching(/channels\.webchannel\.good.*\[encryption-disabled\]/),
    ]));
    expect(warnings.every((warning) => warning.startsWith("- channels.webchannel."))).toBe(true);
  });

  it("keeps a throwing credential loader account-scoped", () => {
    const findings = evaluateWebchannelDoctor(
      cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }),
      {
        env: {},
        loadPersistedEnrolledCreds: () => { throw new Error("credential store unavailable"); },
      },
    );
    expect(findings).toEqual([
      expect.objectContaining({
        accountId: "default",
        checkId: "configuration-invalid",
        message: expect.stringContaining("credential store unavailable"),
      }),
    ]);
    expect(formatDoctorWarning(findings[0]!)).toMatch(
      /channels\.webchannel\.default.*\[configuration-invalid\]/,
    );
  });

  it("keeps future credential remediation free of contradictory re-enrollment advice", () => {
    const findings = evaluateWebchannelDoctor(
      cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }),
      {
        env: {},
        loadPersistedEnrolledCreds: () => {
          throw new StorageDocumentError("credentials", "version-too-new");
        },
      },
    );

    const finding = findings.find(
      (item) => item.checkId === "credential-storage-failed",
    );
    expect(finding).toMatchObject({
      accountId: "default",
      severity: "error",
      message: expect.stringContaining(
        "Run the plugin version that wrote it (or newer)",
      ),
      fix: expect.stringContaining(
        "Run the plugin version that wrote it (or newer)",
      ),
    });
    expect(`${finding?.message}\n${finding?.fix}`).not.toMatch(
      /archive|re-enroll|legacy backup|then retry/i,
    );
  });

  it.each([
    ["key", "conversation-keys"],
    ["generation", "conversation-key-generations"],
  ] as const)(
    "finds a future %s tuple document without changing or quarantining it",
    (target, document) => {
      const fixture = futureTupleFixture(target);
      try {
        const findings = evaluateWebchannelDoctor(fixture.config, { env: {} });
        const finding = findings.find(
          (candidate) => candidate.checkId === "credential-storage-failed",
        );

        expect(finding).toMatchObject({
          accountId: FUTURE_FIXTURE_ACCOUNT,
          severity: "error",
          message: expect.stringContaining(`${document} version-too-new`),
          fix: expect.stringContaining(
            "Run the plugin version that wrote it (or newer)",
          ),
        });
        expect(findings).not.toEqual([]);
        const diagnostic = `${finding?.message}\n${finding?.fix}`;
        for (const forbidden of [
          FUTURE_FIXTURE_TENANT,
          FUTURE_FIXTURE_ACCOUNT,
          fixture.storageRoot,
          fixture.targetPath,
          "fixture-jwt-secret",
          "fixture-seed-secret",
          "fixture-peer-secret",
        ]) {
          expect(diagnostic).not.toContain(forbidden);
        }
        expect(diagnostic).not.toMatch(/archive|re-enroll|legacy backup|then retry/i);
        expectFutureFixtureUntouched(fixture);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("isolates a malformed account credential path and still diagnoses its sibling", () => {
    const findings = evaluateWebchannelDoctor(cfg({
      accounts: {
        "../bad": { auth: validAuth("../bad") },
        good: {
          auth: validAuth("good"),
          encryption: { mode: "disabled" },
        },
      },
    }), {
      env: {},
      loadPersistedEnrolledCreds: (scope) => {
        assertValidAccountId(scope.accountId);
        return persisted;
      },
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: "../bad",
        checkId: "invalid-account-id",
        message: expect.stringMatching(/account key.*\.\.\/bad.*was not started/i),
      }),
      expect.objectContaining({
        accountId: "good",
        checkId: "encryption-disabled",
      }),
    ]));
  });

  it.each([42, "relative/state"])(
    "contains invalid storageRoot %j to its account while diagnosing siblings",
    (storageRoot) => {
      const findings = evaluateWebchannelDoctor(cfg({
        accounts: {
          bad: { storageRoot, auth: validAuth("bad") },
          good: {
            auth: validAuth("good"),
            encryption: { mode: "disabled" },
          },
        },
      }), {
        env: {},
        loadPersistedEnrolledCreds: () => persisted,
      });

      expect(findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          accountId: "bad",
          checkId: "configuration-invalid",
          message: expect.stringContaining("storageRoot"),
        }),
        expect.objectContaining({
          accountId: "good",
          checkId: "encryption-disabled",
        }),
      ]));
    },
  );
});

describe("status probe", () => {
  it.each([
    ["key", "conversation-keys"],
    ["generation", "conversation-key-generations"],
  ] as const)(
    "rejects a future %s tuple document before relay or JWKS I/O",
    async (target, document) => {
      const fixture = futureTupleFixture(target);
      const dial = vi.fn(async () => ({ ok: true as const }));
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ keys: [{ kty: "RSA" }] })),
      );
      try {
        const result = await probeWebchannelAccount(
          {
            account: { accountId: FUTURE_FIXTURE_ACCOUNT },
            timeoutMs: 50,
            cfg: fixture.config,
          },
          { env: {}, dial, fetchImpl },
        );

        expect(result).toMatchObject({
          ok: false,
          accountId: FUTURE_FIXTURE_ACCOUNT,
          admission: "register-hop",
          error: expect.stringContaining(`${document}-version-too-new`),
        });
        expect(result.error).toContain(
          "Run the plugin version that wrote it (or newer)",
        );
        for (const forbidden of [
          FUTURE_FIXTURE_TENANT,
          FUTURE_FIXTURE_ACCOUNT,
          fixture.storageRoot,
          fixture.targetPath,
          "fixture-jwt-secret",
          "fixture-seed-secret",
          "fixture-peer-secret",
        ]) {
          expect(result.error).not.toContain(forbidden);
        }
        expect(result.error).not.toMatch(/archive|re-enroll|legacy backup|then retry/i);
        expect(dial).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expectFutureFixtureUntouched(fixture);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("probes inline effective JWKS plus relay and returns success", async () => {
    const dial = vi.fn(async () => ({ ok: true as const }));
    const result = await probeWebchannelAccount({ account: { accountId: "default" }, timeoutMs: 50, cfg: cfg({ auth: validAuth("default"), dmSecurity: "allowlist" }) }, { env: {}, loadCreds: () => persisted, dial });
    expect(result).toMatchObject({ ok: true, admission: "register-hop", jwks: { source: "inline", keyCount: 1 }, relay: { ok: true } });
    expect(result.relay).toEqual({ ok: true });
    expect(dial).toHaveBeenCalledWith(expect.objectContaining({ subject: "webchannel.default-tenant.default.*.register" }));
  });

  it("probes a healthy target without planning an invalid sibling", async () => {
    const dial = vi.fn(async () => ({ ok: true as const }));
    const loadCreds = vi.fn(
      (_scope: { tenant: string; accountId: string }) => persisted,
    );
    const result = await probeWebchannelAccount(
      {
        account: { accountId: "good" },
        timeoutMs: 50,
        cfg: cfg({
          accounts: {
            bad: { auth: { strategy: "anonymous" } },
            good: { auth: validAuth("good"), dmSecurity: "allowlist" },
          },
        }),
      },
      { env: {}, loadCreds, dial },
    );

    expect(result).toMatchObject({
      ok: true,
      accountId: "good",
      jwks: { source: "inline", keyCount: 1 },
      relay: { ok: true },
    });
    expect(dial).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "webchannel.default-tenant.good.*.register" }),
    );
    expect(
      loadCreds.mock.calls.every(([scope]) => scope.accountId === "good"),
    ).toBe(true);
  });

  it("probes the effective file and URL JWKS sources through injected seams", async () => {
    const dial = vi.fn(async () => ({ ok: true as const }));
    const file = await probeWebchannelAccount({ account: { accountId: "default" }, timeoutMs: 50, cfg: cfg({ auth: { strategy: "jwt", jwt: { issuer: "i", jwksFile: "/keys.json" } }, dmSecurity: "allowlist" }) }, { env: {}, loadCreds: () => persisted, dial, readFile: () => JSON.stringify({ keys: [{ kty: "RSA" }] }) });
    expect(file.jwks).toEqual({ source: "file", keyCount: 1 });

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ keys: [{ kty: "RSA" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const url = await probeWebchannelAccount({ account: { accountId: "default" }, timeoutMs: 50, cfg: cfg({ auth: { strategy: "jwt", jwt: { issuer: "i", jwksUrl: "https://idp/keys" } }, dmSecurity: "allowlist" }) }, { env: {}, loadCreds: () => persisted, dial, fetchImpl });
    expect(url.jwks).toEqual({ source: "url", keyCount: 1 });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("rejects string-valued inline JWKS during structural preparation before relay I/O", async () => {
    const dial = vi.fn(async () => ({ ok: true as const }));
    const result = await probeWebchannelAccount(
      {
        account: { accountId: "named" },
        timeoutMs: 50,
        cfg: cfg({
          accounts: {
            named: {
              auth: {
                strategy: "jwt",
                jwt: {
                  issuer: "https://issuer",
                  jwks: JSON.stringify({ keys: [{ kty: "RSA", kid: "test" }] }),
                },
              },
            },
          },
        }),
      },
      { env: {}, loadCreds: () => persisted, dial },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/jwks must be an object with a keys array/i),
    });
    expect(dial).not.toHaveBeenCalled();
  });

  it("never returns relay URL credentials or URL-JWKS secrets in probe failures", async () => {
    const relayUrl = "wss://user:pass@relay.example/ws?access_token=topsecret#frag";
    const jwksUrl = "https://jwks-user:jwks-pass@idp.example/keys?api_key=jwks-topsecret#jwks-frag";
    const result = await probeWebchannelAccount(
      {
        account: { accountId: "default" },
        timeoutMs: 50,
        cfg: cfg({
          auth: {
            strategy: "jwt",
            jwt: { issuer: "i", jwksUrl },
          },
          dmSecurity: "allowlist",
        }),
      },
      {
        env: {},
        loadCreds: () => ({ ...persisted, natsUrl: relayUrl }),
        dial: async (input) => ({ error: `relay dial failed for ${input.url}` }),
        fetchImpl: async () => { throw new Error(`JWKS endpoint failed at ${jwksUrl}`); },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      relay: { error: expect.stringContaining("wss://relay.example") },
      jwks: { error: expect.stringContaining("https://idp.example") },
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "user",
      "pass",
      "access_token",
      "topsecret",
      "frag",
      "jwks-user",
      "jwks-pass",
      "api_key",
      "jwks-topsecret",
      "jwks-frag",
      "/ws",
      "/keys",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("fails clearly while preserving relay and structured JWKS facts for every empty source", async () => {
    const dial = vi.fn(async () => ({ ok: true as const }));
    const cases = [
      {
        source: "inline",
        auth: { strategy: "jwt", jwt: { issuer: "i", jwks: { keys: [] } } },
        deps: {},
      },
      {
        source: "file",
        auth: { strategy: "jwt", jwt: { issuer: "i", jwksFile: "/keys.json" } },
        deps: { readFile: () => JSON.stringify({ keys: [] }) },
      },
      {
        source: "url",
        auth: { strategy: "jwt", jwt: { issuer: "i", jwksUrl: "https://idp/keys" } },
        deps: { fetchImpl: async () => new Response(JSON.stringify({ keys: [] }), { status: 200, headers: { "content-type": "application/json" } }) },
      },
    ] as const;

    for (const fixture of cases) {
      const result = await probeWebchannelAccount(
        { account: { accountId: "default" }, timeoutMs: 50, cfg: cfg({ auth: fixture.auth, dmSecurity: "allowlist" }) },
        { env: {}, loadCreds: () => persisted, dial, ...fixture.deps },
      );
      expect(result).toMatchObject({
        ok: false,
        error: `jwks: ${fixture.source} source contains 0 keys`,
        jwks: { source: fixture.source, keyCount: 0 },
        relay: { ok: true },
      });
    }
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

  it("ignores disabled and unconfigured lifecycle rows but reports active failures", () => {
    const status = createWebchannelStatusAdapter();
    const inactiveIssues = status.collectStatusIssues?.([
      {
        accountId: "disabled",
        enabled: false,
        configured: true,
        lastError: "disabled",
        probe: { ok: false, error: "disabled" },
      } as never,
      {
        accountId: "unconfigured",
        enabled: true,
        configured: false,
        lastError: "not configured",
        probe: { ok: false, error: "not configured" },
      } as never,
    ]) ?? [];
    expect(inactiveIssues).toEqual([]);

    const activeIssues = status.collectStatusIssues?.([
      {
        accountId: "active",
        enabled: true,
        configured: true,
        lastError: "relay disconnected",
      },
    ]) ?? [];
    expect(activeIssues.map((issue) => issue.message)).toEqual([
      "Channel error: relay disconnected",
    ]);
  });

  it("keeps a distinct pre-existing lastError beside a failed probe for the same account", () => {
    const issues = createWebchannelStatusAdapter().collectStatusIssues?.([
      { accountId: "a", lastError: "relay disconnected", probe: { ok: false, error: "jwks unreachable" } } as never,
    ]) ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      "Webchannel probe failed: jwks unreachable",
      "Channel error: relay disconnected",
    ]);
  });

  it("deduplicates only the exact trimmed probe-derived lastError", () => {
    const issues = createWebchannelStatusAdapter().collectStatusIssues?.([
      { accountId: "a", lastError: "  jwks unreachable ", probe: { ok: false, error: " jwks unreachable  " } } as never,
    ]) ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      "Webchannel probe failed:  jwks unreachable  ",
    ]);
  });
});
