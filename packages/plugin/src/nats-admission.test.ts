/**
 * NATS peer-admission (Axis B) decision tests.
 *
 * Verifies the explicit admission-mode decision across all
 * registerHopAvailable × auth-strategy × override combinations, and in particular
 * the NEW capability: a deployment with NO viable register hop (e.g. static
 * bring-your-own-NATS creds) resolves to `auto` WITHOUT devOpen, while every
 * legacy flow is preserved (enrolled+jwt and devOpen+jwt → register-hop;
 * devOpen+hmac/anon → auto).
 *
 * Axis B is deliberately ignorant of Axis A's credential-mode names — it only
 * sees the derived `registerHopAvailable` boolean. The caller maps:
 *   enrolled / open → registerHopAvailable = true
 *   static          → registerHopAvailable = false
 * Each test below notes the credential mode it stands in for.
 */
import { describe, it, expect } from "vitest";

import { resolveAdmissionMode } from "./nats-admission.js";

describe("resolveAdmissionMode", () => {
  it("explicit override always wins", () => {
    // static (registerHopAvailable=false) + jwt, overridden to register-hop.
    expect(
      resolveAdmissionMode({ authStrategy: "jwt", registerHopAvailable: false, explicitOverride: "register-hop" }),
    ).toBe("register-hop");
    // enrolled (registerHopAvailable=true) + jwt, overridden to auto.
    expect(
      resolveAdmissionMode({ authStrategy: "jwt", registerHopAvailable: true, explicitOverride: "auto" }),
    ).toBe("auto");
  });

  it("no register hop available → auto (static / BYO-NATS — no issuer / register hop)", () => {
    // static maps to registerHopAvailable=false for every strategy.
    expect(resolveAdmissionMode({ registerHopAvailable: false, authStrategy: "hmac-ticket" })).toBe("auto");
    expect(resolveAdmissionMode({ registerHopAvailable: false, authStrategy: undefined })).toBe("auto");
    // Even if someone configures jwt strategy, no viable hop biases toward auto.
    expect(resolveAdmissionMode({ registerHopAvailable: false, authStrategy: "jwt" })).toBe("auto");
  });

  it("jwt strategy with a viable hop → register-hop (production / enrolled)", () => {
    // enrolled + jwt → register-hop.
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: "jwt" })).toBe("register-hop");
    // open (devOpen) + jwt → register-hop.
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: "jwt" })).toBe("register-hop");
  });

  it("non-jwt with a viable hop → auto (hmac-ticket / anonymous / open)", () => {
    // open (devOpen) + hmac → auto.
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: "hmac-ticket" })).toBe("auto");
    // open (devOpen) + anonymous → auto.
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: "anonymous" })).toBe("auto");
    // enrolled + no strategy → auto.
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: undefined })).toBe("auto");
  });

  it("preserves the legacy devOpen-harness decisions exactly", () => {
    // devOpen (open, registerHopAvailable=true) + jwt → register-hop (HTTP hop is sole path).
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: "jwt" })).toBe("register-hop");
    // devOpen (open) + hmac → auto (wildcard auto-register convenience).
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: "hmac-ticket" })).toBe("auto");
  });
});
