import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const worker = fileURLToPath(new URL("../test/stop-core-crash-worker.mts", import.meta.url));
const run = (root: string, phase: string) => new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", worker, root, phase], {
    env: { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: join(root, "openclaw.json") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("core worker timed out: " + stderr)); }, 15_000);
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (phase === "crash" ? signal === "SIGKILL" : code === 0) resolve();
    else reject(new Error(`core worker ${phase} exited ${code}/${signal}: ${stderr}`));
  });
});

it("retains a cancelled binding after the public SDK abort race until durable startup retirement", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-core-recovery-"));
  try {
    await run(root, "crash"); await run(root, "recover"); await run(root, "repeat");
    const load = (phase: string) => JSON.parse(readFileSync(join(root, `${phase}.json`), "utf8"));
    const crashed = load("crash"), recovered = load("recover"), repeated = load("repeat");
    expect(crashed.errors).toEqual([]);
    expect(crashed).toMatchObject({ underlyingSettled: false, handlerReturned: true,
      dispatch: { state: "cancelled" }, core: { status: "running", abortedLastRun: true } });
    expect(crashed.acks).toContain("S");
    expect(crashed.bindings).toHaveLength(1);
    for (const after of [recovered, repeated]) {
      expect(after.errors).toEqual([]);
      expect(after.bindings).toEqual([]);
      expect(after.dispatch.state).toBe("cancelled");
      expect(after.core).toMatchObject({ status: "failed", abortedLastRun: true });
      expect(after.core.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(after.core.restartRecoveryDeliveryContext).toBeUndefined();
      expect(after.runs).toEqual([]);
      expect(after.controls).toEqual([]);
      expect(after.receipt).toEqual(crashed.receipt);
    }
    expect(recovered.acks).toEqual(["recover-A", "recover-S"]);
    expect(repeated.acks).toEqual(["repeat-A", "repeat-S"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45_000);
