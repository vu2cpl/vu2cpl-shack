#!/usr/bin/env python3
"""Servo stabiliser watchdog — Telegram alert on trip, dropout or outage.

Watches the tail of ~/grid_voltage.csv (written every minute by
solar_inverter_mqtt.py) and alerts the shack Telegram bot when the
supply state changes. Cron-driven, once a minute, on the Pi.

Why this exists: the stabiliser was brought back online 2026-08-29
10:09 IST after ~4 days in bypass. The open question in the BESCOM
dispute is whether the nightly outages that stopped during bypass
resume now that it is back in circuit — see SHACK_CHANGELOG 2026-08-29.
The operator is asleep during the window that matters, so the answer
has to arrive as a push, not as a number he reads in the morning.

Three states are distinguished, because they point at different
culprits:

  * OUTAGE    — grid absent (grid_on=0, or the logger unreachable).
                This is the nightly-cut signature under test.
  * DROPOUT   — grid present but the readings are raw mains again
                (sustained high voltage), i.e. the stabiliser is no
                longer in circuit: tripped to bypass, or switched out.
  * STALE     — the CSV stopped growing, so this watchdog is blind.
                Alerted because silence would otherwise read as calm.

Detection notes. Phase *spread* is not a usable discriminator: during
the bypass window spreads ranged 0.6-22 V and overlapped the regulated
range entirely. Absolute voltage separates them cleanly — regulated
output has sat at 230-236 V, while raw mains ran 250-264 V — so
RAW_MAINS_V keys on vmax, confirmed over several samples so a single
spike cannot trip it.

Pure stdlib. Mirrors flows_guard.py's Telegram plumbing (env first,
then the running Node-RED process environment) so no secret is stored
on disk.

Usage:
  stabiliser_watch.py --cron      # one pass, alert on transition
  stabiliser_watch.py --status    # print current state, no alert
  stabiliser_watch.py --test      # send a test Telegram
"""

import csv
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, time as dtime, timedelta

CSV_PATH = os.path.expanduser("~/grid_voltage.csv")
STATE_FILE = os.path.expanduser("~/.stabiliser_watch.state")

# Sustained vmax above this means the readings are raw mains, i.e. the
# stabiliser is not in circuit. Regulated output has never reached it.
RAW_MAINS_V = 245.0

CONFIRM_DROPOUT = 3      # samples of raw mains before calling a dropout
CONFIRM_OUTAGE = 2       # samples of grid-absent before calling an outage
STALE_MIN = 6            # minutes without a new row = watchdog blind
TAIL_BYTES = 65536

NIGHT_START, NIGHT_END = dtime(22, 0), dtime(6, 0)


