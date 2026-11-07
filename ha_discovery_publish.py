"""Publish MQTT-discovery configs for the shack sensors via HA's mqtt.publish service.

Creates HA entities for: AS3935 lightning sensor, GPS NTP chrony, RPi fleet
telemetry, UberSDR sessions, … and WAN data usage (shack/wan/wan1, wan2). All configs are retained on homeassistant/# so
they survive broker/HA restarts. Idempotent — re-running overwrites in place.
"""
import json, os, sys, urllib.request

def env():
    d = {}
    for line in open(os.path.expanduser('~/.config/vu2cpl-shack.env')):
        line = line.strip()
        if line and '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1); d[k] = v.strip()
    return d

E = env()
BASE = E['HA_URL']
HDRS = {'Authorization': 'Bearer ' + E['HA_TOKEN'], 'Content-Type': 'application/json'}

def mqtt_publish(topic, payload, retain=True):
    body = json.dumps({'topic': topic, 'payload': json.dumps(payload) if isinstance(payload, dict) else payload,
                       'retain': retain, 'qos': 0}).encode()
    req = urllib.request.Request(BASE + '/api/services/mqtt/publish', data=body, headers=HDRS, method='POST')
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()

configs = []  # (discovery_topic, config)

def sensor(uid, name, device, state_topic, *, tpl=None, unit=None, dev_class=None,
           state_class=None, icon=None, expire=None, attrs_topic=None, attrs_tpl=None, enabled=True):
    c = {
        'name': name,
        'unique_id': uid,
        'object_id': uid,
        'state_topic': state_topic,
        'device': device,
    }
    if tpl: c['value_template'] = tpl
    if unit: c['unit_of_measurement'] = unit
    if dev_class: c['device_class'] = dev_class
    if state_class: c['state_class'] = state_class
    if icon: c['icon'] = icon
    if expire: c['expire_after'] = expire
    if not enabled: c['enabled_by_default'] = False
    if attrs_topic:
        c['json_attributes_topic'] = attrs_topic
        if attrs_tpl: c['json_attributes_template'] = attrs_tpl
    configs.append((f'homeassistant/sensor/{uid}/config', c))

# ---------- AS3935 lightning sensor ----------
DEV_AS3935 = {'identifiers': ['shack_as3935'], 'name': 'AS3935 Lightning',
              'manufacturer': 'VU2CPL shack', 'model': 'ESP32 bridge (outdoor)'}
T = 'lightning/as3935'
sensor('as3935_state', 'State', DEV_AS3935, T + '/status',
       tpl='{{ value_json.event }}', icon='mdi:flash-alert',
       attrs_topic=T + '/status')
sensor('as3935_rssi', 'WiFi RSSI', DEV_AS3935, T + '/hb',
       tpl='{{ value_json.rssi }}', unit='dBm', dev_class='signal_strength',
       state_class='measurement', expire=600)
sensor('as3935_battery', 'Battery', DEV_AS3935, T + '/hb',
       tpl='{{ (value_json.vbat_mv / 1000) | round(2) }}', unit='V',
       dev_class='voltage', state_class='measurement', expire=600)
sensor('as3935_disturbers', 'Disturber count', DEV_AS3935, T + '/hb',
       tpl='{{ value_json.counters.disturber }}', state_class='total_increasing',
       icon='mdi:waveform', expire=600)
sensor('as3935_strikes', 'Lightning count', DEV_AS3935, T + '/hb',
       tpl='{{ value_json.counters.lightning }}', state_class='total_increasing',
       icon='mdi:lightning-bolt', expire=600)
sensor('as3935_last_event', 'Last event', DEV_AS3935, T + '/last_event',
       tpl='{{ value_json.event }}', icon='mdi:history',
       attrs_topic=T + '/last_event')
