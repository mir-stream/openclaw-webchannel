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
 *      `webchannel-pop:<op>:<peerId>:<nonce>` with the device key, and present it
 *      (`{op:"register"}`), all over NATS request/reply on the account's
 *      `…{peerId}.register` subject. A wrong/missing/expired proof replies a
 *      generic `unauthorized`.
 *   3. `unregisterWithPop()` — the same challenge→sign step in front of the
 *      fire-and-forget `{op:"unregister"}` teardown (issue #51), so a captured
 *      plaintext teardown frame cannot be replayed off the relay.
 *
 * `registerWithPop` also mints the protocol-v3 `clientNonce` freshness anchor
 * (`generateClientNonce`), fresh per ATTEMPT, and carries it out on the result so
 * the caller can rebuild the wrapped-key AAD. That value must always be the
 * locally generated one — see `RegisterWithPopResult.clientNonce`.
 *
 * The signed-message format MUST match the plugin's `popSignedMessage`
 * (`webchannel-pop:${op}:${peerId}:${nonce}`) byte-for-byte — see the conformance
 * test and the cross-package `pop-signed-message-parity.test.ts`.
 */

import { base64urlEncode, randomBytes } from "./e2e-crypto-browser.js";
import type { WrappedConversationKey } from "./e2e-crypto-browser.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";

/**
 * Entropy of the register freshness anchor, in bytes. 32 ≫ the 16-byte floor the
 * plugin validator enforces (`CLIENT_NONCE_MIN_LENGTH` = 22 base64url chars).
 */
const CLIENT_NONCE_BYTES = 32;

/**
 * Generate the per-attempt `clientNonce` — the BROWSER-CHOSEN freshness anchor
 * bound into the wrapped-conversation-key AAD (protocol v3).
 *
 * Call this once PER REGISTER ATTEMPT, never once per `registerWithPop` call: a
 * retry that reused the previous attempt's value would leave the previous
 * attempt's captured reply replayable onto the retry, which is the whole thing
 * the anchor prevents.
 *
 * It must be client-chosen. The agent's PoP challenge reply is unauthenticated
 * plaintext and the browser only presence-checks the nonce it contains, so a
 * relay can answer the challenge itself and replay a MATCHED (old nonce, old
 * wrap) pair without the agent participating at all. Only a value generated
 * locally is one the relay cannot choose.
 *
 * base64url of 32 CSPRNG bytes — the alphabet excludes the `0x1F` AAD delimiter,
 * so the AAD encoding needs no escaping.
 */
export function generateClientNonce(): string {
  return base64urlEncode(randomBytes(CLIENT_NONCE_BYTES));
}

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
 * The operations a PoP proof can authorize. MUST match the plugin's `PopOp`
 * (packages/plugin/src/pop-signed-message.ts).
 */
export type PopOp = "register" | "unregister";

/**
 * The exact message the device signs. MUST be byte-identical to the plugin's
 * `popSignedMessage` — `pop-signed-message-parity.test.ts` asserts it directly
 * against the agent implementation.
 *
 *   `webchannel-pop:{op}:{peerId}:{nonce}`
 *
 *   - `op` stops a proof minted for one operation authorizing another. Both ops
 *     draw from the same per-peer nonce bucket on the agent, so without this a
 *     `register` proof was also a valid `unregister` proof — and a relay can
 *     obtain an unconsumed one for free by SUPPRESSING the register frame, which
 *     is indistinguishable from the lost frame the retry loop below exists to
 *     absorb.
 *   - `peerId` stops a captured signature acting on a different peer.
 *   - `nonce` is single-use and agent-issued, so it stops replay.
 *
 * Injective: `:` cannot occur in any field (closed op vocabulary, subject-token
 * peerId, base64url nonce).
 */
export function popSignedMessage(op: PopOp, peerId: string, nonce: string): string {
  return `webchannel-pop:${op}:${peerId}:${nonce}`;
}

/** Sign `popSignedMessage(op, peerId, nonce)` with the device Ed25519 key → base64url. */
export async function signPop(
  privateKey: CryptoKey,
  op: PopOp,
  peerId: string,
  nonce: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(popSignedMessage(op, peerId, nonce)),
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
 * Typed terminal failure for the mandatory protocol-v2 register contract.
 * Used for an explicit plugin 426 as well as malformed reply versions so the
 * connection layer never misclassifies an upgrade requirement as `server`.
 */
export class ProtocolMismatchError extends Error {
  readonly advertisedVersion: unknown;
  constructor(message: string, advertisedVersion?: unknown) {
    super(message);
    this.name = "ProtocolMismatchError";
    this.advertisedVersion = advertisedVersion;
  }
}

/**
 * Thrown when an account has reached the agent-side conversation-key capacity.
 * This is terminal for the current account and credentials: retrying or
 * re-authenticating cannot create room. Operators must admit new users through
 * another OpenClaw WebChannel account.
 */
export class PopCapacityError extends Error {
  readonly code = 507;
  constructor() {
    super("pop-register: agent account conversation-key capacity reached (code 507)");
    this.name = "PopCapacityError";
  }
}

/**
 * Thrown when a register reply carries a required `protocolVersion` that is
 * missing or not a safe-integer number (e.g. the string "2" from a buggy or
 * third-party plugin). This is exactly the silent-break class the version
 * handshake exists to kill: without this guard the malformed value degrades to
 * `undefined` in a permissive copy-through and mask a plugin speaking an
 * unintelligible contract. Protocol v2 is mandatory: missing and wrong-typed
 * values are terminal, without coercion.
 */
export class ProtocolVersionMalformedError extends ProtocolMismatchError {
  constructor(received: unknown) {
    super(
      `pop-register: register reply carried a non-numeric protocolVersion ` +
        `(${typeof received} ${JSON.stringify(received)}) — the agent-plugin is speaking ` +
        `an unintelligible wire protocol`,
      received,
    );
    this.name = "ProtocolVersionMalformedError";
  }
}

/**
 * Classify a `registerWithPop` throw as TERMINAL (true) vs TRANSIENT (false).
 *
 * TERMINAL = a rejected proof/token (`PopRejectedError`), mandatory-v2 mismatch
 * (`ProtocolMismatchError`), account capacity rejection (`PopCapacityError`),
 * or non-transient server failure (`PopServerError`): redialing the same peer
 * cannot change the reply.
 *
 * TRANSIENT = everything else `registerWithPop` throws: a request timeout, a
 * `503` (JWKS unreachable), or retry-exhaustion because the AGENT is offline
 * while the relay is healthy. The credentials are fine; the peer was momentarily
 * unreachable, so the caller should keep reconnecting/re-attempting.
 */
export function isTerminalRegisterError(err: unknown): boolean {
  return (
    err instanceof PopRejectedError ||
    err instanceof PopCapacityError ||
    err instanceof PopServerError ||
    err instanceof ProtocolMismatchError
  );
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
   * The freshness anchor THIS browser generated for the attempt that succeeded,
   * carried out so the unwrap site (two modules away, in nats-client.ts) can
   * rebuild the wrap AAD. Internal plumbing — it adds NO wire surface.
   *
   * INVARIANT: this is always the LOCALLY GENERATED value. It is never sourced
   * from the register reply, and the agent deliberately does not echo it. Reading
   * it back off the wire would hand the choice of anchor to the relay and defeat
   * the replay defence entirely.
   */
  clientNonce: string;
  /**
   * The agent-plugin's wire-protocol version, echoed in the register reply.
   * Required by protocol v2. Missing, malformed, or mismatched values are
   * terminal. A value that disagrees with the
   * client's `WEBCHANNEL_PROTOCOL_VERSION` is TERMINAL at the call site.
   */
  protocolVersion: number;
  /** The agent-plugin's package version string (diagnostics only). OPTIONAL. */
  pluginVersion?: string;
};

/** Shape of an error reply (generic — no detail, so the reply is no oracle). */
type ErrorReply = { error?: string; code?: number; protocolVersion?: unknown };

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
    // 0. A FRESH freshness anchor per ATTEMPT (not per call). Reusing it across
    //    retries would keep the previous attempt's captured register reply
    //    replayable onto this one.
    const clientNonce = generateClientNonce();

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

    // 2. Sign the bound message with the device Ed25519 key. The op is part of
    //    the signature, so this proof cannot be relabelled as a teardown.
    const signature = await signPop(opts.devicePrivateKey, "register", opts.peerId, nonce);

    // 3. Register — present the proof. A timeout retries (the register may have
    //    landed but its reply was lost); an error reply is terminal.
    // `Omit<…, "clientNonce">` is LOAD-BEARING, not tidiness. The whole freshness
    // anchor rests on the browser using the value it generated; if the reply type
    // carried `clientNonce`, `registerReply.clientNonce` would typecheck cleanly
    // and a future edit could hand the choice of anchor to the relay with nothing
    // but a comment standing in the way. Omitting it makes that read a COMPILE
    // error. The agent does not send the field either — both halves matter.
    let registerReply: (Omit<RegisterWithPopResult, "clientNonce"> & ErrorReply);
    try {
      registerReply = (await opts.request({
        op: "register",
        token: opts.jwt,
        nonce,
        signature,
        // The current protocol makes this request field mandatory; the plugin
        // rejects a missing, malformed, or mismatched value before PoP/key
        // establishment (and before the clientNonce check, so an outdated client
        // gets a terminal 426 rather than a 401 re-login loop).
        protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
        // v3: the browser-chosen freshness anchor. Top-level and unconditional —
        // NOT nested under the PoP fields, because the agent binds it into the
        // wrap AAD whether or not PoP is in play.
        clientNonce,
      })) as typeof registerReply;
    } catch (err) {
      lastTimeout = err as Error;
      continue;
    }
    if (registerReply?.error) {
      // 503 = transient (JWKS unreachable): retry like a lost reply. 401 = genuine
      // reject: terminal. The exact capacity reply is terminal and separately
      // classified; any other reply (e.g. 500, or an unknown 507) is a terminal
      // server failure.
      if (registerReply.code === 503) {
        lastTimeout = new Error("pop-register: register unavailable (503) — retrying");
        continue;
      }
      if (registerReply.code === 401) throw new PopRejectedError();
      if (registerReply.code === 426) {
        const advertised = registerReply.protocolVersion;
        if (typeof advertised !== "number" || !Number.isSafeInteger(advertised)) {
          throw new ProtocolVersionMalformedError(advertised);
        }
        throw new ProtocolMismatchError(
          `pop-register: agent-plugin rejected protocol v${WEBCHANNEL_PROTOCOL_VERSION} ` +
            `and requires v${advertised}`,
          advertised,
        );
      }
      if (registerReply.code === 507 && registerReply.error === "capacity_exceeded") {
        throw new PopCapacityError();
      }
      throw new PopServerError(registerReply.code);
    }
    // Protocol v2 is breaking and mandatory in both directions. Missing and
    // malformed values are terminal just like a numeric mismatch.
    const pv: unknown = registerReply.protocolVersion;
    if (typeof pv !== "number" || !Number.isSafeInteger(pv)) {
      throw new ProtocolVersionMalformedError(pv);
    }
    // Everything else in this result is assembled from `registerReply`. The
    // clientNonce deliberately is NOT: it is the value THIS function generated
    // above. Do not "simplify" this by reading `registerReply.clientNonce` — an
    // echoed anchor is a relay-chosen anchor, and the replay defence collapses.
    const result: RegisterWithPopResult = {
      peerId: opts.peerId,
      registered: true,
      clientNonce,
      protocolVersion: pv,
    };
    if (registerReply.wrappedConversationKey) {
      result.wrappedConversationKey = registerReply.wrappedConversationKey;
    }
    // pluginVersion stays LENIENT (advisory only): a non-string drops to
    // undefined without failing the connection.
    if (typeof registerReply.pluginVersion === "string") {
      result.pluginVersion = registerReply.pluginVersion;
    }
    return result;
  }

  throw lastTimeout ?? new Error("pop-register: registration failed after retries");
}

