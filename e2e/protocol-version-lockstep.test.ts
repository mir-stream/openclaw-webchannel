/**
 * Cross-package lockstep guard for WEBCHANNEL_PROTOCOL_VERSION.
 *
 * The client and the plugin each declare their OWN protocol-version constant
 * (no shared package exists — see packages/client/src/protocol.ts and
 * packages/plugin/src/protocol.ts). The register handshake enforces a MATCH at
 * runtime, so if the two constants ever diverge, every deployed client↔plugin
 * pair goes terminal-mismatch.
 *
 * Each side already has a `toBe(1)` unit test, but those are independent: a
 * one-sided bump (constant + that side's test) would leave CI green while
 * production breaks. This test imports BOTH real constants in one process (the
 * root vitest sweep runs every package together) and asserts equality, so a
 * one-sided bump turns CI RED — forcing the bumper to update both sides (and to
 * consider the downstream WC_REF + gateway redeploy per the PR checklist).
 */

import { describe, it, expect } from "vitest";

import { WEBCHANNEL_PROTOCOL_VERSION as CLIENT_PROTOCOL_VERSION } from "../packages/client/src/protocol.js";
import { WEBCHANNEL_PROTOCOL_VERSION as PLUGIN_PROTOCOL_VERSION } from "../packages/plugin/src/protocol.js";

describe("WEBCHANNEL_PROTOCOL_VERSION client↔plugin lockstep", () => {
  it("the client and plugin constants are identical (a one-sided bump is a mismatch)", () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe(PLUGIN_PROTOCOL_VERSION);
  });
});
