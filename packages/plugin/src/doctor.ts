import { readFileSync } from "node:fs";

import type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelDoctorAdapter,
  ChannelStatusAdapter,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { collectStatusIssuesFromLastError } from "openclaw/plugin-sdk/status-helpers";

import {
  EFFECTIVE_DEPRECATED_ACQUISITION_ENV_KEYS,
  hasWebchannelConfig,
  IGNORED_ACQUISITION_IDENTITY_ENV_KEYS,
} from "./acquisition-env.js";
import {
  loadPersistedEnrolledCreds,
  type PersistedEnrolledCreds,
} from "./account-config.js";
import { resolveEffectiveAccountAuth } from "./account-auth.js";
import type { AuthConfig, JwtAuthConfig } from "./auth.js";
import { validateJwtVerifierConfig, validateVerifierConfig } from "./auth.js";
import { resolveDialMaterial, type DialMaterial } from "./consume-credentials.js";
import { resolveEncryptionPolicy, type WebchannelEncryptionConfig } from "./encryption-policy.js";
import { JWKSCache, type JsonWebKeySet } from "./jwks.js";
import { detectOrphanedDefault, planAccounts } from "./multiplex.js";
import type { WebchannelNatsConfig } from "./nats-credential-source.js";
import { resolveNatsCredentialSource } from "./nats-credential-source.js";
import { dialRelayForPreflight } from "./preflight.js";

export type DoctorCheckId =
  | "encryption-disabled"
  | "creds-missing"
  | "identity-key-missing"
  | "verifier-unbuildable"
  | "shared-audience"
  | "obsolete-cors"
  | "credential-source-invalid"
  | "orphaned-default"
  | "deprecated-acquisition-env";

export type DoctorFinding = {
  accountId: string;
  checkId: DoctorCheckId;
  kind: ChannelStatusIssue["kind"];
  severity: "error" | "warn";
  message: string;
  fix: string;
};

export type DoctorDeps = {
  env?: Record<string, string | undefined>;
  loadPersistedEnrolledCreds?: (accountId: string) => PersistedEnrolledCreds | undefined;
  readFile?: (path: string) => string;
};

const reEnrollFix = (accountId: string) =>
  `Run: openclaw channels add --channel webchannel --account ${accountId}`;

