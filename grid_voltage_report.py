#!/usr/bin/env python3
"""Grid voltage evidence report — Deye 3-phase log -> Markdown + SVG.

Reads the CSV written by solar_inverter_mqtt.py (~/grid_voltage.csv) and
produces a report suitable for handing to the supply utility: per-day
per-phase min/mean/max, over-voltage excursion episodes, and grid-down
episodes.

Why this exists: the shack stores no time series of grid voltage (the
MQTT message is retained = last value only), so this log is the only
record. Built 2026-08-25 for a dispute about nightly outages that the
operator attributes to mains rising above the servo stabiliser's 270 V
limit, tripping it around midnight.

Two things the report states plainly, because both change what the data
proves:

  * The inverter's grid input is DOWNSTREAM of the servo stabiliser.
    Rows show true incoming mains only while the stabiliser is in
    BYPASS. Pass --bypass-from / --bypass-to to mark the window that
    qualifies; outside it the figures are the stabiliser's regulated
    output, not the supply.
  * A hybrid inverter exporting PV raises the voltage at its own
    terminals, so daytime readings are arguable. The night window has
    no PV and no export, which is why it gets its own section — and it
    is the window in dispute anyway.

Pure stdlib: no matplotlib, no pandas. The chart is hand-written SVG.

Usage:
  python3 grid_voltage_report.py --csv ~/grid_voltage.csv --out report.md
  python3 grid_voltage_report.py --trip 270 --night 22:00-06:00 --svg chart.svg
"""

import argparse
import csv
import os
import statistics
import sys
from datetime import datetime, timedelta

PHASES = ("l1_v", "l2_v", "l3_v")
PHASE_LABELS = ("L1", "L2", "L3")


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

def load(path):
    """Return (rows, n_readfail). Rows are dicts with parsed types, in
    time order, ok-status only; read_fail rows are returned separately
    as gap markers since they carry no readings."""
    ok, gaps = [], []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            try:
                ts = datetime.fromtimestamp(int(r["ts_epoch"]))
            except (KeyError, ValueError):
                continue
            if r.get("status") != "ok":
                gaps.append({"ts": ts, "status": r.get("status", "?")})
                continue
            try:
                row = {"ts": ts,
                       "grid_on": r["grid_on"] == "1",
                       "batt_p_w": int(r["batt_p_w"] or 0)}
                for p in PHASES:
                    row[p] = float(r[p])
            except (KeyError, ValueError):
                continue
            row["vmax"] = max(row[p] for p in PHASES)
            row["vmin"] = min(row[p] for p in PHASES)
            ok.append(row)
    ok.sort(key=lambda x: x["ts"])
    gaps.sort(key=lambda x: x["ts"])
    return ok, gaps


def parse_window(spec):
    """'22:00-06:00' -> (1320, 360) as minutes-since-midnight."""
    a, b = spec.split("-")
    def mins(t):
        h, m = t.split(":")
        return int(h) * 60 + int(m)
    return mins(a), mins(b)


def in_window(ts, win):
    start, end = win
    m = ts.hour * 60 + ts.minute
    return (start <= m or m < end) if start > end else (start <= m < end)


# --------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------

def stats_block(rows):
    """min / mean / max per phase, plus when the max occurred."""
    out = {}
    for p, label in zip(PHASES, PHASE_LABELS):
        vals = [r[p] for r in rows]
        if not vals:
            continue
        peak = max(rows, key=lambda r: r[p])
        out[label] = {"min": min(vals), "mean": statistics.fmean(vals),
                      "max": peak[p], "max_at": peak["ts"]}
    return out


def by_day(rows):
    days = {}
    for r in rows:
        days.setdefault(r["ts"].date(), []).append(r)
    return dict(sorted(days.items()))


