/**
 * Shared demo protocol constants + subject grammar.
 *
 * Pure strings only — safe to import from both the node agent and the browser.
 */

export const TENANT = "demo-tenant";
export const AGENT_ID = "demo-agent";
export const PEER_ID = "web-user";

/** NATS WebSocket endpoint (see nats.conf — websocket { port: 8087 }). */
export const NATS_WS_URL = "ws://127.0.0.1:8087";

/** browser → agent (the agent's inbound). */
export function inboundSubject(): string {
  return `webchannel.${TENANT}.${AGENT_ID}.${PEER_ID}.in`;
}

/** agent → browser (the browser's inbound). */
export function outboundSubject(): string {
  return `webchannel.${TENANT}.${AGENT_ID}.${PEER_ID}.out`;
}

/** key-exchange channel (both sides publish/subscribe; tagged by `from`). */
export function handshakeSubject(): string {
  return `webchannel.${TENANT}.${AGENT_ID}.${PEER_ID}.handshake`;
}

/** Plaintext key-exchange message published on the handshake subject. */
export type HandshakeMessage = {
  type: "handshake";
  from: "browser" | "agent";
  /** X25519 public key, base64url (32 bytes). */
  publicKey: string;
};
