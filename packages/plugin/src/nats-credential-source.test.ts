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

describe("static resolution details (re-enabled in P0-3)", () => {
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

describe("resolveNatsCredentialSource — static signals resolve (P0-3, no longer a migration throw)", () => {
  // P0-3 removed the "static creds no longer imply auto admission" migration
  // throw. Each static signal now RESOLVES to a `{ mode: "static" }` source
  // (identity is supplied separately at consume time) — or, when a signal is
  // present but the transport creds are incomplete, fails with the TARGETED
  // "incomplete static credentials" error (never the deleted migration throw).
  const migration = /static NATS credentials no longer imply auto admission/;

  it("inline userJwt + userSeed → resolves static", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      natsConfig: { credentials: { userJwt: "j", userSeed: "s" } },
      env: {},
    }) as Extract<NatsCredentialSource, { mode: "static" }>;
    expect(s.mode).toBe("static");
    expect(s.userJwt).toBe("j");
    expect(s.userSeed).toBe("s");
  });

  it("env JWT + seed → resolves static", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      env: { WEBCHANNEL_NATS_USER_JWT: "j", WEBCHANNEL_NATS_USER_SEED: "s" },
    }) as Extract<NatsCredentialSource, { mode: "static" }>;
    expect(s.mode).toBe("static");
    expect(s.userJwt).toBe("j");
    expect(s.userSeed).toBe("s");
  });

  it("credentials.credsFile → resolves static (from the parsed file)", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      natsConfig: { credentials: { credsFile: "/x" } },
      env: {},
      readFile: () => CREDS_FILE,
    }) as Extract<NatsCredentialSource, { mode: "static" }>;
    expect(s.mode).toBe("static");
    expect(s.userJwt).toContain("eyJhbGci");
    expect(s.userSeed).toMatch(/^SUAGM/);
  });

  it("env creds file → resolves static (from the parsed file)", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      env: { WEBCHANNEL_NATS_CREDS: "/x" },
      readFile: () => CREDS_FILE,
    }) as Extract<NatsCredentialSource, { mode: "static" }>;
    expect(s.mode).toBe("static");
  });

  it("mode:\"static\" alone (no secrets) → targeted incomplete error, NOT the migration throw or a silent enrolled downgrade", () => {
    // An explicit `mode:"static"` is itself a static signal (documented precedence
    // #1); with no transport creds it must fail LOUD with the incompleteness error
    // rather than silently downgrading to the enrolled device-flow.
    expect(() =>
      resolveNatsCredentialSource({
        ...BASE,
        natsConfig: { credentials: { mode: "static" } },
        env: {},
      }),
    ).toThrow(/incomplete .*userJwt \+ userSeed/);
    expect(() =>
      resolveNatsCredentialSource({
        ...BASE,
        natsConfig: { credentials: { mode: "static" } },
        env: {},
      }),
    ).not.toThrow(migration);
  });
});

