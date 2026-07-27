import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { inboundSubject,registerSubject } from "./nats-client.js";
import { AGENT,FakeNatsWS,PEER,TENANT,installFakeWebSocket,makeClient,registerAgent,settle,type ServerHandler } from "./nats-client-wrapped.test-harness.js";
let restore:()=>void;
beforeEach(()=>{restore=installFakeWebSocket();});
afterEach(()=>restore());

describe("WebChannelNatsClient register-hop recovery (F5)",()=>{
  it("re-registers and recovers after transient register failure",async()=>{
    const h=await makeClient({reconnect:true});const K=new Uint8Array(32).fill(6);
    let offline=true;let failedRegisters=0;
    const good=registerAgent(K,h.devicePublicRaw,h.identity);
    FakeNatsWS.sharedHandler=async(s,p,server,reply)=>{
      if(offline) {
        const body=JSON.parse(p) as {op?:string};
        const result=registerAgent(K,h.devicePublicRaw,h.identity,{rejectCode:503})(s,p,server,reply);
        if(body.op==="register"&&++failedRegisters===3) offline=false;
        return result;
      }
      return good(s,p,server,reply);
    };
    h.client.connect();await settle(20);
    expect(FakeNatsWS.instances.length).toBeGreaterThan(1);
    await settle(10);
    h.client.sendUserMessage("recovered");await settle();
    expect(FakeNatsWS.instances.some(ws=>ws.published.some(p=>p.subject===inboundSubject(TENANT,AGENT,PEER)))).toBe(true);
    h.client.disconnect();
  });

  it("re-registers after an interrupted register request and shares the handler across sockets",async()=>{
    const h=await makeClient({reconnect:true});const K=new Uint8Array(32).fill(7);
    const good=registerAgent(K,h.devicePublicRaw,h.identity);let interrupted=false;
    FakeNatsWS.sharedHandler=((s,p,server,reply)=>{
      const body=JSON.parse(p) as {op?:string};
      if(!interrupted&&s===registerSubject(TENANT,AGENT,PEER)&&body.op==="register"){
        interrupted=true;server.close();return;
      }
      return good(s,p,server,reply);
    }) as ServerHandler;
    h.client.connect();await settle(30);
    expect(interrupted).toBe(true);
    expect(FakeNatsWS.instances.length).toBeGreaterThan(1);
    const challenges=FakeNatsWS.instances.flatMap(ws=>ws.published).filter(p=>p.subject===registerSubject(TENANT,AGENT,PEER)&&JSON.parse(p.payload).op==="challenge");
    expect(challenges.length).toBeGreaterThan(1);
    h.client.sendUserMessage("after-interrupt");await settle();
    expect(FakeNatsWS.instances.at(-1)!.published.some(p=>p.subject===inboundSubject(TENANT,AGENT,PEER))).toBe(true);
    h.client.disconnect();
  });

  it("a non-retryable register server error is terminal",async()=>{
    const h=await makeClient({reconnect:true});const errors:Error[]=[];
    const reg=registerSubject(TENANT,AGENT,PEER);
    FakeNatsWS.sharedHandler=(s,p,server,reply)=>{
      if(s!==reg||!reply)return;const body=JSON.parse(p) as {op?:string};
      if(body.op==="challenge")server.deliverToClient(reply,JSON.stringify({nonce:"n"}));
      else server.deliverToClient(reply,JSON.stringify({error:"boom",code:500}));
    };
    h.client.onError(e=>errors.push(e));h.client.connect();await settle(20);
    expect(errors[0]?.name).toBe("PopServerError");
    const count=FakeNatsWS.instances.length;await settle(10);expect(FakeNatsWS.instances).toHaveLength(count);
    h.client.disconnect();
  });

  it("a capacity rejection is terminal and reports the capacity cause",async()=>{
    const h=await makeClient({reconnect:true});const errors:Array<{error:Error;cause?:string}>=[];
    const K=new Uint8Array(32).fill(8);
    FakeNatsWS.sharedHandler=registerAgent(K,h.devicePublicRaw,h.identity,{rejectCode:507});
    h.client.onError((error,cause)=>errors.push({error,cause}));h.client.connect();await settle(20);
    expect(errors[0]?.error.name).toBe("PopCapacityError");
    expect(errors[0]?.cause).toBe("capacity");
    const count=FakeNatsWS.instances.length;await settle(10);expect(FakeNatsWS.instances).toHaveLength(count);
    h.client.disconnect();
  });
});
