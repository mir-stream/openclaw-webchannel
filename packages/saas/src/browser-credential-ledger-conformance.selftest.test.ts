import { describe, expect, it } from "vitest";
import {
  browserCredentialLedgerConformanceCases,
  runBrowserCredentialLedgerConformance,
  CONFORMANCE_RETENTION_SEC,
  type BrowserCredentialLedgerConformanceCase,
} from "./browser-credential-ledger-conformance.js";
import {
  BrowserCredentialCollisionError,
  MemoryBrowserCredentialLedger,
  type BrowserCredentialIssuance,
  type BrowserCredentialLedger,
  type BrowserCredentialRecord,
} from "./browser-credential-ledger.js";

type Broken =
  | "overwrite_on_duplicate"
  | "aliased_reads"
  | "sweep_immortal"
  | "retention_ignored"
  | "page_limit_ignored"
  | "cursor_unbound"
  | "revoke_scope_leak";

function findCase(prefix: string): BrowserCredentialLedgerConformanceCase {
  const found = browserCredentialLedgerConformanceCases.find((candidate) => candidate.name.startsWith(prefix));
  if (!found) throw new Error(`missing exported conformance ${prefix}`);
  return found;
}

/**
 * Each mutant models a plausible ADAPTER defect, not a typo: an UPSERT that
 * reports a collision it already lost, a sweep that treats "no expiry" as "no
 * reason to keep", a driver-side limit, an unvalidated cursor, a scope
 * predicate missing its peer term, and a hard-coded retention.
 */
function breakLedger(inner: MemoryBrowserCredentialLedger, defect: Broken): BrowserCredentialLedger {
  const shadow = new Map<string, BrowserCredentialRecord>();
  const known = new Map<string, BrowserCredentialRecord>();
  const hidden = new Set<string>();
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;

      if (defect === "overwrite_on_duplicate") {
        // An UPSERT that writes first and only then notices the row existed:
        // the collision error is raised honestly, but the original is already gone.
        if (property === "recordIssuance") return async (issuance: BrowserCredentialIssuance) => {
          if (await target.get(issuance.userPubkey) === null) return target.recordIssuance(issuance);
          shadow.set(issuance.userPubkey, { ...issuance, status: "active", revokedAtSec: null });
          throw new BrowserCredentialCollisionError(issuance.userPubkey);
        };
        if (property === "get") return async (userPubkey: string) => shadow.get(userPubkey) ?? target.get(userPubkey);
      }

      // An adapter with an in-process cache that hands out the cached object.
      if (defect === "aliased_reads") {
        if (property === "recordIssuance") return async (issuance: BrowserCredentialIssuance) => {
          const outcome = await target.recordIssuance(issuance);
          if (outcome.kind !== "recorded") return outcome;
          known.set(issuance.userPubkey, outcome.record);
          return { kind: "recorded", record: outcome.record };
        };
        if (property === "get") return async (userPubkey: string) => known.get(userPubkey) ?? target.get(userPubkey);
      }

      if (defect === "sweep_immortal") {
        if (property === "recordIssuance") return async (issuance: BrowserCredentialIssuance) => {
          const outcome = await target.recordIssuance(issuance);
          if (outcome.kind === "recorded") known.set(issuance.userPubkey, outcome.record);
          return outcome;
        };
        // "It has no expiry, so nothing is ever going to age it out" — the exact
        // reasoning that loses the only credential class that matters.
        if (property === "sweep") return async () => {
          let extra = 0;
          for (const [userPubkey, record] of known) {
            if (hidden.has(userPubkey) || record.expiresAtSec !== null) continue;
            if (await target.get(userPubkey) === null) continue;
            hidden.add(userPubkey); extra++;
          }
          return (await target.sweep()) + extra;
        };
        if (property === "get") return async (userPubkey: string) => hidden.has(userPubkey) ? null : target.get(userPubkey);
        if (property === "list") return async (...args: Parameters<BrowserCredentialLedger["list"]>) => {
          const page = await target.list(...args);
          return { records: page.records.filter((record) => !hidden.has(record.userPubkey)), cursor: page.cursor };
        };
      }

      if (defect === "page_limit_ignored" && property === "list") return async (...args: Parameters<BrowserCredentialLedger["list"]>) =>
        target.list(args[0], { ...args[1], limit: 1_000, cursor: null });

      // Resumes at the cursor's keyset position without checking the cursor
      // came from THIS scope+status — the realistic version of the defect, and
      // the one that still pages correctly for honest callers.
      if (defect === "cursor_unbound" && property === "list") return async (...args: Parameters<BrowserCredentialLedger["list"]>) => {
        const [scope, query = {}] = args;
        if (!query.cursor) return target.list(scope, query);
        try {
          const probe = await target.list(scope, { ...query, cursor: null, limit: 1 });
          if (probe.cursor === null) return target.list(scope, query);
          const template = JSON.parse(Buffer.from(probe.cursor, "base64url").toString());
          const incoming = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
          const forged = Buffer.from(JSON.stringify({ ...template, i: incoming.i, u: incoming.u })).toString("base64url");
          return target.list(scope, { ...query, cursor: forged });
        } catch { return target.list(scope, query); }
      };

      if (defect === "revoke_scope_leak" && property === "markRevoked") return async (...args: Parameters<BrowserCredentialLedger["markRevoked"]>) => {
        const [scope, revokedAtSec] = args;
        return target.markRevoked(scope.kind === "peer" ? { kind: "account", natsAccountPublicKey: scope.natsAccountPublicKey } : scope, revokedAtSec);
      };

      return value.bind(target);
    },
  });
}

