import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { inboundSubject,outboundSubject,registerSubject,type OutboundMessage,WebChannelNatsClient } from "./nats-client.js";
import { openMessage,sealMessage } from "./e2e-crypto-browser.js";
import { AGENT,FakeNatsWS,PEER,TENANT,installFakeWebSocket,makeClient,registerAgent,settle,type ServerHandler } from "./nats-client-wrapped.test-harness.js";
let restore:()=>void;
beforeEach(()=>{restore=installFakeWebSocket();});
afterEach(()=>restore());
function ledgerOf(client:WebChannelNatsClient):Map<string,OutboundMessage>{return (client as unknown as {unackedLedger:Map<string,OutboundMessage>}).unackedLedger;}

async function setup(control:{deliver:boolean;ack:boolean}={deliver:true,ack:true}){
 const K=new Uint8Array(32).fill(31);const h=await makeClient({reconnect:true});
 const received:Array<{id?:string;text?:string}>=[];const registration=registerAgent(K,h.devicePublicRaw,h.identity);
 const handler:ServerHandler=async(s,p,server,reply)=>{
   await registration(s,p,server,reply);
   if(s!==inboundSubject(TENANT,AGENT,PEER)||!control.deliver)return;
   const msg=openMessage(p,K) as {type?:string;id?:string;text?:string}|null;
   if(msg?.type!=="user_message")return;
   received.push({id:msg.id,text:msg.text});
   if(control.ack&&msg.id)server.deliverToClient(outboundSubject(TENANT,AGENT,PEER),sealMessage({accountId:AGENT,tenant:TENANT,sub:PEER},K,{type:"ack",ids:[msg.id]} as unknown as OutboundMessage));
 };
 FakeNatsWS.sharedHandler=handler;h.client.connect();await settle();
 return {...h,K,received};
}

describe("WebChannelNatsClient — P0-7b unacked ledger",()=>{
 it("records a published user_message and drains it when ack arrives",async()=>{
   const h=await setup();h.client.sendUserMessage("hello");await settle();
   expect(h.received.map(m=>m.text)).toEqual(["hello"]);expect(ledgerOf(h.client).size).toBe(0);h.client.disconnect();
 });
 it("keeps an unacked message in the ledger",async()=>{
   const h=await setup({deliver:true,ack:false});const id=h.client.sendUserMessage("no-ack");await settle();
   expect([...ledgerOf(h.client).keys()]).toEqual([id]);h.client.disconnect();
 });
 it("replays a lost message on reconnect with the same id exactly once",async()=>{
   const control={deliver:false,ack:true};const h=await setup(control);const id=h.client.sendUserMessage("survive");await settle();
   expect(h.received).toEqual([]);control.deliver=true;FakeNatsWS.instances.at(-1)!.close();await settle(30);
   expect(h.received).toEqual([{id,text:"survive"}]);expect(ledgerOf(h.client).size).toBe(0);h.client.disconnect();
 });
 it("replays unacked frames in original order ahead of outage-queued work",async()=>{
   const control={deliver:false,ack:true};const h=await setup(control);
   const id1=h.client.sendUserMessage("first"),id2=h.client.sendUserMessage("second");await settle();
   control.deliver=true;FakeNatsWS.instances.at(-1)!.close();const id3=h.client.sendUserMessage("third");await settle(30);
   expect(h.received).toEqual([{id:id1,text:"first"},{id:id2,text:"second"},{id:id3,text:"third"}]);
   expect(ledgerOf(h.client).size).toBe(0);h.client.disconnect();
 });
 it("caps the ledger at 100 and evicts the oldest",async()=>{
   const h=await setup({deliver:true,ack:false});const ids:string[]=[];
   for(let i=0;i<101;i++)ids.push(h.client.sendUserMessage(`m${i}`));await settle(20);
   expect(ledgerOf(h.client).size).toBe(100);expect(ledgerOf(h.client).has(ids[0])).toBe(false);expect(ledgerOf(h.client).has(ids[100])).toBe(true);h.client.disconnect();
 });
 it("resetSession preserves entries needed by reconnect",async()=>{
   const h=await setup({deliver:true,ack:false});const id=h.client.sendUserMessage("keep");await settle();
   (h.client as unknown as {resetSession:()=>void}).resetSession();expect([...ledgerOf(h.client).keys()]).toEqual([id]);h.client.disconnect();
 });
 it("disconnect clears the ledger",async()=>{
   const h=await setup({deliver:true,ack:false});h.client.sendUserMessage("gone");await settle();expect(ledgerOf(h.client).size).toBe(1);
   h.client.disconnect();expect(ledgerOf(h.client).size).toBe(0);
 });
 it("an ack for unknown ids is a no-op and still reaches listeners",async()=>{
   const h=await setup({deliver:true,ack:false});const messages:unknown[]=[];h.client.onMessage(m=>messages.push(m));
   const id=h.client.sendUserMessage("real");await settle();
   FakeNatsWS.instances.at(-1)!.deliverToClient(outboundSubject(TENANT,AGENT,PEER),sealMessage({accountId:AGENT,tenant:TENANT,sub:PEER},h.K,{type:"ack",ids:["unknown"]} as unknown as OutboundMessage));
   await settle();expect([...ledgerOf(h.client).keys()]).toEqual([id]);expect(messages).toContainEqual({type:"ack",ids:["unknown"]});h.client.disconnect();
 });
 it("shares the agent handler across sockets and re-registers before replay",async()=>{
   const control={deliver:false,ack:false};const h=await setup(control);h.client.sendUserMessage("pending");await settle();
   FakeNatsWS.instances.at(-1)!.close();await settle(30);
   expect(FakeNatsWS.instances.length).toBeGreaterThan(1);
   const challenges=FakeNatsWS.instances.flatMap(ws=>ws.published).filter(p=>p.subject===registerSubject(TENANT,AGENT,PEER)&&JSON.parse(p.payload).op==="challenge");
   expect(challenges.length).toBeGreaterThan(1);expect(ledgerOf(h.client).size).toBe(1);h.client.disconnect();
 });
});