sensor('as3935_last_event_distance', 'Last event distance', DEV_AS3935, T + '/last_event',
       tpl=("{% if value_json.event == 'lightning' %}"
            "{% if value_json.distance == 63 %}out of range"
            "{% else %}{{ value_json.distance }} km{% endif %}"
            "{% else %}—{% endif %}"),
       icon='mdi:map-marker-distance')
sensor('as3935_last_event_time', 'Last event time', DEV_AS3935, T + '/last_event',
       tpl='{{ (value_json.ts_epoch_ms / 1000) | timestamp_utc }}',
       dev_class='timestamp')

# ---------- GPS NTP (chrony) ----------
DEV_NTP = {'identifiers': ['shack_gpsntp'], 'name': 'GPS NTP (gpsntp)',
           'manufacturer': 'VU2CPL shack', 'model': 'stratum-1 GPS/PPS'}
CT = 'shack/gpsntp/chrony'
sensor('gpsntp_stratum', 'Stratum', DEV_NTP, CT, tpl='{{ value_json.stratum }}',
       icon='mdi:layers-triple', expire=300)
sensor('gpsntp_ref', 'Reference', DEV_NTP, CT, tpl='{{ value_json.ref_name }}',
       icon='mdi:satellite-uplink', expire=300)
sensor('gpsntp_sys_offset', 'System offset', DEV_NTP, CT,
       tpl='{{ (value_json.system_time_offset_s * 1e6) | round(3) }}', unit='µs',
       state_class='measurement', icon='mdi:timer-outline', expire=300)
sensor('gpsntp_rms_offset', 'RMS offset', DEV_NTP, CT,
       tpl='{{ (value_json.rms_offset_s * 1e6) | round(3) }}', unit='µs',
       state_class='measurement', icon='mdi:sine-wave', expire=300)
sensor('gpsntp_skew', 'Skew', DEV_NTP, CT,
       tpl='{{ value_json.skew_ppm }}', unit='ppm', state_class='measurement',
       icon='mdi:chart-bell-curve', expire=300)
sensor('gpsntp_fix', 'GPS fix', DEV_NTP, CT,
       tpl="{{ '3D' if value_json.fix_mode == 3 else ('2D' if value_json.fix_mode == 2 else 'none') }}",
       icon='mdi:crosshairs-gps', expire=300)
sensor('gpsntp_sat_used', 'Satellites used', DEV_NTP, CT,
       tpl='{{ value_json.sat_used }}', state_class='measurement',
       icon='mdi:satellite-variant', expire=300)
sensor('gpsntp_sat_seen', 'Satellites seen', DEV_NTP, CT,
       tpl='{{ value_json.sat_seen }}', state_class='measurement',
       icon='mdi:satellite', expire=300)

# ---------- RPi fleet ----------
FLEET = ['noderedpi4', 'gpsntp', 'openwebrxplus', 'meridianpi5', 'HassPi',
         'rp-f02054', 'web-888']
for host in FLEET:
    slug = host.lower().replace('-', '_')
    dev = {'identifiers': [f'shack_rpi_{slug}'], 'name': f'RPi {host}',
           'manufacturer': 'VU2CPL shack', 'model': 'fleet telemetry'}
    base = f'rpi/{host}'
    sensor(f'rpi_{slug}_cpu', 'CPU', dev, base + '/cpu', unit='%',
           state_class='measurement', icon='mdi:cpu-64-bit', expire=180)
    sensor(f'rpi_{slug}_temp', 'Temp', dev, base + '/temp', unit='°C',
           dev_class='temperature', state_class='measurement', expire=180)
    sensor(f'rpi_{slug}_mem', 'Mem', dev, base + '/mem', unit='%',
           state_class='measurement', icon='mdi:memory', expire=180)
    sensor(f'rpi_{slug}_disk', 'Disk', dev, base + '/disk', unit='%',
           state_class='measurement', icon='mdi:harddisk', expire=180)
    sensor(f'rpi_{slug}_uptime', 'Uptime', dev, base + '/uptime',
           icon='mdi:clock-outline', expire=180)
    sensor(f'rpi_{slug}_ip', 'IP', dev, base + '/ip', icon='mdi:ip-network',
           expire=180)

