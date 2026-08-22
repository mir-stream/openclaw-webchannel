import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceFlowEnrollment } from "openclaw-webchannel-saas";
import { createAccount } from "@nats-io/nkeys";
import { exampleAssert as assert, exampleTest } from "../../../scripts/example-test-guard.mjs";

exampleTest("I132-E4: webchannel app preserves enrollment validation semantics", async () => {

const trustRoot = mkdtempSync(join(tmpdir(), "openclaw-example-enroll-validation-"));
process.env.TRUST_CHAIN_PATH = join(trustRoot, "trust-chain.json");
process.env.RELAY = "synadia";
process.env.NATS_URL = "wss://example.invalid";
process.env.NATS_ACCOUNT_ID = createAccount().getPublicKey();
process.env.NATS_ACCOUNT_SIGNING_SEED = new TextDecoder().decode(createAccount().getSeed());
process.env.ENROLLMENT_ADMIN_TOKEN = "secret-token";

const { exampleAppRequestHandler, createExampleEnrollmentHandler } = await import("../server/index.ts");
const VALID_AGENT_PUBLIC_KEY = "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo";
const SECOND_AGENT_PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function invoke(body: unknown, url = "/api/enroll", authorization?: string, handler = exampleAppRequestHandler) {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  Object.assign(req, { method: "POST", url, headers: { host: "example.test", ...(authorization ? { authorization } : {}) } });
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
  handler(req, res);
  while (!state.writableEnded) await new Promise<void>((resolve) => setImmediate(resolve));
  return { status: res.statusCode, body: JSON.parse(responseBody) as { error?: string } };
}

try {
  const malformed = await invoke({ agentPublicKey: "malformed-key", tenant: "tenant", accountId: "account" });
  assert.deepEqual(malformed, {
    status: 400,
    body: { error: "webchannel: agentPublicKey must be base64url of a 32-byte X25519 public key" },
  });
  console.log("ok - malformed agentPublicKey returns intentional 400");

  const originalEnroll = DeviceFlowEnrollment.prototype.enroll;
  DeviceFlowEnrollment.prototype.enroll = async function () {
    throw new Error("sensitive store failure");
  };
  const failed = await invoke({ agentPublicKey: VALID_AGENT_PUBLIC_KEY, tenant: "tenant", accountId: "account" });
  DeviceFlowEnrollment.prototype.enroll = originalEnroll;
  assert.deepEqual(failed, { status: 500, body: { error: "Internal server error" } });
  assert.doesNotMatch(JSON.stringify(failed.body), /sensitive store failure/);
  console.log("ok - non-validation enrollment failure remains sanitized 500");

  const noTokenHandler = createExampleEnrollmentHandler({
    enrollment: { approve: async () => ({ kind: "rejected" }), deny: async () => false } as never,
    registry: { revokeActive: async () => false },
  });
  for (const [url, body] of [["/admin/enrollments/CODE/approve", {}], ["/admin/enrollments/CODE/deny", {}], ["/revoke", { tenant: "tenant", accountId: "account" }]] as const) {
    assert.equal((await invoke(body, url, undefined, noTokenHandler)).status, 503);
    assert.equal((await invoke(body, url, "Bearer wrong", noTokenHandler)).status, 503);
    assert.equal((await invoke(body, url, undefined)).status, 401);
    assert.equal((await invoke(body, url, "Bearer wrong")).status, 401);
  }
  console.log("ok - approve, deny, and revoke fail closed and reject bad bearer tokens");

  const first = await invoke({ agentPublicKey: VALID_AGENT_PUBLIC_KEY, tenant: "tenant", accountId: "replacement-account" });
  const firstCode = (first.body as { user_code: string }).user_code;
  assert.equal((await invoke({}, `/admin/enrollments/${firstCode}/approve`, "Bearer secret-token")).status, 200);
  const second = await invoke({ agentPublicKey: SECOND_AGENT_PUBLIC_KEY, tenant: "tenant", accountId: "replacement-account" });
  const secondCode = (second.body as { user_code: string }).user_code;
  const conflict = await invoke({}, `/admin/enrollments/${secondCode}/approve`, "Bearer secret-token");
  assert.equal(conflict.status, 409);
  assert.deepEqual(Object.keys(conflict.body).sort(), ["activationId", "enrolledAt", "error", "fingerprint"]);
  const activationId = (conflict.body as { activationId: string }).activationId;
  const confirmed = await invoke({ replaceActivationId: activationId }, `/admin/enrollments/${secondCode}/approve`, "Bearer secret-token");
  assert.equal(confirmed.status, 200);
  assert.equal((confirmed.body as { approved: boolean }).approved, true);
  console.log("ok - conflict response confirms replacement through replaceActivationId");
} catch (error) {
  console.error(error);
  throw error;
} finally {
  rmSync(trustRoot, { recursive: true, force: true });
}
});
