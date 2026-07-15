import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { inboundSubject,outboundSubject,type OutboundMessage } from "./nats-client.js";
import { canonicalAad,openMessage,sealMessage } from "./e2e-crypto-browser.js";
import { AGENT,FakeNatsWS,PEER,TENANT,installFakeWebSocket,makeClient,registerAgent,settle,type ServerHandler } from "./nats-client-wrapped.test-harness.js";
let restore:()=>void;
beforeEach(()=>{restore=installFakeWebSocket();});
afterEach(()=>restore());

async function start(){
 const K=new Uint8Array(32).fill(21);const h=await makeClient();const received:unknown[]=[];
 const registration=registerAgent(K,h.devicePublicRaw,h.identity);
 const handler:ServerHandler=async(s,p,server,reply)=>{
   await registration(s,p,server,reply);
   if(s===inboundSubject(TENANT,AGENT,PEER)){
     const msg=openMessage(p,K) as {type?:string;text?:string}|null;
     if(msg?.type==="user_message")server.deliverToClient(outboundSubject(TENANT,AGENT,PEER),sealMessage({accountId:AGENT,tenant:TENANT,sub:PEER},K,{type:"agent_message",text:`echo: ${msg.text}`} as unknown as OutboundMessage));
   }
 };
 FakeNatsWS.sharedHandler=handler;h.client.onMessage(m=>received.push(m));h.client.connect();
 return {...h,K,received};
}

describe("WebChannelNatsClient (register-delivered E2E encrypted)",()=>{
 it("registers, seals to .in, and decrypts the agent reply from .out",async()=>{
   const h=await start();await settle();h.client.sendUserMessage("hello agent");await settle();
   expect(h.received).toContainEqual({type:"agent_message",text:"echo: hello agent"});
   expect(FakeNatsWS.instances[0].published.some(p=>p.subject===inboundSubject(TENANT,AGENT,PEER))).toBe(true);h.client.disconnect();
 });
 it("only ever puts ciphertext on .in",async()=>{
   const h=await start();h.client.sendUserMessage("topsecret-probe");await settle();
   const wire=FakeNatsWS.instances[0].published.find(p=>p.subject===inboundSubject(TENANT,AGENT,PEER))!.payload;
   expect(wire).not.toContain("topsecret-probe");expect(wire).not.toContain("user_message");
   expect(JSON.parse(wire)).toMatchObject({v:1,content:{ciphertext:expect.any(String)}});h.client.disconnect();
 });
 it("buffers a pre-register send and flushes it only after K unwrap",async()=>{
   let release=()=>{};const gate=new Promise<void>(r=>{release=r;});
   const K=new Uint8Array(32).fill(22);const h=await makeClient();
   FakeNatsWS.sharedHandler=registerAgent(K,h.devicePublicRaw,h.identity,{beforeReply:()=>gate});
   h.client.connect();h.client.sendUserMessage("early");await settle(5);
   expect(FakeNatsWS.instances[0].published.some(p=>p.subject===inboundSubject(TENANT,AGENT,PEER))).toBe(false);
   release();await settle();
   const wire=FakeNatsWS.instances[0].published.find(p=>p.subject===inboundSubject(TENANT,AGENT,PEER))!.payload;
   expect(wire).not.toContain("early");expect(openMessage(wire,K)).toMatchObject({text:"early"});h.client.disconnect();
 });
 it("drops malformed inbound ciphertext without notifying listeners",async()=>{
   const h=await start();await settle();FakeNatsWS.instances[0].deliverToClient(outboundSubject(TENANT,AGENT,PEER),"not-an-envelope");await settle(2);
   expect(h.received).toEqual([]);h.client.disconnect();
 });
 it("drops inbound sealed with the wrong delivered key",async()=>{
   const h=await start();await settle();
   FakeNatsWS.instances[0].deliverToClient(outboundSubject(TENANT,AGENT,PEER),sealMessage({accountId:AGENT,tenant:TENANT,sub:PEER},new Uint8Array(32).fill(99),{type:"agent_message",text:"forged"}));
   await settle(2);expect(h.received).toEqual([]);h.client.disconnect();
 });
});

describe("e2e-crypto-browser registered-key conformance",()=>{
 it("computes canonical AAD with fixed key order",()=>{
   const text=new TextDecoder().decode(canonicalAad({accountId:"a",tenant:"t",sub:"s",messageId:"m",envelopeType:"conversation",ts:123}));
   expect(text).toBe('{"tenant":"t","accountId":"a","sub":"s","messageId":"m","envelopeType":"conversation","ts":123}');
 });
 it("seals and opens a message round-trip with a fixed K",()=>{
   const K=new Uint8Array(32).fill(1);const wire=sealMessage({accountId:"a",tenant:"t",sub:"s"},K,{type:"user_message",text:"round-trip"});
   expect(openMessage(wire,K)).toEqual({type:"user_message",text:"round-trip"});
 });
 it("wrong-key open returns null",()=>{
   const wire=sealMessage({accountId:"a",tenant:"t",sub:"s"},new Uint8Array(32).fill(1),{type:"user_message",text:"x"});
   expect(openMessage(wire,new Uint8Array(32).fill(2))).toBeNull();
 });
 it("AAD routing mutation is rejected",()=>{
   const K=new Uint8Array(32).fill(3);const wire=sealMessage({accountId:"a",tenant:"t",sub:"s"},K,{type:"user_message",text:"x"});
   const env=JSON.parse(wire);env.sub="other";expect(openMessage(JSON.stringify(env),K)).toBeNull();
 });
 it("uses a fresh nonce for equal plaintext under the same K",()=>{
   const K=new Uint8Array(32).fill(4);const a=JSON.parse(sealMessage({accountId:"a",tenant:"t",sub:"s"},K,{type:"user_message",text:"x"}));
   const b=JSON.parse(sealMessage({accountId:"a",tenant:"t",sub:"s"},K,{type:"user_message",text:"x"}));
   expect(a.content.nonce).not.toBe(b.content.nonce);
 });
});
