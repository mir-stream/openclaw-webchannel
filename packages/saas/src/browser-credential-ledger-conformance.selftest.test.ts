import { describe, expect, it } from "vitest";
import {
  browserCredentialLedgerConformanceCases,
  runBrowserCredentialLedgerConformance,
  CONFORMANCE_RETENTION_SEC,
  type BrowserCredentialLedgerConformanceCase,
} from "./browser-credential-ledger-conformance.js";
import {
  BrowserCredentialCollisionError,
  BrowserCredentialCursorError,
  MemoryBrowserCredentialLedger,
  type BrowserCredentialIssuance,
  type BrowserCredentialLedger,
  type BrowserCredentialRecord,
  type BrowserCredentialScope,
} from "./browser-credential-ledger.js";

type Broken =
  | "overwrite_on_duplicate"
  | "aliased_reads"
  | "leaky_list_projection"
  | "sweep_immortal"
  | "retention_ignored"
  | "page_limit_ignored"
  | "cursor_unbound"
  | "offset_pagination"
  | "high_water_offset_pagination"
  | "revoke_scope_leak"
  | "revoke_each_row_transaction"
  | "floor_fractional_expiry"
  | "unknown_scope_as_account"
  | "nowsec_milliseconds"
  | "stale_public_now";

type BrokenState = { failBeforeCommit: boolean };

/** The real memory transaction with a failure injected at its internal staging seam. */
class ControlledMemoryBrowserCredentialLedger extends MemoryBrowserCredentialLedger {
  private failBeforeCommit = false;

  failNextMarkRevokedBeforeCommit(): void {
    this.failBeforeCommit = true;
  }

