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
import { shouldSubscribeWildcard } from "./src/wildcard-gate.js";
import { recent as historyRecent, pageBefore as historyPageBefore, resolveHistoryConfig } from "./src/history.js";
import { WEBCHANNEL_ID } from "./src/transport.js";
import type { WebChannelTransport } from "./src/transport.js";
import { NatsTransport } from "./src/nats-transport.js";
import { createEnrolledNatsConnection, type EnrolledNatsConnection } from "./src/enrolled-nats-connection.js";

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
    // Step 1: Connect to NATS — enrolled by default; dev/open-NATS when configured
    // -----------------------------------------------------------------------

    // `channels.webchannel.nats.devOpen: true` (or WEBCHANNEL_NATS_DEV_OPEN=1)
    // connects to a plain local nats-server with NO enrollment / NO JWT, for
    // LOCAL integration testing only. Production keeps the enrolled-creds path.
    const natsCfg = (
      api.config.nats as { url?: string; devOpen?: boolean } | undefined
    );
    const wcNatsCfg = (webchannelCfg as { nats?: { devOpen?: boolean; url?: string } } | undefined)?.nats;
    const devOpenNats =
      natsCfg?.devOpen === true ||
      wcNatsCfg?.devOpen === true ||
      process.env["WEBCHANNEL_NATS_DEV_OPEN"] === "1";

    if (!natsTransport) {
      const natsUrl =
        process.env["WEBCHANNEL_NATS_URL"] ?? wcNatsCfg?.url ?? natsCfg?.url ?? "ws://127.0.0.1:4222";
      channelTenant = process.env["WEBCHANNEL_TENANT"] ?? api.config.tenant ?? "default-tenant";
      channelAgentId = process.env["WEBCHANNEL_AGENT_ID"] ?? api.config.agentId ?? "default-agent";

      if (devOpenNats) {
        console.log(`[webchannel] DEV open-NATS mode → ${natsUrl} (no enrollment, no JWT)`);
        const transport = new NatsTransport({
          url: natsUrl,
          clientName: "openclaw-webchannel-agent-dev",
        });
        await transport.connect();
        natsTransport = transport;
      } else {
        console.log("[webchannel] Starting NATS enrollment and connection...");
        // `WEBCHANNEL_SAAS_BASE_URL` env override mirrors the other WEBCHANNEL_*
        // envs (NATS_URL/TENANT/AGENT_ID); useful where the host config schema
        // does not carry a top-level `saas` block.
        const saasBaseUrl =
          process.env["WEBCHANNEL_SAAS_BASE_URL"] ?? api.config.saas?.baseUrl ?? "http://localhost:3001";
        try {
          natsConnection = await createEnrolledNatsConnection({
            saasEnrollUrl: `${saasBaseUrl}/api/enroll`,
            saasPollUrl: `${saasBaseUrl}/api/poll`,
            natsUrl,
            tenant: channelTenant,
            agentId: channelAgentId,
            displayInstructions: true,
          });
          natsTransport = natsConnection.transport;
        } catch (err) {
          console.error("[webchannel] Failed to connect to NATS:", err);
          throw err;
        }
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

    // Dev/open-NATS convenience: the wildcard subscription is PURELY the
    // hmac-ticket dev shortcut — the local harness browser connects with an
    // hmac-ticket and does NOT call the HTTP register hop, so we subscribe to the
    // tenant/agent wildcard and let peers auto-register on their handshake (the
    // allowlist gate still runs).
    //
    // When `auth.strategy === "jwt"`, the HTTP `/webchannel/nats/register` route
    // (registered in Step A) is the REAL admission path even under open-NATS —
    // the enrolled/JWT producer is expected to drive challenge → PoP-signed
    // register so the agent calls `registerPeer` for that peer. If we left the
    // wildcard ON in that scenario the agent would already be subscribed to every
    // peer, so a successful round-trip would prove nothing about the register
    // hop. We therefore turn the wildcard OFF whenever the strategy is jwt.
    //
    // This does NOT change production behavior: enrolled production runs with
    // devOpenNats=false, so the wildcard is already off there. It only tightens
    // the devOpen+jwt test scenario so the HTTP hop is the sole admission path.
    const authStrategy = (webchannelCfg?.auth as { strategy?: string } | undefined)?.strategy;
    if (shouldSubscribeWildcard(devOpenNats, authStrategy)) {
      channel.subscribeWildcard();
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
