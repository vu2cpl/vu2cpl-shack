/* === VU2CPL Shack — Vue 3 app ===
   - Subscribes to uibuilder messages from Node-RED
   - Mounts the dashboard with the merged Lightning + AS3935 card as the first widget
   - All cards are collapsible. Default state per card.
   - Responsive via CSS Grid auto-fit (in index.css)
*/

const { createApp, ref, reactive, computed, onMounted } = Vue;

// --- Helper: relative time formatter ---
function relTime(epochMs) {
  if (!epochMs) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (sec < 60)    return sec + 's ago';
  if (sec < 3600)  return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

// === Lightning + AS3935 merged card ===
const LightningCard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>Lightning Protection</span>
        <span v-if="!expanded" class="summary">
          <span v-if="state.bypassActive" :style="{color:'var(--amber-fg)'}">🔕 BYPASS</span>
          <span v-if="state.bypassActive">·</span>
          <span :style="{color: state.antennaOn ? 'var(--green)' : 'var(--red)', fontWeight:700}">
            {{ state.antennaOn ? 'ANT ON' : 'ANT OFF' }}
          </span>
          <template v-if="state.closestKm != null">
            <span>·</span>
            <span :style="{color: closestKmColor, fontWeight:700}">{{ state.closestKm }}km</span>
          </template>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <!-- Bypass banner (only when bypass active) -->
        <div v-if="state.bypassActive" class="banner">
          <span class="ico">🔕</span>
          <span style="flex:1;">BYPASS ACTIVE — strikes alert &amp; log only, no auto-disconnect</span>
          <span>expires in {{ bypassRemain }}</span>
        </div>

        <!-- AS3935 rebooting banner -->
        <div v-if="rebooting" class="banner banner--blue">
          <span class="ico">⟳</span>
          <span style="flex:1;">AS3935 REBOOTING — bridge will be back online in a few seconds</span>
          <span>{{ rebootElapsed }}s</span>
        </div>

        <!-- Action buttons -->
        <div style="display:flex;gap:6px;">
          <button class="btn btn--green" style="flex:1;" @click="action('antennaOn')">ANTENNA ON</button>
          <button class="btn" :class="state.bypassActive ? 'btn--amber' : 'btn--ghost'"
                  style="flex:1;" @click="action('bypassToggle')">BYPASS {{ state.bypassActive ? 'ON' : 'OFF' }}</button>
        </div>

        <!-- AS3935 status line -->
        <div class="statusline">
          <span :style="{ color: state.as3935Status === 'ready' ? 'var(--green)' : 'var(--red)' }">●</span>
          <strong>AS3935</strong>
          <span>{{ state.as3935Status === 'ready' ? '✓ READY' : 'OFFLINE' }}</span>
          <span v-if="state.uptime">UP <strong>{{ state.uptime }}</strong></span>
          <span v-if="state.vbat != null">🔋 <strong>{{ (state.vbat/1000).toFixed(2) }}V</strong></span>
        </div>

        <!-- AS3935 counters row -->
        <div class="statusline">
          <span>⚡ Lightning <strong style="color:var(--blue)">{{ state.counters?.lightning ?? '—' }}</strong></span>
          <span>⚠ Disturber <strong style="color:var(--amber)">{{ state.counters?.disturber ?? '—' }}</strong></span>
          <span>📡 Noise <strong>{{ state.counters?.noise ?? '—' }}</strong></span>
          <span>IRQ <strong>{{ state.counters?.irq ?? '—' }}</strong></span>
        </div>

        <!-- Stats grid -->
        <dl class="stats">
          <dt>Callsign</dt>             <dd>{{ state.callsign || 'VU2CPL' }}</dd>
          <dt>Grid</dt>                 <dd>{{ state.grid || 'MK83TE' }}</dd>
          <dt>Threshold</dt>            <dd>{{ state.thresholdKm ?? '—' }} km</dd>
          <dt>Reconnect</dt>            <dd>{{ state.reconnectMin ?? '—' }} min</dd>
          <dt>Total strikes</dt>        <dd>{{ state.totalStrikes ?? 0 }}</dd>
          <dt>&lt;40 / &lt;50 / &gt;50</dt> <dd>{{ state.lt40 ?? 0 }} / {{ state.lt50 ?? 0 }} / {{ state.gt50 ?? 0 }}</dd>
          <dt>Closest</dt>              <dd>{{ state.closestKm != null ? state.closestKm + ' km' : '—' }}</dd>
          <dt>Antenna</dt>              <dd :style="{color: state.antennaOn ? 'var(--green)' : 'var(--red)'}">{{ state.antennaOn ? 'ON' : 'OFF' }}</dd>
        </dl>

        <!-- AS3935 live tiles -->
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">Distance</div>
            <div class="tile__val">{{ state.as3935Distance ?? '—' }}<span style="font-size:var(--fs-xs);color:var(--muted)"> km</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Energy</div>
            <div class="tile__val" style="color:var(--amber)">{{ state.as3935Energy ?? '—' }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Event</div>
            <div class="tile__val">{{ as3935EventIcon }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Last seen</div>
            <div class="tile__val" style="font-size:var(--fs-sm);color:var(--muted)">{{ lastSeen }}</div>
          </div>
        </div>

        <!-- CAPE (compact) -->
        <div class="statusline">
          <span>CAPE</span>
          <strong :style="{color: capeColor}">{{ state.cape != null ? state.cape + ' J/kg' : '—' }}</strong>
          <span v-if="state.omState" style="color:var(--muted)">· OM state: {{ state.omState }}</span>
        </div>

        <!-- Collapsible: Thresholds -->
        <div class="section">
          <div class="section__header" @click="sec.thresholds = !sec.thresholds">
            <span class="chev">{{ sec.thresholds ? '▼' : '▶' }}</span>
            <span>Thresholds</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.thresholds }">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <label style="font-size:var(--fs-sm);">
                Disconnect: <strong style="color:var(--accent)">{{ state.thresholdKm ?? 40 }} km</strong>
                <input type="range" min="10" max="80" :value="state.thresholdKm ?? 40"
                       @change="action('setThreshold', $event.target.valueAsNumber)" style="width:100%">
              </label>
              <label style="font-size:var(--fs-sm);">
                Reconnect: <strong style="color:var(--accent)">{{ state.reconnectMin ?? 20 }} min</strong>
                <input type="range" min="5" max="60" :value="state.reconnectMin ?? 20"
                       @change="action('setReconnect', $event.target.valueAsNumber)" style="width:100%">
              </label>
            </div>
          </div>
        </div>

        <!-- Collapsible: AS3935 Tunables (touch-friendly steppers + pill toggles) -->
        <div class="section">
          <div class="section__header" @click="sec.tunables = !sec.tunables">
            <span class="chev">{{ sec.tunables ? '▼' : '▶' }}</span>
            <span>AS3935 Tunables</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.tunables }">

            <!-- 4 rows: numeric (left) + paired enum (right). Click a label to reveal help. -->
            <div v-for="(row, i) in tunableRows" :key="i">
              <div class="tun-row">
                <span class="tun-lbl" @click="toggleHelp('num-'+i)">{{ row.num.lbl }} <span class="help-mark">?</span></span>
                <span class="tun-range">{{ row.num.min }}–{{ row.num.max }}</span>
                <button class="tun-step" :disabled="(state.tunables?.[row.num.key] ?? row.num.min) <= row.num.min"
                        @click="step(row.num.key, -1, row.num.min, row.num.max)">−</button>
                <span class="tun-val">{{ state.tunables?.[row.num.key] ?? '—' }}</span>
                <button class="tun-step" :disabled="(state.tunables?.[row.num.key] ?? row.num.max) >= row.num.max"
                        @click="step(row.num.key, +1, row.num.min, row.num.max)">+</button>

                <!-- Paired enum on the right -->
                <span class="tun-enum-lbl" @click="toggleHelp('enum-'+i)">{{ row.enum.lbl }} <span class="help-mark">?</span></span>
                <button v-for="opt in row.enum.options" :key="String(opt.v)"
                        class="pill"
                        :class="{ 'pill--active': String(state.tunables?.[row.enum.key]) === String(opt.v) }"
                        @click="action('setTunable', opt.v, row.enum.key)">
                  {{ opt.label }}
                </button>
              </div>
              <!-- Help text rows (revealed on label click) -->
              <div v-if="activeHelp === 'num-'+i"  class="tun-help">{{ row.num.tip }}</div>
              <div v-if="activeHelp === 'enum-'+i" class="tun-help">{{ row.enum.tip }}</div>
            </div>

            <div style="font-size:var(--fs-xs);color:var(--muted);margin-top:4px;">
              Tap a value to apply. Bridge republishes status after each change.
            </div>
          </div>
        </div>

        <!-- Collapsible: Maintenance (with confirms + countdown) -->
        <div class="section">
          <div class="section__header" @click="sec.maint = !sec.maint">
            <span class="chev">{{ sec.maint ? '▼' : '▶' }}</span>
            <span>AS3935 Maintenance</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.maint }">
            <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px;">
              <button class="btn btn--blue"  @click="doRepublish()">{{ ackLabel('republish', 'Republish') }}</button>
              <button class="btn btn--amber" :disabled="calibCountdown > 0"
                      @click="doCalibrate()">{{ calibCountdown > 0 ? calibCountdown + 's' : ackLabel('calib', 'Calibrate') }}</button>
              <button class="btn btn--green" @click="doQueryBattery()">{{ ackLabel('battery', 'Battery') }}</button>
              <button class="btn btn--amber" @click="doReboot()">Reboot</button>
              <button class="btn btn--red"   @click="doFactoryReset()">Factory Reset</button>
            </div>
          </div>
        </div>

        <!-- Collapsible: Test Injects -->
        <div class="section">
          <div class="section__header" @click="sec.test = !sec.test">
            <span class="chev">{{ sec.test ? '▼' : '▶' }}</span>
            <span>Test Injects (bench only)</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.test }">
            <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px;">
              <button class="btn btn--red"   @click="testInject('near')">{{ ackLabel('test-near', '⚡ Near') }}</button>
              <button class="btn btn--amber" @click="testInject('far')">{{ ackLabel('test-far', '⚡ Far') }}</button>
              <button class="btn btn--green" @click="testInject('oor')">{{ ackLabel('test-oor', '⚡ OOR') }}</button>
              <button class="btn btn--blue"  @click="testInject('disturber')">{{ ackLabel('test-disturber', '⚠ Dist') }}</button>
              <button class="btn btn--blue"  @click="testInject('noise')">{{ ackLabel('test-noise', '📡 Noise') }}</button>
            </div>
          </div>
        </div>

        <!-- Event log -->
        <div style="font-size:var(--fs-xs);color:var(--muted);text-transform:uppercase;letter-spacing:0.3px;margin-top:4px;">
          Event Log · times IST
        </div>
        <div style="font-family:var(--font-mono);font-size:var(--fs-xs);line-height:1.5;max-height:120px;overflow-y:auto;color:var(--muted);">
          <div v-for="(ev, i) in state.eventLog" :key="i" v-html="ev"></div>
          <div v-if="!state.eventLog || state.eventLog.length === 0" style="font-style:italic;">No events yet</div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const sec = reactive({
      thresholds: false,
      tunables:   false,
      maint:      false,
      test:       false
    });
    const state = reactive({
      bypassActive: false,
      bypassExpiresAt: null,
      callsign: 'VU2CPL',
      grid: 'MK83TE',
      thresholdKm: 40,
      reconnectMin: 20,
      totalStrikes: 0,
      lt40: 0, lt50: 0, gt50: 0,
      closestKm: null,
      antennaOn: true,
      as3935Status: null,
      as3935Distance: null,
      as3935Energy: null,
      as3935Event: null,
      as3935LastTs: null,
      nf: null, uptime: null, irq: null, vbat: null,
      cape: null, omState: null,
      tunables: {},
      eventLog: []
    });

    // Refresh relative-time labels every 30s
    const tick = ref(0);
    setInterval(() => { tick.value++; }, 30_000);

    const bypassRemain = computed(() => {
      tick.value;
      if (!state.bypassExpiresAt) return '—';
      const rem = Math.max(0, state.bypassExpiresAt - Date.now());
      const mm = String(Math.floor(rem / 60_000)).padStart(2, '0');
      const ss = String(Math.floor((rem % 60_000) / 1000)).padStart(2, '0');
      return mm + ':' + ss;
    });
    const lastSeen = computed(() => { tick.value; return relTime(state.as3935LastTs); });
    const as3935EventIcon = computed(() => {
      switch (state.as3935Event) {
        case 'lightning': return '⚡';
        case 'disturber': return '⚠';
        case 'noise':     return '📡';
        default:          return '—';
      }
    });
    const capeColor = computed(() => {
      if (state.cape == null) return 'var(--muted)';
      if (state.cape >= 2500) return 'var(--red)';
      if (state.cape >= 800)  return 'var(--amber)';
      return 'var(--green)';
    });
    // Colour of the "closest strike" pill in the collapsed summary
    const closestKmColor = computed(() => {
      const km = state.closestKm;
      if (km == null) return 'var(--muted)';
      if (km < 10)  return 'var(--red)';     // close — would auto-disconnect
      if (km < 25)  return 'var(--amber)';   // medium
      return 'var(--green)';                 // far — informational
    });

    // Receive messages from Node-RED via uibuilder
    onMounted(() => {
      // Card-specific channel: topic === 'lightning'
      uibuilder.onTopic('lightning', (msg) => {
        console.log('[shack] lightning msg received:', msg);
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
        }
      });
      // Catch-all debug: log every uibuilder msg so we can see what arrives
      uibuilder.onChange('msg', (msg) => {
        console.log('[shack] msg(any topic):', msg && msg.topic, msg);
      });
    });

    // List of numeric tunables (rendered as −/+ steppers)
    const numericTunables = [
      { key: 'nf',      lbl: 'Noise',     tip: 'Noise Floor (NF) — threshold below which the chip ignores noise. Range 0–7.', min: 0, max:  7 },
      { key: 'wdth',    lbl: 'Watchdog',  tip: 'Watchdog Threshold (WDTH) — filters out very brief spikes. Range 0–15.',     min: 0, max: 15 },
      { key: 'srej',    lbl: 'Spike Rej', tip: 'Spike Rejection (SREJ) — pattern-match strictness vs lightning waveform. Range 0–15.', min: 0, max: 15 },
      { key: 'tun_cap', lbl: 'Tune Cap',  tip: 'Antenna LC tuning capacitor (TUN_CAP) — adjusts antenna resonance toward 500 kHz. Range 0–15.', min: 0, max: 15 }
    ];

    // List of enum-ish tunables (rendered as pill toggle groups, inline)
    const enumTunables = [
      { key: 'afe_gb', lbl: 'Gain', tip: 'Analog Front-End gain (AFE_GB). Indoor = high gain (weak signals), Outdoor = low gain (strong signals).', options: [
        { v: 'indoor',  label: 'IN'  },
        { v: 'outdoor', label: 'OUT' }
      ]},
      { key: 'modem_sleep', lbl: 'Sleep', tip: 'WiFi modem sleep mode. None = always-on (most responsive, highest power). Min/Max = power saving.', options: [
        { v: 'none', label: 'NONE' },
        { v: 'min',  label: 'MIN'  },
        { v: 'max',  label: 'MAX'  }
      ]},
      { key: 'mask_dist', lbl: 'Mask Dist', tip: 'Mask disturbers — when ON, the chip ignores non-lightning events that look similar (reduces false alerts).', options: [
        { v: false, label: 'OFF' },
        { v: true,  label: 'ON'  }
      ]},
      { key: 'min_num_lightning', lbl: 'Min Strikes', tip: 'Min lightning strikes before triggering. 1 = report any single strike. Higher = more reliable but slower.', options: [
        { v: 1,  label: '1'  },
        { v: 5,  label: '5'  },
        { v: 9,  label: '9'  },
        { v: 16, label: '16' }
      ]}
    ];

    // Click-to-reveal help text per label (toggles which row's help is shown)
    const activeHelp = ref(null);
    function toggleHelp(id) {
      activeHelp.value = activeHelp.value === id ? null : id;
    }

    // Pair each numeric with its enum so they share a row
    const tunableRows = [
      { num: numericTunables[0], enum: enumTunables[0] }, // NF      ↔ AFE
      { num: numericTunables[1], enum: enumTunables[1] }, // WDTH    ↔ SLP
      { num: numericTunables[2], enum: enumTunables[2] }, // SREJ    ↔ MASK
      { num: numericTunables[3], enum: enumTunables[3] }  // TUN_CAP ↔ MIN
    ];

    // Stepper for numeric tunables — clamps and sends in one click
    function step(key, dir, min, max) {
      const cur = state.tunables?.[key];
      if (cur == null) return;
      const next = Math.max(min, Math.min(max, cur + dir));
      if (next === cur) return;
      action('setTunable', next, key);
    }

    // === Maintenance / test action helpers with feedback ===
    // Brief acks shown on the button label after a click so the user knows
    // the click registered (since the bridge reply may take a few seconds).
    const acks = reactive({});
    function showAck(id, text, ms = 1800) {
      acks[id] = text;
      setTimeout(() => { delete acks[id]; }, ms);
    }
    function ackLabel(id, base) { return acks[id] || base; }

    // Calibrate runs ~30s on the bridge; mirror it with a visible countdown
    const calibCountdown = ref(0);
    function doRepublish() {
      action('as3935Republish');
      showAck('republish', '✓ Sent');
    }
    function doQueryBattery() {
      action('as3935QueryBattery');
      showAck('battery', '✓ Sent');
    }
    function doCalibrate() {
      if (!confirm('Calibrate the AS3935 TUN_CAP? This takes ~30s and the chip is unavailable during it.')) return;
      action('as3935Calibrate');
      calibCountdown.value = 30;
      const tickId = setInterval(() => {
        calibCountdown.value--;
        if (calibCountdown.value <= 0) clearInterval(tickId);
      }, 1000);
    }
    // Rebooting banner state — tracks the reboot lifecycle for visual feedback
    const rebooting = ref(false);
    const rebootElapsed = ref(0);
    let rebootTimer = null;

    function startRebootBanner() {
      rebooting.value = true;
      rebootElapsed.value = 0;
      if (rebootTimer) clearInterval(rebootTimer);
      rebootTimer = setInterval(() => {
        rebootElapsed.value++;
        // Auto-clear: when status flips back to ready AND uptime > 0, or safety timeout 45s
        if ((state.as3935Status === 'ready' && state.uptime != null) || rebootElapsed.value > 45) {
          clearInterval(rebootTimer); rebootTimer = null;
          rebooting.value = false;
        }
      }, 1000);
    }

    function doReboot() {
      if (!confirm('Reboot the AS3935 ESP32 bridge?\n\nIt will be offline for ~10–20 seconds.')) return;
      action('as3935Reboot');
      // Optimistic: blank the live fields so the UI doesn't keep showing pre-reboot stats
      state.as3935Status = 'offline';
      state.uptime = null;
      state.counters = null;
      state.vbat = null;
      state.nf = null;
      state.irq = null;
      startRebootBanner();
    }
    function doFactoryReset() {
      if (!confirm('FACTORY RESET WiFi credentials?\n\nThe bridge will lose its WiFi config and require captive-portal re-onboarding. This cannot be undone.')) return;
      if (!confirm('Are you absolutely sure? Type-confirm via this second dialog.')) return;
      action('as3935FactoryReset');
    }

    // Test-inject helpers with visual ack
    function testInject(kind) {
      action('testStrike', kind);
      showAck('test-' + kind, '✓');
    }

    // Operational actions use the same HTTP endpoints D1 uses (proven path).
    // AS3935 maintenance + test injects go via uibuilder → cmd_router.
    // setTunable takes a 3rd `key` argument naming the AS3935 register to change.
    function action(type, value, key) {
      // --- HTTP-direct (operational) ---
      if (type === 'antennaOn') {
        return fetch('/lightning/ant-on', { method: 'POST' }).catch(e => console.warn(e));
      }
      if (type === 'bypassToggle') {
        const next = state.bypassActive ? 'off' : 'on';
        return fetch('/lightning/bypass', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: next })
        }).catch(e => console.warn(e));
      }
      if (type === 'setThreshold') {
        return fetch('/lightning/threshold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value })
        }).catch(e => console.warn(e));
      }
      if (type === 'setReconnect') {
        return fetch('/lightning/reconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value })
        }).catch(e => console.warn(e));
      }
      // --- uibuilder (AS3935 maintenance + tests + tunables) ---
      // Optimistic update for setTunable — show the new value instantly so the
      // user gets immediate feedback. The real bridge status (1–3s later)
      // overwrites this with the confirmed value.
      if (type === 'setTunable' && key && state.tunables) {
        state.tunables[key] = value;
      }
      uibuilder.send({ topic: 'lightning/cmd', payload: { type, value, key } });
    }

    return {
      expanded, sec, state, bypassRemain, lastSeen, as3935EventIcon, capeColor, closestKmColor, action,
      numericTunables, enumTunables, tunableRows, step,
      activeHelp, toggleHelp,
      ackLabel, calibCountdown,
      rebooting, rebootElapsed,
      doRepublish, doCalibrate, doQueryBattery, doReboot, doFactoryReset, testInject
    };
  }
};

