/**
 * #402/#403 — core-initiated outbound targeting and session routing.
 *
 * The audit reproduced both defects through core's own orchestration:
 * `message send --channel webchannel --target <peer>` failed with "Unknown
 * target", and a proactive send was mirrored into core's fallback key
 * (`agent:main:main`, or a tenant-less lowercase key) instead of the peer's
 * `:peer-v2` session. These tests drive the same core functions the pinned SDK
 * runs (see test-fixtures/core-outbound-internals.ts) against a real
 * conversation-key document under a temp storage root.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";

import { createWebChannelPlugin } from "./channel.js";
import { NullPeerChannel } from "./channel-contract.js";
import { ConversationKeyStore } from "./conversation-key-store.js";
import { createClawMessageAdapter } from "./message-adapter.js";
import { createNatsWebChannelPlugin } from "./nats-account-runtime.js";
import { normalizeWebchannelTarget } from "./outbound-target.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";
import { tupleStoragePaths } from "./storage-paths.js";
import {
  loadCoreResolveChannelTarget,
  loadCoreResolveOutboundSessionRoute,
  loadCoreResolveOutboundTargetWithPlugin,
  type CoreResolveChannelTarget,
  type CoreResolveOutboundSessionRoute,
  type CoreResolveOutboundTargetWithPlugin,
} from "./test-fixtures/core-outbound-internals.js";

const TENANT = "fixture-tenant";
const LIVE_TENANT = "live-tenant";

let resolveChannelTarget: CoreResolveChannelTarget;
let resolveOutboundSessionRoute: CoreResolveOutboundSessionRoute;
let resolveOutboundTargetWithPlugin: CoreResolveOutboundTargetWithPlugin;
let root: string;

beforeAll(async () => {
  resolveChannelTarget = await loadCoreResolveChannelTarget();
  resolveOutboundSessionRoute = await loadCoreResolveOutboundSessionRoute();
  resolveOutboundTargetWithPlugin = await loadCoreResolveOutboundTargetWithPlugin();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wc-outbound-target-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function config(session: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): any {
  return {
    ...extra,
    channels: {
      webchannel: {
        tenant: TENANT,
        storageRoot: root,
        accounts: { acme: {}, other: {} },
      },
    },
    session,
  };
}

function register(accountId: string, peerId: string, tenant = TENANT): void {
  new ConversationKeyStore({ tenant, accountId, storageRoot: root }).getOrCreate(peerId);
}

/** The key inbound dispatch gives `peerId`, through the real SDK route. */
function inboundSessionKey(cfg: any, accountId: string, peerId: string, tenant = TENANT): string {
  const api = { config: cfg, runtime: { channel: { routing: { resolveAgentRoute } } } } as any;
  return resolveWebchannelSessionRoute(api, accountId, peerId, tenant).sessionKey;
}

function withoutMessaging(plugin: object): object {
  return { ...plugin, messaging: undefined };
}

describe("target grammar (#402)", () => {
  it.each([
    ["Alice", "Alice"],
    ["  Alice  ", "Alice"],
    ["webchannel:Alice", "Alice"],
    ["WebChannel:Alice", "Alice"],
    ["user:Alice", "Alice"],
    ["USER:Alice", "Alice"],
    ["webchannel:user:Alice", "Alice"],
    // #372: peer ids are case-sensitive; only the prefixes fold.
    ["alice", "alice"],
    ["web-anon_2", "web-anon_2"],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeWebchannelTarget(raw)).toBe(expected);
  });

  it.each([
    "",
    "webchannel:",
    "user:",
    "a.b",
    "a*",
    ">",
    "has space",
    "group:room",
    "channel:room",
    "telegram:123",
    "user:webchannel:Alice",
    "x".repeat(129),
  ])("rejects %j", (raw) => {
    expect(normalizeWebchannelTarget(raw)).toBeUndefined();
  });
});

