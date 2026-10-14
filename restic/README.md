# restic backups to the Synology

This directory holds the nightly, encrypted, deduplicated backups of the shack's Linux boxes. They go
to a restic **rest-server** on the Synology NAS. The servers can only *add* to their backups.
Deleting old snapshots happens in a weekly maintenance job on the Mac.

Set up 2026-10-14 to replace UrBackup. The older backup jobs are being retired once restic has a few
good nights behind it.

| Box | Repository on the NAS | Nightly (IST) | What is in it |
|---|---|---|---|
| ubersdr (192.168.1.109) | `/volume1/Backups/restic/ubersdr` | 01:30 | whole root + `/boot/efi`; Wavelog DB dump |
| macmini-server | `/volume1/Backups/restic/macmini-server` | 03:00 | whole root, `/boot`, `/boot/efi`, Immich library (`/mnt/immich`); ALPA-replica DB dump |
| Mac (maintenance only) | — | Sun 10:30 | `forget --prune` + a rotating `check` of every repository |

The Mac's own files aren't backed up here; it uses Time Machine.

## How it fits together

```
 ubersdr ─┐  HTTPS :9900  append-only, private repos       ┌─ /volume1/Backups/restic/ubersdr
          ├────────────────────────────────▶  rest-server ─┤
 macmini ─┘  (each login reaches only its own repo)        └─ /volume1/Backups/restic/macmini-server
                                                ▲
 Mac ───────── HTTPS :9901  full access, user `maint` ──────┘   forget / prune / check, weekly
```

- **Append-only (:9900).** Each server logs in as its own user (`ubersdr`, `macmini-server`) and
  can only reach its own repository. It can add data and snapshots but can't delete or overwrite
  anything except its own stale lock files. A compromised or ransomware-hit server therefore can't
  destroy its backups.
- **Full access (:9901).** Only the `maint` login can use it. That credential lives only on the Mac.
- **No SSH key for the servers.** Their SSH keys were taken off the NAS when this went in.
  **Caveat:** macmini-server's `manoj` user still has the `alpaindia-backup` key, which logs in as
  NAS `admin`, for `push-to-nas.sh` and `music-to-nas.sh`. Until those jobs are retired or moved to
  a non-admin NAS user, a compromised macmini-server could still delete repository files over SSH.
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

## The NAS side (`nas/`)

DSM 5.2 gives `admin` no root, no `sudo` and no user crontab. So rest-server runs as `admin`, who
also owns the repository files, from `/volume1/homes/admin/rest-server/`. That directory holds the
binary, `rest-server.sh`, the cert and key, `users.htpasswd`, `maint.htpasswd`, the logs and the pid
files.

- **Binary:** rest-server v0.14.0, linux_amd64, the official release. It was SHA256-checked and its
  GPG signature verified against restic's release key `CF8F18F2844575973F79D4E191A6868BD3F7A907`.
- **Control:** `rest-server.sh start|stop|restart|status`.
- **Ports 9900/9901:** DSM's firewall is an allow-list that drops everything else, and changing it
  needs the DSM web UI. These two ports are already allowed because they belong to Surveillance
  Station, which isn't installed. If that ever changes, move the ports.
- **Starting at boot** needs a one-time root step, because `admin` can't write to `/usr/local/etc/rc.d`.
  DSM 5.2 runs every `S*.sh` there with `start` at boot, and the wrapper re-runs `rest-server.sh` as
  `admin`. On the NAS as root:

  ```bash
  cp /volume1/homes/admin/rest-server/S99restic-rest-server.sh /usr/local/etc/rc.d/ && chmod 755 /usr/local/etc/rc.d/S99restic-rest-server.sh
  ```

  Until that's done, after any NAS reboot run as `admin`:

  ```bash
  /volume1/homes/admin/rest-server/rest-server.sh start
  ```

  The nightly runs fail and send a Telegram alert while it's down.
- **Logins.** The htpasswd files are bcrypt. Their plain passwords are on the Mac in
  `~/.config/vu2cpl-shack.env` as `RESTIC_REST_UBERSDR`, `RESTIC_REST_MACMINI_SERVER` and
  `RESTIC_REST_MAINT`. To add a box: `htpasswd -B` a new user into `users.htpasswd`, then run
  `rest-server.sh restart`.

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
| `deploy.sh`, `install-maint.sh` | run from the Mac |
