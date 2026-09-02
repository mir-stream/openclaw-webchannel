import { Buffer } from "node:buffer";
import type { IngressOutcomeStore } from "./ingress-outcome.js";
import type { RetentionSessionToken } from "./inbound-retention.js";

export const MAX_OVERFLOW_RESOLVERS_PER_PROCESS = 64;
export const MAX_OVERFLOW_RESOLVER_METADATA_BYTES = 1 * 1024 * 1024;
const OVERFLOW_RESOLVER_METADATA_OVERHEAD = 192;

export type OverflowResolutionRequest = {
  accountId: string;
  peerId: string;
  key: string;
  id: string;
  sessionToken: RetentionSessionToken;
  /** `/stop` fallback recovery is authoritative over ordinary overload lookup. */
  recoverCancelled?: boolean;
};

export type OverflowResolverStart =
  | { status: "started" }
  | { status: "busy-session" | "busy-key" | "process-count" | "process-bytes" | "invalid" | "disposed" };

export type BoundedOverflowResolverOptions = {
  outcomeStore: IngressOutcomeStore;
  /**
   * #344 — THE DELIVERY JOURNAL, WHICH IS THE ACCEPT AUTHORITY (doc §15.7).
   * This resolver is the SECOND door onto a durable `accepted` marker, and round
   * 2 fixed only the first (`ingress-dedupe.ts`'s found branch), so the same
   * orphan that seam re-admits was still being acked away here.
   *
   * Optional because the resolver is constructed at module scope, before any
   * account has opened a journal, and because callers that predate the journal
   * still build one. Absent means "no authority to consult" and the accepted arm
   * keeps its pre-#344 behaviour — the same fallback the accept seam uses.
   */
  lookupUserRow?(
    request: OverflowResolutionRequest,
    idempotencyKey: string,
  ): { messageId: string; seq: number } | undefined;
  sendAck(
    request: OverflowResolutionRequest,
    committed?: Array<{ random_id: string; messageId: string; seq: number }>,
  ): boolean | Promise<boolean>;
  sendRejected(request: OverflowResolutionRequest): boolean | Promise<boolean>;
  onCancelledRecovered?(request: OverflowResolutionRequest): void;
  maxTasks?: number;
  maxMetadataBytes?: number;
};

/**
 * The identity BOTH stores key this id by.
 *
 * `request.key` is `${peerId}:<body>`, and the body is `ingressDedupeKey`'s —
 * the client `random_id` when it sent a usable one, else the wire id.
 * `appendInboundUser` writes that SAME value as the row's `idempotency_key`
 * (`randomId ?? turnId`), and `lookupUserMessageIdByRandomId` reads that column.
 * So deriving the journal key from the outcome key, rather than carrying a
 * second field, is what makes "the marker and the row are about the same
 * message" true by construction instead of by convention — and asking the two
 * stores about different messages is the exact defect class #344 exists for.
 *
 * Falls back to the wire id if the key is not `${peerId}:`-prefixed. Both
 * construction sites build it that way (`ingressDedupeKey` and
 * `nats-account-runtime.ts`'s `onOverflow`), so this is a totality guard, not a
 * second supported shape.
 */
function idempotencyKeyOf(request: OverflowResolutionRequest): string {
  const prefix = `${request.peerId}:`;
  return request.key.startsWith(prefix) ? request.key.slice(prefix.length) : request.id;
}

type ActiveTask = { request: OverflowResolutionRequest; bytes: number; cancelled: boolean; released: boolean };

export function overflowResolverMetadataBytes(request: OverflowResolutionRequest): number {
  return Buffer.byteLength(request.accountId, "utf8")
    + Buffer.byteLength(request.peerId, "utf8")
    + Buffer.byteLength(request.key, "utf8")
    + Buffer.byteLength(request.id, "utf8")
    + 1 // recoverCancelled mode bit
    + OVERFLOW_RESOLVER_METADATA_OVERHEAD;
}

/** No-wait bounded resolution for ids whose raw frame could not be retained. */
export class BoundedOverflowResolver {
  private readonly activeBySession = new Map<RetentionSessionToken, ActiveTask>();
  private readonly activeClaimsByAccount = new Map<string, Map<string, ActiveTask>>();
  private activeBytes = 0;
  private disposed = false;
  private readonly maxTasks: number;
  private readonly maxMetadataBytes: number;

  constructor(private readonly options: BoundedOverflowResolverOptions) {
    this.maxTasks = options.maxTasks ?? MAX_OVERFLOW_RESOLVERS_PER_PROCESS;
    this.maxMetadataBytes = options.maxMetadataBytes ?? MAX_OVERFLOW_RESOLVER_METADATA_BYTES;
    if (!Number.isSafeInteger(this.maxTasks) || this.maxTasks < 0) throw new TypeError("maxTasks is invalid");
    if (!Number.isSafeInteger(this.maxMetadataBytes) || this.maxMetadataBytes < 0) throw new TypeError("maxMetadataBytes is invalid");
  }

