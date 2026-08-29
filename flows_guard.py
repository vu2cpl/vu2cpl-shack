#!/usr/bin/env python3
"""flows_guard.py — structural tripwire for flows.json stale-tab wipes.

A Node-RED editor tab that outlives an out-of-band flows.json change
(git pull + systemctl restart) still holds the old flow model in browser
memory. Deploy always writes back the tab's ENTIRE model, silently
reverting everything done since the tab loaded — three times in 2026
(07-13, 08-21 x2) that wiped every Vue-bridge wire into uib_shack_01,
the dashboard CSS, and assorted AS3935/rotator wires.

Root cause (established 2026-08-21 after wipe #5): the May 2026 Vue
migration hand-wrote CROSS-TAB wires (and a non-standard ui_base css
field) directly into flows.json. The runtime executes them; the editor
cannot even represent them, so EVERY editor Deploy silently stripped
them. Fixed the same day by refactoring all cross-tab hops onto
link in / link out pairs (the editor-legal mechanism) and moving the
CSS into a site-<head> ui_template.

This script checks the structural invariants:

  1. flows.json parses as a JSON array with a sane node count
  2. at least MIN_UIB_FEEDERS nodes feed the uibuilder node — directly
     wired, or a `link out` linked to a `link in` that wires into it
     (healthy count 2026-08 post-refactor: 14 — a wipe drops it to 0)
  3. ZERO cross-tab or dead wires — the editor-illegal construct that
     caused all five 2026 wipes must never be reintroduced by a hand
     edit of flows.json

Sibling file `flows_guard_middleware.js` enforces the SAME invariants
server-side at deploy time (httpAdminMiddleware in settings.js, added
after wipe #5 rode in through the editor's conflict-merge dialog) —
keep the constants in both files in sync.

Used two ways:
  * git pre-commit hook (Pi + Mac clones):
        git show :flows.json | flows_guard.py --stdin
    → a wiped flows.json can never enter git history; recovery stays
      a one-liner (git checkout -- flows.json + restart).
  * cron tripwire on the Pi, every minute:
        flows_guard.py --cron
    → Telegram alert on healthy→broken transition (and ✅ on recovery),
      via the shack bot. Token/chat-id resolve from our own environment,
      then the shack env files (/etc/default/vu2cpl-shack, then
      ~/.config/vu2cpl-shack.env which wins — monitor.sh's precedence),
      then the running Node-RED process environment as a fallback.
      The env-file step was added 2026-08-29 alongside stabiliser_watch.py;
      before it, a Node-RED outage silently disabled alerting. That was
      justified on the grounds that this guards a bad DEPLOY, during
      which Node-RED is by definition running — true of the main case,
      but not of a wipe arriving by git operation or manual edit while
      Node-RED is stopped, nor of the restart in the recovery path.

If a deliberate refactor legitimately changes these invariants
(e.g. retiring the Vue dashboard), update the constants below FIRST,
in the same commit as the refactor.
"""

import json
import os
import shlex
import subprocess
import sys
import urllib.parse
import urllib.request

UIB_NODE_ID = "uib_shack_01"   # the uibuilder node all Vue builders feed
MIN_UIB_FEEDERS = 10           # healthy = 14 (2026-08); wipe = 0
MIN_NODE_COUNT = 300           # healthy = 518 (2026-08); catches truncation
STATE_FILE = os.path.expanduser("~/.flows_guard_state")
DEFAULT_FLOWS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "flows.json")

RECOVERY_HINT = ("cd ~/.node-red/projects/vu2cpl-shack && "
                 "git checkout -- flows.json && sudo systemctl restart nodered")


def check(flows):
    """Return a list of failure strings (empty = healthy)."""
    fails = []
    if not isinstance(flows, list):
        return ["flows.json is not a JSON array"]
    if len(flows) < MIN_NODE_COUNT:
        fails.append(f"node count {len(flows)} < {MIN_NODE_COUNT}")
    nodes = [n for n in flows if isinstance(n, dict) and n.get("id")]
    byid = {n["id"]: n for n in nodes}

    def wires_to(n, target):
        return any(isinstance(out, list) and target in out
                   for out in n.get("wires", []))

    # feeders = nodes wired into the uibuilder node directly, plus
    # link-out nodes linked to a link-in that wires into it
    link_ins_to_uib = {n["id"] for n in nodes
                       if n.get("type") == "link in" and wires_to(n, UIB_NODE_ID)}
    feeders = sum(
        1 for n in nodes
        if wires_to(n, UIB_NODE_ID)
        or (n.get("type") == "link out"
            and any(l in link_ins_to_uib for l in n.get("links", [])))
    )
    if feeders < MIN_UIB_FEEDERS:
        fails.append(f"only {feeders} nodes feed {UIB_NODE_ID} "
                     f"(need >= {MIN_UIB_FEEDERS}) — Vue-bridge wiring wiped?")

    # zero cross-tab / dead wires (the editor strips these on every Deploy;
    # cross-tab hops must use link in / link out pairs)
    bad = []
    for n in nodes:
        if not n.get("z"):
            continue
        for out in n.get("wires", []):
            for t in (out if isinstance(out, list) else []):
                tn = byid.get(t)
                if tn is None:
                    bad.append(f"{n.get('name') or n['id']} → {t} (missing node)")
                elif tn.get("z") != n.get("z"):
                    bad.append(f"{n.get('name') or n['id']} → "
                               f"{tn.get('name') or t} (cross-tab)")
    if bad:
        shown = "; ".join(bad[:3]) + (f"; … +{len(bad)-3} more" if len(bad) > 3 else "")
        fails.append(f"{len(bad)} cross-tab/dead wire(s) — editor-illegal, "
                     f"use link in/out pairs: {shown}")
    return fails


