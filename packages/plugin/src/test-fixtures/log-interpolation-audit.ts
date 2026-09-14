import ts from "typescript";

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
 *   every `${…}` inside a log statement must call the canonical imported
 *   `logSafe(…)`, unless its exact file + statement + text site is allowlisted.
 *
 * A site-scoped allowlist of values known to be safe is auditable and stays
 * correct as the code grows. A denylist of dangerous spellings is neither: it
 * is only ever as complete as the last person's imagination, which is exactly
 * how the six-entry version shipped green over two live evasions.
 *
 * SCOPE IS SET BY PREFIX, NOT BY FILE. A statement is only checked if its
 * static text carries one of the caller-supplied prefixes — and that cuts
 * INSIDE an enforced file too, not just between files. `nats-account-runtime.ts`
 * writes six structured records as `event=webchannel.*` with no `webchannel:`
 * anywhere; until that prefix was added, the scanner reported 16 statements for
 * that file and silently skipped them. `nats-channel.ts` had the same blind
 * spot through its `[nats-channel]` prefix; callers must list that prefix when
 * enforcing the file. The same rule applies to `ingress-outcome.ts`.
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
  /** Full normalized static text, used for exact site identity. */
  readonly site: string;
  /** Runtime-cooked static fragment immediately before this template value. */
  readonly cookedLeft: string;
  /** Runtime-cooked static fragment immediately after this template value. */
  readonly cookedRight: string;
  /** Whether another interpolation supplies the immediately adjacent value. */
  readonly interpolationBefore: boolean;
  readonly interpolationAfter: boolean;
  /** False only when the AST could not prove the runtime boundary. */
  readonly boundaryKnown: boolean;
}

/**
 * Interpolations that may stay raw, each with the reason it cannot carry
 * peer-controlled bytes. Every allowance names the file and the statement's
 * full normalized static text, and is consumed at most once per scan. An
 * unrelated binding with the same spelling therefore cannot inherit a safety
 * decision made for another file or another site.
 */
export interface AllowedRawInterpolation {
  readonly file: string;
  readonly site: string;
  readonly expression: string;
  readonly reason: string;
}

