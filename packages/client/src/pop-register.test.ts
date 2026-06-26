/**
 * PoP producer ↔ consumer interop tests.
 *
 * The fake plugin server verifies the device's signature with node:crypto
 * EXACTLY as the real plugin does (`pop-challenge.ts` →
 * `edVerify(null, popSignedMessage(peerId, nonce), pubFromJwk, sig)`), so a green
 * `registerWithPop` here proves the browser producer satisfies the real verifier.
 */

import { describe, it, expect } from "vitest";
import { createPublicKey, verify as edVerify } from "node:crypto";

import {
  generateDevicePopKeyPair,
  popSignedMessage,
  signPop,
  registerWithPop,
  PopRejectedError,
  type DevicePopJwk,
} from "./pop-register.js";

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Faithful replica of the plugin's register routes: issues a single-use nonce,
 * then verifies the Ed25519 signature over `webchannel-pop:<peerId>:<nonce>`
 * against `serverPopJwk` — the same check `PopChallengeStore.verify` runs.
 */
function makeFakePlugin(opts: { peerId: string; serverPopJwk: DevicePopJwk }) {
  let issuedNonce: string | null = null;
  const calls = { challenge: 0, register: 0 };
  const seen: { authHeader?: string; body?: { nonce?: string; signature?: string } } = {};

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];

    if (u.endsWith("/webchannel/nats/register/challenge")) {
      calls.challenge++;
      seen.authHeader = auth;
      issuedNonce = `nonce-${calls.challenge}-${Buffer.from([calls.challenge, 7, 42]).toString("hex")}`;
      return jsonResponse({ nonce: issuedNonce });
    }

    if (u.endsWith("/webchannel/nats/register")) {
      calls.register++;
      const body = JSON.parse(String(init?.body)) as { nonce?: string; signature?: string };
      seen.body = body;
      // single-use nonce
      if (!issuedNonce || body.nonce !== issuedNonce) return new Response("", { status: 401 });
      const nonce = issuedNonce;
      issuedNonce = null;
      const pub = createPublicKey({ key: opts.serverPopJwk, format: "jwk" });
      const ok = edVerify(
        null,
        Buffer.from(popSignedMessage(opts.peerId, nonce), "utf8"),
        pub,
        Buffer.from(String(body.signature), "base64url"),
      );
      return ok ? jsonResponse({ peerId: opts.peerId, registered: true }) : new Response("", { status: 401 });
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, seen };
}

const PEER = "user-42";
const BASE = "http://127.0.0.1:18789";

describe("registerWithPop (producer ↔ consumer interop)", () => {
  it("registers when the device signs with the key pinned in pop_jwk", async () => {
    const device = await generateDevicePopKeyPair();
    const plugin = makeFakePlugin({ peerId: PEER, serverPopJwk: device.publicJwk });

    const result = await registerWithPop({
      registerBaseUrl: BASE,
      jwt: "bootstrap.jwt.token",
      peerId: PEER,
      devicePrivateKey: device.privateKey,
      fetchImpl: plugin.fetchImpl,
    });

    expect(result).toEqual({ peerId: PEER, registered: true });
    expect(plugin.calls).toEqual({ challenge: 1, register: 1 });
    expect(plugin.seen.authHeader).toBe("Bearer bootstrap.jwt.token");
    expect(typeof plugin.seen.body?.signature).toBe("string");
  });

  it("is rejected (401 → PopRejectedError) when signing with the wrong device key", async () => {
    const pinned = await generateDevicePopKeyPair();
    const attacker = await generateDevicePopKeyPair();
    // Server pins `pinned`'s public key, but the caller signs with `attacker`.
    const plugin = makeFakePlugin({ peerId: PEER, serverPopJwk: pinned.publicJwk });

    await expect(
      registerWithPop({
        registerBaseUrl: BASE,
        jwt: "jwt",
        peerId: PEER,
        devicePrivateKey: attacker.privateKey,
        fetchImpl: plugin.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(PopRejectedError);
  });

  it("throws when the challenge endpoint fails", async () => {
    const device = await generateDevicePopKeyPair();
    const failingFetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(
      registerWithPop({
        registerBaseUrl: BASE,
        jwt: "jwt",
        peerId: PEER,
        devicePrivateKey: device.privateKey,
        fetchImpl: failingFetch,
      }),
    ).rejects.toThrow(/challenge failed/);
  });

  it("strips a trailing slash from the base URL", async () => {
    const device = await generateDevicePopKeyPair();
    const seenUrls: string[] = [];
    const plugin = makeFakePlugin({ peerId: PEER, serverPopJwk: device.publicJwk });
    const wrapped = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrls.push(String(url));
      return plugin.fetchImpl(url as RequestInfo, init);
    }) as unknown as typeof fetch;

    await registerWithPop({
      registerBaseUrl: `${BASE}/`,
      jwt: "jwt",
      peerId: PEER,
      devicePrivateKey: device.privateKey,
      fetchImpl: wrapped,
    });
    expect(seenUrls).toContain(`${BASE}/webchannel/nats/register/challenge`);
    expect(seenUrls).toContain(`${BASE}/webchannel/nats/register`);
  });
});

describe("PoP spec conformance (must match plugin pop-challenge.ts)", () => {
  it("signs the bound message `webchannel-pop:<peerId>:<nonce>`", () => {
    expect(popSignedMessage("p", "n")).toBe("webchannel-pop:p:n");
  });

  it("produces an Ed25519 signature verifiable over the bound message", async () => {
    const device = await generateDevicePopKeyPair();
    const sig = await signPop(device.privateKey, PEER, "the-nonce");
    const pub = createPublicKey({ key: device.publicJwk, format: "jwk" });
    const ok = edVerify(
      null,
      Buffer.from(popSignedMessage(PEER, "the-nonce"), "utf8"),
      pub,
      Buffer.from(sig, "base64url"),
    );
    expect(ok).toBe(true);

    // A signature over a different nonce must NOT verify (replay/tamper guard).
    const bad = edVerify(
      null,
      Buffer.from(popSignedMessage(PEER, "other-nonce"), "utf8"),
      pub,
      Buffer.from(sig, "base64url"),
    );
    expect(bad).toBe(false);
  });

  it("exports an OKP/Ed25519 public JWK with a 32-byte x", async () => {
    const device = await generateDevicePopKeyPair();
    expect(device.publicJwk.kty).toBe("OKP");
    expect(device.publicJwk.crv).toBe("Ed25519");
    expect(Buffer.from(device.publicJwk.x, "base64url").length).toBe(32);
  });
});
