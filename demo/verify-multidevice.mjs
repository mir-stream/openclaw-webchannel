#!/usr/bin/env node
/**
 * Phase 6 acceptance driver (PHASE6_MULTIDEVICE_PLAN §12 A) — the multi-device
 * scene, against the running showcase demo (demo/run.sh):
 *
 * ONE Playwright run, TWO browser contexts logged in as the SAME user (alice →
 * same peerId), plus a third context as a DIFFERENT user (bob) for the
 * negative control. Sequential assertions:
 *   1. device A chats; device B joins SECOND → A still decrypts new inbound
 *      (the original kill scenario: pre-Phase-6, B's key overwrote A's);
 *   2. the agent's reply decrypts on BOTH devices (identical-ciphertext fanout
 *      over the shared .out with the shared conversation key K);
 *   3. NO duplicate message bubbles on either device after B's
 *      register-triggered snapshot (W6 idempotent hydration / audit F7);
 *   4. device B reloads mid-session → recovers full history + live decrypt
 *      with zero manual steps (stateless register self-heal).
 * Negative controls:
 *   5. the wiretap pane (tenant-creds observer) shows ONLY ciphertext frames;
 *   6. a different user's device (bob) never sees alice's messages
 *      (K is per-peerId; subjects are per-peerId).
 *
 * Not part of CI — a local acceptance driver run against `demo/run.sh`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = require(`${ROOT}/node_modules/openclaw/node_modules/playwright-core`);

const URL = process.env.DEMO_URL ?? "http://127.0.0.1:3961";
const RUN = Date.now().toString(36);
const M1 = `md-${RUN}-first-from-A`;
const M2 = `md-${RUN}-after-B-joined`;
const M3 = `md-${RUN}-after-B-reload`;
const BOB_MSG = `md-${RUN}-bob-own-lane`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`[md] ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(ctx, username) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`  [${username}-page-error]`, e?.message ?? e));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.fill("#username", username);
  await page.fill("#password", "demo");
  await page.click("#login-btn");
  await page.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  // Let the lane finish register + subscribe before driving it.
  await page.waitForTimeout(2000);
  return page;
}

async function send(page, text) {
  await page.fill("#chat-body input", text);
  await page.click("#chat-body button.primary");
}

/** Await an "echo:" agent bubble containing `text` in this page's chat pane. */
async function awaitEcho(page, text, timeout = 30000) {
  await page.waitForFunction(
    (t) => {
      const el = document.querySelector("#chat-body");
      return !!el && el.textContent.includes("echo:") && el.textContent.includes(t);
    },
    text,
    { timeout },
  );
}

/**
 * Count bubbles whose text EXACTLY equals `text` — i.e. the user-role bubble
 * (the echo bubble contains extra metadata so it never exact-matches). A
 * duplicate-hydration bug shows up as a count > 1.
 */
