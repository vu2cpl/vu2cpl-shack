#!/usr/bin/env python3
"""
AS3935 Lightning Sensor → MQTT publisher

Topics published:
  lightning/as3935          — events: lightning / disturber / noise (non-retained)
  lightning/as3935/hb       — heartbeat every HB_INTERVAL seconds (retained)
  lightning/as3935/status   — ready/offline state (retained, LWT for crash detection)

Run via systemd unit /etc/systemd/system/as3935.service
The unit must include:  Environment=PYTHONUNBUFFERED=1
otherwise print() output is block-buffered and never reaches journalctl.
"""

import time, json, sys, signal, smbus2, paho.mqtt.client as mqtt
from RPi import GPIO

# ── Config ──────────────────────────────────────────
MQTT_BROKER   = "192.168.1.169"
MQTT_PORT     = 1883
MQTT_TOPIC    = "lightning/as3935"
TOPIC_HB      = "lightning/as3935/hb"
TOPIC_STATUS  = "lightning/as3935/status"
HB_INTERVAL   = 30          # seconds
MQTT_KEEPALIVE = 60

I2C_BUS          = 1
AS3935_ADDR      = 0x03
IRQ_PIN          = 4           # BCM GPIO (physical pin 7) — verified by SRCO scan May 2026
NOISE_FLOOR      = 4           # 0..7, lower = more sensitive
ANTENNA_LOCATION = "indoor"    # "indoor" (AFE_GB=0x12) or "outdoor" (AFE_GB=0x0E)
TUN_CAP          = 10          # 0..15 (~8 pF/step). Tuned May 2026: 499.9 kHz, -0.02% err.
                               # Re-run as3935_tune.py if antenna is moved or rewired.

# AS3935 registers
REG_CFG0     = 0x00
REG_CFG1     = 0x01
REG_INT      = 0x03
REG_ENERGY_L = 0x04
REG_ENERGY_M = 0x05
REG_ENERGY_H = 0x06
REG_DISTANCE = 0x07

INT_LIGHTNING = 0x08
INT_DISTURBER = 0x04
INT_NOISE     = 0x01

# ── Counters ────────────────────────────────────────
counters = {"lightning": 0, "disturber": 0, "noise": 0, "irq": 0}
start_ts = time.time()

# ── I2C ─────────────────────────────────────────────
bus = smbus2.SMBus(I2C_BUS)

def read_reg(reg):
    return bus.read_byte_data(AS3935_ADDR, reg)

def get_distance():
    return read_reg(REG_DISTANCE) & 0x3F

def get_energy():
    lo = read_reg(REG_ENERGY_L)
    mi = read_reg(REG_ENERGY_M)
    hi = read_reg(REG_ENERGY_H) & 0x1F
    return (hi << 16) | (mi << 8) | lo

def set_noise_floor(level):
    val = read_reg(REG_CFG1)
    val = (val & 0x8F) | ((level & 0x07) << 4)
    bus.write_byte_data(AS3935_ADDR, REG_CFG1, val)

def set_antenna_mode(location):
    """
    AS3935 AFE_GB (analog front-end gain) lives in REG_CFG0 bits [5:1].
    Datasheet values:
        indoor   AFE_GB = 0x12  →  REG_CFG0 |= 0x24
        outdoor  AFE_GB = 0x0E  →  REG_CFG0 |= 0x1C
    Higher gain (indoor) compensates for wall/structure attenuation when the
    ferrite antenna is placed indoors. Use 'outdoor' only when the antenna
    is mounted outside, otherwise nearby RF will flood the chip with disturbers.
    """
    val = read_reg(REG_CFG0) & 0xC1                 # preserve reserved bits + PWD
    val |= 0x24 if location == "indoor" else 0x1C   # AFE_GB << 1
    bus.write_byte_data(AS3935_ADDR, REG_CFG0, val)
    print(f"[init] AFE_GB set for {location} antenna (CFG0=0x{val:02X})")

def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S")

# ── MQTT ────────────────────────────────────────────
def on_connect(c, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print(f"[mqtt] connected to {MQTT_BROKER}:{MQTT_PORT}")
        # Re-publish ready status on every (re)connect
        publish_status("ready")
    else:
        print(f"[mqtt] connect failed rc={reason_code}")

def on_disconnect(c, userdata, disconnect_flags, reason_code, properties):
    print(f"[mqtt] disconnected rc={reason_code} (paho will auto-reconnect)")

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="as3935-pi")
client.on_connect = on_connect
client.on_disconnect = on_disconnect

# Last Will: if the script dies, broker stamps offline (retained)
will_payload = json.dumps({"event": "offline", "ts": now_iso()})
client.will_set(TOPIC_STATUS, will_payload, qos=1, retain=True)

def mqtt_connect_with_retry():
    delay = 2
    while True:
        try:
            client.connect(MQTT_BROKER, MQTT_PORT, MQTT_KEEPALIVE)
            return
        except OSError as e:
            print(f"[mqtt] connect error: {e} — retrying in {delay}s")
            time.sleep(delay)
            delay = min(delay * 2, 60)

_calib_result = {"trco": None, "srco": None}

def publish_status(state, extra=None):
    p = {"event": state, "ts": now_iso(),
         "noise_floor": NOISE_FLOOR, "antenna": ANTENNA_LOCATION,
         "tun_cap": TUN_CAP, "irq_pin": IRQ_PIN,
         "calib_trco": _calib_result["trco"],
         "calib_srco": _calib_result["srco"]}
    if extra:
        p.update(extra)
    client.publish(TOPIC_STATUS, json.dumps(p), qos=1, retain=True)

