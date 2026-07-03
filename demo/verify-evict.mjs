#!/usr/bin/env node
/**
 * Phase 5 aside #1b driver — JWKS key EVICTION revokes an old kid.
 *
 * The register hop verifies the bootstrap JWT (kid → JWKS) BEFORE the PoP gate
 * (index-nats.ts). So a register with a valid kid but no PoP proof returns
 * "Missing proof-of-possession" (JWT accepted), while a register under an
 * unknown/evicted kid returns "Invalid JWT" (JWT rejected). We use that
 * difference to prove eviction WITHOUT running the full PoP flow.
 *
 * Flow (fetch-only, no browser):
 *  1. Mint bootstrap JWT_A (kid A) as alice; register it → "Missing proof-of-
 *     possession" ⇒ A is accepted (and now cached at the gateway).
 *  2. admin rotate + EVICT ⇒ served JWKS = [B] only.
 *  3. Mint JWT_B (kid B); register it → "Missing proof-of-possession" ⇒ B works
 *     AND the gateway's JWKS cache refetches to [B] (flushing A).
 *  4. Replay JWT_A → "Invalid JWT" ⇒ the evicted kid is now rejected.
 *
 * Not part of CI — a local smoke for the demo during development.
 */
import { webcrypto as crypto } from "node:crypto";

const URL = process.env.DEMO_URL ?? "http://127.0.0.1:3961";
const ACCOUNT = process.env.DEMO_ACCOUNT ?? "agent-dev";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

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
  return data; // { jwt, peerId, registerBaseUrl }
}

// Register with a JWT and NO PoP proof. Returns the response body text so the
// caller can distinguish "Invalid JWT" (rejected) from "Missing proof-of-
// possession" (JWT accepted, PoP absent).
async function registerNoPoP(registerBaseUrl, jwt) {
  const r = await fetch(`${registerBaseUrl}/webchannel/nats/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: "{}",
  });
  return { status: r.status, body: (await r.text()).trim() };
}

let code = 1;
try {
  const adminCookie = await login("admin");
  const aliceCookie = await login("alice");

  const before = await (await fetch(`${URL}/admin/signing-key`, { headers: { cookie: adminCookie } })).json();
  console.log(`[evict] start: activeKid=${before.activeKid?.slice(0, 8)} jwks=[${before.jwksKids.map((k) => k.slice(0, 8))}]`);

  // 1. JWT_A under the current kid; register (no PoP) → JWT accepted.
  const bootA = await bootstrap(aliceCookie, await deviceKeys());
  const regUrl = bootA.registerBaseUrl;
  const a1 = await registerNoPoP(regUrl, bootA.jwt);
  const acceptedBefore = a1.body.includes("Missing proof-of-possession");
  console.log(`[evict] JWT_A before evict → ${a1.status} "${a1.body}" (accepted=${acceptedBefore})`);

  // 2. rotate + evict.
  const rot = await (await fetch(`${URL}/admin/rotate-key`, {
    method: "POST",
    headers: { cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ evictPrevious: true }),
  })).json();
  console.log(`[evict] rotate+evict → activeKid=${rot.kid?.slice(0, 8)} jwks=[${rot.jwksKids.map((k) => k.slice(0, 8))}] (old-gone=${!rot.jwksKids.includes(before.activeKid)})`);

  // 3. JWT_B under the new kid; register (no PoP) → JWT accepted, cache flushes to [B].
  const bootB = await bootstrap(aliceCookie, await deviceKeys());
  const b1 = await registerNoPoP(regUrl, bootB.jwt);
  const newWorks = b1.body.includes("Missing proof-of-possession");
  console.log(`[evict] JWT_B after evict → ${b1.status} "${b1.body}" (new-kid-works=${newWorks})`);

  // 4. Replay JWT_A → now rejected at the JWT layer.
  const a2 = await registerNoPoP(regUrl, bootA.jwt);
  const rejectedAfter = a2.status === 401 && a2.body.includes("Invalid JWT");
  console.log(`[evict] JWT_A replayed after evict → ${a2.status} "${a2.body}" (rejected=${rejectedAfter})`);

  const pass = acceptedBefore && !rot.jwksKids.includes(before.activeKid) && newWorks && rejectedAfter;
  console.log(`[evict] result: accepted-before=${acceptedBefore ? "OK" : "FAIL"} new-kid-works=${newWorks ? "OK" : "FAIL"} evicted-kid-rejected=${rejectedAfter ? "OK" : "FAIL"}`);
  code = pass ? 0 : 3;
} catch (err) {
  console.error("[evict] FAIL:", err?.message ?? err);
  code = 2;
}
process.exit(code);
