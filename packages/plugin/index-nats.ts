/**
 * WebChannel Plugin Entry — NATS mode (AC 5).
 *
 * This is the NEW plugin entry for AC 5's NATS cutover.
 * It replaces gateway-WS WebChannelTransport with NATS-based messaging.
 *
 * Key changes from original index.ts:
 * - WebChannelTransport → NatsChannel
 * - WebSocket upgrade route → Peer registration via JWT verification
 * - Direct NATS pub/sub instead of WebSocket frame relay
 * - Multi-peer sessions preserved via peerId routing
 * - Approvals use NATS first-write-wins exactly-once
 */

import { AsyncResource } from "node:async_hooks";

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { NatsChannel } from "./src/nats-channel.js";
import type { InboundWsMessage, NatsChannelCryptoOptions } from "./src/nats-channel.js";
import { ConversationKeyStore } from "./src/conversation-key-store.js";
import { resolveEncryptionPolicy } from "./src/encryption-policy.js";
import type { WebchannelEncryptionConfig } from "./src/encryption-policy.js";
import { createWebChannelPlugin } from "./src/channel.js";
import { handleInboundMessage } from "./src/inbound.js";
import { createSerializedInboundDispatcher } from "./src/inbound-queue.js";
import { handleApprovalDecision } from "./src/approvals.js";
import { resolveVerifier, verifyJwtAndExtractIdentity, preflightResolveJwks, type ConnectionVerifier } from "./src/auth.js";
import type { AuthConfig, JwtAuthConfig } from "./src/auth.js";
import { formatAccountReadiness, deriveJwksUrl, deriveIssuer, type JwksReadiness } from "./src/preflight.js";
import { PopChallengeStore } from "./src/pop-challenge.js";
import { handleRegisterRequest } from "./src/nats-register.js";
import { resolveAdmissionMode, admissionServingPlan } from "./src/nats-admission.js";
import { isDmPostureOpen } from "./src/dm-allowlist.js";
import { recent as historyRecent, pageBefore as historyPageBefore, resolveHistoryConfig } from "./src/history.js";
import { resolveWebchannelSessionRoute } from "./src/session-route.js";
import type { WebChannelTransport } from "./src/transport.js";
import type { NatsTransport } from "./src/nats-transport.js";
import type { EnrolledNatsConnection } from "./src/enrolled-nats-connection.js";
import {
  resolveNatsCredentialSource,
  type NatsCredentialSource,
  type WebchannelNatsConfig,
} from "./src/nats-credential-source.js";
import { consumeCredentialSource } from "./src/consume-credentials.js";
import { planAccounts } from "./src/multiplex.js";
import { loadPersistedEnrolledCreds } from "./src/account-config.js";

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
  verifier?: ConnectionVerifier;
  auth: AuthConfig | undefined;
  historyConfig: ReturnType<typeof resolveHistoryConfig>;
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
 * message/outbound adapters use (sendText, sendTextToAnyOpen, sendProgress,
 * finalizeDraft, sendTyping, sendApprovalRequest/Resolved).
 */
