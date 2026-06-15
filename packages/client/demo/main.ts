/**
 * Vanilla (no-framework) demo for `@clawchannel/client`.
 *
 * This is the whole point of the package: drive ClawChannel from plain
 * JavaScript + DOM, with ZERO React. We construct one `ClawChannelClient`,
 * `subscribe` to its immutable state, and re-render a tiny transcript UI on each
 * change. `send` / `decide` go straight back to the client.
 *
 * Mirrors the React example's hmac-ticket flow: enter the gateway's shared
 * secret + a user id, the browser mints a short-lived ticket (devTicket.ts) and
 * connects via the same-origin `/clawchannel/ws` path (vite proxies it to the
 * gateway). Run with `npm run dev`.
 *
 * ⚠️ DEMO ONLY — minting tickets in the browser exposes the secret. In
 * production your backend issues tickets server-side (AUTH.md §5); pass that as
 * `getTicket`. For a cross-origin gateway, pass `url` instead of using the proxy.
 */
import { ClawChannelClient } from "../src/index.js";
import type { ApprovalDecision, ClawChannelState } from "../src/index.js";
import { makeDevGetTicket } from "./devTicket.js";

const root = document.getElementById("app")!;
root.style.cssText = "max-width:480px;margin:2rem auto;font-family:system-ui";

let client: ClawChannelClient | null = null;
let unsubscribe: (() => void) | null = null;

// ── connect gate (secret + userId) ────────────────────────────────────────────
function renderConnectForm(): void {
  client = null;
  root.replaceChildren();

  const h = el("h2", "ClawChannel — vanilla (no React)");
  const note = el(
    "p",
    "Enter the gateway's shared secret (channels.clawchannel.auth.ticketSecret) and a user id. The browser mints a short-lived ticket and connects.",
  );
  note.style.cssText = "color:#555;font-size:14px;line-height:1.5";
  const warn = el(
    "p",
    "⚠️ Demo only — the secret is used in the browser. In production your backend issues tickets server-side.",
  );
  warn.style.cssText = "color:#a15;font-size:13px;line-height:1.5";

  const secret = inputEl("password", "same as gateway ticketSecret");
  const userId = inputEl("text", "alice");
  userId.value = "alice";

  const connectBtn = el("button", "Connect") as HTMLButtonElement;
  connectBtn.type = "submit";
  connectBtn.style.cssText = "padding:8px 16px;border-radius:8px";

  const form = document.createElement("form");
  form.style.cssText =
    "display:flex;flex-direction:column;gap:10px;margin-top:16px";
  form.append(
    labeled("Shared secret", secret),
    labeled("User id (ticket sub)", userId),
    connectBtn,
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!secret.value.trim() || !userId.value.trim()) return;
    startSession(secret.value.trim(), userId.value.trim());
  };

  root.append(h, note, warn, form);
}

// ── live chat (subscribed to the client) ──────────────────────────────────────
function startSession(secret: string, sub: string): void {
  client = new ClawChannelClient({
    path: "/clawchannel/ws",
    getTicket: makeDevGetTicket(secret, sub),
  });

  root.replaceChildren();

  const bar = el("div");
  bar.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;" +
    "font-size:13px;color:#666;margin-bottom:4px";
  const who = el("span");
  who.innerHTML = `hmac-ticket · as <strong>${escapeHtml(sub)}</strong>`;
  const dot = el("span");
  dot.title = "status";
  dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#bbb";
  const whoWrap = el("span");
  whoWrap.style.cssText = "display:flex;align-items:center;gap:8px";
  whoWrap.append(dot, who);
  const disconnect = el("button", "Disconnect") as HTMLButtonElement;
  disconnect.type = "button";
  disconnect.style.cssText = "font-size:12px;padding:2px 8px";
  disconnect.onclick = () => {
    unsubscribe?.();
    unsubscribe = null;
    client?.close();
    renderConnectForm();
  };
  bar.append(whoWrap, disconnect);

  const transcript = el("div");
  transcript.style.cssText =
    "border:1px solid #ddd;border-radius:8px;padding:12px;height:360px;" +
    "overflow-y:auto;display:flex;flex-direction:column;gap:8px";

  const form = document.createElement("form");
  form.style.cssText = "display:flex;gap:8px;margin-top:8px";
  const input = inputEl("text", "Connecting…");
  input.disabled = true;
  input.style.flex = "1";
  const sendBtn = el("button", "Send") as HTMLButtonElement;
  sendBtn.type = "submit";
  sendBtn.disabled = true;
  sendBtn.style.cssText = "padding:8px 16px";
  form.append(input, sendBtn);
  form.onsubmit = (e) => {
    e.preventDefault();
    client?.send(input.value);
    input.value = "";
  };

  root.append(bar, transcript, form);

  const render = (state: ClawChannelState): void => {
    dot.style.background =
      state.status === "connected"
        ? "#2ecc71"
        : state.status === "reconnecting" || state.status === "connecting"
          ? "#f0ad4e"
          : "#bbb";
    dot.title = state.status;
    input.disabled = !state.connected;
    sendBtn.disabled = !state.connected;
    input.placeholder = state.connected ? "Type a message…" : "Connecting…";
    transcript.replaceChildren(
      ...state.messages.map(renderMessage),
      ...state.approvals.map(renderApproval),
    );
    transcript.scrollTop = transcript.scrollHeight;
  };

  unsubscribe = client.subscribe(render);
  render(client.getState());
  client.connect();
}