def episodes(rows, predicate, gap_minutes=2):
    """Contiguous runs where predicate(row) holds.

    Runs separated by less than gap_minutes are merged, so a single
    sample dipping under the threshold doesn't shatter one real event
    into a dozen rows in the report.
    """
    eps, cur = [], None
    for r in rows:
        if predicate(r):
            if cur and (r["ts"] - cur["end"]) <= timedelta(minutes=gap_minutes):
                cur["end"] = r["ts"]
                cur["rows"].append(r)
            else:
                if cur:
                    eps.append(cur)
                cur = {"start": r["ts"], "end": r["ts"], "rows": [r]}
    if cur:
        eps.append(cur)
    return eps


def outage_episodes(rows, gaps, gap_minutes=2):
    """Grid-down = grid_on false, or a read_fail (inverter unreachable).

    Both are merged into one timeline: during a real outage the readings
    stop entirely, so neither signal alone catches the whole event.
    """
    marks = [{"ts": r["ts"], "kind": "grid_off"} for r in rows if not r["grid_on"]]
    marks += [{"ts": g["ts"], "kind": "no_read"} for g in gaps]
    marks.sort(key=lambda m: m["ts"])
    eps, cur = [], None
    for m in marks:
        if cur and (m["ts"] - cur["end"]) <= timedelta(minutes=gap_minutes):
            cur["end"] = m["ts"]
            cur["kinds"].add(m["kind"])
        else:
            if cur:
                eps.append(cur)
            cur = {"start": m["ts"], "end": m["ts"], "kinds": {m["kind"]}}
    if cur:
        eps.append(cur)
    return eps


