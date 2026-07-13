import { describe, it, expect } from "vitest";

import { filterCommandCatalog } from "./command-filter.js";
import type { CommandCatalogEntry } from "./types.js";

const CATALOG: CommandCatalogEntry[] = [
  { name: "fast", description: "Toggle fast mode." },
  { name: "help", description: "Show available commands." },
  { name: "model", description: "Show or set the model." },
  { name: "new", description: "Start a new session." },
  { name: "reset", description: "Reset the session." },
];

describe("P0-3 — filterCommandCatalog", () => {
  it("`/` alone returns the whole catalog (menu just opened)", () => {
    expect(filterCommandCatalog(CATALOG, "/")).toEqual(CATALOG);
  });

  it("`/he` prefix-matches help", () => {
    expect(filterCommandCatalog(CATALOG, "/he").map((c) => c.name)).toEqual(["help"]);
  });

  it("`/x` matches nothing", () => {
    expect(filterCommandCatalog(CATALOG, "/x")).toEqual([]);
  });

  it("a non-slash input hides the menu (empty)", () => {
    expect(filterCommandCatalog(CATALOG, "hello")).toEqual([]);
    expect(filterCommandCatalog(CATALOG, "")).toEqual([]);
  });

  it("a space after the command name stops suggesting (typing args now)", () => {
    expect(filterCommandCatalog(CATALOG, "/model ")).toEqual([]);
    expect(filterCommandCatalog(CATALOG, "/model gpt")).toEqual([]);
  });

  it("is case-insensitive on the prefix", () => {
    expect(filterCommandCatalog(CATALOG, "/MO").map((c) => c.name)).toEqual(["model"]);
  });

  it("returns [] for an undefined/absent catalog (not yet loaded)", () => {
    expect(filterCommandCatalog(undefined, "/he")).toEqual([]);
  });

  it("matches multiple commands sharing a prefix, preserving catalog order", () => {
    const catalog: CommandCatalogEntry[] = [
      { name: "new", description: "" },
      { name: "name", description: "" },
      { name: "help", description: "" },
    ];
    expect(filterCommandCatalog(catalog, "/n").map((c) => c.name)).toEqual(["new", "name"]);
  });
});
