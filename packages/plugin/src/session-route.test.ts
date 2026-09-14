/**
 * Forced per-account/tenant session isolation and #372 case-sensitive identity.
 * The tests exercise the public SDK key builder, route selection and the same
 * normalization used by core's store, including deliberate identityLinks.
 * The explicit serving tenant models the account's immutable startup plan.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildAgentSessionKey,
  parseAgentSessionKey,
  resolveAgentRoute,
  resolveInboundLastRouteSessionKey,
} from "openclaw/plugin-sdk/routing";

import { isValidSubjectToken } from "./subject-token.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";

/** The tenant every account in this file's fixture config is served under. */
const TENANT = "fixture-tenant";
/**
 * The `:tenant:` component the derivation appends for `TENANT` (#112):
 * the full lowercase SHA-256 digest of the verbatim tenant. The digest survives
 * core's lowercase fold at the store boundary; the isolation suite in
 * `session-route-tenant-isolation.test.ts` proves that end-to-end.
 */
const TENANT_SUFFIX =
  ":tenant:d8db6d6c78c77dfb1e522cfefe25df4fdbbccdc19955306c41633804e12d135d:peer-v2";

/**
 * Fake api whose `resolveAgentRoute` returns a route built under an arbitrary
 * `dmScope` (default "main" collapses to the shared agent:main:main). The helper
 * calls the REAL `buildAgentSessionKey`, so the returned sessionKey is the forced
 * one no matter what the mock's sessionKey was.
 */
function makeApi(opts?: {
  resolvedAgentId?: string;
  resolvedAccountId?: string;
  mockSessionKey?: string;
  identityLinks?: Record<string, string[]>;
}) {
  const resolveAgentRoute = vi.fn((input: any) => ({
    agentId: opts?.resolvedAgentId ?? "main",
    channel: input.channel,
    accountId: opts?.resolvedAccountId ?? input.accountId ?? "",
    // Emulate the global-dmScope="main" collapse (the leak this feature fixes).
    sessionKey: opts?.mockSessionKey ?? "agent:main:main",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "main" as const,
    matchedBy: "default" as const,
  }));
  const api = {
    config: {
      // A channel-level `tenant` is the shared base for every account id these
      // tests use, so `acme`/`acctA`/`acctB` all resolve to TENANT.
      channels: { webchannel: { tenant: TENANT } },
      session: opts?.identityLinks ? { identityLinks: opts.identityLinks } : {},
    },
    runtime: { channel: { routing: { resolveAgentRoute } } },
  } as any;
  return { api, resolveAgentRoute };
}

