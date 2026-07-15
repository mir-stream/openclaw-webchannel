/**
 * WebChannel Plugin Entry — NATS mode (AC 5).
 *
 * This is the NEW plugin entry for AC 5's NATS cutover.
 * It replaces gateway-WS NATS peer channel with NATS-based messaging.
 *
 * Key changes from original index.ts:
 * - NATS peer channel → NatsChannel
 * - WebSocket upgrade route → Peer registration via JWT verification
 * - Direct NATS pub/sub instead of WebSocket frame relay
 * - Multi-peer sessions preserved via peerId routing
 * - Approvals use NATS first-write-wins exactly-once
 */

import { AsyncResource } from "node:async_hooks";

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { NatsChannel } from "./src/nats-channel.js";
import type { RegisterChannelSurface } from "./src/nats-channel.js";
import type { InboundWsMessage, NatsChannelCryptoOptions } from "./src/nats-channel.js";
import { ConversationKeyStore } from "./src/conversation-key-store.js";
import { resolveEncryptionPolicy } from "./src/encryption-policy.js";
import type { WebchannelEncryptionConfig } from "./src/encryption-policy.js";
import { createWebChannelPlugin } from "./src/channel.js";
import { handleInboundMessage } from "./src/inbound.js";
import {
  createSerializedInboundDispatcher,
  coalesceUserMessages,
} from "./src/inbound-queue.js";
import { isControlLaneMessage, shouldDropBufferedInputOnStop } from "./src/control-lane.js";
import { resolveCommandGate } from "./src/command-gate.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/reply-runtime";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { createIngressOnFlush, recordCancelledInboundItems } from "./src/ingress-dedupe.js";
import {
  handleApprovalDecision,
  listPendingApprovalsForPeer,
  listResolvedApprovalsForPeer,
  ApprovalBindingMissingError,
} from "./src/approvals.js";
import { assertJwtAuthConfig, verifyJwtAndExtractIdentity, preflightResolveJwks } from "./src/auth.js";
import type { AuthConfig, JwtAuthConfig } from "./src/auth.js";
import { formatAccountReadiness, deriveJwksUrl, deriveIssuer, type JwksReadiness } from "./src/preflight.js";
import { PopChallengeStore } from "./src/pop-challenge.js";
import { handleRegisterRequest } from "./src/nats-register.js";
import { resolveAdmissionMode, admissionServingPlan } from "./src/nats-admission.js";
import { isDmPostureOpen } from "./src/dm-allowlist.js";
import { recent as historyRecent, pageBefore as historyPageBefore, resolveHistoryConfig, planHistoryFetch } from "./src/history.js";
import { createCommandCatalogProvider } from "./src/commands-catalog.js";
import { resolveWebchannelSessionRoute } from "./src/session-route.js";
import { WEBCHANNEL_ID, type WebChannelPeerChannel } from "./src/channel-contract.js";
import type { NatsTransport } from "./src/nats-transport.js";
import type { EnrolledNatsConnection } from "./src/enrolled-nats-connection.js";
import {
  resolveNatsCredentialSource,
  type NatsCredentialSource,
  type WebchannelNatsConfig,
} from "./src/nats-credential-source.js";
import { consumeCredentialSource } from "./src/consume-credentials.js";
import { planAccounts } from "./src/multiplex.js";
import {
  loadPersistedEnrolledCreds,
  resolveTypingEnabled,
} from "./src/account-config.js";
import type { KeyPair } from "./src/e2e-crypto.js";
import { devOpenAgentIdentityKeyPair } from "./src/dev-identity.js";

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
  /**
   * The `channels.webchannel.auth` verifier — built ONLY for a `register-hop`
   * account. An `auto` account admits peers via the NATS wildcard + X25519
   * handshake and has no verifier, so this is optional. (Register verifies via
   * `verifyJwtAndExtractIdentity` against `auth`, not this field; it is retained
   * to fail loudly on a register-hop account's verifier misconfig.)
   */
  auth: AuthConfig | undefined;
  historyConfig: ReturnType<typeof resolveHistoryConfig>;
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
  nats?: { url?: string; devOpen?: boolean };
  saas?: { baseUrl?: string };
};

/** accountId → runtime, built once per process (idempotent across re-warms). */
const accountRuntimes = new Map<string, AccountRuntime>();
/** Idempotency guard: the async per-account build runs once per process. */
let accountsBuildStarted = false;

/**
 * Detached async-context for history self-reads.
 *
 * History hydration calls `api.runtime.subagent.getSessionMessages`, which
 * dispatches the gateway `sessions.get` method — and that method authorizes
 * against whatever operator client is ambient in the current gateway-request
 * scope. The initial-snapshot read happens inside the register-request handler,
 * whose ambient client is the plugin-auth client (no `operator.read`), so the
 * dispatch is rejected with `missing scope: operator.read` and history silently
 * degrades to `[]`.
 *
 * openclaw's own `deleteSession` sidesteps this by forcing a synthetic operator
 * client, but `getSessionMessages` exposes no such option to plugins. The one
 * lever a plugin has is the *calling context*: with NO ambient scoped client the
 * dispatcher falls through to a synthetic `operator.write` client (which implies
 * `operator.read`) and the read succeeds.
 *
 * This `AsyncResource` is constructed at module-evaluation time — before any
 * request scope can exist — so `runInAsyncScope` re-establishes that clean,
 * client-less context. Running the history read inside it escapes the request's
 * restricted client without touching openclaw core. See `docs/DEMO_PLAN.md`.
 */