export function evaluateWebchannelDoctor(cfg: unknown, deps: DoctorDeps = {}): DoctorFinding[] {
  const env = deps.env ?? process.env;
  const loadCreds = deps.loadPersistedEnrolledCreds ?? loadPersistedEnrolledCreds;
  const findings: DoctorFinding[] = [];
  const claims = new Map<string, string>();
  const top = cfg as { nats?: { url?: string }; saas?: { baseUrl?: string } };

  for (const plan of planAccounts(cfg, { env, warn: () => {} })) {
    const { accountId, account, tenant } = plan;
    const nats = account.nats as WebchannelNatsConfig | undefined;
    try {
      resolveEncryptionPolicy(account.encryption as WebchannelEncryptionConfig | undefined);
    } catch (err) {
      findings.push({
        accountId,
        checkId: "encryption-disabled",
        kind: "config",
        severity: "error",
        message: `E2E encryption is disabled: ${errorMessage(err)}`,
        fix: "Remove the encryption.mode override — the NATS channel is encrypt-by-construction.",
      });
    }

    const rawAuth = account.auth as (AuthConfig & { cors?: unknown }) | undefined;
    if (rawAuth && typeof rawAuth === "object" && "cors" in rawAuth) {
      findings.push({
        accountId,
        checkId: "obsolete-cors",
        kind: "config",
        severity: "warn",
        message: "auth.cors is present but ignored because registration moved to NATS.",
        fix: "Delete the auth.cors block; access control is enforced by NATS credentials.",
      });
    }

    let source: ReturnType<typeof resolveNatsCredentialSource>;
    try {
      source = resolveNatsCredentialSource({
        natsConfig: nats,
        legacyNats: top.nats,
        saasBaseUrl: plan.saasBaseUrl ?? top.saas?.baseUrl,
        tenant,
        accountId,
        env,
        ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
      });
    } catch (err) {
      findings.push({
        accountId,
        checkId: "credential-source-invalid",
        kind: "config",
        severity: "error",
        message: errorMessage(err),
        fix: `Correct the named NATS credential field or file for account ${accountId}.`,
      });
      continue;
    }

    let persisted: PersistedEnrolledCreds | undefined;
    let persistedLoaded = false;
    const getPersisted = () => {
      if (!persistedLoaded) {
        persisted = loadCreds(accountId);
        persistedLoaded = true;
      }
      return persisted;
    };

    if (source.mode === "enrolled" && !getPersisted()) {
      findings.push({
        accountId,
        checkId: "creds-missing",
        kind: "auth",
        severity: "error",
        message: `Effective credential mode=enrolled has no usable persisted credentials.`,
        fix: reEnrollFix(accountId),
      });
    }
    if (source.mode === "enrolled" && getPersisted() && !getPersisted()?.identityKey) {
      findings.push({
        accountId,
        checkId: "identity-key-missing",
        kind: "auth",
        severity: "error",
        message: "The enrolled credentials carry no attested agent identity key; the account is skipped.",
        fix: `${reEnrollFix(accountId)} to mint an attested identity key.`,
      });
    }

    // Register-hop is the ONLY admission path (auto-admission was removed), so
    // every served account is verified against `channels.webchannel.auth` — the
    // serving loop calls `assertJwtAuthConfig(accountAuth)` unconditionally and
    // skips the account when it throws. Mirror that with the cache-free validator.
    {
      const effective = resolveEffectiveAccountAuth({
        accountAuthRaw: rawAuth,
        accountId,
        ...(plan.saasBaseUrl !== undefined ? { planSaasBaseUrl: plan.saasBaseUrl } : {}),
        ...(top.saas?.baseUrl !== undefined ? { topLevelSaasBaseUrl: top.saas.baseUrl } : {}),
        loadCreds: () => getPersisted(),
      });
      if (effective?.strategy === "jwt") {
        const issuer = effective.jwt.issuer;
        const audience = effective.jwt.audience;
        if (typeof issuer === "string" && issuer.length > 0 && typeof audience === "string" && audience.length > 0) {
          const key = `${normalizeSlash(issuer)}\u0000${audience}`;
          const other = claims.get(key);
          if (other !== undefined) {
            const message = `Register-hop accounts ${other} and ${accountId} share effective issuer=${issuer} and audience=${audience}.`;
            findings.push({
              accountId,
              checkId: "shared-audience",
              kind: "config",
              severity: "error",
              message,
              fix: `Give each register-hop account a distinct audience (normally its accountId); update ${other} and ${accountId}.`,
            });
          } else {
            claims.set(key, accountId);
          }
        }
      }
      try {
        validateVerifierConfig(effective);
      } catch (err) {
        findings.push({
          accountId,
          checkId: "verifier-unbuildable",
          kind: "config",
          severity: "error",
          message: errorMessage(err),
          fix: "Correct the effective auth strategy and jwt issuer, audience, and exactly-one JWKS source named above.",
        });
      }
    }
  }

  if (detectOrphanedDefault(cfg)) {
    findings.push({
      accountId: "default",
      checkId: "orphaned-default",
      kind: "config",
      severity: "warn",
      message: "Channel-level auth/nats exists beside named accounts, but accounts.default is absent; the default account is not served.",
      fix: "Move the intended default account fields under accounts.default.",
    });
  }
  const ignoredDeprecated = hasWebchannelConfig(cfg)
    ? IGNORED_ACQUISITION_IDENTITY_ENV_KEYS.filter((key) => env[key] !== undefined)
    : [];
  if (ignoredDeprecated.length > 0) {
    findings.push({
      accountId: "default",
      checkId: "deprecated-acquisition-env",
      kind: "config",
      severity: "warn",
      message: `Deprecated acquisition env is ignored because channels.webchannel config is authoritative: ${ignoredDeprecated.join(", ")}.`,
      fix: `Unset ${ignoredDeprecated.join(", ")} and use openclaw channels add for account configuration.`,
    });
  }
  const effectiveDeprecated = hasWebchannelConfig(cfg)
    ? EFFECTIVE_DEPRECATED_ACQUISITION_ENV_KEYS.filter((key) => env[key] !== undefined)
    : [];
  if (effectiveDeprecated.length > 0) {
    findings.push({
      accountId: "default",
      checkId: "deprecated-acquisition-env",
      kind: "config",
      severity: "warn",
      message: `Deprecated acquisition env is still effective and overrides configured SaaS settings: ${effectiveDeprecated.join(", ")}. Support will be removed after 2026-08-15.`,
      fix: `Move ${effectiveDeprecated.join(", ")} to channels.webchannel configuration, then unset it.`,
    });
  }
  return findings;
}

