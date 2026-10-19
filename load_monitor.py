#!/usr/bin/env python3
"""Live three-phase load monitor for the Deye hybrid inverter — a desktop page.

Serves one HTML page on localhost that draws the inverter's per-phase load
as three lines (R / Y / B), polled from Home Assistant every 5 s, with the
3.3 kW per-phase off-grid limit and the 2.8 kW shedding threshold drawn as
reference lines, grid-off spells shaded, and the geyser plugs that are on
listed in the header. Pure stdlib; HA is reached only from this process,
so Safari never needs CORS or the token.

    python3 load_monitor.py            # http://127.0.0.1:8765
    python3 load_monitor.py --open     # same, and opens it in the default browser
    python3 load_monitor.py --port 9000 --bind 0.0.0.0   # reachable on the LAN

Runs for days as a launchd agent on the Mac (see load_monitor.plist next
to this file: copy to ~/Library/LaunchAgents and `launchctl bootstrap
gui/$(id -u) <plist>`). Needs HA_URL / HA_TOKEN in ~/.config/vu2cpl-shack.env (same contract as
ha_discovery_publish.py). Written 2026-10-19 during the inverter-overload
work (HANDOVER #55); the phase names below follow the re-landed inputs of
that day — change PHASES if the electrician moves them again.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Physical phase -> inverter terminal, as of 2026-10-19 12:30 IST re-landing.
PHASES = [("R", "l1"), ("Y", "l2"), ("B", "l3")]
LIMIT_W = 3300        # 10 kW three-phase unit: per-phase off-grid limit
SHED_W = 2800         # HA escalation threshold
SERIES = {            # selectable series set -> HA sensor pattern
    "total": "sensor.inverter_load_{p}_power",
    "essential": "sensor.inverter_load_ups_{p}_power",
    "smartload": "sensor.inverter_smartload_{p}_power",
}
GRID = "binary_sensor.inverter_grid"
SOC = "sensor.inverter_battery"
BATT_P = "sensor.inverter_battery_power"

ENV_FILE = os.path.expanduser("~/.config/vu2cpl-shack.env")


def load_env():
    env = {}
    try:
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass
    return env


class HA:
    def __init__(self, url, token):
        self.url = url.rstrip("/")
        self.token = token

    def get(self, path, params=None):
        q = ("?" + urllib.parse.urlencode(params)) if params else ""
        req = urllib.request.Request(self.url + path + q, headers={
            "Authorization": "Bearer " + self.token})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)

    def states(self):
        return {s["entity_id"]: s for s in self.get("/api/states")}

    def history(self, entity_ids, minutes):
        start = time.strftime("%Y-%m-%dT%H:%M:%S+00:00",
                              time.gmtime(time.time() - minutes * 60))
        return self.get("/api/history/period/" + start, {
            "filter_entity_id": ",".join(entity_ids),
            "minimal_response": "", "no_attributes": ""})


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def snapshot(ha):
    st = ha.states()
    g = lambda e: st.get(e, {}).get("state")
    out = {"ts": time.time(), "grid": g(GRID) == "on", "soc": num(g(SOC)),
           "batt_p": num(g(BATT_P))}
    for key, pat in SERIES.items():
        out[key] = [num(g(pat.format(p=term))) for _, term in PHASES]
    # geyser plugs that are on: pattern only, no names hard-coded here
    out["geysers_on"] = sorted(
        e.split(".", 1)[1].split("_geyser")[0]
        for e, s in st.items()
        if e.startswith("switch.") and "_geyser_socket" in e and s["state"] == "on")
    return out


def history(ha, minutes):
    ents = [GRID] + [pat.format(p=t) for pat in SERIES.values() for _, t in PHASES]
    raw = ha.history(ents, minutes)
    series = {}
    grid = []
    for s in raw:
        if not s:
            continue
        eid = s[0]["entity_id"]
        if eid == GRID:
            grid = [(iso_ts(p["last_changed"]), p["state"]) for p in s]
            continue
        pts = [(iso_ts(p["last_changed"]), num(p["state"])) for p in s]
        series[eid] = thin(pts, 1500)
    out = {"grid": grid}
    for key, pat in SERIES.items():
        out[key] = [series.get(pat.format(p=t), []) for _, t in PHASES]
    return out


def thin(pts, max_pts):
    """Keep at most max_pts points, preserving each bucket's max so peaks survive."""
    if len(pts) <= max_pts:
        return pts
    size = len(pts) / float(max_pts)
    out = []
    for i in range(max_pts):
        chunk = [p for p in pts[int(i * size):int((i + 1) * size)] if p[1] is not None]
        if chunk:
            out.append(max(chunk, key=lambda p: p[1]))
    return out


