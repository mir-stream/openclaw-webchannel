import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/core";

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  channelConfigs: {
    webchannel: {
      schema: Parameters<typeof buildJsonChannelConfigSchema>[0];
    };
  };
};

describe("shipped WebChannel manifest schema", () => {
  const runtime = buildJsonChannelConfigSchema(
    manifest.channelConfigs.webchannel.schema,
  ).runtime!;

  it("accepts the channel lifecycle enabled flag", () => {
    expect(runtime.safeParse({ enabled: false })).toEqual({
      success: true,
      data: { enabled: false },
    });
  });

  it("retains strict unknown-key rejection", () => {
    expect(runtime.safeParse({ unknownLifecycleKey: true }).success).toBe(false);
  });

  // #113. The operator-facing half of the reasoning gate. These run through
  // core's own schema builder, so they also prove the key is actually reachable
  // in the SHIPPED manifest — not merely present in a source file.
  it("accepts capabilities.reasoning as a boolean, at channel level and per account", () => {
    expect(runtime.safeParse({ capabilities: { reasoning: true } }).success).toBe(true);
    expect(runtime.safeParse({ capabilities: { reasoning: false } }).success).toBe(true);
    // Coexists with the sibling capability rather than displacing it.
    expect(
      runtime.safeParse({ capabilities: { typing: "on", reasoning: true } }).success,
    ).toBe(true);
    // The per-account leaf is deliberately unvalidated (accounts.*
    // additionalProperties:true), so the same shape must pass there too.
    expect(
      runtime.safeParse({ accounts: { named: { capabilities: { reasoning: true } } } }).success,
    ).toBe(true);
  });

  it("rejects the on/off spelling for capabilities.reasoning", () => {
    // `capabilities.typing` next door IS "on"/"off", so that is the wrong
    // spelling an operator reaches for first. Rejecting it at the schema means
    // they get a config error instead of a silently-ignored key. (The resolver
    // independently refuses to read those as ON — see account-config.test.ts.)
    for (const value of ["off", "on", "true", "false", 0, 1, null, {}, []]) {
      expect(
        runtime.safeParse({ capabilities: { reasoning: value } }).success,
        `capabilities.reasoning: ${JSON.stringify(value)} must be rejected`,
      ).toBe(false);
    }
  });

  it("still rejects an unknown sibling of capabilities.reasoning (no additionalProperties escape)", () => {
    expect(runtime.safeParse({ capabilities: { reasonning: true } }).success).toBe(false);
  });

  it("lets every JSON value reach the removed-audience runtime tombstone", () => {
    for (const audience of [null, "", "legacy", 0, false, [], {}, ["a"]]) {
      expect(runtime.safeParse({
        auth: { strategy: "jwt", jwt: { audience } },
      }).success).toBe(true);
      expect(runtime.safeParse({
        accounts: {
          named: { auth: { strategy: "jwt", jwt: { audience } } },
        },
      }).success).toBe(true);
    }
  });
});
