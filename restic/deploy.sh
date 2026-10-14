#!/usr/bin/env bash
# Deploy the restic backup to a shack Linux box, from the Mac.
#
#   ./deploy.sh <host-config> <ssh-target>
#   ./deploy.sh ubersdr 192.168.1.109
#   ./deploy.sh macmini-server macmini-server.local
#
# Installs restic (+ mosquitto-clients) if missing, copies the script, units, excludes, the NAS
# rest-server cert and hosts/<host-config>.conf to the box, writes /etc/restic/repository (the box's
# append-only rest-server URL, login from RESTIC_REST_<HOST> in ~/.config/vu2cpl-shack.env), sets the
# timer from ONCALENDAR, creates the repository password on first deploy, and initialises the
# repository if it does not exist yet.
# It does NOT start a backup; run `sudo systemctl start restic-backup` on the box for that.
# Idempotent: re-run after any change in this directory.

set -euo pipefail
cd "$(dirname "$0")"

[ $# -eq 2 ] || { sed -n '4,6p' "$0"; exit 2; }
NAME=$1 TARGET=$2
[ -f "hosts/$NAME.conf" ] || { echo "no hosts/$NAME.conf"; exit 1; }

ENV_FILE=~/.config/vu2cpl-shack.env
VAR="RESTIC_REST_$(echo "$NAME" | tr 'a-z-' 'A-Z_')"
REST_PW=$(sed -n "s/^$VAR=//p" "$ENV_FILE" | tail -1)
[ -n "$REST_PW" ] || { echo "no $VAR in $ENV_FILE (rest-server login for $NAME)"; exit 1; }
REPO_URL="rest:https://$NAME:$REST_PW@192.168.1.101:9900/$NAME/"

TMP=/tmp/restic-deploy.$$
ssh "$TARGET" "mkdir -p $TMP"
scp -q restic-backup.sh restic-backup.service restic-backup.timer exclude-common.txt nas/public.crt \
    "hosts/$NAME.conf" "$TARGET:$TMP/"
if [ -f "hosts/$NAME.exclude" ]; then scp -q "hosts/$NAME.exclude" "$TARGET:$TMP/exclude-host.txt";
else ssh "$TARGET" ": > $TMP/exclude-host.txt"; fi

ssh "$TARGET" "sudo bash -s" <<EOF
set -euo pipefail
cd $TMP
NEED=""
for p in restic mosquitto-clients; do
    dpkg -s \$p >/dev/null 2>&1 || NEED="\$NEED \$p"
done
if [ -n "\$NEED" ]; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q \$NEED; fi

install -d -m 700 /etc/restic
install -m 755 restic-backup.sh /usr/local/bin/restic-backup
install -m 644 $NAME.conf /etc/restic/backup.conf
install -m 644 exclude-common.txt exclude-host.txt /etc/restic/
install -m 644 public.crt /etc/restic/nas.crt
install -m 644 restic-backup.service restic-backup.timer /etc/systemd/system/
( umask 077; printf '%s\n' '$REPO_URL' > /etc/restic/repository )

if [ ! -s /etc/restic/password ]; then
    ( umask 077; head -c 33 /dev/urandom | base64 > /etc/restic/password )
    echo "NEW repository password created in /etc/restic/password — copy it off the box now"
fi

cal=\$(. /etc/restic/backup.conf; echo "\${ONCALENDAR:-}")
mkdir -p /etc/systemd/system/restic-backup.timer.d
if [ -n "\$cal" ]; then
    printf '[Timer]\nOnCalendar=\nOnCalendar=%s\n' "\$cal" > /etc/systemd/system/restic-backup.timer.d/schedule.conf
fi
systemctl daemon-reload
systemctl enable --now restic-backup.timer

if /usr/local/bin/restic-backup -- cat config >/dev/null 2>&1; then
    echo "repository reachable"
else
    /usr/local/bin/restic-backup -- init
fi
systemctl list-timers restic-backup.timer --no-pager | head -2
rm -rf $TMP
EOF
echo "deployed $NAME to $TARGET"
