import { describe, it, expect, vi } from "vitest";

import { consumeCredentialSource, resolveDialMaterial } from "./consume-credentials.js";
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
    // Connected via the static branch with the persisted creds. With NO persisted
    // natsUrl (pre-delivery creds), the resolver's `source.url` is the fallback.
    expect(transportFactory).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://relay", jwtCredential: "JWT" }),
    );
    if (result.status === "connected") expect(result.dialedUrl).toBe("ws://relay");
  });

  it("enrolled + persisted natsUrl → dials the SaaS-delivered URL, NOT source.url", async () => {
    // The load-bearing assertion for "the SaaS, not the operator, decides the
    // relay URL": when the persisted creds carry a SaaS-delivered `natsUrl`, the
    // consume path dials THAT and ignores the resolver/config `source.url`.
    const transportFactory = vi.fn(() => {
      return { connect: vi.fn(async () => {}), connected: true } as never;
    });

    const source: NatsCredentialSource = {
      mode: "enrolled",
      url: "ws://operator-configured-relay", // the local/config URL — must be ignored
      saasBaseUrl: "http://s",
      tenant: "t",
      accountId: "a",
    };

    const result = await consumeCredentialSource(source, "acctA", {
      transportFactory,
      makeSigner: () => async () => "sig",
      loadPersisted: () => ({
        userJwt: "JWT",
        userSeed: "SEED",
        natsUrl: "wss://saas-delivered-relay", // delivered with the minted creds
      }),
    });

    expect(result.status).toBe("connected");
    expect(transportFactory).toHaveBeenCalledWith(
      expect.objectContaining({ url: "wss://saas-delivered-relay", jwtCredential: "JWT" }),
    );
    // And explicitly NOT the operator-configured URL.
    expect(transportFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://operator-configured-relay" }),
    );
    if (result.status === "connected") {
      expect(result.dialedUrl).toBe("wss://saas-delivered-relay");
    }
  });

  it("F2: enrolled + persisted identityKey → surfaced on the connected result", async () => {
    const transportFactory = vi.fn(() => ({ connect: vi.fn(async () => {}), connected: true }) as never);
    const identityKey = {
      publicKey: new Uint8Array(32).fill(1),
      privateKey: new Uint8Array(32).fill(2),
    };
    const source: NatsCredentialSource = {
      mode: "enrolled",
      url: "ws://relay",
      saasBaseUrl: "http://s",
      tenant: "t",
      accountId: "a",
    };
    const result = await consumeCredentialSource(source, "acctA", {
      transportFactory,
      makeSigner: () => async () => "sig",
      loadPersisted: () => ({ userJwt: "JWT", userSeed: "SEED", identityKey }),
    });
    expect(result.status).toBe("connected");
    if (result.status === "connected") expect(result.identityKey).toBe(identityKey);
  });

  it("F2: enrolled without a persisted identityKey → connected result omits identityKey", async () => {
    const transportFactory = vi.fn(() => ({ connect: vi.fn(async () => {}), connected: true }) as never);
    const source: NatsCredentialSource = {
      mode: "enrolled",
      url: "ws://relay",
      saasBaseUrl: "http://s",
      tenant: "t",
      accountId: "a",
    };
    const result = await consumeCredentialSource(source, "acctA", {
      transportFactory,
      makeSigner: () => async () => "sig",
      loadPersisted: () => ({ userJwt: "JWT", userSeed: "SEED" }),
    });
    expect(result.status).toBe("connected");
    if (result.status === "connected") expect(result.identityKey).toBeUndefined();
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

describe("resolveDialMaterial (probe-safe)", () => {
  const base = { tenant: "t", accountId: "a", env: {} };

  it("surfaces the resolver's refusal of static creds as invalid material", () => {
    // BYO-NATS static credentials are refused until P0-3 lands, so the resolver
    // throws and the probe reports invalid material rather than a dial-able source.
    expect(resolveDialMaterial({ ...base, natsConfig: { url: "ws://static", credentials: { mode: "static", userJwt: "J", userSeed: "S" } } }).status).toBe("invalid");
  });

  it("prefers delivered relay URL and uses configured fallback", () => {
    const enrolled = (natsUrl?: string) => resolveDialMaterial({ ...base, natsConfig: { url: "ws://configured" }, loadCreds: () => ({ userJwt: "J", userSeed: "S", ...(natsUrl ? { natsUrl } : {}) }) });
    expect(enrolled("wss://delivered")).toMatchObject({ status: "ok", dial: { url: "wss://delivered" } });
    expect(enrolled()).toMatchObject({ status: "ok", dial: { url: "ws://configured" } });
  });

  it("maps absent or malformed persisted creds to creds-missing and resolver throws to invalid", () => {
    expect(resolveDialMaterial({ ...base, loadCreds: () => undefined })).toEqual({ status: "creds-missing", accountId: "a" });
    expect(resolveDialMaterial({ ...base, natsConfig: { credentials: { mode: "static", userJwt: "J" } } })).toMatchObject({ status: "invalid" });
  });
});