// === DXCC Tracker card ===
const DXCCCard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>DXCC Tracker</span>
        <span v-if="!expanded" class="summary">
          <span :style="{color: state.newAlerts > 0 ? 'var(--accent)' : 'var(--muted)', fontWeight:700}">
            ⚡ {{ state.newAlerts ?? 0 }} new
          </span>
          <span>·</span>
          <span :style="{color: allClustersOk ? 'var(--green)' : 'var(--amber)', fontWeight:700}">
            {{ clustersOnline }}/{{ clusterNames.length }} clusters
          </span>
          <span>·</span>
          <span :style="{fontWeight:700}">{{ state.stats?.totalWorked ?? '—' }} worked</span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <!-- Cluster pills — clickable to mute/unmute spots from each -->
        <div class="cluster-row">
          <button v-for="c in clusterNames" :key="c"
                  class="cluster-pill"
                  :class="clusterPillClass(c)"
                  :title="clusterTitle(c)"
                  @click="toggleCluster(c)">
            <span class="dot"></span>
            <span class="cluster-pill__name">{{ c }}</span>
          </button>
        </div>

        <!-- Stats line -->
        <div class="statusline">
          <span>Worked <strong style="color:var(--accent)">{{ state.stats?.totalWorked ?? '—' }}</strong></span>
          <span>Confirmed <strong style="color:var(--green)">{{ state.stats?.totalConfirmed ?? '—' }}</strong></span>
          <span>Seed <strong>{{ state.stats?.seedAge ?? '—' }}</strong></span>
        </div>

        <!-- Alerts table (always visible — main content) -->
        <div class="dxcc-alerts">
          <div class="dxcc-alerts__title">
            ALERTS · {{ state.alertList?.length ?? 0 }}
          </div>
          <div class="dxcc-alerts__list" v-if="(state.alertList?.length ?? 0) > 0">
            <div v-for="(a, i) in (state.alertList || []).slice(0, 30)" :key="i"
                 class="dxcc-alert"
                 :class="'dxcc-alert--' + alertSeverityClass(a.type)">
              <span class="dxcc-alert__time">{{ a.time || '--:--' }}</span>
              <span class="dxcc-alert__freq">{{ a.freq ?? '—' }}</span>
              <span class="dxcc-alert__mode">{{ a.mode || '—' }}</span>
              <span class="dxcc-alert__call">{{ a.call || '?' }}</span>
              <span class="dxcc-alert__entity">{{ a.entity || '' }}</span>
              <span class="dxcc-alert__type" :style="{color: alertTypeColor(a.type)}">{{ alertTypeShort(a.type) }}</span>
            </div>
          </div>
          <div v-else class="dxcc-alerts__empty">No alerts yet</div>
        </div>

        <!-- Settings (collapsible, default closed) -->
        <div class="section">
          <div class="section__header" @click="sec.settings = !sec.settings">
            <span class="chev">{{ sec.settings ? '▼' : '▶' }}</span>
            <span>Settings</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.settings }">
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:3px;">
              <button class="btn btn--blue"  @click="doRefresh()">{{ ackLabel('dxcc-refresh', 'Refresh Club Log') }}</button>
              <button class="btn btn--amber" @click="doClear()">{{ ackLabel('dxcc-clear', 'Clear Alerts') }}</button>
              <button class="btn btn--ghost" @click="sec.blacklist = !sec.blacklist">
                Blacklist ({{ (state.blacklist || []).length }})
              </button>
            </div>

            <div v-if="sec.blacklist" style="background:var(--bg);border:1px solid var(--border-2);border-radius:4px;padding:6px;">
              <div style="font-size:var(--fs-xs);color:var(--muted);margin-bottom:4px;">BLACKLIST · click × to remove</div>
              <div style="display:flex;flex-wrap:wrap;gap:3px;">
                <span v-for="cs in (state.blacklist || [])" :key="cs" class="pill" style="cursor:default;">
                  {{ cs }}
                  <span style="margin-left:4px;cursor:pointer;color:var(--red);font-weight:bold;"
                        @click="doBlacklistRemove(cs)">×</span>
                </span>
                <span v-if="!(state.blacklist || []).length" style="color:var(--muted);font-size:var(--fs-xs);">empty</span>
              </div>
              <div style="display:flex;gap:4px;margin-top:6px;">
                <input v-model="newBlacklistCall" type="text" placeholder="callsign"
                       style="flex:1;padding:3px 6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px;font-family:var(--font-mono);font-size:var(--fs-sm);"
                       @keydown.enter="doBlacklistAdd()" />
                <button class="btn btn--red" @click="doBlacklistAdd()">Add</button>
              </div>
            </div>

            <!-- Alert type filters -->
            <div class="filter-row">
              <span class="filter-row__lbl">ALERTS</span>
              <button v-for="t in alertTypes" :key="t.k" class="pill"
                      :class="{ 'pill--active': state.filters?.types?.[t.k] }"
                      @click="toggleFilter('types', t.k)">{{ t.lbl }}</button>
            </div>

            <!-- Mode filters -->
            <div class="filter-row">
              <span class="filter-row__lbl">MODES</span>
              <button v-for="m in modeKeys" :key="m.k" class="pill"
                      :class="{ 'pill--active': state.filters?.modes?.[m.k] }"
                      @click="toggleFilter('modes', m.k)">{{ m.lbl }}</button>
            </div>

            <!-- Band filters -->
            <div class="filter-row">
              <span class="filter-row__lbl">BANDS</span>
              <button v-for="b in bandKeys" :key="b" class="pill"
                      :class="{ 'pill--active': isBandOn(b) }"
                      @click="toggleBand(b)">{{ b }}</button>
            </div>

            <!-- Spot TTL stepper -->
            <div class="filter-row">
              <span class="filter-row__lbl">TTL</span>
              <button class="tun-step" :disabled="(state.filters?.ttl ?? 20) <= 1"
                      @click="bumpTtl(-5)">−</button>
              <span class="tun-val">{{ state.filters?.ttl ?? 20 }}<span style="font-size:var(--fs-xs);color:var(--muted);margin-left:3px;">min</span></span>
              <button class="tun-step" :disabled="(state.filters?.ttl ?? 20) >= 240"
                      @click="bumpTtl(+5)">+</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const sec = reactive({ settings: false, blacklist: false });
    const state = reactive({
      newAlerts: 0,
      stats: {},
      clusterStatus: {},
      muted: {},
      alertList: [],
      blacklist: [],
      filters: { types:{}, modes:{}, bands:{}, ttl: 20 }
    });

    const alertTypes = [
      { k:'dxcc',       lbl:'DXCC' },
      { k:'band',       lbl:'BAND' },
      { k:'bandUnconf', lbl:'?BAND' },
      { k:'mode',       lbl:'MODE' },
      { k:'modeUnconf', lbl:'?MODE' }
    ];
    const modeKeys = [
      { k:'cw',    lbl:'CW' },
      { k:'phone', lbl:'Phone' },
      { k:'data',  lbl:'Data' }
    ];
    const bandKeys = ['160M','80M','60M','40M','30M','20M','17M','15M','12M','10M','6M'];
    const bandKeyMap = {  // band label → backend key ("b160" etc.)
      '160M':'b160','80M':'b80','60M':'b60','40M':'b40','30M':'b30','20M':'b20',
      '17M':'b17','15M':'b15','12M':'b12','10M':'b10','6M':'b6','2M':'b2'
    };

    function isBandOn(band) {
      return !!(state.filters?.bands && state.filters.bands[band]);
    }

    function buildFilterBody() {
      // Convert state.filters into the shape /dxcc/filters expects: { b, t, m, ttl }
      const b = {};
      bandKeys.forEach(bk => {
        if (state.filters?.bands?.[bk]) b[bandKeyMap[bk]] = true;
      });
      return {
        b,
        t: { ...state.filters.types },
        m: { ...state.filters.modes },
        ttl: state.filters.ttl || 20
      };
    }
    function postFilters() {
      fetch('/dxcc/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFilterBody())
      }).catch(e => console.warn(e));
    }
    function toggleFilter(group, key) {
      if (!state.filters[group]) state.filters[group] = {};
      state.filters[group][key] = !state.filters[group][key];
      postFilters();
    }
    function toggleBand(band) {
      if (!state.filters.bands) state.filters.bands = {};
      state.filters.bands[band] = !state.filters.bands[band];
      postFilters();
    }
    function bumpTtl(d) {
      const cur = state.filters?.ttl ?? 20;
      const next = Math.max(1, Math.min(240, cur + d));
      if (next === cur) return;
      state.filters.ttl = next;
      postFilters();
    }

    const clusterNames = ['VU2CPL', 'VU2OY', 'VE7CC', 'N2WQ'];

    const allClustersOk = computed(() =>
      clusterNames.every(c => (state.clusterStatus?.[c]?.connected) && !state.muted?.[c])
    );
    const clustersOnline = computed(() =>
      clusterNames.filter(c => state.clusterStatus?.[c]?.connected && !state.muted?.[c]).length
    );

    function clusterPillClass(name) {
      if (state.muted?.[name]) return 'cluster-pill--muted';
      const s = state.clusterStatus?.[name];
      if (s && s.connected) return 'cluster-pill--ok';
      return 'cluster-pill--off';
    }
    function clusterTitle(name) {
      const s = state.clusterStatus?.[name] || {};
      const muted = state.muted?.[name];
      return `${name} · ${muted ? 'MUTED' : (s.connected ? 'connected' : 'disconnected')}` +
             (s.lastSpot ? ` · last spot ${s.lastSpot}` : '');
    }
    function toggleCluster(name) {
      const next = !state.muted?.[name];
      if (!state.muted) state.muted = {};
      state.muted[name] = next;   // optimistic
      uibuilder.send({ topic: 'dxcc/cmd', payload: { type: 'muteCluster', value: next, key: name } });
    }

    // Alerts colouring
    function alertTypeShort(t) {
      return ({ NEW_DXCC: 'NEW!', NEW_BAND: 'NEW BAND', NEW_MODE: 'NEW MODE',
               NEW_BAND_UNCONF: '? BAND', NEW_MODE_UNCONF: '? MODE',
               NEED_QSL: 'NEED QSL' })[t] || t || '';
    }
    function alertTypeColor(t) {
      return ({ NEW_DXCC: 'var(--red)', NEW_BAND: 'var(--accent)',
               NEW_BAND_UNCONF: 'var(--accent)', NEW_MODE: 'var(--amber)',
               NEW_MODE_UNCONF: 'var(--amber)', NEED_QSL: '#bc8cff' })[t] || 'var(--muted)';
    }
    function alertSeverityClass(t) {
      if (t === 'NEW_DXCC') return 'red';
      if (t === 'NEW_BAND' || t === 'NEW_BAND_UNCONF') return 'blue';
      if (t === 'NEW_MODE' || t === 'NEW_MODE_UNCONF') return 'amber';
      return 'ghost';
    }

    // Actions (HTTP via existing endpoints)
    const acks = reactive({});
    function showAck(id, text, ms = 1500) {
      acks[id] = text;
      setTimeout(() => { delete acks[id]; }, ms);
    }
    function ackLabel(id, base) { return acks[id] || base; }

    function doRefresh() {
      fetch('/dxcc/refresh', { method: 'POST' }).catch(e => console.warn(e));
      showAck('dxcc-refresh', '✓ Sent');
    }
    function doClear() {
      if (!confirm('Clear the alerts list?')) return;
      fetch('/dxcc/clear', { method: 'POST' }).catch(e => console.warn(e));
      showAck('dxcc-clear', '✓ Cleared');
      state.alertList = [];   // optimistic
    }
    const newBlacklistCall = ref('');
    function doBlacklistAdd() {
      const cs = (newBlacklistCall.value || '').trim().toUpperCase();
      if (!cs) return;
      fetch('/dxcc/blacklist-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call: cs })
      }).catch(e => console.warn(e));
      if (!state.blacklist) state.blacklist = [];
      if (!state.blacklist.includes(cs)) state.blacklist.push(cs);
      newBlacklistCall.value = '';
    }
    function doBlacklistRemove(cs) {
      fetch('/dxcc/blacklist-remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call: cs })
      }).catch(e => console.warn(e));
      state.blacklist = (state.blacklist || []).filter(x => x !== cs);
    }

    onMounted(() => {
      uibuilder.onTopic('dxcc', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
        }
      });
    });

    return {
      expanded, sec, state,
      clusterNames, allClustersOk, clustersOnline,
      clusterPillClass, clusterTitle, toggleCluster,
      alertTypeShort, alertTypeColor, alertSeverityClass,
      ackLabel, doRefresh, doClear,
      newBlacklistCall, doBlacklistAdd, doBlacklistRemove,
      alertTypes, modeKeys, bandKeys,
      isBandOn, toggleFilter, toggleBand, bumpTtl
    };
  }
};

