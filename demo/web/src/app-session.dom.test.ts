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
let meStatus: number;
const polls = new Map<number, () => Promise<void>>();

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
function pageEvent(type: "pagehide" | "pageshow", persisted = true): void {
  window.dispatchEvent(new PageTransitionEvent(type, { persisted }));
}
function composer(): HTMLInputElement { return byId("chat-lane").querySelector("input")!; }

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("__DEMO_CONFIG__", structuredClone(config));
  document.body.innerHTML = readFileSync("demo/web/index.html", "utf8");
  cleanup.push(installFakeWebSocket());
  vi.spyOn(window, "addEventListener");
  polls.clear();
  let timerId = 0;
  vi.spyOn(window, "setInterval").mockImplementation((fn: TimerHandler, ms?: number) => {
    const id = ++timerId;
    if (ms === 3000) {
      poll = fn as () => Promise<void>;
      polls.set(id, poll);
    }
    return id as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.spyOn(window, "clearInterval").mockImplementation(id => { polls.delete(Number(id)); });
  requests.length = 0;
  beforeFetch = undefined;
  logoutStatus = 200;
  meStatus = 200;
  me = { username: "alice", isAdmin: false, accounts };
  const identity = makeAgentIdentity();
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    requests.push({ path, init });
    const data = path === "/me" ? me
      : path === "/login" || path === "/logout" ? { ok: true }
      : path === "/bootstrap" ? { jwt: JWT, peerId: PEER, agentPublicKey: identity.publicB64url }
      : path === "/nats-user" || path === "/admin/nats-user" ? { userJwt: JWT, userSeedRaw: Buffer.alloc(32, 4).toString("base64url") }
      : {};
    const status = path === "/logout" ? logoutStatus : path === "/me" ? meStatus : 200;
    // Capture the old response and deliberately ignore abort to test fencing.
    await beforeFetch?.(path, init);
    return { ok: status === 200, status, json: async () => data };
  }));
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  // Lifecycle listeners must survive multiple BFCache cycles in production;
  // each test imports a fresh app module and removes its own listeners here.
  for (const [type, listener] of vi.mocked(window.addEventListener).mock.calls) {
    if (type === "pagehide" || type === "pageshow") window.removeEventListener(type, listener);
  }
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

it("restores the selected lane, unsent draft and one poll across repeated BFCache cycles", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  tab("beta").click();
  await settleUntil(() => FakeNatsWS.instances.length === 2, { label: "selected beta" });
  composer().value = "unsent beta draft";
  pageEvent("pageshow", false); // The initial pageshow must not boot again.
  await setImmediate();
  expect(requests.filter(r => r.path === "/me")).toHaveLength(1);
  for (let cycle = 0; cycle < 2; cycle++) {
    const oldSocket = FakeNatsWS.instances.at(-1)!;
    pageEvent("pagehide");
    expect(oldSocket.readyState).toBe(FakeNatsWS.CLOSED);
    expect(polls.size).toBe(0);
    expect(byId("chat-body").childElementCount).toBe(0);
    const meRequests = requests.filter(r => r.path === "/me").length;
    pageEvent("pageshow");
    pageEvent("pageshow"); // Duplicate notifications cannot remount or repoll.
    await settleUntil(() => FakeNatsWS.instances.length === cycle + 3, { label: "restored lane" });
    expect(requests.filter(r => r.path === "/me")).toHaveLength(meRequests + 1);
    expect(byId("chat-lane").querySelector("strong")!.textContent).toBe("beta");
    expect(composer().value).toBe("unsent beta draft");
    expect(byId("app").classList.contains("hidden")).toBe(false);
    expect(polls.size).toBe(1);
    await polls.values().next().value!();
    expect(requests.filter(r => r.path === "/me")).toHaveLength(meRequests + 2);
  }
  expect(FakeNatsWS.instances.filter(ws => ws.readyState === FakeNatsWS.OPEN)).toHaveLength(1);
});

it("returns to usable sign-in when the cached session expired and ignores its old poll", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  composer().value = "old private draft";
  const gate = deferred();
  beforeFetch = async path => { if (path === "/me") await gate.promise; };
  const oldPoll = poll();
  const oldRequest = requests.at(-1)!;
  pageEvent("pagehide");
  meStatus = 401;
  beforeFetch = undefined;
  pageEvent("pageshow");
  await setImmediate();
  expect(byId("login").classList.contains("hidden")).toBe(false);
  expect(byId<HTMLButtonElement>("login-btn").disabled).toBe(false);
  expect(byId("whoami").textContent).toBe("");
  expect(byId("app").classList.contains("hidden")).toBe(true);
  expect(polls.size).toBe(0);
  expect(oldRequest.init.signal?.aborted).toBe(true);
  gate.resolve();
  await oldPoll;
  expect(FakeNatsWS.instances).toHaveLength(1);
  meStatus = 200;
  byId<HTMLInputElement>("username").value = "alice";
  byId<HTMLInputElement>("password").value = "demo";
  byId<HTMLButtonElement>("login-btn").click();
  await settleUntil(() => FakeNatsWS.instances.length === 2, { label: "fresh login" });
  expect(composer().value).toBe("");
});

