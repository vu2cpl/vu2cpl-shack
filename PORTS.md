# Ports — VU2CPL shack

Every TCP/UDP port the shack uses, grouped by host.

**Last checked:** 2026-11-20. Listening sockets were read live on noderedpi4 (`.169`) and the UberSDR box
(`.109`), the FlexRadio ports were probed, and the UniFi port forwards were read from the gateway's API
(read-only). The rows for the other hosts come from the repo docs and the project repos named in each row.

This repo is public, so the WAN address and the RustDesk server address and key are not in this file.

---

## 1. Internet → shack

### WireGuard VPN (on the UniFi gateway itself, no forward needed)

| Port | Proto | Server | Who | Reaches |
|------|-------|--------|-----|---------|
| 51820 | UDP | Admin VPN (`192.168.3.0/24`) | Manoj's own devices | Everything (Internal + Trusted + IoT) |
| 51821 | UDP | Radio VPN (`192.168.4.0/24`) | Other operators, peers named by callsign | FlexRadio `.148` (any port) and Node-RED `.169:1880` only |
| 51822 | UDP | Guest (`192.168.5.0/24`) | Friends (VOIP) | Internet exit only |

Over the VPN, FlexRadio discovery broadcasts don't arrive, so SmartSDR connects by manual IP. Design and
firewall rules: `vlan-setup` repo, `MIGRATION-PLAN.md` "VPN design".

### UniFi port forwards

| WAN port | Proto | Forwarded to | What | Enabled |
|----------|-------|--------------|------|---------|
| 80 | TCP | `.109:8880` | Caddy, Let's Encrypt HTTP challenge for the OpenWebRX+ certificate. `.109:8880` is open only while a certificate renews. Keep it (`ubersdr-box` README) | yes |
| 4991–4995 | TCP+UDP | `.148:4991–4995` | FlexRadio SmartLink | yes |
| 7374 | TCP+UDP | `.109:7374` | Meridian web UI | yes |
| 7550 | TCP+UDP | `.109:7550` | Meridian DX-cluster telnet (`vu2cpl.ddns.net:7550`). Node-RED's RBN and DXCC tabs reach it this way by hairpin NAT | yes |
| 7580 | TCP+UDP | `.169:7580` | DXCA web GUI. **Stale:** DXCA now runs on `.109:7580`, and `.169:7580` doesn't answer | yes |
| 8073 | TCP+UDP | `.109:8073` | UberSDR (HF, RX888) | yes |
| 8873 | TCP+UDP | `.109:8873` | OpenWebRX+ (VHF) over HTTPS | yes |
| 8901 | TCP+UDP | `.109:8901` | UberSDR public page "VU2CPL WebSDR" | yes |
| 50001 | TCP+UDP | `.237:50001` | Icom remote | yes |
| 8098–8099 | TCP+UDP | `.213` | ALPA server | **no** |
| 8770 | TCP+UDP | `.213:8770` | Jukebox | **no** |
| 21115–21117 | TCP+UDP | `.109` | RustDesk (the old self-hosted server, retired 2026-10-06) | **no** |

---

## 2. noderedpi4 — `192.168.1.169` (checked live)

| Port | Proto | Service |
|------|-------|---------|
| 22 | TCP | SSH |
| 1880 | TCP | Node-RED: editor, `/ui` (Dashboard 1), `/shack` (Vue), every HTTP endpoint (`/lightning/*`, `/power/*`, `/rotator/*`, `/dxcc/*`, `/mains/history`) |
| 1883 | TCP | MQTT (Mosquitto), auth required — see [`MQTT_AUTH.md`](MQTT_AUTH.md) |
| 8883 | TCP | MQTT over TLS |
| 9001 | TCP | MQTT over WebSocket |
| 4992 | UDP | Node-RED listening for FlexRadio discovery broadcasts |
| 7799 | TCP | `rpi_agent` (`POST /reboot`, `POST /shutdown`) |
| 8888 | TCP | `spe-remote`: SPE amplifier WebSocket `/ws` + web UI |
| 8089 | TCP | `lp700-server`: LP-700 WebSocket `/ws` |
| 8090 | TCP | `rotator-remote`: rotator WebSocket `/ws` + compass web page |
| 5353 | UDP | mDNS (avahi) |
| 21119 | UDP | RustDesk client |
| 111 | TCP+UDP | rpcbind (OS default, not used by the shack) |
| 631 | TCP | CUPS, localhost only (OS default) |

---

## 3. UberSDR / Meridian box — `192.168.1.109` (checked live)

