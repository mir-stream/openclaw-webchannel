/**
 * `resolveWebchannelSessionRoute` — FORCED per-user session isolation (Option A).
 *
 * These tests are the real isolation coverage that replaces the retired
 * `crossUserHistoryWarning`: they prove the helper OVERRIDES whatever session
 * key `resolveAgentRoute` returned with a `per-account-channel-peer` key, so a
 * multi-user register-hop account can never collapse peers onto one session —
 * regardless of the operator's global `session.dmScope`.
 *
 * Since #112 the key also carries a `:tenant:<t>` component. Tenant ISOLATION
 * itself is covered in `session-route-tenant-isolation.test.ts`; here the tenant
 * is pinned to a fixture value only so these per-user assertions can spell the
 * whole key. The fixture config declares it explicitly rather than leaning on
 * the fallback, so an ambient `WEBCHANNEL_TENANT` in a developer shell cannot
 * change what these tests assert.
 */
import { createHash } from "node:crypto";

import { describe, it, expect, vi } from "vitest";

import { resolveWebchannelSessionRoute } from "./session-route.js";

/** The tenant every account in this file's fixture config is served under. */
const TENANT = "fixture-tenant";
/**
 * The `:tenant:` component the derivation appends for `TENANT` (#112):
 * `<lowercased tenant>-<16 hex of sha256(verbatim tenant)>`. The digest is what
 * survives core's lowercase fold at the store boundary; the isolation suite in
 * `session-route-tenant-isolation.test.ts` is what proves that end-to-end.
 */
const TENANT_SUFFIX = `:tenant:${TENANT}-${createHash("sha256")
  .update(TENANT, "utf8")
  .digest("hex")
  .slice(0, 16)}`;

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
  it("forces per-account-channel-peer, overriding a collapsed 'main' session key", () => {
    const { api } = makeApi({ mockSessionKey: "agent:main:main" });
    const route = resolveWebchannelSessionRoute(api, "acme", "alice");
    // The naive main key is discarded for the isolated per-peer key.
    expect(route.sessionKey).toBe(`agent:main:webchannel:acme:direct:alice${TENANT_SUFFIX}`);
  });

  it("gives DISTINCT keys to two users on the SAME account (no cross-user collapse)", () => {
    const { api } = makeApi();
    const alice = resolveWebchannelSessionRoute(api, "acme", "alice").sessionKey;
    const bob = resolveWebchannelSessionRoute(api, "acme", "bob").sessionKey;
    expect(alice).not.toBe(bob);
    expect(alice).toBe(`agent:main:webchannel:acme:direct:alice${TENANT_SUFFIX}`);
    expect(bob).toBe(`agent:main:webchannel:acme:direct:bob${TENANT_SUFFIX}`);
  });

  it("gives DISTINCT keys to the SAME user on two accounts (multiplex isolation)", () => {
    // per-channel-peer alone would collide here; per-account-channel-peer does not.
    const { api } = makeApi();
    const onA = resolveWebchannelSessionRoute(api, "acctA", "alice").sessionKey;
    const onB = resolveWebchannelSessionRoute(api, "acctB", "alice").sessionKey;
    expect(onA).not.toBe(onB);
  });

  it("preserves binding-based agent selection (agentId from the resolved route)", () => {
    const { api } = makeApi({ resolvedAgentId: "support-bot", resolvedAccountId: "acme" });
    const route = resolveWebchannelSessionRoute(api, "acme", "alice");
    expect(route.agentId).toBe("support-bot");
    expect(route.sessionKey).toBe(`agent:support-bot:webchannel:acme:direct:alice${TENANT_SUFFIX}`);
  });

  it("returns an internally-consistent route (lastRoutePolicy re-derived to 'session')", () => {
    // The resolved route claimed lastRoutePolicy 'main' (its key == mainSessionKey);
    // once we force a per-peer key the policy must become 'session', not stay 'main'.
    const { api } = makeApi({ mockSessionKey: "agent:main:main" });
    const route = resolveWebchannelSessionRoute(api, "acme", "alice");
    expect(route.sessionKey).not.toBe(route.mainSessionKey);
    expect(route.lastRoutePolicy).toBe("session");
  });
});
