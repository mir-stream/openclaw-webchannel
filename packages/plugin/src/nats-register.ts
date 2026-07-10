/**
 * Register-hop admission handler (register over NATS).
 *
 * This is the verify-and-admit core that used to live in the deleted HTTP
 * register routes. It now runs behind a NATS request/reply seam: a browser
 * publishes `{op:"challenge"|"register"|"unregister", …}` on its
 * account's `webchannel.{tenant}.{accountId}.{peerId}.register` subject, the
 * agent's channel routes the plaintext request here, and this function replies
 * (via `deps.reply`, published to the request's NATS reply-to inbox).
 *
 * Every identity check the HTTP route performed is preserved verbatim; only the
 * transport changed (HTTP → NATS). Extracted from `index-nats.ts` so it is
 * unit-testable without a live gateway/NATS: the I/O-heavy pieces (JWT verify,
 * the history-snapshot read) are injected.
 *
 * SECURITY NOTES
 *  - Identity comes from the VERIFIED JWT `sub` ONLY, never from the subject
 *    peerId. Browser NATS creds are now scoped to `webchannel.{tenant}.*.{peerId}.>`
 *    (packages/saas/src/nats-user-creds.ts), so a browser cannot even publish on
 *    another peerId's `.register` subject — but this handler ALSO rejects a
 *    subject/JWT peerId mismatch (`subjectPeerId !== identity.peerId`) as
 *    defense-in-depth.
 *  - EVERY operation (challenge, register, unregister) is JWT-authenticated and
 *    acts only on the verified peerId. `unregister` is NOT a special-cased
 *    unauthenticated teardown: an unverified/mismatched token is a silent no-op,
 *    so no one can tear down a peer they don't own.
 *  - Failure replies are a single opaque `unauthorized` (401) so the reply channel
 *    is never an oracle; the diagnostic detail stays in the agent's logs. Replay of
 *    a used single-use nonce collapses to the same generic rejection. A TRANSIENT
 *    infra fault (JWKS source unreachable) replies a distinct retryable
 *    `unavailable` (503) — this is not an oracle (both are non-admit), it only lets
 *    the client retry an infra hiccup instead of treating it as a terminal reject.
 *  - Moving the register hop onto NATS exposes the bootstrap JWT to the untrusted
 *    relay (the HTTP path carried it in a TLS Authorization header). The
 *    mitigation is unchanged: PoP (device key) + single-use, short-TTL nonce +
 *    short JWT TTL, so a captured bootstrap JWT alone cannot register.
 */

import { Buffer } from "node:buffer";

import type { AuthConfig } from "./auth.js";
import { TransientVerifyError } from "./auth.js";
import type { JwtIdentity } from "./jwt.js";
import type { PopChallengeStore } from "./pop-challenge.js";
import type { WrappedConversationKey } from "./late-join-decryptor.js";
import { resolveRequirePoP, popRequirementUnmet } from "./register-pop-gate.js";
import { assertValidSubjectToken } from "./subject-token.js";

/**
 * Generic register-reply payloads. ANY verification failure collapses to
 * `unauthorized` (no detail — the reply is never an oracle); an internal fault
 * (no conversation key established) replies a distinct, still-detail-free
 * `registration_failed`.
 */
export const REGISTER_UNAUTHORIZED = JSON.stringify({ error: "unauthorized", code: 401 });
export const REGISTER_FAILED = JSON.stringify({ error: "registration_failed", code: 500 });
/**
 * Transient/infra failure (the JWKS source was unreachable, so verification could
 * not be performed). Distinct, RETRYABLE code — the client retries it with backoff
 * like a lost reply, instead of treating it as a terminal 401. Not an oracle: it
 * reveals nothing about a specific token (a transient failure and a genuine reject
 * are both non-admit); only the retry disposition differs.
 */
export const REGISTER_UNAVAILABLE = JSON.stringify({ error: "unavailable", code: 503 });

