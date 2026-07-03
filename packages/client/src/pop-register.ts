/**
 * Proof-of-Possession registration — the browser PRODUCER side of the PoP gate.
 *
 * The plugin's register routes (`packages/plugin/index-nats.ts` +
 * `pop-challenge.ts`) reject any peer whose bootstrap JWT carries a `pop_jwk`
 * unless the caller proves possession of the matching Ed25519 PRIVATE key by
 * signing a server-issued, single-use nonce. This module is the device half:
 *
 *   1. `generateDevicePopKeyPair()` — the device makes its Ed25519 PoP key. The
 *      PUBLIC key (JWK) is sent to SaaS at bootstrap (→ `pop_jwk`); the PRIVATE
 *      key never leaves the device.
 *   2. `registerWithPop()` — GET a nonce from `/register/challenge`, sign
 *      `webchannel-pop:<peerId>:<nonce>` with the device key, and POST it to
 *      `/register`. On a wrong/missing/expired proof the plugin returns 401.
 *
 * The signed-message format MUST match the plugin's `popSignedMessage`
 * (`webchannel-pop:${peerId}:${nonce}`) byte-for-byte — see the conformance test.
 */

import { base64urlEncode } from "./e2e-crypto-browser.js";
import type { WrappedConversationKey } from "./e2e-crypto-browser.js";

/** Device Ed25519 PoP public key in JWK form (matches the plugin's `pop_jwk`). */
export type DevicePopJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
};

export type DevicePopKeyPair = {
  /** Non-extractable Ed25519 signing key — never leaves the device. */
  privateKey: CryptoKey;
  /** Public JWK to send to SaaS at bootstrap (becomes the JWT `pop_jwk`). */
  publicJwk: DevicePopJwk;
};

/**
 * Generate the device's Ed25519 Proof-of-Possession key pair (Web Crypto).
 * The private key is non-extractable; only the public JWK is exported.
 */
export async function generateDevicePopKeyPair(): Promise<DevicePopKeyPair> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const x = (jwk as { x?: string }).x;
  if (!x) throw new Error("pop-register: Ed25519 public JWK is missing 'x'");
  return { privateKey: kp.privateKey, publicJwk: { kty: "OKP", crv: "Ed25519", x } };
}

/**
 * The exact message the device signs. MUST match the plugin's
 * `popSignedMessage`: binding peerId stops a captured signature registering a
 * different peer, and binding the nonce stops replay.
 */
export function popSignedMessage(peerId: string, nonce: string): string {
  return `webchannel-pop:${peerId}:${nonce}`;
}

/** Sign `popSignedMessage(peerId, nonce)` with the device Ed25519 key → base64url. */
export async function signPop(
  privateKey: CryptoKey,
  peerId: string,
  nonce: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(popSignedMessage(peerId, nonce)),
  );
  return base64urlEncode(new Uint8Array(sig));
}

export type RegisterWithPopOptions = {
  /** Base URL where the plugin serves its register routes (no trailing slash). */
  registerBaseUrl: string;
  /** The bootstrap JWT (RS256) carrying sub=peerId, cnf.jwk and pop_jwk. */
  jwt: string;
  /** peerId = JWT `sub` (the message binding). */
  peerId: string;
  /** Device Ed25519 private key from `generateDevicePopKeyPair()`. */
  devicePrivateKey: CryptoKey;
  /** Injectable fetch (defaults to global fetch) — for tests / non-browser hosts. */
  fetchImpl?: typeof fetch;
};

/** Thrown when the plugin rejects the proof (HTTP 401 at /register). */
export class PopRejectedError extends Error {
  constructor(message = "Proof-of-Possession rejected at registration (401)") {
    super(message);
    this.name = "PopRejectedError";
  }
}

/** Successful register-hop result (parsed register HTTP response). */
export type RegisterWithPopResult = {
  peerId: string;
  registered: true;
  /**
   * Phase 6 (multi-device): the peer's conversation key K, wrapped by the
   * agent to THIS device's X25519 `cnf` public key. Present when the plugin
   * runs the register-delivered key model; the caller unwraps it with the
   * device private key (`unwrapConversationKey`) instead of handshaking.
   */
  wrappedConversationKey?: WrappedConversationKey;
};

/**
 * Run the full PoP registration handshake: challenge → sign → register.
 *
 * @returns the parsed register response (`peerId`, `registered`, and the
 *          agent-wrapped conversation key when the plugin delivers one).
 * @throws {PopRejectedError} on a 401 from /register (bad/missing/expired proof).
 * @throws {Error} on transport / non-401 HTTP failures.
 */
export async function registerWithPop(
  opts: RegisterWithPopOptions,
): Promise<RegisterWithPopResult> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.registerBaseUrl.replace(/\/+$/, "");
  const authHeader = { Authorization: `Bearer ${opts.jwt}` };

  // 1. Challenge — obtain a single-use nonce bound to our peerId.
  const challengeRes = await f(`${base}/webchannel/nats/register/challenge`, {
    method: "POST",
    headers: authHeader,
  });
  if (!challengeRes.ok) {
    const body = await challengeRes.text().catch(() => "");
    throw new Error(
      `pop-register: challenge failed (HTTP ${challengeRes.status}${body ? `: ${body}` : ""})`,
    );
  }
  const { nonce } = (await challengeRes.json()) as { nonce?: string };
  if (!nonce) throw new Error("pop-register: challenge response missing nonce");

  // 2. Sign the bound message with the device Ed25519 key.
  const signature = await signPop(opts.devicePrivateKey, opts.peerId, nonce);

  // 3. Register — present the proof.
  const registerRes = await f(`${base}/webchannel/nats/register`, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature }),
  });
  if (registerRes.status === 401) throw new PopRejectedError();
  if (!registerRes.ok) {
    throw new Error(`pop-register: registration failed (HTTP ${registerRes.status})`);
  }
  // Parse the response body for the Phase 6 wrapped conversation key. A body
  // that fails to parse is treated as an old-plugin response (no wrapped key).
  let wrappedConversationKey: WrappedConversationKey | undefined;
  try {
    const body = (await registerRes.json()) as {
      wrappedConversationKey?: WrappedConversationKey;
    };
    wrappedConversationKey = body.wrappedConversationKey;
  } catch {
    /* old plugin / non-JSON body — legacy handshake path */
  }
  return wrappedConversationKey
    ? { peerId: opts.peerId, registered: true, wrappedConversationKey }
    : { peerId: opts.peerId, registered: true };
}