export function formatDoctorWarning(finding: DoctorFinding): string {
  return `- channels.webchannel.${finding.accountId}: ${finding.severity.toUpperCase()} [${finding.checkId}] ${finding.message} Fix: ${finding.fix}`;
}

export function createWebchannelDoctorAdapter(deps: DoctorDeps = {}): ChannelDoctorAdapter {
  return {
    collectPreviewWarnings: ({ cfg, env }) =>
      evaluateWebchannelDoctor(cfg, {
        ...deps,
        ...(env !== undefined ? { env } : {}),
      }).map(formatDoctorWarning),
  };
}

export type WebchannelProbe = BaseProbeResult & {
  accountId: string;
  admission: "register-hop";
  jwks?: { source: "url" | "file" | "inline"; keyCount: number } | { error: string };
  relay?: { ok: true; url: string } | { error: string };
};

export type ProbeDeps = {
  env?: Record<string, string | undefined>;
  loadCreds?: (accountId: string) => PersistedEnrolledCreds | undefined;
  readFile?: (path: string) => string;
  fetchImpl?: typeof fetch;
  resolveDialMaterial?: typeof resolveDialMaterial;
  dial?: typeof dialRelayForPreflight;
};

export async function probeWebchannelAccount(params: {
  account: { accountId: string | null };
  timeoutMs: number;
  cfg: OpenClawConfig;
}, deps: ProbeDeps = {}): Promise<WebchannelProbe> {
  const accountId = params.account.accountId ?? "default";
  try {
    const plan = planAccounts(params.cfg, { env: deps.env, warn: () => {} }).find((entry) => entry.accountId === accountId);
    if (!plan) throw new Error(`account ${accountId} is not configured`);
    const top = params.cfg as unknown as { nats?: { url?: string }; saas?: { baseUrl?: string } };
    const nats = plan.account.nats as WebchannelNatsConfig | undefined;
    const dialMaterial = (deps.resolveDialMaterial ?? resolveDialMaterial)({
      natsConfig: nats,
      legacyNats: top.nats,
      saasBaseUrl: plan.saasBaseUrl ?? top.saas?.baseUrl,
      tenant: plan.tenant,
      accountId,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
      ...(deps.loadCreds !== undefined ? { loadCreds: deps.loadCreds } : {}),
    });
    // Register-hop is the only admission path; the probe reports it verbatim.
    const admission = "register-hop" as const;
    if (dialMaterial.status !== "ok") {
      return { ok: false, error: dialMaterial.status === "invalid" ? dialMaterial.error : `no enrolled credentials for ${accountId}`, accountId, admission };
    }

    const relay = await probeRelay(dialMaterial, plan.tenant, accountId, params.timeoutMs, deps);
    let jwks: WebchannelProbe["jwks"];
    {
      try {
        const effective = resolveEffectiveAccountAuth({
          accountAuthRaw: plan.account.auth as AuthConfig | undefined,
          accountId,
          ...(plan.saasBaseUrl !== undefined ? { planSaasBaseUrl: plan.saasBaseUrl } : {}),
          ...(top.saas?.baseUrl !== undefined ? { topLevelSaasBaseUrl: top.saas.baseUrl } : {}),
          ...(deps.loadCreds !== undefined ? { loadCreds: deps.loadCreds } : {}),
        });
        if (!effective || effective.strategy !== "jwt") throw new Error("effective JWT verifier config is missing");
        validateJwtVerifierConfig(effective);
        jwks = await probeJwks(effective, params.timeoutMs, deps);
      } catch (err) {
        jwks = { error: errorMessage(err) };
      }
    }
    const errors = ["error" in relay ? `relay: ${relay.error}` : undefined, jwks && "error" in jwks ? `jwks: ${jwks.error}` : undefined].filter(Boolean);
    return {
      ok: errors.length === 0,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      accountId,
      admission,
      ...(jwks !== undefined ? { jwks } : {}),
      relay,
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err), accountId, admission: "register-hop" };
  }
}

