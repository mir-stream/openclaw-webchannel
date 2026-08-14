/**
 * Guard for e2e/local/ports.json — the single source of truth for every
 * hard-coded port in the two families that bind real sockets: the six live e2e
 * gates (plus their drivers), and the root-sweep vitest suites that spawn a real
 * nats-server or HTTP server.
 *
 * WHY (#118, #119): the families used to allocate independently. Overlap meant
 * `nats-server did not become ready` in beforeAll, or — worse — a gate that
 * bound something else's port and quietly exercised nothing. Two collisions
 * shipped that way (18222 monitor vs driver default; 3981 claimed by both
 * run-turn-outcome.sh and run-derived-trust.sh).
 *
 * Putting the numbers in one file makes a concurrent addition a merge conflict.
 * This test makes a *non*-conflicting collision — two branches picking the same
 * free number in different blocks — a red test instead of a flake.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

type PortBlock = Record<string, number | string[] | undefined>;
type PortsDoc = {
  harnesses: Record<string, PortBlock>;
  vitest: Record<string, PortBlock>;
  tools: Record<string, PortBlock>;
  reserved: Record<string, string | string[]>;
};

const doc = JSON.parse(
  readFileSync(join(HERE, "ports.json"), "utf8"),
) as PortsDoc;

/** Every real port in a block, skipping `$note`-style documentation keys. */
function portsOf(block: PortBlock): Array<[string, number]> {
  return Object.entries(block)
    .filter(([k]) => !k.startsWith("$"))
    .map(([k, v]) => [k, v as number]);
}

/** Flat list of every allocation: [owner, key, port]. */
function allAllocations(): Array<[string, string, number]> {
  const out: Array<[string, string, number]> = [];
  for (const group of ["harnesses", "vitest", "tools"] as const) {
    for (const [owner, block] of Object.entries(doc[group] ?? {})) {
      if (owner.startsWith("$")) continue;
      for (const [key, port] of portsOf(block)) out.push([owner, key, port]);
    }
  }
  return out;
}

/** Computed once — it was recomputed per matched literal. */
const allocations = allAllocations();

/** Repo root, from this file's location. */
const REPO = join(HERE, "..", "..");

/** The gate scripts, discovered — never a hard-coded list. */
function gateScripts(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.startsWith("run-") && f.endsWith(".sh"))
    .sort();
}

const SOURCE_EXT = /\.(?:sh|[cm]?[jt]sx?)$/;
const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;
const EMITTED_TO_SOURCE_EXTENSIONS: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const VITEST_SUITE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const VITEST_DEFAULT_EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "cypress",
  ".idea",
  ".git",
  ".cache",
  ".output",
  ".temp",
]);
const REPO_EXCLUDED_ROOTS = new Set(["docker", "examples"]);
const CONFIG_EXCLUSION =
  /^(?:karma|rollup|webpack|vite|vitest|jest|ava|babel|nyc|cypress|tsup|build|eslint|prettier)\.config\./;
