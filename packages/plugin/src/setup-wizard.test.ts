import { beforeEach, describe, it, expect, vi } from "vitest";

// Mock node:fs so status's "creds already exist" probe is controllable and never
// touches the real home dir.
const existsMock = vi.fn((_p: string) => false);
const readMock = vi.fn((_p: string) => "");
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) => existsMock(p),
    readFileSync: (p: string) => readMock(p),
  };
});

import { buildFullAccountPatch } from "./setup.js";
import { webchannelSetupWizard, validateHttpUrl } from "./setup-wizard.js";
import { NullPeerChannel } from "./channel-contract.js";
import { createWebChannelPlugin } from "./channel.js";
import { createCredentialIdentityForEnrollment } from "./credential-document.js";
import { generateKeyPair } from "./e2e-crypto.js";

const CREDENTIAL_PAIR = generateKeyPair();
const CREDENTIAL_KEY = Buffer.from(CREDENTIAL_PAIR.publicKey).toString("base64url");
const CREDENTIAL_PRIVATE_KEY = Buffer.from(CREDENTIAL_PAIR.privateKey).toString("base64url");

function boundCredentialJson(
  overrides: Partial<{
    tenant: string;
    accountId: string;
    saasBaseUrl: string;
  }> = {},
): string {
  const identity = {
    tenant: overrides.tenant ?? "tenant-a",
    accountId: overrides.accountId ?? "accta",
    saasBaseUrl: overrides.saasBaseUrl ?? "https://saas.example",
  };
  return JSON.stringify({
    credentialIdentity: createCredentialIdentityForEnrollment({
      ...identity,
      relayUrl: "wss://relay.example",
      agentPublicKey: CREDENTIAL_KEY,
    }),
    identityKey: {
      publicKey: CREDENTIAL_KEY,
      privateKey: CREDENTIAL_PRIVATE_KEY,
    },
    enrollment: {
      creds: { userJwt: "JWT", userSeed: "SEED" },
      natsUrl: "wss://relay.example",
    },
  });
}

beforeEach(() => {
  existsMock.mockReset();
  existsMock.mockReturnValue(false);
  readMock.mockReset();
  readMock.mockReturnValue("");
});

type Cfg = { channels: { webchannel?: Record<string, unknown> } };
function account(next: unknown, accountId: string): Record<string, unknown> {
  const section = (next as Cfg).channels.webchannel as Record<string, unknown>;
  return (section.accounts as Record<string, Record<string, unknown>>)[accountId];
}

describe("setup-wizard: buildFullAccountPatch (ground-truth demo block)", () => {
  it("(a) with NO issuer/audience: OMITS all JWT-verify params (they derive at runtime)", () => {
    // Trust-anchor change 2: the builder no longer GUESSES issuer/jwksUrl/audience.
    // It emits `auth.strategy:"jwt"` but NO `auth.jwt` sub-object — the runtime
    // deriver fills issuer=saas.baseUrl; the verifier binds aud to accountId,
    // jwksUrl=saas.baseUrl+/.well-known/jwks.json from the anchor. What stays: the
    // anchor (saas.baseUrl), strategy, admission=register-hop, enrolled creds,
    // dmSecurity=open. Mirrors e2e/local/run-demo-synadia.sh MINUS nats.url
    // (SaaS-delivered at enroll — intentionally omitted, see plan Q3).
    expect(
      buildFullAccountPatch({
        tenant: "default-tenant",
        saasBaseUrl: "http://host.docker.internal:3951",
        accountId: "default-agent",
      }),
    ).toEqual({
      tenant: "default-tenant",
      saas: { baseUrl: "http://host.docker.internal:3951" },
      auth: { strategy: "jwt" },
      dmSecurity: "open",
      nats: { admission: "register-hop", credentials: { mode: "enrolled" } },
    });
  });

  it("(a) never emits auth.jwt.jwksUrl/issuer/audience when no pins are supplied", () => {
    const patch = buildFullAccountPatch({
      tenant: "t",
      saasBaseUrl: "https://saas.example.com/",
      accountId: "acct",
    });
    // No `auth.jwt` at all — nothing is guessed; the runtime anchor derives it.
    expect((patch.auth as { jwt?: unknown }).jwt).toBeUndefined();
  });

  it("(b) with an explicit issuer pin writes it but never audience/jwksUrl", () => {
    const patch = buildFullAccountPatch({
      tenant: "default-tenant",
      saasBaseUrl: "http://host.docker.internal:3951",
      accountId: "default-agent",
      issuer: "http://127.0.0.1:3951",
    });
    expect((patch.auth as { jwt: { issuer: string } }).jwt.issuer).toBe("http://127.0.0.1:3951");
    expect((patch.auth as { jwt: Record<string, unknown> }).jwt).not.toHaveProperty("audience");
    // jwksUrl is NEVER written by the builder anymore — it derives at runtime.
    expect((patch.auth as { jwt: { jwksUrl?: unknown } }).jwt.jwksUrl).toBeUndefined();
  });

  it("(b) with ONLY an issuer pin: writes issuer, omits audience (audience still derives)", () => {
    const patch = buildFullAccountPatch({
      tenant: "t",
      saasBaseUrl: "http://s",
      accountId: "acct",
      issuer: "https://logical-issuer.example",
    });
    const jwt = (patch.auth as { jwt: Record<string, unknown> }).jwt;
    expect(jwt).toEqual({ issuer: "https://logical-issuer.example" });
  });

  it("pins admission to register-hop — the register-over-NATS chat path, NOT legacy auto", () => {
    // A `channels add` SaaS-enrolled account MUST admit via the `.register` NATS
    // subject; the legacy `auto` (X25519 wildcard, no `.register`) times out the
    // browser's register request → "Credentials expired" in the UI. This is the
    // ONE assertion that guards the default from regressing back to `auto`.
    const patch = buildFullAccountPatch({
      tenant: "t",
      saasBaseUrl: "http://s",
      accountId: "acct",
    });
    expect((patch.nats as { admission: string }).admission).toBe("register-hop");
  });

});

