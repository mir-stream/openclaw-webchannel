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
 *    so no one can tear down a peer they don't own. Since #51 it ALSO requires
 *    the same single-use PoP proof as `register`, so a relay that captured the
 *    plaintext frame cannot replay the teardown — and the proof is bound to the
 *    OP (pop-signed-message.ts), so a proof minted for `register` is not a valid
 *    teardown either.
 *    CAVEAT — this holds only where PoP holds at all. Under the operator opt-out
 *    (`auth.requirePoP: false`) with a JWT carrying no `pop_jwk`, unregister
 *    stays token-only and therefore replayable off the relay for the JWT's
 *    lifetime. That is deliberate and matches `register` exactly (the same gate,
 *    `popRequirementUnmet`, decides both): an operator who disabled PoP has
 *    disabled it for the whole register hop, not for registration alone.
 *  - The register reply's wrapped conversation key is bound to a BROWSER-chosen,
 *    per-attempt `clientNonce` (protocol v3). Authentication alone left the reply
 *    replayable verbatim; the anchor makes a captured reply useless against any
 *    later attempt. It must be client-chosen — the challenge reply is
 *    unauthenticated plaintext, so a relay could answer a server-issued challenge
 *    itself and replay a MATCHED (old nonce, old wrap) pair. See client-nonce.ts.
 *  - Verification failures are a single opaque `unauthorized` (401), so the
 *    reply channel is not an identity oracle; replay of a used single-use nonce
 *    collapses to the same rejection. A TRANSIENT infra fault (JWKS source
 *    unreachable) replies retryable `unavailable` (503). Only after JWT,
 *    tenant/subject, PoP, and cnf validation can the handler reveal the
 *    account-wide, peer-independent `capacity_exceeded` (507) outcome. It
 *    carries no account, peer, or count detail.
 *  - Moving the register hop onto NATS exposes the bootstrap JWT to the untrusted
 *    relay (the HTTP path carried it in a TLS Authorization header). The
 *    mitigation is unchanged: PoP (device key) + single-use, short-TTL nonce +
 *    short JWT TTL, so a captured bootstrap JWT alone cannot register.
 */

import { Buffer } from "node:buffer";

import { TransientVerifyError } from "./auth.js";
import type { JwtIdentity } from "./jwt.js";
import type { PopChallengeStore } from "./pop-challenge.js";
import type { WrappedConversationKey } from "./late-join-decryptor.js";
import {
  formatCapacityReject,
  type CapacityStatus,
} from "./capacity-status.js";
import { popRequirementUnmet } from "./register-pop-gate.js";
import { isValidClientNonce } from "./client-nonce.js";
import { assertValidSubjectToken } from "./subject-token.js";
import { WEBCHANNEL_PROTOCOL_VERSION, readPluginVersion } from "./protocol.js";
import { logSafe } from "./log-safe.js";

/**
 * Generic register-reply payloads. ANY verification failure collapses to
 * `unauthorized` (no detail — the reply is never an oracle); an internal fault
 * (no conversation key established) replies a distinct, still-detail-free
 * `registration_failed`.
 */
export const REGISTER_UNAUTHORIZED = JSON.stringify({ error: "unauthorized", code: 401 });
export const REGISTER_FAILED = JSON.stringify({ error: "registration_failed", code: 500 });
export const REGISTER_CAPACITY_EXCEEDED = JSON.stringify({
  error: "capacity_exceeded",
  code: 507,
});
/**
 * Transient/infra failure (the JWKS source was unreachable, so verification could
 * not be performed). Distinct, RETRYABLE code — the client retries it with backoff
 * like a lost reply, instead of treating it as a terminal 401. Not an oracle: it
 * reveals nothing about a specific token (a transient failure and a genuine reject
 * are both non-admit); only the retry disposition differs.
 */
export const REGISTER_UNAVAILABLE = JSON.stringify({ error: "unavailable", code: 503 });
export const REGISTER_PROTOCOL_MISMATCH = JSON.stringify({
  error: "protocol_mismatch",
  code: 426,
  protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
});