describe("resolveWebchannelSessionRoute (forced per-user isolation)", () => {
  it("#372 separates valid case-distinct peers after real SDK normalization", () => {
    const params = {
      agentId: "main", channel: "webchannel", accountId: "acme",
      dmScope: "per-account-channel-peer" as const,
    };
    const legacy = (id: string) => buildAgentSessionKey({ ...params, peer: { kind: "direct", id } });
    expect(legacy("Alice")).toBe(legacy("alice"));
    const { api } = makeApi();
    api.runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
    const stored = (id: string) => parseAgentSessionKey(
      resolveWebchannelSessionRoute(api, "acme", id, TENANT).sessionKey,
    );
    expect(stored("Alice")).not.toEqual(stored("alice"));
  });

  it("forces per-account-channel-peer, overriding a collapsed 'main' session key", () => {
    const { api } = makeApi({ mockSessionKey: "agent:main:main" });
    const route = resolveWebchannelSessionRoute(api, "acme", "alice", TENANT);
    // The naive main key is discarded for the isolated per-peer key.
    expect(route.sessionKey).toBe(`agent:main:webchannel:acme:direct:p:616c696365${TENANT_SUFFIX}`);
  });

  it("gives DISTINCT keys to two users on the SAME account (no cross-user collapse)", () => {
    const { api } = makeApi();
    const alice = resolveWebchannelSessionRoute(api, "acme", "alice", TENANT).sessionKey;
    const bob = resolveWebchannelSessionRoute(api, "acme", "bob", TENANT).sessionKey;
    expect(alice).not.toBe(bob);
    expect(alice).toBe(`agent:main:webchannel:acme:direct:p:616c696365${TENANT_SUFFIX}`);
    expect(bob).toBe(`agent:main:webchannel:acme:direct:p:626f62${TENANT_SUFFIX}`);
  });

  it("gives DISTINCT keys to the SAME user on two accounts (multiplex isolation)", () => {
    // per-channel-peer alone would collide here; per-account-channel-peer does not.
    const { api } = makeApi();
    const onA = resolveWebchannelSessionRoute(api, "acctA", "alice", TENANT).sessionKey;
    const onB = resolveWebchannelSessionRoute(api, "acctB", "alice", TENANT).sessionKey;
    expect(onA).not.toBe(onB);
  });

  it("preserves binding-based agent selection (agentId from the resolved route)", () => {
    const { api } = makeApi({ resolvedAgentId: "support-bot", resolvedAccountId: "acme" });
    const route = resolveWebchannelSessionRoute(api, "acme", "alice", TENANT);
    expect(route.agentId).toBe("support-bot");
    expect(route.sessionKey).toBe(`agent:support-bot:webchannel:acme:direct:p:616c696365${TENANT_SUFFIX}`);
  });

  it("returns an internally-consistent route (lastRoutePolicy re-derived to 'session')", () => {
    // The resolved route claimed lastRoutePolicy 'main' (its key == mainSessionKey);
    // once we force a per-peer key the policy must become 'session', not stay 'main'.
    const { api } = makeApi({ mockSessionKey: "agent:main:main" });
    const route = resolveWebchannelSessionRoute(api, "acme", "alice", TENANT);
    expect(route.sessionKey).not.toBe(route.mainSessionKey);
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("keeps maximum validated raw components within 512 when identityLinks are absent", () => {
    const maxAgentId = "g".repeat(64);
    const maxAccountId = "a".repeat(64);
    const maxPeerId = "p".repeat(128);
    const maxTenant = "T".repeat(128);
    const { api } = makeApi({
      resolvedAgentId: maxAgentId,
      resolvedAccountId: maxAccountId,
    });
    expect(api.config.session.identityLinks).toBeUndefined();

    const route = resolveWebchannelSessionRoute(
      api,
      maxAccountId,
      maxPeerId,
      maxTenant,
    );
    const tenantToken = route.sessionKey.split(":tenant:")[1]!.split(":")[0];

    expect(tenantToken).toMatch(/^[a-f0-9]{64}$/);
    // 128 ASCII bytes become 256 hex digits; the complete key stays bounded.
    expect(route.sessionKey).toHaveLength(492);
    expect(route.sessionKey.length).toBeLessThanOrEqual(512);
  });
});

// Use actual route selection as well as actual SDK key construction/normalization.
function realApi(config: Record<string, unknown> = {}) {
  const { api } = makeApi();
  api.config = { ...api.config, ...config };
  api.runtime.channel.routing.resolveAgentRoute = vi.fn(resolveAgentRoute);
  return api;
}

function canonicalKey(key: string): string {
  const parsed = parseAgentSessionKey(key);
  expect(parsed).not.toBeNull();
  return `agent:${parsed!.agentId}:${parsed!.rest}`;
}

function keyFor(api: ReturnType<typeof realApi>, peer: string, account = "acme", tenant = TENANT) {
  const route = resolveWebchannelSessionRoute(api, account, peer, tenant);
  expect(canonicalKey(route.sessionKey)).toBe(route.sessionKey);
  return route.sessionKey;
}

function legacyKey(peer: string, identityLinks?: Record<string, string[]>) {
  return canonicalKey(buildAgentSessionKey({
    agentId: "main", channel: "webchannel", accountId: "acme",
    peer: { kind: "direct", id: peer }, dmScope: "per-account-channel-peer", identityLinks,
  }) + TENANT_SUFFIX.replace(":peer-v2", ""));
}

describe("#372 — accepted peer space and deterministic core-context transition", () => {
  it("distinguishes every alphabet pair and each accepted character at all 128 lengths", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    const peers = new Set<string>([
      "Alice", "alice", "ALICE", "a-b", "a_b", "ab", "-a", "a-", "_a", "a_",
      "p_41", "p-41", "41", "0041", "link-0", "link_0", "peer-v2", "tenant", "main",
    ]);
    for (const a of alphabet) {
      for (let length = 1; length <= 128; length++) peers.add(a.repeat(length));
      for (const b of alphabet) peers.add(a + b);
    }
    const api = realApi();
    const keys = new Set<string>();
    for (const peer of peers) {
      expect(isValidSubjectToken(peer), peer).toBe(true);
      const key = keyFor(api, peer);
      expect(keys.has(key), peer).toBe(false);
      expect(key.length).toBeLessThanOrEqual(512);
      keys.add(key);
    }
    expect(keys.size).toBe(peers.size);
  });

  it("rejects invalid inputs before ASCII encoding can lose bytes or delimiters", () => {
    const api = realApi();
    for (const peer of ["", "a".repeat(129), "é", "Ａ", "a:b", "a.b", "a\n", "a b", "*", ">", "p:41", "link:0"]) {
      expect(isValidSubjectToken(peer), peer).toBe(false);
      expect(() => keyFor(api, peer), peer).toThrow(/peerId/);
    }
    expect(api.runtime.channel.routing.resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("starts fresh for letter-free peers too, without claiming ownership of any old context", () => {
    const api = realApi();
    for (const peer of ["Alice", "alice", "123", "_-", "0", "-", "_", "a".repeat(128)]) {
      expect(keyFor(api, peer)).not.toBe(legacyKey(peer));
      expect(keyFor(realApi(), peer)).toBe(keyFor(api, peer));
    }
    // Letter-free IDs themselves had an injective old derivation, but old
    // identityLinks could still pool a different user into that very context.
    expect(legacyKey("other", { "123": ["other"] })).toBe(legacyKey("123"));
  });

  it("cannot adopt an old link name that imitates the entire new peer/tenant/version suffix", () => {
    const next = keyFor(realApi(), "Alice");
    const forgedCanonical = next.slice("agent:main:webchannel:acme:direct:".length);
    const old = legacyKey("other", { [forgedCanonical]: ["other"] });
    expect(old.startsWith(next)).toBe(true);
    expect(old).not.toBe(next);
    expect(old).toMatch(/:tenant:[a-f0-9]{64}$/);
    expect(next).toMatch(/:tenant:[a-f0-9]{64}:peer-v2$/);
  });

  it("preserves distinct account/tenant tuples for case pairs after real route normalization", () => {
    const api = realApi();
    const keys = new Set<string>();
    for (const account of ["a", "a-b", "b"]) {
      for (const tenant of ["a", "A", "a-b", "a_b", "T".repeat(128)]) {
        for (const peer of ["Alice", "alice", "p_41", "41"]) keys.add(keyFor(api, peer, account, tenant));
      }
    }
    expect(keys.size).toBe(3 * 5 * 4);
  });

  it("keeps raw peer/account bindings and derives the SDK last-route target from the new key", () => {
    const api = realApi({
      agents: { list: [{ id: "main" }, { id: "upper" }, { id: "support" }] },
      bindings: [
        { agentId: "upper", match: { channel: "webchannel", accountId: "acme", peer: { kind: "direct", id: "Alice" } } },
        { agentId: "support", match: { channel: "webchannel", accountId: "acme" } },
      ],
      session: { dmScope: "main" },
    });
    const before = structuredClone(api.config);
    for (const [peer, account, agentId, matchedBy] of [
      ["Alice", "acme", "upper", "binding.peer"],
      ["alice", "acme", "support", "binding.account"],
      ["Alice", "other", "main", "default"],
    ]) {
      const route = resolveWebchannelSessionRoute(api, account!, peer!, TENANT);
      const original = resolveAgentRoute({ cfg: api.config, channel: "webchannel", accountId: account, peer: { kind: "direct", id: peer! } });
      expect(route).toMatchObject({ agentId, matchedBy, accountId: account, channel: original.channel, mainSessionKey: original.mainSessionKey });
      expect(route.sessionKey).not.toBe(original.sessionKey);
      expect(resolveInboundLastRouteSessionKey({ route, sessionKey: route.sessionKey })).toBe(route.sessionKey);
    }
    expect(api.config).toEqual(before);
  });
});

describe("#372 — SDK-selected intentional identityLinks", () => {
  it("preserves scoped/raw matching, case folding and link precedence without linking by canonical name", () => {
    const identityLinks = {
      " ": ["ignored"],
      Shared: [" WEBCHANNEL:Alice ", "BOB"],
      Other: ["bob", "carol"],
    };
    const api = realApi({ session: { identityLinks } });
    const shared = keyFor(api, "Alice");
    for (const peer of ["alice", "ALICE", "Bob", "bob"]) {
      expect(legacyKey(peer, identityLinks)).toBe(legacyKey("Alice", identityLinks));
      expect(keyFor(api, peer)).toBe(shared);
    }
    for (const peer of ["carol", "Shared", "shared", "ignored", "link-0"]) {
      expect(keyFor(api, peer)).not.toBe(shared);
    }
    expect(keyFor(api, "ignored")).toBe(keyFor(realApi(), "ignored"));
    expect(keyFor(api, "Alice", "other")).not.toBe(shared);
    expect(keyFor(api, "Alice", "acme", "other")).not.toBe(shared);
  });

  it("preserves canonical case equivalence without reordering overlapping link entries", () => {
    const identityLinks = {
      Alpha: ["a"],
      Beta: ["b"],
      " ALPHA ": ["b", "c"],
    };
    const api = realApi({ session: { identityLinks } });
    expect(legacyKey("a", identityLinks)).toBe(legacyKey("c", identityLinks));
    expect(legacyKey("b", identityLinks)).not.toBe(legacyKey("a", identityLinks));
    expect(keyFor(api, "a")).toBe(keyFor(api, "c"));
    expect(keyFor(api, "b")).not.toBe(keyFor(api, "a"));
  });

  it("bounds arbitrary canonical names and separates them from peers and tenant delimiters", () => {
    for (const canonical of ["p:416c696365", "link:0", "x:tenant:y:peer-v2", "Ä".repeat(4096), "__proto__"]) {
      const api = realApi({ session: { identityLinks: { [canonical]: ["Alice", "bob"] } } });
      const shared = keyFor(api, "Alice");
      expect(shared).toMatch(/:direct:l:[a-f0-9]{64}:tenant:[a-f0-9]{64}:peer-v2$/);
      expect(shared.length).toBeLessThanOrEqual(512);
      expect(keyFor(api, "bob")).toBe(shared);
      expect(keyFor(realApi(), "Alice")).not.toBe(shared);
      expect(legacyKey("Alice", { [canonical]: ["Alice", "bob"] })).not.toBe(shared);
    }
  });

  it("does not apply identityLinks a second time to encoded peers", () => {
    const api = realApi({ session: { identityLinks: { stolen: ["p:416c696365", "p:616c696365"] } } });
    expect(keyFor(api, "Alice")).toBe(keyFor(realApi(), "Alice"));
    expect(keyFor(api, "alice")).toBe(keyFor(realApi(), "alice"));
    expect(keyFor(api, "Alice")).not.toBe(keyFor(api, "alice"));
  });
});
