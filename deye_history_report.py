#!/usr/bin/env python3
"""Solarman 'PlantsDetails-History' exports -> supply-interruption report.

Companion to grid_voltage_report.py. That one analyses the per-minute
voltage log this shack now keeps; this one analyses what the Deye
inverter already uploaded to the Solarman cloud, which is the only
record covering the period BEFORE local logging started 2026-08-25.

What the cloud export contains: Time, Production, Consumption, Grid,
Battery, SOC, PV, Generator, Grid-tied Inverter Power -- all in kW, at
5-minute resolution, one .xlsx per day. **There is no voltage column.**
So this report cannot evidence over-voltage; what it evidences is every
interruption of supply, with timestamps, durations and independent
corroboration from the battery.

The corroboration matters. `Grid = 0 kW` alone is not proof of an
outage: a hybrid inverter with a full battery and PV covering the load
also imports nothing. What distinguishes a real interruption is that
the battery has to carry the house -- so the state of charge falls.
Episodes are classified on that basis and the report says which test
each one passed, because a utility will (rightly) probe exactly this.

Pure stdlib. These sheets store values inline with no sharedStrings
table, so a small regex reader beats adding an openpyxl dependency.

Usage:
  python3 deye_history_report.py --dir "~/Downloads/deye data" \\
      --out outages.md --svg outages.svg --csv outages.csv
"""

import argparse
import collections
import csv as csvmod
import glob
import os
import re
import sys
import zipfile
from datetime import datetime, timedelta

CELL = re.compile(r'<c r="([A-Z]+)\d+"[^>]*>(?:<v>(.*?)</v>)?</c>', re.S)
ROW = re.compile(r"<row[^>]*>(.*?)</row>", re.S)
COLS = "ABCDEFGHI"


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------

def read_sheet(path):
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if n.startswith("xl/worksheets/sheet")]
        if not names:
            return []
        xml = z.read(sorted(names)[0]).decode("utf-8")
    out = []
    for r in ROW.findall(xml):
        cells = {c: (v if v is not None else "") for c, v in CELL.findall(r)}
        out.append([cells.get(c, "") for c in COLS])
    return out


