#!/usr/bin/env node
/**
 * Interactive chat demo server — the persistent, human-facing sibling of
 * all-real.mjs. It REMOVES all Playwright/headless driving: instead of launching
 * a browser and running one round-trip, it builds the browser bundle and serves
 * a chat page so a HUMAN can open it and chat with the live (enrolled, echo)
 * agent over the same all-real trust chain.
 *
 * It:
 *   1. esbuild → IIFE bundles packages/client/src/browser-demo-entry.ts with
 *      global name `WebDemo` (footer pins globalThis.WebDemo).
 *   2. Serves, on WEBCHANNEL_PAGE_PORT (default 19393), bound to 127.0.0.1:
 *        GET /              → demo-chat.html with a <script> injecting
 *                             globalThis.__DEMO_CONFIG__ (natsUrl/issuerUrl/…) into
 *                             <head>, BEFORE the bundle <script>, so config exists
 *                             when the bundle runs.
 *        GET /demo-bundle.js → the built bundle (text/javascript).
 *   3. Stays alive until SIGINT/SIGTERM, then closes the server and exits 0.
 *
 * The caller (run-demo.sh) points the WEBCHANNEL_* env at the live
 * issuer/nats/gateway/tenant/agent/peer.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url)); // e2e/local
const ROOT = join(__dirname, "..", "..");

const NATS_URL   = process.env.WEBCHANNEL_NATS_URL   ?? "ws://127.0.0.1:18722";
const ISSUER_URL = process.env.WEBCHANNEL_ISSUER_URL ?? "http://127.0.0.1:3942";
const GW_URL     = process.env.WEBCHANNEL_GW_URL     ?? "http://127.0.0.1:19299";
const AGENT_ID   = process.env.WEBCHANNEL_AGENT_ID   ?? "default-agent";
const TENANT     = process.env.WEBCHANNEL_TENANT     ?? "default-tenant";
const PEER_ID    = process.env.WEBCHANNEL_PEER_ID    ?? "web-allreal-peer";
const PAGE_PORT  = parseInt(process.env.WEBCHANNEL_PAGE_PORT ?? "19393", 10);

// ---------------------------------------------------------------------------
// 1. Build the browser bundle (esbuild → IIFE; footer pins globalThis.WebDemo).
//    Same esbuild bin path as all-real.mjs.
// ---------------------------------------------------------------------------
function buildBundle() {
  const esbuildBin = join(ROOT, "node_modules/tsx/node_modules/esbuild/bin/esbuild");
  const entryPoint = join(ROOT, "packages/client/src/browser-demo-entry.ts");
  const outFile = join(tmpdir(), `demo-bundle-${process.pid}.js`);
  execFileSync(esbuildBin, [
    entryPoint,
    "--bundle",
    "--platform=browser",
    "--format=iife",
    "--global-name=WebDemo",
    "--footer:js=;globalThis.WebDemo=WebDemo;",
    `--outfile=${outFile}`,
    "--log-level=warning",
  ]);
  return readFileSync(outFile, "utf8");
}

let bundle;
try {
  bundle = buildBundle();
  console.log("[demo-server] esbuild bundle built");
} catch (err) {
  console.error("[demo-server] BUNDLE FAILED:", err?.message ?? err);
  process.exit(6);
}

// ---------------------------------------------------------------------------
// 2. Load the chat page and inject the config <script> into <head>, BEFORE the
//    bundle <script src="/demo-bundle.js"> tag, so __DEMO_CONFIG__ exists when
//    the bundle runs.
// ---------------------------------------------------------------------------
const rawHtml = readFileSync(join(__dirname, "demo-chat.html"), "utf8");
const configScript =
  `<script>globalThis.__DEMO_CONFIG__=${JSON.stringify({
    natsUrl: NATS_URL,
    issuerUrl: ISSUER_URL,
    gwUrl: GW_URL,
    agentId: AGENT_ID,
    tenant: TENANT,
    peerId: PEER_ID,
  })};</script>`;

// Inject right after <head ...> (the demo-chat.html head contains the bundle
// <script>, which lives in <body>, so injecting into <head> is safely BEFORE it).
const pageHtml = rawHtml.replace(/<head[^>]*>/i, (m) => `${m}\n  ${configScript}`);

// ---------------------------------------------------------------------------
// 3. Persistent http server on 127.0.0.1:PAGE_PORT.
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(pageHtml);
    return;
  }
  if (url === "/demo-bundle.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(bundle);
    return;
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("not found");
});

server.listen(PAGE_PORT, "127.0.0.1", () => {
  console.log(`[demo-server] chat UI at http://127.0.0.1:${PAGE_PORT}/`);
});

// ---------------------------------------------------------------------------
// 4. Stay alive; clean shutdown on SIGINT/SIGTERM.
// ---------------------------------------------------------------------------
function shutdown() {
  console.log("[demo-server] shutting down…");
  server.close(() => process.exit(0));
  // Force-exit if close hangs (e.g. a lingering keep-alive socket).
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
