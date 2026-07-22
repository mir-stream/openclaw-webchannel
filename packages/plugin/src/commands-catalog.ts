/**
 * P0-3 — slash-command DISCOVERY catalog.
 *
 * Command EXECUTION already works on this surface (text slash-commands are
 * routed by core). What was missing is discovery: the browser had no way to
 * know which commands exist, so typing `/` showed nothing. This module builds
 * the catalog the agent delivers to the widget (via the `commands` NATS frame).
 *
 * The catalog is derived from the LIVE native-command registry, filtered by the
 * account's resolved config (`listNativeCommandSpecsForConfig`) — never a
 * hard-coded array. So a command gated off for this deployment is absent from
 * the menu, and new core commands appear without touching this plugin.
 */

import { listNativeCommandSpecsForConfig } from "openclaw/plugin-sdk/native-command-registry";

/**
 * One positional argument of a command, trimmed to exactly what the widget
 * typeahead needs to render/insert it. Deliberately a SUBSET of the registry's
 * `CommandArgDefinition` (no `type`, `preferAutocomplete`, choice-provider
 * functions, …) so the wire frame stays small and JSON-serializable.
 */
export type CommandCatalogArg = {
  name: string;
  description?: string;
  required?: boolean;
  /**
   * The allowed values, present only when the registry declares a STATIC choice
   * list. A dynamic choice PROVIDER (a function) is not serializable, so it is
   * dropped here — the widget just offers free text for that arg.
   */
  choices?: string[];
};

/**
 * One command as delivered to the browser. `name` is WITHOUT a leading slash
 * (the registry's own shape); the widget renders it as `/${name}`.
 */
export type CommandCatalogEntry = {
  name: string;
  description: string;
  args?: CommandCatalogArg[];
};

/**
 * Normalize a registry arg's `choices` to a plain `string[]`, or `undefined`
 * when there are none / they are provided dynamically (a function — not
 * serializable). A choice may be a bare string or a `{ value, label }` pair;
 * the widget only inserts the value, so we keep values.
 */
function normalizeChoices(choices: unknown): string[] | undefined {
  if (!Array.isArray(choices)) return undefined;
  const values = choices.map((c) =>
    typeof c === "string" ? c : (c as { value?: string })?.value ?? "",
  );
  const nonEmpty = values.filter((v) => v.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : undefined;
}

/** Map registry args to the trimmed wire shape (omitted when there are none). */
function mapArgs(
  args: ReadonlyArray<{
    name: string;
    description?: string;
    required?: boolean;
    choices?: unknown;
  }> | undefined,
): CommandCatalogArg[] | undefined {
  if (!args || args.length === 0) return undefined;
  return args.map((a) => {
    const out: CommandCatalogArg = { name: a.name };
    if (a.description) out.description = a.description;
    if (a.required) out.required = true;
    const choices = normalizeChoices(a.choices);
    if (choices) out.choices = choices;
    return out;
  });
}

/**
 * Build the discovery catalog from the live native-command registry, filtered
 * by `cfg` (the account's resolved config). Alias entries are dropped (they
 * duplicate a canonical command under another name); results are stable-sorted
 * by name so the menu order is deterministic across requests.
 */
export function buildCommandCatalog(cfg: unknown): CommandCatalogEntry[] {
  const specs = listNativeCommandSpecsForConfig(cfg as never);
  const entries: CommandCatalogEntry[] = [];
  for (const spec of specs) {
    if (spec.isAlias === true) continue;
    // Defensive: the registry emits names WITHOUT a leading slash, but strip one
    // if a future entry carries it so the widget never renders `//name`.
    const name = spec.name.replace(/^\//, "");
    const entry: CommandCatalogEntry = {
      name,
      description: spec.description ?? "",
    };
    const args = mapArgs(spec.args);
    if (args) entry.args = args;
    entries.push(entry);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/**
 * Memoizing catalog provider — build ONCE, serve many.
 *
 * WHY THIS EXISTS
 * ---------------
 * The catalog is a PURE function of `cfg`, and a gateway process's config is
 * fixed for its lifetime. The `load_commands` handler, by contrast, runs inline
 * on the inbound dispatch path for every registered peer. Building the catalog
 * per request therefore spun the native-command registry list + sort on the
 * event loop for every frame, so a peer could flood `load_commands` and turn
 * discovery into an event-loop DoS surface. Memoizing removes that surface
 * without a rate limiter: the first request pays the build, every later request
 * is a cached read.
 *
 * DESIGN CHOICES
 * --------------
 *  - Config identity: the provider CLOSES OVER one `cfg`. Create one provider per
 *    account at wiring time; the cache can never serve another config's catalog.
 *    If config is ever hot-swapped (core hands a NEW config object), the provider
 *    MUST be re-created — a provider built over the old `cfg` would keep serving
 *    the old catalog by design.
 *  - Throw handling: a FAILED build is NOT cached. We assign the cache only after
 *    a successful build, so a throw propagates to the handler's try/catch (the
 *    failure boundary) and the NEXT request retries rather than latching a
 *    permanently-empty menu on one transient registry fault.
 *  - Shared instance (no defensive copy): the returned array is the SAME cached
 *    instance every call. The only consumer, `sendCommands` → `sendToPeer`, just
 *    serializes/seals it (read-only); nothing mutates it. Returning a copy would
 *    re-pay an allocation on the hot path for no safety gain.
 *  - `build` is injectable ONLY for tests (memoization / retry are otherwise
 *    unobservable without a spy); production wiring passes just `cfg` and gets
 *    the real `buildCommandCatalog`.
 */
export function createCommandCatalogProvider(
  cfg: unknown,
  build: (cfg: unknown) => CommandCatalogEntry[] = buildCommandCatalog,
): () => CommandCatalogEntry[] {
  let cached: CommandCatalogEntry[] | undefined;
  return () => {
    // `undefined` is the "never built (or last build threw)" sentinel — an empty
    // catalog is a valid `[]` and IS cached (it is a real, config-derived result).
    if (cached !== undefined) return cached;
    const built = build(cfg); // may throw — deliberately NOT cached (retry next call)
    cached = built;
    return cached;
  };
}
