/**
 * Visual cards for screens, as MCP Apps.
 *
 * Alexa+ runs on devices with screens (Echo Show, Fire TV) as well as
 * speakers. A spoken answer is the whole product on a speaker; on a screen,
 * the same answer should also be *seen*. MCP Apps is the MCP extension for
 * that: a tool names a `ui://` resource in its `_meta.ui.resourceUri`, and a
 * host that supports MCP Apps fetches that HTML, renders it in a sandboxed
 * iframe, and passes it the tool's result over `postMessage`.
 *
 * Each card here is one self-contained HTML document with no dependencies:
 * a ~40-line MCP Apps client (initialize, receive the tool result, report its
 * size, ask the host to open a link) and a renderer for one tool's
 * `structuredContent`. Hosts that don't support MCP Apps ignore all of it and
 * still get the spoken text and structured data.
 *
 * Wire protocol: MCP Apps 2026-01-26 (`text/html;profile=mcp-app`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "../services.js";
import { VERSION } from "../version.js";

export const APP_MIME = "text/html;profile=mcp-app";

export type CardKind = "brief" | "stock" | "portfolio" | "trade";

export const CARD_URI: Record<CardKind, string> = {
  brief: "ui://afterhours/brief",
  stock: "ui://afterhours/stock",
  portfolio: "ui://afterhours/portfolio",
  trade: "ui://afterhours/trade",
};

/** Which card each tool shows. Tools not listed are voice-only. */
export const TOOL_CARD: Record<string, CardKind> = {
  overnight_brief: "brief",
  check_stock: "stock",
  my_portfolio: "portfolio",
  propose_trade: "trade",
  trade_status: "trade",
};

export function toolUiMeta(tool: string): Record<string, unknown> | undefined {
  const kind = TOOL_CARD[tool];
  return kind ? { ui: { resourceUri: CARD_URI[kind] } } : undefined;
}

const CSS = `
:root{--bg:#0f1733;--ink:#e9ecf7;--muted:#9aa4c4;--line:#26305a;--track:#1a2244;--up:#4ade80;--down:#f87171;--accent:#ffb547;color-scheme:dark}
:root[data-theme=light]{--bg:#ffffff;--ink:#141a2e;--muted:#5b6380;--line:#e2ddd0;--track:#efece4;--up:#15803d;--down:#b91c1c;--accent:#b86e00;color-scheme:light}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{padding:16px 18px}
.label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.big{font-size:38px;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums;line-height:1.1;margin:4px 0}
.up{color:var(--up)}.down{color:var(--down)}.muted{color:var(--muted)}
.row{display:grid;grid-template-columns:96px 1fr 70px;gap:10px;align-items:center;margin:7px 0;font-variant-numeric:tabular-nums}
.track{height:9px;background:var(--track);border-radius:6px;position:relative;overflow:hidden}
.fill{position:absolute;top:0;bottom:0;border-radius:6px}.fill.up{background:var(--up)}.fill.down{background:var(--down)}
.v{text-align:right}
.range{position:relative;height:28px;margin:10px 0 2px}
.range .line{position:absolute;top:13px;left:0;right:0;height:3px;background:var(--track);border-radius:2px}
.range .dot{position:absolute;top:7px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--accent);border:2px solid var(--bg)}
.range .tick{position:absolute;top:9px;width:2px;height:11px;background:var(--muted)}
.ends{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}
.alert{border-left:3px solid var(--accent);padding:4px 0 4px 10px;margin:8px 0}
.code{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:6px}
.digits{font:700 40px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;color:var(--accent)}
.qr{background:#fff;border-radius:10px;padding:6px;width:120px;height:120px}.qr img{width:100%;height:100%;display:block}
button{appearance:none;border:0;border-radius:10px;background:var(--accent);color:#1b1300;font:600 14px/1 inherit;padding:10px 14px;cursor:pointer;margin-top:12px}
.note{font-size:13px;color:var(--muted);margin-top:8px}
`;

/** The minimal MCP Apps client every card shares. */
const CLIENT = `
let seq=0;const waiting={};
function post(m){parent.postMessage(Object.assign({jsonrpc:"2.0"},m),"*")}
function request(method,params){const id=++seq;post({id,method,params});return new Promise(r=>waiting[id]=r)}
function notify(method,params){post({method,params})}
function theme(ctx){if(ctx&&ctx.theme)document.documentElement.dataset.theme=ctx.theme}
function resized(){notify("ui/notifications/size-changed",{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})}
function openLink(url){request("ui/open-link",{url})}
window.addEventListener("message",e=>{if(e.source!==parent)return;const m=e.data;if(!m||m.jsonrpc!=="2.0")return;
 if(m.id!==undefined&&waiting[m.id]){waiting[m.id](m.result||{});delete waiting[m.id];return}
 if(m.method==="ui/notifications/tool-result"){const d=m.params&&m.params.structuredContent;if(d){render(d);resized()}}
 else if(m.method==="ui/notifications/host-context-changed"){theme(m.params)}
 else if(m.method==="ui/resource-teardown"&&m.id!==undefined){post({id:m.id,result:{}})}});
request("ui/initialize",{appInfo:{name:"Afterhours",version:"${VERSION}"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"})
 .then(r=>{theme(r.hostContext);notify("ui/notifications/initialized",{})});
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pct=n=>(n>0?"+":"")+Number(n).toFixed(2)+"%";
const usd=n=>"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const cls=n=>n>=0?"up":"down";
const et=iso=>new Date(iso).toLocaleString("en-US",{timeZone:"America/New_York",weekday:"short",hour:"numeric",minute:"2-digit"})+" ET";
function bars(rows){const max=Math.max(1,...rows.map(r=>Math.abs(r.v)));return rows.map(r=>"<div class=row><span>"+esc(r.k)+"</span><span class=track><span class='fill "+cls(r.v)+"' style='left:0;width:"+(Math.abs(r.v)/max*100).toFixed(1)+"%'></span></span><span class='v "+cls(r.v)+"'>"+esc(r.t)+"</span></div>").join("")}
`;

