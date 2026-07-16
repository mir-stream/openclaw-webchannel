#!/usr/bin/env node
/**
 * #21 ALL-REAL driver — a REAL headless-Chromium browser running the PRODUCTION
 * WebChannelNatsClient (a) NATS-layer NKEY-authenticates to a REAL JWT-auth
 * nats-server AND (b) drives the JWT + Proof-of-Possession HTTP register hop,
 * against a REAL enrolled plugin (real device-flow creds, no unauthenticated NATS mode) — all from ONE shared trust chain
 * — completing an encrypted echo round-trip. The only stand-in is the echo LLM.
 *
 * Fuses the #18 server topology (run-enrolled-transport.sh) with the #19 browser
 * driver mechanics (browser-jwt-register.mjs): esbuild→IIFE bundle of
 * packages/client/src/browser-jwt-entry.ts, served from a real http origin,
 * driven in headless Chromium via globalThis.WebJwtRegister.runAllReal.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url)); // e2e/local
const ROOT = join(__dirname, "..", "..");
const require = createRequire(import.meta.url);

const NATS_URL   = process.env.WEBCHANNEL_NATS_URL   ?? "ws://127.0.0.1:18622";
const ISSUER_URL = process.env.WEBCHANNEL_ISSUER_URL ?? "http://127.0.0.1:3941";
const GW_URL     = process.env.WEBCHANNEL_GW_URL     ?? "http://127.0.0.1:19199";
const ACCOUNT_ID   = process.env.WEBCHANNEL_ACCOUNT_ID   ?? "default-agent";
const TENANT     = process.env.WEBCHANNEL_TENANT     ?? "default-tenant";
const PEER_ID    = process.env.WEBCHANNEL_PEER_ID    ?? "web-allreal-peer";
const PAGE_PORT  = parseInt(process.env.WEBCHANNEL_PAGE_PORT ?? "19393", 10);
const TEXT       = process.env.WEBCHANNEL_TEXT       ?? "hello from an all-real browser (NKEY + PoP)";
const TIMEOUT_MS = parseInt(process.env.WEBCHANNEL_TIMEOUT_MS ?? "25000", 10);

// Hard wall so a stuck browser can never hang CI.
const HARD_DEADLINE_MS = TIMEOUT_MS + 30000;
const hardTimer = setTimeout(() => {
  console.error(`[all-real] HARD TIMEOUT (${HARD_DEADLINE_MS}ms) — aborting`);
  process.exit(7);
}, HARD_DEADLINE_MS);
hardTimer.unref?.();

// ---------------------------------------------------------------------------
// 1. Build the browser bundle (esbuild → IIFE; footer pins globalThis global).
// ---------------------------------------------------------------------------
function buildBundle() {
  const esbuildBin = join(ROOT, "node_modules/tsx/node_modules/esbuild/bin/esbuild");
  const entryPoint = join(ROOT, "packages/client/src/browser-jwt-entry.ts");
  const outFile = join(tmpdir(), `all-real-bundle-${process.pid}.js`);
  execFileSync(esbuildBin, [
    entryPoint,
    "--bundle",
    "--platform=browser",
    "--format=iife",
    "--global-name=WebJwtRegister",
    "--footer:js=;globalThis.WebJwtRegister=WebJwtRegister;",
    `--outfile=${outFile}`,
    "--log-level=warning",
  ]);
  return readFileSync(outFile, "utf8");
}

let bundle;
try {
  bundle = buildBundle();
  console.log("[all-real] esbuild bundle built");
} catch (err) {
  console.error("[all-real] BUNDLE FAILED:", err?.message ?? err);
  process.exit(6);
}

// ---------------------------------------------------------------------------
// 2. Serve the page from a real http origin (NOT about:blank — null origin
//    blocks WebSocket/fetch sub-resources). The bundle is injected via
//    page.addInitScript(bundle) below (the #19 driver pattern), so the served
//    page is a minimal shell with no inline bundle.
// ---------------------------------------------------------------------------
const html = `<!doctype html><html><head><meta charset="utf-8"><title>wc-all-real</title></head><body><h1>webchannel all-real</h1></body></html>`;
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(html);
});
await new Promise((r) => server.listen(PAGE_PORT, "127.0.0.1", r));
console.log(`[all-real] page served at http://127.0.0.1:${PAGE_PORT}/`);

// ---------------------------------------------------------------------------
// 3. Launch headless Chromium and drive the in-page ALL-REAL flow.
// ---------------------------------------------------------------------------
const { chromium } = require(`${ROOT}/node_modules/openclaw/node_modules/playwright-core`);

let browser;
let exitCode = 1;
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--single-process",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const page = await browser.newPage();
  page.on("console", (m) => console.log("  [page]", m.text()));
  page.on("pageerror", (e) => console.error("  [page-error]", e?.message ?? e));

  await page.addInitScript(bundle);
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);

  console.log("[all-real] running production WebChannelNatsClient (NKEY-auth + PoP register) in headless Chromium…");
  const result = await page.evaluate(
    (o) => globalThis.WebJwtRegister.runAllReal(o),
    {
      natsUrl: NATS_URL,
      issuerUrl: ISSUER_URL,
      gwUrl: GW_URL,
      accountId: ACCOUNT_ID,
      tenant: TENANT,
      peerId: PEER_ID,
      text: TEXT,
      timeoutMs: TIMEOUT_MS,
    },
  );

  const replyText = result?.replyText ?? "";
  console.log("[all-real] [REPLY]", JSON.stringify(replyText).slice(0, 300));

  if (replyText.includes(TEXT)) {
    console.log("[PROOF] ALL-REAL: real browser (NKEY-auth + PoP register) ↔ JWT-auth nats ↔ real enrolled plugin → encrypted round-trip OK");
    exitCode = 0;
  } else {
    console.error(`[FAIL] reply did not contain the sent text. sent=${JSON.stringify(TEXT)} reply=${JSON.stringify(replyText)}`);
    exitCode = 1;
  }
} catch (err) {
  console.error("[FAIL] browser driver error:", err?.message ?? err);
  exitCode = 2;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  await new Promise((r) => server.close(r));
  clearTimeout(hardTimer);
}

process.exit(exitCode);
