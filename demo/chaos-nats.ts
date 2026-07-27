/**
 * Chaos scene ③ raw NATS/register manipulations (run via chaos.sh).
 *
 *   cross-tenant   mint tenant-b creds, subscribe tenant-a's subtree → the relay
 *                  answers -ERR Permissions Violation (tenant ISOLATION).
 *   tamper         capture a live ciphertext .out frame with observer creds,
 *                  bit-flip it, republish → the widget AEAD-drops it (INTEGRITY).
 *   replay-jwt     drive the register hop over NATS request/reply, then REPLAY
 *                  the same nonce+signature → the burned nonce is rejected with
 *                  the generic `unauthorized` (single-use nonce; NO oracle).
 *
 * Uses a MINIMAL raw NATS-over-WebSocket client (NKEY challenge-response reusing
 * the production nats-nkey-browser signing), because the production NatsClient
 * only surfaces TERMINAL -ERR via onError — a per-subject "Permissions Violation"
 * is non-terminal and never reaches a callback, so we read raw protocol lines.
 * The same raw client's `request()` drives the register hop's challenge/register
 * request/reply (the register HTTP route is gone).
 */
import { importEd25519SeedKey, signNonce } from "../packages/client/src/nats-nkey-browser.js";
import {
  generateDevicePopKeyPair,
  signPop,
  generateClientNonce,
} from "../packages/client/src/pop-register.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "../packages/client/src/protocol.js";

const SAAS_URL = process.env.SAAS_URL || "http://127.0.0.1:3961";
const TENANT = process.env.DEMO_TENANT || "demo-tenant";
const ACCOUNT = process.env.DEMO_ACCOUNT || "agent-dev";

