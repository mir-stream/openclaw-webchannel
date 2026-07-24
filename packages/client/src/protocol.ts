/**
 * WebChannel wire-protocol version — the client↔plugin register handshake.
 *
 * This integer is bumped whenever the client↔plugin register wire contract
 * changes in a way that is NOT backward-compatible (frame shapes, the register
 * challenge/response fields, key-delivery semantics). It rides the `register`
 * request and the register success reply so a mismatch fails LOUDLY and is
 * diagnosable, instead of silently breaking at runtime (the F2 lesson).
 *
 * There is no shared package between the client and the plugin, so the plugin
 * declares its OWN equal constant (see packages/plugin/src/protocol.ts). The
 * handshake itself catches any drift between the two. Protocol v2 is mandatory
 * in both directions; neither side accepts an absent or mismatched version.
 *
 * NOTE: this is a DIFFERENT layer from the E2E message-envelope version
 * (`ENVELOPE_VERSION` / `v:1`), which versions the encrypted payload format.
 */
export const WEBCHANNEL_PROTOCOL_VERSION = 2;
