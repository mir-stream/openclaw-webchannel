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
 * v4 (breaking, #246): the v6 delivery-render frames are not optional garnish —
 * a peer that ignores them DIVERGES SILENTLY. See the worked example below.
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
 *  - BUMP when correctness — not merely rendering — requires the peer to ACT on
 *    a new frame or field. **v4 is the worked example (#246).** v6 added: a
 *    per-conversation `seq` on every durable inbound frame plus the
 *    `get_difference`/`difference` round-trip that heals a hole in it (#244);
 *    the `user_committed` multi-device broadcast (#245); `history` rows of kind
 *    `reasoning`/`tool`/`approval` (#242); and `ack.committed[]`, the durable
 *    user id the server minted plus its seq (#243). A v3 peer stays on the wire,
 *    looks healthy, and is wrong in two ways it cannot itself detect:
 *      · No `seq` ⇒ no gap detection ⇒ it never sends `get_difference`. This
 *        transport is core NATS pub/sub, AT-MOST-ONCE with no retention, so a
 *        dropped frame leaves a hole the peer CANNOT SEE and never asks to heal.
 *        What reaches it unasked — the history snapshot requested on every
 *        successful register (`nats-register.ts`), a `turn_snapshot` at the end
 *        of a streamed turn — is INCIDENTAL, NOT A REPAIR PATH: it rides the
 *        same at-most-once transport and nothing aims it at the hole. #244
 *        exists so the hole ITSELF triggers the heal instead of luck.
 *      · It DROPS `history` rows that carry no `role` — the `case "history"`
 *        guard every released build has, which is the very thing that made that
 *        widening safe — so its transcript holds no reasoning id to cite as a
 *        `before` cursor and "load older" STALLS FOREVER once an operator
 *        enables `capabilities.reasoningDurable` (#309).
 *    #309 named the only two fixes: withhold the row per peer, or refuse the
 *    connection. This bump is the refusal, and it retires #309's operator-side
 *    mitigation ("do not enable `reasoningDurable` while a stale client is
 *    served"). Both sides already reject a mismatch, so the constant IS the
 *    enforcement — no new gate was added.
 *  - DO NOT BUMP for a new frame type only when its semantics are optional and
 *    safely ignorable by an old peer. Measured, not assumed — and re-measured
 *    after #246 half A put a runtime decoder on both sides' receive doors: an
 *    unknown or malformed frame is REFUSED AT THE DOOR and dropped with one
 *    warn, so `deliverInbound` (nats-client.ts) no longer forwards an
 *    unrecognised frame to the message listeners, and the plugin's door
 *    (`nats-channel.ts`) refuses one before `dispatchInbound` sees it. The
 *    tolerance is UNCHANGED in what it yields — an old peer still ignores a
 *    frame it does not know, it just does so visibly and earlier — and it still
 *    proves only wire tolerance, not semantic compatibility. If correctness
 *    requires the peer to act on a new frame (for example reset or revocation),
 *    BUMP or negotiate a capability. `InboundMessage["type"]` is still a
 *    compile-time union that rejects nothing by itself; what rejects at runtime
 *    is `inbound-wire-decode.ts`'s `KNOWN_INBOUND_TYPES`.
 *
 * ⚠️ v4 ADDED NO CAPABILITY NEGOTIATION, AND THAT IS A DECISION — NOT AN
 * OVERSIGHT TO "FINISH". #309 framed the fix as negotiation, and negotiation is
 * what you need in order to WITHHOLD a frame kind from ONE peer while serving it
 * to another. Under an exact-match version gate there is no such peer: everything
 * that registers is at this exact version. The one shape that would need per-peer
 * withholding — a LIVE delete/edit frame — is not on this wire at all:
 * `messageDeleted`/`messageEdited` are `DurableEvent` kinds with NO PRODUCER
 * (`durable-view-reducer.ts`), reachable only through `difference`/`history`. So
 * a capability carrier would ship with zero consumers, and an unexercised
 * mechanism is one that gets discovered broken the first time it matters. The
 * slice that adds the first frame an EQUAL-version peer must act on decides
 * bump-vs-negotiate then, under the rule above.
 *
 * NOTE: this is a DIFFERENT layer from the E2E message-envelope version
 * (`ENVELOPE_VERSION` / `v:1`), which versions the encrypted payload format.
 */
export const WEBCHANNEL_PROTOCOL_VERSION = 4;
