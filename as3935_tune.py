#!/usr/bin/env python3
"""
AS3935 antenna tuning helper.

The AS3935 chip has a 500 kHz LC tank oscillator driven by its ferrite
antenna. To compensate for stray capacitance from your wiring/enclosure,
the chip provides 16 internal tuning capacitor steps (~8 pF each, 0..120 pF
total) at register 0x08 bits [3:0].

Standard procedure: set DISP_LCO=1 to expose the LCO on the IRQ pin
divided by LCO_FDIV (16/32/64/128), count edges over a fixed window,
multiply by the divider, look for the cap setting that lands closest
to 500 kHz.

Spec tolerance is ±3.5 % (482.5 .. 517.5 kHz). If no cap setting gets
you in spec, the antenna is wrong-sized or has bad connections.

USAGE — must run with as3935.service stopped (otherwise GPIO17 is busy):

    sudo systemctl stop as3935.service
    sudo python3 /home/vu2cpl/as3935_tune.py
    sudo systemctl start as3935.service

The script does NOT modify the running config persistently — it just
measures and recommends. Update TUN_CAP in as3935_mqtt.py with the
recommended value, redeploy.
"""
import time, smbus2, sys
from RPi import GPIO

I2C_BUS     = 1
AS3935_ADDR = 0x03
IRQ_PIN     = 17

REG_INT_LCO = 0x03   # bits [7:6] = LCO_FDIV
REG_TUN_CAP = 0x08   # bit 7 = DISP_LCO, bits [3:0] = TUN_CAP

# Divider 0=÷16, 1=÷32, 2=÷64, 3=÷128.
# ÷16 → ~31 kHz at IRQ — too fast for Python event callback to count reliably.
# ÷128 → ~3.9 kHz at IRQ — comfortable, still gives 0.25 % resolution per edge.
LCO_FDIV = 3
DIV = 16 << LCO_FDIV    # 16, 32, 64, 128

TARGET_HZ = 500_000
TOLERANCE_PCT = 3.5
SAMPLE_SECONDS = 2.0    # longer = more accurate, scales linearly

bus = smbus2.SMBus(I2C_BUS)

def read(reg):  return bus.read_byte_data(AS3935_ADDR, reg)
def write(reg, v): bus.write_byte_data(AS3935_ADDR, reg, v)

def set_lco_fdiv(div):
    v = (read(REG_INT_LCO) & 0x3F) | ((div & 0x03) << 6)
    write(REG_INT_LCO, v)

def set_tun_cap(cap):
    v = (read(REG_TUN_CAP) & 0xF0) | (cap & 0x0F)
    write(REG_TUN_CAP, v)

def disp_lco(on):
    v = read(REG_TUN_CAP)
    write(REG_TUN_CAP, (v | 0x80) if on else (v & 0x7F))

def measure(cap, seconds):
    set_tun_cap(cap)
    set_lco_fdiv(LCO_FDIV)
    disp_lco(True)
    time.sleep(0.05)        # settle the oscillator

    counter = [0]
    def cb(channel): counter[0] += 1

    GPIO.add_event_detect(IRQ_PIN, GPIO.RISING, callback=cb)
    counter[0] = 0
    time.sleep(seconds)
    edges = counter[0]
    GPIO.remove_event_detect(IRQ_PIN)
    disp_lco(False)

    freq = (edges * DIV) / seconds
    return freq, edges

def main():
    GPIO.setmode(GPIO.BCM)
    GPIO.setup(IRQ_PIN, GPIO.IN)

    # I²C self-test
    try:
        cfg0 = read(0x00)
        print(f"AS3935 CFG0 = 0x{cfg0:02X}  (chip responds)")
    except Exception as e:
        print(f"FATAL: cannot read AS3935 over I²C: {e}", file=sys.stderr)
        return 1

    print(f"Target: {TARGET_HZ:>7} Hz  (±{TOLERANCE_PCT}% = "
          f"{int(TARGET_HZ*(1-TOLERANCE_PCT/100))}..{int(TARGET_HZ*(1+TOLERANCE_PCT/100))})")
    print(f"LCO_FDIV: {LCO_FDIV}  (÷{DIV}) → expected IRQ rate ~{TARGET_HZ/DIV:.0f} Hz")
    print(f"Window:   {SAMPLE_SECONDS}s per cap value")
    print()
    print(f"{'CAP':>4} {'pF':>5} {'edges':>8} {'Hz':>10} {'err%':>8}")

    results = []
    for cap in range(16):
        freq, edges = measure(cap, SAMPLE_SECONDS)
        err = (freq - TARGET_HZ) / TARGET_HZ * 100
        results.append((cap, freq, err))
        print(f"{cap:>4} {cap*8:>5} {edges:>8} {freq:>10.0f} {err:>+7.2f}%")

    # Pick best
    best = min(results, key=lambda r: abs(r[1] - TARGET_HZ))
    cap, freq, err = best
    print()
    if abs(err) <= TOLERANCE_PCT:
        print(f"✓ Recommended TUN_CAP = {cap}  ({cap*8} pF)  "
              f"freq={freq:.0f} Hz  err={err:+.2f}%  (in spec)")
    else:
        print(f"⚠ Best is TUN_CAP = {cap}  ({cap*8} pF)  "
              f"freq={freq:.0f} Hz  err={err:+.2f}%  (OUT of ±{TOLERANCE_PCT}% spec)")
        print("  Likely causes:")
        print("    - antenna ferrite damaged / wrong inductance")
        print("    - long wires from antenna to chip adding stray capacitance")
        print("    - I²C / power coupling noise into the LC tank")

    print()
    print("To apply, edit /home/vu2cpl/as3935_mqtt.py:")
    print(f"  Add near other config:    TUN_CAP = {cap}")
    print(f"  In init (after antenna mode):")
    print(f"      v = read_reg(0x08) & 0xF0")
    print(f"      bus.write_byte_data(AS3935_ADDR, 0x08, v | {cap})")

    GPIO.cleanup()
    return 0

if __name__ == '__main__':
    sys.exit(main())
