/**
 * Approval-origin lease registry invariants (issue #93, plan §6.1).
 *
 * The registry's whole value is that it says "I don't know" loudly and often, so
 * most of what follows asserts a NON-answer. The cases that matter are the ones
 * where a plausible-looking peer exists and must NOT be returned: an alias
 * account, an overlapping tuple, a same-millisecond activation, a replayed
 * pre-barrier request, an anomalous clock. A false negative drops one approval;
 * a false positive delivers a permission prompt to the wrong browser.
 *
 * Every semantic test constructs a registry directly with an injected clock —
 * the process-global getter is exercised only by the two global tests, so no
 * test can leak lease state into another.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

import {
  APPROVAL_ORIGIN_REGISTRY_CONTRACT_VERSION,
  APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY,
  ApprovalOriginLeaseRegistry,
  getApprovalOriginRegistry,
  type ApprovalOriginLease,
} from "./approval-origin.js";

// Registry semantics accept an opaque tuple key; production route shape is irrelevant here.
const SESSION = "opaque-session-key-1";
const OTHER_SESSION = "opaque-session-key-2";

type Harness = {
  registry: ApprovalOriginLeaseRegistry;
  /** Set the injected wall clock (ms). */
  set(ms: number): void;
  lease(rawAccountId: string, peerId: string, sessionKey?: string): ApprovalOriginLease;
  /** Create + activate in one step, at the current clock value. */
  run(rawAccountId: string, peerId: string, sessionKey?: string): ApprovalOriginLease;
  /** Create + activate a PRESENCE claim (live, but never selectable). */
  presenceRun(rawAccountId: string, peerId: string, sessionKey?: string): ApprovalOriginLease;
  resolve(
    rawAccountId: string,
    requestCreatedAtMs: number,
    sessionKey?: string,
  ): ReturnType<ApprovalOriginLeaseRegistry["resolve"]>;
};

function harness(
  startMs = 1_000,
  options: { maxPoisonedKeys?: number } = {},
): Harness {
  let nowMs: number = startMs;
  const registry = new ApprovalOriginLeaseRegistry({
    now: () => nowMs,
    ...options,
  });
  const lease = (rawAccountId: string, peerId: string, sessionKey = SESSION) =>
    registry.createLease({ rawAccountId, sessionKey, peerId });
  return {
    registry,
    set: (ms: number) => {
      nowMs = ms;
    },
    lease,
    run: (rawAccountId, peerId, sessionKey = SESSION) => {
      const handle = lease(rawAccountId, peerId, sessionKey);
      handle.activate();
      return handle;
    },
    presenceRun: (rawAccountId, peerId, sessionKey = SESSION) => {
      const handle = registry.createLease({
        rawAccountId,
        sessionKey,
        peerId,
        evidence: "presence",
      });
      handle.activate();
      return handle;
    },
    resolve: (rawAccountId, requestCreatedAtMs, sessionKey = SESSION) =>
      registry.resolve({ rawAccountId, sessionKey, requestCreatedAtMs }),
  };
}

