/**
 * Stantonopoly V2 — Engine (server-authoritativ)
 * Portiert von V1 game.js auf CommonJS. Reine Spiellogik-Engine: KEIN DOM,
 * keine Abrechnung im Frontend. Alles Geld-/Positions-/Eigentumslogik läuft hier
 * und ist die einzige Wahrheit.
 *
 * Team = ein "Player" in der Engine (ein Token, ein Budget, eine aktive Position).
 *
 * Abhängigkeit: ./data.js (Datenquelle/Formeln/Presets).
 */
'use strict';

const D = require('./data.js');

// Bautreihenfolge der Stufen (Armistice nur bei aktivierter Armistice-Regel).
const LEVEL_ORDER = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA', 'ARMISTICE'];

/* ---------------- Interne Hilfsfunktionen ---------------- */

function fmt(n) {
  const neg = n < 0;
  let s = String(Math.abs(Math.round(n)));
  let out = '';
  while (s.length > 3) {
    out = '.' + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  return (neg ? '-' : '') + s + out;
}

function log(game, msg) {
  game.log.push(msg);
}

function fieldName(game, idx) {
  const f = (game && game.fields && game.fields[idx]) ? game.fields[idx] : null;
  return f ? f.name : ('Feld ' + idx);
}

// Normalisiert ein Feld (aus Preset/Auer config) und berechnet die Miet-/Baukarten.
// (2m #3) Kanonische Keys der 10 Farbgruppen (+ Legacy-Buchstaben A–F aus Runde 2k).
// Dient der normalisierten Farbgruppen-Zugehörigkeit in der Engine.
const STAN_GROUP_KEYS = ['blau', 'gruen', 'rot', 'violett', 'orange', 'tuerkis', 'gold', 'pink', 'schwarz', 'weiss'];
const STAN_GROUP_LEGACY = { A: 'rot', B: 'orange', C: 'gruen', D: 'blau', E: 'violett', F: 'gold' };
function normalizeGroupKey(g) {
  if (!g) return null;
  const k = String(g);
  if (STAN_GROUP_KEYS.indexOf(k) !== -1) return k;
  const up = k.toUpperCase();
  if (STAN_GROUP_LEGACY[up]) return STAN_GROUP_LEGACY[up];
  return STAN_GROUP_KEYS[0]; // Fallback (nie fehlerhaft)
}

function normalizeField(f) {
  if (!f || typeof f !== 'object') return { type: 'los', name: 'Feld', price: 0 };
  // 'gundo' ist der alte Name des Ereignis-Feldtyps (Steuerfeld); beides wird zu 'ereignis'.
  const rawType = f.type === 'gundo' ? 'ereignis' : f.type;
  const VALID = ['grundstueck', 'los', 'ereignis', 'gefangnis', 'freiparken', 'steuer'];
  const out = {
    type: VALID.indexOf(rawType) !== -1 ? rawType : 'los',
    name: String(f.name || 'Feld')
  };
  const price = Number(f.price);
  if (Number.isFinite(price) && price >= 0) {
    out.price = Math.round(price);
    out.tabelle = D.tabelleFor(out.price);
  }
  // (2m #3) Farbgruppe (nur Grundstücke). Kanonische Keys => gültige STAN_COLORS.
  if (out.type === 'grundstueck' && f.group !== undefined && f.group !== null && String(f.group) !== '') {
    out.group = normalizeGroupKey(String(f.group));
  }
  // Individuelle Sonderwerte: Los-Bonus, Ereignis-Gebühr/Bonus, Gefängnis-Lösegeld, Steuer-Betrag
  const bonus = Number(f.bonus);
  if (out.type === 'los' && Number.isFinite(bonus)) out.bonus = Math.round(bonus);
  const fee = Number(f.fee);
  if ((out.type === 'ereignis' || out.type === 'steuer' || out.type === 'gefangnis') && Number.isFinite(fee)) out.fee = Math.round(fee);
  const turns = Number(f.turns);
  if (out.type === 'gefangnis' && Number.isFinite(turns) && turns >= 0) out.turns = Math.round(turns);
  return out;
}

function ownerOf(game, fieldIdx) {
  for (let i = 0; i < game.players.length; i++) {
    if (game.players[i].properties[fieldIdx] !== undefined) return game.players[i];
  }
  return null;
}

function aliveCount(game) {
  let n = 0;
  for (let i = 0; i < game.players.length; i++) if (!game.players[i].bankrupt) n++;
  return n;
}

// ---------------------------------------------------------------------
// (2m-A) Vermögenswert eines Teams: Guthaben + Summe der Grundstückswerte
// INKL. Ausbauwert. Für Hypotheken-belastete Felder zählt NUR 10 % ihres
// Werts. Reine Funktion (unit-testbar), ohne game-Mutation.
// ---------------------------------------------------------------------
function propertyWorth(game, fieldIdx, own) {
  const f = (game && game.fields && game.fields[fieldIdx]) ? game.fields[fieldIdx] : null;
  if (!f || f.type !== 'grundstueck') return 0;
  const base = (typeof f.price === 'number') ? f.price : 0;
  const level = (own && own.level) || 'ALLEIN';
  // Ausbauwert = Summe der Baukosten aller erreichten Ausbaustufen (jede Stufe
  // wird beim Bauen separat bezahlt; ALLEIN kostet nichts).
  let build = 0;
  const li = LEVEL_ORDER.indexOf(level);
  if (li > 0) {
    for (let s = 1; s <= li; s++) {
      try { build += D.buildCost(base, LEVEL_ORDER[s], game.settings) || 0; } catch (e) { /* ignorieren */ }
    }
  }
  const total = base + build;
  if (own && own.mortgaged) return Math.round(total * 0.10); // nur 10 %
  return total;
}

function teamWealth(game, playerIdx) {
  const p = game.players[playerIdx];
  if (!p) return 0;
  let w = (typeof p.budget === 'number') ? p.budget : 0;
  const props = p.properties || {};
  for (const fid in props) w += propertyWorth(game, Number(fid), props[fid]);
  return Math.round(w);
}

// Index des reichsten (nicht bankrotten) Teams; -1 falls keines aktiv.
function richestTeamIdx(game) {
  let best = -1;
  let bestW = -Infinity;
  for (let i = 0; i < game.players.length; i++) {
    if (game.players[i].bankrupt) continue;
    const w = teamWealth(game, i);
    if (w > bestW) { bestW = w; best = i; }
  }
  return best;
}


// true wenn vollständig gezahlt, false wenn der Zahler den Betrag nicht decken kann.
// Regel (Sebo): Der Gläubiger erhält immer die VOLLE Summe; der Schuldner geht ins
// Minus (Budget negativ) und muss die offene Schuld (debt) bis zum Zugende tilgen,
// sonst Bankrott. Bei to=null (Bank/Steuer) geht der Fehlbetrag als Schuld an die Bank.
function pay(game, from, to, amount, why) {
  const push = StantonopolyGame.ledgerPush;
  if (from.budget >= amount) {
    from.budget -= amount;
    if (to) to.budget += amount;
    push(game, from, -amount, why);
    if (to) push(game, to, amount, why);
    return true;
  }
  // Nicht genug: Gläubiger erhält trotzdem den vollen Betrag, der Schuldner
  // überzieht das Konto (geht ins Minus) und muss sanieren.
  const shortfall = amount - from.budget;   // Fehlbetrag = offene Schuld
  from.budget -= amount;                    // kann negativ werden
  if (to) to.budget += amount;
  push(game, from, -amount, why);
  if (to) push(game, to, amount, why);
  from.insolvent = true;
  from.debt = shortfall;
  from.creditorIdx = to ? game.players.indexOf(to) : null;
  log(game, from.name + ' kann ' + why + ' nicht decken (' + fmt(amount) + ') → überzieht Konto auf ' + fmt(from.budget) + ', offene Schuld ' + fmt(shortfall) + '. Vor dem Zugende sanieren!');
  return false;
}

// Gutschrift-Einnahme (Sanierungserlös o.ä.): hebt das Konto wieder an.
// Das Rückzahlungs-Bookkeeping zum Gläubiger hat pay() beim Überziehen bereits
// erledigt (dem Gläubiger wurde die volle Summe gutgeschrieben, das Konto des
// Schuldners ins Minus gefahren). Sanierung = Konto wieder positiv machen.
function creditEarnings(game, p, amount, why) {
  const push = StantonopolyGame.ledgerPush;
  p.budget += amount;
  push(game, p, amount, why);
  if (p.debt > 0) log(game, p.name + ' erhält ' + fmt(amount) + ' aus „' + why + '“ → baut überzogenes Konto ab.');
}

function checkWin(game) {
  if (game.over) return;
  const alive = game.players.filter((p) => !p.bankrupt);
  if (alive.length === 1) {
    game.over = true;
    game.winnerInfo = alive[0];
    alive[0].winner = true;
    log(game, 'Sieg: ' + alive[0].name + ' ist der letzte aktive Spieler und gewinnt das Spiel!');
  }
}

function nextIdx(game, from) {
  const n = game.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    if (!game.players[idx].bankrupt) return idx;
  }
  return from;
}

