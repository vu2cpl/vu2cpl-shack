#!/bin/sh
# DSM 5.2 boot hook: copy to /usr/local/etc/rc.d/ (as root, mode 755). DSM calls it with start/stop.
exec /volume1/homes/admin/rest-server/rest-server.sh "$1"
