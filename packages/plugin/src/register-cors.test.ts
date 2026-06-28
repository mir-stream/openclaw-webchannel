import { describe, it, expect } from "vitest";
import { resolveAllowOrigin } from "./register-cors.js";

describe("resolveAllowOrigin (Item 3 — CORS allowlist)", () => {
  describe("no allowlist configured (permissive — no regression)", () => {
    it("reflects the request Origin", () => {
      expect(resolveAllowOrigin("https://app.example", undefined)).toBe("https://app.example");
      expect(resolveAllowOrigin("https://app.example", [])).toBe("https://app.example");
    });
    it("falls back to `*` when no Origin is present", () => {
      expect(resolveAllowOrigin(undefined, undefined)).toBe("*");
      expect(resolveAllowOrigin(undefined, [])).toBe("*");
    });
  });

  describe("allowlist configured", () => {
    const allow = ["https://app.example", "https://admin.example"];

    it("echoes an in-list Origin", () => {
      expect(resolveAllowOrigin("https://app.example", allow)).toBe("https://app.example");
      expect(resolveAllowOrigin("https://admin.example", allow)).toBe("https://admin.example");
    });

    it("returns null for an out-of-list Origin (header must be omitted → browser blocks)", () => {
      expect(resolveAllowOrigin("https://evil.example", allow)).toBeNull();
    });

    it("returns null when no Origin is present", () => {
      expect(resolveAllowOrigin(undefined, allow)).toBeNull();
    });
  });
});
