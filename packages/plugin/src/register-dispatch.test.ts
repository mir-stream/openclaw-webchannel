import { describe, it, expect, vi } from "vitest";

import {
  resolveAccountIdForJwt,
  unionAllowedOrigins,
  addAudMapping,
  resolveAndVerifyRegister,
} from "./register-dispatch.js";

/** Build an (unsigned, structurally-valid) JWT carrying the given `aud`. */
function jwtWithAud(aud: string | string[]): string {
  const b64u = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = b64u({ alg: "RS256", typ: "JWT", kid: "k1" });
  const payload = b64u({ sub: "peer-1", aud, iss: "issuer", exp: 9999999999 });
  return `${header}.${payload}.signature`;
}

describe("resolveAccountIdForJwt (aud → account dispatch)", () => {
  const audToAccount = new Map<string, string>([
    ["agentA", "acctA"],
    ["agentB", "acctB"],
  ]);

  it("maps aud=agentA to accountA", () => {
    expect(resolveAccountIdForJwt(jwtWithAud("agentA"), audToAccount)).toBe("acctA");
  });

  it("maps aud=agentB to accountB", () => {
    expect(resolveAccountIdForJwt(jwtWithAud("agentB"), audToAccount)).toBe("acctB");
  });

  it("returns undefined for an unmapped audience", () => {
    expect(resolveAccountIdForJwt(jwtWithAud("agentX"), audToAccount)).toBeUndefined();
  });

  it("returns undefined for a missing/empty JWT", () => {
    expect(resolveAccountIdForJwt(undefined, audToAccount)).toBeUndefined();
    expect(resolveAccountIdForJwt("", audToAccount)).toBeUndefined();
    expect(resolveAccountIdForJwt("not.a.jwt", audToAccount)).toBeUndefined();
  });

  it("handles an array aud, picking the first mapped audience", () => {
    expect(resolveAccountIdForJwt(jwtWithAud(["other", "agentB"]), audToAccount)).toBe("acctB");
  });

  it("dispatches register to the RIGHT account's channel only (isolation)", () => {
    // Two account runtimes with distinct register spies.
    const channelA = { registerPeer: vi.fn() };
    const channelB = { registerPeer: vi.fn() };
    const runtimes = new Map<string, { channel: { registerPeer: (p: string) => void } }>([
      ["acctA", { channel: channelA }],
      ["acctB", { channel: channelB }],
    ]);

    // Simulate the register handler dispatch for a token with aud=agentA.
    const accountId = resolveAccountIdForJwt(jwtWithAud("agentA"), audToAccount);
    expect(accountId).toBe("acctA");
    runtimes.get(accountId!)!.channel.registerPeer("peer-1");

    expect(channelA.registerPeer).toHaveBeenCalledWith("peer-1");
    expect(channelB.registerPeer).not.toHaveBeenCalled();
  });
});

describe("unionAllowedOrigins (cross-account preflight CORS)", () => {
  it("returns undefined (permissive) for no accounts", () => {
    expect(unionAllowedOrigins([])).toBeUndefined();
  });

  it("returns the single account's allowlist unchanged (Cycle 1 parity)", () => {
    expect(unionAllowedOrigins([["https://a.example"]])).toEqual(["https://a.example"]);
  });

  it("returns the de-duplicated union when ALL accounts have allowlists", () => {
    const u = unionAllowedOrigins([["https://a.example"], ["https://b.example", "https://a.example"]]);
    expect(u?.sort()).toEqual(["https://a.example", "https://b.example"]);
  });

  it("is permissive (undefined) when ANY account is permissive", () => {
    expect(unionAllowedOrigins([["https://a.example"], undefined])).toBeUndefined();
    expect(unionAllowedOrigins([["https://a.example"], []])).toBeUndefined();
  });
});

