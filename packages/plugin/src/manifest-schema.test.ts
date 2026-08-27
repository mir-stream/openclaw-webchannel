import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/core";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";

import { resolveReasoningDurable, resolveReasoningEnabled } from "./account-config.js";

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

  it("rejects malformed channel-level capabilities.reasoning values", () => {
    // `capabilities.typing` next door IS "on"/"off", so that is the wrong
    // spelling an operator reaches for first. Rejecting it at the schema means
    // they get a config error instead of a silently-ignored key. Named-account
    // leaves are deliberately unvalidated and therefore rely on the resolver's
    // independent fail-closed handling — see account-config.test.ts.
    for (const value of ["off", "on", "true", "false", 0, 1, null, {}, []]) {
      expect(
        runtime.safeParse({ capabilities: { reasoning: value } }).success,
        `capabilities.reasoning: ${JSON.stringify(value)} must be rejected`,
      ).toBe(false);
    }
  });

  it("leaves malformed named-account capabilities for the runtime fail-closed boundary", () => {
    for (const capabilities of [null, "off", false, 0, [], { reasoning: "off" }]) {
      expect(
        runtime.safeParse({ accounts: { named: { capabilities } } }).success,
        `named capabilities: ${JSON.stringify(capabilities)} remains schema-unvalidated`,
      ).toBe(true);
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

  // #242 half 1. The SECOND reasoning key — durability, not the lane — mirrored
  // against the shipped manifest for the same reason the block above exists.
  //
  // ⚠️ THE FAILURE THIS PREVENTS IS CONCRETE AND SILENT. `capabilities` is
  // `additionalProperties: false`, so if a later edit drops the schema entry,
  // every operator who set `reasoningDurable` at CHANNEL level fails config
  // validation outright — while the whole suite stays green, because nothing
  // else parses the shipped JSON. The key shipped with no test at all until
  // this block was added.
  it("accepts capabilities.reasoningDurable as a boolean, at channel level and per account", () => {
    expect(runtime.safeParse({ capabilities: { reasoningDurable: true } }).success).toBe(true);
    expect(runtime.safeParse({ capabilities: { reasoningDurable: false } }).success).toBe(true);
    // Coexists with BOTH siblings — the two reasoning keys are independent
    // switches and an operator will set them together.
    expect(
      runtime.safeParse({
        capabilities: { typing: "on", reasoning: true, reasoningDurable: true },
      }).success,
    ).toBe(true);
    // Named-account leaves are deliberately unvalidated, so the same shape must
    // pass there too.
    expect(
      runtime.safeParse({ accounts: { named: { capabilities: { reasoningDurable: true } } } })
        .success,
    ).toBe(true);
  });

  it("rejects malformed channel-level capabilities.reasoningDurable values", () => {
    // The stakes are higher than for the lane key: a truthy string that slipped
    // through would start writing plaintext to disk. The schema rejects it and
    // `resolveReasoningDurable` independently fails closed.
    for (const value of ["true", "on", "off", "false", 0, 1, null, {}, []]) {
      expect(
        runtime.safeParse({ capabilities: { reasoningDurable: value } }).success,
        `capabilities.reasoningDurable: ${JSON.stringify(value)} must be rejected`,
      ).toBe(false);
    }
  });

  describe("capabilities.reasoningDurable declares no schema default (#242 half 1)", () => {
    const hydrate = (value: unknown) => {
      const result = validateJsonSchemaValue({
        schema: manifest.channelConfigs.webchannel.schema as JsonSchemaObject,
        cacheKey: `webchannel-manifest-durable-default-${Math.random()}`,
        value,
        applyDefaults: true,
      });
      if (!result.ok) throw new Error(`unexpected validation failure: ${JSON.stringify(result.errors)}`);
      return result.value as { capabilities?: Record<string, unknown> };
    };

    it("does not materialize `reasoningDurable` when capabilities is absent or empty", () => {
      expect(hydrate({ enabled: true }).capabilities).toBeUndefined();
      expect(hydrate({ enabled: true, capabilities: {} })).not.toHaveProperty(
        "capabilities.reasoningDurable",
      );
    });

    it("does not materialize `reasoningDurable` when a SIBLING capability is set", () => {
      // Including the sibling an operator is most likely to set at the same
      // time: turning the LANE off must not write the DURABILITY key.
      const hydrated = hydrate({ enabled: true, capabilities: { reasoning: false } });
      expect(hydrated).not.toHaveProperty("capabilities.reasoningDurable");
      // `typing` IS materialized — it is the one capability that declares a
      // schema default, and the block above already records that as benign
      // (it hydrates to the value `resolveTypingEnabled` defaults to anyway).
      // Asserted verbatim rather than filtered, so a NEW hydrated default on
      // any sibling shows up here instead of hiding behind a narrow check.
      expect(hydrated.capabilities).toEqual({ reasoning: false, typing: "on" });
    });

    it("preserves an explicitly configured value of either polarity", () => {
      expect(hydrate({ enabled: true, capabilities: { reasoningDurable: true } }).capabilities)
        .toMatchObject({ reasoningDurable: true });
      expect(hydrate({ enabled: true, capabilities: { reasoningDurable: false } }).capabilities)
        .toMatchObject({ reasoningDurable: false });
    });

    it("hydrates to a config that resolveReasoningDurable still reads as OFF", () => {
      // Closes the loop the same way the lane block does, in the opposite
      // direction: the point of having no default is that the resolver's
      // absent-means-OFF branch stays REACHABLE after core writes the hydrated
      // config back. A schema default of `false` would look harmless and would
      // make this assertion pass for the wrong reason — so the two tests above
      // (no materialization) are what carry it, and this one proves the
      // consequence an operator experiences.
      expect(resolveReasoningDurable(hydrate({ enabled: true }))).toBe(false);
      expect(
        resolveReasoningDurable(hydrate({ enabled: true, capabilities: { reasoning: true } })),
      ).toBe(false);
      // And the opt-in survives hydration.
      expect(
        resolveReasoningDurable(
          hydrate({ enabled: true, capabilities: { reasoningDurable: true } }),
        ),
      ).toBe(true);
    });

    it("keeps the two reasoning keys independent through hydration", () => {
      const hydrated = hydrate({
        enabled: true,
        capabilities: { reasoning: false, reasoningDurable: true },
      });
      expect(resolveReasoningEnabled(hydrated)).toBe(false);
      expect(resolveReasoningDurable(hydrated)).toBe(true);
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