def iso_ts(s):
    # HA gives e.g. 2026-10-19T07:13:00.123456+00:00
    s = s.replace("Z", "+00:00")
    head, _, tz = s.partition("+")
    head = head.split(".")[0]
    t = time.strptime(head, "%Y-%m-%dT%H:%M:%S")
    off = 0
    if tz:
        hh, mm = tz.split(":")
        off = int(hh) * 3600 + int(mm) * 60
    import calendar
    return calendar.timegm(t) - off


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phase Loads</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--ink:#c9d1d9;--muted:#8b949e;
 --r:#e66767;--y:#a89600;--b:#3987e5;--crit:#f85149;--warn:#d29922;--good:#3fb950;}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);
 font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
body{display:flex;flex-direction:column;padding:12px 16px;gap:10px}
header{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:110px}
.tile .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.tile .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}
.tile .v small{font-size:12px;color:var(--muted);font-weight:400}
.phase .v{display:flex;align-items:baseline;gap:6px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:middle;margin-right:4px}
.ok{color:var(--good)}.bad{color:var(--crit)}
.ctl{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ctl label{color:var(--muted);font-size:12px}
.ctl select,.ctl button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:inherit}
#wrap{flex:1;position:relative;min-height:320px;background:var(--panel);border:1px solid var(--line);border-radius:8px}
canvas{position:absolute;inset:0;width:100%;height:100%}
#tip{position:absolute;pointer-events:none;display:none;background:#1c2128;border:1px solid var(--line);border-radius:6px;
 padding:6px 8px;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums;z-index:2}
#tip b{font-weight:600}
footer{color:var(--muted);font-size:11px;display:flex;gap:16px;flex-wrap:wrap}
</style></head><body>
<header>
 <div class="tile"><div class="k">Grid</div><div class="v" id="grid">…</div></div>
 <div class="tile"><div class="k">Battery</div><div class="v" id="soc">…</div></div>
 <div class="tile phase"><div class="k"><span class="sw" style="background:var(--r)"></span>R · L1</div><div class="v" id="pR">…</div></div>
 <div class="tile phase"><div class="k"><span class="sw" style="background:var(--y)"></span>Y · L2</div><div class="v" id="pY">…</div></div>
 <div class="tile phase"><div class="k"><span class="sw" style="background:var(--b)"></span>B · L3</div><div class="v" id="pB">…</div></div>
 <div class="tile" style="flex:1 1 160px"><div class="k">Geysers on</div><div class="v" id="gey" style="font-size:16px">…</div></div>
 <div class="ctl">
  <label>Series <select id="set"><option value="total">Total load</option><option value="essential">Essential (UPS)</option><option value="smartload">SmartLoad port</option></select></label>
  <label>Window <select id="win"><option value="15">15 min</option><option value="30">30 min</option><option value="60" selected>60 min</option><option value="180">3 h</option><option value="360">6 h</option><option value="720">12 h</option><option value="1440">24 h</option><option value="4320">3 days</option></select></label>
  <button id="tbl" title="Show last values as a table">Table</button>
 </div>
