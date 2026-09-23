/* =========================================================================
   Stantonopoly V2 — board.js
   Rundum-Brett-Renderer (Monopoly-Form, 16 Felder):
     Top      0-4  (links→rechts)
     Rechts   5-8  (oben→unten, Ecke 4/8 geteilt)
     Bottom   8-12 (rechts→links)
     Links    12-15(unten→oben)
   initBoard():   liest window.__boardData, rendert Felder EINMAL + Tokens + Mitte.
   renderBoard(): aktualisiert nur Token-Positionen, Marker, aktive Markierung, Log.
   Global: window.initBoard, window.renderBoard
   ========================================================================= */
(function () {
  'use strict';

  // ---------------------------- Konstanten ------------------------------
  // Mietanteile (V1 data.js: RENT_MULT) — Fallback, falls window.StantonopolyData fehlt
  var RENT_SHARE = { ALLEIN: 0.10, CYCLONE: 0.50, STORM: 1.00, BALLISTA: 2.00, ARMISTICE: 3.00 };
  var RENT_ROWS = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA'];
  // Anzeigenamen der Ausbaustufen. Stufe 0 heißt "Standard" (statt "allein").
  // Anpassbar über das Preset (levelNames), Fallback hier.
  var LEVEL_NAMES_DEFAULT = { ALLEIN: 'Standard', CYCLONE: 'Cyclone', STORM: 'Storm', BALLISTA: 'Ballista', ARMISTICE: 'Armistice Zone' };
  var LEVEL_ORDER = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA', 'ARMISTICE'];
  var FALLBACK_LOS_BONUS = 500000;   // V1: LOS_PASS_BONUS
  var FALLBACK_GUNDO_FEE = 125000;   // V1: GUNDO_FEE

  function levelNames() {
    var sd = window.StantonopolyData;
    if (sd && sd.LEVEL_NAMES) return sd.LEVEL_NAMES;
    // Live-Level-Namen aus dem Spielzustand (per Preset anpassbar).
    if (state && state.data && state.data.levelNames && typeof state.data.levelNames === 'object') return state.data.levelNames;
    return LEVEL_NAMES_DEFAULT;
  }
  function levelName(level) {
    var m = levelNames();
    var n = m ? m[level] : null;
    return n || LEVEL_NAMES_DEFAULT[level] || level;
  }

  var state = {
    built: false,
    fields: [],
    players: [],
    activeIdx: 0,
    tokens: [],      // DOM-Nodes, Index = player-Index
    markerEls: {},   // feldIdx -> { chip, marks }
    lastLogKey: '',
    data: null
  };

  // ---------------------------- Helfer -----------------------------------
  function fmt(n) {
    var v = Math.round(Number(n) || 0);
    var sign = v < 0 ? '-' : '';
    var d = String(Math.abs(v));
    var out = '';
    for (var i = 0; i < d.length; i++) {
      if (i > 0 && (d.length - i) % 3 === 0) out += '.';
      out += d[i];
    }
    return sign + out;
  }

  function losBonus() {
    var sd = window.StantonopolyData;
    return sd && typeof sd.LOS_PASS_BONUS === 'number' ? sd.LOS_PASS_BONUS : FALLBACK_LOS_BONUS;
  }
  function gundoFee() {
    var sd = window.StantonopolyData;
    return sd && typeof sd.GUNDO_FEE === 'number' ? sd.GUNDO_FEE : FALLBACK_GUNDO_FEE;
  }

  function bandClass(price) {
    if (price <= 300000) return 'b-300';
    if (price <= 400000) return 'b-400';
    if (price <= 500000) return 'b-500';
    return 'b-600';
  }

  /** Zellen-Position im 5×5-Grid (col, row 0..4). */
  function cellGrid(i) {
    if (i <= 4) return { col: i, row: 0, side: 'top' };
    if (i <= 8) return { col: 4, row: i - 4, side: 'right' };
    if (i <= 12) return { col: 12 - i, row: 4, side: 'bottom' };
    return { col: 0, row: 15 - i, side: 'left' };
  }
  function isCornerPos(i) { return false; } // Corner-Klassen entfernt (keine Eckfelder im neuen Design)

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  // ---------------------------- Feld-Rendering (einmalig) ----------------
  // Schwarzer Balken: bei allen Nicht-Grundstücken steht dort der Feldtyp als
  // weißer, zentrierter Text (Punkt: Farbbalken auch für diese Typen).
  function typeBar(f) {
    const T = {
      los: 'LOS', 'gundo': 'GUNDO', ereignis: 'EREIGNIS',
      gefangnis: 'GEFÄNGNIS', freiparken: 'FREI PARKEN', steuer: 'STEUER'
    };
    return el('div', 'colorbar b-black', (T[f.type] || f.type.toUpperCase()).replace(/ /g, '&nbsp;'));
  }
  function buildField(i, f) {
    var g = cellGrid(i);
    var classes = ['field', 'f' + i, 'side-' + g.side];
    if (f.type === 'gundo' || f.type === 'ereignis') classes.push('is-ereignis');

    var node = el('div', classes.join(' '));
    node.setAttribute('data-field-id', String(i));
    node.setAttribute('data-field-type', f.type);

    if (f.type === 'los') {
      node.appendChild(typeBar(f));
      node.appendChild(el('div', 'f-name', 'Orison'));
      node.appendChild(el('div', 'f-bonus', '+' + fmt(losBonus()) + ' uAEC bei Überquerung'));
      node.appendChild(el('div', 'f-glyph', '◈'));
    } else if (f.type === 'gundo' || f.type === 'ereignis') {
      // Ereignis-Steuerfeld: Effekt nur bei Landung; Gebühr/Bonus anzeigen.
      node.appendChild(typeBar(f));
      node.appendChild(el('div', 'f-name', f.name));
      const fee = (typeof f.fee === 'number') ? f.fee : 0;
      node.appendChild(el('div', 'f-bonus', fee > 0 ? ('Gebühr ' + fmt(fee) + ' uAEC')
        : fee < 0 ? ('Bonus ' + fmt(Math.abs(fee)) + ' uAEC') : 'Kein Effekt'));
      node.appendChild(el('div', 'f-glyph', fee > 0 ? '✚' : (fee < 0 ? '✦' : '•')));
    } else if (f.type === 'gefangnis') {
      node.appendChild(typeBar(f));
      node.appendChild(el('div', 'f-name', f.name));
      const bail = (typeof f.fee === 'number') ? f.fee : 0;
      node.appendChild(el('div', 'f-bonus', bail > 0 ? ('Lösegeld ' + fmt(bail) + ' uAEC') : 'Züge aussetzen'));
      node.appendChild(el('div', 'f-glyph', '⛓'));
    } else if (f.type === 'freiparken') {
      node.appendChild(typeBar(f));
      node.appendChild(el('div', 'f-name', f.name));
      node.appendChild(el('div', 'f-bonus', 'Nichts passiert'));
      node.appendChild(el('div', 'f-glyph', '🅿'));
    } else if (f.type === 'steuer') {
      node.appendChild(typeBar(f));
      node.appendChild(el('div', 'f-name', f.name));
      const tax = (typeof f.fee === 'number') ? f.fee : 0;
      node.appendChild(el('div', 'f-bonus', tax > 0 ? ('Zahle ' + fmt(tax) + ' uAEC') : 'Kein Betrag'));
      node.appendChild(el('div', 'f-glyph', '✚'));
    } else {
      node.appendChild(el('div', 'colorbar ' + bandClass(f.price)));
      node.appendChild(el('div', 'f-name', f.name));
      node.appendChild(el('div', 'f-price', fmt(f.price)));
      // Untere Kartenhälfte: aktuelle Miete + Ausbaustufe (besitzerabhängig,
      // wird in updateMarkers aktualisiert). Keine Stufenliste/Symbole mehr.
      var rentBox = el('div', 'f-rentcurrent', '');
      var rentLabel = el('div', 'f-rentlabel', 'Miete');
      var rentVal = el('div', 'f-rentvalue', '—');
      rentVal.setAttribute('data-rentval', '1');
      rentBox.appendChild(rentLabel);
      rentBox.appendChild(rentVal);
      node.appendChild(rentBox);
      var lvlBox = el('div', 'f-levelrow', '');
      var lvlVal = el('span', 'f-levelvalue', levelName('ALLEIN'));
      lvlVal.setAttribute('data-levelval', '1');
      var chip = el('span', 'owner-chip hidden');
      chip.setAttribute('data-chip', '1');
      lvlBox.appendChild(lvlVal);
      lvlBox.appendChild(chip);
      node.appendChild(lvlBox);
      node.appendChild(el('div', 'f-mortrow hidden', '🔒 beliehen'));
      state.markerEls[i] = { chip: chip, field: node, rentVal: rentVal, lvlVal: lvlVal };
    }
    // Overlay-Info für ALLE Feldtypen: absolute Overlay, das den Karteninhalt (außer Colorbar) überdeckt
    var infoToggle = el('div', 'f-info hidden', '');
    infoToggle.setAttribute('data-info-toggle', '1');
    node.appendChild(infoToggle);
    if (state.markerEls[i]) state.markerEls[i].infoToggle = infoToggle;
    return node;
  }

  function buildCenter() {
    var c = el('div', 'board-center');
    c.appendChild(el('div', 'bc-logo', 'STANTONOPOLY'));
    c.appendChild(el('div', 'bc-sub', 'Crusader Cluster'));
    var active = el('div', 'bc-active', '');
    c.appendChild(active);
    return c;
  }

  // ---------------------------- Skalierung --------------------------------
  function setCellSize() {
    var board = document.getElementById('board');
    var wrap = board && board.parentElement;
    if (!board || !wrap) return;
    // viewport-basiert (nicht zirkular über die Board-Breite selbst)
    var vw = Math.min(window.innerWidth || 1024, document.documentElement.clientWidth || 1024);
    var avail = Math.min(wrap.clientWidth || vw, vw) - 8;
    var cell = Math.floor(avail / 5);               // 5 Zellen breit
    cell = Math.max(56, Math.min(cell, 220));      // Desktop groß, Handy mindestens 56px
    board.style.setProperty('--cell-size', cell + 'px');
    layoutTokens();
  }

  // ---------------------------- Tokens ------------------------------------
  /** Mittelpunkt einer Zelle in Koordinaten der .tokens-layer (px). */
  function fieldCenter(i) {
    // Einheitliche horizontale, scrollbare Feldleiste für alle Presets.
    var gap = 8;
    var cardW = 170;
    var cardH = Math.round(cardW * (8 / 5)); // Verhältnis 5:8 (breit:hoch)
    return { x: i * (cardW + gap) + cardW / 2, y: Math.round(cardH / 2), cellW: cardW };
  }

  function layoutTokens() {
    if (!state.built) return;
    var board = document.getElementById('board');
    if (!board) return;
    var byField = {};
    var p = state.data;
    for (var i = 0; i < p.players.length; i++) {
      (byField[p.players[i].pos] = byField[p.players[i].pos] || []).push(i);
    }
    for (var f in byField) {
      var group = byField[f];
      var c = fieldCenter(Number(f));
      var t = c.cellW * 0.30;              // Token-Größe (via --token-size)
      var step = t * 0.62;                 // Versatz nebeneinander
      for (var k = 0; k < group.length; k++) {
        var tok = state.tokens[group[k]];
        if (!tok) continue;
        var dx = (k - (group.length - 1) / 2) * step;
        tok.style.left = (c.x + dx) + 'px';
        tok.style.top = c.y + 'px';
      }
    }
  }

  // ---------------------------- Marker & Log ------------------------------
  function updateMarkers() {
    var p = state.data;
    // alle Marker zurücksetzen, dann belegen
    var i;
    for (i in state.markerEls) {
      var mm = state.markerEls[i];
      if (mm.chip) mm.chip.classList.add('hidden');
      if (mm.field) mm.field.classList.remove('is-mortgaged');
      if (mm.lvlVal) mm.lvlVal.textContent = levelName('ALLEIN');
      if (mm.rentVal) mm.rentVal.textContent = '—';
      if (mm.field) {
        var mortRow = mm.field.querySelector('.f-mortrow');
        if (mortRow) mortRow.classList.add('hidden');
      }
    }
    for (var pi = 0; pi < p.players.length; pi++) {
      var player = p.players[pi];
      var props = player.properties || {};
      for (var fid in props) {
        var m = state.markerEls[Number(fid)];
        if (!m || !m.field) continue;
        var own = props[fid];
        var level = (own && typeof own === 'object') ? own.level : own; // Objekt {level,mortgaged} oder Legacy-String
        var f = state.fields[Number(fid)];
        // Besitzer-Chip
        if (m.chip) {
          m.chip.classList.remove('hidden');
          m.chip.style.background = player.color || '#666';
          m.chip.title = player.teamName || '';
        }
        // Hypothek-Kennzeichnung
        var mortgaged = !!(own && typeof own === 'object' && own.mortgaged);
        if (m.field) m.field.classList.toggle('is-mortgaged', mortgaged);
        if (m.field) {
          var mortRow = m.field.querySelector('.f-mortrow');
          if (mortRow) mortRow.classList.toggle('hidden', !mortgaged);
        }
        // Ausbaustufe (Name) + aktuelle Miete (besitzerabhängig)
        var cur = LEVEL_ORDER.indexOf(level);
        if (cur < 0) cur = 0; // Standard
        if (m.lvlVal) m.lvlVal.textContent = levelName(level);
        if (m.rentVal && f && typeof f.price === 'number') {
          var rentKey = level === 'ALLEIN' ? 'ALLEIN' : level;
          m.rentVal.textContent = fmt(Math.round(f.price * rentMultFor(rentKey))) + ' uAEC';
        }
      }
    }
  }

  function updateActive() {
    var p = state.data;
    var board = document.getElementById('board');
    var actives = board ? board.querySelectorAll('.field.is-active') : [];
    for (var i = 0; i < actives.length; i++) actives[i].classList.remove('is-active');
    if (p.players[p.activeIdx]) {
      var fEl = board.querySelector('.field[data-field-id="' + p.players[p.activeIdx].pos + '"]');
      if (fEl) fEl.classList.add('is-active');
    }
    var bcActive = board ? board.querySelector('.bc-active') : null;
    if (bcActive) {
      var ap = p.players[p.activeIdx];
      bcActive.innerHTML = ap
        ? 'Aktiv: <strong>' + (ap.teamName || '?') + '</strong> · Feld ' + ap.pos
        : '—';
    }
    // Token: Aktiv-Ring + Farbe
    for (var pi = 0; pi < p.players.length; pi++) {
      var tok = state.tokens[pi];
      if (!tok) continue;
      var pl = p.players[pi];
      tok.style.setProperty('--team', pl.color || '#888');
      tok.classList.toggle('is-active', pi === p.activeIdx);
    }
    // Aktives Feld in den sichtbaren Bereich der horizontal scrollbaren Reihe
    // holen (zuverlässig via scrollLeft statt scrollIntoView, das in flex-overflow
    // unzuverlässig ist). Scrollt bei jedem Wurf und beim Zugwechsel.
    var apIdx = p.players[p.activeIdx] ? p.players[p.activeIdx].pos : -1;
    if (board && apIdx >= 0) {
      var target = board.querySelector('.field[data-field-id="' + apIdx + '"]');
      if (target) {
        var gap = 8;
        var cardW = 170;
        var x = apIdx * (cardW + gap) + cardW / 2;
        var viewW = board.clientWidth || board.offsetWidth || 600;
        // Zentriere die Karte: scrollLeft so setzen, dass die Karte mitten im
        // sichtbaren Bereich liegt (und nicht über die Ränder hinaus).
        var targetLeft = Math.max(0, Math.min(x - viewW / 2, (board.scrollWidth || 0) - viewW));
        board.scrollTo({ left: targetLeft, behavior: 'smooth' });
      }
    }
  }

  function logKey() {
    var log = state.data.log || [];
    var last = log.length ? log[log.length - 1] : '';
    return log.length + ':' + (typeof last === 'string' ? last : JSON.stringify(last));
  }

  function updateLog() {
    var box = document.getElementById('log');
    if (!box) return;
    var key = logKey();
    if (key === state.lastLogKey) return;
    state.lastLogKey = key;
    box.innerHTML = '';
    var log = state.data.log || [];
    for (var i = 0; i < log.length; i++) {
      var entry = log[i];
      var text = typeof entry === 'string' ? entry
        : (entry && (entry.msg || entry.message || entry.text)) || JSON.stringify(entry);
      var line = el('div', 'log-line');
      line.textContent = text;
      box.appendChild(line);
    }
    box.scrollTop = box.scrollHeight;
  }

  // ---------------------------- Öffentliche API ---------------------------
  function initBoard() {
    var data = window.__boardData;
    if (!data || !data.fields) return;
    var board = document.getElementById('board');
    if (!board) return;

    state.data = data;
    state.fields = data.fields;
    board.innerHTML = '';

    // Der neue Stil gilt für ALLE Presets: eine horizontale, scrollbare
    // Feldleiste (kein Monopoly-Ring mehr). Footer/Flow identisch.
    var n = data.fields.length;
    board.classList.remove('board-16');
    board.classList.add('board-flex');
    var viewGame = document.getElementById('view-game');
    if (viewGame) viewGame.classList.add('is-flex');

    for (var i = 0; i < n; i++) {
      var f = data.fields[i] || { type: 'grundstueck', name: '—', price: 300000 };
      board.appendChild(buildField(i, f));
    }

    // Kopf-Banner über der Feldleiste: Presetname (Fallback 'Eigene Karte')
    {
      var flexHead = el('div', 'board-flex-head');
      flexHead.appendChild(el('div', 'bc-logo', 'STANTONOPOLY'));
      flexHead.appendChild(el('div', 'bc-sub', String((data && data.presetName) || 'Eigene Karte')));
      var wrapEl = board.parentElement;
      if (wrapEl) wrapEl.insertBefore(flexHead, board);
      else board.appendChild(flexHead);
    }

    // Token-Layer (über allen Feldern, nicht rotiert)
    var layer = el('div', 'tokens-layer');
    board.appendChild(layer);
    state.tokens = [];
    for (var pi = 0; pi < (data.players || []).length; pi++) {
      var t = el('div', 'token');
      t.style.setProperty('--team', data.players[pi].color || '#888');
      layer.appendChild(t);
      state.tokens.push(t);
    }

    state.built = true;

    // Skalierung + Resize
    setCellSize();
    if (window.ResizeObserver) {
      var wrap = board.parentElement;
      new ResizeObserver(setCellSize).observe(wrap || board);
    } else if (window.addEventListener) {
      window.addEventListener('resize', setCellSize);
    }

    renderBoard();
    wireFieldClicks();
  }

  // Grundstückskarten anklickbar: per Klick ein Info-Panel umschalten, das
  // Miete + Ausbaukosten je Ausbaustufe zeigt. Kein fixer "Max Stufe"-Text mehr.
  var RENT_MULT_ARRAY = { ALLEIN: 0.10, ALONE: 0.10, CYCLONE: 0.50, STORM: 1.00, BALLISTA: 2.00, ARMISTICE: 3.00 };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  // Live-Settings aus dem Spielzustand (per Preset) mit Fallback auf Defaults
  function liveSettings() {
    var s = (state && state.data && state.data.settings && typeof state.data.settings === 'object') ? state.data.settings : {};
    return {
      rentMult: s.rentMult || RENT_MULT_ARRAY,
      buildMult: s.buildMult || { CYCLONE: 0.25, STORM: 0.50, BALLISTA: 1.00, ARMISTICE: 1.50 }
    };
  }
  function rentMultFor(level) {
    var rm = liveSettings().rentMult;
    var v = rm[level] != null ? rm[level] : (RENT_MULT_ARRAY[level] != null ? RENT_MULT_ARRAY[level] : (RENT_MULT_ARRAY[level === 'ALLEIN' ? 'ALONE' : level] || 0));
    return v;
  }
  function buildMultFor(level) {
    var bm = liveSettings().buildMult;
    return (bm[level] != null) ? bm[level] : 0;
  }
  function fieldInfoHTML(f, armisticeOn) {
    if (!f) return '';
    var price = (typeof f.price === 'number') ? f.price : null;
    var html = '<button class="f-info-close" title="Schließen">✕</button>';
    html += '<div class="f-info-head">' + esc(f.name || 'Feld') + '</div>';
    if (price != null) {
      // --- Grundstücksinfos: Miete, Ausbaukosten, Hypothek/Abbau ---
      var order = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA'];
      if (armisticeOn) order.push('ARMISTICE');
      // Miete pro Stufe
      html += '<div class="f-info-divider">Miete</div>';
      order.forEach(function (lvl) {
        var rent = Math.round(price * rentMultFor(lvl));
        html += '<div class="f-info-row"><span>' + levelName(lvl) + '</span><em>' + fmt(rent) + ' uAEC</em></div>';
      });
      // Ausbaukosten pro Stufe
      html += '<div class="f-info-divider">Ausbaukosten</div>';
      order.forEach(function (lvl) {
        if (lvl === 'ALLEIN') return;
        var build = Math.round(price * buildMultFor(lvl));
        html += '<div class="f-info-row"><span>' + levelName(lvl) + '</span><i>' + fmt(build) + ' uAEC</i></div>';
      });
      // Hypothek & Abbau-Erlös
      html += '<div class="f-info-divider">Hypothek &amp; Abbau</div>';
      var hypothek = Math.round(price * 0.5);
      var totalBuild = 0;
      order.forEach(function (lvl) {
        if (lvl === 'ALLEIN') return;
        totalBuild += Math.round(price * buildMultFor(lvl));
      });
      var abbau = Math.round(totalBuild * 0.5);
      html += '<div class="f-info-row"><span>Hypothek (50 % Kaufpreis)</span><em>' + fmt(hypothek) + ' uAEC</em></div>';
      html += '<div class="f-info-row"><span>Abbau-Erlös (50 % Ausbau)</span><i>' + fmt(abbau) + ' uAEC</i></div>';
    } else if (f.type === 'los') {
      html += '<div class="f-info-body">Bonus <strong>+' + fmt(losBonus()) + ' uAEC</strong> bei Überquerung</div>';
    } else if (f.type === 'gundo' || f.type === 'ereignis') {
      var fee = (typeof f.fee === 'number') ? f.fee : 0;
      if (fee > 0) {
        html += '<div class="f-info-body">Gebühr <strong>' + fmt(fee) + ' uAEC</strong> bei Landung</div>';
      } else if (fee < 0) {
        html += '<div class="f-info-body">Bonus <strong>' + fmt(Math.abs(fee)) + ' uAEC</strong> bei Landung</div>';
      } else {
        html += '<div class="f-info-body">Kein Effekt</div>';
      }
    } else if (f.type === 'gefangnis') {
      var bail = (typeof f.fee === 'number') ? f.fee : 0;
      if (bail > 0) {
        html += '<div class="f-info-body">Lösegeld <strong>' + fmt(bail) + ' uAEC</strong></div>';
      } else {
        html += '<div class="f-info-body">Züge aussetzen</div>';
      }
    } else if (f.type === 'freiparken') {
      html += '<div class="f-info-body">Nichts passiert</div>';
    } else if (f.type === 'steuer') {
      var tax = (typeof f.fee === 'number') ? f.fee : 0;
      if (tax > 0) {
        html += '<div class="f-info-body">Zahle <strong>' + fmt(tax) + ' uAEC</strong></div>';
      } else {
        html += '<div class="f-info-body">Kein Betrag</div>';
      }
    }
    return html;
  }
  function wireFieldClicks() {
    var board = document.getElementById('board');
    if (!board) return;
    // ALLE Felder anklickbar, nicht nur Grundstücke
    var fields = board.querySelectorAll('.field');
    for (var k = 0; k < fields.length; k++) {
      var fd = fields[k];
      if (fd.getAttribute('data-wired') === '1') continue;
      fd.setAttribute('data-wired', '1');
      fd.addEventListener('click', function (e) {
        // ✕-Button schließt Overlay, ohne zu togglen
        if (e.target.classList.contains('f-info-close')) {
          var toggle = this.querySelector('[data-info-toggle]');
          if (toggle) {
            toggle.innerHTML = '';
            toggle.classList.add('hidden');
          }
          return;
        }
        var node = this;
        var toggle = node.querySelector('[data-info-toggle]');
        if (!toggle) return;
        var fid = Number(node.getAttribute('data-field-id'));
        var f = state.fields && state.fields[fid];
        if (!f) return;
        var armisticeOn = !!(state.data && state.data.armisticeEnabled);
        if (toggle.classList.contains('hidden')) {
          toggle.innerHTML = fieldInfoHTML(f, armisticeOn);
          toggle.classList.remove('hidden');
        } else {
          toggle.innerHTML = '';
          toggle.classList.add('hidden');
        }
      });
    }
  }

  function renderBoard() {
    var data = window.__boardData;
    if (!data || !state.built) return;
    state.data = data;
    updateActive();
    updateMarkers();
    layoutTokens();
    updateLog();
  }

  window.initBoard = initBoard;
  window.renderBoard = renderBoard;
})();
