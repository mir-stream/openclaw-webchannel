#!/usr/bin/env node
/**
 * Phase 5 aside #1b driver — JWKS key EVICTION revokes an old kid.
 *
 * The register hop verifies the bootstrap JWT (kid → JWKS) at the AGENT. That
 * verification runs on the register subject's `challenge` op BEFORE any PoP work:
 * a valid kid replies `{nonce}` (JWT accepted), an unknown/evicted kid replies
 * the generic `{error:"unauthorized"}` (JWT rejected). The register REPLY is
 * deliberately not an oracle (bad-JWT and missing-PoP both collapse to the same
 * `unauthorized`), so we use the CHALLENGE op as the JWT-acceptance probe — no
 * PoP needed.
 *
 * Flow (no browser — a raw NKEY-authenticated NATS request/reply client):
 *  1. Mint bootstrap JWT_A (kid A) as alice; `challenge` with it → `{nonce}` ⇒ A
 *     is accepted (and now cached at the agent).
 *  2. admin rotate + EVICT ⇒ served JWKS = [B] only.
 *  3. Mint JWT_B (kid B); `challenge` with it → `{nonce}` ⇒ B works AND the
 *     agent's JWKS cache refetches to [B] (flushing A).
 *  4. Replay JWT_A → `{error:"unauthorized"}` ⇒ the evicted kid is now rejected.
 *
 * Requires the live demo agent (it verifies the JWT against the SaaS JWKS).
 * Not part of CI — a local smoke for the demo during development.
 */
import { webcrypto as crypto } from "node:crypto";

const URL = process.env.DEMO_URL ?? "http://127.0.0.1:3961";
const ACCOUNT = process.env.DEMO_ACCOUNT ?? "agent-dev";
const TENANT = process.env.DEMO_TENANT ?? "demo-tenant";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const b64urlDecode = (s) => new Uint8Array(Buffer.from(s, "base64url"));

// --- NATS NKEY signing (inline mirror of packages/client nats-nkey-browser) ---
async function importEd25519SeedKey(rawSeed) {
  const header = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(header.length + rawSeed.length);
  pkcs8.set(header, 0);
  pkcs8.set(rawSeed, header.length);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}
async function signNonce(privateKey, nonce) {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(nonce));
  return b64url(new Uint8Array(sig));
}

/**
 * Minimal raw NATS-over-WebSocket client with NKEY challenge-response + a
 * request/reply seam (the register hop rides `webchannel.{tenant}.{account}.
 * {peer}.register`). Mirrors demo/chaos-nats.ts's rawConnect.
 */
function rawConnect(creds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(creds.natsUrl);
    let buf = "";
    let connectSent = false;
    let ready = false;
    let sidCounter = 1;
    const msgHandlers = new Set();
    const rand = () => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");

    const api = {
      request: (subject, replyPrefix, payload, timeoutMs = 5000) =>
        new Promise((res, rej) => {
          const replySubject = `${replyPrefix}.${rand()}`;
          const sid = ++sidCounter;
          let settled = false;
          const onReply = (subj, pl) => {
            if (subj !== replySubject || settled) return;
            settled = true;
            clearTimeout(timer);
            msgHandlers.delete(onReply);
            ws.send(`UNSUB ${sid}\r\n`);
            res(pl);
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            msgHandlers.delete(onReply);
            ws.send(`UNSUB ${sid}\r\n`);
            rej(new Error("request timeout"));
          }, timeoutMs);
          msgHandlers.add(onReply);
          ws.send(`SUB ${replySubject} ${sid}\r\n`);
          ws.send(`PUB ${subject} ${replySubject} ${Buffer.byteLength(payload, "binary")}\r\n${payload}\r\n`);
        }),
      close: () => ws.close(),
    };

    ws.binaryType = "arraybuffer";
    ws.onerror = () => reject(new Error("ws error"));
    ws.onclose = () => { if (!ready) reject(new Error("closed before ready")); };
    ws.onmessage = async (ev) => {
      buf += typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("binary");
      let pos;
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
            try { nonce = JSON.parse(line.slice(5)).nonce ?? ""; } catch { /* */ }
            let sig = "";
            if (nonce) sig = await signNonce(await importEd25519SeedKey(b64urlDecode(creds.userSeedRaw)), nonce);
            const payload = {
              verbose: false, pedantic: false, lang: "ts", version: "1", protocol: 1, echo: false, jwt: creds.userJwt,
            };
            if (sig) payload.sig = sig;
            ws.send(`CONNECT ${JSON.stringify(payload)}\r\n`);
            ws.send("PING\r\n");
          }
          continue;
        }
        if (line === "PONG") { if (!ready) { ready = true; resolve(api); } continue; }
        // +OK / -ERR lines are ignored (per-subject errors are non-fatal here).
      }
    };
  });
}

