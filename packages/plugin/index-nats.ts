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
import type { InboundWsMessage } from "./src/nats-channel.js";
import { createWebChannelPlugin } from "./src/channel.js";
import { handleInboundMessage } from "./src/inbound.js";
import { createSerializedInboundDispatcher } from "./src/inbound-queue.js";
import { handleApprovalDecision } from "./src/approvals.js";
import { resolveVerifier, verifyJwtAndExtractPeerId, verifyJwtAndExtractIdentity, type ConnectionVerifier } from "./src/auth.js";
import type { AuthConfig } from "./src/auth.js";
import { PopChallengeStore } from "./src/pop-challenge.js";
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
  id: "webchannel-nats",
  name: "WebChannel NATS",
  description: "NATS-based WebChannel plugin (AC 5 cutover).",
  plugin: webChannelPlugin,

  async registerFull(api) {
    // -----------------------------------------------------------------------
    // Step 1: Enroll and connect to NATS (if not already done)
    // -----------------------------------------------------------------------

    if (!natsConnection) {
      console.log("[webchannel] Starting NATS enrollment and connection...");

      // Get NATS URL from config or use default
      const natsUrl = api.config.nats?.url ?? "ws://localhost:4222";

      // Get SaaS URLs from config
      const saasBaseUrl = api.config.saas?.baseUrl ?? "http://localhost:3001";
      const saasEnrollUrl = `${saasBaseUrl}/api/enroll`;
      const saasPollUrl = `${saasBaseUrl}/api/poll`;

      // Get tenant/agent IDs from config
      const tenant = api.config.tenant ?? "default-tenant";
      const agentId = api.config.agentId ?? "default-agent";

      try {
        natsConnection = await createEnrolledNatsConnection({
          saasEnrollUrl,
          saasPollUrl,
          natsUrl,
          tenant,
          agentId,
          displayInstructions: true,
        });

        console.log("[webchannel] ✓ Connected to NATS");
      } catch (err) {
        console.error("[webchannel] Failed to connect to NATS:", err);
        throw err;
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Create NATS channel
    // -----------------------------------------------------------------------

    if (!natsChannel) {
      const transport = natsConnection.transport;
      const agentId = natsConnection.enrollment.creds.agentId ?? "default-agent";
      const tenant = natsConnection.tenant ?? "default-tenant";

      natsChannel = new NatsChannel(transport, agentId, tenant);
      // Bind the live channel into the lazy transport facade so the plugin's
      // outbound/message/approval adapters now route to NATS.
      boundChannel = natsChannel;
      console.log("[webchannel] ✓ NATS channel created");
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
    // Step 7: Wire up HTTP route for peer registration (bootstrap JWT)
    // -----------------------------------------------------------------------

    // In NATS mode, browsers don't connect via WebSocket upgrade
    // Instead, they call an HTTP endpoint to register their peerId
    // The endpoint verifies the bootstrap JWT and calls channel.registerPeer()

    // PoP challenge (gap ①): issue a single-use nonce bound to the verified
    // peerId. The browser signs it with the device Ed25519 key and presents the
    // signature to /register.
    api.http.post!(
      "/webchannel/nats/register/challenge",
      async (req, res) => {
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
          const peerId = await verifyJwtAndExtractPeerId(jwt, authConfig?.auth, api.logger);
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
      },
    );

    api.http.post!(
      "/webchannel/nats/register",
      async (req, res) => {
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
          const identity = await verifyJwtAndExtractIdentity(jwt, authConfig?.auth, api.logger);
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
            const messages = await historyRecent(api, route.sessionKey, historyConfig.limit, api.logger);
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
      },
    );

    // -----------------------------------------------------------------------
    // Step 8: Wire up HTTP route for peer unregistration
    // -----------------------------------------------------------------------

    api.http.post!(
      "/webchannel/nats/unregister",
      async (req, res) => {
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
      },
    );

    // -----------------------------------------------------------------------
    // Step 9: Keep the NATS connection alive
    // -----------------------------------------------------------------------

    api.runtime.channel.keepAlive({
      async handler() {
        // This handler is called periodically to keep the channel alive
        // We just need to ensure the NATS connection stays up
        if (natsConnection?.transport && !natsConnection.transport.connected) {
          console.log("[webchannel] NATS disconnected, attempting reconnect...");
          // The enrolled connection should auto-reconnect
        }
      },
    });

    console.log("[webchannel] ✓ NATS mode plugin registered");
  },
});
