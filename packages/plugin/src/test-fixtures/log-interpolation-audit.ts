/**
 * #123 — the log-record integrity checker.
 *
 * WHY THIS IS NOT A REGEX. The first version of this guard was
 * ``/`webchannel:[^`]*`/g``: it matched ONE backtick pair and never looked past
 * its closing backtick. Three shapes walked straight through it —
 *
 *   1. a continuation fragment, which is this codebase's house style for long
 *      records:   `webchannel: probe ` + `peer=${peerId}`
 *   2. a nested template inside an interpolation:
 *      `webchannel: probe ${id ? `id=${id}` : ""}`
 *   3. any spelling outside the six it happened to deny — `${entry.peerId}`,
 *      `${(err as Error).message}` (a live idiom in this repo), or an alias.
 *
 * (1) and (3) are the realistic ones: eight of the runtime's log lines are
 * already ~100+ characters, so the next author to add a peer field wraps the
 * line and lands the value on fragment two.
 *
 * So this scans the whole log STATEMENT — through concatenation, parenthesised
 * sub-expressions and nested templates — and applies a POSITIVE rule:
 *
 *   every `${…}` inside a log statement must be a `logSafe(…)` call,
 *   unless its exact text is on the allowlist below.
 *
 * An allowlist of values known to be safe is auditable and stays correct as the
 * code grows. A denylist of dangerous spellings is neither: it is only ever as
 * complete as the last person's imagination, which is exactly how the six-entry
 * version shipped green over two live evasions.
 *
 * SCOPE IS SET BY PREFIX, NOT BY FILE. A statement is only checked if its
 * static text carries one of the caller-supplied prefixes — and that cuts
 * INSIDE an enforced file too, not just between files. `nats-account-runtime.ts`
 * writes six structured records as `event=webchannel.*` with no `webchannel:`
 * anywhere; until that prefix was added, the scanner reported 16 statements for
 * that file and silently skipped them. `nats-channel.ts` is out for the same
 * reason (`[nats-channel]`), so adding it to an enforced list without adding
 * its prefix would enforce nothing while looking like it did. Same for
 * `ingress-outcome.ts`.
 *
 * FAIL LOUD ON WHAT IT CANNOT READ. Outside templates, strings and comments, a
 * log argument may contain only punctuation and literals; any bare identifier
 * chain is reported as unreadable (`findUnreadableValues`). That is an
 * inversion, and it was forced: the previous version enumerated the dangerous
 * shapes it knew (`+` with a bare operand, `.join(`) and accepted a
 * neighbouring `(` as safe without ever descending into the group — so
 * `+ (message.text ?? "")`, `+ (err as Error).message` and `.concat(peerId)`
 * all passed clean. Every round of review here has landed on the same lesson:
 * a guard that stays quiet about something it does not understand is how the
 * defect ships.
 */

/** A single `${…}` found inside a log statement. */
export interface LogInterpolation {
  /** Exact source text between `${` and `}`. */
  readonly expression: string;
  /** 1-based line number. */
  readonly line: number;
  /** The statement's static text, for a readable failure message. */
  readonly statement: string;
}

/**
 * Interpolations that may stay raw, each with the reason it cannot carry
 * peer-controlled bytes. Keyed by EXACT expression text so a rename or a
 * change of shape re-triggers review rather than silently inheriting the
 * exemption.
 */
export const ALLOWED_RAW_INTERPOLATIONS: ReadonlyMap<string, string> = new Map([
  // Closed enums — the full value set is spelled out in the source.
  ["admission.reason", "six-literal union (dm-allowlist.ts:29-36)"],
  ["turnOutcome", 'the literal union "ok" | "error" (inbound.ts:392)'],
  // Numerics and booleans: cannot contain a newline or a delimiter.
  ["debounceCancelled", "boolean"],
  ["pendingDropped.length", "number"],
  ["PENDING_APPROVAL_CAP", "numeric module constant"],
  ["PENDING_APPROVAL_MAX_AGE_MS", "numeric module constant"],
  // Retry/lifecycle counters on the `event=webchannel.*` records.
  ["failedAttempts", "retry counter (number)"],
  ["delayMs", "backoff delay (number)"],
  ["attempt", "attempt counter (number)"],
  ["outageMs", "outage duration (number)"],
  ["disposeReport.errors.length", "number"],
  // Escaped PER ELEMENT before joining, so a comma inside one id cannot forge a
  // list boundary. Wrapping the joined string instead would be weaker — see the
  // test in ingress-dedupe.test.ts.
  [
    'ackIds.map((id) => logSafe(id)).join(",")',
    "each element escaped before the join (ingress-dedupe.ts:581)",
  ],
]);

