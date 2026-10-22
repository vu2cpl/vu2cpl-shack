#!/usr/bin/env bash
# restic-maint — weekly forget / prune / check of every shack restic repository, run from the Mac.
#
# The boxes back up through the NAS rest-server's APPEND-ONLY endpoint (:9900), so they cannot delete
# anything — retention and integrity checks happen here instead, through the full-access endpoint
# (:9901, user `maint`). Keeping the only deleting credential on the Mac is the point: a compromised
# box can't destroy its own backups.
#
# Per repository:
#   1. restic forget --prune with the KEEP_* policy (7 daily, 5 weekly, 12 monthly);
#   2. restic check --read-data-subset=N/20, N rotating with the ISO week, so all pack data is re-read
#      every 20 weeks.
# Reports retained MQTT on shack/backup/maint; Telegram only on failure and on the first good run after.
#
#   restic-maint.sh              normal weekly run (launchd com.vu2cpl.restic-maint, Sun 10:30)
#   restic-maint.sh --dry-run    show what forget would remove; no prune, no check
#   restic-maint.sh HOST -- ARGS run restic ARGS against HOST's repo with full access (e.g. ubersdr -- snapshots)
#
# Needs in ~/.config/vu2cpl-shack.env: RESTIC_REST_MAINT, RESTIC_PASSWORD_<HOST> per repo,
# TELEGRAM_TOKEN/TELEGRAM_CHAT_ID, MQTT_BROKER/MQTT_USER/MQTT_PASS (optional). Cert: ~/.config/restic/nas.crt.

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Not ~/Library/Caches (restic's macOS default): a cleaner (Mole) emptied it at 10:33 on 2026-10-22 and killed the
# first off-site seed mid-run.
export RESTIC_CACHE_DIR="$HOME/.cache/restic"

ENV_FILE="$HOME/.config/vu2cpl-shack.env"
STATE_DIR="$HOME/.local/state/restic-maint"
HOSTS="ubersdr macmini-server"
NAS=192.168.1.101:9901
KEEP=(--keep-daily 7 --keep-weekly 5 --keep-monthly 12)

mkdir -p "$STATE_DIR"
envval() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d "\"' "; }
log() { echo "$(date '+%F %T') $*"; }

use_repo() {   # export the env for one repo; returns 1 if its password is missing
    local h=$1 var
    var="RESTIC_PASSWORD_$(echo "$h" | tr 'a-z-' 'A-Z_')"
    RESTIC_PASSWORD=$(envval "$var")
    [ -n "$RESTIC_PASSWORD" ] || { log "no $var in $ENV_FILE"; return 1; }
    export RESTIC_PASSWORD
    export RESTIC_REPOSITORY="rest:https://maint:$(envval RESTIC_REST_MAINT)@${NAS}/${h}/"
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
    shift 2; exec restic "$@"
fi

DRY=""; [ "${1:-}" = "--dry-run" ] && DRY=1
PART=$(( 10#$(date +%V) % 20 + 1 ))
FAILS=(); RESULTS=()

for h in $HOSTS; do
    use_repo "$h" || { FAILS+=("$h: no repository password on the Mac"); continue; }
    if [ -n "$DRY" ]; then
        restic forget "${KEEP[@]}" --dry-run; continue
    fi
    if ! restic forget "${KEEP[@]}" --prune >"$STATE_DIR/$h.forget.log" 2>&1; then
        FAILS+=("$h forget/prune: $(tail -2 "$STATE_DIR/$h.forget.log" | tr '\n' ' ' | cut -c1-200)")
        continue
    fi
    if restic check --read-data-subset="${PART}/20" >"$STATE_DIR/$h.check.log" 2>&1; then
        snaps=$(restic snapshots --json 2>/dev/null | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))' 2>/dev/null)
        RESULTS+=("\"$h\": {\"ok\": true, \"snapshots\": ${snaps:-null}}")
        log "$h ok: pruned, check ${PART}/20 passed, ${snaps:-?} snapshots"
    else
        FAILS+=("$h check ${PART}/20 FAILED: $(tail -3 "$STATE_DIR/$h.check.log" | tr '\n' ' ' | cut -c1-200)")
    fi
done
[ -n "$DRY" ] && exit 0

STATE=ok; [ ${#FAILS[@]} -gt 0 ] && STATE=fail
MSG=$( [ "$STATE" = ok ] && echo ok || printf '%s; ' "${FAILS[@]}" )
JSON=$(printf '{"state": "%s", "time": %s, "check_part": "%s/20", "repos": {%s}, "message": %s}' \
    "$STATE" "$(date +%s)" "$PART" "$(IFS=,; echo "${RESULTS[*]:-}")" \
    "$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()[:500]))')")
echo "$JSON" > "$STATE_DIR/last.json"
user=$(envval MQTT_USER); pass=$(envval MQTT_PASS); broker=$(envval MQTT_BROKER)
if [ -n "$user" ] && [ -n "$pass" ] && command -v mosquitto_pub >/dev/null; then
    mosquitto_pub -h "${broker:-192.168.1.169}" -u "$user" -P "$pass" -t shack/backup/maint -r -q 1 -m "$JSON" \
        || log "MQTT publish failed"
fi
log "$STATE $MSG"

prev=$(cat "$STATE_DIR/state" 2>/dev/null || echo ok)
echo "$STATE" > "$STATE_DIR/state"
if [ "$STATE" = fail ]; then
    send "🔴 <b>restic weekly maintenance FAILED</b> (Mac)
$(echo "$MSG" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
Logs: ~/.local/state/restic-maint/"
    exit 1
elif [ "$prev" != ok ]; then
    send "✅ restic weekly maintenance recovered (check ${PART}/20 passed on all repos)"
fi
exit 0
