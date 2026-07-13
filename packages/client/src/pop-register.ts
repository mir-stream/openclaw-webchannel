/**
 * Proof-of-Possession registration — the browser PRODUCER side of the PoP gate.
 *
 * The plugin's register handler (`packages/plugin/index-nats.ts` +
 * `pop-challenge.ts`) reject any peer whose bootstrap JWT carries a `pop_jwk`
 * unless the caller proves possession of the matching Ed25519 PRIVATE key by
 * signing an agent-issued, single-use nonce. This module is the device half:
 *
 *   1. `generateDevicePopKeyPair()` — the device makes its Ed25519 PoP key. The
 *      PUBLIC key (JWK) is sent to SaaS at bootstrap (→ `pop_jwk`); the PRIVATE
 *      key never leaves the device.
 *   2. `registerWithPop()` — request a nonce (`{op:"challenge"}`), sign
 *      `webchannel-pop:<peerId>:<nonce>` with the device key, and present it
 *      (`{op:"register"}`), all over NATS request/reply on the account's
 *      `…{peerId}.register` subject. A wrong/missing/expired proof replies a
 *      generic `unauthorized`.
 *
 * The signed-message format MUST match the plugin's `popSignedMessage`
 * (`webchannel-pop:${peerId}:${nonce}`) byte-for-byte — see the conformance test.
 */

import { base64urlEncode } from "./e2e-crypto-browser.js";
import type { WrappedConversationKey } from "./e2e-crypto-browser.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";

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

/**
 * One register round-trip: send a JSON request object to the account's
 * `…{peerId}.register` subject and resolve with the parsed JSON reply. This is
 * the NATS request/reply seam — injected by `WebChannelNatsClient` (which wraps
 * `NatsClient.request`) and by tests. It performs a SINGLE round-trip with no
 * internal retry; `registerWithPop` owns the retry/backoff policy so it can
 * restart from a fresh challenge when a reply is lost.
 */
export type RegisterRequestFn = (payload: unknown) => Promise<unknown>;

export type RegisterWithPopOptions = {
  /** One NATS request/reply round-trip on the register subject. */
  request: RegisterRequestFn;
  /** The bootstrap JWT (RS256) carrying sub=peerId, cnf.jwk and pop_jwk. */
  jwt: string;
  /** peerId = JWT `sub` (the message binding). */
  peerId: string;
  /** Device Ed25519 private key from `generateDevicePopKeyPair()`. */
  devicePrivateKey: CryptoKey;
  /**
   * How many times to restart the challenge→register unit after a lost reply
   * (request timeout). Default 2 (so 3 attempts total). A real relay can drop a
   * one-shot reply; because server-side register is idempotent (re-wrap + re-
   * snapshot), a fresh challenge + re-register on the next attempt recovers.
   */
  retries?: number;
};

/** Thrown when the agent rejects the proof (generic `unauthorized` reply). */
export class PopRejectedError extends Error {
  constructor(message = "Proof-of-Possession rejected at registration") {
    super(message);
    this.name = "PopRejectedError";
  }
}

/**
 * Thrown on a non-401, non-503 error reply at register — a server-side failure
 * (e.g. code 500) that is TERMINAL: restarting the same request with the same
 * credentials cannot fix it. Distinct from `PopRejectedError` (bad proof/token)
 * so the caller can classify without matching on message strings. Carries the
 * reply `code` for diagnostics.
 */
export class PopServerError extends Error {
  readonly code?: number;
  constructor(code?: number) {
    super(`pop-register: registration failed (code ${code ?? "?"})`);
    this.name = "PopServerError";
    this.code = code;
  }
}

/**
 * Classify a `registerWithPop` throw as TERMINAL (true) vs TRANSIENT (false).
 *
 * TERMINAL = a rejected proof/token (`PopRejectedError`) or a non-transient
 * server failure (`PopServerError`): the SAME bootstrap credentials will never
 * be accepted, so redialing cannot help — the caller must surface a hard error.
 *
 * TRANSIENT = everything else `registerWithPop` throws: a request timeout, a
 * `503` (JWKS unreachable), or retry-exhaustion because the AGENT is offline
 * while the relay is healthy. The credentials are fine; the peer was momentarily
 * unreachable, so the caller should keep reconnecting/re-attempting.
 */
export function isTerminalRegisterError(err: unknown): boolean {
  return err instanceof PopRejectedError || err instanceof PopServerError;
}