| Port | Proto | Service |
|------|-------|---------|
| 22 | TCP | SSH |
| 80, 443 | TCP (443 also UDP) | Caddy (`caddy` container) |
| 7300 | TCP | Meridian RBN-compatible telnet feed |
| 7364 | TCP | Meridian REST API |
| 7374 | TCP | Meridian web UI + same-origin API |
| 7550 | TCP | Meridian DX-cluster telnet (uploads as VU2CPL-88) |
| 7551 | TCP | Meridian Local Users telnet |
| 7575 | TCP | DXCA telnet cluster server |
| 7580 | TCP | DXCA web GUI |
| 8073 | TCP | UberSDR web (HF, RX888) |
| 8080 | TCP | UberSDR web, redirects to `/v2/` |
| 8901 | TCP | UberSDR public page "VU2CPL WebSDR" |
| 1234 | TCP | UberSDR rtl_tcp server |
| 8873 | TCP | OpenWebRX+ public HTTPS (`openwebrx-caddy`, host networking) |
| 8874 | TCP | OpenWebRX+ itself (LAN admin at `/settings`) |
| 8880 | TCP | `openwebrx-caddy` ACME HTTP challenge, open only during a renewal |
| 1073 | TCP | codecserver (OpenWebRX+ digital voice) |
| 8086 | TCP | Wavelog (trial) |
| 2029 | TCP | `openwebrx-caddy` admin API, localhost only |
| 24224 | TCP | fluent-bit, localhost only |
| 61209 | TCP | glances, localhost only |

Inside the Docker network only (not published on the host): hfdl 6090, lightning 6097, ubersdr-dsp 50051,
ubersdr-gotty 9980, ka9q-radio 5004/5006 UDP, wavelog-db 3306.

---

## 4. FlexRadio FLEX-6600 — `192.168.1.148`

| Port | Proto | Use |
|------|-------|-----|
| 4992 | TCP | SmartSDR API. Node-RED's FlexRadio tab and the lightning TX-inhibit connect here (probed open) |
| 4992 | UDP | Discovery broadcast from the radio (LAN only; doesn't cross the VPN) |
| 4991 | UDP | VITA-49 streams (audio, panadapter, meters) to the client |
| 4993 | UDP | SmartLink |
| 4994 | TCP | SmartLink TLS (probed open) |

The WAN forward covers 4991–4995 TCP+UDP for SmartLink.

---

## 5. Other LAN hosts (from the docs)

| Host | Port | Proto | Service |
|------|------|-------|---------|
| Home Assistant `HassPi` `.36` | 8123 | TCP | HA web, REST and WebSocket API |
| HassPi `.36` | 445 | TCP | Samba `config` share |
| HassPi `.36` | 1883 | — | Not listening. HA's own Mosquitto add-on was stopped 2026-10-02; HA uses the shack broker on `.169` |
| meridianpi5 `.164` | 8765 | TCP | `load_monitor.py` (power-management repo). Node-RED's `/mains/history` relays here |
| meridianpi5 `.164`, gpsntp `.158`, Pi 3B+ `.142` | 7799 | TCP | `rpi_agent` |
| gpsntp `.158` | 123 | UDP | NTP (stratum 1, GPS + PPS) |
| NAS `.101` | 9900 | TCP | restic rest-server, append-only |
| NAS `.101` | 9901 | TCP | restic rest-server for the Mac |
| Deye logger `192.168.30.193` | 8899 | TCP | Solarman V5 (inverter registers) |
| Smarteefi boards (IoT VLAN) | 10201 | UDP | Poll and switch commands (unicast from HA) |
| Smarteefi boards (IoT VLAN) | 8890 | UDP | Push broadcast. It can't cross the VLAN, so HA doesn't receive it |
| Icom radio `.237` | 50001 | UDP | Icom remote control (WAN-forwarded) |
| All hosts | 5353 | UDP | mDNS (`rp-f02054.local`, `web-888.local`, `gpsntp.local`) |

---

## 6. Outbound from the shack

| Target | Port | Proto | Used by |
|--------|------|-------|---------|
| `vu2oy.ddns.net` | 7550 | TCP | RBN tab (VU2OY-9) + DXCC cluster |
| `vu24dx.ddns.net` | 7300 | TCP | RBN tab (VU24DX-1) |
| `cluster.n2wq.com` | 8300 | TCP | DXCC cluster |
| `db0sue.de` (KIEL) | 8000 | TCP | DXCC cluster |
| `telnet.reversebeacon.net` | 7001 | TCP | One-off spot checks only |
| Telegram, Open-Meteo, NOAA, kc2g, Club Log, sm7iun | 443 | TCP | Alerts and data fetches |

---

## 7. RustDesk

Self-hosted `hbbs` + `hbbr` on an Oracle Cloud Always Free VM since 2026-10-06. Address, key and the Mac
switch script are in `~/projects/oracle-rustdesk/HANDOVER.md` (not a repo; never put them here).

| Port | Proto | Use | Open on the VM |
|------|-------|-----|----------------|
| 21115 | TCP | NAT type test | yes |
| 21116 | TCP+UDP | ID / rendezvous, hole punching | yes |
| 21117 | TCP | Relay | yes |
| 21118–21119 | TCP | Web client only | no (not needed) |

Clients connect outbound to these, so the shack needs no inbound forward. The old `.109` server's
forward (21115–21117) is still in UniFi, disabled.

---

## Re-checking

```bash
# Listening ports on a Linux box
ssh vu2cpl@192.168.1.169 'sudo ss -tulnp'
ssh vu2cpl@192.168.1.109 'sudo ss -tlnp; sudo docker ps --format "{{.Names}}\t{{.Ports}}"'

# UniFi port forwards (read-only; key stays in ~/.config/vu2cpl-shack.env)
set -a; . ~/.config/vu2cpl-shack.env; set +a
curl -sk -H "X-API-KEY: $UNIFI_API_KEY" "https://$UNIFI_HOST/proxy/network/api/s/default/rest/portforward"
```