  protected override beforeMarkRevokedCommitForConformance(): void {
    if (!this.failBeforeCommit) return;
    this.failBeforeCommit = false;
    throw new Error("webchannel conformance: injected markRevoked transaction failure");
  }
}

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
function breakLedger(inner: ControlledMemoryBrowserCredentialLedger, defect: Broken, state: BrokenState): BrowserCredentialLedger {
  const shadow = new Map<string, BrowserCredentialRecord>();
  const known = new Map<string, BrowserCredentialRecord>();
  const leakyRows = new Map<string, Record<string, unknown>>();
  const hidden = new Set<string>();
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;

      // A fixture-controlled backing clock can conceal a broken public SPI if
      // conformance reads only the fixture. These two mutants keep the backing
      // clock honest while corrupting only the adapter's public answer.
      if (defect === "nowsec_milliseconds" && property === "nowSec") {
        return async () => 1_700_000_000_000;
      }
      if (defect === "stale_public_now" && property === "nowSec") {
        return async () => 1_700_000_000;
      }

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

      // A durable adapter that persists the structurally wider input, projects
      // INSERT/get through a clean column list, but later returns SELECT *.
      if (defect === "leaky_list_projection") {
        if (property === "recordIssuance") return async (issuance: BrowserCredentialIssuance) => {
          const outcome = await target.recordIssuance(issuance);
          if (outcome.kind === "recorded") {
            leakyRows.set(issuance.userPubkey, {
              ...outcome.record,
              ...(issuance as unknown as Record<string, unknown>),
            });
          }
          return outcome;
        };
        if (property === "list") return async (...args: Parameters<BrowserCredentialLedger["list"]>) => {
          const page = await target.list(...args);
          return { ...page, records: page.records.map((record) => leakyRows.get(record.userPubkey) ?? record) };
        };
      }

      // A driver that normalizes expiry into an integer column instead of
      // rejecting the caller's malformed seconds timestamp.
      if (defect === "floor_fractional_expiry" && property === "recordIssuance") {
        return async (issuance: BrowserCredentialIssuance) => target.recordIssuance({
          ...issuance,
          expiresAtSec: issuance.expiresAtSec === null ? null : Math.floor(issuance.expiresAtSec),
        });
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

      // Both adapters use a correctly bound opaque OFFSET cursor. The second
      // also freezes the original newest key, so it survives insertions ahead
      // of page 1 but still shifts when a returned row leaves a status filter.
      if ((defect === "offset_pagination" || defect === "high_water_offset_pagination") && property === "list") return async (...args: Parameters<BrowserCredentialLedger["list"]>) => {
        const [scope, query = {}] = args;
        // Delegate ordinary scope/limit validation to the real adapter.
        await target.list(scope, { ...query, cursor: null });
        const key = JSON.stringify(scope);
        const status = query.status ?? null;
        let offset = 0;
        let highWater: { issuedAtSec: number; userPubkey: string } | null = null;
        if (query.cursor != null) {
          let cursor: { k?: unknown; s?: unknown; o?: unknown; i?: unknown; u?: unknown };
          try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as typeof cursor; }
          catch { throw new BrowserCredentialCursorError("webchannel: browser credential cursor is not a cursor this ledger issued"); }
          if (cursor.k !== key || (cursor.s ?? null) !== status || !Number.isInteger(cursor.o) || (cursor.o as number) < 1) {
            throw new BrowserCredentialCursorError();
          }
          offset = cursor.o as number;
          if (defect === "high_water_offset_pagination") {
            if (!Number.isInteger(cursor.i) || typeof cursor.u !== "string") throw new BrowserCredentialCursorError();
            highWater = { issuedAtSec: cursor.i as number, userPubkey: cursor.u };
          }
        }
        const all: BrowserCredentialRecord[] = [];
        let targetCursor: string | null = null;
        do {
          const page = await target.list(scope, { status: query.status, limit: 1_000, cursor: targetCursor });
          all.push(...page.records); targetCursor = page.cursor;
        } while (targetCursor !== null);
        if (defect === "high_water_offset_pagination" && query.cursor == null) {
          const first = all[0];
          highWater = first ? { issuedAtSec: first.issuedAtSec, userPubkey: first.userPubkey } : null;
        }
        const visible = highWater === null ? all : all.filter((record) =>
          record.issuedAtSec < highWater.issuedAtSec
          || (record.issuedAtSec === highWater.issuedAtSec && record.userPubkey >= highWater.userPubkey));
        const limit = query.limit ?? 200;
        const records = visible.slice(offset, offset + limit);
        const nextOffset = offset + records.length;
        const cursor = nextOffset < visible.length
          ? Buffer.from(JSON.stringify({ k: key, s: status, o: nextOffset,
            ...(highWater ? { i: highWater.issuedAtSec, u: highWater.userPubkey } : {}) })).toString("base64url")
          : null;
        return { records, cursor };
      };

      if (defect === "revoke_scope_leak" && property === "markRevoked") return async (...args: Parameters<BrowserCredentialLedger["markRevoked"]>) => {
        const [scope, revokedAtSec] = args;
        return target.markRevoked(scope.kind === "peer" ? { kind: "account", natsAccountPublicKey: scope.natsAccountPublicKey } : scope, revokedAtSec);
      };

      // Runtime union handling that defaults any unknown discriminator to the
      // broadest branch, reproducing the account-wide typo failure.
      if (defect === "unknown_scope_as_account" && (property === "list" || property === "markRevoked")) {
        return async (scope: BrowserCredentialScope, ...rest: unknown[]) => {
          const runtime = scope as unknown as { kind?: unknown; natsAccountPublicKey?: unknown };
          const knownKind = runtime.kind === "credential" || runtime.kind === "peer" || runtime.kind === "account";
          const normalized = knownKind ? scope : {
            kind: "account",
            natsAccountPublicKey: runtime.natsAccountPublicKey,
          } as BrowserCredentialScope;
          if (property === "list") {
            return target.list(normalized, ...(rest as [Parameters<BrowserCredentialLedger["list"]>[1]]));
          }
          return target.markRevoked(normalized, ...(rest as [number]));
        };
      }

      // Each credential is committed in its own transaction. Serial tests see
      // the right final result; an injected failure after one commit exposes
      // the partial scope that the SPI forbids.
      if (defect === "revoke_each_row_transaction" && property === "markRevoked") {
        return async (scope: BrowserCredentialScope, revokedAtSec: number) => {
          const matched: BrowserCredentialRecord[] = [];
          let cursor: string | null = null;
          do {
            const page = await target.list(scope, { limit: 100, cursor });
            matched.push(...page.records); cursor = page.cursor;
          } while (cursor !== null);
          let marked = 0; let alreadyRevoked = 0;
          for (const record of matched) {
            if (record.status === "revoked") { alreadyRevoked++; continue; }
            await target.markRevoked({ kind: "credential", userPubkey: record.userPubkey }, revokedAtSec);
            marked++;
            if (state.failBeforeCommit) {
              state.failBeforeCommit = false;
              throw new Error("webchannel conformance mutant: row transaction failed");
            }
          }
          return { marked, alreadyRevoked };
        };
      }

      return value.bind(target);
    },
  });
}

function controlled(defect?: Broken, retentionSec: number = CONFORMANCE_RETENTION_SEC) {
  let nowSec = 1_700_000_000;
  const state: BrokenState = { failBeforeCommit: false };
  // The retention defect deliberately discards the harness-supplied horizon.
  const inner = new ControlledMemoryBrowserCredentialLedger({
    autoSweep: false,
    retentionSec: defect === "retention_ignored" ? 5_000 : retentionSec,
    clockSec: () => nowSec,
  });
  return {
    ledger: defect ? breakLedger(inner, defect, state) : inner,
    close: async () => inner.close(),
    clock: { nowSec: () => nowSec, advance: async (sec: number) => { nowSec += sec; } },
    atomicity: {
      failNextMarkRevokedBeforeCommit: async () => {
        if (defect === "revoke_each_row_transaction") state.failBeforeCommit = true;
        else inner.failNextMarkRevokedBeforeCommit();
      },
    },
  };
}

