/**
 * NATS peer admission — Axis B of the agent↔NATS decoupling.
 *
 * ── Separation of concerns ─────────────────────────────────────────────────
 * "How the agent authenticates to NATS" (Axis A — `nats-credential-source.ts`)
 * is orthogonal to "WHICH browser peers the agent serves" (Axis B — here). The
 * legacy code fused the two: the agent only auto-subscribed to inbound/handshake
 * subjects when running in `devOpen` mode, so a real external NATS (static creds,
 * not devOpen, no SaaS issuer) could NEVER receive a browser — wildcard was OFF
 * and there was no register hop either. This module makes admission an explicit,
 * first-class decision independent of the credential source.
 *
 * Crucially, Axis B is IGNORANT of Axis A's vocabulary: it never sees a
 * credential-mode string. The single thing it needs to know about the credential
 * source is a derived CAPABILITY — `registerHopAvailable` — meaning "is an
 * issuer-backed register hop viable at all". Axis A's caller derives that boolean;
 * Axis B only reasons about admission.
 *
 * Two admission modes:
 *
 *   - `register-hop` — a peer must complete the SaaS bootstrap JWT + Proof-of-
 *     Possession round-trip at `/webchannel/nats/register*` before the agent
 *     subscribes to its subjects. This is the production default for `jwt` auth
 *     when a register hop is available.
 *
 *   - `auto` — the agent subscribes to the tenant/agent WILDCARD subjects and
 *     serves ANY peer that completes the X25519 handshake AND passes the
 *     `dmSecurity` allowlist. Security here rests on NATS subject permissions +
 *     the allowlist gate + E2E encryption — NOT on a SaaS issuer. This is what a
 *     bring-your-own-NATS deployment needs, and it must be available WITHOUT devOpen.
 *
 * Decision (env/config override wins, then strategy/capability defaults):
 *   1. explicit `nats.admission` override                  → use it verbatim.
 *   2. `auth.strategy === "jwt"` AND a register hop is viable → `register-hop`.
 *   3. otherwise                                           → `auto`.
 *
 * This preserves every existing flow exactly (with `registerHopAvailable` derived
 * by the caller as "the credential source is NOT bring-your-own static creds"):
 *   - enrolled production (jwt, hop available)   → register-hop (unchanged).
 *   - devOpen + jwt harness (hop available)      → register-hop (HTTP hop is sole path).
 *   - devOpen + anon / no-strategy harness       → auto (wildcard auto-register).
 * and ADDS the new capability: static creds (no hop) + any strategy → auto.
 */

export type AdmissionMode = "auto" | "register-hop";

export type ResolveAdmissionModeInput = {
  /** `channels.webchannel.auth.strategy`. */
  authStrategy?: string;
  /**
   * Whether an issuer-backed register hop is viable for this deployment — a
   * derived CAPABILITY, not a credential-mode name. The caller computes it from
   * Axis A (e.g. `credentialMode !== "static"`), keeping Axis B ignorant of Axis
   * A's vocabulary. When `false`, there is no issuer/register hop to drive, so
   * the wildcard auto-register path (handshake + allowlist guarded) is the only
   * way to serve peers.
   */
  registerHopAvailable: boolean;
  /** Explicit `channels.webchannel.nats.admission` override. */
  explicitOverride?: AdmissionMode;
};

/**
 * Decide the peer-admission mode. See the module docstring for the full rule and
 * its rationale. `auto` means the agent should call `subscribeWildcard()`.
 */
export function resolveAdmissionMode(input: ResolveAdmissionModeInput): AdmissionMode {
  if (input.explicitOverride === "auto" || input.explicitOverride === "register-hop") {
    return input.explicitOverride;
  }
  // The HTTP register hop is the real admission gate, but only when an issuer-
  // backed hop is actually viable. Otherwise the wildcard auto-register path
  // (handshake + dmSecurity allowlist) is the only way to serve peers.
  return input.authStrategy === "jwt" && input.registerHopAvailable
    ? "register-hop"
    : "auto";
}

/**
 * What the per-account serving loop must wire up for a resolved admission mode.
 *
 * This makes the ONE structural fact behind the admission decision testable and
 * explicit: the `channels.webchannel.auth` verifier and the HTTP register hop's
 * `aud → account` dispatch entry are meaningful ONLY for a `register-hop`
 * account. An `auto` account admits peers purely via the NATS wildcard + the
 * X25519 handshake (+ optional `dmSecurity` allowlist), so `auth` gates nothing
 * on its path — it must be served with NO verifier built and NO aud mapping,
 * never skipped for "missing auth".
 *
 *   - `register-hop` → { subscribeWildcard: false, buildVerifier: true,  populateAudMapping: true  }
 *   - `auto`         → { subscribeWildcard: true,  buildVerifier: false, populateAudMapping: false }
 */
export type AdmissionServingPlan = {
  /** `auto` subscribes the tenant/accountId wildcard; `register-hop` does not. */
  subscribeWildcard: boolean;
  /**
   * Build (and require) the `channels.webchannel.auth` `ConnectionVerifier`.
   * True ONLY for `register-hop`, so a pure-`auto` account is served with no
   * `auth` config at all, and a misconfigured jwt account still fails loudly on
   * the register-hop path (its verifier throw skips it) rather than being
   * silently downgraded to `auto`.
   */
  buildVerifier: boolean;
  /** Populate the register route's `aud → account` dispatch map. `register-hop` only. */
  populateAudMapping: boolean;
};

/** Derive the serving plan for an admission mode. See {@link AdmissionServingPlan}. */
export function admissionServingPlan(admission: AdmissionMode): AdmissionServingPlan {
  const registerHop = admission === "register-hop";
  return {
    subscribeWildcard: !registerHop,
    buildVerifier: registerHop,
    populateAudMapping: registerHop,
  };
}

/**
 * Phase 6 guard: cross-user history leak via openclaw's default DM session scope.
 *
 * A `register-hop` account serves MANY users (one peerId per user), but openclaw's
 * `session.dmScope` defaults to `"main"` — every direct peer resolves to the SAME
 * agent session. The register-time history snapshot (and `load_history`) reads
 * `route.sessionKey`, so under `"main"` it returns the SHARED transcript and the
 * agent re-seals OTHER USERS' messages to each requester's own conversation key.
 * Per-peer E2E encryption cannot protect against this: the leak happens before
 * sealing, at session scoping. openclaw's own channel audit flags the same
 * misconfig.
 *
 * Returns the operator warning to log, or `null` when the account is safe
 * (auto admission has no snapshot/history path gated here, and any non-"main"
 * scope isolates DM sessions per sender).
 */
export function crossUserHistoryWarning(input: {
  admission: AdmissionMode;
  accountId: string;
  /** `session.dmScope` from the openclaw config (undefined = openclaw default "main"). */
  dmScope?: string;
}): string | null {
  if (input.admission !== "register-hop") return null;
  const dmScope = input.dmScope ?? "main";
  if (dmScope !== "main") return null;
  return (
    `webchannel: account "${input.accountId}" uses register admission (multi-user) but ` +
    `session.dmScope is "main" — ALL peers share ONE agent session, so the history ` +
    `snapshot and load_history return OTHER USERS' messages re-sealed to each requester ` +
    `(cross-user transcript leak; E2E encryption cannot prevent it). ` +
    `Run: openclaw config set session.dmScope "per-channel-peer"`
  );
}
