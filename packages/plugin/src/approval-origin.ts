/**
 * Approval-origin lease registry (issue #93) — the EVIDENCE substrate for
 * exact-origin approval routing.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A plugin-kind approval request can arrive with every `turnSource*` field
 * `null`. The old fallback then asserted `web-anon` as the target: not the real
 * peer, so the approval was dropped and the write tool timed out — and, worse,
 * an UNPROVEN origin was asserted as a delivery target. This registry answers
 * exactly one question, and refuses to answer it whenever the answer would be a
 * guess:
 *
 *   "which exact webchannel peer had an ordinary agent run active on this
 *    (account, sessionKey) AT THE TIME this request was created — unambiguously?"
 *
 * ── The bias is deliberate ──────────────────────────────────────────────────
 * Every ambiguity, clock anomaly, alias overlap and unprovable ordering
 * resolves to a NON-answer. A false negative costs a dropped approval, which is
 * visible and diagnosable. A false positive delivers a permission prompt to the
 * WRONG browser session — the bug this module exists to prevent. Availability
 * is never traded for exact-origin safety.
 *
 * Consequences of that bias, each of which is load-bearing:
 *
 *   - The collision domain is the SDK-normalized account form
 *     (`normalizeAccountId`, not `toLowerCase()`): the SDK folds `-abc` to
 *     `abc`, so those spellings are the SAME account to core. A private
 *     lowercase-only key would keep them distinct and silently defeat the
 *     overlap poison below. Claims still carry the EXACT raw account id, so an
 *     alias never satisfies a resolve.
 *   - Two distinct exact origins `(rawAccountId, peerId)` alive at once on one
 *     canonical key POISON that key for the rest of the epoch — after a release,
 *     after every claim is gone, and across a later same-origin run. Once two
 *     runs have been confusable, no later state makes the earlier request
 *     provable.
 *   - Time comparisons are STRICT. Same-millisecond equality cannot prove
 *     ordering, so it is excluded; an anomalous clock (non-finite, or moving
 *     backwards inside an epoch) closes the whole epoch.
 *   - EVERY live agent run that can emit an approval is represented by exactly
 *     one claim on its canonical tuple, from `onAgentRunStart` until the outer
 *     `finally` — including runs that must never be ANSWERED with, such as a
 *     control-lane turn that fell through to a real agent turn. Those are
 *     recorded as `presence` claims (see {@link ApprovalOriginEvidence}), which
 *     are unselectable but visible to the overlap poison. Nothing live goes
 *     unrepresented: an unrepresented run is invisible to the poison, which is
 *     the one thing standing between a confusable tuple and a wrong-peer prompt.
 *   - The poison set is never evicted per key — evicting would discard safety
 *     evidence. Overflowing its cap escalates to poisoning the epoch globally.
 *
 * ── Epochs ──────────────────────────────────────────────────────────────────
 * A host teardown/reload rotates the epoch, which captures a new `barrierMs`.
 * Rotation does NOT drop active claims: the queue does not abort a running
 * handler, so a pre-reload run keeps its lease until its own `release()`. That
 * retained run can still serve requests it genuinely creates AFTER the new
 * barrier, while any pre-barrier request replayed by the gateway is rejected as
 * `invalid_request_time`.
 *
 * Pure and in-memory by construction: no I/O, an injectable clock, and no
 * dependency on the current config route or on alias enumeration.
 */

import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

/**
 * Outcome of a lease lookup. Only `resolved` names a delivery target.
 *
 * `ambiguous` and `epoch_poisoned` both mean "not deliverable", but they are
 * very different operational events and must not share a diagnostic:
 * `ambiguous` is ONE confusable tuple, while `epoch_poisoned` means the whole
 * epoch failed closed and EVERY fallback in the process is being dropped.
 */
export type ApprovalOriginLeaseResolution =
  | { kind: "resolved"; peerId: string }
  | { kind: "no_match" }
  | { kind: "ambiguous" }
  | { kind: "epoch_poisoned" }
  | { kind: "invalid_request_time" };

/**
 * An immutable handle to one prospective claim. The claim's fields are captured
 * in the closure at creation, so a caller can never mutate the evidence after
 * the fact.
 */
export type ApprovalOriginLease = Readonly<{
  /** Mark the run as started. Idempotent; captures `activatedAtMs` exactly once. */
  activate(): void;
  /** Drop only this handle's own claim. Idempotent; never touches another claim. */
  release(): void;
}>;

