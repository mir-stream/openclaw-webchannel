/**
 * WebChannel wire-protocol version — the client↔plugin register handshake.
 *
 * This integer rides the `register` request and the register success reply so a
 * mismatch fails LOUDLY and is diagnosable, instead of silently breaking at
 * runtime (the F2 lesson).
 *
 * There is no shared package between the client and the plugin, so the plugin
 * declares its OWN equal constant (see packages/plugin/src/protocol.ts). The
 * handshake catches drift at runtime, and two tests catch it at CI time:
 * `protocol-version-parity.test.ts` and `protocol-version-lockstep.test.ts`
 * each import BOTH constants and compare them, so editing one side alone turns
 * CI red. Named by filename, not path, so a moved file is still one grep away.
 *
 * v3 (breaking): the register request carries a mandatory browser-chosen
 * `clientNonce` bound into the wrapped-conversation-key AAD (freshness anchor
 * against a replayed register reply), and `unregister` requires a PoP proof.
 *
 * When to bump (#160)
 * ───────────────────
 * Bumping is breaking for every deployment simultaneously: both sides reject a
 * mismatch, so after publication a bump means every consumer must redeploy the
 * gateway AND every browser bundle at the same time. Keep the trigger narrow.
 *
 *  - BUMP when the register handshake contract changes: required request or
 *    reply fields, challenge/response semantics, or what the key delivery is
 *    bound to. v3 above is the worked example.
 *  - DO NOT BUMP for a new frame type only when its semantics are optional and
 *    safely ignorable by an old peer. Measured, not assumed: this side has no
 *    dispatch switch at all — `deliverInbound` (nats-client.ts) matches two
 *    specific types and forwards EVERY frame, known or not, to its message
 *    listeners; the plugin's inbound dispatch ends in a `default:` that only
 *    warns and drops the frame (`nats-channel.ts`). That proves wire tolerance,
 *    not semantic compatibility. If correctness requires the peer to act on a
 *    new frame (for example reset or revocation), BUMP or negotiate a capability.
 *    `InboundMessage["type"]` is a compile-time union only and rejects nothing
 *    at runtime.
 *
 * NOTE: this is a DIFFERENT layer from the E2E message-envelope version
 * (`ENVELOPE_VERSION` / `v:1`), which versions the encrypted payload format.
 */
export const WEBCHANNEL_PROTOCOL_VERSION = 3;
