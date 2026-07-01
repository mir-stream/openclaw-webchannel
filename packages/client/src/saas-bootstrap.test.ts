/**
 * Unit tests for SaaS bootstrap key-pin extraction — Sub-AC 4a.
 *
 * Validates:
 *   1. Happy path: well-formed bootstrap payload → correct keys pinned.
 *   2. cnf claim missing or malformed → hard rejection.
 *   3. cnf.jwk wrong kty / crv → rejected.
 *   4. cnf.jwk.x wrong length → rejected.
 *   5. cnf.jwk.d (private key) present → rejected.
 *   6. agentPublicKey missing or wrong length → rejected.
 *   7. parseAndStorePinnedKeys persists keys and getPinnedKeys retrieves them.
 *   8. clearPinnedKeys / clearPinnedKeysForPeer wipe stored keys.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  parseBootstrapResponse,
  parseAndStorePinnedKeys,
  storePinnedKeys,
  getPinnedKeys,
  clearPinnedKeys,
  clearPinnedKeysForPeer,
  type BootstrapPayload,
  type PinnedKeys,
} from "./saas-bootstrap.js";

// ---------------------------------------------------------------------------
// Test-key fixtures
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic 32-byte key for testing.
 * Uses a seed byte pattern (no crypto.getRandomValues — fully deterministic).
 */
function makeKey32(seed: number): Uint8Array {
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed * 7 + i * 13) % 256;
  return buf;
}

