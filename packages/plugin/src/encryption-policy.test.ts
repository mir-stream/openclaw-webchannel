/**
 * Fail-closed boot guard tests (AC 3a / EncryptedChannelWired).
 */

import { describe, it, expect } from "vitest";

import {
  resolveEncryptionPolicy,
  EncryptionDisabledError,
} from "./encryption-policy.js";

describe("resolveEncryptionPolicy (fail-closed NATS boot guard)", () => {
  it("returns crypto options when encryption is unset (secure-by-default)", () => {
    expect(resolveEncryptionPolicy(undefined)).toEqual({ crypto: {} });
    expect(resolveEncryptionPolicy({})).toEqual({ crypto: {} });
  });

  it("returns crypto options when encryption is explicitly required", () => {
    expect(resolveEncryptionPolicy({ mode: "required" })).toEqual({ crypto: {} });
  });

  it("refuses to start when encryption is explicitly disabled (fail-closed)", () => {
    expect(() => resolveEncryptionPolicy({ mode: "disabled" })).toThrow(
      EncryptionDisabledError,
    );
  });

  it("the disabled error explains why the entry will not boot", () => {
    try {
      resolveEncryptionPolicy({ mode: "disabled" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EncryptionDisabledError);
      expect((err as Error).message).toContain("encrypt-by-construction");
      expect((err as Error).message).toContain("ciphertext");
    }
  });
});