export type RegisterHandlerDeps = {
  /** This account's auth config (the verifier enforces its own issuer + aud). */
  auth: AuthConfig | undefined;
  /** peerId segment of the `.register` subject — routing ONLY, never trusted. */
  subjectPeerId: string;
  /** Raw request payload (plaintext JSON; the browser has no session key yet). */
  payload: string;
  /** Publish the response to the request's NATS reply-to inbox. */
  reply: (response: string) => void;
  /** Verify the bootstrap JWT against `auth`; null ⇒ unauthenticated. */
  verifyIdentity: (jwt: string, auth: AuthConfig | undefined) => Promise<JwtIdentity | null>;
  /** Single-use PoP nonce store (issue on challenge, verify on register). */
  popChallenges: PopChallengeStore;
  /** Register the peer in this account's channel (loads/creates its stable K). */
  registerPeer: (peerId: string) => void;
  /** Wrap this account's conversation key K to the request's cnf device key. */
  wrapConversationKeyForDevice: (
    peerId: string,
    devicePublicKey: Uint8Array,
  ) => WrappedConversationKey | null;
  /** Unregister the peer from this account's channel (called only with a VERIFIED peerId). */
  unregisterPeer: (peerId: string) => void;
  /**
   * Fire the STATELESS initial history snapshot for a just-registered peer
   * (route resolution + detached self-read + `sendHistory`). Injected because it
   * needs the gateway `api`; kept out of this pure handler.
   */
  sendHistorySnapshot: (peerId: string) => void;
  /**
   * Fire the authoritative pending-approval snapshot for a just-registered peer
   * (#15). Injected because it reads the plugin's pending-approval store and
   * publishes on the account's channel; kept out of this pure handler. Called on
   * EVERY successful register (an empty pending set is a meaningful signal — it
   * retires cards a client kept actionable after a missed `approval_resolved`).
   * The read and the publish MUST be synchronous in one event-loop turn (see the
   * wiring in index-nats.ts and APPROVAL_REHYDRATION_PLAN §3.2/§3.4).
   */
  sendApprovalSnapshot: (peerId: string) => void;
  logger?: { error?: (msg: string) => void };
};

/**
 * Run the register-hop admission for one NATS request. Replies via `deps.reply`.
 * See the module docstring for the security model. Idempotent for `register`
 * (re-wrap + re-snapshot on every call), so a client that retries after a lost
 * reply recovers cleanly.
 */
