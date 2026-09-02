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
  sendAck(request: OverflowResolutionRequest): boolean | Promise<boolean>;
  sendRejected(request: OverflowResolutionRequest): boolean | Promise<boolean>;
  onCancelledRecovered?(request: OverflowResolutionRequest): void;
  maxTasks?: number;
  maxMetadataBytes?: number;
};

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
        // #344: `overloaded` is the only outcome that publishes a refusal;
        // `cancelled` acks, exactly as it did while it was spelled `accepted`.
        if (known.outcome === "overloaded") await this.options.sendRejected(request);
        else await this.options.sendAck(request);
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
