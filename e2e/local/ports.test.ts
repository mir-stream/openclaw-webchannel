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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const SOURCE_EXT = /\.(sh|ts|mts|cts|js|mjs|cjs)$/;

/**
 * Files that bind or spawn a listener, discovered by CONTENT under
 * packages/-/src/.
 *
 * WHY A PREDICATE AND NOT A LIST (review round 3): the previous version scanned
 * exactly `Object.keys(doc.vitest)` outside e2e/local, so a brand-new suite
 * spawning `nats-server -p 14491 --ws_port 18491` — run-multi-message's live
 * ports — was invisible until somebody remembered to register it. `run-*.sh`
 * gets real discovery; the packages half got a hand-maintained enumeration, in a
 * guard whose whole thesis is that those leak. #118's home was a suite in here.
 *
 * Scope is `packages/-/src/-` deliberately. `packages/saas/reference/-` is out:
 * those are reference servers every harness launches with an explicit PORT, and
 * their defaults are recorded under `reserved`. That is a scope boundary with a
 * reason, not an item-by-item exclusion list.
 */
function bindingSources(): string[] {
  const BINDS = /nats-server|\.listen\s*\(|createServer\s*\(|ws_port|\bspawn\s*\(/;
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules") continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else if (SOURCE_EXT.test(e.name)) {
        const code = decomment(readFileSync(join(dir, e.name), "utf8"), false).join("\n");
        if (BINDS.test(code)) out.push(childRel);
      }
    }
  };
  for (const pkg of readdirSync(join(REPO, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    walk(join(REPO, "packages", pkg.name, "src"), `packages/${pkg.name}/src`);
  }
  return out.sort();
}

/**
 * Every file the literal scan covers: all of e2e/local (recursive — a literal in
 * lib/harness.sh overrides harness_ports for all six gates at once), plus every
 * discovered binding source, plus anything ports.json declares (so a declared
 * file is never dropped just because the predicate misses it).
 */
function scannedFiles(): string[] {
  const out = new Set<string>();
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else if (SOURCE_EXT.test(e.name) && childRel !== "e2e/local/ports.test.ts") {
        out.add(childRel);
      }
    }
  };
  walk(HERE, "e2e/local");
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
 * Judged on CODE, never a substring: the prose in nats-transport-realserver
 * mentions "ports.json" four times, which was enough to switch the old check off
 * for the two suites #118 lived in.
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
  //   (a) a documented non-port constant (NOT_PORTS),
  //   (b) a port the file is the declared owner of, or
  //   (c) a named waiver tied to a filed issue (WAIVED).
  // Gates, drivers and lib/ own nothing — asserted below, not merely asserted in
  // a comment.
  //
  // KNOWN EVASIONS (deliberate-evasion class, listed because the token rule is
  // this design's load-bearing claim): numeric separators (`18_991`), hex/octal
  // (`0x4A2F`), and runtime concatenation of sub-4-digit parts. Each requires
  // intent; the scan targets the accident.
  // -------------------------------------------------------------------------

  /** Integers inside the port range that are not ports. Each needs a reason. */
  const NOT_PORTS = new Map<number, string>([
    [65535, "upper bound of the port range, used in range validation"],
    [2000, "timeout/delay in ms"],
    [3000, "timeout/delay in ms"],
    [4000, "timeout/delay in ms"],
    [5000, "timeout/delay in ms"],
    [8000, "timeout/delay in ms"],
    [10000, "timeout/delay in ms"],
    [15000, "timeout/delay in ms"],
    [20000, "openclaw compaction reserveTokensFloor in the gate configs"],
    [25000, "timeout/delay in ms"],
    [30000, "timeout/delay in ms"],
    [8192, "openclaw maxTokens in the gate configs"],
  ]);

  /**
   * Known-bad literals waived pending a filed fix. Every entry must still be
   * present in its file — see the reciprocal test below, which forces the list
   * to shrink when the underlying defect is fixed. Without that, fixing the
   * filed issue would silently turn these into permanent blind spots.
   */
  const WAIVED = new Map<string, string>([
    [
      "packages/saas/src/demo-server-role.test.ts:18722",
      "= run-two-account-isolation NATS_WS; spawn env for a demo server that never dials it. Filed by review round 2.",
    ],
    [
      "packages/saas/src/demo-ui-smoke.test.ts:19299",
      "= run-two-account-isolation GW_PORT; spawn env (DEMO_GW_URL) for a demo server that never dials it. Filed by review round 2.",
    ],
    [
      "packages/saas/src/demo-ui-smoke.test.ts:4222",
      "= ac6-device-flow-e2e NATS_CLIENT_PORT; spawn env (NATS_URL), same defect, four lines above the DEMO_GW_URL case.",
    ],
  ]);

  /** [rel, line, port] for every non-exempt port-range integer in the scan set. */
  function scanLiterals(): Array<[string, number, number]> {
    const found: Array<[string, number, number]> = [];
    for (const rel of scannedFiles()) {
      const abs = join(REPO, rel);
      if (!existsSync(abs)) continue;
      decomment(readFileSync(abs, "utf8"), rel.endsWith(".sh")).forEach((line, i) => {
        for (const m of line.matchAll(/(?<![\w.\-])(\d{4,5})(?![\w.\-])/g)) {
          const port = Number(m[1]);
          if (port >= 1024 && port <= 65535) found.push([rel, i + 1, port]);
        }
      });
    }
    return found;
  }

  it("exempts nothing that is actually allocated", () => {
    // One NOT_PORTS line used to disarm the guard for a live allocation across
    // every scanned file at once: adding [14491, "poll budget in ms"] made a
    // literal NATS_TCP=14491 in lib/harness.sh green.
    const allocated = new Map(allocations.map(([o, k, p]) => [p, `${o}.${k}`]));
    const clashes = [...NOT_PORTS.keys()]
      .filter((p) => allocated.has(p))
      .map((p) => `  ${p} is exempt as "${NOT_PORTS.get(p)}" but ports.json allocates it to ${allocated.get(p)}`);
    expect(
      clashes,
      `NOT_PORTS overlaps live allocations:\n${clashes.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps no dead exemption or waiver", () => {
    // Both lists must shrink on their own. An exemption nothing uses, or a waiver
    // whose literal is gone, is a blind spot waiting for a future collision.
    const literals = scanLiterals();
    const seen = new Set(literals.map(([, , p]) => p));
    const seenWaivers = new Set(literals.map(([rel, , p]) => `${rel}:${p}`));

    const dead = [
      ...[...NOT_PORTS.keys()]
        .filter((p) => !seen.has(p))
        .map((p) => `  NOT_PORTS ${p} ("${NOT_PORTS.get(p)}") no longer appears anywhere — remove it`),
      ...[...WAIVED.keys()]
        .filter((k) => !seenWaivers.has(k))
        .map((k) => `  WAIVED ${k} no longer appears — the defect is fixed, remove the waiver`),
    ];
    expect(dead, `dead exemptions/waivers:\n${dead.join("\n")}`).toEqual([]);
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

    for (const [rel, line, port] of scanLiterals()) {
      if (NOT_PORTS.has(port)) continue;
      if (ownedPorts(rel).has(port)) continue;
      if (WAIVED.has(`${rel}:${port}`)) continue;
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