function exactBubbleCount(page, text) {
  return page.evaluate((t) => {
    let n = 0;
    for (const d of document.querySelectorAll("#chat-body div")) {
      if (d.childElementCount === 0 && d.textContent === t) n++;
    }
    return n;
  }, text);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
let code = 1;
try {
  // ── Device A (alice) chats first ─────────────────────────────────────────
  const ctxA = await browser.newContext();
  const pageA = await login(ctxA, "alice");
  await send(pageA, M1);
  await awaitEcho(pageA, M1);
  console.log("[md] device A: first message echoed");

  // ── Device B (alice again — SAME peerId) joins SECOND ────────────────────
  const ctxB = await browser.newContext();
  const pageB = await login(ctxB, "alice");
  // B's register-triggered snapshot hydrates the conversation so far.
  await pageB.waitForFunction(
    (t) => document.querySelector("#chat-body")?.textContent?.includes(t),
    M1,
    { timeout: 15000 },
  );
  console.log("[md] device B: joined + hydrated M1 via register snapshot");

  // 1. THE kill scenario: A must still decrypt new inbound after B joined.
  await send(pageA, M2);
  let aAlive = true;
  try {
    await awaitEcho(pageA, M2);
  } catch {
    aAlive = false;
  }
  check("1. device A survives device B's join (original kill scenario)", aAlive);

  // 2. The SAME agent reply decrypts on device B too (shared-K fanout).
  let bFanout = true;
  try {
    await awaitEcho(pageB, M2, 15000);
  } catch {
    bFanout = false;
  }
  check("2. agent outbound decrypts on BOTH devices (identical-ciphertext fanout)", bFanout);

  // 3. No duplicate bubbles after B's register-triggered snapshot (which A,
  //    sharing .out and K, also decrypted). Exact-match user-bubble counts.
  //    NOTE: B has no M2 USER bubble yet — user-typed messages travel device→
  //    agent on .in, so the other device only gets them via a snapshot (B's
  //    reload below re-checks M2 there). Phase 6 asserts agent OUTBOUND on
  //    both devices; live user-message mirroring is out of scope.
  const dupChecks = [
    ["A", pageA, M1, 1], ["A", pageA, M2, 1],
    ["B", pageB, M1, 1], ["B", pageB, M2, 0],
  ];
  let noDupes = true;
  for (const [dev, page, text, want] of dupChecks) {
    const n = await exactBubbleCount(page, text);
    if (n !== want) {
      noDupes = false;
      console.error(`  [md] device ${dev}: expected ${want} bubble(s) for ${JSON.stringify(text)}, found ${n}`);
    }
  }
  check("3. no duplicate message bubbles on either device (W6 idempotent hydration)", noDupes);

  // 4. Device B reloads mid-session → full history + live decrypt, no manual steps.
  await pageB.reload({ waitUntil: "domcontentloaded" });
  await pageB.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  let bRecovered = true;
  try {
    await pageB.waitForFunction(
      ([a, b]) => {
        const t = document.querySelector("#chat-body")?.textContent ?? "";
        return t.includes(a) && t.includes(b);
      },
      [M1, M2],
      { timeout: 15000 },
    );
  } catch {
    bRecovered = false;
  }
  // Post-reload, B's snapshot now hydrates M2's user bubble too — exactly once
  // (the W6 dedup check deferred from assertion 3).
  const m2OnB = await exactBubbleCount(pageB, M2);
  if (m2OnB !== 1) {
    bRecovered = false;
    console.error(`  [md] device B post-reload: expected 1 bubble for M2, found ${m2OnB}`);
  }
  // ...and B decrypts LIVE traffic sent after its reload.
  await pageB.waitForTimeout(1500);
  await send(pageA, M3);
  let bLive = true;
  try {
    await awaitEcho(pageB, M3, 20000);
  } catch {
    bLive = false;
  }
  check("4. device B reload self-heals (history restored + live decrypt)", bRecovered && bLive,
    `history=${bRecovered ? "ok" : "FAIL"} live=${bLive ? "ok" : "FAIL"}`);

  // 5. Wiretap negative control: ciphertext-only frames, and none of our
  //    plaintexts anywhere in the wiretap pane.
  let sawHex = false;
  try {
    await pageA.waitForFunction(
      () => /[0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}/.test(document.querySelector("#wiretap-body")?.textContent ?? ""),
      undefined,
      { timeout: 12000, polling: 500 },
    );
    sawHex = true;
  } catch { /* leave false */ }
  const wiretapLeak = await pageA.evaluate(
    (texts) => {
      const t = document.querySelector("#wiretap-body")?.textContent ?? "";
      return texts.some((x) => t.includes(x));
    },
    [M1, M2, M3],
  );
  check("5. wiretap observer sees ONLY ciphertext", sawHex && !wiretapLeak,
    `hexFrames=${sawHex} plaintextLeak=${wiretapLeak}`);

  // 6. Cross-user negative control: bob's live device never shows alice's texts.
  const ctxC = await browser.newContext();
  const pageC = await login(ctxC, "bob");
  await send(pageC, BOB_MSG);
  await awaitEcho(pageC, BOB_MSG); // bob's own lane works…
  const bobLeak = await pageC.evaluate(
    (texts) => {
      const t = document.querySelector("#chat-body")?.textContent ?? "";
      return texts.some((x) => t.includes(x));
    },
    [M1, M2, M3],
  );
  check("6. a different user's device cannot decrypt (per-peerId K)", !bobLeak);

  await pageA.screenshot({ path: "/tmp/demo-multidevice-A.png", fullPage: true });
  await pageB.screenshot({ path: "/tmp/demo-multidevice-B.png", fullPage: true });
  console.log("[md] screenshots → /tmp/demo-multidevice-{A,B}.png");

  const failed = results.filter((r) => !r.ok);
  code = failed.length === 0 ? 0 : 3;
  console.log(`[md] result: ${results.length - failed.length}/${results.length} assertions passed`);
} catch (err) {
  console.error("[md] FAIL:", err?.message ?? err);
  code = 2;
} finally {
  await browser.close();
}
process.exit(code);
