/**
 * Static boundary test (node:test).
 *
 * Asserts the app's OWN source (server/** + web/**) never reaches into package
 * internals — every library import must be the bare published package name
 * `openclaw-webchannel-saas` / `openclaw-webchannel-client`. It forbids:
 *   1. any `../packages/` path (relative reach into monorepo source), and
 *   2. any deep-subpath import of the two packages
 *      (`openclaw-webchannel-saas/<something>`), which the exports map would
 *      block at runtime anyway.
 *
 * The RUNTIME assertion that internals are unreachable through the exports map
 * (ERR_PACKAGE_PATH_NOT_EXPORTED) is NOT duplicated here — that already lives in
 * `examples/minimal-consumer/test/boundary.test.mjs`. This file is purely a
 * static source check.
 *
 * Exits non-zero on the first violation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleAssert as assert, exampleTest } from "../../../scripts/example-test-guard.mjs";

exampleTest("I132-E3: webchannel app source imports only public package entries", () => {

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, "..");
const SCAN_DIRS = ["server", "web"];
const SOURCE_EXTS = new Set([".ts", ".mts", ".js", ".mjs"]);
const PKGS = ["openclaw-webchannel-saas", "openclaw-webchannel-client"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE_EXTS.has(extname(full))) out.push(full);
  }
  return out;
}

// Match `import ... from "X"`, `export ... from "X"`, and dynamic `import("X")`.
const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failed++;
    console.error(`not ok - ${name}\n    ${detail}`);
  }
}

const files = SCAN_DIRS.flatMap((d) => walk(join(APP_ROOT, d)));
assert.ok(files.length > 0, "expected to find app source files to scan");

for (const file of files) {
  const rel = file.slice(APP_ROOT.length + 1);
  const src = readFileSync(file, "utf-8");
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];

    // 1. No relative reach into monorepo package source.
    check(
      `${rel}: no ../packages import (${spec})`,
      !spec.includes("../packages/") && !spec.includes("packages/"),
      `forbidden relative package-source import: ${spec}`,
    );

    // 2. No deep-subpath import of the two packages — only the bare name.
    for (const pkg of PKGS) {
      if (spec === pkg) continue; // bare package name is the ONLY allowed form
      check(
        `${rel}: no deep-subpath import of ${pkg} (${spec})`,
        !spec.startsWith(`${pkg}/`),
        `forbidden deep import into ${pkg}: ${spec}`,
      );
    }
  }
}

if (failed > 0) console.error(`\n${failed} boundary violation(s)`);
assert.equal(failed, 0, `${failed} source-boundary assertion(s) failed`);
console.log("\nall no-internal-imports assertions passed");
});
