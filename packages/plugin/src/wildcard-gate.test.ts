/**
 * Wildcard admission-gate tests.
 *
 * Asserts the dev/open-NATS wildcard subscription is taken ONLY for the
 * hmac-ticket convenience path and is OFF whenever auth.strategy === "jwt" (so
 * the HTTP /webchannel/nats/register route is the sole admission path), and is
 * never taken outside dev/open-NATS (enrolled production).
 */
import { describe, it, expect } from "vitest";

import { shouldSubscribeWildcard } from "./wildcard-gate.js";

describe("shouldSubscribeWildcard (dev/open-NATS wildcard gate)", () => {
  it("subscribes wildcard under devOpen for hmac-ticket (auto-register convenience)", () => {
    expect(shouldSubscribeWildcard(true, "hmac-ticket")).toBe(true);
  });

  it("subscribes wildcard under devOpen for anonymous", () => {
    expect(shouldSubscribeWildcard(true, "anonymous")).toBe(true);
  });

  it("subscribes wildcard under devOpen when no strategy is configured", () => {
    expect(shouldSubscribeWildcard(true, undefined)).toBe(true);
  });

  it("does NOT subscribe wildcard under devOpen when strategy is jwt (HTTP register is sole path)", () => {
    expect(shouldSubscribeWildcard(true, "jwt")).toBe(false);
  });

  it("never subscribes wildcard outside dev/open-NATS (enrolled production)", () => {
    expect(shouldSubscribeWildcard(false, "jwt")).toBe(false);
    expect(shouldSubscribeWildcard(false, "hmac-ticket")).toBe(false);
    expect(shouldSubscribeWildcard(false, undefined)).toBe(false);
  });
});
