import { describe, it, expect } from "vitest";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  isValidAccountId,
  assertValidAccountId,
  listWebchannelAccountIds,
  inspectWebchannelAccountIds,
  resolveWebchannelAccountConfig,
  resolveAcquisitionIdentity,
  resolveAccountNatsConfig,
  resolveTypingEnabled,
  resolveReasoningEnabled,
  resolveReasoningDurable,
  readAccountsMap,
  readWebchannelSection,
  accountCredentialPath,
  legacyCredentialPath,
  resolveReadCredentialPath,
  loadPersistedCredentialDocument,
} from "./account-config.js";
import { createCredentialIdentityForEnrollment } from "./credential-document.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { planAccounts } from "./multiplex.js";

const HOME = "/home/test";

describe("removed auth.ticketParam migration", () => {
  it("rejects the deprecated flat config through the NATS account planning seam", () => {
    const cfg = { channels: { webchannel: { auth: { strategy: "jwt", ticketParam: "ticket" } } } };
    expect(() => planAccounts(cfg, { env: {} })).toThrow(
      /removed config auth\.ticketParam.*openclaw channels add/s,
    );
  });

  it("rejects the deprecated named-account leaf through the NATS account planning seam", () => {
    const cfg = { channels: { webchannel: { accounts: { work: { auth: { ticketParam: "jwt" } } } } } };
    expect(() => planAccounts(cfg, { env: {} })).toThrow(
      /removed config auth\.ticketParam.*openclaw channels add/s,
    );
  });
});

describe("P0-2 removed config migration", () => {
  it.each([
    ["nats.devOpen", { nats: { devOpen: false } }],
    ['nats.admission="auto"', { nats: { admission: "auto" } }],
    ['nats.credentials.mode="open"', { nats: { credentials: { mode: "open" } } }],
    ['auth.strategy="anonymous"', { auth: { strategy: "anonymous" } }],
  ])("fails account resolution for %s", (setting, account) => {
    const cfg = { channels: { webchannel: account } };
    expect(() => resolveWebchannelAccountConfig(cfg, "default")).toThrow(
      new RegExp(`removed config ${setting.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`),
    );
  });
});

describe("account-config: account id validation (TRUST BOUNDARY)", () => {
  it("accepts safe ids", () => {
    for (const id of [
      "default",
      "acctA",
      "acct-1",
      "a_b-C9",
      "_a",
      "-a",
      "99-",
      "x".repeat(64),
    ]) {
      expect(isValidAccountId(id)).toBe(true);
    }
  });

  it("rejects traversal / illegal / blocked ids", () => {
    for (const id of [
      "../../tmp/evil",
      "..",
      "a/b",
      "a\\b",
      "a.b",
      "",
      "x".repeat(65),
      "__proto__",
      "constructor",
      "prototype",
    ]) {
      expect(isValidAccountId(id)).toBe(false);
    }
  });

  it("assertValidAccountId throws on a traversal id", () => {
    expect(() => assertValidAccountId("../../tmp/evil")).toThrow(/invalid account id/);
  });

  it("uses the SDK contract to collapse a traversal sequence to a safe id", () => {
    expect(normalizeAccountId("../../tmp/evil")).toBe("tmp-evil");
    expect(isValidAccountId(normalizeAccountId("../../tmp/evil"))).toBe(true);
  });

  it("keeps the plugin blocked-key policy aligned with the SDK contract", () => {
    expect(normalizeAccountId(undefined)).toBe("default");
    expect(normalizeAccountId("   ")).toBe("default");
    for (const id of [
      "__proto__",
      "prototype",
      "constructor",
      "__PROTO__",
      "Prototype",
      "CONSTRUCTOR",
    ]) {
      expect(isValidAccountId(id)).toBe(false);
      expect(normalizeAccountId(id)).toBe("default");
    }
  });

  it("keeps raw path safety separate from SDK identity normalization", () => {
    expect(normalizeAccountId("AcctA")).toBe("accta");
    expect(normalizeAccountId("acct-1")).toBe("acct-1");
    expect(normalizeAccountId("_a")).toBe("_a");
    expect(normalizeAccountId("-a")).toBe("a");
    expect(normalizeAccountId("99-")).toBe("99-");
  });
});

