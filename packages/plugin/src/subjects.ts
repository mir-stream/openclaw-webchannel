/**
 * Canonical NATS subject builders (agent/plugin side) — P0-3 S3 anti-drift.
 *
 * The webchannel subject hierarchy is `webchannel.{tenant}.{accountId}.{peerId}.{leaf}`.
 * Before P0-3 these strings were inlined at every call site in `nats-channel.ts`
 * (register wildcard, inbound, outbound, reginbox prefix, preflight), so the
 * subject-coverage / permission-template parity tests could drift from the real
 * runtime subjects while still agreeing with a hand-copied string. Extracting the
 * one true builder here lets the template-coverage test consume the SAME function
 * the runtime does, so a subject change that escapes the template grant breaks the
 * test (that is the whole point).
 *
 * The client package has its OWN copy of the browser-facing builders
 * (`packages/client/src/nats-client.ts`) — it is zero-dependency by design and
 * cannot import this module; a client-side coverage test pins the client's copy
 * against the same shared fixture (see `contracts/nats-permissions.v1.json`).
 */

/** Root token of the whole webchannel subject tree. */
export const WEBCHANNEL_SUBJECT_ROOT = "webchannel";

/** `webchannel.{tenant}.{accountId}` — the per-account subtree root. */
export function accountRoot(tenant: string, accountId: string): string {
  return `${WEBCHANNEL_SUBJECT_ROOT}.${tenant}.${accountId}`;
}

/** Inbound (browser → agent): `webchannel.{tenant}.{accountId}.{peerId}.in`. */
export function inboundSubject(tenant: string, accountId: string, peerId: string): string {
  return `${accountRoot(tenant, accountId)}.${peerId}.in`;
}

/** Outbound (agent → browser): `webchannel.{tenant}.{accountId}.{peerId}.out`. */
export function outboundSubject(tenant: string, accountId: string, peerId: string): string {
  return `${accountRoot(tenant, accountId)}.${peerId}.out`;
}

/** A single peer's register subject: `webchannel.{tenant}.{accountId}.{peerId}.register`. */
export function registerSubject(tenant: string, accountId: string, peerId: string): string {
  return `${accountRoot(tenant, accountId)}.${peerId}.register`;
}

/**
 * The agent's register-admission wildcard: `webchannel.{tenant}.{accountId}.*.register`
 * (the `*` matches any peerId). The agent subscribes this so any peer can drive
 * the JWT + PoP register round-trip; identity still comes only from the verified JWT.
 */
export function registerWildcard(tenant: string, accountId: string): string {
  return `${accountRoot(tenant, accountId)}.*.register`;
}

/**
 * A peer's reginbox reply-prefix (WITH trailing dot):
 * `webchannel.{tenant}.{accountId}.{peerId}.reginbox.`
 *
 * The register-reply allowlist checks `replyTo.startsWith(prefix)` and validates
 * the single token after it, so the trailing dot is load-bearing — a reply-to
 * must be `…reginbox.{token}`, never the bare `…reginbox`.
 */
export function reginboxPrefix(tenant: string, accountId: string, peerId: string): string {
  return `${accountRoot(tenant, accountId)}.${peerId}.reginbox.`;
}

/**
 * The account's preflight probe subject: `webchannel.{tenant}.{accountId}._preflight`.
 * Used by the add-time Gate A relay-dial / permission probe (P1 sub + P2 pub).
 */
export function preflightSubject(tenant: string, accountId: string): string {
  return `${accountRoot(tenant, accountId)}._preflight`;
}
