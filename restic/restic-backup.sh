#!/usr/bin/env bash
# restic-backup — nightly encrypted, deduplicated backup of a shack Linux box to the Synology.
#
# Installed as /usr/local/bin/restic-backup by restic/deploy.sh and run as root by
# restic-backup.timer. Per-host settings live in /etc/restic/backup.conf (from restic/hosts/<host>.conf).
# Secrets, all root mode 600 and never in git:
#   /etc/restic/password    repository encryption password (a copy must also be kept off the box, or the
#                           backups are unreadable once the box is gone)
#   /etc/restic/repository  rest:https://<host>:<pw>@192.168.1.101:9900/<host>/ — the NAS rest-server's
#                           APPEND-ONLY endpoint: this box can add snapshots but never delete or rewrite
#                           anything, so forget/prune/check run weekly from the Mac (restic-maint.sh).
#
# Each run:
#   1. dumps the MariaDB containers listed in DB_DUMPS (their live data dirs are excluded — a file copy
#      of a running database is not a usable backup), checks the Immich nightly dump is fresh;
#   2. restic backup of BACKUP_PATHS (one file system per path, so /proc, /snap etc. are never crossed);
#   3. retained MQTT status on shack/backup/<host>, Telegram only on failure/warning and on recovery.
#
#   restic-backup            normal nightly run
#   restic-backup --status   print the last run's status and the latest snapshots, change nothing
#   restic-backup --test     send a test Telegram message
#   restic-backup -- ARGS    run restic ARGS against this box's repository (e.g. -- snapshots)
#
# Exit codes: 0 ok, 3 backup finished but some files were unreadable (warn), 1 failed.

set -u

CONF=/etc/restic/backup.conf
STATE_DIR=/var/lib/restic-backup
DUMP_DIR=/var/backups/restic-dumps
LOG_TAG=restic-backup

# Defaults; backup.conf overrides.
HOST_LABEL=$(hostname)
BACKUP_PATHS="/"
EXCLUDE_FILES="/etc/restic/exclude-common.txt"
DB_DUMPS=""
IMMICH_DUMP_DIR=""
GOMAXPROCS=2
ENV_FILE=/home/manoj/.config/vu2cpl-shack.env
MQTT_HOST=192.168.1.169
MQTT_PORT=1883

[ -r "$CONF" ] || { echo "missing $CONF — run restic/deploy.sh for this host" >&2; exit 1; }
# shellcheck source=/dev/null
. "$CONF"

export GOMAXPROCS
export RESTIC_REPOSITORY_FILE=/etc/restic/repository
export RESTIC_PASSWORD_FILE=/etc/restic/password
export RESTIC_CACERT=/etc/restic/nas.crt      # the NAS rest-server's self-signed cert
export RESTIC_CACHE_DIR=/var/cache/restic
SHORT=$(hostname -s)
TOPIC="shack/backup/${SHORT}"

mkdir -p "$STATE_DIR" "$DUMP_DIR"
chmod 700 "$DUMP_DIR"

log() { logger -t "$LOG_TAG" -- "$*"; echo "$(date '+%F %T') $*"; }

envval() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d "\"' "; }

send() {
    local tok chat
    tok=$(envval TELEGRAM_TOKEN); chat=$(envval TELEGRAM_CHAT_ID)
    if [ -z "$tok" ] || [ -z "$chat" ]; then
        log "no Telegram creds in $ENV_FILE, alert not sent: $1"
        return 1
    fi
    curl -fsS --max-time 15 -o /dev/null \
        --data-urlencode "chat_id=${chat}" -d parse_mode=HTML \
        --data-urlencode "text=$1" "https://api.telegram.org/bot${tok}/sendMessage" \
        || { log "Telegram send failed"; return 1; }
}

mqtt_pub() {   # retained; silently skipped without MQTT creds
    local user pass
    user=$(envval MQTT_USER); pass=$(envval MQTT_PASS)
    [ -n "$user" ] && [ -n "$pass" ] && command -v mosquitto_pub >/dev/null || return 0
    mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -u "$user" -P "$pass" \
        -t "$TOPIC" -r -q 1 -m "$1" 2>/dev/null || log "MQTT publish to $TOPIC failed"
}

case "${1:-}" in
    --test)
        send "🧪 restic-backup test from <b>${HOST_LABEL}</b>" && echo sent; exit $? ;;
    --status)
        cat "$STATE_DIR/last.json" 2>/dev/null || echo "no run recorded yet"
        echo; restic snapshots --compact --latest 5; exit $? ;;
    --)
        shift; exec restic "$@" ;;
    "") ;;
    *) echo "usage: $0 [--status|--test|-- restic-args]" >&2; exit 2 ;;
esac

START=$(date +%s)
WARN=()

