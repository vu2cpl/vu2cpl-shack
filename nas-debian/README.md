# DS710+ hardware under Debian + OMV

The NAS (Synology DS710+, `192.168.1.101`) runs Debian 13 + OpenMediaVault 8 since 2026-10-16
(HANDOVER #51). DSM used to drive the front panel. These files do it under Debian.
The rest-server units live in `../restic/nas-debian/`.

| File | Installed as | What it does |
|---|---|---|
| `ds710-microp` | `/usr/local/sbin/ds710-microp` | Sends commands to the front-panel microcontroller; `diskled` sets the bay LEDs; `raid` sets status + bay LEDs from md2's state (run at boot and by shack-health's `nas-md-alert` on every RAID event) |
| `dsm-led-dump.py` | run by hand, Python 2/3 | Read-only register snapshot (ICH9 GPIO, PMBASE, PCI config, IT8720F LDN7), same output under DSM and Debian for diffing |
| `ds710-btnwatch` | `/usr/local/sbin/ds710-btnwatch` | Read-only: prints anything that changes on the UARTs, chipset GPIOs, Super I/O GPIOs, ACPI status or input devices while you press buttons |
| `ds710-buttons` + `ds710-buttons.service` | `/usr/local/sbin/`, `/etc/systemd/system/` (enabled) | Power held ~3 s → long beep + clean power-off. USB copy held ~1 s → logged |
| `ds710-shutdown-hook` | `/usr/lib/systemd/system-shutdown/ds710` | At the very end of shutdown tells the controller `1` (power-off) or `C` (restart), as DSM's kernel does |
| `ds710-fan` + `ds710-fan.service` | `/usr/local/sbin/`, `/etc/systemd/system/` (enabled) | Fan duty from disk + CPU temperature: 30 % floor, DSM's steps up to 99 %, 2 °C hysteresis, 65 % if a reading fails |
| `ds710-leds.service` | `/etc/systemd/system/` (enabled) | Boot: power LED on, eSATA off, then `raid`: status + disk LEDs green, or orange if md2 came up degraded. Shutdown: status off, power LED blinking |

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
  `9` green blink, `:` orange, `;` orange blink, `LA2`/`LA3` alarm LED blink/off, `Vnn` fan duty % (tested 2026-10-17)
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
sudo ds710-microp raid                 # LEDs from md2's live state (see below)
sudo ds710-microp raid --show-degraded 20   # visual test: degraded look for 20 s, then the real state
```

**RAID state on the front panel (2026-10-17, #53d).** `raid` reads `/proc/mdstat` and
`/sys/block/md2/md/dev-*/state`. md2 clean with both members `in_sync` → status steady green and both
bays green. Degraded, not assembled, rebuilding, or a member faulty/missing → status **blinking orange**
and each bay whose disk isn't an in-sync member **orange** (bay 1 = libata `ata3`, bay 2 = `ata4`, so it
follows the slot, not the drive). Bay 2's LED is weak (above), so on that bay only the status LED is
reliable. `ds710-leds.service` runs it at boot and shack-health's `nas-md-alert` (mdadm's PROGRAM) on every
RAID event, including the daily degraded reminder.

The helper only flips the level bit of a pin the BIOS already made a GPIO output. It refuses
anything else, and never reconfigures a pin. The GPIO base comes from `setpci -s 00:1f.0 48.l`
(`0x480`).

## Still not working

- **Disk 2 LED: same as under DSM, nothing more to do in software.** Booting DSM once (2026-10-16)
  showed HDD 2 dark at idle under DSM too, with DSM driving GPIO20 high and every chipset/Super I/O
  register identical to Debian's (`dsm-led-dump.py`). Under DSM it only flickers faintly green on
  disk access. The LED itself tests fine with a meter, so bay 2's steady-green drive on the board is
  weak. `ds710-microp diskled 2 …` drives exactly DSM's pins (GPIO20 green / GPIO32 orange).
- ~~**Power button and the USB copy button**~~ **work since 2026-10-16.** The controller reports a
  button on ttyS0 only once it's **held**: `0` after ~3 s on power (it also starts blinking the power
  LED), `` ` `` after ~1 s on USB copy. Taps send nothing, and nothing reaches GPIO, ACPI or input
  devices. `ds710-buttons` turns a power hold into a long beep + `systemctl poweroff`. Holding 4 s
  or more is still the hardware hard-off. Copy is only logged (`journalctl -u ds710-buttons`).
  **Power-off needs the shutdown hook:** without telling the controller `1`, it switched the box
  straight back on after a button power-off, and that quick power cycle left the boot stick
  unreadable to GRUB ("failure reading sector 0x802 from hd0", fixed by a cold start). With the
  hook: reboot and button power-off both tested clean (stays off).
