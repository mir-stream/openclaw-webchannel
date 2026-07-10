#!/usr/bin/env node
/**
 * SaaS Bootstrap JWT issuance endpoint — REAL RS256 issuer + REAL JWKS.
 *
 * This server validates device PoP (proof of possession) inputs and issues
 * RS256-signed bootstrap JWTs containing cnf.jwk (X25519) + pop_jwk (Ed25519)
 * claims. It is NOT a mock: at startup it derives a real trust chain via
 * `setupTrustChain()` (real RSA keypair + real JWKS), holds the importable RSA
 * private key in memory, and signs each JWT with it. The matching public RSA JWK
 * is served at `/.well-known/jwks.json` so the plugin's `verifyJwt` (resolving by
 * `kid`) admits the token. The header `kid` ALWAYS equals the trust chain's kid.
 *
 * USAGE:
 *   node --import tsx packages/saas/reference/bootstrap-server.ts
 *
 * ENDPOINTS:
 *   POST /bootstrap                 - Issue bootstrap JWT (browser/device → SaaS)
 *   GET  /.well-known/jwks.json     - Real RSA public key (RFC 7517) for verifiers
 *
 * ENVIRONMENT VARIABLES:
 *   PORT          - Server port (default: 3001)
 *   SAAS_ISSUER   - Token issuer (`iss` claim). Default http://localhost:<PORT>.
 *   SAAS_BASE_URL - Base URL for response convenience fields (default http://localhost:<PORT>).
 *
 * SECURITY NOTES:
 *   - This reference uses HTTP for demonstration. Use TLS in production.
 *   - No authentication on the bootstrap endpoint. Add device auth in production.
 *   - CORS is enabled for all origins. Restrict in production.
 */

import { createServer } from "node:http";
import { createHash, webcrypto } from "node:crypto";

import { buildBootstrapClaims } from "../src/bootstrap-claims.js";
import { setupTrustChain } from "../src/setup-trust-chain.js";
import type { JwksDocument } from "../src/types.js";
// F2: this dev bootstrap server front-ends a DEV-OPEN register-hop agent, which
// wraps K under the WELL-KNOWN dev identity key (packages/plugin/src/dev-identity.ts).
// Deliver its PUBLIC half so the browser pins the same key the agent wraps under.
import { devOpenAgentIdentityPublicB64url } from "../../plugin/src/dev-identity.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3001", 10);
const SAAS_BASE_URL = process.env.SAAS_BASE_URL || `http://localhost:${PORT}`;
// `iss` claim the plugin checks against `channels.webchannel.auth.jwt.issuer`.
const SAAS_ISSUER = process.env.SAAS_ISSUER || SAAS_BASE_URL;

const JWKS_URL = `${SAAS_BASE_URL}/.well-known/jwks.json`;
const NATS_URL = process.env.NATS_URL || "wss://nats.example.com";
// F2 — DEV-OPEN gate. This reference server has NO enrollment/registry, so it can
// only deliver an `agentPublicKey` pin for the DEV-OPEN register-hop agent (which
// wraps K under the PUBLIC well-known dev identity key). That is safe ONLY when
// the whole stack is dev-open; a production copy would leak the public dev key as
// a "trusted" pin and re-open the MITM. So the pin is served ONLY behind the
// explicit dev knob (WEBCHANNEL_NATS_DEV_OPEN=1, matching the gateway's dev flag).
// Otherwise NO pin is returned and the browser fail-closes on the register path.
const DEV_OPEN = process.env.WEBCHANNEL_NATS_DEV_OPEN === "1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BootstrapRequest = {
  devicePublicKey: string; // base64url-encoded X25519 public key (→ cnf.jwk)
  devicePopPublicKey?: string; // base64url-encoded Ed25519 PoP public key (→ pop_jwk)
  accountId: string;
  tenant: string;
  peerId?: string; // optional caller-supplied peerId; else derived from device key
  pop?: string; // Proof of possession (signature) - optional for this demo
};

type BootstrapResponse = {
  jwt: string; // RS256-signed bootstrap JWT
  peerId: string; // = JWT `sub`; returned so the driver stays consistent
  // F2: the DEV-OPEN agent's well-known dev identity public key, delivered ONLY
  // when DEV_OPEN is set (see above). Omitted otherwise → the browser fail-closes.
  agentPublicKey?: string;
  jwksUrl: string; // JWKS endpoint URL
  natsUrl: string; // NATS WebSocket URL
};

// ---------------------------------------------------------------------------
// Real trust chain (derived once at startup, held in memory)
// ---------------------------------------------------------------------------

type RealTrustChain = {
  /** Importable RSA private key (RSASSA-PKCS1-v1_5, SHA-256, ["sign"]). */
  rsaPrivateKey: webcrypto.CryptoKey;
  /** Public RSA JWKS document (single key, matching kid). */
  jwks: JwksDocument;
  /** Key ID — equals the JWKS key kid and the JWT header kid. */
  kid: string;
};

/** Import a PKCS#8 PEM RSA private key into a webcrypto signing key. */
async function importRsaPrivateKeyFromPem(pem: string): Promise<webcrypto.CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Buffer.from(body, "base64");
  return webcrypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Derive a real trust chain (real RSA keypair + real JWKS) once at boot. */
