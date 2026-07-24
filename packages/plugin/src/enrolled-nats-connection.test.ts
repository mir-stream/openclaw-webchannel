import { describe, expect, it, vi } from "vitest";

import { createEnrolledNatsConnection } from "./enrolled-nats-connection.js";
import {
  completeJwtHandshake,
  createConnectorTransportHarness,
} from "./nats-connect-cleanup-test-helper.js";

function enrolledClient() {
  const identityKey = { publicKey: "pub", privateKey: "priv" };
  const enrollment = {
    creds: { userJwt: "jwt", userSeed: "seed" },
    peerId: "agent",
    jwksUrl: "https://saas/.well-known/jwks.json",
    bootstrapUrl: "https://saas/bootstrap",
    natsUrl: "wss://relay",
  };
  return {
    credentials: { marker: true },
    enroll: vi.fn().mockResolvedValue(enrollment),
    getIdentityKey: vi.fn().mockReturnValue(identityKey),
  };
}

describe("createEnrolledNatsConnection cleanup", () => {
  it.each([
    ["tenant", { tenant: "invalid.tenant" }, "storage.tenant"],
    ["account", { accountId: "../../unsafe" }, "storage.accountId"],
  ] as const)(
    "rejects invalid binding %s before invoking any injected dependency",
    async (_label, override, expectedField) => {
      const enrollmentClientFactory = vi.fn();
      const transportFactory = vi.fn();
      const makeSigner = vi.fn();
      await expect(
        createEnrolledNatsConnection(
          {
            saasBaseUrl: "https://saas",
            saasEnrollUrl: "https://saas/api/enroll",
            saasPollUrl: "https://saas/api/poll",
            natsUrl: "wss://must-not-dial",
            tenant: "tenant",
            accountId: "account",
            ...override,
          },
          {
            enrollmentClientFactory,
            transportFactory,
            makeSigner,
          },
        ),
      ).rejects.toThrow(expectedField);
      expect(enrollmentClientFactory).not.toHaveBeenCalled();
      expect(transportFactory).not.toHaveBeenCalled();
      expect(makeSigner).not.toHaveBeenCalled();
    },
  );

  it("rejects split SaaS endpoints before invoking an injected client factory", async () => {
    const enrollmentClientFactory = vi.fn();
    const transportFactory = vi.fn();
    await expect(
      createEnrolledNatsConnection(
        {
          saasBaseUrl: "https://binding-authority.example",
          saasEnrollUrl:
            "https://different-acquisition.example/api/enroll",
          saasPollUrl:
            "https://different-acquisition.example/api/poll",
          natsUrl: "wss://must-not-dial",
          tenant: "tenant",
          accountId: "account",
        },
        { enrollmentClientFactory, transportFactory },
      ),
    ).rejects.toThrow(
      /enrollment endpoints do not match saasBaseUrl fields=saasEnrollUrl,saasPollUrl/,
    );
    expect(enrollmentClientFactory).not.toHaveBeenCalled();
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("rejects missing delivered relay before identity, signer, transport, or dial", async () => {
    const getIdentityKey = vi.fn();
    const makeSigner = vi.fn();
    const transportFactory = vi.fn();
    const enrollmentClient = {
      credentials: { marker: true },
      enroll: vi.fn().mockResolvedValue({
        creds: { userJwt: "jwt", userSeed: "seed" },
        peerId: "agent",
        jwksUrl: "https://saas/.well-known/jwks.json",
        bootstrapUrl: "https://saas/bootstrap",
      }),
      getIdentityKey,
    };

    await expect(
      createEnrolledNatsConnection(
        {
          saasBaseUrl: "https://saas",
          saasEnrollUrl: "https://saas/api/enroll",
          saasPollUrl: "https://saas/api/poll",
          natsUrl: "wss://must-not-fallback",
          tenant: "tenant",
          accountId: "account",
        },
        {
          enrollmentClientFactory: () => enrollmentClient as never,
          makeSigner,
          transportFactory,
        },
      ),
    ).rejects.toMatchObject({
      code: "credentials-invalid-invalid-document",
      fields: ["enrollment.natsUrl"],
    });
    expect(getIdentityKey).not.toHaveBeenCalled();
    expect(makeSigner).not.toHaveBeenCalled();
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it.each(["signer", "protocol", "timeout"] as const)(
    "retires a real production transport and preserves the %s failure",
    async (failure) => {
      vi.useFakeTimers();
      try {
        const signerError = new Error("NKEY signer rejected");
        let signerRejects = failure === "signer";
        const harness = createConnectorTransportHarness();
        const connecting = createEnrolledNatsConnection({
          saasBaseUrl: "https://saas",
          saasEnrollUrl: "https://saas/api/enroll",
          saasPollUrl: "https://saas/api/poll",
          natsUrl: "wss://fallback",
          tenant: "tenant",
          accountId: "account",
        }, {
          enrollmentClientFactory: () => enrolledClient() as never,
          transportFactory: harness.transportFactory,
          makeSigner: () => async () => {
            if (signerRejects) throw signerError;
            return "signature";
          },
        });
        const rejection = connecting.then(
          () => undefined,
          (error: unknown) => error,
        );
        await Promise.resolve();
        await Promise.resolve();
        const transport = harness.transport();
        const socket = harness.sockets[0]!;
        socket.open();
        transport.subscribe("pre.failure.subscription");

        if (failure === "signer") {
          socket.server('INFO {"nonce":"n"}\r\n');
        } else if (failure === "protocol") {
          socket.server('INFO {"nonce":"n"}\r\n');
          await Promise.resolve();
          await Promise.resolve();
          socket.server("-ERR 'Authorization Violation'\r\n");
        } else {
          await vi.advanceTimersByTimeAsync(25);
        }

        const rejected = await rejection;
        if (failure === "signer") expect(rejected).toBe(signerError);
        if (failure === "protocol") {
          expect(rejected).toBeInstanceOf(Error);
          expect((rejected as Error).message).toContain("Authorization Violation");
        }
        if (failure === "timeout") {
          expect(rejected).toBeInstanceOf(Error);
          expect((rejected as Error).message).toContain("handshake timeout in phase INFO");
        }

        expect(socket.readyState).toBe(3);
        expect(socket.closeCalls).toBeGreaterThan(0);
        expect(transport.connected).toBe(false);
        expect(() => transport.publish("must.not.send", "x")).toThrow(/not connected/);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(harness.sockets).toHaveLength(1);

        signerRejects = false;
        const reused = transport.connect();
        await completeJwtHandshake(harness.sockets[1]!);
        await reused;
        const reconnected = new Promise<void>((resolve) => transport.once("reconnect", resolve));
        harness.sockets[1]!.close();
        await vi.advanceTimersByTimeAsync(5);
        await completeJwtHandshake(harness.sockets[2]!);
        await reconnected;
        expect(harness.sockets[2]!.sent.filter(
          (frame) => typeof frame === "string" && frame.startsWith("SUB "),
        )).toEqual([]);
        transport.disconnect();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("leaves a successfully connected transport live", async () => {
    const transport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const identityKey = { publicKey: "pub", privateKey: "priv" };
    const enrollment = {
      creds: { userJwt: "jwt", userSeed: "seed" },
      peerId: "agent",
      jwksUrl: "https://saas/.well-known/jwks.json",
      bootstrapUrl: "https://saas/bootstrap",
      natsUrl: "wss://relay",
    };
    const enrollmentClient = {
      credentials: { marker: true },
      enroll: vi.fn().mockResolvedValue(enrollment),
      getIdentityKey: vi.fn().mockReturnValue(identityKey),
    };

    const result = await createEnrolledNatsConnection({
      saasBaseUrl: "https://saas",
      saasEnrollUrl: "https://saas/api/enroll",
      saasPollUrl: "https://saas/api/poll",
      natsUrl: "wss://fallback",
      tenant: "tenant",
      accountId: "account",
    }, {
      enrollmentClientFactory: () => enrollmentClient as never,
      transportFactory: () => transport as never,
      makeSigner: vi.fn().mockReturnValue(async () => "signature"),
    });

    expect(result.transport).toBe(transport);
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(transport.disconnect).not.toHaveBeenCalled();
  });

  it("leaves a successfully connected production transport/socket live", async () => {
    const harness = createConnectorTransportHarness();
    const connecting = createEnrolledNatsConnection({
      saasBaseUrl: "https://saas",
      saasEnrollUrl: "https://saas/api/enroll",
      saasPollUrl: "https://saas/api/poll",
      natsUrl: "wss://fallback",
      tenant: "tenant",
      accountId: "account",
    }, {
      enrollmentClientFactory: () => enrolledClient() as never,
      transportFactory: harness.transportFactory,
      makeSigner: () => async () => "signature",
    });
    await Promise.resolve();
    await Promise.resolve();
    await completeJwtHandshake(harness.sockets[0]!);
    const result = await connecting;
    expect(result.transport).toBe(harness.transport());
    expect(result.transport.connected).toBe(true);
    expect(harness.sockets[0]!.closeCalls).toBe(0);
    result.transport.subscribe("still.live");
    expect(harness.sockets[0]!.sent).toContain("SUB still.live 1\r\n");
    result.transport.disconnect();
  });
});