describe("ApprovalOriginLeaseRegistry — resolution", () => {
  it("reports no_match when nothing ever claimed the tuple", () => {
    const h = harness();
    h.set(1_020);
    expect(h.resolve("AcctA", 1_010)).toEqual({ kind: "no_match" });
  });

  it("resolves the exact peer of a single active run", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_030);
    expect(h.resolve("AcctA", 1_020)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("still resolves when duplicate leases share one exact origin", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_012);
    h.run("AcctA", "peerA");
    h.set(1_030);
    expect(h.resolve("AcctA", 1_020)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("is ambiguous for two distinct peers, in either insertion order", () => {
    for (const order of [
      ["peerA", "peerB"],
      ["peerB", "peerA"],
    ]) {
      const h = harness();
      h.set(1_010);
      h.run("AcctA", order[0] as string);
      h.set(1_012);
      h.run("AcctA", order[1] as string);
      h.set(1_030);
      const result = h.resolve("AcctA", 1_020);
      expect(result).toEqual({ kind: "ambiguous" });
      // Never leak a candidate peer under ambiguity, whatever the order.
      expect(JSON.stringify(result)).not.toContain("peer");
    }
  });
});

describe("ApprovalOriginLeaseRegistry — exact raw account identity", () => {
  it("serves the exact raw account only, never a canonical alias", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_030);
    expect(h.resolve("AcctA", 1_020)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
    expect(h.resolve("accta", 1_020)).toEqual({ kind: "no_match" });
  });

  it("poisons the shared canonical tuple when two raw aliases overlap", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_012);
    h.run("accta", "peerB");
    h.set(1_030);
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "ambiguous" });
    expect(h.resolve("accta", 1_020)).toEqual({ kind: "ambiguous" });
  });

  it("poisons when one peer id appears under two different raw accounts", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerShared");
    h.set(1_012);
    h.run("accta", "peerShared");
    h.set(1_030);
    // Same peer string, but two exact origins — provenance is not provable.
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "ambiguous" });
  });

  it("folds `-abc` and `abc` into one canonical tuple (core normalizeAccountId parity)", () => {
    // The regression this pins: the SDK folds this leading-dash spelling, so
    // these are ONE account to core. A private `toLowerCase()` collision domain
    // would keep them apart and silently defeat the poison.
    expect(normalizeAccountId("-abc")).toBe(normalizeAccountId("abc"));

    const h = harness();
    h.set(1_010);
    h.run("-abc", "peerA");
    h.set(1_012);
    h.run("abc", "peerB");
    h.set(1_030);
    expect(h.resolve("abc", 1_020)).toEqual({ kind: "ambiguous" });
    expect(h.resolve("-abc", 1_020)).toEqual({ kind: "ambiguous" });
  });

  it("keeps distinct session keys in distinct collision domains", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_012);
    h.run("AcctA", "peerB", OTHER_SESSION);
    h.set(1_030);
    expect(h.resolve("AcctA", 1_020)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
    expect(h.resolve("AcctA", 1_020, OTHER_SESSION)).toEqual({
      kind: "resolved",
      peerId: "peerB",
    });
  });
});

describe("ApprovalOriginLeaseRegistry — lease handles", () => {
  it("does not claim anything until activate() is called", () => {
    const h = harness();
    h.set(1_010);
    const handle = h.lease("AcctA", "peerA");
    h.set(1_030);
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "no_match" });
    handle.activate();
    h.set(1_050);
    expect(h.resolve("AcctA", 1_040)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("captures activatedAtMs exactly once — repeat activate() is a no-op", () => {
    const h = harness();
    h.set(1_010);
    const handle = h.run("AcctA", "peerA");
    h.set(1_100);
    handle.activate();
    handle.activate();
    h.set(1_200);
    // A re-captured time (1_100) would make this request ineligible; the first
    // capture (1_010) is the only one that counts.
    expect(h.resolve("AcctA", 1_050)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
    // And the duplicate activations must not have created extra claims that
    // could later be released independently.
    handle.release();
    expect(h.resolve("AcctA", 1_050)).toEqual({ kind: "no_match" });
  });

  it("releases only its own claim, by claim id", () => {
    const h = harness();
    h.set(1_010);
    const first = h.run("AcctA", "peerA");
    h.set(1_012);
    const second = h.run("AcctA", "peerA");
    h.set(1_030);

    first.release();
    first.release(); // idempotent, and still only its own claim
    expect(h.resolve("AcctA", 1_020)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
    second.release();
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "no_match" });
  });

  it("ignores activate() after release()", () => {
    const h = harness();
    h.set(1_010);
    const handle = h.lease("AcctA", "peerA");
    handle.release();
    handle.activate();
    h.set(1_030);
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "no_match" });
  });

  it("hands back a frozen handle", () => {
    const h = harness();
    expect(Object.isFrozen(h.lease("AcctA", "peerA"))).toBe(true);
  });
});

