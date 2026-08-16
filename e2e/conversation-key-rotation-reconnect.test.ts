import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FakeNatsWS,
  TENANT,
  AGENT,
  PEER,
  installFakeWebSocket,
  makeClient,
  registerAgent,
  settle,
} from "../packages/client/src/nats-client-wrapped.test-harness.js";
import {
  inboundSubject,
  outboundSubject,
  registerSubject,
  type WebChannelNatsClient,
} from "../packages/client/src/nats-client.js";
import { ConversationKeyStore } from "../packages/plugin/src/conversation-key-store.js";
import {
  openEnvelope,
  sealEnvelope,
} from "../packages/plugin/src/e2e-session.js";

describe("conversation-key rotation browser reconnect", () => {
  let home: string;
  let restoreWebSocket: (() => void) | undefined;
  let client: WebChannelNatsClient | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "webchannel-rotation-reconnect-"));
    restoreWebSocket = installFakeWebSocket();
  });

  afterEach(() => {
    client?.disconnect();
    client = undefined;
    restoreWebSocket?.();
    restoreWebSocket = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("re-registers the production browser client and replaces K_old with K_new", async () => {
    const store = new ConversationKeyStore({
      tenant: TENANT,
      accountId: AGENT,
      home,
    });
    const oldKey = store.getOrCreate(PEER);
    const browser = await makeClient({ reconnect: true });
    client = browser.client;

    // Each register request reads the durable key at reply time. This mirrors
    // the production register handler while keeping the reconnect itself on the
    // real WebChannelNatsClient implementation.
    FakeNatsWS.sharedHandler = async (subject, payload, server, replyTo) => {
      const durableKey = store.get(PEER);
      if (!durableKey) throw new Error("fixture peer disappeared");
      await registerAgent(
        durableKey,
        browser.devicePublicRaw,
        browser.identity,
      )(subject, payload, server, replyTo);
    };

    client.connect();
    await settle(16);
    expect(FakeNatsWS.instances).toHaveLength(1);
    const firstSocket = FakeNatsWS.instances[0]!;

    const firstId = client.sendUserMessage("before rotation");
    await settle(4);
    const inbound = inboundSubject(TENANT, AGENT, PEER);
    const oldWire = firstSocket.published.filter(
      (publication) => publication.subject === inbound,
    );
    expect(oldWire).toHaveLength(1);
    expect(openEnvelope(Buffer.from(oldWire[0]!.payload), oldKey).message)
      .toMatchObject({ type: "user_message", text: "before rotation" });

    // Retire the first send so reconnect does not need to replay it; the next
    // socket's single inbound frame then proves exactly which K it received.
    firstSocket.deliverToClient(
      outboundSubject(TENANT, AGENT, PEER),
      sealEnvelope(
        { tenant: TENANT, accountId: AGENT, sub: PEER },
        oldKey,
        { type: "ack", ids: [firstId] },
      ).toString("utf8"),
    );
    await settle(2);

    const rotated = store.rotate(PEER);
    expect(Buffer.from(rotated.key).equals(Buffer.from(oldKey))).toBe(false);
    firstSocket.close();
    await settle(20);

    expect(FakeNatsWS.instances.length).toBeGreaterThanOrEqual(2);
    const reconnectedSocket = FakeNatsWS.instances.at(-1)!;
    const registerRequests = reconnectedSocket.published.filter(
      (publication) =>
        publication.subject === registerSubject(TENANT, AGENT, PEER),
    );
    expect(registerRequests.some((publication) => {
      const body = JSON.parse(publication.payload) as { op?: unknown };
      return body.op === "register";
    })).toBe(true);

    const received: unknown[] = [];
    client.onMessage((message) => received.push(message));
    reconnectedSocket.deliverToClient(
      outboundSubject(TENANT, AGENT, PEER),
      sealEnvelope(
        { tenant: TENANT, accountId: AGENT, sub: PEER },
        rotated.key,
        { type: "agent_message", text: "after reconnect" },
      ).toString("utf8"),
    );
    await settle(2);
    expect(received).toEqual([
      { type: "agent_message", text: "after reconnect" },
    ]);

    client.sendUserMessage("after rotation");
    await settle(4);
    const newWire = reconnectedSocket.published.filter(
      (publication) => publication.subject === inbound,
    );
    expect(newWire).toHaveLength(1);
    expect(openEnvelope(Buffer.from(newWire[0]!.payload), rotated.key).message)
      .toMatchObject({ type: "user_message", text: "after rotation" });
    expect(() => openEnvelope(Buffer.from(newWire[0]!.payload), oldKey))
      .toThrow();
  });
});
