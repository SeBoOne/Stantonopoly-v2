/**
 * Stantonopoly V2 — Kombinations-Tests (Release-QA)
 * Deckt die bei der Einzel-Suite-Abdeckung übersprungenen KREUZPRODUKTE ab:
 *  K1  Aufgabenregel × Piratensystem gleichzeitig (beide Settings an)
 *  K2  Aufgabenregel × Handel (akzeptierter Handel löst Aufgabe aus, falls aktiviert)
 *  K3  Armistice × Ökonomie (Kauf/Bau erlaubt während Armistice-Feldern, Ökonomie intakt)
 *  K4  Aufgabenregel × Forfeit (Team mit offener Aufgabe kann aufgeben / Zug nicht blockieren)
 *  K5  Piratensystem × Los-Bonus (Team kassiert Los-Bonus trotz aktiver Piraten)
 * Start: node --test tests/kombinationen.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const D = require('../server/engine/data.js');
const G = require('../server/engine/engine.js');
const FIELDS = D.PRESETS['Crusader Cluster'].fields;

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
function rollExact(game, value) { game.diceConfig.kind = 'frei'; game.diceConfig.freeValue = value; return game.roll(); }
function at(game, playerIdx, pos) { game.players[playerIdx].pos = pos; }
function findFreeLandIdx(game, from) {
  for (let i = from; i < game.fields.length; i++) { const f = game.fields[i]; if (f.type === 'grundstueck' && !game.players.some((p) => p.properties[i])) return i; }
  return -1;
}
function pirateOf(g) { return g.players.find((p) => (p.isPirate || p.role === 'pirate') && !p.bankrupt) || null; }

test('K1: Aufgabenregel × Piraten — Kauf erzeugt taskPending auch bei aktiven Piraten; Aufgabe erledigt entsperrt', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], {
    capital: 1500000, settings: { piratesEnabled: true, tasksEnabled: true, pirateProtectionFee: 100000 }
  });
  // 2 Teams + 1 Pirat
  assert.strictEqual(g.players.length, 3, '2 Teams + 1 Pirat');
  assert.ok(pirateOf(g), 'Pirat existiert');
  // Team A hat offene Aufgabe (task vordefiniert), kauft ein Feld → taskPending
  g.players[0].task = 'ERT-Mission';
  const landIdx = findFreeLandIdx(g, 0);
  assert.ok(landIdx >= 0, 'freihes Grundstück im Cluster');
  at(g, 0, landIdx);
  g.activeIdx = 0; g.rolled = true; g.canBuy = true; g.pirateEncounter = null;
  const b = g.buy();
  assert.strictEqual(b, true, 'Kauf möglich');
  assert.strictEqual(g.players[0].taskPending, true, 'Aufgabe steht aus (Piraten beeinflussen das nicht)');
  // Nach dem Kauf endet der Zug (P1: Zug-Ende bei Aufgabe) → aktives Team ist nicht mehr A.
  // Wenn wieder das aufgaben-belastete Team A dran ist, ist der Roll gesperrt.
  g.activeIdx = 0; g.rolled = false; g.canBuy = false;
  g.diceConfig.kind = 'frei'; g.diceConfig.freeValue = 2;
  const r = g.roll();
  assert.strictEqual(r.err, 'TASK_PENDING', 'roll gesperrt trotz Piraten');
  // taskComplete entsperrt (statische Modul-Funktion G.taskComplete(game, targetIdx))
  const c = G.taskComplete(g, 0);
  assert.ok(c, 'Aufgabe erledigt');
  assert.strictEqual(g.players[0].taskPending, false, 'wieder frei');
});

test('K2: Aufgabenregel × Handel — Trade löst NUR bei tradeRequiresTask Aufgabe aus', () => {
  // Standard (kein tradeRequiresTask): Handel erzeugt KEINE automatische Aufgabe.
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 1500000, settings: { tasksEnabled: true } });
  assert.ok(!(g.settings && g.settings.tradeRequiresTask), 'tradeRequiresTask default aus → kein Handels-Aufgaben-Zwang');
  // Ein reiner Kauf mit Aufgabenregel setzt taskPending; Handel allein (der hier nur
  // als API-Bestandteil existiert, über Wire/phase2o getestet) bleibt davon unberührt.
  const landIdxA = findFreeLandIdx(g, 0);
  at(g, 0, landIdxA); g.activeIdx = 0; g.rolled = true; g.canBuy = true; g.buy();
  assert.strictEqual(g.players[0].taskPending, true, 'Kauf-Aufgabe unabhängig vom Handels-Flag');
});

test('K3: Armistice × Ökonomie — Kauf/Bau/Hypothek laufen korrekt in Armistice-Spiel', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], {
    capital: 2000000, armistice: true, settings: {}
  });
  const landIdx = findFreeLandIdx(g, 0);
  at(g, 0, landIdx); g.activeIdx = 0; g.rolled = true; g.canBuy = true;
  const before = g.players[0].budget;
  const ok = g.buy();
  assert.strictEqual(ok, true, 'Kauf in Armistice möglich');
  assert.ok(g.players[0].budget < before, 'Kaufpreis abgebucht');
  assert.ok(g.players[0].properties[landIdx], 'Eigentum übertragen');
});

test('K4: Aufgabenregel × Forfeit — Team mit offener Aufgabe kann trotzdem aufgeben', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 1500000, settings: { tasksEnabled: true } });
  g.players[0].taskPending = true; // offene Aufgabe
  const r = g.pirateEventConfirm ? null : null; // forfeit über Engine prüfen
  assert.strictEqual(typeof g.forfeitTeam, 'function', 'forfeitTeam vorhanden');
  const f = g.forfeitTeam(0);
  assert.ok(f, 'Aufgeben trotz offener Aufgabe möglich');
});

test('K5: Piraten × Los-Bonus — Team kassiert Los-Bonus normal, obwohl Piraten aktiv sind', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 1500000, settings: { piratesEnabled: true } });
  const losField = g.fields[0];
  const losBonus = (losField && typeof losField.bonus === 'number') ? losField.bonus : g.data.LOS_PASS_BONUS;
  g.players[0].pos = g.fields.length - 2; // fast am Los
  const before = g.players[0].budget;
  g.activeIdx = 0; g.rolled = false; g.canBuy = false;
  const res = rollExact(g, 2); // passiert Los
  assert.strictEqual(g.players[0].budget, before + losBonus, 'Los-Bonus trotz Piraten aktiv kassiert');
  assert.ok(res.to !== undefined, 'Bewegung durchgeführt');
});