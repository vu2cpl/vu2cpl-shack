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
    const expanded = ref(true);
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
    const expanded = ref(true);
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
    const expanded = ref(true);
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
  components: { TopBar, LightningCard, DXCCCard, NetworkCard },
  template: `
    <TopBar :connected="connected" />
    <div class="dash-grid">
      <LightningCard />
      <DXCCCard />
      <NetworkCard />
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
