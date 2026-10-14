#!/bin/sh
# restic rest-server on the Synology DS710+ (DSM 5.2, busybox sh) — start | stop | restart | status
#
# Two instances over the same repositories in /volume1/Backups/restic:
#   :9900  append-only + private repos  — the boxes' nightly backups. Each box's user can only reach
#          its own repo (/ubersdr, /macmini-server) and can add data but never delete or overwrite it,
#          so a compromised box cannot destroy its own backups.
#   :9901  full access, user `maint` only — forget/prune/check, run weekly from the Mac (restic-maint.sh).
# Both use TLS with a self-signed cert (clients pin it via RESTIC_CACERT).
# Ports: DSM 5.2's firewall is an allow-list (everything else is dropped), and changing it needs the DSM
# web UI. 9900/9901 are already allowed — they belong to Surveillance Station, which is not installed here.
# If Surveillance Station is ever installed, or those ports are removed from the firewall, move these.
#
# Lives in /volume1/homes/admin/rest-server/ (binary, cert, key, htpasswd files, logs, pids) and runs as
# `admin`, the owner of the repository files. At boot it is started by the root wrapper
# /usr/local/etc/rc.d/S99restic-rest-server.sh, which DSM runs with `start`; as root this script
# re-executes itself as admin.

DIR=/volume1/homes/admin/rest-server
DATA=/volume1/Backups/restic
BIN=$DIR/rest-server

if [ "$(id -u)" = 0 ]; then
    exec su -s /bin/sh -c "$DIR/rest-server.sh $1" admin
fi

running() { [ -f "$DIR/$1.pid" ] && kill -0 "$(cat "$DIR/$1.pid")" 2>/dev/null; }

start_one() {
    name=$1; shift
    if running "$name"; then echo "$name already running (pid $(cat "$DIR/$name.pid"))"; return 0; fi
    nohup "$BIN" --path "$DATA" --tls --tls-cert "$DIR/public.crt" --tls-key "$DIR/private.key" "$@" \
        >> "$DIR/$name.log" 2>&1 < /dev/null &
    echo $! > "$DIR/$name.pid"
    sleep 1
    if running "$name"; then echo "$name started (pid $(cat "$DIR/$name.pid"))"
    else echo "$name FAILED to start — see $DIR/$name.log"; return 1; fi
}

stop_one() {
    if running "$1"; then kill "$(cat "$DIR/$1.pid")"; echo "$1 stopped"; else echo "$1 not running"; fi
    rm -f "$DIR/$1.pid"
}

case "$1" in
    start)
        start_one backup --listen :9900 --append-only --private-repos --htpasswd-file "$DIR/users.htpasswd"
        start_one maint  --listen :9901 --htpasswd-file "$DIR/maint.htpasswd" ;;
    stop)    stop_one backup; stop_one maint ;;
    restart) "$0" stop; sleep 1; "$0" start ;;
    status)
        for n in backup maint; do
            if running $n; then echo "$n running (pid $(cat "$DIR/$n.pid"))"; else echo "$n NOT running"; fi
        done ;;
    *) echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