/**
 * Functions whose RETURN value is safe to interpolate.
 *
 * `logSafe` ONLY. `formatAccountIdForLog` was here on the reasoning that it
 * "sanitises the account id" — it does not: `account-config.ts:78-80` is bare
 * `JSON.stringify(id)`, which this module's own docblock explains is
 * insufficient because it leaves DEL/C1 and U+2028/U+2029 raw.
 *
 * MEASURED, and written with ESCAPES rather than literal characters. The
 * first version of this note embedded a RAW U+2028 in the prose. The claim
 * ("renders as two lines") was true, but the character is invisible: an
 * editor shows it as a line break, so a reader retests with `\n`, gets ONE
 * line, and concludes the rationale is false. A raw control character hidden
 * in the docblock of the module about hidden control characters is worse than
 * a wrong example, because it reads as a caught lie.
 *
 *   input                    formatAccountIdForLog   logSafe
 *   `a\nwebchannel: ...`     1 line                  1 line
 *   `a\u2028webchannel: ...` 2 LINES                 1 line
 *   `a\u007fb`               raw DEL survives        escaped
 *
 * No live defect today — every call site passes a config-derived id. But the
 * exemption matched by call SHAPE, so it would have blessed that function
 * over any argument in any file added to `ENFORCED` later. Its uses ride the
 * documented baseline instead, where the reason gets re-read.
 */
const SAFE_WRAPPERS = ["logSafe"] as const;

/**
 * True only when the expression IS the call — not merely when it starts and
 * ends like one. The prefix/suffix version exempted
 * `${logSafe(peerId).slice(0, 20)}`, which truncates mid-value and can drop the
 * closing quote, destroying the delimiting the whole fix rests on; and
 * `${logSafe(a) || String(peerId)}`, which reaches the record raw. Both are
 * things an author writes to shorten a long line or add a fallback.
 */
function isSafeWrapperCall(expression: string): boolean {
  return SAFE_WRAPPERS.some((fn) => {
    if (!expression.startsWith(`${fn}(`)) return false;
    return scanToCloseParen(expression, fn.length) === expression.length - 1;
  });
}

