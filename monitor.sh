#!/bin/bash
# Broker: prefer an existing env var, then the shack env file, then localhost.
# /etc/default/vu2cpl-shack is written by rebuild_pi.sh Stage 9 (MQTT_BROKER=<ip>).
# Cron doesn't load systemd EnvironmentFile, so we source it ourselves.
if [ -z "$MQTT_BROKER" ] && [ -f /etc/default/vu2cpl-shack ]; then
    . /etc/default/vu2cpl-shack
fi
# Per-user override, for hosts where /etc/default is not writable without a
# sudo password. Holds MQTT_USER/MQTT_PASS (and optionally MQTT_BROKER);
# keep it chmod 600. Values here win over the /etc file.
if [ -f "$HOME/.config/vu2cpl-shack.env" ]; then
    . "$HOME/.config/vu2cpl-shack.env"
fi
BROKER="${MQTT_BROKER:-127.0.0.1}"
ID=$(hostname)

# MQTT auth (optional): set MQTT_USER / MQTT_PASS in /etc/default/vu2cpl-shack
# (the same file that carries MQTT_BROKER, sourced above). Empty MQTT_USER ⇒
# anonymous connect, backward-compatible until the broker sets
# allow_anonymous false. The shack account for these publishers is 'svc'.
AUTH=""
[ -n "$MQTT_USER" ] && AUTH="-u $MQTT_USER -P $MQTT_PASS"

CPU=$(top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d. -f1)
MEM=$(free | awk '/Mem:/ {printf "%.0f", $3/$2 * 100}')
TEMP=$(cat /sys/class/thermal/thermal_zone0/temp | awk '{printf "%.1f", $1/1000}')
DISK=$(df / | awk 'NR==2 {print $5}' | tr -d '%')

# Uptime: use uptime -p if available, fallback to /proc/uptime seconds
UPTIME=$(uptime -p 2>/dev/null | sed 's/up //')
if [ -z "$UPTIME" ]; then
    UPTIME=$(awk '{print int($1)}' /proc/uptime)
fi

# IP: get only the first IP, trimmed cleanly
IP=$(hostname -I | awk '{print $1}' | tr -d '[:space:]')

mosquitto_pub -h $BROKER $AUTH -t "rpi/$ID/cpu"    -m "$CPU"
mosquitto_pub -h $BROKER $AUTH -t "rpi/$ID/mem"    -m "$MEM"
mosquitto_pub -h $BROKER $AUTH -t "rpi/$ID/temp"   -m "$TEMP"
mosquitto_pub -h $BROKER $AUTH -t "rpi/$ID/disk"   -m "$DISK"
mosquitto_pub -h $BROKER $AUTH -t "rpi/$ID/uptime" -m "$UPTIME"
mosquitto_pub -h $BROKER $AUTH -t "rpi/$ID/ip"     -m "$IP"
mosquitto_pub -h $BROKER $AUTH -t "rpi/$ID/status" -m "online"
