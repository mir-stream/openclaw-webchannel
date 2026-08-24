/**
 * WebChannel NATS per-account runtime and plugin definition.
 *
 * Key changes from original index.ts:
 * - NATS peer channel → NatsChannel
 * - Direct browser route → peer registration via NATS JWT verification
 * - Direct NATS pub/sub instead of WebSocket frame relay
 * - Multi-peer sessions preserved via peerId routing
 * - Approvals use NATS first-write-wins exactly-once
 */

import { fileURLToPath } from "node:url";

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { NatsChannel } from "./nats-channel.js";
import type { RegisterChannelSurface } from "./nats-channel.js";
import type { InboundWsMessage, NatsChannelCryptoOptions } from "./nats-channel.js";
import { ConversationKeyStore } from "./conversation-key-store.js";
import { createCapacityDiagnostics } from "./capacity-diagnostics.js";
import { resolveEncryptionPolicy } from "./encryption-policy.js";
import type { WebchannelEncryptionConfig } from "./encryption-policy.js";
import { createWebChannelPlugin } from "./channel.js";
import { nextMessageId } from "./message-adapter.js";
import {
  handleInboundMessage,
  startAgentLifecycleSubscription,
  stopAgentLifecycleSubscription,
} from "./inbound.js";
import {
  createSerializedInboundDispatcher,
  coalesceUserMessages,
  normalizeInboundUserMessage,
} from "./inbound-queue.js";
import type { CoalescedMemberIds, SerializedInboundDispatcher } from "./inbound-queue.js";
// #123: the control-lane ack warning interpolates a peer-supplied peer id and
// message id.
import { logSafe } from "./log-safe.js";
import {
  estimateRetainedMessageBytes,
  InboundRetentionBudget,
} from "./inbound-retention.js";
import type { RetentionSessionToken } from "./inbound-retention.js";
import {
  createBoundedInboundDebouncer,
  type BoundedInboundDebouncer,
} from "./bounded-inbound-debouncer.js";
import { getProcessIngressOutcomeStore } from "./ingress-outcome.js";
import { BoundedOverflowResolver } from "./inbound-overflow-resolver.js";
import { InboundPressureLogger } from "./inbound-pressure-log.js";
import { isControlLaneMessage, shouldDropBufferedInputOnStop } from "./control-lane.js";
import { resolveCommandGate } from "./command-gate.js";
import { resolveInboundDebounceMs } from "openclaw/plugin-sdk/reply-runtime";
import {
  CancelledInboundFallbackTombstones,
  createIngressOnFlush,
  recordCancelledInboundItems,
} from "./ingress-dedupe.js";
import {
  handleApprovalDecision,
  listPendingApprovalsForPeer,
  listResolvedApprovalsForPeer,
  ApprovalBindingMissingError,
} from "./approvals.js";
import type { ResolvedJwtVerifierConfig } from "./auth.js";
import { formatAccountReadiness, type JwksReadiness } from "./preflight.js";
import {
  createMemoizedPersistedAccessor,
  prepareAccountAuth,
} from "./account-auth.js";
import { PopChallengeStore } from "./pop-challenge.js";
import { handleRegisterRequest } from "./nats-register.js";
import {
  recent as historyRecent,
  pageBefore as historyPageBefore,
  resolveHistoryConfig,
  planHistoryFetch,
  runDetachedHistoryRead,
} from "./history.js";
import { createCommandCatalogProvider } from "./commands-catalog.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";
import { WEBCHANNEL_ID, type WebChannelPeerChannel } from "./channel-contract.js";
import {
  NatsConnectionClosedError,
  type NatsTransport,
} from "./nats-transport.js";
import type { EnrolledNatsConnection } from "./enrolled-nats-connection.js";
import {
  resolveNatsCredentialSource,
  type NatsCredentialSource,
  type WebchannelNatsConfig,
} from "./nats-credential-source.js";
import { consumeCredentialSource } from "./consume-credentials.js";
import {
  credentialInspectionCode,
  formatCredentialInspection,
  type BoundCredentialLoadResult,
} from "./credential-document.js";
import { planWebchannelAccount } from "./multiplex.js";
import {
  loadPersistedCredentialDocument,
  resolveTypingEnabled,
} from "./account-config.js";
import {
  credentialStorageFailureDiagnostic,
  isVersionTooNew,
  StorageDocumentError,
} from "./storage-document.js";
import type { KeyPair } from "./e2e-crypto.js";
import {
  NatsAccountRuntimeCoordinator,
  AccountRunFailure,
  AccountPermanentFailureReporter,
  AccountServingAggregateTracker,
  AccountStartupError,
  accountTransportStatusPatch,
  abortableDelay,
  attachAccountTransportListeners,
  classifyAccountStartupFailure,
  commitAccountPublication,
  createAttemptAbortScope,
  createAccountExecutionApi,
  formatRelayOrigin,
  fullJitterDelayMs,
  notifyAccountQuarantine,
  resolveAccountPublicationFailure,
  runAccountStartupLoop,
  resolvePrivateReadiness,
  selectPrimaryRuntime,
  shouldLogRetryAttempt,
  waitForAbort,
} from "./nats-account-coordinator.js";
import {
  formatAccountIdForLog,
  isWebchannelAccountEnabled,
  listWebchannelAccountIds,
} from "./account-config.js";

// In the published single-file bundle, import.meta.url is the URL of the
// dist/index-nats.js module the host actually evaluated. Keep this runtime
// self-report separate from build provenance: the live module names itself.
const LOADED_PLUGIN_BUNDLE_PATH = fileURLToPath(import.meta.url);

export {
  NatsAccountRuntimeCoordinator,
  AccountRunFailure,
  AccountPermanentFailureReporter,
  AccountStartupError,
  accountTransportStatusPatch,
  abortableDelay,
  attachAccountTransportListeners,
  AccountServingAggregateTracker,
  classifyAccountStartupFailure,
  commitAccountPublication,
  createAccountExecutionApi,
  createAttemptAbortScope,
  formatRelayOrigin,
  fullJitterDelayMs,
  notifyAccountQuarantine,
  resolveAccountPublicationFailure,
  runAccountStartupLoop,
  resolvePrivateReadiness,
  retryCeilingMs,
  selectPrimaryRuntime,
  shouldLogRetryAttempt,
  waitForAbort,
} from "./nats-account-coordinator.js";
export type {
  AccountAttemptContext,
  AccountAttemptOutcome,
  AttemptAbortScope,
  AccountStartupFailure,
  AccountStartupLoopOptions,
  DisposeReport,
  PrivateReadinessResult,
  ServingAggregateCategory,
  ServingAggregateTransition,
} from "./nats-account-coordinator.js";

// ---------------------------------------------------------------------------
// Global state — multi-account multiplex (가-1 Cycle 2)
// ---------------------------------------------------------------------------

/**
 * Per-account serving runtime. One `gateway run` builds ONE of these per
 * configured webchannel account (Phase 3 multiplex), each with its own NATS
 * connection, encrypted channel, tenant/accountId subject namespace, verifier,
 * and per-account config.
 *
 * Register admission now rides NATS: each register-hop account subscribes its
 * OWN `webchannel.{tenant}.{accountId}.*.register` subject, so the subject
 * namespace itself pins a request to this account — there is no cross-account
 * dispatch step (the old single HTTP route's aud→account map is gone). The
 * account's own verifier still enforces iss/aud, so a token whose aud does not
 * match this account fails verification.
 */
type AccountRuntime = {
  accountId: string;
  tenant: string;
  channel: NatsChannel;
  transport: NatsTransport;
  enrolled?: EnrolledNatsConnection;
  /** Immutable trust configuration used by this account-bound verifier. */
  auth: ResolvedJwtVerifierConfig;
  historyConfig: ReturnType<typeof resolveHistoryConfig>;
  sessionTokens: Map<string, RetentionSessionToken>;
  inboundDebouncer: BoundedInboundDebouncer<any>;
  inboundDispatcher: SerializedInboundDispatcher<any>;
  owner: object;
  dispose: () => Promise<import("./nats-account-coordinator.js").DisposeReport>;
};

/**
 * Top-level config blocks this entry reads that plugin-sdk's `OpenClawConfig`
 * does not model. The webchannel `channels add` wizard writes a shared `nats`/
 * `saas` base at the config root (the default account's identity base); the SDK
 * type only declares core keys, so `api.config` is narrowed once against this at
 * the point of use. Both fields (and their members) are optional — the runtime
 * already falls back to per-account config / acquisition env when absent.
 */
