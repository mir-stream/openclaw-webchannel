import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, "lib", "harness.sh");

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

type PluginSource = { source: string; plugin?: string };

function assertLoadedRecords(records: PluginSource[]) {
  writeFileSync(
    gatewayLog,
    records
      .map(
        ({ source, plugin = "webchannel" }) =>
          `[plugins] channel registered (plugin=${plugin}, source=${source})`,
      )
      .join("\n") + "\n",
  );
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

function assertLoaded(source: string, plugin = "webchannel") {
  return assertLoadedRecords([{ source, plugin }]);
}

describe("harness_assert_loaded_dist", () => {
  it("accepts an exact webchannel bundle source", () => {
    const result = assertLoaded(dist);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("DIST-ASSERT: gateway loaded the bundle");
  });

  it("accepts an exact source path containing parentheses", () => {
    const parenthesizedDir = join(testDir, "bundle (candidate)");
    mkdirSync(parenthesizedDir);
    dist = join(parenthesizedDir, "index-nats.js");
    writeFileSync(dist, "export {};\n");

    const result = assertLoaded(dist);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`source=${dist}`);
  });

  it("accepts duplicate identical webchannel source records", () => {
    const result = assertLoadedRecords([{ source: dist }, { source: dist }]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects exact then wrong webchannel sources and reports both", () => {
    const wrong = `${dist}.backup`;
    const result = assertLoadedRecords([{ source: dist }, { source: wrong }]);

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
    expect(result.stderr).toContain("no source for plugin=webchannel");
  });
});
