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
export function wrapLikeAgent(
  K: Uint8Array, devicePublicRaw: Uint8Array, identity: AgentIdentity, peerId = PEER,
): WrappedConversationKey {
  const shared = diffieHellman({
    privateKey: createPrivateKey(identity.privatePem),
    publicKey: createPublicKey({key:rawToSpki(devicePublicRaw),type:"spki",format:"der"}),
  });
  const key = Buffer.from(hkdfSync("sha256",shared,Buffer.alloc(32),"webchannel-key-wrap-v1",32));
  const nonce=randomBytes(12);
  const cipher=createCipheriv("chacha20-poly1305",key,nonce,{authTagLength:16});
  cipher.setAAD(Buffer.from(peerId),{plaintextLength:K.length});
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
    const body=JSON.parse(p) as {op?:string};
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
          : {error:options.rejectCode===503?"unavailable":"unauthorized",code:options.rejectCode},
      )); return;
    }
    await options.beforeReply?.();
    const reply:Record<string,unknown>={peerId:PEER,registered:true};
    if (!options.omitWrappedKey) reply.wrappedConversationKey=wrapLikeAgent(K,devicePublicRaw,identity);
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
export type { ProtocolInfo };
