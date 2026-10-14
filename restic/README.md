# restic backups to the Synology

This directory holds the nightly, encrypted, deduplicated backups of the shack's Linux boxes to the
Synology NAS. They were set up on 2026-10-14 to replace UrBackup. The older backup jobs are being
retired once restic has a few good nights behind it.

| Box | Repository on the NAS | Timer (IST) | What is in it |
|---|---|---|---|
| ubersdr (192.168.1.109) | `/volume1/Backups/restic/ubersdr` | 01:30 | whole root + `/boot/efi`; Wavelog DB dump |
| macmini-server | `/volume1/Backups/restic/macmini-server` | 03:00 | whole root, `/boot`, `/boot/efi`, Immich library (`/mnt/immich`); ALPA-replica DB dump |

The Mac is not covered here; it uses Time Machine.

## How it works

`restic-backup.sh` is installed as `/usr/local/bin/restic-backup` and runs as root from `restic-backup.timer`.
Each run:

1. **Dumps databases.** It dumps each MariaDB container in `DB_DUMPS` to `/var/backups/restic-dumps/`,
   using the container's own `MARIADB_*` env, so no credentials are stored here. The live data
   directories are excluded, because a file copy of a running database can't be relied on.
   On macmini-server, Immich writes its own DB dump to `/mnt/immich/backups` at 07:30 IST (02:00 UTC),
   so each 03:00 run carries a dump from about 19.5 h earlier. The script warns if the newest dump is
   more than 26 h old.
2. **Backs up.** It runs `restic backup` of `BACKUP_PATHS` with `--one-file-system`, using
   `exclude-common.txt` plus `hosts/<host>.exclude`.
   Excluded: anything that can be re-downloaded or regenerated, such as Docker image layers, caches,
   snaps, Immich thumbnails and transcodes, Plex metadata, and LM Studio models.
   Kept: Docker volumes, `/etc`, `/home`, `/usr/local`, `/opt` and similar.
3. **Applies retention.** `forget` keeps 7 daily, 5 weekly and 12 monthly snapshots. It also prunes on Sundays.
4. **Checks the data.** On Sundays it runs `restic check --read-data-subset=N/20`. The slice rotates
   with the week number, so all the pack data is re-read every 20 weeks.
5. **Reports.**
   - Retained MQTT JSON on `shack/backup/<host>`: `state`, `time`, `snapshot`, `data_added`,
     `duration_s`, `message`. It uses the `svc` account from `~manoj/.config/vu2cpl-shack.env`.
   - Telegram (the shack bot): 🔴 when a run fails, 🟠 for a warning (unreadable files, a failed
     dump, a stale Immich dump, a failed check), and ✅ on the first good run afterwards. A normal
     good night sends nothing.

The unit runs at `Nice=19`, `IOSchedulingClass=idle`, `CPUWeight=10` and `GOMAXPROCS=2`, so radiod
and UberSDR are not starved.

### Why rclone

The DS710+ runs DSM 5.2. Its SFTP server fails the `chmod` that restic's native `sftp:` backend
issues on every new file. The error is `Chmod …: file does not exist`, and `restic init` can't even
write its key. So the repositories use `rclone:nas:/Backups/restic/<host>`: restic starts
`rclone serve restic --stdio`, and rclone's own SFTP client doesn't issue the chmod. The remote is
defined in `rclone.conf`, installed as `/etc/restic/rclone.conf`.

Paths over SFTP are relative to the NAS's shared folders, so `/Backups/…` on the remote is
`/volume1/Backups/…` on the NAS itself.

## Secrets: the repository password

The password is `/etc/restic/password` on each box (root, mode 600). `deploy.sh` generates it on
the first deploy. **Without it the backup cannot be read**, so it must also exist off the box:

- On the Mac in `~/.config/vu2cpl-shack.env` (mode 600) as `RESTIC_PASSWORD_UBERSDR` and
  `RESTIC_PASSWORD_MACMINI_SERVER`.
- In the shack password manager. Manoj keeps that copy.

None of these values go in git; this repo is public.

## Access to the NAS

Each box's root has its own key, `/root/.ssh/restic_nas`. The public key is in the Synology `admin`
account's `~/.ssh/authorized_keys`, with no forwarding and no pty. The NAS host key is in
`/root/.ssh/known_hosts`, which rclone checks.
`/root/.ssh/config` also defines a `nas-restic` alias for manual checks, e.g.
`sudo sftp nas-restic`. restic itself doesn't use it.

## Deploying and day-to-day use

From the Mac:

```bash
./deploy.sh ubersdr 192.168.1.109
```

```bash
./deploy.sh macmini-server macmini-server.local
```

`deploy.sh` is idempotent. It installs restic, rclone and mosquitto-clients, copies the files, sets
the timer from `ONCALENDAR`, creates the password on the first deploy, and initialises the repository
if it doesn't exist. It never starts a backup.

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
sudo restic-backup -- stats latest
```

```bash
journalctl -u restic-backup -n 30
```

`--status` prints the last run's JSON and the latest snapshots. Anything after `--` is passed to
restic with this box's repository, password and rclone settings. `restic-backup --test` sends a test
Telegram message.

## Restoring

Restore single files or a directory to a scratch location first, then copy them into place:

```bash
sudo restic-backup -- restore latest --target /tmp/restore --include /home/manoj/openwebrx
```

```bash
sudo mkdir -p /mnt/restic && sudo restic-backup -- mount /mnt/restic
```

`mount` lets you browse every snapshot as a folder. Press Ctrl-C to unmount.

To rebuild a whole box onto a new disk:

1. Install the same Ubuntu release.
2. Recreate `/root/.ssh/restic_nas` and `/etc/restic/` by hand, using the password from the password manager.
3. Restore `latest` to a temporary target.
4. rsync it over the new root, leaving out `/etc/fstab`, `/boot` and `/etc/machine-id`.
5. Re-pull the Docker images with `docker compose pull` in each stack.
6. For databases, restore from the dumps in `/var/backups/restic-dumps/` or `/mnt/immich/backups`,
   not from the excluded data directories. Immich's documented restore path takes its own dump.

## Files

| File | Installed as |
|---|---|
| `restic-backup.sh` | `/usr/local/bin/restic-backup` |
| `restic-backup.service`, `restic-backup.timer` | `/etc/systemd/system/` (+ `restic-backup.timer.d/schedule.conf` from `ONCALENDAR`) |
| `hosts/<host>.conf` | `/etc/restic/backup.conf` |
| `exclude-common.txt`, `hosts/<host>.exclude` | `/etc/restic/exclude-common.txt`, `/etc/restic/exclude-host.txt` |
| `rclone.conf` | `/etc/restic/rclone.conf` |
| `deploy.sh` | run from the Mac |
