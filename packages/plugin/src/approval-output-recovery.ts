import type { ApprovalDecision, ApprovalRequestPayload, ApprovalResolutionSendOptions, ApprovalResolutionSendResult } from "./channel-contract.js";

// Active-runtime output recovery, separate from the gateway's decided action.
// One initial attempt plus three retries; the backoff totals 36 seconds.
export const APPROVAL_OUTPUT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
export const APPROVAL_OUTPUT_PENDING_CAP = 512;
export const APPROVAL_OUTPUT_PENDING_BYTES = 2 * 1024 * 1024;
export const APPROVAL_OUTPUT_RETRY_BATCH = 16;

type Output = {
  readonly id: string;
  readonly peerId: string;
  readonly decision: ApprovalDecision;
  request?: ApprovalRequestPayload;
  signal?: AbortSignal;
  status: Exclude<ApprovalResolutionSendResult["status"], "conflict">;
  attempts: number;
  retryAt: number;
  bytes: number;
};
type FailureReason = "storage" | "exhausted" | "capacity" | "disposed" | "aborted";

/** Owns immutable first decisions, owed request payloads and one retry timer.
 * All writers are synchronous: claiming precedes IO and a repeated call joins
 * pending work without spending another attempt. Failed-work eviction leaves a
 * small first-winner tombstone until the ordinary resolution-cache cap evicts it.
 */
