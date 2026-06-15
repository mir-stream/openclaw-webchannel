import { describe, it, expect, vi, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";

import {
  resolveVerifier,
  ANON_PEER_ID,
  type AuthConfig,
  type AuthLogger,
} from "./auth.js";
import { issueClawChannelTicket } from "./ticket.js";

/** Build a minimal IncomingMessage-like object with just a `url`. */
function fakeReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

const ENV_VAR = "CLAWCHANNEL_TEST_TICKET_SECRET";
const SECRET = "shared-hmac-secret";

afterEach(() => {
  delete process.env[ENV_VAR];
  vi.restoreAllMocks();
});

describe("resolveVerifier safe default", () => {
  it("throws on missing auth config", () => {
    expect(() => resolveVerifier(undefined)).toThrow(/strategy is required/);
    expect(() => resolveVerifier(null)).toThrow(/strategy is required/);
  });

  it("throws on unknown strategy", () => {
    expect(() =>
      resolveVerifier({ strategy: "totally-bogus" } as unknown as AuthConfig),
    ).toThrow(/unknown auth strategy/);
  });
});

describe("anonymous strategy", () => {
  it("returns the anon peer and emits a loud warning", async () => {
    const warn = vi.fn();
    const logger: AuthLogger = { warn };
    const verifier = resolveVerifier({ strategy: "anonymous" }, logger);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/anonymous/i);

    const identity = await verifier(fakeReq("/clawchannel/ws"));
    expect(identity).toEqual({ peerId: ANON_PEER_ID });
  });
});

describe("hmac-ticket strategy", () => {
  it("accepts a freshly issued ticket and maps sub -> peerId", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
    });
    const token = issueClawChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: 60,
      displayName: "Grace",
    });
    const identity = await verifier(fakeReq(`/clawchannel/ws?ticket=${token}`));
    expect(identity).toEqual({ peerId: "user-7", displayName: "Grace" });
  });

  it("honors a custom ticketParam", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
      ticketParam: "t",
    });
    const token = issueClawChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: 60,
    });
    expect(await verifier(fakeReq(`/clawchannel/ws?t=${token}`))).toEqual({
      peerId: "user-7",
    });
    // Wrong param name => no ticket => reject.
    expect(
      await verifier(fakeReq(`/clawchannel/ws?ticket=${token}`)),
    ).toBeNull();
  });

  it("rejects a missing ticket", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
    });
    expect(await verifier(fakeReq("/clawchannel/ws"))).toBeNull();
  });

  it("rejects an expired ticket", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
    });
    const token = issueClawChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: -1,
    });
    expect(await verifier(fakeReq(`/clawchannel/ws?ticket=${token}`))).toBeNull();
  });

  it("rejects a tampered ticket", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
    });
    const token = issueClawChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: 60,
    });
    const tampered = `${token}tampered`;
    expect(
      await verifier(fakeReq(`/clawchannel/ws?ticket=${tampered}`)),
    ).toBeNull();
  });

  it("resolves the secret from an env SecretRef", async () => {
    process.env[ENV_VAR] = SECRET;
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: { env: ENV_VAR },
    });
    const token = issueClawChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: 60,
    });
    expect(await verifier(fakeReq(`/clawchannel/ws?ticket=${token}`))).toEqual({
      peerId: "user-7",
    });
  });

  it("throws when the env SecretRef is missing", () => {
    expect(() =>
      resolveVerifier({
        strategy: "hmac-ticket",
        ticketSecret: { env: ENV_VAR },
      }),
    ).toThrow(/is unset or empty/);
  });

  it("throws on an empty inline secret", () => {
    expect(() =>
      resolveVerifier({ strategy: "hmac-ticket", ticketSecret: "" }),
    ).toThrow(/empty string/);
  });
});
