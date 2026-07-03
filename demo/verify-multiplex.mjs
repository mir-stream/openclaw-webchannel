#!/usr/bin/env node
/**
 * Phase 5 aside #2 driver — one gateway, many accounts.
 *
 * With ./demo/multiplex.sh --auto-approve running, a SINGLE gateway (:19599)
 * serves team-sales AND team-support. This asserts:
 *  1. alice's rendezvous for team-sales and bob's for team-support point at the
 *     SAME registerBaseUrl (:19599) ⇒ one gateway process, two accounts.
 *  2. Each user actually chats on their account (echo round-trip), so the
 *     multiplex is live end-to-end, not just configured.
 *
 * Not part of CI — a local smoke for the demo during development.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = require(`${ROOT}/node_modules/openclaw/node_modules/playwright-core`);

const URL = process.env.DEMO_URL ?? "http://127.0.0.1:3961";
const GW_PORT = process.env.MULTIPLEX_PORT ?? "19599";

async function meFor(username) {
  const login = await fetch(`${URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "demo" }),
  });
  const cookie = `sid=${(login.headers.get("set-cookie") ?? "").match(/sid=([^;]+)/)?.[1]}`;
  const me = await (await fetch(`${URL}/me`, { headers: { cookie } })).json();
  return me;
}

async function chatOn(browser, username, account, text) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error(`  [${username} page-error]`, e?.message ?? e));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.fill("#username", username);
  await page.fill("#password", "demo");
  await page.click("#login-btn");
  await page.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  // Select the account's tab (tab text === accountId), then chat.
  await page.waitForFunction(
    (a) => [...document.querySelectorAll("#chat-tabs button")].some((b) => b.textContent === a),
    account,
    { timeout: 10000 },
  );
  await page.click(`#chat-tabs button:text-is("${account}")`);
  await page.fill("#chat-body input", text);
  await page.click("#chat-body button.primary");
  await page.waitForFunction(
    (t) => {
      const el = document.querySelector("#chat-body");
      return !!el && el.textContent.includes("echo:") && el.textContent.includes(t);
    },
    text,
    { timeout: 30000 },
  );
  await page.close();
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
let code = 1;
try {
  const alice = await meFor("alice");
  const bob = await meFor("bob");
  const salesUrl = alice.accounts?.["team-sales"]?.registerBaseUrl ?? "";
  const supportUrl = bob.accounts?.["team-support"]?.registerBaseUrl ?? "";
  const sameGateway = salesUrl.includes(`:${GW_PORT}`) && supportUrl.includes(`:${GW_PORT}`);
  console.log(`[multiplex] alice team-sales → ${salesUrl}`);
  console.log(`[multiplex] bob   team-support → ${supportUrl}`);
  console.log(`[multiplex] same gateway (:${GW_PORT}) = ${sameGateway}`);

  await chatOn(browser, "alice", "team-sales", "sales hello");
  console.log("[multiplex] ✓ alice chatted on team-sales (echo)");
  await chatOn(browser, "bob", "team-support", "support hello");
  console.log("[multiplex] ✓ bob chatted on team-support (echo)");

  code = sameGateway ? 0 : 3;
  console.log(`[multiplex] result: one-gateway-two-accounts=${sameGateway ? "OK" : "FAIL"} both-chat=OK`);
} catch (err) {
  console.error("[multiplex] FAIL:", err?.message ?? err);
  code = 2;
} finally {
  await browser.close();
}
process.exit(code);
