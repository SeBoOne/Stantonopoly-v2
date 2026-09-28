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
        // Kopfzeile: Icon (falls vorhanden) inline VOR dem Titel in einer flex row.
        // ✕-Schließen oben rechts NIE rendern — modal-btns enthält immer einen
        // Abbrechen/Schließen-Button (sonst doppeltes Schließen — 2i #1).
        const hasBtnClose = true;
        if (opts.title || opts.icon) {
          const head = document.createElement('div');
          head.className = 'modal-head';
          if (opts.icon) {
            const ic = document.createElement('div');
            ic.className = 'modal-icon';
            ic.innerHTML = opts.icon;
            head.appendChild(ic);
          }
          if (opts.title) {
            const h = document.createElement('div');
            h.className = 'modal-title';
            h.innerHTML = esc(opts.title);
            head.appendChild(h);
          }
          if (!hasBtnClose) {
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'modal-close';
            x.textContent = '✕';
            x.addEventListener('click', () => closeModal({ runCancel: true }));
            head.appendChild(x);
          }
          panel.appendChild(head);
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
    gmName: null,      // GM-Anzeigename (aus dem Erstellen-Formular / State)
    lastState: null,   // letzter empfangener state
    boardReady: false,
    palette: 'cargo',   // aktive Farbpalette
  };

  /* ---------------- Paletten-Switcher (F-Schale: cargo/ion/uplink) ---------------- */
  const PALETTES = ['cargo', 'ion', 'uplink'];
  const PALETTE_NAMES = { cargo: 'Cargo', ion: 'Ion', uplink: 'Uplink' };
  function applyPalette(name) {
    client.palette = name;
    document.documentElement.setAttribute('data-palette', name);
    try { localStorage.setItem('stantonopoly.palette', name); } catch(e) {}
    // Switcher-Buttons aktualisieren
    document.querySelectorAll('.palette-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-palette') === name);
    });
  }
  function initPaletteSwitcher() {
    const wrap = $('palette-switcher');
    if (!wrap) return;
    // Gespeicherte Palette laden
    let saved = 'cargo';
    try { saved = localStorage.getItem('stantonopoly.palette') || 'cargo'; } catch(e) {}
    if (!PALETTES.includes(saved)) saved = 'cargo';
    applyPalette(saved);
    // Dropdown (2i #6): kompakte Auswahl statt dauerhaft sichtbarer Buttons
    const sel = $('palette-select');
    if (!sel) return;
    PALETTES.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = PALETTE_NAMES[p] || p;
      sel.appendChild(opt);
    });
    sel.value = saved;
    sel.addEventListener('change', () => applyPalette(sel.value));
  }

  /* ---------------- Join-Stand in localStorage ---------------- */
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
    // Body-Klasse für View-Bindung von fixierten Elementen
    document.body.classList.remove('view-game');
    document.body.classList.remove('view-games');
    document.body.classList.remove('view-setup');
    document.body.classList.remove('view-lobby');
    if (name && VIEWS.indexOf(name) !== -1) {
      document.body.classList.add('view-' + name);
    }
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
    // Landing-Hero-Buttons (Sichtcheck-Block 2 #9): „＋ Spiel erstellen“ → Setup,
    // „🎟 Mit Code beitreten“ → Join-Modal.
    const navSetup2 = $('nav-setup2');
    const navJoin2 = $('nav-join2');
    if (navSetup2) navSetup2.addEventListener('click', () => showView('setup'));
    if (navJoin2) navJoin2.addEventListener('click', () => openJoinModal());

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
    // (P4) Manager-Status: null solange nicht als Manager authentifiziert.
    // Der Server erzwingt permanent-Speichern nur mit gültigem Manager-Code (socket.data.managerName).
    let managerName = null;
    function isManager() { return !!managerName; }
    // (2j #2) Nach Speichern einzuwerfendes Preset im cfg-preset-Dropdown (vor Server-Ack gesetzt).
    let pendingSelectPreset = null;
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
          armisticeEnabled: false,
          // (2k #5 → 2m #13) Monopoly-Bauregel in zwei unabhängige Regeln.
          buildGroupOwnership: true,
          buildGroupEven: true,
          // (2h#5/#6) Spielablauf: Würfelmodus (nur 1W6/2W6) + Zug-Timer (s, 0 = aus).
          // Diese Werte sind Game-Pace-Einstellungen und werden beim Start als
          // diceConfig/turnSeconds an den Server übergeben (nicht als Preset-Regel).
          diceConfig: '1w6',
                    turnSeconds: 0
                  };
    let currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS_CLIENT));

    // (2m #13) Bis jetzt Gleichmäßig-Regel nur in Verbindung mit Besitz-Regel:
    // Deaktivieren/ausgrauen des Even-Toggles, wenn Ownership aus ist.
    function syncEvenToggle() {
      const owned = $('s-build-group-owned');
      const even = $('s-build-group-even');
      if (!owned || !even) return;
      even.disabled = !owned.checked;
      if (!owned.checked) even.checked = false;
    }
    // Bei Electron/UI → Eventlistener werden unten (EDGE) verdrahtet; hier nur Helfer-Exposition.
    function bindMonopolyToggles() {
      const owned = $('s-build-group-owned');
      const even = $('s-build-group-even');
      if (owned) owned.addEventListener('change', syncEvenToggle);
      if (even) even.addEventListener('change', () => { if (!$( 's-build-group-owned') || !$('s-build-group-owned').checked) even.checked = false; });
    }

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
            // (2m #13) Monopoly-Bauregel-Toggles (Besitz + Gleichmäßig)
            { const el = $('s-build-group-owned'); if (el) el.checked = !!currentSettings.buildGroupOwnership; }
            { const el = $('s-build-group-even'); if (el) el.checked = !!(currentSettings.buildGroupEven && currentSettings.buildGroupOwnership); syncEvenToggle(); }
            // (2h#5/#6) Spielablauf: Würfelmodus + Zug-Timer
            { const el = $('s-dice'); if (el) el.value = currentSettings.diceConfig || '1w6'; }
            { const el = $('s-turnsecs'); if (el) el.value = String(Math.max(0, Math.round(Number(currentSettings.turnSeconds) || 0))); }
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
            // (2m #13) Monopoly-Bauregel-Toggles lesen (Besitz + Gleichmäßig)
            { const mr = $('s-build-group-owned'); if (mr) currentSettings.buildGroupOwnership = !!mr.checked; }
            { const er = $('s-build-group-even'); if (er && currentSettings.buildGroupOwnership) currentSettings.buildGroupEven = !!er.checked; }
            // (2h#5/#6) Spielablauf: Würfelmodus (nur 1W6/2W6) + Zug-Timer (s)
            { const de = $('s-dice'); if (de && (de.value === '1w6' || de.value === '2w6')) currentSettings.diceConfig = de.value; }
            { const te = $('s-turnsecs'); if (te) currentSettings.turnSeconds = Math.max(0, Math.round(Number(te.value) || 0)); }
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
      if (cur.monopolyBuildRule !== base.monopolyBuildRule) { out.buildGroupOwnership = cur.monopolyBuildRule; out.buildGroupEven = cur.monopolyBuildRule; }
      if (cur.buildGroupOwnership !== base.buildGroupOwnership) out.buildGroupOwnership = cur.buildGroupOwnership;
      if (cur.buildGroupEven !== base.buildGroupEven) out.buildGroupEven = cur.buildGroupEven;
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
        row.className = 'preset-field-row' + ((f.type === 'los' || f.type === 'ereignis' || f.type === 'gundo' || f.type === 'gefangnis' || f.type === 'steuer') ? ' has-extra' : '') + (f.type === 'freiparken' ? ' is-plain' : '');
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
        typeSel.addEventListener('change', () => {
          f.type = typeSel.value;
          // (2k #5) Nicht-kaufbare Felder gehören keiner Farbgruppe an.
          if (f.type !== 'grundstueck') delete f.group;
          renderFieldEditor();
        });
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
        // (2k #5) Farbgruppen-Auswahl NUR für Grundstücke. Nicht-kaufbare Felder
        // (Los/Ereignis/Gefängnis/Steuer/Frei Parken) haben KEINE Gruppe.
        let groupSel = null;
        if (f.type === 'grundstueck') {
          // (2o-B P1) Sichtbarer Farb-Swatch NEBEN dem Dropdown. Die geschlossene
          // <select>-Box rendert option-Hintergrund in Chromium NICHT (nur das
          // geöffnete Popup) — deshalb zeigt ein fixierter Span aus STAN_COLORS[].hex
          // die gewählte Farbe dauerhaft sichtbar im Editor-Grid.
          groupSel = document.createElement('div');
          groupSel.className = 'preset-group-pick';
          const swatch = document.createElement('span');
          swatch.className = 'preset-group-swatch';
          groupSel.appendChild(swatch);
          const sel = document.createElement('select');
          sel.title = 'Farbgruppe (Monopoly-Bauregel: nur gleichfarbig ausbaubar)';
          const noneOpt = document.createElement('option');
          noneOpt.value = ''; noneOpt.textContent = '–';
          sel.appendChild(noneOpt);
          // (2m #3) 10 benannte Farbgruppen. Nicht-kaufbare Felder haben keine Gruppe.
          const COLORS = (window.STAN_COLORS || []);
          const currentGroupKey = window.stanGroupKey ? window.stanGroupKey(f.group) : (f.group || '');
          COLORS.forEach((c) => {
            const oo = document.createElement('option');
            oo.value = c.key; oo.textContent = (c.label || c.key);
            if (c.hex) oo.className = 'preset-group-opt';
            if (String(f.group) === c.key || (currentGroupKey && String(currentGroupKey) === c.key)) oo.selected = true;
            sel.appendChild(oo);
          });
          const syncSwatch = () => {
            const ck = window.stanGroupKey ? window.stanGroupKey(sel.value) : (sel.value || '');
            const c = COLORS.find((x) => x.key === ck);
            swatch.style.background = (c && c.hex) ? c.hex : 'transparent';
            swatch.title = c ? (c.label || c.key) : 'keine Farbgruppe';
          };
          syncSwatch();
          sel.addEventListener('change', () => { f.group = sel.value; syncSwatch(); });
          groupSel.appendChild(sel);
        }
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
        if (groupSel) row.appendChild(groupSel);
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
      if (typeof src.monopolyBuildRule === 'boolean') { s.buildGroupOwnership = src.monopolyBuildRule; s.buildGroupEven = src.monopolyBuildRule; }
      if (typeof src.buildGroupOwnership === 'boolean') s.buildGroupOwnership = src.buildGroupOwnership;
      if (typeof src.buildGroupEven === 'boolean') s.buildGroupEven = src.buildGroupEven; // (2m #13)
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
        // (2j #2) Nach erfolgreichem Speichern: Editor schließen + neues Preset auswählen.
        if (pendingSelectPreset) {
          const name = pendingSelectPreset; pendingSelectPreset = null;
          const m = $('preset-modal'); if (m) m.classList.add('hidden');
          const sel = $('cfg-preset');
          if (sel && name) sel.value = name;
          const saved = presetList.find((p) => p.name === name);
          if (saved && Array.isArray(saved.fields) && saved.fields.length) {
            currentPresetName = name; editorSetName(name);
            editingFields = saved.fields.map((f) => ({ ...f }));
            currentLevelNames = Object.assign({}, DEFAULT_LEVEL_NAMES, saved.levelNames || {});
            applyPresetSettings(saved);
            renderFieldEditor(); syncLevelNameInputs(); syncSettingsInputs();
            showNotify('Preset "' + name + '" gespeichert und ausgewählt.');
          }
          return;
        }
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
      // (P4) Manager-Modus: ohne Manager-Code sind Save/New/Delete im Standardmodus
      // ausgeblendet (nur temporäre Bearbeitung für das aktuelle Spiel möglich).
      function renderManagerMode() {
        const mgr = isManager();
        ['btn-preset-save', 'btn-preset-delete', 'btn-preset-new'].forEach((id) => {
          const b = $(id); if (b) b.classList.toggle('hidden', !mgr);
        });
        // QA-Fix: Nach erfolgreicher Auth wird die Code-Eingabe ausgeblendet und
        // durch einen Abmelden-Button ersetzt (der Code-Fokus hätte keinen Sinn mehr).
        const inputRow = $('mgr-input-row');
        if (inputRow) inputRow.classList.toggle('hidden', mgr);
        const logoutBtn = $('btn-mgr-logout');
        if (logoutBtn) logoutBtn.classList.toggle('hidden', !mgr);
        const st = $('mgr-status');
        if (st) st.textContent = mgr ? ('Aktiv: ' + managerName) : 'Standardmodus — Änderungen gelten nur für dieses Spiel.';
      }
      function bindManager() {
        const inp = $('mgr-code-input');
        const authBtn = $('btn-mgr-auth');
        const logoutBtn = $('btn-mgr-logout');
        if (!authBtn) return;
        authBtn.addEventListener('click', () => {
          const code = (inp ? inp.value : '').trim();
          if (!code) { showNotify('Bitte Manager-Code eingeben.'); return; }
          socket.emit('manager:auth', { code });
        });
        if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') authBtn.click(); });
        // Abmelden: Manager-Rechte auf diesem Socket zurücksetzen.
        if (logoutBtn) logoutBtn.addEventListener('click', () => {
          managerName = null;
          if (inp) inp.value = '';
          socket.emit('manager:logout', {});
          renderManagerMode();
          showNotify('Manager-Modus beendet.');
        });
      }
      socket.on('manager:auth-ok', (d) => {
        // name null/leer = Abmeldung bestätigt; sonst Manager aktiv.
        managerName = (d && d.name) ? d.name : null;
        renderManagerMode();
        if (managerName) showNotify('Manager-Modus aktiv: ' + managerName);
        else showNotify('Manager-Modus beendet.');
      });
      socket.on('error', (err) => {
        // P4: falscher Manager-Code sichtbar melden; andere Fehler stumm (Server verarbeitet diese sowieso).
        if (err && err.code === 'BAD_MANAGER_CODE') showNotify('Ungültiger Manager-Code.', true);
      });
      renderManagerMode();
      bindManager();
      // Preset-Editor-Modal öffnen/schließen
      const openBtn = $('btn-open-preset-editor');
      if (openBtn) openBtn.addEventListener('click', () => { const m = $('preset-modal'); if (m) m.classList.remove('hidden'); bindMonopolyToggles(); syncEvenToggle(); });
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
        // Item-Preise/Sonderwerte normalisieren — Fee-/Bonus-Werte der
        // Ereignis/Gefängnis/Steuer/Los-Felder MITSPEICHERN (Bug 2g#6).
        const fields = editingFields.map((f) => {
          const out = { type: f.type || 'los', name: f.name || 'Feld' };
          if (f.type === 'grundstueck' && typeof f.price === 'number') out.price = f.price;
          // (2k #5) Farbgruppe (nur Grundstücke) explizit speichern.
          if (f.type === 'grundstueck' && f.group !== undefined && f.group !== null && f.group !== '') out.group = String(f.group);
          else if (f.type === 'los') { if (typeof f.bonus === 'number') out.bonus = f.bonus; }
          else if (f.type === 'ereignis' || f.type === 'gundo' || f.type === 'steuer' || f.type === 'gefangnis') {
            if (typeof f.fee === 'number') out.fee = f.fee;
          }
          return out;
        });
        socket.emit('preset:save', { name, fields, levelNames: Object.keys(levelNames).length ? levelNames : null, settings });
        // (2i-2j) Nach erfolgreichem Speichern (Ack 'presets' setzt die neue Liste):
        // Modal automatisch schließen + das neue Preset im Spiel-Dropdown auswählen.
        pendingSelectPreset = name;
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
      // (2i #3) GM-Anzeigename (default 'GM')
      const gmName = (($('cfg-gmname') || {}).value || '').trim().slice(0, 40) || 'GM';
            const preset = strVal('cfg-preset', 'crusader-cluster');
            // Spielregeln-Settings: übernehmen falls von Default abweichend
            readSettingsInputs();
            // (2h#5/#6) Würfelmodus + Zug-Timer kommen aus dem Preset-Editor (Settings-Gruppen),
            // nicht mehr aus dem Setup-Grundformular. Nur 1W6/2W6 sind gültig.
            const diceConfig = (currentSettings.diceConfig === '2w6') ? '2w6' : '1w6';
            const turnSeconds = Math.max(0, Math.round(Number(currentSettings.turnSeconds) || 0));
            // Armistice-Wert ausschließlich aus Preset ableiten.
            const armistice = !!currentSettings.armisticeEnabled;
      // Beim Start wird der aktuell im Editor bearbeitete Feldstand verwendet.
      const fields = (editingFields || []).map((f) => {
        const out = { type: f.type || 'los', name: f.name || 'Feld' };
        if (f.type === 'grundstueck') {
          if (typeof f.price === 'number') out.price = f.price;
          // (2n-A P4) Farbgruppe mit an den Server senden — sonst fehlt f.group
          // im Spielzustand und das k-band fällt auf das Preisband zurück.
          if (f.group !== undefined && f.group !== null && String(f.group) !== '') out.group = String(f.group);
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
              gmName, levelNames: Object.keys(levelNames).length ? levelNames : null,
              settings, turnSeconds };
          }

    // Beim Ändern der Teamanzahl die Konfigurationsliste neu aufbauen.
    const teamsInput = $('cfg-teams');
    if (teamsInput) teamsInput.addEventListener('change', renderTeamConfig);

  function onCreateClick(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const btn = $('btn-create');
    const config = collectConfig();
    // (2n P2) GM-Anzeigenamen merken, damit die Lobby ihn direkt nach gameCreated zeigt.
    client.gmName = config.gmName || 'GM';
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
          // (QA-Fix P2) GM-Anzeigename statt hartkodiert 'GM' verwenden, damit
          // der gesetzte GM-Name in der Team-Spielerliste erscheint.
          const gmPlayName = (client.gmName && String(client.gmName).trim()) ? String(client.gmName).trim() : 'GM';
          client.playerName = gmPlayName;
          client.gameId = data.gameId;
          client.isGM = true; // bleibt GM
          socket.emit('team:join', { gameId: data.gameId, code, playerName: gmPlayName });
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
    // (2k #2) Button-Label entsprechend der Rolle setzen (GM → Abbrechen).
    updateLobbyLeaveBtn();
    showView('lobby');
    // (2n P2) GM-Anzeigename direkt nach gameCreated in der Lobby zeigen
    // (der Server broadcastet nach gameCreated keinen state).
    renderGmNameBox(client.gmName);
    // (2m P9) Ein pausiertes Spiel öffnen heißt NICHT fortsetzen — nur die Lobby.
    if (data && data.resumed && data.paused) {
      showNotify('Pausiertes Spiel geöffnet — das Spiel läuft erst wieder mit „Fortsetzen“.');
    } else if (data && data.resumed) {
      showNotify('Spiel fortgesetzt — Einladungscodes wieder verfügbar.');
    } else {
      showNotify('Spiel erstellt — Einladungscodes zeigen und an die Spieler verteilen.');
    }
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
      onConfirm: doJoin,
      // (2n P7) Enter in einem Beitreten-Feld = Klick auf „Beitreten“ (mit Validierung).
      onOpen: () => {
        ['join-code', 'join-name'].forEach((id) => {
          const inp = $(id);
          if (!inp) return;
          inp.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); doJoin(); }
          });
        });
      }
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
    // (2m P11) GM-Code im Beitrittsformular → GM-Sitzung übernehmen.
    if (data.isGM) {
      client.isGM = true;
      if (data.gmCode) client.gmCode = data.gmCode;
      if (data.role === 'gm' || data.role === 'leader') client.role = data.role;
      saveGM();
    }
    saveJoin();
    // (2m P9) Ein pausiertes Spiel öffnet NUR die Lobby — das Spiel wird NICHT
    // fortgesetzt. Erst der „Fortsetzen“-Button (gm:start) lädt die Spieleansicht.
    if (data.started && !data.over && !data.paused) {
      // Bereits laufendes Spiel: direkt zur Spiel-Ansicht (state-Broadcast rendert Panels).
      showView('game');
      showNotify(data && data.replaced ? 'Login übernommen — Gerätewechsel erfolgreich.' : (data && data.rejoined ? 'Wiedereingetreten — Spiel läuft weiter.' : 'Eingetreten — das Spiel läuft bereits.'));
      // Der state-Broadcast kann VOR dem joined-Event ankommen (Rejoin-Reihenfolge).
      // Rendere aus dem gecachten Zustand neu, damit teamId gesetzt ist und das
      // Team-Panel nicht fälschlich als „Beobachter" erscheint.
      if (client.lastState && client.lastState.gameId === client.gameId) {
        client.renderGameUI(client.lastState);
      }
      // Action-Bar re-rendern: erster Broadcast kommt oft VOR joined → btn-options
      // wäre sonst disabled. Explizites Re-Render nach Setzen von teamId/role (analog Z.864).
      renderActionBar(client.lastState);
    } else {
      showView('lobby');
      showNotify(data && data.rejoined ? 'Wiedereingetreten — Lobby geladen.' : (data && data.paused ? 'Pausiertes Spiel — Lobby geöffnet. Das Spiel wird erst mit „Fortsetzen“ fortgesetzt.' : 'Eingetreten — Lobby geladen.'));
      // Lobby sofort rendern, damit teamId/role gesetzt sind und Vote-Buttons sichtbar werden.
      // Analog zum Rejoin-Muster im started-Zweig (Zeile ~864-866).
      if (client.lastState && client.lastState.gameId === client.gameId) {
        client.renderLobby(client.lastState);
      }
    }
  });

  /* ---------------- Flow 3: Lobby ---------------- */
    // (2m P6) Gerätewechsel: Der Server hat diesen Login durch einen neuen Client
    // (gleicher Name + gleicher Code) ersetzt → aus dem Spiel leiten.
    socket.on('game:redirected', (data) => {
      clearIdentityLocal();
      showView('setup');
      showNotify((data && data.message) || 'Von einem anderen Standort eingeloggt.');
    });

    function leaderMap(leaders) {
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

  // (2n P2) GM-Anzeigename in der Lobby anzeigen (aus State oder client.gmName,
  // nie hart "GM"). Wird von renderLobby UND direkt nach gameCreated aufgerufen.
  function renderGmNameBox(name) {
    const gmNameBox = $('gm-name-box');
    if (!gmNameBox) return;
    const gmName = (name && String(name).trim()) ? String(name).trim() : 'GM';
    gmNameBox.innerHTML = '<span class="code-lbl">GM</span>' +
      '<div class="code-row"><code class="code-big">' + esc(gmName) + '</code></div>';
  }

  function renderLobby(st) {
    // (2n P2) GM-Anzeigename anzeigen (State hat Vorrang, sonst gemerkter Name).
    renderGmNameBox((st && st.gmName) || client.gmName);
    // (2k #1/#2) Codes (GM-Code + Einladungscodes) NUR für den aktiven GM sichtbar.
    const gmBox = $('gm-code-box');
    const invBox = $('invite-code-box');
    if (gmBox) gmBox.classList.toggle('hidden', !(client.isGM));
    if (invBox) invBox.classList.toggle('hidden', !(client.isGM));
    if (client.isGM) updateLobbyLeaveBtn(); // GM → "Abbrechen"
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
          btn.className = 'btn btn-xs';
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
      myIdx: myTeamIdx(st),
      turnDeadline: (typeof game.turnDeadline === 'number') ? game.turnDeadline : 0,
      log: (st && st.log) || [],
      armisticeEnabled: !!game.armisticeEnabled,
      levelNames: game.levelNames || null,
      settings: game.settings || null,
      presetName: (st && st.presetName) || ((st && st.game && st.game.name) || 'Eigene Karte')
    };
  }

  // Fallback, falls board.js (window.initBoard/renderBoard) fehlt
  function renderFallbackBoard() {
    const board = $('board-row');
    if (!board) return;
    const data = window.__boardData || { fields: [], players: [] };
    board.innerHTML = '';
    board.className += ' board-fallback';
    data.fields.forEach((f) => {
      const el = document.createElement('div');
      el.className = 'kcard';
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
    // Presetname dynamisch anzeigen (Banner unter dem Boardbar-Subtext).
    const pn = (st && st.presetName) || 'Eigene Karte';
    const sub = document.querySelector('#bb-sub');
    if (sub) sub.textContent = pn;
    if (typeof window.setScaleInfo === 'function') window.setScaleInfo();
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
    // (2i #11) Hervorhebung: Angebot betrifft mich → ich; Versteigerung → alle Teams.
    panel.classList.toggle('trade-active', mine.length > 0 || !!auction);
    let html = '';
    // Eingehende Angebote (angedeutet sind mich zur Entscheidung)
    const inbound = mine.filter((o) => o.targetIdx === idx);
    if (inbound.length) {
      html += '<div class="trade-head">📩 Angebote an dich</div>';
      inbound.forEach((o) => {
        const f = st.game.fields[o.fieldIdx];
        const verb = o.kind === 'buy' ? ('will dein Feld kaufen') : ('bietet dir seinen Kauf an');
        html += '<div class="trade-row">' +
          '<span>' + esc(o.fromName || '?') + ' ' + verb + ': <strong>' + esc(f ? f.name : '') + '</strong> · ' + fmtUAEC(o.price) + '</span>' +
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
        html += '<div class="trade-row"><span>→ ' + esc(o.targetName || '?') + ' · ' + esc(f ? f.name : '') + ' · ' + fmtUAEC(o.price) + '</span></div>';
      });
    }
    // Laufende Versteigerung
    if (auction) {
      const f = st.game.fields[auction.fieldIdx];
      const remaining = Math.max(0, auction.endsAt - Date.now());
      const isOwner = auction.ownerIdx === idx;
      const myHighest = auction.highest && auction.highest.playerIdx === idx;
      html += '<div class="trade-head">🔨 Auktion: <strong>' + esc(f ? f.name : '') + '</strong></div>';
      html += '<div class="trade-row"><span>Höchstgebot: ' + (auction.highest ? (esc(st.game.players[auction.highest.playerIdx].name) + ' · ' + fmtUAEC(auction.highest.amount)) : '—') + ' · Rest: ' + Math.round(remaining / 1000) + 's</span></div>';
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

      // (2o-B P9) Farbgruppen-Zugehörigkeit eines Feldes (Spiegel von engine.groupOf):
      // nutzt f.group, sonst Preisband-Fallback. Liefert den Gruppen-Key oder null.
      function groupKeyOf(fidx) {
        const gf = flds[fidx];
        if (!gf || gf.type !== 'grundstueck') return null;
        if (gf.group != null && String(gf.group) !== '') return String(gf.group);
        return (gf.price || 0) > 400000 ? 'BAND1' : 'BAND0';
      }
      // (2o-B P9) Ist ein anderes Feld derselben Farbgruppe beliehen (mortgaged)?
      // → Ausbau auf diesem Feld ist serverseitig blockiert (GROUP_MORTGAGED).
      // ABER nur, wenn die Besitz-Regel aktiv ist (Spiegel von engine.build
      // engine.js:652 `if (ruleOwnership)`) — mit buildGroupOwnership=false lässt
      // der Server den Ausbau auch bei beliehenem Gruppenfeld zu, dann kein Gate.
      function ownershipRuleOn() {
        const s = ECON_SETTINGS;
        if (s && typeof s.buildGroupOwnership === 'boolean') return s.buildGroupOwnership;
        if (s && typeof s.monopolyBuildRule === 'boolean') return s.monopolyBuildRule;
        return true; // Default: Regel aktiv
      }
      function groupMortgaged(fidx) {
        if (!ownershipRuleOn()) return false;
        const gk = groupKeyOf(fidx);
        if (gk == null) return false;
        for (let gi = 0; gi < flds.length; gi++) {
          if (gi === fidx) continue;
          if (groupKeyOf(gi) !== gk) continue;
          const gp = props[gi];
          if (gp && typeof gp === 'object' && gp.mortgaged) return true;
        }
        return false;
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
        // (2o-B P9) Ausgebaut (Stufe > ALLEIN) → Hypothek/Verkauf/Versteigern blockiert.
        const built = own && curIdx > 0;
        const buttons = [];

        if (own && !mortgaged && !built) {
          // Hypothek nur, wenn NICHT schon beliehen UND nicht ausgebaut. Info + Bestätigung.
          const loan = Math.round(price * MORTGAGE_SHOW);
          buttons.push({ id: 'econ-mortgage', label: '🔒 Hypothek', cls: 'btn-xs', act: () => {
            openModal({
              title: 'Hypothek aufnehmen',
              icon: '🔒',
              body: '<p>Feld <strong>' + esc(f ? f.name : ('Feld ' + fidx)) + '</strong> (' + esc(econName(own.level)) + ')</p>' +
                '<ul><li>Du erhältst: <strong>' + fmtUAEC(loan) + '</strong> aUEC</li>' +
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
                '<ul><li>Rückzahlung (Darlehen + Zins): <strong>' + fmtUAEC(pay) + '</strong> aUEC</li>' +
                '<li>Danach kassiert das Feld wieder Miete.</li></ul>',
              confirmText: 'Entlasten (' + fmtUAEC(pay) + ')',
              cancelText: 'Abbrechen',
              onConfirm: () => socket.emit('action:unmortgage', { gameId: client.gameId, field: fidx })
            });
          } });
        }
        if (own && !mortgaged && !groupMortgaged(fidx) && curIdx >= 0 && curIdx < ECON_LEVELS.length - 1) {
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
                  '<ul><li>Baukosten: <strong>' + fmtUAEC(buildCost) + '</strong> aUEC</li>' +
                  '<li>Neue Miete für Gegner: <strong>' + fmtUAEC(rentForClient(price, nextLvl)) + '</strong> aUEC</li></ul>',
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
                '<ul><li>Rückerstattung: <strong>' + fmtUAEC(refund) + '</strong> aUEC</li></ul>',
              confirmText: 'Abbauen (+' + fmtUAEC(refund) + ')',
              cancelText: 'Abbrechen',
              onConfirm: () => socket.emit('action:demolish', { gameId: client.gameId, field: fidx })
            });
          } });
        }
        if (own && !built) {
          // An die Bank verkaufen (Sanierung): bankPayout des Basiswerts.
          // (2o-B P9) Ausgebautes Feld kann nicht verkauft werden (BUILT_NOT_SELLABLE).
          const amt = Math.round(price * BANK_SHOW);
          const bankSellOk = (typeof ECON_SETTINGS.bankSellEnabled !== 'boolean') || ECON_SETTINGS.bankSellEnabled === true;
          if (bankSellOk) {
            buttons.push({ id: 'econ-banksell', label: '🏦 An Bank', cls: 'btn-xs btn-danger', act: () => {
              openModal({
                title: 'Feld an die Bank verkaufen',
                icon: '🏦',
                body: '<p>Feld <strong>' + esc(f ? f.name : ('Feld ' + fidx)) + '</strong> (' + esc(econName(own.level)) + ')</p>' +
                  '<ul><li>Erlös: <strong>' + fmtUAEC(amt) + '</strong> aUEC</li>' +
                  '<li>Dauerhaft — nicht umkehrbar. Aktion nur ausführen, wenn nötig.</li></ul>',
                confirmText: 'Verkaufen (+' + fmtUAEC(amt) + ')',
                cancelText: 'Abbrechen',
                onConfirm: () => socket.emit('action:sell', { gameId: client.gameId, field: fidx, buyerIdx: -1 })
              });
            } });
          }
        }
        if (own && !built) {
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
      esc(meta.teamName || ('Team ' + (idx + 1))),
      'Schiff: ' + esc(ship),
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
              return '<option value="' + esc(pid) + '">' + esc(pl.name || 'Spieler') + '</option>';
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
          // (2h#7) GM-Übergabe: Button togglet das Formular darunter (nicht permanent sichtbar).
          const stP = client.lastState;
          const teamsP = stP && Array.isArray(stP.teams) ? stP.teams : [];
          const parts = [];
          teamsP.forEach((t) => {
            const tid = t.teamId != null ? t.teamId : t.id;
            const tname = t.teamName || (t.ship || '') || ('Team ' + tid);
            (t.players || []).forEach((p) => {
              const pid = p.playerId != null ? p.playerId : p.id;
              const pname = p.name || p.playerName || 'Spieler';
              parts.push('<option value="' + pid + '">' + pname + ' (' + tname + ')</option>');
            });
          });
          if (parts.length) {
            items.push('<div class="opt-toggle">' +
              '<div class="opt-row" data-opt="gmtransfer">🎛 GM-Rolle übertragen — ernennt ein anderes Mitglied zum GM.</div>' +
              '<div class="leader-change-form opt-collapse" data-opt="gmtransfer" style="padding:8px;margin-top:4px">' +
              '<select id="gt-player" style="width:100%;margin-bottom:6px"><option value="">— Teilnehmer wählen —</option>' + parts.join('') + '</select>' +
              '<button type="button" class="btn btn-xs btn-primary" id="gt-confirm" disabled>Übertragen</button>' +
              '</div></div>');
          }
          // (2h#7) GM-only: Teamleiter ändern — Button togglet das Formular darunter.
          const st2 = client.lastState;
          const teams2 = st2 && Array.isArray(st2.teams) ? st2.teams : [];
          if (teams2.length > 1) {
            const teamOpts = teams2.map((t) => {
              const tid = t.teamId != null ? t.teamId : t.id;
              const tname = t.teamName || (t.ship || '') || ('Team ' + tid);
              return '<option value="' + tid + '">' + tname + '</option>';
            }).join('');
            items.push('<div class="opt-toggle">' +
              '<div class="opt-row" data-opt="setleader">⚔ Teamleiter ändern — wähle Team und Mitglied, um den Leiter zu wechseln.</div>' +
              '<div class="leader-change-form opt-collapse" data-opt="setleader" style="padding:8px;margin-top:4px">' +
              '<select id="lc-team" style="width:100%;margin-bottom:6px">' + teamOpts + '</select>' +
              '<select id="lc-player" style="width:100%;margin-bottom:6px"><option value="">— Team wählen —</option></select>' +
              '<button type="button" class="btn btn-xs btn-primary" id="lc-confirm">Bestätigen</button>' +
              '</div></div>');
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
        // (2h#7) Toggle-Formulare (GM-Übergabe / Teamleiter ändern): Klick auf die
        // opt-row klappt das darunterliegende .opt-collapse-Formular ein/aus.
        wrap.querySelectorAll('.opt-toggle').forEach((tg) => {
          const row = tg.querySelector('.opt-row');
          const form = tg.querySelector('.opt-collapse');
          if (!row || !form) return;
          row.addEventListener('click', () => {
            const open = form.classList.toggle('is-open');
            row.classList.toggle('is-open', open);
          });
        });
        // Einmalige Verdrahtung der Bestätigen-Buttons (unabhängig vom Toggle).
        const gtConfirm = $('gt-confirm');
        if (gtConfirm) {
          const playerSel = $('gt-player');
          if (playerSel) playerSel.addEventListener('change', () => { gtConfirm.disabled = !playerSel.value; });
          gtConfirm.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const pid = playerSel ? playerSel.value : '';
            if (!pid) { showNotify('Bitte ein Teilnehmer-Mitglied wählen.'); return; }
            socket.emit('gm:transfer', { gameId: client.gameId, gmCode: client.gmCode, playerId: pid });
            closeModal({ runCancel: false });
          });
        }
        const lcConfirm = $('lc-confirm');
        if (lcConfirm) {
          const teamSel = $('lc-team');
          const playerSel = $('lc-player');
          if (teamSel) teamSel.addEventListener('change', () => {
            if (!playerSel || !lcConfirm) return;
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
            lcConfirm.disabled = true;
          });
          if (playerSel) playerSel.addEventListener('change', () => { lcConfirm.disabled = !playerSel.value; });
          lcConfirm.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const tid = teamSel ? teamSel.value : '';
            const pid = playerSel ? playerSel.value : '';
            if (!tid || !pid) { showNotify('Bitte Team und Mitglied wählen.'); return; }
            socket.emit('gm:setleader', { gameId: client.gameId, gmCode: client.gmCode, teamId: tid, playerId: pid });
            closeModal({ runCancel: false });
          });
        }
        // Direkt-Aktionen (leave/pause/forfeitPoll) bleiben wie gehabt.
        wrap.querySelectorAll('[data-opt]').forEach((row) => {
          const o = row.getAttribute('data-opt');
          if (o === 'gmtransfer' || o === 'setleader') return; // via Toggle oben
          row.addEventListener('click', () => {
            if (o === 'leave') { closeModal({ runCancel: false }); onLeaveClick(); }
            else if (o === 'pause') { closeModal({ runCancel: false }); onPauseClick(); }
            else if (o === 'forfeitPoll') { closeModal({ runCancel: false }); onStartForfeitPoll(); }
          });
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
    const arr = log || [];
    // Neueste zuerst (Ticker ist row-reverse → neuester rechts, ältere links raus).
    for (let i = arr.length - 1; i >= 0; i--) {
      const line = document.createElement('span');
      line.className = 'tick';
      line.textContent = typeof arr[i] === 'string' ? arr[i] : JSON.stringify(arr[i]);
      el.appendChild(line);
    }
    el.scrollLeft = 0;
  }

  // Vollständiges Log als Liste im Modal (LOG-Button im Ticker).
  function openLogModal() {
    const log = (client.lastState && client.lastState.log) || [];
    if (!log.length) { showNotify('Noch keine Log-Einträge.'); return; }
    const rows = log.slice().reverse().map((e) => {
      const t = typeof e === 'string' ? e : (e && (e.msg || e.message || e.text)) || JSON.stringify(e);
      return '<div class="log-modal-line">' + esc(t) + '</div>';
    }).join('');
    openModal({
      title: 'Spiel-Log',
      icon: '📜',
      body: '<div class="log-modal-list" style="margin-top:4px">' + rows + '</div>',
      cancelText: 'Schließen',
      confirmText: null
    });
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

    // (2k #3) Aktives Guthaben in der ACTIONBAR (#ab-field) statt im Header anzeigen.
    const abField = document.getElementById('ab-field');
    if (abField) {
      if (st && st.started && myIdx >= 0 && st.game && st.game.players && st.game.players[myIdx]) {
        const bal = st.game.players[myIdx].budget;
        if (typeof bal === 'number') {
          abField.textContent = bal.toLocaleString('de-DE') + ' aUEC';
          abField.classList.remove('hidden');
        } else { abField.textContent = 'Stantonopoly'; }
      } else { abField.textContent = 'Stantonopoly'; }
    }

    if (st.over) {
      client.renderGameUI(st);
      showWinnerModal(st);
      return;
    }
    // (2m P9) Ein pausiertes Spiel zeigt die LOBBY (Teams sammeln sich) — die
    // Spieleansicht lädt erst, wenn der GM das Spiel mit „Fortsetzen“ fortsetzt.
    if (st.started && !st.paused) {
      client.renderGameUI(st);
    } else {
      showView('lobby');
      renderLobby(st);
      renderLog(st.log);
    }
  });

  // (2m-E) Sieger-Modal mit Platzierung (Sieger → erster Ausscheider).
  // Blockierend, für Spieler UND Zuschauer. Nutzt die vom Server ergänzte
  // `ranking`-Liste (st.ranking); Fallback: aus st.game.players ableiten.
  function showWinnerModal(st) {
    if ($('stp-modal')) closeModal({ runCancel: false });
    const winner = st.winnerInfo ? (st.winnerInfo.name || st.winnerInfo.teamName || st.winnerInfo) : '';
    let ranking = Array.isArray(st.ranking) ? st.ranking : [];
    if (!ranking.length && st.game && Array.isArray(st.game.players)) {
      const winnerId = st.winnerInfo ? st.winnerInfo.id : null;
      const alive = [];
      const out = [];
      st.game.players.forEach((p, i) => {
        const meta = (st.teams && st.teams[i]) || {};
        const entry = {
          name: p.name || meta.teamName || ('Team ' + (i + 1)),
          ship: meta.ship || '',
          color: meta.color || '',
          teamName: meta.teamName || p.name || ('Team ' + (i + 1)),
          bankrupt: !!p.bankrupt,
          winner: !!p.winner || (winnerId != null && String(p.id) === String(winnerId)),
          budget: (typeof p.budget === 'number') ? p.budget : 0
        };
        if (entry.winner) alive.unshift(entry);
        else if (!p.bankrupt) alive.push(entry);
        else out.push(entry);
      });
      ranking = alive.concat(out).map((e, i) => Object.assign(e, { place: i + 1 }));
    }
    const rows = ranking.map((r) => {
      const medal = r.place === 1 ? '🏆' : (r.place === 2 ? '🥈' : (r.place === 3 ? '🥉' : ''));
      const status = r.winner ? 'Sieger' : (r.bankrupt ? 'ausgeschieden' : 'aktiv');
      const colorDot = r.color ? '<span class="rk-dot" style="background:' + r.color + '"></span>' : '';
      return '<div class="rk-row' + (r.winner ? ' rk-winner' : '') + '">' +
        '<span class="rk-place">' + r.place + '.</span>' +
        colorDot +
        '<span class="rk-name">' + esc(r.teamName || r.name || '?') + (r.ship ? ' <small>(' + esc(r.ship) + ')</small>' : '') + '</span>' +
        '<span class="rk-status">' + medal + ' ' + status + '</span>' +
        '</div>';
    }).join('');
    openModal({
      title: '🏆 Spiel beendet — Sieger: ' + esc(winner || '?'),
      icon: '🏆',
      body: '<div class="rk-head">Platzierung (Sieger → erster Ausscheider)</div>' +
        '<div class="rk-list">' + (rows || '<div class="rk-empty">Keine Platzierung verfügbar.</div>') + '</div>',
      confirmText: null,
      cancelText: 'Schließen',
      // (2n P5) Siegermodal schließen → Spiel sauber verlassen (zurück zur Startansicht).
      // Das Spiel ist serverseitig beendet (st.over), daher reicht der leave-Flow:
      // game:leave wird gesendet, auf 'left' gewartet, Identität geleert, Setup gezeigt.
      onCancel: () => { emitLeaveAndAck('Spiel verlassen — zurück zur Startansicht.'); }
    });
  }

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
    renderForfeitPollUI(st);
  };

  // (2m P9/P10) Kein renderPauseBanner mehr: pausierte Spiele werden clientseitig IMMER
  // in die Lobby geroutet (state-Handler/joined), nie in die Spielansicht — das Banner
  // wäre in renderGameUI (nur bei !paused erreichbar) toter Code. Pause wird in der
  // Lobby angezeigt, nicht als Overlay über dem Brett.

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
      body: '<p>Dein Team <strong>' + esc(p.name || 'Team') + '</strong> ist in Zahlungsrückstand (Konto: <strong>' + fmtUAEC(p.budget) + '</strong> aUEC).</p>' +
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
        '<ul><li>Lösegeld: <strong>' + fmtUAEC(bail) + '</strong> aUEC</li>' +
        '<li>Freikaufen = sofort weiter; sonst überspringst du die nächsten ' + Math.max(1, p.jailTurns || 1) + ' Zug/Züge.</li></ul>',
      confirmText: 'Freikaufen (' + fmtUAEC(bail) + ')',
      cancelText: 'Absitzen (' + Math.max(1, p.jailTurns || 1) + ' Zug)',
      confirmClass: 'btn-ok',
      onConfirm: () => socket.emit('action:bail', { gameId: client.gameId }),
      onCancel: () => socket.emit('action:jailstay', { gameId: client.gameId })
    });
  }

  /* ---------------- Fehler-Handler (Server → Client) ---------------- */
  socket.on('game:cancelled', (data) => {
    const gid = (data && data.gameId) || client.gameId;
    if (!gid) return;
    // GM, der selbst abgebrochen hat, hat schon clearIdentityLocal() aufgerufen — kein doppeltes Fegen.
    // Alle ANDEREN im Raum (Teams, Spectator, Leiter) haben noch die Identität gesetzt.
    if (client.gameId === gid) {
      // Bewusst NUR die Raum-Zuordnung leeren; gespeicherte Identität optional behalten.
      // (2k #2) Bei removed=1 ist das Spiel gelöscht → Identität verwerfen.
      if (data && data.removed) {
        clearIdentityLocal();
        showView('setup');
        showNotify(gid + ': Spiel wurde vom GM abgebrochen und entfernt.');
      } else {
        // Pausiertes Spiel: Fortsetzen abgebrochen → zurück in die Spieleliste.
        showView('setup');
        showNotify(gid + ': Fortsetzen abgebrochen — das Spiel bleibt pausiert.');
      }
    }
  });

  socket.on('error', (err) => {
    console.error('[client.js] error vom Server', err && (err.code || '') , err && (err.message || err.error || ''));
    const code = err && (err.code || '');
    // (2m P12) Fortsetzen mit leeren Teams: GM wird gefragt — (a) warten oder
    // (b) trotzdem fortsetzen (leere Teams geben automatisch auf).
    if (code === 'EMPTY_TEAMS') {
      const teams = (err && Array.isArray(err.emptyTeams)) ? err.emptyTeams : [];
      const names = teams.map((t) => (t && (t.teamName || t.ship)) || 'Team').join(', ');
      openModal({
        title: 'Leere Teams beim Fortsetzen',
        icon: '⚠️',
        body: '<p>Nicht alle Teams haben Spieler' + (names ? ' (<strong>' + esc(names) + '</strong>)' : '') + '.</p>' +
          '<ul><li><strong>Warten</strong> — die Lobby bleibt offen, bis alle Teams Spieler haben.</li>' +
          '<li><strong>Trotzdem fortsetzen</strong> — leere Teams geben automatisch auf (Forfeit).</li></ul>',
        confirmText: 'Trotzdem fortsetzen',
        cancelText: 'Warten',
        confirmClass: 'btn-danger',
        onConfirm: () => {
          console.log('[client.js] gm:start mit confirmEmpty (leere Teams geben auf)');
          socket.emit('gm:start', { gameId: client.gameId, gmCode: client.gmCode, confirmEmpty: true });
        },
        onCancel: () => { /* Warten: Lobby bleibt offen */ }
      });
      return;
    }
    const msg = (err && (err.notify || err.message || err.error)) || 'Unbekannter Fehler (' + code + ')';
    showNotify(msg);
    if (window.__notifyEl) window.__notifyEl.classList.add('is-error');
  });

  /* ---------------- (2g#8) GM-Übergabe: Ziel erhält den frischen GM-Code ------------- */
    socket.on('gm:owner', (data) => {
      const newCode = data && data.gmCode;
      if (!newCode) return;
      client.gameId = (data && data.gameId) || client.gameId;
      client.gmCode = newCode;
      client.isGM = true;
      client.role = 'gm';
      saveGM();
      showNotify('Du bist jetzt der GM. Bewahre den GM-Code gut auf.');
      if (typeof window.setScaleInfo === 'function') window.setScaleInfo();
    });

    /* ---------------- (2h#8a) GM-Übergabe: der ALTE GM verliert seine GM-Rechte ------------- */
    socket.on('gm:revoked', (data) => {
      // GM-Status sauber zurücksetzen: kein GM mehr, GM-Code verwerfen.
      client.isGM = false;
      client.gmCode = null;
      try { localStorage.removeItem(GM_KEY); } catch (e) {}
      // Rolle: falls der alte GM in einem Team mitspielt, bleibt er Mitglied/Leader;
      // nur die GM-Sonderrechte fallen weg. Beobachter bleiben Beobachter.
      if (client.role === 'gm') client.role = (client.teamId != null) ? 'member' : 'spectator';
      const name = (data && data.newOwnerName) || 'ein anderes Mitglied';
      showNotify('GM-Rolle an ' + name + ' übertragen — du bist nicht mehr der GM.');
      // Options-Modal ohne GM-Actions rendern (falls offen) + Action-Bar aktualisieren.
      if (typeof client.renderGameUI === 'function' && client.lastState) client.renderGameUI(client.lastState);
      else if (typeof renderActionBar === 'function') renderActionBar(client.lastState);
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
  // Paletten-Switcher initialisieren (F-Schale: cargo/ion/uplink)
  initPaletteSwitcher();

  // Drawer (rechte Klapp-Panels) + Aktionsleisten-Wrapping: Klick auf den Kopf
  // klappt den Drawer auf/zu — Funktion bleibt, nur F-Schale-Interaktion.
  document.querySelectorAll('.drawer .dw-head').forEach((head) => {
    head.addEventListener('click', () => {
      const dr = head.closest('.drawer');
      if (dr) dr.classList.toggle('is-open');
    });
  });

  // LOG-Kasten als Button → öffnet das Log-Modal (komplettes Log, neueste zuerst).
  const logBtn = $('tick-log-btn');
  if (logBtn) logBtn.addEventListener('click', openLogModal);

  // Zug-Timer-Anzeige: Boardbar-Restzeit sekündlich aktualisieren (nur in Spielansicht).
  setInterval(() => {
    if (!document.body.classList.contains('view-game')) return;
    const dead = client.lastState && client.lastState.game && client.lastState.game.turnDeadline;
    const timerEl = document.getElementById('bb-timer');
    if (!timerEl) return;
    const stat = timerEl.closest('.bb-stat');
    if (dead && Number(dead) > Date.now()) {
      const remain = Math.max(0, Math.ceil((Number(dead) - Date.now()) / 1000));
      timerEl.textContent = String(remain) + 's';
      if (stat) stat.classList.remove('hidden');
    } else if (stat) {
      stat.classList.add('hidden');
    }
  }, 1000);

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
  // Lobby-Button: Für den AKTIVEN GM ist er "Abbrechen" (Grundkonfektion: neues Spiel
  // abbrechen+entfernen / Fortsetzen abbrechen). Für Mitspieler bleibt er "Verlassen".
  const leaveLobbyBtn = $('btn-leave-lobby');
  function updateLobbyLeaveBtn() {
    if (!leaveLobbyBtn) return;
    if (client.isGM && client.gameId) {
      leaveLobbyBtn.textContent = '✕ Abbrechen';
      leaveLobbyBtn.title = 'GM: dieses Spiel abbrechen bzw. das Fortsetzen abbrechen';
      leaveLobbyBtn.classList.remove('hidden');
    } else if (client.gameId) {
      leaveLobbyBtn.textContent = '↩ Spiel verlassen';
      leaveLobbyBtn.title = '';
      leaveLobbyBtn.classList.remove('hidden');
    } else {
      leaveLobbyBtn.classList.add('hidden');
    }
  }
  if (leaveLobbyBtn) leaveLobbyBtn.addEventListener('click', () => {
    if (!client.gameId) { showView('setup'); return; }
    if (client.isGM) {
      socket.emit('game:cancel', { gameId: client.gameId, gmCode: client.gmCode || '' });
      clearIdentityLocal();
      showView('setup');
      showNotify('Spiel abgebrochen.');
      return;
    }
    // Nicht-GM: Verlassen nur ausführen, wenn der Server es bestätigt ('left').
    // Bei Fehler bleibt die Identität erhalten.
    emitLeaveAndAck('Spiel verlassen.');
    return;
  });
  // Beim gameCreated (Lobby) und bei ROLLEN//State-Änderungen den Button korrekt setzen.
  client.updateLobbyLeaveBtn = updateLobbyLeaveBtn;

  function clearIdentityLocal() {
    try { localStorage.removeItem(LS_KEY); localStorage.removeItem(GM_KEY); } catch (e) {}
    client.gameId = null; client.teamId = null; client.playerId = null;
    client.token = null; client.gmCode = null; client.isGM = false; client.role = null;
  }

  // (2k #4) Verlassen NUR bestätigt ausführen: warte auf das Server-Ack 'left'.
  // Schlägt der Server fehl (z.B. GM_ACTIVE — aktiver GM muss erst Nachfolge übertragen),
  // bleibt der Client im Spiel und identifiziert. Kein optimistisches Aufräumen mehr.
  function emitLeaveAndAck(notifyText) {
      const pb = $('pause-banner');
      if (pb) pb.remove();
      const tid = setTimeout(() => {
        socket.off('left', onLeft); socket.off('error', onErr); socket.off('leave:confirm', onConfirm);
        clearIdentityLocal(); showView('setup');
        showNotify('Spiel verlassen (keine Bestätigung empfangen).');
      }, 4000);
      function onLeft() {
        clearTimeout(tid); socket.off('left', onLeft); socket.off('error', onErr); socket.off('leave:confirm', onConfirm);
        clearIdentityLocal(); showView('setup');
        showNotify(notifyText || 'Spiel verlassen.');
      }
      function onErr(err) {
        const code = err && (err.code || err);
        if (String(code).toUpperCase() === 'GM_ACTIVE') {
          clearTimeout(tid); socket.off('left', onLeft); socket.off('error', onErr); socket.off('leave:confirm', onConfirm);
          // GM bleibt: nichts clearen. Fehlermeldung hat error-Handler schon gezeigt.
          return;
        }
        clearTimeout(tid); socket.off('left', onLeft); socket.off('error', onErr); socket.off('leave:confirm', onConfirm);
        clearIdentityLocal(); showView('setup');
      }
      // (2m P7) Letzter Spieler seines Teams: Server fragt erst nach Bestätigung.
      function onConfirm(data) {
        clearTimeout(tid); socket.off('left', onLeft); socket.off('error', onErr); socket.off('leave:confirm', onConfirm);
        openModal({
          title: 'Team gibt auf',
          icon: '🚩',
          body: '<p>' + esc((data && data.message) || 'Wenn du das Spiel verlässt, gibt dein Team auf.') + '</p>',
          confirmText: 'Verlassen & aufgeben',
          cancelText: 'Abbrechen',
          confirmClass: 'btn-danger',
          onConfirm: () => {
            // Nach Bestätigung: forfeit + leave ausführen und auf 'left' warten.
            const tid2 = setTimeout(() => { clearIdentityLocal(); showView('setup'); }, 4000);
            socket.once('left', () => { clearTimeout(tid2); clearIdentityLocal(); showView('setup'); showNotify('Spiel verlassen — dein Team hat aufgegeben.'); });
            socket.once('error', () => { clearTimeout(tid2); clearIdentityLocal(); showView('setup'); });
            socket.emit('game:leave', { gameId: client.gameId, confirm: true });
          }
        });
      }
      socket.once('left', onLeft);
      socket.once('error', onErr);
      socket.once('leave:confirm', onConfirm);
      socket.emit('game:leave', { gameId: client.gameId });
    }
  client.emitLeaveAndAck = emitLeaveAndAck;

  function leaveNow() {
    // Pause-Banner explizit entfernen, damit er nach dem Verlassen nicht mehr sichtbar bleibt.
    emitLeaveAndAck('Spiel verlassen — du kannst jederzeit mit dem Einladungscode zurückkehren.');
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
      head.innerHTML = '<strong>' + esc(g.name || 'Ohne Namen') + ' <span class="game-id">#' + esc(g.gameId || '') + '</span></strong>' +
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
        // (2m P9) Öffnen eines pausierten Spiels öffnet NUR die Lobby (gm:resume) —
        // das Spiel wird NICHT fortgesetzt. Fortsetzen passiert erst über den
        // „Fortsetzen“-Button in der Lobby (gm:start).
        socket.emit('gm:resume', { gameId: game.gameId, gmCode: client.gmCode });
        showNotify('Pausiertes Spiel geöffnet — Lobby geladen. Fortsetzen über den Button in der Lobby.');
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
    const winnerLine = r && r.winner ? '<div class="result-winner">🏆 Sieger: <strong>' + esc(r.winner.name || '?') + '</strong></div>' : '';
    resBox.innerHTML = '<div class="result-title">Endresultat: ' + esc(r && r.name || '') + '</div>' + winnerLine +
      '<table class="result-table"><thead><tr><th>Team</th><th>Budget</th><th>Liegenschaften</th><th>Status</th></tr></thead><tbody>' +
      rows.map((p) => '<tr>' +
        '<td>' + (p.winner ? '👑 ' : '') + esc(p.name || '') + (p.ship ? ' <small>(' + esc(p.ship) + ')</small>' : '') + '</td>' +
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
