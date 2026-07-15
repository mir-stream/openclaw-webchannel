import { describe, expect, it } from "vitest";

import { registerSubject, WebChannelNatsClient } from "./nats-client.js";

const key = {} as CryptoKey;

describe("WebChannelNatsClient mandatory registration", () => {
  it("uses the register-hop subject", () => {
    expect(registerSubject("tenant", "agent", "peer")).toBe(
      "webchannel.tenant.agent.peer.register",
    );
  });

  it("rejects construction without register material", () => {
    expect(
      () =>
        new WebChannelNatsClient({
          url: "ws://localhost",
          jwt: "jwt",
          accountId: "agent",
          tenant: "tenant",
          peerId: "peer",
        } as never),
    ).toThrow("registration is required");
  });

  it("accepts both required private keys", () => {
    expect(
      () =>
        new WebChannelNatsClient({
          url: "ws://localhost",
          jwt: "jwt",
          accountId: "agent",
          tenant: "tenant",
          peerId: "peer",
          registration: { devicePrivateKey: key, deviceX25519PrivateKey: key },
        }),
    ).not.toThrow();
  });
});
