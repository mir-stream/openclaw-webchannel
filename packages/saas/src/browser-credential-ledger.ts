/**
 * Browser-credential issuance ledger — the durability SPI that answers
 * "what was issued, so what do we cut?".
 *
 * `issueBrowserCredentials` mints a NATS user credential whose `userPubkey`
 * (`U…`) IS the NATS revocation key (see `addRevocation`). Until this ledger
 * existed the key was returned to the caller and recorded nowhere, so a leak had
 * no answer to "which keys must be refused" — and a per-peer answer was not even
 * enumerable, because the reference login path mints a FRESH non-expiring
 * credential on every login and they accumulate under one peerId.
 *
 * Design authority: `docs/ISSUE_72_CONTAINMENT_PLAN.md` §3 (Track A — 발급 원장).
 * The record shape is §3.1 verbatim; the issuance ordering is §3.2.
 *
 * NEVER RECORDED, ANYWHERE: `userJwt`, `userSeed`, `userSeedRaw`, the
 * conversation key K, or any private key. Not in a record, not in a query
 * response, not in a log line, not in an error message. Every error thrown from
 * this module is built from scope identifiers and field names only.
 *
 * TIME UNIT: every timestamp on this SPI is **unix seconds** and every such
 * field is named with a `Sec` suffix. Milliseconds are the recorded trap on this
 * track: `addRevocation` validates a revocation floor as finite/positive/integer
 * but applies NO upper bound, so a millisecond value silently installs a
 * revocation floor in the year 58500 and permanently refuses that key. This SPI
 * therefore rejects any timestamp at or beyond {@link MAX_TIMESTAMP_SEC}, which
 * a millisecond-valued "now" exceeds by three orders of magnitude.
 */

/**
 * Exclusive upper bound for every `…Sec` timestamp on this SPI:
 * 2100-01-01T00:00:00Z. Chosen purely as a millisecond tripwire — `Date.now()`
 * in milliseconds is ~1.8e12, far beyond it, so a unit mix-up fails loudly at
 * the ledger instead of silently reaching `addRevocation`.
 */
export const MAX_TIMESTAMP_SEC = 4_102_444_800;

/**
 * Credential lifecycle status.
 *
 * `revoked` is present from the FIRST published version even though nothing in
 * this sub-task transitions into it: a consumer that writes an exhaustive
 * `switch` over the status of a published SPI is broken by a later enum
 * addition, and this package is about to be published.
 */
export type BrowserCredentialStatus = "active" | "revoked";

/**
 * A secret-free record of one issued browser credential (plan §3.1).
 *
 * `userPubkey` is the primary key: it is a freshly generated Ed25519 public
 * NKEY, unique per mint, and it is exactly the key `addRevocation` refuses.
 */
export type BrowserCredentialRecord = {
  readonly tenant: string;
  /** Audit label only. NEVER used as the NATS account identity (plan §4.1). */
  readonly accountContext: string;
  /** The NATS account public key (`A…`) whose JWT carries the revocation that binds this credential. */
  readonly natsAccountPublicKey: string;
  readonly peerId: string;
  /** Minted user public NKEY (`U…`) = the JWT `sub` = the NATS revocation key. */
  readonly userPubkey: string;
  /** The credential's own `iat`, decoded from the minted JWT — never the ledger clock. */
  readonly issuedAtSec: number;
  /** The credential's own `exp`, or `null` for a non-expiring credential. */
  readonly expiresAtSec: number | null;
  readonly status: BrowserCredentialStatus;
  readonly revokedAtSec: number | null;
};

/** The caller-supplied half of a record; the ledger owns `status`/`revokedAtSec`. */
export type BrowserCredentialIssuance = Omit<BrowserCredentialRecord, "status" | "revokedAtSec">;

/**
 * The three granularities every consumer of this ledger needs, as one union
 * shared by {@link BrowserCredentialLedger.list} and
 * {@link BrowserCredentialLedger.markRevoked}.
 *
 * All scoping is by `natsAccountPublicKey`, never by `accountContext`: the
 * account public key is what a revocation is actually bound to (plan §4.1).
 * `credential` needs no account: `userPubkey` is globally unique.
 */
export type BrowserCredentialScope =
  | { readonly kind: "credential"; readonly userPubkey: string }
  | { readonly kind: "peer"; readonly natsAccountPublicKey: string; readonly peerId: string }
  | { readonly kind: "account"; readonly natsAccountPublicKey: string };

