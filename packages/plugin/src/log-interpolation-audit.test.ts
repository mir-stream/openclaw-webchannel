import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, it, expect } from "vitest";

import { logSafe } from "./log-safe.js";
import {
  ALLOWED_RAW_INTERPOLATIONS,
  findLogStatements,
  findUnsafeLogInterpolations,
  formatViolations,
  rawInterpolationAllowanceKey,
  violationKey,
} from "./test-fixtures/log-interpolation-audit.js";
import { decodeStrictLogfmt } from "./test-fixtures/strict-logfmt.js";

/**
 * #123 — no peer-controlled value reaches a log record raw.
 *
 * This replaces a per-site guard list. Enumerating sites is how #123 got three
 * follow-up rounds: the first pass fixed the two sites the issue named, review
 * found four more, the next found six more.
 *
 * WHAT THIS COVERS — stated as narrowly as it is true, because four rounds of
 * review have found the guard's claim to be the defect, not the fix.
 *
 * For a call in one of the ENFORCED files, reached through a callee
 * `isLogCallee` recognises, whose runtime-cooked STATIC TEXT carries one of
 * `WEBCHANNEL_PREFIXES`: every value that reaches the record is either a
 * `logSafe(…)` call, an allowlisted safe value, a documented baseline entry, or
 * a reported violation. There is no quiet fourth case — anything the scanner
 * cannot read as a value is reported (see `findUnreadableValues`).
 *
 * THREE NAMED BLIND SPOTS. Each is a place a raw value could reach a record
 * without this guard saying anything:
 *
 *   1. VARIABLE-FIRST RECORDS. `const m = `…`; logger.error(m)` needs dataflow.
 *      This is not hypothetical: `nats-account-runtime.ts:339-341` builds
 *      `event=webchannel.invalid_account_id` exactly this way, and this guard
 *      does not see it. (Its one interpolation is `formatAccountIdForLog`, so
 *      it is baseline-class debt, not a live hole — but it is invisible here.)
 *   2. UNRECOGNISED CALLEES. `isLogCallee` matches on name shape. An alias
 *      (`const w = logger.warn; w(…)`) or `.call(…)` is missed.
 *   3. PREFIX SCOPE. A statement inside an enforced file is skipped if its text
 *      carries no listed prefix. This bit us: the `event=webchannel.*` family
 *      was invisible in `nats-account-runtime.ts` until `event=webchannel` was
 *      added below. `nats-channel.ts` had the same gap until `[nats-channel]`
 *      was added below. Adding a file to ENFORCED without its prefix enforces
 *      nothing while looking like it does.
 *
 * The TypeScript AST supplies exact outer call boundaries (including across
 * regex literals); the inner value walk remains deliberately conservative and
 * reports shapes it cannot read.
 */

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

/**
 * Prefixes that mark a line as a webchannel log record.
 *
 * `event=webchannel` is here because `nats-account-runtime.ts` writes six
 * structured records in that style with no `webchannel:` prefix at all. Without
 * it the scanner reported 16 statements for that file and silently skipped
 * them, so a peer field added to the `event=` family would have shipped green.
 */
const WEBCHANNEL_PREFIXES = [
  "webchannel:",
  "[webchannel]",
  "event=webchannel",
  "[nats-channel]",
];

/** The files #123 hardened. These must stay clean. */
const ENFORCED = [
  "inbound.ts",
  "ingress-dedupe.ts",
  "approvals.ts",
  "nats-account-runtime.ts",
  "auth.ts",
  "nats-channel.ts",
  "history.ts",
  "nats-register.ts",
] as const;

/**
 * KNOWN, DOCUMENTED DEBT — interpolations that are still raw, deliberately.
 *
 * Pinned rather than excluded: a new raw value in any of these files still
 * fails, while the ones already there do not block #123. Keys omit line
 * numbers so unrelated edits do not churn this list.
 *
 * Removing an entry is a DELIBERATE edit: fixing a site must also retire its
 * baseline, which is how this list shrinks to nothing instead of rotting.
 */
