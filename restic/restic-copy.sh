#!/usr/bin/env bash
# restic-copy — nightly copies of every shack restic repository, run from the Mac. Two targets, picked by the
# name the script is installed under:
#   restic-copy     second copy onto the UberSDR box's 1 TB HDD (sftp, daily 05:30)
#   restic-offsite  off-site copy on Google Drive (rclone remote gdrive-restic, daily 06:30, since 2026-10-21)
#
# The NAS (2010 DS710+, Debian 13 + OMV 8 since 2026-10-16) would otherwise hold the only copy. This copies new
# snapshots from each NAS repository (full-access endpoint :9901, user `maint`) to a repository of the same
# name on .109's /mnt/backups (sda) over sftp, or on Google Drive under shack-restic/<host>. Each copy uses the
# same password as its source and the same chunker parameters, so dedup works and no new secret lands on .109
# or at Google (restic encrypts before upload). The HDD copy protects against a NAS failure; the Drive copy
# against losing the house (#50 e).
#
# Per repository:
#   1. init the copy on first use (--copy-chunker-params from the source);
#   2. restic copy (only snapshots the copy doesn't have yet);
#   3. HDD: Sundays forget --prune with the same KEEP_* policy as restic-maint, then a metadata check.
#      Drive: Sundays a metadata check; the first Sunday of the month forget --prune (pruning on Drive means
#      download + re-upload, so monthly, --max-unused 10%) and check --read-data-subset=<month>/12, so all the
#      data is re-read once a year. rclone moves deleted files to Drive's Trash (30 days to undo).
# HDD refuses to run if /mnt/backups isn't mounted on .109 (fstab nofail), so it can't fill the NVMe; Drive
# refuses if the rclone remote doesn't answer (sign-in expired: rclone config reconnect gdrive-restic:).
# Drive uploads run at full speed (the daytime 6 MB/s cap was removed 2026-10-22, Manoj); nightly runs carry only
# a few GB. To slow a running upload, send SIGUSR2 to its `rclone serve restic` (toggles RCLONE_BWLIMIT if set).
# Reports retained MQTT on shack/backup/copy or shack/backup/offsite; Telegram only on failure and on the first
# good run after.
#
#   restic-copy                  normal run (launchd com.vu2cpl.restic-copy, daily 05:30)
#   restic-offsite               normal run (launchd com.vu2cpl.restic-offsite, daily 06:30)
#   restic-copy HOST -- ARGS     run restic ARGS against HOST's copy (e.g. ubersdr -- snapshots); same for
#                                restic-offsite
#
# Needs in ~/.config/vu2cpl-shack.env: RESTIC_REST_MAINT, RESTIC_PASSWORD_<HOST> per repo,
# TELEGRAM_TOKEN/TELEGRAM_CHAT_ID, MQTT_BROKER/MQTT_USER/MQTT_PASS (optional). Cert: ~/.config/restic/nas.crt.
# HDD: key login from the Mac to manoj@192.168.1.109. Drive: rclone + the remote gdrive-restic in
# ~/.config/rclone/rclone.conf (own OAuth client, project vu2cpl-rclone, scope drive.file).

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Not ~/Library/Caches (restic's macOS default): a cleaner (Mole) emptied it at 10:33 on 2026-10-22 and killed the
# first off-site seed mid-run.
export RESTIC_CACHE_DIR="$HOME/.cache/restic"

ENV_FILE="$HOME/.config/vu2cpl-shack.env"
HOSTS="ubersdr macmini-server"
NAS=192.168.1.101:9901
KEEP=(--keep-daily 7 --keep-weekly 5 --keep-monthly 12)

case "$(basename "$0")" in
    restic-offsite*)
        TARGET=gdrive
        STATE_DIR="$HOME/.local/state/restic-offsite"
        REMOTE=gdrive-restic:shack-restic
        DEST="$REMOTE"
        TOPIC=shack/backup/offsite
        LABEL="restic off-site copy to Google Drive"
        # 64 MiB packs: a quarter of the files on Drive. The rclone child reads its settings from the env
        # (restic's -o rclone.args can't carry quoted values, e.g. an RCLONE_BWLIMIT timetable). No bandwidth cap.
        EXTRA=(--pack-size 64)
        export RCLONE_DRIVE_CHUNK_SIZE=64M RCLONE_TPSLIMIT=10
        ;;
    *)
        TARGET=hdd
        STATE_DIR="$HOME/.local/state/restic-copy"
        DEST_SSH=manoj@192.168.1.109
        DEST_MNT=/mnt/backups
        DEST_DIR=$DEST_MNT/restic
        DEST="${DEST_SSH#*@}:$DEST_DIR"
        TOPIC=shack/backup/copy
        LABEL="restic copy to .109"
        EXTRA=()
        ;;
esac

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
    if [ "$TARGET" = gdrive ]; then
        export RESTIC_REPOSITORY="rclone:${REMOTE}/${h}"
    else
        export RESTIC_REPOSITORY="sftp:${DEST_SSH}:${DEST_DIR}/${h}"
    fi
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
    shift 2; exec restic ${EXTRA[@]+"${EXTRA[@]}"} "$@"
fi

