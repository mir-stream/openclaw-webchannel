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

import { inboundSubject, outboundSubject, registerSubject } from "./nats-client.js";
import { sealMessage } from "./e2e-crypto-browser.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";
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
  it("reset-session timer-clear reentry cannot register or notify from the abandoned flow", async () => {
    let client: Awaited<ReturnType<typeof makeClient>>["client"] | undefined;
    let invalidated = false;
    const h = await makeClient({
      retryClearTimeout: () => {
        if (invalidated) return;
        invalidated = true;
        client!.disconnect();
        client!.connect();
      },
    });
    client = h.client;
    const K = new Uint8Array(32).fill(6);
    FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity);
    const errors: Error[] = [];
    let sessions = 0;
    h.client.onError((error) => errors.push(error));
    h.client.onSession(() => { sessions++; });
    // Give the first onConnected/resetSession an owned handle whose injected
    // clear hook synchronously replaces the raw connection generation.
    (h.client as unknown as { liveRetryTimer: ReturnType<typeof setTimeout> | null })
      .liveRetryTimer = 41 as unknown as ReturnType<typeof setTimeout>;

    h.client.connect();
    await settle(20);

    expect(invalidated).toBe(true);
    expect(FakeNatsWS.instances).toHaveLength(2);
    expect(FakeNatsWS.instances[0]!.readyState).toBe(FakeNatsWS.CLOSED);
    expect(FakeNatsWS.instances[0]!.published.some(
      (entry) => entry.subject === registerSubject(TENANT, AGENT, PEER),
    )).toBe(false);
    // One genuine PoP flow is exactly challenge + register.
    expect(FakeNatsWS.instances[1]!.published.filter(
      (entry) => entry.subject === registerSubject(TENANT, AGENT, PEER),
    )).toHaveLength(2);
    expect(sessions).toBe(1);
    expect(errors).toEqual([]);
    expect((h.client as unknown as { sessionKey: Uint8Array | null }).sessionKey).toBeTruthy();
    h.client.disconnect();
  });

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
      registerAgent(new Uint8Array(32), h.devicePublicRaw, h.identity, { omitWrappedKey: true, versions: { protocolVersion: WEBCHANNEL_PROTOCOL_VERSION } }),
      registerAgent(new Uint8Array(32).fill(4), h.devicePublicRaw, h.identity, { versions: { protocolVersion: WEBCHANNEL_PROTOCOL_VERSION } }),
    );
    h.client.onError((e) => errors.push(e));
    h.client.onProtocol(() => { if (!reentered) { reentered = true; h.client.disconnect(); h.client.connect(); } });
    h.client.connect(); await settle(12);
    expect(reentered).toBe(true); expect(errors).toEqual([]);
    expect(FakeNatsWS.instances.at(-1)!.readyState).toBe(FakeNatsWS.OPEN); h.client.disconnect();
  });

  it("sync disconnect+connect inside a drained inbound listener cannot leak the old epoch", async () => {
    const h = await makeClient();
    const K = new Uint8Array(32).fill(7);
    const outS = outboundSubject(TENANT, AGENT, PEER);
    let releaseReply!: () => void;
    const gate = new Promise<void>((resolve) => { releaseReply = resolve; });
    FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity, {
      beforeReply: async () => {
        // A sealed .out frame lands BEFORE the register reply delivers K, so it is
        // buffered in pendingInbound and only decrypted by drainPendingInbound().
        FakeNatsWS.instances[0]!.deliverToClient(
          outS,
          sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, { type: "agent_message", id: "m1", text: "hi" }),
        );
        await gate;
      },
    });
    let sessions = 0; const errors: Error[] = []; let torn = false;
    h.client.onSession(() => { sessions++; });
    h.client.onError((e) => errors.push(e));
    // The drained inbound listener synchronously tears down + redials — advancing
    // the epoch under the still-running register continuation.
    h.client.onMessage(() => { if (!torn) { torn = true; h.client.disconnect(); h.client.connect(); } });
    h.client.connect();
    h.client.sendUserMessage("queued-must-not-flush-on-old-epoch");
    await settle(6);
    releaseReply();
    await settle(16);
    expect(torn).toBe(true);
    // The old epoch's socket saw no flushed publish (flushQueue was epoch-guarded).
    expect(FakeNatsWS.instances[0]!.published.some((p) => p.subject === inboundSubject(TENANT, AGENT, PEER))).toBe(false);
    // Exactly one session notification — from the replacement connection, never the stale flow.
    expect(sessions).toBe(1);
    expect(errors).toEqual([]);
    const replacement = FakeNatsWS.instances.at(-1)!;
    expect(replacement.readyState).toBe(FakeNatsWS.OPEN);
    h.client.disconnect();
  });

  // P0-4 send-result-contract terminal model (updated): a register-path terminal
  // (here `omitWrappedKey` → the missing-wrappedConversationKey terminal) now
  // PERMANENTLY retires the instance. An error-listener that tries to reconnect
  // the SAME instance is REFUSED at connect() (the R5 guard in nats-client.ts:
  // "terminally retired"), so no replacement socket is ever dialed — the pre-P0-4
  // "old terminal branch closes the NEW socket" hazard is unreachable because no
  // NEW socket exists. What the epoch guard actually protects — a stale terminal
  // continuation cannot act — still holds: onError fires exactly once and the
  // instance never re-registers on a second socket. The stale-continuation guard
  // itself (retire-before-notify + generation-targeted disconnect) is unchanged
  // and remains proven by the other epoch tests above. Companion suite asserting
  // the same retirement contract at the wrapper layer:
  // nats-client-wrapper-sendstate.test.ts › "P0-4 permanent terminal retirement".
  it("a register-path terminal retires the instance; an error-listener disconnect+connect is refused and the stale continuation stays inert", async () => {
    const h = await makeClient(); let errors = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    FakeNatsWS.sharedHandler = handlerBySocket(
      registerAgent(new Uint8Array(32), h.devicePublicRaw, h.identity, { omitWrappedKey: true }),
      registerAgent(new Uint8Array(32).fill(5), h.devicePublicRaw, h.identity),
    );
    h.client.onError(() => { errors++; if (errors === 1) { h.client.disconnect(); h.client.connect(); } });
    h.client.connect(); await settle(12);
    expect(errors).toBe(1);
    // connect() was refused → no replacement dial; the retired socket is the only one.
    expect(FakeNatsWS.instances).toHaveLength(1);
    expect(FakeNatsWS.instances[0]!.readyState).toBe(FakeNatsWS.CLOSED);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("terminally retired"))).toBe(true);
    // The stale continuation never re-registered: exactly one socket ever published a register.
    const registered = FakeNatsWS.instances.filter((ws) => ws.published.some((p) => p.subject === registerSubject(TENANT, AGENT, PEER)));
    expect(registered).toHaveLength(1);
    warn.mockRestore();
    h.client.disconnect();
  });

  it("raw false invalidates a delayed terminal register continuation without error/session revival", async () => {
    const h = await makeClient(); let releaseReply!: () => void;
    const gate = new Promise<void>((resolve) => { releaseReply = resolve; });
    FakeNatsWS.sharedHandler = handlerBySocket(
      registerAgent(new Uint8Array(32), h.devicePublicRaw, h.identity, { omitWrappedKey: true, beforeReply: () => gate }),
      registerAgent(new Uint8Array(32).fill(8), h.devicePublicRaw, h.identity),
    );
    let errors = 0, sessions = 0;
    h.client.onError(() => { errors++; });
    h.client.onSession(() => { sessions++; });
    h.client.connect(); await settle(5);

    // The first socket dies while its register continuation is still pending.
    // #81 advances the mid-level epoch on raw false before reset/callbacks, so
    // even a terminal-shaped reply from that abandoned transport is stale.
    FakeNatsWS.instances[0]!.close();
    // Stop the raw client's ordinary scheduled reconnect so this test isolates
    // only the delayed continuation and never races a replacement dial.
    h.client.disconnect();
    releaseReply(); await settle(8);

    expect(errors).toBe(0);
    expect(sessions).toBe(0);
    expect(FakeNatsWS.instances).toHaveLength(1);
    expect(FakeNatsWS.instances[0]!.readyState).toBe(FakeNatsWS.CLOSED);
    // No replacement registered and no stale continuation installed a key.
    const registered = FakeNatsWS.instances.filter((ws) => ws.published.some((p) => p.subject === registerSubject(TENANT, AGENT, PEER)));
    expect(registered).toHaveLength(1);
    expect((h.client as unknown as { sessionKey: Uint8Array | null }).sessionKey).toBeNull();
    h.client.disconnect();
  });
});
