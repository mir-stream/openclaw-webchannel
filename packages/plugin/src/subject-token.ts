/**
 * NATS-subject token validator (defense-in-depth against subject injection).
 *
 * Live channel subjects are `webchannel.{tenant}.{accountId}.{peerId}.{in|out|handshake}`.
 * A token containing a `.` (subject separator), `*`/`>` (NATS wildcards), or
 * whitespace/control chars would break the subject hierarchy and could cross
 * tenant boundaries. On the plugin side, `peerId` derives from the verified JWT
 * `sub`; tenant/accountId come from trusted operator config. We still validate the
 * untrusted `peerId` before it is spliced into a subject so a loose/compromised
 * issuer that puts a wildcard in `sub` cannot widen the agent's subscriptions.
 *
 * Allowed: ASCII letters, digits, `-` and `_`. Everything else (including `.`,
 * `*`, `>`, spaces, control chars, and the empty string) is rejected.
 *
 * Kept byte-identical to `packages/saas/src/subject-token.ts` on purpose — both
 * sides of the wire enforce the same admissible token set.
 */

/** Strict safe-token charset: alphanumeric plus `-` and `_`, capped at 128 chars. */
const SAFE_SUBJECT_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Non-throwing predicate: `true` iff `token` is a single, safe NATS subject token
 * (non-empty, no `.`/`*`/`>`/whitespace/control chars). Use at call sites that
 * make a control-flow decision (e.g. drop vs publish) rather than fail hard.
 */
export function isValidSubjectToken(token: unknown): token is string {
  return typeof token === "string" && SAFE_SUBJECT_TOKEN.test(token);
}

/**
 * Throw if `token` is unsafe to interpolate into a NATS subject / permission.
 *
 * @param token - The untrusted token (e.g. peerId).
 * @param label - Human-readable field name for the error message.
 * @throws {Error} when the token is empty or contains a disallowed character.
 */
export function assertValidSubjectToken(token: string, label: string): void {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`webchannel: ${label} must be a non-empty string`);
  }
  if (!SAFE_SUBJECT_TOKEN.test(token)) {
    throw new Error(
      `webchannel: ${label} contains characters not allowed in a NATS subject token ` +
        `(allowed: A-Za-z0-9_-; rejected ".", "*", ">", whitespace, control chars)`,
    );
  }
}
