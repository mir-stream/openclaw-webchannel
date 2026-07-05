#!/usr/bin/env node
/**
 * Phase 2 fleet driver (scene ①) — alice starts with one granted account
 * (agent-dev → one tab). An admin session grants her agent-ops; the widget's
 * background /me poll grows a second tab live. Then alice chats on agent-ops to
 * prove the new lane really connects. Local smoke, not CI.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = require(`${ROOT}/node_modules/openclaw/node_modules/playwright-core`);

const URL = process.env.DEMO_URL ?? "http://127.0.0.1:3961";

// Admin grants alice both accounts via the admin API (cookie jar in-process).
async function adminGrant(accounts) {
  const login = await fetch(`${URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "demo" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const res = await fetch(`${URL}/admin/users/alice/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ accounts }),
  });
  return res.ok;
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
let code = 1;
try {
  // Reset alice to a single grant so the "grows a tab" transition is observable.
  await adminGrant(["agent-dev"]);

  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("  [page-error]", e?.message ?? e));

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.fill("#username", "alice");
  await page.fill("#password", "demo");
  await page.click("#login-btn");
  await page.waitForSelector("#app:not(.hidden)", { timeout: 15000 });

  // One tab initially (agent-dev).
  await page.waitForFunction(
    () => document.querySelectorAll("#chat-tabs button").length === 1,
    { timeout: 10000 },
  );
  const firstTabs = await page.$$eval("#chat-tabs button", (b) => b.map((x) => x.textContent));
  console.log(`[fleet] initial tabs: ${JSON.stringify(firstTabs)}`);

  // Admin grants agent-ops → widget's /me poll should grow a 2nd tab (<=3s poll).
  console.log("[fleet] admin granting agent-ops to alice…");
  await adminGrant(["agent-dev", "agent-ops"]);
  await page.waitForFunction(
    () => document.querySelectorAll("#chat-tabs button").length === 2,
    { timeout: 12000 },
  );
  const grownTabs = await page.$$eval("#chat-tabs button", (b) => b.map((x) => x.textContent));
  console.log(`[fleet] ✓ tab grew live: ${JSON.stringify(grownTabs)}`);

  // Switch to agent-ops, send a message, await its echo (new lane connects).
  const opsTab = await page.$(`#chat-tabs button:has-text("agent-ops")`);
  await opsTab.click();
  await page.waitForSelector("#chat-lane input", { timeout: 10000 });
  await page.fill("#chat-lane input", "hello agent-ops");
  await page.click("#chat-lane button.primary");
  await page.waitForFunction(
    () => {
      const el = document.querySelector("#chat-lane");
      return !!el && el.textContent.includes("echo:") && el.textContent.includes("hello agent-ops");
    },
    { timeout: 30000 },
  );
  console.log("[fleet] ✓ agent-ops lane connected + echoed");

  await page.screenshot({ path: "/tmp/demo-fleet.png", fullPage: true });
  console.log("[fleet] screenshot → /tmp/demo-fleet.png");

  // Revoke agent-ops → tab should shrink back to 1.
  console.log("[fleet] admin revoking agent-ops…");
  await adminGrant(["agent-dev"]);
  await page.waitForFunction(
    () => document.querySelectorAll("#chat-tabs button").length === 1,
    { timeout: 12000 },
  );
  console.log("[fleet] ✓ tab shrank live after revoke");

  code = 0;
} catch (err) {
  console.error("[fleet] FAIL:", err?.message ?? err);
  code = 2;
} finally {
  await browser.close();
}
process.exit(code);
