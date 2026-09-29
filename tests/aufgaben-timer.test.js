/**
 * Stantonopoly V2 — Aufgabenregel P4: Beschäftigtes-Team-Timer (rooms-Ebene)
 * Start: node --test tests/aufgaben-timer.test.js
 *
 * AC5: beschäftigtes Team am Zug → Timer (taskDeadline); ohne Complete →
 * auto nextTurn (Aufgabe offen); manueller nextTurn funktioniert;
 * Complete in Timer → weiter (kein Auto-Ende).
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMPDIR = process.env.TMPDIR || os.tmpdir();
const DB_PATH = path.join(TMPDIR, 'aufg-timer-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.db');
process.env.STANTONOPOLY_DB = DB_PATH;
process.env.NODE_ENV = 'test';

const D = require(path.join(__dirname, '..', 'server', 'engine', 'data.js'));
const G = require(path.join(__dirname, '..', 'server', 'engine', 'engine.js'));
const dbm = require(path.join(__dirname, '..', 'server', 'db.js'));
const { Rooms } = require(path.join(__dirname, '..', 'server', 'rooms.js'));

// Falscher Broadcaster (kein echtes socket.io nötig).
const fakeIO = { to: () => ({ emit: () => {} }) };

function makeGame(settings) {
  return G.createGame({
    data: D,
    players: [{ id: 0, name: 'A', task: 'Mine' }, { id: 1, name: 'B', task: 'Liefern' }],
    startingCapital: D.DEFAULT_CAPITAL,
    diceConfig: { kind: 'frei', freeValue: 0 },
    settings: settings || null
  });
}

function seedGame(gameId, engine, started = 1) {
  dbm.createGame({ gameId, gmCode: 'GM' + gameId, state: engine.serialize(), started, over: 0, name: 'Test' });
}

after(() => {
  try { require('fs').unlinkSync(DB_PATH); } catch (e) {}
});

test('AC5a: beschäftigtes Team am Zug → _armTaskTimer setzt taskDeadline', () => {
  const rooms = new Rooms(fakeIO);
  const g = makeGame({ tasksEnabled: true, tasksTurnTimerMs: 60000 });
  g.players[0].taskPending = true;
  seedGame('g1', g);
  rooms._armTaskTimer('g1');
  const row = dbm.getGame('g1');
  const eng = G.deserialize(row.state, D);
  assert.ok(eng.taskDeadline > Date.now(), 'taskDeadline gesetzt (Zukunft)');
  rooms._clearTaskTimer('g1');
  console.log('AC5a ok');
});

test('AC5b: Timer ohne Complete → auto nextTurn, Aufgabe bleibt offen', async () => {
  const rooms = new Rooms(fakeIO);
  const g = makeGame({ tasksEnabled: true, tasksTurnTimerMs: 60 });
  g.players[0].taskPending = true;
  seedGame('g2', g);
  rooms._armTaskTimer('g2');
  // Timer läuft ab (60ms + 250ms Puffer) → auto nextTurn
  await sleep(400);
  const row = dbm.getGame('g2');
  const eng = G.deserialize(row.state, D);
  assert.notStrictEqual(eng.activeIdx, 0, 'Zug endet automatisch');
  assert.strictEqual(eng.players[0].taskPending, true, 'Aufgabe bleibt offen');
  rooms._clearTaskTimer('g2');
  console.log('AC5b ok');
});

test('AC5c: manueller nextTurn funktioniert (Aufgabe bleibt offen)', () => {
  const rooms = new Rooms(fakeIO);
  const g = makeGame({ tasksEnabled: true, tasksTurnTimerMs: 60000 });
  g.players[0].taskPending = true;
  seedGame('g3', g);
  const row = dbm.getGame('g3');
  const eng = G.deserialize(row.state, D);
  eng.nextTurn();
  dbm.updateState('g3', { state: eng.serialize(), started: 1, over: 0 });
  const eng2 = G.deserialize(dbm.getGame('g3').state, D);
  assert.notStrictEqual(eng2.activeIdx, 0, 'manueller nextTurn wechselt Zug');
  assert.strictEqual(eng2.players[0].taskPending, true, 'Aufgabe bleibt offen');
  rooms._clearTaskTimer('g3');
  console.log('AC5c ok');
});

test('AC5d: Complete in Timer → Zug läuft weiter (kein Auto-Ende)', async () => {
  const rooms = new Rooms(fakeIO);
  const g = makeGame({ tasksEnabled: true, tasksTurnTimerMs: 200 });
  g.players[0].taskPending = true;
  seedGame('g4', g);
  rooms._armTaskTimer('g4');
  // Aufgabe rechtzeitig erledigen (vor Ablauf)
  const row = dbm.getGame('g4');
  const eng = G.deserialize(row.state, D);
  const comp = G.taskComplete(eng, 0);
  assert.strictEqual(comp.ok, true);
  dbm.updateState('g4', { state: eng.serialize(), started: 1, over: 0 });
  rooms._clearTaskTimer('g4');
  // Timer abwarten — da Aufgabe erledigt, darf KEIN Auto-nextTurn passieren.
  await sleep(500);
  const eng2 = G.deserialize(dbm.getGame('g4').state, D);
  assert.strictEqual(eng2.activeIdx, 0, 'kein Auto-Ende nach Complete');
  assert.strictEqual(eng2.players[0].taskPending, false, 'Aufgabe erledigt');
  console.log('AC5d ok');
});

// ---------------------------------------------------------------------------
// Wire-Pfad (rooms.taskComplete): Der Server-Methodenweg muss den schwebenden
// Kauf (pendingAction) über die ENGINE beim Abschluss wirksam machen — ein
// bloßes taskPending=false im rooms-Handler würde den P2-Commit verschlucken.
// ---------------------------------------------------------------------------
test('P2-WIRE: rooms.taskComplete überträgt Besitz eines schwebenden Kaufs', () => {
  const rooms = new Rooms(fakeIO);
  const g = makeGame({ tasksEnabled: true, tasksTurnTimerMs: 60000 });
  // A (players[0]) kauft per Engine ein freies Feld → pendingAction, kein Besitz.
  const card = (() => {
    for (let i = 1; i < g.fields.length; i++) {
      if (g.fields[i].type === 'grundstueck' && !g.players.some((p) => p.properties[i])) return i;
    }
    return 1;
  })();
  g.players[0].pos = card;
  g.canBuy = true;
  const ok = g.buy();
  assert.strictEqual(ok, true);
  assert.strictEqual(g.players[0].properties[card], undefined, 'vor Complete: kein Besitz');
  assert.ok(g.players[0].pendingAction && g.players[0].pendingAction.type === 'kauf', 'pendingAction kauf');
  // Team-/Player-/Leader-Rows anlegen, damit rooms.taskComplete das Team auflöst.
  dbm.upsertTeam({ gameId: 'w1', teamId: 'team_0', ship: 'Redeemer', color: '#2ecc71', invite_code: 'W1A', leaderId: 'sockA' });
  dbm.addPlayer({ id: 'sockA', gameId: 'w1', teamId: 'team_0', name: 'A' });
  // engine.players[0].id muss mit teamId übereinstimmen (String-Vergleich in _piOf).
  g.players[0].id = 'team_0';
  g.players[1].id = 'team_1';
  seedGame('w1', g);
  // rooms.taskComplete über den Wire-Pfad (Socket = Leader von team_0).
  const res = rooms.taskComplete({ gameId: 'w1', sock: { id: 'sockA' } });
  assert.strictEqual(res.error, undefined, 'taskComplete ok: ' + (res.error && res.error.code));
  const eng = G.deserialize(dbm.getGame('w1').state, D);
  assert.strictEqual(eng.players[0].taskPending, false, 'Aufgabe erledigt');
  assert.strictEqual(eng.players[0].pendingAction, undefined, 'pendingAction verbraucht');
  assert.strictEqual(eng.players[0].properties[card].level, 'ALLEIN', 'Besitz über Wire-Pfad übertragen');
  rooms._clearTaskTimer('w1');
  console.log('P2-WIRE ok');
});