/** Successful register-hop result (parsed register reply). */
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
  /**
   * The agent-plugin's wire-protocol version, echoed in the register reply.
   * OPTIONAL: a pre-v1 plugin omits it (the caller treats absence as non-fatal
   * and exposes `agentProtocolVersion: null`). A value that disagrees with the
   * client's `WEBCHANNEL_PROTOCOL_VERSION` is TERMINAL at the call site.
   */
  protocolVersion?: number;
  /** The agent-plugin's package version string (diagnostics only). OPTIONAL. */
  pluginVersion?: string;
};

/** Shape of an error reply (generic — no detail, so the reply is no oracle). */
type ErrorReply = { error?: string; code?: number };

/**
 * Run the full PoP registration over NATS request/reply: challenge → sign →
 * register, with a bounded retry that restarts from a fresh challenge on a lost
 * reply (request timeout).
 *
 * Retry model:
 *   - a TIMEOUT (no reply — a dropped one-shot) retries the whole unit: the
 *     register may have SUCCEEDED server-side with only its reply lost, and a
 *     fresh challenge + idempotent re-register recovers it;
 *   - a `code:503` ("unavailable") reply is a TRANSIENT infra fault (the agent
 *     could not reach its JWKS source) and is RETRIED like a timeout — a momentary
 *     IdP hiccup must not permanently kill the session;
 *   - a `code:401` reply is TERMINAL: a genuine bad proof / rejected token
 *     (→ PopRejectedError) that retrying cannot fix;
 *   - any other error code is a server-side failure surfaced as-is (terminal).
 *
 * @returns the parsed register reply (`peerId`, `registered`, and the
 *          agent-wrapped conversation key when the plugin delivers one).
 * @throws {PopRejectedError} on a genuine proof rejection.
 * @throws {Error} on a non-401 error reply or after exhausting timeout retries.
 */
export async function registerWithPop(
  opts: RegisterWithPopOptions,
): Promise<RegisterWithPopResult> {
  const retries = opts.retries ?? 2;
  let lastTimeout: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // 1. Challenge — obtain a single-use nonce bound to our peerId. A timeout
    //    retries the unit; a received error reply (bad JWT) is terminal.
    let challengeReply: ({ nonce?: string } & ErrorReply);
    try {
      challengeReply = (await opts.request({ op: "challenge", token: opts.jwt })) as typeof challengeReply;
    } catch (err) {
      lastTimeout = err as Error;
      continue;
    }
    if (challengeReply?.error) {
      // A transient 503 (JWKS unreachable) retries the whole unit like a timeout;
      // any other error at challenge is a terminal rejection.
      if (challengeReply.code === 503) {
        lastTimeout = new Error("pop-register: challenge unavailable (503) — retrying");
        continue;
      }
      throw new PopRejectedError("Registration rejected at challenge (unauthorized)");
    }
    const nonce = challengeReply?.nonce;
    if (!nonce) {
      lastTimeout = new Error("pop-register: challenge reply missing nonce");
      continue;
    }

    // 2. Sign the bound message with the device Ed25519 key.
    const signature = await signPop(opts.devicePrivateKey, opts.peerId, nonce);

    // 3. Register — present the proof. A timeout retries (the register may have
    //    landed but its reply was lost); an error reply is terminal.
    let registerReply: (RegisterWithPopResult & ErrorReply);
    try {
      registerReply = (await opts.request({
        op: "register",
        token: opts.jwt,
        nonce,
        signature,
        // Advertise the client's wire-protocol version. A pre-v1 plugin ignores
        // it; a v1 plugin echoes its own version back so the caller can enforce
        // a match (see the register policy in nats-client.ts).
        protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
      })) as typeof registerReply;
    } catch (err) {
      lastTimeout = err as Error;
      continue;
    }
    if (registerReply?.error) {
      // 503 = transient (JWKS unreachable): retry like a lost reply. 401 = genuine
      // reject: terminal. Anything else (e.g. 500): terminal server failure.
      if (registerReply.code === 503) {
        lastTimeout = new Error("pop-register: register unavailable (503) — retrying");
        continue;
      }
      if (registerReply.code === 401) throw new PopRejectedError();
      throw new PopServerError(registerReply.code);
    }
    // Carry the (optional) version fields through to the caller for its handshake
    // policy + state exposure; absent fields stay undefined (pre-v1 plugin).
    const result: RegisterWithPopResult = { peerId: opts.peerId, registered: true };
    if (registerReply.wrappedConversationKey) {
      result.wrappedConversationKey = registerReply.wrappedConversationKey;
    }
    if (typeof registerReply.protocolVersion === "number") {
      result.protocolVersion = registerReply.protocolVersion;
    }
    if (typeof registerReply.pluginVersion === "string") {
      result.pluginVersion = registerReply.pluginVersion;
    }
    return result;
  }

  throw lastTimeout ?? new Error("pop-register: registration failed after retries");
}
