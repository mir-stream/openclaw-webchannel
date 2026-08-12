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
 * Set ECHO_MULTI_MSG_MARKER to make a turn carrying that marker produce TWO real
 * assistant messages instead of one (the #94 multi-message harness). The only way
 * a provider drives a second assistant message in one turn is a tool call, so the
 * two phases are:
 *   phase 1 (no tool result in `messages` yet) → assistant content = message A's
 *     text PLUS a `tool_calls` entry, `finish_reason:"tool_calls"`;
 *   phase 2 (a `role:"tool"` message is present) → ordinary assistant content =
 *     message B's text, `finish_reason:"stop"`.
 * Core's openai-completions adapter parses streamed `tool_calls` deltas
 * (node_modules/openclaw/dist/openai-completions-vbhA-xck.js:579-581) and maps
 * `finish_reason:"tool_calls"` to `stopReason:"toolUse"` (:1017-1018), so this
 * really does run core's tool loop — it is not a synthetic second message.
 * ECHO_MULTI_MSG_TOOL must name a tool core ACTUALLY advertises in `body.tools`
 * and can execute; the default `agents_list` is side-effect-free, takes no
 * arguments, and touches no filesystem or network state.
 *
 * Set ECHO_TOOL_FIRST_MARKER for the same two-phase tool loop with ONE
 * difference: phase 1 emits the `tool_calls` entry and NO assistant content at
 * all, so the turn's FIRST assistant message is tool-only and the channel's
 * first draft lane can never materialize. That is the ordinary shape of "call a
 * tool, then answer" — the most common multi-message turn there is — and it is
 * the one the #94 lane model stalls on, so it gets its own fixture.
 *
 * With ECHO_MULTI_MSG_MARKER and ECHO_TOOL_FIRST_MARKER unset (the default)
 * behaviour is byte-identical to before these modes existed — every other
 * harness shares this file.
 *
 * Usage: node e2e/local/echo-openai-server.mjs [port]   (default 18900)
 */
import { createServer } from "node:http";

const PORT = parseInt(process.argv[2] || process.env.ECHO_PORT || "18900", 10);
const PREFIX = process.env.ECHO_PREFIX ?? "echo: ";
const FAIL_MARKER = process.env.ECHO_FAIL_MARKER || "";

// #94 multi-assistant-message mode. All four are inert while the marker is unset.
const MULTI_MARKER = process.env.ECHO_MULTI_MSG_MARKER || "";
const MULTI_TOOL = process.env.ECHO_MULTI_MSG_TOOL || "agents_list";
// A and B must NOT be prefix-related: the plugin's lane rotation reads a partial
// whose cumulative text stops extending the active lane, and a shrink guard
// deliberately suppresses rotation for a strict prefix (plan §12.2(1)). Prefix-
// related fixtures would test the residual, not the boundary.
const MULTI_TEXT_A = process.env.ECHO_MULTI_MSG_TEXT_A || "ISSUE94_MESSAGE_A checking the roster now.";
const MULTI_TEXT_B = process.env.ECHO_MULTI_MSG_TEXT_B || "ZZZ94_SECOND_ANSWER here is what came back.";

// #94 tool-only-first mode: same loop, but phase 1 carries NO assistant text.
const TOOL_FIRST_MARKER = process.env.ECHO_TOOL_FIRST_MARKER || "";
const TOOL_FIRST_TEXT =
  process.env.ECHO_TOOL_FIRST_TEXT || "TOOLFIRST94_ANSWER after the tool ran.";

let multiToolCallSeq = 0;

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

    const id = "chatcmpl-echo";
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || "echo";
    const sseHead = () =>
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
    const sseChunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

    // #94 multi-assistant-message mode. Gated on the marker AND on the request
    // actually carrying a tool catalogue: an agent turn advertises `tools`, while
    // core's auxiliary completions (title/summary generation) do not, and driving
    // a tool call from one of those would deadlock the turn rather than test it.
    const userText = lastUserText(body.messages);
    const toolLoopMode =
      Array.isArray(body.tools) && body.tools.length > 0
        ? TOOL_FIRST_MARKER && userText.includes(TOOL_FIRST_MARKER)
          ? "tool-first"
          : MULTI_MARKER && userText.includes(MULTI_MARKER)
            ? "multi"
            : null
        : null;
    if (toolLoopMode) {
      // Phase 1 assistant content: message A's text, or NOTHING at all in
      // tool-first mode (the tool-only first assistant message).
      const phase1Text = toolLoopMode === "tool-first" ? "" : MULTI_TEXT_A;
      const phase2Text = toolLoopMode === "tool-first" ? TOOL_FIRST_TEXT : MULTI_TEXT_B;
      const advertised = body.tools.some((t) => t?.function?.name === MULTI_TOOL);
      if (!advertised) {
        console.log(
          `[echo] WARN multi-msg tool ${JSON.stringify(MULTI_TOOL)} is NOT in body.tools ` +
            `(${body.tools.map((t) => t?.function?.name).join(",")}) — core will not be able to execute it`,
        );
      }
      // Phase is decided by the transcript, not by a counter: once core has run
      // the tool it feeds the result back as a `role:"tool"` message.
      //
      // Scope that to THIS turn — messages after the last `role:"user"` one.
      // A second marker turn in the same session still carries the PREVIOUS
      // turn's `role:"tool"` message, so scanning the whole array reports
      // phase 2 on the very first request and the turn never makes a tool call
      // at all. That silently downgrades a two-assistant-message fixture to an
      // ordinary one-message turn, and the harness then passes while testing
      // nothing.
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUserIndex = messages.map((m) => m?.role).lastIndexOf("user");
      const toolResultSeen = messages
        .slice(lastUserIndex + 1)
        .some((m) => m && m.role === "tool");

      if (!toolResultSeen) {
        const callId = `call_issue94_${++multiToolCallSeq}`;
        console.log(
          `[echo] ${toolLoopMode} phase 1 → ${phase1Text ? "text A + " : "NO text, "}` +
            `tool_call ${MULTI_TOOL} (${callId})`,
        );
        if (body.stream) {
          sseHead();
          res.write(sseChunk({ role: "assistant" }));
          // Split A across two deltas so the partial lane really streams. In
          // tool-first mode there is no content delta at all.
          if (phase1Text) {
            const cut = Math.ceil(phase1Text.length / 2);
            res.write(sseChunk({ content: phase1Text.slice(0, cut) }));
            res.write(sseChunk({ content: phase1Text.slice(cut) }));
          }
          res.write(sseChunk({
            tool_calls: [{ index: 0, id: callId, type: "function", function: { name: MULTI_TOOL, arguments: "" } }],
          }));
          res.write(sseChunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }));
          res.write(sseChunk({}, "tool_calls"));
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          id, object: "chat.completion", created, model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: phase1Text,
              tool_calls: [{ id: callId, type: "function", function: { name: MULTI_TOOL, arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
        return;
      }

      console.log(`[echo] ${toolLoopMode} phase 2 → text B (finish stop)`);
      if (body.stream) {
        sseHead();
        res.write(sseChunk({ role: "assistant" }));
        const cut = Math.ceil(phase2Text.length / 2);
        res.write(sseChunk({ content: phase2Text.slice(0, cut) }));
        res.write(sseChunk({ content: phase2Text.slice(cut) }));
        res.write(sseChunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: phase2Text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
      return;
    }

    const reply = `${PREFIX}${userText}`;

    if (body.stream) {
      sseHead();
      res.write(sseChunk({ role: "assistant" }));
      res.write(sseChunk({ content: reply }));
      res.write(sseChunk({}, "stop"));
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
  if (MULTI_MARKER) {
    console.log(`[echo] multi-assistant-message mode armed (marker=${JSON.stringify(MULTI_MARKER)}, tool=${JSON.stringify(MULTI_TOOL)})`);
  }
});
