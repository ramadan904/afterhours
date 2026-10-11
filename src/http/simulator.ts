/**
 * The Alexa+ simulator page.
 *
 * Alexa+'s MCP client isn't available to outside developers, so this page
 * plays its part end to end: it links an account through the server's real
 * OAuth 2.1 + PKCE flow (as the Alexa app would), sends what you say to the
 * planner, which calls the MCP endpoint with the linked token, and speaks the
 * reply. The right-hand panel shows every MCP call with its latency, so the
 * 500ms budget is visible rather than claimed.
 *
 * Unofficial: not made or endorsed by Amazon.
 */

import { esc, layout } from "./pages.js";

const CSS = `
.sim{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:20px;margin-top:18px}
@media (max-width:900px){.grid{grid-template-columns:1fr}}
.device{background:#05070f;border-radius:28px;padding:18px 18px 26px;box-shadow:0 30px 60px -30px #000,inset 0 0 0 1px #1d2440;position:relative}
.screen{background:linear-gradient(160deg,#0f1733,#0a0f22 60%);border-radius:16px;min-height:430px;padding:20px;display:flex;flex-direction:column;gap:14px;color:#e9ecf7;overflow:hidden}
.lightbar{position:absolute;left:18%;right:18%;bottom:10px;height:5px;border-radius:5px;background:#1d2440;transition:background .2s,box-shadow .2s}
.lightbar.listening{background:#22d3ee;box-shadow:0 0 18px #22d3ee}
.lightbar.thinking{background:linear-gradient(90deg,#22d3ee,#6366f1,#22d3ee);background-size:200% 100%;animation:flow 1.1s linear infinite}
.lightbar.speaking{background:#38bdf8;box-shadow:0 0 14px #38bdf8;animation:pulse 1s ease-in-out infinite}
@keyframes flow{to{background-position:-200% 0}}@keyframes pulse{50%{opacity:.55}}
@media (prefers-reduced-motion:reduce){.lightbar{animation:none!important}}
.clock{font:600 13px/1 ui-monospace,monospace;color:#9aa4c4;display:flex;justify-content:space-between}
.visual{flex:1;display:flex;flex-direction:column;justify-content:center;gap:10px;min-height:220px}
.hello{font-size:26px;font-weight:650;line-height:1.25}
.hello small{display:block;font-size:15px;font-weight:400;color:#9aa4c4;margin-top:8px}
.big{font-size:44px;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.label{font-size:13px;color:#9aa4c4;text-transform:uppercase;letter-spacing:.08em}
.bars{display:flex;flex-direction:column;gap:8px}
.bar{display:grid;grid-template-columns:110px 1fr 72px;align-items:center;gap:10px;font-size:15px}
.bar .track{height:10px;background:#1a2244;border-radius:6px;position:relative;overflow:hidden}
.bar .fill{position:absolute;top:0;bottom:0;border-radius:6px}
.bar .v{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:#4ade80}.neg{color:#f87171}.fill.pos{background:#4ade80}.fill.neg{background:#f87171}
.codebox{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.digits{font:700 46px/1 ui-monospace,monospace;letter-spacing:.18em;color:#ffb547}
.qr{background:#fff;border-radius:10px;padding:8px;width:132px;height:132px}
.qr img,.qr canvas,.qr svg{width:100%;height:100%}
.said{font-size:15px;color:#c9d0ea;border-left:3px solid #ffb547;padding-left:10px}
.you{font-size:14px;color:#9aa4c4}
.input{display:flex;gap:8px;margin-top:14px}
.mic{width:48px;height:48px;border-radius:50%;justify-content:center;padding:0;flex:none}
.mic.on{background:#22d3ee;color:#04202a;border-color:transparent}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.chip{font-size:13px;padding:6px 10px;border-radius:999px;font-weight:500}
.panel h2{margin:0 0 8px;font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.step{border:1px solid var(--line);border-radius:12px;padding:12px;margin:10px 0;background:var(--panel)}
.step header{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.step .name{font-family:ui-monospace,monospace;font-weight:700}
.ms{font:600 12px ui-monospace,monospace;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.ms.ok{color:var(--up)}.ms.slow{color:var(--down)}
.step pre{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:8px 0 0;color:var(--muted);max-height:220px;overflow:auto}
.step .args{font-size:13px;color:var(--muted);font-family:ui-monospace,monospace;margin-top:4px;word-break:break-word}
.acct{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.card-frame{width:100%;height:220px;border:0;border-radius:12px;background:transparent;display:block}
.disclaimer{font-size:12px;color:var(--muted);margin-top:16px}
`;