export const ALLOWED_RAW_INTERPOLATIONS: readonly AllowedRawInterpolation[] = [
  // Closed enums — the full value set is spelled out in the source.
  {
    file: "inbound.ts",
    site: "webchannel: inbound denied for peer (); turn not dispatched",
    expression: "admission.reason",
    reason: "six-literal union (dm-allowlist.ts:29-36)",
  },
  {
    file: "inbound.ts",
    site: "webchannel: turn_settled was not delivered for peer= turn= outcome=",
    expression: "turnOutcome",
    reason: 'the literal union "ok" | "error" (inbound.ts:392)',
  },
  {
    file: "approvals.ts",
    site: "[webchannel] event=webchannel.approval.origin_unresolved accountId= reason= sessionKey_present=",
    expression: "reason",
    reason: "OriginUnresolvedReason string-literal union",
  },
  // Numerics and booleans: cannot contain a newline or a delimiter.
  {
    file: "auth.ts",
    site: "webchannel: jwt strategy requires exactly one of jwksUrl, jwksFile, or jwks (got ). Refusing to start.",
    expression: "present.length",
    reason: "number",
  },
  {
    file: "approvals.ts",
    site: "[webchannel] pending-approval cap reached; evicting a still-pending approval (account , peer ) — a client may show it as resolved-elsewhere",
    expression: "PENDING_APPROVAL_CAP",
    reason: "numeric module constant",
  },
  {
    file: "approvals.ts",
    site: "[webchannel] pending-approval (account , peer ) pruned after ms with no finalize — likely an orphaned approval (monitor disposed?)",
    expression: "PENDING_APPROVAL_MAX_AGE_MS",
    reason: "numeric module constant",
  },
  {
    file: "approvals.ts",
    site: "[webchannel] event=webchannel.approval.origin_unresolved accountId= reason= sessionKey_present=",
    expression: "sessionKeyPresent",
    reason: "boolean",
  },
  {
    file: "nats-channel.ts",
    site: "[nats-channel] peer cap reached; evicting oldest peer",
    expression: "this.maxPeers",
    reason: "readonly number",
  },
  {
    file: "nats-channel.ts",
    site: "webchannel: device public key must be 32 bytes (got )",
    expression: "devicePublicKey.length",
    reason: "Uint8Array length (number)",
  },
  {
    file: "nats-channel.ts",
    site: '"[nats-channel] ingress result frame cannot fit effective NATS max_payload; "increase the server limit (suppressed=)',
    expression: "suppressed",
    reason: "suppressed-warning counter (number)",
  },
  {
    file: "nats-channel.ts",
    site: "[nats-channel] Dropping inbound from : ts outside ±ms window (skew=ms) — stale replay or client clock skew; messageId=",
    expression: "this.replayWindowMs",
    reason: "readonly millisecond duration (number)",
  },
  {
    file: "nats-channel.ts",
    site: "[nats-channel] Dropping inbound from : ts outside ±ms window (skew=ms) — stale replay or client clock skew; messageId=",
    expression: "skew",
    reason: "Date.now() minus authenticated numeric timestamp (number)",
  },
  {
    file: "nats-channel.ts",
    site: "[nats-channel] Invalid from :",
    expression: "failure.type",
    reason:
      // #246 half A. `InboundWsDecodeFailure`'s `invalid-fields` arm types this
      // as `KnownInboundWsType` — the five-literal union in
      // `inbound-wire-decode.ts`, which the decoder assigns ONLY after matching
      // the peer's `type` against that set. The peer's own bytes reach the OTHER
      // arm (`unknown-type`), whose line wraps them in `logSafe`. It stays raw so
      // the record keeps the exact `Invalid approval_decision from "peer"` text
      // the two guards this replaced already emitted (pinned by
      // `nats-channel-typing.test.ts`); quoting it would rename the record for
      // every operator grep that matches on it.
      "five-literal union KnownInboundWsType (inbound-wire-decode.ts)",
  },
  // Retry/lifecycle counters on the `event=webchannel.*` records.
  {
    file: "nats-account-runtime.ts",
    site: '"warn"event=webchannel.account_startup accountId= state=retry_scheduled attempt= delayMs= code=',
    expression: "failedAttempts",
    reason: "retry counter (number)",
  },
  {
    file: "nats-account-runtime.ts",
    site: '"warn"event=webchannel.account_startup accountId= state=retry_scheduled attempt= delayMs= code=',
    expression: "delayMs",
    reason: "backoff delay (number)",
  },
  {
    file: "nats-account-runtime.ts",
    site: '"info"event=webchannel.account_startup accountId= state=recovered attempt= failedAttempts= outageMs=',
    expression: "attempt",
    reason: "attempt counter (number)",
  },
  {
    file: "nats-account-runtime.ts",
    site: '"info"event=webchannel.account_startup accountId= state=recovered attempt= failedAttempts= outageMs=',
    expression: "failedAttempts",
    reason: "retry counter (number)",
  },
  {
    file: "nats-account-runtime.ts",
    site: '"info"event=webchannel.account_startup accountId= state=recovered attempt= failedAttempts= outageMs=',
    expression: "outageMs",
    reason: "outage duration (number)",
  },
  {
    file: "nats-account-runtime.ts",
    site: "webchannel: /stop dropped buffered input (debounced=, pending=)",
    expression: "debounceCancelled",
    reason: "boolean",
  },
  {
    file: "nats-account-runtime.ts",
    site: "webchannel: /stop dropped buffered input (debounced=, pending=)",
    expression: "pendingDropped.length",
    reason: "number",
  },
  {
    file: "nats-account-runtime.ts",
    site: '"warn"event=webchannel.account_cleanup accountId= errors=',
    expression: "disposeReport.errors.length",
    reason: "number",
  },
  {
    file: "nats-account-runtime.ts",
    site: '"info"event=webchannel.account_startup accountId= state=stopped attempt=',
    expression: "attempt",
    reason: "attempt counter (number)",
  },
  {
    file: "nats-account-runtime.ts",
    site: "webchannel: loaded plugin bundle (plugin=webchannel, source=)",
    expression: "LOADED_PLUGIN_BUNDLE_PATH",
    reason: "fileURLToPath(import.meta.url) of the running local module; not peer-controlled",
  },
] as const;

