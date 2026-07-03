#!/usr/bin/env python3
"""Generate a self-contained HTML dashboard for the intake pipeline.

Reads pipeline.json + config.json + item folders, embeds the data into a single
static HTML file (pipeline/dashboard.html) with no external dependencies. Re-run
any time (the sweep cog does this each morning):  python pipeline/dashboard.py
"""
import json, datetime as dt
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATES = ["inbox", "planning", "refine", "queue", "working",
          "review", "refactor", "replan", "done", "archive"]


def load(name, default):
    try:
        return json.loads((ROOT / name).read_text(encoding="utf-8"))
    except Exception:
        return default


idx = load("pipeline.json", {"items": {}})
cfg = load("config.json", {})
items = list(idx.get("items", {}).values())
for r in items:
    d = ROOT / r.get("state", "") / r.get("namespace", "")
    r["_has_plan"] = (d / "plan.md").exists()
    r["_has_migration"] = (d / "migration.md").exists()

data = {
    "generated": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    "config": {k: cfg.get(k) for k in (
        "execute_mode", "contract_write", "contract_routing",
        "max_items_per_tick", "max_replan_attempts", "max_refactor_attempts",
        "stuck_threshold_hours")},
    "states": STATES,
    "items": items,
}

HTML = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pipeline Dashboard</title>
<style>
:root{--bg:#0f1216;--panel:#171b21;--panel2:#1d222a;--line:#2a313c;--txt:#e6e9ee;--mut:#94a3b8;--accent:#60a5fa;--red:#f87171;--amber:#fbbf24;--green:#4ade80}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
h1{font-size:18px;margin:0;font-weight:650}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:3px 10px;color:var(--mut);font-size:12px}
.chip b{color:var(--txt)}
.muted{color:var(--mut);font-size:12px}
.needs{margin:16px 20px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:10px;padding:12px 16px}
.needs h2{font-size:13px;margin:0 0 8px;color:var(--amber);text-transform:uppercase;letter-spacing:.04em}
.needs ul{margin:0;padding-left:18px}.needs li{margin:3px 0}
.needs .none{color:var(--mut)}
.board{display:flex;gap:12px;overflow-x:auto;padding:8px 20px 24px;align-items:flex-start}
.col{flex:0 0 230px;background:var(--panel);border:1px solid var(--line);border-radius:10px;min-height:80px}
.col h3{font-size:12px;margin:0;padding:10px 12px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;text-transform:capitalize}
.col .cnt{color:var(--mut)}
.cards{padding:8px;display:flex;flex-direction:column;gap:8px}
.card{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:9px 10px;cursor:pointer;border-left:3px solid var(--st)}
.card:hover{border-color:var(--accent)}
.card .id{font-size:11px;color:var(--mut)}
.card .ttl{font-weight:600;margin:2px 0 4px;font-size:13px}
.card .meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--mut)}
.tag{background:#222834;border-radius:4px;padding:1px 6px}
.tag.warn{background:#3a2a1a;color:var(--amber)}
.tag.bad{background:#3a1f22;color:var(--red)}
.block{margin-top:6px;font-size:11px;color:var(--red)}
.empty{color:var(--mut);font-size:12px;padding:8px 10px}
#panel{position:fixed;top:0;right:0;width:min(460px,92vw);height:100%;background:var(--panel);border-left:1px solid var(--line);transform:translateX(100%);transition:.18s;overflow:auto;padding:18px 20px;z-index:9}
#panel.open{transform:none}
#panel .x{float:right;cursor:pointer;color:var(--mut);font-size:20px;border:0;background:0}
#panel h2{font-size:16px;margin:0 6px 2px 0}
.kv{margin:10px 0;font-size:13px}.kv .k{color:var(--mut)}
.tl{border-left:2px solid var(--line);margin:12px 0;padding-left:14px}
.tl .ev{margin:0 0 12px;position:relative}
.tl .ev:before{content:"";position:absolute;left:-19px;top:4px;width:8px;height:8px;border-radius:50%;background:var(--accent)}
.tl .when{font-size:11px;color:var(--mut)}
.tl .mv{font-weight:600;font-size:12px}
.tl .note{font-size:12px;color:var(--mut)}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:.18s;z-index:8}
.scrim.open{opacity:1;pointer-events:auto}
</style></head><body>
<header>
  <div><h1>Pipeline Dashboard</h1><div class="muted" id="gen"></div></div>
  <div class="chips" id="chips"></div>
</header>
<div class="needs" id="needs"></div>
<div class="board" id="board"></div>
<div class="scrim" id="scrim" onclick="closePanel()"></div>
<div id="panel"><button class="x" onclick="closePanel()">&times;</button><div id="pbody"></div></div>
<script>
const D = /*DATA*/;
const COLORS={inbox:"#94a3b8",planning:"#60a5fa",refine:"#818cf8",queue:"#34d399",working:"#fbbf24",review:"#a78bfa",refactor:"#fb923c",replan:"#f87171",done:"#4ade80",archive:"#6b7280"};
const byId={}; D.items.forEach(i=>byId[i.id]=i);
const HOURS=(D.config.stuck_threshold_hours||48);
function ago(iso){if(!iso)return"";const h=(Date.now()-new Date(iso))/36e5;if(h<1)return Math.round(h*60)+"m";if(h<48)return Math.round(h)+"h";return Math.round(h/24)+"d";}
function isStuck(i){if(["done","archive"].includes(i.state))return false;const h=(Date.now()-new Date(i.updated_at))/36e5;return h>HOURS;}
function parked(i){return (i.state==="replan"&&(i.attempts||0)>=(D.config.max_replan_attempts||2))||(i.state==="refactor"&&(i.refactor_attempts||0)>=(D.config.max_refactor_attempts||2));}
document.getElementById("gen").textContent="generated "+new Date(D.generated).toLocaleString()+"  ·  "+D.items.length+" items";
const c=D.config;document.getElementById("chips").innerHTML=
 [["execute",c.execute_mode],["contract write",c.contract_write],["routing",c.contract_routing],["build/tick",c.max_items_per_tick]]
 .map(x=>`<span class="chip">${x[0]} <b>${x[1]}</b></span>`).join("");
// needs-you
const needs=D.items.filter(i=>["replan","refactor"].includes(i.state)||parked(i));
const stuck=D.items.filter(isStuck);
let nh='<h2>Needs you</h2>';
if(!needs.length&&!stuck.length){nh+='<div class="none">Nothing blocked. ✔</div>';}
else{nh+='<ul>';needs.forEach(i=>{nh+=`<li><a href="#" onclick="open_('${i.id}');return false">${i.id}</a> — <b>${i.title}</b> <span class="muted">(${i.state}${parked(i)?", PARKED":""})</span><br><span class="block">${i.blocked_reason||""}</span></li>`;});
 stuck.filter(i=>!needs.includes(i)).forEach(i=>{nh+=`<li><a href="#" onclick="open_('${i.id}');return false">${i.id}</a> — ${i.title} <span class="muted">(stuck in ${i.state} ${ago(i.updated_at)})</span></li>`;});
 nh+='</ul>';}
document.getElementById("needs").innerHTML=nh;
// board
const board=document.getElementById("board");
D.states.forEach(s=>{const its=D.items.filter(i=>i.state===s);
 let h=`<div class="col"><h3><span>${s}</span><span class="cnt">${its.length}</span></h3><div class="cards" style="--st:${COLORS[s]}">`;
 if(!its.length)h+='<div class="empty">—</div>';
 its.forEach(i=>{const att=(i.attempts||0)+(i.refactor_attempts||0);
  h+=`<div class="card" style="--st:${COLORS[s]}" onclick="open_('${i.id}')">
   <div class="id">${i.id} · ${ago(i.updated_at)} ago</div>
   <div class="ttl">${i.title}</div>
   <div class="meta"><span class="tag">${i.type||"?"}</span>${i.size_hint?`<span class="tag">${i.size_hint}</span>`:""}${i.contract_nodes&&i.contract_nodes.length?`<span class="tag">${i.contract_nodes.length} nodes</span>`:""}${att?`<span class="tag ${parked(i)?"bad":"warn"}">${att} attempt${att>1?"s":""}</span>`:""}${isStuck(i)?'<span class="tag warn">stuck</span>':""}</div>
   ${i.blocked_reason?`<div class="block">${i.blocked_reason}</div>`:""}
  </div>`;});
 h+='</div></div>';board.insertAdjacentHTML("beforeend",h);});
// detail panel
function open_(id){const i=byId[id];if(!i)return;
 let h=`<h2>${i.title}</h2><div class="muted">${i.id} · ${i.namespace}</div>`;
 h+=`<div class="kv"><span class="k">state:</span> <b style="color:${COLORS[i.state]}">${i.state}</b>  ·  <span class="k">type:</span> ${i.type}  ·  <span class="k">size:</span> ${i.size_hint||"?"}</div>`;
 h+=`<div class="kv"><span class="k">attempts:</span> ${i.attempts||0} replan / ${i.refactor_attempts||0} refactor${parked(i)?' <b style="color:var(--red)">PARKED</b>':""}</div>`;
 if(i.contract_nodes&&i.contract_nodes.length)h+=`<div class="kv"><span class="k">contract nodes:</span> ${i.contract_nodes.join(", ")}</div>`;
 h+=`<div class="kv"><span class="k">artifacts:</span> source.md${i._has_plan?", plan.md":""}${i._has_migration?", migration.md":""}</div>`;
 if(i.blocked_reason)h+=`<div class="kv block" style="font-size:13px">⚠ ${i.blocked_reason}</div>`;
 h+='<div class="kv k">history</div><div class="tl">';
 (i.history||[]).slice().reverse().forEach(e=>{h+=`<div class="ev"><div class="when">${new Date(e.at).toLocaleString()}</div><div class="mv">${e.from} → ${e.to}</div><div class="note">${e.note||""}</div></div>`;});
 h+='</div>';
 document.getElementById("pbody").innerHTML=h;
 document.getElementById("panel").classList.add("open");document.getElementById("scrim").classList.add("open");}
function closePanel(){document.getElementById("panel").classList.remove("open");document.getElementById("scrim").classList.remove("open");}
document.addEventListener("keydown",e=>{if(e.key==="Escape")closePanel();});
</script></body></html>'''

out = HTML.replace("/*DATA*/", json.dumps(data, ensure_ascii=False))
(ROOT / "dashboard.html").write_text(out, encoding="utf-8")
print("wrote dashboard.html —", len(items), "items,", len(out), "bytes")
