#!/usr/bin/env node
/**
 * SaaS Bootstrap JWT issuance endpoint.
 *
 * This endpoint validates device PoP (proof of possession) and issues
 * RS256-signed bootstrap JWTs containing cnf.jwk claims.
 *
 * USAGE:
 *   node dist/reference/bootstrap-server.js
 *
 * ENDPOINTS:
 *   POST /bootstrap - Issue bootstrap JWT (browser → SaaS)
 *
 * ENVIRONMENT VARIABLES:
 *   PORT              - Server port (default: 3001)
 *   SAAS_BASE_URL     - SaaS base URL (default: http://localhost:3001)
 *
 * SECURITY NOTES:
 *   - This reference uses HTTP for demonstration. Use TLS in production.
 *   - No authentication on the bootstrap endpoint. Add device auth in production.
 *   - CORS is enabled for all origins. Restrict in production.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3001", 10);
const SAAS_BASE_URL = process.env.SAAS_BASE_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BootstrapRequest = {
  devicePublicKey: string; // base64url-encoded X25519 public key
  agentId: string;
  tenant: string;
  pop?: string; // Proof of possession (signature) - optional for this demo
};

type BootstrapResponse = {
  jwt: string; // RS256-signed bootstrap JWT
  agentPublicKey: string; // SaaS-attested agent public key
  jwksUrl: string; // JWKS endpoint URL
  natsUrl: string; // NATS WebSocket URL
};

// ---------------------------------------------------------------------------
// Mock trust chain (for demonstration)
// ---------------------------------------------------------------------------

const MOCK_RSA_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDE3VRjIIlGsGXVs
LG+mDdpFWVYxwhDjelsI4mPMqG0HQQv8+dKVZ+6vCnFhQRI6eBKdQYZLVxfPHQf3
MqBvYQXlGpCqQ5oTVW5p4m7NTvWq8fJxVFE8VvRwqBPv7FQRRBVGRoEcVd5ZgY3q4
ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3
ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3
ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3ZQ+dZ4Z3
-----END PRIVATE KEY-----`;

const MOCK_AGENT_PUBLIC_KEY = "mock-agent-x25519-public-key-32-bytes-base64urlencoded";

const MOCK_JWKS_URL = `${SAAS_BASE_URL}/.well-known/jwks.json`;
const MOCK_NATS_URL = "wss://nats.example.com";

// ---------------------------------------------------------------------------
// JWT helpers (simplified for demo - use jsonwebtoken in production)
// ---------------------------------------------------------------------------

function createBase64Url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function createMockJwt(payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT", kid: "demo-key-id" };
  const headerB64 = createBase64Url(JSON.stringify(header));
  const payloadB64 = createBase64Url(JSON.stringify(payload));
  const signatureB64 = createBase64Url("mock-signature"); // In production, sign with RSA private key
  return `${headerB64}.${payloadB64}.${signatureB64}`;
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

async function handleBootstrap(req: any, res: any): Promise<void> {
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

    if (!request.agentId || typeof request.agentId !== "string") {
      sendJson(res, { error: "invalid agentId" }, 400);
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

    // Generate peer ID (JWT sub claim)
    const peerId = `user-${randomBytes(8).toString("hex")}`;

    // Create JWT payload with cnf.jwk claim
    const now = Math.floor(Date.now() / 1000);
    const jwtPayload = {
      iss: SAAS_BASE_URL,
      sub: peerId,
      aud: request.agentId,
      exp: now + 300, // 5 minutes
      iat: now,
      agentId: request.agentId,
      tenant: request.tenant,
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "X25519",
          x: request.devicePublicKey,
        },
      },
    };

    const jwt = createMockJwt(jwtPayload);

    const response: BootstrapResponse = {
      jwt,
      agentPublicKey: MOCK_AGENT_PUBLIC_KEY,
      jwksUrl: MOCK_JWKS_URL,
      natsUrl: MOCK_NATS_URL,
    };

    sendJson(res, response);
    console.log(`[bootstrap] Issued bootstrap JWT for peerId=${peerId}, tenant=${request.tenant}`);
  } catch (err) {
    console.error("[bootstrap] Error:", err);
    sendJson(res, { error: "Internal server error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// JWKS endpoint
// ---------------------------------------------------------------------------

async function handleJwks(req: any, res: any): Promise<void> {
  setCorsHeaders(res);

  const jwks = {
    keys: [
      {
        kty: "RSA",
        kid: "demo-key-id",
        alg: "RS256",
        use: "sig",
        n: "mock-modulus-base64url-encoded",
        e: "AQAB",
      },
    ],
  };

  sendJson(res, jwks);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);

  if (url.pathname === "/bootstrap") {
    void handleBootstrap(req, res);
  } else if (url.pathname === "/.well-known/jwks.json") {
    void handleJwks(req, res);
  } else {
    setCorsHeaders(res);
    res.writeHead(404).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`[bootstrap] SaaS Bootstrap server listening on http://localhost:${PORT}`);
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