export function createWebchannelStatusAdapter(deps: ProbeDeps = {}): ChannelStatusAdapter<{ accountId: string | null }, WebchannelProbe> {
  return {
    probeAccount: (params) => probeWebchannelAccount(params, deps),
    collectStatusIssues: (accounts) => collectRuntimeStatusIssues(accounts),
  };
}

function collectRuntimeStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  const failedProbeAccounts = new Set<string>();
  const issues: ChannelStatusIssue[] = [];
  for (const snapshot of accounts) {
    const probe = (snapshot as unknown as { probe?: unknown }).probe;
    if (!isFailedProbe(probe)) continue;
    failedProbeAccounts.add(snapshot.accountId);
    issues.push({
      channel: "webchannel",
      accountId: snapshot.accountId,
      kind: /jwks|credential|auth/i.test(probe.error) ? "auth" : "runtime",
      message: `Webchannel probe failed: ${probe.error}`,
      fix: "Run openclaw doctor and correct the reported account auth or relay connectivity issue.",
    });
  }
  issues.push(...collectStatusIssuesFromLastError(
    "webchannel",
    accounts.filter((snapshot) => !failedProbeAccounts.has(snapshot.accountId)),
  ));
  return issues;
}

async function probeRelay(material: Extract<DialMaterial, { status: "ok" }>, tenant: string, accountId: string, timeoutMs: number, deps: ProbeDeps): Promise<{ ok: true; url: string } | { error: string }> {
  const result = await (deps.dial ?? dialRelayForPreflight)({
    ...material.dial,
    subject: `webchannel.${tenant}.${accountId}._doctor`,
    timeoutMs,
  });
  return "error" in result ? result : { ok: true, url: material.dial.url };
}

async function probeJwks(auth: JwtAuthConfig, timeoutMs: number, deps: ProbeDeps): Promise<Exclude<WebchannelProbe["jwks"], undefined>> {
  const jwt = auth.jwt;
  if (jwt.jwksUrl !== undefined) {
    const cache = JWKSCache.create({ jwksUrl: jwt.jwksUrl }, { fetchTimeoutMs: timeoutMs, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) });
    return { source: "url", keyCount: (await cache.warm()).keys.length };
  }
  if (jwt.jwksFile !== undefined) return { source: "file", keyCount: parseJwks((deps.readFile ?? ((path) => readFileSync(path, "utf8")))(jwt.jwksFile)).keys.length };
  return { source: "inline", keyCount: parseJwks(jwt.jwks).keys.length };
}

function parseJwks(value: unknown): JsonWebKeySet {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { keys?: unknown }).keys)) throw new Error("JWKS must be an object with a keys array");
  return parsed as JsonWebKeySet;
}

function isFailedProbe(value: unknown): value is { ok: false; error: string } {
  return !!value && typeof value === "object" && (value as { ok?: unknown }).ok === false && typeof (value as { error?: unknown }).error === "string";
}

function normalizeSlash(value: string): string { return value.replace(/\/+$/, ""); }
function errorMessage(err: unknown): string { return err instanceof Error ? err.message : String(err); }