def dur(start, end):
    """Inclusive minute count — a single 1-min sample is 1 min, not 0."""
    return int((end - start).total_seconds() // 60) + 1


def end_label(start, end):
    """Show the end date too when an episode crosses midnight — which the
    ones that matter here all do."""
    return end.strftime("%H:%M" if end.date() == start.date()
                        else "%d %b %H:%M")


# --------------------------------------------------------------------------
# SVG chart
# --------------------------------------------------------------------------

def svg_chart(rows, nominal, upper, trip, night, width=1100, height=420,
              bucket_min=5):
    """Per-phase line chart, downsampled to the max in each bucket.

    Max rather than mean: this is an over-voltage case, and averaging
    would bury exactly the peaks that matter.
    """
    if not rows:
        return "<svg xmlns='http://www.w3.org/2000/svg'/>"
    ml, mr, mt, mb = 60, 20, 20, 46
    pw, ph = width - ml - mr, height - mt - mb
    t0, t1 = rows[0]["ts"], rows[-1]["ts"]
    span = max((t1 - t0).total_seconds(), 60)

    buckets = {}
    for r in rows:
        k = int((r["ts"] - t0).total_seconds() // (bucket_min * 60))
        b = buckets.setdefault(k, {"ts": r["ts"]})
        for p in PHASES:
            b[p] = max(b.get(p, 0), r[p])
    pts = [buckets[k] for k in sorted(buckets)]

    lo = min(180.0, min(r["vmin"] for r in rows) - 5)
    hi = max(trip + 10, max(r["vmax"] for r in rows) + 5)
    x = lambda ts: ml + pw * (ts - t0).total_seconds() / span
    y = lambda v: mt + ph * (hi - v) / (hi - lo)

    o = ["<svg xmlns='http://www.w3.org/2000/svg' width='%d' height='%d' "
         "viewBox='0 0 %d %d' font-family='system-ui,sans-serif'>"
         % (width, height, width, height),
         "<rect width='%d' height='%d' fill='#ffffff'/>" % (width, height)]

    # night shading — the window the dispute is about
    cur = t0.replace(hour=0, minute=0, second=0, microsecond=0)
    while cur <= t1:
        if in_window(cur, night):
            nxt = cur + timedelta(minutes=1)
            if x(nxt) > ml:
                o.append("<rect x='%.1f' y='%d' width='%.1f' height='%d' "
                         "fill='#eef2f7'/>"
                         % (max(ml, x(cur)), mt,
                            max(0.6, x(nxt) - max(ml, x(cur))), ph))
        cur += timedelta(minutes=1)

    # reference lines
    for val, colour, label in ((nominal, "#8a8a8a", "%g V nominal" % nominal),
                               (upper, "#d08700", "%.0f V (+%.0f%%)"
                                % (upper, round(100 * (upper / nominal - 1)))),
                               (trip, "#c1121f", "%g V stabiliser trip" % trip)):
        if lo < val < hi:
            o.append("<line x1='%d' y1='%.1f' x2='%d' y2='%.1f' stroke='%s' "
                     "stroke-width='1' stroke-dasharray='5 4'/>"
                     % (ml, y(val), width - mr, y(val), colour))
            o.append("<text x='%d' y='%.1f' font-size='11' fill='%s'>%s</text>"
                     % (width - mr - 4, y(val) - 3, colour, label))
            o[-1] = o[-1].replace("<text ", "<text text-anchor='end' ")

    # y axis
    step = 10 if (hi - lo) <= 120 else 20
    v = int(lo // step) * step
    while v <= hi:
        if v >= lo:
            o.append("<text x='%d' y='%.1f' font-size='11' fill='#444' "
                     "text-anchor='end'>%d</text>" % (ml - 8, y(v) + 4, v))
        v += step

    # phase traces
    for p, label, colour in zip(PHASES, PHASE_LABELS,
                                ("#1f6feb", "#2da44e", "#8250df")):
        d = " ".join("%s%.1f %.1f" % ("M" if i == 0 else "L",
                                      x(b["ts"]), y(b[p]))
                     for i, b in enumerate(pts))
        o.append("<path d='%s' fill='none' stroke='%s' stroke-width='1.4'/>"
                 % (d, colour))
        o.append("<text x='%d' y='%d' font-size='12' fill='%s'>%s</text>"
                 % (ml + 70 * PHASE_LABELS.index(label), height - 10,
                    colour, label))

    # x axis: one tick per day boundary
    o.append("<line x1='%d' y1='%.1f' x2='%d' y2='%.1f' stroke='#444'/>"
             % (ml, mt + ph, width - mr, mt + ph))
    day = t0.replace(hour=0, minute=0, second=0, microsecond=0)
    while day <= t1:
        if day >= t0:
            o.append("<text x='%.1f' y='%d' font-size='11' fill='#444' "
                     "text-anchor='middle'>%s</text>"
                     % (x(day), mt + ph + 16, day.strftime("%d %b")))
        day += timedelta(days=1)
    o.append("<text x='%d' y='%d' font-size='11' fill='#666'>shaded = night "
             "window (no PV export)</text>" % (ml + 230, height - 10))
    o.append("</svg>")
    return "\n".join(o)


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------

def render(rows, gaps, args):
    nominal, trip = args.nominal, args.trip
    upper = args.upper if args.upper else nominal * (1 + args.upper_pct / 100.0)
    night = parse_window(args.night)
    L = []
    add = L.append

    # Voltage statistics run over samples with the grid actually present.
    # A 0 V reading during an interruption is not a supply voltage, and
    # letting it into min/mean would understate the problem being reported.
    live = [r for r in rows if r["grid_on"]]
    if not live:
        sys.exit("no samples with grid present in %s" % args.csv)

    t0, t1 = rows[0]["ts"], rows[-1]["ts"]
    # Round rather than floor: cron fires a few seconds past the minute, so
    # flooring a short span reports more than 100% coverage.
    expected = max(1, round((t1 - t0).total_seconds() / 60) + 1)
    coverage = min(100.0, 100.0 * len(rows) / expected)

    add("# Grid voltage record — %s" % args.site)
    add("")
    add("Measured at the Deye SG0\\*LP3 hybrid inverter's grid input "
        "terminals, 3-phase, one sample per minute.")
    add("")
    add("| | |")
    add("|---|---|")
    add("| Period | %s → %s (IST) |"
        % (t0.strftime("%d %b %Y %H:%M"), t1.strftime("%d %b %Y %H:%M")))
    add("| Samples | %d valid (%d with grid present), %d failed reads, "
        "%.1f%% coverage |"
        % (len(rows), len(live), len(gaps), coverage))
    add("| Nominal | %g V |" % nominal)
    add("| Upper limit used | %.1f V (+%.0f%%) |"
        % (upper, round(100 * (upper / nominal - 1))))
    add("| Stabiliser trip | %g V |" % trip)
    add("")
    add("**Measurement point.** The inverter's grid input is downstream of "
        "the servo stabiliser. These figures are true incoming mains only "
        "while the stabiliser is in bypass%s. With the stabiliser engaged "
        "they show its regulated output (~220 V), not the supply."
        % (" — bypass window: %s" % args.bypass if args.bypass else ""))
    add("")
    add("**Daytime readings.** The inverter exports PV during daylight, "
        "which raises voltage at its own terminals. The night-window "
        "section below has no PV and no export, and is the period in "
        "dispute.")
    add("")

    over = [r for r in live if r["vmax"] > upper]
    above_trip = [r for r in live if r["vmax"] > trip]
    add("## Summary")
    add("")
    add("- **%d of %d samples (%.1f%%) exceeded %.1f V** on at least one phase."
        % (len(over), len(live), 100.0 * len(over) / len(live), upper))
    add("- **%d samples (%.1f%%) exceeded the %g V stabiliser trip point.**"
        % (len(above_trip), 100.0 * len(above_trip) / len(live), trip))
    peak = max(live, key=lambda r: r["vmax"])
    peak_ph = PHASE_LABELS[[peak[p] for p in PHASES].index(peak["vmax"])]
    add("- Highest reading in the period: **%.1f V on %s** at %s."
        % (peak["vmax"], peak_ph, peak["ts"].strftime("%d %b %H:%M")))
    add("")

    add("## Daily summary, all hours")
    add("")
    add("_Excludes samples taken while the grid was absent; those are "
        "listed under Supply interruptions._")
    add("")
    add("| Date | " + " | ".join("%s min/mean/max" % p for p in PHASE_LABELS)
        + " | Peak at |")
    add("|---|" + "---|" * (len(PHASE_LABELS) + 1))
    for day, drows in by_day(live).items():
        s = stats_block(drows)
        dpeak = max(drows, key=lambda r: r["vmax"])
        cells = " | ".join("%.1f / %.1f / **%.1f**"
                           % (s[p]["min"], s[p]["mean"], s[p]["max"])
                           for p in PHASE_LABELS)
        add("| %s | %s | %s |" % (day.strftime("%d %b"), cells,
                                  dpeak["ts"].strftime("%H:%M")))
    add("")

    nrows = [r for r in live if in_window(r["ts"], night)]
    add("## Night window (%s) — no PV, no export" % args.night)
    add("")
    if nrows:
        add("| Date | " + " | ".join("%s min/mean/max" % p
                                     for p in PHASE_LABELS) + " | Peak at |")
        add("|---|" + "---|" * (len(PHASE_LABELS) + 1))
        # A night spanning midnight is attributed to the date it began.
        groups = {}
        for r in nrows:
            key = (r["ts"] - timedelta(minutes=night[1])).date()
            groups.setdefault(key, []).append(r)
        for day, drows in sorted(groups.items()):
            s = stats_block(drows)
            dpeak = max(drows, key=lambda r: r["vmax"])
            cells = " | ".join("%.1f / %.1f / **%.1f**"
                               % (s[p]["min"], s[p]["mean"], s[p]["max"])
                               for p in PHASE_LABELS)
            add("| night of %s | %s | %s |" % (day.strftime("%d %b"), cells,
                                               dpeak["ts"].strftime("%H:%M")))
    else:
        add("_No samples in the night window yet._")
    add("")

    eps = episodes(live, lambda r: r["vmax"] > upper, args.merge_gap)
    add("## Over-voltage episodes (above %.1f V)" % upper)
    add("")
    long_eps = [e for e in eps
                if dur(e["start"], e["end"]) >= args.min_episode]
    short = len(eps) - len(long_eps)
    if long_eps:
        add("| Start | End | Duration | Peak | Phase |")
        add("|---|---|---|---|---|")
        for e in long_eps:
            p = max(e["rows"], key=lambda r: r["vmax"])
            ph = PHASE_LABELS[[p[x] for x in PHASES].index(p["vmax"])]
            add("| %s | %s | %d min | **%.1f V** | %s |"
                % (e["start"].strftime("%d %b %H:%M"),
                   end_label(e["start"], e["end"]),
                   dur(e["start"], e["end"]), p["vmax"], ph))
        if short:
            add("")
            add("_%d further excursion%s shorter than %d minutes omitted._"
                % (short, "" if short == 1 else "s", args.min_episode))
    else:
        add("_None recorded._")
    add("")

    oeps = [e for e in outage_episodes(rows, gaps, args.merge_gap)
            if dur(e["start"], e["end"]) >= args.min_outage]
    add("## Supply interruptions (grid absent ≥ %d min)" % args.min_outage)
    add("")
    if oeps:
        add("| Start | End | Duration | Detected as |")
        add("|---|---|---|---|")
        for e in oeps:
            kinds = ", ".join(sorted(e["kinds"])).replace(
                "grid_off", "inverter reported no grid").replace(
                "no_read", "inverter unreachable")
            add("| %s | %s | %d min | %s |"
                % (e["start"].strftime("%d %b %H:%M"),
                   end_label(e["start"], e["end"]),
                   dur(e["start"], e["end"]), kinds))
    else:
        add("_None recorded._")
    add("")
    add("---")
    add("")
    add("Generated by `grid_voltage_report.py` from `%s`. Source data: "
        "one Modbus read per minute of the inverter's grid input voltage "
        "registers (598-600), logged by `solar_inverter_mqtt.py`."
        % os.path.basename(args.csv))
    return "\n".join(L), upper, night


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--csv", default=os.path.expanduser("~/grid_voltage.csv"))
    ap.add_argument("--out", help="write Markdown here (default: stdout)")
    ap.add_argument("--svg", help="also write an SVG chart here")
    ap.add_argument("--site", default="VU2CPL, Bengaluru")
    ap.add_argument("--nominal", type=float, default=230.0)
    ap.add_argument("--upper", type=float,
                    help="absolute upper limit in volts (overrides --upper-pct)")
    ap.add_argument("--upper-pct", type=float, default=10.0,
                    help="upper limit as %% above nominal (default 10)")
    ap.add_argument("--trip", type=float, default=270.0,
                    help="servo stabiliser trip voltage (default 270)")
    ap.add_argument("--night", default="22:00-06:00")
    ap.add_argument("--bypass", help="note the stabiliser bypass window, "
                                     "e.g. '25 Aug 13:00 onward'")
    ap.add_argument("--merge-gap", type=int, default=2,
                    help="merge episodes separated by fewer than N minutes")
    ap.add_argument("--min-episode", type=int, default=3,
                    help="omit over-voltage excursions shorter than N minutes")
    ap.add_argument("--min-outage", type=int, default=2,
                    help="ignore interruptions shorter than N minutes")
    args = ap.parse_args()

    if not os.path.exists(args.csv):
        sys.exit("no log at %s — is solar_inverter_mqtt.py deployed?" % args.csv)
    rows, gaps = load(args.csv)
    if not rows:
        sys.exit("%s has no valid readings yet" % args.csv)

    md, upper, night = render(rows, gaps, args)
    if args.out:
        with open(args.out, "w") as f:
            f.write(md + "\n")
        print("wrote %s (%d readings)" % (args.out, len(rows)))
    else:
        print(md)
    if args.svg:
        with open(args.svg, "w") as f:
            f.write(svg_chart(rows, args.nominal, upper, args.trip, night))
        print("wrote %s" % args.svg)


if __name__ == "__main__":
    main()