const historyReadScope = new AsyncResource("webchannel:history-read");
const runDetachedHistoryRead = <T>(fn: () => Promise<T>): Promise<T> =>
  historyReadScope.runInAsyncScope(fn);

/**
 * Trust-anchor derivation (design §4 change 1): fill the ABSENT JWT-verify params
 * from `{saas.baseUrl, accountId}` — CONFIG-PRESENT-WINS. These are trust FACTS,
 * not settings, and cannot legitimately mismatch:
 *   - issuer  = SaaS-DELIVERED (EnrollmentResult.issuer, persisted with the
 *               enrolled creds) when present, else saas.baseUrl (back-compat
 *               derivation for pre-issuer enrollments / non-enrolled accounts)
 *   - audience = accountId    (bootstrap JWTs are minted with `aud == accountId`)
 *   - jwksUrl  = saas.baseUrl + /.well-known/jwks.json
 * An explicitly-configured value is an operator PIN (proxy / custom-domain /
 * logical-issuer) and ALWAYS wins — we only fill fields that are absent.
 * Issuer precedence: pin > delivered > derived. The delivered value is used
 * VERBATIM (verifyJwt compares slash-insensitively) — the SaaS declared the
 * exact `iss` it mints at enroll time; re-deriving it here from the base URL is
 * exactly the configuration-by-coincidence this field exists to kill.
 *
 * Returns a NEW object (never mutates the caller's config). Non-jwt (or absent)
 * auth is returned unchanged.
 *
 * Fail-closed: when `saasBaseUrl` is undefined AND the params are absent we fill
 * NOTHING — `makeJwtVerifier` then throws and the jwt account is skipped with a
 * loud log (Step 6). Missing verify params NEVER downgrade an account to `auto`
 * (`admission` is a separate PINNED config default, not derived here). jwksUrl is
 * derived ONLY when no key source (jwksUrl/jwks/jwksFile) is configured, because
 * `makeJwtVerifier` requires EXACTLY ONE — we must not introduce a second.
 */
function deriveAccountAuth(
  raw: AuthConfig | undefined,
  saasBaseUrl: string | undefined,
  accountId: string,
  deliveredIssuer?: string,
): AuthConfig | undefined {
  if (!raw || raw.strategy !== "jwt" || !saasBaseUrl) return raw;
  // Runtime view: a pointer-style account legitimately OMITS these fields (the
  // `as AuthConfig` cast at the read site types them as required, but config may
  // leave them absent — that is exactly what we are filling in here).
  const jwt = (raw.jwt ?? {}) as {
    jwksUrl?: string;
    jwks?: unknown;
    jwksFile?: string;
    issuer?: string;
    audience?: string;
  };
  const hasKeySource =
    typeof jwt.jwksUrl === "string" || jwt.jwks !== undefined || typeof jwt.jwksFile === "string";
  return {
    ...raw,
    jwt: {
      ...jwt,
      // pin > delivered > derived. The derivation goes via the shared canonical
      // helper (trailing-slash stripped), matching the jwksUrl derivation —
      // otherwise an operator's trailing-slash --base-url would pin a
      // non-canonical issuer that mismatches the SaaS's minted `iss` and
      // rejects every bootstrap JWT (silent issuer-mismatch).
      issuer: jwt.issuer ?? deliveredIssuer ?? deriveIssuer(saasBaseUrl),
      audience: jwt.audience ?? accountId,
      ...(hasKeySource ? {} : { jwksUrl: deriveJwksUrl(saasBaseUrl) }),
    },
  } as AuthConfig;
}

/**
 * Lazy transport facade.
 *
 * `createWebChannelPlugin` needs a transport at module-load time, but in NATS
 * mode the real `NatsChannel` only exists after enrollment (inside
 * `registerFull`). This Proxy forwards every transport method call to the live
 * `NatsChannel` once it is bound; before binding, method calls are no-ops
 * returning `false`. `NatsChannel` implements the outbound surface the plugin's
 * message/outbound adapters use (sendText, untargeted fallback, sendProgress,
 * finalizeDraft, sendTyping, sendApprovalRequest/Resolved).
 */
let boundChannel: NatsChannel | null = null;
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
 * resolver reads the live map at call time (the map fills in `registerFull`,
 * well before any approval can fire); an unscoped (null) context reads the
 * `"default"` account, and an unknown account falls back to the lazy facade
 * inside the capability (legacy primary behavior, never a dropped frame).
 */
const webChannelPlugin = createWebChannelPlugin(lazyTransport, {
  resolveApprovalTransport: (accountId) =>
    accountRuntimes.get(accountId ?? "default")?.channel,
});

