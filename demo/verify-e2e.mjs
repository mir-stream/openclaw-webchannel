#!/usr/bin/env node
/**
 * Phase 1 exit-criteria driver — opens the REAL demo page in headless Chromium,
 * logs in as alice, sends a message, and asserts the echo reply arrives; then
 * reloads to check history hydration and reads the wiretap pane for ciphertext.
 * Not part of CI — a local smoke for the demo during development.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = require(`${ROOT}/node_modules/openclaw/node_modules/playwright-core`);

const URL = process.env.DEMO_URL ?? "http://127.0.0.1:3961";
const TEXT = "hello from the phase-1 verify driver";

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
let code = 1;
try {
  const page = await browser.newPage();
  page.on("console", (m) => console.log("  [page]", m.text()));
  page.on("pageerror", (e) => console.error("  [page-error]", e?.message ?? e));

  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // Login as alice.
  await page.fill("#username", "alice");
  await page.fill("#password", "demo");
  await page.click("#login-btn");
  await page.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  console.log("[verify] logged in, app visible");

  // Send a message, await the echo reply bubble.
  await page.fill("#chat-body input", TEXT);
  await page.click("#chat-body button.primary");
  console.log("[verify] sent message, awaiting reply…");
  // Agent reply arrives as an "echo:" bubble (openclaw prepends conversation
  // metadata, so we match the "echo:" marker + our text anywhere in the pane).
  await page.waitForFunction(
    (t) => {
      const el = document.querySelector("#chat-body");
      return !!el && el.textContent.includes("echo:") && el.textContent.includes(t);
    },
    TEXT,
    { timeout: 30000 },
  );
  console.log("[verify] ✓ echo reply received");

  // Wiretap should show at least one ciphertext frame (hex).
  const wiretapText = await page.textContent("#wiretap-body");
  const sawHex = /[0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}/.test(wiretapText ?? "");
  console.log(sawHex ? "[verify] ✓ wiretap shows ciphertext frames" : "[verify] ✗ wiretap had no hex frames");

  await page.screenshot({ path: "/tmp/demo-phase1.png", fullPage: true });
  console.log("[verify] screenshot (chat+wiretap) → /tmp/demo-phase1.png");

  // Reload → history hydration restores the prior turn. This is sent from the
  // E2E handshake-complete handler (not the pre-handshake register hop) and reads
  // the core session store in a detached async-context so `sessions.get` authorizes
  // against a synthetic operator client. Hard criterion: it MUST restore.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  let historyOk = false;
  try {
    await page.waitForFunction(
      (t) => document.querySelector("#chat-body")?.textContent?.includes(t),
      TEXT,
      { timeout: 10000 },
    );
    historyOk = true;
    console.log("[verify] ✓ history restored after reload");
  } catch {
    console.error("[verify] ✗ history NOT restored after reload");
  }

  code = sawHex && historyOk ? 0 : 3;
  console.log(`[verify] result: reply=OK wiretap=${sawHex ? "OK" : "FAIL"} history=${historyOk ? "OK" : "FAIL"}`);
} catch (err) {
  console.error("[verify] FAIL:", err?.message ?? err);
  code = 2;
} finally {
  await browser.close();
}
process.exit(code);
