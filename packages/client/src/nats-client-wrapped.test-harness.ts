import {
  createCipheriv, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes,
} from "node:crypto";
import { WebChannelNatsClient, registerSubject } from "./nats-client.js";
import type { ProtocolInfo } from "./nats-client.js";
import type { WrappedConversationKey } from "./e2e-crypto-browser.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";
import { generateDevicePopKeyPair } from "./pop-register.js";

export const TENANT = "acme";
export const AGENT = "agent-1";
export const PEER = "user-42";
export const JWT = "bootstrap.jwt.token";

export type ServerHandler = (
  subject: string, payload: string, server: FakeNatsWS, replyTo?: string,
) => void | Promise<void>;

export class FakeNatsWS {
  static instances: FakeNatsWS[] = [];
  static sharedHandler: ServerHandler = () => {};
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly published: Array<{ subject: string; payload: string; replyTo?: string }> = [];
  private readonly subs = new Map<string, number>();
  handler: ServerHandler;
  constructor(readonly url: string) {
    this.handler = FakeNatsWS.sharedHandler;
    FakeNatsWS.instances.push(this);
    queueMicrotask(() => { this.readyState = FakeNatsWS.OPEN; this.onopen?.(); });
  }
  send(data: string): void {
    if (data.startsWith("CONNECT")) return;
    if (data.startsWith("PING")) { this.emit("PONG\r\n"); return; }
    if (data.startsWith("PONG")) return;
    if (data.startsWith("SUB ")) {
      const [, subject, sid] = data.trim().split(" ");
      this.subs.set(subject, Number(sid)); return;
    }
    if (data.startsWith("UNSUB ")) {
      const sid = Number(data.trim().split(" ")[1]);
      for (const [subject, id] of this.subs) if (id === sid) this.subs.delete(subject);
      return;
    }
    if (data.startsWith("PUB ")) {
      const split = data.indexOf("\r\n");
      const header = data.slice(0, split).split(" ");
      const subject = header[1];
      const replyTo = header.length === 4 ? header[2] : undefined;
      const payload = data.slice(split + 2).replace(/\r\n$/, "");
      this.published.push({ subject, payload, replyTo });
      void this.handler(subject, payload, this, replyTo);
    }
  }
  subscribedSubjects(): string[] { return [...this.subs.keys()]; }
  deliverToClient(subject: string, payload: string): void {
    const sid = this.subs.get(subject); if (sid === undefined) return;
    const len = new TextEncoder().encode(payload).length;
    this.emit(`MSG ${subject} ${sid} ${len}\r\n${payload}\r\n`);
  }
  close(): void { this.readyState = FakeNatsWS.CLOSED; this.onclose?.(); }
  private emit(frame: string): void { this.onmessage?.({ data: frame }); }
}

export async function generateDeviceX25519(): Promise<{privateKey: CryptoKey; publicRaw: Uint8Array}> {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

export type AgentIdentity = { privatePem: string; publicRaw: Uint8Array; publicB64url: string };
export function makeAgentIdentity(): AgentIdentity {
  const pair = generateKeyPairSync("x25519");
  const raw = new Uint8Array((pair.publicKey.export({type:"spki",format:"der"}) as Buffer).subarray(-32));
  return {
    privatePem: pair.privateKey.export({type:"pkcs8",format:"pem"}) as string,
    publicRaw: raw, publicB64url: Buffer.from(raw).toString("base64url"),
  };
}
function rawToSpki(raw: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from("302a300506032b656e032100","hex"),Buffer.from(raw)]);
}
/**
 * The v3 wrap AAD, re-implemented by hand (no import from the modules under test)
 * so this harness stays an independent agent mirror:
 *   UTF-8("webchannel-wrap-v2") ‹0x1F› UTF-8(peerId) ‹0x1F› UTF-8(clientNonce)
 */
export function wrapAadLikeAgent(peerId: string, clientNonce: string): Buffer {
  const US = Buffer.from([0x1f]);
  return Buffer.concat([
    Buffer.from("webchannel-wrap-v2", "utf8"), US,
    Buffer.from(peerId, "utf8"), US,
    Buffer.from(clientNonce, "utf8"),
  ]);
}