describe("addAudMapping (C1 — first-wins on audience collision)", () => {
  it("adds a fresh mapping", () => {
    const map = new Map<string, string>();
    expect(addAudMapping(map, "agentA", "acctA")).toBe(true);
    expect(map.get("agentA")).toBe("acctA");
  });

  it("keeps the FIRST account on a collision and warns (no silent overwrite)", () => {
    const map = new Map<string, string>([["sharedAud", "acctA"]]);
    const warn = vi.fn();
    const added = addAudMapping(map, "sharedAud", "acctB", warn);
    expect(added).toBe(false);
    expect(map.get("sharedAud")).toBe("acctA"); // first-wins
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("acctA");
    expect(warn.mock.calls[0][0]).toContain("acctB");
  });

  it("does not warn when the same account re-registers the same aud", () => {
    const map = new Map<string, string>([["agentA", "acctA"]]);
    const warn = vi.fn();
    expect(addAudMapping(map, "agentA", "acctA", warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("resolveAndVerifyRegister (C2 — verify-and-register-into-SAME-account)", () => {
  const audToAccount = new Map<string, string>([
    ["agentA", "acctA"],
    ["agentB", "acctB"],
  ]);

  function makeAccounts() {
    const channelA = { registerPeer: vi.fn() };
    const channelB = { registerPeer: vi.fn() };
    const accounts = new Map([
      ["acctA", { accountId: "acctA", auth: { strategy: "jwt", jwt: { audience: "agentA" } }, channel: channelA }],
      ["acctB", { accountId: "acctB", auth: { strategy: "jwt", jwt: { audience: "agentB" } }, channel: channelB }],
    ]);
    return { accounts, channelA, channelB };
  }

  it("a token routed to B verifies against B and registers into B's channel ONLY (not A)", async () => {
    const { accounts, channelA, channelB } = makeAccounts();
    const verifyAuths: unknown[] = [];
    const verify = async (_jwt: string, auth: unknown) => {
      verifyAuths.push(auth);
      return { peerId: "peer-1" };
    };

    const res = await resolveAndVerifyRegister({
      jwt: jwtWithAud("agentB"),
      audToAccount,
      getAccount: (id) => accounts.get(id),
      verify,
    });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    // Verification used B's auth, never A's.
    expect(verifyAuths).toEqual([accounts.get("acctB")!.auth]);
    expect(res.account.accountId).toBe("acctB");
    // The caller registers into the SAME resolved account → B only.
    res.account.channel.registerPeer(res.identity.peerId);
    expect(channelB.registerPeer).toHaveBeenCalledWith("peer-1");
    expect(channelA.registerPeer).not.toHaveBeenCalled();
  });

  it("a token whose aud routes to B can NEVER resolve account A", async () => {
    const { accounts } = makeAccounts();
    const res = await resolveAndVerifyRegister({
      jwt: jwtWithAud("agentB"),
      audToAccount,
      getAccount: (id) => accounts.get(id),
      verify: async () => ({ peerId: "p" }),
    });
    expect(res.status === "ok" && res.account.accountId).toBe("acctB");
  });

  it("missing JWT → no-jwt", async () => {
    const { accounts } = makeAccounts();
    const res = await resolveAndVerifyRegister({
      jwt: undefined,
      audToAccount,
      getAccount: (id) => accounts.get(id),
      verify: async () => ({ peerId: "p" }),
    });
    expect(res.status).toBe("no-jwt");
  });

  it("unmapped audience → no-account (verify never runs)", async () => {
    const { accounts } = makeAccounts();
    const verify = vi.fn(async () => ({ peerId: "p" }));
    const res = await resolveAndVerifyRegister({
      jwt: jwtWithAud("agentX"),
      audToAccount,
      getAccount: (id) => accounts.get(id),
      verify,
    });
    expect(res.status).toBe("no-account");
    expect(verify).not.toHaveBeenCalled();
  });

  it("non-jwt-strategy resolved account → non-jwt (clearer 401, not a 500)", async () => {
    const accounts = new Map([
      ["acctH", { accountId: "acctH", auth: { strategy: "hmac-ticket" }, channel: { registerPeer: vi.fn() } }],
    ]);
    const verify = vi.fn(async () => ({ peerId: "p" }));
    const res = await resolveAndVerifyRegister({
      jwt: jwtWithAud("agentH"),
      audToAccount: new Map([["agentH", "acctH"]]),
      getAccount: (id) => accounts.get(id),
      verify,
    });
    expect(res.status).toBe("non-jwt");
    expect(verify).not.toHaveBeenCalled(); // short-circuits before verify throws
  });

  it("verification failure → invalid", async () => {
    const { accounts } = makeAccounts();
    const res = await resolveAndVerifyRegister({
      jwt: jwtWithAud("agentA"),
      audToAccount,
      getAccount: (id) => accounts.get(id),
      verify: async () => null,
    });
    expect(res.status).toBe("invalid");
  });
});
