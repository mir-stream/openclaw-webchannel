/** Account-id validation shared by config paths and storage identity parsing. */

/** Strict path-safe account-id shape at persistence boundaries. */
const STRICT_ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Object keys that must never be used as account ids (prototype pollution). */
const BLOCKED_ACCOUNT_IDS = new Set(["__proto__", "prototype", "constructor"]);

export function isBlockedAccountId(id: string): boolean {
  return BLOCKED_ACCOUNT_IDS.has(id.toLowerCase());
}

/** True when `id` is a safe account id for use as a filesystem path component. */
export function isValidAccountId(id: string): boolean {
  return (
    typeof id === "string" &&
    STRICT_ACCOUNT_ID_RE.test(id) &&
    !isBlockedAccountId(id)
  );
}

/**
 * Assert that an account id is safe to use in a filesystem path.
 *
 * The value is reported only as JSON-escaped operator configuration; persisted
 * credential contents never flow through this error.
 */
export function assertValidAccountId(id: string): void {
  if (!isValidAccountId(id)) {
    throw new Error(
      `webchannel: invalid account id ${JSON.stringify(id)} — must match ` +
        `/^[A-Za-z0-9_-]{1,64}$/ (refusing to build a credential path).`,
    );
  }
}