export function simulatorPage(p: { baseUrl: string; sample: boolean }): Response {
  const body = `<div class="sim">
<div class="top"><a class="brand" href="/"><span class="moon" aria-hidden="true"></span>Afterhours <span class="pill" style="margin-left:6px">Alexa+ simulator · unofficial</span></a>
<span class="pill">${p.sample ? "Sample data" : "Live data · Solana mainnet"}</span></div>
<div class="grid">
<section aria-label="Simulated Echo Show">
  <div class="device"><div class="screen">
    <div class="clock"><span id="clock"></span><span id="mkt"></span></div>
    <div class="visual" id="visual" aria-live="polite"><div class="hello">Ask about your tokenized stocks.<small>Try “What happened overnight?” Link your account first to hear your portfolio.</small></div></div>
    <div id="said" class="said" hidden></div><div id="you" class="you" hidden></div>
  </div><div class="lightbar" id="light" aria-hidden="true"></div></div>
  <form class="input" id="ask" autocomplete="off">
    <button type="button" class="mic" id="mic" aria-label="Speak" title="Tap to speak">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
    <label for="q" class="sr-only" style="position:absolute;left:-9999px">Say something</label>
    <input id="q" placeholder="“Alexa, what happened overnight?”">
    <button class="primary" type="submit">Ask</button>
  </form>
  <div class="chips" id="chips"></div>
  <label class="small muted" style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="speak" checked style="width:auto"> Speak replies aloud</label>
</section>
<section class="panel" aria-label="Under the hood">
  <div class="card" style="margin-top:0"><h2>Account linking</h2><div class="acct"><div id="acct" class="small">Not linked.</div><div class="row"><button id="link" class="primary">Link account</button><button id="unlink" hidden>Unlink</button></div></div>
  <p class="small muted" style="margin:8px 0 0">OAuth 2.1 + PKCE against this server, the same flow the Alexa app runs.</p></div>
  <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">MCP calls</h2><span class="pill" id="planner">planner: –</span></div>
  <p class="small muted" style="margin:6px 0 0">Streamable HTTP · <span class="mono">${esc(p.baseUrl)}/mcp</span> · Alexa+ budget: 500 ms per call</p>
  <div id="trace"><p class="small muted">Each tool call shows up here with its arguments, latency and result.</p></div></div>
  <p class="disclaimer">Unofficial simulator for development and demos. Alexa and Echo are trademarks of Amazon; this page is not made or endorsed by Amazon. Not investment advice.</p>
</section></div></div>`;

  const cfg = JSON.stringify({ base: p.baseUrl, resource: `${p.baseUrl}/mcp`, redirect: `${p.baseUrl}/sim/` }).replace(/</g, "\\u003c");
  const script = `
const CFG=${cfg};const $=id=>document.getElementById(id);
const store={get(k){try{return sessionStorage.getItem(k)}catch{return null}},set(k,v){try{v==null?sessionStorage.removeItem(k):sessionStorage.setItem(k,v)}catch{}}};
let convo=[];
const CHIPS=["What happened overnight?","How's Tesla doing?","Is the Nvidia token trading rich?","How's my portfolio?","Tell me if Coinbase moves more than 3 percent","Buy 25 dollars of Apple","Did my trade go through?","Is the stock market open?"];
for(const c of CHIPS){const b=document.createElement("button");b.type="button";b.className="chip";b.textContent=c;b.onclick=()=>ask(c);$("chips").appendChild(b)}
function tick(){const d=new Date();$("clock").textContent=d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"});
 $("mkt").textContent="New York "+d.toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"numeric",minute:"2-digit"})}
tick();setInterval(tick,15000);
const b64u=buf=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
function claims(t){try{return JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")))}catch{return null}}
function showAccount(){const t=store.get("at");const c=t&&claims(t);
 if(!c){$("acct").textContent="Not linked.";$("link").hidden=false;$("unlink").hidden=true;return}
 const w=c.wallet?c.wallet.slice(0,4)+"…"+c.wallet.slice(-4):"no wallet";
 $("acct").innerHTML="Linked: <span class=mono>"+w+"</span> "+(c.verified?"<span class=pill>signed</span>":"<span class=pill>watch-only</span>");
 $("link").hidden=true;$("unlink").hidden=false}
async function link(){const v=b64u(crypto.getRandomValues(new Uint8Array(32)));const s=b64u(crypto.getRandomValues(new Uint8Array(16)));
 store.set("pkce",v);store.set("state",s);const ch=b64u(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));
 const u=new URL(CFG.base+"/authorize");u.search=new URLSearchParams({response_type:"code",client_id:"afterhours-simulator",redirect_uri:CFG.redirect,code_challenge:ch,code_challenge_method:"S256",state:s,scope:"market portfolio trade",resource:CFG.resource});location.href=u}
async function tokenRequest(params){const r=await fetch(CFG.base+"/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:"afterhours-simulator",...params})});
 const j=await r.json();if(!r.ok)throw new Error(j.error_description||j.error);store.set("at",j.access_token);store.set("rt",j.refresh_token);showAccount()}
async function finishLink(){const q=new URLSearchParams(location.search);if(!q.has("code")&&!q.has("error"))return;window.history.replaceState({}, "", CFG.redirect);
 if(q.get("error")){$("acct").textContent="Linking failed: "+(q.get("error_description")||q.get("error"));return}
 if(q.get("state")!==store.get("state")){$("acct").textContent="Linking failed: state mismatch.";return}
 try{await tokenRequest({grant_type:"authorization_code",code:q.get("code"),redirect_uri:CFG.redirect,code_verifier:store.get("pkce"),resource:CFG.resource})}catch(e){$("acct").textContent="Linking failed: "+e.message}
 store.set("pkce",null);store.set("state",null)}
async function refresh(){const rt=store.get("rt");if(!rt)return false;try{await tokenRequest({grant_type:"refresh_token",refresh_token:rt});return true}catch{store.set("at",null);store.set("rt",null);showAccount();return false}}
$("link").onclick=link;$("unlink").onclick=()=>{store.set("at",null);store.set("rt",null);showAccount()};
const light=s=>{$("light").className="lightbar "+(s||"")};
const pct=n=>(n>0?"+":"")+n.toFixed(2)+"%";const usd=n=>"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const escH=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function bars(rows){const max=Math.max(1,...rows.map(r=>Math.abs(r.v)));return "<div class=bars>"+rows.map(r=>"<div class=bar><span>"+escH(r.k)+"</span><span class=track><span class='fill "+(r.v>=0?"pos":"neg")+"' style='left:0;width:"+(Math.abs(r.v)/max*100).toFixed(1)+"%'></span></span><span class='v "+(r.v>=0?"pos":"neg")+"'>"+escH(r.t)+"</span></div>").join("")+"</div>"}
let bridge=null;
/* A minimal MCP Apps host: renders the tool's ui:// card in a sandboxed
   iframe and speaks the MCP Apps postMessage protocol with it. */
function mountCard(step){const v=$("visual");v.innerHTML="";const f=document.createElement("iframe");
 f.setAttribute("sandbox","allow-scripts");f.setAttribute("title","Afterhours card");f.className="card-frame";f.srcdoc=step.ui.html;v.appendChild(f);
 if(bridge)window.removeEventListener("message",bridge);
 const reply=(id,result)=>f.contentWindow.postMessage({jsonrpc:"2.0",id,result},"*");
 bridge=e=>{if(e.source!==f.contentWindow)return;const m=e.data;if(!m||m.jsonrpc!=="2.0")return;
  if(m.method==="ui/initialize")reply(m.id,{protocolVersion:"2026-01-26",hostInfo:{name:"Afterhours Alexa+ simulator",version:"1"},hostCapabilities:{openLinks:{}},hostContext:{theme:"dark",displayMode:"inline",availableDisplayModes:["inline"],platform:"web",locale:"en-US",timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,toolInfo:{tool:{name:step.tool}}}});
  else if(m.method==="ui/notifications/initialized"){f.contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-input",params:{arguments:step.args}},"*");
   f.contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{content:[{type:"text",text:step.text}],structuredContent:step.structured}},"*")}
  else if(m.method==="ui/notifications/size-changed"&&m.params)f.style.height=Math.min(420,Math.max(80,m.params.height))+"px";
  else if(m.method==="ui/open-link"){const u=String(m.params&&m.params.url||"");const ok=u.startsWith("https://")||u.startsWith("http://");if(ok)window.open(m.params.url,"_blank","noopener");reply(m.id,ok?{}:{isError:true})}
  else if(m.id!==undefined)f.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Not supported"}},"*")};
 window.addEventListener("message",bridge)}
function visual(step,reply){const d=step&&step.structured;const v=$("visual");if(step&&step.ui&&!step.isError){mountCard(step);return}if(!d||step.isError){v.innerHTML="<div class=hello>"+escH(reply)+"</div>";return}
 switch(step.tool){
 case "overnight_brief":v.innerHTML="<div class=label>"+escH(d.marketPhase)+" · biggest moves"+(d.dataSource==="sample"?" · sample data":"")+"</div>"+(d.movers.length?bars(d.movers.map(m=>({k:m.token,v:m.gapPercent,t:pct(m.gapPercent)}))):"<div class=hello>All quiet.</div>");break;
 case "check_stock":v.innerHTML="<div class=label>"+escH(d.token)+" vs "+escH(d.comparedWith)+"</div><div class=big>"+usd(d.tokenPrice)+"</div><div class='hello "+((d.gapPercent||0)>=0?"pos":"neg")+"'>"+(d.gapPercent==null?"no reference":pct(d.gapPercent))+"<small>share "+(d.sharePrice?usd(d.sharePrice):"–")+" · "+escH(d.kind.replace("_"," "))+"</small></div>";break;
 case "my_portfolio":v.innerHTML="<div class=label>Portfolio"+(d.dataSource==="sample"?" · sample data":"")+"</div><div class=big>"+usd(d.totalUsd)+"</div><div class='"+(d.changeUsd>=0?"pos":"neg")+"'>"+(d.changeUsd>=0?"+":"−")+usd(Math.abs(d.changeUsd))+"</div>"+bars(d.positions.map(p=>({k:p.ticker+"x",v:p.changeUsd||0,t:usd(p.valueUsd)})));break;
 case "propose_trade":case "trade_status":{const url=d.confirmUrl;v.innerHTML="<div class=label>"+escH(d.side)+" "+usd(d.usd)+" of "+escH(d.ticker)+"x · "+escH(d.status.replace("_"," "))+"</div><div class=codebox><div><div class=digits>"+escH(d.code)+"</div><a href='"+escH(url)+"' target=_blank rel=noopener class=small>"+escH(url.replace(/^https?:\\/\\//,""))+"</a></div><div class=qr id=qr aria-label='QR code for the confirm page'></div></div>";
  const qrPath=new URL(url).pathname+new URL(url).search;$("qr").innerHTML="<img alt='' src='/qr.svg?path="+encodeURIComponent(qrPath)+"'>";break}
 default:v.innerHTML="<div class=hello>"+escH(reply)+"</div>"}}
function trace(turn){const t=$("trace");$("planner").textContent="planner: "+turn.planner+(turn.fallbackReason?" (fallback)":"");
 if(!turn.steps.length){t.innerHTML="<p class='small muted'>No tool call for that.</p>";return}
 t.innerHTML=turn.steps.map(s=>"<div class=step><header><span class=name>"+escH(s.tool)+"</span><span class='ms "+(s.ms<500?"ok":"slow")+"'>"+s.ms+" ms</span></header><div class=args>"+escH(JSON.stringify(s.args))+(s.ui?" <span class=pill title='MCP Apps card rendered on the screen'>"+escH(s.ui.uri)+"</span>":"")+"</div><pre>"+escH(s.text)+"</pre>"+(s.structured?"<details><summary class='small muted'>structuredContent</summary><pre>"+escH(JSON.stringify(s.structured,null,2))+"</pre></details>":"")+"</div>").join("")}
function say(text){if(!$("speak").checked||!("speechSynthesis" in window)){light("");return}
 speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.rate=1.02;const en=speechSynthesis.getVoices().find(v=>/en-US/.test(v.lang)&&/Samantha|Google US|Joanna|Aria|Jenny/.test(v.name));if(en)u.voice=en;
 u.onstart=()=>light("speaking");u.onend=()=>light("");speechSynthesis.speak(u)}
async function ask(text){text=text.trim();if(!text)return;$("q").value="";$("you").hidden=false;$("you").textContent="You: “"+text+"”";$("said").hidden=true;light("thinking");
 const send=()=>fetch(CFG.base+"/sim/api/turn",{method:"POST",headers:{"content-type":"application/json",...(store.get("at")?{authorization:"Bearer "+store.get("at")}:{})},body:JSON.stringify({utterance:text,history:convo})});
 let r=await send();if(r.status===401&&await refresh())r=await send();
 const j=await r.json().catch(()=>({error:"Bad response"}));
 if(!r.ok){light("");$("visual").innerHTML="<div class=hello>"+escH(j.error)+"</div>";if(r.status===401)$("link").focus();return}
 convo.push({role:"user",text},{role:"assistant",text:j.reply});convo=convo.slice(-8);
 $("said").hidden=false;$("said").textContent=j.reply;visual(j.steps[j.steps.length-1],j.reply);trace(j);say(j.reply)}
$("ask").addEventListener("submit",e=>{e.preventDefault();ask($("q").value)});
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
if(!SR){$("mic").hidden=true}else{const rec=new SR();rec.lang="en-US";rec.interimResults=true;let on=false;
 rec.onresult=e=>{const r=e.results[e.results.length-1];$("q").value=r[0].transcript.replace(/^alexa,?\\s*/i,"");if(r.isFinal){ask($("q").value)}};
 rec.onend=()=>{on=false;$("mic").classList.remove("on");if($("light").className.includes("listening"))light("")};
 $("mic").onclick=()=>{if(on){rec.stop();return}speechSynthesis&&speechSynthesis.cancel();on=true;$("mic").classList.add("on");light("listening");rec.start()}}
showAccount();finishLink();`;
  return layout("Alexa+ simulator · Afterhours", body, {
    script,
    head: `<style>${CSS}</style>`,
  });
}