/** Publish a register-subject frame fire-and-forget (no reply-to, no response). */
export type RegisterPublishFn = (payload: unknown) => void | Promise<void>;

export type UnregisterWithPopOptions = {
  /**
   * One NATS request/reply round-trip on the register subject (for `challenge`).
   *
   * REPLY-TO CONSTRAINT: the agent publishes register-subject replies ONLY to
   * `webchannel.{tenant}.{accountId}.{peerId}.reginbox.{token}` — every other
   * reply-to is dropped with no response (allowlist in the plugin's
   * `NatsChannel.handleRegister`). A `request` wired with a default `_INBOX.*`
   * reply-to therefore never receives the challenge nonce: this function times
   * out, returns `false`, and the teardown silently never happens. Set the reply
   * prefix explicitly, as `WebChannelNatsClient` does for its own register hop.
   */
  request: RegisterRequestFn;
  /** Fire-and-forget publish on the register subject (for `unregister` itself). */
  publish: RegisterPublishFn;
  /** The bootstrap JWT (RS256) carrying sub=peerId and pop_jwk. */
  jwt: string;
  /** peerId = JWT `sub` (the message binding). */
  peerId: string;
  /** Device Ed25519 private key from `generateDevicePopKeyPair()`. */
  devicePrivateKey: CryptoKey;
};

