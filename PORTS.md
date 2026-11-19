# Ports — VU2CPL shack

Every TCP/UDP port the shack uses, as three lists: grouped by host (sections 1–8), [by app (A–Z)](#by-app-az)
and [by port (ascending)](#by-port-ascending). When a port changes, change all three.

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

## By app (A–Z)

Same entries as sections 1–8, one row per app and port. `WAN forward` = the UniFi gateway forwards that port from the internet.

| App | Port | Proto | Host | Notes |
|-----|------|-------|------|-------|
| AetherSDR | 9007 | UDP | Mac mini | Antenna Genius / ShackSwitch discovery |
| AetherSDR | 50001 | TCP | Mac mini | TCI server |
| Caddy (`caddy` container) | 80 | TCP | UberSDR box `.109` |  |
| Caddy (`caddy` container) | 443 | TCP+UDP | UberSDR box `.109` |  |
| Caddy (`openwebrx-caddy`) | 80 | TCP | WAN forward | → `.109:8880`, Let's Encrypt HTTP challenge |
| Caddy (`openwebrx-caddy`) | 2029 | TCP | UberSDR box `.109` | admin API, localhost only |
| Caddy (`openwebrx-caddy`) | 8873 | TCP | UberSDR box `.109`, WAN forward | OpenWebRX+ public HTTPS |
| Caddy (`openwebrx-caddy`) | 8880 | TCP | UberSDR box `.109` | ACME challenge, open only during a renewal |
| chrony | 323 | UDP | UberSDR box `.109` | command port, localhost only |
| codecserver | 1073 | TCP | UberSDR box `.109` | OpenWebRX+ digital voice |
| CUPS | 631 | TCP | noderedpi4 `.169` | localhost only, OS default |
| Deye / Solarman logger | 8899 | TCP | `192.168.30.193` (IoT VLAN) | inverter registers, Solarman V5 |
| DX cluster: KIEL `db0sue.de` | 8000 | TCP | internet | outbound, DXCC tab |
| DX cluster: N2WQ `cluster.n2wq.com` | 8300 | TCP | internet | outbound, DXCC tab |
| DX cluster: VU24DX `vu24dx.ddns.net` | 7300 | TCP | internet | outbound, RBN tab (VU24DX-1) |
| DX cluster: VU2OY `vu2oy.ddns.net` | 7550 | TCP | internet | outbound, RBN tab (VU2OY-9) + DXCC tab |
| DXCA | 2333 | UDP | UberSDR box `.109` | decoder input: MSHV |
| DXCA | 2334 | UDP | UberSDR box `.109` | decoder input: JTDX (via RX Hub) |
| DXCA | 2335 | UDP | UberSDR box `.109` | decoder input: WSJT-X |
| DXCA | 2336 | UDP | UberSDR box `.109` | decoder input: UberSDR |
| DXCA | 2337 | UDP | UberSDR box `.109` | decoder input: SDR-Control (IC-705) |
| DXCA | 7575 | TCP | UberSDR box `.109` | telnet cluster server |
| DXCA | 7580 | TCP | UberSDR box `.109`, WAN forward | web GUI |
| FlexRadio | 4991 | UDP | FlexRadio `.148` | VITA-49 streams to the client |
| FlexRadio | 4992 | TCP | FlexRadio `.148` | SmartSDR API |
| FlexRadio | 4992 | UDP | FlexRadio `.148` | discovery broadcast (LAN only) |
| FlexRadio | 4993 | UDP | FlexRadio `.148` | SmartLink |
| FlexRadio | 4994 | TCP | FlexRadio `.148` | SmartLink TLS |
| FlexRadio SmartLink | 4991–4995 | TCP+UDP | WAN forward | → `.148:4991–4995` |
| fluent-bit | 24224 | TCP | UberSDR box `.109` | localhost only |
| glances | 61209 | TCP | UberSDR box `.109` | localhost only |
| Home Assistant | 8123 | TCP | HassPi `.36` | web, REST and WebSocket API |
| Icom remote | 50001 | TCP+UDP | Icom `.237`, WAN forward |  |
| load_monitor.py | 8765 | TCP | meridianpi5 `.164` | Node-RED `/mains/history` relays here |
| lp700-server | 8089 | TCP | noderedpi4 `.169` | LP-700 WebSocket `/ws` |
| mDNS (avahi) | 5353 | UDP | all hosts |  |
| Meridian | 7300 | TCP | UberSDR box `.109` | RBN-compatible telnet feed |
| Meridian | 7364 | TCP | UberSDR box `.109` | REST API |
| Meridian | 7374 | TCP | UberSDR box `.109`, WAN forward | web UI + same-origin API |
| Meridian | 7550 | TCP | UberSDR box `.109`, WAN forward | DX-cluster telnet (`vu2cpl.ddns.net:7550`) |
| Meridian | 7551 | TCP | UberSDR box `.109` | Local Users telnet |
| Mosquitto (MQTT) | 1883 | TCP | noderedpi4 `.169` | auth required |
| Mosquitto (MQTT) | 8883 | TCP | noderedpi4 `.169` | MQTT over TLS |
| Mosquitto (MQTT) | 9001 | TCP | noderedpi4 `.169` | MQTT over WebSocket |
| mshv_rumlog_bridge.py (qso-inbox) | 2233 | UDP | Mac mini | localhost only, MSHV logged-QSO ADIF |
| Node-RED | 1880 | TCP | noderedpi4 `.169` | editor, `/ui`, `/shack`, HTTP endpoints |
| Node-RED | 4992 | UDP | noderedpi4 `.169` | listens for FlexRadio discovery |
| NTP (chrony on gpsntp) | 123 | UDP | gpsntp `.158` | stratum 1, GPS + PPS |
| OpenWebRX+ | 8874 | TCP | UberSDR box `.109` | the app itself; LAN admin at `/settings` |
| restic rest-server | 9900 | TCP | NAS `.101` | append-only |
| restic rest-server | 9901 | TCP | NAS `.101` | for the Mac |
| Reverse Beacon Network | 7001 | TCP | internet | outbound, one-off spot checks |
| rotator-remote | 8090 | TCP | noderedpi4 `.169` | rotator WebSocket `/ws` + compass page |
| rpcbind | 111 | TCP+UDP | noderedpi4 `.169` | OS default, not used by the shack |
| rpi_agent | 7799 | TCP | noderedpi4 `.169`, meridianpi5 `.164`, gpsntp `.158`, Pi 3B+ `.142` | reboot / shutdown |
| RUMlogNG | 2237 | UDP | Mac mini | WSJT-X-style UDP (DXCA passthrough) |
| RUMlogNG | 2238 | UDP | Mac mini | ADIF UDP logging |
| RustDesk client | 21119 | UDP | noderedpi4 `.169`, UberSDR box `.109`, Mac mini |  |
| RustDesk server | 21115 | TCP | Oracle VM | NAT type test |
| RustDesk server | 21116 | TCP+UDP | Oracle VM | ID / rendezvous |
| RustDesk server | 21117 | TCP | Oracle VM | relay |
| RX Hub | 2242 | UDP | Mac mini | localhost only, JTDX-VU UDP in |
| RX Hub | 8742 | TCP | Mac mini | web page, localhost only |
| Samba | 445 | TCP | HassPi `.36` | `config` share |
| sdrc_rumlog_proxy.py (qso-inbox) | 2239 | UDP | Mac mini | localhost only, SDR-Control |
| Smarteefi | 8890 | UDP | Smarteefi boards (IoT VLAN) | push broadcast, doesn't cross the VLAN |
| Smarteefi | 10201 | UDP | Smarteefi boards (IoT VLAN) | poll and switch (unicast from HA) |
| spe-remote | 8888 | TCP | noderedpi4 `.169` | SPE WebSocket `/ws` + web UI |
| SSH | 22 | TCP | noderedpi4 `.169`, UberSDR box `.109`, other Linux hosts |  |
| UberSDR | 1024–1029 | UDP | UberSDR box `.109` | HPSDR bridge |
| UberSDR | 1234 | TCP | UberSDR box `.109` | rtl_tcp server |
| UberSDR | 8073 | TCP | UberSDR box `.109`, WAN forward | web (HF, RX888) + KiwiSDR emulation |
| UberSDR | 8080 | TCP | UberSDR box `.109` | web + API; RX Hub connects here |
| UberSDR | 8901 | TCP | UberSDR box `.109`, WAN forward | public page "VU2CPL WebSDR" |
| Wavelog (trial) | 8086 | TCP | UberSDR box `.109` |  |
| Web APIs: Telegram, Open-Meteo, NOAA, kc2g, Club Log, sm7iun | 443 | TCP | internet | outbound |
| WireGuard: Admin VPN | 51820 | UDP | UniFi gateway | Manoj's devices, full access |
| WireGuard: Guest | 51822 | UDP | UniFi gateway | internet exit only |
| WireGuard: Radio VPN | 51821 | UDP | UniFi gateway | operators: Flex + Node-RED 1880 only |

---

## By port (ascending)

Same entries, sorted by port number (a range sorts by its first port).

| Port | Proto | App | Host | Notes |
|------|-------|-----|------|-------|
| 22 | TCP | SSH | noderedpi4 `.169`, UberSDR box `.109`, other Linux hosts |  |
| 80 | TCP | Caddy (`caddy` container) | UberSDR box `.109` |  |
| 80 | TCP | Caddy (`openwebrx-caddy`) | WAN forward | → `.109:8880`, Let's Encrypt HTTP challenge |
| 111 | TCP+UDP | rpcbind | noderedpi4 `.169` | OS default, not used by the shack |
| 123 | UDP | NTP (chrony on gpsntp) | gpsntp `.158` | stratum 1, GPS + PPS |
| 323 | UDP | chrony | UberSDR box `.109` | command port, localhost only |
| 443 | TCP | Web APIs: Telegram, Open-Meteo, NOAA, kc2g, Club Log, sm7iun | internet | outbound |
| 443 | TCP+UDP | Caddy (`caddy` container) | UberSDR box `.109` |  |
| 445 | TCP | Samba | HassPi `.36` | `config` share |
| 631 | TCP | CUPS | noderedpi4 `.169` | localhost only, OS default |
| 1024–1029 | UDP | UberSDR | UberSDR box `.109` | HPSDR bridge |
| 1073 | TCP | codecserver | UberSDR box `.109` | OpenWebRX+ digital voice |
| 1234 | TCP | UberSDR | UberSDR box `.109` | rtl_tcp server |
| 1880 | TCP | Node-RED | noderedpi4 `.169` | editor, `/ui`, `/shack`, HTTP endpoints |
| 1883 | TCP | Mosquitto (MQTT) | noderedpi4 `.169` | auth required |
| 2029 | TCP | Caddy (`openwebrx-caddy`) | UberSDR box `.109` | admin API, localhost only |
| 2233 | UDP | mshv_rumlog_bridge.py (qso-inbox) | Mac mini | localhost only, MSHV logged-QSO ADIF |
| 2237 | UDP | RUMlogNG | Mac mini | WSJT-X-style UDP (DXCA passthrough) |
| 2238 | UDP | RUMlogNG | Mac mini | ADIF UDP logging |
| 2239 | UDP | sdrc_rumlog_proxy.py (qso-inbox) | Mac mini | localhost only, SDR-Control |
| 2242 | UDP | RX Hub | Mac mini | localhost only, JTDX-VU UDP in |
| 2333 | UDP | DXCA | UberSDR box `.109` | decoder input: MSHV |
| 2334 | UDP | DXCA | UberSDR box `.109` | decoder input: JTDX (via RX Hub) |
| 2335 | UDP | DXCA | UberSDR box `.109` | decoder input: WSJT-X |
| 2336 | UDP | DXCA | UberSDR box `.109` | decoder input: UberSDR |
| 2337 | UDP | DXCA | UberSDR box `.109` | decoder input: SDR-Control (IC-705) |
| 4991–4995 | TCP+UDP | FlexRadio SmartLink | WAN forward | → `.148:4991–4995` |
| 4991 | UDP | FlexRadio | FlexRadio `.148` | VITA-49 streams to the client |
| 4992 | TCP | FlexRadio | FlexRadio `.148` | SmartSDR API |
| 4992 | UDP | FlexRadio | FlexRadio `.148` | discovery broadcast (LAN only) |
| 4992 | UDP | Node-RED | noderedpi4 `.169` | listens for FlexRadio discovery |
| 4993 | UDP | FlexRadio | FlexRadio `.148` | SmartLink |
| 4994 | TCP | FlexRadio | FlexRadio `.148` | SmartLink TLS |
| 5353 | UDP | mDNS (avahi) | all hosts |  |
| 7001 | TCP | Reverse Beacon Network | internet | outbound, one-off spot checks |
| 7300 | TCP | DX cluster: VU24DX `vu24dx.ddns.net` | internet | outbound, RBN tab (VU24DX-1) |
| 7300 | TCP | Meridian | UberSDR box `.109` | RBN-compatible telnet feed |
| 7364 | TCP | Meridian | UberSDR box `.109` | REST API |
| 7374 | TCP | Meridian | UberSDR box `.109`, WAN forward | web UI + same-origin API |
| 7550 | TCP | DX cluster: VU2OY `vu2oy.ddns.net` | internet | outbound, RBN tab (VU2OY-9) + DXCC tab |
| 7550 | TCP | Meridian | UberSDR box `.109`, WAN forward | DX-cluster telnet (`vu2cpl.ddns.net:7550`) |
| 7551 | TCP | Meridian | UberSDR box `.109` | Local Users telnet |
| 7575 | TCP | DXCA | UberSDR box `.109` | telnet cluster server |
| 7580 | TCP | DXCA | UberSDR box `.109`, WAN forward | web GUI |
| 7799 | TCP | rpi_agent | noderedpi4 `.169`, meridianpi5 `.164`, gpsntp `.158`, Pi 3B+ `.142` | reboot / shutdown |
| 8000 | TCP | DX cluster: KIEL `db0sue.de` | internet | outbound, DXCC tab |
| 8073 | TCP | UberSDR | UberSDR box `.109`, WAN forward | web (HF, RX888) + KiwiSDR emulation |
| 8080 | TCP | UberSDR | UberSDR box `.109` | web + API; RX Hub connects here |
| 8086 | TCP | Wavelog (trial) | UberSDR box `.109` |  |
| 8089 | TCP | lp700-server | noderedpi4 `.169` | LP-700 WebSocket `/ws` |
| 8090 | TCP | rotator-remote | noderedpi4 `.169` | rotator WebSocket `/ws` + compass page |
| 8123 | TCP | Home Assistant | HassPi `.36` | web, REST and WebSocket API |
| 8300 | TCP | DX cluster: N2WQ `cluster.n2wq.com` | internet | outbound, DXCC tab |
| 8742 | TCP | RX Hub | Mac mini | web page, localhost only |
| 8765 | TCP | load_monitor.py | meridianpi5 `.164` | Node-RED `/mains/history` relays here |
| 8873 | TCP | Caddy (`openwebrx-caddy`) | UberSDR box `.109`, WAN forward | OpenWebRX+ public HTTPS |
| 8874 | TCP | OpenWebRX+ | UberSDR box `.109` | the app itself; LAN admin at `/settings` |
| 8880 | TCP | Caddy (`openwebrx-caddy`) | UberSDR box `.109` | ACME challenge, open only during a renewal |
| 8883 | TCP | Mosquitto (MQTT) | noderedpi4 `.169` | MQTT over TLS |
| 8888 | TCP | spe-remote | noderedpi4 `.169` | SPE WebSocket `/ws` + web UI |
| 8890 | UDP | Smarteefi | Smarteefi boards (IoT VLAN) | push broadcast, doesn't cross the VLAN |
| 8899 | TCP | Deye / Solarman logger | `192.168.30.193` (IoT VLAN) | inverter registers, Solarman V5 |
| 8901 | TCP | UberSDR | UberSDR box `.109`, WAN forward | public page "VU2CPL WebSDR" |
| 9001 | TCP | Mosquitto (MQTT) | noderedpi4 `.169` | MQTT over WebSocket |
| 9007 | UDP | AetherSDR | Mac mini | Antenna Genius / ShackSwitch discovery |
| 9900 | TCP | restic rest-server | NAS `.101` | append-only |
| 9901 | TCP | restic rest-server | NAS `.101` | for the Mac |
| 10201 | UDP | Smarteefi | Smarteefi boards (IoT VLAN) | poll and switch (unicast from HA) |
| 21115 | TCP | RustDesk server | Oracle VM | NAT type test |
| 21116 | TCP+UDP | RustDesk server | Oracle VM | ID / rendezvous |
| 21117 | TCP | RustDesk server | Oracle VM | relay |
| 21119 | UDP | RustDesk client | noderedpi4 `.169`, UberSDR box `.109`, Mac mini |  |
| 24224 | TCP | fluent-bit | UberSDR box `.109` | localhost only |
| 50001 | TCP | AetherSDR | Mac mini | TCI server |
| 50001 | TCP+UDP | Icom remote | Icom `.237`, WAN forward |  |
| 51820 | UDP | WireGuard: Admin VPN | UniFi gateway | Manoj's devices, full access |
| 51821 | UDP | WireGuard: Radio VPN | UniFi gateway | operators: Flex + Node-RED 1880 only |
| 51822 | UDP | WireGuard: Guest | UniFi gateway | internet exit only |
| 61209 | TCP | glances | UberSDR box `.109` | localhost only |

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
