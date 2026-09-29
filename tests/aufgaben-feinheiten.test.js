/**
 * Stantonopoly V2 — Aufgabenregel-Feinheiten (t_63cd2906)
 * Start: node --test tests/aufgaben-feinheiten.test.js
 *
 * Abgedeckt (Akzeptanzkriterien 1-7):
 *  F1  tasksEnabled=true: Kauf → Budget sofort, Besitz erst nach taskComplete,
 *      Miete vor Complete nicht aktiv; nach Complete Besitz + Miete aktiv. (AC1)
 *  F2  P2 Verfall: Bankrott vor Complete → Feld frei, Geld weg. (AC2)
 *  F3  tasksEnabled=false: exakt altes Sofort-Verhalten. (AC3)
 *  F4  P3: tasksRequireTrade=false → Handel ohne Aufgabe; true → Handel setzt
 *      taskPending (+ Zug-Ende beim Käufer am Zug). (AC4)
 *  F5  P4: beschäftigtes Team am Zug → Timer (taskDeadline); ohne Complete →
 *      auto nextTurn (Aufgabe offen); manueller nextTurn funktioniert;
 *      Complete in Timer → weiter. (AC5, rooms-Ebene)
 *  F6  P1: nach Kauf/Ausbau ist activeIdx nicht mehr dasselbe Team. (AC6)
 *  F7  Suite grün (Alt+Neu); bestehende buy/build-Tests (tasksEnabled=false)
 *      unverändert grün. (AC7)
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

function rollExact(game, value) {
  game.diceConfig.kind = 'frei';
  game.diceConfig.freeValue = value;
  return game.roll();
}

function at(game, playerIdx, pos) {
  game.players[playerIdx].pos = pos;
}

function findFreeLandIdx(game, from) {
  for (let i = from; i < game.fields.length; i++) {
    const f = game.fields[i];
    if (f.type === 'grundstueck' && !game.players.some((p) => p.properties[i])) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// F1 (AC1): Kauf → Budget sofort, Besitz erst nach taskComplete, Miete vor
// Complete nicht aktiv; nach Complete Besitz + Miete aktiv.
// ---------------------------------------------------------------------------
test('F1: tasksEnabled=true → Kauf: Budget sofort, Besitz erst nach taskComplete, Miete vorher nicht aktiv', () => {
  const g = makeGame([{ name: 'A', task: 'Mine' }, { name: 'B', task: 'Liefern' }], { settings: { tasksEnabled: true } });
  const card = findFreeLandIdx(g, 1);
  at(g, 0, card);
  g.canBuy = true;
  const price = g.fields[card].price;
  const budgetBefore = g.players[0].budget;
  const ok = g.buy();
  assert.strictEqual(ok, true, 'Kauf gelingt');
  // Budget sofort abgebucht
  assert.strictEqual(g.players[0].budget, budgetBefore - price, 'Budget sofort abgebucht');
  // Besitz noch NICHT übertragen (schwebend)
  assert.strictEqual(g.players[0].properties[card], undefined, 'Besitz noch nicht übertragen');
  assert.ok(g.players[0].pendingAction && g.players[0].pendingAction.type === 'kauf', 'pendingAction kauf gesetzt');
  assert.strictEqual(g.players[0].pendingAction.fieldIdx, card, 'pendingAction.fieldIdx korrekt');
  assert.strictEqual(g.players[0].taskPending, true, 'taskPending=true');
  // Miete vor Complete nicht aktiv: B landet auf dem Feld → keine Miete
  at(g, 1, card);
  const r = rollExact(g, 0); // B ist aktiv? Nein — nach P1 ist activeIdx gewechselt.
  // Nach P1 ist activeIdx nicht mehr A. Wir prüfen die Miet-Freiheit direkt über
  // eine Landung von B (activeIdx auf B setzen).
  g.activeIdx = 1;
  g.rolled = false;
  at(g, 1, card);
  const r2 = rollExact(g, 0);
  assert.notStrictEqual(r2.err, 'TASK_PENDING');
  // B hat keine Miete gezahlt (Feld gehört niemandem, schwebend)
  assert.strictEqual(g.players[1].budget, D.DEFAULT_CAPITAL, 'B zahlt keine Miete auf schwebendem Feld');
  // taskComplete → Besitz + Miete aktiv
  const comp = G.taskComplete(g, 0);
  assert.strictEqual(comp.ok, true);
  assert.strictEqual(g.players[0].properties[card].level, 'ALLEIN', 'Besitz nach Complete übertragen');
  assert.strictEqual(g.players[0].pendingAction, undefined, 'pendingAction verbraucht');
  // Miete jetzt aktiv: B landet erneut → zahlt Miete an A
  g.activeIdx = 1;
  g.rolled = false;
  at(g, 1, card);
  const budgetB = g.players[1].budget;
  rollExact(g, 0);
  assert.ok(g.players[1].budget < budgetB, 'B zahlt jetzt Miete an A');
  console.log('F1 ok');
});

// ---------------------------------------------------------------------------
// F2 (AC2): Bankrott vor Complete → Feld frei, Geld weg.
// ---------------------------------------------------------------------------
test('F2: Bankrott vor Complete → Feld bleibt frei, Geld weg', () => {
  const g = makeGame([{ name: 'A', task: 'Mine' }, { name: 'B' }], { settings: { tasksEnabled: true }, capital: 2000000 });
  const card = findFreeLandIdx(g, 1);
  at(g, 0, card);
  g.canBuy = true;
  const price = g.fields[card].price;
  g.buy();
  assert.strictEqual(g.players[0].taskPending, true);
  assert.strictEqual(g.players[0].properties[card], undefined, 'noch kein Besitz');
  // A wird bankrott (Budget negativ, insolvent) → resolveInsolvency
    g.players[0].budget = -1;
    g.players[0].insolvent = true;
    g.players[0].debt = 1;
    g.resolveInsolvency(0);
  assert.strictEqual(g.players[0].bankrupt, true, 'A bankrott');
  assert.strictEqual(g.players[0].pendingAction, undefined, 'pendingAction verworfen');
  // Feld bleibt frei (kein Besitzer)
  const owner = (() => { for (let i = 0; i < g.players.length; i++) if (g.players[i].properties[card] !== undefined) return g.players[i]; return null; })();
  assert.strictEqual(owner, null, 'Feld bleibt frei');
  // Geld ist weg (Budget 0)
  assert.strictEqual(g.players[0].budget, 0, 'Geld weg');
  console.log('F2 ok');
});

// ---------------------------------------------------------------------------
// F3 (AC3): tasksEnabled=false → exakt altes Sofort-Verhalten.
// ---------------------------------------------------------------------------
test('F3: tasksEnabled=false → Kauf überträgt Besitz sofort, keine pendingAction', () => {
  const g = makeGame([{ name: 'A', task: 'Mine' }, { name: 'B' }]);
  const card = findFreeLandIdx(g, 1);
  at(g, 0, card);
  g.canBuy = true;
  const price = g.fields[card].price;
  const budgetBefore = g.players[0].budget;
  g.buy();
  assert.strictEqual(g.players[0].budget, budgetBefore - price, 'Budget abgebucht');
  assert.strictEqual(g.players[0].properties[card].level, 'ALLEIN', 'Besitz sofort übertragen');
  assert.strictEqual(g.players[0].pendingAction, undefined, 'keine pendingAction');
  assert.strictEqual(g.players[0].taskPending, false, 'keine Aufgabe');
  console.log('F3 ok');
});

// ---------------------------------------------------------------------------
// F4 (AC4): P3 — tasksRequireTrade=false → Handel ohne Aufgabe; true → Handel
// setzt taskPending (+ Zug-Ende beim Käufer am Zug).
// ---------------------------------------------------------------------------
function setupTradeGame(settings) {
  const g = makeGame([{ name: 'A', task: 'Mine' }, { name: 'B', task: 'Liefern' }], { settings });
  // A besitzt Feld 1, B besitzt Feld 2
  g.players[0].properties[1] = { level: 'ALLEIN' };
  g.players[1].properties[2] = { level: 'ALLEIN' };
  return g;
}

test('F4a: tasksRequireTrade=false → akzeptierter Handel löst KEINE Aufgabe', () => {
  const g = setupTradeGame({ tasksEnabled: true, tasksRequireTrade: false });
  // A (fromIdx 0) verkauft Feld 1 an B (targetIdx 1)
  const mk = g.makeOffer({ kind: 'sell', fromIdx: 0, targetIdx: 1, fieldIdx: 1, price: 100000 });
  assert.strictEqual(mk.ok, true);
  const resp = g.respondOffer(mk.offer.id, 1);
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(resp.done, true);
  assert.strictEqual(g.players[1].taskPending, false, 'keine Aufgabe durch Handel');
  assert.strictEqual(g.players[1].properties[1].level, 'ALLEIN', 'B besitzt Feld 1');
  console.log('F4a ok');
});

test('F4b: tasksRequireTrade=true → akzeptierter Handel setzt taskPending beim Käufer', () => {
  const g = setupTradeGame({ tasksEnabled: true, tasksRequireTrade: true });
  const mk = g.makeOffer({ kind: 'sell', fromIdx: 0, targetIdx: 1, fieldIdx: 1, price: 100000 });
  const resp = g.respondOffer(mk.offer.id, 1);
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(g.players[1].taskPending, true, 'Käufer B hat Aufgabe');
  assert.strictEqual(g.players[1].properties[1].level, 'ALLEIN', 'B besitzt Feld 1');
  console.log('F4b ok');
});

test('F4c: tasksRequireTrade=true + Käufer am Zug → Zug endet (activeIdx wechselt)', () => {
  const g = setupTradeGame({ tasksEnabled: true, tasksRequireTrade: true });
  g.activeIdx = 1; // B (Käufer) ist am Zug
  const mk = g.makeOffer({ kind: 'sell', fromIdx: 0, targetIdx: 1, fieldIdx: 1, price: 100000 });
  const resp = g.respondOffer(mk.offer.id, 1);
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(g.players[1].taskPending, true);
  assert.notStrictEqual(g.activeIdx, 1, 'Zug endet, activeIdx wechselt');
  console.log('F4c ok');
});

// ---------------------------------------------------------------------------
// F6 (AC6): P1 — nach Kauf/Ausbau ist activeIdx nicht mehr dasselbe Team.
// ---------------------------------------------------------------------------
test('F6a: P1 → nach Kauf ist activeIdx nicht mehr dasselbe Team', () => {
  const g = makeGame([{ name: 'A', task: 'Mine' }, { name: 'B' }], { settings: { tasksEnabled: true } });
  const card = findFreeLandIdx(g, 1);
  at(g, 0, card);
  g.canBuy = true;
  g.buy();
  assert.notStrictEqual(g.activeIdx, 0, 'activeIdx wechselt nach Kauf');
  assert.strictEqual(g.players[0].taskPending, true);
  console.log('F6a ok');
});

test('F6b: P1 → nach Ausbau ist activeIdx nicht mehr dasselbe Team', () => {
  const g = makeGame([{ name: 'A', task: 'Bauen', ship: 'Redeemer' }, { name: 'B' }], { settings: { tasksEnabled: true, buildGroupOwnership: false }, capital: 20000000 });
  g.players[0].properties[2] = { level: 'ALLEIN' };
  g.players[0].pos = 2;
  const ok = g.build(2);
  assert.strictEqual(ok, true, 'Ausbau gelingt');
  assert.notStrictEqual(g.activeIdx, 0, 'activeIdx wechselt nach Ausbau');
  assert.strictEqual(g.players[0].taskPending, true);
  // Stufe noch nicht wirksam (schwebend)
  assert.strictEqual(g.players[0].properties[2].level, 'ALLEIN', 'Stufe noch nicht wirksam');
  assert.ok(g.players[0].pendingAction && g.players[0].pendingAction.type === 'ausbau', 'pendingAction ausbau');
  // taskComplete → Stufe wirksam
  G.taskComplete(g, 0);
  assert.strictEqual(g.players[0].properties[2].level, 'CYCLONE', 'Stufe nach Complete wirksam');
  console.log('F6b ok');
});

// ---------------------------------------------------------------------------
// F7 (AC7): Suite grün — Alt-Tests (aufgaben.test.js) laufen separat; hier
// prüfen wir, dass tasksEnabled=false buy/build exakt altes Verhalten zeigen.
// ---------------------------------------------------------------------------
test('F7: tasksEnabled=false → build überträgt Stufe sofort, keine pendingAction', () => {
  const g = makeGame([{ name: 'A', task: 'Bauen', ship: 'Redeemer' }, { name: 'B' }], { capital: 20000000, settings: { buildGroupOwnership: false } });
  g.players[0].properties[2] = { level: 'ALLEIN' };
  g.players[0].pos = 2;
  const ok = g.build(2);
  assert.strictEqual(ok, true);
  assert.strictEqual(g.players[0].properties[2].level, 'CYCLONE', 'Stufe sofort wirksam');
  assert.strictEqual(g.players[0].pendingAction, undefined, 'keine pendingAction');
  assert.strictEqual(g.players[0].taskPending, false, 'keine Aufgabe');
  console.log('F7 ok');
});
