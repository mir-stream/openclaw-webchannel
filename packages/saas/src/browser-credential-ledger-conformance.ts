/**
 * Conformance suite for {@link BrowserCredentialLedger}.
 *
 * This is the primary deliverable of the ledger SPI, not a test of the bundled
 * memory implementation. We cannot write a deployer's Postgres/Redis/DynamoDB
 * adapter, and the ledger's failure mode is silent — a subtly wrong adapter
 * looks healthy right up to the incident where it cannot say which keys to cut.
 * The only way to hold an implementation we did not write to the meaning we
 * intend is to hand the deployer an executable statement of it.
 *
 * Nothing here uses a secret. The fixtures deliberately pass extra
 * `userJwt`/`userSeedRaw` properties in one case for the sole purpose of proving
 * they never reach a stored record.
 */

import {
  MAX_TIMESTAMP_SEC,
  type BrowserCredentialIssuance,
  type BrowserCredentialLedger,
  type BrowserCredentialRecord,
  type BrowserCredentialScope,
} from "./browser-credential-ledger.js";

type Method = keyof BrowserCredentialLedger;
export type BrowserCredentialLedgerInterposeHooks =
  Partial<Record<Method, { before?: () => void | Promise<void>; after?: (result: unknown) => void | Promise<void> }>>;

export type BrowserCredentialLedgerFaultControl = { remaining(): number; clear(): void };

/** Harness-owned decorator: adapters need no test-only failpoint capability. */
export function interposeBrowserCredentialLedger(
  ledger: BrowserCredentialLedger,
  hooks: BrowserCredentialLedgerInterposeHooks = {},
): BrowserCredentialLedger & { throwAfterRecord(options?: { times?: number }): BrowserCredentialLedgerFaultControl } {
  let throws = 0;
  const control = {
    throwAfterRecord({ times = 1 }: { times?: number } = {}) { throws = times; return { remaining: () => throws, clear: () => { throws = 0; } }; },
  };
  return new Proxy(ledger, {
    get(target, property, receiver) {
      if (property === "throwAfterRecord") return control.throwAfterRecord;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const hook = hooks[property as Method]; await hook?.before?.();
        const result = await value.apply(target, args); await hook?.after?.(result);
        if (property === "recordIssuance" && throws > 0 && (result as { kind?: string }).kind === "recorded") {
          throws--; throw new Error("webchannel conformance: recorded response lost");
        }
        return result;
      };
    },
  }) as BrowserCredentialLedger & typeof control;
}

export type BrowserCredentialLedgerConformanceOptions = {
  create(config: { retentionSec: number; autoSweep: false }): Promise<{
    ledger: BrowserCredentialLedger;
    close(): Promise<void>;
    clock?: { nowSec(): number; advance(sec: number): Promise<void> };
  }>;
  /** Receives the same visible message emitted by the default console reporter. */
  reportSkip?(message: string): void;
};
type Instance = Awaited<ReturnType<BrowserCredentialLedgerConformanceOptions["create"]>>;
type Clock = NonNullable<Instance["clock"]>;
export type BrowserCredentialLedgerConformanceCase = {
  name: string;
  suite: "core" | "clock" | "fault";
  run(instance: Instance): Promise<void>;
};

/** The retention horizon the harness configures; case 7 is written against it. */
export const CONFORMANCE_RETENTION_SEC = 50;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`BrowserCredentialLedger conformance: ${message}`);
}
function requireClock(instance: Instance, caseName: string): Clock {
  invariant(instance.clock, `${caseName} requires the optional controlled clock capability`);
  return instance.clock;
}
const fixtureNow = async (instance: Instance): Promise<number> => instance.clock?.nowSec() ?? instance.ledger.nowSec();
// Property order is NOT part of the contract — an adapter that builds records
// from a SELECT has whatever order its driver hands back — so comparisons
// canonicalize object keys first. Array order is preserved: the list order IS
// part of the contract.
const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

const ACCOUNT = "A".repeat(56);
const OTHER_ACCOUNT = "B".repeat(56);
const RECORD_FIELDS = [
  "tenant", "accountContext", "natsAccountPublicKey", "peerId",
  "userPubkey", "issuedAtSec", "expiresAtSec", "status", "revokedAtSec",
] as const;