describe("core target resolution (#402)", () => {
  it("reproduces the audit: without the messaging adapter core reports Unknown target", async () => {
    register("acme", "Alice");
    const plugin = withoutMessaging(createWebChannelPlugin(new NullPeerChannel()));
    const result = await resolveChannelTarget({
      cfg: config(), channel: "webchannel", input: "Alice", accountId: "acme", plugin,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toMatch(/Unknown target "Alice"/);
  });

  it.each(["Alice", "user:Alice", "webchannel:Alice", "webchannel:user:Alice"])(
    "resolves registered %j to the bare case-preserved peer",
    async (input) => {
      register("acme", "Alice");
      const plugin = createWebChannelPlugin(new NullPeerChannel());
      const result = await resolveChannelTarget({
        cfg: config(), channel: "webchannel", input, accountId: "acme", plugin,
      });
      expect(result).toMatchObject({ ok: true, target: { to: "Alice", kind: "user" } });
    },
  );

  it("rejects a peer that never registered, even when core would keep a normalized target", async () => {
    register("acme", "Alice");
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    for (const unknownTargetMode of [undefined, "normalized"] as const) {
      await expect(resolveChannelTarget({
        cfg: config(), channel: "webchannel", input: "user:Bob", accountId: "acme", plugin,
        ...(unknownTargetMode ? { unknownTargetMode } : {}),
      })).rejects.toThrow(/unknown target "Bob" for account "acme".*registered/);
    }
  });

  it("#372: a case variant of a registered peer is a different, unknown peer", async () => {
    register("acme", "Alice");
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    await expect(resolveChannelTarget({
      cfg: config(), channel: "webchannel", input: "alice", accountId: "acme", plugin,
    })).rejects.toThrow(/unknown target "alice"/);
  });

  it("does not borrow another account's registration", async () => {
    register("other", "Alice");
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    await expect(resolveChannelTarget({
      cfg: config(), channel: "webchannel", input: "Alice", accountId: "acme", plugin,
    })).rejects.toThrow(/unknown target "Alice" for account "acme"/);
    await expect(resolveChannelTarget({
      cfg: config(), channel: "webchannel", input: "Alice", accountId: "other", plugin,
    })).resolves.toMatchObject({ ok: true, target: { to: "Alice" } });
  });

  it("selects the account exactly as the send surfaces do", async () => {
    register("acme", "Alice");
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    await expect(resolveChannelTarget({
      cfg: config(), channel: "webchannel", input: "Alice", accountId: "ghost", plugin,
    })).rejects.toThrow(/outbound account "ghost" is not a valid listed account/);
    const disabled = config();
    disabled.channels.webchannel.accounts.acme.enabled = false;
    await expect(resolveChannelTarget({
      cfg: disabled, channel: "webchannel", input: "Alice", accountId: "acme", plugin,
    })).rejects.toThrow(/outbound account "acme" is disabled/);
  });

  it("reports an unparseable target as core's Unknown target with the peer hint", async () => {
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    const result = await resolveChannelTarget({
      cfg: config(), channel: "webchannel", input: "a.b", accountId: "acme", plugin,
    });
    expect(!result.ok && result.error.message).toMatch(/Unknown target "a\.b".*<peerId>/);
  });

  it.each(["current", "self", "this", "me", "Me", "webchannel:me"])(
    "refuses reserved %j as a literal destination, as Telegram does",
    async (input) => {
      register("acme", "me");
      const plugin = createWebChannelPlugin(new NullPeerChannel());
      const result = await resolveChannelTarget({
        cfg: config(), channel: "webchannel", input, accountId: "acme", plugin,
      });
      expect(!result.ok && result.error.message).toMatch(/Reserved target ".*" for WebChannel/);
    },
  );

  it("rejects prefixed reserved peers during cron-shaped target resolution", async () => {
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    for (const peerId of ["current", "self", "this", "me", "Me"]) {
      register("acme", peerId);
      for (const input of [`user:${peerId}`, `webchannel:user:${peerId}`]) {
        // Cron first docks the raw target. Core permits the explicit `user:`
        // grammar here, then asks the channel resolver to normalize it.
        const docked = resolveOutboundTargetWithPlugin({
          plugin,
          target: { channel: "webchannel", to: input, cfg: config(), accountId: "acme", mode: "explicit" },
        });
        expect(docked).toEqual({ ok: true, to: input });
        await expect(resolveChannelTarget({
          cfg: config(), channel: "webchannel", input, accountId: "acme", plugin,
          unknownTargetMode: "normalized",
        })).rejects.toThrow(new RegExp(`reserved target ${JSON.stringify(peerId)}`, "i"));
      }
    }
  });

  it("never quarantines a corrupt key document it only reads", async () => {
    // The CLI resolves targets beside a running gateway. The store's lazy load
    // would archive a corrupt document as `<file>.corrupt-v2-*` and persist an
    // empty map in its place, erasing every peer's key under the gateway.
    register("acme", "Alice");
    const paths = tupleStoragePaths({ tenant: TENANT, accountId: "acme", storageRoot: root });
    writeFileSync(paths.conversationKeyPath, "{ not a key document");
    const before = {
      keys: readFileSync(paths.conversationKeyPath),
      generations: readFileSync(paths.conversationKeyGenerationsPath),
      entries: readdirSync(paths.directory).sort(),
    };
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    await expect(resolveChannelTarget({
      cfg: config(), channel: "webchannel", input: "Alice", accountId: "acme", plugin,
    })).rejects.toThrow(/cannot resolve target "Alice" for account "acme"/);
    expect(readFileSync(paths.conversationKeyPath)).toEqual(before.keys);
    expect(readFileSync(paths.conversationKeyGenerationsPath)).toEqual(before.generations);
    expect(readdirSync(paths.directory).sort()).toEqual(before.entries);
    expect(readdirSync(paths.directory).filter((name) => name.includes(".corrupt-"))).toEqual([]);
  });

  it("creates nothing when no key document exists", async () => {
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    await expect(resolveChannelTarget({
      cfg: config(), channel: "webchannel", input: "Alice", accountId: "acme", plugin,
    })).rejects.toThrow(/unknown target "Alice" for account "acme"/);
    const paths = tupleStoragePaths({ tenant: TENANT, accountId: "acme", storageRoot: root });
    expect(existsSync(paths.conversationKeyPath)).toBe(false);
    expect(existsSync(paths.conversationKeyGenerationsPath)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("resolves from disk without a live runtime, as the CLI process does", async () => {
    register("acme", "Alice");
    const plugin = createNatsWebChannelPlugin(new Map());
    await expect(resolveChannelTarget({
      cfg: config(), channel: "webchannel", input: "Alice", accountId: "acme", plugin,
    })).resolves.toMatchObject({ ok: true, target: { to: "Alice" } });
  });
});

describe("outbound session route (#403)", () => {
  it("reproduces the audit: without the hook core mirrors into its fallback key", async () => {
    register("acme", "Alice");
    const plugin = withoutMessaging(createWebChannelPlugin(new NullPeerChannel()));
    const shared = await resolveOutboundSessionRoute({
      cfg: config(), channel: "webchannel", plugin, agentId: "main", accountId: "acme", target: "Alice",
    });
    expect(shared?.sessionKey).toBe("agent:main:main");
    const scoped = await resolveOutboundSessionRoute({
      cfg: config({ dmScope: "per-channel-peer" }), channel: "webchannel", plugin,
      agentId: "main", accountId: "acme", target: "Alice",
    });
    expect(scoped?.sessionKey).toBe("agent:main:webchannel:direct:alice");
  });

  it.each([
    ["default dmScope", {}],
    ["global per-channel-peer", { dmScope: "per-channel-peer" }],
    ["identityLinks", { identityLinks: { "Alice Canonical": ["webchannel:Alice"] } }],
  ])("routes into the peer's inbound session under %s", async (_label, session) => {
    register("acme", "Alice");
    const cfg = config(session);
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    const expected = inboundSessionKey(cfg, "acme", "Alice");
    expect(expected).toMatch(/:peer-v2$/);
    for (const target of ["Alice", "user:Alice", "webchannel:Alice"]) {
      const route = await resolveOutboundSessionRoute({
        cfg, channel: "webchannel", plugin, agentId: "main", accountId: "acme", target,
      });
      expect(route).toMatchObject({
        sessionKey: expected,
        baseSessionKey: expected,
        recipientSessionExact: "delivery-identity",
        to: "Alice",
      });
    }
  });

  it("keys the sending agent, as Telegram does, when a binding routes the peer elsewhere", async () => {
    register("acme", "Alice");
    const cfg = config({}, {
      agents: { list: [{ id: "main" }, { id: "support" }] },
      bindings: [{ agentId: "support", match: { channel: "webchannel", accountId: "acme" } }],
    });
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    const inbound = inboundSessionKey(cfg, "acme", "Alice");
    expect(inbound).toMatch(/^agent:support:webchannel:acme:direct:.*:peer-v2$/);
    const route = (agentId: string) => resolveOutboundSessionRoute({
      cfg, channel: "webchannel", plugin, agentId, accountId: "acme", target: "Alice",
    });
    // The bound agent mirrors into the peer's inbound session.
    expect((await route("support"))?.sessionKey).toBe(inbound);
    // Another sender records what IT said, in its own peer-scoped session:
    // same encoding, tenant and :peer-v2 marker, only the agent differs.
    const fromMain = (await route("main"))?.sessionKey;
    expect(fromMain).toBe(inbound.replace(/^agent:support:/, "agent:main:"));
    expect(fromMain).not.toBe(inbound);
  });

  it("#372: case-distinct registered peers keep distinct sessions", async () => {
    register("acme", "Alice");
    register("acme", "alice");
    const cfg = config();
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    const route = (target: string) => resolveOutboundSessionRoute({
      cfg, channel: "webchannel", plugin, agentId: "main", accountId: "acme", target,
    });
    const [upper, lower] = await Promise.all([route("Alice"), route("alice")]);
    expect(upper?.sessionKey).toBe(inboundSessionKey(cfg, "acme", "Alice"));
    expect(lower?.sessionKey).toBe(inboundSessionKey(cfg, "acme", "alice"));
    expect(upper?.sessionKey).not.toBe(lower?.sessionKey);
  });

  it("keys each account separately and refuses an unregistered peer", async () => {
    register("acme", "Alice");
    register("other", "Alice");
    const cfg = config();
    const plugin = createWebChannelPlugin(new NullPeerChannel());
    const acme = await resolveOutboundSessionRoute({
      cfg, channel: "webchannel", plugin, agentId: "main", accountId: "acme", target: "Alice",
    });
    const other = await resolveOutboundSessionRoute({
      cfg, channel: "webchannel", plugin, agentId: "main", accountId: "other", target: "Alice",
    });
    expect(acme?.sessionKey).toBe(inboundSessionKey(cfg, "acme", "Alice"));
    expect(other?.sessionKey).toBe(inboundSessionKey(cfg, "other", "Alice"));
    expect(acme?.sessionKey).not.toBe(other?.sessionKey);
    await expect(resolveOutboundSessionRoute({
      cfg, channel: "webchannel", plugin, agentId: "main", accountId: "acme", target: "Bob",
    })).rejects.toThrow(/unknown target "Bob" for account "acme"/);
  });

  it("uses a live runtime's serving tenant and store over the current config", async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), "wc-outbound-live-"));
    try {
      new ConversationKeyStore({ tenant: LIVE_TENANT, accountId: "acme", storageRoot: liveRoot })
        .getOrCreate("Alice");
      const cfg = config();
      const plugin = createNatsWebChannelPlugin(new Map([
        ["acme", { channel: new NullPeerChannel() as any, tenant: LIVE_TENANT, storageRoot: liveRoot }],
      ]));
      const route = await resolveOutboundSessionRoute({
        cfg, channel: "webchannel", plugin, agentId: "main", accountId: "acme", target: "Alice",
      });
      expect(route?.sessionKey).toBe(inboundSessionKey(cfg, "acme", "Alice", LIVE_TENANT));
      expect(route?.sessionKey).not.toBe(inboundSessionKey(cfg, "acme", "Alice"));
    } finally {
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });
});

describe("send surfaces accept the target grammar (#402)", () => {
  it("strips explicit prefixes before the legacy outbound send", async () => {
    const transport = new NullPeerChannel();
    const sendText = vi.spyOn(transport, "sendText").mockReturnValue(true);
    const plugin = createWebChannelPlugin(transport) as any;
    await plugin.outbound.sendText({ to: "webchannel:user:Alice", text: "hi" });
    expect(sendText.mock.calls[0]![0]).toBe("Alice");
    await plugin.outbound.sendText({ to: "me", text: "reply" });
    expect(sendText.mock.calls[1]![0]).toBe("me");
    await expect(plugin.outbound.sendText({ to: "a.b", text: "hi" }))
      .rejects.toThrow(/outbound target "a\.b" is not a valid peer id/);
  });

  it("strips explicit prefixes before the message adapter send", async () => {
    const transport = new NullPeerChannel();
    const sendText = vi.spyOn(transport, "sendText").mockReturnValue(true);
    const adapter = createClawMessageAdapter(transport) as any;
    await adapter.send.text({ to: "user:Alice", text: "hi" });
    expect(sendText.mock.calls[0]![0]).toBe("Alice");
    await adapter.send.text({ to: "me", text: "reply" });
    expect(sendText.mock.calls[1]![0]).toBe("me");
    await expect(adapter.send.text({ to: "group:room", text: "hi" }))
      .rejects.toThrow(/outbound target "group:room" is not a valid peer id/);
  });
});