describe("ApprovalOriginLeaseRegistry — presence evidence", () => {
  it("is never selectable, at any request time", () => {
    const h = harness();
    h.set(1_010);
    h.presenceRun("AcctA", "peerA");
    h.set(1_100);
    for (const requestCreatedAtMs of [1_001, 1_011, 1_050, 1_100]) {
      expect(h.resolve("AcctA", requestCreatedAtMs)).toEqual({ kind: "no_match" });
    }
  });

  it("still poisons the tuple against a second distinct origin", () => {
    // The whole reason presence exists: a live run that must not be ANSWERED
    // with must still be VISIBLE, or the other peer's claim gets returned as
    // the origin of this run's request.
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA"); // an ordinary run, selectable on its own
    h.set(1_012);
    h.presenceRun("AcctA", "peerB"); // e.g. a control-lane turn that became a run
    h.set(1_040);
    expect(h.resolve("AcctA", 1_030)).toEqual({ kind: "ambiguous" });
  });

  it("does not poison when it shares the exact origin of an ordinary run", () => {
    // The common case: a peer sends `/stop` during its own turn. Two claims,
    // one exact origin — nothing confusable, so the run stays deliverable.
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_012);
    h.presenceRun("AcctA", "peerA");
    h.set(1_040);
    expect(h.resolve("AcctA", 1_030)).toEqual({ kind: "resolved", peerId: "peerA" });
  });

  it("stops poisoning nothing — its release removes exactly its own claim", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_012);
    const presence = h.presenceRun("AcctA", "peerB");
    h.set(1_040);
    expect(h.resolve("AcctA", 1_030)).toEqual({ kind: "ambiguous" });

    // Poison is sticky for the epoch, so releasing does not restore service …
    presence.release();
    expect(h.resolve("AcctA", 1_030)).toEqual({ kind: "ambiguous" });
    // … but after a rotation the rescan finds no overlap left, which proves the
    // presence claim really was removed rather than lingering.
    h.set(1_050);
    h.registry.rotateEpoch();
    h.set(1_080);
    expect(h.resolve("AcctA", 1_070)).toEqual({ kind: "resolved", peerId: "peerA" });
  });
});

describe("ApprovalOriginLeaseRegistry — request time", () => {
  it("excludes a claim activated at or after the request", () => {
    const h = harness();
    h.set(1_020);
    h.run("AcctA", "peerA");
    h.set(1_040);
    // Strictly before only: same-millisecond equality cannot prove ordering.
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "no_match" });
    expect(h.resolve("AcctA", 1_019)).toEqual({ kind: "no_match" });
    expect(h.resolve("AcctA", 1_021)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("rejects non-finite request times", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_030);
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(h.resolve("AcctA", value)).toEqual({
        kind: "invalid_request_time",
      });
    }
  });

  it("rejects a request stamped in the future", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_030);
    expect(h.resolve("AcctA", 1_031)).toEqual({ kind: "invalid_request_time" });
    expect(h.resolve("AcctA", 1_030)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("rejects a request at or below the epoch barrier", () => {
    const h = harness(1_000);
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_030);
    expect(h.resolve("AcctA", 999)).toEqual({ kind: "invalid_request_time" });
    // Barrier equality is rejected too.
    expect(h.resolve("AcctA", 1_000)).toEqual({ kind: "invalid_request_time" });
  });
});

