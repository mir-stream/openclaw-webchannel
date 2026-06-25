/**
 * Browser-side E2E envelope codec — mirrors the plugin's e2e-envelope wire
 * format EXACTLY so a node agent and a browser interoperate:
 *
 *   { v:1, agentId, tenant, sub, messageId, envelopeType, ts,
 *     content: { nonce, ciphertext, tag } }   // all base64url
 *
 * Routing fields are plaintext (the NATS operator can see them); only `content`
 * is ChaCha20-Poly1305 ciphertext.
 */

import { encrypt, decrypt } from "./e2e-crypto.js";

export type EnvelopeType = "conversation" | "typing";

export type MessageEnvelope = {
  v: 1;
  agentId: string;
  tenant: string;
  sub: string;
  messageId: string;
  envelopeType: EnvelopeType;
  ts: number;
  content: { nonce: string; ciphertext: string; tag: string };
};

export type EnvelopeRouting = {
  agentId: string;
  tenant: string;
  sub: string;
  messageId: string;
  envelopeType: EnvelopeType;
  ts: number;
};

function u8ToB64Url(u: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToU8(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeEnvelope(
  routing: EnvelopeRouting,
  plaintext: string | Uint8Array,
  key: Uint8Array,
): MessageEnvelope {
  const bytes = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const { ciphertext, nonce, tag } = encrypt(key, bytes);
  return {
    v: 1,
    ...routing,
    content: {
      nonce: u8ToB64Url(nonce),
      ciphertext: u8ToB64Url(ciphertext),
      tag: u8ToB64Url(tag),
    },
  };
}

export function decryptEnvelopeContent(env: MessageEnvelope, key: Uint8Array): Uint8Array {
  return decrypt(
    key,
    b64UrlToU8(env.content.nonce),
    b64UrlToU8(env.content.ciphertext),
    b64UrlToU8(env.content.tag),
  );
}

export function serializeEnvelope(env: MessageEnvelope): string {
  return JSON.stringify(env);
}

export function deserializeEnvelope(payload: string | Uint8Array): MessageEnvelope {
  const json = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  return JSON.parse(json) as MessageEnvelope;
}
