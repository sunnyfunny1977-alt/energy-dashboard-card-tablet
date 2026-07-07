/**
 * HA Energie-Dashboard Analytics — Home Assistant Custom Card (Tablet-Version)
 * Version: 1.0.0  |  Optimiert für Lovelace-Panel / Tablet-Darstellung
 *
 * Zeigt die Daten des eingebauten Home-Assistant-Energie-Dashboards
 * (Langzeit-Statistiken des Recorders) im Stil der Anker SOLIX Tablet-Karte.
 *
 * Installation:
 *   1. Datei nach /config/www/energy-dashboard-card/energy-dashboard-card-tablet.js kopieren
 *   2. In HA Ressource hinzufügen:
 *      URL: /local/energy-dashboard-card/energy-dashboard-card-tablet.js  Typ: JavaScript-Modul
 *   3. Karte hinzufügen:
 *      type: custom:energy-dashboard-card-tablet
 *
 * Datenquellen werden AUTOMATISCH aus der Energie-Dashboard-Konfiguration
 * gelesen (energy/get_prefs): Solar, Netz, Speicher und alle dort
 * eingetragenen Verbraucher-Geräte. Neue Steckdosen/Geräte im
 * Energie-Dashboard erscheinen ohne Anpassung der Karte.
 *
 * Optionale Konfiguration (überschreibt die automatische Erkennung):
 *   type: custom:energy-dashboard-card-tablet
 *   days: 365
 *   energy_price: 0.35
 *   feed_in_tariff: 0.082
 *   system_cost: 1200
 *   exclude_devices:                      # Geräte aus der Anzeige ausblenden
 *     - sensor.poolpumpe_energie_gesamt
 *   solar_sensor: sensor.mein_solar       # auch Listen möglich
 *   grid_import_sensor: sensor.mein_bezug
 *   grid_export_sensor: sensor.meine_einspeisung
 *   battery_in_sensor: sensor.speicher_ladung
 *   battery_out_sensor: sensor.speicher_entladung
 *   devices:                              # ersetzt die automatische Geräteliste
 *     - entity: sensor.kuche_energie_gesamt
 *       name: Küche
 */