const KNOWN_RAW: Record<string, readonly string[]> = {
  "inbound.ts": [],
  "ingress-dedupe.ts": [],

  "approvals.ts": [],

  /**
   * Startup/config logging, NOT the peer path: `accountId` and `tenant` are
   * operator-configured, `source.mode` is a closed enum, `formatRelayOrigin`
   * formats a dialed URL from config. Escaping them would be harmless but is
   * out of #123's scope, which is peer-controlled values.
   */
  "nats-account-runtime.ts": [
    `nats-account-runtime.ts  ::  accountId  @  "warn"[webchannel] account "": auth.cors is OBSOLETE and IGNORED — the register hop moved from HTTP to NATS, so browser-origin allowlisting no longer applies. Remove the auth.cors block. Access control is the SaaS-minted per-peer NATS credential scope.`,
    `nats-account-runtime.ts  ::  formatAccountIdForLog(accountId)  @  "warn"event=webchannel.account_startup accountId= state=retry_scheduled attempt= delayMs= code=`,
    `nats-account-runtime.ts  ::  failure.code  @  "warn"event=webchannel.account_startup accountId= state=retry_scheduled attempt= delayMs= code=`,
    `nats-account-runtime.ts  ::  formatAccountIdForLog(accountId)  @  "info"event=webchannel.account_startup accountId= state=recovered attempt= failedAttempts= outageMs=`,
    `nats-account-runtime.ts  ::  formatAccountIdForLog(accountId)  @  "info"event=webchannel.account_transport accountId= state=recovered`,
    `nats-account-runtime.ts  ::  formatAccountIdForLog(accountId)  @  "error"event=webchannel.account_transport accountId= state=error code=transport-error`,
    `nats-account-runtime.ts  ::  formatAccountIdForLog(accountId)  @  "info"[webchannel] account credential source: →`,
    `nats-account-runtime.ts  ::  source.mode  @  "info"[webchannel] account credential source: →`,
    `nats-account-runtime.ts  ::  formatRelayOrigin(consumed.dialedUrl)  @  "info"[webchannel] account credential source: →`,
    `nats-account-runtime.ts  ::  accountId  @  "info"[webchannel] account "" ✓ encrypted NATS channel (tenant=, accountId=)`,
    `nats-account-runtime.ts  ::  tenant  @  "info"[webchannel] account "" ✓ encrypted NATS channel (tenant=, accountId=)`,
    `nats-account-runtime.ts  ::  accountId  @  "info"[webchannel] account "" ✓ encrypted NATS channel (tenant=, accountId=)`,
    `nats-account-runtime.ts  ::  formatAccountIdForLog(accountId)  @  "warn"event=webchannel.account_cleanup accountId= errors=`,
    `nats-account-runtime.ts  ::  formatAccountIdForLog(accountId)  @  "info"event=webchannel.account_startup accountId= state=stopped attempt=`,
  ],
  "auth.ts": [],
  "nats-channel.ts": [],
  "history.ts": [],
  "nats-register.ts": [],
};

/**
 * MEASURED coverage floors, per file.
 *
 * A global `>= 40` with a per-file `> 0` let a SCOPED regression pass: a
 * scanner that silently returned one statement for `inbound.ts` only — the file
 * carrying `turnId`, the value this whole issue is about — kept the suite green
 * while five peer interpolations were reverted to raw. The global total stayed
 * above 40 because the other three files still reported fully.
 *
 * These are the real numbers. If a legitimate edit changes one, update it
 * DELIBERATELY — that is the point.
 */
const COVERAGE_FLOOR: Record<string, { statements: number; interpolations: number }> = {
  "inbound.ts": { statements: 6, interpolations: 12 },
  "ingress-dedupe.ts": { statements: 13, interpolations: 7 },
  "approvals.ts": { statements: 9, interpolations: 24 },
  "nats-account-runtime.ts": { statements: 22, interpolations: 44 },
  "auth.ts": { statements: 16, interpolations: 5 },
  "nats-channel.ts": { statements: 22, interpolations: 33 },
  "history.ts": { statements: 6, interpolations: 4 },
  "nats-register.ts": { statements: 18, interpolations: 20 },
};

