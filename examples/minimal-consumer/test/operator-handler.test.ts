import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { EnrollmentValidationError } from "@mir-stream/webchannel-saas";
import { createMinimalConsumerEnrollmentHandler } from "../src/operator.ts";

async function invoke(handler: ReturnType<typeof createMinimalConsumerEnrollmentHandler>, path: string, value: unknown, authorization?: string) {
  const req = Readable.from([JSON.stringify(value)]) as IncomingMessage;
  Object.assign(req, { method: "POST", url: path, headers: authorization ? { authorization } : {} });
  let responseBody = "";
  const headers = new Map<string, string>();
  const state = { headersSent: false, writableEnded: false };
  const res = {
    statusCode: 200,
    get headersSent() { return state.headersSent; },
    get writableEnded() { return state.writableEnded; },
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    end(value?: string) { responseBody = value ?? ""; state.headersSent = true; state.writableEnded = true; },
  } as unknown as ServerResponse;
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(responseBody) as Record<string, unknown> };
}

const conflict = {
  kind: "conflict",
  existing: { activationId: "activation-1", keyIdFingerprint: "fingerprint", enrolledAt: 123 },
} as const;
const approveCalls: Array<[string, { replaceActivationId?: string }]> = [];
const enrollment = {
  enroll: async () => { throw new EnrollmentValidationError("invalid enrollment"); },
  poll: async () => ({ error: "authorization_pending" }),
  approve: async (code: string, options: { replaceActivationId?: string }) => {
    approveCalls.push([code, options]);
    return options.replaceActivationId
      ? { kind: "approved", result: { peerId: "peer" } } as const
      : conflict;
  },
  deny: async () => true,
};
const registry = { revokeActive: async () => true };

for (const [path, body] of [["/approve", { user_code: "CODE" }], ["/deny", { user_code: "CODE" }], ["/revoke", { tenant: "tenant", accountId: "account" }]] as const) {
  const missing = createMinimalConsumerEnrollmentHandler({ enrollment: enrollment as never, registry, bootstrap: () => ({}) });
  assert.equal((await invoke(missing, path, body)).status, 503);
  const configured = createMinimalConsumerEnrollmentHandler({ adminToken: "secret-token", enrollment: enrollment as never, registry, bootstrap: () => ({}) });
  assert.equal((await invoke(configured, path, body)).status, 401);
  assert.equal((await invoke(configured, path, body, "Bearer wrong")).status, 401);
}
console.log("ok - approve, deny, and revoke fail closed and reject bad bearer tokens");

const handler = createMinimalConsumerEnrollmentHandler({ adminToken: "secret-token", enrollment: enrollment as never, registry, bootstrap: () => ({}) });
const first = await invoke(handler, "/approve", { user_code: "CODE" }, "Bearer secret-token");
assert.equal(first.status, 409);
assert.deepEqual(first.body, { error: "conflict", activationId: "activation-1", fingerprint: "fingerprint", enrolledAt: 123 });
const confirmed = await invoke(handler, "/approve", { user_code: "CODE", replaceActivationId: first.body.activationId }, "Bearer secret-token");
assert.equal(confirmed.status, 200);
assert.deepEqual(confirmed.body, { approved: true, peerId: "peer" });
assert.deepEqual(approveCalls.at(-1), ["CODE", { replaceActivationId: "activation-1" }]);
console.log("ok - conflict response confirms replacement through replaceActivationId");

assert.deepEqual(await invoke(handler, "/enroll", {}), { status: 400, body: { error: "invalid enrollment" } });
console.log("ok - EnrollmentValidationError maps to 400");