export function wrapLikeAgent(
  K: Uint8Array, devicePublicRaw: Uint8Array, identity: AgentIdentity,
  clientNonce: string, peerId = PEER,
): WrappedConversationKey {
  const shared = diffieHellman({
    privateKey: createPrivateKey(identity.privatePem),
    publicKey: createPublicKey({key:rawToSpki(devicePublicRaw),type:"spki",format:"der"}),
  });
  const key = Buffer.from(hkdfSync("sha256",shared,Buffer.alloc(32),"webchannel-key-wrap-v1",32));
  const nonce=randomBytes(12);
  const cipher=createCipheriv("chacha20-poly1305",key,nonce,{authTagLength:16});
  cipher.setAAD(wrapAadLikeAgent(peerId, clientNonce),{plaintextLength:K.length});
  const ciphertext=Buffer.concat([cipher.update(Buffer.from(K)),cipher.final()]);
  const b64=(v:Uint8Array)=>Buffer.from(v).toString("base64url");
  return {ephemeralPublicKey:b64(identity.publicRaw),nonce:b64(nonce),ciphertext:b64(ciphertext),tag:b64(cipher.getAuthTag())};
}

export type RegisterAgentOptions = {
  rejectCode?: number;
  omitWrappedKey?: boolean;
  versions?: { protocolVersion?: number | string; pluginVersion?: string };
  omitProtocolVersion?: boolean;
  beforeReply?: () => Promise<void>;
};
export function registerAgent(
  K: Uint8Array, devicePublicRaw: Uint8Array, identity: AgentIdentity,
  options: RegisterAgentOptions = {},
): ServerHandler {
  const subject = registerSubject(TENANT,AGENT,PEER);
  return async (s,p,server,replyTo) => {
    if (s !== subject || !replyTo) return;
    const body=JSON.parse(p) as {op?:string; clientNonce?:unknown};
    if (body.op === "challenge") { server.deliverToClient(replyTo,JSON.stringify({nonce:"nonce-abc"})); return; }
    if (body.op !== "register") return;
    if (options.rejectCode) {
      server.deliverToClient(replyTo,JSON.stringify(
        options.rejectCode === 426
          ? {
              error: "protocol_mismatch",
              code: 426,
              protocolVersion: options.versions?.protocolVersion ?? WEBCHANNEL_PROTOCOL_VERSION,
            }
          : {
              error:
                options.rejectCode === 503
                  ? "unavailable"
                  : options.rejectCode === 507
                    ? "capacity_exceeded"
                    : "unauthorized",
              code: options.rejectCode,
            },
      )); return;
    }
    await options.beforeReply?.();
    const reply:Record<string,unknown>={peerId:PEER,registered:true};
    // v3: wrap against the anchor THIS request carried, exactly like the real
    // agent. The reply never echoes it back.
    const clientNonce = typeof body.clientNonce === "string" ? body.clientNonce : "";
    if (!options.omitWrappedKey) reply.wrappedConversationKey=wrapLikeAgent(K,devicePublicRaw,identity,clientNonce);
    if (!options.omitProtocolVersion) {
      reply.protocolVersion=options.versions?.protocolVersion ?? WEBCHANNEL_PROTOCOL_VERSION;
    }
    if (options.versions?.pluginVersion !== undefined) reply.pluginVersion=options.versions.pluginVersion;
    server.deliverToClient(replyTo,JSON.stringify(reply));
  };
}

