# RX antenna switch: CAT input selector — PLAN

**Status: plan only, nothing built.** Written 2026-11-23 on Manoj's request ("first make a plan, will
implement later"). Open item #60 in HANDOVER.md. Building it changes `flows.json`, so it needs Manoj's
yes on this plan first (CLAUDE.md critical rule #1).

## Goal

The RA0SMS RX antenna switch's AUTO mode follows **one** radio's frequency. Manoj picks that radio on
the dashboards, `/ui` and `/shack`:

**CAT input: OFF · FLEX · RGO ONE · AETHER**

Both radios use the switch (Manoj, 2026-11-23).

## What exists already

- The switch (firmware `5.0.2-cpl.4`) takes the frequency on **`shack/rxswitch/set/freq`**, not
  retained: Hz, or JSON `{"hz":…,"app":"…"}` (`freq_hz` accepted, `{"ok":false}` ignored, `app` cut to
  8 characters). Each message is also the radio heartbeat: `hb` stays true for 15 s. So a sender must
  repeat every ≤15 s and stop when the radio is off. Then `hb` goes false and the relay keeps its
  antenna (the switch's own behaviour).
- AUTO switches only on a **band change**, to the first antenna mapped to that band on the switch's own
  `/grid` page. Today: 160 m → RX ANT 1, 80 → 2, 60 → 3, 40 → 4, 30 → 5, 20 → 6, 17 m and up none.
- `nodered` has readwrite `#` on the broker. **No ACL change is needed.**

## The three sources (checked 2026-11-23)

| Input | Where the frequency comes from | Available when | Notes |
|---|---|---|---|
| **FLEX** | `flow.flexState` on the FlexRadio tab (SmartSDR TCP API, straight from the radio) | the Flex is on; no app needed | Slice = the one with `active==1`, else the first `in_use` (Manoj: the RX slice). `slices[key].rawFreq` is MHz |
| **RGO ONE** | `shack/rgo-spe-cat/rig` (retained, on change, ≤4/s) + `shack/rgo-spe-cat/status` (LWT `offline`, 30 s heartbeat) | the bridge is online and the radio answers | `{"ok":false}` when the radio stops answering (what it shows now: radio off). The rig message is retained, so it must be gated on `status`, or an old frequency looks live |
| **AETHER** | AetherSDR's TCI server, `ws://192.168.10.226:50001` (Mac Mini) | AetherSDR is open on the Mac | Listens on all interfaces; reachable from the Pi (checked); Mac firewall off. Sends `vfo:<trx>,0,<hz>;` for each receiver and `active_slice:<trx>,<letter>;` when the selected slice changes. AetherSDR drives Flex, Icom (network), Hermes Lite 2, ANAN and RTL radios; not the RGO ONE |

For the Flex, FLEX and AETHER give the same frequency. FLEX works whenever the radio is on. AETHER
works only while AetherSDR runs, but it also covers other radios that AetherSDR drives.

## Design

### Node-RED (all cross-tab hops by link pairs, rule #7)

**FlexRadio tab** (3 nodes): inject every 2 s → function *Flex RX slice → RX switch* (reads
`flow.flexState`; nothing when the radio is disconnected or no slice is in use) → link out
`rxsw_lo_flex` → RX Antenna Switch tab.

**RX Antenna Switch tab** (`rxsw_tab`):
- link in `rxsw_li_flex` (from the Flex tab).
- mqtt in `shack/rgo-spe-cat/rig` and `shack/rgo-spe-cat/status`.
- websocket client `ws://192.168.10.226:50001` + websocket in → function *Parse TCI* (splits each text
  frame on `;`, keeps the VFO A frequency of each receiver and the active receiver; never sends
  anything to AetherSDR).
- function *CAT input → RX switch*, the one place that decides:
  - keeps the latest value of each source with a time stamp: flow `rxsw_cat_src`;
  - the selection in flow **`rxsw_cat` (file scope, survives a restart)**: `off|flex|rgo|aether`;
  - sends `shack/rxswitch/set/freq` `{"hz":…,"app":"FLEX"|"RGO"|"AETHER"}` for the selected source only:
    at once when its frequency changes (at most 2 per second), and every 5 s while the source is fresh
    (Flex/TCI value no older than 10 s; RGO `ok:true` and `status` not `offline`);
  - sends nothing for OFF or a stale source;
  - goes out through the existing `rxsw_mqtt_out` (topic per message, not retained).
- inject every 5 s → that function (keepalive).
- `POST /rxswitch/cat` `{source}` → function (400 for an unknown source; stores `rxsw_cat`) → http response.
- `RX switch state` adds `cat: {sel, src: {flex|rgo|aether: {ok, hz, age}}}` to the payload the
  dashboards already get (topic `rxswitch`).

About 15 new nodes. flows_guard only has a minimum node count, so its constants don't change. The Vue
feeder count is unchanged (the existing `vue_lo_rxsw`).

### Dashboards (D1 panel `rxsw_panel` + Vue `RxSwitchCard`)

- A **CAT** row in a fixed place under the AUTO row, the same on both:
  `CAT  [OFF] [FLEX] [RGO ONE] [AETHER]`. The selected one is lit. A source with no data is greyed,
  with the reason in its tooltip ("AetherSDR not running", "RGO ONE off", "Flex not connected"). It
  stays in its slot and can still be selected (shared-controls rule).
- The existing radio line keeps showing what the switch reports (`app · freq MHz`, or "no radio data").
- Click → `POST /rxswitch/cat`. No confirm: it only changes what AUTO follows.
- D1 template height +1 row; new Vue build number; card layout checked at the real card widths in a
  browser harness before deploy, as for v61.

### Not changed

The switch firmware (cpl.4 is enough), the broker ACL, and HA (nothing about the switch is in HA).

## To check when building

1. **The websocket client while AetherSDR is closed.** It reconnects by itself. If it fills the
   Node-RED log with connection errors every few seconds, connect only while AETHER is selected (a
   function node with the `ws` module instead of the websocket nodes).
2. **The Mac's address.** `192.168.10.226` must not change, or the TCI URL breaks. Is it a UniFi
   reservation? (mDNS `MiniM4-Pro.local` does not cross from the Pi's VLAN.)
3. **Flex `active` with two GUI clients** (for example SmartSDR and AetherSDR together): each client has
   its own selected slice. Check which one `flexState` reports.
4. **AetherSDR's TCI client list** will show the Pi as a client. It is read-only, but check that its
   presence changes nothing in AetherSDR (TCI audio/IQ streams start only when a client asks).

## Tests (with Manoj present: AUTO moves the real relays)

1. Each input alone: the switch's `state` shows the right `app`, `freq`, `hb:true`; a band change moves
   the relay with AUTO on.
2. Turn the selected source off (radio off, AetherSDR closed, RGO off): `hb` goes false within 15 s, the
   relay stays, the dashboards grey that input.
3. Change the selection while a radio is transmitting: the switch refuses while PTT is high (its own
   rule) and follows once PTT drops.
4. Restart Node-RED: the selection is kept.
5. flows_guard OK; revert tag `pre-rxswcat-<date>` before the deploy.

## Questions for Manoj

1. Which input is selected after the first deploy (OFF keeps today's behaviour)?
2. When the selected input goes quiet, should the switch just hold (as planned), or fall back to another
   input?
3. Reserve `192.168.10.226` for the Mac Mini in UniFi?
4. Anything in HA, or dashboards only?
