import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const ROOT = "/Users/mircorn/workspace/openclaw-webchannel";
const { chromium } = require(`${ROOT}/node_modules/openclaw/node_modules/playwright-core`);

const SECRET = "e2e-ticket-secret";
const b64 = (s) => Buffer.from(s).toString("base64url");
const iat = (Date.now() / 1000) | 0;
const si = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify({ sub: "web-anon", iat, exp: iat + 300 }))}`;
const jwt = `${si}.${crypto.createHmac("sha256", SECRET).update(si).digest("base64url")}`;

const bundle = readFileSync("/tmp/oc-e2e/browser-bundle.js", "utf8");
const PAGE_PORT = 19292;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>wc</title></head><body><h1>web client</h1><script>${bundle}</script></body></html>`;
const server = createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(html); });
await new Promise((r) => server.listen(PAGE_PORT, "127.0.0.1", r));

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("  [page]", m.text()));
await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);

console.log("[browser] running production WebChannelNatsClient in headless Chromium…");
const reply = await page.evaluate(
  async (opts) => await globalThis.runWeb(opts),
  { natsUrl: "ws://127.0.0.1:18222", jwt, accountId: "default-agent", tenant: "default-tenant", peerId: "web-anon", text: "hello from a real browser" },
);
console.log("\n[BROWSER REPLY]", JSON.stringify(reply).slice(0, 300));
console.log("\nContains the message echoed back? ", reply.includes("hello from a real browser"));

await browser.close();
server.close();
process.exit(reply.includes("hello from a real browser") ? 0 : 1);
