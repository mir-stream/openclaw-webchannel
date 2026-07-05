#!/usr/bin/env node
/**
 * Phase 5 aside #2 driver — one gateway, many accounts.
 *
 * With ./demo/multiplex.sh --auto-approve running, a SINGLE gateway serves
 * team-sales AND team-support (it subscribes BOTH accounts' register subjects).
 * Register admission is over NATS now, so the rendezvous carries no per-account
 * gateway URL to compare — the multiplex is proven END-TO-END instead:
 *  1. alice's rendezvous exposes team-sales and bob's exposes team-support (both
 *     grantable, each on the shared relay).
 *  2. Each user actually chats on their account (echo round-trip) through the one
 *     gateway multiplex.sh launched ⇒ one process, two accounts, live.
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
  // Structural sanity: each user's account is present + dialable (shared relay).
  const salesReady = Boolean(alice.accounts?.["team-sales"]?.natsUrl);
  const supportReady = Boolean(bob.accounts?.["team-support"]?.natsUrl);
  console.log(`[multiplex] alice team-sales → ${alice.accounts?.["team-sales"]?.natsUrl ?? "(missing)"}`);
  console.log(`[multiplex] bob   team-support → ${bob.accounts?.["team-support"]?.natsUrl ?? "(missing)"}`);
  if (!salesReady || !supportReady) {
    throw new Error("expected both accounts in the rendezvous (team-sales for alice, team-support for bob)");
  }

  // The real multiplex proof: both users chat end-to-end through the ONE gateway
  // multiplex.sh launched (subscribing both accounts' register subjects).
  await chatOn(browser, "alice", "team-sales", "sales hello");
  console.log("[multiplex] ✓ alice chatted on team-sales (echo)");
  await chatOn(browser, "bob", "team-support", "support hello");
  console.log("[multiplex] ✓ bob chatted on team-support (echo)");

  code = 0;
  console.log("[multiplex] result: both accounts served by the single gateway (both-chat=OK)");
} catch (err) {
  console.error("[multiplex] FAIL:", err?.message ?? err);
  code = 2;
} finally {
  await browser.close();
}
process.exit(code);