export default defineChannelPluginEntry({
  id: "webchannel",
  name: "WebChannel NATS",
  description: "NATS-based WebChannel plugin (AC 5 cutover).",
  plugin: webChannelPlugin,

  async registerFull(api) {
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
      channel: NatsChannel,
      historyConfig: ReturnType<typeof resolveHistoryConfig>,
      peerId: string,
    ): void => {
      try {
        // Same forced per-account-channel-peer key as the inbound WRITE site —
        // so the snapshot reads THIS user's session, never the shared "main" one.
        const route = resolveWebchannelSessionRoute(api, accountId, peerId);
        void runDetachedHistoryRead(() =>
          historyRecent(api, route.sessionKey, historyConfig.limit, api.logger),
        )
          .then((messages) => {
            if (messages.length > 0) channel.sendHistory(peerId, messages);
          })
          .catch((err) => {
            api.logger.error?.(
              `webchannel: history snapshot failed for ${peerId}: ${String(err)}`,
            );
          });
      } catch (err) {
        api.logger.error?.(
          `webchannel: history snapshot resolution failed for ${peerId}: ${String(err)}`,
        );
      }
    };

    // -----------------------------------------------------------------------
    // Steps 0–7 (per account): build ONE serving runtime per configured account
    // -----------------------------------------------------------------------

    // Idempotency: openclaw pre-warms plugins, so `registerFull` can run more
    // than once per process. Build the per-account runtimes (each with its own
    // NATS connection + `.register` subscription) exactly once; later invocations
    // are a no-op.
    if (accountsBuildStarted) {
      console.log("[webchannel] ✓ NATS mode plugin registered (accounts already built)");
      return;
    }
    accountsBuildStarted = true;

    // Narrow ONCE against the channel-plugin config extensions plugin-sdk's
    // `OpenClawConfig` does not declare (see `WebchannelChannelConfig`). Every
    // top-level `nats`/`saas` read below goes through this local.
    const config = api.config as typeof api.config & WebchannelChannelConfig;
    const legacyNats = config.nats;

    // Phase 3 planning (pure): list accounts. The wire identity is the accountId
    // itself (unique by construction), so there are no structural pre-I/O skips.
    // Order is deterministic (sorted accountIds).
    const plans = planAccounts(api.config, {
      warn: (msg) => (api.logger?.warn ?? console.warn)?.(msg),
    });

    // Fix #7: shared-audience cross-account guard. Register admission is chosen
    // purely by the `.register` subject (accountId segment), NOT by the token's
    // aud. So if two register-hop accounts on this gateway share the same (issuer,
    // audience), a token minted for one VERIFIES against the other's subject →
    // that peer would get the WRONG account's conversation key + history. The
    // deleted register-dispatch map used to catch this via an aud→account
    // collision warning; re-add that detection here. Keyed by (issuer, audience);
    // value = the first register-hop accountId that claimed it.
    const registerHopAudClaims = new Map<string, string>();

    for (const plan of plans) {
      const { accountId, tenant, account } = plan;
      // Derive the EFFECTIVE account auth ONCE, here — every downstream consumer
      // below (the shared-audience guard, the connection verifier via
      // `assertJwtAuthConfig`, the register-path `verifyIdentity`, and the published
      // `AccountRuntime.auth`) reads this single local, so they all see the
      // effective (derived) issuer/jwksUrl/audience, per the design's "diagnostics
      // must read the effective values" constraint. See `deriveAccountAuth` above
      // for the config-present-wins + fail-closed rationale.
      const accountAuth = deriveAccountAuth(
        account.auth as AuthConfig | undefined,
        // Match the consume block's precedence (:277): plan-resolved base URL
        // (config `saas.baseUrl` over acquisition env) falls back to the flat
        // top-level `saas.baseUrl`.
        plan.saasBaseUrl ?? config.saas?.baseUrl,
        accountId,
        // SaaS-delivered issuer, persisted with the enrolled creds at
        // `channels add` time (EnrollmentResult.issuer). Same loader the
        // consume step uses later — ONE reader, so the two paths can't drift.
        // Returns undefined for non-enrolled accounts / pre-issuer creds →
        // the derivation fallback applies.
        loadPersistedEnrolledCreds(accountId)?.issuer,
      );
      const accountNatsCfg = account.nats as WebchannelNatsConfig | undefined;
      const accountEncryption = account.encryption as WebchannelEncryptionConfig | undefined;
      const accountDmSecurity = account.dmSecurity as string | undefined;

      // Obsolete-config tidy: the register hop moved from HTTP to NATS, so the
      // old `auth.cors` browser-origin allowlist no longer applies and is silently
      // ignored. Warn (once per account, at startup) so an operator carrying a
      // stale block isn't misled into thinking origin restriction is still active.
      const rawAuth = account.auth as Record<string, unknown> | undefined;
      if (rawAuth && typeof rawAuth === "object" && "cors" in rawAuth) {
        (api.logger?.warn ?? console.warn)?.(
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
        (api.logger?.error ?? console.error)?.(
          `[webchannel] account "${accountId}" encryption misconfig — skipping ` +
            `(refusing to serve without E2E encryption): ${(err as Error).message}`,
        );
        continue;
      }

      // ---- Step 1 (per account): resolve credential source + CONSUME -------
      let transport: NatsTransport;
      let enrolled: EnrolledNatsConnection | undefined;
      let credentialMode: NatsCredentialSource["mode"];
      // F2: the agent's SaaS-attested identity key from the enrolled creds (set
      // only on the enrolled path). The register-hop channel wraps K under it.
      let identityKey: KeyPair | undefined;
      try {
        const source = resolveNatsCredentialSource({
          natsConfig: accountNatsCfg,
          legacyNats,
          saasBaseUrl: plan.saasBaseUrl ?? config.saas?.baseUrl,
          tenant,
          accountId,
        });
        credentialMode = source.mode;
        const consumed = await consumeCredentialSource(source, accountId);
        if (consumed.status === "creds-missing") {
          // Account-scoped graceful degradation (creds missing/expired): skip
          // serving THIS account with an actionable log. No runtime enroll, no
          // polling, no hang; other accounts/channels and the process are fine.
          (api.logger?.warn ?? api.logger?.error ?? console.warn)?.(
            `[webchannel] account "${consumed.accountId}" has no enrolled credentials — ` +
              `skipping serving this account. Run: openclaw channels add --channel ` +
              `webchannel --account ${consumed.accountId}`,
          );
          continue;
        }
        // Log the EFFECTIVE relay (consumed.dialedUrl), not the resolver's
        // `source.url`: for enrolled mode the SaaS-delivered `natsUrl` wins, so
        // these can differ — printing the dialed URL keeps the log truthful.
        console.log(
          `[webchannel] account "${accountId}" credential source: ${source.mode} → ${consumed.dialedUrl}`,
        );
        transport = consumed.connection.transport;
        if (consumed.connection.enrolled) enrolled = consumed.connection.enrolled;
        identityKey = consumed.identityKey;
        // Review 2026-07-02 (C1): attach a post-handshake "error" listener so a
        // transient NATS failure (server restart → TCP reset; a post-connect
        // `-ERR Permissions Violation`) is logged with account context —
        // instead of crashing the WHOLE gateway process. NatsTransport also
        // self-guards against a missing listener, but attaching one here gives
        // structured operator logging.
        transport.on("error", (err: Error) => {
          (api.logger?.error ?? console.error)?.(
            `[webchannel] account "${accountId}" NATS transport error: ${err.message} ` +
              `(connection dropped; auto-reconnect with backoff is active — S1)`,
          );
        });
        // S1: log recovery too — without this the operator sees the drop but
        // never learns the account healed itself.
        transport.on("reconnect", () => {
          (api.logger?.info ?? console.log)?.(
            `[webchannel] account "${accountId}" NATS connection re-established; subscriptions replayed`,
          );
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (api.logger?.warn ?? api.logger?.error ?? console.warn)?.(
          `[webchannel] account "${accountId}" NATS connection failed — skipping this account (${msg})`,
        );
        continue;
      }

      // ---- Axis B (per account): peer admission -----------------------------
      // Resolved BEFORE the channel is built (Phase 6): a `register-hop`
      // account gets an agent-owned ConversationKeyStore — its peers' stable
      // key K is wrap-delivered via the register HTTP response and the legacy
      // `.handshake` is disabled — while an `auto` account gets NO store and
      // keeps the per-device handshake untouched (F5 decision).
      const registerHopAvailable = credentialMode !== "static";
      const admission = resolveAdmissionMode({
        authStrategy: (accountAuth as { strategy?: string } | undefined)?.strategy,
        registerHopAvailable,
        explicitOverride: accountNatsCfg?.admission,
      });
      // The serving plan makes the ONE structural consequence of `admission`
      // explicit and testable: only a `register-hop` account builds a verifier
      // and an aud→account dispatch entry; an `auto` account subscribes the
      // wildcard and is served with NO `channels.webchannel.auth` config.
      const servingPlan = admissionServingPlan(admission);
      // Phase 6 review finding 1 (RESOLVED, not warned): a multi-user
      // (register-hop) account no longer risks the SHARED-transcript leak on the
      // history snapshot / load_history paths — webchannel FORCES its own
      // per-account-channel-peer session scope regardless of the operator's
      // global session.dmScope (see src/session-route.ts). The old startup
      // dmScope="main" warning is therefore gone; the readiness line below
      // reports the ENFORCED scope instead.

      // Fix #7: detect two register-hop accounts sharing the same (issuer, aud).
      // Only register-hop + jwt accounts admit by verifying a token, so only they
      // can be cross-verified by a shared audience. Warn loudly naming both.
      if (admission === "register-hop" && (accountAuth as { strategy?: string } | undefined)?.strategy === "jwt") {
        const jwtBlock = (accountAuth as { jwt?: { issuer?: string; audience?: string } }).jwt;
        const issuer = jwtBlock?.issuer;
        const audience = jwtBlock?.audience;
        if (issuer && audience) {
          // Normalize the issuer the SAME way verifyJwt compares it (trailing
          // slash collapsed) — otherwise a config-pinned "https://x/" and a
          // derived "https://x" would key as DISTINCT here yet CROSS-VERIFY at
          // runtime, so this guard would miss exactly the collision it exists to
          // name (a bootstrap JWT for one account admitting on the other's subject).
          const key = `${deriveIssuer(issuer)} ${audience}`;
          const firstAccount = registerHopAudClaims.get(key);
          if (firstAccount && firstAccount !== accountId) {
            (api.logger?.warn ?? console.warn)?.(
              `[webchannel] SHARED-AUDIENCE MISCONFIG: register-hop accounts "${firstAccount}" and ` +
                `"${accountId}" share the same jwt (issuer="${issuer}", audience="${audience}"). ` +
                `A bootstrap JWT minted for one will VERIFY against the other's .register subject → ` +
                `the peer would receive the WRONG account's conversation key + history. Give each ` +
                `register-hop account a DISTINCT audience (= its accountId).`,
            );
          } else if (!firstAccount) {
            registerHopAudClaims.set(key, accountId);
          }
        }
      }

      // ---- F2: resolve the register-hop wrap identity key -------------------
      // A register-hop account wraps the conversation key K under the agent's
      // SaaS-attested identity key so the browser can authenticate it. K MUST be
      // wrapped under an ATTESTED key on every non-dev path:
      //  - ENROLLED mode (production): the key comes from the persisted creds. If
      //    it is absent (pre-F2 creds / malformed block) we SKIP serving.
      //  - STATIC creds + explicit `nats.admission:"register-hop"` (a legitimate
      //    bring-your-own-NATS production shape — the override is honored verbatim,
      //    nats-admission.ts): there is a real untrusted relay, so an unattested
      //    key would re-open the MITM. Also SKIP serving — BYON register-hop still
      //    requires an enrolled/attested identity key.
      //  - open mode ONLY (`WEBCHANNEL_NATS_DEV_OPEN` / devOpen / credentials.mode
      //    "open" — the genuine dev/e2e knob, no untrusted relay in the threat
      //    model): fall back to the WELL-KNOWN dev identity key so the dev browser
      //    drivers can pin it. This is the ONLY path that may wrap under the public
      //    dev key.
      // Auto accounts never wrap K, so they never reach this block.
      let registerHopIdentityKey = identityKey;
      if (admission === "register-hop" && !registerHopIdentityKey) {
        if (credentialMode === "open") {
          registerHopIdentityKey = devOpenAgentIdentityKeyPair();
          (api.logger?.warn ?? console.warn)?.(
            `[webchannel] account "${accountId}" register-hop on DEV-OPEN NATS with no enrolled ` +
              `identity key — using the WELL-KNOWN DEV identity key to wrap K (DEV/E2E ONLY, NOT ` +
              `attested; this key is public, so an untrusted relay could MITM — never use dev-open ` +
              `in production).`,
          );
        } else {
          // enrolled (production) OR static (BYO-NATS production) with no attested
          // key → fail closed. Never wrap K under the public dev key on a path that
          // faces a real relay.
          (api.logger?.error ?? console.error)?.(
            `[webchannel] account "${accountId}" is register-hop (${credentialMode}) but has no ` +
              `agent identity key — refusing to serve (the browser could not authenticate the ` +
              `conversation key; wrapping under the public dev key would re-open the relay MITM). ` +
              `Enroll to mint an attested identity key: openclaw channels add --channel webchannel ` +
              `--account ${accountId}`,
          );
          continue;
        }
      }

      // ---- Step 2 (per account): create the encrypted NATS channel ---------
      // Subject namespace is webchannel.{tenant}.{accountId}.{peerId} — the
      // accountId is the wire identity (one namespace per account).
      const channel = new NatsChannel(transport, accountId, tenant, {
        ...cryptoOptions,
        ...(admission === "register-hop"
          ? {
              keyStore: new ConversationKeyStore({ accountId }),
              // Guaranteed present: enrolled/static → persisted attested key (else
              // skipped above); dev-open → the well-known dev key.
              identityKeyPair: registerHopIdentityKey,
            }
          : {}),
      });
      console.log(
        `[webchannel] account "${accountId}" ✓ encrypted NATS channel (tenant=${tenant}, accountId=${accountId})`,
      );

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
      type WebchannelUserMessage = Extract<
        InboundWsMessage,
        { type: "user_message" }
      >;
      const inboundDispatcher =
        createSerializedInboundDispatcher<WebchannelUserMessage>(
          (peerId, message) =>
            handleInboundMessage(
              api,
              channel,
              peerId,
              message,
              accountId,
            ),
          {
            // P1-8b layer (b): busy-time coalesce. A message that arrives while a
            // turn is already running for its session buffers and is merged into
            // ONE follow-up turn on completion (Telegram parity), instead of
            // chaining a separate turn each.
            coalesce: coalesceUserMessages,
          },
        );
      const dispatchInbound = inboundDispatcher.dispatch;

      // P0-7a: per-account ingress idempotency. Each `user_message` carries a
      // stable client `id`; we record `${peerId}:${id}` at admission with a 7-day
      // window (Telegram parity) and drop a duplicate frame before it runs a
      // second turn. ONE instance PER ACCOUNT — namespace = accountId, so ids are
      // isolated per account and a peer cannot poison another peer's ids. We use
      // `createPersistentDedupe` (record-at-ingress), NOT `createClaimableDedupe`
      // (claim/commit); the rationale for at-most-once admission over
      // claim/forget rollback lives in ingress-dedupe.ts. A disk fault degrades
      // to memory-only (onDiskError → warn) and never blocks inbound.
      const inboundDedupe = createPersistentDedupe({
        pluginId: WEBCHANNEL_ID,
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        memoryMaxSize: 2048,
        stateMaxEntries: 5000,
        onDiskError: (err) =>
          api.logger?.warn?.(
            `webchannel: account "${accountId}" ingress dedupe disk error ` +
              `(degrading to memory-only): ${String(err)}`,
          ),
      });

      // P1-8b layer (a): idle pre-run debounce (Telegram parity), REUSING core's
      // `createInboundDebouncer`. Sits IN FRONT of the per-session FIFO: rapid
      // same-peer messages within the debounce window flush together as ONE
      // merged turn. `resolveInboundDebounceMs` reads the GLOBAL config
      // (`messages.inbound.byChannel.webchannel ?? messages.inbound.debounceMs ??
      // 0`) — resolved ONCE here per account. The core default is 0ms, which makes
      // this layer inert (each message flushes immediately) unless an operator
      // opts in; layer (b) still coalesces busy-time regardless. We keep that
      // default (do NOT invent a nonzero one). Items carry `peerId` so `buildKey`
      // and `onFlush` can route; `serializeImmediate` guarantees same-peer flushes
      // never reorder even on the 0ms immediate path (core serializes same-key
      // flushes through its `keyChains`). `onFlush` calls `dispatchInbound`
      // SYNCHRONOUSLY, so a message arriving during a previous flush's merged turn
      // lands in layer (b)'s buffer rather than spawning a parallel turn.
      const inboundDebounceMs = resolveInboundDebounceMs({
        cfg: api.config,
        channel: WEBCHANNEL_ID,
      });
      const inboundDebouncer = createInboundDebouncer<{
        peerId: string;
        message: WebchannelUserMessage;
      }>({
        debounceMs: inboundDebounceMs,
        serializeImmediate: true,
        buildKey: (item) => item.peerId,
        // P0-7a ingress dedupe + P0-7b ingress ack. The REAL handler is
        // `createIngressOnFlush` (src/ingress-dedupe.ts) — extracted there so it
        // is tsc-checked and tested directly. Its doc owns the load-bearing
        // rationale (why the async dedupe belongs on this same-peer-serialized
        // flush path, the control-lane bypass, per-id record-before-coalesce, and
        // why the ack covers fresh + duplicates alike and precedes dispatch).
        // Split log sinks: routine duplicate drops at info, fail-open faults at
        // warn. `sendAck` (P0-7b) drains the client's replay ledger on ingress
        // ADMISSION (not turn success); P0-7a wired no ack (first half).
        onFlush: createIngressOnFlush<{
          peerId: string;
          message: WebchannelUserMessage;
        }>({
          accountId,
          checkAndRecord: (key, opts) => inboundDedupe.checkAndRecord(key, opts),
          dispatch: dispatchInbound,
          coalesce: coalesceUserMessages,
          sendAck: (peerId, ids) => channel.sendAck(peerId, ids),
          logInfo: (m) => api.logger?.info?.(m),
          logWarn: (m) => api.logger?.warn?.(m),
        }),
        onError: (err) =>
          api.logger.error?.(
            `webchannel: inbound debounce flush failed: ${String(err)}`,
          ),
        onCancel: (items) => {
          // P0-7b: a `/stop` cancels debounce-buffered messages that never reached
          // onFlush, so they were never dedupe-recorded and never acked — yet the
          // client's replay ledger still holds them. Record their ids (so an
          // in-flight replay is dropped as a duplicate) and ack them (drain the
          // ledger). onCancel is sync-shaped and checkAndRecord is async, so this
          // is best-effort fire-and-forget with a warn — a lost record only
          // re-opens the pre-existing pre-4b replay window (see the helper). Layer
          // (b) `clearPending` items are NOT handled here: they were already
          // acked+recorded at their own onFlush.
          void recordCancelledInboundItems(
            items,
            accountId,
            (key, opts) => inboundDedupe.checkAndRecord(key, opts),
            (peerId, ids) => channel.sendAck(peerId, ids),
            (m) => api.logger?.warn?.(m),
          ).catch((err) =>
            api.logger?.warn?.(
              `webchannel: cancelled-inbound handling failed: ${String(err)}`,
            ),
          );
        },
      });

      // Command-gate mirror (P1-8a follow-up), resolved ONCE per account. It
      // depends only on `api.config` + `accountId`, never on the message, so we
      // build it here rather than per abort. When an operator configures a
      // commands/owner allowlist, core IGNORES our control-lane
      // `access.commands.authorized` stamp and a non-listed peer's `/stop`
      // silently fails — this lets the control-lane branch below detect that and
      // send the peer a hedged notice. See src/command-gate.ts for the traced
      // core paths (all testable logic lives there; this file is tsc-blind).
      const commandGate = resolveCommandGate(api.config, accountId);
      channel.setMessageHandler((peerId, message) => {
        if (message.type !== "user_message") return; // approvals routed below
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
          //     vocabulary — a "wait"/"stop please" still aborts the running turn
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
            const debounceCancelled = inboundDebouncer.cancelKey(peerId);
            const pendingDropped = inboundDispatcher.clearPending(peerId);
            if (debounceCancelled || pendingDropped > 0) {
              api.logger?.info?.(
                `webchannel: /stop dropped buffered input for peer ${peerId} (debounced=${debounceCancelled}, pending=${pendingDropped})`,
              );
            }
          }
          // P0-7b: ack the control-lane frame here too. It bypasses the
          // debouncer/onFlush (and is never deduped), so without this its
          // client-side ledger entry would never drain and every reconnect would
          // replay the /stop. A replayed /stop that lands before this ack is a
          // harmless no-op abort (accepted).
          if (message.id) channel.sendAck(peerId, [message.id]);
          void handleInboundMessage(
            api,
            channel,
            peerId,
            message,
            accountId,
            { controlLane: true },
          ).catch((err) =>
            api.logger?.error?.(
              `webchannel: control-lane dispatch failed: ${String(err)}`,
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
          if (commandGate.delegated && !commandGate.isListed(peerId)) {
            channel.sendText(
              peerId,
              "Stop may not be permitted for this user: this agent restricts " +
                "commands to an operator allowlist.",
            );
          }
          return;
        }
        // Normal inbound: through layer (a) debounce → onFlush → per-session FIFO
        // (layer (b) coalesce). `enqueue` is fire-and-forget from here; attach a
        // rejection handler so a flush failure can't surface as an
        // unhandledRejection (the debouncer already routes onFlush throws to
        // `onError`, so this is belt-and-suspenders).
        void inboundDebouncer
          .enqueue({ peerId, message })
          .catch((err) =>
            api.logger?.error?.(
              `webchannel: inbound enqueue failed: ${String(err)}`,
            ),
          );
      });

      // ---- Axis B consequence: wildcard subscription (auto accounts) --------
      if (servingPlan.subscribeWildcard) {
        channel.subscribeWildcard();
      }
      if (admission === "auto" && isDmPostureOpen(accountDmSecurity)) {
        api.logger.warn?.(
          `webchannel: account "${accountId}" admission=auto with no dmSecurity allowlist — ` +
            "any peer with NATS access + a valid handshake is served; rely on NATS subject permissions.",
        );
      }

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
            api.logger.warn?.(`webchannel: approval resolve ignored (${id}): ${err.message}`);
          } else {
            api.logger.error?.(`webchannel: approval resolve failed (${id}): ${String(err)}`);
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
          const route = resolveWebchannelSessionRoute(api, accountId, peerId);
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
              api.logger.error?.(`webchannel: history page failed for ${peerId}: ${String(err)}`);
            });
        } catch (err) {
          api.logger.error?.(`webchannel: history resolution failed for ${peerId}: ${String(err)}`);
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
      // EXPOSURE DECISION (deliberate): unlike the history/approval snapshots —
      // which are register-hop-gated because they carry the user's own data —
      // the `commands` frame is served to ANY handshaken peer, including
      // wildcard / `admission:"auto"` peers. Auto-mode peers never call
      // registerPeer, so gating discovery on registration would kill the
      // typeahead in auto mode entirely. The catalog is low-sensitivity command
      // metadata (names / descriptions / args), already config-filtered by
      // buildCommandCatalog — so serving it to any handshaken peer is accepted.
      const catalogProvider = createCommandCatalogProvider(api.config);
      channel.setLoadCommandsHandler((peerId) => {
        try {
          channel.sendCommands(peerId, catalogProvider());
        } catch (err) {
          api.logger.error?.(
            `webchannel: command catalog failed for ${peerId}: ${String(err)}`,
          );
        }
      });

      // NOTE (Phase 6): the initial history snapshot is now sent from the
      // REGISTER route (stateless register — K is established there, and the
      // client subscribes `.out` before registering). The old
      // `setHandshakeCompleteHandler` snapshot wiring is gone: registered
      // peers no longer handshake at all, and the channel only ever fired that
      // callback for registered peers, so it could never fire again.

      // ---- Step 6 (per account): JWT verifier (register-hop accounts only) --
      // Only a `register-hop` account is gated by `channels.webchannel.auth`, so
      // only then do we build (and require) its verifier. A misconfigured jwt
      // auth on a register-hop account still fails loudly here — assertJwtAuthConfig
      // throws and we skip the account (never silently downgrading a broken jwt
      // account to auto). An `auto` account builds NO verifier and is served with
      // no `auth` config at all (invariant 1).
      // Effective (derived) trust facts for the readiness gate (Gate B) — read
      // from the DERIVED `accountAuth`, never raw `account.auth` (design §5).
      const effJwt = (accountAuth as { jwt?: { issuer?: string; audience?: string } } | undefined)?.jwt;
      const effIssuer = effJwt?.issuer;
      const effAudience = effJwt?.audience;

      if (servingPlan.buildVerifier) {
        try {
          assertJwtAuthConfig(accountAuth);
        } catch (err) {
          // Fail-closed: the verifier could not be built (missing/unresolvable
          // trust params). Emit a per-gate FAIL readiness line naming the
          // issuer/aud state — not just the raw thrown message — then skip the
          // account (never downgrade a broken jwt account to `auto`).
          const buildFail = formatAccountReadiness({
            accountId,
            admission,
            ...(effIssuer !== undefined ? { issuer: effIssuer } : {}),
            ...(effAudience !== undefined ? { audience: effAudience } : {}),
            buildError: (err as Error).message,
            ...(accountDmSecurity !== undefined ? { dmSecurity: accountDmSecurity } : {}),
          });
          (api.logger?.error ?? console.error)?.(buildFail.line);
          continue;
        }
      }

      // ---- Publish this account's runtime -----------------------------------
      accountRuntimes.set(accountId, {
        accountId,
        tenant,
        channel,
        transport,
        ...(enrolled ? { enrolled } : {}),
        auth: accountAuth,
        historyConfig,
      });

      // ---- Axis B consequence: register-hop admission over NATS -------------
      // A register-hop account wires the register-request handler and subscribes
      // its own `.register` wildcard (the NATS analogue of the old HTTP route).
      // An `auto` account does neither — it admits via the wildcard + handshake.
      if (servingPlan.subscribeRegister) {
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
        // NatsChannel a compile error — this file is outside `tsc`'s include set.
        const registerChannel: RegisterChannelSurface = channel;
        channel.setRegisterRequestHandler((subjectPeerId, payload, reply) => {
          // The handler is internally guarded (it replies REGISTER_FAILED on any
          // throw), but attach a `.catch` here too as defense-in-depth: a future
          // unguarded path must never surface as an unhandledRejection.
          void handleRegisterRequest({
            auth: accountAuth,
            subjectPeerId,
            payload,
            reply,
            verifyIdentity: (jwt, a) => verifyJwtAndExtractIdentity(jwt, a, api.logger),
            popChallenges: accountPopChallenges,
            registerPeer: (pid) => registerChannel.registerPeer(pid),
            wrapConversationKeyForDevice: (pid, key) =>
              registerChannel.wrapConversationKeyForDevice(pid, key),
            unregisterPeer: (pid) => registerChannel.unregisterPeer(pid),
            sendHistorySnapshot: (pid) =>
              sendHistorySnapshot(accountId, channel, historyConfig, pid),
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
            logger: api.logger,
          }).catch((err) => {
            api.logger?.error?.(
              `webchannel: register handler rejected for subject peerId "${subjectPeerId}": ${String(err)}`,
            );
          });
        });
        channel.subscribeRegister();
      }

      // ---- Step 7 (per account): startup readiness gate (Gate B) -----------
      // The account is now fully wired (verifier built, channel created,
      // register subscribed). Emit ONE structured readiness line reporting the
      // EFFECTIVE (derived) trust facts, or the precise failure. For a
      // register-hop jwt account we resolve the JWKS ONCE here (reusing the
      // account's live cache via `preflightResolveJwks`, which also primes the
      // very cache the register/challenge routes verify against) so the line can
      // report the key count — the single most useful diagnostic (an empty or
      // unreachable JWKS ⇒ no bootstrap JWT can ever verify). A transient JWKS
      // fetch failure is reported as a loud FAIL line but does NOT skip the
      // account: it is already fail-closed (no reachable keys ⇒ every register
      // verify is non-admit), and the cache retries per-register on the 5-min
      // TTL — permanently skipping on a momentary IdP hiccup would be worse.
      let jwks: JwksReadiness | undefined;
      if (
        servingPlan.buildVerifier &&
        (accountAuth as { strategy?: string } | undefined)?.strategy === "jwt"
      ) {
        try {
          jwks = await preflightResolveJwks(accountAuth as JwtAuthConfig);
        } catch (err) {
          jwks = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      const readiness = formatAccountReadiness({
        accountId,
        admission,
        ...(effIssuer !== undefined ? { issuer: effIssuer } : {}),
        ...(effAudience !== undefined ? { audience: effAudience } : {}),
        ...(jwks !== undefined ? { jwks } : {}),
        ...(accountDmSecurity !== undefined ? { dmSecurity: accountDmSecurity } : {}),
      });
      if (readiness.verdict === "FAIL") (api.logger?.error ?? console.error)?.(readiness.line);
      else if (readiness.verdict === "WARN") (api.logger?.warn ?? console.warn)?.(readiness.line);
      else (api.logger?.info ?? console.log)?.(readiness.line);
    }

    // Bind the lazy transport facade to a PRIMARY channel for core-initiated
    // (untargeted) outbound. Inbound replies already route per-account via each
    // channel's own dispatcher, and APPROVALS now route per-account too (S1):
    // the approval capability resolves the originating account's channel via
    // `resolveApprovalTransport` above, so the facade only backstops an
    // unknown-account fallback there. Prefer "default", else the first built
    // account.
    //
    // Remaining follow-up (S1 outbound leg): core-initiated UNTARGETED sends
    // (`untargeted fallback` etc.) are still primary-only — a peerId registered on
    // BOTH the primary AND a non-primary account could receive the primary
    // account's proactive outbound. Decide semantics when agent-initiated
    // outbound is built (docs/BACKLOG.md S1).
    const primary = accountRuntimes.get("default") ?? [...accountRuntimes.values()][0];
    boundChannel = primary ? primary.channel : null;

    // -----------------------------------------------------------------------
    // Step 9: Keep the NATS connections alive (best-effort, all accounts)
    // -----------------------------------------------------------------------
    const keepAlive = (api.runtime.channel as { keepAlive?: (opts: { handler: () => Promise<void> }) => void }).keepAlive;
    if (typeof keepAlive === "function") {
      keepAlive({
        async handler() {
          for (const rt of accountRuntimes.values()) {
            if (!rt.transport.connected) {
              console.log(`[webchannel] account "${rt.accountId}" NATS disconnected, awaiting reconnect...`);
            }
          }
        },
      });
    }

    // S2: restore operator visibility. A green ✓ with "0 serving" would mask a
    // misconfig (e.g. a single-"default" encryption fat-finger) as a healthy-
    // looking permanent 503. When NOTHING serves, emit an ERROR (not ✓) naming
    // the cause; keep the ✓ only when ≥1 account actually serves.
    if (accountRuntimes.size === 0) {
      (api.logger?.error ?? console.error)?.(
        `[webchannel] NO webchannel accounts are serving — all ${plans.length} configured ` +
          `account(s) were skipped (misconfig: encryption ` +
          `policy, missing credentials, or connection failure). The register routes will ` +
          `reply 503 until fixed; review the per-account skip logs above and re-run ` +
          `'openclaw channels add --channel webchannel'.`,
      );
    } else {
      console.log(
        `[webchannel] ✓ NATS mode plugin registered (${accountRuntimes.size} of ` +
          `${plans.length} configured account(s) serving)`,
      );
    }
  },
});
