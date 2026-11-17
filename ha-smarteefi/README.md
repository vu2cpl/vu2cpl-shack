# Smarteefi on Home Assistant: local patches

HassPi (`192.168.1.36`) runs the Smarteefi custom integration from HACS. These patches make it work in this
house, where the Smarteefi boards are on the IoT VLAN (`192.168.30.x`) and HA is on `192.168.1.x`.

The integration is by Core Embedded: upstream at
[coreembedded/smarteefi-homeassistant](https://github.com/coreembedded/smarteefi-homeassistant). The patch
file is against upstream commit `cb9e4c5` (2026-09-26).

## Files

| File | What it is |
|---|---|
| `smarteefi-vu2cpl.patch` | The patch to `__init__.py`, `config_flow.py` and `switch.py` |
| `smarteefi_hosts.json` | Serial → device IP and HA device name. Copied to `/config/smarteefi_hosts.json` |
| `apply.sh` | Checks, backs up, patches the share, copies the host map, optionally restarts HA |

## When to run apply.sh

Run it after **any** HACS update or redownload of Smarteefi. HACS replaces the whole component folder and
the patches are lost without any error. This happened on 2026-10-02 and nobody noticed for 6 weeks: all 17
switches showed "off" and HA logged a `Device Offline` error every 5 seconds.

1. Mount the HA share: Finder → Go → Connect to Server → `smb://192.168.1.36/config`.
2. Check: `./apply.sh --check` (exit 0 = patch live).
3. Patch and restart: `./apply.sh --restart`.

A config-entry reload is not enough. HA caches the component's Python modules until a full restart.

`apply.sh` does a dry run first. If upstream changed the same lines, it stops and changes nothing. Then
port the patch to the new upstream code (clone upstream, apply the old patch by hand, `git diff` again).
Stock files are backed up to `/config/smarteefi-backups/<date>-stock/`, outside the component folder.

## What the patch does

1. **Unicast host map.** The bundled `smarteefi-ha-cli` sends a UDP broadcast to `ip | ~netmask` of HA's own
   interface. A broadcast cannot cross the VLAN. For a serial in `smarteefi_hosts.json`, the CLI gets the
   device IP with netmask `255.255.255.255`, so the same arithmetic gives routed unicast. Unlisted serials
   keep the stock broadcast. Used for `get-status` (polling) and `set-status` (switching).
2. **One HA device per board.** Upstream creates entities only, so the integration page showed 0 devices and
   the switches had no area. Each board is now a device (name from the host map, model = serial prefix
   `SE5` / `NS2` / `NS4`). Areas can be set on the device.
3. **Unavailable instead of a false "off".** After 3 failed polls in a row, the board's entities become
   `unavailable` and one warning is logged. They come back on the next good poll. Upstream logged an ERROR
   on every failed poll and kept the last state.
4. **A switch command that gets no answer raises an error.** The CLI exits 0 even when it prints
   `Device Offline`. Upstream then showed the switch as changed although nothing switched.
5. **Poll overlap guard.** Upstream polls every 5 s (since `cb9e4c5`). One sweep (5 boards, 1 s gaps) takes
   longer than that. Sweeps no longer stack up, and a CLI call is killed after 15 s.
6. **HA 2026 fixes.** The options flow no longer assigns `config_entry` (a 500 on Configure).
   `async_unload_platforms` replaces `async_forward_entry_unload` with a list (a failure on reload). The UDP
   listener is a real `DatagramProtocol` with `SO_REUSEADDR`/`SO_REUSEPORT` set before `bind()` (an
   "Address in use" error after every reload).

Device push updates (UDP :8890 broadcast from the boards) still cannot cross the VLAN. State comes from the
5 s poll.

## The boards

| Serial | IP (UniFi reservation) | HA device | Switches |
|---|---|---|---|
| `se5110002011` | 192.168.30.112 | Shack power board | USB, Empty, Empty, DIAMOND GSV3000, NETWORK SW |
| `ns4110003532` | 192.168.30.120 | Shack wall outlet | Always on, UNIFi 8 port router, Mini Rack, Monitor |
| `ns2110001047` | 192.168.30.149 | Foyer & Porch | Foyer light, Porch (as lights) |
| `ns2110001071` | 192.168.30.206 | Living & Pooja | Living, Pooja (as lights) |
| `ns4110003068` | 192.168.30.249 | Gate & outer wall | Gate1, Gate2, Ext Wall1, Ext wall2 (as lights) |

## Lights (since 2026-11-17)

The 8 light circuits are shown as lights with HA's **Show as → Light** helper (`switch_as_x`):
`light.foyer_light`, `light.porch`, `light.living`, `light.pooja`, `light.gate1`, `light.gate2`,
`light.ext_wall1`, `light.ext_wall2`. Each one wraps the `switch.*` of the same name, which is hidden, not
deleted. Use the `light.*` entities in dashboards and automations. Deleting a helper un-hides its switch.
The helpers live in HA's config entries, not in this repo, and a HACS update does not touch them.

**Friendly names:** since HA 2026.x the friendly name of any entity on a device is "device name + entity
name". So with the board devices, `light.porch` is called "Foyer & Porch Porch". To shorten it, rename the
device in HA (Settings → Devices) or set the device `name` in `smarteefi_hosts.json`.

If a board gets a new IP, edit `smarteefi_hosts.json` here, run `./apply.sh --restart`, and commit.
