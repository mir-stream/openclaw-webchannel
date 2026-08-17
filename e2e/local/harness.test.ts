import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const HARNESS = join(HERE, "lib", "harness.sh");

function gateScripts(): string[] {
  return readdirSync(HERE)
    .filter((file) => file.startsWith("run-") && file.endsWith(".sh"))
    .sort();
}

let testDir: string;
let dist: string;
let gatewayLog: string;
let distSha: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "webchannel-harness-"));
  dist = join(testDir, "index-nats.js");
  gatewayLog = join(testDir, "gateway.log");
  writeFileSync(dist, "export {};\n");
  distSha = createHash("sha256").update("export {};\n").digest("hex");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

type ProvenanceEmitter = "plugin" | "core";
type PluginSource = {
  source: string;
  plugin?: string;
  emitter?: ProvenanceEmitter;
};

function assertLoadedLog(lines: string[]) {
  writeFileSync(gatewayLog, `${lines.join("\n")}\n`);
  return spawnSync(
    "bash",
    [
      "-c",
      '. "$1"; harness_assert_loaded_dist harness-test "$2"',
      "harness-test",
      HARNESS,
      gatewayLog,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_DIST: dist,
        HARNESS_DIST_SHA: distSha,
      },
    },
  );
}

function assertLoadedRecords(records: PluginSource[]) {
  return assertLoadedLog(
    records
      .map(
        ({ source, plugin = "webchannel", emitter = "plugin" }) =>
          emitter === "plugin"
            ? `webchannel: loaded plugin bundle (plugin=${plugin}, source=${source})`
            : `[plugins] channel "webchannel" registered (plugin=${plugin}, source=${source})`,
      ),
  );
}

function assertLoaded(source: string, plugin = "webchannel") {
  return assertLoadedRecords([{ source, plugin }]);
}

describe("harness_prepare_private_root", () => {
  it("makes an umask-0002 root exactly 0700 without deleting existing contents", () => {
    const root = join(testDir, "private-root");
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "umask 0002",
          'mkdir -p "$2"',
          'printf preserved > "$2/sentinel"',
          '. "$1"',
          'harness_prepare_private_root "$2"',
          'test "$(cat "$2/sentinel")" = preserved',
          'if harness_prepare_private_root ""; then exit 31; fi',
          'if harness_prepare_private_root "/"; then exit 32; fi',
        ].join("\n"),
        "harness-private-root-test",
        HARNESS,
        root,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, ".openclaw")).isDirectory()).toBe(true);
    expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("preserved");
    expect(result.stderr).toContain("requires one non-empty root path");
    expect(result.stderr).toContain("refusing unsafe private root target");
  });

  it("keeps every live gate and the demo on the private-root preparation path", () => {
    for (const script of gateScripts()) {
      const source = readFileSync(join(HERE, script), "utf8");
      expect(source, script).toMatch(/^harness_prepare_private_root "\$OCH"$/m);
      expect(source, script).not.toMatch(/^mkdir -p "\$OCH\/\.openclaw"$/m);
    }

    const demo = readFileSync(join(REPO, "demo", "run.sh"), "utf8");
    expect(demo).toMatch(
      /mkdir -p "\$OCH\/\.openclaw"\s*\nchmod 0700 "\$OCH"/,
    );
  });
});

describe("harness_assert_loaded_dist", () => {
  it("accepts plugin provenance with zero core diagnostics", () => {
    const result = assertLoaded(dist);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("DIST-ASSERT: gateway loaded the bundle");
  });

  it("accepts an exact plugin source path containing spaces and parentheses", () => {
    const parenthesizedDir = join(testDir, "bundle (candidate)");
    mkdirSync(parenthesizedDir);
    dist = join(parenthesizedDir, "index-nats.js");
    writeFileSync(dist, "export {};\n");

    const result = assertLoaded(dist);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`source=${dist}`);
  });

  it("accepts corroborating plugin and core records for the same source", () => {
    const result = assertLoadedRecords([
      { source: dist, emitter: "plugin" },
      { source: dist, emitter: "core" },
    ]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts duplicate identical webchannel source records", () => {
    const result = assertLoadedRecords([{ source: dist }, { source: dist }]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects an exact plugin source plus a foreign core source containing spaces and parentheses", () => {
    const wrong = join(testDir, "foreign dist (copy)", "index-nats.js");
    const result = assertLoadedRecords([
      { source: dist, emitter: "plugin" },
      { source: wrong, emitter: "core" },
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`source=${dist}\n`);
    expect(result.stderr).toContain(`source=${wrong}\n`);
  });

  it("rejects wrong then exact webchannel sources and reports both", () => {
    const wrong = `${dist}.backup`;
    const result = assertLoadedRecords([{ source: wrong }, { source: dist }]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`source=${dist}\n`);
    expect(result.stderr).toContain(`source=${wrong}\n`);
  });

  it("rejects a source for which the expected path is only a prefix", () => {
    const result = assertLoaded(`${dist}.backup`);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`source=${dist}.backup`);
  });

  it("rejects a source for which the expected path is only a suffix", () => {
    const result = assertLoaded(`stale-${dist}`);

    expect(result.status).toBe(2);
  });

  it("does not accept an exact source resolved for another plugin", () => {
    const result = assertLoaded(dist, "another-plugin");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no provenance record for plugin=webchannel");
  });

  it("rejects a log with neither plugin nor core provenance", () => {
    const result = assertLoadedLog([
      "webchannel: gateway setup completed",
      "[gateway] ready",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "(none — no provenance record for plugin=webchannel)",
    );
  });
});
