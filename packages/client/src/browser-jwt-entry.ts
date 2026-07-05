/**
 * Browser entry for the real-browser JWT + Proof-of-Possession register hop
 * (#19). This module is bundled (esbuild, platform=browser, IIFE) and injected
 * into a real headless Chromium page; `runJwtRegister` runs the ENTIRE flow
 * IN-PAGE so the Ed25519 PoP private key never crosses the Node↔page boundary.
 *
 * It is the in-browser port of `e2e/local/saas-issuer-roundtrip.ts` (the Node
 * driver): generate the device keys, bootstrap directly from the reference SaaS
 * issuer (CORS `*`), then drive the PRODUCTION `WebChannelNatsClient` through the
 * PoP HTTP register hop against the live gateway and await the encrypted reply.
 *
 * BROWSER-SAFE ONLY: uses crypto.subtle, fetch, btoa, TextEncoder — no `node:`
 * imports — so it survives the browser bundle. `WebChannelNatsClient` is itself
 * browser-safe (webcrypto + WebSocket only).
 */

import { WebChannelNatsClient } from "./nats-client.js";

export type RunJwtRegisterOptions = {
  /** NATS WebSocket URL (e.g. ws://127.0.0.1:<port>). */
  natsUrl: string;
  /** Reference SaaS issuer base URL serving POST /bootstrap (CORS `*`). */
  issuerUrl: string;
  /** Gateway base URL serving the PoP register routes. */
  gwUrl: string;
  accountId: string;
  tenant: string;
  peerId: string;
  /** Message text to send; the echo model returns it for the assertion. */
  text: string;
  /** Overall round-trip timeout (ms). */
  timeoutMs?: number;
};

/** base64url-encode raw bytes (browser-safe; no Buffer). */
function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Run the full in-page JWT + PoP register round-trip.
 *
 * @returns `{ replyText }` — the decrypted `agent_message` text.
 * @throws on bootstrap failure, PoP/register rejection (onError), or timeout.
 */
