import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/core";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";

import { resolveReasoningEnabled } from "./account-config.js";

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

  // #113 P0. The manifest must declare NO schema default for
  // `capabilities.reasoning`. Core hydrates schema defaults into the stored
  // config (`validateJsonSchemaValue({ applyDefaults: true })` writes the result
  // back over `channels.webchannel`), so a `"default": false` here is not
  // documentation — it MATERIALIZES the key. `resolveReasoningEnabled` then reads
  // a PRESENT non-`true` value and correctly fails closed, the lane never opens,
  // and because it never opens the empty-lane warning cannot fire either. That is
  // bit-for-bit the silent failure #113 exists to end, reintroduced through the
  // schema. Two individually-correct guards — the fail-closed rule and a schema
  // default — meeting.
  //
  // `safeParse` alone cannot see this: defaults are hydrated by the validator,
  // not by the runtime parse, so these cases go through core's validator the way
  // the real config load does.
  describe("capabilities.reasoning declares no schema default (#113)", () => {
    const hydrate = (value: unknown) => {
      const result = validateJsonSchemaValue({
        schema: manifest.channelConfigs.webchannel.schema as JsonSchemaObject,
        // Unique per call: the validator caches compiled schemas by this key.
        cacheKey: `webchannel-manifest-default-${Math.random()}`,
        value,
        applyDefaults: true,
      });
      if (!result.ok) throw new Error(`unexpected validation failure: ${JSON.stringify(result.errors)}`);
      return result.value as { capabilities?: Record<string, unknown> };
    };

    it("does not materialize `reasoning` when the whole capabilities block is absent", () => {
      expect(hydrate({ enabled: true }).capabilities).toBeUndefined();
    });

    it("does not materialize `reasoning` when capabilities is present but empty", () => {
      expect(hydrate({ enabled: true, capabilities: {} })).not.toHaveProperty(
        "capabilities.reasoning",
      );
    });

    it("does not materialize `reasoning` when a SIBLING capability is set", () => {
      // The case that actually broke, and the one no e2e gate can reach: an
      // operator sets `capabilities.typing` — the key documented immediately
      // above this one — and silently acquires `reasoning: false`.
      const hydrated = hydrate({ enabled: true, capabilities: { typing: "off" } });
      expect(hydrated).not.toHaveProperty("capabilities.reasoning");
      // The sibling's own default is untouched by this fix and stays benign: it
      // materializes `typing`, but to the value `resolveTypingEnabled` already
      // defaults to, so no behaviour rides on it.
      expect(hydrated.capabilities).toEqual({ typing: "off" });
    });

    it("preserves an explicitly configured value of either polarity", () => {
      expect(hydrate({ enabled: true, capabilities: { reasoning: true } }).capabilities)
        .toMatchObject({ reasoning: true });
      expect(hydrate({ enabled: true, capabilities: { reasoning: false } }).capabilities)
        .toMatchObject({ reasoning: false });
    });

    it("hydrates to a config that resolveReasoningEnabled still reads as ON", () => {
      // Closes the loop end to end: the point of having no default is that the
      // resolver's absent-means-ON branch stays REACHABLE after core has written
      // the hydrated config back. Asserting the schema shape alone would not
      // catch a default reintroduced under a different spelling.
      expect(resolveReasoningEnabled(hydrate({ enabled: true, capabilities: { typing: "off" } })))
        .toBe(true);
      expect(resolveReasoningEnabled(hydrate({ enabled: true }))).toBe(true);
    });
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