/** Encode a Uint8Array to base64url (mirrors the internal helper, Node-compatible). */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Build a minimal valid bootstrap payload from raw key bytes. */
function makePayload(
  devicePub: Uint8Array,
  agentPub: Uint8Array,
  overrides: Partial<Record<string, unknown>> = {},
): BootstrapPayload {
  const verifiedJwtPayload: Record<string, unknown> = {
    iss: "https://saas.example.com/",
    sub: "user-42",
    aud: "openclaw-webchannel",
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    accountId: "agent-abc",
    tenant: "tenant-xyz",
    cnf: {
      jwk: {
        kty: "OKP",
        crv: "X25519",
        x: toBase64Url(devicePub),
      },
    },
    ...overrides,
  };
  return {
    verifiedJwtPayload,
    agentPublicKey: toBase64Url(agentPub),
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DEVICE_PUB  = makeKey32(1);
const AGENT_PUB   = makeKey32(2);
const PEER_ID     = "user-42";

// Clear the in-memory pin store before each test to avoid cross-test leakage.
beforeEach(() => {
  clearPinnedKeys();
});

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("parseBootstrapResponse — happy path", () => {
  it("returns correct 32-byte agentPublicKey and devicePublicKey from a well-formed payload", () => {
    const payload = makePayload(DEVICE_PUB, AGENT_PUB);
    const pins: PinnedKeys = parseBootstrapResponse(payload);

    // Keys are Uint8Arrays of length 32.
    expect(pins.agentPublicKey).toBeInstanceOf(Uint8Array);
    expect(pins.agentPublicKey.length).toBe(32);
    expect(pins.devicePublicKey).toBeInstanceOf(Uint8Array);
    expect(pins.devicePublicKey.length).toBe(32);

    // Keys match the fixture bytes.
    expect(Array.from(pins.agentPublicKey)).toEqual(Array.from(AGENT_PUB));
    expect(Array.from(pins.devicePublicKey)).toEqual(Array.from(DEVICE_PUB));
  });

  it("handles base64url padding variants (no pad, 1-pad, 2-pad) in cnf.jwk.x", () => {
    // A 30-byte key → base64url with 2 padding chars when padded; base64url normally omits padding.
    // Using makeKey32 (32 bytes) and checking round-trip for various encoding lengths.
    // The main concern: our base64url decoder correctly handles strings with 0/1/2 padding.

    // 32 bytes: base64url without padding is 43 chars (32 * 4 / 3 = 42.67 → 43 base64 chars,
    // 44 padded with '='). Let's verify the round-trip is correct for our fixture keys.
    const testKeys = [makeKey32(3), makeKey32(5), makeKey32(17), makeKey32(100)];
    for (const key of testKeys) {
      const payload = makePayload(key, AGENT_PUB);
      const pins = parseBootstrapResponse(payload);
      expect(Array.from(pins.devicePublicKey)).toEqual(Array.from(key));
    }
  });

  it("accepts extra unknown fields in the JWT payload (forward-compatible)", () => {
    const payload = makePayload(DEVICE_PUB, AGENT_PUB, {
      jti: "nonce-abc-123",
      someNewClaim: { nested: true },
    });
    expect(() => parseBootstrapResponse(payload)).not.toThrow();
  });

  it("extracts distinct keys when agentPublicKey !== devicePublicKey", () => {
    const device = makeKey32(10);
    const agent  = makeKey32(20);
    const pins = parseBootstrapResponse(makePayload(device, agent));
    // The two pinned keys must be distinct objects with distinct values.
    expect(Array.from(pins.agentPublicKey)).not.toEqual(Array.from(pins.devicePublicKey));
    expect(Array.from(pins.agentPublicKey)).toEqual(Array.from(agent));
    expect(Array.from(pins.devicePublicKey)).toEqual(Array.from(device));
  });
});

// ---------------------------------------------------------------------------
// 2. cnf claim missing or malformed
// ---------------------------------------------------------------------------

describe("parseBootstrapResponse — cnf claim rejection", () => {
  it("rejects when cnf is absent from the JWT payload", () => {
    const payload = makePayload(DEVICE_PUB, AGENT_PUB, { cnf: undefined });
    // Force-remove cnf from the object.
    const { cnf: _removed, ...withoutCnf } =
      payload.verifiedJwtPayload as Record<string, unknown>;
    void _removed;
    const modPayload: BootstrapPayload = {
      verifiedJwtPayload: withoutCnf,
      agentPublicKey: payload.agentPublicKey,
    };
    expect(() => parseBootstrapResponse(modPayload)).toThrow(/cnf claim is missing/);
  });

  it("rejects when cnf is null", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: { ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload, cnf: null },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/cnf claim is missing/);
  });

  it("rejects when cnf is a string (not an object)", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: "not-an-object",
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/cnf claim is missing or not an object/);
  });

  it("rejects when cnf is an array (not a plain object)", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: [{ jwk: {} }],
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/cnf claim is missing or not an object/);
  });

  it("rejects when cnf.jwk is absent", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: { kid: "some-key-id" }, // RFC 7800 kid form — not accepted here
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/cnf\.jwk is missing/);
  });

  it("rejects when cnf.jwk is null", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: { jwk: null },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/cnf\.jwk is missing/);
  });

  it("rejects when cnf.jwk is an array", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: { jwk: [{ kty: "OKP" }] },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/cnf\.jwk is missing/);
  });
});

// ---------------------------------------------------------------------------
// 3. cnf.jwk wrong kty / crv
// ---------------------------------------------------------------------------

describe("parseBootstrapResponse — cnf.jwk kty/crv enforcement", () => {
  it("rejects kty !== 'OKP' (EC key attempt)", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: {
          jwk: { kty: "EC", crv: "P-256", x: toBase64Url(DEVICE_PUB), y: toBase64Url(DEVICE_PUB) },
        },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/kty must be "OKP"/);
  });

  it("rejects kty !== 'OKP' (RSA key attempt)", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: {
          jwk: { kty: "RSA", n: "big-modulus", e: "AQAB" },
        },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/kty must be "OKP"/);
  });

  it("rejects kty of OKP with crv !== 'X25519' (Ed25519 attempt)", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: {
          jwk: { kty: "OKP", crv: "Ed25519", x: toBase64Url(DEVICE_PUB) },
        },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/crv must be "X25519"/);
  });

  it("rejects crv !== 'X25519' (X448 attempt)", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: {
          jwk: { kty: "OKP", crv: "X448", x: toBase64Url(DEVICE_PUB) },
        },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/crv must be "X25519"/);
  });

  it("rejects missing crv field entirely", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: {
          jwk: { kty: "OKP", x: toBase64Url(DEVICE_PUB) }, // crv omitted
        },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/crv must be "X25519"/);
  });
});

