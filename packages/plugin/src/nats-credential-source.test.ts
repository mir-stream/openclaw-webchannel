/**
 * NATS credential-source (Axis A) tests.
 *
 * Covers the resolver decision table (open / static / enrolled, env-overrides-
 * config), `.creds` file parsing, env/file/inline secret loading, and the
 * connector's `static` branch (user JWT + NKEY signing callback) — all without
 * opening a real socket (the transport + signer are injected).
 */
import { describe, it, expect, vi } from "vitest";

import {
  resolveNatsCredentialSource,
  connectNatsCredentialSource,
  parseNatsCredsFile,
  type NatsCredentialSource,
} from "./nats-credential-source.js";

// A realistic-shaped NATS .creds file (tokens are fake but well-formed).
const CREDS_FILE = `-----BEGIN NATS USER JWT-----
eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJ1c2VyIjoidGVzdCJ9.SIG
------END NATS USER JWT------

************************* IMPORTANT *************************
NKEY Seed printed below can be used to sign and prove identity.

-----BEGIN USER NKEY SEED-----
SUAGMOCN73OQKB2ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDE
------END USER NKEY SEED------

*************************************************************
`;

const BASE = {
  tenant: "t1",
  accountId: "a1",
} as const;

describe("parseNatsCredsFile", () => {
  it("extracts the JWT and seed from a standard .creds file", () => {
    const { userJwt, userSeed } = parseNatsCredsFile(CREDS_FILE);
    expect(userJwt).toBe(
      "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJ1c2VyIjoidGVzdCJ9.SIG",
    );
    expect(userSeed).toBe("SUAGMOCN73OQKB2ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDE");
  });

  it("throws when a block is missing", () => {
    expect(() => parseNatsCredsFile("garbage")).toThrow(/NATS USER JWT/);
    expect(() =>
      parseNatsCredsFile(
        "-----BEGIN NATS USER JWT-----\nJ\n------END NATS USER JWT------",
      ),
    ).toThrow(/USER NKEY SEED/);
  });
});

describe("resolveNatsCredentialSource — removed open mode", () => {
  it("rejects WEBCHANNEL_NATS_DEV_OPEN=1 with a migration error", () => {
    expect(() => resolveNatsCredentialSource({
      ...BASE,
      natsConfig: { credentials: { mode: "static", userJwt: "j", userSeed: "s" } },
      env: { WEBCHANNEL_NATS_DEV_OPEN: "1" },
    })).toThrow(/WEBCHANNEL_NATS_DEV_OPEN was removed/);
  });
});

describe.skip("legacy static resolution details (serving removed until P0-3)", () => {
  it("resolves static from env JWT + seed and applies the URL precedence", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      natsConfig: { url: "wss://config:4222" },
      env: {
        WEBCHANNEL_NATS_URL: "wss://env:4222",
        WEBCHANNEL_NATS_USER_JWT: "env-jwt",
        WEBCHANNEL_NATS_USER_SEED: "env-seed",
      },
    });
    expect(s).toEqual({
      mode: "static",
      url: "wss://env:4222",
      userJwt: "env-jwt",
      userSeed: "env-seed",
    });
  });

  it("resolves static from a .creds file path (via config)", () => {
    const readFile = vi.fn().mockReturnValue(CREDS_FILE);
    const s = resolveNatsCredentialSource({
      ...BASE,
      natsConfig: { url: "wss://x", credentials: { mode: "static", credsFile: "/x.creds" } },
      env: {},
      readFile,
    }) as Extract<NatsCredentialSource, { mode: "static" }>;
    expect(readFile).toHaveBeenCalledWith("/x.creds");
    expect(s.mode).toBe("static");
    expect(s.userJwt).toContain("eyJhbGci");
    expect(s.userSeed).toMatch(/^SUAGM/);
  });

  it("resolves static from a .creds file path (via WEBCHANNEL_NATS_CREDS env)", () => {
    const readFile = vi.fn().mockReturnValue(CREDS_FILE);
    const s = resolveNatsCredentialSource({
      ...BASE,
      env: { WEBCHANNEL_NATS_CREDS: "/env.creds" },
      readFile,
    });
    expect(readFile).toHaveBeenCalledWith("/env.creds");
    expect(s.mode).toBe("static");
  });

  it("env JWT/seed override the .creds file values", () => {
    const readFile = vi.fn().mockReturnValue(CREDS_FILE);
    const s = resolveNatsCredentialSource({
      ...BASE,
      env: {
        WEBCHANNEL_NATS_CREDS: "/x.creds",
        WEBCHANNEL_NATS_USER_JWT: "override-jwt",
      },
      readFile,
    }) as Extract<NatsCredentialSource, { mode: "static" }>;
    expect(s.userJwt).toBe("override-jwt"); // env wins over file
    expect(s.userSeed).toMatch(/^SUAGM/); // seed still from file
  });

  it("resolves inline config secrets, including { env } SecretRefs", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      natsConfig: {
        credentials: { userJwt: { env: "MY_JWT" }, userSeed: "inline-seed" },
      },
      env: { MY_JWT: "resolved-jwt" },
    }) as Extract<NatsCredentialSource, { mode: "static" }>;
    expect(s.userJwt).toBe("resolved-jwt");
    expect(s.userSeed).toBe("inline-seed");
  });

  it("throws when static is signalled but a secret is missing", () => {
    expect(() =>
      resolveNatsCredentialSource({
        ...BASE,
        env: { WEBCHANNEL_NATS_USER_JWT: "only-jwt" },
      }),
    ).toThrow(/incomplete .*userSeed/);
  });

  it("throws when a { env } SecretRef points at an unset var", () => {
    expect(() =>
      resolveNatsCredentialSource({
        ...BASE,
        natsConfig: { credentials: { userJwt: { env: "NOPE" }, userSeed: "s" } },
        env: {},
      }),
    ).toThrow(/env "NOPE" is unset/);
  });
});

