/**
 * P0-3 — the command catalog is built from the LIVE native-command registry
 * (config-filtered, alias-free, name-sorted), never a hard-coded array. These
 * tests run against the REAL registry so a drift in the registry's shape (name
 * with/without slash, arg mapping) is caught here.
 */

import { describe, it, expect } from "vitest";

import { buildCommandCatalog } from "./commands-catalog.js";

describe("P0-3 — buildCommandCatalog (real registry)", () => {
  const catalog = buildCommandCatalog({});
  const names = catalog.map((c) => c.name);

  it("returns entries including the core session commands", () => {
    expect(catalog.length).toBeGreaterThan(0);
    // The acceptance set the widget must be able to surface.
    expect(names).toContain("help");
    expect(names.includes("new") || names.includes("reset")).toBe(true);
    expect(names).toContain("model");
  });

  it("names are WITHOUT a leading slash (the widget renders `/name`)", () => {
    expect(names.every((n) => !n.startsWith("/"))).toBe(true);
  });

  it("drops alias entries", () => {
    // The registry marks aliases with `isAlias: true`; none should survive. We
    // can't see the flag on the wire entry, so assert indirectly: every entry
    // has a non-empty name and there are no duplicate names (aliases duplicate a
    // canonical command's identity).
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is stable-sorted by name", () => {
    const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(names).toEqual(sorted);
  });

  it("maps args when a command declares them (e.g. /model takes a model arg)", () => {
    const model = catalog.find((c) => c.name === "model");
    expect(model).toBeDefined();
    expect(model?.args && model.args.length).toBeGreaterThan(0);
    expect(model?.args?.[0].name).toBe("model");
  });

  it("omits args for a no-arg command", () => {
    const help = catalog.find((c) => c.name === "help");
    expect(help).toBeDefined();
    expect(help?.args).toBeUndefined();
  });

  it("carries static arg choices as a plain string[] (JSON-serializable)", () => {
    // At least one registry command has an arg with a static choice list
    // (e.g. /tools mode compact|verbose). Find any and assert the shape.
    const withChoices = catalog
      .flatMap((c) => c.args ?? [])
      .find((a) => Array.isArray(a.choices) && a.choices.length > 0);
    expect(withChoices).toBeDefined();
    expect(withChoices?.choices?.every((v) => typeof v === "string")).toBe(true);
  });

  it("produces a JSON-round-trippable catalog (no functions leaked from choice providers)", () => {
    expect(() => JSON.parse(JSON.stringify(catalog))).not.toThrow();
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });
});