describe("setup-wizard: declarative detection", () => {
  it("is declarative-detectable (has own status AND credentials)", () => {
    // Core keys on `"status" in x && "credentials" in x`
    // (openclaw src/commands/channel-setup/registry.ts).
    expect("status" in webchannelSetupWizard).toBe(true);
    expect("credentials" in webchannelSetupWizard).toBe(true);
    expect(Array.isArray(webchannelSetupWizard.credentials)).toBe(true);
    expect(webchannelSetupWizard.channel).toBe("webchannel");
  });

  it("status.resolveConfigured does not let auth.jwt bypass enrolled credentials", () => {
    existsMock.mockReturnValue(false);
    const cfg = {
      channels: { webchannel: { accounts: { accta: { auth: { jwt: {} } } } } },
    } as never;
    expect(webchannelSetupWizard.status.resolveConfigured({ cfg, accountId: "accta" })).toBe(false);
  });

  it("status.resolveConfigured is false when neither auth.jwt nor creds exist", () => {
    existsMock.mockReturnValue(false);
    const cfg = { channels: { webchannel: { accounts: { accta: {} } } } } as never;
    expect(webchannelSetupWizard.status.resolveConfigured({ cfg, accountId: "accta" })).toBe(false);
  });

  it("status.resolveConfigured requires a complete matching credential document, not path existence", () => {
    existsMock.mockReturnValue(true);
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: {
              tenant: "tenant-a",
              saas: { baseUrl: "https://saas.example" },
              auth: { jwt: { issuer: "https://issuer.example" } },
            },
          },
        },
      },
    } as never;

    readMock.mockReturnValue("not-json");
    expect(
      webchannelSetupWizard.status.resolveConfigured({
        cfg,
        accountId: "accta",
      }),
    ).toBe(false);

    readMock.mockReturnValue(boundCredentialJson({ tenant: "other-tenant" }));
    expect(
      webchannelSetupWizard.status.resolveConfigured({
        cfg,
        accountId: "accta",
      }),
    ).toBe(false);

    readMock.mockReturnValue(boundCredentialJson());
    expect(
      webchannelSetupWizard.status.resolveConfigured({
        cfg,
        accountId: "accta",
      }),
    ).toBe(true);
  });

  it("status validates against the effective nats.credentials SaaS override", () => {
    existsMock.mockReturnValue(true);
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: {
              tenant: "tenant-a",
              saas: { baseUrl: "https://saas-a.example" },
              nats: {
                credentials: {
                  mode: "enrolled",
                  saasBaseUrl: "https://saas-b.example",
                },
              },
              auth: { jwt: { issuer: "https://issuer.example" } },
            },
          },
        },
      },
    } as never;

    readMock.mockReturnValue(
      boundCredentialJson({ saasBaseUrl: "https://saas-a.example" }),
    );
    expect(
      webchannelSetupWizard.status.resolveConfigured({ cfg, accountId: "accta" }),
    ).toBe(false);

    readMock.mockReturnValue(
      boundCredentialJson({ saasBaseUrl: "https://saas-b.example" }),
    );
    expect(
      webchannelSetupWizard.status.resolveConfigured({ cfg, accountId: "accta" }),
    ).toBe(true);
  });
});

describe("setup-wizard: constructed plugin exposes setupWizard", () => {
  it("forwards setupWizard through createChannelPluginBase", () => {
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    expect(plugin.setupWizard).toBeDefined();
    expect((plugin.setupWizard as { channel?: string }).channel).toBe("webchannel");
    expect(plugin.setupWizard).toBe(webchannelSetupWizard);
  });
});

