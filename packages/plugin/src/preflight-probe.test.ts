/**
 * Add-time permission probe (P0-3 D4a) — correlation + PING-barrier verdict logic.
 *
 * The probe's REAL-server verdict semantics (a real nats-server sends the `-ERR`
 * before PONG, allows the agent's own subtree, denies outside the namespace) are
 * proven in packages/saas/src/nats-permissions-realserver.test.ts — the plugin
 * bans @nats-io so it cannot mint scoped creds here. This suite drives a
 * CONTROLLABLE fake transport to pin the parts that ARE plugin logic: `-ERR`
 * correlation on BOTH operation kind AND subject, the sequential 4-probe verdict,
 * and per-probe cleanup (UNSUB).
 */
import { EventEmitter } from "node:events";

import { describe, it, expect } from "vitest";

import {
  runPermissionProbes,
  parsePermissionViolation,
  type ProbeOperation,
  type ProbeTransport,
} from "./preflight-probe.js";
import { preflightSubject } from "./subjects.js";

function violationErr(op: ProbeOperation, subject: string): Error {
  return new Error(`NATS server error: -ERR 'Permissions Violation for ${op} to "${subject}"'`);
}

/**
 * A fake transport modeling nats-server: a SUB/PUB the `deny` predicate rejects
 * queues a `-ERR` that is flushed (emitted on `error`) on the next `flush()` —
 * mirroring the barrier (the server emits the op's `-ERR` before PONG). `extra`
 * lets a test inject an UNCORRELATED error on a flush.
 */
class FakeProbeTransport extends EventEmitter implements ProbeTransport {
  sid = 0;
  calls: Array<{ op: string; subject: string }> = [];
  private queued: Error[] = [];
  constructor(
    private readonly deny: (op: ProbeOperation, subject: string) => boolean,
    private readonly extra: () => Error[] = () => [],
  ) {
    super();
  }
  subscribe(subject: string): number {
    this.calls.push({ op: "sub", subject });
    if (this.deny("Subscription", subject)) this.queued.push(violationErr("Subscription", subject));
    return ++this.sid;
  }
  publish(subject: string): void {
    this.calls.push({ op: "pub", subject });
    if (this.deny("Publish", subject)) this.queued.push(violationErr("Publish", subject));
  }
  unsubscribe(sid: number): void {
    this.calls.push({ op: "unsub", subject: String(sid) });
  }
  async flush(): Promise<void> {
    for (const e of [...this.queued, ...this.extra()]) this.emit("error", e);
    this.queued = [];
  }
}

const IDS = { tenant: "t1", accountId: "a1" };
const SELF = preflightSubject("t1", "a1");
const FOREIGN = "webchannel.other-tenant._probe";
const FOREIGN_NAMESPACE = "_webchannel_preflight_foreign.fixed";

describe("parsePermissionViolation", () => {
  it("extracts operation + subject from a real -ERR line", () => {
    expect(parsePermissionViolation(`NATS server error: -ERR 'Permissions Violation for Subscription to "x.y"'`))
      .toEqual({ operation: "Subscription", subject: "x.y" });
    expect(parsePermissionViolation(`… Permissions Violation for Publish to "a.b.c"`))
      .toEqual({ operation: "Publish", subject: "a.b.c" });
  });
  it("returns null for a non-violation error", () => {
    expect(parsePermissionViolation("NATS server error: -ERR 'Authorization Violation'")).toBeNull();
  });
});

