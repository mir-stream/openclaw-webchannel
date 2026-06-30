#!/usr/bin/env node
/**
 * Interactive LIVE chat server — the persistent, human-facing page that talks to
 * a REAL openclaw gateway over the EXISTING hmac-ticket webchannel path (NOT the
 * NATS path). It is the hmac-ticket sibling of demo-server.mjs.
 *
 * It:
 *   1. esbuild → IIFE bundles packages/client/src/browser-live-entry.ts with
 *      global name `WebLive` (footer pins globalThis.WebLive).
 *   2. Serves, on WEBCHANNEL_PAGE_PORT (default 19394), bound to 127.0.0.1:
 *        GET /              → live-chat.html with a <script> injecting
 *                             globalThis.__LIVE_CONFIG__ (wsUrl/ticketUrl) into
 *                             <head>, BEFORE the bundle <script>, so config
 *                             exists when the bundle runs.
 *        GET /live-bundle.js → the built bundle (text/javascript).
 *        GET /ticket        → a FRESH server-minted HS256 ticket (text/plain).
 *   3. Stays alive until SIGINT/SIGTERM, then closes the server and exits 0.
 *
 * TICKET APPROACH: TS IMPORT. This file imports the REAL `issueWebChannelTicket`
 * straight from the plugin TypeScript source (`../../packages/plugin/src/ticket.ts`)
 * — the single source of truth for the wire format — so it MUST be launched under
 * tsx, e.g. `node --import tsx live-chat-server.mjs`. The shared
 * WEBCHANNEL_TICKET_SECRET is read from the environment and NEVER reaches the
 * browser (only the minted short-lived token does).
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { issueWebChannelTicket } from "../../packages/plugin/src/ticket.ts";

const __dirname = dirname(fileURLToPath(import.meta.url)); // e2e/local
const ROOT = join(__dirname, "..", "..");

const WS_URL    = process.env.WEBCHANNEL_LIVE_WS_URL ?? "ws://127.0.0.1:18789/webchannel/ws";
const SUB       = process.env.WEBCHANNEL_LIVE_SUB    ?? "web-anon";
const SECRET    = process.env.WEBCHANNEL_TICKET_SECRET; // required to mint tickets
const PAGE_PORT = parseInt(process.env.WEBCHANNEL_PAGE_PORT ?? "19394", 10);
const TICKET_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------
// 1. Build the browser bundle (esbuild → IIFE; footer pins globalThis.WebLive).
//    Same esbuild bin path + flags as demo-server.mjs.
// ---------------------------------------------------------------------------
function buildBundle() {
  const esbuildBin = join(ROOT, "node_modules/tsx/node_modules/esbuild/bin/esbuild");
  const entryPoint = join(ROOT, "packages/client/src/browser-live-entry.ts");
  const outFile = join(tmpdir(), `live-bundle-${process.pid}.js`);
  execFileSync(esbuildBin, [
    entryPoint,
    "--bundle",
    "--platform=browser",
    "--format=iife",
    "--global-name=WebLive",
    "--footer:js=;globalThis.WebLive=WebLive;",
    `--outfile=${outFile}`,
    "--log-level=warning",
  ]);
  return readFileSync(outFile, "utf8");
}

let bundle;
try {
  bundle = buildBundle();
  console.log("[live-chat-server] esbuild bundle built");
} catch (err) {
  console.error("[live-chat-server] BUNDLE FAILED:", err?.message ?? err);
  process.exit(6);
}

// ---------------------------------------------------------------------------
// 2. Load the chat page and inject the config <script> into <head>, BEFORE the
//    bundle <script src="/live-bundle.js"> tag, so __LIVE_CONFIG__ exists when
//    the bundle runs.
// ---------------------------------------------------------------------------
const rawHtml = readFileSync(join(__dirname, "live-chat.html"), "utf8");
const configScript =
  `<script>globalThis.__LIVE_CONFIG__=${JSON.stringify({
    wsUrl: WS_URL,
    ticketUrl: "/ticket",
  })};</script>`;

// Inject right after <head ...> (the bundle <script> lives in <body>, so the
// <head> injection is safely BEFORE it).
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

  if (url === "/live-bundle.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(bundle);
    return;
  }

  if (url === "/ticket") {
    if (!SECRET) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("WEBCHANNEL_TICKET_SECRET is not set — the server cannot mint tickets.");
      return;
    }
    try {
      const token = issueWebChannelTicket({
        sub: SUB,
        secret: SECRET,
        ttlSeconds: TICKET_TTL_SECONDS,
      });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(token);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`ticket mint failed: ${err?.message ?? err}`);
    }
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("not found");
});

server.listen(PAGE_PORT, "127.0.0.1", () => {
  console.log(`[live-chat-server] live chat UI at http://127.0.0.1:${PAGE_PORT}/`);
  if (!SECRET) {
    console.warn(
      "[live-chat-server] WARNING: WEBCHANNEL_TICKET_SECRET is unset — /ticket will 500 until the Tech Lead supplies it.",
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Stay alive; clean shutdown on SIGINT/SIGTERM.
// ---------------------------------------------------------------------------
function shutdown() {
  console.log("[live-chat-server] shutting down…");
  server.close(() => process.exit(0));
  // Force-exit if close hangs (e.g. a lingering keep-alive socket).
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