it.each(["different user", "revoked account"])("does not restore the cached draft for a %s", async change => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  tab("beta").click();
  await settleUntil(() => FakeNatsWS.instances.length === 2, { label: "selected beta" });
  composer().value = "belongs to alice on beta";
  pageEvent("pagehide");
  me = change === "different user"
    ? { ...me, username: "bob" }
    : { ...me, accounts: { alpha: accounts.alpha } };
  pageEvent("pageshow");
  await settleUntil(() => FakeNatsWS.instances.length === 3, { label: "revalidated session" });
  expect(byId("whoami").textContent).toBe(me.username);
  expect(byId("chat-lane").querySelector("strong")!.textContent).toBe("alpha");
  expect(composer().value).toBe("");
  expect(polls.size).toBe(1);
});

it("fences auth and poll completions from before suspension while restoring the draft", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  const authGate = deferred();
  const pollGate = deferred();
  let blocked = false;
  beforeFetch = async path => {
    if (path === "/nats-user") { blocked = true; await authGate.promise; }
    if (path === "/me") await pollGate.promise;
  };
  Array.from(byId("chat-lane").querySelectorAll("button")).find(b => b.textContent!.includes("short-lived"))!.click();
  await settleUntil(() => blocked, { label: "pending re-auth" });
  const staleAuth = requests.at(-1)!;
  composer().value = "keep while authenticating";
  const oldPoll = poll();
  const stalePoll = requests.at(-1)!;
  pageEvent("pagehide");
  beforeFetch = undefined;
  me = { ...me, accounts: { alpha: accounts.alpha } };
  pageEvent("pageshow");
  await settleUntil(() => FakeNatsWS.instances.length === 2, { label: "restored session" });
  authGate.resolve();
  pollGate.resolve();
  await oldPoll;
  await setImmediate();
  expect(staleAuth.init.signal?.aborted).toBe(true);
  expect(stalePoll.init.signal?.aborted).toBe(true);
  expect(FakeNatsWS.instances).toHaveLength(2);
  expect(byId("chat-tabs").textContent).toBe("alpha");
  expect(composer().value).toBe("keep while authenticating");
  expect(polls.size).toBe(1);
});

it("keeps the draft when another BFCache cycle interrupts the restoration lookup", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  composer().value = "draft across two suspensions";
  pageEvent("pagehide");
  const gate = deferred();
  beforeFetch = async path => { if (path === "/me") await gate.promise; };
  pageEvent("pageshow");
  const staleLookup = requests.at(-1)!;
  pageEvent("pagehide");
  beforeFetch = undefined;
  pageEvent("pageshow");
  await settleUntil(() => FakeNatsWS.instances.length === 2, { label: "latest restore" });
  gate.resolve();
  await setImmediate();
  expect(staleLookup.init.signal?.aborted).toBe(true);
  expect(FakeNatsWS.instances).toHaveLength(2);
  expect(composer().value).toBe("draft across two suspensions");
  expect(polls.size).toBe(1);
});

it("unblocks interrupted login controls and ignores its late callback after restoration", async () => {
  meStatus = 401;
  await boot();
  await setImmediate();
  const gate = deferred();
  beforeFetch = async path => { if (path === "/login") await gate.promise; };
  byId<HTMLInputElement>("username").value = "alice";
  byId<HTMLInputElement>("password").value = "demo";
  byId<HTMLButtonElement>("login-btn").click();
  const staleLogin = requests.at(-1)!;
  expect(byId<HTMLButtonElement>("login-btn").disabled).toBe(true);
  pageEvent("pagehide");
  beforeFetch = undefined;
  pageEvent("pageshow");
  await setImmediate();
  expect(byId<HTMLButtonElement>("login-btn").disabled).toBe(false);
  expect(staleLogin.init.signal?.aborted).toBe(true);
  gate.resolve();
  await setImmediate();
  expect(FakeNatsWS.instances).toHaveLength(0);
  expect(polls.size).toBe(0);
  expect(byId("app").classList.contains("hidden")).toBe(true);
});

