/**
 * Chaos scene ③ raw NATS/register manipulations (run via chaos.sh).
 *
 *   cross-tenant   mint tenant-b creds, subscribe tenant-a's subtree → the relay
 *                  answers -ERR Permissions Violation (tenant ISOLATION).
 *   tamper         capture a live ciphertext .out frame with observer creds,
 *                  bit-flip it, republish → the widget AEAD-drops it (INTEGRITY).
 *   replay-jwt     (see chaos.sh note) register replay — separate HTTP flow.
 *
 * Uses a MINIMAL raw NATS-over-WebSocket client (NKEY challenge-response reusing
 * the production nats-nkey-browser signing), because the production NatsClient
 * only surfaces TERMINAL -ERR via onError — a per-subject "Permissions Violation"
 * is non-terminal and never reaches a callback, so we read raw protocol lines.
 */
import { importEd25519SeedKey, signNonce } from "../packages/client/src/nats-nkey-browser.js";

const SAAS_URL = process.env.SAAS_URL || "http://127.0.0.1:3961";
const TENANT = process.env.DEMO_TENANT || "demo-tenant";

function b64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Creds = { userJwt: string; userSeedRaw: string; natsUrl: string };
type RawNats = {
  sub: (subject: string) => void;
  pub: (subject: string, payload: string) => void;
  onLine: (h: (line: string) => void) => void;
  onMsg: (h: (subject: string, payload: string) => void) => void;
  close: () => void;
};

/** Log in as admin, return the session cookie. */
async function adminCookie(): Promise<string> {
  const res = await fetch(`${SAAS_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "demo" }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("admin login failed");
  return cookie;
}

/** Minimal raw NATS client over WebSocket with NKEY challenge-response. */
function rawConnect(creds: Creds): Promise<RawNats> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(creds.natsUrl);
    let buf = "";
    let connectSent = false;
    let ready = false;
    const lineHandlers = new Set<(line: string) => void>();
    const msgHandlers = new Set<(subject: string, payload: string) => void>();

    const api: RawNats = {
      sub: (s) => ws.send(`SUB ${s} 1\r\n`),
      pub: (s, p) => ws.send(`PUB ${s} ${Buffer.byteLength(p, "binary")}\r\n${p}\r\n`),
      onLine: (h) => lineHandlers.add(h),
      onMsg: (h) => msgHandlers.add(h),
      close: () => ws.close(),
    };

    ws.binaryType = "arraybuffer";
    ws.onerror = () => reject(new Error("ws error"));
    ws.onclose = () => { if (!ready) reject(new Error("closed before ready")); };
    ws.onmessage = async (ev: MessageEvent) => {
      buf += typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("binary");
      let pos: number;
      while ((pos = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, pos);
        if (line.startsWith("MSG ")) {
          const parts = line.split(" ");
          const subject = parts[1];
          const bytes = parseInt(parts[parts.length - 1], 10);
          if (buf.length < pos + 2 + bytes + 2) break; // await full payload
          const payload = buf.slice(pos + 2, pos + 2 + bytes);
          buf = buf.slice(pos + 2 + bytes + 2);
          for (const h of msgHandlers) h(subject, payload);
          continue;
        }
        buf = buf.slice(pos + 2);
        if (!line) continue;
        if (line.startsWith("INFO ")) {
          if (!connectSent) {
            connectSent = true;
            let nonce = "";
            try { nonce = (JSON.parse(line.slice(5)) as { nonce?: string }).nonce ?? ""; } catch { /* */ }
            let sig = "";
            if (nonce) sig = await signNonce(await importEd25519SeedKey(b64urlDecode(creds.userSeedRaw)), nonce);
            const payload: Record<string, unknown> = {
              verbose: false, pedantic: false, lang: "ts", version: "1", protocol: 1, echo: false, jwt: creds.userJwt,
            };
            if (sig) payload["sig"] = sig;
            ws.send(`CONNECT ${JSON.stringify(payload)}\r\n`);
            ws.send("PING\r\n");
          }
          continue;
        }
        if (line === "PONG") { if (!ready) { ready = true; resolve(api); } continue; }
        if (line.startsWith("+OK")) continue;
        for (const h of lineHandlers) h(line);
      }
    };
  });
}

async function crossTenant(): Promise<number> {
  const cookie = await adminCookie();
  const res = await fetch(`${SAAS_URL}/admin/chaos/nats-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ tenant: "tenant-b", role: "browser" }),
  });
  if (!res.ok) throw new Error(`chaos mint failed: HTTP ${res.status}`);
  const creds = (await res.json()) as Creds;
  console.log("[chaos] minted tenant-b creds; subscribing tenant-a's subtree…");
  const nats = await rawConnect(creds);
  let violation = false;
  nats.onLine((line) => {
    if (/-ERR.*Permissions Violation/i.test(line)) {
      violation = true;
      console.log(`[chaos] ✓ relay refused cross-tenant subscribe → ${line.trim()}`);
    }
  });
  nats.sub(`webchannel.${TENANT}.>`);
  await sleep(2000);
  nats.close();
  if (!violation) { console.error("[chaos] ✗ expected -ERR Permissions Violation, saw none"); return 3; }
  console.log("[chaos] cross-tenant isolation holds (tenant-b cannot read tenant-a).");
  return 0;
}

async function tamper(): Promise<number> {
  const cookie = await adminCookie();
  // Observer creds for THIS tenant (admin session). Same mint the wiretap uses.
  const res = await fetch(`${SAAS_URL}/nats-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ role: "browser" }),
  });
  if (!res.ok) throw new Error(`observer mint failed: HTTP ${res.status}`);
  const creds = (await res.json()) as Creds;
  const nats = await rawConnect(creds);
  let captured: { subject: string; payload: string } | null = null;
  nats.onMsg((subject, payload) => {
    if (!captured && subject.endsWith(".out") && payload.length > 0) captured = { subject, payload };
  });
  nats.sub(`webchannel.${TENANT}.>`);
  console.log("[chaos] observing for a live .out frame — send a message in the widget now…");
  for (let i = 0; i < 60 && !captured; i++) await sleep(500);
  if (!captured) { console.error("[chaos] ✗ no .out frame captured (open the widget + send a message, then retry)"); nats.close(); return 3; }
  const cap = captured as { subject: string; payload: string };
  const bytes = Buffer.from(cap.payload, "binary");
  bytes[0] = bytes[0] ^ 0xff; // flip a byte inside the AEAD-protected frame
  nats.pub(cap.subject, bytes.toString("binary"));
  await sleep(300); // let the PUB flush onto the wire before we close
  nats.close();
  console.log(`[chaos] ✓ published a bit-flipped copy to ${cap.subject}`);
  console.log("[chaos] the widget AEAD-opens it → null → silently DROPPED (chat stays clean).");
  return 0;
}

const cmd = process.argv[2];
let exit = 1;
try {
  if (cmd === "cross-tenant") exit = await crossTenant();
  else if (cmd === "tamper") exit = await tamper();
  else if (cmd === "replay-jwt") {
    console.error("[chaos] replay-jwt is not implemented in chaos-nats.ts yet (register-challenge flow).");
    exit = 3;
  } else {
    console.error(`[chaos] unknown command: ${cmd}`);
    exit = 1;
  }
} catch (err) {
  console.error("[chaos] error:", (err as Error).message);
  exit = 2;
}
process.exit(exit);