# ---------- Lightning protection state (Node-RED bridge) ----------
# Fed by the "Lightning state → MQTT" nodes on the Lightning tab publishing
# retained JSON on shack/lightning/state every 10 s (added 2026-08-25).
DEV_LPROT = {'identifiers': ['shack_lightning_protection'], 'name': 'Lightning Protection',
             'manufacturer': 'VU2CPL shack', 'model': 'Node-RED lightning logic'}
LS = 'shack/lightning/state'

def binary(uid, name, device, state_topic, *, tpl, icon=None, expire=None):
    c = {'name': name, 'unique_id': uid, 'object_id': uid,
         'state_topic': state_topic, 'value_template': tpl,
         'payload_on': 'ON', 'payload_off': 'OFF', 'device': device}
    if icon: c['icon'] = icon
    if expire: c['expire_after'] = expire
    configs.append((f'homeassistant/binary_sensor/{uid}/config', c))

binary('lprot_bypass', 'Bypass', DEV_LPROT, LS,
       tpl="{{ 'ON' if value_json.bypass_active else 'OFF' }}",
       icon='mdi:shield-off-outline', expire=60)
binary('lprot_manual_hold', 'Manual hold', DEV_LPROT, LS,
       tpl="{{ 'ON' if value_json.manual_off else 'OFF' }}",
       icon='mdi:hand-back-left', expire=60)
sensor('lprot_om_state', 'Storm state (OM)', DEV_LPROT, LS,
       tpl='{{ value_json.om_state }}', icon='mdi:weather-lightning-rainy',
       expire=60)
sensor('lprot_threshold', 'Threshold', DEV_LPROT, LS,
       tpl='{{ value_json.threshold_km }}', unit='km',
       icon='mdi:map-marker-radius', expire=60)
sensor('lprot_reconnect', 'Reconnect timer', DEV_LPROT, LS,
       tpl='{{ value_json.reconnect_min }}', unit='min',
       icon='mdi:timer-refresh-outline', expire=60)
sensor('lprot_bypass_remaining', 'Bypass remaining', DEV_LPROT, LS,
       tpl=('{{ ((value_json.bypass_expires_at - value_json.ts) / 60000) | round(0) '
            'if value_json.bypass_expires_at else 0 }}'),
       unit='min', icon='mdi:timer-sand', expire=60)

# ---------- UberSDR ----------
DEV_UBER = {'identifiers': ['shack_ubersdr'], 'name': 'UberSDR',
            'manufacturer': 'VU2CPL shack', 'model': 'WebSDR receiver'}
UT = 'ubersdr/metrics/sessions'
# non_bypassed_users = external humans. count - internal_sessions was wrong:
# it also counted UberSDR's own docker-network service clients (cwskimmer,
# hfdl, lightning, … ~24 of them), reading "26 listeners" when 1-2 were real.
# Caveat: an ip_bypass LAN listener (the operator) isn't counted here; the
# Node-RED dashboards' who-table (2026-09-09) does include LAN humans.
sensor('ubersdr_listeners', 'Listeners', DEV_UBER, UT,
       tpl='{{ value_json.non_bypassed_users }}',
       state_class='measurement', icon='mdi:account-multiple', expire=300)
sensor('ubersdr_decoders', 'Internal decoders', DEV_UBER, UT,
       tpl='{{ value_json.internal_sessions }}', state_class='measurement',
       icon='mdi:radio-tower', expire=300)
sensor('ubersdr_sessions', 'Total sessions', DEV_UBER, UT,
       tpl='{{ value_json.count }}', state_class='measurement',
       icon='mdi:counter', expire=300)

# ---------- Phase-2 gateway bridges (Node-RED → shack/<subsystem>/state) ----------
# Fed by the 2026-08-25 bridge nodes: retained JSON per tab, read-only taps.