/**
 * What a claim is allowed to be used for.
 *
 *   - `origin` — an ordinary agent run. Its start time is captured and it is
 *     ELIGIBLE to be selected as the origin of a request created after it.
 *   - `presence` — a run that is live and can emit approvals, but must never be
 *     ANSWERED with. It is recorded at {@link UNPROVABLE_ACTIVATED_AT_MS}, so it
 *     can never be selected, while still counting toward the overlap poison.
 *
 * `presence` exists because "not selectable" and "not present" are different
 * requirements, and conflating them is a safety bug: an unrecorded live run is
 * invisible to the poison, which lets a DIFFERENT peer's claim be returned as
 * the origin of the unrecorded run's request.
 */
export type ApprovalOriginEvidence = "origin" | "presence";

/** Inputs identifying one live agent run. */
export type ApprovalOriginLeaseInput = {
  /** The EXACT account id the handler was registered with (never normalized). */
  rawAccountId: string;
  /** The session key already resolved for this turn. */
  sessionKey: string;
  /** The verified transport peer id (wsKey) that started the run. */
  peerId: string;
  /** Defaults to `"origin"`. See {@link ApprovalOriginEvidence}. */
  evidence?: ApprovalOriginEvidence;
};

/** Inputs for one origin lookup, from the approval resolver. */
export type ApprovalOriginResolveInput = {
  /** The EXACT raw account id the approval handler owns. */
  rawAccountId: string;
  /** `request.request.sessionKey`, already proven non-empty by the caller. */
  sessionKey: string;
  /** The outer `request.createdAtMs`. */
  requestCreatedAtMs: number;
};

/**
 * The surface the process-global getter promises. The getter validates a
 * pre-existing global STRUCTURALLY against this shape (never `instanceof`),
 * because a cache-busted module reload produces a different class object for
 * the same registry.
 */
export interface ApprovalOriginRegistry {
  /** Structural contract marker checked by {@link getApprovalOriginRegistry}. */
  readonly contractVersion: number;
  createLease(input: ApprovalOriginLeaseInput): ApprovalOriginLease;
  resolve(input: ApprovalOriginResolveInput): ApprovalOriginLeaseResolution;
  rotateEpoch(): void;
}

/** The structural contract version of this registry implementation. */
export const APPROVAL_ORIGIN_REGISTRY_CONTRACT_VERSION = 1;

/** Default cap on per-key poison entries before the epoch fails closed globally. */
export const DEFAULT_MAX_POISONED_KEYS = 1024;

/**
 * The `activatedAtMs` of a PRESENCE claim — a live run that must never be
 * selected as an origin. Three situations produce one, and they are all the same
 * concept rather than three special cases:
 *
 *   1. the caller declared `evidence: "presence"` (the control lane),
 *   2. the clock read was anomalous, so no start time can be trusted,
 *   3. the handle lay dormant across an epoch rotation, so its start time
 *      belongs to a teardown that has already been fenced off.
 *
 * `Infinity` implements "unselectable" exactly: `resolve` filters on
 * `activatedAtMs < requestCreatedAtMs`, and `Infinity < x` is false for every
 * finite `x` — while the claim still counts toward `poisonIfOverlapping`, both
 * on insert and in the `rotateEpoch` rescan, and is removed by its own
 * `release()` like any other claim.
 *
 * Dropping these claims instead (the tempting reading of "no proof, no claim")
 * would DELETE overlap evidence: a live run invisible to the poison lets a
 * post-barrier request from that run resolve to the OTHER peer on the tuple.
 * Adding claims is strictly one-directional — it can turn a `resolved` into an
 * `ambiguous` or leave a `no_match` alone, and can never manufacture a new
 * `resolved`. That trades a vanishingly rare wrong-peer delivery for a dropped
 * approval, which is the trade this module makes everywhere else.
 */
const UNPROVABLE_ACTIVATED_AT_MS = Number.POSITIVE_INFINITY;

/** One active agent run's proof of origin. Internal; never handed to a caller. */
type ApprovalOriginClaim = Readonly<{
  claimId: number;
  rawAccountId: string;
  canonicalKey: string;
  peerId: string;
  activatedAtMs: number;
}>;