const LOG_CALLEE = /([A-Za-z_$][A-Za-z0-9_$]*(?:\s*\??\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\??\.?\s*\(/g;

/**
 * Is this callee a logging (or log-destined error-construction) sink?
 *
 * Deliberately over-inclusive: a false positive only means we scan a call that
 * turns out to carry no log prefix, and it is then dropped. A false NEGATIVE is
 * a silent hole. `debugLog` was one — it fails an exact-name list and it fails
 * `startsWith("log")`, and it is the spelling someone actually writes.
 */
function isLogCallee(chain: string): boolean {
  const last = chain.split(/\??\./).pop()?.trim().toLowerCase() ?? "";
  return (
    ["warn", "error", "info", "debug", "trace", "log", "super"].includes(last) ||
    ["warn", "log", "debug", "trace", "report", "emit", "diagnos"].some((verb) =>
      last.startsWith(verb),
    ) ||
    ["log", "warn", "error"].some((noun) => last.endsWith(noun))
  );
}

function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return src.length;
}

function skipComment(src: string, i: number): number {
  if (src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl < 0 ? src.length : nl;
  }
  const close = src.indexOf("*/", i);
  return close < 0 ? src.length : close + 2;
}

interface TemplateScan {
  /** Index just past the closing backtick. */
  readonly end: number;
  /** Direct (depth-1) interpolations of this template. */
  readonly interpolations: Array<{ text: string; index: number }>;
  /** Concatenated static text of this template. */
  readonly literal: string;
}

/** Scan a template literal beginning at `start` (which must be a backtick). */
function scanTemplate(src: string, start: number): TemplateScan {
  const interpolations: Array<{ text: string; index: number }> = [];
  let literal = "";
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      literal += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") return { end: i + 1, interpolations, literal };
    if (ch === "$" && src[i + 1] === "{") {
      const exprStart = i + 2;
      const exprEnd = scanToCloseBrace(src, exprStart);
      interpolations.push({ text: src.slice(exprStart, exprEnd), index: exprStart });
      i = exprEnd + 1;
      continue;
    }
    literal += ch;
    i++;
  }
  return { end: src.length, interpolations, literal };
}

/** From just after `${`, find the matching `}`, honouring nesting. */
function scanToCloseBrace(src: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      i = scanTemplate(src, i).end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth--;
      i++;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return src.length;
}

/**
 * Walk `[start, end)` collecting EVERY template literal's interpolations,
 * recursing into each interpolation so a nested template cannot hide a raw
 * value inside an outer one.
 */
function collectInterpolations(
  src: string,
  start: number,
  end: number,
  out: Array<{ text: string; index: number }>,
  literalOut: { text: string },
): void {
  let i = start;
  while (i < end) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const stringEnd = skipString(src, i);
      literalOut.text += src.slice(i, stringEnd);
      i = stringEnd;
      continue;
    }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (ch === "`") {
      const scan = scanTemplate(src, i);
      literalOut.text += scan.literal;
      for (const interp of scan.interpolations) {
        out.push(interp);
        collectInterpolations(
          src,
          interp.index,
          interp.index + interp.text.length,
          out,
          literalOut,
        );
      }
      i = scan.end;
      continue;
    }
    i++;
  }
}

/** From a call's `(`, find the index of its matching `)`. */
function scanToCloseParen(src: string, open: number): number {
  let i = open + 1;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      i = scanTemplate(src, i).end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return src.length;
}

/** A log statement: one logging call whose text carries a known log prefix. */
export interface LogStatement {
  readonly literal: string;
  readonly line: number;
  readonly interpolations: readonly LogInterpolation[];
  /**
   * Shapes this scanner cannot reason about, reported as violations rather than
   * ignored. See `findUnreadableValues`.
   */
  readonly unreadable: readonly string[];
}

