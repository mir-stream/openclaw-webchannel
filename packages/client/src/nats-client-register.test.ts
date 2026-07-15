import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inboundSubject, registerSubject } from "./nats-client.js";
import { openMessage } from "./e2e-crypto-browser.js";
import {
  AGENT, FakeNatsWS, JWT, PEER, TENANT, installFakeWebSocket, makeClient,
  registerAgent, settle,
} from "./nats-client-wrapped.test-harness.js";

let restore:()=>void;
beforeEach(()=>{restore=installFakeWebSocket();});
afterEach(()=>restore());

describe("WebChannelNatsClient PoP registration wiring (NATS)",()=>{
  it("registers challenge → PoP → admit, then unwraps K and flushes ciphertext",async()=>{
    const K=new Uint8Array(32).fill(11);
    const h=await makeClient();
    FakeNatsWS.sharedHandler=registerAgent(K,h.devicePublicRaw,h.identity);
    h.client.connect();
    h.client.sendUserMessage("hello");
    await settle();
    const server=FakeNatsWS.instances[0];
    const pubs=server.published.filter(p=>p.subject===registerSubject(TENANT,AGENT,PEER));
    expect(pubs).toHaveLength(2);
    expect(JSON.parse(pubs[0].payload)).toEqual({op:"challenge",token:JWT});
    const proof=JSON.parse(pubs[1].payload) as {op:string;token:string;nonce:string;signature:string};
    expect(proof).toMatchObject({op:"register",token:JWT,nonce:"nonce-abc"});
    expect(typeof proof.signature).toBe("string");
    const sent=server.published.find(p=>p.subject===inboundSubject(TENANT,AGENT,PEER))!;
    expect(sent.payload).not.toContain("hello");
    expect(openMessage(sent.payload,K)).toMatchObject({type:"user_message",text:"hello"});
    h.client.disconnect();
  });

  it("fail-closed terminal when register omits wrapped K",async()=>{
    const h=await makeClient(); const errors:Error[]=[];
    FakeNatsWS.sharedHandler=registerAgent(new Uint8Array(32),h.devicePublicRaw,h.identity,{omitWrappedKey:true});
    h.client.onError(e=>errors.push(e));h.client.connect();h.client.sendUserMessage("blocked");await settle();
    expect(errors[0]?.message).toMatch(/wrappedConversationKey/);
    expect(FakeNatsWS.instances[0].readyState).toBe(FakeNatsWS.CLOSED);
    expect(FakeNatsWS.instances[0].published.some(p=>p.subject===inboundSubject(TENANT,AGENT,PEER))).toBe(false);
  });

  it("fail-closed terminal when the SaaS pin is absent",async()=>{
    const h=await makeClient({pinned:null});const errors:Error[]=[];
    FakeNatsWS.sharedHandler=registerAgent(new Uint8Array(32).fill(2),h.devicePublicRaw,h.identity);
    h.client.onError(e=>errors.push(e));h.client.connect();await settle();
    expect(errors[0]?.message).toMatch(/pinned agent public key/i);
    expect(FakeNatsWS.instances[0].readyState).toBe(FakeNatsWS.CLOSED);
  });

  it("protocol version absent is non-fatal for compatibility",async()=>{
    const h=await makeClient();const seen:unknown[]=[];
    FakeNatsWS.sharedHandler=registerAgent(new Uint8Array(32).fill(3),h.devicePublicRaw,h.identity);
    h.client.onProtocol(v=>seen.push(v));h.client.connect();await settle();
    expect(seen).toEqual([{protocolVersion:null,pluginVersion:null}]);
    expect(FakeNatsWS.instances[0].readyState).toBe(FakeNatsWS.OPEN);h.client.disconnect();
  });

  it("matching protocol version proceeds and reports plugin version",async()=>{
    const h=await makeClient();const seen:unknown[]=[];
    FakeNatsWS.sharedHandler=registerAgent(new Uint8Array(32).fill(4),h.devicePublicRaw,h.identity,{versions:{protocolVersion:1,pluginVersion:"9.9.9"}});
    h.client.onProtocol(v=>seen.push(v));h.client.connect();await settle();
    expect(seen).toEqual([{protocolVersion:1,pluginVersion:"9.9.9"}]);
    expect((h.client as unknown as {sessionKey:Uint8Array}).sessionKey).toBeTruthy();h.client.disconnect();
  });

  it("protocol mismatch is terminal and never publishes inbound",async()=>{
    const h=await makeClient();const errors:Error[]=[];
    FakeNatsWS.sharedHandler=registerAgent(new Uint8Array(32).fill(5),h.devicePublicRaw,h.identity,{versions:{protocolVersion:2}});
    h.client.onError(e=>errors.push(e));h.client.connect();h.client.sendUserMessage("blocked");await settle();
    expect(errors[0]?.message).toMatch(/protocol/i);
    expect(FakeNatsWS.instances[0].readyState).toBe(FakeNatsWS.CLOSED);
    expect(FakeNatsWS.instances[0].published.some(p=>p.subject===inboundSubject(TENANT,AGENT,PEER))).toBe(false);
  });

  it("authentication rejection is terminal with no reconnect",async()=>{
    const h=await makeClient({reconnect:true});const errors:Error[]=[];
    FakeNatsWS.sharedHandler=registerAgent(new Uint8Array(32),h.devicePublicRaw,h.identity,{rejectCode:401});
    h.client.onError(e=>errors.push(e));h.client.connect();await settle(20);
    expect(errors[0]?.name).toBe("PopRejectedError");
    const count=FakeNatsWS.instances.length;await settle(10);expect(FakeNatsWS.instances).toHaveLength(count);
    h.client.disconnect();
  });
});