def publish_hb():
    p = {
        "alive":     True,
        "ts":        now_iso(),
        "uptime_s":  int(time.time() - start_ts),
        "counters":  dict(counters),
    }
    client.publish(TOPIC_HB, json.dumps(p), qos=0, retain=True)

# ── IRQ Callback ────────────────────────────────────
def irq_handler(channel):
    counters["irq"] += 1
    try:
        time.sleep(0.003)  # datasheet: wait 2ms after IRQ
        int_val = read_reg(REG_INT) & 0x0F

        if int_val == INT_LIGHTNING:
            dist   = get_distance()
            energy = get_energy()
            counters["lightning"] += 1
            payload = {
                "event":     "lightning",
                "distance":  dist,
                "energy":    energy,
                "timestamp": now_iso(),
            }
            print(f"⚡ Lightning! {dist}km energy={energy}")
            client.publish(MQTT_TOPIC, json.dumps(payload))

        elif int_val == INT_DISTURBER:
            counters["disturber"] += 1
            payload = {"event": "disturber", "timestamp": now_iso()}
            print("⚠ Disturber")
            client.publish(MQTT_TOPIC, json.dumps(payload))

        elif int_val == INT_NOISE:
            counters["noise"] += 1
            payload = {"event": "noise", "timestamp": now_iso()}
            print("📡 Noise high")
            client.publish(MQTT_TOPIC, json.dumps(payload))
    except Exception as e:
        print(f"[irq] error: {e}")

# ── Shutdown ────────────────────────────────────────
def shutdown(signum, frame):
    print(f"[main] signal {signum} received, shutting down")
    try:
        publish_status("offline")
        client.loop_stop()
        client.disconnect()
    except Exception:
        pass
    try:
        GPIO.cleanup()
    except Exception:
        pass
    sys.exit(0)

signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT,  shutdown)

# ── Init ────────────────────────────────────────────
# I2C self-test — read CFG0 to confirm chip responds
try:
    cfg0 = read_reg(REG_CFG0)
    print(f"[init] AS3935 CFG0=0x{cfg0:02X} (i2c bus {I2C_BUS} addr 0x{AS3935_ADDR:02X})")
    if cfg0 == 0xFF or cfg0 == 0x00:
        print("[init] WARNING: CFG0 looks suspicious — chip may not be responding")
except Exception as e:
    print(f"[init] FATAL: cannot read AS3935 over I2C: {e}")
    sys.exit(1)

mqtt_connect_with_retry()
client.loop_start()

# GPIO IRQ
GPIO.setmode(GPIO.BCM)
GPIO.setup(IRQ_PIN, GPIO.IN)
GPIO.add_event_detect(IRQ_PIN, GPIO.RISING, callback=irq_handler)

# Sensor config
set_antenna_mode(ANTENNA_LOCATION)
set_noise_floor(NOISE_FLOOR)

# LC tank tuning — preserves DISP bits[7:5], rewrites TUN_CAP[3:0]
_v = read_reg(0x08) & 0xF0
bus.write_byte_data(AS3935_ADDR, 0x08, _v | (TUN_CAP & 0x0F))
print(f"[init] TUN_CAP set to {TUN_CAP} ({TUN_CAP * 8} pF)")

# Internal RC oscillator calibration. Datasheet: send CALIB_RCO (0x96 → 0x3D),
# wait ≥2ms, verify CALIB_DONE (bit 7) is set and CALIB_NOK (bit 6) is clear
# in both 0x3A (TRCO) and 0x3B (SRCO).
bus.write_byte_data(AS3935_ADDR, 0x3D, 0x96)
time.sleep(0.005)
_trco = read_reg(0x3A)
_srco = read_reg(0x3B)
_trco_ok = bool(_trco & 0x80) and not bool(_trco & 0x40)
_srco_ok = bool(_srco & 0x80) and not bool(_srco & 0x40)
_calib_result["trco"] = "OK" if _trco_ok else "FAIL"
_calib_result["srco"] = "OK" if _srco_ok else "FAIL"
print(f"[init] CALIB_RCO  TRCO={_calib_result['trco']} (0x{_trco:02X})  "
      f"SRCO={_calib_result['srco']} (0x{_srco:02X})")
if not (_trco_ok and _srco_ok):
    print("[init] WARNING: RC oscillator calibration failed — chip timing may be off")

# Clear any pending interrupt left from the configuration writes (some writes
# can transiently spike the IRQ line; reading 0x03 acknowledges it).
_int_clear = read_reg(REG_INT) & 0x0F
print(f"[init] Cleared pending INT: 0x{_int_clear:X}")

# Re-publish status now that calibration result is populated. The on_connect
# callback fired earlier with calib_* still None — overwrite the retained
# message so MQTT Explorer shows the actual result.
publish_status("ready")

print(f"AS3935 ready — interrupt mode on GPIO{IRQ_PIN}, noise_floor={NOISE_FLOOR}, "
      f"antenna={ANTENNA_LOCATION}, tun_cap={TUN_CAP}")

# ── Main loop: heartbeat ────────────────────────────
last_hb = 0
try:
    while True:
        now = time.time()
        if now - last_hb >= HB_INTERVAL:
            publish_hb()
            last_hb = now
        time.sleep(1)
except KeyboardInterrupt:
    shutdown(signal.SIGINT, None)
finally:
    try:
        publish_status("offline")
    except Exception:
        pass
    client.loop_stop()
    client.disconnect()
    GPIO.cleanup()
