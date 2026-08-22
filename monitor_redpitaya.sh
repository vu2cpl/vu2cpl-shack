#!/bin/sh
# monitor_redpitaya.sh — RPi Fleet Monitor telemetry from a Zynq/Alpine
# SDR appliance. Deployed unchanged on BOTH such boxes in this shack:
#   - Red Pitaya skimmer  rp-f02054.local (Zynq-7010, 2020-era Alpine)
#   - Web-888 receiver    192.168.1.235 / web-888 (Zynq, recent Alpine)
# The name is historical — the Red Pitaya was first.
#
# Same topics/cadence as monitor.sh (rpi/<hostname>/{cpu,temp,mem,disk,
# uptime,ip,status}, once a minute from cron) so the host auto-appears on
# the fleet tab — but every probe is rewritten for this platform:
#   - temp comes from the Zynq's on-chip XADC via IIO sysfs, not
#     /sys/class/thermal (which doesn't exist here)
#   - cpu% from a 1-second /proc/stat delta (BusyBox top prints a
#     different format than procps)
#   - mem% from /proc/meminfo MemAvailable (BusyBox free counts cache
#     as used)
#   - ip via `ip route get` (BusyBox hostname has no -I)
#   - uptime prettified from /proc/uptime (BusyBox uptime has no -p)
#
# Config: $HOME/.config/vu2cpl-shack.env (chmod 600) with
#   MQTT_BROKER=192.168.1.169
#   MQTT_USER=svc
#   MQTT_PASS=<from the shack password manager>
#
# Alpine-diskless gotcha: Pavel Demin images run from RAM — after
# installing (apk add mosquitto-clients, this script, the env file, the
# crontab), run `lbu commit -d` or it's all gone on reboot.

[ -f "$HOME/.config/vu2cpl-shack.env" ] && . "$HOME/.config/vu2cpl-shack.env"
BROKER="${MQTT_BROKER:-192.168.1.169}"
ID=$(hostname)
AUTH=""
[ -n "$MQTT_USER" ] && AUTH="-u $MQTT_USER -P $MQTT_PASS"

# CPU %: 1-second busy-time delta over /proc/stat
# fields: cpu user nice system idle iowait irq softirq steal
S1=$(head -1 /proc/stat)
sleep 1
S2=$(head -1 /proc/stat)
CPU=$(printf '%s\n%s\n' "$S1" "$S2" | awk '
    NR==1 { b1=$2+$3+$4+$7+$8+$9; i1=$5+$6 }
    NR==2 { db=$2+$3+$4+$7+$8+$9-b1; di=$5+$6-i1;
            if (db+di > 0) printf "%.0f", 100*db/(db+di); else print 0 }')

# Mem %: used = total - available
MEM=$(awk '/MemTotal:/ {t=$2} /MemAvailable:/ {a=$2}
           END {printf "%.0f", (t-a)/t*100}' /proc/meminfo)

# Temp: Zynq XADC — (raw + offset) * scale / 1000 °C
XADC=$(dirname "$(grep -l xadc /sys/bus/iio/devices/*/name)" 2>/dev/null)
if [ -n "$XADC" ]; then
    TEMP=$(awk -v r="$(cat "$XADC/in_temp0_raw")" \
               -v o="$(cat "$XADC/in_temp0_offset")" \
               -v s="$(cat "$XADC/in_temp0_scale")" \
               'BEGIN {printf "%.1f", (r+o)*s/1000}')
else
    TEMP=""
fi

DISK=$(df / | awk 'NR==2 {print $5}' | tr -d '%')

UPTIME=$(awk '{s=int($1); d=int(s/86400); h=int(s%86400/3600); m=int(s%3600/60);
               if (d) printf "%dd %dh %dm", d, h, m;
               else if (h) printf "%dh %dm", h, m;
               else printf "%dm", m}' /proc/uptime)

IP=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)

mosquitto_pub -h "$BROKER" $AUTH -t "rpi/$ID/cpu"    -m "$CPU"
mosquitto_pub -h "$BROKER" $AUTH -t "rpi/$ID/mem"    -m "$MEM"
[ -n "$TEMP" ] && \
mosquitto_pub -h "$BROKER" $AUTH -t "rpi/$ID/temp"   -m "$TEMP"
mosquitto_pub -h "$BROKER" $AUTH -t "rpi/$ID/disk"   -m "$DISK"
mosquitto_pub -h "$BROKER" $AUTH -t "rpi/$ID/uptime" -m "$UPTIME"
mosquitto_pub -h "$BROKER" $AUTH -t "rpi/$ID/ip"     -m "$IP"
mosquitto_pub -h "$BROKER" $AUTH -t "rpi/$ID/status" -m "online"
