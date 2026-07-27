/**
 * `clientNonce` — the BROWSER-CHOSEN freshness anchor for the register-hop
 * key wrap (protocol v3).
 *
 * WHY CLIENT-CHOSEN. The wrapped conversation key delivered in the register
 * reply is AUTHENTICATED (static-static ECDH under the SaaS-pinned agent
 * identity key) but, before v3, not FRESH: a hostile relay could capture a
 * register reply and replay it verbatim. That is harmless only while K never
 * rotates — the moment K rotation exists, the replayed wrap becomes a full
 * session hijack. v3 binds a per-attempt, browser-generated random value into
 * the wrap AAD so a captured wrap is useless against the next attempt.
 *
 * A SERVER-issued PoP nonce cannot serve as this anchor. The challenge reply is
 * unauthenticated plaintext and the browser only presence-checks it, so a relay
 * can answer the challenge itself and replay a MATCHED `(old nonce, old wrap)`
 * pair without the agent ever participating. `PopChallengeStore.consume()`
 * protects the AGENT from replay, not the browser. Only a value the browser
 * generates locally is one the relay cannot choose.
 *
 * FORMAT. base64url of ≥16 random bytes. The charset is deliberately the
 * base64url alphabet only: it excludes the `0x1F` UNIT SEPARATOR used to delimit
 * the AAD fields (see `wrapAad` in late-join-decryptor.ts), so the AAD encoding
 * stays unambiguous without any escaping.
 */

/**
 * Minimum accepted length in characters. 16 random bytes encode to 22 unpadded
 * base64url characters, so 22 is the floor for the ≥16-byte entropy requirement.
 */
export const CLIENT_NONCE_MIN_LENGTH = 22;

/** Upper bound — bounds the AAD and the parsed request; far above any real nonce. */
export const CLIENT_NONCE_MAX_LENGTH = 128;

/**
 * Unpadded base64url charset ONLY. `=` padding is rejected (the browser encodes
 * unpadded), and every character outside this set — notably `0x1F` — is rejected,
 * which is what makes the `wrapAad` delimiter unambiguous.
 */
const CLIENT_NONCE_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${CLIENT_NONCE_MIN_LENGTH},${CLIENT_NONCE_MAX_LENGTH}}$`,
);

/**
 * `true` iff `value` is a well-formed client freshness nonce. Non-throwing: the
 * register handler turns a `false` into the same opaque 401 every other
 * validation failure produces (the reply is never an oracle).
 */
export function isValidClientNonce(value: unknown): value is string {
  return typeof value === "string" && CLIENT_NONCE_PATTERN.test(value);
}
