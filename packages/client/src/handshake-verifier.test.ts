/**
 * Handshake MITM-rejection verifier — Sub-AC 4b.
 *
 * Tests that the NATS handshake verifier:
 *   1. Accepts a well-formed handshake when both keys match the SaaS-pinned values.
 *   2. Rejects (HandshakeMitmError) when the agent key is forged.
 *   3. Rejects (HandshakeMitmError) when the device key is forged.
 *   4. Rejects when no pins are stored for the peerId (Error, not MITM).
 *   5. Rejects malformed / structurally-invalid handshake payloads.
 *   6. Uses constant-time comparison (length/type guard edge cases).
 *   7. Integration: mock NATS peer delivers a forged agent key via a simulated
 *      NATS MSG frame; the browser-side verifier refuses with HandshakeMitmError.
 *
 * Test nomenclature
 * ─────────────────
 * "mock NATS peer" — an in-process fake that publishes a NATS MSG payload
 * (a raw Buffer or string) exactly as a real NATS server would deliver it
 * to a subscriber.  The fake does NOT open any TCP socket; it uses the same
 * `_wsFactory` seam pattern as the NatsTransport unit tests.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  HandshakeMitmError,
  verifyAgentKey,
  verifyDeviceKey,
  parseAndVerifyHandshake,
  type HandshakeHelloMessage,
} from "./handshake-verifier.js";

import {
  storePinnedKeys,
  clearPinnedKeys,
  type PinnedKeys,
} from "./saas-bootstrap.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test key fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a deterministic 32-byte key for testing (no crypto.getRandomValues). */
function makeKey32(seed: number): Uint8Array {
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed * 7 + i * 13) % 256;
  return buf;
}