export async function handleRegisterRequest(deps: RegisterHandlerDeps): Promise<void> {
  const { auth, subjectPeerId, payload, reply, popChallenges, logger } = deps;

  let parsed: { op?: unknown; token?: unknown; nonce?: unknown; signature?: unknown };
  try {
    parsed = JSON.parse(payload) as typeof parsed;
  } catch {
    reply(REGISTER_UNAUTHORIZED);
    return;
  }
  const op = typeof parsed.op === "string" ? parsed.op : "";

  if (op !== "challenge" && op !== "register" && op !== "unregister") {
    reply(REGISTER_UNAUTHORIZED);
    return;
  }

  const token = typeof parsed.token === "string" ? parsed.token : "";

  // Unregister: authenticated, fire-and-forget teardown (NO reply). It flows
  // through the SAME verify + subject/JWT-peerId match as register, so an
  // unverified / mismatched / transient-verify token is a silent no-op — no one
  // can tear down a peer they don't own. The victim (if any) simply re-registers.
  if (op === "unregister") {
    if (!token) return;
    let unregIdentity: JwtIdentity | null;
    try {
      unregIdentity = await deps.verifyIdentity(token, auth);
    } catch (err) {
      // Transient or verify error → do NOT act on an unverified peerId.
      logger?.error?.(`webchannel: unregister verify error (ignored): ${String(err)}`);
      return;
    }
    if (!unregIdentity) return;
    if (subjectPeerId !== unregIdentity.peerId) {
      logger?.error?.(
        `webchannel: unregister subject peerId "${subjectPeerId}" != JWT peerId "${unregIdentity.peerId}" — ignoring`,
      );
      return;
    }
    deps.unregisterPeer(unregIdentity.peerId);
    return;
  }

  if (!token) {
    reply(REGISTER_UNAUTHORIZED);
    return;
  }

  // Verify against THIS account's auth. The subject namespace already pins the
  // request to this account, and the account's verifier enforces its own issuer
  // + audience, so a token whose aud does not match this account fails here.
  // A TRANSIENT infra fault (JWKS unreachable) is answered with a retryable 503
  // (REGISTER_UNAVAILABLE), distinct from a terminal 401, so a momentary hiccup
  // doesn't permanently kill the session; a genuine verify failure stays 401.
  let identity: JwtIdentity | null;
  try {
    identity = await deps.verifyIdentity(token, auth);
  } catch (err) {
    if (err instanceof TransientVerifyError) {
      logger?.error?.(`webchannel: register verify unavailable (transient): ${String(err)}`);
      reply(REGISTER_UNAVAILABLE);
      return;
    }
    logger?.error?.(`webchannel: register verify error: ${String(err)}`);
    reply(REGISTER_UNAUTHORIZED);
    return;
  }
  if (!identity) {
    reply(REGISTER_UNAUTHORIZED);
    return;
  }
  const peerId = identity.peerId;

  // SECURITY (subject spoofing): identity is the verified JWT `sub`, never the
  // subject peerId. Reject a mismatch.
  if (subjectPeerId !== peerId) {
    logger?.error?.(
      `webchannel: register subject peerId "${subjectPeerId}" != JWT peerId "${peerId}" — rejecting`,
    );
    reply(REGISTER_UNAUTHORIZED);
    return;
  }

  // Defense-in-depth: a loose/compromised issuer could place a `.`/`*`/`>` in
  // `sub` and widen the agent's subscriptions. Reject BEFORE any subject use.
  try {
    assertValidSubjectToken(peerId, "peerId");
  } catch (err) {
    logger?.error?.(`webchannel: ${(err as Error).message}`);
    reply(REGISTER_UNAUTHORIZED);
    return;
  }

  // Challenge: issue a single-use nonce bound to the verified peerId.
  if (op === "challenge") {
    const nonce = popChallenges.issue(peerId);
    reply(JSON.stringify({ nonce }));
    return;
  }

  // op === "register"
  // PoP gate (secure-by-default): PoP is REQUIRED unless auth.requirePoP=false.
  const requirePoP = resolveRequirePoP(auth as { requirePoP?: boolean } | undefined);
  if (popRequirementUnmet(requirePoP, Boolean(identity.popPublicJwk))) {
    logger?.error?.(
      `webchannel: register rejected for ${peerId} — proof-of-possession required (JWT has no pop_jwk)`,
    );
    reply(REGISTER_UNAUTHORIZED);
    return;
  }

  // Proof-of-Possession: prove possession of the device private key by signing
  // the issued nonce. Missing / invalid / expired / REPLAYED → generic reject.
  if (identity.popPublicJwk) {
    const nonce = typeof parsed.nonce === "string" ? parsed.nonce : "";
    const signature = typeof parsed.signature === "string" ? parsed.signature : "";
    if (!nonce || !signature) {
      reply(REGISTER_UNAUTHORIZED);
      return;
    }
    const verdict = popChallenges.verify({
      peerId,
      nonce,
      signatureB64Url: signature,
      popPublicJwk: identity.popPublicJwk,
    });
    if (!verdict.ok) {
      logger?.error?.(`webchannel: PoP verification failed for ${peerId} (${verdict.reason})`);
      reply(REGISTER_UNAUTHORIZED);
      return;
    }
  }

  // Phase 6: the register reply IS the key-delivery channel — wrap K to the JWT
  // cnf device key. A register token without cnf has no key path, so reject it.
  if (!identity.devicePublicKey) {
    logger?.error?.(
      `webchannel: register rejected for ${peerId} — JWT has no cnf device key (key delivery impossible)`,
    );
    reply(REGISTER_UNAUTHORIZED);
    return;
  }
  const devicePublicKey = new Uint8Array(Buffer.from(identity.devicePublicKey, "base64url"));
  if (devicePublicKey.length !== 32) {
    reply(REGISTER_UNAUTHORIZED);
    return;
  }

  // Register (idempotent) + wrap K + snapshot. These do real I/O — registerPeer
  // loads/creates the peer's stable K (ConversationKeyStore.persist → fs writes
  // that can EACCES/ENOSPC), wrap does crypto, snapshot reads history — so any
  // throw here MUST reply REGISTER_FAILED, not escape. The call site wires this as
  // `void handleRegisterRequest(...)`; an unguarded throw would leave the browser
  // with NO reply (→ client retries then terminal disconnect) AND raise an
  // unhandledRejection. This mirrors the deleted HTTP route's whole-body try/catch.
  try {
    // Register (idempotent) + wrap K to THIS request's attested device key.
    deps.registerPeer(peerId);
    const wrappedConversationKey = deps.wrapConversationKeyForDevice(peerId, devicePublicKey);
    if (!wrappedConversationKey) {
      logger?.error?.(`webchannel: no conversation key established for ${peerId} at register`);
      reply(REGISTER_FAILED);
      return;
    }

    // Stateless register: fire the bounded initial history snapshot every time
    // (first join, reload, reconnect); the client's id-idempotent hydration
    // absorbs duplicates. K is established above, and the client subscribed `.out`
    // before registering, so nothing is lost.
    deps.sendHistorySnapshot(peerId);

    // #15: authoritative pending-approval snapshot, right after history and in
    // the SAME success block (so a throw still replies REGISTER_FAILED). Always
    // sent — an empty set is the reconciliation signal that retires stale cards.
    deps.sendApprovalSnapshot(peerId);

    reply(JSON.stringify({ peerId, registered: true, wrappedConversationKey }));
  } catch (err) {
    logger?.error?.(`webchannel: register failed for ${peerId}: ${String(err)}`);
    reply(REGISTER_FAILED);
  }
}