- **Fan (2026-10-17):** `-Vnn` works: 30 → 65 → 99 each audibly faster (checked by ear by Manoj), and 30 sounds
  the same as the speed the controller held before, so 30 % is the floor. Nothing on this board reports fan RPM
  (no it87/IT8720F fan inputs under Debian; the controller has no read-back). `ds710-fan.service` sets the duty
  every minute from the hottest data disk (`smartctl -n standby`, every 5 min, never wakes a sleeping disk) and
  the hottest CPU core: 40 % at disk 38 / CPU 58 °C, 50 % at 41 / 63, 65 % at 44 / 68, 80 % at 47 / 72, 99 % at
  50 / 76; down only once 2 °C clear; 65 % if a temperature can't be read. Changes go to the journal
  (`journalctl -t ds710-fan`); `ds710-fan --once` prints readings and the duty without touching anything.
  At normal temps (disks 31-35, CPU 41-49 °C) it stays at 30 %.

## Re-cloning the spare boot stick

The spare is the SanDisk **Cruzer Fit** (serial …6472, kept in the drawer with the Synology module).
It holds the original 2026-10-16 13:02 install: `sdX1` root plus an unused swap partition `sdX5`.
Its root filesystem has the **same UUID** as the Ultra Fit's (`c6160f5b…`), so it can boot in its
place, and the two must never be in at boot together. Re-clone it after any real change to the
system. Last re-cloned 2026-10-16 22:11 (all of `nas-debian/`, `RESUME=none`).

Live, with no downtime, on the running NAS (plug the Cruzer in *after* boot):

```bash
lsblk -dno NAME,MODEL                       # find the Cruzer, e.g. sdd; use the device path, never the UUID
sudo mkdir -p /mnt/rootsrc /mnt/spare
sudo mount --bind / /mnt/rootsrc
sudo mount --make-private /mnt/rootsrc      # MUST come before mounting the spare (see below)
sudo mount -o remount,bind,ro /mnt/rootsrc
sudo mount /dev/sdd1 /mnt/spare
sudo systemd-run --unit=spare-clone rsync -aHAXS --numeric-ids --delete --delete-excluded \
    "--exclude=/mnt/*" /mnt/rootsrc/ /mnt/spare/          # ~2.5 min; survives the ssh session
sudo grub-install --target=i386-pc --boot-directory=/mnt/spare/boot /dev/sdd
sync; sudo umount /mnt/spare /mnt/rootsrc; sudo rmdir /mnt/spare /mnt/rootsrc
```

Then pull the Cruzer.

- **Why the bind mount:** it shows the root filesystem as it is on the stick, without OMV's
  writecache overlays (`/var/log`, apt, rrd, monit) on top.
- **Why `--make-private`:** `/` is a *shared* mount under systemd. Without it, mounting the spare
  also appears inside the bind (`/mnt/rootsrc/mnt/spare`), and rsync copies the spare into itself.
  That happened on 2026-10-16: 8.9 GB of junk before it was stopped.
- **Why `systemd-run`:** a backgrounded `nohup` rsync was still killed by SIGHUP when the ssh session
  closed.
- While the Cruzer is plugged in, `/dev/disk/by-uuid/c6160f5b…` points at whichever stick appeared
  last. The running system is unaffected, but don't reboot until it's out.