# ---- 1. database dumps ------------------------------------------------------------------------
# DB_DUMPS = space-separated MariaDB container names. The dump uses the container's own
# MARIADB_USER/MARIADB_PASSWORD/MARIADB_DATABASE env, so no credentials are kept here.
for c in $DB_DUMPS; do
    out="$DUMP_DIR/${c}.sql.gz"
    if docker exec "$c" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" exec mariadb-dump --single-transaction --quick \
            --routines --skip-comments -u"$MARIADB_USER" "$MARIADB_DATABASE"' 2>"$STATE_DIR/dump-err" \
            | gzip -6 > "$out.part" && [ "${PIPESTATUS[0]}" -eq 0 ] && [ "$(stat -c %s "$out.part")" -gt 1000 ]; then
        mv "$out.part" "$out"
        log "dump $c ok ($(stat -c %s "$out") bytes)"
    else
        rm -f "$out.part"
        WARN+=("dump of $c failed: $(head -c 200 "$STATE_DIR/dump-err")")
        log "dump $c FAILED"
    fi
done

# Immich writes its own DB dump at 07:30 IST (02:00 UTC); the live postgres dir is excluded, so that dump is the
# database backup. Warn if the newest one is older than 26 h.
if [ -n "$IMMICH_DUMP_DIR" ]; then
    newest=$(find "$IMMICH_DUMP_DIR" -maxdepth 1 -name 'immich-db-backup-*.sql.gz' -mmin -1560 2>/dev/null | head -1)
    [ -n "$newest" ] || WARN+=("no Immich DB dump newer than 26 h in $IMMICH_DUMP_DIR")
fi

# ---- 2. backup --------------------------------------------------------------------------------
restic unlock >/dev/null 2>&1 || true    # clears only stale locks (append-only still allows lock deletes)

excl=()
for f in $EXCLUDE_FILES; do [ -r "$f" ] && excl+=(--exclude-file "$f"); done
# shellcheck disable=SC2086
restic backup $BACKUP_PATHS "$DUMP_DIR" "${excl[@]}" \
    --one-file-system --exclude-caches --tag nightly --host "$SHORT" \
    --json --quiet > "$STATE_DIR/backup.json" 2> "$STATE_DIR/backup.err"
RC=$?
SUMMARY=$(grep '"message_type":"summary"' "$STATE_DIR/backup.json" | tail -1)

field() { echo "$SUMMARY" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('$1',''))
except Exception: print('')"; }

SNAP=$(field snapshot_id); SNAP=${SNAP:0:8}
ADDED=$(field data_added); NEWF=$(field files_new); CHGF=$(field files_changed); TOTALB=$(field total_bytes_processed)
ERRTAIL=$(grep -v '^$' "$STATE_DIR/backup.err" | tail -3 | cut -c1-300)

if [ $RC -eq 3 ]; then
    WARN+=("some files could not be read: ${ERRTAIL}")
elif [ $RC -ne 0 ]; then
    STATE=fail
fi

# ---- 3. report --------------------------------------------------------------------------------
DUR=$(( $(date +%s) - START ))
if [ "${STATE:-}" = fail ]; then
    MSG="backup failed (rc=$RC): ${ERRTAIL}"
elif [ ${#WARN[@]} -gt 0 ]; then
    STATE=warn; MSG=$(printf '%s; ' "${WARN[@]}")
else
    STATE=ok; MSG="ok"
fi

JSON=$(STATE="$STATE" MSG="$MSG" SNAP="$SNAP" ADDED="$ADDED" NEWF="$NEWF" CHGF="$CHGF" TOTALB="$TOTALB" \
       DUR="$DUR" HOSTN="$SHORT" python3 -c '
import json, os, time
n = lambda k: int(float(os.environ[k])) if os.environ.get(k) else None
print(json.dumps({"host": os.environ["HOSTN"], "state": os.environ["STATE"], "time": int(time.time()),
    "snapshot": os.environ["SNAP"] or None, "data_added": n("ADDED"), "files_new": n("NEWF"),
    "files_changed": n("CHGF"), "total_bytes": n("TOTALB"), "duration_s": n("DUR"),
    "message": os.environ["MSG"][:500]}))')
echo "$JSON" > "$STATE_DIR/last.json"
mqtt_pub "$JSON"
log "$STATE snapshot=${SNAP:-none} added=${ADDED:-?}B duration=${DUR}s ${MSG}"

prev=$(cat "$STATE_DIR/state" 2>/dev/null || echo ok)
echo "$STATE" > "$STATE_DIR/state"
esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
human() { numfmt --to=iec --suffix=B "${1:-0}" 2>/dev/null || echo "${1:-?}B"; }
case "$STATE" in
    fail) send "🔴 <b>restic backup FAILED</b> on ${HOST_LABEL}
$(echo "$MSG" | esc)
Logs: <code>journalctl -u restic-backup</code>" ;;
    warn) send "🟠 <b>restic backup warning</b> on ${HOST_LABEL} (snapshot ${SNAP:-none})
$(echo "$MSG" | esc)" ;;
    ok)   [ "$prev" != ok ] && send "✅ restic backup recovered on ${HOST_LABEL}: snapshot ${SNAP}, $(human "$ADDED") added" ;;
esac

case "$STATE" in ok) exit 0 ;; warn) exit 3 ;; *) exit 1 ;; esac
