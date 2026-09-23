import { Buffer } from "node:buffer";
import type { IngressOutcomeStore } from "./ingress-outcome.js";
import { MAX_INGRESS_RESULT_IDS } from "./ingress-result-chunks.js";
import type { RetentionSessionToken } from "./inbound-retention.js";

export const MAX_OVERFLOW_RESOLVERS_PER_PROCESS = 64;
export const MAX_OVERFLOW_RESOLVER_METADATA_BYTES = 1 * 1024 * 1024;
const OVERFLOW_RESOLVER_METADATA_OVERHEAD = 192;

export type OverflowResolutionRequest = {
  accountId: string;
  peerId: string;
  key: string;
  id: string;
  /** Usable client random_id; presence cannot be inferred from equality with id. */
  randomId?: string;
  sessionToken: RetentionSessionToken;
  /** `/stop` fallback recovery is authoritative over ordinary overload lookup. */
  recoverCancelled?: boolean;
};

export type OverflowResolverStart =
  | { status: "started" | "joined" }
  | { status: "busy-session" | "busy-key" | "process-count" | "correlation-count" | "process-bytes" | "invalid" | "disposed" };

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
    cancelled?: boolean,
  ): boolean | Promise<boolean>;
  sendRejected(request: OverflowResolutionRequest): boolean | Promise<boolean>;
  onCancelledRecovered?(request: OverflowResolutionRequest): void;
  maxTasks?: number;
  maxMetadataBytes?: number;
};

/** The journal key is the body of the canonical peer-scoped outcome key. */
function idempotencyKeyOf(request: OverflowResolutionRequest): string {
  const prefix = `${request.peerId}:`;
  return request.key.startsWith(prefix) ? request.key.slice(prefix.length) : request.id;
}

type ActiveTask = {
  request: OverflowResolutionRequest;
  correlations: OverflowResolutionRequest[];
  bytes: number;
  cancelled: boolean;
  released: boolean;
};