async function login(username) {
  const r = await fetch(`${URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "demo" }),
  });
  if (!r.ok) throw new Error(`${username} login failed HTTP ${r.status}`);
  const sid = (r.headers.get("set-cookie") ?? "").match(/sid=([^;]+)/)?.[1];
  if (!sid) throw new Error(`${username} login returned no sid`);
  return `sid=${sid}`;
}

async function natsUser(cookie) {
  const r = await fetch(`${URL}/nats-user`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "browser" }),
  });
  const data = await r.json();
  if (!r.ok || !data.userJwt || !data.userSeedRaw || !data.natsUrl) {
    throw new Error(`nats-user mint failed HTTP ${r.status} ${JSON.stringify(data)}`);
  }
  return data; // { userJwt, userSeedRaw, natsUrl }
}

async function deviceKeys() {
  const x = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const deviceX25519PublicKey = b64url(await crypto.subtle.exportKey("raw", x.publicKey));
  const ed = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", ed.publicKey);
  return { deviceX25519PublicKey, devicePopPublicKey: jwk.x };
}

async function bootstrap(cookie, keys) {
  const r = await fetch(`${URL}/bootstrap`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: ACCOUNT, ...keys }),
  });
  const data = await r.json();
  if (!r.ok || !data.jwt) throw new Error(`bootstrap failed HTTP ${r.status} ${JSON.stringify(data)}`);
  return data; // { jwt, peerId }
}

// Probe the register hop's `challenge` op: a valid-kid JWT replies `{nonce}`
// (accepted); an evicted/unknown kid replies `{error:"unauthorized"}` (rejected).
async function challengeAccepted(nats, peerId, jwt) {
  const subject = `webchannel.${TENANT}.${ACCOUNT}.${peerId}.register`;
  const replyPrefix = `webchannel.${TENANT}.${ACCOUNT}.${peerId}.reginbox`;
  const reply = JSON.parse(await nats.request(subject, replyPrefix, JSON.stringify({ op: "challenge", token: jwt })));
  return { accepted: typeof reply.nonce === "string" && reply.nonce.length > 0, reply };
}

let code = 1;
let nats;
try {
  const adminCookie = await login("admin");
  const aliceCookie = await login("alice");
  nats = await rawConnect(await natsUser(aliceCookie));

  const before = await (await fetch(`${URL}/admin/signing-key`, { headers: { cookie: adminCookie } })).json();
  console.log(`[evict] start: activeKid=${before.activeKid?.slice(0, 8)} jwks=[${before.jwksKids.map((k) => k.slice(0, 8))}]`);

  // 1. JWT_A under the current kid; challenge → JWT accepted.
  const bootA = await bootstrap(aliceCookie, await deviceKeys());
  const a1 = await challengeAccepted(nats, bootA.peerId, bootA.jwt);
  console.log(`[evict] JWT_A before evict → ${JSON.stringify(a1.reply)} (accepted=${a1.accepted})`);

  // 2. rotate + evict.
  const rot = await (await fetch(`${URL}/admin/rotate-key`, {
    method: "POST",
    headers: { cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ evictPrevious: true }),
  })).json();
  console.log(`[evict] rotate+evict → activeKid=${rot.kid?.slice(0, 8)} jwks=[${rot.jwksKids.map((k) => k.slice(0, 8))}] (old-gone=${!rot.jwksKids.includes(before.activeKid)})`);

  // 3. JWT_B under the new kid; challenge → JWT accepted, agent JWKS cache flushes to [B].
  const bootB = await bootstrap(aliceCookie, await deviceKeys());
  const b1 = await challengeAccepted(nats, bootB.peerId, bootB.jwt);
  console.log(`[evict] JWT_B after evict → ${JSON.stringify(b1.reply)} (new-kid-works=${b1.accepted})`);

  // 4. Replay JWT_A → now rejected at the JWT layer (generic unauthorized).
  const a2 = await challengeAccepted(nats, bootA.peerId, bootA.jwt);
  const rejectedAfter = !a2.accepted && (a2.reply.error === "unauthorized" || a2.reply.code === 401);
  console.log(`[evict] JWT_A replayed after evict → ${JSON.stringify(a2.reply)} (rejected=${rejectedAfter})`);

  const pass = a1.accepted && !rot.jwksKids.includes(before.activeKid) && b1.accepted && rejectedAfter;
  console.log(`[evict] result: accepted-before=${a1.accepted ? "OK" : "FAIL"} new-kid-works=${b1.accepted ? "OK" : "FAIL"} evicted-kid-rejected=${rejectedAfter ? "OK" : "FAIL"}`);
  code = pass ? 0 : 3;
} catch (err) {
  console.error("[evict] FAIL:", err?.message ?? err);
  code = 2;
} finally {
  nats?.close();
}
process.exit(code);