function controlled(defect?: Broken, retentionSec: number = CONFORMANCE_RETENTION_SEC) {
  let nowSec = 1_700_000_000;
  // The retention defect deliberately discards the harness-supplied horizon.
  const inner = new MemoryBrowserCredentialLedger({
    autoSweep: false,
    retentionSec: defect === "retention_ignored" ? 5_000 : retentionSec,
    clockSec: () => nowSec,
  });
  return {
    ledger: defect ? breakLedger(inner, defect) : inner,
    close: async () => inner.close(),
    clock: { nowSec: () => nowSec, advance: async (sec: number) => { nowSec += sec; } },
  };
}

describe("BrowserCredentialLedger conformance harness self-tests", () => {
  it("accepts the honest memory implementation across the full suite", async () => {
    const report = await runBrowserCredentialLedgerConformance({ create: async (config) => controlled(undefined, config.retentionSec) });
    expect(report.skipped).toEqual([]);
    expect(report.passed).toHaveLength(browserCredentialLedgerConformanceCases.length);
  });

  // Each mutant must die on the EXACT assertion built to catch its defect — a
  // generic "some conformance error" match would let fixture drift (the mutant
  // failing earlier for an unrelated reason) masquerade as mutation coverage.
  for (const [prefix, defect, killedBy] of [
    ["1:", "overwrite_on_duplicate", "duplicate issuance overwrote the original record"],
    ["1:", "aliased_reads", "a returned record is aliased to the ledger's own state"],
    ["4:", "page_limit_ignored", "page exceeded the requested limit"],
    ["4:", "cursor_unbound", "a cursor from a different scope was accepted"],
    ["5:", "revoke_scope_leak", "peer revocation did not mark exactly its scope"],
    ["6:", "retention_ignored", "configured retention was ignored one second past the boundary"],
    ["7:", "sweep_immortal", "sweep removed an active non-expiring credential"],
  ] as const) {
    it(`rejects the deliberately broken ${defect} adapter on its targeted assertion`, async () => {
      await expect(findCase(prefix).run(controlled(defect))).rejects.toThrow(`BrowserCredentialLedger conformance: ${killedBy}`);
    });
  }

  it("fails a directly selected clock case loudly and visibly skips clock cases in the convenience runner", async () => {
    const withoutClock = () => {
      const ledger = new MemoryBrowserCredentialLedger({ autoSweep: false, retentionSec: CONFORMANCE_RETENTION_SEC, clockSec: () => 1_700_000_000 });
      return { ledger, close: async () => ledger.close() };
    };
    await expect(findCase("6:").run(withoutClock())).rejects.toThrow("case 6 requires the optional controlled clock capability");
    const skips: string[] = [];
    const report = await runBrowserCredentialLedgerConformance({ create: async () => withoutClock(), reportSkip: (message) => skips.push(message) });
    expect(report.skipped).toHaveLength(browserCredentialLedgerConformanceCases.filter((candidate) => candidate.suite === "clock").length);
    expect(skips).toHaveLength(report.skipped.length);
    expect(skips.every((message) => message.includes("SKIP") && message.includes("controlled clock"))).toBe(true);
  });
});
