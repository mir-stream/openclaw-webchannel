/**
 * P0-3 slash-command typeahead filter (pure).
 *
 * Lives here (not in the demo widget) because demo/web has no test runner —
 * keeping the filter logic in the client package lets it be unit-tested. The
 * widget imports it to render its `/`-menu.
 */

import type { CommandCatalogEntry } from "./types.js";

/**
 * Filter a command catalog for a widget input value.
 *
 * Returns the commands whose name PREFIX-matches what the user is typing after
 * the leading slash — or an empty list (menu hidden) when the input is not a
 * slash command:
 *   - `"/"`      → the whole catalog (menu just opened);
 *   - `"/he"`    → commands whose name starts with "he" (e.g. `help`);
 *   - `"/x"`     → empty (no match);
 *   - `"hello"`  → empty (not a slash command);
 *   - `"/model "`→ empty (a space means the command name is complete and the
 *                  user is now typing arguments — stop suggesting).
 *
 * Matching is case-insensitive on the name WITHOUT the leading slash (the
 * catalog's shape).
 */
export function filterCommandCatalog(
  catalog: readonly CommandCatalogEntry[] | undefined,
  inputValue: string,
): CommandCatalogEntry[] {
  if (!catalog || !inputValue.startsWith("/")) return [];
  const query = inputValue.slice(1);
  // A space means the command token is finished; the typeahead is for the name.
  if (/\s/.test(query)) return [];
  const lower = query.toLowerCase();
  return catalog.filter((c) => c.name.toLowerCase().startsWith(lower));
}
