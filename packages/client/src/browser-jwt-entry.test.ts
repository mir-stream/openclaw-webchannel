import { describe, expect, it, vi } from "vitest";

import {
  buildReferenceBootstrapRequest,
  resolveReferenceBootstrapTuple,
  runJwtRegister,
} from "./browser-jwt-entry.js";

describe("reference bootstrap tuple ownership", () => {
  it("never sends tenant/accountId as caller-chosen mint inputs", () => {
    expect(buildReferenceBootstrapRequest({
      devicePublicKey: "x-key",
      devicePopPublicKey: "pop-key",
      peerId: "peer",
    })).toEqual({
      devicePublicKey: "x-key",
      devicePopPublicKey: "pop-key",
      peerId: "peer",
    });
  });

  it("requires the server tuple and treats optional caller values only as assertions", () => {
    expect(resolveReferenceBootstrapTuple({ accountId: "acct", tenant: "tenant" }))
      .toEqual({ accountId: "acct", tenant: "tenant" });
    expect(() => resolveReferenceBootstrapTuple({ accountId: "acct" }))
      .toThrow(/missing fixed tenant\/accountId/);
    expect(() => resolveReferenceBootstrapTuple(
      { accountId: "acct", tenant: "tenant" },
      { accountId: "other" },
    )).toThrow(/accountId mismatch/);
    expect(() => resolveReferenceBootstrapTuple(
      { accountId: "acct", tenant: "tenant" },
      { tenant: "other" },
    )).toThrow(/tenant mismatch/);
  });

  it.each([
    ["account", { accountId: "expected-account", tenant: "fixed-tenant" }],
    ["tenant", { accountId: "fixed-account", tenant: "expected-tenant" }],
  ])("rejects a fixed-%s mismatch before client construction, dial, or subscription", async (_kind, expected) => {
    const connect = vi.fn();
    const onError = vi.fn();
    const onMessage = vi.fn();
    const sendUserMessage = vi.fn();
    const clientFactory = vi.fn(() => ({
      connect,
      disconnect: vi.fn(),
      onError,
      onMessage,
      sendUserMessage,
    }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jwt: "header.payload.signature",
      peerId: "fixed-peer",
      accountId: "fixed-account",
      tenant: "fixed-tenant",
      agentPublicKey: "agent-pin",
      natsUrl: "ws://server-owned-relay",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(runJwtRegister({
      natsUrl: "ws://fallback-relay",
      issuerUrl: "https://issuer.example",
      gwUrl: "unused",
      peerId: "fixed-peer",
      text: "must never send",
      ...expected,
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      clientFactory,
    })).rejects.toThrow(new RegExp(`${_kind}Id? mismatch|${_kind} mismatch`, "i"));

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});
