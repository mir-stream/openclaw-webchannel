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
  IGNORED_ACQUISITION_IDENTITY_ENV_KEYS,
} from "./acquisition-env.js";
import {
  hasWebchannelConfig,
  inspectWebchannelAccountIds,
  findRemovedAudiencePaths,
  isWebchannelAccountEnabled,
  listWebchannelAccountIds,
  loadPersistedCredentialDocument,
  RemovedAudienceConfigError,
} from "./account-config.js";
import { createMemoizedPersistedAccessor, prepareAccountAuth } from "./account-auth.js";
import type { AuthConfig, ResolvedJwtVerifierConfig } from "./auth.js";
import { resolveDialMaterial, type DialMaterial } from "./consume-credentials.js";
import { ConversationKeyStore } from "./conversation-key-store.js";
import { resolveEncryptionPolicy, type WebchannelEncryptionConfig } from "./encryption-policy.js";
import { JWKSCache, type JsonWebKeySet } from "./jwks.js";
import {
  type AccountPlanEntry,
  detectOrphanedDefault,
  planWebchannelAccount,
} from "./multiplex.js";
import type { WebchannelNatsConfig } from "./nats-credential-source.js";
import { resolveNatsCredentialSource } from "./nats-credential-source.js";
import { dialRelayForPreflight } from "./preflight.js";
import {
  formatCredentialInspection,
  type BoundCredentialLoadResult,
  type PersistedEnrolledCreds,
} from "./credential-document.js";
import {
  credentialStorageFailureDiagnostic,
  isVersionTooNew,
  StorageDocumentError,
} from "./storage-document.js";

export type DoctorCheckId =
  | "invalid-account-id"
  | "configuration-invalid"
  | "encryption-disabled"
  | "creds-missing"
  | "credential-binding-failed"
  | "credential-storage-failed"
  | "identity-key-missing"
  | "verifier-unbuildable"
  | "audience-override-removed"
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
  loadPersistedEnrolledCreds?: (
    scope: { tenant: string; accountId: string },
  ) => PersistedEnrolledCreds | undefined;
  readFile?: (path: string) => string;
};

const reEnrollFix = (accountId: string) =>
  `Run: openclaw channels add --channel webchannel --account ${accountId}`;

function futureConversationKeyDiagnostic(input: {
  tenant: string;
  accountId: string;
  storageRoot?: string;
}): ReturnType<typeof credentialStorageFailureDiagnostic> | undefined {
  try {
    new ConversationKeyStore(input).assertNoFutureDocuments();
    return undefined;
  } catch (error) {
    if (!isVersionTooNew(error)) throw error;
    return credentialStorageFailureDiagnostic(error);
  }
}