function attachMethods(game) {
  game.current = function () { return StantonopolyGame.current(game); };
  game.roll = function () { return StantonopolyGame.roll(game); };
  game.buy = function () { return StantonopolyGame.buy(game); };
  game.skip = function () { return StantonopolyGame.skip(game); };
  game.bail = function () { return StantonopolyGame.bail(game); };
  game.jailStay = function () { return StantonopolyGame.jailStay(game); };
  game.build = function (fieldIdx) { return StantonopolyGame.build(game, fieldIdx); };
  game.mortgage = function (fieldIdx) { return StantonopolyGame.mortgage(game, fieldIdx); };
  game.unmortgage = function (fieldIdx) { return StantonopolyGame.unmortgage(game, fieldIdx); };
  game.demolish = function (fieldIdx) { return StantonopolyGame.demolish(game, fieldIdx); };
  game.forfeit = function () { return StantonopolyGame.forfeit(game); };
  game.forfeitTeam = function (teamIdx) { return StantonopolyGame.forfeitTeam(game, teamIdx); };
  game.sellProperty = function (fieldIdx, buyerIdx, price) { return StantonopolyGame.sellProperty(game, fieldIdx, buyerIdx, price); };
  game.auctionField = function (fieldIdx, bids) { return StantonopolyGame.auctionField(game, fieldIdx, bids); };
  game.makeOffer = function (opts) { return StantonopolyGame.makeOffer(game, opts); };
  game.respondOffer = function (offerId, accept) { return StantonopolyGame.respondOffer(game, offerId, accept); };
  game.startAuction = function (opts) { return StantonopolyGame.startAuction(game, opts); };
  game.bidAuction = function (bidderIdx, amount) { return StantonopolyGame.bidAuction(game, bidderIdx, amount); };
  game.resolveAuction = function (accept) { return StantonopolyGame.resolveAuction(game, accept); };
  game.resolveInsolvency = function (playerIdx) { return StantonopolyGame.resolveInsolvency(game, playerIdx); };
  game.nextTurn = function () { return StantonopolyGame.nextTurn(game); };
  game.serialize = function () { return StantonopolyGame.serialize(game); };
  // (2m-A) Vermögenswert-Helper (Server-Auto-Beenden)
  game.teamWealth = function (playerIdx) { return teamWealth(game, playerIdx); };
  game.richestTeamIdx = function () { return richestTeamIdx(game); };
  return game;
}

