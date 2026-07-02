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

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { NatsChannel } from "./src/nats-channel.js";
import type { InboundWsMessage, NatsChannelCryptoOptions } from "./src/nats-channel.js";
import { resolveEncryptionPolicy } from "./src/encryption-policy.js";
import type { WebchannelEncryptionConfig } from "./src/encryption-policy.js";
import { createWebChannelPlugin } from "./src/channel.js";
import { handleInboundMessage } from "./src/inbound.js";
import { createSerializedInboundDispatcher } from "./src/inbound-queue.js";
import { handleApprovalDecision } from "./src/approvals.js";
import { resolveVerifier, verifyJwtAndExtractPeerId, verifyJwtAndExtractIdentity, type ConnectionVerifier } from "./src/auth.js";
import type { AuthConfig } from "./src/auth.js";
import { PopChallengeStore } from "./src/pop-challenge.js";
import { resolveRequirePoP, popRequirementUnmet } from "./src/register-pop-gate.js";
import { resolveAllowOrigin } from "./src/register-cors.js";
import { assertValidSubjectToken } from "./src/subject-token.js";
import { resolveAdmissionMode, admissionServingPlan } from "./src/nats-admission.js";
import { isDmPostureOpen } from "./src/dm-allowlist.js";
import { recent as historyRecent, pageBefore as historyPageBefore, resolveHistoryConfig } from "./src/history.js";
import { WEBCHANNEL_ID } from "./src/transport.js";
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
import {
  resolveAccountIdForJwt,
  unionAllowedOrigins as unionAllowedOriginsOf,
  addAudMapping,
  resolveAndVerifyRegister,
} from "./src/register-dispatch.js";

// ---------------------------------------------------------------------------
// Global state — multi-account multiplex (가-1 Cycle 2)
// ---------------------------------------------------------------------------

/**
 * Per-account serving runtime. One `gateway run` builds ONE of these per
 * configured webchannel account (Phase 3 multiplex), each with its own NATS
 * connection, encrypted channel, tenant/accountId subject namespace, verifier,
 * and per-account config. The single HTTP register route dispatches to the
 * right runtime by JWT `aud` (= accountId).
 */
type AccountRuntime = {
  accountId: string;
  tenant: string;
  channel: NatsChannel;
  transport: NatsTransport;
  enrolled?: EnrolledNatsConnection;
  /**
   * The `channels.webchannel.auth` verifier — built ONLY for a `register-hop`
   * account (admission gated by the HTTP register hop). An `auto` account admits
   * peers via the NATS wildcard + X25519 handshake and has no verifier, so this
   * is optional. (The register route verifies via `verifyJwtAndExtractIdentity`
   * against `auth`, not this field; it is retained for register-hop accounts.)
   */
  verifier?: ConnectionVerifier;
  auth: AuthConfig | undefined;
  historyConfig: ReturnType<typeof resolveHistoryConfig>;
  allowedOrigins: string[] | undefined;
};

/** accountId → runtime, built once per process (idempotent across re-warms). */
const accountRuntimes = new Map<string, AccountRuntime>();
/** aud (= accountId, and the configured jwt.audience) → accountId dispatch map. */
const audToAccount = new Map<string, string>();
/** Idempotency guard: the async per-account build runs once per process. */
let accountsBuildStarted = false;

/**
 * Proof-of-Possession nonce store (gap ①). Single-use, short-TTL nonces bound
 * to a peerId; the register route verifies an Ed25519 signature over the nonce
 * against the bootstrap JWT's `pop_jwk`.
 *
 * NOTE (multi-account): this store is PROCESS-WIDE, not per-account. It is keyed
 * by peerId (the verified JWT `sub`) and only proves possession of the device
 * key for that nonce — it is NOT an account-authorization decision. The full
 * per-account verify (issuer + aud + signature via the resolved account's
 * verifier) still gates every register, so a shared nonce store is not
 * exploitable across accounts; a cross-account peerId collision could at most
 * let a peer consume a nonce it also legitimately holds the device key for.
 */
