#!/usr/bin/env node
/**
 * Fake OpenAI-compatible chat-completions server for LOCAL E2E.
 *
 * Implements just enough of POST /v1/chat/completions (both streaming SSE and
 * non-streaming) to return a deterministic "echo: <last user message>" reply.
 * Lets a real openclaw gateway answer without calling a real LLM — point a
 * provider at http://127.0.0.1:<port>/v1 with api:"openai-completions".
 *
 * Set ECHO_FAIL_MARKER to make the server REJECT (HTTP 500) any turn whose last
 * user message contains that marker, the way a provider outage does. Used by the
 * #87 turn-outcome harness to drive core's terminal-error path. Unset (the
 * default) means every turn echoes as before.
 *
 * Usage: node e2e/local/echo-openai-server.mjs [port]   (default 18900)
 */
import { createServer } from "node:http";

const PORT = parseInt(process.argv[2] || process.env.ECHO_PORT || "18900", 10);
const PREFIX = process.env.ECHO_PREFIX ?? "echo: ";
const FAIL_MARKER = process.env.ECHO_FAIL_MARKER || "";

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
      }
    }
  }
  return "";
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => { d += c; });
    req.on("end", () => resolve(d));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Minimal model listing (some clients probe /v1/models).
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [{ id: "echo", object: "model" }] }));
    return;
  }

  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }

    // Provider-rejection mode (#87 harness). A 500 here is what a real provider
    // outage looks like to core: it does not throw out of the turn, it absorbs
    // the failure and returns a terminal error payload instead of an answer.
    if (FAIL_MARKER && lastUserText(body.messages).includes(FAIL_MARKER)) {
      console.log(`[echo] REJECT (marker=${FAIL_MARKER})`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: { message: "echo harness: provider rejected the turn", type: "server_error" },
      }));
      return;
    }

    const reply = `${PREFIX}${lastUserText(body.messages)}`;
    const id = "chatcmpl-echo";
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || "echo";

    if (body.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant" }));
      res.write(chunk({ content: reply }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
      console.log(`[echo] stream → ${JSON.stringify(reply)}`);
      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }));
    console.log(`[echo] → ${JSON.stringify(reply)}`);
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[echo] fake OpenAI chat-completions on http://127.0.0.1:${PORT}/v1 (prefix=${JSON.stringify(PREFIX)})`);
});
