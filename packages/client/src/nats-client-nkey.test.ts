/**
 * Production NATS client — NATS-layer NKEY challenge-response auth tests (#21).
 *
 * Proves the new `natsCredentials` path:
 *   - With NKEY creds: CONNECT is DEFERRED to the server's INFO line, carries the
 *     user JWT + an Ed25519 `sig` over the INFO nonce, and that signature
 *     verifies against the seed's public key.
 *   - WITHOUT NKEY creds (zero-regression): CONNECT is sent on ws-open with the
 *     bootstrap `jwt` and NO `sig`, and the client connects even if the server
 *     never sends INFO (proving the CONNECT was not deferred).
 *
 * Node ≥18 exposes crypto.subtle with Ed25519, so the real sign/verify runs here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NatsClient } from "./nats-client.js";
import { base64urlEncode, base64urlDecode } from "./e2e-crypto-browser.js";

// ---------------------------------------------------------------------------
// Fake JWT-auth nats-server: greets with INFO+nonce, captures CONNECT, PONGs.
// ---------------------------------------------------------------------------

class FakeJwtNatsWS {
  static instances: FakeJwtNatsWS[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Toggle whether the server emits an INFO line after open. */
  static sendInfo = true;
  /** Nonce embedded in the INFO greeting. */
  static nonce = "server-nonce-abc123";

  url: string;
  binaryType = "blob";
  readyState: number = FakeJwtNatsWS.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  /** Parsed CONNECT payload(s) the client sent, in order. */
  readonly connects: Array<Record<string, unknown>> = [];

  constructor(url: string) {
    this.url = url;
    FakeJwtNatsWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeJwtNatsWS.OPEN;
      this.onopen?.();
      if (FakeJwtNatsWS.sendInfo) {
        this.emit(`INFO {"server_id":"FAKE","nonce":"${FakeJwtNatsWS.nonce}"}\r\n`);
      }
    });
  }

  send(data: string): void {
    if (data.startsWith("CONNECT")) {
      this.connects.push(JSON.parse(data.slice("CONNECT".length).trim()));
      return;
    }
    if (data.startsWith("PING")) {
      this.emit("PONG\r\n");
      return;
    }
    // SUB/PUB/PONG/UNSUB — irrelevant to this test.
  }

  close(): void {
    this.readyState = FakeJwtNatsWS.CLOSED;
    this.onclose?.();
  }

  private emit(frame: string): void {
    this.onmessage?.({ data: frame });
  }
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

let originalWebSocket: unknown;

beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeJwtNatsWS;
  FakeJwtNatsWS.instances = [];
  FakeJwtNatsWS.sendInfo = true;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

/** Generate an Ed25519 keypair and return the raw-seed (b64url) + public key. */
async function makeUserCreds(): Promise<{ userSeedRaw: string; publicKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // PKCS#8 for Ed25519 is 48 bytes: 16-byte header + 32-byte raw seed.
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const rawSeed = pkcs8.slice(16);
  return { userSeedRaw: base64urlEncode(rawSeed), publicKey: kp.publicKey };
}

describe("NatsClient — NKEY-auth CONNECT (natsCredentials present)", () => {
  it("defers CONNECT to INFO and signs the nonce with a verifiable Ed25519 sig", async () => {
    const { userSeedRaw, publicKey } = await makeUserCreds();
    const userJwt = "fake.user.jwt";

    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: "bootstrap-jwt-should-not-be-used",
      agentId: "a",
      tenant: "t",
      peerId: "p",
      natsCredentials: { userJwt, userSeedRaw },
    });
    let connected = false;
    client.onState((c) => { connected = c; });
    client.connect();
    await settle();

    const server = FakeJwtNatsWS.instances.at(-1)!;
    expect(server.connects.length).toBe(1);
    const connect = server.connects[0];

    // CONNECT carries the USER jwt (not the bootstrap jwt) and a sig.
    expect(connect["jwt"]).toBe(userJwt);
    expect(typeof connect["sig"]).toBe("string");

    // The sig must verify against the seed's public key over the INFO nonce.
    const sigBytes = new Uint8Array(base64urlDecode(connect["sig"] as string));
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      sigBytes,
      new Uint8Array(new TextEncoder().encode(FakeJwtNatsWS.nonce)),
    );
    expect(ok).toBe(true);

    // PONG (after our PING) flips us to connected.
    expect(connected).toBe(true);
    client.disconnect();
  });
});

describe("NatsClient — no-natsCredentials path is unchanged (zero regression)", () => {
  it("sends CONNECT on ws-open with the bootstrap jwt and NO sig — even without INFO", async () => {
    // Server emits NO INFO: if the client (wrongly) deferred CONNECT to INFO, it
    // would never connect. The original path sends CONNECT on open, so it must.
    FakeJwtNatsWS.sendInfo = false;

    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: "bootstrap-jwt-value",
      agentId: "a",
      tenant: "t",
      peerId: "p",
    });
    let connected = false;
    client.onState((c) => { connected = c; });
    client.connect();
    await settle();

    const server = FakeJwtNatsWS.instances.at(-1)!;
    expect(server.connects.length).toBe(1);
    const connect = server.connects[0];
    expect(connect["jwt"]).toBe("bootstrap-jwt-value");
    expect(connect["sig"]).toBeUndefined();
    expect(connected).toBe(true);
    client.disconnect();
  });
});