export function evaluateWebchannelDoctor(cfg: unknown, deps: DoctorDeps = {}): DoctorFinding[] {
  const env = deps.env ?? process.env;
  const injectedLoadCreds = deps.loadPersistedEnrolledCreds;
  const findings: DoctorFinding[] = [];
  const top = cfg as { nats?: { url?: string }; saas?: { baseUrl?: string } };

  const inspection = inspectWebchannelAccountIds(cfg);
  for (const invalid of inspection.invalid) {
    const fix =
      invalid.reasonKind === "normalized-collision"
        ? "Rename or remove configured account entries until their OpenClaw SDK-normalized account ids are unique, then rerun account setup/enrollment for each renamed account so credentials and JWT audience stay aligned."
        : "Rename the config key to match /^[A-Za-z0-9_-]{1,64}$/ (excluding __proto__, prototype, and constructor), then rerun account setup/enrollment so credentials and JWT audience stay aligned.";
    findings.push({
      accountId: invalid.id,
      checkId: "invalid-account-id",
      kind: "config",
      severity: "error",
      message:
        `Account key ${JSON.stringify(invalid.id)} is invalid (${invalid.reason}) and was not started.`,
      fix,
    });
  }

  const plans: AccountPlanEntry[] = [];
  for (const accountId of listWebchannelAccountIds(cfg)) {
    if (!isWebchannelAccountEnabled(cfg, accountId)) {
      const paths = findRemovedAudiencePaths(cfg, accountId);
      if (paths.length > 0) {
        findings.push({
          accountId,
          checkId: "audience-override-removed",
          kind: "config",
          severity: "warn",
          message: `Account is disabled and not serving, but removed config ${paths.join(", ")} must be deleted before re-enable.`,
          fix: "Delete auth.jwt.audience; JWT aud is always the runtime accountId.",
        });
      }
      continue;
    }
    try {
      const plan = planWebchannelAccount(cfg, accountId, { env, warn: () => {} });
      if (plan) plans.push(plan);
    } catch (err) {
      findings.push(err instanceof RemovedAudienceConfigError
        ? removedAudienceFinding(accountId, err, "error")
        : configurationInvalidFinding(accountId, err));
    }
  }

  for (const plan of plans) {
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
        ...(plan.storageRoot !== undefined
          ? { storageRoot: plan.storageRoot }
          : {}),
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
        persistedLoaded = true;
        persisted = injectedLoadCreds?.({ tenant, accountId });
      }
      return persisted;
    };

    if (source.mode === "enrolled") {
      let enrolled: PersistedEnrolledCreds | undefined;
      try {
        if (injectedLoadCreds) {
          enrolled = getPersisted();
        } else {
          const loaded = loadPersistedCredentialDocument({
            tenant,
            accountId,
            saasBaseUrl: source.saasBaseUrl,
          }, {
            ...(source.storageRoot !== undefined
              ? { storageRoot: source.storageRoot }
              : {}),
            ...(source.credentialPath !== undefined
              ? { credentialPath: source.credentialPath }
              : {}),
          });
          persistedLoaded = true;
          if (loaded.status === "match") {
            persisted = loaded.credentials;
            enrolled = persisted;
          } else if (loaded.status === "absent") {
            enrolled = undefined;
          } else {
            findings.push({
              accountId,
              checkId: "credential-binding-failed",
              kind: "auth",
              severity: "error",
              message:
                `Persisted enrollment material is not reusable ` +
                `(${formatCredentialInspection(loaded)}).`,
              fix:
                `Stop the gateway, archive the account credential file, complete any required ` +
                `SaaS active-key replacement, then ${reEnrollFix(accountId)}.`,
            });
            continue;
          }
        }
      } catch (err) {
        if (err instanceof StorageDocumentError) {
          const diagnostic = credentialStorageFailureDiagnostic(err);
          findings.push({
            accountId,
            checkId: "credential-storage-failed",
            kind: "auth",
            severity: "error",
            message: `${diagnostic.detail}.`,
            fix:
              err.code === "version-too-new"
                ? diagnostic.detail
                : "Stop all old WebChannel plugin processes for this account, inspect the " +
                  "recoverable legacy backup if present, then retry.",
          });
          continue;
        }
        findings.push(configurationInvalidFinding(accountId, err));
        continue;
      }
      if (!enrolled) {
        findings.push({
          accountId,
          checkId: "creds-missing",
          kind: "auth",
          severity: "error",
          message: `Effective credential mode=enrolled has no usable persisted credentials.`,
          fix: reEnrollFix(accountId),
        });
      }
      if (enrolled && !enrolled.identityKey) {
        findings.push({
          accountId,
          checkId: "identity-key-missing",
          kind: "auth",
          severity: "error",
          message: "The enrolled credentials carry no attested agent identity key; the account is skipped.",
          fix: `${reEnrollFix(accountId)} to mint an attested identity key.`,
        });
      }
    }

    // An injected credential reader is a complete persistence seam for doctor
    // tests/embedders. Production has no injection and inspects the real tuple,
    // matching runtime's non-mutating pre-publication compatibility gate.
    if (!injectedLoadCreds) {
      try {
        const diagnostic = futureConversationKeyDiagnostic({
          tenant,
          accountId,
          ...(plan.storageRoot !== undefined
            ? { storageRoot: plan.storageRoot }
            : {}),
        });
        if (diagnostic) {
          findings.push({
            accountId,
            checkId: "credential-storage-failed",
            kind: "auth",
            severity: "error",
            message: `${diagnostic.detail}.`,
            fix: diagnostic.detail,
          });
          continue;
        }
      } catch (err) {
        findings.push(configurationInvalidFinding(accountId, err));
        continue;
      }
    }

    try {
      prepareAccountAuth({
        plan,
        getPersisted,
        ...(source.mode === "enrolled"
          ? { effectiveSaasBaseUrl: source.saasBaseUrl }
          : {}),
        ...(top.saas?.baseUrl !== undefined ? { topLevelSaasBaseUrl: top.saas.baseUrl } : {}),
      });
    } catch (err) {
      findings.push({
        accountId,
        checkId: "verifier-unbuildable",
        kind: "config",
        severity: "error",
        message: errorMessage(err),
        fix: "Correct the effective JWT issuer and exactly-one JWKS source named above.",
      });
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
  const prefix = finding.checkId === "invalid-account-id"
    ? `channels.webchannel.accounts[${JSON.stringify(finding.accountId)}]`
    : `channels.webchannel.${finding.accountId}`;
  return `- ${prefix}: ${finding.severity.toUpperCase()} [${finding.checkId}] ${finding.message} Fix: ${finding.fix}`;
}