ENV_FILES = ("/etc/default/vu2cpl-shack",
             os.path.expanduser("~/.config/vu2cpl-shack.env"))


def read_env_files():
    """Parse the shack env files the shell scripts source.

    monitor.sh's precedence: the /etc file first, the per-user one
    second so it wins. Deliberately duplicated from stabiliser_watch.py
    rather than shared — this script also runs as a git pre-commit hook
    from an arbitrary cwd in two different clones, so it must stay
    import-free and standalone.
    """
    out = {}
    for path in ENV_FILES:
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if line.startswith("export "):
                        line = line[7:].lstrip()
                    if "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip()
                    if not k.replace("_", "").isalnum():
                        continue
                    try:                       # strip shell quoting
                        parts = shlex.split(v)
                        v = parts[0] if parts else ""
                    except ValueError:
                        v = v.strip().strip("'\"")
                    out[k] = v
        except OSError:
            continue                            # absent or unreadable: fine
    return out


def telegram_creds():
    """Token/chat-id: our env, then the shack env files, then Node-RED."""
    tok, chat = os.environ.get("TELEGRAM_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if tok and chat:
        return tok, chat

    env_file = read_env_files()
    tok = tok or env_file.get("TELEGRAM_TOKEN")
    chat = chat or env_file.get("TELEGRAM_CHAT_ID")
    if tok and chat:
        return tok, chat

    try:
        pid = subprocess.run(
            ["systemctl", "show", "-p", "MainPID", "--value", "nodered"],
            capture_output=True, text=True, timeout=10).stdout.strip()
        if pid and pid != "0":
            with open(f"/proc/{pid}/environ", "rb") as f:
                env = dict(
                    kv.split("=", 1) for kv in
                    f.read().decode(errors="replace").split("\0") if "=" in kv)
            return env.get("TELEGRAM_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    except Exception as e:
        print(f"flows_guard: could not read Node-RED environ: {e}", file=sys.stderr)
    return None, None


def send_telegram(text):
    tok, chat = telegram_creds()
    if not (tok and chat):
        print("flows_guard: no Telegram credentials available — alert skipped",
              file=sys.stderr)
        return False
    data = urllib.parse.urlencode(
        {"chat_id": chat, "text": text, "parse_mode": "HTML"}).encode()
    try:
        urllib.request.urlopen(
            f"https://api.telegram.org/bot{tok}/sendMessage", data, timeout=15)
        return True
    except Exception as e:
        print(f"flows_guard: Telegram send failed: {e}", file=sys.stderr)
        return False


def read_state():
    try:
        with open(STATE_FILE) as f:
            return f.read().strip()
    except OSError:
        return "ok"          # first run: assume healthy, alert only on break


def write_state(s):
    with open(STATE_FILE, "w") as f:
        f.write(s + "\n")


def main():
    args = sys.argv[1:]

    if "--test-telegram" in args:
        ok = send_telegram("🧪 <b>flows_guard</b> test — alert pipeline OK "
                           "(noderedpi4)")
        print("test message sent" if ok else "test message FAILED")
        return 0 if ok else 1

    if "--stdin" in args:
        flows = json.load(sys.stdin)
        src = "<stdin>"
    else:
        path = next((a for a in args if not a.startswith("--")), DEFAULT_FLOWS)
        src = path
        try:
            with open(path) as f:
                flows = json.load(f)
        except Exception as e:
            flows, parse_err = None, e

    fails = check(flows) if flows is not None else [f"cannot parse: {parse_err}"]

    if "--cron" in args:
        prev = read_state()
        if fails and prev == "ok":
            send_telegram(
                "⚠️ <b>flows.json WIPED?</b> (noderedpi4)\n"
                + "\n".join("• " + f for f in fails)
                + "\n\nLikely a stale-editor-tab Deploy. Recover with:\n"
                + f"<code>{RECOVERY_HINT}</code>")
            print("flows_guard: BROKEN — " + "; ".join(fails))
        elif not fails and prev == "bad":
            send_telegram("✅ <b>flows.json healthy again</b> (noderedpi4)")
            print("flows_guard: recovered")
        write_state("bad" if fails else "ok")
        return 0                       # cron itself always exits 0

    if fails:
        print(f"flows_guard: FAIL ({src})")
        for f in fails:
            print("  ✗ " + f)
        return 1
    print(f"flows_guard: OK ({src})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
