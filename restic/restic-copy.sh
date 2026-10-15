#!/usr/bin/env bash
# restic-copy — nightly second copy of every shack restic repository onto the UberSDR box's 1 TB HDD,
# run from the Mac.
#
# The NAS (DS710+, DSM 5.2, unpatched since ~2017) holds the only copy of the backups. This copies new
# snapshots from each NAS repository (full-access endpoint :9901, user `maint`) to a repository of the same
# name on .109's /mnt/backups (sda) over sftp. Each copy uses the same password as its source and the same
# chunker parameters, so dedup works and no new secret lands on .109. It protects against a NAS failure,
# not against losing the house (that's #50 (e), off-site).
#
# Per repository:
#   1. init the copy on first use (--copy-chunker-params from the source);
#   2. restic copy (only snapshots the copy doesn't have yet);
#   3. Sundays only: forget --prune with the same KEEP_* policy as restic-maint, then a metadata check.
# Refuses to run if /mnt/backups isn't mounted on .109 (fstab nofail), so it can't fill the NVMe.
# Reports retained MQTT on shack/backup/copy; Telegram only on failure and on the first good run after.
#
#   restic-copy.sh               normal run (launchd com.vu2cpl.restic-copy, daily 05:30)
#   restic-copy.sh HOST -- ARGS  run restic ARGS against HOST's copy on .109 (e.g. ubersdr -- snapshots)
#
# Needs in ~/.config/vu2cpl-shack.env: RESTIC_REST_MAINT, RESTIC_PASSWORD_<HOST> per repo,
# TELEGRAM_TOKEN/TELEGRAM_CHAT_ID, MQTT_BROKER/MQTT_USER/MQTT_PASS (optional). Cert: ~/.config/restic/nas.crt.
# Key login from the Mac to manoj@192.168.1.109.

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ENV_FILE="$HOME/.config/vu2cpl-shack.env"
STATE_DIR="$HOME/.local/state/restic-copy"
HOSTS="ubersdr macmini-server"
NAS=192.168.1.101:9901
DEST_SSH=manoj@192.168.1.109
DEST_MNT=/mnt/backups
DEST_DIR=$DEST_MNT/restic
KEEP=(--keep-daily 7 --keep-weekly 5 --keep-monthly 12)

mkdir -p "$STATE_DIR"
envval() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d "\"' "; }
log() { echo "$(date '+%F %T') $*"; }

use_repo() {   # export the env for one repo pair; returns 1 if its password is missing
    local h=$1 var
    var="RESTIC_PASSWORD_$(echo "$h" | tr 'a-z-' 'A-Z_')"
    RESTIC_PASSWORD=$(envval "$var")
    [ -n "$RESTIC_PASSWORD" ] || { log "no $var in $ENV_FILE"; return 1; }
    export RESTIC_PASSWORD RESTIC_FROM_PASSWORD="$RESTIC_PASSWORD"
    export RESTIC_FROM_REPOSITORY="rest:https://maint:$(envval RESTIC_REST_MAINT)@${NAS}/${h}/"
    export RESTIC_REPOSITORY="sftp:${DEST_SSH}:${DEST_DIR}/${h}"
    export RESTIC_CACERT="$HOME/.config/restic/nas.crt"
}

send() {
    local tok chat
    tok=$(envval TELEGRAM_TOKEN); chat=$(envval TELEGRAM_CHAT_ID)
    [ -n "$tok" ] && [ -n "$chat" ] || { log "no Telegram creds, not sent: $1"; return 1; }
    curl -fsS --max-time 15 -o /dev/null --data-urlencode "chat_id=${chat}" -d parse_mode=HTML \
        --data-urlencode "text=$1" "https://api.telegram.org/bot${tok}/sendMessage" || log "Telegram send failed"
}

if [ "${2:-}" = "--" ]; then
    use_repo "$1" || exit 1
    unset RESTIC_FROM_REPOSITORY RESTIC_FROM_PASSWORD
    shift 2; exec restic "$@"
fi