const BINDS =
  /nats-server|\.listen\s*\(|createServer\s*\(|\bnew\s+WebSocketServer\s*\(|ws_port|\bspawn\s*\(/;
const STATIC_RELATIVE_MODULE =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;
const STATIC_RELATIVE_REQUIRE =
  /\brequire\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

function isBindingSource(codeWithoutComments: string): boolean {
  return BINDS.test(codeWithoutComments);
}

function repoRelative(repo: string, abs: string): string {
  return relative(repo, abs).split(sep).join("/");
}

function hasExcludedDirectory(rel: string): boolean {
  const parts = rel.split("/");
  return (
    parts.some((part) => VITEST_DEFAULT_EXCLUDED_DIRS.has(part)) ||
    REPO_EXCLUDED_ROOTS.has(parts[0] ?? "")
  );
}

function isExcludedRelativePath(rel: string): boolean {
  const basename = rel.split("/").at(-1) ?? "";
  return hasExcludedDirectory(rel) || CONFIG_EXCLUSION.test(basename);
}

/** Walk source files beneath one relative directory, tolerating absent roots. */
function sourceFilesUnder(
  repo: string,
  startRel: string,
  honorVitestExclusions = true,
): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const excluded = honorVitestExclusions
        ? e.isDirectory()
          ? hasExcludedDirectory(childRel)
          : isExcludedRelativePath(childRel)
        : e.name === "node_modules";
      if (e.isDirectory() && excluded) continue;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else if (SOURCE_EXT.test(e.name) && !excluded) out.push(childRel);
    }
  };
  walk(join(repo, ...startRel.split("/").filter(Boolean)), startRel);
  return out.sort();
}

/** The root Vitest universe implied by configDefaults.include and exclusions. */
function vitestSuiteFiles(repo = REPO): string[] {
  return sourceFilesUnder(repo, "")
    .filter(
      (rel) =>
        VITEST_SUITE.test(rel) && rel !== "e2e/local/ports.test.ts",
    )
    .sort();
}

/**
 * Direct listener roots. Preserve the broad packages/<name>/src content scan
 * that covers #118's original family, then add every root Vitest test/spec source
 * shape outside configDefaults/repo exclusions. This catches future demo tests
 * without turning the whole product tree into a literal scan.
 */
function directBindingSources(repo = REPO): string[] {
  const candidates = new Set(vitestSuiteFiles(repo));
  let packages: Dirent[];
  try {
    packages = readdirSync(join(repo, "packages"), { withFileTypes: true });
  } catch {
    packages = [];
  }
  for (const pkg of packages) {
    if (!pkg.isDirectory()) continue;
    for (const rel of sourceFilesUnder(
      repo,
      `packages/${pkg.name}/src`,
      false,
    )) {
      candidates.add(rel);
    }
  }

  return [...candidates]
    .filter((rel) => {
      const code = decomment(
        readFileSync(join(repo, ...rel.split("/")), "utf8"),
        false,
      ).join("\n");
      return isBindingSource(code);
    })
    .sort();
}

function staticRelativeModules(codeWithoutComments: string): string[] {
  return [
    ...new Set([
      ...[...codeWithoutComments.matchAll(STATIC_RELATIVE_MODULE)].map(
        (match) => match[1]!,
      ),
      ...[...codeWithoutComments.matchAll(STATIC_RELATIVE_REQUIRE)].map(
        (match) => match[1]!,
      ),
    ]),
  ];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve a local source import, preferring TS behind emitted `.js` names. */
function resolveLocalSource(
  repo: string,
  importerRel: string,
  specifier: string,
): string | null {
  const base = resolve(dirname(join(repo, ...importerRel.split("/"))), specifier);
  const relBase = relative(repo, base);
  if (relBase === ".." || relBase.startsWith(`..${sep}`) || isAbsolute(relBase)) {
    return null;
  }

  const extension = extname(base);
  const candidates: string[] = [];
  const sourceExtensions = EMITTED_TO_SOURCE_EXTENSIONS[extension];
  if (sourceExtensions) {
    const stem = base.slice(0, -extension.length);
    for (const ext of sourceExtensions) candidates.push(`${stem}${ext}`);
    candidates.push(base);
  } else if (
    extension &&
    (MODULE_EXTENSIONS as readonly string[]).includes(extension)
  ) {
    candidates.push(base);
  } else if (extension) {
    return null;
  } else {
    for (const ext of MODULE_EXTENSIONS) candidates.push(`${base}${ext}`);
    for (const ext of MODULE_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  }

  for (const candidate of candidates) {
    const rel = repoRelative(repo, candidate);
    if (!isExcludedRelativePath(rel) && isFile(candidate)) return rel;
  }
  return null;
}

/**
 * Direct binding roots plus their recursive local static ESM and CommonJS
 * provenance. `.js` specifiers prefer their TS source and extensionless
 * specifiers resolve source/index variants. Dynamic, package, and excluded-tree
 * imports are deliberately outside this static provenance boundary; product
 * files unrelated to a binding root are never swept.
 */
function bindingSources(repo = REPO): string[] {
  const discovered = new Set<string>();
  const pending = [...directBindingSources(repo)];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    if (discovered.has(rel)) continue;
    discovered.add(rel);
    const code = decomment(
      readFileSync(join(repo, ...rel.split("/")), "utf8"),
      false,
    ).join("\n");
    for (const specifier of staticRelativeModules(code)) {
      const dependency = resolveLocalSource(repo, rel, specifier);
      if (dependency && !discovered.has(dependency)) pending.push(dependency);
    }
  }
  return [...discovered].sort();
}

/**
 * Every file the literal scan covers: all of e2e/local (recursive — a literal in
 * lib/harness.sh overrides harness_ports for all six gates at once), plus every
 * discovered binding source, plus anything ports.json declares (so a declared
 * file is never dropped just because the predicate misses it).
 */
function scannedFiles(): string[] {
  const out = new Set<string>();
  for (const rel of sourceFilesUnder(REPO, "e2e/local", false)) {
    if (rel !== "e2e/local/ports.test.ts") out.add(rel);
  }
  for (const f of bindingSources()) out.add(f);
  for (const group of ["vitest", "tools"] as const) {
    for (const k of Object.keys(doc[group] ?? {})) {
      if (!k.startsWith("$") && existsSync(join(REPO, k))) out.add(k);
    }
  }
  return [...out].sort();
}

/** Ports a file is the declared owner of and may therefore hard-code. */
function ownedPorts(rel: string): Set<number> {
  const owned = new Set<number>();
  for (const group of ["vitest", "tools"] as const) {
    const block = doc[group]?.[rel];
    if (!block) continue;
    const abs = join(REPO, rel);
    // A file that reads the authority owns nothing as a literal — the entire
    // point is that it has none.
    if (existsSync(abs) && readsAuthority(decomment(readFileSync(abs, "utf8"), false).join("\n"))) {
      continue;
    }
    for (const [, port] of portsOf(block)) owned.add(port);
  }
  return owned;
}

/**
 * Does this file actually resolve e2e/local/ports.json at runtime?
 *
 * Judged on CODE, never a substring: prose mentioning ports.json used to be
 * enough to switch this check off for the suites #118 lived in.
 */
function readsAuthority(codeWithoutComments: string): boolean {
  return (
    /readFileSync\s*\(/.test(codeWithoutComments) &&
    /["\'`][^"\'`]*ports\.json["\'`]/.test(codeWithoutComments)
  );
}

/**
 * Strip comments, STRING-AWARE, preserving line structure.
 *
 * The naive version was `text.replace(/\/\*[\s\S]*?\*\//g, "")` plus a
 * per-line `\s#.*$`. Both were reproducibly exploitable:
 *   - a `/-` inside a string literal (a glob like "packages/-/src", a regex
 *     source) opened a pseudo-comment that ran to the next `-/` ANYWHERE later
 *     in the file, deleting live code — an unbounded blind span;
 *   - a ` #` inside a shell double-quoted string (an HTTP header value, a URL
 *     fragment, a jq program) hid the rest of that line.
 * It also collapsed newlines, so every reported line number in a non-shell file
 * was short by the length of the preceding block comments.
 *
 * So: walk the text tracking quote state, blank comment spans to spaces, and
 * never remove a newline. Offender line numbers are then exact.
 */
function decomment(text: string, shell: boolean): string[] {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      // Shell single quotes take no escapes; everything else does.
      if (c === "\\" && !(shell && quote === "'")) {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || (!shell && c === "`")) {
      quote = c;
      i++;
      continue;
    }
    if (!shell && c === "/" && n === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (!shell && c === "/" && n === "*") {
      let j = i + 2;
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j = Math.min(j + 2, text.length);
      blank(i, j);
      i = j;
      continue;
    }
    // In shell `#` only opens a comment at the start of a word.
    if (shell && c === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join("").split("\n");
}

type PortLiteral = [rel: string, line: number, value: number];
type LiteralBudget = {
  file: string;
  value: number;
  count: number;
  reason: string;
};

/** Every port-range integer in one source, with comments ignored. */
function literalsInSource(rel: string, text: string): PortLiteral[] {
  const found: PortLiteral[] = [];
  decomment(text, rel.endsWith(".sh")).forEach((line, i) => {
    for (const match of line.matchAll(/(?<![\w.\-])(\d{4,5})(?![\w.\-])/g)) {
      const value = Number(match[1]);
      if (value >= 1024 && value <= 65535) found.push([rel, i + 1, value]);
    }
  });
  return found;
}

function literalsInFiles(repo: string, files: string[]): PortLiteral[] {
  return files.flatMap((rel) =>
    literalsInSource(
      rel,
      readFileSync(join(repo, ...rel.split("/")), "utf8"),
    ),
  );
}

function budgetKey(file: string, value: number): string {
  return `${file}:${value}`;
}

/** Consume only the exact occurrence allowance for each source/value pair. */
function withoutLiteralBudgets(
  literals: PortLiteral[],
  budgets: LiteralBudget[],
): PortLiteral[] {
  const allowed = new Map(
    budgets.map((rule) => [budgetKey(rule.file, rule.value), rule.count]),
  );
  const seen = new Map<string, number>();
  return literals.filter(([file, , value]) => {
    const key = budgetKey(file, value);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return occurrence > (allowed.get(key) ?? 0);
  });
}

/** Exact-count liveness in both directions, including duplicate rule keys. */
function literalBudgetProblems(
  literals: PortLiteral[],
  budgets: LiteralBudget[],
  label: string,
): string[] {
  const counts = new Map<string, number>();
  for (const [file, , value] of literals) {
    const key = budgetKey(file, value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ruleKeys = new Set<string>();
  const problems: string[] = [];
  for (const rule of budgets) {
    const key = budgetKey(rule.file, rule.value);
    if (ruleKeys.has(key)) {
      problems.push(`  ${label} ${key} is declared more than once`);
      continue;
    }
    ruleKeys.add(key);
    const actual = counts.get(key) ?? 0;
    if (actual !== rule.count) {
      problems.push(
        `  ${label} ${key} expects ${rule.count}, found ${actual} (${rule.reason})`,
      );
    }
  }
  return problems;
}

function withFixtureRepo(
  files: Record<string, string>,
  assertion: (repo: string) => void,
): void {
  const repo = mkdtempSync(join(tmpdir(), "webchannel-port-discovery-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = join(repo, ...rel.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    assertion(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("e2e/local/ports.json", () => {
  it("allocates only well-formed ports", () => {
    for (const [owner, key, port] of allAllocations()) {
      expect(
        Number.isInteger(port) && port > 1024 && port < 65536,
        `${owner}.${key} = ${JSON.stringify(port)} is not an unprivileged port`,
      ).toBe(true);
    }
  });

  it("assigns every port to exactly one owner", () => {
    // Global uniqueness, deliberately: two harnesses may NOT share a port even
    // if they never run concurrently today. "They don't overlap in practice" is
    // precisely the assumption #119 was, and a leftover process from a killed
    // run outlives that assumption anyway.
    const byPort = new Map<number, string[]>();
    for (const [owner, key, port] of allAllocations()) {
      const claims = byPort.get(port) ?? [];
      claims.push(`${owner}.${key}`);
      byPort.set(port, claims);
    }

    const collisions = [...byPort.entries()]
      .filter(([, claims]) => claims.length > 1)
      .map(([port, claims]) => `  ${port} claimed by ${claims.join(" and ")}`);

    expect(collisions, `port collisions:\n${collisions.join("\n")}`).toEqual([]);
  });

  it("never claims a reserved port", () => {
    const reserved = new Map(
      Object.entries(doc.reserved)
        .filter(([k]) => !k.startsWith("$"))
        .map(([port, why]) => [Number(port), String(why)]),
    );

    const violations = allAllocations()
      .filter(([, , port]) => reserved.has(port))
      .map(
        ([owner, key, port]) =>
          `  ${owner}.${key} = ${port} — reserved: ${reserved.get(port)}`,
      );

    expect(
      violations,
      `reserved ports claimed:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("has an entry for every gate script, and vice versa", () => {
    // A new gate that forgets to register lands here rather than in a flake.
    const scripts = gateScripts().map((f) => f.slice(0, -3));
    const registered = Object.keys(doc.harnesses)
      .filter((k) => !k.startsWith("$"))
      .sort();

    expect(registered).toEqual(scripts);
  });

  it("discovers WebSocketServer constructor listeners", () => {
    expect(bindingSources()).toContain(
      "packages/plugin/src/nats-cutover-e2e.test.ts",
    );
  });

  it("discovers a root-sweep binding suite outside packages", () => {
    withFixtureRepo(
      {
        "demo/server.test.ts":
          'new WebSocketServer({ port: 18491, host: "127.0.0.1" });\n',
        "examples/ignored.test.ts":
          'new WebSocketServer({ port: 18491, host: "127.0.0.1" });\n',
        "dist/ignored.spec.js": "new WebSocketServer({ port: 18491 });\n",
      },
      (repo) => {
        expect(vitestSuiteFiles(repo)).toEqual(["demo/server.test.ts"]);
        expect(bindingSources(repo)).toEqual(["demo/server.test.ts"]);
        expect(literalsInFiles(repo, bindingSources(repo))).toContainEqual([
          "demo/server.test.ts",
          1,
          18491,
        ]);
      },
    );
  });

  it("includes recursive local import provenance for a binding suite", () => {
    withFixtureRepo(
      {
        "demo/server.test.ts": [
          'import { FIXED_PORT } from "./fixed-port.js";',
          "new WebSocketServer({ port: FIXED_PORT });",
          "",
        ].join("\n"),
        "demo/fixed-port.ts":
          'export { FIXED_PORT } from "./ports";\n',
        "demo/ports/index.ts": "export const FIXED_PORT = 18491;\n",
      },
      (repo) => {
        expect(bindingSources(repo)).toEqual([
          "demo/fixed-port.ts",
          "demo/ports/index.ts",
          "demo/server.test.ts",
        ]);
        expect(literalsInFiles(repo, bindingSources(repo))).toContainEqual([
          "demo/ports/index.ts",
          1,
          18491,
        ]);
      },
    );
  });

  it("includes CommonJS require provenance for a binding suite", () => {
    withFixtureRepo(
      {
        "demo/server.test.cjs": [
          'const { FIXED_PORT } = require("./fixed-port.cjs");',
          'require("./ignored.json");',
          "new WebSocketServer({ port: FIXED_PORT });",
          "",
        ].join("\n"),
        "demo/fixed-port.cts": "export const FIXED_PORT = 18491;\n",
        "demo/fixed-port.ts": "export const FIXED_PORT = 3000;\n",
        "demo/ignored.json": "{ \"port\": 18491 }\n",
      },
      (repo) => {
        expect(bindingSources(repo)).toEqual([
          "demo/fixed-port.cts",
          "demo/server.test.cjs",
        ]);
        expect(literalsInFiles(repo, bindingSources(repo))).toContainEqual([
          "demo/fixed-port.cts",
          1,
          18491,
        ]);
      },
    );
  });

  it("makes every gate load its OWN block", () => {
    // Nothing used to tie run-X.sh to block X: `harness_ports run-turn-outcome
    // run-multi-message` inside run-multi-message.sh was 7/7 green while giving
    // that gate five ports identical to run-turn-outcome's. That is #118 with no
    // literal anywhere — and the optional log-tag argument makes name != tag look
    // like ordinary usage. Copy-paste between gates is how 3981 got double-claimed
    // in the first place, so this is the original defect's own mechanism.
    const problems: string[] = [];
    for (const file of gateScripts()) {
      const body = decomment(readFileSync(join(HERE, file), "utf8"), true).join("\n");
      const calls = [...body.matchAll(/^\s*harness_ports\s+(\S+)/gm)].map((m) => m[1]);
      const expected = file.slice(0, -3);
      if (calls.length !== 1) {
        problems.push(`  ${file}: expected exactly one harness_ports call, found ${calls.length}`);
        continue;
      }
      if (calls[0] !== expected) {
        problems.push(`  ${file}: loads block '${calls[0]}' — a gate must load its own block '${expected}'`);
      }
    }
    expect(problems, `gates loading the wrong block:\n${problems.join("\n")}`).toEqual([]);
  });

  it("defines every port key its gate actually references", () => {
    // Vocabulary is DERIVED from what ports.json declares, so it is not a closed
    // shape list. A gate referencing a name declared in NO block is a runtime
    // `unbound variable` under `set -u` on its very first run — loud, immediate,
    // and not something this static check can see without parsing shell.
    const vocab = new Set<string>();
    for (const block of Object.values(doc.harnesses)) {
      for (const [k] of portsOf(block)) vocab.add(k);
    }
    const missing: string[] = [];
    for (const [harness, block] of Object.entries(doc.harnesses)) {
      if (harness.startsWith("$")) continue;
      const body = readFileSync(join(HERE, `${harness}.sh`), "utf8");
      const declared = new Set(portsOf(block).map(([k]) => k));
      for (const key of vocab) {
        if (new RegExp(`\\$\\{?${key}\\b`).test(body) && !declared.has(key)) {
          missing.push(`  ${harness}.sh references $${key}, its block does not define it`);
        }
      }
    }
    expect(missing, `gates referencing undeclared ports:\n${missing.join("\n")}`).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The literal scan: an ALLOWLIST, not a denylist of shapes.
  //
  // Every integer in the unprivileged port range, in any scanned file, outside
  // comments and not part of a longer token, IS a port unless it is
  //   (a) a documented, source-scoped non-port occurrence (NOT_PORTS),
  //   (b) a documented product port outside the test topology,
  //   (c) a port the file is the declared owner of, or
  //   (d) a named waiver tied to a filed issue (WAIVED).
  // Gates, drivers and lib/ own nothing — asserted below, not merely asserted in
  // a comment.
  //
  // KNOWN EVASIONS (deliberate-evasion class, listed because the token rule is
  // this design's load-bearing claim): numeric separators (`18_991`), hex/octal
  // (`0x4A2F`), and runtime concatenation of sub-4-digit parts. Each requires
  // intent; the scan targets the accident.
  // -------------------------------------------------------------------------

  /**
   * Exact source occurrences inside the port range that are not ports.
   *
   * The count is load-bearing: the same value in another file has no allowance,
   * and another occurrence in this file exceeds the allowance. This avoids
   * brittle line numbers while preventing a timeout from globally exempting a
   * listener that happens to use the same number.
   */
  const NOT_PORTS: LiteralBudget[] = [
    { file: "e2e/local/require-env.ts", value: 65535, count: 1, reason: "port-range validation upper bound" },
    { file: "e2e/local/lib/harness.sh", value: 65535, count: 1, reason: "port-range validation upper bound" },
    { file: "e2e/local/run-multi-message.sh", value: 8192, count: 1, reason: "OpenClaw maxTokens" },
    { file: "e2e/local/run-multi-message.sh", value: 20000, count: 1, reason: "OpenClaw reserveTokensFloor" },
    { file: "e2e/local/run-two-account-isolation.sh", value: 8192, count: 2, reason: "OpenClaw maxTokens" },
    { file: "e2e/local/run-two-account-isolation.sh", value: 20000, count: 1, reason: "OpenClaw reserveTokensFloor" },
    { file: "e2e/local/run-derived-trust.sh", value: 8192, count: 1, reason: "OpenClaw maxTokens" },
    { file: "e2e/local/run-derived-trust.sh", value: 20000, count: 1, reason: "OpenClaw reserveTokensFloor" },
    { file: "e2e/local/run-enrolled-transport.sh", value: 8192, count: 1, reason: "OpenClaw maxTokens" },
    { file: "e2e/local/run-enrolled-transport.sh", value: 20000, count: 1, reason: "OpenClaw reserveTokensFloor" },
    { file: "e2e/local/run-all-real.sh", value: 8192, count: 1, reason: "OpenClaw maxTokens" },
    { file: "e2e/local/run-all-real.sh", value: 20000, count: 1, reason: "OpenClaw reserveTokensFloor" },
    { file: "e2e/local/run-turn-outcome.sh", value: 8192, count: 1, reason: "OpenClaw maxTokens" },
    { file: "e2e/local/run-turn-outcome.sh", value: 20000, count: 1, reason: "OpenClaw reserveTokensFloor" },
    { file: "e2e/local/two-account-isolation-roundtrip.ts", value: 5000, count: 1, reason: "timeout in ms" },
    { file: "e2e/local/two-account-isolation-roundtrip.ts", value: 25000, count: 1, reason: "timeout in ms" },
    { file: "e2e/local/multi-message-roundtrip.ts", value: 5000, count: 1, reason: "timeout in ms" },
    { file: "e2e/local/enrolled-transport-roundtrip.ts", value: 5000, count: 1, reason: "timeout in ms" },
    { file: "e2e/local/enrolled-transport-roundtrip.ts", value: 30000, count: 1, reason: "timeout in ms" },
    { file: "e2e/local/turn-outcome-roundtrip.ts", value: 5000, count: 1, reason: "timeout in ms" },
    { file: "e2e/local/all-real.mjs", value: 25000, count: 1, reason: "timeout in ms" },
    { file: "e2e/local/all-real.mjs", value: 30000, count: 1, reason: "timeout in ms" },
    { file: "packages/saas/src/ac6-device-flow-e2e.test.ts", value: 2000, count: 1, reason: "startup delay in ms" },
    { file: "packages/saas/src/nats-permissions-realserver.test.ts", value: 65535, count: 1, reason: "port-range validation upper bound" },
    { file: "packages/saas/src/nats-permissions-realserver.test.ts", value: 5000, count: 1, reason: "waitFor default timeout in ms" },
    { file: "packages/saas/src/nats-permissions-realserver.test.ts", value: 4000, count: 2, reason: "connection timeout in ms" },
    { file: "packages/saas/src/nats-permissions-realserver.test.ts", value: 10000, count: 1, reason: "server readiness timeout in ms" },
    { file: "packages/saas/src/nats-permissions-realserver.test.ts", value: 20000, count: 1, reason: "Vitest hook timeout in ms" },
    { file: "packages/saas/src/nats-permissions-realserver.test.ts", value: 2000, count: 9, reason: "assertion timeout in ms" },
    { file: "packages/plugin/src/nats-transport-realserver.test.ts", value: 65535, count: 1, reason: "port-range validation upper bound" },
    { file: "packages/plugin/src/nats-transport-realserver.test.ts", value: 2000, count: 1, reason: "waitFor default timeout in ms" },
    { file: "packages/plugin/src/nats-transport-realserver.test.ts", value: 8000, count: 1, reason: "server readiness timeout in ms" },
    { file: "packages/plugin/src/nats-transport-realserver.test.ts", value: 15000, count: 1, reason: "Vitest hook timeout in ms" },
    { file: "packages/plugin/src/nats-transport-realserver.test.ts", value: 5000, count: 1, reason: "message fixture amount" },
    { file: "packages/plugin/src/nats-transport-realserver.test.ts", value: 3000, count: 2, reason: "assertion timeout in ms" },
    { file: "packages/plugin/src/nats-transport-realserver.test.ts", value: 4000, count: 1, reason: "assertion timeout in ms" },
    { file: "packages/plugin/src/auth.ts", value: 4000, count: 1, reason: "JWKS fetch timeout in ms" },
    { file: "packages/plugin/src/enrollment-client.ts", value: 5000, count: 1, reason: "RFC 8628 polling floor in ms" },
    { file: "packages/plugin/src/ingress-result-chunks.ts", value: 1024, count: 1, reason: "byte-size multiplier" },
    { file: "packages/plugin/src/nats-transport.ts", value: 1024, count: 4, reason: "protocol buffer-size multiplier" },
    { file: "packages/plugin/src/preflight.ts", value: 5000, count: 1, reason: "relay-dial timeout in ms" },
    { file: "packages/saas/src/setup-trust-chain.ts", value: 2048, count: 2, reason: "RSA key size in bits" },
  ];

  /**
   * Real product dial defaults reached only through provenance imports. They are
   * ports, so they are deliberately not called NOT_PORTS; the discovered tests
   * inject their own listener URLs and these defaults do not bind test sockets.
   */
  const OUTSIDE_TEST_TOPOLOGY: LiteralBudget[] = [
    {
      file: "packages/plugin/src/nats-credential-source.ts",
      value: 4222,
      count: 1,
      reason: "product NATS dial fallback; discovered tests inject their own URL",
    },
    {
      file: "packages/plugin/src/nats-credential-source.ts",
      value: 3001,
      count: 1,
      reason: "product SaaS dial fallback; discovered tests inject their own base URL",
    },
  ];

  /**
   * Known-bad literals waived pending a filed fix. Every entry's exact count
   * must remain present in its file — see the reciprocal test below, which
   * forces the list to shrink when the defect is fixed and grow red when a
   * second occurrence appears.
   */
  const WAIVED: LiteralBudget[] = [
    {
      file: "packages/saas/src/demo-server-role.test.ts",
      value: 18722,
      count: 1,
      reason: "= run-two-account-isolation NATS_WS; spawn env for a demo server that never dials it. Issue #138.",
    },
    {
      file: "packages/saas/src/demo-ui-smoke.test.ts",
      value: 19299,
      count: 1,
      reason: "= run-two-account-isolation GW_PORT; spawn env (DEMO_GW_URL) for a demo server that never dials it. Issue #138.",
    },
    {
      file: "packages/saas/src/demo-ui-smoke.test.ts",
      value: 4222,
      count: 1,
      reason: "= ac6-device-flow-e2e NATS_CLIENT_PORT; spawn env (NATS_URL), same defect, four lines above the DEMO_GW_URL case. Issue #138.",
    },
  ];

  /** Every port-range integer in the scan set. */
  function scanLiterals(): PortLiteral[] {
    return literalsInFiles(REPO, scannedFiles());
  }

  it("never exempts a port owned by the same source", () => {
    const clashes = [...NOT_PORTS, ...OUTSIDE_TEST_TOPOLOGY, ...WAIVED]
      .filter((rule) => ownedPorts(rule.file).has(rule.value))
      .map(
        (rule) =>
          `  ${budgetKey(rule.file, rule.value)} (${rule.reason}) is also owned by that file`,
      );
    expect(clashes, `literal budget hides owned ports:\n${clashes.join("\n")}`).toEqual([]);
  });

  it("keeps every literal occurrence budget exact", () => {
    const literals = scanLiterals();
    const dead = [
      ...literalBudgetProblems(literals, NOT_PORTS, "NOT_PORTS"),
      ...literalBudgetProblems(
        literals,
        OUTSIDE_TEST_TOPOLOGY,
        "OUTSIDE_TEST_TOPOLOGY",
      ),
      ...literalBudgetProblems(literals, WAIVED, "WAIVED"),
    ];
    expect(dead, `stale literal budgets:\n${dead.join("\n")}`).toEqual([]);
  });

  it("scopes a timeout exemption away from a discovered fixed listener", () => {
    const timeoutFile = "e2e/local/timeout-fixture.ts";
    const listenerFile = "packages/fixture/src/listener.test.ts";
    const listener = "new WebSocketServer({ port: 3000 });";
    const exemptions: LiteralBudget[] = [
      { file: timeoutFile, value: 3000, count: 1, reason: "timeout in ms" },
    ];
    const timeoutLiterals = literalsInSource(timeoutFile, "setTimeout(done, 3000);");
    const listenerLiterals = literalsInSource(listenerFile, listener);

    expect(isBindingSource(listener)).toBe(true);
    expect(doc.reserved["3000"]).toBeDefined();
    expect(withoutLiteralBudgets(timeoutLiterals, exemptions)).toEqual([]);
    expect(
      withoutLiteralBudgets(
        [...timeoutLiterals, ...listenerLiterals],
        exemptions,
      ),
    ).toEqual(listenerLiterals);
  });

  it("does not let an extra same-file literal share an exemption", () => {
    const file = "packages/fixture/src/listener.test.ts";
    const source = [
      "setTimeout(done, 3000);",
      "new WebSocketServer({ port: 3000 });",
    ].join("\n");
    const exemptions: LiteralBudget[] = [
      { file, value: 3000, count: 1, reason: "timeout in ms" },
    ];

    expect(withoutLiteralBudgets(literalsInSource(file, source), exemptions)).toEqual([
      [file, 2, 3000],
    ]);
  });

  it("does not let a second same-file listener share a waiver", () => {
    const file = "packages/saas/src/demo-ui-smoke.test.ts";
    const source = [
      "new WebSocketServer({ port: 19299 });",
      "new WebSocketServer({ port: 19299 });",
    ].join("\n");
    const waiver: LiteralBudget[] = [
      { file, value: 19299, count: 1, reason: "existing filed defect" },
    ];
    const literals = literalsInSource(file, source);

    expect(withoutLiteralBudgets(literals, waiver)).toEqual([[file, 2, 19299]]);
    expect(literalBudgetProblems(literals, waiver, "WAIVED")).toEqual([
      expect.stringContaining("expects 1, found 2"),
    ]);
  });

  it("grants literal rights to no gate, driver or helper", () => {
    // "Gates, drivers and lib/ own nothing" was only a comment. A tools/vitest
    // entry naming a gate script would silently re-grant literal rights.
    const bad: string[] = [];
    for (const group of ["vitest", "tools"] as const) {
      for (const k of Object.keys(doc[group] ?? {})) {
        if (k.startsWith("$")) continue;
        if (k.startsWith("e2e/local/") && !/^e2e\/local\/[^/]+\.mjs$/.test(k)) {
          bad.push(`  ${group}."${k}" — nothing under e2e/local may own a literal except a standalone tool`);
        }
        if (/^e2e\/local\/(run-.*\.sh|lib\/)/.test(k)) {
          bad.push(`  ${group}."${k}" — gates and lib/ must take ports from harness_ports`);
        }
      }
    }
    expect(bad, `literal rights granted where they must not be:\n${bad.join("\n")}`).toEqual([]);
  });

  it("contains no port literal outside the authority", () => {
    const offenders: string[] = [];
    const allocatedBy = new Map<number, string>();
    for (const [o, k, p] of allocations) {
      allocatedBy.set(p, `${allocatedBy.get(p) ? `${allocatedBy.get(p)}, ` : ""}${o}.${k}`);
    }

    for (const [rel, line, port] of withoutLiteralBudgets(
      scanLiterals(),
      [...NOT_PORTS, ...OUTSIDE_TEST_TOPOLOGY, ...WAIVED],
    )) {
      if (ownedPorts(rel).has(port)) continue;
      const whose = allocatedBy.has(port)
        ? ` — ports.json allocates it to ${allocatedBy.get(port)}`
        : " — not registered in ports.json at all";
      offenders.push(`  ${rel}:${line}: literal ${port}${whose}`);
    }

    expect(
      offenders,
      `port literals outside the authority:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the declared suites in sync, both directions", () => {
    const problems: string[] = [];
    for (const group of ["vitest", "tools"] as const) {
      for (const [suite, block] of Object.entries(doc[group] ?? {})) {
        if (suite.startsWith("$")) continue;
        const abs = join(REPO, suite);
        if (!existsSync(abs)) {
          problems.push(`  ${group}."${suite}" is declared but does not exist`);
          continue;
        }
        const code = decomment(readFileSync(abs, "utf8"), suite.endsWith(".sh")).join("\n");
        if (readsAuthority(code)) {
          for (const [key] of portsOf(block)) {
            if (!new RegExp(`SUITE_PORTS\\s*\\.\\s*${key}\\b`).test(code)) {
              problems.push(`  ${suite} resolves ports.json but never reads SUITE_PORTS.${key} — declared and unused`);
            }
          }
        } else {
          for (const [key, port] of portsOf(block)) {
            if (!new RegExp(`(?<![\\w.\\-])${port}(?![\\w.\\-])`).test(code)) {
              problems.push(`  ${suite}: declares ${key}=${port}, but that number does not appear in its code`);
            }
          }
        }
      }
    }
    expect(problems, `ports.json out of sync with its declared files:\n${problems.join("\n")}`).toEqual([]);
  });
});
