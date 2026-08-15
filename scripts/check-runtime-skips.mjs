#!/usr/bin/env node
/**
 * Audit runtime ctx.skip() against a small, committed per-file budget.
 *
 * This deliberately remains separate from check-test-inventory.mjs. The
 * inventory is a deterministic collection snapshot; replacing it with run
 * counts made environment-driven skips look like deleted tests and offered no
 * usable snapshot update. This guard instead compares that collected count to
 * the completed (passed or failed) assertions in one concrete run report.
 * Statically skipped/todo tests are absent from the collected count, so their
 * report entries do not become false runtime-skip findings.
 *
 * The rule is inverted: a file absent from runtime-skip-allowances.json has a
 * budget of ZERO. The two committed non-zero widths are visible debt. A width
 * can hide that many in-place ctx.skip replacements in its named file, but no
 * more and nowhere else. Their source callsite counts are checked reciprocally
 * so a fixed skip path makes its allowance stale and red instead of letting the
 * exemption rot.
 *
 * Usage:
 *   npm run test:runtime-skips -- <vitest-results.json>
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const INVENTORY = resolve(REPO, ".github/test-inventory.json");
const ALLOWANCES = resolve(REPO, ".github/runtime-skip-allowances.json");
const ALLOWANCE_REL = ".github/runtime-skip-allowances.json";
const REPORT_STATUSES = new Set(["passed", "failed", "skipped", "pending", "todo"]);

export class RuntimeSkipAuditError extends Error {}

function fail(message) {
  throw new RuntimeSkipAuditError(message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read ${label} at ${path}: ${error.message}`);
  }
}

function repoRelative(path) {
  const absolute = isAbsolute(path) ? path : resolve(REPO, path);
  const rel = relative(REPO, absolute).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../") || rel === "") {
    fail(`report path is outside the repository: ${path}`);
  }
  return rel;
}

function validateInventory(snapshot) {
  if (!object(snapshot) || !object(snapshot.files) || Object.keys(snapshot.files).length === 0) {
    fail(".github/test-inventory.json has no usable files map.");
  }
  for (const [file, count] of Object.entries(snapshot.files)) {
    if (!Number.isInteger(count) || count <= 0 || file.startsWith("/") || file.includes("\\")) {
      fail(`invalid inventory entry ${file}: ${JSON.stringify(count)}`);
    }
  }
  return snapshot.files;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/** Count executable ctx.skip() call expressions; comments and strings do not count. */