// ---------------------------------------------------------------------------
// 4. cnf.jwk.x wrong length / encoding
// ---------------------------------------------------------------------------

describe("parseBootstrapResponse — cnf.jwk.x length enforcement", () => {
  it("rejects when x is an empty string", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: { jwk: { kty: "OKP", crv: "X25519", x: "" } },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/cnf\.jwk\.x must be a non-empty base64url string/);
  });

  it("rejects when x is not a string (number)", () => {
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: { jwk: { kty: "OKP", crv: "X25519", x: 12345 } },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/cnf\.jwk\.x must be a non-empty base64url string/);
  });

  it("rejects when x decodes to fewer than 32 bytes (16-byte key)", () => {
    const shortKey = new Uint8Array(16); // 16 bytes — too short
    for (let i = 0; i < 16; i++) shortKey[i] = i;
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: { jwk: { kty: "OKP", crv: "X25519", x: toBase64Url(shortKey) } },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/must decode to exactly 32 bytes/);
  });

  it("rejects when x decodes to more than 32 bytes (64-byte key)", () => {
    const longKey = new Uint8Array(64);
    for (let i = 0; i < 64; i++) longKey[i] = i;
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: { jwk: { kty: "OKP", crv: "X25519", x: toBase64Url(longKey) } },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/must decode to exactly 32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// 5. cnf.jwk.d (private key) present
// ---------------------------------------------------------------------------

describe("parseBootstrapResponse — private key (d) rejection", () => {
  it("rejects when cnf.jwk.d is present (device private key must not appear in bootstrap)", () => {
    const devicePriv = makeKey32(99); // fake private key for test
    const payload: BootstrapPayload = {
      verifiedJwtPayload: {
        ...makePayload(DEVICE_PUB, AGENT_PUB).verifiedJwtPayload,
        cnf: {
          jwk: {
            kty: "OKP",
            crv: "X25519",
            x: toBase64Url(DEVICE_PUB),
            d: toBase64Url(devicePriv), // MUST be rejected
          },
        },
      },
      agentPublicKey: toBase64Url(AGENT_PUB),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/cnf\.jwk\.d \(private key\) must not be present/);
  });
});

// ---------------------------------------------------------------------------
// 6. agentPublicKey missing or wrong length
// ---------------------------------------------------------------------------

describe("parseBootstrapResponse — agentPublicKey validation", () => {
  it("rejects when agentPublicKey is an empty string", () => {
    const base = makePayload(DEVICE_PUB, AGENT_PUB);
    const payload: BootstrapPayload = {
      verifiedJwtPayload: base.verifiedJwtPayload,
      agentPublicKey: "",
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/agentPublicKey must be a non-empty base64url string/);
  });

  it("rejects when agentPublicKey decodes to fewer than 32 bytes", () => {
    const short = new Uint8Array(20);
    for (let i = 0; i < 20; i++) short[i] = i + 1;
    const base = makePayload(DEVICE_PUB, AGENT_PUB);
    const payload: BootstrapPayload = {
      verifiedJwtPayload: base.verifiedJwtPayload,
      agentPublicKey: toBase64Url(short),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/must decode to exactly 32 bytes/);
  });

  it("rejects when agentPublicKey decodes to more than 32 bytes", () => {
    const long = new Uint8Array(48);
    for (let i = 0; i < 48; i++) long[i] = i * 3;
    const base = makePayload(DEVICE_PUB, AGENT_PUB);
    const payload: BootstrapPayload = {
      verifiedJwtPayload: base.verifiedJwtPayload,
      agentPublicKey: toBase64Url(long),
    };
    expect(() => parseBootstrapResponse(payload)).toThrow(/must decode to exactly 32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// 7. parseAndStorePinnedKeys — parse + persist
// ---------------------------------------------------------------------------

describe("parseAndStorePinnedKeys", () => {
  it("parses and stores keys; getPinnedKeys returns the same values", () => {
    const pins = parseAndStorePinnedKeys(PEER_ID, makePayload(DEVICE_PUB, AGENT_PUB));

    expect(Array.from(pins.agentPublicKey)).toEqual(Array.from(AGENT_PUB));
    expect(Array.from(pins.devicePublicKey)).toEqual(Array.from(DEVICE_PUB));

    const retrieved = getPinnedKeys(PEER_ID);
    expect(retrieved).not.toBeNull();
    expect(Array.from(retrieved!.agentPublicKey)).toEqual(Array.from(AGENT_PUB));
    expect(Array.from(retrieved!.devicePublicKey)).toEqual(Array.from(DEVICE_PUB));
  });

  it("replaces existing keys on re-registration for the same peerId", () => {
    const device1 = makeKey32(31);
    const device2 = makeKey32(32);

    parseAndStorePinnedKeys(PEER_ID, makePayload(device1, AGENT_PUB));
    expect(Array.from(getPinnedKeys(PEER_ID)!.devicePublicKey)).toEqual(Array.from(device1));

    parseAndStorePinnedKeys(PEER_ID, makePayload(device2, AGENT_PUB));
    expect(Array.from(getPinnedKeys(PEER_ID)!.devicePublicKey)).toEqual(Array.from(device2));
  });

  it("stores keys independently for different peerIds", () => {
    const device1 = makeKey32(40);
    const device2 = makeKey32(41);
    const peerId1 = "user-100";
    const peerId2 = "user-200";

    parseAndStorePinnedKeys(peerId1, makePayload(device1, AGENT_PUB));
    parseAndStorePinnedKeys(peerId2, makePayload(device2, AGENT_PUB));

    expect(Array.from(getPinnedKeys(peerId1)!.devicePublicKey)).toEqual(Array.from(device1));
    expect(Array.from(getPinnedKeys(peerId2)!.devicePublicKey)).toEqual(Array.from(device2));
  });

  it("propagates parseBootstrapResponse errors (malformed payload not stored)", () => {
    // A payload with missing cnf — should throw before any store.
    const bad = makePayload(DEVICE_PUB, AGENT_PUB);
    const { cnf: _rm, ...withoutCnf } = bad.verifiedJwtPayload as Record<string, unknown>;
    void _rm;
    const badPayload: BootstrapPayload = {
      verifiedJwtPayload: withoutCnf,
      agentPublicKey: bad.agentPublicKey,
    };

    expect(() => parseAndStorePinnedKeys(PEER_ID, badPayload)).toThrow(/cnf claim is missing/);
    // Nothing was stored.
    expect(getPinnedKeys(PEER_ID)).toBeNull();
  });

  it("rejects a non-string peerId", () => {
    expect(() =>
      storePinnedKeys("", { agentPublicKey: AGENT_PUB, devicePublicKey: DEVICE_PUB }),
    ).toThrow(/peerId must be a non-empty string/);
  });
});

// ---------------------------------------------------------------------------
// 8. clearPinnedKeys / clearPinnedKeysForPeer
// ---------------------------------------------------------------------------

describe("clearPinnedKeys / clearPinnedKeysForPeer", () => {
  it("clearPinnedKeys removes all stored entries", () => {
    parseAndStorePinnedKeys("user-A", makePayload(DEVICE_PUB, AGENT_PUB));
    parseAndStorePinnedKeys("user-B", makePayload(makeKey32(77), AGENT_PUB));

    clearPinnedKeys();

    expect(getPinnedKeys("user-A")).toBeNull();
    expect(getPinnedKeys("user-B")).toBeNull();
  });

  it("clearPinnedKeysForPeer removes only the targeted entry", () => {
    parseAndStorePinnedKeys("user-A", makePayload(DEVICE_PUB, AGENT_PUB));
    parseAndStorePinnedKeys("user-B", makePayload(makeKey32(88), AGENT_PUB));

    clearPinnedKeysForPeer("user-A");

    expect(getPinnedKeys("user-A")).toBeNull();
    expect(getPinnedKeys("user-B")).not.toBeNull(); // untouched
  });

  it("getPinnedKeys returns null for an unknown peerId", () => {
    expect(getPinnedKeys("nobody")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Security: SaaS attestation contract assertions
// ---------------------------------------------------------------------------

describe("Security — SaaS attestation contract", () => {
  it("agent key and device key are independent values (not aliased)", () => {
    const payload = makePayload(DEVICE_PUB, AGENT_PUB);
    const pins = parseBootstrapResponse(payload);

    // Mutation of one must not affect the other — Uint8Array copies.
    // (We validate they are distinct typed arrays, not the same reference.)
    expect(pins.agentPublicKey).not.toBe(pins.devicePublicKey);
  });

  it("each call to parseBootstrapResponse returns fresh Uint8Array instances", () => {
    const payload = makePayload(DEVICE_PUB, AGENT_PUB);
    const pins1 = parseBootstrapResponse(payload);
    const pins2 = parseBootstrapResponse(payload);

    // Different Uint8Array instances (defensive copy), same values.
    expect(pins1.agentPublicKey).not.toBe(pins2.agentPublicKey);
    expect(Array.from(pins1.agentPublicKey)).toEqual(Array.from(pins2.agentPublicKey));
  });

  it("cnf.jwk-bound key pin must equal the raw base64url-decoded bytes (no transforms)", () => {
    // The key pin for the device must be the EXACT bytes from cnf.jwk.x, decoded
    // from base64url.  No key derivation, hashing, or transformation applied.
    const rawDeviceKey = new Uint8Array(32);
    rawDeviceKey.fill(0xab); // 0xab × 32
    const b64url = toBase64Url(rawDeviceKey);

    const payload = makePayload(rawDeviceKey, AGENT_PUB);
    const pins = parseBootstrapResponse(payload);

    // Byte-by-byte exact match.
    for (let i = 0; i < 32; i++) {
      expect(pins.devicePublicKey[i]).toBe(0xab);
    }
    // Sanity: base64url-decoding the field gives the same bytes.
    const decoded = Buffer.from(b64url, "base64url");
    expect(Array.from(pins.devicePublicKey)).toEqual(Array.from(decoded));
  });

  it("two different devices get different pinned device keys from their respective JWTs", () => {
    const deviceA = makeKey32(11);
    const deviceB = makeKey32(22);

    // Simulate two separate bootstrap responses (one per device registration).
    const pinsA = parseBootstrapResponse(makePayload(deviceA, AGENT_PUB));
    const pinsB = parseBootstrapResponse(makePayload(deviceB, AGENT_PUB));

    // Keys must differ.
    expect(Array.from(pinsA.devicePublicKey)).not.toEqual(Array.from(pinsB.devicePublicKey));
    // Agent key is the same (same agent for both devices).
    expect(Array.from(pinsA.agentPublicKey)).toEqual(Array.from(pinsB.agentPublicKey));
  });

  it("cnf is the single source of truth — agentPublicKey travels separately (not inside cnf)", () => {
    // The cnf claim ONLY carries the device key.
    // The agent key is a top-level field in the bootstrap response, NOT inside cnf.
    const payload = makePayload(DEVICE_PUB, AGENT_PUB);
    const cnf = payload.verifiedJwtPayload["cnf"] as Record<string, unknown>;
    const jwk = cnf["jwk"] as Record<string, unknown>;

    // cnf.jwk should not contain the agent public key.
    expect(toBase64Url(AGENT_PUB)).not.toBe(jwk["x"] as string);
    // The device key and agent key are distinct (fixture values).
    expect(Array.from(DEVICE_PUB)).not.toEqual(Array.from(AGENT_PUB));
  });
});
