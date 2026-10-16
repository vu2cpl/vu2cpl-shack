# DS710+ hardware under Debian + OMV

The NAS (Synology DS710+, `192.168.1.101`) runs Debian 13 + OpenMediaVault 8 since 2026-10-16
(HANDOVER #51). DSM used to drive the front panel. These files do it under Debian.
The rest-server units live in `../restic/nas-debian/`.

| File | Installed as | What it does |
|---|---|---|
| `ds710-microp` | `/usr/local/sbin/ds710-microp` | Sends commands to the front-panel microcontroller |
| `ds710-leds.service` | `/etc/systemd/system/` (enabled) | Boot: power LED on, status steady green, eSATA off. Shutdown: status off, power LED blinking |

## The microcontroller

Found by reading DSM's own driver (`synobios.ko`, built from `ds710+.c`) off DSM's untouched system
partition, mounted read-only:

- **Port:** the UART at I/O `0x3F8`, which is Debian's `/dev/ttyS0` (DSM numbers it `ttyS1`).
  9600 baud, 8N1, `CLOCAL` (DSM's termios flags `0x8bd`).
- **Framing:** every command is `-` + command. Bare bytes (the format other Synology models use)
  are ignored on this one.
- **Works (tested 2026-10-16):** `8` status green, `LE1`/`LE3` eSATA LED on/off, `3` long beep,
  `R` read the controller ID.
- **From DSM's tables, not all tested:** `4`/`5`/`6` power LED on/blink/off, `7` status off,
  `9` green blink, `:` orange, `;` orange blink, `LA2`/`LA3` alarm LED blink/off, `Vnn` fan duty %
  (DSM's DS710+ table: 20, 30, 40, 50, 65, 80, 99).
- **Doesn't work:** `2` short beep. The PC speaker isn't wired to the buzzer either.
- **Never send:** `1` (hard power-off) or `V00` (fan stopped). The helper refuses both.

```bash
sudo ds710-microp 8        # status green
sudo ds710-microp ';'      # status orange blinking
sudo ds710-microp LE3      # eSATA LED off
```

## Still not working

- **Disk 1 / Disk 2 LEDs:** not on the microcontroller. DSM drives them through GPIO pins on the
  IT8720F Super I/O (`SetDiskLedStatusBySataSuperIO`, `syno_superio_gpio_pin` in `synobios.ko`).
- **Power button and the second front button:** no bytes reach Linux and no ACPI events. A short
  press does nothing, and a long press is a hard power-off. Shut down from OMV or `sudo poweroff`.
- **Fan:** runs at whatever speed the controller holds. `-Vnn` should set it (untested).