const issuance = (over: Partial<BrowserCredentialIssuance> & { userPubkey: string; issuedAtSec: number }): BrowserCredentialIssuance => ({
  tenant: "tenant",
  accountContext: "account-context",
  natsAccountPublicKey: ACCOUNT,
  peerId: "peer",
  expiresAtSec: null,
  ...over,
});

async function expectNamedError(action: () => Promise<unknown>, name: string, message: string): Promise<void> {
  try { await action(); }
  catch (error) { invariant(error instanceof Error && error.name === name, `${message} (threw ${error instanceof Error ? error.name : typeof error} instead of ${name})`); return; }
  throw new Error(`BrowserCredentialLedger conformance: ${message}`);
}

/** Drain a scope one page at a time, asserting the page invariants as it goes. */
async function drain(
  ledger: BrowserCredentialLedger,
  scope: BrowserCredentialScope,
  query: { status?: "active" | "revoked"; limit: number },
): Promise<BrowserCredentialRecord[]> {
  const seen: BrowserCredentialRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result: Awaited<ReturnType<BrowserCredentialLedger["list"]>> = await ledger.list(scope, { ...query, cursor });
    invariant(result.records.length <= query.limit, "page exceeded the requested limit");
    invariant(result.cursor === null || result.records.length > 0, "non-null cursor returned with an empty page (a draining loop cannot terminate)");
    seen.push(...result.records);
    cursor = result.cursor;
    if (cursor === null) return seen;
  }
  throw new Error("BrowserCredentialLedger conformance: pagination did not terminate within 100 pages");
}

/**
 * Individually named cases are public so an adapter can expose them through its
 * native test runner as parameterized tests. The convenience runner below still
 * gives every case a fresh instance, which is the harness's reset contract.
 */