let boundChannel: NatsChannel | null = null;
const lazyTransport = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    const target = boundChannel as unknown as Record<string, unknown> | null;
    if (!target) return () => false;
    const value = target[prop as string];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
}) as unknown as WebChannelTransport;

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
    accountRuntimes.get(accountId ?? "default")?.channel as unknown as
      | WebChannelTransport
      | undefined,
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

    const legacyNats = api.config.nats as { url?: string; devOpen?: boolean } | undefined;

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
      // `resolveVerifier`, the register-path `verifyIdentity`, and the published
      // `AccountRuntime.auth`) reads this single local, so they all see the
      // effective (derived) issuer/jwksUrl/audience, per the design's "diagnostics
      // must read the effective values" constraint. See `deriveAccountAuth` above
      // for the config-present-wins + fail-closed rationale.
      const accountAuth = deriveAccountAuth(
        account.auth as AuthConfig | undefined,
        // Match the consume block's precedence (:277): plan-resolved base URL
        // (config `saas.baseUrl` over acquisition env) falls back to the flat
        // top-level `saas.baseUrl`.
        plan.saasBaseUrl ?? api.config.saas?.baseUrl,
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
      try {
        const source = resolveNatsCredentialSource({
          natsConfig: accountNatsCfg,
          legacyNats,
          saasBaseUrl: plan.saasBaseUrl ?? api.config.saas?.baseUrl,
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

      // ---- Step 2 (per account): create the encrypted NATS channel ---------
      // Subject namespace is webchannel.{tenant}.{accountId}.{peerId} — the
      // accountId is the wire identity (one namespace per account).
      const channel = new NatsChannel(transport, accountId, tenant, {
        ...cryptoOptions,
        ...(admission === "register-hop"
          ? { keyStore: new ConversationKeyStore({ accountId }) }
          : {}),
      });
      console.log(
        `[webchannel] account "${accountId}" ✓ encrypted NATS channel (tenant=${tenant}, accountId=${accountId})`,
      );

      // ---- Step 3 (per account): inbound dispatcher (accountId-threaded) ----
      // Each account gets its OWN serialized dispatcher bound to its channel and
      // accountId, so inbound turns resolve THIS account's route (binding.account)
      // and replies deliver back over THIS account's channel.
      const { dispatch: dispatchInbound } = createSerializedInboundDispatcher<
        Extract<InboundWsMessage, { type: "user_message" }>
      >((peerId, message) =>
        handleInboundMessage(
          api,
          channel as unknown as WebChannelTransport,
          peerId,
          message,
          accountId,
        ),
      );
      channel.setMessageHandler((peerId, message) => {
        if (message.type !== "user_message") return; // approvals routed below
        dispatchInbound(peerId, message);
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
          api.logger.error?.(`webchannel: approval resolve failed (${id}): ${String(err)}`);
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
          void runDetachedHistoryRead(() =>
            historyPageBefore(api, route.sessionKey, request, historyConfig.pageSize, api.logger),
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

      // NOTE (Phase 6): the initial history snapshot is now sent from the
      // REGISTER route (stateless register — K is established there, and the
      // client subscribes `.out` before registering). The old
      // `setHandshakeCompleteHandler` snapshot wiring is gone: registered
      // peers no longer handshake at all, and the channel only ever fired that
      // callback for registered peers, so it could never fire again.

      // ---- Step 6 (per account): JWT verifier (register-hop accounts only) --
      // Only a `register-hop` account is gated by `channels.webchannel.auth`, so
      // only then do we build (and require) its verifier. A misconfigured jwt
      // auth on a register-hop account still fails loudly here — resolveVerifier
      // throws and we skip the account (never silently downgrading a broken jwt
      // account to auto). An `auto` account builds NO verifier and is served with
      // no `auth` config at all (invariant 1).
      // Effective (derived) trust facts for the readiness gate (Gate B) — read
      // from the DERIVED `accountAuth`, never raw `account.auth` (design §5).
      const effJwt = (accountAuth as { jwt?: { issuer?: string; audience?: string } } | undefined)?.jwt;
      const effIssuer = effJwt?.issuer;
      const effAudience = effJwt?.audience;

      let verifier: ConnectionVerifier | undefined;
      if (servingPlan.buildVerifier) {
        try {
          verifier = resolveVerifier(accountAuth, api.logger);
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
        ...(verifier ? { verifier } : {}),
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
            registerPeer: (pid) => channel.registerPeer(pid),
            wrapConversationKeyForDevice: (pid, key) =>
              channel.wrapConversationKeyForDevice(pid, key),
            unregisterPeer: (pid) => channel.unregisterPeer(pid),
            sendHistorySnapshot: (pid) =>
              sendHistorySnapshot(accountId, channel, historyConfig, pid),
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
    // (`sendTextToAnyOpen` etc.) are still primary-only — a peerId registered on
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