(function () {
  'use strict';

  // ── Chart.js laden (shared via window, kein Konflikt mit anderen Karten) ──
  function loadChartJS() {
    if (!window._ankerChartJsReady) {
      if (window.Chart) {
        window._ankerChartJsReady = Promise.resolve();
      } else {
        window._ankerChartJsReady = new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('Chart.js konnte nicht geladen werden.'));
          document.head.appendChild(s);
        });
      }
    }
    return window._ankerChartJsReady;
  }

  // ── Konstanten ─────────────────────────────────────────────────────────────
  const MONTH_NAMES = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  const DEV_COLORS  = ['#FBBF24','#3B82F6','#10B981','#F87171','#818CF8','#F472B6','#fb923c','#2dd4bf','#a3e635','#c084fc'];
  const REST_COLOR  = '#cbd5e1';
  const CO2_FACTOR  = 0.363; // kg CO₂ je kWh genutzter Solarenergie
  const WIN         = 14;    // Tablet zeigt 14 Datenpunkte auf einmal

  // Konfig-Werte können als String oder Liste angegeben werden
  const toArr = (v) => v == null ? [] : (Array.isArray(v) ? v : [v]);

  const BASE_FIELDS = ['gesamtErzeugung','eigenverbrauch','netzimport','einspeisung',
    'speicherLadung','speicherEntladung','genutzteSolar','co2','geraeteSumme','rest'];

  // ── ISO-Kalenderwoche ──────────────────────────────────────────────────────
  function isoWeek(d) {
    const dk = new Date(d); dk.setHours(0,0,0,0);
    dk.setDate(dk.getDate() + 3 - (dk.getDay() + 6) % 7);
    const w1 = new Date(dk.getFullYear(), 0, 4);
    return 1 + Math.round(((dk - w1) / 86400000 - 3 + (w1.getDay() + 6) % 7) / 7);
  }

  function aggregate(data, mode, fields) {
    const g = {};
    data.forEach(r => {
      let key, sk;
      if (mode === 'month' || mode === 'all') { key = `${MONTH_NAMES[r.month-1]} ${r.year}`; sk = r.year*100+r.month; }
      else if (mode === 'year') { key = `${r.year}`; sk = r.year; }
      else { key = `KW ${r.week} ${r.year}`; sk = r.year*100+r.week; }
      if (!g[key]) { g[key] = { datum: key, sortKey: sk }; fields.forEach(f => g[key][f] = 0); }
      fields.forEach(f => { g[key][f] += r[f] || 0; });
    });
    return Object.values(g).sort((a,b) => a.sortKey - b.sortKey);
  }

  // ── Custom Card ────────────────────────────────────────────────────────────
  class EnergyDashboardCardTablet extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._data      = null;
      this._viewMode  = 'day';
      this._scrollIdx = 0;
      this._tab       = 'overview';
      this._price     = 0.35;
      this._cost      = 1200;
      this._feedIn    = 0.082;
      this._settings  = false;
      this._charts    = {};
      this._loading   = true;
      this._error     = null;
      this._updated   = null;
      this._days      = 365;
      this._sensors   = { solar: [], gridImport: [], gridExport: [], batteryIn: [], batteryOut: [] };
      this._devices   = [];
      this._started   = false;
    }

    setConfig(cfg) {
      this._cfg = cfg;
      if (cfg.energy_price)   this._price  = parseFloat(cfg.energy_price);
      if (cfg.system_cost)    this._cost   = parseFloat(cfg.system_cost);
      if (cfg.feed_in_tariff) this._feedIn = parseFloat(cfg.feed_in_tariff);
      if (cfg.days)           this._days   = parseInt(cfg.days);
      this._render();
      this._maybeLoad();
    }

    set hass(h) { this._hass = h; this._maybeLoad(); }
    getCardSize() { return 18; }

    _maybeLoad() {
      if (this._started || !this._hass || !this._cfg) return;
      this._started = true;
      this._load();
    }

    _devFields() { return this._devices.map((_, i) => `dev${i}`); }
    _fields()    { return BASE_FIELDS.concat(this._devFields()); }

    // ── Quellen aus der Energie-Dashboard-Konfiguration ermitteln ──────────
    async _resolveSources() {
      const cfg = this._cfg || {};
      const hasSensorOverride = cfg.solar_sensor || cfg.grid_import_sensor || cfg.grid_export_sensor
        || cfg.battery_in_sensor || cfg.battery_out_sensor;
      const hasDeviceOverride = Array.isArray(cfg.devices) && cfg.devices.length;

      let prefs = null;
      if (!hasSensorOverride || !hasDeviceOverride) {
        try { prefs = await this._hass.callWS({ type: 'energy/get_prefs' }); }
        catch (e) { prefs = null; }
      }

      // Energie-Quellen (Solar/Netz/Speicher) — beide Prefs-Formate abdecken
      const s = { solar: [], gridImport: [], gridExport: [], batteryIn: [], batteryOut: [] };
      (prefs?.energy_sources || []).forEach(src => {
        if (src.type === 'solar' && src.stat_energy_from) s.solar.push(src.stat_energy_from);
        if (src.type === 'grid') {
          if (src.stat_energy_from) s.gridImport.push(src.stat_energy_from);
          if (src.stat_energy_to)   s.gridExport.push(src.stat_energy_to);
          (src.flow_from || []).forEach(f => f.stat_energy_from && s.gridImport.push(f.stat_energy_from));
          (src.flow_to   || []).forEach(f => f.stat_energy_to   && s.gridExport.push(f.stat_energy_to));
        }
        if (src.type === 'battery') {
          if (src.stat_energy_to)   s.batteryIn.push(src.stat_energy_to);
          if (src.stat_energy_from) s.batteryOut.push(src.stat_energy_from);
        }
      });
      if (cfg.solar_sensor)       s.solar      = toArr(cfg.solar_sensor);
      if (cfg.grid_import_sensor) s.gridImport = toArr(cfg.grid_import_sensor);
      if (cfg.grid_export_sensor) s.gridExport = toArr(cfg.grid_export_sensor);
      if (cfg.battery_in_sensor)  s.batteryIn  = toArr(cfg.battery_in_sensor);
      if (cfg.battery_out_sensor) s.batteryOut = toArr(cfg.battery_out_sensor);
      this._sensors = s;

      // Verbraucher-Geräte: automatisch aus dem Energie-Dashboard,
      // per devices: ersetzbar, per exclude_devices: filterbar
      let devices;
      if (hasDeviceOverride) {
        devices = cfg.devices.map(d => ({ entity: d.entity, name: d.name || d.entity }));
      } else {
        devices = (prefs?.device_consumption || []).map(d => ({
          entity: d.stat_consumption,
          name: d.name
            || this._hass.states?.[d.stat_consumption]?.attributes?.friendly_name
            || d.stat_consumption,
        }));
      }
      const excl = toArr(cfg.exclude_devices);
      if (excl.length) devices = devices.filter(d => !excl.includes(d.entity));
      this._devices = devices;

      if (!s.solar.length && !s.gridImport.length) {
        throw new Error('Keine Energie-Quellen gefunden. Bitte das Energie-Dashboard in Home Assistant konfigurieren oder Sensoren in der Karten-Konfiguration angeben.');
      }
    }

    // ── Langzeit-Statistiken laden ─────────────────────────────────────────
    async _load() {
      this._loading = true; this._error = null; this._render();
      try {
        await loadChartJS();
        if (!this._hass) throw new Error('Keine Verbindung zu Home Assistant.');

        await this._resolveSources();

        const ids = [
          ...this._sensors.solar, ...this._sensors.gridImport, ...this._sensors.gridExport,
          ...this._sensors.batteryIn, ...this._sensors.batteryOut,
          ...this._devices.map(d => d.entity),
        ].filter(Boolean);

        const end   = new Date();
        const start = new Date(end.getTime() - this._days * 86400000);

        const stats = await this._hass.callWS({
          type: 'recorder/statistics_during_period',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          statistic_ids: ids,
          period: 'day',
          types: ['change'],
          units: { energy: 'kWh' },
        });

        this._data    = this._buildRows(stats);
        this._updated = new Date();
        this._scrollIdx = Math.max(0, this._data.length - WIN);
      } catch (e) { this._error = e.message || String(e); }
      this._loading = false; this._render(); this._drawCharts();
    }

    _buildRows(stats) {
      // Pro Sensor & Tag das Energie-Delta ('change') einsammeln
      const days = {}; // key 'YYYY-MM-DD' -> { ts, values: {statId: kWh} }
      Object.keys(stats || {}).forEach(id => {
        (stats[id] || []).forEach(p => {
          const t = new Date(p.start);
          if (isNaN(t.getTime())) return;
          const key = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
          if (!days[key]) days[key] = { ts: new Date(t.getFullYear(), t.getMonth(), t.getDate()), values: {} };
          const v = typeof p.change === 'number' ? p.change : 0;
          days[key].values[id] = (days[key].values[id] || 0) + Math.max(0, v);
        });
      });

      const s = this._sensors;
      const rows = Object.values(days).sort((a,b) => a.ts - b.ts).map(day => {
        const g   = (id)  => day.values[id] || 0;
        const sum = (ids) => ids.reduce((a, id) => a + g(id), 0);
        const solar = sum(s.solar), imp = sum(s.gridImport), exp = sum(s.gridExport),
              spLad = sum(s.batteryIn), spEnt = sum(s.batteryOut);
        const cons  = Math.max(0, imp + solar + spEnt - spLad - exp);
        const gut   = Math.max(0, solar - exp);
        const d     = day.ts;
        const row = {
          datum: d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' }),
          ts: d, week: isoWeek(d), month: d.getMonth() + 1, year: d.getFullYear(),
          gesamtErzeugung: solar, eigenverbrauch: cons,
          netzimport: imp, einspeisung: exp,
          speicherLadung: spLad, speicherEntladung: spEnt,
          genutzteSolar: gut, co2: gut * CO2_FACTOR,
        };
        let devSum = 0;
        this._devices.forEach((dev, i) => { const v = g(dev.entity); row[`dev${i}`] = v; devSum += v; });
        row.geraeteSumme = devSum;
        row.rest = Math.max(0, cons - devSum);
        return row;
      }).filter(r => (r.gesamtErzeugung + r.eigenverbrauch + r.netzimport + r.einspeisung) > 0.005);

      if (!rows.length) throw new Error('Keine Energie-Statistiken im gewählten Zeitraum gefunden.');
      return rows;
    }

    _agg()    { return this._data ? aggregate(this._data, this._viewMode, this._fields()) : []; }
    _srcLen() { return this._data ? (this._viewMode === 'day' ? this._data.length : this._agg().length) : 0; }

    _window() {
      if (!this._data) return [];
      const src = this._viewMode === 'day' ? this._data : this._agg();
      if (['year','all'].includes(this._viewMode)) return this._agg();
      return src.slice(this._scrollIdx, this._scrollIdx + WIN);
    }

    _stats() {
      if (!this._data?.length) return null;
      const win  = this._window();
      const base = this._viewMode === 'all' ? this._agg() : win;
      if (!base.length) return null;
      const last = ['day','week'].includes(this._viewMode) && win.length;
      const src  = last ? [win[win.length-1]] : base;
      const s    = (k) => src.reduce((a,c) => a+(c[k]||0), 0);

      const gen=s('gesamtErzeugung'), cons=s('eigenverbrauch'),
            imp=s('netzimport'),      exp=s('einspeisung'),
            co2=s('co2'),             gut=s('genutzteSolar'),
            sLad=s('speicherLadung'), sEnt=s('speicherEntladung');

      const dir  = Math.max(0, cons - imp);
      const sav  = dir  * this._price;
      const fRev = exp  * this._feedIn;
      const tot  = sav  + fRev;
      const roi  = this._cost > 0 ? tot / this._cost * 100 : 0;

      return {
        gen: gen.toFixed(2), cons: cons.toFixed(2), imp: imp.toFixed(2), exp: exp.toFixed(2),
        co2: co2.toFixed(1), sav: sav.toFixed(2), fRev: fRev.toFixed(2), tot: tot.toFixed(2),
        roi: roi.toFixed(1),
        aut:  (cons > 0 ? dir/cons*100 : 0).toFixed(1),
        evq:  (gen  > 0 ? gut/gen*100  : 0).toFixed(1),
        spEff:(sLad > 0 ? sEnt/sLad*100 : 0).toFixed(1),
        period: last ? win[win.length-1]?.datum : null,
      };
    }

    _records() {
      if (!this._data?.length) return null;
      let mGen={v:0,d:'-'}, mAut={v:0,d:'-'};
      this._data.forEach(r => {
        if (r.gesamtErzeugung > mGen.v) mGen = {v:r.gesamtErzeugung, d:r.datum};
        if (r.eigenverbrauch > 0.5) {
          const a = Math.max(0,r.eigenverbrauch-r.netzimport)/r.eigenverbrauch*100;
          if (a > mAut.v) mAut = {v:a, d:r.datum};
        }
      });
      return { mGen, mAut };
    }

    // ── Render ──────────────────────────────────────────────────────────────
    _render() {
      const st  = this._stats();
      const rec = this._records();
      const win = this._window();
      const srcLen = this._srcLen();
      const showSlider = this._data && !['year','all'].includes(this._viewMode) && srcLen > WIN;

      this.shadowRoot.innerHTML = `<style>${CSS}</style><ha-card><div class="cc">${
        this._loading ? T.loading() :
        this._error   ? T.error(this._error) :
        this._data    ? T.dashboard(this, st, rec, win, showSlider, srcLen) : ''
      }</div></ha-card>`;

      this._bind();
    }

    _bind() {
      const r = this.shadowRoot;
      r.getElementById('btn-retry')?.addEventListener('click', () => this._load());
      r.getElementById('btn-reload')?.addEventListener('click', () => this._load());
      r.getElementById('btn-settings')?.addEventListener('click', () => {
        this._settings = !this._settings; this._render(); this._drawCharts();
      });
      r.querySelectorAll('.vm-btn').forEach(b => b.addEventListener('click', () => {
        this._viewMode = b.dataset.mode;
        this._scrollIdx = Math.max(0, this._srcLen() - WIN);
        this._render(); this._drawCharts();
      }));
      r.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => {
        this._tab = b.dataset.tab; this._render(); this._drawCharts();
      }));
      const slider = r.getElementById('time-slider');
      if (slider) {
        slider.addEventListener('input', (e) => {
          this._scrollIdx = parseInt(e.target.value);
          const w = this._window();
          const lbl = r.querySelector('.slider-label');
          if (lbl) lbl.textContent = `${w[0]?.datum||'?'} — ${w[w.length-1]?.datum||'?'}`;
          this._drawCharts();
        });
      }
      ['energy-price','feed-in-tariff','system-cost'].forEach(id => {
        r.getElementById(id)?.addEventListener('change', (e) => {
          const v = parseFloat(e.target.value); if (isNaN(v)) return;
          if (id === 'energy-price')   this._price  = v;
          if (id === 'feed-in-tariff') this._feedIn = v;
          if (id === 'system-cost')    this._cost   = v;
          this._render(); this._drawCharts();
        });
      });
    }

    // ── Charts ──────────────────────────────────────────────────────────────
    _kill() { Object.values(this._charts).forEach(c => { try { c.destroy(); } catch(_){} }); this._charts = {}; }

    _drawCharts() {
      if (!this._data || !window.Chart) return;
      this._kill();
      const r   = this.shadowRoot;
      const win = this._window();
      const lbl = win.map(d => d.datum);
      const mk  = (id, cfg) => { const el = r.getElementById(id); if (el) this._charts[id] = new Chart(el, cfg); };
      const opt = this._opts.bind(this);
      const devs = this._devices;

      if (this._tab === 'overview') {
        mk('c-flow', { type:'line', data:{ labels:lbl, datasets:[
          { label:'Solar erzeugt', data:win.map(d=>d.gesamtErzeugung), borderColor:'#FBBF24', backgroundColor:'rgba(251,191,36,.15)', fill:true, tension:.3, pointRadius:3, pointHoverRadius:6 },
          { label:'Hausverbrauch', data:win.map(d=>d.eigenverbrauch),  borderColor:'#3B82F6', backgroundColor:'rgba(59,130,246,.15)',  fill:true, tension:.3, pointRadius:3, pointHoverRadius:6 },
          { label:'Netzbezug',     data:win.map(d=>d.netzimport),      borderColor:'#f43f5e', backgroundColor:'rgba(244,63,94,.08)',   fill:true, borderDash:[5,5], tension:.3, pointRadius:3, pointHoverRadius:6 },
        ]}, options: opt('kWh') });

        const devRaw = devs.map((dv,i)=>({n:dv.name,v:win.reduce((a,d)=>a+(d[`dev${i}`]||0),0),c:DEV_COLORS[i%DEV_COLORS.length]})).filter(p=>p.v>0.001);
        const restV  = win.reduce((a,d)=>a+(d.rest||0),0);
        if (restV > 0.001) devRaw.push({n:'Nicht gemessen', v:restV, c:REST_COLOR});
        if (devRaw.length) mk('c-devpie', { type:'doughnut', data:{
          labels: devRaw.map(p=>p.n),
          datasets:[{ data:devRaw.map(p=>p.v), backgroundColor:devRaw.map(p=>p.c), borderWidth:3, hoverOffset:8 }]
        }, options:{ responsive:true, maintainAspectRatio:false, cutout:'62%',
          plugins:{ legend:{ position:'bottom', labels:{ font:{size:11}, padding:10 }},
            tooltip:{ callbacks:{ label:c=>`${c.label}: ${c.raw.toFixed(2)} kWh` }}}
        }});

        mk('c-aut', { type:'bar', data:{ labels:lbl, datasets:[
          { label:'Solar genutzt (kWh)', data:win.map(d=>d.genutzteSolar),  backgroundColor:'rgba(16,185,129,.75)', borderRadius:4 },
          { label:'Einspeisung (kWh)',   data:win.map(d=>d.einspeisung),    backgroundColor:'rgba(129,140,248,.75)', borderRadius:4 },
        ]}, options: opt('kWh') });

        mk('c-ertrag', { data:{ labels:lbl, datasets:[
          { type:'bar',  label:'Ersparter Strom (€)',   data:win.map(d=>+(Math.max(0,d.eigenverbrauch-d.netzimport)*this._price).toFixed(3)), backgroundColor:'rgba(16,185,129,.75)', borderRadius:4, yAxisID:'y' },
          { type:'bar',  label:'Einspeisevergütung (€)',data:win.map(d=>+((d.einspeisung||0)*this._feedIn).toFixed(3)), backgroundColor:'rgba(129,140,248,.75)', borderRadius:4, yAxisID:'y' },
          { type:'line', label:'Gesamt (€)', data:win.map(d=>+(Math.max(0,d.eigenverbrauch-d.netzimport)*this._price+(d.einspeisung||0)*this._feedIn).toFixed(3)), borderColor:'#f59e0b', borderWidth:3, pointRadius:0, tension:.3, yAxisID:'y2' },
        ]}, options:{ ...opt('€'), scales:{ x:{ticks:{font:{size:11}},grid:{display:false}}, y:{ticks:{font:{size:11},callback:v=>v.toFixed(2)+' €'},grid:{color:'rgba(0,0,0,.04)'}}, y2:{position:'right',ticks:{font:{size:11},callback:v=>v.toFixed(2)+' €'},grid:{display:false}} }}});
      }

      if (this._tab === 'devices') {
        mk('c-devstack', { type:'bar', data:{ labels:lbl, datasets:[
          ...devs.map((dv,i) => ({ label:dv.name, data:win.map(d=>d[`dev${i}`]||0), backgroundColor:DEV_COLORS[i%DEV_COLORS.length], stack:'d' })),
          { label:'Nicht gemessen', data:win.map(d=>d.rest||0), backgroundColor:REST_COLOR, stack:'d', borderRadius:4 },
        ]}, options: opt('kWh') });

        const totals = devs.map((dv,i)=>({n:dv.name,v:win.reduce((a,d)=>a+(d[`dev${i}`]||0),0),c:DEV_COLORS[i%DEV_COLORS.length]}))
          .sort((a,b)=>b.v-a.v);
        mk('c-devtot', { type:'bar', data:{ labels:totals.map(t=>t.n), datasets:[
          { label:'Verbrauch (kWh)', data:totals.map(t=>t.v), backgroundColor:totals.map(t=>t.c), borderRadius:6 },
        ]}, options:{ responsive:true, maintainAspectRatio:false, indexAxis:'y',
          plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:c=>`${c.raw.toFixed(2)} kWh` }}},
          scales:{ x:{ticks:{font:{size:11},callback:v=>v.toFixed(1)+' kWh'},grid:{color:'rgba(0,0,0,.04)'}}, y:{ticks:{font:{size:11}},grid:{display:false}} }
        }});

        mk('c-devshare', { type:'bar', data:{ labels:lbl, datasets:[
          { label:'Gemessen (Geräte)', data:win.map(d=>d.geraeteSumme||0), backgroundColor:'rgba(16,185,129,.75)', stack:'s' },
          { label:'Nicht gemessen',    data:win.map(d=>d.rest||0),         backgroundColor:REST_COLOR,             stack:'s', borderRadius:4 },
        ]}, options: opt('kWh') });
      }

      if (this._tab === 'storage') {
        mk('c-spch', { type:'bar', data:{ labels:lbl, datasets:[
          { label:'Laden (kWh)',   data:win.map(d=>d.speicherLadung),    backgroundColor:'#10B981', borderRadius:4 },
          { label:'Entladen (kWh)',data:win.map(d=>d.speicherEntladung), backgroundColor:'#FBBF24', borderRadius:4 },
        ]}, options: opt('kWh') });

        mk('c-speff', { data:{ labels:lbl, datasets:[
          { type:'bar',  label:'Ladung (kWh)',    data:win.map(d=>d.speicherLadung),    backgroundColor:'rgba(16,185,129,.5)', borderRadius:3, yAxisID:'y' },
          { type:'bar',  label:'Entladung (kWh)', data:win.map(d=>d.speicherEntladung), backgroundColor:'rgba(251,191,36,.5)', borderRadius:3, yAxisID:'y' },
          { type:'line', label:'Effizienz (%)',   data:win.map(d=>d.speicherLadung>0.01?Math.min(120,d.speicherEntladung/d.speicherLadung*100):null), borderColor:'#818CF8', borderWidth:2.5, pointRadius:4, pointBackgroundColor:'#818CF8', yAxisID:'y2' },
        ]}, options:{ responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false}, plugins:{legend:{labels:{font:{size:12}}}}, scales:{ x:{ticks:{font:{size:11}},grid:{display:false}}, y:{ticks:{font:{size:11},callback:v=>v.toFixed(1)+' kWh'},grid:{color:'rgba(0,0,0,.04)'}}, y2:{position:'right',min:0,max:120,ticks:{font:{size:11},callback:v=>v+'%'},grid:{display:false}} }}});

        mk('c-grid', { type:'bar', data:{ labels:lbl, datasets:[
          { label:'Netzbezug (kWh)',    data:win.map(d=>d.netzimport),  backgroundColor:'#f43f5e', borderRadius:4 },
          { label:'Einspeisung (kWh)',  data:win.map(d=>d.einspeisung), backgroundColor:'#818CF8', borderRadius:4 },
        ]}, options: opt('kWh') });
      }

      if (this._tab === 'co2') {
        mk('c-co2', { type:'line', data:{ labels:lbl, datasets:[{ label:'CO₂ gespart', data:win.map(d=>d.co2), borderColor:'#10B981', backgroundColor:'rgba(16,185,129,.2)', fill:true, tension:.3, pointRadius:3 }]}, options: opt('kg') });

        mk('c-co2sol', { data:{ labels:lbl, datasets:[
          { type:'bar',  label:'Erzeugung (kWh)',  data:win.map(d=>d.gesamtErzeugung), backgroundColor:'rgba(251,191,36,.7)', borderRadius:3, yAxisID:'y' },
          { type:'line', label:'CO₂ gespart (kg)', data:win.map(d=>d.co2),             borderColor:'#10B981', borderWidth:2.5, pointRadius:0, tension:.3, yAxisID:'y2' },
        ]}, options:{ responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false}, plugins:{legend:{labels:{font:{size:12}}}}, scales:{ x:{ticks:{font:{size:11}},grid:{display:false}}, y:{ticks:{font:{size:11},callback:v=>v.toFixed(1)+' kWh'},grid:{color:'rgba(0,0,0,.04)'}}, y2:{position:'right',ticks:{font:{size:11},callback:v=>v.toFixed(1)+' kg'},grid:{display:false}} }}});
      }

      if (this._tab === 'heatmap') {
        const monthly = {};
        this._data.forEach(d => {
          const k = `${MONTH_NAMES[d.month-1]} ${d.year}`;
          if (!monthly[k]) monthly[k] = {datum:k,gesamtErzeugung:0,eigenverbrauch:0,netzimport:0,sort:d.year*100+d.month};
          monthly[k].gesamtErzeugung += d.gesamtErzeugung;
          monthly[k].eigenverbrauch  += d.eigenverbrauch;
          monthly[k].netzimport      += d.netzimport;
        });
        const md = Object.values(monthly).sort((a,b)=>a.sort-b.sort);
        mk('c-monthly', { type:'bar', data:{ labels:md.map(d=>d.datum), datasets:[
          { label:'Solar erzeugt', data:md.map(d=>d.gesamtErzeugung), backgroundColor:'#FBBF24', borderRadius:5 },
          { label:'Hausverbrauch', data:md.map(d=>d.eigenverbrauch),  backgroundColor:'#3B82F6', borderRadius:5 },
          { label:'Netzbezug',     data:md.map(d=>d.netzimport),      backgroundColor:'#f43f5e', borderRadius:5 },
        ]}, options: opt('kWh') });
      }
    }

    _opts(unit = 'kWh') {
      return {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { font: { size: 12 }, padding: 14 } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${typeof c.raw==='number'?c.raw.toFixed(2):c.raw} ${unit}` } }
        },
        scales: {
          x: { ticks: { font: { size: 11 } }, grid: { display: false } },
          y: { ticks: { font: { size: 11 }, callback: v => v.toFixed(1)+' '+unit }, grid: { color: 'rgba(0,0,0,.04)' } }
        }
      };
    }
  }

  // ── Templates ──────────────────────────────────────────────────────────────
  const T = {
    loading: () => `<div class="loading"><div class="spinner"></div><p>Lade Energie-Statistiken…</p></div>`,

    error: (msg) => `
      <div class="err-box">
        <div class="err-ic">⚠️</div><h3>Fehler beim Laden</h3>
        <p>${msg}</p>
        <button id="btn-retry">🔄 Erneut versuchen</button>
      </div>`,

    dashboard: (card, st, rec, win, showSlider, srcLen) => `
      ${T.header(card)}
      ${card._settings ? T.settings(card) : ''}
      ${st ? T.statGrid(st, rec) : ''}
      ${T.tabs(card._tab)}
      ${showSlider ? T.slider(card._scrollIdx, srcLen, win) : ''}
      <div class="tab-content">
        ${card._tab==='overview' ? T.overview()          : ''}
        ${card._tab==='devices'  ? T.devices()            : ''}
        ${card._tab==='storage'  ? T.storage()            : ''}
        ${card._tab==='co2'      ? T.co2(card._data)      : ''}
        ${card._tab==='heatmap'  ? T.heatmap(card._data)  : ''}
        ${card._tab==='table'    ? T.table(win)           : ''}
      </div>
      <div class="footer">HOME ASSISTANT Energie-Statistiken · Quellen automatisch aus dem Energie-Dashboard · ${card._days} Tage${card._updated?' · ⟳ '+card._updated.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}):''}</div>`,

    header: (c) => `
      <div class="hdr">
        <div class="hdr-left">
          <div class="logo"><span class="la">ENERGIE</span><span class="ls">HOME</span></div>
          <div class="hdr-sub">
            SYSTEM <em>ANALYTICS</em>
            <span class="badge">${c._data?.length} Tage · ${c._devices.length} Geräte · ${WIN} Datenpunkte/Ansicht</span>
            ${c._updated?`<span class="badge-s">⟳ ${c._updated.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</span>`:''}
          </div>
        </div>
        <div class="hdr-right">
          <button class="btn-ic" id="btn-settings">⚙️ Einstellungen</button>
          <button class="btn-ic" id="btn-reload">🔄 Aktualisieren</button>
          <div class="vm-grp">
            ${['day','week','month','year','all'].map(m=>`
              <button class="vm-btn ${c._viewMode===m?'active':''}" data-mode="${m}">
                ${m==='day'?'Tag':m==='week'?'Woche':m==='month'?'Monat':m==='year'?'Jahr':'Alle'}
              </button>`).join('')}
          </div>
        </div>
      </div>`,

    settings: (c) => `
      <div class="settings">
        <h3>⚙️ ROI &amp; Tarif-Einstellungen</h3>
        <div class="sg">
          <div class="si"><label>⚡ Strompreis (€/kWh)</label>
            <input id="energy-price"   type="number" min="0.001" max="2"   step="0.001" value="${c._price.toFixed(3)}"/></div>
          <div class="si"><label>📈 Einspeisevergütung (€/kWh)</label>
            <input id="feed-in-tariff" type="number" min="0"     max="0.5" step="0.001" value="${c._feedIn.toFixed(3)}"/></div>
          <div class="si"><label>💶 Anlagenkosten (€)</label>
            <input id="system-cost"    type="number" min="0"     step="100"             value="${c._cost}"/></div>
        </div>
      </div>`,

    statGrid: (st, rec) => {
      const cards = [
        { icon:'💶', title:st.period?`Gesamtertrag (${st.period})`:'Gesamtertrag (ROI)', val:`${st.tot} €`, hi:true,
          kpi1:'ROI', kpi1v:`${st.roi}%`, kpi2:'Ersparnis', kpi2v:`${st.sav} €`, kpi3:'Einspeisung', kpi3v:`${st.fRev} €` },
        { icon:'☀️', title:st.period?`Erzeugung (${st.period})`:'Solarproduktion', val:`${st.gen} kWh`,
          kpi1:'Eingespeist', kpi1v:`${st.exp} kWh`, kpi2:'EV-Quote', kpi2v:`${st.evq}%` },
        { icon:'🏠', title:'Hausverbrauch', val:`${st.cons} kWh`,
          kpi1:'Netzbezug', kpi1v:`${st.imp} kWh`, kpi2:'Eigenanteil', kpi2v:`${(parseFloat(st.aut)).toFixed(1)}%` },
        { icon:'🛡️', title:'Autarkiequote', val:`${st.aut}%`,
          kpi1:'EV-Quote', kpi1v:`${st.evq}%`, kpi2:'Sp.-Eff.', kpi2v:`${st.spEff}%` },
        { icon:'🌿', title:'CO₂-Einsparung', val:`${st.co2} kg`,
          kpi1:'Ø/Tag', kpi1v:`${(parseFloat(st.co2)/Math.max(1,14)).toFixed(2)} kg` },
      ];
      if (rec) cards.push({ icon:'🏆', title:'Rekorde', val:`${rec.mGen.v.toFixed(2)} kWh`, gold:true,
        kpi1:'Peak-Tag', kpi1v:rec.mGen.d, kpi2:'Max. Autarkie', kpi2v:`${rec.mAut.v.toFixed(1)}%` });

      return `<div class="stat-grid">${cards.map(c=>`
        <div class="sc ${c.hi?'hi':''} ${c.gold?'gold':''}">
          <div class="sc-top">
            <span class="sc-icon">${c.icon}</span>
            <span class="sc-ttl">${c.title}</span>
          </div>
          <div class="sc-val">${c.val}</div>
          <div class="sc-kpis">
            ${c.kpi1?`<div class="kpi"><span class="kpi-l">${c.kpi1}</span><span class="kpi-v">${c.kpi1v}</span></div>`:''}
            ${c.kpi2?`<div class="kpi"><span class="kpi-l">${c.kpi2}</span><span class="kpi-v">${c.kpi2v}</span></div>`:''}
            ${c.kpi3?`<div class="kpi"><span class="kpi-l">${c.kpi3}</span><span class="kpi-v">${c.kpi3v}</span></div>`:''}
          </div>
        </div>`).join('')}</div>`;
    },

    tabs: (active) => `
      <div class="tabs">
        ${[{id:'overview',l:'📊 Übersicht'},{id:'devices',l:'🔌 Geräte'},{id:'storage',l:'🔋 Speicher'},
           {id:'co2',l:'🌿 CO₂'},{id:'heatmap',l:'📅 Heatmap'},{id:'table',l:'📋 Tabelle'}]
          .map(t=>`<button class="tab-btn ${active===t.id?'active':''}" data-tab="${t.id}">${t.l}</button>`).join('')}
      </div>`,

    slider: (idx, srcLen, win) => `
      <div class="slider-wrap">
        <span class="sl-ic">📆</span>
        <div class="sl-range">
          <input id="time-slider" type="range" min="0" max="${Math.max(0,srcLen-WIN)}" value="${idx}"/>
          <div class="sl-ticks">
            <span>${win[0]?.datum||'?'}</span>
            <span class="slider-label">${win[0]?.datum||'?'} — ${win[win.length-1]?.datum||'?'}</span>
            <span>${win[win.length-1]?.datum||'?'}</span>
          </div>
        </div>
      </div>`,

    // ── Tab: Übersicht (3-Spalten wie Vorlage) ──────────────────────────────
    overview: () => `
      <div class="row3">
        <div class="span2 ccard">
          <div class="ch3"><h3>📈 Energiefluss</h3></div>
          <div class="cw tall"><canvas id="c-flow"></canvas></div>
        </div>
        <div class="ccard">
          <div class="ch3"><h3>🥧 Verbrauchs-Verteilung</h3></div>
          <div class="cw mid"><canvas id="c-devpie"></canvas></div>
        </div>
      </div>
      <div class="row3">
        <div class="span2 ccard">
          <div class="ch3"><h3>🛡️ Autarkie &amp; Eigenverbrauchsquote</h3></div>
          <div class="cw std"><canvas id="c-aut"></canvas></div>
        </div>
        <div class="ccard">
          <div class="ch3"><h3>💶 Ertragsübersicht</h3></div>
          <div class="cw std"><canvas id="c-ertrag"></canvas></div>
        </div>
      </div>`,

    // ── Tab: Geräte ──────────────────────────────────────────────────────────
    devices: () => `
      <div class="row3">
        <div class="span2 ccard">
          <div class="ch3"><h3>🔌 Geräteverbrauch im Zeitverlauf</h3><p class="csub">Gestapelter Verbrauch der Energie-Dashboard-Geräte + nicht gemessener Rest</p></div>
          <div class="cw tall"><canvas id="c-devstack"></canvas></div>
        </div>
        <div class="ccard">
          <div class="ch3"><h3>🏅 Top-Verbraucher</h3><p class="csub">Summe im gewählten Zeitfenster</p></div>
          <div class="cw tall"><canvas id="c-devtot"></canvas></div>
        </div>
      </div>
      <div class="row1 ccard">
        <div class="ch3"><h3>📐 Gemessen vs. nicht gemessen</h3><p class="csub">Anteil des Hausverbrauchs, der über Geräte-Sensoren erfasst wird</p></div>
        <div class="cw std"><canvas id="c-devshare"></canvas></div>
      </div>`,

    // ── Tab: Speicher (3 gleiche Spalten) ────────────────────────────────────
    storage: () => `
      <div class="row3">
        <div class="ccard">
          <div class="ch3"><h3>🔋 Speicher Laden &amp; Entladen</h3></div>
          <div class="cw tall"><canvas id="c-spch"></canvas></div>
        </div>
        <div class="ccard">
          <div class="ch3"><h3>↔️ Speicher-Effizienz (Lade/Entlade-Ratio)</h3></div>
          <div class="cw tall"><canvas id="c-speff"></canvas></div>
        </div>
        <div class="ccard">
          <div class="ch3"><h3>🔌 Netzbezug vs. Einspeisung</h3></div>
          <div class="cw tall"><canvas id="c-grid"></canvas></div>
        </div>
      </div>`,

    // ── Tab: CO₂ ────────────────────────────────────────────────────────────
    co2: (data) => {
      if (!data) return '';
      const total = data.reduce((a,c)=>a+(c.co2||0),0);
      const avg   = total / data.length;
      return `
        <div class="co2-kpis">
          <div class="co2k"><div class="co2i">🌿</div><div class="co2l">Gesamte CO₂-Einsparung</div><div class="co2v">${total.toFixed(1)} kg</div></div>
          <div class="co2k"><div class="co2i">📅</div><div class="co2l">Ø CO₂ pro Tag</div><div class="co2v">${avg.toFixed(2)} kg/Tag</div></div>
          <div class="co2k"><div class="co2i">🌳</div><div class="co2l">Entspricht ca.</div><div class="co2v">${(total/21).toFixed(0)} Bäume/Jahr</div></div>
          <div class="co2k"><div class="co2i">🏭</div><div class="co2l">CO₂-Faktor genutzt</div><div class="co2v">${CO2_FACTOR} kg/kWh</div></div>
        </div>
        <div class="row3">
          <div class="span2 ccard">
            <div class="ch3"><h3>🌿 CO₂-Einsparung im Zeitverlauf</h3></div>
            <div class="cw tall"><canvas id="c-co2"></canvas></div>
          </div>
          <div class="ccard">
            <div class="ch3"><h3>⚡ Solar-Erzeugung vs. CO₂</h3></div>
            <div class="cw tall"><canvas id="c-co2sol"></canvas></div>
          </div>
        </div>`;
    },

    // ── Tab: Heatmap + Monatsvergleich ───────────────────────────────────────
    heatmap: (data) => {
      if (!data) return '';
      const maxG = Math.max(...data.map(d=>d.gesamtErzeugung), 0.01);
      const best = data.reduce((b,d)=>d.gesamtErzeugung>b.gesamtErzeugung?d:b, data[0]);

      const months = {};
      data.forEach(d => {
        const k = `${d.year}-${String(d.month).padStart(2,'0')}`;
        if (!months[k]) months[k] = {year:d.year,month:d.month,days:{}};
        months[k].days[d.ts.getDate()] = d.gesamtErzeugung;
      });
      const sm = Object.values(months).sort((a,b)=>a.year*100+a.month-(b.year*100+b.month));

      const col = v => {
        if (!v) return '#f1f5f9';
        const t = Math.min(v/maxG,1);
        return t<.2?'#fef3c7':t<.4?'#fde68a':t<.6?'#fbbf24':t<.8?'#f59e0b':'#d97706';
      };

      const hmHtml = sm.map(md => {
        const off = (new Date(md.year,md.month-1,1).getDay()+6)%7;
        const dim = new Date(md.year,md.month,0).getDate();
        const cells = [...Array(off).fill(null),...Array.from({length:dim},(_,i)=>i+1)];
        return `
          <div class="hm-month">
            <div class="hm-lbl">${MONTH_NAMES[md.month-1]} ${md.year}</div>
            <div class="hm-grid">
              ${['Mo','Di','Mi','Do','Fr','Sa','So'].map(d=>`<div class="hm-dow">${d}</div>`).join('')}
              ${cells.map(day => {
                if (!day) return '<div class="hm-c empty"></div>';
                const isBest = md.year===best.year && md.month===best.month && day===best.ts.getDate();
                const v = md.days[day]||0;
                return `<div class="hm-c" style="background:${col(v)}"
                  title="${String(day).padStart(2,'0')}.${String(md.month).padStart(2,'0')}.${md.year}: ${v.toFixed(2)} kWh${isBest?' ★ Bester Tag':''}">
                  ${isBest?'<span class="hm-star">★</span>':`<span class="hm-day">${day}</span>`}
                </div>`;
              }).join('')}
            </div>
          </div>`;
      }).join('');

      return `
        <div class="ccard hm-card">
          <div class="ch3">
            <h3>📅 Produktions-Kalender</h3>
            <p class="csub">Jede Zelle = Solarproduktion des Tages. Farbe = Intensität relativ zum Besttag (${maxG.toFixed(1)} kWh).</p>
          </div>
          <div class="hm-scroll">
            <div class="hm-months">${hmHtml}</div>
          </div>
          <div class="hm-legend">
            <span>Niedrig</span>
            ${['#fef3c7','#fde68a','#fbbf24','#f59e0b','#d97706'].map(c=>`<div class="leg-c" style="background:${c}"></div>`).join('')}
            <span>Hoch</span>
            <span class="leg-star">★ Bester Tag: ${best.datum} · ${maxG.toFixed(2)} kWh</span>
          </div>
        </div>
        <div class="row1 ccard" style="margin-top:12px">
          <div class="ch3"><h3>📊 Monats-Vergleich (Gesamt)</h3></div>
          <div class="cw tall"><canvas id="c-monthly"></canvas></div>
        </div>`;
    },

    // ── Tab: Tabelle ─────────────────────────────────────────────────────────
    table: (win) => {
      const rows = win.slice().reverse().map(d => {
        const dir = Math.max(0, d.eigenverbrauch - d.netzimport);
        const aut = d.eigenverbrauch > 0 ? (dir/d.eigenverbrauch*100).toFixed(1) : '-';
        const f2 = v => (v||0).toFixed(2);
        return `<tr>
          <td class="td-d">${d.datum}</td>
          <td class="td-s">${f2(d.gesamtErzeugung)}</td>
          <td class="td-h">${f2(d.eigenverbrauch)}</td>
          <td class="td-g">${f2(d.netzimport)}</td>
          <td class="td-e">${f2(d.einspeisung)}</td>
          <td class="td-gr">${f2(d.speicherLadung)}</td>
          <td class="td-am">${f2(d.speicherEntladung)}</td>
          <td>${f2(d.geraeteSumme)}</td>
          <td>${f2(d.rest)}</td>
          <td class="td-co">${f2(d.co2)}</td>
          <td class="${parseFloat(aut)>=50?'td-ok':''}">${aut!=='-'?aut+'%':'-'}</td>
        </tr>`;
      }).join('');
      return `<div class="tbl-wrap"><table>
        <thead><tr>${['Datum','Solar (kWh)','Haushalt (kWh)','Netzbezug (kWh)','Einspeisung (kWh)','Sp.Ladung','Sp.Entlad.','Geräte (kWh)','Rest (kWh)','CO₂ (kg)','Autarkie'].map(h=>`<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
    },
  };

  // ── CSS (identisch zur Anker-Tablet-Vorlage) ────────────────────────────────
  const CSS = `
:host { display:block }
ha-card { font-family:'Segoe UI',system-ui,sans-serif; overflow:hidden }
.cc { padding:20px 22px }

/* Loading / Error */
.loading { display:flex; flex-direction:column; align-items:center; padding:60px; color:var(--secondary-text-color,#888) }
.spinner { width:48px; height:48px; border:3px solid #e2e8f0; border-top-color:#FBBF24; border-radius:50%; animation:spin .8s linear infinite; margin-bottom:20px }
@keyframes spin { to { transform:rotate(360deg) } }
.err-box { text-align:center; padding:40px }
.err-ic  { font-size:56px; margin-bottom:14px }
.err-box h3 { margin:0 0 8px; font-size:18px; color:var(--error-color,#e11d48) }
.err-box button { margin-top:18px; padding:10px 28px; background:#FBBF24; border:none; border-radius:10px; font-weight:700; cursor:pointer; font-size:14px }

/* ── HEADER ─────────────────────────────────────────────────────────────── */
.hdr { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; flex-wrap:wrap }
.hdr-left { display:flex; align-items:center; gap:18px; flex-wrap:wrap }
.logo { display:flex; align-items:center }
.la,.ls { font-size:28px; font-weight:900; color:#2563eb; letter-spacing:-1.5px; line-height:1 }
.ls { font-style:italic; margin-left:5px }
.hdr-sub { font-size:12px; font-weight:700; color:var(--secondary-text-color,#888); letter-spacing:2px; text-transform:uppercase; display:flex; align-items:center; gap:8px; flex-wrap:wrap }
.badge   { background:var(--secondary-background-color,#f1f5f9); font-size:11px; font-weight:700; padding:3px 10px; border-radius:7px }
.badge-s { background:var(--secondary-background-color,#f1f5f9); font-size:11px; padding:3px 8px; border-radius:7px }
.hdr-right { display:flex; align-items:center; gap:10px; flex-wrap:wrap }
.btn-ic { display:flex; align-items:center; gap:6px; background:var(--card-background-color,#fff); border:1px solid var(--divider-color,#e2e8f0); border-radius:10px; padding:8px 14px; cursor:pointer; font-size:13px; font-weight:600; white-space:nowrap }
.btn-ic:hover { background:var(--secondary-background-color,#f8f9fa) }
.vm-grp { display:flex; background:var(--secondary-background-color,#f1f5f9); border-radius:12px; padding:3px; gap:3px }
.vm-btn { padding:7px 14px; border:none; background:transparent; border-radius:9px; font-size:12px; font-weight:700; cursor:pointer; color:var(--secondary-text-color,#888) }
.vm-btn.active { background:#f59e0b; color:#fff; box-shadow:0 2px 6px rgba(245,158,11,.4) }
.vm-btn:not(.active):hover { background:var(--divider-color,#e2e8f0) }

/* ── SETTINGS ───────────────────────────────────────────────────────────── */
.settings { background:var(--secondary-background-color,#f8f9fa); border-radius:14px; padding:18px; margin-bottom:18px; border:1px solid #fde68a }
.settings h3 { font-size:14px; font-weight:800; color:#d97706; margin:0 0 14px }
.sg { display:grid; grid-template-columns:repeat(3,1fr); gap:16px }
.si label { display:block; font-size:11px; font-weight:700; color:var(--secondary-text-color,#888); margin-bottom:6px; text-transform:uppercase; letter-spacing:.5px }
.si input { width:100%; padding:9px 12px; border:1px solid var(--divider-color,#e2e8f0); border-radius:10px; background:var(--card-background-color,#fff); color:var(--primary-text-color,#111); font-size:14px; font-weight:600; box-sizing:border-box }
.si input:focus { outline:2px solid #f59e0b; outline-offset:1px }

/* ── STAT KARTEN (6 nebeneinander auf Tablet) ───────────────────────────── */
.stat-grid { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin-bottom:18px }
@media(max-width:1100px){ .stat-grid { grid-template-columns:repeat(3,1fr) } }
@media(max-width:700px)  { .stat-grid { grid-template-columns:repeat(2,1fr) } }
.sc { background:var(--card-background-color,#fff); border:1px solid var(--divider-color,#e2e8f0); border-radius:16px; padding:14px 16px; display:flex; flex-direction:column; gap:8px }
.sc.hi   { border-color:#fde68a; background:rgba(251,191,36,.06) }
.sc.gold { border-color:#fde68a; background:rgba(251,191,36,.06) }
.sc-top  { display:flex; align-items:center; gap:8px }
.sc-icon { font-size:20px }
.sc-ttl  { font-size:10px; font-weight:700; color:var(--secondary-text-color,#888); text-transform:uppercase; letter-spacing:.8px; line-height:1.2 }
.sc-val  { font-size:20px; font-weight:900; color:var(--primary-text-color,#111); letter-spacing:-.8px; line-height:1 }
.sc-kpis { display:flex; flex-direction:column; gap:3px; margin-top:2px }
.kpi     { display:flex; justify-content:space-between; align-items:center }
.kpi-l   { font-size:9px; font-weight:600; color:var(--secondary-text-color,#888); text-transform:uppercase }
.kpi-v   { font-size:11px; font-weight:800; color:var(--primary-text-color,#111) }

/* ── TABS ───────────────────────────────────────────────────────────────── */
.tabs { display:flex; gap:6px; background:var(--secondary-background-color,#f1f5f9); padding:5px; border-radius:14px; margin-bottom:16px }
.tab-btn { flex:1; padding:10px 8px; border:none; background:transparent; border-radius:10px; font-size:13px; font-weight:700; cursor:pointer; color:var(--secondary-text-color,#888); white-space:nowrap; text-align:center }
.tab-btn.active { background:#f59e0b; color:#fff; box-shadow:0 2px 8px rgba(245,158,11,.4) }
.tab-btn:not(.active):hover { background:var(--divider-color,#e2e8f0) }

/* ── SLIDER ─────────────────────────────────────────────────────────────── */
.slider-wrap { display:flex; align-items:center; gap:14px; background:var(--secondary-background-color,#f1f5f9); padding:12px 16px; border-radius:14px; margin-bottom:14px }
.sl-ic { font-size:18px }
.sl-range { flex:1 }
.sl-range input[type=range] { width:100%; accent-color:#f59e0b; height:6px; cursor:pointer }
.sl-ticks { display:flex; justify-content:space-between; margin-top:4px }
.sl-ticks span { font-size:10px; color:var(--secondary-text-color,#888) }
.slider-label { font-size:12px; font-weight:800; color:#d97706 }

/* ── CHART GRID (immer 3 Spalten) ───────────────────────────────────────── */
.row3  { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-bottom:14px }
.row1  { margin-bottom:14px }
.span2 { grid-column:span 2 }
@media(max-width:900px) { .row3 { grid-template-columns:1fr } .span2 { grid-column:1 } }

.ccard { background:var(--card-background-color,#fff); border:1px solid var(--divider-color,#e2e8f0); border-radius:16px; padding:18px 20px }
.ch3   { margin-bottom:12px }
.ch3 h3 { font-size:14px; font-weight:700; margin:0 0 2px; color:var(--primary-text-color,#111) }
.csub  { font-size:12px; color:var(--secondary-text-color,#888); margin:0 }

/* Chart-Höhen (Tablet: großzügiger) */
.cw      { position:relative; height:320px }
.cw.tall { height:340px }
.cw.std  { height:290px }
.cw.mid  { height:260px }

/* ── CO2 KPIs ───────────────────────────────────────────────────────────── */
.co2-kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px }
@media(max-width:900px){ .co2-kpis { grid-template-columns:repeat(2,1fr) } }
.co2k { background:var(--card-background-color,#fff); border:1px solid var(--divider-color,#e2e8f0); border-radius:16px; padding:16px; text-align:center }
.co2i { font-size:26px; margin-bottom:6px }
.co2l { font-size:10px; font-weight:700; color:var(--secondary-text-color,#888); text-transform:uppercase }
.co2v { font-size:20px; font-weight:900; color:var(--primary-text-color,#111); margin-top:5px }

/* ── HEATMAP ────────────────────────────────────────────────────────────── */
.hm-card { margin-bottom:0 }
.hm-scroll { overflow-x:auto; padding-bottom:8px }
.hm-months { display:flex; gap:22px; min-width:max-content }
.hm-lbl    { font-size:11px; font-weight:700; color:var(--secondary-text-color,#888); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px }
.hm-grid   { display:grid; grid-template-columns:repeat(7,30px); gap:4px }
.hm-dow    { font-size:9px; font-weight:700; text-align:center; color:var(--secondary-text-color,#888); padding:2px 0 }
.hm-c      { width:30px; height:30px; border-radius:7px; display:flex; align-items:center; justify-content:center; transition:transform .1s; cursor:default }
.hm-c.empty { background:transparent!important }
.hm-c:not(.empty):hover { transform:scale(1.2); z-index:1; position:relative }
.hm-day    { font-size:9px; font-weight:600; color:#78716c }
.hm-star   { font-size:16px; color:#fbbf24; filter:drop-shadow(0 0 3px rgba(0,0,0,.3)) }
.hm-legend { display:flex; align-items:center; gap:10px; margin-top:14px; padding-top:12px; border-top:1px solid var(--divider-color,#e2e8f0); flex-wrap:wrap }
.hm-legend span { font-size:11px; font-weight:700; color:var(--secondary-text-color,#888) }
.leg-c    { width:22px; height:14px; border-radius:4px }
.leg-star { color:#f59e0b; font-size:12px; margin-left:10px }

/* ── TABELLE ────────────────────────────────────────────────────────────── */
.tbl-wrap { overflow-x:auto; max-height:600px; overflow-y:auto; border-radius:12px; border:1px solid var(--divider-color,#e2e8f0) }
table { width:100%; border-collapse:collapse; font-size:12px; white-space:nowrap }
thead { position:sticky; top:0; background:var(--secondary-background-color,#f1f5f9); z-index:1 }
th { padding:12px 10px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:var(--secondary-text-color,#888); border-bottom:2px solid var(--divider-color,#e2e8f0); text-align:left }
td { padding:10px; border-bottom:1px solid var(--divider-color,#e2e8f0) }
tr:last-child td { border-bottom:none }
tr:hover td { background:var(--secondary-background-color,#f8f9fa) }
.td-d  { color:var(--secondary-text-color,#888); font-weight:600; min-width:90px }
.td-s  { color:#d97706; font-weight:700 }
.td-h  { color:#2563eb; font-weight:700 }
.td-g  { color:#e11d48; font-weight:700 }
.td-e  { color:#7c3aed; font-weight:700 }
.td-gr { color:#059669; font-weight:700 }
.td-am { color:#d97706; font-weight:700 }
.td-co { color:#16a34a; font-weight:700 }
.td-ok { color:#059669; font-weight:700 }

/* ── FOOTER ─────────────────────────────────────────────────────────────── */
.footer { margin-top:18px; padding-top:12px; border-top:1px solid var(--divider-color,#e2e8f0); font-size:11px; color:var(--secondary-text-color,#888); text-align:center }
`;

  // ── Registrierung ──────────────────────────────────────────────────────────
  if (!customElements.get('energy-dashboard-card-tablet')) {
    customElements.define('energy-dashboard-card-tablet', EnergyDashboardCardTablet);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.find(c => c.type === 'energy-dashboard-card-tablet')) {
    window.customCards.push({
      type:        'energy-dashboard-card-tablet',
      name:        'Energie-Dashboard Analytics (Tablet)',
      description: 'HA Energie-Dashboard-Daten im Anker-Tablet-Stil: 3-Spalten-Grid, Statistiken, Charts',
      preview:     true,
    });
  }

})(); // Ende IIFE
