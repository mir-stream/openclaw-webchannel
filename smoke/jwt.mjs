/**
 * Live smoke for the JWT/JWKS auth strategy.
 *
 * Reads the JWT minted by `scripts/jwt-smoke-bootstrap.mjs` from
 * `/tmp/jwt-smoke.json` (line 2) and connects to the running gateway
 * via `?ticket=<jwt>`. Expects:
 *   - WS upgrade is accepted (no 401/403)
 *   - server pushes at least one frame (typing, history, agent_message, etc.)
 *
 * Run after switching the gateway to auth.strategy="jwt" with the same
 * issuer/audience/jwks that the bootstrap used. Restore the original
 * `~/.openclaw/openclaw.json` afterward (or restart the gateway).
 */

import { WebSocket } from "ws";
import fs from "node:fs";

const URL_BASE = process.env.WS_URL || "ws://127.0.0.1:18789/webchannel/ws";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000);

const boot = fs.readFileSync("/tmp/jwt-smoke.json", "utf8").trim().split("\n");
if (boot.length < 2) {
  console.error("[smoke] /tmp/jwt-smoke.json missing or malformed");
  process.exit(3);
}
const { jwt } = JSON.parse(boot[1]);
const url = `${URL_BASE}?ticket=${encodeURIComponent(jwt)}`;

const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`;
const frames = [];

const ws = new WebSocket(url);

const finish = (code, label) => {
  const types = frames.map((f) => f.type).join(",") || "(none)";
  const verdict =
    frames.length > 0
      ? `PASS — JWT ticket accepted, ${frames.length} frame(s): ${types}`
      : `FAIL — no frames received`;
  console.log(`\n[smoke] ${label} (${Date.now() - t0}ms)`);
  console.log(`[smoke] VERDICT: ${verdict}`);
  try { ws.close(); } catch {}
  process.exit(frames.length > 0 ? 0 : 2);
};

const timer = setTimeout(() => finish(2, "TIMEOUT"), TIMEOUT_MS);

ws.on("open", () => {
  console.log(`[${ms()}] connected (jwt ticket)`);
  ws.send(JSON.stringify({ type: "user_message", text: "jwt-smoke-ping" }));
});

ws.on("message", (data) => {
  const raw = typeof data === "string" ? data : data.toString();
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  frames.push(msg);
  const preview = typeof msg.text === "string" ? JSON.stringify(msg.text.slice(0, 80)) : "";
  console.log(`[${ms()}] <- ${msg.type} id=${msg.id ?? "-"} ${preview}`);
  if (msg.type === "agent_message") {
    clearTimeout(timer);
    setTimeout(() => finish(0, "agent reply"), 800);
  }
});

ws.on("unexpected-response", (_req, res) => {
  clearTimeout(timer);
  console.error(`[smoke] REJECTED at WS upgrade: HTTP ${res.statusCode}`);
  process.exit(3);
});

ws.on("error", (err) => { clearTimeout(timer); console.error(`[smoke] WS ERROR: ${err?.message || err}`); process.exit(4); });