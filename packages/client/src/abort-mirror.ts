/**
 * P1-9: client-side mirror of core's abort predicate.
 *
 * The server routes abort text OUT-OF-BAND and aborts whatever turn is live at
 * arrival time (`packages/plugin/src/control-lane.ts` → SDK `isAbortRequestText`
 * in `openclaw/plugin-sdk/command-primitives-runtime`). P1-9 holds a
 * mid-turn `send()` client-side instead of publishing it immediately; abort text
 * must NEVER enter that hold:
 *   - a held abort deadlocks (the hold waits for the settle, the settle needs the
 *     abort);
 *   - a held-then-released abort is a STALE abort — it would kill the user's OWN
 *     just-started follow-up turn (or a turn another device started). See the
 *     plan §3.3.
 * So `send()` checks `isLikelyAbortText` FIRST and bypasses the hold, publishing
 * immediately.
 *
 * WHY MIRRORING IS SAFE. This mirror deliberately OMITS core's
 * `normalizeCommandBody` alias/mention canonicalization, so it accepts a strict
 * SUBSET of what the server accepts:
 *   - false positive (mirror says abort, server doesn't) — impossible while the
 *     subset property holds; `packages/plugin/src/abort-mirror-contract.test.ts`
 *     enforces it against the real SDK predicate (the same cross-package
 *     drift-guard pattern PACKAGING.md §3 uses for the wire types);
 *   - false negative (core's vocabulary grew; the mirror doesn't know the word) —
 *     the new word is held like normal text and released later: degraded but
 *     bounded to vocabulary added to core AFTER the pin. RE-PIN on openclaw
 *     upgrades (copy this set + the normalization from the new dist).
 *
 * MAINTENANCE. `ABORT_TRIGGERS`, `TRAILING_PUNCT`, and the `normalizeAbort`
 * pipeline are copied VERBATIM from the openclaw dist
 * (`abort-primitives-*.js` → `ABORT_TRIGGERS`, `TRAILING_ABORT_PUNCTUATION_RE`,
 * `normalizeAbortTriggerText`). Do NOT hand-edit; re-copy on upgrade. The
 * contract test fails mechanically if core REMOVES a word (it cannot see
 * additions — see the accepted residual above).
 *
 * This module has NO imports so the client package stays zero-dependency and
 * Node-free. It is intentionally NOT re-exported from the public barrel
 * (`index.ts`) — the plugin-side contract test imports the source path directly,
 * the way the demo imports client source cross-package.
 */

/**
 * The abort vocabulary, pinned VERBATIM from the openclaw dist. Exported (but
 * NOT via the public barrel) so `packages/plugin/src/abort-mirror-contract.test.ts`
 * can enumerate exactly what the mirror accepts and assert the subset property
 * against the real SDK predicate.
 * `abort-primitives-*.js` `ABORT_TRIGGERS` (44 entries, including the non-Latin
 * ones — do not transcribe by hand, re-copy on upgrade).
 */
export const ABORT_TRIGGERS: ReadonlySet<string> = new Set([
  "stop",
  "esc",
  "abort",
  "wait",
  "exit",
  "interrupt",
  "detente",
  "deten",
  "detén",
  "arrete",
  "arrête",
  "停止",
  "停下来",
  "暂停",
  "やめて",
  "止めて",
  "रुको",
  "توقف",
  "стоп",
  "остановись",
  "останови",
  "остановить",
  "прекрати",
  "halt",
  "anhalten",
  "aufhören",
  "hoer auf",
  "stopp",
  "pare",
  "stop openclaw",
  "openclaw stop",
  "stop action",
  "stop current action",
  "stop run",
  "stop current run",
  "stop agent",
  "stop the agent",
  "stop don't do anything",
  "stop dont do anything",
  "stop do not do anything",
  "stop doing anything",
  "do not do that",
  "please stop",
  "stop please",
]);

/**
 * Trailing-punctuation strip, copied VERBATIM from the dist
 * `TRAILING_ABORT_PUNCTUATION_RE`.
 */
const TRAILING_PUNCT = /[.!?！？…,，。;；:：'"’”)\]}]+$/u;

/**
 * Normalization pipeline mirroring the dist `normalizeAbortTriggerText`:
 * `normalizeLowercaseStringOrEmpty` (trim + lowercase) → curly-quote/backtick →
 * `'` → collapse whitespace → strip trailing punctuation → trim.
 */
const normalizeAbort = (t: string): string =>
  t
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .replace(TRAILING_PUNCT, "")
    .trim();

/**
 * True when `t` is abort-shaped: the explicit `/stop` command (any case /
 * trailing punctuation) or a natural-language abort trigger. Mirrors the dist
 * `isAbortRequestText` MINUS `normalizeCommandBody` (see the module header).
 */
export const isLikelyAbortText = (t: string): boolean =>
  t.trim().toLowerCase() === "/stop" ||
  normalizeAbort(t) === "/stop" ||
  ABORT_TRIGGERS.has(normalizeAbort(t));

/**
 * True ONLY for the unambiguous typed `/stop` (case- and surrounding-whitespace-
 * insensitive). Mirrors `control-lane.ts` `isExplicitAbortCommand` — the ONLY
 * abort form that also RETRACTS held messages (§3.4); NL abort words bypass but
 * leave held messages intact.
 */
export const isExplicitStop = (t: string): boolean =>
  t.trim().toLowerCase() === "/stop";
