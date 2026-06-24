import type { EncryptedPayload } from './export.js';

// Renders the self-contained snapshot viewer: a single HTML document that holds
// the AES-GCM ciphertext and a small password-gated decrypt/render app. It makes
// NO network requests — it works from a file:// URL, offline, with no server.
//
// IMPORTANT: the embedded <script> below must not use template literals
// (backticks) or ${...}, because the whole document is itself a template literal
// here. The two interpolations at the very bottom (payload + info) are the only
// ${...} in this file. The viewer uses string concatenation throughout.

interface ViewerInfo {
  generatedAt: string;
  expiresAt: string | null;
}

export function renderSnapshotHtml(payload: EncryptedPayload, info: ViewerInfo): string {
  // Escape `<` so the JSON can't break out of the <script> context (e.g. a
  // "</script>" appearing inside a string value).
  const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  const infoJson = JSON.stringify(info).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>KevFin — Encrypted Snapshot</title>
<style>
  :root{
    --bg:#0e1117; --surface:#161b22; --border:#272d38; --text:#e6edf3;
    --muted:#8b949e; --accent:#6c8fff; --green:#3fb950; --red:#f85149; --amber:#d29922;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--accent)}
  .wrap{max-width:960px;margin:0 auto;padding:32px 24px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:24px}
  h1{font-size:28px;font-weight:700;letter-spacing:-.5px}
  h2{font-size:16px;font-weight:600;margin-bottom:14px}
  .muted{color:var(--muted)}
  .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px 24px}
  .kpi .label{color:var(--muted);font-size:13px;margin-bottom:8px}
  .kpi .val{font-size:26px;font-weight:700}
  .kpi.hero{background:rgba(108,143,255,.12);border-color:var(--accent)}
  .kpi.hero .val{font-size:30px;color:var(--accent)}
  .row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:13px}
  .grp{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:14px 0 4px;display:flex;justify-content:space-between}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  .bar{height:8px;border-radius:4px;background:var(--accent)}
  .bartrack{flex:1;height:8px;border-radius:4px;background:var(--bg);margin:0 10px;overflow:hidden}
  .pos{color:var(--green)} .neg{color:var(--red)}
  input{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:15px;padding:10px 12px;width:100%}
  button{background:var(--accent);border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:600;padding:10px 16px;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .gate{max-width:380px;margin:14vh auto;text-align:center}
  .gate .card{text-align:left}
  .err{color:var(--red);font-size:13px;margin-top:10px;min-height:18px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td{padding:5px 0;border-bottom:1px solid var(--border)}
  td.num{text-align:right;white-space:nowrap}
  .tag{font-size:11px;color:var(--muted)}
  @media(max-width:680px){.kpis{grid-template-columns:1fr}.two{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="root"></div>

<script id="payload" type="application/json">${payloadJson}</script>
<script id="info" type="application/json">${infoJson}</script>
<script>
"use strict";
(function(){
  var PAYLOAD = JSON.parse(document.getElementById("payload").textContent);
  var INFO = JSON.parse(document.getElementById("info").textContent);
  var root = document.getElementById("root");

  // ---- helpers -------------------------------------------------------------
  function h(html){ var d=document.createElement("div"); d.innerHTML=html; return d; }
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function money(n){ if(n==null||isNaN(n)) return "—"; return "$"+Math.round(n).toLocaleString(); }
  function pct(f){ if(f==null||isNaN(f)) return "—"; return (f*100).toFixed(1)+"%"; }
  function signPct(f){ if(f==null||isNaN(f)) return "—"; return (f>=0?"+":"")+(f*100).toFixed(1)+"%"; }
  function b64ToBytes(b64){ var bin=atob(b64); var u=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; }
  function fmtDate(iso){ if(!iso) return ""; var d=new Date(iso); if(isNaN(d.getTime())) return iso; return d.toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}); }

  // ---- decryption (mirrors server/src/services/export.ts) ------------------
  function decrypt(password){
    var enc=new TextEncoder();
    var salt=b64ToBytes(PAYLOAD.salt), iv=b64ToBytes(PAYLOAD.iv), ct=b64ToBytes(PAYLOAD.ct);
    return crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"])
      .then(function(base){
        return crypto.subtle.deriveKey(
          { name:"PBKDF2", salt:salt, iterations:PAYLOAD.iterations, hash:"SHA-256" },
          base, { name:"AES-GCM", length:256 }, false, ["decrypt"]);
      })
      .then(function(key){ return crypto.subtle.decrypt({ name:"AES-GCM", iv:iv }, key, ct); })
      .then(function(buf){ return JSON.parse(new TextDecoder().decode(buf)); });
  }

  // ---- net-worth SVG chart -------------------------------------------------
  function chart(history){
    var data=(history||[]).slice().sort(function(a,b){ return a.date<b.date?-1:1; });
    if(data.length<2) return "";
    var W=860,H=240,P=8;
    var vals=data.map(function(d){ return d.net_worth; });
    var min=Math.min.apply(null,vals), max=Math.max.apply(null,vals);
    if(min===max){ min-=1; max+=1; }
    var n=data.length;
    function x(i){ return P+(W-2*P)*(i/(n-1)); }
    function y(v){ return P+(H-2*P)*(1-(v-min)/(max-min)); }
    var line="", area="M"+x(0).toFixed(1)+" "+(H-P).toFixed(1);
    for(var i=0;i<n;i++){ var px=x(i).toFixed(1), py=y(vals[i]).toFixed(1); line+=(i?" L":"M")+px+" "+py; area+=" L"+px+" "+py; }
    area+=" L"+x(n-1).toFixed(1)+" "+(H-P).toFixed(1)+" Z";
    var first=data[0], last=data[n-1];
    return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" style="width:100%;height:240px;display:block">'
      +'<path d="'+area+'" fill="rgba(108,143,255,.12)"/>'
      +'<path d="'+line+'" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>'
      +'<div class="row muted" style="font-size:12px"><span>'+esc(first.date)+'</span><span>'+esc(last.date)+'</span></div>';
  }

  // ---- breakdown sections --------------------------------------------------
  var CAT_LABEL={brokerage:"Brokerage",banking:"Cash & Banking",credit:"Credit Cards",other:"Other Accounts"};
  var CAT_ORDER=["brokerage","banking","credit","other"];

  function accountsCard(bd){
    var accts=(bd.accounts||[]).filter(function(a){ return !a.hidden; });
    var html='<div class="card"><h2>Financial Accounts</h2>';
    CAT_ORDER.forEach(function(cat){
      var rows=accts.filter(function(a){ return a.category===cat; });
      if(!rows.length) return;
      var sub=rows.reduce(function(s,a){ return s+a.balance; },0);
      html+='<div class="grp"><span>'+esc(CAT_LABEL[cat])+'</span><span>'+money(sub)+'</span></div>';
      rows.forEach(function(a){
        html+='<div class="row"><span>'+esc(a.name)+' <span class="tag">('+esc(a.org_name)+')</span></span>'
          +'<span class="'+(a.balance<0?"neg":"")+'">'+money(a.balance)+'</span></div>';
      });
    });
    html+='</div>';
    return html;
  }

  function realEstateCard(props){
    if(!props||!props.length) return "";
    var html='<div class="card"><h2>Real Estate</h2>';
    props.forEach(function(p){
      var eq=(p.zestimate||0)-(p.mortgage_balance||0);
      html+='<div style="padding:8px 0;border-bottom:1px solid var(--border)">'
        +'<div style="font-weight:600;margin-bottom:4px">'+esc(p.address)+'</div>'
        +'<div class="row"><span class="muted">Value</span><span class="pos">'+money(p.zestimate)+'</span></div>'
        +'<div class="row"><span class="muted">Mortgage</span><span class="neg">'+money(p.mortgage_balance)+'</span></div>'
        +'<div class="row"><span class="muted">Equity</span><span class="'+(eq>=0?"pos":"neg")+'">'+money(eq)+'</span></div></div>';
    });
    html+='</div>';
    return html;
  }

  function manualAssetsCard(assets){
    if(!assets||!assets.length) return "";
    var html='<div class="card"><h2>Manual Assets</h2>';
    assets.forEach(function(a){
      html+='<div class="row"><span>'+esc(a.name)+'</span><span class="pos">'+money(a.value)+'</span></div>';
    });
    html+='</div>';
    return html;
  }

  function allocationCard(al){
    if(!al||!al.byAssetClass||!al.byAssetClass.length) return "";
    var slices=al.byAssetClass.slice().sort(function(a,b){ return b.value-a.value; });
    var html='<div class="card"><h2>Asset Allocation</h2>';
    slices.forEach(function(s){
      var p=Math.max(0,Math.min(100,(s.pct||0)*100));
      html+='<div class="row"><span style="min-width:140px">'+esc(s.name)+'</span>'
        +'<span class="bartrack"><span class="bar" style="width:'+p.toFixed(1)+'%;display:block"></span></span>'
        +'<span class="num" style="min-width:120px">'+money(s.value)+' <span class="tag">'+pct(s.pct)+'</span></span></div>';
    });
    html+='</div>';
    return html;
  }

  function performanceCard(perf){
    if(!perf||!perf.series||!perf.series.length) return "";
    var html='<div class="card"><h2>Investment Performance <span class="tag">since '+esc(perf.startDate||"")+'</span></h2>'
      +'<table><tbody>';
    perf.series.forEach(function(s){
      html+='<tr><td>'+esc(s.label)+' <span class="tag">'+esc(s.type)+'</span></td>'
        +'<td class="num '+((s.totalReturn||0)>=0?"pos":"neg")+'">'+signPct(s.totalReturn)+'</td>'
        +'<td class="num muted">'+signPct(s.cagr)+' CAGR</td></tr>';
    });
    html+='</tbody></table></div>';
    return html;
  }

  function budgetCard(b){
    if(!b) return "";
    var cats=(b.byCategory||[]).filter(function(c){ return c.spent>0; })
      .sort(function(x,y){ return y.spent-x.spent; }).slice(0,8);
    var html='<div class="card"><h2>Budget <span class="tag">'+esc(b.month||"")+'</span></h2>'
      +'<div class="row"><span class="muted">Income</span><span class="pos">'+money(b.income)+'</span></div>'
      +'<div class="row"><span class="muted">Spending</span><span class="neg">'+money(b.spending)+'</span></div>';
    if(cats.length){
      html+='<div class="grp"><span>Top categories</span><span></span></div>';
      cats.forEach(function(c){
        html+='<div class="row"><span>'+esc(c.category)+'</span><span>'+money(c.spent)+'</span></div>';
      });
    }
    html+='</div>';
    return html;
  }

  // ---- top-level render ----------------------------------------------------
  function render(snap){
    var meta=snap.meta||{}, data=snap.data||{};
    var nw=data.netWorth||{}, hist=nw.history||[], bd=nw.breakdown||{};
    var latest=hist.length?hist[0]:null; // history is newest-first

    var html='<div class="wrap">'
      +'<div style="margin-bottom:24px"><h1>'+esc(meta.appName||"KevFin")+'</h1>'
      +'<p class="muted">Snapshot · generated '+esc(fmtDate(meta.generatedAt))+'</p></div>';

    html+='<div class="kpis">'
      +'<div class="kpi hero"><div class="label">Net Worth</div><div class="val">'+money(latest?latest.net_worth:null)+'</div></div>'
      +'<div class="kpi"><div class="label">Accounts</div><div class="val" style="color:var(--amber)">'+money(latest?latest.accounts_total:null)+'</div></div>'
      +'<div class="kpi"><div class="label">Real Estate</div><div class="val" style="color:var(--green)">'+money(latest?latest.real_estate_total:null)+'</div></div>'
      +'</div>';

    html+='<div class="card"><h2>Net Worth History</h2>'+(chart(hist)||'<p class="muted">Not enough history to chart.</p>')+'</div>';

    html+='<div class="two"><div>'+accountsCard(bd)+'</div><div>'
      +realEstateCard(bd.properties)+manualAssetsCard(bd.manualAssets)+'</div></div>';

    html+=allocationCard(data.allocation)+performanceCard(data.performance)+budgetCard(data.budget);

    html+='<p class="muted" style="font-size:12px;margin-top:8px">Read-only snapshot. Figures are point-in-time as of generation and are not live.</p>';
    html+='</div>';
    root.innerHTML=html;
  }

  // ---- password gate -------------------------------------------------------
  function gate(message){
    root.innerHTML=''
      +'<div class="gate"><h1 style="margin-bottom:8px">KevFin</h1>'
      +'<p class="muted" style="margin-bottom:18px">Encrypted snapshot' + (INFO.generatedAt?' · '+esc(fmtDate(INFO.generatedAt)):'') + '</p>'
      +'<div class="card"><label class="muted" style="font-size:12px">Password</label>'
      +'<input id="pw" type="password" autofocus style="margin:6px 0 12px" />'
      +'<button id="go" style="width:100%">Unlock</button>'
      +'<div class="err" id="err">'+(message?esc(message):'')+'</div></div></div>';
    var pw=document.getElementById("pw"), go=document.getElementById("go"), err=document.getElementById("err");
    function submit(){
      var p=pw.value;
      if(!p){ err.textContent="Enter the password."; return; }
      go.disabled=true; err.textContent="Decrypting…";
      decrypt(p).then(function(snap){
        var exp=snap.meta&&snap.meta.expiresAt;
        if(exp&&new Date(exp).getTime()<Date.now()){
          go.disabled=false;
          root.innerHTML='<div class="gate"><div class="card"><h2>Snapshot expired</h2>'
            +'<p class="muted">This snapshot was set to expire on '+esc(fmtDate(exp))+' and is no longer viewable.</p></div></div>';
          return;
        }
        render(snap);
      }).catch(function(){
        go.disabled=false;
        err.textContent="Incorrect password, or the file is corrupted.";
      });
    }
    go.addEventListener("click", submit);
    pw.addEventListener("keydown", function(e){ if(e.key==="Enter") submit(); });
  }

  if(!crypto||!crypto.subtle){
    root.innerHTML='<div class="gate"><div class="card"><h2>Unsupported browser</h2><p class="muted">This viewer needs the Web Crypto API. Open the file over http(s) or in a modern browser.</p></div></div>';
  } else {
    gate("");
  }
})();
</script>
</body>
</html>`;
}
