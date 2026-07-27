import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { NatsChannel, type InboundWsMessage } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";
import { encrypt, generateKeyPair } from "./e2e-crypto.js";
import { openEnvelope, sealEnvelope } from "./e2e-session.js";

function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split("."), s = subject.split(".");
  for (let i=0;i<p.length;i++) { if (p[i] === ">") return true; if (i>=s.length) return false; if (p[i] !== "*" && p[i] !== s[i]) return false; }
  return p.length === s.length;
}
class Broker {
  clients: Transport[] = [];
  route(subject:string,payload:Buffer,sender:Transport):void { for(const c of this.clients) if(c!==sender&&c.matches(subject)) c.emit("message",{subject,payload}); }
}
class Transport extends EventEmitter {
  connected=true; private subs=new Map<number,string>(); private sid=0;
  constructor(private broker:Broker){super();broker.clients.push(this);}
  subscribe(subject:string):number{const id=++this.sid;this.subs.set(id,subject);return id;}
  unsubscribe(id:number):void{this.subs.delete(id);}
  publish(subject:string,payload:string|Buffer|Uint8Array):void{this.broker.route(subject,Buffer.from(payload as Uint8Array),this);}
  matches(subject:string):boolean{return [...this.subs.values()].some(p=>subjectMatches(p,subject));}
}
const TENANT="acme", AGENT="agent-1", PEER="user-42";
const inSubj=`webchannel.${TENANT}.${AGENT}.${PEER}.in`;
const outSubj=`webchannel.${TENANT}.${AGENT}.${PEER}.out`;
function makeHarness(registered = true){
 const broker=new Broker(), agent=new Transport(broker);
 const sessionKey=new Uint8Array(32).fill(7);
 const channel=new NatsChannel(agent as unknown as NatsTransport,AGENT,TENANT,{keyStore:{getOrCreate:()=>sessionKey} as never,identityKeyPair:generateKeyPair()});
 const inbound:InboundWsMessage[]=[];
 channel.setMessageHandler((peer,msg)=>{inbound.push(msg);channel.sendText(peer,`reply:${msg.type==="user_message"?msg.text:""}`);});
 if (registered) channel.registerPeer(PEER);
 const wiretap=new Transport(broker);wiretap.subscribe(inSubj);wiretap.subscribe(outSubj);
 const wirePayloads:Array<{subject:string;text:string}>=[];
 wiretap.on("message",(m:{subject:string;payload:Buffer})=>wirePayloads.push({subject:m.subject,text:m.payload.toString("utf8")}));
 const browser=new Transport(broker);browser.subscribe(outSubj);
 const browserReplies:unknown[]=[];
 browser.on("message",(m:{payload:Buffer})=>browserReplies.push(openEnvelope(m.payload,sessionKey).message));
 return {channel,browser,wirePayloads,inbound,browserReplies,sessionKey};
}

