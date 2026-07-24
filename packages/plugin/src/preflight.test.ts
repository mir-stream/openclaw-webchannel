/**
 * Trust-anchor preflight tests (design §4 change 4).
 *
 * Gate B — `formatAccountReadiness`: the gateway-start readiness reporter. Every
 * branch (happy path, empty JWKS, JWKS fetch failure, verifier build failure,
 * the ENFORCED per-account-channel-peer dmScope line, and the graceful `auto`
 * degrade) is asserted here so the loop can stay a thin logger.
 *
 * Gate A — `evaluateAddPreflight` (pure) + `runAddPreflight` (I/O, with injected
 * fetch + dial seams): the achievable add-time checks.
 */
import { describe, it, expect, vi } from "vitest";

import {
  formatAccountReadiness,
  evaluateAddPreflight,
  runAddPreflight,
  dialRelayForPreflight,
  deriveJwksUrl,
} from "./preflight.js";

describe("formatAccountReadiness (Gate B)", () => {
  it("happy path (register-hop, keys present) → READY with ENFORCED dmScope", () => {
    const r = formatAccountReadiness({
      accountId: "acme",
      admission: "register-hop",
      issuer: "https://saas.example",
      audience: "acme",
      jwks: { keyCount: 2 },
      dmSecurity: "open",
    });
    expect(r.verdict).toBe("READY");
    expect(r.line).toContain('account "acme" READY');
    expect(r.line).toContain("issuer=https://saas.example");
    expect(r.line).toContain("JWKS 2 keys");
    expect(r.line).toContain("aud=acme");
    expect(r.line).toContain("admission=register-hop (subscribed *.register)");
    // The line reports the scope webchannel ENFORCES itself, not the operator's
    // global session.dmScope — proving per-user isolation is active.
    expect(r.line).toContain("dmScope=per-account-channel-peer (webchannel-enforced)");
    expect(r.line).toContain("dmSecurity=open");
  });

  it("empty JWKS → FAIL line (cannot verify any bootstrap JWT)", () => {
    const r = formatAccountReadiness({
      accountId: "acme",
      admission: "register-hop",
      issuer: "https://saas.example",
      audience: "acme",
      jwks: { keyCount: 0 },
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.line).toContain("FAIL");
    expect(r.line).toContain("JWKS 0 keys — cannot verify any bootstrap JWT");
  });

  it("JWKS fetch failure → FAIL line naming the reason", () => {
    const r = formatAccountReadiness({
      accountId: "acme",
      admission: "register-hop",
      issuer: "https://saas.example",
      audience: "acme",
      jwks: { error: "HTTP 503" },
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.line).toContain("JWKS FETCH FAILED: HTTP 503");
  });

  it("verifier build failure → FAIL line naming issuer/aud state", () => {
    const r = formatAccountReadiness({
      accountId: "acme",
      admission: "register-hop",
      buildError: "channels.webchannel.auth.jwt.issuer is required",
      // issuer/aud unresolved because the verifier could not build.
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.line).toContain("verifier build failed");
    expect(r.line).toContain("issuer=(unresolved)");
    expect(r.line).toContain("aud=(unresolved)");
  });

  it("register-hop with the operator's global dmScope=main → still READY (webchannel enforces its own scope)", () => {
    // Previously this was a WARN (shared-session cross-user leak). Webchannel now
    // FORCES per-account-channel-peer at every session-key site
    // (src/session-route.ts), so the global session.dmScope is irrelevant here:
    // the verdict is READY and the line reports the ENFORCED scope. This is the
    // adapted successor to the old dmScope=main WARN test — same account shape,
    // but the isolation is now proven active rather than warned-about.
    const r = formatAccountReadiness({
      accountId: "acme",
      admission: "register-hop",
      issuer: "https://saas.example",
      audience: "acme",
      jwks: { keyCount: 1 },
    });
    expect(r.verdict).toBe("READY");
    expect(r.line).toContain('account "acme" READY');
    expect(r.line).toContain("dmScope=per-account-channel-peer (webchannel-enforced)");
    expect(r.line).not.toContain("leaks transcripts across users");
  });

});

describe("evaluateAddPreflight (Gate A, pure)", () => {
  const base = {
    accountId: "acme",
    effectiveIssuer: "https://saas.example",
    effectiveAudience: "acme",
    derivedJwksUrl: "https://saas.example/.well-known/jwks.json",
  };

  it("all checks pass → ok with the green summary", () => {
    const r = evaluateAddPreflight({
      ...base,
      deliveredJwksUrl: "https://saas.example/.well-known/jwks.json",
      jwks: { keyCount: 3 },
      relay: { ok: true },
    });
    expect(r.ok).toBe(true);
    // The PASS line surfaces the EFFECTIVE issuer (pin > delivered > derived)
    // so the operator sees which one won while still watching the add.
    expect(r.line).toBe(
      "channels add preflight: issuer/aud ✓ (issuer=https://saas.example) · JWKS 3 keys ✓ · relay dial ✓",
    );
  });

  it("reports account-derived audience with no configurable pin branch", () => {
    const r = evaluateAddPreflight({
      ...base,
      jwks: { keyCount: 3 },
      relay: { ok: true },
    });
    expect(r.ok).toBe(true);
    expect(base.effectiveAudience).toBe(base.accountId);
  });

  it("JWKS fetch failure → FAIL naming the derived url", () => {
    const r = evaluateAddPreflight({
      ...base,
      jwks: { error: "connection refused" },
      relay: { ok: true },
    });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("JWKS fetch failed");
    expect(r.line).toContain(base.derivedJwksUrl);
  });

  it("JWKS 0 keys → FAIL", () => {
    const r = evaluateAddPreflight({ ...base, jwks: { keyCount: 0 }, relay: { ok: true } });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("has 0 keys");
  });

  it("delivered jwksUrl != derived → FAIL (issuer-mismatch trap surfaced early)", () => {
    const r = evaluateAddPreflight({
      ...base,
      deliveredJwksUrl: "https://real-saas.example/.well-known/jwks.json",
      jwks: { keyCount: 3 },
      relay: { ok: true },
    });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("advertises JWKS at https://real-saas.example");
    expect(r.line).toContain("derives jwksUrl=" + base.derivedJwksUrl);
  });

  it("relay dial failure → FAIL", () => {
    const r = evaluateAddPreflight({
      ...base,
      jwks: { keyCount: 3 },
      relay: { error: "TLS handshake failed" },
    });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("relay dial failed: TLS handshake failed");
  });
});

describe("runAddPreflight (Gate A, orchestrated with seams)", () => {
  const jwksDoc = JSON.stringify({ keys: [{ kid: "k1", kty: "RSA", n: "x", e: "AQAB" }] });
  const okFetch = vi.fn(
    async () => new Response(jwksDoc, { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;

  it("derives the jwks url from the base and passes when JWKS + dial are healthy", async () => {
    const log = vi.fn();
    const dial = vi.fn(async (_input: { url: string; subject: string }) => ({ ok: true }) as const);
    const report = await runAddPreflight({
      accountId: "acme",
      tenant: "t",
      saasBaseUrl: "https://saas.example/",
      enrollment: {
        userJwt: "J",
        userSeed: "S",
        natsUrl: "wss://relay.example",
        jwksUrl: deriveJwksUrl("https://saas.example/"),
      },
      log,
      fetchImpl: okFetch,
      dial,
    });
    expect(report.ok).toBe(true);
    expect(dial).toHaveBeenCalledOnce();
    // Scoped no-op subject rides the account's own subtree.
    expect(dial.mock.calls[0][0]).toMatchObject({
      url: "wss://relay.example",
      subject: "webchannel.t.acme._preflight",
    });
    expect(log.mock.calls.some((c) => String(c[0]).includes("issuer/aud ✓"))).toBe(true);
  });

  it("reports FAIL (does not throw) when the relay dial fails", async () => {
    const log = vi.fn();
    const report = await runAddPreflight({
      accountId: "acme",
      tenant: "t",
      saasBaseUrl: "https://saas.example",
      enrollment: { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example" },
      log,
      fetchImpl: okFetch,
      dial: async () => ({ error: "refused" }),
    });
    expect(report.ok).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes("relay dial failed: refused"))).toBe(true);
  });

  it("FAILs when no relay URL was delivered (cannot prove the dial)", async () => {
    const log = vi.fn();
    const report = await runAddPreflight({
      accountId: "acme",
      tenant: "t",
      saasBaseUrl: "https://saas.example",
      enrollment: { userJwt: "J", userSeed: "S" },
      log,
      fetchImpl: okFetch,
    });
    expect(report.ok).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes("no SaaS-delivered relay URL"))).toBe(true);
  });

  it("uses the SaaS-DELIVERED issuer over the derivation (pin > delivered > derived)", async () => {
    // Matches the runtime's deriveAccountAuth precedence: a delivered issuer
    // (EnrollmentResult.issuer) beats issuer=saasBaseUrl derivation, so Gate A
    // reports the issuer the runtime will actually verify against.
    const log = vi.fn();
    const report = await runAddPreflight({
      accountId: "acme",
      tenant: "t",
      saasBaseUrl: "https://saas.example",
      enrollment: {
        userJwt: "J",
        userSeed: "S",
        natsUrl: "wss://relay.example",
        jwksUrl: deriveJwksUrl("https://saas.example"),
        issuer: "https://saas.local/logical-issuer",
      },
      log,
      fetchImpl: okFetch,
      dial: async () => ({ ok: true }) as const,
    });
    expect(report.ok).toBe(true);
    expect(log.mock.calls.some((c) => String(c[0]).includes("issuer=https://saas.local/logical-issuer"))).toBe(
      true,
    );
    // No pin present ⇒ no pin-vs-delivered contradiction warning.
    expect(log.mock.calls.some((c) => String(c[0]).includes("WARN: auth.jwt.issuer"))).toBe(false);
  });

  it("WARNs when an operator pin contradicts the SaaS-delivered issuer (pin still wins)", async () => {
    const log = vi.fn();
    const report = await runAddPreflight({
      accountId: "acme",
      tenant: "t",
      saasBaseUrl: "https://saas.example",
      enrollment: {
        userJwt: "J",
        userSeed: "S",
        natsUrl: "wss://relay.example",
        jwksUrl: deriveJwksUrl("https://saas.example"),
        issuer: "https://saas.local/real-issuer",
      },
      pinnedIssuer: "https://stale-pin.example",
      log,
      fetchImpl: okFetch,
      dial: async () => ({ ok: true }) as const,
    });
    expect(log.mock.calls.some((c) => String(c[0]).includes('WARN: auth.jwt.issuer is pinned to'))).toBe(true);
    // Pin wins in the report line (operator escape hatch).
    expect(log.mock.calls.some((c) => String(c[0]).includes("issuer=https://stale-pin.example"))).toBe(true);
    expect(report).toBeDefined();
  });

  it("does NOT warn when pin and delivered issuer differ only by trailing slash", async () => {
    // verifyJwt compares iss slash-insensitively, so a slash variant is not a
    // contradiction — warning on it would train operators to ignore the warning.
    const log = vi.fn();
    await runAddPreflight({
      accountId: "acme",
      tenant: "t",
      saasBaseUrl: "https://saas.example",
      enrollment: {
        userJwt: "J",
        userSeed: "S",
        natsUrl: "wss://relay.example",
        issuer: "https://saas.example/",
      },
      pinnedIssuer: "https://saas.example",
      log,
      fetchImpl: okFetch,
      dial: async () => ({ ok: true }) as const,
    });
    expect(log.mock.calls.some((c) => String(c[0]).includes("WARN: auth.jwt.issuer"))).toBe(false);
  });
});

describe("dialRelayForPreflight (relay-dial probe)", () => {
  /** A fake NatsTransport whose `connect` settles only when the test releases it. */
  function slowTransport(): {
    factory: () => never;
    release: () => void;
    disconnect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  } {
    let release: () => void = () => {};
    const connected = new Promise<void>((r) => {
      release = r;
    });
    const disconnect = vi.fn();
    const subscribe = vi.fn();
    const flush = vi.fn(async () => {});
    const on = vi.fn();
    const off = vi.fn();
    return {
      factory: () =>
        ({
          connect: vi.fn(() => connected),
          subscribe,
          flush,
          on,
          off,
          disconnect,
          connected: true,
        }) as never,
      release: () => release(),
      disconnect,
      subscribe,
      flush,
      on,
      off,
    };
  }

  it("disconnects a connection that lands AFTER the dial timed out", async () => {
    // The timeout does not cancel the connect. Without a late-settle disposer the
    // relay's answer arrives to nobody: a live authenticated transport (plus its
    // subscription) that no code holds and nothing ever closes. Doctor/status
    // probe this path repeatedly, so each slow probe would leak one.
    const t = slowTransport();

    const result = await dialRelayForPreflight({
      url: "wss://relay.example",
      userJwt: "J",
      userSeed: "S",
      subject: "webchannel.t.acme._preflight",
      timeoutMs: 5,
      connectDeps: { transportFactory: t.factory, makeSigner: () => async () => "sig" },
    });

    // The caller's contract is unchanged: it still gets the timeout verdict, and
    // nothing was torn down while the connect was merely slow.
    expect(result).toEqual({ error: "relay dial timed out after 5ms" });
    expect(t.disconnect).not.toHaveBeenCalled();

    t.release();
    await vi.waitFor(() => expect(t.disconnect).toHaveBeenCalledTimes(1));
  });

  it("disconnects on the normal path too (probe succeeds, then tears down)", async () => {
    const t = slowTransport();
    t.release(); // connect resolves immediately — no timeout involved

    const result = await dialRelayForPreflight({
      url: "wss://relay.example",
      userJwt: "J",
      userSeed: "S",
      subject: "webchannel.t.acme._preflight",
      timeoutMs: 5000,
      connectDeps: { transportFactory: t.factory, makeSigner: () => async () => "sig" },
    });

    expect(result).toEqual({ ok: true });
    expect(t.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      t.flush.mock.invocationCallOrder[0]!,
    );
    expect(t.disconnect).toHaveBeenCalledTimes(1);
    expect(t.off).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("does not report success when the SUB/PING fence rejects", async () => {
    const t = slowTransport();
    t.release();
    t.flush.mockRejectedValueOnce(new Error("secret broker diagnostic"));

    const result = await dialRelayForPreflight({
      url: "wss://relay.example",
      userJwt: "SECRET-JWT",
      userSeed: "SECRET-SEED",
      subject: "webchannel.t.acme._preflight",
      timeoutMs: 5000,
      connectDeps: { transportFactory: t.factory, makeSigner: () => async () => "sig" },
    });

    expect(result).toEqual({ error: "relay subscription rejected" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(t.disconnect).toHaveBeenCalledTimes(1);
    expect(t.off).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("bounds the SUB/PING fence and tears down after timeout", async () => {
    const t = slowTransport();
    t.release();
    // An injected transport may ignore AbortSignal entirely; the public helper
    // still owns a hard wall-clock bound around the fence.
    t.flush.mockImplementationOnce(() => new Promise<void>(() => {}));

    const result = await dialRelayForPreflight({
      url: "wss://relay.example",
      userJwt: "J",
      userSeed: "S",
      subject: "webchannel.t.acme._preflight",
      timeoutMs: 5,
      connectDeps: { transportFactory: t.factory, makeSigner: () => async () => "sig" },
    });

    expect(result).toEqual({
      error: "relay subscription timed out after 5ms",
    });
    expect(t.disconnect).toHaveBeenCalledTimes(1);
    expect(t.off).toHaveBeenCalledWith("error", expect.any(Function));
  });
});
