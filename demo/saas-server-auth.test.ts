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

async function invoke(path: string, body: string, headers: Record<string, string> = {}) {
  const req = Readable.from([body]) as IncomingMessage;
  Object.assign(req, { method: "POST", url: path, headers: { host: "demo.test", ...headers } });
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

describe("demo enrollment admin authorization boundary", () => {
  async function login(username: string): Promise<string> {
    const response = await invoke("/login", JSON.stringify({ username, password: "demo" }), { "content-type": "application/json" });
    expect(response.status).toBe(200);
    return String(response.headers.get("set-cookie")).split(";", 1)[0];
  }

  it("accepts a real admin sid and rejects missing, non-admin, and bearer-only callers", async () => {
    const action = (headers: Record<string, string> = {}) => invoke("/admin/accounts/no-active-key/revoke", "{}", headers);
    expect((await action()).status).toBe(403);
    expect((await action({ authorization: "Bearer demo-bypass-attempt" })).status).toBe(403);
    expect((await action({ cookie: await login("alice") })).status).toBe(403);
    expect((await action({ cookie: await login("admin") })).status).toBe(404);
  });
});
