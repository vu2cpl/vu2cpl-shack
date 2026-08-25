"""Publish MQTT-discovery configs for the shack sensors via HA's mqtt.publish service.

Creates HA entities for: AS3935 lightning sensor, GPS NTP chrony, RPi fleet
telemetry, UberSDR sessions. All configs are retained on homeassistant/# so
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
           state_class=None, icon=None, expire=None, attrs_topic=None, attrs_tpl=None):
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
       state_class='measurement', expire=180)
sensor('as3935_battery', 'Battery', DEV_AS3935, T + '/hb',
       tpl='{{ (value_json.vbat_mv / 1000) | round(2) }}', unit='V',
       dev_class='voltage', state_class='measurement', expire=180)
sensor('as3935_disturbers', 'Disturber count', DEV_AS3935, T + '/hb',
       tpl='{{ value_json.counters.disturber }}', state_class='total_increasing',
       icon='mdi:waveform', expire=180)
sensor('as3935_strikes', 'Lightning count', DEV_AS3935, T + '/hb',
       tpl='{{ value_json.counters.lightning }}', state_class='total_increasing',
       icon='mdi:lightning-bolt', expire=180)
sensor('as3935_last_event', 'Last event', DEV_AS3935, T + '/last_event',
       tpl='{{ value_json.event }}', icon='mdi:history',
       attrs_topic=T + '/last_event')
sensor('as3935_last_event_distance', 'Last event distance', DEV_AS3935, T + '/last_event',
       tpl='{{ value_json.distance }}', unit='km', icon='mdi:map-marker-distance')
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

# ---------- UberSDR ----------
DEV_UBER = {'identifiers': ['shack_ubersdr'], 'name': 'UberSDR',
            'manufacturer': 'VU2CPL shack', 'model': 'WebSDR receiver'}
UT = 'ubersdr/metrics/sessions'
sensor('ubersdr_listeners', 'Listeners', DEV_UBER, UT,
       tpl='{{ value_json.count - value_json.internal_sessions }}',
       state_class='measurement', icon='mdi:account-multiple', expire=300)
sensor('ubersdr_decoders', 'Internal decoders', DEV_UBER, UT,
       tpl='{{ value_json.internal_sessions }}', state_class='measurement',
       icon='mdi:radio-tower', expire=300)
sensor('ubersdr_sessions', 'Total sessions', DEV_UBER, UT,
       tpl='{{ value_json.count }}', state_class='measurement',
       icon='mdi:counter', expire=300)

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
