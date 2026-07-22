/**
 * NATS-subject token validator (defense against subject-hierarchy injection).
 *
 * Live channel subjects are `webchannel.{tenant}.{accountId}.{peerId}.{in|out|register|reginbox}`.
 * A token containing a `.` (subject separator), `*`/`>` (NATS wildcards), or
 * whitespace/control chars would break the subject hierarchy and could cross
 * tenant boundaries (e.g. a `tenant` of `a.*` would widen a `webchannel.{tenant}.>`
 * grant to every tenant). We therefore restrict every interpolated token to a
 * strict, conservative alphanumeric set BEFORE it is ever spliced into a subject
 * or a NATS permission grant.
 *
 * Allowed: ASCII letters, digits, `-` and `_`. Everything else (including `.`,
 * `*`, `>`, spaces, control chars, and the empty string) is rejected.
 */

/** Strict safe-token charset: alphanumeric plus `-` and `_`, capped at 128 chars. */
const SAFE_SUBJECT_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Throw if `token` is unsafe to interpolate into a NATS subject / permission.
 *
 * @param token - The untrusted token (e.g. tenant, accountId).
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