describe("BrowserCredentialLedger conformance harness self-tests", () => {
  it("accepts the honest memory implementation across the full suite", async () => {
    const report = await runBrowserCredentialLedgerConformance({ create: async (config) => controlled(undefined, config.retentionSec) });
    expect(report.skipped).toEqual([]);
    expect(report.passed).toHaveLength(browserCredentialLedgerConformanceCases.length);
  });

  it("Memory rejects a millisecond clock before nowSec exposure or destructive sweep", async () => {
    const seconds = 1_700_000_000;
    let clock = seconds + 0.75;
    const ledger = new MemoryBrowserCredentialLedger({ autoSweep: false, retentionSec: 0, clockSec: () => clock });
    const userPubkey = `U${"8".repeat(55)}`;

    // Fractional seconds remain a supported clock source and are floored once.
    expect(await ledger.nowSec()).toBe(seconds);
    await ledger.recordIssuance({
      tenant: "tenant",
      accountContext: "context",
      natsAccountPublicKey: "A".repeat(56),
      peerId: "peer",
      userPubkey,
      issuedAtSec: seconds,
      expiresAtSec: seconds + 60,
    });

    // Date.now()-shaped milliseconds would previously classify this live row
    // as ancient and delete it. Both public time and sweep must reject first.
    clock = 1_700_000_000_000;
    await expect(ledger.nowSec()).rejects.toMatchObject({ name: "BrowserCredentialLedgerInputError" });
    await expect(ledger.sweep()).rejects.toMatchObject({ name: "BrowserCredentialLedgerInputError" });
    expect(await ledger.get(userPubkey)).toMatchObject({ status: "active", expiresAtSec: seconds + 60 });
  });

  // Each mutant must die on the EXACT assertion built to catch its defect — a
  // generic "some conformance error" match would let fixture drift (the mutant
  // failing earlier for an unrelated reason) masquerade as mutation coverage.
  for (const [prefix, defect, killedBy] of [
    ["1:", "overwrite_on_duplicate", "duplicate issuance overwrote the original record"],
    ["1:", "aliased_reads", "a returned record is aliased to the ledger's own state"],
    ["1:", "leaky_list_projection", "list did not project the exact secret-free contract page"],
    ["1:", "nowsec_milliseconds", "ledger.nowSec is not a positive integer in unix SECONDS below the millisecond tripwire"],
    ["2:", "floor_fractional_expiry", "fractional expiresAtSec was accepted"],
    ["3:", "unknown_scope_as_account", "an unknown scope kind was accepted by list as an account-wide query"],
    ["4:", "page_limit_ignored", "page exceeded the requested limit"],
    ["4:", "cursor_unbound", "a cursor from a different scope was accepted"],
    ["4:", "offset_pagination", "cursor resumed by page offset after a newer issuance (duplicated, skipped, or admitted a before-anchor record)"],
    ["4:", "high_water_offset_pagination", "status-filtered cursor resumed by offset after a returned row was revoked (skipped or duplicated an unaffected after-anchor row)"],
    ["5:", "revoke_scope_leak", "peer revocation did not mark exactly its scope"],
    ["5:", "revoke_each_row_transaction", "markRevoked left a partially revoked scope after an injected transactional failure"],
    ["6:", "retention_ignored", "configured retention was ignored one second past the boundary"],
    ["6:", "stale_public_now", "controlled clock does not agree exactly with ledger.nowSec"],
  ] as const) {
    it(`rejects the deliberately broken ${defect} adapter on its targeted assertion`, async () => {
      await expect(findCase(prefix).run(controlled(defect))).rejects.toThrow(`BrowserCredentialLedger conformance: ${killedBy}`);
    });
  }

  it("rejects sweep_immortal in core case 7 without a controlled clock fixture", async () => {
    const instance = controlled("sweep_immortal");
    const withoutClock = { ledger: instance.ledger, close: instance.close, atomicity: instance.atomicity };
    try {
      await expect(findCase("7:").run(withoutClock)).rejects.toThrow(
        "BrowserCredentialLedger conformance: sweep removed an active non-expiring credential",
      );
    } finally { await instance.close(); }
  });

  it("fails a directly selected clock case loudly and visibly skips clock cases in the convenience runner", async () => {
    const withoutClock = () => {
      const ledger = new ControlledMemoryBrowserCredentialLedger({ autoSweep: false, retentionSec: CONFORMANCE_RETENTION_SEC, clockSec: () => 1_700_000_000 });
      return {
        ledger,
        close: async () => ledger.close(),
        atomicity: { failNextMarkRevokedBeforeCommit: async () => ledger.failNextMarkRevokedBeforeCommit() },
      };
    };
    await expect(findCase("6:").run(withoutClock())).rejects.toThrow("case 6 requires the optional controlled clock capability");
    const skips: string[] = [];
    const report = await runBrowserCredentialLedgerConformance({ create: async () => withoutClock(), reportSkip: (message) => skips.push(message) });
    expect(report.skipped).toHaveLength(browserCredentialLedgerConformanceCases.filter((candidate) => candidate.suite === "clock").length);
    expect(report.passed).toContain(findCase("7:").name);
    expect(skips).toHaveLength(report.skipped.length);
    expect(skips.every((message) => message.includes("SKIP") && message.includes("controlled clock"))).toBe(true);
  });
});
