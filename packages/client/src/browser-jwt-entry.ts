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
  agentId: string;
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
      agentId: opts.agentId,
      tenant: opts.tenant,
      peerId: opts.peerId,
    }),
  });
  if (!bootstrapRes.ok) {
    throw new Error(
      `bootstrap failed: HTTP ${bootstrapRes.status} ${await bootstrapRes.text()}`,
    );
  }
  const { jwt, peerId } = (await bootstrapRes.json()) as { jwt?: string; peerId?: string };
  if (!jwt || !peerId) throw new Error("bootstrap response missing jwt/peerId");

  // 4. Production client with the `registration` (PoP HTTP register) path. The
  //    in-page Ed25519 private key is handed straight to the client — no
  //    serialization, no boundary crossing.
  const client = new WebChannelNatsClient({
    url: opts.natsUrl,
    jwt,
    agentId: opts.agentId,
    tenant: opts.tenant,
    peerId,
    registration: {
      registerBaseUrl: opts.gwUrl,
      devicePrivateKey: ed25519.privateKey,
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
