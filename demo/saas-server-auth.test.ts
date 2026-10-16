import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

const trustRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "openclaw-demo-auth-"));
  process.env.TRUST_CHAIN_PATH = join(root, "trust-chain.json");
  return root;
});
import { demoSaasRequestHandler } from "./saas-server.js";

afterAll(() => rmSync(trustRoot, { recursive: true, force: true }));

async function invoke(path: string, body: string, headers: Record<string, string> = {}, method = "POST") {
  const req = Readable.from([body]) as IncomingMessage;
  Object.assign(req, { method, url: path, headers: { host: "demo.test", ...headers } });
  const responseHeaders = new Map<string, string | number | readonly string[]>();
  let responseBody = "";
  const state = { headersSent: false, writableEnded: false };
  const res = {
    statusCode: 200,
    get headersSent() { return state.headersSent; },
    get writableEnded() { return state.writableEnded; },
    setHeader(name: string, value: string | number | readonly string[]) { responseHeaders.set(name.toLowerCase(), value); },
    writeHead(status: number) { this.statusCode = status; state.headersSent = true; return this; },
    end(value?: string) { responseBody = value ?? ""; state.headersSent = true; state.writableEnded = true; },
  } as unknown as ServerResponse;
  await demoSaasRequestHandler(req, res);
  // The legacy login route uses event callbacks; allow its end callback to run.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { status: res.statusCode, body: responseBody, headers: responseHeaders };
}

async function login(username: string): Promise<string> {
  const response = await invoke("/login", JSON.stringify({ username, password: "demo" }), { "content-type": "application/json" });
  expect(response.status).toBe(200);
  return String(response.headers.get("set-cookie")).split(";", 1)[0];
}

describe("demo enrollment admin authorization boundary", () => {
  it("accepts a real admin sid and rejects missing, non-admin, and bearer-only callers", async () => {
    const action = (headers: Record<string, string> = {}) => invoke("/admin/accounts/no-active-key/revoke", "{}", headers);
    expect((await action()).status).toBe(403);
    expect((await action({ authorization: "Bearer demo-bypass-attempt" })).status).toBe(403);
    expect((await action({ cookie: await login("alice") })).status).toBe(403);
    expect((await action({ cookie: await login("admin") })).status).toBe(404);
  });
});

describe("demo current-session logout", () => {
  it.each(["alice", "admin"])("invalidates %s's sid, expires its cookie and permits a fresh login", async username => {
    const cookie = await login(username);
    const otherDevice = await login(username);
    expect((await invoke("/me", "", { cookie }, "GET")).status).toBe(200);
    const response = await invoke("/logout", "{}", { cookie });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toBe("sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
    // Replay the captured sid to prove server-side invalidation independently
    // of the browser honoring the expired cookie.
    expect((await invoke("/me", "", { cookie }, "GET")).status).toBe(401);
    expect((await invoke("/nats-user", "{}", { cookie })).status).toBe(401);
    expect((await invoke("/bootstrap", "{}", { cookie })).status).toBe(401);
    expect((await invoke("/logout", "{}", { cookie })).status).toBe(401);
    expect((await invoke("/me", "", { cookie: otherDevice }, "GET")).status).toBe(200);
    const fresh = await login(username);
    expect(fresh).not.toBe(cookie);
    expect((await invoke("/me", "", { cookie: fresh }, "GET")).status).toBe(200);
  });

  it("requires POST and a real session cookie, ignoring body and bearer session selectors", async () => {
    const cookie = await login("alice");
    const get = await invoke("/logout", "", { cookie }, "GET");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(get.headers.has("set-cookie")).toBe(false);
    expect((await invoke("/logout", JSON.stringify({ sid: cookie.slice(4) }))).status).toBe(401);
    expect((await invoke("/logout", "{}", { authorization: `Bearer ${cookie.slice(4)}` })).status).toBe(401);
    expect((await invoke("/logout", "{}", { cookie: "sid=unknown" })).status).toBe(401);
    expect((await invoke("/me", "", { cookie }, "GET")).status).toBe(200);
  });
});