const RESOLUTION_NO_MATCH: ApprovalOriginLeaseResolution = Object.freeze({
  kind: "no_match",
});
const RESOLUTION_AMBIGUOUS: ApprovalOriginLeaseResolution = Object.freeze({
  kind: "ambiguous",
});
const RESOLUTION_EPOCH_POISONED: ApprovalOriginLeaseResolution = Object.freeze({
  kind: "epoch_poisoned",
});
const RESOLUTION_INVALID_REQUEST_TIME: ApprovalOriginLeaseResolution =
  Object.freeze({ kind: "invalid_request_time" });

/**
 * The collision domain key: `(core-canonical account, sessionKey)`.
 *
 * The separator is a space, which the canonical account form can never contain
 * (`normalizeAccountId` emits `[a-z0-9_-]{1,64}` only), so the two fields
 * cannot be confused across the boundary. `sessionKey` is last and therefore
 * unconstrained.
 */
function composeCanonicalKey(rawAccountId: string, sessionKey: string): string {
  return `${normalizeAccountId(rawAccountId)} ${sessionKey}`;
}

/** Unambiguous identity of one exact origin, used only for overlap counting. */
function exactOriginKey(rawAccountId: string, peerId: string): string {
  return JSON.stringify([rawAccountId, peerId]);
}

/**
 * In-memory, single-process registry of ordinary-agent-run origin leases.
 *
 * Not a general active-turn or liveness registry: it proves only the short
 * window in which a run can emit a tool approval.
 */
export class ApprovalOriginLeaseRegistry implements ApprovalOriginRegistry {
  readonly contractVersion = APPROVAL_ORIGIN_REGISTRY_CONTRACT_VERSION;

  private readonly now: () => number;
  private readonly maxPoisonedKeys: number;

  /**
   * Claim id source. It lives on the INSTANCE, not at module scope: the
   * registry object is the process-global shared by every module generation, so
   * an instance counter is unique across reloads while a module-level one would
   * restart at zero in a fresh generation and collide with retained claims.
   */
  private nextClaimId = 1;

  private epoch = 0;
  private barrierMs = 0;
  private clockTrusted = false;
  private lastObservedMs = Number.NEGATIVE_INFINITY;

  private readonly claimsByKey = new Map<
    string,
    Map<number, ApprovalOriginClaim>
  >();
  private readonly poisonedKeys = new Set<string>();
  private epochGloballyPoisoned = false;

  constructor(options: { now?: () => number; maxPoisonedKeys?: number } = {}) {
    this.now = options.now ?? Date.now;
    const cap = options.maxPoisonedKeys;
    this.maxPoisonedKeys =
      typeof cap === "number" && Number.isInteger(cap) && cap > 0
        ? cap
        : DEFAULT_MAX_POISONED_KEYS;
    this.establishBarrier();
  }

  /**
   * Build an immutable handle for a turn WITHOUT touching registry state. The
   * exact claim, its unique id and the creation epoch are captured in the
   * closure; only `activate()` publishes anything.
   */
  createLease(input: ApprovalOriginLeaseInput): ApprovalOriginLease {
    const { rawAccountId, sessionKey, peerId } = input;
    const evidence: ApprovalOriginEvidence = input.evidence ?? "origin";
    const canonicalKey = composeCanonicalKey(rawAccountId, sessionKey);
    const claimId = this.nextClaimId++;
    const createdEpoch = this.epoch;
    let activated = false;
    let released = false;

    return Object.freeze({
      activate: (): void => {
        // A released handle's turn is over; it must never claim. Everything
        // else that reaches here is a LIVE run and gets a claim.
        if (activated || released) return;
        // Three ways to end up with a presence claim, one rule: the run is
        // recorded, but with no usable start time. Either the caller asked for
        // presence, or the handle lay dormant across a rotation (its start time
        // belongs to a teardown already fenced off), or the clock read was
        // anomalous — which additionally closes the epoch inside `readClock()`.
        const provable = evidence === "origin" && createdEpoch === this.epoch;
        const readMs = provable ? this.readClock() : null;
        activated = true;
        this.insertClaim(
          Object.freeze({
            claimId,
            rawAccountId,
            canonicalKey,
            peerId,
            activatedAtMs: readMs ?? UNPROVABLE_ACTIVATED_AT_MS,
          }),
        );
      },
      release: (): void => {
        if (released) return;
        released = true;
        // Keyed by this handle's own claim id, so a stale or dormant release
        // can never remove a newer claim on the same canonical key.
        this.deleteClaim(canonicalKey, claimId);
      },
    });
  }

