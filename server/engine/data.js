/**
 * Stantonopoly V2 — Quelle der Wahrheit (Single Source of Truth)
 * Portiert von V1 data.js (CommonJS-only für Node-Server).
 * Server-authoritativ: Der Server berechnet, das Frontend zeigt nur an.
 * Alle Beträge sind ganze aUEC (Units of AEC).
 */
'use strict';

// ---------------------------------------------------------------------------
// Multiplikatoren
// ---------------------------------------------------------------------------

// Miete pro Ausbaustufe als Anteil des Kaufpreises (aUEC)
const RENT_MULT = {
  ALONE: 0.10,
  CYCLONE: 0.50,
  STORM: 1.00,
  BALLISTA: 2.00,
  ARMISTICE: 3.00
};

// Baukosten pro Ausbaustufe als Anteil des Kaufpreises (aUEC)
// ALONE ist der Ausgangszustand und kostet nichts -> 0
const BUILD_MULT = {
  CYCLONE: 0.25,
  STORM: 0.50,
  BALLISTA: 1.00,
  ARMISTICE: 1.50
};

// Kredit: Darlehen = 75 % des Kaufpreises
const MORTGAGE_MULT = 0.75;

// Alle Ausbaustufen; 'ARMISTICE' ist die optionale 4./5. Stufe
const LEVELS = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA', 'ARMISTICE'];

// Anzeigenamen der Ausbaustufen (pro Preset überschreibbar via levelNames).
const DEFAULT_LEVEL_NAMES = {
  ALLEIN: 'Standard',
  CYCLONE: 'Cyclone',
  STORM: 'Storm',
  BALLISTA: 'Ballista',
  ARMISTICE: 'Armistice Zone'
};

// ─────────────────────────────────────────────────────────────────────────
// Spielregel-Einstellungen (pro Preset überschreibbar via `settings`).
// Die Engine liest ALLE ekonomischen Parameter aus game.settings; fehlt ein
// Wert, greift dieser Default. So kann ein Preset eigene Miet-Multiplikatoren,
// Baukosten, Hypothek/Entlastung, Bank-Verkauf, Abbau-Rückerstattung, Timer
// und Funktionsperren mitbringen.
// ─────────────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  // Miete pro Ausbaustufe als Anteil des Kaufpreises (wie RENT_MULT)
  rentMult: { ALLEIN: 0.10, CYCLONE: 0.50, STORM: 1.00, BALLISTA: 2.00, ARMISTICE: 3.00 },
  // Baukosten pro Ausbaustufe als Anteil des Kaufpreises (wie BUILD_MULT)
  buildMult: { ALLEIN: 0, CYCLONE: 0.25, STORM: 0.50, BALLISTA: 1.00, ARMISTICE: 1.50 },
  // Hypothek: Darlehen = Anteil des Kaufpreises
  mortgageMult: 0.75,
  // Entlastung: Rückzahlung = Darlehen × unmortgageRate (10 % Zins → 1.10)
  unmortgageRate: 1.10,
  // Bank-Verkauf an die Bank (Sanierung) erlaubt? false = Funktion gesperrt
  bankSellEnabled: true,
  // Anteil des Kaufpreises, den die Bank beim Ankauf zahlt
  bankPayout: 0.75,
  // Abbau-Rückerstattung: Anteil der Baukosten einer Stufe
  demolishRefundRate: 0.50,
  // Versteigerungsdauer (ms)
  auctionMs: 15000,
  // Dauer der Aufgeben-Abstimmung (ms)
  pollMs: 15000,
  // Armistice (letzte Ausbaustufe) im Preset aktivieren?
  armisticeEnabled: false,
  // (2k #5 → 2m #13) Monopoly-Bauregel aufgeteilt in zwei unabhängige Regeln:
  //  - buildGroupOwnership: nur ausbauen, wenn man die ganze Farbgruppe besitzt.
  //  - buildGroupEven:      gleichmäßig ausbauen/abbauen (max − min ≤ 1 Stufe).
  // (2m #13) / buildGroupEven ist nur in Verbindung mit buildGroupOwnership aktivierbar;
  // buildGroupOwnership kann auch allein stehen. Default: beide an.
  buildGroupOwnership: true,
  buildGroupEven: true,
  // (Aufgabenregel) Nach Kauf/Ausbau muss das Team eine Aufgabe erledigen,
  // bevor sein Zug wieder freigeschaltet wird. Default: aus (Verhalten wie bisher).
  tasksEnabled: false,
  // (Aufgabenregel P4) Timer (ms), den ein beschäftigtes Team am eigenen Zug hat,
  // um die Aufgabe abzuschließen. Läuft er ohne Abschluss ab, endet der Zug
  // automatisch (Aufgabe bleibt offen). Default: 10 s.
  tasksTurnTimerMs: 10000,
  // (Aufgabenregel P3) Optionale Regel: ein AKZEPTIERTER Handel löst ebenfalls
  // eine Aufgabe aus (+ Zug-Ende). Nur relevant, wenn tasksEnabled=true.
  tasksRequireTrade: false,
  // (Piratensystem) Optionale Begegnungs-Mechanik. ALLE Default = aus/inaktiv,
  // sodass ohne Pirates EXAKT bisheriges Verhalten gilt.
  piratesEnabled: false,
  pirateDice: '1w6',      // eigene Würfel der Piraten ('1w6'|'2w6')
  pirateProtectionFee: 250000, // Schutzgeld-Höhe (aUEC)
  pirateCaughtMult: 2,    // Faktor, wenn das Team erwischt wird (z.B. 2 = doppelt)
  // (P7) Warte-Turns: Die Piraten bleiben so viele NORMALE-Team-Zugwechsel auf ihrem
  // Feld, bevor sie automatisch weiterziehen. Jeder komplette Zug eines normalen Teams
  // zählt 1. (Pirat-Team selbst zählt nicht.)
  pirateWaitTurns: 6,
  // (P9) Optional: pro Durchgang nur 1 Piraten-Interaktion je Team (Reset bei Los-Pass).
  pirateOncePerLap: false
};

