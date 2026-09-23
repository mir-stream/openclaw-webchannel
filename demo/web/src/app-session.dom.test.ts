// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  TENANT, PEER, JWT, FakeNatsWS, installFakeWebSocket,
  makeAgentIdentity, settleUntil,
} from "../../../packages/client/src/nats-client-wrapped.test-harness.js";
import { createWiretap } from "./wiretap.js";

const accounts = { alpha: { natsUrl: "ws://alpha" }, beta: { natsUrl: "ws://beta" } };
const config = { tenant: TENANT, issuerUrl: "https://issuer.invalid", accounts, llmMode: "echo" as const };
const cleanup: Array<() => void> = [];
const requests: Array<{ path: string; init: RequestInit }> = [];
let beforeFetch: ((path: string, init: RequestInit) => Promise<void>) | undefined;
let me: { username: string; isAdmin: boolean; accounts: typeof accounts | Record<string, { natsUrl: string }> };
let poll: () => Promise<void>;
let logoutStatus: number;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function tab(name: string): HTMLButtonElement {
  return Array.from(byId("chat-tabs").querySelectorAll("button")).find(b => b.textContent === name)!;
}
async function boot() { await import("./app.js"); }

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("__DEMO_CONFIG__", structuredClone(config));
  document.body.innerHTML = readFileSync("demo/web/index.html", "utf8");
  cleanup.push(installFakeWebSocket());
  vi.spyOn(window, "setInterval").mockImplementation((fn: TimerHandler, ms?: number) => {
    if (ms === 3000) poll = fn as () => Promise<void>;
    return 1 as unknown as ReturnType<typeof window.setInterval>;
  });
  requests.length = 0;
  beforeFetch = undefined;
  logoutStatus = 200;
  me = { username: "alice", isAdmin: false, accounts };
  const identity = makeAgentIdentity();
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    requests.push({ path, init });
    const data = path === "/me" ? me
      : path === "/login" || path === "/logout" ? { ok: true }
      : path === "/bootstrap" ? { jwt: JWT, peerId: PEER, agentPublicKey: identity.publicB64url }
      : path === "/nats-user" || path === "/admin/nats-user" ? { userJwt: JWT, userSeedRaw: Buffer.alloc(32, 4).toString("base64url") }
      : {};
    // Capture the old response and deliberately ignore abort to test fencing.
    await beforeFetch?.(path, init);
    const status = path === "/logout" ? logoutStatus : 200;
    return { ok: status === 200, status, json: async () => data };
  }));
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  for (const fn of cleanup.splice(0).reverse()) fn();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("keeps the latest account when initial authentication completes out of order", async () => {
  const gate = deferred();
  let blocked = false;
  beforeFetch = async (path, init) => {
    if (path === "/bootstrap" && JSON.parse(init.body as string).accountId === "alpha") {
      blocked = true;
      await gate.promise;
    }
  };
  await boot();
  await settleUntil(() => blocked, { label: "alpha bootstrap" });
  const oldRequest = requests.at(-1)!;
  tab("beta").click();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "beta mount" });
  expect(oldRequest.init.signal?.aborted).toBe(true);
  expect(FakeNatsWS.instances[0].url).toBe("ws://beta");
  gate.resolve();
  await setImmediate();
  expect(FakeNatsWS.instances).toHaveLength(1);
  expect(byId("chat-lane").querySelector("strong")!.textContent).toBe("beta");
  // The stale promise must not steal the teardown for beta.
  window.dispatchEvent(new Event("pagehide"));
  expect(FakeNatsWS.instances[0].readyState).toBe(FakeNatsWS.CLOSED);
});

it("revoking all grants cancels an account that is still authenticating", async () => {
  const gate = deferred();
  let blocked = false;
  beforeFetch = async path => { if (path === "/nats-user") { blocked = true; await gate.promise; } };
  await boot();
  await settleUntil(() => blocked, { label: "pending initial auth" });
  me = { ...me, accounts: {} };
  await poll();
  gate.resolve();
  await setImmediate();
  expect(byId("chat-tabs").textContent).toContain("No agent granted");
  expect(byId("chat-lane").childElementCount).toBe(0);
  expect(FakeNatsWS.instances).toHaveLength(0);
});

it("a stale startup session response cannot replace a later login", async () => {
  const gate = deferred();
  let blocked = false;
  beforeFetch = async path => { if (path === "/me" && !blocked) { blocked = true; await gate.promise; } };
  await boot();
  await settleUntil(() => blocked, { label: "startup session lookup" });
  const oldRequest = requests[0];
  me = { username: "bob", isAdmin: false, accounts: { beta: accounts.beta } };
  byId<HTMLInputElement>("username").value = "bob";
  byId<HTMLInputElement>("password").value = "demo";
  byId<HTMLButtonElement>("login-btn").click();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "new login mount" });
  gate.resolve();
  await setImmediate();
  expect(oldRequest.init.signal?.aborted).toBe(true);
  expect(byId("whoami").textContent).toBe("bob");
  expect(byId("chat-lane").querySelector("strong")!.textContent).toBe("beta");
  expect(FakeNatsWS.instances).toHaveLength(1);
});