export type BrowserCredentialQuery = {
  /** Omit for every status. */
  readonly status?: BrowserCredentialStatus;
  /** Maximum records in the returned page. Must be a positive integer when present. */
  readonly limit?: number;
  /** `null`/omitted starts at the first page; otherwise a cursor from a previous page of the SAME scope+status. */
  readonly cursor?: string | null;
};

/**
 * One page of the scope's total order.
 *
 * INVARIANT a non-null `cursor` implies a NON-EMPTY `records` array, so a
 * `while (cursor)` drain always terminates.
 */
export type BrowserCredentialPage = {
  readonly records: readonly BrowserCredentialRecord[];
  /** Opaque; `null` means the scope is exhausted. */
  readonly cursor: string | null;
};

/**
 * Outcome of {@link BrowserCredentialLedger.recordIssuance}.
 *
 * `fenced` exists from the first published version for the same reason
 * `"revoked"` does: plan §3.2 makes the fence check part of THIS transaction —
 * a scope with a live revocation fence must not be able to persist (and
 * therefore must not be able to release) a new credential. Nothing in this
 * sub-task acquires a fence, so a ledger with no fence support returns
 * `recorded` always; the variant is reserved so adding fences later is an
 * implementation change and not a contract change.
 *
 * Either way the caller's obligation is the same and is fail-closed: anything
 * other than `recorded` means the minted JWT and seed are destroyed unreturned.
 */
export type RecordIssuanceOutcome =
  | { readonly kind: "recorded"; readonly record: BrowserCredentialRecord }
  | { readonly kind: "fenced"; readonly scope: "peer" | "account" };

/** Outcome of {@link BrowserCredentialLedger.markRevoked}; `marked + alreadyRevoked` is the matched-record count. */
export type MarkRevokedResult = {
  readonly marked: number;
  readonly alreadyRevoked: number;
};

/** `name` is the portable cross-package contract; consumers must not rely on `instanceof`. */
export class BrowserCredentialCollisionError extends Error {
  constructor(userPubkey: string) {
    super(`webchannel: browser credential already recorded: ${userPubkey}`);
    this.name = "BrowserCredentialCollisionError";
  }
}
/** `name` is the portable cross-package contract; consumers must not rely on `instanceof`. */
export class BrowserCredentialCursorError extends Error {
  constructor(message = "webchannel: browser credential cursor does not belong to this scope/status query") {
    super(message);
    this.name = "BrowserCredentialCursorError";
  }
}
/** `name` is the portable cross-package contract; consumers must not rely on `instanceof`. */
export class BrowserCredentialLedgerInputError extends Error {
  constructor(message: string) {
    super(`webchannel: ${message}`);
    this.name = "BrowserCredentialLedgerInputError";
  }
}

const isTimestampSec = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < MAX_TIMESTAMP_SEC;
const isIdentifier = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Shared input validation so an adapter proves the SAME rejections the
 * conformance suite asserts instead of reimplementing them. Field NAMES only in
 * the message — never a field value, because two of them are identifiers a
 * deployer may consider privacy-relevant and none of them are worth the risk of
 * a value reaching a log.
 */
export function assertBrowserCredentialIssuance(issuance: BrowserCredentialIssuance): void {
  for (const field of ["tenant", "accountContext", "natsAccountPublicKey", "peerId", "userPubkey"] as const) {
    if (!isIdentifier(issuance[field])) {
      throw new BrowserCredentialLedgerInputError(`browser credential ${field} must be a non-empty string`);
    }
  }
  if (!isTimestampSec(issuance.issuedAtSec)) throw new BrowserCredentialLedgerInputError(timestampMessage("issuedAtSec"));
  if (issuance.expiresAtSec !== null && !isTimestampSec(issuance.expiresAtSec)) {
    throw new BrowserCredentialLedgerInputError(`${timestampMessage("expiresAtSec")}, or null for a non-expiring credential`);
  }
}

/** Same rule as the record timestamps — see {@link MAX_TIMESTAMP_SEC}. */
export function assertTimestampSec(value: number, field: string): void {
  if (!isTimestampSec(value)) throw new BrowserCredentialLedgerInputError(timestampMessage(field));
}