const StantonopolyGame = {
  D: D,
  LEVEL_ORDER: LEVEL_ORDER,

  createGame: function (config) {
    if (!config || !config.data) {
      throw new Error('createGame: config.data fehlt');
    }
    config = config || {};
    const data = config.data;
    const startingCapital = (typeof config.startingCapital === 'number' && isFinite(config.startingCapital))
      ? config.startingCapital
      : data.DEFAULT_CAPITAL;
    // Felder des gewählten Presets; Fallback auf Standard-Preset.
    const fields = (Array.isArray(config.fields) && config.fields.length)
      ? config.fields.map(normalizeField)
      : (D.PRESETS['Crusader Cluster'] ? D.PRESETS['Crusader Cluster'].fields.map(normalizeField) : []);

    const players = (config.players || []).map((p) => {
      return {
        id: p.id,
        name: p.name,
        ship: p.ship,
        task: p.task,
        budget: startingCapital,
        pos: 0,
        properties: {}, // fieldId -> { level }
        ledger: [],     // Cashflow-Verlauf
        bankrupt: false,
        winner: false,
        jailed: false,      // im Gefängnis (überspringt Züge)
        jailTurns: 0,       // verbleibende Züge im Gefängnis (0 = frei)
        insolvent: false,   // Zahlungsrückstand → muss vor Zugende sanieren
        debt: undefined,    // offene Schuld (Zahlungsrückstand)
        creditorIdx: undefined // wem geschuldet (null = an die Bank)
      };
    });

    const game = {
      data: data,
      fields: fields,
      players: players,
      activeIdx: 0,
      over: false,
      winnerInfo: null,
      diceConfig: config.diceConfig || { kind: '1w6' },
      armisticeEnabled: !!config.armisticeEnabled,
      levelNames: (config.levelNames && typeof config.levelNames === 'object') ? config.levelNames : null,
      settings: D.mergeSettings(config.settings),
      rolled: false,          // true = in diesem Zug wurde bereits gewürfelt (Sperre)
      canBuy: false,          // true = der Spieler kann nach dem Wurf das Feld kaufen
      offers: [],             // offene Handels-Angebote (Verkauf/Kauf) je Team
      auction: null,          // aktive Versteigerung (ein Besitzer versteigert sein Feld)
      forfeitPoll: null,      // Aufgeben-Abstimmung (Mitglieder-Votes; rooms verwaltet sie)
      turnSeconds: Math.max(0, Math.round(Number(config.turnSeconds) || 0)), // (2g#17) Zug-Timer in s
      turnDeadline: Number(config.turnDeadline) || 0,                        // Server-Zeitstempel Ablauf
      log: []
    };

    log(game, 'Neues Spiel gestartet mit ' + players.length + ' Spieler(n). Startkapital: ' + fmt(startingCapital) + '.');
    return attachMethods(game);
  },

  current: function (game) {
    return game.players[game.activeIdx];
  },

  roll: function (game) {
    if (game.rolled) {
      log(game, 'Würfeln nicht möglich: in diesem Zug wurde bereits gewürfelt.');
      return { err: 'ALREADY_ROLLED' };
    }
    const p = game.players[game.activeIdx];
    const cfg = game.diceConfig;

    let sum;
    let detail;
    if (cfg.kind === '1w6') {
      sum = 1 + Math.floor(Math.random() * 6);
      detail = '(' + sum + ')';
    } else if (cfg.kind === '2w6') {
      const a = 1 + Math.floor(Math.random() * 6);
      const b = 1 + Math.floor(Math.random() * 6);
      sum = a + b;
      detail = '(' + a + ' + ' + b + ')';
    } else if (cfg.kind === 'frei') {
      if (typeof cfg.freeValue === 'number' && isFinite(cfg.freeValue)) {
        sum = cfg.freeValue;
        detail = '(frei: ' + sum + ')';
      } else {
        const c = 1 + Math.floor(Math.random() * 6);
        const d = 1 + Math.floor(Math.random() * 6);
        sum = c + d;
        detail = '(frei-Zufall: ' + c + ' + ' + d + ')';
      }
    } else {
      sum = 1 + Math.floor(Math.random() * 6);
      detail = '(' + sum + ')';
    }

    const from = p.pos;
    const total = from + sum;
    let lapBonus = 0;
    const lap = (total >= game.fields.length);
    if (lap) {
      // Orison überqueren: + Los-Bonus (individuell je Feld0, sonst global).
      // KEINE Gundo/Ereignis-Gebühr mehr — Ereignis-Felder wirken nur bei Landung.
      const losField = game.fields[0];
      const losBonus2 = (losField && typeof losField.bonus === 'number') ? losField.bonus : game.data.LOS_PASS_BONUS;
      lapBonus = losBonus2;
      p.budget += lapBonus;
      log(game, p.name + ' überquert Orison (LOS) → + ' + fmt(lapBonus) + ' Bonus.');
      this.ledgerPush(game, p, lapBonus, 'Orison-Bonus');
    }
    const to = total % game.fields.length;
    p.pos = to;

    const landingField = game.fields[to];
    const landing = {
      idx: to,
      type: landingField.type,
      name: landingField.name,
      price: (typeof landingField.price === 'number') ? landingField.price : undefined
    };

    log(game, p.name + ' würfelt ' + detail + ' → bewegt sich von ' + from + ' nach ' + to + ' (' + landingField.name + ').');

    const events = [];
    let canBuy = false;
    let turnPassed = false; // true = Aufrufer kann direkt nextTurn()

    if (game.over) {
      turnPassed = true;
    } else if (p.bankrupt) {
      turnPassed = true;
    } else if (landingField.type === 'grundstueck') {
      const owner = ownerOf(game, to);
      if (owner === null) {
        if (p.budget >= landingField.price) {
          canBuy = true;
          log(game, p.name + ' landet auf freiem Grundstück „' + landingField.name + '“ (Kauf möglich – ' + fmt(landingField.price) + ') → Kaufentscheidung erforderlich.');
          events.push('Kauf möglich auf „' + landingField.name + '“ (' + fmt(landingField.price) + ')');
        } else {
          log(game, p.name + ' landet auf freiem Grundstück „' + landingField.name + '“ kann es aber nicht kaufen (Budget ' + fmt(p.budget) + ' < ' + fmt(landingField.price) + ') → Zug weiter.');
          turnPassed = true;
        }
      } else if (owner === p) {
        log(game, p.name + ' landet auf eigenem Grundstück „' + landingField.name + '“ → nichts zu tun, weiter.');
        turnPassed = true;
      } else {
        const level = owner.properties[to].level;
        const rent = game.data.rentFor(landingField.price, level, game.settings);
        log(game, p.name + ' landet auf fremdem Grundstück „' + landingField.name + '“ (Besitzer: ' + owner.name + ', Stufe ' + level + ') → Miete ' + fmt(rent) + '.');
        const ok = pay(game, p, owner, rent, 'Miete für „' + landingField.name + '“');
        events.push('Miete ' + fmt(rent) + ' an ' + owner.name);
        if (!ok) {
          turnPassed = true;
        } else {
          log(game, owner.name + ' erhält ' + fmt(rent) + ' Miete.');
          turnPassed = true;
        }
      }
    } else if (landingField.type === 'los') {
      log(game, p.name + ' landet auf „' + landingField.name + '“ (LOS) → nichts zu tun, weiter.');
      turnPassed = true;
    } else if (landingField.type === 'freiparken') {
      // Frei Parken: neutrales Feld — nichts passiert.
      log(game, p.name + ' landet auf „' + landingField.name + '“ (Frei Parken) → nichts zu tun.');
      events.push('Frei Parken');
      turnPassed = true;
    } else if (landingField.type === 'gefangnis') {
      // Gefängnis: Landung setzt den Spieler ins Gefängnis. Überspringt danach
      // jailTurns Züge (Standard 1). Wenn ein Lösegeld (fee) definiert ist, wird
      // dem Spieler die WAHL angeboten (Client-Modal): freikaufen oder absitzen.
      const bail = (typeof landingField.fee === 'number') ? landingField.fee : 0;
      const jailTurnsF = (typeof landingField.turns === 'number') ? landingField.turns : 1;
      if (p.jailed) {
        log(game, p.name + ' ist bereits im Gefängnis („' + landingField.name + '“).');
        events.push('Bereits im Gefängnis');
        turnPassed = true;
      } else {
        p.jailed = true;
        p.jailTurns = Math.max(1, jailTurnsF);
        if (bail > 0) {
          // Wahl anbieten: Freikauf vs. Züge aussetzen. Zug wartet auf Entscheidung.
          p.jailBail = bail;
          landing.jailChoice = { bail, turns: p.jailTurns };
          log(game, p.name + ' landet im Gefängnis („' + landingField.name + '“). Lösegeld ' + fmt(bail) + ' — freikaufen oder absitzen?');
          events.push('⚠️ Gefängnis · Lösegeld ' + fmt(bail) + ' zahlen oder absitzen?');
          // turnPassed bleibt false → Zug pausiert auf Entscheidung
          events.push('JailChoice');
        } else {
          log(game, p.name + ' landet im Gefängnis („' + landingField.name + '“) — überspringt die nächsten ' + p.jailTurns + ' Zug/Züge.');
          events.push('Gefängnis · ' + p.jailTurns + ' Zug/Züge aussetzen');
          turnPassed = true;
        }
      }
    } else if (landingField.type === 'steuer') {
      // Steuer/Pflichtfeld: fester Betrag an die Bank (nur bei Landung).
      const tax = (typeof landingField.fee === 'number') ? landingField.fee : 0;
      if (tax > 0) {
        const ok = pay(game, p, null, tax, 'Steuer „' + landingField.name + '“');
        log(game, p.name + ' landet auf „' + landingField.name + '“ (Steuer) → ' + fmt(tax) + ' an die Bank.');
        events.push('Steuer ' + fmt(tax));
        turnPassed = true;
      } else {
        log(game, p.name + ' landet auf „' + landingField.name + '“ (Steuer) → kein Betrag, weiter.');
        turnPassed = true;
      }
    } else if (landingField.type === 'ereignis') {
      // Ereignis-Feld (wie ein Monopoly-Steuerfeld): wirkt NUR bei Landung.
      // fee > 0 = Gebühr an die Bank, fee < 0 = Bonus, 0/kein = nichts.
      const eFee = (typeof landingField.fee === 'number') ? landingField.fee : 0;
      if (eFee > 0) {
        const ok = pay(game, p, null, eFee, 'Ereignis-Gebühr „' + landingField.name + '“');
        log(game, p.name + ' landet auf „' + landingField.name + '“ (Ereignis) → Gebühr ' + fmt(eFee) + '.');
        events.push('Ereignis-Gebühr ' + fmt(eFee));
        turnPassed = true;
      } else if (eFee < 0) {
        const bonus = Math.abs(eFee);
        p.budget += bonus;
        this.ledgerPush(game, p, bonus, 'Ereignis-Bonus „' + landingField.name + '“');
        log(game, p.name + ' landet auf „' + landingField.name + '“ (Ereignis) → Bonus ' + fmt(bonus) + '.');
        events.push('Ereignis-Bonus +' + fmt(bonus));
        turnPassed = true;
      } else {
        log(game, p.name + ' landet auf „' + landingField.name + '“ (Ereignis) → kein Effekt, weiter.');
        turnPassed = true;
      }
    } else {
      log(game, p.name + ' landet auf Feld „' + landingField.name + '“ (unbekannter Typ ' + landingField.type + ') → weiter.');
      turnPassed = true;
    }

    // Nach erfolgreichem Wurf ist die Würfel-Aktion in diesem Zug gesperrt.
    game.rolled = true;
    // Merkt, ob der aktive Spieler das Zielfeld kaufen kann (Entscheidung bevorsteht).
    game.canBuy = canBuy;

    return {
      sum: sum,
      from: from,
      to: to,
      lapBonus: lapBonus,
      landing: landing,
      canBuy: canBuy,
      turnPassed: turnPassed,
      events: events
    };
  },

  buy: function (game) {
    const p = game.players[game.activeIdx];
    if (game.over || p.bankrupt) return false;
    const idx = p.pos;
    const f = game.fields[idx];
    if (!f || f.type !== 'grundstueck') return false;
    const owner = ownerOf(game, idx);
    if (owner !== null) return false;
    if (p.budget < f.price) {
      log(game, p.name + ' kann „' + f.name + '“ nicht kaufen (Budget ' + fmt(p.budget) + ' < ' + fmt(f.price) + ').');
      return false;
    }
    p.budget -= f.price;
    p.properties[idx] = { level: 'ALLEIN' };
    game.canBuy = false;
    log(game, p.name + ' kauft „' + f.name + '“ für ' + fmt(f.price) + '.');
    this.ledgerPush(game, p, -f.price, 'Kauf „' + f.name + '“');
    return true;
  },

  skip: function (game) {
    const p = game.players[game.activeIdx];
    const f = game.fields[p.pos];
    game.canBuy = false;
    log(game, p.name + ' springt den Kauf auf „' + (f ? f.name : ('Feld ' + p.pos)) + '“ über.');
    return true;
  },

  // Freikäuft aus dem Gefängnis (Lösegeld bail). Der Zug ist danach beendet →
  // nächster Spieler. Optional: Schuldenmodell (zahlt über's Konto, geht ins Minus).
  bail: function (game) {
    const p = game.players[game.activeIdx];
    if (game.over || p.bankrupt) return { ok: false, reason: 'inactive' };
    if (!p.jailed || !p.jailBail) return { ok: false, reason: 'not_jailed' };
    const bail = p.jailBail;
    const payedFull = pay(game, p, null, bail, 'Gefängnis-Lösegeld');
    p.jailed = false;
    p.jailTurns = 0;
    p.jailBail = undefined;
    log(game, p.name + ' kauft sich aus dem Gefängnis frei (' + fmt(bail) + ').');
    this.resolveInsolvency(game, game.activeIdx);
    this.nextTurn(game);
    return { ok: true, payedFull, bail };
  },

  // Spieler entscheidet, im Gefängnis zu bleiben → Zug endet, er überspringt die
  // nächsten jailTurns Züge.
  jailStay: function (game) {
    const p = game.players[game.activeIdx];
    if (game.over || p.bankrupt) return { ok: false, reason: 'inactive' };
    if (!p.jailed) return { ok: false, reason: 'not_jailed' };
    p.jailBail = undefined;
    log(game, p.name + ' entscheidet, im Gefängnis zu bleiben (überspringt ' + p.jailTurns + ' Zug/Züge).');
    this.resolveInsolvency(game, game.activeIdx);
    this.nextTurn(game);
    return { ok: true, turns: p.jailTurns };
  },

  build: function (game, fieldIdx) {
    const p = game.players[game.activeIdx];
    if (game.over || p.bankrupt) return false;
    const own = p.properties[fieldIdx];
    if (!own) return false;
    const f = game.fields[fieldIdx];
    if (!f || f.type !== 'grundstueck') return false;

    const curIdx = LEVEL_ORDER.indexOf(own.level);
    if (curIdx === -1) return false;
    const nextLevel = LEVEL_ORDER[curIdx + 1];
    if (!nextLevel) return false;
    if (nextLevel === 'ARMISTICE' && !game.armisticeEnabled) return false;

    // ---- Monopoly-Bauregel(n) (2k #5 → 2m #13): zwei unabhängige Regeln. ----
    // buildGroupOwnership: Ausbau nur, wenn die ganze Farbgruppe im selben Besitz.
    // buildGroupEven:      gleichmäßig bauen — keine Stufe >1 über der schwächsten.
    // buildGroupEven ist nur in Verbindung mit buildGroupOwnership aktivierbar
    // (Client erzwingt das), buildGroupOwnership kann allein stehen.
    let ruleOwnership = true;
    let ruleEven = true;
    if (game.settings && typeof game.settings.buildGroupOwnership === 'boolean') ruleOwnership = game.settings.buildGroupOwnership;
    else if (game.settings && typeof game.settings.monopolyBuildRule === 'boolean') ruleOwnership = game.settings.monopolyBuildRule;
    if (game.settings && typeof game.settings.buildGroupEven === 'boolean') ruleEven = game.settings.buildGroupEven;
    else if (game.settings && typeof game.settings.monopolyBuildRule === 'boolean') ruleEven = game.settings.monopolyBuildRule;
    if (!ruleOwnership) ruleEven = false; // gleichmäßig braucht die Besitz-Regel

    // Farbgruppen-Zugehörigkeit (inkl. Preisband-Default): alle Grundstücke derselben Gruppe.
    const groupOf = (fid) => {
      const gf = game.fields[fid];
      if (!gf || gf.type !== 'grundstueck') return null;
      if (gf.group != null && String(gf.group) !== '') return normalizeGroupKey(String(gf.group));
      return (gf.price || 0) > 400000 ? 'BAND1' : 'BAND0';
    };
    const grpKey = groupOf(fieldIdx);
    let group = [];
    for (let gi = 0; gi < game.fields.length; gi++) {
      if (game.fields[gi] && game.fields[gi].type === 'grundstueck' && groupOf(gi) === grpKey) group.push(gi);
    }
    // Einzelgänger (Gruppe mit nur diesem Feld): immer bauen lassen.
    if (group.length <= 1) { group = [fieldIdx]; }

    if (ruleOwnership && ruleEven && group.length > 1) {
      // (1) Alle Felder der Gruppe müssen demselben Besitzer gehören.
      for (let gi = 0; gi < group.length; gi++) {
        const gowner = ownerOf(game, group[gi]);
        if (!gowner || gowner.id !== p.id) {
          log(game, p.name + ' kann auf „' + f.name + '“ nicht ausbauen: Alle Felder der Farbgruppe müssen im selben Besitz sein (Monopoly-Bauregel).');
          return false;
        }
      }
      // (2) Gleichmäßiger Ausbau: keine Stufe darf >1 über der schwächsten der Gruppe liegen.
      const levels = group.map((gi) => LEVEL_ORDER.indexOf(game.players[game.activeIdx].properties[gi].level));
      const newLevelRow = levels.slice();
      newLevelRow[group.indexOf(fieldIdx)] = curIdx + 1;
      const tmin = Math.min.apply(null, newLevelRow);
      const tmax = Math.max.apply(null, newLevelRow);
      if (tmax - tmin > 1) {
        log(game, p.name + ' kann auf „' + f.name + '“ nicht ausbauen: gleichmäßig ausbauen — keine Stufe darf mehr als 1 über der schwächsten der Farbgruppe liegen (Monopoly-Bauregel).');
        return false;
      }
    } else if (ruleOwnership && group.length > 1) {
      // NUR Besitz-Regel aktiv (ohne Gleichmäßig): ganzer Gruppen-Besitz genügt.
      for (let gi = 0; gi < group.length; gi++) {
        const gowner = ownerOf(game, group[gi]);
        if (!gowner || gowner.id !== p.id) {
          log(game, p.name + ' kann auf „' + f.name + '“ nicht ausbauen: Alle Felder der Farbgruppe müssen im selben Besitz sein (Monopoly-Bauregel).');
          return false;
        }
      }
    }

    const cost = game.data.buildCost(f.price, nextLevel, game.settings);
    if (p.budget < cost) {
      log(game, p.name + ' kann nicht auf „' + f.name + '“ auf ' + nextLevel + ' ausbauen (Kosten ' + fmt(cost) + ', Budget ' + fmt(p.budget) + ').');
      return false;
    }
    p.budget -= cost;
    p.properties[fieldIdx].level = nextLevel;
    log(game, p.name + ' baut „' + f.name + '“ aus: ' + own.level + ' → ' + nextLevel + ' (Kosten ' + fmt(cost) + ').');
    this.ledgerPush(game, p, -cost, 'Ausbau „' + f.name + '“ (' + nextLevel + ')');
    return true;
  },

  // Sanierungspflicht lösen: Wenn der angegebene Spieler immer noch in Zahlungsrückstand ist
  // (Budget <= 0, Schulden offen), scheidet er bankrott aus — es sei denn seine Sanierung
  // hat das Budget in den Plus-Bereich gebracht. Wird am Ende eines Zuges bzw. nach
  // Verkauf/Abreiß/Hypothek-Transaktionen aufgerufen.
  resolveInsolvency: function (game, playerIdx) {
    const pl = game.players[playerIdx];
    if (!pl || pl.bankrupt || !pl.insolvent) return { ok: true, action: 'none' };
    // Saniert gilt als gelöst, sobald das Budget wieder >= 0 ist (der Überzug führt
    // die komplette Schuld ab). debt ist nur Marker — Budget>=0 = vollständig zurückgezahlt.
    const debtCleared = pl.budget >= 0;
    if (debtCleared) {
      pl.insolvent = false;
      pl.debt = undefined;
      pl.creditorIdx = undefined;
      log(game, pl.name + ' hat seine Schulden vollständig beglichen und bleibt im Spiel (Budget ' + fmt(pl.budget) + ').');
      return { ok: true, action: 'saved' };
    }
    // Nicht saniert → Bankrott
    pl.bankrupt = true;
    pl.budget = 0;
    pl.properties = {};
    pl.insolvent = false;
    pl.debt = undefined;
    pl.creditorIdx = undefined;
    log(game, pl.name + ' konnte seine Schulden bis zum Zugende nicht decken → BANKROTT (scheidet aus).');
    checkWin(game);
    return { ok: true, action: 'bankrupt' };
  },

  nextTurn: function (game) {
    if (game.over) return;
    checkWin(game);
    // Erst: vorheriger (abgebender) Spieler muss seinen Zahlungsrückstand lösen.
    const prevIdx = game.activeIdx;
    this.resolveInsolvency(game, prevIdx);
    checkWin(game);
    if (game.over) return;
    const from = game.activeIdx;
    let target = nextIdx(game, from);
    // Gefängnis: Spieler, die im Gefängnis sitzen, überspringen ihre Züge
    // (jailTurns zählt runter; danach frei). Läuft bis ein freier Spieler dran ist.
    let guard = 0;
    while (guard < game.players.length + 2) {
      guard++;
      const cand = game.players[target];
      if (cand.jailed && cand.jailTurns > 0) {
        cand.jailTurns--;
        if (cand.jailTurns <= 0) { cand.jailed = false; }
        log(game, cand.name + ' sitzt im Gefängnis und überspringt diesen Zug (noch ' + Math.max(cand.jailTurns, 0) + ').');
        target = nextIdx(game, target);
      } else {
        break;
      }
    }
    game.activeIdx = target;
    // (2g#15) Zinsen auf ÜBERNOMMENE Hypotheken (Zinsen pro Runde), fällig
    // beim Zug des Halters. Eigene Hypotheken (nicht übernommen) zinsen erst
    // bei der Tilgung. Direkt-Ablösung bleibt jederzeit über unmortgage möglich.
    this._chargeMortgageInterest(game, target);
    // Neuer Zug: Würfel-Sperre aufheben + Kaufentscheidung zurücksetzen.
    game.rolled = false;
    game.canBuy = false;
    log(game, 'Zug wechselt von ' + game.players[from].name + ' zu ' + game.players[game.activeIdx].name + '.');
  },

  // Zinsen pro Runde auf übernommene (takenOver) Hypotheken des aktiven Spielers.
  _chargeMortgageInterest: function (game, pi) {
    const p = game.players[pi];
    if (!p) return 0;
    const rate = (game.settings && game.settings.unmortgageRate != null) ? game.settings.unmortgageRate : 1.10;
    const interestRate = Math.max(0, rate - 1);
    if (!(interestRate > 0)) return 0;
    let total = 0;
    const props = p.properties || {};
    const names = [];
    for (const fid in props) {
      const own = props[fid];
      if (own && own.mortgaged && own.takenOver) {
        const interest = Math.round((own.mortgagedValue || 0) * interestRate);
        if (interest > 0) {
          total += interest;
          p.budget -= interest;
          names.push('„' + fieldName(game, Number(fid)) + '“ (' + fmt(interest) + ')');
        }
      }
    }
    if (total > 0) {
      log(game, p.name + ' zahlt Zinsen für übernommene Hypotheken: ' + names.join(', ') + ' (−' + fmt(total) + ').');
      this.ledgerPush(game, p, -total, 'Hypotheken-Zinsen (übernommene)');
      if (p.budget < 0) this.resolveInsolvency(game, pi);
    }
    return total;
  },

  // ------------------------------------------------------------------
  // Cashflow-Ledger: verbucht jede Geldänderung eines Spielers für den
  // Verlaufs-Bericht des eigenen Teams. Aufruf bei jeder Budget-Änderung.
  // ------------------------------------------------------------------
  ledgerPush: function (game, player, amount, why) {
    if (!player) return;
    if (!Array.isArray(player.ledger)) player.ledger = [];
    player.ledger.push({
      amount: Math.round(amount),          // + Einzahlung / − Ausgabe
      why: String(why || ''),
      turn: game.log.length,
      at: new Date().toISOString().slice(11, 19)
    });
    if (player.ledger.length > 500) player.ledger = player.ledger.slice(-500);
  },

  // ------------------------------------------------------------------
  // Hypothek: Eigentum beleihen (75% des Kaufpreises zurück). Belehntes
  // Feld kassiert keine Miete mehr. Rückzahlung = Hypothek + 10% Zins.
  // ------------------------------------------------------------------
  mortgage: function (game, fieldIdx) {
    const p = game.players[game.activeIdx];
    if (game.over || p.bankrupt) return { ok: false, reason: 'not_your_turn' };
    const own = p.properties[fieldIdx];
    if (!own) return { ok: false, reason: 'not_owned' };
    if (own.mortgaged) return { ok: false, reason: 'already_mortgaged' };
    const f = game.fields[fieldIdx];
    const val = f && typeof f.price === 'number' ? f.price : 0;
    const loan = Math.round(val * (game.settings.mortgageMult != null ? game.settings.mortgageMult : 0.75));
    own.mortgaged = true;
    own.mortgagedValue = loan;
    log(game, p.name + ' beleihnt „' + (f ? f.name : 'Feld ' + fieldIdx) + '“ (Hypothek) → + ' + fmt(loan) + '.');
    creditEarnings(game, p, loan, 'Hypothek „' + (f ? f.name : fieldIdx) + '“');
    this.resolveInsolvency(game, game.activeIdx);
    return { ok: true, loan, fieldIdx };
  },

  unmortgage: function (game, fieldIdx) {
    const p = game.players[game.activeIdx];
    if (game.over || p.bankrupt) return { ok: false, reason: 'not_your_turn' };
    const own = p.properties[fieldIdx];
    if (!own || !own.mortgaged) return { ok: false, reason: 'not_mortgaged' };
    const f = game.fields[fieldIdx];
    const base = own.mortgagedValue || Math.round((f && typeof f.price === 'number' ? f.price : 0) * (game.settings.mortgageMult != null ? game.settings.mortgageMult : 0.75));
    const pay = Math.round(base * (game.settings.unmortgageRate != null ? game.settings.unmortgageRate : 1.10));
    if (p.budget < pay) return { ok: false, reason: 'no_money', need: pay };
    p.budget -= pay;
    own.mortgaged = false;
    own.mortgagedValue = undefined;
    log(game, p.name + ' tilgt Hypothek auf „' + (f ? f.name : 'Feld ' + fieldIdx) + '“ (zahlt ' + fmt(pay) + ').');
    this.ledgerPush(game, p, -pay, 'Hypothek tilgen „' + (f ? f.name : fieldIdx) + '“');
    return { ok: true, pay, fieldIdx };
  },

  // ------------------------------------------------------------------
  // Abbau (Häuser/Hotels zurückverkaufen): eine Stufe abwickeln, 50% der
  // Baukosten zurück. (Like Monopoly selling houses at half price.)
  // ------------------------------------------------------------------
  demolish: function (game, fieldIdx) {
    const p = game.players[game.activeIdx];
    if (game.over || p.bankrupt) return { ok: false, reason: 'not_your_turn' };
    const own = p.properties[fieldIdx];
    if (!own) return { ok: false, reason: 'not_owned' };
    if (own.mortgaged) return { ok: false, reason: 'mortgaged' };
    const f = game.fields[fieldIdx];
    const curIdx = LEVEL_ORDER.indexOf(own.level);
    if (curIdx <= 0) return { ok: false, reason: 'nothing_to_remove' };
    const curLevel = LEVEL_ORDER[curIdx];

    // (2m #14) Gleichmäßige-Regel beim Abbau symmetrisch erzwingen: keine Stufe einer
    // Farbgruppe darf nach dem Abbau >1 über der schwächsten der Gruppe liegen.
    let ruleEven = true;
    if (game.settings && typeof game.settings.buildGroupEven === 'boolean') ruleEven = game.settings.buildGroupEven;
    else if (game.settings && typeof game.settings.monopolyBuildRule === 'boolean') ruleEven = game.settings.monopolyBuildRule;
    let ruleOwnership = true;
    if (game.settings && typeof game.settings.buildGroupOwnership === 'boolean') ruleOwnership = game.settings.buildGroupOwnership;
    else if (game.settings && typeof game.settings.monopolyBuildRule === 'boolean') ruleOwnership = game.settings.monopolyBuildRule;
    if (!ruleOwnership) ruleEven = false;
    if (ruleEven) {
      const groupOf = (fid) => {
        const gf = game.fields[fid];
        if (!gf || gf.type !== 'grundstueck') return null;
        if (gf.group != null && String(gf.group) !== '') return String(gf.group);
        return (gf.price || 0) > 400000 ? 'BAND1' : 'BAND0';
      };
      const grpKey = groupOf(fieldIdx);
      let group = [];
      for (let gi = 0; gi < game.fields.length; gi++) {
        if (game.fields[gi] && game.fields[gi].type === 'grundstueck' && groupOf(gi) === grpKey) group.push(gi);
      }
      if (group.length > 1) {
        const levels = group.map((gi) => {
          const pr = game.players[game.activeIdx].properties[gi];
          return { gi, lv: LEVEL_ORDER.indexOf(pr && pr.level ? pr.level : 'ALLEIN') };
        });
        // Nach dem Abbau: dieses Feld sinkt um 1 Stufe.
        const after = levels.map((x) => x.gi === fieldIdx ? x.lv - 1 : x.lv);
        const tmin = Math.min.apply(null, after);
        const tmax = Math.max.apply(null, after);
        if (tmax - tmin > 1) {
          log(game, p.name + ' kann auf „' + (f ? f.name : 'Feld ' + fieldIdx) + '“ nicht abbauen: gleichmäßig abbauen — keine Stufe darf mehr als 1 über der schwächsten der Farbgruppe liegen (Monopoly-Bauregel).');
          return { ok: false, reason: 'even_demolish' };
        }
      }
    }

    const cost = game.data.buildCost(f ? f.price : 0, curLevel, game.settings);
    const refund = Math.round(cost * (game.settings.demolishRefundRate != null ? game.settings.demolishRefundRate : 0.5));
    own.level = LEVEL_ORDER[curIdx - 1];
    log(game, p.name + ' verkauft auf „' + (f ? f.name : 'Feld ' + fieldIdx) + '“ eine Stufe (' + curLevel + ' → ' + own.level + '), Rückerstattung ' + fmt(refund) + '.');
    creditEarnings(game, p, refund, 'Rückbau „' + (f ? f.name : fieldIdx) + '“');
    this.resolveInsolvency(game, game.activeIdx);
    return { ok: true, refund, fieldIdx, level: own.level };
  },

  // ------------------------------------------------------------------
  // Aufgeben: Team scheidet freiwillig aus (wie Bankrott). Besitz wird
  // an die Bank zurückgegeben. (Monopoly: aufgeben = Bankrott.)
  // ------------------------------------------------------------------
  forfeit: function (game) {
    const p = game.players[game.activeIdx];
    if (game.over || p.bankrupt) return { ok: false, reason: 'inactive' };
    p.bankrupt = true;
    p.budget = 0;
    p.properties = {};
    log(game, p.name + ' gibt auf und scheidet aus (Besitz geht an die Bank).');
    checkWin(game);
    return { ok: true };
  },

  // Team (per playerIdx) zum Aufgeben zwingen — genutzt von der Aufgeben-Abstimmung
  // (die Mitglieder-Ebene verwaltet rooms.js). Der aktive Spieler des Teams scheidet aus,
  // ersatzweise der Spieler an der Reihe, falls jenes Team gerade nicht aktiv ist.
  forfeitTeam: function (game, teamIdx) {
    const p = game.players[teamIdx];
    if (!p || p.bankrupt) return { ok: false, reason: 'inactive' };
    p.bankrupt = true;
    p.budget = 0;
    p.properties = {};
    log(game, p.name + ' gibt per Abstimmung auf und scheidet aus (Besitz an die Bank).');
    checkWin(game);
    return { ok: true };
  },

  // ------------------------------------------------------------------
  // Verkauf an ein anderes Team: Besitzer überträgt ein Grundstück
  // (inkl. Ausbaustufe) gegen vereinbarten Betrag an ein anderes Team.
  // ------------------------------------------------------------------
  sellProperty: function (game, fieldIdx, buyerIdx, price, explicitSellerIdx) {
    const seller = (explicitSellerIdx != null && game.players[explicitSellerIdx])
      ? game.players[explicitSellerIdx]
      : game.players[game.activeIdx];
    if (!seller) return { ok: false, reason: 'bad_target' };
    if (game.over || seller.bankrupt) return { ok: false, reason: 'inactive' };
    const own = seller.properties[fieldIdx];
    if (!own) return { ok: false, reason: 'not_owned' };
    // Verkauf an die Bank (Sanierung): buyerIdx = -1 bzw. fehlend → Bank zahlt
    // bankPayout × Basis. Funktionssperre: settings.bankSellEnabled=false blockiert.
    // (2g#15) Ein belehntes Grundstück kann NICHT an die Bank verkauft werden.
    if (buyerIdx == null || Number(buyerIdx) < 0) {
      if (own.mortgaged) return { ok: false, reason: 'mortgaged' };
      if (game.settings && game.settings.bankSellEnabled === false) {
        return { ok: false, reason: 'bank_sell_disabled' };
      }
      const f = game.fields[fieldIdx];
      const base = (f && typeof f.price === 'number' ? f.price : 0) * (game.settings && game.settings.bankPayout != null ? game.settings.bankPayout : 0.75);
      const amt = Math.round(base);
      delete seller.properties[fieldIdx];
      log(game, seller.name + ' verkauft „' + (f ? f.name : 'Feld ' + fieldIdx) + '“ an die Bank für ' + fmt(amt) + ' (Sanierung).');
      creditEarnings(game, seller, amt, 'Bankverkauf „' + (f ? f.name : fieldIdx) + '“');
      this.resolveInsolvency(game, game.activeIdx);
      return { ok: true, fieldIdx, buyerIdx: -1, price: amt };
    }
    const buyer = game.players[buyerIdx];
    if (!buyer || seller.id === buyer.id) return { ok: false, reason: 'bad_target' };
    if (buyer.bankrupt) return { ok: false, reason: 'inactive' };
    const amt = Math.round(Number(price));
    if (!(amt >= 0)) return { ok: false, reason: 'bad_price' };
    if (buyer.budget < amt) return { ok: false, reason: 'buyer_no_money' };
    const f = game.fields[fieldIdx];
    // Eigentum übertragen (Ausbaustufe + Hypothek-Status bleiben).
    // (2g#15) Übertragene Hypothek: Käufer übernimmt; Flag markiert sie für
    // die Zinsen-pro-Runde-Abrechnung (kann alternativ sofort getilgt werden).
    if (own.mortgaged && !own.takenOver) own.takenOver = true;
    delete seller.properties[fieldIdx];
    buyer.properties[fieldIdx] = own;
    buyer.budget -= amt;
    this.ledgerPush(game, buyer, -amt, 'Kauf von „' + (f ? f.name : fieldIdx) + '“');
    log(game, seller.name + ' verkauft „' + (f ? f.name : 'Feld ' + fieldIdx) + '“ an ' + buyer.name + ' für ' + fmt(amt) + '.');
    creditEarnings(game, seller, amt, 'Verkauf „' + (f ? f.name : fieldIdx) + '“');
    this.resolveInsolvency(game, game.activeIdx);
    return { ok: true, fieldIdx, buyerIdx, price: amt };
  },

  // ------------------------------------------------------------------
  // Verkaufs-/Kauf-Angebot erstellen: Besitzer bietet ein Feld zum Verkauf an
  // (kind='sell'), ODER ein Team bietet dem Besitzer einen Kauf an (kind='buy').
  // Das Ziel-Team muss annehmen ODER ablehnen — kein automatischer Abschluss.
  // ------------------------------------------------------------------
  makeOffer: function (game, opts) {
    const kind = opts.kind === 'buy' ? 'buy' : 'sell';
    const fromIdx = Number(opts.fromIdx);
    const targetIdx = Number(opts.targetIdx);
    const fieldIdx = Number(opts.fieldIdx);
    const price = Math.round(Number(opts.price));
    if (game.over) return { ok: false, reason: 'over' };
    const from = game.players[fromIdx];
    const target = game.players[targetIdx];
    if (!from || !target || from.id === target.id) return { ok: false, reason: 'bad_target' };
    if (from.bankrupt || target.bankrupt) return { ok: false, reason: 'inactive' };
    if (!(price >= 0)) return { ok: false, reason: 'bad_price' };
    if (!game.fields[fieldIdx]) return { ok: false, reason: 'bad_field' };
    const f = game.fields[fieldIdx];
    if (kind === 'sell') {
      if (!from.properties[fieldIdx]) return { ok: false, reason: 'not_owned' };
    } else {
      // buy: das Feld muss dem Ziel gehören
      if (!target.properties[fieldIdx]) return { ok: false, reason: 'target_not_owned' };
    }
    // Alte Angebote desselben Feldes/Parts verwerfen
    game.offers = (game.offers || []).filter((o) => !(o.fieldIdx === fieldIdx && o.fromIdx === fromIdx && o.targetIdx === targetIdx));
    const offer = {
      id: 'o' + (game.offers.length + 1) + '_' + Date.now(),
      kind,                      // 'sell' (from verkauft) / 'buy' (from will kaufen)
      fieldIdx, price,
      fromIdx, targetIdx,
      created: Date.now(),
      fromName: from.name,
      targetName: target.name,
      level: from.properties[fieldIdx] ? from.properties[fieldIdx].level : null
    };
    game.offers.push(offer);
    log(game, (kind === 'sell' ? from.name + ' bietet „' + f.name + '“ an ' + target.name : from.name + ' bietet ' + target.name + ' den Kauf von „' + f.name + '“') + ' für ' + fmt(price) + ' an.');
    return { ok: true, offer };
  },

  // Ziel-Team akzeptiert oder lehnt ein offenes Angebot ab.
  respondOffer: function (game, offerId, accept) {
    const list = game.offers || [];
    const i = list.findIndex((o) => String(o.id) === String(offerId));
    if (i === -1) return { ok: false, reason: 'no_offer' };
    const offer = list[i];
    const acceptIdx = Number(accept);
    const from = game.players[offer.fromIdx];
    const target = game.players[offer.targetIdx];
    const f = game.fields[offer.fieldIdx];
    const listAfter = list.slice(); listAfter.splice(i, 1);
    game.offers = listAfter;
    if (acceptIdx === 1) {
      // buy: Ziel (Besitzer) verkauft an from; sell: from verkauft an Ziel.
      const seller = offer.kind === 'buy' ? target : from;
      const buyer = offer.kind === 'buy' ? from : target;
      this.sellProperty(game, offer.fieldIdx, game.players.indexOf(buyer), offer.price, game.players.indexOf(seller));
      return { ok: true, done: true, offer };
    }
    log(game, offer.targetName + ' lehnt das Angebot für „' + (f ? f.name : 'Feld ' + offer.fieldIdx) + '“ ab.');
    return { ok: true, done: false, offer };
  },

  // ------------------------------------------------------------------
  // Versteigerung eines EIGENEN Feldes: Besitzer startet; alle Teams können
  // bieten; max. AUKTION_MS (15s). Versteigerer kann vorzeitig akzeptieren oder
  // abbrechen. liveWinner = Höchstbote iterativ.
  // ------------------------------------------------------------------
  startAuction: function (game, opts) {
    const ownerIdx = Number(opts.ownerIdx);
    const fieldIdx = Number(opts.fieldIdx);
    if (game.over) return { ok: false, reason: 'over' };
    if (game.auction) return { ok: false, reason: 'auction_running' };
    const owner = game.players[ownerIdx];
    if (!owner || owner.bankrupt) return { ok: false, reason: 'inactive' };
    if (!owner.properties[fieldIdx]) return { ok: false, reason: 'not_owned' };
    const dur = opts.durationMs > 0 ? opts.durationMs : (game.settings && game.settings.auctionMs != null ? game.settings.auctionMs : (game.data.AUCTION_MS || 15000));
    const f = game.fields[fieldIdx];
    const minBid = Math.max(1, Math.round((typeof f.price === 'number' ? f.price : 0) * 0.1));
    game.auction = {
      id: 'a' + Date.now(),
      fieldIdx,
      ownerIdx,
      started: Date.now(),
      endsAt: Date.now() + dur,
      durationMs: dur,
      minBid,
      highest: null,         // { playerIdx, amount }
      bids: []
    };
    log(game, owner.name + ' versteigert „' + f.name + '“ — Gebote willkommen! (Start: ' + fmt(minBid) + ')');
    return { ok: true, auction: game.auction };
  },

  bidAuction: function (game, bidderIdx, amount) {
    if (!game.auction) return { ok: false, reason: 'no_auction' };
    const au = game.auction;
    if (Date.now() > au.endsAt) return { ok: false, reason: 'ended' };
    const bidder = game.players[bidderIdx];
    if (!bidder || bidder.bankrupt || bidderIdx === au.ownerIdx) return { ok: false, reason: 'inactive' };
    const amt = Math.round(Number(amount));
    if (!(amt >= au.minBid)) return { ok: false, reason: 'under_min' };
    if (au.highest && amt <= au.highest.amount) return { ok: false, reason: 'must_top' };
    if (bidder.budget < amt) return { ok: false, reason: 'no_money' };
    au.highest = { playerIdx: bidderIdx, amount: amt };
    au.bids.push({ playerIdx: bidderIdx, amount: amt, at: Date.now() });
    log(game, bidder.name + ' bietet ' + fmt(amt) + ' auf „' + game.fields[au.fieldIdx].name + '“.');
    return { ok: true, highest: au.highest };
  },

  // Besitzer akzeptiert das letzte Gebot (accept) oder bricht ab (cancel).
  resolveAuction: function (game, accept) {
    const au = game.auction;
    if (!au) return { ok: false, reason: 'no_auction' };
    game.auction = null;
    if (accept === 1 && au.highest) {
      const winner = game.players[au.highest.playerIdx];
      const owner = game.players[au.ownerIdx];
      const f = game.fields[au.fieldIdx];
      const own = owner.properties[au.fieldIdx];
      const amt = au.highest.amount;
      if (!own) return { ok: false, reason: 'not_owned' };
      delete owner.properties[au.fieldIdx];
      winner.properties[au.fieldIdx] = own;
      winner.budget -= amt;
      owner.budget += amt;
      log(game, 'Versteigerung „' + f.name + '“ endet: ' + winner.name + ' ersteigert für ' + fmt(amt) + '.');
      this.ledgerPush(game, winner, -amt, 'Ersteigerung „' + f.name + '“');
      this.ledgerPush(game, owner, amt, 'Verkauf via Auktion „' + f.name + '“');
      return { ok: true, sold: true, winnerIdx: au.highest.playerIdx, price: amt };
    }
    log(game, 'Versteigerung von „' + (game.fields[au.fieldIdx] ? game.fields[au.fieldIdx].name : 'Feld ' + au.fieldIdx) + '“ ohne Kauf abgebrochen.');
    return { ok: true, sold: false };
  },

  // ------------------------------------------------------------------
  // Versteigerung: Bank verauktioniert ein Feld, alle Bankrott-losen
  // Teams bieten nacheinander; Höchstbote gewinnt.
  // ------------------------------------------------------------------
  auctionField: function (game, fieldIdx, bids) {
    const f = game.fields[fieldIdx];
    if (!f) return { ok: false, reason: 'bad_field' };
    if (ownerOf(game, fieldIdx)) return { ok: false, reason: 'owned' };
    // bids: [[playerIdx, amount], …] — Höchstbote gewinnt
    let best = null;
    (bids || []).forEach(([pi, amt]) => {
      const pl = game.players[pi];
      if (!pl || pl.bankrupt) return;
      const a = Math.round(Number(amt));
      if (a > 0 && a <= pl.budget && (!best || a > best.amount)) best = { pi, player: pl, amount: a };
    });
    if (!best) return { ok: false, reason: 'no_winners' };
    best.player.budget -= best.amount;
    best.player.properties[fieldIdx] = { level: 'ALLEIN' };
    log(game, best.player.name + ' ersteigert „' + f.name + '“ für ' + fmt(best.amount) + '.');
    this.ledgerPush(game, best.player, -best.amount, 'Versteigerung „' + f.name + '“');
    return { ok: true, fieldIdx, winnerIdx: best.pi, price: best.amount };
  },

  serialize: function (game) {
    return JSON.stringify({
      fields: game.fields,
      players: game.players,
      activeIdx: game.activeIdx,
      over: game.over,
      winnerInfo: game.winnerInfo,
      diceConfig: game.diceConfig,
      armisticeEnabled: game.armisticeEnabled,
      levelNames: game.levelNames || null,
      settings: game.settings || null,
      rolled: !!game.rolled,
      canBuy: !!game.canBuy,
      offers: game.offers || [],
      auction: game.auction || null,
      forfeitPoll: game.forfeitPoll || null,
      turnSeconds: Math.max(0, Math.round(Number(game.turnSeconds) || 0)),
      turnDeadline: typeof game.turnDeadline === 'number' ? game.turnDeadline : 0,
      log: game.log
    });
  },

  deserialize: function (json, data) {
    const raw = typeof json === 'string' ? JSON.parse(json) : json;
    const game = {
      data: data,
      fields: Array.isArray(raw.fields) ? raw.fields.map(normalizeField)
        : (D.PRESETS['Crusader Cluster'] ? D.PRESETS['Crusader Cluster'].fields.map(normalizeField) : []),
      players: raw.players.map(function (p) {
        return {
          id: p.id,
          name: p.name,
          ship: p.ship,
          task: p.task,
          budget: p.budget,
          pos: p.pos,
          properties: p.properties || {},
          ledger: Array.isArray(p.ledger) ? p.ledger : [],
          bankrupt: !!p.bankrupt,
          winner: !!p.winner,
          jailed: !!p.jailed,
          jailTurns: Math.max(0, Math.round(Number(p.jailTurns) || 0)),
          jailBail: (typeof p.jailBail === 'number') ? Math.round(p.jailBail) : undefined,
          insolvent: !!p.insolvent,
          debt: (typeof p.debt === 'number') ? Math.round(p.debt) : undefined,
          creditorIdx: (typeof p.creditorIdx === 'number') ? p.creditorIdx : undefined
        };
      }),
      activeIdx: raw.activeIdx || 0,
      over: !!raw.over,
      winnerInfo: raw.winnerInfo || null,
      diceConfig: raw.diceConfig || { kind: '1w6' },
      armisticeEnabled: !!raw.armisticeEnabled,
      levelNames: (raw.levelNames && typeof raw.levelNames === 'object') ? raw.levelNames : null,
      settings: D.mergeSettings(raw.settings),
      rolled: !!raw.rolled,
      canBuy: !!raw.canBuy,
      offers: Array.isArray(raw.offers) ? raw.offers : [],
      auction: raw.auction || null,
      forfeitPoll: raw.forfeitPoll || null,
      turnSeconds: Math.max(0, Math.round(Number(raw.turnSeconds) || 0)),
      turnDeadline: (typeof raw.turnDeadline === 'number') ? raw.turnDeadline : 0,
      log: Array.isArray(raw.log) ? raw.log.slice() : []
    };
    return attachMethods(game);
  }
};

module.exports = StantonopolyGame;

// (2m-A) Reine, unit-testbare Vermögenswert-Helper zusätzlich als statische Exporte
// (damit Tests direkt ohne createGame-Objekt pro PlayerIdx rechnen können).
module.exports.teamWealth = teamWealth;
module.exports.propertyWorth = propertyWorth;
module.exports.richestTeamIdx = richestTeamIdx;
module.exports.aliveCount = aliveCount;