export function rawInterpolationAllowanceKey(
  allowance: Pick<AllowedRawInterpolation, "file" | "site" | "expression">,
): string {
  return `${allowance.file}\u0000${allowance.site}\u0000${allowance.expression}`;
}

/**
 * The function whose RETURN value is safe to interpolate.
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
const CANONICAL_LOG_SAFE_MODULE = "./log-safe.js";

/** Collect the identifiers introduced by one binding name, including destructuring. */
function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
}

/**
 * `logSafe(…)` is trustworthy only when `logSafe` is the canonical named import
 * and no lexical declaration shadows it anywhere in the file. Requiring the
 * whole file to be shadow-free is intentionally conservative: it keeps this
 * source scanner from having to approximate JavaScript scope at every nested
 * interpolation while still proving that every accepted spelling resolves to
 * the one implementation whose contract this audit relies on.
 */
function hasCanonicalUnshadowedLogSafe(source: string, file: string): boolean {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const canonicalImports: ts.ImportSpecifier[] = [];
  const bindings: Array<{ readonly identifier: ts.Identifier; readonly owner: ts.Node }> = [];

  const addBinding = (name: ts.BindingName | ts.Identifier | undefined, owner: ts.Node): void => {
    if (!name) return;
    const identifiers = ts.isIdentifier(name) ? [name] : bindingIdentifiers(name);
    for (const identifier of identifiers) {
      if (identifier.text === "logSafe") bindings.push({ identifier, owner });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const declaration = node.parent.parent.parent;
      const imported = node.propertyName?.text ?? node.name.text;
      if (
        ts.isImportDeclaration(declaration) &&
        !node.isTypeOnly &&
        !declaration.importClause?.isTypeOnly &&
        ts.isStringLiteral(declaration.moduleSpecifier) &&
        declaration.moduleSpecifier.text === CANONICAL_LOG_SAFE_MODULE &&
        imported === "logSafe" &&
        node.name.text === "logSafe"
      ) {
        canonicalImports.push(node);
      }
      addBinding(node.name, node);
    } else if (ts.isImportClause(node)) {
      addBinding(node.name, node);
    } else if (ts.isNamespaceImport(node)) {
      addBinding(node.name, node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      addBinding(node.name, node);
    } else if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      addBinding(node.name, node);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node)
    ) {
      addBinding(node.name, node);
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      addBinding(node.name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (canonicalImports.length !== 1) return false;
  const canonical = canonicalImports[0]!;
  return bindings.every(({ owner }) => owner === canonical);
}

/**
 * True only when the expression IS the call — not merely when it starts and
 * ends like one. The prefix/suffix version exempted
 * `${logSafe(peerId).slice(0, 20)}`, which truncates mid-value and can drop the
 * closing quote, destroying the delimiting the whole fix rests on; and
 * `${logSafe(a) || String(peerId)}`, which reaches the record raw. Both are
 * things an author writes to shorten a long line or add a fallback.
 *
 * `logSafe` returns one complete JSON-quoted token. Its template boundary must
 * preserve that token: an adjacent quote/backslash can consume one of its
 * quotes, and an adjacent ECMAScript identifier-part character merges it into
 * a larger token that strict logfmt rejects. Another interpolation (including
 * across a `+` concatenation) is dynamic adjacency and is rejected too. Empty
 * record boundaries and whitespace remain valid. Punctuation remains valid in
 * prose, but not inside a statically recognisable logfmt field: for `key=...`,
 * `logSafe` must begin immediately after `=` and end at whitespace or record
 * end. This preserves the owned `=${logSafe(x)} `, ` ${logSafe(x)}: ` and
 * `(${logSafe(x)}):` shapes without blessing `key=-${logSafe(x)}` or
 * `key=${logSafe(x)}-suffix`.
 */
function isUnsafeQuotedTokenNeighbor(fragment: string, side: "left" | "right"): boolean {
  const codePoints = Array.from(fragment);
  const neighbor = side === "left" ? codePoints.at(-1) : codePoints[0];
  if (neighbor === undefined) return false;
  return /["'`\\$\u200c\u200d\p{ID_Continue}]/u.test(neighbor);
}

/**
 * If the contiguous cooked prefix is a logfmt `key=value` token, prove that
 * the wrapper supplies the whole value. The key grammar mirrors the strict
 * test decoder: non-whitespace/non-`=` bytes, with quotes rejected.
 */
function hasSafeLogfmtFieldBoundary(interpolation: LogInterpolation): boolean {
  const field = /(?:^|\s)([^"=\s]+)=([^\s]*)$/u.exec(interpolation.cookedLeft);
  if (!field) {
    // A trailing token that contains `=` but does not include a complete valid
    // key is not proven prose. This is what an unknown outer edge leaves behind
    // in ``unknown + `=${logSafe(value)}```: treating the local `=` as a complete
    // boundary blessed `="value"`, which strict logfmt rejects as an empty key.
    const trailingToken = /(?:^|\s)([^\s]*)$/u.exec(interpolation.cookedLeft)?.[1] ?? "";
    return !trailingToken.includes("=");
  }
  if (field[2] !== "") return false;
  const right = Array.from(interpolation.cookedRight)[0];
  if (right === undefined) return true;
  return /\s/u.test(right) && !/[\r\n\u0085\u2028\u2029]/u.test(right);
}

function isSafeWrapperCall(interpolation: LogInterpolation, canonicalBinding: boolean): boolean {
  const expression = interpolation.expression;
  if (!canonicalBinding || !expression.startsWith("logSafe(")) return false;
  if (scanToCloseParen(expression, "logSafe".length) !== expression.length - 1) return false;
  if (
    !interpolation.boundaryKnown ||
    interpolation.interpolationBefore ||
    interpolation.interpolationAfter
  ) {
    return false;
  }
  if (!hasSafeLogfmtFieldBoundary(interpolation)) return false;
  return (
    !isUnsafeQuotedTokenNeighbor(interpolation.cookedLeft, "left") &&
    !isUnsafeQuotedTokenNeighbor(interpolation.cookedRight, "right")
  );
}

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

interface CallBoundary {
  /** Index of the call's opening `(`. */
  readonly open: number;
  /** Index of the matching closing `)`. */
  readonly close: number;
  /** Runtime-cooked static text from quoted strings and template fragments. */
  readonly prefixText: string;
}

/**
 * Concatenate runtime-cooked static text in source order. `node.text` is cooked
 * by the TypeScript parser, so `"webchannel" + ":"`, `"\x77ebchannel:"`, and
 * their template equivalents all expose the same prefix they produce at
 * runtime. Dynamic identifiers contribute nothing; nested literals remain
 * conservatively visible, matching the previous scanner's broad scope.
 */
function collectCookedStaticText(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isRegularExpressionLiteral(node)) return "";
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += collectCookedStaticText(span.expression);
      text += span.literal.text;
    }
    return text;
  }
  let text = "";
  ts.forEachChild(node, (child) => {
    text += collectCookedStaticText(child);
  });
  return text;
}

type RuntimeEdge =
  | { readonly kind: "none" }
  | { readonly kind: "static"; readonly text: string }
  | { readonly kind: "interpolation" }
  | { readonly kind: "unknown" };

interface TemplateInterpolationBoundary {
  readonly cookedLeft: string;
  readonly cookedRight: string;
  readonly interpolationBefore: boolean;
  readonly interpolationAfter: boolean;
  readonly boundaryKnown: boolean;
}

/** Entire runtime text when an expression is statically a string. */
function runtimeStaticString(node: ts.Expression): string | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return runtimeStaticString(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = runtimeStaticString(node.left);
    const right = runtimeStaticString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function isTransparentRuntimeWrapper(parent: ts.Node, child: ts.Node): boolean {
  return (
    (ts.isParenthesizedExpression(parent) && parent.expression === child) ||
    (ts.isAsExpression(parent) && parent.expression === child) ||
    (ts.isTypeAssertionExpression(parent) && parent.expression === child) ||
    (ts.isNonNullExpression(parent) && parent.expression === child) ||
    (ts.isSatisfiesExpression(parent) && parent.expression === child) ||
    (ts.isAwaitExpression(parent) && parent.expression === child) ||
    (ts.isConditionalExpression(parent) &&
      (parent.whenTrue === child || parent.whenFalse === child)) ||
    (ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(parent.operatorToken.kind) &&
      (parent.left === child || parent.right === child)) ||
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      parent.right === child)
  );
}

/** The first/last runtime value contributed by an expression in a `+` chain. */
function runtimeEdge(node: ts.Expression, side: "left" | "right"): RuntimeEdge {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return runtimeEdge(node.expression, side);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.length === 0 ? { kind: "none" } : { kind: "static", text: node.text };
  }
  if (ts.isTemplateExpression(node)) {
    const text =
      side === "left"
        ? node.head.text
        : node.templateSpans[node.templateSpans.length - 1]!.literal.text;
    return text.length === 0 ? { kind: "interpolation" } : { kind: "static", text };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const first = side === "left" ? node.left : node.right;
    const second = side === "left" ? node.right : node.left;
    const wholeFirst = runtimeStaticString(first);
    if (wholeFirst !== undefined) {
      const next = runtimeEdge(second, side);
      if (wholeFirst.length === 0) return next;
      if (next.kind === "static") {
        return {
          kind: "static",
          text: side === "left" ? wholeFirst + next.text : next.text + wholeFirst,
        };
      }
      return { kind: "static", text: wholeFirst };
    }
    const edge = runtimeEdge(first, side);
    return edge.kind === "none" ? runtimeEdge(second, side) : edge;
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = runtimeEdge(node.whenTrue, side);
    const whenFalse = runtimeEdge(node.whenFalse, side);
    if (whenTrue.kind === "none" && whenFalse.kind === "none") return { kind: "none" };
    // The field checker consumes the complete cooked edge, not just the byte
    // adjacent to the interpolation. If branches differ anywhere, choosing one
    // would hide the other branch's possible `key=<prefix>` shape.
    if (
      whenTrue.kind === "static" &&
      whenFalse.kind === "static" &&
      whenTrue.text === whenFalse.text
    ) {
      return whenTrue;
    }
    if (whenTrue.kind === "interpolation" && whenFalse.kind === "interpolation") {
      return { kind: "interpolation" };
    }
    return { kind: "unknown" };
  }
  if (
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return { kind: "static", text: node.getText() };
  }
  return { kind: "unknown" };
}

/**
 * Find a value adjacent at runtime when an interpolation sits at the edge of a
 * template in a string-concatenation chain. This closes the equivalent split
 * spelling: `` `peer=${logSafe(x)}` + `suffix` ``.
 */
function externalRuntimeEdge(
  template: ts.TemplateExpression,
  side: "left" | "right",
): RuntimeEdge {
  let current: ts.Expression = template;
  let staticText = "";
  while (true) {
    const parent = current.parent;
    if (isTransparentRuntimeWrapper(parent, current)) {
      current = parent as ts.Expression;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const hasSibling =
        (side === "left" && parent.right === current) ||
        (side === "right" && parent.left === current);
      if (hasSibling) {
        const sibling = side === "left" ? parent.left : parent.right;
        const wholeSibling = runtimeStaticString(sibling);
        if (wholeSibling !== undefined) {
          staticText =
            side === "left" ? wholeSibling + staticText : staticText + wholeSibling;
        } else {
          const edge = runtimeEdge(sibling, side === "left" ? "right" : "left");
          if (edge.kind === "static") {
            return {
              kind: "static",
              text: side === "left" ? edge.text + staticText : staticText + edge.text,
            };
          }
          return staticText.length > 0 ? { kind: "static", text: staticText } : edge;
        }
      }
      current = parent;
      continue;
    }
    if (
      ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        parent.arguments?.some((argument) => argument === current)) ||
      (ts.isTemplateSpan(parent) && parent.expression === current)
    ) {
      return staticText.length > 0 ? { kind: "static", text: staticText } : { kind: "none" };
    }
    // A transformation this checker does not model is not a proven record
    // boundary. Fail loud instead of quietly blessing the wrapped value.
    return staticText.length > 0 ? { kind: "static", text: staticText } : { kind: "unknown" };
  }
}

