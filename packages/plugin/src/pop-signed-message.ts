/**
 * The exact byte string a device signs to prove possession of its PoP key.
 *
 * Standalone and dependency-free (no `node:` imports) for the same reason as
 * `wrap-aad.ts`: the browser declares its own byte-identical copy in
 * `packages/client/src/pop-register.ts`, and `pop-signed-message-parity.test.ts`
 * imports THIS file to compare the two implementations directly. If they ever
 * drift by one byte, every PoP registration fails and it looks like a key bug.
 *
 * Re-exported from `pop-challenge.ts`, which is where verifiers reach it.
 *
 * BINDING (three fields, three distinct attacks)
 * ──────────────────────────────────────────────
 *   • `op` (v3) — a proof minted for one operation must not authorize another.
 *     Without it, `register` and `unregister` were interchangeable, because both
 *     verify sites draw from the SAME per-peer nonce bucket and checked the same
 *     string. The attack needed no replay: a relay forwards `challenge` (it wants
 *     the proof to exist), then SUPPRESSES the browser's `register` frame — which
 *     is indistinguishable from the ordinary lost frame `registerWithPop`'s retry
 *     loop exists to absorb, so the agent never sees it and the nonce stays
 *     unconsumed. The relay then relabels the identical `{token, nonce,
 *     signature}` triple as `{op:"unregister"}` and the teardown runs.
 *
 *     That is worse than a teardown DoS: `unregisterPeer` also clears the peer's
 *     F4 replay window (`nats-channel.ts`, `seenMessageIds.delete`). So the relay
 *     could suppress → forge teardown → wait for the browser to re-register →
 *     replay previously captured `.in` envelopes, which now pass dedupe as FRESH
 *     user messages. Message-injection integrity loss, not key loss (persisted K
 *     survives a teardown).
 *
 *   • `peerId` — a signature captured for one peer must not act on another.
 *   • `nonce` — single-use and server-issued, so a captured proof cannot be
 *     replayed for the same op.
 *
 * ENCODING. `webchannel-pop:{op}:{peerId}:{nonce}`.
 *
 * Injectivity does NOT rest on the peerId being colon-free. Both call sites do
 * run `assertValidSubjectToken` (`[A-Za-z0-9_-]{1,128}`) before verifying, but
 * relying on that would make this encoding's correctness a property of two remote
 * call sites — and it already failed once: the unregister branch returned before
 * reaching register's copy of that check, so a `:`-bearing peerId was reachable
 * here until the check was added to that branch too.
 *
 * The encoding is injective on its own terms, from the two fields it fully
 * controls. `op` is a closed vocabulary of colon-free literals, so the 2nd field
 * is unambiguous reading forward; `nonce` is base64url from `randomBytes(32)` and
 * therefore colon-free, so the last field is unambiguous reading BACKWARD. Fixing
 * both ends pins the peerId to everything between them, whatever it contains.
 *
 * DECIDED, NOT OVERLOOKED: `tenant`/`accountId` are deliberately NOT bound here.
 * See the identical note in `wrap-aad.ts` for the reasoning.
 *
 * Against the v2 encoding this replaces (`webchannel-pop:{peerId}:{nonce}`) the
 * separation is weaker and does NOT need to be strong: a v2 message could equal a
 * v3 one only for a peerId containing `:` (e.g. `register:user-42`), which
 * `assertValidSubjectToken` rejects. More to the point, cross-version confusion is
 * unreachable by construction — a signature is only ever checked against a nonce
 * this agent issued and stores single-use, and a v2 and a v3 agent never share a
 * nonce store. Protocol v3 is a hard break in both directions.
 */

/**
 * The operations a PoP proof can authorize. Closed vocabulary — both values are
 * `:`-free, which is what keeps the signed message injective. Adding a value here
 * is a wire-contract change: it must stay `:`-free and must be added on both
 * sides at once.
 */
export type PopOp = "register" | "unregister";

/**
 * Build the signed message. MUST be byte-identical to the browser's
 * `popSignedMessage` (packages/client/src/pop-register.ts).
 */
export function popSignedMessage(op: PopOp, peerId: string, nonce: string): string {
  return `webchannel-pop:${op}:${peerId}:${nonce}`;
}