</header>
<div id="wrap"><canvas id="c"></canvas><div id="tip"></div></div>
<footer><span>Solid red line: 3.3 kW per-phase off-grid limit. Dashed: 2.8 kW shedding threshold. Shaded: grid off.</span>
 <span id="stat">connecting…</span></footer>
<script>
const LIMIT=__LIMIT__, SHED=__SHED__, NAMES=__NAMES__, TERMS=__TERMS__;
const COL=['#e66767','#a89600','#3987e5'];
let setKey='total', winMin=60, data={total:[[],[],[]],essential:[[],[],[]],smartload:[[],[],[]]}, grid=[], last=null, hover=null, table=false;
const $=id=>document.getElementById(id);
const fmtW=v=>v==null?'—':Math.round(v).toLocaleString()+' W';
const hhmm=t=>{const d=new Date(t*1000);return d.toTimeString().slice(0,8);};
async function loadHistory(){
  const h=await (await fetch('/api/history?minutes='+winMin)).json();
  for(const k in data) data[k]=h[k].map(s=>s.filter(p=>p[1]!=null));
  grid=h.grid; draw();
}
async function tick(){
  try{
    const s=await (await fetch('/api/now')).json(); last=s;
    for(const k in data) s[k].forEach((v,i)=>{ if(v!=null) data[k][i].push([s.ts,v]); });
    grid.push([s.ts, s.grid?'on':'off']);
    const cut=s.ts-winMin*60-30;
    for(const k in data) data[k]=data[k].map(a=>a.filter(p=>p[0]>=cut));
    $('grid').innerHTML=s.grid?'<span class="ok">ON</span>':'<span class="bad">OFF</span>';
    $('soc').innerHTML=(s.soc==null?'—':s.soc+'%')+' <small>'+(s.batt_p==null?'':(s.batt_p>25?'discharging':s.batt_p<-25?'charging':'idle'))+'</small>';
    ['R','Y','B'].forEach((n,i)=>{const v=s[setKey][i];const el=$('p'+n);el.textContent=fmtW(v);el.className=v!=null&&v>LIMIT?'bad':v!=null&&v>SHED?'':'';el.style.color=v!=null&&v>LIMIT?'var(--crit)':v!=null&&v>SHED?'var(--warn)':'';});
    $('gey').textContent=s.geysers_on.length?s.geysers_on.join(', '):'none';
    $('stat').textContent='updated '+hhmm(s.ts)+' · every 5 s';
    draw();
  }catch(e){$('stat').textContent='HA unreachable: '+e;}
}
const cv=$('c'),ctx=cv.getContext('2d');
function draw(){
  const W=cv.clientWidth,H=cv.clientHeight,dpr=window.devicePixelRatio||1;
  if(cv.width!==W*dpr||cv.height!==H*dpr){cv.width=W*dpr;cv.height=H*dpr;}
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  const padL=56,padR=92,padT=16,padB=28, x0=padL,x1=W-padR,y0=padT,y1=H-padB;
  const now=last?last.ts:Date.now()/1000, t0=now-winMin*60;
  const ser=data[setKey]; let maxV=LIMIT*1.15;
  ser.forEach(a=>a.forEach(p=>{if(p[1]>maxV)maxV=p[1];})); maxV=Math.ceil(maxV/500)*500;
  const X=t=>x0+(t-t0)/(now-t0)*(x1-x0), Y=v=>y1-(v/maxV)*(y1-y0);
  if(table){drawTable(W,H);return;}
  // grid-off bands
  ctx.fillStyle='rgba(248,81,73,0.10)';
  let offAt=null; const g=grid.filter(p=>p[0]<=now);
  // seed with state before window
  for(const [t,s] of g){ if(s==='off'&&offAt==null) offAt=Math.max(t,t0); if(s==='on'&&offAt!=null){ctx.fillRect(X(offAt),y0,X(t)-X(offAt),y1-y0);offAt=null;} }
  if(offAt!=null) ctx.fillRect(X(offAt),y0,x1-X(offAt),y1-y0);
  // gridlines + y labels
  ctx.strokeStyle='#30363d';ctx.lineWidth=1;ctx.fillStyle='#8b949e';ctx.font='11px -apple-system,Helvetica,Arial';ctx.textAlign='right';
  for(let v=0;v<=maxV;v+=500){const y=Y(v);ctx.beginPath();ctx.moveTo(x0,y);ctx.lineTo(x1,y);ctx.stroke();if(v%1000===0)ctx.fillText((v/1000)+' kW',x0-6,y+4);}
  ctx.textAlign='center';
  const step=winMin<=15?120:winMin<=30?300:winMin<=60?600:winMin<=180?1800:winMin<=720?3600:winMin<=1440?7200:21600;
  for(let t=Math.ceil(t0/step)*step;t<=now;t+=step){const x=X(t);ctx.beginPath();ctx.moveTo(x,y1);ctx.lineTo(x,y1+4);ctx.stroke();ctx.fillText(winMin>1440?new Date(t*1000).toLocaleString('en-GB',{weekday:'short',hour:'2-digit',minute:'2-digit'}):hhmm(t).slice(0,5),x,y1+16);}
  // reference lines
  ctx.lineWidth=1.5;ctx.strokeStyle='#f85149';ctx.beginPath();ctx.moveTo(x0,Y(LIMIT));ctx.lineTo(x1,Y(LIMIT));ctx.stroke();
  ctx.setLineDash([6,4]);ctx.strokeStyle='#d29922';ctx.beginPath();ctx.moveTo(x0,Y(SHED));ctx.lineTo(x1,Y(SHED));ctx.stroke();ctx.setLineDash([]);
  ctx.textAlign='left';ctx.fillStyle='#f85149';ctx.fillText('3.3 kW limit',x1+6,Y(LIMIT)+4);ctx.fillStyle='#d29922';ctx.fillText('2.8 kW shed',x1+6,Y(SHED)+4);
  // series
  ctx.lineWidth=2;ctx.lineJoin='round';
  const ends=[];
  ser.forEach((a,i)=>{ctx.strokeStyle=COL[i];ctx.beginPath();let first=true;
    for(const [t,v] of a){ if(t<t0) continue; const x=X(t),y=Y(v); if(first){ctx.moveTo(x,y);first=false;}else ctx.lineTo(x,y);}
    ctx.stroke(); if(a.length) ends.push([i,Y(a[a.length-1][1]),a[a.length-1][1]]);});
  // direct labels at right end, de-overlapped
  ends.sort((p,q)=>p[1]-q[1]); for(let i=1;i<ends.length;i++) if(ends[i][1]-ends[i-1][1]<14) ends[i][1]=ends[i-1][1]+14;
  ctx.font='600 12px -apple-system,Helvetica,Arial';
  for(const [i,y,v] of ends){ctx.fillStyle=COL[i];ctx.fillText(NAMES[i]+' '+Math.round(v),x1+6,y+4);}
  // hover crosshair
  if(hover&&hover.x>=x0&&hover.x<=x1){const t=t0+(hover.x-x0)/(x1-x0)*(now-t0);
    ctx.strokeStyle='#8b949e';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(hover.x,y0);ctx.lineTo(hover.x,y1);ctx.stroke();ctx.setLineDash([]);
    const tip=$('tip');let html='<b>'+hhmm(t)+'</b>';
    ser.forEach((a,i)=>{let best=null;for(const p of a){if(p[0]<=t)best=p;else break;} if(best){html+='<br><span style="color:'+COL[i]+'">●</span> '+NAMES[i]+' · '+TERMS[i]+' '+fmtW(best[1]);ctx.fillStyle=COL[i];ctx.beginPath();ctx.arc(X(best[0]),Y(best[1]),4,0,7);ctx.fill();ctx.strokeStyle='#161b22';ctx.lineWidth=2;ctx.stroke();}});
    const goff=g.filter(p=>p[0]<=t).pop(); if(goff) html+='<br>grid '+goff[1];
    tip.innerHTML=html;tip.style.display='block';tip.style.left=Math.min(hover.x+12,W-170)+'px';tip.style.top=Math.max(8,hover.y-10)+'px';
  } else $('tip').style.display='none';
}
function drawTable(W,H){ctx.fillStyle='#c9d1d9';ctx.font='13px -apple-system,Helvetica,Arial';ctx.textAlign='left';
  const ser=data[setKey];let y=30;ctx.fillText('Last 20 samples · '+setKey,16,y);y+=22;
  const n=Math.max(...ser.map(a=>a.length));const rows=[];
  for(let k=Math.max(0,n-20);k<n;k++){rows.push([ser[0][k]?hhmm(ser[0][k][0]):'',...ser.map(a=>a[k]?fmtW(a[k][1]):'—')]);}
  ctx.fillStyle='#8b949e';ctx.fillText('time',16,y);NAMES.forEach((nm,i)=>ctx.fillText(nm+' · '+TERMS[i],120+i*130,y));y+=18;ctx.fillStyle='#c9d1d9';
  for(const r of rows){ctx.fillText(r[0],16,y);r.slice(1).forEach((v,i)=>ctx.fillText(v,120+i*130,y));y+=18;if(y>H-10)break;}}
