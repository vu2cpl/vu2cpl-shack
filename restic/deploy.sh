#!/usr/bin/env bash
# Deploy the restic backup to a shack Linux box, from the Mac.
#
#   ./deploy.sh <host-config> <ssh-target>
#   ./deploy.sh ubersdr 192.168.1.109
#   ./deploy.sh macmini-server macmini-server.local
#
# Installs restic, rclone (+ mosquitto-clients) if missing, copies the script, units, excludes and
# hosts/<host-config>.conf to the box, sets the timer from ONCALENDAR, creates the repository
# password on first deploy, and initialises the repository if it does not exist yet.
# It does NOT start a backup; run `sudo systemctl start restic-backup` on the box for that.
#
# The box's root needs the SSH key /root/.ssh/restic_nas authorised on the Synology admin account,
# and the NAS host key in /root/.ssh/known_hosts — see README.md. Idempotent: re-run after any change in this directory.

set -euo pipefail
cd "$(dirname "$0")"

[ $# -eq 2 ] || { sed -n '4,6p' "$0"; exit 2; }
NAME=$1 TARGET=$2
[ -f "hosts/$NAME.conf" ] || { echo "no hosts/$NAME.conf"; exit 1; }

TMP=/tmp/restic-deploy.$$
ssh "$TARGET" "mkdir -p $TMP"
scp -q restic-backup.sh restic-backup.service restic-backup.timer exclude-common.txt rclone.conf \
    "hosts/$NAME.conf" "$TARGET:$TMP/"
if [ -f "hosts/$NAME.exclude" ]; then scp -q "hosts/$NAME.exclude" "$TARGET:$TMP/exclude-host.txt";
else ssh "$TARGET" ": > $TMP/exclude-host.txt"; fi

ssh "$TARGET" "sudo bash -s" <<EOF
set -euo pipefail
cd $TMP
for p in restic rclone mosquitto-clients; do
    dpkg -s \$p >/dev/null 2>&1 || NEED="\${NEED:-} \$p"
done
[ -n "\${NEED:-}" ] && DEBIAN_FRONTEND=noninteractive apt-get install -y -q \$NEED

install -d -m 700 /etc/restic
install -m 755 restic-backup.sh /usr/local/bin/restic-backup
install -m 644 $NAME.conf /etc/restic/backup.conf
install -m 644 exclude-common.txt exclude-host.txt /etc/restic/
install -m 600 rclone.conf /etc/restic/rclone.conf
install -m 644 restic-backup.service restic-backup.timer /etc/systemd/system/

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
    echo "repository exists"
else
    /usr/local/bin/restic-backup -- init
fi
systemctl list-timers restic-backup.timer --no-pager | head -2
rm -rf $TMP
EOF
echo "deployed $NAME to $TARGET"