type WebchannelChannelConfig = {
  nats?: { url?: string };
  saas?: { baseUrl?: string };
};

/** accountId → runtime, built once per process (idempotent across re-warms). */
const accountRuntimes = new Map<string, AccountRuntime>();
/** One heap/failure-domain budget and outcome cache across every account. */
const processInboundRetention = new InboundRetentionBudget();
const processIngressOutcomes = getProcessIngressOutcomeStore();
const processCancelledInboundFallback = new CancelledInboundFallbackTombstones(
  (message) => console.warn(message),
);
const processOverflowResolver = new BoundedOverflowResolver({
  outcomeStore: processIngressOutcomes,
  sendAck: ({ accountId, peerId, id }) =>
    accountRuntimes.get(accountId)?.channel.sendAck(peerId, [id]) ?? false,
  sendRejected: ({ accountId, peerId, id }) =>
    accountRuntimes.get(accountId)?.channel.sendInboundRejected(peerId, [id]) ?? false,
  onCancelledRecovered: ({ accountId, key }) => {
    processCancelledInboundFallback.delete(key, accountId);
  },
});
const accountCoordinator = new NatsAccountRuntimeCoordinator();
const aggregateTracker = new AccountServingAggregateTracker();
const permanentFailureReporter = new AccountPermanentFailureReporter();
const reportedInvalidAccountIds = new Set<string>();

export function accountNeverServedStatusPatch(input: {
  restartPending: boolean;
  reconnectAttempts: number;
  lastError: string | null;
}): typeof input & { connected: undefined } {
  return { ...input, connected: undefined };
}

export function connectedPublishedAccountIds<T extends { transport: { connected: boolean } }>(
  runtimes: ReadonlyMap<string, T>,
): string[] {
  return [...runtimes.entries()]
    .filter(([accountId, runtime]) => runtimes.get(accountId) === runtime && runtime.transport.connected)
    .map(([accountId]) => accountId);
}

function reportServingAggregate(api: any): void {
  const expectedAccountIds = listWebchannelAccountIds(api.config)
    .filter((accountId) => isWebchannelAccountEnabled(api.config, accountId));
  aggregateTracker.update({
    generation: Number(api.generation ?? 0),
    expectedAccountIds,
    servingAccountIds: connectedPublishedAccountIds(accountRuntimes),
    logger: api.logger,
  });
}

/**
 * Lazy transport facade.
 *
 * `createWebChannelPlugin` needs a transport at module-load time, but in NATS
 * mode the real `NatsChannel` only exists after its account lifecycle commits.
 * This Proxy forwards every transport method call to the live
 * `NatsChannel` once it is bound; before binding, method calls are no-ops
 * returning `false`. `NatsChannel` implements the outbound surface the plugin's
 * message/outbound adapters use (sendText, sendProgress, finalizeDraft,
 * sendTyping, sendApprovalRequest/Resolved — see `WebChannelPeerChannel`).
 */
let boundChannel: NatsChannel | null = null;
function rebindPrimary(): void {
  const primary = selectPrimaryRuntime(accountRuntimes);
  boundChannel = primary?.channel ?? null;
}