export const browserCredentialLedgerConformanceCases: readonly BrowserCredentialLedgerConformanceCase[] = [
  { name: "1: issuance is insert-only, exact, and carries no caller-supplied extras", suite: "core", async run(instance) {
    const { ledger } = instance;
    const now = await fixtureNow(instance);
    invariant(Number.isInteger(now) && now > 0 && now < MAX_TIMESTAMP_SEC, "nowSec is not a positive integer in unix SECONDS below the millisecond tripwire");

    const input = issuance({ userPubkey: `U${"1".repeat(55)}`, issuedAtSec: now, expiresAtSec: now + 86_400 });
    // A caller handing over a wider object must not be able to widen the record.
    const withSecrets = { ...input, userJwt: "header.payload.signature", userSeedRaw: "RAW-SEED", userSeed: "SUSEED" } as BrowserCredentialIssuance;
    const outcome = await ledger.recordIssuance(withSecrets);
    invariant(outcome.kind === "recorded", "a ledger with no fence store answered something other than recorded");
    invariant(same(outcome.record, { ...input, status: "active", revokedAtSec: null }), "recorded record is not exactly the issuance plus an active status");
    invariant(same(Object.keys(outcome.record).sort(), [...RECORD_FIELDS].sort()), "recorded record does not carry exactly the nine contract fields");
    const serialized = JSON.stringify(outcome.record);
    for (const secret of ["header.payload.signature", "RAW-SEED", "SUSEED", "userJwt", "userSeed"]) {
      invariant(!serialized.includes(secret), `recorded record leaked ${secret}`);
    }
    invariant(same(await ledger.get(input.userPubkey), outcome.record), "get disagrees with the recorded record");
    invariant(await ledger.get(`U${"9".repeat(55)}`) === null, "unknown userPubkey did not read back null");

    // `readonly` is a compile-time promise only. A record handed back by
    // reference lets a JS consumer rewrite the ledger's own answer to "what do
    // we cut?" — an adapter with an in-process cache has the same hazard.
    const returned = await ledger.get(input.userPubkey) as unknown as Record<string, unknown>;
    returned.status = "revoked"; returned.userPubkey = "tampered"; returned.expiresAtSec = null;
    const reread = await ledger.get(input.userPubkey);
    invariant(reread?.status === "active" && reread.userPubkey === input.userPubkey && reread.expiresAtSec === input.expiresAtSec,
      "a returned record is aliased to the ledger's own state");

    const before = await ledger.get(input.userPubkey);
    await expectNamedError(() => ledger.recordIssuance({ ...input, peerId: "other-peer", expiresAtSec: null }),
      "BrowserCredentialCollisionError", "duplicate userPubkey was accepted instead of colliding");
    invariant(same(await ledger.get(input.userPubkey), before), "duplicate issuance overwrote the original record");
  } },

  { name: "2: malformed issuance is refused, millisecond timestamps loudest", suite: "core", async run(instance) {
    const { ledger } = instance;
    const now = await fixtureNow(instance);
    const base = issuance({ userPubkey: `U${"2".repeat(55)}`, issuedAtSec: now });
    const rejected: Array<[string, BrowserCredentialIssuance]> = [
      ["empty tenant", { ...base, tenant: "" }],
      ["empty accountContext", { ...base, accountContext: "" }],
      ["empty natsAccountPublicKey", { ...base, natsAccountPublicKey: "" }],
      ["empty peerId", { ...base, peerId: "" }],
      ["empty userPubkey", { ...base, userPubkey: "" }],
      // The recorded trap: Date.now() in MILLISECONDS reaching a seconds field.
      // addRevocation would accept it and install a year-58500 revocation floor.
      ["millisecond issuedAtSec", { ...base, issuedAtSec: 1_800_000_000_000 }],
      ["millisecond expiresAtSec", { ...base, expiresAtSec: 1_800_000_000_000 }],
      ["boundary issuedAtSec", { ...base, issuedAtSec: MAX_TIMESTAMP_SEC }],
      ["fractional issuedAtSec", { ...base, issuedAtSec: now + 0.5 }],
      ["zero issuedAtSec", { ...base, issuedAtSec: 0 }],
      ["negative expiresAtSec", { ...base, expiresAtSec: -1 }],
      ["NaN issuedAtSec", { ...base, issuedAtSec: Number.NaN }],
      ["Infinity expiresAtSec", { ...base, expiresAtSec: Number.POSITIVE_INFINITY }],
    ];
    for (const [label, candidate] of rejected) {
      await expectNamedError(() => ledger.recordIssuance(candidate), "BrowserCredentialLedgerInputError", `${label} was accepted`);
      invariant(await ledger.get(candidate.userPubkey) === null, `${label} persisted a record before failing validation`);
    }
    // The boundary itself is exclusive; one second below it is a legal record.
    invariant((await ledger.recordIssuance({ ...base, issuedAtSec: MAX_TIMESTAMP_SEC - 1 })).kind === "recorded", "a legal in-range timestamp was refused");
    await expectNamedError(() => ledger.markRevoked({ kind: "credential", userPubkey: base.userPubkey }, 1_800_000_000_000),
      "BrowserCredentialLedgerInputError", "millisecond revokedAtSec was accepted");
    await expectNamedError(() => ledger.markRevoked({ kind: "peer", natsAccountPublicKey: ACCOUNT, peerId: "" }, now),
      "BrowserCredentialLedgerInputError", "empty peer scope was accepted");
    await expectNamedError(() => ledger.list({ kind: "account", natsAccountPublicKey: ACCOUNT }, { limit: 0 }),
      "BrowserCredentialLedgerInputError", "limit 0 was accepted");
    await expectNamedError(() => ledger.list({ kind: "account", natsAccountPublicKey: ACCOUNT }, { limit: 1.5 }),
      "BrowserCredentialLedgerInputError", "fractional limit was accepted");
  } },

  { name: "3: one peer accumulates many credentials and every scope enumerates exactly its own", suite: "core", async run(instance) {
    const { ledger } = instance;
    const now = await fixtureNow(instance);
    // The reference login path mints a FRESH non-expiring credential per login,
    // so per-peer enumeration is the granularity an operator actually revokes at.
    const peerKeys = [`U${"a".repeat(55)}`, `U${"b".repeat(55)}`, `U${"c".repeat(55)}`];
    for (const [index, userPubkey] of peerKeys.entries()) {
      await ledger.recordIssuance(issuance({ userPubkey, issuedAtSec: now + index, expiresAtSec: index === 1 ? now + 86_400 : null }));
    }
    const sibling = `U${"d".repeat(55)}`;
    await ledger.recordIssuance(issuance({ userPubkey: sibling, peerId: "peer-2", issuedAtSec: now }));
    const foreign = `U${"e".repeat(55)}`;
    await ledger.recordIssuance(issuance({ userPubkey: foreign, natsAccountPublicKey: OTHER_ACCOUNT, issuedAtSec: now }));

    const peerScope = { kind: "peer", natsAccountPublicKey: ACCOUNT, peerId: "peer" } as const;
    const listed = await drain(ledger, peerScope, { limit: 10 });
    invariant(same(listed.map((r) => r.userPubkey).sort(), [...peerKeys].sort()), "per-peer enumeration lost or invented a credential");
    invariant(listed.filter((r) => r.expiresAtSec === null).length === 2, "non-expiring credentials were not enumerated");

    const account = await drain(ledger, { kind: "account", natsAccountPublicKey: ACCOUNT }, { limit: 10 });
    invariant(same(account.map((r) => r.userPubkey).sort(), [...peerKeys, sibling].sort()), "account enumeration did not span exactly its own peers");
    const single = await drain(ledger, { kind: "credential", userPubkey: peerKeys[1] as string }, { limit: 10 });
    invariant(single.length === 1 && single[0]?.userPubkey === peerKeys[1], "credential scope did not return exactly its one record");
    const other = await drain(ledger, { kind: "account", natsAccountPublicKey: OTHER_ACCOUNT }, { limit: 10 });
    invariant(same(other.map((r) => r.userPubkey), [foreign]), "a foreign account's records crossed the account scope");
  } },

  { name: "4: pagination is a stable total order with exact keyset resume", suite: "core", async run(instance) {
    const { ledger } = instance;
    const now = await fixtureNow(instance);
    // Two records deliberately SHARE an issuedAtSec: the documented order is
    // issuedAtSec DESC then userPubkey ASC, and only a tie exercises the
    // tie-break a keyset cursor needs to avoid duplicating or skipping a row.
    const seeded: Array<[string, number]> = [
      [`U${"1".repeat(55)}`, now + 3], [`U${"2".repeat(55)}`, now + 1], [`U${"3".repeat(55)}`, now + 2],
      [`U${"4".repeat(55)}`, now + 2], [`U${"5".repeat(55)}`, now],
    ];
    for (const [userPubkey, issuedAtSec] of seeded) await ledger.recordIssuance(issuance({ userPubkey, issuedAtSec }));
    const expected = [...seeded]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([userPubkey]) => userPubkey);

    const scope = { kind: "peer", natsAccountPublicKey: ACCOUNT, peerId: "peer" } as const;
    for (const limit of [1, 2, 5, 50]) {
      const walked = await drain(ledger, scope, { limit });
      invariant(same(walked.map((r) => r.userPubkey), expected), `limit ${limit} did not reproduce the documented total order exactly once per record`);
    }
    const firstPage = await ledger.list(scope, { limit: 2 });
    invariant(firstPage.cursor !== null, "a page smaller than the scope returned no cursor");
    // A cursor is bound to its scope+status; anything else must be refused, not
    // silently re-anchored — a re-anchored cursor can leak or drop rows.
    await expectNamedError(() => ledger.list({ kind: "account", natsAccountPublicKey: ACCOUNT }, { limit: 2, cursor: firstPage.cursor }),
      "BrowserCredentialCursorError", "a cursor from a different scope was accepted");
    await expectNamedError(() => ledger.list(scope, { limit: 2, status: "active", cursor: firstPage.cursor }),
      "BrowserCredentialCursorError", "a cursor from a different status filter was accepted");
    await expectNamedError(() => ledger.list(scope, { limit: 2, cursor: "not-a-cursor" }),
      "BrowserCredentialCursorError", "a fabricated cursor was accepted");
    const lastPage = await ledger.list(scope, { limit: 50 });
    invariant(lastPage.cursor === null && lastPage.records.length === expected.length, "an exhausted scope did not return a null cursor");
  } },

  { name: "5: markRevoked is scoped, atomic, idempotent, and monotonic", suite: "core", async run(instance) {
    const { ledger } = instance;
    const now = await fixtureNow(instance);
    const p1 = [`U${"1".repeat(55)}`, `U${"2".repeat(55)}`];
    const p2 = `U${"3".repeat(55)}`;
    const foreign = `U${"4".repeat(55)}`;
    for (const userPubkey of p1) await ledger.recordIssuance(issuance({ userPubkey, issuedAtSec: now }));
    await ledger.recordIssuance(issuance({ userPubkey: p2, peerId: "peer-2", issuedAtSec: now }));
    await ledger.recordIssuance(issuance({ userPubkey: foreign, natsAccountPublicKey: OTHER_ACCOUNT, issuedAtSec: now }));

    const peerScope = { kind: "peer", natsAccountPublicKey: ACCOUNT, peerId: "peer" } as const;
    invariant(same(await ledger.markRevoked(peerScope, now + 1), { marked: 2, alreadyRevoked: 0 }), "peer revocation did not mark exactly its scope");
    for (const userPubkey of p1) {
      const record = await ledger.get(userPubkey);
      invariant(record?.status === "revoked" && record.revokedAtSec === now + 1, "revoked record did not carry status revoked with its revokedAtSec");
    }
    for (const userPubkey of [p2, foreign]) {
      const record = await ledger.get(userPubkey);
      invariant(record?.status === "active" && record.revokedAtSec === null, "peer-scoped revocation marked a record outside its scope");
    }
    // Idempotent AND monotonic: a replay with a LATER stamp must not move the
    // record's revokedAtSec, or a retry would push out its retention horizon and
    // rewrite the audit answer to "when was this cut?".
    invariant(same(await ledger.markRevoked(peerScope, now + 500), { marked: 0, alreadyRevoked: 2 }), "replayed peer revocation was not idempotent");
    invariant((await ledger.get(p1[0] as string))?.revokedAtSec === now + 1, "replayed revocation re-stamped revokedAtSec");

    invariant(same(await ledger.markRevoked({ kind: "account", natsAccountPublicKey: ACCOUNT }, now + 2), { marked: 1, alreadyRevoked: 2 }), "account revocation did not absorb the already-revoked peer");
    invariant((await ledger.get(foreign))?.status === "active", "account-scoped revocation crossed into another account");
    invariant(same(await ledger.markRevoked({ kind: "credential", userPubkey: foreign }, now + 3), { marked: 1, alreadyRevoked: 0 }), "credential revocation did not mark its single record");
    invariant(same(await ledger.markRevoked({ kind: "credential", userPubkey: `U${"9".repeat(55)}` }, now + 3), { marked: 0, alreadyRevoked: 0 }), "unknown credential revocation did not report an empty match");

    const active = await drain(ledger, { kind: "account", natsAccountPublicKey: ACCOUNT }, { limit: 10, status: "active" });
    invariant(active.length === 0, "status filter still reports revoked records as active");
    const revoked = await drain(ledger, { kind: "account", natsAccountPublicKey: ACCOUNT }, { limit: 1, status: "revoked" });
    invariant(revoked.length === 3 && revoked.every((r) => r.status === "revoked"), "status filter did not page exactly the revoked set");
  } },

  { name: "6: both removable classes retain at equality and drop one second later", suite: "clock", async run(instance) {
    const { ledger } = instance; const clock = requireClock(instance, "case 6");
    const t0 = clock.nowSec();
    const expiring = `U${"1".repeat(55)}`;
    const cut = `U${"3".repeat(55)}`;
    await ledger.recordIssuance(issuance({ userPubkey: expiring, issuedAtSec: t0, expiresAtSec: t0 + 10 }));
    await ledger.recordIssuance(issuance({ userPubkey: cut, issuedAtSec: t0, expiresAtSec: null }));
    await clock.advance(10);
    await ledger.markRevoked({ kind: "credential", userPubkey: cut }, clock.nowSec());

    // Both removable classes now share the boundary t0 + 10 + retention: one
    // aged from expiresAtSec, one from revokedAtSec.
    await clock.advance(CONFORMANCE_RETENTION_SEC);
    invariant(await ledger.sweep() === 0, "configured retention evicted at the equality boundary");
    invariant(await ledger.get(expiring) !== null && await ledger.get(cut) !== null, "equality sweep removed a still-live record");
    await clock.advance(1);
    invariant(await ledger.sweep() === 2, "configured retention was ignored one second past the boundary");
    invariant(await ledger.get(expiring) === null && await ledger.get(cut) === null, "sweep reported removals it did not make");
    const drained = await drain(ledger, { kind: "peer", natsAccountPublicKey: ACCOUNT, peerId: "peer" }, { limit: 10 });
    invariant(drained.length === 0, "swept records are still enumerable");
  } },

  { name: "7: an ACTIVE non-expiring credential is never swept, at any age", suite: "clock", async run(instance) {
    const { ledger } = instance; const clock = requireClock(instance, "case 7");
    const t0 = clock.nowSec();
    const immortal = `U${"2".repeat(55)}`;
    const expiring = `U${"1".repeat(55)}`;
    await ledger.recordIssuance(issuance({ userPubkey: immortal, issuedAtSec: t0, expiresAtSec: null }));
    await ledger.recordIssuance(issuance({ userPubkey: expiring, issuedAtSec: t0, expiresAtSec: t0 + 10 }));
    // The property the whole SPI exists for. The reference login path mints
    // non-expiring credentials; a forgotten one is indistinguishable from
    // "there was nothing to cut", so no amount of elapsed time may drop it.
    await clock.advance(10_000_000);
    invariant(await ledger.sweep() === 1, "sweep removed an active non-expiring credential");
    const survivor = await ledger.get(immortal);
    invariant(survivor?.status === "active" && survivor.expiresAtSec === null, "an active non-expiring credential did not survive unbounded time");
    invariant(await ledger.get(expiring) === null, "the expired companion was not swept, so the case proved nothing");
    invariant(await ledger.sweep() === 0, "a repeated sweep removed the surviving non-expiring credential");
    const listed = await drain(ledger, { kind: "peer", natsAccountPublicKey: ACCOUNT, peerId: "peer" }, { limit: 10 });
    invariant(same(listed.map((r) => r.userPubkey), [immortal]), "the surviving credential is no longer enumerable");
  } },

  { name: "8/fault: a lost recordIssuance response never means a lost record", suite: "fault", async run(instance) {
    const now = await fixtureNow(instance);
    const ledger = interposeBrowserCredentialLedger(instance.ledger);
    const input = issuance({ userPubkey: `U${"7".repeat(55)}`, issuedAtSec: now, expiresAtSec: now + 60 });
    ledger.throwAfterRecord({ times: 1 });
    try { await ledger.recordIssuance(input); throw new Error("failpoint did not fire"); }
    catch (error) { invariant(error instanceof Error && error.message.includes("recorded response lost"), "wrong failpoint error"); }
    // The issuance path is fail-closed, so an ambiguous record means the caller
    // withheld a credential that may nonetheless be durable. The ledger must
    // still be able to name it — over-recording is recoverable, under-recording
    // is the incident.
    const recovered = await ledger.get(input.userPubkey);
    invariant(same(recovered, { ...input, status: "active", revokedAtSec: null }), "an ambiguous recordIssuance left no durable record");
    await expectNamedError(() => ledger.recordIssuance(input), "BrowserCredentialCollisionError", "a retry after an ambiguous record silently overwrote it");
  } },
];

export type BrowserCredentialLedgerConformanceReport = { passed: string[]; skipped: string[] };

export async function runBrowserCredentialLedgerConformance(
  options: BrowserCredentialLedgerConformanceOptions,
): Promise<BrowserCredentialLedgerConformanceReport> {
  const report: BrowserCredentialLedgerConformanceReport = { passed: [], skipped: [] };
  for (const testCase of browserCredentialLedgerConformanceCases) {
    const instance = await options.create({ retentionSec: CONFORMANCE_RETENTION_SEC, autoSweep: false });
    try {
      if (testCase.suite === "clock" && !instance.clock) {
        const message = `BrowserCredentialLedger conformance: SKIP ${testCase.name} (optional controlled clock capability not provided)`;
        report.skipped.push(testCase.name); (options.reportSkip ?? console.warn)(message); continue;
      }
      await testCase.run(instance); report.passed.push(testCase.name);
    }
    catch (error) { throw new Error(`${testCase.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    finally { await instance.close(); }
  }
  return report;
}