def binary2(uid, name, device, state_topic, *, tpl, icon=None, expire=None):
    c = {'name': name, 'unique_id': uid, 'object_id': uid,
         'state_topic': state_topic, 'value_template': tpl,
         'payload_on': 'ON', 'payload_off': 'OFF', 'device': device}
    if icon: c['icon'] = icon
    if expire: c['expire_after'] = expire
    configs.append((f'homeassistant/binary_sensor/{uid}/config', c))

DEV_FLEX = {'identifiers': ['shack_flex'], 'name': 'FlexRadio',
            'manufacturer': 'VU2CPL shack', 'model': 'FLEX-6600 (TCP bridge)'}
FT = 'shack/flex/state'
binary2('flex_connected', 'Connected', DEV_FLEX, FT,
        tpl="{{ 'ON' if value_json.connected else 'OFF' }}",
        icon='mdi:radio', expire=30)
binary2('flex_transmitting', 'Transmitting', DEV_FLEX, FT,
        tpl="{{ 'ON' if value_json.transmitting else 'OFF' }}",
        icon='mdi:access-point', expire=30)
sensor('flex_state', 'State', DEV_FLEX, FT,
       tpl='{{ value_json.txstate }}', icon='mdi:radio-tower',
       expire=30, attrs_topic=FT)

DEV_SPE = {'identifiers': ['shack_spe'], 'name': 'SPE Amplifier',
           'manufacturer': 'VU2CPL shack', 'model': 'Expert 1.5K-FA (WS bridge)'}
ST = 'shack/spe/state'
sensor('spe_mode', 'Mode', DEV_SPE, ST, tpl='{{ value_json.mode }}',
       icon='mdi:amplifier', expire=30, attrs_topic=ST)
binary2('spe_transmitting', 'Transmitting', DEV_SPE, ST,
        tpl="{{ 'ON' if value_json.rxtx == 'TRANSMIT' else 'OFF' }}",
        icon='mdi:access-point', expire=30)
binary2('spe_tuning', 'Tuning', DEV_SPE, ST,
        tpl="{{ 'ON' if value_json.tune else 'OFF' }}",
        icon='mdi:tune-vertical', expire=30)
sensor('spe_power', 'Power out', DEV_SPE, ST, tpl='{{ value_json.pwr }}',
       unit='W', dev_class='power', state_class='measurement', expire=30)
sensor('spe_power_peak', 'Power peak', DEV_SPE, ST, tpl='{{ value_json.pwr_peak }}',
       unit='W', dev_class='power', state_class='measurement', expire=30)
sensor('spe_swr', 'Antenna SWR', DEV_SPE, ST, tpl='{{ value_json.antswr }}',
       state_class='measurement', icon='mdi:swap-vertical', expire=30)
sensor('spe_band', 'Band', DEV_SPE, ST, tpl='{{ value_json.band }}',
       icon='mdi:sine-wave', expire=30)
sensor('spe_temp', 'PA temp', DEV_SPE, ST, tpl='{{ value_json.tempUpper }}',
       unit='°C', dev_class='temperature', state_class='measurement', expire=30)

DEV_LP = {'identifiers': ['shack_lp700'], 'name': 'LP-700',
          'manufacturer': 'VU2CPL shack', 'model': 'Telepost meter (WS bridge)'}
LT = 'shack/lp700/state'
sensor('lp700_avg', 'Power avg', DEV_LP, LT, tpl='{{ value_json.avg }}',
       unit='W', dev_class='power', state_class='measurement', expire=30)
sensor('lp700_peak', 'Power peak', DEV_LP, LT, tpl='{{ value_json.peak }}',
       unit='W', dev_class='power', state_class='measurement', expire=30)
sensor('lp700_swr', 'SWR', DEV_LP, LT, tpl='{{ value_json.swr }}',
       state_class='measurement', icon='mdi:swap-vertical', expire=30)