const timestampMessage = (field: string): string =>
  `browser credential ${field} must be a positive integer below ${MAX_TIMESTAMP_SEC} unix SECONDS (a millisecond value is the recorded trap on this path)`;

export function assertBrowserCredentialScope(scope: BrowserCredentialScope): void {
  if (scope === null || typeof scope !== "object") {
    throw new BrowserCredentialLedgerInputError("browser credential scope must be an object with kind credential, peer, or account");
  }
  const candidate = scope as unknown as Record<string, unknown>;
  let fields: readonly string[];
  switch (candidate.kind) {
    case "credential": fields = ["userPubkey"]; break;
    case "peer": fields = ["natsAccountPublicKey", "peerId"]; break;
    case "account": fields = ["natsAccountPublicKey"]; break;
    default:
      // Never default an untrusted discriminator to the broadest scope. A
      // misspelled peer scope becoming an account scope would turn one cut into
      // an account-wide operation.
      throw new BrowserCredentialLedgerInputError("browser credential scope kind must be credential, peer, or account");
  }
  for (const field of fields) {
    if (!isIdentifier(candidate[field])) {
      throw new BrowserCredentialLedgerInputError(`browser credential scope ${candidate.kind as string}.${field} must be a non-empty string`);
    }
  }
}

/**
 * The durability boundary for browser-credential issuance.
 *
 * Implementations own the authoritative clock (`nowSec`) used for retention and
 * for stamping revocations. They do NOT own `issuedAtSec`/`expiresAtSec`: those
 * are decoded from the credential itself by the issuance path (plan §3.2), so a
 * ledger whose clock disagrees with the issuer still records the truth about
 * what a nats-server will accept.
 */
export interface BrowserCredentialLedger {
  /** Authoritative unix-SECONDS clock; used for retention and revocation stamps only. */
  nowSec(): Promise<number>;
  /**
   * Persist one issuance. INSERT-ONLY: a repeat `userPubkey` throws
   * {@link BrowserCredentialCollisionError} and leaves the stored record
   * untouched — an overwrite could silently replace an active record with a
   * weaker one and lose the very key an operator has to cut.
   *
   * Callers MUST treat any outcome other than `recorded`, and any throw, as
   * fail-closed: destroy the minted credential, return nothing.
   */
  recordIssuance(issuance: BrowserCredentialIssuance): Promise<RecordIssuanceOutcome>;
  /** Point read by the revocation key itself. */
  get(userPubkey: string): Promise<BrowserCredentialRecord | null>;
  /**
   * Page through a scope in a stable TOTAL order: `issuedAtSec` descending,
   * ties broken by `userPubkey` ascending. `userPubkey` is unique, so the order
   * is total and a keyset cursor over it can neither duplicate nor skip.
   *
   * A cursor is only valid for the identical scope+status; anything else throws
   * {@link BrowserCredentialCursorError}. An implementation must never return a
   * record outside the requested scope/status, whatever cursor it is handed.
   */
  list(scope: BrowserCredentialScope, query?: BrowserCredentialQuery): Promise<BrowserCredentialPage>;
  /**
   * Transition every ACTIVE record in `scope` to `revoked` with
   * `revokedAtSec`, atomically. Idempotent and monotonic: an already-revoked
   * record keeps its original `revokedAtSec` and is counted in
   * `alreadyRevoked`, never re-stamped and never returned to `active`.
   *
   * This is the ledger's own record lifecycle, not the revocation OPERATION —
   * authorization, dry-run, confirmation consume, issuance fences, and the
   * account-JWT publish/readback all live in plan §4/§5 and are out of scope
   * here. The transition is on the SPI now because the published record type
   * declares a `revoked` state, and a state no method can reach is not a
   * contract a deployer can implement.
   */
  markRevoked(scope: BrowserCredentialScope, revokedAtSec: number): Promise<MarkRevokedResult>;
  /**
   * Drop records that can no longer name a usable credential, returning how
   * many were removed. Exactly two removable classes, both at a STRICT `>`
   * boundary so a record is contractually live at equality:
   *
   *   - `expiresAtSec !== null && nowSec > expiresAtSec + retention` — the
   *     credential is refused by nats-server on its own, whatever its status.
   *   - `status === "revoked" && nowSec > revokedAtSec + retention` — an
   *     operator has already cut it.
   *
   * An ACTIVE record with `expiresAtSec === null` is NEVER removable. That is
   * the whole point of the ledger: the reference login path mints non-expiring
   * credentials, and forgetting one is indistinguishable from "there was
   * nothing to cut".
   */
  sweep(): Promise<number>;
}