// ── render helpers ────────────────────────────────────────────────────────────
function renderMessage(m: ClawChannelState["messages"][number]): HTMLElement {
  const bubble = el("div", m.text);
  const isUser = m.role === "user";
  bubble.style.cssText = [
    `align-self:${isUser ? "flex-end" : "flex-start"}`,
    `background:${isUser ? "#0a84ff" : m.working ? "#f4f0e6" : "#eee"}`,
    `color:${isUser ? "white" : m.working ? "#7a6f57" : "black"}`,
    `font-style:${m.working ? "italic" : "normal"}`,
    `border:${m.working ? "1px dashed #d8cfb8" : "none"}`,
    "padding:6px 10px;border-radius:12px;max-width:80%;white-space:pre-wrap",
  ].join(";");
  return bubble;
}

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  "allow-once": "Allowed once",
  "allow-always": "Allowed always",
  deny: "Denied",
};

function approvalButtonColor(style: string): string {
  switch (style) {
    case "success":
      return "#2ecc71";
    case "danger":
      return "#e74c3c";
    case "primary":
      return "#0a84ff";
    default:
      return "#888";
  }
}

function renderApproval(a: ClawChannelState["approvals"][number]): HTMLElement {
  const card = el("div");
  card.style.cssText =
    "align-self:flex-start;background:#fff8e1;border:1px solid #f0d98c;" +
    "border-radius:12px;padding:10px 12px;max-width:90%;display:flex;" +
    "flex-direction:column;gap:8px";

  const title = el(
    "div",
    a.kind === "exec" ? "Approval required" : "Plugin approval",
  );
  title.style.fontWeight = "600";
  const prompt = el("div", a.prompt);
  prompt.style.cssText = "white-space:pre-wrap;color:#5a4b1f";
  card.append(title, prompt);

  if (a.resolvedDecision !== undefined) {
    const outcome = el("div", DECISION_LABEL[a.resolvedDecision]);
    outcome.style.cssText = "font-style:italic;color:#7a6f57";
    card.appendChild(outcome);
  } else {
    const row = el("div");
    row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
    for (const opt of a.options) {
      const btn = el("button", opt.label) as HTMLButtonElement;
      btn.type = "button";
      btn.style.cssText = [
        "padding:6px 12px;border-radius:8px;border:none;color:white;cursor:pointer",
        `background:${approvalButtonColor(opt.style)}`,
      ].join(";");
      btn.onclick = () => client?.decide(a.id, opt.decision);
      row.appendChild(btn);
    }
    card.appendChild(row);
  }
  return card;
}

// ── tiny DOM utils ────────────────────────────────────────────────────────────
function el(tag: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function inputEl(type: string, placeholder: string): HTMLInputElement {
  const node = document.createElement("input");
  node.type = type;
  node.placeholder = placeholder;
  node.autocomplete = "off";
  node.style.cssText = "padding:8px;border-radius:8px;border:1px solid #ccc";
  return node;
}

function labeled(text: string, control: HTMLElement): HTMLElement {
  const label = document.createElement("label");
  label.style.cssText = "display:flex;flex-direction:column;gap:4px;font-size:13px";
  label.append(document.createTextNode(text), control);
  return label;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

renderConnectForm();
