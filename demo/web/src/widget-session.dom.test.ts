// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWidget } from "./widget.js";
import { openMessage, sealMessage } from "../../../packages/client/src/e2e-crypto-browser.js";
import { outboundSubject, type OutboundMessage } from "../../../packages/client/src/nats-client.js";
import {
  AGENT, TENANT, PEER, JWT, FakeNatsWS, installFakeWebSocket,
  makeAgentIdentity, registerAgent, settleUntil,
} from "../../../packages/client/src/nats-client-wrapped.test-harness.js";

const config = { tenant: TENANT, issuerUrl: "https://issuer.invalid", accounts: { [AGENT]: { natsUrl: "ws://fixture" } }, llmMode: "echo" as const };
const cleanup: Array<() => void> = [];
const requests: Array<{ path: string; init: RequestInit }> = [];
const sent: Array<Record<string, unknown>> = [];
const key = new Uint8Array(32).fill(61);
let beforeFetch: ((path: string, init: RequestInit) => Promise<void>) | undefined;
let root: HTMLDivElement;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function button(text: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll("button")).find(b => b.textContent!.includes(text))!;
}
function deliver(frame: Record<string, unknown>) {
  FakeNatsWS.instances.at(-1)!.deliverToClient(outboundSubject(TENANT, AGENT, PEER), sealMessage(
    { tenant: TENANT, accountId: AGENT, sub: PEER }, key, frame as unknown as OutboundMessage,
  ));
}
function submit(text: string) {
  const input = root.querySelector("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
}
async function ready(count: number) {
  await settleUntil(() => FakeNatsWS.instances.length === count, { label: "owned socket" });
  FakeNatsWS.instances.at(-1)!.onmessage?.({ data: 'INFO {"nonce":"widget-fixture"}\r\n' });
  await settleUntil(() => root.textContent!.includes("● connected"), { label: "widget registration" });
}
async function mount() {
  const teardown = await createWidget(root, config, AGENT);
  cleanup.push(teardown);
  await ready(1);
  return teardown;
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  cleanup.push(installFakeWebSocket());
  requests.length = 0;
  sent.length = 0;
  beforeFetch = undefined;
  const identity = makeAgentIdentity();
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    requests.push({ path, init });
    // Deliberately ignore AbortSignal: ownership checks must also fence a
    // response whose fetch/json continuation was already scheduled at abort.
    await beforeFetch?.(path, init);
    const data = path === "/nats-user"
      ? { userJwt: JWT, userSeedRaw: Buffer.alloc(32, 4).toString("base64url") }
      : { jwt: JWT, peerId: PEER, agentPublicKey: identity.publicB64url };
    if (path === "/bootstrap") {
      const body = JSON.parse(init.body as string);
      const register = registerAgent(key, new Uint8Array(Buffer.from(body.deviceX25519PublicKey, "base64url")), identity);
      FakeNatsWS.sharedHandler = async (subject, payload, server, reply) => {
        await register(subject, payload, server, reply);
        if (!subject.endsWith(".in")) return;
        const frame = openMessage(payload, key) as Record<string, unknown> | null;
        if (frame?.type === "user_message") sent.push(frame);
      };
    }
    return { ok: true, status: 200, json: async () => data };
  }));
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("preserves a draft submitted during slow re-auth until the new SDK owns it", async () => {
  await mount();
  const gate = deferred();
  beforeFetch = async path => { if (path === "/nats-user") await gate.promise; };
  button("short-lived").click();
  await settleUntil(() => requests.length === 3, { label: "pending re-auth" });
  const input = root.querySelector("input")!;
  input.value = "draft during authentication";
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(button("Send").disabled).toBe(true);
  expect(input.value).toBe("draft during authentication");
  expect(sent).toEqual([]);
  gate.resolve();
  await ready(2);
  expect(input.value).toBe("draft during authentication");
  button("Send").click();
  await settleUntil(() => sent.length === 1, { label: "intentional draft send" });
  expect(sent[0].text).toBe("draft during authentication");
  expect(input.value).toBe("");
});

it("retains the draft after auth failure and retries with the same short TTL", async () => {
  await mount();
  beforeFetch = async () => { throw new Error("auth offline"); };
  button("short-lived").click();
  await settleUntil(() => root.textContent!.includes("Re-authentication failed"), { label: "auth failure" });
  const input = root.querySelector("input")!;
  input.value = "unsent draft";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(input.value).toBe("unsent draft");
  beforeFetch = undefined;
  button("Re-authenticate").click();
  await ready(2);
  expect(input.value).toBe("unsent draft");
  expect(requests.filter(r => r.path === "/nats-user").slice(1).map(r => JSON.parse(r.init.body as string).ttlSeconds)).toEqual([12, 12]);
});

