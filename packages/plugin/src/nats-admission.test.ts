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

import { resolveAdmissionMode, admissionServingPlan } from "./nats-admission.js";

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
    expect(resolveAdmissionMode({ registerHopAvailable: false, authStrategy: "anonymous" })).toBe("auto");
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

  it("non-jwt with a viable hop → auto (anonymous / no-strategy / open)", () => {
    // open (devOpen) + anonymous → auto.
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: "anonymous" })).toBe("auto");
    // enrolled + no strategy → auto.
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: undefined })).toBe("auto");
  });

  it("preserves the legacy devOpen-harness decisions exactly", () => {
    // devOpen (open, registerHopAvailable=true) + jwt → register-hop (HTTP hop is sole path).
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: "jwt" })).toBe("register-hop");
    // devOpen (open) + non-jwt → auto (wildcard auto-register convenience).
    expect(resolveAdmissionMode({ registerHopAvailable: true, authStrategy: "anonymous" })).toBe("auto");
  });
});

/**
 * Serving-plan tests — the structural consequence of the admission decision that
 * the per-account build loop in index-nats.ts consumes.
 *
 * These lock the fix: the `channels.webchannel.auth` verifier and the register
 * route's `aud → account` dispatch entry are meaningful ONLY for a `register-hop`
 * account. A pure-`auto` account is served (wildcard subscribed, dispatcher
 * wired) with NO verifier and NO aud mapping — never skipped for "missing auth".
 */
describe("admissionServingPlan", () => {
  it("INVARIANT 1 — auto ⇒ wildcard subscribed, NO verifier built, NO aud mapping", () => {
    // An enrolled/open account whose admission is `auto` is served purely via the
    // NATS wildcard + handshake. It must NOT require or build the auth verifier,
    // and must NOT claim an aud dispatch entry.
    expect(admissionServingPlan("auto")).toEqual({
      subscribeWildcard: true,
      buildVerifier: false,
      populateAudMapping: false,
    });
  });

  it("INVARIANT 2 — register-hop ⇒ verifier built + aud mapping populated, NO wildcard", () => {
    // A jwt register-hop account keeps the verifier + register-route dispatch
    // exactly as before (peers gated by the HTTP hop, not the wildcard).
    expect(admissionServingPlan("register-hop")).toEqual({
      subscribeWildcard: false,
      buildVerifier: true,
      populateAudMapping: true,
    });
  });

  it("INVARIANT 4 — no auth.strategy + no nats.admission ⇒ auto ⇒ served, no verifier", () => {
    // An account with neither `auth` nor `nats.admission` set: resolveAdmissionMode
    // returns `auto`, and its serving plan builds no verifier and subscribes the
    // wildcard — i.e. it IS served end-to-end without any auth ceremony.
    const admission = resolveAdmissionMode({
      authStrategy: undefined,
      registerHopAvailable: true, // enrolled/open: a hop is viable but unused (no jwt strategy)
      explicitOverride: undefined,
    });
    expect(admission).toBe("auto");
    const plan = admissionServingPlan(admission);
    expect(plan.buildVerifier).toBe(false);
    expect(plan.subscribeWildcard).toBe(true);
    expect(plan.populateAudMapping).toBe(false);
  });

  it("INVARIANT 3 — a jwt account with a viable hop stays register-hop (verifier IS required)", () => {
    // A misconfigured jwt account still resolves to register-hop, so buildVerifier
    // is true → resolveVerifier runs (and throws → the account is skipped, loud).
    // The verifier is skipped only for a GENUINE `auto` decision, never as a
    // catch-all for verifier errors.
    const admission = resolveAdmissionMode({
      authStrategy: "jwt",
      registerHopAvailable: true,
      explicitOverride: undefined,
    });
    expect(admission).toBe("register-hop");
    expect(admissionServingPlan(admission).buildVerifier).toBe(true);
  });
});