const popChallenges = new PopChallengeStore();

/** Read and JSON-parse a request body. Throws on invalid JSON / empty body. */
async function readJsonBody(req: { on(ev: string, cb: (chunk?: Buffer) => void): void }): Promise<unknown> {
  const raw = await new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk?: Buffer) => { if (chunk) data += chunk.toString(); });
    req.on("end", () => resolve(data));
  });
  return JSON.parse(raw);
}

/**
 * Apply permissive CORS headers to the browser-driven register hop.
 *
 * The SaaS-embed widget runs on a page whose origin differs from the gateway
 * origin (per the deployment model), so a real browser issues a cross-origin
 * preflight + request carrying an `Authorization: Bearer <jwt>` header and a
 * JSON body. Without these headers the browser blocks the register call (Node
 * `fetch` ignored CORS, which is why the Node drivers never hit this). We reflect
 * the request `Origin` (falling back to `*`) and allow the `Authorization` +
 * `Content-Type` headers the PoP flow uses.
 *
 * HARDENING (Item 3): when `auth.cors.allowedOrigins` is configured and non-empty,
 * the allow-origin header is set ONLY for an in-list Origin (out-of-list / missing
 * Origin ⇒ no header ⇒ the browser blocks the response). When unset/empty the
 * behavior is the original permissive one (reflect Origin / `*`) — zero regression.
 * The allowlist decision lives in `resolveAllowOrigin` (see register-cors.ts).
 *
 * NOTE: `/webchannel/nats/unregister` intentionally does NOT call this — no
 * browser path hits it over HTTP today (production teardown `disconnect()` is
 * pure-NATS). A future browser HTTP-teardown path MUST add `setRegisterCors`
 * here too, or it will fail the cross-origin preflight silently.
 */
