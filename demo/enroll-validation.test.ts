import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.TRUST_CHAIN_PATH = `/tmp/openclaw-demo-enroll-validation-${process.pid}.json`;
});
import { DeviceFlowEnrollment } from "../packages/saas/src/device-flow-enrollment.js";
import { demoSaasRequestHandler } from "./saas-server.js";

const VALID_AGENT_PUBLIC_KEY = "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo";

async function invoke(body: unknown) {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  Object.assign(req, { method: "POST", url: "/api/enroll", headers: { host: "demo.test" } });
  let responseBody = "";
  const state = { headersSent: false, writableEnded: false };
  const res = {
    statusCode: 200,
    get headersSent() { return state.headersSent; },
    get writableEnded() { return state.writableEnded; },
    setHeader() { return this; },
    writeHead(status: number) { this.statusCode = status; state.headersSent = true; return this; },
    end(value?: string) { responseBody = value ?? ""; state.headersSent = true; state.writableEnded = true; },
  } as unknown as ServerResponse;
  await demoSaasRequestHandler(req, res);
  await vi.waitFor(() => expect(state.writableEnded).toBe(true));
  return { status: res.statusCode, body: JSON.parse(responseBody) as { error?: string } };
}

afterEach(() => vi.restoreAllMocks());

describe("demo /api/enroll validation boundary", () => {
  it("returns the intentional validation error as 400", async () => {
    const response = await invoke({ agentPublicKey: "malformed-key", tenant: "tenant", accountId: "account" });
    expect(response).toEqual({
      status: 400,
      body: { error: "webchannel: agentPublicKey must be base64url of a 32-byte X25519 public key" },
    });
  });

  it("keeps non-validation enrollment failures sanitized as 500", async () => {
    vi.spyOn(DeviceFlowEnrollment.prototype, "enroll").mockRejectedValueOnce(
      new Error("sensitive store failure"),
    );
    const response = await invoke({ agentPublicKey: VALID_AGENT_PUBLIC_KEY, tenant: "tenant", accountId: "account" });
    expect(response).toEqual({ status: 500, body: { error: "Internal server error" } });
    expect(JSON.stringify(response.body)).not.toContain("sensitive store failure");
  });
});
