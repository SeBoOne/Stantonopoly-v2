/* =====================================================================
 * Stantonopoly V2 — engine.test.js
 * Portierung der V1-Akzeptanz-Suite gegen die Server-Engine (CommonJS).
 * Start: node --test tests/engine.test.js
 * ===================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const D = require('../server/engine/data.js');
const G = require('../server/engine/engine.js');
const FIELDS = D.PRESETS['Stantonopoly v1'].fields;

// Deterministischer Würfel: 'frei'-Konfig mit festem freeValue.
function makeGame(players, opts) {
  opts = opts || {};
  return G.createGame({
    data: D,
    players: players.map((p, i) => ({ id: i, name: p.name, ship: p.ship || '', task: p.task || '' })),
    startingCapital: (opts.capital !== undefined) ? opts.capital : D.DEFAULT_CAPITAL,
    diceConfig: { kind: 'frei', freeValue: 0 },
    armisticeEnabled: !!opts.armistice,
    settings: opts.settings || null
  });
}

function rollExact(game, value) {
  game.diceConfig.kind = 'frei';
  game.diceConfig.freeValue = value;
  return game.roll();
}

// ---------------------------------------------------------------------
// Akzeptanz 1: Rent-Formel — 4 Preisbänder exakt gegen Excel
// ---------------------------------------------------------------------
test('Rent-Formel: alle 4 Preisbänder exakt gegen Excel', () => {
  const ref = {
    300000: { base: 30000, cyclone: 150000, storm: 300000, ballista: 600000, bCyclone: 75000, bStorm: 150000, bBallista: 300000, mortg: 225000 },
    400000: { base: 40000, cyclone: 200000, storm: 400000, ballista: 800000, bCyclone: 100000, bStorm: 200000, bBallista: 400000, mortg: 300000 },
    500000: { base: 50000, cyclone: 250000, storm: 500000, ballista: 1000000, bCyclone: 125000, bStorm: 250000, bBallista: 500000, mortg: 375000 },
    600000: { base: 60000, cyclone: 300000, storm: 600000, ballista: 1200000, bCyclone: 150000, bStorm: 300000, bBallista: 600000, mortg: 450000 }
  };
  for (const price of Object.keys(ref)) {
    const r = ref[price];
    assert.strictEqual(D.baseRent(Number(price)), r.base, `base ${price}`);
    assert.strictEqual(D.rentFor(Number(price), 'CYCLONE'), r.cyclone, `cyclone ${price}`);
    assert.strictEqual(D.rentFor(Number(price), 'STORM'), r.storm, `storm ${price}`);
    assert.strictEqual(D.rentFor(Number(price), 'BALLISTA'), r.ballista, `ballista ${price}`);
    assert.strictEqual(D.buildCost(Number(price), 'CYCLONE'), r.bCyclone, `bCyclone ${price}`);
    assert.strictEqual(D.buildCost(Number(price), 'STORM'), r.bStorm, `bStorm ${price}`);
    assert.strictEqual(D.buildCost(Number(price), 'BALLISTA'), r.bBallista, `bBallista ${price}`);
    assert.strictEqual(D.mortgage(Number(price)), r.mortg, `mortgage ${price}`);
  }
  assert.strictEqual(D.rentFor(600000, 'ALLEIN'), D.baseRent(600000));
});

// ---------------------------------------------------------------------
// Akzeptanz 2: Umlauf +500k
// ---------------------------------------------------------------------
test('Umlauf: Überquerung von Feld 15 → Orison bringt +500k (keine Ereignis-Gebühr mehr)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  g.players[0].pos = 14;
  const before = g.players[0].budget;
  const res = rollExact(g, 2);
  assert.strictEqual(res.to, 0, 'landet auf Orison (Index 0)');
  assert.strictEqual(res.lapBonus, D.LOS_PASS_BONUS, 'Lap-Bonus geliefert');
  // Neue Regel: Überquerung von Los = +500k, OHNE Ereignis-Gebühr-Abzug.
  assert.strictEqual(g.players[0].budget, before + D.LOS_PASS_BONUS, 'vollständiger Los-Bonus');
});

// ---------------------------------------------------------------------
// Akzeptanz 3: Ereignis-Feld (wie ein Steuerfeld) — nur bei Landung
// ---------------------------------------------------------------------
test('Ereignis-Feld: Landung löst Gebühr/Bonus aus, KEIN Eigentum', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  g.fields[6].type = 'ereignis';
  g.fields[6].fee = 0; // explizit kein Effekt für Grundtest
  g.players[0].pos = 5;
  const aBefore = g.players[0].budget;
  rollExact(g, 1);
  assert.strictEqual(g.players[0].pos, 6, 'A auf Feld 6');
  assert.strictEqual(g.fields[6].type, 'ereignis', 'Feld 6 ist Ereignis-Typ');
  // fee=0 → kein Effekt, kein Eigentum.
  assert.ok(!g.players[0].properties[6], 'kein Eigentum auf Ereignis-Feld');
  assert.strictEqual(g.players[0].budget, aBefore, 'kein Effekt (fee=0)');

  // Feld 6 auf Gebühr setzen und erneut prüfen
  g.fields[6].fee = 20000;
  g.players[0].pos = 5;
  g.rolled = false;
  const aBefore2 = g.players[0].budget;
  rollExact(g, 1);
  assert.strictEqual(g.players[0].budget, aBefore2 - 20000, 'Ereignis-Gebühr an die Bank');
  assert.ok(!g.players[0].properties[6], 'weiterhin kein Eigentum');
});

// ---------------------------------------------------------------------
// Akzeptanz 3b: Neue Feldtypen (Gefängnis, Frei Parken, Steuer)
// ---------------------------------------------------------------------
test('Gefängnis: Landung bietet Wahl (Freikauf per bail() oder absitzen)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  g.fields[6].type = 'gefangnis';
  g.fields[6].fee = 40000; // Lösegeld
  // A lande auf Gefängnis (Feld 6) → wird inhaftiert, KEIN Auto-Zahlung;
  // es wird die Wahl angeboten (jailBail gesetzt).
  g.players[0].pos = 5;
  const before = g.players[0].budget;
  rollExact(g, 1);
  assert.strictEqual(g.players[0].pos, 6, 'A auf Feld 6');
  assert.strictEqual(g.players[0].jailed, true, 'A wird inhaftiert');
  assert.strictEqual(g.players[0].jailBail, 40000, 'Lösegeld als Wahl angeboten');
  assert.strictEqual(g.players[0].budget, before, 'NICHTS automatisch bezahlt');
  // Freikauf per bail(): zahlt Lösegeld, wird frei, Zug endet
  const br = g.bail();
  assert.ok(br && br.ok, 'bail ok');
  assert.strictEqual(g.players[0].jailed, false, 'nach Freikauf frei');
  assert.strictEqual(g.players[0].budget, before - 40000, 'Lösegeld erst beim Freikauf bezahlt');
});

test('Steuer & Frei Parken: Steuer zahlt festen Betrag; Frei Parken neutral', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  g.fields[6].type = 'steuer';
  g.fields[6].fee = 50000;
  g.players[0].pos = 5;
  const before = g.players[0].budget;
  rollExact(g, 1);
  assert.strictEqual(g.players[0].budget, before - 50000, 'Steuer-Betrag an die Bank');

  g.fields[6].type = 'freiparken';
  g.players[0].pos = 5; g.rolled = false;
  const before2 = g.players[0].budget;
  rollExact(g, 1);
  assert.strictEqual(g.players[0].budget, before2, 'Frei Parken: kein Effekt');
});

// ---------------------------------------------------------------------
// Akzeptanz 4: Bankrott — Spiel endet bei 1 Team
// ---------------------------------------------------------------------
test('Bankrott: Team ohne Geld scheidet aus; Spiel endet bei 1 verbleibendem Team', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  g.activeIdx = 1;
  g.players[1].pos = 15;
  g.players[1].budget = 2000000;
  assert.strictEqual(g.players[1].properties[15] === undefined, true);
  g.buy();
  assert.ok(g.players[1].properties[15], 'B besitzt Feld 15');
  // (2g#12) Monopoly-Bauregel: Ausbau erfordert die ganze Farbgruppe im selben
  // Besitz. B bekommt die übrigen band1-Felder (2,3,5,8,9,10,13,14) zugewiesen.
  [2, 3, 5, 8, 9, 10, 13, 14].forEach((fid) => { g.players[1].properties[fid] = { level: 'ALLEIN' }; });
  g.build(15);
  assert.strictEqual(g.players[1].properties[15].level, 'CYCLONE');

  g.activeIdx = 0;
  g.players[0].budget = 100000;
  g.players[0].pos = 14;
  rollExact(g, 1);
  assert.strictEqual(g.players[0].pos, 15, 'A auf Feld 15');
  // Neue Regel: nicht sofort bankrott — A ist in Zahlungsrückstand (Sanierungsphase),
  // scheidet aber am Zugende aus, wenn es nicht sanieren kann (hier: kein Eigentum).
  assert.strictEqual(g.players[0].insolvent, true, 'A ist zunächst in Zahlungsrückstand');
  assert.strictEqual(g.players[0].bankrupt, false, 'A ist noch nicht bankrott (Sanierungsphase)');
  assert.ok(g.players[0].budget < 0, 'A hat überzogenes (negatives) Konto');
  // Zugende: A kann nicht sanieren → Bankrott.
  g.nextTurn();
  assert.strictEqual(g.players[0].bankrupt, true, 'A ist am Zugende bankrott');

  g.activeIdx = 2;
  g.rolled = false; // neuer Zug (Bankrott-Fall C)
  g.players[2].budget = 50000;
  g.players[2].pos = 14;
  rollExact(g, 1);
  assert.strictEqual(g.players[2].insolvent, true, 'C ist zunächst in Zahlungsrückstand');
  assert.strictEqual(g.players[2].bankrupt, false, 'C noch nicht bankrott');
  g.nextTurn();
  assert.strictEqual(g.players[2].bankrupt, true, 'C ist am Zugende bankrott');
  assert.strictEqual(g.over, true, 'Spiel ist vorbei');
  assert.strictEqual(g.winnerInfo.name, 'B', 'B gewinnt');
});

// ---------------------------------------------------------------------
// Akzeptanz 5-A: Kauf/Skip auf freiem Grundstück
// ---------------------------------------------------------------------
test('Kaufentscheidung: buy() kauft, skip() lässt offen', () => {
  const g = makeGame([{ name: 'A' }]);
  g.players[0].pos = 0;
  const res = rollExact(g, 1);
  assert.strictEqual(res.to, 1);
  assert.strictEqual(res.canBuy, true, 'Kauf möglich');
  const before = g.players[0].budget;
  assert.strictEqual(g.buy(), true, 'buy erfolgreich');
  assert.strictEqual(g.players[0].properties[1] !== undefined, true);
  assert.strictEqual(g.players[0].budget, before - FIELDS[1].price);
});

// ---------------------------------------------------------------------
// Akzeptanz 5-B: build() erhöht Stufen; Armistice nur wenn aktiviert
// ---------------------------------------------------------------------
test('Ausbau: stufenweise, gleichmäßig in der Farbgruppe (Monopoly-Bauregel), Armistice nur bei Aktivierung', () => {
  const g = makeGame([{ name: 'A' }], { armistice: false, capital: 9000000 });
  g.players[0].pos = 11;
  rollExact(g, 0);
  g.buy();
  // (2g#12) Monopoly-Bauregel: Ausbau nur in der ganzen Farbgruppe im selben
  // Besitz (v1: weiße Gruppe = 11,12) und gleichmäßig (max − min ≤ 1 Stufe).
  const GROUP = [11, 12];
  [12].forEach((fid) => { g.players[0].properties[fid] = { level: 'ALLEIN' }; });
  // Einseitiger Ausbau: nur Feld 11 eine Stufe hoch ist erlaubt (Differenz 1) …
  assert.strictEqual(g.build(11), true, 'erster Ausbau ok (Farbgruppe im Besitz)');
  // … aber eine Lücke (>1 über der schwächsten Stufe der Gruppe) wird abgelehnt.
  assert.strictEqual(g.build(11), false, 'Lücke abgelehnt: keine Stufe >1 über der schwächsten der Farbgruppe');
  // Gleichmäßig nachziehen: Rest der Gruppe auf CYCLONE, dann alle auf STORM, dann BALLISTA.
  [12].forEach((fid) => { assert.strictEqual(g.build(fid), true, 'CYCLONE Feld ' + fid); });
  ['STORM', 'BALLISTA'].forEach((lvl) => {
    GROUP.forEach((fid) => { assert.strictEqual(g.build(fid), true, lvl + ' Feld ' + fid); });
  });
  assert.strictEqual(g.players[0].properties[11].level, 'BALLISTA');
  assert.strictEqual(g.build(11), false, 'Armistice deaktiviert → kein weiterer Ausbau');

  const g2 = makeGame([{ name: 'A' }], { armistice: true, capital: 9000000 });
  g2.players[0].pos = 11;
  rollExact(g2, 0);
  g2.buy();
  [12].forEach((fid) => { g2.players[0].properties[fid] = { level: 'ALLEIN' }; });
  ['CYCLONE', 'STORM', 'BALLISTA'].forEach((lvl) => {
    GROUP.forEach((fid) => { assert.strictEqual(g2.build(fid), true, lvl + ' Feld ' + fid); });
  });
  GROUP.forEach((fid) => { assert.strictEqual(g2.build(fid), true, 'Armistice aktiviert → Endstufe (ARMISTICE) Feld ' + fid); });
  assert.strictEqual(g2.players[0].properties[11].level, 'ARMISTICE');
  assert.strictEqual(g2.build(11), false, 'Cap erreicht');
});

// ---------------------------------------------------------------------
// Akzeptanz 6: Persistenz — serialize/deserialize identisch
// ---------------------------------------------------------------------
test('Persistenz: serialize→deserialize erhält Zustand exakt', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  g.activeIdx = 0; g.players[0].pos = 2; rollExact(g, 0); g.buy();
  // (2g#12) Monopoly-Bauregel: volle band1-Farbgruppe (2,3,5,8,9,10,13,14,15)
  // muss A gehören UND gleichmäßig sein → Rest auf CYCLONE, dann Feld 2 zweimal.
  [3, 5, 8, 9, 10, 13, 14, 15].forEach((fid) => { g.players[0].properties[fid] = { level: 'CYCLONE' }; });
  g.build(2); g.build(2);
  g.activeIdx = 1; g.players[1].pos = 7; rollExact(g, 0); g.buy(); // B kauft band0-Feld 7
  const stateBefore = g.serialize();
  const g2 = G.deserialize(stateBefore, D);
  assert.strictEqual(JSON.stringify(g2.serialize()), JSON.stringify(g.serialize()), 'Zustand identisch nach Round-Trip');
  assert.strictEqual(g2.players[0].properties[2].level, 'STORM');
  assert.strictEqual(g2.players[0].budget, g.players[0].budget);
});

// ---------------------------------------------------------------------
// Akzeptanz 7: Setup-Constraints + Preset + formatUAEC
// ---------------------------------------------------------------------
test('Setup-Constraints: MIN_TEAMS=2, MAX_TEAMS=8', () => {
  assert.strictEqual(D.MIN_TEAMS, 2);
  assert.strictEqual(D.MAX_TEAMS, 8);
});

test('Preset "Stantonopoly v1": 16 Felder, Orison LOS, Spezial-Grundstück auf Index 6', () => {
  const p = D.PRESETS['Stantonopoly v1'];
  assert.strictEqual(p.fields.length, 16);
  assert.strictEqual(p.fields[0].type, 'los');
  assert.strictEqual(p.fields[0].name, 'Orison');
  assert.strictEqual(p.fields[6].type, 'spezial');
  assert.strictEqual(p.fields[6].name, 'Covalex Hub Gundo');
  assert.strictEqual(p.fields[6].fee, 125000);
});

test('formatUAEC: deutsche Tausenderpunkte ohne Dezimalkomma', () => {
  assert.strictEqual(D.formatUAEC(1500000), '1.500.000');
  assert.strictEqual(D.formatUAEC(30000), '30.000');
  assert.strictEqual(D.formatUAEC(0), '0');
});

// Farbgruppen-Konvention der Bänder (für Board-CSS, aus Brief)
test('Farbgruppen: Preisbänder decken 300k/400k/500k/600k ab', () => {
  const prices = FIELDS.filter((f) => f.type === 'grundstueck').map((f) => f.price);
  assert.ok(prices.includes(300000));
  assert.ok(prices.includes(400000));
  assert.ok(prices.includes(500000));
  assert.ok(prices.includes(600000));
});

// =====================================================================
// Runde 2m — P13/P14: Monopoly-Bauregel in zwei Regeln; gleichmäßiger
// Aus- UND Abbau symmetrisch.
// =====================================================================
// Stantonopoly v1: die weiße Farbgruppe ist 11, 12 (Terra Mills + Gallete Farms).
const GROUP0 = [11, 12];

function ownWholeGroup(game, playerIdx, groupIds) {
  groupIds.forEach((fid) => { game.players[playerIdx].properties[fid] = { level: 'ALLEIN' }; });
}

test('2m P13: Besitzregel AUS + Gleichmäßig AUS → einzeln ohne Gruppen-Zwang bauen', () => {
  const g = makeGame([{ name: 'A' }], { capital: 9000000, settings: { buildGroupOwnership: false, buildGroupEven: false } });
  g.players[0].pos = 11; rollExact(g, 0); g.buy();
  // Nur Feld 11 besessen — ohne Besitzregel darf darauf trotzdem gebaut werden.
  assert.strictEqual(g.build(11), true, 'ohne Gruppen-Regeln einzeln bauen ok');
  assert.strictEqual(g.players[0].properties[11].level, 'CYCLONE');
  // ... und sogar einseitig weiter (keine Gleichmäßig-Pflicht).
  assert.strictEqual(g.build(11), true);
  assert.strictEqual(g.build(11), true);
  assert.strictEqual(g.players[0].properties[11].level, 'BALLISTA');
});

test('2m P13: Besitzregel AN + Gleichmäßig AUS → ganze Gruppe nötig, aber ungleichmäßig erlaubt', () => {
  const g = makeGame([{ name: 'A' }], { capital: 9000000, settings: { buildGroupOwnership: true, buildGroupEven: false } });
  g.players[0].pos = 11; rollExact(g, 0); g.buy();
  // Ohne Rest der Gruppe: Ausbau abgelehnt (Besitzregel).
  assert.strictEqual(g.build(11), false, 'ohne ganze Gruppe abgelehnt (Besitzregel)');
  ownWholeGroup(g, 0, GROUP0);
  // Ausbau jetzt erlaubt, und einseitig auf Feld 11 weiter (Gleichmäßig ist AUS).
  assert.strictEqual(g.build(11), true, 'mit voller Gruppe bauen ok');
  assert.strictEqual(g.build(11), true, 'ungleichmäßig erlaubt (Gleichmäßig AUS)');
  assert.strictEqual(g.players[0].properties[11].level, 'STORM');
  assert.strictEqual(g.players[0].properties[12].level, 'ALLEIN', 'Rest der Gruppe bleibt Standard');
});

test('2m P13: Besitz + Gleichmäßig AN → ganzer Besitz UND gleichmäßig', () => {
  const g = makeGame([{ name: 'A' }], { capital: 9000000, settings: { buildGroupOwnership: true, buildGroupEven: true } });
  g.players[0].pos = 11; rollExact(g, 0); g.buy();
  assert.strictEqual(g.build(11), false, 'ohne Gruppe abgelehnt');
  ownWholeGroup(g, 0, GROUP0);
  assert.strictEqual(g.build(11), true, 'erster Ausbau (Differenz 1)');
  // Lücke: einseitig nochmal auf Feld 11 → Differenz 2 über dem Rest → abgelehnt.
  assert.strictEqual(g.build(11), false, 'Lücke abgelehnt (gleichmäßig)');
  // Rest der Gruppe nachziehen → dann wieder bauen möglich.
  [12].forEach((fid) => assert.strictEqual(g.build(fid), true, 'CYCLONE Feld ' + fid));
  assert.strictEqual(g.build(11), true, 'nach gleichmäßig Nachziehen weiter bauen');
});

test('2m P14: Gleichmäßige-Regel gilt AUCH beim Abbau', () => {
  const g = makeGame([{ name: 'A' }], { capital: 9000000, settings: { buildGroupOwnership: true, buildGroupEven: true } });
  g.players[0].pos = 11; rollExact(g, 0); g.buy();
  ownWholeGroup(g, 0, GROUP0);
  // Alle auf CYCLONE, dann Feld 11 auf STORM (Differenz 1 — erlaubt).
  [11, 12].forEach((fid) => g.build(fid));
  g.build(11); // Feld 11 → STORM
  assert.strictEqual(g.players[0].properties[11].level, 'STORM');
  // Sanity: Differenz 1 → Abbau des höchsten Feldes erlaubt.
  const r1 = g.demolish(11);
  assert.equal(r1.ok, true, 'höchstes Feld abbauen ok (nach Abbau Differenz 0)');
  assert.strictEqual(g.players[0].properties[11].level, 'CYCLONE');
  // Alle wieder gleich CYCLONE; dann REST der Gruppe auf ALLEIN ziehen ist verboten,
  // weil Differenz 2 entstünde — das höchste Feld zuerst entfernen geht nicht tiefer.
  g.build(11); // zurück nach STORM? Nein — build(11) von CYCLONE→STORM ok (Differenz 1).
  assert.strictEqual(g.players[0].properties[11].level, 'STORM');
  // Ein mittleres Feld (12) von CYCLONE auf ALLEIN abzubauen → Differenz 2 (STORM vs ALLEIN) → abgelehnt.
  const r2 = g.demolish(12);
  assert.equal(r2.ok, false, 'ungleichmäßiges Abreißen abgelehnt (even_demolish)');
  assert.strictEqual(g.players[0].properties[12].level, 'CYCLONE', 'Feld 12 bleibt CYCLONE');
  // Aber wenn Feld 11 zuerst auf CYCLONE abgebaut wird (gleichmäßig), dann ist alles einheitlich.
  assert.equal(g.demolish(11).ok, true, 'Feld 11 abbauen → alles CYCLONE (Differenz 0)');
  // Jetzt einheitlich: Abbau von 12 auf ALLEIN → Differenz 1 → erlaubt.
  const r3 = g.demolish(12);
  assert.equal(r3.ok, true, 'im Gleichstand angrenzend abbauen ok');
});