# One run at a time (the first seed takes ~8 h and would overlap the next 05:30 run).
LOCK="$STATE_DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
    pid=$(cat "$LOCK/pid" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then log "already running (pid $pid), skipping"; exit 0; fi
    rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

SUNDAY=""; [ "$(date +%u)" = 7 ] && SUNDAY=1
FAILS=(); RESULTS=()

if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$DEST_SSH" "mountpoint -q $DEST_MNT && test -w $DEST_DIR"; then
    FAILS+=("$DEST_MNT not mounted or $DEST_DIR not writable on $DEST_SSH (or ssh failed)")
else
    for h in $HOSTS; do
        use_repo "$h" || { FAILS+=("$h: no repository password on the Mac"); continue; }
        if ! restic cat config >/dev/null 2>&1; then
            log "$h: initialising the copy at $RESTIC_REPOSITORY"
            if ! restic init --copy-chunker-params >"$STATE_DIR/$h.init.log" 2>&1; then
                FAILS+=("$h init: $(tail -2 "$STATE_DIR/$h.init.log" | tr '\n' ' ' | cut -c1-200)"); continue
            fi
        fi
        t0=$(date +%s)
        if ! restic copy >"$STATE_DIR/$h.copy.log" 2>&1; then
            FAILS+=("$h copy: $(tail -2 "$STATE_DIR/$h.copy.log" | tr '\n' ' ' | cut -c1-200)"); continue
        fi
        if [ -n "$SUNDAY" ]; then
            if ! restic forget "${KEEP[@]}" --prune >"$STATE_DIR/$h.forget.log" 2>&1; then
                FAILS+=("$h forget/prune: $(tail -2 "$STATE_DIR/$h.forget.log" | tr '\n' ' ' | cut -c1-200)"); continue
            fi
            if ! restic check >"$STATE_DIR/$h.check.log" 2>&1; then
                FAILS+=("$h check FAILED: $(tail -3 "$STATE_DIR/$h.check.log" | tr '\n' ' ' | cut -c1-200)"); continue
            fi
        fi
        latest=$(restic snapshots --latest 1 --json 2>/dev/null | python3 -c 'import sys,json; s=json.load(sys.stdin); print(s[-1]["short_id"] if s else "")' 2>/dev/null)
        RESULTS+=("\"$h\": {\"ok\": true, \"latest\": \"${latest}\", \"duration_s\": $(( $(date +%s) - t0 ))}")
        log "$h ok: copy done, latest ${latest:-?}${SUNDAY:+, pruned + checked}"
    done
fi

STATE=ok; [ ${#FAILS[@]} -gt 0 ] && STATE=fail
MSG=$( [ "$STATE" = ok ] && echo ok || printf '%s; ' "${FAILS[@]}" )
JSON=$(printf '{"state": "%s", "time": %s, "dest": "%s", "repos": {%s}, "message": %s}' \
    "$STATE" "$(date +%s)" "${DEST_SSH#*@}:$DEST_DIR" "$(IFS=,; echo "${RESULTS[*]:-}")" \
    "$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()[:500]))')")
echo "$JSON" > "$STATE_DIR/last.json"
user=$(envval MQTT_USER); pass=$(envval MQTT_PASS); broker=$(envval MQTT_BROKER)
if [ -n "$user" ] && [ -n "$pass" ] && command -v mosquitto_pub >/dev/null; then
    mosquitto_pub -h "${broker:-192.168.1.169}" -u "$user" -P "$pass" -t shack/backup/copy -r -q 1 -m "$JSON" \
        || log "MQTT publish failed"
fi
log "$STATE $MSG"

prev=$(cat "$STATE_DIR/state" 2>/dev/null || echo ok)
echo "$STATE" > "$STATE_DIR/state"
if [ "$STATE" = fail ]; then
    send "🔴 <b>restic copy to .109 FAILED</b> (Mac)
$(echo "$MSG" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
Logs: ~/.local/state/restic-copy/"
    exit 1
elif [ "$prev" != ok ]; then
    send "✅ restic copy to .109 recovered (all repos copied)"
fi
exit 0
