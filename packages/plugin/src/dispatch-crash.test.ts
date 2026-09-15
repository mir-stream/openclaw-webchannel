import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const worker = fileURLToPath(new URL("../test/dispatch-crash-worker.mts", import.meta.url));
const run = (dir: string, phase: string, boundary: string) => new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", worker, dir, phase, boundary], { stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; child.stderr.on("data", chunk => { error += chunk; });
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child timed out: " + error)); }, 10_000);
  child.on("error", reject);
  child.on("close", (code, signal) => { clearTimeout(timer); if ((phase === "crash" && signal === "SIGKILL") || (phase !== "crash" && code === 0)) resolve(); else reject(new Error(`child ${phase} ${code} ${signal}: ${error}`)); });
});
it.each(["accept", "before-start", "after-start", "effect", "queued", "cancelled"])("OS process recreation at %s preserves option 2", async boundary => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch369-crash-"));
  try {
    await run(dir, "crash", boundary); await run(dir, "recover", boundary); await run(dir, "repeat", boundary);
    const recovered = JSON.parse(readFileSync(join(dir, "recover.json"), "utf8"));
    const repeated = JSON.parse(readFileSync(join(dir, "repeat.json"), "utf8"));
    const expectedA = boundary === "accept" || boundary === "before-start" ? "completed" : boundary === "cancelled" ? "cancelled" : "interrupted";
    expect(recovered.dispatch[0]).toMatchObject({ messageId: "webchannel-user-1", seq: 1, state: expectedA, input: { turnId: "A", randomId: "logical-A" } });
    expect(recovered.history).toContainEqual(expect.objectContaining({ id: "webchannel-user-1", requestState: expectedA }));
    const expectedRuns = boundary === "accept" || boundary === "before-start" ? ["A"] : boundary === "queued" ? ["C"] : [];
    expect(recovered.calls).toEqual(expectedRuns);
    if (boundary === "queued") {
      expect(recovered.history).toContainEqual(expect.objectContaining({ id: "result-C", text: "answer B\n\nC" }));
      expect(recovered.dispatch.slice(1).map((r: { state: string }) => r.state)).toEqual(["completed", "completed"]);
    }
    // Retransmit only persisted originals: B/C absent in single-request cases
    // are fresh sends in the last child, so A is the universal suppression check.
    expect(repeated.calls).not.toContain("A");
    if (boundary === "queued" || boundary === "cancelled") expect(repeated.calls).toEqual([]);
    expect(repeated.dispatch[0]).toEqual(recovered.dispatch[0]);
    const effects = readFileSync(join(dir, "effects.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
    expect(effects.filter(e => e.id === "A")).toHaveLength(boundary === "after-start" ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 25_000);
