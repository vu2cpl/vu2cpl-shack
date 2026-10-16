# DS710+ hardware under Debian + OMV

The NAS (Synology DS710+, `192.168.1.101`) runs Debian 13 + OpenMediaVault 8 since 2026-10-16
(HANDOVER #51). DSM used to drive the front panel. These files do it under Debian.
The rest-server units live in `../restic/nas-debian/`.

| File | Installed as | What it does |
|---|---|---|
| `ds710-microp` | `/usr/local/sbin/ds710-microp` | Sends commands to the front-panel microcontroller; `diskled` sets the bay LEDs |
| `ds710-btnwatch` | `/usr/local/sbin/ds710-btnwatch` | Read-only: prints anything that changes on the UARTs, chipset GPIOs, Super I/O GPIOs, ACPI status or input devices while you press buttons |
| `ds710-leds.service` | `/etc/systemd/system/` (enabled) | Boot: power LED on, status steady green, eSATA off, disk LEDs green. Shutdown: status off, power LED blinking |

## The microcontroller

Found by reading DSM's own driver (`synobios.ko`, built from `ds710+.c`) off DSM's untouched system
partition, mounted read-only:

- **Port:** the UART at I/O `0x3F8`, which is Debian's `/dev/ttyS0` (DSM numbers it `ttyS1`).
  9600 baud, 8N1, `CLOCAL` (DSM's termios flags `0x8bd`).
- **Framing:** every command is `-` + command. Bare bytes (the format other Synology models use)
  are ignored on this one.
- **Works (tested 2026-10-16):** `8` status green, `LE1`/`LE3` eSATA LED on/off, `3` long beep,
  `R` toggles the controller streaming its ID byte (`1`, about 12 a second); send it again to stop, as DSM does.
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

## Disk-bay LEDs

Not on the microcontroller. On the DS710+, DSM's `synobios.ko` drives them from chipset (ICH9R)
GPIOs, pin high = LED on. The AHCI enclosure-message path (`sata_syno_ahci_diskled_set`) is the
DS712+'s; synobios never selects it on this model.

| Bay | Green | Orange | Works under Debian |
|---|---|---|---|
| Disk 1 | GPIO16 | GPIO18 | yes, both colours (2026-10-16) |
| Disk 2 | GPIO20 | GPIO32 | **no**: those pins light nothing on this board, although bay 2 worked under DSM |

```bash
sudo ds710-microp diskled 1 green      # or orange / off; "all" for both bays
```

The helper only flips the level bit of a pin the BIOS already made a GPIO output. It refuses
anything else, and never reconfigures a pin. The GPIO base comes from `setpci -s 00:1f.0 48.l`
(`0x480`).

## Still not working

- **Disk 2 LED:** dark, although it worked under DSM (green, blinking with access). Bay 1's LED is
  GPIO16 gated by hardware disk activity: it blinks while its disk is read. Bay 2 stays dark with
  GPIO20 high (the boot preset sets it) even while its disk is read. Tried, each with no light on
  bay 2: GPIO20/32 in all four combinations, GPIO33/34, 49/55, the IT8720F's GP32/GP33 (BIOS-set
  outputs, DSM's "disk 5" pins), AHCI enclosure messages with and without GPIO20 high, and SATA link
  power `max_performance`. So a third signal gates bay 2. DSM's userland (`scemd`, packed) can set
  any whitelisted GPIO through synobios's raw GPIO ioctl, which may be how. What's left are pins
  that are inputs today; making one an output could cut disk power or short a USB over-current
  line, so nothing is guessed. Details in HANDOVER #53d.
- **Power button and the USB copy button:** nothing reaches Linux. During taps (2026-10-16, twice,
  `ds710-btnwatch`): no UART byte on ttyS0 or ttyS1 (the Synology protocol would send `0` /
  `` ` ``), no change on any of the 64 chipset GPIOs or the Super I/O GPIO sets, no ACPI PM1/GPE
  status, no input event, although Linux has an ACPI power-button device. Held presses (about 1-2 s)
  are still to be tried. A long press is a hard power-off. Shut down from OMV or `sudo poweroff`.
- **Fan:** runs at whatever speed the controller holds. `-Vnn` should set it (untested).