DEV_ROT = {'identifiers': ['shack_rotator'], 'name': 'Rotator',
           'manufacturer': 'VU2CPL shack', 'model': 'Rotor-EZ (WS bridge)'}
RT = 'shack/rotator/state'
sensor('rotator_heading', 'Heading', DEV_ROT, RT, tpl='{{ value_json.heading }}',
       unit='°', state_class='measurement', icon='mdi:compass', expire=30)
sensor('rotator_target', 'Target', DEV_ROT, RT,
       tpl='{% if value_json.target is not none %}{{ value_json.target }}{% endif %}',
       unit='°', icon='mdi:compass-outline', expire=30)
sensor('rotator_sector', 'Sector', DEV_ROT, RT,
       tpl=("{% set h = value_json.heading %}{% if h is not none %}"
            "{{ ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW',"
            "'W','WNW','NW','NNW'][((h / 22.5) + 0.5) | int % 16] }}{% endif %}"),
       icon='mdi:compass-rose', expire=30)
# Overlap: gateway-derived flag (rotor past 360° of travel; DCU-1 has no
# overlap bit — rotator-remote tracks the heading crossing the South stop).
# null (pre-first-WS-frame) renders OFF. Added 2026-09-08, TODO #45.
binary2('rotator_overlap', 'Overlap', DEV_ROT, RT,
        tpl="{{ 'ON' if value_json.overlap else 'OFF' }}",
        icon='mdi:rotate-360', expire=30)

DEV_DXCC = {'identifiers': ['shack_dxcc'], 'name': 'DXCC Tracker',
            'manufacturer': 'VU2CPL shack', 'model': 'DXCA MQTT status (ClubLog / clusters)'}
# Since 2026-11-07 these read DXCA's retained status topics (dxca v2.24.0, the
# "Status" tick on its shack MQTT destination). Before that they read
# shack/dxcc/state, from the Node-RED DXCC tab that DXCA replaced and that has
# been disabled since 2026-08-27, which is why the card sat "unavailable".
# The unique_ids are unchanged, so the entity ids, and the card, stay the same.
DXCA_BASE = 'shack/dxca/spots'
DS = DXCA_BASE + '/status'            # cluster health
DU = DXCA_BASE + '/status/VU2CPL'     # this account's totals + recent alerts
sensor('dxcc_entities', 'Entities worked', DEV_DXCC, DU,
       tpl='{{ value_json.stats.dxcc_worked }}', icon='mdi:earth',
       expire=180, attrs_topic=DU,
       attrs_tpl='{{ {"recent_alerts": value_json.recent_alerts, "qso_count": value_json.qso_count, '
                 '"last_refresh_unix": value_json.last_refresh_unix} | tojson }}')
sensor('dxcc_confirmed', 'Entities confirmed', DEV_DXCC, DU,
       tpl='{{ value_json.stats.dxcc_confirmed }}', icon='mdi:check-decagram', expire=180)
sensor('dxcc_band_slots', 'Slots worked', DEV_DXCC, DU,
       tpl='{{ value_json.stats.slots_worked }}', icon='mdi:view-grid', expire=180)
sensor('dxcc_slots_confirmed', 'Slots confirmed', DEV_DXCC, DU,
       tpl='{{ value_json.stats.slots_confirmed }}', icon='mdi:view-grid-outline', expire=180)
sensor('dxcc_clusters_online', 'Clusters online', DEV_DXCC, DS,
       tpl='{{ value_json.clusters_online }}', icon='mdi:server-network', expire=180,
       attrs_topic=DS, attrs_tpl='{{ {"clusters_total": value_json.clusters_total} | tojson }}')

DEV_RBN = {'identifiers': ['shack_rbn'], 'name': 'RBN Skimmers',
           'manufacturer': 'VU2CPL shack', 'model': 'CW/RTTY skimmer monitor'}
