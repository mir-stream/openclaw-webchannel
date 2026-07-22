import { describe, expect, it, vi, type TestContext } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// jsdom is a root dev dependency; this repository intentionally carries no @types/jsdom.
// @ts-expect-error no declaration package installed
import { JSDOM } from "jsdom";
import { authorizeEnrollmentAdmin } from "../reference/admin-auth.js";
import { renderApprovalTemplate } from "../reference/approval-page-renderer.js";
import { serializeBootstrapResponse, serializeEnrollmentRequest, serializeEnrollmentResponse } from "./p1-1-wire-adapter.js";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createAccount } from "@nats-io/nkeys";
import { DeviceFlowEnrollment } from "./device-flow-enrollment.js";
import { MemoryEnrollmentRepository } from "./enrollment-repository.js";
import { createDemoEnrollmentHttpHandler, createReferenceEnrollmentHttpHandler } from "./enrollment-http-handler.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (path: string) => readFile(join(root, path), "utf8");
const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

async function exerciseApprovalDom(html: string, hostile: string) {
  const fetchMock = async () => ({ status: 200, json: async () => ({ success: true, accountId: hostile, tenant: hostile, peerId: hostile }) });
  const dom = new JSDOM(html, { runScripts: "dangerously", beforeParse(window: any) { window.fetch = fetchMock; window.confirm = () => false; } });
  (dom.window.document.getElementById("admin-token") as HTMLInputElement).value = "memory-only";
  (dom.window.document.querySelector("button.approve") as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return dom;
}

describe("P1-1 HTTP callers and reference approval UI", () => {
  const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const makeService = () => {
    const account = createAccount();
    const registry = new MemoryEnrollmentRepository();
    const enrollment = new DeviceFlowEnrollment({
      saasTrustChain: { rsaPrivateKeyPem: "TEST", natsAccountSeed: new TextDecoder().decode(account.getSeed()) },
      natsAccountConfig: { operatorJwt: "op", accountJwt: "acct", resolverConfig: {}, accountPublicKey: "pub" },
      saasBaseUrl: "https://saas", jwksUrl: "https://saas/jwks", bootstrapUrl: "https://saas/bootstrap", natsUrl: "wss://nats",
      repository: registry,
    });
    return { enrollment, registry };
  };
  const withServer = async (ctx: TestContext, listener: ReturnType<typeof createReferenceEnrollmentHttpHandler>, run: (base: string) => Promise<void>) => {
    const server = createServer(listener);
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        console.warn("P1-1 real HTTP matrix skipped: sandbox denied listen(2) with EPERM");
        (ctx as unknown as { skip(): void }).skip();
        return;
      }
      throw error;
    }
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing TCP address");
      await run(`http://127.0.0.1:${address.port}`);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  };
  const post = (base: string, path: string, value: unknown, token?: string) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const invoke = async (listener: ReturnType<typeof createReferenceEnrollmentHttpHandler>, path: string, rawBody: string, headers: Record<string, string> = {}) => {
    const req = Readable.from([rawBody]) as IncomingMessage;
    Object.assign(req, { method: "POST", url: path, headers });
    const responseHeaders = new Map<string, string>();
    let responseBody = "";
    const state = { headersSent: false, writableEnded: false };
    const res = {
      statusCode: 200,
      get headersSent() { return state.headersSent; },
      get writableEnded() { return state.writableEnded; },
      setHeader(name: string, value: string) { responseHeaders.set(name.toLowerCase(), value); },
      end(value?: string) { responseBody = value ?? ""; state.headersSent = true; state.writableEnded = true; },
    } as unknown as ServerResponse;
    await listener(req, res);
    return { status: res.statusCode, json: () => JSON.parse(responseBody) as unknown };
  };

  for (const [profile, factory] of [["reference", createReferenceEnrollmentHttpHandler], ["demo", createDemoEnrollmentHttpHandler]] as const) {
    it(`26-27: ${profile} real HTTP handler enforces auth and replacement semantics`, async (ctx) => {
      const { enrollment, registry } = makeService();
      const logs: string[] = [];
      const a = await enrollment.enroll({ agentPublicKey: KEY_A, tenant: "tenant", accountId: "account" });
      expect((await enrollment.approve(a.user_code)).kind).toBe("approved");
      const b = await enrollment.enroll({ agentPublicKey: KEY_B, tenant: "tenant", accountId: "account" });
      const approvePath = profile === "demo" ? `/admin/enrollments/${b.user_code}/approve` : "/approve";
      const approveBody = profile === "demo" ? {} : { user_code: b.user_code };
      const denyPath = profile === "demo" ? `/admin/enrollments/${b.user_code}/deny` : "/deny";
      const denyBody = profile === "demo" ? {} : { user_code: b.user_code };
      const revokePath = profile === "demo" ? "/admin/accounts/account/revoke" : "/revoke";

      await withServer(ctx, factory({ enrollment, registry, bootstrap: () => ({ jwt: "jwt", peerId: "peer" }), log: (line) => logs.push(line) }), async (base) => {
        for (const [path, payload] of [[approvePath, approveBody], [denyPath, denyBody], [revokePath, { tenant: "tenant", accountId: "account" }]] as const) expect((await post(base, path, payload)).status).toBe(503);
        expect((await post(base, "/enroll", { agentPublicKey: KEY_B, tenant: "tenant", accountId: `${profile}-open` })).status).toBe(200);
        expect((await post(base, "/poll", { device_code: "missing" })).status).toBe(400);
        expect((await post(base, "/bootstrap", {})).status).toBe(200);
      });
      await withServer(ctx, factory({ adminToken: "secret-token", enrollment, registry, bootstrap: () => ({ jwt: "jwt", peerId: "peer" }), log: (line) => logs.push(line) }), async (base) => {
        expect((await post(base, approvePath, approveBody, "wrong")).status).toBe(401);
        const conflictResponse = await post(base, approvePath, approveBody, "secret-token");
        expect(conflictResponse.status).toBe(409);
        const conflict = await conflictResponse.json() as Record<string, unknown>;
        expect(Object.keys(conflict).sort()).toEqual(["activationId", "enrolledAt", "error", "fingerprint"]);
        expect(conflict).toMatchObject({ error: "conflict", activationId: expect.any(String), fingerprint: expect.any(String), enrolledAt: expect.any(Number) });
        const confirmed = await post(base, approvePath, { ...approveBody, replaceActivationId: conflict.activationId }, "secret-token");
        expect(confirmed.status).toBe(200);
        expect(await confirmed.clone().text()).not.toContain("secret-token");
        const preflight = await fetch(`${base}${approvePath}`, { method: "OPTIONS" });
        expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
        for (const response of [conflictResponse, confirmed, preflight]) expect(response.url).not.toContain("secret-token");
      });
      expect(logs.join("\n")).not.toContain("secret-token");
      expect(logs.filter((line) => line.includes("authorization is not configured"))).toHaveLength(1);
    });
  }

  it("round-2 failure matrix returns bounded JSON errors and logs internal failures", async () => {
    const approved = { kind: "approved", result: { peerId: "peer" } } as const;
    const cases: Array<{
      name: string;
      path: string;
      enrollment?: Record<string, ReturnType<typeof vi.fn>>;
      registry?: Record<string, ReturnType<typeof vi.fn>>;
      onApproved?: ReturnType<typeof vi.fn>;
      bootstrap?: ReturnType<typeof vi.fn>;
    }> = [
      { name: "enroll store failure", path: "/enroll", enrollment: { enroll: vi.fn().mockRejectedValue(new Error("enroll store secret detail")) } },
      { name: "poll store failure", path: "/poll", enrollment: { poll: vi.fn().mockRejectedValue(new Error("poll store secret detail")) } },
      { name: "mint failure", path: "/approve", enrollment: { approve: vi.fn().mockRejectedValue(new Error("mint secret detail")) } },
      { name: "registry rejection", path: "/revoke", registry: { revokeActive: vi.fn().mockRejectedValue(new Error("registry secret detail")) } },
      { name: "onApproved hook throw", path: "/approve", enrollment: { approve: vi.fn().mockResolvedValue(approved) }, onApproved: vi.fn().mockRejectedValue(new Error("hook secret detail")) },
      { name: "bootstrap throw", path: "/bootstrap", bootstrap: vi.fn().mockRejectedValue(new Error("bootstrap secret detail")) },
    ];
    for (const failure of cases) {
      const logs: string[] = [];
      const enrollment = {
        enroll: vi.fn(), poll: vi.fn(), approve: vi.fn().mockResolvedValue(approved), deny: vi.fn(),
        ...(failure.enrollment ?? {}),
      };
      const registry = { revokeActive: vi.fn().mockResolvedValue(true), ...(failure.registry ?? {}) };
      const handler = createReferenceEnrollmentHttpHandler({
        adminToken: "secret-token", enrollment: enrollment as never, registry: registry as never,
        bootstrap: failure.bootstrap ?? (() => ({})), onApproved: failure.onApproved,
        log: (line) => logs.push(line),
      });
      const requestBody = failure.path === "/approve"
        ? { user_code: "CODE" }
        : failure.path === "/enroll"
          ? { agentPublicKey: KEY_A, tenant: "tenant", accountId: "account" }
          : failure.path === "/poll"
            ? { device_code: "device" }
            : { tenant: "tenant", accountId: "account" };
      const response = await invoke(handler, failure.path, JSON.stringify(requestBody), { authorization: "Bearer secret-token" });
      expect(response.status, failure.name).toBe(500);
      expect(response.json(), failure.name).toEqual({ error: "internal server error" });
      expect(logs.join("\n"), failure.name).toContain("secret detail");
    }

    const logs: string[] = [];
    const inertEnrollment = { enroll: vi.fn(), poll: vi.fn(), approve: vi.fn(), deny: vi.fn() };
    const handler = createDemoEnrollmentHttpHandler({
      authorize: () => ({ ok: true }), enrollment: inertEnrollment as never,
      registry: { revokeActive: vi.fn() } as never, bootstrap: () => ({}), log: (line) => logs.push(line),
    });
    const badEncoding = await invoke(handler, "/admin/enrollments/%E0%A4%A/approve", "{}");
    expect(badEncoding.status).toBe(400);
    expect(badEncoding.json()).toEqual({ error: "malformed URL encoding" });
    const malformedJson = await invoke(handler, "/admin/enrollments/CODE/approve", "{broken");
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.json()).toEqual({ error: "invalid JSON body" });
    expect(logs).toEqual([]);
  });

  it("27: UI keeps the token memory-only, sends Authorization, and never embeds storage/URL/log sinks", async () => {
    const html = await source("packages/saas/reference/enrollment-ui.html");
    expect(html).toContain('let adminToken = ""');
    expect(html).toContain('"Authorization"');
    expect(html).not.toMatch(/localStorage|sessionStorage|URLSearchParams.*admin|console\.(?:log|error)\([^)]*adminToken/);
    const server = await source("packages/saas/reference/enrollment-server.ts");
    expect(server).not.toContain("template.replaceAll(\"{{ADMIN_TOKEN}}");
    expect(server).toContain('Access-Control-Allow-Headers", "Content-Type, Authorization"');
  });

  it("28: external template transports user code only through an escaped data attribute and uses text nodes for hostile response fields", async () => {
    const template = await source("packages/saas/reference/enrollment-ui.html");
    expect(template).toContain('data-user-code="{{USER_CODE}}"');
    expect(template).not.toContain('const userCode = "{{USER_CODE}}"');
    expect(template).toContain("statusEl.replaceChildren()");
    const dom = new JSDOM(template.replaceAll("{{USER_CODE}}", "&lt;/script&gt;&lt;script&gt;globalThis.pwned=1&lt;/script&gt;&lt;!--"), { runScripts: "outside-only" });
    expect(dom.window.document.querySelectorAll("script")).toHaveLength(1);
    expect(dom.window.document.body.dataset.userCode).toContain("</script><script>");
    expect(dom.window.document.querySelectorAll("img,svg,iframe,[onerror],[onclick^='alert']")).toHaveLength(0);
  });

  it("28: fallback template independently uses data attributes/textContent and contains no dynamic innerHTML sink", async () => {
    const server = await source("packages/saas/reference/enrollment-server.ts");
    const fallback = server.slice(server.indexOf("function fallbackApprovalTemplate"), server.indexOf("// ---------------------------------------------------------------------------\n// HTTP server"));
    expect(fallback).toContain('data-user-code="${displayCode}"');
    expect(fallback).toContain("document.body.dataset.userCode");
    expect(fallback).not.toMatch(/statusEl\.innerHTML\s*=.*result\./s);
    for (const payload of ["</script><script>alert(1)</script>", "<!--<img src=x onerror=alert(1)>"]) {
      const escaped = escapeAttribute(payload);
      const fragment = `<body data-user-code="${escaped}"><script>void 0</script><div id="status"></div></body>`;
      const dom = new JSDOM(fragment, { runScripts: "outside-only" });
      expect(dom.window.document.querySelectorAll("script")).toHaveLength(1);
      expect(dom.window.document.querySelectorAll("img,[onerror]")).toHaveLength(0);
    }
  });

  it("28: a forced external-template read failure selects fallbackApprovalTemplate", async () => {
    const fallback = vi.fn(() => '<body data-user-code="safe"><script>void 0</script></body>');
    const rendered = await renderApprovalTemplate({
      templatePath: "/missing/enrollment-ui.html",
      userCode: "</script><script>alert(1)</script><!--",
      readTemplate: async () => { throw new Error("forced read failure"); },
      fallback,
    });
    expect(fallback).toHaveBeenCalledWith("</script><script>alert(1)</script><!--");
    expect(rendered).toContain('data-user-code="safe"');
  });

  it("28: hostile approval response values traverse both real statusEl paths as text and cannot create DOM structure", async () => {
    const hostile = '<img src=x onerror="globalThis.pwned=1"><script>alert(1)</script>';
    const external = (await source("packages/saas/reference/enrollment-ui.html")).replaceAll("{{USER_CODE}}", "SAFE-CODE");
    const server = await source("packages/saas/reference/enrollment-server.ts");
    const fallbackSource = server.slice(server.indexOf("function fallbackApprovalTemplate"));
    const templateStart = fallbackSource.indexOf("return `") + 8;
    const templateEnd = fallbackSource.indexOf("`;", templateStart);
    const fallback = fallbackSource.slice(templateStart, templateEnd).replaceAll("${displayCode}", "SAFE-CODE");
    for (const [name, html] of [["external", external], ["forced-fallback", fallback]] as const) {
      const dom = await exerciseApprovalDom(html, hostile);
      const status = dom.window.document.getElementById("status")!;
      expect(status.querySelectorAll("img,script,[onerror]"), name).toHaveLength(0);
      expect(status.textContent, name).toContain(hostile);
    }
  });

  it("29: test bootstrap route does not accept caller-supplied agentPublicKey", async () => {
    const server = await source("packages/saas/reference/enrollment-server.ts");
    const route = server.slice(server.indexOf('if (path === "/test/bootstrap-jwt"'));
    expect(route).not.toMatch(/const \{[^}]*agentPublicKey/);
    expect(route).toContain("agentKeyRegistry.getActive");
  });

  it("21 and 24: all HTTP adapters reject missing accountId and the offline reset runbook names every credential path", async () => {
    for (const file of ["packages/saas/reference/enrollment-server.ts", "demo/saas-server.ts", "examples/webchannel-app/server/index.ts"]) {
      const text = await source(file);
      expect(text, file).toMatch(/!enrollRequest\.accountId/);
      expect(text, file).toContain("400");
    }
    const auth = await source("docs/AUTH.md");
    expect(auth).toContain('$HOME/.openclaw-webchannel/<account>/credentials.json');
    expect(auth).toContain("credentialPath");
    expect(auth).toContain('$HOME/.openclaw-webchannel/credentials.json');
    expect(auth).toContain("already-running transport continues using its old in-memory credentials");
  });

  it("31: real wire adapters exactly preserve the checked-in pre-P1-1 shapes", async () => {
    const fixture = JSON.parse(await source("packages/saas/src/fixtures/pre-p1-1-wire-shapes.json")) as Record<string, string[]>;
    const keys = (value: object) => Object.keys(value).sort();
    const request = serializeEnrollmentRequest({
      agentPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      accountId: "account",
      tenant: "tenant",
      pluginVersion: "0.2.0",
      protocolVersion: 1,
    });
    const response = serializeEnrollmentResponse({
      device_code: "device", user_code: "USER-CODE", verification_uri: "https://saas/enroll",
      verification_uri_complete: "https://saas/enroll?user_code=USER-CODE", expires_in: 600, interval: 5,
    });
    const sessionAbsent = serializeBootstrapResponse({ jwt: "jwt", peerId: "peer" }, null);
    const sessionPresent = serializeBootstrapResponse({ jwt: "jwt", peerId: "peer" }, "PIN");
    const rendezvousAbsent = serializeBootstrapResponse({ jwt: "jwt", peerId: "peer", natsUrl: "wss://nats" }, null);
    const rendezvousPresent = serializeBootstrapResponse({ jwt: "jwt", peerId: "peer", natsUrl: "wss://nats" }, "PIN");
    const absent = serializeBootstrapResponse({ jwt: "jwt", peerId: "peer", jwksUrl: "https://saas/jwks", natsUrl: "wss://nats" }, null);
    const present = serializeBootstrapResponse({ jwt: "jwt", peerId: "peer", jwksUrl: "https://saas/jwks", natsUrl: "wss://nats" }, "PIN");
    expect(keys(request)).toEqual(fixture.enrollmentRequest);
    expect(keys(response)).toEqual(fixture.enrollmentResponse);
    expect(keys(sessionAbsent)).toEqual(fixture.bootstrapSessionPinAbsent);
    expect(keys(sessionPresent)).toEqual(fixture.bootstrapSessionPinPresent);
    expect(keys(rendezvousAbsent)).toEqual(fixture.bootstrapRendezvousPinAbsent);
    expect(keys(rendezvousPresent)).toEqual(fixture.bootstrapRendezvousPinPresent);
    expect(keys(absent)).toEqual(fixture.bootstrapStandalonePinAbsent);
    expect(keys(present)).toEqual(fixture.bootstrapStandalonePinPresent);
    for (const wire of [request, response, sessionAbsent, sessionPresent, rendezvousAbsent, rendezvousPresent, absent, present]) {
      expect(wire).not.toHaveProperty("activationId");
      expect(wire).not.toHaveProperty("keyId");
      expect(wire).not.toHaveProperty("registry");
      expect(wire).not.toHaveProperty("agentId");
    }
  });
});