describe("runPermissionProbes — sequential PING-barrier verdicts", () => {
  it("PASS: self sub+pub allowed, foreign sub denied", async () => {
    const t = new FakeProbeTransport(
      (_op, subject) => subject === FOREIGN || subject === FOREIGN_NAMESPACE,
    );
    const report = await runPermissionProbes(t, IDS, { foreignSubject: FOREIGN, foreignNamespaceSubject: FOREIGN_NAMESPACE });
    expect(report.verdict).toBe("PASS");
    expect(report.results.map((r) => r.allowed)).toEqual([true, true, false, false]);
  });

  it("FAIL + template when the agent is denied SUB on its own subtree (P1)", async () => {
    const t = new FakeProbeTransport((op, subject) => op === "Subscription" && subject === SELF);
    const report = await runPermissionProbes(t, IDS, { foreignSubject: FOREIGN, foreignNamespaceSubject: FOREIGN_NAMESPACE });
    expect(report.verdict).toBe("FAIL");
    expect(report.results[0].allowed).toBe(false);
    // The FAIL line carries the permission template so the operator can fix it.
    expect(report.line).toContain("BYO-NATS subject permissions required");
  });

  it("FAIL when the agent is denied PUB on its own subtree (P2) — same subject, different op", async () => {
    const t = new FakeProbeTransport((op, subject) => op === "Publish" && subject === SELF);
    const report = await runPermissionProbes(t, IDS, { foreignSubject: FOREIGN, foreignNamespaceSubject: FOREIGN_NAMESPACE });
    expect(report.verdict).toBe("FAIL");
    // P1 (sub, same subject) is NOT tripped — correlation is by op AND subject.
    expect(report.results[0].allowed).toBe(true);
    expect(report.results[1].allowed).toBe(false);
  });

  it("WARN (over-broad) when the foreign-namespace subscription is ALLOWED", async () => {
    const t = new FakeProbeTransport(() => false); // nothing denied
    const report = await runPermissionProbes(t, IDS, { foreignSubject: FOREIGN, foreignNamespaceSubject: FOREIGN_NAMESPACE });
    expect(report.verdict).toBe("WARN");
    expect(report.results[2].allowed).toBe(true);
    expect(report.line).toContain("OVER-BROAD");
  });

  it("WARN when access is limited to webchannel but crosses tenant boundaries", async () => {
    // Models allow `webchannel.>`: the old outside-namespace-only probe called
    // this PASS even though these creds can read every tenant.
    const t = new FakeProbeTransport(
      (_op, subject) => !subject.startsWith("webchannel."),
    );
    const report = await runPermissionProbes(t, IDS, {
      foreignSubject: FOREIGN,
      foreignNamespaceSubject: FOREIGN_NAMESPACE,
    });
    expect(report.verdict).toBe("WARN");
    expect(report.results[2].allowed).toBe(true);
    expect(report.results[3].allowed).toBe(false);
    expect(report.line).toContain("another tenant");
  });

  it("correlation: an UNCORRELATED -ERR (wrong operation) does not trip a probe", async () => {
    // During P1 (Subscription of SELF) the server spuriously emits a PUBLISH
    // violation for SELF. Different op ⇒ must NOT be attributed to the sub probe.
    let fired = false;
    const t = new FakeProbeTransport(
      () => false,
      () => {
        if (fired) return [];
        fired = true;
        return [violationErr("Publish", SELF)];
      },
    );
    const report = await runPermissionProbes(t, IDS, { foreignSubject: FOREIGN, foreignNamespaceSubject: FOREIGN_NAMESPACE });
    expect(report.results[0].allowed).toBe(true); // P1 not tripped by the Publish -ERR
  });

  it("cleans up each sub probe with an UNSUB after its barrier", async () => {
    const t = new FakeProbeTransport(() => false);
    await runPermissionProbes(t, IDS, { foreignSubject: FOREIGN, foreignNamespaceSubject: FOREIGN_NAMESPACE });
    // P1 sub → unsub, P2 pub, P3 foreign tenant sub, P4 foreign namespace sub.
    const ops = t.calls.map((c) => c.op);
    expect(ops).toEqual(["sub", "unsub", "pub", "sub", "unsub", "sub", "unsub"]);
  });

  it("does not leave `error` listeners attached after the probes (no leak)", async () => {
    const t = new FakeProbeTransport(() => false);
    await runPermissionProbes(t, IDS, { foreignSubject: FOREIGN, foreignNamespaceSubject: FOREIGN_NAMESPACE });
    expect(t.listenerCount("error")).toBe(0);
  });

  it("a rejecting flush() PROPAGATES (and still unhooks its listener) — the contract preflight relies on", async () => {
    // FakeProbeTransport's flush resolves unconditionally, so nothing here ever
    // exercised the barrier-timeout path (nats-transport.ts:500 rejects). That gap
    // is why the rejection's misattribution as a "relay dial failed" survived:
    // runPermissionProbes has no internal catch and MUST surface the rejection so
    // its caller can attribute it to the probe leg (see preflight.test.ts). Pinning
    // both halves of that contract — it rejects, and it does not leak a listener.
    const t = new FakeProbeTransport(() => false);
    const boom = new Error("NatsTransport: flush (PING/PONG) timed out after 2000ms");
    t.flush = async () => {
      throw boom;
    };
    await expect(
      runPermissionProbes(t, IDS, { foreignSubject: FOREIGN, foreignNamespaceSubject: FOREIGN_NAMESPACE }),
    ).rejects.toThrow("flush (PING/PONG) timed out");
    expect(t.listenerCount("error")).toBe(0);
  });
});
