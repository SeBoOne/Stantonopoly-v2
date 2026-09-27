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
  const VIEWS = ['login', 'dashboard', 'games', 'presets', 'log'];
  function showView(name) {
    VIEWS.forEach((v) => {
      const el = $('view-' + v);
      if (el) { el.classList.toggle('hidden', v !== name); el.classList.toggle('active', v === name); }
    });
    document.body.classList.remove('view-login', 'view-dashboard', 'view-games', 'view-presets', 'view-log');
    document.body.classList.add('view-' + name);
    // Nav aktualisieren
    renderNav(name);
    if (name === 'dashboard') reloadDashboard();
    else if (name === 'games') reloadGames();
    else if (name === 'presets') reloadPresets();
    else if (name === 'log') reloadLog();
  }

  function renderNav(active) {
    const nav = $('admin-nav');
    if (!nav) return;
    nav.innerHTML = '';
    const items = [['dashboard', 'Übersicht'], ['games', 'Spiele'], ['presets', 'Presets'], ['log', 'Protokoll']];
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
        o.textContent = p.name + (p.builtin ? ' (Standard)' : ' (eigen)');
        sel.appendChild(o);
      });
      if (currentPresetName && Array.from(sel.options).some((o) => o.value === currentPresetName)) sel.value = currentPresetName;
      updatePresetMeta();
    } catch (e) {}
  }

  function updatePresetMeta() {
    const p = presetList.find((x) => x.name === currentPresetName);
    const meta = $('ad-preset-meta');
    if (meta) meta.textContent = p ? (p.builtin ? 'Eingebautes Preset — kann umbenannt/kopiert, nicht überschrieben oder gelöscht werden.' : ('Eigenes Preset · ' + (p.fields ? p.fields.length : 0) + ' Felder · zuletzt ' + (p.updated_at || '—'))) : '';
  }

  // Admin-Preset-Editor (spiegelt den Spiel-Preset-Editor für die Kernfunktionen).
  function openEditor() {
    const m = $('admin-preset-modal');
    if (m) m.classList.remove('hidden');
    const inp = $('ad-preset-name');
    if (inp && currentPresetName) inp.value = currentPresetName;
    renderFields();
    syncLevelNames();
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
      const nameIn = document.createElement('input');
      nameIn.type = 'text'; nameIn.value = f.name || ''; nameIn.placeholder = 'Name';
      nameIn.addEventListener('input', () => { f.name = nameIn.value; });
      const priceIn = document.createElement('input');
      priceIn.type = 'number'; priceIn.min = '0'; priceIn.step = '10000';
      priceIn.value = typeof f.price === 'number' ? f.price : '';
      priceIn.placeholder = 'Preis';
      priceIn.disabled = f.type !== 'grundstueck';
      priceIn.addEventListener('input', () => { f.price = Number(priceIn.value) || 0; });
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
    try {
      const created = !presetList.some((p) => p.name === name);
      await api('POST', '/presets', {
        name,
        fields: normalizeFields(),
        levelNames: Object.keys(levelNames).length ? levelNames : null
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
      const inp = $('ad-preset-name'); if (inp) inp.value = '';
      openEditor();
    });
    const ed = $('btn-ad-preset-edit');
    if (ed) ed.addEventListener('click', () => {
      if (!currentPresetName) { showNotify('Bitte ein Preset auswählen.', true); return; }
      const p = presetList.find((x) => x.name === currentPresetName);
      editingFields = (p && Array.isArray(p.fields) && p.fields.length) ? p.fields.map((f) => ({ ...f })) : DEFAULT_FIELDS();
      currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES, (p && p.levelNames) || {});
      openEditor();
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
      const actionLbl = { delete_game: 'Spiel gelöscht', delete_preset: 'Preset gelöscht', save_preset: 'Preset gespeichert', login: 'Anmeldung', login_failed: 'Login fehlgeschlagen', change_password: 'Passwort geändert' };
      el.innerHTML = rows.map((r) =>
        '<div class="ad-row"><div class="ad-row-main">' +
        '<div class="ad-row-head"><span class="ad-status ok">' + esc(actionLbl[r.action] || r.action) + '</span>' +
        '<strong>' + esc(r.target || '—') + '</strong></div>' +
        (r.detail ? '<div class="ad-meta">' + esc(r.detail) + '</div>' : '') +
        '</div><div class="ad-row-side"><span class="hint">' + esc(r.created_at) + '</span></div></div>'
      ).join('');
    } catch (e) {}
  }

  // ---------------- Boot ----------------
  function boot() {
      const stored = loadStoredToken();
      initLogin();
      initPresets();
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