  /**
   * Resolve the exact peer that provably owned this request's run, or say why
   * it cannot be proven. Never returns a peer under any ambiguity.
   */
  resolve(input: ApprovalOriginResolveInput): ApprovalOriginLeaseResolution {
    if (!this.clockTrusted) return RESOLUTION_INVALID_REQUEST_TIME;
    const nowMs = this.readClock();
    if (nowMs === null) return RESOLUTION_INVALID_REQUEST_TIME;

    const requestCreatedAtMs = input.requestCreatedAtMs;
    if (!Number.isFinite(requestCreatedAtMs)) {
      return RESOLUTION_INVALID_REQUEST_TIME;
    }
    // Barrier equality is rejected too: a request stamped exactly at the
    // barrier is not provably later than the rotation that drew it.
    if (requestCreatedAtMs <= this.barrierMs) {
      return RESOLUTION_INVALID_REQUEST_TIME;
    }
    if (requestCreatedAtMs > nowMs) return RESOLUTION_INVALID_REQUEST_TIME;

    const canonicalKey = composeCanonicalKey(
      input.rawAccountId,
      input.sessionKey,
    );
    // Kept distinct on purpose: one confusable tuple is a local event, whereas a
    // globally poisoned epoch is dropping EVERY fallback in the process until
    // the next rotation. An operator has to be able to tell those apart.
    if (this.epochGloballyPoisoned) return RESOLUTION_EPOCH_POISONED;
    if (this.poisonedKeys.has(canonicalKey)) return RESOLUTION_AMBIGUOUS;

    let onlyPeerId: string | undefined;
    for (const claim of this.claimsByKey.get(canonicalKey)?.values() ?? []) {
      // Exact raw account, byte equality: an alias sharing the canonical key
      // must not resolve.
      if (claim.rawAccountId !== input.rawAccountId) continue;
      // Strict: same-millisecond equality cannot prove the run preceded the
      // request.
      if (!(claim.activatedAtMs < requestCreatedAtMs)) continue;
      if (onlyPeerId === undefined) onlyPeerId = claim.peerId;
      // Defence in depth: overlapping distinct origins are normally already
      // poisoned, so this branch should be unreachable — take it anyway.
      else if (onlyPeerId !== claim.peerId) return RESOLUTION_AMBIGUOUS;
    }
    if (onlyPeerId === undefined) return RESOLUTION_NO_MATCH;
    return { kind: "resolved", peerId: onlyPeerId };
  }

  /**
   * Start a new epoch (host teardown/reload): draw a fresh barrier, restore
   * clock trust, and drop the previous epoch's poison.
   *
   * Active claims are deliberately RETAINED — a handler that survived teardown
   * owns its lease until its own `release()`. Retained claims are then rescanned
   * so any still-overlapping canonical key is re-poisoned immediately, before
   * any resolve can observe the cleared set.
   */
  rotateEpoch(): void {
    this.epoch += 1;
    this.poisonedKeys.clear();
    this.epochGloballyPoisoned = false;
    this.establishBarrier();
    for (const canonicalKey of this.claimsByKey.keys()) {
      this.poisonIfOverlapping(canonicalKey);
    }
  }

  /**
   * Capture the current clock as this epoch's barrier. A non-finite read leaves
   * the epoch untrusted (every resolve fails closed) until a later rotation
   * establishes a fresh finite barrier. A backwards jump IS accepted here: a
   * rotation is exactly where a new time baseline may legitimately be drawn.
   */
  private establishBarrier(): void {
    const value = this.now();
    if (!Number.isFinite(value)) {
      this.clockTrusted = false;
      return;
    }
    this.barrierMs = value;
    this.lastObservedMs = value;
    this.clockTrusted = true;
  }

  /**
   * Read the clock, or `null` on an anomaly. A read must be finite and
   * non-decreasing within the epoch; anything else marks the epoch untrusted,
   * which adds no claim and fails every resolve closed until the next rotation.
   */
  private readClock(): number | null {
    const value = this.now();
    if (!Number.isFinite(value) || value < this.lastObservedMs) {
      this.clockTrusted = false;
      return null;
    }
    this.lastObservedMs = value;
    return value;
  }