export function overflowResolverMetadataBytes(request: OverflowResolutionRequest): number {
  return Buffer.byteLength(request.accountId, "utf8")
    + Buffer.byteLength(request.peerId, "utf8")
    + Buffer.byteLength(request.key, "utf8")
    + Buffer.byteLength(request.id, "utf8")
    + Buffer.byteLength(request.randomId ?? "", "utf8")
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
      || (request.randomId !== undefined && (typeof request.randomId !== "string"
        || request.randomId.length === 0 || request.randomId.length > 128))
      || (request.recoverCancelled !== undefined && typeof request.recoverCancelled !== "boolean")
    ) return { status: "invalid" };
    const active = this.activeBySession.get(request.sessionToken);
    if (active) {
      if (active.cancelled || active.request.accountId !== request.accountId
        || active.request.peerId !== request.peerId || active.request.key !== request.key
        || (request.recoverCancelled === true && !active.request.recoverCancelled)
        || active.correlations.some((value) => value.id === request.id && value.randomId === request.randomId)) {
        return { status: "busy-session" };
      }
      // New wire correlations share one logical verdict without adding storage
      // tasks or retaining source frames. Both count and charged bytes are bounded.
      if (active.correlations.length >= MAX_INGRESS_RESULT_IDS) return { status: "correlation-count" };
      const bytes = overflowResolverMetadataBytes(request);
      if (bytes > this.maxMetadataBytes - this.activeBytes) return { status: "process-bytes" };
      active.correlations.push(this.copyRequest(request));
      active.bytes += bytes;
      this.activeBytes += bytes;
      return { status: "joined" };
    }
    if (this.hasActiveClaim(request.accountId, request.key)) return { status: "busy-key" };
    if (this.activeBySession.size >= this.maxTasks) return { status: "process-count" };
    const bytes = overflowResolverMetadataBytes(request);
    if (bytes > this.maxMetadataBytes - this.activeBytes) return { status: "process-bytes" };

    // Copy only bounded metadata. The source message/object is never captured.
    const retained = this.copyRequest(request);
    const task: ActiveTask = { request: retained, correlations: [retained], bytes, cancelled: false, released: false };
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

  /** One bounded logical target, captured synchronously before /stop commits.
   * The resolver may own an ID with no retained frame or dispatch row yet. */
  pendingLogicalKey(sessionToken: RetentionSessionToken): string | undefined {
    const task = this.activeBySession.get(sessionToken);
    return !this.disposed && task && !task.cancelled ? idempotencyKeyOf(task.request) : undefined;
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

  private copyRequest(request: OverflowResolutionRequest): OverflowResolutionRequest {
    return {
      accountId: request.accountId, peerId: request.peerId, key: request.key,
      id: request.id, randomId: request.randomId, sessionToken: request.sessionToken,
      recoverCancelled: request.recoverCancelled === true,
    };
  }

  private async resolve(task: ActiveTask): Promise<void> {
    const request = task.request;
    try {
      let outcome: "accepted" | "cancelled" | "overloaded";
      let row: { messageId: string; seq: number } | undefined;
      if (request.recoverCancelled) {
        // /stop fallback is authoritative over an ordinary overload marker.
        const recorded = await this.options.outcomeStore.record(
          request.accountId, request.key, "cancelled", { replaceOthers: true },
        );
        if (task.cancelled || this.disposed) {
          if (recorded.status === "recorded") await recorded.write.rollback();
          return;
        }
        if (recorded.status !== "recorded") return;
        if (recorded.durability !== "durable") {
          await recorded.write.rollback();
          return;
        }
        recorded.write.commit();
        outcome = "cancelled";
        row = this.userRowFor(request, idempotencyKeyOf(request));
      } else {
        const known = await this.options.outcomeStore.lookup(request.accountId, request.key);
        if (task.cancelled || this.disposed || known.status === "unknown") return;
        if (known.status === "found") {
          outcome = known.outcome;
          if (outcome !== "overloaded") row = this.userRowFor(request, idempotencyKeyOf(request));
          // #364: a marker alone cannot prove acceptance. Leave an orphan
          // unresolved for normal admission; cancelled needs no journal row.
          if (outcome === "accepted" && this.options.lookupUserRow !== undefined && row === undefined) return;
        } else {
          const recorded = await this.options.outcomeStore.record(request.accountId, request.key, "overloaded");
          if (task.cancelled || this.disposed) {
            if (recorded.status === "recorded") await recorded.write.rollback();
            return;
          }
          if (recorded.status !== "recorded") return;
          if (recorded.durability !== "durable") {
            await recorded.write.rollback();
            return;
          }
          recorded.write.commit();
          outcome = "overloaded";
        }
      }
      // New correlations may join while an async result send is pending. Drain
      // them here before releasing the claim; no source frame is captured.
      for (const correlation of task.correlations) {
        if (task.cancelled || this.disposed) return;
        if (outcome === "overloaded") await this.options.sendRejected(correlation);
        else {
          const echo = this.committedEchoFor(correlation, row);
          const acked = await (outcome === "cancelled"
            ? this.options.sendAck(correlation, echo, true)
            : echo ? this.options.sendAck(correlation, echo) : this.options.sendAck(correlation));
          if (request.recoverCancelled && !task.cancelled && !this.disposed && acked) {
            this.options.onCancelledRecovered?.(correlation);
          }
        }
      }
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

  /** Echo only an explicitly supplied, usable random_id, even when it equals id. */
  private committedEchoFor(
    request: OverflowResolutionRequest,
    row: { messageId: string; seq: number } | undefined,
  ): Array<{ random_id: string; messageId: string; seq: number }> | undefined {
    if (row === undefined || request.randomId === undefined) return undefined;
    return [{ random_id: request.randomId, messageId: row.messageId, seq: row.seq }];
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
