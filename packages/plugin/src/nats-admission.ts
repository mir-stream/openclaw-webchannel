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
 *   - devOpen + hmac/anon harness                → auto (wildcard auto-register).
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
