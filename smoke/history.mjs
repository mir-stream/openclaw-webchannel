/**
 * Live smoke for the history-pagination seed.
 *
 * 1. Connect.
 * 2. Send a user message.
 * 3. Wait for the agent's final reply (so the message lands in the transcript).
 * 4. Disconnect.
 * 5. Reconnect (fresh socket).
 * 6. Assert at least one `history` frame is received before the next turn
 *    completes, and that the prior user message is present in `messages`.
 *
 * Run with the same gateway the other smokes use:
 *   WS_URL=ws://127.0.0.1:18789/webchannel/ws node smoke/history.mjs
 *
 * For hmac-ticket auth, also set WEBCHANNEL_TICKET_SECRET and the smoke will
 * mint a fresh ticket on each connect (same approach as smoke/e2e.mjs).
 */

import { WebSocket } from "ws";
import crypto from "node:crypto";

const URL = process.env.WS_URL || "ws://127.0.0.1:18789/webchannel/ws";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 90000);
const SECRET = process.env.WEBCHANNEL_TICKET_SECRET;

function ticketUrl() {
  if (!SECRET) return URL;
  const b64 = (s) => Buffer.from(s).toString("base64url");
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64(JSON.stringify({ sub: "smoke-user", iat, exp: iat + 60 }));
  const si = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", SECRET).update(si).digest("base64url");
  return `${URL}?ticket=${encodeURIComponent(`${si}.${sig}`)}`;
}

const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`;

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ticketUrl());
    const frames = [];
    const timer = setTimeout(
      () => reject(new Error(`${label}: timeout after ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );
    ws.on("open", () => {
      console.log(`[${ms()}] ${label} connected`);
      clearTimeout(timer);
      resolve({ ws, frames });
    });
    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString();
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      frames.push(msg);
      console.log(`[${ms()}] ${label} <- ${msg.type}${msg.id ? ` id=${msg.id}` : ""}`);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ws error ${err?.message || err}`));
    });
    ws.on("close", () => {
      // Resolve on close so the smoke can still print what it saw.
    });
  });
}

function waitForFrame(frames, predicate, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const found = frames.find(predicate);
    if (found) return resolve(found);
    const t = setTimeout(
      () => reject(new Error(`${label}: did not see matching frame within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const interval = setInterval(() => {
      const f = frames.find(predicate);
      if (f) {
        clearTimeout(t);
        clearInterval(interval);
        resolve(f);
      }
    }, 50);
  });
}

const MARKER = `smoke-history-${Date.now()}`;

async function main() {
  // Phase 1: send a marker user message and let the agent reply.
  const phase1 = await connect("phase1");
  phase1.ws.send(JSON.stringify({ type: "user_message", text: MARKER }));
  console.log(`[${ms()}] phase1 -> user_message: ${MARKER}`);
  await waitForFrame(
    phase1.frames,
    (f) => f.type === "agent_message",
    "phase1",
    TIMEOUT_MS,
  );
  // Brief grace so the agent's turn finishes writing to the transcript.
  await new Promise((r) => setTimeout(r, 1500));
  phase1.ws.close();
  console.log(`[${ms()}] phase1 closed`);

  // Phase 2: reconnect and assert the snapshot contains our marker.
  const phase2 = await connect("phase2");
  const historyFrame = await waitForFrame(
    phase2.frames,
    (f) => f.type === "history",
    "phase2",
    TIMEOUT_MS,
  );
  const messages = Array.isArray(historyFrame.messages) ? historyFrame.messages : [];
  console.log(
    `[${ms()}] phase2 history: ${messages.length} message(s) — ids=${messages
      .slice(0, 5)
      .map((m) => m.id)
      .join(",")}${messages.length > 5 ? "…" : ""}`,
  );
  const sawMarker = messages.some(
    (m) => m && typeof m.text === "string" && m.text.includes(MARKER),
  );
  if (!sawMarker) {
    console.error(`[smoke] FAIL — marker "${MARKER}" not present in history snapshot`);
    phase2.ws.close();
    process.exit(2);
  }
  console.log(`[smoke] PASS — history snapshot hydrated with the prior user message`);
  phase2.ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`[smoke] FAIL — ${err?.message || err}`);
  process.exit(1);
});