cv.addEventListener('mousemove',e=>{const r=cv.getBoundingClientRect();hover={x:e.clientX-r.left,y:e.clientY-r.top};draw();});
cv.addEventListener('mouseleave',()=>{hover=null;draw();});
$('set').onchange=e=>{setKey=e.target.value;if(last)tick();else draw();};
$('win').onchange=e=>{winMin=+e.target.value;loadHistory();};
$('tbl').onclick=()=>{table=!table;$('tbl').textContent=table?'Chart':'Table';draw();};
window.addEventListener('resize',draw);
loadHistory().then(tick); setInterval(tick,5000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    ha = None

    def log_message(self, *a):  # quiet
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        try:
            if u.path == "/":
                page = (PAGE.replace("__LIMIT__", str(LIMIT_W))
                        .replace("__SHED__", str(SHED_W))
                        .replace("__NAMES__", json.dumps([n for n, _ in PHASES]))
                        .replace("__TERMS__", json.dumps([t.upper() for _, t in PHASES])))
                self.send(200, page, "text/html")
            elif u.path == "/api/now":
                self.send(200, json.dumps(snapshot(self.ha)))
            elif u.path == "/api/history":
                q = urllib.parse.parse_qs(u.query)
                minutes = max(5, min(4320, int(q.get("minutes", ["60"])[0])))
                self.send(200, json.dumps(history(self.ha, minutes)))
            else:
                self.send(404, "not found", "text/plain")
        except Exception as e:  # HA down, token wrong, etc.
            self.send(502, json.dumps({"error": str(e)}))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--open", action="store_true", help="open in the default browser")
    a = ap.parse_args()
    env = load_env()
    url = os.environ.get("HA_URL") or env.get("HA_URL") or "http://192.168.1.36:8123"
    token = os.environ.get("HA_TOKEN") or env.get("HA_TOKEN")
    if not token:
        sys.exit("HA_TOKEN not found in environment or " + ENV_FILE)
    Handler.ha = HA(url, token)
    srv = ThreadingHTTPServer((a.bind, a.port), Handler)
    link = "http://%s:%d/" % ("127.0.0.1" if a.bind == "0.0.0.0" else a.bind, a.port)
    print("Phase load monitor on", link, "(HA at %s)" % url, flush=True)
    if a.open:
        webbrowser.open(link)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