export function createWebchannelDoctorAdapter(deps: DoctorDeps = {}): ChannelDoctorAdapter {
  return {
    collectPreviewWarnings: ({ cfg, env }) => {
      try {
        return evaluateWebchannelDoctor(cfg, {
          ...deps,
          ...(env !== undefined ? { env } : {}),
        }).map(formatDoctorWarning);
      } catch (err) {
        return [
          `- channels.webchannel: ERROR [configuration-invalid] Could not inspect WebChannel configuration: ${errorMessage(err)} Fix: Correct the reported account/configuration or reconfigure it with openclaw channels add --channel webchannel.`,
        ];
      }
    },
  };
}

export type WebchannelProbe = BaseProbeResult & {
  accountId: string;
  admission: "register-hop";
  jwks?: { source: "url" | "file" | "inline"; keyCount: number } | { error: string };
  relay?: { ok: true } | { error: string };
};

export type ProbeDeps = {
  env?: Record<string, string | undefined>;
  loadCreds?: (
    scope: { tenant: string; accountId: string },
  ) => PersistedEnrolledCreds | undefined;
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
    if (!listWebchannelAccountIds(params.cfg).includes(accountId)) {
      throw new Error(`account ${accountId} is not configured`);
    }
    const plan = planWebchannelAccount(params.cfg, accountId, {
      env: deps.env,
      warn: () => {},
    });
    if (!plan) throw new Error(`account ${accountId} is not configured`);
    const top = params.cfg as unknown as { nats?: { url?: string }; saas?: { baseUrl?: string } };
    const nats = plan.account.nats as WebchannelNatsConfig | undefined;
    const source = resolveNatsCredentialSource({
      natsConfig: nats,
      legacyNats: top.nats,
      saasBaseUrl: plan.saasBaseUrl ?? top.saas?.baseUrl,
      tenant: plan.tenant,
      accountId,
      ...(plan.storageRoot !== undefined
        ? { storageRoot: plan.storageRoot }
        : {}),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
    });
    let credentialLoad: BoundCredentialLoadResult | undefined;
    if (source.mode === "enrolled") {
      if (deps.loadCreds) {
        const injected = deps.loadCreds({
          tenant: plan.tenant,
          accountId,
        });
        credentialLoad = injected
          ? {
              status: "match",
              document: {} as never,
              credentials: injected,
            }
          : { status: "absent" };
      } else {
        try {
          credentialLoad = loadPersistedCredentialDocument({
            tenant: plan.tenant,
            accountId,
            saasBaseUrl: source.saasBaseUrl,
          }, {
            ...(source.storageRoot !== undefined
              ? { storageRoot: source.storageRoot }
              : {}),
            ...(source.credentialPath !== undefined
              ? { credentialPath: source.credentialPath }
              : {}),
          });
        } catch (error) {
          if (error instanceof StorageDocumentError) {
            const diagnostic = credentialStorageFailureDiagnostic(error);
            return {
              ok: false,
              error: `${diagnostic.code}: ${diagnostic.detail}`,
              accountId,
              admission: "register-hop",
            };
          }
          throw error;
        }
      }
      if (credentialLoad.status !== "match") {
        return {
          ok: false,
          error: credentialLoad.status === "absent"
            ? `no enrolled credentials for ${accountId}`
            : formatCredentialInspection(credentialLoad),
          accountId,
          admission: "register-hop",
        };
      }
    }
    // `loadCreds` is a complete injected persistence seam. The production
    // adapter has no injection and checks the same tuple documents runtime
    // gates before publication, before any relay or JWKS network operation.
    if (!deps.loadCreds) {
      const diagnostic = futureConversationKeyDiagnostic({
        tenant: plan.tenant,
        accountId,
        ...(plan.storageRoot !== undefined
          ? { storageRoot: plan.storageRoot }
          : {}),
      });
      if (diagnostic) {
        return {
          ok: false,
          error: `${diagnostic.code}: ${diagnostic.detail}`,
          accountId,
          admission: "register-hop",
        };
      }
    }
    const getPersisted = createMemoizedPersistedAccessor(
      () => credentialLoad?.status === "match"
        ? credentialLoad.credentials
        : undefined,
    );
    let preparedAuth;
    try {
      preparedAuth = prepareAccountAuth({
        plan,
        getPersisted,
        ...(source.mode === "enrolled"
          ? { effectiveSaasBaseUrl: source.saasBaseUrl }
          : {}),
        ...(top.saas?.baseUrl !== undefined ? { topLevelSaasBaseUrl: top.saas.baseUrl } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        error: redactUrlSecrets(errorMessage(err)),
        accountId,
        admission: "register-hop",
      };
    }
    const dialMaterial = (deps.resolveDialMaterial ?? resolveDialMaterial)({
      natsConfig: nats,
      legacyNats: top.nats,
      saasBaseUrl: plan.saasBaseUrl ?? top.saas?.baseUrl,
      tenant: plan.tenant,
      accountId,
      ...(plan.storageRoot !== undefined
        ? { storageRoot: plan.storageRoot }
        : {}),
      ...(source.mode === "enrolled" && source.credentialPath !== undefined
        ? { credentialPath: source.credentialPath }
        : {}),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
      ...(credentialLoad ? { loadCreds: () => credentialLoad! } : {}),
    });
    // Register-hop is the only admission path; the probe reports it verbatim.
    const admission = "register-hop" as const;
    if (dialMaterial.status !== "ok") {
      return {
        ok: false,
        error: redactUrlSecrets(
          dialMaterial.status === "invalid"
            ? dialMaterial.error
            : `no enrolled credentials for ${accountId}`,
        ),
        accountId,
        admission,
      };
    }

    const relay = await probeRelay(dialMaterial, plan.tenant, accountId, params.timeoutMs, deps);
    let jwks: WebchannelProbe["jwks"];
    {
      try {
        jwks = await probeJwks(preparedAuth.auth, params.timeoutMs, deps);
      } catch (err) {
        jwks = { error: redactUrlSecrets(errorMessage(err)) };
      }
    }
    const errors = [
      "error" in relay ? `relay: ${relay.error}` : undefined,
      jwks && "error" in jwks ? `jwks: ${jwks.error}` : undefined,
      jwks && "keyCount" in jwks && jwks.keyCount === 0
        ? `jwks: ${jwks.source} source contains 0 keys`
        : undefined,
    ].filter((error): error is string => error !== undefined);
    return {
      ok: errors.length === 0,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      accountId,
      admission,
      ...(jwks !== undefined ? { jwks } : {}),
      relay,
    };
  } catch (err) {
    return {
      ok: false,
      error: redactUrlSecrets(errorMessage(err)),
      accountId,
      admission: "register-hop",
    };
  }
}

export function createWebchannelStatusAdapter(deps: ProbeDeps = {}): ChannelStatusAdapter<{ accountId: string | null }, WebchannelProbe> {
  return {
    probeAccount: (params) => probeWebchannelAccount(params, deps),
    collectStatusIssues: (accounts) => collectRuntimeStatusIssues(accounts),
  };
}

function collectRuntimeStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  const activeAccounts = accounts.filter(
    (snapshot) => snapshot.enabled !== false && snapshot.configured !== false,
  );
  for (const snapshot of activeAccounts) {
    const probe = (snapshot as unknown as { probe?: unknown }).probe;
    if (!isFailedProbe(probe)) continue;
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
    activeAccounts.filter((snapshot) => {
      const probe = (snapshot as unknown as { probe?: unknown }).probe;
      const lastError = typeof snapshot.lastError === "string"
        ? snapshot.lastError.trim()
        : "";
      return !(isFailedProbe(probe) && lastError === probe.error.trim());
    }),
  ));
  return issues;
}

