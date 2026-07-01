import { describe, it, expect, vi } from "vitest";

// Mock node:fs so status's "creds already exist" probe is controllable and never
// touches the real home dir.
const existsMock = vi.fn((_p: string) => false);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (p: string) => existsMock(p) };
});

import { buildFullAccountPatch } from "./setup.js";
import { webchannelSetupWizard, validateHttpUrl } from "./setup-wizard.js";
import { WebChannelTransport } from "./transport.js";
import { createWebChannelPlugin } from "./channel.js";

type Cfg = { channels: { webchannel?: Record<string, unknown> } };
function account(next: unknown, accountId: string): Record<string, unknown> {
  const section = (next as Cfg).channels.webchannel as Record<string, unknown>;
  return (section.accounts as Record<string, Record<string, unknown>>)[accountId];
}

describe("setup-wizard: buildFullAccountPatch (ground-truth demo block)", () => {
  it("emits the complete enroll-ready block with derived jwksUrl/issuer/audience", () => {
    // Mirrors e2e/local/run-demo-synadia.sh, MINUS nats.url (SaaS-delivered at
    // enroll — intentionally omitted, see plan Q3) and with the derived issuer
    // default (= saasBaseUrl).
    expect(
      buildFullAccountPatch({
        tenant: "default-tenant",
        saasBaseUrl: "http://host.docker.internal:3951",
        accountId: "default-agent",
      }),
    ).toEqual({
      tenant: "default-tenant",
      saas: { baseUrl: "http://host.docker.internal:3951" },
      auth: {
        strategy: "jwt",
        jwt: {
          jwksUrl: "http://host.docker.internal:3951/.well-known/jwks.json",
          issuer: "http://host.docker.internal:3951",
          audience: "default-agent",
        },
      },
      dmSecurity: "open",
      nats: { admission: "auto", credentials: { mode: "enrolled" } },
    });
  });

  it("honors a docker-style issuer override + explicit audience (matches the demo iss)", () => {
    const patch = buildFullAccountPatch({
      tenant: "default-tenant",
      saasBaseUrl: "http://host.docker.internal:3951",
      accountId: "default-agent",
      issuer: "http://127.0.0.1:3951",
      audience: "default-agent",
    });
    expect((patch.auth as { jwt: { issuer: string } }).jwt.issuer).toBe("http://127.0.0.1:3951");
    expect((patch.auth as { jwt: { audience: string } }).jwt.audience).toBe("default-agent");
  });

  it("joins jwksUrl without a double slash when the base URL has a trailing slash", () => {
    const patch = buildFullAccountPatch({
      tenant: "t",
      saasBaseUrl: "https://saas.example.com/",
      accountId: "acct",
    });
    expect((patch.auth as { jwt: { jwksUrl: string } }).jwt.jwksUrl).toBe(
      "https://saas.example.com/.well-known/jwks.json",
    );
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

  it("status.resolveConfigured is true once auth.jwt is present", () => {
    existsMock.mockReturnValue(false);
    const cfg = {
      channels: { webchannel: { accounts: { accta: { auth: { jwt: {} } } } } },
    } as never;
    expect(webchannelSetupWizard.status.resolveConfigured({ cfg, accountId: "accta" })).toBe(true);
  });

  it("status.resolveConfigured is false when neither auth.jwt nor creds exist", () => {
    existsMock.mockReturnValue(false);
    const cfg = { channels: { webchannel: { accounts: { accta: {} } } } } as never;
    expect(webchannelSetupWizard.status.resolveConfigured({ cfg, accountId: "accta" })).toBe(false);
  });
});

describe("setup-wizard: constructed plugin exposes setupWizard", () => {
  it("forwards setupWizard through createChannelPluginBase", () => {
    const plugin = createWebChannelPlugin(new WebChannelTransport());
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

  it("finalize writes the full block from collected values", () => {
    const cfg = { channels: { webchannel: { accounts: {} } } } as never;
    const finalized = webchannelSetupWizard.finalize?.({
      cfg,
      accountId: "accta",
      credentialValues: { tenant: "t", saasBaseUrl: "http://s" },
    } as never) as { cfg: unknown };
    expect(account(finalized.cfg, "accta")).toEqual({
      tenant: "t",
      saas: { baseUrl: "http://s" },
      auth: {
        strategy: "jwt",
        jwt: {
          jwksUrl: "http://s/.well-known/jwks.json",
          issuer: "http://s",
          audience: "accta",
        },
      },
      dmSecurity: "open",
      nats: { admission: "auto", credentials: { mode: "enrolled" } },
    });
  });

  it("finalize derives a CANONICAL audience/account key for a mixed-case account id", () => {
    const cfg = { channels: { webchannel: { accounts: {} } } } as never;
    const finalized = webchannelSetupWizard.finalize?.({
      cfg,
      accountId: "AcctA",
      // audience is the default the wizard surfaces = canonical(accountId).
      credentialValues: { tenant: "t", saasBaseUrl: "http://s", audience: "accta" },
    } as never) as { cfg: unknown };
    // Written under the canonical key, and aud matches that key.
    const written = account(finalized.cfg, "accta");
    expect(written).toBeDefined();
    expect((written.auth as { jwt: { audience: string } }).jwt.audience).toBe("accta");
  });

  it("finalize flows a trailing-slash saasBaseUrl to a correct jwksUrl", () => {
    const cfg = { channels: { webchannel: { accounts: {} } } } as never;
    const finalized = webchannelSetupWizard.finalize?.({
      cfg,
      accountId: "accta",
      credentialValues: { tenant: "t", saasBaseUrl: "https://saas.example.com/" },
    } as never) as { cfg: unknown };
    expect(
      (account(finalized.cfg, "accta").auth as { jwt: { jwksUrl: string } }).jwt.jwksUrl,
    ).toBe("https://saas.example.com/.well-known/jwks.json");
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
