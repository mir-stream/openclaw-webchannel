import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createEnrollmentHttpHandler } from "./enrollment-http-handler.js";

async function invoke(outcome: unknown) {
  const handler = createEnrollmentHttpHandler({ profile: "demo", authorize: () => ({ ok: true }),
    enrollment: { enroll: async () => ({}), poll: async () => ({ error: "authorization_pending" }), approve: async () => outcome, deny: async () => false } as never,
    registry: { getActive: async () => null, register: async () => ({ ok: false, reason: "conflict", current: null }), revokeActive: async () => false, listHistory: async () => [] } });
  const req = Readable.from([JSON.stringify({})]) as IncomingMessage; Object.assign(req, { method: "POST", url: "/admin/enrollments/CODE/approve", headers: {} });
  let text = ""; const state = { sent: false, ended: false }; const res = { statusCode: 0,
    get headersSent() { return state.sent; }, get writableEnded() { return state.ended; }, setHeader() {},
    end(value?: string) { text = value ?? ""; state.sent = true; state.ended = true; },
  } as unknown as ServerResponse;
  await handler(req, res); return { status: res.statusCode, body: JSON.parse(text) };
}

describe("enrollment HTTP approve dispatch", () => {
  it("22: maps in_progress to a distinct 409 and never falls through as approved", async () => {
    expect(await invoke({ kind: "in_progress" })).toEqual({ status: 409, body: { error: "approval_in_progress", error_description: "Approval in progress, retry shortly" } });
  });
  it("keeps conflict distinct from in_progress", async () => {
    expect(await invoke({ kind: "conflict", existing: null, incoming: { keyIdFingerprint: "incoming" } })).toEqual({ status: 409, body: { error: "conflict", activationId: null, fingerprint: null, enrolledAt: null } });
  });
});