// === Solar Conditions card ===
const SolarCard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>Solar Conditions</span>
        <span v-if="!expanded" class="summary">
          <span :style="{color: gColor({k:'sfi',v:state.sfi}), fontWeight:600}">SFI {{ state.sfi ?? '—' }}</span>
          <span>·</span>
          <span :style="{color: gColor({k:'k',v:state.k}), fontWeight:600}">K {{ state.k != null ? Number(state.k).toFixed(1) : '—' }}</span>
          <span v-if="state.muf != null">·</span>
          <span v-if="state.muf != null" :style="{color:'var(--accent)', fontWeight:600}">MUF {{ state.muf }}</span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <!-- Mini gauges -->
        <div class="solar-gauges">
          <div v-for="g in gauges" :key="g.k" class="solar-gauge">
            <div class="solar-gauge__lbl">{{ g.title }}</div>
            <svg viewBox="0 0 80 44" width="100%" style="display:block;">
              <path d="M8 40 A32 32 0 0 1 72 40" fill="none" stroke="var(--border)" stroke-width="5" stroke-linecap="round"/>
              <path d="M8 40 A32 32 0 0 1 72 40" fill="none" :stroke="gColor(g)" stroke-width="5" stroke-linecap="round"
                    stroke-dasharray="101" :stroke-dashoffset="(101*(1-pct(g))).toFixed(1)"/>
              <text x="40" y="36" text-anchor="middle" :fill="gColor(g)" font-size="15" font-weight="700"
                    font-family="JetBrains Mono,SFMono-Regular,monospace">{{ display(g) }}</text>
            </svg>
            <div class="solar-gauge__sub">{{ g.lbl || '—' }}</div>
          </div>
        </div>

        <!-- Space Weather (R/S/G) -->
        <div class="solar-sec-label">Space Weather (R/S/G)</div>
        <div class="solar-rsg-row">
          <div v-for="s in scales" :key="s.key" class="solar-rsg">
            <div class="solar-rsg__lbl">{{ s.lbl }}</div>
            <div class="solar-rsg__values">
              <span v-for="c in ['R','S','G']" :key="c" :style="rsgStyle(scaleVal(s.key, c))">{{ c }}{{ scaleVal(s.key, c) ?? '—' }}</span>
            </div>
          </div>
        </div>

        <!-- MUF / foF2 / X-ray -->
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">MUF</div>
            <div class="tile__val">{{ state.muf ?? '—' }}<span class="tile__sub-unit">MHz</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">foF2</div>
            <div class="tile__val">{{ state.fof2 ?? '—' }}<span class="tile__sub-unit">MHz</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">X-ray now / 24h</div>
            <div class="tile__val">{{ state.xnow ?? '—' }} / {{ state.x24 ?? '—' }}</div>
          </div>
        </div>

        <!-- HF Band Conditions -->
        <div class="solar-sec-label">HF Bands · SFI − K Penalty</div>
        <div class="bands-list">
          <div v-for="b in bands" :key="b.name" class="band-row">
            <span class="band-row__name">{{ b.name }}</span>
            <div class="band-row__bar">
              <div :style="{height:'100%', width: b.score + '%', background: b.color, transition:'width 0.4s'}"></div>
            </div>
            <span class="band-row__lbl" :style="{color: b.color}">{{ b.label }}</span>
          </div>
          <div class="solar-bands-legend">≥80 Excellent · ≥60 Good · ≥40 Fair · ≥20 Poor · &lt;20 Bad</div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const state = reactive({
      sfi:null, sfiLbl:null, k:null, kLbl:null, a:null, aLbl:null,
      muf:null, fof2:null, xnow:null, x24:null, rsg:{}
    });

    const gauges = computed(() => [
      { k:'sfi', title:'SFI',     v: state.sfi, lbl: state.sfiLbl, min: 50, max: 250 },
      { k:'k',   title:'K-Index', v: state.k,   lbl: state.kLbl,   min:  0, max:   9 },
      { k:'a',   title:'A-Index', v: state.a,   lbl: state.aLbl,   min:  0, max: 100 }
    ]);
    const scales = [
      { key:'h24',  lbl:'24h' }, { key:'cur', lbl:'Now' }, { key:'pred', lbl:'Pred' }
    ];

    function display(g) { if (g.v == null) return '—'; return g.k === 'k' ? Number(g.v).toFixed(1) : String(g.v); }
    function pct(g) { if (g.v == null) return 0; return Math.max(0, Math.min(1, (g.v - g.min) / (g.max - g.min))); }
    function gColor(g) {
      if (g.v == null) return 'var(--muted)';
      if (g.k === 'sfi') return g.v >= 130 ? 'var(--green)' : g.v >= 90 ? 'var(--amber)' : 'var(--red)';
      if (g.k === 'k')   return g.v < 4.5  ? 'var(--green)' : g.v < 6    ? 'var(--amber)' : 'var(--red)';
      return g.v < 36 ? 'var(--green)' : g.v < 103 ? 'var(--amber)' : 'var(--red)';
    }
    function scaleVal(k, c) { return state.rsg?.[k]?.[c]; }
    function rsgStyle(v) {
      let color = 'var(--green)';
      if (v != null && v > 0) color = v <= 2 ? 'var(--amber)' : 'var(--red)';
      return {
        color, fontWeight:600, fontFamily:'var(--font-mono)',
        background: 'var(--bg)', border: '1px solid currentColor',
        borderRadius:'4px', padding:'2px 6px', fontSize:'var(--fs-sm)'
      };
    }

    // Band conditions formula (matches Node-RED builder so colours/labels are identical)
    const BANDS = [
      {name:'6M',   minSFI:200, maxSFI:300, kW:0.20},
      {name:'10M',  minSFI:130, maxSFI:280, kW:0.25},
      {name:'12M',  minSFI:115, maxSFI:270, kW:0.30},
      {name:'15M',  minSFI:100, maxSFI:260, kW:0.35},
      {name:'17M',  minSFI:90,  maxSFI:250, kW:0.40},
      {name:'20M',  minSFI:70,  maxSFI:240, kW:0.45},
      {name:'30M',  minSFI:65,  maxSFI:230, kW:0.55},
      {name:'40M',  minSFI:60,  maxSFI:220, kW:0.65},
      {name:'60M',  minSFI:60,  maxSFI:210, kW:0.70},
      {name:'80M',  minSFI:55,  maxSFI:200, kW:0.80},
      {name:'160M', minSFI:50,  maxSFI:180, kW:0.90}
    ];
    const bands = computed(() => {
      const sfi = state.sfi || 0, k = state.k || 0;
      return BANDS.map(b => {
        const sfiScore = Math.min(100, Math.max(0, (sfi - b.minSFI) / (b.maxSFI - b.minSFI) * 100));
        const kPen = (k / 9) * b.kW * 100;
        const sc = Math.max(0, Math.min(100, sfiScore - kPen));
        let label, color;
        if (sc >= 80) { label='Excellent'; color='var(--green)'; }
        else if (sc >= 60) { label='Good';  color='var(--green)'; }
        else if (sc >= 40) { label='Fair';  color='var(--amber)'; }
        else if (sc >= 20) { label='Poor';  color='var(--amber)'; }
        else               { label='Bad';   color='var(--red)';   }
        return { name: b.name, score: Math.round(sc), label, color };
      });
    });

    onMounted(() => {
      uibuilder.onTopic('solar', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
        }
      });
    });

    return { expanded, state, gauges, scales, bands, display, pct, gColor, scaleVal, rsgStyle };
  }
};