export class ApprovalOutputRecovery {
  private readonly outputs = new Map<string, Output>();
  private readonly pending = new Map<string, Output>();
  private readonly signals = new Map<AbortSignal, { ids: Set<string>; abort: () => void }>();
  private retainedBytes = 0;
  private abandoned = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: {
    maxResolutions: number;
    hasJournal: boolean;
    journalRequest: (peerId: string, request: ApprovalRequestPayload) => void;
    sendResolution: (peerId: string, id: string, decision: ApprovalDecision, journal: boolean) => { delivered: boolean; journaled: boolean };
    onFailure: (id: string, reason: FailureReason, attempts: number) => void;
  }) {}

  send(peerId: string, id: string, decision: ApprovalDecision, options?: ApprovalResolutionSendOptions): ApprovalResolutionSendResult {
    if (this.disposed || options?.abortSignal?.aborted) return { accepted: false, delivered: false, journaled: false, status: "unavailable" };
    const existing = this.outputs.get(id);
    if (existing) {
      if (existing.peerId !== peerId || existing.decision !== decision) return { accepted: false, delivered: false, journaled: false, status: "conflict" };
      options?.onClaim?.();
      // Only an already accepted row may be pushed again. In particular an
      // alternate request payload cannot replace a failed first attempt.
      const delivered = existing.status === "journaled" || existing.status === "unavailable"
        ? this.deps.sendResolution(peerId, id, existing.decision, false).delivered : false;
      return this.result(existing, delivered);
    }
    const output: Output = {
      peerId, id, decision, status: "pending", attempts: 0, retryAt: 0, bytes: 0,
      request: options?.journalRequestFirst ? structuredClone(options.journalRequestFirst) : undefined,
      signal: options?.abortSignal,
    };
    // Identity comes from the delivered entry, never from a later payload.
    if (output.request) output.request.id = id;
    this.outputs.set(id, output);
    while (this.outputs.size > this.deps.maxResolutions) {
      const oldest = this.outputs.values().next().value as Output;
      if (this.pending.has(oldest.id)) this.abandon(oldest, "capacity");
      this.outputs.delete(oldest.id);
    }
    options?.onClaim?.();
    const result = this.attempt(output);
    this.schedule();
    return result;
  }

  private result(output: Output, delivered = false): ApprovalResolutionSendResult {
    return { accepted: true, delivered, journaled: output.status === "journaled", status: output.status };
  }

  private attempt(output: Output): ApprovalResolutionSendResult {
    if (this.disposed || output.signal?.aborted) {
      this.abandon(output, this.disposed ? "disposed" : "aborted");
      return this.result(output);
    }
    output.attempts++;
    try {
      if (this.deps.hasJournal && output.request) {
        this.deps.journalRequest(output.peerId, output.request);
        output.request = undefined; // A committed request is never written twice.
      }
      const result = this.deps.sendResolution(output.peerId, output.id, output.decision, this.deps.hasJournal);
      if (this.deps.hasJournal && !result.journaled) throw new Error("Approval journal did not accept output");
      output.status = result.journaled ? "journaled" : "unavailable";
      this.release(output);
      output.request = undefined;
      return this.result(output, result.delivered);
    } catch {
      output.status = output.attempts > APPROVAL_OUTPUT_RETRY_DELAYS_MS.length ? "exhausted" : "pending";
      output.retryAt = Date.now() + (APPROVAL_OUTPUT_RETRY_DELAYS_MS[output.attempts - 1] ?? 0);
      if (!this.pending.has(output.id)) {
        output.bytes = Buffer.byteLength(JSON.stringify([output.id, output.peerId, output.decision, output.request]), "utf8");
        if (output.bytes > APPROVAL_OUTPUT_PENDING_BYTES) {
          this.abandon(output, "capacity");
          return this.result(output);
        }
        while (this.pending.size >= APPROVAL_OUTPUT_PENDING_CAP || this.retainedBytes + output.bytes > APPROVAL_OUTPUT_PENDING_BYTES) {
          this.abandon(this.pending.values().next().value as Output, "capacity");
        }
        this.pending.set(output.id, output);
        this.retainedBytes += output.bytes;
        this.watchAbort(output);
      }
      if (output.attempts === 1 || output.status === "exhausted") this.reportFailure(output, output.status === "exhausted" ? "exhausted" : "storage");
      return this.result(output);
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    let next = Infinity;
    for (const output of this.pending.values()) if (output.status === "pending") next = Math.min(next, output.retryAt);
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => {
      if (this.disposed || this.timer !== timer) return;
      this.timer = undefined;
      let remaining = APPROVAL_OUTPUT_RETRY_BATCH;
      for (const output of this.pending.values()) {
        if (output.status !== "pending" || output.retryAt > Date.now()) continue;
        this.attempt(output);
        if (--remaining === 0) break;
      }
      this.schedule();
    }, Math.max(0, next - Date.now()));
    timer.unref?.();
    this.timer = timer;
  }

  private watchAbort(output: Output): void {
    const signal = output.signal;
    if (!signal) return;
    let group = this.signals.get(signal);
    if (!group) {
      const ids = new Set<string>();
      const abort = () => {
        for (const id of [...ids]) {
          const current = this.pending.get(id);
          if (current?.signal === signal) this.abandon(current, "aborted");
        }
        this.schedule();
      };
      group = { ids, abort };
      this.signals.set(signal, group);
      signal.addEventListener("abort", abort, { once: true });
    }
    group.ids.add(output.id);
  }

  private release(output: Output): void {
    if (this.pending.delete(output.id)) this.retainedBytes -= output.bytes;
    const signal = output.signal;
    const group = signal && this.signals.get(signal);
    if (group && signal) {
      group.ids.delete(output.id);
      if (group.ids.size === 0) {
        signal.removeEventListener("abort", group.abort);
        this.signals.delete(signal);
      }
    }
    output.signal = undefined;
  }

  private abandon(output: Output, reason: Exclude<FailureReason, "storage" | "exhausted">): void {
    this.release(output);
    output.status = "abandoned";
    output.request = undefined;
    this.abandoned++;
    this.reportFailure(output, reason);
  }

  private reportFailure(output: Output, reason: FailureReason): void {
    try {
      this.deps.onFailure(output.id, reason, output.attempts);
    } catch {
      // Diagnostics must not interrupt scheduling or strand teardown ownership.
    }
  }

  status(): { pending: number; exhausted: number; abandoned: number; retainedBytes: number } {
    let exhausted = 0;
    for (const output of this.pending.values()) if (output.status === "exhausted") exhausted++;
    return { pending: this.pending.size - exhausted, exhausted, abandoned: this.abandoned, retainedBytes: this.retainedBytes };
  }

  resolver(id: string): string | undefined { return this.outputs.get(id)?.peerId; }
  get size(): number { return this.outputs.size; }

  /** Existing channel test-reset seam also cancels retained work. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const output of this.pending.values()) this.abandon(output, "disposed");
    this.outputs.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }
}