export async function makeClient(options?: {
  identity?: AgentIdentity; pinned?: string | null; reconnect?: boolean;
  retryRandom?: () => number;
  retryNow?: () => number;
  retrySetTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  retryClearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  ackStallTimeoutMs?: number;
}): Promise<{client:WebChannelNatsClient; devicePublicRaw:Uint8Array; identity:AgentIdentity}> {
  const identity=options?.identity ?? makeAgentIdentity();
  const pop=await generateDevicePopKeyPair();
  const x=await generateDeviceX25519();
  const client=new WebChannelNatsClient({
    url:"ws://127.0.0.1:4222",jwt:JWT,accountId:AGENT,tenant:TENANT,peerId:PEER,
    registration:{
      devicePrivateKey:pop.privateKey,deviceX25519PrivateKey:x.privateKey,
      ...(options?.pinned === null ? {} : {pinnedAgentPublicKey:options?.pinned ?? identity.publicB64url}),
    },
    ...(options?.reconnect ? {reconnectBaseMs:1,reconnectCapMs:2,heartbeatIntervalMs:0} : {}),
    ...(options?.retryRandom ? {_retryRandom: options.retryRandom} : {}),
    ...(options?.retryNow ? {_retryNow: options.retryNow} : {}),
    ...(options?.retrySetTimeout ? {_retrySetTimeout: options.retrySetTimeout} : {}),
    ...(options?.retryClearTimeout ? {_retryClearTimeout: options.retryClearTimeout} : {}),
    ...(options?.ackStallTimeoutMs !== undefined
      ? {ackStallTimeoutMs: options.ackStallTimeoutMs}
      : {}),
  });
  return {client,devicePublicRaw:x.publicRaw,identity};
}

export function installFakeWebSocket(): () => void {
  const original=(globalThis as {WebSocket?:unknown}).WebSocket;
  (globalThis as {WebSocket:unknown}).WebSocket=FakeNatsWS;
  FakeNatsWS.instances=[]; FakeNatsWS.sharedHandler=()=>{};
  return ()=>{(globalThis as {WebSocket?:unknown}).WebSocket=original;};
}
export async function settle(rounds=12):Promise<void> {
  for(let i=0;i<rounds;i++) await new Promise(r=>setTimeout(r,3));
}

/**
 * Wait for a CONDITION instead of for a fixed number of ticks.
 *
 * `settle()` is a wall-clock budget (12 × 3 ms), not a queue drain: when the work
 * it is standing in for is slower than 36 ms — a loaded CI runner stretching the
 * X25519 unwrap and the register round-trip — the assertion after it reads a
 * state that simply has not arrived yet. Adding rounds moves that race rather
 * than removing it, so anything whose precondition is "the handshake/publish has
 * completed" should wait for the completion itself.
 *
 * Poll on a REAL timer, deliberately: everything being waited on here is driven
 * by timers and I/O callbacks, so a microtask spin would burn the budget without
 * ever letting the pending work run. That also means this helper cannot be used
 * under `vi.useFakeTimers()` — it would never advance.
 *
 * THROWS on timeout, by design. A waiter that gives up quietly and lets the
 * assertion run anyway converts a red into a differently-worded red at best, and
 * into a false green at worst; the gate is this project's only test evidence, so
 * a helper that can silently disarm it is worse than the fixed budget it
 * replaces. The message names what was awaited and for how long.
 *
 * @param predicate the condition to wait for; polled until it returns true
 * @param label     what is being awaited — quoted verbatim in the timeout error
 * @param timeoutMs ceiling (default 2 s). Chosen as ~55× the 36 ms budget it
 *   replaces, so a runner would have to be ~55× slower than the local box to
 *   trip it — comfortably past the ~10× stretch measured on a contended runner,
 *   while staying under vitest's 5 s default test timeout. A genuine hang then
 *   surfaces as THIS message rather than as an anonymous "test timed out",
 *   which is the difference between a diagnosable red and another argued-away
 *   one. That holds while a test's waits total under 5 s; because this throws,
 *   only the FIRST to time out can fire, so today's max of two waits is safe.
 * @param intervalMs poll period (default 2 ms)
 */
export async function settleUntil(
  predicate: () => boolean,
  { label, timeoutMs = 2000, intervalMs = 2 }: { label: string; timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `settleUntil: timed out after ${Date.now() - startedAt}ms (limit ${timeoutMs}ms) waiting for: ${label}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
export type { ProtocolInfo };