describe("resolveNatsCredentialSource — static migration signals", () => {
  const migration = /static NATS credentials no longer imply auto admission/;
  it.each([
    ["mode", { natsConfig: { credentials: { mode: "static" } }, env: {} }],
    ["credsFile", { natsConfig: { credentials: { credsFile: "/x" } }, env: {} }],
    ["inline", { natsConfig: { credentials: { userJwt: "j", userSeed: "s" } }, env: {} }],
    ["env JWT+seed", { env: { WEBCHANNEL_NATS_USER_JWT: "j", WEBCHANNEL_NATS_USER_SEED: "s" } }],
    ["env creds file", { env: { WEBCHANNEL_NATS_CREDS: "/x" } }],
  ])("rejects %s", (_name, extra) => {
    expect(() => resolveNatsCredentialSource({ ...BASE, ...extra } as never)).toThrow(migration);
  });
});

describe("resolveNatsCredentialSource — enrolled (default)", () => {
  it("defaults to enrolled and carries the SaaS base URL + tenant/agent", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      saasBaseUrl: "https://saas.example",
      env: {},
    });
    expect(s).toEqual({
      mode: "enrolled",
      url: "ws://127.0.0.1:4222",
      saasBaseUrl: "https://saas.example",
      tenant: "t1",
      accountId: "a1",
    });
  });

  it("falls back to the default SaaS base URL when none is provided", () => {
    const s = resolveNatsCredentialSource({ ...BASE, env: {} }) as Extract<
      NatsCredentialSource,
      { mode: "enrolled" }
    >;
    expect(s.saasBaseUrl).toBe("http://localhost:3001");
  });

  it("honors nats.credentials.saasBaseUrl (over the top-level config value)", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      // Top-level api.config.saas?.baseUrl — the LOWER-precedence config source.
      saasBaseUrl: "https://top-level.example",
      natsConfig: { credentials: { saasBaseUrl: "https://creds.example" } },
      env: {},
    }) as Extract<NatsCredentialSource, { mode: "enrolled" }>;
    expect(s.saasBaseUrl).toBe("https://creds.example");
  });

  it("env WEBCHANNEL_SAAS_BASE_URL overrides nats.credentials.saasBaseUrl", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      saasBaseUrl: "https://top-level.example",
      natsConfig: { credentials: { saasBaseUrl: "https://creds.example" } },
      env: { WEBCHANNEL_SAAS_BASE_URL: "https://env.example" },
    }) as Extract<NatsCredentialSource, { mode: "enrolled" }>;
    expect(s.saasBaseUrl).toBe("https://env.example");
  });
});

describe("connectNatsCredentialSource — static branch", () => {
  it("builds a transport with the user JWT + an NKEY signing callback", async () => {
    let captured: Record<string, unknown> | undefined;
    const fakeTransport = { connect: vi.fn().mockResolvedValue(undefined) };
    const makeSigner = vi.fn().mockReturnValue(async () => "sig");

    const result = await connectNatsCredentialSource(
      { mode: "static", url: "wss://x", userJwt: "JWT", userSeed: "SEED" },
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transportFactory: (opts) => {
          captured = opts as Record<string, unknown>;
          return fakeTransport as any;
        },
        makeSigner,
      },
    );

    expect(captured?.["url"]).toBe("wss://x");
    expect(captured?.["jwtCredential"]).toBe("JWT");
    expect(typeof captured?.["nkeySigningCallback"]).toBe("function");
    expect(makeSigner).toHaveBeenCalledWith("SEED");
    expect(fakeTransport.connect).toHaveBeenCalled();
    expect(result.transport).toBe(fakeTransport);
    expect(result.enrolled).toBeUndefined();
  });

  it("enrolled branch delegates to createEnrolled and returns the connection", async () => {
    const fakeTransport = { connect: vi.fn() };
    const enrolled = { transport: fakeTransport };
    const createEnrolled = vi.fn().mockResolvedValue(enrolled);
    const result = await connectNatsCredentialSource(
      {
        mode: "enrolled",
        url: "wss://n",
        saasBaseUrl: "https://saas.example",
        tenant: "t1",
        accountId: "a1",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { createEnrolled: createEnrolled as any },
    );
    expect(createEnrolled).toHaveBeenCalledWith(
      expect.objectContaining({
        saasEnrollUrl: "https://saas.example/api/enroll",
        saasPollUrl: "https://saas.example/api/poll",
        natsUrl: "wss://n",
        tenant: "t1",
        accountId: "a1",
      }),
    );
    expect(result.transport).toBe(fakeTransport);
    expect(result.enrolled).toBe(enrolled);
  });
});
