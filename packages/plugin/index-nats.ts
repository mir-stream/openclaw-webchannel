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
import { resolveAdmissionMode } from "./src/nats-admission.js";
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
import {
  resolveAccountNatsConfig,
  resolveServingAccountId,
} from "./src/account-config.js";
import { resolveAcquisitionEnvPrecedence } from "./src/acquisition-env.js";

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

/**
 * Shared NATS channel instance.
 *
 * Replaces WebChannelTransport from the original gateway-WS implementation.
 * All message routing now goes through NATS subjects.
 */
let natsChannel: NatsChannel | null = null;
let natsConnection: EnrolledNatsConnection | null = null;
/** Live transport (from enrolled connection OR the dev/open-NATS path). */
let natsTransport: NatsTransport | null = null;
let channelTenant = "default-tenant";
let channelAgentId = "default-agent";

/**
 * Proof-of-Possession nonce store (gap ①). Single-use, short-TTL nonces bound
 * to a peerId; the register route verifies an Ed25519 signature over the nonce
 * against the bootstrap JWT's `pop_jwk`.
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
    // completes — so they read live state through the `live` holder, populated
    // at the end of `registerFull`. Until setup finishes, handlers reply 503.
    const live: {
      channel: NatsChannel | null;
      verifier: ConnectionVerifier | null;
      auth: AuthConfig | undefined;
      historyConfig: ReturnType<typeof resolveHistoryConfig> | null;
    } = { channel: null, verifier: null, auth: undefined, historyConfig: null };

    // PoP challenge (gap ①): issue a single-use nonce bound to the verified
    // peerId. The browser signs it with the device Ed25519 key and presents the
    // signature to /register.
    api.registerHttpRoute({
      path: "/webchannel/nats/register/challenge",
      auth: "plugin",
      match: "exact",
      handler: asRoute(async (req, res) => {
        // CORS: reflect origin (or honor the configured allowlist) on every
        // response path; answer the browser's preflight (sent because of the
        // Authorization header) without a JWT.
        setRegisterCors(req, res, corsAllowedOrigins(live.auth));
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
        try {
          const authHeader = req.headers["authorization"];
          const jwt = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7)
            : new URL(req.url!, `http://${req.headers.host}`).searchParams.get("jwt");
          if (!jwt) {
            res.statusCode = 401;
            res.end("Missing JWT");
            return;
          }
          const peerId = await verifyJwtAndExtractPeerId(jwt, live.auth, api.logger);
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
        // CORS: reflect origin (or honor the configured allowlist) on every
        // response path (including 401/500/503); answer the browser's preflight
        // without requiring a JWT/body.
        setRegisterCors(req, res, corsAllowedOrigins(live.auth));
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
        const channel = live.channel;
        const verifier = live.verifier;
        if (!channel || !live.historyConfig) {
          res.statusCode = 503;
          res.end("WebChannel starting up");
          return;
        }
        if (!verifier) {
          res.statusCode = 500;
          res.end("No verifier configured");
          return;
        }

        try {
          // Extract JWT from Authorization header or query parameter
          const authHeader = req.headers["authorization"];
          const jwt = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7)
            : (new URL(req.url!, `http://${req.headers.host}`).searchParams.get("jwt"));

          if (!jwt) {
            res.statusCode = 401;
            res.end("Missing JWT");
            return;
          }

          // Verify JWT and extract the full identity (peerId + PoP key)
          const identity = await verifyJwtAndExtractIdentity(jwt, live.auth, api.logger);
          if (!identity) {
            res.statusCode = 401;
            res.end("Invalid JWT");
            return;
          }
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
          const requirePoP = resolveRequirePoP(live.auth as { requirePoP?: boolean } | undefined);
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

          // Register peer in NATS channel
          channel.registerPeer(peerId);

          // Send initial history snapshot
          try {
            const route = api.runtime.channel.routing.resolveAgentRoute({
              cfg: api.config,
              channel: WEBCHANNEL_ID,
              peer: { kind: "direct", id: peerId },
            });
            const messages = await historyRecent(api, route.sessionKey, live.historyConfig.limit, api.logger);
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
        const channel = live.channel;
        if (!channel) {
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

          channel.unregisterPeer(peerId);

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
    // Step 0: Fail-closed encryption guard (AC 3a / EncryptedChannelWired)
    // -----------------------------------------------------------------------

    // The NATS relay is untrusted and must only ever observe ciphertext. Resolve
    // the encryption policy BEFORE connecting to NATS: a deployment that disables
    // encryption throws here and the entry refuses to start — it never connects,
    // never registers a peer, and therefore never emits plaintext to the relay.
    const webchannelCfg = (
      api.config.channels as Record<string, unknown> | undefined
    )?.webchannel as
      | { encryption?: WebchannelEncryptionConfig; auth?: AuthConfig }
      | undefined;

    let cryptoOptions: NatsChannelCryptoOptions;
    try {
      cryptoOptions = resolveEncryptionPolicy(webchannelCfg?.encryption).crypto;
    } catch (err) {
      api.logger.error?.(`webchannel: ${(err as Error).message}`);
      throw err;
    }

    // -----------------------------------------------------------------------
    // Step 1: Resolve the credential SOURCE (Axis A), then connect.
    // -----------------------------------------------------------------------

    // Axis A (`nats-credential-source.ts`) decouples HOW the agent authenticates
    // to NATS from the connection itself. 가-1 makes `gateway run` CONSUME-ONLY:
    // the `enrolled` source no longer enrolls at runtime — it LOADS the persisted
    // per-account creds (acquisition moved to `openclaw channels add`). The
    // `open` / `static` sources are unchanged (auth material is already present).
    // Connection/static env keeps its override meaning: WEBCHANNEL_NATS_URL /
    // _USER_JWT / _USER_SEED / _CREDS / _DEV_OPEN.
    const wcNatsCfg = (webchannelCfg as { nats?: WebchannelNatsConfig } | undefined)?.nats;
    const legacyNats = api.config.nats as { url?: string; devOpen?: boolean } | undefined;

    // Tracks the resolved credential source mode so the admission decision
    // (Axis B, Step 3) is made explicitly rather than inferred from devOpen.
    let credentialMode: NatsCredentialSource["mode"] = "enrolled";

    if (!natsTransport) {
      // Cycle 1 serves the single serving account (`"default"` when listed, else
      // the first listed account). A flat/legacy config resolves to `"default"`.
      // Cycle 2 multiplexes ALL listed accounts (the list seam already exists).
      const accountId = resolveServingAccountId(api.config);

      // Acquisition identity with deterministic config-over-env precedence
      // (deliverable 6): config wins when present; the legacy WEBCHANNEL_TENANT/
      // _AGENT_ID/_SAAS_BASE_URL env only synthesizes a `"default"` identity when
      // there is NO webchannel config (one-time deprecation warning otherwise).
      const { identity } = resolveAcquisitionEnvPrecedence(api.config, accountId, {
        warn: (msg) => (api.logger?.warn ?? console.warn)?.(msg),
      });
      channelTenant = identity.tenant;
      channelAgentId = identity.agentId;

      // Prefer the account-scoped nats config; fall back to the flat block.
      const accountNatsCfg = resolveAccountNatsConfig(api.config, accountId) ?? wcNatsCfg;

      try {
        const source = resolveNatsCredentialSource({
          natsConfig: accountNatsCfg,
          legacyNats,
          // Pass the config-derived saasBaseUrl RAW; the resolver owns the full
          // saasBaseUrl precedence (env > nats.credentials.saasBaseUrl > this > default).
          saasBaseUrl: identity.saasBaseUrl ?? api.config.saas?.baseUrl,
          tenant: channelTenant,
          agentId: channelAgentId,
        });
        credentialMode = source.mode;
        console.log(`[webchannel] NATS credential source: ${source.mode} → ${source.url}`);

        // CONSUME-only: enrolled → load persisted per-account creds (no enroll).
        const consumed = await consumeCredentialSource(source, accountId);
        if (consumed.status === "creds-missing") {
          // Account-scoped graceful degradation: skip serving THIS account with
          // an actionable log (skipped account id + remediation command). No
          // runtime enroll, no polling, no hang. Other accounts/channels and the
          // gateway process are unaffected — we just return without binding a
          // transport, so the register routes reply 503 for this account.
          (api.logger?.warn ?? api.logger?.error ?? console.warn)?.(
            `[webchannel] account "${consumed.accountId}" has no enrolled credentials — ` +
              `skipping serving this account. Run: openclaw channels add --channel ` +
              `webchannel --account ${consumed.accountId}`,
          );
          return;
        }
        natsTransport = consumed.connection.transport;
        if (consumed.connection.enrolled) natsConnection = consumed.connection.enrolled;
      } catch (err) {
        // Non-fatal (graceful degradation): a failed resolve/connect disables the
        // webchannel for THIS process instead of crashing it — applied uniformly
        // to ALL credential sources (open / static / enrolled-consume). This
        // matters because openclaw loads this channel entry in EVERY context —
        // not just the serving gateway, but also local `openclaw chat`/TUI/CLI
        // runs. Without this guard the throw propagates out of registerFull as an
        // unhandled rejection and takes the whole process down (TUI wouldn't even
        // start). The serving gateway stays up too (other channels keep working);
        // the register routes reply 503 until a connection is established. The
        // encryption fail-closed guard (Step 0) is separate and still throws.
        const msg = err instanceof Error ? err.message : String(err);
        (api.logger?.warn ?? api.logger?.error ?? console.warn)?.(
          `[webchannel] NATS connection failed — channel inactive for this process (${msg})`,
        );
        return;
      }
      console.log("[webchannel] ✓ Connected to NATS");
    }

    // -----------------------------------------------------------------------
    // Step 2: Create NATS channel
    // -----------------------------------------------------------------------

    if (!natsChannel) {
      // Encrypt-by-construction: the channel performs the per-peer X25519
      // handshake and ChaCha20-Poly1305-seals every frame. It is fail-closed —
      // it never publishes or processes plaintext on the relay.
      natsChannel = new NatsChannel(natsTransport, channelAgentId, channelTenant, cryptoOptions);
      // Bind the live channel into the lazy transport facade so the plugin's
      // outbound/message/approval adapters now route to NATS.
      boundChannel = natsChannel;
      console.log("[webchannel] ✓ Encrypted NATS channel created");
    }

    const channel = natsChannel;

    // -----------------------------------------------------------------------
    // Step 3: Wire up inbound message dispatcher
    // -----------------------------------------------------------------------

    // Bridge inbound NATS messages into the OpenClaw agent runtime — the same
    // seam the WS entry (index.ts) uses. `handleInboundMessage` runs the turn
    // through `api.runtime.channel.inbound.run` (which reaches the model) and
    // delivers the agent's reply back via `channel.sendText` (NatsChannel
    // satisfies the transport surface it touches: sendTyping + sendText).
    // Serialized per-peer so two turns for one peer never interleave.
    const { dispatch: dispatchInbound } = createSerializedInboundDispatcher<
      Extract<InboundWsMessage, { type: "user_message" }>
    >((peerId, message) =>
      handleInboundMessage(
        api,
        channel as unknown as WebChannelTransport,
        peerId,
        message,
      ),
    );

    channel.setMessageHandler((peerId, message) => {
      if (message.type !== "user_message") return; // approvals routed below
      dispatchInbound(peerId, message);
    });

    // Axis B — PEER ADMISSION (`nats-admission.ts`), decided EXPLICITLY and
    // independently of the credential source:
    //   - `register-hop`: a peer must complete the SaaS JWT + PoP round-trip at
    //     `/webchannel/nats/register*` before the agent subscribes to it. The
    //     production default for `auth.strategy === "jwt"`.
    //   - `auto`: the agent subscribes to the tenant/agent wildcard and serves any
    //     peer that completes the X25519 handshake AND passes the dmSecurity
    //     allowlist (security = subject permissions + allowlist + E2E encryption).
    //     This is now available for a real external NATS with `static` creds — NOT
    //     just devOpen — which the legacy devOpen-gated wildcard could never do.
    // An explicit `nats.admission` override wins. Existing flows are unchanged:
    // enrolled+jwt → register-hop; devOpen+jwt → register-hop; devOpen+hmac → auto.
    const authStrategy = (webchannelCfg?.auth as { strategy?: string } | undefined)?.strategy;
    // Derive Axis B's capability from Axis A WITHOUT leaking credential-mode names
    // into the admission module: an issuer-backed register hop is viable for every
    // source EXCEPT bring-your-own static creds (which has no issuer to run).
    const registerHopAvailable = credentialMode !== "static";
    const admission = resolveAdmissionMode({
      authStrategy,
      registerHopAvailable,
      explicitOverride: wcNatsCfg?.admission,
    });
    if (admission === "auto") {
      channel.subscribeWildcard();
    }

    // SAFETY: surface the open admission posture exactly once at startup. When
    // admission is `auto` AND no dmSecurity allowlist gates senders (notably the
    // static + auto BYO-NATS case), the agent serves ANY peer that can reach the
    // subjects and complete the handshake — the boundary is then purely NATS
    // subject permissions. Do NOT warn for register-hop or when an allowlist is set.
    const dmSecurity = (webchannelCfg as { dmSecurity?: string } | undefined)?.dmSecurity;
    if (admission === "auto" && isDmPostureOpen(dmSecurity)) {
      api.logger.warn?.(
        "webchannel: admission=auto with no dmSecurity allowlist — any peer with NATS " +
          "access + a valid handshake is served; rely on NATS subject permissions as the boundary.",
      );
    }

    // -----------------------------------------------------------------------
    // Step 4: Wire up approval decision handler
    // -----------------------------------------------------------------------

    channel.setApprovalDecisionHandler((peerId, id, decision) => {
      void handleApprovalDecision(api.config, id, decision, peerId).catch((err) => {
        api.logger.error?.(
          `webchannel: approval resolve failed (${id}): ${String(err)}`,
        );
      });
    });

    // -----------------------------------------------------------------------
    // Step 5: Wire up history load handler
    // -----------------------------------------------------------------------

    const historyConfig = resolveHistoryConfig(
      (api.config.channels as Record<string, unknown> | undefined)?.webchannel as
        | { capabilities?: { typing?: "on" | "off" } }
        | undefined,
    );

    channel.setLoadHistoryHandler((peerId, request) => {
      try {
        const route = api.runtime.channel.routing.resolveAgentRoute({
          cfg: api.config,
          channel: WEBCHANNEL_ID,
          peer: { kind: "direct", id: peerId },
        });
        void historyPageBefore(api, route.sessionKey, request, historyConfig.pageSize, api.logger)
          .then((messages) => {
            channel.sendHistory(peerId, messages);
          })
          .catch((err) => {
            api.logger.error?.(
              `webchannel: history page failed for ${peerId}: ${String(err)}`,
            );
          });
      } catch (err) {
        api.logger.error?.(
          `webchannel: history resolution failed for ${peerId}: ${String(err)}`,
        );
      }
    });

    // -----------------------------------------------------------------------
    // Step 6: Set up JWT verifier for peer registration
    // -----------------------------------------------------------------------

    const authConfig = (
      api.config.channels as Record<string, unknown> | undefined
    )?.webchannel as { auth?: AuthConfig } | undefined;

    let verifier: ConnectionVerifier | null = null;
    try {
      verifier = resolveVerifier(authConfig?.auth, api.logger);
    } catch (err) {
      const errorMsg = (err as Error).message;
      api.logger.error?.(`webchannel: ${errorMsg}`);
      throw err;
    }

    // -----------------------------------------------------------------------
    // Step 7: Publish live state to the HTTP route handlers registered in Step A
    // -----------------------------------------------------------------------

    // The register / challenge / unregister routes were registered synchronously
    // at the top of registerFull (Step A) — they MUST be, or openclaw drops them.
    // Now that async setup is complete, hand them the live channel + verifier so
    // requests stop replying 503 and start admitting peers (JWT + PoP).
    live.channel = channel;
    live.verifier = verifier;
    live.auth = authConfig?.auth;
    live.historyConfig = historyConfig;

    // -----------------------------------------------------------------------
    // Step 9: Keep the NATS connection alive
    // -----------------------------------------------------------------------

    // keepAlive is optional — not all gateway runtimes expose it. The NATS
    // transport maintains its own connection, so this is best-effort.
    const keepAlive = (api.runtime.channel as { keepAlive?: (opts: { handler: () => Promise<void> }) => void }).keepAlive;
    if (typeof keepAlive === "function") {
      keepAlive({
        async handler() {
          if (natsTransport && !natsTransport.connected) {
            console.log("[webchannel] NATS disconnected, attempting reconnect...");
          }
        },
      });
    }

    console.log("[webchannel] ✓ NATS mode plugin registered");
  },
});