export async function runJwtRegister(
  opts: RunJwtRegisterOptions,
): Promise<{ replyText: string }> {
  const timeoutMs = opts.timeoutMs ?? 25000;

  // 1. Device X25519 key → devicePublicKey (b64url raw 32B). Extractable so we
  //    can export the raw public key; the server stamps it as cnf.jwk.
  const x25519 = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const x25519Raw = await crypto.subtle.exportKey("raw", x25519.publicKey);
  const devicePublicKey = b64url(x25519Raw);

  // 2. Device Ed25519 PoP key → devicePopPublicKey (jwk.x). NON-extractable: the
  //    private CryptoKey signs the register nonce and NEVER leaves the page.
  const ed25519 = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const edPubJwk = (await crypto.subtle.exportKey("jwk", ed25519.publicKey)) as { x?: string };
  if (!edPubJwk.x) throw new Error("Ed25519 public JWK missing 'x'");
  const devicePopPublicKey = edPubJwk.x;

  // 3. Ask the REAL reference issuer to mint + RS256-sign the bootstrap JWT.
  //    The issuer serves CORS `*`, so the browser fetches it directly in-page.
  const bootstrapRes = await fetch(`${opts.issuerUrl}/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      devicePublicKey,
      devicePopPublicKey,
      accountId: opts.accountId,
      tenant: opts.tenant,
      peerId: opts.peerId,
    }),
  });
  if (!bootstrapRes.ok) {
    throw new Error(
      `bootstrap failed: HTTP ${bootstrapRes.status} ${await bootstrapRes.text()}`,
    );
  }
  const { jwt, peerId, natsUrl: deliveredNatsUrl } = (await bootstrapRes.json()) as {
    jwt?: string;
    peerId?: string;
    natsUrl?: string;
  };
  if (!jwt || !peerId) throw new Error("bootstrap response missing jwt/peerId");

  // The SaaS is the rendezvous authority: dial the relay URL it returned in the
  // bootstrap response, falling back to the page-supplied `opts.natsUrl` only when
  // the issuer didn't send one (back-compat).
  const natsUrl = deliveredNatsUrl ?? opts.natsUrl;

  // 4. Production client with the `registration` (PoP HTTP register) path. The
  //    in-page Ed25519 private key is handed straight to the client — no
  //    serialization, no boundary crossing.
  const client = new WebChannelNatsClient({
    url: natsUrl,
    jwt,
    accountId: opts.accountId,
    tenant: opts.tenant,
    peerId,
    registration: {
      devicePrivateKey: ed25519.privateKey,
      // Phase 6: the cnf X25519 private key — the session key K arrives
      // wrapped in the register reply (no handshake on this path).
      deviceX25519PrivateKey: x25519.privateKey,
    },
  });

  return await new Promise<{ replyText: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error("TIMEOUT waiting for agent reply"));
    }, timeoutMs);

    // Registration failure (PoP/JWT rejected) is terminal and fail-closed.
    client.onError((e) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`register-FAIL: ${e.message}`));
    });

    client.onMessage((m) => {
      if (m.type === "agent_message") {
        clearTimeout(timer);
        const replyText = m.text ?? "";
        client.disconnect();
        resolve({ replyText });
      }
    });

    // The client buffers the send through NATS connect + HTTP PoP register +
    // handshake, so no fixed sleep is needed (matches saas-issuer-roundtrip.ts).
    client.connect();
    client.sendUserMessage(opts.text);
  });
}

// ---------------------------------------------------------------------------
// #21 ALL-REAL fusion: NKEY-auth to a JWT-auth nats-server AND the PoP register
// hop, both from ONE in-page flow against the unified reference issuer.
// ---------------------------------------------------------------------------

export type RunAllRealOptions = {
  /** JWT-auth NATS WebSocket URL (NKEY challenge-response required). */
  natsUrl: string;
  /** Unified reference issuer (serves /test/nats-user + /test/bootstrap-jwt, CORS `*`). */
  issuerUrl: string;
  /** Gateway base URL serving the PoP register routes. */
  gwUrl: string;
  accountId: string;
  tenant: string;
  peerId: string;
  /** Message text to send; the echo model returns it for the assertion. */
  text: string;
  /** Overall round-trip timeout (ms). */
  timeoutMs?: number;
};

/**
 * Run the full in-page ALL-REAL round-trip:
 *   - mint tenant-scoped NATS user creds (raw seed) from the issuer,
 *   - mint a PoP bootstrap JWT (X25519 cnf.jwk + Ed25519 pop_jwk) from the issuer,
 *   - drive the PRODUCTION WebChannelNatsClient with BOTH `natsCredentials`
 *     (NATS-layer NKEY auth) AND `registration` (HTTP PoP register hop),
 *   - complete the X25519 handshake + encrypted echo round-trip.
 *
 * @returns `{ replyText }` — the decrypted `agent_message` text.
 * @throws on any fetch failure, NKEY/PoP rejection (onError), or timeout.
 */
export async function runAllReal(
  opts: RunAllRealOptions,
): Promise<{ replyText: string }> {
  const timeoutMs = opts.timeoutMs ?? 25000;

  // 1. Device X25519 key → cnf.jwk (b64url raw 32B). Extractable to export raw pub.
  const x25519 = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const x25519Raw = await crypto.subtle.exportKey("raw", x25519.publicKey);
  const deviceX25519PublicKey = b64url(x25519Raw);

  // 2. Device Ed25519 PoP key → pop_jwk (jwk.x). NON-extractable: signs the
  //    register nonce in-page and NEVER leaves the page.
  const ed25519 = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const edPubJwk = (await crypto.subtle.exportKey("jwk", ed25519.publicKey)) as { x?: string };
  if (!edPubJwk.x) throw new Error("Ed25519 public JWK missing 'x'");
  const devicePopPublicKey = edPubJwk.x;

  // 3. Tenant-scoped NATS user creds (for NATS-layer NKEY auth). userSeedRaw is
  //    base64url of the raw 32-byte Ed25519 seed — browser signs with it directly.
  const credsRes = await fetch(`${opts.issuerUrl}/test/nats-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Per-peer browser creds: scope to the peerId we bootstrap under below.
    body: JSON.stringify({ tenant: opts.tenant, role: "browser", peerId: opts.peerId }),
  });
  if (!credsRes.ok) {
    throw new Error(`nats-user failed: HTTP ${credsRes.status} ${await credsRes.text()}`);
  }
  const { userJwt, userSeedRaw, natsUrl: deliveredNatsUrl } = (await credsRes.json()) as {
    userJwt?: string;
    userSeedRaw?: string;
    natsUrl?: string;
  };
  if (!userJwt || !userSeedRaw) throw new Error("nats-user response missing userJwt/userSeedRaw");

  // SaaS-delivered relay URL wins over the page-supplied `opts.natsUrl` (fallback).
  const natsUrl = deliveredNatsUrl ?? opts.natsUrl;

  // 4. PoP bootstrap JWT (RS256, this issuer's trust chain) for the register hop.
  const bootRes = await fetch(`${opts.issuerUrl}/test/bootstrap-jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant: opts.tenant,
      accountId: opts.accountId,
      peerId: opts.peerId,
      deviceX25519PublicKey,
      devicePopPublicKey,
    }),
  });
  if (!bootRes.ok) {
    throw new Error(`bootstrap-jwt failed: HTTP ${bootRes.status} ${await bootRes.text()}`);
  }
  const { jwt, peerId } = (await bootRes.json()) as { jwt?: string; peerId?: string };
  if (!jwt || !peerId) throw new Error("bootstrap-jwt response missing jwt/peerId");

  // 5. Production client with BOTH NATS-layer NKEY auth AND the PoP register hop.
  const client = new WebChannelNatsClient({
    url: natsUrl,
    jwt,
    accountId: opts.accountId,
    tenant: opts.tenant,
    peerId,
    natsCredentials: { userJwt, userSeedRaw },
    registration: {
      devicePrivateKey: ed25519.privateKey,
      // Phase 6: register-delivered conversation key (no handshake).
      deviceX25519PrivateKey: x25519.privateKey,
    },
  });

  return await new Promise<{ replyText: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error("TIMEOUT waiting for agent reply"));
    }, timeoutMs);

    client.onError((e) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`allreal-FAIL: ${e.message}`));
    });

    client.onMessage((m) => {
      if (m.type === "agent_message") {
        clearTimeout(timer);
        const replyText = m.text ?? "";
        client.disconnect();
        resolve({ replyText });
      }
    });

    client.connect();
    client.sendUserMessage(opts.text);
  });
}
