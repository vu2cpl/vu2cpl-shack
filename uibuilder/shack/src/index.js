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
          {{ summary }}
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

            <!-- 4 rows: numeric (left) + paired enum (right) -->
            <div v-for="(row, i) in tunableRows" :key="i" class="tun-row">
              <span class="tun-lbl">{{ row.num.lbl }}</span>
              <span class="tun-range">{{ row.num.min }}–{{ row.num.max }}</span>
              <button class="tun-step" :disabled="(state.tunables?.[row.num.key] ?? row.num.min) <= row.num.min"
                      @click="step(row.num.key, -1, row.num.min, row.num.max)">−</button>
              <span class="tun-val">{{ state.tunables?.[row.num.key] ?? '—' }}</span>
              <button class="tun-step" :disabled="(state.tunables?.[row.num.key] ?? row.num.max) >= row.num.max"
                      @click="step(row.num.key, +1, row.num.min, row.num.max)">+</button>

              <!-- Paired enum on the right -->
              <span class="tun-enum-lbl">{{ row.enum.lbl }}</span>
              <button v-for="opt in row.enum.options" :key="String(opt.v)"
                      class="pill"
                      :class="{ 'pill--active': String(state.tunables?.[row.enum.key]) === String(opt.v) }"
                      @click="action('setTunable', opt.v, row.enum.key)">
                {{ opt.label }}
              </button>
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
    const summary = computed(() => {
      const parts = [];
      if (state.bypassActive) parts.push('🔕 BYPASS');
      parts.push((state.antennaOn ? 'ANT ON' : 'ANT OFF'));
      if (state.closestKm != null) parts.push(state.closestKm + 'km');
      return parts.join(' · ');
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
      { key: 'nf',      lbl: 'NF',      min: 0, max:  7 },
      { key: 'wdth',    lbl: 'WDTH',    min: 0, max: 15 },
      { key: 'srej',    lbl: 'SREJ',    min: 0, max: 15 },
      { key: 'tun_cap', lbl: 'TUN_CAP', min: 0, max: 15 }
    ];

    // List of enum-ish tunables (rendered as pill toggle groups, inline)
    const enumTunables = [
      { key: 'afe_gb', lbl: 'AFE', options: [
        { v: 'indoor',  label: 'IN'  },
        { v: 'outdoor', label: 'OUT' }
      ]},
      { key: 'modem_sleep', lbl: 'SLP', options: [
        { v: 'none', label: 'NONE' },
        { v: 'min',  label: 'MIN'  },
        { v: 'max',  label: 'MAX'  }
      ]},
      { key: 'mask_dist', lbl: 'MASK', options: [
        { v: false, label: 'OFF' },
        { v: true,  label: 'ON'  }
      ]},
      { key: 'min_num_lightning', lbl: 'MIN', options: [
        { v: 1,  label: '1'  },
        { v: 5,  label: '5'  },
        { v: 9,  label: '9'  },
        { v: 16, label: '16' }
      ]}
    ];

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
      expanded, sec, state, bypassRemain, lastSeen, as3935EventIcon, capeColor, summary, action,
      numericTunables, enumTunables, tunableRows, step,
      ackLabel, calibCountdown,
      rebooting, rebootElapsed,
      doRepublish, doCalibrate, doQueryBattery, doReboot, doFactoryReset, testInject
    };
  }
};

// === Top-bar with callsign + clocks ===
const TopBar = {
  template: `
    <div class="topbar">
      <div>
        <div class="callsign">VU2CPL</div>
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
  components: { TopBar, LightningCard },
  template: `
    <div class="conn-pill" :class="{ 'is-connected': connected }">
      <span class="dot"></span>
      <span>{{ connected ? 'LIVE' : 'OFFLINE' }}</span>
    </div>
    <TopBar />
    <div class="dash-grid">
      <LightningCard />
      <!-- More cards go here as we migrate them -->
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
