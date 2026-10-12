/**
 * The companion app (/app): the screen half of Afterhours.
 *
 * Voice is the front door, but some things want a screen: the shape of the
 * night as a chart, managing alerts, and above all a phone that can be woken
 * by a notification when an alert fires at 2 a.m. The app is deliberately just
 * another MCP client of the same server. It signs in through the same OAuth
 * flow (as its own public client) and reads everything through the same tools
 * Alexa calls, so the two can never disagree.
 */

import { esc, layout } from "./pages.js";
import { LISTINGS } from "../market/universe.js";

const CSS = `
.app{max-width:760px;margin:0 auto;padding:16px 16px 72px}
.bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.chip{font-size:13px;color:var(--muted);display:flex;gap:8px;align-items:center}
.status{font-size:15px;color:var(--muted);margin:18px 0 4px}
.sec{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin:14px 0}
.sec h2{margin:0 0 10px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}
.total{font-size:34px;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.rowbtn{all:unset;box-sizing:border-box;width:100%;display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:11px 4px;border-top:1px solid var(--line);cursor:pointer;font-variant-numeric:tabular-nums}
.rowbtn:first-of-type{border-top:0}
.rowbtn:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:8px}
.rowbtn .sub{display:block;font-size:13px;color:var(--muted)}
.chart{padding:4px 0 10px}
.chart svg{width:100%;height:120px;display:block}
.chart .cap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px;font-size:12px;color:var(--muted)}
.alert{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)}
.alert:first-child{border-top:0}
.alert .when{font-size:13px;color:var(--accent)}
.form{display:grid;grid-template-columns:1.4fr 1fr 1fr auto;gap:8px;margin-top:12px}
@media (max-width:560px){.form{grid-template-columns:1fr 1fr}.form button{grid-column:span 2}}
select{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:11px 10px;font:inherit}
.link{all:unset;color:var(--muted);cursor:pointer;font-size:14px;text-decoration:underline}
.empty{color:var(--muted);font-size:15px}
.hero{padding:40px 0 10px}
.hero h1{font-size:34px;line-height:1.15}
`;

