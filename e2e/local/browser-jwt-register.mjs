#!/usr/bin/env node
/**
 * #19 driver — real headless-Chromium browser drives the PRODUCTION
 * WebChannelNatsClient through the JWT + Proof-of-Possession HTTP register hop.
 *
 * This is the in-browser counterpart of e2e/local/saas-issuer-roundtrip.ts (the
 * Node driver). It:
 *   1. esbuild-bundles packages/client/src/browser-jwt-entry.ts → IIFE
 *      (global WebJwtRegister) for the browser,
 *   2. serves a real http://127.0.0.1:<PAGE_PORT> page (NOT about:blank — a null
 *      origin blocks WebSocket/fetch sub-resources),
 *   3. injects the bundle, then runs globalThis.WebJwtRegister.runJwtRegister IN
 *      the page — keygen (X25519 + Ed25519) → issuer /bootstrap → PoP register
 *      against the gateway → encrypted round-trip → returns the reply text,
 *   4. asserts the reply contains the sent text (echo model) and exits 0/1.
 *
 * Config comes from env (the harness sets these). Page console + page errors are
 * forwarded to Node so a CORS / WS / fetch failure is debuggable.
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

const NATS_URL  = process.env.WEBCHANNEL_NATS_URL   ?? "ws://127.0.0.1:18522";
const ISSUER_URL = process.env.WEBCHANNEL_ISSUER_URL ?? "http://127.0.0.1:3931";
const GW_URL    = process.env.WEBCHANNEL_GW_URL     ?? "http://127.0.0.1:19099";
const AGENT_ID  = process.env.WEBCHANNEL_AGENT_ID   ?? "default-agent";
const TENANT    = process.env.WEBCHANNEL_TENANT     ?? "default-tenant";
const PEER_ID   = process.env.WEBCHANNEL_PEER_ID    ?? "web-browser-peer";
const PAGE_PORT = parseInt(process.env.WEBCHANNEL_PAGE_PORT ?? "19293", 10);
const TEXT      = process.env.WEBCHANNEL_TEXT       ?? "hello from a real browser via JWT+PoP";
const TIMEOUT_MS = parseInt(process.env.WEBCHANNEL_TIMEOUT_MS ?? "25000", 10);

// Hard wall so a stuck browser can never hang CI.
const HARD_DEADLINE_MS = TIMEOUT_MS + 30000;
const hardTimer = setTimeout(() => {
  console.error(`[browser-jwt] HARD TIMEOUT (${HARD_DEADLINE_MS}ms) — aborting`);
  process.exit(7);
}, HARD_DEADLINE_MS);
hardTimer.unref?.();

// ---------------------------------------------------------------------------
// 1. Build the browser bundle (esbuild → IIFE; footer pins globalThis global).
// ---------------------------------------------------------------------------
function buildBundle() {
  const esbuildBin = join(ROOT, "node_modules/tsx/node_modules/esbuild/bin/esbuild");
  const entryPoint = join(ROOT, "packages/client/src/browser-jwt-entry.ts");
  const outFile = join(tmpdir(), `browser-jwt-bundle-${process.pid}.js`);
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
  console.log("[browser-jwt] esbuild bundle built");
} catch (err) {
  console.error("[browser-jwt] BUNDLE FAILED:", err?.message ?? err);
  process.exit(6);
}

// ---------------------------------------------------------------------------
// 2. Serve the page from a real http origin.
// ---------------------------------------------------------------------------
const html = `<!doctype html><html><head><meta charset="utf-8"><title>wc-jwt</title></head><body><h1>webchannel jwt+pop</h1><script>${bundle}</script></body></html>`;
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(html);
});
await new Promise((r) => server.listen(PAGE_PORT, "127.0.0.1", r));
console.log(`[browser-jwt] page served at http://127.0.0.1:${PAGE_PORT}/`);

// ---------------------------------------------------------------------------
// 3. Launch headless Chromium and drive the in-page flow.
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

  console.log("[browser-jwt] running production WebChannelNatsClient (JWT+PoP) in headless Chromium…");
  const result = await page.evaluate(
    (o) => globalThis.WebJwtRegister.runJwtRegister(o),
    {
      natsUrl: NATS_URL,
      issuerUrl: ISSUER_URL,
      gwUrl: GW_URL,
      agentId: AGENT_ID,
      tenant: TENANT,
      peerId: PEER_ID,
      text: TEXT,
      timeoutMs: TIMEOUT_MS,
    },
  );

  const replyText = result?.replyText ?? "";
  console.log("[browser-jwt] [REPLY]", JSON.stringify(replyText).slice(0, 300));

  if (replyText.includes(TEXT)) {
    console.log("[PROOF] real headless browser drove JWT+PoP register hop → encrypted round-trip OK");
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
