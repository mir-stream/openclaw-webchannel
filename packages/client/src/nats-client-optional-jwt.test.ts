/**
 * Browser NatsClient — optional bootstrap `jwt` tests.
 *
 * The bootstrap JWT is now optional: it is only needed for the SaaS register-hop
 * path. When connecting to a bring-your-own-NATS with `natsCredentials` and NO
 * `registration`, no bootstrap JWT is required — the client connects using only
 * the NATS user creds + url. This asserts:
 *   1. With `natsCredentials` and NO `jwt`: the client connects (deferred CONNECT
 *      carries the USER jwt, never the absent bootstrap jwt).
 *   2. No `jwt` on the plain (no-creds) path: CONNECT omits the `jwt` field
 *      entirely (no `"jwt":undefined`/`null` leaks onto the wire).
 *   3. With `jwt` present (unchanged): CONNECT still carries it byte-for-byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NatsClient, WebChannelNatsClient } from "./nats-client.js";
import { base64urlEncode } from "./e2e-crypto-browser.js";

class FakeNatsWS {
  static instances: FakeNatsWS[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static sendInfo = true;
  static nonce = "nonce-xyz";

  url: string;
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly connects: Array<Record<string, unknown>> = [];
  readonly rawConnects: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeNatsWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeNatsWS.OPEN;
      this.onopen?.();
      if (FakeNatsWS.sendInfo) {
        this.onmessage?.({ data: `INFO {"server_id":"F","nonce":"${FakeNatsWS.nonce}"}\r\n` });
      }
    });
  }

  send(data: string): void {
    if (data.startsWith("CONNECT")) {
      this.rawConnects.push(data);
      this.connects.push(JSON.parse(data.slice("CONNECT".length).trim()));
      return;
    }
    if (data.startsWith("PING")) {
      this.onmessage?.({ data: "PONG\r\n" });
    }
  }

  close(): void {
    this.readyState = FakeNatsWS.CLOSED;
    this.onclose?.();
  }
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

let originalWebSocket: unknown;

beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeNatsWS;
  FakeNatsWS.instances = [];
  FakeNatsWS.sendInfo = true;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

async function makeUserSeedRaw(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return base64urlEncode(pkcs8.slice(16));
}

describe("NatsClient — optional bootstrap jwt", () => {
  it("connects with natsCredentials and NO bootstrap jwt", async () => {
    const userSeedRaw = await makeUserSeedRaw();
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      // No `jwt` field at all — BYO-NATS.
      natsCredentials: { userJwt: "user-jwt", userSeedRaw },
    });
    let connected = false;
    client.onState((c) => { connected = c; });
    client.connect();
    await settle();

    const server = FakeNatsWS.instances.at(-1)!;
    expect(server.connects.length).toBe(1);
    expect(server.connects[0]["jwt"]).toBe("user-jwt"); // user jwt, not bootstrap
    expect(typeof server.connects[0]["sig"]).toBe("string");
    expect(connected).toBe(true);
    client.disconnect();
  });

  it("omits the jwt field on the plain path when no bootstrap jwt is given", async () => {
    FakeNatsWS.sendInfo = false; // no NKEY auth → CONNECT on open
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      // No `jwt`, no `natsCredentials`.
    });
    let connected = false;
    client.onState((c) => { connected = c; });
    client.connect();
    await settle();

    const server = FakeNatsWS.instances.at(-1)!;
    expect(server.connects.length).toBe(1);
    expect("jwt" in server.connects[0]).toBe(false);
    // Belt-and-suspenders: no literal undefined/null leaked onto the wire.
    expect(server.rawConnects[0]).not.toContain("jwt");
    expect(connected).toBe(true);
    client.disconnect();
  });

  it("still carries the bootstrap jwt unchanged when provided (no regression)", async () => {
    FakeNatsWS.sendInfo = false;
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: "bootstrap-jwt",
      accountId: "a",
      tenant: "t",
      peerId: "p",
    });
    client.connect();
    await settle();
    const server = FakeNatsWS.instances.at(-1)!;
    expect(server.connects[0]["jwt"]).toBe("bootstrap-jwt");
    client.disconnect();
  });
});

describe("WebChannelNatsClient — registration without a bootstrap jwt", () => {
  it("fires the error callback and does NOT proceed to the PoP register hop", async () => {
    FakeNatsWS.sendInfo = false; // plain path: CONNECT on ws-open, PONG → connected.
    // The guard rejects before devicePrivateKey is ever used, but the type wants a
    // real CryptoKey, so mint a throwaway Ed25519 key.
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    // fetchImpl is the only path to the register hop — assert it is never called.
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));

    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      // NO bootstrap `jwt`, but `registration` is present → guard must trip.
      registration: {
        registerBaseUrl: "http://localhost:9999",
        devicePrivateKey: kp.privateKey,
        fetchImpl: fetchSpy as unknown as typeof fetch,
      },
    });

    let captured: Error | null = null;
    client.onError((e) => { captured = e; });
    let lastState = true;
    client.onState((c) => { lastState = c; });

    client.connect();
    await settle();

    expect(captured).toBeInstanceOf(Error);
    expect((captured as unknown as Error).message).toMatch(/registration requires a bootstrap/i);
    // Did NOT proceed to the register hop…
    expect(fetchSpy).not.toHaveBeenCalled();
    // …and tore the connection down (fail-closed).
    expect(lastState).toBe(false);

    client.disconnect();
  });
});
