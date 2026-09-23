/* =========================================================================
 * Stantonopoly V2 — Frontend-Controller (client.js)
 * socket.io-client + UI-Flows (GM-Setup, Team-Join, Leiterwahl, In-Game).
 *
 * SERVER-AUTHORITATIV: Diese Datei zeigt NUR empfangene states an und sendet
 * Aktionen. Es wird hier NIE abgerechnet (kein Budget, keine Position, keine
 * Rente client-seitig berechnet).
 *
 * DOM-IDs und board.js-Expose kommen von public/index.html / board.js
 * (anderes Kind). Falls board.js fehlt: graceful Fallback (Feldliste in #board).
 * ========================================================================= */
(function () {
  'use strict';

  /* ---------------- DOM-Helfer ---------------- */
  const $ = (id) => document.getElementById(id);

  function showNotify(msg) {
    const el = $('notify');
    if (!el) return;
    window.__notifyEl = el;
    el.textContent = msg;
    el.classList.remove('hidden');
    // Fehler-Hinweis-Format kurz beibehalten
    if (showNotify._errClean) { clearTimeout(showNotify._errClean); showNotify._errClean = null; }
    if (el.classList.contains('is-error')) {
      showNotify._errClean = setTimeout(() => el.classList.remove('is-error'), 5000);
    }
    if (showNotify._timer) clearTimeout(showNotify._timer);
    showNotify._timer = setTimeout(() => el.classList.add('hidden'), 5000);
  }

  // ---------------- Modal-System (Bestätigung mit Info + Abbrechen) ----------------
  // Erzeugt ein zentriertes Overlay mit Titel, Info-Zeilen und [Abbrechen][Bestätigen].
  // onConfirm wird beim OK gerufen (und alles geschlossen). IMMER schließbar:
  // ✕-Button oben, Abbrechen-Button unten, Overlay-Klick und ESC. onCancel (optional)
  // ist eine Zusatz-Aktion, die beim Schließen via Abbrechen/✕/ESC/Overlay läuft.
  function openModal(opts) {
    const prev = $('stp-modal');
    if (prev) closeModal();
    if (typeof opts === 'string') opts = { body: opts };
    const wrap = document.createElement('div');
    wrap.id = 'stp-modal';
    wrap.className = 'modal-overlay';

    // Overlay-Klick schließt (nur wenn direkt auf das Overlay geklickt wird,
    // nicht auf das Panel selbst).
    wrap.addEventListener('click', (ev) => {
      if (ev.target === wrap) { closeModal({ runCancel: true }); }
    });
    // ESC schließt.
    const escH = (ev) => { if (ev.key === 'Escape') { closeModal({ runCancel: true }); } };
    document.addEventListener('keydown', escH);

    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    if (opts.title) {
      const h = document.createElement('div');
      h.className = 'modal-title';
      h.innerHTML = esc(opts.title);
      // ✕-Schließen oben rechts (immer vorhanden)
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'modal-close';
      x.textContent = '✕';
      x.addEventListener('click', () => closeModal({ runCancel: true }));
      h.appendChild(x);
      panel.appendChild(h);
    }
    if (opts.icon) {
      const ic = document.createElement('div');
      ic.className = 'modal-icon';
      ic.innerHTML = opts.icon;
      panel.appendChild(ic);
    }
    if (opts.body) {
      const b = document.createElement('div');
      b.className = 'modal-body';
      b.innerHTML = opts.body;
      panel.appendChild(b);
    }
    const row = document.createElement('div');
    row.className = 'modal-btns';
    // Abbrechen IMMER vorhanden (schließt). onCancel läuft dabei, falls gesetzt.
    const cb = document.createElement('button');
    cb.type = 'button';
    cb.className = 'btn btn-xs';
    cb.textContent = opts.cancelText || 'Abbrechen';
    cb.addEventListener('click', () => closeModal({ runCancel: true }));
    row.appendChild(cb);
    if (opts.onConfirm != null) {
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn btn-xs ' + (opts.confirmClass || 'btn-ok');
      ok.textContent = opts.confirmText || 'OK';
      ok.addEventListener('click', () => closeModal({ runCancel: false, confirm: true }));
      row.appendChild(ok);
    }
    panel.appendChild(row);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);
    // onCancel nach dem Mount speichern, damit closeModal ihn kennt.
    wrap.setAttribute('data-hascancel', opts.onCancel ? '1' : '0');
    client.__modalCancel = opts.onCancel;
    client.__modalConfirm = opts.onConfirm;
    // ESC-Handler wieder entfernen, wenn das nächste Modal kommt oder geschlossen wird.
    window.__modalEscH = escH;
    if (opts.onOpen) opts.onOpen();
  }

  function closeModal({ runCancel, confirm } = {}) {
    const el = $('stp-modal');
    // onCancel/onConfirm genau EINMAL ausführen, danach bereinigen.
    if (confirm && client.__modalConfirm) { const fn = client.__modalConfirm; client.__modalConfirm = null; client.__modalCancel = null; fn(); }
    else if (runCancel && client.__modalCancel) { const fn = client.__modalCancel; client.__modalCancel = null; client.__modalConfirm = null; fn(); }
    else { client.__modalCancel = null; client.__modalConfirm = null; }
    if (window.__modalEscH) { document.removeEventListener('keydown', window.__modalEscH); window.__modalEscH = null; }
    if (el) el.remove();
  }

  /* ---------------- Client-Zustand ---------------- */
  const client = {
    gameId: null,      // aktives Spiel (Raum)
    gmCode: null,      // GM-Code (nur GM kennt ihn)
    teamId: null,      // eigenes Team (null = Beobachter)
    playerId: null,    // eigene Spieler-ID
    role: null,        // 'gm' | 'leader' | 'member' | 'spectator'
    isGM: false,
    lastState: null,   // letzter empfangener state
    boardReady: false,
  };

  // Join-Stand in localStorage sichern, damit ein Neuladen automatisch
  // rejoin-t (eigene Identität/Team bleibt erhalten).
  const LS_KEY = 'stantonopoly.joined.v1';
  function saveJoin() {
    if (!client.gameId || !client.token) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        gameId: client.gameId,
        token: client.token,
        name: client.playerName || ''
      }));
    } catch (e) { /* Speicher blockiert */ }
  }
  function loadJoin() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function clearJoin() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  // GM-Zustand sichern, damit ein Neuladen des GM denselben Bildschirm wiederholt.
  const GM_KEY = 'stantonopoly.gm.v1';
  function saveGM() {
    if (!client.gameId || !client.gmCode) return;
    try {
      localStorage.setItem(GM_KEY, JSON.stringify({ gameId: client.gameId, gmCode: client.gmCode }));
    } catch (e) {}
  }
  function loadGM() {
    try {
      const raw = localStorage.getItem(GM_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function clearGM() {
    try { localStorage.removeItem(GM_KEY); } catch (e) {}
  }

  const TEAM_COLORS = ['#2ecc71', '#95a5a6', '#f1c40f', '#e74c3c', '#3498db', '#e67e22'];

  /* ---------------- Socket ---------------- */
  if (typeof io === 'undefined') {
    console.error('[client.js] window.io fehlt — socket.io-client wurde nicht geladen.');
    showNotify('Fehler: Socket.io-Client fehlt, bitte Seite neu laden.');
    return;
  }
  const socket = io();

  socket.on('connect', () => console.log('[client.js] verbunden'));
  socket.on('disconnect', () => {
    console.log('[client.js] getrennt');
    showNotify('Verbindung zum Server getrennt — verbinde neu…');
  });

  /* ---------------- View-Navigation ---------------- */
  const VIEWS = ['setup', 'lobby', 'game', 'games'];
  function showView(name) {
    VIEWS.forEach((v) => {
      const el = $('view-' + v);
      if (el) {
        el.classList.toggle('hidden', v !== name);
        el.classList.toggle('active', v === name);
      }
    });
  }

  /* ---------------- Rollen-Helfer ---------------- */
  function normRole() {
    return (client.role || '').toLowerCase();
  }
  // true, wenn die eigene Rolle eine aktionsfähige Rolle ist (Leader oder GM)
  function canAct() {
    const r = normRole();
    return r.indexOf('gm') !== -1 || r.indexOf('leader') !== -1;
  }
  function isSpectator() {
    return normRole().indexOf('spect') !== -1 || client.role === 'observer';
  }

  /* ---------------- Header-Navigation (Ansicht wechseln) ------------- */
  const navSetup = $('nav-setup');
  const navJoin = $('nav-join');
  if (navSetup) navSetup.addEventListener('click', () => showView('setup'));
  if (navJoin) navJoin.addEventListener('click', () => openJoinModal());

  /* ---------------- Kopieren-Helfer ------------- */
  function copyText(text, btn) {
    const done = () => {
      if (btn) { const old = btn.textContent; btn.textContent = '✓ kopiert'; setTimeout(() => { btn.textContent = old; }, 1500); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); done();
    }
  }

  /* ---------------- Flow 1: GM-Setup ---------------- */
    const DEFAULT_SHIPS = ['Redeemer', 'Hammerhead', 'Reclaimer', 'Caterpillar', 'Carrack', '890 Jump', 'Moth', 'Railen'];
    const SHIP_DEFAULT_TASKS = {
      'Redeemer': 'ERT oder VHRT-Mission erledigen',
      'Hammerhead': 'ERT oder VHRT-Mission erledigen',
      'Reclaimer': 'Hammerhead-Salvage-Mission erledigen',
      'Moth': 'Hammerhead-Salvage-Mission erledigen',
      'Caterpillar': 'Einen Traderun erledigen',
      'Railen': 'Einen Traderun erledigen',
      'Carrack': 'Delivery-Mission (mit Begleitschiff/Kommandomodul) erledigen',
      '890 Jump': 'Mit einem Snub eine Runde bei Miners Lament, Caplan oder Yadar Valley fliegen'
    };

    /* ---------------- Preset-Editor (eigene Karten) ---------------- */
    // Fallback-Standardfelder (wird genutzt, falls Server-Presets noch nicht geladen)
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

    let presetList = [];          // [{name, builtin}]
    let currentPresetName = 'Crusader Cluster';
    let editingFields = DEFAULT_FIELDS();
    // Ausbaustufen-Namen (je Preset anpassbar). Defaults = data.js DEFAULT_LEVEL_NAMES.
    const DEFAULT_LEVEL_NAMES = { ALLEIN: 'Standard', CYCLONE: 'Cyclone', STORM: 'Storm', BALLISTA: 'Ballista', ARMISTICE: 'Armistice Zone' };
    let currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES);
    const LEVEL_KEYS = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA', 'ARMISTICE'];
    function syncLevelNameInputs() {
      LEVEL_KEYS.forEach((k) => {
        const inp = $(('lvl-' + k));
        if (inp && inp.value !== undefined) inp.value = currentLevelNames[k] || '';
      });
    }
    function readLevelNameInputs() {
      LEVEL_KEYS.forEach((k) => {
        const inp = $(('lvl-' + k));
        const v = inp ? (inp.value || '').trim() : '';
        // Nur nicht-leere Einträge übernehmen (leer = Default/gewohnten Wert behalten)
        if (v) currentLevelNames[k] = v;
        else if (!currentLevelNames[k]) currentLevelNames[k] = DEFAULT_LEVEL_NAMES[k] || '';
      });
    }

    // Spielregeln (Settings) je Preset. Interne Werte = Dezimal (wie Server);
    // die Eingabefelder zeigen Prozent (50 → 0.50). Defaults = data.js DEFAULT_SETTINGS.
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
      armisticeEnabled: false
    };
    let currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS_CLIENT));
    function syncSettingsInputs() {
      const set = (id, v) => { const el = $(id); if (el && el.value !== undefined) { if (typeof v === 'undefined' || v === null) el.value = ''; else el.value = Math.round(v * 100); } };
      set('s-rent-ALLEIN', currentSettings.rentMult.ALLEIN);
      set('s-rent-CYCLONE', currentSettings.rentMult.CYCLONE);
      set('s-rent-STORM', currentSettings.rentMult.STORM);
      set('s-rent-BALLISTA', currentSettings.rentMult.BALLISTA);
      set('s-rent-ARMISTICE', currentSettings.rentMult.ARMISTICE);
      set('s-build-CYCLONE', currentSettings.buildMult.CYCLONE);
      set('s-build-STORM', currentSettings.buildMult.STORM);
      set('s-build-BALLISTA', currentSettings.buildMult.BALLISTA);
      set('s-build-ARMISTICE', currentSettings.buildMult.ARMISTICE);
      set('s-mortgage-mult', currentSettings.mortgageMult);
      { const el = $('s-unmortgage-rate'); if (el) el.value = String(Math.round((currentSettings.unmortgageRate - 1) * 100)); } // +% (Prozentwert direkt, nicht via set() doppelt *100)
      set('s-bank-payout', currentSettings.bankPayout);
      set('s-demolish-refund', currentSettings.demolishRefundRate);
      const bs = $('s-bank-sell'); if (bs) bs.checked = !!currentSettings.bankSellEnabled;
      { const el = $('s-auction-ms'); if (el) el.value = Math.round(currentSettings.auctionMs / 1000); }
      { const el = $('s-poll-ms'); if (el) el.value = Math.round(currentSettings.pollMs / 1000); }
      { const el = $('s-armistice'); if (el) el.checked = !!currentSettings.armisticeEnabled; }
    }
    function readSettingsInputs() {
      const p = (v, d) => { if (v == null) return d; const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
      const read = (id, apply) => { const el = $(id); if (el) { const v = el.value; if (v !== undefined && v !== '') apply(v); } };
      read('s-rent-ALLEIN', (v) => currentSettings.rentMult.ALLEIN = p(v, 0.10) / 100);
      read('s-rent-CYCLONE', (v) => currentSettings.rentMult.CYCLONE = p(v, 0.50) / 100);
      read('s-rent-STORM', (v) => currentSettings.rentMult.STORM = p(v, 1.00) / 100);
      read('s-rent-BALLISTA', (v) => currentSettings.rentMult.BALLISTA = p(v, 2.00) / 100);
      read('s-rent-ARMISTICE', (v) => currentSettings.rentMult.ARMISTICE = p(v, 3.00) / 100);
      read('s-build-CYCLONE', (v) => currentSettings.buildMult.CYCLONE = p(v, 0.25) / 100);
      read('s-build-STORM', (v) => currentSettings.buildMult.STORM = p(v, 0.50) / 100);
      read('s-build-BALLISTA', (v) => currentSettings.buildMult.BALLISTA = p(v, 1.00) / 100);
      read('s-build-ARMISTICE', (v) => currentSettings.buildMult.ARMISTICE = p(v, 1.50) / 100);
      read('s-mortgage-mult', (v) => currentSettings.mortgageMult = p(v, 0.75) / 100);
      read('s-unmortgage-rate', (v) => currentSettings.unmortgageRate = p(v, 10) / 100 + 1);
      read('s-bank-payout', (v) => currentSettings.bankPayout = p(v, 0.75) / 100);
      read('s-demolish-refund', (v) => currentSettings.demolishRefundRate = p(v, 0.50) / 100);
      const bs = $('s-bank-sell'); if (bs) currentSettings.bankSellEnabled = !!bs.checked;
      read('s-auction-ms', (v) => currentSettings.auctionMs = Math.max(1, Math.round(Number(v)) * 1000));
      read('s-poll-ms', (v) => currentSettings.pollMs = Math.max(1, Math.round(Number(v)) * 1000));
      { const ae = $('s-armistice'); if (ae) currentSettings.armisticeEnabled = !!ae.checked; }
    }
    // Settings nur senden, wenn sie von den Defaults abweichen (sonst null)
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
      return Object.keys(out).length ? out : null;
    }

    function loadPresetDropdown() {
      const sel = $('cfg-preset');
      if (!sel) return;
      sel.innerHTML = '';
      (presetList.length ? presetList : [{ name: 'Crusader Cluster', builtin: 1 }]).forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name + (p.builtin ? ' (Standard)' : '');
        sel.appendChild(opt);
      });
      // aktuelles Preset wiederherstellen, falls vorhanden
      if (Array.from(sel.options).some((o) => o.value === currentPresetName)) sel.value = currentPresetName;
    }

    function editorSetName(name) {
      currentPresetName = name;
      const inp = $('preset-name');
      if (inp) inp.value = name;
      const meta = $('preset-meta');
      if (meta) {
        const p = presetList.find((x) => x.name === name);
        meta.textContent = p && p.builtin ? ' (eingebaut)' : (p ? ' (eigen)' : '');
      }
      loadPresetDropdown();
    }

    function renderFieldEditor() {
      const list = $('preset-field-list');
      if (!list) return;
      list.innerHTML = '';
      editingFields.forEach((f, i) => {
        const row = document.createElement('div');
        // Los/Gundo haben ein Zusatzfeld (Los-Bonus/Gebühr) → 8-spaltiges Grid.
        row.className = 'preset-field-row' + ((f.type === 'los' || f.type === 'ereignis' || f.type === 'gundo' || f.type === 'gefangnis' || f.type === 'steuer') ? ' has-extra' : '');
        const idx = document.createElement('span');
        idx.className = 'preset-field-idx';
        idx.textContent = i;
        const typeSel = document.createElement('select');
        [['los', 'Los'], ['grundstueck', 'Grundstück'], ['ereignis', 'Ereignis'], ['gefangnis', 'Gefängnis'], ['freiparken', 'Frei Parken'], ['steuer', 'Steuer']].forEach(([v, l]) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = l;
          if (f.type === v) o.selected = true;
          typeSel.appendChild(o);
        });
        typeSel.addEventListener('change', () => { f.type = typeSel.value; renderFieldEditor(); });
        const nameIn = document.createElement('input');
        nameIn.type = 'text';
        nameIn.value = f.name || '';
        nameIn.placeholder = 'Name';
        nameIn.addEventListener('input', () => { f.name = nameIn.value; });
        const priceIn = document.createElement('input');
        priceIn.type = 'number';
        priceIn.min = '0';
        priceIn.step = '10000';
        priceIn.value = typeof f.price === 'number' ? f.price : '';
        priceIn.placeholder = 'Preis';
        priceIn.disabled = f.type !== 'grundstueck';
        priceIn.addEventListener('input', () => { f.price = Number(priceIn.value) || 0; });
        // Sonder-Werte: Los-Feld = Los-Bonus; Gundo-Feld = Übernahme-Gebühr (negativ = Bonus)
        let bonusIn = null, feeIn = null;
        if (f.type === 'los') {
          bonusIn = document.createElement('input');
          bonusIn.type = 'number'; bonusIn.step = '10000';
          bonusIn.value = typeof f.bonus === 'number' ? f.bonus : '';
          bonusIn.placeholder = 'Los-Bonus';
          bonusIn.title = 'Betrag beim Überqueren von Orison (Los)';
          bonusIn.addEventListener('input', () => { f.bonus = Number(bonusIn.value) || 0; });
        } else if (f.type === 'ereignis' || f.type === 'gundo' || f.type === 'steuer' || f.type === 'gefangnis') {
          feeIn = document.createElement('input');
          feeIn.type = 'number'; feeIn.step = '10000';
          feeIn.value = typeof f.fee === 'number' ? f.fee : '';
          if (f.type === 'ereignis' || f.type === 'gundo') {
            feeIn.placeholder = 'Gebühr/Bonus';
            feeIn.title = 'Ereignis-Effekt bei Landung: Gebühr (positiv) oder Bonus (negativ)';
          } else if (f.type === 'steuer') {
            feeIn.placeholder = 'Betrag';
            feeIn.title = 'Steuer-Betrag an die Bank bei Landung';
          } else {
            feeIn.placeholder = 'Lösegeld';
            feeIn.title = 'Gefängnis-Lösegeld: wird sofort gezahlt, um frei zu kommen';
          }
          feeIn.addEventListener('input', () => { f.fee = Number(feeIn.value) || 0; });
        }
        const up = document.createElement('button'); up.type = 'button'; up.className = 'btn btn-xs btn-ghost'; up.textContent = '↑';
        up.addEventListener('click', () => { if (i > 0) { const t = editingFields[i - 1]; editingFields[i - 1] = editingFields[i]; editingFields[i] = t; renderFieldEditor(); } });
        const dn = document.createElement('button'); dn.type = 'button'; dn.className = 'btn btn-xs btn-ghost'; dn.textContent = '↓';
        dn.addEventListener('click', () => { if (i < editingFields.length - 1) { const t = editingFields[i + 1]; editingFields[i + 1] = editingFields[i]; editingFields[i] = t; renderFieldEditor(); } });
        const del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn-xs btn-ghost del'; del.textContent = '✕';
        del.addEventListener('click', () => { editingFields.splice(i, 1); renderFieldEditor(); });
        row.appendChild(idx); row.appendChild(typeSel); row.appendChild(nameIn); row.appendChild(priceIn);
        if (bonusIn) row.appendChild(bonusIn);
        if (feeIn) row.appendChild(feeIn);
        row.appendChild(up); row.appendChild(dn); row.appendChild(del);
        list.appendChild(row);
      });
    }

    function loadPresetByName(name) {
      socket.emit('preset:list', {}); // aktualisiert
      currentPresetName = name;
      editorSetName(name);
      showNotify('Preset geladen: ' + name);
    }

    // Settings aus einem (Preset-)Objekt übernehmen (Default-Merge; Daten sind Dezimal)
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
      if (src.rentMult && typeof src.rentMult === 'object') Object.assign(s.rentMult, src.rentMult);
      if (src.buildMult && typeof src.buildMult === 'object') Object.assign(s.buildMult, src.buildMult);
      currentSettings = s;
    }

    // auf 'presets'-Event: Liste aktualisieren; Felder des aktuell gewählten Presets
    // in den Editor übernehmen (eigen ODER eingebaut), sofern noch nicht bearbeitet.
    socket.on('presets', (data) => {
      if (data && Array.isArray(data.presets)) {
        presetList = data.presets;
        loadPresetDropdown();
        const cur = presetList.find((p) => p.name === currentPresetName);
        if (cur && Array.isArray(cur.fields) && cur.fields.length) {
          // Aktuell gewähltes Preset anzeigen (eigen oder eingebaut).
          editingFields = cur.fields.map((f) => ({ ...f }));
          currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES, cur.levelNames || {});
          applyPresetSettings(cur);
          renderFieldEditor();
          syncLevelNameInputs();
          syncSettingsInputs();
        } else if (cur && cur.builtin) {
          editingFields = DEFAULT_FIELDS();
          currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES, cur.levelNames || {});
          applyPresetSettings(cur);
          renderFieldEditor();
          syncLevelNameInputs();
          syncSettingsInputs();
        }
      }
    });

    function initPresetEditor() {
      loadPresetDropdown();
      renderFieldEditor();
      syncLevelNameInputs();
      syncSettingsInputs();
      editorSetName('Crusader Cluster');
      socket.emit('preset:list', {});
      // Preset-Editor-Modal öffnen/schließen
      const openBtn = $('btn-open-preset-editor');
      if (openBtn) openBtn.addEventListener('click', () => { const m = $('preset-modal'); if (m) m.classList.remove('hidden'); });
      const closeBtn = $('btn-preset-close');
      if (closeBtn) closeBtn.addEventListener('click', () => { const m = $('preset-modal'); if (m) m.classList.add('hidden'); });
      // Events
      const sel = $('cfg-preset');
      if (sel) sel.addEventListener('change', () => {
        const name = sel.value || 'Crusader Cluster';
        editorSetName(name);
        const p = presetList.find((x) => x.name === name);
        if (p && Array.isArray(p.fields) && p.fields.length) {
          // Geladenes Preset (eigen ODER eingebaut) in den Editor übernehmen
          editingFields = p.fields.map((f) => ({ ...f }));
          currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES, p.levelNames || {});
          applyPresetSettings(p);
          renderFieldEditor();
          syncLevelNameInputs();
          syncSettingsInputs();
          showNotify('Preset "' + name + '" geladen.');
        } else if (!p || p.builtin) {
          editingFields = DEFAULT_FIELDS();
          currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES);
          applyPresetSettings(p);
          renderFieldEditor();
          syncLevelNameInputs();
          syncSettingsInputs();
        }
      });
      const newBtn = $('btn-preset-new');
      if (newBtn) newBtn.addEventListener('click', () => {
        editingFields = DEFAULT_FIELDS();
        currentPresetName = '';
        currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES);
        currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS_CLIENT));
        const inp = $('preset-name');
        if (inp) inp.value = '';
        renderFieldEditor();
        syncLevelNameInputs();
        syncSettingsInputs();
        showNotify('Neues leeres Preset — Felder, Namen und Regeln bearbeiten und speichern.');
      });
      const saveBtn = $('btn-preset-save');
      if (saveBtn) saveBtn.addEventListener('click', () => {
        const inp = $('preset-name');
        const name = (inp && inp.value ? inp.value : currentPresetName).trim();
        if (!name) { showNotify('Bitte einen Namen für das Preset eingeben.'); return; }
        editorSetName(name);
        // Stufen-Namen aus den Eingabefeldern übernehmen (nur nicht-leere zählen)
        readLevelNameInputs();
        const levelNames = {};
        LEVEL_KEYS.forEach((k) => { if (currentLevelNames[k]) levelNames[k] = currentLevelNames[k]; });
        // Regeln aus den Eingabefeldern übernehmen (nur Abweichungen von Defaults)
        readSettingsInputs();
        const settings = settingsPayload();
        // Item-Preise normalisieren
        const fields = editingFields.map((f) => ({
          type: f.type || 'los',
          name: f.name || 'Feld',
          ...(f.type === 'grundstueck' && typeof f.price === 'number' ? { price: f.price } : {})
        }));
        socket.emit('preset:save', { name, fields, levelNames: Object.keys(levelNames).length ? levelNames : null, settings });
        showNotify('Preset "' + name + '" gespeichert.');
      });
      const delBtn = $('btn-preset-delete');
      if (delBtn) delBtn.addEventListener('click', () => {
        const name = currentPresetName;
        if (!name) { showNotify('Kein Preset ausgewählt.'); return; }
        socket.emit('preset:delete', { name });
        showNotify('Preset "' + name + '" gelöscht.');
      });
      const addBtn = $('btn-field-add');
      if (addBtn) addBtn.addEventListener('click', () => {
        editingFields.push({ type: 'grundstueck', name: 'Neues Feld', price: 100000 });
        renderFieldEditor();
      });
    }

    function numVal(id, dflt) {
      const el = $(id);
      if (!el) return dflt;
      const v = Number(el.value);
      return Number.isFinite(v) ? v : dflt;
    }
    function strVal(id, dflt) {
      const el = $(id);
      if (!el) return dflt;
      const v = (el.value || '').trim();
      return v || dflt;
    }

    // Team-Konfigurationsliste (Schiff + Aufgabe je Team) rendern.
    function renderTeamConfig() {
      const list = $('team-config-list');
      const countEl = $('cfg-teams');
      if (!list || !countEl) return;
      const teams = Math.max(2, Math.min(8, numVal('cfg-teams', 4) || 4));
      countEl.value = teams;
      // Bestehende Eingaben merken, um beim +/- Wechsel nicht zu verlieren.
      const prev = [];
      list.querySelectorAll('.team-config-row').forEach((row) => {
        prev.push({ ship: (row.querySelector('[data-ship]') || {}).value || '', task: (row.querySelector('[data-task]') || {}).value || '' });
      });
      list.innerHTML = '';
      for (let i = 0; i < teams; i++) {
        const got = prev[i] || {};
        const defaultShip = DEFAULT_SHIPS[i % DEFAULT_SHIPS.length];
        const row = document.createElement('div');
        row.className = 'team-config-row';
        const num = document.createElement('span');
        num.className = 'team-config-idx';
        num.textContent = 'Team ' + (i + 1);
        const shipIn = document.createElement('input');
        shipIn.type = 'text'; shipIn.dataset.ship = '1';
        shipIn.placeholder = 'Schiff (z.B. ' + defaultShip + ')';
        shipIn.value = got.ship || defaultShip;
        const taskIn = document.createElement('input');
        taskIn.type = 'text'; taskIn.dataset.task = '1';
        taskIn.placeholder = SHIP_DEFAULT_TASKS[defaultShip] || 'Aufgabe eingeben';
        taskIn.value = got.task || SHIP_DEFAULT_TASKS[got.ship] || SHIP_DEFAULT_TASKS[defaultShip] || '';
        shipIn.addEventListener('input', () => {
          // Bei neu gewähltem Schiff dessen Standard-Aufgabe setzen, falls noch leer.
          if (!taskIn.value.trim()) taskIn.value = SHIP_DEFAULT_TASKS[shipIn.value.trim()] || '';
        });
        row.appendChild(num); row.appendChild(shipIn); row.appendChild(taskIn);
        list.appendChild(row);
      }
    }

    function collectConfig() {
      const teams = Math.max(2, Math.min(8, numVal('cfg-teams', 4) || 4));
      const ships = [];
      const tasks = [];
      const list = $('team-config-list');
      if (list) {
        list.querySelectorAll('.team-config-row').forEach((row, i) => {
          const ship = ((row.querySelector('[data-ship]') || {}).value || '').trim() || DEFAULT_SHIPS[i % DEFAULT_SHIPS.length];
          const task = ((row.querySelector('[data-task]') || {}).value || '').trim();
          ships.push(ship);
          tasks.push(task);
        });
      }
      // Sicherstellen, dass genug Einträge da sind (z.B. wenn Liste nicht gerendert).
      while (ships.length < teams) { ships.push(DEFAULT_SHIPS[ships.length % DEFAULT_SHIPS.length]); tasks.push(''); }
      const capital = numVal('cfg-capital', 1000000);
      const diceConfig = strVal('cfg-dice', '1w6');
      const preset = strVal('cfg-preset', 'crusader-cluster');
      // Spielregeln-Settings: übernehmen falls von Default abweichend
      readSettingsInputs();
      // Armistice-Wert ausschließlich aus Preset ableiten.
      const armistice = !!currentSettings.armisticeEnabled;
      // Beim Start wird der aktuell im Editor bearbeitete Feldstand verwendet.
      const fields = (editingFields || []).map((f) => {
        const out = { type: f.type || 'los', name: f.name || 'Feld' };
        if (f.type === 'grundstueck') {
          if (typeof f.price === 'number') out.price = f.price;
        } else if (f.type === 'los') {
          if (typeof f.bonus === 'number') out.bonus = f.bonus;
        } else if (f.type === 'ereignis' || f.type === 'gundo' || f.type === 'steuer' || f.type === 'gefangnis') {
          if (typeof f.fee === 'number') out.fee = f.fee;
        }
        // freiparken: kein Wert (neutral)
        return out;
      });
      // Ausbaustufen-Namen: aktuellen Editor-Stand (aus den Inputs) mitsenden,
      // nur nicht-leere Einträge.
      readLevelNameInputs();
      const levelNames = {};
      LEVEL_KEYS.forEach((k) => { if (currentLevelNames[k]) levelNames[k] = currentLevelNames[k]; });
      const settings = settingsPayload();
      return { teams, ships, tasks, capital, diceConfig, preset, armistice, fields,
        levelNames: Object.keys(levelNames).length ? levelNames : null,
        settings };
    }

    // Beim Ändern der Teamanzahl die Konfigurationsliste neu aufbauen.
    const teamsInput = $('cfg-teams');
    if (teamsInput) teamsInput.addEventListener('change', renderTeamConfig);

  function onCreateClick(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const btn = $('btn-create');
    const config = collectConfig();
    console.log('[client.js] gm:create senden', { config });
    socket.emit('gm:create', { config });
    if (btn) btn.disabled = true;
    showNotify('Spiel wird erstellt…');
  }

  socket.on('gameCreated', (data) => {
    console.log('[client.js] gameCreated', data);
    client.gameId = data.gameId;
    client.gmCode = data.gmCode;
    client.isGM = true;
    client.role = 'gm';
    saveGM();

    // GM-Code + Einladungscodes in der LOBBY anzeigen (nur für GM kopierbar)
    const gmBox = $('gm-code-box');
    const invBox = $('invite-code-box');
    if (gmBox) {
      gmBox.innerHTML = '<span class="code-lbl">GM-Code (nur du)</span>' +
        '<div class="code-row"><code class="code-big">' + (data.gmCode || '') + '</code>' +
        '<button type="button" class="btn btn-xs btn-ghost" data-copy="' + (data.gmCode || '') + '">Kopieren</button></div>';
      gmBox.classList.remove('hidden');
    }
    if (invBox) {
      invBox.innerHTML = '<span class="code-lbl">Einladungscodes (je Team, an Spieler geben)</span>';
      const tokens = Array.isArray(data.tokens) ? data.tokens : [];
      tokens.forEach((t) => {
        const code = typeof t === 'string' ? t : (t && (t.code || t.token || t.inviteCode)) || '';
        const label = (t && (t.ship || t.shipName || t.teamName)) || ('Team');
        const row = document.createElement('div');
        row.className = 'code-row';
        const codeEl = document.createElement('code');
        codeEl.className = 'code-big';
        codeEl.textContent = code;
        const nameEl = document.createElement('span');
        nameEl.className = 'code-ship';
        nameEl.textContent = label;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-xs btn-ghost';
        btn.textContent = 'Kopieren';
        btn.addEventListener('click', () => copyText(code, btn));
        row.appendChild(nameEl);
        row.appendChild(codeEl);
        row.appendChild(btn);
        // GM selbst in dieses Team eintreten (mitspielen)
        const joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.className = 'btn btn-xs btn-ghost gm-play';
        joinBtn.textContent = 'Mitspielen';
        joinBtn.title = 'Als GM in dieses Team eintreten (als Mitglied/Teamleiter mitspielen)';
        joinBtn.addEventListener('click', () => {
          client.playerName = 'GM';
          client.gameId = data.gameId;
          client.isGM = true; // bleibt GM
          socket.emit('team:join', { gameId: data.gameId, code, playerName: 'GM' });
          showNotify('Du trittst dem Team bei…');
        });
        row.appendChild(joinBtn);
        invBox.appendChild(row);
      });
      if (!tokens.length) invBox.textContent = 'Keine Einladungscodes erhalten.';
      invBox.classList.remove('hidden');
    }

    // Alle Kopier-Buttons im GM-Code-Box verdrahten (GM-Code + Spiel-ID)
    if (gmBox) {
      gmBox.querySelectorAll('[data-copy]').forEach((cb) => {
        cb.addEventListener('click', () => copyText(cb.getAttribute('data-copy'), cb));
      });
    }
    // Start-Button: Da der Server nach gameCreated keinen state broadcastet,
    // hier direkt sichtbar/unsichtbar setzen (GM: zeigen, sonst verbergen).
    // Beim Fortsetzen eines gespeicherten Spiels heißt er "Fortsetzen".
    const gBtnStart = $('btn-start');
    if (gBtnStart) {
      if (client.isGM) {
        gBtnStart.classList.remove('hidden');
        gBtnStart.textContent = data && data.resumed ? 'Fortsetzen' : 'Spiel starten';
      } else gBtnStart.classList.add('hidden');
    }
    const leaveLobby = $('btn-leave-lobby');
    if (leaveLobby && client.gameId) leaveLobby.classList.remove('hidden');
    showView('lobby');
    showNotify(data && data.resumed ? 'Spiel fortgesetzt — Einladungscodes wieder verfügbar.' : 'Spiel erstellt — Einladungscodes zeigen und an die Spieler verteilen.');
  });

  /* ---------------- Flow 2: Team-Join ---------------- */
  // Einladungscode kann als "gameId-code" oder als reiner Code vorliegen;
  // falls vorhanden, wird zusätzlich #join-gameid respektiert.
  function parseInvite(codeRaw) {
    let gameId = $('join-gameid') ? $('join-gameid').value.trim() : '';
    let code = (codeRaw || '').trim();
    if (!gameId) {
      const m = /^([A-Za-z0-9]+)-([A-Za-z0-9-]+)$/.exec(code);
      if (m) { gameId = m[1]; code = m[2]; }
    }
    return { gameId, code };
  }

  function onJoinClick(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const codeRaw = $('join-code') ? $('join-code').value : '';
    const name = $('join-name') ? $('join-name').value : '';
    if (!codeRaw.trim() || !name.trim()) {
      showNotify('Bitte Einladungscode und Name eingeben.');
      return;
    }
    const { gameId, code } = parseInvite(codeRaw);
    client.playerName = name.trim();
    client.gameId = gameId || null;
    console.log('[client.js] team:join senden', { gameId, code, playerName: name.trim() });
    socket.emit('team:join', { gameId, code, playerName: name.trim() });
  }

  // „Spiel beitreten“ als Modal (statt eigener Standalone-Ansicht). Code + Name;
  // Beobachten geht über die Spiele-Liste (ohne Code) — kein separates Feld mehr.
  function openJoinModal() {
    const doJoin = () => {
      const codeRaw = $('join-code') ? $('join-code').value : '';
      const name = $('join-name') ? $('join-name').value : '';
      if (!codeRaw.trim() || !name.trim()) { showNotify('Bitte Einladungscode und Name eingeben.'); return; }
      const { gameId, code } = parseInvite(codeRaw);
      client.playerName = name.trim();
      client.gameId = gameId || null;
      closeModal({ runCancel: false });
      socket.emit('team:join', { gameId, code, playerName: name.trim() });
    };
    openModal({
      title: 'Spiel beitreten',
      icon: '🎟️',
      body: '<p>Mit dem <strong>Einladungscode</strong> einem Team eines laufenden Spiels beitreten:</p>' +
        '<div class="join-modal-row"><span>Code</span><input id="join-code" type="text" spellcheck="false" placeholder="z. B. CDE-1234" autocomplete="off" /></div>' +
        '<div class="join-modal-row"><span>Name</span><input id="join-name" type="text" maxlength="24" placeholder="Pilot/in" autocomplete="off" /></div>' +
        '<div class="join-modal-hint">Zuschauen (ohne Code) geht über die Spiele-Liste → „Zuschauen“.</div>',
      confirmText: 'Beitreten',
      cancelText: 'Abbrechen',
      confirmClass: 'btn-primary',
      onConfirm: doJoin
    });
  }

  socket.on('joined', (data) => {
    console.log('[client.js] joined', data);
    if (data.teamId != null) client.teamId = data.teamId;
    if (data.playerId != null) client.playerId = data.playerId;
    if (data.role) client.role = data.role;
    if (data.token) client.token = data.token;
    if (data.gameId) client.gameId = data.gameId;
    if (data.playerName) client.playerName = data.playerName;
    saveJoin();
    if (data.started && !data.over) {
      // Bereits laufendes Spiel: direkt zur Spiel-Ansicht (state-Broadcast rendert Panels).
      showView('game');
      showNotify(data && data.rejoined ? 'Wiedereingetreten — Spiel läuft weiter.' : 'Eingetreten — das Spiel läuft bereits.');
      // Der state-Broadcast kann VOR dem joined-Event ankommen (Rejoin-Reihenfolge).
      // Rendere aus dem gecachten Zustand neu, damit teamId gesetzt ist und das
      // Team-Panel nicht fälschlich als „Beobachter" erscheint.
      if (client.lastState && client.lastState.gameId === client.gameId) {
        client.renderGameUI(client.lastState);
      }
    } else {
      showView('lobby');
      showNotify(data && data.rejoined ? 'Wiedereingetreten — Lobby geladen.' : 'Eingetreten — Lobby geladen.');
      // Lobby sofort rendern, damit teamId/role gesetzt sind und Vote-Buttons sichtbar werden.
      // Analog zum Rejoin-Muster im started-Zweig (Zeile ~864-866).
      if (client.lastState && client.lastState.gameId === client.gameId) {
        client.renderLobby(client.lastState);
      }
    }
  });

  /* ---------------- Flow 3: Lobby ---------------- */
  function leaderMap(leaders) {
    // state.leaders sind {playerId, teamId, leaderId} Einträge (ein Eintrag pro Spieler).
    // Der Leiter eines Teams = l.leaderId (der gewählte/gewollte Spieler).
    const map = {};
    if (!leaders) return map;
    if (Array.isArray(leaders)) {
      leaders.forEach((l) => {
        if (l && l.teamId != null) {
          const leaderId = l.leaderId != null ? l.leaderId : l.playerId;
          if (leaderId != null) map[l.teamId] = leaderId;
        }
      });
    } else if (typeof leaders === 'object') {
      Object.keys(leaders).forEach((k) => { map[k] = leaders[k]; });
    }
    return map;
  }

  function renderLobby(st) {
    const list = $('lobby-teams-list');
    const teams = st && Array.isArray(st.teams) ? st.teams : [];
    const leaders = leaderMap(st && st.leaders);
    if (!list) return;
    list.innerHTML = '';
    teams.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'lobby-team';
      const head = document.createElement('div');
      head.className = 'lobby-team-head';
      const ship = t.ship || t.shipName || '';
      const name = t.teamName || (ship ? 'Team ' + ship : 'Team ' + t.id);
      head.textContent = name + ' — ' + ship;
      card.appendChild(head);

      const pWrap = document.createElement('div');
      pWrap.className = 'lobby-team-players';
      const players = Array.isArray(t.players) ? t.players : [];
      const leaderId = leaders[t.id] != null ? leaders[t.id]
        : (leaders[t.teamId] != null ? leaders[t.teamId] : null);
      players.forEach((p) => {
        const pid = p.playerId != null ? p.playerId : p.id;
        const pname = p.name || p.playerName || ('Spieler ' + pid);
        const isLeader = leaderId != null && String(pid) === String(leaderId);
        const row = document.createElement('div');
        row.className = 'lobby-player' + (isLeader ? ' leader' : '');
        // Stimmenzahl für diesen Kandidat (von allen Spielern im Team)
        const voteCount = (t.votes && typeof t.votes === 'object' && t.votes[pid] != null)
          ? t.votes[pid] : 0;
        // Führend? (Kandidat mit den meisten Stimmen im Team)
        let voteCounts = [];
        if (t.votes && typeof t.votes === 'object') {
          voteCounts = Object.values(t.votes);
        }
        const maxVotes = voteCounts.length ? Math.max(...voteCounts) : 0;
        const isLeading = maxVotes > 0 && voteCount === maxVotes;

        const span = document.createElement('span');
        span.textContent = pname + (isLeader ? ' (Leiter)' : '');
        row.appendChild(span);
        // Live-Stimmenzahl als Badge anzeigen
        if (voteCount > 0) {
          const badge = document.createElement('span');
          badge.className = 'lobby-vote-badge';
          badge.textContent = ' (' + voteCount + ' ' + (voteCount === 1 ? 'Stimme' : 'Stimmen') + ')';
          if (isLeading) badge.classList.add('lobby-vote-leading');
          row.appendChild(badge);
        }
        // Vote-Button — nur im EIGENEN Team möglich (server prüft zusätzlich)
        const myTeamId = client.teamId != null ? String(client.teamId) : null;
        const thisTeamId = String(t.teamId != null ? t.teamId : t.id);
        const isMyTeam = myTeamId === thisTeamId;
        if (client.gameId && pid != null && isMyTeam) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = 'Wählen';
          btn.disabled = isLeader; // Leader kann nicht wieder gewählt werden
          btn.addEventListener('click', () => {
            console.log('[client.js] vote:leader senden', { gameId: client.gameId, playerId: pid });
            socket.emit('vote:leader', { gameId: client.gameId, playerId: pid });
          });
          row.appendChild(btn);
        }
        pWrap.appendChild(row);
      });
      if (!players.length) {
        const empty = document.createElement('span');
        empty.textContent = 'Noch keine Spieler.';
        pWrap.appendChild(empty);
      }
      card.appendChild(pWrap);
      list.appendChild(card);
    });
    // Start-Button nur für GM sichtbar (UX; echte Prüfung server-seitig).
    // Die Klasse 'hidden' (display:none !important) toggeln, nicht style.display.
    const btnStart = $('btn-start');
    if (btnStart) {
      if (client.isGM) {
        btnStart.classList.remove('hidden');
      } else {
        btnStart.classList.add('hidden');
      }
    }
  }
  // renderLobby als client-Methode expose (für sofortiges Re-Render nach Join).
  client.renderLobby = renderLobby;

  function onStartClick() {
    if (!client.isGM) { showNotify('Nur der GM kann das Spiel starten.'); return; }
    console.log('[client.js] gm:start senden', { gameId: client.gameId, gmCode: client.gmCode });
    socket.emit('gm:start', { gameId: client.gameId, gmCode: client.gmCode });
  }

  /* ---------------- Flow 4: Spiel ---------------- */
  function myTeamIdx(st) {
    const teams = st && Array.isArray(st.teams) ? st.teams : [];
    for (let i = 0; i < teams.length; i++) {
      const t = teams[i];
      if (client.teamId != null && (t.id == client.teamId || t.teamId == client.teamId)) return i;
    }
    return -1;
  }

  function toBoardData(st) {
    const game = (st && st.game) || {};
    const teams = (st && Array.isArray(st.teams)) ? st.teams : [];
    const players = (game.players || []).map((p, i) => {
      const meta = teams[i] || {};
      const ship = meta.ship || meta.shipName || '';
      return {
        teamName: meta.teamName || (ship ? 'Team ' + ship : 'Team ' + (i + 1)),
        ship,
        pos: p.pos,
        color: meta.color || TEAM_COLORS[i % TEAM_COLORS.length],
        properties: p.properties || {},
      };
    });
    return {
      fields: game.fields || (window.STANTONOPOLY_FIELDS ? window.STANTONOPOLY_FIELDS.slice() : []),
      players,
      activeIdx: game.activeIdx,
      log: (st && st.log) || [],
      armisticeEnabled: !!game.armisticeEnabled,
      levelNames: game.levelNames || null,
      settings: game.settings || null,
      presetName: (st && st.presetName) || ((st && st.game && st.game.name) || 'Eigene Karte')
    };
  }

  // Fallback, falls board.js (window.initBoard/renderBoard) fehlt
  function renderFallbackBoard() {
    const board = $('board');
    if (!board) return;
    const data = window.__boardData || { fields: [], players: [] };
    board.innerHTML = '';
    board.className += ' board-fallback';
    data.fields.forEach((f) => {
      const el = document.createElement('div');
      el.className = 'field-row';
      const id = f.id != null ? f.id : (f.idx != null ? f.idx : f.name || '');
      const label = f.name || f.label || ('Feld ' + id);
      const here = data.players
        .filter((p) => p.pos == id || p.pos === Number(id))
        .map((p) => p.teamName)
        .join(', ');
      el.textContent = '#' + id + ' ' + label + (here ? '  [anwesend: ' + here + ']' : '');
      board.appendChild(el);
    });
  }

  function renderBoardView(st) {
    window.__boardData = toBoardData(st);
    if (typeof window.initBoard === 'function' && !client.boardReady) {
      window.initBoard();
      client.boardReady = true;
    }
    if (typeof window.renderBoard === 'function') {
      window.renderBoard();
    } else {
      console.warn('[client.js] board.js nicht vorhanden → Fallback-Feldliste.');
      renderFallbackBoard();
    }
    // Presetname dynamisch anzeigen (Banner unter dem Logo + Header-Subtext).
    const pn = (st && st.presetName) || 'Eigene Karte';
    const sub = document.querySelector('#view-game .board-flex-head .bc-sub');
    if (sub) sub.textContent = pn;
    const hsub = document.querySelector('.header-sub');
    if (hsub) hsub.textContent = pn + ' · AAWA-Event';
    renderCashflow(st);
    renderEconBar(st);
    renderTradePanel(st);
  }

  // ------------- Cashflow-Verlauf des eigenen Teams -------------
  function renderCashflow(st) {
    const box = $('cashflow');
    if (!box) return;
    const idx = myTeamIdx(st);
    const p = (st.game && st.game.players) ? st.game.players[idx] : null;
    // Cashflow ist IMMER sichtbar (auch ohne Buchungen → Platzhalter), damit
    // sich das Layout nicht verschiebt. Nur außerhalb eines aktiven Spiels verstecken.
    if (idx < 0 || !p || !st.started || st.over) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const ledger = Array.isArray(p.ledger) ? p.ledger : [];
    if (!ledger.length) {
      box.innerHTML = '<div class="cashflow-head">💰 Cashflow (letzte Buchungen)</div>' +
        '<div class="cf-empty">Noch keine Buchungen — hier erscheint dein Geld-Ein- und -Ausgang.</div>';
      return;
    }
    const rows = ledger.slice(-12).reverse().map((e) => {
      const amt = Number(e.amount != null ? e.amount : e.delta) || 0;
      const sign = amt >= 0 ? 'pos' : 'neg';
      return '<div class="cf-row ' + sign + '"><span class="cf-amt">' + (amt >= 0 ? '+' : '−') + fmtUAEC(Math.abs(amt)) + '</span>' +
        '<span class="cf-txt">' + esc(e.why || '') + '</span></div>';
    }).join('');
    box.innerHTML = '<div class="cashflow-head">💰 Cashflow (letzte Buchungen)</div>' + rows;
  }

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // ------------- Economy-Aktionen (Hypothek / Abbau / Verkauf / Versteigern / Aufgeben) -------------
  function renderEconBar(st) {
    const bar = $('econ-bar');
    if (!bar) return;
    const idx = myTeamIdx(st);
    bar.innerHTML = '';
    if (idx < 0 || !st.started || st.over) { return; }
    if (client.role !== 'gm' && client.role !== 'leader') {
      bar.innerHTML = '<div class="econ-hint">Wirtschaft-Aktionen kann nur der Teamleiter auslösen.</div>';
      return;
    }
    const p = (st.game && st.game.players) ? st.game.players[idx] : {};
    const props = p.properties || {};
    const data = window.__boardData || {};
    const fields = Array.isArray(data.fields) ? data.fields : [];
    const otherTeams = (st.game && Array.isArray(st.game.players) ? st.game.players : []).map((pl, pi) => ({ pi, pl }))
      .filter((o) => o.pi !== idx && !o.pl.bankrupt);
    const teamOpts = otherTeams.map((o) => '<option value="' + o.pi + '">' + (o.pl.name || ('Team ' + (o.pi + 1))) + '</option>').join('');

    const ownFields = fields.map((f, i) => ({ i, f, own: props[i] })).filter((o) => o.own);
    const ownOpts = ownFields.map((o) => '<option value="' + o.i + '">' + (o.f.name || ('Feld ' + o.i)) +
      ' (' + o.own.level + (o.own.mortgaged ? ', beliehen' : '') + ')</option>').join('');
    // Fremde (besessene) Felder für ein Kaufangebot an den jeweiligen Besitzer
    const foreignFields = fields.map((f, i) => ({ i, f, owner: ownerOfIdx(st, i) }))
      .filter((o) => o.owner != null && o.owner !== idx && o.f.type !== 'ereignis' && o.f.type !== 'gundo' && o.f.type !== 'gefangnis' && o.f.type !== 'freiparken' && o.f.type !== 'steuer' && o.f.type !== 'los');

    let html = '';
    // Eigene Felder: Hypothek / Entlasten / Ausbau / Abbau / Aufgeben / An Bank verkaufen
    if (p.insolvent) html += '<div class="econ-warn">⚠️ Zahlungsrückstand! Saniere oder dein Team scheidet beim nächsten Zug aus.</div>';
    html += '<div class="econ-row"><span>Mein Feld</span><select id="econ-field">' +
      (ownOpts || '<option value="-1">— keins —</option>') + '</select></div>';
    html += '<div class="econ-row" id="econ-btnrow"></div>';
    if (ownFields.length && otherTeams.length) {
      html += '<div class="econ-row"><span>Verkauf anbieten an</span><select id="econ-buyer">' + teamOpts + '</select>' +
        '<input id="econ-price" type="number" min="1" step="1000" placeholder="Preis" style="width:84px" />' +
        '<button type="button" class="btn btn-xs" id="econ-sell">↔ Angebot</button></div>';
    }
    if (ownFields.length) {
      html += '<div class="econ-row"><button type="button" class="btn btn-xs" id="econ-auction">🔨 Meine Versteigerung</button></div>';
    }
    // Fremde Felder: EIN Dropdown mit allen fremden Grundstücken + Betrag + Angebot
    // (statt einer Zeile pro Feld, damit lange Karten/Teams übersichtlich bleiben).
    const buyableFields = foreignFields.filter((o) => o.owner != null);
    if (buyableFields.length && otherTeams.length) {
      const buyOpts = buyableFields.map((o) => {
        const ownerName = (st.game.players[o.owner] && st.game.players[o.owner].name) || ('Team ' + (o.owner + 1));
        const lvl = (props[o.i] && props[o.i].level) || (o.owner != null && st.game.players[o.owner].properties && st.game.players[o.owner].properties[o.i] ? st.game.players[o.owner].properties[o.i].level : '');
        return '<option value="' + o.i + '">' + (o.f.name || ('Feld ' + o.i)) + ' (' + ownerName + (lvl ? ' · ' + lvl : '') + ')</option>';
      }).join('');
      html += '<div class="econ-row"><span>Kauf anbieten</span>' +
        '<select id="econ-buyfield">' + buyOpts + '</select>' +
        '<input id="econ-buyprice" type="number" min="1" step="1000" placeholder="Betrag" style="width:84px" />' +
        '<button type="button" class="btn btn-xs" id="econ-buyoffer">🛒 Angebot</button></div>';
    }
    bar.innerHTML = html;
    wireEconBtns(st);
  }

  function ownerOfIdx(st, fieldIdx) {
    const players = (st.game && Array.isArray(st.game.players)) ? st.game.players : [];
    for (let i = 0; i < players.length; i++) if (players[i].properties && players[i].properties[fieldIdx]) return i;
    return null;
  }

  function ownerSet(st, fieldIdx) {
    return (st.game && Array.isArray(st.game.players) ? st.game.players : []).some((pl) => pl.properties && pl.properties[fieldIdx]);
  }

  // ------------- Angebote & Versteigerung (eingehend) -------------
  function renderTradePanel(st) {
    const panel = $('trade-panel');
    if (!panel) return;
    const idx = myTeamIdx(st);
    const offers = Array.isArray(st.game && st.game.offers) ? st.game.offers : [];
    const auction = (st.game && st.game.auction) || null;
    // Trade-Panel ist IMMER sichtbar (im aktiven Spiel), auch ohne Angelegenheiten
    // → Platzhalter, damit sich das Layout nicht verschiebt.
    if (idx < 0 || !st.started || st.over) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    // Nur Angebote, die MEIN Team betreffen (targetIdx===idx oder fromIdx===idx)
    const mine = offers.filter((o) => o.targetIdx === idx || o.fromIdx === idx);
    let html = '';
    // Eingehende Angebote (angedeutet sind mich zur Entscheidung)
    const inbound = mine.filter((o) => o.targetIdx === idx);
    if (inbound.length) {
      html += '<div class="trade-head">📩 Angebote an dich</div>';
      inbound.forEach((o) => {
        const f = st.game.fields[o.fieldIdx];
        const verb = o.kind === 'buy' ? ('will dein Feld kaufen') : ('bietet dir seinen Kauf an');
        html += '<div class="trade-row">' +
          '<span>' + (o.fromName || '?') + ' ' + verb + ': <strong>' + (f && f.name) + '</strong> · ' + fmtUAEC(o.price) + '</span>' +
          '<div>' +
          '<button type="button" class="btn btn-xs btn-ok" data-offer="' + o.id + '" data-accept="1">Annehmen</button> ' +
          '<button type="button" class="btn btn-xs btn-danger" data-offer="' + o.id + '" data-accept="0">Ablehnen</button>' +
          '</div></div>';
      });
    }
    // Eigene, noch offene Angebote (können zurückgezogen? → einfach warten)
    const outbound = mine.filter((o) => o.fromIdx === idx && o.targetIdx !== idx);
    if (outbound.length) {
      html += '<div class="trade-head">⏳ Wartet auf Antwort</div>';
      outbound.forEach((o) => {
        const f = st.game.fields[o.fieldIdx];
        html += '<div class="trade-row"><span>→ ' + (o.targetName || '?') + ' · ' + (f && f.name) + ' · ' + fmtUAEC(o.price) + '</span></div>';
      });
    }
    // Laufende Versteigerung
    if (auction) {
      const f = st.game.fields[auction.fieldIdx];
      const remaining = Math.max(0, auction.endsAt - Date.now());
      const isOwner = auction.ownerIdx === idx;
      const myHighest = auction.highest && auction.highest.playerIdx === idx;
      html += '<div class="trade-head">🔨 Auktion: <strong>' + (f && f.name) + '</strong></div>';
      html += '<div class="trade-row"><span>Höchstgebot: ' + (auction.highest ? (st.game.players[auction.highest.playerIdx].name + ' · ' + fmtUAEC(auction.highest.amount)) : '—') + ' · Rest: ' + Math.round(remaining / 1000) + 's</span></div>';
      if (isOwner) {
        html += '<div class="trade-row">' +
          '<button type="button" class="btn btn-xs btn-ok" id="au-me-accept">Vorzeitig akzeptieren</button> ' +
          '<button type="button" class="btn btn-xs btn-danger" id="au-me-abort">Abbrechen</button></div>';
      } else if (client.role === 'leader' || client.role === 'gm') {
        html += '<div class="trade-row"><input id="au-bid-amt" type="number" min="1" step="1000" placeholder="Gebot" style="width:90px" /> ' +
          '<button type="button" class="btn btn-xs" id="au-bid">Bieten</button></div>';
      }
    }
    if (!html) {
      html = '<div class="trade-head">🤝 Handel &amp; Versteigerung</div>' +
        '<div class="trade-empty">Keine offenen Angebote oder Versteigerungen aktuell.</div>';
    }
    panel.innerHTML = html;
    if (html) panel.classList.remove('hidden');

    // Event-Bindung
    panel.querySelectorAll('[data-offer]').forEach((b) => {
      b.addEventListener('click', () => socket.emit('trade:respond', { gameId: client.gameId, offerId: b.getAttribute('data-offer'), accept: b.getAttribute('data-accept') }));
    });
    const ab = $('au-bid');
    if (ab) ab.addEventListener('click', () => {
      const amt = $('au-bid-amt'); const v = amt ? Number(amt.value) : 0;
      if (!(v > 0)) { showNotify('Gebot eingeben.'); return; }
      socket.emit('auction:bid', { gameId: client.gameId, amount: v });
    });
    const acc = $('au-me-accept');
    if (acc) acc.addEventListener('click', () => socket.emit('auction:resolve', { gameId: client.gameId, accept: 1 }));
    const abort = $('au-me-abort');
    if (abort) abort.addEventListener('click', () => socket.emit('auction:resolve', { gameId: client.gameId, accept: 0 }));
  }

  function wireEconBtns(st) {
      // Level-/Kosten-Konstanten (Spiegel von server/engine/data.js; der Server
      // bleibt autoritativ, hier nur für Anzeige in den Massen-Modals).
      var ECON_LEVELS = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA', 'ARMISTICE'];
      var ECON_NAMES_DEFAULT = { ALLEIN: 'Standard', CYCLONE: 'Cyclone', STORM: 'Storm', BALLISTA: 'Ballista', ARMISTICE: 'Armistice Zone' };
      // Live-Level-Namen aus dem Spielzustand (per Preset anpassbar).
      var ECON_NAMES = Object.assign({}, ECON_NAMES_DEFAULT, (st.game && st.game.levelNames) || {});
      var ECON_SETTINGS = (st.game && st.game.settings && typeof st.game.settings === 'object') ? st.game.settings : {};
      var BUILD_MULT = Object.assign({ CYCLONE: 0.25, STORM: 0.50, BALLISTA: 1.00, ARMISTICE: 1.50 }, ECON_SETTINGS.buildMult || {});
      var RENT_MULT_SHOW = Object.assign({ ALLEIN: 0.10, CYCLONE: 0.50, STORM: 1.00, BALLISTA: 2.00, ARMISTICE: 3.00 }, ECON_SETTINGS.rentMult || {});
      var MORTGAGE_SHOW = (typeof ECON_SETTINGS.mortgageMult === 'number') ? ECON_SETTINGS.mortgageMult : 0.75;
      var UNMORTGAGE_SHOW = (typeof ECON_SETTINGS.unmortgageRate === 'number') ? ECON_SETTINGS.unmortgageRate : 1.10;
      var BANK_SHOW = (typeof ECON_SETTINGS.bankPayout === 'number') ? ECON_SETTINGS.bankPayout : 0.75;
      var DEMOLISH_REFUND_SHOW = (typeof ECON_SETTINGS.demolishRefundRate === 'number') ? ECON_SETTINGS.demolishRefundRate : 0.50;
      function econName(l) { return ECON_NAMES[l] || l; }

      const btn = (id) => document.getElementById(id);
      const fieldIdx = () => { const s = btn('econ-field'); return s ? Number(s.value) : -1; };
      const myIdx = myTeamIdx(st);
      const player = (st.game && Array.isArray(st.game.players)) ? st.game.players[myIdx] : null;
      const props = (player && player.properties) ? player.properties : {};
      const data = window.__boardData || {};
      const flds = Array.isArray(data.fields) ? data.fields : [];

      function ownProp(fidx) {
        const o = props[fidx];
        return (o && typeof o === 'object') ? o : (o != null ? { level: o } : null);
      }

      // Verfügbarkeitsbasierte Buttons für das gewählte Feld + Info-Modals.
      function renderBtnRow() {
        const row = btn('econ-btnrow');
        if (!row) return;
        const fidx = fieldIdx();
        const own = ownProp(fidx);
        const f = flds[fidx];
        const price = (f && typeof f.price === 'number') ? f.price : 0;
        const curIdx = own ? ECON_LEVELS.indexOf(own.level) : -1;
        const mortgaged = !!(own && own.mortgaged);
        const buttons = [];

        if (own && !mortgaged) {
          // Hypothek nur, wenn NICHT schon beliehen. Info + Bestätigung.
          const loan = Math.round(price * MORTGAGE_SHOW);
          buttons.push({ id: 'econ-mortgage', label: '🔒 Hypothek', cls: 'btn-xs', act: () => {
            openModal({
              title: 'Hypothek aufnehmen',
              icon: '🔒',
              body: '<p>Feld <strong>' + esc(f ? f.name : ('Feld ' + fidx)) + '</strong> (' + esc(econName(own.level)) + ')</p>' +
                '<ul><li>Du erhältst: <strong>' + fmtUAEC(loan) + '</strong> uAEC</li>' +
                '<li>Pfand: Feld erzielt keine Miete mehr (bis Entlastung)</li>' +
                '<li>Entlastung kostet später: <strong>' + fmtUAEC(Math.round(loan * UNMORTGAGE_SHOW)) + '</strong> (Darlehen + Zins)</li></ul>',
              confirmText: 'Hypothek aufnehmen',
              cancelText: 'Abbrechen',
              onConfirm: () => socket.emit('action:mortgage', { gameId: client.gameId, field: fidx })
            });
          } });
        }
        if (own && mortgaged) {
          // Entlasten nur, wenn schon beliehen. Info + Bestätigung.
          const loan = own.mortgagedValue || Math.round(price * MORTGAGE_SHOW);
          const pay = Math.round(loan * UNMORTGAGE_SHOW);
          buttons.push({ id: 'econ-remortgage', label: '🔓 Entlasten', cls: 'btn-xs', act: () => {
            openModal({
              title: 'Hypothek entlasten',
              icon: '🔓',
              body: '<p>Feld <strong>' + esc(f ? f.name : ('Feld ' + fidx)) + '</strong></p>' +
                '<ul><li>Rückzahlung (Darlehen + Zins): <strong>' + fmtUAEC(pay) + '</strong> uAEC</li>' +
                '<li>Danach kassiert das Feld wieder Miete.</li></ul>',
              confirmText: 'Entlasten (' + fmtUAEC(pay) + ')',
              cancelText: 'Abbrechen',
              onConfirm: () => socket.emit('action:unmortgage', { gameId: client.gameId, field: fidx })
            });
          } });
        }
        if (own && !mortgaged && curIdx >= 0 && curIdx < ECON_LEVELS.length - 1) {
          // Ausbauen (nächste Stufe zeigen). ARMISTICE nur, wenn aktiviert (Server prüft zusätzlich).
          const nextLvl = ECON_LEVELS[curIdx + 1];
          const armOn = !!(st.game && st.game.armisticeEnabled);
          if (nextLvl !== 'ARMISTICE' || armOn) {
            const buildCost = Math.round(price * (BUILD_MULT[nextLvl] || 0));
            buttons.push({ id: 'econ-build', label: '🔨 Ausbauen → ' + econName(nextLvl), cls: 'btn-xs', act: () => {
              openModal({
                title: 'Ausbau auf ' + econName(nextLvl),
                icon: '🔨',
                body: '<p>Feld <strong>' + esc(f ? f.name : ('Feld ' + fidx)) + '</strong> (' + esc(econName(own.level)) + ' → <strong>' + esc(econName(nextLvl)) + '</strong>)</p>' +
                  '<ul><li>Baukosten: <strong>' + fmtUAEC(buildCost) + '</strong> uAEC</li>' +
                  '<li>Neue Miete für Gegner: <strong>' + fmtUAEC(rentForClient(price, nextLvl)) + '</strong> uAEC</li></ul>',
                confirmText: 'Ausbauen (' + fmtUAEC(buildCost) + ')',
                cancelText: 'Abbrechen',
                onConfirm: () => socket.emit('action:build', { gameId: client.gameId, field: fidx })
              });
            } });
          }
        }
        if (own && !mortgaged && curIdx > 0) {
          // Abbau (eine Stufe zurück, demolishRefundRate der Baukosten zurück)
          const curLvl = ECON_LEVELS[curIdx];
          const cost = Math.round(price * (BUILD_MULT[curLvl] || 0));
          const refund = Math.round(cost * DEMOLISH_REFUND_SHOW);
          buttons.push({ id: 'econ-demolish', label: '− Abbau (' + econName(curLvl) + ')', cls: 'btn-xs', act: () => {
            openModal({
              title: 'Abbau: ' + econName(curLvl),
              icon: '−',
              body: '<p>Feld <strong>' + esc(f ? f.name : ('Feld ' + fidx)) + '</strong> zurück auf <strong>' + esc(econName(ECON_LEVELS[curIdx - 1])) + '</strong></p>' +
                '<ul><li>Rückerstattung: <strong>' + fmtUAEC(refund) + '</strong> uAEC</li></ul>',
              confirmText: 'Abbauen (+' + fmtUAEC(refund) + ')',
              cancelText: 'Abbrechen',
              onConfirm: () => socket.emit('action:demolish', { gameId: client.gameId, field: fidx })
            });
          } });
        }
        if (own) {
          // An die Bank verkaufen (Sanierung): bankPayout des Basiswerts.
          const amt = Math.round(price * BANK_SHOW);
          const bankSellOk = (typeof ECON_SETTINGS.bankSellEnabled !== 'boolean') || ECON_SETTINGS.bankSellEnabled === true;
          if (bankSellOk) {
            buttons.push({ id: 'econ-banksell', label: '🏦 An Bank', cls: 'btn-xs btn-danger', act: () => {
              openModal({
                title: 'Feld an die Bank verkaufen',
                icon: '🏦',
                body: '<p>Feld <strong>' + esc(f ? f.name : ('Feld ' + fidx)) + '</strong> (' + esc(econName(own.level)) + ')</p>' +
                  '<ul><li>Erlös: <strong>' + fmtUAEC(amt) + '</strong> uAEC</li>' +
                  '<li>Dauerhaft — nicht umkehrbar. Aktion nur ausführen, wenn nötig.</li></ul>',
                confirmText: 'Verkaufen (+' + fmtUAEC(amt) + ')',
                cancelText: 'Abbrechen',
                onConfirm: () => socket.emit('action:sell', { gameId: client.gameId, field: fidx, buyerIdx: -1 })
              });
            } });
          }
        }
        if (own) {
          buttons.push({ id: 'econ-auction-me', label: '🔨 Versteigern', cls: 'btn-xs', act: () => {
            openModal({
              title: 'Feld versteigern',
              icon: '🔨',
              body: '<p>Feld <strong>' + esc(f ? f.name : ('Feld ' + fidx)) + '</strong> an alle Teams versteigern? (<strong>' + fmtUAEC(price) + '</strong> Basis)</p>' +
                '<ul><li>Max. 15 Sekunden, Höchstgebot gewinnt.</li><li>Du kannst vorzeitig akzeptieren/abbrechen.</li></ul>',
              confirmText: 'Auktion starten',
              cancelText: 'Abbrechen',
              onConfirm: () => socket.emit('auction:start', { gameId: client.gameId, field: fidx })
            });
          } });
        }
        // Aufgeben ist in die Action-Bar verschoben worden (hier entfernt).

        row.innerHTML = buttons.map((b) => '<button type="button" class="btn ' + b.cls + '" id="' + b.id + '">' + b.label + '</button>').join('') ||
          '<div class="econ-hint">— wähle ein eigenes Feld —</div>';
        buttons.forEach((b) => { const el = btn(b.id); if (el) el.addEventListener('click', b.act); });
      }

      function rentForClient(price, level) {
        const mult = RENT_MULT_SHOW[level];
        return Math.round(price * (mult != null ? mult : 0));
      }

      // Bei Feldwechsel die Buttons aktualisieren.
      const sel = btn('econ-field');
      if (sel) {
        sel.addEventListener('change', renderBtnRow);
      }
      renderBtnRow();

      const sell = btn('econ-sell');
      if (sell) sell.addEventListener('click', () => {
        const b = btn('econ-buyer'); const pr = btn('econ-price');
        const buyerIdx = b ? Number(b.value) : -1;
        const price = pr ? Number(pr.value) : 0;
        if (!(price > 0)) { showNotify('Bitte einen Preis angeben.'); return; }
        socket.emit('trade:make', { gameId: client.gameId, kind: 'sell', field: fieldIdx(), targetIdx: buyerIdx, price });
      });
      // Kaufangebot: ein Dropdown mit allen fremden Feldern + Betrag
      const buyOffer = btn('econ-buyoffer');
      if (buyOffer) buyOffer.addEventListener('click', () => {
        const selF = btn('econ-buyfield'); const pr = btn('econ-buyprice');
        const fidx = selF ? Number(selF.value) : -1;
        const price = pr ? Number(pr.value) : 0;
        const owner = ownerOfIdx(st, fidx);
        if (!(price > 0)) { showNotify('Betrag angeben.'); return; }
        socket.emit('trade:make', { gameId: client.gameId, kind: 'buy', field: fidx, targetIdx: owner, price });
      });
    }

  function renderPlayerPanel(st) {
    const panel = $('player-panel');
    if (!panel) return;
    const game = st.game || {};
    const idx = myTeamIdx(st);
    const teams = Array.isArray(st.teams) ? st.teams : [];
    if (idx < 0) {
      panel.innerHTML = '<div>Beobachter: keine eigene Mannschaft.</div>';
      return;
    }
    const meta = teams[idx] || {};
    const p = (game.players || [])[idx] || {};
    const ship = meta.ship || meta.shipName || '';
    const budget = p.budget != null ? p.budget : (p.capital != null ? p.capital : p.money != null ? p.money : '—');
    const lines = [
      meta.teamName || ('Team ' + (idx + 1)),
      'Schiff: ' + ship,
      'Rolle: ' + (client.role || '—'),
      'Budget: ' + budget,
      'Position: ' + (p.pos != null ? p.pos : '—'),
      (p.jailed ? '⛓ IM GEFÄNGNIS (überspringt ' + (p.jailTurns || 0) + ' Zug/Züge)' : ''),
    ].filter((l) => l !== '');
    let leaderUI = '';
    // Nur der aktuelle Teamleiter kann die Rolle (ohne Vote) an ein anderes
    // Teammitglied abtreten. Mitglieder/Beobachter sehen nur einen Hinweis.
    // (Ein mitspielender GM ist normaler Spieler seines Teams — darf genauso.)
    if (!isSpectator() && client.teamId != null) {
      const myPlayers = (meta.players || []).filter((pl) => {
        const pid = pl.playerId != null ? pl.playerId : pl.id;
        return client.playerId != null && String(pid) !== String(client.playerId);
      });
      if (client.role === 'leader') {
        if (myPlayers.length) {
          leaderUI = '<div class="leader-switch"><span>Rolle abgeben an:</span>' +
            '<select id="leader-candidate">' +
            myPlayers.map((pl) => {
              const pid = pl.playerId != null ? pl.playerId : pl.id;
              return '<option value="' + pid + '">' + (pl.name || 'Spieler') + '</option>';
            }).join('') +
            '</select>' +
            '<button type="button" class="btn btn-xs btn-ghost" id="leader-change-btn">Rolle übertragen</button></div>';
        } else {
          leaderUI = '<div class="leader-hint">Du bist Teamleiter. Die Rolle kannst du an ein weiteres Teammitglied abgeben.</div>';
        }
      } else {
        leaderUI = '<div class="leader-hint">Du bist Mitglied — nur der Teamleiter kann handeln und die Rolle abgeben.</div>';
      }
    }
    panel.innerHTML = lines.map((l) => '<div>' + l + '</div>').join('') + leaderUI;

    const lb = $('leader-change-btn');
    if (lb) lb.addEventListener('click', () => {
      const sel = $('leader-candidate');
      const pid = sel && sel.value;
      if (!pid) { showNotify('Bitte ein Teammitglied als neuen Leiter auswählen.'); return; }
      console.log('[client.js] action:transferLeader senden', { gameId: client.gameId, playerId: pid });
      socket.emit('action:transferLeader', { gameId: client.gameId, playerId: pid });
    });
  }

  const ACTION_BTN = {};
  function actionBtn(id, label, handler) {
    let b = ACTION_BTN[id];
    if (!b) {
      const bar = $('action-bar');
      if (!bar) return null;
      b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      // Styling: .btn Basis + .btn-primary für den Haupt-Button (Würfeln), Rest .btn
      b.className = id === 'btn-roll' ? 'btn btn-primary' : 'btn';
      bar.appendChild(b);
      ACTION_BTN[id] = b;
    }
    b.textContent = label;
    // Handler per addEventListener einmalig binden (Duplikat-Schutz über data-wired).
    if (handler && b.getAttribute('data-wired') !== '1') {
      b.addEventListener('click', handler);
      b.setAttribute('data-wired', '1');
    }
    return b;
  }
  function setBtn(id, show, enabled) {
    const b = ACTION_BTN[id];
    if (!b) return;
    b.style.display = show ? '' : 'none';
    b.disabled = !enabled;
  }

  function renderActionBar(st) {
    const bar = $('action-bar');
    const allIds = ['btn-roll', 'btn-buy', 'btn-skip', 'btn-task', 'btn-next', 'btn-start-game', 'btn-options'];
    // existierende Action-Buttons vorab verdrahten (nur einmal)
    ['btn-roll','btn-buy','btn-skip','btn-task','btn-next'].forEach((id) => {
      const map = { 'btn-roll': 'Würfeln', 'btn-buy': 'Kaufen', 'btn-skip': 'Überspringen', 'btn-task': 'Aufgabe erledigt', 'btn-next': 'Nächster Zug' };
      actionBtn(id, map[id], { 'btn-roll': onRollClick, 'btn-buy': onBuyClick, 'btn-skip': onSkipClick, 'btn-task': onTaskClick, 'btn-next': onNextClick }[id]);
    });
    if (!st.started || st.over) {
      allIds.forEach((id) => setBtn(id, false, false));
      // Start-Button im Spiel-View für GM, wenn nicht gestartet
      const startBtn = actionBtn('btn-start-game', 'Start', () => {
        console.log('[client.js] gm:start senden (aus Action-Bar)', { gameId: client.gameId, gmCode: client.gmCode });
        socket.emit('gm:start', { gameId: client.gameId, gmCode: client.gmCode });
      });
      if (startBtn) {
        startBtn.style.display = client.isGM && !st.started ? '' : 'none';
        startBtn.disabled = !(client.isGM && !st.started);
      }
      return;
    }
    const game = st.game || {};
    const idx = myTeamIdx(st);
    const myTurn = idx >= 0 && game.activeIdx === idx;
    const isLeaderOfActive = myTurn && canAct() && !isSpectator();
    const rolled = game.rolled === true;
    const canBuy = game.canBuy === true;

    // Nur für den Teamleiter des aktiven Teams sind Aktions-Buttons sichtbar.
    // Alle anderen (Mitglieder, Beobachter, andere Teams) sehen keine Aktions-Buttons.
    const showActions = isLeaderOfActive;

    setBtn('btn-roll', showActions && !rolled && !canBuy, showActions && !rolled && !canBuy);
    setBtn('btn-buy', showActions && canBuy, showActions && canBuy);
    setBtn('btn-skip', showActions && canBuy, showActions && canBuy);
    setBtn('btn-task', showActions, showActions);
    // "Nächster Zug": ausgegraut, solange das aktive Team in Zahlungsrückstand ist
    // (insolvent) — es muss zuerst sanieren, sonst scheidet es am Zugende aus.
    const activeP = game.players && game.players[idx];
    const insolventBlock = showActions && activeP && activeP.insolvent;
    setBtn('btn-next', showActions && !insolventBlock, showActions && rolled && !insolventBlock);

    // Optionen (jede Rolle im aktiven Spiel): öffnet das rollenabhängige Modale
    // mit "Spiel verlassen" + (Teammitglied) Aufgeben-Abstimmung bzw. (GM) Pausieren.
    const inGame = !!st.started && !st.over;
    const optsBtn = actionBtn('btn-options', '⚙ Optionen', onOptionsClick);
    if (optsBtn) {
      optsBtn.style.display = inGame ? '' : 'none';
      optsBtn.disabled = !inGame;
    }
  }

  function onOptionsClick() {
    const isTeam = client.role === 'leader' || client.role === 'member';
    const items = [];
    if (isTeam) {
      items.push('<div class="opt-row" data-opt="forfeitPoll">🚩 <strong>Team-Aufgabe abstimmen</strong> — startet eine 15-Sek.-Abstimmung aller Teammitglieder (Starter stimmt automatisch dafür, Enthaltung zählt nicht).</div>');
    }
    items.push('<div class="opt-row" data-opt="leave">↩ Spiel verlassen — dein Slot wird freigegeben, du kannst jederzeit mit dem Einladungscode zurückkehren.</div>');
    if (client.isGM) {
      items.push('<div class="opt-row" data-opt="pause">⏸ Spiel pausieren — unterbricht das Spiel; alle Teilnehmer sehen die Pausemeldung.</div>');
      // GM-only: Teamleiter ändern
      const st2 = client.lastState;
      const teams2 = st2 && Array.isArray(st2.teams) ? st2.teams : [];
      if (teams2.length > 1) {
        const teamOpts = teams2.map((t) => {
          const tid = t.teamId != null ? t.teamId : t.id;
          const tname = t.teamName || (t.ship || '') || ('Team ' + tid);
          return '<option value="' + tid + '">' + tname + '</option>';
        }).join('');
        items.push('<div class="opt-row" data-opt="setleader">⚔ Teamleiter ändern — wähle Team und Mitglied, um den Leiter zu wechseln.</div>');
        items.push('<div class="leader-change-form" data-opt="setleader" style="padding:8px;margin-top:4px">' +
          '<select id="lc-team" style="width:100%;margin-bottom:6px">' + teamOpts + '</select>' +
          '<select id="lc-player" style="width:100%;margin-bottom:6px"><option value="">— Team wählen —</option></select>' +
          '<button type="button" class="btn btn-xs btn-primary" id="lc-confirm">Bestätigen</button>' +
          '</div>');
      }
    }
    openModal({
      title: 'Optionen',
      icon: '⚙',
      body: '<div class="opt-list">' + items.join('') + '</div>',
      confirmText: null,
      cancelText: 'Schließen',
      onOpen: () => {
        const wrap = $('stp-modal');
        if (!wrap) return;
        wrap.querySelectorAll('[data-opt]').forEach((row) => {
          const o = row.getAttribute('data-opt');
          if (o === 'leave') { closeModal({ runCancel: false }); onLeaveClick(); }
          else if (o === 'pause') { closeModal({ runCancel: false }); onPauseClick(); }
          else if (o === 'forfeitPoll') { closeModal({ runCancel: false }); onStartForfeitPoll(); }
          else if (o === 'setleader') {
            // Teamleiter-Formular: Team-Auswahl → Spieler-Ausfüllen + Bestätigen
            const form = row;
            const teamSel = $('lc-team');
            const playerSel = $('lc-player');
            const confirmBtn = $('lc-confirm');
            // Spieler-Options beim Teamwechsel aufbauen
            if (teamSel) teamSel.addEventListener('change', () => {
              if (!playerSel || !confirmBtn) return;
              const chosenTeamId = teamSel.value;
              const st3 = client.lastState;
              const teams3 = st3 && Array.isArray(st3.teams) ? st3.teams : [];
              const chosenTeam = teams3.find((t) => String(t.teamId != null ? t.teamId : t.id) === chosenTeamId);
              const players3 = (chosenTeam && Array.isArray(chosenTeam.players)) ? chosenTeam.players : [];
              playerSel.innerHTML = '<option value="">— Mitglied wählen —</option>' +
                players3.map((p) => {
                  const pid = p.playerId != null ? p.playerId : p.id;
                  const pname = p.name || p.playerName || 'Spieler';
                  return '<option value="' + pid + '">' + pname + '</option>';
                }).join('');
              confirmBtn.disabled = true;
            });
            if (playerSel) playerSel.addEventListener('change', () => {
              if (confirmBtn) confirmBtn.disabled = !playerSel.value;
            });
            if (confirmBtn) confirmBtn.addEventListener('click', () => {
              const tid = teamSel ? teamSel.value : '';
              const pid = playerSel ? playerSel.value : '';
              if (!tid || !pid) { showNotify('Bitte Team und Mitglied wählen.'); return; }
              socket.emit('gm:setleader', { gameId: client.gameId, gmCode: client.gmCode, teamId: tid, playerId: pid });
              closeModal({ runCancel: false });
            });
          }
        });
      }
    });
  }

  function onPauseClick() {
    if (!client.isGM) return;
    socket.emit('gm:pause', { gameId: client.gameId, gmCode: client.gmCode });
    showNotify('Spiel wird pausiert…');
  }

  function onStartForfeitPoll() {
    socket.emit('action:forfeit', { gameId: client.gameId });
    showNotify('Abstimmung gestartet — Team aufgeben? (15 s)');
  }

  function onLeaveClick() {
    openModal({
      title: 'Spiel verlassen',
      icon: '↩',
      body: '<p>Spiel wirklich verlassen? Dein Slot wird freigegeben, du kannst jederzeit mit dem Einladungscode zurückkehren.</p>',
      confirmText: 'Verlassen',
      cancelText: 'Abbrechen',
      onConfirm: () => { leaveNow(); }
    });
  }

  function onRollClick() {
    console.log('[client.js] action:roll senden', { gameId: client.gameId });
    socket.emit('action:roll', { gameId: client.gameId });
  }
  function onBuyClick() {
    console.log('[client.js] action:buy senden', { gameId: client.gameId });
    socket.emit('action:buy', { gameId: client.gameId });
  }
  function onSkipClick() {
    console.log('[client.js] action:skip senden', { gameId: client.gameId });
    socket.emit('action:skip', { gameId: client.gameId });
  }
  function onTaskClick() {
    console.log('[client.js] task:complete senden', { gameId: client.gameId });
    socket.emit('task:complete', { gameId: client.gameId });
  }
  function onBuildClick() {
    // Ausbau läuft über die Econ-Bar (eigenes Feld-Dropdown).
    const sel = $('econ-field');
    const field = sel && sel.value !== '' && Number(sel.value) >= 0 ? sel.value : null;
    if (field == null) { showNotify('Bitte zuerst dein Feld in der Wirtschaftsleiste wählen.'); return; }
    console.log('[client.js] action:build senden', { gameId: client.gameId, field });
    socket.emit('action:build', { gameId: client.gameId, field });
  }
  function onNextClick() {
    console.log('[client.js] action:nextTurn senden', { gameId: client.gameId });
    socket.emit('action:nextTurn', { gameId: client.gameId });
  }

  function renderLog(log) {
    const el = $('log');
    if (!el) return;
    el.innerHTML = '';
    (log || []).forEach((entry) => {
      const line = document.createElement('div');
      line.textContent = typeof entry === 'string' ? entry : JSON.stringify(entry);
      el.appendChild(line);
    });
    el.scrollTop = el.scrollHeight;
  }

  /* ---------------- Flow 6: Beobachter ---------------- */
  // Zuschauen läuft über die Spiele-Liste (→ „Zuschauen“) ohne Code — die frühere
  // separate Spectate-Eingabe in der Join-Ansicht wurde dafür entfernt (Sebo-Wunsch).

  /* ---------------- State-Handler (Server → Client) ---------------- */
  socket.on('state', (st) => {
    console.log('[client.js] state', st && st.gameId, st && st.started, st && st.over);
    client.lastState = st;
    if (st && st.gameId) client.gameId = st.gameId;

    // Rollen-Update: wenn ich zum Teamleiter gewählt wurde
    const leaders = leaderMap(st && st.leaders);
    const myIdx = myTeamIdx(st);
    if (myIdx >= 0) {
      const leaderId = leaders[st.teams[myIdx].id] != null ? leaders[st.teams[myIdx].id]
        : leaders[st.teams[myIdx].teamId];
      if (leaderId != null && client.playerId != null && String(leaderId) === String(client.playerId)) {
        client.role = 'leader';
      } else if (client.role === 'leader' && leaderId != null && String(leaderId) !== String(client.playerId)) {
        client.role = 'member';
      }
    }

    if (st.over) {
      client.renderGameUI(st);
      const winner = st.winnerInfo ? (st.winnerInfo.name || st.winnerInfo.teamName || st.winnerInfo) : '';
      showNotify('Spiel beendet. Gewinner: ' + winner);
      return;
    }
    if (st.started) {
      client.renderGameUI(st);
    } else {
      showView('lobby');
      renderLobby(st);
      renderLog(st.log);
    }
  });

  // Spielansicht einmal rendern (Brett, Players, Aktionen, Log).
  // Wird bei jedem state und nach joined/rejoin aufgerufen (teamId ist dann gesetzt,
  // damit das Team-Panel nicht fälschlich als „Beobachter" erscheint).
  client.renderGameUI = (st) => {
    showView('game');
    renderBoardView(st);
    renderPlayerPanel(st);
    renderActionBar(st);
    renderLog(st.log);
    maybeShowJailChoice(st);
    maybeShowInsolvencyWarning(st);
    renderPauseBanner(st);
    renderForfeitPollUI(st);
  };

  // Pausierung: Wenn der GM das Spiel pausiert hat, verdecken → ein Banner mit
  // [Spiel verlassen] und deaktivierte Aktionen. Fortgesetzt → Banner entfernt.
  function renderPauseBanner(st) {
    let banner = $('pause-banner');
    if (st && st.paused) {
      if (!client.__leftToSetup) {
        client.__leftToSetup = false;
      }
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'pause-banner';
        banner.className = 'pause-banner';
        document.body.appendChild(banner);
      }
      // GM-Code prominent anzeigen (nur für GM sichtbar)
      let gmCodeHtml = '';
      if (client.isGM && client.gmCode) {
        gmCodeHtml = '<div class="pause-gm-code">GM-Code für Fortsetzen: <strong>' + client.gmCode + '</strong>' +
          '<button type="button" class="btn btn-xs btn-ghost" data-copy="' + client.gmCode + '">Kopieren</button></div>';
      }
      banner.innerHTML = '<div class="pause-inner">' +
        '<div class="pause-title">⏸ Spiel pausiert</div>' +
        '<div class="pause-text">Der Gamemaster hat das Spiel pausiert. Aktionen sind deaktiviert — du kannst das Spiel verlassen und später mit deinem Einladungscode zurückkehren.</div>' +
        gmCodeHtml +
        '<button type="button" class="btn btn-xs" id="pause-leave">↩ Spiel verlassen</button>' +
        '</div>';
      // Kopier-Button für GM-Code
      if (client.isGM) {
        const copyBtn = banner.querySelector('[data-copy]');
        if (copyBtn) copyBtn.addEventListener('click', () => copyText(copyBtn.getAttribute('data-copy'), copyBtn));
      }
      const lb = banner.querySelector('#pause-leave');
      if (lb) lb.addEventListener('click', () => { client.__leftToSetup = true; leaveNow(); });
      // Alle Action-Buttons deaktivieren
      const bar = $('action-bar');
      if (bar) Array.from(bar.querySelectorAll('button')).forEach((b) => { b.disabled = true; });
      const econ = $('econ-bar');
      if (econ) Array.from(econ.querySelectorAll('button')).forEach((b) => { b.disabled = true; });
    } else if (banner) {
      banner.remove();
    }
  }

  // Aufgeben-Abstimmung: zeigt das laufende Poll-Modal für die eigenen Teammitglieder.
  let pollUIKey = '';
  function renderForfeitPollUI(st) {
    const poll = st.game && st.game.forfeitPoll;
    const myIdx = myTeamIdx(st);
    const myTeamId = (st.game && myIdx >= 0 && st.game.players && st.game.players[myIdx]) ? st.game.players[myIdx].id : null;
    if (!poll || myTeamId == null || poll.teamId !== myTeamId) {
      pollUIKey = '';
      return;
    }
    // Nur für Teammitglied (Leader oder Member) ohne sich wiederholendes Modal.
    if (!(client.role === 'leader' || client.role === 'member')) return;
    const key = poll.started + ':' + (poll.startedBy || '');
    if (pollUIKey === key) return;
    pollUIKey = key;
    openModal({
      title: '🚩 Team-Aufgabe — Abstimmung',
      icon: '🗳️',
      body: '<p><strong>' + esc(poll.startedName || 'Ein Mitglied') + '</strong> schlägt vor, euer Team aufzugeben. ' +
        '<strong>15 s</strong> — wer nicht abstimmt, enthält sich (zählt nicht).</p>' +
        '<div class="poll-rows" style="margin-top:6px">' +
        '<button type="button" class="btn btn-xs btn-danger" id="poll-yes">🗳️ JA — aufgeben</button>' +
        '<button type="button" class="btn btn-xs btn-ok" id="poll-no">🗳️ NEIN — weiterspielen</button>' +
        '</div>',
      confirmText: null,
      cancelText: 'Enthalten',
      onOpen: () => {
        const yes = $('poll-yes'); const no = $('poll-no');
        if (yes) yes.addEventListener('click', () => { closeModal({ runCancel: false }); socket.emit('forfeit:vote', { gameId: client.gameId, agree: 1 }); });
        if (no) no.addEventListener('click', () => { closeModal({ runCancel: false }); socket.emit('forfeit:vote', { gameId: client.gameId, agree: -1 }); });
      }
    });
  }

  // Bankrott-Warnung: Einmal pro Rückstand ein markantes Modal zeigen, wenn das
  // eigene Team in Zahlungsrückstand ist (droht auszuscheiden). Der Leader muss
  // sanieren (Abbau/Hypothek/Bankverkauf) oder sein Team gibt auf.
  let seenInsolvencyWarn = '';
  function maybeShowInsolvencyWarning(st) {
    if (client.role !== 'leader') return;
    if ($('stp-modal')) return; // kein zweites Modal über ein anderes legen
    const idx = myTeamIdx(st);
    if (idx < 0) return;
    const p = (st.game && st.game.players && st.game.players[idx]) || null;
    if (!p || !p.insolvent) { seenInsolvencyWarn = ''; return; }
    const key = String(idx) + ':' + Math.round(Number(p.budget || 0));
    if (seenInsolvencyWarn === key) return;
    seenInsolvencyWarn = key;
    openModal({
      title: '🚨 BANKROTT droht',
      icon: '⚠️',
      body: '<p>Dein Team <strong>' + esc(p.name || 'Team') + '</strong> ist in Zahlungsrückstand (Konto: <strong>' + fmtUAEC(p.budget) + '</strong> uAEC).</p>' +
        '<ul><li>Baue Stufen ab, nimm eine Hypothek auf oder verkaufe Grundstücke an die Bank, um das Konto auszugleichen.</li>' +
        '<li>Der <strong>„Nächster Zug“</strong>-Button ist gesperrt, bis du saniert hast.</li>' +
        '<li>Schaffst du es nicht, scheidet dein Team am Zugende automatisch aus.</li></ul>',
      confirmText: 'Verstanden',
      cancelText: null,
      onConfirm: () => { /* nur schließen */ }
    });
  }

  // Gefängnis-Wahl: Wenn der aktive Leader auf einem Gefängnis-Feld mit Lösegeld
  // gelandet ist (jailBail gesetzt), ein Modal mit [Freikaufen][Absitzen] zeigen.
  // Nur für den betroffenen Leader und nur einmal pro Landung.
  let seenJailOffer = '';
  function maybeShowJailChoice(st) {
    if (!$('stp-modal')) {
      seenJailOffer = ''; // Modal geschlossen → künftige Choice wieder zulassen
    }
    if (client.role !== 'leader') return;
    const game = st.game || {};
    const p = (game.players && game.players[game.activeIdx]) || null;
    if (!p || !p.jailed || !(p.jailBail != null && p.jailBail > 0)) return;
    const key = String(p.id) + ':' + p.pos;
    if (seenJailOffer === key) return;
    seenJailOffer = key;
    const bail = p.jailBail;
    openModal({
      title: '🕳️ Du sitzt im Gefängnis',
      icon: '⛓',
      body: '<p>Feld <strong>' + esc((game.fields && game.fields[p.pos] && game.fields[p.pos].name) || ('Feld ' + p.pos)) + '</strong></p>' +
        '<ul><li>Lösegeld: <strong>' + fmtUAEC(bail) + '</strong> uAEC</li>' +
        '<li>Freikaufen = sofort weiter; sonst überspringst du die nächsten ' + Math.max(1, p.jailTurns || 1) + ' Zug/Züge.</li></ul>',
      confirmText: 'Freikaufen (' + fmtUAEC(bail) + ')',
      cancelText: 'Absitzen (' + Math.max(1, p.jailTurns || 1) + ' Zug)',
      confirmClass: 'btn-ok',
      onConfirm: () => socket.emit('action:bail', { gameId: client.gameId }),
      onCancel: () => socket.emit('action:jailstay', { gameId: client.gameId })
    });
  }

  /* ---------------- Fehler-Handler (Server → Client) ---------------- */
  socket.on('error', (err) => {
    console.error('[client.js] error vom Server', err && (err.code || '') , err && (err.message || err.error || ''));
    const msg = (err && (err.message || err.error)) || 'Unbekannter Fehler (' + ((err && err.code) || '') + ')';
    showNotify(msg);
    if (window.__notifyEl) window.__notifyEl.classList.add('is-error');
  });

  /* ---------------- Event-Bindings ---------------- */
  const btnCreate = $('btn-create');
  if (btnCreate) btnCreate.addEventListener('click', onCreateClick);
  const btnStart = $('btn-start');
  if (btnStart) btnStart.addEventListener('click', onStartClick);
  // Enter-Taste in Formularen soll nicht neu laden (Ohne Submit-Navigation).
  const createForm = $('gm-create-form');
  if (createForm) createForm.addEventListener('submit', (e) => e.preventDefault());

  // Action-Bar-Buttons (werden beim ersten state mit started=true erzeugt)
  actionBtn('btn-roll', 'Würfeln', onRollClick);
  actionBtn('btn-buy', 'Kaufen', onBuyClick);
  actionBtn('btn-skip', 'Überspringen', onSkipClick);
  actionBtn('btn-task', 'Aufgabe erledigt', onTaskClick);
  actionBtn('btn-next', 'Nächster Zug', onNextClick);

  // Team-Konfigurationsliste initial rendern.
  renderTeamConfig();

  // Preset-Editor initialisieren.
  initPresetEditor();

  // Automatischer Rejoin: gespeicherten Join-Stand wiederherstellen.
  const saved = loadJoin();
  if (saved && saved.token && saved.gameId) {
    client.gameId = saved.gameId;
    client.token = saved.token;
    client.playerName = saved.name || '';
    console.log('[client.js] auto-rejoin versuchen', saved.gameId);
    socket.emit('team:rejoin', { gameId: saved.gameId, token: saved.token });
  }
  // Automatischer GM-Reconnect: gespeicherten GM-Stand wiederherstellen.
  const savedGM = loadGM();
  if (savedGM && savedGM.gameId && savedGM.gmCode) {
    client.gameId = savedGM.gameId;
    client.gmCode = savedGM.gmCode;
    client.isGM = true;
    client.role = 'gm';
    console.log('[client.js] auto-gm-resume versuchen', savedGM.gameId);
    socket.emit('gm:resume', { gameId: savedGM.gameId, gmCode: savedGM.gmCode });
  }

  // Start-View: die Spiele-Liste ist die Landing-Page (nicht „Spiel erstellen“).
  showGamesView();

  // Dreh-Hinweis: dauerhaft ausblenden, wenn der Nutzer "Trotzdem zeigen" wählt.
  const rotateSkip = $('rotate-skip');
  if (rotateSkip) rotateSkip.addEventListener('click', () => {
    try { localStorage.setItem('stantonopoly.rotate.skip', '1'); } catch (e) {}
    const ov = $('rotate-overlay'); if (ov) ov.style.display = 'none';
  });
  (function initRotateOverlay() {
    let skipped = false;
    try { skipped = localStorage.getItem('stantonopoly.rotate.skip') === '1'; } catch (e) {}
    if (skipped) { const ov = $('rotate-overlay'); if (ov) ov.style.display = 'none'; }
  })();

  /* ---------------- Spiel fortgesetzt (GM) ---------------- */
  // "Spiel verlassen" aus der Lobby (GM verwirft/verlässt das Lobby-Spiel).
  const leaveLobbyBtn = $('btn-leave-lobby');
  if (leaveLobbyBtn) leaveLobbyBtn.addEventListener('click', () => {
    if (!client.gameId) { showView('setup'); return; }
    socket.emit('game:leave', { gameId: client.gameId });
    clearIdentityLocal();
    showView('setup');
  });

  function clearIdentityLocal() {
    try { localStorage.removeItem(LS_KEY); localStorage.removeItem(GM_KEY); } catch (e) {}
    client.gameId = null; client.teamId = null; client.playerId = null;
    client.token = null; client.gmCode = null; client.isGM = false; client.role = null;
  }
  function leaveNow() {
    // Pause-Banner explizit entfernen, damit er nach dem Verlassen nicht mehr sichtbar bleibt.
    const pb = $('pause-banner');
    if (pb) pb.remove();
    socket.emit('game:leave', { gameId: client.gameId });
    clearIdentityLocal();
    showView('setup');
    showNotify('Spiel verlassen — du kannst jederzeit mit dem Einladungscode zurückkehren.');
  }

  /* ---------------- Spiele-Übersicht (aktiv/beendet, Zuschauen, Resultat) ---- */
  let currentGamesTab = 'active';
  let gamesCache = [];

  function showGamesView() {
    showView('games');
    socket.emit('lobby:list');
  }

  function renderGamesList(tab) {
    currentGamesTab = tab || currentGamesTab;
    const list = $('games-list');
    const resBox = $('game-result');
    if (resBox) resBox.classList.add('hidden'); resBox.innerHTML = '';
    if (!list) return;
    const active = gamesCache.filter((g) => !g.over && !g.paused);
    const paused = gamesCache.filter((g) => !g.over && g.paused);
    const done = gamesCache.filter((g) => g.over);
    const mapTab = { active, paused, done }[currentGamesTab] || active;
    const data = mapTab;
    const labels = { active: 'aktiven', paused: 'pausierten', done: 'abgeschlossenen' }[currentGamesTab] || 'aktiven';
    list.innerHTML = '';
    if (!data.length) {
      list.innerHTML = '<div class="games-empty">Keine ' + labels + ' Spiele.</div>';
      return;
    }
    data.forEach((g) => {
      const card = document.createElement('div');
      card.className = 'game-card';
      const head = document.createElement('div');
      head.className = 'game-card-head';
      head.innerHTML = '<strong>' + (g.name || 'Ohne Namen') + ' <span class="game-id">#' + (g.gameId || '') + '</span></strong>' +
        '<span class="game-status ' + (g.paused ? 'paused' : (g.started ? 'started' : 'lobby')) + '">' +
        (g.over ? 'beendet' : (g.paused ? '⏸ pausiert' : (g.started ? 'läuft' : 'in Lobby'))) + '</span>';
      card.appendChild(head);
      const teams = (g.teams || []).map((t) => t.ship || t.teamId || '').filter(Boolean);
      if (teams.length) {
        const shipLine = document.createElement('div');
        shipLine.className = 'game-card-teams';
        shipLine.textContent = 'Teams: ' + teams.join(' · ');
        card.appendChild(shipLine);
      }
      const actions = document.createElement('div');
      actions.className = 'game-card-actions';
      if (g.paused) {
        // Pausiert: Fortsetzen (GM-Code nötig) oder Zuschauen
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.className = 'btn btn-xs btn-primary';
        resume.textContent = '▶ Fortsetzen (GM)';
        resume.addEventListener('click', () => openGMResumeModal(g));
        actions.appendChild(resume);
        const watch = document.createElement('button');
        watch.type = 'button';
        watch.className = 'btn btn-xs btn-ghost';
        watch.textContent = 'Zuschauen';
        watch.addEventListener('click', () => {
          client.isGM = false; client.role = 'spectator'; client.teamId = null;
          client.gameId = g.gameId;
          socket.emit('lobby:spectate', { gameId: g.gameId });
          showView('lobby');
          showNotify('Pausiertes Spiel — du schaust zu (nur lesen).');
        });
        actions.appendChild(watch);
      } else {
        // Zuschauen (aktiv oder beendet) ohne Code — nur Lesen
        const watch = document.createElement('button');
        watch.type = 'button';
        watch.className = 'btn btn-xs btn-ghost';
        watch.textContent = g.over ? 'Resultat' : 'Zuschauen';
        watch.addEventListener('click', () => {
          if (g.over) {
            socket.emit('lobby:result', { gameId: g.gameId });
          } else {
            client.isGM = false; client.role = 'spectator'; client.teamId = null;
            client.gameId = g.gameId;
            socket.emit('lobby:spectate', { gameId: g.gameId });
            showView('lobby');
            showNotify('Du schaust zu (nur lesen).');
          }
        });
        actions.appendChild(watch);
      }
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  // GM gibt seinen GM-Code ein, um ein pausiertes Spiel fortzusetzen.
  function openGMResumeModal(game) {
    openModal({
      title: 'Pausiertes Spiel fortsetzen · ' + (game?.name || ''),
      icon: '▶',
      body: '<p>Gib den <strong>GM-Code</strong> ein, um das Spiel freizuschalten. Danach erhältst du die Einladungscodes erneut und wirst in die Lobby geleitet.</p>',
      confirmText: 'Fortsetzen',
      cancelText: 'Abbrechen',
      confirmClass: 'btn-ok',
      onConfirm: () => {
        const inp = $('gm-resume-code');
        const code = inp ? inp.value.trim() : '';
        if (!code) { showNotify('GM-Code eingeben.'); return; }
        client.gmCode = code.toUpperCase();
        client.isGM = true; client.role = 'gm';
        socket.emit('gm:resumegame', { gameId: game.gameId, gmCode: client.gmCode });
        showNotify('Spiel wird fortgesetzt…');
      },
      onOpen: () => {
        const body = $('stp-modal');
        if (body) {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.id = 'gm-resume-code';
          inp.className = 'gm-resume-input';
          inp.placeholder = 'GM-Code';
          body.querySelector('.modal-body').appendChild(inp);
        }
      }
    });
  }

  socket.on('lobby:games', (data) => {
    gamesCache = (data && Array.isArray(data.games)) ? data.games : [];
    renderGamesList(currentGamesTab);
  });

  socket.on('lobby:result', (r) => {
    const resBox = $('game-result');
    const list = $('games-list');
    if (!resBox) return;
    if (list) list.innerHTML = '';
    resBox.classList.remove('hidden');
    const rows = (r && r.players) ? r.players.slice().sort((a, b) => (b.winner ? 1 : 0) - (a.winner ? 1 : 0)) : [];
    const winnerLine = r && r.winner ? '<div class="result-winner">🏆 Sieger: <strong>' + (r.winner.name || '?') + '</strong></div>' : '';
    resBox.innerHTML = '<div class="result-title">Endresultat: ' + (r && r.name || '') + '</div>' + winnerLine +
      '<table class="result-table"><thead><tr><th>Team</th><th>Budget</th><th>Liegenschaften</th><th>Status</th></tr></thead><tbody>' +
      rows.map((p) => '<tr>' +
        '<td>' + (p.winner ? '👑 ' : '') + (p.name || '') + (p.ship ? ' <small>(' + p.ship + ')</small>' : '') + '</td>' +
        '<td>' + fmtUAEC(p.budget) + '</td>' +
        '<td>' + fmtUAEC(p.fieldValue) + '</td>' +
        '<td>' + (p.bankrupt ? 'bankrott' : (p.winner ? 'Sieger' : 'aktiv')) + '</td></tr>').join('') +
        '</tbody></table>' +
        '<button type="button" id="result-back" class="btn btn-xs btn-ghost" style="margin-top:8px">Zurück zur Liste</button>';
    const back = $('result-back');
    if (back) back.addEventListener('click', () => { resBox.classList.add('hidden'); renderGamesList(currentGamesTab); });
  });

  // Tabs
  const tabA = $('games-tab-active');
  const tabP = $('games-tab-paused');
  const tabD = $('games-tab-done');
  if (tabA) tabA.addEventListener('click', () => renderGamesList('active'));
  if (tabP) tabP.addEventListener('click', () => renderGamesList('paused'));
  if (tabD) tabD.addEventListener('click', () => renderGamesList('done'));
  const navGames = $('nav-games');
  if (navGames) navGames.addEventListener('click', showGamesView);

  function fmtUAEC(n) {
    const v = Math.round(Number(n) || 0); const neg = v < 0;
    let s = String(Math.abs(v)); let o = '';
    while (s.length > 3) { o = '.' + s.slice(-3) + o; s = s.slice(0, -3); }
    return (neg ? '-' : '') + s + o;
  }

  console.log('[client.js] client.js initialisiert.');
})();