export type RegisterHandlerDeps = {
  /** Agent-owned tenant namespace; primary confinement remains structural in NATS. */
  tenant: string;
  /** peerId segment of the `.register` subject — routing ONLY, never trusted. */
  subjectPeerId: string;
  /** Raw request payload (plaintext JSON; the browser has no session key yet). */
  payload: string;
  /** Publish the response to the request's NATS reply-to inbox. */
  reply: (response: string) => void;
  /** Token-only verifier already bound to this runtime account id. */
  verifyIdentity: (jwt: string) => Promise<JwtIdentity | null>;
  /** Strictly resolved during account preparation; never inferred by truthiness here. */
  requirePoP: boolean;
  /** Single-use PoP nonce store (issue on challenge, verify on register). */
  popChallenges: PopChallengeStore;
  /** Register the peer in this account's channel (loads/creates its stable K). */
  registerPeer: (peerId: string) => void;
  /**
   * Wrap this account's conversation key K to the request's cnf device key,
   * binding the request's browser-chosen `clientNonce` into the wrap AAD (v3
   * freshness anchor — see client-nonce.ts).
   */
  wrapConversationKeyForDevice: (
    peerId: string,
    devicePublicKey: Uint8Array,
    clientNonce: string,
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
   * Fire the authoritative approval snapshot for a just-registered peer (#15/#19).
   * Injected because it reads the plugin's pending + recently-resolved approval
   * stores and publishes on the account's channel; kept out of this pure handler.
   * Called on EVERY successful register (an empty pending set is a meaningful
   * signal — it retires cards a client kept actionable after a missed
   * `approval_resolved`; the resolved set (#19) lets the client show the actual
   * decision rather than a neutral "resolved elsewhere"). The reads and the
   * publish MUST be synchronous in one event-loop turn (see the wiring in
   * index-nats.ts and APPROVAL_REHYDRATION_PLAN §3.2/§3.4).
   */
  sendApprovalSnapshot: (peerId: string) => void;
  /** Capacity-only diagnostics; never wrap or replace the general security logger. */
  onCapacityReject?: (status: CapacityStatus) => void;
  logger?: { error?: (msg: string) => void };
};

type CapacityErrorShape = CapacityStatus & {
  name: "ConversationKeyCapacityError";
};

function isConversationKeyCapacityError(err: unknown): err is CapacityErrorShape {
  if (!err || typeof err !== "object") return false;
  const value = err as Record<string, unknown>;
  return (
    value.name === "ConversationKeyCapacityError" &&
    typeof value.accountId === "string" &&
    value.accountId.length > 0 &&
    Number.isSafeInteger(value.currentKeys) &&
    (value.currentKeys as number) >= 0 &&
    Number.isSafeInteger(value.maxKeys) &&
    (value.maxKeys as number) > 0
  );
}

function hasCapacityErrorName(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ConversationKeyCapacityError"
  );
}

function consoleCapacityFallback(status: CapacityStatus): void {
  try {
    console.error(formatCapacityReject(status));
  } catch {
    // Diagnostics are never load-bearing for an already-sent reply.
  }
}

function identityMatchesTenantScope(identity: JwtIdentity, tenant: string): boolean {
  return typeof identity.tenant === "string" && identity.tenant.length > 0 && identity.tenant === tenant;
}

/**
 * Run the register-hop admission for one NATS request. Replies via `deps.reply`.
 * See the module docstring for the security model. Idempotent for `register`
 * (re-wrap + re-snapshot on every call), so a client that retries after a lost
 * reply recovers cleanly.
 */
export async function handleRegisterRequest(deps: RegisterHandlerDeps): Promise<void> {
  const { subjectPeerId, payload, reply, popChallenges, logger } = deps;

  let parsed: {
    op?: unknown;
    token?: unknown;
    nonce?: unknown;
    signature?: unknown;
    protocolVersion?: unknown;
    /**
     * v3 freshness anchor, generated by the BROWSER per register attempt. Read
     * from the function-scoped `parsed` — deliberately NOT nested under the PoP
     * branch, because the anchor must bind the wrap whether or not PoP is in
     * play.
     */
    clientNonce?: unknown;
  };
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
  // through the SAME verify + tenant/subject/JWT-peerId checks as register, so
  // an unverified / mismatched / transient-verify token is a silent no-op — no
  // one can tear down a peer they don't own. The victim (if any) simply
  // re-registers.
  //
  // ISSUE #51 — unregister ALSO requires proof-of-possession. JWT + tenant +
  // subject match alone made it REPLAYABLE: the bootstrap JWT crosses the
  // untrusted relay in plaintext, so a relay-positioned observer could capture
  // `{op:"unregister", token}` and re-send it until the JWT expired, tearing down
  // the victim's subscription and session key each time with no signal to the
  // victim. Requiring the same single-use PoP challenge/response as `register`
  // makes each teardown usable exactly once (`popChallenges.verify` consumes the
  // nonce), so a captured frame is inert on replay.
  //
  // EVERY failure below stays a SILENT no-op with NO reply — unregister must
  // never become an oracle, and it must stay fire-and-forget.
  if (op === "unregister") {
    if (!token) return;
    let unregIdentity: JwtIdentity | null;
    try {
      unregIdentity = await deps.verifyIdentity(token);
    } catch (err) {
      // Transient or verify error → do NOT act on an unverified peerId.
      logger?.error?.(`webchannel: unregister verify error (ignored): ${logSafe(err)}`);
      return;
    }
    if (!unregIdentity) return;
    if (!identityMatchesTenantScope(unregIdentity, deps.tenant)) {
      logger?.error?.(
        "webchannel: unregister JWT tenant does not match configured tenant — ignoring",
      );
      return;
    }
    if (subjectPeerId !== unregIdentity.peerId) {
      logger?.error?.(
        `webchannel: unregister subject peerId ${logSafe(subjectPeerId)} != JWT peerId ${logSafe(unregIdentity.peerId)} — ignoring`,
      );
      return;
    }

    // Same defense-in-depth check register runs before touching a peerId — the
    // unregister branch returns before reaching register's copy, so it needs its
    // own. Without it a `:`-bearing peerId from a loose issuer would reach
    // `popChallenges.verify` below, which is the one place the signed-message
    // encoding assumes a colon-free peerId (pop-signed-message.ts). The encoding
    // is unambiguous regardless — see the note there — but the check keeps that
    // argument simple, and a peerId that cannot be a subject token has no
    // business reaching a teardown either. Silent no-op, like every other
    // rejection on this path.
    try {
      assertValidSubjectToken(unregIdentity.peerId, "peerId");
    } catch (err) {
      logger?.error?.(`webchannel: unregister ${logSafe((err as Error).message)}`);
      return;
    }

    // #51 PoP gate — gated on `requirePoP` exactly like register, so an operator
    // who opted out of PoP entirely keeps the previous (token-only) behaviour on
    // BOTH ops rather than getting a teardown path that can never succeed.
    if (popRequirementUnmet(deps.requirePoP, Boolean(unregIdentity.popPublicJwk))) {
      logger?.error?.(
        `webchannel: unregister ignored for ${logSafe(unregIdentity.peerId)} — proof-of-possession required (JWT has no pop_jwk)`,
      );
      return;
    }
    if (unregIdentity.popPublicJwk) {
      const unregNonce = typeof parsed.nonce === "string" ? parsed.nonce : "";
      const unregSignature = typeof parsed.signature === "string" ? parsed.signature : "";
      if (!unregNonce || !unregSignature) return;
      const unregVerdict = popChallenges.verify({
        // The op is part of the SIGNED message. Both ops share this per-peer
        // nonce bucket, so without this a proof the browser minted for `register`
        // would authorize a teardown — and a relay can obtain one for free by
        // SUPPRESSING the register frame (which looks exactly like the lost frame
        // the client's retry loop absorbs) and relabelling the triple.
        op: "unregister",
        peerId: unregIdentity.peerId,
        nonce: unregNonce,
        signatureB64Url: unregSignature,
        popPublicJwk: unregIdentity.popPublicJwk,
      });
      if (!unregVerdict.ok) {
        // A REPLAYED unregister lands here: the first use consumed the nonce, so
        // the second lookup is "nonce-missing" and the teardown never runs. A
        // register-minted proof lands here too, as "signature-mismatch".
        logger?.error?.(
          `webchannel: unregister PoP verification failed for ${logSafe(unregIdentity.peerId)} (${logSafe(unregVerdict.reason)})`,
        );
        return;
      }
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
    identity = await deps.verifyIdentity(token);
  } catch (err) {
    if (err instanceof TransientVerifyError) {
      logger?.error?.(`webchannel: register verify unavailable (transient): ${logSafe(err)}`);
      reply(REGISTER_UNAVAILABLE);
      return;
    }
    logger?.error?.(`webchannel: register verify error: ${logSafe(err)}`);
    reply(REGISTER_UNAUTHORIZED);
    return;
  }
  if (!identity) {
    reply(REGISTER_UNAUTHORIZED);
    return;
  }
  const peerId = identity.peerId;

  // Defense-in-depth: primary tenant binding is structural (the configured NATS
  // namespace and scoped credentials). The mandatory signed claim must agree.
  if (!identityMatchesTenantScope(identity, deps.tenant)) {
    logger?.error?.("webchannel: register JWT tenant does not match configured tenant — rejecting");
    reply(REGISTER_UNAUTHORIZED);
    return;
  }

  // SECURITY (subject spoofing): identity is the verified JWT `sub`, never the
  // subject peerId. Reject a mismatch.
  if (subjectPeerId !== peerId) {
    logger?.error?.(
      `webchannel: register subject peerId ${logSafe(subjectPeerId)} != JWT peerId ${logSafe(peerId)} — rejecting`,
    );
    reply(REGISTER_UNAUTHORIZED);
    return;
  }

  // Defense-in-depth: a loose/compromised issuer could place a `.`/`*`/`>` in
  // `sub` and widen the agent's subscriptions. Reject BEFORE any subject use.
  try {
    assertValidSubjectToken(peerId, "peerId");
  } catch (err) {
    logger?.error?.(`webchannel: ${logSafe((err as Error).message)}`);
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
  // Version validation deliberately follows authenticated tenant/subject checks:
  // unauthenticated requests must not gain an account/version oracle. It occurs
  // before PoP/key establishment and peer registration, so a v1 client can never
  // establish a v2 session that ignores terminal overflow results.
  if (
    typeof parsed.protocolVersion !== "number"
    || !Number.isSafeInteger(parsed.protocolVersion)
    || parsed.protocolVersion !== WEBCHANNEL_PROTOCOL_VERSION
  ) {
    reply(REGISTER_PROTOCOL_MISMATCH);
    return;
  }

  // v3 freshness anchor. Validation deliberately lands AFTER the protocolVersion
  // check and BEFORE PoP/key establishment.
  //
  // ORDERING IS LOAD-BEARING. A v2 browser sends no `clientNonce`. If this check
  // ran first it would answer 401 → the client raises `PopRejectedError` → the
  // embedder classifies it `auth-rejected` and routes to a re-login flow, which
  // mints fresh credentials and fails identically: an INFINITE re-login loop.
  // Behind the version check, that same browser gets a clean terminal 426 telling
  // it to upgrade.
  if (!isValidClientNonce(parsed.clientNonce)) {
    logger?.error?.(
      `webchannel: register rejected for ${logSafe(peerId)} — missing or malformed clientNonce`,
    );
    reply(REGISTER_UNAUTHORIZED);
    return;
  }
  const clientNonce = parsed.clientNonce;

  // PoP gate (secure-by-default): PoP is REQUIRED unless auth.requirePoP=false.
  if (popRequirementUnmet(deps.requirePoP, Boolean(identity.popPublicJwk))) {
    logger?.error?.(
      `webchannel: register rejected for ${logSafe(peerId)} — proof-of-possession required (JWT has no pop_jwk)`,
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
      // Bound into the signed message: an `unregister` proof must not register.
      op: "register",
      peerId,
      nonce,
      signatureB64Url: signature,
      popPublicJwk: identity.popPublicJwk,
    });
    if (!verdict.ok) {
      logger?.error?.(
        `webchannel: PoP verification failed for ${logSafe(peerId)} (${logSafe(verdict.reason)})`,
      );
      reply(REGISTER_UNAUTHORIZED);
      return;
    }
  }

  // Phase 6: the register reply IS the key-delivery channel — wrap K to the JWT
  // cnf device key. A register token without cnf has no key path, so reject it.
  if (!identity.devicePublicKey) {
    logger?.error?.(
      `webchannel: register rejected for ${logSafe(peerId)} — JWT has no cnf device key (key delivery impossible)`,
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
  // throw here MUST produce a guarded reply (REGISTER_CAPACITY_EXCEEDED for the
  // typed capacity boundary, otherwise REGISTER_FAILED), not escape. The call
  // site wires this as `void handleRegisterRequest(...)`; an unguarded throw
  // would leave the browser with NO reply (→ client retries then terminal
  // disconnect) AND raise an unhandledRejection. This mirrors the deleted HTTP
  // route's whole-body try/catch.
  try {
    // Register (idempotent) + wrap K to THIS request's attested device key.
    deps.registerPeer(peerId);
    // The wrap AAD binds BOTH the verified peerId and THIS request's
    // browser-chosen clientNonce, so the reply is authenticated AND fresh.
    const wrappedConversationKey = deps.wrapConversationKeyForDevice(
      peerId,
      devicePublicKey,
      clientNonce,
    );
    if (!wrappedConversationKey) {
      logger?.error?.(
        `webchannel: no conversation key established for ${logSafe(peerId)} at register`,
      );
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

    // Wire-protocol handshake: echo the mandatory protocol version plus the
    // optional package version so the client can enforce lockstep and the admin
    // screen can report the agent-plugin build.
    //
    // PLAINTEXT BY DESIGN: these fields ride the unencrypted register reply over
    // the untrusted relay. A hostile relay can already forge/suppress this reply
    // (it can forge a mismatch to force the client terminal — a DoS it already
    // holds via forged 401s / dropped replies — or strip a real one), and it can
    // READ pluginVersion (an agent build fingerprint). That is acceptable: these
    // are DIAGNOSTICS, never authenticated. Real security rests entirely on the
    // pinned-agent-identity-key unwrap of the wrapped conversation key above; the
    // version fields gate nothing on the trust path.
    //
    // DO NOT ECHO `clientNonce` HERE. The anchor's whole value is that the
    // browser generated it locally and compares against ITS OWN copy. The moment
    // it also appears in the reply, someone will "conveniently" read it back off
    // the wire — and then the relay chooses the anchor and the replay defence is
    // gone. There is nothing for the browser to learn from an echo.
    reply(
      JSON.stringify({
        peerId,
        registered: true,
        wrappedConversationKey,
        protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
        pluginVersion: readPluginVersion() ?? undefined,
      }),
    );
  } catch (err) {
    if (isConversationKeyCapacityError(err)) {
      const status: CapacityStatus = {
        accountId: err.accountId,
        currentKeys: err.currentKeys,
        maxKeys: err.maxKeys,
      };

      // Wire outcome first: no logger/callback failure may turn a permanent 507
      // into a timeout that the browser treats as transient and reconnects.
      reply(REGISTER_CAPACITY_EXCEEDED);
      try {
        if (deps.onCapacityReject) {
          try {
            deps.onCapacityReject(status);
          } catch {
            // A configured capacity callback owns this branch; do not duplicate
            // into the general security logger if it fails.
            consoleCapacityFallback(status);
          }
        } else if (logger?.error) {
          try {
            logger.error(formatCapacityReject(status));
          } catch {
            consoleCapacityFallback(status);
          }
        } else {
          consoleCapacityFallback(status);
        }
      } catch {
        // Defense-in-depth: diagnostics must never reject the handler after 507.
      }
      return;
    }

    if (hasCapacityErrorName(err)) {
      // A same-name object with an invalid shape is an internal contract bug,
      // not a trusted capacity signal. Avoid combining its dynamic fields with
      // the authenticated peer id in logs.
      reply(REGISTER_FAILED);
      try {
        logger?.error?.("webchannel: malformed conversation-key capacity error; registration failed");
      } catch {
        // Reply already sent; diagnostic failure is non-fatal.
      }
      return;
    }

    logger?.error?.(
      `webchannel: register failed for ${logSafe(peerId)}: ${logSafe(err)}`,
    );
    reply(REGISTER_FAILED);
  }
}
