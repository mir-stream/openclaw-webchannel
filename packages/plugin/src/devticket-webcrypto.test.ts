import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";

import { verifyTicket } from "./ticket.js";

/**
 * Cross-runtime compatibility guard for the PoC browser ticket issuer
 * (webchannel/widget/src/example/devTicket.ts). That issuer signs HS256 tickets with
 * the Web Crypto API (`crypto.subtle`); the server verifies them with
 * `node:crypto`. This test reproduces the exact Web Crypto signing path (here
 * via node:crypto's WebCrypto implementation, the same API surface the browser
 * uses) and asserts the resulting token is accepted by `verifyTicket` — proving
 * the two runtimes agree on algorithm and base64url encoding.
 */

const SECRET = "poc-shared-secret";
const encoder = new TextEncoder();

function base64Url(input: string | Uint8Array): string {
  const buf =
    typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64url");
}

/** Mirror of devTicket.ts issueDevTicket, using WebCrypto subtle (browser API). */
async function issueViaWebCrypto(
  secret: string,
  sub: string,
  ttlSeconds = 60,
  iat = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ sub, iat, exp: iat + ttlSeconds }));
  const signingInput = `${header}.${payload}`;
  const key = await webcrypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await webcrypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(sig))}`;
}

describe("browser-issued (WebCrypto) ticket ↔ server verifyTicket", () => {
  it("a WebCrypto-signed HS256 ticket verifies on the server", async () => {
    const token = await issueViaWebCrypto(SECRET, "poc-user");
    expect(verifyTicket(token, SECRET)).toEqual({ sub: "poc-user" });
  });

  it("rejects when the server secret differs", async () => {
    const token = await issueViaWebCrypto(SECRET, "poc-user");
    expect(verifyTicket(token, "other-secret")).toBeNull();
  });

  it("rejects an expired WebCrypto ticket", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await issueViaWebCrypto(SECRET, "poc-user", 60, past);
    expect(verifyTicket(token, SECRET)).toBeNull();
  });
});
