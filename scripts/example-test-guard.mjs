import test from "node:test";
import strictAssert from "node:assert/strict";
import { exampleCoverageFailure } from "./example-test-guard-core.mjs";

let registered = 0;
let assertions = 0;

function counted(method) {
  return (...args) => {
    assertions += 1;
    return method(...args);
  };
}

/** The assertion surface used by the four consumer files, with a real count. */
export const exampleAssert = Object.freeze({
  deepEqual: counted(strictAssert.deepEqual),
  doesNotMatch: counted(strictAssert.doesNotMatch),
  equal: counted(strictAssert.equal),
  fail: counted(strictAssert.fail),
  notEqual: counted(strictAssert.notEqual),
  ok: counted(strictAssert.ok),
});

/**
 * Register an examples/** consumer test with node:test.
 *
 * The package scripts preload this module before loading each test file. That
 * matters because Node treats an empty file as one successful file-level test;
 * the exit hook below turns that otherwise-green zero-registration run red.
 * Each file is launched separately so one live sibling cannot cover an empty
 * file's zero.
 */
export function exampleTest(name, fn) {
  registered += 1;
  return test(name, fn);
}

process.once("exit", () => {
  const missing = exampleCoverageFailure(registered, assertions);
  if (missing === null) return;
  console.error(`FATAL: example test file ${missing}. Restore its guarded node:test assertions; a vacuous consumer test must not pass.`);
  process.exitCode = 1;
});
