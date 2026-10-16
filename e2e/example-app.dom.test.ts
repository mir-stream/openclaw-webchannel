// @vitest-environment jsdom
import { setImmediate } from "node:timers/promises";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebChannelState } from "openclaw-webchannel-client";

const fake = vi.hoisted(() => ({ clients: [] as any[] }));
vi.mock("openclaw-webchannel-client", () => ({
  generateDevicePopKeyPair: async () => ({ privateKey: {}, publicJwk: { x: "public-pop" } }),
  WebChannelNATSClient: class {
    listeners = new Set<(state: WebChannelState) => void>();
    state = { agentProtocolVersion: null, agentPluginVersion: null, status: "connecting", connected: false, messages: [], approvals: [], reasoning: [], toolActivity: [] };
    connect = vi.fn();
    close = vi.fn();
    send = vi.fn(() => ({}));
    constructor(readonly options: any) { fake.clients.push(this); }
    subscribe(fn: (state: WebChannelState) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    getState() { return this.state; }
    emit(state: any) { this.state = { ...this.state, ...state }; for (const fn of this.listeners) fn(this.state as WebChannelState); }
  },
}));

let fetchHook: ((path: string, init: RequestInit) => Promise<void>) | undefined;
beforeEach(() => {
  vi.resetModules(); fake.clients.length = 0; fetchHook = undefined;
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    await fetchHook?.(path, init); // ignores abort to exercise generation fences
    const data = path === "/login" ? { token: "token", peerId: "peer", accountId: "account", tenant: "tenant" }
      : path === "/bootstrap" ? { jwt: "jwt", peerId: "peer", natsUrl: "ws://fixture", agentPublicKey: "pin" }
      : { userJwt: "jwt", userSeedRaw: "seed", natsUrl: "ws://fixture" };
    return { ok: true, json: async () => data };
  }));
});
afterEach(() => {
  document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function mount() {
  document.body.innerHTML = '<form id="login"><input name="username" value="a"><input name="password" value="p"></form><div id="status"></div><div id="banner"></div><div id="chat"></div><form id="composer"><input id="msg"></form>';
  await import("../examples/webchannel-app/web/app.js");
}
function login() { document.getElementById("login")!.dispatchEvent(new Event("submit", { cancelable: true })); }

it("#415 F4: a replaced pending connection cannot construct an orphan client", async () => {
  const gate = deferred(); let boots = 0;
  fetchHook = async path => { if (path === "/bootstrap" && ++boots === 1) await gate.promise; };
  await mount(); login();
  await vi.waitFor(() => expect(boots).toBe(1));
  login(); await vi.waitFor(() => expect(fake.clients).toHaveLength(1));
  gate.resolve();
  await vi.waitFor(() => expect(document.getElementById("status")!.textContent).toContain("connecting"));
  // Drain the now-unblocked auth chain before counting live constructors.
  await setImmediate();
  expect(fake.clients).toHaveLength(1);
  expect(fake.clients[0].connect).toHaveBeenCalledOnce();
});

it("#415 F4: replacement unsubscribes and fences the retired client's render", async () => {
  await mount(); login(); await vi.waitFor(() => expect(fake.clients).toHaveLength(1));
  const old = fake.clients[0];
  login(); await vi.waitFor(() => expect(fake.clients).toHaveLength(2));
  expect(old.close).toHaveBeenCalledOnce(); expect(old.listeners.size).toBe(0);
  old.emit({ status: "error", error: "stale error" });
  expect(document.body.textContent).not.toContain("stale error");
});

it("#415 F4: a rejected stale authentication cannot overwrite a newer connection", async () => {
  const gate = deferred(); let boots = 0;
  fetchHook = async path => {
    if (path === "/bootstrap" && ++boots === 1) { await gate.promise; throw new Error("stale authentication failure"); }
  };
  await mount(); login(); await vi.waitFor(() => expect(boots).toBe(1));
  login(); await vi.waitFor(() => expect(fake.clients).toHaveLength(1));
  fake.clients[0].emit({ status: "connected", connected: true });
  gate.resolve(); await setImmediate();
  expect(document.getElementById("status")!.textContent).toContain("connected");
  expect(document.body.textContent).not.toContain("stale authentication failure");
});

it("#415 F5: typed protocol failure offers upgrade guidance, never an inferred agent timeout", async () => {
  await mount(); login(); await vi.waitFor(() => expect(fake.clients).toHaveLength(1));
  fake.clients[0].emit({ status: "error", error: "request timeout", errorCause: "protocol-mismatch" });
  expect(document.getElementById("banner")!.textContent).toContain("Upgrade");
  expect(document.getElementById("banner")!.textContent).not.toContain("Waiting for an agent");
  expect(document.getElementById("banner")!.querySelector("button")).toBeNull();
});

it("#415 F5: authentication failure offers a fresh authentication attempt", async () => {
  await mount(); login(); await vi.waitFor(() => expect(fake.clients).toHaveLength(1));
  fake.clients[0].emit({ status: "error", errorCause: "auth-expired", error: "expired" });
  const retry = document.getElementById("banner")!.querySelector("button");
  expect(retry?.textContent).toBe("Re-authenticate");
  retry!.click(); await vi.waitFor(() => expect(fake.clients).toHaveLength(2));
});

it("#415 F5: minimal consumer includes only actionable approvals", async () => {
  const { summarize } = await import("../examples/minimal-consumer/src/widget.js");
  const state = { status: "connected", approvals: [
    { id: "history", actionable: false }, { id: "live", actionable: true },
  ] } as WebChannelState;
  expect(summarize(state).pendingApprovals.map(a => a.id)).toEqual(["live"]);
});
