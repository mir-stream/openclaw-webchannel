/**
 * Cross-package BYTE-IDENTITY contract for the key-wrap AAD.
 *
 * The agent (`packages/plugin/src/late-join-decryptor.ts`) and the browser
 * (`packages/client/src/e2e-crypto-browser.ts`) each declare their OWN `wrapAad`
 * — there is no shared package between them. If those two encodings ever drift by
 * a single byte, EVERY register-delivered conversation key fails Poly1305 and the
 * product is dead on arrival, with a failure that looks like a crypto bug rather
 * than a contract break.
 *
 * Before v3 this contract was asserted NOWHERE: it survived only because "UTF-8 of
 * the peerId" was too simple to get wrong. v3's encoding has a version prefix, two
 * delimiters, and two fields, so it is asserted here — both implementations
 * imported by relative source path and compared byte-for-byte (the same
 * cross-package seam pattern as nats-p04-integration.test.ts). The agent half
 * lives in `packages/plugin/src/wrap-aad.ts`, kept free of `node:` imports
 * precisely so it typechecks under this package's browser-only lib set.
 *
 * The golden vector below is a THIRD, hand-rolled encoding: it pins the actual
 * bytes, so a symmetric edit to both implementations still fails.
 */

import { describe, it, expect } from "vitest";

import {
  wrapAad as agentWrapAad,
  WRAP_AAD_VERSION as AGENT_VERSION,
  WRAP_AAD_SEPARATOR as AGENT_SEPARATOR,
} from "../../plugin/src/wrap-aad.js";
import {
  wrapAad as browserWrapAad,
  WRAP_AAD_VERSION as BROWSER_VERSION,
  WRAP_AAD_SEPARATOR as BROWSER_SEPARATOR,
} from "./e2e-crypto-browser.js";

/** Hex without node:Buffer — this file typechecks under browser-only libs. */
const hex = (b: Uint8Array) =>
  Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");

const utf8 = (s: string) => new TextEncoder().encode(s);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

describe("wrapAad byte-identity (agent ↔ browser)", () => {
  it("declares the same version string and delimiter byte on both sides", () => {
    expect(BROWSER_VERSION).toBe(AGENT_VERSION);
    expect(BROWSER_SEPARATOR).toBe(AGENT_SEPARATOR);
    // 0x1F UNIT SEPARATOR — outside both field alphabets, so no escaping needed.
    expect(AGENT_SEPARATOR).toBe(0x1f);
  });

  it.each([
    ["user-42", "Y2xpZW50LW5vbmNlLWZpeHR1cmUtMDE"],
    ["a", "AAAAAAAAAAAAAAAAAAAAAA"],
    // Full legal subject-token charset + a full-length base64url nonce.
    ["A-Za-z0-9_-", "-_09azAZ".repeat(8)],
    ["x".repeat(128), "Q".repeat(128)],
  ])("produces byte-identical AAD for (%s, …)", (peerId, clientNonce) => {
    const agent = agentWrapAad(peerId, clientNonce);
    const browser = browserWrapAad(peerId, clientNonce);
    expect(hex(browser)).toBe(hex(agent));
  });

  it("matches an independently hand-rolled golden encoding", () => {
    const peerId = "user-42";
    const clientNonce = "Y2xpZW50LW5vbmNlLWZpeHR1cmUtMDE";
    // version ‹0x1F› peerId ‹0x1F› clientNonce — built here without touching
    // either implementation, so a matching edit to BOTH still trips this.
    const golden = concatBytes(
      utf8("webchannel-wrap-v2"),
      new Uint8Array([0x1f]),
      utf8(peerId),
      new Uint8Array([0x1f]),
      utf8(clientNonce),
    );
    expect(hex(agentWrapAad(peerId, clientNonce))).toBe(hex(golden));
    expect(hex(browserWrapAad(peerId, clientNonce))).toBe(hex(golden));
  });

  it("is UNAMBIGUOUS: no (peerId, clientNonce) pair can collide with another", () => {
    // The property the delimiter buys. With naive concatenation, ("ab","c") and
    // ("a","bc") would encode identically; with 0x1F — which neither alphabet can
    // contain — they cannot.
    expect(hex(agentWrapAad("ab", "cdefghijklmnopqrstuvwx")))
      .not.toBe(hex(agentWrapAad("abc", "defghijklmnopqrstuvwx")));
  });

  it("changes when EITHER field changes (both are actually bound)", () => {
    const base = hex(agentWrapAad("peer-A", "bm9uY2UtdmFsdWUtb25lLXh4eA"));
    expect(hex(agentWrapAad("peer-B", "bm9uY2UtdmFsdWUtb25lLXh4eA"))).not.toBe(base);
    expect(hex(agentWrapAad("peer-A", "bm9uY2UtdmFsdWUtdHdvLXh4eA"))).not.toBe(base);
  });
});
