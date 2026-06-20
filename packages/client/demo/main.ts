/**
 * Vanilla (no-framework) demo for `openclaw-webchannel-client`.
 *
 * This is the whole point of the package: drive WebChannel from plain
 * JavaScript + DOM, with ZERO React. We construct one `WebChannelClient`,
 * `subscribe` to its immutable state, and re-render a tiny transcript UI on each
 * change. `send` / `decide` go straight back to the client.
 *
 * Mode: pick between `hmac-ticket` (browser-side HS256 minting, shared secret)
 * and `jwt` (browser-side RS256 minting with a self-generated keypair). The
 * gateway is configured server-side — whichever strategy you choose, point it
 * at the matching auth block. For JWT mode the demo prints its public JWK to
 * the console so an operator can paste it into the gateway's JWKS file.
 *
 * ⚠️ DEMO ONLY — minting tickets in the browser exposes the secret (hmac) or
 * the private key (jwt). In production your backend issues tickets server-side
 * (AUTH.md §5/§10); pass that as `getTicket`. For a cross-origin gateway, pass
 * `url` instead of using the proxy.
 */
import { WebChannelClient } from "../src/index.js";
import type { ApprovalDecision, WebChannelState } from "../src/index.js";
import { makeDevGetTicket } from "./devTicket.js";
import { initDevJwtIssuer, makeDevGetJwtTicket } from "./devTicket.jwt.js";

const root = document.getElementById("app")!;
root.style.cssText = "max-width:480px;margin:2rem auto;font-family:system-ui";

let client: WebChannelClient | null = null;
let unsubscribe: (() => void) | null = null;

// ── connect gate (secret + userId) ────────────────────────────────────────────
type AuthMode = "hmac-ticket" | "jwt";

function renderConnectForm(): void {
  client = null;
  root.replaceChildren();

  const h = el("h2", "WebChannel — vanilla (no React)");
  const note = el(
    "p",
    "Pick an auth mode and enter the matching config. The browser mints a short-lived ticket and connects.",
  );
  note.style.cssText = "color:#555;font-size:14px;line-height:1.5";
  const warn = el(
    "p",
    "⚠️ Demo only — minting tickets in the browser exposes the secret (hmac) or the private key (jwt). In production your backend issues tickets server-side.",
  );
  warn.style.cssText = "color:#a15;font-size:13px;line-height:1.5";

  const modeSelect = document.createElement("select") as HTMLSelectElement;
  modeSelect.style.cssText = "padding:8px;border-radius:8px;border:1px solid #ccc";
  for (const value of ["hmac-ticket", "jwt"] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent =
      value === "hmac-ticket"
        ? "hmac-ticket (shared secret)"
        : "jwt (RS256 + JWKS)";
    modeSelect.appendChild(opt);
  }
  modeSelect.value = "hmac-ticket";

  const secret = inputEl("password", "same as gateway ticketSecret");
  const userId = inputEl("text", "alice");
  userId.value = "alice";

  const issuer = inputEl("text", "https://demo.local/");
  issuer.value = "https://demo.local/";
  const audience = inputEl("text", "webchannel-demo");
  audience.value = "webchannel-demo";

  const connectBtn = el("button", "Connect") as HTMLButtonElement;
  connectBtn.type = "submit";
  connectBtn.style.cssText = "padding:8px 16px;border-radius:8px";
  connectBtn.disabled = false;

  // Show/hide the right fields based on the selected mode. The JWT block is
  // hidden by default because the default mode is hmac-ticket.
  const hmacBlock = labeled("Shared secret", secret);
  const jwtBlock = el("div");
  jwtBlock.style.cssText = "display:none;flex-direction:column;gap:10px";
  jwtBlock.append(
    labeled("Issuer (iss)", issuer),
    labeled("Audience (aud)", audience),
  );

  modeSelect.onchange = () => {
    if (modeSelect.value === "jwt") {
      hmacBlock.style.display = "none";
      jwtBlock.style.display = "flex";
    } else {
      hmacBlock.style.display = "flex";
      jwtBlock.style.display = "none";
    }
  };

  const form = document.createElement("form");
  form.style.cssText =
    "display:flex;flex-direction:column;gap:10px;margin-top:16px";
  form.append(
    labeled("Auth mode", modeSelect),
    hmacBlock,
    jwtBlock,
    labeled("User id (ticket sub)", userId),
    connectBtn,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!userId.value.trim()) return;
    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting…";
    try {
      const mode = modeSelect.value as AuthMode;
      const sub = userId.value.trim();
      if (mode === "hmac-ticket") {
        if (!secret.value.trim()) return;
        startSession({
          kind: "hmac-ticket",
          sub,
          getTicket: makeDevGetTicket(secret.value.trim(), sub),
        });
      } else {
        if (!issuer.value.trim() || !audience.value.trim()) return;
        // Generate (or load) the RSA keypair FIRST; only then start the session.
        // While the keypair is being created we paint a "preparing…" UI so the
        // user sees why the connect button is unresponsive.
        const dev = await initDevJwtIssuer({
          issuer: issuer.value.trim(),
          audience: audience.value.trim(),
        });
        // Print the demo's public JWK to the console so an operator can paste
        // it into the gateway's JWKS while testing.
        console.info(
          "[demo] JWT issuer ready — paste this public JWK into your gateway's JWKS:",
          dev.publicJwk,
        );
        startSession({
          kind: "jwt",
          sub,
          getTicket: makeDevGetJwtTicket(dev, sub),
        });
      }
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = "Connect";
    }
  };

  root.append(h, note, warn, form);
}

// ── live chat (subscribed to the client) ──────────────────────────────────────

type StartSessionInput = {
  kind: AuthMode;
  sub: string;
  getTicket: () => Promise<string | null>;
};

function startSession(input: StartSessionInput): void {
  client = new WebChannelClient({
    path: "/webchannel/ws",
    getTicket: input.getTicket,
  });

  root.replaceChildren();

  const bar = el("div");
  bar.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;" +
    "font-size:13px;color:#666;margin-bottom:4px";
  const who = el("span");
  who.innerHTML = `${input.kind} · as <strong>${escapeHtml(input.sub)}</strong>`;
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
  const chatInput = inputEl("text", "Connecting…");
  chatInput.disabled = true;
  chatInput.style.flex = "1";
  const sendBtn = el("button", "Send") as HTMLButtonElement;
  sendBtn.type = "submit";
  sendBtn.disabled = true;
  sendBtn.style.cssText = "padding:8px 16px";
  form.append(chatInput, sendBtn);
  form.onsubmit = (e) => {
    e.preventDefault();
    client?.send(chatInput.value);
    chatInput.value = "";
  };

  root.append(bar, transcript, form);

  const render = (state: WebChannelState): void => {
    dot.style.background =
      state.status === "connected"
        ? "#2ecc71"
        : state.status === "reconnecting" || state.status === "connecting"
          ? "#f0ad4e"
          : "#bbb";
    dot.title = state.status;
    chatInput.disabled = !state.connected;
    sendBtn.disabled = !state.connected;
    chatInput.placeholder = state.connected ? "Type a message…" : "Connecting…";
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
function renderMessage(m: WebChannelState["messages"][number]): HTMLElement {
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

function renderApproval(a: WebChannelState["approvals"][number]): HTMLElement {
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