BT = 'shack/rbn/state'
sensor('rbn_state', 'State', DEV_RBN, BT,
       tpl=("{{ (value_json.skimmers.values() | selectattr('status', 'eq', 'online') "
            "| list | length) }} online"),
       icon='mdi:radio-tower', expire=60, attrs_topic=BT)
# Entity id kept as rbn_vu2cpl_h1 so dashboards keep working; since 2026-10-01 it
# tracks the .109 meridian container (VU2CPL-88), not .170's bare VU2CPL.
sensor('rbn_vu2cpl_h1', 'VU2CPL-88 spots (1h)', DEV_RBN, BT,
       tpl="{{ value_json.skimmers['VU2CPL-88'].h1_total }}",
       state_class='measurement', icon='mdi:counter', expire=60)
# Entity id kept as rbn_vu2oy_h1; keyed VU2OY-9 since 2026-10-15, when VU2OY's
# port became a Meridian server spotting as VU2OY-9-#.
sensor('rbn_vu2oy_h1', 'VU2OY-9 spots (1h)', DEV_RBN, BT,
       tpl="{{ value_json.skimmers['VU2OY-9'].h1_total }}",
       state_class='measurement', icon='mdi:counter', expire=60)
# VU24DX (Kozhikode) added 2026-10-07; keyed by its RBN call VU24DX-1.
sensor('rbn_vu24dx_h1', 'VU24DX-1 spots (1h)', DEV_RBN, BT,
       tpl="{{ value_json.skimmers['VU24DX-1'].h1_total }}",
       state_class='measurement', icon='mdi:counter', expire=60)

# ---------- Mains monitor (raw mains at the incomer, before the servo stabiliser) ----------
# ESP32 + Selec MFM384 in the private vu2cpl/power-management repo (mains-monitor/), added
# 2026-11-07. The stabilised side is the inverter's grid input (sensor.inverter_grid_l1..l3_voltage).
# Current / power / energy read 0 until the CTs are fitted, so those entities are created
# disabled: enable them in HA (device page) once the CTs are in.
DEV_MAINS = {'identifiers': ['shack_mains_monitor'], 'name': 'Mains Monitor',
             'manufacturer': 'VU2CPL shack', 'model': 'ESP32 + Selec MFM384 (incomer)'}
MT = 'shack/mains-monitor/state'
for i, ph in enumerate('RYB'):
    sensor(f'mains_v_{ph.lower()}', f'Raw {ph}', DEV_MAINS, MT,
           tpl=f'{{{{ value_json.v[{i}] }}}}', unit='V', dev_class='voltage',
           state_class='measurement', expire=120)
    sensor(f'mains_vmax_{ph.lower()}', f'Raw {ph} peak (10 s)', DEV_MAINS, MT,
           tpl=f'{{{{ value_json.vmax[{i}] }}}}', unit='V', dev_class='voltage',
           state_class='measurement', expire=120)
    sensor(f'mains_i_{ph.lower()}', f'Current {ph}', DEV_MAINS, MT,
           tpl=f'{{{{ value_json.i[{i}] }}}}', unit='A', dev_class='current',
           state_class='measurement', expire=120, enabled=False)
    sensor(f'mains_kw_{ph.lower()}', f'Power {ph}', DEV_MAINS, MT,
           tpl=f'{{{{ value_json.kw[{i}] }}}}', unit='kW', dev_class='power',
           state_class='measurement', expire=120, enabled=False)
sensor('mains_hz', 'Frequency', DEV_MAINS, MT, tpl='{{ value_json.hz }}', unit='Hz',
       dev_class='frequency', state_class='measurement', expire=120)
sensor('mains_overvoltage', 'Over-voltage', DEV_MAINS, MT,
       tpl=("{{ 'alarm' if 'alarm' in value_json.ov else "
            "('warn' if 'warn' in value_json.ov else 'ok') }}"),
       icon='mdi:flash-triangle', expire=120, attrs_topic=MT,
       attrs_tpl="{{ {'R': value_json.ov[0], 'Y': value_json.ov[1], 'B': value_json.ov[2]} | tojson }}")
