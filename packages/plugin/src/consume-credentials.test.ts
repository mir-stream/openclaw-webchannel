import { describe, it, expect, vi } from "vitest";

import { consumeCredentialSource } from "./consume-credentials.js";
import type { NatsCredentialSource } from "./nats-credential-source.js";

describe("consumeCredentialSource", () => {
  it("enrolled + persisted creds → connects via the static path (NO enroll)", async () => {
    const transportFactory = vi.fn(() => {
      return {
        connect: vi.fn(async () => {}),
        connected: true,
      } as never;
    });
    const createEnrolled = vi.fn(); // must NOT be called

    const source: NatsCredentialSource = {
      mode: "enrolled",
      url: "ws://relay",
      saasBaseUrl: "http://s",
      tenant: "t",
      accountId: "a",
    };

    const result = await consumeCredentialSource(source, "acctA", {
      transportFactory,
      createEnrolled,
      makeSigner: () => async () => "sig",
      loadPersisted: () => ({ userJwt: "JWT", userSeed: "SEED" }),
    });

    expect(result.status).toBe("connected");
    expect(createEnrolled).not.toHaveBeenCalled();
    // Connected via the static branch with the persisted creds.
    expect(transportFactory).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://relay", jwtCredential: "JWT" }),
    );
  });

  it("enrolled + missing creds → creds-missing (no connect, no enroll)", async () => {
    const transportFactory = vi.fn();
    const createEnrolled = vi.fn();
    const source: NatsCredentialSource = {
      mode: "enrolled",
      url: "ws://relay",
      saasBaseUrl: "http://s",
      tenant: "t",
      accountId: "a",
    };

    const result = await consumeCredentialSource(source, "acctMissing", {
      transportFactory,
      createEnrolled,
      loadPersisted: () => undefined,
    });

    expect(result).toEqual({ status: "creds-missing", accountId: "acctMissing" });
    expect(transportFactory).not.toHaveBeenCalled();
    expect(createEnrolled).not.toHaveBeenCalled();
  });

  it("open source → delegates to connectNatsCredentialSource unchanged", async () => {
    const transportFactory = vi.fn(() => ({ connect: vi.fn(async () => {}) }) as never);
    const source: NatsCredentialSource = { mode: "open", url: "ws://open" };
    const result = await consumeCredentialSource(source, "default", { transportFactory });
    expect(result.status).toBe("connected");
    expect(transportFactory).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://open" }),
    );
  });

  it("static source → delegates to connectNatsCredentialSource unchanged", async () => {
    const transportFactory = vi.fn(() => ({ connect: vi.fn(async () => {}) }) as never);
    const makeSigner = vi.fn(() => async () => "sig");
    const source: NatsCredentialSource = {
      mode: "static",
      url: "ws://static",
      userJwt: "J",
      userSeed: "S",
    };
    const result = await consumeCredentialSource(source, "default", {
      transportFactory,
      makeSigner,
    });
    expect(result.status).toBe("connected");
    expect(transportFactory).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://static", jwtCredential: "J" }),
    );
  });
});
