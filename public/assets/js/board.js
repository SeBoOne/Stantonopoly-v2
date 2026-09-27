/* =========================================================================
   Stantonopoly V2 — board.js (F-Schale · Ansatz 2)
   Horizontale Scroll-Kartenreihe mit Scroll-Snap + Fortschritts-Indikator
   + Minikarte + "Zum aktiven Feld"-Sprung. Karten wachsen per fitPage()
   bis 264×480 (data-tall) und zeigen dann die Feld-Akte (Stufe/Band/Hypothek)
   im Karteninneren. Kein Demo-Badge — nur echte Felder.

   initBoard():   liest window.__boardData, rendert Kartenreihe + Header + Minikarte.
   renderBoard(): aktualisiert Token, Marker, aktives Feld, Progress, Log.
   Global: window.initBoard, window.renderBoard
   ========================================================================= */
(function () {
  'use strict';

  var RENT_MULT_ARRAY = { ALLEIN: 0.10, ALONE: 0.10, CYCLONE: 0.50, STORM: 1.00, BALLISTA: 2.00, ARMISTICE: 3.00 };
  var LEVEL_NAMES_DEFAULT = { ALLEIN: 'Standard', CYCLONE: 'Cyclone', STORM: 'Storm', BALLISTA: 'Ballista', ARMISTICE: 'Armistice Zone' };
  var LEVEL_ORDER = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA', 'ARMISTICE'];
  var FALLBACK_LOS_BONUS = 500000;
  var FALLBACK_GUNDO_FEE = 125000;

  var state = {
    built: false,
    fields: [],
    players: [],
    activeIdx: 0,
    data: null,
    cardEls: {},      // feldIdx -> card node
    markerEls: {},    // feldIdx -> {chip, card, lvlEl, rentEl, mortgagedEl, ownerEl}
    lastLogKey: ''
  };

  // ---------------------------- Helfer -----------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
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
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function levelNames() {
    if (state.data && state.data.levelNames && typeof state.data.levelNames === 'object') return state.data.levelNames;
    return LEVEL_NAMES_DEFAULT;
  }
  function levelName(level) {
    var m = levelNames();
    var n = m ? m[level] : null;
    return n || LEVEL_NAMES_DEFAULT[level] || level;
  }
  function losBonus() { return FALLBACK_LOS_BONUS; }
  function liveSettings() {
    var s = (state.data && state.data.settings && typeof state.data.settings === 'object') ? state.data.settings : {};
    return {
      rentMult: s.rentMult || RENT_MULT_ARRAY,
      buildMult: s.buildMult || { CYCLONE: 0.25, STORM: 0.50, BALLISTA: 1.00, ARMISTICE: 1.50 },
      mortgageMult: (typeof s.mortgageMult === 'number') ? s.mortgageMult : 0.75
    };
  }
  function rentMultFor(level) {
    var rm = liveSettings().rentMult;
    var v = rm[level] != null ? rm[level] : (RENT_MULT_ARRAY[level] != null ? RENT_MULT_ARRAY[level] : (RENT_MULT_ARRAY[level === 'ALLEIN' ? 'ALONE' : level] || 0));
    return v;
  }

  // Band-/Typ-Klassifizierung für die Farbband am Kartenkopf.
  function typeClass(f) {
    if (f.type === 'los') return 'is-los';
    if (f.type === 'gundo' || f.type === 'ereignis') return 'is-event';
    if (f.type === 'gefangnis') return 'is-jail';
    if (f.type === 'steuer') return 'is-steuer';
    if (f.type === 'freiparken') return 'is-freiparken';
    var p = (typeof f.price === 'number') ? f.price : 0;
    // (2k #5) Eigene Farbgruppe (Preset-Editor) → band-g<letter>; sonst Preisband-Fallback.
    var g = (typeof f.group === 'string' && f.group !== '') ? f.group : '';
    if (g) return 'band-g' + g.slice(0, 1).toUpperCase();
    return p <= 400000 ? 'band-400' : 'band-500';
  }
  function typeLabel(f) {
    var T = { los: 'LOS', 'gundo': 'GUNDO', ereignis: 'EREIGNIS', gefangnis: 'GEFÄNGNIS', freiparken: 'FREI PARKEN', steuer: 'STEUER' };
    return T[f.type] || 'FELD';
  }
  function feeText(f) {
    if (f.type === 'los') return 'Überquerung: +' + fmt(losBonus()) + ' aUEC';
    var fee = (typeof f.fee === 'number') ? f.fee : 0;
    if (f.type === 'gundo' || f.type === 'ereignis') return fee > 0 ? ('Gebühr ' + fmt(fee) + ' aUEC') : (fee < 0 ? ('Bonus ' + fmt(Math.abs(fee)) + ' aUEC') : 'Kein Effekt');
    if (f.type === 'gefangnis') return fee > 0 ? ('Lösegeld ' + fmt(fee) + ' aUEC') : 'Züge aussetzen';
    if (f.type === 'steuer') return fee > 0 ? ('Zahle ' + fmt(fee) + ' aUEC') : 'Kein Betrag';
    if (f.type === 'freiparken') return 'Nichts passiert';
    return '';
  }

  // ---------------------------- Karte bauen ------------------------------
  function buildCard(i, f) {
    var card = el('div', 'kcard ' + typeClass(f));
    card.setAttribute('data-field-id', String(i));
    card.setAttribute('data-field-type', f.type);

    var band = el('div', 'k-band', '');
    card.appendChild(band);
    var notch = el('div', 'k-notch', '');
    var top = el('div', 'k-top', '');
    top.appendChild(el('span', 'k-idx', String(i)));
    top.appendChild(el('span', 'k-type', typeLabel(f)));

    var name = el('div', 'kc-name', esc(f.name || ('Feld ' + i)));
    card.appendChild(top);
    card.appendChild(name);

    if (f.type === 'los' || f.type === 'gundo' || f.type === 'ereignis' || f.type === 'gefangnis' || f.type === 'steuer' || f.type === 'freiparken') {
      var price = el('div', 'kc-price', f.type === 'los' ? ('+' + fmt(losBonus())) : feeText(f));
      price.style.fontSize = '20px';
      card.appendChild(price);
    } else {
      card.appendChild(el('div', 'kc-price', fmt(f.price)));
      var rent = el('div', 'kc-rent', '');
      rent.appendChild(el('span', '', 'Miete: '));
      var rentV = el('em', 'k-rentval', '—');
      rent.appendChild(rentV);
      card.appendChild(rent);
      var own = el('div', 'kc-own', '');
      var ownV = el('span', 'k-ownval', '—');
      own.appendChild(ownV);
      card.appendChild(own);
    }

    // Feld-Akte (nur sichtbar bei data-tall): nur die Ausbaustufe. Band steht
        // bereits als Farbstreifen am Kartenkopf (k-band), Hypothek entfällt.
        // (2h#4) kc-akte NUR bei Grundstücken rendern — Ereignis/Gefängnis/Steuer/
        // Frei Parken/Los haben keine Ausbaustufen-Akte.
        if (f.type === 'grundstueck') {
          var akte = el('div', 'kc-akte', '');
          akte.appendChild(el('div', 'kv', '<span class="t-lbl">Ausbaustufe</span><strong class="k-ak-lvl">' + esc(levelName('ALLEIN')) + '</strong>'));
          card.appendChild(akte);
        }

        // (2h#3) Feld-Info-Layer: Klick auf die Karte blendet Kosten/Mieten je Stufe
        // ein (Grundstück) bzw. nur die Gebühr (Fee-Felder). Zweiter Klick / ✕ /
        // Klick außerhalb schließt. Wird von wireCardClicks befüllt.
        var info = el('div', 'kc-info', '');
        info.setAttribute('data-info', '1');
        card.appendChild(info);

        // Token-Reihe am unteren Kartenrand
        var tok = el('div', 'kc-tok', '');
        card.appendChild(tok);
        card.appendChild(el('div', 'k-notch', ''));

        state.markerEls[i] = {
          card: card,
          tok: tok,
          rentEl: card.querySelector('.k-rentval'),
          ownEl: card.querySelector('.k-ownval'),
          akLvl: card.querySelector('.k-ak-lvl')
        };
        return card;
      }

  // ---------------------------- Minikarte / Progress ----------------------
  function buildMiniMap() {
    var mini = document.getElementById('mini-map');
    if (!mini) return;
    mini.innerHTML = '';
    state.fields.forEach(function (f, i) {
      var b = el('button', '');
      b.setAttribute('data-mini-idx', String(i));
      b.title = String(i) + ' · ' + (f.name || '');
      b.addEventListener('click', function () { scrollToCard(i); });
      mini.appendChild(b);
    });
  }
  function scrollToCard(i) {
    var row = document.getElementById('board-row');
    if (!row) return;
    var card = row.querySelector('.kcard[data-field-id="' + i + '"]');
    if (!card) return;
    row.scrollTo({ left: card.offsetLeft - row.clientWidth / 2 + card.offsetWidth / 2, behavior: 'smooth' });
  }
  function gotoActive() {
    var p = state.players[state.activeIdx];
    if (p && p.pos != null) scrollToCard(p.pos);
  }

  // ---------------------------- Skalierung (fitPage) ----------------------
  // Kartenhöhe aus der freien Fensterhöhe ableiten (bis 480 px, data-tall=1),
  // damit unter der Reihe kein toter Streifen bleibt.
  function fitPage() {
    var row = document.getElementById('board-row');
    if (!row) return;
    var boardCol = row.closest('.board-col');
    var bar = boardCol ? boardCol.querySelector('.boardbar') : null;
    var maps = document.getElementById('mini-map') || null;
    // Freie Höhe = Fenster − Kopf (Header) − Actionbar − Ticker − Leisten oberhalb
    var availH = window.innerHeight - 120 - 56 - 58;
    if (bar) availH -= bar.offsetHeight || 0;
    if (maps) availH -= 30;
    availH -= 30; // padding
    // Höhe auf 180–480 begrenzen
    var h = Math.max(180, Math.min(480, availH));
    var minH = 280; // Schwellwert, ab dem die Karte "hoch" (Feld-Akte) wird
    row.style.setProperty('--card-h', h + 'px');
    row.setAttribute('data-tall', h >= minH ? '1' : '0');
  }

  // ---------------------------- Tokens ------------------------------------
  function renderTokens(fieldIdx) {
    var mm = state.markerEls[fieldIdx];
    if (!mm || !mm.tok) return;
    mm.tok.innerHTML = '';
    var present = state.players.filter(function (p) { return p.pos == fieldIdx; });
    present.forEach(function (p) {
      // Jede Team-EIGENE Farbe + eigener Buchstabe (Anfangsbuchstabe des Schiffnamens).
      var ship = p.ship || p.teamName || '';
      var letter = (ship.replace(/^team\s+/i, '').trim() || '•').charAt(0).toUpperCase();
      var t = el('span', 'tok', '');
      t.textContent = letter;
      t.title = p.teamName || '';
      t.style.background = p.color || '#888';
      mm.tok.appendChild(t);
    });
  }

  // ---------------------------- Marker / Aktives Feld ---------------------
  function updateMarkers() {
    var i;
    for (i in state.markerEls) {
      var mm = state.markerEls[i];
      if (mm.card) mm.card.classList.remove('is-mortgaged');
      if (mm.ownEl) mm.ownEl.textContent = '—';
      if (mm.rentEl) mm.rentEl.textContent = '—';
      if (mm.akLvl) mm.akLvl.textContent = levelName('ALLEIN');
      if (mm.card) mm.card.classList.remove('has-owner');
      renderTokens(Number(i));
    }
    state.players.forEach(function (player, pi) {
      var props = player.properties || {};
      for (var fid in props) {
        var m = state.markerEls[Number(fid)];
        if (!m) continue;
        var own = props[fid];
        var level = (own && typeof own === 'object') ? own.level : own;
        var mortgaged = !!(own && typeof own === 'object' && own.mortgaged);
        if (m.card) m.card.classList.add('has-owner'); // (2i #9) Preis ausblenden
        if (m.card && mortgaged) m.card.classList.add('is-mortgaged');
        if (m.ownEl) m.ownEl.textContent = player.teamName || '';
        var price = (state.fields[Number(fid)] && typeof state.fields[Number(fid)].price === 'number') ? state.fields[Number(fid)].price : 0;
        if (m.rentEl && price) m.rentEl.textContent = fmt(Math.round(price * rentMultFor(level))) + ' aUEC';
        if (m.akLvl) m.akLvl.textContent = levelName(level);
      }
    });
  }
  function updateActive() {
    var board = document.querySelector('#board-row');
    var i;
    for (i in state.markerEls) if (state.markerEls[i].card) state.markerEls[i].card.classList.remove('is-active');
    if (board) {
      board.querySelectorAll('.kcard.is-active').forEach(function (c) { c.classList.remove('is-active'); });
    }
    if (state.players[state.activeIdx] && state.players[state.activeIdx].pos != null) {
      var fEl = board ? board.querySelector('.kcard[data-field-id="' + state.players[state.activeIdx].pos + '"]') : null;
      if (fEl) fEl.classList.add('is-active');
    }
    // (2i #4) Auto-Scroll: bei Zugwechsel (Zugbeginn) und nach dem Würfeln (Position
    // des aktiven Teams hat sich geändert) automatisch zum aktiven Feld scrollen.
    var actP = state.players[state.activeIdx] || {};
    var actKey = state.activeIdx + ':' + (actP.pos != null ? actP.pos : -1);
    if (state._lastActiveKey !== actKey && state._builtOnce) {
      if (actP.pos != null) scrollToCard(actP.pos);
    }
    state._lastActiveKey = actKey;
    state._builtOnce = true;
    // Minikarte aktiv markieren
    var mini = document.getElementById('mini-map');
    if (mini) {
      var actPos = state.players[state.activeIdx] ? state.players[state.activeIdx].pos : null;
      mini.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('is-active', Number(b.getAttribute('data-mini-idx')) === actPos);
      });
    }
    // Boardbar: nur "Aktives Team" (Teamname, keine Feldposition/Zug/Phase).
    var p = state.players[state.activeIdx];
    var setEl = function (id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt; };
    setEl('bb-active', p ? (p.teamName || '?') : '—');
    // Eigene-Zug-Auszeichnung ("DU BIST AM ZUG"), falls das eigene Team am Zug ist.
    var myIdx = (state.data && state.data.myIdx != null) ? state.data.myIdx : -1;
    var bar = document.querySelector('.boardbar');
    if (bar) {
      var badge = bar.querySelector('.bb-myturn-badge');
      var isMine = (myIdx >= 0 && myIdx === state.activeIdx);
      bar.classList.toggle('bb-myturn', isMine);
      if (isMine && !badge) {
        var b = document.createElement('span');
        b.className = 'bb-myturn-badge';
        b.textContent = '◈ DU BIST AM ZUG';
        bar.querySelector('.bb-r').appendChild(b);
      } else if (!isMine && badge) {
        badge.remove();
      }
    }
    // Zug-Timer-Restzeit anzeigen (falls GM einen Timer gesetzt hat).
    var timerEl = document.getElementById('bb-timer');
    if (timerEl) {
      var stat = timerEl.closest('.bb-stat');
      var dead = state.data && state.data.turnDeadline;
      if (stat && dead && dead > 0) {
        var remain = Math.max(0, Math.ceil((dead - Date.now()) / 1000));
        timerEl.textContent = String(remain) + 's';
        stat.classList.remove('hidden');
      } else if (stat) {
        stat.classList.add('hidden');
      }
    }
  }

  // ---------------------------- Log (Ticker) ------------------------------
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
    // Neueste zuerst: Einträge von hinten einsetzen; der Ticker (row-reverse)
    // zeigt den neuesten rechts und ältere laufen links aus dem (verborgenen) Rand.
    var frag = document.createDocumentFragment();
    for (var i = log.length - 1; i >= 0; i--) {
      var entry = log[i];
      var text = typeof entry === 'string' ? entry : (entry && (entry.msg || entry.message || entry.text)) || JSON.stringify(entry);
      var line = document.createElement('span');
      line.className = 'tick';
      line.textContent = text;
      frag.appendChild(line);
    }
    box.appendChild(frag);
    box.scrollLeft = 0;
  }

  // ---------------------------- Feld-Info (Klick) -------------------------
    // (2h#3) Klick auf eine Feldkarte blendet Kosten/Mieten je Stufe ein.
    // Grundstück: Grundpreis, Miete je Ausbaustufe (alle level), Baukosten je
    // Stufe, Hypothekswert. Fee-Felder: nur die Gebühr. Zweiter Klick / ✕ /
    // Klick außerhalb schließt.
    function buildCostFor(price, level) {
      var bm = liveSettings().buildMult;
      var v = bm[level] != null ? bm[level] : 0;
      return Math.round(price * v);
    }
    function fieldInfoHTML(f) {
      if (!f) return '';
      var price = (typeof f.price === 'number') ? f.price : null;
      var html = '<div class="t-lbl" style="margin-bottom:6px">' + esc(f.name || 'Feld') + '</div>';
      if (f.type === 'grundstueck' && price != null) {
        var order = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA'];
        if (state.data && state.data.armisticeEnabled) order.push('ARMISTICE');
        html += '<div class="kv" style="border-top:2px solid var(--line);padding-top:6px"><span class="t-lbl">Grundpreis</span><strong>' + fmt(price) + ' aUEC</strong></div>';
        html += '<div class="kv" style="border-top:2px solid var(--line);padding-top:6px"><span class="t-lbl">Miete je Stufe</span></div>';
        order.forEach(function (lvl) {
          var rent = Math.round(price * rentMultFor(lvl));
          html += '<div class="kv"><span class="t-lbl">' + esc(levelName(lvl)) + '</span><strong>' + fmt(rent) + ' aUEC</strong></div>';
        });
        html += '<div class="kv" style="border-top:2px solid var(--line);padding-top:6px"><span class="t-lbl">Baukosten je Stufe</span></div>';
        order.forEach(function (lvl) {
          if (lvl === 'ALLEIN') return;
          var cost = buildCostFor(price, lvl);
          html += '<div class="kv"><span class="t-lbl">→ ' + esc(levelName(lvl)) + '</span><strong>' + fmt(cost) + ' aUEC</strong></div>';
        });
        var mortg = Math.round(price * liveSettings().mortgageMult);
        html += '<div class="kv" style="border-top:2px solid var(--line);padding-top:6px"><span class="t-lbl">Hypothekswert</span><strong>' + fmt(mortg) + ' aUEC</strong></div>';
      } else {
        // Fee-Felder: nur die Gebühr/Bonus anzeigen.
        html += '<div class="kv" style="border-top:2px solid var(--line);padding-top:6px"><span class="t-lbl">Effekt</span><strong>' + esc(feeText(f)) + '</strong></div>';
      }
      return html;
    }
    function closeFieldInfo() {
      var row = document.getElementById('board-row');
      if (!row) return;
      row.querySelectorAll('.kcard.is-info-open').forEach(function (c) { c.classList.remove('is-info-open'); });
    }
    function wireCardClicks() {
      var row = document.getElementById('board-row');
      if (!row) return;
      // (2h#2) Wheel-Scroll der Feldreihe robust: passive:false-Handler mit sauberem
      // scrollLeft-Handling UND Scroll-Snap während der Interaktion deaktivieren
      // (CSS-Klasse is-wheel-scrolling → scroll-snap-type:none), nach 150 ms Idle
      // wieder aktivieren. Verhindert, dass der Snap-Point zurückschnappt.
      if (row.getAttribute('data-wheel') !== '1') {
        row.setAttribute('data-wheel', '1');
        var wheelTimer = null;
        row.addEventListener('wheel', function (e) {
          e.preventDefault();
          row.classList.add('is-wheel-scrolling');
          row.scrollLeft += e.deltaY;
          if (wheelTimer) clearTimeout(wheelTimer);
          wheelTimer = setTimeout(function () { row.classList.remove('is-wheel-scrolling'); }, 150);
        }, { passive: false });
      }
      row.querySelectorAll('.kcard').forEach(function (card) {
        if (card.getAttribute('data-wired')) return;
        card.setAttribute('data-wired', '1');
        card.addEventListener('click', function (ev) {
          // Klick auf den ✕-Close im Info-Layer schließt nur (kein Re-Toggle).
          if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-info-close')) {
            card.classList.remove('is-info-open');
            return;
          }
          var fid = Number(card.getAttribute('data-field-id'));
          var f = state.fields[fid];
          if (!f) return;
          // Karte "hochschalten" (Feld-Akte sichtbar) und in den sichtbaren Bereich holen.
          row.setAttribute('data-tall', '1');
          row.style.setProperty('--card-h', '480px');
          scrollToCard(fid);
          // Info-Layer togglen: zweiter Klick schließt.
          var wasOpen = card.classList.contains('is-info-open');
          closeFieldInfo();
          if (!wasOpen) {
            var infoEl = card.querySelector('.kc-info');
            if (infoEl) {
              infoEl.innerHTML = fieldInfoHTML(f) +
                '<button type="button" class="btn btn-xs btn-ghost kc-info-close" data-info-close="1">✕ Schließen</button>';
              card.classList.add('is-info-open');
            }
          }
        });
      });
      // Klick außerhalb einer Karte schließt das Info-Layer.
      if (row.getAttribute('data-outside') !== '1') {
        row.setAttribute('data-outside', '1');
        document.addEventListener('click', function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest('.kcard')) return;
          closeFieldInfo();
        });
      }
    }

  // ---------------------------- Öffentliche API ---------------------------
  function initBoard() {
    var data = window.__boardData;
    if (!data || !data.fields) return;
    var row = document.getElementById('board-row');
    if (!row) return;

    state.data = data;
    state.fields = data.fields;
    state.players = data.players || [];
    state.activeIdx = data.activeIdx;
    state.markerEls = {};
    row.innerHTML = '';

    state.fields.forEach(function (f, i) {
      var card = buildCard(i, f || { type: 'grundstueck', name: '—', price: 300000 });
      row.appendChild(card);
    });

    buildMiniMap();
    state.built = true;
    fitPage();
    if (window.ResizeObserver) {
      var grid = row.closest('.gamewrap') || row;
      new ResizeObserver(fitPage).observe(grid);
    } else if (window.addEventListener) {
      window.addEventListener('resize', fitPage);
    }

    // "Zum aktiven Feld"-Button
    var gotoBtn = document.getElementById('btn-goto-active');
    if (gotoBtn) { gotoBtn.onclick = null; gotoBtn.addEventListener('click', gotoActive); }

    renderBoard();
    wireCardClicks();
  }

  function renderBoard() {
    var data = window.__boardData;
    if (!data || !state.built) return;
    state.data = data;
    state.players = data.players || [];
    state.activeIdx = data.activeIdx;
    state.fields = data.fields;
    updateActive();
    updateMarkers();
    updateLog();
  }

  function setScaleInfo() {
    var info = document.getElementById('scale-info');
    if (info) info.textContent = 'Felder: ' + (state.fields.length || 0);
  }

  window.initBoard = initBoard;
  window.renderBoard = renderBoard;
  window.setScaleInfo = setScaleInfo;
})();