/** Encode a Uint8Array to base64url (Node.js Buffer fast path). */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Build a valid HandshakeHelloMessage JSON string. */
function makeHandshakePayload(
  peerId: string,
  agentPub: Uint8Array,
  devicePub: Uint8Array,
  overrides: Partial<Record<string, unknown>> = {},
): string {
  const msg: Record<string, unknown> = {
    type: "handshake_hello",
    version: 1,
    peerId,
    agentPublicKey: toBase64Url(agentPub),
    devicePublicKey: toBase64Url(devicePub),
    ...overrides,
  };
  return JSON.stringify(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PEER_ID = "user-42";
const AGENT_PUB = makeKey32(1); // legitimate SaaS-attested agent key
const DEVICE_PUB = makeKey32(2); // legitimate SaaS-attested device key (cnf.jwk.x)

const GOOD_PINS: PinnedKeys = {
  agentPublicKey: AGENT_PUB,
  devicePublicKey: DEVICE_PUB,
};

// Wipe the in-memory pin store before each test to prevent cross-test leakage.
beforeEach(() => {
  clearPinnedKeys();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — verifyAgentKey / verifyDeviceKey
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyAgentKey — happy path", () => {
  it("does not throw when the presented key exactly matches the SaaS-pinned agent key", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    // No exception — keys match.
    expect(() => verifyAgentKey(PEER_ID, new Uint8Array(AGENT_PUB))).not.toThrow();
  });

  it("does not throw for a different peerId with its own matching pin", () => {
    const otherPeer = "user-99";
    const otherAgent = makeKey32(10);
    storePinnedKeys(otherPeer, { agentPublicKey: otherAgent, devicePublicKey: makeKey32(11) });
    expect(() => verifyAgentKey(otherPeer, new Uint8Array(otherAgent))).not.toThrow();
  });
});

describe("verifyDeviceKey — happy path", () => {
  it("does not throw when the presented key exactly matches the SaaS-pinned device key", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    expect(() => verifyDeviceKey(PEER_ID, new Uint8Array(DEVICE_PUB))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MITM rejection — forged agent key
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyAgentKey — MITM rejection on forged key", () => {
  it("throws HandshakeMitmError when the presented agent key differs by one byte", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);

    const forgedKey = new Uint8Array(AGENT_PUB);
    forgedKey[0] = forgedKey[0]! ^ 0xff; // flip all bits of the first byte

    expect(() => verifyAgentKey(PEER_ID, forgedKey))
      .toThrow(HandshakeMitmError);
  });

  it("throws HandshakeMitmError with a message mentioning MITM", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const forgedKey = makeKey32(99); // completely different key

    let caught: unknown;
    try {
      verifyAgentKey(PEER_ID, forgedKey);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HandshakeMitmError);
    expect((caught as HandshakeMitmError).message).toMatch(/agent key mismatch/i);
    expect((caught as HandshakeMitmError).message).toMatch(/MITM/i);
    expect((caught as HandshakeMitmError).message).toMatch(/aborted/i);
  });

  it("throws HandshakeMitmError.kind === 'HandshakeMitmError'", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    try {
      verifyAgentKey(PEER_ID, makeKey32(50));
    } catch (e) {
      expect((e as HandshakeMitmError).kind).toBe("HandshakeMitmError");
    }
  });

  it("is not a plain Error subclass identity confusion — instanceof HandshakeMitmError is true", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    try {
      verifyAgentKey(PEER_ID, makeKey32(51));
    } catch (e) {
      expect(e instanceof HandshakeMitmError).toBe(true);
      expect(e instanceof Error).toBe(true); // also an Error for catch ergonomics
    }
  });

  it("rejects an all-zero forged key (not just off-by-one)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    expect(() => verifyAgentKey(PEER_ID, new Uint8Array(32)))
      .toThrow(HandshakeMitmError);
  });

  it("rejects a key with wrong length (short key — 16 bytes)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    expect(() => verifyAgentKey(PEER_ID, new Uint8Array(16)))
      .toThrow(HandshakeMitmError);
  });

  it("rejects a key with wrong length (long key — 64 bytes)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    expect(() => verifyAgentKey(PEER_ID, new Uint8Array(64)))
      .toThrow(HandshakeMitmError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. MITM rejection — forged device key
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyDeviceKey — MITM rejection on forged key", () => {
  it("throws HandshakeMitmError when the presented device key differs by one byte", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const forgedKey = new Uint8Array(DEVICE_PUB);
    forgedKey[31] = forgedKey[31]! ^ 0x01; // flip last bit of last byte

    expect(() => verifyDeviceKey(PEER_ID, forgedKey))
      .toThrow(HandshakeMitmError);
  });

  it("throws HandshakeMitmError with a message mentioning MITM and device key mismatch", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const forgedKey = makeKey32(88);

    let caught: unknown;
    try {
      verifyDeviceKey(PEER_ID, forgedKey);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HandshakeMitmError);
    expect((caught as HandshakeMitmError).message).toMatch(/device key mismatch/i);
    expect((caught as HandshakeMitmError).message).toMatch(/MITM/i);
    expect((caught as HandshakeMitmError).message).toMatch(/aborted/i);
  });

  it("rejects a completely different device key (not off-by-one)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    expect(() => verifyDeviceKey(PEER_ID, makeKey32(77)))
      .toThrow(HandshakeMitmError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Missing pins — no pins stored for peerId
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyAgentKey / verifyDeviceKey — missing pins", () => {
  it("verifyAgentKey throws a plain Error (not HandshakeMitmError) when no pins are stored", () => {
    // No storePinnedKeys call — pins are absent.
    let caught: unknown;
    try {
      verifyAgentKey(PEER_ID, AGENT_PUB);
    } catch (e) {
      caught = e;
    }
    // A missing pin is NOT a MITM — it's a bootstrap error.
    // Plain Error is thrown, NOT HandshakeMitmError.
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(HandshakeMitmError);
    expect((caught as Error).message).toMatch(/no pinned keys/i);
    expect((caught as Error).message).toMatch(/bootstrap/i);
  });

  it("verifyDeviceKey throws a plain Error when no pins are stored", () => {
    let caught: unknown;
    try {
      verifyDeviceKey(PEER_ID, DEVICE_PUB);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(HandshakeMitmError);
    expect((caught as Error).message).toMatch(/no pinned keys/i);
  });

  it("verifyAgentKey throws for a peerId that was never bootstrapped even when another peer was", () => {
    storePinnedKeys("other-user", GOOD_PINS);
    expect(() => verifyAgentKey("nobody", AGENT_PUB)).toThrow(/no pinned keys/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. parseAndVerifyHandshake — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAndVerifyHandshake — happy path", () => {
  it("returns the validated HandshakeHelloMessage when both keys match", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const payload = makeHandshakePayload(PEER_ID, AGENT_PUB, DEVICE_PUB);

    const msg: HandshakeHelloMessage = parseAndVerifyHandshake(payload, PEER_ID);

    expect(msg.type).toBe("handshake_hello");
    expect(msg.version).toBe(1);
    expect(msg.peerId).toBe(PEER_ID);
    expect(msg.agentPublicKey).toBe(toBase64Url(AGENT_PUB));
    expect(msg.devicePublicKey).toBe(toBase64Url(DEVICE_PUB));
  });

  it("accepts a Buffer payload (raw NATS MSG binary)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const payload = Buffer.from(
      makeHandshakePayload(PEER_ID, AGENT_PUB, DEVICE_PUB),
      "utf8",
    );
    expect(() => parseAndVerifyHandshake(payload, PEER_ID)).not.toThrow();
  });

  it("accepts a string payload (UTF-8 text from NATS MSG)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const payload = makeHandshakePayload(PEER_ID, AGENT_PUB, DEVICE_PUB);
    expect(typeof payload).toBe("string");
    expect(() => parseAndVerifyHandshake(payload, PEER_ID)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. parseAndVerifyHandshake — MITM rejection (forged keys in NATS payload)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAndVerifyHandshake — MITM rejection on forged keys in payload", () => {
  it("throws HandshakeMitmError when the payload contains a forged agentPublicKey", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const forgedAgentKey = makeKey32(200); // not the pinned value
    const payload = makeHandshakePayload(PEER_ID, forgedAgentKey, DEVICE_PUB);

    expect(() => parseAndVerifyHandshake(payload, PEER_ID))
      .toThrow(HandshakeMitmError);
  });

  it("throws HandshakeMitmError when the payload contains a forged devicePublicKey", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const forgedDeviceKey = makeKey32(201); // not the pinned value
    const payload = makeHandshakePayload(PEER_ID, AGENT_PUB, forgedDeviceKey);

    expect(() => parseAndVerifyHandshake(payload, PEER_ID))
      .toThrow(HandshakeMitmError);
  });

  it("throws HandshakeMitmError when both keys are forged", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const payload = makeHandshakePayload(PEER_ID, makeKey32(202), makeKey32(203));

    expect(() => parseAndVerifyHandshake(payload, PEER_ID))
      .toThrow(HandshakeMitmError);
  });

  it("error message identifies the failing key type (agent mismatch)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const payload = makeHandshakePayload(PEER_ID, makeKey32(210), DEVICE_PUB);

    let caught: unknown;
    try {
      parseAndVerifyHandshake(payload, PEER_ID);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HandshakeMitmError);
    expect((caught as HandshakeMitmError).message).toMatch(/agent key mismatch/i);
  });

  it("error message identifies the failing key type (device mismatch)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const payload = makeHandshakePayload(PEER_ID, AGENT_PUB, makeKey32(211));

    let caught: unknown;
    try {
      parseAndVerifyHandshake(payload, PEER_ID);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HandshakeMitmError);
    expect((caught as HandshakeMitmError).message).toMatch(/device key mismatch/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. parseAndVerifyHandshake — structural / malformed payload rejection
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAndVerifyHandshake — malformed payload rejection", () => {
  beforeEach(() => storePinnedKeys(PEER_ID, GOOD_PINS));

  it("throws Error (not HandshakeMitmError) on invalid JSON", () => {
    let caught: unknown;
    try {
      parseAndVerifyHandshake("this is not json", PEER_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(HandshakeMitmError);
    expect((caught as Error).message).toMatch(/parse/i);
  });

  it("throws on a non-object JSON value (array)", () => {
    expect(() => parseAndVerifyHandshake(JSON.stringify([1, 2, 3]), PEER_ID))
      .toThrow(/must be a JSON object/);
  });

  it("throws when type is not 'handshake_hello'", () => {
    const payload = JSON.stringify({
      type: "wrong_type",
      version: 1,
      peerId: PEER_ID,
      agentPublicKey: toBase64Url(AGENT_PUB),
      devicePublicKey: toBase64Url(DEVICE_PUB),
    });
    expect(() => parseAndVerifyHandshake(payload, PEER_ID)).toThrow(
      /"handshake_hello"/,
    );
  });

  it("throws when version is not 1", () => {
    const payload = makeHandshakePayload(PEER_ID, AGENT_PUB, DEVICE_PUB, {
      version: 2,
    });
    expect(() => parseAndVerifyHandshake(payload, PEER_ID)).toThrow(
      /unsupported handshake version/,
    );
  });

  it("throws when peerId in payload does not match the expected peerId", () => {
    const payload = makeHandshakePayload("different-user", AGENT_PUB, DEVICE_PUB);
    expect(() => parseAndVerifyHandshake(payload, PEER_ID)).toThrow(
      /peerId mismatch/,
    );
  });

  it("throws when agentPublicKey is missing", () => {
    const payload = JSON.stringify({
      type: "handshake_hello",
      version: 1,
      peerId: PEER_ID,
      // agentPublicKey omitted
      devicePublicKey: toBase64Url(DEVICE_PUB),
    });
    expect(() => parseAndVerifyHandshake(payload, PEER_ID)).toThrow(
      /agentPublicKey must be a non-empty/,
    );
  });

  it("throws when devicePublicKey is missing", () => {
    const payload = JSON.stringify({
      type: "handshake_hello",
      version: 1,
      peerId: PEER_ID,
      agentPublicKey: toBase64Url(AGENT_PUB),
      // devicePublicKey omitted
    });
    expect(() => parseAndVerifyHandshake(payload, PEER_ID)).toThrow(
      /devicePublicKey must be a non-empty/,
    );
  });

  it("throws when agentPublicKey is an empty string", () => {
    const payload = makeHandshakePayload(PEER_ID, AGENT_PUB, DEVICE_PUB, {
      agentPublicKey: "",
    });
    expect(() => parseAndVerifyHandshake(payload, PEER_ID)).toThrow(
      /agentPublicKey must be a non-empty/,
    );
  });

  it("throws when devicePublicKey is an empty string", () => {
    const payload = makeHandshakePayload(PEER_ID, AGENT_PUB, DEVICE_PUB, {
      devicePublicKey: "",
    });
    expect(() => parseAndVerifyHandshake(payload, PEER_ID)).toThrow(
      /devicePublicKey must be a non-empty/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Constant-time comparison — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("Constant-time comparison — edge cases", () => {
  it("detects a single-bit flip in the presented key (bit 0 of byte 0)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const flipBit0 = new Uint8Array(AGENT_PUB);
    flipBit0[0] = flipBit0[0]! ^ 0x01;
    expect(() => verifyAgentKey(PEER_ID, flipBit0)).toThrow(HandshakeMitmError);
  });

  it("detects a single-bit flip in the last byte", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const flipLast = new Uint8Array(AGENT_PUB);
    flipLast[31] = flipLast[31]! ^ 0x80;
    expect(() => verifyAgentKey(PEER_ID, flipLast)).toThrow(HandshakeMitmError);
  });

  it("accepts a byte-identical copy (not the same Uint8Array reference)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    // The pinned key is AGENT_PUB; we present a COPY (different reference).
    const copy = new Uint8Array(AGENT_PUB);
    expect(copy).not.toBe(AGENT_PUB); // different reference
    expect(() => verifyAgentKey(PEER_ID, copy)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Integration test — mock NATS peer presents forged key
//
// This test simulates the full browser-side handshake-verification flow using
// a mock NATS peer.  The "mock NATS peer" is a fake that delivers a NATS MSG
// payload directly to the message handler (the `_wsFactory` seam pattern used
// throughout the transport layer).
//
// Flow:
//   1. Browser seeds good pins for PEER_ID (SaaS bootstrap complete).
//   2. Mock NATS peer publishes a `handshake_hello` with a FORGED agent key.
//   3. Browser's on-message handler calls `parseAndVerifyHandshake`.
//   4. Test asserts HandshakeMitmError is thrown and handshake is refused.
// ─────────────────────────────────────────────────────────────────────────────

describe("Integration — mock NATS peer presenting forged key", () => {
  /**
   * Minimal mock NATS peer.
   *
   * Simulates a NATS server delivering a single MSG frame to a subscriber.
   * No real socket is opened — this is pure in-process simulation using the
   * same `_wsFactory` seam as the NatsTransport unit tests.
   *
   * Usage:
   *   const peer = new MockNatsPeer();
   *   // Register an on-message handler:
   *   peer.onMessage(payload => { ... });
   *   // Deliver a MSG:
   *   peer.deliver(subject, payloadString);
   */
  class MockNatsPeer {
    private messageHandlers: Array<(payload: Buffer) => void> = [];

    /** Register a handler called for each delivered MSG payload. */
    onMessage(fn: (payload: Buffer) => void): void {
      this.messageHandlers.push(fn);
    }

    /**
     * Deliver a simulated NATS MSG with the given subject and payload.
     * Calls all registered message handlers with the raw payload Buffer.
     *
     * This mimics what NatsTransport emits on its 'message' event when the
     * NATS server pushes a MSG frame for a subscribed subject.
     */
    deliver(_subject: string, payload: string): void {
      const buf = Buffer.from(payload, "utf8");
      // NatsTransport emits { subject, payload } — we deliver the payload Buffer
      // directly to simulate what the browser's on-message handler receives.
      for (const fn of this.messageHandlers) {
        fn(buf);
      }
    }
  }

  it(
    "mock NATS peer presents legitimate keys — handshake succeeds",
    () => {
      storePinnedKeys(PEER_ID, GOOD_PINS);
      const peer = new MockNatsPeer();

      const HANDSHAKE_SUBJECT = `chat.tenant1.agent1.${PEER_ID}.handshake`;

      let caughtError: unknown = null;
      let receivedMessage: HandshakeHelloMessage | null = null;

      // Browser-side on-message handler: parse + verify the handshake.
      peer.onMessage((payload) => {
        try {
          receivedMessage = parseAndVerifyHandshake(payload, PEER_ID);
        } catch (e) {
          caughtError = e;
        }
      });

      // Mock peer (legitimate agent) publishes the correct keys.
      peer.deliver(
        HANDSHAKE_SUBJECT,
        makeHandshakePayload(PEER_ID, AGENT_PUB, DEVICE_PUB),
      );

      expect(caughtError).toBeNull();
      expect(receivedMessage).not.toBeNull();
      expect(receivedMessage!.peerId).toBe(PEER_ID);
    },
  );

  it(
    "mock NATS peer presents FORGED agent key — handshake is refused with HandshakeMitmError",
    () => {
      // ── Step 1: Browser seeds the good pins from the SaaS bootstrap ──────────
      storePinnedKeys(PEER_ID, GOOD_PINS);

      const peer = new MockNatsPeer();
      const HANDSHAKE_SUBJECT = `chat.tenant1.agent1.${PEER_ID}.handshake`;

      // ── Step 2: Capture any error thrown by the verifier ─────────────────────
      let caughtError: unknown = null;
      let receivedMessage: HandshakeHelloMessage | null = null;

      // Browser-side on-message handler: calls the verifier on each MSG.
      peer.onMessage((payload) => {
        try {
          receivedMessage = parseAndVerifyHandshake(payload, PEER_ID);
        } catch (e) {
          caughtError = e;
        }
      });

      // ── Step 3: Mock NATS peer (forged agent) publishes a FORGED agent key ───
      const FORGED_AGENT_KEY = makeKey32(255); // NOT the pinned value
      peer.deliver(
        HANDSHAKE_SUBJECT,
        makeHandshakePayload(PEER_ID, FORGED_AGENT_KEY, DEVICE_PUB),
      );

      // ── Step 4: Assert the handshake is REFUSED ───────────────────────────────
      // The verifier must throw HandshakeMitmError — the forged key was rejected.
      expect(caughtError).toBeInstanceOf(HandshakeMitmError);
      expect((caughtError as HandshakeMitmError).message).toMatch(/agent key mismatch/i);
      expect((caughtError as HandshakeMitmError).message).toMatch(/MITM/i);

      // No message was processed — handshake was aborted before any key use.
      expect(receivedMessage).toBeNull();
    },
  );

  it(
    "mock NATS peer presents FORGED device key — handshake is refused with HandshakeMitmError",
    () => {
      storePinnedKeys(PEER_ID, GOOD_PINS);

      const peer = new MockNatsPeer();
      const HANDSHAKE_SUBJECT = `chat.tenant1.agent1.${PEER_ID}.handshake`;

      let caughtError: unknown = null;
      let receivedMessage: HandshakeHelloMessage | null = null;

      peer.onMessage((payload) => {
        try {
          receivedMessage = parseAndVerifyHandshake(payload, PEER_ID);
        } catch (e) {
          caughtError = e;
        }
      });

      const FORGED_DEVICE_KEY = makeKey32(254); // NOT the pinned cnf.jwk.x value
      peer.deliver(
        HANDSHAKE_SUBJECT,
        makeHandshakePayload(PEER_ID, AGENT_PUB, FORGED_DEVICE_KEY),
      );

      expect(caughtError).toBeInstanceOf(HandshakeMitmError);
      expect((caughtError as HandshakeMitmError).message).toMatch(/device key mismatch/i);
      expect((caughtError as HandshakeMitmError).message).toMatch(/MITM/i);
      expect(receivedMessage).toBeNull();
    },
  );

  it(
    "mock NATS peer presents both keys forged — first mismatch (agent) is reported",
    () => {
      storePinnedKeys(PEER_ID, GOOD_PINS);

      const peer = new MockNatsPeer();
      let caughtError: unknown = null;

      peer.onMessage((payload) => {
        try {
          parseAndVerifyHandshake(payload, PEER_ID);
        } catch (e) {
          caughtError = e;
        }
      });

      peer.deliver(
        `chat.tenant1.agent1.${PEER_ID}.handshake`,
        makeHandshakePayload(PEER_ID, makeKey32(253), makeKey32(252)),
      );

      // Agent key is checked first — that's what the error should mention.
      expect(caughtError).toBeInstanceOf(HandshakeMitmError);
      expect((caughtError as HandshakeMitmError).message).toMatch(/agent key mismatch/i);
    },
  );

  it(
    "mock NATS peer presents forged key when no bootstrap has been done — Error (not MITM) is thrown",
    () => {
      // clearPinnedKeys() was called in beforeEach — no pins for PEER_ID.
      const peer = new MockNatsPeer();
      let caughtError: unknown = null;

      peer.onMessage((payload) => {
        try {
          parseAndVerifyHandshake(payload, PEER_ID);
        } catch (e) {
          caughtError = e;
        }
      });

      peer.deliver(
        `chat.tenant1.agent1.${PEER_ID}.handshake`,
        makeHandshakePayload(PEER_ID, AGENT_PUB, DEVICE_PUB),
      );

      // Missing pins is a bootstrap error, not a MITM.
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).not.toBeInstanceOf(HandshakeMitmError);
      expect((caughtError as Error).message).toMatch(/no pinned keys/i);
    },
  );

  it(
    "mock NATS peer sends malformed JSON — Error is thrown (not MITM, handshake refused)",
    () => {
      storePinnedKeys(PEER_ID, GOOD_PINS);

      const peer = new MockNatsPeer();
      let caughtError: unknown = null;
      let received: HandshakeHelloMessage | null = null;

      peer.onMessage((payload) => {
        try {
          received = parseAndVerifyHandshake(payload, PEER_ID);
        } catch (e) {
          caughtError = e;
        }
      });

      // Deliver a garbled payload — e.g. from a malicious relay injecting noise.
      peer.deliver(
        `chat.tenant1.agent1.${PEER_ID}.handshake`,
        "NOT VALID JSON {{{",
      );

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).not.toBeInstanceOf(HandshakeMitmError);
      expect((caughtError as Error).message).toMatch(/parse/i);
      expect(received).toBeNull();
    },
  );

  it(
    "multiple sequential deliveries: first forged, then legitimate — only the second succeeds",
    () => {
      storePinnedKeys(PEER_ID, GOOD_PINS);

      const peer = new MockNatsPeer();
      const errors: unknown[] = [];
      const successes: HandshakeHelloMessage[] = [];

      peer.onMessage((payload) => {
        try {
          successes.push(parseAndVerifyHandshake(payload, PEER_ID));
        } catch (e) {
          errors.push(e);
        }
      });

      // First: forged key — rejected.
      peer.deliver(
        `chat.tenant1.agent1.${PEER_ID}.handshake`,
        makeHandshakePayload(PEER_ID, makeKey32(251), DEVICE_PUB),
      );

      // Second: legitimate keys — accepted.
      peer.deliver(
        `chat.tenant1.agent1.${PEER_ID}.handshake`,
        makeHandshakePayload(PEER_ID, AGENT_PUB, DEVICE_PUB),
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(HandshakeMitmError);
      expect(successes).toHaveLength(1);
      expect(successes[0]!.peerId).toBe(PEER_ID);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Security invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("Security invariants", () => {
  it("does not expose pin values in the error message (no key bytes in message)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    try {
      verifyAgentKey(PEER_ID, makeKey32(100));
    } catch (e) {
      const msg = (e as HandshakeMitmError).message;
      // The error must NOT embed the hex/base64 of the pinned or presented key.
      // It should only describe the KIND of mismatch, not the values.
      // (This prevents the error message from becoming a side-channel for
      //  learning the pinned key value.)
      expect(msg).not.toMatch(/[0-9a-f]{32,}/i); // no 16+ hex chars
      expect(msg).not.toMatch(/[A-Za-z0-9+/]{43,}/); // no base64 > 32 bytes
    }
  });

  it("HandshakeMitmError name property is 'HandshakeMitmError'", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    try {
      verifyAgentKey(PEER_ID, makeKey32(101));
    } catch (e) {
      expect((e as HandshakeMitmError).name).toBe("HandshakeMitmError");
    }
  });

  it("the same presented key always produces the same result (deterministic)", () => {
    storePinnedKeys(PEER_ID, GOOD_PINS);
    const forged = makeKey32(102);

    // Call twice — must produce the same error both times.
    for (let i = 0; i < 2; i++) {
      let caught: unknown = null;
      try {
        verifyAgentKey(PEER_ID, forged);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HandshakeMitmError);
    }
  });

  it("pin verification is independent per peerId — one MITM does not affect another peer", () => {
    const peerA = "user-A";
    const peerB = "user-B";
    const agentA = makeKey32(30);
    const agentB = makeKey32(31);
    const deviceK = makeKey32(32);

    storePinnedKeys(peerA, { agentPublicKey: agentA, devicePublicKey: deviceK });
    storePinnedKeys(peerB, { agentPublicKey: agentB, devicePublicKey: deviceK });

    // Forged key for peerA — peerB should be unaffected.
    expect(() => verifyAgentKey(peerA, makeKey32(99))).toThrow(HandshakeMitmError);
    expect(() => verifyAgentKey(peerB, new Uint8Array(agentB))).not.toThrow();
  });
});
