import { describe, expect, it } from "vitest";

import { WebChannelNatsClient } from "./nats-client.js";
import { WebChannelNATSClient } from "./nats-client-wrapper.js";

const privateKey = {} as CryptoKey;
const directBase = {
  url: "wss://nats.example",
  jwt: "bootstrap.jwt",
  accountId: "account",
  tenant: "tenant",
  peerId: "peer",
};

describe("required authenticated registration", () => {
  it("direct client rejects missing registration", () => {
    expect(() => new WebChannelNatsClient(directBase as never)).toThrow(/registration is required/);
  });

  it("direct client rejects either missing private key", () => {
    expect(() => new WebChannelNatsClient({
      ...directBase,
      registration: { deviceX25519PrivateKey: privateKey },
    } as never)).toThrow(/devicePrivateKey is required/);
    expect(() => new WebChannelNatsClient({
      ...directBase,
      registration: { devicePrivateKey: privateKey },
    } as never)).toThrow(/deviceX25519PrivateKey is required/);
  });

  it("direct client rejects an empty bootstrap jwt", () => {
    expect(() => new WebChannelNatsClient({
      ...directBase,
      jwt: "  ",
      registration: { devicePrivateKey: privateKey, deviceX25519PrivateKey: privateKey },
    })).toThrow(/non-empty bootstrap jwt/);
  });

  it("wrapper rejects missing registration", () => {
    expect(() => new WebChannelNATSClient({
      natsUrl: directBase.url,
      bootstrapJwt: directBase.jwt,
      accountId: directBase.accountId,
      tenant: directBase.tenant,
      peerId: directBase.peerId,
    } as never)).toThrow(/registration is required/);
  });

  it("wrapper rejects either missing private key", () => {
    const base = {
      natsUrl: directBase.url,
      bootstrapJwt: directBase.jwt,
      accountId: directBase.accountId,
      tenant: directBase.tenant,
      peerId: directBase.peerId,
    };
    expect(() => new WebChannelNATSClient({
      ...base,
      registration: { deviceX25519PrivateKey: privateKey },
    } as never)).toThrow(/devicePrivateKey is required/);
    expect(() => new WebChannelNATSClient({
      ...base,
      registration: { devicePrivateKey: privateKey },
    } as never)).toThrow(/deviceX25519PrivateKey is required/);
  });

  it("wrapper rejects an empty bootstrap jwt", () => {
    expect(() => new WebChannelNATSClient({
      natsUrl: directBase.url,
      bootstrapJwt: "",
      accountId: directBase.accountId,
      tenant: directBase.tenant,
      peerId: directBase.peerId,
      registration: { devicePrivateKey: privateKey, deviceX25519PrivateKey: privateKey },
    })).toThrow(/non-empty bootstrap jwt/);
  });
});