// === Rotor card ===
const RotorCard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>Rotor</span>
        <span v-if="!expanded" class="summary">
          <span :style="{color:'var(--accent)', fontWeight:600}">{{ headingFmt(state.heading) }} {{ cardinal(state.heading) }}</span>
          <span v-if="state.target != null && state.target !== state.heading">·</span>
          <span v-if="state.target != null && state.target !== state.heading" :style="{color:'var(--amber)', fontWeight:600}">→ {{ headingFmt(state.target) }}</span>
          <span>·</span>
          <span :style="{color: state.power ? 'var(--green)' : 'var(--muted)', fontWeight:600}">{{ state.power ? 'ON' : 'OFF' }}</span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <!-- Big interactive compass — click anywhere on the face to set heading -->
        <div class="rotor-stage">
          <svg viewBox="0 0 220 220" class="rotor-compass"
               :style="{cursor: 'crosshair'}"
               @mousemove="onHover($event)"
               @mouseleave="hover.deg = null"
               @click="onClick($event)">
            <!-- Arrowhead marker for the needle -->
            <defs>
              <marker id="needle-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                      markerWidth="5" markerHeight="5" orient="auto">
                <polygon points="0,0 10,5 0,10" fill="var(--green)"/>
              </marker>
            </defs>
            <!-- Background rings + tick marks -->
            <circle cx="110" cy="110" r="104" fill="var(--bg)" stroke="var(--border)" stroke-width="1"/>
            <circle cx="110" cy="110" r="80"  fill="none" stroke="var(--border-2)" stroke-width="0.5"/>
            <circle cx="110" cy="110" r="50"  fill="none" stroke="var(--border-2)" stroke-width="0.5"/>
            <g v-for="t in 36" :key="t"
               :transform="'rotate(' + (t * 10) + ' 110 110)'">
              <line x1="110" :y1="t % 3 === 0 ? 6 : 8" x2="110" y2="14"
                    :stroke="t % 3 === 0 ? 'var(--text-dim)' : 'var(--border)'"
                    :stroke-width="t % 3 === 0 ? 1.2 : 0.6"/>
            </g>
            <!-- Cardinal labels INSIDE the compass ring -->
            <text x="110" y="26"  text-anchor="middle" fill="var(--text)"     font-size="14" font-weight="700">N</text>
            <text x="195" y="115" text-anchor="middle" fill="var(--text)"     font-size="14" font-weight="700">E</text>
            <text x="110" y="202" text-anchor="middle" fill="var(--text)"     font-size="14" font-weight="700">S</text>
            <text x="25"  y="115" text-anchor="middle" fill="var(--text)"     font-size="14" font-weight="700">W</text>
            <!-- Intercardinals -->
            <text x="170" y="55"  text-anchor="middle" fill="var(--muted)" font-size="10">NE</text>
            <text x="170" y="175" text-anchor="middle" fill="var(--muted)" font-size="10">SE</text>
            <text x="50"  y="175" text-anchor="middle" fill="var(--muted)" font-size="10">SW</text>
            <text x="50"  y="55"  text-anchor="middle" fill="var(--muted)" font-size="10">NW</text>
            <!-- Hover preview line -->
            <line v-if="hover.deg != null"
                  x1="110" y1="110" :x2="hoverX" :y2="hoverY"
                  stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="2 3" opacity="0.6"/>
            <!-- Target heading marker -->
            <line v-if="state.target != null"
                  x1="110" y1="110" :x2="targetX" :y2="targetY"
                  stroke="var(--amber)" stroke-width="2" stroke-dasharray="4 4" opacity="0.8"/>
            <!-- Current heading needle (thicker + arrowhead) -->
            <line x1="110" y1="110" :x2="needleX" :y2="needleY"
                  stroke="var(--green)" stroke-width="5" stroke-linecap="round"
                  marker-end="url(#needle-arrow)"/>
            <circle cx="110" cy="110" r="7" fill="var(--green)"/>
            <!-- Heading value in center bottom of compass -->
            <text x="110" y="155" text-anchor="middle" fill="var(--accent)" font-size="22" font-weight="700"
                  font-family="JetBrains Mono,SFMono-Regular,monospace">{{ headingFmt(state.heading) }}</text>
            <text x="110" y="172" text-anchor="middle" fill="var(--text-dim)" font-size="11">{{ cardinal(state.heading) }}</text>
            <!-- Hover heading display -->
            <text v-if="hover.deg != null"
                  x="110" y="188" text-anchor="middle" fill="var(--amber-fg)" font-size="10"
                  font-family="JetBrains Mono,SFMono-Regular,monospace">→ {{ Math.round(hover.deg) }}°</text>
          </svg>

          <div class="rotor-aside">
            <button class="btn" :class="state.power ? 'btn--green' : 'btn--red'" @click="togglePower()">
              {{ state.power ? '● ON' : '○ OFF' }}
            </button>
            <div v-if="rotatorRemain" class="rotor-timer">⏱ {{ rotatorRemain }}</div>
            <button class="btn btn--red"   @click="doStop()">■ STOP</button>
            <button class="btn btn--amber" @click="doLpSp()">{{ onLongPath ? 'SP' : 'LP' }}</button>
          </div>
        </div>

        <!-- Manual heading entry -->
        <div class="rotor-manual">
          <input v-model.number="manualHdg" type="number" min="0" max="359" placeholder="0-359"
                 @keydown.enter="doGo()" />
          <button class="btn btn--green" @click="doGo()" :disabled="manualHdg == null">GO</button>
        </div>

        <!-- DXCC presets — collapsible (default closed) -->
        <div class="section">
          <div class="section__header" @click="showPresets = !showPresets">
            <span class="chev">{{ showPresets ? '▼' : '▶' }}</span>
            <span>DXCC Presets</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !showPresets }">
            <div class="rotor-presets-row">
              <button v-for="p in presets" :key="p.lbl"
                      class="rotor-preset-chip"
                      :class="{ 'rotor-preset-chip--active': state.target === p.deg }"
                      :style="{ '--chip-accent': octantColor(p.deg) }"
                      @click="goPreset(p.deg)">
                <span class="rotor-preset-chip__lbl">{{ p.lbl }}</span>
                <span class="rotor-preset-chip__deg">{{ p.deg }}°</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const showPresets = ref(false);
    const hover = reactive({ deg: null });
    const state = reactive({ heading: null, target: null, power: false, timerEnd: null });

    const presets = [
      { lbl: 'N',  deg:   0 },
      { lbl: 'US', deg:  10 },
      { lbl: 'JA', deg:  60 },
      { lbl: 'E',  deg:  90 },
      { lbl: 'VK', deg: 120 },
      { lbl: 'ZL', deg: 170 },
      { lbl: 'S',  deg: 180 },
      { lbl: 'SA', deg: 235 },
      { lbl: 'W',  deg: 270 },
      { lbl: 'EU', deg: 325 }
    ];

    // Octant colour: 8 mild hues, one per compass octant — gives the preset chips
    // a "compass rose" tint without being garish
    function octantColor(deg) {
      const octant = Math.floor(((deg + 22.5) % 360) / 45);
      // N · NE · E · SE · S · SW · W · NW
      const palette = ['#58a6ff', '#79c0ff', '#d29922', '#e3b341',
                       '#bc8cff', '#a371f7', '#3fb950', '#56d364'];
      return palette[octant];
    }

    function headingFmt(h) { return h == null ? '—°' : (Math.round(h)) + '°'; }
    function cardinal(h) {
      if (h == null) return '';
      const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
      return dirs[Math.round(h / 22.5) % 16];
    }

    function endpoint(h) {
      if (h == null) return { x: 110, y: 110 };
      const rad = (h - 90) * Math.PI / 180;
      return { x: 110 + 90 * Math.cos(rad), y: 110 + 90 * Math.sin(rad) };
    }

    // Hover preview endpoint
    const hoverX = computed(() => endpoint(hover.deg).x.toFixed(1));
    const hoverY = computed(() => endpoint(hover.deg).y.toFixed(1));

    // Convert SVG-space (x, y) to compass degrees (0–359, 0° = North)
    function xyToDeg(x, y) {
      const dx = x - 110, dy = y - 110;
      if (dx * dx + dy * dy > 104 * 104) return null;  // outside the ring → ignore
      const ang = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180, 0° = East
      return Math.round((ang + 90 + 360) % 360);
    }
    function svgCoords(evt) {
      const svg = evt.currentTarget;
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const p = pt.matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }
    function onHover(evt) {
      const p = svgCoords(evt);
      if (!p) return;
      hover.deg = xyToDeg(p.x, p.y);
    }
    function onClick(evt) {
      const p = svgCoords(evt);
      if (!p) return;
      const deg = xyToDeg(p.x, p.y);
      if (deg == null) return;
      // Set optimistic target so the amber dashed line moves immediately
      state.target = deg;
      goPreset(deg);
    }
    const needleX = computed(() => endpoint(state.heading).x.toFixed(1));
    const needleY = computed(() => endpoint(state.heading).y.toFixed(1));
    const targetX = computed(() => endpoint(state.target).x.toFixed(1));
    const targetY = computed(() => endpoint(state.target).y.toFixed(1));

    // Rotator auto-off countdown (mirrors flow.rotatorTimerEnd from Power card builder)
    const rotatorRemain = ref(null);
    let rotInt = null;
    function refreshRotatorTimer() {
      if (rotInt) { clearInterval(rotInt); rotInt = null; }
      const end = state.timerEnd;
      if (!end) { rotatorRemain.value = null; return; }
      function tick() {
        const rem = Math.max(0, Math.round((end - Date.now()) / 1000));
        const m = Math.floor(rem / 60), s = rem % 60;
        rotatorRemain.value = m + ':' + String(s).padStart(2, '0');
        if (rem <= 0) { rotatorRemain.value = null; if (rotInt) { clearInterval(rotInt); rotInt = null; } }
      }
      tick();
      rotInt = setInterval(tick, 1000);
    }

    // Actions — direct HTTP to existing endpoints
    const manualHdg = ref(null);
    function togglePower() {
      fetch('/rotator/power-toggle', { method: 'POST' }).catch(e => console.warn(e));
    }
    function doStop() {
      fetch('/rotor/stop', { method: 'POST' }).catch(e => console.warn(e));
    }
    const onLongPath = ref(false);
    function doLpSp() {
      fetch('/rotor/lpsp', { method: 'POST' }).catch(e => console.warn(e));
      onLongPath.value = !onLongPath.value;
    }
    function doGo() {
      const h = manualHdg.value;
      if (h == null || h < 0 || h > 359) return;
      fetch('/rotor/go', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hdg: h })
      }).catch(e => console.warn(e));
      state.target = h;
    }
    function goPreset(deg) {
      fetch('/rotor/go', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hdg: deg })
      }).catch(e => console.warn(e));
      state.target = deg;
    }

    onMounted(() => {
      uibuilder.onTopic('rotor', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
          refreshRotatorTimer();
        }
      });
    });

    return {
      expanded, showPresets, state, presets, hover, manualHdg, rotatorRemain,
      onLongPath,
      headingFmt, cardinal, octantColor, needleX, needleY, targetX, targetY, hoverX, hoverY,
      togglePower, doStop, doLpSp, doGo, goPreset, onHover, onClick
    };
  }
};