describe("NatsChannel (encrypt-by-construction)",()=>{
  it("only ever puts ciphertext on the wire (relay sees no plaintext)", () => {
    const h = makeHarness();
    
    const key = h.sessionKey;
    h.browser.publish(inSubj, sealEnvelope({ accountId: AGENT, tenant: TENANT, sub: PEER }, key, {
      type: "user_message",
      text: "topsecret-probe",
    }));

    const dataFrames = h.wirePayloads.filter((p) => p.subject === inSubj || p.subject === outSubj);
    expect(dataFrames.length).toBe(2); // one in, one out
    for (const frame of dataFrames) {
      // No plaintext leaks anywhere on the wire.
      expect(frame.text).not.toContain("topsecret-probe");
      expect(frame.text).not.toContain("reply:");
      expect(frame.text).not.toContain("user_message");
      expect(frame.text).not.toContain("agent_message");
      // The frame is a genuine v1 envelope with a ciphertext content block.
      const env = JSON.parse(frame.text) as { v: number; content?: { ciphertext?: string } };
      expect(env.v).toBe(1);
      expect(typeof env.content?.ciphertext).toBe("string");
      expect((env.content!.ciphertext as string).length).toBeGreaterThan(0);
    }
  });

  it("fail-closed: refuses to send before registration (no plaintext outbound)", () => {
    const h = makeHarness(false);
    // No handshake performed.
    const ok = h.channel.sendText(PEER, "must-not-leak");
    expect(ok).toBe(false);
    expect(h.wirePayloads.some((p) => p.subject === outSubj)).toBe(false);
  });

  it("fail-closed: drops inbound that arrives before registration", () => {
    const h = makeHarness(false);
    // Plaintext attempt before any key exchange.
    h.browser.publish(inSubj, Buffer.from(JSON.stringify({ type: "user_message", text: "x" })));
    // Sealed-with-some-key attempt before any key exchange.
    const someKey = new Uint8Array(32).fill(9);
    h.browser.publish(inSubj, sealEnvelope({ accountId: AGENT, tenant: TENANT, sub: PEER }, someKey, { type: "user_message", text: "y" }));
    expect(h.inbound).toEqual([]);
  });

  it("fail-closed: drops a frame whose routing (AAD) was tampered after sealing (AC2)", () => {
    const h = makeHarness();
    
    const key = h.sessionKey;

    // Seal legitimately, then tamper a plaintext routing field WITHOUT re-encrypting.
    // The agent recomputes canonical AAD from the (tampered) routing, so the
    // ChaCha20-Poly1305 tag no longer authenticates → decryption fails → dropped.
    const sealed = sealEnvelope({ accountId: AGENT, tenant: TENANT, sub: PEER }, key, {
      type: "user_message",
      text: "authentic",
    });
    const env = JSON.parse(sealed.toString("utf8")) as Record<string, unknown>;
    env["messageId"] = `${String(env["messageId"])}-tampered`; // routing/AAD mutation
    h.browser.publish(inSubj, Buffer.from(JSON.stringify(env)));

    expect(h.inbound).toEqual([]);

    // And a control: the same payload, untampered, IS accepted — proving the drop
    // above is specifically due to the AAD mismatch, not a structural reject.
    h.browser.publish(inSubj, sealed);
    expect(h.inbound).toEqual([{ type: "user_message", text: "authentic" }]);
  });

  it("fail-closed: drops a frame sealed with the wrong key after registration", () => {
    const h = makeHarness();
    
    // Wrong key (not the negotiated session key) → decrypt fails → dropped.
    const wrongKey = new Uint8Array(32).fill(9);
    h.browser.publish(inSubj, sealEnvelope({ accountId: AGENT, tenant: TENANT, sub: PEER }, wrongKey, {
      type: "user_message",
      text: "tampered",
    }));
    expect(h.inbound).toEqual([]);
  });

  it("uses a fresh 12-byte nonce per seal (no nonce reuse)", () => {
    // Sanity on the underlying AEAD the channel relies on.
    const key = new Uint8Array(32).fill(8);
    const a = encrypt(key, new TextEncoder().encode("same"));
    const b = encrypt(key, new TextEncoder().encode("same"));
    expect(Buffer.from(a.nonce).toString("hex")).not.toBe(Buffer.from(b.nonce).toString("hex"));
  });

});
describe("NatsChannel (F4 anti-replay)",()=>{
 const routing={accountId:AGENT,tenant:TENANT,sub:PEER};
 it("drops a byte-identical replayed sealed frame on the second delivery",()=>{
   const h=makeHarness(); const frame=sealEnvelope(routing,h.sessionKey,{type:"user_message",text:"run the tool"});
   const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
   h.browser.publish(inSubj,frame); h.browser.publish(inSubj,frame);
   expect(h.inbound).toEqual([{type:"user_message",text:"run the tool"}]);
   expect(warn).toHaveBeenCalledWith(expect.stringContaining("replayed messageId")); warn.mockRestore();
 });
 it("passes a fresh frame carrying a new messageId",()=>{
   const h=makeHarness();
   h.browser.publish(inSubj,sealEnvelope(routing,h.sessionKey,{type:"user_message",text:"one"}));
   h.browser.publish(inSubj,sealEnvelope(routing,h.sessionKey,{type:"user_message",text:"two"}));
   expect(h.inbound).toEqual([{type:"user_message",text:"one"},{type:"user_message",text:"two"}]);
 });
 it("rejects a frame whose ts is outside the ±window",()=>{
   vi.useFakeTimers(); const t=1_700_000_000_000; vi.setSystemTime(t);
   const h=makeHarness(); const stale=sealEnvelope(routing,h.sessionKey,{type:"user_message",text:"old"});
   vi.setSystemTime(t+11*60*1000); h.browser.publish(inSubj,stale);
   expect(h.inbound).toEqual([]);
   h.browser.publish(inSubj,sealEnvelope(routing,h.sessionKey,{type:"user_message",text:"fresh"}));
   expect(h.inbound).toEqual([{type:"user_message",text:"fresh"}]); vi.useRealTimers();
 });
});