async function probeRelay(material: Extract<DialMaterial, { status: "ok" }>, tenant: string, accountId: string, timeoutMs: number, deps: ProbeDeps): Promise<{ ok: true } | { error: string }> {
  const result = await (deps.dial ?? dialRelayForPreflight)({
    ...material.dial,
    subject: `webchannel.${tenant}.${accountId}.*.register`,
    timeoutMs,
  });
  return "error" in result
    ? { error: redactUrlSecrets(result.error) }
    : { ok: true };
}

async function probeJwks(auth: ResolvedJwtVerifierConfig, timeoutMs: number, deps: ProbeDeps): Promise<Exclude<WebchannelProbe["jwks"], undefined>> {
  const jwt = auth.jwt;
  if (jwt.jwksUrl !== undefined) {
    const cache = JWKSCache.create({ jwksUrl: jwt.jwksUrl }, { fetchTimeoutMs: timeoutMs, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) });
    return { source: "url", keyCount: (await cache.warm()).keys.length };
  }
  if (jwt.jwksFile !== undefined) {
    const contents = (deps.readFile ?? ((path) => readFileSync(path, "utf8")))(jwt.jwksFile);
    return {
      source: "file",
      keyCount: parseJwksDocument(JSON.parse(contents) as unknown).keys.length,
    };
  }
  return { source: "inline", keyCount: parseJwksDocument(jwt.jwks).keys.length };
}

