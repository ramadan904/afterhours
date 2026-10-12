/**
 * Server-rendered pages. No build step and no framework: each page is a string
 * with a little inline script, so the whole product deploys as one process.
 */

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const STYLE = `
:root{--bg:#0b1020;--panel:#121a33;--panel-2:#18213f;--ink:#e9ecf7;--muted:#9aa4c4;--line:#26305a;--accent:#ffb547;--accent-ink:#1b1300;--up:#4ade80;--down:#f87171;--focus:#8ab4ff;color-scheme:dark}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f6f4ef;--panel:#fff;--panel-2:#f1eee6;--ink:#141a2e;--muted:#5b6380;--line:#e2ddd0;--accent:#9a5c00;--accent-ink:#fff;--up:#15803d;--down:#b91c1c;--focus:#1d4ed8;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0}[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
body{background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
.wrap{max-width:720px;margin:0 auto;padding:32px 16px 64px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2px;color:var(--ink);text-decoration:none}
.moon{width:22px;height:22px;border-radius:50%;box-shadow:inset -6px -2px 0 0 var(--accent);transform:rotate(-20deg)}
h1{font-size:28px;line-height:1.2;margin:24px 0 8px}h2{font-size:18px;margin:28px 0 8px}
.muted{color:var(--muted)}.small{font-size:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
button,.btn{appearance:none;border:1px solid var(--line);background:var(--panel-2);color:var(--ink);border-radius:10px;padding:11px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px}
button.primary,.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:transparent}
button:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
input{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
.code-input{font:600 28px/1 ui-monospace,monospace;letter-spacing:.35em;text-align:center}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:13px;color:var(--muted)}
.up{color:var(--up)}.down{color:var(--down)}
.err{color:var(--down)}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}
`;