// === LP-700 Power/SWR meter ===
const LP700Card = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>LP-700 Power Meter</span>
        <span v-if="!expanded" class="summary">
          <span class="mini-bar"><span class="mini-bar__fill" :style="{width: pctOf(state.avg, scaleW) + '%', background:'var(--green)'}"></span></span>
          <span :style="{color:'var(--green)', fontWeight:600}">{{ Math.round(state.avg || 0) }}W</span>
          <span>·</span>
          <span :style="{color: swrColor(state.swr), fontWeight:600}">SWR {{ state.swr != null ? state.swr.toFixed(2) : '—' }}</span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <!-- Scale indicator -->
        <div class="statusline">
          <span>Full Scale</span>
          <strong>{{ scaleW }}<span style="color:var(--text-dim);font-weight:400;margin-left:2px;font-family:var(--font-sans);"> W</span></strong>
        </div>

        <!-- Power + SWR bars -->
        <div class="lp-meters">
          <!-- Avg power -->
          <div class="lp-meter">
            <div class="lp-meter__head">
              <span class="lp-meter__lbl">AVG</span>
              <span class="lp-meter__val" :style="{color:'var(--green)'}">{{ Math.round(state.avg || 0) }}<span class="tile__sub-unit">W</span></span>
            </div>
            <div class="lp-meter__track">
              <div class="lp-meter__fill" :style="{width: pctOf(state.avg, scaleW) + '%', background: 'var(--green)'}"></div>
            </div>
          </div>
          <!-- Peak power -->
          <div class="lp-meter">
            <div class="lp-meter__head">
              <span class="lp-meter__lbl">PEAK</span>
              <span class="lp-meter__val" :style="{color:'var(--amber)'}">{{ Math.round(state.peak || 0) }}<span class="tile__sub-unit">W</span></span>
            </div>
            <div class="lp-meter__track">
              <div class="lp-meter__fill" :style="{width: pctOf(state.peak, scaleW) + '%', background: 'var(--amber)'}"></div>
            </div>
          </div>
          <!-- SWR -->
          <div class="lp-meter">
            <div class="lp-meter__head">
              <span class="lp-meter__lbl">SWR</span>
              <span class="lp-meter__val" :style="{color: swrColor(state.swr)}">{{ state.swr != null ? state.swr.toFixed(2) : '—' }}</span>
            </div>
            <div class="lp-meter__track">
              <div class="lp-meter__fill" :style="{width: swrPct + '%', background: swrColor(state.swr)}"></div>
            </div>
          </div>
        </div>

        <!-- Channel + Range cycle buttons -->
        <div class="lp-controls">
          <div class="lp-control">
            <div class="lp-control__lbl">Channel</div>
            <button class="btn btn--blue lp-control__btn" @click="cycleChannel()">
              <span class="lp-control__val">{{ channelLabel }}</span>
              <span class="lp-control__hint">▸ cycle</span>
            </button>
          </div>
          <div class="lp-control">
            <div class="lp-control__lbl">Range</div>
            <button class="btn btn--blue lp-control__btn" @click="cycleRange()">
              <span class="lp-control__val">{{ rangeLabel }}</span>
              <span class="lp-control__hint">▸ cycle</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const state = reactive({
      avg:null, peak:null, swr:null, channel:null, range:null, scale:null
    });

    const CH_LABELS  = ['Auto','CH 1','CH 2','CH 3','CH 4'];
    const RNG_LABELS = ['5W','10W','25W','50W','100W','250W','500W','1kW','2.5kW','5kW','10kW','Auto'];

    const channelLabel = computed(() => {
      const c = state.channel;
      if (c == null) return '—';
      return CH_LABELS[c] != null ? CH_LABELS[c] : ('CH ' + c);
    });
    const rangeLabel = computed(() => {
      const r = state.range;
      if (r == null) return '—';
      return RNG_LABELS[r] != null ? RNG_LABELS[r] : String(r);
    });

    // Scale: bar full-scale watts based on currently active range / scale
    const scaleW = computed(() => {
      const SCALE_STEPS = [5, 25, 50, 100, 500, 1000, 1500, 2000, 5000];
      const target = Math.max(state.avg || 0, state.peak || 0);
      for (const s of SCALE_STEPS) {
        if (target <= s) return s;
      }
      return SCALE_STEPS[SCALE_STEPS.length - 1];
    });

    function pctOf(v, max) {
      if (v == null || max == null || max === 0) return 0;
      return Math.min(100, (v / max) * 100);
    }
    const swrPct = computed(() => {
      const s = state.swr;
      if (s == null) return 0;
      return Math.min(100, ((s - 1) / 2) * 100);
    });
    function swrColor(s) {
      if (s == null) return 'var(--muted)';
      if (s >= 2.0) return 'var(--red)';
      if (s >= 1.5) return 'var(--amber)';
      return 'var(--green)';
    }

    function cycleChannel() {
      uibuilder.send({ topic: 'lp700/cmd', payload: { type: 'channelStep' } });
    }
    function cycleRange() {
      uibuilder.send({ topic: 'lp700/cmd', payload: { type: 'rangeStep' } });
    }

    onMounted(() => {
      uibuilder.onTopic('lp700', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
        }
      });
    });

    return { expanded, state, channelLabel, rangeLabel, scaleW, pctOf, swrPct, swrColor, cycleChannel, cycleRange };
  }
};

