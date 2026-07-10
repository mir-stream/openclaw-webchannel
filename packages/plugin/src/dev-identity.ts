/**
 * F2 — WELL-KNOWN agent identity key pair for the DEV-OPEN register-hop path.
 *
 * ⚠️  NOT A SECRET AND NOT FOR PRODUCTION. ⚠️
 *
 * The register-hop key model wraps the conversation key K under the agent's
 * SaaS-attested identity key so the browser can authenticate it (see
 * late-join-decryptor.ts / saas-bootstrap.ts). PRODUCTION register-hop accounts
 * are ENROLLED and carry that attested key in their persisted credentials — an
 * enrolled register-hop account with no identity key is fail-closed (index-nats).
 *
 * But the dev/e2e register-hop harnesses run on OPEN NATS (`WEBCHANNEL_NATS_DEV_OPEN`)
 * with NO enrolled creds and therefore no identity key. Those harnesses are OUT of
 * the F2 threat model (there is no untrusted shared relay — the whole NATS is a
 * throwaway localhost server). To let them exercise the real register-delivered-key
 * wire path WITHOUT enrollment, the agent falls back to THIS keypair, and the
 * matching dev browser drivers pin its public half. Because both sides derive the
 * SAME keypair from a fixed label, the round-trip authenticates in dev exactly as
 * a pinned production key would — while a real deployment (enrolled mode) can never
 * reach this fallback.
 *
 * The pair is DERIVED at runtime from a constant label (no private-key literal in
 * the source), so it is stable across processes without embedding key material.
 */

import { createHash } from "node:crypto";

import { keyPairFromSeed, type KeyPair } from "./e2e-crypto.js";

/** Fixed label → 32-byte seed → X25519 keypair (deterministic, dev-only). */
const DEV_IDENTITY_SEED = new Uint8Array(
  createHash("sha256").update("webchannel-dev-open-agent-identity-v1").digest(),
);

/** The well-known dev identity key pair (agent wraps K under this in dev-open). */
export function devOpenAgentIdentityKeyPair(): KeyPair {
  return keyPairFromSeed(DEV_IDENTITY_SEED);
}

/** base64url of the dev identity PUBLIC key — what dev browser drivers pin. */
export function devOpenAgentIdentityPublicB64url(): string {
  return Buffer.from(devOpenAgentIdentityKeyPair().publicKey).toString("base64url");
}
