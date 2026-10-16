# restic backups to the Synology

This directory holds the nightly, encrypted, deduplicated backups of the shack's Linux boxes. They go
to a restic **rest-server** on the Synology NAS. The servers can only *add* to their backups.
Deleting old snapshots happens in a weekly maintenance job on the Mac.

Set up 2026-10-14 to replace UrBackup, which was uninstalled the same day.

| Box | Repository on the NAS | Nightly (IST) | What is in it |
|---|---|---|---|
| ubersdr (192.168.1.109) | `/volume1/Backups/restic/ubersdr` | 01:30 | whole root + `/boot/efi`; Wavelog DB dump |
| macmini-server | `/volume1/Backups/restic/macmini-server` | 03:00 | whole root, `/boot`, `/boot/efi`, Immich library (`/mnt/immich`); ALPA-replica DB dump |
| Mac (maintenance only) | — | Sun 10:30 | `forget --prune` + a rotating `check` of every repository |
| Mac → ubersdr HDD (second copy) | `/mnt/backups/restic/<host>` on `.109`'s 1 TB disk | 05:30 | `restic copy` of both repositories; Sundays also prune + check |

The Macs (Mac Mini and MacBook) are deliberately not in restic: they use Time Machine (Manoj, 2026-10-14).

## How it fits together

```
 ubersdr ─┐  HTTPS :9900  append-only, private repos       ┌─ /volume1/Backups/restic/ubersdr
          ├────────────────────────────────▶  rest-server ─┤
 macmini ─┘  (each login reaches only its own repo)        └─ /volume1/Backups/restic/macmini-server
                                                ▲
 Mac ───────── HTTPS :9901  full access, user `maint` ──────┘   forget / prune / check, weekly
  │
  └── sftp manoj@192.168.1.109 ──▶ /mnt/backups/restic/<host>   restic copy, daily 05:30 (second copy)
```

- **Append-only (:9900).** Each server logs in as its own user (`ubersdr`, `macmini-server`) and
  can only reach its own repository. It can add data and snapshots but can't delete or overwrite
  anything except its own stale lock files. A compromised or ransomware-hit server therefore can't
  destroy its backups.
- **Full access (:9901).** Only the `maint` login can use it. That credential lives only on the Mac.
- **No SSH key for the servers.** Their SSH keys were taken off the NAS when this went in.
  macmini-server's other NAS key (`alpaindia-backup`, used by the old ALPA and music pushes, which were
  retired on 2026-10-14) is now forced to `command="cat /volume1/Backups/mac-projects.status"`, so it
  can't run anything else on the NAS.
- **TLS** uses a self-signed cert (`nas/public.crt`, valid to 2036, SAN `IP:192.168.1.101`). Clients
  pin it with `RESTIC_CACERT`. TLS stays on, even though restic already encrypts the data, so the
  logins (above all `maint`) never cross the network in clear text.

### Speed (2 GB test, 2026-10-14, NAS otherwise idle)

| Transport | Throughput |
|---|---|
| restic native `sftp:` | doesn't work: DSM 5.2's SFTP fails restic's chmod (`Chmod …: file does not exist`), even on `init` |
| rclone `sftp` backend (first setup) | 12 MB/s |
| rest-server, TLS (**in use**) | 21 MB/s |
| rest-server, plain HTTP | 29 MB/s |

The NAS is a DS710+, with an Atom D410 that has no AES-NI. Its CPU is the limit. SSH used AES-GCM
in software, which is why SFTP was so slow.

## The NAS side (`nas-debian/`, since 2026-10-16)