// === SPE Amplifier card ===
const SPECard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>SPE Amplifier {{ state.model && state.model !== '—' ? state.model : '' }}</span>
        <span v-if="!expanded" class="summary">
          <span :style="{color: powerOn ? 'var(--green)' : 'var(--muted)', fontWeight:600}">
            {{ powerOn ? '● ON' : '○ OFF' }}
          </span>
          <span v-if="powerOn">·</span>
          <span v-if="powerOn" :style="{color: isTransmitting ? 'var(--red)' : 'var(--green)', fontWeight:600}">
            {{ state.rxtx === 'TRANSMIT' ? 'TX' : 'RX' }}
          </span>
          <span v-if="powerOn && state.band">·</span>
          <span v-if="powerOn && state.band" :style="{color:'var(--accent)', fontWeight:600}">{{ state.band }}</span>
          <span v-if="powerOn"><span class="mini-bar"><span class="mini-bar__fill" :style="{width: pwrPct + '%', background: pwrBarColor}"></span></span></span>
          <span v-if="powerOn" :style="{color: pwrBarColor, fontWeight:600}">{{ Math.round(state.pwr || 0) }}W</span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <!-- Top: power toggle + sync status -->
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="btn" :class="powerOn ? 'btn--green' : 'btn--red'"
                  style="flex:0 0 auto;" @click="togglePower()">
            {{ powerOn ? '● ON' : '○ OFF' }}
          </button>
          <span class="statusline" style="flex:1;justify-content:flex-end;">
            <span>{{ state.usb ? '✓ WS Connected' : '✗ Disconnected' }}</span>
          </span>
        </div>

        <!-- Primary controls: MODE / TUNE / PWRLVL -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;">
          <button class="btn btn--blue"  :disabled="!powerOn" @click="sendCmd('MODE')">Mode</button>
          <button class="btn btn--amber" :disabled="!powerOn" @click="confirmTune()">Tune</button>
          <button class="btn btn--blue"  :disabled="!powerOn" @click="sendCmd('PWRLVL')">PWR Level</button>
        </div>

        <!-- Top metrics: Mode / RX-TX / Band -->
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">Mode</div>
            <div class="tile__val" :style="{color: state.mode === 'Operate' ? 'var(--red)' : 'var(--green)'}">{{ state.mode || '—' }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">RX / TX</div>
            <div class="tile__val" :style="{color: state.rxtx === 'TRANSMIT' ? 'var(--red)' : 'var(--green)'}">{{ state.rxtx || '—' }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Band</div>
            <div class="tile__val" :style="{color:'var(--accent)'}">{{ state.band || '—' }}</div>
          </div>
        </div>

        <!-- Power level + Input + TX Ant -->
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">Power Level</div>
            <div class="tile__val" :style="{color: pwrLvlColor}">{{ state.pwrlvl || '—' }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Input</div>
            <div class="tile__val" style="font-size:var(--fs-sm)">{{ state.input || '—' }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">TX Antenna</div>
            <div class="tile__val" style="font-size:var(--fs-sm)">{{ state.txant || '—' }}</div>
          </div>
        </div>

        <!-- Output power bar -->
        <div class="solar-sec-label">Output Power</div>
        <div class="band-row" style="grid-template-columns:auto 1fr auto;">
          <span class="band-row__name" style="width:auto">{{ Math.round(state.pwr || 0) }} W</span>
          <div class="band-row__bar" style="height:10px">
            <div :style="{height:'100%', width: pwrPct + '%', background: pwrBarColor, transition:'width 0.3s'}"></div>
          </div>
          <span style="font-size:var(--fs-xs);color:var(--text-dim);">/ {{ state.pwrMax || 1500 }} W</span>
        </div>

        <!-- SWR tiles -->
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">ATU SWR</div>
            <div class="tile__val" :style="{color: swrColor(state.atuswr)}">{{ state.atuswr != null ? state.atuswr.toFixed(2) : '—' }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Antenna SWR</div>
            <div class="tile__val" :style="{color: swrColor(state.antswr)}">{{ state.antswr != null ? state.antswr.toFixed(2) : '—' }}</div>
          </div>
        </div>

        <!-- Warnings / Alarms -->
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">Warnings</div>
            <div class="tile__val" :style="{color: state.warnings === 'No Warnings' ? 'var(--green)' : 'var(--amber)', fontSize:'var(--fs-sm)'}">{{ state.warnings || '—' }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Alarms</div>
            <div class="tile__val" :style="{color: state.alarms === 'No Alarms' ? 'var(--green)' : 'var(--red)', fontSize:'var(--fs-sm)'}">{{ state.alarms || '—' }}</div>
          </div>
        </div>

        <!-- Hardware telemetry -->
        <div class="solar-sec-label">Hardware</div>
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">V PA</div>
            <div class="tile__val">{{ state.vpa != null ? state.vpa.toFixed(1) : '—' }}<span class="tile__sub-unit">V</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">I PA</div>
            <div class="tile__val">{{ state.ipa != null ? state.ipa.toFixed(1) : '—' }}<span class="tile__sub-unit">A</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Temp Upper</div>
            <div class="tile__val" :style="{color: tempColor(state.tempUpper)}">{{ state.tempUpper != null ? Math.round(state.tempUpper) : '—' }}<span class="tile__sub-unit">°C</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Temp Lower</div>
            <div class="tile__val" :style="{color: tempColor(state.tempLower)}">{{ state.tempLower != null ? Math.round(state.tempLower) : '—' }}<span class="tile__sub-unit">°C</span></div>
          </div>
        </div>

        <!-- Collapsible: Operating -->
        <div class="section">
          <div class="section__header" @click="sec.operating = !sec.operating">
            <span class="chev">{{ sec.operating ? '▼' : '▶' }}</span>
            <span>Operating</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.operating }">
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px;">
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('INPUT')">Input</button>
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('ANTENNA')">Antenna</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:4px;">
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('BAND_MINUS')">◀ Band</button>
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('BAND_PLUS')">Band ▶</button>
            </div>
          </div>
        </div>

        <!-- Collapsible: ATU manual tune -->
        <div class="section">
          <div class="section__header" @click="sec.atu = !sec.atu">
            <span class="chev">{{ sec.atu ? '▼' : '▶' }}</span>
            <span>ATU Manual</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.atu }">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('L_MINUS')">L −</button>
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('L_PLUS')">L +</button>
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('C_MINUS')">C −</button>
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('C_PLUS')">C +</button>
            </div>
            <button class="btn btn--blue" :disabled="!powerOn" @click="sendCmd('SET')" style="margin-top:4px;">SET (save ATU)</button>
          </div>
        </div>

        <!-- Collapsible: Display + navigation -->
        <div class="section">
          <div class="section__header" @click="sec.display = !sec.display">
            <span class="chev">{{ sec.display ? '▼' : '▶' }}</span>
            <span>Display</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.display }">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;">
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('BL_ON')">BL ON</button>
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('BL_OFF')">BL OFF</button>
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('DISPLAY')">Display</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:4px;">
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('LEFT')">◀</button>
              <button class="btn btn--ghost" :disabled="!powerOn" @click="sendCmd('RIGHT')">▶</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const sec = reactive({ operating: false, atu: false, display: false });
    const state = reactive({
      model:null, mode:null, rxtx:null, band:null, input:null, txant:null,
      pwrlvl:null, pwr:0, pwrMax:1500, atuswr:null, antswr:null,
      vpa:null, ipa:null, tempUpper:null, tempLower:null, tempComb:null,
      warnings:null, alarms:null, usb:false
    });

    const powerOn = computed(() => !!state.usb);
    const isTransmitting = computed(() => state.rxtx === 'TRANSMIT');

    const pwrPct = computed(() => {
      if (!state.pwr || !state.pwrMax) return 0;
      return Math.min(100, (state.pwr / state.pwrMax) * 100);
    });
    const pwrBarColor = computed(() => {
      const p = pwrPct.value;
      if (p > 85) return 'var(--red)';
      if (p > 65) return 'var(--amber)';
      return 'var(--green)';
    });
    const pwrLvlColor = computed(() => {
      if (state.pwrlvl === 'Maximum') return 'var(--red)';
      if (state.pwrlvl === 'Middle')  return 'var(--amber)';
      return 'var(--accent)';
    });

    function swrColor(s) {
      if (s == null) return 'var(--muted)';
      if (s >= 2.0) return 'var(--red)';
      if (s >= 1.5) return 'var(--amber)';
      return 'var(--green)';
    }
    function tempColor(t) {
      if (t == null) return 'var(--muted)';
      if (t >= 80) return 'var(--red)';
      if (t >= 60) return 'var(--amber)';
      return 'var(--green)';
    }

    function togglePower() {
      const next = powerOn.value ? 'OFF_SPE' : 'ON_SPE';
      const msg = powerOn.value
        ? 'Power OFF the SPE amplifier?'
        : 'Power ON the SPE amplifier?';
      if (!confirm(msg)) return;
      uibuilder.send({ topic: 'spe/cmd', payload: { type: 'spePower', value: next } });
    }
    function sendCmd(cmd) {
      uibuilder.send({ topic: 'spe/cmd', payload: { type: 'speCmd', value: cmd } });
    }
    function confirmTune() {
      if (!confirm('Start ATU TUNE?\n\nThe amp will transmit a low-power tuning carrier for a few seconds.')) return;
      sendCmd('TUNE');
    }

    onMounted(() => {
      uibuilder.onTopic('spe', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
        }
      });
    });

    return { expanded, sec, state, powerOn, isTransmitting, pwrPct, pwrBarColor, pwrLvlColor, swrColor, tempColor, togglePower, sendCmd, confirmTune };
  }
};

// === FlexRadio card ===
const FlexCard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>FlexRadio {{ state.model || '6600' }}</span>
        <span v-if="!expanded" class="summary">
          <span :style="{color: isTransmitting ? 'var(--red)' : 'var(--green)', fontWeight:600}">
            {{ isTransmitting ? '⚡ TX' : '✓ RX' }}
          </span>
          <span v-if="primarySlice">·</span>
          <span v-if="primarySlice" :style="{color:'var(--accent)', fontWeight:600}">
            {{ primarySlice.freq }} {{ primarySlice.mode }}
          </span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <!-- Header info: connection / callsign / clients -->
        <div class="statusline">
          <span :style="{color: state.model ? 'var(--green)' : 'var(--muted)'}">●</span>
          <strong>{{ state.model || '— (not connected)' }}</strong>
          <span v-if="state.callsign">Call <strong>{{ state.callsign }}</strong></span>
          <span v-if="clientNames">Clients <strong>{{ clientNames }}</strong></span>
        </div>

        <!-- Active slices table -->
        <div class="solar-sec-label">Active Slices</div>
        <div v-if="activeSlices.length === 0" class="empty-row">No active slices</div>
        <table v-else class="slice-tbl">
          <tbody>
            <tr v-for="sl in activeSlices" :key="sl.slice"
                :class="sl.isTx ? 'slice-row--tx' : 'slice-row--rx'">
              <td class="slice-tbl__letter">{{ sl.slice }}</td>
              <td class="slice-tbl__freq">{{ sl.freq }}</td>
              <td class="slice-tbl__mode">{{ sl.mode }}</td>
              <td class="slice-tbl__state">
                <span :style="{color: sl.isTx ? 'var(--red)' : 'var(--green)', fontWeight:700}">
                  {{ sl.isTx ? 'TX' : 'RX' }}
                </span>
              </td>
              <td class="slice-tbl__client">{{ sl.client || '—' }}</td>
            </tr>
          </tbody>
        </table>

        <!-- Power settings -->
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">RF Power</div>
            <div class="tile__val">{{ state.rfpower ?? '—' }}<span class="tile__sub-unit">W</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Tune Power</div>
            <div class="tile__val">{{ state.tunepower ?? '—' }}<span class="tile__sub-unit">W</span></div>
          </div>
        </div>

        <!-- Hardware telemetry -->
        <div class="solar-sec-label">Hardware</div>
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">PA Temp</div>
            <div class="tile__val" :style="{color: tempColor(state.patemp)}">{{ state.patemp ?? '—' }}<span class="tile__sub-unit">°C</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">PA Volts</div>
            <div class="tile__val">{{ state.pavolts ?? '—' }}<span class="tile__sub-unit">V</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Input</div>
            <div class="tile__val">{{ state.involts ?? '—' }}<span class="tile__sub-unit">V</span></div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Fan</div>
            <div class="tile__val">{{ state.fan ?? '—' }}<span class="tile__sub-unit">RPM</span></div>
          </div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const state = reactive({
      model:null, callsign:null, clients:[], slices:{},
      activeSlices:[], rfpower:null, tunepower:null,
      patemp:null, pavolts:null, involts:null, fan:null
    });

    const activeSlices = computed(() => state.activeSlices || []);
    const isTransmitting = computed(() => activeSlices.value.some(s => s.isTx));
    const primarySlice = computed(() => {
      // Show the TX slice if any, else the first active slice
      return activeSlices.value.find(s => s.isTx) || activeSlices.value[0] || null;
    });
    const clientNames = computed(() => {
      const cs = state.clients;
      if (!cs) return null;
      if (Array.isArray(cs)) return cs.length ? cs.join(', ') : null;
      return String(cs);
    });

    function tempColor(t) {
      const n = parseFloat(t);
      if (isNaN(n)) return 'var(--muted)';
      if (n >= 60) return 'var(--red)';
      if (n >= 50) return 'var(--amber)';
      return 'var(--green)';
    }

    onMounted(() => {
      uibuilder.onTopic('flex', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
        }
      });
    });

    return { expanded, state, activeSlices, isTransmitting, primarySlice, clientNames, tempColor };
  }
};

