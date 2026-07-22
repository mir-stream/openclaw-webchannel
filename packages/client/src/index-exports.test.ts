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
  type WebChannelErrorCause,
  type WebChannelNATSClientOptions,
} from "./index.js";
import * as publicApi from "./index.js";
import { WebChannelNATSClient } from "./nats-client-wrapper.js";

// P1-7: compile-time export assertion for the new type. A type-only export has no
// runtime value, so there is nothing to `expect` at runtime — this TYPE-POSITION
// use is the whole check: if the barrel stops exporting the name, tsc fails here.
const _errorCauseExported: WebChannelErrorCause = "protocol-mismatch";
void _errorCauseExported;
const registration = {
  devicePrivateKey: {} as CryptoKey,
  deviceX25519PrivateKey: {} as CryptoKey,
};

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
  it("does not export the removed gateway client", () => {
    const removedExport = "WebChannel" + "Client";
    expect(removedExport in publicApi).toBe(false);
  });

  it("constructs the NATS wrapper type without legacy WS options", () => {
    // Uses the barrel-exported options type (not ConstructorParameters) so tsc
    // fails here if `WebChannelNATSClientOptions` drops off the public surface.
    const compileOnly = (options: WebChannelNATSClientOptions) =>
      new WebChannelNATSClient(options);
    expect(compileOnly).toBeTypeOf("function");
    const options: WebChannelNATSClientOptions = {
      natsUrl: "wss://relay.example.test",
      bootstrapJwt: "jwt",
      accountId: "account",
      tenant: "tenant",
      peerId: "peer",
      reconnectBaseMs: 250,
      reconnectCapMs: 5_000,
      heartbeatIntervalMs: 20_000,
      registration,
    };
    expect(options.natsUrl).toContain("relay");
  });
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