async function initTrustChain(): Promise<RealTrustChain> {
  const chain = await setupTrustChain();
  const rsaPrivateKey = await importRsaPrivateKeyFromPem(chain.private.rsaPrivateKeyPem);
  return { rsaPrivateKey, jwks: chain.jwks, kid: chain.kid };
}

// ---------------------------------------------------------------------------
// JWT signing (RS256, real signature with the trust-chain private key)
// ---------------------------------------------------------------------------

function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** RS256-sign a claims payload, embedding the trust chain's kid in the header. */
async function signBootstrapJwt(
  payload: Record<string, unknown>,
  trustChain: RealTrustChain,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: trustChain.kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await webcrypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    trustChain.rsaPrivateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

/** Deterministic peerId derived from the device key (stable per device). */
function derivePeerId(devicePublicKey: string): string {
  const digest = createHash("sha256").update(devicePublicKey).digest("hex");
  return `user-${digest.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function setCorsHeaders(res: any): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: any, data: unknown, status = 200): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Bootstrap endpoint
// ---------------------------------------------------------------------------

async function handleBootstrap(req: any, res: any, trustChain: RealTrustChain): Promise<void> {
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end("Method not allowed");
    return;
  }

  setCorsHeaders(res);

  try {
    const body = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => { data += chunk; });
      req.on("end", () => resolve(data));
    });

    const request: BootstrapRequest = JSON.parse(body);

    // Validate request
    if (!request.devicePublicKey || typeof request.devicePublicKey !== "string") {
      sendJson(res, { error: "invalid devicePublicKey" }, 400);
      return;
    }

    if (!request.accountId || typeof request.accountId !== "string") {
      sendJson(res, { error: "invalid accountId" }, 400);
      return;
    }

    if (!request.tenant || typeof request.tenant !== "string") {
      sendJson(res, { error: "invalid tenant" }, 400);
      return;
    }

    // Decode and validate device public key format
    const deviceKeyBytes = Buffer.from(request.devicePublicKey, "base64url");
    if (deviceKeyBytes.length !== 32) {
      sendJson(res, { error: "devicePublicKey must be 32 bytes" }, 400);
      return;
    }
    if (request.devicePopPublicKey && Buffer.from(request.devicePopPublicKey, "base64url").length !== 32) {
      sendJson(res, { error: "devicePopPublicKey must be 32 bytes" }, 400);
      return;
    }

    // peerId = JWT `sub`. Accept a caller-supplied peerId; otherwise derive a
    // deterministic one from the device key (stable across re-bootstraps).
    const peerId =
      typeof request.peerId === "string" && request.peerId.length > 0
        ? request.peerId
        : derivePeerId(request.devicePublicKey);

    // Create JWT payload with cnf.jwk (+ pop_jwk when the device sent its PoP key).
    const jwtPayload = buildBootstrapClaims({
      iss: SAAS_ISSUER,
      peerId,
      accountId: request.accountId,
      tenant: request.tenant,
      deviceX25519PublicKey: request.devicePublicKey,
      devicePopPublicKey: request.devicePopPublicKey,
    });

    // REAL RS256 signature with the trust-chain private key; header.kid = trust kid.
    const jwt = await signBootstrapJwt(jwtPayload, trustChain);

    const response: BootstrapResponse = {
      jwt,
      peerId,
      // F2: deliver the well-known dev identity public key so the browser pins it
      // — ONLY in dev-open mode (this reference server has no registry/enrollment,
      // and the dev key is public, so serving it outside dev-open would re-open
      // the MITM). Omitted otherwise → the browser fail-closes on the register path.
      ...(DEV_OPEN ? { agentPublicKey: devOpenAgentIdentityPublicB64url() } : {}),
      jwksUrl: JWKS_URL,
      natsUrl: NATS_URL,
    };

    sendJson(res, response);
    console.log(`[bootstrap] Issued RS256 bootstrap JWT (kid=${trustChain.kid}) for peerId=${peerId}, tenant=${request.tenant}`);
  } catch (err) {
    console.error("[bootstrap] Error:", err);
    sendJson(res, { error: "Internal server error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// JWKS endpoint — serve the REAL public RSA JWK (matching kid)
// ---------------------------------------------------------------------------

function handleJwks(req: any, res: any, trustChain: RealTrustChain): void {
  setCorsHeaders(res);
  sendJson(res, trustChain.jwks);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const trustChain = await initTrustChain();

const server = createServer((req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);

  if (url.pathname === "/bootstrap") {
    void handleBootstrap(req, res, trustChain);
  } else if (url.pathname === "/.well-known/jwks.json") {
    handleJwks(req, res, trustChain);
  } else {
    setCorsHeaders(res);
    res.writeHead(404).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`[bootstrap] SaaS Bootstrap server listening on http://localhost:${PORT}`);
  console.log(`[bootstrap] Issuer (iss): ${SAAS_ISSUER}`);
  console.log(`[bootstrap] Signing kid: ${trustChain.kid}`);
  console.log(`[bootstrap] Bootstrap endpoint: http://localhost:${PORT}/bootstrap`);
  console.log(`[bootstrap] JWKS endpoint: http://localhost:${PORT}/.well-known/jwks.json`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[bootstrap] Shutting down gracefully...");
  server.close(() => {
    console.log("[bootstrap] Server closed");
    process.exit(0);
  });
});