export function companionPage(p: { baseUrl: string; sample: boolean }): Response {
  const universe = LISTINGS.map((l) => ({ ticker: l.ticker, token: l.token, name: l.spoken }));
  const cfg = JSON.stringify({ base: p.baseUrl, resource: `${p.baseUrl}/mcp`, redirect: `${p.baseUrl}/app/`, universe, sample: p.sample }).replace(/</g, "\\u003c");

  const body = `<div class="app">
<header class="bar"><a class="brand" href="/"><span class="moon" aria-hidden="true"></span>Afterhours</a>
<div class="chip" id="who" hidden><span id="whoText" class="mono"></span><button class="link" id="signout">Sign out</button></div></header>

<main id="out" hidden><div class="hero">
<h1>Your tokenized stocks, at any hour.</h1>
<p class="muted">The same Afterhours you talk to, on a screen: the shape of the night, your alerts, and a phone that wakes you when one goes off.</p>
<button class="primary" id="signin">Sign in with your wallet</button>
${p.sample ? `<p class="small muted">This server runs on sample data; you can sign in with the sample portfolio.</p>` : ""}
</div></main>

<main id="in" hidden>
<h1 class="sr-only">Your Afterhours</h1>
<p class="status" id="status" aria-live="polite"></p>
<section class="sec" aria-labelledby="pTitle"><h2 id="pTitle">Your portfolio</h2><div id="portfolio"><p class="empty">Loading…</p></div></section>
<section class="sec" aria-labelledby="mTitle"><h2 id="mTitle">Biggest moves</h2><div id="movers"><p class="empty">Loading…</p></div></section>
<section class="sec" aria-labelledby="aTitle"><h2 id="aTitle">Alerts</h2><div id="alerts"></div>
<form class="form" id="alertForm"><label class="sr-only" for="aStock">Stock</label><select id="aStock"></select>
<label class="sr-only" for="aKind">Kind</label><select id="aKind"><option value="percent">moves %</option><option value="price">price $</option></select>
<label class="sr-only" for="aValue">Value</label><input id="aValue" type="number" step="any" min="0" required placeholder="2">
<button class="primary" type="submit">Add</button></form><p id="alertMsg" class="small" role="status"></p></section>
<section class="sec" aria-labelledby="tTitle"><h2 id="tTitle">Latest trade</h2><div id="trade"><p class="empty">No trade yet. Say "buy 25 dollars of Apple" to Alexa.</p></div></section>
<section class="sec" aria-labelledby="nTitle"><h2 id="nTitle">Notifications</h2><p id="pushText" class="muted" style="margin:0 0 10px">Get your alerts on this device the moment they go off, even at 2 a.m.</p>
<div class="row"><button class="primary" id="pushOn" hidden>Turn on</button><button id="pushTest" hidden>Send a test</button><button id="pushOff" hidden>Turn off</button></div></section>
</main></div>`;

  const script = `
const CFG=${cfg};const $=id=>document.getElementById(id);
const st={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch{}}};
const escH=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd=n=>"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const pct=n=>(n>0?"+":"")+Number(n).toFixed(2)+"%";
const cls=n=>n>=0?"up":"down";
const et=iso=>new Date(iso).toLocaleString("en-US",{weekday:"short",hour:"numeric",minute:"2-digit"});
const b64u=buf=>btoa(String.fromCharCode(...new Uint8Array(buf))).split("+").join("-").split("/").join("_").split("=").join("");
function claims(t){try{return JSON.parse(atob(t.split(".")[1].split("-").join("+").split("_").join("/")))}catch{return null}}

/* ---------- sign-in: the same OAuth 2.1 + PKCE flow Alexa uses ---------- */
async function signin(){const v=b64u(crypto.getRandomValues(new Uint8Array(32)));const s=b64u(crypto.getRandomValues(new Uint8Array(16)));
 st.set("ah_pkce",v);st.set("ah_state",s);const ch=b64u(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));
 const u=new URL(CFG.base+"/authorize");u.search=new URLSearchParams({response_type:"code",client_id:"afterhours-app",redirect_uri:CFG.redirect,code_challenge:ch,code_challenge_method:"S256",state:s,scope:"market portfolio trade",resource:CFG.resource});location.href=u}
async function tokenRequest(params){const r=await fetch(CFG.base+"/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:"afterhours-app",...params})});
 const j=await r.json();if(!r.ok)throw new Error(j.error_description||j.error);st.set("ah_at",j.access_token);st.set("ah_rt",j.refresh_token)}
async function finishSignin(){const q=new URLSearchParams(location.search);if(!q.has("code"))return;const hash=location.hash;history.replaceState({},"",CFG.redirect+hash);
 if(q.get("state")!==st.get("ah_state"))return;
 await tokenRequest({grant_type:"authorization_code",code:q.get("code"),redirect_uri:CFG.redirect,code_verifier:st.get("ah_pkce"),resource:CFG.resource}).catch(()=>{});
 st.set("ah_pkce",null);st.set("ah_state",null)}
async function refresh(){const rt=st.get("ah_rt");if(!rt)return false;try{await tokenRequest({grant_type:"refresh_token",refresh_token:rt});return true}catch{signout();return false}}
function signout(){st.set("ah_at",null);st.set("ah_rt",null);show()}

/* ---------- MCP: the app reads everything through Alexa's tools ---------- */
let rpcId=0;
async function tool(name,args){const call=()=>fetch(CFG.base+"/mcp",{method:"POST",headers:{authorization:"Bearer "+st.get("ah_at"),"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:++rpcId,method:"tools/call",params:{name,arguments:args||{}}})});
 let r=await call();if(r.status===401&&await refresh())r=await call();if(r.status===401){signout();throw new Error("signed out")}
 const j=await r.json();const res=j.result||{};const text=(res.content||[]).map(c=>c.text).join(" ");return {text,data:res.structuredContent||null,error:Boolean(res.isError)}}

/* ---------- the night, drawn ---------- */
async function chart(ticker,host){host.innerHTML="<p class=empty>Loading the night…</p>";
 const r=await fetch(CFG.base+"/api/tape?ticker="+encodeURIComponent(ticker));const t=await r.json();const pts=t.points||[];
 if(pts.length<2){host.innerHTML="<p class=empty>No overnight tape yet for "+escH(ticker)+"x. It fills in every 5 minutes.</p>";return}
 const W=600,H=120,P=8;const xs=pts.map(p=>Date.parse(p.at)),ys=pts.map(p=>p.gapPercent);
 const x0=xs[0],x1=xs[xs.length-1],lo=Math.min(0,...ys),hi=Math.max(0,...ys),span=(hi-lo)||1;
 const X=x=>P+(x-x0)/((x1-x0)||1)*(W-2*P),Y=y=>P+(hi-y)/span*(H-2*P);
 const path=pts.map((p,i)=>(i?"L":"M")+X(xs[i]).toFixed(1)+" "+Y(ys[i]).toFixed(1)).join(" ");
 const iHi=ys.indexOf(Math.max(...ys)),iLo=ys.indexOf(Math.min(...ys)),last=ys[ys.length-1];
 const label="Gap versus the last close for "+ticker+"x since "+et(t.since)+": now "+pct(last)+", high "+pct(ys[iHi])+" at "+et(pts[iHi].at)+", low "+pct(ys[iLo])+" at "+et(pts[iLo].at)+".";
 host.innerHTML="<svg viewBox='0 0 "+W+" "+H+"' preserveAspectRatio='none' role='img' aria-label='"+escH(label)+"'>"+
  "<line x1='0' x2='"+W+"' y1='"+Y(0).toFixed(1)+"' y2='"+Y(0).toFixed(1)+"' stroke='currentColor' stroke-opacity='.35' stroke-dasharray='4 4' vector-effect='non-scaling-stroke'/>"+
  "<path d='"+path+"' fill='none' stroke='"+(last>=0?"var(--up)":"var(--down)")+"' stroke-width='2' vector-effect='non-scaling-stroke' stroke-linejoin='round'/>"+
  "<circle cx='"+X(xs[iHi]).toFixed(1)+"' cy='"+Y(ys[iHi]).toFixed(1)+"' r='3' fill='var(--accent)'/><circle cx='"+X(x1).toFixed(1)+"' cy='"+Y(last).toFixed(1)+"' r='3.5' fill='currentColor'/></svg>"+
  "<div class=cap><span>since "+escH(et(t.since))+"</span><span>high "+pct(ys[iHi])+" · "+escH(et(pts[iHi].at))+"</span><span>now <b class="+cls(last)+">"+pct(last)+"</b></span></div>"}
function rows(list,host){host.innerHTML="";if(!list.length){host.innerHTML="<p class=empty>Nothing to show.</p>";return}
 for(const r of list){const b=document.createElement("button");b.className="rowbtn";b.setAttribute("aria-expanded","false");b.dataset.ticker=r.ticker;
  b.innerHTML="<span>"+escH(r.title)+"<span class=sub>"+escH(r.sub)+"</span></span><span>"+escH(r.right)+"</span><b class="+cls(r.sign)+">"+escH(r.change)+"</b>";
  const box=document.createElement("div");box.className="chart";box.hidden=true;
  b.onclick=()=>{const open=box.hidden;box.hidden=!open;b.setAttribute("aria-expanded",String(open));if(open)chart(r.ticker,box)};
  host.appendChild(b);host.appendChild(box)}}

async function loadPortfolio(){const r=await tool("my_portfolio");const host=$("portfolio");
 if(r.error||!r.data){host.innerHTML="<p class=empty>"+escH(r.text)+"</p>";return}
 const d=r.data;if(!d.positions.length){host.innerHTML="<p class=empty>"+escH(r.text)+"</p>";return}
 host.innerHTML="<div class=total>"+usd(d.totalUsd)+"</div><div class="+cls(d.changeUsd)+" style='margin-bottom:8px'>"+(d.changeUsd>=0?"+":"−")+usd(Math.abs(d.changeUsd))+" <span class=muted>since the close</span></div><div id=prows></div>";
 rows(d.positions.map(p=>({ticker:p.ticker,title:cap1(p.name),sub:p.amount+" "+p.ticker+"x",right:usd(p.valueUsd),change:p.changeUsd==null?"–":(p.changeUsd>=0?"+":"−")+usd(Math.abs(p.changeUsd)),sign:p.changeUsd||0})),$("prows"))}
async function loadStatus(){const r=await tool("market_status");$("status").textContent=r.text}
const cap1=s=>s.charAt(0).toUpperCase()+s.slice(1);
async function loadMovers(){const r=await tool("overnight_brief",{count:5});
 const d=r.data;if(!d){$("movers").innerHTML="<p class=empty>"+escH(r.text)+"</p>";return}
 rows(d.movers.map(m=>({ticker:m.ticker,title:cap1(m.name),sub:m.token+" vs "+m.comparedWith,right:usd(m.tokenPrice),change:pct(m.gapPercent),sign:m.gapPercent})),$("movers"))}
async function loadAlerts(){const r=await tool("list_alerts");const host=$("alerts");const list=(r.data&&r.data.alerts)||[];
 if(!list.length){host.innerHTML="<p class=empty>No alerts yet. Add one below, or say “tell me if Tesla moves more than 2 percent.”</p>";return}
 host.innerHTML="";for(const a of list){const div=document.createElement("div");div.className="alert";
  const what=a.kind==="price"?a.name+" "+a.direction+" "+usd(a.price):a.name+" moves "+a.thresholdPercent+"%";
  div.innerHTML="<span>"+escH(what)+"</span>";const x=document.createElement("button");x.textContent="Remove";x.setAttribute("aria-label","Remove "+what);
  x.onclick=async()=>{x.disabled=true;await tool("remove_alert",{stock:a.ticker});loadAlerts()};div.appendChild(x);host.appendChild(div)}}
async function loadTrade(){const r=await tool("trade_status");if(r.error||!r.data)return;const d=r.data;
 $("trade").innerHTML="<p style='margin:0 0 8px'>"+escH(r.text)+"</p>"+(d.status==="awaiting_signature"?"<a class='btn primary' href='/go?code="+encodeURIComponent(d.code)+"'>Review and sign</a>":"")}

$("alertForm").addEventListener("submit",async e=>{e.preventDefault();const v=Number($("aValue").value);if(!(v>0))return;
 const args={stock:$("aStock").value};args[$("aKind").value]=v;const r=await tool("set_alert",args);$("alertMsg").textContent=r.text;$("alertMsg").className="small "+(r.error?"err":"muted");if(!r.error){$("aValue").value="";loadAlerts()}});
$("aKind").onchange=()=>{$("aValue").placeholder=$("aKind").value==="price"?"400":"2"};

/* ---------- push: the phone that wakes you ---------- */
const canPush="serviceWorker" in navigator&&"PushManager" in window&&"Notification" in window;
function keyBytes(k){const s=k.split("-").join("+").split("_").join("/");const raw=atob(s+"===".slice((s.length+3)%4));return Uint8Array.from(raw,c=>c.charCodeAt(0))}
async function pushState(){if(!canPush){$("pushText").textContent="This browser can't receive push notifications. On iPhone, add Afterhours to your Home Screen first.";return}
 const reg=await navigator.serviceWorker.register("/sw.js");const sub=await reg.pushManager.getSubscription();
 $("pushOn").hidden=Boolean(sub);$("pushOff").hidden=!sub;$("pushTest").hidden=!sub;
 if(sub)$("pushText").textContent="On for this device. Alerts arrive here the moment they go off.";
 else if(Notification.permission==="denied"){$("pushText").textContent="Notifications are blocked for this site in your browser settings.";$("pushOn").hidden=true}}
async function authed(path,body){const go=()=>fetch(CFG.base+path,{method:"POST",headers:{authorization:"Bearer "+st.get("ah_at"),"content-type":"application/json"},body:JSON.stringify(body)});
 let r=await go();if(r.status===401&&await refresh())r=await go();return r.json()}
$("pushOn").onclick=async()=>{if(await Notification.requestPermission()!=="granted"){pushState();return}
 const reg=await navigator.serviceWorker.ready;const key=(await (await fetch(CFG.base+"/api/push/key")).json()).publicKey;
 try{const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(key)});const r=await authed("/api/push/subscribe",{subscription:sub.toJSON()});if(r.error)$("pushText").textContent=r.error}
 catch(e){$("pushText").textContent="Couldn't turn on notifications: "+e.message}pushState()};
$("pushTest").onclick=async()=>{const r=await authed("/api/push/test",{});$("pushText").textContent=r.delivered?"Sent. It should appear in a moment.":(r.error||"Nothing was delivered.")};
$("pushOff").onclick=async()=>{const reg=await navigator.serviceWorker.ready;const sub=await reg.pushManager.getSubscription();if(sub){await authed("/api/push/unsubscribe",{endpoint:sub.endpoint});await sub.unsubscribe()}pushState()};

async function show(){const t=st.get("ah_at");const c=t&&claims(t);$("out").hidden=Boolean(c);$("in").hidden=!c;$("who").hidden=!c;
 if(!c)return;$("whoText").textContent=(c.wallet?c.wallet.slice(0,4)+"…"+c.wallet.slice(-4):"")+(c.verified?" · signed":" · watch-only");
 $("aStock").innerHTML=CFG.universe.map(u=>"<option value='"+u.ticker+"'>"+escH(u.name.replace(/^the /,""))+" ("+u.token+")</option>").join("");
 await Promise.all([loadStatus(),loadMovers(),loadPortfolio(),loadAlerts(),loadTrade(),pushState()]).catch(()=>{});
 const deep=location.hash.slice(1).toUpperCase();if(deep){const b=document.querySelector(".rowbtn[data-ticker='"+deep+"']");if(b){b.click();b.scrollIntoView({block:"center"})}}}
$("signin").onclick=signin;$("signout").onclick=signout;
finishSignin().then(show);`;

  return layout("Afterhours", body, {
    script,
    head: `<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0b1020"><link rel="apple-touch-icon" href="/icons/192.png"><style>${CSS}</style>`,
  });
}

export { esc };