The DS710+ runs **Debian 13 + OpenMediaVault 8** since 2026-10-16 (DSM 5.2 before; see "Before
2026-10-16" below). The repositories, logins, cert and ports did not change, so no client changed.

- **Volume:** the DSM data array `md2` + LVM `vg1000/lv` (ext4) is mounted by OMV at
  `/srv/dev-disk-by-uuid-179587aa-f31b-4d5c-94be-de3ba4582f55` and **bind-mounted at `/volume1`**
  (an `/etc/fstab` line outside OMV's block), so every DSM-era path still holds.
- **User:** `nasadmin`, uid 1024 / gid 100 (`users`) = DSM's `admin`, so the repository files kept their
  owner. OMV reserves the name `admin` for its web UI.
- **Binary:** the same rest-server v0.14.0, copied to `/usr/local/bin/rest-server`.
- **Config:** unchanged in `/volume1/homes/admin/rest-server/` (`public.crt`, `private.key`,
  `users.htpasswd`, `maint.htpasswd`). The DSM-era `rest-server.sh`, logs and pid files there are unused.
- **Control:** two systemd units from `nas-debian/`, `rest-server-backup.service` (`:9900`,
  append-only, private repos) and `rest-server-maint.service` (`:9901`, full access, `maint`).
  Both run as `nasadmin`, `RequiresMountsFor=/volume1`, write access only to `/volume1/Backups/restic`,
  logs in the journal (`journalctl -u rest-server-backup`). Install or update:

  ```bash
  scp restic/nas-debian/rest-server-*.service vu2cpl@192.168.1.101:/tmp/
  ssh vu2cpl@192.168.1.101 'sudo install -m 644 /tmp/rest-server-*.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart rest-server-backup rest-server-maint'
  ```

- **Ports 9900/9901:** no firewall on the Debian side (DSM's allow-list is gone); the NAS stays a
  LAN-only backup site.
- **Proven 2026-10-16:** after two reboots both endpoints came back on their own, and .109 and
  macmini-server listed their snapshots over `:9900`, the Mac over `:9901`.
- **Logins.** The htpasswd files are bcrypt. Their plain passwords are on the Mac in
  `~/.config/vu2cpl-shack.env` as `RESTIC_REST_UBERSDR`, `RESTIC_REST_MACMINI_SERVER` and
  `RESTIC_REST_MAINT`. To add a box: `htpasswd -B` a new user into `users.htpasswd`, then
  `sudo systemctl restart rest-server-backup`.

### Before 2026-10-16: DSM 5.2 (`nas/`, kept for the way back)

Plugging the Synology boot module back in boots DSM again on the same disks, and then `nas/` applies.
DSM 5.2 gave `admin` no root, no `sudo` and no user crontab, so rest-server ran as `admin` from
`/volume1/homes/admin/rest-server/` via `rest-server.sh start|stop|restart|status`, started at boot
by a root hook `/usr/local/etc/rc.d/S99restic-rest-server.sh` that Manoj installed on 2026-10-14
(proven by a NAS reboot on 2026-10-15). Ports 9900/9901 were chosen because DSM's allow-list
firewall already allowed them (Surveillance Station's, not installed). The binary was SHA256-checked
and GPG-verified against restic's release key `CF8F18F2844575973F79D4E191A6868BD3F7A907`.

## What a nightly run does (`restic-backup.sh`)

1. **Database dumps.** It dumps each MariaDB container in `DB_DUMPS` to `/var/backups/restic-dumps/`,
   using the container's own `MARIADB_*` env. Live data directories are excluded.
   On macmini-server, Immich writes its own DB dump to `/mnt/immich/backups` at 07:30 IST (02:00 UTC),
   so the 03:00 run carries a dump from about 19.5 h earlier. The script warns if the newest is more
   than 26 h old.
2. **Backup.** `restic backup` of `BACKUP_PATHS` with `--one-file-system`, using `exclude-common.txt`
   plus `hosts/<host>.exclude`.
   - Excluded: Docker image layers, caches, snaps, Immich thumbnails and transcodes, Plex metadata,
     LM Studio models.
   - Kept: Docker volumes, `/etc`, `/home`, `/usr/local`, `/opt` and similar.
3. **Report.**
   - Retained MQTT JSON on `shack/backup/<host>`: `state`, `time`, `snapshot`, `data_added`,
     `duration_s`, `message`. It uses the `svc` account from `~manoj/.config/vu2cpl-shack.env`.
   - Telegram: 🔴 when a run fails, 🟠 for a warning, ✅ on the first good run afterwards.
   - The daily shack-health report (07:15) grades the retained topics: a missed night is WARN, two missed
     nights or a failed run is FAIL, and a missed weekly maintenance run is WARN.

The unit runs at Nice 19, idle IO, CPUWeight 10 and `GOMAXPROCS=2`, so radiod and UberSDR aren't
starved.

## Weekly maintenance on the Mac (`restic-maint.sh`)

The launchd agent `com.vu2cpl.restic-maint` runs every Sunday at 10:30. For each repository it:
- runs `forget --prune`, keeping 7 daily, 5 weekly and 12 monthly snapshots;
- runs `check --read-data-subset=N/20`, with N rotating by ISO week so all the data is re-read
  every 20 weeks.

It publishes retained MQTT on `shack/backup/maint` and sends Telegram only on failure or recovery.
Its log is `~/Library/Logs/restic-maint.log`. `install-maint.sh` installs it: macOS via brew and
launchd, Pi or Linux via apt and crontab.

```bash
~/.local/bin/restic-maint --dry-run
```

```bash
~/.local/bin/restic-maint ubersdr -- snapshots
```

The second form is a full-access restic shell for one repository. Use it for anything the
append-only side can't do, such as deleting a snapshot by hand.

## Second copy on the ubersdr box (`restic-copy.sh`)

The NAS (a DS710+ on DSM 5.2, unpatched since about 2017) would otherwise hold the only copy. Since
2026-10-15 the Mac copies every repository each morning to `.109`'s 1 TB Seagate (`sda`, `/mnt/backups`):

- launchd `com.vu2cpl.restic-copy`, daily 05:30, under `caffeinate -i`. Log `~/Library/Logs/restic-copy.log`,
  per-repo logs in `~/.local/state/restic-copy/`.
- Source is the NAS `:9901` (`maint`), destination `sftp:manoj@192.168.1.109:/mnt/backups/restic/<host>`.
  Each copy has the **same password as its source** and was initialised with `--copy-chunker-params`, so
  dedup works and no new secret lives on `.109`.
- `restic copy` only adds snapshots the copy doesn't have. On Sundays it also runs `forget --prune` with the
  same 7/5/12 policy and a metadata `check`.
- It refuses to run when `/mnt/backups` isn't mounted (fstab `nofail`), so it can't fill the NVMe. A lock
  stops overlapping runs.
- Retained MQTT `shack/backup/copy`, graded by shack-health. Telegram only on failure or recovery.
- What it protects against: a dead NAS or a broken NAS repository. What it doesn't: losing the house,
  or a compromised `.109` (manoj can write that disk). Off-site (#50 e): the ALPA hosting server, once
  ALPA's files are off it (Manoj, 2026-10-15; expected in a month or two).
- The NAS itself stays a local-only backup site for as long as it works reliably, deliberately not used
  over the internet (Manoj, 2026-10-15).

```bash
~/.local/bin/restic-copy ubersdr -- snapshots
```

The first seed (about 620 GB) started 2026-10-15 20:44 at 45-60 MB/s. `ubersdr` finished at 20:52 (29 GB);
`macmini-server` was still running at 22:00, expected to finish about 23:00.

**Snapshot IDs differ in the copy.** `restic copy` writes new snapshot IDs and records the source ID in the
snapshot's `original` field (`snapshots --json`). Example: copy `4e46ed76` = NAS `b62c8459`. So the copy's
"latest" in `shack/backup/copy` never matches the NAS ID; compare times, or `original`.

## Secrets

| Secret | Where | Can do |
|---|---|---|
| Repository password, one per repo | `/etc/restic/password` on the box; Mac env `RESTIC_PASSWORD_<HOST>`; password manager | decrypt the backup. **Without it the data is unrecoverable.** |
| Server login | `/etc/restic/repository` on the box; Mac env `RESTIC_REST_<HOST>` | append to its own repo |
| `maint` login | Mac env `RESTIC_REST_MAINT` only | delete or prune anything |

None of these values go in git; this repo is public. The cert is public, so it's committed.

## Deploying and day-to-day use

From the Mac:

```bash
./deploy.sh ubersdr 192.168.1.109
```

```bash
./deploy.sh macmini-server macmini-server.local
```

`deploy.sh` is idempotent. It installs restic and mosquitto-clients, copies the files and the NAS
cert, and writes `/etc/restic/repository` from the Mac's `RESTIC_REST_<HOST>`. It sets the timer
from `ONCALENDAR`, creates the repository password on the first deploy, and initialises the
repository if it's missing. It never starts a backup.

On a box:

```bash
sudo systemctl start restic-backup
```

```bash
sudo restic-backup --status
```

```bash
sudo restic-backup -- snapshots
```

```bash
journalctl -u restic-backup -n 30
```

`--status` prints the last run's JSON and the latest snapshots. Anything after `--` runs restic
against this box's repository; from a box that access is append-only. `restic-backup --test` sends a
test Telegram message.

## Restoring

**Last tested 2026-10-15:** on-box restores on both boxes, and a Mac restore of 25 random Immich
originals, all matched live by sha256 (SHACK_CHANGELOG 2026-10-15). Restore to a scratch target, never in place.

From the box itself (append-only access is enough to read):

```bash
sudo restic-backup -- restore latest --target /tmp/restore --include /home/manoj/openwebrx
```

```bash
sudo mkdir -p /mnt/restic && sudo restic-backup -- mount /mnt/restic
```

`mount` lets you browse every snapshot as a folder. Press Ctrl-C to unmount.

From the Mac, if the box is gone, restore to anywhere:

```bash
~/.local/bin/restic-maint ubersdr -- restore latest --target ~/restore-ubersdr
```

If the NAS is gone, restore from the second copy on `.109` instead (same password):

```bash
~/.local/bin/restic-copy macmini-server -- restore latest --target ~/restore-macmini --include /etc
```

To rebuild a whole box onto a new disk:

1. Install the same Ubuntu release.
2. Run `deploy.sh` for it, then copy the password from the password manager to `/etc/restic/password`.
3. Restore `latest` to a temporary target.
4. rsync it over the new root, leaving out `/etc/fstab`, `/boot` and `/etc/machine-id`.
5. Re-pull the Docker images with `docker compose pull` in each stack.
6. For databases, restore from the dumps in `/var/backups/restic-dumps/` or `/mnt/immich/backups`.

## Files

| File | Installed as |
|---|---|
| `restic-backup.sh` | `/usr/local/bin/restic-backup` on each box |
| `restic-backup.service`, `restic-backup.timer` | `/etc/systemd/system/` (+ `restic-backup.timer.d/schedule.conf` from `ONCALENDAR`) |
| `hosts/<host>.conf` | `/etc/restic/backup.conf` |
| `exclude-common.txt`, `hosts/<host>.exclude` | `/etc/restic/exclude-common.txt`, `/etc/restic/exclude-host.txt` |
| `nas/public.crt` | `/etc/restic/nas.crt` on boxes, `~/.config/restic/nas.crt` on the Mac |
| `nas/rest-server.sh`, `nas/S99restic-rest-server.sh` | `/volume1/homes/admin/rest-server/` on the NAS (+ the rc.d copy, as root) |
| `restic-maint.sh` | `~/.local/bin/restic-maint` on the Mac (launchd `com.vu2cpl.restic-maint`) |
| `restic-copy.sh` | `~/.local/bin/restic-copy` on the Mac (launchd `com.vu2cpl.restic-copy`) |
| `deploy.sh`, `install-maint.sh` | run from the Mac |
