/**
 * Cross-package lockstep for `WEBCHANNEL_PROTOCOL_VERSION`.
 *
 * The plugin and the client each declare their own constant (no shared package),
 * and each side's own suite asserts a literal. That catches a one-sided edit only
 * because both literals happen to be written down; it does not state the actual
 * contract, which is that the two constants are EQUAL. Pinned here directly, in
 * the same spirit as `wrap-aad-parity.test.ts`.
 *
 * This test lives in the plugin package because the client's `protocol.ts` is a
 * bare `export const` with no imports, so it typechecks cleanly under the plugin's
 * Node lib set. The reverse direction would not: the plugin's `protocol.ts` pulls
 * in `node:module` for `readPluginVersion`.
 */

import { describe, it, expect } from "vitest";

import { WEBCHANNEL_PROTOCOL_VERSION as PLUGIN_VERSION } from "./protocol.js";
import { WEBCHANNEL_PROTOCOL_VERSION as CLIENT_VERSION } from "../../client/src/protocol.js";

describe("WEBCHANNEL_PROTOCOL_VERSION lockstep (plugin ↔ client)", () => {
  it("the two constants are equal", () => {
    expect(CLIENT_VERSION).toBe(PLUGIN_VERSION);
  });

  it("is a positive safe integer (the wire contract is numeric, never coerced)", () => {
    expect(Number.isSafeInteger(PLUGIN_VERSION)).toBe(true);
    expect(PLUGIN_VERSION).toBeGreaterThan(0);
  });
});
