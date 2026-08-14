#!/usr/bin/env node
/**
 * check-test-inventory.mjs — the e2e-gate's anti-deletion guard.
 *
 * WHY THIS EXISTS (read before "simplifying" it back into a constant):
 * the gate used to assert `passedTests >= 1465`, a number hand-written at seed
 * time and never touched again. The suite has since grown to nearly double it,
 * so the assertion could not fail: every test in the repo could be deleted and
 * the step would still print "Baseline check passed". A check that only passes
 * is indistinguishable from a check that works, which is why it went unnoticed
 * for a month. Bumping the constant to today's number only restarts that clock.
 *
 * THE ANTI-ROT PROPERTY: the expected counts live in a COMMITTED snapshot
 * (.github/test-inventory.json) and are compared EXACTLY, in both directions.
 *  - fewer tests in a file (or a file gone)  → REGRESSION, gate red
 *  - more tests, or a new file               → DRIFT, gate red
 * Because growth is red too, the snapshot cannot silently fall behind: the
 * first PR that adds a test is forced to regenerate it, and every deletion
 * shows up as a negative number in a diff a human has to approve. There is no
 * state in which the snapshot is stale and the gate is green.
 *
 * WHAT IS COUNTED — statically COLLECTED tests, from `vitest list`, on both
 * sides. Never a run report. This is a deliberate reversal, and the reason is
 * the whole difference between a guard and a flake:
 *
 *   Counting what RAN sounds stronger and is worse. THREE suites self-skip at
 *   RUNTIME on environment noise — nats-transport.test.ts's port-scan pair
 *   calls ctx.skip() when the per-PID LISTEN floor drifts (which its docstring
 *   says happens "under full-suite load", i.e. exactly how CI runs it),
 *   p1-1-http-ui-contract.test.ts skips when a sandbox denies listen(2), and
 *   ac6-device-flow-e2e.test.ts warns "nats-server not available" and returns
 *   early, passing VACUOUSLY rather than skipping (that last one is issue #133;
 *   named here so a reader counting unobserved suites gets three, not two). Off
 *   a run report those tests vanish from the count on a bad day, so the gate goes
 *   red with "tests disappeared" when nothing was deleted — and the remedy the
 *   red message prints (regenerate the snapshot) collects statically, produces
 *   no diff, and cannot clear it. The only thing that clears it is committing
 *   the flake-lowered number, after which deleting those tests for real is
 *   green forever. A guard whose false alarm can only be silenced by disarming
 *   it is worse than no guard.
 *
 *   Collection has no such noise: it evaluates module top level and describe
 *   bodies, and nothing else. `describe.skipIf(!NATS_SERVER_BIN)` IS evaluated
 *   then, so a real-server suite going dormant still goes red — though by
 *   different routes, and the distinction matters when reading the output:
 *   with CI=true (the gate) both realserver files THROW at module top level, so
 *   collection itself fails and you get "'vitest list' exited 1"; with CI unset
 *   (a dev box) `skipIf` simply drops them and you get a count drop, 146/2707.
 *   Either way red — the property that matters is kept. `.skip`, `.todo` and
 *   `skipIf` are all omitted from the list, so silencing a test any of those
 *   ways is a count drop. Only a RUNTIME self-skip is invisible, which is
 *   precisely the flake we are refusing to be hostage to.
 *
 * WHAT THIS CANNOT CATCH: it counts tests, it does not judge them. A test that
 * is deleted and replaced by a vacuous one in the same file keeps the count
 * identical and passes here. Weakening a test's assertions is likewise
 * invisible, and so is a test that collects but self-skips at runtime (above).
 * It also says nothing about examples/**, which vitest.config.ts excludes from
 * the sweep. Those two gaps are enforced by check-runtime-skips.mjs and the
 * examples' zero-registration guard respectively; they stay separate because
 * their failure modes are not deterministic collection drift.
 *
 * SHAPE — why the snapshot carries no `totalTests`/`totalFiles`, and why the
 * check refuses any top-level key it does not validate: a total is one line
 * that EVERY concurrent branch rewrites, so it is a guaranteed merge conflict
 * on every pair of PRs that touch tests, while the per-file lines below it
 * auto-merge cleanly. Resolve that conflict the fast way — take one side's
 * total, keep both sides' file lines — and the header is now a false count in
 * the one file whose entire job is being trustworthy about counts. Nothing
 * would catch it, because nothing read those fields. A summary the checker can
 * recompute in a loop is not worth a standing conflict site plus an unchecked
 * assertion, so it is derived at runtime and never stored. If you add a field
 * here, teach `check()` to validate it — an unvalidated field in this file is
 * the same bug as the constant this script replaced.
 *
 * SECOND JOB — `--scope`: the snapshot is also the only thing that knows how
 * many test files the suite step ought to execute, so this script doubles as
 * that step's own scope assertion. See scope() for why it compares file paths
 * and never counts.
 *
 * USAGE — the gate runs the first form, so a green local run IS the gate:
 *   npm run test:inventory                  # check (collects via `vitest list`)
 *   npm run test:inventory:update           # regenerate the snapshot
 *   npm run test:inventory:update -- --accept-deletions   # …to accept deletions
 *                                                         # or first bootstrap
 *   node scripts/check-test-inventory.mjs <list.json>            # check a
 *                                                                # captured list
 *   node scripts/check-test-inventory.mjs --scope <results.json> # assert a run
 *                                                                # executed
 *                                                                # every file
 * Collection needs nats-server — on PATH, or in /usr/local/bin, /usr/bin or
 * /opt/homebrew/bin, which the suites probe unconditionally. Without it, on a
 * dev box (CI unset) the `skipIf` real-server suites do not collect and the
 * check reports them as deleted (-23); under CI=true they throw at module top
 * level instead and collection fails outright. Both red, different messages.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SNAPSHOT = join(REPO, ".github", "test-inventory.json");
const SNAPSHOT_REL = relative(REPO, SNAPSHOT).split(sep).join("/");
const UPDATE_CMD = "npm run test:inventory:update";
const ACCEPT_UPDATE_CMD = `${UPDATE_CMD} -- --accept-deletions`;
const NATS_COLLECTION_SENTINELS = [
  "packages/plugin/src/nats-transport-realserver.test.ts",
  "packages/saas/src/nats-permissions-realserver.test.ts",
];

class FatalError extends Error {}

function fail(msg) {
  throw new FatalError(msg);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`could not read ${what} at ${path}: ${err.message}`);
  }
}

function toRel(abs) {
  return relative(REPO, abs).split(sep).join("/");
}

function total(files) {
  return Object.values(files).reduce((sum, n) => sum + n, 0);
}

/**
 * `vitest list --json` → { relPath: collectedTestCount }, keys sorted.
 * One entry per collected test; statically skipped tests are not emitted, so a
 * file with nothing left to collect simply has no entry — which reads as GONE
 * against the snapshot, the honest description of a file that runs nothing.
 */