it.each(["/nats-user", "/bootstrap"])("teardown during %s prevents late connection and cannot clear a replacement mount", async path => {
  const teardown = await mount();
  const gate = deferred();
  let blocked = false;
  beforeFetch = async current => { if (current === path) { blocked = true; await gate.promise; } };
  button("short-lived").click();
  await settleUntil(() => blocked, { label: "pending authentication" });
  const request = requests.at(-1)!;
  teardown();
  root.textContent = "replacement lane";
  expect(request.init.signal?.aborted).toBe(true);
  gate.resolve();
  await setImmediate();
  teardown();
  expect(FakeNatsWS.instances).toHaveLength(1);
  expect(FakeNatsWS.instances[0].readyState).toBe(FakeNatsWS.CLOSED);
  expect(root.textContent).toBe("replacement lane");
});

it("only the latest re-auth may publish a client or an error", async () => {
  await mount();
  const old = deferred();
  let blocked = false;
  beforeFetch = async path => {
    if (path === "/nats-user" && !blocked) { blocked = true; await old.promise; }
  };
  button("short-lived").click();
  await settleUntil(() => blocked, { label: "first re-auth" });
  const staleRequest = requests.at(-1)!;
  button("short-lived").click();
  await ready(2);
  expect(staleRequest.init.signal?.aborted).toBe(true);
  old.reject(new Error("stale auth failure"));
  await setImmediate();
  expect(FakeNatsWS.instances).toHaveLength(2);
  expect(root.textContent).toContain("● connected");
  expect(root.textContent).not.toContain("stale auth failure");
});

it("aborts an initial mount before its teardown promise resolves", async () => {
  const owner = new AbortController();
  const gate = deferred();
  let blocked = false;
  beforeFetch = async path => { if (path === "/bootstrap") { blocked = true; await gate.promise; } };
  const mounting = createWidget(root, config, AGENT, owner.signal);
  await settleUntil(() => blocked, { label: "initial bootstrap" });
  owner.abort();
  root.textContent = "new account";
  gate.resolve();
  const teardown = await mounting;
  teardown();
  expect(FakeNatsWS.instances).toHaveLength(0);
  expect(root.textContent).toBe("new account");
});

it("shows queued, sent, accepted and completed receipts without claiming acceptance on socket write", async () => {
  cleanup.push(await createWidget(root, config, AGENT));
  submit("receipt lifecycle");
  expect(root.querySelector('[data-send-state="queued"]')?.textContent).toContain("Queued · waiting to send");
  expect(sent).toEqual([]);
  await ready(1);
  await settleUntil(() => sent.length === 1, { label: "encrypted send" });
  expect(root.querySelector('[data-send-state="sent"]')?.textContent).toBe("Sent · awaiting acceptance");
  expect(root.textContent).not.toContain("Accepted by agent");
  deliver({ type: "ack", ids: [sent[0].id] });
  expect(root.querySelector('[data-send-state="accepted"]')?.textContent).toBe("Accepted by agent");
  expect(root.textContent).not.toContain("Completed");
  deliver({ type: "turn_settled", turnId: sent[0].id, outcome: "ok" });
  expect(root.querySelector('[data-send-state="completed"]')?.textContent).toBe("Completed");
});

it("shows an encrypted overload rejection and restores text without sending or overwriting a draft", async () => {
  await mount();
  submit("rejected message");
  await settleUntil(() => sent.length === 1, { label: "send before rejection" });
  deliver({ type: "inbound_rejected", ids: [sent[0].id], reason: "overloaded" });
  const status = root.querySelector('[data-send-state="failed"]')!;
  expect(status.textContent).toContain("Send failed · agent overloaded");
  expect(status.textContent).toContain("did not accept");
  expect(root.textContent).toContain("● connected");
  const input = root.querySelector("input")!;
  input.value = "existing draft";
  button("Restore draft").click();
  expect(input.value).toBe("existing draft rejected message");
  await setImmediate();
  expect(sent).toHaveLength(1);
  expect(root.querySelector('[data-send-state="failed"]')).not.toBeNull();
});

it("warns about possible effects after execution failure and never retries it automatically", async () => {
  await mount();
  submit("perform an operation");
  await settleUntil(() => sent.length === 1, { label: "operation send" });
  deliver({ type: "ack", ids: [sent[0].id] });
  deliver({ type: "turn_settled", turnId: sent[0].id, outcome: "error" });
  const status = root.querySelector('[data-send-state="failed"]')!;
  expect(status.textContent).toContain("Request failed after acceptance");
  expect(status.textContent).toContain("may have had effects");
  button("Restore draft").click();
  await setImmediate();
  expect(sent).toHaveLength(1);
  expect(root.querySelector("input")!.value).toBe("perform an operation");
});

it("shows terminal auth failures with re-authentication rather than a send retry", async () => {
  await mount();
  submit("awaiting acceptance");
  await settleUntil(() => sent.length === 1, { label: "pending send" });
  FakeNatsWS.instances[0].onmessage?.({ data: "-ERR 'Authentication Expired'\r\n" });
  await settleUntil(() => !!root.querySelector('[data-send-state="failed"]'), { label: "terminal receipt" });
  expect(root.querySelector('[data-send-state="failed"]')!.textContent).toContain("Credentials expired");
  expect(button("Re-authenticate")).toBeDefined();
  expect(button("Restore draft")).toBeUndefined();
  expect(sent).toHaveLength(1);
});