describe("ApprovalOriginLeaseRegistry — epoch rotation", () => {
  it("fails closed when a rotation redraws the barrier behind the observed clock", () => {
    const h = harness();
    h.set(1_020);
    // The first delivery has no live claim, but advances the registry's clock
    // observation before the wall clock steps backwards.
    expect(h.resolve("AcctA", 1_015)).toEqual({ kind: "no_match" });

    h.set(1_010);
    h.registry.rotateEpoch(); // backwards barrier = 1_010; epoch is untrusted
    const postJump = h.lease("AcctA", "peerA");
    h.set(1_012);
    postJump.activate();
    h.set(1_016);
    // The preserved 1_015 stamp now looks post-barrier and post-activation, but
    // accepting it would hand a pre-jump approval to the new peer.
    expect(h.resolve("AcctA", 1_015)).toEqual({
      kind: "invalid_request_time",
    });
  });

  it("restores trust on the next forward rotation after a backwards baseline", () => {
    const h = harness();
    h.set(1_020);
    expect(h.resolve("AcctA", 1_015)).toEqual({ kind: "no_match" });
    h.set(1_010);
    h.registry.rotateEpoch(); // backwards baseline closes this epoch

    // The backwards finite reading becomes the recovery baseline, so a later
    // forward rotation need not wait for the stale pre-jump value of 1_020.
    h.set(1_011);
    h.registry.rotateEpoch(); // barrier = 1_011; trust restored
    h.set(1_012);
    h.run("AcctA", "peerA");
    h.set(1_016);
    expect(h.resolve("AcctA", 1_015)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("resolves a handle created before a rotation and activated after it (#267)", () => {
    const h = harness();
    h.set(1_010);
    const spanning = h.lease("AcctA", "peerA");
    h.set(1_020);
    h.registry.rotateEpoch(); // barrier = 1_020
    h.set(1_030);
    spanning.activate(); // start time READ HERE — after the barrier
    h.set(1_050);
    // The start time is not inherited from the fenced-off epoch: it is read at
    // activation, so it proves the run began at 1_030, after the barrier. A
    // request the run genuinely created afterwards resolves, which is exactly
    // what the module header promises a retained run may still do.
    expect(h.resolve("AcctA", 1_031)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
    expect(h.resolve("AcctA", 1_050)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("still refuses a request created before the spanning handle activated (#267)", () => {
    const h = harness();
    h.set(1_010);
    const spanning = h.lease("AcctA", "peerA");
    h.set(1_020);
    h.registry.rotateEpoch(); // barrier = 1_020
    h.set(1_030);
    spanning.activate();
    h.set(1_050);
    // Strict ordering is untouched: post-barrier but pre-activation is still
    // unprovable, and same-millisecond equality does not count as ordering.
    expect(h.resolve("AcctA", 1_021)).toEqual({ kind: "no_match" });
    expect(h.resolve("AcctA", 1_030)).toEqual({ kind: "no_match" });
  });

  it("still refuses a pre-barrier request replayed after a rotation", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_020);
    h.registry.rotateEpoch(); // barrier = 1_020
    h.set(1_050);
    // The replay guard is independent of claim activation and #267 does not
    // touch it: a request stamped before the barrier can never be attributed.
    expect(h.resolve("AcctA", 1_015)).toEqual({ kind: "invalid_request_time" });
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "invalid_request_time" });
  });

  it("poisons the tuple when a spanning handle activates over a retained claim", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA"); // survives the restart, keeps its lease
    h.set(1_012);
    const spanning = h.lease("AcctA", "peerB");
    h.set(1_020);
    h.registry.rotateEpoch(); // barrier = 1_020
    h.set(1_030);
    spanning.activate();

    h.set(1_050);
    // Two exact origins are live on one tuple. A post-barrier request could
    // have come from either, so it must not be handed to peerA — and #267 must
    // not weaken that: making the spanning claim PROVABLE makes this MORE
    // clearly ambiguous, never resolvable.
    expect(h.resolve("AcctA", 1_040)).toEqual({ kind: "ambiguous" });
  });

  it("retains an active claim across rotation; its later release spares newer claims", () => {
    const h = harness();
    h.set(1_010);
    const retained = h.run("AcctA", "peerA");
    h.set(1_020);
    h.registry.rotateEpoch(); // barrier = 1_020
    h.set(1_030);
    h.run("AcctA", "peerA"); // a fresh run on the same key, same exact origin
    h.set(1_040);

    // 1_025 is after the retained claim only; 1_035 is after both.
    expect(h.resolve("AcctA", 1_025)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
    retained.release();
    expect(h.resolve("AcctA", 1_025)).toEqual({ kind: "no_match" });
    expect(h.resolve("AcctA", 1_035)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("lets a retained run serve post-barrier requests while rejecting pre-barrier replays", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_020);
    h.registry.rotateEpoch(); // barrier = 1_020
    h.set(1_040);
    expect(h.resolve("AcctA", 1_015)).toEqual({ kind: "invalid_request_time" });
    expect(h.resolve("AcctA", 1_030)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("re-poisons retained overlapping claims immediately on rotation", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_012);
    h.run("AcctA", "peerB");
    h.set(1_020);
    h.registry.rotateEpoch();
    h.set(1_040);
    expect(h.resolve("AcctA", 1_030)).toEqual({ kind: "ambiguous" });
  });

  it("clears a poison whose overlap is gone, but the new barrier still rejects the old request", () => {
    const h = harness();
    h.set(1_010);
    const a = h.run("AcctA", "peerA");
    h.set(1_012);
    const b = h.run("AcctA", "peerB");
    h.set(1_014);
    a.release();
    b.release();
    h.set(1_020);
    h.registry.rotateEpoch(); // barrier = 1_020, poison reset
    h.set(1_030);
    h.run("AcctA", "peerA");
    h.set(1_050);

    // The old (pre-barrier) request is rejected on time, not on poison.
    expect(h.resolve("AcctA", 1_016)).toEqual({ kind: "invalid_request_time" });
    // A genuinely new request on the un-poisoned key resolves again.
    expect(h.resolve("AcctA", 1_040)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });
});

describe("ApprovalOriginLeaseRegistry — sticky poison", () => {
  it("stays poisoned after one side releases, after all release, and for a later run", () => {
    const h = harness();
    h.set(1_010);
    const a = h.run("AcctA", "peerA");
    h.set(1_012);
    const b = h.run("AcctA", "peerB");
    h.set(1_040);
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "ambiguous" });

    b.release();
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "ambiguous" });

    a.release();
    expect(h.resolve("AcctA", 1_020)).toEqual({ kind: "ambiguous" });

    h.set(1_050);
    h.run("AcctA", "peerA"); // a later, unambiguous same-origin run
    h.set(1_070);
    expect(h.resolve("AcctA", 1_060)).toEqual({ kind: "ambiguous" });
  });

  it("escalates to a global epoch poison instead of evicting keys", () => {
    const h = harness(1_000, { maxPoisonedKeys: 2 });
    const keys = ["s-1", "s-2", "s-3"];
    const overlapping: ApprovalOriginLease[] = [];
    let clock = 1_010;
    for (const key of keys) {
      h.set(clock++);
      overlapping.push(h.run("AcctA", "peerA", key));
      h.set(clock++);
      overlapping.push(h.run("AcctA", "peerB", key));
    }
    // A clean, never-overlapped key in the same epoch.
    h.set(clock++);
    h.run("AcctA", "peerC", "s-clean");
    h.set(2_000);

    // The third overlap would exceed the cap, so the epoch fails closed as a
    // whole — the first two keys are NOT evicted to make room. The outcome is
    // reported as `epoch_poisoned`, NOT `ambiguous`: this is a process-wide
    // outage, and an operator must be able to tell it from one bad tuple.
    for (const key of [...keys, "s-clean"]) {
      expect(h.resolve("AcctA", 1_900, key)).toEqual({ kind: "epoch_poisoned" });
    }

    // Only a rotation clears it, and only for keys whose overlap is gone.
    for (const handle of overlapping) handle.release();
    h.set(2_010);
    h.registry.rotateEpoch();
    h.set(2_030);
    expect(h.resolve("AcctA", 2_020, "s-clean")).toEqual({
      kind: "resolved",
      peerId: "peerC",
    });
    expect(h.resolve("AcctA", 2_020, "s-1")).toEqual({ kind: "no_match" });
  });

  it("re-escalates on rotation when the retained overlaps still exceed the cap", () => {
    const h = harness(1_000, { maxPoisonedKeys: 2 });
    let clock = 1_010;
    for (const key of ["s-1", "s-2", "s-3"]) {
      h.set(clock++);
      h.run("AcctA", "peerA", key);
      h.set(clock++);
      h.run("AcctA", "peerB", key);
    }
    h.set(clock++);
    h.run("AcctA", "peerC", "s-clean");

    h.set(2_010);
    h.registry.rotateEpoch(); // nothing was released, so the rescan re-escalates
    h.set(2_030);
    expect(h.resolve("AcctA", 2_020, "s-clean")).toEqual({ kind: "epoch_poisoned" });
  });

  it("reports a single confusable tuple as ambiguous, not as a poisoned epoch", () => {
    // The two must never be conflated: one is a local event, the other is the
    // whole process refusing every fallback.
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_012);
    h.run("AcctA", "peerB");
    h.set(1_040);
    expect(h.resolve("AcctA", 1_030)).toEqual({ kind: "ambiguous" });
  });
});

describe("ApprovalOriginLeaseRegistry — clock anomalies", () => {
  it("closes the epoch on a backwards clock and recovers only on rotation", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_030);
    expect(h.resolve("AcctA", 1_020)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });

    h.set(1_005); // wall clock moved backwards inside the epoch
    expect(h.resolve("AcctA", 1_002)).toEqual({ kind: "invalid_request_time" });
    // Untrusted is sticky for the epoch, even once readings look sane again.
    h.set(1_050);
    expect(h.resolve("AcctA", 1_040)).toEqual({ kind: "invalid_request_time" });

    h.registry.rotateEpoch(); // barrier = 1_050, trust restored
    h.set(1_060);
    // Service is restored: this is a real answer about the retained claim, not
    // a clock rejection.
    expect(h.resolve("AcctA", 1_055)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("never resolves a run whose activation hit a non-finite clock", () => {
    const h = harness();
    h.set(Number.NaN);
    h.run("AcctA", "peerA"); // live, but its start time is unprovable
    expect(h.resolve("AcctA", 1_010)).toEqual({ kind: "invalid_request_time" });

    h.set(1_020);
    h.registry.rotateEpoch(); // barrier = 1_020, trust restored
    h.set(1_060);
    // The registry answers again, and the answer is never that peer.
    for (const requestCreatedAtMs of [1_021, 1_040, 1_060]) {
      expect(h.resolve("AcctA", requestCreatedAtMs)).toEqual({
        kind: "no_match",
      });
    }
  });

  it("poisons the tuple when a clock-anomalous activation overlaps a retained claim", () => {
    const h = harness();
    h.set(1_010);
    h.run("AcctA", "peerA");
    h.set(1_012);
    const anomalous = h.lease("AcctA", "peerB");
    h.set(1_005); // wall clock moved backwards
    anomalous.activate(); // live run, unprovable start time, epoch now untrusted

    h.set(1_060);
    h.registry.rotateEpoch(); // barrier = 1_060, trust restored, poison reset
    h.set(1_090);
    // The retained-claim rescan sees both live origins and re-poisons.
    expect(h.resolve("AcctA", 1_080)).toEqual({ kind: "ambiguous" });
  });

  it("keeps an unprovable claim unselectable, and releases exactly it", () => {
    const h = harness();
    h.set(Number.NaN);
    const unprovable = h.run("AcctA", "peerB");
    h.set(1_020);
    h.registry.rotateEpoch(); // barrier = 1_020, trust restored
    h.set(1_100);
    for (const requestCreatedAtMs of [1_021, 1_060, 1_100]) {
      expect(h.resolve("AcctA", requestCreatedAtMs)).toEqual({
        kind: "no_match",
      });
    }

    // Unselectable, but present: a second exact origin on the tuple poisons it.
    const other = h.run("AcctA", "peerC");
    expect(h.resolve("AcctA", 1_050)).toEqual({ kind: "ambiguous" });

    unprovable.release();
    other.release();
    h.set(1_200);
    h.registry.rotateEpoch(); // barrier = 1_200, poison reset
    h.set(1_210);
    h.run("AcctA", "peerA");
    h.set(1_230);
    // Had either claim outlived its release, this activation would have
    // poisoned the tuple instead.
    expect(h.resolve("AcctA", 1_220)).toEqual({
      kind: "resolved",
      peerId: "peerA",
    });
  });

  it("stays closed when construction itself reads a non-finite clock", () => {
    let nowMs: number = Number.NaN;
    const registry = new ApprovalOriginLeaseRegistry({ now: () => nowMs });
    nowMs = 1_030;
    expect(
      registry.resolve({
        rawAccountId: "AcctA",
        sessionKey: SESSION,
        requestCreatedAtMs: 1_020,
      }),
    ).toEqual({ kind: "invalid_request_time" });
  });
});

describe("getApprovalOriginRegistry", () => {
  const slots = globalThis as unknown as Record<symbol, unknown>;
  let saved: unknown;

  beforeEach(() => {
    saved = slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    delete slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    else slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = saved;
  });

  it("hands every module generation the same registry object", () => {
    const first = getApprovalOriginRegistry();
    const second = getApprovalOriginRegistry();
    expect(second).toBe(first);
    expect(first.contractVersion).toBe(APPROVAL_ORIGIN_REGISTRY_CONTRACT_VERSION);
  });

  it("shares claims across generations that never saw each other's module", () => {
    // Stand in for "generation 1 installed the registry": plant one with an
    // injected clock, then let two later getter calls observe it.
    let nowMs: number = 1_000;
    slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = new ApprovalOriginLeaseRegistry(
      { now: () => nowMs },
    );

    const inboundGeneration = getApprovalOriginRegistry();
    nowMs = 1_010;
    inboundGeneration
      .createLease({ rawAccountId: "AcctA", sessionKey: SESSION, peerId: "peerA" })
      .activate();

    const approvalsGeneration = getApprovalOriginRegistry();
    expect(approvalsGeneration).toBe(inboundGeneration);
    nowMs = 1_030;
    expect(
      approvalsGeneration.resolve({
        rawAccountId: "AcctA",
        sessionKey: SESSION,
        requestCreatedAtMs: 1_020,
      }),
    ).toEqual({ kind: "resolved", peerId: "peerA" });
  });

  it.each([
    ["a wrong contract version", { contractVersion: 2, createLease() {}, resolve() {}, rotateEpoch() {} }],
    ["a missing createLease", { contractVersion: 1, resolve() {}, rotateEpoch() {} }],
    ["a non-callable resolve", { contractVersion: 1, createLease() {}, resolve: 1, rotateEpoch() {} }],
    ["a missing rotateEpoch", { contractVersion: 1, createLease() {}, resolve() {} }],
    ["a non-object", "not-a-registry"],
    ["null", null],
  ])("fails closed on %s rather than replacing it", (_label, planted) => {
    slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = planted;
    expect(() => getApprovalOriginRegistry()).toThrow(
      /incompatible approval-origin registry/,
    );
    // The hostile/stale value is left exactly as found — no split state.
    expect(slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY]).toBe(planted);
  });
});