function parseJwksDocument(value: unknown): JsonWebKeySet {
  if (!value || typeof value !== "object" || !Array.isArray((value as { keys?: unknown }).keys)) throw new Error("JWKS must be an object with a keys array");
  return value as JsonWebKeySet;
}

function isFailedProbe(value: unknown): value is { ok: false; error: string } {
  return !!value && typeof value === "object" && (value as { ok?: unknown }).ok === false && typeof (value as { error?: unknown }).error === "string";
}

const URL_IN_ERROR_RE = /\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi;
function redactUrlSecrets(value: string): string {
  return value.replace(URL_IN_ERROR_RE, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      url.username = "";
      url.password = "";
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return `${url.protocol}//${url.host}`;
    } catch {
      return "[redacted-url]";
    }
  });
}
function configurationInvalidFinding(accountId: string, err: unknown): DoctorFinding {
  return {
    accountId,
    checkId: "configuration-invalid",
    kind: "config",
    severity: "error",
    message: `Could not inspect configuration or persisted credentials for account ${JSON.stringify(accountId)}: ${errorMessage(err)}`,
    fix: "Correct the account id/configuration or credential-store readability, then rerun openclaw doctor or reconfigure WebChannel with a valid account value.",
  };
}
function removedAudienceFinding(
  accountId: string,
  err: RemovedAudienceConfigError,
  severity: "error" | "warn",
): DoctorFinding {
  return {
    accountId,
    checkId: "audience-override-removed",
    kind: "config",
    severity,
    message: err.message,
    fix: "Delete auth.jwt.audience; JWT aud is always the runtime accountId.",
  };
}
function errorMessage(err: unknown): string { return err instanceof Error ? err.message : String(err); }