function setRegisterCors(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  allowedOrigins?: string[],
): void {
  const origin = req.headers["origin"];
  const allow = resolveAllowOrigin(typeof origin === "string" ? origin : undefined, allowedOrigins);
  // Omit Access-Control-Allow-Origin entirely when the allowlist excludes the
  // Origin — setting it to a wrong value would still let the browser through.
  if (allow !== null) {
    res.setHeader("Access-Control-Allow-Origin", allow);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

/**
 * Read the optional CORS allowlist defensively off the live auth config. The
 * schema places `cors` at the `auth` level (any strategy), so this reads it via
 * a cast without assuming a strategy; the register hop only runs under `jwt` in
 * practice. Absent/undefined ⇒ permissive default.
 */
function corsAllowedOrigins(auth: AuthConfig | undefined): string[] | undefined {
  return (auth as { cors?: { allowedOrigins?: string[] } } | undefined)?.cors?.allowedOrigins;
}

/**
 * Adapt a void-returning (req,res) handler to the boolean contract that
 * `api.registerHttpRoute` expects (return true = "this route handled it").
 */
function asRoute(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>,
): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    await handler(req, res);
    return true;
  };
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
 * Resolve the account runtime a bootstrap JWT targets, by peeking its
 * (unverified) `aud` claim and mapping it to an account. The SELECTED account's
 * verifier then performs full signature+aud+issuer verification, so this peek
 * only routes — it never grants trust (see `peekUnverifiedJwtAudiences`).
 */
function accountForJwt(jwt: string | null | undefined): AccountRuntime | undefined {
  const accountId = resolveAccountIdForJwt(jwt, audToAccount);
  return accountId !== undefined ? accountRuntimes.get(accountId) : undefined;
}

/** CORS allowlist for the no-JWT preflight path (union over served accounts). */
function unionAllowedOrigins(): string[] | undefined {
  return unionAllowedOriginsOf([...accountRuntimes.values()].map((rt) => rt.allowedOrigins));
}

/**
 * Create the WebChannel plugin, backed by the lazy NATS transport facade.
 */
const webChannelPlugin = createWebChannelPlugin(lazyTransport);

export default defineChannelPluginEntry({
  id: "webchannel",
  name: "WebChannel NATS",
  description: "NATS-based WebChannel plugin (AC 5 cutover).",
  plugin: webChannelPlugin,

  async registerFull(api) {
    // -----------------------------------------------------------------------
    // Step A: Register HTTP routes SYNCHRONOUSLY, before any `await`.
    // -----------------------------------------------------------------------

    // CRITICAL: openclaw only honors `api.registerHttpRoute` during the
    // SYNCHRONOUS execution window of `registerFull`. Any call made after an
    // `await` (e.g. after `await transport.connect()`) is silently dropped —
    // openclaw's plugin-registration side-effect scope has already closed, so
    // `api.registerHttpRoute` resolves to a no-op and the route never reaches
    // the gateway's serving registry (→ 404 at request time). This is NOT an
    // openclaw limitation on plain-HTTP plugin routes (they dispatch fine, same
    // as the WS-upgrade route in index.ts); it was a latent ordering bug here.
    //
    // The route HANDLERS only run at request time — long after async setup
    // completes — so they read live state through the module-level
    // `accountRuntimes` / `audToAccount` maps (populated by the async build).
    // Readiness is derived from the map at REQUEST time (not a per-call flag) so
    // a re-warmed `registerFull` whose build is still in flight can never leave a
    // stale handler stuck at 503. Until the first build populates the map, the
    // handlers reply 503. A single route set serves ALL accounts; the handler
    // dispatches to the right account by JWT `aud` (가-2 stays single-route).
    const accountsReady = () => accountRuntimes.size > 0;

    // PoP challenge (gap ①): issue a single-use nonce bound to the verified
    // peerId. The browser signs it with the device Ed25519 key and presents the
    // signature to /register. Dispatched to the account named by the JWT `aud`.
    api.registerHttpRoute({
      path: "/webchannel/nats/register/challenge",
      auth: "plugin",
      match: "exact",
      handler: asRoute(async (req, res) => {
        const authHeader = req.headers["authorization"];
        const jwt = authHeader?.startsWith("Bearer ")
          ? authHeader.slice(7)
          : new URL(req.url!, `http://${req.headers.host}`).searchParams.get("jwt");
        const account = accountForJwt(jwt);
        // CORS: use the resolved account's allowlist when known, else the union
        // (preflight / unmapped). Set on every response path including 401/503.
        setRegisterCors(req, res, account ? account.allowedOrigins : unionAllowedOrigins());
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (!accountsReady()) {
          res.statusCode = 503;
          res.end("WebChannel starting up");
          return;
        }
        try {
          if (!jwt) {
            res.statusCode = 401;
            res.end("Missing JWT");
            return;
          }
          if (!account) {
            res.statusCode = 401;
            res.end("No account for token audience");
            return;
          }
          const peerId = await verifyJwtAndExtractPeerId(jwt, account.auth, api.logger);
          if (!peerId) {
            res.statusCode = 401;
            res.end("Invalid JWT");
            return;
          }
          const nonce = popChallenges.issue(peerId);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ nonce }));
        } catch (err) {
          api.logger.error?.(`webchannel: PoP challenge failed: ${String(err)}`);
          res.statusCode = 500;
          res.end("Challenge failed");
        }
      }),
    });

    api.registerHttpRoute({
      path: "/webchannel/nats/register",
      auth: "plugin",
      match: "exact",
      handler: asRoute(async (req, res) => {
        // Extract JWT first so we can resolve the target account for CORS +
        // dispatch. CORS is set on every response path (including 401/500/503).
        const authHeader = req.headers["authorization"];
        const jwt = authHeader?.startsWith("Bearer ")
          ? authHeader.slice(7)
          : (new URL(req.url!, `http://${req.headers.host}`).searchParams.get("jwt"));
        const corsAccount = accountForJwt(jwt);
        setRegisterCors(req, res, corsAccount ? corsAccount.allowedOrigins : unionAllowedOrigins());
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (!accountsReady()) {
          res.statusCode = 503;
          res.end("WebChannel starting up");
          return;
        }

        try {
          // Resolve-and-verify in ONE step (S1 invariant, locked by
          // register-dispatch.test.ts): the account a token's aud routes to is
          // the SAME account it is verified against AND registered into. A token
          // routed to account B can never be verified against / registered into
          // account A — they are one `resolved.account`.
          const resolved = await resolveAndVerifyRegister({
            jwt,
            audToAccount,
            getAccount: (id) => accountRuntimes.get(id),
            verify: (j, a) => verifyJwtAndExtractIdentity(j, a as AuthConfig | undefined, api.logger),
          });
          if (resolved.status === "no-jwt") {
            res.statusCode = 401;
            res.end("Missing JWT");
            return;
          }
          if (resolved.status === "no-account" || resolved.status === "non-jwt") {
            // No served account for this aud, or the account isn't a jwt-strategy
            // register-hop account (clearer 401 than letting verify throw → 500).
            res.statusCode = 401;
            res.end("No account for token audience");
            return;
          }
          if (resolved.status === "invalid") {
            res.statusCode = 401;
            res.end("Invalid JWT");
            return;
          }
          const account = resolved.account;
          const channel = account.channel;
          const auth = account.auth;
          const identity = resolved.identity;
          const peerId = identity.peerId;

          // Defense-in-depth (Item 2): peerId comes from the verified JWT `sub`,
          // but a loose/compromised issuer could place a `.`/`*`/`>` there and
          // widen the agent's subscriptions. Reject it BEFORE any subject use.
          try {
            assertValidSubjectToken(peerId, "peerId");
          } catch (err) {
            api.logger.error?.(`webchannel: ${(err as Error).message}`);
            res.statusCode = 400;
            res.end("Invalid peerId");
            return;
          }

          // Proof-of-Possession gate (Item 1, secure-by-default): PoP is REQUIRED
          // unless an operator explicitly sets auth.requirePoP=false. A verified
          // bootstrap JWT minted WITHOUT `pop_jwk` is otherwise freely replayable,
          // so with the default (true) we reject it here BEFORE registering.
          const requirePoP = resolveRequirePoP(auth as { requirePoP?: boolean } | undefined);
          if (popRequirementUnmet(requirePoP, Boolean(identity.popPublicJwk))) {
            api.logger.error?.(
              `webchannel: register rejected for ${peerId} — proof-of-possession required (JWT has no pop_jwk)`,
            );
            res.statusCode = 401;
            res.end("Proof-of-possession required");
            return;
          }

          // Proof-of-Possession (gap ①): when the bootstrap JWT carries an
          // Ed25519 `pop_jwk`, the caller MUST prove possession of the device
          // private key by signing the issued nonce. Missing / invalid /
          // expired / replayed → 401 and the peer is NOT registered.
          if (identity.popPublicJwk) {
            let proof: { nonce?: unknown; signature?: unknown } = {};
            try {
              proof = (await readJsonBody(req)) as typeof proof;
            } catch {
              /* empty / invalid body → treated as missing proof below */
            }
            const nonce = typeof proof.nonce === "string" ? proof.nonce : "";
            const signature = typeof proof.signature === "string" ? proof.signature : "";
            if (!nonce || !signature) {
              res.statusCode = 401;
              res.end("Missing proof-of-possession");
              return;
            }
            const verdict = popChallenges.verify({
              peerId,
              nonce,
              signatureB64Url: signature,
              popPublicJwk: identity.popPublicJwk,
            });
            if (!verdict.ok) {
              api.logger.error?.(
                `webchannel: PoP verification failed for ${peerId} (${verdict.reason})`,
              );
              res.statusCode = 401;
              res.end("Invalid proof-of-possession");
              return;
            }
          }

          // Register peer in THIS account's NATS channel.
          channel.registerPeer(peerId);

          // Send initial history snapshot, scoped to this account's route
          // (accountId activates binding.account + per-account session key).
          try {
            const route = api.runtime.channel.routing.resolveAgentRoute({
              cfg: api.config,
              channel: WEBCHANNEL_ID,
              accountId: account.accountId,
              peer: { kind: "direct", id: peerId },
            });
            const messages = await historyRecent(api, route.sessionKey, account.historyConfig.limit, api.logger);
            channel.sendHistory(peerId, messages);
          } catch (err) {
            api.logger.error?.(
              `webchannel: history snapshot failed for ${peerId}: ${String(err)}`,
            );
          }

          // Send success response
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ peerId, registered: true }));
        } catch (err) {
          api.logger.error?.(`webchannel: peer registration failed: ${String(err)}`);
          res.statusCode = 500;
          res.end("Registration failed");
        }
      }),
    });

    api.registerHttpRoute({
      path: "/webchannel/nats/unregister",
      auth: "plugin",
      match: "exact",
      handler: asRoute(async (req, res) => {
        if (!accountsReady()) {
          res.statusCode = 503;
          res.end("WebChannel starting up");
          return;
        }
        try {
          const body = await new Promise<string>((resolve) => {
            let data = "";
          req.on("data", (chunk: Buffer) => { data += chunk; });
            req.on("end", () => resolve(data));
          });
          const { peerId } = JSON.parse(body);

          if (!peerId) {
            res.statusCode = 400;
            res.end("Missing peerId");
            return;
          }

          // No JWT on the teardown path, so unregister the peer from EVERY
          // account's channel (idempotent — a peer lives in exactly one).
          for (const rt of accountRuntimes.values()) {
            rt.channel.unregisterPeer(peerId);
          }

          res.statusCode = 200;
          res.end(JSON.stringify({ peerId, unregistered: true }));
        } catch (err) {
          api.logger.error?.(`webchannel: peer unregistration failed: ${String(err)}`);
          res.statusCode = 500;
          res.end("Unregistration failed");
        }
      }),
    });

    // -----------------------------------------------------------------------
    // Steps 0–7 (per account): build ONE serving runtime per configured account
    // -----------------------------------------------------------------------

    // Idempotency: openclaw pre-warms plugins, so `registerFull` can run more
    // than once per process. Build the per-account runtimes exactly once; later
    // invocations are a no-op — their freshly-registered route handlers read the
    // shared module-level maps via `accountsReady()`, so they see the accounts
    // built by the first invocation with no per-call state to go stale.
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

    for (const plan of plans) {
      const { accountId, tenant, account } = plan;
      const accountAuth = account.auth as AuthConfig | undefined;
      const accountNatsCfg = account.nats as WebchannelNatsConfig | undefined;
      const accountEncryption = account.encryption as WebchannelEncryptionConfig | undefined;
      const accountDmSecurity = account.dmSecurity as string | undefined;

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

      // ---- Step 2 (per account): create the encrypted NATS channel ---------
      // Subject namespace is webchannel.{tenant}.{accountId}.{peerId} — the
      // accountId is the wire identity (one namespace per account).
      const channel = new NatsChannel(transport, accountId, tenant, cryptoOptions);
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

      // ---- Axis B (per account): peer admission ----------------------------
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
      channel.setApprovalDecisionHandler((peerId, id, decision) => {
        void handleApprovalDecision(api.config, id, decision, peerId).catch((err) => {
          api.logger.error?.(`webchannel: approval resolve failed (${id}): ${String(err)}`);
        });
      });

      // ---- Step 5 (per account): history load handler ----------------------
      const historyConfig = resolveHistoryConfig(
        account as { capabilities?: { typing?: "on" | "off" } } | undefined,
      );
      channel.setLoadHistoryHandler((peerId, request) => {
        try {
          const route = api.runtime.channel.routing.resolveAgentRoute({
            cfg: api.config,
            channel: WEBCHANNEL_ID,
            accountId,
            peer: { kind: "direct", id: peerId },
          });
          void historyPageBefore(api, route.sessionKey, request, historyConfig.pageSize, api.logger)
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

      // ---- Step 6 (per account): JWT verifier (register-hop accounts only) --
      // Only a `register-hop` account is gated by `channels.webchannel.auth`, so
      // only then do we build (and require) its verifier. A misconfigured jwt
      // auth on a register-hop account still fails loudly here — resolveVerifier
      // throws and we skip the account (never silently downgrading a broken jwt
      // account to auto). An `auto` account builds NO verifier and is served with
      // no `auth` config at all (invariant 1).
      let verifier: ConnectionVerifier | undefined;
      if (servingPlan.buildVerifier) {
        try {
          verifier = resolveVerifier(accountAuth, api.logger);
        } catch (err) {
          (api.logger?.error ?? console.error)?.(
            `[webchannel] account "${accountId}" verifier misconfig — skipping: ${(err as Error).message}`,
          );
          continue;
        }
      }

      // ---- Publish this account's runtime + aud→account dispatch entries ----
      const allowedOrigins = corsAllowedOrigins(accountAuth);
      accountRuntimes.set(accountId, {
        accountId,
        tenant,
        channel,
        transport,
        ...(enrolled ? { enrolled } : {}),
        ...(verifier ? { verifier } : {}),
        auth: accountAuth,
        historyConfig,
        allowedOrigins,
      });
      // Dispatch keys are populated for register-hop accounts ONLY: the register
      // route dispatches a bootstrap JWT by `aud`, and an `auto` account has no
      // register hop, so it must NOT claim an aud (that would misroute a token to
      // an account whose handler would 401 it as "non-jwt"). Keys: the accountId
      // (= subject/wire key, also the JWT `aud`) AND the configured jwt.audience
      // (what the bootstrap JWT actually carries) if it differs. First-wins on
      // collision (C1): a shared IdP audience across accounts is kept for the
      // FIRST account + logged, never silently overwritten (which would misroute).
      if (servingPlan.populateAudMapping) {
        const onAudCollision = (msg: string) => (api.logger?.warn ?? console.warn)?.(msg);
        addAudMapping(audToAccount, accountId, accountId, onAudCollision);
        const configuredAud = (accountAuth as { jwt?: { audience?: string } } | undefined)?.jwt?.audience;
        if (typeof configuredAud === "string" && configuredAud.length > 0) {
          addAudMapping(audToAccount, configuredAud, accountId, onAudCollision);
        }
      }
    }

    // Bind the lazy transport facade to a PRIMARY channel for core-initiated
    // (untargeted) outbound + the approval capability, which use the single
    // facade. Inbound replies already route per-account via each channel's own
    // dispatcher (so AC6's inbound routing is unaffected). Prefer "default", else
    // the first built account.
    //
    // Cycle 3 follow-up: this is primary-only. A peerId that happens to be
    // registered on BOTH the primary AND a non-primary account could receive the
    // primary account's PROACTIVE / APPROVAL outbound (the untargeted facade
    // can't disambiguate by account). Per-account proactive-outbound + approval
    // routing needs an accountId-aware outbound facade (Cycle 3).
    const primary = accountRuntimes.get("default") ?? [...accountRuntimes.values()][0];
    boundChannel = primary ? primary.channel : null;

    // Route handlers become ready automatically: `accountsReady()` reads the
    // `accountRuntimes` map populated above, so as soon as ≥1 account is built
    // the register/challenge/unregister routes stop replying 503.

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