/** Runtime-cooked neighbors for every `${...}` in every template. */
function collectTemplateInterpolationBoundaries(
  sourceFile: ts.SourceFile,
): ReadonlyMap<number, TemplateInterpolationBoundary> {
  const boundaries = new Map<number, TemplateInterpolationBoundary>();
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      for (let index = 0; index < node.templateSpans.length; index += 1) {
        const span = node.templateSpans[index]!;
        const localLeft = index === 0 ? node.head.text : node.templateSpans[index - 1]!.literal.text;
        const localRight = span.literal.text;
        const externalLeft =
          index === 0 ? externalRuntimeEdge(node, "left") : { kind: "none" as const };
        const externalRight =
          index === node.templateSpans.length - 1
            ? externalRuntimeEdge(node, "right")
            : { kind: "none" as const };
        boundaries.set(span.expression.pos, {
          cookedLeft:
            (externalLeft.kind === "static" ? externalLeft.text : "") + localLeft,
          cookedRight:
            localRight + (externalRight.kind === "static" ? externalRight.text : ""),
          interpolationBefore:
            (index > 0 && localLeft.length === 0) ||
            (localLeft.length === 0 && externalLeft.kind === "interpolation"),
          interpolationAfter:
            (index < node.templateSpans.length - 1 && localRight.length === 0) ||
            (localRight.length === 0 && externalRight.kind === "interpolation"),
          boundaryKnown:
            (localLeft.length > 0 || externalLeft.kind !== "unknown") &&
            (localRight.length > 0 || externalRight.kind !== "unknown"),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return boundaries;
}

function createAuditSourceFile(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "log-interpolation-audit-input.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/**
 * Locate logging calls with the TypeScript parser so comments, strings and
 * regex literals cannot forge a `)` boundary. The previous regex found the
 * callee and then scanned punctuation itself; `/)/` in argument one therefore
 * truncated the call before a raw interpolation in argument two and skipped it
 * quietly. AST argument ranges give the exact outer parentheses while leaving
 * the existing fail-loud value walk unchanged.
 */
function findLogCallBoundaries(source: string, sourceFile: ts.SourceFile): CallBoundary[] {
  const boundaries: CallBoundary[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      const callee = node.expression.getText(sourceFile);
      const open = node.arguments.pos - 1;
      // `arguments.end` stops after a trailing comma; the expression's end is
      // always just past the syntactic closing parenthesis.
      const close = node.end - 1;
      if (isLogCallee(callee) && source[open] === "(" && source[close] === ")") {
        boundaries.push({
          open,
          close,
          prefixText: node.arguments.map(collectCookedStaticText).join(""),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return boundaries.sort((a, b) => a.open - b.open || b.close - a.close);
}

/**
 * Hide regex literal bytes from the legacy inner scanner without changing any
 * source offset. TypeScript has already distinguished regex from division, so
 * a quote or backtick inside `/…/` cannot masquerade as a string/template
 * delimiter; preserving every ECMAScript line terminator also preserves every
 * reported line number.
 */
function maskRegularExpressionLiterals(source: string, sourceFile: ts.SourceFile): string {
  // `split("")` deliberately preserves UTF-16 code-unit offsets used by the
  // TypeScript AST (unlike `[...source]`, which combines surrogate pairs).
  const masked = source.split("");
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) {
      for (let index = node.getStart(sourceFile); index < node.end; index += 1) {
        if (!isEcmascriptLineTerminator(masked[index])) masked[index] = " ";
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return masked.join("");
}

function isEcmascriptLineTerminator(ch: string | undefined): boolean {
  return ch === "\r" || ch === "\n" || ch === "\u2028" || ch === "\u2029";
}

/** 1-based source line, treating CRLF as the single terminator sequence it is. */
function sourceLineNumber(source: string, end: number): number {
  let line = 1;
  for (let index = 0; index < end; index += 1) {
    const ch = source[index];
    if (ch === "\r") {
      line += 1;
      if (source[index + 1] === "\n") index += 1;
    } else if (ch === "\n" || ch === "\u2028" || ch === "\u2029") {
      line += 1;
    }
  }
  return line;
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
    let end = i + 2;
    while (end < src.length && !isEcmascriptLineTerminator(src[end])) end += 1;
    return end;
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
  /** Full normalized static text: the stable identity used by site-scoped exemptions. */
  readonly site: string;
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
function findUnreadableValues(
  src: string,
  source: string,
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): string[] {
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
  // The byte walker above deliberately retains its readable member-chain
  // diagnostics, but ASCII character classes cannot recognize valid Unicode
  // identifiers and skip the digits in source escapes such as `\u0061`.
  // Supplement only those spellings from the TypeScript AST. Ordinary ASCII
  // identifiers keep the established scanner output and count behavior.
  const visitIdentifier = (node: ts.Node): void => {
    const nodeStart = node.getStart(sourceFile);
    if (node.end <= start || nodeStart >= end) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      return;
    }
    if (ts.isIdentifier(node) && nodeStart >= start && node.end <= end) {
      const raw = source.slice(nodeStart, node.end);
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw)) {
        const isTernaryCondition =
          ts.isConditionalExpression(node.parent) && node.parent.condition === node;
        if (!isTernaryCondition) {
          found.add(`bare value \`${raw}\` at code level — this scanner cannot read it`);
        }
      }
    }
    ts.forEachChild(node, visitIdentifier);
  };
  visitIdentifier(sourceFile);
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
  const consumed: Array<[number, number]> = [];
  const sourceFile = createAuditSourceFile(source);
  const scanSource = maskRegularExpressionLiterals(source, sourceFile);
  const templateBoundaries = collectTemplateInterpolationBoundaries(sourceFile);
  for (const { open, close, prefixText } of findLogCallBoundaries(source, sourceFile)) {
    // Skip a call we already swallowed as part of an enclosing log statement.
    if (consumed.some(([s, e]) => open > s && open < e)) continue;
    const found: Array<{ text: string; index: number }> = [];
    const literalOut = { text: "" };
    collectInterpolations(scanSource, open + 1, close, found, literalOut);
    if (!prefixes.some((prefix) => prefixText.includes(prefix))) continue;
    consumed.push([open, close]);
    const site = literalOut.text.replace(/\s+/g, " ").trim();
    const statement = site.slice(0, 90);
    statements.push({
      literal: statement,
      site,
      line: sourceLineNumber(source, open),
      unreadable: findUnreadableValues(scanSource, source, sourceFile, open + 1, close),
      interpolations: found.map((interp) => {
        const boundary = templateBoundaries.get(interp.index);
        return {
          expression: interp.text.replace(/\s+/g, " ").trim(),
          line: sourceLineNumber(source, interp.index),
          statement,
          site,
          cookedLeft: boundary?.cookedLeft ?? "",
          cookedRight: boundary?.cookedRight ?? "",
          interpolationBefore: boundary?.interpolationBefore ?? true,
          interpolationAfter: boundary?.interpolationAfter ?? true,
          boundaryKnown: boundary !== undefined && boundary.boundaryKnown,
        };
      }),
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
  const canonicalBinding = hasCanonicalUnshadowedLogSafe(source, options.file);
  const consumedAllowances = new Set<number>();
  for (const statement of findLogStatements(source, options.prefixes)) {
    for (const interp of statement.interpolations) {
      const expr = interp.expression;
      if (isSafeWrapperCall(interp, canonicalBinding)) continue;
      const allowanceIndex = ALLOWED_RAW_INTERPOLATIONS.findIndex(
        (allowance, index) =>
          !consumedAllowances.has(index) &&
          allowance.file === options.file &&
          allowance.site === statement.site &&
          allowance.expression === expr,
      );
      if (allowanceIndex >= 0) {
        consumedAllowances.add(allowanceIndex);
        continue;
      }
      violations.push({ ...interp, file: options.file });
    }
    // Report what the scanner cannot read, rather than passing it silently.
    for (const warning of statement.unreadable) {
      violations.push({
        expression: warning,
        line: statement.line,
        statement: statement.literal,
        site: statement.site,
        cookedLeft: "",
        cookedRight: "",
        interpolationBefore: false,
        interpolationAfter: false,
        boundaryKnown: false,
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
 * A line-number-free but exact identity for a violation. Diagnostics abbreviate
 * `statement` for readability; baselines use the full site and file so one long
 * same-expression record cannot transfer an exemption to a neighbouring site.
 */
export function violationKey(violation: LogViolation): string {
  return `${violation.file}  ::  ${violation.expression}  @  ${violation.site}`;
}
