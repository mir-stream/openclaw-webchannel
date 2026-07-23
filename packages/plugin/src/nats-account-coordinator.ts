import { createHash } from "node:crypto";

import {
  formatAccountIdForLog,
  RemovedAudienceConfigError,
} from "./account-config.js";
import {
  NatsConnectionClosedError,
  NatsHandshakeTimeoutError,
  NatsLifecycleAbortError,
  NatsServerError,
  NatsUnexpectedResponseError,
  type TransportCloseReport,
} from "./nats-transport.js";
import { JwksLifecycleAbortError } from "./jwks.js";

export type AccountStartupFailureKind = "transient" | "permanent" | "aborted" | "unknown";
export type AccountStartupPhase = "preflight" | "dns" | "websocket" | "tls" | "nats-auth" | "nats-protocol" | "wiring";
export type AccountStartupFailure = {
  kind: AccountStartupFailureKind;
  code: string;
  phase: AccountStartupPhase;
  cause: unknown;
  operatorMessage: string;
};

export type DisposeReport = {
  errors: Array<{ phase: string; error: unknown }>;
  transport: TransportCloseReport;
};

export type AttemptAbortScope = {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  dispose: () => void;
};

/** One attempt-local signal linked to its host signal, with explicit listener cleanup. */
export function createAttemptAbortScope(hostSignal: AbortSignal): AttemptAbortScope {
  const controller = new AbortController();
  let disposed = false;
  const onHostAbort = () => controller.abort(hostSignal.reason);
  hostSignal.addEventListener("abort", onHostAbort, { once: true });
  if (hostSignal.aborted) onHostAbort();
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      hostSignal.removeEventListener("abort", onHostAbort);
      if (!controller.signal.aborted) controller.abort(new NatsLifecycleAbortError());
    },
  };
}

export class AccountRunFailure extends Error {
  constructor(message: string, public readonly closeReport: TransportCloseReport, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "AccountRunFailure";
  }
}

export class AccountStartupError extends Error {
  constructor(public readonly failure: AccountStartupFailure) {
    super(failure.operatorMessage, { cause: failure.cause });
    this.name = "AccountStartupError";
  }
}

/** Stable, control-safe, per-generation permanent-failure reporting. */
export class AccountPermanentFailureReporter {
  private readonly reported = new Set<string>();

  report(input: {
    generation: number;
    accountId: string;
    code: string;
    operatorMessage: string;
    attempt?: number;
    logger?: { error?: (message: string) => void };
  }): boolean {
    // The first permanent failure in one config generation owns remediation.
    // Replacement tasks for that same account/generation remain silent even if
    // they discover a different terminal code later.
    const key = JSON.stringify([input.generation, input.accountId]);
    if (this.reported.has(key)) return false;
    this.reported.add(key);
    const code = input.code.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
    const message =
      `event=webchannel.account_startup accountId=${formatAccountIdForLog(input.accountId)} ` +
      `state=permanent_skip attempt=${input.attempt ?? 0} code=${code} ` +
      `detail=${JSON.stringify(input.operatorMessage)}`;
    try {
      (input.logger?.error ?? console.error)(message);
    } catch {
      try { console.error(message); } catch { /* diagnostics never own lifecycle */ }
    }
    return true;
  }
}

const TRANSIENT_CODES = new Set([
  "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ENETDOWN", "EHOSTDOWN", "ECONNABORTED", "ETIMEDOUT",
  "ESOCKETTIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT",
]);
const TLS_PERMANENT_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_SIGNATURE_FAILURE", "ERR_TLS_INVALID_PROTOCOL_VERSION",
]);
const TRANSIENT_CLOSE_CODES = new Set([0, 1000, 1001, 1005, 1006, 1011, 1012, 1013, 1014]);
const PERMANENT_CLOSE_CODES = new Set([1002, 1003, 1007, 1009, 1010]);

function startupCloseLabel(code: number): string {
  if (code === 0 || code === 1005) return "no-status";
  if (code === 1000) return "normal-closure";
  if (code === 1001) return "going-away";
  if (code === 1002) return "protocol-error";
  if (code === 1003) return "unsupported-data";
  if (code === 1006) return "abnormal-closure";
  if (code === 1007) return "invalid-payload";
  if (code === 1008) return "policy-violation";
  if (code === 1009) return "message-too-big";
  if (code === 1010) return "missing-extension";
  if (code === 1011) return "server-error";
  if (code === 1012) return "service-restart";
  if (code === 1013) return "try-again-later";
  if (code === 1014) return "bad-gateway";
  return "unmapped";
}

