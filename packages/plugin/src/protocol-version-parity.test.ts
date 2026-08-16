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
 *
 * #160: THIS TEST IS THE ENFORCEMENT BOTH `protocol.ts` HEADERS POINT AT. Each
 * of them documents the lockstep and the bump rule in prose; a rule with no
 * executable guard is how #122 and #115 happened. If this file is renamed,
 * moved, or deleted, update both headers in the same change — they name it by
 * filename precisely so a move stays greppable.
 * `protocol-version-lockstep.test.ts` makes the same comparison from the e2e
 * side; the two are deliberate redundancy across suites, not a duplicate to
 * clean up.
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