const lazyTransport: WebChannelPeerChannel = new Proxy({} as WebChannelPeerChannel, {
  get(_t, prop) {
    const target = boundChannel as unknown as Record<string, unknown> | null;
    if (!target) return () => false;
    const value = target[prop as string];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
});

/**
 * Create the WebChannel plugin, backed by the lazy NATS transport facade.
 *
 * S1 (accountId-aware approvals): the approval capability additionally gets a
 * PER-ACCOUNT transport resolver over `accountRuntimes`, so each account's
 * native approval handler (core starts one per configured account) delivers
 * and finalizes prompts on ITS OWN channel — never the primary facade. The
 * resolver reads the live map at call time (each account lifecycle publishes
 * only after its private wiring fence); an unscoped (null) context reads the
 * `"default"` account, and an unknown account falls back to the lazy facade
 * inside the capability (legacy primary behavior, never a dropped frame).
 */
const webChannelPlugin = createWebChannelPlugin(lazyTransport, {
  resolveApprovalTransport: (accountId) =>
    accountRuntimes.get(accountId ?? "default")?.channel,
  startNatsAccount: (ctx) => startNatsAccountLifecycle(ctx),
  onInvalidAccountId: (_cfg, invalid) => {
    const install = accountCoordinator.currentInstall();
    if (!install) return;
    const reportKey = `${install.generation}\u0000${invalid.id}`;
    if (reportedInvalidAccountIds.has(reportKey)) return;
    reportedInvalidAccountIds.add(reportKey);
    const logger = install.logger as { error?: (message: string) => void } | undefined;
    const message =
      `event=webchannel.invalid_account_id accountId=${formatAccountIdForLog(invalid.id)} ` +
      `state=permanent_skip reason=${JSON.stringify(invalid.reason)}`;
    try {
      (logger?.error ?? console.error)(message);
    } catch {
      try { console.error(message); } catch { /* invalid reporting can never break enumeration */ }
    }
  },
});

async function buildNatsAccount(api: any, ctx: any, ownerIdentity: object): Promise<import("./nats-transport.js").TransportCloseReport | undefined> {
    // Seed the generation aggregate before any dormant preflight return. Thus
    // an all-permanent/missing-credential generation still emits `zero` once.
    reportServingAggregate(api);
    const writeStatus = (status: Record<string, unknown>) => ctx.setStatus?.({ accountId: ctx.accountId, ...status });
    const setStatus = (status: Record<string, unknown>) => {
      try { writeStatus(status); } catch { /* diagnostics never own cleanup */ }
    };
    const log = (level: "info" | "warn" | "error", message: string) => {
      try {
        const fallback = level === "info" ? console.log : level === "warn" ? console.warn : console.error;
        (api.logger?.[level] ?? fallback)?.(message);
      } catch { /* diagnostics never own lifecycle */ }
    };
    const reportPermanent = (
      accountId: string,
      code: string,
      operatorMessage: string,
      attempt = 0,
    ) => permanentFailureReporter.report({
      generation: Number(api.generation ?? 0),
      accountId,
      code,
      operatorMessage,
      attempt,
      logger: api.logger,
    });
    setStatus(accountNeverServedStatusPatch({ restartPending: false, reconnectAttempts: 0, lastError: null }));
    // -----------------------------------------------------------------------
    // Register-hop admission over NATS (replaces the deleted HTTP routes).
    // -----------------------------------------------------------------------
    //
    // The register/challenge/unregister hop used to dial the gateway's INBOUND
    // HTTP routes — the ONLY place the browser reached the agent process
    // directly, violating the outbound-only premise. It now rides NATS
    // request/reply: each register-hop account subscribes its own
    // `webchannel.{tenant}.{accountId}.*.register` subject (see
    // `channel.subscribeRegister()` below), and requests are verified and
    // answered by `handleRegisterRequest` (packages/plugin/src/nats-register.ts).
    // The account-specific I/O — JWT verify + the history snapshot — is injected
    // here; every identity check the HTTP route performed is preserved verbatim.

    // Fire the STATELESS initial history snapshot for a just-registered peer:
    // resolve the agent route, self-read the recent transcript detached (so
    // `sessions.get` authorizes against a synthetic operator client — see
    // historyReadScope), and seal it to the peer over `.out`. K is already
    // established at register time and the client subscribes `.out` BEFORE it
    // registers, so nothing is lost.
    const sendHistorySnapshot = (
      accountId: string,
      servingTenant: string,
      channel: NatsChannel,
      historyConfig: ReturnType<typeof resolveHistoryConfig>,
      peerId: string,
    ): void => {
      try {
        // Same forced per-account-channel-peer key as the inbound WRITE site —
        // so the snapshot reads THIS user's session, never the shared "main" one.
        const route = resolveWebchannelSessionRoute(
          api,
          accountId,
          peerId,
          servingTenant,
        );
        void runDetachedHistoryRead(() =>
          historyRecent(api, route.sessionKey, historyConfig.limit, api.logger),
        )
          .then((messages) => {
            if (messages.length > 0) channel.sendHistory(peerId, messages);
          })
          .catch((err) => {
            api.logger.error?.(
              `webchannel: history snapshot failed for ${logSafe(peerId)}: ${logSafe(err)}`,
            );
          });
      } catch (err) {
        api.logger.error?.(
          `webchannel: history snapshot resolution failed for ${logSafe(peerId)}: ${logSafe(err)}`,
        );
      }
    };

    // -----------------------------------------------------------------------
    // Steps 0–7 (per account): build ONE serving runtime per configured account
    // -----------------------------------------------------------------------

    // Narrow ONCE against the channel-plugin config extensions plugin-sdk's
    // `OpenClawConfig` does not declare (see `WebchannelChannelConfig`). Every
    // top-level `nats`/`saas` read below goes through this local.
    const config = api.config as typeof api.config & WebchannelChannelConfig;
    const legacyNats = config.nats;

    // Phase 3 planning (pure): list enabled accounts. Disabled accounts are
    // omitted before acquisition/credential/network work; the wire identity is
    // the accountId itself (unique by construction). Order is deterministic.
    let plan: ReturnType<typeof planWebchannelAccount>;
    try {
      plan = planWebchannelAccount(api.config, ctx.accountId, {
        warn: (msg) => log("warn", msg),
      });
    } catch (err) {
      const failure = classifyAccountStartupFailure(err, "preflight");
      setStatus(accountNeverServedStatusPatch({ restartPending: false, reconnectAttempts: 0, lastError: failure.operatorMessage }));
      reportPermanent(ctx.accountId, failure.code, failure.operatorMessage);
      await waitForAbort(ctx.abortSignal);
      return undefined;
    }
    if (!plan) {
      setStatus(accountNeverServedStatusPatch({ restartPending: false, reconnectAttempts: 0, lastError: "account is disabled or not configured" }));
      await waitForAbort(ctx.abortSignal);
      return undefined;
    }

    {
      const { accountId, tenant, account } = plan;
      const accountNatsCfg = account.nats as WebchannelNatsConfig | undefined;
      const accountEncryption = account.encryption as WebchannelEncryptionConfig | undefined;
      const accountDmSecurity = account.dmSecurity as string | undefined;
      const admission = "register-hop" as const;

      // Resolve the effective source before reading enrolled material. In
      // particular, source.saasBaseUrl includes the resolver's actual override
      // precedence and is therefore the SaaS identity the document must match.
      let source: NatsCredentialSource;
      try {
        source = resolveNatsCredentialSource({
          natsConfig: accountNatsCfg,
          legacyNats,
          saasBaseUrl: plan.saasBaseUrl ?? config.saas?.baseUrl,
          tenant,
          accountId,
          ...(plan.storageRoot !== undefined
            ? { storageRoot: plan.storageRoot }
            : {}),
        });
      } catch (err) {
        const failure = classifyAccountStartupFailure(err, "preflight");
        setStatus(accountNeverServedStatusPatch({ restartPending: false, reconnectAttempts: 0, lastError: failure.operatorMessage }));
        reportPermanent(accountId, failure.code, failure.operatorMessage);
        await waitForAbort(ctx.abortSignal);
        return undefined;
      }

      // Gate A: load and validate the complete credential document before its
      // issuer, relay, JWT, seed, or identity key can influence auth or network
      // work. Keep the exact result so the consume boundary repeats the gate
      // without a second, potentially different filesystem read.
      let credentialLoad: BoundCredentialLoadResult | undefined;
      if (source.mode === "enrolled") {
        try {
          credentialLoad = loadPersistedCredentialDocument({
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
        } catch (error) {
          if (error instanceof StorageDocumentError) {
            const diagnostic = credentialStorageFailureDiagnostic(error);
            reportPermanent(accountId, diagnostic.code, diagnostic.detail);
            setStatus(accountNeverServedStatusPatch({
              restartPending: false,
              reconnectAttempts: 0,
              lastError: diagnostic.detail,
            }));
            await waitForAbort(ctx.abortSignal);
            return undefined;
          }
          const detail =
            "effective tenant/account/SaaS identity is invalid; correct the account configuration";
          reportPermanent(
            accountId,
            "credential-binding-expectation-invalid",
            detail,
          );
          setStatus(accountNeverServedStatusPatch({
            restartPending: false,
            reconnectAttempts: 0,
            lastError: detail,
          }));
          await waitForAbort(ctx.abortSignal);
          return undefined;
        }
        if (credentialLoad.status !== "match") {
          const code = credentialInspectionCode(credentialLoad);
          const detail = credentialLoad.status === "absent"
            ? `enrolled credentials are absent; run: openclaw channels add --channel webchannel --account ${accountId}`
            : `enrolled credentials are not reusable (${formatCredentialInspection(credentialLoad)}); ` +
              `stop the gateway, archive the account credential file, complete any required SaaS ` +
              `active-key replacement, then re-run channels add for account ${accountId}`;
          reportPermanent(accountId, code, detail);
          setStatus(accountNeverServedStatusPatch({
            restartPending: false,
            reconnectAttempts: 0,
            lastError: detail,
          }));
          await waitForAbort(ctx.abortSignal);
          return undefined;
        }
      }

      // Immutable auth preparation receives only the already-bound projection.
      // Thus a delivered issuer can never be read from unbound/mismatched bytes.
      const getPersisted = createMemoizedPersistedAccessor(
        () => credentialLoad?.status === "match"
          ? credentialLoad.credentials
          : undefined,
      );
      let accountAuth: ReturnType<typeof prepareAccountAuth>;
      try {
        accountAuth = prepareAccountAuth({
          plan,
          getPersisted,
          ...(source.mode === "enrolled"
            ? { effectiveSaasBaseUrl: source.saasBaseUrl }
            : {}),
          ...(config.saas?.baseUrl !== undefined
            ? { topLevelSaasBaseUrl: config.saas.baseUrl }
            : {}),
          logger: api.logger,
        });
      } catch (err) {
        const buildError = err instanceof Error ? err.message : String(err);
        let buildDetail = `JWT verifier configuration is invalid: ${buildError}`;
        try {
          buildDetail = formatAccountReadiness({
            accountId,
            admission: "register-hop",
            audience: accountId,
            buildError,
            ...(account.dmSecurity !== undefined
              ? { dmSecurity: String(account.dmSecurity) }
              : {}),
          }).line;
        } catch { /* the stable permanent event below remains available */ }
        reportPermanent(
          accountId,
          "jwt-auth-config-invalid",
          `${buildDetail}; fix the account JWT issuer and exactly-one JWKS source`,
        );
        setStatus(accountNeverServedStatusPatch({
          restartPending: false,
          reconnectAttempts: 0,
          lastError: buildDetail,
        }));
        await waitForAbort(ctx.abortSignal);
        return undefined;
      }
      const effIssuer = accountAuth.auth.jwt.issuer;
      const effAudience = accountId;

      // Obsolete-config tidy: the register hop moved from HTTP to NATS, so the
      // old `auth.cors` browser-origin allowlist no longer applies and is silently
      // ignored. Warn (once per account, at startup) so an operator carrying a
      // stale block isn't misled into thinking origin restriction is still active.
      const rawAuth = account.auth as Record<string, unknown> | undefined;
      if (rawAuth && typeof rawAuth === "object" && "cors" in rawAuth) {
        log("warn",
          `[webchannel] account "${accountId}": auth.cors is OBSOLETE and IGNORED — the ` +
            `register hop moved from HTTP to NATS, so browser-origin allowlisting no longer ` +
            `applies. Remove the auth.cors block. Access control is the SaaS-minted per-peer ` +
            `NATS credential scope.`,
        );
      }

      // ---- Step 0 (per account): fail-closed encryption guard --------------
      // The NATS relay must only ever observe ciphertext. If an account disables
      // encryption, we SKIP that account (it is never served, never connects,
      // never emits plaintext) rather than crashing the whole process — this
      // keeps the fail-closed invariant (no plaintext) while isolating the
      // misconfig from other accounts/channels.
      let cryptoOptions: NatsChannelCryptoOptions;
      try {
        cryptoOptions = resolveEncryptionPolicy(accountEncryption).crypto;
      } catch (err) {
        reportPermanent(
          accountId,
          "encryption-policy-invalid",
          `E2E encryption configuration is invalid; refusing to serve without encryption. ${(err as Error).message}`,
        );
        setStatus(accountNeverServedStatusPatch({ restartPending: false, reconnectAttempts: 0, lastError: "E2E encryption configuration is invalid" }));
        await waitForAbort(ctx.abortSignal);
        return undefined;
      }

      // ---- Step 1 (per account): consume already-bound credential source ----
      // F2: the agent's SaaS-attested identity key from the enrolled creds (set
      // only on the enrolled path). The register-hop channel wraps K under it.
      let identityKey: KeyPair | undefined =
        credentialLoad?.status === "match"
          ? credentialLoad.credentials.identityKey
          : undefined;
      if (!identityKey) {
        reportPermanent(
          accountId,
          "identity-key-missing",
          `attested agent identity key is missing; run: openclaw channels add --channel webchannel --account ${accountId}`,
        );
        setStatus(accountNeverServedStatusPatch({ restartPending: false, reconnectAttempts: 0, lastError: "attested agent identity key is missing" }));
        await waitForAbort(ctx.abortSignal);
        return undefined;
      }

      const preflightIdentityKey = identityKey;
      // Keep one limiter per account lifecycle so transport restart attempts do
      // not reset capacity-rejection suppression and create a fresh log burst.
      const capacityDiagnostics = createCapacityDiagnostics({ logger: api.logger });
      return await runAccountStartupLoop({
        signal: ctx.abortSignal,
        onRetryScheduled: ({ failure, failedAttempts, delayMs }) => {
          setStatus(accountNeverServedStatusPatch({
            restartPending: true,
            reconnectAttempts: failedAttempts,
            lastError: failure.operatorMessage,
          }));
          if (shouldLogRetryAttempt(failedAttempts)) {
            log("warn",
              `event=webchannel.account_startup accountId=${formatAccountIdForLog(accountId)} ` +
              `state=retry_scheduled attempt=${failedAttempts} delayMs=${delayMs} code=${failure.code}`,
            );
          }
        },
        onRecovered: ({ attempt, failedAttempts, outageMs }) => {
          log("info",
            `event=webchannel.account_startup accountId=${formatAccountIdForLog(accountId)} ` +
            `state=recovered attempt=${attempt} failedAttempts=${failedAttempts} outageMs=${outageMs}`,
          );
        },
        onTerminal: ({ failure, failedAttempts, quarantined }) => {
          const lastError = quarantined
            ? "transport closure could not be confirmed; account quarantined"
            : failure.operatorMessage;
          const status = {
            restartPending: false,
            reconnectAttempts: failedAttempts,
            lastError,
          };
          setStatus(quarantined ? { ...status, connected: false } : accountNeverServedStatusPatch(status));
          reportPermanent(accountId, failure.code, failure.operatorMessage, failedAttempts);
        },
        attempt: async ({ attempt, failedAttempts, markCommitted }) => {
      const attemptAbort = createAttemptAbortScope(ctx.abortSignal);
      let transport: NatsTransport;
      let enrolled: EnrolledNatsConnection | undefined;
      let attemptIdentityKey = preflightIdentityKey;
      let published = false;
      let runtimeActive = true;
      let runtimeRef: AccountRuntime | undefined;
      let preCommitPoisoned = false;
      let privateFailure: unknown;
      let initialHandshakeEstablished = false;
      let detachTransportListeners: (() => void) | undefined;
      const poisonPrivateAttempt = (cause: unknown) => {
        if (preCommitPoisoned) return;
        preCommitPoisoned = true;
        privateFailure = cause;
        attemptAbort.abort(cause);
        transport.disconnect();
      };
      const onInitialConnect = () => {
        initialHandshakeEstablished = true;
      };
      const onDisconnect = (cause?: unknown) => {
        if (!published) {
          // Before the first PONG, connect() rejection owns the typed DNS/TLS/
          // timeout/close cause. The socket's follow-on close must not replace
          // it with a generic disconnect.
          if (!initialHandshakeEstablished) return;
          poisonPrivateAttempt(cause ?? new NatsConnectionClosedError(1006, false));
          return;
        }
        if (runtimeActive && accountRuntimes.get(accountId) === runtimeRef) {
          setStatus(accountTransportStatusPatch("disconnect"));
          reportServingAggregate(api);
        }
      };
      const onReconnect = () => {
        if (runtimeActive && published && accountRuntimes.get(accountId) === runtimeRef) {
          setStatus(accountTransportStatusPatch("reconnect"));
          reportServingAggregate(api);
          log("info", `event=webchannel.account_transport accountId=${formatAccountIdForLog(accountId)} state=recovered`);
        }
      };
      const onTransportError = (err: Error) => {
        if (!published) {
          if (!initialHandshakeEstablished) return;
          poisonPrivateAttempt(err);
          return;
        }
        if (runtimeActive && published && accountRuntimes.get(accountId) === runtimeRef) {
          setStatus(accountTransportStatusPatch("error"));
        }
        log("error", `event=webchannel.account_transport accountId=${formatAccountIdForLog(accountId)} state=error code=transport-error`);
      };
      let attemptTransport: NatsTransport | undefined;
      try {
        const consumed = await consumeCredentialSource(source, {
          signal: attemptAbort.signal,
          ...(source.mode === "enrolled" && credentialLoad
            ? { loadPersisted: () => credentialLoad }
            : {}),
          onTransport: (created) => {
            // The connector calls this before awaiting connect(). Take sticky
            // disconnect/error ownership here so PONG+close cannot outrun the
            // async continuation which returns the connected transport.
            attemptTransport = created;
            transport = created;
            detachTransportListeners = attachAccountTransportListeners(created, {
              connect: onInitialConnect,
              disconnect: onDisconnect,
              reconnect: onReconnect,
              error: onTransportError,
            });
          },
        });
        if (consumed.status === "creds-missing") {
          attemptAbort.dispose();
          return {
            kind: "failed" as const,
            cause: new AccountStartupError({
              kind: "permanent",
              code: "creds-missing",
              phase: "preflight",
              cause: consumed,
              operatorMessage: "enrolled credentials are missing; re-enroll the account",
            }),
          };
        }
        if (consumed.status === "creds-binding-failed") {
          attemptAbort.dispose();
          return {
            kind: "failed" as const,
            cause: new AccountStartupError({
              kind: "permanent",
              code: credentialInspectionCode(consumed.failure),
              phase: "preflight",
              cause: consumed.failure,
              operatorMessage:
                `enrolled credentials failed the runtime binding gate ` +
                `(${formatCredentialInspection(consumed.failure)}); archive them and re-enroll`,
            }),
          };
        }
        // Log the EFFECTIVE relay (consumed.dialedUrl), not the resolver's
        // `source.url`: for enrolled mode the SaaS-delivered `natsUrl` wins, so
        // these can differ — printing the dialed URL keeps the log truthful.
        log("info", `[webchannel] account ${formatAccountIdForLog(accountId)} credential source: ${source.mode} → ${formatRelayOrigin(consumed.dialedUrl)}`);
        transport = consumed.connection.transport;
        if (consumed.connection.enrolled) enrolled = consumed.connection.enrolled;
        attemptIdentityKey = consumed.identityKey ?? attemptIdentityKey;
      } catch (err) {
        try { detachTransportListeners?.(); } catch { /* close still owns cleanup */ }
        const closeReport = attemptTransport ? await attemptTransport.closeGracefully() : undefined;
        attemptAbort.dispose();
        return {
          kind: "failed" as const,
          cause: privateFailure ?? err,
          ...(closeReport ? { closeReport } : {}),
        };
      }

      // Phase 6 review finding 1 (RESOLVED, not warned): a multi-user
      // (register-hop) account no longer risks the SHARED-transcript leak on the
      // history snapshot / load_history paths — webchannel FORCES its own
      // per-account-channel-peer session scope regardless of the operator's
      // global session.dmScope (see src/session-route.ts). The old startup
      // dmScope="main" warning is therefore gone; the readiness line below
      // reports the ENFORCED scope instead.

      // ---- Step 2 (per account): create the encrypted NATS channel ---------
      // Subject namespace is webchannel.{tenant}.{accountId}.{peerId} — the
      // accountId is the wire identity (one namespace per account).
      let channel: NatsChannel;
      try {
        const keyStore = new ConversationKeyStore({
          tenant,
          accountId,
          ...(plan.storageRoot !== undefined
            ? { storageRoot: plan.storageRoot }
            : {}),
          onCapacityWarning: capacityDiagnostics.onCapacityWarning,
        });
        // #159: do not publish a serving runtime that will fail its first
        // registration after discovering state written by a newer release.
        // This probe is version-only and non-mutating; ordinary corruption
        // keeps the key store's existing lazy quarantine/audit policy.
        keyStore.assertNoFutureDocuments();
        channel = new NatsChannel(transport, accountId, tenant, {
          ...cryptoOptions,
          keyStore,
          identityKeyPair: attemptIdentityKey,
        });
      } catch (err) {
        try { detachTransportListeners?.(); } catch { /* close still owns cleanup */ }
        const closeReport = await transport.closeGracefully();
        attemptAbort.dispose();
        const cause = isVersionTooNew(err)
          ? new AccountStartupError({
              kind: "permanent",
              code: `${err.document}-version-too-new`,
              phase: "preflight",
              cause: err,
              operatorMessage: err.message,
            })
          : err;
        return { kind: "failed" as const, cause, closeReport };
      }
      log("info",
        `[webchannel] account "${accountId}" ✓ encrypted NATS channel (tenant=${tenant}, accountId=${accountId})`,
      );

      // #99: the dispatcher's message type is the wire frame PLUS the internal
      // member-id list `coalesceUserMessages` stamps on a merged turn. Widened
      // here, at the dispatcher boundary, and nowhere else: `InboundWsMessage`
      // itself stays exactly as deployed clients know it (no protocol change),
      // and the extra field only ever travels plugin-internally, from the merge
      // to `handleInboundMessage`'s settle path.
      type WebchannelUserMessage = Extract<
        InboundWsMessage,
        { type: "user_message" }
      > & CoalescedMemberIds;
      type DebounceItem = {
        peerId: string;
        message: WebchannelUserMessage;
      };
      const sessionTokens = new Map<string, RetentionSessionToken>();
      const sessionToken = (peerId: string): RetentionSessionToken => {
        let token = sessionTokens.get(peerId);
        if (!token) {
          token = processInboundRetention.createSessionToken();
          sessionTokens.set(peerId, token);
        }
        return token;
      };
      const pressureLogger = new InboundPressureLogger(
        (message) => (api.logger?.warn ?? console.warn)?.(message),
      );
      let inboundDispatcher: SerializedInboundDispatcher<WebchannelUserMessage> | undefined;
      let inboundDebouncer: BoundedInboundDebouncer<DebounceItem> | undefined;
      let disposePromise: Promise<import("./nats-account-coordinator.js").DisposeReport> | undefined;
      const dispose = () => {
        if (disposePromise) return disposePromise;
        disposePromise = (async () => {
          const errors: Array<{ phase: string; error: unknown }> = [];
          runtimeActive = false;
          try { attemptAbort.dispose(); } catch (error) { errors.push({ phase: "attempt-abort-listener", error }); }
          try { inboundDebouncer?.dispose(); } catch (error) { errors.push({ phase: "debouncer", error }); }
          try { inboundDispatcher?.dispose(); } catch (error) { errors.push({ phase: "dispatcher", error }); }
          try { processOverflowResolver.invalidateAccount(accountId); } catch (error) { errors.push({ phase: "overflow-resolver", error }); }
          sessionTokens.clear();
          try { detachTransportListeners?.(); } catch (error) { errors.push({ phase: "transport-listeners", error }); }
          try { channel.dispose(); } catch (error) { errors.push({ phase: "channel", error }); }
          const transportReport = await transport.closeGracefully();
          return { errors, transport: transportReport };
        })();
        return disposePromise;
      };

      try {

      // P0-6: honor `capabilities.typing: "off"` on NATS (previously the gate
      // existed only on the legacy WS transport, so the off-toggle was silently
      // ignored here). `account` (destructured from the serving plan above) IS
      // this account's RESOLVED config — `resolveWebchannelAccountConfig(cfg,
      // accountId)` (multiplex.ts), the channel-level base merged under the
      // account override — so each account's capability applies to its own
      // channel (가-1 Cycle 2). We reuse that binding rather than re-resolving:
      // it is already the exact `WebchannelAccountConfig` `resolveTypingEnabled`
      // takes (the history handler below casts it only because
      // `resolveHistoryConfig` wants a narrower shape).
      channel.setTypingEnabled(resolveTypingEnabled(account));

      // ---- Step 3 (per account): inbound dispatcher (accountId-threaded) ----
      // Each account gets its OWN serialized dispatcher bound to its channel and
      // accountId, so inbound turns resolve THIS account's route (binding.account)
      // and replies deliver back over THIS account's channel.
      inboundDispatcher =
        createSerializedInboundDispatcher<WebchannelUserMessage>(
          (peerId, message) =>
            handleInboundMessage(
              api,
              channel,
              peerId,
              message,
              accountId,
              tenant,
            ),
          {
            // P1-8b layer (b): busy-time coalesce. A message that arrives while a
            // turn is already running for its session buffers and is merged into
            // ONE follow-up turn on completion (Telegram parity), instead of
            // chaining a separate turn each.
            coalesce: coalesceUserMessages,
            budget: processInboundRetention,
            sessionToken,
          },
        );
      const cancelledInboundFallback = processCancelledInboundFallback;

      // P1-8b layer (a): repo-owned bounded idle pre-run debounce (Telegram
      // parity). It replaces core's unbounded primitive and sits IN FRONT of the
      // per-session FIFO: rapid
      // same-peer messages within the debounce window flush together as ONE
      // merged turn. `resolveInboundDebounceMs` reads the GLOBAL config
      // (`messages.inbound.byChannel.webchannel ?? messages.inbound.debounceMs ??
      // 0`) — resolved ONCE here per account. The core default is 0ms, which makes
      // this layer inert (each message flushes immediately) unless an operator
      // opts in; layer (b) still coalesces busy-time regardless. We keep that
      // default (do NOT invent a nonzero one). Items carry `peerId` so `buildKey`
      // and `onFlush` can route; one explicit bounded worker owns each same-key
      // sequence. Forced retirement severs queued batch captures, while a callback
      // that already began keeps its copied entries charged until settlement.
      const inboundDebounceMs = resolveInboundDebounceMs({
        cfg: api.config,
        channel: WEBCHANNEL_ID,
      });
      const onIngressFlush = createIngressOnFlush<DebounceItem>({
        accountId,
        outcomeStore: processIngressOutcomes,
        beginBatch: (peerId) => inboundDispatcher!.beginBatch(peerId),
        sendAck: (peerId, ids) => channel.sendAck(peerId, ids),
        sendInboundRejected: (peerId, ids) => channel.sendInboundRejected(peerId, ids),
        cancelledFallback: cancelledInboundFallback,
        logInfo: (message) => api.logger?.info?.(message),
        logWarn: (message) => api.logger?.warn?.(message),
        isActive: () => runtimeActive,
      });
      inboundDebouncer = createBoundedInboundDebouncer<DebounceItem>({
        debounceMs: inboundDebounceMs,
        buildKey: (item) => item.peerId,
        sessionToken: (peerId) => sessionToken(peerId),
        budget: processInboundRetention,
        // Charge the authenticated wire message only. `peerId` is routing
        // metadata on the repo-owned wrapper.
        measure: (item) => estimateRetainedMessageBytes(item.message),
        getId: (item) => item.message.id,
        isOverflowClaimed: (peerId, id) =>
          processOverflowResolver.hasActiveClaim(accountId, `${peerId}:${id}`),
        isCancelledFallback: (peerId, id) =>
          cancelledInboundFallback.has(`${peerId}:${id}`, accountId),
        peekOutcome: (peerId, id) =>
          processIngressOutcomes.peek(accountId, `${peerId}:${id}`),
        onKnownOutcome: (peerId, id, outcome) => {
          if (outcome === "accepted") channel.sendAck(peerId, [id]);
          else channel.sendInboundRejected(peerId, [id]);
        },
        onOverflow: ({ key: peerId, id, reason, chargedBytes, recoverCancelled }) => {
          pressureLogger.record({
            accountId,
            internalReason: reason,
            rejectedMessages: 1,
            rejectedChargedBytes: chargedBytes ?? 0,
            snapshot: processInboundRetention.snapshot(sessionToken(peerId)),
          });
          if (typeof id !== "string" || id.length === 0 || id.length > 128) return;
          processOverflowResolver.tryStart({
            accountId,
            peerId,
            id,
            key: `${peerId}:${id}`,
            sessionToken: sessionToken(peerId),
            recoverCancelled,
          });
        },
        onFlush: onIngressFlush,
        onCancel: async (entries) => {
          // P0-7b: a `/stop` cancels debounce-buffered messages that never reached
          // onFlush, so they were never dedupe-recorded and never acked — yet the
          // client's replay ledger still holds them. Record their ids (so an
          // in-flight replay is dropped as accepted) and ACK them. The bounded
          // debouncer keeps reservations charged until this callback settles.
          await recordCancelledInboundItems(
            entries.map((entry) => entry.item),
            accountId,
            async (key) => {
              const result = await processIngressOutcomes.record(
                accountId,
                key,
                "accepted",
                { replaceOpposite: true },
              );
              if (result.status !== "recorded") throw result.error;
              result.write.commit();
              return true;
            },
            (peerId, ids) => channel.sendAck(peerId, ids),
            (message) => api.logger?.warn?.(message),
            cancelledInboundFallback,
            () => entries.every((entry) => !entry.isRetired()),
          ).catch((err) => {
            api.logger?.warn?.(
              `webchannel: cancelled-inbound handling failed: ${logSafe(err)}`,
            );
          });
        },
      });

      const retirePeerIngress = (peerId: string): void => {
        inboundDebouncer!.cancelKey(peerId, { notify: false });
        inboundDispatcher!.clearPending(peerId);
        const token = sessionTokens.get(peerId);
        if (token) processOverflowResolver.invalidateSession(token);
        sessionTokens.delete(peerId);
      };
      channel.setPeerUnregisterHandler(retirePeerIngress);

      // Command-gate mirror (P1-8a follow-up), resolved ONCE per account. It
      // depends only on `api.config` + `accountId`, never on the message, so we
      // build it here rather than per abort. When an operator configures a
      // commands/owner allowlist, core IGNORES our control-lane
      // `access.commands.authorized` stamp and a non-listed peer's `/stop`
      // silently fails — this lets the control-lane branch below detect that and
      // send the peer a hedged notice. See src/command-gate.ts for the traced
      // core paths (all testable logic lives in the imported typed helpers).
      const commandGate = resolveCommandGate(api.config, accountId);
      channel.setMessageHandler((peerId, rawMessage) => {
        if (!runtimeActive) return;
        if (rawMessage.type !== "user_message") return; // approvals routed below
        // #99: rebuild the frame from its KNOWN wire fields before anything else
        // touches it. The decode path is a cast (`JSON.parse(...) as
        // InboundWsMessage`, nats-channel.ts) and its `user_message` case
        // forwards the object with no field checks, so a peer could attach ANY
        // property — including `coalescedIds`, which is plugin-internal state
        // meaning "these receipts settle with this turn". Stripping it here is
        // what makes `coalesceUserMessages` its ONLY producer: a peer cannot
        // name ids it never sent, cannot make the settle loop iterate a
        // non-iterable, and cannot make the merge throw (which the dispatcher
        // absorbs by discarding the whole turn — ACKed, never run, never
        // settled). The read sites guard the field too; this is the layer that
        // makes the "never from the wire" claim true.
        //
        // The normalization itself is a tested pure function; this file just
        // routes (same split as `isControlLaneMessage` below). The ORDER is the
        // part that matters here and is pinned by the source guard in
        // `index-nats-wiring.test.ts`: nothing — not the control lane, not the
        // ack, not the debouncer — may see the raw frame, and that guard counts
        // the reads above this line, so do not add one.
        const message: WebchannelUserMessage = normalizeInboundUserMessage(rawMessage);
        // Control lane (P1-8a): an abort ("/stop"/"stop"/…) must reach core's
        // fast-abort WHILE the running turn is live, so it must NOT queue behind
        // that turn on the per-session FIFO. Dispatch it directly, fire-and-
        // forget, as an authorized control-lane turn. All the testable logic
        // lives in `isControlLaneMessage` + `handleInboundMessage` (both under
        // tsc + vitest); this file just routes.
        //
        // Unlike the FIFO path (inbound-queue.ts swallows a rejected turn), this
        // direct dispatch has no chain to absorb a throw, and the pre-try work in
        // handleInboundMessage (config/admission/route resolution, sendTyping)
        // runs OUTSIDE its internal try/catch — so we MUST attach a rejection
        // handler here or an unhandledRejection would take down the gateway.
        //
        // Authorization note: if an operator sets `commands.allowFrom` that
        // EXCLUDES this peer, core's fast-abort returns handled:false (verified
        // dist-B2e1grFo.js:1281) and the abort frame falls through to a NORMAL
        // turn that races the running one, hits core's busy gate, and is dropped
        // as busy. No wedge and no double-delivery — the /stop is simply ignored
        // for an unauthorized sender.
        if (isControlLaneMessage(message)) {
          // P1-8b: an EXPLICIT "/stop" (typed, or the widget Stop button which
          // sends the literal "/stop") wants the text queued behind the running
          // turn gone too — mirroring core fast-abort clearing its own followup
          // lanes. Drop this peer's buffered input on BOTH layers before
          // dispatching the abort: (a) any messages waiting in the pre-run
          // debounce window (`cancelKey`), and (b) any messages buffered during
          // the running turn (`clearPending`). Log at info only when something
          // was actually dropped.
          //
          // The destructive drop is gated by `shouldDropBufferedInputOnStop`,
          // which narrows on TWO axes (both live in the tested predicate):
          //  1. EXPLICIT "/stop" only, NOT the broader `isControlLaneMessage`
          //     vocabulary — a "halt"/"stop please" still aborts the running turn
          //     for core parity, but a false-positive NL match must never
          //     silently destroy a queued follow-up. Only the unambiguous "/stop"
          //     opts in.
          //  2. AUTHZ ASYMMETRY — the drop is all-or-nothing with the abort, and
          //     the abort is core's call. When a commands/owner allowlist is
          //     configured, core IGNORES our control-lane stamp (see the hedge
          //     below + command-gate.ts): a non-listed peer's abort is refused,
          //     the running turn keeps going. Dropping their buffers then would be
          //     a PARTIAL /stop — turn survives, queued input destroyed. So we
          //     drop only when the gate says core will honor this peer's abort
          //     (`!delegated || isListed`). The mirror is biased toward NOT
          //     dropping, so its only error is skipping cleanup for a peer whose
          //     abort actually succeeded (their follow-up runs after the abort) —
          //     accepted over destroying input for a peer whose turn survives.
          if (shouldDropBufferedInputOnStop(message, commandGate, peerId)) {
            const debounceCancelled = inboundDebouncer!.cancelKey(peerId, { notify: true });
            const pendingDropped = inboundDispatcher!.clearPending(peerId);
            if (debounceCancelled || pendingDropped.length > 0) {
              api.logger?.info?.(
                `webchannel: /stop dropped buffered input (debounced=${debounceCancelled}, pending=${pendingDropped.length})`,
              );
            }
          }
          // P0-7b: ack the control-lane frame here too. It bypasses the
          // debouncer/onFlush (and is never deduped), so without this its
          // client-side ledger entry would never drain and every reconnect would
          // replay the /stop. A replayed /stop that lands before this ack is a
          // harmless no-op abort (accepted).
          if (message.id && !channel.sendAck(peerId, [message.id])) {
            api.logger?.warn?.(
              `webchannel: control-lane ack failed for peer=${logSafe(peerId)} id=${logSafe(message.id)}`,
            );
          }
          void handleInboundMessage(
            api,
            channel,
            peerId,
            message,
            accountId,
            tenant,
            { controlLane: true },
          ).catch((err) =>
            api.logger?.error?.(
              `webchannel: control-lane dispatch failed: ${logSafe(err)}`,
            ),
          );
          // Feedback-only hedge for the stamp-ignored trap. Core's
          // `resolveCommandSenderAuthorization` IGNORES our control-lane
          // `access.commands.authorized` stamp whenever a commands/owner
          // allowlist is configured (see src/command-gate.ts): a non-listed
          // peer's /stop returns handled:false, falls through to a normal turn,
          // and is dropped as busy — the run is NOT aborted and the widget's
          // Stop button would otherwise sit silently inert with zero feedback.
          // We STILL dispatch the abort above (core is the authority — the
          // mirror can be wrong), and here we ADDITIONALLY warn the peer when
          // our best-effort mirror says core will reject this sender. The gate
          // is a conservative mirror biased toward showing this notice, so a
          // false positive is only an extra hedged message, never a missed one.
          // Best-effort send (ignore the boolean return), matching the rest of
          // the outbound surface.
          // #238: this notice is a real durable bubble, so the plugin mints its
          // id at the delivery act rather than letting the viewer name it. Still
          // best-effort — the boolean return stays deliberately ignored.
          if (commandGate.delegated && !commandGate.isListed(peerId)) {
            channel.sendText(
              peerId,
              "Stop may not be permitted for this user: this agent restricts " +
                "commands to an operator allowlist.",
              nextMessageId(),
            );
          }
          return;
        }
        // Normal inbound: through layer (a) debounce → onFlush → per-session FIFO
        // (layer (b) coalesce). `enqueue` is fire-and-forget from here; attach a
        // rejection handler so a flush failure can't surface as an
        // unhandledRejection (the debouncer already routes onFlush throws to
        // `onError`, so this is belt-and-suspenders).
        void inboundDebouncer!
          .enqueue({ peerId, message })
          .catch((err) =>
            api.logger?.error?.(
              `webchannel: inbound enqueue failed: ${logSafe(err)}`,
            ),
          );
      });

      // ---- Step 4 (per account): approval decision handler -----------------
      // S1: pass THIS account's id so the fail-closed approver check reads the
      // account's own `execApprovals.approvers` — a peer who is an approver on
      // another account cannot resolve approvals via this account's channel.
      channel.setApprovalDecisionHandler((peerId, id, decision) => {
        void handleApprovalDecision(api.config, id, decision, peerId, accountId).catch((err) => {
          // A missing delivery binding is EXPECTED in normal multi-device flows
          // (a Leg C snapshot re-send racing a finalize, or two devices both
          // clicking) — log it at warn, not error. Genuine authz rejections
          // (non-approver, cross-account) stay at error.
          if (err instanceof ApprovalBindingMissingError) {
            api.logger.warn?.(`webchannel: approval resolve ignored (${logSafe(id)}): ${logSafe(err.message)}`);
          } else {
            api.logger.error?.(`webchannel: approval resolve failed (${logSafe(id)}): ${logSafe(err)}`);
          }
        });
      });

      // ---- Step 5 (per account): history load handler ----------------------
      const historyConfig = resolveHistoryConfig(
        account as { capabilities?: { typing?: "on" | "off" } } | undefined,
      );
      channel.setLoadHistoryHandler((peerId, request) => {
        try {
          // Same forced key as the WRITE + snapshot sites — pagination reads
          // THIS user's session, so older pages never leak another user's turns.
          const route = resolveWebchannelSessionRoute(api, accountId, peerId, tenant);
          // `planHistoryFetch` validates the wire `limit` (the NATS dispatch
          // forwards it unvalidated) and picks paginate-vs-tail from `before`.
          const plan = planHistoryFetch(request, historyConfig.pageSize);
          void runDetachedHistoryRead(() =>
            plan.kind === "page"
              ? historyPageBefore(api, route.sessionKey, plan.beforeId, plan.limit, api.logger)
              : historyRecent(api, route.sessionKey, plan.limit, api.logger),
          )
            .then((messages) => {
              channel.sendHistory(peerId, messages);
            })
            .catch((err) => {
              api.logger.error?.(`webchannel: history page failed for ${logSafe(peerId)}: ${logSafe(err)}`);
            });
        } catch (err) {
          api.logger.error?.(`webchannel: history resolution failed for ${logSafe(peerId)}: ${logSafe(err)}`);
        }
      });

      // ---- Step 5b (per account): command-catalog load handler (P0-3) ------
      // Slash-command DISCOVERY. The catalog is a PURE function of the agent's
      // resolved config, which is fixed for the process's lifetime, so we build
      // it ONCE via a memoizing provider (created here, per account) and serve
      // the cached result on every request. Per-request building was an
      // event-loop DoS surface: this handler runs inline on the inbound dispatch
      // path for ANY handshaken peer (see the exposure decision below), so a peer
      // could flood `load_commands` and re-spin the registry list + sort each
      // frame. Memoizing removes that without a rate limiter. The provider does
      // NOT cache a thrown build, so a transient registry fault retries on the
      // next request rather than latching an empty menu; the try/catch stays the
      // failure boundary (a build fault must never surface as an unhandled throw
      // on the dispatch path). See src/commands-catalog.ts for the design.
      //
      // The `commands` frame carries only low-sensitivity command metadata
      // (names / descriptions / args), already config-filtered by
      // buildCommandCatalog — so unlike the history/approval snapshots (which
      // carry the user's own data) it does not need to be withheld pending any
      // additional gate. Every peer is register-hop-authenticated before this
      // handler can fire, so serving the catalog to a registered peer is accepted.
      const catalogProvider = createCommandCatalogProvider(api.config);
      channel.setLoadCommandsHandler((peerId) => {
        try {
          channel.sendCommands(peerId, catalogProvider());
        } catch (err) {
          api.logger.error?.(
            `webchannel: command catalog failed for ${logSafe(peerId)}: ${logSafe(err)}`,
          );
        }
      });

      // NOTE (Phase 6): the initial history snapshot is now sent from the
      // REGISTER route (stateless register — K is established there, and the
      // client subscribes `.out` before registering). The old
      // `setHandshakeCompleteHandler` snapshot wiring is gone: registered
      // peers no longer handshake at all, and the channel only ever fired that
      // callback for registered peers, so it could never fire again.

      // ---- Axis B consequence: register-hop admission over NATS -------------
      // Every account wires the register-request handler and subscribes its own
      // `.register` wildcard (the NATS analogue of the old HTTP route) — the sole
      // admission path now that auto-admission and the X25519 handshake are gone.
      {
        // PER-ACCOUNT PoP nonce store (NOT process-wide). Scoping the store to
        // this account means its per-peer cap evicts only THIS account's own
        // peers' nonces — so an attacker flooding `challenge` in account A can
        // never evict a victim's in-flight nonce in account B, even if their IdPs
        // mint a colliding `sub`/peerId. (A process-wide store keyed by bare
        // peerId would re-open that cross-account eviction across a sub collision.)
        const accountPopChallenges = new PopChallengeStore();
        // Narrow, typed view of the channel methods the register deps feed. The
        // `RegisterChannelSurface` contract (Pick over NatsChannel, declared in
        // a type-checked file) is what makes dropping any of these methods from
        // NatsChannel a compile error inside the normal TypeScript closure.
        const registerChannel: RegisterChannelSurface = channel;
        channel.setRegisterRequestHandler((subjectPeerId, payload, reply) => {
          // The register SUB is installed privately and flushed before account
          // publication. A request can arrive in the narrow PONG→commit window;
          // keep it inert until this runtime is actually serving.
          if (!published) return;
          // The handler is internally guarded (it replies REGISTER_FAILED on any
          // throw), but attach a `.catch` here too as defense-in-depth: a future
          // unguarded path must never surface as an unhandledRejection.
          void handleRegisterRequest({
            tenant,
            subjectPeerId,
            payload,
            reply,
            verifyIdentity: accountAuth.verifyIdentity,
            requirePoP: accountAuth.requirePoP,
            popChallenges: accountPopChallenges,
            registerPeer: (pid) => registerChannel.registerPeer(pid),
            wrapConversationKeyForDevice: (pid, key, clientNonce) =>
              registerChannel.wrapConversationKeyForDevice(pid, key, clientNonce),
            unregisterPeer: (pid) => registerChannel.unregisterPeer(pid),
            sendHistorySnapshot: (pid) =>
              sendHistorySnapshot(accountId, tenant, channel, historyConfig, pid),
            // #15/#19: authoritative pending-approval snapshot PLUS recently-
            // resolved outcomes. BOTH store reads and the publish MUST be
            // synchronous — one event-loop turn, NO await/.then() between them (do
            // NOT imitate sendHistorySnapshot's detached-read shape above). The
            // §3.4 race analysis holds precisely BECAUSE finalize deletes the
            // pending entry AND records the resolved outcome before publishing
            // `approval_resolved`, and this is list→list→publish atomically — so a
            // snapshot can never list an approval whose resolve frame preceded it,
            // nor omit an approval from BOTH lists while the client awaits it.
            // Sent even when empty (retires stale cards). Reached through the
            // typed `registerChannel` (RegisterChannelSurface) so removing
            // `sendApprovalSnapshot` from NatsChannel is a compile error at the
            // contract, not a silent runtime break here.
            sendApprovalSnapshot: (pid) =>
              registerChannel.sendApprovalSnapshot(
                pid,
                listPendingApprovalsForPeer(accountId, pid),
                listResolvedApprovalsForPeer(accountId, pid),
              ),
            onCapacityReject: capacityDiagnostics.onCapacityReject,
            logger: api.logger,
          }).catch((err) => {
            api.logger?.error?.(
              `webchannel: register handler rejected for subject peerId ${logSafe(subjectPeerId)}: ${logSafe(err)}`,
            );
          });
        });
      }

      // ---- Step 7 (per account): startup readiness gate (Gate B) -----------
      // The account is fully wired but still private. Warm the exact cache owned
      // by its account-bound verifier, then install and flush the required
      // register subscription before either reporting readiness or publishing
      // the runtime. A transient JWKS failure is reported but does not
      // permanently skip the account: live verification remains fail-closed
      // and can retry.
      let jwks: JwksReadiness | undefined;
      try {
        const readiness = await resolvePrivateReadiness({
          signal: attemptAbort.signal,
          resolve: (signal) => accountAuth.warmJwks(signal),
          dispose,
        });
        if (readiness.kind === "aborted") {
          if (ctx.abortSignal.aborted) {
            return { kind: "completed" as const, closeReport: readiness.closeReport };
          }
          return {
            kind: "failed" as const,
            cause: privateFailure ?? new NatsConnectionClosedError(1006, false),
            closeReport: readiness.closeReport,
          };
        }
        jwks = readiness.value;
      } catch (err) {
        jwks = { error: err instanceof Error ? err.message : String(err) };
      }

      if (ctx.abortSignal.aborted || preCommitPoisoned || !transport.connected) {
        const closeReport = (await dispose()).transport;
        if (ctx.abortSignal.aborted) return { kind: "completed" as const, closeReport };
        return {
          kind: "failed" as const,
          cause: privateFailure ?? new NatsConnectionClosedError(1006, false),
          closeReport,
        };
      }

      // NATS accepts SUB asynchronously. The local sid alone says nothing about
      // server authorization, so SUB+PING/PONG is the publication barrier.
      // A permissions -ERR rejects flush and the account stays private.
      try {
        channel.subscribeRegister();
        await transport.flush(attemptAbort.signal);
      } catch (err) {
        const cause = privateFailure ?? err;
        const closeReport = (await dispose()).transport;
        if (ctx.abortSignal.aborted) {
          return { kind: "completed" as const, closeReport };
        }
        return { kind: "failed" as const, cause, closeReport };
      }

      if (ctx.abortSignal.aborted || preCommitPoisoned || !transport.connected) {
        const closeReport = (await dispose()).transport;
        if (ctx.abortSignal.aborted) return { kind: "completed" as const, closeReport };
        return {
          kind: "failed" as const,
          cause: privateFailure ?? new NatsConnectionClosedError(1006, false),
          closeReport,
        };
      }

      const readiness = formatAccountReadiness({
        accountId,
        admission,
        ...(effIssuer !== undefined ? { issuer: effIssuer } : {}),
        ...(effAudience !== undefined ? { audience: effAudience } : {}),
        ...(jwks !== undefined ? { jwks } : {}),
        ...(accountDmSecurity !== undefined ? { dmSecurity: accountDmSecurity } : {}),
      });
      if (readiness.verdict === "FAIL") log("error", readiness.line);
      else if (readiness.verdict === "WARN") log("warn", readiness.line);
      else log("info", readiness.line);

      const rollbackPublication = () => {
        if (runtimeRef && accountRuntimes.get(accountId) === runtimeRef) accountRuntimes.delete(accountId);
        published = false;
        try { reportServingAggregate(api); } catch { /* rollback continues */ }
        if (boundChannel === channel) boundChannel = null;
        try { rebindPrimary(); } catch { boundChannel = null; }
        setStatus(accountNeverServedStatusPatch({ restartPending: false, reconnectAttempts: failedAttempts, lastError: "account publication rolled back" }));
      };
      let publicationFailureState: {
        poisoned: boolean;
        privateFailure: unknown;
        connected: boolean;
      } | undefined;
      try {
        // Phase D is intentionally synchronous after the server-confirmed
        // register-subscription barrier. The serving status write is the final
        // throwing operation in this fence; a failure unpublishes synchronously
        // before disposal is awaited.
        const committed = commitAccountPublication<AccountRuntime>({
          publish: () => {
            if (ctx.abortSignal.aborted || preCommitPoisoned || !transport.connected) {
              throw new Error("account lost ownership or connection during commit");
            }
            runtimeRef = {
              accountId,
              tenant,
              channel,
              transport,
              ...(enrolled ? { enrolled } : {}),
              auth: accountAuth.auth,
              historyConfig,
              sessionTokens,
              inboundDebouncer: inboundDebouncer!,
              inboundDispatcher: inboundDispatcher!,
              owner: ownerIdentity,
              dispose,
            };
            accountRuntimes.set(accountId, runtimeRef);
            published = true;
            rebindPrimary();
            return runtimeRef;
          },
          writeServingStatus: () => writeStatus({
            connected: true,
            restartPending: false,
            reconnectAttempts: 0,
            lastConnectedAt: Date.now(),
            lastError: null,
          }),
          rollback: rollbackPublication,
          dispose,
          captureFailureState: () => {
            publicationFailureState = {
              poisoned: preCommitPoisoned,
              privateFailure,
              connected: transport.connected,
            };
          },
        });
        if (committed instanceof Promise) await committed;
        reportServingAggregate(api);
        markCommitted();
      } catch (err) {
        // If the helper already disposed, its synchronous snapshot still
        // records whether a real private loss preceded rollback. For failures
        // after a successful helper return, capture current state now.
        const failureState = publicationFailureState ?? {
          poisoned: preCommitPoisoned,
          privateFailure,
          connected: transport.connected,
        };
        rollbackPublication();
        const rollback = await dispose();
        if (ctx.abortSignal.aborted) {
          return { kind: "completed" as const, closeReport: rollback.transport };
        }
        return resolveAccountPublicationFailure({
          state: failureState,
          cause: err,
          closeReport: rollback.transport,
        });
      }

      await waitForAbort(ctx.abortSignal);
      if (runtimeRef && accountRuntimes.get(accountId) === runtimeRef && runtimeRef.owner === ownerIdentity) {
        accountRuntimes.delete(accountId);
        published = false;
        reportServingAggregate(api);
        if (boundChannel === channel) boundChannel = null;
        try { rebindPrimary(); } catch { boundChannel = null; }
        setStatus({ connected: false, restartPending: false, reconnectAttempts: 0, lastError: null });
      }
      const disposeReport = await dispose();
      const closeReport = disposeReport.transport;
      if (disposeReport.errors.length > 0) {
        log("warn", `event=webchannel.account_cleanup accountId=${formatAccountIdForLog(accountId)} errors=${disposeReport.errors.length}`);
      }
      log("info", `event=webchannel.account_startup accountId=${formatAccountIdForLog(accountId)} state=stopped attempt=${attempt}`);
      return { kind: "completed" as const, closeReport };
      } catch (err) {
        if (err instanceof AccountRunFailure) throw err;
        const rollback = await dispose();
        if (!rollback.transport.reconnectSuppressed || !rollback.transport.socketClosed) {
          throw new AccountRunFailure("account wiring failed and transport closure is unconfirmed", rollback.transport, { cause: err });
        }
        if (ctx.abortSignal.aborted) return { kind: "completed" as const, closeReport: rollback.transport };
        return { kind: "failed" as const, cause: err, closeReport: rollback.transport };
      }
        },
      });
    }

    return undefined;
}

async function startNatsAccountLifecycle(ctx: any): Promise<void> {
  await accountCoordinator.runAccount(ctx.accountId, ctx.abortSignal, async (owner, install) => {
    const executionApi = createAccountExecutionApi(install, ctx.cfg);
    const closeReport = await buildNatsAccount(executionApi, ctx, owner);
    return closeReport ? {
      closeReport,
      ...(closeReport.closeHandle ? { probePhysicalClose: closeReport.closeHandle.probe } : {}),
    } : undefined;
  }, ({ accountId, generation, logger }) => {
    notifyAccountQuarantine({
      accountId,
      generation,
      setStatus: (status) => ctx.setStatus?.({ accountId, ...status }),
      logger,
    });
  });
}

export default defineChannelPluginEntry({
  id: "webchannel",
  name: "WebChannel NATS",
  description: "NATS-based WebChannel plugin (AC 5 cutover).",
  plugin: webChannelPlugin,
  registerFull(api) {
    if (api.registrationMode !== "full") return;
    // #87: one lifecycle subscription per plugin generation, owned here so the
    // host can tear it down. `onAgentEvent` registers on a process-global
    // listener set, so without this a reload would stack a listener per
    // generation for the lifetime of the process.
    startAgentLifecycleSubscription(api);
    api.lifecycle?.registerRuntimeLifecycle?.({
      id: "webchannel-agent-lifecycle-verdicts",
      description: "Releases the #87 turn-outcome lifecycle subscription.",
      cleanup: () => {
        stopAgentLifecycleSubscription();
      },
    });
    accountCoordinator.installFull(api);
    api.logger.info(
      `webchannel: loaded plugin bundle (plugin=webchannel, source=${LOADED_PLUGIN_BUNDLE_PATH})`,
    );
  },
});