function b64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Creds = { userJwt: string; userSeedRaw: string; natsUrl: string };
type RawNats = {
  sub: (subject: string) => void;
  pub: (subject: string, payload: string) => void;
  /**
   * NATS request/reply: SUB a fresh in-namespace reply inbox (derived from
   * `replyPrefix`, covered by the tenant-wide creds — no `_INBOX` grant), PUB
   * `payload` to `subject` with that inbox as reply-to, and resolve with the
   * first reply payload (or reject on timeout). This is the raw analogue of the
   * production client's `NatsClient.request` — the register hop now rides it.
   */
  request: (subject: string, replyPrefix: string, payload: string, timeoutMs?: number) => Promise<string>;
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
    let sidCounter = 1;

    const rand = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");

    const api: RawNats = {
      sub: (s) => ws.send(`SUB ${s} 1\r\n`),
      pub: (s, p) => ws.send(`PUB ${s} ${Buffer.byteLength(p, "binary")}\r\n${p}\r\n`),
      request: (subject, replyPrefix, payload, timeoutMs = 5000) =>
        new Promise<string>((resolveReq, rejectReq) => {
          const replySubject = `${replyPrefix}.${rand()}`;
          const sid = ++sidCounter;
          let settled = false;
          const onReply = (subj: string, pl: string): void => {
            if (subj !== replySubject || settled) return;
            settled = true;
            clearTimeout(timer);
            msgHandlers.delete(onReply);
            ws.send(`UNSUB ${sid}\r\n`);
            resolveReq(pl);
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            msgHandlers.delete(onReply);
            ws.send(`UNSUB ${sid}\r\n`);
            rejectReq(new Error("request timeout"));
          }, timeoutMs);
          msgHandlers.add(onReply);
          ws.send(`SUB ${replySubject} ${sid}\r\n`);
          ws.send(
            `PUB ${subject} ${replySubject} ${Buffer.byteLength(payload, "binary")}\r\n${payload}\r\n`,
          );
        }),
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
  // Wire-position adversary: this scene captures ANOTHER peer's `.out` frame and
  // republishes a bit-flipped copy, modelling a tampering relay. That needs
  // tenant-wide read AND write, so it uses AGENT creds — browser creds are now
  // pinned to the caller's own peer subtree (per-peer scoping) and observer creds
  // are sub-only, so neither can write to a victim peer's `.out`. Tenant-wide agent
  // creds are OPERATOR-only: they come from the admin-gated /admin/nats-user route
  // (the browser-facing /nats-user no longer honors a body `role`), so this scene
  // authenticates as admin first (adminCookie above).
  const res = await fetch(`${SAAS_URL}/admin/nats-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ role: "agent" }),
  });
  if (!res.ok) throw new Error(`tamper mint failed: HTTP ${res.status}`);
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

/** b64url of raw bytes. */
function b64urlBytes(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(bytes).toString("base64url");
}

type RegisterReply = {
  nonce?: string;
  peerId?: string;
  registered?: boolean;
  error?: string;
  code?: number;
};

async function replayJwt(): Promise<number> {
  const cookie = await adminCookie();
  // Mint this-tenant browser creds so we can dial the relay and drive the register
  // hop over NATS request/reply (the register HTTP route is gone — admission now
  // rides `webchannel.{tenant}.{account}.{peer}.register`).
  const credRes = await fetch(`${SAAS_URL}/nats-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ role: "browser" }),
  });
  if (!credRes.ok) throw new Error(`nats-user mint failed: HTTP ${credRes.status}`);
  const creds = (await credRes.json()) as Creds;

  // Device keys: an X25519 (cnf.jwk) + an Ed25519 PoP pair the register hop proves.
  const x = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const deviceX25519PublicKey = b64urlBytes(await crypto.subtle.exportKey("raw", x.publicKey));
  const pop = await generateDevicePopKeyPair();

  // Session-gated bootstrap JWT (admin → agent-dev). peerId is server-derived.
  const bootRes = await fetch(`${SAAS_URL}/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ accountId: ACCOUNT, deviceX25519PublicKey, devicePopPublicKey: pop.publicJwk.x }),
  });
  if (!bootRes.ok) throw new Error(`bootstrap failed: HTTP ${bootRes.status}`);
  const { jwt, peerId } = (await bootRes.json()) as { jwt: string; peerId: string };

  const nats = await rawConnect(creds);
  const registerSubj = `webchannel.${TENANT}.${ACCOUNT}.${peerId}.register`;
  const replyPrefix = `webchannel.${TENANT}.${ACCOUNT}.${peerId}.reginbox`;
  const parse = (raw: string): RegisterReply => JSON.parse(raw) as RegisterReply;

  try {
    // 1. Get a single-use challenge nonce.
    const ch = parse(await nats.request(registerSubj, replyPrefix, JSON.stringify({ op: "challenge", token: jwt })));
    if (!ch.nonce) throw new Error(`challenge returned no nonce: ${JSON.stringify(ch)}`);
    // The proof is bound to the OP it authorizes, so this one cannot be
    // relabelled as an `unregister` (see plugin/src/pop-signed-message.ts).
    const signature = await signPop(pop.privateKey, "register", peerId, ch.nonce);
    const registerBody = JSON.stringify({
      op: "register",
      token: jwt,
      nonce: ch.nonce,
      signature,
      // Both fields are mandatory on the v3 register request. `protocolVersion`
      // was already required at v2 and its omission here was a pre-existing bug:
      // the agent answers 426 before PoP, so this scenario could never reach the
      // replay it means to test. `clientNonce` is the v3 freshness anchor; this
      // scenario deliberately reuses one value across both round-trips, since what
      // it exercises is the single-use PoP nonce, not the anchor.
      protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
      clientNonce: generateClientNonce(),
    });

    // 2. Register once with the valid proof — should succeed (burns the nonce).
    const r1 = parse(await nats.request(registerSubj, replyPrefix, registerBody));
    console.log(`[chaos] first register (valid proof) → ${JSON.stringify(r1)}`);
    // 3. Replay the SAME nonce+signature — the burned nonce must be rejected with
    //    the generic `unauthorized` (the reply is never an oracle).
    const r2 = parse(await nats.request(registerSubj, replyPrefix, registerBody));
    console.log(`[chaos] replayed register (same nonce+sig) → ${JSON.stringify(r2)}`);

    const firstOk = r1.registered === true && !r1.error;
    const replayRejected = r2.error === "unauthorized" || r2.code === 401;
    if (firstOk && replayRejected) {
      console.log("[chaos] ✓ replay defeated: the nonce is single-use (burned on first use).");
      return 0;
    }
    console.error(
      `[chaos] ✗ expected first=registered + replay=unauthorized, got ${JSON.stringify(r1)} / ${JSON.stringify(r2)}`,
    );
    return 3;
  } finally {
    nats.close();
  }
}

const cmd = process.argv[2];
let exit = 1;
try {
  if (cmd === "cross-tenant") exit = await crossTenant();
  else if (cmd === "tamper") exit = await tamper();
  else if (cmd === "replay-jwt") exit = await replayJwt();
  else {
    console.error(`[chaos] unknown command: ${cmd}`);
    exit = 1;
  }
} catch (err) {
  console.error("[chaos] error:", (err as Error).message);
  exit = 2;
}
process.exit(exit);