/**
 * Tear down this peer's agent-side subscription and session key — with proof of
 * possession (issue #51).
 *
 * Before v3 `{op:"unregister", token}` was authenticated by JWT + tenant +
 * subject match ALONE. The bootstrap JWT crosses the untrusted relay in
 * plaintext, so a relay-positioned observer could capture that frame and replay
 * it until the JWT expired, tearing down the victim's session each time with no
 * signal to the victim. The agent now requires the same single-use PoP proof it
 * requires for `register`: challenge → sign → present. Because
 * `PopChallengeStore` consumes the nonce, a captured frame is inert on replay.
 *
 * Fire-and-forget by contract, on BOTH sides: the agent never replies (success
 * and every failure are silent no-ops, so the op is not an oracle), and this
 * function never throws — a failed challenge simply means no teardown happened,
 * and the agent reclaims the peer on its own terms (peer cap / re-register).
 *
 * @returns `true` if an unregister frame was published, `false` if the challenge
 *          leg failed and nothing was sent. NOT an acknowledgement of teardown —
 *          there is no reply to acknowledge with.
 */
export async function unregisterWithPop(opts: UnregisterWithPopOptions): Promise<boolean> {
  let nonce: string | undefined;
  try {
    const challengeReply = (await opts.request({ op: "challenge", token: opts.jwt })) as
      | ({ nonce?: string } & ErrorReply)
      | undefined;
    if (challengeReply?.error) return false;
    nonce = challengeReply?.nonce;
  } catch {
    // Timeout / transport failure — nothing to tear down with.
    return false;
  }
  if (!nonce) return false;

  try {
    const signature = await signPop(opts.devicePrivateKey, "unregister", opts.peerId, nonce);
    await opts.publish({ op: "unregister", token: opts.jwt, nonce, signature });
    return true;
  } catch {
    return false;
  }
}