describe("account-config: resolveTypingEnabled (P0-6)", () => {
  it("defaults ON when capabilities is absent", () => {
    expect(resolveTypingEnabled({})).toBe(true);
    expect(resolveTypingEnabled({ capabilities: {} })).toBe(true);
  });

  it("ON for explicit typing:'on'", () => {
    expect(resolveTypingEnabled({ capabilities: { typing: "on" } })).toBe(true);
  });

  it("OFF only for explicit typing:'off'", () => {
    expect(resolveTypingEnabled({ capabilities: { typing: "off" } })).toBe(false);
  });

  it("honors an account override 'off' over a channel-level 'on' base (through the merge)", () => {
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { typing: "on" },
          accounts: {
            acctA: { capabilities: { typing: "off" } },
          },
        },
      },
    };
    expect(resolveTypingEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it("honors an account override 'on' over a channel-level 'off' base (through the merge)", () => {
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { typing: "off" },
          accounts: {
            acctA: { capabilities: { typing: "on" } },
          },
        },
      },
    };
    expect(resolveTypingEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(true);
  });

  it("inherits the channel-level base when the account omits capabilities (shared-base merge)", () => {
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { typing: "off" },
          accounts: { acctA: { tenant: "t" } },
        },
      },
    };
    expect(resolveTypingEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it("keeps the base typing:'off' when the account sets OTHER capabilities (nested merge, no clobber)", () => {
    // Locks `capabilities` staying in NESTED_OBJECT_KEYS: the account's
    // capabilities object must MERGE over the base, not replace it — dropping
    // that would silently regress typing:"off" back to being ignored.
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { typing: "off" },
          accounts: { acctA: { capabilities: { someOtherKey: "x" } } },
        },
      },
    };
    expect(resolveTypingEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });
});

