import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  ALLOWED_RAW_INTERPOLATIONS,
  findLogStatements,
  findUnsafeLogInterpolations,
  formatViolations,
  violationKey,
} from "./test-fixtures/log-interpolation-audit.js";

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
 * `isLogCallee` recognises, whose STATIC TEXT carries one of
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
 *      added below. `nats-channel.ts` is excluded the same way — by PREFIX, not
 *      by file — since its records read `[nats-channel]`. Adding a file to
 *      ENFORCED without adding its prefix enforces nothing while looking like
 *      it does.
 *
 * Regex literals are also not tokenised, so an expression containing one may
 * mis-parse — but it fails LOUD (a spurious violation), and the exact coverage
 * floors below catch a silent drop.
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
const WEBCHANNEL_PREFIXES = ["webchannel:", "[webchannel]", "event=webchannel"];

/** The files #123 hardened. These must stay clean. */
const ENFORCED = [
  "inbound.ts",
  "ingress-dedupe.ts",
  "approvals.ts",
  "nats-account-runtime.ts",
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

  /**
   * The `[webchannel]` console sites in the pending-approval store. These are
   * peer-derived (approval ids, session keys) and several carry the same
   * hard-coded-quote trap #123 fixed in the thrown messages — they are a filed
   * follow-up, deliberately NOT fixed here to keep this diff out of #93/#100
   * approval logic. The `webchannel:`-prefixed thrown messages in this same
   * file ARE enforced (empty baseline entries below would show as failures).
   */
  "approvals.ts": [
    'evicted.payload.id  @  [webchannel] pending-approval cap reached; evicting a still-',
    'evicted.accountKey  @  [webchannel] pending-approval cap reached; evicting a still-',
    'evicted.sessionKey  @  [webchannel] pending-approval cap reached; evicting a still-',
    'entry.payload.id  @  [webchannel] pending-approval "" (account "", peer "") prune',
    'entry.accountKey  @  [webchannel] pending-approval "" (account "", peer "") prune',
    'entry.sessionKey  @  [webchannel] pending-approval "" (account "", peer "") prune',
    "pendingPayload.id  @  [webchannel] approval not delivered: no live channel for acc",
    "accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID  @  [webchannel] approval not delivered: no live channel for acc",
    "pendingPayload.id  @  [webchannel] approval not delivered: no matching open socket",
    "sessionKey  @  [webchannel] approval not delivered: no matching open socket",
    "accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID  @  [webchannel] approval not delivered: no matching open socket",
    "entry.approvalId  @  [webchannel] approval resolve frame dropped: no live channel",
    "accountId ?? entry.accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID  @  [webchannel] approval resolve frame dropped: no live channel",
    "formatAccountIdForLog(rawAccountId)  @  [webchannel] event=webchannel.approval.origin_unresolved acc",
    "reason  @  [webchannel] event=webchannel.approval.origin_unresolved acc",
    "sessionKeyPresent  @  [webchannel] event=webchannel.approval.origin_unresolved acc",
  ],

  /**
   * Startup/config logging, NOT the peer path: `accountId` and `tenant` are
   * operator-configured, `source.mode` is a closed enum, `formatRelayOrigin`
   * formats a dialed URL from config. Escaping them would be harmless but is
   * out of #123's scope, which is peer-controlled values.
   */
  "nats-account-runtime.ts": [
    'accountId  @  "warn"[webchannel] account "": auth.cors is OBSOLETE and IGN',
    'formatAccountIdForLog(accountId)  @  "warn"event=webchannel.account_startup accountId= state=retr',
    'failure.code  @  "warn"event=webchannel.account_startup accountId= state=retr',
    'formatAccountIdForLog(accountId)  @  "info"event=webchannel.account_startup accountId= state=reco',
    'formatAccountIdForLog(accountId)  @  "info"event=webchannel.account_transport accountId= state=re',
    'formatAccountIdForLog(accountId)  @  "error"event=webchannel.account_transport accountId= state=e',
    'formatAccountIdForLog(accountId)  @  "info"[webchannel] account credential source: \u2192',
    'source.mode  @  "info"[webchannel] account credential source: \u2192',
    'formatRelayOrigin(consumed.dialedUrl)  @  "info"[webchannel] account credential source: \u2192',
    'accountId  @  "info"[webchannel] account "" \u2713 encrypted NATS channel (tena',
    'tenant  @  "info"[webchannel] account "" \u2713 encrypted NATS channel (tena',
    'accountId  @  "info"[webchannel] account "" \u2713 encrypted NATS channel (tena',
    'formatAccountIdForLog(accountId)  @  "warn"event=webchannel.account_cleanup accountId= errors=',
    'formatAccountIdForLog(accountId)  @  "info"event=webchannel.account_startup accountId= state=stop',
  ],
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
};

describe("log-record integrity — enforced files (#123)", () => {
  /**
   * Exact MULTISET equality against the baseline, in one assertion.
   *
   * Was two tests using `includes`, which made a baseline key a PATTERN: one
   * entry silently absorbed any number of matching violations, so a new site
   * reusing an expression and sharing the first 60 static characters would
   * arrive pre-exempted. Counts now have to match, so a second occurrence is a
   * failure. It also collapses "no new violation" and "no stale entry" into the
   * single property both were approximating.
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

  it("every allowlist entry is still LIVE in a scanned file", () => {
    // Mirrors the KNOWN_RAW staleness test. Without it, blanket file-agnostic
    // exemptions rot: five entries here were already dead, naming expressions
    // in `nats-channel.ts` and `ingress-outcome.ts` — files no prefix reaches.
    // If either is ever added to ENFORCED they would arrive PRE-EXEMPTED on
    // reasons nobody re-verified.
    const live = new Set(
      ENFORCED.flatMap((file) =>
        findLogStatements(read(file), WEBCHANNEL_PREFIXES).flatMap((s) =>
          s.interpolations.map((i) => i.expression),
        ),
      ),
    );
    const dead = [...ALLOWED_RAW_INTERPOLATIONS.keys()].filter((key) => !live.has(key));
    expect(dead).toEqual([]);
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
  const check = (src: string) =>
    formatViolations(findUnsafeLogInterpolations(src, { file: "probe.ts", prefixes: WEBCHANNEL_PREFIXES }));

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

  it("accepts logSafe across the same shapes it rejects raw", () => {
    expect(
      check("api.logger?.warn?.(`webchannel: probe ` +\n  `peer=${logSafe(peerId)}`);"),
    ).toEqual([]);
    expect(check("api.logger?.warn?.(`webchannel: probe ${logSafe(entry.peerId)}`);")).toEqual([]);
    expect(
      check("api.logger.error?.(`webchannel: probe: ${logSafe(err as Error)}`);"),
    ).toEqual([]);
  });

  it("allows an explicitly allowlisted safe value, and nothing near it", () => {
    expect(check("api.logger?.info?.(`webchannel: probe (${admission.reason})`);")).toEqual([]);
    // A neighbouring raw value in the same statement is still caught.
    const mixed = check(
      "api.logger?.info?.(`webchannel: probe (${admission.reason}) peer=${wsKey}`);",
    );
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toContain("${wsKey}");
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
