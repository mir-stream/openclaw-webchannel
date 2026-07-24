/**
 * Wire-protocol version + runtime plugin-version reporting (plugin side).
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

import { WEBCHANNEL_PROTOCOL_VERSION, readPluginVersion } from "./protocol.js";

describe("plugin protocol module", () => {
  it("declares wire-protocol version 2 (lockstep with the client constant)", () => {
    expect(WEBCHANNEL_PROTOCOL_VERSION).toBe(2);
  });

  it("reads this plugin's package.json version at runtime (createRequire)", () => {
    const require = createRequire(import.meta.url);
    const expected = (require("../package.json") as { version: string }).version;
    expect(readPluginVersion()).toBe(expected);
  });

  it("is cached — repeated reads return the same value", () => {
    expect(readPluginVersion()).toBe(readPluginVersion());
  });
});