describe("log-record integrity — enforced files (#123)", () => {
  /**
   * Exact MULTISET equality against the baseline, in one assertion.
   *
   * Was two tests using `includes`, which made a baseline key a PATTERN: one
   * entry silently absorbed any number of matching violations. Counts now have
   * to match, and `violationKey` includes the full file + static site, so neither
   * a duplicate occurrence nor a different record sharing a long prefix can
   * arrive pre-exempted. This also collapses "no new violation" and "no stale
   * entry" into the single property both were approximating.
   */
  it.each(ENFORCED)("%s matches its documented baseline exactly", (file) => {
    const live = findUnsafeLogInterpolations(read(file), {
      file,
      prefixes: WEBCHANNEL_PREFIXES,
    });
    // Sorted so the diff on failure reads as added/removed lines, and so
    // ordering inside the source is not accidentally pinned.
    expect(live.map(violationKey).sort()).toEqual([...KNOWN_RAW[file]!].sort());
    // `formatViolations` carries line numbers; surface them when the set is
    // wrong so the failure names the site, not just the expression.
    if (live.length !== KNOWN_RAW[file]!.length) {
      expect(formatViolations(live)).toEqual([]);
    }
  });

  it.each(ENFORCED)("%s keeps its MEASURED coverage (scoped-regression guard)", (file) => {
    const statements = findLogStatements(read(file), WEBCHANNEL_PREFIXES);
    const interpolations = statements.reduce((n, s) => n + s.interpolations.length, 0);
    expect({
      statements: statements.length,
      interpolations,
    }).toEqual(COVERAGE_FLOOR[file]);
  });

  it("approvals.ts sweeps every console.warn even when its prefix is new", () => {
    // Like index-nats-wiring's whole-source contracts, discover the complete
    // production surface instead of pinning a list of today's call sites.
    // A future warning with a new prefix is isolated and checked with the empty
    // prefix, so it cannot land outside WEBCHANNEL_PREFIXES and disappear.
    const source = read("approvals.ts");
    const sourceFile = ts.createSourceFile(
      "approvals.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const calls: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "console.warn") {
        calls.push(node.getText(sourceFile));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const violations = calls.flatMap((call) =>
      findUnsafeLogInterpolations(
        `import { logSafe } from "./log-safe.js";\n${call}`,
        { file: "approvals.ts", prefixes: [""] },
      ),
    );
    expect(formatViolations(violations)).toEqual([]);
  });

  it("every allowlist entry is still LIVE in a scanned file", () => {
    // Mirrors the KNOWN_RAW staleness test. Without it, exemptions rot: five
    // entries here were already dead, naming expressions in `nats-channel.ts`
    // and `ingress-outcome.ts` — files no prefix reaches.
    // If either is ever added to ENFORCED they would arrive PRE-EXEMPTED on
    // reasons nobody re-verified.
    const liveCounts = new Map<string, number>();
    for (const file of ENFORCED) {
      for (const statement of findLogStatements(read(file), WEBCHANNEL_PREFIXES)) {
        for (const interpolation of statement.interpolations) {
          const key = rawInterpolationAllowanceKey({
            file,
            site: statement.site,
            expression: interpolation.expression,
          });
          liveCounts.set(key, (liveCounts.get(key) ?? 0) + 1);
        }
      }
    }
    const dead = ALLOWED_RAW_INTERPOLATIONS.filter((allowance) => {
      const key = rawInterpolationAllowanceKey(allowance);
      const remaining = liveCounts.get(key) ?? 0;
      if (remaining === 0) return true;
      liveCounts.set(key, remaining - 1);
      return false;
    });
    expect(dead).toEqual([]);
  });
});

describe("strict logfmt record terminators (#123)", () => {
  const terminators = [
    ["LF", "\n"],
    ["CR", "\r"],
    ["CRLF", "\r\n"],
    ["NEL", "\u0085"],
    ["LINE SEPARATOR", "\u2028"],
    ["PARAGRAPH SEPARATOR", "\u2029"],
  ] as const;

  it.each(terminators)("rejects a raw %s before it can start a second field", (_name, mark) => {
    expect(() => decodeStrictLogfmt(`peer=trusted${mark}forged=true`)).toThrow(
      /logfmt records must be single-line/,
    );
  });

  it.each(terminators)("accepts a logSafe-escaped %s as one field value", (_name, mark) => {
    const hostile = `trusted${mark}forged=true`;
    const record = `peer=${logSafe(hostile)} outcome=ok`;
    expect(record).not.toContain(mark);
    const fields = decodeStrictLogfmt(record);
    expect(fields.get("peer")).toBe(hostile);
    expect(fields.has("forged")).toBe(false);
    expect(fields.get("outcome")).toBe("ok");
  });
});

/**
 * The checker's own red-proof.
 *
 * A guard whose whole purpose is to defeat evasion has to be SEEN red in every
 * shape it claims to cover, against source it does not control. Each case below
 * is a shape that walked through the previous regex version green.
 */
describe("the checker catches every known evasion (#123)", () => {
  const canonicalImport = 'import { logSafe } from "./log-safe.js";\n';
  const check = (
    src: string,
    options: { readonly file?: string; readonly prependCanonicalImport?: boolean } = {},
  ) => formatViolations(findUnsafeLogInterpolations(
    `${options.prependCanonicalImport === false ? "" : canonicalImport}${src}`,
    { file: options.file ?? "probe.ts", prefixes: WEBCHANNEL_PREFIXES },
  ));

  it("EVASION 1: a raw value on a continuation fragment", () => {
    // The house style for long records — and the shape the regex version could
    // not see, because it stopped at the first closing backtick.
    const violations = check(
      "api.logger?.warn?.(`webchannel: probe ` +\n  `peer=${peerId} id=${message.id}`);",
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("${peerId}");
    expect(violations[1]).toContain("${message.id}");
  });

  it("EVASION 2: a nested template inside an interpolation", () => {
    const violations = check(
      'api.logger?.warn?.(`webchannel: probe ${message.id ? `id=${message.id}` : ""} peer=${peerId}`);',
    );
    // Both the outer conditional and the inner raw read are reported.
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(violations.join("\n")).toContain("${peerId}");
    expect(violations.join("\n")).toContain("message.id");
  });

  it("EVASION 3: a renamed identifier the old denylist never spelled", () => {
    const violations = check("api.logger?.warn?.(`webchannel: probe peer=${entry.peerId}`);");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("${entry.peerId}");
  });

  it("EVASION 4: `${(err as Error).message}`, a live idiom in this repo", () => {
    // Used in jwks.ts, nats-register.ts:278 and nats-credential-source.ts:352 —
    // not an invented shape.
    const violations = check(
      "api.logger.error?.(`webchannel: probe failed: ${(err as Error).message}`);",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("(err as Error).message");
  });

  it("EVASION 5: an aliased local", () => {
    const violations = check("const p = peerId;\napi.logger?.warn?.(`webchannel: probe ${p}`);");
    expect(violations).toHaveLength(1);
  });

  it.each([
    ["non-ASCII", "const π = peerId; console.warn(\"webchannel: peer=\" + π);", "π"],
    [
      "source-escaped",
      "const \\u0061 = peerId; console.warn(\"webchannel: peer=\" + \\u0061);",
      "\\u0061",
    ],
  ])("EVASION 13: a valid %s TypeScript identifier fails loud", (_name, source, spelling) => {
    expect(findLogStatements(source, WEBCHANNEL_PREFIXES)).toHaveLength(1);
    const violations = check(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(spelling);
  });

  it("accepts logSafe across the same shapes it rejects raw", () => {
    expect(
      check("api.logger?.warn?.(`webchannel: probe ` +\n  `peer=${logSafe(peerId)}`);"),
    ).toEqual([]);
    expect(check("api.logger?.warn?.(`webchannel: probe ${logSafe(entry.peerId)}`);")).toEqual([]);
    expect(
      check("api.logger.error?.(`webchannel: probe: ${logSafe(err as Error)}`);"),
    ).toEqual([]);
  });

  it("EVASION 15: static quotes cannot wrap a logSafe token", () => {
    const violations = check(
      'api.logger.warn(`webchannel: peer="${logSafe(peerId)}" outcome=ok`);',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("logSafe(peerId)");
    expect(
      check('console.warn(`webchannel: peer="` + `${logSafe(peerId)}` + `"`);'),
    ).toHaveLength(1);

    const emitted = `webchannel: peer="${logSafe("x outcome=forged")}" outcome=ok`;
    expect(emitted).toBe('webchannel: peer=""x outcome=forged"" outcome=ok');
    expect(() => decodeStrictLogfmt(emitted)).toThrow(
      /invalid character after quoted logfmt value/,
    );
  });

  it("rejects identifier-like token prefixes and suffixes around logSafe", () => {
    expect(check("console.warn(`webchannel: peer=prefix${logSafe(peerId)}`);")).toHaveLength(1);
    expect(check("console.warn(`webchannel: peer=${logSafe(peerId)}suffix`);")).toHaveLength(1);
    // Concatenation cannot hide the same runtime adjacency on another fragment.
    expect(
      check("console.warn(`webchannel: peer=${logSafe(peerId)}` + `suffix`);"),
    ).toHaveLength(1);

    const prefixed = `webchannel: peer=prefix${logSafe("x outcome=forged")}`;
    const suffixed = `webchannel: peer=${logSafe("x outcome=forged")}suffix outcome=ok`;
    expect(() => decodeStrictLogfmt(prefixed)).toThrow(/invalid bare logfmt value/);
    expect(() => decodeStrictLogfmt(suffixed)).toThrow(
      /invalid character after quoted logfmt value/,
    );
  });

  it.each([
    ["prefix", "-"],
    ["suffix", "-"],
    ["prefix", ","],
    ["suffix", ","],
    ["prefix", ":"],
    ["suffix", ":"],
    ["prefix", "="],
    ["suffix", "="],
  ] as const)(
    "EVASION 17: rejects a logfmt field with a %s %s",
    (position, punctuation) => {
      const source =
        position === "prefix"
          ? `console.warn(\`webchannel: peer=${punctuation}\${logSafe(peerId)}\`);`
          : `console.warn(\`webchannel: peer=\${logSafe(peerId)}${punctuation}\`);`;
      expect(check(source)).toHaveLength(1);

      const emitted =
        position === "prefix"
          ? `peer=${punctuation}${logSafe("id")}`
          : `peer=${logSafe("id")}${punctuation}`;
      expect(() => decodeStrictLogfmt(emitted)).toThrow();
    },
  );

  it.each([
    ["split prefix", 'console.warn("webchannel: peer=" + `-${logSafe(peerId)}`);'],
    ["split suffix", 'console.warn(`webchannel: peer=${logSafe(peerId)}` + "-suffix");'],
    [
      "multi-fragment prefix",
      'console.warn("webchannel: " + "peer=" + `-${logSafe(peerId)}`);',
    ],
    [
      "source-cooked prefix",
      'console.warn("webchannel: pe\\u0065r=" + `\\u002d${logSafe(peerId)}`);',
    ],
    [
      "source-cooked suffix",
      'console.warn(`webchannel: peer=${logSafe(peerId)}` + "\\u002dsuffix");',
    ],
  ])("rejects a field boundary hidden by a %s", (_name, source) => {
    expect(check(source)).toHaveLength(1);
  });

  it("EVASION 18: checks the complete conditional runtime edge, not its last byte", () => {
    const source =
      'console.warn("webchannel:" + (flag ? " peer=" : " peer=-=") + ' +
      '`${logSafe(peerId)} outcome=ok`);';
    expect(check(source)).toHaveLength(1);

    const emitted = `webchannel:${false ? " peer=" : " peer=-="}${logSafe("id")} outcome=ok`;
    expect(() => decodeStrictLogfmt(emitted)).toThrow(/invalid bare logfmt value/);
  });

  it("fails loud when an unknown outer edge leaves only an incomplete field delimiter", () => {
    const source =
      'console.warn("webchannel: " + [] + `=${logSafe(peerId)} outcome=ok`);';
    expect(check(source)).toHaveLength(1);

    const emitted = `webchannel: ${[]}=${logSafe("id")} outcome=ok`;
    expect(() => decodeStrictLogfmt(emitted)).toThrow(/invalid logfmt key/);
  });

  it("rejects directly adjacent logSafe interpolations", () => {
    expect(
      check("console.warn(`webchannel: pair=${logSafe(first)}${logSafe(second)}`);"),
    ).toHaveLength(2);
    expect(
      check("console.warn(`webchannel: pair=${logSafe(first)}` + `${logSafe(second)}`);"),
    ).toHaveLength(2);
  });

  it.each([
    [
      "quotes",
      "console.warn(`webchannel: peer=\\u0022${logSafe(peerId)}\\x22`);",
    ],
    ["token prefix", "console.warn(`webchannel: peer=\\u0078${logSafe(peerId)}`);"],
    ["token suffix", "console.warn(`webchannel: peer=${logSafe(peerId)}\\u0078`);"],
    ["backslash", "console.warn(`webchannel: peer=\\\\${logSafe(peerId)}`);"],
  ])("rejects a source-escaped static %s boundary", (_name, source) => {
    expect(check(source)).toHaveLength(1);
  });

  it.each([
    ["logfmt field", "console.warn(`webchannel: peer=${logSafe(peerId)} outcome=ok`);"],
    ["logfmt field at end", "console.warn(`webchannel: peer=${logSafe(peerId)}`);"],
    [
      "split logfmt field",
      'console.warn("webchannel: peer=" + `${logSafe(peerId)}` + " outcome=ok");',
    ],
    ["prose colon", "console.warn(`webchannel: failed for ${logSafe(peerId)}: retrying`);"],
    ["parenthesized", "console.warn(`webchannel: approval (${logSafe(id)}): ignored`);"],
  ])("accepts the owned %s token boundary", (_name, source) => {
    expect(check(source)).toEqual([]);
  });

  it("accepts a conditional field edge only when every cooked branch is identical", () => {
    expect(
      check(
        'console.warn("webchannel:" + (flag ? " peer=" : " pe\\u0065r=") + ' +
          '`${logSafe(peerId)} outcome=ok`);',
      ),
    ).toEqual([]);
  });

  it("scopes raw allowances by file and concrete statement, with one-use semantics", () => {
    const allowedSite =
      "api.logger?.warn?.(`webchannel: turn_settled was not delivered for " +
      "peer=${logSafe(wsKey)} turn=${logSafe(settleId)} outcome=${turnOutcome}`);";

    // The exact expression at an unrelated site cannot inherit the allowance.
    expect(check("api.logger?.info?.(`webchannel: attacker=${turnOutcome}`);", {
      file: "inbound.ts",
    })).toHaveLength(1);
    // Nor can the exact allowed statement in another file.
    expect(check(allowedSite)).toHaveLength(1);
    // One allowance cannot silently absorb a duplicated site in its own file.
    expect(check(`${allowedSite}\n${allowedSite}`, { file: "inbound.ts" })).toHaveLength(1);
  });

  it("keys baseline debt by the full site, not the abbreviated diagnostic prefix", () => {
    const common = `webchannel: ${"same-prefix-".repeat(10)}`;
    const source = [
      `console.warn(\`${common}first peer=\${peerId}\`);`,
      `console.warn(\`${common}second peer=\${peerId}\`);`,
    ].join("\n");
    const violations = findUnsafeLogInterpolations(`${canonicalImport}${source}`, {
      file: "probe.ts",
      prefixes: WEBCHANNEL_PREFIXES,
    });
    expect(violations).toHaveLength(2);
    expect(violations[0]!.statement).toBe(violations[1]!.statement);
    expect(violations[0]!.site).not.toBe(violations[1]!.site);
    expect(new Set(violations.map(violationKey)).size).toBe(2);
  });

  it("trusts only the unshadowed canonical logSafe named import", () => {
    const call = "api.logger?.warn?.(`webchannel: peer=${logSafe(peerId)}`);";
    expect(check(call)).toEqual([]);
    expect(check(
      `import { logSafe } from "./not-log-safe.js";\n${call}`,
      { prependCanonicalImport: false },
    )).toHaveLength(1);
    expect(check(`function probe() { const logSafe = String; ${call} }`)).toHaveLength(1);
    expect(check(`function probe(logSafe: (value: unknown) => string) { ${call} }`)).toHaveLength(1);
  });

  it("EVASION 6: `logSafe(x)` that is only the PREFIX of a bigger expression", () => {
    // `.slice()` truncates mid-value and can drop the closing quote, so the
    // next field's key is swallowed into this one — field injection, restored,
    // via an expression the prefix/suffix check blessed.
    const truncated = check("api.logger?.warn?.(`webchannel: peer=${logSafe(peerId).slice(0, 20)}`);");
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toContain("logSafe(peerId).slice(0, 20)");

    const fallback = check(
      "api.logger?.warn?.(`webchannel: peer=${logSafe(a) || String(peerId)}`);",
    );
    expect(fallback).toHaveLength(1);

    // A genuine nested call inside the escaper is still fine.
    expect(check("api.logger?.warn?.(`webchannel: peer=${logSafe(pick(a, b))}`);")).toEqual([]);
  });

  it("EVASION 7: concatenation and join, whose operands the ${…} walk cannot see", () => {
    expect(
      check('api.logger?.warn?.("webchannel: dropped peer=" + peerId + " id=" + message.id);'),
    ).not.toEqual([]);
    expect(
      check('api.logger?.warn?.(["webchannel: dropped", "peer=" + peerId].join(" "));'),
    ).not.toEqual([]);
    // The house style — template + template, and template + parenthesised
    // group — must stay legal, or every real log line in the repo goes red.
    expect(
      check("api.logger?.warn?.(`webchannel: a ` + `peer=${logSafe(peerId)}`);"),
    ).toEqual([]);
    expect(
      check('api.logger?.warn?.(`webchannel: a ` + (x ? `b=${logSafe(b)}` : ""));'),
    ).toEqual([]);
  });

  it("EVASION 9: a PARENTHESISED bare operand — the group must be read, not accepted", () => {
    // The previous `scannable` helper returned true for a neighbouring `(` and
    // nothing ever descended. Every one of these was green.
    //
    // The first is the live ack site with `message.text` appended: the
    // browser's own message body, arbitrary length, arbitrary newlines.
    expect(
      check(
        "api.logger?.warn?.(`webchannel: control-lane ack failed for peer=${logSafe(peerId)}` + (message.text ?? \"\"));",
      ),
    ).not.toEqual([]);
    // Parentheses are MANDATORY syntax here, so the single most likely raw-error
    // concatenation in the codebase was the one that evaded.
    expect(
      check("api.logger?.warn?.(`webchannel: probe failed: ` + (err as Error).message);"),
    ).not.toEqual([]);
    expect(check("api.logger?.warn?.(`webchannel: probe ` + (peerId));")).not.toEqual([]);
    expect(check('api.logger?.warn?.(`webchannel: probe ` + (id ? id : "none"));')).not.toEqual(
      [],
    );
    // Mixed group: the template branch is scanned, the bare branch was not.
    expect(
      check('api.logger?.warn?.(`webchannel: probe ` + (x ? `a=${logSafe(a)}` : peerId));'),
    ).not.toEqual([]);
  });

  it("EVASION 10: `.concat(`, the sibling of `+` and `.join(`", () => {
    expect(
      check('api.logger?.warn?.("webchannel: peer=".concat(peerId, " id=", message.id));'),
    ).not.toEqual([]);
    expect(
      check("api.logger?.warn?.(`webchannel: peer=`.concat(peerId));"),
    ).not.toEqual([]);
  });

  it("EVASION 11: an `event=`-prefixed record, invisible until its prefix was listed", () => {
    // `nats-account-runtime.ts` writes six records in this style. `log("warn", …)`
    // was always a recognised callee; only the prefix list excluded them.
    const violations = check(
      "api.logger?.warn?.(`event=webchannel.control_lane_ack_failed peer=${peerId} id=${message.id}`);",
    );
    expect(violations).toHaveLength(2);
    expect(violations.join("\n")).toContain("${peerId}");
    expect(violations.join("\n")).toContain("${message.id}");
  });

  it.each([
    ["quoted fragments", 'console.warn("webchannel" + ": peer=" + peerId);'],
    ["source escape", 'console.warn("\\u0077ebchannel: peer=" + peerId);'],
  ])("EVASION 14: detects a runtime-cooked prefix across %s", (_name, source) => {
    expect(findLogStatements(source, WEBCHANNEL_PREFIXES)).toHaveLength(1);
    const violations = check(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("peerId");
  });

  it.each([
    ["closing parenthesis", "console.warn(/)/, `webchannel: peer=${peerId}`);"],
    ["backtick", "console.warn(/`/, `webchannel: peer=${peerId}`);"],
    ["quote", 'console.warn(/"/, `webchannel: peer=${peerId}`);'],
  ])("EVASION 12: regex content (%s) cannot hide a later raw value", (_name, source) => {
    expect(findLogStatements(source, WEBCHANNEL_PREFIXES)).toHaveLength(1);
    const violations = check(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("${peerId}");
  });

  it.each([
    ["LF", "\n"],
    ["CR", "\r"],
    ["CRLF", "\r\n"],
    ["LINE SEPARATOR", "\u2028"],
    ["PARAGRAPH SEPARATOR", "\u2029"],
  ])("EVASION 16: a %s ends a line comment", (_name, separator) => {
    const source = `console.warn("webchannel: peer=" + // comment${separator} peerId);`;
    const diagnostics = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.Latest },
      reportDiagnostics: true,
    }).diagnostics ?? [];
    expect(diagnostics).toEqual([]);
    expect(findLogStatements(source, WEBCHANNEL_PREFIXES)).toHaveLength(1);
    const violations = check(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("peerId");

    // The same terminator drives diagnostic lines; CRLF counts only once.
    const templated =
      `console.warn("webchannel: peer=" + // comment${separator}` +
      "`peer=${peerId}`);";
    const interpolation = findLogStatements(templated, WEBCHANNEL_PREFIXES)[0]?.interpolations[0];
    expect(interpolation?.line).toBe(2);
  });

  it("accepts canonical logSafe whose argument contains a regex delimiter trap", () => {
    expect(check("console.warn(`webchannel: pattern=${logSafe(/`/)}`);")).toEqual([]);
  });

  it("EVASION 8: `debugLog`, the callee spelling that fails both name rules", () => {
    // "debuglog" is not in the exact list and does not start with "log".
    const violations = check("this.debugLog(`webchannel: probe peer=${peerId}`);");
    expect(violations).toHaveLength(1);
    expect(check("api.logger?.trace?.(`webchannel: probe peer=${peerId}`);")).toHaveLength(1);
    expect(check("emitDiagnostic(`webchannel: probe peer=${peerId}`);")).toHaveLength(1);
  });

  it("ignores the dedupe KEYS, which are map lookups and must stay raw", () => {
    // `${peerId}:${id}` builds a cache key, not a log record. Scoping by log
    // prefix keeps these out without needing an exemption for `peerId` itself.
    expect(check("processIngressOutcomes.peek(accountId, `${peerId}:${id}`);")).toEqual([]);
  });
});