// === Power Control card ===
const PowerCard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>Power Control</span>
        <span v-if="!expanded" class="summary">
          <span :style="{color:'var(--accent)', fontWeight:600}">{{ onCount }}/{{ plugs.length }}</span>
          <span v-if="state.energy?.power != null">·</span>
          <span v-if="state.energy?.power != null" :style="{color:'var(--text)', fontWeight:600}">
            {{ state.energy.power }} W
          </span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <div class="plug-grid">
          <button v-for="p in plugs" :key="p.topic"
                  class="plug"
                  :class="plugClass(p)"
                  @click="toggle(p.topic)">
            <span class="plug__dot"></span>
            <span class="plug__lbl">{{ p.label }}</span>
            <span v-if="p.topic === 'cmnd/powerstrip1/POWER2' && rotatorRemain" class="plug__sub">⏱ {{ rotatorRemain }}</span>
          </button>
        </div>

        <div v-if="state.energy" class="energy-row">
          <div class="energy-tile">
            <div class="energy-tile__lbl">Voltage</div>
            <div class="energy-tile__val">{{ state.energy.voltage ?? '—' }}<span class="unit">V</span></div>
          </div>
          <div class="energy-tile">
            <div class="energy-tile__lbl">Current</div>
            <div class="energy-tile__val">{{ state.energy.current ?? '—' }}<span class="unit">A</span></div>
          </div>
          <div class="energy-tile">
            <div class="energy-tile__lbl">Power</div>
            <div class="energy-tile__val">{{ state.energy.power ?? '—' }}<span class="unit">W</span></div>
          </div>
          <div class="energy-tile">
            <div class="energy-tile__lbl">Today</div>
            <div class="energy-tile__val">{{ state.energy.today ?? '—' }}<span class="unit">kWh</span></div>
          </div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const state = reactive({ power: {}, energy: null, rotatorTimerEnd: null });

    // All 20 outlets, ordered to match the existing /ui layout
    const plugs = [
      { topic:'cmnd/powerstrip1/POWER1', label:'13.8V SMPS' },
      { topic:'cmnd/powerstrip1/POWER2', label:'Rotator' },
      { topic:'cmnd/powerstrip1/POWER3', label:'PLUG3' },
      { topic:'cmnd/powerstrip1/POWER4', label:'Plug4' },
      { topic:'cmnd/powerstrip1/POWER5', label:'Antenna' },
      { topic:'cmnd/powerstrip2/POWER1', label:'Plug1' },
      { topic:'cmnd/powerstrip2/POWER2', label:'Plug2' },
      { topic:'cmnd/powerstrip2/POWER3', label:'Plug3' },
      { topic:'cmnd/powerstrip2/POWER4', label:'Plug4' },
      { topic:'cmnd/powerstrip2/POWER5', label:'USB2' },
      { topic:'cmnd/powerstrip3/POWER1', label:'LZ1AQ' },
      { topic:'cmnd/powerstrip3/POWER2', label:'Single Loop' },
      { topic:'cmnd/powerstrip3/POWER3', label:'SDR Fan' },
      { topic:'cmnd/powerstrip3/POWER4', label:'PLUG4' },
      { topic:'cmnd/powerstrip3/POWER5', label:'USB3' },
      { topic:'cmnd/4relayboard/POWER1', label:'Flex ON' },
      { topic:'cmnd/4relayboard/POWER2', label:'Flex PTT' },
      { topic:'cmnd/4relayboard/POWER3', label:'Relay3' },
      { topic:'cmnd/4relayboard/POWER4', label:'Relay4' },
      { topic:'cmnd/16Amasterswitch/POWER1', label:'16A Mains', master: true }
    ];

    function plugIsOn(topic) {
      const v = state.power?.[topic];
      return v === 'ON' || v === true || v === 1;
    }
    function plugClass(p) {
      if (p.master) return 'plug--master';
      return plugIsOn(p.topic) ? 'plug--on' : 'plug--off';
    }
    function toggle(topic) {
      // Optimistic local flip
      if (state.power) state.power[topic] = plugIsOn(topic) ? 'OFF' : 'ON';
      uibuilder.send({ topic: 'power/cmd', payload: { type: 'togglePlug', plug: topic } });
    }
    const onCount = computed(() => plugs.filter(p => plugIsOn(p.topic)).length);

    // Rotator auto-off countdown (driven by flow.rotatorTimerEnd from Node-RED)
    const rotatorRemain = ref(null);
    let rotInt = null;
    function refreshRotator() {
      const end = state.rotatorTimerEnd;
      if (!end) { rotatorRemain.value = null; if (rotInt) { clearInterval(rotInt); rotInt = null; } return; }
      function tick() {
        const rem = Math.max(0, Math.round((end - Date.now()) / 1000));
        const m = Math.floor(rem / 60), s = rem % 60;
        rotatorRemain.value = m + ':' + String(s).padStart(2, '0');
        if (rem <= 0) { rotatorRemain.value = null; if (rotInt) { clearInterval(rotInt); rotInt = null; } }
      }
      tick();
      if (!rotInt) rotInt = setInterval(tick, 1000);
    }

    onMounted(() => {
      uibuilder.onTopic('power', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
          refreshRotator();
        }
      });
    });

    return { expanded, state, plugs, plugClass, plugIsOn, toggle, onCount, rotatorRemain };
  }
};

// === RPi Fleet card ===
const RPiCard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>RPi Fleet</span>
        <span v-if="!expanded" class="summary">
          <span :style="{color: anyOffline ? 'var(--red)' : 'var(--green)', fontWeight:700}">
            {{ onlineCount }}/{{ hosts.length }} online
          </span>
          <span v-if="hottestPi">·</span>
          <span v-if="hottestPi" :style="{color: tempColor(hottestPi.temp), fontWeight:700}">
            {{ hottestPi.name }} {{ hottestPi.temp }}°C
          </span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <div class="rpi-grid">
          <div v-for="h in hosts" :key="h" class="rpi-host" :class="hostClass(h)">
            <div class="rpi-host__top">
              <span class="rpi-host__name">
                <span class="dot" :style="{color: statusColor(h)}"></span>
                {{ h }}
              </span>
              <span class="rpi-host__actions">
                <button class="btn btn--amber" @click="doReboot(h)">Reboot</button>
                <button class="btn btn--red"   @click="doShutdown(h)">Shutdown</button>
              </span>
            </div>

            <div class="rpi-host__metrics">
              <div class="rpi-metric">
                <div class="rpi-metric__lbl">CPU</div>
                <div class="rpi-metric__val" :style="{color: cpuColor(dev(h).cpu)}">{{ dev(h).cpu ?? '—' }}%</div>
                <div class="rpi-metric__bar"><div :style="{width:(dev(h).cpu||0)+'%', background:cpuColor(dev(h).cpu)}"></div></div>
              </div>
              <div class="rpi-metric">
                <div class="rpi-metric__lbl">Temp</div>
                <div class="rpi-metric__val" :style="{color: tempColor(dev(h).temp)}">{{ dev(h).temp ?? '—' }}°C</div>
                <div class="rpi-metric__bar"><div :style="{width:tempPct(dev(h).temp)+'%', background:tempColor(dev(h).temp)}"></div></div>
              </div>
              <div class="rpi-metric">
                <div class="rpi-metric__lbl">Mem</div>
                <div class="rpi-metric__val" :style="{color: pctColor(dev(h).mem)}">{{ dev(h).mem ?? '—' }}%</div>
                <div class="rpi-metric__bar"><div :style="{width:(dev(h).mem||0)+'%', background:pctColor(dev(h).mem)}"></div></div>
              </div>
              <div class="rpi-metric">
                <div class="rpi-metric__lbl">Disk</div>
                <div class="rpi-metric__val" :style="{color: pctColor(dev(h).disk)}">{{ dev(h).disk ?? '—' }}%</div>
                <div class="rpi-metric__bar"><div :style="{width:(dev(h).disk||0)+'%', background:pctColor(dev(h).disk)}"></div></div>
              </div>
            </div>

            <div class="rpi-host__meta">
              <span>IP {{ dev(h).ip || '—' }}</span>
              <span>Up {{ fmtUptime(dev(h).uptime) }}</span>
              <span v-if="dev(h).lastSeen">Seen {{ dev(h).lastSeen }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const state = reactive({ devices: {} });

    function dev(h) { return state.devices?.[h] || {}; }

    const hosts = computed(() => Object.keys(state.devices || {}).sort());

    const onlineCount = computed(() => hosts.value.filter(h => dev(h).status === 'online').length);
    const anyOffline  = computed(() => hosts.value.some(h => dev(h).status !== 'online'));
    const hottestPi   = computed(() => {
      let best = null;
      hosts.value.forEach(h => {
        const t = parseFloat(dev(h).temp);
        if (!isNaN(t) && (!best || t > best.temp)) best = { name: h, temp: t };
      });
      return best;
    });

    function statusColor(h) { return dev(h).status === 'online' ? 'var(--green)' : 'var(--red)'; }
    function hostClass(h)   { return dev(h).status === 'online' ? 'rpi-host--online' : 'rpi-host--offline'; }

    function pctColor(v) {
      const n = parseFloat(v);
      if (isNaN(n)) return 'var(--muted)';
      if (n >= 90) return 'var(--red)';
      if (n >= 70) return 'var(--amber)';
      return 'var(--green)';
    }
    function cpuColor(v) { return pctColor(v); }
    function tempColor(v) {
      const n = parseFloat(v);
      if (isNaN(n)) return 'var(--muted)';
      if (n >= 75) return 'var(--red)';
      if (n >= 60) return 'var(--amber)';
      return 'var(--green)';
    }
    function tempPct(v) {
      const n = parseFloat(v);
      if (isNaN(n)) return 0;
      return Math.min(100, Math.max(0, n));  // simple 0–100°C scale
    }
    function fmtUptime(u) {
      if (!u) return '—';
      const s = parseInt(u, 10);
      if (isNaN(s)) return String(u);
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + m + 'm';
    }

    function doReboot(host) {
      if (!confirm(`Reboot ${host}?\n\nIt will be unreachable for ~30 seconds.`)) return;
      uibuilder.send({ topic: 'rpi/cmd', payload: { type: 'rpiReboot', host } });
    }
    function doShutdown(host) {
      if (!confirm(`SHUTDOWN ${host}?\n\nIt will NOT restart automatically — you'll need to power-cycle it manually.`)) return;
      uibuilder.send({ topic: 'rpi/cmd', payload: { type: 'rpiShutdown', host } });
    }

    onMounted(() => {
      uibuilder.onTopic('rpi', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
        }
      });
    });

    return {
      expanded, state, hosts, dev,
      onlineCount, anyOffline, hottestPi,
      statusColor, hostClass, pctColor, cpuColor, tempColor, tempPct, fmtUptime,
      doReboot, doShutdown
    };
  }
};