export type MemoryBrowserCredentialLedgerOptions = {
  /** Unix SECONDS. Defaults to `Date.now()/1000` floored. */
  clockSec?: () => number;
  /** Seconds retained past a record's removable boundary. */
  retentionSec?: number;
  autoSweep?: boolean;
  sweepIntervalMs?: number;
  /** Page size when a query omits `limit`. */
  defaultLimit?: number;
};

const DEFAULT_RETENTION_SEC = 30 * 24 * 60 * 60;
const DEFAULT_SWEEP_INTERVAL_MS = 3_600_000;
const DEFAULT_LIMIT = 200;

const scopeKey = (scope: BrowserCredentialScope): string => {
  switch (scope.kind) {
    case "credential": return `c ${scope.userPubkey}`;
    case "peer": return `p ${scope.natsAccountPublicKey} ${scope.peerId}`;
    case "account": return `a ${scope.natsAccountPublicKey}`;
    default: throw new BrowserCredentialLedgerInputError("browser credential scope kind must be credential, peer, or account");
  }
};

const inScope = (record: BrowserCredentialRecord, scope: BrowserCredentialScope): boolean => {
  switch (scope.kind) {
    case "credential": return record.userPubkey === scope.userPubkey;
    case "peer": return record.natsAccountPublicKey === scope.natsAccountPublicKey && record.peerId === scope.peerId;
    case "account": return record.natsAccountPublicKey === scope.natsAccountPublicKey;
    default: throw new BrowserCredentialLedgerInputError("browser credential scope kind must be credential, peer, or account");
  }
};

// issuedAtSec DESC, then userPubkey ASC. userPubkey is unique, so this is a
// TOTAL order — the property a keyset cursor needs to be exact.
const byNewestFirst = (a: BrowserCredentialRecord, b: BrowserCredentialRecord): number =>
  b.issuedAtSec - a.issuedAtSec || (a.userPubkey < b.userPubkey ? -1 : a.userPubkey > b.userPubkey ? 1 : 0);

type CursorPayload = { readonly k: string; readonly s: string | null; readonly i: number; readonly u: string };

// Every record leaves this ledger as a copy. `readonly` is a compile-time
// promise only; a JS consumer that mutated a returned record would silently
// rewrite the durable answer to "what do we cut?" — and an adapter with an
// in-process cache has the identical hazard.
const clone = (record: BrowserCredentialRecord): BrowserCredentialRecord => ({ ...record });

/**
 * Single-process reference implementation.
 *
 * NOT DURABLE, and therefore NOT A PRODUCTION DEFAULT. A gateway restart empties
 * it, and an empty ledger is indistinguishable from "nothing was ever issued" —
 * which is the exact failure this SPI exists to prevent. A deployer MUST supply
 * a durable implementation and prove it with
 * `runBrowserCredentialLedgerConformance`. This class is for tests, for local
 * demos, and as the executable spelling of the contract.
 */