/** Index of the previous/next meaningful char, skipping whitespace + comments. */
function stepMeaningful(src: string, i: number, dir: 1 | -1, lo: number, hi: number): number {
  let j = i;
  while (j >= lo && j < hi) {
    const ch = src[j]!;
    if (/\s/.test(ch)) {
      j += dir;
      continue;
    }
    // A `//` comment tail only ever matters going forward; going back, treat a
    // `/` as meaningful so we stay conservative (and loud).
    if (dir === 1 && ch === "/" && (src[j + 1] === "/" || src[j + 1] === "*")) {
      j = skipComment(src, j);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * Anything in a log argument that this scanner cannot READ as a value.
 *
 * The previous version enumerated dangerous shapes — `+` with a bare operand,
 * `.join(` — and stayed quiet on everything else. Two ordinary shapes walked
 * through it: `+ (message.text ?? "")` and `+ (err as Error).message`, because
 * it accepted a neighbouring `(` as "scannable" while nothing ever descended
 * into the group. `.concat(` was silent for the same reason. Enumerating
 * dangerous shapes fails the same way a denylist of spellings did two rounds
 * ago, so this inverts too.
 *
 * The rule now: outside templates, strings and comments, a log argument may
 * contain only punctuation and literals. Any BARE IDENTIFIER CHAIN at code
 * level — `message.text`, `(err as Error).message`, `peerId`, `.concat(…)`,
 * `.join(…)` — is a value this scanner cannot follow, and is reported.
 *
 * ONE exception, because real code needs it: an identifier immediately
 * followed by a single `?` is a ternary CONDITION, which is never emitted into
 * the record. `` `frag` + (accountId ? ` for account ${logSafe(accountId)}` : "") ``
 * — the live shape at approvals.ts — stays legal. `??` is deliberately NOT
 * exempt: its left operand IS emitted.
 */
function findUnreadableValues(src: string, start: number, end: number): string[] {
  const found = new Set<string>();
  let i = start;
  while (i < end) {
    const ch = src[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      i = scanTemplate(src, i).end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < end && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      // Absorb a member chain so `message.text` reads as one value.
      while (j < end && /[.?]/.test(src[j]!) && /[A-Za-z_$]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < end && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      }
      const token = src.slice(i, j);
      const next = stepMeaningful(src, j, 1, start, end);
      const isTernaryCondition =
        next >= 0 && src[next] === "?" && src[next + 1] !== "?" && src[next + 1] !== ".";
      if (!isTernaryCondition) {
        found.add(`bare value \`${token}\` at code level — this scanner cannot read it`);
      }
      i = j;
      continue;
    }
    i++;
  }
  return [...found];
}

/**
 * Every logging call in `source` whose static text contains one of `prefixes`,
 * with all of its interpolations — across concatenation and nesting.
 */
export function findLogStatements(
  source: string,
  prefixes: readonly string[],
): LogStatement[] {
  const statements: LogStatement[] = [];
  LOG_CALLEE.lastIndex = 0;
  let match: RegExpExecArray | null;
  const consumed: Array<[number, number]> = [];
  while ((match = LOG_CALLEE.exec(source)) !== null) {
    if (!isLogCallee(match[1]!)) continue;
    const open = match.index + match[0].length - 1;
    // Skip a call we already swallowed as part of an enclosing log statement.
    if (consumed.some(([s, e]) => open > s && open < e)) continue;
    const close = scanToCloseParen(source, open);
    const found: Array<{ text: string; index: number }> = [];
    const literalOut = { text: "" };
    collectInterpolations(source, open + 1, close, found, literalOut);
    if (!prefixes.some((prefix) => literalOut.text.includes(prefix))) continue;
    consumed.push([open, close]);
    const statement = literalOut.text.replace(/\s+/g, " ").trim().slice(0, 90);
    statements.push({
      literal: statement,
      line: source.slice(0, open).split("\n").length,
      unreadable: findUnreadableValues(source, open + 1, close),
      interpolations: found.map((interp) => ({
        expression: interp.text.replace(/\s+/g, " ").trim(),
        line: source.slice(0, interp.index).split("\n").length,
        statement,
      })),
    });
  }
  return statements;
}

/** An interpolation that is neither `logSafe(…)` nor allowlisted. */
export interface LogViolation extends LogInterpolation {
  readonly file: string;
}

/**
 * The positive rule. Returns every interpolation in a prefixed log statement
 * that is not a `logSafe(…)` call and not explicitly allowlisted.
 */
export function findUnsafeLogInterpolations(
  source: string,
  options: { readonly file: string; readonly prefixes: readonly string[] },
): LogViolation[] {
  const violations: LogViolation[] = [];
  for (const statement of findLogStatements(source, options.prefixes)) {
    for (const interp of statement.interpolations) {
      const expr = interp.expression;
      if (isSafeWrapperCall(expr)) continue;
      if (ALLOWED_RAW_INTERPOLATIONS.has(expr)) continue;
      violations.push({ ...interp, file: options.file });
    }
    // Report what the scanner cannot read, rather than passing it silently.
    for (const warning of statement.unreadable) {
      violations.push({
        expression: warning,
        line: statement.line,
        statement: statement.literal,
        file: options.file,
      });
    }
  }
  return violations;
}

/** Render violations as `file:line  ${expr}  — in "<record>"` for assertions. */
export function formatViolations(violations: readonly LogViolation[]): string[] {
  return violations.map(
    (v) => `${v.file}:${v.line}  \${${v.expression}}  — in "${v.statement}"`,
  );
}

/**
 * A line-number-free identity for a violation, so a documented baseline of
 * known debt survives edits elsewhere in the file instead of churning on every
 * line shift.
 */
export function violationKey(violation: LogViolation): string {
  return `${violation.expression}  @  ${violation.statement.slice(0, 60)}`;
}