def tail_rows(path, nbytes=TAIL_BYTES):
    """Parse the last chunk of the CSV. Returns rows oldest-first."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - nbytes))
        chunk = f.read().decode(errors="replace")
    lines = chunk.splitlines()
    if not lines:
        return []
    # Drop line 0 either way: a mid-file seek leaves it a partial row, and
    # reading from the top makes it the header. Neither is data.
    lines = lines[1:]
    cols = ["ts_iso", "ts_epoch", "status", "l1_v", "l2_v", "l3_v",
            "grid_on", "batt_soc", "batt_p_w"]
    out = []
    for r in csv.DictReader(lines, fieldnames=cols):
        try:
            ts = datetime.fromtimestamp(int(r["ts_epoch"]))
        except (TypeError, ValueError):
            continue
        row = {"ts": ts, "status": r.get("status", "?")}
        if row["status"] != "ok":
            row["grid_on"] = None       # no reading at all
            out.append(row)
            continue
        try:
            v = [float(r[p]) for p in ("l1_v", "l2_v", "l3_v")]
            row["v"] = v
            row["vmax"], row["vmin"] = max(v), min(v)
            row["grid_on"] = r["grid_on"] == "1"
            row["soc"] = int(r["batt_soc"] or 0)
            row["batt_w"] = int(r["batt_p_w"] or 0)
        except (KeyError, TypeError, ValueError):
            continue
        out.append(row)
    out.sort(key=lambda x: x["ts"])
    return out


def classify(rows, now=None):
    """Return (state, detail). States: regulating / outage / dropout /
    stale / unknown."""
    now = now or datetime.now()
    if not rows:
        return "unknown", "no readings in the log tail"

    last = rows[-1]
    age = (now - last["ts"]).total_seconds() / 60.0
    if age > STALE_MIN:
        return "stale", ("no new reading for %d min (last %s) — "
                         "solar_inverter_mqtt.py cron may be dead"
                         % (int(age), last["ts"].strftime("%H:%M")))

    # Grid absent: grid_on false, or the inverter unreadable. Both mean
    # the same thing here, per outage_episodes() in grid_voltage_report.py.
    def absent(r):
        return r["grid_on"] is None or r["grid_on"] is False

    recent = rows[-CONFIRM_OUTAGE:]
    if len(recent) >= CONFIRM_OUTAGE and all(absent(r) for r in recent):
        start = last["ts"]
        for r in reversed(rows):
            if absent(r):
                start = r["ts"]
            else:
                break
        mins = int((last["ts"] - start).total_seconds() // 60) + 1
        soc = next((r.get("soc") for r in reversed(rows)
                    if r.get("soc") is not None), None)
        return "outage", ("grid absent since %s (%d min)%s"
                          % (start.strftime("%H:%M"), mins,
                             "" if soc is None else ", battery %d%%" % soc))

    live = [r for r in rows if r.get("grid_on") and "vmax" in r]
    if not live:
        return "unknown", "no grid-present readings in the tail"

    recent_live = live[-CONFIRM_DROPOUT:]
    if (len(recent_live) >= CONFIRM_DROPOUT
            and all(r["vmax"] > RAW_MAINS_V for r in recent_live)):
        peak = max(r["vmax"] for r in recent_live)
        return "dropout", ("readings back at raw-mains level for %d samples "
                           "(peak %.1f V, now %s) — stabiliser appears out "
                           "of circuit"
                           % (len(recent_live), peak, fmt_v(live[-1])))

    return "regulating", fmt_v(live[-1])


def fmt_v(row):
    return "%.1f / %.1f / %.1f V" % tuple(row["v"])


def in_night(ts):
    t = ts.time()
    return t >= NIGHT_START or t < NIGHT_END


def telegram_creds():
    """Token/chat-id from our env, else from the running Node-RED process."""
    tok, chat = os.environ.get("TELEGRAM_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if tok and chat:
        return tok, chat
    try:
        pid = subprocess.run(
            ["systemctl", "show", "-p", "MainPID", "--value", "nodered"],
            capture_output=True, text=True, timeout=10).stdout.strip()
        if pid and pid != "0":
            with open("/proc/%s/environ" % pid, "rb") as f:
                env = dict(kv.split("=", 1) for kv in
                           f.read().decode(errors="replace").split("\0")
                           if "=" in kv)
            return env.get("TELEGRAM_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    except Exception as e:
        print("stabiliser_watch: could not read Node-RED environ: %s" % e,
              file=sys.stderr)
    return None, None


def send_telegram(text):
    tok, chat = telegram_creds()
    if not (tok and chat):
        print("stabiliser_watch: no Telegram credentials — alert skipped",
              file=sys.stderr)
        return False
    data = urllib.parse.urlencode(
        {"chat_id": chat, "text": text, "parse_mode": "HTML"}).encode()
    try:
        urllib.request.urlopen(
            "https://api.telegram.org/bot%s/sendMessage" % tok, data, timeout=15)
        return True
    except Exception as e:
        print("stabiliser_watch: Telegram send failed: %s" % e, file=sys.stderr)
        return False


def read_state():
    try:
        with open(STATE_FILE) as f:
            return f.read().strip() or "regulating"
    except OSError:
        return None          # first run


def write_state(s):
    with open(STATE_FILE, "w") as f:
        f.write(s + "\n")


ICON = {"outage": "🔴", "dropout": "🟠", "stale": "⚪", "regulating": "✅",
        "unknown": "⚪"}

TITLE = {"outage": "SUPPLY LOST",
         "dropout": "STABILISER OUT OF CIRCUIT",
         "stale": "VOLTAGE LOG STALLED",
         "unknown": "STABILISER WATCH — UNKNOWN STATE"}


def compose(state, detail, prev, now):
    night = in_night(now)
    if state == "regulating":
        msg = ["✅ <b>SUPPLY BACK TO NORMAL</b>",
               "Stabiliser regulating again: %s" % detail]
        if prev == "outage":
            msg.append("Recovered from a supply interruption.")
        elif prev == "dropout":
            msg.append("Stabiliser is back in circuit.")
        elif prev == "stale":
            msg.append("Voltage log is being written again.")
    else:
        msg = ["%s <b>%s</b>" % (ICON[state], TITLE[state]), detail]
        if state == "outage":
            msg.append("")
            msg.append("This is the pattern under test: nightly cuts "
                       "stopped while the stabiliser was bypassed "
                       "(25-29 Aug). A cut now, with it back in circuit, "
                       "points at the stabiliser rather than BESCOM.")
        elif state == "dropout":
            msg.append("")
            msg.append("Readings are true incoming mains again while this "
                       "lasts — usable as supply evidence, unlike regulated "
                       "output.")
    msg.append("")
    msg.append("<i>%s%s · noderedpi4</i>"
               % (now.strftime("%d %b %H:%M"),
                  " · night window" if night else ""))
    return "\n".join(msg)


def main():
    args = sys.argv[1:]

    if "--test" in args:
        ok = send_telegram("🧪 <b>stabiliser_watch</b> test — alert pipeline "
                           "OK (noderedpi4)")
        print("test message sent" if ok else "test message FAILED")
        return 0 if ok else 1

    if not os.path.exists(CSV_PATH):
        print("stabiliser_watch: no log at %s" % CSV_PATH, file=sys.stderr)
        return 1

    now = datetime.now()
    rows = tail_rows(CSV_PATH)
    state, detail = classify(rows, now)

    if "--status" in args:
        print("%s: %s" % (state, detail))
        return 0

    prev = read_state()

    # First run: remember what we saw, and only shout if it is already bad.
    if prev is None:
        write_state(state)
        if state != "regulating":
            send_telegram(compose(state, detail, prev, now))
        print("stabiliser_watch: first run, state=%s" % state)
        return 0

    if state == prev:
        return 0

    # "unknown" is a transient read artefact, not a condition worth waking
    # anyone for; record it but stay quiet.
    if state == "unknown":
        write_state(state)
        return 0

    write_state(state)
    if send_telegram(compose(state, detail, prev, now)):
        print("stabiliser_watch: %s -> %s (alerted)" % (prev, state))
    else:
        print("stabiliser_watch: %s -> %s (alert FAILED)" % (prev, state))
    return 0


if __name__ == "__main__":
    sys.exit(main())