  private insertClaim(claim: ApprovalOriginClaim): void {
    let claims = this.claimsByKey.get(claim.canonicalKey);
    if (!claims) {
      claims = new Map<number, ApprovalOriginClaim>();
      this.claimsByKey.set(claim.canonicalKey, claims);
    }
    claims.set(claim.claimId, claim);
    this.poisonIfOverlapping(claim.canonicalKey);
  }

  private deleteClaim(canonicalKey: string, claimId: number): void {
    const claims = this.claimsByKey.get(canonicalKey);
    if (!claims) return;
    claims.delete(claimId);
    if (claims.size === 0) this.claimsByKey.delete(canonicalKey);
  }

  /**
   * Poison a canonical key once two or more DISTINCT exact origins
   * `(rawAccountId, peerId)` are active on it. Duplicate leases of one identical
   * origin are the normal repeated-turn case and never poison.
   */
  private poisonIfOverlapping(canonicalKey: string): void {
    const claims = this.claimsByKey.get(canonicalKey);
    if (!claims || claims.size < 2) return;
    const origins = new Set<string>();
    for (const claim of claims.values()) {
      origins.add(exactOriginKey(claim.rawAccountId, claim.peerId));
      if (origins.size >= 2) {
        this.poisonKey(canonicalKey);
        return;
      }
    }
  }

  /**
   * Record a poisoned key, escalating to a global epoch poison rather than
   * evicting: an evicted key is lost safety evidence, and losing it would let a
   * confusable tuple resolve again.
   */
  private poisonKey(canonicalKey: string): void {
    if (this.epochGloballyPoisoned || this.poisonedKeys.has(canonicalKey)) {
      return;
    }
    if (this.poisonedKeys.size + 1 > this.maxPoisonedKeys) {
      this.poisonedKeys.clear();
      this.epochGloballyPoisoned = true;
      return;
    }
    this.poisonedKeys.add(canonicalKey);
  }
}

/**
 * The versioned process-global slot. Exported so tests can plant and clean up
 * global values; production code must go through
 * {@link getApprovalOriginRegistry}.
 */
export const APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY = Symbol.for(
  "openclaw-webchannel.approval-origin-registry.v1",
);

/** Raised when the global slot holds something this build cannot share state with. */
export class IncompatibleApprovalOriginRegistryError extends Error {
  constructor(detail: string) {
    super(
      `webchannel: an incompatible approval-origin registry is already installed at ` +
        `${APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY.toString()} (${detail}). Refusing to replace it: ` +
        `two registries would split the lease state that exact-origin approval routing depends on.`,
    );
    this.name = "IncompatibleApprovalOriginRegistryError";
  }
}

function describeIncompatibility(value: unknown): string | undefined {
  if (value === null) return "expected an object, got null";
  if (typeof value !== "object") return `expected an object, got ${typeof value}`;
  const candidate = value as {
    contractVersion?: unknown;
    createLease?: unknown;
    resolve?: unknown;
    rotateEpoch?: unknown;
  };
  if (candidate.contractVersion !== APPROVAL_ORIGIN_REGISTRY_CONTRACT_VERSION) {
    return `contractVersion ${String(candidate.contractVersion)} !== ${APPROVAL_ORIGIN_REGISTRY_CONTRACT_VERSION}`;
  }
  for (const method of ["createLease", "resolve", "rotateEpoch"] as const) {
    if (typeof candidate[method] !== "function") return `missing ${method}()`;
  }
  return undefined;
}

/**
 * The one registry this process shares.
 *
 * Cache-busted module reloads produce a fresh module instance each time, so a
 * module-local singleton would let an OLD `inbound.ts` handle and a NEW
 * `approvals.ts` resolver observe different claims and different epochs — the
 * precise split this design exists to prevent. The slot is therefore validated
 * STRUCTURALLY (`contractVersion` plus the callable method surface), never with
 * `instanceof`, which cannot hold across generations.
 *
 * An incompatible value THROWS rather than being replaced: failing plugin
 * initialization closed is strictly safer than running on split state.
 */
export function getApprovalOriginRegistry(): ApprovalOriginRegistry {
  const slots = globalThis as unknown as Record<symbol, unknown>;
  const existing = slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
  if (existing !== undefined) {
    const detail = describeIncompatibility(existing);
    if (detail !== undefined) {
      throw new IncompatibleApprovalOriginRegistryError(detail);
    }
    return existing as ApprovalOriginRegistry;
  }
  const created = new ApprovalOriginLeaseRegistry();
  slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = created;
  return created;
}
