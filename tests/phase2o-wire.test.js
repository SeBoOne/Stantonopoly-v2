/**
 * Runde 2o — Task A: Wire-Tests (rooms/index) für die neuen Server-Gameplay-
 * Regeln: P2 (Gefängnis-Wahl nur Landender), P3 (Kauf beliehen → Wahl), P4
 * (keine Miete bei beliehen), P5 (Group-Hypothek), P6 (Hypothek gebaut),
 * P8 (Verkauf gebaut). Strukturierte Ablehnungen liefern reason + notify.
 *
 * Start: node --test tests/phase2o-wire.test.js
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { io: ClientIO } = require('socket.io-client');

const D = require(path.join(__dirname, '..', 'server', 'engine', 'data.js'));
const G = require(path.join(__dirname, '..', 'server', 'engine', 'engine.js'));

const TMPDIR = process.env.TMPDIR || os.tmpdir();
const DB_PATH = path.join(TMPDIR, 'p2o-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.db');
const PORT = 18540;
process.env.STANTONOPOLY_DB = DB_PATH;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.STANTONOPOLY_INACTIVE_MS = '600000'; // Pause/Sweep im Test nicht stören
process.env.STANTONOPOLY_SWEEP_MS = '600000';

const mod = require(path.join(__dirname, '..', 'server', 'index.js'));
const srv = mod.start(PORT);
const { rooms } = mod;
const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));

const ALL = [];
const track = (c) => { ALL.push(c); return c; };

function connect(name) {
  const c = ClientIO(`http://localhost:${PORT}`, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 3000 });
  if (c.io && c.io.engine) c.io.engine.on('open', () => { c.io.engine.pingInterval = 0; c.io.engine.pingTimeout = 0; });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { c.disconnect(true); reject(new Error('Connect ' + name)); }, 5000);
    c.on('connect', () => { clearTimeout(to); resolve(c); });
    c.on('connect_error', (e) => { clearTimeout(to); c.disconnect(true); reject(new Error(name + ': ' + e.message)); });
  });
}

function once(client, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { client.off(event); reject(new Error('Timeout ' + event)); }, timeoutMs);
    client.once(event, (d) => { clearTimeout(to); resolve(d); });
  });
}
function waitState(client, predicate, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => { client.off('state', h); if (!done) reject(new Error('waitState timeout')); }, timeoutMs);
    const h = (st) => { if (done) return; if (predicate(st)) { done = true; clearTimeout(to); client.off('state', h); resolve(st); } };
    client.on('state', h);
  });
}
function onceErr(client, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { client.off('error', h); reject(new Error('Timeout error')); }, timeoutMs);
    const h = (err) => { clearTimeout(to); client.off('error', h); resolve(err); };
    client.once('error', h);
  });
}

after(() => {
  try { rooms._stopAutoSweep && rooms._stopAutoSweep(); } catch (e) {}
  try { srv.close && srv.close(); } catch (e) {}
  ALL.forEach((c) => { try { c.disconnect(true); } catch (e) {} });
});

// Erstellt + startet ein 2-Team-Spiel; gibt { gm, teams: [A, B], gameId } zurück.
// A = Team 0 (engine player idx 0), B = Team 1 (engine player idx 1).
// Die Leader-Sockets der Teams sind in den Arrays ([0]=A-Leader, [1]=B-Leader).
async function setupGame() {
  const gm = track(await connect('p2o-gm'));
  const createdP = once(gm, 'gameCreated');
  gm.emit('gm:create', { config: { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false, preset: 'Crusader Cluster' } });
  const ev = await createdP;

  const teamLeaders = [];
  for (const token of ev.tokens) {
    const cs = track(await connect('p2o-t-' + token.teamId));
    const j = once(cs, 'joined');
    cs.emit('team:join', { gameId: ev.gameId, code: token.code, playerName: 'P-' + token.teamId });
    await j; await sleep(40);
    teamLeaders.push(cs);
  }
  const startedP = waitState(teamLeaders[0], (s) => s && s.started === true, 6000);
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await startedP;
  await sleep(50);
  return { gm, teams: teamLeaders, gameId: ev.gameId };
}

// Engine-Zustand direkt in der DB setzen (State-Änderung, damit Wire-Aktionen
// gegen einen kontrollierten Zustand laufen).
function setEngine(gameId, mutate) {
  const engine = G.deserialize(dbMod.getGame(gameId).state, D);
  mutate(engine);
  dbMod.updateState(gameId, { state: engine.serialize(), started: 1, over: 0 });
  return engine;
}
function readEngine(gameId) {
  return G.deserialize(dbMod.getGame(gameId).state, D);
}

test('2o Wire P6: Hypothek auf bebautes Feld → error mit reason BUILT_NOT_MORTGAGEABLE + notify', async () => {
  const { teams, gameId } = await setupGame();
  setEngine(gameId, (e) => {
    e.settings.buildGroupOwnership = false;
    e.activeIdx = 0;                       // Team A (idx0) ist am Zug
    e.players[0].budget = 5000000;
    e.players[0].properties[1] = { level: 'CYCLONE' };
  });
  const errP = onceErr(teams[0]);
  teams[0].emit('action:mortgage', { gameId, field: 1 });
  const err = await errP;
  assert.strictEqual(err.reason, 'BUILT_NOT_MORTGAGEABLE');
  assert.ok(err.notify && err.notify.length > 0, 'notify-Satz');
  assert.strictEqual(err.code, 'ECON');
});

test('2o Wire P8: Soldat bebautes Feld an die Bank → error reason BANK_BUY_BUILT', async () => {
  const { teams, gameId } = await setupGame();
  setEngine(gameId, (e) => {
    e.settings.buildGroupOwnership = false;
    e.activeIdx = 0;
    e.players[0].budget = 5000000;
    e.players[0].properties[1] = { level: 'CYCLONE' };
  });
  const errP = onceErr(teams[0]);
  teams[0].emit('action:sell', { gameId, field: 1, buyerIdx: -1 });
  const err = await errP;
  assert.strictEqual(err.reason, 'BANK_BUY_BUILT');
  assert.ok(err.notify && err.notify.length > 0);
});

test('2o Wire P5: Ausbau bei beliehenem Gruppenfeld → error reason GROUP_MORTGAGED', async () => {
  const { teams, gameId } = await setupGame();
  setEngine(gameId, (e) => {
    e.settings.buildGroupOwnership = true;
    e.settings.buildGroupEven = false;
    e.activeIdx = 0;
    e.players[0].budget = 9000000;
    [1, 4, 7, 11, 12].forEach((fid) => { e.players[0].properties[fid] = { level: 'ALLEIN' }; });
    e.players[0].properties[1].mortgaged = true;
    e.players[0].properties[1].mortgagedValue = Math.round(D.mortgage(400000));
  });
  const errP = onceErr(teams[0]);
  teams[0].emit('action:build', { gameId, field: 4 });
  const err = await errP;
  assert.strictEqual(err.reason, 'GROUP_MORTGAGED');
  assert.ok(err.notify && err.notify.length > 0);
});

test('2o Wire P3: Kauf eines beliehenen Feldes → mortgageChoice im State; Clear entlastet', async () => {
  const { teams, gameId } = await setupGame();
  // A (idx0, aktiv) beleiht Feld 1, verkauft dann an B (idx1).
  setEngine(gameId, (e) => {
    e.settings.buildGroupOwnership = false;
    e.activeIdx = 0;
    e.players[0].budget = 5000000;
    e.players[1].budget = 5000000;
    e.players[0].properties[1] = { level: 'ALLEIN' };
  });
  // Hypothek auf Feld 1: Erfolg → Feld ist danach beliehen.
  const stMort = waitState(teams[0], (s) => s && s.game && s.game.players[0].properties[1] && s.game.players[0].properties[1].mortgaged === true, 6000);
  teams[0].emit('action:mortgage', { gameId, field: 1 });
  assert.ok(await stMort, 'Feld 1 beliehen');
  // Feld 1 für 50000 an Team B verkaufen.
  const stAfterSell = waitState(teams[1], (s) => s && s.game && s.game.mortgageChoice && s.game.mortgageChoice.buyerIdx === 1, 6000);
  teams[0].emit('action:sell', { gameId, field: 1, buyerIdx: 1, price: 50000 });
  const st2 = await stAfterSell;
  assert.ok(st2.game.mortgageChoice, 'mortgageChoice im State nach Kauf');
  assert.strictEqual(st2.game.mortgageChoice.fieldIdx, 1);
  assert.strictEqual(st2.game.mortgageChoice.buyerIdx, 1, 'Käufer = Team B');
  assert.strictEqual(st2.game.mortgageChoice.fullClear, Math.round(300000 * 1.10));
  // B besitzt das Feld beliehen.
  assert.ok(st2.game.players[1].properties[1], 'B besitzt');
  assert.strictEqual(st2.game.players[1].properties[1].mortgaged, true, 'beliehen übernommen');

  // B (Leader von Team 1) löst die Wahl mit 'clear' auf → Feld entlastet.
  const bBudgetBefore = st2.game.players[1].budget;
  const fullClear = st2.game.mortgageChoice.fullClear;
  const stCleared = waitState(teams[1], (s) => s && s.game && !s.game.mortgageChoice, 6000);
  teams[1].emit('action:mortgageChoice', { gameId, choice: 'clear' });
  const st3 = await stCleared;
  assert.ok(st3.game.players[1].properties[1], 'B behält das Feld');
  assert.strictEqual(st3.game.players[1].properties[1].mortgaged, false, 'voll entlastet');
  assert.strictEqual(st3.game.players[1].budget, bBudgetBefore - fullClear, 'Hypothek + 10 % Zins bezahlt');
  assert.strictEqual(st3.game.mortgageChoice, null, 'Wahl aufgelöst');
});

test('2o Wire P4: Landung auf fremdem beliehenen Feld → keine Miete (Log-Hinweis)', async () => {
  const { teams, gameId } = await setupGame();
  setEngine(gameId, (e) => {
    e.activeIdx = 1;               // Team B ist am Zug
    e.diceConfig = { kind: 'frei', freeValue: 1 };
    e.players[1].pos = 14;         // −> landet auf Feld 15
    e.players[1].budget = 1500000;
    e.players[0].budget = 1500000;
    e.players[0].properties[15] = { level: 'CYCLONE', mortgaged: true, mortgagedValue: 450000 };
  });
  const stP = waitState(teams[1], (s) => s && s.game && s.game.rolled === true, 6000);
  teams[1].emit('action:roll', { gameId });
  const st = await stP;
  const p = st.game.players[1];
  assert.strictEqual(p.pos, 15, 'B ist auf Feld 15 gelandet');
  assert.strictEqual(p.insolvent, false, 'kein Zahlungsrückstand');
  // Keine Miete abgeflossen (Budget unverändert).
  assert.strictEqual(p.budget, 1500000, 'B budgett unverändert: keine Miete');
  assert.ok(st.log.some((l) => /keine Miete/.test(l)), 'Log-Hinweis „keine Miete“ vorhanden');
});

test('2o Wire P2: Gefängnis-Wahl erreicht den Landenden — jailBail am aktiven Spieler gesetzt', async () => {
  const { teams, gameId } = await setupGame();
  setEngine(gameId, (e) => {
    e.activeIdx = 0;               // Team A würfelt
    e.diceConfig = { kind: 'frei', freeValue: 1 };
    e.players[0].pos = 5;          // −> landet auf Feld 6 (Gefängnis)
    e.fields[6].type = 'gefangnis';
    e.fields[6].fee = 40000;
  });
  const stP = waitState(teams[0], (s) => s && s.game && s.game.players[s.game.activeIdx] && s.game.players[s.game.activeIdx].jailBail != null, 6000);
  teams[0].emit('action:roll', { gameId });
  const st = await stP;
  const active = st.game.players[st.game.activeIdx];
  assert.strictEqual(active.id, 'team_0', 'Aktiv = Team A (Landender)');
  assert.strictEqual(active.jailed, true);
  assert.strictEqual(active.jailBail, 40000, 'Wahl am Landenden angeboten');
  // Das andere Team ist NICHT inhaftiert / hat keine Wahl.
  assert.strictEqual(st.game.players[1].jailBail, undefined, 'B hat keine Gefängnis-Wahl');
});