describe("account-config: resolveReasoningEnabled (#113)", () => {
  it("defaults ON when the key is absent (capabilities missing or empty)", () => {
    // Decision ①: the consumer already ships the reasoning UI, so a deployment
    // that never hand-edited its config would otherwise render an empty
    // Reasoning shell on every turn — the exact symptom #113 removes.
    expect(resolveReasoningEnabled({})).toBe(true);
    expect(resolveReasoningEnabled({ capabilities: {} })).toBe(true);
    expect(resolveReasoningEnabled({ capabilities: { typing: "on" } })).toBe(true);
  });

  it("ON for explicit boolean true", () => {
    expect(resolveReasoningEnabled({ capabilities: { reasoning: true } })).toBe(true);
  });

  it("OFF for explicit false", () => {
    expect(resolveReasoningEnabled({ capabilities: { reasoning: false } })).toBe(false);
  });

  it("OFF for every PRESENT non-boolean-true value, including the string 'off'", () => {
    // Load-bearing, and it survives the default flip. The rule is
    // `absent → ON; present-and-not-true → OFF`, NOT `!== false`. Under `!== false`
    // the string "off" — the spelling an operator who copied `capabilities.typing`
    // reaches for first — is truthy and would KEEP the lane on, defeating the
    // operator's intent in the privacy-losing direction. Every present value that
    // is not boolean `true` must fail CLOSED. The JSON schema rejects these, but
    // the resolver must not depend on the schema having been applied (same rule
    // `resolveTypingEnabled` documents).
    for (const value of ["off", "on", "true", "false", 1, 0, {}, [], null, undefined]) {
      expect(
        resolveReasoningEnabled({ capabilities: { reasoning: value } }),
        `reasoning: ${JSON.stringify(value)} must resolve OFF`,
      ).toBe(false);
    }
  });

  it("fails closed for every present malformed capabilities container", () => {
    for (const capabilities of [null, "off", [], 0, 1, false, new Date(0)]) {
      expect(
        resolveReasoningEnabled({ capabilities }),
        `capabilities: ${String(capabilities)} must resolve OFF`,
      ).toBe(false);
    }
  });

  it("accepts plain capabilities objects, including null-prototype records", () => {
    const inheritedSafeRecord = Object.assign(Object.create(null), { reasoning: true });
    expect(resolveReasoningEnabled({ capabilities: {} })).toBe(true);
    expect(resolveReasoningEnabled({ capabilities: inheritedSafeRecord })).toBe(true);
  });

  it("honors an account override false over an unset channel-level base (through the merge)", () => {
    // Asserts the OFF direction on purpose. With the default now ON, an
    // account override of `true` over an unset base would pass even if the merge
    // dropped the key entirely — a false green. Only the `false` override can
    // distinguish "the merge carried my value" from "the default happened to
    // agree with me". Every merge case below is written the same way.
    const cfg = {
      channels: {
        webchannel: {
          accounts: { acctA: { capabilities: { reasoning: false } } },
        },
      },
    };
    expect(resolveReasoningEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it("honors an account override false over a channel-level true base (through the merge)", () => {
    // One noisy account can be silenced without disarming the deployment.
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { reasoning: true },
          accounts: { acctA: { capabilities: { reasoning: false } } },
        },
      },
    };
    expect(resolveReasoningEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it("inherits the channel-level base when the account omits capabilities (shared-base merge)", () => {
    // Base OFF, account silent: the deployment-wide opt-OUT must reach the
    // account. A merge that dropped the base would fall back to the ON default
    // and leak reasoning to every account that did not restate it.
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { reasoning: false },
          accounts: { acctA: { tenant: "t" } },
        },
      },
    };
    expect(resolveReasoningEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it("keeps a base reasoning:false when the account sets OTHER capabilities (nested merge, no clobber)", () => {
    // Locks `capabilities` staying in NESTED_OBJECT_KEYS, same as the typing
    // case above: an account touching a SIBLING capability must not silently
    // drop the deployment's reasoning opt-out and re-enable the lane by default.
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { reasoning: false },
          accounts: { acctA: { capabilities: { typing: "off" } } },
        },
      },
    };
    expect(resolveReasoningEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it.each([null, "off", [], 0, false] as const)(
    "keeps an inherited base opt-out closed when a named account replaces capabilities with %s",
    (capabilities) => {
      const cfg = {
        channels: {
          webchannel: {
            capabilities: { reasoning: false },
            accounts: { acctA: { capabilities } },
          },
        },
      };
      expect(resolveReasoningEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
    },
  );

  it("lets a malformed named-account container fail closed over a channel-level true", () => {
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { reasoning: true },
          accounts: { acctA: { capabilities: "off" } },
        },
      },
    };
    expect(resolveReasoningEnabled(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it("is independent of capabilities.typing in both directions", () => {
    // Both now default ON, so the two resolvers agree on an absent key and this
    // no longer discriminates by default alone. What it locks is that each reads
    // its OWN key: setting one must not move the other off its default, and the
    // two disagree on how a PRESENT string is read (typing accepts "on"/"off",
    // reasoning fails closed on both).
    expect(resolveReasoningEnabled({ capabilities: { typing: "off" } })).toBe(true);
    expect(resolveTypingEnabled({ capabilities: { reasoning: false } })).toBe(true);
    expect(resolveReasoningEnabled({ capabilities: { reasoning: "on" } })).toBe(false);
    expect(resolveTypingEnabled({ capabilities: { typing: "on" } })).toBe(true);
  });
});

describe("account-config: resolveReasoningDurable (#242 half 1)", () => {
  it("defaults OFF when the key is absent — container missing, empty, or unrelated", () => {
    // ⚠️ THE OPPOSITE DEFAULT TO `resolveReasoningEnabled` NEXT DOOR, ON
    // PURPOSE. #113's default-ON was a decision to render a volatile live lane,
    // and it does not inherit to a decision to permanently record plaintext to
    // disk. The lane is drawn and forgotten; the journal is plaintext that
    // nothing ages out (#299 unshipped) and that no client can read back until
    // #242 half 2 — cost with no benefit, so it takes the reversible direction.
    expect(resolveReasoningDurable({})).toBe(false);
    expect(resolveReasoningDurable({ capabilities: {} })).toBe(false);
    expect(resolveReasoningDurable({ capabilities: { typing: "on" } })).toBe(false);
    // The neighbouring key does NOT open it — the whole point of the split.
    expect(resolveReasoningDurable({ capabilities: { reasoning: true } })).toBe(false);
  });

  it("ON only for explicit boolean true", () => {
    expect(resolveReasoningDurable({ capabilities: { reasoningDurable: true } })).toBe(true);
  });

  it("OFF for explicit false", () => {
    expect(resolveReasoningDurable({ capabilities: { reasoningDurable: false } })).toBe(false);
  });

  it("OFF for every PRESENT non-boolean-true value, the string 'true' included", () => {
    // Same fail-closed rule as `resolveReasoningEnabled`, and it matters MORE
    // here: a truthiness read would let the string "true" — or "on", copied from
    // `capabilities.typing` — silently start writing plaintext to disk.
    for (const value of ["true", "on", "off", "false", 1, 0, {}, [], null, undefined]) {
      expect(
        resolveReasoningDurable({ capabilities: { reasoningDurable: value } }),
        `reasoningDurable: ${JSON.stringify(value)} must resolve OFF`,
      ).toBe(false);
    }
  });

  it("fails closed for every malformed capabilities container", () => {
    for (const capabilities of [null, "off", [], 0, 1, false, true, new Date(0)]) {
      expect(
        resolveReasoningDurable({ capabilities }),
        `capabilities: ${String(capabilities)} must resolve OFF`,
      ).toBe(false);
    }
  });

  it("refuses a value reachable only through the PROTOTYPE CHAIN", () => {
    // ⚠️ THIS IS THE OWN-PROPERTY TEST'S WORK, NOT THE PROTOTYPE CHECK'S, AND THE
    // TWO ARE EASY TO MISATTRIBUTE — an earlier revision of
    // `resolveReasoningDurable`'s docblock credited the prototype check with
    // exactly this and was wrong. Measured against the counterfactual: with the
    // prototype check DELETED, every case below still resolves `false`. What the
    // prototype check actually contributes is the separate case at the end of
    // this file's next test — an OWN-property opt-in on a non-plain object.
    //
    // (a) a CLASS instance whose prototype declares the key.
    class Capabilities {}
    (Capabilities.prototype as { reasoningDurable?: boolean }).reasoningDurable = true;
    expect(resolveReasoningDurable({ capabilities: new Capabilities() })).toBe(false);

    // (b) a plain object INHERITING it from a poisoned Object.prototype. The
    //     prototype check passes here (it IS Object.prototype), so this case is
    //     carried entirely by the OWN-property test.
    const proto = Object.prototype as { reasoningDurable?: boolean };
    try {
      proto.reasoningDurable = true;
      expect(resolveReasoningDurable({ capabilities: {} })).toBe(false);
      // Non-vacuity: the poison really is reachable by a bare property read,
      // so the assertion above is about the guard and not about an empty object.
      expect(({} as { reasoningDurable?: boolean }).reasoningDurable).toBe(true);
    } finally {
      delete proto.reasoningDurable;
    }
    expect(({} as { reasoningDurable?: boolean }).reasoningDurable).toBeUndefined();
  });

  it("refuses an OWN-property opt-in on a NON-PLAIN object — the prototype check's only job", () => {
    // ⚠️ THE ONE BEHAVIOUR THE PROTOTYPE CHECK CONTRIBUTES, ISOLATED. Deleting
    // that check flips THIS case to `true` and leaves every other case in this
    // file unchanged — which is how its real job was identified.
    //
    // The reason to keep it is a shape argument, not an inheritance one: config
    // is JSON, so a class instance cannot have come from a parsed config file,
    // and a switch that turns on plaintext-at-rest should refuse a container it
    // has no model of rather than honour a key it happens to carry.
    class Capabilities {
      reasoningDurable = true;
    }
    expect(resolveReasoningDurable({ capabilities: new Capabilities() })).toBe(false);
    // Same shape, same verdict, via other non-plain prototypes.
    expect(resolveReasoningDurable({ capabilities: Object.assign(new Date(0), { reasoningDurable: true }) })).toBe(false);
    expect(resolveReasoningDurable({ capabilities: Object.assign(new Map(), { reasoningDurable: true }) })).toBe(false);
  });

  it("accepts a null-prototype record carrying the key as an OWN property", () => {
    // `Object.create(null)` is the safest plain record there is and is what a
    // hardened config loader produces, so a null prototype is ACCEPTED. What the
    // check refuses is a prototype that could carry keys.
    const record = Object.assign(Object.create(null), { reasoningDurable: true });
    expect(resolveReasoningDurable({ capabilities: record })).toBe(true);
    expect(resolveReasoningDurable({ capabilities: Object.create(null) })).toBe(false);
  });

  it("carries a channel-level opt-in down to an account that omits capabilities", () => {
    // The ON direction is the meaningful one here (mirror image of the reasoning
    // suite): with the default OFF, only a `true` that survives the merge can
    // distinguish "the merge carried my value" from "the default agreed".
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { reasoningDurable: true },
          accounts: { acctA: { tenant: "t" } },
        },
      },
    };
    expect(resolveReasoningDurable(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(true);
  });

  it("lets one account opt out of a channel-level opt-in", () => {
    const cfg = {
      channels: {
        webchannel: {
          capabilities: { reasoningDurable: true },
          accounts: { acctA: { capabilities: { reasoningDurable: false } } },
        },
      },
    };
    expect(resolveReasoningDurable(resolveWebchannelAccountConfig(cfg, "acctA"))).toBe(false);
  });

  it("#242 half 2: the diagnostic's trigger is exactly `durable && !enabled`", () => {
    // The predicate `nats-account-runtime.ts` warns on, pinned as a pure
    // function of config so the wiring guard in `index-nats-wiring.test.ts` only
    // has to check WHERE it is read, never WHAT it decides. It fires on the one
    // combination that records zero rows for an operator who asked for rows —
    // and stays silent on the shipped default (lane on, durable off), which is
    // fully supported and must never warn.
    const triggers = (capabilities: unknown): boolean =>
      resolveReasoningDurable({ capabilities } as Parameters<typeof resolveReasoningDurable>[0]) &&
      !resolveReasoningEnabled({ capabilities } as Parameters<typeof resolveReasoningEnabled>[0]);

    expect(triggers({ reasoning: false, reasoningDurable: true })).toBe(true);
    expect(triggers({ reasoning: "off", reasoningDurable: true })).toBe(true);
    // Silent everywhere else, including both defaults.
    expect(triggers({ reasoning: true, reasoningDurable: true })).toBe(false);
    expect(triggers({})).toBe(false);
    expect(triggers({ reasoning: false })).toBe(false);
    expect(triggers(undefined)).toBe(false);
  });

  it("is independent of capabilities.reasoning in BOTH directions", () => {
    // The split, stated as a property: neither key moves the other off its own
    // default. A future refactor that folds them back into one switch fails here.
    expect(resolveReasoningEnabled({ capabilities: { reasoningDurable: true } })).toBe(true);
    expect(resolveReasoningDurable({ capabilities: { reasoning: true } })).toBe(false);
    expect(resolveReasoningEnabled({ capabilities: { reasoning: false, reasoningDurable: true } })).toBe(false);
    expect(resolveReasoningDurable({ capabilities: { reasoning: false, reasoningDurable: true } })).toBe(true);
  });
});

describe("account-config: listWebchannelAccountIds", () => {
  function expectNormalizedCollision(ids: readonly string[], normalized: string): void {
    const cfg = {
      channels: {
        webchannel: {
          accounts: Object.fromEntries(ids.map((id) => [id, { tenant: "t" }])),
        },
      },
    };
    const inspection = inspectWebchannelAccountIds(cfg);

    expect(inspection.validIds).toEqual([]);
    expect(inspection.usesImplicitDefault).toBe(false);
    expect(inspection.invalid.map(({ id }) => id)).toEqual(
      [...ids].sort((a, b) => a.localeCompare(b)),
    );
    for (const { reason, reasonKind } of inspection.invalid) {
      expect(reasonKind).toBe("normalized-collision");
      expect(reason).toContain(JSON.stringify(normalized));
      for (const id of ids) expect(reason).toContain(JSON.stringify(id));
    }
    expect(planAccounts(cfg, { env: {} })).toEqual([]);
  }

  it("rejects a case-fold collision and identifies both configured ids (#135)", () => {
    expectNormalizedCollision(["Acme", "acme"], "acme");
  });

  it("rejects an invalid-character replacement collision (#135)", () => {
    expectNormalizedCollision(["a.b", "a-b"], "a-b");
  });

  it("rejects a whitespace-trimming collision (#135)", () => {
    expectNormalizedCollision([" acme", "acme "], "acme");
  });

  it("rejects a 64-character clamp collision (#135)", () => {
    const sharedPrefix = "a".repeat(64);
    expectNormalizedCollision([`${sharedPrefix}x`, `${sharedPrefix}y`], sharedPrefix);
  });

  it.each([
    ["99", "99-"],
    ["a", "a-"],
    ["x-y", "x-y-"],
  ])(
    "serves %s and %s as distinct SDK identities (#135 false-positive guard)",
    (left, right) => {
      const cfg = {
        channels: {
          webchannel: {
            accounts: {
              [left]: { tenant: "t" },
              [right]: { tenant: "t" },
            },
          },
        },
      };

      expect(inspectWebchannelAccountIds(cfg)).toEqual({
        validIds: [left, right].sort((a, b) => a.localeCompare(b)),
        invalid: [],
        usesImplicitDefault: false,
      });
      expect(planAccounts(cfg, { env: {} }).map(({ accountId }) => accountId)).toEqual(
        [left, right].sort((a, b) => a.localeCompare(b)),
      );
    },
  );

  it("isolates invalid raw keys and does not synthesize default for an explicit all-invalid map", () => {
    const mixed = { channels: { webchannel: { accounts: { good: {}, "bad.id": {}, constructor: {}, Zed: {} } } } };
    expect(inspectWebchannelAccountIds(mixed)).toEqual({
      validIds: ["good", "Zed"].sort((a, b) => a.localeCompare(b)),
      invalid: [
        {
          id: "bad.id",
          reason: "the id must match /^[A-Za-z0-9_-]{1,64}$/",
          reasonKind: "invalid-format",
        },
        {
          id: "constructor",
          reason: "the id is a blocked prototype key",
          reasonKind: "blocked-prototype-key",
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
      usesImplicitDefault: false,
    });
    expect(listWebchannelAccountIds({ channels: { webchannel: { accounts: { "../bad": {} } } } })).toEqual([]);
  });
  it("synthesizes default when there is no webchannel section", () => {
    expect(listWebchannelAccountIds({ channels: {} })).toEqual([DEFAULT_WEBCHANNEL_ACCOUNT_ID]);
    expect(listWebchannelAccountIds({})).toEqual([DEFAULT_WEBCHANNEL_ACCOUNT_ID]);
  });

  it("returns default for a flat single-account config", () => {
    const cfg = { channels: { webchannel: { auth: { strategy: "jwt" }, allowFrom: ["a"] } } };
    expect(listWebchannelAccountIds(cfg)).toEqual([DEFAULT_WEBCHANNEL_ACCOUNT_ID]);
  });

  it("returns default for an empty webchannel object", () => {
    expect(listWebchannelAccountIds({ channels: { webchannel: {} } })).toEqual([
      DEFAULT_WEBCHANNEL_ACCOUNT_ID,
    ]);
  });

  it("returns default when the accounts map is PRESENT but empty, even with channel-level fields", () => {
    const cfg = {
      channels: { webchannel: { auth: { strategy: "jwt" }, accounts: {} } },
    };
    expect(listWebchannelAccountIds(cfg)).toEqual([DEFAULT_WEBCHANNEL_ACCOUNT_ID]);
  });

  it("lists accounts-map children", () => {
    const cfg = {
      channels: { webchannel: { accounts: { acctA: { auth: {} }, acctB: { allowFrom: [] } } } },
    };
    expect(listWebchannelAccountIds(cfg)).toEqual(["acctA", "acctB"]);
  });

  it("treats channel-level base as shared base only — no implicit default beside named accounts", () => {
    const cfg = {
      channels: { webchannel: { auth: { strategy: "jwt" }, accounts: { acctB: {} } } },
    };
    expect(listWebchannelAccountIds(cfg)).toEqual(["acctB"]);
  });

  it("honors an explicit `default` account in the accounts map", () => {
    const cfg = { channels: { webchannel: { accounts: { default: { auth: {} }, acctB: {} } } } };
    expect(listWebchannelAccountIds(cfg)).toEqual(["acctB", "default"]);
  });

  it("does NOT conjure a phantom default from channel-level shared tuning keys (issue #17)", () => {
    const cfg = {
      channels: {
        webchannel: { accounts: { for_work: {} }, streaming: { mode: "progress" } },
      },
    };
    expect(listWebchannelAccountIds(cfg)).toEqual(["for_work"]);
  });
});

describe("account-config: resolveWebchannelAccountConfig (base merge)", () => {
  it("returns the flat block AS the default account (backward compat)", () => {
    const cfg = { channels: { webchannel: { allowFrom: ["a"], dmSecurity: "allowlist" } } };
    const acct = resolveWebchannelAccountConfig(cfg, "default");
    expect(acct.allowFrom).toEqual(["a"]);
    expect(acct.dmSecurity).toBe("allowlist");
  });

  it("merges channel-level base UNDER a named account override", () => {
    const cfg = {
      channels: {
        webchannel: {
          auth: { strategy: "jwt" },
          allowFrom: ["base"],
          accounts: { acctB: { allowFrom: ["b"], agentId: "agentB" } },
        },
      },
    };
    const acct = resolveWebchannelAccountConfig(cfg, "acctB");
    expect(acct.allowFrom).toEqual(["b"]);
    expect(acct.auth).toEqual({ strategy: "jwt" });
    expect(acct.agentId).toBe("agentB");
  });

  it("shallow-merges nested object keys (nats.url base + nats.credentials override)", () => {
    const cfg = {
      channels: {
        webchannel: {
          nats: { url: "ws://base" },
          accounts: { acctB: { nats: { credentials: { mode: "enrolled" } } } },
        },
      },
    };
    const acct = resolveWebchannelAccountConfig(cfg, "acctB");
    expect(acct.nats).toEqual({ url: "ws://base", credentials: { mode: "enrolled" } });
  });

  it("does NOT leak the accounts map into the resolved account", () => {
    const cfg = { channels: { webchannel: { auth: {}, accounts: { acctB: {} } } } };
    const acct = resolveWebchannelAccountConfig(cfg, "default");
    expect(acct.accounts).toBeUndefined();
  });

  it("returns base for a missing named account (inherits shared base only)", () => {
    const cfg = { channels: { webchannel: { auth: { strategy: "jwt" }, accounts: { acctA: {} } } } };
    expect(resolveWebchannelAccountConfig(cfg, "nope")).toEqual({ auth: { strategy: "jwt" } });
  });
});

describe("account-config: readWebchannelSection / readAccountsMap / resolveAccountNatsConfig", () => {
  it("reads the section", () => {
    const cfg = { channels: { webchannel: { nats: { url: "ws://x" } } } };
    expect(readWebchannelSection(cfg)).toEqual({ nats: { url: "ws://x" } });
  });

  it("reads the accounts map", () => {
    const cfg = { channels: { webchannel: { accounts: { a: { x: 1 } } } } };
    expect(readAccountsMap(readWebchannelSection(cfg))).toEqual({ a: { x: 1 } });
  });

  it("rejects a merged per-account devOpen fixture", () => {
    const cfg = {
      channels: { webchannel: { nats: { url: "ws://base" }, accounts: { acctA: { nats: { devOpen: true } } } } },
    };
    expect(() => resolveAccountNatsConfig(cfg, "acctA")).toThrow(/removed config nats.devOpen/);
  });

  it("reads flat nats config for default", () => {
    const cfg = { channels: { webchannel: { nats: { url: "ws://flat" } } } };
    expect(resolveAccountNatsConfig(cfg, "default")).toEqual({ url: "ws://flat" });
  });
});

describe("account-config: resolveAcquisitionIdentity", () => {
  it("reads per-account identity from the accounts map", () => {
    const cfg = {
      channels: {
        webchannel: {
          accounts: { acctA: { tenant: "tA", saas: { baseUrl: "http://s" } } },
        },
      },
    };
    expect(resolveAcquisitionIdentity(cfg, "acctA")).toEqual({
      accountId: "acctA",
      tenant: "tA",
      saasBaseUrl: "http://s",
    });
  });

  it("falls back to top-level cfg for the default account only", () => {
    const cfg = {
      tenant: "topTenant",
      saas: { baseUrl: "http://top" },
      channels: { webchannel: { allowFrom: ["a"] } },
    };
    expect(resolveAcquisitionIdentity(cfg, "default")).toEqual({
      accountId: "default",
      tenant: "topTenant",
      saasBaseUrl: "http://top",
    });
  });

  it("does NOT use top-level fallback for a non-default account with no own identity", () => {
    const cfg = {
      tenant: "topTenant",
      channels: { webchannel: { accounts: { acctB: {} } } },
    };
    const id = resolveAcquisitionIdentity(cfg, "acctB");
    expect(id.tenant).toBe("default-tenant");
    // accountId is the wire identity (가-2); the handling agent is a bind concern.
    expect(id.accountId).toBe("acctB");
    expect(id.saasBaseUrl).toBeUndefined();
  });

  it("defaults to the historical literals when nothing is configured", () => {
    expect(resolveAcquisitionIdentity({}, "default")).toEqual({
      accountId: "default",
      tenant: "default-tenant",
      saasBaseUrl: undefined,
    });
  });
});

describe("account-config: credential paths", () => {
  it("rejects account-less path reads at the API boundary", () => {
    expect(() => (accountCredentialPath as unknown as () => string)()).toThrow(
      /storage identity/,
    );
  });
  it("builds the opaque tuple-scoped path", () => {
    expect(
      accountCredentialPath(
        { tenant: "tenant-a", accountId: "acctA" },
        { home: HOME },
      ),
    ).toMatch(
      new RegExp(
        `^${HOME}/\\.openclaw-webchannel-v2/v2_[A-Za-z0-9_-]{43}/credentials\\.json$`,
      ),
    );
  });

  it("REJECTS a traversal account id before building a path (security)", () => {
    expect(() =>
      accountCredentialPath(
        { tenant: "tenant-a", accountId: "../../tmp/evil" },
        { home: HOME },
      ),
    ).toThrow(/storage\.accountId/);
  });

  it("builds the legacy path", () => {
    expect(legacyCredentialPath(HOME)).toBe(
      join(HOME, ".openclaw-webchannel", "credentials.json"),
    );
  });

  it("resolveReadCredentialPath prefers the per-account file when it exists", () => {
    const scope = { tenant: "tenant-a", accountId: "default" };
    const perAccount = accountCredentialPath(scope, { home: HOME });
    const path = resolveReadCredentialPath(scope, {
      home: HOME,
      exists: (p) => p === perAccount,
    });
    expect(path).toBe(perAccount);
  });

  it("resolveReadCredentialPath ignores the legacy file for default", () => {
    const legacy = legacyCredentialPath(HOME);
    const scope = { tenant: "tenant-a", accountId: "default" };
    const perAccount = accountCredentialPath(scope, { home: HOME });
    const path = resolveReadCredentialPath(scope, {
      home: HOME,
      exists: (p) => p === legacy,
    });
    expect(path).toBe(perAccount);
  });

  it("resolveReadCredentialPath does NOT use legacy for a non-default account", () => {
    const legacy = legacyCredentialPath(HOME);
    const scope = { tenant: "tenant-a", accountId: "acctA" };
    const perAccount = accountCredentialPath(scope, { home: HOME });
    const path = resolveReadCredentialPath(scope, {
      home: HOME,
      exists: (p) => p === legacy, // only legacy exists
    });
    expect(path).toBe(perAccount);
  });

  it("resolveReadCredentialPath returns the per-account path when nothing exists", () => {
    const scope = { tenant: "tenant-a", accountId: "default" };
    const path = resolveReadCredentialPath(scope, { home: HOME, exists: () => false });
    expect(path).toBe(accountCredentialPath(scope, { home: HOME }));
  });

  it("resolveReadCredentialPath rejects a traversal id", () => {
    expect(() =>
      resolveReadCredentialPath(
        { tenant: "tenant-a", accountId: "../../evil" },
        { home: HOME, exists: () => false },
      ),
    ).toThrow(/storage\.accountId/);
  });
});

describe("account-config: loadPersistedCredentialDocument", () => {
  const pair = generateKeyPair();
  const key = Buffer.from(pair.publicKey).toString("base64url");
  const privateKey = Buffer.from(pair.privateKey).toString("base64url");
  const expected = {
    tenant: "tenant-a",
    accountId: "acctA",
    saasBaseUrl: "https://saas.example",
  };
  const validFile = JSON.stringify({
    credentialIdentity: createCredentialIdentityForEnrollment({
      ...expected,
      deliveredIssuer: "https://issuer.example/",
      relayUrl: "wss://relay.example",
      agentPublicKey: key,
    }),
    identityKey: { publicKey: key, privateKey },
    enrollment: {
      creds: { userJwt: "JWT", userSeed: "SEED" },
      peerId: "peer-a",
      jwksUrl: "https://keys.example/jwks",
      bootstrapUrl: "https://bootstrap.example",
      issuer: "https://issuer.example/",
      natsUrl: "wss://relay.example",
    },
    tenant: expected.tenant,
    accountId: expected.accountId,
    saasEnrollUrl: `${expected.saasBaseUrl}/api/enroll`,
    saasPollUrl: `${expected.saasBaseUrl}/api/poll`,
  });

  it("loads only a complete matching per-account document", () => {
    const perAccount = accountCredentialPath(expected, { home: HOME });
    const result = loadPersistedCredentialDocument(expected, {
      home: HOME,
      read: (path) => {
        expect(path).toBe(perAccount);
        return validFile;
      },
    });
    expect(result.status).toBe("match");
    if (result.status === "match") {
      expect(result.credentials).toMatchObject({
        userJwt: "JWT",
        userSeed: "SEED",
        issuer: "https://issuer.example/",
        natsUrl: "wss://relay.example",
      });
      expect(result.credentials.identityKey!.publicKey).toHaveLength(32);
    }
  });

  it("upgrades a complete owned v1 exact override before returning secrets", () => {
    const home = mkdtempSync(join(tmpdir(), "webchannel-exact-v1-load-"));
    try {
      const credentialPath = join(home, "operator", "account.json");
      mkdirSync(dirname(credentialPath), { recursive: true });
      const legacy = JSON.parse(validFile) as Record<string, unknown>;
      delete legacy.credentialIdentity;
      writeFileSync(credentialPath, JSON.stringify(legacy), { mode: 0o600 });

      const loaded = loadPersistedCredentialDocument(expected, {
        home,
        credentialPath,
      });

      expect(loaded.status).toBe("match");
      expect(
        JSON.parse(readFileSync(credentialPath, "utf8")),
      ).toHaveProperty("credentialIdentity");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores the legacy single-file path and distinguishes absence", () => {
    const legacy = legacyCredentialPath(HOME);
    const reads: string[] = [];
    expect(loadPersistedCredentialDocument({
      ...expected,
      accountId: "default",
    }, {
      home: HOME,
      read: (path) => {
        reads.push(path);
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    })).toEqual({ status: "absent" });
    expect(reads).toEqual([
      accountCredentialPath(
        { tenant: expected.tenant, accountId: "default" },
        { home: HOME },
      ),
    ]);
    expect(reads).not.toContain(legacy);
  });

  it("distinguishes malformed JSON without exposing its contents", () => {
    const perAccount = accountCredentialPath(expected, { home: HOME });
    expect(loadPersistedCredentialDocument(expected, {
      home: HOME,
      read: (path) => {
        expect(path).toBe(perAccount);
        return "not-json SECRET";
      },
    })).toEqual({
      status: "invalid",
      code: "invalid-json",
      fields: [],
    });
  });

  it("distinguishes an unreadable existing file without exposing the I/O error", () => {
    const perAccount = accountCredentialPath(expected, { home: HOME });
    expect(loadPersistedCredentialDocument(expected, {
      home: HOME,
      read: (path) => {
        expect(path).toBe(perAccount);
        throw Object.assign(new Error("SECRET filesystem detail"), {
          code: "EACCES",
        });
      },
    })).toEqual({
      status: "invalid",
      code: "read-failed",
      fields: [],
    });
  });

  it("classifies a dangling credential symlink as read-failed", () => {
    const home = mkdtempSync(join(tmpdir(), "webchannel-dangling-credential-"));
    try {
      const path = accountCredentialPath(expected, { home });
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(join(home, "missing-target"), path);
      expect(loadPersistedCredentialDocument(expected, { home })).toEqual({
        status: "invalid",
        code: "read-failed",
        fields: [],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("classifies a dangling parent-component symlink as read-failed", () => {
    const home = mkdtempSync(join(tmpdir(), "webchannel-dangling-parent-"));
    try {
      const path = accountCredentialPath(expected, { home });
      mkdirSync(dirname(dirname(path)), { recursive: true });
      symlinkSync(join(home, "missing-account-dir"), dirname(path));
      expect(loadPersistedCredentialDocument(expected, { home })).toEqual({
        status: "invalid",
        code: "read-failed",
        fields: [],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps genuinely missing normal directories classified as absent", () => {
    const home = mkdtempSync(join(tmpdir(), "webchannel-missing-credential-"));
    try {
      expect(loadPersistedCredentialDocument(expected, { home })).toEqual({
        status: "absent",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("validates effective tenant/SaaS identity before consulting the filesystem", () => {
    let consulted = false;
    expect(() => loadPersistedCredentialDocument({
      ...expected,
      tenant: "tenant.with.dot",
    }, {
      home: HOME,
      read: () => {
        consulted = true;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    })).toThrow(/storage identity invalid-field/);
    expect(consulted).toBe(false);
  });

  it("rejects a traversal account id", () => {
    expect(() => loadPersistedCredentialDocument({
      ...expected,
      accountId: "../../evil",
    }, { home: HOME })).toThrow(/storage\.accountId/);
  });
});
