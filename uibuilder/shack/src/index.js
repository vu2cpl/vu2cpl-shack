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
          <span v-if="state.nf != null">NF=<strong>{{ state.nf }}</strong></span>
          <span v-if="state.uptime">UP <strong>{{ state.uptime }}</strong></span>
          <span v-if="state.irq != null">IRQ=<strong>{{ state.irq }}</strong></span>
          <span v-if="state.vbat != null">🔋 <strong>{{ (state.vbat/1000).toFixed(2) }}V</strong></span>
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
            <label style="font-size:var(--fs-sm);">
              Disconnect threshold: <strong style="color:var(--accent)">{{ state.thresholdKm ?? 40 }} km</strong>
              <input type="range" min="10" max="80" :value="state.thresholdKm ?? 40"
                     @change="action('setThreshold', $event.target.valueAsNumber)" style="width:100%">
            </label>
            <label style="font-size:var(--fs-sm);">
              Reconnect timer: <strong style="color:var(--accent)">{{ state.reconnectMin ?? 20 }} min</strong>
              <input type="range" min="5" max="60" :value="state.reconnectMin ?? 20"
                     @change="action('setReconnect', $event.target.valueAsNumber)" style="width:100%">
            </label>
          </div>
        </div>

        <!-- Collapsible: AS3935 Tunables -->
        <div class="section">
          <div class="section__header" @click="sec.tunables = !sec.tunables">
            <span class="chev">{{ sec.tunables ? '▼' : '▶' }}</span>
            <span>AS3935 Tunables</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.tunables }">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:var(--fs-sm);">
              <label v-for="key in ['nf','wdth','srej','tun_cap','mask_dist','min_num_lightning']" :key="key">
                {{ key }}: <strong style="color:var(--accent)">{{ state.tunables?.[key] ?? '—' }}</strong>
              </label>
              <label>AFE: <strong style="color:var(--accent)">{{ state.tunables?.afe_gb || '—' }}</strong></label>
              <label>Sleep: <strong style="color:var(--accent)">{{ state.tunables?.modem_sleep ?? '—' }}</strong></label>
            </div>
            <div style="font-size:var(--fs-xs);color:var(--muted);">
              Edit via AS3935 cmd channel (todo: inline edit UI)
            </div>
          </div>
        </div>

        <!-- Collapsible: Maintenance -->
        <div class="section">
          <div class="section__header" @click="sec.maint = !sec.maint">
            <span class="chev">{{ sec.maint ? '▼' : '▶' }}</span>
            <span>AS3935 Maintenance</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.maint }">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
              <button class="btn btn--ghost" @click="action('as3935Republish')">Republish Status</button>
              <button class="btn btn--ghost" @click="action('as3935Calibrate')">Calibrate TUN_CAP</button>
              <button class="btn btn--ghost" @click="action('as3935QueryBattery')">Query Battery</button>
              <button class="btn btn--amber" @click="action('as3935Reboot')">Reboot</button>
            </div>
            <button class="btn btn--red" @click="action('as3935FactoryReset')">Factory Reset WiFi</button>
          </div>
        </div>

        <!-- Collapsible: Test Injects -->
        <div class="section">
          <div class="section__header" @click="sec.test = !sec.test">
            <span class="chev">{{ sec.test ? '▼' : '▶' }}</span>
            <span>Test Injects (bench only)</span>
          </div>
          <div class="section__body" :class="{ 'is-collapsed': !sec.test }">
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;">
              <button class="btn btn--ghost" @click="action('testStrike','near')">⚡ Near 5km</button>
              <button class="btn btn--ghost" @click="action('testStrike','far')">⚡ Far 25km</button>
              <button class="btn btn--ghost" @click="action('testStrike','oor')">⚡ OOR 63</button>
              <button class="btn btn--ghost" @click="action('testStrike','disturber')">⚠ Disturber</button>
              <button class="btn btn--ghost" @click="action('testStrike','noise')">📡 Noise</button>
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

    // Operational actions use the same HTTP endpoints D1 uses (proven path).
    // AS3935 maintenance + test injects go via uibuilder → cmd_router.
    function action(type, value) {
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
      // --- uibuilder (AS3935 maintenance + tests) ---
      uibuilder.send({ topic: 'lightning/cmd', payload: { type, value } });
    }

    return { expanded, sec, state, bypassRemain, lastSeen, as3935EventIcon, capeColor, summary, action };
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
