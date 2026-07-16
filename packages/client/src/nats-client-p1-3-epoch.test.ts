import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unwrapControl = vi.hoisted(() => ({ mode: "actual" as "actual" | "resolve" | "reject", release: undefined as (() => void) | undefined }));
vi.mock("./e2e-crypto-browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./e2e-crypto-browser.js")>();
  return {
    ...actual,
    unwrapConversationKey: async (...args: Parameters<typeof actual.unwrapConversationKey>) => {
      const mode = unwrapControl.mode;
      if (mode === "actual") return actual.unwrapConversationKey(...args);
      unwrapControl.mode = "actual";
      await new Promise<void>((resolve) => { unwrapControl.release = resolve; });
      if (mode === "reject") throw new Error("late unwrap rejection");
      return new Uint8Array(32).fill(99);
    },
  };
});

import { inboundSubject, registerSubject } from "./nats-client.js";
import {
  AGENT, FakeNatsWS, PEER, TENANT, installFakeWebSocket, makeClient,
  registerAgent, settle, type ServerHandler,
} from "./nats-client-wrapped.test-harness.js";

let restore: () => void;
beforeEach(() => { restore = installFakeWebSocket(); unwrapControl.mode = "actual"; unwrapControl.release = undefined; });
afterEach(() => restore());

function handlerBySocket(first: ServerHandler, later: ServerHandler): ServerHandler {
  return (s, p, server, reply) => (FakeNatsWS.instances.indexOf(server) === 0 ? first : later)(s, p, server, reply);
}

describe("P1-3 connection epoch guards", () => {
  it("disconnect during an in-flight register reply cannot install a key or flush", async () => {
    const h = await makeClient(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    FakeNatsWS.sharedHandler = registerAgent(new Uint8Array(32).fill(1), h.devicePublicRaw, h.identity, { beforeReply: () => gate });
    h.client.connect(); h.client.sendUserMessage("must-stay-unsent"); await settle(5);
    h.client.disconnect(); release(); await settle(5);
    expect((h.client as unknown as { sessionKey: Uint8Array | null }).sessionKey).toBeNull();
    expect(FakeNatsWS.instances.flatMap((ws) => ws.published).some((p) => p.subject === inboundSubject(TENANT, AGENT, PEER))).toBe(false);
  });

  it.each(["resolve", "reject"] as const)("late unwrap %s cannot damage the replacement flow", async (mode) => {
    const h = await makeClient(); const errors: Error[] = [];
    const firstKey = new Uint8Array(32).fill(2), newKey = new Uint8Array(32).fill(3);
    unwrapControl.mode = mode;
    FakeNatsWS.sharedHandler = handlerBySocket(
      registerAgent(firstKey, h.devicePublicRaw, h.identity),
      registerAgent(newKey, h.devicePublicRaw, h.identity),
    );
    h.client.onError((e) => errors.push(e)); h.client.connect();
    await vi.waitFor(() => expect(unwrapControl.release).toBeTypeOf("function"));
    h.client.disconnect(); h.client.connect(); await settle(8);
    const replacement = FakeNatsWS.instances.at(-1)!;
    expect(replacement.readyState).toBe(FakeNatsWS.OPEN);
    unwrapControl.release!(); await settle(4);
    expect(replacement.readyState).toBe(FakeNatsWS.OPEN);
    expect(errors).toEqual([]);
    expect((h.client as unknown as { sessionKey: Uint8Array | null }).sessionKey).toBeTruthy();
    h.client.disconnect();
  });

  it("protocol-listener disconnect+connect makes the missing-key branch stale", async () => {
    const h = await makeClient(); const errors: Error[] = []; let reentered = false;
    FakeNatsWS.sharedHandler = handlerBySocket(
      registerAgent(new Uint8Array(32), h.devicePublicRaw, h.identity, { omitWrappedKey: true, versions: { protocolVersion: 1 } }),
      registerAgent(new Uint8Array(32).fill(4), h.devicePublicRaw, h.identity, { versions: { protocolVersion: 1 } }),
    );
    h.client.onError((e) => errors.push(e));
    h.client.onProtocol(() => { if (!reentered) { reentered = true; h.client.disconnect(); h.client.connect(); } });
    h.client.connect(); await settle(12);
    expect(reentered).toBe(true); expect(errors).toEqual([]);
    expect(FakeNatsWS.instances.at(-1)!.readyState).toBe(FakeNatsWS.OPEN); h.client.disconnect();
  });

  it("error-listener disconnect+connect prevents the old terminal branch closing the new socket", async () => {
    const h = await makeClient(); let errors = 0;
    FakeNatsWS.sharedHandler = handlerBySocket(
      registerAgent(new Uint8Array(32), h.devicePublicRaw, h.identity, { omitWrappedKey: true }),
      registerAgent(new Uint8Array(32).fill(5), h.devicePublicRaw, h.identity),
    );
    h.client.onError(() => { errors++; if (errors === 1) { h.client.disconnect(); h.client.connect(); } });
    h.client.connect(); await settle(12);
    expect(errors).toBe(1); expect(FakeNatsWS.instances).toHaveLength(2);
    expect(FakeNatsWS.instances[1]!.readyState).toBe(FakeNatsWS.OPEN);
    expect(FakeNatsWS.instances[1]!.published.some((p) => p.subject === registerSubject(TENANT, AGENT, PEER))).toBe(true);
    h.client.disconnect();
  });
});
