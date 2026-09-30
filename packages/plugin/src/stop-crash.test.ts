import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const worker = fileURLToPath(new URL("../test/stop-crash-worker.mts", import.meta.url));
const run = (root: string, phase: string, boundary: string) => new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", worker, root, phase, boundary], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`stop child timed out: ${stderr}`)); }, 10_000);
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (phase === "crash" ? signal === "SIGKILL" : code === 0) resolve();
    else reject(new Error(`stop child ${phase} ${boundary} exited ${code}/${signal}: ${stderr}`));
  });
});

/** Real process death/reopen and real SQLite, with a controlled core recipient. */
it.each(["before-commit", "after-commit", "inside-stop-ack"])("SIGKILL at %s preserves the committed stop boundary and retransmission result", async boundary => {
  const root = mkdtempSync(join(tmpdir(), "stop-crash-"));
  try {
    await run(root, "crash", boundary);
    await run(root, "recover", boundary);
    await run(root, "repeat", boundary);
    const load = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));
    const before = load("before.json");
    const recovered = load("recover.json");
    const repeated = load("repeat.json");
    const committed = boundary !== "before-commit";
    expect(recovered.errors).toEqual([]); expect(repeated.errors).toEqual([]);
    expect(recovered.initial.targets).toEqual(committed ? [true, true, true, false, false] : [false, false, false, false, false]);
    expect(recovered.initial.stop).toEqual(committed ? { key: "logical-S", cancelBuffered: true, targetCount: 3 } : null);
    if (!committed) {
      // All SQL writes made before SIGKILL rolled back, not just the receipt.
      expect(recovered.initial.dispatch).toEqual(before.dispatch);
      expect(recovered.initial.events).toEqual(before.events);
    }
    expect(recovered.initial.dispatch.slice(0, 2).map((row: { state: string }) => row.state)).toEqual(committed ? ["cancelled", "cancelled"] : ["started", "queued"]);
    expect(recovered.recovered.dispatch.slice(0, 2).map((row: { state: string }) => row.state)).toEqual(committed ? ["cancelled", "cancelled"] : ["interrupted", "completed"]);
    expect(recovered.originalReplays.calls).toEqual(committed ? [] : ["B", "C"]);
    expect(recovered.duplicate.controls).toEqual(committed ? [] : ["device-2-retry:S"]);
    expect(recovered.duplicate.signalD).toBe(!committed);
    expect(recovered.duplicate.retained).toEqual(committed ? ["E"] : []);
    expect(recovered.duplicate.receipt).toMatchObject({ key: "logical-S", targetCount: committed ? 3 : 2 });
    expect(recovered.final.dispatch.slice(3).map((row: { state: string } | null) => row?.state ?? null)).toEqual(committed ? ["completed", "completed"] : ["cancelled", null]);
    expect(recovered.budget).toEqual({ messages: 0, bytes: 0 });
    expect(repeated.calls).toEqual([]);
    expect(repeated.controls).toEqual([]);
    expect(repeated.final.stop).toEqual(recovered.final.stop);
    expect(repeated.final.targets).toEqual(recovered.final.targets);
    const acks = readFileSync(join(root, "acks.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(acks.filter(ack => ack.phase === "crash" && ack.ids.includes("device-2:S"))).toHaveLength(boundary === "inside-stop-ack" ? 1 : 0);
    expect(acks).toContainEqual(expect.objectContaining({ phase: "repeat", ids: ["device-2-repeat:S"] }));
    const effects = readFileSync(join(root, "effects.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(effects.filter(effect => effect.text === "A")).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