# One run at a time per target (a first seed takes 8-15 h and would overlap the next run).
LOCK="$STATE_DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
    pid=$(cat "$LOCK/pid" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then log "already running (pid $pid), skipping"; exit 0; fi
    rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

SUNDAY=""; [ "$(date +%u)" = 7 ] && SUNDAY=1
PRUNE=""; CHECK_ARGS=()
if [ "$TARGET" = gdrive ]; then
    [ -n "$SUNDAY" ] && [ "$(date +%d)" -le 7 ] && { PRUNE=1; CHECK_ARGS=(--read-data-subset="$(( 10#$(date +%m) ))/12"); }
    PRUNE_ARGS=(--prune --max-unused 10%)
else
    PRUNE=$SUNDAY; PRUNE_ARGS=(--prune)
fi
FAILS=(); RESULTS=()

if [ "$TARGET" = gdrive ]; then
    precheck() { rclone lsd "$REMOTE" >/dev/null 2>&1 || rclone mkdir "$REMOTE" >/dev/null 2>&1; }
    PRECHECK_FAIL="Google Drive remote $REMOTE not reachable (sign-in expired? rclone config reconnect gdrive-restic:)"
else
    precheck() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$DEST_SSH" "mountpoint -q $DEST_MNT && test -w $DEST_DIR"; }
    PRECHECK_FAIL="$DEST_MNT not mounted or $DEST_DIR not writable on $DEST_SSH (or ssh failed)"
fi

if ! precheck; then
    FAILS+=("$PRECHECK_FAIL")
else
    for h in $HOSTS; do
        use_repo "$h" || { FAILS+=("$h: no repository password on the Mac"); continue; }
        if ! restic ${EXTRA[@]+"${EXTRA[@]}"} cat config >/dev/null 2>&1; then
            log "$h: initialising the copy at $RESTIC_REPOSITORY"
            if ! restic ${EXTRA[@]+"${EXTRA[@]}"} init --copy-chunker-params >"$STATE_DIR/$h.init.log" 2>&1; then
                FAILS+=("$h init: $(tail -2 "$STATE_DIR/$h.init.log" | tr '\n' ' ' | cut -c1-200)"); continue
            fi
        fi
        t0=$(date +%s)
        if ! restic ${EXTRA[@]+"${EXTRA[@]}"} copy >"$STATE_DIR/$h.copy.log" 2>&1; then
            FAILS+=("$h copy: $(tail -2 "$STATE_DIR/$h.copy.log" | tr '\n' ' ' | cut -c1-200)"); continue
        fi
        if [ -n "$PRUNE" ]; then
            if ! restic ${EXTRA[@]+"${EXTRA[@]}"} forget "${KEEP[@]}" "${PRUNE_ARGS[@]}" >"$STATE_DIR/$h.forget.log" 2>&1; then
                FAILS+=("$h forget/prune: $(tail -2 "$STATE_DIR/$h.forget.log" | tr '\n' ' ' | cut -c1-200)"); continue
            fi
        fi
        if [ -n "$SUNDAY" ]; then
            if ! restic ${EXTRA[@]+"${EXTRA[@]}"} check ${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"} >"$STATE_DIR/$h.check.log" 2>&1; then
                FAILS+=("$h check FAILED: $(tail -3 "$STATE_DIR/$h.check.log" | tr '\n' ' ' | cut -c1-200)"); continue
            fi
        fi
        latest=$(restic ${EXTRA[@]+"${EXTRA[@]}"} snapshots --latest 1 --json 2>/dev/null | python3 -c 'import sys,json; s=json.load(sys.stdin); print(s[-1]["short_id"] if s else "")' 2>/dev/null)
        RESULTS+=("\"$h\": {\"ok\": true, \"latest\": \"${latest}\", \"duration_s\": $(( $(date +%s) - t0 ))}")
        log "$h ok: copy done, latest ${latest:-?}${PRUNE:+, pruned}${SUNDAY:+, checked}"
    done
fi

STATE=ok; [ ${#FAILS[@]} -gt 0 ] && STATE=fail
MSG=$( [ "$STATE" = ok ] && echo ok || printf '%s; ' "${FAILS[@]}" )
JSON=$(printf '{"state": "%s", "time": %s, "dest": "%s", "repos": {%s}, "message": %s}' \
    "$STATE" "$(date +%s)" "$DEST" "$(IFS=,; echo "${RESULTS[*]:-}")" \
    "$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()[:500]))')")
echo "$JSON" > "$STATE_DIR/last.json"
user=$(envval MQTT_USER); pass=$(envval MQTT_PASS); broker=$(envval MQTT_BROKER)
if [ -n "$user" ] && [ -n "$pass" ] && command -v mosquitto_pub >/dev/null; then
    # Retried: twice (2026-10-20/21) the 05:30 publish failed with "Bad file descriptor" before reaching the
    # broker, just after the Mac woke, so shack-health saw a stale copy result.
    for try in 1 2 3; do
        err=$(mosquitto_pub -h "${broker:-192.168.1.169}" -u "$user" -P "$pass" -t "$TOPIC" -r -q 1 -m "$JSON" 2>&1) \
            && break
        log "MQTT publish failed (try $try): $err"
        [ "$try" -lt 3 ] && sleep 20
    done
fi
log "$STATE $MSG"

prev=$(cat "$STATE_DIR/state" 2>/dev/null || echo ok)
echo "$STATE" > "$STATE_DIR/state"
if [ "$STATE" = fail ]; then
    send "🔴 <b>$LABEL FAILED</b> (Mac)
$(echo "$MSG" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
Logs: ${STATE_DIR/#$HOME/~}/"
    exit 1
elif [ "$prev" != ok ]; then
    send "✅ $LABEL recovered (all repos copied)"
fi
exit 0
