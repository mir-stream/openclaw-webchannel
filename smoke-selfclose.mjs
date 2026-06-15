import { WebSocket } from "ws";
const URL = "ws://127.0.0.1:18789/clawchannel/ws";
const t0 = Date.now(); const ms = () => `${String(Date.now()-t0).padStart(6)}ms`;
let phase = 1, got1=false, got2=false, ws;
const log = s => console.log(`[${ms()}] ${s}`);
function connect(){
  ws = new WebSocket(URL);
  ws.on("open", () => { log(`open (phase ${phase})`); ws.send(JSON.stringify({type:"user_message", text:`Reply with exactly: RT${phase}`})); });
  ws.on("message", d => {
    let m; try{m=JSON.parse(d.toString())}catch{return}
    if(m.type!=="agent_message") return;
    log(`<- ${JSON.stringify((m.text||"").slice(0,30))}`);
    if(phase===1){ got1=true; phase=2; log("closing socket to simulate a drop..."); ws.close(); }
    else { got2=true; finish(); }
  });
  ws.on("close", () => { if(phase===2 && !got2){ log("reconnecting (new socket)..."); setTimeout(connect, 500); } });
  ws.on("error", e => log(`err ${e?.message||e}`));
}
function finish(){ console.log(`\n[smoke] RT1=${got1} RT2-after-reconnect=${got2} VERDICT: ${got1&&got2?"PASS":"FAIL"}`); try{ws.close()}catch{}; process.exit(got1&&got2?0:2); }
setTimeout(()=>{log("TIMEOUT");finish();}, 60000);
connect();
