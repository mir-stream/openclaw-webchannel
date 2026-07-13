/**
 * Public export-surface contract test.
 *
 * The whole reason the bootstrap validator is exported is so a downstream host
 * (rota-crew) can run a contract test against the client's ACTUAL parsing logic
 * (F2 lesson). This test guards that the export exists AND behaves at the PACKAGE
 * ENTRY (`./index.js`) — a re-export that regresses (typo, removed name) fails
 * here, not silently in a consumer.
 */

import { describe, expect, it } from "vitest";

import {
  parseBootstrapResponse,
  parseAndStorePinnedKeys,
  WEBCHANNEL_PROTOCOL_VERSION,
  type BootstrapPayload,
  type PinnedKeys,
} from "./index.js";

/** Deterministic 32-byte key (no crypto.getRandomValues — reproducible). */
function makeKey32(seed: number): Uint8Array {
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed * 7 + i * 13) % 256;
  return buf;
}

function toB64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function validPayload(): BootstrapPayload {
  return {
    verifiedJwtPayload: {
      sub: "peer-1",
      cnf: { jwk: { kty: "OKP", crv: "X25519", x: toB64Url(makeKey32(1)) } },
    },
    agentPublicKey: toB64Url(makeKey32(2)),
  };
}

describe("public export surface (package entry)", () => {
  it("re-exports parseBootstrapResponse and it validates a well-formed payload", () => {
    const keys: PinnedKeys = parseBootstrapResponse(validPayload());
    expect(keys.agentPublicKey).toEqual(makeKey32(2));
    expect(keys.devicePublicKey).toEqual(makeKey32(1));
  });

  it("re-exports parseBootstrapResponse and it throws on a malformed cnf claim", () => {
    const bad = validPayload();
    (bad.verifiedJwtPayload as Record<string, unknown>).cnf = { jwk: { kty: "RSA" } };
    expect(() => parseBootstrapResponse(bad)).toThrow();
  });

  it("re-exports parseAndStorePinnedKeys", () => {
    const keys = parseAndStorePinnedKeys("peer-exports", validPayload());
    expect(keys.agentPublicKey).toEqual(makeKey32(2));
  });

  it("re-exports the wire-protocol version constant", () => {
    expect(WEBCHANNEL_PROTOCOL_VERSION).toBe(1);
  });
});
