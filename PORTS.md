# Ports — VU2CPL shack

Every TCP/UDP port the shack uses, grouped by host.

**Last checked:** 2026-11-20. Listening sockets (TCP and UDP) were read live on noderedpi4 (`.169`), the UberSDR
box (`.109`) and the Mac mini, the FlexRadio ports were probed, and the UniFi port forwards were read from the gateway's API
(read-only). Disabled forwards (ALPA, Jukebox, old RustDesk) were deleted by Manoj the same day. The rows for the other hosts come from the repo docs and the project repos named in each row.

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

| WAN port | Proto | Forwarded to | What |
|----------|-------|--------------|------|
| 80 | TCP | `.109:8880` | Caddy, Let's Encrypt HTTP challenge for the OpenWebRX+ certificate. `.109:8880` is open only while a certificate renews. Keep it (`ubersdr-box` README) |
| 4991–4995 | TCP+UDP | `.148:4991–4995` | FlexRadio SmartLink |
| 7374 | TCP+UDP | `.109:7374` | Meridian web UI |
| 7550 | TCP+UDP | `.109:7550` | Meridian DX-cluster telnet (`vu2cpl.ddns.net:7550`). Node-RED's RBN and DXCC tabs reach it this way by hairpin NAT |
| 7580 | TCP+UDP | `.109:7580` | DXCA web GUI (pointed at `.169` until 2026-11-20, when Manoj fixed it) |
| 8073 | TCP+UDP | `.109:8073` | UberSDR (HF, RX888) |
| 8873 | TCP+UDP | `.109:8873` | OpenWebRX+ (VHF) over HTTPS |
| 8901 | TCP+UDP | `.109:8901` | UberSDR public page "VU2CPL WebSDR" |
| 50001 | TCP+UDP | `.237:50001` | Icom remote |

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
| 8073 | TCP | UberSDR web (HF, RX888), including its KiwiSDR emulation (`/kiwi/…`) |
| 8080 | TCP | UberSDR web + API (redirects to `/v2/`). RX Hub's UberSDR source connects here |
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
| 2333 | UDP | DXCA decoder input: MSHV (from the Mac) |
| 2334 | UDP | DXCA decoder input: JTDX (JTDX-VU on the Mac, relayed by RX Hub) |
| 2335 | UDP | DXCA decoder input: WSJT-X |
| 2336 | UDP | DXCA decoder input: UberSDR (from `.109` itself) |
| 2337 | UDP | DXCA decoder input: SDR-Control (IC-705) |
| 1024–1029 | UDP | UberSDR HPSDR bridge (`ubersdr-hpsdr-bridge`) |
| 5353 | UDP | mDNS (avahi) |
| 21119 | UDP | RustDesk client |
| 323 | UDP | chrony command port, localhost only |

Inside the Docker network only (not published on the host): hfdl 6090, lightning 6097, ubersdr-dsp 50051,
ubersdr-gotty 9980, ka9q-radio 5004/5006 UDP, wavelog-db 3306.

---

## 4. Mac mini `MiniM4-Pro` — `192.168.10.226`, Trusted VLAN (checked live)

| Port | Proto | Service |
|------|-------|---------|
| 2242 | UDP | **RX Hub**, localhost only: JTDX-VU (profile `FLEX VITA49`) sends its WSJT-X UDP here. RX Hub follows the dial from it and relays everything to DXCA at `.109:2334` UDP. Private repo `vu2cpl/rx-hub`, LaunchAgent `com.vu2cpl.rx-hub` |
| 8742 | TCP | **RX Hub** web page, localhost only on the Mac (`http://127.0.0.1:8742/`) |
| 2237 | UDP | RUMlogNG, WSJT-X-style UDP (DXCA's passthrough → RUMlog) |
| 2238 | UDP | RUMlogNG, ADIF UDP logging (qso-inbox bridge, WaveLogGate) |
| 2233 | UDP | `mshv_rumlog_bridge.py` (qso-inbox), localhost only: MSHV "Logged QSO ADIF" |
| 2239 | UDP | `sdrc_rumlog_proxy.py` (qso-inbox), localhost only: SDR-Control |
| 50001 | TCP | AetherSDR TCI server |
| 9007 | UDP | AetherSDR, Antenna Genius / ShackSwitch discovery |
| 21119 | UDP | RustDesk client |

RX Hub's sources connect out from the Mac: UberSDR `.109:8080`, the Kiwi emulation on `.109:8073`, OpenWebRX+
(public receivers), and the FlexRadio, directly on `.148` or over SmartLink. While RX Hub is down, DXCA gets
nothing from JTDX-VU (see the rx-hub HANDOVER).

---

## 5. FlexRadio FLEX-6600 — `192.168.1.148`

| Port | Proto | Use |
|------|-------|-----|
| 4992 | TCP | SmartSDR API. Node-RED's FlexRadio tab and the lightning TX-inhibit connect here (probed open) |
| 4992 | UDP | Discovery broadcast from the radio (LAN only; doesn't cross the VPN) |
| 4991 | UDP | VITA-49 streams (audio, panadapter, meters) to the client |
| 4993 | UDP | SmartLink |
| 4994 | TCP | SmartLink TLS (probed open) |

The WAN forward covers 4991–4995 TCP+UDP for SmartLink.

---

## 6. Other LAN hosts (from the docs)

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

## 7. Outbound from the shack

| Target | Port | Proto | Used by |
|--------|------|-------|---------|
| `vu2oy.ddns.net` | 7550 | TCP | RBN tab (VU2OY-9) + DXCC cluster |
| `vu24dx.ddns.net` | 7300 | TCP | RBN tab (VU24DX-1) |
| `cluster.n2wq.com` | 8300 | TCP | DXCC cluster |
| `db0sue.de` (KIEL) | 8000 | TCP | DXCC cluster |
| `telnet.reversebeacon.net` | 7001 | TCP | One-off spot checks only |
| Telegram, Open-Meteo, NOAA, kc2g, Club Log, sm7iun | 443 | TCP | Alerts and data fetches |

---

## 8. RustDesk

Self-hosted `hbbs` + `hbbr` on an Oracle Cloud Always Free VM since 2026-10-06. Address, key and the Mac
switch script are in `~/projects/oracle-rustdesk/HANDOVER.md` (not a repo; never put them here).

| Port | Proto | Use | Open on the VM |
|------|-------|-----|----------------|
| 21115 | TCP | NAT type test | yes |
| 21116 | TCP+UDP | ID / rendezvous, hole punching | yes |
| 21117 | TCP | Relay | yes |
| 21118–21119 | TCP | Web client only | no (not needed) |

Clients connect outbound to these, so the shack needs no inbound forward. The old `.109` server's
forward was deleted from UniFi on 2026-11-20.

---

## Re-checking

```bash
# Listening ports on a Linux box
ssh vu2cpl@192.168.1.169 'sudo ss -tulnp'
ssh vu2cpl@192.168.1.109 'sudo ss -tulnp; sudo docker ps --format "{{.Names}}\t{{.Ports}}"'

# The Mac
lsof -nP -iTCP -sTCP:LISTEN; lsof -nP -iUDP

# UniFi port forwards (read-only; key stays in ~/.config/vu2cpl-shack.env)
set -a; . ~/.config/vu2cpl-shack.env; set +a
curl -sk -H "X-API-KEY: $UNIFI_API_KEY" "https://$UNIFI_HOST/proxy/network/api/s/default/rest/portforward"
```