it("aborting pending observer credentials cannot create a late wiretap socket", async () => {
  const owner = new AbortController();
  const gate = deferred();
  beforeFetch = async () => { await gate.promise; };
  const root = byId("wiretap-body");
  const mounting = createWiretap(root, config, "alpha", owner.signal);
  owner.abort();
  root.textContent = "new session";
  gate.resolve();
  const teardown = await mounting;
  teardown();
  expect(requests[0].init.signal?.aborted).toBe(true);
  expect(FakeNatsWS.instances).toHaveLength(0);
  expect(root.textContent).toBe("new session");
});

it("logs out before showing sign-in and fences stale re-auth and poll responses across a new login", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  const authGate = deferred();
  const pollGate = deferred();
  const logoutGate = deferred();
  let blockedAuth = false;
  beforeFetch = async path => {
    if (path === "/nats-user") { blockedAuth = true; await authGate.promise; }
    if (path === "/me") await pollGate.promise;
    if (path === "/logout") await logoutGate.promise;
  };
  Array.from(byId("chat-lane").querySelectorAll("button")).find(b => b.textContent!.includes("short-lived"))!.click();
  await settleUntil(() => blockedAuth, { label: "pending re-auth" });
  const staleAuth = requests.at(-1)!;
  const polling = poll();
  const stalePoll = requests.at(-1)!;
  byId<HTMLButtonElement>("logout").click();
  expect(requests.at(-1)).toMatchObject({ path: "/logout", init: { method: "POST", credentials: "same-origin" } });
  expect(staleAuth.init.signal?.aborted).toBe(true);
  expect(stalePoll.init.signal?.aborted).toBe(true);
  expect(byId("login").classList.contains("hidden")).toBe(true);
  expect(byId<HTMLButtonElement>("login-btn").disabled).toBe(true);
  logoutGate.resolve();
  await settleUntil(() => !byId<HTMLButtonElement>("login-btn").disabled, { label: "logout completion" });
  expect(byId("login").classList.contains("hidden")).toBe(false);
  expect(byId("app").classList.contains("hidden")).toBe(true);
  expect(byId("logout").classList.contains("hidden")).toBe(true);

  beforeFetch = undefined;
  me = { username: "bob", isAdmin: false, accounts: { beta: accounts.beta } };
  byId<HTMLInputElement>("username").value = "bob";
  byId<HTMLInputElement>("password").value = "demo";
  byId<HTMLButtonElement>("login-btn").click();
  await settleUntil(() => FakeNatsWS.instances.length === 2, { label: "new session" });
  authGate.resolve();
  pollGate.resolve();
  await polling;
  await setImmediate();
  expect(FakeNatsWS.instances).toHaveLength(2);
  expect(FakeNatsWS.instances[0].readyState).toBe(FakeNatsWS.CLOSED);
  expect(byId("whoami").textContent).toBe("bob");
  expect(byId("chat-tabs").textContent).toBe("beta");
  expect(byId("chat-lane").querySelector("strong")!.textContent).toBe("beta");
});

it("logout during the first bootstrap cannot resurrect the session or create a socket", async () => {
  const gate = deferred();
  let blocked = false;
  beforeFetch = async path => { if (path === "/bootstrap") { blocked = true; await gate.promise; } };
  await boot();
  await settleUntil(() => blocked, { label: "initial bootstrap" });
  byId<HTMLButtonElement>("logout").click();
  await settleUntil(() => !byId("login").classList.contains("hidden"), { label: "signed out" });
  gate.resolve();
  await setImmediate();
  expect(FakeNatsWS.instances).toHaveLength(0);
  expect(byId("app").classList.contains("hidden")).toBe(true);
  expect(byId("chat-body").childElementCount).toBe(0);
  expect(byId("whoami").textContent).toBe("");
});

it("admin logout retires an observer whose credentials have not arrived", async () => {
  me = { ...me, username: "admin", isAdmin: true };
  const gate = deferred();
  let blocked = false;
  beforeFetch = async path => { if (path === "/admin/nats-user") { blocked = true; await gate.promise; } };
  await boot();
  await settleUntil(() => blocked, { label: "observer credentials" });
  const stale = requests.at(-1)!;
  byId<HTMLButtonElement>("logout").click();
  await settleUntil(() => !byId("login").classList.contains("hidden"), { label: "admin signed out" });
  gate.resolve();
  await setImmediate();
  expect(stale.init.signal?.aborted).toBe(true);
  expect(FakeNatsWS.instances).toHaveLength(1);
  expect(FakeNatsWS.instances[0].readyState).toBe(FakeNatsWS.CLOSED);
  expect(byId("wiretap-body").childElementCount).toBe(0);
  expect(byId("app").classList.contains("hidden")).toBe(true);
});

it("reports a failed logout, blocks a racing login and accepts an already-invalidated session on retry", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  beforeFetch = async path => { if (path === "/logout") throw new Error("offline"); };
  byId<HTMLButtonElement>("logout").click();
  await settleUntil(() => byId("login-err").textContent!.includes("Log out failed"), { label: "logout failure" });
  expect(byId("login-err").textContent).toContain("session may still be active");
  expect(byId<HTMLButtonElement>("login-btn").disabled).toBe(true);
  byId<HTMLInputElement>("password").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(requests.some(r => r.path === "/login")).toBe(false);
  beforeFetch = undefined;
  logoutStatus = 401;
  byId<HTMLButtonElement>("logout").click();
  await settleUntil(() => !byId<HTMLButtonElement>("login-btn").disabled, { label: "logout retry" });
  expect(byId("logout").classList.contains("hidden")).toBe(true);
  expect(byId("login-err").textContent).toBe("");
});
