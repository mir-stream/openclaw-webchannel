import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const worker = fileURLToPath(
  new URL("../test/command-authorization-core-worker.mts", import.meta.url),
);

type ProbeResult = {
  name: string;
  authorized: boolean;
  prepared: boolean;
  before: string;
  after: string;
  resets: boolean;
};

function run(root: string): Promise<ProbeResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, root], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
        OPENCLAW_TEST_FAST: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    // A cold public-SDK startup can exceed 20s while the CI runner is executing
    // the full suite concurrently (the existing core recovery probe does too).
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`command authorization core worker timed out: ${stderr}`));
    }, 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`command authorization core worker exited ${code}/${signal}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as ProbeResult[]);
    });
  });
}

it("keeps denied resets on the pinned core session while open or listed peers reset", async () => {
  const root = mkdtempSync(join(tmpdir(), "command-authorization-core-"));
  try {
    // The worker imports the public SDK only after these isolated ambient paths
    // exist, so it cannot merge the developer's runtime config into the probe.
    writeFileSync(join(root, "openclaw.json"), JSON.stringify({}));
    const results = await run(root);

    expect(results).toHaveLength(7);
    for (const result of results) {
      expect(result.prepared, result.name).toBe(true);
      expect(result.authorized, result.name).toBe(result.resets);
      expect(result.after, result.name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      if (result.resets) {
        expect(result.after, result.name).not.toBe(result.before);
      } else {
        expect(result.after, result.name).toBe(result.before);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 75_000);
