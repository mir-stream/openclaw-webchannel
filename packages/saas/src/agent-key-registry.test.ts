import { describe, expect, it } from "vitest";
import { agentKeyRegistryKey } from "./agent-key-registry.js";
import { MemoryEnrollmentRepository } from "./enrollment-repository.js";
import { runAgentKeyRegistryConformance } from "./agent-key-registry-conformance.js";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("MemoryEnrollmentRepository v2", () => {
  it("runs the exported conformance suite", async () => {
    await runAgentKeyRegistryConformance(() => new MemoryEnrollmentRepository());
  });

  it("registers, conflicts, replaces, and records append-only history", async () => {
    const r = new MemoryEnrollmentRepository();
    const a = await r.register("t", "a", A, null);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.record.activationId).not.toBe(a.record.keyId);
    const conflict = await r.register("t", "a", B, null);
    expect(conflict).toMatchObject({ ok: false, reason: "conflict" });
    const b = await r.register("t", "a", B, a.record.activationId);
    expect(b.ok).toBe(true);
    const history = await r.listHistory("t", "a");
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ status: "superseded", supersededBy: history[0].activationId });
  });

  it("uses activation events for CAS and rejects A-B-A replay", async () => {
    const r = new MemoryEnrollmentRepository();
    const a1 = await r.register("t", "a", A, null); expect(a1.ok).toBe(true); if (!a1.ok) return;
    const b = await r.register("t", "a", B, a1.record.activationId); expect(b.ok).toBe(true); if (!b.ok) return;
    const a2 = await r.register("t", "a", A, b.record.activationId); expect(a2.ok).toBe(true); if (!a2.ok) return;
    expect(a2.record.activationId).not.toBe(a1.record.activationId);
    expect(await r.register("t", "a", B, a1.record.activationId)).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("gives tombstone precedence over idempotency and permits another key", async () => {
    const r = new MemoryEnrollmentRepository();
    await r.register("t", "a", A, null);
    expect(await r.revokeActive("t", "a")).toBe(true);
    expect(await r.revokeActive("t", "a")).toBe(false);
    expect(await r.register("t", "a", A, null)).toEqual({ ok: false, reason: "revoked" });
    expect((await r.register("t", "a", B, null)).ok).toBe(true);
  });

  it("returns defensive snapshots", async () => {
    const r = new MemoryEnrollmentRepository();
    await r.register("t", "a", A, null);
    const active = await r.getActive("t", "a");
    (active as { publicKey: string }).publicKey = B;
    const history = await r.listHistory("t", "a");
    (history[0] as { status: string }).status = "revoked";
    expect((await r.getActive("t", "a"))?.publicKey).toBe(A);
  });

  it("length-prefixes both slot segments", () => {
    expect(agentKeyRegistryKey("a/b", "c")).not.toBe(agentKeyRegistryKey("a", "b/c"));
    expect(agentKeyRegistryKey("t", "default")).not.toBe(agentKeyRegistryKey("td", "efault"));
  });
});