const RENDER: Record<CardKind, string> = {
  brief: `function render(d){const a=(d.alertsTriggered||[]).map(x=>"<div class=alert><b>"+esc(x.ticker)+"x</b> alert ("+x.thresholdPercent+"%) "+(x.firedAt?"went off at "+et(x.firedAt)+", "+pct(x.firedGapPercent)+" · now ":"")+"<span class="+cls(x.gapPercent)+">"+pct(x.gapPercent)+"</span></div>").join("");
 document.body.innerHTML="<main><div class=label>"+esc(d.marketPhase)+" · biggest moves"+(d.dataSource==="sample"?" · sample data":"")+"</div>"+a+(d.movers.length?bars(d.movers.map(m=>({k:m.token,v:m.gapPercent,t:pct(m.gapPercent)}))):"<p class=muted>Everything is within normal noise.</p>")+"<div class=note>vs "+esc(d.movers[0]?d.movers[0].comparedWith:"share prices")+"</div></main>"}`,
  stock: `function render(d){let range="";const o=d.overnight;
 if(o&&d.gapPercent!=null){const lo=Math.min(o.lowPercent,0,d.gapPercent),hi=Math.max(o.highPercent,0,d.gapPercent),w=hi-lo||1,x=v=>((v-lo)/w*100).toFixed(1)+"%";
  range="<div class=label style='margin-top:12px'>Since "+esc(d.comparedWith.replace(/'s close/,"'s close"))+"</div><div class=range><span class=line></span><span class=tick style='left:"+x(0)+"' title='share price'></span><span class=dot style='left:"+x(d.gapPercent)+"'></span></div><div class=ends><span>low "+pct(o.lowPercent)+" · "+et(o.lowAt)+"</span><span>high "+pct(o.highPercent)+" · "+et(o.highAt)+"</span></div>"}
 document.body.innerHTML="<main><div class=label>"+esc(d.token)+" · "+esc(d.name)+(d.dataSource==="sample"?" · sample data":"")+"</div><div class=big>"+usd(d.tokenPrice)+"</div><div class='"+cls(d.gapPercent||0)+"' style='font-size:20px;font-weight:650'>"+(d.gapPercent==null?"no reference":pct(d.gapPercent))+" <span class=muted style='font-size:14px;font-weight:400'>vs "+esc(d.comparedWith)+(d.sharePrice?" ("+usd(d.sharePrice)+")":"")+"</span></div>"+range+(d.verdict?"<div class=note>"+esc(d.verdict)+"</div>":"")+"</main>"}`,
  portfolio: `function render(d){document.body.innerHTML="<main><div class=label>Portfolio"+(d.dataSource==="sample"?" · sample data":"")+"</div><div class=big>"+usd(d.totalUsd)+"</div><div class="+cls(d.changeUsd)+" style='font-weight:650'>"+(d.changeUsd>=0?"+":"−")+usd(Math.abs(d.changeUsd))+" <span class=muted style='font-weight:400'>since the close</span></div>"+bars(d.positions.map(p=>({k:p.ticker+"x",v:p.changeUsd||0,t:usd(p.valueUsd)})))+"</main>"}`,
  trade: `const STATUS={awaiting_signature:"waiting for your signature",submitted:"sent, confirming",confirmed:"confirmed on Solana",failed:"not confirmed",expired:"expired",cancelled:"cancelled"};
function render(d){const live=d.status==="awaiting_signature";const u=new URL(d.confirmUrl);
 document.body.innerHTML="<main><div class=label>"+esc(d.side)+" "+usd(d.usd)+" of "+esc(d.ticker)+"x · "+esc(STATUS[d.status]||d.status)+"</div>"+(live?"<div class=code><div><div class=digits>"+esc(d.code)+"</div><div class=note>Scan, or open "+esc(u.host)+"/go</div></div><div class=qr><img alt='QR code for the confirm page' src='"+esc(u.origin)+"/qr.svg?path="+encodeURIComponent(u.pathname+u.search)+"'></div></div><button id=open>Review and sign</button><div class=note>Nothing happens until you sign in your own wallet.</div>":"<div class=big style='font-size:26px'>"+esc(STATUS[d.status]||d.status)+"</div>")+"</main>";
 const b=document.getElementById("open");if(b)b.onclick=()=>openLink(d.confirmUrl);
 const img=document.querySelector(".qr img");if(img)img.onload=resized}`,
};

export function cardHtml(kind: CardKind): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Afterhours</title><style>${CSS}</style></head><body><main class=muted>Loading…</main><script>${CLIENT}${RENDER[kind]}</script></body></html>`;
}

export function registerApps(server: McpServer, svc: Services): void {
  const origin = new URL(svc.baseUrl).origin;
  for (const kind of Object.keys(CARD_URI) as CardKind[]) {
    const uri = CARD_URI[kind];
    server.registerResource(
      `card-${kind}`,
      uri,
      { title: `Afterhours ${kind} card`, description: `Visual card for the ${kind} answer.`, mimeType: APP_MIME },
      async () => ({
        contents: [
          {
            uri,
            mimeType: APP_MIME,
            text: cardHtml(kind),
            // The trade card loads its QR code from this server; nothing else
            // is fetched.
            _meta: { ui: { prefersBorder: true, csp: { resourceDomains: kind === "trade" ? [origin] : [] } } },
          },
        ],
      }),
    );
  }
}
