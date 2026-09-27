/**
 * Runde 2o — Task A: Server-Gameplay-Regeln (Miete bei beliehen P4, Hypothek/
 * Kauf beliehen P3/P6, Verkauf bebaut P8, buildGroupOwnership-Hypothek P5,
 * Gefängnis-Wahl nur Landender P2).
 *
 *  - Engine-Unit-Tests (hier): reine Spiellogik.
 *  - Wire-Tests (rooms/index) in tests/phase2o-wire.test.js.
 *
 * Start: node --test tests/phase2o.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const D = require(path.join(__dirname, '..', 'server', 'engine', 'data.js'));
const G = require(path.join(__dirname, '..', 'server', 'engine', 'engine.js'));

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

const GROUP0 = [1, 4, 7, 11, 12]; // band0 (Preis ≤ 400k)

// ---------------------------------------------------------------------
// P4: Beliehenes Feld kassiert KEINE Miete
// ---------------------------------------------------------------------
test('2o P4: Landung auf fremdem beliehenen Grundstück → keine Miete (kein Transfer)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 1000000 });
  // A besitzt Feld 15, beliehen.
  g.players[0].properties[15] = { level: 'ALLEIN', mortgaged: true, mortgagedValue: 450000 };
  g.activeIdx = 1;               // B ist am Zug
  const bBefore = g.players[1].budget;
  const aBefore = g.players[0].budget;
  g.players[1].pos = 15;         // B steht schon vor Feld 15…
  const res = rollExact(g, 0);   // …und landet darauf
  assert.strictEqual(res.to, 15, 'B landet auf Feld 15');
  assert.strictEqual(g.players[1].budget, bBefore, 'B zahlt KEINE Miete');
  assert.strictEqual(g.players[0].budget, aBefore, 'Besitzer erhält NICHTS');
  assert.strictEqual(g.players[1].insolvent, false, 'kein Zahlungsrückstand');
  // Log/Hinweis erwähnt, dass keine Miete fällig ist.
  assert.ok(g.log.some((l) => /beliehen/.test(l) && /keine Miete/.test(l)), 'Log-Hinweis „keine Miete“');
});

test('2o P4: fremdes NICHT beliehenes Feld kassiert weiterhin Miete (Regression)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 1000000 });
  g.players[0].properties[15] = { level: 'ALLEIN' }; // nicht beliehen
  g.activeIdx = 1;
  const bBefore = g.players[1].budget;
  const aBefore = g.players[0].budget;
  g.players[1].pos = 15;
  rollExact(g, 0);
  assert.ok(g.players[1].budget < bBefore, 'B zahlt Miete');
  assert.ok(g.players[0].budget > aBefore, 'A erhält Miete');
});

// ---------------------------------------------------------------------
// P6: Keine Hypothek auf ein bebautes Feld
// ---------------------------------------------------------------------
test('2o P6: Hypothek auf bebautes Feld → abgelehnt (BUILT_NOT_MORTGAGEABLE)', () => {
  // Ohne Gruppen-Besitzregel kann ein Einzelfeld direkt ausgebaut werden.
  const g = makeGame([{ name: 'A' }], { capital: 9000000, settings: { buildGroupOwnership: false, buildGroupEven: false } });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  assert.strictEqual(g.build(1), true, 'Ausbau ok (ohne Gruppen-Regeln)');
  assert.strictEqual(g.players[0].properties[1].level, 'CYCLONE');
  const r = g.mortgage(1);
  assert.strictEqual(r.ok, false, 'Hypothek abgelehnt');
  assert.strictEqual(r.reason, 'BUILT_NOT_MORTGAGEABLE', 'reason');
  assert.ok(r.notify && typeof r.notify === 'string' && r.notify.length > 0, 'notify-Satz vorhanden');
  assert.strictEqual(g.players[0].properties[1].mortgaged, undefined, 'Feld bleibt unbelastet');
});

test('2o P6: Hypothek auf unausgebautes Feld ist weiterhin erlaubt', () => {
  const g = makeGame([{ name: 'A' }], { capital: 1000000 });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  const r = g.mortgage(1);
  assert.strictEqual(r.ok, true, 'Hypothek ok');
  assert.strictEqual(g.players[0].properties[1].mortgaged, true);
});

// ---------------------------------------------------------------------
// P8: Bebautes Feld darf nicht verkauft/versteigert werden
// ---------------------------------------------------------------------
test('2o P8: bebautes Feld an die BANK verkaufen → abgelehnt (BANK_BUY_BUILT)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 9000000, settings: { buildGroupOwnership: false } });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  g.build(1);
  const r = g.sellProperty(1, -1, 0); // buyerIdx -1 = Bank
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'BANK_BUY_BUILT');
  assert.ok(r.notify && r.notify.length > 0);
  assert.ok(g.players[0].properties[1], 'Eigentum bleibt beim Besitzer');
});

test('2o P8: bebautes Feld an ein anderes TEAM verkaufen → abgelehnt (BUILT_NOT_SELLABLE)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 9000000, settings: { buildGroupOwnership: false } });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  g.build(1);
  const r = g.sellProperty(1, 1, 100000); // B kauft von A
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'BUILT_NOT_SELLABLE');
  assert.ok(r.notify && r.notify.length > 0);
  assert.ok(g.players[0].properties[1], 'A behält das Feld');
  assert.ok(!g.players[1].properties[1], 'B hat es nicht');
});

test('2o P8: bebautes Feld versteigern → abgelehnt (startAuction BUILT_NOT_SELLABLE)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 9000000, settings: { buildGroupOwnership: false } });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  g.build(1);
  const r = g.startAuction({ ownerIdx: 0, fieldIdx: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'BUILT_NOT_SELLABLE');
});

test('2o P8: unausgebautes Feld verkaufen bleibt erlaubt (Regression)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 1000000 });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  const r = g.sellProperty(1, 1, 100000);
  assert.strictEqual(r.ok, true, 'unausgebaut verkaufen ok');
  assert.ok(g.players[1].properties[1]);
});

// ---------------------------------------------------------------------
// P5: Beliehenes Gruppenfeld blockt Ausbau (GROUP_MORTGAGED)
// ---------------------------------------------------------------------
test('2o P5: beliehenes Gruppenfeld → kein Ausbau anderer Gruppenfelder', () => {
  const g = makeGame([{ name: 'A' }], { capital: 9000000, settings: { buildGroupOwnership: true, buildGroupEven: false } });
  GROUP0.forEach((fid) => { g.players[0].properties[fid] = { level: 'ALLEIN' }; });
  // Feld 1 beleihen (unausgebaut, ohne Gruppen-Bau → keine GROUP_NOT_DEMOLISHED-Sperre).
  g.players[0].properties[1].mortgaged = true;
  g.players[0].properties[1].mortgagedValue = Math.round(D.mortgage(400000));
  const r = g.build(4);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'GROUP_MORTGAGED');
  assert.ok(r.notify && r.notify.length > 0, 'notify-Satz vorhanden');
  assert.strictEqual(g.players[0].properties[4].level, 'ALLEIN', 'Feld 4 bleibt unausgebaut');
});

test('2o P5: ohne Beliehenheit in der Gruppe ist Ausbau erlaubt (Regression)', () => {
  const g = makeGame([{ name: 'A' }], { capital: 9000000, settings: { buildGroupOwnership: true, buildGroupEven: false } });
  GROUP0.forEach((fid) => { g.players[0].properties[fid] = { level: 'ALLEIN' }; });
  assert.strictEqual(g.build(4), true, 'ohne beliehenes Gruppenfeld bauen ok');
});

// ---------------------------------------------------------------------
// P5: Hypothek auf Gruppenfeld nur, wenn ALLE Gebäude abgebaut (GROUP_NOT_DEMOLISHED)
// ---------------------------------------------------------------------
test('2o P5: Hypothek auf Gruppenfeld mit ausgebautem Nachbar → abgelehnt (GROUP_NOT_DEMOLISHED)', () => {
  const g = makeGame([{ name: 'A' }], { capital: 9000000, settings: { buildGroupOwnership: true, buildGroupEven: false } });
  GROUP0.forEach((fid) => { g.players[0].properties[fid] = { level: 'ALLEIN' }; });
  g.build(1); // Feld 1 auf CYCLONE
  assert.strictEqual(g.players[0].properties[1].level, 'CYCLONE');
  const r = g.mortgage(4); // anderes Gruppenfeld beleihen
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'GROUP_NOT_DEMOLISHED');
  assert.ok(r.notify && r.notify.length > 0);
});

test('2o P5: Hypothek auf Gruppenfeld erlaubt, wenn alle Gebäude der Gruppe abgebaut', () => {
  const g = makeGame([{ name: 'A' }], { capital: 9000000, settings: { buildGroupOwnership: true, buildGroupEven: false } });
  GROUP0.forEach((fid) => { g.players[0].properties[fid] = { level: 'ALLEIN' }; });
  assert.strictEqual(g.mortgage(4).ok, true, 'bei komplett abgebauter Gruppe ok');
});

// ---------------------------------------------------------------------
// P2: Gefängnis-Wahl ist an den LANDENDEN gerichtet (playerId)
// ---------------------------------------------------------------------
test('2o P2: Gefängnis-Wahl-Event trägt die playerId des Landenden', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  g.fields[6].type = 'gefangnis';
  g.fields[6].fee = 40000;
  g.players[0].pos = 5;
  const res = rollExact(g, 1); // A (id 0) landet auf Gefängnis 6
  assert.strictEqual(res.to, 6);
  const jailEvents = res.events.filter((e) => e && typeof e === 'object' && e.kind === 'jail-choice');
  assert.ok(jailEvents.length >= 1, 'JailChoice-Event vorhanden');
  jailEvents.forEach((e) => {
    assert.strictEqual(e.playerId, g.players[0].id, 'playerId = Landender (Team A, id 0)');
  });
  assert.strictEqual(g.players[0].jailBail, 40000);
});

// ---------------------------------------------------------------------
// P3: Kauf eines beliehenen Feldes → Wahl (belassen nach 10 % / sofort entlasten)
// ---------------------------------------------------------------------
test('2o P3: Team-Kauf eines beliehenen Feldes erzwingt Wahl (keep = 10 % Zins)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 5000000 });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  g.activeIdx = 0;
  // A beleiht Feld 1 (400000 × 0.75 = 300000).
  assert.strictEqual(g.mortgage(1).ok, true);
  assert.strictEqual(g.players[0].properties[1].mortgaged, true);
  const mv = g.players[0].properties[1].mortgagedValue;
  const rate = 1.10;
  const interest = Math.round(mv * (rate - 1));
  const fullClear = Math.round(mv * rate);
  assert.strictEqual(mv, 300000);

  // B kauft von A für 50000. (A bleibt aktiver Verkäufer.)
  const sell = g.sellProperty(1, 1, 50000);
  assert.strictEqual(sell.ok, true, 'unausgebaut beliehen verkaufen ok');
  assert.strictEqual(sell.mortgageChoiceRequired, true, 'Wahl erforderlich');

  const mc = g.mortgageChoice;
  assert.ok(mc, 'mortgageChoice gesetzt');
  assert.strictEqual(mc.buyerIdx, 1, 'Käufer ist B');
  assert.strictEqual(mc.fieldIdx, 1);
  assert.strictEqual(mc.interest, interest, '10 % Zins nur');
  assert.strictEqual(mc.fullClear, fullClear, 'Hypothek + 10 % Zins in einem');
  // Das Feld gehört B und ist beliehen (incl. mortgagedValue).
  assert.ok(g.players[1].properties[1], 'B besitzt das Feld');
  assert.strictEqual(g.players[1].properties[1].mortgaged, true, 'bei Übernahme beliehen');

  // Option (a) keep: 10 % Zins zahlen, Feld bleibt beliehen.
  const bBefore = g.players[1].budget;
  const keep = g.resolveMortgageChoice(1, 'keep');
  assert.strictEqual(keep.ok, true);
  assert.strictEqual(keep.choice, 'keep');
  assert.strictEqual(keep.pay, interest);
  assert.strictEqual(g.players[1].budget, bBefore - interest, 'nur 10 % Zins gezahlt');
  assert.strictEqual(g.players[1].properties[1].mortgaged, true, 'weiter beliehen');
  assert.strictEqual(g.players[1].properties[1].mortgagedValue, 300000, 'mortgagedValue bleibt');
  assert.strictEqual(g.mortgageChoice, null, 'Wahl aufgelöst');
});

test('2o P3: Team-Kauf eines beliehenen Feldes — Option clear = sofort voll entlasten', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 5000000 });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  g.activeIdx = 0;
  g.mortgage(1);
  assert.strictEqual(g.sellProperty(1, 1, 50000).ok, true);
  const mc = g.mortgageChoice;
  const fullClear = mc.fullClear;
  assert.strictEqual(fullClear, Math.round(300000 * 1.10));

  const bBefore = g.players[1].budget;
  const clr = g.resolveMortgageChoice(1, 'clear');
  assert.strictEqual(clr.ok, true);
  assert.strictEqual(clr.cleared, true);
  assert.strictEqual(clr.pay, fullClear);
  assert.strictEqual(g.players[1].budget, bBefore - fullClear, 'Hypothek + Zins in einem bezahlt');
  assert.strictEqual(g.players[1].properties[1].mortgaged, false, 'entlastet');
  assert.strictEqual(g.players[1].properties[1].mortgagedValue, undefined, 'kein Hypothekenwert mehr');
  assert.strictEqual(g.mortgageChoice, null, 'Wahl aufgelöst');
});

test('2o P3: Übernahme-Wahl ohne genug Geld → abgelehnt (no_money)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 5000000 });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  g.activeIdx = 0;
  g.mortgage(1);
  g.sellProperty(1, 1, 50000);
  g.players[1].budget = 5000; // zu wenig für Zins
  const r = g.resolveMortgageChoice(1, 'keep');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_money');
  assert.ok(r.notify && r.notify.length > 0);
  assert.ok(g.mortgageChoice, 'Wahl bleibt offen');
});

test('2o P3: Ersteigerung eines beliehenen Feldes setzt dieselbe Wahl (resolveAuction)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 5000000 });
  g.players[0].properties[1] = { level: 'ALLEIN', mortgaged: true, mortgagedValue: 300000, takenOver: true };
  // B ersteigert Feld 1 über die Besitzer-Auktion.
  g.startAuction({ ownerIdx: 0, fieldIdx: 1 });
  g.bidAuction(1, 100000);
  const res = g.resolveAuction(1);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.mortgageChoiceRequired, true, 'Wahl nach Ersteigerung');
  assert.strictEqual(g.mortgageChoice.buyerIdx, 1);
  assert.ok(g.players[1].properties[1] && g.players[1].properties[1].mortgaged, 'B hält Field beliehen');
  assert.strictEqual(g.resolveMortgageChoice(1, 'clear').ok, true);
  assert.strictEqual(g.players[1].properties[1].mortgaged, false);
});

// ---------------------------------------------------------------------
// Serialisierung: mortgageChoice überlebt den Round-Trip
// ---------------------------------------------------------------------
test('2o P3: mortgageChoice überlebt serialize→deserialize', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 5000000 });
  g.players[0].properties[1] = { level: 'ALLEIN' };
  g.activeIdx = 0;
  g.mortgage(1);
  g.sellProperty(1, 1, 50000);
  assert.ok(g.mortgageChoice, 'Wahl gesetzt');
  const g2 = G.deserialize(g.serialize(), D);
  assert.ok(g2.mortgageChoice, 'nach Deserialize noch da');
  assert.strictEqual(g2.mortgageChoice.buyerIdx, 1);
  assert.strictEqual(g2.resolveMortgageChoice(1, 'clear').ok, true);
});