export function classifyAccountStartupFailure(cause: unknown, phase: AccountStartupPhase = "websocket"): AccountStartupFailure {
  if (cause instanceof AccountStartupError) return cause.failure;
  if (cause instanceof RemovedAudienceConfigError) {
    return {
      kind: "permanent",
      code: "audience-override-removed",
      phase: "preflight",
      cause,
      operatorMessage: cause.message,
    };
  }
  if (cause instanceof NatsLifecycleAbortError || cause instanceof JwksLifecycleAbortError ||
      (cause instanceof DOMException && cause.name === "AbortError")) {
    return { kind: "aborted", code: "lifecycle-aborted", phase, cause, operatorMessage: "account startup aborted" };
  }
  if (cause instanceof NatsHandshakeTimeoutError) {
    return { kind: "transient", code: "handshake-timeout", phase: "websocket", cause, operatorMessage: "NATS handshake timed out" };
  }
  if (cause instanceof NatsUnexpectedResponseError) {
    const transient = cause.statusCode === 408 || cause.statusCode === 425 || cause.statusCode === 429 || cause.statusCode >= 500;
    return { kind: transient ? "transient" : "permanent", code: `http-upgrade-${cause.statusCode}`, phase: "websocket", cause, operatorMessage: `relay WebSocket upgrade failed (HTTP ${cause.statusCode})` };
  }
  if (cause instanceof NatsConnectionClosedError) {
    const closeCode = cause.closeCode || 1005;
    const kind = TRANSIENT_CLOSE_CODES.has(cause.closeCode)
      ? "transient"
      : PERMANENT_CLOSE_CODES.has(cause.closeCode) ? "permanent" : "unknown";
    return { kind, code: `websocket-close-${closeCode}`, phase: "websocket", cause, operatorMessage: `relay WebSocket closed during startup (code=${closeCode}, label=${startupCloseLabel(closeCode)}, reasonPresent=${cause.reasonPresent})` };
  }
  if (cause instanceof NatsServerError) {
    if (cause.code === "authentication-timeout") return { kind: "transient", code: cause.code, phase: "nats-auth", cause, operatorMessage: "NATS authentication timed out" };
    if (cause.code === "authorization-violation" || cause.code === "credentials-expired") return { kind: "permanent", code: cause.code, phase: "nats-auth", cause, operatorMessage: `NATS rejected account credentials (${cause.code})` };
    return { kind: cause.code === "protocol-error" ? "permanent" : "unknown", code: cause.code, phase: "nats-protocol", cause, operatorMessage: "NATS server rejected the startup protocol" };
  }
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code?: unknown }).code) : "";
  if (code === "ERR_INVALID_URL") return { kind: "permanent", code: "invalid-relay-url", phase: "preflight", cause, operatorMessage: "relay WebSocket URL is invalid" };
  if (code === "NATS_CREDENTIAL_INVALID") return { kind: "permanent", code: "nats-credential-invalid", phase: "preflight", cause, operatorMessage: "NATS credential material is invalid; re-enroll the account" };
  if (TRANSIENT_CODES.has(code)) return { kind: "transient", code: code.toLowerCase(), phase: code.startsWith("EAI") || code === "ENOTFOUND" ? "dns" : "websocket", cause, operatorMessage: `relay connection unavailable (${code})` };
  if (TLS_PERMANENT_CODES.has(code)) return { kind: "permanent", code: code.toLowerCase(), phase: "tls", cause, operatorMessage: `relay TLS validation failed (${code})` };
  if (/TLS|SSL/.test(code) && /TIMEOUT|RESET|EOF/.test(code)) return { kind: "transient", code: code.toLowerCase(), phase: "tls", cause, operatorMessage: `relay TLS connection was interrupted (${code})` };
  return { kind: "unknown", code: "unknown-startup-failure", phase, cause, operatorMessage: "account startup failed for an unclassified reason" };
}

export function retryCeilingMs(failedAttempts: number): number {
  if (failedAttempts <= 1) return 1_000;
  return Math.min(60_000, 1_000 * 2 ** Math.min(30, failedAttempts - 1));
}

export function fullJitterDelayMs(failedAttempts: number, random: () => number = Math.random): number {
  const ceiling = retryCeilingMs(failedAttempts);
  return Math.floor(Math.max(0, Math.min(0.999999999999, random())) * ceiling);
}