  hasActiveClaim(accountId: string, key: string): boolean {
    return this.activeClaimsByAccount.get(accountId)?.has(key) ?? false;
  }

  tryStart(request: OverflowResolutionRequest): OverflowResolverStart {
    if (this.disposed) return { status: "disposed" };
    if (
      typeof request.accountId !== "string" || typeof request.peerId !== "string"
      || typeof request.key !== "string" || typeof request.id !== "string"
      || request.id.length === 0 || request.id.length > 128
      || (request.recoverCancelled !== undefined && typeof request.recoverCancelled !== "boolean")
    ) return { status: "invalid" };
    if (this.activeBySession.has(request.sessionToken)) return { status: "busy-session" };
    if (this.hasActiveClaim(request.accountId, request.key)) return { status: "busy-key" };
    if (this.activeBySession.size >= this.maxTasks) return { status: "process-count" };
    const bytes = overflowResolverMetadataBytes(request);
    if (bytes > this.maxMetadataBytes - this.activeBytes) return { status: "process-bytes" };

    // Copy only bounded metadata. The source message/object is never captured.
    const retained: OverflowResolutionRequest = {
      accountId: request.accountId,
      peerId: request.peerId,
      key: request.key,
      id: request.id,
      sessionToken: request.sessionToken,
      recoverCancelled: request.recoverCancelled === true,
    };
    const task: ActiveTask = { request: retained, bytes, cancelled: false, released: false };
    this.activeBySession.set(retained.sessionToken, task);
    let accountClaims = this.activeClaimsByAccount.get(retained.accountId);
    if (!accountClaims) {
      accountClaims = new Map();
      this.activeClaimsByAccount.set(retained.accountId, accountClaims);
    }
    accountClaims.set(retained.key, task);
    this.activeBytes += bytes;
    void this.resolve(task);
    return { status: "started" };
  }

  invalidateSession(sessionToken: RetentionSessionToken): boolean {
    const task = this.activeBySession.get(sessionToken);
    if (!task || task.cancelled) return false;
    task.cancelled = true;
    return true;
  }

  invalidateAccount(accountId: string): number {
    let count = 0;
    for (const task of [...this.activeBySession.values()]) {
      if (task.request.accountId !== accountId) continue;
      if (task.cancelled) continue;
      task.cancelled = true;
      count++;
    }
    return count;
  }

  dispose(): number {
    if (this.disposed) return 0;
    this.disposed = true;
    const count = this.activeBySession.size;
    for (const task of [...this.activeBySession.values()]) {
      task.cancelled = true;
    }
    return count;
  }

  usage(): { tasks: number; metadataBytes: number } {
    return { tasks: this.activeBySession.size, metadataBytes: this.activeBytes };
  }

