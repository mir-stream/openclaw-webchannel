/**
 * #123 — log-record integrity for peer-controlled values.
 *
 * Warning logs in this plugin are FIRST-LINE DIAGNOSTIC EVIDENCE: the #113
 * empty-reasoning-lane diagnostic exists so an operator can read one line and
 * know the lane is dead. That only holds if a peer cannot write into the log
 * stream. Several warn sites interpolate `turnId` (which is just the browser's
 * `message.id`) and `wsKey`, so a newline in an inbound id let a peer append a
 * second, fully-formed log line — a forged record a SIEM parses as genuine and
 * folds into an incident timeline. The impact is evidence poisoning, not code
 * execution.
 *
 * Two things have to be neutralised, not one:
 *
 *  1. RECORD injection — a newline (or `\r`, or U+2028/U+2029, which several
 *     log viewers and JS itself treat as line terminators) ends the record and
 *     starts an attacker-authored one.
 *  2. FIELD injection — the surviving single line is still parsed as
 *     `key=value` pairs by every log pipeline we care about, so an id of
 *     `x outcome=ok peer=trusted` forges fields inside a real record without
 *     ever needing a newline. Escaping control characters alone does not stop
 *     this; only delimiting the value does.
 *
 * So this quotes as well as escapes, via `JSON.stringify`. That is also the
 * shape #113/#126 already shipped and pinned with tests in `inbound.ts`
 * (`turn="turn-42\nforged=true"`), so routing every site through this helper
 * unifies the file on one style rather than adding a second one.
 *
 * Readable and grep-able is preserved: the literal prefixes the e2e harnesses
 * scrape (`turn_settled was not delivered`, `[echo] FAIL`) are untouched, and
 * the id itself still appears verbatim inside the quotes, so `grep turn-42`
 * keeps matching. The quotes are the signal that the value is untrusted.
 *
 * `JSON.stringify` covers C0 (U+0000–U+001F), which is where `\n`, `\r` and
 * the ANSI escape U+001B live. It does NOT escape DEL/C1 (U+007F–U+009F) or
 * U+2028/U+2029, all of which are legal inside a JSON string and all of which
 * can still confuse a terminal or a line splitter — hence the second pass.
 */
const UNESCAPED_BY_JSON = /[\u007f-\u009f\u2028\u2029]/g;

/**
 * Render a peer-controlled value for a log line: quoted, with every character
 * that could end the record or forge a field escaped.
 *
 * Accepts `unknown` on purpose. `turnId` traces back to `message.id` off the
 * wire, and the inbound frame is not schema-validated at this boundary, so a
 * non-string can reach a warn site. This must also never throw: several call
 * sites are inside the settle loop's `finally`, where a throw would escape into
 * the dispatcher's `.catch(() => {})` and strand every receipt in the turn.
 */
export function logSafe(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : String(value);
  } catch {
    // An object whose `toString`/`valueOf` throws, or a null-prototype object
    // (`String(Object.create(null))` is a TypeError). NOT a Symbol — explicit
    // `String(sym)` is legal and renders "Symbol(s)"; only implicit coercion
    // throws. The value is unusable as evidence, but losing the whole record
    // would be worse.
    text = "<unprintable>";
  }
  return JSON.stringify(text).replace(
    UNESCAPED_BY_JSON,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