def load(folder):
    """Merge every .xlsx in the folder into one clean, deduplicated series.

    The daily exports overlap (each carries a 00:00 boundary row) and
    contain all-zero padding rows, so both are dropped here rather than
    quietly skewing the statistics downstream.
    """
    files = sorted(glob.glob(os.path.join(folder, "*.xlsx")))
    if not files:
        sys.exit("no .xlsx files in %s" % folder)
    seen, dropped, headers = {}, 0, set()
    for f in files:
        sheet = read_sheet(f)
        if not sheet:
            continue
        headers.add(tuple(sheet[0]))
        for row in sheet[1:]:
            try:
                ts = datetime.strptime(row[0], "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            num = lambda i: (float(row[i]) if row[i] not in ("", None) else 0.0)
            try:
                rec = {"ts": ts, "cons": num(2), "grid": num(3),
                       "batt": num(4), "soc": num(5), "pv": num(6)}
            except ValueError:
                continue
            # Padding rows carry a zero SOC, which never occurs in real data.
            if rec["soc"] == 0 and rec["cons"] == 0:
                dropped += 1
                continue
            if ts in seen:
                dropped += 1
            seen[ts] = rec
    if len(headers) > 1:
        print("warning: exports have differing headers", file=sys.stderr)
    return sorted(seen.values(), key=lambda r: r["ts"]), dropped, len(files)


# --------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------

def episodes(recs, step_min, merge_steps=2):
    eps, cur = [], None
    gap = timedelta(minutes=step_min * merge_steps)
    for r in recs:
        if r["grid"] != 0:
            continue
        if cur and (r["ts"] - cur["end"]) <= gap:
            cur["end"] = r["ts"]
            cur["rows"].append(r)
        else:
            if cur:
                eps.append(cur)
            cur = {"start": r["ts"], "end": r["ts"], "rows": [r]}
    if cur:
        eps.append(cur)
    for e in eps:
        e["mins"] = int((e["end"] - e["start"]).total_seconds() // 60) + step_min
        socs = [r["soc"] for r in e["rows"]]
        e["soc_from"], e["soc_to"] = socs[0], socs[-1]
        e["soc_drop"] = socs[0] - min(socs)
        e["pv_max"] = max(r["pv"] for r in e["rows"])
        e["cons_mean"] = sum(r["cons"] for r in e["rows"]) / len(e["rows"])
        # A real interruption forces the battery to carry the house. Zero
        # import with a full battery and PV covering the load looks
        # identical in the Grid column but leaves SOC untouched.
        if e["soc_drop"] >= 1.0:
            e["verdict"] = "outage"
            e["basis"] = "battery discharged %.0f%%" % e["soc_drop"]
        elif e["pv_max"] == 0 and e["cons_mean"] > 0.1:
            e["verdict"] = "outage"
            e["basis"] = "no PV, load %.2f kW carried off-grid" % e["cons_mean"]
        else:
            e["verdict"] = "zero-import"
            e["basis"] = "SOC flat, PV %.2f kW covering load" % e["pv_max"]
    return eps


def data_gaps(recs, step_min, min_gap_steps=2):
    gaps = []
    for a, b in zip(recs, recs[1:]):
        d = int((b["ts"] - a["ts"]).total_seconds() // 60)
        if d > step_min * min_gap_steps:
            gaps.append({"start": a["ts"], "end": b["ts"], "mins": d - step_min})
    return gaps


# --------------------------------------------------------------------------
# Timeline chart — one row per day, 24 h across
# --------------------------------------------------------------------------

def svg_timeline(days, outs, gaps, width=1080, row_h=15):
    ml, mt, mr = 74, 46, 16
    pw = width - ml - mr
    height = mt + row_h * len(days) + 46
    x = lambda mins: ml + pw * mins / 1440.0
    o = ["<svg xmlns='http://www.w3.org/2000/svg' width='%d' height='%d' "
         "viewBox='0 0 %d %d' font-family='system-ui,sans-serif'>"
         % (width, height, width, height),
         "<rect width='%d' height='%d' fill='#ffffff'/>" % (width, height)]
    for h in range(0, 25, 2):
        o.append("<line x1='%.1f' y1='%d' x2='%.1f' y2='%d' stroke='#e6e6e6'/>"
                 % (x(h * 60), mt, x(h * 60), mt + row_h * len(days)))
        o.append("<text x='%.1f' y='%d' font-size='10' fill='#666' "
                 "text-anchor='middle'>%02d</text>" % (x(h * 60), mt - 6, h))
    # the disputed window
    o.append("<rect x='%.1f' y='%d' width='%.1f' height='%d' fill='#f5f0e6'/>"
             % (x(0), mt, x(6 * 60) - x(0), row_h * len(days)))
    o.append("<rect x='%.1f' y='%d' width='%.1f' height='%d' fill='#f5f0e6'/>"
             % (x(22 * 60), mt, x(1440) - x(22 * 60), row_h * len(days)))
    for i, day in enumerate(days):
        y = mt + i * row_h
        o.append("<text x='%d' y='%d' font-size='10' fill='#333' "
                 "text-anchor='end'>%s</text>"
                 % (ml - 8, y + row_h - 4, day.strftime("%a %d %b")))
        o.append("<line x1='%d' y1='%.1f' x2='%d' y2='%.1f' stroke='#f0f0f0'/>"
                 % (ml, y + row_h - 0.5, width - mr, y + row_h - 0.5))
        for e, colour in [(g, "#c9c9c9") for g in gaps] + \
                         [(e, "#c1121f") for e in outs]:
            for s, t in clip_to_day(e, day):
                o.append("<rect x='%.1f' y='%d' width='%.1f' height='%d' "
                         "fill='%s'/>"
                         % (x(s), y + 1, max(1.2, x(t) - x(s)), row_h - 3,
                            colour))
    ly = mt + row_h * len(days) + 22
    o.append("<rect x='%d' y='%d' width='12' height='9' fill='#c1121f'/>" % (ml, ly))
    o.append("<text x='%d' y='%d' font-size='11' fill='#333'>supply "
             "interruption</text>" % (ml + 18, ly + 8))
    o.append("<rect x='%d' y='%d' width='12' height='9' fill='#c9c9c9'/>"
             % (ml + 150, ly))
    o.append("<text x='%d' y='%d' font-size='11' fill='#333'>no data "
             "reported</text>" % (ml + 168, ly + 8))
    o.append("<rect x='%d' y='%d' width='12' height='9' fill='#f5f0e6'/>"
             % (ml + 310, ly))
    o.append("<text x='%d' y='%d' font-size='11' fill='#333'>22:00-06:00"
             "</text>" % (ml + 328, ly + 8))
    o.append("</svg>")
    return "\n".join(o)


def clip_to_day(e, day):
    """Return (start_min, end_min) spans of an episode falling on `day`."""
    d0 = datetime(day.year, day.month, day.day)
    d1 = d0 + timedelta(days=1)
    s, t = max(e["start"], d0), min(e["end"], d1)
    if s >= t:
        return []
    return [((s - d0).total_seconds() / 60, (t - d0).total_seconds() / 60)]


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------

def render(recs, eps, gaps, args, step_min, dropped, nfiles):
    outs = [e for e in eps
            if e["verdict"] == "outage" and e["mins"] >= args.min_outage]
    zeros = [e for e in eps if e["verdict"] == "zero-import"]
    t0, t1 = recs[0]["ts"], recs[-1]["ts"]
    ndays = (t1.date() - t0.date()).days + 1
    L = []
    add = L.append

    add("# Supply interruption record — %s" % args.site)
    add("")
    add("Derived from the solar inverter's own cloud telemetry "
        "(Solarman plant history, %d daily exports), 5-minute resolution."
        % nfiles)
    add("")
    add("| | |")
    add("|---|---|")
    add("| Period | %s → %s (IST), %d days |"
        % (t0.strftime("%d %b %Y %H:%M"), t1.strftime("%d %b %Y %H:%M"), ndays))
    add("| Readings | %d (after removing %d duplicate/padding rows) |"
        % (len(recs), dropped))
    add("| **Interruptions ≥ %d min** | **%d** |" % (args.min_outage, len(outs)))
    add("| **Total time without supply** | **%.1f hours** (%.0f min/day "
        "average) |" % (sum(e["mins"] for e in outs) / 60.0,
                        sum(e["mins"] for e in outs) / float(ndays)))
    add("")

    night = [e for e in outs if e["start"].hour < 6 or e["start"].hour >= 22]
    night_min = sum(e["mins"] for e in night)
    total_min = sum(e["mins"] for e in outs) or 1
    add("## Summary")
    add("")
    add("- **%d of %d interruptions (%.0f%%) began between 22:00 and 06:00**, "
        "accounting for %.1f of the %.1f lost hours (%.0f%%)."
        % (len(night), len(outs), 100.0 * len(night) / max(len(outs), 1),
           night_min / 60.0, total_min / 60.0, 100.0 * night_min / total_min))
    if outs:
        worst = max(outs, key=lambda e: e["mins"])
        add("- Longest single interruption: **%d minutes** on %s (%02d:%02d–%s), "
            "battery fell %.0f%% → %.0f%%."
            % (worst["mins"], worst["start"].strftime("%d %b"),
               worst["start"].hour, worst["start"].minute,
               worst["end"].strftime("%H:%M"), worst["soc_from"],
               worst["soc_to"]))
    add("- Every interruption listed is corroborated by the battery "
        "discharging to carry the property, or by there being no solar "
        "generation at the time. Episodes where the inverter merely drew "
        "nothing from the grid (battery full, solar covering the load) are "
        "excluded — there are %d of those and they are **not** counted as "
        "interruptions." % len(zeros))
    add("")

    add("## When interruptions occur")
    add("")
    add("Lost minutes by hour of day, whole period:")
    add("")
    byhour = collections.Counter()
    for e in outs:
        cur = e["start"]
        while cur <= e["end"]:
            byhour[cur.hour] += step_min
            cur += timedelta(minutes=step_min)
    peak = max(byhour.values()) if byhour else 1
    add("| Hour | Lost minutes | |")
    add("|---|---|---|")
    for h in range(24):
        m = byhour.get(h, 0)
        add("| %02d:00 | %d | %s |" % (h, m, "█" * int(28.0 * m / peak)))
    add("")

    # A weekly roll-up makes a step change in supply quality visible
    # without the report having to assert a cause or a date.
    add("## By week")
    add("")
    add("| Week beginning | Interruptions | Time lost |")
    add("|---|---|---|")
    wk0 = t0.date() - timedelta(days=t0.weekday())
    weeks = collections.defaultdict(list)
    for e in outs:
        w = e["start"].date() - timedelta(days=e["start"].weekday())
        weeks[w].append(e)
    w = wk0
    while w <= t1.date():
        es = weeks.get(w, [])
        add("| %s | %d | %s |"
            % (w.strftime("%d %b"), len(es),
               ("**%.1f h**" % (sum(e["mins"] for e in es) / 60.0))
               if es else "—"))
        w += timedelta(days=7)
    add("")

    add("## Daily totals")
    add("")
    add("| Date | Interruptions | Time lost | Longest |")
    add("|---|---|---|---|")
    perday = collections.defaultdict(list)
    for e in outs:
        perday[e["start"].date()].append(e)
    day = t0.date()
    while day <= t1.date():
        es = perday.get(day, [])
        add("| %s | %d | %s | %s |"
            % (day.strftime("%a %d %b"), len(es),
               ("%d min" % sum(e["mins"] for e in es)) if es else "—",
               ("%d min" % max(e["mins"] for e in es)) if es else "—"))
        day += timedelta(days=1)
    add("")

    add("## Every interruption")
    add("")
    add("| Date | From | To | Duration | Battery | Basis |")
    add("|---|---|---|---|---|---|")
    for e in outs:
        add("| %s | %s | %s | **%d min** | %.0f%% → %.0f%% | %s |"
            % (e["start"].strftime("%a %d %b"), e["start"].strftime("%H:%M"),
               e["end"].strftime("%H:%M"), e["mins"], e["soc_from"],
               e["soc_to"], e["basis"]))
    add("")

    if gaps:
        add("## Periods with no telemetry")
        add("")
        add("The inverter reported nothing at all during these windows. They "
            "are **not** counted as interruptions above — the cause cannot be "
            "established from this data, and a loss of internet connectivity "
            "would look the same. They are listed for completeness.")
        add("")
        add("| Date | From | To | Duration |")
        add("|---|---|---|---|")
        for g in gaps:
            if g["mins"] >= args.min_gap:
                add("| %s | %s | %s | %d min |"
                    % (g["start"].strftime("%a %d %b"),
                       g["start"].strftime("%H:%M"),
                       g["end"].strftime("%H:%M"), g["mins"]))
        add("")

    add("---")
    add("")
    add("### How this was measured, and what it does not show")
    add("")
    add("The property has a Deye hybrid solar inverter with battery storage. "
        "It records grid import/export, solar generation, household "
        "consumption and battery state of charge every 5 minutes, and "
        "uploads them to the manufacturer's cloud service. This report is "
        "generated from that record; it is the manufacturer's own "
        "instrumentation, not a device fitted for this complaint.")
    add("")
    add("An interruption is identified where grid power is zero **and** the "
        "battery is discharging to carry the property (or there is no solar "
        "generation to do so). The battery's state of charge falling is "
        "independent physical confirmation that supply was absent.")
    add("")
    add("**This record does not show supply voltage** — the cloud export "
        "contains no voltage channel. Separate per-minute voltage logging "
        "began on 25 August 2026 and is reported separately.")
    return "\n".join(L), outs


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", required=True,
                    help="folder of PlantsDetails-History*.xlsx exports")
    ap.add_argument("--out", help="write Markdown here (default: stdout)")
    ap.add_argument("--svg", help="also write the day-by-day timeline here")
    ap.add_argument("--csv", help="also write the interruption table here")
    ap.add_argument("--site", default="VU2CPL, Bengaluru")
    ap.add_argument("--min-outage", type=int, default=10,
                    help="ignore interruptions shorter than N minutes")
    ap.add_argument("--min-gap", type=int, default=15,
                    help="only list telemetry gaps of N minutes or more")
    args = ap.parse_args()

    folder = os.path.expanduser(args.dir)
    recs, dropped, nfiles = load(folder)
    if len(recs) < 2:
        sys.exit("not enough readings")

    deltas = collections.Counter(
        int((b["ts"] - a["ts"]).total_seconds() // 60)
        for a, b in zip(recs, recs[1:]))
    step = deltas.most_common(1)[0][0] or 5

    eps = episodes(recs, step)
    gaps = data_gaps(recs, step)
    md, outs = render(recs, eps, gaps, args, step, dropped, nfiles)

    if args.out:
        with open(args.out, "w") as f:
            f.write(md + "\n")
        print("wrote %s — %d interruptions, %.1f h lost"
              % (args.out, len(outs), sum(e["mins"] for e in outs) / 60.0))
    else:
        print(md)

    if args.svg:
        days = []
        d = recs[0]["ts"].date()
        while d <= recs[-1]["ts"].date():
            days.append(d)
            d += timedelta(days=1)
        with open(args.svg, "w") as f:
            f.write(svg_timeline(days, outs,
                                 [g for g in gaps if g["mins"] >= args.min_gap]))
        print("wrote %s" % args.svg)

    if args.csv:
        with open(args.csv, "w", newline="") as f:
            w = csvmod.writer(f)
            w.writerow(["date", "start", "end", "duration_min",
                        "soc_start_pct", "soc_end_pct", "basis"])
            for e in outs:
                w.writerow([e["start"].strftime("%Y-%m-%d"),
                            e["start"].strftime("%H:%M"),
                            e["end"].strftime("%H:%M"), e["mins"],
                            e["soc_from"], e["soc_to"], e["basis"]])
        print("wrote %s" % args.csv)


if __name__ == "__main__":
    main()