  private async resolve(task: ActiveTask): Promise<void> {
    const request = task.request;
    try {
      if (request.recoverCancelled) {
        // A failed `/stop` suppression write means this id was deliberately
        // killed. It must never be reclassified as overloaded merely because its
        // replay arrived while the raw retention budget was full. Replace any
        // conflicting marker, publish only ACK, and keep the fallback unless
        // persistence + ACK both succeed while this task is still active.
        const recorded = await this.options.outcomeStore.record(
          request.accountId,
          request.key,
          // #344: the outcome now SAYS "killed" instead of borrowing `accepted`.
          // The comment above already required this and the marker could not
          // express it — the accept seam read the borrowed `accepted` (with no
          // journal row) as a crash-window replay and re-ran the killed text.
          "cancelled",
          { replaceOthers: true },
        );
        if (task.cancelled || this.disposed) {
          if (recorded.status === "recorded") await recorded.write.rollback();
          return;
        }
        if (recorded.status !== "recorded") return;
        recorded.write.commit();
        const acked = await this.options.sendAck(request);
        if (!task.cancelled && !this.disposed && acked) {
          this.options.onCancelledRecovered?.(request);
        }
        return;
      }
      const known = await this.options.outcomeStore.lookup(request.accountId, request.key);
      if (task.cancelled || this.disposed) return;
      if (known.status === "found") {
        // #344: `overloaded` is the only outcome that publishes a refusal.
        if (known.outcome === "overloaded") {
          await this.options.sendRejected(request);
          return;
        }
        const idempotencyKey = idempotencyKeyOf(request);
        const row = this.userRowFor(request, idempotencyKey);
        // `cancelled` acks, exactly as it did while it was spelled `accepted`.
        // Its VERDICT asks the journal nothing — a `/stop` suppression has no row
        // on purpose, so absence proves nothing — but it still echoes a row that
        // happens to exist (a message journaled before the `/stop` landed).
        if (known.outcome === "cancelled") {
          await this.options.sendAck(
            request,
            this.committedEchoFor(request, idempotencyKey, row),
          );
          return;
        }
        // ⭐ #344 — `accepted` GETS THE SAME JOURNAL QUESTION THE ACCEPT SEAM
        // ASKS, AND THIS IS THE SECOND DOOR ONTO IT. Round 2 fixed the found
        // branch in `ingress-dedupe.ts` and left this one, so a crash-window
        // orphan replayed while the retention budget was full still landed here
        // and was acked as a terminal accept — the client drained its ledger and
        // the message was never journaled and never answered. Same rule, same
        // authority: a marker with no row is not evidence of an accept.
        if (this.options.lookupUserRow !== undefined && row === undefined) {
          // PUBLISH NOTHING, exactly like the `unknown` arm below — and for the
          // same reason: this resolver has no way to admit a message, only to
          // report a verdict, and there is no true verdict to report. Silence
          // leaves the client's ledger entry intact, so the message is replayed
          // and taken by the ordinary flush path, which journals it, dispatches
          // the turn and echoes the minted id. The retention pressure that sent
          // it here is transient; the loss it used to cause was not.
          return;
        }
        // #333 path 6: when the row DOES exist, carry the `committed` echo. This
        // arm used to ack bare, so a replay resolved through overflow left the
        // client with an un-adopted optimistic bubble until the next gap-sync.
        await this.options.sendAck(
          request,
          this.committedEchoFor(request, idempotencyKey, row),
        );
        return;
      }
      if (known.status === "unknown") return;
      const recorded = await this.options.outcomeStore.record(request.accountId, request.key, "overloaded");
      if (task.cancelled || this.disposed) {
        // Roll back this exact write while its per-key operation gate is still
        // held. A replacement lookup/write cannot overtake this cleanup.
        if (recorded.status === "recorded") await recorded.write.rollback();
        return;
      }
      if (recorded.status !== "recorded") return;
      if (recorded.durability !== "durable") {
        await recorded.write.rollback();
        return;
      }
      recorded.write.commit();
      await this.options.sendRejected(request);
    } catch {
      // Same-id live retry remains the recovery owner.
    } finally {
      this.release(task);
    }
  }

  /**
   * This id's journal row, or `undefined` for all three of "no journal wired",
   * "no row", and "the journal threw". Collapsing the three is deliberate at the
   * ONE call site that can act on it: the accepted arm re-checks
   * `options.lookupUserRow !== undefined` so an absent journal keeps the old
   * behaviour, and a fault is then treated as "no row" — the fail-safe
   * direction, since it withholds a terminal accept instead of inventing one.
   */
  private userRowFor(
    request: OverflowResolutionRequest,
    idempotencyKey: string,
  ): { messageId: string; seq: number } | undefined {
    try {
      return this.options.lookupUserRow?.(request, idempotencyKey);
    } catch {
      return undefined;
    }
  }

  /**
   * The `ack.committed` echo — present only when a row exists AND the identity
   * it is keyed by is a real client `random_id`.
   *
   * The second condition is why this is not just "the row". `idempotencyKeyOf`
   * yields `random_id ?? wireId`, and an echo whose `random_id` field carries a
   * WIRE id would have the client re-key an optimistic bubble by a value it
   * never used as a `random_id`. `ingress-dedupe.ts` draws the same line by only
   * ever pushing `committedBatch` entries when `randomId !== undefined`; here the
   * equivalent test is that the key body differs from the wire id. An older
   * client therefore still gets a bare ack — exactly as it does at that seam.
   */
  private committedEchoFor(
    request: OverflowResolutionRequest,
    idempotencyKey: string,
    row: { messageId: string; seq: number } | undefined,
  ): Array<{ random_id: string; messageId: string; seq: number }> | undefined {
    if (row === undefined || idempotencyKey === request.id) return undefined;
    return [{ random_id: idempotencyKey, messageId: row.messageId, seq: row.seq }];
  }

  private release(task: ActiveTask): void {
    if (task.released) return;
    task.released = true;
    if (this.activeBySession.get(task.request.sessionToken) === task) {
      this.activeBySession.delete(task.request.sessionToken);
    }
    const accountClaims = this.activeClaimsByAccount.get(task.request.accountId);
    if (accountClaims?.get(task.request.key) === task) accountClaims.delete(task.request.key);
    if (accountClaims?.size === 0) this.activeClaimsByAccount.delete(task.request.accountId);
    this.activeBytes -= task.bytes;
    if (this.activeBytes < 0) throw new Error("overflow resolver metadata accounting underflow");
  }
}
