#!/usr/bin/env node
/**
 * Phase 5 aside #1 driver — JWKS signing-key rotation, zero downtime.
 *
 * 1. alice connects a lane (bootstrap JWT under the ORIGINAL kid) and chats.
 * 2. admin rotates the RS256 signing key in GRACE mode (new kid prepended, old
 *    kid kept in the JWKS).
 * 3. alice reloads → a fresh bootstrap JWT is minted under the NEW kid. The
 *    gateway's JWKS cache (which only knows the old kid) misses the new kid,
 *    refetches ONCE, finds it, and verifies. The lane chats again → the rotation
 *    caused no downtime.
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

// --- admin REST helpers (a manual cookie jar; the page context is alice) -----
async function adminSession() {
  const r = await fetch(`${URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "demo" }),
  });
  if (!r.ok) throw new Error(`admin login failed HTTP ${r.status}`);
  const sid = (r.headers.get("set-cookie") ?? "").match(/sid=([^;]+)/)?.[1];
  if (!sid) throw new Error("admin login returned no sid cookie");
  return `sid=${sid}`;
}
const adminGet = async (cookie, p) =>
  (await fetch(`${URL}${p}`, { headers: { cookie } })).json();
const adminPost = async (cookie, p, body) =>
  (await fetch(`${URL}${p}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })).json();

const sendAndAwaitEcho = async (page, text) => {
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
};

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
let code = 1;
try {
  const cookie = await adminSession();
  const before = await adminGet(cookie, "/admin/signing-key");
  console.log(`[rotate] before: activeKid=${before.activeKid} jwks=[${before.jwksKids}]`);

  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("  [page-error]", e?.message ?? e));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.fill("#username", "alice");
  await page.fill("#password", "demo");
  await page.click("#login-btn");
  await page.waitForSelector("#app:not(.hidden)", { timeout: 15000 });

  await sendAndAwaitEcho(page, "before rotation");
  console.log("[rotate] ✓ lane works on original kid");

  // Rotate (grace: keep old kid so any in-flight token still verifies).
  const rot = await adminPost(cookie, "/admin/rotate-key", { evictPrevious: false });
  const after = await adminGet(cookie, "/admin/signing-key");
  const rotated = rot.ok && after.activeKid !== before.activeKid && after.jwksKids.includes(before.activeKid);
  console.log(`[rotate] rotate ok=${rot.ok} activeKid=${after.activeKid} jwks=[${after.jwksKids}] (grace-keeps-old=${after.jwksKids.includes(before.activeKid)})`);

  // Reload → fresh bootstrap JWT under the NEW kid. Gateway refetches JWKS once.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  let afterRotateOk = false;
  try {
    await sendAndAwaitEcho(page, "after rotation");
    afterRotateOk = true;
    console.log("[rotate] ✓ lane works on NEW kid after reload (zero downtime)");
  } catch {
    console.error("[rotate] ✗ lane FAILED after rotation");
  }

  code = rotated && afterRotateOk ? 0 : 3;
  console.log(`[rotate] result: rotated=${rotated ? "OK" : "FAIL"} zero-downtime=${afterRotateOk ? "OK" : "FAIL"}`);
} catch (err) {
  console.error("[rotate] FAIL:", err?.message ?? err);
  code = 2;
} finally {
  await browser.close();
}
process.exit(code);