export function shouldLogRetryAttempt(failedAttempts: number): boolean {
  return failedAttempts === 1 || (failedAttempts > 0 && failedAttempts % 10 === 0);
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new NatsLifecycleAbortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(new NatsLifecycleAbortError()); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function formatRelayOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch { return "[invalid-relay-url]"; }
}

export function selectPrimaryRuntime<T>(runtimes: ReadonlyMap<string, T>): T | undefined {
  return runtimes.get("default") ?? [...runtimes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
}

export type AccountAttemptOutcome =
  | { kind: "completed"; closeReport?: TransportCloseReport }
  | { kind: "failed"; cause: unknown; closeReport?: TransportCloseReport };

export type AccountAttemptContext = {
  attempt: number;
  failedAttempts: number;
  markCommitted: () => void;
};

export type AccountStartupLoopOptions = {
  signal: AbortSignal;
  attempt: (context: AccountAttemptContext) => Promise<AccountAttemptOutcome>;
  random?: () => number;
  now?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  waitForAbort?: (signal: AbortSignal) => Promise<void>;
  onRetryScheduled?: (event: { failure: AccountStartupFailure; failedAttempts: number; delayMs: number }) => void;
  onRecovered?: (event: { attempt: number; failedAttempts: number; outageMs: number }) => void;
  onTerminal?: (event: { failure: AccountStartupFailure; failedAttempts: number; quarantined: boolean }) => void;
};

export type PrivateReadinessResult<T> =
  | { kind: "ready"; value: T }
  | { kind: "aborted"; closeReport: TransportCloseReport };

/**
 * Keep lifecycle abort transactional while private readiness I/O is pending.
 * Abort wins the fence, awaits the caller's shared full disposer, and prevents
 * a non-cooperative late result from reaching commit code.
 */
export async function resolvePrivateReadiness<T>(options: {
  signal: AbortSignal;
  resolve: (signal: AbortSignal) => Promise<T>;
  dispose: () => Promise<DisposeReport>;
}): Promise<PrivateReadinessResult<T>> {
  if (options.signal.aborted) {
    return { kind: "aborted", closeReport: (await options.dispose()).transport };
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new NatsLifecycleAbortError());
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
  try {
    const value = await Promise.race([options.resolve(options.signal), aborted]);
    if (options.signal.aborted) {
      return { kind: "aborted", closeReport: (await options.dispose()).transport };
    }
    return { kind: "ready", value };
  } catch (cause) {
    if (options.signal.aborted || classifyAccountStartupFailure(cause, "wiring").kind === "aborted") {
      return { kind: "aborted", closeReport: (await options.dispose()).transport };
    }
    throw cause;
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Execute the synchronous publication/status fence. Failure rolls publication
 * back synchronously, then returns a promise which rejects only after disposal.
 */
export function commitAccountPublication<T>(options: {
  publish: () => T;
  writeServingStatus: () => void;
  rollback: () => void;
  dispose: () => Promise<DisposeReport>;
  /** Captures private-loss provenance synchronously, before rollback/disposal mutates it. */
  captureFailureState?: (cause: unknown) => void;
}): T | Promise<never> {
  try {
    const publication = options.publish();
    options.writeServingStatus();
    return publication;
  } catch (cause) {
    try { options.captureFailureState?.(cause); } catch { /* preserve the publication failure */ }
    try { options.rollback(); } catch { /* disposal still owns final cleanup */ }
    return options.dispose().then(
      () => { throw cause; },
      (disposeCause) => { throw disposeCause; },
    );
  }
}

export type AccountPublicationFailureState = {
  poisoned: boolean;
  privateFailure: unknown;
  connected: boolean;
};

/** Preserve the distinction between a private disconnect and a commit invariant failure. */
export function resolveAccountPublicationFailure(options: {
  state: AccountPublicationFailureState;
  cause: unknown;
  closeReport: TransportCloseReport;
}): Extract<AccountAttemptOutcome, { kind: "failed" }> {
  if (options.state.poisoned || options.state.privateFailure !== undefined || !options.state.connected) {
    return {
      kind: "failed",
      cause: options.state.privateFailure ?? new NatsConnectionClosedError(1006, false),
      closeReport: options.closeReport,
    };
  }
  throw new AccountRunFailure("account publication invariant failed", options.closeReport, { cause: options.cause });
}

type AccountTransportEventSurface = {
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  off: (event: string, listener: (...args: any[]) => void) => unknown;
};

export type AccountTransportListeners = {
  connect: () => void;
  disconnect: (cause?: unknown) => void;
  reconnect: () => void;
  error: (error: Error) => void;
};

/** Install attempt ownership at transport handoff and return idempotent cleanup. */
export function attachAccountTransportListeners(
  transport: AccountTransportEventSurface,
  listeners: AccountTransportListeners,
): () => void {
  let attached = 0;
  let detached = false;
  const entries = [
    ["connect", listeners.connect],
    ["disconnect", listeners.disconnect],
    ["reconnect", listeners.reconnect],
    ["error", listeners.error],
  ] as const;
  try {
    for (const [event, listener] of entries) {
      transport.on(event, listener);
      attached++;
    }
  } catch (cause) {
    for (let i = attached - 1; i >= 0; i--) {
      try { transport.off(entries[i]![0], entries[i]![1]); } catch { /* preserve attachment failure */ }
    }
    throw cause;
  }
  return () => {
    if (detached) return;
    detached = true;
    const failures: unknown[] = [];
    for (const [event, listener] of entries) {
      try { transport.off(event, listener); } catch (cause) { failures.push(cause); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "failed to detach account transport listeners");
  };
}

export type AccountTransportStatusPatch = Record<string, unknown>;

/** Status ownership policy for live private transport events. */
export function accountTransportStatusPatch(
  event: "disconnect" | "reconnect" | "error",
  now: () => number = Date.now,
): AccountTransportStatusPatch {
  if (event === "disconnect") {
    return {
      connected: false,
      restartPending: true,
      lastDisconnect: { at: now(), error: "relay disconnected" },
      lastError: "relay disconnected; reconnect pending",
    };
  }
  if (event === "reconnect") {
    return {
      connected: true,
      restartPending: false,
      reconnectAttempts: 0,
      lastConnectedAt: now(),
      lastError: null,
    };
  }
  // An error event alone neither closes the socket nor schedules reconnect.
  // The disconnect event owns the disconnected/restart-pending transition.
  return { lastError: "NATS transport error observed" };
}

export type AccountQuarantineDiagnosticInput = {
  accountId: string;
  generation: number;
  setStatus?: (status: Record<string, unknown>) => void;
  logger?: { warn?: (message: string) => void };
};

/** Diagnostic-only quarantine status/log transition; never owns lifecycle. */
export function notifyAccountQuarantine(input: AccountQuarantineDiagnosticInput): void {
  const lastError = "transport closure could not be confirmed; account quarantined; restart the gateway after confirming the relay socket is closed";
  try {
    input.setStatus?.({
      connected: false,
      restartPending: false,
      lastError,
    });
  } catch { /* status diagnostics cannot affect lease release */ }
  const message =
    `event=webchannel.account_quarantine accountId=${formatAccountIdForLog(input.accountId)} ` +
    `generation=${input.generation} state=quarantined code=transport-close-unconfirmed ` +
    `detail=${JSON.stringify(lastError)}`;
  try {
    (input.logger?.warn ?? console.warn)(message);
  } catch {
    try { console.warn(message); } catch { /* logging cannot affect quarantine */ }
  }
}

/** One owner-local loop covering dial, private wiring, the pre-commit fence, and backoff. */
export async function runAccountStartupLoop(options: AccountStartupLoopOptions): Promise<TransportCloseReport | undefined> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? abortableDelay;
  const wait = options.waitForAbort ?? waitForAbort;
  const outageStartedAt = now();
  let failedAttempts = 0;

  for (;;) {
    if (options.signal.aborted) return undefined;
    let committed = false;
    const markCommitted = () => {
      if (committed) return;
      committed = true;
      if (failedAttempts > 0) {
        try {
          options.onRecovered?.({
            attempt: failedAttempts + 1,
            failedAttempts,
            outageMs: Math.max(0, now() - outageStartedAt),
          });
        } catch { /* observers are diagnostic-only */ }
      }
    };

    let outcome: AccountAttemptOutcome;
    try {
      outcome = await options.attempt({ attempt: failedAttempts + 1, failedAttempts, markCommitted });
    } catch (cause) {
      if (cause instanceof AccountRunFailure) throw cause;
      outcome = { kind: "failed", cause };
    }
    if (outcome.kind === "completed") return outcome.closeReport;

    const failure = classifyAccountStartupFailure(outcome.cause);
    if (failure.kind === "aborted" || options.signal.aborted) return outcome.closeReport;
    failedAttempts++;

    const closeConfirmed = !outcome.closeReport ||
      (outcome.closeReport.reconnectSuppressed && outcome.closeReport.socketClosed);
    if (!closeConfirmed) {
      try { options.onTerminal?.({ failure, failedAttempts, quarantined: true }); }
      catch { /* observers are diagnostic-only */ }
      return outcome.closeReport;
    }

    if (failure.kind !== "transient") {
      try { options.onTerminal?.({ failure, failedAttempts, quarantined: false }); }
      catch { /* observers are diagnostic-only */ }
      await wait(options.signal);
      return outcome.closeReport;
    }

    const delayMs = fullJitterDelayMs(failedAttempts, options.random);
    try { options.onRetryScheduled?.({ failure, failedAttempts, delayMs }); }
    catch { /* observers are diagnostic-only */ }
    try {
      await delay(delayMs, options.signal);
    } catch (cause) {
      if (classifyAccountStartupFailure(cause).kind !== "aborted") throw cause;
      return outcome.closeReport;
    }
  }
}

export type ServingAggregateCategory = "zero" | "partial" | "complete";
export type ServingAggregateTransition = {
  generation: number;
  category: ServingAggregateCategory;
  servingCount: number;
  totalCount: number;
};

/** Tracks the newest config generation while allowing stale cleanup to refresh actual serving counts. */
export class AccountServingAggregateTracker {
  private generation = 0;
  private expected = new Set<string>();
  private lastCategory: ServingAggregateCategory | undefined;
  private logger: { info?: (message: string) => void } | undefined;

  update(input: {
    generation: number;
    expectedAccountIds: Iterable<string>;
    servingAccountIds: Iterable<string>;
    logger?: { info?: (message: string) => void };
  }): ServingAggregateTransition | undefined {
    if (input.generation > this.generation) {
      this.generation = input.generation;
      this.expected = new Set(input.expectedAccountIds);
      this.logger = input.logger;
      this.lastCategory = undefined;
    } else if (input.generation === this.generation) {
      this.expected = new Set(input.expectedAccountIds);
      this.logger = input.logger ?? this.logger;
    } else if (this.generation === 0) {
      return undefined;
    }

    const serving = new Set(input.servingAccountIds);
    let servingCount = 0;
    for (const accountId of this.expected) if (serving.has(accountId)) servingCount++;
    const totalCount = this.expected.size;
    const category: ServingAggregateCategory = servingCount === 0
      ? "zero"
      : servingCount >= totalCount ? "complete" : "partial";
    if (category === this.lastCategory) return undefined;
    this.lastCategory = category;
    const transition = { generation: this.generation, category, servingCount, totalCount };
    const message = `event=webchannel.account_aggregate generation=${transition.generation} state=${category} servingCount=${servingCount} totalCount=${totalCount}`;
    try { (this.logger?.info ?? console.log)(message); } catch { /* diagnostics never own lifecycle */ }
    return transition;
  }
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AccountStartupError({ kind: "unknown", code: "host-config-invariant", phase: "preflight", cause: value, operatorMessage: "host supplied non-JSON configuration" });
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new AccountStartupError({ kind: "unknown", code: "host-config-cycle", phase: "preflight", cause: value, operatorMessage: "host supplied cyclic configuration" });
    seen.add(value); const result = `[${value.map((v) => canonicalJson(v, seen)).join(",")}]`; seen.delete(value); return result;
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) throw new AccountStartupError({ kind: "unknown", code: "host-config-cycle", phase: "preflight", cause: value, operatorMessage: "host supplied cyclic configuration" });
    seen.add(value);
    const result = `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], seen)}`).join(",")}}`;
    seen.delete(value); return result;
  }
  throw new AccountStartupError({ kind: "unknown", code: "host-config-invariant", phase: "preflight", cause: value, operatorMessage: "host supplied non-JSON configuration" });
}

export type FullInstall = {
  generation: number;
  fingerprint: string;
  runtime: unknown;
  logger: any;
};

export function createAccountExecutionApi<TConfig>(install: FullInstall, cfg: TConfig): {
  runtime: unknown;
  logger: any;
  config: TConfig;
  generation: number;
} {
  return {
    runtime: install.runtime,
    logger: install.logger,
    config: cfg,
    generation: install.generation,
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Owner = { install: FullInstall; arrival: number; signal: AbortSignal; released: Deferred<void> };
type Waiter = { install: FullInstall; arrival: number; signal: AbortSignal; grant: Deferred<Owner | undefined> };
type AccountSlot = {
  owner?: Owner;
  waiters: Waiter[];
  highestGeneration: number;
  nextArrival: number;
  quarantine?: {
    probeCutoffArrival: number;
    probing: boolean;
    probePhysicalClose: () => Promise<TransportCloseReport>;
  };
};

export type AccountRunResult = {
  closeReport?: TransportCloseReport;
  probePhysicalClose?: () => Promise<TransportCloseReport>;
} | void;

export type AccountQuarantineEvent = {
  accountId: string;
  generation: number;
  logger: FullInstall["logger"];
};

/** Structural install token plus per-account synchronous lease serialization. */
export class NatsAccountRuntimeCoordinator {
  private install: FullInstall | undefined;
  private nextGeneration = 0;
  private readonly slots = new Map<string, AccountSlot>();

  installFull(api: { registrationMode?: string; config: unknown; runtime: unknown; logger: unknown }): FullInstall | undefined {
    if (api.registrationMode !== "full") return this.install;
    const fingerprint = createHash("sha256").update(canonicalJson(api.config)).digest("hex");
    const generation = this.install?.fingerprint === fingerprint ? this.install.generation : ++this.nextGeneration;
    this.install = { generation, fingerprint, runtime: api.runtime, logger: api.logger };
    return this.install;
  }

  currentInstall(): FullInstall | undefined { return this.install; }

  /** Test/diagnostic snapshot; contains no config, credentials, or handles. */
  inspectAccountState(accountId: string): { owner: boolean; waiters: number; quarantined: boolean; probing: boolean } | undefined {
    const slot = this.slots.get(accountId);
    if (!slot) return undefined;
    return {
      owner: slot.owner !== undefined,
      waiters: slot.waiters.length,
      quarantined: slot.quarantine !== undefined,
      probing: slot.quarantine?.probing ?? false,
    };
  }

  async runAccount(
    accountId: string,
    hostSignal: AbortSignal,
    run: (owner: Owner, install: FullInstall) => Promise<AccountRunResult>,
    onQuarantine?: (event: AccountQuarantineEvent) => void,
  ): Promise<void> {
    const install = this.install;
    if (!install) throw new AccountStartupError({ kind: "unknown", code: "host-full-registration-missing", phase: "preflight", cause: null, operatorMessage: "full plugin registration has not completed" });
    const slot = this.slots.get(accountId) ?? { waiters: [], highestGeneration: 0, nextArrival: 0 };
    this.slots.set(accountId, slot);
    const arrival = ++slot.nextArrival;
    slot.highestGeneration = Math.max(slot.highestGeneration, install.generation);
    let owner: Owner;
    if (!slot.owner && !slot.quarantine) {
      owner = { install, arrival, signal: hostSignal, released: deferred<void>() };
      slot.owner = owner;
    } else {
      const waiter: Waiter = { install, arrival, signal: hostSignal, grant: deferred<Owner | undefined>() };
      slot.waiters.push(waiter);
      this.maybeProbe(accountId, slot, waiter);
      const granted = await this.awaitGrant(accountId, slot, waiter);
      if (!granted) return;
      owner = granted;
    }
    if (hostSignal.aborted) {
      this.releaseUnstartedOwner(accountId, slot, owner);
      return;
    }

    for (;;) {
      let canPromote = true;
      let result: AccountRunResult = undefined;
      let runError: unknown;
      try {
        result = await run(owner, owner.install);
        if (result?.closeReport) canPromote = result.closeReport.reconnectSuppressed && result.closeReport.socketClosed;
      } catch (error) {
        runError = error;
        canPromote = false;
        if (error instanceof AccountRunFailure) {
          result = {
            closeReport: error.closeReport,
            ...(error.closeReport.closeHandle ? { probePhysicalClose: error.closeReport.closeHandle.probe } : {}),
          };
          canPromote = error.closeReport.reconnectSuppressed && error.closeReport.socketClosed;
        }
      }

      let selfWaiter: Waiter | undefined;
      if (canPromote) {
        if (slot.owner === owner) slot.owner = undefined;
        owner.released.resolve();
        this.promote(slot);
      } else {
        const unconfirmed = result?.closeReport ?? {
          reconnectSuppressed: true,
          socketClosed: false,
          forcedTerminationAttempted: false,
          gracefulTimedOut: false,
        };
        slot.quarantine = {
          probeCutoffArrival: slot.nextArrival,
          probing: false,
          probePhysicalClose: result?.probePhysicalClose ?? (async () => unconfirmed),
        };
        // Invoke the callback while this owner still holds the slot fence. The
        // callback is diagnostic-only, and cannot prevent release/quarantine.
        if (slot.owner === owner) {
          try {
            onQuarantine?.({
              accountId,
              generation: owner.install.generation,
              logger: owner.install.logger,
            });
          }
          catch { /* diagnostics never own coordinator lifecycle */ }
          slot.owner = undefined;
        }
        owner.released.resolve();
        if (!hostSignal.aborted) {
          const retainedWaiter: Waiter = {
            install: owner.install,
            arrival: owner.arrival,
            signal: hostSignal,
            grant: deferred<Owner | undefined>(),
          };
          selfWaiter = retainedWaiter;
          slot.waiters.push(retainedWaiter);
        }
      }

      // An unconfirmed physical close must not manufacture an early lifecycle
      // exit. Keep this invocation represented by its original arrival token;
      // only a strictly later host invocation may probe the retained socket.
      if (selfWaiter) {
        const granted = await this.awaitGrant(accountId, slot, selfWaiter);
        if (!granted) return;
        owner = granted;
        if (hostSignal.aborted) {
          this.releaseUnstartedOwner(accountId, slot, owner);
          return;
        }
        continue;
      }
      this.cleanupSlot(accountId, slot);
      if (runError !== undefined) throw runError;
      return;
    }
  }

  private async awaitGrant(accountId: string, slot: AccountSlot, waiter: Waiter): Promise<Owner | undefined> {
    const removeWaiter = () => {
      slot.waiters = slot.waiters.filter((candidate) => candidate !== waiter);
      this.cleanupSlot(accountId, slot);
    };
    if (waiter.signal.aborted) {
      removeWaiter();
      return undefined;
    }
    const onAbort = () => {
      removeWaiter();
      waiter.grant.resolve(undefined);
    };
    waiter.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const owner = await waiter.grant.promise;
      return owner || undefined;
    }
    finally { waiter.signal.removeEventListener("abort", onAbort); }
  }

  private releaseUnstartedOwner(accountId: string, slot: AccountSlot, owner: Owner): void {
    if (slot.owner === owner) slot.owner = undefined;
    owner.released.resolve();
    this.promote(slot);
    this.cleanupSlot(accountId, slot);
  }

  private maybeProbe(accountId: string, slot: AccountSlot, waiter: Waiter): void {
    const quarantine = slot.quarantine;
    if (!quarantine || quarantine.probing || waiter.signal.aborted || waiter.arrival <= quarantine.probeCutoffArrival) return;
    quarantine.probing = true;
    void quarantine.probePhysicalClose().then(
      (report) => {
        if (slot.quarantine !== quarantine) return;
        quarantine.probing = false;
        if (report.reconnectSuppressed && report.socketClosed) {
          slot.quarantine = undefined;
          this.promote(slot);
        } else quarantine.probeCutoffArrival = slot.nextArrival;
        this.cleanupSlot(accountId, slot);
      },
      () => {
        if (slot.quarantine === quarantine) {
          quarantine.probing = false;
          quarantine.probeCutoffArrival = slot.nextArrival;
          this.cleanupSlot(accountId, slot);
        }
      },
    );
  }

  private promote(slot: AccountSlot): void {
    slot.waiters = slot.waiters.filter((waiter) => !waiter.signal.aborted);
    const eligible = slot.waiters.filter((w) => !w.signal.aborted && w.install.generation >= slot.highestGeneration);
    eligible.sort((a, b) => b.install.generation - a.install.generation || a.arrival - b.arrival);
    const selected = eligible[0];
    if (!selected) return;
    slot.waiters = slot.waiters.filter((w) => w !== selected);
    const owner = { install: selected.install, arrival: selected.arrival, signal: selected.signal, released: deferred<void>() };
    slot.owner = owner;
    selected.grant.resolve(owner);
  }

  private cleanupSlot(accountId: string, slot: AccountSlot): void {
    if (!slot.owner && !slot.quarantine && slot.waiters.length === 0 && this.slots.get(accountId) === slot) {
      this.slots.delete(accountId);
    }
  }
}
