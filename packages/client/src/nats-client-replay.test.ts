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
 const received:Array<{id?:string;text?:string}>=[];
 // #243 half 1: capture the wire `random_id` SEPARATELY so the existing exact
 // `toEqual([{id,text}])` assertions on `received` stay unchanged.
 const receivedFull:Array<{id?:string;text?:string;random_id?:string}>=[];
 const registration=registerAgent(K,h.devicePublicRaw,h.identity);
 const handler:ServerHandler=async(s,p,server,reply)=>{
   await registration(s,p,server,reply);
   if(s!==inboundSubject(TENANT,AGENT,PEER)||!control.deliver)return;
   const msg=openMessage(p,K) as {type?:string;id?:string;text?:string;random_id?:string}|null;
   if(msg?.type!=="user_message")return;
   received.push({id:msg.id,text:msg.text});
   receivedFull.push({id:msg.id,text:msg.text,random_id:msg.random_id});
   if(control.ack&&msg.id)server.deliverToClient(outboundSubject(TENANT,AGENT,PEER),sealMessage({accountId:AGENT,tenant:TENANT,sub:PEER},K,{type:"ack",ids:[msg.id]} as unknown as OutboundMessage));
 };
 FakeNatsWS.sharedHandler=handler;h.client.connect();await settle();
 return {...h,K,received,receivedFull};
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

// #243 half 1: the client stamps an idempotency `random_id` on every user_message
// frame, distinct from the durable wire `id`, and REUSES it on a reconnect replay
// (it rides the ledger entry). That reuse is the property half 2 depends on: once
// the server mints the durable id, retry idempotency can no longer ride the wire
// id and must already ride random_id.
describe("WebChannelNatsClient — #243 half 1 wire random_id",()=>{
 it("stamps a non-empty random_id, distinct from the durable wire id",async()=>{
   const h=await setup();const id=h.client.sendUserMessage("hello");await settle();
   expect(h.receivedFull).toHaveLength(1);
   const frame=h.receivedFull[0]!;
   expect(frame.id).toBe(id);
   expect(typeof frame.random_id).toBe("string");
   expect(frame.random_id!.length).toBeGreaterThan(0);
   expect(frame.random_id).not.toBe(id); // idempotency key ≠ durable id
   h.client.disconnect();
 });
 it("mints a DIFFERENT random_id for each distinct message",async()=>{
   const h=await setup();h.client.sendUserMessage("a");h.client.sendUserMessage("b");await settle();
   expect(h.receivedFull.map(f=>f.text)).toEqual(["a","b"]);
   const [ra,rb]=h.receivedFull.map(f=>f.random_id);
   expect(ra).toBeTruthy();expect(rb).toBeTruthy();expect(ra).not.toBe(rb);
   h.client.disconnect();
 });
 it("REUSES the same random_id when replaying an unacked message on reconnect",async()=>{
   // deliver but never ack → the frame stays in the ledger; force a reconnect and
   // it is re-delivered. Both deliveries must carry the SAME random_id.
   const control={deliver:true,ack:false};const h=await setup(control);
   h.client.sendUserMessage("retry-me");await settle();
   expect(h.receivedFull).toHaveLength(1);
   const first=h.receivedFull[0]!.random_id;
   expect(first).toBeTruthy();
   FakeNatsWS.instances.at(-1)!.close();await settle(30); // reconnect → flushQueue replays the ledger
   expect(h.receivedFull.length).toBeGreaterThanOrEqual(2);
   expect(h.receivedFull[1]!.text).toBe("retry-me");
   expect(h.receivedFull[1]!.random_id).toBe(first); // SAME random_id on the replay
   h.client.disconnect();
 });
});