export class MemoryBrowserCredentialLedger implements BrowserCredentialLedger {
  private records = new Map<string, BrowserCredentialRecord>();
  private readonly clockSec: () => number;
  private readonly retentionSec: number;
  private readonly defaultLimit: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: MemoryBrowserCredentialLedgerOptions = {}) {
    this.clockSec = options.clockSec ?? (() => Math.floor(Date.now() / 1000));
    this.retentionSec = options.retentionSec ?? DEFAULT_RETENTION_SEC;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (options.autoSweep !== false) this.startSweeper();
  }
  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }
  close(): void { if (this.sweepTimer) clearInterval(this.sweepTimer); this.sweepTimer = undefined; }

  async nowSec(): Promise<number> { return Math.floor(this.clockSec()); }

  async recordIssuance(issuance: BrowserCredentialIssuance): Promise<RecordIssuanceOutcome> {
    assertBrowserCredentialIssuance(issuance);
    if (this.records.has(issuance.userPubkey)) throw new BrowserCredentialCollisionError(issuance.userPubkey);
    // Spell the record out field by field instead of spreading the caller's
    // object: a caller that hands over an object carrying extra properties (a
    // JWT, a seed) must not be able to widen the durable record by accident.
    const record: BrowserCredentialRecord = {
      tenant: issuance.tenant,
      accountContext: issuance.accountContext,
      natsAccountPublicKey: issuance.natsAccountPublicKey,
      peerId: issuance.peerId,
      userPubkey: issuance.userPubkey,
      issuedAtSec: issuance.issuedAtSec,
      expiresAtSec: issuance.expiresAtSec,
      status: "active",
      revokedAtSec: null,
    };
    this.records.set(record.userPubkey, record);
    // This implementation has no fence store, so it can never answer `fenced`.
    return { kind: "recorded", record: clone(record) };
  }

  async get(userPubkey: string): Promise<BrowserCredentialRecord | null> {
    const record = this.records.get(userPubkey);
    return record ? clone(record) : null;
  }

  async list(scope: BrowserCredentialScope, query: BrowserCredentialQuery = {}): Promise<BrowserCredentialPage> {
    assertBrowserCredentialScope(scope);
    const limit = query.limit ?? this.defaultLimit;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new BrowserCredentialLedgerInputError("browser credential query limit must be a positive integer");
    }
    const status = query.status ?? null;
    // `!= null`, not truthiness: an empty-string cursor is a caller error, not a
    // request for the first page.
    const after = query.cursor != null ? this.decodeCursor(query.cursor, scope, status) : null;
    const matched = [...this.records.values()]
      .filter((record) => inScope(record, scope) && (status === null || record.status === status))
      .sort(byNewestFirst)
      // Strictly after the cursor in the SAME total order used to sort.
      .filter((record) => !after || record.issuedAtSec < after.i || (record.issuedAtSec === after.i && record.userPubkey > after.u));
    const records = matched.slice(0, limit).map(clone);
    const last = records.at(-1);
    // A non-null cursor must imply a non-empty page, or a draining loop never
    // terminates — so the cursor is emitted only when a further record exists.
    const cursor = last && matched.length > records.length
      ? Buffer.from(JSON.stringify({ k: scopeKey(scope), s: status, i: last.issuedAtSec, u: last.userPubkey } satisfies CursorPayload)).toString("base64url")
      : null;
    return { records, cursor };
  }

  private decodeCursor(cursor: string, scope: BrowserCredentialScope, status: BrowserCredentialStatus | null): CursorPayload {
    let payload: CursorPayload;
    // A malformed cursor is caller input; nothing of it reaches the message.
    try { payload = JSON.parse(Buffer.from(cursor, "base64url").toString()) as CursorPayload; }
    catch { throw new BrowserCredentialCursorError("webchannel: browser credential cursor is not a cursor this ledger issued"); }
    if (payload?.k !== scopeKey(scope) || (payload.s ?? null) !== status || typeof payload.i !== "number" || typeof payload.u !== "string") {
      throw new BrowserCredentialCursorError();
    }
    return payload;
  }

  async markRevoked(scope: BrowserCredentialScope, revokedAtSec: number): Promise<MarkRevokedResult> {
    assertBrowserCredentialScope(scope);
    assertTimestampSec(revokedAtSec, "revokedAtSec");
    let marked = 0; let alreadyRevoked = 0;
    // Stage into a private copy and publish the whole map with one reference
    // replacement. Besides making concurrent reads all-before/all-after, this
    // leaves the authoritative map untouched if staging itself throws. A
    // durable adapter must spell the equivalent as one database transaction.
    const staged = new Map(this.records);
    for (const [key, record] of this.records) {
      if (!inScope(record, scope)) continue;
      if (record.status === "revoked") { alreadyRevoked++; continue; }
      staged.set(key, { ...record, status: "revoked", revokedAtSec });
      marked++;
    }
    if (marked > 0) this.beforeMarkRevokedCommitForConformance();
    this.records = staged;
    return { marked, alreadyRevoked };
  }

  /** @internal A no-op seam used only to fail the real staged transaction immediately before commit in conformance tests. */
  protected beforeMarkRevokedCommitForConformance(): void {}

  async sweep(): Promise<number> {
    const now = Math.floor(this.clockSec()); let removed = 0;
    for (const [key, record] of this.records) {
      const expired = record.expiresAtSec !== null && now > record.expiresAtSec + this.retentionSec;
      const cut = record.status === "revoked" && record.revokedAtSec !== null && now > record.revokedAtSec + this.retentionSec;
      if (expired || cut) { this.records.delete(key); removed++; }
    }
    return removed;
  }
}