export function layout(title: string, body: string, opts: { script?: string; head?: string } = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="color-scheme" content="dark light">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%230b1020'/%3E%3Cpath d='M20 6a10 10 0 1 0 6 16A11 11 0 0 1 20 6z' fill='%23ffb547'/%3E%3C/svg%3E">
<style>${STYLE}</style>${opts.head ?? ""}</head><body>${body}${opts.script ? `<script>${opts.script}</script>` : ""}</body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

const header = `<a class="brand" href="/"><span class="moon" aria-hidden="true"></span>Afterhours</a>`;

export function errorPage(message: string, status = 400): Response {
  const res = layout("Afterhours", `<main class="wrap">${header}<h1>Something's not right</h1><p>${esc(message)}</p></main>`);
  return new Response(res.body, { status, headers: res.headers });
}

/**
 * Shared browser helper: Solana wallets via the Wallet Standard.
 *
 * Phantom, Solflare, Backpack and other modern wallets register themselves
 * through the Wallet Standard events, and its features take raw bytes: a
 * message to sign, or a serialized transaction to sign and send. So the pages
 * need no Solana library at all, and nothing is loaded from a CDN.
 */
const WALLET_JS = `
const FOUND=[];let onWallets=()=>{};
function register(...ws){for(const w of ws){if(!FOUND.includes(w)&&(w.chains||[]).some(c=>c.startsWith("solana:"))&&w.features&&w.features["standard:connect"]){FOUND.push(w)}}onWallets();return()=>{}}
window.addEventListener("wallet-standard:register-wallet",e=>{try{e.detail({register})}catch{}});
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready",{detail:{register}}));
function wallets(){return FOUND.map(w=>[w.name,w])}
async function connectWallet(w){const r=await w.features["standard:connect"].connect();const account=(r&&r.accounts&&r.accounts[0])||w.accounts[0];if(!account)throw new Error("The wallet didn't share an account.");return {account,address:account.address}}
async function signText(w,account,bytes){const f=w.features["solana:signMessage"];if(!f)throw new Error(w.name+" can't sign messages.");const [out]=await f.signMessage({account,message:bytes});return out.signature}
async function signAndSend(w,account,tx){const f=w.features["solana:signAndSendTransaction"];if(!f)throw new Error(w.name+" can't send transactions.");const [out]=await f.signAndSendTransaction({account,transaction:tx,chain:"solana:mainnet"});return b58(out.signature)}
function b64(bytes){let s="";bytes.forEach(b=>s+=String.fromCharCode(b));return btoa(s)}
function fromB64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
function b58(bytes){const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let d=[],out="";
 for(const byte of bytes){let carry=byte;for(let j=0;j<d.length;j++){carry+=d[j]<<8;d[j]=carry%58;carry=carry/58|0}while(carry){d.push(carry%58);carry=carry/58|0}}
 for(const byte of bytes){if(byte!==0)break;out+="1"}for(let k=d.length-1;k>=0;k--)out+=A[d[k]];return out}
`;

export function authorizePage(p: {
  clientName: string;
  requestToken: string;
  host: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  sample: boolean;
  scope: string;
}): Response {
  const body = `<main class="wrap">${header}
<h1>Link Afterhours to ${esc(p.clientName)}</h1>
<p class="muted">So ${esc(p.clientName)} can tell you about <em>your</em> tokenized stocks, link the Solana wallet that holds them.</p>
<div class="card">
  <h2 style="margin-top:0">Sign in with your wallet</h2>
  <p class="small muted">Your wallet will ask you to sign a short message. Signing is free and can't move funds; it only proves the wallet is yours.</p>
  <div class="row" id="walletButtons"></div>
  <p id="noWallet" class="small muted" hidden>No Solana wallet found in this browser. Open this page in Phantom, Solflare or Backpack, or use a watch-only address below.</p>
  <p id="walletError" class="small err" role="alert"></p>
</div>
<div class="card">
  <h2 style="margin-top:0">Or watch an address (read-only)</h2>
  <p class="small muted">Afterhours reads its public balances. Any trade you propose still has to be signed by that address's own wallet.</p>
  <form method="post" action="/authorize" class="row">
    <input type="hidden" name="request" value="${esc(p.requestToken)}"><input type="hidden" name="mode" value="watch">
    <label for="addr" class="small muted" style="width:100%">Solana address or .sol name</label>
    <input id="addr" name="address" required pattern="[1-9A-HJ-NP-Za-km-z]{32,44}|[A-Za-z0-9\\-]+(\\.[A-Za-z0-9\\-]+)*\\.sol" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Address, or a name like toly.sol">
    <button type="submit">Link watch-only</button>
  </form>
</div>
${p.sample ? `<div class="card"><h2 style="margin-top:0">Demo</h2><p class="small muted">This server runs on sample data. Link the sample portfolio to try everything without a wallet.</p>
<form method="post" action="/authorize"><input type="hidden" name="request" value="${esc(p.requestToken)}"><input type="hidden" name="mode" value="sample"><button class="primary" type="submit">Use the sample portfolio</button></form></div>` : ""}
<p class="small muted">Access requested: ${esc(p.scope)}. Afterhours stores your wallet address and nothing else. You can unlink at any time in ${esc(p.clientName)}.</p>
<form id="signed" method="post" action="/authorize" hidden>
  <input type="hidden" name="request" value="${esc(p.requestToken)}"><input type="hidden" name="mode" value="wallet">
  <input type="hidden" name="address"><input type="hidden" name="message"><input type="hidden" name="signature">
  <input type="hidden" name="issuedAt" value="${esc(p.issuedAt)}"><input type="hidden" name="expiresAt" value="${esc(p.expiresAt)}">
</form>
</main>`;
  const cfg = JSON.stringify({ host: p.host, uri: p.uri, nonce: p.nonce, issuedAt: p.issuedAt, expiresAt: p.expiresAt });
  const script = `${WALLET_JS}
const CFG=${cfg.replace(/</g, "\\u003c")};
function message(address){return [CFG.host+" wants you to link your Solana account to Alexa:",address,"","Afterhours can read your tokenized stock balances. It can never move funds: every trade needs your signature in this wallet.","","URI: "+CFG.uri,"Version: 1","Chain ID: mainnet","Nonce: "+CFG.nonce,"Issued At: "+CFG.issuedAt,"Expiration Time: "+CFG.expiresAt].join("\\n")}
function render(){const box=document.getElementById("walletButtons");box.innerHTML="";const found=wallets();
 document.getElementById("noWallet").hidden=found.length>0;
 for(const [name,w] of found){const b=document.createElement("button");b.className="primary";b.textContent="Sign in with "+name;b.onclick=()=>link(w,b);box.appendChild(b)}}
async function link(w,b){const err=document.getElementById("walletError");err.textContent="";b.disabled=true;
 try{const {account,address}=await connectWallet(w);const msg=message(address);const sig=await signText(w,account,new TextEncoder().encode(msg));
  const f=document.getElementById("signed");f.address.value=address;f.message.value=msg;f.signature.value=b64(new Uint8Array(sig));f.submit()}
 catch(e){err.textContent=(e&&e.message)||"The wallet didn't sign. Nothing was shared.";b.disabled=false}}
onWallets=render;render();setTimeout(render,800);`;
  return layout("Link Afterhours", body, { script });
}

export function landingPage(p: { baseUrl: string; sample: boolean; repoUrl: string }): Response {
  const body = `<main class="wrap">${header}
<h1>Your tokenized stocks, by voice, at any hour.</h1>
<p class="muted">The stock market is open about 33 hours a week. Tokenized stocks trade all 168. Afterhours is an Alexa+ add-on that tells you what moved while the market was shut, what your wallet is worth, and lets you propose a trade by voice. The trade only happens when you sign it in your own wallet.</p>
<div class="row"><a class="btn primary" href="/sim/">Try it in the Alexa+ simulator</a><a class="btn" href="/app/">Open the app</a><a class="btn" href="/go">Confirm a trade</a><a class="btn" href="${esc(p.repoUrl)}">Source</a></div>
<div class="card">
<h2 style="margin-top:0">Ask Alexa</h2>
<ul>
<li>"What happened overnight?"</li><li>"How's Tesla doing?" / "Is the Nvidia token trading rich?"</li>
<li>"How's my portfolio?"</li><li>"Tell me if Coinbase moves more than 3 percent."</li>
<li>"Buy 25 dollars of Apple." → Alexa reads you a code to sign</li><li>"Did my trade go through?"</li>
</ul></div>
<div class="card">
<h2 style="margin-top:0">Connect an MCP client</h2>
<dl><dt>Endpoint</dt><dd class="mono">${esc(p.baseUrl)}/mcp</dd>
<dt>Transport</dt><dd>Streamable HTTP, MCP 2025-11-25</dd>
<dt>Auth</dt><dd>OAuth 2.1 + PKCE (S256). <a href="/.well-known/oauth-protected-resource">Resource metadata</a> · <a href="/.well-known/oauth-authorization-server">Server metadata</a></dd>
<dt>Data</dt><dd>${p.sample ? "Sample data (offline mode)" : "Live: Jupiter prices and Solana mainnet balances"}</dd></dl>
</div>
<p class="small muted">Not investment advice. Afterhours holds no keys and cannot sign transactions.</p>
</main>`;
  return layout("Afterhours", body);
}

export function confirmPage(p: { code: string }): Response {
  const body = `<main class="wrap">${header}
<h1>Confirm a trade</h1>
<p class="muted">Enter the six-digit code Alexa read to you. You'll see a fresh quote, then sign in your own wallet. Nothing happens until you sign.</p>
<div class="card"><form id="lookup" class="row" autocomplete="off">
<label for="code" class="small muted" style="width:100%">Code</label>
<input id="code" class="code-input" inputmode="numeric" pattern="[0-9 ]{6,11}" maxlength="11" required value="${esc(p.code)}" aria-describedby="lookupErr">
<button class="primary" type="submit" style="width:100%;justify-content:center">Find my trade</button>
<p id="lookupErr" class="small err" role="alert"></p></form></div>
<div class="card" id="intent" hidden>
<div class="row" style="justify-content:space-between"><h2 style="margin:0" id="title"></h2><span class="pill" id="status"></span></div>
<dl style="margin-top:12px" id="facts"></dl>
<div id="quote" class="small muted" style="margin-top:12px"></div>
<div class="row" style="margin-top:16px" id="actions"></div>
<p id="msg" class="small" role="status" aria-live="polite"></p>
<div id="phone" hidden style="margin-top:16px;border-top:1px solid var(--line);padding-top:16px">
<h3 style="margin:0 0 8px;font-size:16px">Or sign on your phone</h3>
<div class="row" style="align-items:center;flex-wrap:nowrap"><img id="payQr" width="148" height="148" alt="QR code that opens this trade in a phone wallet" style="background:#fff;border-radius:8px;padding:6px;flex:none">
<p class="small muted" style="margin:0">Scan with Phantom, Solflare or Backpack. Your wallet fetches a fresh quote for this trade and signs it there. This page updates when Solana confirms it.</p></div>
</div>
</div>
</main>`;
  const script = `${WALLET_JS}
const $=id=>document.getElementById(id);let current=null;
const money=n=>"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const short=a=>a.slice(0,4)+"…"+a.slice(-4);
const STATUS={awaiting_signature:"Waiting for your signature",submitted:"Sent, confirming…",confirmed:"Confirmed on Solana",failed:"Not confirmed",expired:"Expired"};
async function api(path,body){const r=await fetch(path,body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{});const j=await r.json().catch(()=>({error:"Bad response"}));if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j}
function show(i){current=i;$("intent").hidden=false;$("title").textContent=(i.side==="buy"?"Buy ":"Sell ")+money(i.usd)+" of "+i.token;
 $("status").textContent=STATUS[i.status]||i.status;
 $("facts").innerHTML="<dt>Wallet</dt><dd class=mono>"+short(i.wallet)+"</dd><dt>Price when asked</dt><dd>"+money(i.priceAtProposal)+"</dd><dt>Pays with</dt><dd>"+(i.side==="buy"?"USDC":i.token)+"</dd><dt>Expires</dt><dd>"+new Date(i.expiresAt).toLocaleTimeString()+"</dd>"+(i.signature?"<dt>Transaction</dt><dd><a href='https://solscan.io/tx/"+i.signature+"' target=_blank rel=noopener>"+short(i.signature)+"</a></dd>":"");
 const a=$("actions");a.innerHTML="";
 if(i.status==="awaiting_signature"){const found=wallets();if(!found.length){$("msg").textContent="No wallet in this browser. Open this trade in your wallet's app to sign, or scan the code below with it.";
   const here=encodeURIComponent(location.origin+"/go/"+i.code),ref=encodeURIComponent(location.origin);
   for(const [name,href] of [["Phantom","https://phantom.app/ul/browse/"+here+"?ref="+ref],["Solflare","https://solflare.com/ul/v1/browse/"+here+"?ref="+ref]]){const l=document.createElement("a");l.className="btn primary";l.href=href;l.textContent="Open in "+name;a.appendChild(l)}}
  for(const [name,w] of found){const b=document.createElement("button");b.className="primary";b.textContent="Review & sign with "+name;b.onclick=()=>sign(w,b);a.appendChild(b)}
  const c=document.createElement("button");c.textContent="Cancel";c.onclick=cancel;a.appendChild(c)}
 if(i.status==="failed")$("msg").textContent=i.error?"Not confirmed: "+i.error+".":"The swap failed. Nothing was filled.";
 if(i.status==="confirmed")$("msg").textContent="Done. Alexa can tell you it went through.";
 const phone=i.status==="awaiting_signature";$("phone").hidden=!phone;if(phone&&!$("payQr").src)$("payQr").src="/qr.svg?pay="+i.code;
 clearTimeout(window.__poll);if(i.status==="submitted")window.__poll=setTimeout(poll,2500);else if(phone)window.__poll=setTimeout(poll,6000)}
async function lookup(e){e&&e.preventDefault();$("lookupErr").textContent="";const code=$("code").value.replace(/\\D/g,"");
 try{show(await api("/api/trade?code="+code))}catch(err){$("lookupErr").textContent=err.message}}
async function sign(w,b){b.disabled=true;$("msg").textContent="Connecting…";
 try{const {account,address:addr}=await connectWallet(w);if(addr!==current.wallet)throw new Error("This is "+short(addr)+". The trade was proposed for "+short(current.wallet)+": switch accounts in your wallet.");
  $("msg").textContent="Getting a fresh quote…";const built=await api("/api/trade/build",{code:current.code});
  $("quote").textContent="Fresh quote: you pay "+built.pay+" and receive about "+built.receive+" (price impact "+built.impact+", max slippage "+built.slippage+").";
  $("msg").textContent="Approve it in your wallet…";const sig=await signAndSend(w,account,fromB64(built.transaction));
  show(await api("/api/trade/submitted",{code:current.code,signature:sig}));$("msg").textContent="Sent. Waiting for Solana to confirm…"}
 catch(e){$("msg").textContent=(e&&e.message)||"Not signed. Nothing was sent.";b.disabled=false}}
async function cancel(){try{show(await api("/api/trade/cancel",{code:current.code}));$("msg").textContent="Cancelled."}catch(e){$("msg").textContent=e.message}}
async function poll(){try{show(await api("/api/trade?code="+current.code))}catch{}}
onWallets=()=>{if(current)show(current)};
$("lookup").addEventListener("submit",lookup);if($("code").value)lookup();`;
  return layout("Confirm a trade · Afterhours", body, { script });
}