// ---------------------------------------------------------------------------
// Berechnungsfunktionen (alle auf Integer gerundet via Math.round)
// ---------------------------------------------------------------------------

function baseRent(price, mult) {
  const m = mult || RENT_MULT.ALONE;
  return Math.round(price * m);
}

function rentFor(price, levelName, settings) {
  const mult = (settings && settings.rentMult) ? settings.rentMult : RENT_MULT;
  const key = levelName === 'ALLEIN' ? 'ALONE' : levelName;
  const key2 = levelName === 'ALLEIN' ? 'ALLEIN' : levelName;
  const m = mult[key] != null ? mult[key] : mult[key2];
  if (m == null) {
    throw new Error('Unbekanntes Level: ' + levelName);
  }
  return Math.round(price * m);
}

function buildCost(price, levelName, settings) {
  if (levelName === 'ALLEIN') {
    return 0;
  }
  const mult = (settings && settings.buildMult) ? settings.buildMult : BUILD_MULT;
  if (!(levelName in mult)) {
    throw new Error('Unbekanntes Level: ' + levelName);
  }
  return Math.round(price * mult[levelName]);
}

function mortgage(price, settings) {
  const mult = (settings && settings.mortgageMult != null) ? settings.mortgageMult : MORTGAGE_MULT;
  return Math.round(price * mult);
}

/**
 * Zahl -> deutsches Format mit Tausenderpunkten, ohne Dezimalkomma.
 * Bewusst manuell implementiert (kein toLocaleString), da sich die
 * Separator-Verhalten zwischen Node und Browser unterscheiden.
 */
function formatUAEC(n) {
  const value = Math.round(Number(n));
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      out += '.';
    }
    out += digits[i];
  }
  return sign + out;
}

/**
 * Tiefen-Merge der Preset-Settings über die Defaults. Fehlende Skalare und
 * fehlende Schlüssel verschachtelter Maps (rentMult/buildMult) werden aufgefüllt,
 * vorhandene Werte des Presets gewinnen.
 */
function mergeSettings(userSettings) {
  const d = DEFAULT_SETTINGS;
  const u = (userSettings && typeof userSettings === 'object') ? userSettings : {};
  const _u = Object.assign({}, u);
  // (2m #13) Rückwärtskompatibel: alte Presets setzten nur monopolyBuildRule.
  // Wenn die neuen Flags nicht explizit gesetzt sind, werden beide daraus abgeleitet.
  if (typeof _u.monopolyBuildRule === 'boolean') {
    if (typeof _u.buildGroupOwnership !== 'boolean') _u.buildGroupOwnership = _u.monopolyBuildRule;
    if (typeof _u.buildGroupEven !== 'boolean') _u.buildGroupEven = _u.monopolyBuildRule;
  }
  const out = {};
  for (const key of Object.keys(d)) {
    if (typeof d[key] === 'object' && d[key] !== null && !Array.isArray(d[key])) {
      out[key] = Object.assign({}, d[key], (_u[key] && typeof _u[key] === 'object') ? _u[key] : {});
    } else {
      out[key] = (_u[key] !== undefined && _u[key] !== '') ? _u[key] : d[key];
    }
  }
  return out;
}

