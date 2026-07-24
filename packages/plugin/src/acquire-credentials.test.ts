import { describe, it, expect, vi } from "vitest";
import { acquireCredentials } from "./acquire-credentials.js";
import { accountCredentialPath } from "./account-config.js";
import { EnrollmentClient } from "./enrollment-client.js";

const HOME = "/home/test";

function fakeEnrollmentResult() {
  return {
    creds: { userJwt: "JWT", userSeed: "SEED" },
    peerId: "peer-1",
    jwksUrl: "http://s/.well-known/jwks.json",
    bootstrapUrl: "http://s/bootstrap",
  };
}

describe("acquireCredentials", () => {
  it.each([
    ["tenant", { tenant: "invalid.tenant" }, "storage.tenant"],
    ["account", { accountId: "../../unsafe" }, "storage.accountId"],
    ["malformed SaaS URL", { saasBaseUrl: "not a url" }, "binding.saasBaseUrl"],
    ["relative SaaS URL", { saasBaseUrl: "/control" }, "binding.saasBaseUrl"],
    ["non-HTTP SaaS URL", { saasBaseUrl: "ftp://saas.example" }, "binding.saasBaseUrl"],
  ] as const)(
    "rejects invalid binding %s before path/log/client invocation",
    async (_label, override, expectedField) => {
      const clientFactory = vi.fn();
      const log = vi.fn();
      await expect(
        acquireCredentials({
          accountId: "account",
          saasBaseUrl: "https://saas.example",
          tenant: "tenant",
          credentialPath: "/explicit/must-not-be-read.json",
          log,
          _clientFactory: clientFactory,
          ...override,
        }),
      ).rejects.toThrow(expectedField);
      expect(clientFactory).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("runs the device flow non-interactively and persists to the per-account path", async () => {
    let capturedOpts: ConstructorParameters<typeof EnrollmentClient>[0] | undefined;
    const enroll = vi.fn(async () => fakeEnrollmentResult());
    const log = vi.fn();

    const result = await acquireCredentials({
      accountId: "acctA",
      saasBaseUrl: "http://saas.example",
      tenant: "tA",
      home: HOME,
      log,
      _clientFactory: (opts) => {
        capturedOpts = opts;
        return { enroll } as unknown as EnrollmentClient;
      },
    });

    expect(result.peerId).toBe("peer-1");
    expect(enroll).toHaveBeenCalledOnce();
    // Derives /api/enroll + /api/poll from the base URL.
    expect(capturedOpts?.saasBaseUrl).toBe("http://saas.example");
    expect(capturedOpts?.saasEnrollUrl).toBe("http://saas.example/api/enroll");
    expect(capturedOpts?.saasPollUrl).toBe("http://saas.example/api/poll");
    expect(capturedOpts?.tenant).toBe("tA");
    // The wire identity sent to enrollment is the accountId (가-2).
    expect(capturedOpts?.accountId).toBe("acctA");
    // Account-scoped persistence path.
    expect(capturedOpts?.credentialPath).toBe(
      accountCredentialPath(
        { tenant: "tA", accountId: "acctA" },
        { home: HOME },
      ),
    );
    // The user_code progress is streamed via the injected log (no TTY).
    expect(log).toHaveBeenCalled();
  });

  it("preserves the exact SaaS base while normalizing only endpoint joining", async () => {
    let capturedOpts: ConstructorParameters<typeof EnrollmentClient>[0] | undefined;
    await acquireCredentials({
      accountId: "default",
      saasBaseUrl: "http://saas.example/",
      tenant: "t",
      home: HOME,
      log: () => {},
      _clientFactory: (opts) => {
        capturedOpts = opts;
        return { enroll: async () => fakeEnrollmentResult() } as unknown as EnrollmentClient;
      },
    });
    expect(capturedOpts?.saasBaseUrl).toBe("http://saas.example/");
    expect(capturedOpts?.saasEnrollUrl).toBe("http://saas.example/api/enroll");
  });

  it("honors an explicit credentialPath override", async () => {
    let capturedOpts: ConstructorParameters<typeof EnrollmentClient>[0] | undefined;
    await acquireCredentials({
      accountId: "default",
      saasBaseUrl: "http://s",
      tenant: "t",
      credentialPath: "/custom/path/creds.json",
      log: () => {},
      _clientFactory: (opts) => {
        capturedOpts = opts;
        return { enroll: async () => fakeEnrollmentResult() } as unknown as EnrollmentClient;
      },
    });
    expect(capturedOpts?.credentialPath).toBe("/custom/path/creds.json");
  });

  it("propagates an enrollment failure (rejects)", async () => {
    await expect(
      acquireCredentials({
      accountId: "default",
        saasBaseUrl: "http://s",
        tenant: "t",
        log: () => {},
        _clientFactory: () =>
          ({ enroll: async () => { throw new Error("denied"); } }) as unknown as EnrollmentClient,
      }),
    ).rejects.toThrow("denied");
  });

  it("defaults accountId to 'default' for the path", async () => {
    let capturedOpts: ConstructorParameters<typeof EnrollmentClient>[0] | undefined;
    await acquireCredentials({
      accountId: "default",
      saasBaseUrl: "http://s",
      tenant: "t",
      home: HOME,
      log: () => {},
      _clientFactory: (opts) => {
        capturedOpts = opts;
        return { enroll: async () => fakeEnrollmentResult() } as unknown as EnrollmentClient;
      },
    });
    expect(capturedOpts?.credentialPath).toBe(
      accountCredentialPath(
        { tenant: "t", accountId: "default" },
        { home: HOME },
      ),
    );
  });
});
