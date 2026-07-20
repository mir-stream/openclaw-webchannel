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

  it("surfaces the credential source mode + effective dialed relay (P0-3 D1-5)", () => {
    const r = formatAccountReadiness({
      accountId: "acme",
      admission: "register-hop",
      issuer: "https://saas.example",
      audience: "acme",
      jwks: { keyCount: 1 },
      credentialSource: "static",
      dialedUrl: "wss://byo-relay:4222",
    });
    expect(r.line).toContain("source=static");
    expect(r.line).toContain("relay=wss://byo-relay:4222");
  });

  it("shows (unknown) source/relay when a build failure preempts the consume facts", () => {
    const r = formatAccountReadiness({
      accountId: "acme",
      admission: "register-hop",
      buildError: "missing jwks source",
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.line).toContain("source=(unknown)");
    expect(r.line).toContain("relay=(unknown)");
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

  it("pinned audience != accountId → FAIL naming the mismatch", () => {
    const r = evaluateAddPreflight({
      ...base,
      pinnedAudience: "wrong-aud",
      jwks: { keyCount: 3 },
      relay: { ok: true },
    });
    expect(r.ok).toBe(false);
    expect(r.line).toContain('auth.jwt.audience="wrong-aud"');
    expect(r.line).toContain('aud="acme"');
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

  // D4b: the dial now goes through the runtime resolve → consume path. A healthy
  // dial = persisted enrolled creds (loadPersisted) + a transport that connects
  // (transportFactory). `probePass` stubs the permission probe; the probe's own
  // logic is covered by preflight-probe.test.ts.
  type Captured = { url?: string };
  const healthyConsumeDeps = (
    captured: Captured = {},
    persisted: { userJwt: string; userSeed: string; natsUrl?: string } = { userJwt: "J", userSeed: "S" },
  ) => ({
    loadPersisted: () => persisted as never,
    makeSigner: () => async () => "sig",
    transportFactory: (o: { url: string }) => {
      captured.url = o.url;
      return { connect: async () => {}, disconnect: () => {} } as never;
    },
  });
  const probePass = vi.fn(async () => ({ results: [], verdict: "PASS" as const, line: "probe pass" }));

  it("dials the runtime resolve→consume path and passes when JWKS + dial + probe are healthy", async () => {
    const log = vi.fn();
    const captured: Captured = {};
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
      consumeDeps: healthyConsumeDeps(captured, { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example" }),
      runProbes: probePass,
    });
    expect(report.ok).toBe(true);
    // Enrolled consume dials the SaaS-delivered natsUrl (runtime-identical).
    expect(captured.url).toBe("wss://relay.example");
    expect(probePass).toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).includes("issuer/aud ✓"))).toBe(true);
    expect(log.mock.calls.some((c) => String(c[0]).includes("permissions PASS"))).toBe(true);
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
      consumeDeps: {
        loadPersisted: () => ({ userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example" }) as never,
        makeSigner: () => async () => "sig",
        transportFactory: () => ({ connect: async () => { throw new Error("refused"); }, disconnect: () => {} }) as never,
      },
      runProbes: probePass,
    });
    expect(report.ok).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes("relay dial failed: refused"))).toBe(true);
  });

  it("disconnects a transport whose dial resolves after the preflight timeout", async () => {
    vi.useFakeTimers();
    try {
      const disconnect = vi.fn();
      const localProbe = vi.fn(async () => ({ results: [], verdict: "PASS" as const, line: "probe pass" }));
      let finishConnect!: () => void;
      const connect = new Promise<void>((resolve) => { finishConnect = resolve; });
      const reportPromise = runAddPreflight({
        accountId: "acme",
        tenant: "t",
        saasBaseUrl: "https://saas.example",
        enrollment: { userJwt: "J", userSeed: "S" },
        log: vi.fn(),
        fetchImpl: okFetch,
        timeoutMs: 10,
        consumeDeps: {
          loadPersisted: () => ({ userJwt: "J", userSeed: "S" }) as never,
          makeSigner: () => async () => "sig",
          transportFactory: () => ({ connect: () => connect, disconnect }) as never,
        },
        runProbes: localProbe,
      });

      await vi.advanceTimersByTimeAsync(10);
      const report = await reportPromise;
      expect(report.ok).toBe(false);
      expect(disconnect).not.toHaveBeenCalled();

      finishConnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(localProbe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("FAILs when no enrolled creds are persisted (creds-missing → dial cannot run)", async () => {
    // Replaces the old "no relay URL" case: under D4b the dial goes through
    // consume, which fail-closes to creds-missing when nothing is persisted.
    const log = vi.fn();
    const localProbe = vi.fn(async () => ({ results: [], verdict: "PASS" as const, line: "probe pass" }));
    const report = await runAddPreflight({
      accountId: "acme",
      tenant: "t",
      saasBaseUrl: "https://saas.example",
      enrollment: { userJwt: "J", userSeed: "S" },
      log,
      fetchImpl: okFetch,
      consumeDeps: { loadPersisted: () => undefined },
      runProbes: localProbe,
    });
    expect(report.ok).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes("no enrolled credentials persisted"))).toBe(true);
    // The probe never runs when the dial never connected.
    expect(localProbe).not.toHaveBeenCalled();
  });

  it("a probe FAIL flips the verdict and surfaces the permission template", async () => {
    const log = vi.fn();
    const report = await runAddPreflight({
      accountId: "acme",
      tenant: "t",
      saasBaseUrl: "https://saas.example",
      enrollment: { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example", jwksUrl: deriveJwksUrl("https://saas.example") },
      log,
      fetchImpl: okFetch,
      consumeDeps: healthyConsumeDeps({}, { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example" }),
      runProbes: async () => ({ results: [], verdict: "FAIL" as const, line: "NATS permission probe FAIL — template…" }),
    });
    expect(report.ok).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes("permissions FAIL"))).toBe(true);
  });

  it("a probe WARN (over-broad) is surfaced but does NOT fail the add", async () => {
    const log = vi.fn();
    const report = await runAddPreflight({
      accountId: "acme",
      tenant: "t",
      saasBaseUrl: "https://saas.example",
      enrollment: { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example", jwksUrl: deriveJwksUrl("https://saas.example") },
      log,
      fetchImpl: okFetch,
      consumeDeps: healthyConsumeDeps({}, { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example" }),
      runProbes: async () => ({ results: [], verdict: "WARN" as const, line: "NATS permission probe WARN — over-broad" }),
    });
    expect(report.ok).toBe(true);
    expect(log.mock.calls.some((c) => String(c[0]).includes("permissions WARN"))).toBe(true);
  });

  it("uses the SaaS-DELIVERED issuer over the derivation (pin > delivered > derived)", async () => {
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
      consumeDeps: healthyConsumeDeps({}, { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example" }),
      runProbes: probePass,
    });
    expect(report.ok).toBe(true);
    expect(log.mock.calls.some((c) => String(c[0]).includes("issuer=https://saas.local/logical-issuer"))).toBe(true);
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
      consumeDeps: healthyConsumeDeps({}, { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example" }),
      runProbes: probePass,
    });
    expect(log.mock.calls.some((c) => String(c[0]).includes('WARN: auth.jwt.issuer is pinned to'))).toBe(true);
    expect(log.mock.calls.some((c) => String(c[0]).includes("issuer=https://stale-pin.example"))).toBe(true);
    expect(report).toBeDefined();
  });

  it("does NOT warn when pin and delivered issuer differ only by trailing slash", async () => {
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
      consumeDeps: healthyConsumeDeps({}, { userJwt: "J", userSeed: "S", natsUrl: "wss://relay.example" }),
      runProbes: probePass,
    });
    expect(log.mock.calls.some((c) => String(c[0]).includes("WARN: auth.jwt.issuer"))).toBe(false);
  });
});
