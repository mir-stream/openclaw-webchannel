import { describe, expect, it, vi } from "vitest";
import { runDemo } from "./browser-demo-entry.js";

import {
  buildReferenceBootstrapRequest,
  resolveReferenceBootstrapTuple,
  runJwtRegister,
  runAllReal,
} from "./browser-jwt-entry.js";

it.each(["reference", "all-real", "demo"])("#415 E8: %s never creates an exportable device private key", async entry => {
  const generate = crypto.subtle.generateKey.bind(crypto.subtle);
  const pairs: CryptoKeyPair[] = [];
  const spy = vi.spyOn(crypto.subtle, "generateKey").mockImplementation(async (...args: Parameters<typeof generate>) => {
    const pair = await generate(...args) as CryptoKeyPair;
    pairs.push(pair);
    return pair;
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("stop after key generation"));
  const opts = { natsUrl: "ws://unused", issuerUrl: "https://issuer.test", gwUrl: "unused", accountId: "a", tenant: "t", peerId: "p", text: "hello" };
  try {
    const result = entry === "reference" ? runJwtRegister(opts)
      : entry === "all-real" ? runAllReal(opts)
      : runDemo(opts, { onReply: () => {}, onError: () => {}, onStatus: () => {} });
    await expect(result).rejects.toThrow("stop after key generation");
    const device = pairs.find(pair => pair.privateKey.algorithm.name === "X25519")!;
    expect(device).toBeDefined();
    expect(device.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", device.privateKey)).rejects.toThrow();
    expect((await crypto.subtle.exportKey("raw", device.publicKey)).byteLength).toBe(32);
  } finally {
    spy.mockRestore(); fetchSpy.mockRestore();
  }
});

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