// === GPS NTP / Chrony status card ===
const GpsNtpCard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>GPS Time Server</span>
        <span v-if="!expanded" class="summary">
          <span :style="{color: stratumColor, fontWeight:600}">Stratum {{ state.stratum ?? '—' }}</span>
          <span>·</span>
          <span :style="{color: refColor, fontWeight:600}">{{ state.ref_name || '—' }}</span>
          <span v-if="state.system_time_offset_s != null">·</span>
          <span v-if="state.system_time_offset_s != null" :style="{color: offsetColor, fontWeight:600}">
            {{ fmtNs(state.system_time_offset_s) }}
          </span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <!-- Top status row -->
        <div class="statusline">
          <span :style="{color: state.host ? 'var(--green)' : 'var(--red)'}">●</span>
          <strong>{{ state.host || 'gpsntp' }}</strong>
          <span v-if="state.ts">· {{ ageStr }} ago</span>
        </div>

        <!-- Headline metrics: stratum, reference, fix -->
        <div class="tiles">
          <div class="tile">
            <div class="tile__lbl">Stratum</div>
            <div class="tile__val" :style="{color: stratumColor}">{{ state.stratum ?? '—' }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Reference</div>
            <div class="tile__val" :style="{color: refColor, fontSize:'var(--fs-sm)'}">{{ state.ref_name || '—' }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Fix</div>
            <div class="tile__val" :style="{color: fixColor}">{{ fixLabel }}</div>
          </div>
          <div class="tile">
            <div class="tile__lbl">Satellites</div>
            <div class="tile__val">{{ state.sat_used ?? '—' }}<span class="tile__sub-unit">/ {{ state.sat_seen ?? '—' }}</span></div>
          </div>
        </div>

        <!-- Offset / dispersion / skew metrics -->
        <div class="solar-sec-label">Sync Quality</div>
        <dl class="stats">
          <dt>System Offset</dt>     <dd :style="{color: offsetColor}">{{ fmtNs(state.system_time_offset_s) }}</dd>
          <dt>Last Offset</dt>       <dd>{{ fmtNs(state.last_offset_s) }}</dd>
          <dt>RMS Offset</dt>        <dd :style="{color: rmsColor}">{{ fmtNs(state.rms_offset_s) }}</dd>
          <dt>Root Dispersion</dt>   <dd :style="{color: dispColor}">{{ fmtNs(state.root_dispersion_s) }}</dd>
          <dt>Root Delay</dt>        <dd>{{ fmtNs(state.root_delay_s) }}</dd>
          <dt>Frequency Drift</dt>   <dd>{{ state.freq_ppm != null ? state.freq_ppm.toFixed(3) + ' ppm' : '—' }}</dd>
          <dt>Skew</dt>              <dd :style="{color: skewColor}">{{ state.skew_ppm != null ? state.skew_ppm.toFixed(3) + ' ppm' : '—' }}</dd>
          <dt>Leap</dt>              <dd>{{ state.leap || '—' }}</dd>
        </dl>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const state = reactive({
      host:null, ts:null, stratum:null, ref_name:null, ref_id:null,
      system_time_offset_s:null, last_offset_s:null, rms_offset_s:null,
      root_delay_s:null, root_dispersion_s:null, freq_ppm:null, skew_ppm:null,
      leap:null, fix_mode:null, sat_used:null, sat_seen:null
    });

    // Tick to update "X seconds ago" label
    const tick = ref(0);
    setInterval(() => { tick.value++; }, 10000);
    const ageStr = computed(() => {
      tick.value;
      if (!state.ts) return '—';
      const sec = Math.max(0, Math.floor(Date.now() / 1000 - state.ts));
      if (sec < 60)    return sec + 's';
      if (sec < 3600)  return Math.floor(sec / 60) + 'm';
      return Math.floor(sec / 3600) + 'h';
    });

    // Format small times — chrony reports in seconds; we want ns/µs/ms readable
    function fmtNs(v) {
      if (v == null) return '—';
      const a = Math.abs(v);
      const sign = v < 0 ? '−' : '';
      if (a < 1e-6)  return sign + (a * 1e9).toFixed(0) + ' ns';
      if (a < 1e-3)  return sign + (a * 1e6).toFixed(1) + ' µs';
      if (a < 1)     return sign + (a * 1e3).toFixed(2) + ' ms';
      return sign + a.toFixed(3) + ' s';
    }

    // Threshold colours per the CLAUDE.md spec
    const offsetColor = computed(() => Math.abs(state.system_time_offset_s || 0) > 1e-3 ? 'var(--amber)' : 'var(--green)');
    const rmsColor    = computed(() => (state.rms_offset_s ?? 0) > 1e-3 ? 'var(--amber)' : 'var(--green)');
    const dispColor   = computed(() => (state.root_dispersion_s ?? 0) > 5e-3 ? 'var(--amber)' : 'var(--green)');
    const skewColor   = computed(() => Math.abs(state.skew_ppm ?? 0) > 1 ? 'var(--amber)' : 'var(--green)');
    const stratumColor = computed(() => state.stratum === 1 ? 'var(--green)' : (state.stratum != null && state.stratum < 5 ? 'var(--amber)' : 'var(--red)'));
    const refColor    = computed(() => /^PPS/i.test(state.ref_name || '') ? 'var(--green)' : 'var(--amber)');
    const fixColor    = computed(() => state.fix_mode === 3 ? 'var(--green)' : (state.fix_mode === 2 ? 'var(--amber)' : 'var(--red)'));
    const fixLabel    = computed(() => state.fix_mode === 3 ? '3D' : (state.fix_mode === 2 ? '2D' : (state.fix_mode === 1 ? 'No fix' : '—')));

    onMounted(() => {
      uibuilder.onTopic('gpsntp', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
        }
      });
    });

    return {
      expanded, state, ageStr, fmtNs,
      offsetColor, rmsColor, dispColor, skewColor,
      stratumColor, refColor, fixColor, fixLabel
    };
  }
};

// === Network Monitor card ===
const NetworkCard = {
  template: `
    <div class="card">
      <div class="card__header" @click="expanded = !expanded">
        <span class="chev">{{ expanded ? '▼' : '▶' }}</span>
        <span>Network Monitor</span>
        <span v-if="!expanded" class="summary">
          <span :style="{color: anyDown ? 'var(--red)' : 'var(--green)', fontWeight:700}">
            {{ upCount }}/{{ hosts.length }} up
          </span>
          <span v-if="avgMs != null">·</span>
          <span v-if="avgMs != null" :style="{color: latencyColor(avgMs), fontWeight:700}">{{ avgMs }}ms avg</span>
        </span>
      </div>

      <div class="card__body" :class="{ 'is-collapsed': !expanded }">

        <div class="net-grid">
          <div v-for="h in hosts" :key="h.key" class="net-tile" :class="tileClass(h)">
            <div class="net-tile__name">{{ h.label }}</div>
            <div class="net-tile__addr">{{ h.addr }}</div>
            <div class="net-tile__val" :style="{color: tileColor(h)}">
              <span class="dot"></span>
              {{ tileText(h) }}
            </div>
          </div>
        </div>

        <!-- Internet failover stats line -->
        <div class="statusline">
          <span>Internet
            <strong :style="{color: state.status ? 'var(--green)' : 'var(--red)'}">
              {{ state.status ? 'UP' : 'DOWN' }}
            </strong>
          </span>
          <span v-if="state.totalFails != null">Fails <strong>{{ state.totalFails }}</strong></span>
          <span v-if="state.lastFail">Last <strong>{{ state.lastFail }}</strong></span>
        </div>
      </div>
    </div>
  `,
  setup() {
    const expanded = ref(false);
    const state = reactive({ pings: {}, status: null, totalFails: null, lastFail: null });

    // Hosts displayed — keys must match the stamp functions in Node-RED
    const hosts = [
      { key:'Internet',  label:'Internet',  addr:'www.google.com'  },
      { key:'Flex',      label:'FlexRadio', addr:'192.168.1.148'   },
      { key:'OpenwebRX', label:'OpenwebRX+',addr:'192.168.1.158'   },
      { key:'RBN_PC',    label:'Mac RBN',   addr:'192.168.1.245'   },
      { key:'RBN_SDR',   label:'RBN SDR',   addr:'192.168.1.241'   }
    ];

    function pingFor(key) { return state.pings?.[key] || {}; }
    function latencyColor(ms) {
      if (ms == null) return 'var(--muted)';
      if (ms < 50)   return 'var(--green)';
      if (ms < 200)  return 'var(--amber)';
      return 'var(--red)';
    }
    function tileClass(h) {
      const p = pingFor(h.key);
      if (p.up === false) return 'net-tile--down';
      if (p.up === true)  return 'net-tile--up';
      return 'net-tile--unknown';
    }
    function tileColor(h) {
      const p = pingFor(h.key);
      if (p.up === false) return 'var(--red)';
      return latencyColor(p.ms);
    }
    function tileText(h) {
      const p = pingFor(h.key);
      if (p.up === false) return 'DOWN';
      if (p.up === true && p.ms != null) return Math.round(p.ms) + ' ms';
      return '—';
    }

    const upCount = computed(() =>
      hosts.filter(h => pingFor(h.key).up === true).length
    );
    const anyDown = computed(() =>
      hosts.some(h => pingFor(h.key).up === false)
    );
    const avgMs = computed(() => {
      const ups = hosts.map(h => pingFor(h.key)).filter(p => p.up === true && p.ms != null);
      if (!ups.length) return null;
      return Math.round(ups.reduce((s, p) => s + p.ms, 0) / ups.length);
    });

    onMounted(() => {
      uibuilder.onTopic('network', (msg) => {
        if (msg && msg.payload && typeof msg.payload === 'object') {
          Object.assign(state, msg.payload);
        }
      });
    });

    return { expanded, state, hosts, pingFor, latencyColor, tileClass, tileColor, tileText, upCount, anyDown, avgMs };
  }
};

// === Top-bar with callsign + clocks + inline connection pill ===
const TopBar = {
  props: ['connected'],
  template: `
    <div class="topbar">
      <div class="topbar__left">
        <div class="callsign-row">
          <span class="callsign">VU2CPL</span>
          <span class="conn-pill" :class="{ 'is-connected': connected }">
            <span class="dot"></span>
            <span>{{ connected ? 'LIVE' : 'OFFLINE' }}</span>
          </span>
        </div>
        <div class="sub">MK83TE · Bengaluru · Shack Control</div>
      </div>
      <div class="clocks">
        <div class="clk"><div class="clk-lbl">UTC</div><div class="clk-val">{{ utc }}</div></div>
        <div class="clk"><div class="clk-lbl">IST</div><div class="clk-val">{{ ist }}</div></div>
        <div class="clk"><div class="clk-lbl">Sunrise</div><div class="clk-val amber">{{ sr }}</div></div>
        <div class="clk"><div class="clk-lbl">Sunset</div><div class="clk-val amber">{{ ss }}</div></div>
      </div>
    </div>
  `,
  setup() {
    const utc = ref('--:--:--');
    const ist = ref('--:--:--');
    const sr  = ref('05:56'); // TODO: compute properly or fetch from NR
    const ss  = ref('18:36');
    const pad = (n) => String(n).padStart(2, '0');
    function tick() {
      const now = new Date();
      utc.value = pad(now.getUTCHours()) + ':' + pad(now.getUTCMinutes()) + ':' + pad(now.getUTCSeconds());
      const istD = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
      ist.value = pad(istD.getUTCHours()) + ':' + pad(istD.getUTCMinutes()) + ':' + pad(istD.getUTCSeconds());
    }
    tick(); setInterval(tick, 1000);
    return { utc, ist, sr, ss };
  }
};

// === Root app ===
const App = {
  components: { TopBar, LightningCard, DXCCCard, NetworkCard, RPiCard, PowerCard, SolarCard, FlexCard, SPECard, LP700Card, RotorCard, GpsNtpCard },
  template: `
    <TopBar :connected="connected" />
    <div class="dash-grid">
      <FlexCard />
      <LP700Card />
      <SPECard />
      <RotorCard />
      <LightningCard />
      <PowerCard />
      <SolarCard />
      <DXCCCard />
      <RPiCard />
      <NetworkCard />
      <GpsNtpCard />
    </div>
  `,
  setup() {
    const connected = ref(false);
    let lastMsgAt = 0;
    onMounted(() => {
      uibuilder.start();
      // Multi-pronged detection — v7 may use different property names than older versions
      try { uibuilder.onChange('socketConnected', (v) => { connected.value = !!v; }); } catch (e) {}
      try { uibuilder.onChange('ioConnected',     (v) => { connected.value = !!v; }); } catch (e) {}
      // Definitive: if we've received a message in the last 10s, we are connected
      uibuilder.onChange('msg', () => { lastMsgAt = Date.now(); });
      setInterval(() => {
        if (Date.now() - lastMsgAt < 10_000) connected.value = true;
        else if (Date.now() - lastMsgAt > 15_000) connected.value = false;
      }, 1000);
      console.log('[shack] uibuilder started, version:', uibuilder.version || 'unknown');
    });
    return { connected };
  }
};

createApp(App).mount('#app');