export function countCtxSkipCallsites(source, file = "source.ts") {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let count = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = unwrapExpression(node.expression.expression);
      if (node.expression.name.text === "skip" && ts.isIdentifier(receiver) && receiver.text === "ctx") {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

export function validateAllowances(snapshot, inventory, sourceFor = (file) => readFileSync(resolve(REPO, file), "utf8")) {
  if (!object(snapshot)) fail(`${ALLOWANCE_REL} is not a JSON object.`);
  const topKeys = Object.keys(snapshot);
  const unknownTop = topKeys.filter((key) => key !== "note" && key !== "files");
  if (unknownTop.length > 0 || typeof snapshot.note !== "string" || !object(snapshot.files)) {
    fail(`${ALLOWANCE_REL} has an invalid or unvalidated top-level shape.`);
  }

  const allowances = {};
  for (const [file, entry] of Object.entries(snapshot.files)) {
    if (!object(entry)) fail(`${ALLOWANCE_REL} entry ${file} is not an object.`);
    const keys = Object.keys(entry);
    const expectedKeys = ["ctxSkipCallsites", "maxRuntimeSkips", "reason"];
    if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
      fail(`${ALLOWANCE_REL} entry ${file} has an invalid or unvalidated shape.`);
    }
    if (!(file in inventory)) fail(`${ALLOWANCE_REL} entry ${file} is stale: the file is absent from the inventory.`);
    if (!Number.isInteger(entry.maxRuntimeSkips) || entry.maxRuntimeSkips <= 0 || entry.maxRuntimeSkips > inventory[file]) {
      fail(`${ALLOWANCE_REL} entry ${file} has invalid maxRuntimeSkips ${JSON.stringify(entry.maxRuntimeSkips)}.`);
    }
    if (!Number.isInteger(entry.ctxSkipCallsites) || entry.ctxSkipCallsites <= 0) {
      fail(`${ALLOWANCE_REL} entry ${file} has invalid ctxSkipCallsites ${JSON.stringify(entry.ctxSkipCallsites)}.`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      fail(`${ALLOWANCE_REL} entry ${file} needs a non-empty reason.`);
    }

    let source;
    try {
      source = sourceFor(file);
    } catch (error) {
      fail(`could not read allowance source ${file}: ${error.message}`);
    }
    const live = countCtxSkipCallsites(source, file);
    if (live !== entry.ctxSkipCallsites) {
      fail(
        `${ALLOWANCE_REL} entry ${file} is stale or incomplete: ` +
          `${entry.ctxSkipCallsites} committed ctx.skip callsite(s), ${live} live. ` +
          "Remove/reduce the allowance when a skip path is fixed; review and update it when one is added.",
      );
    }
    allowances[file] = entry;
  }
  return allowances;
}

/**
 * Pure report audit used by the CLI and its regression tests.
 * Returns per-file measurements or throws one combined, reviewable failure.
 */
export function auditRuntimeSkips(report, inventory, allowances) {
  if (!object(report) || !Array.isArray(report.testResults)) {
    fail("input is not a 'vitest run --reporter=json' report.");
  }

  const suites = new Map();
  for (const suite of report.testResults) {
    if (!object(suite) || typeof suite.name !== "string" || !Array.isArray(suite.assertionResults)) {
      fail("vitest report contains a malformed file result.");
    }
    const file = repoRelative(suite.name);
    if (suites.has(file)) fail(`vitest report contains duplicate results for ${file}.`);
    for (const assertion of suite.assertionResults) {
      if (!object(assertion) || !REPORT_STATUSES.has(assertion.status)) {
        fail(`${file} contains an unknown assertion status: ${JSON.stringify(assertion?.status)}.`);
      }
    }
    suites.set(file, suite.assertionResults);
  }

  const rows = [];
  const violations = [];
  for (const [file, collected] of Object.entries(inventory)) {
    const assertions = suites.get(file);
    if (!assertions) {
      violations.push(`  ${file}: report entry GONE (${collected} collected tests unaccounted for)`);
      continue;
    }
    const completed = assertions.filter((assertion) => assertion.status === "passed" || assertion.status === "failed").length;
    const runtimeSkipped = collected - completed;
    const allowed = allowances[file]?.maxRuntimeSkips ?? 0;
    rows.push({ file, collected, completed, runtimeSkipped, allowed });
    if (runtimeSkipped < 0) {
      violations.push(
        `  ${file}: ${completed} completed exceeds ${collected} collected ` +
          "(inventory/report mismatch; regenerate only after reviewing the test change)",
      );
    } else if (runtimeSkipped > allowed) {
      violations.push(`  ${file}: ${runtimeSkipped} runtime-skipped, allowance ${allowed}`);
    }
  }

  if (violations.length > 0) {
    fail(
      `runtime skip budget exceeded or run report incomplete in ${violations.length} file(s):\n` +
        `${violations.join("\n")}\n\n` +
        `Unlisted files allow zero. The only exceptions are committed in ${ALLOWANCE_REL}; ` +
        "do not add one for an intentional test deletion.",
    );
  }
  return rows;
}

function main(reportPath) {
  if (!reportPath) {
    console.error("usage: node scripts/check-runtime-skips.mjs <vitest-results.json>");
    process.exitCode = 2;
    return;
  }
  if (!existsSync(reportPath)) fail(`vitest results report is missing at ${reportPath}.`);

  const inventory = validateInventory(readJson(INVENTORY, "test inventory"));
  const allowances = validateAllowances(readJson(ALLOWANCES, "runtime skip allowances"), inventory);
  const rows = auditRuntimeSkips(readJson(reportPath, "vitest results report"), inventory, allowances);
  const skipped = rows.filter((row) => row.runtimeSkipped > 0);
  const total = skipped.reduce((sum, row) => sum + row.runtimeSkipped, 0);

  console.log(`Runtime skip audit: ${total} runtime-skipped test(s) across ${rows.length} inventoried files.`);
  for (const row of skipped) console.log(`  ${row.file}: ${row.runtimeSkipped} / ${row.allowed} allowed`);
  console.log(`Runtime skip audit passed: unlisted files allowed 0; ${Object.keys(allowances).length} file allowance(s) are live.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      console.error("usage: node scripts/check-runtime-skips.mjs <vitest-results.json>");
      process.exitCode = 2;
    } else {
      main(process.argv[2]);
    }
  } catch (error) {
    if (!(error instanceof RuntimeSkipAuditError)) throw error;
    console.error(`FATAL: ${error.message}`);
    process.exitCode = 1;
  }
}
