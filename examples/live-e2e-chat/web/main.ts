/**
 * Browser chat UI — the human-facing half of the live E2E demo.
 *
 * Uses the same browser modules verified headlessly by ../smoke.ts:
 *   e2e-crypto (X25519+HKDF+ChaCha20-Poly1305) · e2e-envelope · nats-ws.
 *
 * It dials the NATS server over WebSocket, does an X25519 handshake with the
 * agent, then exchanges ChaCha20-Poly1305-encrypted messages. A "wire" panel
 * shows the raw ciphertext envelope that actually crosses NATS, next to the
 * plaintext you see — proving the relay never sees your words.
 */

import { generateKeyPair, deriveSharedSecret, hkdfSha256 } from "./e2e-crypto.js";
import {
  encodeEnvelope,
  decryptEnvelopeContent,
  serializeEnvelope,
  deserializeEnvelope,
  type MessageEnvelope,
} from "./e2e-envelope.js";
import { NatsWsClient } from "./nats-ws.js";
import {
  NATS_WS_URL,
  TENANT,
  AGENT_ID,
  PEER_ID,
  inboundSubject,
  outboundSubject,
  handshakeSubject,
  type HandshakeMessage,
} from "../protocol.js";

const HKDF_INFO = "webchannel-conversation-v1";

// --- tiny DOM helpers -------------------------------------------------------
const app = document.getElementById("app")!;
app.innerHTML = `
  <header>
    <h1>WebChannel — live E2E chat over NATS</h1>
    <div id="status" class="status">connecting…</div>
  </header>
  <main>
    <section class="chat">
      <div id="log" class="log"></div>
      <form id="form" autocomplete="off">
        <input id="input" placeholder="Type a message… (it gets ChaCha20-Poly1305 encrypted)" disabled />
        <button id="send" disabled>Send</button>
      </form>
    </section>
    <section class="wire">
      <h2>On the wire (what the NATS relay sees)</h2>
      <p class="hint">Routing metadata is plaintext; <code>content</code> is ciphertext only.</p>
      <pre id="wire">—</pre>
      <h2>After decrypt (what only you + the agent see)</h2>
      <pre id="plain">—</pre>
    </section>
  </main>`;

const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const inputEl = document.getElementById("input") as HTMLInputElement;
const sendEl = document.getElementById("send") as HTMLButtonElement;
const formEl = document.getElementById("form") as HTMLFormElement;
const wireEl = document.getElementById("wire")!;
const plainEl = document.getElementById("plain")!;

function setStatus(text: string, cls: string) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}
function addBubble(text: string, who: "you" | "agent" | "sys") {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function showWire(env: MessageEnvelope, plaintext: string) {
  wireEl.textContent = JSON.stringify(env, null, 2);
  plainEl.textContent = plaintext;
}

// --- crypto + transport -----------------------------------------------------
const browser = generateKeyPair();
let sessionKey: Uint8Array | null = null;
const client = new NatsWsClient(NATS_WS_URL);
const hs = handshakeSubject();
const out = outboundSubject();
const inbound = inboundSubject();

const helloMsg: HandshakeMessage = {
  type: "handshake",
  from: "browser",
  publicKey: toB64Url(browser.publicKey),
};

client.onMessage((subject, payload) => {
  const raw = new TextDecoder().decode(payload);
  if (subject === hs) {
    let m: HandshakeMessage;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type !== "handshake" || m.from !== "agent" || sessionKey) return;
    const agentPub = fromB64Url(m.publicKey);
    sessionKey = hkdfSha256(deriveSharedSecret(browser.privateKey, agentPub), null, HKDF_INFO, 32);
    setStatus("🔒 E2E session established", "ok");
    addBubble("Secure channel established (X25519 + HKDF-SHA256). You can chat now.", "sys");
    inputEl.disabled = false;
    sendEl.disabled = false;
    inputEl.focus();
  } else if (subject === out) {
    if (!sessionKey) return;
    try {
      const env = deserializeEnvelope(raw);
      const text = new TextDecoder().decode(decryptEnvelopeContent(env, sessionKey));
      const obj = JSON.parse(text);
      addBubble(obj.text, "agent");
      showWire(env, text);
    } catch (err) {
      addBubble(`(failed to decrypt agent message: ${(err as Error).message})`, "sys");
    }
  }
});

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || !sessionKey) return;
  inputEl.value = "";
  addBubble(text, "you");

  const env = encodeEnvelope(
    {
      agentId: AGENT_ID,
      tenant: TENANT,
      sub: PEER_ID,
      messageId: crypto.randomUUID(),
      envelopeType: "conversation",
      ts: Date.now(),
    },
    JSON.stringify({ text }),
    sessionKey,
  );
  showWire(env, JSON.stringify({ text }));
  client.publish(inbound, serializeEnvelope(env));
});

async function start() {
  try {
    await client.connect();
  } catch (err) {
    setStatus(`✗ cannot reach NATS at ${NATS_WS_URL} — is the demo running?`, "err");
    addBubble((err as Error).message, "sys");
    return;
  }
  client.subscribe(hs);
  client.subscribe(out);
  setStatus("connected — handshaking with agent…", "warn");
  addBubble("Connected to NATS. Sending X25519 public key to the agent…", "sys");
  // Retry the hello until the agent answers (it may start slightly after us).
  for (let i = 0; i < 30 && !sessionKey; i++) {
    client.publish(hs, JSON.stringify(helloMsg));
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!sessionKey) setStatus("✗ no agent responded — is agent.ts running?", "err");
}

function toB64Url(u: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

start();