it("keeps an interrupted logout blocked across restore and rejects its late success during a retry", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  const first = deferred();
  const retry = deferred();
  let attempts = 0;
  beforeFetch = async path => { if (path === "/logout") await (++attempts === 1 ? first.promise : retry.promise); };
  byId<HTMLButtonElement>("logout").click();
  const staleLogout = requests.at(-1)!;
  const meRequests = requests.filter(r => r.path === "/me").length;
  pageEvent("pagehide");
  pageEvent("pageshow");
  expect(byId("login-err").textContent).toContain("interrupted");
  expect(byId<HTMLButtonElement>("login-btn").disabled).toBe(true);
  expect(byId<HTMLButtonElement>("logout").disabled).toBe(false);
  expect(staleLogout.init.signal?.aborted).toBe(true);
  expect(requests.filter(r => r.path === "/me")).toHaveLength(meRequests);
  expect(polls.size).toBe(0);
  byId<HTMLInputElement>("password").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(requests.some(r => r.path === "/login")).toBe(false);
  byId<HTMLButtonElement>("logout").click();
  first.resolve();
  await setImmediate();
  expect(byId<HTMLButtonElement>("login-btn").disabled).toBe(true);
  expect(byId<HTMLButtonElement>("logout").disabled).toBe(true);
  retry.resolve();
  await settleUntil(() => !byId<HTMLButtonElement>("login-btn").disabled, { label: "confirmed logout retry" });
  expect(byId("logout").classList.contains("hidden")).toBe(true);
  expect(FakeNatsWS.instances).toHaveLength(1);
});

it("preserves failed-logout blocking through repeated page restores until an explicit retry succeeds", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  logoutStatus = 500;
  byId<HTMLButtonElement>("logout").click();
  await settleUntil(() => byId("login-err").textContent!.includes("Log out failed"), { label: "failed logout" });
  const meRequests = requests.filter(r => r.path === "/me").length;
  for (let cycle = 0; cycle < 2; cycle++) {
    pageEvent("pagehide");
    pageEvent("pageshow");
    expect(byId<HTMLButtonElement>("login-btn").disabled).toBe(true);
    expect(byId<HTMLButtonElement>("logout").disabled).toBe(false);
    expect(byId("app").classList.contains("hidden")).toBe(true);
  }
  expect(requests.filter(r => r.path === "/me")).toHaveLength(meRequests);
  expect(FakeNatsWS.instances).toHaveLength(1);
  logoutStatus = 401;
  byId<HTMLButtonElement>("logout").click();
  await settleUntil(() => !byId<HTMLButtonElement>("login-btn").disabled, { label: "logout retry" });
  expect(byId("login-err").textContent).toBe("");
});

it("restores the draft before slow authentication and preserves edits made while waiting", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  composer().value = "cached draft";
  pageEvent("pagehide");
  const gate = deferred();
  let blocked = false;
  beforeFetch = async path => { if (path === "/nats-user") { blocked = true; await gate.promise; } };
  pageEvent("pageshow");
  await settleUntil(() => blocked, { label: "restoration authentication" });
  expect(composer().value).toBe("cached draft");
  composer().value += " with new edits";
  gate.resolve();
  await settleUntil(() => FakeNatsWS.instances.length === 2, { label: "restored client" });
  expect(composer().value).toBe("cached draft with new edits");
  expect(polls.size).toBe(1);
});

it("offers usable sign-in after restoration lookup fails without showing cached session state", async () => {
  await boot();
  await settleUntil(() => FakeNatsWS.instances.length === 1, { label: "initial session" });
  pageEvent("pagehide");
  beforeFetch = async path => { if (path === "/me") throw new Error("offline"); };
  pageEvent("pageshow");
  await settleUntil(() => byId("login-err").textContent!.includes("Session lookup failed"), { label: "lookup failure" });
  expect(byId<HTMLButtonElement>("login-btn").disabled).toBe(false);
  expect(byId("whoami").textContent).toBe("");
  expect(byId("app").classList.contains("hidden")).toBe(true);
  expect(polls.size).toBe(0);
  expect(FakeNatsWS.instances).toHaveLength(1);
});

it("restores the admin observer once and fences its pre-suspension credential response", async () => {
  me = { ...me, username: "admin", isAdmin: true };
  const gate = deferred();
  let blocked = false;
  beforeFetch = async path => { if (path === "/admin/nats-user") { blocked = true; await gate.promise; } };
  await boot();
  await settleUntil(() => blocked, { label: "old observer auth" });
  const oldObserver = requests.at(-1)!;
  pageEvent("pagehide");
  beforeFetch = undefined;
  pageEvent("pageshow");
  pageEvent("pageshow");
  await settleUntil(() => FakeNatsWS.instances.length === 3, { label: "restored chat and observer" });
  gate.resolve();
  await setImmediate();
  expect(oldObserver.init.signal?.aborted).toBe(true);
  expect(FakeNatsWS.instances).toHaveLength(3);
  expect(FakeNatsWS.instances.filter(ws => ws.readyState === FakeNatsWS.OPEN)).toHaveLength(2);
  expect(requests.filter(r => r.path === "/admin/nats-user")).toHaveLength(2);
  expect(byId("whoami").textContent).toBe("admin (admin)");
  expect(polls.size).toBe(1);
});
