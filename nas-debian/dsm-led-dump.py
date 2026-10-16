# DS710+ register snapshot for the HDD 2 LED hunt (vu2cpl-shack nas-debian/, HANDOVER #53d).
# Python 2 (DSM 5.2) and 3 (Debian). Run as root:  python dsm-led-dump.py
# Reads only, except the Super I/O config-mode sequence every Super I/O access needs
# (key 87 01 55 55 to port 0x2E, index/LDN-select writes, exit = 02 to reg 02).
# Nothing is written to any GPIO, LED or the front-panel controller.
import os, struct, sys, time

fd = os.open("/dev/port", os.O_RDWR)
def inb(p):
    os.lseek(fd, p, 0); return bytearray(os.read(fd, 1))[0]
def inl(p):
    os.lseek(fd, p, 0); return struct.unpack("<I", os.read(fd, 4))[0]
def outb(p, v):
    os.lseek(fd, p, 0); os.write(fd, bytearray([v]))

print("== %s  %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), " ".join(os.uname())))
print("cmdline: " + open("/proc/cmdline").read().strip())
G = 0x480
names = {0: "USE_SEL", 4: "IO_SEL", 0xC: "GP_LVL", 0x18: "GPO_BLINK", 0x1C: "GP_SER_BLINK",
         0x2C: "GPI_INV", 0x30: "USE_SEL2", 0x34: "IO_SEL2", 0x38: "GP_LVL2"}
print("== ICH9 GPIO (base 0x480)")
for o in range(0, 0x50, 4):
    print("  %03x %-12s %08x" % (G + o, names.get(o, ""), inl(G + o)))
print("== ICH9 PMBASE 0x800")
for o in (0, 2, 4, 0x20, 0x24, 0x28, 0x2C, 0x30, 0x34):
    print("  %03x %08x" % (0x800 + o, inl(0x800 + o)))
for d in ("0000:00:1f.0", "0000:00:1f.2"):
    try:
        c = bytearray(open("/sys/bus/pci/devices/%s/config" % d, "rb").read())
        print("== PCI %s" % d)
        for i in range(0, len(c), 16):
            print("  %02x: %s" % (i, " ".join("%02x" % x for x in c[i:i + 16])))
    except IOError as e:
        print("== PCI %s: %s" % (d, e))

print("== IT8720F LDN7")
for b in (0x87, 0x01, 0x55, 0x55): outb(0x2E, b)
def sio(r):
    outb(0x2E, r); return inb(0x2F)
try:
    print("  chip %02x%02x rev %02x" % (sio(0x20), sio(0x21), sio(0x22)))
    outb(0x2E, 0x07); outb(0x2F, 0x07)
    regs = list(range(0x25, 0x2B)) + [0x2C, 0x30, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65] \
        + list(range(0xB0, 0xB5)) + list(range(0xB8, 0xBD)) + list(range(0xC0, 0xC5)) \
        + list(range(0xC8, 0xCD)) + list(range(0xF0, 0xF7))
    vals = dict((r, sio(r)) for r in regs)
    print("  " + " ".join("%02x=%02x" % (r, vals[r]) for r in regs))
finally:
    outb(0x2E, 0x02); outb(0x2F, 0x02)
base = vals[0x62] << 8 | vals[0x63]
if base:
    print("  simple I/O 0x%04x: %s" % (base, " ".join("%02x" % inb(base + i) for i in range(5))))

print("== scsi hosts / disks")
for h in sorted(os.listdir("/sys/class/scsi_host")):
    p = "/sys/class/scsi_host/" + h
    def r(f):
        try: return open(p + "/" + f).read().strip()
        except Exception: return "-"
    print("  %s %s lpm=%s em=%s" % (h, r("proc_name"), r("link_power_management_policy"), r("em_message")))
print("== end")