/** Vorberechnete Miet-/Kreditkarte für ein Grundstücksfeld.
 */
function tabelleFor(price) {
  return {
    base: baseRent(price),
    cyclone: rentFor(price, 'CYCLONE'),
    storm: rentFor(price, 'STORM'),
    ballista: rentFor(price, 'BALLISTA'),
    mortg: mortgage(price)
  };
}

// ---------------------------------------------------------------------------
// Stammdaten
// ---------------------------------------------------------------------------

const StantonopolyData = {
  VERSION: '1.0.0',
  DEFAULT_CAPITAL: 1500000,
  LOS_PASS_BONUS: 500000,
  GUNDO_FEE: 125000,
  MIN_TEAMS: 2,
  MAX_TEAMS: 8,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,

  RENT_MULT: RENT_MULT,
  BUILD_MULT: BUILD_MULT,
  MORTGAGE_MULT: MORTGAGE_MULT,
  BANK_PAYOUT: 0.75,   // An die Bank verkaufen (Sanierung): Anteil des Feldwerts
  LEVELS: LEVELS,

  baseRent: baseRent,
  rentFor: rentFor,
  buildCost: buildCost,
  mortgage: mortgage,
  formatUAEC: formatUAEC,
  tabelleFor: tabelleFor,
  mergeSettings: mergeSettings,
  DEFAULT_LEVEL_NAMES: DEFAULT_LEVEL_NAMES,

  // Karten-Presets; Reihenfolge der fields: Index 0-15 (id = Index)
  PRESETS: {
    // Default-Preset: Stantonopoly v1 (ersetzt "Crusader Cluster").
    // Felder tragen die Farbgruppe (group) — `tabelle` (Mietstufen) wird in
    // normalizeField automatisch aus dem Preis ergänzt.
    'Stantonopoly v1': {
      name: 'Stantonopoly v1',
      levelNames: {
        ALLEIN: 'Standard',
        CYCLONE: 'Cyclone AA',
        STORM: 'Storm AA',
        BALLISTA: 'Ballista',
        ARMISTICE: 'Armistice Zone'
      },
      settings: { bankSellEnabled: false, tasksEnabled: true },
      fields: [
        { type: 'los', name: 'Orison' },                                                        // 0
        { type: 'grundstueck', name: 'Seraphim', price: 400000, group: 'pink' },                // 1
        { type: 'grundstueck', name: 'Shubin Mining SCD-1', price: 500000, group: 'gold' },     // 2
        { type: 'grundstueck', name: 'Kudre Ore', price: 500000, group: 'gold' },               // 3
        { type: 'grundstueck', name: 'Brios Breaker Yard', price: 400000, group: 'schwarz' },   // 4
        { type: 'grundstueck', name: 'Arc Mining 141', price: 500000, group: 'gold' },          // 5
        { type: 'ereignis', name: 'Covalex Hub Gundo', fee: 125000 },                           // 6
        { type: 'grundstueck', name: 'Miner Lament', price: 300000, group: 'schwarz' },         // 7
        { type: 'grundstueck', name: 'Grim Hex', price: 500000, group: 'rot' },                 // 8
        { type: 'grundstueck', name: 'NT-999-XX', price: 600000, group: 'rot' },                // 9
        { type: 'grundstueck', name: 'Deakins Research', price: 500000, group: 'gruen' },       // 10
        { type: 'grundstueck', name: 'Terra Mills HydroFarm', price: 300000, group: 'weiss' },  // 11
        { type: 'grundstueck', name: 'Gallete Family Farms', price: 300000, group: 'weiss' },   // 12
        { type: 'grundstueck', name: 'Hickes Research', price: 500000, group: 'gruen' },        // 13
        { type: 'grundstueck', name: 'Security Post Kareah', price: 600000, group: 'blau' },    // 14
        { type: 'grundstueck', name: 'Comm Array ST2-55', price: 600000, group: 'blau' }         // 15
      ]
    }
  }
};

// CommonJS-Export (Server).
module.exports = StantonopolyData;