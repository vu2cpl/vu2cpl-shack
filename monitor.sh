#!/bin/bash
BROKER=192.168.1.169
ID=$(hostname)

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

mosquitto_pub -h $BROKER -t "rpi/$ID/cpu"    -m "$CPU"
mosquitto_pub -h $BROKER -t "rpi/$ID/mem"    -m "$MEM"
mosquitto_pub -h $BROKER -t "rpi/$ID/temp"   -m "$TEMP"
mosquitto_pub -h $BROKER -t "rpi/$ID/disk"   -m "$DISK"
mosquitto_pub -h $BROKER -t "rpi/$ID/uptime" -m "$UPTIME"
mosquitto_pub -h $BROKER -t "rpi/$ID/ip"     -m "$IP"
mosquitto_pub -h $BROKER -t "rpi/$ID/status" -m "online"