function toInventory(data, source) {
  if (!Array.isArray(data)) {
    fail(`${source} is not a 'vitest list --json' array.`);
  }
  const files = {};
  for (const entry of data) {
    if (!entry?.file) continue;
    const rel = toRel(entry.file);
    files[rel] = (files[rel] ?? 0) + 1;
  }
  if (Object.keys(files).length === 0) {
    fail(`${source} lists no test files at all — refusing to treat that as an inventory.`);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Collect the inventory. Collection only: no test body, no hook, no listener. */
function collectViaVitestList() {
  const bin = join(REPO, "node_modules", ".bin", "vitest");
  if (!existsSync(bin)) fail(`vitest not installed at ${bin} — run 'npm install' first.`);

  const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
  const out = join(dir, "list.json");
  try {
    // --disableConsoleIntercept: vitest 2.1.9's `list` crashes with
    // "Cannot read properties of undefined (reading 'config')" the moment a
    // test file logs during collection, because the default reporter has no
    // context in list mode. Routing worker output straight to stdout avoids
    // that path entirely. Drop the flag only after verifying `list` is fixed.
    const res = spawnSync(process.execPath, [bin, "list", "--disableConsoleIntercept", `--json=${out}`], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (res.status !== 0) {
      fail(
        `'vitest list' exited ${res.status} — see the collection error above.\n` +
          "  A test file that cannot be imported cannot be inventoried; fix that first.",
      );
    }
    if (!existsSync(out)) fail("'vitest list' wrote no JSON output.");
    return toInventory(readJson(out, "'vitest list' output"), "'vitest list' output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Either a captured list JSON, or a fresh collection. */
function inventoryFrom(listPath) {
  return listPath ? toInventory(readJson(listPath, "'vitest list' JSON"), listPath) : collectViaVitestList();
}

/**
 * --scope: did the test run actually EXECUTE every file in the inventory?
 *
 * Nothing else couples the suite step's scope to anything — the old
 * `passed >= BASELINE` was unfailable, and the inventory check deliberately
 * collects on its own. Narrow the run to `packages/client`, or add --project /
 * --shard / --changed, and the suite step exits 0 having executed a fraction of
 * the tests while the inventory check still passes. This closes that.
 *
 * It compares FILE PATHS ONLY and never reads a count — that is what makes it
 * immune to the runtime self-skips (nats-transport.test.ts's port-scan pair,
 * p1-1-http-ui-contract.test.ts's listen(2)/EPERM path) that make any run-report
 * COUNT unusable as a gate. A file whose tests all self-skipped still executed.
 *
 * Extra files in the run that are not in the inventory are ignored on purpose:
 * a file whose every test is statically skipped is absent from the inventory by
 * design, and failing on it would be a red with no snapshot-shaped remedy.
 *
 * NOT CAUGHT HERE: `-t <pattern>`. Vitest reports filtered-out tests as pending
 * in files that still appear, so this path-only assertion cannot distinguish a
 * name filter from a runtime skip. check-runtime-skips.mjs now compares the
 * completed count with this inventory and makes that red outside the two small
 * committed flake widths. Do not add `-t` to the suite step regardless.
 */
function scope(resultsPath) {
  const expected = loadSnapshot();
  const data = readJson(resultsPath, "vitest results JSON");
  if (!Array.isArray(data?.testResults)) {
    fail(`${resultsPath} is not a 'vitest run --reporter=json' report.`);
  }

  const executed = new Set();
  for (const suite of data.testResults) {
    if (suite?.name) executed.add(toRel(suite.name));
  }

  const missing = Object.keys(expected).filter((file) => !executed.has(file));
  console.log(`Run scope: executed ${executed.size} test files; inventory expects ${Object.keys(expected).length}.`);

  if (missing.length > 0) {
    console.error(`\nFATAL: the test run skipped ${missing.length} file(s) the inventory expects:`);
    console.error(missing.slice(0, 15).map((f) => `  ${f}`).join("\n"));
    if (missing.length > 15) console.error(`  … and ${missing.length - 15} more`);
    console.error(
      "\nThe suite step ran a NARROWER set of files than the repo contains — a path\n" +
        "argument, --project, --shard, --changed or a config `include` change will do\n" +
        "this. It exits 0 having never executed those tests, and the inventory check\n" +
        "cannot see it because that check collects independently. Restore the full run.",
    );
    process.exit(1);
  }

  console.log("Run scope OK: every file in the inventory was executed.");
}

/** Every top-level key the checker knows how to validate. Nothing else is allowed. */
const SNAPSHOT_KEYS = new Set(["note", "files"]);

/**
 * The snapshot is a trusted input — a corrupt or half-merged one must be as red
 * as a missing test, never quietly permissive. Anything that would make an
 * entry unenforceable (non-integer, negative, zero, an absolute path that can
 * never match a repo-relative result key) fails here instead of silently
 * excusing that file.
 */
function loadSnapshot() {
  if (!existsSync(SNAPSHOT)) {
    fail(`${SNAPSHOT_REL} is missing. Restore it, or bootstrap a new baseline with '${ACCEPT_UPDATE_CMD}'.`);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  } catch (err) {
    fail(
      `${SNAPSHOT_REL} exists but is not valid JSON: ${err.message}\n` +
        "  Left-over merge conflict markers are the usual cause. Resolve them (the\n" +
        "  per-file lines merge cleanly; take both sides). If the baseline cannot be\n" +
        `  recovered, delete the file and explicitly bootstrap it with '${ACCEPT_UPDATE_CMD}'.`,
    );
  }

  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail(
      `${SNAPSHOT_REL} is not a JSON object. Repair it, or delete it and bootstrap a new baseline with ` +
        `'${ACCEPT_UPDATE_CMD}'.`,
    );
  }

  const unknown = Object.keys(snapshot).filter((k) => !SNAPSHOT_KEYS.has(k));
  if (unknown.length > 0) {
    fail(
      `${SNAPSHOT_REL} has top-level key(s) this checker does not validate: ${unknown.join(", ")}.\n` +
        "  Stored totals were deliberately removed (they conflict on every concurrent PR and\n" +
        "  nothing read them). Either drop the field, or teach check() to validate it —\n" +
        "  an unvalidated field here is the bug this script exists to prevent.",
    );
  }

  const expected = snapshot.files;
  if (expected === null || typeof expected !== "object" || Array.isArray(expected) || Object.keys(expected).length === 0) {
    fail(
      `${SNAPSHOT_REL} has no usable 'files' map. Repair it, or delete it and bootstrap a new baseline with ` +
        `'${ACCEPT_UPDATE_CMD}'.`,
    );
  }

  const bad = [];
  for (const [file, count] of Object.entries(expected)) {
    if (!Number.isInteger(count) || count <= 0) {
      bad.push(`  ${file}: ${JSON.stringify(count)} is not a positive integer test count`);
    } else if (file.startsWith("/") || file.includes("\\")) {
      bad.push(`  ${file}: not a repo-relative POSIX path, so it can never match a collected file`);
    }
  }
  if (bad.length > 0) {
    console.error(`FATAL: ${SNAPSHOT_REL} is corrupt — ${bad.length} bad entr(y/ies):`);
    console.error(bad.join("\n"));
    console.error(
      `\nRepair it, or delete it and explicitly bootstrap a new baseline with '${ACCEPT_UPDATE_CMD}'.`,
    );
    process.exit(1);
  }

  return expected;
}

/**
 * The one command that COMMITS the inventory, so it is the one place a silent
 * omission becomes permanent. Reproduced: with no nats-server on any candidate
 * path and CI unset, a bare `--update` printed "146 files / 2707 collected
 * tests" and nothing else — quietly dropping both `skipIf` real-server suites,
 * after which the developer's own check is green with 23 tests' worth of
 * enforcement gone. CI catches it as DRIFT, but the commit already happened.
 *
 * THE DEFAULT TRIGGER IS THE TOTAL, NOT THE PER-FILE DELTA, and that choice is
 * what keeps this guard alive. Per-file, any test MOVED between files trips it
 * — one file loses 3, another gains 3 — so `--accept-deletions` would become
 * the incantation for routine refactors, and a flag typed by habit guards
 * nothing. A collection gap (missing binary, a suite gone dormant) only
 * subtracts, so a net drop is refused while count-neutral and growing rewrites
 * pass — and any file that lost tests is still PRINTED, so a move is visible
 * without being blocked.
 *
 * One known collection gap gets an independent check: without nats-server both
 * real-server files disappear together (-23), but unrelated additions can
 * offset that loss and defeat a total-only guard. Those files are therefore
 * collection sentinels: either one missing requires explicit acceptance even
 * when the total holds. This applies equally to fresh and captured lists; the
 * latter cannot prove which environment originally collected it.
 *
 * The counts cannot prove a move: N tests leaving file A and N unrelated tests
 * arriving in file B is indistinguishable from a move by any count-only check.
 * Naming test names in the snapshot would settle it and cost a 2700-line file
 * that churns on every rename. The total catches every uncompensated shrink
 * without firing on a refactor; the sentinel exception covers the known
 * compensable environmental gap above.
 *
 * Refusing rather than warning (when it does fire) is deliberate — a warning
 * scrolls past in the same terminal that is about to `git commit`, and the
 * recovery is a follow-up commit.
 */
function reviewShrink(next, accepted) {
  if (!existsSync(SNAPSHOT)) {
    if (!accepted) {
      fail(
        `${SNAPSHOT_REL} is missing; refusing to bootstrap an inventory without explicit acceptance.\n` +
          "  A missing snapshot removes the prior baseline, so collection gaps cannot be detected.\n" +
          `  Restore it, or intentionally create a new baseline with '${ACCEPT_UPDATE_CMD}'.`,
      );
    }
    console.warn(`Bootstrapping missing ${SNAPSHOT_REL} with --accept-deletions.`);
    return;
  }

  // Update must trust exactly the same snapshot shapes as check mode. A
  // parseable-but-corrupt baseline is no more useful for detecting shrinkage
  // than a missing one, and must never be overwritten by a bare update.
  const prev = loadSnapshot();

  const missingNatsSentinels = NATS_COLLECTION_SENTINELS.filter(
    (file) => file in prev && !(file in next),
  );
  if (missingNatsSentinels.length > 0) {
    const details = missingNatsSentinels.map((file) => `  ${file}: GONE`).join("\n");
    if (!accepted) {
      fail(
        `refusing to write an inventory missing ${missingNatsSentinels.length} nats-server collection ` +
          `sentinel(s):\n${details}\n\n` +
          "  These files disappear when nats-server is unavailable during collection; additions\n" +
          "  elsewhere cannot prove that collection was complete. Install nats-server and re-run\n" +
          `  (or recapture the list). If the files were intentionally removed: ${ACCEPT_UPDATE_CMD}`,
      );
    }
    console.warn(`Accepting missing nats-server collection sentinel(s):\n${details}`);
  }

  const losses = [];
  const gains = [];
  for (const [file, was] of Object.entries(prev)) {
    if (!Number.isInteger(was)) continue;
    const now = next[file];
    if (now === undefined) losses.push(`  ${file}: ${was} → GONE`);
    else if (now < was) losses.push(`  ${file}: ${was} → ${now}  (-${was - now})`);
    else if (now > was) gains.push(`  ${file}: ${was} → ${now}  (+${now - was})`);
  }
  for (const [file, now] of Object.entries(next)) {
    if (!(file in prev)) gains.push(`  ${file}: NEW → ${now}`);
  }
  if (losses.length === 0) return;

  const prevTotal = total(prev);
  const nextTotal = total(next);

  // Count-neutral or growing: a move, or a rewrite that replaced what it
  // removed. Not blocked — but never silent.
  if (nextTotal >= prevTotal) {
    console.log(
      `Note: ${losses.length} file(s) lost tests while the total held at ` +
        `${prevTotal} → ${nextTotal} (tests moved between files?):`,
    );
    console.log(losses.join("\n"));
    return;
  }

  if (accepted) {
    console.warn(`Accepting a net loss of ${prevTotal - nextTotal} test(s) across ${losses.length} file(s):`);
    console.warn(losses.join("\n"));
    return;
  }

  console.error(
    `FATAL: refusing to write a SMALLER inventory — ${prevTotal} → ${nextTotal} ` +
      `(${nextTotal - prevTotal}) across ${losses.length} file(s):`,
  );
  console.error(losses.join("\n"));
  if (gains.length > 0) {
    console.error(`\n${gains.length} file(s) gained tests, but not enough to cover it:`);
    console.error(gains.join("\n"));
  }
  console.error(
    "\nIf you did not just delete those tests, this is a collection gap rather than a\n" +
      "deletion — most often nats-server missing with CI unset, which drops the two\n" +
      "`skipIf` real-server suites (-23). Install it and re-run.\n" +
      "Moving tests between ordinary files does NOT need a flag; only a net loss or\n" +
      "the disappearance of a required nats-server collection sentinel does.\n" +
      `If tests really were deleted: ${UPDATE_CMD} -- --accept-deletions`,
  );
  process.exit(1);
}

function update(listPath, acceptDeletions) {
  const files = inventoryFrom(listPath);
  reviewShrink(files, acceptDeletions);
  const snapshot = {
    note:
      "Collected (non-skipped) test count per file, from 'vitest list'. Checked " +
      "EXACTLY by scripts/check-test-inventory.mjs in the e2e gate: a drop is a " +
      `deleted or skipped test, a rise means this file is stale. Regenerate with '${UPDATE_CMD}'. ` +
      "No totals field on purpose — see the script's SHAPE note.",
    files,
  };
  writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${SNAPSHOT_REL}: ${Object.keys(files).length} files / ${total(files)} collected tests.`);
}

function check(listPath) {
  const expected = loadSnapshot();
  const actual = inventoryFrom(listPath);

  const regressions = [];
  const drift = [];
  for (const [file, want] of Object.entries(expected)) {
    const got = actual[file];
    if (got === undefined) regressions.push(`  ${file}: ${want} → GONE (file collects nothing)`);
    else if (got < want) regressions.push(`  ${file}: ${want} → ${got}  (-${want - got})`);
    else if (got > want) drift.push(`  ${file}: ${want} → ${got}  (+${got - want})`);
  }
  for (const [file, got] of Object.entries(actual)) {
    if (!(file in expected)) drift.push(`  ${file}: NEW → ${got}`);
  }

  const expectedTotal = total(expected);
  const actualTotal = total(actual);
  console.log(
    `Test inventory: ${actualTotal} collected tests in ${Object.keys(actual).length} files ` +
      `(snapshot: ${expectedTotal} in ${Object.keys(expected).length}).`,
  );

  if (regressions.length > 0) {
    console.error(`\nFATAL: tests disappeared — ${regressions.length} file(s) below the committed inventory:`);
    console.error(regressions.join("\n"));
    console.error(
      `\nNet: ${expectedTotal} → ${actualTotal} collected tests (${actualTotal - expectedTotal}).\n` +
        "A test was deleted, skipped, moved, or stopped being collected. Restore it, or —\n" +
        `if the change is intentional — run '${UPDATE_CMD}' and commit ${SNAPSHOT_REL},\n` +
        "so a reviewer sees the change as an explicit per-file diff. An ordinary move needs\n" +
        "nothing more; a NET loss or a nats-server sentinel disappearing will ask you\n" +
        "to confirm explicitly.\n" +
        "\nTwo false alarms to rule out first:\n" +
        "  - running locally without nats-server: the `skipIf` real-server suites do not\n" +
        "    collect without it (-23). Install it — CI always has it.\n" +
        "  - a file that fails to IMPORT collects nothing and reads as GONE; the\n" +
        "    test-suite step will be red too. Fix that — nothing was deleted.",
    );
    if (drift.length > 0) console.error(`\nAlso added (${drift.length}):\n${drift.join("\n")}`);
    process.exit(1);
  }

  if (drift.length > 0) {
    console.error(`\nFATAL: the committed inventory is stale — ${drift.length} file(s) above it:`);
    console.error(drift.join("\n"));
    console.error(
      `\nNet: ${expectedTotal} → ${actualTotal} collected tests (+${actualTotal - expectedTotal}).\n` +
        `Growth fails on purpose: an inventory that is allowed to lag is an inventory that\n` +
        `stops detecting deletions. Run '${UPDATE_CMD}' and commit ${SNAPSHOT_REL}.`,
    );
    process.exit(1);
  }

  console.log(`Inventory check passed: every file matches ${SNAPSHOT_REL} exactly.`);
}

const KNOWN_FLAGS = new Set(["--update", "--scope", "--accept-deletions"]);
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positional = argv.filter((a) => !a.startsWith("-"));
const unknownFlags = [...flags].filter((f) => !KNOWN_FLAGS.has(f));

function usage(code) {
  console.error(
    "usage:\n" +
      "  node scripts/check-test-inventory.mjs                       # check (collects via 'vitest list')\n" +
      "  node scripts/check-test-inventory.mjs <list.json>           # check a captured 'vitest list --json'\n" +
      "  node scripts/check-test-inventory.mjs --scope <results.json>  # assert a run executed every file\n" +
      "  node scripts/check-test-inventory.mjs --update [list.json] [--accept-deletions]",
  );
  process.exit(code);
}

try {
  if (unknownFlags.length > 0 || positional.length > 1) usage(2);
  else if (flags.has("--update") && !flags.has("--scope")) update(positional[0], flags.has("--accept-deletions"));
  else if (flags.has("--scope") && !flags.has("--update") && !flags.has("--accept-deletions")) {
    if (positional.length !== 1) usage(2);
    scope(positional[0]);
  } else if (flags.size === 0) check(positional[0] ?? null);
  else usage(2);
} catch (err) {
  if (!(err instanceof FatalError)) throw err;
  console.error(`FATAL: ${err.message}`);
  process.exitCode = 1;
}
