/**
 * Wildcard-subscription admission gate.
 *
 * The dev/open-NATS `channel.subscribeWildcard()` is PURELY the hmac-ticket dev
 * shortcut: the local harness browser connects with an hmac-ticket and does NOT
 * call the HTTP register hop, so the agent subscribes to the tenant/agent
 * wildcard and peers auto-register on their handshake (the allowlist gate still
 * runs).
 *
 * When `auth.strategy === "jwt"`, the HTTP `/webchannel/nats/register` route is
 * the REAL admission path even under open-NATS — the enrolled/JWT producer must
 * drive challenge → PoP-signed register so the agent calls `registerPeer`. If we
 * left the wildcard ON in that scenario the proof would be meaningless (the agent
 * would already be subscribed to every peer). So the wildcard must be OFF on the
 * jwt path.
 *
 * This does NOT change production behavior: enrolled production runs with
 * devOpenNats=false, so the wildcard is already off there.
 */
export function shouldSubscribeWildcard(
  devOpenNats: boolean,
  authStrategy: string | undefined,
): boolean {
  return devOpenNats && authStrategy !== "jwt";
}