sensor('mains_kw_total', 'Power total', DEV_MAINS, MT, tpl='{{ value_json.kw_total }}',
       unit='kW', dev_class='power', state_class='measurement', expire=120, enabled=False)
sensor('mains_kwh', 'Energy', DEV_MAINS, MT, tpl='{{ value_json.kwh }}', unit='kWh',
       dev_class='energy', state_class='total_increasing', enabled=False)
sensor('mains_pf', 'Power factor', DEV_MAINS, MT, tpl='{{ value_json.pf_total }}',
       dev_class='power_factor', state_class='measurement', expire=120, enabled=False)
sensor('mains_meter', 'Meter link', DEV_MAINS, 'shack/mains-monitor/status',
       tpl=("{% if value_json.event == 'heartbeat' %}{{ value_json.meter }}"
            "{% else %}{{ value_json.event }}{% endif %}"),
       icon='mdi:meter-electric', attrs_topic='shack/mains-monitor/status')
binary('mains_supply', 'Raw supply', DEV_MAINS, MT,
       tpl="{{ 'ON' if value_json.supply == 'ok' else 'OFF' }}", icon='mdi:transmission-tower',
       expire=120)
configs[-1][1]['device_class'] = 'power'

# ---------- WAN data usage vs the ISP caps ----------
# Retained shack/wan/wan1 + wan2, published hourly by wan-usage on the Mac (private
# vu2cpl/vlan-setup, scripts/wan-usage/) from the UDM's daily WAN totals. WAN1 3 TB per
# cycle 11th → 10th, WAN2 1 TB per cycle 26th → 25th, download + upload, decimal GB.
# expire_after 2 h = two missed hourly runs → unavailable (the dashboards' "stale" rule).
# The pct sensor carries the whole payload as attributes (cycle dates, limit, etc.).
# Added 2026-11-07.
DEV_WAN = {'identifiers': ['shack_wan'], 'name': 'WAN Data',
           'manufacturer': 'VU2CPL shack', 'model': 'UDM daily WAN totals (wan-usage)'}
for n in (1, 2):
    WT = f'shack/wan/wan{n}'
    sensor(f'wan{n}_used_pct', f'WAN{n} used', DEV_WAN, WT, tpl='{{ value_json.pct }}', unit='%',
           state_class='measurement', icon='mdi:gauge', expire=7200, attrs_topic=WT)
    for key, label, icon in (('used_gb', 'used GB', 'mdi:database'),
                             ('down_gb', 'download', 'mdi:download'),
                             ('up_gb', 'upload', 'mdi:upload'),
                             ('today_gb', 'today', 'mdi:calendar-today'),
                             ('projected_gb', 'projected', 'mdi:chart-line')):
        sensor(f'wan{n}_{key}', f'WAN{n} {label}', DEV_WAN, WT, tpl=f'{{{{ value_json.{key} }}}}',
               unit='GB', dev_class='data_size', state_class='measurement', icon=icon, expire=7200)
    sensor(f'wan{n}_days_left', f'WAN{n} days left', DEV_WAN, WT, tpl='{{ value_json.days_left }}',
           unit='d', dev_class='duration', state_class='measurement', expire=7200)
    sensor(f'wan{n}_budget_gb_day', f'WAN{n} keep under', DEV_WAN, WT,
           tpl='{{ value_json.budget_gb_day }}', unit='GB/d', state_class='measurement',
           icon='mdi:speedometer-slow', expire=7200)

if __name__ == '__main__':
    if '--dry' in sys.argv:
        for t, c in configs:
            print(t, '->', c['name'])
        print(len(configs), 'configs')
        sys.exit(0)
    for t, c in configs:
        mqtt_publish(t, c)
        print('published', t)
    print(f'done: {len(configs)} discovery configs published (retained)')