describe("resolveNatsCredentialSource — explicit mode:\"enrolled\" is authoritative", () => {
  // The hole this closes: WEBCHANNEL_NATS_USER_JWT/_SEED/_CREDS are PROCESS-WIDE.
  // Before this, ANY static signal won, so exporting them for one BYO account also
  // flipped every enrolled account to static — each then dialing the ENV relay with
  // ANOTHER account's user credential, collapsing per-account relay isolation.
  // `setup.ts` writes mode:"enrolled" into every wizard-created account, so that
  // declaration is exactly the thing that must now hold the line.

  it("env-only static creds do NOT flip a mode:\"enrolled\" account (and it warns once)", () => {
    const warn = vi.fn();
    const s = resolveNatsCredentialSource({
      ...BASE,
      saasBaseUrl: "https://saas.example",
      natsConfig: { credentials: { mode: "enrolled" } },
      env: {
        WEBCHANNEL_NATS_USER_JWT: "other-accounts-jwt",
        WEBCHANNEL_NATS_USER_SEED: "other-accounts-seed",
      },
      warn,
    });
    expect(s.mode).toBe("enrolled");
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    // Must name the account and the exact env vars it ignored — a bare "ignored
    // env creds" line is unactionable on a multi-account gateway.
    expect(msg).toContain('"a1"');
    expect(msg).toContain("WEBCHANNEL_NATS_USER_JWT");
    expect(msg).toContain("WEBCHANNEL_NATS_USER_SEED");
    expect(msg).toMatch(/IGNORED/);
  });

  it("WEBCHANNEL_NATS_CREDS alone also loses to mode:\"enrolled\" (and is named in the warning)", () => {
    const warn = vi.fn();
    // readFile must never be reached: an enrolled account must not even parse a
    // process-wide .creds file it was never meant to use.
    const readFile = vi.fn().mockReturnValue(CREDS_FILE);
    const s = resolveNatsCredentialSource({
      ...BASE,
      natsConfig: { credentials: { mode: "enrolled" } },
      env: { WEBCHANNEL_NATS_CREDS: "/other-account.creds" },
      readFile,
      warn,
    });
    expect(s.mode).toBe("enrolled");
    expect(readFile).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toContain("WEBCHANNEL_NATS_CREDS");
  });

  it("resolves the SAME enrolled source the default fall-through would (no drift)", () => {
    const explicit = resolveNatsCredentialSource({
      ...BASE,
      saasBaseUrl: "https://top-level.example",
      natsConfig: {
        url: "wss://cfg:4222",
        credentials: { mode: "enrolled", saasBaseUrl: "https://creds.example" },
      },
      env: { WEBCHANNEL_NATS_USER_JWT: "j", WEBCHANNEL_NATS_USER_SEED: "s" },
    });
    const inferred = resolveNatsCredentialSource({
      ...BASE,
      saasBaseUrl: "https://top-level.example",
      natsConfig: { url: "wss://cfg:4222", credentials: { saasBaseUrl: "https://creds.example" } },
      env: {},
    });
    expect(explicit).toEqual(inferred);
  });

  it("mode:\"enrolled\" + ACCOUNT-CONFIG static secrets is a contradiction ⇒ throws", () => {
    // Account-level config is scoped intent typed next to `mode`, unlike ambient
    // env. No silent winner is defensible, so fail closed and name both sides.
    for (const credentials of [
      { mode: "enrolled" as const, userJwt: "j", userSeed: "s" },
      { mode: "enrolled" as const, credsFile: "/byo.creds" },
      { mode: "enrolled" as const, userSeed: "s" },
    ]) {
      expect(() =>
        resolveNatsCredentialSource({ ...BASE, natsConfig: { credentials }, env: {} }),
      ).toThrow(/mode:"enrolled" but the SAME account config also carries static/);
    }
  });

  it("the contradiction error names the account and the offending config paths", () => {
    let caught: Error | undefined;
    try {
      resolveNatsCredentialSource({
        ...BASE,
        natsConfig: { credentials: { mode: "enrolled", credsFile: "/x", userSeed: "s" } },
        env: {},
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('"a1"');
    expect(caught!.message).toContain("channels.webchannel.nats.credentials.credsFile");
    expect(caught!.message).toContain("channels.webchannel.nats.credentials.userSeed");
    // Not reported as an offender — it was never set.
    expect(caught!.message).not.toContain("channels.webchannel.nats.credentials.userJwt,");
    expect(caught!.message).toMatch(/Refusing to start/);
  });

  it("mode:\"enrolled\" with no static material anywhere ⇒ enrolled, and NO warning", () => {
    const warn = vi.fn();
    const s = resolveNatsCredentialSource({
      ...BASE,
      saasBaseUrl: "https://saas.example",
      natsConfig: { credentials: { mode: "enrolled" } },
      env: {},
      warn,
    });
    expect(s.mode).toBe("enrolled");
    expect(warn).not.toHaveBeenCalled();
  });

  it("is a no-op without an injected warn (the resolver never touches console)", () => {
    expect(() =>
      resolveNatsCredentialSource({
        ...BASE,
        natsConfig: { credentials: { mode: "enrolled" } },
        env: { WEBCHANNEL_NATS_USER_JWT: "j" },
      }),
    ).not.toThrow();
  });

  it("REGRESSION: mode ABSENT (legacy config) + env secrets still resolves STATIC", () => {
    // The enrolled-wins rule keys on an EXPLICIT declaration only. Legacy configs
    // written before `mode` existed must keep inferring static from any signal —
    // silently downgrading them to the device-flow would break working gateways.
    const warn = vi.fn();
    const s = resolveNatsCredentialSource({
      ...BASE,
      natsConfig: { url: "wss://byo:4222" },
      env: { WEBCHANNEL_NATS_USER_JWT: "j", WEBCHANNEL_NATS_USER_SEED: "s" },
      warn,
    }) as Extract<NatsCredentialSource, { mode: "static" }>;
    expect(s.mode).toBe("static");
    expect(s.userJwt).toBe("j");
    expect(warn).not.toHaveBeenCalled();
  });

  it("REGRESSION: mode:\"static\" is unchanged — env secrets resolve static", () => {
    const s = resolveNatsCredentialSource({
      ...BASE,
      natsConfig: { credentials: { mode: "static" } },
      env: { WEBCHANNEL_NATS_USER_JWT: "j", WEBCHANNEL_NATS_USER_SEED: "s" },
    }) as Extract<NatsCredentialSource, { mode: "static" }>;
    expect(s.mode).toBe("static");
    expect(s.userSeed).toBe("s");
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
