/* =========================================================================
 * Stantonopoly V2 — Admin-Dashboard (admin.js)
 * Authentifizierter REST-Client gegen die /admin-API. Keine Admin-Daten im
 * Spiel-Frontend; Token wird nur im SessionStorage dieses Tabs gehalten.
 * RSI-HUD / F-Schale-Design (cargo/ion/uplink), passt zu client.js.
 * ========================================================================= */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let token = null;
  let username = null;
  let presetList = [];
  // Admin-Preset-Editor-Zustand
  let currentPresetName = '';
  let editingFields = [];
  const LEVEL_KEYS = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA', 'ARMISTICE'];
  const DEFAULT_LEVEL_NAMES = { ALLEIN: 'Standard', CYCLONE: 'Cyclone', STORM: 'Storm', BALLISTA: 'Ballista', ARMISTICE: 'Armistice Zone' };
  let currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES);

    // Spielregeln (Settings) je Preset — identisch zum Spiel-Editor (client.js).
    // Interne Werte = Dezimal (wie Server); Eingabefelder zeigen Prozent (50 → 0.50).
    const DEFAULT_SETTINGS_CLIENT = {
      rentMult: { ALLEIN: 0.10, CYCLONE: 0.50, STORM: 1.00, BALLISTA: 2.00, ARMISTICE: 3.00 },
      buildMult: { ALLEIN: 0, CYCLONE: 0.25, STORM: 0.50, BALLISTA: 1.00, ARMISTICE: 1.50 },
      mortgageMult: 0.75,
      unmortgageRate: 1.10,
      bankSellEnabled: true,
      bankPayout: 0.75,
      demolishRefundRate: 0.50,
      auctionMs: 15000,
      pollMs: 15000,
      armisticeEnabled: false,
      buildGroupOwnership: true,
      buildGroupEven: true,
      tasksEnabled: false,
      tasksTurnTimerMs: 10000,
      tasksRequireTrade: false,
      diceConfig: '1w6',
      turnSeconds: 0,
      piratesEnabled: false,
      pirateDice: '1w6',
      pirateProtectionFee: 250000,
      pirateCaughtMult: 2
    };
    let currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS_CLIENT));

    // (2m #13) Gleichmäßig-Regel nur in Verbindung mit Besitz-Regel.
    function syncEvenToggle() {
      const owned = $('ad-s-build-group-owned');
      const even = $('ad-s-build-group-even');
      if (!owned || !even) return;
      even.disabled = !owned.checked;
      if (!owned.checked) even.checked = false;
    }
    function bindMonopolyToggles() {
      const owned = $('ad-s-build-group-owned');
      const even = $('ad-s-build-group-even');
      if (owned) owned.addEventListener('change', syncEvenToggle);
      if (even) even.addEventListener('change', () => { const o = $('ad-s-build-group-owned'); if (!o || !o.checked) even.checked = false; });
    }

    // Settings aus einem (Preset-)Objekt übernehmen (Default-Merge; Daten sind Dezimal).
    function applyPresetSettings(p) {
      const src = (p && p.settings && typeof p.settings === 'object') ? p.settings : {};
      const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS_CLIENT));
      if (typeof src.mortgageMult === 'number') s.mortgageMult = src.mortgageMult;
      if (typeof src.unmortgageRate === 'number') s.unmortgageRate = src.unmortgageRate;
      if (typeof src.bankSellEnabled === 'boolean') s.bankSellEnabled = src.bankSellEnabled;
      if (typeof src.bankPayout === 'number') s.bankPayout = src.bankPayout;
      if (typeof src.demolishRefundRate === 'number') s.demolishRefundRate = src.demolishRefundRate;
      if (typeof src.auctionMs === 'number') s.auctionMs = src.auctionMs;
      if (typeof src.pollMs === 'number') s.pollMs = src.pollMs;
      if (typeof src.armisticeEnabled === 'boolean') s.armisticeEnabled = src.armisticeEnabled;
      if (typeof src.tasksEnabled === 'boolean') s.tasksEnabled = src.tasksEnabled;
      if (typeof src.monopolyBuildRule === 'boolean') { s.buildGroupOwnership = src.monopolyBuildRule; s.buildGroupEven = src.monopolyBuildRule; }
      if (typeof src.buildGroupOwnership === 'boolean') s.buildGroupOwnership = src.buildGroupOwnership;
      if (typeof src.buildGroupEven === 'boolean') s.buildGroupEven = src.buildGroupEven;
      if (typeof src.tasksTurnTimerMs === 'number') s.tasksTurnTimerMs = src.tasksTurnTimerMs;
      if (typeof src.tasksRequireTrade === 'boolean') s.tasksRequireTrade = src.tasksRequireTrade;
      if (typeof src.piratesEnabled === 'boolean') s.piratesEnabled = src.piratesEnabled;
      if (src.pirateDice === '1w6' || src.pirateDice === '2w6') s.pirateDice = src.pirateDice;
      if (typeof src.pirateProtectionFee === 'number') s.pirateProtectionFee = src.pirateProtectionFee;
      if (typeof src.pirateCaughtMult === 'number') s.pirateCaughtMult = src.pirateCaughtMult;
      if (src.rentMult && typeof src.rentMult === 'object') Object.assign(s.rentMult, src.rentMult);
      if (src.buildMult && typeof src.buildMult === 'object') Object.assign(s.buildMult, src.buildMult);
      if (src.diceConfig === '1w6' || src.diceConfig === '2w6') s.diceConfig = src.diceConfig;
      if (typeof src.turnSeconds === 'number') s.turnSeconds = src.turnSeconds;
      currentSettings = s;
    }

    function syncSettingsInputs() {
      const set = (id, v) => { const el = $(id); if (el && el.value !== undefined) { if (typeof v === 'undefined' || v === null) el.value = ''; else el.value = Math.round(v * 100); } };
      set('ad-s-rent-ALLEIN', currentSettings.rentMult.ALLEIN);
      set('ad-s-rent-CYCLONE', currentSettings.rentMult.CYCLONE);
      set('ad-s-rent-STORM', currentSettings.rentMult.STORM);
      set('ad-s-rent-BALLISTA', currentSettings.rentMult.BALLISTA);
      set('ad-s-rent-ARMISTICE', currentSettings.rentMult.ARMISTICE);
      set('ad-s-build-CYCLONE', currentSettings.buildMult.CYCLONE);
      set('ad-s-build-STORM', currentSettings.buildMult.STORM);
      set('ad-s-build-BALLISTA', currentSettings.buildMult.BALLISTA);
      set('ad-s-build-ARMISTICE', currentSettings.buildMult.ARMISTICE);
      set('ad-s-mortgage-mult', currentSettings.mortgageMult);
      { const el = $('ad-s-unmortgage-rate'); if (el) el.value = String(Math.round((currentSettings.unmortgageRate - 1) * 100)); }
      set('ad-s-bank-payout', currentSettings.bankPayout);
      set('ad-s-demolish-refund', currentSettings.demolishRefundRate);
      { const bs = $('ad-s-bank-sell'); if (bs) bs.checked = !!currentSettings.bankSellEnabled; }
      { const el = $('ad-s-auction-ms'); if (el) el.value = Math.round(currentSettings.auctionMs / 1000); }
      { const el = $('ad-s-poll-ms'); if (el) el.value = Math.round(currentSettings.pollMs / 1000); }
      { const el = $('ad-s-armistice'); if (el) el.checked = !!currentSettings.armisticeEnabled; }
      { const el = $('ad-s-build-group-owned'); if (el) el.checked = !!currentSettings.buildGroupOwnership; }
      { const el = $('ad-s-build-group-even'); if (el) el.checked = !!(currentSettings.buildGroupEven && currentSettings.buildGroupOwnership); syncEvenToggle(); }
      { const el = $('ad-s-tasks-enabled'); if (el) el.checked = !!currentSettings.tasksEnabled; }
      { const el = $('ad-s-tasks-turn-timer'); if (el) el.value = String(Math.max(0, Math.round(Number(currentSettings.tasksTurnTimerMs) || 0) / 1000)); }
      { const el = $('ad-s-tasks-require-trade'); if (el) el.checked = !!currentSettings.tasksRequireTrade; }
      { const el = $('ad-s-dice'); if (el) el.value = currentSettings.diceConfig || '1w6'; }
      { const el = $('ad-s-turnsecs'); if (el) el.value = String(Math.max(0, Math.round(Number(currentSettings.turnSeconds) || 0))); }
      { const el = $('ad-s-pirates-enabled'); if (el) el.checked = !!currentSettings.piratesEnabled; }
      { const el = $('ad-s-pirate-dice'); if (el) el.value = currentSettings.pirateDice || '1w6'; }
      { const el = $('ad-s-pirate-fee'); if (el) el.value = String(currentSettings.pirateProtectionFee != null ? currentSettings.pirateProtectionFee : 250000); }
      { const el = $('ad-s-pirate-caught-mult'); if (el) el.value = String(currentSettings.pirateCaughtMult != null ? currentSettings.pirateCaughtMult : 2); }
    }

    function readSettingsInputs() {
      const p = (v, d) => { if (v == null) return d; const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
      const read = (id, apply) => { const el = $(id); if (el) { const v = el.value; if (v !== undefined && v !== '') apply(v); } };
      read('ad-s-rent-ALLEIN', (v) => currentSettings.rentMult.ALLEIN = p(v, 0.10) / 100);
      read('ad-s-rent-CYCLONE', (v) => currentSettings.rentMult.CYCLONE = p(v, 0.50) / 100);
      read('ad-s-rent-STORM', (v) => currentSettings.rentMult.STORM = p(v, 1.00) / 100);
      read('ad-s-rent-BALLISTA', (v) => currentSettings.rentMult.BALLISTA = p(v, 2.00) / 100);
      read('ad-s-rent-ARMISTICE', (v) => currentSettings.rentMult.ARMISTICE = p(v, 3.00) / 100);
      read('ad-s-build-CYCLONE', (v) => currentSettings.buildMult.CYCLONE = p(v, 0.25) / 100);
      read('ad-s-build-STORM', (v) => currentSettings.buildMult.STORM = p(v, 0.50) / 100);
      read('ad-s-build-BALLISTA', (v) => currentSettings.buildMult.BALLISTA = p(v, 1.00) / 100);
      read('ad-s-build-ARMISTICE', (v) => currentSettings.buildMult.ARMISTICE = p(v, 1.50) / 100);
      read('ad-s-mortgage-mult', (v) => currentSettings.mortgageMult = p(v, 0.75) / 100);
      read('ad-s-unmortgage-rate', (v) => currentSettings.unmortgageRate = p(v, 10) / 100 + 1);
      read('ad-s-bank-payout', (v) => currentSettings.bankPayout = p(v, 0.75) / 100);
      read('ad-s-demolish-refund', (v) => currentSettings.demolishRefundRate = p(v, 0.50) / 100);
      { const bs = $('ad-s-bank-sell'); if (bs) currentSettings.bankSellEnabled = !!bs.checked; }
      read('ad-s-auction-ms', (v) => currentSettings.auctionMs = Math.max(1, Math.round(Number(v)) * 1000));
      read('ad-s-poll-ms', (v) => currentSettings.pollMs = Math.max(1, Math.round(Number(v)) * 1000));
      { const ae = $('ad-s-armistice'); if (ae) currentSettings.armisticeEnabled = !!ae.checked; }
      { const mr = $('ad-s-build-group-owned'); if (mr) currentSettings.buildGroupOwnership = !!mr.checked; }
      { const er = $('ad-s-build-group-even'); if (er && currentSettings.buildGroupOwnership) currentSettings.buildGroupEven = !!er.checked; }
      { const te_ = $('ad-s-tasks-enabled'); if (te_) currentSettings.tasksEnabled = !!te_.checked; }
      { const tt = $('ad-s-tasks-turn-timer'); if (tt) currentSettings.tasksTurnTimerMs = Math.max(0, Math.round(Number(tt.value) || 0) * 1000); }
      { const tr = $('ad-s-tasks-require-trade'); if (tr) currentSettings.tasksRequireTrade = !!tr.checked; }
      { const de = $('ad-s-dice'); if (de && (de.value === '1w6' || de.value === '2w6')) currentSettings.diceConfig = de.value; }
      { const te = $('ad-s-turnsecs'); if (te) currentSettings.turnSeconds = Math.max(0, Math.round(Number(te.value) || 0)); }
      { const pe = $('ad-s-pirates-enabled'); if (pe) currentSettings.piratesEnabled = !!pe.checked; }
      { const pd = $('ad-s-pirate-dice'); if (pd && (pd.value === '1w6' || pd.value === '2w6')) currentSettings.pirateDice = pd.value; }
      { const pf = $('ad-s-pirate-fee'); if (pf) currentSettings.pirateProtectionFee = Math.max(0, Math.round(Number(pf.value) || 0)); }
      { const pm = $('ad-s-pirate-caught-mult'); if (pm) currentSettings.pirateCaughtMult = Math.max(1, Math.round(Number(pm.value) || 1)); }
    }

    // Settings nur senden, wenn sie von den Defaults abweichen (sonst null).
    function settingsPayload() {
      const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS_CLIENT));
      const cur = currentSettings;
      const out = {};
      if (JSON.stringify(cur.rentMult) !== JSON.stringify(base.rentMult)) out.rentMult = cur.rentMult;
      if (JSON.stringify(cur.buildMult) !== JSON.stringify(base.buildMult)) out.buildMult = cur.buildMult;
      if (cur.mortgageMult !== base.mortgageMult) out.mortgageMult = cur.mortgageMult;
      if (cur.unmortgageRate !== base.unmortgageRate) out.unmortgageRate = cur.unmortgageRate;
      if (cur.bankSellEnabled !== base.bankSellEnabled) out.bankSellEnabled = cur.bankSellEnabled;
      if (cur.bankPayout !== base.bankPayout) out.bankPayout = cur.bankPayout;
      if (cur.demolishRefundRate !== base.demolishRefundRate) out.demolishRefundRate = cur.demolishRefundRate;
      if (cur.auctionMs !== base.auctionMs) out.auctionMs = cur.auctionMs;
      if (cur.pollMs !== base.pollMs) out.pollMs = cur.pollMs;
      if (cur.armisticeEnabled !== base.armisticeEnabled) out.armisticeEnabled = cur.armisticeEnabled;
      if (cur.buildGroupOwnership !== base.buildGroupOwnership) out.buildGroupOwnership = cur.buildGroupOwnership;
      if (cur.buildGroupEven !== base.buildGroupEven) out.buildGroupEven = cur.buildGroupEven;
      if (cur.tasksEnabled !== base.tasksEnabled) out.tasksEnabled = cur.tasksEnabled;
      if (cur.tasksTurnTimerMs !== base.tasksTurnTimerMs) out.tasksTurnTimerMs = cur.tasksTurnTimerMs;
      if (cur.tasksRequireTrade !== base.tasksRequireTrade) out.tasksRequireTrade = cur.tasksRequireTrade;
      if (cur.piratesEnabled !== base.piratesEnabled) out.piratesEnabled = cur.piratesEnabled;
      if (cur.pirateDice !== base.pirateDice) out.pirateDice = cur.pirateDice;
      if (cur.pirateProtectionFee !== base.pirateProtectionFee) out.pirateProtectionFee = cur.pirateProtectionFee;
      if (cur.pirateCaughtMult !== base.pirateCaughtMult) out.pirateCaughtMult = cur.pirateCaughtMult;
      if (cur.diceConfig !== base.diceConfig) out.diceConfig = cur.diceConfig;
      if (cur.turnSeconds !== base.turnSeconds) out.turnSeconds = cur.turnSeconds;
      return Object.keys(out).length ? out : null;
    }

    const DEFAULT_FIELDS = () => [
    { type: 'los', name: 'Orison' },
    { type: 'grundstueck', name: 'Seraphim', price: 400000 },
    { type: 'grundstueck', name: 'Shubin Mining SCD-1', price: 500000 },
    { type: 'grundstueck', name: 'Kudre Ore', price: 500000 },
    { type: 'grundstueck', name: 'Brios Breaker Yard', price: 400000 },
    { type: 'grundstueck', name: 'Arc Mining 141', price: 500000 },
    { type: 'ereignis', name: 'Covalex Hub Gundo' },
    { type: 'grundstueck', name: 'Miner Lament', price: 300000 },
    { type: 'grundstueck', name: 'Grim Hex', price: 500000 },
    { type: 'grundstueck', name: 'NT-999-XX', price: 600000 },
    { type: 'grundstueck', name: 'Deakins Research', price: 500000 },
    { type: 'grundstueck', name: 'Terra Mills HydroFarm', price: 300000 },
    { type: 'grundstueck', name: 'Gallete Family Farms', price: 300000 },
    { type: 'grundstueck', name: 'Hickes Research', price: 500000 },
    { type: 'grundstueck', name: 'Security Post Kareah', price: 600000 },
    { type: 'grundstueck', name: 'Comm Array ST2-55', price: 600000 }
  ];

  const FIELD_TYPES = [['los', 'Los'], ['grundstueck', 'Grundstück'], ['ereignis', 'Ereignis'], ['gefangnis', 'Gefängnis'], ['freiparken', 'Frei Parken'], ['steuer', 'Steuer']];
  // Farbgruppen-Fallback (board.js lädt auf der Admin-Seite nicht; gleiche Keys/Farben).
  const DEFAULT_GROUPS = [
    { key: 'blau', label: 'Blau' }, { key: 'gruen', label: 'Grün' }, { key: 'rot', label: 'Rot' },
    { key: 'violett', label: 'Violett' }, { key: 'orange', label: 'Orange' }, { key: 'tuerkis', label: 'Türkis' },
    { key: 'gold', label: 'Gold' }, { key: 'pink', label: 'Pink' }, { key: 'schwarz', label: 'Schwarz' }, { key: 'weiss', label: 'Weiß' }
  ];
  const GROUPS = (window.STAN_COLORS && window.STAN_COLORS.length) ? window.STAN_COLORS : DEFAULT_GROUPS;

  function showNotify(msg, isErr) {
    const el = $('notify');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('is-error', !!isErr);
    el.classList.remove('hidden');
    if (showNotify._t) clearTimeout(showNotify._t);
    showNotify._t = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  function setToken(t, u) {
    token = t || null;
    username = u || null;
    try {
      if (token) sessionStorage.setItem('stp.admin.token', token);
      else sessionStorage.removeItem('stp.admin.token');
    } catch (e) {}
  }

  function loadStoredToken() {
    try { return sessionStorage.getItem('stp.admin.token') || null; } catch (e) { return null; }
  }

  async function api(method, path, body) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch('/admin' + path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401) {
      setToken(null, null);
      showView('login');
      showNotify((data && data.message) || 'Bitte neu anmelden.', true);
      throw new Error('UNAUTH');
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || ('HTTP ' + res.status));
      err.code = (data && data.error) || 'ERR';
      throw err;
    }
    return data || {};
  }

  // ---------------- Views / Nav ----------------
  const VIEWS = ['login', 'dashboard', 'games', 'presets', 'managers', 'scdata', 'log'];
  function showView(name) {
    VIEWS.forEach((v) => {
      const el = $('view-' + v);
      if (el) { el.classList.toggle('hidden', v !== name); el.classList.toggle('active', v === name); }
    });
    document.body.classList.remove('view-login', 'view-dashboard', 'view-games', 'view-presets', 'view-managers', 'view-scdata', 'view-log');
    document.body.classList.add('view-' + name);
    // Nav aktualisieren
    renderNav(name);
    if (name === 'dashboard') reloadDashboard();
    else if (name === 'games') reloadGames();
    else if (name === 'presets') reloadPresets();
    else if (name === 'managers') reloadManagerCodes();
    else if (name === 'scdata') reloadScdata();
    else if (name === 'log') reloadLog();
  }

  function renderNav(active) {
    const nav = $('admin-nav');
    if (!nav) return;
    nav.innerHTML = '';
    const items = [['dashboard', 'Übersicht'], ['games', 'Spiele'], ['presets', 'Presets'], ['managers', 'Manager'], ['scdata', 'SC-Daten'], ['log', 'Protokoll']];
    items.forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nav-item' + (active === id ? ' is-on' : '');
      b.textContent = label;
      b.addEventListener('click', () => showView(id));
      nav.appendChild(b);
    });
    const sep = document.createElement('span');
    sep.className = 'nav-item';
    sep.textContent = '';
    nav.appendChild(sep);
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'nav-item nav-join';
    out.textContent = '↩ Abmelden';
    out.addEventListener('click', async () => { try { await api('POST', '/logout'); } catch (e) {} setToken(null, null); showView('login'); });
    nav.appendChild(out);
  }

  // ---------------- Login ----------------
    function initLogin() {
      const form = $('login-form');
      if (!form) return;
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const u = $('login-user').value.trim();
        const p = $('login-pass').value;
        const note = $('login-note');
        if (!u || !p) { showNotify('Benutzername und Passwort eingeben.', true); return; }
        try {
          const data = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
          }).then((r) => r.json());
          if (!data.ok) {
            showNotify((data && data.message) || 'Anmeldung fehlgeschlagen.', true);
            if (note) note.textContent = '';
            return;
          }
          setToken(data.token, data.username);
          if (note) note.textContent = '';
          const uEl = $('admin-user');
          if (uEl) uEl.textContent = 'Angemeldet: ' + data.username;
          showNotify('Angemeldet als ' + data.username);
          showView('dashboard');
        } catch (e) {
          showNotify('Fehler bei der Anmeldung.', true);
        }
      });
    }

    // Ersteinrichtung: solange kein Admin-Konto existiert, Login-Formular
    // ausblenden und das Setup-Formular zeigen (ohne Terminal).
    async function checkSetup() {
      try {
        const r = await fetch('/admin/setup-status').then((x) => x.json());
        if (r && r.needsSetup) {
          const lf = $('login-form'); if (lf) lf.classList.add('hidden');
          const sf = $('setup-form'); if (sf) sf.classList.remove('hidden');
          const sfrm = $('setup-form');
          if (sfrm) sfrm.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const u = $('setup-user').value.trim();
            const p = $('setup-pass').value;
            const note = $('setup-note');
            if (!u || p.length < 8) { showNotify('Benutzername + Passwort (min. 8 Zeichen) eingeben.', true); return; }
            try {
              const data = await fetch('/admin/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u, password: p })
              }).then((x) => x.json());
              if (!data.ok) { showNotify((data && data.message) || 'Einrichtung fehlgeschlagen.', true); return; }
              setToken(data.token, data.username);
              if (note) note.textContent = '';
              const uEl = $('admin-user');
              if (uEl) uEl.textContent = 'Angemeldet: ' + data.username;
              showNotify('Admin-Konto eingerichtet — angemeldet.');
              showView('dashboard');
            } catch (e) { showNotify('Fehler bei der Einrichtung.', true); }
          });
        }
      } catch (e) { /* Server nicht erreichbar — Login-n-Formular bleibt */ }
    }

  // ---------------- Dashboard ----------------
  async function reloadDashboard() {
    try {
      const d = await api('GET', '/dashboard');
      const s = d.stats || {};
      const cards = [
        ['Gesamt', s.total, ''], ['Lobby', s.lobby, ''], ['Aktiv', s.active, 'ok'], ['Pausiert', s.paused, 'warn'], ['Beendet', s.done, 'dim'], ['Presets', s.presetCount, '']
      ];
      const el = $('ad-stats');
      el.innerHTML = cards.map(([k, v, kind]) => '<div class="ad-stat ' + kind + '"><span class="ad-stat-v">' + v + '</span><span class="ad-stat-k">' + esc(k) + '</span></div>').join('');
    } catch (e) {}
  }

  // ---------------- Spiele ----------------
  async function reloadGames() {
    try {
      const d = await api('GET', '/games');
      const list = $('ad-games-list');
      const arch = $('ad-archived-list');
      const render = (listEl, games, showCodes) => {
        if (!listEl) return;
        if (!games.length) { listEl.innerHTML = '<div class="ad-empty">Keine.</div>'; return; }
        listEl.innerHTML = games.map((g) => {
          const statusLbl = g.status === 'active' ? 'aktiv' : g.status === 'paused' ? 'pausiert' : 'Lobby';
          const statusCls = g.status === 'active' ? 'ok' : g.status === 'paused' ? 'warn' : 'dim';
          const teams = (g.teams || []).map((t) => t.ship).filter(Boolean).join(' · ') || '—';
          const codeCell = showCodes
            ? '<span class="ad-code">' + esc(g.gmCode || '—') + '</span>'
            : '<span class="hint">archiviert</span>';
          return '<div class="ad-row">' +
            '<div class="ad-row-main">' +
              '<div class="ad-row-head"><span class="ad-status ' + statusCls + '">' + esc(statusLbl) + '</span><strong>' + esc(g.name) + '</strong></div>' +
              '<div class="ad-meta">' + esc(g.gameId) + ' · ' + esc(teams) + ' · ' + g.players + ' Spieler</div>' +
            '</div>' +
            '<div class="ad-row-side">' + codeCell +
              '<button type="button" class="btn btn-xs btn-danger" data-del="' + esc(g.gameId) + '">Löschen</button>' +
            '</div></div>';
        }).join('');
        listEl.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => confirmDeleteGame(b.getAttribute('data-del'))));
      };
      render(list, d.games || [], true);
      render(arch, d.archived || [], false);
    } catch (e) {}
  }

  function confirmDeleteGame(gameId) {
    if (!window.confirm('Spiel ' + gameId + ' wirklich endgültig löschen?\nAlle zugehörigen Daten (Teams, Spieler, Stimmen, Codes) werden entfernt.')) return;
    doDeleteGame(gameId);
  }

  async function doDeleteGame(gameId) {
    try {
      await api('DELETE', '/games/' + encodeURIComponent(gameId));
      showNotify('Spiel ' + gameId + ' gelöscht.');
      reloadGames();
    } catch (e) { showNotify('Löschen fehlgeschlagen: ' + e.message, true); }
  }

  // ---------------- Presets ----------------
  async function reloadPresets() {
    try {
      const d = await api('GET', '/presets');
      presetList = d.presets || [];
      const sel = $('ad-preset-select');
      sel.innerHTML = '';
      [...presetList].forEach((p) => {
        const o = document.createElement('option');
        o.value = p.name;
        o.textContent = p.name + (p.builtin ? ' (Standard)' : ' (eigen)') + (p.enabled === false ? ' — deaktiviert' : '');
        sel.appendChild(o);
      });
      // QA-Fix P1: Wenn bereits ein Preset gewählt oder nur genau eines vorhanden
      // ist, currentPresetName sicherstellen (Browser <select> wählt den 1. Eintrag
      // automatisch OHNE change-Event → sonst blockiert \"Bearbeiten\").
      const hasCurrent = currentPresetName && Array.from(sel.options).some((o) => o.value === currentPresetName);
      if (hasCurrent) sel.value = currentPresetName;
      else if (sel.options.length) {
        currentPresetName = sel.value = sel.options[0].value;
      } else currentPresetName = '';
      updatePresetMeta();
    } catch (e) {}
  }

  function updatePresetMeta() {
    const p = presetList.find((x) => x.name === currentPresetName);
    const meta = $('ad-preset-meta');
    if (meta) {
      if (!p) meta.textContent = currentPresetName ? '' : 'Preset auswählen oder neu anlegen.';
      else {
        const kind = p.builtin ? 'Eingebautes Preset — bearbeitbar, nicht löschbar' : ('Eigenes Preset · ' + (p.fields ? p.fields.length : 0) + ' Felder · zuletzt ' + (p.updated_at || '—'));
        meta.textContent = kind + (p.enabled === false ? ' · DEAKTIVIERT' : '');
      }
    }
    const tg = $('btn-ad-preset-toggle');
    if (tg) {
      tg.textContent = (p && p.enabled === false) ? 'Aktivieren' : 'Deaktivieren';
    }
  }

  // Admin-Preset-Editor (spiegelt den Spiel-Preset-Editor für die Kernfunktionen).
  function openEditor() {
    const m = $('admin-preset-modal');
    if (m) m.classList.remove('hidden');
    const inp = $('ad-preset-name');
    if (inp && currentPresetName) inp.value = currentPresetName;
    renderFields();
        syncLevelNames();
        syncSettingsInputs();
        bindMonopolyToggles();
      }
  function closeEditor() {
    const m = $('admin-preset-modal');
    if (m) m.classList.add('hidden');
  }

  function renderFields() {
    const list = $('ad-preset-field-list');
    if (!list) return;
    list.innerHTML = '';
    editingFields.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'preset-field-row';
      const idx = document.createElement('span');
      idx.className = 'preset-field-idx';
      idx.textContent = i;
      const typeSel = document.createElement('select');
      FIELD_TYPES.forEach(([v, l]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = l;
        if (f.type === v) o.selected = true;
        typeSel.appendChild(o);
      });
      typeSel.addEventListener('change', () => { f.type = typeSel.value; if (f.type !== 'grundstueck') delete f.group; renderFields(); });
      // QA-Fix (Admin-Editor): los/ereignis/gundo/steuer/gefangnis brauchen ein Betrags-
      // Eingabefeld (Bonus/Fee/Lösegeld) + passendes 8-spaltiges Grid (has-extra).
      const isBetragFeld = ['los', 'ereignis', 'gundo', 'steuer', 'gefangnis'].indexOf(f.type) !== -1;
      if (isBetragFeld) row.classList.add('has-extra');
      // Frei Parken: weder Gruppen-Select (nur Grundstücke) noch Betrag → schmales Grid.
      if (f.type === 'freiparken') row.classList.add('is-plain');
      const nameIn = document.createElement('input');
      nameIn.type = 'text'; nameIn.value = f.name || ''; nameIn.placeholder = 'Name';
      nameIn.addEventListener('input', () => { f.name = nameIn.value; });
      const priceIn = document.createElement('input');
      priceIn.type = 'number'; priceIn.min = '0'; priceIn.step = '10000';
      priceIn.value = typeof f.price === 'number' ? f.price : '';
      priceIn.placeholder = 'Preis';
      priceIn.disabled = f.type !== 'grundstueck';
      priceIn.addEventListener('input', () => { f.price = Number(priceIn.value) || 0; });
      // Betrags-Eingabe für Sonder-Felder (spiegelt den Spiel-Editor 1:1):
      // Los = Bonuszahlung, Ereignis/Gundo = Gebühr (negativ = Bonus),
      // Steuer = fester Betrag, Gefängnis = Lösegeld.
      let betragIn = null;
      if (isBetragFeld) {
        betragIn = document.createElement('input');
        betragIn.type = 'number'; betragIn.step = '10000';
        betragIn.min = (f.type === 'ereignis' || f.type === 'gundo') ? '' : 0;
        betragIn.value = typeof f.fee === 'number' ? f.fee : (typeof f.bonus === 'number' ? f.bonus : '');
        if (f.type === 'los') {
          betragIn.placeholder = 'Los-Bonus*';
          betragIn.title = 'Betrag beim Überqueren/Landen auf Orison (Los)';
        } else if (f.type === 'ereignis' || f.type === 'gundo') {
          betragIn.placeholder = 'Gebühr/Bonus*';
          betragIn.title = 'Ereignis-Effekt bei Landung: Gebühr (positiv) oder Bonus (negativ)';
        } else if (f.type === 'steuer') {
          betragIn.placeholder = 'Betrag*';
          betragIn.title = 'Steuer-Betrag an die Bank bei Landung';
        } else {
          betragIn.placeholder = 'Lösegeld*';
          betragIn.title = 'Gefängnis-Lösegeld: wird bei Landung gezahlt, um frei zu kommen';
        }
        betragIn.addEventListener('input', () => {
          const v = Number(betragIn.value);
          const n = Number.isFinite(v) ? v : 0;
          if (f.type === 'los') f.bonus = n;
          else f.fee = n;
        });
      }
      // Farbgruppe (nur Grundstücke)
      let grpSel = null;
      if (f.type === 'grundstueck') {
        grpSel = document.createElement('select');
        const none = document.createElement('option');
        none.value = ''; none.textContent = '–';
        grpSel.appendChild(none);
        (GROUPS.length ? GROUPS : [{ key: '', label: '' }]).forEach((c) => {
          const o = document.createElement('option');
          o.value = c.key || ''; o.textContent = (c.label || c.key || '–');
          if (String(f.group) === (c.key || '')) o.selected = true;
          grpSel.appendChild(o);
        });
        grpSel.addEventListener('change', () => { f.group = grpSel.value; });
      }
      const up = document.createElement('button'); up.type = 'button'; up.className = 'btn btn-xs btn-ghost'; up.textContent = '↑';
      up.addEventListener('click', () => { if (i > 0) { [editingFields[i - 1], editingFields[i]] = [editingFields[i], editingFields[i - 1]]; renderFields(); } });
      const dn = document.createElement('button'); dn.type = 'button'; dn.className = 'btn btn-xs btn-ghost'; dn.textContent = '↓';
      dn.addEventListener('click', () => { if (i < editingFields.length - 1) { [editingFields[i + 1], editingFields[i]] = [editingFields[i], editingFields[i + 1]]; renderFields(); } });
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn-xs btn-ghost del'; del.textContent = '✕';
      del.addEventListener('click', () => { editingFields.splice(i, 1); renderFields(); });
      row.appendChild(idx); row.appendChild(typeSel); row.appendChild(nameIn); row.appendChild(priceIn);
      if (betragIn) row.appendChild(betragIn);
      if (grpSel) row.appendChild(grpSel);
      row.appendChild(up); row.appendChild(dn); row.appendChild(del);
      list.appendChild(row);
    });
  }

  function syncLevelNames() {
    LEVEL_KEYS.forEach((k) => {
      const inp = $('ad-lvl-' + k);
      if (inp) inp.value = currentLevelNames[k] || '';
    });
  }
  function readLevelNames() {
    LEVEL_KEYS.forEach((k) => {
      const inp = $('ad-lvl-' + k);
      const v = inp ? inp.value.trim() : '';
      if (v) currentLevelNames[k] = v;
    });
  }

  function normalizeFields() {
    return editingFields.map((f) => {
      const out = { type: f.type || 'los', name: f.name || 'Feld' };
      if (f.type === 'grundstueck') {
        if (typeof f.price === 'number') out.price = f.price;
        if (f.group !== undefined && f.group !== null && String(f.group) !== '') out.group = String(f.group);
      } else if (f.type === 'los') { if (typeof f.bonus === 'number') out.bonus = f.bonus; }
      else if (['ereignis', 'gundo', 'steuer', 'gefangnis'].indexOf(f.type) !== -1) { if (typeof f.fee === 'number') out.fee = f.fee; }
      return out;
    });
  }

  async function savePreset() {
    const inp = $('ad-preset-name');
    const name = (inp && inp.value ? inp.value : currentPresetName).trim();
    if (!name) { showNotify('Bitte einen Namen eingeben.', true); return; }
    readLevelNames();
        const levelNames = {};
        LEVEL_KEYS.forEach((k) => { if (currentLevelNames[k]) levelNames[k] = currentLevelNames[k]; });
        // Regeln aus den Eingabefeldern übernehmen (nur Abweichungen von Defaults)
        readSettingsInputs();
        const settings = settingsPayload();
        try {
          const created = !presetList.some((p) => p.name === name);
          await api('POST', '/presets', {
            name,
            fields: normalizeFields(),
            levelNames: Object.keys(levelNames).length ? levelNames : null,
            settings
          });
      showNotify('Preset "' + name + '" ' + (created ? 'angelegt' : 'gespeichert') + '.');
      closeEditor();
      currentPresetName = name;
      await reloadPresets();
      const sel = $('ad-preset-select');
      if (sel) sel.value = name;
    } catch (e) { showNotify('Speichern fehlgeschlagen: ' + e.message, true); }
  }

  async function deletePreset() {
    const name = currentPresetName;
    if (!name) { showNotify('Kein Preset ausgewählt.', true); return; }
    if (!window.confirm('Preset "' + name + '" wirklich löschen?')) return;
    try {
      await api('DELETE', '/presets/' + encodeURIComponent(name));
      showNotify('Preset "' + name + '" gelöscht.');
      currentPresetName = '';
      await reloadPresets();
    } catch (e) { showNotify('Löschen fehlgeschlagen: ' + e.message, true); }
  }

  function initPresets() {
    const sel = $('ad-preset-select');
    if (sel) sel.addEventListener('change', () => { currentPresetName = sel.value || ''; updatePresetMeta(); });
    const nb = $('btn-ad-preset-new');
    if (nb) nb.addEventListener('click', () => {
          currentPresetName = '';
          editingFields = DEFAULT_FIELDS();
          currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES);
          currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS_CLIENT));
          const inp = $('ad-preset-name'); if (inp) inp.value = '';
          openEditor();
        });
        const ed = $('btn-ad-preset-edit');
        if (ed) ed.addEventListener('click', () => {
          if (!currentPresetName) { showNotify('Bitte ein Preset auswählen.', true); return; }
          const p = presetList.find((x) => x.name === currentPresetName);
          editingFields = (p && Array.isArray(p.fields) && p.fields.length) ? p.fields.map((f) => ({ ...f })) : DEFAULT_FIELDS();
          currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES, (p && p.levelNames) || {});
          applyPresetSettings(p);
          openEditor();
        });
    const tg = $('btn-ad-preset-toggle');
    if (tg) tg.addEventListener('click', async () => {
      if (!currentPresetName) { showNotify('Bitte ein Preset auswählen.', true); return; }
      const p = presetList.find((x) => x.name === currentPresetName);
      const next = !(p && p.enabled === false);
      try {
        await api('POST', '/presets/' + encodeURIComponent(currentPresetName) + '/set-enabled', { enabled: next });
        showNotify('Preset "' + currentPresetName + '" ' + (next ? 'aktiviert' : 'deaktiviert') + '.');
        await reloadPresets();
      } catch (e) { showNotify('Umschalten fehlgeschlagen: ' + e.message, true); }
    });
    const dl = $('btn-ad-preset-delete');
    if (dl) dl.addEventListener('click', deletePreset);
    const closeB = $('btn-admin-preset-close');
    if (closeB) closeB.addEventListener('click', closeEditor);
    const saveB = $('btn-admin-preset-save');
    if (saveB) saveB.addEventListener('click', savePreset);
    const addB = $('btn-ad-field-add');
    if (addB) addB.addEventListener('click', () => { editingFields.push({ type: 'grundstueck', name: 'Neues Feld', price: 100000 }); renderFields(); });
  }

  // ---------------- Protokoll ----------------
  async function reloadLog() {
    try {
      const d = await api('GET', '/log');
      const el = $('ad-log-list');
      const rows = d.log || [];
      if (!rows.length) { el.innerHTML = '<div class="ad-empty">Noch keine Aktionen protokolliert.</div>'; return; }
      const actionLbl = { delete_game: 'Spiel gelöscht', delete_preset: 'Preset gelöscht', save_preset: 'Preset gespeichert', login: 'Anmeldung', login_failed: 'Login fehlgeschlagen', change_password: 'Passwort geändert', create_manager_code: 'Manager-Code erzeugt', delete_manager_code: 'Manager-Code entfernt', rename_manager_code: 'Manager-Code umbenannt', manager_login: 'Manager eingeloggt', enable_preset: 'Preset aktiviert', disable_preset: 'Preset deaktiviert' };
      el.innerHTML = rows.map((r) =>
        '<div class="ad-row"><div class="ad-row-main">' +
        '<div class="ad-row-head"><span class="ad-status ok">' + esc(actionLbl[r.action] || r.action) + '</span>' +
        '<strong>' + esc(r.target || '—') + '</strong></div>' +
        (r.detail ? '<div class="ad-meta">' + esc(r.detail) + '</div>' : '') +
        '</div><div class="ad-row-side"><span class="hint">' + esc(r.created_at) + '</span></div></div>'
      ).join('');
    } catch (e) {}
  }

  // ---------------- Manager-Codes ----------------
  async function reloadManagerCodes() {
    try {
      const d = await api('GET', '/manager-codes');
      const listEl = $('ad-manager-list');
      const rows = d.codes || [];
      if (!rows.length) { if (listEl) listEl.innerHTML = '<div class="ad-empty">Noch keine Manager-Codes. Erstelle einen, um einem Spieler erweiterte Preset-Rechte zu geben.</div>'; return; }
      if (listEl) {
        // row-parts sind Escaped; Kinder einzeln gebaut, kein rohes innerHTML aus Serverdaten.
        listEl.innerHTML = '';
        rows.forEach((c) => {
          const row = document.createElement('div');
          row.className = 'ad-row';
          const main = document.createElement('div');
          main.className = 'ad-row-main';
          const head = document.createElement('div');
          head.className = 'ad-row-head';
          const nameStrong = document.createElement('strong');
          nameStrong.textContent = c.name || '—';
          head.appendChild(nameStrong);
          main.appendChild(head);
          const meta = document.createElement('div');
          meta.className = 'ad-meta';
          meta.textContent = 'Code: ' + c.code + ' · erstellt ' + (c.created_at || '—');
          main.appendChild(meta);
          row.appendChild(main);
          const side = document.createElement('div');
          side.className = 'ad-row-side';
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'btn btn-xs btn-danger';
          delBtn.textContent = 'Entfernen';
          delBtn.addEventListener('click', () => confirmDeleteManagerCode(c.code, c.name));
          side.appendChild(delBtn);
          row.appendChild(side);
          listEl.appendChild(row);
        });
      }
    } catch (e) {}
  }

  // ---------------- SC-Daten (Star-Citizen-Wiki-Katalog) ----------------
  let scState = { ships: [], locations: [], shipsUpdatedAt: null, locationsUpdatedAt: null };
  let scShipFilter = '';
  let scLocFilter = '';
  let scEditing = null; // { kind, id }

  async function reloadScdata() {
    try {
      const d = await api('GET', '/sc-data');
      scState.ships = d.ships || [];
      scState.locations = d.locations || [];
      scState.shipsUpdatedAt = d.shipsUpdatedAt;
      scState.locationsUpdatedAt = d.locationsUpdatedAt;
      renderScBlocks();
    } catch (e) { /* token läuft evtl. ab */ }
  }

  function fmtScDate(iso) {
    if (!iso) return 'noch nie aktualisiert';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderScBlocks() {
    renderScList('ship', 'ad-sc-ships', 'sc-ships-meta', 'sc-ships-filter', scState.ships, scState.shipsUpdatedAt, scShipFilter);
    renderScList('location', 'ad-sc-locs', 'sc-locs-meta', 'sc-locs-filter', scState.locations, scState.locationsUpdatedAt, scLocFilter);
    bindScFilter('sc-ships-filter', 'ship');
    bindScFilter('sc-locs-filter', 'location');
  }

  function renderScList(kind, listId, metaId, filterId, items, updatedAt, filterText) {
    const listEl = $(listId);
    if (!listEl) return;
    const metaEl = $(metaId);
    if (metaEl) metaEl.textContent = items.length + ' Einträge · zuletzt aktualisiert: ' + fmtScDate(updatedAt);
    const q = (filterText || '').trim().toLowerCase();
    const filtered = q ? items.filter((x) => x.name.toLowerCase().includes(q)) : items;
    listEl.innerHTML = '';
    if (!items.length) {
      listEl.appendChild(Object.assign(document.createElement('div'), { className: 'ad-empty', textContent: 'Katalog leer — „Jetzt aktualisieren“ holt die Namen.' }));
      return;
    }
    if (!filtered.length) {
      listEl.appendChild(Object.assign(document.createElement('div'), { className: 'ad-empty', textContent: 'Keine Einträge zum Filter.' }));
      return;
    }
    filtered.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'ad-row';
      const main = document.createElement('div');
      main.className = 'ad-row-main';
      const isEditing = scEditing && scEditing.kind === kind && scEditing.id === it.id;
      const nameEl = (() => {
        if (!isEditing) {
          const strong = document.createElement('strong');
          strong.className = 'ad-sc-name';
          strong.textContent = it.name;
          return strong;
        }
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'ad-sc-edit';
        inp.value = it.name;
        inp.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') submitScRename(kind, it.id, inp.value);
          else if (ev.key === 'Escape') { scEditing = null; renderScBlocks(); }
        });
        return inp;
      })();
      main.appendChild(nameEl);
      row.appendChild(main);
      const side = document.createElement('div');
      side.className = 'ad-row-side';
      if (isEditing) {
        const okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.className = 'ad-sc-btn'; okBtn.textContent = 'Speichern';
        okBtn.addEventListener('click', () => submitScRename(kind, it.id, side.querySelector('.ad-sc-edit') ? side.querySelector('.ad-sc-edit').value : it.name));
        const cancelBtn = document.createElement('button'); cancelBtn.type = 'button'; cancelBtn.className = 'ad-sc-btn'; cancelBtn.textContent = 'Abbrechen';
        cancelBtn.addEventListener('click', () => { scEditing = null; renderScBlocks(); });
        side.appendChild(okBtn); side.appendChild(cancelBtn);
      } else {
        const editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.className = 'ad-sc-btn'; editBtn.textContent = 'Bearbeiten';
        editBtn.addEventListener('click', () => { scEditing = { kind, id: it.id }; renderScBlocks(); });
        const delBtn = document.createElement('button'); delBtn.type = 'button'; delBtn.className = 'ad-sc-btn danger'; delBtn.textContent = 'Löschen';
        delBtn.addEventListener('click', () => confirmScDelete(kind, it.id, it.name));
        side.appendChild(editBtn); side.appendChild(delBtn);
      }
      row.appendChild(side);
      listEl.appendChild(row);
    });
  }

  function bindScFilter(filterId, kind) {
    const f = $(filterId);
    if (!f) return;
    f.value = kind === 'ship' ? scShipFilter : scLocFilter;
    f.oninput = () => {
      if (kind === 'ship') scShipFilter = f.value;
      else scLocFilter = f.value;
      renderScBlocks();
    };
  }

  function submitScRename(kind, id, newName) {
    (async () => {
      try {
        const d = await api('POST', '/sc-name/rename', { kind, id, name: newName });
        if (d && d.ok) { scEditing = null; showNotify('Name aktualisiert.'); await reloadScdata(); }
        else showNotify((d && d.message) || 'Umbenennen fehlgeschlagen.', true);
      } catch (e) { showNotify('Umbenennen fehlgeschlagen.', true); }
    })();
  }

  function confirmScDelete(kind, id, name) {
    if (!window.confirm('Eintrag löschen? ' + name)) return;
    (async () => {
      try {
        const d = await api('DELETE', '/sc-name/' + kind + '/' + id);
        if (d && d.ok) { showNotify('Eintrag gelöscht.'); await reloadScdata(); }
        else showNotify((d && d.message) || 'Löschen fehlgeschlagen.', true);
      } catch (e) { showNotify('Löschen fehlgeschlagen.', true); }
    })();
  }

  function initScdata() {
    const syncBtn = $('btn-sc-sync');
    if (syncBtn) syncBtn.addEventListener('click', () => {
      (async () => {
        const resEl = $('sc-sync-result');
        if (resEl) { resEl.textContent = 'aktualisiere …'; resEl.className = 'sc-sync-result'; }
        if (syncBtn) syncBtn.disabled = true;
        try {
          const d = await api('POST', '/sc-sync');
          if (d && d.ok) {
            if (resEl) { resEl.textContent = '✓ Schiffe: ' + (d.ships ? d.ships.count : 0) + ' · Orte: ' + (d.locations ? d.locations.count : 0) + ' — aktuell gespeichert.'; resEl.className = 'sc-sync-result ok'; }
            await reloadScdata();
          } else {
            if (resEl) { resEl.textContent = '✖ Sync fehlgeschlagen: ' + ((d && (d.message || (d.errors && d.errors.map((x) => x.error).join(', ')))) || 'unbekannt'); resEl.className = 'sc-sync-result err'; }
          }
        } catch (e) {
          if (resEl) { resEl.textContent = '✖ Sync fehlgeschlagen.'; resEl.className = 'sc-sync-result err'; }
        } finally {
          if (syncBtn) syncBtn.disabled = false;
        }
      })();
    });
  }

  async function createManagerCode() {
    const nameIn = $('mgr-name-input');
    const name = (nameIn ? nameIn.value : '').trim();
    if (!name) { showNotify('Bitte ein internes Namenslabel angeben (wer ist der Manager?).', true); return; }
    try {
      const d = await api('POST', '/manager-codes', { name });
      const result = $('mgr-code-result');
      if (result) {
        result.classList.remove('hidden');
        // Der Code ist ein serverseitig erzeugtes Geheimnis — nur hier einmalig zeigen.
        const pre = document.createElement('strong');
        pre.textContent = 'Neuer Code für "' + d.name + '": ' + d.code;
        result.innerHTML = '';
        result.appendChild(pre);
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = 'Kopiere ihn jetzt — nach dem Neuladen ist er nur noch als Liste (ohne Geheimnis-Hervorhebung) sichtbar.';
        result.appendChild(hint);
      }
      if (nameIn) nameIn.value = '';
      showNotify('Manager-Code erzeugt.');
      await reloadManagerCodes();
    } catch (e) { showNotify('Erzeugen fehlgeschlagen: ' + e.message, true); }
  }

  function confirmDeleteManagerCode(code, name) {
    if (!window.confirm('Manager-Code für "' + name + '" entfernen?\nDer Zugang wird damit sofort entzogen.')) return;
    (async () => {
      try {
        await api('DELETE', '/manager-codes/' + encodeURIComponent(code));
        showNotify('Manager-Code entfernt.');
        await reloadManagerCodes();
      } catch (e) { showNotify('Entfernen fehlgeschlagen: ' + e.message, true); }
    })();
  }

  function initManagers() {
    const createBtn = $('btn-ad-mgr-create');
    if (createBtn) createBtn.addEventListener('click', createManagerCode);
    const nameIn = $('mgr-name-input');
    if (nameIn) nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') createManagerCode(); });
  }

  // ---------------- Boot ----------------
  function boot() {
      const stored = loadStoredToken();
      initLogin();
      initPresets();
      initManagers();
      initScdata();
      // Ersteinrichtung prüfen (falls kein Admin-Konto existstiert).
      checkSetup();
    // Bei gespeichertem Token: verifizieren und Dashboard zeigen.
    const tryEnter = async (tok) => {
      setToken(tok, null);
      try {
        const me = await api('GET', '/me');
        setToken(tok, me.username);
        const u = $('admin-user');
        if (u) u.textContent = 'Angemeldet: admin';
        showView('dashboard');
      } catch (e) {
        showView('login');
      }
    };
    if (stored) { tryEnter(stored); }
    else { showView('login'); }
  }

  window.addEventListener('DOMContentLoaded', boot);
  // Für potenzielle Test-/Debug-Zugriffe (kein Secret — nur UI-Helfer).
  window.__admin = { api, showView, showNotify, reloadGames, reloadPresets };
})();