describe("setup-wizard: per-field funnel safety", () => {
  it("a text-input applySet (saasBaseUrl absent) does NOT emit a full/broken block", () => {
    const cfg = { channels: { webchannel: { accounts: {} } } } as never;
    for (const textInput of webchannelSetupWizard.textInputs ?? []) {
      const result = textInput.applySet?.({ cfg, accountId: "accta", value: "whatever" });
      // No-op: the config is returned untouched (no auth/nats/dmSecurity written
      // mid-wizard). The real write happens only in finalize.
      expect(result).toBe(cfg);
    }
  });

  it("finalize with no collected saasBaseUrl leaves cfg untouched", () => {
    const cfg = { channels: { webchannel: { accounts: {} } } } as never;
    const finalized = webchannelSetupWizard.finalize?.({
      cfg,
      accountId: "accta",
      credentialValues: { tenant: "t" },
      // The remaining finalize params are unused on this early-return path.
    } as never);
    expect((finalized as { cfg: unknown }).cfg).toBe(cfg);
  });

  it("finalize writes the full block from collected values (no pins ⇒ no auth.jwt)", () => {
    const cfg = { channels: { webchannel: { accounts: {} } } } as never;
    const finalized = webchannelSetupWizard.finalize?.({
      cfg,
      accountId: "accta",
      credentialValues: { tenant: "t", saasBaseUrl: "http://s" },
    } as never) as { cfg: unknown };
    // No issuer/audience collected ⇒ the JWT-verify params are OMITTED and derive
    // at runtime; only the anchor + strategy + admission/creds/dmSecurity persist.
    expect(account(finalized.cfg, "accta")).toEqual({
      tenant: "t",
      saas: { baseUrl: "http://s" },
      auth: { strategy: "jwt" },
      dmSecurity: "open",
      nats: { admission: "register-hop", credentials: { mode: "enrolled" } },
    });
  });

  it("finalize uses the CANONICAL account key without persisting a separate audience", () => {
    const cfg = { channels: { webchannel: { accounts: {} } } } as never;
    const finalized = webchannelSetupWizard.finalize?.({
      cfg,
      accountId: "AcctA",
      credentialValues: { tenant: "t", saasBaseUrl: "http://s" },
    } as never) as { cfg: unknown };
    // The account key is the JWT audience; there is no independently writable
    // audience field that can drift from it.
    const written = account(finalized.cfg, "accta");
    expect(written).toBeDefined();
    expect((written.auth as { jwt?: Record<string, unknown> }).jwt?.audience).toBeUndefined();
  });

  it("finalize NEVER writes an issuer pin — even if a stray issuer value is collected", () => {
    // The issuer prompt was REMOVED (the issuer is SaaS-delivered at
    // enrollment; an add-time prefill-pin would permanently shadow it).
    // finalize must not thread a credentialValues issuer through even if one
    // is present (e.g. a stale harness), and the wizard must not prompt for it.
    expect(
      webchannelSetupWizard.textInputs?.some((input) => input.inputKey === ("issuer" as never)),
    ).toBe(false);
    const cfg = { channels: { webchannel: { accounts: {} } } } as never;
    const finalized = webchannelSetupWizard.finalize?.({
      cfg,
      accountId: "accta",
      credentialValues: {
        tenant: "t",
        saasBaseUrl: "https://saas.example.com/",
        issuer: "https://custom-domain.example",
      },
    } as never) as { cfg: unknown };
    const jwt = (account(finalized.cfg, "accta").auth as { jwt?: Record<string, unknown> }).jwt;
    expect(jwt?.issuer).toBeUndefined();
  });

  it("finalize preserves an EXISTING issuer pin across a wizard re-run (no clobber)", () => {
    const cfg = {
      channels: {
        webchannel: {
          accounts: {
            accta: {
              tenant: "t",
              saas: { baseUrl: "https://saas.example.com" },
              auth: { strategy: "jwt", jwt: { issuer: "https://logical-issuer.example" } },
            },
          },
        },
      },
    } as never;
    const finalized = webchannelSetupWizard.finalize?.({
      cfg,
      accountId: "accta",
      credentialValues: { tenant: "t", saasBaseUrl: "https://saas.example.com" },
    } as never) as { cfg: unknown };
    // The operator's hand-set pin survives the full-block rewrite.
    const jwt = (account(finalized.cfg, "accta").auth as { jwt: Record<string, unknown> }).jwt;
    expect(jwt.issuer).toBe("https://logical-issuer.example");
  });
});

describe("setup-wizard: validateHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(validateHttpUrl("http://saas.example.com")).toBeUndefined();
    expect(validateHttpUrl("https://saas.example.com:3951/path")).toBeUndefined();
    expect(validateHttpUrl("http://host.docker.internal:3951")).toBeUndefined();
  });

  it("rejects non-http(s) schemes", () => {
    expect(validateHttpUrl("ftp://x")).toBe("URL must use http:// or https://");
    expect(validateHttpUrl("ws://relay:4222")).toBe("URL must use http:// or https://");
  });

  it("rejects unparseable / empty input", () => {
    expect(validateHttpUrl("notaurl")).toBeDefined();
    expect(validateHttpUrl("")).toBeDefined();
  });
});
