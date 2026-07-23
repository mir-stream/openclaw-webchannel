import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  NatsConnectionClosedError,
  NatsHandshakeTimeoutError,
  NatsLifecycleAbortError,
  NatsServerError,
  NatsTransport,
  NatsUnexpectedResponseError,
  type TransportCloseReport,
} from "./nats-transport.js";
import { connectNatsCredentialSource } from "./nats-credential-source.js";
import {
  AccountRunFailure,
  AccountPermanentFailureReporter,
  AccountServingAggregateTracker,
  NatsAccountRuntimeCoordinator,
  accountNeverServedStatusPatch,
  accountTransportStatusPatch,
  attachAccountTransportListeners,
  classifyAccountStartupFailure,
  commitAccountPublication,
  connectedPublishedAccountIds,
  createAccountExecutionApi,
  createAttemptAbortScope,
  formatRelayOrigin,
  fullJitterDelayMs,
  notifyAccountQuarantine,
  retryCeilingMs,
  resolveAccountPublicationFailure,
  resolvePrivateReadiness,
  runAccountStartupLoop,
  selectPrimaryRuntime,
  shouldLogRetryAttempt,
} from "./nats-account-runtime.js";

class ImmediateCloseWebSocket {
  readyState: number = WebSocket.CONNECTING;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
    return this;
  }

  send(): void { /* protocol output is irrelevant to this ownership test */ }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.serverClose(1005);
  }

  terminate(): void { this.close(); }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  frame(frame: string): void { this.emit("message", frame); }

  serverClose(code: number): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from("typed-close"));
  }

  private emit(event: string, ...args: any[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

const closed = (socketClosed = true): TransportCloseReport => ({
  reconnectSuppressed: true,
  socketClosed,
  forcedTerminationAttempted: !socketClosed,
  gracefulTimedOut: !socketClosed,
});

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("account startup failure classification", () => {
  it("classifies structured DNS, HTTP, NATS, timeout, abort, and TLS failures", () => {
    expect(classifyAccountStartupFailure(Object.assign(new Error(), { code: "ENOTFOUND" })).kind).toBe("transient");
    expect(classifyAccountStartupFailure(new NatsUnexpectedResponseError(503)).kind).toBe("transient");
    expect(classifyAccountStartupFailure(new NatsUnexpectedResponseError(429)).kind).toBe("transient");
    expect(classifyAccountStartupFailure(new NatsUnexpectedResponseError(401)).kind).toBe("permanent");
    expect(classifyAccountStartupFailure(new NatsServerError("authorization-violation")).kind).toBe("permanent");
    expect(classifyAccountStartupFailure(new NatsServerError("authentication-timeout")).kind).toBe("transient");
    expect(classifyAccountStartupFailure(new NatsHandshakeTimeoutError("PONG")).kind).toBe("transient");
    expect(classifyAccountStartupFailure(new NatsLifecycleAbortError()).kind).toBe("aborted");
    expect(classifyAccountStartupFailure(Object.assign(new Error(), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })).kind).toBe("permanent");
    expect(classifyAccountStartupFailure(new Error("opaque")).kind).toBe("unknown");
  });

  it("implements the complete pre-PONG close policy without exposing the raw reason", () => {
    for (const code of [0, 1000, 1001, 1005, 1006, 1011, 1012, 1013, 1014]) {
      expect(classifyAccountStartupFailure(new NatsConnectionClosedError(code, true)).kind).toBe("transient");
    }
    for (const code of [1002, 1003, 1007, 1009, 1010]) {
      expect(classifyAccountStartupFailure(new NatsConnectionClosedError(code, true)).kind).toBe("permanent");
    }
    for (const code of [1004, 1008, 1015, 3001, 4001]) {
      const failure = classifyAccountStartupFailure(new NatsConnectionClosedError(code, true));
      expect(failure.kind).toBe("unknown");
      expect(failure.operatorMessage).not.toContain("fake-secret\n");
    }
  });

  it("uses capped full jitter and redacts relay URL components", () => {
    expect([1, 2, 3, 7, 100].map(retryCeilingMs)).toEqual([1_000, 2_000, 4_000, 60_000, 60_000]);
    expect(fullJitterDelayMs(1, () => 0)).toBe(0);
    expect(fullJitterDelayMs(1, () => 0.999999)).toBeLessThan(1_000);
    expect(formatRelayOrigin("wss://user:pass@nats.example:8443/private?q=secret#x")).toBe("wss://nats.example:8443");
    expect([1, 2, 9, 10, 11, 20].filter(shouldLogRetryAttempt)).toEqual([1, 10, 20]);
  });
});

describe("account startup attempt transaction", () => {
  it("recovers after two transient failures with one fresh jitter delay per failed attempt", async () => {
    const events: string[] = [];
    const delays: number[] = [];
    let attempts = 0;
    let clock = 10;
    const result = await runAccountStartupLoop({
      signal: new AbortController().signal,
      random: () => 0.5,
      now: () => clock,
      delay: async (ms) => { delays.push(ms); clock += ms; },
      onRetryScheduled: ({ failedAttempts }) => events.push(`retry:${failedAttempts}`),
      onRecovered: ({ attempt, failedAttempts, outageMs }) => events.push(`recovered:${attempt}:${failedAttempts}:${outageMs}`),
      attempt: async ({ markCommitted }) => {
        attempts++;
        if (attempts < 3) {
          return { kind: "failed", cause: Object.assign(new Error("down"), { code: "ECONNREFUSED" }), closeReport: closed() };
        }
        markCommitted();
        return { kind: "completed", closeReport: closed() };
      },
    });
    expect(result).toEqual(closed());
    expect(attempts).toBe(3);
    expect(delays).toEqual([500, 1_000]);
    expect(events).toEqual(["retry:1", "retry:2", "recovered:3:2:1500"]);
  });

  it("aborts during backoff without another attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const result = runAccountStartupLoop({
      signal: controller.signal,
      onRetryScheduled: () => controller.abort(),
      attempt: async () => {
        attempts++;
        return { kind: "failed", cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }), closeReport: closed() };
      },
    });
    await expect(result).resolves.toEqual(closed());
    expect(attempts).toBe(1);
  });

  it.each([
    ["permanent", new NatsServerError("authorization-violation")],
    ["unknown", new Error("opaque")],
  ])("keeps a %s failure dormant until host abort", async (_label, cause) => {
    const controller = new AbortController();
    let attempts = 0;
    const running = runAccountStartupLoop({
      signal: controller.signal,
      attempt: async () => { attempts++; return { kind: "failed", cause, closeReport: closed() }; },
    });
    await tick();
    expect(attempts).toBe(1);
    let settled = false;
    void running.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    controller.abort();
    await expect(running).resolves.toEqual(closed());
  });

  it("disposes a post-PONG private failure and retries the whole delayed-wiring attempt without recursion", async () => {
    let releaseWiring!: () => void;
    const wiring = new Promise<void>((resolve) => { releaseWiring = resolve; });
    const disposed: number[] = [];
    const delays: number[] = [];
    let attempts = 0;
    let privateFailure: unknown;
    const running = runAccountStartupLoop({
      signal: new AbortController().signal,
      random: () => 0.25,
      delay: async (ms) => { delays.push(ms); },
      attempt: async ({ markCommitted }) => {
        const current = ++attempts;
        if (current === 1) {
          await wiring;
          disposed.push(current);
          return { kind: "failed", cause: privateFailure, closeReport: closed() };
        }
        markCommitted();
        return { kind: "completed", closeReport: closed() };
      },
    });
    privateFailure = new NatsConnectionClosedError(1012, false);
    releaseWiring();
    await expect(running).resolves.toEqual(closed());
    expect({ attempts, disposed, delays }).toEqual({ attempts: 2, disposed: [1], delays: [250] });
  });

  it("contains observer failures across retry, recovery, terminal, and aggregate transitions", async () => {
    let attempts = 0;
    await expect(runAccountStartupLoop({
      signal: new AbortController().signal,
      delay: async () => {},
      onRetryScheduled: () => { throw new Error("retry observer"); },
      onRecovered: () => { throw new Error("recovered observer"); },
      attempt: async ({ markCommitted }) => {
        attempts++;
        if (attempts === 1) return { kind: "failed", cause: Object.assign(new Error(), { code: "ECONNRESET" }), closeReport: closed() };
        markCommitted();
        return { kind: "completed", closeReport: closed() };
      },
    })).resolves.toEqual(closed());
    expect(attempts).toBe(2);

    const terminalController = new AbortController();
    const terminal = runAccountStartupLoop({
      signal: terminalController.signal,
      onTerminal: () => { throw new Error("terminal observer"); },
      attempt: async () => ({ kind: "failed", cause: new NatsServerError("authorization-violation"), closeReport: closed() }),
    });
    await tick();
    terminalController.abort();
    await expect(terminal).resolves.toEqual(closed());

    const aggregate = new AccountServingAggregateTracker();
    expect(() => aggregate.update({
      generation: 1,
      expectedAccountIds: ["a"],
      servingAccountIds: [],
      logger: { info: () => { throw new Error("aggregate observer"); } },
    })).not.toThrow();
  });

  it("uses the shared full disposer on readiness abort and fences SUB/map/status from a late result", async () => {
    const controller = new AbortController();
    let resolveReadiness!: (value: string) => void;
    const readiness = new Promise<string>((resolve) => { resolveReadiness = resolve; });
    const effects = { dispatcher: 0, channel: 0, transport: 0, subscribe: 0, map: 0, status: 0 };
    const running = resolvePrivateReadiness({
      signal: controller.signal,
      resolve: async () => readiness,
      dispose: async () => {
        effects.dispatcher++;
        effects.channel++;
        effects.transport++;
        return { errors: [], transport: closed() };
      },
    }).then((result) => {
      if (result.kind === "ready") {
        effects.subscribe++;
        effects.map++;
        effects.status++;
      }
      return result;
    });
    controller.abort();
    await expect(running).resolves.toEqual({ kind: "aborted", closeReport: closed() });
    expect(effects).toEqual({ dispatcher: 1, channel: 1, transport: 1, subscribe: 0, map: 0, status: 0 });
    resolveReadiness("late");
    await tick();
    expect(effects).toEqual({ dispatcher: 1, channel: 1, transport: 1, subscribe: 0, map: 0, status: 0 });
  });

  it("interrupts non-cooperative private readiness, fully disposes, and schedules exactly one typed retry", async () => {
    const host = new AbortController();
    const effects = { attempts: 0, disposed: 0, dispatcher: 0, channel: 0, transport: 0 };
    const retryCodes: string[] = [];
    const delays: number[] = [];
    let poison!: (cause: unknown) => void;
    const running = runAccountStartupLoop({
      signal: host.signal,
      random: () => 0.5,
      delay: async (ms) => { delays.push(ms); },
      onRetryScheduled: ({ failure }) => retryCodes.push(failure.code),
      attempt: async ({ markCommitted }) => {
        effects.attempts++;
        if (effects.attempts === 2) {
          markCommitted();
          return { kind: "completed", closeReport: closed() };
        }
        const scope = createAttemptAbortScope(host.signal);
        let privateFailure: unknown;
        poison = (cause) => { privateFailure = cause; scope.abort(cause); };
        const readiness = await resolvePrivateReadiness({
          signal: scope.signal,
          resolve: async () => new Promise<string>(() => {}),
          dispose: async () => {
            effects.disposed++;
            effects.dispatcher++;
            effects.channel++;
            effects.transport++;
            scope.dispose();
            return { errors: [], transport: closed() };
          },
        });
        if (readiness.kind === "ready") throw new Error("late readiness crossed poison fence");
        if (host.signal.aborted) return { kind: "completed", closeReport: readiness.closeReport };
        return { kind: "failed", cause: privateFailure, closeReport: readiness.closeReport };
      },
    });
    await tick();
    poison(new NatsConnectionClosedError(1012, false));
    await expect(running).resolves.toEqual(closed());
    expect(effects).toEqual({ attempts: 2, disposed: 1, dispatcher: 1, channel: 1, transport: 1 });
    expect(retryCodes).toEqual(["websocket-close-1012"]);
    expect(delays).toEqual([500]);
  });

  it("treats host abort during non-cooperative readiness as a clean stop with no retry", async () => {
    const host = new AbortController();
    let attempts = 0;
    let disposed = 0;
    const retries = vi.fn();
    const running = runAccountStartupLoop({
      signal: host.signal,
      onRetryScheduled: retries,
      attempt: async () => {
        attempts++;
        const scope = createAttemptAbortScope(host.signal);
        const readiness = await resolvePrivateReadiness({
          signal: scope.signal,
          resolve: async () => new Promise<string>(() => {}),
          dispose: async () => {
            disposed++;
            scope.dispose();
            return { errors: [], transport: closed() };
          },
        });
        return { kind: "completed", closeReport: readiness.kind === "aborted" ? readiness.closeReport : closed() };
      },
    });
    await tick();
    host.abort();
    await expect(running).resolves.toEqual(closed());
    expect({ attempts, disposed }).toEqual({ attempts: 1, disposed: 1 });
    expect(retries).not.toHaveBeenCalled();
  });

  it("rolls publication back synchronously and awaits disposal when final serving status throws", async () => {
    const publications = new Set<string>();
    let disposed = false;
    let releaseDispose!: () => void;
    const disposalGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
    const committed = commitAccountPublication({
      publish: () => { publications.add("runtime"); return "runtime"; },
      writeServingStatus: () => { throw new Error("status failed"); },
      rollback: () => { publications.delete("runtime"); },
      dispose: async () => {
        await disposalGate;
        disposed = true;
        return { errors: [], transport: closed() };
      },
    });
    expect(committed).toBeInstanceOf(Promise);
    expect([...publications]).toEqual([]);
    let settled = false;
    void (committed as Promise<never>).catch(() => { settled = true; });
    await tick();
    expect({ disposed, settled }).toEqual({ disposed: false, settled: false });
    releaseDispose();
    await expect(committed).rejects.toThrow("status failed");
    expect({ disposed, settled }).toEqual({ disposed: true, settled: true });
  });

  it("propagates a serving-status invariant only after disposal and never schedules retry", async () => {
    let releaseDispose!: () => void;
    const disposalGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
    const retry = vi.fn();
    const effects: string[] = [];
    const running = runAccountStartupLoop({
      signal: new AbortController().signal,
      onRetryScheduled: retry,
      attempt: async () => {
        let failureState: { poisoned: boolean; privateFailure: unknown; connected: boolean } | undefined;
        try {
          const publication = commitAccountPublication({
            publish: () => { effects.push("publish"); return "runtime"; },
            writeServingStatus: () => { throw new Error("serving status failed"); },
            rollback: () => { effects.push("rollback"); },
            captureFailureState: () => {
              failureState = { poisoned: false, privateFailure: undefined, connected: true };
              effects.push("snapshot");
            },
            dispose: async () => {
              effects.push("dispose-start");
              await disposalGate;
              effects.push("dispose-finished");
              return { errors: [], transport: closed() };
            },
          });
          if (publication instanceof Promise) await publication;
          throw new Error("publication unexpectedly committed");
        } catch (cause) {
          effects.push("classify");
          return resolveAccountPublicationFailure({
            state: failureState!,
            cause,
            closeReport: closed(),
          });
        }
      },
    });
    expect(effects).toEqual(["publish", "snapshot", "rollback", "dispose-start"]);
    let settled = false;
    void running.catch(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    releaseDispose();
    await expect(running).rejects.toBeInstanceOf(AccountRunFailure);
    expect(effects).toEqual(["publish", "snapshot", "rollback", "dispose-start", "dispose-finished", "classify"]);
    expect(retry).not.toHaveBeenCalled();
  });

  it("keeps a PONG+immediate permanent close sticky across the connect continuation", async () => {
    const host = new AbortController();
    const socket = new ImmediateCloseWebSocket();
    const retries = vi.fn();
    const terminalCodes: string[] = [];
    let attempts = 0;
    const running = runAccountStartupLoop({
      signal: host.signal,
      onRetryScheduled: retries,
      onTerminal: ({ failure }) => terminalCodes.push(failure.code),
      attempt: async () => {
        attempts++;
        const scope = createAttemptAbortScope(host.signal);
        let transport: NatsTransport | undefined;
        let detach: (() => void) | undefined;
        let privateFailure: unknown;
        let initialHandshakeEstablished = false;
        try {
          await connectNatsCredentialSource(
            { mode: "static", url: "ws://sticky", userJwt: "jwt", userSeed: "seed" },
            {
              makeSigner: () => async () => "signature",
              signal: scope.signal,
              transportFactory: () => new NatsTransport({
                url: "ws://sticky",
                reconnect: true,
                handshakeTimeoutMs: 0,
                _wsFactory: () => socket as unknown as WebSocket,
              }),
              onTransport: (created) => {
                transport = created;
                const poison = (cause: unknown) => {
                  if (privateFailure !== undefined) return;
                  privateFailure = cause;
                  scope.abort(cause);
                  created.disconnect();
                };
                detach = attachAccountTransportListeners(created, {
                  connect: () => { initialHandshakeEstablished = true; },
                  disconnect: (cause) => {
                    if (initialHandshakeEstablished) poison(cause ?? new NatsConnectionClosedError(1006, false));
                  },
                  reconnect: () => {},
                  error: (cause) => {
                    if (initialHandshakeEstablished) poison(cause);
                  },
                });
              },
            },
          );
          throw new Error("closed transport unexpectedly returned");
        } catch (cause) {
          try { detach?.(); } catch { /* all listeners were still attempted */ }
          const closeReport = transport ? await transport.closeGracefully() : closed();
          scope.dispose();
          return { kind: "failed" as const, cause: privateFailure ?? cause, closeReport };
        }
      },
    });

    socket.open();
    socket.frame("PONG\r\n");
    socket.serverClose(1002);
    await vi.waitFor(() => {
      expect({ attempts, terminalCodes }).toEqual({ attempts: 1, terminalCodes: ["websocket-close-1002"] });
    });
    expect(retries).not.toHaveBeenCalled();
    host.abort();
    await expect(running).resolves.toMatchObject({ socketClosed: true });
  });

  it("keeps a pre-PONG handshake timeout authoritative over the follow-on close", async () => {
    vi.useFakeTimers();
    try {
      const socket = new ImmediateCloseWebSocket();
      let transport: NatsTransport | undefined;
      let detach: (() => void) | undefined;
      let initialHandshakeEstablished = false;
      let privateFailure: unknown;
      let disconnects = 0;
      const connecting = connectNatsCredentialSource(
        { mode: "static", url: "ws://timeout", userJwt: "jwt", userSeed: "seed" },
        {
          makeSigner: () => async () => "signature",
          transportFactory: () => new NatsTransport({
            url: "ws://timeout",
            reconnect: true,
            handshakeTimeoutMs: 10,
            _wsFactory: () => socket as unknown as WebSocket,
          }),
          onTransport: (created) => {
            transport = created;
            detach = attachAccountTransportListeners(created, {
              connect: () => { initialHandshakeEstablished = true; },
              disconnect: (cause) => {
                disconnects++;
                if (initialHandshakeEstablished) privateFailure = cause;
              },
              reconnect: () => {},
              error: (cause) => {
                if (initialHandshakeEstablished) privateFailure = cause;
              },
            });
          },
        },
      );
      const rejected = connecting.then(
        () => undefined,
        (cause: unknown) => cause,
      );
      socket.open();
      await vi.advanceTimersByTimeAsync(10);
      const connectCause = await rejected;
      try { detach?.(); } catch { /* all detach attempts still ran */ }
      await transport?.closeGracefully();

      expect(connectCause).toBeInstanceOf(NatsHandshakeTimeoutError);
      expect({ initialHandshakeEstablished, disconnects, privateFailure }).toEqual({
        initialHandshakeEstablished: false,
        disconnects: 1,
        privateFailure: undefined,
      });
      const selectedCause = privateFailure ?? connectCause;
      expect(classifyAccountStartupFailure(selectedCause)).toMatchObject({
        kind: "transient",
        code: "handshake-timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches every private transport listener even when one off call throws", () => {
    const removed: string[] = [];
    const transport = {
      on: vi.fn(),
      off: (event: string) => {
        removed.push(event);
        if (event === "disconnect") throw new Error("injected detach failure");
      },
    };
    const detach = attachAccountTransportListeners(transport, {
      connect: () => {},
      disconnect: () => {},
      reconnect: () => {},
      error: () => {},
    });
    expect(detach).toThrow(AggregateError);
    expect(removed).toEqual(["connect", "disconnect", "reconnect", "error"]);
  });
});

describe("live account transport status", () => {
  it("keeps error-only events connected and leaves restart ownership to disconnect", () => {
    const errorPatch = accountTransportStatusPatch("error", () => 7);
    expect(errorPatch).toEqual({ lastError: "NATS transport error observed" });
    expect(errorPatch).not.toHaveProperty("connected");
    expect(errorPatch).not.toHaveProperty("restartPending");

    expect(accountTransportStatusPatch("disconnect", () => 7)).toMatchObject({
      connected: false,
      restartPending: true,
      lastDisconnect: { at: 7, error: "relay disconnected" },
    });
  });

  it("keeps a dormant never-served permanent failure healthy under the pinned host policy", () => {
    const status = {
      running: true,
      lastStartAt: 0,
      ...accountNeverServedStatusPatch({
        restartPending: false,
        reconnectAttempts: 3,
        lastError: "permanent configuration failure",
      }),
    };
    const now = 120_001;
    const channelConnectGraceMs = 120_000;
    const pinnedHostHealthy = status.running === true
      && (now - status.lastStartAt < channelConnectGraceMs || status.connected !== false);

    expect(status).toMatchObject({
      connected: undefined,
      restartPending: false,
      reconnectAttempts: 3,
      lastError: "permanent configuration failure",
    });
    expect(pinnedHostHealthy).toBe(true);
  });
});

describe("permanent account failure reporting", () => {
  it("deduplicates by account and generation, retaining the first remediation", () => {
    const reporter = new AccountPermanentFailureReporter();
    const lines: string[] = [];
    const logger = { error: (line: string) => lines.push(line) };
    expect(reporter.report({ generation: 4, accountId: "bad\nid", code: "creds-missing", operatorMessage: "run setup\nnow", logger })).toBe(true);
    expect(reporter.report({ generation: 4, accountId: "bad\nid", code: "creds-missing", operatorMessage: "duplicate", logger })).toBe(false);
    expect(reporter.report({ generation: 4, accountId: "bad\nid", code: "identity-key-missing", operatorMessage: "re-enroll", logger })).toBe(false);
    expect(reporter.report({ generation: 5, accountId: "bad\nid", code: "creds-missing", operatorMessage: "new generation", logger })).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('accountId="bad\\nid"');
    expect(lines[0]).toContain('detail="run setup\\nnow"');
    expect(lines[0]).not.toContain("bad\nid");
  });

  it("contains a throwing logger without changing dedupe", () => {
    const reporter = new AccountPermanentFailureReporter();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const input = {
      generation: 1,
      accountId: "a",
      code: "config-invalid",
      operatorMessage: "fix config",
      logger: { error: () => { throw new Error("logger failed"); } },
    };
    expect(() => reporter.report(input)).not.toThrow();
    expect(reporter.report(input)).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("account serving aggregate", () => {
  it("counts only connected published runtimes and emits disconnect/reconnect transitions", () => {
    const lines: string[] = [];
    const tracker = new AccountServingAggregateTracker();
    const a = { transport: { connected: true } };
    const b = { transport: { connected: true } };
    const runtimes = new Map([["a", a], ["b", b]]);
    const refresh = () => tracker.update({
      generation: 1,
      expectedAccountIds: ["a", "b"],
      servingAccountIds: connectedPublishedAccountIds(runtimes),
      logger: { info: (line) => lines.push(line) },
    });

    expect(refresh()?.category).toBe("complete");
    a.transport.connected = false;
    expect(refresh()?.category).toBe("partial");
    b.transport.connected = false;
    expect(refresh()?.category).toBe("zero");
    a.transport.connected = true;
    expect(refresh()?.category).toBe("partial");
    b.transport.connected = true;
    expect(refresh()?.category).toBe("complete");
    expect(lines.map((line) => line.match(/state=(\w+)/)?.[1])).toEqual([
      "complete", "partial", "zero", "partial", "complete",
    ]);
  });

  it("emits generation-aware zero, partial, and complete transitions only when category changes", () => {
    const lines: string[] = [];
    const tracker = new AccountServingAggregateTracker();
    expect(tracker.update({ generation: 1, expectedAccountIds: ["a", "b"], servingAccountIds: [], logger: { info: (line) => lines.push(line) } })?.category).toBe("zero");
    expect(tracker.update({ generation: 1, expectedAccountIds: ["a", "b"], servingAccountIds: [], logger: { info: (line) => lines.push(line) } })).toBeUndefined();
    expect(tracker.update({ generation: 1, expectedAccountIds: ["a", "b"], servingAccountIds: ["a"], logger: { info: (line) => lines.push(line) } })?.category).toBe("partial");
    expect(tracker.update({ generation: 1, expectedAccountIds: ["a", "b"], servingAccountIds: ["a", "b"], logger: { info: (line) => lines.push(line) } })?.category).toBe("complete");
    expect(lines).toHaveLength(3);
  });

  it("seeds an all-permanent generation at zero and lets stale cleanup refresh only the newest generation", () => {
    const lines: string[] = [];
    const tracker = new AccountServingAggregateTracker();
    tracker.update({ generation: 1, expectedAccountIds: ["old"], servingAccountIds: ["old"], logger: { info: (line) => lines.push(line) } });
    tracker.update({ generation: 2, expectedAccountIds: ["permanent"], servingAccountIds: [], logger: { info: (line) => lines.push(line) } });
    expect(tracker.update({ generation: 1, expectedAccountIds: ["old"], servingAccountIds: [], logger: { info: (line) => lines.push(line) } })).toBeUndefined();
    expect(lines.at(-1)).toContain("generation=2 state=zero");
    expect(lines.filter((line) => line.includes("generation=2 state=zero"))).toHaveLength(1);
  });

  it("builds execution APIs from the task config while retaining install runtime/logger/generation", () => {
    const registrationConfig = { channels: { webchannel: { accounts: { stale: {} } } } };
    const taskConfig = { channels: { webchannel: { accounts: { current: {} } } } };
    const runtime = {};
    const logger = {};
    const api = createAccountExecutionApi({ generation: 7, fingerprint: "x", runtime, logger }, taskConfig);
    expect(api).toEqual({ runtime, logger, config: taskConfig, generation: 7 });
    expect(api.config).not.toBe(registrationConfig);
  });
});

describe("NatsAccountRuntimeCoordinator", () => {
  it("selects default dynamically, else the lexicographically smallest serving id", () => {
    const runtimes = new Map([["z", 3], ["b", 2]]);
    expect(selectPrimaryRuntime(runtimes)).toBe(2);
    runtimes.set("default", 1);
    expect(selectPrimaryRuntime(runtimes)).toBe(1);
    runtimes.delete("default"); runtimes.delete("b");
    expect(selectPrimaryRuntime(runtimes)).toBe(3);
  });

  it("deduplicates consecutive structural installs but keeps A-B-A monotone", () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    expect(coordinator.installFull({ registrationMode: "tool-discovery", config: { a: 1 }, runtime: 0, logger: 0 })).toBeUndefined();
    const a1 = coordinator.installFull({ registrationMode: "full", config: { z: 2, a: 1 }, runtime: 1, logger: 1 })!;
    const a2 = coordinator.installFull({ registrationMode: "full", config: { a: 1, z: 2 }, runtime: 2, logger: 2 })!;
    const b = coordinator.installFull({ registrationMode: "full", config: { a: 2 }, runtime: 3, logger: 3 })!;
    const a3 = coordinator.installFull({ registrationMode: "full", config: { a: 1, z: 2 }, runtime: 4, logger: 4 })!;
    expect([a1.generation, a2.generation, b.generation, a3.generation]).toEqual([1, 1, 2, 3]);
    expect(a2.runtime).toBe(2);
  });

  it("serializes same-account owners and promotes highest generation after full release", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    coordinator.installFull({ registrationMode: "full", config: { v: 1 }, runtime: 1, logger: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const first = coordinator.runAccount("a", new AbortController().signal, async () => {
      calls.push("old-start"); await held; calls.push("old-release"); return { closeReport: closed() };
    });
    coordinator.installFull({ registrationMode: "full", config: { v: 2 }, runtime: 2, logger: 2 });
    const second = coordinator.runAccount("a", new AbortController().signal, async () => {
      calls.push("new-start"); return { closeReport: closed() };
    });
    await Promise.resolve();
    expect(calls).toEqual(["old-start"]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(["old-start", "old-release", "new-start"]);
  });

  it("keeps an older waiter dormant after a newer generation was observed and then aborted", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    coordinator.installFull({ registrationMode: "full", config: { v: 1 }, runtime: 1, logger: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const owner = coordinator.runAccount("a", new AbortController().signal, async () => {
      await held;
      return { closeReport: closed() };
    });
    const oldController = new AbortController();
    const oldCallback = vi.fn(async () => ({ closeReport: closed() }));
    const old = coordinator.runAccount("a", oldController.signal, oldCallback);
    coordinator.installFull({ registrationMode: "full", config: { v: 2 }, runtime: 2, logger: 2 });
    const newController = new AbortController();
    const newer = coordinator.runAccount("a", newController.signal, async () => ({ closeReport: closed() }));
    newController.abort();
    release();
    await owner;
    await newer;
    await tick();
    expect(oldCallback).not.toHaveBeenCalled();
    expect(coordinator.inspectAccountState("a")).toMatchObject({ owner: false, waiters: 1 });
    oldController.abort();
    await old;
    expect(coordinator.inspectAccountState("a")).toBeUndefined();
  });

  it("keeps a healthy account independent while another account owner remains blocked", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    coordinator.installFull({ registrationMode: "full", config: { v: 1 }, runtime: 1, logger: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const retrying = coordinator.runAccount("retrying", new AbortController().signal, async () => {
      calls.push("retrying"); await gate; return { closeReport: closed() };
    });
    await coordinator.runAccount("healthy", new AbortController().signal, async () => {
      calls.push("healthy"); return { closeReport: closed() };
    });
    expect(calls).toEqual(["retrying", "healthy"]);
    release(); await retrying;
  });

  it("removes an already-aborted overlapping waiter without hanging or leaking its slot entry", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    coordinator.installFull({ registrationMode: "full", config: { v: 1 }, runtime: 1, logger: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.runAccount("a", new AbortController().signal, async () => {
      await held;
      return { closeReport: closed() };
    });
    const aborted = new AbortController();
    aborted.abort();
    const callback = vi.fn();
    await expect(coordinator.runAccount("a", aborted.signal, callback)).resolves.toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(coordinator.inspectAccountState("a")).toMatchObject({ owner: true, waiters: 0 });
    release();
    await first;
    expect(coordinator.inspectAccountState("a")).toBeUndefined();
  });

  it("releases a promoted waiter that aborts before its continuation and promotes the next live waiter", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    coordinator.installFull({ registrationMode: "full", config: { v: 1 }, runtime: 1, logger: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const first = coordinator.runAccount("a", new AbortController().signal, async () => {
      calls.push("first");
      await held;
      return { closeReport: closed() };
    });
    const promotedController = new AbortController();
    const promoted = coordinator.runAccount("a", promotedController.signal, async () => {
      calls.push("aborted-promoted");
      return { closeReport: closed() };
    });
    const live = coordinator.runAccount("a", new AbortController().signal, async () => {
      calls.push("live");
      return { closeReport: closed() };
    });
    release();
    await Promise.resolve();
    promotedController.abort();
    await Promise.all([first, promoted, live]);
    expect(calls).toEqual(["first", "live"]);
    expect(coordinator.inspectAccountState("a")).toBeUndefined();
  });

  it("quarantines an unconfirmed close and allows only a strictly later serialized probe", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    coordinator.installFull({ registrationMode: "full", config: { v: 1 }, runtime: 1, logger: 1 });
    let resolveProbe!: (report: TransportCloseReport) => void;
    const probe = vi.fn(() => new Promise<TransportCloseReport>((resolve) => { resolveProbe = resolve; }));
    let originalRuns = 0;
    const original = coordinator.runAccount("a", new AbortController().signal, async () => {
      originalRuns++;
      return originalRuns === 1
        ? { closeReport: closed(false), probePhysicalClose: probe }
        : { closeReport: closed() };
    });
    await Promise.resolve();
    const calls: string[] = [];
    const later = coordinator.runAccount("a", new AbortController().signal, async () => {
      calls.push("replacement"); return { closeReport: closed() };
    });
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    resolveProbe(closed());
    await Promise.all([original, later]);
    expect(originalRuns).toBe(2);
    expect(calls).toEqual(["replacement"]);
  });

  it("reports an owner-fenced quarantine after clean host abort with unconfirmed close", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    const lines: string[] = [];
    const statuses: Array<Record<string, unknown>> = [];
    coordinator.installFull({
      registrationMode: "full",
      config: { v: 1 },
      runtime: 1,
      logger: { warn: (line: string) => lines.push(line) },
    });
    const host = new AbortController();
    await coordinator.runAccount("bad\nid", host.signal, async () => {
      host.abort();
      return { closeReport: closed(false) };
    }, (event) => {
      notifyAccountQuarantine({
        ...event,
        setStatus: (status) => statuses.push(status),
      });
    });

    expect(coordinator.inspectAccountState("bad\nid")).toMatchObject({
      owner: false,
      quarantined: true,
    });
    expect(statuses).toEqual([expect.objectContaining({
      connected: false,
      restartPending: false,
      lastError: expect.stringContaining("restart the gateway"),
    })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('accountId="bad\\nid"');
    expect(lines[0]).toContain("state=quarantined");
    expect(lines[0]).not.toContain("bad\nid");
  });

  it("contains quarantine callback, status, and logger failures without retaining the lease", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    coordinator.installFull({ registrationMode: "full", config: { v: 1 }, runtime: 1, logger: 1 });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = new AbortController();

    const runFailure = new AccountRunFailure("run failed", closed(false));
    await expect(coordinator.runAccount(
      "a",
      host.signal,
      async () => {
        host.abort();
        throw runFailure;
      },
      (event) => {
        notifyAccountQuarantine({
          ...event,
          setStatus: () => { throw new Error("status failed"); },
          logger: { warn: () => { throw new Error("logger failed"); } },
        });
        throw new Error("callback failed after diagnostics");
      },
    )).rejects.toBe(runFailure);

    expect(coordinator.inspectAccountState("a")).toMatchObject({
      owner: false,
      quarantined: true,
    });
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });

  it("runs only one concurrent quarantine probe, skips an aborted probe waiter, and promotes live arrivals after confirmation", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    coordinator.installFull({ registrationMode: "full", config: { v: 1 }, runtime: 1, logger: 1 });
    let resolveProbe!: (report: TransportCloseReport) => void;
    const probe = vi.fn(() => new Promise<TransportCloseReport>((resolve) => { resolveProbe = resolve; }));
    let originalRuns = 0;
    const original = coordinator.runAccount("a", new AbortController().signal, async () => {
      originalRuns++;
      return originalRuns === 1
        ? { closeReport: closed(false), probePhysicalClose: probe }
        : { closeReport: closed() };
    });
    await tick();
    const abortedController = new AbortController();
    const abortedCallback = vi.fn(async () => ({ closeReport: closed() }));
    const aborted = coordinator.runAccount("a", abortedController.signal, abortedCallback);
    const calls: string[] = [];
    const liveOne = coordinator.runAccount("a", new AbortController().signal, async () => {
      calls.push("one");
      return { closeReport: closed() };
    });
    const liveTwo = coordinator.runAccount("a", new AbortController().signal, async () => {
      calls.push("two");
      return { closeReport: closed() };
    });
    await tick();
    expect(probe).toHaveBeenCalledTimes(1);
    abortedController.abort();
    resolveProbe(closed());
    await Promise.all([original, aborted, liveOne, liveTwo]);
    expect(abortedCallback).not.toHaveBeenCalled();
    expect(originalRuns).toBe(2);
    expect(calls).toEqual(["one", "two"]);
  });

  it("requires a strictly newer arrival after an unconfirmed probe before probing again", async () => {
    const coordinator = new NatsAccountRuntimeCoordinator();
    coordinator.installFull({ registrationMode: "full", config: { v: 1 }, runtime: 1, logger: 1 });
    const probeReports = [closed(false), closed()];
    const probe = vi.fn(async () => probeReports.shift()!);
    let originalRuns = 0;
    const originalController = new AbortController();
    const original = coordinator.runAccount("a", originalController.signal, async () => {
      originalRuns++;
      return originalRuns === 1
        ? { closeReport: closed(false), probePhysicalClose: probe }
        : { closeReport: closed() };
    });
    await tick();
    const firstLaterController = new AbortController();
    const firstLater = coordinator.runAccount("a", firstLaterController.signal, async () => ({ closeReport: closed() }));
    await tick();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(coordinator.inspectAccountState("a")).toMatchObject({ quarantined: true, probing: false });
    const secondLater = coordinator.runAccount("a", new AbortController().signal, async () => ({ closeReport: closed() }));
    await Promise.all([original, firstLater, secondLater]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(originalRuns).toBe(2);
  });
});
